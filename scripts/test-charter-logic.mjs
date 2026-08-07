#!/usr/bin/env node
/**
 * Unit tests for charter/engine.js — the preferred-convertible-stock engine.
 * Pins the securities maths: share pricing, cumulative dividend accrual, the
 * liquidation waterfall (non-participating / participating / capped), the
 * convert-vs-preference breakeven, and both anti-dilution formulas (full
 * ratchet and broad-based weighted average) against hand-computed numbers.
 * Loaded in a vm sandbox (repo is type:module). Run: node scripts/test-charter-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'charter', 'engine.js'), 'utf8'), sandbox, { filename: 'charter/engine.js' });
const E = sandbox.module.exports;

/* the worked example used throughout: £1m in at £4m pre on 1m founder shares
   ⇒ £4.00/share, 250,000 preferred shares, 20% as-converted, £5m post */
const base = (over = {}) => E.normalize({
  company: 'Ballrz Ltd', seriesName: 'Series A Preferred', holder: 'Rafa',
  investment: 1_000_000, preMoney: 4_000_000, commonShares: 1_000_000,
  dividendPct: 0, cumulative: true, prefMultiple: 1, participation: 'none',
  antiDilution: 'broad', issueDate: '2026-08-07', ...over,
});

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/* ---- the series ---- */

test('normalize fills defaults, clamps junk, never mutates input', () => {
  const raw = { investment: -5, commonShares: 0, dividendPct: -3, participation: 'weird', antiDilution: 'nope' };
  const s = E.normalize(raw);
  assert.equal(s.investment, 1);
  assert.equal(s.commonShares, 1);
  assert.equal(s.dividendPct, 0);
  assert.equal(s.participation, 'none');
  assert.equal(s.antiDilution, 'broad');
  assert.equal(raw.investment, -5, 'input untouched');
  const d = E.normalize({});
  assert.equal(d.seriesName, 'Series A Preferred');
  assert.equal(d.prefMultiple, 1);
});

test('share pricing: price = preMoney ÷ common, shares = investment ÷ price', () => {
  const s = base();
  assert.equal(E.pricePerShare(s), 4);
  assert.equal(E.sharesFor(s), 250_000);
  assert.equal(E.postMoney(s), 5_000_000);
  assert.equal(E.prorataFrac(s), 0.2);
});

test('conversion starts 1:1 at the issue price and never adjusts upward', () => {
  const s = base();
  assert.equal(s.conversionPrice, 4);
  assert.equal(E.conversionRatio(s), 1);
  assert.equal(E.asConvertedShares(s), 250_000);
  // a conversion price above the issue price is clamped back down
  assert.equal(base({ conversionPrice: 9 }).conversionPrice, 4);
});

/* ---- dividends & preference ---- */

test('cumulative dividends accrue simple on the investment; non-cumulative accrue nothing', () => {
  const s = base({ dividendPct: 8 });
  assert.equal(E.accruedDividend(s, 3), 240_000);
  assert.equal(E.accruedDividend(s, 0), 0);
  assert.equal(E.accruedDividend(base({ dividendPct: 8, cumulative: false }), 3), 0);
  assert.equal(E.preferenceAmount(s, 3), 1_240_000);
});

test('preference = multiple × investment plus accrued', () => {
  assert.equal(E.preferenceAmount(base(), 0), 1_000_000);
  assert.equal(E.preferenceAmount(base({ prefMultiple: 2 }), 0), 2_000_000);
});

/* ---- the waterfall: non-participating ---- */

test('low exit: preference route wins, common takes the remainder', () => {
  const w = E.waterfall(base(), 3_000_000, 0);
  assert.equal(w.route, 'preference');
  assert.equal(w.payout, 1_000_000);
  assert.equal(w.convertPayout, 600_000);
  assert.equal(w.common, 2_000_000);
  assert.equal(w.moic, 1);
});

test('exit below the preference: preferred takes everything, common is wiped', () => {
  const w = E.waterfall(base(), 600_000, 0);
  assert.equal(w.payout, 600_000);
  assert.equal(w.common, 0);
});

test('high exit: converting wins', () => {
  const w = E.waterfall(base(), 10_000_000, 0);
  assert.equal(w.route, 'convert');
  assert.equal(w.payout, 2_000_000);
  assert.equal(w.common, 8_000_000);
  assert.equal(w.moic, 2);
});

test('non-participating breakeven = preference ÷ pro-rata (£1m ÷ 20% = £5m), and dividends move it', () => {
  assert.equal(E.breakevenExit(base(), 0), 5_000_000);
  assert.equal(E.breakevenExit(base({ prefMultiple: 2 }), 0), 10_000_000);
  assert.equal(E.breakevenExit(base({ dividendPct: 8 }), 3), 6_200_000);
  // exactly at breakeven the two routes pay the same
  const w = E.waterfall(base(), 5_000_000, 0);
  assert.equal(w.preferencePayout, w.convertPayout);
});

/* ---- participating & capped ---- */

test('participating: preference plus pro-rata of the remainder', () => {
  const w = E.waterfall(base({ participation: 'full' }), 10_000_000, 0);
  assert.equal(w.payout, 1_000_000 + 0.2 * 9_000_000); // 2.8m — the double dip
  assert.equal(w.route, 'preference');
  assert.equal(E.breakevenExit(base({ participation: 'full' }), 0), Infinity);
});

test('capped participation: cap binds, then converting takes over', () => {
  const s = base({ participation: 'capped', participationCap: 3 });
  assert.equal(E.waterfall(s, 10_000_000, 0).payout, 2_800_000); // below the 3m cap
  const w = E.waterfall(s, 20_000_000, 0);
  // pref route would be 1m + 0.2×19m = 4.8m, capped to 3m; converting pays 4m
  assert.equal(w.route, 'convert');
  assert.equal(w.payout, 4_000_000);
  assert.equal(E.breakevenExit(s, 0), 15_000_000); // cap ÷ pro-rata = 3m ÷ 0.2
});

/* ---- anti-dilution ---- */

test('full ratchet: conversion price drops straight to the down-round price', () => {
  const s = E.downRound(base({ antiDilution: 'ratchet' }), 2, 500_000);
  assert.equal(s.conversionPrice, 2);
  assert.equal(E.conversionRatio(s), 2);
  assert.equal(E.asConvertedShares(s), 500_000);
});

test('broad-based weighted average: NCP = OCP × (A+B)/(A+C), hand-computed', () => {
  // A = 1.25m fully-diluted, B = £1m ÷ £4 = 250k, C = 500k new shares
  // NCP = 4 × 1.5m/1.75m = 24/7 ≈ 3.428571
  const s = E.downRound(base(), 2, 500_000);
  assert.ok(Math.abs(s.conversionPrice - 24 / 7) < 1e-9);
  assert.ok(Math.abs(E.conversionRatio(s) - 7 / 6) < 1e-9);
  assert.equal(E.asConvertedShares(s), 291_667);
  // ratchet is always harsher than weighted average
  assert.ok(E.downRound(base({ antiDilution: 'ratchet' }), 2, 500_000).conversionPrice < s.conversionPrice);
});

test('no adjustment on an up round, with antiDilution none, and never mutates', () => {
  const s = base();
  assert.equal(E.downRound(s, 5, 500_000).conversionPrice, 4);
  assert.equal(E.downRound(base({ antiDilution: 'none' }), 2, 500_000).conversionPrice, 4);
  assert.equal(s.conversionPrice, 4, 'input untouched');
});

test('a down round shifts the whole waterfall: more as-converted shares, earlier breakeven', () => {
  const before = base(), after = E.downRound(base({ antiDilution: 'ratchet' }), 2, 500_000);
  assert.ok(E.prorataFrac(after) > E.prorataFrac(before));
  assert.ok(E.breakevenExit(after, 0) < E.breakevenExit(before, 0));
});

/* ---- reporting ---- */

test('payoutCurve: right length, preferred payout never decreases as exits grow', () => {
  const pts = E.payoutCurve(base(), 0, 20_000_000, 40);
  assert.equal(pts.length, 41);
  assert.equal(pts[0].preferred, 0);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].preferred >= pts[i - 1].preferred);
  assert.equal(pts[pts.length - 1].exit, 20_000_000);
});

test('capTable: as-converted ownership sums to 100%', () => {
  const rows = E.capTable(base());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].shares + rows[1].shares, 1_250_000);
  assert.ok(Math.abs(rows[0].pct + rows[1].pct - 100) < 0.02);
  assert.equal(rows[1].pct, 20);
});

test('termSheet: carries the key economics as readable lines', () => {
  const rows = E.termSheet(base({ dividendPct: 8, participation: 'capped' }));
  const by = {}; rows.forEach((r) => { by[r.term] = r.detail; });
  assert.equal(by['Issuer'], 'Ballrz Ltd');
  assert.match(by['Investment'], /£1,000,000/);
  assert.match(by['Valuation'], /£4,000,000 pre-money · £5,000,000 post-money/);
  assert.match(by['Dividend'], /8% per annum, cumulative/);
  assert.match(by['Liquidation preference'], /1× the investment plus accrued dividends/);
  assert.match(by['Participation'], /capped/i);
  assert.match(by['Conversion'], /£4\.0000 per share/);
  assert.match(by['Anti-dilution'], /Broad-based weighted average/);
});

test('certificateNo is deterministic and tracks the identity fields', () => {
  assert.equal(E.certificateNo(base()), E.certificateNo(base()));
  assert.match(E.certificateNo(base()), /^PCS-[0-9A-F]{8}$/);
  assert.notEqual(E.certificateNo(base()), E.certificateNo(base({ holder: 'Someone Else' })));
});

test('deterministic end to end: same series ⇒ identical waterfall, curve and sheet', () => {
  const a = base({ dividendPct: 8, participation: 'capped' });
  const b = base({ dividendPct: 8, participation: 'capped' });
  assert.deepEqual(E.waterfall(a, 12_345_678, 2.5), E.waterfall(b, 12_345_678, 2.5));
  assert.deepEqual(E.payoutCurve(a, 2.5), E.payoutCurve(b, 2.5));
  assert.deepEqual(E.termSheet(a), E.termSheet(b));
});

console.log('── charter preferred-convertible-stock engine unit tests ──');
let failed = 0;
for (const [n, f] of tests) {
  try { f(); passed++; console.log('  ✓ ' + n); }
  catch (e) { failed++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
