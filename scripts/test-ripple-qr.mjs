#!/usr/bin/env node
/**
 * Structural unit tests for ripple/qr.js — the dependency-free QR encoder.
 * We can't visually scan here, so we verify the spec's fixed structure: matrix
 * size, the three finder patterns, separators, timing patterns, the dark module,
 * version selection, and SVG output. These invariants catch placement bugs.
 * Run: node scripts/test-ripple-qr.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'ripple', 'qr.js'), 'utf8'), sandbox, { filename: 'ripple/qr.js' });
const QR = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

const isFinder = (m, r0, c0) => {
  for (let dr = 0; dr < 7; dr++) for (let dc = 0; dc < 7; dc++) {
    const ring = (dr === 0 || dr === 6 || dc === 0 || dc === 6);
    const core = (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
    if (m[r0 + dr][c0 + dc] !== (ring || core)) return false;
  }
  return true;
};

test('encode picks a version and a correct matrix size', () => {
  const qr = QR.encode('https://refayethossain28.github.io/BallrzAPP/ripple/?add=alex');
  assert.ok(qr, 'should encode');
  assert.equal(qr.size, 17 + 4 * qr.version);
  assert.equal(qr.modules.length, qr.size);
  assert.equal(qr.modules[0].length, qr.size);
});

test('three finder patterns sit in the corners', () => {
  const qr = QR.encode('hello-ripple');
  const n = qr.size, m = qr.modules;
  assert.ok(isFinder(m, 0, 0), 'top-left finder');
  assert.ok(isFinder(m, 0, n - 7), 'top-right finder');
  assert.ok(isFinder(m, n - 7, 0), 'bottom-left finder');
});

test('separators around the top-left finder are light', () => {
  const qr = QR.encode('hello-ripple');
  const m = qr.modules;
  for (let i = 0; i < 8; i++) { assert.equal(m[7][i], false, 'row separator'); assert.equal(m[i][7], false, 'col separator'); }
});

test('timing patterns alternate on row 6 and column 6', () => {
  const qr = QR.encode('timing-check-123');
  const n = qr.size, m = qr.modules;
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0, 'h timing @' + i);
    assert.equal(m[i][6], i % 2 === 0, 'v timing @' + i);
  }
});

test('dark module is present', () => {
  const qr = QR.encode('dark-module');
  assert.equal(qr.modules[qr.size - 8][8], true);
});

test('longer content selects a higher version', () => {
  const small = QR.encode('hi');
  const big = QR.encode('x'.repeat(120));
  assert.ok(big.version > small.version, 'more data => higher version');
});

test('toSVG renders dark modules with a quiet zone', () => {
  const qr = QR.encode('svg-test');
  const svg = QR.toSVG(qr, 4);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('path'));
  const dim = (qr.size + 8) * 4;
  assert.ok(svg.includes('width="' + dim + '"'), 'includes quiet zone in size');
});

test('encode returns null when content is too long for the supported range', () => {
  assert.equal(QR.encode('y'.repeat(400)), null);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`✗ ${name}\n   ${err.message}`); process.exit(1); }
}
console.log(`✓ ripple QR: ${passed}/${tests.length} tests passed`);
