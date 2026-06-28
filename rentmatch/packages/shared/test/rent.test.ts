import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, rentSchedule, buildRentLedger, daysUntilDue, type Tenancy,
} from '../src/rent.ts';

const DAY = 86_400_000;
const start = Date.UTC(2026, 0, 15); // 15 Jan 2026
const tenancy: Tenancy = { startDate: start, monthlyRentPence: 120_000, termMonths: 12 };

test('addMonths advances by calendar month and preserves the day', () => {
  assert.equal(addMonths(start, 1), Date.UTC(2026, 1, 15));
  assert.equal(addMonths(start, 12), Date.UTC(2027, 0, 15));
});

test('addMonths clamps to the last day of a shorter month', () => {
  const jan31 = Date.UTC(2026, 0, 31);
  assert.equal(addMonths(jan31, 1), Date.UTC(2026, 1, 28)); // Feb 2026 has 28 days
});

test('rentSchedule produces one charge per term month, in order', () => {
  const schedule = rentSchedule(tenancy);
  assert.equal(schedule.length, 12);
  assert.equal(schedule[0].period, '2026-01');
  assert.equal(schedule[11].period, '2026-12');
  assert.ok(schedule.every((c) => c.amountPence === 120_000));
});

test('before the tenancy starts nothing is due — status upcoming', () => {
  const led = buildRentLedger(tenancy, [], Date.UTC(2026, 0, 1));
  assert.equal(led.totalDuePence, 0);
  assert.equal(led.status, 'upcoming');
  assert.equal(led.nextDueDate, start);
});

test('an unpaid month in the past is arrears', () => {
  const led = buildRentLedger(tenancy, [], Date.UTC(2026, 0, 20)); // first charge passed, unpaid
  assert.equal(led.totalDuePence, 120_000);
  assert.equal(led.arrearsPence, 120_000);
  assert.equal(led.monthsInArrears, 1);
  assert.equal(led.status, 'arrears');
  assert.equal(led.nextDueDate, Date.UTC(2026, 1, 15));
});

test('three months in, two paid → one month of arrears', () => {
  const asOf = Date.UTC(2026, 2, 20); // Jan, Feb, Mar charges due (3 × 120k)
  const payments = [
    { date: Date.UTC(2026, 0, 16), amountPence: 120_000 },
    { date: Date.UTC(2026, 1, 16), amountPence: 120_000 },
  ];
  const led = buildRentLedger(tenancy, payments, asOf);
  assert.equal(led.totalDuePence, 360_000);
  assert.equal(led.totalPaidPence, 240_000);
  assert.equal(led.balancePence, 120_000);
  assert.equal(led.monthsInArrears, 1);
  assert.equal(led.status, 'arrears');
});

test('paying ahead puts the tenant in credit, never also in arrears', () => {
  const asOf = Date.UTC(2026, 0, 20); // only Jan due
  const led = buildRentLedger(tenancy, [{ date: start, amountPence: 240_000 }], asOf);
  assert.equal(led.balancePence, -120_000);
  assert.equal(led.creditPence, 120_000);
  assert.equal(led.arrearsPence, 0);
  assert.equal(led.status, 'credit');
});

test('exactly settled to date reads as paid', () => {
  const asOf = Date.UTC(2026, 1, 20); // Jan + Feb due
  const led = buildRentLedger(tenancy, [{ date: start, amountPence: 240_000 }], asOf);
  assert.equal(led.balancePence, 0);
  assert.equal(led.status, 'paid');
});

test('daysUntilDue is positive before and negative after', () => {
  assert.equal(daysUntilDue(start, start - 3 * DAY), 3);
  assert.equal(daysUntilDue(start, start + 2 * DAY), -2);
});
