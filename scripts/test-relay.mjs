#!/usr/bin/env node
/**
 * Tests for the hardened TimeCoin relay (coin/server.mjs): memory-bounded
 * message buffer, per-IP token-bucket rate limiting (keyed on x-forwarded-for),
 * and the /status metrics. Zero dependencies — spins the real server on an
 * ephemeral port and drives it over HTTP. Run: node scripts/test-relay.mjs
 */
import assert from 'node:assert/strict';
import { createRelay } from '../coin/server.mjs';

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

// Start a relay with the given options on a random port; returns { base, close }.
async function boot(opts) {
  const server = createRelay(opts);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
const post = (base, body, ip) =>
  fetch(base + '/msg', { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) }, body: JSON.stringify(body) });
const tx = (id) => ({ type: 'tx', tx: { id } });

test('accepts valid messages and hands back a monotonic seq', async () => {
  const { base, close } = await boot({ rateCapacity: 100 });
  try {
    const r1 = await (await post(base, tx('a'))).json();
    const r2 = await (await post(base, tx('b'))).json();
    assert.equal(r1.ok, true); assert.equal(r1.seq, 1);
    assert.equal(r2.seq, 2);
    const msgs = (await (await fetch(base + '/msgs?since=0')).json()).msgs;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].tx.id, 'a');
  } finally { await close(); }
});

test('rejects bad json and unknown message types with 400', async () => {
  const { base, close } = await boot({ rateCapacity: 100 });
  try {
    const bad = await fetch(base + '/msg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(bad.status, 400);
    const wrong = await post(base, { type: 'malware', payload: 1 });
    assert.equal(wrong.status, 400);
  } finally { await close(); }
});

test('the buffer is bounded by count — oldest messages are evicted', async () => {
  const { base, close } = await boot({ maxHeld: 5, rateCapacity: 100 });
  try {
    for (let i = 0; i < 9; i++) await post(base, tx('m' + i));
    const body = await (await fetch(base + '/msgs?since=0')).json();
    assert.equal(body.seq, 9, 'seq keeps counting');
    assert.equal(body.msgs.length, 5, 'only the last 5 are held');
    assert.equal(body.msgs[0].tx.id, 'm4', 'm0..m3 evicted');
    const st = await (await fetch(base + '/status')).json();
    assert.equal(st.held, 5);
  } finally { await close(); }
});

test('the buffer is bounded by bytes as well as count', async () => {
  // Each message JSON is ~1KB; a 4KB budget must keep only a few.
  const { base, close } = await boot({ maxHeld: 10000, maxBytes: 4096, rateCapacity: 100 });
  try {
    const big = 'x'.repeat(900);
    for (let i = 0; i < 20; i++) await post(base, { type: 'chat', chat: { id: i, text: big } });
    const st = await (await fetch(base + '/status')).json();
    assert.ok(st.heldBytes <= 4096, 'held bytes stays within budget, got ' + st.heldBytes);
    assert.ok(st.held < 20 && st.held >= 1, 'kept a bounded slice, held=' + st.held);
  } finally { await close(); }
});

test('per-IP rate limiting throttles a flooder but not other clients', async () => {
  // capacity 3, no refill: the 4th post from one IP is rejected.
  const { base, close } = await boot({ rateCapacity: 3, rateRefill: 0 });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(base, tx('f' + i), '9.9.9.9')).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429], 'first 3 ok then throttled');
    // a DIFFERENT client IP has its own fresh bucket
    const other = await post(base, tx('other'), '8.8.8.8');
    assert.equal(other.status, 200, 'a different IP is unaffected');
    const st = await (await fetch(base + '/status')).json();
    assert.equal(st.rejectedRate, 2);
    assert.ok(st.clients >= 2);
  } finally { await close(); }
});

test('refilled tokens let a well-behaved client keep posting', async () => {
  // capacity 1, refill 10/sec (1 token per 100ms): an immediate second post is
  // throttled, but after a wait the refilled token lets it through.
  const { base, close } = await boot({ rateCapacity: 1, rateRefill: 10 });
  try {
    assert.equal((await post(base, tx('a'), '1.1.1.1')).status, 200);
    assert.equal((await post(base, tx('b'), '1.1.1.1')).status, 429, 'immediate re-post throttled');
    await new Promise((r) => setTimeout(r, 200)); // ~2 tokens refilled
    assert.equal((await post(base, tx('c'), '1.1.1.1')).status, 200, 'allowed after refill');
  } finally { await close(); }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
  }
  console.log('\nrelay: ' + passed + '/' + tests.length + ' passed');
})();
