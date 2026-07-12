#!/usr/bin/env node
/**
 * Tests for the Cortex relay (cortex/server.mjs) and the httpTransport in
 * cortex/net.js. Boots the real relay on an ephemeral port: it serves the app,
 * forwards only Cortex message types, and — end to end over HTTP — two nodes
 * mine and converge through it. Zero dependencies. Run:
 *   node scripts/test-cortex-relay.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createCortexRelay } from '../cortex/server.mjs';

// Load the browser-UMD modules (coin, engine, net) in a vm sandbox for the node logic.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const box = { module: { exports: {} } }; box.self = box; vm.createContext(box);
const load = (p, g) => { box.module = { exports: {} }; vm.runInContext(readFileSync(join(ROOT, p), 'utf8'), box, { filename: p }); if (g) box[g] = box.module.exports; return box.module.exports; };
const C = load('coin/engine.js', 'BallrzCoin');
load('cortex/datasets.js', 'BallrzCortexData');
const X = load('cortex/engine.js', 'BallrzCortex');
const Net = load('cortex/net.js', 'BallrzCortexNet');

const alice = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001');

async function boot() {
  const server = createCortexRelay({ rateCapacity: 1000 });
  await new Promise((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

test('the relay identifies as cortex and forwards Cortex message types', async () => {
  const { base, close } = await boot();
  try {
    const status = await (await fetch(base + '/status')).json();
    assert.equal(status.name, 'cortex-relay');
    for (const type of ['hello', 'chain', 'block', 'tx']) {
      const r = await fetch(base + '/msg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type }) });
      assert.equal(r.status, 200, `${type} accepted`);
    }
    const bad = await fetch(base + '/msg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'malware' }) });
    assert.equal(bad.status, 400, 'unknown type rejected');
  } finally { await close(); }
});

test('the relay serves the app and its modules', async () => {
  const { base, close } = await boot();
  try {
    const idx = await fetch(base + '/');
    assert.equal(idx.status, 200);
    assert.match(await idx.text(), /Cortex/);
    for (const p of ['/engine.js', '/net.js', '/datasets.js', '/coin/engine.js', '/vendor/noble-crypto.js', '/miner-worker.js']) {
      assert.equal((await fetch(base + p)).status, 200, `${p} served`);
    }
  } finally { await close(); }
});

test('a node homed on TWO relays bridges them into one network', async () => {
  const A = await boot(), B = await boot();
  try {
    const task = () => X.makeTask({ id: 'bridge' });
    const mkNode = (id, urls) => {
      const chain = new X.Chain(task(), { genesisSeed: 'g' });
      const transports = urls.map((u) => Net.httpTransport(u, { fetch }));
      const node = Net.createNode({ id, chain, send: (m) => transports.forEach((t) => t.send(m)) });
      return { node, chain, poll: () => Promise.all(transports.map((t) => t.poll((m) => node.receive(m)).catch(() => 0))) };
    };
    const minerA = mkNode('minerA', [A.base]);          // only on relay A
    const watcherB = mkNode('watcherB', [B.base]);      // only on relay B
    const bridge = mkNode('bridge', [A.base, B.base]);  // homed on both
    const blk = minerA.node.mineAndBroadcast({ privKey: alice.privateKey, steps: 300, nonce: 'br0' });
    assert.ok(blk, 'miner on relay A mines');
    // gossip: A → bridge (poll A) → re-broadcast to both → watcher (poll B).
    // The re-broadcast POST is fire-and-forget, so poll until it lands.
    for (let i = 0; i < 20 && watcherB.chain.height() === 0; i++) {
      await bridge.poll();
      await new Promise((r) => setTimeout(r, 50));
      await watcherB.poll();
    }
    assert.equal(watcherB.chain.height(), 1, 'the block crossed relays through the bridge node');
    assert.equal(watcherB.chain.tip().hash, blk.hash);
  } finally { await A.close(); await B.close(); }
});

test('two nodes mine and converge through the real relay over HTTP', async () => {
  const { base, close } = await boot();
  try {
    const mk = (id) => {
      const t = Net.httpTransport(base, { fetch });
      const node = Net.createNode({ id, chain: new X.Chain(X.makeTask({ id: 'relaynet' }), { genesisSeed: 'g' }), send: (m) => t.send(m) });
      return { node, t };
    };
    const A = mk('A'), B = mk('B');
    // A mines a block (POSTed to the relay), then B polls and applies it.
    A.node.mineAndBroadcast({ privKey: alice.privateKey, steps: 300, nonce: 'r1' });
    await new Promise((r) => setTimeout(r, 20));
    await B.t.poll((m) => B.node.receive(m));
    assert.equal(B.node.chain.height(), 1, 'B received A\'s block via the relay');
    assert.equal(B.node.chain.tip().hash, A.node.chain.tip().hash, 'same tip across the network');
  } finally { await close(); }
});

// ---- runner ----------------------------------------------------------------
const run = async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`ok - ${name}`); }
    catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
  }
  console.log(`\n${passed}/${tests.length} cortex relay tests passed`);
  process.exit(failed ? 1 : 0);
};
run();
