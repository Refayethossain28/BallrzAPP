import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMandateActive, dueCollections, coveredPeriods, mandateLabel, COLLECTION_LEAD_DAYS,
  type RentCollection,
} from '../src/collection.ts';
import type { Tenancy } from '../src/rent.ts';

const start = Date.UTC(2026, 0, 15);
const tenancy: Tenancy = { startDate: start, monthlyRentPence: 120_000, termMonths: 12 };

test('only an active mandate may be collected against', () => {
  assert.equal(isMandateActive({ status: 'active' }), true);
  assert.equal(isMandateActive({ status: 'pending' }), false);
  assert.equal(isMandateActive(null), false);
  assert.equal(isMandateActive(undefined), false);
});

test('a charge inside the lead window is due for collection', () => {
  const asOf = start - (COLLECTION_LEAD_DAYS - 1) * 86_400_000; // 2 days before due
  const due = dueCollections(tenancy, [], asOf);
  assert.equal(due[0].period, '2026-01');
  assert.equal(due[0].amountPence, 120_000);
});

test('charges beyond the lead window are not yet collected', () => {
  const asOf = start - 30 * 86_400_000; // a month before the first charge
  assert.deepEqual(dueCollections(tenancy, [], asOf), []);
});

test('covered periods are not collected again (idempotent)', () => {
  const asOf = Date.UTC(2026, 0, 20); // Jan due/passed
  const all = dueCollections(tenancy, [], asOf);
  assert.ok(all.some((c) => c.period === '2026-01'));
  const after = dueCollections(tenancy, ['2026-01'], asOf);
  assert.ok(!after.some((c) => c.period === '2026-01'));
});

test('overdue uncovered charges are still collected (catch-up)', () => {
  const asOf = Date.UTC(2026, 2, 20); // Jan, Feb, Mar all due
  const due = dueCollections(tenancy, ['2026-01'], asOf); // Jan already collected
  const periods = due.map((c) => c.period);
  assert.deepEqual(periods, ['2026-02', '2026-03']);
});

test('coveredPeriods counts standing collections but frees failed ones for retry', () => {
  const collections: RentCollection[] = [
    { period: '2026-01', amountPence: 120_000, status: 'confirmed', chargeDate: start },
    { period: '2026-02', amountPence: 120_000, status: 'submitted', chargeDate: Date.UTC(2026, 1, 15) },
    { period: '2026-03', amountPence: 120_000, status: 'failed', chargeDate: Date.UTC(2026, 2, 15) },
  ];
  assert.deepEqual(coveredPeriods(collections).sort(), ['2026-01', '2026-02']);
});

test('mandateLabel describes each state', () => {
  assert.equal(mandateLabel({ status: 'active' }), 'Direct Debit active');
  assert.equal(mandateLabel({ status: 'pending' }), 'Direct Debit setup in progress');
  assert.equal(mandateLabel(null), 'No Direct Debit');
});
