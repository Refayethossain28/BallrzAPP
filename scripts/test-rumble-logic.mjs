#!/usr/bin/env node
/**
 * Unit tests for rumble/engine.js — the pure one-on-one fighting engine
 * behind Rumble (an original arcade fighter: eight original fighters,
 * best-of-three rounds on a 99-second clock, motion-input specials,
 * projectiles that clash, blocking with chip damage, knockdowns, the
 * surge meter, a deterministic CPU and the arcade ladder).
 * The engine is fully tick-driven: no wall clock anywhere, so the same
 * seed and inputs always replay the same match.
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-rumble-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'rumble', 'engine.js'), 'utf8'), sandbox, { filename: 'rumble/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---------- helpers ---------- */
const NONE = {};
function match(over = {}) {
  return E.createMatch({ p1: 'volt', p2: 'gale', seed: 'test', ...over });
}
function startFight(m) { m.phase = 'fight'; m.phaseT = 0; return m; }
function run(m, n, in1 = NONE, in2 = NONE) {
  const evs = [];
  for (let i = 0; i < n; i++) { E.step(m, in1, in2); evs.push(...m.events); }
  return evs;
}
function runSeq(m, seq1, in2 = NONE) {
  const evs = [];
  for (const in1 of seq1) { E.step(m, in1, in2); evs.push(...m.events); }
  return evs;
}
// Feed player 1 a quarter-circle-forward + punch (facing right).
const QCF_LP = [{ d: true }, { d: true, r: true }, { r: true }, { r: true, lp: true }];
const QCF_HP = [{ d: true }, { d: true, r: true }, { r: true }, { r: true, hp: true }];
const DP_LP = [{ r: true }, { d: true }, { d: true, r: true }, { d: true, r: true, lp: true }];
const QCB_LK = [{ d: true }, { d: true, l: true }, { l: true }, { l: true, lk: true }];

/* ---------- roster integrity ---------- */
test('roster: eight original fighters, unique ids and names, full data', () => {
  assert.equal(E.ROSTER.length, 8);
  const ids = new Set(), names = new Set();
  for (const c of E.ROSTER) {
    ids.add(c.id); names.add(c.name);
    assert.ok(c.home && c.tag && c.quote, `${c.id} has flavour text`);
    assert.ok(c.spd >= 2.4 && c.spd <= 4.4, `${c.id} speed sane`);
    assert.ok(c.pow >= 0.8 && c.pow <= 1.3, `${c.id} power sane`);
    assert.ok(c.reach >= 0.85 && c.reach <= 1.35, `${c.id} reach sane`);
    assert.ok(c.colors.gear && c.colors.skin, `${c.id} palette`);
    for (const slot of ['a', 'b', 'c']) assert.ok(c.specials[slot].name, `${c.id} special ${slot}`);
    assert.ok(['shot', 'lunge'].includes(c.specials.a.kind), `${c.id} signature kind`);
  }
  assert.equal(ids.size, 8); assert.equal(names.size, 8);
  assert.ok(ids.has('onyx'), 'the champion exists');
});
test('special names are original (no borrowed move names)', () => {
  const all = E.ROSTER.flatMap((c) => [c.name, c.specials.a.name, c.specials.b.name, c.specials.c.name]).join(' ').toLowerCase();
  for (const banned of ['hadoken', 'shoryuken', 'tatsumaki', 'sonic boom', 'ryu', 'ken ', 'chun', 'guile', 'blanka', 'zangief', 'dhalsim', 'honda', 'bison', 'sagat']) {
    assert.ok(!all.includes(banned), `no "${banned}" anywhere in the roster`);
  }
});

/* ---------- deterministic helpers ---------- */
test('rand01 is deterministic and in [0,1)', () => {
  assert.equal(E.rand01('a:1'), E.rand01('a:1'));
  for (const s of ['x', 'y', 'z:9']) { const v = E.rand01(s); assert.ok(v >= 0 && v < 1); }
  assert.notEqual(E.rand01('a'), E.rand01('b'));
});
test('rectsOverlap: overlapping, touching and disjoint', () => {
  const A = { x0: 0, x1: 10, y0: 0, y1: 10 };
  assert.equal(E.rectsOverlap(A, { x0: 5, x1: 15, y0: 5, y1: 15 }), true);
  assert.equal(E.rectsOverlap(A, { x0: 10, x1: 20, y0: 0, y1: 10 }), false, 'edge-touch is not a hit');
  assert.equal(E.rectsOverlap(A, { x0: 11, x1: 20, y0: 0, y1: 10 }), false);
});
test('dirFrom and mirrorDir speak numpad', () => {
  assert.equal(E.dirFrom({}), 5);
  assert.equal(E.dirFrom({ d: true }), 2);
  assert.equal(E.dirFrom({ d: true, r: true }), 3);
  assert.equal(E.dirFrom({ u: true, l: true }), 7);
  assert.equal(E.mirrorDir(6), 4); assert.equal(E.mirrorDir(1), 3); assert.equal(E.mirrorDir(2), 2);
});
test('detectMotion: quarter-circle matches, mirrors when facing left, expires', () => {
  const buf = [{ t: 1, d: 2 }, { t: 3, d: 3 }, { t: 5, d: 6 }];
  assert.equal(E.detectMotion(buf, E.MOTIONS.qcf, 8, 1), true);
  assert.equal(E.detectMotion(buf, E.MOTIONS.qcf, 8, -1), false, 'mirrored pattern needs mirrored dirs');
  const bufL = [{ t: 1, d: 2 }, { t: 3, d: 1 }, { t: 5, d: 4 }];
  assert.equal(E.detectMotion(bufL, E.MOTIONS.qcf, 8, -1), true);
  assert.equal(E.detectMotion(buf, E.MOTIONS.qcf, 60, 1), false, 'stale motion expires');
  assert.equal(E.detectMotion([{ t: 1, d: 6 }, { t: 3, d: 2 }, { t: 5, d: 3 }], E.MOTIONS.dp, 8, 1), true);
});

/* ---------- match flow basics ---------- */
test('createMatch: sane initial shape', () => {
  const m = match();
  assert.equal(m.phase, 'intro');
  assert.equal(m.round, 1);
  deepEq(m.wins, [0, 0]);
  assert.equal(m.f[0].hp, E.MAX_HP);
  assert.equal(E.timerSeconds(m), E.ROUND_SECONDS);
  assert.equal(m.f[0].facing, 1); assert.equal(m.f[1].facing, -1);
  assert.equal(m.stage, 'Sky Terrace', 'stage follows the challenger');
});
test('intro counts down, then the round is live', () => {
  const m = match();
  const evs = run(m, 111);
  assert.equal(m.phase, 'fight');
  assert.ok(evs.some((e) => e.type === 'fight'));
});
test('whole matches are deterministic: same seed and inputs replay identically', () => {
  const play = () => {
    const m = match({ seed: 'replay' });
    for (let i = 0; i < 700; i++) {
      const in1 = E.cpuInputs(m, 0), in2 = E.cpuInputs(m, 1);
      E.step(m, in1, in2);
    }
    return m;
  };
  deepEq(play(), play());
});

/* ---------- movement ---------- */
test('walking: forward at full speed, backward slower, walls clamp', () => {
  const m = startFight(match());
  const x0 = m.f[0].x;
  run(m, 10, { r: true });
  assert.ok(Math.abs(m.f[0].x - (x0 + 34)) < 0.01, 'volt walks forward 3.4/tick');
  const back = m.f[0].x;
  run(m, 10, { l: true });
  assert.ok(back - m.f[0].x < 34 - 0.01, 'backing off is slower');
  m.f[0].x = E.WALL_L + 2;
  run(m, 30, { l: true });
  assert.equal(m.f[0].x, E.WALL_L, 'left wall holds');
});
test('facing follows the opponent', () => {
  const m = startFight(match());
  m.f[0].x = 700; m.f[1].x = 200;
  run(m, 1);
  assert.equal(m.f[0].facing, -1);
  assert.equal(m.f[1].facing, 1);
});
test('jumping: leaves the ground, arcs, lands back to idle', () => {
  const m = startFight(match());
  run(m, 1, { u: true });
  assert.equal(m.f[0].phase, 'jump');
  let peak = 0, airTicks = 0;
  for (let i = 0; i < 80 && (m.f[0].y > 0 || m.f[0].phase === 'jump'); i++) {
    E.step(m, NONE, NONE); peak = Math.max(peak, m.f[0].y); airTicks++;
  }
  assert.ok(peak > 90 && peak < 150, `jump apex ~120 (got ${peak.toFixed(1)})`);
  assert.ok(airTicks > 25 && airTicks < 50, 'airtime around 37 ticks');
  assert.equal(m.f[0].phase, 'idle');
  assert.equal(m.f[0].y, 0);
});
test('crouching shrinks the hurt box', () => {
  const m = startFight(match());
  run(m, 2, { d: true });
  assert.equal(m.f[0].phase, 'crouch');
  assert.equal(E.hurtBox(m.f[0]).y1, E.CROUCH_H);
  run(m, 2);
  assert.equal(E.hurtBox(m.f[0]).y1, E.STAND_H);
});
test('bodies cannot overlap: push apart to body width', () => {
  const m = startFight(match());
  m.f[0].x = 480; m.f[1].x = 480;
  run(m, 3);
  assert.ok(Math.abs(m.f[1].x - m.f[0].x) >= E.BODY_W - 0.01);
});

/* ---------- normal attacks ---------- */
test('a jab in range connects: damage, hitstun, meter for both', () => {
  const m = startFight(match());
  m.f[0].x = 450; m.f[1].x = 500;
  const evs = run(m, 8, { lp: true });
  assert.ok(evs.some((e) => e.type === 'hit'), 'hit event');
  assert.equal(m.f[1].hp, E.MAX_HP - 5, 'volt jab does 5');
  assert.equal(m.f[1].phase === 'hitstun' || m.f[1].phase === 'idle', true);
  assert.ok(m.f[0].meter > 0 && m.f[1].meter > 0, 'both gain meter');
});
test('power scales damage: Brick hits harder than Mirage', () => {
  const hpAfter = (id) => {
    const m = startFight(match({ p1: id }));
    m.f[0].x = 450; m.f[1].x = 500;
    run(m, 16, { hp: true });
    return m.f[1].hp;
  };
  assert.ok(hpAfter('brick') < hpAfter('mirage'), 'heavyweight straight hurts more');
});
test('the same attack whiffs from far away', () => {
  const m = startFight(match());
  m.f[0].x = 200; m.f[1].x = 700;
  run(m, 10, { lp: true });
  assert.equal(m.f[1].hp, E.MAX_HP);
});
test('an attack only hits once per swing', () => {
  const m = startFight(match());
  m.f[0].x = 450; m.f[1].x = 500;
  run(m, 30, { lp: true });
  assert.equal(m.f[1].hp, E.MAX_HP - 5, 'held button = one jab, one hit');
});
test('blocking a normal: no damage, blockstun, small meter', () => {
  const m = startFight(match());
  m.f[0].x = 450; m.f[1].x = 500;
  const evs = run(m, 8, { lp: true }, { r: true }); // P2 holds away
  assert.ok(evs.some((e) => e.type === 'block'));
  assert.equal(m.f[1].hp, E.MAX_HP, 'normals do no chip');
  assert.equal(m.f[1].meter, 3);
});
test('sweeps are lows: stand-block fails, crouch-block works, hit knocks down', () => {
  const sweep = (blockInputs) => {
    const m = startFight(match());
    m.f[0].x = 450; m.f[1].x = 520;
    run(m, 14, { d: true, hk: true }, blockInputs);
    return m;
  };
  const hit = sweep({ r: true });               // standing away — low goes under
  assert.ok(hit.f[1].hp < E.MAX_HP);
  assert.equal(hit.f[1].phase, 'knockdown', 'sweep knocks down');
  const blocked = sweep({ r: true, d: true });  // crouch-block
  assert.equal(blocked.f[1].hp, E.MAX_HP);
});
test('knockdown: invulnerable while down, gets up into idle', () => {
  const m = startFight(match());
  m.f[0].x = 450; m.f[1].x = 520;
  run(m, 14, { d: true, hk: true });
  assert.equal(m.f[1].phase, 'knockdown');
  const hpDown = m.f[1].hp;
  run(m, 20, { lp: true });
  assert.equal(m.f[1].hp, hpDown, 'no hits while down');
  run(m, 60);
  assert.equal(m.f[1].phase, 'idle', 'back on their feet');
});
test('jump-in attacks are highs: they beat crouch-block but not stand-block', () => {
  const jumpIn = (blockInputs) => {
    const m = startFight(match());
    m.f[0].x = 500; m.f[1].x = 560;
    E.step(m, { u: true, r: true }, blockInputs);
    for (let i = 0; i < 12; i++) E.step(m, { r: true }, blockInputs);
    for (let i = 0; i < 40; i++) E.step(m, { r: true, lp: true }, blockInputs);
    return m;
  };
  const crouched = jumpIn({ r: true, d: true });
  assert.ok(crouched.f[1].hp < E.MAX_HP, 'high hits the crouch-blocker');
  const standing = jumpIn({ r: true });
  assert.equal(standing.f[1].hp, E.MAX_HP, 'stand-block holds');
});

/* ---------- specials ---------- */
test('quarter-circle-forward + punch fires the signature projectile', () => {
  const m = startFight(match());
  const evs = runSeq(m, QCF_LP);
  assert.ok(evs.some((e) => e.type === 'special' && e.name === 'Arc Bolt'));
  run(m, 12);
  assert.equal(m.shots.length, 1);
  assert.equal(m.shots[0].dmg, 12);
  const x1 = m.shots[0].x;
  run(m, 5);
  assert.ok(m.shots[0].x > x1, 'the bolt travels');
});
test('projectile connects: damage and hitstun at range', () => {
  const m = startFight(match());
  runSeq(m, QCF_LP);
  run(m, 90);
  assert.equal(m.f[1].hp, E.MAX_HP - 12);
});
test('projectile blocked: quarter damage chip', () => {
  const m = startFight(match());
  runSeq(m, QCF_LP, { r: true });
  run(m, 200, NONE, { r: true }); // the blocker backs off — give the bolt time to arrive
  assert.equal(m.f[1].hp, E.MAX_HP - 3, 'ceil(12/4) = 3 chip');
});
test('projectiles clash and cancel out', () => {
  const m = startFight(match({ p2: 'ember' }));
  m.shots.push({ x: 400, y: 108, vx: 6, owner: 0, dmg: 12, power: 1, name: 'Arc Bolt' });
  m.shots.push({ x: 520, y: 108, vx: -6.5, owner: 1, dmg: 11, power: 1, name: 'Cinder Dart' });
  const evs = run(m, 20);
  assert.ok(evs.some((e) => e.type === 'clash'));
  assert.equal(m.shots.length, 0);
  assert.equal(m.f[0].hp, E.MAX_HP); assert.equal(m.f[1].hp, E.MAX_HP);
});
test('surge shot: spends a full meter, hits ~1.8×, beats a normal shot', () => {
  const m = startFight(match());
  m.f[0].meter = E.METER_MAX;
  runSeq(m, QCF_HP);
  assert.equal(m.f[0].meter, 0, 'meter spent');
  run(m, 12); // the shot leaves the hand after its startup ticks
  assert.equal(m.shots.length, 1);
  assert.equal(m.shots[0].dmg, Math.round(12 * 1.8));
  assert.equal(m.shots[0].power, 2);
  m.shots[0].x = 400; // stage a clash against a normal shot
  m.shots.push({ x: 520, y: 108, vx: -6, owner: 1, dmg: 11, power: 1, name: 'Jetstream' });
  run(m, 14);
  assert.equal(m.shots.length, 1, 'the surge bolt survives the clash');
  assert.equal(m.shots[0].power, 1);
});
test('without meter, heavy-punch quarter-circle is just the normal shot', () => {
  const m = startFight(match());
  runSeq(m, QCF_HP);
  run(m, 12);
  assert.equal(m.shots.length, 1);
  assert.equal(m.shots[0].power, 1);
  assert.equal(m.f[0].meter, 0);
});
test('rising strike (forward-down-downforward + punch) launches and knocks down a jumper', () => {
  const m = startFight(match());
  m.f[0].x = 480; m.f[1].x = 560;
  m.f[1].phase = 'jump'; m.f[1].y = 60; m.f[1].vy = 2;
  const evs = runSeq(m, DP_LP);
  assert.ok(evs.some((e) => e.type === 'special' && e.name === 'Coil Rise'));
  run(m, 10);
  assert.ok(m.f[1].hp < E.MAX_HP, 'anti-air connects');
  assert.equal(m.f[1].phase, 'knockdown');
  assert.ok(m.f[0].y > 0, 'the strike rises');
});
test('quarter-circle-back + kick: sweeping dash that knocks down and chips', () => {
  const m = startFight(match());
  m.f[0].x = 470; m.f[1].x = 560;
  const evs = runSeq(m, QCB_LK);
  assert.ok(evs.some((e) => e.type === 'special' && e.name === 'Live Wire'));
  run(m, 20);
  assert.equal(m.f[1].phase, 'knockdown');
  assert.equal(m.f[1].hp, E.MAX_HP - 12);
  const m2 = startFight(match());
  m2.f[0].x = 470; m2.f[1].x = 560;
  runSeq(m2, QCB_LK, { r: true, d: true }); // lows crouch-block
  run(m2, 20, NONE, { r: true, d: true });
  assert.equal(m2.f[1].hp, E.MAX_HP - 3, 'blocked special chips ceil(12/4)');
});
test('the lunge fighters close distance with their signature', () => {
  const m = startFight(match({ p1: 'sable' }));
  m.f[0].x = 300; m.f[1].x = 560;
  runSeq(m, QCF_LP);
  const x0 = m.f[0].x;
  run(m, 24); // startup + full travel
  assert.ok(m.f[0].x > x0 + 120, 'Lance Dart travels');
  assert.equal(m.shots.length, 0, 'no projectile from a lunge');
});
test('meter caps at 100', () => {
  const m = startFight(match());
  m.f[0].meter = 97;
  m.f[0].x = 450; m.f[1].x = 500;
  run(m, 16, { hp: true });
  assert.equal(m.f[0].meter, E.METER_MAX);
});

/* ---------- rounds, KO, the clock ---------- */
test('KO ends the round, scores it, and the next round resets', () => {
  const m = startFight(match());
  m.f[0].x = 450; m.f[1].x = 500; m.f[1].hp = 3;
  const evs = run(m, 8, { lp: true });
  assert.ok(evs.some((e) => e.type === 'ko'));
  assert.equal(m.phase, 'ko');
  run(m, 300);
  deepEq(m.wins, [1, 0]);
  assert.equal(m.round, 2);
  assert.equal(m.phase, 'intro');
  assert.equal(m.f[1].hp, E.MAX_HP, 'fresh health');
  assert.equal(m.f[0].x, 300, 'positions reset');
});
test('two round wins take the match', () => {
  const m = startFight(match());
  m.wins = [1, 0];
  m.f[0].x = 450; m.f[1].x = 500; m.f[1].hp = 3;
  run(m, 8, { lp: true });
  run(m, 300);
  assert.equal(m.phase, 'matchover');
  assert.equal(m.winner, 0);
});
test('chip damage can finish a round', () => {
  const m = startFight(match());
  m.f[1].hp = 2;
  runSeq(m, QCF_LP, { r: true });
  const evs = run(m, 200, NONE, { r: true });
  assert.ok(evs.some((e) => e.type === 'ko'));
});
test('double KO is a draw round: nobody scores, the round replays', () => {
  const m = startFight(match());
  m.f[0].hp = 5; m.f[1].hp = 5;
  m.shots.push({ x: 630, y: 108, vx: 6, owner: 0, dmg: 12, power: 1, name: 'x' });
  m.shots.push({ x: 330, y: 108, vx: -6, owner: 1, dmg: 12, power: 1, name: 'y' });
  const evs = run(m, 8);
  const ko = evs.find((e) => e.type === 'ko');
  assert.ok(ko && ko.double, 'double KO seen');
  run(m, 300);
  deepEq(m.wins, [0, 0]);
  assert.equal(m.round, 2, 'replayed as a fresh round');
});
test('the clock runs only during the fight and decides timeouts by health', () => {
  const m = match();
  run(m, 50); // still intro
  assert.equal(m.time, E.ROUND_SECONDS * E.TICKS);
  startFight(m);
  run(m, 60);
  assert.equal(E.timerSeconds(m), E.ROUND_SECONDS - 1);
  m.time = 1; m.f[1].hp = 40;
  const evs = run(m, 2);
  assert.ok(evs.some((e) => e.type === 'timeup' && e.winner === 0));
  run(m, 200);
  deepEq(m.wins, [1, 0]);
});
test('a timeout with equal health is a draw round', () => {
  const m = startFight(match());
  m.time = 1;
  run(m, 2);
  assert.equal(m.roundWinner, -1);
  run(m, 200);
  deepEq(m.wins, [0, 0]);
  assert.equal(m.round, 2);
});
test('decideTimeout picks the healthier fighter', () => {
  const m = match();
  m.f[0].hp = 10; m.f[1].hp = 90;
  assert.equal(E.decideTimeout(m), 1);
  m.f[0].hp = 90; m.f[1].hp = 90;
  assert.equal(E.decideTimeout(m), -1);
});
test('practice mode: the clock never runs out', () => {
  const m = startFight(match({ mode: 'practice' }));
  run(m, 120);
  assert.equal(m.time, E.ROUND_SECONDS * E.TICKS);
});

/* ---------- the CPU and the ladder ---------- */
test('cpuInputs is a pure function of the match state', () => {
  const m = startFight(match({ mode: 'cpu', level: 3 }));
  run(m, 37);
  const snap = JSON.stringify(m);
  const a = E.cpuInputs(m, 1);
  deepEq(m, JSON.parse(snap), 'no mutation');
  deepEq(a, E.cpuInputs(m, 1), 'same state, same decision');
});
test('the CPU actually fights: a cpu-vs-cpu match draws blood and ends', () => {
  const m = match({ mode: 'cpu', level: 4, seed: 'brawl' });
  let guard = 30000;
  while (m.phase !== 'matchover' && guard-- > 0) {
    E.step(m, E.cpuInputs(m, 0), E.cpuInputs(m, 1));
  }
  assert.equal(m.phase, 'matchover', 'the match reaches a verdict');
  assert.ok(m.winner === 0 || m.winner === 1);
});
test('every CPU level finishes an idle opponent well inside the round clock', () => {
  // The classic failure mode is a passive CPU that pokes air until time
  // runs out — every level must be able to actually close and finish.
  for (const lvl of [1, 2, 3, 4]) {
    const m = startFight(match({ mode: 'cpu', level: lvl, seed: 'ramp' }));
    let ko = 0;
    for (let i = 1; i <= E.ROUND_SECONDS * E.TICKS && !ko; i++) {
      E.step(m, NONE, E.cpuInputs(m, 1));
      if (m.events.some((e) => e.type === 'ko')) ko = i;
    }
    assert.ok(ko > 0 && ko < E.ROUND_SECONDS * E.TICKS / 2, `level ${lvl} KOs briskly (${ko} ticks)`);
  }
});
test('ladderFor: seven bouts, the champion last, never yourself, deterministic', () => {
  const l = E.ladderFor('volt', 'seed1');
  assert.equal(l.length, 7);
  assert.equal(l[l.length - 1], 'onyx');
  assert.ok(!l.includes('volt'));
  deepEq(l, E.ladderFor('volt', 'seed1'));
  assert.notEqual(JSON.stringify(E.ladderFor('volt', 'seed2')), JSON.stringify(l), 'seeds shuffle');
  const asChamp = E.ladderFor('onyx', 'seed1');
  assert.equal(asChamp.length, 7);
  assert.ok(!asChamp.includes('onyx'));
});
test('ladder difficulty ramps to the champion', () => {
  assert.equal(E.ladderLevel(0, 7), 1);
  assert.equal(E.ladderLevel(3, 7), 2);
  assert.equal(E.ladderLevel(5, 7), 3);
  assert.equal(E.ladderLevel(6, 7), 4, 'the champion fights at full strength');
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
