#!/usr/bin/env node
/**
 * Cross-implementation tests: mine a chain with the JavaScript engine, then
 * make the INDEPENDENT Python validator (cortex/validator.py — zero shared
 * code) re-validate it from scratch: hashes, signatures, the neural network's
 * recomputed loss, the emission schedule, coinbase payouts, transfers and the
 * ledger. Then hand it tampered chains and expect precise rejections. Two
 * implementations agreeing is what makes the consensus rules the spec, not
 * one engine's quirks. Requires python3. Run: node scripts/test-cortex-pyvalidator.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const box = { module: { exports: {} } }; box.self = box; vm.createContext(box);
const load = (p, g) => { box.module = { exports: {} }; vm.runInContext(readFileSync(join(ROOT, p), 'utf8'), box, { filename: p }); if (g) box[g] = box.module.exports; return box.module.exports; };
const C = load('coin/engine.js', 'BallrzCoin');
load('cortex/datasets.js', 'BallrzCortexData');
const X = load('cortex/engine.js', 'BallrzCortex');

const alice = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001');
const bob = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000002');
const carol = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000003');

// A small-but-real task: the REAL war dataset, a scheduled emission, payouts.
const TASK_OPTS = {
  id: 'pyval', dataset: 'war', layers: [8],
  minImprovement: 0.0001, rewardPerLoss: 1e9,
  schedule: { startAt: 1000000, halfLifeMs: 3600e3, budget: 0.2, minIntervalMs: 1000 },
};
const GENESIS_SEED = 'g';
const DIR = mkdtempSync(join(tmpdir(), 'cortex-pyval-'));

function pyValidate(blocks) {
  const file = join(DIR, `snap-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ taskId: TASK_OPTS.id, blocks }));
  try {
    const out = execFileSync('python3', [join(ROOT, 'cortex/validator.py'), file, '--genesis-seed', GENESIS_SEED, '--task-json', JSON.stringify(TASK_OPTS)], { encoding: 'utf8' });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

// Build the reference chain once: two blocks, a payout, and a transfer.
const task = X.makeTask(TASK_OPTS);
const chain = new X.Chain(task, { genesisSeed: GENESIS_SEED });
const t1 = 1000000 + Math.round(3600e3 / 4);
const b1 = chain.mineBlock({ privKey: alice.privateKey, payTo: bob.address, steps: 400, at: t1, nonce: 'p0' });
assert.ok(b1, 'block 1 mines (alice rig, paying bob)');
chain.addBlock(b1);
const pay = X.signTransfer({ privKey: bob.privateKey, to: carol.address, amount: Math.floor(chain.balanceOf(bob.address) / 3), at: 5, nonce: 'n1' });
const t2 = 1000000 + Math.round(3600e3 / 2);
const b2 = chain.mineBlock({ privKey: alice.privateKey, payTo: alice.address, steps: 400, at: t2, nonce: 'p1', txs: [pay] });
assert.ok(b2, 'block 2 mines (with a transfer)');
chain.addBlock(b2);

let n = 0; const tests = []; const test = (name, fn) => tests.push([name, fn]);

test('the Python validator accepts the JS-mined chain and agrees on every balance', () => {
  const r = pyValidate(chain.blocks);
  assert.ok(r.ok, 'python says VALID:\n' + r.out);
  assert.match(r.out, /VALID: 2 block/);
  const supply = chain.totalSupply();
  assert.match(r.out, new RegExp('total supply ' + supply + ' base units'), 'supplies agree exactly');
  for (const w of [alice, bob, carol]) {
    const bal = chain.balanceOf(w.address);
    if (bal > 0) assert.match(r.out, new RegExp(w.address.slice(0, 12) + '.*' + (bal / 1e6).toFixed(6)), 'balance of ' + w.address.slice(0, 8));
  }
});

test('a bumped reward is rejected as wrong block reward', () => {
  const blocks = JSON.parse(JSON.stringify(chain.blocks));
  blocks[1].reward += 1;
  blocks[1].hash = X.blockHash(blocks[1]);
  const r = pyValidate(blocks);
  assert.equal(r.ok, false);
  assert.match(r.out, /wrong block reward/);
});

test('a flipped weight is rejected as a weights-hash mismatch', () => {
  const blocks = JSON.parse(JSON.stringify(chain.blocks));
  blocks[2].weights[0] += 0.000001;
  const r = pyValidate(blocks);
  assert.equal(r.ok, false);
  assert.match(r.out, /weights hash mismatch/);
});

test('a redirected payout is rejected as a bad signature', () => {
  const blocks = JSON.parse(JSON.stringify(chain.blocks));
  blocks[1].miner = carol.address;
  blocks[1].hash = X.blockHash(blocks[1]);
  const r = pyValidate(blocks);
  assert.equal(r.ok, false);
  assert.match(r.out, /bad signature/);
});

test('a block mined outside the emission schedule is rejected', () => {
  // A twin task WITHOUT the schedule mines an over-eager block; the validator,
  // enforcing the schedule, must refuse it.
  const twin = X.makeTask({ id: 'pyval', dataset: 'war', layers: [8], minImprovement: 0.0001, rewardPerLoss: 1e9 });
  const cheat = new X.Chain(twin, { genesisSeed: GENESIS_SEED });
  const blk = cheat.mineBlock({ privKey: alice.privateKey, steps: 400, at: 1000000 + 1001, nonce: 'c0', maxRounds: 40 });
  assert.ok(blk, 'twin mines without schedule limits');
  const r = pyValidate([cheat.blocks[0], blk]);
  assert.equal(r.ok, false);
  assert.match(r.out, /ahead of schedule/);
});

test('a tampered genesis is rejected (weights must derive from the seed)', () => {
  const blocks = JSON.parse(JSON.stringify(chain.blocks));
  blocks[0].weights[3] += 0.000001;
  const r = pyValidate(blocks);
  assert.equal(r.ok, false);
  assert.match(r.out, /genesis/);
});

// ---- runner ----------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); n++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
}
console.log(`\n${n}/${tests.length} cortex python-validator tests passed`);
if (failed) process.exit(1);
