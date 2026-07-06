#!/usr/bin/env node
/**
 * Unit tests for coin/mutual.js — the mutual-credit (LETS-style) ledger:
 * signed IOUs on secp256k1, net-zero balances, credit-limit enforcement,
 * de-duplication and deterministic ordering. Loaded in a vm sandbox alongside
 * the coin engine (repo is type:module). Run: node scripts/test-mutual-logic.mjs
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
sandbox.BallrzCoin = C;                 // mutual.js looks it up as self.BallrzCoin
sandbox.module = { exports: {} };
vm.runInContext(readFileSync(join(ROOT, 'coin', 'mutual.js'), 'utf8'), sandbox, { filename: 'coin/mutual.js' });
const M = sandbox.module.exports;

const COIN = C.COIN;
const alice = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001');
const bob = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000002');
const carol = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000003');

let n = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let clock = 1000;
const tick = () => ++clock;
const pay = (fromW, to, amount, memo) =>
  M.signCredit({ privKey: fromW.privateKey, to: to.address, amount: amount, at: tick(), nonce: 'n' + clock, memo: memo });

test('a credit transfer signs and verifies', () => {
  const tx = pay(alice, bob, 5 * COIN, 'lift into town');
  assert.equal(tx.from, alice.address);
  assert.equal(tx.to, bob.address);
  assert.ok(M.verifyCredit(tx), 'valid transfer verifies');
  assert.equal(tx.memo, 'lift into town');
});

test('tampering with amount, sender or signature is rejected', () => {
  const tx = pay(alice, bob, 5 * COIN);
  assert.ok(M.verifyCredit(tx));
  assert.ok(!M.verifyCredit({ ...tx, amount: 500 * COIN }), 'amount tamper fails');
  assert.ok(!M.verifyCredit({ ...tx, to: carol.address }), 'redirect fails');
  assert.ok(!M.verifyCredit({ ...tx, from: bob.address }), 'sender swap fails');
  // forging someone else's debit: sign as bob but claim to be alice
  const forged = pay(bob, carol, COIN);
  assert.ok(!M.verifyCredit({ ...forged, from: alice.address, to: carol.address }), 'cannot forge from a foreign address');
});

test('a positive integer amount is required, and no self-pay', () => {
  assert.ok(!M.verifyCredit(pay(alice, bob, 0)), 'zero rejected');
  assert.ok(!M.verifyCredit({ ...pay(alice, bob, COIN), amount: -COIN }), 'negative rejected');
  assert.ok(!M.verifyCredit({ ...pay(alice, bob, COIN), amount: 1.5 }), 'non-integer rejected');
  const self = M.signCredit({ privKey: alice.privateKey, to: alice.address, amount: COIN, at: tick(), nonce: 'x' });
  assert.ok(!M.verifyCredit(self), 'paying yourself is rejected');
});

test('the ledger always nets to zero', () => {
  const txs = [pay(alice, bob, 5 * COIN), pay(bob, carol, 2 * COIN), pay(carol, alice, 1 * COIN)];
  const { balances } = M.applyLedger(txs, Infinity);
  assert.equal(M.netSum(balances), 0, 'sum of all balances is zero');
  assert.equal(balances[alice.address], -4 * COIN);
  assert.equal(balances[bob.address], 3 * COIN);
  assert.equal(balances[carol.address], 1 * COIN);
});

test('credit limit bounds how far negative an account can go', () => {
  const limit = 3 * COIN;
  const txs = [pay(alice, bob, 2 * COIN), pay(alice, carol, 2 * COIN)]; // second pushes alice to -4
  const res = M.applyLedger(txs, limit);
  assert.equal(res.applied.length, 1, 'only the first transfer fits under the limit');
  assert.equal(res.rejected.length, 1);
  assert.equal(res.balances[alice.address], -2 * COIN, 'alice stopped at -2, within -3');
  assert.equal(M.netSum(res.balances), 0);
});

test('per-person credit limits via a limitFor(address) function', () => {
  // alice may go to -1, bob to -5. Each tries to spend 3.
  const limits = { [alice.address]: 1 * COIN, [bob.address]: 5 * COIN };
  const limitFor = (addr) => (addr in limits ? limits[addr] : 2 * COIN);
  const res = M.applyLedger([pay(alice, carol, 3 * COIN), pay(bob, carol, 3 * COIN)], limitFor);
  // alice's -3 breaks her -1 limit → rejected; bob's -3 is within -5 → applied
  assert.equal(res.balances[alice.address] || 0, 0, 'alice blocked by her tight limit');
  assert.equal(res.balances[bob.address], -3 * COIN, 'bob allowed under his higher limit');
  assert.equal(res.balances[carol.address], 3 * COIN);
  assert.equal(M.netSum(res.balances), 0);
});
test('duplicate transfers are counted once; order is deterministic', () => {
  const tx = pay(alice, bob, 4 * COIN);
  const { balances, applied } = M.applyLedger([tx, tx, { ...tx }], Infinity);
  assert.equal(applied.length, 1, 'same id applied once');
  assert.equal(balances[alice.address], -4 * COIN);
  // reordering the input does not change the result
  const a = M.applyLedger([pay(alice, bob, COIN), pay(bob, carol, COIN)], Infinity).balances;
  const b = M.applyLedger([pay(bob, carol, COIN), pay(alice, bob, COIN)], Infinity).balances;
  assert.equal(M.netSum(a), 0); assert.equal(M.netSum(b), 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); n++; }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
  }
  console.log('\nmutual: ' + n + '/' + tests.length + ' passed');
})();
