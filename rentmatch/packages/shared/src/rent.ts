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
