#!/usr/bin/env node
/**
 * Unit tests for helix/helix.js — the online, non-stationary, fairness-aware
 * decision engine. Loaded in a vm sandbox (repo is type:module). These tests
 * assert the three guarantees that make Helix worth trusting:
 *   1. it converges on the better arm (Thompson sampling actually works),
 *   2. it forgets and re-learns when rewards drift (decay),
 *   3. it never starves an eligible arm past the budget (fairness theorem),
 * plus determinism, persistence, and the sampler's statistical correctness.
 *
 * Run: node scripts/test-helix-logic.mjs   (or npm test)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} }, Math, Date, JSON, Number, Object, Array };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'helix', 'helix.js'), 'utf8'), sandbox, { filename: 'helix/helix.js' });
const Helix = sandbox.module.exports;

let passed = 0;
const tests = [];
const test = (n, f) => tests.push([n, f]);
const approx = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} (|${a}-${b}| > ${eps})`);
// Arrays returned from the vm sandbox carry the sandbox realm's Array.prototype,
// so deepStrictEqual against a literal here trips on the prototype mismatch.
// Normalize into this realm before comparing flat string/number arrays.
const arr = (x) => Array.from(x);

/* ───────────────────────── seeded RNG / samplers ───────────────────────── */

test('mulberry32 is deterministic and stays in [0,1)', () => {
  const r1 = Helix.mulberry32(42), r2 = Helix.mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const v = r1();
    assert.equal(v, r2(), 'same seed must give same stream');
    assert.ok(v >= 0 && v < 1, 'out of range: ' + v);
  }
});

test('hashSeed: numbers pass through, strings are stable', () => {
  assert.equal(Helix.hashSeed(7), 7);
  assert.equal(Helix.hashSeed('apex'), Helix.hashSeed('apex'));
  assert.notEqual(Helix.hashSeed('apex'), Helix.hashSeed('rent'));
});

test('betaSample mean matches α/(α+β) (law of large numbers)', () => {
  const rng = Helix.mulberry32(1);
  let sum = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) sum += Helix.betaSample(2, 8, rng); // mean = 0.2
  approx(sum / N, 0.2, 0.01, 'Beta(2,8) sample mean');
});

test('betaSample always in [0,1]', () => {
  const rng = Helix.mulberry32(3);
  for (let i = 0; i < 5000; i++) {
    const v = Helix.betaSample(0.5, 0.5, rng); // U-shaped, hits near edges
    assert.ok(v >= 0 && v <= 1, 'beta out of range: ' + v);
  }
});

test('gamma mean ≈ shape (Gamma(k,1) has mean k)', () => {
  const rng = Helix.mulberry32(9);
  for (const k of [0.5, 1, 3, 7]) {
    let s = 0; const N = 20000;
    for (let i = 0; i < N; i++) s += Helix.gamma(k, rng);
    approx(s / N, k, k * 0.05 + 0.02, `Gamma(${k}) mean`);
  }
});

/* ───────────────────────── arm bookkeeping / stats ─────────────────────── */

test('arm registration, has, remove, ids', () => {
  const h = Helix({ seed: 1 });
  h.arm('a', { who: 'A' }).arm('b');
  assert.ok(h.has('a') && h.has('b'));
  assert.deepEqual(arr(h.ids()).sort(), ['a', 'b']);
  assert.equal(h.stats('a').meta.who, 'A');
  assert.ok(h.remove('b'));
  assert.ok(!h.has('b'));
  assert.equal(h.stats('zzz'), null);
});

test('uniform prior ⇒ mean 0.5; evidence shifts mean and shrinks sd', () => {
  const h = Helix({ seed: 1 });
  h.arm('a');
  approx(h.stats('a').mean, 0.5, 1e-9, 'prior mean');
  const sd0 = h.stats('a').sd;
  for (let i = 0; i < 20; i++) h.win('a');
  const s = h.stats('a');
  assert.ok(s.mean > 0.8, 'mean should climb with wins: ' + s.mean);
  assert.ok(s.sd < sd0, 'sd should shrink with evidence');
  assert.ok(s.ci[0] >= 0 && s.ci[1] <= 1, 'CI clamped to [0,1]');
});

test('fractional reward splits credit (mean ≈ reward level)', () => {
  const h = Helix({ seed: 5 });
  h.arm('a');
  for (let i = 0; i < 200; i++) h.reward('a', 0.3);
  approx(h.stats('a').mean, 0.3, 0.02, 'fractional reward mean');
});

/* ─────────────────────────── core: it learns ───────────────────────────── */

test('Thompson sampling converges on the better arm', () => {
  // Two arms, true success rates 0.7 vs 0.3. After learning, the engine should
  // pick "good" the large majority of the time.
  const h = Helix({ seed: 123 });
  h.arm('good').arm('bad');
  const rng = Helix.mulberry32(999); // independent env RNG for outcomes
  const truth = { good: 0.7, bad: 0.3 };
  let goodPicks = 0;
  const ROUNDS = 1500;
  for (let i = 0; i < ROUNDS; i++) {
    const pick = h.best();              // explore/exploit choice
    if (pick === 'good') goodPicks++;
    h.reward(pick, rng() < truth[pick] ? 1 : 0); // observe real outcome
  }
  assert.ok(goodPicks / ROUNDS > 0.8, `should favor good arm; got ${goodPicks}/${ROUNDS}`);
  assert.ok(h.stats('good').mean > h.stats('bad').mean, 'good arm believed better');
});

test('regret stays low vs always-best oracle', () => {
  const h = Helix({ seed: 7 });
  const truth = { a: 0.2, b: 0.5, c: 0.85 };
  for (const id of Object.keys(truth)) h.arm(id);
  const rng = Helix.mulberry32(202);
  let reward = 0;
  const ROUNDS = 2000;
  for (let i = 0; i < ROUNDS; i++) {
    const pick = h.best();
    const r = rng() < truth[pick] ? 1 : 0;
    reward += r;
    h.reward(pick, r);
  }
  const oracle = 0.85 * ROUNDS; // always-c expected reward
  const regret = oracle - reward;
  // Sub-linear regret: average per-round regret should be small.
  assert.ok(regret / ROUNDS < 0.12, `avg regret too high: ${(regret / ROUNDS).toFixed(3)}`);
});

/* ──────────────────── non-stationarity: it forgets & re-learns ─────────── */

test('decay lets the engine re-learn after the world flips', () => {
  // Phase 1: "a" is great, "b" is poor. Phase 2: they SWAP. A stationary learner
  // stays stuck on "a"; a decaying learner recovers.
  const decaying = Helix({ seed: 11, decay: 0.95 });
  const stationary = Helix({ seed: 11, decay: 1 });
  for (const h of [decaying, stationary]) h.arm('a').arm('b');
  const rng = Helix.mulberry32(303);

  const run = (h, rateA, rateB, rounds) => {
    let aPicks = 0;
    for (let i = 0; i < rounds; i++) {
      const pick = h.best();
      if (pick === 'a') aPicks++;
      h.reward(pick, rng() < (pick === 'a' ? rateA : rateB) ? 1 : 0);
    }
    return aPicks / rounds;
  };

  run(decaying, 0.8, 0.2, 800);   // phase 1: a good
  run(stationary, 0.8, 0.2, 800);
  const decAfterFlip = run(decaying, 0.2, 0.8, 800);   // phase 2: b good now
  const statAfterFlip = run(stationary, 0.2, 0.8, 800);

  // The decaying engine should now pick "a" much less than the stuck one.
  assert.ok(decAfterFlip < 0.5, `decaying engine should abandon a: ${decAfterFlip.toFixed(2)}`);
  assert.ok(decAfterFlip < statAfterFlip - 0.1,
    `decay should recover faster than stationary (${decAfterFlip.toFixed(2)} vs ${statAfterFlip.toFixed(2)})`);
});

test('decay relaxes an arm posterior back toward the prior over idle rounds', () => {
  const h = Helix({ seed: 2, decay: 0.5 });
  h.arm('a').arm('b');
  for (let i = 0; i < 10; i++) h.win('a'); // strong belief a≈1
  const before = h.stats('a').mean;
  for (let i = 0; i < 30; i++) h.select(['b']); // advance the clock without touching a
  const after = h.stats('a').mean;
  assert.ok(after < before, 'idle arm should fade');
  approx(after, 0.5, 0.02, 'faded arm returns toward uniform prior mean');
});

/* ─────────────────────── fairness: the starvation theorem ───────────────── */

test('starvation budget bounds max neglect (the fairness guarantee)', () => {
  // THEOREM: with budget B and k=1, every eligible arm is selected at least once
  // every B + n rounds. We verify the observed worst-case gap respects the bound.
  const B = 5, n = 4, k = 1;
  const h = Helix({ seed: 17, starvationBudget: B });
  const arms = ['a', 'b', 'c', 'd'];
  for (const id of arms) h.arm(id);

  const lastSeen = Object.fromEntries(arms.map((id) => [id, -1]));
  let worstGap = 0;
  const ROUNDS = 600;
  for (let t = 0; t < ROUNDS; t++) {
    const pick = h.select(undefined, k)[0];
    // Reward "a" heavily so a pure bandit would otherwise hog every round.
    h.reward(pick, pick === 'a' ? 1 : 0);
    for (const id of arms) {
      if (id === pick) { lastSeen[id] = t; }
      else if (lastSeen[id] >= 0) worstGap = Math.max(worstGap, t - lastSeen[id]);
    }
  }
  const bound = B + Math.ceil(n / k);
  assert.ok(worstGap <= bound, `worst neglect ${worstGap} exceeded bound ${bound}`);
});

test('without a budget, a dominant arm CAN starve others (shows the floor matters)', () => {
  const h = Helix({ seed: 17 }); // starvationBudget defaults to Infinity
  for (const id of ['a', 'b', 'c', 'd']) h.arm(id);
  // Make "a" overwhelmingly good.
  for (let i = 0; i < 50; i++) h.reward('a', 1);
  let aCount = 0;
  for (let t = 0; t < 200; t++) { if (h.best() === 'a') aCount++; h.reward('a', 1); }
  assert.ok(aCount > 180, `dominant arm should hog selections w/o fairness: ${aCount}/200`);
});

test('most-starved arm is promoted first', () => {
  const h = Helix({ seed: 1, starvationBudget: 2 });
  for (const id of ['a', 'b', 'c']) h.arm(id);
  // Touch a and b recently; never touch c.
  h.select(['a']); h.select(['b']); h.select(['a']); h.select(['b']);
  // c has the longest staleness — rank should surface it first.
  const r = h.rank(['a', 'b', 'c'], 1);
  assert.equal(r[0], 'c', 'longest-neglected arm must be promoted');
});

/* ─────────────────────── determinism & persistence ─────────────────────── */

test('same seed + same feedback ⇒ identical decisions', () => {
  const play = () => {
    const h = Helix({ seed: 'replay-me' });
    h.arm('x').arm('y').arm('z');
    const picks = [];
    const rng = Helix.mulberry32(55);
    for (let i = 0; i < 100; i++) {
      const p = h.best();
      picks.push(p);
      h.reward(p, rng() < 0.5 ? 1 : 0);
    }
    return picks.join(',');
  };
  assert.equal(play(), play(), 'runs must be bit-for-bit reproducible');
});

test('snapshot / restore round-trips exactly', () => {
  const h = Helix({ seed: 'snap', decay: 0.9, starvationBudget: 7 });
  h.arm('a', { tag: 1 }).arm('b');
  const rng = Helix.mulberry32(8);
  for (let i = 0; i < 40; i++) { const p = h.best(); h.reward(p, rng() < 0.6 ? 1 : 0); }
  const snap = JSON.parse(JSON.stringify(h.snapshot()));

  const h2 = Helix({ seed: 0 }).restore(snap);
  assert.equal(h2.round(), h.round());
  assert.deepEqual(h2.stats('a'), h.stats('a'));
  assert.deepEqual(h2.config(), h.config());

  // And future decisions continue identically after restore.
  const after1 = []; const after2 = [];
  const r1 = Helix.mulberry32(12), r2 = Helix.mulberry32(12);
  for (let i = 0; i < 20; i++) { const p = h.best(); after1.push(p); h.reward(p, r1() < 0.5 ? 1 : 0); }
  for (let i = 0; i < 20; i++) { const p = h2.best(); after2.push(p); h2.reward(p, r2() < 0.5 ? 1 : 0); }
  assert.deepEqual(after2, after1, 'restored engine must continue identically');
});

/* ─────────────────────────── edge cases / API ──────────────────────────── */

test('rank/select handle empty + single-candidate gracefully', () => {
  const h = Helix({ seed: 1 });
  assert.deepEqual(arr(h.rank([], 3)), []);
  assert.deepEqual(arr(h.select([], 3)), []);
  h.arm('only');
  assert.deepEqual(arr(h.rank(undefined, 5)), ['only']); // k clamped to #arms
});

test('rank ignores unknown candidate ids', () => {
  const h = Helix({ seed: 1 });
  h.arm('real');
  assert.deepEqual(arr(h.rank(['real', 'ghost'], 2)), ['real']);
});

test('select advances the clock and records pulls', () => {
  const h = Helix({ seed: 1 });
  h.arm('a');
  assert.equal(h.round(), 0);
  h.select();
  assert.equal(h.round(), 1);
  assert.equal(h.stats('a').pulls, 1);
});

test('score() is exploration-free and ranks by posterior mean', () => {
  const h = Helix({ seed: 1 });
  h.arm('lo').arm('hi');
  for (let i = 0; i < 10; i++) h.win('hi');
  for (let i = 0; i < 10; i++) h.lose('lo');
  const s = h.score();
  assert.equal(s[0].id, 'hi');
  assert.equal(s[1].id, 'lo');
  // Deterministic: no RNG involved.
  assert.deepEqual(h.score(), h.score());
});

test('config clamps out-of-range options safely', () => {
  const c = Helix({ decay: 5, starvationBudget: -3, priorAlpha: -1 }).config();
  assert.equal(c.decay, 1, 'decay clamped to ≤1');
  assert.equal(c.starvationBudget, Infinity, 'invalid budget ⇒ off');
  assert.ok(c.priorAlpha > 0, 'prior kept positive');
});

test('restore rejects a bad snapshot', () => {
  assert.throws(() => Helix({}).restore({ v: 99 }), /snapshot/);
});

/* ──────────────────────────────── runner ───────────────────────────────── */

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n      ${err.message}`); process.exitCode = 1; }
}
console.log(`\nhelix: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exitCode = 1;
