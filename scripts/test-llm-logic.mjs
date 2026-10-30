#!/usr/bin/env node
/**
 * Unit tests for llm-from-scratch/web/gpt.js — the browser inference engine
 * behind ApexAI — against reference values produced by the NumPy model
 * (llm-from-scratch/tools/make_parity_fixture.py → web/test/parity-fixture.json):
 *   • logits parity with the Python forward pass for the v1 (GPT-2 style) and
 *     v2 (Llama style: RoPE/RMSNorm/SwiGLU/tied) architectures, for f4, f2,
 *     q8 and the original format-1 export layout;
 *   • the KV cache: incremental stepping == a fresh full pass, the
 *     logitsForLast() prefix fast path, rebuilds, and contexts longer than
 *     the window (learned positions crop like model.py; rotary ones slide);
 *   • tokenizer parity (char + BPE) with the Python tokenizers, incl.
 *     whitespace runs, unicode and surrogate pairs; the merge-rank key fix;
 *   • the sampler (top-k, top-p, repetition penalty, seeded determinism);
 *   • tensor decoding (f2, q8).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-llm-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LLM = join(ROOT, 'llm-from-scratch');
const sandbox = { module: { exports: {} }, Buffer };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(LLM, 'web', 'gpt.js'), 'utf8'), sandbox, { filename: 'web/gpt.js' });
const G = sandbox.module.exports;
const FIX = JSON.parse(readFileSync(process.env.LLM_FIXTURE || join(LLM, 'web', 'test', 'parity-fixture.json'), 'utf8'));

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const maxAbsDiff = (a, b) => { let m = 0; for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
// a deterministic rng for the sampler tests (mulberry32)
const seeded = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const argmax = (v) => { let b = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[b]) b = i; return b; };

/* ---------- decoding ---------- */
test('decodeTensor: q8 rebuilds q * scale[column]', () => {
  const q = Int8Array.from([127, -127, 0, 64, 1, -1]);           // shape (2, 3)
  const scale = Float32Array.from([0.5, 2, 0.01]);
  const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  const out = G.decodeTensor({ shape: [2, 3], dtype: 'q8', data: b64(new Uint8Array(q.buffer)), scale: b64(new Uint8Array(scale.buffer)) });
  deepEq(Array.from(out, (x) => +x.toFixed(4)), [63.5, -254, 0, 32, 2, -0.01]);
});
test('decodeTensor: q8 axis "row" uses one scale per row', () => {
  const q = Int8Array.from([127, -127, 0, 64, 1, -1]);           // shape (2, 3)
  const scale = Float32Array.from([0.5, 2]);
  const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  const out = G.decodeTensor({ shape: [2, 3], dtype: 'q8', axis: 'row', data: b64(new Uint8Array(q.buffer)), scale: b64(new Uint8Array(scale.buffer)) });
  deepEq(Array.from(out), [63.5, -63.5, 0, 128, 2, -2]);
});
test('decodeTensor: f2 halves decode (1, -2.5, 0, 65504, subnormal)', () => {
  const u16 = Uint16Array.from([0x3c00, 0xc100, 0x0000, 0x7bff, 0x0001]);
  const out = G.decodeTensor({ shape: [5], dtype: 'f2', data: Buffer.from(u16.buffer).toString('base64') });
  deepEq(Array.from(out), [1, -2.5, 0, 65504, 5.960464477539063e-8]);
});
test('decodeTensor: file-level dtype applies when a tensor has none (format 1)', () => {
  const u16 = Uint16Array.from([0x3c00]);
  assert.equal(G.decodeTensor({ shape: [1], data: Buffer.from(u16.buffer).toString('base64') }, 'f2')[0], 1);
  const f32 = Float32Array.from([3.25]);
  assert.equal(G.b64ToFloat32(Buffer.from(f32.buffer).toString('base64'))[0], 3.25);
});

/* ---------- tokenizers ---------- */
for (const v of FIX.variants) {
  test(`tokenizer parity [${v.arch} ${v.spec.tokenizer.type}]: sample text + prompts match Python ids, round-trip`, () => {
    const tok = G.makeTokenizer(v.spec.tokenizer);
    deepEq(tok.encode(FIX.sample_text), v.sample_ids, 'sample text ids');
    for (const [p, ids] of Object.entries(v.prompt_ids)) deepEq(tok.encode(p), ids, JSON.stringify(p));
    assert.equal(tok.decode(tok.encode(FIX.sample_text)), FIX.sample_text, 'round trip');
  });
}
test('BPE rank keys do not collide for whitespace-run pairs', () => {
  // Only the merge (" ","  ") exists here. Joined with a space, its key is four
  // spaces — the same key ("  "," ") would get — so the old port merged
  // ["  ", " "] into "   " where tokenizer.py (which keys on the tuple) stops.
  const tok = G.makeTokenizer({ type: 'bpe', vocab: [' ', '  ', '   ', 'a'], merges: [[' ', ' '], [' ', '  ']] });
  deepEq(tok.encode('   '), [1, 0]);         // merge(" "," ") -> ["  "," "]; ("  "," ") has no rank -> stop
  deepEq(tok.encode('    '), [1, 1]);        // all adjacent (" "," ") pairs merge in one greedy pass
  const tok2 = G.makeTokenizer({ type: 'bpe', vocab: [' ', '  ', '   ', 'a'], merges: [[' ', ' '], ['  ', ' ']] });
  deepEq(tok2.encode('   '), [2]);           // here the second merge IS ("  "," ")
  assert.equal(tok2.decode(tok2.encode('    a   ')), '    a   ');
});

/* ---------- logits parity + KV cache ---------- */
for (const v of FIX.variants) {
  const label = `${v.arch} ${v.dtype}`;
  test(`logits parity [${label}]: ${v.cases.length} cases match the NumPy forward pass`, () => {
    const m = new G.Model(v.spec);
    let worst = 0, worstBeyond = 0;
    for (const c of v.cases) {
      const got = m.logitsForLast(c.ids.slice(0, c.len));
      const d = maxAbsDiff(got, c.logits);
      if (c.beyond_block) worstBeyond = Math.max(worstBeyond, d); else worst = Math.max(worst, d);
    }
    assert.ok(worst < 2e-4, `within-window max abs diff ${worst}`);
    // A cold prompt longer than the window is cropped to the last block_size
    // tokens with positions from 0 — exactly model.py's crop — for both
    // learned and rotary positions, so the same tolerance applies.
    assert.ok(worstBeyond < 2e-4, `beyond-window max abs diff ${worstBeyond}`);
  });
  test(`KV cache [${label}]: two instances stepping the same ids agree bit for bit (determinism; parity is the teacher-forced test)`, () => {
    const a = new G.Model(v.spec), b = new G.Model(v.spec);
    const ids = v.sample_ids.slice(0, v.spec.config.block_size);
    let inc = null;
    for (const id of ids) inc = Float32Array.from(a.stepToken(id));
    const full = b.logitsForLast(ids);
    assert.equal(maxAbsDiff(inc, full), 0);
  });
  test(`logitsForLast [${label}]: prefix fast path, repeat call, rebuild all agree`, () => {
    const m = new G.Model(v.spec), ref = new G.Model(v.spec);
    const ids = v.sample_ids.slice(0, 8);
    const l1 = Float32Array.from(m.logitsForLast(ids.slice(0, 5)));
    assert.equal(m.cache.history.length, 5);
    const l2 = Float32Array.from(m.logitsForLast(ids.slice(0, 6)));   // +1 token: single step
    assert.equal(m.cache.history.length, 6, 'extended by one step, not rebuilt');
    deepEq(Array.from(m.logitsForLast(ids.slice(0, 6))), Array.from(l2), 'same ids → same logits');
    assert.equal(maxAbsDiff(l2, ref.logitsForLast(ids.slice(0, 6))), 0);
    const l3 = Float32Array.from(m.logitsForLast(ids.slice(2, 8)));   // unrelated: rebuild
    assert.equal(maxAbsDiff(l3, new G.Model(v.spec).logitsForLast(ids.slice(2, 8))), 0);
    assert.notEqual(maxAbsDiff(l1, l3), 0);
  });
  test(`long context [${label}]: past block_size the cache rebuilds over the recent 3/4 window, exactly`, () => {
    const B = v.spec.config.block_size, keep = B - Math.floor(B / 4);
    const ids = v.sample_ids.slice(0, 2 * B + 3);                 // overflows more than once
    const m = new G.Model(v.spec);
    // the documented policy (GPT.crop_window), simulated: once more than B tokens
    // are in play, the newest `keep` of them (the new one included) remain
    let win = [], lg = null;
    for (const id of ids) {
      win.push(id);
      if (win.length > B) win = win.slice(-keep);
      lg = m.stepToken(id);
    }
    const expected = new G.Model(v.spec).logitsForLast(win);       // a plain pass over that window
    assert.equal(maxAbsDiff(lg, expected), 0);
    assert.equal(m.cache.len, win.length);
    assert.ok(win.length > keep && win.length <= B);
    assert.equal(m.cache.history.length, ids.length, 'full history kept for prefix detection');
    // and logitsForLast on the full ids keeps using the fast path afterwards
    const next = v.sample_ids[ids.length];
    win.push(next);
    if (win.length > B) win = win.slice(-keep);
    const viaPrefix = Float32Array.from(m.logitsForLast(ids.concat([next])));
    assert.equal(m.cache.history.length, ids.length + 1);
    assert.equal(maxAbsDiff(viaPrefix, new G.Model(v.spec).logitsForLast(win)), 0);
  });
}

for (const v of FIX.variants.filter((x) => x.stepwise)) {
  test(`teacher-forced parity [${v.arch} ${v.dtype}]: ${v.stepwise.ids.length} steps through two window overflows match Python at every step`, () => {
    const m = new G.Model(v.spec);
    let worst = 0;
    v.stepwise.ids.forEach((id, i) => { worst = Math.max(worst, maxAbsDiff(m.stepToken(id), v.stepwise.logits[i])); });
    assert.ok(worst < 2e-4, `stepToken max abs diff ${worst}`);
    // the page's path: logitsForLast with the growing id list (prefix fast path)
    const m2 = new G.Model(v.spec), ids = [];
    let worst2 = 0;
    v.stepwise.ids.forEach((id, i) => { ids.push(id); worst2 = Math.max(worst2, maxAbsDiff(m2.logitsForLast(ids), v.stepwise.logits[i])); });
    assert.ok(worst2 < 2e-4, `logitsForLast max abs diff ${worst2}`);
    assert.equal(m2.cache.history.length, ids.length);
  });
}

test('the committed v1 model files (niche Names / Microcopy models) still load and run', () => {
  for (const [file, prompt] of [['model-names.json', 'Noir '], ['model-microcopy.json', 'booked: ']]) {
    const spec = JSON.parse(readFileSync(join(LLM, 'web', file), 'utf8'));
    const m = new G.Model(spec);
    assert.equal(m.posEmb, 'learned'); assert.equal(m.format, 1);
    const ids = m.tokenizer.encode(prompt);
    assert.ok(ids.length > 0);
    const lg = m.logitsForLast(ids);
    assert.equal(lg.length, spec.config.vocab_size);
    for (let i = 0; i < lg.length; i++) assert.ok(Number.isFinite(lg[i]), `${file}: non-finite logit`);
    const out = m.generate(prompt, 12, { topK: 5, rng: seeded(1) });
    assert.ok(out.length > 0);
  }
});
test('BPE/char tokenizers survive words that are Object.prototype keys', () => {
  const v = FIX.variants.find((x) => x.arch === 'v2' && x.dtype === 'f4');
  const tok = G.makeTokenizer(v.spec.tokenizer);
  for (const w of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf constructor']) {
    const ids = tok.encode(w);
    assert.ok(Array.isArray(ids) && ids.every((i) => Number.isInteger(i)), w);
    assert.equal(tok.decode(ids), [...w].filter((ch) => v.sample_text.includes(ch)).length === w.length ? w : tok.decode(ids));
  }
  const ct = G.makeTokenizer({ type: 'char', chars: ['c', 'o', 'n', 's', 't', 'r', 'u'] });
  deepEq(ct.encode('constructor'), [0, 1, 2, 3, 4, 5, 6, 0, 4, 1, 5]);
  assert.equal(ct.decode(ct.encode('constructor')), 'constructor');
});
for (const v of FIX.variants.filter((x) => x.dtype === 'f4')) {
  test(`long prompt [${v.arch}]: after a prompt longer than block_size, the next token is one step, not a rebuild`, () => {
    const B = v.spec.config.block_size, keep = B - Math.floor(B / 4);
    const ids = v.sample_ids.slice(0, B + 7);
    const m = new G.Model(v.spec);
    m.logitsForLast(ids);                          // cold: runs the last B tokens
    assert.equal(m.cache.history.length, ids.length, 'full prompt remembered');
    assert.equal(m.cache.len, B);
    const next = v.sample_ids[B + 7];
    const lg = Float32Array.from(m.logitsForLast(ids.concat([next])));
    assert.equal(m.cache.history.length, ids.length + 1, 'one step appended');
    assert.equal(m.cache.len, keep, 'window overflowed into the newest `keep` tokens');
    // equals Python's policy: window = newest keep tokens including `next`
    const expected = new G.Model(v.spec).logitsForLast(ids.concat([next]).slice(-keep));
    assert.equal(maxAbsDiff(lg, expected), 0);
  });
}
test('the page uses the one sampler in gpt.js (no second copy to drift)', () => {
  const html = readFileSync(join(LLM, 'web', 'index.html'), 'utf8');
  assert.ok(!/function sampleFrom\s*\(/.test(html));
  assert.ok(/GPTLib\.sample\(/.test(html));
  assert.ok(/gpt\.js\?v=2/.test(html), 'versioned engine URL');
  const sw = readFileSync(join(LLM, 'web', 'sw.js'), 'utf8');
  assert.ok(/gpt\.js\?v=2/.test(sw), 'service worker precaches the same engine URL');
});

/* ---------- sampling + generate ---------- */
test('sample: top-k 1 is argmax; tiny top-p is argmax; temperature does not change argmax', () => {
  const logits = Float32Array.from([0.1, 2.5, -1, 2.4, 0]);
  assert.equal(G.sample(logits, { topK: 1, rng: seeded(1) }), 1);
  assert.equal(G.sample(logits, { topP: 1e-9, rng: seeded(1) }), 1);
  assert.equal(G.sample(logits, { temperature: 0.01, rng: seeded(9) }), 1);
});
test('sample: repetition penalty pushes a seen token below an unseen rival', () => {
  const logits = Float32Array.from([2.0, 1.9, -5, -5]);
  assert.equal(G.sample(logits, { topK: 1 }), 0);
  assert.equal(G.sample(logits, { topK: 1, repetitionPenalty: 1.5 }, [0]), 1);
  // negative logits are multiplied (made more negative), never divided toward zero
  const neg = Float32Array.from([-1.0, -1.1]);
  assert.equal(G.sample(neg, { topK: 1, repetitionPenalty: 1.5 }, [0]), 1);
});
test('sample: seeded rng is deterministic and respects the top-k set', () => {
  const logits = Float32Array.from(Array.from({ length: 50 }, (_, i) => Math.sin(i) * 3));
  const a = Array.from({ length: 20 }, (_, i) => G.sample(logits, { topK: 3, temperature: 1, rng: seeded(i) }));
  const b = Array.from({ length: 20 }, (_, i) => G.sample(logits, { topK: 3, temperature: 1, rng: seeded(i) }));
  deepEq(a, b);
  const order = Array.from(logits.keys()).sort((x, y) => logits[y] - logits[x]).slice(0, 3);
  for (const id of a) assert.ok(order.includes(id), `token ${id} outside top-3`);
});
test('generate: emits exactly n tokens, deterministic under a seeded rng, streams via onToken', () => {
  const v = FIX.variants.find((x) => x.arch === 'v2' && x.dtype === 'f4');
  const m = new G.Model(v.spec);
  const pieces = [];
  const out = m.generate('It was a', 7, { temperature: 0.9, topK: 20, rng: seeded(3) }, (t) => pieces.push(t));
  assert.equal(pieces.length, 7);
  assert.equal(pieces.join(''), out);
  assert.equal(new G.Model(v.spec).generate('It was a', 7, { temperature: 0.9, topK: 20, rng: seeded(3) }), out);
  // repetitionWindow limits the penalised context to the last N ids
  const r = new G.Model(v.spec).generate('It was a', 5, { repetitionPenalty: 1.3, repetitionWindow: 2, rng: seeded(5) });
  assert.equal(typeof r, 'string');
});
test('Model exposes config, meta, tokenizer and the architecture switches (v1 defaults)', () => {
  const v1 = FIX.variants.find((x) => x.dtype === 'f2-legacy');
  const m = new G.Model(v1.spec);
  assert.equal(m.posEmb, 'learned'); assert.equal(m.normKind, 'layernorm'); assert.equal(m.mlpKind, 'gelu');
  assert.equal(m.tied, false); assert.equal(m.meta, null); assert.equal(m.format, 1);
  const v2 = new G.Model(FIX.variants.find((x) => x.arch === 'v2' && x.dtype === 'q8').spec);
  assert.equal(v2.posEmb, 'rope'); assert.equal(v2.normKind, 'rmsnorm'); assert.equal(v2.mlpKind, 'swiglu');
  assert.equal(v2.tied, true); assert.equal(v2.headT, null); assert.equal(v2.format, 2);
  assert.ok(v2.meta && v2.meta.fixture);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n  ${e && e.stack || e}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} llm tests passed`);
if (passed !== tests.length) process.exit(1);
