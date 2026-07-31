import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidRating, clampComment, submitRating, type RatingBackend } from './rating.ts';

test('isValidRating accepts integers 1..5 only', () => {
  for (const n of [1, 2, 3, 4, 5]) assert.equal(isValidRating(n), true);
  for (const n of [0, 6, -1, 2.5, NaN]) assert.equal(isValidRating(n), false);
});

test('clampComment caps at 1000 chars', () => {
  assert.equal(clampComment('x'.repeat(1200)).length, 1000);
  assert.equal(clampComment('great'), 'great');
});

test('submitRating rejects an out-of-range rating without calling the backend', async () => {
  let called = false;
  const backend: RatingBackend = { submitTripRating: async () => { called = true; return { ok: true }; } };
  const ok = await submitRating(backend, { bookingRef: 'APX-1', rating: 9 });
  assert.equal(ok, false);
  assert.equal(called, false);
});

test('submitRating rejects when there is no booking reference', async () => {
  const backend: RatingBackend = { submitTripRating: async () => ({ ok: true }) };
  assert.equal(await submitRating(backend, { bookingRef: '', rating: 5 }), false);
});

test('submitRating sends a clamped comment and the driverId', async () => {
  let sent: { comment?: string; driverId?: string } | null = null;
  const backend: RatingBackend = {
    submitTripRating: async (d) => { sent = { comment: d.comment, driverId: d.driverId }; return { ok: true }; },
  };
  const ok = await submitRating(backend, { bookingRef: 'APX-1', rating: 5, comment: 'y'.repeat(2000), driverId: 'drv1' });
  assert.equal(ok, true);
  assert.equal(sent!.comment!.length, 1000);
  assert.equal(sent!.driverId, 'drv1');
});

test('submitRating returns false when offline (no backend)', async () => {
  assert.equal(await submitRating(null, { bookingRef: 'APX-1', rating: 5 }), false);
});
