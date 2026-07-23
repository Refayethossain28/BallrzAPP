#!/usr/bin/env node
/**
 * Unit tests for coin/bridge.js — cross-circle mutual-credit routing:
 * a forwarding leg whose signed nonce commits to the incoming leg, so a route
 * from a payer in one circle to a payee in another (via a dual-member bridge)
 * is fully verifiable and net-zero for the bridge. Tamper, wrong-signer, and
 * wash-trade cases are rejected. Loaded in a vm sandbox with the engine +
 * mutual + bridge modules (repo is type:module). Run: node scripts/test-bridge.mjs
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
const load = (rel, global) => {
  sandbox.module = { exports: {} };
  vm.runInContext(readFileSync(join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  if (global) sandbox[global] = sandbox.module.exports;
  return sandbox.module.exports;
};
const C = load('coin/engine.js', 'BallrzCoin');
const M = load('coin/mutual.js', 'BallrzMutual');
const B = load('coin/bridge.js', 'BallrzBridge');

const COIN = C.COIN;
const w = (n) => C.walletFromPrivateKey(String(n).padStart(64, '0'));
const payer = w(1);    // in circle A
const bridge = w(2);   // dual member of A and B
const payee = w(3);    // in circle B
const other = w(4);

let clock = 1000;
const tick = () => ++clock;
// leg A: payer gives the bridge credit in circle A
const legAFor = (amount) => M.signCredit({ privKey: payer.privateKey, to: bridge.address, amount, at: tick(), nonce: 'legA' + clock, memo: 'lift to town' });
// leg B: the bridge forwards it to the payee in circle B
const legBFor = (legA, at) => B.buildBridgeLeg({ incoming: legA, privKey: bridge.privateKey, payee: payee.address, at: at || tick(), memo: 'passed onward' });

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

test('a bridge leg is an ordinary, valid mutual-credit transfer', () => {
  const legA = legAFor(3 * COIN);
  const legB = legBFor(legA);
  assert.ok(M.verifyCredit(legB), 'leg B verifies as a normal credit — no special handling needed to gossip/fold it');
  assert.equal(legB.from, bridge.address);
  assert.equal(legB.to, payee.address);
  assert.equal(legB.amount, 3 * COIN, 'same amount forwarded');
});

test('the forwarding leg commits to the incoming leg via its signed nonce', () => {
  const legA = legAFor(2 * COIN);
  const legB = legBFor(legA);
  assert.ok(B.isBridgeLeg(legB));
  assert.equal(B.incomingIdOf(legB), legA.id, 'the nonce names leg A');
});

test('a complete intertrade verifies and names payer, bridge, payee', () => {
  const legA = legAFor(5 * COIN);
  const legB = legBFor(legA);
  const v = B.verifyIntertrade(legA, legB);
  assert.ok(v.ok, v.reason);
  assert.equal(v.payer, payer.address);
  assert.equal(v.bridge, bridge.address);
  assert.equal(v.payee, payee.address);
  assert.equal(v.amount, 5 * COIN);
});

test('the bridge is net-zero across the two circles — no value is minted', () => {
  const legA = legAFor(4 * COIN);
  const legB = legBFor(legA);
  const net = B.bridgeNet(legA, legB);
  assert.equal(net.inCircleA, 4 * COIN, '+ owed to the bridge in A');
  assert.equal(net.inCircleB, -4 * COIN, '− owed by the bridge in B');
  assert.equal(net.net, 0, 'sums to exactly zero');
});

test('only the recipient of the incoming favour can bridge it onward', () => {
  const legA = legAFor(COIN);
  assert.throws(() => B.buildBridgeLeg({ incoming: legA, privKey: other.privateKey, payee: payee.address, at: tick() }),
    /only the recipient/);
});

test('a bridge cannot forward to itself or straight back to the sender', () => {
  const legA = legAFor(COIN);
  assert.throws(() => B.buildBridgeLeg({ incoming: legA, privKey: bridge.privateKey, payee: bridge.address, at: tick() }), /forward to someone else/);
  assert.throws(() => B.buildBridgeLeg({ incoming: legA, privKey: bridge.privateKey, payee: payer.address, at: tick() }), /straight back/);
});

test('tampering with the forwarded amount is caught', () => {
  const legA = legAFor(3 * COIN);
  const legB = legBFor(legA);
  // re-point the amount — breaks leg B's own signature first, but even a
  // consistently re-signed different amount fails the amounts-match check.
  assert.ok(!M.verifyCredit({ ...legB, amount: 9 * COIN }), 'amount tamper breaks the signature');
  const forged = M.signCredit({ privKey: bridge.privateKey, to: payee.address, amount: 9 * COIN, at: tick(), nonce: B.bridgeNonce(legA.id) });
  const v = B.verifyIntertrade(legA, forged);
  assert.ok(!v.ok, 'a bigger forwarded amount is rejected');
  assert.match(v.reason, /amounts do not match/);
});

test('a forwarding leg that names a different incoming favour is rejected', () => {
  const legA1 = legAFor(2 * COIN);
  const legA2 = legAFor(2 * COIN);
  const legB = legBFor(legA1);
  const v = B.verifyIntertrade(legA2, legB);
  assert.ok(!v.ok);
  assert.match(v.reason, /does not commit/);
});

test('a wash (payer === payee) is rejected', () => {
  // payer gives the bridge credit, bridge tries to forward it back to the payer
  const legA = legAFor(COIN);
  // build directly (buildBridgeLeg guards this, so forge the leg to test verify)
  const washed = M.signCredit({ privKey: bridge.privateKey, to: payer.address, amount: COIN, at: tick(), nonce: B.bridgeNonce(legA.id) });
  const v = B.verifyIntertrade(legA, washed);
  assert.ok(!v.ok);
  assert.match(v.reason, /same/);
});

test('the expected-bridge assertion is enforced', () => {
  const legA = legAFor(COIN);
  const legB = legBFor(legA);
  assert.ok(B.verifyIntertrade(legA, legB, { bridge: bridge.address }).ok);
  assert.ok(!B.verifyIntertrade(legA, legB, { bridge: other.address }).ok, 'wrong expected bridge fails');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
  }
  console.log('\nbridge: ' + passed + '/' + tests.length + ' passed');
})();
