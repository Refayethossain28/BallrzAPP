#!/usr/bin/env node
/**
 * Unit tests for synapse/engine.js — the pure Proof-of-Inference chain
 * behind Synapse (deterministic hashing and the toy seeded oracle, wallets,
 * ask-transactions with fees, mining that seals verified answers into
 * blocks, the halving supply curve with its 100,000 SYN cap, ledger
 * balances, and full-chain validation that rejects any faked answer).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-synapse-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'synapse', 'engine.js'), 'utf8'), sandbox, { filename: 'synapse/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0); // 2026-08-16 12:00 UTC
const { MILL } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

// A mined starter chain: one block to the miner so wallets have coins to spend.
const MINER = E.walletFromSecret('miner-secret-phrase').address;
const ASKER = E.walletFromSecret('asker-secret-phrase');
function minedChain() {
  const chain = E.newChain();
  const b1 = E.mineBlock(chain, [], MINER, NOW, 500000);
  assert.ok(b1, 'starter block mined');
  chain.push(b1);
  return chain;
}

/* ---------- hashing & determinism ---------- */
test('hashHex: deterministic 32-hex digests, distinct per input', () => {
  assert.equal(E.hashHex('a'), E.hashHex('a'));
  assert.match(E.hashHex('a'), /^[0-9a-f]{32}$/);
  assert.notEqual(E.hashHex('a'), E.hashHex('b'));
});

/* ---------- money curve ---------- */
test('subsidy: 50 SYN, halving every 1000 blocks, genesis mints nothing', () => {
  assert.equal(E.subsidyAt(0), 0);
  assert.equal(E.subsidyAt(1), 50 * MILL);
  assert.equal(E.subsidyAt(1000), 50 * MILL);
  assert.equal(E.subsidyAt(1001), 25 * MILL);
  assert.equal(E.subsidyAt(2001), 12500);
});
test('supply: exact era sums and the just-under-100k SYN hard cap', () => {
  assert.equal(E.supplyAt(0), 0);
  assert.equal(E.supplyAt(10), 10 * 50 * MILL);
  assert.equal(E.supplyAt(1000), 1000 * 50 * MILL);
  assert.equal(E.supplyAt(1500), 1000 * 50 * MILL + 500 * 25 * MILL);
  assert.equal(E.supplyAt(1e6), E.PARAMS.cap, 'the floor-halved series sums to the cap exactly');
  assert.equal(E.PARAMS.cap, 99994 * MILL, 'just under 100k — floor halving, like Bitcoin’s just-under-21M');
});
test('formatSYN: mills to human money', () => {
  assert.equal(E.formatSYN(0), '0 SYN');
  assert.equal(E.formatSYN(50 * MILL), '50 SYN');
  assert.equal(E.formatSYN(1234567), '1,234.567 SYN');
  assert.equal(E.formatSYN(1500), '1.5 SYN');
  assert.equal(E.formatSYN(-2500), '-2.5 SYN');
});

/* ---------- wallets ---------- */
test('walletFromSecret: deterministic address, trims, rejects short secrets', () => {
  const w = E.walletFromSecret('  correct horse battery  ');
  assert.equal(w.ok, true);
  assert.match(w.address, /^syn[0-9a-f]{20}$/);
  assert.equal(w.address, E.walletFromSecret('correct horse battery').address);
  assert.notEqual(w.address, E.walletFromSecret('correct horse batterz').address);
  assert.equal(E.walletFromSecret('tiny').ok, false);
});

/* ---------- the toy oracle ---------- */
test('infer: pure function of (seed, prompt) — same in, same out', () => {
  const a = E.infer('seed1', 'Should I learn to sail this autumn?');
  assert.equal(a, E.infer('seed1', 'Should I learn to sail this autumn?'));
  assert.ok(a.length > 20, 'says something');
});
test('infer: different seed or prompt, different answer; echoes prompt words', () => {
  const p = 'How do I finish my marathon training plan?';
  assert.notEqual(E.infer('seed1', p), E.infer('seed2', p));
  assert.notEqual(E.infer('seed1', p), E.infer('seed1', 'What colour should the kitchen be?'));
  const joined = [E.infer('s1', p), E.infer('s2', p), E.infer('s3', p)].join(' ');
  assert.match(joined, /marathon|training|finish|plan/, 'weaves in the asker’s own words');
});
test('promptWords: unique, lowercased, 4+ letters only', () => {
  deepEq(E.promptWords('The THE cat plans plans a big Voyage'), ['plans', 'voyage']);
  deepEq(E.promptWords(''), []);
});

/* ---------- asking ---------- */
test('makeAsk: builds a fee-bearing prompt tx; rejects empty and over-long prompts', () => {
  const v = E.makeAsk('asker-secret-phrase', '  What next?  ', 2 * MILL, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.tx.from, ASKER.address);
  assert.equal(v.tx.prompt, 'What next?');
  assert.equal(v.tx.fee, 2 * MILL);
  assert.match(v.tx.id, /^ask[0-9a-f]{16}$/);
  assert.equal(E.makeAsk('asker-secret-phrase', '   ', 0, NOW).ok, false);
  assert.equal(E.makeAsk('asker-secret-phrase', 'x'.repeat(281), 0, NOW).ok, false);
  assert.equal(E.makeAsk('short', 'hi there world', 0, NOW).ok, false);
});
test('makeAsk clamps junk fees to the minimum', () => {
  assert.equal(E.makeAsk('asker-secret-phrase', 'ok?', -50, NOW).tx.fee, E.PARAMS.minFee);
  assert.equal(E.makeAsk('asker-secret-phrase', 'ok?', 'junk', NOW).tx.fee, E.PARAMS.minFee);
});

/* ---------- genesis & mining ---------- */
test('genesis: fixed, no premine, chain validates', () => {
  const chain = E.newChain();
  deepEq(chain[0], E.genesisBlock(), 'every node derives the identical genesis');
  assert.equal(chain[0].subsidy, 0);
  deepEq(E.balancesOf(chain), {});
  assert.equal(E.validateChain(chain).ok, true);
});
test('mineBlock: empty block passes PoW, pays the subsidy, validates', () => {
  const chain = E.newChain();
  const b = E.mineBlock(chain, [], MINER, NOW, 500000);
  assert.ok(b);
  assert.equal(b.hash.slice(0, 2), E.PARAMS.powPrefix);
  assert.equal(b.subsidy, 50 * MILL);
  assert.equal(E.validateBlock(chain, b).ok, true);
  chain.push(b);
  assert.equal(E.balancesOf(chain)[MINER], 50 * MILL);
});
test('the full loop: mine → ask with fee → mine the answer → balances settle', () => {
  const chain = minedChain();
  // the miner funds the asker off-chain in this test by asking FROM the miner
  const ask = E.makeAsk('miner-secret-phrase', 'Where does the fee go?', 3 * MILL, NOW + 1000).tx;
  const b2 = E.mineBlock(chain, [ask], ASKER.address, NOW + 2000, 500000);
  assert.ok(b2);
  assert.equal(b2.txs.length, 1);
  assert.equal(b2.answers[0].promptId, ask.id);
  assert.equal(b2.answers[0].text, E.infer(chain[1].hash, ask.prompt), 'answer is the seeded inference');
  assert.equal(E.validateBlock(chain, b2).ok, true);
  chain.push(b2);
  const bal = E.balancesOf(chain);
  assert.equal(bal[MINER], 50 * MILL - 3 * MILL, 'asker paid the fee');
  assert.equal(bal[ASKER.address], 50 * MILL + 3 * MILL, 'answerer earned subsidy + fee');
  assert.equal(E.validateChain(chain).ok, true);
});
test('affordableAsks: drops prompts the asker cannot pay for, caps per block', () => {
  const chain = minedChain(); // miner holds 50 SYN
  const rich = E.makeAsk('miner-secret-phrase', 'affordable?', 40 * MILL, NOW).tx;
  const broke = E.makeAsk('miner-secret-phrase', 'also affordable?', 20 * MILL, NOW + 1).tx; // 40+20 > 50
  const stranger = E.makeAsk('asker-secret-phrase', 'no coins yet', 1 * MILL, NOW + 2).tx;
  deepEq(E.affordableAsks(chain, [rich, broke, stranger]).map((t) => t.id), [rich.id],
    'cumulative fees respected; unfunded wallets excluded');
});

/* ---------- the consensus rule bites ---------- */
test('Proof of Inference: a tampered answer invalidates the block', () => {
  const chain = minedChain();
  const ask = E.makeAsk('miner-secret-phrase', 'Is this answer real?', MILL, NOW + 1000).tx;
  const b = E.mineBlock(chain, [ask], ASKER.address, NOW + 2000, 500000);
  assert.ok(b);
  const forged = JSON.parse(JSON.stringify(b));
  forged.answers[0].text = 'Yes, definitely. Trust me.';
  forged.hash = E.computeBlockHash(forged); // even re-hashed honestly…
  // …it may or may not still satisfy PoW, but re-inference always catches it:
  const v = E.validateBlock(chain, forged);
  assert.equal(v.ok, false);
  assert.ok(/re-inference|proof-of-work/.test(v.reason), v.reason);
});
test('validateBlock rejects wrong subsidy, broken linkage and stale time', () => {
  const chain = minedChain();
  const b = E.mineBlock(chain, [], MINER, NOW + 1000, 500000);
  const greedy = { ...b, subsidy: 60 * MILL };
  greedy.hash = E.computeBlockHash(greedy);
  assert.equal(E.validateBlock(chain, greedy).ok, false);
  const orphan = { ...b, prevHash: E.hashHex('elsewhere') };
  assert.equal(E.validateBlock(chain, orphan).ok, false);
  const early = { ...b, ts: chain[1].ts - 5 };
  assert.equal(E.validateBlock(chain, early).ok, false);
});
test('validateChain walks every block and pins the genesis', () => {
  const chain = minedChain();
  assert.equal(E.validateChain(chain).ok, true);
  const badGenesis = JSON.parse(JSON.stringify(chain));
  badGenesis[0].message = 'rewritten history';
  assert.equal(E.validateChain(badGenesis).ok, false);
  const tampered = JSON.parse(JSON.stringify(chain));
  tampered[1].subsidy = 999 * MILL;
  assert.equal(E.validateChain(tampered).ok, false);
});

/* ---------- stats ---------- */
test('chainStats: height, supply vs cap, asks and halving countdown', () => {
  const chain = minedChain();
  const s = E.chainStats(chain);
  assert.equal(s.height, 1);
  assert.equal(s.supply, 50 * MILL);
  assert.equal(s.cap, 99994 * MILL);
  assert.equal(s.nextSubsidy, 50 * MILL);
  assert.equal(s.blocksToHalving, 999);
  assert.equal(s.asks, 0);
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
console.log(`\nsynapse: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
