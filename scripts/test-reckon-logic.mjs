#!/usr/bin/env node
/**
 * Unit tests for reckon/engine.js — the pure UK self-assessment tax engine
 * behind Reckon (rate cards per tax year, income tax with the personal-
 * allowance taper, Class 4/Class 2 National Insurance, trading allowance vs
 * expenses vs mileage, the whole-bill compute, per-payment set-aside,
 * payments on account, and the clock-injected deadline calendar).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-reckon-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'reckon', 'engine.js'), 'utf8'), sandbox, { filename: 'reckon/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2025, 8, 3, 12, 0, 0); // 2025-09-03 12:00 UTC, inside 2025-26
const Y = '2025-26';

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---------- rate cards & tax-year resolution ---------- */
test('rate cards exist for both years and default sensibly', () => {
  deepEq(E.taxYears(), ['2024-25', '2025-26']);
  assert.equal(E.rateCard('2025-26').personalAllowance, 12570);
  assert.equal(E.rateCard('nonsense').year, E.DEFAULT_YEAR);
});
test('taxYearFor: the 6 April boundary is exact', () => {
  assert.equal(E.taxYearFor(Date.UTC(2025, 3, 5)), '2024-25');  // 5 Apr 2025
  assert.equal(E.taxYearFor(Date.UTC(2025, 3, 6)), '2025-26');  // 6 Apr 2025
  assert.equal(E.taxYearFor(Date.UTC(2026, 0, 31)), '2025-26'); // 31 Jan 2026
});

/* ---------- deductions ---------- */
test('mileage: 45p to 10,000 miles then 25p', () => {
  assert.equal(E.mileageDeduction(1000), 450);
  assert.equal(E.mileageDeduction(10000), 4500);
  assert.equal(E.mileageDeduction(12000), 4500 + 500);
  assert.equal(E.mileageDeduction(-5), 0);
});
test('bestDeduction: trading allowance when better, expenses when better, capped at income', () => {
  deepEq(E.bestDeduction(20000, 300, 0), { amount: 1000, method: 'trading-allowance' });
  deepEq(E.bestDeduction(20000, 2400, 0), { amount: 2400, method: 'expenses' });
  // 800 expenses + 1,000 miles @45p = 1,250 beats the £1,000 allowance
  deepEq(E.bestDeduction(20000, 800, 1000), { amount: 1250, method: 'expenses' });
  // allowance can't create a loss: capped at income
  deepEq(E.bestDeduction(600, 0, 0), { amount: 600, method: 'trading-allowance' });
});

/* ---------- income tax ---------- */
test('personal allowance tapers £1 per £2 over £100k, gone by £125,140', () => {
  assert.equal(E.personalAllowance(60000), 12570);
  assert.equal(E.personalAllowance(110000), 7570);
  assert.equal(E.personalAllowance(125140), 0);
  assert.equal(E.personalAllowance(200000), 0);
});
test('income tax at £30,000 profit: £3,486 basic-rate only', () => {
  const t = E.incomeTax(30000, E.rateCard(Y));
  assert.equal(t.taxable, 17430);
  assert.equal(t.total, 3486);
  deepEq(t.bands.map((b) => b.name), ['basic']);
});
test('income tax at £60,000 profit: basic + higher = £11,432', () => {
  const t = E.incomeTax(60000, E.rateCard(Y));
  deepEq(t.bands, [
    { name: 'basic', rate: 0.2, amount: 37700, tax: 7540 },
    { name: 'higher', rate: 0.4, amount: 9730, tax: 3892 },
  ]);
  assert.equal(t.total, 11432);
});
test('income tax at £130,000 profit: allowance fully tapered, additional rate bites', () => {
  const t = E.incomeTax(130000, E.rateCard(Y));
  assert.equal(t.allowance, 0);
  assert.equal(t.taxable, 130000);
  // 37,700@20% + 87,440@40% + 4,860@45% = 7,540 + 34,976 + 2,187
  assert.equal(t.total, 44703);
  deepEq(t.bands.map((b) => b.name), ['basic', 'higher', 'additional']);
});
test('the 60% trap: taper makes £110k profit cost 60%+2% at the margin', () => {
  assert.equal(E.incomeTax(110000, E.rateCard(Y)).total, 33432);
  assert.equal(E.marginalRate(110000, E.rateCard(Y)), 0.62);
});

/* ---------- National Insurance ---------- */
test('Class 4: 6% in the main band, 2% above the upper limit', () => {
  assert.equal(E.class4NI(30000), 1045.8);
  assert.equal(E.class4NI(60000), 2262 + 194.6);
  assert.equal(E.class4NI(12570), 0);
  assert.equal(E.class4NI(10000), 0);
});
test('Class 2: nothing due; credited over the small-profits threshold, voluntary below', () => {
  const over = E.class2NI(20000, E.rateCard(Y));
  assert.equal(over.due, 0);
  assert.equal(over.credited, true);
  assert.equal(over.voluntary, 0);
  const under = E.class2NI(5000, E.rateCard(Y));
  assert.equal(under.credited, false);
  assert.equal(under.voluntary, 182); // 52 × £3.50
});

/* ---------- the whole bill ---------- */
test('computeBill: £36,000 income, £6,000 expenses ⇒ £30,000 profit, £4,531.80 bill', () => {
  const b = E.computeBill({ income: 36000, expenses: 6000, taxYear: Y });
  assert.equal(b.profit, 30000);
  assert.equal(b.incomeTax, 3486);
  assert.equal(b.class4, 1045.8);
  assert.equal(b.total, 4531.8);
  assert.equal(b.takeHome, 30000 - 4531.8);
  assert.equal(b.effectiveRate, 0.151);
  assert.equal(b.setAsidePerPound, 0.13); // per £1 of gross income
  assert.equal(b.deductionMethod, 'expenses');
});
test('computeBill: junk-safe and zero-safe', () => {
  const b = E.computeBill({ income: 'nope', expenses: -4, miles: NaN, taxYear: Y });
  assert.equal(b.profit, 0);
  assert.equal(b.total, 0);
  assert.equal(b.effectiveRate, 0);
  assert.equal(b.setAsidePerPound, 0);
});
test('computeBill: below the allowance nothing is owed at all', () => {
  const b = E.computeBill({ income: 12000, expenses: 0, taxYear: Y });
  assert.equal(b.total, 0);
  assert.equal(b.takeHome, b.profit);
});

/* ---------- per-payment set-aside ---------- */
test('setAsideForPayment is marginal, not average: later pounds cost more', () => {
  const early = E.setAsideForPayment(1000, { income: 5000 }, Y);
  assert.equal(early.setAside, 0); // still inside the personal allowance
  assert.equal(early.keep, 1000);
  const later = E.setAsideForPayment(1000, { income: 60000 }, Y);
  assert.equal(later.setAside, 420); // 40% tax + 2% Class 4
  assert.equal(later.rate, 0.42);
  assert.equal(later.keep, 580);
});
test('setAsideForPayment respects YTD expenses', () => {
  // 30k income − 20k expenses = 10k profit: next £1,000 is still allowance
  const s = E.setAsideForPayment(1000, { income: 30000, expenses: 20000 }, Y);
  assert.equal(s.setAside, 0);
});

/* ---------- payments on account ---------- */
test('paymentSchedule: first big year — full balancing + 50% POA in January', () => {
  const p = E.paymentSchedule(4531.8, 0, Y);
  assert.equal(p.paidOnAccount, 0);
  assert.equal(p.balancing, 4531.8);
  assert.equal(p.poaNext, 2265.9);
  assert.equal(p.january, 6797.7);
  assert.equal(p.july, 2265.9);
});
test('paymentSchedule: steady year nets off what was paid on account', () => {
  const p = E.paymentSchedule(4531.8, 4000, Y);
  assert.equal(p.paidOnAccount, 4000);
  assert.equal(p.balancing, 531.8);
  assert.equal(p.january, 2797.7);
});
test('paymentSchedule: smaller year produces a refund and no negative January', () => {
  const p = E.paymentSchedule(2000, 5000, Y);
  assert.equal(p.refund, 3000);
  assert.equal(p.january, 1000); // just next year's first POA
});
test('paymentSchedule: small bill (≤£1,000) never triggers POAs', () => {
  const p = E.paymentSchedule(900, 0, Y);
  assert.equal(p.poaNext, 0);
  assert.equal(p.january, 900);
  assert.equal(p.july, 0);
});

/* ---------- deadlines (clock-injected) ---------- */
test('deadlines: from Sep 2025 the order is register, paper, online, POA2', () => {
  const d = E.deadlines(NOW);
  deepEq(d.map((x) => x.id), ['register', 'paper', 'online', 'poa2']);
  assert.equal(d[0].ts, Date.UTC(2025, 9, 5));
  assert.equal(d[2].ts, Date.UTC(2026, 0, 31));
  assert.ok(d[2].detail.includes('2024-25'), 'Jan 2026 files the 2024-25 return');
  assert.ok(d.every((x) => x.daysLeft > 0));
});
test('deadlines: the day itself still counts as upcoming, not rolled a year', () => {
  const onTheDay = E.deadlines(Date.UTC(2026, 0, 31));
  const online = onTheDay.find((x) => x.id === 'online');
  assert.equal(online.ts, Date.UTC(2026, 0, 31));
  assert.equal(online.daysLeft, 0);
});

/* ---------- formatting ---------- */
test('fmtGBP: thousands separators, clean whole pounds, sign', () => {
  assert.equal(E.fmtGBP(4531.8), '£4,531.80');
  assert.equal(E.fmtGBP(30000), '£30,000');
  assert.equal(E.fmtGBP(-250.5), '−£250.50');
});
test('round2 avoids float drift', () => {
  assert.equal(E.round2(0.1 + 0.2), 0.3);
  assert.equal(E.round2(1045.7999999), 1045.8);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nreckon: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
