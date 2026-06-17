#!/usr/bin/env node
/**
 * Unit tests for apexvip-lib.js (ApexLib) — the hotel-rate estimate engine
 * extracted from the client app. Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-apexvip-lib.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'apexvip-lib.js'), 'utf8'), sandbox, { filename: 'apexvip-lib.js' });
const Lib = sandbox.module.exports;

const ritz = { name: 'The Ritz London', base: 780 };
let passed = 0; const tests = [];
const test = (n, f) => tests.push([n, f]);

test('seed01 is deterministic and in [0,1)', () => {
  assert.equal(Lib.seed01('abc'), Lib.seed01('abc'));
  const v = Lib.seed01('The Ritz London2026-07-03');
  assert.ok(v >= 0 && v < 1);
});

test('hotelRateKey composes the stay key', () => {
  assert.equal(Lib.hotelRateKey('X', '2026-07-03', 2, 2), 'X|2026-07-03|2|2');
});

test('estimateHotelRate is deterministic for the same stay', () => {
  assert.deepEqual(Lib.estimateHotelRate(ritz, '2026-07-03', 2, 2), Lib.estimateHotelRate(ritz, '2026-07-03', 2, 2));
});

test('estimateHotelRate: weekend >= midweek; rounds to £5; total ≈ nightly×nights', () => {
  const fri = Lib.estimateHotelRate(ritz, '2026-07-03', 2, 2); // Fri/Sat
  const tue = Lib.estimateHotelRate(ritz, '2026-07-07', 2, 2); // Tue/Wed
  assert.ok(fri.nightly >= tue.nightly);
  assert.equal(fri.nightly % 5, 0);
  assert.equal(fri.total % 5, 0);
  assert.ok(Math.abs(fri.total - fri.nightly * fri.nights) <= 5 * fri.nights);
});

test('estimateHotelRate: occupancy & length-of-stay shape the quote', () => {
  const r = Lib.estimateHotelRate(ritz, '2026-07-03', 7, 4);
  assert.equal(r.nights, 7);
  assert.equal(r.guests, 4);
  assert.equal(r.currency, 'GBP');
  assert.equal(r.available, true);
});

console.log('── apexvip-lib unit tests ──');
let failed = 0;
for (const [n, f] of tests) {
  try { f(); passed++; console.log('  ✓ ' + n); }
  catch (e) { failed++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
