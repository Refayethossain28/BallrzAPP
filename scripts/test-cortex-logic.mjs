#!/usr/bin/env node
/**
 * Unit tests for cortex/engine.js (the Drill Engine) — the deterministic core
 * of Cortex, the daily brain gym: round generation for all five drills, answer
 * checking, scoring, the difficulty staircase, ratings, streaks and the shared
 * daily workout. Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-cortex-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'cortex', 'engine.js'), 'utf8'), sandbox, { filename: 'cortex/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const rng = (seed = 42) => E.makeRng(seed);

/* ---- PRNG ---- */

test('makeRng is deterministic and uniform-ish in [0,1)', () => {
  const a = rng(7), b = rng(7);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  const c = rng(7);
  let sum = 0;
  for (let i = 0; i < 2000; i++) { const v = c(); assert.ok(v >= 0 && v < 1); sum += v; }
  assert.ok(Math.abs(sum / 2000 - 0.5) < 0.05, 'mean should be ~0.5');
});

test('hashSeed: stable, spreads nearby strings apart', () => {
  assert.equal(E.hashSeed('2026-07-22'), E.hashSeed('2026-07-22'));
  assert.notEqual(E.hashSeed('2026-07-22'), E.hashSeed('2026-07-23'));
});

test('shuffle is a permutation and deterministic per seed', () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  const s1 = E.shuffle(rng(3), arr), s2 = E.shuffle(rng(3), arr);
  assert.deepEqual(s1, s2);
  assert.deepEqual(s1.slice().sort((a, b) => a - b), arr);
  assert.deepEqual(arr, [1, 2, 3, 4, 5, 6, 7, 8], 'input not mutated');
});

/* ---- flash (memory) ---- */

test('flash: lit cells are unique, in range, and match params', () => {
  for (const level of [1, 8, 16, 30]) {
    const r = E.genRound('flash', level, rng(level));
    const p = E.flashParams(level);
    assert.equal(r.grid, p.grid);
    assert.equal(r.lit.length, p.cells);
    assert.equal(new Set(r.lit).size, r.lit.length, 'no duplicate cells');
    for (const c of r.lit) assert.ok(c >= 0 && c < r.grid * r.grid);
  }
});

test('flash: difficulty scales — more cells, bigger grid, briefer flash', () => {
  const lo = E.flashParams(1), hi = E.flashParams(30);
  assert.ok(hi.cells > lo.cells);
  assert.ok(hi.grid > lo.grid);
  assert.ok(hi.showMs < lo.showMs);
  assert.ok(lo.cells < lo.grid * lo.grid, 'always at least one dark cell');
  assert.ok(hi.cells < hi.grid * hi.grid);
});

test('flash: checkAnswer is order-insensitive set equality', () => {
  const r = E.genRound('flash', 5, rng(9));
  assert.equal(E.checkAnswer(r, r.lit.slice().reverse()), true);
  assert.equal(E.checkAnswer(r, r.lit.slice(1)), false, 'missing one cell');
  const wrong = r.lit.slice();
  wrong[0] = (wrong[0] + 1) % (r.grid * r.grid);
  if (new Set(wrong).size === wrong.length) assert.equal(E.checkAnswer(r, wrong), false);
  assert.equal(E.checkAnswer(r, null), false);
});

/* ---- storm (maths) ---- */

test('storm: the arithmetic in the prompt really equals the answer', () => {
  for (let seed = 0; seed < 60; seed++) {
    for (const level of [1, 6, 12, 25]) {
      const r = E.genRound('storm', level, rng(seed));
      const expr = r.prompt.replace(' = ?', '').replace(/−/g, '-').replace(/×/g, '*');
      assert.equal(eval(expr), r.answer, `prompt "${r.prompt}" vs answer ${r.answer}`);
    }
  }
});

test('storm: 4 unique options, answer among them, subtraction never negative', () => {
  for (let seed = 0; seed < 40; seed++) {
    const r = E.genRound('storm', 4, rng(seed));
    assert.equal(r.options.length, 4);
    assert.equal(new Set(r.options).size, 4);
    assert.ok(r.options.includes(r.answer));
    assert.ok(r.answer >= 0, 'no negative answers at low level');
  }
});

test('storm: time limit shrinks with level but stays sane', () => {
  const t1 = E.genRound('storm', 1, rng(1)).timeLimitMs;
  const t30 = E.genRound('storm', 30, rng(1)).timeLimitMs;
  assert.ok(t30 < t1);
  assert.ok(t30 >= 3000, 'never impossible');
});

/* ---- stroop (focus) ---- */

test('stroop: ink mode answers the ink, word mode answers the word', () => {
  for (let seed = 0; seed < 60; seed++) {
    const lo = E.genRound('stroop', 3, rng(seed));
    assert.equal(lo.mode, 'ink', 'below level 8 always ink mode');
    assert.equal(lo.answer, lo.inkName);
    const hi = E.genRound('stroop', 20, rng(seed));
    assert.equal(hi.answer, hi.mode === 'ink' ? hi.inkName : hi.word);
  }
});

test('stroop: options are 4 unique colour names including the answer', () => {
  const names = E.STROOP_COLORS.map((c) => c.name);
  for (let seed = 0; seed < 40; seed++) {
    const r = E.genRound('stroop', 10, rng(seed));
    assert.equal(r.options.length, 4);
    assert.equal(new Set(r.options).size, 4);
    assert.ok(r.options.includes(r.answer));
    for (const o of r.options) assert.ok(names.includes(o));
  }
});

test('stroop: mostly incongruent, but congruent rounds exist', () => {
  let incongruent = 0, congruent = 0;
  const r0 = rng(5);
  for (let i = 0; i < 300; i++) {
    const r = E.genRound('stroop', 5, r0);
    if (r.word === r.inkName) congruent++; else incongruent++;
  }
  assert.ok(incongruent > congruent * 2, 'interference is the point');
  assert.ok(congruent > 0, 'but pure "never the word" must not work');
});

/* ---- echo (working memory) ---- */

test('echo: sequence unique; exactly one option was in the stream', () => {
  for (let seed = 0; seed < 60; seed++) {
    for (const level of [1, 9, 15, 30]) {
      const r = E.genRound('echo', level, rng(seed));
      assert.equal(new Set(r.sequence).size, r.sequence.length);
      assert.equal(r.options.length, 4);
      assert.equal(new Set(r.options).size, 4);
      const inSeq = r.options.filter((o) => r.sequence.includes(o));
      assert.equal(inSeq.length, 1, 'exactly one option was in the stream');
      assert.equal(inSeq[0], r.answer, 'and it is the answer');
    }
  }
});

test('echo: levels lengthen the stream, speed it up, and switch to twin decoys', () => {
  const lo = E.echoParams(1), hi = E.echoParams(30);
  assert.ok(hi.seqLen > lo.seqLen);
  assert.ok(hi.itemMs < lo.itemMs);
  assert.equal(lo.twins, false);
  assert.equal(hi.twins, true);
  const twins = Object.values(E.ECHO_TWINS);
  const r = E.genRound('echo', 20, rng(11));
  for (const o of r.options) if (o !== r.answer) assert.ok(twins.includes(o), o + ' should be a twin decoy');
});

/* ---- odd (speed) ---- */

test('odd: exactly one intruder, at the answer index', () => {
  for (let seed = 0; seed < 60; seed++) {
    for (const level of [1, 10, 22, 30]) {
      const r = E.genRound('odd', level, rng(seed));
      assert.equal(r.symbols.length, r.grid * r.grid);
      const counts = {};
      for (const s of r.symbols) counts[s] = (counts[s] || 0) + 1;
      const kinds = Object.keys(counts);
      assert.equal(kinds.length, 2, 'base glyph + one intruder');
      const intruder = kinds.find((k) => counts[k] === 1);
      assert.equal(counts[intruder], 1);
      assert.equal(r.symbols[r.answer], intruder);
    }
  }
});

test('odd: the wall grows and the glyphs get more confusable with level', () => {
  const lo = E.oddParams(1), hi = E.oddParams(30);
  assert.ok(hi.grid > lo.grid);
  assert.ok(hi.tier > lo.tier);
  assert.ok(hi.timeLimitMs < lo.timeLimitMs && hi.timeLimitMs >= 2000);
});

/* ---- generic round contract ---- */

test('genRound: deterministic per seed, distinct across seeds, rejects unknowns', () => {
  for (const d of E.DRILLS) {
    assert.deepEqual(E.genRound(d.id, 7, rng(123)), E.genRound(d.id, 7, rng(123)));
  }
  const a = E.genRound('storm', 7, rng(1)), b = E.genRound('storm', 7, rng(2));
  assert.notDeepEqual(a, b);
  assert.throws(() => E.genRound('nope', 1, rng(1)));
});

test('every round carries a positive time limit and its level', () => {
  for (const d of E.DRILLS) {
    const r = E.genRound(d.id, 13, rng(4));
    assert.ok(r.timeLimitMs > 0);
    assert.equal(r.level, 13);
    assert.equal(r.drill, d.id);
  }
});

/* ---- scoring ---- */

test('roundPoints: wrong = 0; faster and higher-level = more', () => {
  assert.equal(E.roundPoints(10, false, 100, 5000), 0);
  const fast = E.roundPoints(5, true, 500, 5000);
  const slow = E.roundPoints(5, true, 4900, 5000);
  assert.ok(fast > slow && slow >= 100);
  assert.ok(E.roundPoints(20, true, 1000, 5000) > E.roundPoints(2, true, 1000, 5000));
});

test('comboMultiplier: ×1 cold, +0.1 per hit, capped at ×2', () => {
  assert.equal(E.comboMultiplier(0), 1);
  assert.equal(E.comboMultiplier(3), 1.3);
  assert.equal(E.comboMultiplier(10), 2);
  assert.equal(E.comboMultiplier(25), 2);
});

test('nextLevel: staircase up on hit, down on miss, clamped to 1..MAX', () => {
  assert.equal(E.nextLevel(5, true), 6);
  assert.equal(E.nextLevel(5, false), 4);
  assert.equal(E.nextLevel(1, false), 1);
  assert.equal(E.nextLevel(E.MAX_LEVEL, true), E.MAX_LEVEL);
});

test('sessionSummary: score applies combo, tracks accuracy / best run / peak', () => {
  const R = (correct, level, points) => ({ correct, level, points, ms: 1000 });
  const s = E.sessionSummary([R(true, 1, 100), R(true, 2, 100), R(false, 3, 0), R(true, 2, 100)]);
  // combo: 100×1 + 100×1.1 + 0 + 100×1 (run reset by the miss)
  assert.equal(s.score, 310);
  assert.equal(s.hits, 3);
  assert.equal(s.accuracy, 0.75);
  assert.equal(s.bestCombo, 2);
  assert.equal(s.peakLevel, 3);
  assert.equal(s.rounds, 4);
});

/* ---- ratings ---- */

test('sessionPerformance: rises with peak level and accuracy, capped at 1000', () => {
  const weak = E.sessionPerformance({ peakLevel: 2, accuracy: 0.4 });
  const strong = E.sessionPerformance({ peakLevel: 15, accuracy: 0.9 });
  assert.ok(strong > weak);
  assert.equal(E.sessionPerformance({ peakLevel: 30, accuracy: 1 }), 1000);
});

test('updateRating: EMA toward performance — gains fast, decays gently', () => {
  assert.equal(E.updateRating(0, 400), 100);
  assert.equal(E.updateRating(400, 400), 400, 'stable at plateau');
  const dip = E.updateRating(600, 200);
  assert.ok(dip < 600 && dip > 200, 'a bad day dents, never erases');
  assert.ok(E.updateRating(990, 10000) <= 1000);
});

test('brainIndex: mean of earned domains only; rankFor names the tiers', () => {
  assert.equal(E.brainIndex({}), 0);
  assert.equal(E.brainIndex({ memory: 600 }), 600);
  assert.equal(E.brainIndex({ memory: 600, speed: 200 }), 400);
  assert.equal(E.rankFor(0), 'Spark');
  assert.equal(E.rankFor(510), 'Sharp');
  assert.equal(E.rankFor(1000), 'Limitless');
});

/* ---- streaks & the daily workout ---- */

test('isoDay / dayDiff: UTC calendar arithmetic', () => {
  assert.equal(E.isoDay(Date.UTC(2026, 6, 22, 23, 59)), '2026-07-22');
  assert.equal(E.dayDiff('2026-07-21', '2026-07-22'), 1);
  assert.equal(E.dayDiff('2026-06-30', '2026-07-01'), 1, 'crosses month end');
  assert.equal(E.dayDiff('2026-07-22', '2026-07-22'), 0);
});

test('updateStreak: extends on consecutive days, holds same-day, resets on a gap', () => {
  // engine objects live in the vm realm — compare fields, not object identity
  const eq = (s, streak, lastDay) => { assert.equal(s.streak, streak); assert.equal(s.lastDay, lastDay); };
  let s = E.updateStreak(null, '2026-07-20');
  eq(s, 1, '2026-07-20');
  s = E.updateStreak(s, '2026-07-21');
  eq(s, 2, '2026-07-21');
  eq(E.updateStreak(s, '2026-07-21'), 2, '2026-07-21');
  eq(E.updateStreak(s, '2026-07-25'), 1, '2026-07-25');
});

test('dailyWorkout: same date → same 3 distinct drills for everyone; dates differ', () => {
  const a = E.dailyWorkout('2026-07-22'), b = E.dailyWorkout('2026-07-22');
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3);
  const ids = E.DRILLS.map((d) => d.id);
  for (const id of a) assert.ok(ids.includes(id));
  let differs = false;
  for (let d = 1; d <= 10 && !differs; d++) {
    const day = '2026-08-' + String(d).padStart(2, '0');
    if (JSON.stringify(E.dailyWorkout(day)) !== JSON.stringify(a)) differs = true;
  }
  assert.ok(differs, 'the workout rotates across dates');
});

test('a full simulated session holds a mid-scale player near their level', () => {
  // A player who always gets rounds at level ≤ 12 right and above 12 wrong
  // should staircase up to ~12 and oscillate — the adaptive promise.
  let level = 1;
  const r0 = rng(99);
  const results = [];
  for (let i = 0; i < 40; i++) {
    const round = E.genRound('storm', level, r0);
    const correct = level <= 12;
    results.push({ correct, ms: 1500, level, points: E.roundPoints(level, correct, 1500, round.timeLimitMs) });
    level = E.nextLevel(level, correct);
  }
  assert.ok(level >= 11 && level <= 13, `converged near the ceiling, got ${level}`);
  const sum = E.sessionSummary(results);
  assert.ok(sum.peakLevel === 13, 'peaks one past the ceiling then falls back');
  assert.ok(sum.score > 0 && sum.accuracy > 0.5);
});

/* ---- Cortex Pro membership ---- */

const DAY = 86400000;
const T0 = Date.parse('2026-07-01T12:00:00Z');

test('startPro: 7-day trial, live immediately', () => {
  const sub = E.startPro(T0);
  assert.equal(sub.status, 'trialing');
  assert.equal(sub.periodEnd, T0 + E.PRO.trialDays * DAY);
  assert.ok(E.isPro(sub));
  assert.equal(E.proTrialDaysLeft(sub, T0), 7);
  assert.equal(E.proTrialDaysLeft(sub, T0 + 6.5 * DAY), 1);
});

test('advancePro: trial converts to active with one invoice per period', () => {
  const sub = E.startPro(T0);
  // mid-trial: nothing happens
  const mid = E.advancePro(sub, T0 + 3 * DAY);
  assert.deepEqual(mid.sub, sub);
  assert.equal(mid.invoices.length, 0);
  assert.equal(sub.status, 'trialing', 'input not mutated');
  // past trial end: one renewal, one invoice at the boundary
  const one = E.advancePro(sub, T0 + 8 * DAY);
  assert.equal(one.sub.status, 'active');
  assert.equal(one.invoices.length, 1);
  assert.equal(one.invoices[0].amountPence, E.PRO.pricePence);
  assert.equal(one.invoices[0].at, T0 + 7 * DAY);
  assert.equal(one.sub.periodEnd, T0 + 7 * DAY + E.PRO.periodDays * DAY);
  // two whole periods later: two more invoices, each at its own boundary
  const three = E.advancePro(sub, T0 + 7 * DAY + 2.5 * E.PRO.periodDays * DAY);
  assert.equal(three.invoices.length, 3);
  assert.equal(three.invoices[2].at, T0 + 7 * DAY + 2 * E.PRO.periodDays * DAY);
});

test('cancelPro runs to period end; resumePro undoes it; canceled cannot resume', () => {
  const sub = E.cancelPro(E.startPro(T0));
  assert.ok(E.isPro(sub), 'still live until the period ends');
  const ended = E.advancePro(sub, T0 + 10 * DAY);
  assert.equal(ended.sub.status, 'canceled');
  assert.equal(ended.sub.endedAt, T0 + 7 * DAY);
  assert.equal(ended.invoices.length, 0, 'a scheduled cancel is never billed');
  assert.ok(!E.isPro(ended.sub));
  // resume before the boundary keeps it alive and billing resumes
  const resumed = E.resumePro(E.cancelPro(E.startPro(T0)));
  const renewed = E.advancePro(resumed, T0 + 8 * DAY);
  assert.equal(renewed.sub.status, 'active');
  assert.equal(renewed.invoices.length, 1);
  assert.throws(() => E.resumePro(ended.sub));
  // null passes through advance untouched
  const nul = E.advancePro(null, T0);
  assert.equal(nul.sub, null);
  assert.equal(nul.invoices.length, 0);
});

test('free-play quota: 1/day free, unlimited on Pro (trial or active)', () => {
  assert.equal(E.FREE_PLAYS_PER_DAY, 1);
  assert.ok(E.canFreePlay(null, 0));
  assert.ok(!E.canFreePlay(null, 1));
  assert.equal(E.freePlaysLeft(null, 0), 1);
  assert.equal(E.freePlaysLeft(null, 3), 0);
  const sub = E.startPro(T0);
  assert.ok(E.canFreePlay(sub, 99));
  assert.equal(E.freePlaysLeft(sub, 99), null, 'null = unlimited');
  const lapsed = E.advancePro(E.cancelPro(sub), T0 + 8 * DAY).sub;
  assert.ok(!E.canFreePlay(lapsed, 1), 'a lapsed Pro is back on the free quota');
});

console.log('── cortex drill-engine unit tests ──');
let failed = 0;
for (const [n, f] of tests) {
  try { f(); passed++; console.log('  ✓ ' + n); }
  catch (e) { failed++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
