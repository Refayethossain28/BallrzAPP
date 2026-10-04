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
  assert.equal(E.FPS_MIN, 2); assert.equal(E.FPS_MAX, 12); assert.equal(E.FPS_DEFAULT, 5);
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

/* ---------- frame codec ---------- */
test('encodeFrame → parseFrame round trip; every char ∈ ALNUM; constant length', () => {
  const { ctx, K } = transfer(randomBytes(500, 3), 20);
  const len = E.HEADER_LEN + 30;
  for (let seq = 0; seq < K + 50; seq++) {
    const text = E.encodeFrame(ctx, seq);
    assert.equal(text.length, len, 'constant length');
    assert.ok(ALNUM_RE.test(text), `alnum only: ${text}`);
    assert.equal(text.slice(0, 2), 'B1');
    const f = E.parseFrame(text);
    assert.ok(f, 'parses');
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
    wrongMagic: 'B2' + good.slice(2),
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
test('bad: same tid with inconsistent K or frame size is rejected without resetting', () => {
  const { ctx } = transfer(randomBytes(300, 81), 20);
  const dec = E.createDecoder();
  E.decoderPush(dec, frameAt(ctx, 0));
  const f1 = frameAt(ctx, 1); f1.K = f1.K + 1;
  assert.equal(E.decoderPush(dec, f1).type, 'bad');
  const f2 = frameAt(ctx, 2); f2.payload = f2.payload.subarray(0, 10);
  assert.equal(E.decoderPush(dec, f2).type, 'bad');
  assert.equal(E.decoderPush(dec, null).type, 'bad');
  assert.equal(E.decoderProgress(dec).have, 1);
  assert.equal(E.decoderPush(dec, frameAt(ctx, 1)).type, 'progress', 'still the same transfer');
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
test('decoder loses nothing when the pending cap evicts the oldest equation', () => {
  const t = transfer(randomBytes(300, 91), 20);
  const dec = E.createDecoder();
  let seq = t.K, ev = null;
  while (seq < 60 * t.K) { ev = E.decoderPush(dec, frameAt(t.ctx, seq++)); if (ev.type === 'complete') break; }
  assert.equal(ev.type, 'complete');
  assert.ok(E.decoderProgress(dec).pending <= E.PENDING_CAP_FACTOR * t.K);
  bytesEq(E.decoderResult(dec).fileBytes, t.bytes);
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
  // a dead equation is ignored; fewer live equations than unknowns → no attempt
  dec.pending[3].dead = true;
  assert.equal(E.solvePending(dec).length, 0);
  dec.pending = [dec.pending[0]];
  assert.equal(E.solvePending(dec).length, 0, 'P < U is skipped');
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
test('elimination is throttled: nextSolveAt advances by max(1, unknown/16) unique frames per attempt', () => {
  const t = transfer(randomBytes(4000, 24), 20);
  const dec = E.createDecoder();
  // coded frames only (late joiner): pending grows until P ≥ U triggers the first attempt
  let seq = t.K, attempts = 0, last = -1;
  while (!dec.complete && seq < 40 * t.K) {
    E.decoderPush(dec, frameAt(t.ctx, seq++));
    if (dec.nextSolveAt !== last) { attempts++; last = dec.nextSolveAt; }
  }
  assert.ok(dec.complete);
  assert.ok(attempts >= 1 && attempts < dec.unique, `attempts ${attempts} of ${dec.unique} unique frames`);
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
test('imageShrinkTarget: 1280 px long edge at q 0.72 with a note', () => {
  const t = E.imageShrinkTarget(4 * 1024 * 1024);
  assert.equal(t.maxEdge, 1280);
  assert.equal(t.quality, 0.72);
  assert.ok(typeof t.note === 'string' && t.note.length > 10);
  assert.notEqual(E.imageShrinkTarget(20 * 1024).note, t.note, 'small files get a different note');
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
