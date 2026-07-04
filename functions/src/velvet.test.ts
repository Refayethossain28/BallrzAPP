/**
 * Unit tests for the pure webhook helpers in velvet.ts — the pieces that map
 * Stripe's world onto the concierge membership. These run with no emulator
 * (node --test, like logic.test.ts); the Firestore-touching paths are covered
 * by the rules tests and exercised end-to-end in production by the webhook.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { safeReturnUrl, tierFromSubscription, mapStatus } from './velvet.ts';

const DEFAULT = 'https://refayethossain28.github.io/BallrzAPP/concierge/';

test('safeReturnUrl: https and localhost pass; everything else falls back', () => {
  assert.equal(safeReturnUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(safeReturnUrl('http://localhost:5173/app'), 'http://localhost:5173/app');
  assert.equal(safeReturnUrl('http://evil.com/x'), DEFAULT);       // plain http
  assert.equal(safeReturnUrl('javascript:alert(1)'), DEFAULT);
  assert.equal(safeReturnUrl(''), DEFAULT);
  assert.equal(safeReturnUrl(undefined), DEFAULT);
  assert.equal(safeReturnUrl('https://a b'), DEFAULT);             // whitespace
});

const sub = (over: Record<string, unknown>): Stripe.Subscription =>
  ({ metadata: {}, items: { data: [] }, ...over }) as unknown as Stripe.Subscription;

test('tierFromSubscription: metadata wins, lookup_key is the fallback, silver the default', () => {
  assert.equal(tierFromSubscription(sub({ metadata: { tier: 'black' } })), 'black');
  assert.equal(tierFromSubscription(sub({ metadata: { tier: 'nonsense' },
    items: { data: [{ price: { lookup_key: 'velvet_gold_monthly' } }] } })), 'gold');
  assert.equal(tierFromSubscription(sub({
    items: { data: [{ price: { lookup_key: 'someone_elses_key' } }] } })), 'silver');
  assert.equal(tierFromSubscription(sub({})), 'silver');
});

test('mapStatus: trial and active-ish map through; everything else is canceled', () => {
  assert.equal(mapStatus('trialing'), 'trialing');
  assert.equal(mapStatus('active'), 'active');
  assert.equal(mapStatus('past_due'), 'active');   // grace — Stripe retries the charge
  for (const s of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'] as const) {
    assert.equal(mapStatus(s), 'canceled');
  }
});
