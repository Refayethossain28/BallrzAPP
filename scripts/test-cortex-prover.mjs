#!/usr/bin/env node
/**
 * Unit tests for cortex/prover.js — the phase-5 scoring-proof layer. Covers:
 * the committed transcript's mean equals the engine's loss; the authoritative
 * O(M) verifyFull accepts honest proofs and rejects tampered loss / leaf / root;
 * the cheap verifySampled catches aggregation lies deterministically and a
 * sampled leaf corruption via fraud proof; and — honestly — that a single
 * UN-sampled corruption can slip past the probabilistic spot-check while the
 * full check still catches it. Loaded in a vm sandbox with the coin engine,
 * dataset module and cortex engine. Run: node scripts/test-cortex-prover.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const box = { module: { exports: {} } }; box.self = box;
vm.createContext(box);
const load = (p, set) => { box.module = { exports: {} }; vm.runInContext(readFileSync(join(ROOT, p), 'utf8'), box, { filename: p }); if (set) box[set] = box.module.exports; return box.module.exports; };
const C = load('coin/engine.js', 'BallrzCoin');
load('cortex/datasets.js', 'BallrzCortexData');
const X = load('cortex/engine.js', 'BallrzCortex');
const P = load('cortex/prover.js', 'BallrzCortexProver');

// A trained banknote model + its raw data, shared across tests.
const task = X.makeTask({ id: 'prover', dataset: 'banknote', layers: [12], standardize: false });
const weights = X.train(task, X.randomWeights(task, 'p'), 400, 0.5);
const XS = task.X, YS = task.y;

let n = 0; const tests = []; const test = (name, fn) => tests.push([name, fn]);

test('the committed transcript mean equals the engine loss exactly', () => {
  const proof = P.scoreWithProof(task, weights, XS, YS);
  assert.equal(proof.leaves.length, XS.length);
  assert.equal(proof.loss, Math.round(X.loss(task, weights, XS, YS) * 1e9) / 1e9, 'transcript mean == engine.loss');
  assert.ok(/^[0-9a-f]{64}$/.test(proof.root), 'a Merkle root over the leaves');
  assert.equal(P.rootOf(proof.leaves), proof.root, 'root recomputes from the leaves');
});

test('verifyFull accepts an honest proof and rejects tampering', () => {
  const proof = P.scoreWithProof(task, weights, XS, YS);
  assert.equal(P.verifyFull(task, weights, XS, YS, proof).ok, true);
  // tampered aggregate loss
  const badLoss = { ...proof, loss: proof.loss - 0.2 };
  assert.equal(P.verifyFull(task, weights, XS, YS, badLoss).ok, false);
  // tampered leaf (+ root recomputed so it's a pure leaf lie)
  const leaves = proof.leaves.slice(); leaves[3] = leaves[3] + 1;
  const badLeaf = { loss: P.meanOf(leaves), leaves, root: P.rootOf(leaves) };
  const r = P.verifyFull(task, weights, XS, YS, badLeaf);
  assert.equal(r.ok, false); assert.match(r.reason, /leaf 3 is false/);
  // tampered root only
  assert.equal(P.verifyFull(task, weights, XS, YS, { ...proof, root: '00'.repeat(32) }).ok, false);
});

test('verifySampled accepts an honest proof, checking only k of M forward passes', () => {
  const proof = P.scoreWithProof(task, weights, XS, YS);
  const res = P.verifySampled(task, weights, XS, YS, proof, { beacon: 'b1', k: 16 });
  assert.equal(res.ok, true);
  assert.equal(res.checked, 16);
  assert.ok(res.checked < res.samples, `verified ${res.checked} of ${res.samples} samples`);
  assert.ok(res.soundness(0.1) > 0.8, 'catches a 10% corruption with >80% probability at k=16');
});

test('verifySampled catches an aggregation lie deterministically (no sampling needed)', () => {
  const proof = P.scoreWithProof(task, weights, XS, YS);
  const lie = { ...proof, loss: proof.loss - 0.3 }; // leaves honest, mean claim false
  const res = P.verifySampled(task, weights, XS, YS, lie, { beacon: 'b1', k: 16 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not the transcript mean/);
});

test('a sampled leaf corruption is caught as a fraud proof', () => {
  const proof = P.scoreWithProof(task, weights, XS, YS);
  const idx = P.sample('bX', XS.length, 16);       // the indices this beacon will check
  const victim = idx[0];
  const leaves = proof.leaves.slice();
  leaves[victim] = leaves[victim] + 2;             // corrupt a leaf that WILL be sampled
  const forged = { loss: P.meanOf(leaves), leaves, root: P.rootOf(leaves) }; // internally consistent
  const res = P.verifySampled(task, weights, XS, YS, forged, { beacon: 'bX', k: 16 });
  assert.equal(res.ok, false);
  assert.equal(res.fraudIndex, victim);
  assert.match(res.reason, /fraud proof/);
});

test('honesty: a single UN-sampled corruption slips past the spot-check but not verifyFull', () => {
  const proof = P.scoreWithProof(task, weights, XS, YS);
  const idx = new Set(P.sample('bY', XS.length, 16));
  let victim = 0; while (idx.has(victim)) victim++;  // an index this beacon does NOT check
  const leaves = proof.leaves.slice();
  leaves[victim] = leaves[victim] + 0.001;           // tiny lie, internally consistent
  const forged = { loss: P.meanOf(leaves), leaves, root: P.rootOf(leaves) };
  // cheap path misses it (this is the probabilistic tradeoff, stated honestly)...
  assert.equal(P.verifySampled(task, weights, XS, YS, forged, { beacon: 'bY', k: 16 }).ok, true);
  // ...the authoritative full check always catches it.
  assert.equal(P.verifyFull(task, weights, XS, YS, forged).ok, false);
});

test('soundness rises with k and with the size of the lie', () => {
  assert.ok(P.soundnessForMeanShift(32, 0.2, 3) > P.soundnessForMeanShift(8, 0.2, 3), 'more spot-checks -> more soundness');
  assert.ok(P.soundnessForMeanShift(16, 0.5, 3) > P.soundnessForMeanShift(16, 0.05, 3), 'bigger lie -> easier to catch');
  assert.ok(P.soundnessForMeanShift(16, 0.2, 3) >= 0 && P.soundnessForMeanShift(16, 0.2, 3) <= 1, 'a probability');
});

// ---- runner ----------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); n++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
}
console.log(`\n${n}/${tests.length} cortex scoring-proof tests passed`);
if (failed) process.exit(1);
