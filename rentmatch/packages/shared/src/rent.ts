/**
 * Rent ledger — pure, deterministic accounting for a tenancy. Given the tenancy
 * terms and the payments received, it derives the schedule of rent charges, what
 * is owed to date, and whether the tenant is in arrears, square, or in credit.
 * No I/O and no `Date.now()` (passed in as `asOf`) so it's fully unit-testable
 * and identical on the client, in Cloud Functions, and in any future surface.
 *
 * All money is integer **pence** (GBP), consistent with `money.ts`.
 */

export interface Tenancy {
  /** Epoch ms of the first rent due date; the monthly due day derives from it. */
  startDate: number;
  monthlyRentPence: number;
  /** Number of monthly rent charges over the fixed term. */
  termMonths: number;
}

export interface RentPayment {
  /** Epoch ms the payment was received. */
  date: number;
  amountPence: number;
}

export interface RentCharge {
  /** Epoch ms this month's rent falls due. */
  dueDate: number;
  amountPence: number;
  /** Billing period as `YYYY-MM` (UTC), e.g. "2026-07". */
  period: string;
}

export type RentStatus = 'upcoming' | 'paid' | 'arrears' | 'credit';

export interface RentLedger {
  /** Every scheduled charge over the term (past and future). */
  schedule: RentCharge[];
  /** Charges whose due date has passed `asOf`. */
  dueToDate: RentCharge[];
  totalDuePence: number;
  totalPaidPence: number;
  /** Owed minus paid. Positive ⇒ arrears, negative ⇒ in credit. */
  balancePence: number;
  arrearsPence: number;
  creditPence: number;
  /** Whole months behind, rounded down (0 if square or in credit). */
  monthsInArrears: number;
  /** Next charge falling due after `asOf`, or null once the term is fully billed. */
  nextDueDate: number | null;
  status: RentStatus;
}

const DAY = 86_400_000;

/**
 * Add `n` calendar months to an epoch, clamping the day to the target month's
 * length (e.g. Jan 31 + 1 month → Feb 28/29) and preserving the time of day.
 * Uses an explicit-argument Date, which is deterministic and side-effect-free.
 */
export function addMonths(epoch: number, n: number): number {
  const d = new Date(epoch);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  target.setUTCHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  return target.getTime();
}

/** `YYYY-MM` (UTC) for a billing period label. */
function periodLabel(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The full monthly charge schedule for a tenancy. */
export function rentSchedule(tenancy: Tenancy): RentCharge[] {
  const charges: RentCharge[] = [];
  for (let i = 0; i < Math.max(0, Math.floor(tenancy.termMonths)); i++) {
    const dueDate = addMonths(tenancy.startDate, i);
    charges.push({ dueDate, amountPence: tenancy.monthlyRentPence, period: periodLabel(dueDate) });
  }
  return charges;
}

/**
 * Derive the rent ledger as of `asOf`. A charge counts as "due" once its due
 * date has passed; payments count in full regardless of date (a tenant can pay
 * ahead). Arrears and credit are two sides of the balance, never both non-zero.
 */
export function buildRentLedger(
  tenancy: Tenancy,
  payments: RentPayment[],
  asOf: number = Date.now(),
): RentLedger {
  const schedule = rentSchedule(tenancy);
  const dueToDate = schedule.filter((c) => c.dueDate <= asOf);

  const totalDuePence = dueToDate.reduce((sum, c) => sum + c.amountPence, 0);
  const totalPaidPence = payments.reduce((sum, p) => sum + p.amountPence, 0);
  const balancePence = totalDuePence - totalPaidPence;

  const arrearsPence = Math.max(0, balancePence);
  const creditPence = Math.max(0, -balancePence);
  const monthsInArrears =
    tenancy.monthlyRentPence > 0 ? Math.floor(arrearsPence / tenancy.monthlyRentPence) : 0;

  const nextDueDate = schedule.find((c) => c.dueDate > asOf)?.dueDate ?? null;

  let status: RentStatus;
  if (arrearsPence > 0) status = 'arrears';
  else if (totalDuePence === 0) status = 'upcoming';
  else if (creditPence > 0) status = 'credit';
  else status = 'paid';

  return {
    schedule,
    dueToDate,
    totalDuePence,
    totalPaidPence,
    balancePence,
    arrearsPence,
    creditPence,
    monthsInArrears,
    nextDueDate,
    status,
  };
}

/** Days until (positive) or since (negative) the next rent is due. */
export function daysUntilDue(nextDueDate: number, asOf: number = Date.now()): number {
  return Math.round((nextDueDate - asOf) / DAY);
}

/* ---- rent reminders (drives the daily cron, mirrors the compliance pattern) ---- */

/** Nudge the landlord this many days before a rent payment falls due. */
export const RENT_DUE_SOON_DAYS = 3;

export type RentReminderKind = 'due-soon' | 'overdue';

export interface RentReminder {
  kind: RentReminderKind;
  /** Pence relevant to the nudge: the upcoming charge, or the arrears owed. */
  amountPence: number;
  /** Present for due-soon reminders. */
  dueDate?: number;
  /** Stable idempotency key so a daily run never repeats a milestone. */
  key: string;
}

/**
 * Rent reminders *due now* for a tenancy, given the keys already sent. Built
 * from the same ledger as everything else, using the denormalised `totalPaid`
 * so the cron needs no per-payment fetch. Overdue is keyed by how many charges
 * have fallen due, so each newly-missed month nudges exactly once; due-soon is
 * keyed by the upcoming period.
 */
export function dueRentReminders(
  tenancy: Tenancy,
  totalPaidPence: number,
  sentKeys: readonly string[] = [],
  now: number = Date.now(),
): RentReminder[] {
  const sent = new Set(sentKeys);
  const ledger = buildRentLedger(tenancy, [{ date: 0, amountPence: totalPaidPence }], now);
  const out: RentReminder[] = [];

  if (ledger.arrearsPence > 0) {
    const key = `overdue:${ledger.dueToDate.length}`;
    if (!sent.has(key)) out.push({ kind: 'overdue', amountPence: ledger.arrearsPence, key });
  }

  if (ledger.nextDueDate != null) {
    const days = daysUntilDue(ledger.nextDueDate, now);
    if (days >= 0 && days <= RENT_DUE_SOON_DAYS) {
      const key = `due:${periodLabel(ledger.nextDueDate)}`;
      if (!sent.has(key)) out.push({ kind: 'due-soon', amountPence: tenancy.monthlyRentPence, dueDate: ledger.nextDueDate, key });
    }
  }

  return out;
}

/* ---- statement export ---- */

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** ISO date (UTC, YYYY-MM-DD) for stable, spreadsheet-friendly statement rows. */
function isoDate(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

/**
 * A rent statement as CSV — the schedule of charges and the payments received,
 * with a closing balance. Deterministic (UTC dates), so it's testable and an
 * accountant gets the same file every time.
 */
export function buildRentStatementCsv(
  tenancy: Tenancy & { tenantName?: string; propertyLabel?: string },
  payments: RentPayment[],
  asOf: number = Date.now(),
): string {
  const ledger = buildRentLedger(tenancy, payments, asOf);
  const rows: (string | number)[][] = [['Date', 'Description', 'Charge (£)', 'Payment (£)']];

  const gbp = (pence: number) => (pence / 100).toFixed(2);

  for (const c of ledger.dueToDate) {
    rows.push([isoDate(c.dueDate), `Rent due (${c.period})`, gbp(c.amountPence), '']);
  }
  for (const p of [...payments].sort((a, b) => a.date - b.date)) {
    rows.push([isoDate(p.date), 'Payment received', '', gbp(p.amountPence)]);
  }
  rows.push([]);
  rows.push(['', 'Total charged to date', gbp(ledger.totalDuePence), '']);
  rows.push(['', 'Total received', '', gbp(ledger.totalPaidPence)]);
  rows.push(['', ledger.arrearsPence > 0 ? 'Arrears outstanding' : 'Balance in credit', gbp(Math.abs(ledger.balancePence)), '']);

  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}
