#!/usr/bin/env node
/**
 * Unit tests for tokens/engine.js — the pure "what will this prompt cost"
 * engine behind Tokens (the Claude model catalog with clock-injected intro
 * pricing, the heuristic token estimator, per-request costing and model
 * comparison, prompt-cache economics, the monthly usage ledger with budget
 * projection, and the money/token formatters).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-tokens-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'tokens', 'engine.js'), 'utf8'), sandbox, { filename: 'tokens/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);        // 2026-08-16 12:00 UTC — Sonnet 5 intro window
const SEPT = Date.UTC(2026, 8, 2, 12, 0, 0);        // 2026-09-02 — intro over
const { DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const close = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, (m || '') + ` (${a} vs ${b})`);

/* ---------- the catalog & pricing clock ---------- */
test('catalog: every model has sane pricing and context fields', () => {
  assert.ok(E.MODELS.length >= 8);
  for (const m of E.MODELS) {
    assert.ok(m.id && m.name && m.tier, m.id);
    assert.ok(m.context > 0 && m.maxOut > 0, m.id);
    assert.ok(m.inPerM > 0 && m.outPerM > m.inPerM, m.id + ': output should out-price input');
  }
  assert.equal(E.modelById('claude-opus-5').inPerM, 5);
  assert.equal(E.modelById('claude-fable-5').outPerM, 50);
  assert.equal(E.modelById('nope'), null);
});
test('priceFor: Sonnet 5 intro pricing holds through 2026-08-31 UTC, then reverts', () => {
  const during = E.priceFor('claude-sonnet-5', NOW);
  assert.equal(during.intro, true);
  assert.equal(during.inPerM, 2);
  assert.equal(during.outPerM, 10);
  const lastMoment = Date.UTC(2026, 7, 31, 23, 59, 59);
  assert.equal(E.priceFor('claude-sonnet-5', lastMoment).intro, true, 'intro covers the whole last day');
  const after = E.priceFor('claude-sonnet-5', SEPT);
  assert.equal(after.intro, false);
  assert.equal(after.inPerM, 3);
  assert.equal(after.outPerM, 15);
});
test('priceFor: models without intro pricing ignore the clock', () => {
  deepEq(E.priceFor('claude-opus-5', NOW), E.priceFor('claude-opus-5', SEPT));
  assert.equal(E.priceFor('nope', NOW), null);
});

/* ---------- token estimation ---------- */
test('estimateTokens: deterministic, empty is 0, tiny is at least 1', () => {
  assert.equal(E.estimateTokens(''), 0);
  assert.equal(E.estimateTokens(null), 0);
  assert.equal(E.estimateTokens('a'), 1);
  assert.equal(E.estimateTokens('hello world'), E.estimateTokens('hello world'));
});
test('estimateTokens: prose lands near chars/4 and grows with input', () => {
  const prose = 'The quick brown fox jumps over the lazy dog and keeps on running through the field. '.repeat(12);
  const est = E.estimateTokens(prose);
  assert.ok(est > prose.length / 6 && est < prose.length / 2.5, `prose estimate in range: ${est} for ${prose.length} chars`);
  assert.ok(E.estimateTokens(prose + prose) > est, 'more text, more tokens');
});
test('estimateTokens: symbol-dense code estimates denser than same-length prose', () => {
  const code = 'const x = {a: [1, 2], b: (y) => y * 2}; if (x.a[0] === 1) { x.b(3); }';
  const prose = 'the cat sat on the mat and then the dog sat on the mat too okay yes'.slice(0, code.length);
  assert.ok(E.estimateTokens(code) > E.estimateTokens(prose), 'code > prose per char');
});
test('textStats counts chars, words, lines and tokens together', () => {
  const s = E.textStats('one two\nthree');
  assert.equal(s.chars, 13);
  assert.equal(s.words, 3);
  assert.equal(s.lines, 2);
  assert.ok(s.tokens >= 1);
  deepEq(E.textStats(''), { chars: 0, words: 0, lines: 0, tokens: 0 });
});

/* ---------- costing & comparison ---------- */
test('costOf: exact list-price arithmetic', () => {
  const c = E.costOf('claude-opus-5', 100000, 10000, NOW);
  close(c.input, 0.5, 'input: 100k @ $5/M');
  close(c.output, 0.25, 'output: 10k @ $25/M');
  close(c.total, 0.75);
  assert.equal(E.costOf('nope', 1, 1, NOW), null);
  close(E.costOf('claude-haiku-4-5', 0, 0, NOW).total, 0, 'zero tokens cost nothing');
});
test('costOf uses intro pricing under the injected clock', () => {
  close(E.costOf('claude-sonnet-5', 1e6, 0, NOW).total, 2, 'intro $2/M');
  close(E.costOf('claude-sonnet-5', 1e6, 0, SEPT).total, 3, 'list $3/M after');
});
test('compareModels: cheapest first, Haiku wins, Fable priciest, all models present', () => {
  const rows = E.compareModels(50000, 2000, NOW);
  assert.equal(rows.length, E.MODELS.length);
  assert.equal(rows[0].model.id, 'claude-haiku-4-5');
  assert.equal(rows[rows.length - 1].model.id, 'claude-fable-5');
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].cost.total >= rows[i - 1].cost.total, 'sorted ascending');
  }
});
test('contextFit: Haiku 200k window overflows where the 1M models fit', () => {
  const big = 500000;
  assert.equal(E.contextFit('claude-haiku-4-5', big).fits, false);
  assert.equal(E.contextFit('claude-opus-5', big).fits, true);
  close(E.contextFit('claude-opus-5', big).pct, 0.5);
  assert.equal(E.contextFit('claude-haiku-4-5', 9e9).pct, 1, 'pct clamps at 1');
});

/* ---------- cache economics ---------- */
test('cachePlan: 5m TTL — 1 write + reads vs full price, break-even at 2 requests', () => {
  const one = E.cachePlan('claude-opus-5', 1e6, 1, '5m', NOW);
  assert.equal(one.worthIt, false, 'a single request only pays the write premium');
  close(one.cached, 5 * 1.25);
  const two = E.cachePlan('claude-opus-5', 1e6, 2, '5m', NOW);
  close(two.uncached, 10);
  close(two.cached, 5 * 1.25 + 5 * 0.1);
  assert.equal(two.worthIt, true, '5m TTL pays for itself at two requests');
});
test('cachePlan: 1h TTL writes at 2× and needs three requests to win', () => {
  assert.equal(E.cachePlan('claude-opus-5', 1e6, 2, '1h', NOW).worthIt, false);
  const three = E.cachePlan('claude-opus-5', 1e6, 3, '1h', NOW);
  close(three.uncached, 15);
  close(three.cached, 5 * 2 + 5 * 0.1 * 2);
  assert.equal(three.worthIt, true);
  assert.equal(three.ttl, '1h');
});

/* ---------- the ledger ---------- */
test('validateEntry: fills timestamp, clamps junk, needs a model and some tokens', () => {
  const v = E.validateEntry({ model: 'claude-opus-5', inTokens: '1200.9', outTokens: -5, note: '  daily digest  ' }, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.entry.ts, NOW);
  assert.equal(v.entry.inTokens, 1200);
  assert.equal(v.entry.outTokens, 0);
  assert.equal(v.entry.note, 'daily digest');
  assert.equal(E.validateEntry({ model: 'nope', inTokens: 5 }, NOW).ok, false);
  assert.equal(E.validateEntry({ model: 'claude-opus-5', inTokens: 0, outTokens: 0 }, NOW).ok, false);
});
test('entryCost prices at the entry timestamp, not the viewing clock', () => {
  const augustSonnet = { ts: NOW, model: 'claude-sonnet-5', inTokens: 1e6, outTokens: 0 };
  close(E.entryCost(augustSonnet), 2, 'August entry keeps its intro price forever');
  close(E.entryCost({ ...augustSonnet, ts: SEPT }), 3);
});
test('monthReport: only this UTC month counts, rollup by model, straight-line projection', () => {
  const entries = [
    { ts: NOW, model: 'claude-opus-5', inTokens: 1e6, outTokens: 0 },          // $5
    { ts: NOW - DAY, model: 'claude-opus-5', inTokens: 0, outTokens: 1e6 },    // $25
    { ts: NOW - DAY, model: 'claude-haiku-4-5', inTokens: 1e6, outTokens: 0 }, // $1
    { ts: NOW - 40 * DAY, model: 'claude-fable-5', inTokens: 1e6, outTokens: 1e6 }, // July — excluded
  ];
  const r = E.monthReport(entries, NOW);
  assert.equal(r.monthKey, '2026-08');
  assert.equal(r.count, 3);
  close(r.spend, 31);
  assert.equal(r.byModel[0].model, 'claude-opus-5', 'biggest spender first');
  close(r.byModel[0].spend, 30);
  assert.equal(r.dayOfMonth, 16);
  assert.equal(r.daysInMonth, 31);
  close(r.projected, 31 / 16 * 31);
});
test('budgetStatus: ok under budget, warn when projection blows it, over when spend does', () => {
  const r = E.monthReport([{ ts: NOW, model: 'claude-opus-5', inTokens: 2e6, outTokens: 0 }], NOW); // $10, projects ~$19.4
  assert.equal(E.budgetStatus(r, 0).hasBudget, false);
  assert.equal(E.budgetStatus(r, 50).status, 'ok');
  assert.equal(E.budgetStatus(r, 15).status, 'warn', 'projection over, spend under');
  assert.equal(E.budgetStatus(r, 8).status, 'over');
  close(E.budgetStatus(r, 50).left, 40);
  assert.equal(E.budgetStatus(r, 8).pct, 1, 'bar clamps at full');
});

/* ---------- formatters ---------- */
test('formatUSD: sub-cent honesty at token scale', () => {
  assert.equal(E.formatUSD(0), '$0');
  assert.equal(E.formatUSD(0.00004), '<$0.0001');
  assert.equal(E.formatUSD(0.0042), '$0.0042');
  assert.equal(E.formatUSD(0.75), '$0.75');
  assert.equal(E.formatUSD(12.4), '$12.40');
  assert.equal(E.formatUSD(1234), '$1,234');
});
test('formatTokens: k and M shorthand', () => {
  assert.equal(E.formatTokens(999), '999');
  assert.equal(E.formatTokens(1200), '1.2k');
  assert.equal(E.formatTokens(1000000), '1M');
  assert.equal(E.formatTokens(3400000), '3.4M');
  assert.equal(E.formatTokens(-5), '0');
});
test('escapeHTML neutralises markup', () => {
  assert.equal(E.escapeHTML('<b a="1">&\''), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;');
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\ntokens: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
