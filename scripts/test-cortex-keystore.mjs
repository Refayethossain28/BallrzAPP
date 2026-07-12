#!/usr/bin/env node
/**
 * Unit tests for cortex/keystore.js — passphrase-encrypted wallet keys.
 * Round-trip, wrong-passphrase rejection, tamper detection, salt independence,
 * and that a real generated wallet key survives encryption. Small `iters` here
 * so the KDF is fast in tests. Run: node scripts/test-cortex-keystore.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const box = { module: { exports: {} } }; box.self = box; vm.createContext(box);
const load = (p, g) => { box.module = { exports: {} }; vm.runInContext(readFileSync(join(ROOT, p), 'utf8'), box, { filename: p }); if (g) box[g] = box.module.exports; return box.module.exports; };
const C = load('coin/engine.js', 'BallrzCoin');
const K = load('cortex/keystore.js', 'BallrzCortexKeystore');

const SALT = '00112233445566778899aabbccddeeff';
const IT = 500; // fast for tests
const priv = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001').privateKey;

let n = 0; const tests = []; const test = (name, fn) => tests.push([name, fn]);

test('encrypt → decrypt round-trips the private key', () => {
  const boxed = K.encryptKey(priv, 'correct horse battery staple', { salt: SALT, iters: IT });
  assert.equal(boxed.v, 1);
  assert.notEqual(boxed.ct, priv, 'ciphertext is not the plaintext');
  assert.equal(K.decryptKey(boxed, 'correct horse battery staple'), priv, 'decrypts back exactly');
});

test('a wrong passphrase is rejected, not silently wrong', () => {
  const boxed = K.encryptKey(priv, 'right-pass', { salt: SALT, iters: IT });
  assert.throws(() => K.decryptKey(boxed, 'WRONG-pass'), /wrong passphrase or corrupted/);
});

test('tampering with the ciphertext or mac is detected', () => {
  const boxed = K.encryptKey(priv, 'p', { salt: SALT, iters: IT });
  const flippedCt = { ...boxed, ct: boxed.ct.slice(0, -2) + (boxed.ct.slice(-2) === '00' ? '01' : '00') };
  assert.throws(() => K.decryptKey(flippedCt, 'p'), /corrupted/);
  const flippedMac = { ...boxed, mac: boxed.mac.slice(0, -2) + (boxed.mac.slice(-2) === '00' ? '01' : '00') };
  assert.throws(() => K.decryptKey(flippedMac, 'p'), /corrupted/);
});

test('the same key under different salts gives different ciphertext', () => {
  const a = K.encryptKey(priv, 'p', { salt: SALT, iters: IT });
  const b = K.encryptKey(priv, 'p', { salt: 'ffffffffffffffffffffffffffffffff', iters: IT });
  assert.notEqual(a.ct, b.ct, 'salt diversifies ciphertext');
  assert.equal(K.decryptKey(a, 'p'), K.decryptKey(b, 'p'), 'both still decrypt to the key');
});

test('encryption is deterministic given the same salt (reproducible box)', () => {
  const a = K.encryptKey(priv, 'p', { salt: SALT, iters: IT });
  const b = K.encryptKey(priv, 'p', { salt: SALT, iters: IT });
  assert.equal(a.ct, b.ct); assert.equal(a.mac, b.mac);
});

test('a freshly generated wallet key survives the round trip', () => {
  const w = C.generateWallet();
  const boxed = K.encryptKey(w.privateKey, 'hunter2', { salt: SALT, iters: IT });
  assert.equal(K.decryptKey(boxed, 'hunter2'), w.privateKey);
  assert.equal(C.walletFromPrivateKey(K.decryptKey(boxed, 'hunter2')).address, w.address, 'restores the same wallet');
});

test('rejects a malformed private key', () => {
  assert.throws(() => K.encryptKey('not-hex', 'p', { salt: SALT, iters: IT }), /32 bytes hex/);
});

// ---- runner ----------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); n++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
}
console.log(`\n${n}/${tests.length} cortex keystore tests passed`);
if (failed) process.exit(1);
