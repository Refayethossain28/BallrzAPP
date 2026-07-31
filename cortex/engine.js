/**
 * Cortex — the Drill Engine
 * =========================
 *
 * The deterministic core of Cortex, the daily brain gym. Every round of every
 * exercise — what appears on screen, what the right answer is, how hard the
 * next round gets, what your score and brain ratings become — is computed
 * here, from pure functions and a seeded PRNG. Nothing is random at run time
 * unless the UI *chooses* a seed; the same seed + the same level always deals
 * the same round. That determinism is what makes an "addictive" loop honest:
 * the difficulty staircase, the combo curve and the rating model are all
 * inspectable and unit-tested, not tuned in the dark.
 *
 * The five drills — one per cognitive domain
 * ------------------------------------------
 *   flash   Memory        a grid of cells lights up, then goes dark — tap
 *                         back every lit cell from memory.
 *   storm   Maths         rapid mental arithmetic against the clock, from
 *                         single sums to multi-step chains.
 *   stroop  Focus         the word "BLUE" printed in red ink: answer the ink,
 *                         not the word. Higher levels flip the question mid-
 *                         session (reverse Stroop), the classic interference
 *                         task since 1935.
 *   echo    Working mem   a stream of symbols shown one by one, then gone —
 *                         pick the one that was in the stream. Higher levels
 *                         use confusable twins (◆/◇, ●/○ …).
 *   odd     Speed         a wall of identical glyphs hiding one that differs;
 *                         find it before the clock runs out.
 *
 * The loop
 * --------
 *   Each session is SESSION_ROUNDS rounds of one drill. Difficulty follows a
 *   psychophysical staircase (+1 level on a hit, −1 on a miss, clamped to
 *   1..MAX_LEVEL), so every player converges on ~50–80% success — the zone
 *   where a game feels "hard but doable", which is what actually trains.
 *   Points reward correctness first and speed second; a hit streak multiplies
 *   them. A session updates the drill's domain *rating* (an exponential
 *   moving average toward that session's performance), the five ratings
 *   average into a single Brain Index with named ranks, and a calendar streak
 *   rewards showing up daily. dailyWorkout() deals the same 3-drill circuit
 *   to every human on Earth for a given date — that's the "everyone needs
 *   this, everyone plays the same workout today" hook.
 *
 * UMD so it runs in the browser (window.Cortex) and under Node/vm for tests —
 * same pattern as cusp/engine.js. Pure, deterministic, framework-free.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Cortex = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_LEVEL = 30;
  var SESSION_ROUNDS = 10;
  var MAX_RATING = 1000;

  var DRILLS = [
    { id: 'flash',  name: 'Flashback',   emoji: '🧩', domain: 'memory',  kind: 'recall',   tagline: 'Tap back the cells that lit up' },
    { id: 'storm',  name: 'Number Storm', emoji: '➗', domain: 'maths',   kind: 'choice',   tagline: 'Mental arithmetic against the clock' },
    { id: 'stroop', name: 'Ink Trap',    emoji: '🎯', domain: 'focus',   kind: 'choice',   tagline: 'Answer the ink, ignore the word' },
    { id: 'echo',   name: 'Echo',        emoji: '🔁', domain: 'working', kind: 'sequence', tagline: 'Hold the vanishing stream in mind' },
    { id: 'odd',    name: 'Odd One Out', emoji: '⚡', domain: 'speed',   kind: 'gridtap',  tagline: 'One glyph is different — find it' }
  ];
  var DOMAINS = ['memory', 'maths', 'focus', 'working', 'speed'];

  var RANKS = [
    { min: 0,   name: 'Spark' },
    { min: 200, name: 'Kindler' },
    { min: 350, name: 'Thinker' },
    { min: 500, name: 'Sharp' },
    { min: 650, name: 'Brilliant' },
    { min: 800, name: 'Mastermind' },
    { min: 920, name: 'Limitless' }
  ];

  var clamp = function (x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; };

  /* ---------------------------------------------------------------- PRNG */

  // FNV-1a string hash → 32-bit seed. Deterministic across engines.
  function hashSeed(str) {
    var h = 0x811c9dc5;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // mulberry32 — tiny, fast, high-quality-enough, fully deterministic.
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rInt = function (rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); };
  var pick = function (rng, arr) { return arr[Math.floor(rng() * arr.length)]; };
  function shuffle(rng, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ------------------------------------------------------- drill: flash */
  // Grid recall. Level grows the grid (3×3 → 6×6) and the number of lit
  // cells; the flash gets briefer as levels climb.

  function flashParams(level) {
    var L = clamp(level, 1, MAX_LEVEL);
    var grid = 3 + Math.min(3, Math.floor((L - 1) / 8));         // 3,4,5,6
    var cells = Math.min(2 + Math.floor((L + 1) / 2), grid * grid - 2);
    return {
      grid: grid,
      cells: cells,
      showMs: Math.max(900, 2400 - L * 55),
      timeLimitMs: 4000 + cells * 1400
    };
  }

  function genFlash(level, rng) {
    var p = flashParams(level);
    var all = [];
    for (var i = 0; i < p.grid * p.grid; i++) all.push(i);
    var lit = shuffle(rng, all).slice(0, p.cells).sort(function (a, b) { return a - b; });
    return { drill: 'flash', kind: 'recall', level: level, grid: p.grid,
             lit: lit, showMs: p.showMs, timeLimitMs: p.timeLimitMs };
  }

  /* ------------------------------------------------------- drill: storm */
  // Mental arithmetic. Level tiers move from single small sums through
  // multiplication to two-step chains. Decoys sit near the true answer so
  // "roughly right" isn't enough.

  function stormTimeLimit(level) { return Math.max(3500, 9000 - level * 180); }

  function genStorm(level, rng) {
    var L = clamp(level, 1, MAX_LEVEL);
    var span = 9 + L * 3;                     // operand size grows with level
    var a, b, c, prompt, answer;
    var form = L < 5 ? pick(rng, ['add', 'sub'])
             : L < 10 ? pick(rng, ['add', 'sub', 'mul'])
             : L < 18 ? pick(rng, ['sub', 'mul', 'chain'])
             : pick(rng, ['mul', 'chain', 'mulchain']);
    if (form === 'add') {
      a = rInt(rng, 3, span); b = rInt(rng, 3, span);
      prompt = a + ' + ' + b; answer = a + b;
    } else if (form === 'sub') {
      a = rInt(rng, 6, span + 10); b = rInt(rng, 2, a - 1);
      prompt = a + ' − ' + b; answer = a - b;
    } else if (form === 'mul') {
      a = rInt(rng, 3, 6 + Math.floor(L / 2)); b = rInt(rng, 3, 9 + Math.floor(L / 3));
      prompt = a + ' × ' + b; answer = a * b;
    } else if (form === 'chain') {
      a = rInt(rng, 5, span); b = rInt(rng, 3, span); c = rInt(rng, 2, Math.floor(span / 2));
      prompt = a + ' + ' + b + ' − ' + c; answer = a + b - c;
    } else { // mulchain: (a × b) + c, shown with brackets so precedence is explicit
      a = rInt(rng, 3, 9); b = rInt(rng, 4, 12); c = rInt(rng, 5, span);
      prompt = '(' + a + ' × ' + b + ') + ' + c; answer = a * b + c;
    }
    // three distinct near-miss decoys
    var opts = [answer];
    while (opts.length < 4) {
      var off = rInt(rng, 1, Math.max(3, Math.floor(Math.abs(answer) * 0.15) + 2));
      var d = answer + (rng() < 0.5 ? -off : off);
      if (opts.indexOf(d) === -1) opts.push(d);
    }
    opts = shuffle(rng, opts);
    return { drill: 'storm', kind: 'choice', level: level, prompt: prompt + ' = ?',
             options: opts, answer: answer, timeLimitMs: stormTimeLimit(level) };
  }

  /* ------------------------------------------------------ drill: stroop */
  // Classic colour–word interference. Below level 8 the question is always
  // "what INK is this?"; from level 8 the mode flips round to round (reverse
  // Stroop: "what does the WORD say?"), which is where the real burn lives.

  var STROOP_COLORS = [
    { name: 'RED',    hex: '#ff5d6c' },
    { name: 'BLUE',   hex: '#5d8bff' },
    { name: 'GREEN',  hex: '#3fd68f' },
    { name: 'YELLOW', hex: '#ffc94d' },
    { name: 'PURPLE', hex: '#b07cff' },
    { name: 'ORANGE', hex: '#ff9d4d' }
  ];

  function stroopTimeLimit(level) { return Math.max(1600, 4200 - level * 110); }

  function genStroop(level, rng) {
    var L = clamp(level, 1, MAX_LEVEL);
    var pool = STROOP_COLORS.slice(0, 4 + Math.min(2, Math.floor(L / 10))); // 4→6 colours
    var word = pick(rng, pool);
    // mostly incongruent — congruent rounds are kept in so you can't just
    // learn "never say the word you read"
    var ink = rng() < 0.8 ? pick(rng, pool.filter(function (c) { return c.name !== word.name; })) : word;
    var mode = L >= 8 && rng() < 0.5 ? 'word' : 'ink';
    var answer = mode === 'ink' ? ink.name : word.name;
    var names = pool.map(function (c) { return c.name; });
    var opts = shuffle(rng, [answer].concat(shuffle(rng, names.filter(function (n) { return n !== answer; })).slice(0, 3)));
    return { drill: 'stroop', kind: 'choice', level: level, mode: mode,
             word: word.name, inkHex: ink.hex, inkName: ink.name,
             prompt: mode === 'ink' ? 'Tap the INK colour' : 'Tap what the WORD says',
             options: opts, answer: answer, timeLimitMs: stroopTimeLimit(level) };
  }

  /* -------------------------------------------------------- drill: echo */
  // Sequence recognition. A stream of symbols is shown one at a time and
  // vanishes; exactly one of the four options was in it. High levels draw
  // decoys from each shown symbol's confusable twin (◆→◇), so a fuzzy trace
  // stops being good enough.

  var ECHO_SYMBOLS = ['◆', '●', '▲', '■', '★', '⬟', '✚', '♥'];
  var ECHO_TWINS = { '◆': '◇', '●': '○', '▲': '△', '■': '□', '★': '☆', '⬟': '⬠', '✚': '✛', '♥': '♡' };

  function echoParams(level) {
    var L = clamp(level, 1, MAX_LEVEL);
    return {
      seqLen: Math.min(3 + Math.floor(L / 3), 9),
      itemMs: Math.max(420, 820 - L * 16),
      timeLimitMs: Math.max(2500, 5000 - L * 80),
      twins: L >= 10
    };
  }

  function genEcho(level, rng) {
    var p = echoParams(level);
    var seq = shuffle(rng, ECHO_SYMBOLS).slice(0, p.seqLen);
    var answer = pick(rng, seq);
    var unused = ECHO_SYMBOLS.filter(function (s) { return seq.indexOf(s) === -1; });
    var decoys;
    if (p.twins) {
      // twins of *shown* symbols (excluding the answer's own twin — its twin
      // as a decoy next to it would test eyesight, not memory)
      decoys = shuffle(rng, seq.filter(function (s) { return s !== answer; })
        .map(function (s) { return ECHO_TWINS[s]; })).slice(0, 3);
    } else {
      decoys = shuffle(rng, unused).slice(0, 3);
    }
    while (decoys.length < 3) { // tiny unused pool at long seqLen — top up with twins
      var extra = ECHO_TWINS[seq[decoys.length]];
      if (extra && decoys.indexOf(extra) === -1 && extra !== answer) decoys.push(extra);
      else break;
    }
    var opts = shuffle(rng, [answer].concat(decoys));
    return { drill: 'echo', kind: 'sequence', level: level, sequence: seq,
             itemMs: p.itemMs, prompt: 'Which one was in the stream?',
             options: opts, answer: answer, timeLimitMs: p.timeLimitMs };
  }

  /* --------------------------------------------------------- drill: odd */
  // Visual search. A grid of one glyph with a single intruder. Level grows
  // the wall and moves through ever more confusable glyph pairs.

  var ODD_TIERS = [
    [['●', '★'], ['■', '▲'], ['♥', '✚'], ['◆', '○']],                 // obviously different
    [['●', '◆'], ['■', '◼'], ['▲', '▶'], ['★', '✦']],                // same family
    [['◉', '◎'], ['▲', '△'], ['■', '□'], ['◆', '◇'], ['Ø', 'O']]     // squint-hard
  ];

  function oddParams(level) {
    var L = clamp(level, 1, MAX_LEVEL);
    return {
      grid: 3 + Math.min(3, Math.floor(L / 7)),                  // 3..6
      tier: Math.min(2, Math.floor((L - 1) / 8)),                // 0..2
      timeLimitMs: Math.max(2200, 5200 - L * 110)
    };
  }

  function genOdd(level, rng) {
    var p = oddParams(level);
    var pair = pick(rng, ODD_TIERS[p.tier]);
    var flip = rng() < 0.5;
    var base = flip ? pair[1] : pair[0], intruder = flip ? pair[0] : pair[1];
    var n = p.grid * p.grid;
    var at = rInt(rng, 0, n - 1);
    var symbols = [];
    for (var i = 0; i < n; i++) symbols.push(i === at ? intruder : base);
    return { drill: 'odd', kind: 'gridtap', level: level, grid: p.grid,
             symbols: symbols, answer: at, timeLimitMs: p.timeLimitMs };
  }

  /* --------------------------------------------------- rounds & scoring */

  function genRound(drillId, level, rng) {
    switch (drillId) {
      case 'flash':  return genFlash(level, rng);
      case 'storm':  return genStorm(level, rng);
      case 'stroop': return genStroop(level, rng);
      case 'echo':   return genEcho(level, rng);
      case 'odd':    return genOdd(level, rng);
      default: throw new Error('unknown drill: ' + drillId);
    }
  }

  // flash answers are a set of tapped cell indices; everything else is a value
  function checkAnswer(round, answer) {
    if (round.kind === 'recall') {
      if (!answer || answer.length !== round.lit.length) return false;
      var got = answer.slice().sort(function (a, b) { return a - b; });
      for (var i = 0; i < got.length; i++) if (got[i] !== round.lit[i]) return false;
      return true;
    }
    return answer === round.answer;
  }

  // Correctness earns the points; speed multiplies them (up to 1.5×); level
  // scales the whole thing so climbing the staircase is always worth it.
  function roundPoints(level, correct, ms, timeLimitMs) {
    if (!correct) return 0;
    var speed = clamp(1 - ms / Math.max(1, timeLimitMs), 0, 1);
    return Math.round(100 * (1 + (clamp(level, 1, MAX_LEVEL) - 1) * 0.15) * (1 + 0.5 * speed));
  }

  // Hit-streak multiplier: ×1.0, ×1.1 … capped at ×2.0 after a 10 streak.
  function comboMultiplier(streak) { return 1 + Math.min(Math.max(streak, 0), 10) * 0.1; }

  // Psychophysical staircase: hit → up a level, miss → down, clamped.
  function nextLevel(level, correct) {
    return clamp(level + (correct ? 1 : -1), 1, MAX_LEVEL);
  }

  // results: [{correct, ms, level, points}]
  function sessionSummary(results) {
    var score = 0, hits = 0, best = 0, run = 0, peak = 1, ms = 0;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      score += Math.round((r.points || 0) * comboMultiplier(run));
      if (r.correct) { hits++; run++; if (run > best) best = run; } else run = 0;
      if (r.level > peak) peak = r.level;
      ms += r.ms || 0;
    }
    var n = results.length || 1;
    return {
      rounds: results.length,
      score: score,
      hits: hits,
      accuracy: Math.round((hits / n) * 100) / 100,
      bestCombo: best,
      peakLevel: peak,
      avgMs: Math.round(ms / n)
    };
  }

  /* ------------------------------------------------- ratings & progress */

  // A session's performance on the 0..1000 scale: the level you can hold is
  // worth most; accuracy tops it up. peak 30 & flawless ≈ 1000.
  function sessionPerformance(summary) {
    return clamp(Math.round(summary.peakLevel * 25 + summary.accuracy * 250), 0, MAX_RATING);
  }

  // Ratings chase performance as an EMA — quick early gains, honest plateaus,
  // and a bad day only dents (never erases) a strong rating.
  function updateRating(oldRating, perf) {
    var r = clamp(oldRating || 0, 0, MAX_RATING);
    return clamp(Math.round(r + 0.25 * (clamp(perf, 0, MAX_RATING) - r)), 0, MAX_RATING);
  }

  // Brain Index = mean of the domain ratings you've earned so far.
  function brainIndex(ratings) {
    var sum = 0, n = 0;
    for (var d = 0; d < DOMAINS.length; d++) {
      var v = ratings && ratings[DOMAINS[d]];
      if (typeof v === 'number' && v > 0) { sum += clamp(v, 0, MAX_RATING); n++; }
    }
    return n ? Math.round(sum / n) : 0;
  }

  function rankFor(index) {
    var r = RANKS[0];
    for (var i = 0; i < RANKS.length; i++) if (index >= RANKS[i].min) r = RANKS[i];
    return r.name;
  }

  /* -------------------------------------------------- streaks & workout */

  function isoDay(ts) {
    var d = new Date(ts);
    var m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function dayDiff(isoA, isoB) {
    return Math.round((Date.parse(isoB + 'T00:00:00Z') - Date.parse(isoA + 'T00:00:00Z')) / 86400000);
  }

  // {streak, lastDay} + today's ISO date → the new state. Same day is a
  // no-op; the next calendar day extends; any gap resets to 1.
  function updateStreak(state, todayISO) {
    var s = state || { streak: 0, lastDay: null };
    if (!s.lastDay) return { streak: 1, lastDay: todayISO };
    var gap = dayDiff(s.lastDay, todayISO);
    if (gap <= 0) return { streak: Math.max(1, s.streak), lastDay: s.lastDay };
    if (gap === 1) return { streak: s.streak + 1, lastDay: todayISO };
    return { streak: 1, lastDay: todayISO };
  }

  // The same date deals the same 3-drill circuit to everyone on Earth.
  function dailyWorkout(dayISO) {
    var rng = makeRng(hashSeed('cortex-workout-' + dayISO));
    return shuffle(rng, DRILLS.map(function (d) { return d.id; })).slice(0, 3);
  }

  /* ------------------------------------------------------------ exports */

  return {
    VERSION: VERSION,
    MAX_LEVEL: MAX_LEVEL,
    SESSION_ROUNDS: SESSION_ROUNDS,
    MAX_RATING: MAX_RATING,
    DRILLS: DRILLS,
    DOMAINS: DOMAINS,
    RANKS: RANKS,
    STROOP_COLORS: STROOP_COLORS,
    ECHO_SYMBOLS: ECHO_SYMBOLS,
    ECHO_TWINS: ECHO_TWINS,
    hashSeed: hashSeed,
    makeRng: makeRng,
    shuffle: shuffle,
    flashParams: flashParams,
    echoParams: echoParams,
    oddParams: oddParams,
    genRound: genRound,
    checkAnswer: checkAnswer,
    roundPoints: roundPoints,
    comboMultiplier: comboMultiplier,
    nextLevel: nextLevel,
    sessionSummary: sessionSummary,
    sessionPerformance: sessionPerformance,
    updateRating: updateRating,
    brainIndex: brainIndex,
    rankFor: rankFor,
    isoDay: isoDay,
    dayDiff: dayDiff,
    updateStreak: updateStreak,
    dailyWorkout: dailyWorkout
  };
});
