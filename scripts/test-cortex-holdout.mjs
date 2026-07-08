#!/usr/bin/env node
/**
 * Unit tests for cortex/holdout.js — the commit–reveal layer that rewards
 * generalisation instead of memorisation. Covers: hiding/binding commitments,
 * reveal verification, deterministic train/holdout preparation, the weight
 * commitment that stops a miner tuning to the test batch after the fact, and
 * that a genuinely trained model earns reward on an unseen batch while a
 * do-nothing model earns nothing. Loaded in a vm sandbox alongside the coin
 * engine, the dataset module and the cortex engine. Run:
 *   node scripts/test-cortex-holdout.mjs
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
const DATA = load('cortex/datasets.js', 'BallrzCortexData');
const X = load('cortex/engine.js', 'BallrzCortex');
const H = load('cortex/holdout.js', 'BallrzCortexHoldout');

const alice = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001');

let n = 0; const tests = []; const test = (name, fn) => tests.push([name, fn]);

test('a batch commitment is binding — any change to the batch changes the hash', () => {
  const feats = [[1, 2], [3, 4]], labels = [0, 1];
  const c = H.commit('salt-1', feats, labels);
  assert.ok(/^[0-9a-f]{64}$/.test(c), 'looks like a sha256');
  assert.ok(H.verifyReveal(c, 'salt-1', feats, labels), 'the true reveal verifies');
  assert.ok(!H.verifyReveal(c, 'salt-1', [[1, 2], [3, 5]], labels), 'a changed feature is caught');
  assert.ok(!H.verifyReveal(c, 'salt-1', feats, [1, 1]), 'a changed label is caught');
  assert.ok(!H.verifyReveal(c, 'salt-2', feats, labels), 'the wrong salt is caught');
  assert.notEqual(c, H.commit('salt-9', feats, labels), 'the salt hides the batch');
});

test('prepareHoldout is deterministic, disjoint, and its commitments match', () => {
  const bn = DATA.get('banknote');
  const a = H.prepareHoldout({ features: bn.features, labels: bn.labels, testFraction: 0.3, batches: 3, seed: 'k' });
  const b = H.prepareHoldout({ features: bn.features, labels: bn.labels, testFraction: 0.3, batches: 3, seed: 'k' });
  assert.equal(a.commitments.join(','), b.commitments.join(','), 'same seed -> same seal');
  assert.equal(a.sealed.length, 3, 'three sealed batches');
  const testRows = a.sealed.reduce((s, x) => s + x.features.length, 0);
  assert.equal(a.train.features.length + testRows, bn.features.length, 'train + test partitions the data');
  assert.ok(Math.abs(testRows - Math.floor(bn.features.length * 0.3)) <= a.sealed.length, '~30% held out');
  // every published commitment really is the commitment of its sealed batch
  a.sealed.forEach((s) => assert.ok(H.verifyReveal(a.commitments[s.index], s.salt, s.features, s.labels)));
  // a different seed reseals differently
  const c = H.prepareHoldout({ features: bn.features, labels: bn.labels, testFraction: 0.3, batches: 3, seed: 'other' });
  assert.notEqual(a.commitments[0], c.commitments[0]);
});

// Build a genuinely-trained model on the public train set, plus a "did nothing"
// baseline, for the reward tests below.
function scenario() {
  const bn = DATA.get('banknote');
  const seal = H.prepareHoldout({ features: bn.features, labels: bn.labels, testFraction: 0.25, batches: 2, seed: 's' });
  const task = X.makeTask({ id: 'cr', data: { name: 'banknote-train', features: seal.train.features, labels: seal.train.labels }, layers: [16] });
  const genesis = X.randomWeights(task, 'g');           // the untrained baseline (parent)
  const trained = X.train(task, genesis, 1500, 0.5);    // the miner's model
  return { seal, task, genesis, trained };
}

test('a trained model earns reward on a freshly revealed, unseen batch', () => {
  const { seal, task, genesis, trained } = scenario();
  const batch = seal.sealed[0];
  const res = H.settle({
    task, parentWeights: genesis, weights: trained,
    weightsCommitment: H.commitWeights(trained),
    batchCommitment: seal.commitments[0],
    reveal: { salt: batch.salt, features: batch.features, labels: batch.labels }
  });
  assert.equal(res.ok, true, res.reason);
  assert.ok(res.testLoss < res.baseLoss, 'the trained model beats the untrained parent on unseen data');
  assert.ok(res.improvement > 0 && res.reward > 0, 'positive MIND reward for genuine generalisation');
  assert.ok(res.testAccuracy > 0.9, `high accuracy on data it never trained on (${(res.testAccuracy * 100).toFixed(1)}%)`);
});

test('committing the SAME (untrained) weights as the parent earns nothing', () => {
  const { seal, task, genesis } = scenario();
  const batch = seal.sealed[0];
  const res = H.settle({
    task, parentWeights: genesis, weights: genesis, // no learning at all
    weightsCommitment: H.commitWeights(genesis),
    batchCommitment: seal.commitments[0],
    reveal: { salt: batch.salt, features: batch.features, labels: batch.labels }
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.improvement, 0, 'no improvement over the parent');
  assert.equal(res.reward, 0, 'so no MIND is minted');
});

test('a miner cannot tune to the test batch after committing (weight commitment binds)', () => {
  const { seal, task, genesis, trained } = scenario();
  const batch = seal.sealed[0];
  // Miner commits `trained`, then tries to submit weights re-optimised on the batch.
  const Z = X.standardizeRows(task, batch.features);
  const cheat = X.train({ ...task, X: Z, y: batch.labels, samples: Z.length }, trained, 300, 0.5);
  const res = H.settle({
    task, parentWeights: genesis, weights: cheat,     // weights != what was committed
    weightsCommitment: H.commitWeights(trained),
    batchCommitment: seal.commitments[0],
    reveal: { salt: batch.salt, features: batch.features, labels: batch.labels }
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'weights do not match the commitment');
});

test('a substituted (non-committed) batch is rejected at reveal', () => {
  const { seal, task, genesis, trained } = scenario();
  const real = seal.sealed[0];
  // Attacker reveals an easier hand-picked batch instead of the committed one.
  const fake = { salt: real.salt, features: real.features.slice(0, 4), labels: real.labels.slice(0, 4) };
  const res = H.settle({
    task, parentWeights: genesis, weights: trained,
    weightsCommitment: H.commitWeights(trained),
    batchCommitment: seal.commitments[0],
    reveal: fake
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'revealed batch does not match its commitment');
});

// ---- runner ----------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); n++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
}
console.log(`\n${n}/${tests.length} cortex commit–reveal tests passed`);
if (failed) process.exit(1);
