import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  taxYearStartYear, taxYearLabel, taxYearRange, summariseFinances, taxYearsPresent,
  type ExpenseEntry, type FinanceEntry,
} from '../src/finance.ts';

test('UK tax year boundary is 6 April', () => {
  assert.equal(taxYearStartYear(Date.UTC(2027, 3, 5)), 2026); // 5 Apr 2027 → 2026/27
  assert.equal(taxYearStartYear(Date.UTC(2027, 3, 6)), 2027); // 6 Apr 2027 → 2027/28
  assert.equal(taxYearStartYear(Date.UTC(2026, 11, 31)), 2026);
});

test('tax year labels and ranges', () => {
  assert.equal(taxYearLabel(2026), '2026/27');
  const { start, end } = taxYearRange(2026);
  assert.equal(start, Date.UTC(2026, 3, 6));
  assert.equal(end, Date.UTC(2027, 3, 6));
});

const income: FinanceEntry[] = [
  { date: Date.UTC(2026, 4, 1), amountPence: 120_000 }, // in 2026/27
  { date: Date.UTC(2026, 5, 1), amountPence: 120_000 }, // in 2026/27
  { date: Date.UTC(2027, 4, 1), amountPence: 130_000 }, // next year
];
const expenses: ExpenseEntry[] = [
  { date: Date.UTC(2026, 4, 10), amountPence: 30_000, category: 'repairs-maintenance' },
  { date: Date.UTC(2026, 6, 10), amountPence: 12_000, category: 'insurance' },
  { date: Date.UTC(2026, 7, 1), amountPence: 50_000, category: 'mortgage-interest' },
  { date: Date.UTC(2025, 5, 1), amountPence: 99_999, category: 'other' }, // previous year — excluded
];

test('summary nets income and expenses within the chosen tax year only', () => {
  const s = summariseFinances(income, expenses, 2026);
  assert.equal(s.label, '2026/27');
  assert.equal(s.incomePence, 240_000);
  assert.equal(s.expensePence, 92_000);
  assert.equal(s.netPence, 240_000 - 92_000);
});

test('mortgage interest is separated from allowable expenses', () => {
  const s = summariseFinances(income, expenses, 2026);
  assert.equal(s.mortgageInterestPence, 50_000);
  assert.equal(s.allowableExpensePence, 92_000 - 50_000);
});

test('byCategory lists non-zero totals largest first', () => {
  const s = summariseFinances(income, expenses, 2026);
  assert.equal(s.byCategory[0].category, 'mortgage-interest'); // 50k
  assert.equal(s.byCategory[1].category, 'repairs-maintenance'); // 30k
  assert.ok(s.byCategory.every((c) => c.amountPence > 0));
});

test('a different tax year sees its own figures', () => {
  const s = summariseFinances(income, expenses, 2027);
  assert.equal(s.incomePence, 130_000);
  assert.equal(s.expensePence, 0);
});

test('taxYearsPresent includes the current year and every year with data, newest first', () => {
  const years = taxYearsPresent([...income, ...expenses], Date.UTC(2026, 4, 1));
  assert.equal(years[0], years.slice().sort((a, b) => b - a)[0]);
  assert.ok(years.includes(2025));
  assert.ok(years.includes(2026));
  assert.ok(years.includes(2027));
});
