/**
 * Membership / business-model state machine. Single source for logic that was
 * previously duplicated as `subState()` (apexvip-client.html) and
 * `driverSubState()` (apexvip-driver.html), plus the commission maths shown in
 * the admin (mirrors `normalizeCommissionPct` in functions/src/logic.ts).
 *
 * The platform runs in one of two admin-controlled modes (`settings/business`):
 * 'commission' (free to join, fixed 20% platform cut) or 'subscription'
 * (monthly memberships, free trial for new members, admin-set commission).
 */

export interface BusinessSettings {
  model?: 'commission' | 'subscription' | string;
  commissionPct?: number;
  clientMonthlyFee?: number;
  driverMonthlyFee?: number;
  trialDays?: number;
}

/** A `subscriptions/{uid}` doc, tolerant of Firestore Timestamps or Dates. */
export interface SubscriptionDoc {
  status?: 'trial' | 'active' | 'cancelled' | string;
  trialEndsAt?: Date | { toDate(): Date } | string | number | null;
}

export type MembershipState =
  | { mode: 'off' }
  | { mode: 'trial'; daysLeft: number }
  | { mode: 'active' }
  | { mode: 'expired' };

export const DEFAULT_TRIAL_DAYS = 30;
const DAY_MS = 86_400_000;

/** Clamp a platform commission percentage to 0–50 (default 20 on junk). */
export function normalizeCommissionPct(pct: unknown): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 20;
  return Math.min(50, Math.max(0, Math.round(n)));
}

/** The driver's keep-share (%) under the given settings. Commission mode = 80. */
export function keepPercent(business: BusinessSettings | null | undefined): number {
  const pct = business?.model === 'subscription' ? normalizeCommissionPct(business.commissionPct) : 20;
  return 100 - pct;
}

function toDate(v: SubscriptionDoc['trialEndsAt']): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate(): Date }).toDate();
  }
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** When a trial started `now` would end, per the settings. */
export function trialEndDate(business: BusinessSettings | null | undefined, now: Date = new Date()): Date {
  const days = Number(business?.trialDays) > 0 ? Number(business!.trialDays) : DEFAULT_TRIAL_DAYS;
  return new Date(now.getTime() + days * DAY_MS);
}

/**
 * Where a member stands. `off` in commission mode (no banners, no gates);
 * otherwise trial (with whole days left), active, or expired. A member with no
 * subscription doc yet is treated as a fresh trial — nobody is locked out the
 * moment the admin flips the switch.
 */
export function membershipState(
  sub: SubscriptionDoc | null | undefined,
  business: BusinessSettings | null | undefined,
  now: Date = new Date(),
): MembershipState {
  if (business?.model !== 'subscription') return { mode: 'off' };
  if (!sub) return { mode: 'trial', daysLeft: Number(business?.trialDays) > 0 ? Number(business!.trialDays) : DEFAULT_TRIAL_DAYS };
  if (sub.status === 'active') return { mode: 'active' };
  const ends = toDate(sub.trialEndsAt);
  if (!ends) return { mode: 'expired' };
  const daysLeft = Math.ceil((ends.getTime() - now.getTime()) / DAY_MS);
  return daysLeft > 0 ? { mode: 'trial', daysLeft } : { mode: 'expired' };
}
