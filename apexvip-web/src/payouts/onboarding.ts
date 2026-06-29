/**
 * Driver payout onboarding — Stripe Connect Express.
 *
 * The decision logic of `setupPayouts` from apexvip-driver.html, lifted out of
 * the DOM so it's typed and testable: skip when there's no backend (demo), skip
 * when payouts are already active, otherwise create/resume a hosted onboarding
 * link, open it, and schedule a status refresh for when the driver returns. The
 * window-open, toasts and `setTimeout` are injected.
 */

import type { ApexClient } from '../apexClient.ts';

export type OnboardingOutcome = 'unavailable' | 'already_active' | 'opened' | 'no_url';

export interface OnboardingDeps {
  /** Typed client, or null when Firebase is unavailable (demo mode). */
  backend: Pick<ApexClient, 'createDriverPayoutAccount' | 'getDriverPayoutStatus'> | null;
  /** Whether this driver's payouts are already enabled (S._payout.payoutsEnabled). */
  payoutsEnabled: boolean;
  /** Open the hosted Stripe onboarding link (a new tab/window in the app). */
  openUrl: (url: string) => void;
  /**
   * Schedule the post-return status refresh. The page wires this to a
   * `setTimeout`; the callback re-polls `getDriverPayoutStatus`.
   */
  scheduleStatusRefresh?: (refresh: () => Promise<unknown>) => void;
}

export interface OnboardingResult {
  outcome: OnboardingOutcome;
  url?: string;
}

export async function startPayoutOnboarding(deps: OnboardingDeps): Promise<OnboardingResult> {
  if (!deps.backend) return { outcome: 'unavailable' };
  if (deps.payoutsEnabled) return { outcome: 'already_active' };

  // Create or resume the connected account; errors propagate to the caller's toast.
  const { url } = await deps.backend.createDriverPayoutAccount();
  if (!url) return { outcome: 'no_url' };

  deps.openUrl(url);
  // Refresh status shortly after they come back from the hosted flow.
  deps.scheduleStatusRefresh?.(() => deps.backend!.getDriverPayoutStatus());
  return { outcome: 'opened', url };
}
