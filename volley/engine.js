/* Volley — the pure hand-eye coordination engine.
 * =====================================================================
 * Volley trains hand-eye coordination with four short drills: Strike
 * (tap targets before they shrink away), Pursuit (keep your finger glued
 * to a swooping ball), Reflex (tap the instant the arena says GO) and
 * Chain (hit numbered targets in order). Every rule — where a target
 * spawns, how fast it shrinks, what a tap is worth, how a reaction time
 * is judged, how XP turns into ranks — lives HERE, as pure,
 * deterministic, clock-injected functions with zero DOM and zero I/O.
 * Unit-tested in scripts/test-volley-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

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

  // One deterministic float in [0,1) from any seed string.
  function rand01(seed) {
    var h = hashStr(seed);
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function round1(x) { return Math.round(x * 10) / 10; }
  function round2(x) { return Math.round(x * 100) / 100; }

  /* ---------------- the drills ---------------- */
  // One catalogue the whole app reads: the home screen lists it, the play
  // view configures itself from it, results and XP key off drill.key.
  var DRILLS = [
    { key: 'strike',  name: 'Strike',  emoji: '🎯', mode: 'timed',  durationMs: 45 * SECOND,
      skill: 'aim + speed',
      blurb: 'Targets pop up and shrink away. Smash each one before it vanishes — dead-centre and early pays double.' },
    { key: 'pursuit', name: 'Pursuit', emoji: '🟢', mode: 'timed',  durationMs: 30 * SECOND,
      skill: 'smooth tracking',
      blurb: 'One ball swoops around the arena, getting twitchier as it goes. Keep your finger glued to it.' },
    { key: 'reflex',  name: 'Reflex',  emoji: '⚡', mode: 'rounds', rounds: 5,
      skill: 'raw reaction',
      blurb: 'Hold steady through the wait… then tap the very instant the arena flashes GO. Jump early and the round is dead.' },
    { key: 'chain',   name: 'Chain',   emoji: '🔢', mode: 'rounds', rounds: 3, chainLength: 6,
      skill: 'scan + precision',
      blurb: 'Six numbered targets, one order, no do-overs. Sweep 1→6 fast and clean; wrong taps cost you.' }
  ];

  function drillByKey(key) {
    for (var i = 0; i < DRILLS.length; i++) if (DRILLS[i].key === key) return DRILLS[i];
    return null;
  }

  /* ---------------- Strike: tap the shrinking target ---------------- */
  // Difficulty is a ramp over the target INDEX, not the clock, so a slow
  // player is never punished twice: targets get smaller and shorter-lived
  // as you clear more of them, flattening out by the 24th.
  function strikeLevel(i) { return clamp((i | 0) / 24, 0, 1); }

  function strikeTarget(seed, i, arena) {
    var lvl = strikeLevel(i);
    var base = Math.min(arena.w, arena.h);
    var r = Math.max(18, lerp(0.085, 0.05, lvl) * base);
    var m = r + 10; // keep the whole disc inside the arena
    var x = m + rand01(seed + ':sx:' + i) * Math.max(1, arena.w - 2 * m);
    var y = m + rand01(seed + ':sy:' + i) * Math.max(1, arena.h - 2 * m);
    var ttl = Math.round(lerp(1900, 1100, lvl));
    return { i: i | 0, x: round1(x), y: round1(y), r: round1(r), ttl: ttl };
  }

  // The disc shrinks linearly to a quarter of its born size over its life,
  // then expires — so "late" and "small" are the same pressure.
  function strikeRadiusAt(target, elapsedMs) {
    var t = clamp(elapsedMs / target.ttl, 0, 1);
    return target.r * (1 - 0.75 * t);
  }

  var TAP_PAD = 12; // fat-finger forgiveness, in px, around the live disc

  function judgeStrike(target, tapX, tapY, elapsedMs) {
    if (elapsedMs >= target.ttl) return { hit: false, reason: 'expired' };
    var rNow = strikeRadiusAt(target, elapsedMs);
    var d = Math.hypot(tapX - target.x, tapY - target.y);
    if (d > rNow + TAP_PAD) return { hit: false, reason: 'miss', dist: round1(d) };
    var precision = clamp(1 - d / (rNow + TAP_PAD), 0, 1);
    var speed = clamp(1 - elapsedMs / target.ttl, 0, 1);
    var ring = precision > 0.66 ? 'bull' : precision > 0.33 ? 'inner' : 'edge';
    return {
      hit: true, ring: ring,
      precision: round2(precision), speed: round2(speed),
      points: Math.round(10 + 10 * precision + 10 * speed),
      reactMs: Math.round(elapsedMs)
    };
  }

  // Every 5 hits in a row raises the multiplier by ×0.5, capped at ×3.
  function comboMult(streak) {
    return Math.min(3, 1 + Math.floor(Math.max(0, streak | 0) / 5) * 0.5);
  }

  // events, in play order: judgeStrike results plus {hit:false,reason:'expired'}
  // for targets that ran out. The combo lives here so it's pure and tested.
  function strikeSummary(events) {
    var hits = 0, faults = 0, streak = 0, best = 0, score = 0, reactSum = 0;
    for (var i = 0; i < (events || []).length; i++) {
      var e = events[i];
      if (e && e.hit) {
        score += Math.round((e.points || 0) * comboMult(streak));
        streak++; hits++;
        if (streak > best) best = streak;
        reactSum += e.reactMs || 0;
      } else {
        faults++; streak = 0;
      }
    }
    var total = hits + faults;
    return {
      hits: hits, faults: faults,
      accuracy: total ? Math.round(100 * hits / total) : 0,
      avgReactMs: hits ? Math.round(reactSum / hits) : 0,
      bestStreak: best, score: score
    };
  }

  /* ---------------- Pursuit: keep your finger on the ball ---------------- */
  // The path is a seeded two-tone Lissajous per axis whose clock runs on a
  // gentle chirp (time stretches by ~50% over a 30s run), so the ball
  // swoops lazily at first and gets twitchier — fully deterministic.
  function pursuitRadius(arena) {
    return Math.max(22, 0.07 * Math.min(arena.w, arena.h));
  }

  function pursuitPos(seed, tMs, arena) {
    var t = (tMs / 1000) * (1 + tMs / 120000); // the chirp
    var fx1 = 0.10 + rand01(seed + ':fx1') * 0.07;
    var fx2 = 0.21 + rand01(seed + ':fx2') * 0.09;
    var fy1 = 0.12 + rand01(seed + ':fy1') * 0.07;
    var fy2 = 0.24 + rand01(seed + ':fy2') * 0.09;
    var p1 = rand01(seed + ':p1') * 6.28318, p2 = rand01(seed + ':p2') * 6.28318;
    var p3 = rand01(seed + ':p3') * 6.28318, p4 = rand01(seed + ':p4') * 6.28318;
    var nx = 0.5 + 0.34 * Math.sin(6.28318 * fx1 * t + p1) + 0.15 * Math.sin(6.28318 * fx2 * t + p2);
    var ny = 0.5 + 0.34 * Math.sin(6.28318 * fy1 * t + p3) + 0.15 * Math.sin(6.28318 * fy2 * t + p4);
    var r = pursuitRadius(arena);
    var m = r + 8;
    return {
      x: round1(m + clamp(nx, 0, 1) * Math.max(1, arena.w - 2 * m)),
      y: round1(m + clamp(ny, 0, 1) * Math.max(1, arena.h - 2 * m)),
      r: round1(r)
    };
  }

  // One frame's verdict: "on the ball" is the disc plus a 25% grace halo.
  function pursuitSample(ball, px, py) {
    var d = Math.hypot(px - ball.x, py - ball.y);
    return { on: d <= ball.r * 1.25, dist: round1(d) };
  }

  function pursuitSummary(samples, durationMs) {
    var n = (samples || []).length;
    var on = 0, run = 0, bestRun = 0, distOnSum = 0;
    for (var i = 0; i < n; i++) {
      if (samples[i] && samples[i].on) {
        on++; run++; distOnSum += samples[i].dist || 0;
        if (run > bestRun) bestRun = run;
      } else run = 0;
    }
    var frac = n ? on / n : 0;
    return {
      samples: n,
      onPct: Math.round(100 * frac),
      longestHoldMs: n ? Math.round(durationMs * bestRun / n) : 0,
      avgDistOn: on ? round1(distOnSum / on) : 0,
      // quadratic-ish: gluing beats grazing — 100% hold = 1000, 50% = 375
      score: Math.round(500 * frac * (1 + frac))
    };
  }

  /* ---------------- Reflex: tap the instant it says GO ---------------- */
  function reflexDelay(seed, round) {
    return Math.round(1200 + rand01(seed + ':wait:' + round) * 2400);
  }

  var REFLEX_BANDS = [
    { max: 180,      key: 'lightning', label: 'Lightning',  emoji: '⚡', points: 100 },
    { max: 250,      key: 'sharp',     label: 'Sharp',      emoji: '🎯', points: 80 },
    { max: 350,      key: 'solid',     label: 'Solid',      emoji: '👍', points: 60 },
    { max: 500,      key: 'late',      label: 'A beat late', emoji: '🐢', points: 35 },
    { max: Infinity, key: 'asleep',    label: 'Wake up!',   emoji: '😴', points: 10 }
  ];

  // ms since GO; negative means the tap landed before the signal.
  function judgeReflex(ms) {
    if (ms < 0) return { key: 'false', label: 'False start', emoji: '😬', points: 0, ms: -1 };
    for (var i = 0; i < REFLEX_BANDS.length; i++) {
      if (ms < REFLEX_BANDS[i].max) {
        var b = REFLEX_BANDS[i];
        return { key: b.key, label: b.label, emoji: b.emoji, points: b.points, ms: Math.round(ms) };
      }
    }
  }

  // times: one entry per round, ms since GO, or -1 for a false start.
  function reflexSummary(times) {
    var valid = [], score = 0, falseStarts = 0;
    for (var i = 0; i < (times || []).length; i++) {
      var t = times[i];
      if (t < 0) { falseStarts++; continue; }
      valid.push(t);
      score += judgeReflex(t).points;
    }
    valid.sort(function (a, b) { return a - b; });
    var median = 0;
    if (valid.length) {
      var mid = valid.length >> 1;
      median = valid.length % 2 ? valid[mid] : Math.round((valid[mid - 1] + valid[mid]) / 2);
    }
    return {
      rounds: (times || []).length, falseStarts: falseStarts,
      bestMs: valid.length ? Math.round(valid[0]) : 0,
      medianMs: Math.round(median),
      score: score
    };
  }

  /* ---------------- Chain: numbered targets, one order ---------------- */
  // Deterministic layout with a min-separation rule: each disc tries up to
  // 30 seeded spots and keeps the first that clears every earlier disc by
  // 2.3 radii (the last try always sticks, so layout never fails).
  function chainLayout(seed, round, n, arena) {
    var r = Math.max(20, 0.055 * Math.min(arena.w, arena.h));
    var m = r + 10;
    var targets = [];
    for (var i = 0; i < n; i++) {
      var x = 0, y = 0;
      for (var a = 0; a < 30; a++) {
        x = m + rand01(seed + ':cx:' + round + ':' + i + ':' + a) * Math.max(1, arena.w - 2 * m);
        y = m + rand01(seed + ':cy:' + round + ':' + i + ':' + a) * Math.max(1, arena.h - 2 * m);
        var clear = true;
        for (var j = 0; j < targets.length; j++) {
          if (Math.hypot(x - targets[j].x, y - targets[j].y) < 2.3 * r) { clear = false; break; }
        }
        if (clear) break;
      }
      targets.push({ n: i + 1, x: round1(x), y: round1(y) });
    }
    return { r: round1(r), targets: targets };
  }

  // Par is 900ms per target; beating par scales the round up to ×1.5,
  // dawdling scales it down to ×0.25. Wrong taps take a bite afterwards.
  function chainScore(n, elapsedMs, mistakes) {
    var par = n * 900;
    var timeFactor = clamp(par / Math.max(1, elapsedMs), 0.25, 1.5);
    return Math.max(0, Math.round(n * 20 * timeFactor) - 10 * (mistakes | 0));
  }

  // rounds: [{n, elapsedMs, mistakes}] — one per completed chain.
  function chainSummary(rounds) {
    var score = 0, mistakes = 0, timeSum = 0, targets = 0;
    for (var i = 0; i < (rounds || []).length; i++) {
      var r = rounds[i];
      score += chainScore(r.n, r.elapsedMs, r.mistakes);
      mistakes += r.mistakes | 0;
      timeSum += r.elapsedMs;
      targets += r.n | 0;
    }
    return {
      rounds: (rounds || []).length, mistakes: mistakes,
      avgPerTargetMs: targets ? Math.round(timeSum / targets) : 0,
      score: score
    };
  }

  /* ---------------- progression: XP and ranks ---------------- */
  // Each drill's score lands on its own scale, so XP normalises them:
  // a decent run of anything is worth roughly 100 XP.
  function xpFor(drillKey, score) {
    var s = Math.max(0, score | 0);
    if (drillKey === 'strike') return Math.round(s / 6);
    if (drillKey === 'pursuit') return Math.round(s / 6);
    if (drillKey === 'reflex') return Math.round(s / 3.5);
    if (drillKey === 'chain') return Math.round(s / 3.5);
    return Math.round(s / 6);
  }

  var RANKS = [
    { min: 0,    name: 'Butterfingers', emoji: '🧤', hint: 'Everyone starts here. Run one drill — any drill.' },
    { min: 250,  name: 'Rally Rookie',  emoji: '🏓', hint: 'Hands and eyes are on speaking terms.' },
    { min: 800,  name: 'Quick Hands',   emoji: '🫰', hint: 'You catch things people drop.' },
    { min: 2000, name: 'Sharpshooter',  emoji: '🎯', hint: 'Targets feel bigger than they are.' },
    { min: 4500, name: 'Deadeye',       emoji: '🦅', hint: 'The ball looks slow to you now.' },
    { min: 9000, name: 'Hawkeye',       emoji: '👁️', hint: 'The top of the ladder. Nothing gets past you.' }
  ];

  function rankFor(xp) {
    var n = Math.max(0, xp | 0);
    var cur = RANKS[0], next = null;
    for (var i = 0; i < RANKS.length; i++) {
      if (n >= RANKS[i].min) cur = RANKS[i];
      else { next = RANKS[i]; break; }
    }
    var progress = 1;
    if (next) progress = (n - cur.min) / (next.min - cur.min);
    return {
      name: cur.name, emoji: cur.emoji, hint: cur.hint, min: cur.min,
      next: next ? { name: next.name, min: next.min, needed: next.min - n } : null,
      progress: clamp(progress, 0, 1)
    };
  }

  /* ---------------- the daily drill ---------------- */
  function dailyDrill(isoDate) {
    var idx = hashStr('volley-day:' + String(isoDate)) % DRILLS.length;
    return { date: String(isoDate), drill: DRILLS[idx], index: idx };
  }

  /* ---------------- history: bests and trend ---------------- */
  // history: [{drill, score, ts}], any order.
  function personalBests(history) {
    var bests = {};
    for (var i = 0; i < (history || []).length; i++) {
      var h = history[i];
      if (!h || !h.drill) continue;
      if (!bests[h.drill] || h.score > bests[h.drill].score) {
        bests[h.drill] = { score: h.score | 0, ts: h.ts || 0 };
      }
    }
    return bests;
  }

  // Compare the mean of the latest 3 runs of a drill against the 3 before
  // them; needs at least 4 runs to say anything.
  function trendFor(history, drillKey) {
    var runs = [];
    for (var i = 0; i < (history || []).length; i++) {
      if (history[i] && history[i].drill === drillKey) runs.push(history[i]);
    }
    runs.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    if (runs.length < 4) return { dir: 'flat', pct: 0, runs: runs.length };
    var recent = runs.slice(-3), before = runs.slice(0, -3).slice(-3);
    var avg = function (xs) {
      var s = 0; for (var j = 0; j < xs.length; j++) s += xs[j].score || 0;
      return s / xs.length;
    };
    var a = avg(before), b = avg(recent);
    if (a <= 0) return { dir: b > 0 ? 'up' : 'flat', pct: 0, runs: runs.length };
    var pct = Math.round(100 * (b - a) / a);
    return { dir: pct > 3 ? 'up' : pct < -3 ? 'down' : 'flat', pct: pct, runs: runs.length };
  }

  /* ---------------- little formatters ---------------- */
  function formatMs(ms) {
    ms = Math.max(0, Math.round(ms || 0));
    if (ms < 1000) return ms + ' ms';
    return round1(ms / 1000) + ' s';
  }

  function timeAgo(ts, now) {
    var d = Math.max(0, (now || 0) - (ts || 0));
    if (d < MINUTE) return 'just now';
    if (d < HOUR) return Math.floor(d / MINUTE) + 'm ago';
    if (d < DAY) return Math.floor(d / HOUR) + 'h ago';
    if (d < 7 * DAY) return Math.floor(d / DAY) + 'd ago';
    return Math.floor(d / (7 * DAY)) + 'w ago';
  }

  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    DRILLS: DRILLS, RANKS: RANKS, TAP_PAD: TAP_PAD,
    hashStr: hashStr, rand01: rand01, clamp: clamp, lerp: lerp,
    drillByKey: drillByKey,
    strikeLevel: strikeLevel, strikeTarget: strikeTarget, strikeRadiusAt: strikeRadiusAt,
    judgeStrike: judgeStrike, comboMult: comboMult, strikeSummary: strikeSummary,
    pursuitRadius: pursuitRadius, pursuitPos: pursuitPos, pursuitSample: pursuitSample,
    pursuitSummary: pursuitSummary,
    reflexDelay: reflexDelay, judgeReflex: judgeReflex, reflexSummary: reflexSummary,
    chainLayout: chainLayout, chainScore: chainScore, chainSummary: chainSummary,
    xpFor: xpFor, rankFor: rankFor, dailyDrill: dailyDrill,
    personalBests: personalBests, trendFor: trendFor,
    formatMs: formatMs, timeAgo: timeAgo
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.VolleyEngine = E;
})(typeof self !== 'undefined' ? self : this);
