#!/usr/bin/env node
/**
 * Tests for the AI Token node+relay (aicoin/server.mjs): it must serve the
 * full-node app with everything a fresh device needs (app, both engines, the
 * GPT runtime and weights), and delegate the gossip API to TimeCoin's
 * hardened relay. Zero dependencies — real server on an ephemeral port.
 * Run: node scripts/test-aicoin-relay.mjs
 */
import assert from 'node:assert/strict';
import { createNode } from '../aicoin/server.mjs';

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

async function boot() {
  const server = createNode({ rateCapacity: 100 });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test('serves the app and every dependency a fresh node needs', async () => {
  const { base, close } = await boot();
  try {
    const app = await (await fetch(base + '/')).text();
    assert.match(app, /mine AI tokens/i);
    for (const path of ['/engine.js', '/coin/engine.js', '/llm-from-scratch/web/gpt.js']) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-type'), /javascript/, path);
    }
    const model = await (await fetch(base + '/llm-from-scratch/web/model.json')).json();
    assert.ok(model.config && model.weights, 'model.json parses with config + weights');
    assert.equal((await fetch(base + '/nope')).status, 404);
  } finally { await close(); }
});

test('relays gossip: POST /msg round-trips through GET /msgs, /status reports', async () => {
  const { base, close } = await boot();
  try {
    const post = await (await fetch(base + '/msg', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'tx', tx: { id: 'ai-1' } })
    })).json();
    assert.equal(post.ok, true);
    const got = await (await fetch(base + '/msgs?since=0')).json();
    assert.equal(got.msgs.length, 1);
    assert.equal(got.msgs[0].tx.id, 'ai-1');
    const status = await (await fetch(base + '/status')).json();
    assert.equal(status.ok, true);
  } finally { await close(); }
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n      ${err.message}`); process.exitCode = 1; }
}
console.log(`\naicoin relay: ${passed}/${tests.length} passed`);
