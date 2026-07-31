import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteFare } from './pricing.ts';

test('no promo: VAT is 1/6 of the total', () => {
  assert.deepEqual(quoteFare(185, false), { base: 185, discount: 0, total: 185, vat: 31 });
});

test('promo applies a 20% discount, VAT on the discounted total', () => {
  // base 185 → discount 37 → total 148 → vat round(148/6)=25
  assert.deepEqual(quoteFare(185, true), { base: 185, discount: 37, total: 148, vat: 25 });
});

test('rounding: discount and VAT are rounded to whole pounds', () => {
  // base 95 → discount round(19)=19 → total 76 → vat round(12.67)=13
  assert.deepEqual(quoteFare(95, true), { base: 95, discount: 19, total: 76, vat: 13 });
});

test('zero base is a no-op', () => {
  assert.deepEqual(quoteFare(0, true), { base: 0, discount: 0, total: 0, vat: 0 });
});
