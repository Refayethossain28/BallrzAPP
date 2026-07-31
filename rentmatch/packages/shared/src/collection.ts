/**
 * Automated rent collection via Direct Debit (Open Banking — GoCardless-shaped).
 * Pure scheduling/reconciliation logic: which rent charges still need a payment
 * initiated, and whether a mandate is good to collect on. The provider API calls
 * live in Cloud Functions; this engine — the part that must never double-charge
 * or miss a month — is deterministic and unit-tested.
 *
 * Money is integer **pence** (GBP). `asOf` is injected, never `Date.now()` in core.
 */
import type { Tenancy } from './rent.ts';
import { rentSchedule } from './rent.ts';

const DAY = 86_400_000;

export type MandateStatus = 'none' | 'pending' | 'active' | 'failed' | 'cancelled';

export interface DirectDebitMandate {
  status: MandateStatus;
  provider?: 'gocardless';
  mandateId?: string;
  customerId?: string;
}

/** Only an active mandate may be collected against. */
export function isMandateActive(mandate?: DirectDebitMandate | null): boolean {
  return mandate?.status === 'active';
}

export type CollectionStatus = 'scheduled' | 'submitted' | 'confirmed' | 'failed';

export interface RentCollection {
  /** Rent period this collection settles, e.g. "2026-07". */
  period: string;
  amountPence: number;
  status: CollectionStatus;
  /** Epoch ms the Direct Debit is/was charged (≈ the rent due date). */
  chargeDate: number;
  /** Provider payment id once created. */
  paymentId?: string;
}

/** Initiate a Direct Debit this many days before the rent due date. */
export const COLLECTION_LEAD_DAYS = 3;

/** A collection still standing (not failed) covers its period; a failed one frees it for retry. */
export function coveredPeriods(collections: readonly RentCollection[]): string[] {
  return collections.filter((c) => c.status !== 'failed').map((c) => c.period);
}

/**
 * Charges that need a Direct Debit initiated now: due within the lead window (or
 * already overdue) and not yet covered by a standing collection. Idempotent via
 * `covered`, so the daily cron creates each period's payment exactly once.
 */
export function dueCollections(
  tenancy: Tenancy,
  covered: readonly string[],
  asOf: number = Date.now(),
  leadDays: number = COLLECTION_LEAD_DAYS,
): { period: string; amountPence: number; chargeDate: number }[] {
  const done = new Set(covered);
  const lead = leadDays * DAY;
  return rentSchedule(tenancy)
    .filter((c) => !done.has(c.period) && c.dueDate - asOf <= lead)
    .map((c) => ({ period: c.period, amountPence: c.amountPence, chargeDate: c.dueDate }));
}

/** Human label for a mandate's collection state. */
export function mandateLabel(mandate?: DirectDebitMandate | null): string {
  switch (mandate?.status) {
    case 'active':
      return 'Direct Debit active';
    case 'pending':
      return 'Direct Debit setup in progress';
    case 'failed':
      return 'Direct Debit setup failed';
    case 'cancelled':
      return 'Direct Debit cancelled';
    default:
      return 'No Direct Debit';
  }
}
