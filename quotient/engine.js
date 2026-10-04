/* Quotient — the pure adaptive IQ-test engine.
 * =====================================================================
 * Quotient is a computerised adaptive test (CAT) of general reasoning.
 * Six item families are GENERATED on the fly from a seed — matrix
 * reasoning, number series, mental rotation, working-memory span,
 * deductive logic and verbal reasoning — so no two sittings share items
 * and nothing can be memorised. Every item carries item-response-theory
 * (IRT) parameters (discrimination a, difficulty b, guessing c); ability
 * θ is estimated after every answer by expected-a-posteriori (EAP) under
 * a N(0,1) prior, the next item is drawn at the difficulty that is most
 * informative for the current estimate, and the sitting stops as soon as
 * the standard error is small enough. θ maps to the familiar IQ scale
 * (mean 100, SD 15) with an honest 95% confidence interval.
 *
 * Every rule lives HERE as pure, deterministic, clock-injected functions
 * with zero DOM and zero I/O — unit-tested in
 * scripts/test-quotient-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND;

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

  // mulberry32 seeded from the hash — a repeatable stream of floats in [0,1).
  function rng(seed) {
    var a = hashStr(seed) || 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rint(r, lo, hi) { return lo + Math.floor(r() * (hi - lo + 1)); }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
  function shuffle(r, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function sample(r, arr, k) { return shuffle(r, arr).slice(0, k); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round2(v) { return Math.round(v * 100) / 100; }

  /* ---------------- statistics ---------------- */

  // Standard normal CDF (Zelen & Severo), |error| < 7.5e-8.
  function normalCdf(z) {
    if (z < -8) return 0;
    if (z > 8) return 1;
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989422804014327 * Math.exp(-z * z / 2);
    var p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? 1 - p : p;
  }
  function normalPdf(z) { return 0.3989422804014327 * Math.exp(-z * z / 2); }

  /* ---------------- item response theory ---------------- */
  // Three-parameter logistic model. a: discrimination, b: difficulty (on the
  // θ scale, SD units), c: chance of a correct guess (1/options, 0 for recall).

  function probCorrect(theta, item) {
    var c = item.c || 0;
    return c + (1 - c) / (1 + Math.exp(-item.a * (theta - item.b)));
  }

  // Fisher information one item contributes at θ.
  function itemInfo(theta, item) {
    var c = item.c || 0;
    var p = probCorrect(theta, item), q = 1 - p;
    if (p <= 0 || p >= 1) return 0;
    var k = (p - c) / (1 - c);
    return item.a * item.a * (q / p) * k * k;
  }

  // A prior a little wider than the population's N(0,1) halves the shrinkage
  // of extreme scores toward the mean at a negligible cost in precision
  // (checked by simulation: bias at θ=±2 drops from ~0.4 to ~0.2 SD).
  var PRIOR_SD = 1.5;
  var GRID = [];
  for (var gi = -40; gi <= 40; gi++) GRID.push(gi / 10);

  // EAP estimate of θ with a normal prior: posterior mean and posterior SD.
  function estimateAbility(responses, prior) {
    var mu = (prior && typeof prior.mu === 'number') ? prior.mu : 0;
    var sd = (prior && typeof prior.sd === 'number') ? prior.sd : PRIOR_SD;
    var logw = new Array(GRID.length), mx = -Infinity, i, j;
    for (i = 0; i < GRID.length; i++) {
      var th = GRID[i], lw = -0.5 * Math.pow((th - mu) / sd, 2);
      for (j = 0; j < responses.length; j++) {
        var p = probCorrect(th, responses[j]);
        p = clamp(p, 1e-6, 1 - 1e-6);
        lw += Math.log(responses[j].correct ? p : 1 - p);
      }
      logw[i] = lw;
      if (lw > mx) mx = lw;
    }
    var sum = 0, mean = 0;
    for (i = 0; i < GRID.length; i++) { logw[i] = Math.exp(logw[i] - mx); sum += logw[i]; mean += GRID[i] * logw[i]; }
    mean /= sum;
    var v = 0;
    for (i = 0; i < GRID.length; i++) v += (GRID[i] - mean) * (GRID[i] - mean) * logw[i];
    v /= sum;
    return { theta: Math.round(mean * 1000) / 1000, se: Math.round(Math.sqrt(v) * 1000) / 1000 };
  }

  /* ---------------- the IQ scale ---------------- */

  function iqFromTheta(theta) { return Math.round(100 + 15 * theta); }

  var BANDS = [
    { min: 130, label: 'Very high',     note: 'Roughly the top 2%.' },
    { min: 120, label: 'High',          note: 'Roughly the top 9%.' },
    { min: 110, label: 'High average',  note: 'Above about three quarters of people.' },
    { min: 90,  label: 'Average',       note: 'Where half of all people score.' },
    { min: 80,  label: 'Low average',   note: 'Below about three quarters of people.' },
    { min: 70,  label: 'Low',           note: 'Roughly the bottom 9%.' },
    { min: -Infinity, label: 'Very low', note: 'Roughly the bottom 2%.' }
  ];
  function bandFor(iq) {
    for (var i = 0; i < BANDS.length; i++) if (iq >= BANDS[i].min) return BANDS[i];
    return BANDS[BANDS.length - 1];
  }

  // "About 1 in N people" score at least this far from the mean, on this side.
  function rarity(theta) {
    var p = normalCdf(theta);
    var tail = theta >= 0 ? 1 - p : p;
    return Math.max(1, Math.round(1 / Math.max(tail, 1e-9)));
  }

  function percentile(theta) { return Math.round(normalCdf(theta) * 1000) / 10; }

  /* ---------------- domains ---------------- */

  var DOMAINS = [
    { key: 'matrix',  label: 'Matrix reasoning', short: 'Matrix',  a: 1.3, cultureFair: true,  timeLimitMs: 90 * SECOND,
      levels: [-1.85, -1.15, -0.8, -0.1, 0.3, 1.0, 2.0] },
    { key: 'series',  label: 'Number series',    short: 'Series',  a: 1.1, cultureFair: true,  timeLimitMs: 75 * SECOND,
      levels: [-2.0, -1.3, -0.6, 0.1, 0.8, 1.5, 2.2] },
    { key: 'spatial', label: 'Mental rotation',  short: 'Spatial', a: 1.0, cultureFair: true,  timeLimitMs: 60 * SECOND,
      levels: [-1.4, -0.6, 0.2, 1.0, 1.8] },
    { key: 'memory',  label: 'Working memory',   short: 'Memory',  a: 1.0, cultureFair: true,  timeLimitMs: 45 * SECOND,
      levels: [-1.8, -1.2, -1.0, -0.4, -0.2, 0.4, 0.6, 1.2, 1.4, 2.0, 2.2, 2.8] },
    { key: 'logic',   label: 'Deductive logic',  short: 'Logic',   a: 1.0, cultureFair: false, timeLimitMs: 75 * SECOND,
      levels: [-2.0, -1.5, -0.8, -0.6, -0.5, 0.3, 0.4, 0.5, 0.8, 0.9, 1.2, 1.4, 1.8, 2.2, 2.4] },
    { key: 'verbal',  label: 'Verbal reasoning', short: 'Verbal',  a: 0.9, cultureFair: false, timeLimitMs: 45 * SECOND,
      levels: [-2.2, -1.6, -1.0, -0.4, 0.2, 0.8, 1.4, 2.0] }
  ];
  function domainByKey(key) {
    for (var i = 0; i < DOMAINS.length; i++) if (DOMAINS[i].key === key) return DOMAINS[i];
    return null;
  }

  var INSTRUCTIONS = {
    matrix: { title: 'Matrix reasoning',
      text: 'Each puzzle is a 3 × 3 grid of shapes that follows a set of rules across the rows. One cell is missing. Work out the rules and choose the option that completes the grid.',
      tip: 'Look at one property at a time — shape, how many, shading, size, tilt — and ask how it changes along a row.' },
    series: { title: 'Number series',
      text: 'A row of numbers follows a rule. Work out the rule and choose the number that comes next.',
      tip: 'Check the differences between neighbours first; if they aren’t constant, check how the differences change, or whether two sequences are interleaved.' },
    spatial: { title: 'Mental rotation',
      text: 'You’ll see a target figure and four candidates. Exactly one candidate is the target rotated on the page. The others are mirror images. Choose the rotation.',
      tip: 'Mirror images can never be turned into the original by rotating — they are its reflection.' },
    memory: { title: 'Working memory',
      text: 'Digits will appear one at a time. When they stop, type them back — in the order shown, or in reverse order when the screen says so.',
      tip: 'Group the digits into chunks of two or three as they arrive.' },
    logic: { title: 'Deductive logic',
      text: 'Assume the statements are true, however odd they sound. Choose the one conclusion that must follow — or “nothing can be concluded” when nothing does.',
      tip: '“All”, “No” and “Some” mean exactly what they say. Don’t add knowledge from outside the statements.' },
    verbal: { title: 'Verbal reasoning',
      text: 'Complete the analogy (A is to B as C is to ?), or find the word that doesn’t belong with the others.',
      tip: 'Name the relationship in the first pair before you look at the options.' }
  };

  /* ================================================================
   *  1. MATRIX REASONING — generated 3×3 grids with row rules
   * ================================================================ */

  var ATTRS = ['shape', 'count', 'fill', 'size', 'rot'];
  var SHAPES = ['circle', 'square', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star'];
  var ROT_OK = ['triangle', 'square', 'pentagon', 'star']; // tilt is visible at 0/30/60°
  var FILLS = ['none', 'solid', 'half', 'grey'];
  var SIZES = ['s', 'm', 'l'];
  var COUNTS = [1, 2, 3];
  var ROTS = [0, 1, 2];
  var RULE_W = { row: 0.45, prog: 0.7, dist3: 1.0 };
  var MATRIX_PLANS = [
    null,
    [['prog'], ['row']],
    [['row', 'prog'], ['prog', 'prog']],
    [['prog', 'dist3'], ['row', 'dist3']],
    [['row', 'prog', 'dist3'], ['prog', 'prog', 'dist3']],
    [['dist3', 'dist3', 'prog'], ['dist3', 'dist3', 'row']],
    [['dist3', 'dist3', 'prog', 'prog'], ['dist3', 'dist3', 'prog', 'row']],
    [['dist3', 'dist3', 'dist3', 'prog', 'prog'], ['dist3', 'dist3', 'dist3', 'prog', 'row']]
  ];
  var RULE_TEXT = {
    row: 'stays the same along each row',
    prog: 'steps through the same order along each row',
    dist3: 'appears once in each of its three values in every row'
  };
  var ATTR_TEXT = { shape: 'Shape', count: 'The number of shapes', fill: 'Shading', size: 'Size', rot: 'Tilt' };
  var PERMS3 = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

  // Rotation is invisible on a circle, so it never counts as a difference there.
  function canonCell(c) {
    var out = { shape: c.shape, count: c.count, fill: c.fill, size: c.size, rot: c.rot };
    if (ROT_OK.indexOf(out.shape) < 0) out.rot = 0;
    return out;
  }
  function cellKey(c) { var k = canonCell(c); return k.shape + '|' + k.count + '|' + k.fill + '|' + k.size + '|' + k.rot; }

  function genMatrix(seed, level) {
    level = clamp(Math.round(level), 1, 7);
    var r = rng('matrix:' + seed + ':' + level);
    var plan = pick(r, MATRIX_PLANS[level]);
    var active = sample(r, ATTRS, plan.length);
    var rules = {}, i, a;
    for (i = 0; i < active.length; i++) rules[active[i]] = plan[i];
    var rotActive = rules.rot !== undefined;
    var shapePool = rotActive ? ROT_OK : SHAPES;

    // the values each attribute can take in this puzzle
    var vals = {
      shape: rules.shape ? sample(r, shapePool, 3) : [pick(r, shapePool)],
      count: rules.count ? COUNTS.slice() : [pick(r, [1, 2])],
      fill:  rules.fill ? sample(r, FILLS, 3) : [pick(r, FILLS)],
      size:  rules.size ? SIZES.slice() : [pick(r, ['m', 'l'])],
      rot:   rules.rot ? ROTS.slice() : [0]
    };

    // index grids per attribute
    var idx = {};
    for (a = 0; a < ATTRS.length; a++) {
      var attr = ATTRS[a], rule = rules[attr], g = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], row, col;
      if (rule === 'row') {
        var rv = shuffle(r, [0, 1, 2]);
        for (row = 0; row < 3; row++) for (col = 0; col < 3; col++) g[row][col] = rv[row];
      } else if (rule === 'prog') {
        var off = shuffle(r, [0, 1, 2]), dir = pick(r, [1, 2]);
        for (row = 0; row < 3; row++) for (col = 0; col < 3; col++) g[row][col] = (off[row] + dir * col) % 3;
      } else if (rule === 'dist3') {
        var perms = sample(r, PERMS3, 3);
        for (row = 0; row < 3; row++) for (col = 0; col < 3; col++) g[row][col] = perms[row][col];
      }
      idx[attr] = g;
    }
    var cells = [];
    for (i = 0; i < 9; i++) {
      var rr = Math.floor(i / 3), cc = i % 3;
      cells.push({
        shape: vals.shape[idx.shape[rr][cc]],
        count: vals.count[idx.count[rr][cc]],
        fill:  vals.fill[idx.fill[rr][cc]],
        size:  vals.size[idx.size[rr][cc]],
        rot:   vals.rot[idx.rot[rr][cc]]
      });
    }
    var answer = cells[8];
    var answerKey = cellKey(answer);

    // distractors: the answer with one or two properties changed
    var seen = {}; seen[answerKey] = true;
    var distractors = [], tries = 0;
    var pools = {
      shape: rules.shape ? vals.shape : shapePool,
      count: COUNTS, fill: FILLS, size: SIZES,
      rot: ROTS
    };
    while (distractors.length < 7 && tries++ < 400) {
      var d = { shape: answer.shape, count: answer.count, fill: answer.fill, size: answer.size, rot: answer.rot };
      var k = r() < 0.6 ? 1 : 2;
      var which = sample(r, ATTRS, k), changed = 0;
      for (i = 0; i < which.length; i++) {
        var at = which[i];
        if (at === 'rot' && ROT_OK.indexOf(d.shape) < 0) continue;
        var others = pools[at].filter(function (v) { return v !== d[at]; });
        if (!others.length) continue;
        d[at] = pick(r, others);
        changed++;
      }
      if (!changed) continue;
      var dk = cellKey(d);
      if (seen[dk]) continue;
      seen[dk] = true;
      distractors.push(canonCell(d));
    }
    var options = shuffle(r, distractors.concat([canonCell(answer)]));
    var answerIndex = -1;
    for (i = 0; i < options.length; i++) if (cellKey(options[i]) === answerKey) answerIndex = i;

    var b = -2.4, ruleLines = [];
    for (i = 0; i < active.length; i++) {
      b += RULE_W[rules[active[i]]] + (i > 0 ? 0.15 : 0);
      ruleLines.push(ATTR_TEXT[active[i]] + ' ' + RULE_TEXT[rules[active[i]]] + '.');
    }
    var dom = domainByKey('matrix');
    return {
      domain: 'matrix', kind: 'matrix', type: 'choice', level: level,
      a: dom.a, b: round2(clamp(b, -2.6, 2.8)), c: 1 / 8,
      prompt: 'Which option completes the grid?',
      cells: cells.slice(0, 8).map(canonCell), grid: idx, rules: rules, values: vals,
      options: options, answer: answerIndex,
      explanation: ruleLines.join(' '),
      summary: 'Matrix with ' + active.length + ' rule' + (active.length === 1 ? '' : 's') + ' (' + active.join(', ') + ')'
    };
  }

  /* ---- pure SVG rendering of a matrix cell ---- */
  var INK = '#1d2040', GREY = '#a3a8bd';
  function fmt(n) { return Math.round(n * 100) / 100; }
  function polyPoints(cx, cy, R, n, rotDeg) {
    var pts = [];
    for (var k = 0; k < n; k++) {
      var ang = (-90 + rotDeg + 360 * k / n) * Math.PI / 180;
      pts.push(fmt(cx + R * Math.cos(ang)) + ',' + fmt(cy + R * Math.sin(ang)));
    }
    return pts.join(' ');
  }
  function starPoints(cx, cy, R, rotDeg) {
    var pts = [];
    for (var k = 0; k < 10; k++) {
      var rad = k % 2 === 0 ? R : R * 0.45;
      var ang = (-90 + rotDeg + 36 * k) * Math.PI / 180;
      pts.push(fmt(cx + rad * Math.cos(ang)) + ',' + fmt(cy + rad * Math.sin(ang)));
    }
    return pts.join(' ');
  }
  function shapeEl(shape, cx, cy, R, rotDeg, fill, stroke) {
    var attrs = ' fill="' + fill + '" stroke="' + stroke + '" stroke-width="3" stroke-linejoin="round"';
    if (shape === 'circle') return '<circle cx="' + fmt(cx) + '" cy="' + fmt(cy) + '" r="' + fmt(R) + '"' + attrs + '/>';
    var pts;
    if (shape === 'square') pts = polyPoints(cx, cy, R, 4, rotDeg + 45);
    else if (shape === 'diamond') pts = polyPoints(cx, cy, R, 4, rotDeg);
    else if (shape === 'triangle') pts = polyPoints(cx, cy, R, 3, rotDeg);
    else if (shape === 'pentagon') pts = polyPoints(cx, cy, R, 5, rotDeg);
    else if (shape === 'hexagon') pts = polyPoints(cx, cy, R, 6, rotDeg);
    else pts = starPoints(cx, cy, R, rotDeg);
    return '<polygon points="' + pts + '"' + attrs + '/>';
  }
  var CELL_POS = { 1: [[50, 50]], 2: [[30, 50], [70, 50]], 3: [[50, 28], [28, 70], [72, 70]] };
  var CELL_SCALE = { 1: 1, 2: 0.72, 3: 0.62 };
  var SIZE_R = { s: 12, m: 18, l: 25 };

  function cellSVG(spec, extraClass) {
    if (!spec) return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="qcell ' + (extraClass || '') + '"><text x="50" y="62" text-anchor="middle" font-size="40" fill="' + GREY + '">?</text></svg>';
    var c = canonCell(spec);
    var R = SIZE_R[c.size] * CELL_SCALE[c.count];
    var rot = c.rot * 30;
    var out = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="qcell ' + (extraClass || '') + '">';
    var pos = CELL_POS[c.count];
    for (var i = 0; i < pos.length; i++) {
      var cx = pos[i][0], cy = pos[i][1];
      if (c.fill === 'solid') out += shapeEl(c.shape, cx, cy, R, rot, INK, INK);
      else if (c.fill === 'grey') out += shapeEl(c.shape, cx, cy, R, rot, GREY, INK);
      else if (c.fill === 'half') {
        out += shapeEl(c.shape, cx, cy, R, rot, INK, INK);
        out += '<rect x="' + fmt(cx) + '" y="' + fmt(cy - R - 2) + '" width="' + fmt(R + 3) + '" height="' + fmt(2 * R + 4) + '" fill="#fff"/>';
        out += shapeEl(c.shape, cx, cy, R, rot, 'none', INK);
      } else out += shapeEl(c.shape, cx, cy, R, rot, '#fff', INK);
    }
    return out + '</svg>';
  }

  /* ================================================================
   *  2. NUMBER SERIES
   * ================================================================ */

  var PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43];
  var SERIES_KINDS = [null,
    ['arith'], ['geo', 'arithNeg'], ['alt'], ['second'], ['squares', 'primes'], ['fib', 'affine'], ['geoDiff', 'nsq', 'altGeo']];
  var SERIES_ADJ = { arith: 0, arithNeg: 0.1, geo: 0, alt: 0, second: 0, squares: 0, primes: 0.2, fib: 0, affine: 0.15, geoDiff: 0.1, nsq: 0, altGeo: 0.1 };

  function seriesTerms(r, kind, n) {
    var t = [], i, a0, d, q, x;
    if (kind === 'arith') { a0 = rint(r, 1, 15); d = rint(r, 2, 9); for (i = 0; i < n; i++) t.push(a0 + i * d); return { terms: t, rule: 'Add ' + d + ' each time.' }; }
    if (kind === 'arithNeg') { a0 = rint(r, 60, 95); d = rint(r, 3, 9); for (i = 0; i < n; i++) t.push(a0 - i * d); return { terms: t, rule: 'Subtract ' + d + ' each time.' }; }
    if (kind === 'geo') { a0 = rint(r, 1, 4); q = pick(r, [2, 3]); x = a0; for (i = 0; i < n; i++) { t.push(x); x *= q; } return { terms: t, rule: 'Multiply by ' + q + ' each time.' }; }
    if (kind === 'alt') {
      a0 = rint(r, 1, 10); var d1 = rint(r, 2, 6); var b0 = rint(r, 20, 40); var d2 = pick(r, [-5, -4, -3, -2, 2, 3, 4, 5]);
      for (i = 0; i < n; i++) t.push(i % 2 === 0 ? a0 + (i / 2) * d1 : b0 + ((i - 1) / 2) * d2);
      return { terms: t, rule: 'Two interleaved sequences: one adds ' + d1 + ', the other ' + (d2 < 0 ? 'subtracts ' + (-d2) : 'adds ' + d2) + '.' };
    }
    if (kind === 'second') {
      a0 = rint(r, 1, 10); d = rint(r, 1, 4); var dd = rint(r, 1, 3); x = a0;
      for (i = 0; i < n; i++) { t.push(x); x += d; d += dd; }
      return { terms: t, rule: 'The gaps grow by ' + dd + ' each time.' };
    }
    if (kind === 'squares') { var c = rint(r, -3, 3); var n0 = rint(r, 1, 3); for (i = 0; i < n; i++) t.push((n0 + i) * (n0 + i) + c); return { terms: t, rule: 'Square numbers' + (c ? (c > 0 ? ' plus ' + c : ' minus ' + (-c)) : '') + '.' }; }
    if (kind === 'primes') { var s = rint(r, 0, 3); for (i = 0; i < n; i++) t.push(PRIMES[s + i]); return { terms: t, rule: 'Consecutive prime numbers.' }; }
    if (kind === 'fib') { a0 = rint(r, 1, 5); var b1 = rint(r, 1, 6); t = [a0, b1]; while (t.length < n) t.push(t[t.length - 1] + t[t.length - 2]); return { terms: t, rule: 'Each number is the sum of the two before it.' }; }
    if (kind === 'affine') {
      var m = pick(r, [2, 3]); var k = pick(r, [-2, -1, 1, 2]); x = rint(r, 1, m === 3 ? 2 : 4); if (m === 3 && k === -2) k = -1;
      for (i = 0; i < n; i++) { t.push(x); x = m * x + k; }
      return { terms: t, rule: 'Multiply by ' + m + ' then ' + (k > 0 ? 'add ' + k : 'subtract ' + (-k)) + '.' };
    }
    if (kind === 'geoDiff') { a0 = rint(r, 1, 5); d = rint(r, 1, 3); x = a0; for (i = 0; i < n; i++) { t.push(x); x += d; d *= 2; } return { terms: t, rule: 'The gaps double each time.' }; }
    if (kind === 'nsq') { var n1 = rint(r, 1, 3); for (i = 0; i < n; i++) { var m1 = n1 + i; t.push(m1 * m1 + m1); } return { terms: t, rule: 'Each term is n × (n + 1): the gaps grow by 2.' }; }
    // altGeo
    a0 = rint(r, 1, 3); var b2 = rint(r, 5, 15); var d3 = rint(r, 2, 5);
    for (i = 0; i < n; i++) t.push(i % 2 === 0 ? a0 * Math.pow(2, i / 2) : b2 + ((i - 1) / 2) * d3);
    return { terms: t, rule: 'Two interleaved sequences: one doubles, the other adds ' + d3 + '.' };
  }

  function genSeries(seed, level) {
    level = clamp(Math.round(level), 1, 7);
    var r = rng('series:' + seed + ':' + level);
    var kind = pick(r, SERIES_KINDS[level]);
    var s = seriesTerms(r, kind, 7);
    var shown = s.terms.slice(0, 6), ans = s.terms[6];
    var last = shown[5], prev = shown[4], diff = last - prev;
    var cands = [ans + 1, ans - 1, ans + 2, ans - 2, last + diff, ans + diff, last * 2, ans + 10, ans - 10, ans + 3, ans - 3, ans + 2 * diff, last + 2 * diff + 1];
    var seen = {}; seen[ans] = true; var pool = [];
    for (var i = 0; i < cands.length; i++) { var v = cands[i]; if (!seen[v] && Number.isInteger(v)) { seen[v] = true; pool.push(v); } }
    var options = shuffle(r, sample(r, pool, 4).concat([ans]));
    var dom = domainByKey('series');
    return {
      domain: 'series', kind: kind, type: 'choice', level: level,
      a: dom.a, b: round2(dom.levels[level - 1] + SERIES_ADJ[kind]), c: 1 / 5,
      prompt: 'What number comes next?', terms: shown,
      options: options, answer: options.indexOf(ans),
      explanation: s.rule + ' Next: ' + ans + '.',
      summary: 'Series ' + shown.join(', ') + ', … → ' + ans
    };
  }

  /* ================================================================
   *  3. MENTAL ROTATION — chiral polyominoes
   * ================================================================ */

  function normFig(cells) {
    var minR = Infinity, minC = Infinity, i;
    for (i = 0; i < cells.length; i++) { if (cells[i][0] < minR) minR = cells[i][0]; if (cells[i][1] < minC) minC = cells[i][1]; }
    var out = cells.map(function (c) { return [c[0] - minR, c[1] - minC]; });
    out.sort(function (p, q) { return p[0] - q[0] || p[1] - q[1]; });
    return out;
  }
  function figKey(cells) { return normFig(cells).map(function (c) { return c[0] + ',' + c[1]; }).join(';'); }
  function figDims(cells) {
    var h = 0, w = 0;
    for (var i = 0; i < cells.length; i++) { if (cells[i][0] + 1 > h) h = cells[i][0] + 1; if (cells[i][1] + 1 > w) w = cells[i][1] + 1; }
    return { h: h, w: w };
  }
  function rotFig(cells) { // 90° clockwise
    var n = normFig(cells), d = figDims(n);
    return normFig(n.map(function (c) { return [c[1], d.h - 1 - c[0]]; }));
  }
  function mirrorFig(cells) {
    var n = normFig(cells), d = figDims(n);
    return normFig(n.map(function (c) { return [c[0], d.w - 1 - c[1]]; }));
  }
  function rotN(cells, k) { var f = normFig(cells); for (var i = 0; i < k; i++) f = rotFig(f); return f; }
  function isChiral(cells) {
    var m = mirrorFig(cells), k0 = figKey(cells);
    for (var k = 0; k < 4; k++) if (figKey(rotN(m, k)) === k0) return false;
    return true;
  }
  function hasRotSymmetry(cells) {
    var k0 = figKey(cells);
    for (var k = 1; k < 4; k++) if (figKey(rotN(cells, k)) === k0) return true;
    return false;
  }
  function growFigure(r, n, G) {
    for (var attempt = 0; attempt < 60; attempt++) {
      var set = {}, cells = [], start = [Math.floor(G / 2), Math.floor(G / 2)];
      set[start.join(',')] = true; cells.push(start);
      var guard = 0;
      while (cells.length < n && guard++ < 200) {
        var base = pick(r, cells), dir = pick(r, [[1, 0], [-1, 0], [0, 1], [0, -1]]);
        var nr = base[0] + dir[0], nc = base[1] + dir[1];
        if (nr < 0 || nc < 0 || nr >= G || nc >= G) continue;
        var key = nr + ',' + nc;
        if (set[key]) continue;
        set[key] = true; cells.push([nr, nc]);
      }
      if (cells.length !== n) continue;
      var f = normFig(cells);
      if (isChiral(f) && !hasRotSymmetry(f)) return f;
    }
    return null;
  }

  function genSpatial(seed, level) {
    level = clamp(Math.round(level), 1, 5);
    var n = level + 3; // 4..8 cells
    var G = n <= 6 ? 4 : 5;
    var r = rng('spatial:' + seed + ':' + level);
    var fig = growFigure(r, n, G);
    if (!fig) fig = normFig([[0, 0], [1, 0], [2, 0], [2, 1]].concat(n > 4 ? [[0, 1]] : []));
    var k = pick(r, [1, 2, 3]);
    var correct = rotN(fig, k);
    var m = mirrorFig(fig), mirrors = [], seen = {}, i;
    for (i = 0; i < 4; i++) { var mk = rotN(m, i), key = figKey(mk); if (!seen[key]) { seen[key] = true; mirrors.push(mk); } }
    var distractors = sample(r, mirrors, 3);
    var options = shuffle(r, distractors.concat([correct]));
    var answer = -1, ck = figKey(correct);
    for (i = 0; i < options.length; i++) if (figKey(options[i]) === ck) answer = i;
    var dom = domainByKey('spatial');
    return {
      domain: 'spatial', kind: 'rotation', type: 'choice', level: level,
      a: dom.a, b: round2(dom.levels[level - 1] + (k === 2 ? 0 : 0.3)), c: 1 / 4,
      prompt: 'Which figure is the target turned on the page (not flipped)?',
      target: fig, grid: G, turn: k * 90,
      options: options, answer: answer,
      explanation: 'Only one option is the target turned ' + (k * 90) + '°; the other three are mirror images, which no rotation can produce.',
      summary: n + '-cell figure, turned ' + (k * 90) + '°'
    };
  }

  function figureSVG(cells, G, extraClass) {
    var n = normFig(cells), d = figDims(n);
    G = Math.max(G || 0, d.h, d.w);
    var unit = 100 / G, ox = (G - d.w) * unit / 2, oy = (G - d.h) * unit / 2;
    var out = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="qfig ' + (extraClass || '') + '">';
    for (var i = 0; i < n.length; i++) {
      out += '<rect x="' + fmt(ox + n[i][1] * unit + 1) + '" y="' + fmt(oy + n[i][0] * unit + 1) + '" width="' + fmt(unit - 2) + '" height="' + fmt(unit - 2) + '" rx="2" fill="' + INK + '"/>';
    }
    // an anchor dot marks one specific cell so orientation is unambiguous
    var a = n[0];
    out += '<circle cx="' + fmt(ox + a[1] * unit + unit / 2) + '" cy="' + fmt(oy + a[0] * unit + unit / 2) + '" r="' + fmt(unit * 0.16) + '" fill="#fff"/>';
    return out + '</svg>';
  }

  /* ================================================================
   *  4. WORKING MEMORY — digit span, forward and backward
   * ================================================================ */

  var SPAN_VARIANTS = [
    { len: 4, back: false, b: -1.8 }, { len: 3, back: true, b: -1.2 }, { len: 5, back: false, b: -1.0 },
    { len: 4, back: true, b: -0.4 }, { len: 6, back: false, b: -0.2 }, { len: 5, back: true, b: 0.4 },
    { len: 7, back: false, b: 0.6 }, { len: 6, back: true, b: 1.2 }, { len: 8, back: false, b: 1.4 },
    { len: 7, back: true, b: 2.0 }, { len: 9, back: false, b: 2.2 }, { len: 8, back: true, b: 2.8 }
  ];

  function genSpan(seed, level) {
    level = clamp(Math.round(level), 1, SPAN_VARIANTS.length);
    var v = SPAN_VARIANTS[level - 1];
    var r = rng('memory:' + seed + ':' + level);
    var digits = [], last = -1;
    while (digits.length < v.len) { var d = rint(r, 0, 9); if (d === last) continue; digits.push(d); last = d; }
    var expected = (v.back ? digits.slice().reverse() : digits).join('');
    var dom = domainByKey('memory');
    return {
      domain: 'memory', kind: v.back ? 'backward' : 'forward', type: 'span', level: level,
      a: dom.a, b: v.b, c: 0,
      prompt: v.back ? 'Type the digits in REVERSE order.' : 'Type the digits in the order shown.',
      digits: digits, backward: v.back, presentMs: 1000, gapMs: 250,
      expected: expected,
      explanation: 'The digits were ' + digits.join(' ') + (v.back ? ', so reversed: ' + expected.split('').join(' ') : '') + '.',
      summary: v.len + ' digits ' + (v.back ? 'backward' : 'forward')
    };
  }
  function normalizeDigits(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }

  /* ================================================================
   *  5. DEDUCTIVE LOGIC — nonsense-noun syllogisms and conditionals
   * ================================================================ */

  var NOUNS = ['zork', 'blim', 'trell', 'quand', 'fribble', 'mock', 'lunt', 'wug', 'plonk', 'grib', 'snarl', 'wibble'];
  var NONE = 'Nothing can be concluded.';
  var LOGIC_FORMS = [
    { name: 'Modus ponens', b: -2.0, premises: ['If a thing is a {a}, then it is a {b}.', 'This thing is a {a}.'],
      valid: 'This thing is a {b}.', invalid: ['This thing is not a {b}.', 'This thing is a {b} only if it is also a {c}.', NONE] },
    { name: 'Universal chain', b: -1.5, premises: ['All {A} are {B}.', 'All {B} are {C}.'],
      valid: 'All {A} are {C}.', invalid: ['All {C} are {A}.', 'No {A} are {C}.', 'Some {C} are not {A}.'] },
    { name: 'Some-to-all', b: -0.8, premises: ['All {B} are {C}.', 'Some {A} are {B}.'],
      valid: 'Some {A} are {C}.', invalid: ['All {A} are {C}.', 'No {A} are {C}.', 'All {C} are {B}.'] },
    { name: 'Modus tollens', b: -0.6, premises: ['If a thing is a {a}, then it is a {b}.', 'This thing is not a {b}.'],
      valid: 'This thing is not a {a}.', invalid: ['This thing is a {a}.', 'This thing is a {b}.', NONE] },
    { name: 'Universal exclusion', b: -0.5, premises: ['No {B} are {C}.', 'All {A} are {B}.'],
      valid: 'No {A} are {C}.', invalid: ['All {A} are {C}.', 'Some {A} are {C}.', 'All {C} are {B}.'] },
    { name: 'Affirming the consequent (trap)', b: 0.3, premises: ['If a thing is a {a}, then it is a {b}.', 'This thing is a {b}.'],
      valid: NONE, invalid: ['This thing is a {a}.', 'This thing is not a {a}.', 'This thing is not a {b}.'] },
    { name: 'Exclusion, reversed', b: 0.4, premises: ['All {C} are {B}.', 'No {A} are {B}.'],
      valid: 'No {A} are {C}.', invalid: ['All {A} are {C}.', 'Some {A} are {C}.', 'All {B} are {C}.'] },
    { name: 'Denying the antecedent (trap)', b: 0.5, premises: ['If a thing is a {a}, then it is a {b}.', 'This thing is not a {a}.'],
      valid: NONE, invalid: ['This thing is not a {b}.', 'This thing is a {b}.', 'This thing is a {a}.'] },
    { name: 'Particular exclusion', b: 0.8, premises: ['No {B} are {C}.', 'Some {A} are {B}.'],
      valid: 'Some {A} are not {C}.', invalid: ['No {A} are {C}.', 'All {A} are {C}.', 'Some {C} are {B}.'] },
    { name: 'Some, reversed', b: 0.9, premises: ['Some {B} are {C}.', 'All {B} are {A}.'],
      valid: 'Some {A} are {C}.', invalid: ['All {A} are {C}.', 'All {C} are {A}.', 'No {A} are {C}.'] },
    { name: 'Undistributed middle (trap)', b: 1.2, premises: ['All {A} are {B}.', 'All {C} are {B}.'],
      valid: NONE, invalid: ['All {A} are {C}.', 'All {C} are {A}.', 'Some {A} are {C}.'] },
    { name: 'Some-not, from all', b: 1.4, premises: ['All {C} are {B}.', 'Some {A} are not {B}.'],
      valid: 'Some {A} are not {C}.', invalid: ['No {A} are {C}.', 'All {A} are {C}.', 'Some {C} are not {B}.'] },
    { name: 'Some-not, reversed', b: 1.8, premises: ['Some {B} are not {C}.', 'All {B} are {A}.'],
      valid: 'Some {A} are not {C}.', invalid: ['No {A} are {C}.', 'All {A} are {C}.', 'Some {C} are not {A}.'] },
    { name: 'Three-step chain', b: 2.2, premises: ['All {A} are {B}.', 'No {C} are {B}.', 'Some {D} are {A}.'],
      valid: 'Some {D} are not {C}.', invalid: ['No {D} are {C}.', 'All {D} are {C}.', 'Some {C} are {D}.'] },
    { name: 'Three-step some-not', b: 2.4, premises: ['All {A} are {B}.', 'All {B} are {C}.', 'Some {D} are not {C}.'],
      valid: 'Some {D} are not {A}.', invalid: ['Some {D} are {A}.', 'No {D} are {A}.', 'All {A} are {D}.'] }
  ];
  function fillNouns(tpl, map) {
    return tpl.replace(/\{([abcdABCD])\}/g, function (_m, k) {
      var noun = map[k.toLowerCase()];
      return k === k.toUpperCase() ? noun + 's' : noun;
    });
  }

  function genLogic(seed, level) {
    level = clamp(Math.round(level), 1, LOGIC_FORMS.length);
    var form = LOGIC_FORMS[level - 1];
    var r = rng('logic:' + seed + ':' + level);
    var ns = sample(r, NOUNS, 4), map = { a: ns[0], b: ns[1], c: ns[2], d: ns[3] };
    var premises = form.premises.map(function (p) { return fillNouns(p, map); });
    var valid = fillNouns(form.valid, map);
    var options = shuffle(r, form.invalid.map(function (p) { return fillNouns(p, map); }).concat([valid]));
    var dom = domainByKey('logic');
    return {
      domain: 'logic', kind: form.name, type: 'choice', level: level,
      a: dom.a, b: form.b, c: 1 / 4,
      prompt: 'Assume these are true. Which conclusion must follow?',
      premises: premises, options: options, answer: options.indexOf(valid),
      explanation: form.name + ': ' + (valid === NONE ? 'none of the specific conclusions is forced by the premises.' : '“' + valid + '” is the only conclusion the premises force.'),
      summary: form.name
    };
  }

  /* ================================================================
   *  6. VERBAL REASONING — curated analogies and odd-one-out
   * ================================================================ */

  var ANALOGIES = [
    ['Kitten : Cat :: Puppy : ?', ['Dog', 'Wolf', 'Bark', 'Kennel', 'Litter'], -2.2, 'the young of the animal'],
    ['Hot : Cold :: Up : ?', ['Down', 'Sky', 'High', 'Over', 'Ladder'], -2.0, 'opposites'],
    ['Pen : Write :: Knife : ?', ['Cut', 'Sharp', 'Kitchen', 'Fork', 'Steel'], -1.8, 'the tool and what it does'],
    ['Bird : Fly :: Fish : ?', ['Swim', 'Water', 'Fin', 'Scale', 'Gill'], -1.8, 'the animal and how it moves'],
    ['Glove : Hand :: Helmet : ?', ['Head', 'Hair', 'Hat', 'Bike', 'Shoulder'], -1.6, 'what the item protects'],
    ['Triangle : Three :: Hexagon : ?', ['Six', 'Four', 'Five', 'Eight', 'Ten'], -1.5, 'number of sides'],
    ['Author : Book :: Composer : ?', ['Symphony', 'Piano', 'Orchestra', 'Concert', 'Conductor'], -1.2, 'the maker and the work'],
    ['Thermometer : Temperature :: Scale : ?', ['Weight', 'Height', 'Kilogram', 'Balance', 'Fish'], -1.2, 'the instrument and what it measures'],
    ['Car : Garage :: Aircraft : ?', ['Hangar', 'Runway', 'Sky', 'Pilot', 'Ticket'], -1.0, 'where the vehicle is housed'],
    ['Sculptor : Statue :: Poet : ?', ['Poem', 'Rhyme', 'Ink', 'Stage', 'Library'], -1.0, 'the artist and the work'],
    ['Circle : Sphere :: Square : ?', ['Cube', 'Rectangle', 'Box', 'Triangle', 'Pyramid'], -0.8, 'the 2D shape and its 3D solid'],
    ['Optimist : Hopeful :: Pessimist : ?', ['Gloomy', 'Honest', 'Careful', 'Lonely', 'Clever'], -0.6, 'the person and their outlook'],
    ['Scarce : Abundant :: Brief : ?', ['Lengthy', 'Short', 'Quick', 'Rare', 'Small'], -0.4, 'opposites'],
    ['Sheep : Flock :: Lion : ?', ['Pride', 'Herd', 'Pack', 'Den', 'Mane'], -0.3, 'the animal and its group'],
    ['Arrogant : Humble :: Generous : ?', ['Stingy', 'Kind', 'Wealthy', 'Giving', 'Grateful'], -0.2, 'opposites'],
    ['Drought : Rain :: Famine : ?', ['Food', 'Hunger', 'Crop', 'Desert', 'Money'], 0.0, 'the shortage and what is short'],
    ['Bulb : Tulip :: Acorn : ?', ['Oak', 'Squirrel', 'Pine', 'Maple', 'Leaf'], 0.0, 'what grows from it'],
    ['Chef : Kitchen :: Blacksmith : ?', ['Forge', 'Hammer', 'Anvil', 'Iron', 'Fire'], 0.1, 'where the worker works'],
    ['Sonnet : Poem :: Waltz : ?', ['Dance', 'Music', 'Song', 'Ballroom', 'Violin'], 0.2, 'a kind of the wider category'],
    ['Fortify : Weaken :: Elongate : ?', ['Shorten', 'Extend', 'Widen', 'Bend', 'Measure'], 0.2, 'opposites'],
    ['Prologue : Epilogue :: Dawn : ?', ['Dusk', 'Morning', 'Sun', 'Noon', 'Moon'], 0.3, 'beginning and end'],
    ['Miser : Money :: Glutton : ?', ['Food', 'Greed', 'Fat', 'Hunger', 'Wealth'], 0.4, 'what the person craves'],
    ['Grain : Silo :: Water : ?', ['Reservoir', 'River', 'Glass', 'Rain', 'Ocean'], 0.4, 'where it is stored in bulk'],
    ['Water : Thirst :: Sleep : ?', ['Fatigue', 'Dream', 'Bed', 'Night', 'Rest'], 0.5, 'what relieves the need'],
    ['Symptom : Disease :: Clue : ?', ['Mystery', 'Detective', 'Solution', 'Fingerprint', 'Suspect'], 0.6, 'the sign and what it points to'],
    ['Archipelago : Island :: Constellation : ?', ['Star', 'Sky', 'Galaxy', 'Planet', 'Telescope'], 0.7, 'the group and its member'],
    ['Cartographer : Map :: Lexicographer : ?', ['Dictionary', 'Novel', 'Language', 'Library', 'Atlas'], 0.8, 'the maker and the work'],
    ['Cacophony : Harmony :: Chaos : ?', ['Order', 'Noise', 'Music', 'Silence', 'Storm'], 0.9, 'opposites'],
    ['Anonymous : Name :: Nomadic : ?', ['Home', 'Tent', 'Travel', 'Tribe', 'Desert'], 1.0, 'what is lacking'],
    ['Zenith : Nadir :: Apex : ?', ['Base', 'Peak', 'Summit', 'Top', 'Edge'], 1.1, 'opposites'],
    ['Ephemeral : Permanent :: Verbose : ?', ['Terse', 'Loud', 'Wordy', 'Silent', 'Written'], 1.2, 'opposites'],
    ['Antidote : Poison :: Solace : ?', ['Grief', 'Comfort', 'Friend', 'Joy', 'Medicine'], 1.3, 'what it counteracts'],
    ['Candid : Frank :: Reticent : ?', ['Reserved', 'Talkative', 'Nervous', 'Rude', 'Curious'], 1.4, 'synonyms'],
    ['Vertex : Polygon :: Node : ?', ['Network', 'Circle', 'Line', 'Angle', 'Point'], 1.5, 'the part and the whole'],
    ['Loquacious : Talkative :: Taciturn : ?', ['Quiet', 'Tired', 'Angry', 'Wise', 'Strong'], 1.6, 'synonyms'],
    ['Pedagogy : Teaching :: Oenology : ?', ['Wine', 'Birds', 'Rocks', 'Sleep', 'Coins'], 2.0, 'the study and its subject'],
    ['Photon : Light :: Phonon : ?', ['Sound', 'Heat', 'Phone', 'Colour', 'Motion'], 2.0, 'the quantum and the phenomenon'],
    ['Iron : Rust :: Copper : ?', ['Verdigris', 'Bronze', 'Wire', 'Ore', 'Alloy'], 2.2, 'the metal and its corrosion']
  ];
  var ODD_ONES = [
    [['Apple', 'Banana', 'Carrot', 'Grape', 'Pear'], 'Carrot', -2.0, 'the only vegetable'],
    [['Novel', 'Poem', 'Essay', 'Pencil', 'Play'], 'Pencil', -2.2, 'the only object, not a form of writing'],
    [['Copper', 'Iron', 'Gold', 'Glass', 'Silver'], 'Glass', -1.6, 'the only non-metal'],
    [['Oak', 'Pine', 'Rose', 'Maple', 'Birch'], 'Rose', -1.4, 'the only one that is not a tree'],
    [['Mercury', 'Venus', 'Sun', 'Mars', 'Jupiter'], 'Sun', -1.2, 'the only star'],
    [['Triangle', 'Square', 'Circle', 'Pentagon', 'Hexagon'], 'Circle', -1.0, 'the only shape without straight sides'],
    [['Violin', 'Cello', 'Guitar', 'Trumpet', 'Harp'], 'Trumpet', -0.8, 'the only instrument without strings'],
    [['Ounce', 'Pound', 'Gram', 'Yard', 'Ton'], 'Yard', -0.6, 'the only measure of length'],
    [['Whisper', 'Shout', 'Mutter', 'Murmur', 'Mumble'], 'Shout', -0.4, 'the only loud one'],
    [['Sprint', 'Jog', 'Stroll', 'Dash', 'Bolt'], 'Stroll', -0.2, 'the only slow one'],
    [['Candid', 'Frank', 'Sincere', 'Devious', 'Honest'], 'Devious', 0.0, 'the only one that is not about honesty'],
    [['Meticulous', 'Careful', 'Thorough', 'Slapdash', 'Precise'], 'Slapdash', 0.1, 'the only careless one'],
    [['Lisbon', 'Madrid', 'Paris', 'Berlin', 'Milan'], 'Milan', 0.2, 'the only one that is not a capital city'],
    [['Clarinet', 'Oboe', 'Flute', 'Bassoon', 'Viola'], 'Viola', 0.3, 'the only string instrument among woodwinds'],
    [['Kilogram', 'Metre', 'Litre', 'Second', 'Fahrenheit'], 'Fahrenheit', 0.4, 'the only non-metric unit'],
    [['Hexagon', 'Octagon', 'Pentagon', 'Rhombus', 'Heptagon'], 'Rhombus', 0.5, 'the only one not named by its number of sides'],
    [['Ebb', 'Dwindle', 'Wane', 'Surge', 'Recede'], 'Surge', 0.6, 'the only one meaning to increase'],
    [['Lynx', 'Ocelot', 'Jaguar', 'Hyena', 'Cheetah'], 'Hyena', 0.6, 'the only one that is not a cat'],
    [['Sonnet', 'Haiku', 'Limerick', 'Ballad', 'Fresco'], 'Fresco', 0.7, 'the only one that is not a poem'],
    [['Diamond', 'Ruby', 'Sapphire', 'Pearl', 'Emerald'], 'Pearl', 0.8, 'the only one that is not a mineral'],
    [['Cirrus', 'Cumulus', 'Stratus', 'Nimbus', 'Tundra'], 'Tundra', 0.9, 'the only one that is not a cloud'],
    [['Tributary', 'Delta', 'Estuary', 'Plateau', 'Rapids'], 'Plateau', 1.0, 'the only one that is not part of a river'],
    [['Fibula', 'Scapula', 'Patella', 'Vertebra', 'Retina'], 'Retina', 1.0, 'the only one that is not a bone'],
    [['Deciduous', 'Evergreen', 'Coniferous', 'Perennial', 'Igneous'], 'Igneous', 1.1, 'the only one about rock, not plants'],
    [['Tibia', 'Femur', 'Ulna', 'Aorta', 'Radius'], 'Aorta', 1.2, 'the only one that is not a bone'],
    [['Pavlova', 'Baklava', 'Tiramisu', 'Gazpacho', 'Meringue'], 'Gazpacho', 1.3, 'the only savoury dish'],
    [['Copper', 'Zinc', 'Bronze', 'Tin', 'Nickel'], 'Bronze', 1.4, 'the only alloy'],
    [['Ampere', 'Volt', 'Ohm', 'Newton', 'Watt'], 'Newton', 1.6, 'the only unit that is not electrical'],
    [['Frugal', 'Thrifty', 'Prodigal', 'Economical', 'Sparing'], 'Prodigal', 1.7, 'the only wasteful one'],
    [['Andante', 'Allegro', 'Adagio', 'Presto', 'Arpeggio'], 'Arpeggio', 1.8, 'the only one that is not a tempo']
  ];

  // The verbal bank is finite, so an item is addressed by bank id and a
  // sitting never repeats one. `used` is the list of ids already asked.
  function verbalPool(used) {
    var out = [], i, id;
    for (i = 0; i < ANALOGIES.length; i++) { id = 'a' + i; if (used.indexOf(id) < 0) out.push({ id: id, b: ANALOGIES[i][2] }); }
    for (i = 0; i < ODD_ONES.length; i++) { id = 'o' + i; if (used.indexOf(id) < 0) out.push({ id: id, b: ODD_ONES[i][2] }); }
    return out;
  }
  function genVerbal(seed, id) {
    var r = rng('verbal:' + seed + ':' + id);
    var dom = domainByKey('verbal'), n = parseInt(id.slice(1), 10);
    if (id.charAt(0) === 'a') {
      var an = ANALOGIES[n];
      var opts = shuffle(r, an[1]);
      return {
        domain: 'verbal', kind: 'analogy', type: 'choice', level: id, bankId: id,
        a: dom.a, b: an[2], c: 1 / 5,
        prompt: an[0], options: opts, answer: opts.indexOf(an[1][0]),
        explanation: 'The relationship is ' + an[3] + ': ' + an[1][0] + '.',
        summary: an[0].replace(' ?', ' ' + an[1][0])
      };
    }
    var od = ODD_ONES[n];
    var o2 = shuffle(r, od[0]);
    return {
      domain: 'verbal', kind: 'oddOneOut', type: 'choice', level: id, bankId: id,
      a: dom.a, b: od[2], c: 1 / 5,
      prompt: 'Which word does not belong?', options: o2, answer: o2.indexOf(od[1]),
      explanation: od[1] + ' is ' + od[3] + '.',
      summary: 'Odd one out: ' + od[0].join(', ') + ' → ' + od[1]
    };
  }

  /* ================================================================
   *  THE ADAPTIVE SESSION
   * ================================================================ */

  var LENGTHS = {
    standard: { minPerDomain: 3, maxItems: 36, targetSE: 0.38, label: 'Standard', minutes: '20–30' },
    quick:    { minPerDomain: 2, maxItems: 18, targetSE: 0.5, label: 'Quick', minutes: '10–15' }
  };
  var MODES = {
    full:        { label: 'Full', blurb: 'All six domains, including language-based items.' },
    cultureFair: { label: 'Culture-fair', blurb: 'Non-verbal domains only: matrix, series, rotation, memory.' }
  };

  function createSession(opts) {
    opts = opts || {};
    var mode = MODES[opts.mode] ? opts.mode : 'full';
    var length = LENGTHS[opts.length] ? opts.length : 'standard';
    var L = LENGTHS[length];
    var domains = DOMAINS.filter(function (d) { return mode === 'full' || d.cultureFair; }).map(function (d) { return d.key; });
    var seed = String(opts.seed == null ? 'q' : opts.seed);
    var order = shuffle(rng('order:' + seed), domains);
    return {
      v: 1, seed: seed, mode: mode, length: length, domains: order,
      minItems: L.minPerDomain * domains.length, maxItems: L.maxItems, targetSE: L.targetSE,
      startedAt: opts.now == null ? 0 : opts.now, finishedAt: null, finished: false,
      theta: 0, se: 1, asked: [], used: { verbal: [] }
    };
  }

  function domainCounts(state) {
    var counts = {};
    for (var i = 0; i < state.domains.length; i++) counts[state.domains[i]] = 0;
    for (i = 0; i < state.asked.length; i++) counts[state.asked[i].domain]++;
    return counts;
  }

  // The domain asked least so far, ties broken by the sitting's fixed order.
  function nextDomain(state) {
    var counts = domainCounts(state), best = null;
    for (var i = 0; i < state.domains.length; i++) {
      var d = state.domains[i];
      if (best === null || counts[d] < counts[best]) best = d;
    }
    return best;
  }

  // Level whose difficulty is nearest the current ability estimate, with a
  // deterministic nudge one step either way so a sitting doesn't rut.
  function chooseLevel(levels, theta, r) {
    var best = 0, bestD = Infinity, i;
    for (i = 0; i < levels.length; i++) { var d = Math.abs(levels[i] - theta); if (d < bestD) { bestD = d; best = i; } }
    var u = r();
    if (u < 0.15 && best > 0) best--;
    else if (u > 0.85 && best < levels.length - 1) best++;
    return best;
  }

  function nextItem(state) {
    if (state.finished) return null;
    var n = state.asked.length;
    var domain = nextDomain(state);
    var dom = domainByKey(domain);
    var r = rng('pick:' + state.seed + ':' + n + ':' + domain);
    var itemSeed = state.seed + ':' + n, item;
    if (domain === 'verbal') {
      var pool = verbalPool(state.used.verbal);
      if (!pool.length) pool = verbalPool([]);
      var levels = pool.map(function (p) { return p.b; });
      // sort the pool by difficulty so the nudge steps to a neighbouring item
      pool.sort(function (p, q) { return p.b - q.b; });
      levels = pool.map(function (p) { return p.b; });
      item = genVerbal(itemSeed, pool[chooseLevel(levels, state.theta, r)].id);
    } else {
      var lvl = chooseLevel(dom.levels, state.theta, r) + 1;
      if (domain === 'matrix') item = genMatrix(itemSeed, lvl);
      else if (domain === 'series') item = genSeries(itemSeed, lvl);
      else if (domain === 'spatial') item = genSpatial(itemSeed, lvl);
      else if (domain === 'memory') item = genSpan(itemSeed, lvl);
      else item = genLogic(itemSeed, lvl);
    }
    item.n = n;
    item.id = itemSeed + ':' + domain + ':' + item.level;
    item.timeLimitMs = dom.timeLimitMs;
    return item;
  }

  function isCorrect(item, response) {
    if (response == null) return false;
    if (item.type === 'span') return normalizeDigits(response) === item.expected;
    return Number(response) === item.answer;
  }

  function responseLabel(item, response) {
    if (response == null) return 'No answer';
    if (item.type === 'span') return normalizeDigits(response) || 'No answer';
    var o = item.options[Number(response)];
    if (o == null) return 'No answer';
    if (item.domain === 'matrix') return 'Option ' + (Number(response) + 1);
    if (item.domain === 'spatial') return 'Figure ' + (Number(response) + 1);
    return String(o);
  }
  function answerLabel(item) {
    if (item.type === 'span') return item.expected;
    if (item.domain === 'matrix') return 'Option ' + (item.answer + 1);
    if (item.domain === 'spatial') return 'Figure ' + (item.answer + 1);
    return String(item.options[item.answer]);
  }

  // Record an answer (response === null means the clock ran out). Returns a
  // NEW state; the input is never mutated.
  function answer(state, item, response, elapsedMs, now) {
    if (state.finished) return state;
    if (!item || item.n !== state.asked.length) throw new Error('answer: item does not match the session position');
    var correct = isCorrect(item, response);
    var rec = {
      n: item.n, id: item.id, domain: item.domain, kind: item.kind, level: item.level,
      a: item.a, b: item.b, c: item.c, correct: correct,
      timedOut: response == null, elapsedMs: Math.max(0, Math.round(elapsedMs || 0)),
      response: responseLabel(item, response), answerText: answerLabel(item),
      summary: item.summary, explanation: item.explanation
    };
    var asked = state.asked.concat([rec]);
    var est = estimateAbility(asked);
    var used = { verbal: state.used.verbal.slice() };
    if (item.bankId) used.verbal.push(item.bankId);
    var n = asked.length;
    var done = n >= state.maxItems || (n >= state.minItems && est.se <= state.targetSE);
    return {
      v: state.v, seed: state.seed, mode: state.mode, length: state.length, domains: state.domains,
      minItems: state.minItems, maxItems: state.maxItems, targetSE: state.targetSE,
      startedAt: state.startedAt, finishedAt: done ? (now == null ? null : now) : null, finished: done,
      theta: est.theta, se: est.se, asked: asked, used: used
    };
  }

  function progress(state) {
    var n = state.asked.length;
    // the sitting ends somewhere between min and max; show a conservative bar
    var expected = state.minItems + Math.round((state.maxItems - state.minItems) * 0.5);
    return {
      n: n, minItems: state.minItems, maxItems: state.maxItems,
      fraction: clamp(n / Math.max(expected, n + 1), 0, 0.98),
      remainingMax: Math.max(0, state.maxItems - n)
    };
  }

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function report(state) {
    var est = { theta: state.theta, se: state.se };
    var iq = iqFromTheta(est.theta);
    var half = 1.96 * 15 * est.se;
    var lo = Math.round(100 + 15 * est.theta - half), hi = Math.round(100 + 15 * est.theta + half);
    var domains = [], i, j;
    for (i = 0; i < state.domains.length; i++) {
      var key = state.domains[i], dom = domainByKey(key), items = [];
      for (j = 0; j < state.asked.length; j++) if (state.asked[j].domain === key) items.push(state.asked[j]);
      var de = estimateAbility(items), correct = items.filter(function (x) { return x.correct; }).length;
      domains.push({ key: key, label: dom.label, short: dom.short, n: items.length, correct: correct,
        theta: de.theta, se: de.se, iq: iqFromTheta(de.theta) });
    }
    domains.sort(function (a, b) { return b.theta - a.theta; });
    var correctAll = state.asked.filter(function (x) { return x.correct; }).length;
    var timedOut = state.asked.filter(function (x) { return x.timedOut; }).length;
    var band = bandFor(iq);
    var caveats = [
      'This is an adaptive estimate from ' + state.asked.length + ' generated items, not a clinically normed assessment. Item difficulties are model-based, not calibrated on a population sample.',
      'The interval is the range that would contain your score 95 times in 100 if you sat comparable tests; treat the point score as a centre, not a fact.',
      state.mode === 'cultureFair' ? 'Culture-fair mode omits language-based domains, which sharpens fairness and slightly widens the interval.' : 'Verbal items assume fluent English; if that is not your first language, weight the non-verbal domains more.',
      'Fatigue, distraction, and practice all move scores by several points. One sitting is one sample.'
    ];
    return {
      theta: est.theta, se: est.se, iq: iq, ciLow: lo, ciHigh: hi,
      percentile: percentile(est.theta), rarity: rarity(est.theta), above: est.theta >= 0,
      band: band.label, bandNote: band.note,
      items: state.asked.length, correct: correctAll, timedOut: timedOut,
      medianMs: Math.round(median(state.asked.map(function (x) { return x.elapsedMs; }))),
      durationMs: (state.finishedAt != null && state.startedAt != null) ? Math.max(0, state.finishedAt - state.startedAt) : null,
      mode: state.mode, length: state.length, domains: domains, review: state.asked.slice(), caveats: caveats,
      finished: !!state.finished
    };
  }

  function shareText(rep) {
    var pct = rep.percentile;
    return 'Quotient · IQ ' + rep.iq + ' (95% CI ' + rep.ciLow + '–' + rep.ciHigh + '), ' + pct + 'th percentile · ' + rep.band +
      ' · ' + rep.items + ' adaptive items' + (rep.mode === 'cultureFair' ? ', culture-fair' : '') + '.';
  }

  /* ---- the bell curve, as plain path data for the result page ---- */
  // Returns points of the standard normal over [-4,4] scaled into a w×h box,
  // plus the x position of θ, so the page can draw it with no math of its own.
  function bellCurve(theta, w, h) {
    var pts = [], peak = normalPdf(0), i;
    for (i = 0; i <= 80; i++) {
      var z = -4 + i * 0.1;
      pts.push([Math.round((z + 4) / 8 * w * 100) / 100, Math.round(((h - 6) - normalPdf(z) / peak * (h - 12)) * 100) / 100]);
    }
    var x = clamp((theta + 4) / 8, 0, 1) * w;
    return { points: pts, x: Math.round(x * 100) / 100, baseline: h - 6 };
  }

  function formatDuration(ms) {
    if (ms == null) return '—';
    var m = Math.floor(ms / MINUTE), s = Math.round((ms % MINUTE) / SECOND);
    if (s === 60) { m++; s = 0; }
    return m ? m + 'm ' + (s < 10 ? '0' : '') + s + 's' : s + 's';
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var api = {
    SECOND: SECOND, MINUTE: MINUTE,
    DOMAINS: DOMAINS, INSTRUCTIONS: INSTRUCTIONS, LENGTHS: LENGTHS, MODES: MODES, BANDS: BANDS,
    ANALOGIES: ANALOGIES, ODD_ONES: ODD_ONES, LOGIC_FORMS: LOGIC_FORMS, SPAN_VARIANTS: SPAN_VARIANTS,
    hashStr: hashStr, rng: rng, shuffle: shuffle,
    normalCdf: normalCdf, normalPdf: normalPdf,
    probCorrect: probCorrect, itemInfo: itemInfo, estimateAbility: estimateAbility,
    iqFromTheta: iqFromTheta, bandFor: bandFor, rarity: rarity, percentile: percentile,
    domainByKey: domainByKey,
    genMatrix: genMatrix, cellKey: cellKey, canonCell: canonCell, cellSVG: cellSVG,
    genSeries: genSeries,
    genSpatial: genSpatial, figKey: figKey, rotFig: rotFig, mirrorFig: mirrorFig, rotN: rotN, isChiral: isChiral, figureSVG: figureSVG,
    genSpan: genSpan, normalizeDigits: normalizeDigits,
    genLogic: genLogic,
    genVerbal: genVerbal, verbalPool: verbalPool,
    createSession: createSession, nextItem: nextItem, nextDomain: nextDomain, chooseLevel: chooseLevel,
    isCorrect: isCorrect, answer: answer, progress: progress, report: report, shareText: shareText,
    bellCurve: bellCurve, formatDuration: formatDuration, escapeHTML: escapeHTML
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuotientEngine = api;
})(typeof self !== 'undefined' ? self : this);
