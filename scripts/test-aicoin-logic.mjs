#!/usr/bin/env node
/**
 * Unit tests for aicoin/engine.js — the AI Token (AIT) chain: monetary
 * parameters and the 2^25 supply cap, mining rewards paid in AIT, the
 * spark↔model-token peg, prompt-commitment addresses, inference receipts
 * (pay, mine, verify, and every way verification must fail), fees flowing to
 * miners, and cumulative-work fork choice under AI Token parameters.
 * Loaded in a vm sandbox (repo is type:module). Run: node scripts/test-aicoin-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Load the base engine, then the AI layer on top of it, the same way the
// browser does (coin/engine.js first, aicoin/engine.js second).
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'coin', 'engine.js'), 'utf8'), sandbox, { filename: 'coin/engine.js' });
const C = sandbox.module.exports;
sandbox.BallrzCoin = C;
sandbox.module = { exports: {} };
vm.runInContext(readFileSync(join(ROOT, 'aicoin', 'engine.js'), 'utf8'), sandbox, { filename: 'aicoin/engine.js' });
const AI = sandbox.module.exports;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n      ${err.message}`); process.exitCode = 1; }
}

// An easy proof-of-work limit (8 zero bits, ~256 hashes per block) so tests
// mine real blocks fast; consensus logic is identical at any target.
const EASY = { genesisTarget: '00' + 'f'.repeat(62) };
const T0 = AI.PARAMS.genesisTimestamp + 60000;
// Deterministic wallets — fixed private keys, no RNG in tests.
const alice = C.walletFromPrivateKey('1'.padStart(64, '0'));
const bob = C.walletFromPrivateKey('2'.padStart(64, '0'));
const mineAt = (chain, addr, i) => chain.minePendingTransactions(addr, { timestamp: T0 + i * 20000 });

console.log('aicoin/engine.js — AI Token');

test('monetary parameters: 128 AIT subsidy halving every 2^17 blocks caps supply at 2^25 AIT', () => {
  assert.equal(AI.PARAMS.ticker, 'AIT');
  assert.equal(AI.PARAMS.initialSubsidy, 128 * AI.COIN);
  assert.equal(AI.PARAMS.halvingInterval, 131072);
  const chain = AI.createChain();
  assert.equal(chain.stats().maxSupply, Math.pow(2, 25) * AI.COIN);
  assert.equal(chain.subsidyAt(1), 128 * AI.COIN);
  assert.equal(chain.subsidyAt(131071), 128 * AI.COIN);
  assert.equal(chain.subsidyAt(131072), 64 * AI.COIN);
  assert.equal(chain.subsidyAt(131072 * 7), AI.COIN); // seven halvings: 1 AIT
  assert.equal(chain.subsidyAt(131072 * 53), 0);      // series exhausted
});

test('genesis is deterministic, and a different chain from TimeCoin', () => {
  const a = AI.createChain(), b = AI.createChain();
  assert.equal(a.blocks[0].hash, b.blocks[0].hash);
  const time = new C.Blockchain({});
  assert.notEqual(a.blocks[0].hash, time.blocks[0].hash);
  // Blocks from the TIME chain can never be adopted here: different genesis.
  assert.equal(a.replaceChain(time.blocks), false);
});

test('mining a block pays the miner 128 AI tokens', () => {
  const chain = AI.createChain(EASY);
  const block = mineAt(chain, alice.address, 1);
  assert.equal(block.height, 1);
  assert.ok(C.meetsTarget(block.hash, block.target));
  assert.equal(chain.getBalance(alice.address), 128 * AI.COIN);
  assert.equal(chain.totalSupply(), 128 * AI.COIN);
  assert.equal(AI.formatAIT(chain.getBalance(alice.address)), '128 AIT');
});

test('the peg: one spark buys one model token, so 1 AIT = 100,000 tokens of inference', () => {
  assert.equal(AI.costForTokens(1), 1);
  assert.equal(AI.costForTokens(100000), AI.COIN);
  assert.equal(AI.tokensFor(AI.COIN), AI.TOKENS_PER_AIT);
  assert.equal(AI.tokensFor(0), 0);
  assert.throws(() => AI.costForTokens(0));
  assert.throws(() => AI.costForTokens(-5));
  assert.throws(() => AI.costForTokens(1.5));
  assert.equal(AI.estimateTokens('a'.repeat(400)), 100);
  assert.equal(AI.estimateTokens(''), 1);
});

test('prompt-commitment addresses are deterministic, valid, and prompt-specific', () => {
  const p = 'Explain proof of work to a five-year-old';
  const addr = AI.promptAddress(p);
  assert.equal(addr, AI.promptAddress(p));
  assert.ok(C.isValidAddress(addr));
  assert.equal(C.addressType(addr), 'p2pkh');
  assert.notEqual(addr, AI.promptAddress(p + '!'));
  assert.throws(() => AI.promptAddress(''));
  // The payload is the double-SHA-256 of the prompt, not any key's hash.
  assert.equal(C.base58CheckDecode(addr).payload.length, 20);
});

test('inference receipt: pay, mine, verify — and the supply shrinks by the burn', () => {
  const chain = AI.createChain(EASY);
  mineAt(chain, alice.address, 1);
  const prompt = 'Write a haiku about difficulty retargeting';
  const receipt = AI.payForInference({ chain, wallet: alice, prompt, modelTokens: 5000, timestamp: T0 + 30000 });
  assert.equal(receipt.cost, 5000);

  // Before mining it's only pending.
  let v = AI.verifyInferenceReceipt(chain, { txId: receipt.txId, prompt, modelTokens: 5000 });
  assert.equal(v.ok, false);
  assert.match(v.status, /pending/);

  mineAt(chain, bob.address, 2);
  v = AI.verifyInferenceReceipt(chain, { txId: receipt.txId, prompt, modelTokens: 5000 });
  assert.equal(v.ok, true);
  assert.equal(v.paid, 5000);
  assert.equal(v.confirmations, 1);
  assert.equal(v.address, AI.promptAddress(prompt));

  // Alice paid 5,000 sparks; the burn address holds them but nobody can spend them.
  assert.equal(chain.getBalance(alice.address), 128 * AI.COIN - 5000);
  assert.equal(chain.getBalance(AI.promptAddress(prompt)), 5000);
});

test('receipt verification rejects the wrong prompt, overclaimed tokens, and unknown txIds', () => {
  const chain = AI.createChain(EASY);
  mineAt(chain, alice.address, 1);
  const prompt = 'What is a UTXO?';
  const receipt = AI.payForInference({ chain, wallet: alice, prompt, modelTokens: 2000, timestamp: T0 + 30000 });
  mineAt(chain, alice.address, 2);

  const wrongPrompt = AI.verifyInferenceReceipt(chain, { txId: receipt.txId, prompt: 'What is a UTXO? ', modelTokens: 2000 });
  assert.equal(wrongPrompt.ok, false);
  assert.match(wrongPrompt.status, /mismatch/);

  const overclaim = AI.verifyInferenceReceipt(chain, { txId: receipt.txId, prompt, modelTokens: 2001 });
  assert.equal(overclaim.ok, false);
  assert.match(overclaim.status, /underpaid/);

  const unknown = AI.verifyInferenceReceipt(chain, { txId: 'f'.repeat(64), prompt, modelTokens: 2000 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.status, /not found/);

  const garbage = AI.verifyInferenceReceipt(chain, { txId: receipt.txId, prompt: '', modelTokens: 2000 });
  assert.equal(garbage.ok, false);
  assert.match(garbage.status, /invalid/);
});

test('paying for inference without funds fails; fees on receipts go to the miner', () => {
  const chain = AI.createChain(EASY);
  assert.throws(() => AI.payForInference({ chain, wallet: bob, prompt: 'hi', modelTokens: 100, timestamp: T0 }),
    /insufficient funds/);

  mineAt(chain, alice.address, 1);
  AI.payForInference({ chain, wallet: alice, prompt: 'hi', modelTokens: 100, fee: 250, timestamp: T0 + 30000 });
  mineAt(chain, bob.address, 2);
  assert.equal(chain.getBalance(bob.address), 128 * AI.COIN + 250);
});

test('ordinary AIT transfers still work (it is a real currency, not only a meter)', () => {
  const chain = AI.createChain(EASY);
  mineAt(chain, alice.address, 1);
  chain.send(alice, bob.address, 40 * AI.COIN, 0, { timestamp: T0 + 30000 });
  mineAt(chain, alice.address, 2);
  assert.equal(chain.getBalance(bob.address), 40 * AI.COIN);
  assert.equal(chain.getBalance(alice.address), (128 - 40 + 128) * AI.COIN);
});

test('fork choice: nodes converge on the chain with more cumulative work', () => {
  const a = AI.createChain(EASY), b = AI.createChain(EASY);
  mineAt(a, alice.address, 1);
  mineAt(b, bob.address, 1);
  mineAt(b, bob.address, 2);
  assert.equal(a.replaceChain(b.blocks), true);   // heavier chain wins
  assert.equal(a.tip.height, 2);
  assert.equal(b.replaceChain(a.blocks), false);  // equal work never reorgs
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures' : ''}`);
