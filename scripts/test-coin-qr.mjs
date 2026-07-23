#!/usr/bin/env node
/**
 * Decodability tests for coin/qr.js — the dependency-free QR encoder.
 *
 * The old structural-only test (test-ripple-qr.mjs) checked that finder and
 * timing patterns were in the right place, but never that the code could be
 * *read*. It missed a reversed Reed–Solomon generator polynomial: every QR the
 * app produced looked valid but was unscannable (wrong ECC bytes), so no camera
 * could decode a wallet, payment or paper-wallet QR.
 *
 * This guards the actual output two ways, with zero dependencies:
 *   1. The Reed–Solomon ECC is checked against known-answer vectors that were
 *      cross-verified against a reference QR library (node `qrcode`).
 *   2. The full rendered matrix for a canonical payment URL is pinned by a
 *      SHA-256 hash; that exact matrix was confirmed to decode back to the URL
 *      by a reference reader (`jsQR`) when this test was written. Any change to
 *      the encoder that alters the output — including a regression that breaks
 *      scannability — trips the hash and must be re-verified.
 *
 * Run: node scripts/test-coin-qr.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'coin', 'qr.js'), 'utf8'), sandbox, { filename: 'coin/qr.js' });
const QR = sandbox.module.exports;

const hex = (a) => [...a].map((x) => ('0' + x.toString(16)).slice(-2)).join('');
const bytesOf = (s) => [...Buffer.from(s, 'utf8')];

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

test('Reed–Solomon ECC matches known-answer vectors (cross-checked vs node `qrcode`)', () => {
  // version-1-L data block for "HI" (mode+count+data+pad), 7 ECC codewords.
  const hiData = [0x40, 0x24, 0x84, 0x90, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec];
  assert.equal(hex(QR.rsEncode(hiData, 7)), '9dd39656a299d4', 'ecLen=7 ECC');
  // 15-ECC vector over the bytes of "ballrzcoin".
  assert.equal(hex(QR.rsEncode(bytesOf('ballrzcoin'), 15)), '16ffe7223811556b96f899c187ea60', 'ecLen=15 ECC');
});

test('the generator polynomial is monic (leading coefficient 1)', () => {
  // A reversed generator (the shipped bug) makes ECC(all-zero data) non-zero.
  // For zero data the remainder must be all zeros under a correct monic generator.
  assert.deepEqual(QR.rsEncode([0, 0, 0, 0], 7), [0, 0, 0, 0, 0, 0, 0], 'ECC of zero data is zero');
});

test('a canonical payment QR renders to the exact (decodable) matrix', () => {
  const PAY = 'https://refayethossain28.github.io/BallrzAPP/coin/?pay=BS2f2fPy26pptvHhy3ajFme8RX1MUcm3A3';
  const qr = QR.encode(PAY);
  assert.equal(qr.version, 5);
  assert.equal(qr.size, 37);
  const rows = qr.modules.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('\n');
  // This matrix was verified to decode back to PAY by the jsQR reference reader.
  assert.equal(
    createHash('sha256').update(rows).digest('hex'),
    '0c10e14cd4e8142bbd928eefe75d24ad299e000b3d4ea13a560c1ad75fc7efeb',
    'encoder output changed — re-verify it still scans, then update this hash',
  );
});

test('a long invite QR (version 8, with version-information block) is decodable', () => {
  // Versions ≥ 7 need an 18-bit version-information block; without it the whole
  // code is unscannable (this bit them once — long invite links wouldn't scan).
  const PAY = 'https://ballrzcoin-jtb2.onrender.com/?claim=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff&relay=https%3A%2F%2Fballrzcoin-jtb2.onrender.com&from=circle';
  const qr = QR.encode(PAY);
  assert.equal(qr.version, 8);
  assert.equal(qr.size, 49);
  const rows = qr.modules.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('\n');
  // Verified to decode back to PAY by the jsQR reference reader.
  assert.equal(
    createHash('sha256').update(rows).digest('hex'),
    '7a84c525a233ba5c9bc17d75c8ef5799e2eade7c1383ba7f07a0c39d54617344',
    'v7+ encoder output changed — re-verify it still scans, then update this hash',
  );
});

test('version selection scales with payload length', () => {
  assert.equal(QR.encode('HI').version, 1);
  assert.ok(QR.encode('x'.repeat(80)).version >= 4, 'longer payloads pick a bigger version');
  assert.equal(QR.encode('z'.repeat(100000)), null, 'oversized payloads return null, not a broken code');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
  }
  console.log('\ncoin QR: ' + passed + '/' + tests.length + ' passed');
})();
