#!/usr/bin/env node
/**
 * Unit tests for graft/engine.js — the income engine behind Graft.
 * Pins the money maths: matcher scoring and ordering, the greedy weekly
 * planner (52/12 weeks-to-month convention), tracker totals / effective
 * £/hr / ISO-week streaks, invoice arithmetic (VAT after discount), and
 * the UK trading-allowance note.
 * Loaded in a vm sandbox (repo is type:module). Run: node scripts/test-graft-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Engine objects are born in the vm realm, whose Object.prototype differs from
// ours — strict deepEqual would fail on the prototype alone. JSON round-trip
// re-homes them for structural comparison.
const plain = (x) => JSON.parse(JSON.stringify(x));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} }, Date };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'graft', 'engine.js'), 'utf8'), sandbox, { filename: 'graft/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/* ---- catalog ---- */

test('catalog is honest and well-formed', () => {
  assert.ok(E.HUSTLES.length >= 15);
  const ids = new Set();
  for (const h of E.HUSTLES) {
    assert.ok(!ids.has(h.id), `duplicate id ${h.id}`); ids.add(h.id);
    assert.ok(h.rate[0] > 0 && h.rate[1] >= h.rate[0], `${h.id} rate range sane`);
    assert.ok(h.rate[1] <= 100, `${h.id} no get-rich-quick rates`);
    assert.ok(h.startCost >= 0 && h.firstPayDays >= 1, `${h.id} costs sane`);
    assert.ok(h.scalable >= 0 && h.scalable <= 1, `${h.id} scalable in 0..1`);
    for (const s of h.skills) assert.ok(E.SKILLS.includes(s), `${h.id} skill ${s} is a known chip`);
  }
  assert.equal(E.hustle('webdev').name, 'Freelance web development');
  assert.equal(E.hustle('nope'), null);
  assert.equal(E.rateMid({ rate: [10, 30] }), 20);
});

/* ---- matcher ---- */

test('matchScore: skills you have beat skills you lack', () => {
  const p = { cash: 500, wants: 'fast', skills: ['coding'] };
  const webdev = E.matchScore(E.hustle('webdev'), p);
  const noSkill = E.matchScore(E.hustle('webdev'), { ...p, skills: [] });
  assert.ok(webdev > noSkill, 'having the listed skill raises the score');
});

test('matchScore: unaffordable start cost cuts the score to 35%', () => {
  const h = E.hustle('privatehire'); // £400 to start
  const rich = E.matchScore(h, { cash: 400, wants: 'fast', skills: ['driving'] });
  const broke = E.matchScore(h, { cash: 0, wants: 'fast', skills: ['driving'] });
  assert.equal(broke, Math.round(rich * 0.35));
});

test('matchScore: wants=fast favours quick first pay, wants=scale favours scalability', () => {
  const p = { cash: 200, skills: [] };
  const delivery = E.hustle('delivery');   // 7 days, scalable 0.1
  const course = E.hustle('course');       // 90 days, scalable 0.95
  assert.ok(E.matchScore(delivery, { ...p, wants: 'fast' }) > E.matchScore(course, { ...p, wants: 'fast' }));
  assert.ok(E.matchScore(course, { ...p, wants: 'scale' }) > E.matchScore(delivery, { ...p, wants: 'scale' }));
});

test('recommend: sorted best-first, flags affordability, gives reasons', () => {
  const recs = E.recommend({ hoursWeekly: 10, cash: 0, wants: 'fast', skills: ['writing'] });
  assert.equal(recs.length, E.HUSTLES.length);
  for (let i = 1; i < recs.length; i++) assert.ok(recs[i - 1].score >= recs[i].score, 'descending scores');
  const valet = recs.find((r) => r.hustle.id === 'carvaleting');
  assert.equal(valet.affordable, false);
  assert.ok(valet.reasons.some((r) => r.includes('£150')), 'says what it costs to start');
  const writing = recs.find((r) => r.hustle.id === 'writing');
  assert.ok(writing.reasons.some((r) => r.includes('writing')), 'names the skill it uses');
});

/* ---- planner ---- */

test('plan: weekly hours convert to monthly at ×52/12', () => {
  assert.equal(E.weeklyToMonthly(120), 520); // £120/wk → £520/mo, not £480
  const p = E.plan(520, [{ id: 'a', rate: 20 }], 40);
  assert.equal(p.rows[0].hoursWeekly, 6); // £520/mo needs £120/wk = 6h at £20
  assert.equal(p.monthly, 520);
  assert.equal(p.feasible, true);
  assert.equal(p.shortfall, 0);
});

test('plan: greedy — highest £/hr fills first, caps respected', () => {
  const p = E.plan(1000, [
    { id: 'cheap', rate: 10 },
    { id: 'dear', rate: 50, capWeekly: 2 }
  ], 40);
  assert.equal(p.rows[0].id, 'dear');
  assert.equal(p.rows[0].hoursWeekly, 2);            // capped
  assert.equal(p.rows[0].monthly, 433.33);           // 2h × £50 × 52/12
  assert.ok(p.rows[1].hoursWeekly > 0, 'remainder falls to the next rate');
  assert.equal(p.feasible, true);
});

test('plan: says plainly when the target does not fit your hours', () => {
  const p = E.plan(2000, [{ id: 'a', rate: 10 }], 10); // 10h × £10 → £433/mo max
  assert.equal(p.feasible, false);
  assert.equal(p.hoursUsed, 10);
  assert.equal(p.hoursSpare, 0);
  assert.equal(p.shortfall, 2000 - p.monthly);
});

test('plan: zero target and zero-rate picks are handled', () => {
  const p0 = E.plan(0, [{ id: 'a', rate: 20 }], 10);
  assert.equal(p0.feasible, true);
  assert.equal(p0.hoursUsed, 0);
  assert.equal(E.plan(100, [{ id: 'a', rate: 0 }], 10).rows.length, 0);
});

/* ---- tracker ---- */

const entries = [
  { id: '1', dateISO: '2026-07-03', hustleId: 'delivery', amount: 45, hours: 3 },
  { id: '2', dateISO: '2026-07-10', hustleId: 'writing', amount: 120, hours: 4 },
  { id: '3', dateISO: '2026-07-17', hustleId: 'delivery', amount: 60, hours: 4 },
  { id: '4', dateISO: '2026-06-20', hustleId: 'writing', amount: 200, hours: 5 }
];

test('monthTotals: earned, hours, effective £/hr and the per-hustle split', () => {
  const t = E.monthTotals(entries, '2026-07');
  assert.equal(t.earned, 225);
  assert.equal(t.hours, 11);
  assert.equal(t.rate, 20.45);
  assert.deepEqual(plain(t.byHustle), { delivery: 105, writing: 120 });
  assert.equal(E.monthTotals(entries, '2026-01').earned, 0);
  assert.equal(E.monthTotals(entries, '2026-01').rate, 0);
});

test('bestEarner and yearTotal', () => {
  assert.equal(E.bestEarner(entries, '2026-07'), 'writing');
  assert.equal(E.bestEarner(entries, '2026-01'), null);
  assert.equal(E.yearTotal(entries, '2026'), 425);
  assert.equal(E.yearTotal(entries, '2025'), 0);
});

test('weekKey follows the ISO Thursday rule', () => {
  assert.equal(E.weekKey('2026-01-01'), '2026-W01'); // 1 Jan 2026 is a Thursday
  assert.equal(E.weekKey('2027-01-01'), '2026-W53'); // 1 Jan 2027 is a Friday → prev ISO year
  assert.equal(E.weekKey('2026-07-28'), '2026-W31');
});

test('isoShiftDays crosses month and year boundaries', () => {
  assert.equal(E.isoShiftDays('2026-07-28', -7), '2026-07-21');
  assert.equal(E.isoShiftDays('2026-01-03', -7), '2025-12-27');
});

test('streakWeeks: consecutive weeks, with grace for a not-yet-logged current week', () => {
  // entries land in W27, W28, W31 of 2026 (3rd, 10th, 17th July → W27..W29 actually)
  const es = [
    { dateISO: '2026-07-06', amount: 10 },  // W28
    { dateISO: '2026-07-13', amount: 10 },  // W29
    { dateISO: '2026-07-20', amount: 10 }   // W30
  ];
  assert.equal(E.streakWeeks(es, '2026-07-22'), 3);  // today in W30, logged
  assert.equal(E.streakWeeks(es, '2026-07-28'), 3);  // today in W31 empty → grace, streak intact
  assert.equal(E.streakWeeks(es, '2026-08-05'), 0);  // a full week missed → broken
  assert.equal(E.streakWeeks([], '2026-07-28'), 0);
});

/* ---- invoice ---- */

test('invoiceTotals: VAT applies after the discount', () => {
  const t = E.invoiceTotals(
    [{ desc: 'Build', qty: 10, unit: 50 }, { desc: 'Hosting', qty: 1, unit: 100 }],
    { discountPct: 10, vatPct: 20 }
  );
  assert.equal(t.subtotal, 600);
  assert.equal(t.discount, 60);
  assert.equal(t.net, 540);
  assert.equal(t.vat, 108);
  assert.equal(t.total, 648);
});

test('invoiceTotals: defaults are zero-safe', () => {
  const t = E.invoiceTotals([{ qty: 2, unit: 19.99 }]);
  assert.equal(t.subtotal, 39.98);
  assert.equal(t.vat, 0);
  assert.equal(t.total, 39.98);
  assert.equal(E.invoiceTotals([]).total, 0);
});

test('invoiceRef is stable and padded', () => {
  assert.equal(E.invoiceRef(7, '2026-07-28'), 'INV-2026-007');
  assert.equal(E.invoiceRef(123, '2026-01-01'), 'INV-2026-123');
  assert.equal(E.invoiceRef(0, '2026-01-01'), 'INV-2026-001');
});

/* ---- tax note ---- */

test('tradingAllowance: first £1,000 free, must report above', () => {
  assert.deepEqual(plain(E.tradingAllowance(600)), { allowance: 1000, taxFree: 600, above: 0, mustReport: false });
  assert.deepEqual(plain(E.tradingAllowance(1000)), { allowance: 1000, taxFree: 1000, above: 0, mustReport: false });
  assert.deepEqual(plain(E.tradingAllowance(4500)), { allowance: 1000, taxFree: 1000, above: 3500, mustReport: true });
});

/* ---- formatting ---- */

test('money formats without Intl', () => {
  assert.equal(E.money(1234.5), '£1,234.50');
  assert.equal(E.money(1200, true), '£1,200');
  assert.equal(E.money(0), '£0.00');
  assert.equal(E.money(-45.25), '−£45.25');
});

/* ---- run ---- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
console.log(`\ntest-graft-logic: ${passed}/${tests.length} passed`);
