/* Ballrz — the pure football engine.
 * =================================================================
 * The repo is named after this app. Every rule of the game lives here —
 * squad generation, fixtures, tactics, the minute-by-minute match
 * simulation, league table maths, cup draws, penalty shootouts, player
 * development, transfers, finances, awards and the news feed — as pure,
 * deterministic, seeded functions with zero DOM and zero I/O, so the
 * whole career mode is unit-testable (scripts/test-ballrz-logic.mjs)
 * and replayable: the same seed always produces the same universe.
 * index.html is just the stadium; this file is the sport.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  /* ---------------- deterministic hashing / seeded randomness ---------------- */

  // FNV-1a 32-bit — stable across platforms, good spread for short strings.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // mulberry32 — a tiny, high-quality 32-bit PRNG. Seeded from any string.
  function rng(seed) {
    var a = hashStr(seed) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
  function shuffle(r, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function round1(x) { return Math.round(x * 10) / 10; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtMoney(n) {
    n = Math.round(n || 0);
    var sign = n < 0 ? '-' : ''; n = Math.abs(n);
    if (n >= 1e6) return sign + '£' + (Math.round(n / 1e5) / 10) + 'm';
    if (n >= 1e3) return sign + '£' + Math.round(n / 1e3) + 'k';
    return sign + '£' + n;
  }

  /* ---------------- the football universe: clubs & people ---------------- */

  // The real 20 — the 2025–26 English top flight, with each club's colours.
  // Tier reflects rough squad strength: 1 = title contenders … 4 = scrappers.
  var CLUBS = [
    { name: 'Arsenal',            short: 'ARS', color: '#EF0107', color2: '#8f0005', tier: 1 },
    { name: 'Aston Villa',        short: 'AVL', color: '#670E36', color2: '#95BFE5', tier: 2 },
    { name: 'Bournemouth',        short: 'BOU', color: '#DA291C', color2: '#231F20', tier: 3 },
    { name: 'Brentford',          short: 'BRE', color: '#E30613', color2: '#8f040c', tier: 3 },
    { name: 'Brighton',           short: 'BHA', color: '#0057B8', color2: '#003b7d', tier: 2 },
    { name: 'Burnley',            short: 'BUR', color: '#6C1D45', color2: '#99D6EA', tier: 4 },
    { name: 'Chelsea',            short: 'CHE', color: '#034694', color2: '#022c5e', tier: 1 },
    { name: 'Crystal Palace',     short: 'CRY', color: '#1B458F', color2: '#C4122E', tier: 2 },
    { name: 'Everton',            short: 'EVE', color: '#003399', color2: '#00226b', tier: 3 },
    { name: 'Fulham',             short: 'FUL', color: '#9a9aa2', color2: '#1a1a1a', tier: 3 },
    { name: 'Leeds United',       short: 'LEE', color: '#FFCD00', color2: '#1D428A', tier: 4 },
    { name: 'Liverpool',          short: 'LIV', color: '#C8102E', color2: '#7d0a1d', tier: 1 },
    { name: 'Manchester City',    short: 'MCI', color: '#6CABDD', color2: '#2f6f9e', tier: 1 },
    { name: 'Manchester United',  short: 'MUN', color: '#DA291C', color2: '#8f1a12', tier: 2 },
    { name: 'Newcastle United',   short: 'NEW', color: '#4a5056', color2: '#241F20', tier: 2 },
    { name: 'Nottingham Forest',  short: 'NFO', color: '#DD0000', color2: '#8b0000', tier: 3 },
    { name: 'Sunderland',         short: 'SUN', color: '#EB172B', color2: '#8f0e1a', tier: 4 },
    { name: 'Tottenham Hotspur',  short: 'TOT', color: '#132257', color2: '#3d56a8', tier: 2 },
    { name: 'West Ham United',    short: 'WHU', color: '#7A263A', color2: '#1BB1E7', tier: 3 },
    { name: 'Wolves',             short: 'WOL', color: '#FDB913', color2: '#a67608', tier: 4 },
  ];

  var FIRST = ['Marcus','Leo','Kai','Jude','Theo','Mason','Ethan','Noah','Luka','Mateo',
    'Diego','Rafael','Andres','Thiago','Bruno','Pedro','Joao','Yusuf','Omar','Karim',
    'Amir','Idris','Kofi','Kwame','Sekou','Moussa','Youssef','Emeka','Chidi','Tunde',
    'Sven','Lars','Erik','Nils','Henrik','Jan','Pavel','Milan','Luca','Marco',
    'Enzo','Hugo','Antoine','Jules','Louis','Ken','Hiro','Takumi','Minjun','Jiho',
    'Arjun','Ravi','Dev','Santiago','Nico','Gabriel','Samuel','Daniel','David','Adam'];

  var LAST = ['Silva','Santos','Costa','Pereira','Rodriguez','Garcia','Fernandez','Martinez','Lopez','Gonzalez',
    'Hernandez','Rossi','Ricci','Moretti','Conti','Bianchi','Muller','Schmidt','Weber','Fischer',
    'Wagner','Novak','Kovac','Horvath','Dvorak','Johnson','Smith','Brown','Wilson','Taylor',
    'Walker','Wright','Robinson','Clarke','Hall','Adeyemi','Okafor','Mensah','Diallo','Traore',
    'Keita','Ndiaye','Toure','Sow','Haddad','Mansour','Rahman','Hossain','Khan','Patel',
    'Sharma','Singh','Kim','Park','Sato','Tanaka','Nakamura','Yamamoto','Andersen','Larsen',
    'Nilsson','Berg','Virtanen','Kowalski','Nowak','Ivanov','Petrov','Popescu','Dimitrov','Laurent'];

  var POSITIONS = ['GK', 'DF', 'MF', 'FW'];
  var SQUAD_SHAPE = { GK: 2, DF: 6, MF: 6, FW: 4 };   // 18 players per squad

  var FORMATIONS = {
    '4-4-2':   { DF: 4, MF: 4, FW: 2, att: 1.00, def: 1.00 },
    '4-3-3':   { DF: 4, MF: 3, FW: 3, att: 1.08, def: 0.95 },
    '3-5-2':   { DF: 3, MF: 5, FW: 2, att: 1.04, def: 0.93 },
    '4-2-3-1': { DF: 4, MF: 5, FW: 1, att: 0.97, def: 1.05 },
    '5-4-1':   { DF: 5, MF: 4, FW: 1, att: 0.86, def: 1.14 },
  };

  var MENTALITIES = {
    defensive: { att: 0.88, def: 1.12 },
    balanced:  { att: 1.00, def: 1.00 },
    attacking: { att: 1.12, def: 0.90 },
  };

  var TIER_BASE = { 1: 74, 2: 68, 3: 62, 4: 56 };
  var TIER_BUDGET = { 1: 20e6, 2: 12e6, 3: 7e6, 4: 4e6 };

  // Overall is position-weighted: a striker is his finishing, a keeper his hands.
  var OVR_W = {
    GK: { keeping: 0.70, defending: 0.10, pace: 0.05, technique: 0.05, finishing: 0.00, stamina: 0.10 },
    DF: { keeping: 0.00, defending: 0.50, pace: 0.20, technique: 0.15, finishing: 0.00, stamina: 0.15 },
    MF: { keeping: 0.00, defending: 0.15, pace: 0.20, technique: 0.45, finishing: 0.05, stamina: 0.15 },
    FW: { keeping: 0.00, defending: 0.00, pace: 0.25, technique: 0.20, finishing: 0.50, stamina: 0.05 },
  };
  var ATTRS = ['pace', 'technique', 'defending', 'finishing', 'keeping', 'stamina'];

  function overall(p) {
    var w = OVR_W[p.pos], sum = 0;
    for (var i = 0; i < ATTRS.length; i++) sum += (p[ATTRS[i]] || 0) * w[ATTRS[i]];
    return Math.round(sum);
  }

  // Transfer value: quality squared, peaking in the mid-20s, forwards at a premium.
  function playerValue(p) {
    var ovr = overall(p);
    var base = Math.pow(Math.max(1, ovr - 40), 2) * 1200;
    var age = p.age;
    var ageMul = age <= 21 ? 1.30 : age <= 24 ? 1.18 : age <= 27 ? 1.05
      : age <= 29 ? 0.92 : age <= 31 ? 0.72 : age <= 33 ? 0.48 : 0.28;
    var posMul = p.pos === 'FW' ? 1.20 : p.pos === 'MF' ? 1.10 : p.pos === 'DF' ? 1.00 : 0.90;
    return Math.max(25000, Math.round(base * ageMul * posMul / 25000) * 25000);
  }

  function genPlayer(r, pos, tier, boost) {
    var base = TIER_BASE[tier] + (boost || 0);
    var p = {
      name: pick(r, FIRST) + ' ' + pick(r, LAST),
      pos: pos,
      age: 17 + Math.floor(Math.pow(r(), 0.9) * 18),   // 17–34, skewed young
    };
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var v = base + (r() * 2 - 1) * 12;
      // Off-position attributes sag: keepers can't finish, strikers don't tackle.
      if (a === 'keeping' && pos !== 'GK') v = 20 + r() * 15;
      if (a === 'finishing' && pos === 'GK') v = 15 + r() * 10;
      if (a === 'finishing' && pos === 'DF') v = v - 18;
      if (a === 'defending' && pos === 'FW') v = v - 18;
      if (a === 'defending' && pos === 'GK') v = v - 20;
      p[a] = Math.round(clamp(v, 20, 96));
    }
    return p;
  }

  // The whole league: 20 clubs, 360 players, one seed.
  function genLeague(seed) {
    var clubs = [], players = {}, nextId = 1;
    for (var c = 0; c < CLUBS.length; c++) {
      var t = CLUBS[c];
      var r = rng(seed + ':club:' + t.short);
      var squad = [];
      var stars = 1 + Math.floor(r() * 2);   // 1–2 stars per squad
      var made = 0;
      for (var pi = 0; pi < POSITIONS.length; pi++) {
        var pos = POSITIONS[pi], n = SQUAD_SHAPE[pos];
        for (var k = 0; k < n; k++) {
          var boost = (made < stars && pos !== 'GK' && k === 0) ? 8 : 0;
          if (boost) made++;
          var pl = genPlayer(r, pos, t.tier, boost);
          pl.id = 'p' + (nextId++);
          pl.clubId = 'c' + (c + 1);
          players[pl.id] = pl;
          squad.push(pl.id);
        }
      }
      clubs.push({
        id: 'c' + (c + 1), name: t.name, short: t.short, color: t.color,
        color2: t.color2, tier: t.tier, morale: 70, squad: squad,
        budget: TIER_BUDGET[t.tier],
      });
    }
    return { clubs: clubs, players: players };
  }

  /* ---------------- fixtures: double round-robin (Berger tables) ---------------- */

  function fixtures(teamIds) {
    var ids = teamIds.slice();
    var n = ids.length;
    if (n % 2 !== 0) throw new Error('need an even number of teams');
    var rounds = [];
    var half = [];
    var rot = ids.slice(1);
    for (var rd = 0; rd < n - 1; rd++) {
      var games = [];
      var left = [ids[0]].concat(rot.slice(0, n / 2 - 1));
      var right = rot.slice(n / 2 - 1).reverse();
      for (var i = 0; i < n / 2; i++) {
        // Alternate the fixed team's venue so nobody plays 19 straight at home.
        if (i === 0 && rd % 2 === 1) games.push({ home: right[i], away: left[i] });
        else games.push({ home: left[i], away: right[i] });
      }
      half.push(games);
      rot.push(rot.shift());
    }
    for (var a = 0; a < half.length; a++) rounds.push(half[a]);
    for (var b = 0; b < half.length; b++) {
      rounds.push(half[b].map(function (g) { return { home: g.away, away: g.home }; }));
    }
    return rounds;
  }

  /* ---------------- lineups & team strength ---------------- */

  // Best XI for a formation from the available players (injured/banned excluded
  // by the caller). Falls back to best-overall bodies when a position runs dry.
  function pickXI(players, formation) {
    var shape = FORMATIONS[formation] || FORMATIONS['4-4-2'];
    var byPos = { GK: [], DF: [], MF: [], FW: [] };
    for (var i = 0; i < players.length; i++) byPos[players[i].pos].push(players[i]);
    for (var pos in byPos) byPos[pos].sort(function (a, b) { return overall(b) - overall(a); });
    var xi = { GK: [], DF: [], MF: [], FW: [] };
    var used = {};
    var want = { GK: 1, DF: shape.DF, MF: shape.MF, FW: shape.FW };
    for (var pp in want) {
      for (var k = 0; k < want[pp] && k < byPos[pp].length; k++) {
        xi[pp].push(byPos[pp][k]); used[byPos[pp][k].id] = 1;
      }
    }
    var all = xi.GK.concat(xi.DF, xi.MF, xi.FW);
    if (all.length < 11) {
      var rest = players.filter(function (p) { return !used[p.id]; })
        .sort(function (a, b) { return overall(b) - overall(a); });
      for (var m = 0; m < rest.length && all.length < 11; m++) {
        xi[rest[m].pos === 'GK' ? 'MF' : rest[m].pos].push(rest[m]);
        all.push(rest[m]);
      }
    }
    xi.all = all;
    return xi;
  }

  function avg(arr, f) {
    if (!arr.length) return 0;
    var s = 0; for (var i = 0; i < arr.length; i++) s += f(arr[i]);
    return s / arr.length;
  }

  // Attack / midfield / defence numbers the simulator runs on.
  function teamStrength(xi, tactics, morale) {
    var shape = FORMATIONS[tactics.formation] || FORMATIONS['4-4-2'];
    var ment = MENTALITIES[tactics.mentality] || MENTALITIES.balanced;
    var attackers = xi.FW.concat(xi.MF);
    var att = avg(attackers, function (p) {
      return p.pos === 'FW'
        ? p.finishing * 0.60 + p.pace * 0.25 + p.technique * 0.15
        : p.technique * 0.50 + p.pace * 0.28 + p.finishing * 0.22;
    });
    var def = avg(xi.DF, function (p) { return p.defending * 0.70 + p.pace * 0.30; }) * 0.65
            + avg(xi.GK, function (p) { return p.keeping; }) * 0.35;
    var mid = avg(xi.MF, function (p) { return p.technique * 0.7 + p.stamina * 0.3; });
    var mMul = 0.92 + (morale == null ? 70 : morale) / 500;   // 0.92–1.11
    return {
      att: att * shape.att * ment.att * mMul,
      def: def * shape.def * ment.def * mMul,
      mid: mid * mMul,
      stamina: avg(xi.all, function (p) { return p.stamina; }),
    };
  }

  // AI managers pick sensible tactics: shape from their squad, mood from the gap.
  function aiTactics(availablePlayers, ownRating, oppRating) {
    var counts = { DF: 0, MF: 0, FW: 0 };
    for (var i = 0; i < availablePlayers.length; i++) {
      if (counts[availablePlayers[i].pos] != null) counts[availablePlayers[i].pos]++;
    }
    var formation = counts.FW >= 4 ? '4-3-3' : counts.MF >= 6 ? '3-5-2'
      : counts.DF >= 6 ? '5-4-1' : '4-4-2';
    var mentality = ownRating > oppRating + 5 ? 'attacking'
      : ownRating < oppRating - 5 ? 'defensive' : 'balanced';
    return { formation: formation, mentality: mentality };
  }

  /* ---------------- the match: minute by minute, one seed ---------------- */

  var CHANCE_TEXT = [
    '{P} slices through the middle — {G} smothers it!',
    '{P} lets fly from 25 yards, tipped over by {G}!',
    '{P} is clean through… {G} stands tall and wins it!',
    'header from {P} — clawed off the line by {G}!',
    '{P} cuts inside and curls one — {G} at full stretch!',
  ];
  var MISS_TEXT = [
    '{P} blazes it over from a great position.',
    '{P} drags the shot inches wide of the post.',
    '{P} scuffs the finish with the goal gaping.',
  ];
  var POST_TEXT = [
    '{P} rattles the crossbar — so close!',
    '{P} thumps the post, the stadium gasps.',
  ];
  var GOAL_TEXT = [
    'GOAL! {P} buries it into the bottom corner!',
    'GOAL! {P} finishes a flowing move{A}!',
    'GOAL! {P} rises highest and heads it home{A}!',
    'GOAL! {P} lashes it into the roof of the net!',
    'GOAL! {P} slots it past the keeper, ice cold{A}!',
  ];

  function fill(t, p, extra) {
    return t.replace('{P}', p).replace('{G}', extra && extra.gk || 'the keeper')
      .replace('{A}', extra && extra.assist ? ', teed up by ' + extra.assist : '');
  }

  // Weighted scorer pick: strikers feast, defenders nick one at a corner.
  function pickScorer(r, xi) {
    var pool = [];
    for (var i = 0; i < xi.all.length; i++) {
      var p = xi.all[i];
      var w = p.pos === 'FW' ? 12 : p.pos === 'MF' ? 6 : p.pos === 'DF' ? 1.5 : 0;
      w *= 0.5 + p.finishing / 100;
      pool.push([p, w]);
    }
    var total = 0, j;
    for (j = 0; j < pool.length; j++) total += pool[j][1];
    var x = r() * total;
    for (j = 0; j < pool.length; j++) { x -= pool[j][1]; if (x <= 0) return pool[j][0]; }
    return pool[pool.length - 1][0];
  }

  /**
   * simulateMatch(seed, home, away, opts)
   * home/away: { club:{id,name,short}, xi, tactics, morale }
   * opts: { extraTime: true } for cup ties that must produce a winner.
   * Fully deterministic for a given seed. Returns score, a ticker-ready
   * event list, match stats (xG, shots, possession, cards), player
   * ratings, injuries and (in cup mode) whether pens are needed.
   */
  function simulateMatch(seed, home, away, opts) {
    opts = opts || {};
    var r = rng(seed);
    var H = teamStrength(home.xi, home.tactics, home.morale);
    var A = teamStrength(away.xi, away.tactics, away.morale);
    H.att *= 1.06; H.mid *= 1.04;   // home advantage
    var events = [], goals = { H: 0, A: 0 };
    var stats = {
      H: { shots: 0, onTarget: 0, xg: 0, fouls: 0, yellows: 0, reds: 0 },
      A: { shots: 0, onTarget: 0, xg: 0, fouls: 0, yellows: 0, reds: 0 },
    };
    var ratings = {}, injuries = [], sentOff = { H: 0, A: 0 };
    var i, p;
    for (i = 0; i < home.xi.all.length; i++) ratings[home.xi.all[i].id] = 6.0;
    for (i = 0; i < away.xi.all.length; i++) ratings[away.xi.all[i].id] = 6.0;

    var possH = clamp(Math.round(100 * Math.pow(H.mid, 1.3) / (Math.pow(H.mid, 1.3) + Math.pow(A.mid, 1.3))), 32, 68);

    function attemptFor(side, minute) {
      var atk = side === 'H' ? home : away, dfd = side === 'H' ? away : home;
      var S = side === 'H' ? H : A, D = side === 'H' ? A : H;
      var st = stats[side];
      var scorer = pickScorer(r, atk.xi);
      var gk = dfd.xi.GK[0];
      var gkName = gk ? gk.name : 'the keeper';
      st.shots++;
      var pGoal = clamp(0.30 + (scorer.finishing - (gk ? gk.keeping : 60)) * 0.004
        + (S.att - D.def) * 0.002, 0.10, 0.55);
      st.xg = Math.round((st.xg + pGoal) * 100) / 100;
      var roll = r();
      if (roll < pGoal) {
        goals[side]++;
        st.onTarget++;
        var assist = null;
        if (r() < 0.65) {
          var mates = atk.xi.all.filter(function (q) { return q.id !== scorer.id && q.pos !== 'GK'; });
          if (mates.length) assist = pick(r, mates);
        }
        ratings[scorer.id] += 1.0;
        if (assist) ratings[assist.id] += 0.5;
        if (gk) ratings[gk.id] -= 0.2;
        events.push({ min: minute, type: 'goal', team: side, playerId: scorer.id,
          assistId: assist ? assist.id : null, score: goals.H + '–' + goals.A,
          text: fill(pick(r, GOAL_TEXT), scorer.name, { assist: assist && assist.name }) });
      } else if (roll < pGoal + 0.30) {
        st.onTarget++;
        if (gk) ratings[gk.id] += 0.25;
        events.push({ min: minute, type: 'save', team: side, playerId: scorer.id,
          text: fill(pick(r, CHANCE_TEXT), scorer.name, { gk: gkName }) });
      } else if (roll < pGoal + 0.38) {
        events.push({ min: minute, type: 'post', team: side, playerId: scorer.id,
          text: fill(pick(r, POST_TEXT), scorer.name) });
      } else {
        events.push({ min: minute, type: 'miss', team: side, playerId: scorer.id,
          text: fill(pick(r, MISS_TEXT), scorer.name) });
      }
    }

    function discipline(side, minute) {
      var team = side === 'H' ? home : away;
      var st = stats[side];
      st.fouls++;
      var outfield = team.xi.all.filter(function (q) { return q.pos !== 'GK'; });
      var offender = pick(r, outfield);
      if (r() < 0.030 && sentOff[side] === 0) {   // straight red: rare, one per team max
        st.reds++; sentOff[side]++;
        ratings[offender.id] -= 1.5;
        events.push({ min: minute, type: 'red', team: side, playerId: offender.id,
          text: offender.name + ' sees RED — straight off, down to ten!' });
      } else if (r() < 0.24) {
        st.yellows++;
        ratings[offender.id] -= 0.3;
        events.push({ min: minute, type: 'yellow', team: side, playerId: offender.id,
          text: offender.name + ' goes into the book.' });
      }
      if (r() < 0.012) {
        var victim = pick(r, (side === 'H' ? away : home).xi.all);
        var out = 1 + Math.floor(r() * 4);
        injuries.push({ playerId: victim.id, matches: out });
        events.push({ min: minute, type: 'injury', team: side === 'H' ? 'A' : 'H',
          playerId: victim.id, text: victim.name + ' limps off injured (out ~' + out + ' games).' });
      }
    }

    function half(from, to, tired) {
      for (var minute = from; minute <= to; minute++) {
        var fatigue = tired ? 0.85 + (H.stamina + A.stamina) / 1200 : 1;
        var down = { H: sentOff.H ? 0.75 : 1, A: sentOff.A ? 0.75 : 1 };
        var pH = 0.055 * Math.pow(H.att / Math.max(1, A.def), 1.4) * fatigue * down.H;
        var pA = 0.047 * Math.pow(A.att / Math.max(1, H.def), 1.4) * fatigue * down.A;
        var roll = r();
        if (roll < pH) attemptFor('H', minute);
        else if (roll < pH + pA) attemptFor('A', minute);
        else if (roll < pH + pA + 0.10) discipline(r() < possH / 100 ? 'A' : 'H', minute);
      }
    }

    events.push({ min: 1, type: 'ko', text: 'We are underway at ' + home.club.name + '!' });
    half(1, 45, false);
    events.push({ min: 45, type: 'ht', score: goals.H + '–' + goals.A,
      text: 'Half-time: ' + home.club.short + ' ' + goals.H + '–' + goals.A + ' ' + away.club.short });
    half(46, 90, false);
    var needsShootout = false;
    if (opts.extraTime && goals.H === goals.A) {
      events.push({ min: 90, type: 'et', text: 'Level after 90 — extra time!' });
      half(91, 120, true);
      if (goals.H === goals.A) needsShootout = true;
    }
    events.push({ min: opts.extraTime && events.some(function (e) { return e.type === 'et'; }) ? 120 : 90,
      type: 'ft', score: goals.H + '–' + goals.A,
      text: 'Full-time: ' + home.club.short + ' ' + goals.H + '–' + goals.A + ' ' + away.club.short });

    // Result bumps: winners glow, losers sag; clean sheets flatter the back line.
    var winner = goals.H > goals.A ? 'H' : goals.A > goals.H ? 'A' : null;
    function bump(xi, delta) {
      for (var k = 0; k < xi.all.length; k++) ratings[xi.all[k].id] += delta;
    }
    if (winner === 'H') { bump(home.xi, 0.3); bump(away.xi, -0.3); }
    if (winner === 'A') { bump(away.xi, 0.3); bump(home.xi, -0.3); }
    if (goals.A === 0) home.xi.DF.concat(home.xi.GK).forEach(function (q) { ratings[q.id] += 0.3; });
    if (goals.H === 0) away.xi.DF.concat(away.xi.GK).forEach(function (q) { ratings[q.id] += 0.3; });
    for (var id in ratings) ratings[id] = round1(clamp(ratings[id], 3, 10));

    return {
      homeGoals: goals.H, awayGoals: goals.A, events: events,
      stats: { possH: possH, possA: 100 - possH,
        shotsH: stats.H.shots, shotsA: stats.A.shots,
        onTargetH: stats.H.onTarget, onTargetA: stats.A.onTarget,
        xgH: stats.H.xg, xgA: stats.A.xg,
        foulsH: stats.H.fouls, foulsA: stats.A.fouls,
        yellowsH: stats.H.yellows, yellowsA: stats.A.yellows,
        redsH: stats.H.reds, redsA: stats.A.reds },
      ratings: ratings, injuries: injuries, needsShootout: needsShootout,
    };
  }

  /* ---------------- penalty shootout ---------------- */

  // Best of five, then sudden death. Stops the moment it's decided.
  function shootout(seed, hKickers, aKickers, hGK, aGK) {
    var r = rng(seed);
    var kicks = [], score = { H: 0, A: 0 };
    function take(side, idx) {
      var kicker = side === 'H' ? hKickers[idx % hKickers.length] : aKickers[idx % aKickers.length];
      var gk = side === 'H' ? aGK : hGK;
      var p = clamp(0.74 + (kicker.technique - (gk ? gk.keeping : 60)) * 0.004, 0.50, 0.93);
      var scored = r() < p;
      if (scored) score[side]++;
      kicks.push({ team: side, playerId: kicker.id, name: kicker.name, scored: scored });
      return scored;
    }
    var round;
    for (round = 0; round < 5; round++) {
      take('H', round);
      // Unwinnable? stop — like the real thing.
      if (score.H > score.A + (5 - round - 1)) break;
      take('A', round);
      if (score.A > score.H + (5 - round - 1)) break;
      if (round === 4 && score.H !== score.A) break;
    }
    var sd = 5;
    while (score.H === score.A) {
      take('H', sd); take('A', sd); sd++;
      if (sd > 30) { score.H++; break; }   // theoretical guard; deterministic anyway
    }
    return { hScore: score.H, aScore: score.A, kicks: kicks,
      winner: score.H > score.A ? 'H' : 'A' };
  }

  /* ---------------- league table ---------------- */

  // Points, then goal difference, then goals for, then name — with a form guide.
  function leagueTable(clubs, results) {
    var rows = {};
    clubs.forEach(function (c) {
      rows[c.id] = { id: c.id, name: c.name, short: c.short, p: 0, w: 0, d: 0, l: 0,
        gf: 0, ga: 0, gd: 0, pts: 0, form: [] };
    });
    results.forEach(function (res) {
      var h = rows[res.home], a = rows[res.away];
      if (!h || !a) return;
      h.p++; a.p++;
      h.gf += res.hg; h.ga += res.ag; a.gf += res.ag; a.ga += res.hg;
      if (res.hg > res.ag) { h.w++; a.l++; h.pts += 3; h.form.push('W'); a.form.push('L'); }
      else if (res.hg < res.ag) { a.w++; h.l++; a.pts += 3; a.form.push('W'); h.form.push('L'); }
      else { h.d++; a.d++; h.pts++; a.pts++; h.form.push('D'); a.form.push('D'); }
    });
    var out = [];
    for (var id in rows) {
      rows[id].gd = rows[id].gf - rows[id].ga;
      rows[id].form = rows[id].form.slice(-5);
      out.push(rows[id]);
    }
    out.sort(function (x, y) {
      return y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || (x.name < y.name ? -1 : 1);
    });
    return out;
  }

  /* ---------------- cup: preliminary round + straight knockout ---------------- */

  // 20 clubs: 8 drawn into a preliminary round, 12 byes; then R16→QF→SF→Final.
  function cupDraw(seed, teamIds) {
    var order = shuffle(rng(seed + ':cup'), teamIds.slice());
    var prelim = [], byes = order.slice(8);
    for (var i = 0; i < 8; i += 2) prelim.push({ home: order[i], away: order[i + 1] });
    return { prelim: prelim, byes: byes };
  }

  function cupPairs(seed, roundName, teamIds) {
    var order = shuffle(rng(seed + ':cup:' + roundName), teamIds.slice());
    var pairs = [];
    for (var i = 0; i + 1 < order.length; i += 2) pairs.push({ home: order[i], away: order[i + 1] });
    return pairs;
  }

  var CUP_ROUNDS = ['Preliminary', 'Round of 16', 'Quarter-final', 'Semi-final', 'Final'];

  /* ---------------- development, transfers, money ---------------- */

  // A season of football changes a player: the young grow, the old fade.
  function developPlayer(p, r, minutesShare) {
    var q = clone(p);
    q.age++;
    var growth = 0;
    if (q.age <= 21) growth = 1 + Math.floor(r() * 3 + minutesShare * 2);
    else if (q.age <= 24) growth = Math.floor(r() * 2 + minutesShare * 2);
    else if (q.age <= 28) growth = Math.floor(r() * 2) - 0;
    else if (q.age <= 31) growth = -Math.floor(r() * 2);
    else growth = -(1 + Math.floor(r() * 3));
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var d = growth;
      if (growth < 0 && (a === 'pace' || a === 'stamina')) d = growth - 1;  // legs go first
      if (growth < 0 && (a === 'technique' || a === 'keeping')) d = Math.ceil(growth / 2);
      q[a] = Math.round(clamp(q[a] + d, 20, 99));
    }
    return q;
  }

  function retires(p, r) {
    if (p.age >= 38) return true;
    if (p.age >= 34) return r() < (p.age - 33) * 0.3;
    return false;
  }

  // What another club will actually let a player go for.
  function askingPrice(seed, p) {
    var r = rng(seed + ':ask:' + p.id);
    return Math.round(playerValue(p) * (1.10 + r() * 0.35) / 25000) * 25000;
  }

  // Deterministic negotiation: generous bids land, lowballs get a counter or a door.
  function offerResult(seed, p, offer) {
    var ask = askingPrice(seed, p);
    if (offer >= ask) return { verdict: 'accepted', ask: ask };
    if (offer >= ask * 0.85) return { verdict: 'countered', ask: ask, counter: Math.round((ask + offer) / 2 / 25000) * 25000 };
    return { verdict: 'rejected', ask: ask };
  }

  // The window's shop: each club's non-core players, priced.
  function transferList(seed, league, myClubId) {
    var out = [];
    league.clubs.forEach(function (c) {
      if (c.id === myClubId) return;
      var squad = c.squad.map(function (id) { return league.players[id]; })
        .sort(function (a, b) { return overall(b) - overall(a); });
      // The best 8 are untouchable; the rest can be prised away. Cap depth so
      // a club is never stripped below a matchday squad.
      for (var i = 8; i < squad.length && c.squad.length > 14; i++) {
        var p = squad[i];
        out.push({ playerId: p.id, clubId: c.id, price: askingPrice(seed, p) });
      }
    });
    out.sort(function (a, b) { return b.price - a.price; });
    return out;
  }

  function sellPrice(p) { return Math.round(playerValue(p) * 0.9 / 25000) * 25000; }

  // Gate money for a home game: a bigger club, a better mood, a fuller ground.
  function matchdayIncome(club, tablePos) {
    var base = { 1: 320000, 2: 210000, 3: 140000, 4: 90000 }[club.tier] || 90000;
    var posBonus = clamp((21 - (tablePos || 10)) / 20, 0, 1) * 0.4;
    var mood = club.morale / 100 * 0.3;
    return Math.round(base * (0.8 + posBonus + mood) / 1000) * 1000;
  }

  var PRIZE = [5e6, 3.5e6, 2.5e6, 1.8e6, 1.4e6, 1.1e6, 900e3, 800e3, 700e3, 650e3,
    600e3, 550e3, 500e3, 450e3, 400e3, 380e3, 360e3, 340e3, 320e3, 300e3];
  function seasonPrize(position) { return PRIZE[clamp(position, 1, 20) - 1]; }

  /* ---------------- awards & news ---------------- */

  function awards(league, playerStats) {
    var players = league.players;
    var ids = Object.keys(playerStats).filter(function (id) { return players[id]; });
    function top(metric) {
      var best = null;
      ids.forEach(function (id) {
        var s = playerStats[id];
        if (!best || (s[metric] || 0) > (playerStats[best][metric] || 0)) best = id;
      });
      return best && (playerStats[best][metric] || 0) > 0 ? best : null;
    }
    var minApps = 10;
    var poty = null, potyAvg = 0;
    ids.forEach(function (id) {
      var s = playerStats[id];
      if ((s.apps || 0) >= minApps) {
        var a = s.ratingSum / s.apps;
        if (a > potyAvg) { potyAvg = a; poty = id; }
      }
    });
    return {
      goldenBoot: top('goals'), playmaker: top('assists'),
      playerOfSeason: poty, playerOfSeasonAvg: round1(potyAvg),
    };
  }

  function newsForResult(seed, home, away, res) {
    var r = rng(seed + ':news');
    var score = res.hg + '–' + res.ag;
    var big = Math.abs(res.hg - res.ag) >= 3;
    var glut = res.hg + res.ag >= 5;
    var winner = res.hg > res.ag ? home : res.ag > res.hg ? away : null;
    var loser = winner === home ? away : home;
    if (!winner) {
      return pick(r, [
        'Honours even: ' + home.name + ' ' + score + ' ' + away.name + '.',
        home.short + ' and ' + away.short + ' share the points in a ' + score + ' draw.',
      ]);
    }
    if (big) return winner.name + ' run riot, ' + score + ' — a statement win over ' + loser.short + '.';
    if (glut) return 'Goals everywhere: ' + home.name + ' ' + score + ' ' + away.name + '.';
    return pick(r, [
      winner.name + ' edge it ' + score + ' against ' + loser.name + '.',
      winner.short + ' take all three points, ' + score + '.',
      'A hard-fought ' + score + ' win for ' + winner.name + '.',
    ]);
  }

  /* ---------------- the career: one pure state machine ---------------- */

  function buildCalendar(nLeagueRounds) {
    // Cup dates land after league rounds 7, 14, 21, 28 and 34.
    var cupAfter = { 7: 0, 14: 1, 21: 2, 28: 3, 34: 4 };
    var cal = [];
    for (var i = 0; i < nLeagueRounds; i++) {
      cal.push({ type: 'league', round: i });
      if (cupAfter[i + 1] != null) cal.push({ type: 'cup', round: cupAfter[i + 1] });
    }
    return cal;
  }

  function newGame(seed, myClubId) {
    var league = genLeague(seed);
    var ids = league.clubs.map(function (c) { return c.id; });
    var fx = fixtures(ids);
    var draw = cupDraw(seed + ':s1', ids);
    return {
      v: 1, seed: seed, myClubId: myClubId || ids[0], season: 1, pointer: 0,
      league: league, fixtures: fx, calendar: buildCalendar(fx.length),
      results: [], playerStats: {}, injuries: {}, suspensions: {}, yellowCards: {},
      cup: { draw: draw, alive: ids.slice(), round: 0, ties: [], myOut: false, winnerId: null },
      tactics: { formation: '4-4-2', mentality: 'balanced' },
      trophies: [], news: [{ season: 1, text: 'A new season begins. Twenty clubs, one title, one cup.' }],
      awards: null, seasonOver: false,
    };
  }

  function availablePlayers(state, club) {
    return club.squad
      .map(function (id) { return state.league.players[id]; })
      .filter(function (p) {
        return p && !(state.injuries[p.id] > 0) && !(state.suspensions[p.id] > 0);
      });
  }

  function clubRating(state, club) {
    var xi = pickXI(availablePlayers(state, club), '4-4-2');
    return Math.round(avg(xi.all, overall));
  }

  function statFor(stats, id) {
    if (!stats[id]) stats[id] = { apps: 0, goals: 0, assists: 0, yellows: 0, reds: 0, ratingSum: 0, motm: 0 };
    return stats[id];
  }

  // Everything one matchday does to the world, as a pure state→state step.
  function playTie(state, seed, homeClub, awayClub, opts) {
    var hAvail = availablePlayers(state, homeClub);
    var aAvail = availablePlayers(state, awayClub);
    var isMineH = homeClub.id === state.myClubId, isMineA = awayClub.id === state.myClubId;
    var hRate = clubRating(state, homeClub), aRate = clubRating(state, awayClub);
    var hTac = isMineH ? state.tactics : aiTactics(hAvail, hRate, aRate);
    var aTac = isMineA ? state.tactics : aiTactics(aAvail, aRate, hRate);
    var hXI = pickXI(hAvail, hTac.formation);
    var aXI = pickXI(aAvail, aTac.formation);
    var sim = simulateMatch(seed,
      { club: homeClub, xi: hXI, tactics: hTac, morale: homeClub.morale },
      { club: awayClub, xi: aXI, tactics: aTac, morale: awayClub.morale }, opts);
    var pens = null;
    if (sim.needsShootout) {
      var hK = hXI.all.filter(function (p) { return p.pos !== 'GK'; })
        .sort(function (a, b) { return b.technique - a.technique; }).slice(0, 5);
      var aK = aXI.all.filter(function (p) { return p.pos !== 'GK'; })
        .sort(function (a, b) { return b.technique - a.technique; }).slice(0, 5);
      pens = shootout(seed + ':pens', hK, aK, hXI.GK[0], aXI.GK[0]);
    }
    return { sim: sim, pens: pens, hXI: hXI, aXI: aXI };
  }

  function applyMatchBookkeeping(state, homeClub, awayClub, played) {
    var sim = played.sim;
    // Appearances, goals, assists, cards, ratings.
    [{ xi: played.hXI, side: 'H' }, { xi: played.aXI, side: 'A' }].forEach(function (t) {
      t.xi.all.forEach(function (p) {
        var s = statFor(state.playerStats, p.id);
        s.apps++;
        s.ratingSum = Math.round((s.ratingSum + (sim.ratings[p.id] || 6)) * 10) / 10;
      });
    });
    var motm = null, motmR = 0;
    sim.events.forEach(function (e) {
      if (e.type === 'goal') {
        statFor(state.playerStats, e.playerId).goals++;
        if (e.assistId) statFor(state.playerStats, e.assistId).assists++;
      }
      if (e.type === 'yellow') {
        var s = statFor(state.playerStats, e.playerId);
        s.yellows++;
        state.yellowCards[e.playerId] = (state.yellowCards[e.playerId] || 0) + 1;
        if (state.yellowCards[e.playerId] >= 5) {
          state.yellowCards[e.playerId] = 0;
          state.suspensions[e.playerId] = Math.max(state.suspensions[e.playerId] || 0, 1) + 1;
        }
      }
      if (e.type === 'red') {
        statFor(state.playerStats, e.playerId).reds++;
        state.suspensions[e.playerId] = Math.max(state.suspensions[e.playerId] || 0, 0) + 2 + 1;
      }
    });
    for (var id in sim.ratings) {
      if (sim.ratings[id] > motmR) { motmR = sim.ratings[id]; motm = id; }
    }
    if (motm) statFor(state.playerStats, motm).motm++;
    sim.injuries.forEach(function (inj) {
      state.injuries[inj.playerId] = Math.max(state.injuries[inj.playerId] || 0, inj.matches) + 1;
    });
    // Morale swings with results.
    var hg = sim.homeGoals, ag = sim.awayGoals;
    homeClub.morale = clamp(homeClub.morale + (hg > ag ? 5 : hg < ag ? -5 : 1), 35, 95);
    awayClub.morale = clamp(awayClub.morale + (ag > hg ? 6 : ag < hg ? -5 : 1), 35, 95);
    return { motm: motm };
  }

  // One press of "continue": simulates the next calendar entry for every club.
  function advanceRound(state) {
    if (state.pointer >= state.calendar.length) return clone(state);
    var s = clone(state);
    var entry = s.calendar[s.pointer];
    var byId = {};
    s.league.clubs.forEach(function (c) { byId[c.id] = c; });
    var myMatch = null;

    // A matchday passing heals and frees people.
    function tickBans() {
      var id;
      for (id in s.injuries) { if (--s.injuries[id] <= 0) delete s.injuries[id]; }
      for (id in s.suspensions) { if (--s.suspensions[id] <= 0) delete s.suspensions[id]; }
    }
    tickBans();

    if (entry.type === 'league') {
      var games = s.fixtures[entry.round];
      var tablePosBefore = {};
      leagueTable(s.league.clubs, s.results).forEach(function (row, i) { tablePosBefore[row.id] = i + 1; });
      games.forEach(function (g, gi) {
        var home = byId[g.home], away = byId[g.away];
        var seed = s.seed + ':s' + s.season + ':L' + entry.round + ':' + g.home + 'v' + g.away;
        var played = playTie(s, seed, home, away, {});
        var book = applyMatchBookkeeping(s, home, away, played);
        var res = { comp: 'league', round: entry.round, home: g.home, away: g.away,
          hg: played.sim.homeGoals, ag: played.sim.awayGoals };
        s.results.push(res);
        if (home.id === s.myClubId || away.id === s.myClubId) {
          myMatch = { res: res, sim: played.sim, motm: book.motm,
            homeClub: { id: home.id, name: home.name, short: home.short, color: home.color },
            awayClub: { id: away.id, name: away.name, short: away.short, color: away.color } };
          if (home.id === s.myClubId) home.budget += matchdayIncome(home, tablePosBefore[home.id]);
          s.news.unshift({ season: s.season, round: entry.round + 1,
            text: newsForResult(seed, home, away, res) });
        } else if (gi === 0 || res.hg + res.ag >= 5) {
          s.news.unshift({ season: s.season, round: entry.round + 1,
            text: newsForResult(seed, home, away, res) });
        }
      });
    } else {
      // Cup day. Build this round's ties from the draw or the survivors.
      var ties;
      var ids = s.cup.alive;
      if (s.cup.round === 0) ties = s.cup.draw.prelim;
      else ties = cupPairs(s.seed + ':s' + s.season, CUP_ROUNDS[s.cup.round], ids);
      var winners = s.cup.round === 0 ? s.cup.draw.byes.slice() : [];
      var tieResults = [];
      ties.forEach(function (t) {
        var home = byId[t.home], away = byId[t.away];
        var seed = s.seed + ':s' + s.season + ':C' + s.cup.round + ':' + t.home + 'v' + t.away;
        var played = playTie(s, seed, home, away, { extraTime: true });
        var book = applyMatchBookkeeping(s, home, away, played);
        var winId = played.sim.homeGoals > played.sim.awayGoals ? t.home
          : played.sim.awayGoals > played.sim.homeGoals ? t.away
          : (played.pens.winner === 'H' ? t.home : t.away);
        winners.push(winId);
        var res = { comp: 'cup', round: s.cup.round, home: t.home, away: t.away,
          hg: played.sim.homeGoals, ag: played.sim.awayGoals,
          pens: played.pens ? played.pens.hScore + '–' + played.pens.aScore : null,
          winner: winId };
        tieResults.push(res);
        if (home.id === s.myClubId || away.id === s.myClubId) {
          myMatch = { res: res, sim: played.sim, pens: played.pens, motm: book.motm,
            homeClub: { id: home.id, name: home.name, short: home.short, color: home.color },
            awayClub: { id: away.id, name: away.name, short: away.short, color: away.color } };
          if (winId !== s.myClubId) s.cup.myOut = true;
          s.news.unshift({ season: s.season,
            text: (winId === s.myClubId ? 'Cup progress! ' : 'Cup exit. ') +
              byId[winId].name + ' win the ' + CUP_ROUNDS[s.cup.round].toLowerCase() +
              (res.pens ? ' on penalties (' + res.pens + ')' : '') + '.' });
        }
      });
      s.cup.ties.push({ name: CUP_ROUNDS[s.cup.round], results: tieResults });
      s.cup.alive = winners;
      s.cup.round++;
      if (s.cup.round >= CUP_ROUNDS.length || winners.length === 1) {
        s.cup.winnerId = winners[0];
        s.news.unshift({ season: s.season,
          text: '🏆 ' + byId[winners[0]].name + ' lift the Ballrz Cup!' });
        if (winners[0] === s.myClubId) {
          s.trophies.push({ season: s.season, name: 'Ballrz Cup' });
          byId[s.myClubId].budget += 2.5e6;
        }
      }
    }

    s.pointer++;
    if (s.pointer >= s.calendar.length) s.seasonOver = true;
    s.lastMatch = myMatch;
    return s;
  }

  // Champagne, growth spurts, retirements, and a fresh fixture list.
  function endSeason(state) {
    var s = clone(state);
    var table = leagueTable(s.league.clubs, s.results.filter(function (r) { return r.comp === 'league'; }));
    var byId = {};
    s.league.clubs.forEach(function (c) { byId[c.id] = c; });
    var champion = table[0];
    s.news.unshift({ season: s.season, text: '👑 ' + champion.name + ' are champions of Ballrz League Season ' + s.season + '!' });
    if (champion.id === s.myClubId) s.trophies.push({ season: s.season, name: 'League Title' });
    var myPos = table.findIndex(function (r) { return r.id === s.myClubId; }) + 1;
    byId[s.myClubId].budget += seasonPrize(myPos);
    s.awards = awards(s.league, s.playerStats);
    s.history = s.history || [];
    s.history.push({ season: s.season, championId: champion.id, myPos: myPos,
      cupWinnerId: s.cup.winnerId, awards: s.awards });

    // Development + retirement, minutes-weighted; academy kids fill the gaps.
    var totalApps = s.calendar.filter(function (e) { return e.type === 'league'; }).length;
    var devR = rng(s.seed + ':dev:s' + s.season);
    s.league.clubs.forEach(function (c) {
      var kept = [];
      c.squad.forEach(function (id) {
        var p = s.league.players[id];
        var share = clamp(((s.playerStats[id] || {}).apps || 0) / Math.max(1, totalApps), 0, 1);
        if (retires(p, devR)) {
          delete s.league.players[id];
          if (c.id === s.myClubId) {
            s.news.unshift({ season: s.season, text: p.name + ' hangs up the boots at ' + p.age + '.' });
          }
          return;
        }
        s.league.players[id] = developPlayer(p, devR, share);
        kept.push(id);
      });
      c.squad = kept;
      // The academy refills every squad to 18, respecting the squad shape.
      var counts = { GK: 0, DF: 0, MF: 0, FW: 0 };
      c.squad.forEach(function (id) { counts[s.league.players[id].pos]++; });
      POSITIONS.forEach(function (pos) {
        while (counts[pos] < SQUAD_SHAPE[pos]) {
          var kid = genPlayer(devR, pos, Math.min(4, c.tier + 1), 0);
          kid.age = 17 + Math.floor(devR() * 2);
          kid.id = 'p' + (hashStr(s.seed + c.id + pos + counts[pos] + 's' + s.season) % 1e9 + 1e9);
          kid.clubId = c.id;
          s.league.players[kid.id] = kid;
          c.squad.push(kid.id);
          counts[pos]++;
        }
      });
    });

    // New season, fresh slate.
    s.season++;
    var ids = s.league.clubs.map(function (c) { return c.id; });
    s.fixtures = fixtures(ids);
    s.calendar = buildCalendar(s.fixtures.length);
    s.pointer = 0;
    s.results = [];
    s.playerStats = {};
    s.injuries = {}; s.suspensions = {}; s.yellowCards = {};
    s.cup = { draw: cupDraw(s.seed + ':s' + s.season, ids), alive: ids.slice(),
      round: 0, ties: [], myOut: false, winnerId: null };
    s.seasonOver = false;
    s.lastMatch = null;
    s.news.unshift({ season: s.season, text: 'Season ' + s.season + ' kicks off. The slate is clean.' });
    return s;
  }

  // Buying and selling, as pure state transitions with hard guards.
  function buyPlayer(state, playerId, price) {
    var s = clone(state);
    var p = s.league.players[playerId];
    var me = s.league.clubs.find(function (c) { return c.id === s.myClubId; });
    var seller = s.league.clubs.find(function (c) { return c.id === p.clubId; });
    if (!p || !seller || seller.id === s.myClubId) throw new Error('not for sale');
    if (price > me.budget) throw new Error('not enough budget');
    if (me.squad.length >= 25) throw new Error('squad is full (25)');
    if (seller.squad.length <= 14) throw new Error('selling club refuses — squad too thin');
    me.budget -= price;
    seller.budget += price;
    seller.squad = seller.squad.filter(function (id) { return id !== playerId; });
    me.squad.push(playerId);
    p.clubId = me.id;
    s.news.unshift({ season: s.season,
      text: '✍️ ' + p.name + ' joins ' + me.name + ' from ' + seller.name + ' for ' + fmtMoney(price) + '.' });
    return s;
  }

  function sellPlayer(state, playerId) {
    var s = clone(state);
    var p = s.league.players[playerId];
    var me = s.league.clubs.find(function (c) { return c.id === s.myClubId; });
    if (!p || p.clubId !== me.id) throw new Error('not your player');
    if (me.squad.length <= 14) throw new Error('squad too thin to sell (min 14)');
    var counts = { GK: 0, DF: 0, MF: 0, FW: 0 };
    me.squad.forEach(function (id) { counts[s.league.players[id].pos]++; });
    if (p.pos === 'GK' && counts.GK <= 1) throw new Error('cannot sell your only keeper');
    var fee = sellPrice(p);
    me.budget += fee;
    me.squad = me.squad.filter(function (id) { return id !== playerId; });
    // The player moves to the interested club with the deepest pockets.
    var buyer = s.league.clubs.filter(function (c) { return c.id !== me.id && c.squad.length < 25; })
      .sort(function (a, b) { return b.budget - a.budget; })[0];
    buyer.budget -= Math.min(buyer.budget, fee);
    buyer.squad.push(playerId);
    p.clubId = buyer.id;
    s.news.unshift({ season: s.season,
      text: '💸 ' + p.name + ' sold to ' + buyer.name + ' for ' + fmtMoney(fee) + '.' });
    return s;
  }

  /* ---------------- exports ---------------- */

  var Ballrz = {
    // primitives
    hashStr: hashStr, rng: rng, clamp: clamp, round1: round1,
    escapeHTML: escapeHTML, fmtMoney: fmtMoney,
    // universe
    CLUBS: CLUBS, POSITIONS: POSITIONS, FORMATIONS: FORMATIONS,
    MENTALITIES: MENTALITIES, ATTRS: ATTRS, SQUAD_SHAPE: SQUAD_SHAPE,
    CUP_ROUNDS: CUP_ROUNDS,
    genPlayer: genPlayer, genLeague: genLeague, overall: overall, playerValue: playerValue,
    // scheduling & selection
    fixtures: fixtures, pickXI: pickXI, teamStrength: teamStrength, aiTactics: aiTactics,
    buildCalendar: buildCalendar,
    // match day
    simulateMatch: simulateMatch, shootout: shootout,
    // competitions
    leagueTable: leagueTable, cupDraw: cupDraw, cupPairs: cupPairs,
    // people & money
    developPlayer: developPlayer, retires: retires,
    askingPrice: askingPrice, offerResult: offerResult, transferList: transferList,
    sellPrice: sellPrice, matchdayIncome: matchdayIncome, seasonPrize: seasonPrize,
    awards: awards, newsForResult: newsForResult,
    // the career state machine
    newGame: newGame, advanceRound: advanceRound, endSeason: endSeason,
    buyPlayer: buyPlayer, sellPlayer: sellPlayer,
    availablePlayers: availablePlayers, clubRating: clubRating,
  };

  root.Ballrz = Ballrz;
  if (typeof module !== 'undefined' && module.exports) module.exports = Ballrz;
})(typeof self !== 'undefined' ? self : this);
