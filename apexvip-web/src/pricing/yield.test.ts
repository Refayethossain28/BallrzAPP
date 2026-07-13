import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yieldMultiplier, YIELD_CAP, YIELD_FLOOR, YIELD_STEP } from './yield.ts';

test('balanced market quotes 1.0-ish and never exceeds the hard cap', () => {
  const calm = yieldMultiplier({ openJobs: 1, idleDrivers: 4, previous: 1 });
  assert.ok(calm.multiplier >= 1 && calm.multiplier <= 1.1);
  // Absurd scarcity still cannot break the cap, even after many updates.
  let m = 1;
  for (let i = 0; i < 50; i++) m = yieldMultiplier({ openJobs: 500, idleDrivers: 1, previous: m }).multiplier;
  assert.ok(m <= YIELD_CAP + 1e-9, String(m));
});

test('log damping: doubling scarcity does not double the premium', () => {
  const p2 = yieldMultiplier({ openJobs: 2, idleDrivers: 1, previous: YIELD_CAP }).target - 1;
  const p4 = yieldMultiplier({ openJobs: 4, idleDrivers: 1, previous: YIELD_CAP }).target - 1;
  assert.ok(p4 < p2 * 2);
});

test('hysteresis: one step per update, direction reported honestly', () => {
  const up = yieldMultiplier({ openJobs: 30, idleDrivers: 1, previous: 1 });
  assert.equal(up.multiplier, 1 + YIELD_STEP);
  assert.equal(up.direction, 'rising');
  const down = yieldMultiplier({ openJobs: 0, idleDrivers: 8, heat: 0.5, previous: 1.3 });
  assert.equal(down.multiplier, 1.25);
  assert.equal(down.direction, 'falling');
});

test('quantized to 0.05 steps', () => {
  const q = yieldMultiplier({ openJobs: 3, idleDrivers: 2, previous: 1.1 });
  assert.ok(Math.abs(q.multiplier / YIELD_STEP - Math.round(q.multiplier / YIELD_STEP)) < 1e-9);
});

test('quiet market eases to the courtesy floor, never below', () => {
  let m = 1;
  for (let i = 0; i < 10; i++) m = yieldMultiplier({ openJobs: 0, idleDrivers: 6, heat: 0.5, previous: m }).multiplier;
  assert.equal(m, YIELD_FLOOR);
});

test('loyalty immunity: members are never surged but still get quiet-hour prices', () => {
  const vip = yieldMultiplier({ openJobs: 40, idleDrivers: 1, previous: 1.3, clientTier: 'black' });
  assert.equal(vip.multiplier, 1);
  assert.ok(vip.loyaltyProtected);
  const vipQuiet = yieldMultiplier({ openJobs: 0, idleDrivers: 6, heat: 0.5, previous: 0.95, clientTier: 'gold' });
  assert.ok(vipQuiet.multiplier < 1); // discounts DO apply to members
  assert.ok(!vipQuiet.loyaltyProtected);
});

test('ApexPulse heat pre-warms pricing before the queue forms', () => {
  const cold = yieldMultiplier({ openJobs: 2, idleDrivers: 2, heat: 1.0, previous: 1.2 });
  const hot = yieldMultiplier({ openJobs: 2, idleDrivers: 2, heat: 2.5, previous: 1.2 });
  assert.ok(hot.target > cold.target);
});

test('an off-grid previous still moves at most one 0.05 step', () => {
  const q = yieldMultiplier({ openJobs: 0, idleDrivers: 8, heat: 0.5, previous: 1.02 });
  // 1.02 snaps to 1.00; one step down is 0.95 — never a 0.07+ jump.
  assert.ok(Math.abs(q.multiplier - 1.0) <= YIELD_STEP + 1e-9, String(q.multiplier));
});
