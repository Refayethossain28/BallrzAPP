#!/usr/bin/env node
/**
 * Unit tests for atlas/core.mjs — the pure, deterministic core of the Atlas LAN
 * node registry + scheduler: report normalisation, node health/staleness,
 * capability matching and the (deliberately simple, explainable) node selector.
 *
 * core.mjs is real ESM with named exports, so we import it directly — no vm
 * sandbox needed, and every function takes `now` explicitly so results are
 * reproducible. Zero dependencies — Node built-ins only.
 * Run: node scripts/test-atlas-logic.mjs
 */
import assert from 'node:assert/strict';
import {
  normList, normHealth, normalizeReport, nodeStatus, isSchedulable,
  hasCapabilities, compareNodes, selectNode, summarize,
} from '../atlas/core.mjs';

let passed = 0;
const tests = [];
const test = (n, f) => tests.push([n, f]);

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0); // fixed clock
const STALE = 15000;

/** Build a canonical node record for tests (fresh heartbeat by default). */
function node(over = {}) {
  return normalizeReport({
    hostname: 'box', ip: '10.0.0.2', cpuCores: 8, ramMB: 16384,
    gpuName: 'RTX 4090', vramMB: 24576, services: ['postgres'],
    capabilities: ['ocr', 'vision'], load: 0.2, health: 'ok', ...over,
  }, over.lastSeen != null ? over.lastSeen : NOW);
}

/* ---------- normalisation ---------- */
test('normList lowercases, trims, dedupes and sorts', () => {
  assert.deepEqual(normList([' OCR', 'ocr', 'Vision', null, '']), ['ocr', 'vision']);
  assert.deepEqual(normList('nope'), []);
});

test('normHealth maps synonyms to ok | degraded | down', () => {
  assert.equal(normHealth('OK'), 'ok');
  assert.equal(normHealth('warn'), 'degraded');
  assert.equal(normHealth('dead'), 'down');
  assert.equal(normHealth(undefined), 'ok');
});

test('normalizeReport coerces junk to safe defaults, keeps the node visible', () => {
  const n = normalizeReport({ hostname: '  Alpha ', cpuCores: '4', ramMB: 'x', load: 5 }, NOW);
  assert.equal(n.hostname, 'Alpha');
  assert.equal(n.id, 'Alpha');       // id falls back to hostname
  assert.equal(n.cpuCores, 4);       // string coerced
  assert.equal(n.ramMB, 0);          // NaN → 0, not dropped
  assert.equal(n.load, 1);           // clamped into 0..1
  assert.equal(n.lastSeen, NOW);
});

test('normalizeReport: missing hostname/id becomes "unknown"', () => {
  assert.equal(normalizeReport({}, NOW).hostname, 'unknown');
});

/* ---------- health / staleness ---------- */
test('nodeStatus: fresh + ok = healthy and schedulable', () => {
  const n = node();
  assert.equal(nodeStatus(n, NOW, STALE), 'healthy');
  assert.equal(isSchedulable(n, NOW, STALE), true);
});

test('nodeStatus: no heartbeat within window = stale (overrides reported ok)', () => {
  const n = node({ lastSeen: NOW - STALE - 1 });
  assert.equal(nodeStatus(n, NOW, STALE), 'stale');
  assert.equal(isSchedulable(n, NOW, STALE), false);
});

test('nodeStatus: fresh but degraded/down are visible but not schedulable', () => {
  assert.equal(nodeStatus(node({ health: 'degraded' }), NOW, STALE), 'degraded');
  assert.equal(nodeStatus(node({ health: 'down' }), NOW, STALE), 'unhealthy');
  assert.equal(isSchedulable(node({ health: 'degraded' }), NOW, STALE), false);
  assert.equal(isSchedulable(node({ health: 'down' }), NOW, STALE), false);
});

/* ---------- capability matching ---------- */
test('hasCapabilities: requires ALL, empty requirement matches anything', () => {
  const n = node({ capabilities: ['ocr', 'vision', 'embeddings'] });
  assert.equal(hasCapabilities(n, ['ocr', 'vision']), true);
  assert.equal(hasCapabilities(n, ['ocr', 'whisper']), false);
  assert.equal(hasCapabilities(n, []), true);
  assert.equal(hasCapabilities(n, ['OCR']), true); // case-insensitive
});

/* ---------- ordering ---------- */
test('compareNodes: lower load wins, ties break by cpu then ram then id', () => {
  const a = node({ id: 'a', load: 0.1 });
  const b = node({ id: 'b', load: 0.9 });
  assert.ok(compareNodes(a, b) < 0);
  const c = node({ id: 'c', load: 0.5, cpuCores: 16 });
  const d = node({ id: 'd', load: 0.5, cpuCores: 8 });
  assert.ok(compareNodes(c, d) < 0); // more CPU on a load tie
});

/* ---------- selection ---------- */
test('selectNode: picks lowest-load node that has the required capabilities', () => {
  const busy = node({ id: 'busy', load: 0.8, capabilities: ['ocr', 'vision'] });
  const idle = node({ id: 'idle', load: 0.1, capabilities: ['ocr', 'vision'] });
  const other = node({ id: 'other', load: 0.0, capabilities: ['whisper'] });
  const d = selectNode([busy, idle, other], { capabilities: ['ocr', 'vision'] }, NOW, STALE);
  assert.equal(d.node.id, 'idle');
  assert.deepEqual(d.candidates, ['idle', 'busy']); // 'other' filtered on caps
  assert.match(d.reason, /ocr, vision/);
});

test('selectNode: no nodes → explained refusal', () => {
  const d = selectNode([], { capabilities: ['ocr'] }, NOW, STALE);
  assert.equal(d.node, null);
  assert.match(d.reason, /no nodes registered/);
});

test('selectNode: all stale → refusal names the reason', () => {
  const stale = node({ id: 's', lastSeen: NOW - STALE - 1 });
  const d = selectNode([stale], { capabilities: ['ocr'] }, NOW, STALE);
  assert.equal(d.node, null);
  assert.match(d.reason, /no healthy nodes/);
});

test('selectNode: healthy but missing capability → capability refusal', () => {
  const n = node({ id: 'n', capabilities: ['ocr'] });
  const d = selectNode([n], { capabilities: ['whisper'] }, NOW, STALE);
  assert.equal(d.node, null);
  assert.match(d.reason, /required capabilities \[whisper\]/);
});

test('selectNode: empty requirement still returns the least-loaded healthy node', () => {
  const a = node({ id: 'a', load: 0.7 });
  const b = node({ id: 'b', load: 0.2 });
  const d = selectNode([a, b], {}, NOW, STALE);
  assert.equal(d.node.id, 'b');
});

test('selectNode is deterministic across input order', () => {
  const a = node({ id: 'a', load: 0.3 });
  const b = node({ id: 'b', load: 0.3, cpuCores: 32 });
  const one = selectNode([a, b], {}, NOW, STALE).node.id;
  const two = selectNode([b, a], {}, NOW, STALE).node.id;
  assert.equal(one, two);
  assert.equal(one, 'b'); // more CPU on the load tie
});

/* ---------- summary ---------- */
test('summarize tallies statuses and unions capabilities', () => {
  const s = summarize([
    node({ id: 'a', capabilities: ['ocr'] }),
    node({ id: 'b', health: 'down', capabilities: ['vision'] }),
    node({ id: 'c', lastSeen: NOW - STALE - 1 }),
  ], NOW, STALE);
  assert.equal(s.total, 3);
  assert.equal(s.healthy, 1);
  assert.equal(s.unhealthy, 1);
  assert.equal(s.stale, 1);
  assert.deepEqual(s.capabilities, ['ocr', 'vision']);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n   ${e.message}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} atlas core tests passed`);
if (passed !== tests.length) process.exitCode = 1;
