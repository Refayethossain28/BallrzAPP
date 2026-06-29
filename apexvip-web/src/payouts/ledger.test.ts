import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateOwedBalances, formatSettlement, type PayoutLedgerEntry } from './ledger.ts';

test('groups by driver, summing amounts and counting trips', () => {
  const ledger: PayoutLedgerEntry[] = [
    { driverId: 'd1', amount: 80, currency: 'GBP', status: 'owed' },
    { driverId: 'd1', amount: 76, currency: 'GBP', status: 'owed' },
    { driverId: 'd2', amount: 50, currency: 'GBP', status: 'owed' },
  ];
  assert.deepEqual(aggregateOwedBalances(ledger), [
    { driverId: 'd1', amount: 156, count: 2, currency: 'GBP' },
    { driverId: 'd2', amount: 50, count: 1, currency: 'GBP' },
  ]);
});

test('skips entries without a driverId', () => {
  const r = aggregateOwedBalances([
    { amount: 99, status: 'owed' },
    { driverId: 'd1', amount: 10, status: 'owed' },
  ]);
  assert.deepEqual(r, [{ driverId: 'd1', amount: 10, count: 1, currency: 'GBP' }]);
});

test('ignores already-paid entries', () => {
  const r = aggregateOwedBalances([
    { driverId: 'd1', amount: 10, status: 'owed' },
    { driverId: 'd1', amount: 999, status: 'paid' },
  ]);
  assert.deepEqual(r, [{ driverId: 'd1', amount: 10, count: 1, currency: 'GBP' }]);
});

test('non-numeric amounts count as zero but still tally a trip', () => {
  const r = aggregateOwedBalances([
    { driverId: 'd1', amount: undefined, status: 'owed' },
    { driverId: 'd1', amount: 40, status: 'owed' },
  ]);
  assert.deepEqual(r, [{ driverId: 'd1', amount: 40, count: 2, currency: 'GBP' }]);
});

test('currency comes from the first entry seen for a driver; GBP default', () => {
  const r = aggregateOwedBalances([
    { driverId: 'd1', amount: 10, currency: 'EUR', status: 'owed' },
    { driverId: 'd1', amount: 10, currency: 'USD', status: 'owed' },
    { driverId: 'd2', amount: 5, status: 'owed' },
  ]);
  assert.equal(r[0].currency, 'EUR');
  assert.equal(r[1].currency, 'GBP');
});

test('formatSettlement: normal and mock', () => {
  assert.equal(
    formatSettlement({ paid: 156, count: 2, currency: 'GBP' }),
    'Paid GBP 156 across 2 trip(s).',
  );
  assert.equal(
    formatSettlement({ paid: 0, count: 0, mock: true }),
    'Paid GBP 0 across 0 trip(s) (mock — no Stripe key set).',
  );
});
