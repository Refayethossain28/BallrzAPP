import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_FEE_PENCE,
  formatGBP,
  weeklyRentPence,
  depositCapWeeks,
  tenancyDepositCapPence,
  holdingDepositCapPence,
  isDepositWithinCap,
  poundsToPence,
} from '../src/money.ts';

test('platform fee is £100', () => {
  assert.equal(PLATFORM_FEE_PENCE, 10_000);
  assert.equal(formatGBP(PLATFORM_FEE_PENCE), '£100');
});

test('formatGBP shows pence only when non-whole', () => {
  assert.equal(formatGBP(220000), '£2,200');
  assert.equal(formatGBP(109615), '£1,096.15');
});

test('weekly rent derived from monthly', () => {
  assert.equal(weeklyRentPence(220000), 50769); // £2200pcm → £507.69/wk
});

test('deposit cap is 5 weeks under £50k/yr, 6 weeks at/above', () => {
  assert.equal(depositCapWeeks(220000), 5); // £26,400/yr
  assert.equal(depositCapWeeks(poundsToPence(4500)), 6); // £54,000/yr
  // boundary: exactly £50,000/yr is NOT under the threshold → 6 weeks
  assert.equal(depositCapWeeks(poundsToPence(50000 / 12)), 6);
});

test('tenancy + holding deposit caps', () => {
  assert.equal(tenancyDepositCapPence(220000), 50769 * 5);
  assert.equal(holdingDepositCapPence(220000), 50769);
});

test('isDepositWithinCap', () => {
  const cap = tenancyDepositCapPence(165000);
  assert.equal(isDepositWithinCap(165000, cap), true);
  assert.equal(isDepositWithinCap(165000, cap + 1), false);
});
