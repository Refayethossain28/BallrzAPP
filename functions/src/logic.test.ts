/**
 * Unit tests for the pure backend logic (functions/src/logic.ts).
 * Run: `npm test` (node --test with TypeScript type-stripping).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  round5, isoPlusDays, computeFareBounds, driverEarning, dispatchPay,
  bookingEvent, bookingMessage, daysUntil, shouldRemind, flightHHMM,
  normalizeCommissionPct,
} from './logic.ts';

test('round5 rounds to the nearest £5', () => {
  assert.equal(round5(12), 10);
  assert.equal(round5(13), 15);
  assert.equal(round5(995.4), 995);
});

test('isoPlusDays adds days and stays on the calendar', () => {
  assert.equal(isoPlusDays('2026-07-03', 2), '2026-07-05');
  assert.equal(isoPlusDays('2026-07-30', 3), '2026-08-02');
});

test('computeFareBounds: defaults', () => {
  assert.deepEqual(computeFareBounds({}), { floor: 19, ceiling: 3605 });
});

test('computeFareBounds: custom rate card', () => {
  assert.deepEqual(
    computeFareBounds({ min_fare_s: 50, min_fare_v: 60, day_v: 600, hourly_v_rate: 80, peak_surcharge_pct: 20 }),
    { floor: 25, ceiling: 3956 },
  );
});

test('driverEarning is 80%, baseFare preferred over price', () => {
  assert.equal(driverEarning({ baseFare: 100 }), 80);
  assert.equal(driverEarning({ price: 50 }), 40);
  assert.equal(driverEarning({ baseFare: 100, price: 50 }), 80);
  assert.equal(driverEarning({}), 0);
});

test('dispatchPay is 80% with a £95 default base', () => {
  assert.equal(dispatchPay({}), 76);
  assert.equal(dispatchPay({ baseFare: 200 }), 160);
});

test('subscription-model commission is adjustable and clamped to 0–50', () => {
  assert.equal(driverEarning({ baseFare: 100 }, 10), 90);   // admin sets 10%
  assert.equal(driverEarning({ baseFare: 100 }, 0), 100);   // pure subscription, 0% cut
  assert.equal(driverEarning({ baseFare: 100 }, 99), 50);   // clamped at 50
  assert.equal(driverEarning({ baseFare: 100 }, -5), 100);  // clamped at 0
  assert.equal(driverEarning({ baseFare: 100 }, NaN), 80);  // junk → default 20%
  assert.equal(dispatchPay({ baseFare: 200 }, 10), 180);
  assert.equal(normalizeCommissionPct(undefined), 20);
});

test('bookingEvent: create / delete / status transitions', () => {
  assert.equal(bookingEvent(null, { status: 'pending' }), 'received');
  assert.equal(bookingEvent({ status: 'pending' }, null), null);
  assert.equal(bookingEvent({ status: 'pending' }, { status: 'confirmed' }), 'confirmed');
  assert.equal(bookingEvent({ status: 'confirmed' }, { status: 'en_route' }), 'en_route');
  assert.equal(bookingEvent({ status: 'confirmed' }, { status: 'arriving' }), 'en_route');
  assert.equal(bookingEvent({ status: 'en_route' }, { status: 'completed' }), 'completed');
  assert.equal(bookingEvent({ status: 'pending' }, { status: 'cancelled' }), 'cancelled');
  assert.equal(bookingEvent({ status: 'pending' }, { status: 'pending' }), null); // no change
});

test('bookingEvent: driver assigned by name appearing', () => {
  assert.equal(bookingEvent({ status: 'confirmed' }, { status: 'confirmed', driverName: 'Sam' }), 'driver_assigned');
});

test('bookingMessage builds subject + body, unknown → null', () => {
  const [subject, body] = bookingMessage('received', { ref: 'APX-1', pickup: 'Mayfair', airport: 'Heathrow T5', date: '2026-07-01', time: '9am' })!;
  assert.match(subject, /received your booking/i);
  assert.match(body, /APX-1/);
  assert.match(body, /Mayfair → Heathrow T5/);
  assert.equal(bookingMessage('nonsense', {}), null);
});

test('daysUntil from a fixed clock', () => {
  const now = new Date('2026-06-29T12:00:00Z');
  assert.equal(daysUntil('2026-06-30', now), 1);
  assert.equal(daysUntil('2026-06-29', now), 0);
  assert.equal(daysUntil('2026-06-22', now), -7);
  assert.equal(daysUntil('not-a-date', now), null);
  assert.equal(daysUntil(undefined, now), null);
});

test('shouldRemind: milestones and weekly-after-expiry', () => {
  for (const d of [30, 14, 7, 3, 1, 0]) assert.equal(shouldRemind(d), true);
  assert.equal(shouldRemind(29), false);
  assert.equal(shouldRemind(-7), true);  // a week overdue
  assert.equal(shouldRemind(-14), true);
  assert.equal(shouldRemind(-3), false); // not a weekly mark
  assert.equal(shouldRemind(null), false);
});

test('flightHHMM extracts HH:MM from an ISO datetime', () => {
  assert.equal(flightHHMM('2026-06-29T07:35:00+00:00'), '07:35');
  assert.equal(flightHHMM(''), '');
  assert.equal(flightHHMM(undefined), '');
});
