#!/usr/bin/env node
/**
 * Unit tests for volley/engine.js — the pure hand-eye coordination engine
 * behind Volley (seeded target spawns for the Strike drill, the Pursuit
 * ball path, Reflex reaction judging, Chain layouts and scoring, combo
 * multipliers, XP/rank progression, daily drill and history trends).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-volley-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'volley', 'engine.js'), 'utf8'), sandbox, { filename: 'volley/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0); // 2026-08-28 12:00 UTC
const ARENA = { w: 390, h: 620 };
const SEED = 'test-seed';

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---------- seeded randomness ---------- */
test('rand01 is deterministic and in [0,1)', () => {
  assert.equal(E.rand01('a'), E.rand01('a'));
  assert.notEqual(E.rand01('a'), E.rand01('b'));
  for (const s of ['x', 'y', 'volley:1', '']) {
    const v = E.rand01(s);
    assert.ok(v >= 0 && v < 1, `rand01(${s}) in range`);
  }
});

/* ---------- the drill catalogue ---------- */
test('DRILLS: four drills, each findable by key, timed ones carry durations', () => {
  assert.equal(E.DRILLS.length, 4);
  for (const d of E.DRILLS) {
    assert.equal(E.drillByKey(d.key).name, d.name);
    if (d.mode === 'timed') assert.ok(d.durationMs > 0);
    else assert.ok(d.rounds > 0);
  }
  assert.equal(E.drillByKey('nope'), null);
});

/* ---------- Strike ---------- */
test('strikeTarget is deterministic and always fully inside the arena', () => {
  deepEq(E.strikeTarget(SEED, 3, ARENA), E.strikeTarget(SEED, 3, ARENA));
  assert.notEqual(JSON.stringify(E.strikeTarget(SEED, 3, ARENA)),
                  JSON.stringify(E.strikeTarget(SEED, 4, ARENA)));
  for (let i = 0; i < 60; i++) {
    const t = E.strikeTarget(SEED, i, ARENA);
    assert.ok(t.x - t.r >= 0 && t.x + t.r <= ARENA.w, `target ${i} inside x`);
    assert.ok(t.y - t.r >= 0 && t.y + t.r <= ARENA.h, `target ${i} inside y`);
    assert.ok(t.r >= 18 && t.ttl >= 1100 && t.ttl <= 1900);
  }
});

test('strike difficulty ramps: later targets are smaller and shorter-lived', () => {
  const early = E.strikeTarget(SEED, 0, ARENA);
  const late = E.strikeTarget(SEED, 40, ARENA);
  assert.ok(late.r < early.r, 'radius shrinks with index');
  assert.ok(late.ttl < early.ttl, 'lifetime shrinks with index');
  assert.equal(E.strikeLevel(0), 0);
  assert.equal(E.strikeLevel(24), 1);
  assert.equal(E.strikeLevel(999), 1, 'ramp flattens out');
});

test('strikeRadiusAt shrinks monotonically to a quarter of born size', () => {
  const t = E.strikeTarget(SEED, 0, ARENA);
  assert.equal(E.strikeRadiusAt(t, 0), t.r);
  assert.ok(E.strikeRadiusAt(t, t.ttl / 2) < t.r);
  assert.ok(Math.abs(E.strikeRadiusAt(t, t.ttl) - t.r * 0.25) < 1e-9);
});

test('judgeStrike: bullseye early beats edge late; outside pad misses; expiry expires', () => {
  const t = { i: 0, x: 100, y: 100, r: 40, ttl: 1600 };
  const bull = E.judgeStrike(t, 100, 100, 100);
  assert.equal(bull.hit, true);
  assert.equal(bull.ring, 'bull');
  const edge = E.judgeStrike(t, 100 + E.strikeRadiusAt(t, 1400), 100, 1400);
  assert.equal(edge.hit, true);
  assert.ok(bull.points > edge.points, 'centre+early outscores edge+late');
  assert.ok(bull.precision > 0.9 && bull.speed > 0.9);
  const miss = E.judgeStrike(t, 100 + t.r + E.TAP_PAD + 1, 100, 100);
  deepEq({ hit: miss.hit, reason: miss.reason }, { hit: false, reason: 'miss' });
  assert.equal(E.judgeStrike(t, 100, 100, 1600).reason, 'expired');
});

test('comboMult: ×1 base, +0.5 every 5 hits, capped at ×3', () => {
  assert.equal(E.comboMult(0), 1);
  assert.equal(E.comboMult(4), 1);
  assert.equal(E.comboMult(5), 1.5);
  assert.equal(E.comboMult(14), 2);
  assert.equal(E.comboMult(999), 3);
});

test('strikeSummary: combo applies in order, faults reset the streak', () => {
  const hit = (points) => ({ hit: true, points, reactMs: 400 });
  const s = E.strikeSummary([hit(20), hit(20), { hit: false, reason: 'miss' }, hit(20)]);
  assert.equal(s.hits, 3);
  assert.equal(s.faults, 1);
  assert.equal(s.accuracy, 75);
  assert.equal(s.bestStreak, 2);
  assert.equal(s.avgReactMs, 400);
  assert.equal(s.score, 60, 'all at ×1 (streak never reaches 5)');
  // six straight hits: the 6th lands at streak 5 → ×1.5
  const six = E.strikeSummary([hit(10), hit(10), hit(10), hit(10), hit(10), hit(10)]);
  assert.equal(six.score, 10 * 5 + 15);
  deepEq(E.strikeSummary([]), { hits: 0, faults: 0, accuracy: 0, avgReactMs: 0, bestStreak: 0, score: 0 });
});

/* ---------- Pursuit ---------- */
test('pursuitPos is deterministic, smooth-ish, and stays inside the arena', () => {
  deepEq(E.pursuitPos(SEED, 5000, ARENA), E.pursuitPos(SEED, 5000, ARENA));
  let prev = null;
  for (let t = 0; t <= 30000; t += 50) {
    const p = E.pursuitPos(SEED, t, ARENA);
    assert.ok(p.x - p.r >= 0 && p.x + p.r <= ARENA.w, `ball inside x at ${t}`);
    assert.ok(p.y - p.r >= 0 && p.y + p.r <= ARENA.h, `ball inside y at ${t}`);
    if (prev) {
      const step = Math.hypot(p.x - prev.x, p.y - prev.y);
      assert.ok(step < 60, `no teleporting between frames (moved ${step}px at ${t})`);
    }
    prev = p;
  }
});

test('pursuitSample: on within the grace halo, off outside it', () => {
  const ball = { x: 100, y: 100, r: 40 };
  assert.equal(E.pursuitSample(ball, 100, 100).on, true);
  assert.equal(E.pursuitSample(ball, 100 + 49, 100).on, true, 'inside 1.25× halo');
  assert.equal(E.pursuitSample(ball, 100 + 51, 100).on, false);
});

test('pursuitSummary: perfect hold = 1000, half = 375, empty is safe', () => {
  const on = { on: true, dist: 5 }, off = { on: false, dist: 200 };
  const perfect = E.pursuitSummary([on, on, on, on], 30000);
  assert.equal(perfect.onPct, 100);
  assert.equal(perfect.score, 1000);
  assert.equal(perfect.longestHoldMs, 30000);
  const half = E.pursuitSummary([on, off, on, off], 30000);
  assert.equal(half.onPct, 50);
  assert.equal(half.score, 375);
  assert.equal(half.longestHoldMs, 7500);
  assert.equal(E.pursuitSummary([], 30000).score, 0);
});

/* ---------- Reflex ---------- */
test('reflexDelay: deterministic, always 1200–3600ms', () => {
  assert.equal(E.reflexDelay(SEED, 1), E.reflexDelay(SEED, 1));
  const seen = new Set();
  for (let r = 0; r < 20; r++) {
    const d = E.reflexDelay(SEED, r);
    assert.ok(d >= 1200 && d <= 3600, `delay ${d} in range`);
    seen.add(d);
  }
  assert.ok(seen.size > 10, 'delays actually vary between rounds');
});

test('judgeReflex bands: false start, lightning through asleep, points descend', () => {
  assert.equal(E.judgeReflex(-5).key, 'false');
  assert.equal(E.judgeReflex(-5).points, 0);
  assert.equal(E.judgeReflex(150).key, 'lightning');
  assert.equal(E.judgeReflex(200).key, 'sharp');
  assert.equal(E.judgeReflex(300).key, 'solid');
  assert.equal(E.judgeReflex(450).key, 'late');
  assert.equal(E.judgeReflex(900).key, 'asleep');
  const pts = [150, 200, 300, 450, 900].map((ms) => E.judgeReflex(ms).points);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i] < pts[i - 1], 'slower is worth less');
});

test('reflexSummary: median, best, false starts counted and unscored', () => {
  const s = E.reflexSummary([210, -1, 190, 330, 170]);
  assert.equal(s.rounds, 5);
  assert.equal(s.falseStarts, 1);
  assert.equal(s.bestMs, 170);
  assert.equal(s.medianMs, 200);
  assert.equal(s.score, 80 + 80 + 60 + 100);
  deepEq(E.reflexSummary([]), { rounds: 0, falseStarts: 0, bestMs: 0, medianMs: 0, score: 0 });
});

/* ---------- Chain ---------- */
test('chainLayout: n numbered targets, deterministic, inside the arena, spread out', () => {
  const a = E.chainLayout(SEED, 1, 6, ARENA);
  deepEq(a, E.chainLayout(SEED, 1, 6, ARENA));
  assert.equal(a.targets.length, 6);
  deepEq(a.targets.map((t) => t.n), [1, 2, 3, 4, 5, 6]);
  for (const t of a.targets) {
    assert.ok(t.x - a.r >= 0 && t.x + a.r <= ARENA.w);
    assert.ok(t.y - a.r >= 0 && t.y + a.r <= ARENA.h);
  }
  // the separation rule holds on a roomy arena
  for (let i = 0; i < a.targets.length; i++) {
    for (let j = i + 1; j < a.targets.length; j++) {
      const d = Math.hypot(a.targets[i].x - a.targets[j].x, a.targets[i].y - a.targets[j].y);
      assert.ok(d >= 2 * a.r, `targets ${i} and ${j} do not overlap (${d})`);
    }
  }
  assert.notEqual(JSON.stringify(a), JSON.stringify(E.chainLayout(SEED, 2, 6, ARENA)), 'rounds differ');
});

test('chainScore: par pays 120 for 6, speed caps ×1.5, mistakes bite, floors at 0', () => {
  assert.equal(E.chainScore(6, 6 * 900, 0), 120);
  assert.equal(E.chainScore(6, 1, 0), 180, 'speed factor caps at 1.5');
  assert.equal(E.chainScore(6, 1e9, 0), 30, 'dawdle floor is ×0.25');
  assert.equal(E.chainScore(6, 6 * 900, 2), 100);
  assert.equal(E.chainScore(6, 1e9, 99), 0, 'never negative');
});

test('chainSummary aggregates rounds', () => {
  const s = E.chainSummary([
    { n: 6, elapsedMs: 5400, mistakes: 0 },
    { n: 6, elapsedMs: 2700, mistakes: 1 },
  ]);
  assert.equal(s.rounds, 2);
  assert.equal(s.mistakes, 1);
  assert.equal(s.avgPerTargetMs, Math.round(8100 / 12));
  assert.equal(s.score, 120 + (180 - 10));
});

/* ---------- progression ---------- */
test('xpFor: a decent run of any drill lands near 100 XP, never negative', () => {
  assert.equal(E.xpFor('strike', 600), 100);
  assert.equal(E.xpFor('pursuit', 600), 100);
  assert.equal(E.xpFor('reflex', 350), 100);
  assert.equal(E.xpFor('chain', 350), 100);
  assert.equal(E.xpFor('strike', -50), 0);
});

test('rankFor: monotonic thresholds, progress toward the next rank', () => {
  assert.equal(E.rankFor(0).name, 'Butterfingers');
  assert.equal(E.rankFor(0).next.name, 'Rally Rookie');
  const mid = E.rankFor(1400);
  assert.equal(mid.name, 'Quick Hands');
  assert.equal(mid.next.needed, 600);
  assert.ok(mid.progress > 0 && mid.progress < 1);
  const top = E.rankFor(999999);
  assert.equal(top.name, 'Hawkeye');
  assert.equal(top.next, null);
  assert.equal(top.progress, 1);
  for (let i = 1; i < E.RANKS.length; i++) assert.ok(E.RANKS[i].min > E.RANKS[i - 1].min);
});

/* ---------- daily drill, bests, trend ---------- */
test('dailyDrill: deterministic per date, a real drill from the catalogue', () => {
  deepEq(E.dailyDrill('2026-08-28'), E.dailyDrill('2026-08-28'));
  const d = E.dailyDrill('2026-08-28');
  assert.ok(E.DRILLS.some((x) => x.key === d.drill.key));
  const keys = new Set();
  for (let i = 1; i <= 14; i++) keys.add(E.dailyDrill('2026-08-' + String(i).padStart(2, '0')).drill.key);
  assert.ok(keys.size > 1, 'the daily drill actually rotates');
});

test('personalBests keeps the top score per drill', () => {
  const bests = E.personalBests([
    { drill: 'strike', score: 300, ts: 1 },
    { drill: 'strike', score: 500, ts: 2 },
    { drill: 'reflex', score: 260, ts: 3 },
  ]);
  assert.equal(bests.strike.score, 500);
  assert.equal(bests.reflex.score, 260);
  deepEq(E.personalBests([]), {});
});

test('trendFor: needs 4 runs, then compares last 3 against the 3 before', () => {
  const mk = (scores) => scores.map((score, i) => ({ drill: 'strike', score, ts: i }));
  assert.equal(E.trendFor(mk([100, 200, 300]), 'strike').dir, 'flat');
  const up = E.trendFor(mk([100, 100, 100, 200, 200, 200]), 'strike');
  assert.equal(up.dir, 'up');
  assert.equal(up.pct, 100);
  const down = E.trendFor(mk([200, 200, 200, 100, 100, 100]), 'strike');
  assert.equal(down.dir, 'down');
  const flat = E.trendFor(mk([200, 200, 200, 201, 202, 200]), 'strike');
  assert.equal(flat.dir, 'flat');
});

/* ---------- formatters ---------- */
test('formatMs and timeAgo', () => {
  assert.equal(E.formatMs(234), '234 ms');
  assert.equal(E.formatMs(1234), '1.2 s');
  assert.equal(E.formatMs(-5), '0 ms');
  assert.equal(E.timeAgo(NOW - 30 * 1000, NOW), 'just now');
  assert.equal(E.timeAgo(NOW - 5 * E.MINUTE, NOW), '5m ago');
  assert.equal(E.timeAgo(NOW - 3 * E.HOUR, NOW), '3h ago');
  assert.equal(E.timeAgo(NOW - 2 * E.DAY, NOW), '2d ago');
});

/* ---- runner ---- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    console.error('  ✗ ' + name);
    console.error(String(e && e.stack || e).split('\n').slice(0, 6).map((l) => '    ' + l).join('\n'));
    process.exitCode = 1;
  }
}
console.log(`\nvolley: ${passed}/${tests.length} tests passed`);
if (passed !== tests.length) process.exit(1);
