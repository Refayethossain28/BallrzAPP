import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, rentSchedule, buildRentLedger, daysUntilDue,
  dueRentReminders, buildRentStatementCsv, type Tenancy,
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

/* ---- rent reminders ---- */

test('a due-soon reminder fires within the window and is idempotent', () => {
  const asOf = Date.UTC(2026, 0, 13); // 2 days before the 15 Jan charge
  const due = dueRentReminders(tenancy, 0, [], asOf);
  const soon = due.find((r) => r.kind === 'due-soon');
  assert.ok(soon, 'expected a due-soon reminder');
  assert.equal(soon!.amountPence, 120_000);
  // Same key suppresses a repeat next day.
  assert.deepEqual(dueRentReminders(tenancy, 0, [soon!.key], asOf).filter((r) => r.kind === 'due-soon'), []);
});

test('no due-soon reminder outside the window', () => {
  const asOf = Date.UTC(2026, 0, 1); // 14 days before
  assert.deepEqual(dueRentReminders(tenancy, 0, [], asOf).filter((r) => r.kind === 'due-soon'), []);
});

test('an overdue reminder fires once per newly-missed month', () => {
  const jan = dueRentReminders(tenancy, 0, [], Date.UTC(2026, 0, 20));
  const r1 = jan.find((r) => r.kind === 'overdue');
  assert.ok(r1);
  assert.equal(r1!.amountPence, 120_000);
  // Same month, already sent → no repeat.
  assert.deepEqual(
    dueRentReminders(tenancy, 0, [r1!.key], Date.UTC(2026, 0, 25)).filter((r) => r.kind === 'overdue'),
    [],
  );
  // A second month falls due unpaid → a fresh overdue reminder (different key).
  const feb = dueRentReminders(tenancy, 0, [r1!.key], Date.UTC(2026, 1, 20));
  const r2 = feb.find((r) => r.kind === 'overdue');
  assert.ok(r2);
  assert.notEqual(r2!.key, r1!.key);
  assert.equal(r2!.amountPence, 240_000);
});

test('a fully-paid tenancy raises no reminders', () => {
  const asOf = Date.UTC(2026, 0, 20);
  assert.deepEqual(dueRentReminders(tenancy, 120_000, [], asOf), []);
});

/* ---- statement CSV ---- */

test('rent statement CSV lists charges, payments and a closing balance', () => {
  const asOf = Date.UTC(2026, 1, 20); // Jan + Feb due
  const csv = buildRentStatementCsv(
    { ...tenancy, tenantName: 'Tom', propertyLabel: '14 Mapledene Road' },
    [{ date: Date.UTC(2026, 0, 16), amountPence: 120_000 }],
    asOf,
  );
  const lines = csv.split('\n');
  assert.equal(lines[0], 'Date,Description,Charge (£),Payment (£)');
  assert.ok(csv.includes('Rent due (2026-01)'));
  assert.ok(csv.includes('Payment received'));
  assert.ok(csv.includes('Total charged to date,2400.00')); // Jan + Feb due
  assert.ok(csv.includes('Total received,,1200.00'));
  assert.ok(csv.includes('Arrears outstanding,1200.00'));
});
