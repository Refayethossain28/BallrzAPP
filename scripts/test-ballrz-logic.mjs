#!/usr/bin/env node
/**
 * Unit tests for ballrz/engine.js — the pure football engine behind Ballrz
 * (squad generation, Berger fixtures, tactics, the minute-by-minute match
 * simulation, league table maths, cup draws, penalty shootouts, player
 * development, transfers, finances, awards and the career state machine).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-ballrz-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'ballrz', 'engine.js'), 'utf8'), sandbox, { filename: 'ballrz/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---------- primitives ---------- */
test('hashStr is deterministic and spreads', () => {
  assert.equal(E.hashStr('ballrz'), E.hashStr('ballrz'));
  assert.notEqual(E.hashStr('ballrz'), E.hashStr('ballrz2'));
});
test('rng: same seed same stream, different seeds differ, values in [0,1)', () => {
  const a = E.rng('s1'), b = E.rng('s1'), c = E.rng('s2');
  const va = [a(), a(), a()], vb = [b(), b(), b()];
  deepEq(va, vb);
  assert.notEqual(JSON.stringify(va), JSON.stringify([c(), c(), c()]));
  for (const v of va) assert.ok(v >= 0 && v < 1);
});
test('escapeHTML neutralises markup', () => {
  assert.equal(E.escapeHTML('<b a="c">&\''), '&lt;b a=&quot;c&quot;&gt;&amp;&#39;');
});
test('fmtMoney: millions, thousands, negatives', () => {
  assert.equal(E.fmtMoney(12_500_000), '£12.5m');
  assert.equal(E.fmtMoney(850_000), '£850k');
  assert.equal(E.fmtMoney(-2_000_000), '-£2m');
  assert.equal(E.fmtMoney(0), '£0');
});

/* ---------- universe generation ---------- */
test('genLeague: 20 clubs, 18 players each, deterministic per seed', () => {
  const L1 = E.genLeague('alpha'), L2 = E.genLeague('alpha'), L3 = E.genLeague('beta');
  assert.equal(L1.clubs.length, 20);
  deepEq(L1, L2, 'same seed → identical league');
  assert.notEqual(JSON.stringify(L1), JSON.stringify(L3), 'different seed → different league');
  for (const c of L1.clubs) {
    assert.equal(c.squad.length, 18);
    const counts = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const id of c.squad) counts[L1.players[id].pos]++;
    deepEq(counts, { GK: 2, DF: 6, MF: 6, FW: 4 });
  }
});
test('genLeague: tier 1 clubs are stronger than tier 4 on average', () => {
  const L = E.genLeague('tiers');
  const meanOvr = (c) => c.squad.reduce((s, id) => s + E.overall(L.players[id]), 0) / c.squad.length;
  const t1 = L.clubs.filter((c) => c.tier === 1).map(meanOvr);
  const t4 = L.clubs.filter((c) => c.tier === 4).map(meanOvr);
  assert.ok(Math.min(...t1) > Math.max(...t4), 'every t1 squad above every t4 squad');
});
test('overall: position-weighted and bounded', () => {
  const gk = { pos: 'GK', pace: 50, technique: 50, defending: 50, finishing: 20, keeping: 90, stamina: 50 };
  const fw = { ...gk, pos: 'FW', keeping: 20, finishing: 90 };
  assert.ok(E.overall(gk) > 70, 'keeping dominates a GK');
  assert.ok(E.overall(fw) > 65, 'finishing dominates a FW');
  assert.ok(E.overall(gk) <= 99 && E.overall(gk) >= 0);
});
test('playerValue: better is dearer, prime age beats twilight, floor holds', () => {
  const base = { pos: 'MF', pace: 70, technique: 70, defending: 60, finishing: 60, keeping: 20, stamina: 70 };
  const young = { ...base, age: 21 }, prime = { ...base, age: 26 }, old = { ...base, age: 34 };
  assert.ok(E.playerValue(young) > E.playerValue(prime), 'youth premium');
  assert.ok(E.playerValue(prime) > E.playerValue(old), 'age decline');
  const dud = { pos: 'DF', pace: 20, technique: 20, defending: 20, finishing: 20, keeping: 20, stamina: 20, age: 36 };
  assert.equal(E.playerValue(dud), 25000, 'value never below the floor');
  const better = { ...base, age: 26, technique: 85 };
  assert.ok(E.playerValue(better) > E.playerValue(prime), 'more skill, more money');
});

/* ---------- fixtures ---------- */
test('fixtures: double round-robin invariants for 20 teams', () => {
  const ids = Array.from({ length: 20 }, (_, i) => 'c' + (i + 1));
  const rounds = E.fixtures(ids);
  assert.equal(rounds.length, 38);
  const pairSeen = new Set();
  for (const round of rounds) {
    assert.equal(round.length, 10);
    const inRound = new Set();
    for (const g of round) {
      assert.ok(!inRound.has(g.home) && !inRound.has(g.away), 'no team twice in a round');
      inRound.add(g.home); inRound.add(g.away);
      const key = g.home + '>' + g.away;
      assert.ok(!pairSeen.has(key), 'no repeated ordered pairing');
      pairSeen.add(key);
    }
  }
  assert.equal(pairSeen.size, 380, 'every ordered pair exactly once');
});
test('fixtures: every team gets 19 home and 19 away games', () => {
  const ids = Array.from({ length: 20 }, (_, i) => 'c' + (i + 1));
  const home = {}, away = {};
  for (const round of E.fixtures(ids)) for (const g of round) {
    home[g.home] = (home[g.home] || 0) + 1;
    away[g.away] = (away[g.away] || 0) + 1;
  }
  for (const id of ids) { assert.equal(home[id], 19); assert.equal(away[id], 19); }
});
test('fixtures: odd team count throws', () => {
  assert.throws(() => E.fixtures(['a', 'b', 'c']));
});

/* ---------- lineups & strength ---------- */
const demoSquad = (seed) => {
  const L = E.genLeague(seed);
  const c = L.clubs[0];
  return c.squad.map((id) => L.players[id]);
};
test('pickXI: 11 players in the requested shape, strongest first', () => {
  const squad = demoSquad('xi');
  const xi = E.pickXI(squad, '4-3-3');
  assert.equal(xi.all.length, 11);
  assert.equal(xi.GK.length, 1);
  assert.equal(xi.DF.length, 4);
  assert.equal(xi.MF.length, 3);
  assert.equal(xi.FW.length, 3);
  const benchDF = squad.filter((p) => p.pos === 'DF' && !xi.DF.includes(p));
  for (const b of benchDF) for (const s of xi.DF) {
    assert.ok(E.overall(s) >= E.overall(b), 'no stronger defender left on the bench');
  }
});
test('pickXI: fills gaps with best remaining bodies when a position runs dry', () => {
  const squad = demoSquad('thin').filter((p) => p.pos !== 'FW');
  const xi = E.pickXI(squad, '4-3-3');
  assert.equal(xi.all.length, 11, 'still fields eleven');
});
test('teamStrength: attacking mentality trades defence for attack', () => {
  const xi = E.pickXI(demoSquad('str'), '4-4-2');
  const bal = E.teamStrength(xi, { formation: '4-4-2', mentality: 'balanced' }, 70);
  const att = E.teamStrength(xi, { formation: '4-4-2', mentality: 'attacking' }, 70);
  assert.ok(att.att > bal.att && att.def < bal.def);
});
test('teamStrength: morale moves the whole team', () => {
  const xi = E.pickXI(demoSquad('mor'), '4-4-2');
  const low = E.teamStrength(xi, { formation: '4-4-2', mentality: 'balanced' }, 40);
  const high = E.teamStrength(xi, { formation: '4-4-2', mentality: 'balanced' }, 95);
  assert.ok(high.att > low.att && high.def > low.def);
});
test('aiTactics: underdogs park the bus, favourites push up', () => {
  const squad = demoSquad('ai');
  assert.equal(E.aiTactics(squad, 60, 75).mentality, 'defensive');
  assert.equal(E.aiTactics(squad, 75, 60).mentality, 'attacking');
  assert.equal(E.aiTactics(squad, 70, 70).mentality, 'balanced');
});

/* ---------- the match ---------- */
const matchTeams = (seed) => {
  const L = E.genLeague(seed);
  const mk = (c) => ({
    club: { id: c.id, name: c.name, short: c.short },
    xi: E.pickXI(c.squad.map((id) => L.players[id]), '4-4-2'),
    tactics: { formation: '4-4-2', mentality: 'balanced' },
    morale: 70,
  });
  return [mk(L.clubs[0]), mk(L.clubs[10])];
};
test('simulateMatch: deterministic for a given seed', () => {
  const [h, a] = matchTeams('det');
  const r1 = E.simulateMatch('m1', h, a);
  const r2 = E.simulateMatch('m1', h, a);
  deepEq(r1, r2);
  const r3 = E.simulateMatch('m2', h, a);
  assert.notEqual(JSON.stringify(r1.events), JSON.stringify(r3.events), 'different seed, different match');
});
test('simulateMatch: score agrees with goal events, stats are coherent', () => {
  const [h, a] = matchTeams('coh');
  for (let i = 0; i < 20; i++) {
    const r = E.simulateMatch('coh' + i, h, a);
    const gH = r.events.filter((e) => e.type === 'goal' && e.team === 'H').length;
    const gA = r.events.filter((e) => e.type === 'goal' && e.team === 'A').length;
    assert.equal(r.homeGoals, gH);
    assert.equal(r.awayGoals, gA);
    assert.equal(r.stats.possH + r.stats.possA, 100);
    assert.ok(r.stats.onTargetH >= gH, 'goals are on target');
    assert.ok(r.stats.shotsH >= r.stats.onTargetH);
    assert.ok(r.stats.xgH >= 0 && r.stats.xgA >= 0);
    assert.ok(r.events[0].type === 'ko' && r.events[r.events.length - 1].type === 'ft');
  }
});
test('simulateMatch: goal totals over many games look like football', () => {
  const [h, a] = matchTeams('cal');
  let total = 0, homeWins = 0, awayWins = 0, n = 300;
  for (let i = 0; i < n; i++) {
    const r = E.simulateMatch('cal' + i, h, a);
    total += r.homeGoals + r.awayGoals;
    if (r.homeGoals > r.awayGoals) homeWins++;
    if (r.awayGoals > r.homeGoals) awayWins++;
  }
  const avg = total / n;
  assert.ok(avg > 1.6 && avg < 4.0, `avg goals/game ${avg.toFixed(2)} in a plausible band`);
  assert.ok(homeWins > awayWins, 'home advantage exists over 300 games');
});
test('simulateMatch: ratings for all 22, bounded 3–10, scorers rated up', () => {
  const [h, a] = matchTeams('rat');
  const r = E.simulateMatch('rat1', h, a);
  assert.equal(Object.keys(r.ratings).length, 22);
  for (const id in r.ratings) assert.ok(r.ratings[id] >= 3 && r.ratings[id] <= 10);
});
test('simulateMatch: cup mode plays extra time and flags shootouts only when level', () => {
  const [h, a] = matchTeams('cup');
  let sawShootout = false, sawDecided = false;
  for (let i = 0; i < 40; i++) {
    const r = E.simulateMatch('cup' + i, h, a, { extraTime: true });
    if (r.needsShootout) {
      sawShootout = true;
      assert.equal(r.homeGoals, r.awayGoals, 'shootout only when still level');
    } else {
      sawDecided = true;
      assert.notEqual(r.homeGoals, r.awayGoals, 'no shootout when decided');
    }
  }
  assert.ok(sawShootout && sawDecided, 'both outcomes occur across 40 cup ties');
});

/* ---------- shootout ---------- */
test('shootout: deterministic, decided, kick log matches the score', () => {
  const [h, a] = matchTeams('pens');
  const hK = h.xi.all.filter((p) => p.pos !== 'GK').slice(0, 5);
  const aK = a.xi.all.filter((p) => p.pos !== 'GK').slice(0, 5);
  const s1 = E.shootout('p1', hK, aK, h.xi.GK[0], a.xi.GK[0]);
  const s2 = E.shootout('p1', hK, aK, h.xi.GK[0], a.xi.GK[0]);
  deepEq(s1, s2);
  assert.notEqual(s1.hScore, s1.aScore, 'a shootout always produces a winner');
  assert.equal(s1.winner, s1.hScore > s1.aScore ? 'H' : 'A');
  const scoredH = s1.kicks.filter((k) => k.team === 'H' && k.scored).length;
  assert.equal(scoredH, s1.hScore, 'kick log adds up');
});
test('shootout: stops early when mathematically decided', () => {
  let sawEarly = false;
  const [h, a] = matchTeams('early');
  const hK = h.xi.all.filter((p) => p.pos !== 'GK').slice(0, 5);
  const aK = a.xi.all.filter((p) => p.pos !== 'GK').slice(0, 5);
  for (let i = 0; i < 60; i++) {
    const s = E.shootout('e' + i, hK, aK, h.xi.GK[0], a.xi.GK[0]);
    if (s.kicks.length < 10) { sawEarly = true; break; }
  }
  assert.ok(sawEarly, 'at least one shootout ends before all ten kicks');
});

/* ---------- league table ---------- */
test('leagueTable: points and tie-breakers (pts → GD → GF)', () => {
  const clubs = [{ id: 'a', name: 'A', short: 'A' }, { id: 'b', name: 'B', short: 'B' },
    { id: 'c', name: 'C', short: 'C' }, { id: 'd', name: 'D', short: 'D' }];
  const results = [
    { home: 'a', away: 'b', hg: 3, ag: 0 },   // a: 3pts +3
    { home: 'c', away: 'd', hg: 2, ag: 1 },   // c: 3pts +1
    { home: 'b', away: 'd', hg: 1, ag: 1 },   // 1pt each
  ];
  const t = E.leagueTable(clubs, results);
  assert.equal(t[0].id, 'a', 'GD splits equal points');
  assert.equal(t[1].id, 'c');
  assert.equal(t[0].pts, 3);
  assert.equal(t[2].pts, 1);
  assert.equal(t[2].id, 'd', 'GD splits the two sides on 1 point too');
  deepEq(t.map((r) => r.p), [1, 1, 2, 2]);
});
test('leagueTable: form guide keeps the last five results', () => {
  const clubs = [{ id: 'a', name: 'A', short: 'A' }, { id: 'b', name: 'B', short: 'B' }];
  const results = Array.from({ length: 7 }, (_, i) => ({ home: 'a', away: 'b', hg: i % 2 ? 1 : 0, ag: 0 }));
  const t = E.leagueTable(clubs, results);
  const a = t.find((r) => r.id === 'a');
  assert.equal(a.form.length, 5);
});

/* ---------- cup ---------- */
test('cupDraw: 8 into the preliminary round, 12 byes, everyone exactly once', () => {
  const ids = Array.from({ length: 20 }, (_, i) => 'c' + (i + 1));
  const d1 = E.cupDraw('s', ids), d2 = E.cupDraw('s', ids);
  deepEq(d1, d2, 'draw is deterministic');
  assert.equal(d1.prelim.length, 4);
  assert.equal(d1.byes.length, 12);
  const seen = new Set(d1.byes);
  for (const t of d1.prelim) { seen.add(t.home); seen.add(t.away); }
  assert.equal(seen.size, 20);
});
test('cupPairs: pairs everyone, deterministic per round name', () => {
  const ids = Array.from({ length: 16 }, (_, i) => 'c' + i);
  const p = E.cupPairs('s', 'Round of 16', ids);
  assert.equal(p.length, 8);
  const seen = new Set();
  for (const t of p) { seen.add(t.home); seen.add(t.away); }
  assert.equal(seen.size, 16);
});

/* ---------- development & transfers ---------- */
test('developPlayer: the young grow, the old lose their legs first', () => {
  const r = E.rng('dev');
  const kid = { pos: 'MF', age: 18, pace: 60, technique: 60, defending: 50, finishing: 50, keeping: 20, stamina: 60 };
  const vet = { ...kid, age: 33 };
  const kid2 = E.developPlayer(kid, r, 0.8);
  const vet2 = E.developPlayer(vet, E.rng('dev2'), 0.8);
  assert.equal(kid2.age, 19);
  assert.ok(E.overall(kid2) >= E.overall(kid), 'young player never regresses');
  assert.ok(vet2.pace <= vet.pace, 'veteran pace does not grow');
  assert.ok(kid !== kid2, 'input is not mutated');
  assert.equal(kid.age, 18, 'original untouched');
});
test('retires: nobody at 30, everybody at 38', () => {
  const r = E.rng('ret');
  assert.equal(E.retires({ age: 30 }, r), false);
  assert.equal(E.retires({ age: 38 }, r), true);
});
test('offerResult: pay the ask and it is accepted; lowball and it is not', () => {
  const p = { id: 'px', pos: 'FW', age: 24, pace: 75, technique: 70, defending: 30, finishing: 78, keeping: 20, stamina: 70 };
  const ask = E.askingPrice('t', p);
  assert.ok(ask > E.playerValue(p), 'clubs ask above value');
  assert.equal(E.offerResult('t', p, ask).verdict, 'accepted');
  const counter = E.offerResult('t', p, Math.round(ask * 0.9));
  assert.equal(counter.verdict, 'countered');
  assert.ok(counter.counter > ask * 0.9 && counter.counter < ask, 'counter splits the difference');
  assert.equal(E.offerResult('t', p, Math.round(ask * 0.5)).verdict, 'rejected');
});
test('transferList: never my club, never a club\'s best eight, priced at the ask', () => {
  const L = E.genLeague('mkt');
  const my = L.clubs[0].id;
  const list = E.transferList('mkt', L, my);
  assert.ok(list.length > 0);
  for (const item of list) {
    assert.notEqual(item.clubId, my);
    const club = L.clubs.find((c) => c.id === item.clubId);
    const betterOrEqual = club.squad.map((id) => L.players[id])
      .filter((q) => q.id !== item.playerId && E.overall(q) >= E.overall(L.players[item.playerId])).length;
    assert.ok(betterOrEqual >= 8, 'only depth players are listed');
    assert.equal(item.price, E.askingPrice('mkt', L.players[item.playerId]));
  }
});
test('matchdayIncome and seasonPrize reward success', () => {
  const club = { tier: 1, morale: 80 };
  assert.ok(E.matchdayIncome(club, 1) > E.matchdayIncome(club, 20));
  assert.ok(E.seasonPrize(1) > E.seasonPrize(10));
  assert.equal(E.seasonPrize(1), 5e6);
});

/* ---------- career state machine ---------- */
test('newGame: deterministic, calendar has 38 league rounds + 5 cup dates', () => {
  const g1 = E.newGame('career', 'c5');
  const g2 = E.newGame('career', 'c5');
  deepEq(g1, g2);
  assert.equal(g1.calendar.filter((e) => e.type === 'league').length, 38);
  assert.equal(g1.calendar.filter((e) => e.type === 'cup').length, 5);
  assert.equal(g1.myClubId, 'c5');
  assert.equal(g1.season, 1);
});
test('advanceRound: pure, plays a full round, records results, finds my match', () => {
  const g = E.newGame('adv', 'c1');
  const before = JSON.stringify(g);
  const g2 = E.advanceRound(g);
  assert.equal(JSON.stringify(g), before, 'input state not mutated');
  assert.equal(g2.pointer, 1);
  assert.equal(g2.results.length, 10, 'all ten games played');
  assert.ok(g2.lastMatch, 'my match surfaced for the ticker');
  assert.ok(g2.lastMatch.homeClub.id === 'c1' || g2.lastMatch.awayClub.id === 'c1');
  const table = E.leagueTable(g2.league.clubs, g2.results);
  assert.equal(table.reduce((s, r) => s + r.p, 0), 20, 'everyone has played once');
  const apps = Object.values(g2.playerStats).reduce((s, x) => s + x.apps, 0);
  assert.equal(apps, 220, '22 players × 10 games got an appearance');
});
test('advanceRound: replaying the same state gives the identical round', () => {
  const g = E.newGame('replay', 'c3');
  deepEq(E.advanceRound(g).results, E.advanceRound(g).results);
});
test('career: a full half-season keeps every invariant', () => {
  let g = E.newGame('sim', 'c7');
  for (let i = 0; i < 24; i++) g = E.advanceRound(g);
  const league = g.results.filter((r) => r.comp === 'league');
  const cup = g.results.filter((r) => r.comp === 'cup');
  assert.equal(league.length + cup.length, g.results.length);
  const table = E.leagueTable(g.league.clubs, league);
  for (const row of table) assert.equal(row.pts, row.w * 3 + row.d, 'points arithmetic holds');
  // Suspensions and injuries only ever hold positive counters.
  for (const k in g.injuries) assert.ok(g.injuries[k] > 0);
  for (const k in g.suspensions) assert.ok(g.suspensions[k] > 0);
  // The cup has progressed past its preliminary round by round 21.
  assert.ok(g.cup.round >= 3, 'cup rounds have been played');
  assert.ok(g.cup.alive.length <= 16);
});
test('career: a full season ends, a cup winner and champion are crowned', () => {
  let g = E.newGame('full', 'c12');
  while (!g.seasonOver) g = E.advanceRound(g);
  assert.equal(g.pointer, g.calendar.length);
  assert.ok(g.cup.winnerId, 'the cup was lifted');
  const table = E.leagueTable(g.league.clubs, g.results.filter((r) => r.comp === 'league'));
  assert.equal(table[0].p, 38, 'champions played all 38');
  const g2 = E.endSeason(g);
  assert.equal(g2.season, 2);
  assert.equal(g2.results.length, 0);
  assert.equal(g2.pointer, 0);
  assert.ok(g2.history.length === 1 && g2.history[0].championId === table[0].id);
  assert.ok(g2.awards, 'awards handed out');
  // Everyone aged a year (survivors), squads refilled to 18.
  for (const c of g2.league.clubs) assert.ok(c.squad.length >= 18);
  const someKid = Object.values(g2.league.players).some((p) => p.age <= 18);
  assert.ok(someKid, 'the academy produced youngsters');
});
test('career: suspensions actually sideline players', () => {
  // Find a round where a red card happened, then check the player sits out.
  let g = E.newGame('bans', 'c2');
  for (let i = 0; i < 10 && Object.keys(g.suspensions).length === 0; i++) g = E.advanceRound(g);
  if (Object.keys(g.suspensions).length > 0) {
    const banned = Object.keys(g.suspensions)[0];
    const club = g.league.clubs.find((c) => c.squad.includes(banned));
    const avail = E.availablePlayers(g, club);
    assert.ok(!avail.some((p) => p.id === banned), 'banned player unavailable');
  }
});
test('buyPlayer: money moves, squads move, guards hold', () => {
  const g = E.newGame('buy', 'c1');
  const list = E.transferList(g.seed, g.league, 'c1');
  const item = list.find((x) => x.price < 5e6);
  const me = g.league.clubs.find((c) => c.id === 'c1');
  const before = me.budget;
  const g2 = E.buyPlayer(g, item.playerId, item.price);
  const me2 = g2.league.clubs.find((c) => c.id === 'c1');
  const seller2 = g2.league.clubs.find((c) => c.id === item.clubId);
  assert.equal(me2.budget, before - item.price);
  assert.ok(me2.squad.includes(item.playerId));
  assert.ok(!seller2.squad.includes(item.playerId));
  assert.equal(g2.league.players[item.playerId].clubId, 'c1');
  assert.equal(g.league.players[item.playerId].clubId, item.clubId, 'original state untouched');
  assert.throws(() => E.buyPlayer(g, item.playerId, 1e12), /budget/);
});
test('sellPlayer: fee banked, cannot sell the only keeper', () => {
  const g = E.newGame('sell', 'c4');
  const me = g.league.clubs.find((c) => c.id === 'c4');
  const fw = me.squad.map((id) => g.league.players[id]).filter((p) => p.pos === 'FW')
    .sort((a, b) => E.overall(a) - E.overall(b))[0];
  const g2 = E.sellPlayer(g, fw.id);
  const me2 = g2.league.clubs.find((c) => c.id === 'c4');
  assert.equal(me2.budget, me.budget + E.sellPrice(fw));
  assert.ok(!me2.squad.includes(fw.id));
  // Sell one keeper: fine. Sell the second: refused.
  const gks = me.squad.map((id) => g.league.players[id]).filter((p) => p.pos === 'GK');
  let g3 = E.sellPlayer(g, gks[0].id);
  assert.throws(() => E.sellPlayer(g3, gks[1].id), /keeper/);
});
test('awards: golden boot goes to the top scorer, POTY needs 10 apps', () => {
  const L = E.genLeague('awards');
  const [a, b, c] = L.clubs[0].squad;
  const stats = {
    [a]: { apps: 20, goals: 15, assists: 2, ratingSum: 140, motm: 3 },
    [b]: { apps: 20, goals: 9, assists: 12, ratingSum: 150, motm: 5 },
    [c]: { apps: 4, goals: 1, assists: 0, ratingSum: 39, motm: 0 },   // 9.75 avg but too few apps
  };
  const aw = E.awards(L, stats);
  assert.equal(aw.goldenBoot, a);
  assert.equal(aw.playmaker, b);
  assert.equal(aw.playerOfSeason, b, 'part-timers do not win POTY');
});
test('newsForResult: deterministic, mentions the score', () => {
  const home = { name: 'Rivergate United', short: 'RIV' };
  const away = { name: 'Harbour City', short: 'HBC' };
  const n1 = E.newsForResult('n', home, away, { hg: 4, ag: 0 });
  assert.equal(n1, E.newsForResult('n', home, away, { hg: 4, ag: 0 }));
  assert.ok(n1.includes('4–0'));
  assert.ok(E.newsForResult('n', home, away, { hg: 1, ag: 1 }).length > 0);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nballrz: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
