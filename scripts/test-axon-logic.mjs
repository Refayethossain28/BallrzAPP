#!/usr/bin/env node
/**
 * Unit tests for axon/engine.js — the from-scratch neural network behind
 * Axon (seeded init, forward pass, softmax + cross-entropy backprop checked
 * against numeric gradients, momentum SGD that actually learns XOR and the
 * bullseye, deterministic datasets, the decision map, and save/load).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-axon-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'axon', 'engine.js'), 'utf8'), sandbox, { filename: 'axon/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---------- seeded randomness ---------- */
test('rng: same seed, same stream; different seed, different stream; in [0,1)', () => {
  const a = E.rng('s1'), b = E.rng('s1'), c = E.rng('s2');
  const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
  deepEq(sa, sb);
  assert.notEqual(JSON.stringify(sa), JSON.stringify(sc));
  for (const v of sa) assert.ok(v >= 0 && v < 1, `got ${v}`);
});
test('rng spreads: 1000 draws cover low and high halves roughly evenly', () => {
  const r = E.rng('spread');
  let lo = 0;
  for (let i = 0; i < 1000; i++) if (r() < 0.5) lo++;
  assert.ok(lo > 400 && lo < 600, `got ${lo}/1000 below 0.5`);
});
test('gaussian: mean ≈ 0, sd ≈ 1 over 4000 draws', () => {
  const r = E.rng('gauss');
  let sum = 0, sq = 0; const N = 4000;
  for (let i = 0; i < N; i++) { const g = E.gaussian(r); sum += g; sq += g * g; }
  const mean = sum / N, sd = Math.sqrt(sq / N - mean * mean);
  assert.ok(Math.abs(mean) < 0.06, `mean ${mean}`);
  assert.ok(Math.abs(sd - 1) < 0.06, `sd ${sd}`);
});

/* ---------- senses ---------- */
test('featurize: raw and rich modes', () => {
  deepEq(E.featurize({ x: 0.5, y: -0.25 }, 'xy'), [0.5, -0.25]);
  deepEq(E.featurize({ x: 0.5, y: -0.25 }, 'rich'), [0.5, -0.25, 0.25, 0.0625, -0.125]);
  deepEq(E.featurize({ x: 'junk', y: null }, 'xy'), [0, 0]);
});

/* ---------- building the net ---------- */
test('createNet: shapes match the spec, output head is always 3 classes', () => {
  const net = E.createNet({ hidden: [8, 6], activation: 'tanh', seed: 'me', features: 'xy' });
  deepEq(net.sizes, [2, 8, 6, 3]);
  assert.equal(net.weights.length, 3);
  assert.equal(net.weights[0].length, 8);
  assert.equal(net.weights[0][0].length, 2);
  assert.equal(net.weights[2].length, 3);
  assert.equal(net.biases[1].length, 6);
  assert.equal(net.epochs, 0);
  assert.equal(E.paramCount(net), 8 * 2 + 8 + 6 * 8 + 6 + 3 * 6 + 3);
  assert.ok(E.describe(net).includes('2 → 8 → 6 → 3'));
});
test('createNet: rich senses widen the input layer; sizes are clamped', () => {
  deepEq(E.createNet({ hidden: [4], features: 'rich', seed: 's' }).sizes, [5, 4, 3]);
  deepEq(E.createNet({ hidden: [0, 99], seed: 's' }).sizes, [2, 1, 32, 3]);
  deepEq(E.createNet({ seed: 's' }).sizes, [2, 8, 3], 'defaults');
});
test('createNet is deterministic: same seed twins, different seed diverges', () => {
  const a = E.createNet({ hidden: [5], seed: 'twin' });
  const b = E.createNet({ hidden: [5], seed: 'twin' });
  const c = E.createNet({ hidden: [5], seed: 'other' });
  deepEq(a.weights, b.weights);
  assert.notEqual(JSON.stringify(a.weights), JSON.stringify(c.weights));
});

/* ---------- forward pass ---------- */
test('softmax: sums to 1, order-preserving, stable for huge inputs', () => {
  const p = E.softmax([1, 2, 3]);
  assert.ok(Math.abs(p[0] + p[1] + p[2] - 1) < 1e-12);
  assert.ok(p[2] > p[1] && p[1] > p[0]);
  const big = E.softmax([1000, 1001, 999]);
  assert.ok(big.every((v) => isFinite(v)) && Math.abs(big[0] + big[1] + big[2] - 1) < 1e-9);
});
test('forward: traces every layer; probs are a distribution', () => {
  const net = E.createNet({ hidden: [4], seed: 'fwd' });
  const f = E.forward(net, { x: 0.3, y: -0.7 });
  assert.equal(f.as.length, 3);
  assert.equal(f.as[0].length, 2);
  assert.equal(f.as[1].length, 4);
  assert.equal(f.as[2].length, 3);
  const sum = f.probs[0] + f.probs[1] + f.probs[2];
  assert.ok(Math.abs(sum - 1) < 1e-12 && f.probs.every((p) => p >= 0));
});
test('predict picks the argmax and reports its confidence', () => {
  const net = E.createNet({ hidden: [4], seed: 'pred' });
  const pr = E.predict(net, { x: 0.1, y: 0.2 });
  assert.ok(pr.k >= 0 && pr.k < 3);
  assert.equal(pr.p, Math.max(...pr.probs));
});

/* ---------- the calculus: backprop vs numeric gradients ---------- */
// The one test that proves the whole engine: nudge each parameter by ±ε and
// compare the measured slope of the loss with what backprop claims.
function gradCheck(activation, features) {
  const net = E.createNet({ hidden: [4, 3], activation, features, seed: 'grad-' + activation });
  const pts = [
    { x: 0.3, y: -0.6, k: 0 }, { x: -0.8, y: 0.2, k: 1 },
    { x: 0.5, y: 0.7, k: 2 }, { x: -0.1, y: -0.2, k: 1 },
  ];
  const g = E.backprop(net, pts);
  const eps = 1e-5;
  let worst = 0, checked = 0;
  for (let l = 0; l < net.weights.length; l++) {
    for (let i = 0; i < net.weights[l].length; i++) {
      for (let j = 0; j < net.weights[l][i].length; j++) {
        const w0 = net.weights[l][i][j];
        net.weights[l][i][j] = w0 + eps;
        const up = E.lossOf(net, pts);
        net.weights[l][i][j] = w0 - eps;
        const dn = E.lossOf(net, pts);
        net.weights[l][i][j] = w0;
        const numeric = (up - dn) / (2 * eps);
        const analytic = g.dW[l][i][j];
        const err = Math.abs(numeric - analytic) / Math.max(1e-6, Math.abs(numeric) + Math.abs(analytic));
        worst = Math.max(worst, err); checked++;
      }
      const b0 = net.biases[l][i];
      net.biases[l][i] = b0 + eps;
      const up = E.lossOf(net, pts);
      net.biases[l][i] = b0 - eps;
      const dn = E.lossOf(net, pts);
      net.biases[l][i] = b0;
      const err = Math.abs((up - dn) / (2 * eps) - g.db[l][i]) /
        Math.max(1e-6, Math.abs((up - dn) / (2 * eps)) + Math.abs(g.db[l][i]));
      worst = Math.max(worst, err); checked++;
    }
  }
  return { worst, checked };
}
test('gradient check (tanh): backprop matches numeric slopes on every parameter', () => {
  const { worst, checked } = gradCheck('tanh', 'xy');
  assert.ok(checked > 30, `only ${checked} params checked`);
  assert.ok(worst < 1e-4, `worst relative error ${worst}`);
});
test('gradient check (sigmoid + rich senses)', () => {
  assert.ok(gradCheck('sigmoid', 'rich').worst < 1e-4);
});
test('gradient check (relu)', () => {
  assert.ok(gradCheck('relu', 'xy').worst < 1e-3, 'relu (away from kinks)');
});

/* ---------- training ---------- */
test('trainEpoch: deterministic (twin nets stay twins), counts epochs, refuses bad data', () => {
  const data = E.makeDataset('blobs', { n: 60, seed: 'det' });
  const a = E.createNet({ hidden: [6], seed: 'twin' });
  const b = E.createNet({ hidden: [6], seed: 'twin' });
  const ra = E.trainEpoch(a, data, { lr: 0.1 });
  const rb = E.trainEpoch(b, data, { lr: 0.1 });
  deepEq(a.weights, b.weights);
  deepEq(ra, rb);
  assert.equal(a.epochs, 1);
  assert.equal(E.trainEpoch(a, [], {}), null, 'empty data');
  assert.equal(E.trainEpoch(a, [{ x: 0, y: 0, k: 0 }, { x: 1, y: 1, k: 0 },
    { x: 0, y: 1, k: 0 }, { x: 1, y: 0, k: 0 }], {}), null, 'single class');
  assert.equal(a.epochs, 1, 'refused passes don’t count');
});
test('training LEARNS: the checkerboard (XOR) reaches ≥97% from a cold start', () => {
  const net = E.createNet({ hidden: [8], activation: 'tanh', seed: 'xor-run' });
  const data = E.makeDataset('xor', { n: 120, seed: 'xor-run' });
  const before = E.evaluate(net, data);
  for (let e = 0; e < 200; e++) E.trainEpoch(net, data, { lr: 0.1, momentum: 0.9 });
  const after = E.evaluate(net, data);
  assert.ok(after.accuracy >= 0.97, `accuracy ${after.accuracy}`);
  assert.ok(after.loss < before.loss, 'loss went down');
});
test('training LEARNS: the bullseye needs a bent boundary and gets one', () => {
  const net = E.createNet({ hidden: [8], activation: 'tanh', seed: 'rings-run' });
  const data = E.makeDataset('rings', { n: 120, seed: 'rings-run' });
  for (let e = 0; e < 250; e++) E.trainEpoch(net, data, { lr: 0.1, momentum: 0.9 });
  assert.ok(E.evaluate(net, data).accuracy >= 0.97);
});
test('evaluate: exact arithmetic on a hand-checked case', () => {
  const net = E.createNet({ hidden: [4], seed: 'eval' });
  const pts = [{ x: 0.2, y: 0.1, k: 0 }, { x: -0.4, y: 0.9, k: 1 }];
  const ev = E.evaluate(net, pts);
  const hits = pts.filter((p) => E.predict(net, p).k === p.k).length;
  assert.equal(ev.correct, hits);
  assert.equal(ev.total, 2);
  assert.equal(ev.accuracy, hits / 2);
  assert.ok(ev.loss > 0);
});
test('trainable: needs 4+ dots and 2+ classes, with human reasons', () => {
  assert.equal(E.trainable([]).ok, false);
  assert.equal(E.trainable([{ k: 0 }, { k: 1 }, { k: 0 }]).ok, false);
  assert.equal(E.trainable([{ k: 0 }, { k: 0 }, { k: 0 }, { k: 0 }]).ok, false);
  assert.equal(E.trainable([{ k: 0 }, { k: 1 }, { k: 0 }, { k: 1 }]).ok, true);
  assert.ok(E.trainable([]).reason.length > 10);
});

/* ---------- datasets ---------- */
test('makeDataset: deterministic, clamped to [-1,1]², size clamps apply', () => {
  for (const d of E.DATASETS) {
    const a = E.makeDataset(d.key, { n: 90, seed: 'z' });
    const b = E.makeDataset(d.key, { n: 90, seed: 'z' });
    deepEq(a, b, d.key);
    assert.equal(a.length, 90);
    for (const p of a) {
      assert.ok(p.x >= -1 && p.x <= 1 && p.y >= -1 && p.y <= 1, `${d.key} in bounds`);
      assert.ok(p.k >= 0 && p.k < d.classes, `${d.key} class range`);
    }
    const used = new Set(a.map((p) => p.k));
    assert.equal(used.size, d.classes, `${d.key} uses all its classes`);
  }
  assert.equal(E.makeDataset('xor', { n: 1 }).length, 8, 'floor');
  assert.equal(E.makeDataset('xor', { n: 9999 }).length, 400, 'ceiling');
});
test('checkerboard labels actually follow the XOR rule', () => {
  for (const p of E.makeDataset('xor', { n: 100, seed: 'rule' })) {
    assert.equal(p.k, (p.x >= 0) !== (p.y >= 0) ? 1 : 0);
  }
});
test('spiral: three arms, balanced within one dot', () => {
  const counts = [0, 0, 0];
  for (const p of E.makeDataset('spiral', { n: 99, seed: 's' })) counts[p.k]++;
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, JSON.stringify(counts));
});

/* ---------- the decision map ---------- */
test('decisionGrid: right size, cells agree with predict() at cell centers', () => {
  const net = E.createNet({ hidden: [5], seed: 'grid' });
  const g = E.decisionGrid(net, 16);
  assert.equal(g.res, 16);
  assert.equal(g.k.length, 256);
  assert.equal(g.p.length, 256);
  // top-left cell is the upper-left of the canvas: x≈-1, y≈+1
  const tl = E.predict(net, { x: -1 + 1 / 16, y: 1 - 1 / 16 });
  assert.equal(g.k[0], tl.k);
  assert.ok(Math.abs(g.p[0] - tl.p) < 1e-12);
  const mid = E.predict(net, { x: -1 + 2 * (8 + 0.5) / 16, y: 1 - 2 * (3 + 0.5) / 16 });
  assert.equal(g.k[3 * 16 + 8], mid.k);
  assert.equal(E.decisionGrid(net, 9999).res, 128, 'res clamp');
});

/* ---------- identity & coaching ---------- */
test('netName: deterministic, two words from the rosters', () => {
  assert.equal(E.netName('me'), E.netName('me'));
  const parts = E.netName('someone').split(' ');
  assert.equal(parts.length, 2);
  assert.notEqual(E.netName('a'), E.netName('b'));
});
test('coachLine: fresh, guessing, and mastered read differently', () => {
  const fresh = E.coachLine({ epochs: 0 });
  const guessing = E.coachLine({ epochs: 10, accuracy: 0.5 });
  const done = E.coachLine({ epochs: 500, accuracy: 1 });
  assert.ok(fresh.includes('Fresh'));
  assert.ok(guessing.toLowerCase().includes('guessing'));
  assert.ok(done.includes('Learned it'));
  assert.equal(new Set([fresh, guessing, done]).size, 3);
});

/* ---------- save / load ---------- */
test('serialize → deserialize: the mind survives the round trip exactly', () => {
  const net = E.createNet({ hidden: [6, 4], activation: 'relu', features: 'rich', seed: 'keep' });
  const data = E.makeDataset('blobs', { n: 40, seed: 'keep' });
  for (let e = 0; e < 5; e++) E.trainEpoch(net, data, { lr: 0.05 });
  const back = E.deserialize(E.serialize(net));
  assert.equal(back.ok, true);
  deepEq(back.net.weights, net.weights);
  deepEq(back.net.sizes, net.sizes);
  assert.equal(back.net.epochs, net.epochs);
  const p = { x: 0.21, y: -0.53 };
  deepEq(E.predict(back.net, p), E.predict(net, p));
  const r = E.trainEpoch(back.net, data, { lr: 0.05 });
  assert.ok(r && isFinite(r.loss), 'restored net can keep training');
});
test('deserialize rejects junk: bad JSON, wrong version, tampered shapes, NaN', () => {
  assert.equal(E.deserialize('not json').ok, false);
  assert.equal(E.deserialize('{"v":2}').ok, false);
  const good = JSON.parse(E.serialize(E.createNet({ hidden: [4], seed: 'j' })));
  const wrongLen = JSON.parse(JSON.stringify(good));
  wrongLen.weights[0].pop();
  assert.equal(E.deserialize(JSON.stringify(wrongLen)).ok, false);
  const nan = JSON.parse(JSON.stringify(good));
  nan.weights[0][0][0] = 'NaN';
  assert.equal(E.deserialize(JSON.stringify(nan)).ok, false);
  const badHead = JSON.parse(JSON.stringify(good));
  badHead.sizes[badHead.sizes.length - 1] = 7;
  assert.equal(E.deserialize(JSON.stringify(badHead)).ok, false);
});

/* ---------- formatters & safety ---------- */
test('formatters: percent, loss, epoch counts', () => {
  assert.equal(E.fmtPct(0.923), '92%');
  assert.equal(E.fmtPct(2), '100%');
  assert.equal(E.fmtLoss(0.12345), '0.123');
  assert.equal(E.fmtLoss(NaN), '0.000');
  assert.equal(E.fmtEpochs(999), '999');
  assert.equal(E.fmtEpochs(4321), '4.3k');
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
console.log(`\n${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
