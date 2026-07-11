#!/usr/bin/env node
/**
 * Differential tests: the AUDITED crypto provider (cortex/vendor/noble-crypto.js,
 * bundling @noble/secp256k1 + @noble/hashes) against the engine's hand-rolled
 * built-ins. The two must agree byte-for-byte — identical hashes, public keys,
 * addresses, HMACs and (thanks to RFC 6979 + low-S on both sides) identical
 * signatures — so a network of mixed nodes can never fork over crypto.
 * Run: node scripts/test-cortex-crypto.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sandbox(files) {
  const box = { module: { exports: {} } }; box.self = box; box.globalThis = box;
  vm.createContext(box);
  const out = {};
  for (const [p, g] of files) {
    box.module = { exports: {} };
    vm.runInContext(readFileSync(join(ROOT, p), 'utf8'), box, { filename: p });
    if (g) { box[g] = box.module.exports; out[g] = box.module.exports; }
  }
  out.box = box;
  return out;
}

// C0: built-ins only.  C1: audited provider loaded first.
const S0 = sandbox([['coin/engine.js', 'BallrzCoin'], ['cortex/datasets.js', 'BallrzCortexData'], ['cortex/engine.js', 'BallrzCortex']]);
const S1 = sandbox([['cortex/vendor/noble-crypto.js', null], ['coin/engine.js', 'BallrzCoin'], ['cortex/datasets.js', 'BallrzCortexData'], ['cortex/engine.js', 'BallrzCortex']]);
const C0 = S0.BallrzCoin, C1 = S1.BallrzCoin;

let n = 0; const tests = []; const test = (name, fn) => tests.push([name, fn]);

test('the audited provider is actually active (not silently absent)', () => {
  assert.equal(C0.cryptoProvider, null, 'control sandbox uses built-ins');
  assert.match(String(C1.cryptoProvider), /noble/, 'provider sandbox uses @noble');
});

const PRIVS = [
  '0000000000000000000000000000000000000000000000000000000000000001',
  '0000000000000000000000000000000000000000000000000000000000000002',
  'c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5db',
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140', // n-1
];
const MSGS = ['', 'hello', 'Cortex Proof-of-Learning', 'ü™ unicode ✓', 'x'.repeat(1000)];

test('SHA-256 and HMAC are byte-identical', () => {
  for (const m of MSGS) assert.equal(C1.sha256(m), C0.sha256(m), `sha256("${m.slice(0, 12)}…")`);
  for (const m of MSGS) assert.equal(C1.sha256d(m), C0.sha256d(m));
  const key = C0.hexToBytes(C0.sha256('key'));
  for (const m of MSGS) {
    assert.equal(C1.hmacSha256(key, C1.utf8ToBytes(m)), C0.hmacSha256(key, C0.utf8ToBytes(m)), 'hmac');
  }
});

test('public keys and addresses are byte-identical', () => {
  for (const priv of PRIVS) {
    const p0 = C0.getPublicKey(priv), p1 = C1.getPublicKey(priv);
    assert.equal(p1, p0, 'pubkey for ' + priv.slice(0, 8));
    assert.equal(C1.addressFromPublicKey(p1), C0.addressFromPublicKey(p0), 'address');
    assert.equal(C1.walletFromPrivateKey(priv).address, C0.walletFromPrivateKey(priv).address);
  }
});

test('signatures are byte-identical (RFC 6979 + low-S on both sides)', () => {
  for (const priv of PRIVS) {
    for (const m of MSGS) {
      const h = C0.sha256(m);
      const s0 = C0.sign(h, priv), s1 = C1.sign(h, priv);
      assert.equal(s1, s0, `sig(priv=${priv.slice(0, 8)}, "${m.slice(0, 12)}")`);
    }
  }
});

test('each implementation verifies the other, and both reject tampering identically', () => {
  const priv = PRIVS[2], pub = C0.getPublicKey(priv);
  const h = C0.sha256('cross-verify');
  const s0 = C0.sign(h, priv), s1 = C1.sign(h, priv);
  assert.equal(C1.verify(h, s0, pub), true, 'noble verifies built-in sig');
  assert.equal(C0.verify(h, s1, pub), true, 'built-in verifies noble sig');
  const bad = (s0.slice(0, 10) === 'aaaaaaaaaa' ? 'b' : 'a').repeat(10) + s0.slice(10);
  assert.equal(C0.verify(h, bad, pub), C1.verify(h, bad, pub), 'tampered sig: same verdict');
  assert.equal(C0.verify(h, bad, pub), false);
  assert.equal(C0.verify(C0.sha256('other'), s0, pub), false, 'wrong message rejected (built-in)');
  assert.equal(C1.verify(C1.sha256('other'), s0, pub), false, 'wrong message rejected (noble)');
  // malformed inputs: identical, non-throwing verdicts
  for (const junk of ['', '00', 'zz'.repeat(64), s0.slice(0, 64)]) {
    assert.equal(C0.verify(h, junk, pub), false);
    assert.equal(C1.verify(h, junk, pub), false);
  }
});

test('high-S signatures get the same (permissive) verdict from both', () => {
  // Consensus safety: if one implementation accepted high-S and the other did
  // not, an attacker could split the network with a malleated signature.
  const priv = PRIVS[0], pub = C0.getPublicKey(priv);
  const h = C0.sha256('malleability');
  const sig = C0.sign(h, priv);
  const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  const r = sig.slice(0, 64), s = BigInt('0x' + sig.slice(64));
  const highS = r + (N - s).toString(16).padStart(64, '0');
  assert.equal(C0.verify(h, highS, pub), C1.verify(h, highS, pub), 'same high-S verdict');
});

test('ECDH shared secrets are byte-identical', () => {
  const a = PRIVS[0], b = PRIVS[2];
  const s0 = C0.ecdh(a, C0.getPublicKey(b)), s1 = C1.ecdh(a, C1.getPublicKey(b));
  assert.equal(s1, s0);
  assert.equal(C1.ecdh(b, C1.getPublicKey(a)), s0, 'and symmetric');
});

test('a chain mined under noble validates under the built-ins (and vice versa)', () => {
  const mk = (S) => {
    const X = S.BallrzCortex;
    const t = X.makeTask({ id: 'xchain' });
    const chain = new X.Chain(t, { genesisSeed: 'g' });
    return { X, t, chain };
  };
  const A = mk(S1), B = mk(S0); // A mines with noble, B validates with built-ins
  const w = C1.walletFromPrivateKey(PRIVS[2]);
  for (let i = 0; i < 3; i++) {
    const blk = A.chain.mineBlock({ privKey: PRIVS[2], steps: 300, nonce: 'x' + i });
    if (!blk) break;
    A.chain.addBlock(blk);
  }
  assert.ok(A.chain.height() >= 2, 'mined a few blocks under noble');
  const blocks = JSON.parse(JSON.stringify(A.chain.blocks)); // cross realm: plain data
  assert.ok(B.chain.replaceChain(blocks), 'built-in sandbox adopts the noble-mined chain');
  assert.equal(B.chain.balanceOf(w.address), A.chain.balanceOf(w.address), 'balances agree');
  // and the reverse: built-in-mined chain adopted under noble
  const A2 = mk(S0), B2 = mk(S1);
  for (let i = 0; i < 3; i++) {
    const blk = A2.chain.mineBlock({ privKey: PRIVS[3], steps: 300, nonce: 'y' + i });
    if (!blk) break;
    A2.chain.addBlock(blk);
  }
  assert.ok(B2.chain.replaceChain(JSON.parse(JSON.stringify(A2.chain.blocks))), 'noble sandbox adopts the built-in-mined chain');
});

// ---- runner ----------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); n++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
}
console.log(`\n${n}/${tests.length} cortex crypto differential tests passed`);
if (failed) process.exit(1);
