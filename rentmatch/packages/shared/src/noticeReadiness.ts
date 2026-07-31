/**
 * Section 21 "notice readiness" — the market-leading verdict.
 *
 * A Section 21 no-fault possession notice is legally INVALID unless a set of
 * preconditions is met (Housing Act 1988 s21 as amended by the Deregulation
 * Act 2015 and the Tenant Fees Act 2019). Landlords routinely discover, months
 * into trying to evict, that a missing gas certificate or an unprotected
 * deposit has voided their notice. This engine answers, in one glance, "could I
 * lawfully serve notice today?" — and if not, exactly what to fix.
 *
 * Pure and unit-tested. Not legal advice; it surfaces the well-established
 * statutory gates, worst-first.
 */
import { depositProtectionStatus, type DepositProtection } from './deposit.ts';
import { isDepositWithinCap } from './money.ts';

const DAY_MS = 86_400_000;

/** A landlord can't serve a s21 in the first four months of the original tenancy. */
export const SECTION21_MIN_TENANCY_DAYS = 4 * 30;

export interface Section21Inputs {
  /** Tenancy start (epoch ms) — the 4-month rule runs from here. */
  tenancyStartDate: number;
  monthlyRentPence: number;
  deposit: DepositProtection | null | undefined;
  /** Has a current gas safety certificate been given to the tenant? */
  gasSafetyProvided: boolean;
  /** Is there a valid (in-date) EICR and was it given to the tenant? */
  eicrValid: boolean;
  /** Has a valid EPC been given to the tenant? */
  epcProvided: boolean;
  /** Was the current "How to Rent" guide served at the start of the tenancy? */
  howToRentProvided: boolean;
}

export type BlockerSeverity = 'blocker' | 'warning';

export interface ReadinessItem {
  id: string;
  severity: BlockerSeverity;
  /** Short, landlord-facing statement of what's wrong and why it matters. */
  message: string;
}

export interface Section21Readiness {
  /** True only when there are zero blockers. */
  ready: boolean;
  blockers: ReadinessItem[];
  warnings: ReadinessItem[];
  /** All items (blockers first), for a single list rendering. */
  items: ReadinessItem[];
}

/**
 * Assess whether a valid Section 21 could be served as of `now`. Each failed
 * statutory gate is a blocker; softer risks (e.g. deposit still within its
 * 30-day window) are warnings.
 */
export function assessSection21Readiness(input: Section21Inputs, now: number): Section21Readiness {
  const blockers: ReadinessItem[] = [];
  const warnings: ReadinessItem[] = [];

  // Deposit protection — the most common s21-killer.
  const dep = depositProtectionStatus(input.deposit, now);
  if (dep.state === 'overdue') {
    blockers.push({ id: 'deposit-overdue', severity: 'blocker',
      message: 'Deposit was not protected with prescribed information within 30 days. A Section 21 is invalid and you may owe the tenant 1–3× the deposit. Return the deposit before serving notice.' });
  } else if (dep.state === 'due') {
    warnings.push({ id: 'deposit-due', severity: 'warning',
      message: `Deposit not yet protected — ${dep.daysRemaining} day(s) left of the 30-day window. Protect it and serve prescribed information to keep Section 21 available.` });
  } else if (dep.state === 'info-outstanding') {
    blockers.push({ id: 'deposit-info', severity: 'blocker',
      message: 'Deposit is protected but the prescribed information has not been served on the tenant — Section 21 is invalid until it is.' });
  }

  // Deposit cap (Tenant Fees Act 2019): an over-cap deposit blocks s21 until the excess is returned.
  if (input.deposit && input.deposit.depositPence > 0 && !isDepositWithinCap(input.monthlyRentPence, input.deposit.depositPence)) {
    blockers.push({ id: 'deposit-cap', severity: 'blocker',
      message: 'Deposit exceeds the 5-week cap (Tenant Fees Act 2019). Refund the excess — an over-cap deposit voids a Section 21.' });
  }

  if (!input.gasSafetyProvided) {
    blockers.push({ id: 'gas', severity: 'blocker',
      message: 'No current gas safety certificate given to the tenant. Section 21 is invalid without it (where there is a gas supply).' });
  }
  if (!input.epcProvided) {
    blockers.push({ id: 'epc', severity: 'blocker',
      message: 'No valid EPC given to the tenant — required before a valid Section 21.' });
  }
  if (!input.eicrValid) {
    blockers.push({ id: 'eicr', severity: 'blocker',
      message: 'No in-date electrical safety report (EICR). Required by law, and its absence undermines a Section 21.' });
  }
  if (!input.howToRentProvided) {
    blockers.push({ id: 'how-to-rent', severity: 'blocker',
      message: 'The current "How to Rent" guide was not served at the start of the tenancy — Section 21 is invalid without it.' });
  }

  // Four-month rule: no s21 in the first four months of the original tenancy.
  const daysIn = Math.floor((now - input.tenancyStartDate) / DAY_MS);
  if (daysIn < SECTION21_MIN_TENANCY_DAYS) {
    blockers.push({ id: 'four-month', severity: 'blocker',
      message: `A Section 21 can't be served in the first four months of the tenancy (${SECTION21_MIN_TENANCY_DAYS - daysIn} day(s) to go).` });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    items: [...blockers, ...warnings],
  };
}
