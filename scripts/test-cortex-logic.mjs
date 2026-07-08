#!/usr/bin/env node
/**
 * Unit tests for cortex/engine.js — the Cortex Proof-of-Learning blockchain:
 * a deterministic shared dataset + MLP, a full-batch gradient trainer that
 * measurably reduces loss, hash-linked and secp256k1-signed model checkpoints,
 * loss-is-recomputed-not-trusted block validation, and cumulative-learning
 * fork choice. Loaded in a vm sandbox alongside the coin engine (which supplies
 * the cryptography), repo is type:module. Run: node scripts/test-cortex-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'coin', 'engine.js'), 'utf8'), sandbox, { filename: 'coin/engine.js' });
const C = sandbox.module.exports;
sandbox.BallrzCoin = C;                 // cortex/engine.js looks it up as self.BallrzCoin
sandbox.module = { exports: {} };
vm.runInContext(readFileSync(join(ROOT, 'cortex', 'engine.js'), 'utf8'), sandbox, { filename: 'cortex/engine.js' });
const X = sandbox.module.exports;

const alice = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001');
const bob = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000002');

let n = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the task is deterministic and non-trivially labelled', () => {
  const t1 = X.makeTask({ id: 'unit', samples: 80 });
  const t2 = X.makeTask({ id: 'unit', samples: 80 });
  assert.deepEqual(t1.X, t2.X, 'same dataset from same id');
  assert.deepEqual(t1.y, t2.y, 'same labels from same id');
  assert.equal(t1.X.length, 80);
  const ones = t1.y.filter((v) => v === 1).length;
  assert.ok(ones > 15 && ones < 65, `labels are mixed, not degenerate (got ${ones}/80 ones)`);
  assert.equal(t1.dim, 4 * t1.hidden + 1, 'weight vector length matches the 2->H->1 shape');
});

test('starting weights are reproducible and quantised to the grid', () => {
  const t = X.makeTask({ id: 'unit' });
  const a = X.randomWeights(t, 'seed');
  const b = X.randomWeights(t, 'seed');
  assert.deepEqual(a, b, 'same seed -> same weights');
  assert.equal(a.length, t.dim);
  a.forEach((w) => assert.ok(Math.abs(Math.round(w / t.quantum) * t.quantum - w) < 1e-12, 'on the quantum grid'));
  const c = X.randomWeights(t, 'other');
  assert.notDeepEqual(a, c, 'different seed -> different weights');
});

test('training reduces loss and lifts accuracy on a nonlinear task', () => {
  const t = X.makeTask({ id: 'learn' });
  const w0 = X.randomWeights(t, 'g');
  const l0 = X.loss(t, w0);
  const w1 = X.train(t, w0, 1500, 0.5);
  const l1 = X.loss(t, w1);
  assert.ok(l1 < l0, `loss falls (${l0.toFixed(3)} -> ${l1.toFixed(3)})`);
  assert.ok(X.accuracy(t, w1) > 0.8, `accuracy clears 80% (${X.accuracy(t, w1).toFixed(2)})`);
  // Determinism: the same training run gives byte-identical weights.
  assert.deepEqual(X.train(t, w0, 1500, 0.5), w1, 'training is deterministic');
});

test('genesis is a valid, self-consistent block', () => {
  const t = X.makeTask({ id: 'chain' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  const g = chain.tip();
  assert.equal(chain.height(), 0);
  assert.equal(g.index, 0);
  assert.equal(g.prevHash, X.GENESIS_PREV);
  assert.equal(g.hash, X.blockHash(g), 'genesis hash checks out');
  assert.equal(Math.round(X.loss(t, g.weights) * 1e9) / 1e9, g.loss, 'genesis loss is honest');
  assert.equal(chain.cumulativeImprovement(), 0, 'nothing learned yet');
});

test('a mined block is signed, links to its parent, and lowers loss', () => {
  const t = X.makeTask({ id: 'chain' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  const before = chain.tipLoss();
  const blk = chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'a1' });
  assert.ok(blk, 'a block was produced');
  assert.equal(blk.index, 1);
  assert.equal(blk.prevHash, chain.tip().hash, 'links to genesis');
  assert.equal(blk.miner, alice.address, 'mined by alice');
  assert.ok(blk.loss <= before - t.minImprovement + 1e-12, 'meets the minimum learning bar');
  assert.ok(C.verify(C.sha256(X.canonical(blk)), blk.sig, blk.pubKey), 'signature verifies');
  assert.ok(chain.addBlock(blk), 'accepted onto the chain');
  assert.equal(chain.height(), 1);
  assert.ok(chain.cumulativeImprovement() > 0, 'the chain has now learned something');
});

test('the chain learns block over block and improves accuracy end to end', () => {
  const t = X.makeTask({ id: 'e2e' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  const startAcc = chain.accuracy();
  let last = chain.tipLoss();
  for (let i = 0; i < 6; i++) {
    const blk = chain.mineBlock({ privKey: (i % 2 ? bob : alice).privateKey, steps: 400, nonce: 'n' + i });
    if (!blk) break;
    chain.addBlock(blk);
    assert.ok(blk.loss < last, `block ${i + 1} strictly lowers loss`);
    last = blk.loss;
  }
  assert.ok(chain.height() >= 3, 'several blocks were mineable');
  assert.ok(chain.accuracy() > startAcc, 'the shared model is measurably smarter');
});

test('a block lying about its loss is rejected', () => {
  const t = X.makeTask({ id: 'liar' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  const blk = chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'x' });
  // Forge a lower loss and re-sign so only the loss recomputation catches it.
  const forged = Object.assign({}, blk, { loss: blk.loss - 0.5 });
  forged.weightsHash = X.weightsHash(t, forged.weights);
  forged.sig = C.sign(C.sha256(X.canonical(forged)), alice.privateKey);
  forged.hash = X.blockHash(forged);
  const v = chain.isValidBlock(forged, chain.tip());
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'claimed loss is false');
  assert.throws(() => chain.addBlock(forged), /claimed loss is false/);
});

test('a block with no real learning is rejected', () => {
  const t = X.makeTask({ id: 'lazy' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  const tip = chain.tip();
  // Re-publish the genesis weights (zero improvement), honestly signed.
  const lazy = {
    index: 1, prevHash: tip.hash, taskId: t.id,
    weights: tip.weights.slice(), weightsHash: tip.weightsHash, loss: tip.loss,
    reward: 0, txs: [], txsRoot: X.txsRoot([]),
    miner: alice.address, pubKey: alice.publicKey, at: 0, nonce: 'z'
  };
  lazy.sig = C.sign(C.sha256(X.canonical(lazy)), alice.privateKey);
  lazy.hash = X.blockHash(lazy);
  const v = chain.isValidBlock(lazy, tip);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'insufficient learning');
});

test("a block signed by the wrong key can't claim someone else's work", () => {
  const t = X.makeTask({ id: 'forge' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  const blk = chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'q' });
  // Keep alice's signature but claim bob mined it.
  const tampered = Object.assign({}, blk, { miner: bob.address });
  tampered.hash = X.blockHash(tampered);
  const v = chain.isValidBlock(tampered, chain.tip());
  assert.equal(v.ok, false);
  assert.ok(v.reason === 'pubkey/miner mismatch' || v.reason === 'bad signature', `got: ${v.reason}`);
});

test('tampering with the hash link is caught', () => {
  const t = X.makeTask({ id: 'link' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  const blk = chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'l' });
  const cut = Object.assign({}, blk, { prevHash: X.GENESIS_PREV });
  const v = chain.isValidBlock(cut, chain.tip());
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'does not link to parent');
});

test('fork choice adopts the chain that has learned more', () => {
  const t = X.makeTask({ id: 'fork' });
  // Node A mines two modest blocks.
  const nodeA = new X.Chain(t, { genesisSeed: 'g' });
  for (let i = 0; i < 2; i++) nodeA.addBlock(nodeA.mineBlock({ privKey: alice.privateKey, steps: 300, nonce: 'a' + i }));
  // Node B starts from the SAME genesis and mines further (more total learning).
  const nodeB = new X.Chain(t, { genesisSeed: 'g' });
  for (let i = 0; i < 5; i++) {
    const b = nodeB.mineBlock({ privKey: bob.privateKey, steps: 400, nonce: 'b' + i });
    if (!b) break;
    nodeB.addBlock(b);
  }
  assert.equal(nodeA.blocks[0].hash, nodeB.blocks[0].hash, 'shared genesis');
  assert.ok(nodeB.cumulativeImprovement() > nodeA.cumulativeImprovement(), 'B learned more');
  const switched = nodeA.replaceChain(nodeB.blocks);
  assert.equal(switched, true, 'A adopts the smarter chain');
  assert.equal(nodeA.tipLoss(), nodeB.tipLoss());
  // And it refuses to switch back to the shorter-learning chain.
  const backAgain = nodeB.replaceChain(nodeA.blocks.slice(0, 2));
  assert.equal(backAgain, false, 'never trades a smarter chain for a dumber one');
});

test('a fork with a doctored middle block is rejected wholesale', () => {
  const t = X.makeTask({ id: 'validate' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  const good = new X.Chain(t, { genesisSeed: 'g' });
  for (let i = 0; i < 3; i++) good.addBlock(good.mineBlock({ privKey: alice.privateKey, steps: 400, nonce: 'v' + i }));
  const rogue = good.blocks.map((b) => Object.assign({}, b));
  rogue[2].loss = rogue[2].loss - 0.4; // lie inside the chain
  assert.equal(chain.scoreChain(rogue), null, 'the whole fork is invalid');
  assert.equal(chain.replaceChain(rogue), false, 'and is never adopted');
});

// ---- task-scale presets ----------------------------------------------------

test('scale presets set the production-cost tier and stay overridable', () => {
  const toy = X.makeTask({ id: 's', scale: 'toy' });
  const small = X.makeTask({ id: 's', scale: 'small' });
  const medium = X.makeTask({ id: 's', scale: 'medium' });
  const large = X.makeTask({ id: 's', scale: 'large' });
  assert.equal(toy.scale, 'toy');
  // (compare primitives, not arrays: engine arrays live in the vm sandbox realm,
  // so deepStrictEqual against a native literal would mismatch on prototype)
  assert.equal(toy.inputs, 2);
  assert.equal(toy.layers.length, 1);
  assert.equal(toy.layers[0], 6);
  assert.equal(toy.samples, 120);
  assert.equal(toy.dim, 25, 'toy is 25 params, same layout as before');
  // each step up genuinely enlarges the model + dataset (=> more cost per step)
  assert.ok(small.dim > toy.dim && small.samples > toy.samples);
  assert.ok(large.dim > medium.dim && medium.dim > small.dim, 'params grow with scale');
  assert.ok(large.layers.length >= 2, 'large is a genuinely deeper (multi-hidden-layer) net');
  // dim always equals the weights implied by the [inputs, ...layers, 1] shape
  const expectDim = (a) => { let d = 0; for (let i = 0; i < a.arch.length - 1; i++) d += a.arch[i] * a.arch[i + 1] + a.arch[i + 1]; return d; };
  assert.equal(large.dim, expectDim(large), 'dim matches the general architecture');
  // an unscaled task is the toy tier
  assert.equal(X.makeTask({ id: 's' }).scale, 'toy');
  // explicit options still win over the preset
  const custom = X.makeTask({ id: 's', scale: 'large', hidden: 10 });
  assert.equal(custom.hidden, 10, 'explicit hidden overrides the preset');
  // an unknown scale is rejected, not silently ignored
  assert.throws(() => X.makeTask({ id: 's', scale: 'galaxy' }), /unknown task scale/);
});

test('backprop matches a numerical gradient (general multi-layer net)', () => {
  // A small but multi-layer net so every backprop path (output + two hidden
  // layers) is exercised. Compare the analytic gradient implied by one
  // trainStep against a finite-difference estimate of dLoss/dw.
  const t = X.makeTask({ id: 'grad', inputs: 3, layers: [4, 3], samples: 30, noise: 0 });
  const w = X.randomWeights(t, 'gc');
  // trainStep (unlike train) does not quantise its output, so at lr=1 the
  // analytic gradient is exactly w - trainStep(w) with no rounding noise.
  const next = X.trainStep(t, w, 1);
  const eps = 1e-5;
  let maxRelErr = 0;
  // check a spread of coordinates across the layers, not just the first few
  for (let idx = 0; idx < t.dim; idx += Math.max(1, Math.floor(t.dim / 12))) {
    const analytic = w[idx] - next[idx]; // dLoss/dw at this coordinate
    const wp = w.slice(); wp[idx] += eps;
    const wm = w.slice(); wm[idx] -= eps;
    const numeric = (X.loss(t, wp) - X.loss(t, wm)) / (2 * eps);
    const denom = Math.max(1e-6, Math.abs(analytic) + Math.abs(numeric));
    maxRelErr = Math.max(maxRelErr, Math.abs(analytic - numeric) / denom);
  }
  assert.ok(maxRelErr < 1e-4, `analytic vs numerical gradient agree (max rel err ${maxRelErr.toExponential(2)})`);
});

test('a genuinely deep net (two hidden layers) learns the task', () => {
  const t = X.makeTask({ id: 'deep', inputs: 4, layers: [12, 8], samples: 200 });
  const w0 = X.randomWeights(t, 'd');
  const w1 = X.train(t, w0, 2500, 0.5);
  assert.ok(X.loss(t, w1) < X.loss(t, w0), 'loss falls through the deep net');
  assert.ok(X.accuracy(t, w1) > 0.8, `deep net clears 80% accuracy (${X.accuracy(t, w1).toFixed(2)})`);
  assert.equal(t.arch.length, 4, 'input + 2 hidden + output');
});

test('a larger scale still mines, learns and pays MIND', () => {
  const t = X.makeTask({ id: 'scaled', scale: 'small' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  const blk = chain.mineBlock({ privKey: alice.privateKey, steps: 300, nonce: 'sc1' });
  assert.ok(blk, 'a block is mineable at the small scale');
  chain.addBlock(blk);
  assert.ok(blk.reward > 0 && chain.balanceOf(alice.address) === blk.reward, 'miner earns MIND');
  assert.ok(chain.tipLoss() < chain.baselineLoss, 'the bigger model learned');
});

// ---- MIND token layer ------------------------------------------------------

test('mining mints MIND to the miner in proportion to the learning done', () => {
  const t = X.makeTask({ id: 'reward' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  assert.equal(chain.totalSupply(), 0, 'genesis mints nothing');
  const before = chain.tipLoss();
  const blk = chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'r1' });
  chain.addBlock(blk);
  const expected = Math.round((before - blk.loss) * X.REWARD_PER_LOSS);
  assert.equal(blk.reward, expected, 'reward = loss reduced × scale');
  assert.ok(blk.reward > 0, 'a learning block pays something');
  assert.equal(chain.balanceOf(alice.address), expected, 'credited to the miner');
  assert.equal(chain.totalSupply(), expected, 'supply grew by exactly the reward');
});

test('total MIND supply tracks the total learning on the chain', () => {
  const t = X.makeTask({ id: 'supply' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  let i = 0;
  while (i < 8) { const b = chain.mineBlock({ privKey: alice.privateKey, steps: 300, nonce: 's' + i }); if (!b) break; chain.addBlock(b); i++; }
  const fromLearning = Math.round(chain.cumulativeImprovement() * X.REWARD_PER_LOSS);
  // per-block rounding means it's within a base unit or two per block, never runaway
  assert.ok(Math.abs(chain.totalSupply() - fromLearning) <= chain.height(), 'supply is bounded by knowledge created');
  assert.equal(chain.totalSupply(), chain.balanceOf(alice.address), 'alice mined it all');
});

test('a signed transfer moves MIND, conserves supply, and updates balances', () => {
  const t = X.makeTask({ id: 'spend' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  chain.addBlock(chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'm0' }));
  chain.addBlock(chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'm1' }));
  const aliceBal = chain.balanceOf(alice.address);
  assert.ok(aliceBal > 0, 'alice has earned MIND');
  const half = Math.floor(aliceBal / 2);
  const pay = X.signTransfer({ privKey: alice.privateKey, to: bob.address, amount: half, at: 1, nonce: 't1' });
  const supplyBefore = chain.totalSupply();
  const blk = chain.mineBlock({ privKey: bob.privateKey, steps: 500, nonce: 'm2', txs: [pay] });
  chain.addBlock(blk);
  assert.equal(chain.balanceOf(alice.address), aliceBal - half, 'alice debited');
  assert.equal(chain.balanceOf(bob.address), half + blk.reward, 'bob got the transfer plus his own reward');
  assert.equal(chain.totalSupply(), supplyBefore + blk.reward, 'transfers conserve — only the coinbase adds supply');
});

test('you cannot spend MIND you do not have (overdraft rejected)', () => {
  const t = X.makeTask({ id: 'overdraft' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  chain.addBlock(chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'o0' }));
  const tooMuch = X.signTransfer({ privKey: alice.privateKey, to: bob.address, amount: chain.balanceOf(alice.address) + 1, at: 1, nonce: 'o1' });
  const bad = chain.mineBlock({ privKey: bob.privateKey, steps: 500, nonce: 'o2', txs: [tooMuch] });
  assert.throws(() => chain.addBlock(bad), /overdraft/);
  assert.equal(chain.height(), 1, 'the bad block never landed');
});

test('a transfer cannot be replayed with the same nonce', () => {
  const t = X.makeTask({ id: 'replay' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  chain.addBlock(chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'e0' }));
  const pay = X.signTransfer({ privKey: alice.privateKey, to: bob.address, amount: Math.floor(chain.balanceOf(alice.address) / 4), at: 1, nonce: 'dup' });
  chain.addBlock(chain.mineBlock({ privKey: bob.privateKey, steps: 500, nonce: 'e1', txs: [pay] }));
  const again = chain.mineBlock({ privKey: bob.privateKey, steps: 500, nonce: 'e2', txs: [pay] });
  assert.throws(() => chain.addBlock(again), /duplicate transfer nonce/);
});

test('a block that mints itself extra MIND is rejected', () => {
  const t = X.makeTask({ id: 'greedy' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  const blk = chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'g1' });
  const greedy = Object.assign({}, blk, { reward: blk.reward + 5 * X.MIND });
  greedy.sig = C.sign(C.sha256(X.canonical(greedy)), alice.privateKey);
  greedy.hash = X.blockHash(greedy);
  const v = chain.isValidBlock(greedy, chain.tip());
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'wrong block reward');
});

test('tampering with a transferred amount is caught', () => {
  const t = X.makeTask({ id: 'tamper' });
  const chain = new X.Chain(t, { genesisSeed: 'g' });
  chain.addBlock(chain.mineBlock({ privKey: alice.privateKey, steps: 500, nonce: 'p0' }));
  const pay = X.signTransfer({ privKey: alice.privateKey, to: bob.address, amount: Math.floor(chain.balanceOf(alice.address) / 3), at: 1, nonce: 'x1' });
  const blk = chain.mineBlock({ privKey: bob.privateKey, steps: 500, nonce: 'p1', txs: [pay] });
  blk.txs[0] = Object.assign({}, pay, { amount: pay.amount * 2 }); // bump after signing
  const v = chain.isValidBlock(blk, chain.tip());
  assert.equal(v.ok, false);
  assert.ok(['transfers root mismatch', 'invalid transfer'].includes(v.reason), `got: ${v.reason}`);
});

test('fork choice carries the winning chain\'s MIND balances with it', () => {
  const t = X.makeTask({ id: 'forkledger' });
  const nodeA = new X.Chain(t, { genesisSeed: 'g' });
  nodeA.addBlock(nodeA.mineBlock({ privKey: alice.privateKey, steps: 300, nonce: 'a0' }));
  const nodeB = new X.Chain(t, { genesisSeed: 'g' });
  for (let i = 0; i < 5; i++) { const b = nodeB.mineBlock({ privKey: bob.privateKey, steps: 400, nonce: 'b' + i }); if (!b) break; nodeB.addBlock(b); }
  assert.ok(nodeA.replaceChain(nodeB.blocks), 'A adopts B');
  assert.equal(nodeA.balanceOf(bob.address), nodeB.balanceOf(bob.address), 'balances rebuilt from the adopted chain');
  assert.equal(nodeA.balanceOf(alice.address), 0, "A's old reward is gone with its orphaned block");
  assert.equal(nodeA.totalSupply(), nodeB.totalSupply());
});

// ---- runner ----------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); n++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
}
console.log(`\n${n}/${tests.length} cortex tests passed`);
if (failed) process.exit(1);
