#!/usr/bin/env node
/**
 * Unit tests for imposter/engine.js — the deal/vote/score core of the Imposter
 * party game. Loaded in a vm sandbox (repo is type:module). Determinism comes
 * from seeding mulberry32, so every "random" path here is reproducible.
 * Run: node scripts/test-imposter-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'imposter', 'engine.js'), 'utf8'), sandbox, { filename: 'imposter/engine.js' });
const E = sandbox.module.exports;

const players = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/* ---------- word packs ---------- */
test('every pack has a name, emoji and a healthy, unique word list', () => {
  for (const k of E.PACK_KEYS) {
    const pack = E.WORD_PACKS[k];
    assert.ok(pack.name && pack.emoji, `${k} missing meta`);
    assert.ok(pack.words.length >= 12, `${k} too few words`);
    assert.equal(new Set(pack.words).size, pack.words.length, `${k} has duplicate words`);
    for (const w of pack.words) assert.ok(/^[A-Za-z][A-Za-z ]*$/.test(w), `${k}: "${w}" should be plain letters/spaces`);
  }
});

test('resolveWordList: mixed merges packs; custom passes through', () => {
  const mixed = E.resolveWordList('mixed');
  assert.ok(mixed.length > E.WORD_PACKS.food.words.length);
  assert.deepEqual(E.resolveWordList('anything', ['A', 'B']), ['A', 'B']);
  assert.deepEqual(E.resolveWordList('food', []), E.WORD_PACKS.food.words); // empty custom ignored
});

/* ---------- imposter counts ---------- */
test('suggestImposters scales, maxImposters keeps crew in the majority', () => {
  assert.equal(E.suggestImposters(3), 1);
  assert.equal(E.suggestImposters(6), 1);
  assert.equal(E.suggestImposters(8), 2);
  // crew must strictly outnumber imposters, and there's always >=2 crew
  for (let n = 3; n <= 12; n++) {
    const m = E.maxImposters(n);
    assert.ok(m >= 1, `n=${n} max>=1`);
    assert.ok(n - m > m, `n=${n}: crew ${n - m} must beat imposters ${m}`);
    assert.ok(n - m >= 2, `n=${n}: need >=2 crew`);
  }
});

/* ---------- dealing ---------- */
test('dealRound: exactly N assignments, right imposter count, crew share one word', () => {
  const rng = E.mulberry32(42);
  const r = E.dealRound({ players: players(6), imposterCount: 2, packKey: 'animals', rng });
  assert.equal(r.assignments.length, 6);
  const imps = r.assignments.filter((a) => a.isImposter);
  assert.equal(imps.length, 2);
  const crew = r.assignments.filter((a) => !a.isImposter);
  for (const c of crew) assert.equal(c.word, r.secret, 'every crew word == secret');
  assert.ok(E.WORD_PACKS.animals.words.includes(r.secret));
});

test('classic mode: imposters get no word; decoy mode: a different same-pack word', () => {
  let rng = E.mulberry32(7);
  const classic = E.dealRound({ players: players(4), packKey: 'food', mode: 'classic', rng });
  for (const a of classic.assignments) if (a.isImposter) assert.equal(a.word, null);
  assert.equal(classic.decoy, null);

  rng = E.mulberry32(7);
  const decoy = E.dealRound({ players: players(4), packKey: 'food', mode: 'decoy', rng });
  assert.ok(decoy.decoy && decoy.decoy !== decoy.secret, 'decoy differs from secret');
  assert.ok(E.WORD_PACKS.food.words.includes(decoy.decoy), 'decoy from same pack');
  for (const a of decoy.assignments) if (a.isImposter) assert.equal(a.word, decoy.decoy);
});

test('dealRound: order is a permutation of all players; clamps imposter count; needs 3+', () => {
  const rng = E.mulberry32(99);
  const r = E.dealRound({ players: players(5), imposterCount: 99, rng });
  assert.equal([...new Set(r.order)].length, 5);
  assert.deepEqual(r.order.slice().sort(), players(5).map((p) => p.id).sort());
  assert.equal(r.assignments.filter((a) => a.isImposter).length, E.maxImposters(5));
  assert.throws(() => E.dealRound({ players: players(2), rng }), /at least 3/);
});

test('dealRound is reproducible for a given seed', () => {
  const a = E.dealRound({ players: players(5), packKey: 'tech', rng: E.mulberry32(123) });
  const b = E.dealRound({ players: players(5), packKey: 'tech', rng: E.mulberry32(123) });
  assert.deepEqual(a.assignments, b.assignments);
  assert.equal(a.secret, b.secret);
  assert.deepEqual(a.order, b.order);
});

/* ---------- voting ---------- */
test('tallyVotes: clear winner, ties, abstentions', () => {
  assert.deepEqual(E.tallyVotes(['p1', 'p1', 'p2']).eliminated, 'p1');
  const tied = E.tallyVotes(['p1', 'p2']);
  assert.ok(tied.tie);
  assert.equal(tied.eliminated, null);
  const withAbstain = E.tallyVotes(['p1', null, 'p1', undefined]);
  assert.equal(withAbstain.eliminated, 'p1');
  assert.equal(withAbstain.counts.p1, 2);
  assert.equal(E.tallyVotes([]).eliminated, null);
});

/* ---------- resolution & scoring ---------- */
function fixedRound() {
  // p0 is the imposter; secret is "Pizza".
  const assignments = [
    { id: 'p0', name: 'A', isImposter: true, role: 'imposter', word: null },
    { id: 'p1', name: 'B', isImposter: false, role: 'crew', word: 'Pizza' },
    { id: 'p2', name: 'C', isImposter: false, role: 'crew', word: 'Pizza' },
    { id: 'p3', name: 'D', isImposter: false, role: 'crew', word: 'Pizza' },
  ];
  return { assignments, secret: 'Pizza' };
}

test('crew win: imposter caught, no correct guess — only crew score', () => {
  const { assignments, secret } = fixedRound();
  const r = E.resolveRound({ assignments, eliminatedId: 'p0', guessedWord: 'Taco', secret });
  assert.equal(r.outcome, 'crew');
  assert.ok(r.caughtImposter && !r.stolen);
  assert.equal(r.scores.p0, 0);
  assert.equal(r.scores.p1, E.SCORE.CREW_CATCH);
  assert.equal(r.scores.p1 + r.scores.p2 + r.scores.p3, 3 * E.SCORE.CREW_CATCH);
});

test('imposter steal: caught but names the word (case/space-insensitive)', () => {
  const { assignments, secret } = fixedRound();
  const r = E.resolveRound({ assignments, eliminatedId: 'p0', guessedWord: '  pIzZa ', secret });
  assert.equal(r.outcome, 'imposter');
  assert.ok(r.caughtImposter && r.stolen && r.guessRight);
  assert.equal(r.scores.p0, E.SCORE.IMPOSTER_STEAL);
  assert.equal(r.scores.p1, 0);
});

test('imposter evade: an innocent is voted out', () => {
  const { assignments, secret } = fixedRound();
  const r = E.resolveRound({ assignments, eliminatedId: 'p2', guessedWord: null, secret });
  assert.equal(r.outcome, 'imposter');
  assert.ok(!r.caughtImposter);
  assert.equal(r.scores.p0, E.SCORE.IMPOSTER_EVADE);
  assert.equal(r.scores.p2, 0);
});

test('imposter evade: a tied/again vote eliminates nobody', () => {
  const { assignments, secret } = fixedRound();
  const r = E.resolveRound({ assignments, eliminatedId: null, secret });
  assert.equal(r.outcome, 'imposter');
  assert.match(r.summary, /tied/);
  assert.equal(r.scores.p0, E.SCORE.IMPOSTER_EVADE);
});

test('applyScores folds deltas into running totals', () => {
  let totals = {};
  totals = E.applyScores(totals, { p0: 0, p1: 1, p2: 1 });
  totals = E.applyScores(totals, { p0: 3, p1: 0, p2: 0 });
  assert.deepEqual({ ...totals }, { p0: 3, p1: 1, p2: 1 }); // spread into this realm (engine runs in a vm)
});

/* ---------- locations (Spyfall) mode ---------- */
test('every location has an emoji and enough roles to cover a full table', () => {
  for (const k of E.LOCATION_KEYS) {
    const loc = E.LOCATIONS[k];
    assert.ok(loc.name && loc.emoji, `${k} missing meta`);
    assert.ok(loc.roles.length >= 8, `${k} needs >=8 roles, has ${loc.roles.length}`);
    assert.equal(new Set(loc.roles).size, loc.roles.length, `${k} has duplicate roles`);
  }
});

test('location deal: shared location, unique-ish crew roles, spy gets neither', () => {
  const rng = E.mulberry32(11);
  const r = E.dealRound({ players: players(6), imposterCount: 1, gameType: 'location', locationKey: 'casino', rng });
  assert.equal(r.gameType, 'location');
  assert.equal(r.secret, 'Casino');
  assert.equal(r.category, 'Location');
  const crew = r.assignments.filter((a) => !a.isImposter);
  const spy = r.assignments.find((a) => a.isImposter);
  for (const c of crew) {
    assert.equal(c.word, 'Casino', 'crew knows the location');
    assert.ok(E.LOCATIONS.casino.roles.includes(c.roleName), 'crew role is from the location');
  }
  assert.equal(spy.word, null, 'spy has no location');
  assert.equal(spy.roleName, 'The Spy');
  // 6 players <= 10 roles ⇒ the 5 crew get distinct roles
  const crewRoles = crew.map((c) => c.roleName);
  assert.equal(new Set(crewRoles).size, crewRoles.length, 'crew roles distinct when roles outnumber crew');
});

test('location mode reuses the steal pipeline: spy names the location to steal', () => {
  const rng = E.mulberry32(3);
  const r = E.dealRound({ players: players(4), gameType: 'location', locationKey: 'beach', rng });
  const spy = r.assignments.find((a) => a.isImposter);
  const res = E.resolveRound({ assignments: r.assignments, eliminatedId: spy.id, guessedWord: 'beach', secret: r.secret });
  assert.equal(res.outcome, 'imposter');
  assert.ok(res.stolen);
});

test("location 'mixed' picks some real location", () => {
  const r = E.dealRound({ players: players(5), gameType: 'location', locationKey: 'mixed', rng: E.mulberry32(8) });
  assert.ok(E.LOCATION_KEYS.some((k) => E.LOCATIONS[k].name === r.secret));
});

/* ---------- standings / MVP / match end ---------- */
test('standings: ranks, leader, MVP, and target-based match win', () => {
  const ps = players(3);
  const s1 = E.standings(ps, { p0: 2, p1: 5, p2: 1 }, 10);
  assert.equal(s1.rows[0].id, 'p1');
  assert.equal(s1.rows[0].rank, 1);
  assert.equal(s1.mvp.id, 'p1');
  assert.equal(s1.matchWon, false, 'nobody at target yet');

  const s2 = E.standings(ps, { p0: 4, p1: 11, p2: 1 }, 10);
  assert.ok(s2.matchWon && s2.champion.id === 'p1');

  const s3 = E.standings(ps, { p0: 10, p1: 10, p2: 1 }, 10);
  assert.equal(s3.matchWon, false, 'tie at the top is not a win');
  assert.ok(s3.tiedAtTop, 'flagged for a decider');

  const s0 = E.standings(ps, {}, 10);
  assert.equal(s0.mvp, null, 'no MVP at 0–0–0');
});

/* ---------- per-player stats ---------- */
test('applyRoundStats accumulates rounds, imposter count, catches, steals, wins', () => {
  let stats = {};
  const { assignments, secret } = fixedRound(); // p0 imposter, p1-3 crew, secret Pizza

  // round 1: crew catch the imposter (no steal)
  let res = E.resolveRound({ assignments, eliminatedId: 'p0', guessedWord: 'no', secret });
  stats = E.applyRoundStats(stats, assignments, res);
  assert.deepEqual({ ...stats.p0 }, { rounds: 1, asImposter: 1, caught: 1, steals: 0, wins: 0 });
  assert.deepEqual({ ...stats.p1 }, { rounds: 1, asImposter: 0, caught: 0, steals: 0, wins: 1 });

  // round 2: same imposter caught but steals it back
  res = E.resolveRound({ assignments, eliminatedId: 'p0', guessedWord: 'Pizza', secret });
  stats = E.applyRoundStats(stats, assignments, res);
  assert.deepEqual({ ...stats.p0 }, { rounds: 2, asImposter: 2, caught: 2, steals: 1, wins: 1 });
  assert.deepEqual({ ...stats.p1 }, { rounds: 2, asImposter: 0, caught: 0, steals: 0, wins: 1 }); // crew lost r2

  assert.equal(E.winRate(stats.p0), 0.5);
  assert.equal(E.winRate({ rounds: 0 }), null);
});

/* ---------- end-to-end sanity ---------- */
test('a full seeded game deals, votes out the imposter and scores the crew', () => {
  const rng = E.mulberry32(2026);
  const r = E.dealRound({ players: players(5), imposterCount: 1, packKey: 'mixed', rng });
  const impId = r.assignments.find((a) => a.isImposter).id;
  const votes = r.assignments.map(() => impId); // everyone (correctly) fingers the imposter
  const tally = E.tallyVotes(votes);
  assert.equal(tally.eliminated, impId);
  const res = E.resolveRound({ assignments: r.assignments, eliminatedId: tally.eliminated, guessedWord: 'nope', secret: r.secret });
  assert.equal(res.outcome, 'crew');
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1; }
}
console.log(`\nimposter engine: ${passed}/${tests.length} passed`);
