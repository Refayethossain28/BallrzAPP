/**
 * Referrals — code generation, normalization, apply flow.
 *
 * From `loadReferralCode` / `applyReferral` in apexvip-client.html. The pure bits
 * (normalize a typed code, the demo code, the error→message mapping) are testable;
 * the typed wrappers call `generateReferralCode` / `applyReferralCode`.
 */

import type { ApexClient } from '../apexClient.ts';

export type ReferralBackend = Pick<ApexClient, 'generateReferralCode' | 'applyReferralCode'>;

export const DEFAULT_REFERRAL_CREDIT = 50;

/** Normalize a user-entered code exactly as the backend expects: trimmed, upper. */
export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** The offline/demo code shown when Firebase isn't configured. */
export function demoReferralCode(uid?: string): string {
  return 'APEX' + (uid?.slice(0, 4)?.toUpperCase() || 'DEMO') + '247';
}

/** Map an apply error to the user-facing message (mirrors the source wording). */
export function referralErrorMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (m.includes('already')) return "You've already used this code.";
  if (m.includes('not-found')) return 'Invalid code — check and try again.';
  return 'Could not apply code — try again.';
}

/** Fetch the caller's referral code (live), or the demo code when offline. */
export async function loadReferralCode(backend: ReferralBackend | null, uid?: string): Promise<string> {
  if (!backend) return demoReferralCode(uid);
  const { code } = await backend.generateReferralCode();
  return code;
}

export interface ApplyReferralResult {
  ok: boolean;
  message: string;
  creditsAwarded: number;
}

/** Apply a referral code, returning a typed outcome with the user-facing message. */
export async function applyReferral(backend: ReferralBackend | null, rawCode: string): Promise<ApplyReferralResult> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return { ok: false, message: 'Enter a referral code.', creditsAwarded: 0 };
  if (!backend) return { ok: false, message: 'Referrals are available in the live app.', creditsAwarded: 0 };
  try {
    const res = await backend.applyReferralCode({ code });
    return { ok: true, message: '✓ ' + res.message, creditsAwarded: res.creditsAwarded ?? DEFAULT_REFERRAL_CREDIT };
  } catch (err) {
    return { ok: false, message: referralErrorMessage(err), creditsAwarded: 0 };
  }
}
