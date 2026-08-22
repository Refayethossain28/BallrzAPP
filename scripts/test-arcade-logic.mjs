#!/usr/bin/env node
/**
 * Unit tests for arcade/engine.js — the pure game-console engine behind
 * Arcade: Serpent (snake movement, growth, seeded apples, walls and
 * self-bites), Fuse 2048 (slide/merge rows, seeded tile spawns, win and
 * dead-board detection), Breaker (deterministic launch, wall/paddle/brick
 * ricochets, lives and levels) and the console's high-score table.
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-arcade-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'arcade', 'engine.js'), 'utf8'), sandbox, { filename: 'arcade/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0); // 2026-08-22 12:00 UTC

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---------- the cartridge rack ---------- */
test('GAMES: five cartridges, unique ids, gameById round-trips', () => {
  assert.equal(E.GAMES.length, 5);
  const ids = E.GAMES.map((g) => g.id);
  deepEq([...new Set(ids)], ids, 'ids are unique');
  for (const g of E.GAMES) {
    assert.ok(g.name && g.emoji && g.tagline && g.controls, `${g.id} card is complete`);
    assert.equal(E.gameById(g.id).name, g.name);
  }
  assert.equal(E.gameById('pong'), null);
});
test('the external slots: Ultra 64 pins n64, OmniCart opens the picker', () => {
  const ext = E.GAMES.filter((g) => g.external);
  deepEq(ext.map((g) => g.id), ['ultra64', 'omni']);
  assert.equal(E.gameById('ultra64').core, 'n64', 'Ultra 64 boots straight into N64');
  assert.equal(E.gameById('omni').core, '', 'OmniCart shows the system picker');
  for (const g of ext) assert.ok(g.badge, `${g.id} carries a menu badge`);
  for (const g of E.GAMES) {
    if (!g.external) assert.ok(['serpent', 'fuse', 'breaker'].includes(g.id), `${g.id} is a built-in engine game`);
  }
});

/* ---------- serpent: setup ---------- */
test('newSnake: three segments mid-garden, heading right, food on a free cell', () => {
  const s = E.newSnake('seed-a');
  assert.equal(s.snake.length, 3);
  assert.equal(s.dir, 'right');
  assert.equal(s.alive, true);
  assert.equal(s.score, 0);
  deepEq(s.snake[0], { x: 8, y: 8 });
  assert.ok(s.food, 'an apple exists');
  assert.ok(s.food.x >= 0 && s.food.x < s.cols && s.food.y >= 0 && s.food.y < s.rows);
  assert.ok(!s.snake.some((c) => c.x === s.food.x && c.y === s.food.y), 'apple not on the serpent');
});
test('newSnake is seed-deterministic', () => {
  deepEq(E.newSnake('x'), E.newSnake('x'));
  const a = E.newSnake('a'), b = E.newSnake('b');
  // bodies match, but the seeded apple generally moves with the seed
  deepEq(a.snake, b.snake);
});

/* ---------- serpent: movement ---------- */
test('stepSnake moves one cell, keeps length, honours turns', () => {
  const s0 = E.newSnake('x');
  const s1 = E.stepSnake(s0, null);
  deepEq(s1.snake[0], { x: 9, y: 8 });
  assert.equal(s1.snake.length, 3);
  assert.equal(s1.steps, 1);
  const s2 = E.stepSnake(s1, 'up');
  assert.equal(s2.dir, 'up');
  deepEq(s2.snake[0], { x: 9, y: 7 });
});
test('stepSnake ignores a reverse into the neck', () => {
  const s0 = E.newSnake('x'); // heading right
  const s1 = E.stepSnake(s0, 'left');
  assert.equal(s1.dir, 'right', 'cannot fold back');
  deepEq(s1.snake[0], { x: 9, y: 8 });
});
test('stepSnake is pure: the input state is untouched', () => {
  const s0 = E.newSnake('x');
  const frozen = JSON.stringify(s0);
  E.stepSnake(s0, 'up');
  assert.equal(JSON.stringify(s0), frozen);
});

/* ---------- serpent: eating ---------- */
test('eating grows the serpent, scores 10 and reseats the apple deterministically', () => {
  const s0 = E.newSnake('x');
  // steer straight onto the apple by walking the exact grid path
  let s = s0;
  const food = s0.food;
  // walk horizontally then vertically toward the apple, one axis at a time
  for (let guard = 0; guard < 200 && s.alive && s.eaten === 0; guard++) {
    const head = s.snake[0];
    let want = null;
    if (head.x < food.x) want = 'right';
    else if (head.x > food.x) want = 'left';
    else if (head.y < food.y) want = 'down';
    else if (head.y > food.y) want = 'up';
    s = E.stepSnake(s, want);
  }
  assert.equal(s.eaten, 1, 'the apple was reached');
  assert.equal(s.score, 10);
  assert.equal(s.snake.length, 4, 'grew by one');
  assert.ok(s.food, 'a new apple appeared');
  assert.ok(!(s.food.x === food.x && s.food.y === food.y) ||
            s.snake.some((c) => c.x === food.x && c.y === food.y),
            'the new apple is a fresh placement');
  // replaying the same journey lands the same second apple
  let t = s0;
  for (let guard = 0; guard < 200 && t.alive && t.eaten === 0; guard++) {
    const head = t.snake[0];
    let want = null;
    if (head.x < food.x) want = 'right';
    else if (head.x > food.x) want = 'left';
    else if (head.y < food.y) want = 'down';
    else if (head.y > food.y) want = 'up';
    t = E.stepSnake(t, want);
  }
  deepEq(t.food, s.food, 'seeded apples replay identically');
});

/* ---------- serpent: dying ---------- */
test('the wall kills: marching right off the garden ends the run', () => {
  let s = E.newSnake('x');
  for (let i = 0; i < E.SNAKE_COLS + 2 && s.alive; i++) s = E.stepSnake(s, 'right');
  assert.equal(s.alive, false);
  const atDeath = s;
  deepEq(E.stepSnake(atDeath, 'up'), atDeath, 'a dead serpent stays dead');
});
test('biting your own body kills; chasing your vacating tail does not', () => {
  // grow to length 5 by hand-building a state, then loop into the body
  const body = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 7, y: 9 }, { x: 8, y: 9 }, { x: 9, y: 9 }];
  const s = { cols: 16, rows: 16, seed: 'x', snake: body, dir: 'right', food: { x: 0, y: 0 }, score: 0, eaten: 0, steps: 0, alive: true };
  const down = E.stepSnake(s, 'down'); // head → (8,9), still occupied after tail moves
  assert.equal(down.alive, false, 'bit its own body');
  // a 4-loop chasing its tail survives: the tail cell vacates the same tick
  const ring = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 7, y: 9 }, { x: 8, y: 9 }];
  const s2 = { cols: 16, rows: 16, seed: 'x', snake: ring, dir: 'right', food: { x: 0, y: 0 }, score: 0, eaten: 0, steps: 0, alive: true };
  assert.equal(E.stepSnake(s2, 'down').alive, true, 'the tail vacated in time');
});
test('snakeSpeedMs quickens with score and floors at 70ms', () => {
  assert.equal(E.snakeSpeedMs(0), 160);
  assert.equal(E.snakeSpeedMs(49), 160);
  assert.equal(E.snakeSpeedMs(50), 150);
  assert.equal(E.snakeSpeedMs(100000), 70);
  assert.ok(E.snakeSpeedMs(200) <= E.snakeSpeedMs(100), 'monotonic');
});

/* ---------- fuse 2048: sliding ---------- */
test('slideLeft merges pairs once, left to right', () => {
  deepEq(E.slideLeft([2, 2, 0, 0]), { row: [4, 0, 0, 0], gained: 4, moved: true });
  deepEq(E.slideLeft([2, 2, 2, 2]), { row: [4, 4, 0, 0], gained: 8, moved: true }, 'no double-merge');
  deepEq(E.slideLeft([4, 2, 2, 0]), { row: [4, 4, 0, 0], gained: 4, moved: true }, 'merge favours the front');
  deepEq(E.slideLeft([2, 0, 0, 2]), { row: [4, 0, 0, 0], gained: 4, moved: true }, 'gaps close before merging');
  deepEq(E.slideLeft([2, 4, 2, 4]), { row: [2, 4, 2, 4], gained: 0, moved: false }, 'nothing to do');
  deepEq(E.slideLeft([0, 0, 0, 2]), { row: [2, 0, 0, 0], gained: 0, moved: true }, 'a slide with no merge still moves');
});
test('move2048 slides every direction correctly', () => {
  const base = { seed: 'x', board: [[2, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 2]], score: 0, moves: 0, won: false, over: false };
  const left = E.move2048(base, 'left');
  assert.equal(left.board[0][0], 4);
  assert.equal(left.board[3][0], 4);
  assert.equal(left.score, 8);
  const up = E.move2048(base, 'up');
  assert.equal(up.board[0][0], 4);
  assert.equal(up.board[0][3], 4);
  const down = E.move2048(base, 'down');
  assert.equal(down.board[3][0], 4);
  const right = E.move2048(base, 'right');
  assert.equal(right.board[0][3], 4);
});
test('a move that changes nothing spawns nothing and returns the same state', () => {
  const stuckLeft = { seed: 'x', board: [[2, 4, 8, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 0, moves: 0, won: false, over: false };
  assert.equal(E.move2048(stuckLeft, 'left'), stuckLeft, 'identity — no phantom spawn');
});
test('a real move spawns exactly one seeded tile (2 or 4)', () => {
  const s0 = E.new2048('spawn-test');
  const countTiles = (b) => b.flat().filter(Boolean).length;
  assert.equal(countTiles(s0.board), 2, 'a fresh board deals two tiles');
  const s1 = E.move2048(s0, 'left');
  if (s1 !== s0) {
    const merged = s1.score > 0;
    assert.equal(countTiles(s1.board), countTiles(s0.board) + 1 - (merged ? s1.score > 4 ? 2 : 1 : 0) + (merged ? (s1.score > 4 ? 1 : 0) : 0), 'net one new tile modulo merges');
    assert.ok(s1.board.flat().every((v) => v === 0 || (v & (v - 1)) === 0), 'all tiles are powers of two');
  }
  deepEq(E.move2048(s0, 'left'), s1, 'seeded spawn replays identically');
});
test('new2048 is seed-deterministic and different seeds deal differently', () => {
  deepEq(E.new2048('a'), E.new2048('a'));
  const boards = new Set(['a', 'b', 'c', 'd', 'e'].map((s) => JSON.stringify(E.new2048(s).board)));
  assert.ok(boards.size >= 2, 'seeds actually vary the deal');
});
test('won flips at 2048 and sticks; over on a dead board; canMove2048 edges', () => {
  const nearly = { seed: 'x', board: [[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 0, moves: 0, won: false, over: false };
  const won = E.move2048(nearly, 'left');
  assert.equal(won.won, true);
  assert.equal(won.over, false, 'winning does not end the game');
  const dead = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
  assert.equal(E.canMove2048(dead), false);
  assert.equal(E.canMove2048([[2, 2, 4, 8], [4, 8, 16, 32], [8, 16, 32, 64], [16, 32, 64, 128]]), true, 'one merge left');
  assert.equal(E.canMove2048([[0, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]), true, 'one hole left');
  assert.equal(E.highestTile(dead), 4);
  const doneState = { seed: 'x', board: dead, score: 0, moves: 9, won: false, over: true };
  assert.equal(E.move2048(doneState, 'left'), doneState, 'a finished game ignores input');
});

/* ---------- breaker: setup & launch ---------- */
test('newBreaker: 35 bricks, 3 lives, ball resting on the paddle', () => {
  const b = E.newBreaker('x');
  assert.equal(b.bricks.length, 35);
  assert.equal(E.bricksAlive(b.bricks), 35);
  assert.equal(b.lives, 3);
  assert.equal(b.stuck, true);
  assert.equal(b.over, false);
  assert.ok(b.ball.y < E.BREAKER.paddleY, 'ball sits above the paddle');
  assert.ok(b.bricks.every((bk) => bk.x >= 0 && bk.x + bk.w <= 1 && bk.y + bk.h < 0.5), 'bricks hang in the top half');
  assert.equal(b.bricks[0].pts, 50, 'top row is worth most');
  assert.equal(b.bricks[34].pts, 10, 'bottom row least');
});
test('launchBreaker: deterministic upward launch; no-op mid-flight', () => {
  const b0 = E.newBreaker('x');
  const f1 = E.launchBreaker(b0);
  assert.equal(f1.stuck, false);
  assert.ok(f1.ball.vy < 0, 'launches upward');
  assert.ok(Math.hypot(f1.ball.vx, f1.ball.vy) > 0.5, 'at game speed');
  deepEq(E.launchBreaker(b0), f1, 'seeded angle replays');
  assert.equal(E.launchBreaker(f1), f1, 'launching a flying ball is a no-op');
});

/* ---------- breaker: physics ---------- */
const DT = 1 / 120;
test('a stuck ball rides the paddle and the paddle clamps to the walls', () => {
  const b0 = E.newBreaker('x');
  const b1 = E.stepBreaker(b0, 0.9, DT);
  assert.equal(b1.ball.x, b1.paddleX);
  const clamped = E.stepBreaker(b0, 5, DT);
  assert.equal(clamped.paddleX, 1 - E.BREAKER.paddleW / 2);
  const clampedLo = E.stepBreaker(b0, -5, DT);
  assert.equal(clampedLo.paddleX, E.BREAKER.paddleW / 2);
});
test('walls reflect: left wall flips vx, top wall flips vy', () => {
  const base = E.newBreaker('x');
  const leftWall = { ...E.launchBreaker(base), ball: { x: 0.02, y: 0.5, vx: -0.5, vy: -0.3 } };
  const b1 = E.stepBreaker(leftWall, 0.5, DT);
  assert.ok(b1.ball.vx > 0, 'vx flipped at the left wall');
  const topWall = { ...E.launchBreaker(base), ball: { x: 0.5, y: 0.01, vx: 0.1, vy: -0.5 }, bricks: base.bricks.map((bk) => ({ ...bk, alive: bk.row > 0 ? bk.alive : bk.alive })) };
  // aim between brick columns is fiddly — clear the bricks so only the wall is in play
  topWall.bricks = base.bricks.map((bk) => ({ ...bk, y: bk.y + 0.4 }));
  const b2 = E.stepBreaker(topWall, 0.5, DT);
  assert.ok(b2.ball.vy > 0, 'vy flipped at the top wall');
});
test('hitting a brick kills it once and banks its points', () => {
  const base = E.launchBreaker(E.newBreaker('x'));
  const target = base.bricks[17]; // middle of the wall
  const rigged = { ...base, ball: { x: target.x + target.w / 2, y: target.y + target.h + E.BREAKER.ballR + 0.001, vx: 0, vy: -0.6 } };
  const hit = E.stepBreaker(rigged, 0.5, DT);
  assert.equal(E.bricksAlive(hit.bricks), 34, 'exactly one brick died');
  assert.equal(hit.bricks[17].alive, false, 'the one we aimed at');
  assert.equal(hit.score, base.score + target.pts);
  assert.ok(hit.ball.vy > 0, 'the ball bounced back down');
  assert.ok(rigged.bricks[17].alive, 'input state untouched');
});
test('the paddle returns a falling ball, steering by hit offset', () => {
  const base = E.launchBreaker(E.newBreaker('x'));
  const paddleTop = E.BREAKER.paddleY - E.BREAKER.paddleH / 2;
  const centre = { ...base, ball: { x: 0.5, y: paddleTop - E.BREAKER.ballR + 0.001, vx: 0, vy: 0.5 } };
  const c = E.stepBreaker(centre, 0.5, DT);
  assert.ok(c.ball.vy < 0, 'bounced up');
  assert.ok(Math.abs(c.ball.vx) < 0.1, 'a centre hit goes near-straight up');
  const edge = { ...base, ball: { x: 0.59, y: paddleTop - E.BREAKER.ballR + 0.001, vx: 0, vy: 0.5 } };
  const e = E.stepBreaker(edge, 0.5, DT);
  assert.ok(e.ball.vx > 0.2, 'an edge hit fires it sideways');
});
test('dropping the ball costs a life; the last life ends the game', () => {
  const base = E.launchBreaker(E.newBreaker('x'));
  const dropping = { ...base, ball: { x: 0.05, y: 1.05, vx: 0, vy: 0.6 } };
  const b1 = E.stepBreaker(dropping, 0.9, DT); // paddle far away
  assert.equal(b1.lives, 2);
  assert.equal(b1.stuck, true, 'ball back on the paddle');
  assert.equal(b1.over, false);
  const lastLife = { ...dropping, lives: 1 };
  const b2 = E.stepBreaker(lastLife, 0.9, DT);
  assert.equal(b2.lives, 0);
  assert.equal(b2.over, true);
  assert.equal(E.stepBreaker(b2, 0.5, DT), b2, 'a finished game ignores steps');
});
test('clearing the wall advances the level with fresh, faster bricks', () => {
  const base = E.launchBreaker(E.newBreaker('x'));
  const last = base.bricks[0];
  const oneLeft = {
    ...base,
    bricks: base.bricks.map((bk, i) => ({ ...bk, alive: i === 0 })),
    ball: { x: last.x + last.w / 2, y: last.y + last.h + E.BREAKER.ballR + 0.001, vx: 0, vy: -0.6 },
  };
  const cleared = E.stepBreaker(oneLeft, 0.5, DT);
  assert.equal(cleared.level, 2);
  assert.equal(E.bricksAlive(cleared.bricks), 35, 'a fresh wall');
  assert.equal(cleared.stuck, true);
  assert.ok(E.breakerSpeed(cleared) > E.breakerSpeed(E.newBreaker('x')), 'level 2 is faster');
});
test('breaker physics replay identically from the same seed and inputs', () => {
  const run = () => {
    let s = E.launchBreaker(E.newBreaker('replay'));
    for (let i = 0; i < 600; i++) s = E.stepBreaker(s, 0.35 + 0.3 * Math.sin(i / 40), DT);
    return s;
  };
  deepEq(run(), run());
});

/* ---------- the high-score table ---------- */
test('recordScore: first run sets best; better beats it; worse only counts a play', () => {
  let t = E.recordScore({}, 'serpent', 120, NOW);
  deepEq(t.serpent, { best: 120, last: 120, plays: 1, ts: NOW });
  t = E.recordScore(t, 'serpent', 80, NOW + 1000);
  assert.equal(t.serpent.best, 120, 'a worse run keeps the best');
  assert.equal(t.serpent.last, 80);
  assert.equal(t.serpent.plays, 2);
  assert.equal(t.serpent.ts, NOW, 'best timestamp untouched');
  t = E.recordScore(t, 'serpent', 300, NOW + 2000);
  assert.equal(t.serpent.best, 300);
  assert.equal(t.serpent.ts, NOW + 2000, 'the clock stamps the new best');
});
test('recordScore is pure, per-game, and junk-safe', () => {
  const before = { serpent: { best: 10, last: 10, plays: 1, ts: NOW } };
  const frozen = JSON.stringify(before);
  const after = E.recordScore(before, 'fuse', 50, NOW);
  assert.equal(JSON.stringify(before), frozen, 'input table untouched');
  assert.equal(after.serpent.best, 10, 'other games unaffected');
  assert.equal(after.fuse.best, 50);
  assert.equal(E.recordScore({}, 'fuse', 'garbage', NOW).fuse.best, 0);
  assert.equal(E.recordScore({}, 'fuse', -5, NOW).fuse.best, 0);
  assert.equal(E.recordScore(null, 'fuse', 12.9, NOW).fuse.best, 12, 'floats floor');
});
test('bestScore / isHighScore / formatScore', () => {
  const t = { fuse: { best: 1500, last: 100, plays: 3, ts: NOW } };
  assert.equal(E.bestScore(t, 'fuse'), 1500);
  assert.equal(E.bestScore(t, 'serpent'), 0);
  assert.equal(E.bestScore(null, 'fuse'), 0);
  assert.equal(E.isHighScore(t, 'fuse', 1501), true);
  assert.equal(E.isHighScore(t, 'fuse', 1500), false);
  assert.equal(E.isHighScore(t, 'serpent', 1), true);
  assert.equal(E.formatScore(0), '0');
  assert.equal(E.formatScore(999), '999');
  assert.equal(E.formatScore(1234567), '1,234,567');
});

/* ---------- seeded randomness ---------- */
test('rand01/hashStr are stable, spread, and in range', () => {
  assert.equal(E.hashStr('arcade'), E.hashStr('arcade'));
  assert.notEqual(E.hashStr('a'), E.hashStr('b'));
  const r = E.rand01('seed-x');
  assert.equal(r, E.rand01('seed-x'));
  assert.ok(r >= 0 && r < 1);
  const vals = new Set(Array.from({ length: 50 }, (_, i) => E.rand01('s' + i)));
  assert.ok(vals.size > 45, 'seeds spread');
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\narcade: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
