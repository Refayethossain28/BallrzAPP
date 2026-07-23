/**
 * Driver payout ledger — admin-side aggregation & formatting.
 *
 * Lifted from `loadDriverBalances` / `payoutDriverNow` in apexvip-admin.html.
 * `aggregateOwedBalances` is the pure core that groups the `driver_payouts`
 * ledger into a per-driver owed balance; `formatSettlement` renders the result
 * of the `payoutDriver` callable. The DOM/Firestore I/O stays in the page.
 */

import type { PayoutSettleResult } from '@apexvip/contract';

/** One row of the `driver_payouts` ledger (as read from Firestore). */
export interface PayoutLedgerEntry {
  driverId?: string;
  amount?: number;
  currency?: string;
  status?: string; // 'owed' | 'paid'
}

/** Owed total for one driver, ready to render a "Pay out" row. */
export interface DriverBalance {
  driverId: string;
  amount: number;
  count: number;
  currency: string;
}

/**
 * Group owed ledger entries per driver, summing amounts and counting trips.
 * Entries without a driverId are skipped; an entry already marked `paid` is
 * ignored. The currency is taken from the first entry seen for each driver
 * (matching the source). Insertion order is preserved.
 */
export function aggregateOwedBalances(entries: PayoutLedgerEntry[]): DriverBalance[] {
  const by = new Map<string, DriverBalance>();
  for (const x of entries) {
    if (x.status && x.status !== 'owed') continue;
    const k = x.driverId;
    if (!k) continue;
    const cur = by.get(k) || { driverId: k, amount: 0, count: 0, currency: x.currency || 'GBP' };
    cur.amount += Number(x.amount) || 0;
    cur.count++;
    by.set(k, cur);
  }
  return [...by.values()];
}

/** The admin confirmation line after settling a driver's balance. */
export function formatSettlement(r: PayoutSettleResult): string {
  const cur = r.currency || 'GBP';
  return `Paid ${cur} ${r.paid || 0} across ${r.count || 0} trip(s)${r.mock ? ' (mock — no Stripe key set)' : ''}.`;
}
