#!/usr/bin/env node
/**
 * Unit tests for peak/engine.js — the pure human-performance engine behind
 * Peak (Mifflin-St Jeor metabolism → TDEE → goal calories/macros, Epley 1RM,
 * barbell plate math, double-progression overload, the deterministic workout
 * generator, food-log totals, sleep-cycle bedtime math, the daily Peak score,
 * streaks and the level curve).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-peak-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'peak', 'engine.js'), 'utf8'), sandbox, { filename: 'peak/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0); // 2026-08-28 12:00 UTC
const { MINUTE, HOUR } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

const RAFA = { sex: 'male', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'build' };
const AMY = { sex: 'female', age: 28, heightCm: 165, weightKg: 60, activity: 'light', goal: 'cut' };

/* ---------- days ---------- */
test('dayKey is timezone-aware and prevDayKey walks the calendar', () => {
  assert.equal(E.dayKey(NOW, 0), '2026-08-28');
  // 12:00 UTC at UTC+13 is already tomorrow; at UTC-13 it is still yesterday.
  assert.equal(E.dayKey(NOW, 13 * 60), '2026-08-29');
  assert.equal(E.dayKey(NOW, -13 * 60), '2026-08-27');
  assert.equal(E.prevDayKey('2026-03-01'), '2026-02-28');
  assert.equal(E.prevDayKey('2026-01-01'), '2025-12-31');
});

/* ---------- profile & metabolism ---------- */
test('validateProfile: good input passes, junk collects every error', () => {
  const v = E.validateProfile(RAFA);
  assert.equal(v.ok, true);
  assert.equal(v.weightKg, 80);
  const bad = E.validateProfile({ sex: 'x', age: 5, heightCm: 90, weightKg: 10 });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 6);
});
test('bmr matches Mifflin-St Jeor for both formulas', () => {
  // 10*80 + 6.25*180 - 5*30 + 5 = 1780
  assert.equal(E.bmr(RAFA), 1780);
  // 10*60 + 6.25*165 - 5*28 - 161 = 1330.25 → 1330
  assert.equal(E.bmr(AMY), 1330);
});
test('tdee applies the activity multiplier', () => {
  assert.equal(E.tdee(RAFA), Math.round(1780 * 1.55)); // 2759
  assert.equal(E.tdee(AMY), Math.round(1330.25 * 1.375)); // 1829
});
test('calorieTarget: +10% to build, −20% to cut, floored so a cut stays safe', () => {
  assert.equal(E.calorieTarget(RAFA), Math.round(2759 * 1.10)); // 3035
  assert.equal(E.calorieTarget(AMY), Math.round(1829.09375 * 0.80)); // 1463
  const tiny = { sex: 'female', age: 80, heightCm: 145, weightKg: 40, activity: 'sedentary', goal: 'cut' };
  assert.equal(E.calorieTarget(tiny), 1200, 'cut can never go below the floor');
});
test('macroTargets: protein by g/kg, fat 25% kcal, carbs fill the remainder', () => {
  const m = E.macroTargets(RAFA);
  assert.equal(m.protein, Math.round(1.8 * 80)); // 144
  assert.equal(m.fat, Math.round(m.kcal * 0.25 / 9));
  assert.equal(m.carbs, Math.round((m.kcal - m.protein * 4 - m.fat * 9) / 4));
  assert.ok(Math.abs(m.protein * 4 + m.fat * 9 + m.carbs * 4 - m.kcal) < 8, 'macros re-add to calories');
});
test('hydrationTarget: 35 ml/kg to the nearest 100, clamped to a sane band', () => {
  assert.equal(E.hydrationTarget(RAFA), 2800);
  assert.equal(E.hydrationTarget({ weightKg: 30 }), 1500);
  assert.equal(E.hydrationTarget({ weightKg: 200 }), 4000);
});

/* ---------- strength ---------- */
test('oneRepMax: Epley, 1 rep is the lift itself, junk is 0', () => {
  assert.equal(E.oneRepMax(100, 1), 100);
  assert.equal(E.oneRepMax(100, 5), E.round1(100 * (1 + 5 / 30))); // 116.7
  assert.equal(E.oneRepMax(100, 50), E.oneRepMax(100, 12), 'reps clamp at 12');
  assert.equal(E.oneRepMax(-5, 5), 0);
  assert.equal(E.oneRepMax('junk', 5), 0);
});
test('trainingLoads maps the % table off the 1RM', () => {
  const loads = E.trainingLoads(100);
  assert.equal(loads.length, 8);
  deepEq(loads[0], { pct: 95, kg: 95 });
  deepEq(loads[7], { pct: 60, kg: 60 });
});
test('plateMath loads the bar greedily per side', () => {
  const r = E.plateMath(100, 20);
  assert.equal(r.ok, true);
  deepEq(r.perSide, [25, 15]); // (100-20)/2 = 40 per side
  assert.equal(r.achievedKg, 100);
  assert.equal(r.shortKg, 0);
});
test('plateMath: unreachable targets round down and report the shortfall', () => {
  const r = E.plateMath(101, 20); // 40.5/side; smallest plate 1.25 → best 40.0
  assert.equal(r.achievedKg, 100);
  assert.equal(r.shortKg, 1);
  const below = E.plateMath(15, 20);
  assert.equal(below.ok, false);
});
test('plateMath honours a custom plate set', () => {
  const r = E.plateMath(60, 20, [10, 5]);
  deepEq(r.perSide, [10, 10]);
  assert.equal(r.achievedKg, 60);
});
test('nextSession: double progression — top adds load, fail deloads, else adds a rep', () => {
  const up = E.nextSession({ weightKg: 60, reps: [12, 12, 12] });
  assert.equal(up.weightKg, 62.5);
  assert.equal(up.targetReps, E.REP_LOW);
  const deload = E.nextSession({ weightKg: 60, reps: [8, 7, 6] });
  assert.equal(deload.weightKg, 54);
  const hold = E.nextSession({ weightKg: 60, reps: [12, 10, 9] });
  assert.equal(hold.weightKg, 60);
  assert.equal(hold.targetReps, 12, 'best set 12 caps target at the top of the window');
  const first = E.nextSession(null);
  assert.equal(first.weightKg, 20);
});

/* ---------- the workout generator ---------- */
test('workoutPlan: right split shape for each frequency', () => {
  assert.equal(E.workoutPlan(3, 'gym', 's').length, 3);
  const four = E.workoutPlan(4, 'gym', 's');
  deepEq(four.map((d) => d.kind), ['upper', 'lower', 'upper', 'lower']);
  const six = E.workoutPlan(6, 'gym', 's');
  deepEq(six.map((d) => d.kind), ['push', 'pull', 'legs', 'push', 'pull', 'legs']);
  assert.equal(E.workoutPlan(99, 'gym', 's').length, 6, 'frequency clamps to 2–6');
});
test('workoutPlan is deterministic for a seed and respects equipment', () => {
  deepEq(E.workoutPlan(3, 'bodyweight', 'seed-1'), E.workoutPlan(3, 'bodyweight', 'seed-1'));
  const bw = E.workoutPlan(5, 'bodyweight', 'seed-2');
  for (const day of bw) {
    for (const ex of day.exercises) {
      const src = E.EXERCISES.find((e) => e.name === ex.name);
      assert.ok(src.equip.includes('bodyweight'), ex.name + ' must be doable with bodyweight');
    }
  }
});
test('workoutPlan avoids repeating an exercise within a day', () => {
  for (const day of E.workoutPlan(6, 'gym', 'seed-3')) {
    const names = day.exercises.map((e) => e.name);
    assert.equal(new Set(names).size, names.length, 'no duplicate exercise in one day');
  }
});

/* ---------- fuel ---------- */
test('searchFoods finds by substring, empty query offers the shortlist', () => {
  assert.ok(E.searchFoods('chicken').some((f) => f.name.startsWith('Chicken')));
  assert.equal(E.searchFoods('zzz-nothing').length, 0);
  assert.equal(E.searchFoods('').length, 8);
});
test('logTotals sums and rounds; junk entries count as zero', () => {
  const t = E.logTotals([
    { kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
    { kcal: 260, protein: 5, carbs: 56, fat: 0.6 },
    { kcal: 'junk' }
  ]);
  deepEq(t, { kcal: 425, protein: 36, carbs: 56, fat: 4.2 });
});
test('fuelState reports remaining, percentages and overshoot', () => {
  const s = E.fuelState({ kcal: 1500, protein: 90 }, { kcal: 3000, protein: 180 });
  assert.equal(s.remainingKcal, 1500);
  assert.equal(s.pctKcal, 50);
  assert.equal(s.pctProtein, 50);
  assert.equal(s.over, false);
  assert.equal(E.fuelState({ kcal: 3200 }, { kcal: 3000, protein: 180 }).over, true);
});

/* ---------- rest ---------- */
test('sleepStats: 15-min fall-asleep allowance, 90-min cycles, honest labels', () => {
  const bed = NOW - 8 * HOUR;
  const s = E.sleepStats(bed, NOW);
  assert.equal(s.ok, true);
  assert.equal(s.hours, E.round1((8 * 60 - 15) / 60)); // 7.8
  assert.equal(s.cycles, 5);
  assert.equal(s.label, 'In the 7–9h zone');
  assert.equal(E.sleepStats(NOW - 5 * HOUR, NOW).label, 'Short night');
  assert.equal(E.sleepStats(NOW, NOW - HOUR).ok, false, 'waking before bed is not a night');
});
test('bedtimesFor counts whole cycles back from the alarm', () => {
  const wake = Date.UTC(2026, 7, 28, 7, 0);
  const b = E.bedtimesFor(wake);
  deepEq(b.map((x) => x.cycles), [6, 5, 4]);
  assert.equal(E.fmtClock(b[0].ts, 0), '21:45'); // 9h + 15min before 07:00
  assert.equal(E.fmtClock(b[2].ts, 0), '00:45');
});
test('sleepDebt accumulates only shortfalls', () => {
  assert.equal(E.sleepDebt([6, 8, 5.5], 8), 4.5);
  assert.equal(E.sleepDebt([9, 10], 8), 0);
});

/* ---------- the Peak score ---------- */
const TARGETS = { kcal: 3000, protein: 180 };
test('peakScore: a perfect day is exactly 100', () => {
  const s = E.peakScore({
    trained: true, kcal: 3000, protein: 180, fuelTargets: TARGETS,
    sleepHours: 8, waterMl: 2800, waterTarget: 2800
  });
  deepEq(s, { total: 100, move: 40, fuel: 30, rest: 30, waterBonus: 5 });
  assert.equal(E.scoreLabel(s.total), 'Peak day');
});
test('peakScore: an empty day is 0 and partial days score in between', () => {
  assert.equal(E.peakScore({}).total, 0);
  const half = E.peakScore({ steps: 4000, stepTarget: 8000, kcal: 2600, protein: 90, fuelTargets: TARGETS, sleepHours: 6.5 });
  assert.ok(half.total > 20 && half.total < 60, 'got ' + half.total);
  assert.equal(half.move, 13, 'steps earn partial move credit');
});
test('peakScore: overshooting calories scores the same as undershooting by the band', () => {
  const over = E.peakScore({ kcal: 3300, fuelTargets: TARGETS });
  const under = E.peakScore({ kcal: 2700, fuelTargets: TARGETS });
  assert.equal(over.fuel, under.fuel, 'the band is symmetric — bingeing is not rewarded');
});
test('peakScore: unlogged fuel earns nothing (no silent credit)', () => {
  assert.equal(E.peakScore({ fuelTargets: TARGETS }).fuel, 0);
});

/* ---------- streaks, XP, levels ---------- */
test('streak counts back and an unfinished today does not break the chain', () => {
  const scores = { '2026-08-27': 70, '2026-08-26': 61, '2026-08-25': 90, '2026-08-24': 20 };
  assert.equal(E.streak(scores, '2026-08-28'), 3, 'today at 0 leaves yesterday’s streak alive');
  assert.equal(E.streak({ ...scores, '2026-08-28': 80 }, '2026-08-28'), 4, 'today over the bar extends it');
  assert.equal(E.streak({}, '2026-08-28'), 0);
});
test('level curve: early levels fast, floors and needs consistent', () => {
  assert.equal(E.levelFor(0).level, 1);
  assert.equal(E.levelFor(250).level, 2);
  const l = E.levelFor(1000);
  assert.equal(l.level, 3);
  assert.equal(l.into, 1000 - 750);
  assert.equal(l.need, 1500 - 750);
  assert.equal(E.levelName(1), 'Rookie');
  assert.equal(E.levelName(99), 'Peak', 'name clamps at the top');
});

/* ---------- daily prompt & hashing ---------- */
test('dailyPrompt: stable for a date, rotates across dates, always from the list', () => {
  const a = E.dailyPrompt('2026-08-28');
  deepEq(a, E.dailyPrompt('2026-08-28'));
  assert.ok(E.PROMPTS.includes(a.prompt));
  const seen = new Set();
  for (let d = 1; d <= 16; d++) seen.add(E.dailyPrompt('2026-08-' + String(d).padStart(2, '0')).prompt);
  assert.ok(seen.size >= 5, 'prompts rotate across days');
});
test('rand01/hashStr are stable and spread', () => {
  assert.equal(E.hashStr('peak'), E.hashStr('peak'));
  assert.notEqual(E.hashStr('a'), E.hashStr('b'));
  const r = E.rand01('seed-x');
  assert.equal(r, E.rand01('seed-x'));
  assert.ok(r >= 0 && r < 1);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\npeak: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
