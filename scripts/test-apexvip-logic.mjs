#!/usr/bin/env node
/**
 * Unit tests for the ApexVIP core engine (apexvip-core.js).
 *
 * apexvip-core.js is a UMD module exporting the pure pricing/matching logic the
 * client and admin apps rely on (ApexYield™, PrestigeMatch™, etc.), so we can
 * require it directly and assert real behaviour — no DOM, no network, zero deps.
 *
 * Run: node scripts/test-apexvip-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The repo is "type":"module", so a bare require() would treat the UMD file as
// ESM and break its `module.exports` branch. Run it in a vm sandbox instead.
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'apexvip-core.js'), 'utf8'), sandbox, { filename: 'apexvip-core.js' });
const Core = sandbox.module.exports;

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── ApexYield™ ──────────────────────────────────────────────────────────────
test('apexYield: invalid date returns neutral 1.0 multiplier', () => {
  const r = Core.apexYield({ date: 'invalid', time: '99:99' });
  assert.equal(r.multiplier, 1.0);
  assert.equal(r.label, 'Standard');
});

test('apexYield: multiplier always within [1.0, 3.0] across a week/day sweep', () => {
  for (const date of ['2026-01-13', '2026-06-19', '2026-12-31', '2026-07-04']) {
    for (let h = 0; h < 24; h++) {
      for (const v of ['s', 'v', 'rolls-royce phantom']) {
        const m = Core.apexYield({ date, time: String(h).padStart(2, '0') + ':00', vehicle: v }).multiplier;
        assert.ok(m >= 1.0 && m <= 3.0, `multiplier ${m} out of range for ${date} ${h}h ${v}`);
      }
    }
  }
});

test('apexYield: quiet weekday small-hours <= busy Friday evening', () => {
  const quiet = Core.apexYield({ date: '2026-02-10', time: '03:00' }).multiplier; // Tue 3am
  const busy  = Core.apexYield({ date: '2026-02-13', time: '19:00' }).multiplier; // Fri 7pm
  assert.ok(quiet <= busy, `expected quiet(${quiet}) <= busy(${busy})`);
});

test('apexYield: exposes the four signal layers', () => {
  const s = Core.apexYield({ date: '2026-06-19', time: '18:00' }).signals;
  for (const k of ['L1_hourly', 'L2_dow', 'L3_event', 'L4_elasticity']) assert.ok(k in s, 'missing ' + k);
});

// ── PrestigeMatch™ ────────────────────────────────────────────────────────────
const driver = (o) => ({ id: o.id, vehicle: o.vehicle || 'S-Class', rating: o.rating ?? 4.8,
  etaMinutes: o.eta ?? 10, status: o.status || 'available', pastClients: o.pastClients || [],
  corporateIds: o.corporateIds || [] });

test('prestigeMatch: empty driver list returns []', () => {
  const out = Core.prestigeMatch({ vehicleClass: 'S-Class' }, []);
  assert.ok(Array.isArray(out) && out.length === 0);
});

test('prestigeMatch: results sorted by matchScore desc', () => {
  const out = Core.prestigeMatch({ vehicleClass: 'S-Class' }, [
    driver({ id: 'a', rating: 4.2, eta: 25 }),
    driver({ id: 'b', rating: 5.0, eta: 4 }),
  ]);
  assert.equal(out[0].id, 'b');
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].matchScore >= out[i].matchScore);
});

test('prestigeMatch: a busy driver is penalised below an identical available one', () => {
  const [a, b] = Core.prestigeMatch({ vehicleClass: 'S-Class' }, [
    driver({ id: 'busy', status: 'busy' }),
    driver({ id: 'free', status: 'available' }),
  ]);
  assert.equal(a.id, 'free');
  const busy = [a, b].find(d => d.id === 'busy');
  assert.equal(busy.matchBreakdown.penalty, 50);
});

test('prestigeMatch: exact vehicle match outscores a mismatch', () => {
  const out = Core.prestigeMatch({ vehicleClass: 'Rolls-Royce Phantom' }, [
    driver({ id: 'phantom', vehicle: 'Rolls-Royce Phantom' }),
    driver({ id: 'vclass', vehicle: 'V-Class' }),
  ]);
  assert.equal(out[0].id, 'phantom');
});

// ── SilentService™ ────────────────────────────────────────────────────────────
test('silentService: null on empty history; learns top patterns', () => {
  assert.equal(Core.silentService([]), null);
  const p = Core.silentService([
    { pickup: 'Mayfair', dropoff: 'Heathrow T5', serviceType: 'airport', vehicle: 'S-Class', time: '08:30' },
    { pickup: 'Mayfair', dropoff: 'Gatwick',     serviceType: 'airport', vehicle: 'S-Class', time: '09:15' },
  ]);
  assert.equal(p.bookings, 2);
  assert.equal(p.preferredService, 'airport');
  assert.equal(p.preferredVehicle, 'S-Class');
  assert.equal(p.prefill.pickup, 'Mayfair');
});

// ── ApexETA™ ──────────────────────────────────────────────────────────────────
test('apexETA: total = base + buffer; rush hour widens the buffer', () => {
  const off  = Core.apexETA({ baseMinutes: 40, tripType: 'airport', hour: 12 });
  const rush = Core.apexETA({ baseMinutes: 40, tripType: 'airport', hour: 8 });
  assert.equal(off.totalMinutes, off.baseMinutes + off.bufferMinutes);
  assert.ok(rush.bufferMinutes > off.bufferMinutes, 'rush buffer should exceed off-peak');
});

// ── QuietRoute™ ───────────────────────────────────────────────────────────────
test('quietRoute: smoother route with fewer stops scores higher', () => {
  const out = Core.quietRoute([
    { id: 'bumpy', minutes: 30, stopsPerKm: 2.5, roughSegments: 4, scenicKm: 0, totalKm: 12 },
    { id: 'glide', minutes: 31, stopsPerKm: 0.4, roughSegments: 0, scenicKm: 6, totalKm: 12 },
  ]);
  assert.equal(out[0].id, 'glide');
});

// ── ApexLifetime™ ─────────────────────────────────────────────────────────────
test('apexLifetime: empty → Member/0; big recent spender → Black', () => {
  assert.equal(Core.apexLifetime([]).tier, 'Member');
  const now = Date.now();
  const recent = (price, daysAgo) => ({ price, date: new Date(now - daysAgo * 86400000).toISOString() });
  const big = Array.from({ length: 12 }, (_, i) => recent(1100, i)); // ~£13.2k, all recent
  const r = Core.apexLifetime(big, now);
  assert.equal(r.tier, 'Black');
  assert.ok(r.score >= 75);
});

// ── runner ────────────────────────────────────────────────────────────────────
console.log('── apexvip-core unit tests ──');
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
