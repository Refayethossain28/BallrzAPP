#!/usr/bin/env node
/**
 * Unit tests for beam/engine.js — the pure protocol engine behind Beam,
 * file transfer by animated QR code: base45 (RFC 9285), CRC-32, the
 * stream/manifest container, chunking, the Luby-Transform fountain code
 * with its robust soliton degree distribution, the fixed-width frame
 * codec, the peeling decoder (lossless, 30 % loss, late joiner, duplicates,
 * tid switch, corruption), the manifest peek, and planning/ETA/formatters.
 * Loaded in a vm sandbox (repo is type:module). No wall clock, fixed seeds.
 * Run: node scripts/test-beam-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'beam', 'engine.js'), 'utf8'), sandbox, { filename: 'beam/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const bytesEq = (a, b, m) => deepEq(Array.from(a), Array.from(b), m);
const u8 = (s) => E.utf8Encode(s);
const ALNUM_RE = /^[0-9A-Z $%*+\-.\/:]+$/;

/** Seeded pseudo-random bytes (the engine's own rng, so no Math.random anywhere). */
function randomBytes(n, seed) {
  const r = E.rng(seed), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(r() * 256);
  return out;
}
/** A ready-to-beam transfer: bytes → stream → context. */
function transfer(bytes, chunkBytes, meta = {}) {
  const built = E.buildStream(bytes, { name: 'file.bin', type: 'application/octet-stream', ...meta });
  const ctx = E.makeContext(built.stream, chunkBytes);
  return { bytes, built, ctx, K: ctx.K };
}
const frameAt = (ctx, seq) => E.parseFrame(E.encodeFrame(ctx, seq));

/* ---------- base45 (RFC 9285) ---------- */
test('base45Encode matches the four RFC 9285 vectors', () => {
  assert.equal(E.base45Encode(u8('AB')), 'BB8');
  assert.equal(E.base45Encode(u8('Hello!!')), '%69 VD92EX0');
  assert.equal(E.base45Encode(u8('base-45')), 'UJCLQE7W581');
  assert.equal(E.base45Encode(u8('ietf!')), 'QED8WEX0');
});
test('base45Decode inverts the vectors', () => {
  assert.equal(E.utf8Decode(E.base45Decode('BB8')), 'AB');
  assert.equal(E.utf8Decode(E.base45Decode('%69 VD92EX0')), 'Hello!!');
  assert.equal(E.utf8Decode(E.base45Decode('UJCLQE7W581')), 'base-45');
  assert.equal(E.utf8Decode(E.base45Decode('QED8WEX0')), 'ietf!');
});
test('base45 round-trips odd lengths, even lengths, all byte values and empty', () => {
  for (const n of [0, 1, 2, 3, 7, 8, 255, 256, 1001]) {
    const b = randomBytes(n, 100 + n);
    const s = E.base45Encode(b);
    assert.equal(s.length, Math.floor(n / 2) * 3 + (n % 2 ? 2 : 0), `length for ${n} bytes`);
    assert.ok(s === '' || ALNUM_RE.test(s), 'alphabet');
    bytesEq(E.base45Decode(s), b, `round trip ${n}`);
  }
  const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;
  bytesEq(E.base45Decode(E.base45Encode(all)), all);
  assert.equal(E.base45Encode(new Uint8Array(0)), '');
  assert.equal(E.base45Decode('').length, 0);
});
test('base45Decode rejects bad characters, bad lengths and out-of-range values', () => {
  assert.throws(() => E.base45Decode('bb8'), /bad character/);
  assert.throws(() => E.base45Decode('BB8!'), /bad character|bad length/);
  assert.throws(() => E.base45Decode('B'), /bad length/);
  assert.throws(() => E.base45Decode('BB8A'), /bad length/);
  assert.throws(() => E.base45Decode('GGW'), /out of range/, '65536 does not fit two bytes');
  assert.throws(() => E.base45Decode('::'), /out of range/, 'pair > 255');
  assert.throws(() => E.base45Decode('::::::'), /out of range/);
});

/* ---------- CRC-32, hashing, rng, base36 ---------- */
test('crc32: IEEE check value, hex form, empty input', () => {
  assert.equal(E.crc32(u8('123456789')), 0xCBF43926);
  assert.equal(E.crc32Hex(u8('123456789')), 'cbf43926');
  assert.equal(E.crc32(new Uint8Array(0)), 0);
  assert.equal(E.crc32Hex(new Uint8Array(0)), '00000000');
  assert.equal(E.crc32Hex(u8('a')), 'e8b7be43');
});
test('hashStr is FNV-1a and rng is deterministic in [0,1)', () => {
  assert.equal(E.hashStr(''), 0x811c9dc5);
  assert.equal(E.hashStr('a'), 0xe40c292c);
  assert.equal(E.hashStr('beam:10:12'), E.hashStr('beam:10:12'));
  assert.notEqual(E.hashStr('beam:10:12'), E.hashStr('beam:10:13'));
  const a = E.rng(42), b = E.rng(42);
  const seqA = Array.from({ length: 50 }, () => a());
  const seqB = Array.from({ length: 50 }, () => b());
  deepEq(seqA, seqB);
  assert.ok(seqA.every((x) => x >= 0 && x < 1));
  assert.ok(new Set(seqA).size > 45, 'spread');
});
test('base36 helpers: uppercase, zero-padded, strict', () => {
  assert.equal(E.toBase36(0, 4), '0000');
  assert.equal(E.toBase36(35, 4), '000Z');
  assert.equal(E.toBase36(36, 4), '0010');
  assert.equal(E.toBase36(E.K_MAX, 4), 'ZZZZ');
  assert.equal(E.fromBase36('ZZZZZ'), E.SEQ_MAX);
  assert.equal(E.K_MAX, 1679615);
  for (const n of [0, 1, 35, 36, 1295, 1296, 46655, 46656, 1679615]) assert.equal(E.fromBase36(E.toBase36(n, 5)), n);
  assert.throws(() => E.toBase36(1679616, 4), /fit/);
  assert.throws(() => E.toBase36(-1, 4));
  assert.throws(() => E.fromBase36('zz'), /bad digits/);
  assert.throws(() => E.fromBase36('0 1'), /bad digits/);
});

/* ---------- utf8 ---------- */
test('utf8Encode/Decode round-trip ASCII, accents, CJK, emoji; invalid bytes become U+FFFD', () => {
  for (const s of ['', 'plain', 'héllo wörld', '日本語', '🌸 beam ☃ 🇯🇵', 'a\u0000b']) assert.equal(E.utf8Decode(E.utf8Encode(s)), s);
  bytesEq(E.utf8Encode('€'), [0xe2, 0x82, 0xac]);
  assert.equal(E.utf8Decode(new Uint8Array([0xff, 0x41])), '\ufffdA');
  assert.equal(E.utf8Decode(new Uint8Array([0xe2, 0x82])), '\ufffd\ufffd', 'truncated sequence');
});

/* ---------- stream & manifest ---------- */
test('buildStream/parseStream round trip with a unicode name', () => {
  const bytes = u8('the quick brown 🦊');
  const { stream, manifest, tid } = E.buildStream(bytes, { name: 'résumé 日本.txt', type: 'text/plain', originalSize: bytes.length });
  assert.equal(tid.length, 6);
  assert.ok(ALNUM_RE.test(tid));
  assert.equal(stream.length, 2 + ((stream[0] << 8) | stream[1]) + bytes.length);
  assert.equal(manifest.v, 1);
  assert.equal(manifest.n, 'résumé 日本.txt');
  assert.equal(manifest.t, 'text/plain');
  assert.equal(manifest.s, bytes.length);
  assert.equal(manifest.b, bytes.length);
  assert.equal(manifest.z, 0);
  assert.equal(manifest.h, E.crc32Hex(bytes));
  const parsed = E.parseStream(stream);
  deepEq(parsed.manifest, manifest);
  bytesEq(parsed.fileBytes, bytes);
  assert.equal(E.streamLength(stream), stream.length);
  assert.equal(E.utf8Decode(parsed.fileBytes), 'the quick brown 🦊');
});
test('buildStream: empty file, empty type, compressed flag with original crc', () => {
  const empty = E.buildStream(new Uint8Array(0), { name: 'nothing', type: '' });
  assert.equal(empty.manifest.b, 0);
  assert.equal(empty.manifest.t, '');
  assert.equal(E.parseStream(empty.stream).fileBytes.length, 0);
  assert.equal(E.streamLength(empty.stream), empty.stream.length);
  const z = E.buildStream(u8('deflated-ish'), { name: 'big.txt', type: 'text/plain', originalSize: 5000, compressed: true, originalCrcHex: 'deadbeef' });
  assert.equal(z.manifest.z, 1);
  assert.equal(z.manifest.s, 5000);
  assert.equal(z.manifest.h, 'deadbeef');
  assert.throws(() => E.buildStream(u8('x'), { name: 'a', compressed: true }), /originalCrcHex/);
});
test('parseStream: padded reassembly is trimmed by streamLength; garbage throws human messages', () => {
  const { stream } = E.buildStream(u8('hello'), { name: 'h.txt', type: 'text/plain' });
  const padded = new Uint8Array(stream.length + 13); padded.set(stream);
  assert.equal(E.streamLength(padded), stream.length);
  bytesEq(E.parseStream(padded).fileBytes, u8('hello'));
  assert.throws(() => E.parseStream(padded, stream.length + 1), /mismatch/);
  assert.throws(() => E.parseStream(new Uint8Array([0])), /short/);
  assert.throws(() => E.parseStream(new Uint8Array([0, 5, 65, 66])), /cut off/);
  assert.throws(() => E.parseStream(new Uint8Array([0, 2, 65, 66])), /JSON/);
  const v2 = u8('{"v":2,"b":0}');
  assert.throws(() => E.parseStream(new Uint8Array([0, v2.length, ...v2])), /version/);
  const big = u8('{"v":1,"b":99,"n":"x"}');
  assert.throws(() => E.parseStream(new Uint8Array([0, big.length, ...big])), /cut off/);
  assert.equal(E.parseStream(stream).manifest.n, 'h.txt');
});
test('safeFileName strips separators and control chars, trims, truncates, falls back', () => {
  assert.equal(E.safeFileName('  ../../etc/passwd  '), 'etcpasswd');
  assert.equal(E.safeFileName('C:\\Users\\x\\photo.jpg'), 'C:Usersxphoto.jpg');
  assert.equal(E.safeFileName('a\u0000b\u001fc\n.txt'), 'abc.txt');
  assert.equal(E.safeFileName(''), 'beam-file');
  assert.equal(E.safeFileName(null), 'beam-file');
  assert.equal(E.safeFileName('...'), 'beam-file');
  assert.equal(E.safeFileName('Été 2026 🌸.png'), 'Été 2026 🌸.png');
  assert.ok(E.safeFileName('x'.repeat(500)).length <= E.MAX_NAME);
  assert.equal(E.MAX_NAME, 180);
  assert.equal(E.safeFileName('y'.repeat(179) + '🌸').length, 179, 'never leaves a dangling surrogate');
});
test('safeFileName strips Unicode direction/format controls so a name cannot disguise its extension', () => {
  assert.equal(E.safeFileName('invoice\u202egnp.exe'), 'invoicegnp.exe', 'RLO (U+202E) removed');
  for (const cp of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]) {
    const out = E.safeFileName('a' + String.fromCharCode(cp) + 'b.txt');
    assert.equal(out, 'ab.txt', `U+${cp.toString(16)} stripped`);
  }
  assert.equal(E.safeFileName('\u202e\u202e'), 'beam-file', 'nothing but controls falls back');
  // legitimate joiners and scripts survive: ZWJ emoji sequences, Persian ZWNJ, RTL text itself
  assert.equal(E.safeFileName('👨\u200d💻.png'), '👨\u200d💻.png');
  assert.equal(E.safeFileName('می\u200cخواهم.txt'), 'می\u200cخواهم.txt');
  assert.equal(E.safeFileName('שלום.pdf'), 'שלום.pdf');
  // and the sanitised name is what travels in the manifest
  const built = E.buildStream(u8('x'), { name: 'invoice\u202egnp.exe', type: 'application/octet-stream' });
  assert.equal(built.manifest.n, 'invoicegnp.exe');
  assert.equal(E.parseStream(built.stream).manifest.n, 'invoicegnp.exe');
});

/* ---------- chunking & capacity ---------- */
test('chunkBytesFor: even, derived from alnum capacity, throws when too small', () => {
  assert.equal(E.HEADER_LEN, 23);
  assert.equal(E.chunkBytesFor(1249), 816, 'v20-L alnum capacity');
  assert.equal(E.chunkBytesFor(395), 248, 'v10-L');
  assert.equal(E.chunkBytesFor(26), 2);
  assert.equal(E.chunkBytesFor(28), 2);
  assert.equal(E.chunkBytesFor(29), 4);
  for (const c of [100, 395, 758, 1249, 1853, 2520, 4296]) assert.equal(E.chunkBytesFor(c) % 2, 0);
  assert.throws(() => E.chunkBytesFor(25), /too small/);
  assert.throws(() => E.chunkBytesFor(0));
});
test('chunkCount and chunkAt with zero padding', () => {
  assert.equal(E.chunkCount(0, 10), 1);
  assert.equal(E.chunkCount(10, 10), 1);
  assert.equal(E.chunkCount(11, 10), 2);
  assert.equal(E.chunkCount(1000, 816), 2);
  const s = new Uint8Array([1, 2, 3, 4, 5]);
  bytesEq(E.chunkAt(s, 0, 4), [1, 2, 3, 4]);
  bytesEq(E.chunkAt(s, 1, 4), [5, 0, 0, 0]);
  bytesEq(E.chunkAt(s, 7, 4), [0, 0, 0, 0]);
  assert.equal(E.chunkAt(s, 0, 4).length, 4);
});
test('PRESETS and fps constants match the contract', () => {
  deepEq(E.PRESETS.map((p) => [p.id, p.version, p.ec]), [['s', 10, 'L'], ['m', 15, 'L'], ['l', 20, 'L'], ['xl', 25, 'L'], ['max', 30, 'L']]);
  assert.ok(E.PRESETS.every((p) => p.label && p.hint));
  assert.equal(E.DEFAULT_PRESET, 'l');
  assert.equal(E.FPS_MIN, 2); assert.equal(E.FPS_MAX, 20); assert.equal(E.FPS_DEFAULT, 8);
});

/* ---------- fountain code ---------- */
test('solitonTable: cumulative, length K+1, starts at 0, ends at 1, degree-1 mass > 0, memoised', () => {
  for (const K of [1, 2, 3, 7, 50, 100, 1000, 5000]) {
    const t = E.solitonTable(K);
    assert.equal(t.length, K + 1, `len K=${K}`);
    assert.equal(t[0], 0);
    assert.equal(t[K], 1);
    assert.ok(t[1] > 0, `degree-1 mass K=${K}`);
    for (let d = 1; d <= K; d++) assert.ok(t[d] >= t[d - 1] && t[d] <= 1 + 1e-12, `monotone K=${K} d=${d}`);
    if (K >= 50) assert.ok(1 - t[K - 1] <= 1 / (K * (K - 1)) + 1e-12, `top degree carries only its ideal-soliton mass K=${K}`);
    assert.equal(E.solitonTable(K), t, 'memoised');
  }
  deepEq(E.solitonTable(1), [0, 1]);
  const t100 = E.solitonTable(100);
  assert.ok(t100[1] > 0.03 && t100[1] < 0.08, `K=100 degree-1 ≈ 4.8 %, got ${t100[1]}`);
  assert.ok(t100[2] - t100[1] > 0.3, 'degree 2 dominates (ideal soliton 1/2)');
  // reference values pin the arithmetic (both phones must build the identical table)
  assert.equal(E.solitonTable(100)[1], 0.04817779432295241);
  assert.equal(E.solitonTable(1000)[7], 0.7696681389197401);
});
test('solitonTable memo is single-entry: a table for another K releases the previous one', () => {
  // A per-K map would let a hostile screen pin ~13 MB per distinct K forever (parseFrame accepts any
  // K ≤ K_MAX and tid/K sit outside the payload CRC). Each side only ever works on one K at a time.
  const t50 = E.solitonTable(50);
  assert.equal(E.solitonTable(50), t50, 'same K → same table');
  const t60 = E.solitonTable(60);
  assert.equal(E.solitonTable(60), t60);
  assert.notEqual(E.solitonTable(50), t50, 'the K=50 table was dropped when K=60 was built');
  deepEq(E.solitonTable(50), t50, 'but it is rebuilt identically');
});
test('frameNeighbors samples degrees from the soliton table (degree-1 share and CDF track solitonTable)', () => {
  // Nothing else ties the sampler to the table: an encoder that never emits degree-1 coded frames
  // would pass every other suite and strand late joiners on files above GE_MAX_UNKNOWN chunks.
  const N = 2000;
  for (const K of [10, 100, 1000]) {
    const t = E.solitonTable(K), hist = new Map();
    // protocol 2 alternates soliton (even j) and dense (odd j) repair frames: sample the soliton ones
    for (let seq = K; seq < K + 2 * N; seq += 2) { const d = E.frameNeighbors(seq, K).length; hist.set(d, (hist.get(d) || 0) + 1); }
    const share1 = (hist.get(1) || 0) / N;
    assert.ok(share1 > 0, `K=${K}: some coded frames must have degree 1`);
    assert.ok(share1 > 0.5 * t[1] && share1 < 1.5 * t[1], `K=${K}: degree-1 share ${share1.toFixed(4)} vs table ${t[1].toFixed(4)}`);
    let acc = 0;
    for (let d = 1; d <= Math.min(K, 8); d++) {
      acc += (hist.get(d) || 0) / N;
      assert.ok(Math.abs(acc - t[d]) < 0.03, `K=${K}: empirical P(degree ≤ ${d}) = ${acc.toFixed(3)} vs table ${t[d].toFixed(3)}`);
    }
    assert.ok(hist.get(2) / N > 0.3, `K=${K}: degree 2 dominates`);
  }
});
test('frameNeighbors: systematic prefix is the identity', () => {
  for (const K of [1, 5, 100]) for (let s = 0; s < K; s++) deepEq(E.frameNeighbors(s, K), [s]);
});
test('frameNeighbors: coded frames are deterministic, in range, distinct, sorted; K=1 always [0]', () => {
  for (const K of [1, 2, 3, 10, 100, 1000]) {
    let degreeSum = 0, maxDeg = 0;
    for (let seq = K; seq < K + 300; seq++) {
      const n = E.frameNeighbors(seq, K);
      deepEq(E.frameNeighbors(seq, K), n, 'deterministic');
      assert.ok(n.length >= 1 && n.length <= K, `degree K=${K} seq=${seq}`);
      for (let i = 0; i < n.length; i++) {
        assert.ok(Number.isInteger(n[i]) && n[i] >= 0 && n[i] < K, 'in range');
        if (i) assert.ok(n[i] > n[i - 1], 'strictly ascending → distinct & sorted');
      }
      degreeSum += n.length; maxDeg = Math.max(maxDeg, n.length);
      if (K === 1) deepEq(n, [0]);
    }
    if (K >= 10) assert.ok(maxDeg > 1 && degreeSum / 300 > 1.5, `mix of degrees for K=${K}`);
  }
  deepEq(E.frameNeighbors(10, 10), E.frameNeighbors(10, 10));
  assert.notEqual(JSON.stringify(E.frameNeighbors(10, 10)) + JSON.stringify(E.frameNeighbors(11, 10)) + JSON.stringify(E.frameNeighbors(12, 10)),
    JSON.stringify([[0], [0], [0]]));
});
test('framePayload XORs exactly the neighbour chunks', () => {
  const bytes = randomBytes(95, 7);
  const { stream } = E.buildStream(bytes, { name: 'x' });
  const cb = 16, K = E.chunkCount(stream.length, cb);
  bytesEq(E.framePayload(stream, 3, K, cb), E.chunkAt(stream, 3, cb));
  for (let seq = K; seq < K + 40; seq++) {
    const n = E.frameNeighbors(seq, K);
    const want = new Uint8Array(cb);
    for (const i of n) { const c = E.chunkAt(stream, i, cb); for (let j = 0; j < cb; j++) want[j] ^= c[j]; }
    bytesEq(E.framePayload(stream, seq, K, cb), want, `seq ${seq}`);
  }
});

/* ---------- protocol 2: alternating soliton / dense repair frames ---------- */
test('protocol 2 repair frames: soliton (bit-identical to protocol 1) except dense ones — every other up to 1024 chunks, every 8th above', () => {
  assert.equal(E.DENSE_EVERY_LARGE, 8);
  assert.equal(E.repairIsDense(1, 1024), true); assert.equal(E.repairIsDense(0, 1024), false); assert.equal(E.repairIsDense(3, 10), true);
  assert.equal(E.repairIsDense(1, 1025), false); assert.equal(E.repairIsDense(7, 1025), true); assert.equal(E.repairIsDense(15, 5000), true); assert.equal(E.repairIsDense(8, 5000), false);
  for (const K of [10, 100, 1000, 3000]) {
    let dense = 0, denseSizes = 0, sol = 0, solSizes = 0;
    for (let seq = K; seq < K + 400; seq++) {
      const n2 = E.frameNeighbors(seq, K), n1 = E.frameNeighbors(seq, K, 1);
      assert.ok(n2.every((x, i) => x >= 0 && x < K && (i === 0 || x > n2[i - 1])), 'in range, sorted, distinct');
      if (!E.repairIsDense(seq - K, K)) { deepEq(n2, n1, `non-dense j: protocol 2 equals protocol 1 at seq ${seq}`); sol++; solSizes += n2.length; }
      else { dense++; denseSizes += n2.length; assert.ok(n2.length >= 1); assert.ok(n1.length <= K); }
      deepEq(E.frameNeighbors(seq, K, 2), n2, 'v:2 is the default');
    }
    assert.equal(dense, K <= 1024 ? 200 : 50, `K=${K}: dense share`);
    const meanDense = denseSizes / dense, meanSol = solSizes / sol;
    assert.ok(Math.abs(meanDense - K / 2) < 2 + 3 * Math.sqrt(K) / 2 / Math.sqrt(dense) * 4, `K=${K}: dense frames average ${meanDense.toFixed(1)} chunks (expect ≈ ${K / 2})`);
    if (K >= 100) assert.ok(meanSol < K / 4 && K / 4 < meanDense, `K=${K}: soliton mean ${meanSol.toFixed(1)} ≪ dense mean ${meanDense.toFixed(1)}`);
  }
  deepEq(E.frameNeighbors(1, 1), [0]); deepEq(E.frameNeighbors(2, 1), [0]); deepEq(E.frameNeighbors(2, 1, 1), [0]);
});
test('protocol-1 frames (makeContext {v:1}) carry the B1 magic and still decode here, lossless and lossy; versions never mix', () => {
  const bytes = randomBytes(3000, 41);
  const built = E.buildStream(bytes, { name: 'old.bin', type: '' });
  const ctx1 = E.makeContext(built.stream, 20, { v: 1 });
  assert.equal(ctx1.v, 1);
  assert.equal(E.encodeFrame(ctx1, 0).slice(0, 2), 'B1');
  assert.equal(E.parseFrame(E.encodeFrame(ctx1, 5)).v, 1);
  assert.equal(E.parseFrame(E.encodeFrame(E.makeContext(built.stream, 20), 5)).v, 2);
  assert.equal(E.parseFrame('B3' + E.encodeFrame(ctx1, 5).slice(2)), null, 'unknown protocol rejected');
  assert.equal(E.parseFrame('B0' + E.encodeFrame(ctx1, 5).slice(2)), null);
  let dec = E.createDecoder(), ev;
  for (let seq = 0; seq < ctx1.K; seq++) ev = E.decoderPush(dec, frameAt(ctx1, seq));
  assert.equal(ev.type, 'complete'); assert.equal(dec.v, 1);
  bytesEq(E.decoderResult(dec).fileBytes, bytes);
  dec = E.createDecoder(); const r = E.rng(42); let seq = 0;
  while (!dec.complete && seq < 20 * ctx1.K) { const f = frameAt(ctx1, seq++); if (r() < 0.2) continue; E.decoderPush(dec, f); }
  assert.ok(dec.complete, 'lossy protocol-1 transfer completes with the soliton-only rule');
  bytesEq(E.decoderResult(dec).fileBytes, bytes);
  const ctx2 = E.makeContext(built.stream, 20);
  const d3 = E.createDecoder(); E.decoderPush(d3, frameAt(ctx1, 0));
  const mixed = E.decoderPush(d3, frameAt(ctx2, 1));
  assert.equal(mixed.type, 'bad'); assert.ok(/protocol/.test(mixed.reason));
  assert.equal(E.decoderProgress(d3).have, 1, 'the transfer in progress is untouched');
});
test('dense repair frames: a receiver missing a few chunks finishes in about that many frames (the old tail is gone)', () => {
  // K ≈ 300 at 5 % seeded loss: with soliton-only repair the sender showed ~40 % extra frames; now a few %.
  const t = transfer(randomBytes(6000, 51), 20);
  const run = (seed, v) => {
    const ctx = E.makeContext(t.built.stream, 20, { v });
    const r = E.rng(seed), dec = E.createDecoder(); let seq = 0, shown = 0;
    while (!dec.complete && seq < 30 * ctx.K) { const text = E.encodeFrame(ctx, seq++); shown++; if (r() < 0.05) continue; E.decoderPush(dec, E.parseFrame(text)); }
    assert.ok(dec.complete); bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
    return (shown - ctx.K) / ctx.K;
  };
  let v2 = 0, v1 = 0;
  for (const seed of [1, 2, 3, 4, 5]) { v2 += run(seed, 2); v1 += run(seed, 1); }
  v2 /= 5; v1 /= 5;
  assert.ok(v2 < 0.15, `protocol 2 extra frames ${v2.toFixed(3)} should be under 15 %`);
  assert.ok(v2 < v1 / 2, `protocol 2 (${v2.toFixed(3)}) should at least halve protocol 1's overhead (${v1.toFixed(3)})`);
});
test('frames too dense to park while many chunks are unknown are discarded, counted, and the transfer still completes', () => {
  const t = transfer(randomBytes(30000, 61), 20);
  assert.ok(t.K > 2 * E.PARK_MAX_DEGREE + 200, `K=${t.K}: dense frames (~K/2 unknowns) exceed PARK_MAX_DEGREE for a late joiner`);
  const dec = E.createDecoder();
  assert.ok(E.repairIsDense(7, t.K) && E.repairIsDense(15, t.K), 'above 1024 chunks every 8th repair frame is dense');
  let ev = E.decoderPush(dec, frameAt(t.ctx, t.K + 7));      // j = 7 → dense
  assert.equal(ev.type, 'start');
  ev = E.decoderPush(dec, frameAt(t.ctx, t.K + 15));         // j = 15 → dense
  assert.equal(ev.type, 'redundant'); assert.equal(ev.discarded, true);
  assert.ok(E.decoderProgress(dec).discarded >= 1);
  assert.equal(dec.pending.length, 0, 'nothing parked');
  assert.equal(E.decoderProgress(dec).redundant, 0, 'discarded is counted separately from redundant');
  let seq = 3 * t.K, used = 0;
  while (!dec.complete && used < 3 * t.K) { used++; E.decoderPush(dec, frameAt(t.ctx, seq++)); }
  assert.ok(dec.complete, 'late joiner completes once enough is known for dense frames to park and eliminate');
  bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
  assert.ok(E.decoderProgress(dec).discarded > 0);
});
test('linkAdvice: null until enough frames; faster when nearly lossless; slower when a third is missed; ok between', () => {
  assert.equal(E.linkAdvice(null), null);
  assert.equal(E.linkAdvice({ minSeq: 0, maxSeq: 10, unique: 11, elapsedMs: 5000 }), null, 'fewer than 20 frames shown');
  assert.equal(E.linkAdvice({ minSeq: 0, maxSeq: 40, unique: 41, elapsedMs: 2000 }), null, 'under 3 s');
  assert.equal(E.linkAdvice({ minSeq: -1, maxSeq: -1, unique: 0, elapsedMs: 9000 }), null, 'nothing seen');
  const fast = E.linkAdvice({ minSeq: 100, maxSeq: 199, unique: 98, elapsedMs: 10000 });
  assert.equal(fast.advice, 'faster'); assert.ok(Math.abs(fast.senderFps - 9.9) < 0.01); assert.ok(fast.missRate < 0.03); assert.equal(fast.shown, 100);
  const slow = E.linkAdvice({ minSeq: 0, maxSeq: 99, unique: 50, elapsedMs: 10000 });
  assert.equal(slow.advice, 'slower'); assert.equal(slow.missRate, 0.5);
  assert.equal(E.linkAdvice({ minSeq: 0, maxSeq: 99, unique: 85, elapsedMs: 10000 }).advice, 'ok');
  assert.equal(E.linkAdvice({ minSeq: 0, maxSeq: 199, unique: 200, elapsedMs: 10000 }).advice, 'ok', 'already at FPS_MAX');
});
test('eliminationStep: every frame while the system is small, backing off cubically', () => {
  assert.equal(E.eliminationStep(1), 1); assert.equal(E.eliminationStep(500), 1); assert.equal(E.eliminationStep(860), 1);
  assert.equal(E.eliminationStep(1404), 4); assert.equal(E.eliminationStep(2048), 13);
});
test('decoderProgress reports pendingUseful (repair frames in hand, capped at the unknown count), discarded and the seq range', () => {
  const t = transfer(randomBytes(2000, 71), 20);
  const dec = E.createDecoder();
  for (let seq = 0; seq < t.K - 3; seq++) E.decoderPush(dec, frameAt(t.ctx, seq));
  let p = E.decoderProgress(dec);
  assert.equal(p.pendingUseful, 0); assert.equal(p.minSeq, 0); assert.equal(p.maxSeq, t.K - 4); assert.equal(p.v, 2); assert.equal(p.discarded, 0);
  for (const j of [1, 3, 5, 7]) if (!dec.complete) E.decoderPush(dec, frameAt(t.ctx, t.K + j));   // dense repair frames
  p = E.decoderProgress(dec);
  assert.ok(p.complete || p.have > t.K - 3 || p.pendingUseful >= 1, 'repair frames count toward progress');
  assert.ok(p.pendingUseful <= t.K - p.have);
  assert.ok(p.maxSeq >= t.K + 1 && p.maxSeq <= t.K + 7, `maxSeq ${p.maxSeq} (pushes stop once complete)`);
});

test('protocol-1 output is bit-identical to the first release (fingerprint taken from commit 09079fa)', () => {
  const r = E.rng(4242), bytes = new Uint8Array(5000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(r() * 256);
  const built = E.buildStream(bytes, { name: 'pin.bin', type: 'application/octet-stream' });
  const ctx = E.makeContext(built.stream, 20, { v: 1 });
  assert.equal(ctx.K, 255); assert.equal(ctx.tid, 'KVMMBM');
  const h = createHash('sha256');
  for (let seq = 0; seq < ctx.K + 400; seq++) h.update(E.encodeFrame(ctx, seq) + '\n');
  assert.equal(h.digest('hex'), '183d4ba8d5ea64f9a7b5927bb8c15370ca518dd89c8d019b276f9bce681950b1', 'an old receiver must keep decoding this sender');
});
test('PARK_MAX_DEGREE is 512 and is the exact parking boundary for a dense frame', () => {
  assert.equal(E.PARK_MAX_DEGREE, 512);
  const t = transfer(randomBytes(23000, 61), 20);            // K ≈ 1150 → dense frames every 8th, ~575 chunks each
  assert.ok(t.K > 1024 && t.K < 1300, `K=${t.K}`);
  const seq = t.K + 7;
  const nb = E.frameNeighbors(seq, t.K);
  assert.ok(nb.length > 512 + 20, `dense frame touches ${nb.length} chunks`);
  const run = (unknownCount) => {
    const dec = E.createDecoder({ elimination: false });
    const unknown = new Set(nb.slice(0, unknownCount));
    for (let s = 0; s < t.K; s++) if (!unknown.has(s)) E.decoderPush(dec, frameAt(t.ctx, s));
    assert.equal(E.decoderProgress(dec).have, t.K - unknownCount);
    return { ev: E.decoderPush(dec, frameAt(t.ctx, seq)), dec };
  };
  const parked = run(512);
  assert.equal(parked.ev.type, 'progress', '512 unknowns: parked'); assert.equal(parked.dec.pending.length, 1); assert.equal(parked.dec.discarded, 0);
  const dropped = run(513);
  assert.equal(dropped.ev.type, 'redundant', '513 unknowns: discarded'); assert.equal(dropped.ev.discarded, true); assert.equal(dropped.dec.pending.length, 0); assert.equal(dropped.dec.discarded, 1);
  // a discarded dense frame costs no chunk work: it is decided before the first XOR
  const fresh = E.createDecoder(); E.decoderPush(fresh, frameAt(t.ctx, 0));
  const t0 = process.hrtime.bigint(); for (let i = 0; i < 20; i++) E.decoderPush(fresh, frameAt(t.ctx, t.K + 7 + 8 * i)); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 200, `20 discarded dense frames took ${ms.toFixed(1)} ms`);
});
test('a hostile header claiming K near K_MAX with protocol 2 costs bounded work per frame', () => {
  const payload = u8('xx');
  const tag = (b) => E.base45Encode(new Uint8Array([(E.crc32(b) >>> 24) & 255, (E.crc32(b) >>> 16) & 255, (E.crc32(b) >>> 8) & 255, E.crc32(b) & 255]));
  const K = E.K_MAX - 1;
  const frame = (seq) => E.parseFrame('B2' + tag(u8('tid-h')) + E.toBase36(K, 4) + E.toBase36(seq, 5) + tag(payload) + E.base45Encode(payload));
  const dec = E.createDecoder();
  assert.equal(E.decoderPush(dec, frame(K + 7)).type, 'start');
  const t0 = process.hrtime.bigint();
  for (let i = 1; i <= 5; i++) assert.equal(E.decoderPush(dec, frame(K + 7 + 8 * i)).discarded, true, 'dense frames are discarded, not parked');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 150, `5 hostile dense frames took ${ms.toFixed(1)} ms (must bail after PARK_MAX_DEGREE unknowns, not scan K)`);
});
test('decoderContinue: null whenever solveMore is clear (mid-transfer too), and solveMore is dropped when no pass can run', () => {
  const t = transfer(randomBytes(2000, 71), 20);
  const dec = E.createDecoder();
  for (let seq = 0; seq < t.K - 3; seq++) E.decoderPush(dec, frameAt(t.ctx, seq));
  assert.equal(dec.solveMore, false); assert.equal(E.decoderContinue(dec), null, 'mid-transfer, nothing budgeted → null');
  // a sticky flag with nothing solvable (pending < unknown) must clear on the first continue, not spin for ever
  dec.solveMore = true;
  const ev = E.decoderContinue(dec);
  assert.ok(ev && ev.type === 'progress' && ev.resolved.length === 0, 'one empty pass');
  assert.equal(dec.solveMore, false, 'flag dropped because pending < unknown');
  assert.equal(E.decoderContinue(dec), null, 'and the next call is null — no busy loop for the page');
  // same with far too many unknowns for elimination
  const big = transfer(randomBytes(60000, 73), 20);
  const d2 = E.createDecoder(); E.decoderPush(d2, frameAt(big.ctx, 0));
  assert.ok(big.K - 1 > E.GE_MAX_UNKNOWN);
  d2.solveMore = true; E.decoderContinue(d2);
  assert.equal(d2.solveMore, false); assert.equal(E.decoderContinue(d2), null);
});
test('pendingUseful is capped at the unknown count; seq range and discarded reset on a tid switch', () => {
  const t = transfer(randomBytes(2000, 71), 20);
  const a = 7, b = 40;
  const d = E.createDecoder({ elimination: false });
  for (let s = 0; s < t.K; s++) if (s !== a && s !== b) E.decoderPush(d, frameAt(t.ctx, s));
  assert.equal(E.decoderProgress(d).have, t.K - 2);
  // repair frames touching BOTH unknown chunks park (two unknowns each); five of them → 5 in hand, 2 useful
  let seq = t.K, parked = 0;
  while (parked < 5) { const n = E.frameNeighbors(seq, t.K); if (n.indexOf(a) >= 0 && n.indexOf(b) >= 0) { const ev = E.decoderPush(d, frameAt(t.ctx, seq)); if (ev.type === 'progress') parked++; } seq++; }
  const p = E.decoderProgress(d);
  assert.equal(p.pending, 5); assert.equal(p.pendingUseful, 2, 'capped at the 2 unknown chunks'); assert.equal(p.have, t.K - 2);
  // switch to another transfer: the range and counters belong to the new one
  const other = transfer(randomBytes(900, 72), 20);
  E.decoderPush(d, frameAt(other.ctx, 5));
  const q = E.decoderProgress(d);
  assert.equal(q.tid, other.ctx.tid); assert.equal(q.minSeq, 5); assert.equal(q.maxSeq, 5); assert.equal(q.discarded, 0); assert.equal(q.pending, 0); assert.equal(q.pendingUseful, 0);
});
test('linkAdvice ignores an implausible span (a sequence wrap or two transfers in one window)', () => {
  assert.equal(E.linkAdvice({ minSeq: 3, maxSeq: 60466175, unique: 70, elapsedMs: 5000 }), null);
  assert.equal(E.linkAdvice({ minSeq: 0, maxSeq: 5000, unique: 60, elapsedMs: 5000 }), null, '5000 frames in 5 s is impossible');
  assert.ok(E.linkAdvice({ minSeq: 0, maxSeq: 99, unique: 60, elapsedMs: 5000 }), 'a plausible span is judged');
});

/* ---------- frame codec ---------- */
test('encodeFrame → parseFrame round trip; every char ∈ ALNUM; constant length', () => {
  const { ctx, K } = transfer(randomBytes(500, 3), 20);
  const len = E.HEADER_LEN + 30;
  for (let seq = 0; seq < K + 50; seq++) {
    const text = E.encodeFrame(ctx, seq);
    assert.equal(text.length, len, 'constant length');
    assert.ok(ALNUM_RE.test(text), `alnum only: ${text}`);
    assert.equal(text.slice(0, 2), 'B2');
    const f = E.parseFrame(text);
    assert.ok(f, 'parses');
    assert.equal(f.v, 2);
    assert.equal(f.tid, ctx.tid);
    assert.equal(f.K, K);
    assert.equal(f.seq, seq);
    bytesEq(f.payload, E.framePayload(ctx.stream, seq, K, 20));
  }
  assert.equal(ctx.tid, E.buildStream(randomBytes(500, 3), { name: 'file.bin', type: 'application/octet-stream' }).tid, 'tid is the stream CRC');
  assert.throws(() => E.encodeFrame(ctx, E.SEQ_MAX + 1), /out of range/);
  assert.equal(E.encodeFrame(ctx, E.SEQ_MAX).slice(12, 17), 'ZZZZZ');
});
test('makeContext validates its inputs', () => {
  const { stream } = E.buildStream(u8('abc'), { name: 'a' });
  const ctx = E.makeContext(stream, 4);
  assert.equal(ctx.K, Math.ceil(stream.length / 4));
  assert.equal(ctx.chunkBytes, 4);
  assert.equal(ctx.tid.length, 6);
  assert.throws(() => E.makeContext(stream, 3), /even/);
  assert.throws(() => E.makeContext(stream, 0), /even/);
  assert.throws(() => E.makeContext(null, 4));
});
test('parseFrame returns null (never throws) on every kind of malformed input', () => {
  const { ctx } = transfer(randomBytes(300, 9), 20);
  const good = E.encodeFrame(ctx, 2);
  assert.ok(E.parseFrame(good));
  const bad = {
    garbage: 'hello world this is not a frame at all!!!',
    lowercase: good.toLowerCase(),
    truncated1: good.slice(0, -1),
    truncated3: good.slice(0, -3),
    truncatedHeader: good.slice(0, 20),
    flippedPayloadChar: good.slice(0, 30) + (good[30] === 'A' ? 'B' : 'A') + good.slice(31),
    flippedCrcChar: good.slice(0, 18) + (good[18] === 'A' ? 'B' : 'A') + good.slice(19),
    wrongMagic: 'B9' + good.slice(2),
    wrongMagic2: 'Q1' + good.slice(2),
    kZero: good.slice(0, 8) + '0000' + good.slice(12),
    kNotBase36: good.slice(0, 8) + '00 1' + good.slice(12),
    seqNotBase36: good.slice(0, 12) + '0.001' + good.slice(17),
    tidOutOfRange: good.slice(0, 2) + '::::::' + good.slice(8),
    extraChar: good + 'A',
    extraTriplet: good + 'AAA',
    nonAlnum: good.slice(0, 30) + '#' + good.slice(31),
    unicode: good.slice(0, 30) + 'É' + good.slice(31),
    empty: '',
    url: 'https://example.com/beam/',
    spaces: ' '.repeat(good.length),
  };
  for (const [name, text] of Object.entries(bad)) assert.equal(E.parseFrame(text), null, `should reject: ${name}`);
  for (const v of [null, undefined, 123, {}, [], new Uint8Array(5)]) assert.equal(E.parseFrame(v), null);
  assert.ok(E.parseFrame(good), 'the original still parses');
});

/** A hand-assembled frame with an arbitrary header — what a hostile screen can show (CRC covers the payload only). */
function craftFrame(tidSeed, K, seq, payload) {
  const tag = (b) => E.base45Encode(new Uint8Array([(E.crc32(b) >>> 24) & 255, (E.crc32(b) >>> 16) & 255, (E.crc32(b) >>> 8) & 255, E.crc32(b) & 255]));
  return 'B1' + tag(u8('tid' + tidSeed)) + E.toBase36(K, 4) + E.toBase36(seq, 5) + tag(payload) + E.base45Encode(payload);
}
test('hostile frames with distinct tids and huge K are handled without retaining per-K state', () => {
  const dec = E.createDecoder();
  const payload = new Uint8Array([1, 2]);
  const t50 = E.solitonTable(50);
  for (let i = 0; i < 3; i++) {
    const f = E.parseFrame(craftFrame(i, E.K_MAX - i, E.K_MAX + 5, payload));
    assert.ok(f && f.K === E.K_MAX - i, 'parseFrame accepts the maximal K');
    const ev = E.decoderPush(dec, f);
    assert.ok(ev.type === (i === 0 ? 'start' : 'switch'), `coded frame adopted as a new transfer (${ev.type})`);
    assert.equal(E.decoderProgress(dec).K, E.K_MAX - i);
  }
  assert.notEqual(E.solitonTable(50), t50, 'only the latest table is memoised — nothing accumulates per K');
  // a real transfer afterwards is unaffected
  const t = transfer(randomBytes(300, 7), 20);
  let last = null;
  for (let seq = 0; seq < t.K; seq++) last = E.decoderPush(dec, frameAt(t.ctx, seq));
  assert.equal(last.type, 'complete');
  bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
});

/* ---------- decoder scenarios ---------- */
test('(a) lossless: start on frame 0, complete on frame K−1 exactly, K frames seen, bytes identical', () => {
  const t = transfer(randomBytes(1234, 11), 24, { name: 'doc.bin' });
  const { ctx, K } = t;
  assert.ok(K > 10);
  const dec = E.createDecoder();
  assert.equal(E.decoderProgress(dec).K, 0);
  for (let seq = 0; seq < K; seq++) {
    const ev = E.decoderPush(dec, frameAt(ctx, seq));
    if (seq === 0) { assert.equal(ev.type, 'start'); assert.equal(ev.tid, ctx.tid); assert.equal(ev.K, K); }
    else if (seq < K - 1) { assert.equal(ev.type, 'progress'); assert.equal(ev.have, seq + 1); deepEq(ev.resolved, [seq]); }
    else { assert.equal(ev.type, 'complete'); assert.equal(ev.have, K); assert.equal(ev.K, K); }
    if (seq < K - 1) assert.equal(E.decoderProgress(dec).complete, false);
  }
  const p = E.decoderProgress(dec);
  assert.equal(p.framesSeen, K);
  assert.equal(p.unique, K);
  assert.equal(p.redundant, 0);
  assert.equal(p.have, K);
  assert.equal(p.pct, 100);
  assert.equal(p.complete, true);
  assert.equal(p.tid, ctx.tid);
  assert.ok(Array.from(E.decoderHas(dec)).every((x) => x === 1));
  const res = E.decoderResult(dec);
  bytesEq(res.fileBytes, t.bytes);
  assert.equal(res.manifest.n, 'doc.bin');
  assert.equal(res.stream.length, ctx.stream.length);
  assert.equal(res.manifest.h, E.crc32Hex(t.bytes));
});
test('decoderHas and progress pct track partial state', () => {
  const { ctx, K } = transfer(randomBytes(400, 12), 20);
  const dec = E.createDecoder();
  E.decoderPush(dec, frameAt(ctx, 0));
  E.decoderPush(dec, frameAt(ctx, 5));
  const has = Array.from(E.decoderHas(dec));
  assert.equal(has.length, K);
  assert.equal(has[0], 1); assert.equal(has[5], 1); assert.equal(has[1], 0);
  assert.equal(has.reduce((a, b) => a + b, 0), 2);
  assert.equal(E.decoderProgress(dec).pct, Math.round(2 / K * 1000) / 10);
  assert.throws(() => E.decoderResult(dec), /not complete/);
});
test('(b) 30 % random frame loss (seeded) completes with overhead < 60 % of K', () => {
  const t = transfer(randomBytes(3000, 21), 20);
  const { ctx, K } = t;
  const run = (seed) => {
    const r = E.rng(seed), dec = E.createDecoder();
    let received = 0, seq = 0, ev = null, completes = 0;
    while (seq < 50 * K) {
      const text = E.encodeFrame(ctx, seq++);
      if (r() < 0.3) continue; // the camera missed this one
      received++;
      ev = E.decoderPush(dec, E.parseFrame(text));
      if (ev.type === 'complete') { completes++; break; }
    }
    assert.equal(completes, 1, `seed ${seed} completed`);
    bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
    return (received - K) / K;
  };
  const main = run(2026);
  assert.ok(main < 0.6, `overhead ${main.toFixed(3)} must be < 0.6`);
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const mean = seeds.map(run).reduce((a, b) => a + b, 0) / seeds.length;
  assert.ok(mean < 0.6, `mean overhead ${mean.toFixed(3)} must be < 0.6`);
});
test('(b′) a coded frame can resolve several chunks at once and propagate through pending equations', () => {
  const { ctx, K } = transfer(randomBytes(600, 22), 20);
  // Feed only coded frames until the first multi-resolution event appears.
  const dec = E.createDecoder();
  let multi = null, seq = K;
  while (!multi && seq < 40 * K) {
    const ev = E.decoderPush(dec, frameAt(ctx, seq++));
    if (ev.resolved && ev.resolved.length > 1) multi = ev;
    if (ev.type === 'complete') break;
  }
  assert.ok(multi, 'some frame resolved more than one chunk via the work queue');
  for (const i of multi.resolved) assert.ok(E.decoderHas(dec)[i] === 1);
});
test('(c) late joiner starting at seq 3K (coded frames only) completes with correct bytes', () => {
  const t = transfer(randomBytes(2000, 31), 20, { name: 'late.bin' });
  const { ctx, K } = t;
  const dec = E.createDecoder();
  let seq = 3 * K, used = 0, ev = null;
  while (used < 40 * K) {
    used++;
    ev = E.decoderPush(dec, frameAt(ctx, seq++));
    if (used === 1) { assert.equal(ev.type, 'start'); assert.equal(ev.K, K); }
    if (ev.type === 'complete') break;
  }
  assert.equal(ev.type, 'complete');
  assert.ok(used < 3 * K, `late joiner used ${used} frames for K=${K}`);
  assert.equal(E.decoderProgress(dec).framesSeen, used);
  const res = E.decoderResult(dec);
  bytesEq(res.fileBytes, t.bytes);
  assert.equal(res.manifest.n, 'late.bin');
});
test('(d) duplicates by seq → dup, not counted as unique', () => {
  const { ctx } = transfer(randomBytes(300, 41), 20);
  const dec = E.createDecoder();
  E.decoderPush(dec, frameAt(ctx, 0));
  E.decoderPush(dec, frameAt(ctx, 1));
  assert.equal(E.decoderPush(dec, frameAt(ctx, 1)).type, 'dup');
  assert.equal(E.decoderPush(dec, frameAt(ctx, 0)).type, 'dup');
  const p = E.decoderProgress(dec);
  assert.equal(p.framesSeen, 4);
  assert.equal(p.unique, 2);
  assert.equal(p.have, 2);
});
test('redundant: a coded frame whose neighbours are all known carries nothing', () => {
  const { ctx, K } = transfer(randomBytes(300, 42), 20);
  const dec = E.createDecoder();
  for (let seq = 0; seq < K - 1; seq++) E.decoderPush(dec, frameAt(ctx, seq));
  // find a coded frame that does not touch the one missing chunk
  let seq = K;
  while (E.frameNeighbors(seq, K).indexOf(K - 1) >= 0) seq++;
  assert.equal(E.decoderPush(dec, frameAt(ctx, seq)).type, 'redundant');
  assert.equal(E.decoderProgress(dec).redundant, 1);
  assert.equal(E.decoderProgress(dec).have, K - 1);
});
test('(e) tid switch → switch event, previous progress dropped, new transfer completes', () => {
  const a = transfer(randomBytes(500, 51), 20, { name: 'a.bin' });
  const b = transfer(randomBytes(700, 52), 20, { name: 'b.bin' });
  assert.notEqual(a.ctx.tid, b.ctx.tid);
  const dec = E.createDecoder();
  for (let seq = 0; seq < 5; seq++) E.decoderPush(dec, frameAt(a.ctx, seq));
  assert.equal(E.decoderProgress(dec).have, 5);
  const ev = E.decoderPush(dec, frameAt(b.ctx, 3));
  assert.equal(ev.type, 'switch');
  assert.equal(ev.tid, b.ctx.tid);
  assert.equal(ev.K, b.K);
  const p = E.decoderProgress(dec);
  assert.equal(p.tid, b.ctx.tid);
  assert.equal(p.have, 1, 'old progress is gone, the switching frame counts');
  assert.equal(p.framesSeen, 1);
  let last = null;
  for (let seq = 0; seq < b.K; seq++) last = E.decoderPush(dec, frameAt(b.ctx, seq));
  assert.equal(last.type, 'complete');
  const res = E.decoderResult(dec);
  bytesEq(res.fileBytes, b.bytes);
  assert.equal(res.manifest.n, 'b.bin');
});
test('(f) frames after completion → done; result stays available', () => {
  const t = transfer(randomBytes(200, 61), 20);
  const dec = E.createDecoder();
  for (let seq = 0; seq < t.K; seq++) E.decoderPush(dec, frameAt(t.ctx, seq));
  assert.equal(E.decoderProgress(dec).complete, true);
  assert.equal(E.decoderPush(dec, frameAt(t.ctx, t.K)).type, 'done');
  assert.equal(E.decoderPush(dec, frameAt(t.ctx, 0)).type, 'done', 'even a seq already seen');
  assert.equal(E.decoderPush(dec, frameAt(t.ctx, t.K + 7)).type, 'done');
  bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
});
test('(g) decoderResult on a corrupt reassembly throws "corrupt transfer"', () => {
  const t = transfer(randomBytes(400, 71), 20);
  const dec = E.createDecoder();
  for (let seq = 0; seq < t.K; seq++) E.decoderPush(dec, frameAt(t.ctx, seq));
  dec.chunks[t.K - 2][3] ^= 0x55; // hand-flip a byte in the file body
  assert.throws(() => E.decoderResult(dec), /corrupt transfer/);
  dec.chunks[t.K - 2][3] ^= 0x55;
  bytesEq(E.decoderResult(dec).fileBytes, t.bytes, 'and clean again once repaired');
  dec.chunks[0][0] ^= 0xff; // wreck the manifest length
  assert.throws(() => E.decoderResult(dec), /corrupt transfer/);
});
test('bad: a lone same-tid frame with inconsistent K or frame size is rejected without resetting', () => {
  const { ctx } = transfer(randomBytes(300, 81), 20);
  const dec = E.createDecoder();
  E.decoderPush(dec, frameAt(ctx, 0));
  const f1 = frameAt(ctx, 1); f1.K = f1.K + 1;
  const ev1 = E.decoderPush(dec, f1);
  assert.equal(ev1.type, 'bad');
  assert.match(ev1.reason, /K changed within transfer/);
  const f2 = frameAt(ctx, 2); f2.payload = f2.payload.subarray(0, 10);
  const ev2 = E.decoderPush(dec, f2);
  assert.equal(ev2.type, 'bad');
  assert.match(ev2.reason, /frame size changed/);
  assert.equal(E.decoderPush(dec, null).type, 'bad');
  assert.equal(E.decoderProgress(dec).have, 1);
  assert.equal(E.decoderPush(dec, frameAt(ctx, 1)).type, 'progress', 'still the same transfer');
  // the same misread shown twice (same seq) is still not a re-plan
  const f3 = frameAt(ctx, 3); f3.K = f3.K + 1;
  assert.equal(E.decoderPush(dec, f3).type, 'bad');
  assert.equal(E.decoderPush(dec, { ...f3, payload: f3.payload }).type, 'bad', 'same seq twice does not reset');
  assert.equal(E.decoderProgress(dec).have, 2, 'progress intact');
  assert.equal(E.decoderPush(dec, frameAt(ctx, 2)).type, 'progress');
  // a consistent frame in between clears the candidate: alternating mismatches never reset
  const f4 = frameAt(ctx, 4); f4.K = f4.K + 1;
  assert.equal(E.decoderPush(dec, f4).type, 'bad');
  assert.equal(E.decoderPush(dec, frameAt(ctx, 5)).type, 'progress');
  const f6 = frameAt(ctx, 6); f6.K = f6.K + 1;
  assert.equal(E.decoderPush(dec, f6).type, 'bad');
  assert.equal(E.decoderProgress(dec).have, 4, 'still the original transfer');
});
test('re-plan: the same file beamed again at another density (same tid, new K) switches instead of locking on bad', () => {
  // tid = CRC(stream) ignores chunkBytes: Stop → lower the density → Start keeps the tid but changes K
  // and the frame size. The receiver must follow (two distinct-seq frames agreeing on the new plan),
  // not reject every frame forever.
  const built = E.buildStream(randomBytes(5000, 82), { name: 'photo.jpg', type: 'image/jpeg' });
  const big = E.makeContext(built.stream, 816), small = E.makeContext(built.stream, 248);
  assert.equal(big.tid, small.tid, 'same stream, same tid');
  assert.notEqual(big.K, small.K);
  for (const [from, to] of [[big, small], [small, big]]) {
    const dec = E.createDecoder();
    E.decoderPush(dec, frameAt(from, 0));
    E.decoderPush(dec, frameAt(from, 1));
    assert.equal(E.decoderProgress(dec).have, 2);
    const first = E.decoderPush(dec, frameAt(to, 0));
    assert.equal(first.type, 'bad', 'one frame is not proof (the header is outside the payload CRC)');
    assert.equal(first.replan, true);
    assert.equal(E.decoderProgress(dec).K, from.K, 'not reset yet');
    const second = E.decoderPush(dec, frameAt(to, 1));
    assert.equal(second.type, 'switch', 'two consistent frames → re-plan');
    assert.equal(second.tid, to.tid);
    assert.equal(second.K, to.K);
    const p = E.decoderProgress(dec);
    assert.equal(p.K, to.K); assert.equal(p.have, 1); assert.equal(p.framesSeen, 1);
    let ev = null, seq = 2;
    while (!dec.complete && seq < 3 * to.K) ev = E.decoderPush(dec, frameAt(to, seq++));
    assert.equal(ev.type, 'complete');
    const res = E.decoderResult(dec);
    bytesEq(res.fileBytes, randomBytes(5000, 82));
    assert.equal(res.manifest.n, 'photo.jpg');
  }
  // an EC toggle changes only the frame size at the same K-ish: also a re-plan
  const ecL = E.makeContext(built.stream, 816), ecM = E.makeContext(built.stream, 640);
  const dec = E.createDecoder();
  E.decoderPush(dec, frameAt(ecL, 0));
  assert.equal(E.decoderPush(dec, frameAt(ecM, 0)).type, 'bad');
  assert.equal(E.decoderPush(dec, frameAt(ecM, 1)).type, 'switch');
  assert.equal(E.decoderProgress(dec).K, ecM.K);
});
test('K=1: the very first frame completes (reported as complete, carrying tid)', () => {
  const t = transfer(u8('hi'), 200);
  assert.equal(t.K, 1);
  const dec = E.createDecoder();
  const ev = E.decoderPush(dec, frameAt(t.ctx, 0));
  assert.equal(ev.type, 'complete');
  assert.equal(ev.tid, t.ctx.tid);
  assert.equal(ev.K, 1);
  bytesEq(E.decoderResult(dec).fileBytes, u8('hi'));
  assert.equal(E.decoderPush(dec, frameAt(t.ctx, 1)).type, 'done');
  // a late joiner on K=1 also completes from a coded frame
  const dec2 = E.createDecoder();
  assert.equal(E.decoderPush(dec2, frameAt(t.ctx, 99)).type, 'complete');
});
test('pending cap: the oldest equation is evicted (dead, counted) and the transfer still completes', () => {
  // Ordinary runs never come near 4×K pending (peeling collapses equations as fast as they arrive), so
  // the cap is lowered through the test hook and only multi-neighbour coded frames are fed: with no
  // chunk known, pure peeling cannot collapse them, so each one parks until the cap evicts.
  assert.equal(E.createDecoder().pendingCapFactor, E.PENDING_CAP_FACTOR, 'default factor');
  assert.equal(E.PENDING_CAP_FACTOR, 4);
  const t = transfer(randomBytes(40, 91), 20);
  assert.ok(t.K >= 5 && t.K <= 12, `small K (${t.K})`);
  const factor = 0.5, cap = Math.ceil(factor * t.K);
  const dec = E.createDecoder({ elimination: false, pendingCapFactor: factor });
  let seq = t.K;
  const nextMulti = () => { while (E.frameNeighbors(seq, t.K).length < 2) seq++; return seq++; };
  while (dec.pending.length < cap) E.decoderPush(dec, frameAt(t.ctx, nextMulti()));
  assert.equal(dec.pending.length, cap);
  assert.equal(dec.evicted, 0);
  assert.equal(dec.have, 0);
  const oldest = dec.pending[0], second = dec.pending[1];
  const ev = E.decoderPush(dec, frameAt(t.ctx, nextMulti()));
  assert.equal(ev.type, 'progress');
  assert.equal(dec.pending.length, cap, 'cap holds');
  assert.equal(dec.evicted, 1, 'one eviction counted');
  assert.equal(oldest.dead, true, 'the evicted equation is marked dead');
  assert.ok(dec.pending.indexOf(oldest) < 0, 'and is gone from the live list');
  assert.equal(dec.pending[0], second, 'FIFO: the next oldest moved up');
  assert.equal(E.decoderProgress(dec).pending, cap);
  // the sender keeps looping: everything still decodes byte-identically despite the dropped equations
  let last = null, s = 0;
  while (!dec.complete && s < 60 * t.K) last = E.decoderPush(dec, frameAt(t.ctx, s++));
  assert.equal(last.type, 'complete');
  assert.ok(dec.evicted >= 1);
  bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
  // and the default 4×K cap is honoured by an ordinary coded-only run
  const t2 = transfer(randomBytes(300, 91), 20);
  const dec2 = E.createDecoder();
  let seq2 = t2.K, ev2 = null;
  while (seq2 < 60 * t2.K) { ev2 = E.decoderPush(dec2, frameAt(t2.ctx, seq2++)); if (ev2.type === 'complete') break; }
  assert.equal(ev2.type, 'complete');
  assert.ok(E.decoderProgress(dec2).pending <= E.PENDING_CAP_FACTOR * t2.K);
  bytesEq(E.decoderResult(dec2).fileBytes, t2.bytes);
});
test('peeling alone (no elimination) finishes a late joiner from coded frames only — degree-1 frames do arrive', () => {
  // Pins the fountain code's self-sufficiency: above GE_MAX_UNKNOWN unknowns the decoder is peeling only,
  // so a late joiner on a multi-MB file depends on degree-1 coded frames showing up at the soliton rate.
  // Protocol-1 frames are soliton-only — exactly the half of protocol-2 repair frames a peeling-only
  // receiver can use — so the bound below is per useful frame.
  for (const [bytes, seed] of [[4000, 93], [10000, 94], [16000, 95]]) {
    const t = transfer(randomBytes(bytes, seed), 20);
    const ctx1 = E.makeContext(t.built.stream, 20, { v: 1 });
    const dec = E.createDecoder({ elimination: false });
    let seq = 3 * t.K, used = 0, ev = null;
    while (used < 3 * t.K) { used++; ev = E.decoderPush(dec, frameAt(ctx1, seq++)); if (ev.type === 'complete') break; }
    assert.equal(ev.type, 'complete', `K=${t.K}: peeling-only late joiner never completed`);
    assert.ok(used < 1.6 * t.K, `K=${t.K}: used ${used} frames`);
    bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
  }
});
test('xorInto word path: chunk sizes ≡ 0 and ≡ 2 (mod 4) decode byte-identically from coded frames only', () => {
  for (const cb of [32, 34, 100, 102, 816, 630]) {
    const t = transfer(randomBytes(cb * 23 + 5, cb), cb);
    const dec = E.createDecoder();
    let seq = 2 * t.K, ev = null, used = 0;
    while (used < 4 * t.K) { used++; ev = E.decoderPush(dec, frameAt(t.ctx, seq++)); if (ev.type === 'complete') break; }
    assert.equal(ev.type, 'complete', `chunkBytes=${cb}`);
    bytesEq(E.decoderResult(dec).fileBytes, t.bytes, `chunkBytes=${cb}`);
  }
});

/* ---------- inactivation: Gaussian elimination over the pending equations ---------- */
test('solvePending: rank-deficient equations resolve nothing; full rank resolves every unknown', () => {
  // K=3, nothing known. {0,1}, {1,2}, {0,2} are dependent (any two sum to the third): rank 2 of 3.
  const dec = E.createDecoder();
  dec.tid = 'HANDBUILT'.slice(0, 6); dec.K = 3; dec.chunkBytes = 2; dec.chunks = new Array(3); dec.have = 0;
  const c = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])];
  const x = (...cs) => cs.reduce((a, b) => new Uint8Array([a[0] ^ b[0], a[1] ^ b[1]]), new Uint8Array(2));
  dec.pending = [
    { idx: [0, 1], data: x(c[0], c[1]), dead: false },
    { idx: [1, 2], data: x(c[1], c[2]), dead: false },
    { idx: [0, 2], data: x(c[0], c[2]), dead: false },
  ];
  assert.equal(E.solvePending(dec).length, 0, 'three dependent equations pin nothing down');
  dec.pending.push({ idx: [0, 1, 2], data: x(c[0], c[1], c[2]), dead: false });
  const sol = E.solvePending(dec).sort((a, b) => a.chunk - b.chunk);
  deepEq(sol.map((s) => s.chunk), [0, 1, 2], 'full rank resolves all three');
  for (const s of sol) bytesEq(s.data, c[s.chunk], `chunk ${s.chunk} data`);
  // a column budget stops the (expensive) data phase early and says so
  const part = E.solvePending(dec, 2);
  assert.equal(part.length, 2);
  assert.equal(part.truncated, true);
  for (const s of part) bytesEq(s.data, c[s.chunk]);
  assert.equal(E.solvePending(dec, 3).truncated, undefined, 'exactly enough budget is not truncated');
  assert.equal(E.solvePending(dec, 0).length, 3, 'a non-positive budget means unlimited');
  // a dead equation is ignored; fewer live equations than unknowns → no attempt
  dec.pending[3].dead = true;
  assert.equal(E.solvePending(dec).length, 0);
  dec.pending = [dec.pending[0]];
  assert.equal(E.solvePending(dec).length, 0, 'P < U is skipped');
});
test('elimination is budgeted per push: a late joiner resolves at most solveColumns chunks by elimination per frame, then continues', () => {
  assert.equal(E.createDecoder().solveColumns, E.GE_COLUMNS_PER_PUSH);
  assert.ok(E.GE_COLUMNS_PER_PUSH >= 16 && E.GE_COLUMNS_PER_PUSH <= 256, `budget ${E.GE_COLUMNS_PER_PUSH}`);
  const t = transfer(randomBytes(4000, 25), 20);
  const run = (solveColumns, drive) => {
    const dec = E.createDecoder({ solveColumns });
    let seq = 3 * t.K, used = 0, truncatedPushes = 0, continues = 0, ev = null;
    assert.equal(E.decoderContinue(dec), null, 'nothing to continue before any frame');
    while (used < 3 * t.K) {
      used++;
      ev = E.decoderPush(dec, frameAt(t.ctx, seq++));
      if (dec.solveMore) {
        truncatedPushes++;
        assert.equal(dec.nextSolveAt, dec.unique, 'a truncated pass may continue on the very next push');
        if (drive) {
          // what the page does: keep continuing from a timer, no new frame needed
          while (dec.solveMore && ev.type !== 'complete') { const c = E.decoderContinue(dec); assert.ok(c, 'continue returns an event while solveMore'); continues++; ev = c; }
        }
      }
      if (ev.type === 'complete') break;
    }
    assert.equal(ev.type, 'complete');
    assert.equal(E.decoderContinue(dec), null, 'nothing to continue after completion');
    bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
    return { used, truncatedPushes, continues };
  };
  const unlimited = run(Infinity, false), budgeted = run(4, false), driven = run(4, true);
  assert.equal(unlimited.truncatedPushes, 0);
  assert.ok(budgeted.truncatedPushes >= 1, 'the small budget was hit at least once');
  assert.ok(budgeted.used > unlimited.used, `left to the frames alone, a budgeted pass waits for more codes (${budgeted.used} vs ${unlimited.used})`);
  assert.ok(driven.continues >= 1, 'the driven run continued between frames');
  assert.ok(driven.used <= unlimited.used + 1, `driven by decoderContinue, budgeting costs no frames: ${driven.used} vs ${unlimited.used}`);
  assert.ok(E.createDecoder({ solveColumns: 0 }).solveColumns === E.GE_COLUMNS_PER_PUSH, 'invalid budget → default');
});
test('elimination finishes seeded lossy runs in no more frames than peeling alone (fewer overall), same bytes', () => {
  const t = transfer(randomBytes(10000, 23), 20);
  const { ctx, K } = t;
  const run = (seed, elimination) => {
    const r = E.rng(seed), dec = E.createDecoder({ elimination });
    let received = 0, seq = 0;
    while (seq < 50 * K) {
      const text = E.encodeFrame(ctx, seq++);
      if (r() < 0.3) continue;
      received++;
      if (E.decoderPush(dec, E.parseFrame(text)).type === 'complete') break;
    }
    assert.ok(dec.complete, `seed ${seed} elimination=${elimination} completed`);
    bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
    return received;
  };
  let peel = 0, elim = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const a = run(seed, false), b = run(seed, true);
    assert.ok(b <= a, `seed ${seed}: elimination needed ${b} frames, peeling alone ${a}`);
    peel += a; elim += b;
  }
  assert.ok(elim < peel, `elimination should save frames somewhere: ${elim} vs ${peel}`);
  assert.ok(K > 400 && K < 600, `K=${K} — this test is about a mid-size transfer`);
});
test('elimination is throttled: nextSolveAt advances by eliminationStep(unknown) unique frames per attempt', () => {
  // A lossy mid-size run gives several attempts. nextSolveAt starts at 0 and only an attempt changes it,
  // so `last` starts at 0 too (the untouched initial value must not count as an attempt). The unknown
  // count at attempt time is bracketed: peeling inside the same push happens before the attempt (so
  // unknown ≤ the pre-push count) and elimination resolves chunks after it (so unknown ≥ the post-push count).
  const t = transfer(randomBytes(10000, 23), 20);
  const run = (seed) => {
    const r = E.rng(seed), dec = E.createDecoder({ solveColumns: Infinity });
    let seq = 0, attempts = 0, last = 0;
    while (!dec.complete && seq < 40 * t.K) {
      const text = E.encodeFrame(t.ctx, seq++);
      if (r() < 0.3) continue;
      const unknownBefore = dec.K - dec.have;
      E.decoderPush(dec, E.parseFrame(text));
      if (dec.nextSolveAt === last) continue;
      attempts++;
      assert.ok(dec.unique >= last, `attempt at unique=${dec.unique} before the previous nextSolveAt=${last}`);
      const step = dec.nextSolveAt - dec.unique, unknownAfter = dec.K - dec.have;
      const lo = E.eliminationStep(unknownAfter), hi = E.eliminationStep(unknownBefore);
      assert.ok(step >= lo && step <= hi, `step ${step} outside [${lo}, ${hi}] (unknown before ${unknownBefore}, after ${unknownAfter})`);
      last = dec.nextSolveAt;
    }
    assert.ok(dec.complete);
    bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
    return attempts;
  };
  const attempts = [1, 2, 3, 4].map(run);
  assert.ok(attempts.every((a) => a >= 1), `every run attempted elimination: ${attempts}`);
  assert.ok(attempts.some((a) => a >= 2), `some run attempted more than once: ${attempts}`);
  // coded frames only (late joiner): the first attempt waits until P ≥ U; no attempt before that
  const dec = E.createDecoder({ solveColumns: Infinity });
  let seq = t.K;
  while (dec.nextSolveAt === 0 && seq < 4 * t.K) {
    E.decoderPush(dec, frameAt(t.ctx, seq++));
    if (dec.nextSolveAt === 0) assert.ok(dec.pending.length < dec.K - dec.have || dec.complete, 'no attempt while P < U');
  }
  assert.ok(dec.nextSolveAt > 0, 'an attempt happened');
  assert.ok(dec.nextSolveAt - dec.unique >= 1);
  // The exact formula, with many unknowns left: a cycle of degree-2 equations {i, i+1} spans only the
  // even-parity vectors, so with even-degree coded frames the system stays rank-deficient (rank K−1),
  // every attempt resolves nothing and the unknown count is exactly K at each attempt.
  const t2 = transfer(randomBytes(28000, 26), 20);
  const K = t2.K;
  assert.ok(E.eliminationStep(K) >= 4, `K=${K} so that the step is ≥ 4`);
  const d2 = E.createDecoder({ solveColumns: Infinity });
  // even-degree SOLITON frames only (dense frames at this K exceed PARK_MAX_DEGREE and are discarded, which would skip attempts)
  const evenCoded = (() => { let s = K; return () => { while ((s - K) % 2 === 1 || E.frameNeighbors(s, K).length % 2 !== 0) s++; return frameAt(t2.ctx, s++); }; })();
  assert.equal(E.decoderPush(d2, evenCoded()).type, 'start');
  assert.equal(d2.have, 0);
  for (let i = 0; i < K; i++) {
    const j = (i + 1) % K, data = E.chunkAt(t2.ctx.stream, i, 20);
    const cj = E.chunkAt(t2.ctx.stream, j, 20);
    for (let b = 0; b < 20; b++) data[b] ^= cj[b];
    const eq = { idx: [Math.min(i, j), Math.max(i, j)], data, dead: false };
    d2.pending.push(eq);
    for (const c of eq.idx) (d2.byChunk[c] || (d2.byChunk[c] = [])).push(eq);
  }
  assert.ok(d2.pending.length >= K, 'P ≥ U from here on');
  const step = E.eliminationStep(K);
  assert.ok(step >= 4);
  const expected = [];
  for (let n = 0; n < 3 * step; n++) {
    E.decoderPush(d2, evenCoded());
    assert.equal(d2.have, 0, 'rank-deficient: nothing ever resolves');
    if (d2.unique >= (expected.length ? expected[expected.length - 1] : 0) && d2.nextSolveAt !== (expected.length ? expected[expected.length - 1] : 0)) {
      expected.push(d2.nextSolveAt);
      assert.equal(d2.nextSolveAt, d2.unique + step, `attempt at unique=${d2.unique} schedules the next ${step} unique frames later`);
    } else {
      assert.equal(d2.nextSolveAt, expected[expected.length - 1], `no attempt at unique=${d2.unique} before nextSolveAt`);
    }
  }
  assert.equal(expected.length, 3, `three attempts over ${3 * step} frames: ${expected}`);
  assert.equal(expected[0], 2 + step, 'first attempt on the first push with P ≥ U');
  assert.equal(expected[1], expected[0] + step);
  assert.equal(expected[2], expected[1] + step);
});

/* ---------- peekManifest ---------- */
test('peekManifest: null until the contiguous prefix covers the manifest, then the manifest', () => {
  const t = transfer(randomBytes(1000, 101), 20, { name: 'notes.txt', type: 'text/plain' });
  const ml = (t.ctx.stream[0] << 8) | t.ctx.stream[1];
  const needChunks = Math.ceil((2 + ml) / 20);
  assert.ok(needChunks >= 4, `manifest spans ${needChunks} chunks`);
  const dec = E.createDecoder();
  assert.equal(E.peekManifest(dec), null, 'no transfer yet');
  E.decoderPush(dec, frameAt(t.ctx, 1));
  E.decoderPush(dec, frameAt(t.ctx, 2));
  assert.equal(E.peekManifest(dec), null, 'chunk 0 missing');
  E.decoderPush(dec, frameAt(t.ctx, 0));
  assert.equal(E.peekManifest(dec), null, 'prefix not yet long enough');
  for (let i = 3; i < needChunks - 1; i++) E.decoderPush(dec, frameAt(t.ctx, i));
  assert.equal(E.peekManifest(dec), null, 'one chunk short');
  E.decoderPush(dec, frameAt(t.ctx, needChunks - 1));
  const m = E.peekManifest(dec);
  assert.ok(m, 'manifest available');
  assert.equal(m.n, 'notes.txt');
  assert.equal(m.t, 'text/plain');
  assert.equal(m.b, 1000);
  assert.equal(m.v, 1);
  assert.equal(E.peekManifest(dec), m, 'cached');
});

/* ---------- planning, ETA, formatters ---------- */
test('plan: K, bytes/s, cycle and padded estimate', () => {
  const p = E.plan({ streamLen: 10000, chunkBytes: 816, fps: 5 });
  assert.equal(p.K, 13);
  assert.equal(p.bytesPerFrame, 816);
  assert.equal(p.bytesPerSecond, 4080);
  assert.equal(p.cycleSeconds, 13 / 5);
  assert.ok(Math.abs(p.estimateSeconds - 13 / 5 * 1.15) < 1e-12);
  assert.equal(E.plan({ streamLen: 0, chunkBytes: 100, fps: 2 }).K, 1);
});
test('eta: null before 2 useful frames, 0 when done, otherwise from the observed rate', () => {
  assert.equal(E.eta({ have: 0, K: 100, framesSeen: 0, elapsedMs: 0 }), null);
  assert.equal(E.eta({ have: 1, K: 100, framesSeen: 1, elapsedMs: 500 }), null);
  assert.equal(E.eta({ have: 100, K: 100, framesSeen: 120, elapsedMs: 30000 }), 0);
  const e = E.eta({ have: 20, K: 100, framesSeen: 20, elapsedMs: 4000 }); // 5 chunks/s → 80 left → 16 s ×1.15
  assert.ok(typeof e === 'number' && e >= 16 && e <= 20, `got ${e}`);
  assert.ok(E.eta({ have: 50, K: 100, framesSeen: 50, elapsedMs: 10000 }) < E.eta({ have: 10, K: 100, framesSeen: 10, elapsedMs: 10000 }));
});
test('formatBytes / formatDuration / formatPct', () => {
  assert.equal(E.formatBytes(0), '0 B');
  assert.equal(E.formatBytes(812), '812 B');
  assert.equal(E.formatBytes(1234), '1.2 KB');
  assert.equal(E.formatBytes(180 * 1024), '180 KB');
  assert.equal(E.formatBytes(3.4 * 1024 * 1024), '3.4 MB');
  assert.equal(E.formatBytes(2 * 1024 ** 3), '2.0 GB');
  assert.equal(E.formatDuration(4), '4s');
  assert.equal(E.formatDuration(80), '1m 20s');
  assert.equal(E.formatDuration(60), '1m');
  assert.equal(E.formatDuration(2 * 3600 + 5 * 60 + 9), '2h 5m');
  assert.equal(E.formatDuration(-3), '0s');
  assert.equal(E.formatDuration(NaN), '0s');
  assert.equal(E.formatPct(42.4), '42%');
  assert.equal(E.formatPct(142), '100%');
  assert.equal(E.formatPct(-1), '0%');
});
test('fileKind by mime type, then by extension', () => {
  assert.equal(E.fileKind('image/jpeg', 'x.jpg'), 'image');
  assert.equal(E.fileKind('', 'IMG_0001.HEIC'), 'image');
  assert.equal(E.fileKind('video/mp4', 'a.mp4'), 'video');
  assert.equal(E.fileKind('', 'clip.mov'), 'video');
  assert.equal(E.fileKind('audio/mpeg', 'song.mp3'), 'audio');
  assert.equal(E.fileKind('text/plain', 'note.txt'), 'text');
  assert.equal(E.fileKind('application/json', 'data.json'), 'text');
  assert.equal(E.fileKind('', 'README.md'), 'text');
  assert.equal(E.fileKind('application/pdf', 'doc.pdf'), 'pdf');
  assert.equal(E.fileKind('', 'doc.pdf'), 'pdf');
  assert.equal(E.fileKind('application/zip', 'a.zip'), 'archive');
  assert.equal(E.fileKind('', 'a.tar.gz'), 'archive');
  assert.equal(E.fileKind('application/octet-stream', 'mystery.bin'), 'other');
  assert.equal(E.fileKind(undefined, undefined), 'other');
});
test('shouldCompress is false for already-compressed kinds, true otherwise', () => {
  const no = [['image/jpeg', 'a.jpg'], ['image/png', 'a.png'], ['image/gif', 'a.gif'], ['image/webp', 'a.webp'], ['', 'a.heic'],
    ['video/mp4', 'a.mp4'], ['video/quicktime', 'a.mov'], ['audio/mpeg', 'a.mp3'], ['audio/mp4', 'a.m4a'], ['application/zip', 'a.zip'],
    ['application/gzip', 'a.gz'], ['', 'a.7z'], ['application/pdf', 'a.pdf'], ['', 'a.PDF']];
  for (const [t, n] of no) assert.equal(E.shouldCompress(t, n), false, `${t} ${n}`);
  const yes = [['text/plain', 'note.txt'], ['application/json', 'd.json'], ['image/svg+xml', 'v.svg'], ['', 'file.bin'], ['application/octet-stream', 'x'],
    ['text/csv', 'rows.csv'], ['image/bmp', 'raw.bmp'], ['', 'book.epub']];
  for (const [t, n] of yes) assert.equal(E.shouldCompress(t, n), true, `${t} ${n}`);
});
test('imageShrinkTarget levels: Small 800 px q0.62, Medium (default) 1280 px q0.72, Original untouched', () => {
  const t = E.imageShrinkTarget(4 * 1024 * 1024);
  assert.equal(t.maxEdge, 1280);
  assert.equal(t.quality, 0.72);
  assert.equal(t.id, 'm');
  assert.ok(typeof t.note === 'string' && t.note.length > 10);
  assert.notEqual(E.imageShrinkTarget(20 * 1024).note, t.note, 'small files get a different note');
  const sm = E.imageShrinkTarget(4 * 1024 * 1024, 's');
  assert.equal(sm.maxEdge, 800); assert.equal(sm.quality, 0.62); assert.equal(sm.id, 's');
  const o = E.imageShrinkTarget(4 * 1024 * 1024, 'o');
  assert.equal(o.maxEdge, 0); assert.equal(o.id, 'o');
  deepEq(E.imageShrinkTarget(1, 'nope'), E.imageShrinkTarget(1, 'm'), 'unknown level → default');
  deepEq(E.SHRINK_LEVELS.map((l) => l.id), ['s', 'm', 'o']);
  assert.equal(E.DEFAULT_SHRINK, 'm');
});
test('engine is pure: no Date.now / Math.random / DOM in the source', () => {
  const src = readFileSync(join(ROOT, 'beam', 'engine.js'), 'utf8');
  assert.ok(!/Date\.now|Math\.random|document\.|window\.|localStorage|fetch\(/.test(src));
  assert.ok(!/BeamQR/.test(src), 'engine.js must not depend on qr.js');
  assert.equal(sandbox.BeamEngine, E, 'also exported on the global for the page');
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nbeam: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
