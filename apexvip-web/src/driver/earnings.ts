/**
 * Driver earnings maths over the payout ledger (`driver_payouts` rows).
 * Lifted from the inline calculations in apexvip-driver.html's Earnings screen
 * so period totals and the weekly bars have ONE tested implementation.
 *
 * Rows are tolerant of Firestore Timestamps, Dates, ISO strings and epoch ms;
 * rows without a usable date are ignored.
 */

export interface LedgerRowLike {
  amount?: number | string;
  bookingRef?: string;
  status?: string;
  createdAt?: Date | { toDate(): Date } | string | number | null;
}

export type EarningsPeriod = 'today' | 'week' | 'month';

export interface EarningsSummary {
  total: number;
  count: number;
  /** The rows inside the period, newest first, with a resolved `at` date. */
  rows: Array<{ amount: number; ref: string; status: string; at: Date }>;
}

const DAY_MS = 86_400_000;

function toDate(v: LedgerRowLike['createdAt']): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate(): Date }).toDate();
  }
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalize(rows: LedgerRowLike[] | null | undefined) {
  return (rows || [])
    .map((r) => ({ amount: Number(r.amount) || 0, ref: r.bookingRef || '', status: r.status || '', at: toDate(r.createdAt) }))
    .filter((r): r is { amount: number; ref: string; status: string; at: Date } => r.at !== null);
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** Total + rows for a period ('today' = calendar day; week/month = rolling 7/31 days). */
export function summarizeEarnings(
  rows: LedgerRowLike[] | null | undefined,
  period: EarningsPeriod,
  now: Date = new Date(),
): EarningsSummary {
  const windowDays = period === 'week' ? 7 : 31;
  const inPeriod = normalize(rows).filter((r) =>
    period === 'today' ? sameDay(r.at, now) : now.getTime() - r.at.getTime() < windowDays * DAY_MS,
  );
  inPeriod.sort((a, b) => b.at.getTime() - a.at.getTime());
  return { total: inPeriod.reduce((a, r) => a + r.amount, 0), count: inPeriod.length, rows: inPeriod };
}

export interface DailyBars {
  bars: number[];
  labels: string[];
  max: number;
}

/** Per-day earned totals for the trailing `days` days; last label is 'Today'. */
export function dailyEarnings(rows: LedgerRowLike[] | null | undefined, now: Date = new Date(), days = 7): DailyBars {
  const all = normalize(rows);
  const bars: number[] = [];
  const labels: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    bars.push(all.filter((r) => sameDay(r.at, d)).reduce((a, r) => a + r.amount, 0));
    labels.push(i === 0 ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'short' }));
  }
  return { bars, labels, max: Math.max(1, ...bars) };
}

/** Sum of rows still owed (unsettled). */
export function owedBalance(rows: LedgerRowLike[] | null | undefined): number {
  return normalize(rows).filter((r) => r.status === 'owed').reduce((a, r) => a + r.amount, 0);
}
