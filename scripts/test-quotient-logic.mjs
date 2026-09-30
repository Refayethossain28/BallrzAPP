#!/usr/bin/env node
/**
 * Unit tests for quotient/engine.js — the pure adaptive IQ-test engine behind
 * Quotient: the six seeded item generators (matrix reasoning, number series,
 * mental rotation, digit span, deductive logic, verbal reasoning), the
 * item-response-theory core (3PL probability, EAP ability estimate), the
 * adaptive session (domain rotation, difficulty targeting, stop rule,
 * immutable state), the IQ scale, and the pure SVG renderers.
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-quotient-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'quotient', 'engine.js'), 'utf8'), sandbox, { filename: 'quotient/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0); // 2026-09-30 12:00 UTC

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const SEEDS = Array.from({ length: 40 }, (_, i) => 'seed-' + i);

// every multiple-choice item: unique options, one answer, sane IRT params
function checkChoice(item, nOpts) {
  assert.equal(item.type, 'choice');
  assert.equal(item.options.length, nOpts, 'option count');
  const keys = new Set(item.options.map((o) => JSON.stringify(o)));
  assert.equal(keys.size, nOpts, 'options must be distinct: ' + JSON.stringify(item.options));
  assert.ok(item.answer >= 0 && item.answer < nOpts, 'answer index in range');
  assert.ok(Math.abs(item.c - 1 / nOpts) < 1e-9, 'guessing = 1/options');
  assert.ok(item.a > 0 && item.b >= -3 && item.b <= 3, 'IRT params sane');
  assert.ok(typeof item.explanation === 'string' && item.explanation.length > 10);
  assert.ok(typeof item.summary === 'string' && item.summary.length > 3);
}

/* ---------- randomness & stats ---------- */
test('hashStr/rng are stable and spread', () => {
  assert.equal(E.hashStr('quotient'), E.hashStr('quotient'));
  assert.notEqual(E.hashStr('a'), E.hashStr('b'));
  const r1 = E.rng('x'), r2 = E.rng('x');
  const s1 = [r1(), r1(), r1()], s2 = [r2(), r2(), r2()];
  deepEq(s1, s2);
  assert.ok(s1.every((v) => v >= 0 && v < 1));
  assert.notEqual(s1[0], s1[1]);
});
test('normalCdf matches the standard table', () => {
  assert.ok(Math.abs(E.normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(E.normalCdf(1.96) - 0.975) < 2e-4);
  assert.ok(Math.abs(E.normalCdf(-1) - 0.158655) < 1e-5);
  assert.equal(E.normalCdf(9), 1);
});

/* ---------- IRT core ---------- */
test('probCorrect: 3PL shape — c at the floor, (1+c)/2 at θ=b, monotone', () => {
  const item = { a: 1.2, b: 0.5, c: 0.25 };
  assert.ok(Math.abs(E.probCorrect(0.5, item) - 0.625) < 1e-9);
  assert.ok(E.probCorrect(-6, item) < 0.26);
  assert.ok(E.probCorrect(6, item) > 0.99);
  assert.ok(E.probCorrect(1, item) > E.probCorrect(0, item));
});
test('itemInfo peaks near the difficulty and is zero-ish far away', () => {
  const item = { a: 1, b: 0, c: 0 };
  assert.ok(E.itemInfo(0, item) > E.itemInfo(2, item));
  assert.ok(E.itemInfo(0, item) > E.itemInfo(-2, item));
  assert.ok(E.itemInfo(6, item) < 0.01);
});
test('estimateAbility: no data → prior mean, wide; evidence moves it and tightens it', () => {
  const none = E.estimateAbility([]);
  assert.ok(Math.abs(none.theta) < 0.01);
  assert.ok(none.se > 1.2 && none.se < 1.6, 'prior SD ~1.5, truncated at ±4: ' + none.se);
  const right = E.estimateAbility([{ a: 1.2, b: 0, c: 0.2, correct: true }, { a: 1.2, b: 1, c: 0.2, correct: true }]);
  const wrong = E.estimateAbility([{ a: 1.2, b: 0, c: 0.2, correct: false }, { a: 1.2, b: -1, c: 0.2, correct: false }]);
  assert.ok(right.theta > 0.3 && wrong.theta < -0.3);
  assert.ok(right.se < none.se && wrong.se < none.se);
  // a symmetric pattern sits at the middle
  const mixed = E.estimateAbility([{ a: 1, b: 1, c: 0, correct: false }, { a: 1, b: -1, c: 0, correct: true }]);
  assert.ok(Math.abs(mixed.theta) < 0.05);
});

/* ---------- the IQ scale ---------- */
test('iqFromTheta, bands, percentile and rarity', () => {
  assert.equal(E.iqFromTheta(0), 100);
  assert.equal(E.iqFromTheta(2), 130);
  assert.equal(E.bandFor(100).label, 'Average');
  assert.equal(E.bandFor(130).label, 'Very high');
  assert.equal(E.bandFor(69).label, 'Very low');
  assert.equal(E.bandFor(115).label, 'High average');
  assert.equal(E.percentile(0), 50);
  assert.equal(E.rarity(0), 2);
  assert.equal(E.rarity(2), Math.round(1 / (1 - E.normalCdf(2))));
  assert.equal(E.rarity(-2), E.rarity(2));
});

/* ---------- matrix reasoning ---------- */
const rowOK = (rule, row) => {
  if (rule === 'row') return row[0] === row[1] && row[1] === row[2];
  if (rule === 'prog') return (row[1] - row[0] + 3) % 3 === (row[2] - row[1] + 3) % 3 && row[0] !== row[1];
  if (rule === 'dist3') return new Set(row).size === 3;
  return row.every((v) => v === 0);
};
test('genMatrix: every level/seed yields 8 distinct options, one correct, rules hold row by row', () => {
  for (const seed of SEEDS) for (let level = 1; level <= 7; level++) {
    const m = E.genMatrix(seed, level);
    checkChoice(m, 8);
    assert.equal(m.cells.length, 8);
    for (const attr of Object.keys(m.grid)) for (const row of m.grid[attr]) assert.ok(rowOK(m.rules[attr], row), `${seed} L${level} ${attr} ${m.rules[attr]} ${row}`);
    // the correct option is exactly the rule-determined bottom-right cell
    const idx = m.grid, v = m.values;
    const want = E.cellKey({ shape: v.shape[idx.shape[2][2]], count: v.count[idx.count[2][2]], fill: v.fill[idx.fill[2][2]], size: v.size[idx.size[2][2]], rot: v.rot[idx.rot[2][2]] });
    assert.equal(E.cellKey(m.options[m.answer]), want);
    const keys = new Set(m.options.map(E.cellKey));
    assert.equal(keys.size, 8, 'visually distinct options');
    // tilt only ever varies on shapes where it is visible
    if (m.rules.rot) for (const c of m.cells) assert.ok(['triangle', 'square', 'pentagon', 'star'].includes(c.shape));
  }
});
test('genMatrix: difficulty rises with level and the item is deterministic', () => {
  const avg = (l) => SEEDS.reduce((s, seed) => s + E.genMatrix(seed, l).b, 0) / SEEDS.length;
  assert.ok(avg(1) < avg(3) && avg(3) < avg(5) && avg(5) < avg(7), [avg(1), avg(3), avg(5), avg(7)].join());
  deepEq(E.genMatrix('fixed', 4), E.genMatrix('fixed', 4));
  assert.notEqual(JSON.stringify(E.genMatrix('fixed', 4).options), JSON.stringify(E.genMatrix('other', 4).options));
});
test('cellSVG renders every shape/fill/count without NaN and shows ? for the gap', () => {
  for (const shape of ['circle', 'square', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star'])
    for (const fill of ['none', 'solid', 'half', 'grey']) for (const count of [1, 2, 3]) {
      const s = E.cellSVG({ shape, count, fill, size: 'l', rot: 2 });
      assert.ok(s.startsWith('<svg') && s.endsWith('</svg>'));
      assert.ok(!/NaN|undefined/.test(s), s);
      assert.equal((s.match(/<(circle|polygon)/g) || []).length, count * (fill === 'half' ? 2 : 1));
    }
  assert.ok(E.cellSVG(null).includes('?'));
  // rotation is invisible on a circle, so the key ignores it
  assert.equal(E.cellKey({ shape: 'circle', count: 1, fill: 'none', size: 'm', rot: 2 }), E.cellKey({ shape: 'circle', count: 1, fill: 'none', size: 'm', rot: 0 }));
});

/* ---------- number series ---------- */
test('genSeries: 6 shown terms, 5 distinct integer options, the answer continues the rule', () => {
  const kinds = new Set();
  for (const seed of SEEDS) for (let level = 1; level <= 7; level++) {
    const s = E.genSeries(seed, level);
    checkChoice(s, 5);
    kinds.add(s.kind);
    assert.equal(s.terms.length, 6);
    assert.ok(s.options.every(Number.isInteger));
    const ans = s.options[s.answer];
    if (s.kind === 'arith' || s.kind === 'arithNeg') {
      const all = s.terms.concat([ans]), d = all[1] - all[0];
      for (let i = 1; i < all.length; i++) assert.equal(all[i] - all[i - 1], d);
    }
    if (s.kind === 'fib') assert.equal(ans, s.terms[5] + s.terms[4]);
    if (s.kind === 'geo') assert.equal(ans / s.terms[5], s.terms[1] / s.terms[0]);
    if (s.kind === 'nsq') { const n = Math.round((Math.sqrt(4 * ans + 1) - 1) / 2); assert.equal(n * (n + 1), ans); }
    assert.ok(Math.abs(ans) < 5000, 'numbers stay readable');
  }
  assert.ok(kinds.size >= 11, 'all series families appear: ' + [...kinds].join());
});
test('genSeries: fixed seed snapshot and rising difficulty', () => {
  const s = E.genSeries('s1', 1);
  deepEq(s.terms, [3, 9, 15, 21, 27, 33]);
  assert.equal(s.options[s.answer], 39);
  assert.ok(E.genSeries('x', 1).b < E.genSeries('x', 4).b && E.genSeries('x', 4).b < E.genSeries('x', 7).b);
});

/* ---------- mental rotation ---------- */
test('figure algebra: four rotations cycle, mirror is an involution, chirality detected', () => {
  const L = [[0, 0], [1, 0], [2, 0], [2, 1]];
  assert.equal(E.figKey(E.rotN(L, 4)), E.figKey(L));
  assert.notEqual(E.figKey(E.rotN(L, 1)), E.figKey(L));
  assert.equal(E.figKey(E.mirrorFig(E.mirrorFig(L))), E.figKey(L));
  assert.equal(E.isChiral(L), true);
  assert.equal(E.isChiral([[0, 0], [0, 1], [1, 0], [1, 1]]), false, 'a square is achiral');
  assert.equal(E.isChiral([[0, 0], [0, 1], [0, 2], [1, 1]]), false, 'a T is achiral');
});
test('genSpatial: the correct option is a rotation, the three distractors are mirror images, all distinct', () => {
  for (const seed of SEEDS) for (let level = 1; level <= 5; level++) {
    const s = E.genSpatial(seed, level);
    checkChoice(s, 4);
    assert.equal(s.target.length, level + 3);
    assert.ok(E.isChiral(s.target));
    const rots = new Set([0, 1, 2, 3].map((k) => E.figKey(E.rotN(s.target, k))));
    const mirrors = new Set([0, 1, 2, 3].map((k) => E.figKey(E.rotN(E.mirrorFig(s.target), k))));
    s.options.forEach((o, i) => {
      const k = E.figKey(o);
      if (i === s.answer) assert.ok(rots.has(k), 'answer is a rotation');
      else { assert.ok(mirrors.has(k), 'distractor is a mirror'); assert.ok(!rots.has(k)); }
    });
    assert.equal(new Set(s.options.map(E.figKey)).size, 4);
    assert.ok(!/NaN|undefined/.test(E.figureSVG(s.target, s.grid)));
    assert.equal((E.figureSVG(s.target, s.grid).match(/<rect/g) || []).length, s.target.length);
  }
});

/* ---------- working memory ---------- */
test('genSpan: right length, no adjacent repeats, backward reverses, difficulty ordered', () => {
  for (const seed of SEEDS) for (let level = 1; level <= E.SPAN_VARIANTS.length; level++) {
    const s = E.genSpan(seed, level), v = E.SPAN_VARIANTS[level - 1];
    assert.equal(s.type, 'span');
    assert.equal(s.digits.length, v.len);
    for (let i = 1; i < s.digits.length; i++) assert.notEqual(s.digits[i], s.digits[i - 1]);
    assert.equal(s.expected, (v.back ? s.digits.slice().reverse() : s.digits).join(''));
    assert.equal(s.c, 0);
  }
  for (let i = 1; i < E.SPAN_VARIANTS.length; i++) assert.ok(E.SPAN_VARIANTS[i].b > E.SPAN_VARIANTS[i - 1].b);
  assert.equal(E.normalizeDigits(' 4 2-1x9 '), '4219');
});

/* ---------- deductive logic ---------- */
test('genLogic: every form yields 4 distinct options with the valid conclusion present, nouns substituted', () => {
  assert.equal(E.LOGIC_FORMS.length, 15);
  for (let i = 1; i < E.LOGIC_FORMS.length; i++) assert.ok(E.LOGIC_FORMS[i].b >= E.LOGIC_FORMS[i - 1].b, 'forms sorted by difficulty');
  for (const seed of SEEDS.slice(0, 10)) for (let level = 1; level <= E.LOGIC_FORMS.length; level++) {
    const l = E.genLogic(seed, level);
    checkChoice(l, 4);
    assert.ok(l.premises.length >= 2);
    assert.ok(!/\{[a-dA-D]\}/.test(l.premises.join(' ') + l.options.join(' ')), 'no unfilled placeholders');
    if (E.LOGIC_FORMS[level - 1].valid === 'Nothing can be concluded.') assert.equal(l.options[l.answer], 'Nothing can be concluded.');
  }
  const l = E.genLogic('s1', 2);
  assert.match(l.premises[0], /^All \w+s are \w+s\.$/);
});

/* ---------- verbal ---------- */
test('verbal bank integrity: unique options, answer present, difficulties in range', () => {
  for (const [q, opts, b] of E.ANALOGIES) {
    assert.equal(opts.length, 5); assert.equal(new Set(opts).size, 5);
    assert.ok(q.endsWith(' : ?')); assert.ok(b >= -2.5 && b <= 2.5);
  }
  for (const [opts, ans, b] of E.ODD_ONES) {
    assert.equal(opts.length, 5); assert.equal(new Set(opts).size, 5);
    assert.ok(opts.includes(ans)); assert.ok(b >= -2.5 && b <= 2.5);
  }
  assert.ok(E.ANALOGIES.length + E.ODD_ONES.length >= 60);
});
test('genVerbal: shuffled options keep the right answer; pool excludes used ids', () => {
  const a = E.genVerbal('s', 'a0');
  checkChoice(a, 5);
  assert.equal(a.options[a.answer], E.ANALOGIES[0][1][0]);
  const o = E.genVerbal('s', 'o0');
  checkChoice(o, 5);
  assert.equal(o.options[o.answer], E.ODD_ONES[0][1]);
  assert.equal(E.verbalPool([]).length, E.ANALOGIES.length + E.ODD_ONES.length);
  assert.equal(E.verbalPool(['a0', 'o3']).length, E.ANALOGIES.length + E.ODD_ONES.length - 2);
});

/* ---------- the adaptive session ---------- */
function simulate(trueTheta, seed, opts = {}) {
  const r = E.rng('sim:' + seed);
  let s = E.createSession({ seed: 'sim:' + seed, now: NOW, ...opts });
  const items = [];
  while (!s.finished) {
    const it = E.nextItem(s);
    items.push(it);
    const ok = r() < E.probCorrect(trueTheta, it);
    const resp = it.type === 'span' ? (ok ? it.expected : '0') : (ok ? it.answer : (it.answer + 1) % it.options.length);
    s = E.answer(s, it, resp, 4000, NOW + (items.length) * 5000);
  }
  return { state: s, items };
}
test('createSession: modes pick domains, lengths set bounds, order is seeded', () => {
  const full = E.createSession({ seed: 'a', now: NOW });
  assert.equal(full.domains.length, 6); assert.equal(full.minItems, 18); assert.equal(full.maxItems, 36);
  const cf = E.createSession({ seed: 'a', mode: 'cultureFair', length: 'quick', now: NOW });
  deepEq(cf.domains.slice().sort(), ['matrix', 'memory', 'series', 'spatial']);
  assert.equal(cf.minItems, 8); assert.equal(cf.maxItems, 18);
  deepEq(E.createSession({ seed: 'a', now: NOW }).domains, full.domains);
  assert.notEqual(JSON.stringify(E.createSession({ seed: 'b', now: NOW }).domains), JSON.stringify(full.domains));
  assert.equal(E.createSession({ mode: 'nope', length: 'nah' }).mode, 'full');
});
test('nextItem is deterministic for a given state (resume shows the same item) and rotates domains', () => {
  const s = E.createSession({ seed: 'det', now: NOW });
  deepEq(E.nextItem(s), E.nextItem(s));
  const { items } = simulate(0, 'rot');
  const firstSix = items.slice(0, 6).map((i) => i.domain);
  assert.equal(new Set(firstSix).size, 6, 'first six items cover all six domains: ' + firstSix);
  for (let i = 0; i < items.length; i++) { assert.equal(items[i].n, i); assert.ok(items[i].timeLimitMs > 0); }
});
test('answer: immutable, records the response, times out as wrong, refuses a stale item', () => {
  const s0 = E.createSession({ seed: 'imm', now: NOW });
  const it = E.nextItem(s0);
  const s1 = E.answer(s0, it, it.type === 'span' ? it.expected : it.answer, 3200, NOW + 5000);
  assert.equal(s0.asked.length, 0, 'input untouched');
  assert.equal(s1.asked.length, 1);
  assert.equal(s1.asked[0].correct, true);
  assert.equal(s1.asked[0].elapsedMs, 3200);
  assert.ok(s1.theta > 0);
  const s2 = E.answer(s0, it, null, 90000, NOW + 90000);
  assert.equal(s2.asked[0].correct, false);
  assert.equal(s2.asked[0].timedOut, true);
  assert.equal(s2.asked[0].response, 'No answer');
  assert.ok(s2.theta < 0);
  assert.throws(() => E.answer(s1, it, 0, 0, NOW), /position/);
});
test('the sitting stops between min and max items and never before every domain has its share', () => {
  for (const seed of ['a', 'b', 'c']) for (const length of ['standard', 'quick']) {
    const { state } = simulate(0.5, seed + length, { length });
    assert.ok(state.finished);
    assert.ok(state.asked.length >= state.minItems && state.asked.length <= state.maxItems);
    const counts = {};
    for (const x of state.asked) counts[x.domain] = (counts[x.domain] || 0) + 1;
    for (const d of state.domains) assert.ok(counts[d] >= E.LENGTHS[length].minPerDomain, d);
    assert.equal(state.finishedAt > state.startedAt, true);
    assert.equal(E.nextItem(state), null);
  }
});
test('verbal items never repeat within a sitting', () => {
  const { items } = simulate(0, 'norepeat');
  const ids = items.filter((i) => i.domain === 'verbal').map((i) => i.bankId);
  assert.equal(new Set(ids).size, ids.length);
});
test('difficulty tracks ability: a strong respondent gets harder items than a weak one', () => {
  const hi = simulate(2, 'track').items.map((i) => i.b), lo = simulate(-2, 'track').items.map((i) => i.b);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(hi.slice(6)) - mean(lo.slice(6)) > 2, `hi ${mean(hi)} lo ${mean(lo)}`);
});
test('recovery: simulated respondents are estimated within tolerance, with little bias', () => {
  for (const t of [-1.5, 0, 1.5]) {
    let bias = 0, mae = 0; const N = 12;
    for (let i = 0; i < N; i++) { const { state } = simulate(t, 'rec' + t + ':' + i); bias += state.theta - t; mae += Math.abs(state.theta - t); }
    assert.ok(Math.abs(bias / N) < 0.35, `bias at ${t}: ${bias / N}`);
    assert.ok(mae / N < 0.6, `mae at ${t}: ${mae / N}`);
  }
  const perfect = simulate(9, 'perfect').state, hopeless = simulate(-9, 'hopeless').state;
  assert.ok(perfect.theta > 2, 'all right → well above 2: ' + perfect.theta);
  assert.ok(hopeless.theta < -2, 'all wrong → well below -2: ' + hopeless.theta);
  assert.ok(perfect.se < 0.6 && hopeless.se < 0.6);
});
test('report: IQ, interval, percentile, domains, review and caveats are all consistent', () => {
  const { state } = simulate(1, 'rep');
  const rep = E.report(state);
  assert.equal(rep.iq, E.iqFromTheta(state.theta));
  assert.equal(rep.ciLow, Math.round(100 + 15 * state.theta - 1.96 * 15 * state.se));
  assert.equal(rep.ciHigh, Math.round(100 + 15 * state.theta + 1.96 * 15 * state.se));
  assert.ok(rep.ciLow < rep.iq && rep.iq < rep.ciHigh);
  assert.equal(rep.percentile, E.percentile(state.theta));
  assert.equal(rep.domains.length, 6);
  for (let i = 1; i < rep.domains.length; i++) assert.ok(rep.domains[i - 1].theta >= rep.domains[i].theta, 'sorted best first');
  assert.equal(rep.domains.reduce((s, d) => s + d.n, 0), state.asked.length);
  assert.equal(rep.review.length, state.asked.length);
  assert.equal(rep.items, state.asked.length);
  assert.equal(rep.correct, state.asked.filter((x) => x.correct).length);
  assert.equal(rep.durationMs, state.finishedAt - state.startedAt);
  assert.equal(rep.medianMs, 4000);
  assert.equal(rep.caveats.length, 4);
  assert.match(E.shareText(rep), /^Quotient · IQ \d+ \(95% CI \d+–\d+\), [\d.]+th percentile/);
  const cf = E.report(simulate(0, 'cf', { mode: 'cultureFair' }).state);
  assert.ok(cf.caveats.some((c) => /Culture-fair/.test(c)));
});
test('progress: conservative fraction that never reaches 1 before the end', () => {
  const s = E.createSession({ seed: 'p', now: NOW });
  assert.equal(E.progress(s).n, 0);
  assert.equal(E.progress(s).fraction, 0);
  const { state } = simulate(0, 'p2');
  assert.ok(E.progress(state).fraction <= 0.98);
  assert.equal(E.progress(state).remainingMax, state.maxItems - state.asked.length);
});
test('bellCurve, formatDuration, escapeHTML', () => {
  const bc = E.bellCurve(0, 560, 160);
  assert.equal(bc.points.length, 81);
  assert.equal(bc.x, 280);
  assert.equal(bc.baseline, 154);
  assert.ok(Math.abs(bc.points[40][1] - 6) < 0.01, 'peak touches the top margin: ' + bc.points[40][1]);
  assert.ok(bc.points[0][1] > 153.9 && bc.points[0][1] <= 154, 'tails sit on the baseline: ' + bc.points[0][1]);
  assert.ok(bc.points[30][1] > bc.points[40][1] && bc.points[30][1] < bc.points[0][1], 'monotone shoulder');
  assert.equal(E.bellCurve(9, 560, 160).x, 560, 'clamped');
  assert.equal(E.formatDuration(65000), '1m 05s');
  assert.equal(E.formatDuration(4000), '4s');
  assert.equal(E.formatDuration(null), '—');
  assert.equal(E.escapeHTML('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nquotient: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
