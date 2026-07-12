#!/usr/bin/env node
/**
 * Tests for cortex/node.mjs — the deployable headless node: it mines against a
 * real relay, gossips to a peer, persists its chain to disk, and restores from
 * that file across a restart (encrypted-keyfile path included). Boots the real
 * relay on an ephemeral port. Run: node scripts/test-cortex-node.mjs
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createCortexRelay } from '../cortex/server.mjs';
import { bootNode } from '../cortex/node.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'cortex-node-'));

async function boot() {
  const server = createCortexRelay({ rateCapacity: 1000 });
  await new Promise((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

test('two deployed nodes mine, gossip, and persist over a real relay', async () => {
  const { base, close } = await boot();
  try {
    const aFile = join(TMP, 'a.json'), bFile = join(TMP, 'b.json');
    const A = bootNode({ relay: base, dataFile: aFile, taskId: 't1', fetch, id: 'A' });
    const B = bootNode({ relay: base, dataFile: bFile, taskId: 't1', fetch, id: 'B' });

    const blk = A.mine({ steps: 300 });
    assert.ok(blk, 'A mined a block');
    assert.ok(existsSync(aFile), 'A persisted its chain to disk');
    assert.ok(A.node.chain.balanceOf(A.wallet.address) > 0, 'A earned MIND');

    await new Promise((r) => setTimeout(r, 20));
    await B.poll();
    assert.equal(B.node.chain.height(), 1, 'B received A\'s block via the relay');
    assert.equal(B.node.chain.tip().hash, A.node.chain.tip().hash, 'same tip');
    B.save();

    // Restart B from its data file — the chain survives.
    const B2 = bootNode({ relay: base, dataFile: bFile, taskId: 't1', fetch, id: 'B' });
    assert.equal(B2.node.chain.height(), 1, 'B restored its chain from disk');
    assert.equal(B2.node.chain.tip().hash, A.node.chain.tip().hash);
  } finally { await close(); }
});

test('a node generates and reloads an ENCRYPTED keyfile (no plaintext key on disk)', async () => {
  const keyFile = join(TMP, 'wallet.json');
  const first = bootNode({ dataFile: join(TMP, 'c.json'), taskId: 't2', keyFile, passphrase: 'pw', id: 'C' });
  assert.ok(existsSync(keyFile), 'keyfile written');
  const raw = readFileSync(keyFile, 'utf8');
  assert.ok(!raw.includes(first.wallet.privateKey), 'the plaintext private key is NOT on disk');
  assert.match(raw, /"mac"/, 'it is an encrypted key box');
  // reloading with the passphrase restores the same wallet
  const again = bootNode({ dataFile: join(TMP, 'c2.json'), taskId: 't2', keyFile, passphrase: 'pw', id: 'C' });
  assert.equal(again.wallet.address, first.wallet.address, 'same wallet restored from the encrypted keyfile');
  // wrong passphrase is rejected
  assert.throws(() => bootNode({ taskId: 't2', keyFile, passphrase: 'WRONG' }), /wrong passphrase|corrupted/);
});

test('a data file for a different task is refused (no silent cross-task load)', async () => {
  const f = join(TMP, 'x.json');
  const h = bootNode({ dataFile: f, taskId: 'taskA', id: 'X' });
  h.node.mineAndBroadcast({ privKey: h.wallet.privateKey, steps: 200, nonce: 'x0' }); h.save();
  assert.throws(() => bootNode({ dataFile: f, taskId: 'taskB', id: 'X' }), /data file is for task/);
});

// ---- runner ----------------------------------------------------------------
const run = async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`ok - ${name}`); }
    catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
  }
  console.log(`\n${passed}/${tests.length} cortex node tests passed`);
  process.exit(failed ? 1 : 0);
};
run();
