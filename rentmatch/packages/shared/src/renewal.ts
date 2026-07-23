/**
 * Tenancy renewals — the recurring use of the £100 execution fee. When a fixed
 * term is ending, the landlord renews: new term, optionally new rent, a fresh
 * agreement to sign, and the platform fee again. This module is the pure part:
 * sensible default terms and the rent-change maths. The agreement generation,
 * e-signature and fee charge live in Cloud Functions.
 *
 * Money is integer **pence** (GBP); `asOf` is injected, never `Date.now()` in core.
 */
import { addMonths, type Tenancy } from './rent.ts';

export interface RenewalTerms {
  /** Epoch ms the renewed term begins (first rent due date). */
  startDate: number;
  termMonths: number;
  monthlyRentPence: number;
}

/**
 * Defaults for renewing a tenancy: start the day the current term ends (or
 * today if that has already passed), keeping the same rent and term length as a
 * starting point the landlord can adjust.
 */
export function renewalDefaults(tenancy: Tenancy, asOf: number = Date.now()): RenewalTerms {
  const currentEnd = addMonths(tenancy.startDate, tenancy.termMonths);
  return {
    startDate: Math.max(currentEnd, asOf),
    termMonths: tenancy.termMonths,
    monthlyRentPence: tenancy.monthlyRentPence,
  };
}

/** Percentage rent change a renewal represents (positive = increase). */
export function rentChangePct(oldRentPence: number, newRentPence: number): number {
  if (oldRentPence <= 0) return 0;
  return ((newRentPence - oldRentPence) / oldRentPence) * 100;
}

/** The tenancy fields to persist when a renewal completes (a fresh term). */
export function applyRenewal(terms: RenewalTerms): Tenancy {
  return {
    startDate: terms.startDate,
    termMonths: terms.termMonths,
    monthlyRentPence: terms.monthlyRentPence,
  };
}

/** Lifecycle of a renewal in flight. */
export type RenewalStatus = 'awaiting-signature' | 'signed' | 'completed';
