/**
 * Tenancy deposit protection — the single biggest legal trap for UK landlords.
 *
 * By law (Housing Act 2004, as amended) a deposit taken for an assured
 * shorthold tenancy in England must be protected in a government-authorised
 * scheme **within 30 days** of receipt, and the tenant given the scheme's
 * "prescribed information" in the same window. Miss it and the landlord:
 *   - cannot serve a valid Section 21 notice (can't regain possession), and
 *   - can be ordered to pay the tenant 1–3× the deposit.
 *
 * Pure and unit-tested: the app records the facts, this module renders the
 * legal status and the deadline.
 */

/** The three government-authorised schemes in England & Wales. */
export type DepositScheme = 'dps' | 'mydeposits' | 'tds';

export const DEPOSIT_SCHEME_NAMES: Record<DepositScheme, string> = {
  dps: 'Deposit Protection Service',
  mydeposits: 'mydeposits',
  tds: 'Tenancy Deposit Scheme',
};

/** What the landlord has recorded about protecting a tenancy's deposit. */
export interface DepositProtection {
  depositPence: number;
  /** Epoch ms the deposit was received from the tenant (starts the 30-day clock). */
  receivedAt: number;
  scheme?: DepositScheme;
  /** Epoch ms the deposit was protected in the scheme. */
  protectedAt?: number;
  /** Epoch ms the prescribed information was served on the tenant. */
  prescribedInfoServedAt?: number;
}

/** Statutory window to protect a deposit and serve prescribed information. */
export const DEPOSIT_PROTECTION_DEADLINE_DAYS = 30;
const DAY_MS = 86_400_000;

export type DepositProtectionState =
  | 'none' // no deposit taken — nothing to protect
  | 'due' // taken, within the 30-day window, not yet fully protected
  | 'overdue' // window passed without full protection — S21 blocked, penalty risk
  | 'info-outstanding' // protected in time but prescribed info not yet served
  | 'protected'; // protected AND prescribed info served

export interface DepositProtectionStatus {
  state: DepositProtectionState;
  /** Epoch ms by which protection + prescribed info must be complete. */
  deadline: number;
  /** Whole days remaining until the deadline (negative once passed). */
  daysRemaining: number;
  scheme?: DepositScheme;
}

/**
 * Assess a deposit's protection status as of `now`. "Fully protected" means
 * both protected in a scheme AND prescribed information served, each on or
 * before the 30-day deadline.
 */
export function depositProtectionStatus(
  deposit: DepositProtection | null | undefined,
  now: number,
): DepositProtectionStatus {
  if (!deposit || deposit.depositPence <= 0) {
    return { state: 'none', deadline: 0, daysRemaining: 0 };
  }
  const deadline = deposit.receivedAt + DEPOSIT_PROTECTION_DEADLINE_DAYS * DAY_MS;
  const daysRemaining = Math.floor((deadline - now) / DAY_MS);
  const protectedInTime = deposit.protectedAt != null && deposit.protectedAt <= deadline;
  const infoInTime = deposit.prescribedInfoServedAt != null && deposit.prescribedInfoServedAt <= deadline;

  let state: DepositProtectionState;
  if (protectedInTime && infoInTime) state = 'protected';
  else if (protectedInTime && deposit.prescribedInfoServedAt == null && now <= deadline) state = 'info-outstanding';
  else if (deposit.protectedAt == null && now <= deadline) state = 'due';
  else state = 'overdue'; // deadline passed without full, in-time protection

  return { state, deadline, daysRemaining, scheme: deposit.scheme };
}

/** True when the deposit is fully and lawfully protected (scheme + prescribed info, in time). */
export function isDepositProtected(deposit: DepositProtection | null | undefined, now: number): boolean {
  return depositProtectionStatus(deposit, now).state === 'protected';
}
