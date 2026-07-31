#!/usr/bin/env node
/**
 * Unit tests for drip/engine.js — the passive income engine behind Drip.
 * Pins the money maths: yield twelfths, compounding growth rates, DRIP
 * reinvestment, the freedom-date crossover against inflation-growing
 * expenses, and the honesty metrics (passivity, diversification).
 * Loaded in a vm sandbox (repo is type:module). Run: node scripts/test-drip-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'drip', 'engine.js'), 'utf8'), sandbox, { filename: 'drip/engine.js' });
const E = sandbox.module.exports;

const stream = (over = {}) => ({ id: over.id || 's1', name: 'x', type: 'custom',
  capital: 0, yieldPct: 0, incomeMonthly: 0, incomeGrowthPct: 0, capitalGrowthPct: 0,
  contribMonthly: 0, reinvest: false, hoursMonthly: 0, ...over });

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/* ---- rates ---- */

test('mRate compounds: twelve months equals the annual rate exactly', () => {
  const m = E.mRate(5);
  assert.ok(Math.abs(Math.pow(1 + m, 12) - 1.05) < 1e-12);
  assert.equal(E.mRate(0), 0);
  assert.ok(E.mRate(-20) < 0);
});

test('monthlyIncome: yield streams pay capital × yield twelfths', () => {
  assert.equal(E.monthlyIncome(stream({ capital: 12000, yieldPct: 5 })), 50);
  assert.equal(E.monthlyIncome(stream({ incomeMonthly: 150 })), 150);
  // capital present but no yield ⇒ falls back to direct income
  assert.equal(E.monthlyIncome(stream({ capital: 9999, incomeMonthly: 25 })), 25);
});

test('normalize fills defaults, clamps negatives, never mutates input', () => {
  const raw = { id: 7, capital: -50, yieldPct: -2, hoursMonthly: -1, type: 'nope' };
  const n = E.normalize(raw);
  assert.equal(n.id, '7');
  assert.equal(n.capital, 0);
  assert.equal(n.yieldPct, 0);
  assert.equal(n.hoursMonthly, 0);
  assert.equal(n.type, 'custom');
  assert.equal(raw.capital, -50, 'input untouched');
});

test('every preset produces a valid normalized stream', () => {
  for (const [type, p] of Object.entries(E.PRESETS)) {
    const n = E.normalize({ ...p, type });
    assert.equal(n.type, type);
    assert.ok(E.monthlyIncome(n) >= 0);
  }
});

/* ---- projection ---- */

test('project is deterministic: same inputs, same rows', () => {
  const ss = [stream({ capital: 10000, yieldPct: 4, reinvest: true }),
              stream({ id: 's2', incomeMonthly: 200, incomeGrowthPct: -10 })];
  const a = E.project(ss, { months: 120, expenses: 1500 });
  const b = E.project(ss, { months: 120, expenses: 1500 });
  assert.deepEqual(a, b);
});

test('flat savings without reinvestment: income never changes, cash accrues', () => {
  const p = E.project([stream({ capital: 12000, yieldPct: 5 })], { months: 24 });
  assert.equal(p.rows[0].income, 50);
  assert.equal(p.rows[23].income, 50);
  assert.equal(p.rows[23].cash, 50 * 24);
  assert.equal(p.rows[23].capital, 12000);
});

test('DRIP: reinvesting strictly beats not reinvesting, and compounds', () => {
  const base = { capital: 10000, yieldPct: 6 };
  const drip = E.project([stream({ ...base, reinvest: true })], { months: 120 });
  const flat = E.project([stream({ ...base, reinvest: false })], { months: 120 });
  assert.ok(drip.rows[119].income > flat.rows[119].income);
  assert.ok(drip.rows[119].capital > flat.rows[119].capital);
  // month 0 pays the same either way — compounding needs time, not magic
  assert.equal(drip.rows[0].income, flat.rows[0].income);
});

test('reinvested simple twelfths ≈ (1 + y/1200)^n growth on capital', () => {
  const p = E.project([stream({ capital: 10000, yieldPct: 6, reinvest: true })], { months: 12 });
  const expected = 10000 * Math.pow(1 + 6 / 1200, 12);
  assert.ok(Math.abs(p.rows[11].capital - expected) < 0.01, `${p.rows[11].capital} vs ${expected}`);
});

test('contributions drip into capital and lift income over time', () => {
  const withC = E.project([stream({ capital: 0, yieldPct: 5, contribMonthly: 500 })], { months: 24 });
  // contribution alone builds capital even from zero…
  assert.ok(withC.rows[23].capital >= 500 * 24 - 0.01);
  // …but a capital:0 stream has no yield base at month 0
  assert.equal(withC.rows[0].income, 0);
  assert.ok(withC.rows[23].income > 0);
});

test('income growth compounds: +5%/yr dividend income is ×1.05 after a year', () => {
  const p = E.project([stream({ capital: 12000, yieldPct: 5, incomeGrowthPct: 5 })], { months: 13 });
  assert.ok(Math.abs(p.rows[12].income / p.rows[0].income - 1.05) < 1e-6);
});

test('royalty decay: −20%/yr income is ×0.8 after a year and never negative', () => {
  const p = E.project([stream({ incomeMonthly: 100, incomeGrowthPct: -20 })], { months: 121 });
  assert.ok(Math.abs(p.rows[12].income - 80) < 0.01);
  for (const r of p.rows) assert.ok(r.income >= 0);
});

test('capital growth compounds independently of income', () => {
  const p = E.project([stream({ capital: 10000, yieldPct: 0, incomeMonthly: 10, capitalGrowthPct: 7 })], { months: 13 });
  assert.ok(Math.abs(p.rows[11].capital - 10000 * 1.07) < 0.01);
  assert.equal(p.rows[12].income, 10, 'income untouched by capital growth');
});

test('byStream splits the month income by stream id', () => {
  const p = E.project([stream({ id: 'a', capital: 12000, yieldPct: 5 }),
                       stream({ id: 'b', incomeMonthly: 30 })], { months: 1 });
  assert.equal(p.rows[0].byStream.a, 50);
  assert.equal(p.rows[0].byStream.b, 30);
  assert.equal(p.rows[0].income, 80);
});

test('project clamps horizon and handles an empty portfolio', () => {
  const p = E.project([], { months: 0 });
  assert.equal(p.rows.length, 1);
  assert.equal(p.incomeNow, 0);
  assert.equal(p.crossoverIndex, -1);
});

/* ---- the freedom date ---- */

test('crossover: found when growing income meets inflation-growing expenses', () => {
  const ss = [stream({ capital: 100000, yieldPct: 5, reinvest: true, contribMonthly: 2000 })];
  const p = E.project(ss, { months: 360, expenses: 1000, inflationPct: 2.5 });
  assert.ok(p.crossoverIndex > 0, 'not free today');
  const r = p.rows[p.crossoverIndex];
  assert.ok(r.income >= r.expenses, 'income covers grown expenses at crossover');
  assert.ok(p.rows[p.crossoverIndex - 1].income < p.rows[p.crossoverIndex - 1].expenses);
});

test('crossover is 0 when already free, −1 when never reached', () => {
  const rich = E.project([stream({ capital: 1e6, yieldPct: 6 })], { months: 12, expenses: 1000 });
  assert.equal(rich.crossoverIndex, 0);
  const never = E.project([stream({ incomeMonthly: 10 })], { months: 360, expenses: 5000 });
  assert.equal(never.crossoverIndex, -1);
});

test('higher inflation pushes the freedom date later (or off the chart)', () => {
  const ss = [stream({ capital: 50000, yieldPct: 5, reinvest: true, contribMonthly: 1000 })];
  const lo = E.project(ss, { months: 600, expenses: 1200, inflationPct: 0 });
  const hi = E.project(ss, { months: 600, expenses: 1200, inflationPct: 6 });
  assert.ok(lo.crossoverIndex >= 0);
  assert.ok(hi.crossoverIndex === -1 || hi.crossoverIndex > lo.crossoverIndex);
});

test('incomeReal deflates nominal income by inflation', () => {
  const p = E.project([stream({ incomeMonthly: 100 })], { months: 13, inflationPct: 2.5 });
  assert.equal(p.rows[0].incomeReal, 100);
  assert.ok(Math.abs(p.rows[12].incomeReal - 100 / 1.025) < 0.01);
});

/* ---- coverage, passivity, diversification ---- */

test('coverage = income / expenses; free (1) when there are no expenses', () => {
  const ss = [stream({ incomeMonthly: 500 })];
  assert.equal(E.coverage(ss, 2000), 0.25);
  assert.equal(E.coverage(ss, 0), 1);
  assert.equal(E.coverage([], 2000), 0);
});

test('passivity: 0 hours ⇒ 1.0; 10 h/mo ⇒ 0.5; income-weighted blend', () => {
  assert.equal(E.passivity([stream({ incomeMonthly: 100 })]).score, 1);
  assert.equal(E.passivity([stream({ incomeMonthly: 100, hoursMonthly: 10 })]).score, 0.5);
  // £900 truly-passive + £100 needy ⇒ weighted well above the needy score
  const mixed = E.passivity([stream({ incomeMonthly: 900 }),
                             stream({ id: 'b', incomeMonthly: 100, hoursMonthly: 10 })]);
  assert.ok(mixed.score > 0.9 && mixed.score < 1);
  assert.equal(mixed.hoursMonthly, 10);
  assert.equal(mixed.hourly, 100, '£1000/mo over 10h = £100/hr');
});

test('diversification: 0 for one stream, 1 for equal streams, between otherwise', () => {
  assert.equal(E.diversification([stream({ incomeMonthly: 100 })]), 0);
  const equal = [stream({ id: 'a', incomeMonthly: 100 }), stream({ id: 'b', incomeMonthly: 100 }),
                 stream({ id: 'c', incomeMonthly: 100 })];
  assert.equal(E.diversification(equal), 1);
  const skewed = [stream({ id: 'a', incomeMonthly: 950 }), stream({ id: 'b', incomeMonthly: 50 })];
  const d = E.diversification(skewed);
  assert.ok(d > 0 && d < 0.5, `skewed portfolio scored ${d}`);
});

/* ---- calendar + dashboard ---- */

test('monthAt / monthLabel do pure calendar math across year ends', () => {
  const d = E.monthAt({ y: 2026, m: 11 }, 3);
  assert.equal(d.y, 2027); assert.equal(d.m, 2);
  assert.equal(E.monthLabel({ y: 2026, m: 7 }, 0), 'Jul 2026');
  assert.equal(E.monthLabel({ y: 2026, m: 7 }, 18), 'Jan 2028');
});

test('summarize bundles the dashboard and names the freedom month', () => {
  const ss = [stream({ capital: 240000, yieldPct: 5 })];
  const s = E.summarize(ss, { months: 60, expenses: 900, inflationPct: 0, start: { y: 2026, m: 7 } });
  assert.equal(s.incomeNow, 1000);
  assert.equal(s.yearNow, 12000);
  assert.ok(Math.abs(s.coverage - 1000 / 900) < 1e-9);
  assert.equal(s.crossoverIndex, 0);
  assert.equal(s.freedomLabel, 'Jul 2026');
  assert.equal(s.passivity.score, 1);
});

/* ---- plan vs reality ---- */

test('ymKey / parseYM / monthIndex round-trip and reject junk', () => {
  assert.equal(E.ymKey({ y: 2026, m: 7 }), '2026-07');
  const d = E.parseYM('2026-07');
  assert.equal(d.y, 2026); assert.equal(d.m, 7);
  assert.equal(E.parseYM('2026-13'), null);
  assert.equal(E.parseYM('garbage'), null);
  assert.equal(E.monthIndex({ y: 2026, m: 7 }, '2027-01'), 6);
  assert.equal(E.monthIndex({ y: 2026, m: 7 }, '2026-06'), -1);
  assert.equal(E.monthIndex({ y: 2026, m: 7 }, 'nope'), null);
});

test('trackRecord: sums entries per month and compares against the plan', () => {
  const ss = [stream({ id: 'a', capital: 12000, yieldPct: 5 })]; // £50/mo flat
  const tr = E.trackRecord([
    { ym: '2026-07', streamId: 'a', amount: 45 },
    { ym: '2026-08', streamId: 'a', amount: 30 },
    { ym: '2026-08', streamId: 'a', amount: 30 },   // two entries, one month
    { ym: '2025-01', streamId: 'a', amount: 999 },  // before the plan started
    { ym: 'bad', streamId: 'a', amount: 10 }        // junk is dropped
  ], ss, { months: 24, start: { y: 2026, m: 7 } });
  assert.equal(tr.rows.length, 3);
  assert.equal(tr.rows[0].ym, '2026-08', 'newest first');
  assert.equal(tr.rows[0].actual, 60);
  assert.equal(tr.rows[0].projected, 50);
  assert.equal(tr.rows[0].delta, 10);
  const early = tr.rows.find((r) => r.ym === '2025-01');
  assert.equal(early.projected, null, 'no invented projection outside the plan');
  assert.equal(tr.summary.months, 2);
  assert.equal(tr.summary.actualTotal, 105);
  assert.equal(tr.summary.projectedTotal, 100);
  assert.ok(Math.abs(tr.summary.ratio - 1.05) < 1e-9);
});

/* ---- what if? ---- */

test('scenario builders: reinvest-all flips DRIP; contrib targets highest yield', () => {
  const ss = [stream({ id: 'lo', capital: 1000, yieldPct: 2 }),
              stream({ id: 'hi', capital: 1000, yieldPct: 6 })];
  const drip = E.scenarioReinvestAll(ss);
  assert.ok(drip.every((s) => s.reinvest));
  assert.ok(!ss.some((s) => s.reinvest), 'originals untouched');
  assert.equal(E.bestYieldStreamId(ss), 'hi');
  const c = E.scenarioAddContrib(ss, 100);
  assert.equal(c.find((s) => s.id === 'hi').contribMonthly, 100);
  assert.equal(c.find((s) => s.id === 'lo').contribMonthly, 0);
  assert.equal(E.bestYieldStreamId([stream({ incomeMonthly: 50 })]), null);
});

test('compare: each habit strictly helps, and both beats either alone', () => {
  const ss = [stream({ capital: 20000, yieldPct: 5 })];
  const out = E.compare(ss, { months: 240, expenses: 500 }, 200);
  const by = {}; out.forEach((r) => { by[r.key] = r; });
  assert.equal(out.map((r) => r.key).join(','), 'base,drip,contrib,both');
  assert.ok(by.drip.incomeEnd > by.base.incomeEnd);
  assert.ok(by.contrib.incomeEnd > by.base.incomeEnd);
  assert.ok(by.both.incomeEnd > by.drip.incomeEnd);
  assert.ok(by.both.incomeEnd > by.contrib.incomeEnd);
  // a better scenario never reaches freedom later (−1 = never counts as last)
  const rank = (i) => (i < 0 ? Infinity : i);
  assert.ok(rank(by.both.crossoverIndex) <= rank(by.base.crossoverIndex));
  assert.equal(by.contrib.label, '+£200/mo in');
});

console.log('── drip passive-income-engine unit tests ──');
let failed = 0;
for (const [n, f] of tests) {
  try { f(); passed++; console.log('  ✓ ' + n); }
  catch (e) { failed++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
