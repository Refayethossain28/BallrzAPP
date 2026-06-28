import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renewalDefaults, rentChangePct, applyRenewal } from '../src/renewal.ts';
import type { Tenancy } from '../src/rent.ts';

const tenancy: Tenancy = { startDate: Date.UTC(2026, 0, 15), monthlyRentPence: 120_000, termMonths: 12 };

test('renewal defaults start when the current term ends', () => {
  const asOf = Date.UTC(2026, 10, 1); // before the term ends (15 Jan 2027)
  const d = renewalDefaults(tenancy, asOf);
  assert.equal(d.startDate, Date.UTC(2027, 0, 15));
  assert.equal(d.termMonths, 12);
  assert.equal(d.monthlyRentPence, 120_000);
});

test('if the term already ended, the renewal starts today', () => {
  const asOf = Date.UTC(2027, 2, 1); // after the term end
  assert.equal(renewalDefaults(tenancy, asOf).startDate, asOf);
});

test('rentChangePct reports the increase', () => {
  assert.equal(rentChangePct(120_000, 126_000), 5);
  assert.equal(rentChangePct(120_000, 120_000), 0);
  assert.equal(rentChangePct(0, 100_000), 0);
});

test('applyRenewal yields a fresh term', () => {
  const terms = { startDate: Date.UTC(2027, 0, 15), termMonths: 6, monthlyRentPence: 130_000 };
  assert.deepEqual(applyRenewal(terms), terms);
});
