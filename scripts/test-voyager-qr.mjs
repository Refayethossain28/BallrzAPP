#!/usr/bin/env node
/**
 * Tests for voyager/qr.js — the from-scratch QR encoder behind 📱 hand-off.
 * The strongest possible check: every matrix is rendered to pixels and decoded
 * by an INDEPENDENT decoder (jsQR). If the Reed–Solomon maths, interleaving,
 * masking or format bits were wrong anywhere, the round-trip would fail.
 * Run: node scripts/test-voyager-qr.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'voyager', 'qr.js'), 'utf8'), sandbox, { filename: 'voyager/qr.js' });
const QR = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/** Render a module matrix to RGBA pixels (scale 4, quiet zone 4 modules). */
function rasterize(code) {
  const scale = 4, quiet = 4;
  const px = (code.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let r = 0; r < code.size; r++) {
    for (let c = 0; c < code.size; c++) {
      if (!code.modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const y = (r + quiet) * scale + dy, x = (c + quiet) * scale + dx;
          const i = (y * px + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: px, height: px };
}

function roundTrip(text) {
  const code = QR.encode(text);
  const img = rasterize(code);
  const decoded = jsQR(img.data, img.width, img.height);
  assert.ok(decoded, `decoder found no QR (v${code.version}, mask ${code.mask})`);
  assert.equal(decoded.data, text, `round-trip mismatch at v${code.version}`);
  return code;
}

test('BCH vectors match the published spec values', () => {
  assert.equal(QR.formatBits(0), 0x77c4);            // EC L, mask 0 → 111011111000100
  assert.equal(QR.versionBits(7), 0x07c94);          // version 7 → 000111110010010100
});

test('v1: a short URL round-trips through an independent decoder', () => {
  const code = roundTrip('https://a.io/x');
  assert.equal(code.version, 1);
  assert.equal(code.size, 21);
});

test('v3–v5: typical page URLs round-trip', () => {
  const c3 = roundTrip('https://refayethossain28.github.io/BallrzAPP/voyager/');
  assert.ok(c3.version <= 4, 'unexpectedly large version');
  roundTrip('https://example.com/some/deep/path?query=with-parameters&and=more#plus-a-fragment-on-top');
});

test('v6: multi-block interleaving survives', () => {
  const text = 'https://example.com/' + 'abcdefghij'.repeat(11);   // 130 bytes → v6 (2 blocks)
  const code = roundTrip(text);
  assert.equal(code.version, 6);
});

test('v7: version-info bits are placed and readable', () => {
  const text = 'https://example.com/' + 'x'.repeat(130);           // 150 bytes → v7
  const code = roundTrip(text);
  assert.equal(code.version, 7);
  assert.equal(code.size, 45);
});

test('v10: 16-bit count and the 4-block split survive', () => {
  const text = 'https://example.com/?q=' + 'y'.repeat(240);        // 263 bytes → v10
  const code = roundTrip(text);
  assert.equal(code.version, 10);
});

test('UTF-8 beyond ASCII round-trips (emoji and accents)', () => {
  roundTrip('https://example.com/café?q=🧭 voyager');
});

test('every emitted matrix is square with only booleans', () => {
  const code = QR.encode('https://example.com/check');
  assert.equal(code.modules.length, code.size);
  for (const row of code.modules) {
    assert.equal(row.length, code.size);
    for (const cell of row) assert.equal(typeof cell, 'boolean');
  }
});

test('too long for v10 → an honest throw, not a corrupt code', () => {
  assert.throws(() => QR.encode('z'.repeat(272)), /too long/);
  QR.encode('z'.repeat(271));                                       // the boundary itself fits
});

/* ---- run ---- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n${err.message}\n`);
    process.exitCode = 1;
  }
}
console.log(`\nvoyager qr: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
