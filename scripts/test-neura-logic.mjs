#!/usr/bin/env node
/**
 * Unit tests for neura/ — the Neura (NEURA) AI-native store-of-value chain:
 * the deterministic brain (bit-identical training, stable serialisation,
 * loss that actually falls), the Proof-of-Intelligence consensus rule
 * (missing/forged/stale commitments rejected), the 21,000,000 NEURA hard
 * cap and halving schedule, transfers, fork choice that refuses a heavier
 * chain with fake intelligence, and JSON round-trips.
 * Run: node scripts/test-neura-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Load each UMD module in its own sandbox, browser-style dependency order.
function loadUMD(relPath) {
  const box = { module: { exports: {} } };
  box.self = box;
  vm.createContext(box);
  vm.runInContext(readFileSync(join(ROOT, relPath), 'utf8'), box, { filename: relPath });
  return box.module.exports;
}
const C = loadUMD('coin/engine.js');
const Brain = loadUMD('neura/brain.js');
const N = loadUMD('neura/engine.js')(C, Brain); // Node path exports the factory

// Easy PoW for tests: 8 leading zero bits (~256 hashes per block).
const EASY = { genesisTarget: '00' + 'f'.repeat(62) };
const newChain = () => new N.Chain(EASY);

// Deterministic clock: strictly increasing timestamps.
let now = N.PARAMS.genesisTimestamp;
const tick = () => (now += 20000);
const mineTo = (chain, wallet) =>
  chain.minePendingTransactions(wallet.address, { timestamp: tick(), maxIterations: 1e7 });

const alice = C.generateWallet('11'.repeat(32));
const bob = C.generateWallet('22'.repeat(32));

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/* ---------- the brain ---------- */

test('training is bit-deterministic: same seed, same weights, same hash', () => {
  const run = () => {
    const b = Brain.initBrain(N.GENESIS_BRAIN_SEED);
    for (let h = 1; h <= 3; h++) Brain.trainStep(b, N.poiSeed(h, 'ab'.repeat(32)));
    return b;
  };
  const b1 = run(), b2 = run();
  assert.equal(Brain.serialize(b1), Brain.serialize(b2), 'identical serialised weights');
  assert.equal(N.brainHashOf(b1), N.brainHashOf(b2), 'identical brain hash');
  assert.equal(b1.steps, 3 * Brain.STEPS_PER_BLOCK, 'step counter advances');
});

test('different seeds diverge and serialisation round-trips exactly', () => {
  const a = Brain.initBrain('aa'.repeat(32));
  const b = Brain.initBrain('bb'.repeat(32));
  assert.notEqual(Brain.serialize(a), Brain.serialize(b), 'different seeds → different minds');
  const restored = Brain.deserialize(Brain.serialize(a));
  assert.equal(Brain.serialize(restored), Brain.serialize(a), 'deserialize(serialize(x)) is exact');
});

test('the mind learns: eval loss falls as blocks train it', () => {
  const b = Brain.initBrain(N.GENESIS_BRAIN_SEED);
  const l0 = Brain.evalLoss(b);
  for (let h = 1; h <= 40; h++) Brain.trainStep(b, N.poiSeed(h, h.toString(16).padStart(64, '0')));
  const l40 = Brain.evalLoss(b);
  assert.ok(l40 < l0 * 0.7, `loss should fall by >30% over 40 blocks (${l0.toFixed(4)} → ${l40.toFixed(4)})`);
});

test('the target mark is a real image: bright strokes, dark background', () => {
  assert.ok(Brain.targetAt(-0.34, 0) > 0.99, 'the N left post is bright');
  assert.ok(Brain.targetAt(0.8, 0) > 0.99, 'the ring is bright');
  assert.ok(Brain.targetAt(0, 0.62) < 0.01, 'between ring and N is dark');
  const img = Brain.renderTarget(16);
  assert.ok(img.some((v) => v > 0.9) && img.some((v) => v < 0.1), 'render has both ink and space');
});

/* ---------- monetary policy: a store of value ---------- */

test('hard cap: exactly 21,000,000 NEURA can ever exist', () => {
  const chain = newChain();
  assert.equal(chain.stats().maxSupply, 21_000_000 * C.COIN);
  // The halving series really does stay under the cap.
  let supply = 0;
  for (let era = 0; era < 60; era++) supply += chain.subsidyAt(1 + era * N.PARAMS.halvingInterval) * N.PARAMS.halvingInterval;
  assert.ok(supply <= 21_000_000 * C.COIN, 'sum of all subsidies respects the cap');
  assert.equal(chain.subsidyAt(1), 50 * C.COIN, 'block 1 pays 50 NEURA');
  assert.equal(chain.subsidyAt(N.PARAMS.halvingInterval), 25 * C.COIN, 'first halving');
});

test('no premine: genesis pays nobody and supply starts at zero', () => {
  const chain = newChain();
  assert.equal(chain.totalSupply(), 0, 'zero coins before the first mined block');
  assert.equal(chain.blocks[0].transactions[0].outputs.length, 0, 'genesis coinbase has no outputs');
});

/* ---------- Proof of Intelligence ---------- */

test('an honestly mined block carries a valid Proof of Intelligence', () => {
  const chain = newChain();
  const block = mineTo(chain, alice);
  const committed = N.parsePoI(block.transactions[0].extra);
  assert.ok(committed, 'coinbase commits a brain hash');
  assert.equal(committed, N.brainHashOf(chain.brain), 'commitment matches the advanced mind');
  assert.equal(chain.brain.steps, Brain.STEPS_PER_BLOCK, 'the mind advanced exactly one step');
  assert.equal(chain.getBalance(alice.address), 50 * C.COIN, 'miner earned the subsidy');
});

// Mine a block on `chain` with an arbitrary coinbase `extra`, bypassing the
// Neura template — this is how an attacker who skips the AI work would mine.
function mineRaw(chain, extra) {
  const height = chain.tip.height + 1;
  const cb = C.createCoinbase({ height, address: alice.address, amount: chain.subsidyAt(height), extra });
  const block = {
    height,
    prevHash: chain.tip.hash,
    merkleRoot: C.merkleRoot([cb.id]),
    timestamp: tick(),
    target: chain.nextTarget(),
    nonce: 0,
    transactions: [cb],
    hash: ''
  };
  assert.ok(C.mine(block, { maxIterations: 1e7 }), 'test PoW should succeed at easy target');
  return block;
}

test('a block with no PoI commitment is rejected despite valid PoW', () => {
  const chain = newChain();
  const block = mineRaw(chain, 'just a normal coinbase message');
  assert.throws(() => chain.addBlock(block), /missing proof of intelligence/);
  assert.equal(chain.tip.height, 0, 'chain unchanged');
});

test('a forged brain hash is rejected: you cannot fake the learning', () => {
  const chain = newChain();
  const block = mineRaw(chain, N.POI_PREFIX + '|' + 'de'.repeat(32));
  assert.throws(() => chain.addBlock(block), /invalid proof of intelligence/);
});

test('a stale commitment (skipping the training step) is rejected', () => {
  const chain = newChain();
  mineTo(chain, alice);
  // Reuse the *current* brain hash instead of advancing it — lazy miner.
  const block = mineRaw(chain, N.POI_PREFIX + '|' + N.brainHashOf(chain.brain));
  assert.throws(() => chain.addBlock(block), /invalid proof of intelligence/);
});

test('the training batch is bound to the previous block hash', () => {
  // Two chains that diverge at block 1 must demand different training steps.
  const a = newChain(), b = newChain();
  mineTo(a, alice);
  mineTo(b, bob);
  assert.notEqual(a.tip.hash, b.tip.hash, 'chains diverged');
  assert.notEqual(N.poiSeed(2, a.tip.hash), N.poiSeed(2, b.tip.hash), 'different seeds');
  assert.notEqual(N.brainHashOf(a.nextBrain()), N.brainHashOf(b.nextBrain()), 'different required minds');
});

/* ---------- money movement ---------- */

test('coins move: mine, send with fee, balances and history add up', () => {
  const chain = newChain();
  mineTo(chain, alice);
  chain.send(alice, bob.address, 12 * C.COIN, C.COIN / 10, { timestamp: tick() });
  mineTo(chain, bob); // bob mines the block containing the transfer, earning subsidy + fee
  assert.equal(chain.getBalance(bob.address), 12 * C.COIN + 50 * C.COIN + C.COIN / 10);
  assert.equal(chain.getBalance(alice.address), 50 * C.COIN - 12 * C.COIN - C.COIN / 10);
  assert.equal(chain.totalSupply(), 100 * C.COIN, 'supply is exactly two subsidies');
  assert.ok(chain.history(bob.address).length >= 2, 'bob sees the transfer and his coinbase');
});

test('double-spends still die: the monetary core is fully enforced', () => {
  const chain = newChain();
  mineTo(chain, alice);
  const utxos = chain.spendableUtxos(alice.address);
  const tx1 = C.buildTransaction({ wallet: alice, utxos, to: bob.address, amount: 10 * C.COIN, timestamp: tick() });
  const tx2 = C.buildTransaction({ wallet: alice, utxos, to: alice.address, amount: 10 * C.COIN, timestamp: tick() });
  chain.submitTransaction(tx1);
  assert.throws(() => chain.submitTransaction(tx2), /UTXO|spent|double|input/i);
});

/* ---------- persistence & fork choice ---------- */

test('JSON round-trip revalidates everything, including every PoI', () => {
  const chain = newChain();
  mineTo(chain, alice);
  chain.send(alice, bob.address, 5 * C.COIN, 0, { timestamp: tick() });
  mineTo(chain, alice);
  const restored = N.Chain.fromJSON(JSON.parse(JSON.stringify(chain.toJSON())));
  assert.equal(restored.tip.hash, chain.tip.hash);
  assert.equal(N.brainHashOf(restored.brain), N.brainHashOf(chain.brain), 'the restored node re-derived the same mind');
  assert.equal(restored.getBalance(bob.address), 5 * C.COIN);
});

test('fork choice: nodes converge on the heavier chain and its mind', () => {
  const a = newChain(), b = newChain();
  mineTo(a, alice);
  mineTo(b, bob);
  mineTo(b, bob); // b is heavier
  assert.equal(a.replaceChain(b.toJSON().blocks), true, 'a adopts the heavier chain');
  assert.equal(a.tip.hash, b.tip.hash);
  assert.equal(N.brainHashOf(a.brain), N.brainHashOf(b.brain), 'and re-derives the identical mind');
  assert.equal(a.brains.length, 3, 'one mind state per block');
  assert.equal(b.replaceChain(a.toJSON().blocks), false, 'equal work is not adopted');
});

test('a HEAVIER chain with fake intelligence is still rejected', () => {
  const honest = newChain();
  mineTo(honest, alice);

  // The attacker mines MORE proof-of-work but fakes the AI commitments,
  // using the raw monetary core directly (all of Bitcoin's rules, no PoI).
  const params = { ...N.PARAMS, ...EASY };
  const attacker = new C.Blockchain(params);
  for (let i = 0; i < 3; i++) {
    const block = attacker.prepareBlock(bob.address, { extra: N.POI_PREFIX + '|' + 'ba'.repeat(32), timestamp: tick() });
    assert.ok(C.mine(block, { maxIterations: 1e7 }));
    attacker.addBlock(block);
  }
  assert.ok(attacker.workTotal > honest.workTotal, 'attacker really has more cumulative work');
  assert.equal(honest.replaceChain(attacker.toJSON().blocks), false, 'work cannot buy fake intelligence');
  assert.equal(honest.tip.height, 1, 'honest chain untouched');
});

test('stats expose the mind: loss, synapse score, brain hash', () => {
  const chain = newChain();
  const s0 = chain.stats();
  assert.equal(s0.ticker, 'NEURA');
  assert.equal(s0.synapseScore, 0, 'genesis mind scores zero');
  for (let i = 0; i < 8; i++) mineTo(chain, alice);
  const s = chain.stats();
  assert.ok(s.loss < s0.loss, 'loss fell');
  assert.ok(s.synapseScore > 0 && s.synapseScore <= 100, 'synapse score in (0, 100]');
  assert.equal(s.brainSteps, 8 * Brain.STEPS_PER_BLOCK);
  assert.match(s.brainHash, /^[0-9a-f]{64}$/);
});

/* ---------- runner ---------- */
for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nneura: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
