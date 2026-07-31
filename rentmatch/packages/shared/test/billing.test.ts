import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANS,
  monthlyPricePence,
  canTrackUnits,
  smallestPlanFor,
  isSubscriptionActive,
  effectivePlan,
  type Subscription,
} from '../src/billing.ts';

test('Free is one property at £0; Landlord is a £99 flat plan up to 10', () => {
  assert.equal(monthlyPricePence('free', 1), 0);
  assert.equal(PLANS.landlord.basePence, 9_900);
  assert.equal(monthlyPricePence('landlord', 1), 9_900);
  assert.equal(monthlyPricePence('landlord', 10), 9_900); // flat, no per-unit
});

test('Agent is £49 base + £6 per unit', () => {
  assert.equal(monthlyPricePence('agent', 0), 4_900);
  assert.equal(monthlyPricePence('agent', 1), 5_500);
  assert.equal(monthlyPricePence('agent', 20), 4_900 + 20 * 600);
});

test('unit caps gate which plan may hold a portfolio', () => {
  assert.equal(canTrackUnits('free', 1), true);
  assert.equal(canTrackUnits('free', 2), false);
  assert.equal(canTrackUnits('landlord', 10), true);
  assert.equal(canTrackUnits('landlord', 11), false);
  assert.equal(canTrackUnits('agent', 500), true);
});

test('smallestPlanFor recommends the cheapest sufficient plan', () => {
  assert.equal(smallestPlanFor(1), 'free');
  assert.equal(smallestPlanFor(6), 'landlord');
  assert.equal(smallestPlanFor(10), 'landlord');
  assert.equal(smallestPlanFor(11), 'agent');
});

test('only active/trialing subscriptions grant paid features', () => {
  const active: Subscription = { plan: 'landlord', status: 'active' };
  const pastDue: Subscription = { plan: 'landlord', status: 'past_due' };
  assert.equal(isSubscriptionActive(active), true);
  assert.equal(isSubscriptionActive(pastDue), false);
  assert.equal(isSubscriptionActive(null), false);
  assert.equal(effectivePlan(active), 'landlord');
  assert.equal(effectivePlan(pastDue), 'free'); // lapses back to Free
  assert.equal(effectivePlan(null), 'free');
});
