import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEarnings, dailyEarnings, owedBalance, type LedgerRowLike } from './earnings.ts';

const NOW = new Date('2026-07-03T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const ROWS: LedgerRowLike[] = [
  { amount: 76, bookingRef: 'APX-1', status: 'paid', createdAt: NOW },
  { amount: 104, bookingRef: 'APX-2', status: 'owed', createdAt: { toDate: () => daysAgo(2) } },
  { amount: 148, bookingRef: 'APX-3', status: 'owed', createdAt: daysAgo(10).toISOString() },
  { amount: 99, bookingRef: 'APX-4', status: 'paid', createdAt: daysAgo(40) },
  { amount: 50, bookingRef: 'BAD', status: 'owed', createdAt: null },  // ignored: no date
];

test('summarizeEarnings: today / rolling week / rolling month', () => {
  assert.deepEqual(
    (({ total, count }) => ({ total, count }))(summarizeEarnings(ROWS, 'today', NOW)),
    { total: 76, count: 1 });
  assert.equal(summarizeEarnings(ROWS, 'week', NOW).total, 180);   // 76 + 104
  assert.equal(summarizeEarnings(ROWS, 'month', NOW).total, 328);  // + 148
});

test('summarizeEarnings sorts newest first and resolves mixed date shapes', () => {
  const rows = summarizeEarnings(ROWS, 'month', NOW).rows;
  assert.deepEqual(rows.map(r => r.ref), ['APX-1', 'APX-2', 'APX-3']);
});

test('dailyEarnings: 7 bars, Today last, correct sums and max', () => {
  const { bars, labels, max } = dailyEarnings(ROWS, NOW);
  assert.equal(bars.length, 7);
  assert.equal(labels[6], 'Today');
  assert.equal(bars[6], 76);
  assert.equal(bars[4], 104);      // two days ago
  assert.equal(max, 104);
});

test('owedBalance sums only unsettled rows with usable dates', () => {
  assert.equal(owedBalance(ROWS), 104 + 148);
  assert.equal(owedBalance([]), 0);
  assert.equal(owedBalance(null), 0);
});
