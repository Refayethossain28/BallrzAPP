/**
 * ApexEngine — the pure, framework-free logic shared between the TypeScript build
 * and the single-file HTML apps.
 *
 * Built (via `npm run build:engine`) into a committed IIFE at the repo root,
 * `apexvip-engine.js`, which exposes everything here on `window.ApexEngine`. The
 * HTML apps load that script and call into it instead of carrying their own
 * copies — so the concierge parser, fare math and payout aggregation have ONE
 * implementation, the one covered by this package's tests.
 *
 * Only pure functions belong here: no Firebase, no DOM. The typed callable
 * orchestration (resolveConcierge, runCheckout, …) stays in the build for code
 * that consumes the typed client.
 */

export { parseIntentLocal } from './concierge/intent.ts';
export { quoteFare, PROMO_RATE } from './payments/pricing.ts';
export { aggregateOwedBalances, formatSettlement } from './payouts/ledger.ts';
export { normalizeReferralCode, demoReferralCode, referralErrorMessage } from './referrals/referrals.ts';
export { isValidRating, clampComment } from './trips/rating.ts';
export { prepareChauffeurMessage } from './trips/chat.ts';
export { normalizeFlightNumber, isValidFlightNumber, demoFlightStatus } from './trips/flight.ts';
export { membershipState, keepPercent, trialEndDate, normalizeCommissionPct } from './membership/membership.ts';
export { escapeHtml } from './security/escape.ts';
export { buildBookingPayload, SERVICE_LABELS } from './payments/booking.ts';
export { summarizeEarnings, dailyEarnings, owedBalance } from './driver/earnings.ts';
export { errorMessage, errorFingerprint, formatErrorReport, shouldReport } from './telemetry/errors.ts';
