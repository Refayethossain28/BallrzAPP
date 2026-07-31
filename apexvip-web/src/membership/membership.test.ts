import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  membershipState, keepPercent, trialEndDate, normalizeCommissionPct,
  DEFAULT_TRIAL_DAYS, type BusinessSettings,
} from './membership.ts';

const SUB_MODE: BusinessSettings = { model: 'subscription', trialDays: 30, commissionPct: 20 };
const NOW = new Date('2026-07-03T12:00:00Z');

test('commission mode is always off — no banners, no gates', () => {
  assert.deepEqual(membershipState(null, { model: 'commission' }, NOW), { mode: 'off' });
  assert.deepEqual(membershipState({ status: 'active' }, null, NOW), { mode: 'off' });
  assert.deepEqual(membershipState({ status: 'trial', trialEndsAt: new Date(0) }, undefined, NOW), { mode: 'off' });
});

test('no subscription doc yet → fresh trial with the configured days', () => {
  assert.deepEqual(membershipState(null, SUB_MODE, NOW), { mode: 'trial', daysLeft: 30 });
  assert.deepEqual(membershipState(undefined, { model: 'subscription' }, NOW), { mode: 'trial', daysLeft: DEFAULT_TRIAL_DAYS });
});

test('active membership wins regardless of trial dates', () => {
  assert.deepEqual(membershipState({ status: 'active', trialEndsAt: new Date(0) }, SUB_MODE, NOW), { mode: 'active' });
});

test('trial counts whole days left; expiry flips to expired', () => {
  const in36h = new Date(NOW.getTime() + 36 * 3600_000);
  assert.deepEqual(membershipState({ status: 'trial', trialEndsAt: in36h }, SUB_MODE, NOW), { mode: 'trial', daysLeft: 2 });
  const past = new Date(NOW.getTime() - 1000);
  assert.deepEqual(membershipState({ status: 'trial', trialEndsAt: past }, SUB_MODE, NOW), { mode: 'expired' });
});

test('accepts Firestore Timestamp-shaped and ISO-string trial ends', () => {
  const ts = { toDate: () => new Date(NOW.getTime() + 10 * 86_400_000) };
  assert.deepEqual(membershipState({ status: 'trial', trialEndsAt: ts }, SUB_MODE, NOW), { mode: 'trial', daysLeft: 10 });
  const iso = new Date(NOW.getTime() + 86_400_000).toISOString();
  assert.deepEqual(membershipState({ status: 'trial', trialEndsAt: iso }, SUB_MODE, NOW), { mode: 'trial', daysLeft: 1 });
  assert.deepEqual(membershipState({ status: 'trial', trialEndsAt: 'garbage' }, SUB_MODE, NOW), { mode: 'expired' });
});

test('keepPercent: 80 in commission mode, 100−commission in subscription mode, clamped', () => {
  assert.equal(keepPercent({ model: 'commission' }), 80);
  assert.equal(keepPercent(null), 80);
  assert.equal(keepPercent({ model: 'subscription', commissionPct: 10 }), 90);
  assert.equal(keepPercent({ model: 'subscription', commissionPct: 0 }), 100);
  assert.equal(keepPercent({ model: 'subscription', commissionPct: 99 }), 50);
  assert.equal(keepPercent({ model: 'subscription', commissionPct: NaN }), 80);
});

test('normalizeCommissionPct mirrors the backend clamp', () => {
  assert.equal(normalizeCommissionPct(undefined), 20);
  assert.equal(normalizeCommissionPct(-5), 0);
  assert.equal(normalizeCommissionPct(72), 50);
});

test('trialEndDate honours configured days and defaults', () => {
  assert.equal(trialEndDate({ trialDays: 7 }, NOW).getTime(), NOW.getTime() + 7 * 86_400_000);
  assert.equal(trialEndDate(null, NOW).getTime(), NOW.getTime() + DEFAULT_TRIAL_DAYS * 86_400_000);
});
