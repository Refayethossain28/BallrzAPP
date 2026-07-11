#!/usr/bin/env node
/**
 * Unit tests for cortex/net.js — the gossip/consensus-sync layer. Drives nodes
 * over a synchronous in-memory bus (no real network) so convergence is
 * deterministic: block fast-path propagation, cumulative-learning fork choice
 * across peers, MIND-transfer gossip into the mempool, and a late joiner
 * catching up via hello→chain. Loaded in a vm sandbox with the coin engine,
 * dataset module and cortex engine. Run: node scripts/test-cortex-net.mjs
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
load('cortex/datasets.js', 'BallrzCortexData');
const X = load('cortex/engine.js', 'BallrzCortex');
const Net = load('cortex/net.js', 'BallrzCortexNet');

const alice = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001');
const bob = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000002');
const task = () => X.makeTask({ id: 'net' });               // shared genesis across nodes
const freshChain = () => new X.Chain(task(), { genesisSeed: 'g' });

// A synchronous message bus: nodes push messages, pump() delivers each to every
// other node until the queue drains (dedup in net.js stops re-broadcast loops).
function makeBus() {
  const bus = { q: [], nodes: [] };
  bus.node = (id, chain) => { const nd = Net.createNode({ id, chain, send: (m) => bus.q.push(m) }); bus.nodes.push(nd); return nd; };
  bus.pump = (max = 4000) => { let s = 0; while (bus.q.length && s++ < max) { const m = bus.q.shift(); for (const n of bus.nodes) if (n.id !== m.from) n.receive(m); } };
  return bus;
}

let n = 0; const tests = []; const test = (name, fn) => tests.push([name, fn]);

test('a mined block propagates to a peer (fast path)', () => {
  const bus = makeBus();
  const a = bus.node('A', freshChain()), b = bus.node('B', freshChain());
  assert.equal(b.chain.height(), 0);
  a.mineAndBroadcast({ privKey: alice.privateKey, steps: 300, nonce: 'a1' });
  bus.pump();
  assert.equal(b.chain.height(), 1, 'B accepted the block');
  assert.equal(b.chain.tip().hash, a.chain.tip().hash, 'same tip');
  assert.ok(b.stats.blocksAccepted >= 1);
});

test('peers converge on the chain that has learned more (fork choice)', () => {
  // Build two chains independently off the same genesis, then connect them.
  const cA = freshChain(); cA.addBlock(cA.mineBlock({ privKey: alice.privateKey, steps: 300, nonce: 'a0' }));
  const cB = freshChain();
  for (let i = 0; i < 4; i++) { const blk = cB.mineBlock({ privKey: bob.privateKey, steps: 300, nonce: 'b' + i }); if (!blk) break; cB.addBlock(blk); }
  assert.ok(cB.cumulativeImprovement() > cA.cumulativeImprovement(), 'B learned more');
  const bus = makeBus();
  const a = bus.node('A', cA), b = bus.node('B', cB);
  a.announce(); b.announce(); bus.pump();
  assert.equal(a.chain.tip().hash, b.chain.tip().hash, 'converged');
  assert.equal(a.chain.cumulativeImprovement(), cB.cumulativeImprovement(), 'A adopted the smarter chain');
  assert.ok(a.stats.chainsAdopted >= 1);
});

test('a MIND transfer gossips into peers\' mempools', () => {
  const bus = makeBus();
  const a = bus.node('A', freshChain()), b = bus.node('B', freshChain()), c = bus.node('C', freshChain());
  const tx = X.signTransfer({ privKey: alice.privateKey, to: bob.address, amount: 1000, at: 1, nonce: 'n1' });
  a.submitTx(tx); bus.pump();
  assert.equal(b.mempool.length, 1, 'B pooled it');
  assert.equal(c.mempool.length, 1, 'C pooled it too (relayed)');
  assert.equal(b.mempool[0].id, tx.id);
});

test('a late joiner catches up via hello → chain', () => {
  const cA = freshChain();
  for (let i = 0; i < 2; i++) cA.addBlock(cA.mineBlock({ privKey: alice.privateKey, steps: 300, nonce: 'j' + i }));
  const bus = makeBus();
  const a = bus.node('A', cA), late = bus.node('LATE', freshChain());
  assert.equal(late.chain.height(), 0);
  late.hello(); bus.pump();
  assert.equal(late.chain.height(), 2, 'caught up to the network tip');
  assert.equal(late.chain.tip().hash, a.chain.tip().hash);
});

test('a block that does not fit triggers a sync request, not a crash', () => {
  const bus = makeBus();
  const a = bus.node('A', freshChain());
  // A receives a block from an unknown height (bad prevHash) — should ask to sync.
  const tag = a.receive({ type: 'block', from: 'X', block: { index: 5, prevHash: 'ff'.repeat(32), hash: 'ab'.repeat(32) } });
  assert.equal(tag, 'requested:sync');
  assert.equal(a.chain.height(), 0, 'chain untouched');
});

/* ---- network-adjusted time (median of peers) ------------------------------ */
test('a node corrects its clock to the median of its peers', () => {
  const clockAt = (t) => () => t;
  const me = Net.createNode({ id: 'me', chain: freshChain(), send: () => {}, clock: clockAt(1000000) });
  assert.equal(me.now(), 1000000, 'no peers: local clock');
  // three peers whose clocks read +2s, +3s, +120s — median is +3s
  me.receive({ type: 'hello', from: 'p1', now: 1002000 });
  me.receive({ type: 'hello', from: 'p2', now: 1003000 });
  me.receive({ type: 'hello', from: 'p3', now: 1120000 });
  assert.equal(me.now(), 1003000, 'median offset applied');
});

test('a sybil majority cannot drag network time beyond the clamp', () => {
  const me = Net.createNode({ id: 'me', chain: freshChain(), send: () => {}, clock: () => 5000000 });
  for (let i = 0; i < 9; i++) me.receive({ type: 'hello', from: 'evil' + i, now: 5000000 + 3600e3 }); // all +1 hour
  assert.equal(me.now(), 5000000, 'median beyond ±10min → fall back to the local clock');
});

test('future-block rejection runs on network time, not the local clock', () => {
  // A scheduled task; the receiving node's LOCAL clock is 6 minutes slow, but
  // its peers are on real time — the block must be accepted, not dropped.
  const NOW = 1783641600000 + 20 * 60e3; // 20min after the schedule start
  const st = X.makeTask({ id: 'nettime', minImprovement: 1e-4, schedule: { startAt: 1783641600000, halfLifeMs: 3600e3, budget: 0.2, minIntervalMs: 1000 } });
  const mk = () => new X.Chain(X.makeTask({ id: 'nettime', minImprovement: 1e-4, schedule: { startAt: 1783641600000, halfLifeMs: 3600e3, budget: 0.2, minIntervalMs: 1000 } }), { genesisSeed: 'g' });
  const minerChain = mk();
  const blk = minerChain.mineBlock({ privKey: alice.privateKey, steps: 400, at: NOW, nonce: 't0' });
  assert.ok(blk, 'miner (on real time) mines');
  const slow = Net.createNode({ id: 'slow', chain: mk(), send: () => {}, clock: () => NOW - 6 * 60e3 });
  // without peer calibration the block looks >5min in the future and is dropped
  assert.equal(slow.receive({ type: 'block', from: 'm', block: blk, now: NOW - 6 * 60e3 }), 'rejected:future-timestamp');
  // three honest peers on real time calibrate the slow node…
  slow.receive({ type: 'hello', from: 'h1', now: NOW });
  slow.receive({ type: 'hello', from: 'h2', now: NOW + 500 });
  slow.receive({ type: 'hello', from: 'h3', now: NOW - 500 });
  // …and the same block is now accepted
  assert.equal(slow.receive({ type: 'block', from: 'm2', block: blk, now: NOW }), 'accepted:block');
});

test('a genuinely future-dated block is rejected even after calibration', () => {
  const NOW = 1783641600000 + 40 * 60e3;
  const mk = () => new X.Chain(X.makeTask({ id: 'nettime2', minImprovement: 1e-4, schedule: { startAt: 1783641600000, halfLifeMs: 3600e3, budget: 0.2, minIntervalMs: 1000 } }), { genesisSeed: 'g' });
  const cheatChain = mk();
  const blk = cheatChain.mineBlock({ privKey: alice.privateKey, steps: 400, at: NOW + 30 * 60e3, nonce: 'f0' }); // post-dated +30min to unlock budget early
  assert.ok(blk, 'cheater can construct the block locally');
  const honest = Net.createNode({ id: 'h', chain: mk(), send: () => {}, clock: () => NOW });
  honest.receive({ type: 'hello', from: 'h1', now: NOW });
  honest.receive({ type: 'hello', from: 'h2', now: NOW });
  assert.equal(honest.receive({ type: 'block', from: 'cheat', block: blk, now: NOW }), 'rejected:future-timestamp');
});

// ---- runner ----------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); n++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
}
console.log(`\n${n}/${tests.length} cortex net tests passed`);
if (failed) process.exit(1);
