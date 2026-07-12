#!/usr/bin/env node
/**
 * Unit tests for the fork-safety layer — the deterministic transcendentals that
 * make Cortex's consensus reproducible bit-for-bit across machines. Two things:
 *   (1) ACCURACY — detExp/detLn/detTanh/detSigmoid match Math.* to ~1e-10, so
 *       the model still learns exactly as before;
 *   (2) DETERMINISM — a set of PINNED exact values (function outputs + genesis
 *       weights + a reference loss). Because these are built only from IEEE-754
 *       correctly-rounded ops (+ − × ÷ √), every conforming platform MUST
 *       reproduce these exact doubles. If this suite passes on two machines,
 *       they agree on consensus. If a machine ever fails a pinned value, that
 *       machine's arithmetic is non-conforming — which is exactly what we want
 *       to catch. Loaded in a vm sandbox. Run: node scripts/test-cortex-determinism.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const box = { module: { exports: {} } }; box.self = box; vm.createContext(box);
const load = (p, g) => { box.module = { exports: {} }; vm.runInContext(readFileSync(join(ROOT, p), 'utf8'), box, { filename: p }); if (g) box[g] = box.module.exports; return box.module.exports; };
load('coin/engine.js', 'BallrzCoin');
load('cortex/datasets.js', 'BallrzCortexData');
const X = load('cortex/engine.js', 'BallrzCortex');

let n = 0; const tests = []; const test = (name, fn) => tests.push([name, fn]);

test('deterministic exp/ln/tanh/sigmoid match Math.* to ~1e-10', () => {
  let e = 0, l = 0, t = 0, s = 0;
  for (let x = -40; x <= 40; x += 0.011) e = Math.max(e, Math.abs(X.detExp(x) - Math.exp(x)) / (Math.exp(x) + 1e-30));
  for (let x = 1e-6; x <= 1e6; x *= 1.013) l = Math.max(l, Math.abs(X.detLn(x) - Math.log(x)) / (Math.abs(Math.log(x)) + 1e-30));
  for (let x = -15; x <= 15; x += 0.013) t = Math.max(t, Math.abs(X.detTanh(x) - Math.tanh(x)));
  for (let x = -30; x <= 30; x += 0.017) s = Math.max(s, Math.abs(X.detSigmoid(x) - 1 / (1 + Math.exp(-x))));
  assert.ok(e < 1e-9, `exp rel err ${e.toExponential(2)}`);
  assert.ok(l < 1e-9, `ln rel err ${l.toExponential(2)}`);
  assert.ok(t < 1e-9, `tanh abs err ${t.toExponential(2)}`);
  assert.ok(s < 1e-9, `sigmoid abs err ${s.toExponential(2)}`);
});

test('identities hold exactly', () => {
  assert.equal(X.detExp(0), 1);
  assert.equal(X.detLn(1), 0);
  assert.equal(X.detTanh(0), 0);
  assert.equal(X.detSigmoid(0), 0.5);
  // round-trip ln(exp(x)) ≈ x
  for (let x = -5; x <= 5; x += 0.5) assert.ok(Math.abs(X.detLn(X.detExp(x)) - x) < 1e-9);
  // tanh saturates; sigmoid saturates to the nearest representable double
  assert.equal(X.detTanh(50), 1); assert.equal(X.detTanh(-50), -1);
  assert.ok(X.detSigmoid(50) > 0.99 && X.detSigmoid(50) <= 1);
  assert.ok(X.detSigmoid(-50) >= 0 && X.detSigmoid(-50) < 0.01);
});

test('PINNED exact values — every IEEE-754 platform must reproduce these bits', () => {
  // If any of these fail on your machine, its floating point is non-conforming
  // and it cannot safely validate the chain. These are the cross-machine oracle.
  assert.equal(X.detExp(0.5), 1.648721270700089);
  assert.equal(X.detLn(2), 0.6931471805599453);
  assert.equal(X.detTanh(1), 0.761594155955765);
  assert.equal(X.detSigmoid(1), 0.7310585786305351);
});

test('PINNED consensus reference — genesis weights and loss are bit-exact', () => {
  const t = X.makeTask({ id: 'det-ref' });
  const w = X.randomWeights(t, 'ref');
  // genesis weights come from the integer PRNG + Irwin–Hall (no transcendentals)
  assert.equal(w.slice(0, 3).join(','), '0.6213759999999999,0.12745399999999998,-1.0460239999999998');
  // the loss a validator recomputes to check a block — must be identical everywhere
  assert.equal(X.loss(t, w), 0.7353263517686769);
  assert.equal(X.accuracy(t, w), 0.475);
});

test('recomputation is stable and the consensus path avoids Math transcendentals', () => {
  const t = X.makeTask({ id: 'det-ref' });
  const w = X.randomWeights(t, 'ref');
  assert.equal(X.loss(t, w), X.loss(t, w), 'loss is a pure function');
  // sampleLoss (prover source of truth) averages to loss exactly
  let s = 0; for (let i = 0; i < t.samples; i++) s += X.sampleLoss(t, w, t.X[i], t.y[i]);
  assert.equal(Math.round((s / t.samples) * 1e12) / 1e12, Math.round(X.loss(t, w) * 1e12) / 1e12, 'sampleLoss mean == loss');
  // the deployable engine must not CALL Math.{exp,log,tanh,cos,sin,pow} in the
  // consensus path (match actual calls — the trailing "(" — not comments).
  const src = readFileSync(join(ROOT, 'cortex', 'engine.js'), 'utf8');
  assert.equal(/Math\.(exp|log|tanh|cos|sin|pow)\s*\(/.test(src), false, 'no non-deterministic Math transcendental calls in engine.js');
});

// ---- runner ----------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); n++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
}
console.log(`\n${n}/${tests.length} cortex determinism tests passed`);
if (failed) process.exit(1);
