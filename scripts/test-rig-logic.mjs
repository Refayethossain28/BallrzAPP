#!/usr/bin/env node
/**
 * Unit tests for rig/engine.js — the pure proof-of-work mining engine
 * behind Rig (FIPS 180-4 SHA-256 cross-checked against node:crypto, real
 * 80-byte Bitcoin header serialization proven by recomputing the actual
 * Bitcoin genesis block hash, compact-bits target maths, deterministic
 * nonce scanning, local chains with halving rewards and clamped
 * retargeting, hashrate windows, vardiff share targets and the honest
 * reality-check maths).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-rig-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'rig', 'engine.js'), 'utf8'), sandbox, { filename: 'rig/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const nodeSha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/* ---------- bytes & hex ---------- */
test('hex round-trips and reverseHex flips byte order', () => {
  assert.equal(E.bytesToHex(E.hexToBytes('00ff10ab')), '00ff10ab');
  assert.equal(E.reverseHex('01020304'), '04030201');
  assert.equal(E.reverseHex(E.reverseHex('deadbeef00')), 'deadbeef00');
  assert.throws(() => E.hexToBytes('abc'));   // odd length
  assert.throws(() => E.hexToBytes('zz'));    // non-hex
});
test('utf8ToBytes matches Node for ascii, accents, CJK and emoji', () => {
  for (const s of ['', 'abc', 'café', '時間', 'mine ⛏️ 🚀', 'a\u0000b']) {
    assert.equal(E.bytesToHex(E.utf8ToBytes(s)), Buffer.from(s, 'utf8').toString('hex'), JSON.stringify(s));
  }
});

/* ---------- SHA-256: FIPS vectors + cross-check against node:crypto ---------- */
test('SHA-256 FIPS 180-4 vectors', () => {
  assert.equal(E.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(E.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(E.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});
test('SHA-256 agrees with node:crypto across lengths 0..200 (padding edges included)', () => {
  // deterministic pseudo-random bytes so the run is reproducible
  let seed = 0x12345678;
  const next = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed & 0xff; };
  for (let len = 0; len <= 200; len++) {
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = next();
    const mine = E.bytesToHex(E.sha256Bytes(buf)); // Buffer is Uint8Array-compatible cross-realm
    assert.equal(mine, nodeSha256(buf), `length ${len}`);
  }
});
test('double SHA-256 is sha256(sha256(x))', () => {
  const inner = createHash('sha256').update(Buffer.from('hello', 'utf8')).digest();
  assert.equal(E.sha256dHex('hello'), nodeSha256(inner));
});

/* ---------- the Bitcoin genesis block: the whole point ---------- */
test('serializeHeader produces the genesis block\'s exact 80 wire bytes', () => {
  const bytes = E.serializeHeader(E.GENESIS);
  assert.equal(bytes.length, 80);
  // the canonical raw genesis header, byte for byte
  assert.equal(E.bytesToHex(bytes),
    '01000000' + '0'.repeat(64) +
    '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' +
    '29ab5f49' + 'ffff001d' + '1dac2b7c');
});
test('headerHash recomputes the real Bitcoin genesis hash from raw bytes', () => {
  assert.equal(E.headerHash(E.GENESIS), '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  const v = E.verifyGenesis();
  assert.equal(v.ok, true);
  assert.equal(v.computed, v.expected);
});
test('the genesis hash meets its own compact-bits target', () => {
  assert.equal(E.hashMeetsTarget(E.GENESIS.hash, E.bitsToTarget(E.GENESIS.bits)), true);
});

/* ---------- targets, bits, difficulty ---------- */
test('bitsToTarget(0x1d00ffff) is the difficulty-1 target', () => {
  assert.equal(E.bytesToHex(E.bitsToTarget(0x1d00ffff)),
    '00000000ffff0000000000000000000000000000000000000000000000000000');
});
test('targetToBits round-trips real compact encodings', () => {
  for (const bits of [0x1d00ffff, 0x1b0404cb, 0x170355f0, 0x1c05a3f4]) {
    assert.equal(E.targetToBits(E.bitsToTarget(bits)) >>> 0, bits, '0x' + bits.toString(16));
  }
});
test('difficulty maths: diff-1 bits are difficulty 1, and known-block difficulty is right', () => {
  assert.equal(E.difficultyFromBits(0x1d00ffff), 1);
  // block 100,800-era bits 0x1b0404cb is the classic worked example: ~16,307
  const d = E.difficultyFromBits(0x1b0404cb);
  assert.ok(Math.abs(d - 16307.42) < 0.5, `got ${d}`);
});
test('targetFromDifficulty and targetFromExpectedHashes invert their reads', () => {
  const t = E.targetFromDifficulty(1000);
  const d = E.difficultyFromTarget(t);
  assert.ok(Math.abs(d - 1000) / 1000 < 1e-6, `got ${d}`);
  const h = E.expectedHashesForTarget(E.targetFromExpectedHashes(1e6));
  assert.ok(Math.abs(h - 1e6) / 1e6 < 1e-6, `got ${h}`);
});
test('hashMeetsTarget: below passes, equal passes, above fails', () => {
  const target = '00000000ffff0000000000000000000000000000000000000000000000000000';
  const t = E.bitsToTarget(0x1d00ffff);
  assert.equal(E.hashMeetsTarget('00000000fffe' + 'f'.repeat(52), t), true);
  assert.equal(E.hashMeetsTarget(target, t), true);
  assert.equal(E.hashMeetsTarget('0000000100000000' + '0'.repeat(48), t), false);
});
test('floatToTarget clamps: zero and overflow', () => {
  assert.equal(E.bytesToHex(E.floatToTarget(0)), '0'.repeat(64));
  assert.equal(E.bytesToHex(E.floatToTarget(Math.pow(2, 300))), 'f'.repeat(64));
});

/* ---------- mining: deterministic, and the finds are real ---------- */
const JOB_HEADER = {
  version: 2,
  prevHash: E.reverseHex(E.sha256dHex('rig-test-parent')),
  merkleRoot: E.reverseHex(E.sha256dHex('rig-test-merkle')),
  time: 1758240000, bits: 0x1d00ffff, nonce: 0
};
test('mineRange is deterministic and every reported find truly meets its target', () => {
  const share = E.targetFromExpectedHashes(256);   // easy: expect ~16 shares in 4096
  const block = E.targetFromExpectedHashes(2048);  // harder subset
  const a = E.mineRange(JOB_HEADER, 0, 4096, { share, block });
  const b = E.mineRange(JOB_HEADER, 0, 4096, { share, block });
  deepEq(a, b, 'same range twice must be identical');
  assert.equal(a.tried, 4096);
  assert.ok(a.shares.length > 0, 'easy target should yield shares');
  for (const s of a.shares) {
    assert.equal(E.headerHash({ ...JOB_HEADER, nonce: s.nonce }), s.hash, 'share hash re-verifies');
    assert.equal(E.hashMeetsTarget(s.hash, share), true);
    assert.equal(E.hashMeetsTarget(s.hash, block), false, 'block wins are not double-counted as shares');
  }
  for (const bl of a.blocks) assert.equal(E.hashMeetsTarget(bl.hash, block), true);
  // best is truly the minimum over the range
  let min = null;
  for (let n = 0; n < 4096; n++) {
    const h = E.headerHash({ ...JOB_HEADER, nonce: n });
    if (min === null || h < min) min = h;
  }
  assert.equal(a.best.hash, min);
});
test('mineRange wraps the nonce at 2^32 without losing determinism', () => {
  const r = E.mineRange(JOB_HEADER, 4294967294, 4, {});
  deepEq(r.last && { nonce: r.last.nonce }, { nonce: 1 });
  assert.equal(r.tried, 4);
});

/* ---------- coins, chains, rewards, retargeting ---------- */
const BLZ = E.coinById('blz');
test('coin catalog: btc is real-only, locals are minable', () => {
  assert.equal(E.coinById('btc').kind, 'real');
  for (const id of ['blz', 'nug', 'emb']) assert.equal(E.coinById(id).kind, 'local');
  assert.equal(E.coinById('nope'), null);
});
test('newChain is deterministic per coin', () => {
  deepEq(E.newChain(BLZ), E.newChain(BLZ));
  assert.equal(E.newChain(BLZ).height, 0);
  assert.equal(E.newChain(BLZ).expectedHashes, BLZ.startHashes);
  assert.notEqual(E.newChain(BLZ).tipHash, E.newChain(E.coinById('nug')).tipHash);
});
test('rewardAt halves on schedule and hard-caps at zero', () => {
  assert.equal(E.rewardAt(BLZ, 1), 50);
  assert.equal(E.rewardAt(BLZ, BLZ.halvingEvery), 25);
  assert.equal(E.rewardAt(BLZ, BLZ.halvingEvery * 2), 12.5);
  assert.equal(E.rewardAt(BLZ, BLZ.halvingEvery * 40), 0, 'subsidy ends below one smallest unit');
});
test('sealBlock advances the tip to the found hash and credits the reward', () => {
  const chain = E.newChain(BLZ);
  const found = { nonce: 7, hash: '00' + 'ab'.repeat(31) };
  const r = E.sealBlock(BLZ, chain, found, 1758240000);
  assert.equal(r.chain.height, 1);
  assert.equal(r.chain.tipHash, found.hash);
  assert.equal(r.reward, 50);
  assert.equal(r.chain.minedTotal, 50);
  assert.equal(r.retargeted, null);
});
test('retarget: fast blocks raise expectedHashes, clamped ×4, window resets', () => {
  let chain = E.newChain(BLZ);
  // 10 blocks 1 second apart — 20× too fast, so the clamp must hold at ×4
  for (let i = 0; i < BLZ.retargetEvery; i++) {
    const r = E.sealBlock(BLZ, chain, { nonce: i, hash: E.sha256dHex('b' + i) }, 1758240000 + i);
    chain = r.chain;
    if (i < BLZ.retargetEvery - 1) assert.equal(r.retargeted, null);
    else {
      assert.equal(r.retargeted.from, BLZ.startHashes);
      assert.equal(r.retargeted.to, BLZ.startHashes * 4, 'clamped at ×4');
    }
  }
  assert.equal(chain.expectedHashes, BLZ.startHashes * 4);
  deepEq(chain.windowTimes, []);
});
test('retarget: slow blocks lower expectedHashes with a floor', () => {
  let chain = E.newChain(BLZ);
  chain = { ...chain, expectedHashes: 8192 };
  for (let i = 0; i < BLZ.retargetEvery; i++) {
    chain = E.sealBlock(BLZ, chain, { nonce: i, hash: E.sha256dHex('s' + i) }, 1758240000 + i * BLZ.blockSeconds * 10).chain;
  }
  assert.equal(chain.expectedHashes, 4096, 'floor holds under the ×0.25 clamp');
});

/* ---------- jobs & vardiff ---------- */
const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
test('buildJob: local job chains off the tip, is deterministic, target matches chain difficulty', () => {
  const chain = E.newChain(BLZ);
  const a = E.buildJob(BLZ, chain, 'rafa', NOW);
  const b = E.buildJob(BLZ, chain, 'rafa', NOW);
  deepEq(a, b);
  assert.equal(a.header.prevHash, chain.tipHash);
  assert.equal(a.height, 1);
  const h = E.expectedHashesForTarget(a.blockTarget);
  assert.ok(Math.abs(h - chain.expectedHashes) / chain.expectedHashes < 1e-4); // compact-bits quantization
  deepEq(Array.from(a.blockTarget), Array.from(E.bitsToTarget(a.header.bits)),
    'a sealed block must meet the target its own header bits declare');
  const c = E.buildJob(BLZ, chain, 'other', NOW);
  assert.notEqual(c.header.merkleRoot, a.header.merkleRoot, 'merkle commits to the miner tag');
});
test('buildJob: btc practice job uses the real network difficulty and version bits', () => {
  const btc = E.coinById('btc');
  const j = E.buildJob(btc, null, 'rafa', NOW);
  assert.equal(j.height, null);
  assert.equal(j.header.version, 0x20000000);
  const d = E.difficultyFromTarget(j.blockTarget);
  assert.ok(Math.abs(d - btc.networkDifficulty) / btc.networkDifficulty < 1e-3, `got ${d}`);
  deepEq(Array.from(j.blockTarget), Array.from(E.bitsToTarget(j.header.bits)),
    'practice target is exactly what the header bits encode');
});
test('vardiff share sizing: tracks hashrate, clamped both ends, never harder than the block', () => {
  assert.equal(E.shareHashesFor(100000, 6), 600000);
  assert.equal(E.shareHashesFor(0, 6), 60000, 'idle default 10 kH/s × period');
  assert.equal(E.shareHashesFor(1, 6), 32768, 'floor');
  assert.equal(E.shareHashesFor(1e12, 6), 2147483648, 'ceiling');
  const blockT = E.targetFromExpectedHashes(50000); // easier than the share target below
  const t = E.shareTargetFor(1e6, 6, blockT);
  deepEq(Array.from(t), Array.from(blockT), 'share target relaxes to the block target');
});

/* ---------- hashrate windows ---------- */
test('hashrateOf averages the window and prunes stale samples', () => {
  const samples = [
    { t: NOW - 12000, n: 999999 }, // stale, outside the 10 s window
    { t: NOW - 8000, n: 800000 },
    { t: NOW - 4000, n: 800000 },
    { t: NOW, n: 800000 }
  ];
  assert.equal(E.pruneSamples(samples, NOW, 10000).length, 3);
  const h = E.hashrateOf(samples, NOW, 10000);
  assert.ok(Math.abs(h - 300000) < 1, `2.4M hashes over 8 s = 300 kH/s, got ${h}`);
  assert.equal(E.hashrateOf([], NOW, 10000), 0);
});

/* ---------- the honest maths ---------- */
test('expectedSecondsToBlock: difficulty 1 at 2^32 H/s is one second', () => {
  assert.equal(E.expectedSecondsToBlock(1, Math.pow(2, 32)), 1);
  assert.equal(E.expectedSecondsToBlock(5, 0), Infinity);
});
test('btcReality: a phone-grade hashrate means universe-scale waiting, stated plainly', () => {
  const r = E.btcReality(200000, 1.25e14); // 200 kH/s vs the real network
  assert.ok(r.networkHashrate > 8e20, 'network is ~10^21 H/s');
  assert.ok(r.yourShare < 1e-15, 'your slice is beyond negligible');
  assert.ok(r.yearsToBlock > 1e10, 'tens of billions of years');
  assert.ok(r.universeAges > 5, 'several universe-ages');
  assert.match(r.verdict, /ASIC/);
  assert.equal(E.btcReality(0, 1.25e14).yourShare, 0);
});

/* ---------- formatters ---------- */
test('formatHashrate scales units', () => {
  assert.equal(E.formatHashrate(0), '0 H/s');
  assert.equal(E.formatHashrate(950), '950 H/s');
  assert.equal(E.formatHashrate(123456), '123 kH/s');
  assert.equal(E.formatHashrate(2500000), '2.5 MH/s');
  assert.equal(E.formatHashrate(9e20), '900 EH/s');
});
test('formatDuration is honest at every scale', () => {
  assert.equal(E.formatDuration(30), '30 seconds');
  assert.equal(E.formatDuration(600), '10 minutes');
  assert.equal(E.formatDuration(7200), '2 hours');
  assert.equal(E.formatDuration(86400 * 3), '3 days');
  assert.equal(E.formatDuration(86400 * 365.25 * 2), 'about 2 years');
  assert.match(E.formatDuration(4.1e4 * 365.25 * 86400), /41 thousand years/);
  assert.match(E.formatDuration(3.2e13 * 365.25 * 86400), /32 trillion years/);
  assert.match(E.formatDuration(1e19 * 365.25 * 86400), /10\^19 years/);
  assert.equal(E.formatDuration(Infinity), 'forever (no hashrate yet)');
});
test('formatAmount / formatInt / formatDifficulty', () => {
  assert.equal(E.formatAmount(1234.5, 2), '1,234.50');
  assert.equal(E.formatAmount(0, 8), '0.00000000');
  assert.equal(E.formatInt(1234567), '1,234,567');
  assert.equal(E.formatDifficulty(1.25e14), '125 T');
  assert.equal(E.formatDifficulty(16307.42), '16.31 k');
});
test('escapeHTML and leadingZeroes', () => {
  assert.equal(E.escapeHTML('<b x="1">&\'</b>'), '&lt;b x=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;');
  assert.equal(E.leadingZeroes('000abc'), 3);
  assert.equal(E.leadingZeroes('abc'), 0);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
