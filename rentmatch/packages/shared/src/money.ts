/**
 * Money helpers and statutory caps. All amounts are integer **pence** (GBP)
 * to avoid floating-point drift; format only at the edges.
 *
 * Caps implement the Tenant Fees Act 2019.
 */

/** RentMatch's one-off platform fee, charged to the landlord on full execution. */
export const PLATFORM_FEE_PENCE = 10_000; // £100.00

/** Annual-rent threshold (pence) above which the deposit cap rises to 6 weeks. */
export const DEPOSIT_CAP_THRESHOLD_PENCE = 5_000_000; // £50,000 / year

export function poundsToPence(pounds: number): number {
  return Math.round(pounds * 100);
}

/** Format integer pence as GBP, hiding the pence part when it is a whole pound. */
export function formatGBP(pence: number): string {
  const hasPence = pence % 100 !== 0;
  return (
    '£' +
    (pence / 100).toLocaleString('en-GB', {
      minimumFractionDigits: hasPence ? 2 : 0,
      maximumFractionDigits: 2,
    })
  );
}

/** Weekly rent (pence, rounded to the nearest penny) from a monthly figure. */
export function weeklyRentPence(monthlyRentPence: number): number {
  return Math.round((monthlyRentPence * 12) / 52);
}

/**
 * Tenant Fees Act 2019 tenancy-deposit cap, in weeks of rent:
 * 5 weeks where annual rent is under £50,000, otherwise 6 weeks.
 */
export function depositCapWeeks(monthlyRentPence: number): 5 | 6 {
  return monthlyRentPence * 12 < DEPOSIT_CAP_THRESHOLD_PENCE ? 5 : 6;
}

/** Maximum permitted tenancy deposit (pence) under the Tenant Fees Act 2019. */
export function tenancyDepositCapPence(monthlyRentPence: number): number {
  return weeklyRentPence(monthlyRentPence) * depositCapWeeks(monthlyRentPence);
}

/** Maximum permitted holding deposit (pence) — capped at one week's rent. */
export function holdingDepositCapPence(monthlyRentPence: number): number {
  return weeklyRentPence(monthlyRentPence);
}

/** Whether a proposed deposit is within the statutory cap. */
export function isDepositWithinCap(monthlyRentPence: number, depositPence: number): boolean {
  return depositPence <= tenancyDepositCapPence(monthlyRentPence);
}
