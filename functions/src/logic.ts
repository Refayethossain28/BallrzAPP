/**
 * ApexVIP backend — pure logic, extracted from index.ts so it can be unit-tested
 * without Firebase. These are the deterministic helpers behind pricing bounds,
 * the 80% driver split, booking-lifecycle messaging, and compliance expiry.
 * index.ts imports them; logic.test.ts covers them.
 */

import type { Booking, Pricing } from './types.js';

/** Round to the nearest £5. */
export const round5 = (x: number): number => Math.round(x / 5) * 5;

/** ISO date `dateStr` plus `days`, as YYYY-MM-DD (noon-anchored to dodge DST). */
export function isoPlusDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Plausible-fare floor/ceiling from the operator rate card. Used to reject a
 * tampered/ runaway Square charge. Pure: index.ts reads settings/pricing and
 * passes it here.
 */
export function computeFareBounds(p: Pricing): { floor: number; ceiling: number } {
  const num = (v: unknown, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);
  const minFare = Math.min(num(p.min_fare_s, 38), num(p.min_fare_v, 50));
  const dayV = num(p.day_v, 550);
  const hourlyV = num(p.hourly_v_rate, 75);
  const peak = 1 + num(p.peak_surcharge_pct, 15) / 100;
  const ceiling = Math.max(dayV, hourlyV * 12) * peak * 3 + 500;
  const floor = Math.max(5, Math.floor(minFare * 0.5));
  return { floor, ceiling };
}

/** Clamp a platform commission percentage to a sane 0–50 range (default 20). */
export function normalizeCommissionPct(pct: unknown): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 20;
  return Math.min(50, Math.max(0, Math.round(n)));
}

/**
 * Driver's earning for a completed trip (payout ledger). Defaults to the
 * commission model's fixed 20% platform cut (driver keeps 80%); under the
 * subscription model the admin-set commission is passed in instead.
 */
export function driverEarning(b: Booking, commissionPct = 20): number {
  const keep = (100 - normalizeCommissionPct(commissionPct)) / 100;
  return Math.round((Number(b.baseFare) || Number(b.price) || 0) * keep);
}

/** Driver pay shown on a dispatched open_job (same split, default £95 base). */
export function dispatchPay(b: Booking, commissionPct = 20): number {
  const keep = (100 - normalizeCommissionPct(commissionPct)) / 100;
  return Math.round((Number(b.baseFare) || Number(b.price) || 95) * keep);
}

/** Which lifecycle message (if any) a booking write represents. */
export function bookingEvent(before: Booking | null, after: Booking | null): string | null {
  if (!after) return null;                 // deleted
  if (!before) return 'received';          // newly created
  if (before.status !== after.status) {
    switch (after.status) {
      case 'confirmed':       return 'confirmed';
      case 'driver_assigned': return 'driver_assigned';
      case 'en_route':
      case 'arriving':        return 'en_route';
      case 'completed':       return 'completed';
      case 'cancelled':       return 'cancelled';
      default: return null;
    }
  }
  if (!before.driverName && after.driverName) return 'driver_assigned';
  return null;
}

/** The [subject, body] for a lifecycle event, or null. */
export function bookingMessage(event: string, b: Booking): [string, string] | null {
  const ref = b.ref || b.bookingRef || '';
  const route = [b.pickup, b.dropoff || b.airport].filter(Boolean).join(' → ');
  const when = [b.date, b.time].filter(Boolean).join(' ');
  const M: Record<string, [string, string]> = {
    received:        ['We\'ve received your booking', `Thank you — we've received your ApexVIP booking ${ref}. ${route}${when ? ' · ' + when : ''}. We'll confirm your chauffeur shortly.`],
    confirmed:       ['Your booking is confirmed', `Your ApexVIP journey ${ref} is confirmed. ${route}${when ? ' · ' + when : ''}.`],
    driver_assigned: ['Your chauffeur is assigned', `${b.driverName || 'Your chauffeur'} will be looking after you for booking ${ref}${b.vehicle ? ' in a ' + b.vehicle : ''}.`],
    en_route:        ['Your chauffeur is on the way', `Your ApexVIP chauffeur is en route for booking ${ref}. ${route}.`],
    completed:       ['Thank you for travelling with ApexVIP', `Your journey ${ref} is complete. A receipt is available in the app. We hope to welcome you again soon.`],
    cancelled:       ['Your booking has been cancelled', `Your ApexVIP booking ${ref} has been cancelled. Any eligible refund will follow per our cancellation policy.`],
  };
  return M[event] || null;
}

/** Whole days from `now` (UTC midnight) until an ISO date; null if unparseable. */
export function daysUntil(iso: string | undefined, now: Date = new Date()): number | null {
  if (!iso || typeof iso !== 'string') return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const n = new Date(now); n.setUTCHours(0, 0, 0, 0);
  return Math.round((d.getTime() - n.getTime()) / 86400000);
}

/** Reminder milestones: 30/14/7/3/1/0 days out, then weekly once expired. */
export const REMIND_DAYS = new Set([30, 14, 7, 3, 1, 0]);
export const shouldRemind = (dl: number | null): boolean =>
  dl != null && (REMIND_DAYS.has(dl) || (dl < 0 && dl % 7 === 0));

/** "HH:MM" out of an ISO datetime string, or ''. */
export const flightHHMM = (iso: unknown): string =>
  (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : '');
