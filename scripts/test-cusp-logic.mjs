#!/usr/bin/env node
/**
 * Unit tests for cusp/engine.js (the Salience Engine) — the proprietary
 * "what should I do right now?" scoring model behind Cusp. Loaded in a vm
 * sandbox (repo is type:module). Run: node scripts/test-cusp-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'cusp', 'engine.js'), 'utf8'), sandbox, { filename: 'cusp/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 5, 17, 10, 0, 0); // 2026-06-17 10:00 — a sharp morning hour
const HOUR = 3600000, DAY = 86400000;
const ctx = (over = {}) => ({ now: NOW, windowMin: 30, energy: 0.85, lastProject: null, ...over });
const task = (over = {}) => ({ id: over.id || 't', title: 'x', importance: 3, effort: 30,
  load: 'medium', createdAt: NOW, ...over });

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

test('WEIGHTS sum to 1', () => {
  const s = Object.values(E.WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(s - 1) < 1e-9, 'weights sum = ' + s);
});

test('circadianEnergy: night trough < morning peak; always in [0,1]', () => {
  assert.ok(E.circadianEnergy(3) < E.circadianEnergy(10));
  assert.ok(E.circadianEnergy(2) < 0.35, '3am should read low');
  for (let h = 0; h < 24; h++) { const v = E.circadianEnergy(h); assert.ok(v >= 0 && v <= 1); }
  assert.equal(E.circadianEnergy(10), E.circadianEnergy(34)); // wraps
});

test('score is deterministic for the same task + context', () => {
  const t = task({ due: NOW + 5 * HOUR });
  assert.deepEqual(E.score(t, ctx()), E.score(t, ctx()));
});

test('urgency: overdue ⇒ U=1; tighter deadline ⇒ higher U', () => {
  const overdue = E.score(task({ due: NOW - HOUR }), ctx());
  assert.equal(overdue.parts.U, 1);
  assert.ok(overdue.reasons.includes('overdue'));
  const soon = E.score(task({ effort: 60, due: NOW + 2 * HOUR }), ctx()).parts.U;
  const later = E.score(task({ effort: 60, due: NOW + 10 * DAY / HOUR * HOUR }), ctx()).parts.U;
  assert.ok(soon > later, `soon ${soon} should exceed later ${later}`);
});

test('urgency is tightness: a big task due in 4h beats a tiny task due in 4h', () => {
  const big = E.score(task({ effort: 180, due: NOW + 4 * HOUR }), ctx()).parts.U;
  const tiny = E.score(task({ effort: 5, due: NOW + 4 * HOUR }), ctx()).parts.U;
  assert.ok(big > tiny, `big ${big} should exceed tiny ${tiny}`);
});

test('undated tasks get a floor but lose to a deadline', () => {
  assert.equal(E.score(task(), ctx()).parts.U, 0.15);
  const dated = E.score(task({ due: NOW + 3 * HOUR }), ctx());
  assert.ok(dated.parts.U > 0.15);
});

test('energy fit: deep work scores best when sharp, light work best when fried', () => {
  const deepSharp = E.score(task({ load: 'deep' }), ctx({ energy: 0.9 })).parts.E;
  const deepTired = E.score(task({ load: 'deep' }), ctx({ energy: 0.2 })).parts.E;
  assert.ok(deepSharp > deepTired);
  const lightTired = E.score(task({ load: 'light' }), ctx({ energy: 0.2 })).parts.E;
  assert.ok(lightTired > deepTired, 'tired ⇒ light beats deep');
});

test('window fit: quick win fills a small gap; oversized task can’t (but deep gets partial)', () => {
  const fits = E.score(task({ effort: 15 }), ctx({ windowMin: 30 }));
  assert.equal(fits.parts.W, 1);
  assert.ok(fits.reasons.some(r => r.includes('window')));
  const tooBigLight = E.score(task({ effort: 120, load: 'light' }), ctx({ windowMin: 15 })).parts.W;
  const tooBigDeep = E.score(task({ effort: 120, load: 'deep' }), ctx({ windowMin: 15 })).parts.W;
  assert.ok(tooBigLight < 0.5);
  assert.ok(tooBigDeep > tooBigLight, 'a deep task is worth starting');
});

test('momentum: staying in the same project beats a cold switch', () => {
  const same = E.score(task({ project: 'Launch' }), ctx({ lastProject: 'Launch' })).parts.M;
  const cold = E.score(task({ project: 'Taxes' }), ctx({ lastProject: 'Launch' })).parts.M;
  assert.equal(same, 1);
  assert.ok(same > cold);
});

test('contributions sum to the salience score', () => {
  const r = E.score(task({ due: NOW + 6 * HOUR, project: 'P' }), ctx({ lastProject: 'P' }));
  const sum = Object.values(r.contrib).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - r.salience) < 0.2, `Σcontrib ${sum} ≈ salience ${r.salience}`);
});

test('eligibility: a task with an unfinished dependency is blocked', () => {
  const tasks = [task({ id: 'a', done: false }), task({ id: 'b', deps: ['a'] })];
  const { ranked, blocked } = E.rank(tasks, ctx());
  assert.equal(ranked.map(r => r.id).join(','), 'a');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].id, 'b');
});

test('dependency clears once the prerequisite is done', () => {
  const tasks = [task({ id: 'a', done: true }), task({ id: 'b', deps: ['a'] })];
  const { ranked, blocked } = E.rank(tasks, ctx());
  assert.equal(blocked.length, 0);
  assert.equal(ranked.map(r => r.id).join(','), 'b');
});

test('a just-skipped (snoozed) task steps aside so the next pick surfaces', () => {
  const tasks = [
    task({ id: 'top', importance: 5, due: NOW - HOUR, snoozeUntil: NOW + 20 * 60000 }),
    task({ id: 'next', importance: 4 })
  ];
  const r = E.rank(tasks, ctx());
  assert.equal(r.ranked.map(x => x.id).join(','), 'next');
  assert.equal(r.snoozed.length, 1);
  // once the snooze lapses, it comes straight back to the top
  const r2 = E.rank(tasks, ctx({ now: NOW + 25 * 60000 }));
  assert.equal(r2.ranked[0].id, 'top');
});

test('rank: an overdue important task surfaces above calm filler', () => {
  const tasks = [
    task({ id: 'calm', importance: 2, due: null }),
    task({ id: 'fire', importance: 5, effort: 20, due: NOW - HOUR })
  ];
  const { ranked } = E.rank(tasks, ctx());
  assert.equal(ranked[0].id, 'fire');
});

test('planWindow packs highest-salience tasks that fit the time you have', () => {
  const tasks = [
    task({ id: 'big', importance: 5, effort: 90, due: NOW + 3 * HOUR }),
    task({ id: 'mid', importance: 4, effort: 20 }),
    task({ id: 'lil', importance: 3, effort: 10 })
  ];
  const { ranked } = E.rank(tasks, ctx({ windowMin: 30 }));
  const { plan, usedMin, leftMin } = E.planWindow(ranked, 30);
  assert.ok(!plan.some(p => p.id === 'big'), '90-min task can’t fit a 30-min window');
  assert.ok(usedMin <= 30 && leftMin >= 0);
  assert.equal(usedMin + leftMin, 30);
});

// ── planOptimal: the precedence-aware right-now optimiser ──────────────────

// Brute-force reference: max total salience over every precedence-valid subset
// that fits the window. Used to assert planOptimal really is optimal.
function brute(tasks, c) {
  const done = new Set(tasks.filter(t => t.done).map(t => t.id));
  const sched = tasks.filter(t => !t.done && !(t.snoozeUntil && t.snoozeUntil > c.now));
  const val = {}, eff = {};
  for (const t of sched) { val[t.id] = E.score(t, c).salience; eff[t.id] = Math.max(1, t.effort || 30); }
  const ids = sched.map(t => t.id);
  let best = 0;
  for (let m = 0; m < (1 << ids.length); m++) {
    const set = new Set(); let e = 0, v = 0, ok = true;
    for (let i = 0; i < ids.length; i++) if (m & (1 << i)) { set.add(ids[i]); e += eff[ids[i]]; v += val[ids[i]]; }
    if (e > c.windowMin) continue;
    for (const id of set) {                       // precedence: every dep done or in set
      const t = tasks.find(x => x.id === id);
      for (const d of (t.deps || [])) if (!done.has(d) && !set.has(d)) { ok = false; break; }
      if (!ok) break;
    }
    if (ok && v > best) best = v;
  }
  return best;
}

test('planOptimal never scores below greedy, and beats it when greedy is myopic', () => {
  // window 30: greedy grabs "big" (sal-heavy, 30m) and stops; two smaller tasks
  // together fit the same window and deliver more.
  const tasks = [
    task({ id: 'big', importance: 5, effort: 30, load: 'light', due: NOW + 2 * HOUR }),
    task({ id: 'a',   importance: 4, effort: 15, load: 'light' }),
    task({ id: 'b',   importance: 4, effort: 15, load: 'light' })
  ];
  const c = ctx({ windowMin: 30 });
  const { ranked } = E.rank(tasks, c);
  const greedy = E.planWindow(ranked, 30);
  const opt = E.planOptimal(tasks, c);
  const greedyTotal = greedy.plan.reduce((s, p) => s + p.salience, 0);
  assert.ok(opt.totalSalience >= greedyTotal - 1e-9, `optimal ${opt.totalSalience} ≥ greedy ${greedyTotal}`);
  assert.ok(opt.totalSalience > greedyTotal, 'on this case optimal should strictly win');
  assert.ok(opt.usedMin <= 30 && opt.leftMin >= 0 && opt.usedMin + opt.leftMin === 30);
});

test('planOptimal matches a brute-force optimum across the backlog', () => {
  const tasks = [
    task({ id: 'p', importance: 5, effort: 20, due: NOW + 90 * 60000 }),
    task({ id: 'q', importance: 3, effort: 25, load: 'light' }),
    task({ id: 'r', importance: 4, effort: 10 }),
    task({ id: 's', importance: 2, effort: 15, due: NOW + 5 * HOUR }),
    task({ id: 'u', importance: 5, effort: 35, load: 'deep' })
  ];
  for (const windowMin of [15, 30, 45, 60]) {
    const c = ctx({ windowMin });
    assert.ok(Math.abs(E.planOptimal(tasks, c).totalSalience - brute(tasks, c)) < 1e-6,
      `window ${windowMin}: optimiser must equal brute force`);
  }
});

test('planOptimal chains through a quick blocker to unlock a high-value task', () => {
  // "payoff" is important but blocked by a 5-min "unblock". A greedy/eligible
  // planner can never schedule payoff; the optimiser does both, in order.
  const tasks = [
    task({ id: 'unblock', importance: 3, effort: 5, load: 'light' }),
    task({ id: 'payoff',  importance: 5, effort: 20, due: NOW + 90 * 60000, deps: ['unblock'] }),
    task({ id: 'filler',  importance: 2, effort: 25, load: 'light' })
  ];
  const c = ctx({ windowMin: 30 });
  const opt = E.planOptimal(tasks, c);
  const ids = opt.plan.map(p => p.task.id);
  assert.ok(ids.includes('unblock') && ids.includes('payoff'), 'both the blocker and its payoff are scheduled');
  assert.ok(ids.indexOf('unblock') < ids.indexOf('payoff'), 'the blocker is placed first');
  assert.equal(opt.unlocked.join(','), 'payoff', 'payoff is reported as unlocked');
});

test('planOptimal leaves a task blocked when its prerequisite can’t be done now', () => {
  // payoff depends on a prereq that is snoozed past the moment ⇒ unreachable.
  const tasks = [
    task({ id: 'prereq', importance: 3, effort: 10, snoozeUntil: NOW + DAY }),
    task({ id: 'payoff', importance: 5, effort: 15, deps: ['prereq'] }),
    task({ id: 'safe',   importance: 4, effort: 15, load: 'light' })
  ];
  const c = ctx({ windowMin: 30 });
  const ids = E.planOptimal(tasks, c).plan.map(p => p.task.id);
  assert.ok(!ids.includes('payoff'), 'unreachable payoff is never scheduled');
});

test('planOptimal is deterministic and respects the window budget', () => {
  const tasks = [
    task({ id: 'a', importance: 4, effort: 12, due: NOW + 3 * HOUR }),
    task({ id: 'b', importance: 5, effort: 18, load: 'deep' }),
    task({ id: 'c', importance: 3, effort: 9, load: 'light' })
  ];
  const c = ctx({ windowMin: 25 });
  const first = E.planOptimal(tasks, c);
  assert.deepEqual(first.plan.map(p => p.task.id), E.planOptimal(tasks, c).plan.map(p => p.task.id));
  assert.ok(first.usedMin <= 25);
});

test('rotRisk flags chronically skipped tasks', () => {
  assert.equal(E.rotRisk(task({ skips: 4 }), NOW), true);
  assert.equal(E.rotRisk(task({ skips: 0 }), NOW), false);
  assert.equal(E.rotRisk(task({ skips: 1, createdAt: NOW - 30 * DAY }), NOW), true);
});

console.log('── cusp salience-engine unit tests ──');
let failed = 0;
for (const [n, f] of tests) {
  try { f(); passed++; console.log('  ✓ ' + n); }
  catch (e) { failed++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
