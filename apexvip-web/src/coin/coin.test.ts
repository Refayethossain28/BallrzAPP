import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientCoinsEarned,
  driverCoinsEarned,
  coinEarnRates,
  earnPctForBalance,
  apexTier,
  apexTierColor,
  tierProgress,
  applyCoinRedemption,
  appendCoinTx,
  coinSupply,
  round2,
} from './coin.ts';

test('clientCoinsEarned: tier % of the fare, whole coins, junk-safe', () => {
  assert.equal(clientCoinsEarned(200), 6); // Bronze default 3%
  assert.equal(clientCoinsEarned(200, 5), 10); // Gold rate
  assert.equal(clientCoinsEarned(185, 5), 9); // round(9.25)
  assert.equal(clientCoinsEarned(190, 5), 10); // round(9.5) rounds up
  assert.equal(clientCoinsEarned(0, 6), 0);
  assert.equal(clientCoinsEarned(-50, 6), 0);
  assert.equal(clientCoinsEarned(NaN, 4), 0);
  assert.equal(clientCoinsEarned(200, NaN), 6); // junk rate → Bronze default
});

test('driverCoinsEarned: % of job pay at 2 dp, junk-safe', () => {
  assert.equal(driverCoinsEarned(152), 3.04); // default 2%
  assert.equal(driverCoinsEarned(95.55), 1.91); // 1.911 → 1.91
  assert.equal(driverCoinsEarned(152, 3), 4.56); // admin-tuned rate
  assert.equal(driverCoinsEarned(-10), 0);
  assert.equal(driverCoinsEarned(undefined as unknown as number), 0);
});

test('coinEarnRates: defaults 3/4/5/6 + 2, admin overrides clamped to 0–20', () => {
  assert.deepEqual(coinEarnRates(null), {
    tiers: { Bronze: 3, Silver: 4, Gold: 5, Platinum: 6 },
    driverPct: 2,
  });
  const tuned = coinEarnRates({ bronzePct: 2.5, platinumPct: 50, driverPct: -3, goldPct: 'junk' as unknown as number });
  assert.equal(tuned.tiers.Bronze, 2.5);
  assert.equal(tuned.tiers.Platinum, 20); // clamped ceiling
  assert.equal(tuned.tiers.Gold, 5); // junk → default
  assert.equal(tuned.driverPct, 0); // clamped floor
});

test('earnPctForBalance: the balance\'s tier picks the rate', () => {
  assert.equal(earnPctForBalance(0), 3);
  assert.equal(earnPctForBalance(600), 4);
  assert.equal(earnPctForBalance(2500), 5);
  assert.equal(earnPctForBalance(9000), 6);
  assert.equal(earnPctForBalance(600, coinEarnRates({ silverPct: 4.5 })), 4.5);
});

test('round2 avoids float drift', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(3.045 * 1), 3.05);
});

test('apexTier: ladder boundaries are inclusive', () => {
  assert.equal(apexTier(0), 'Bronze');
  assert.equal(apexTier(499), 'Bronze');
  assert.equal(apexTier(500), 'Silver');
  assert.equal(apexTier(1999), 'Silver');
  assert.equal(apexTier(2000), 'Gold');
  assert.equal(apexTier(5000), 'Platinum');
  assert.equal(apexTier(-5), 'Bronze');
  assert.equal(apexTier(NaN), 'Bronze');
});

test('apexTierColor: known tiers, Bronze fallback for junk', () => {
  assert.equal(apexTierColor('Platinum'), '#b9f2ff');
  assert.equal(apexTierColor('nonsense'), '#cd7f32');
});

test('tierProgress: next rung, target and whole-percent bar', () => {
  assert.deepEqual(tierProgress(250), { tier: 'Bronze', next: 'Silver', target: 500, pct: 50 });
  assert.deepEqual(tierProgress(500), { tier: 'Silver', next: 'Gold', target: 2000, pct: 25 });
  assert.deepEqual(tierProgress(4999), { tier: 'Gold', next: 'Platinum', target: 5000, pct: 99 });
  assert.deepEqual(tierProgress(9000), { tier: 'Platinum', next: null, target: null, pct: 100 });
});

test('applyCoinRedemption: balance covers part of the fare', () => {
  assert.deepEqual(applyCoinRedemption(148, 60), { redeemed: 60, cashDue: 88, newBalance: 0 });
});

test('applyCoinRedemption: balance exceeds the fare — fare never overpaid', () => {
  assert.deepEqual(applyCoinRedemption(95, 500), { redeemed: 95, cashDue: 0, newBalance: 405 });
});

test('applyCoinRedemption: whole coins only; fractional balance keeps its remainder', () => {
  assert.deepEqual(applyCoinRedemption(100, 42.75), { redeemed: 42, cashDue: 58, newBalance: 0.75 });
});

test('applyCoinRedemption: zero/negative/junk inputs redeem nothing', () => {
  assert.deepEqual(applyCoinRedemption(0, 100), { redeemed: 0, cashDue: 0, newBalance: 100 });
  assert.deepEqual(applyCoinRedemption(100, 0), { redeemed: 0, cashDue: 100, newBalance: 0 });
  assert.deepEqual(applyCoinRedemption(-50, -10), { redeemed: 0, cashDue: 0, newBalance: 0 });
  assert.deepEqual(applyCoinRedemption(NaN, NaN), { redeemed: 0, cashDue: 0, newBalance: 0 });
});

test('appendCoinTx: prepends and caps the history', () => {
  const hist = appendCoinTx([{ n: 1 }, { n: 2 }], { n: 3 });
  assert.deepEqual(hist, [{ n: 3 }, { n: 1 }, { n: 2 }]);
  const capped = appendCoinTx([{ n: 1 }, { n: 2 }], { n: 3 }, 2);
  assert.deepEqual(capped, [{ n: 3 }, { n: 1 }]);
  assert.deepEqual(appendCoinTx(null, { n: 1 }), [{ n: 1 }]);
});

test('coinSupply: client earns + driver earns − redemptions, floored at zero', () => {
  const events = [
    { e: 'apex_earned', amount: 9 },
    { event: 'apex_earned', amount: 7 }, // legacy key
    { e: 'trip_completed', axc: 3.04, pay: 152 },
    { e: 'trip_completed', pay: 80 }, // no axc field → contributes nothing
    { e: 'apex_redeemed', amount: 5 },
    { e: 'booking_confirmed', price: 148 }, // unrelated event ignored
  ];
  assert.deepEqual(coinSupply(events), { issued: 19.04, redeemed: 5, circulating: 14.04, onchain: 0 });
});

test('coinSupply: bridge flows move coins between in-app and on-chain', () => {
  const events = [
    { e: 'apex_earned', amount: 20 },
    { e: 'apex_withdrawn', amount: 12 },
    { e: 'apex_deposited', amount: 5 },
    { e: 'apex_redeemed', amount: 3 },
  ];
  // on-chain 12−5=7; in-app 20−3−7=10
  assert.deepEqual(coinSupply(events), { issued: 20, redeemed: 3, circulating: 10, onchain: 7 });
});

test('coinSupply: never reports negative figures, junk-safe', () => {
  assert.deepEqual(coinSupply([{ e: 'apex_redeemed', amount: 10 }]), { issued: 0, redeemed: 10, circulating: 0, onchain: 0 });
  assert.deepEqual(coinSupply(null), { issued: 0, redeemed: 0, circulating: 0, onchain: 0 });
  assert.deepEqual(coinSupply([{ e: 'apex_earned', amount: 'junk' }, { e: 'apex_deposited', amount: 4 }]), { issued: 0, redeemed: 0, circulating: 0, onchain: 0 });
});
