#!/usr/bin/env node
/**
 * End-to-end test for Beam — file transfer by animated QR code.
 *
 * The whole pipeline, exactly as the two phones run it, but in Node:
 *
 *   bytes → buildStream → makeContext → encodeFrame (BeamEngine)
 *         → BeamQR.encode({ version, ec, mode: 'alnum' })      (the sender's screen)
 *         → rasterise to RGBA pixels (scale 4, quiet zone 4)
 *         → jsQR (an INDEPENDENT decoder — the receiver's camera)
 *         → parseFrame → decoderPush (BeamEngine)              (the receiver)
 *         → decoderResult → bytes
 *
 * with every 7th frame dropped on the floor, so the fountain code has to
 * finish the job with repair frames. Three files (a 1 KB text, a 20 KB
 * seeded-random binary, a 0-byte file) × two presets (Small = v10, Large =
 * v20). Besides byte-identical output and a correct manifest, every frame
 * jsQR returns must equal the frame text we encoded EXACTLY — spaces
 * included (base45 emits ' ' as a digit, so a trimming decoder would corrupt
 * every frame; this is the assertion that catches it).
 *
 * Both modules are loaded in a vm sandbox like the other tests; the only
 * dependency is the jsqr devDependency. Run: node scripts/test-beam-e2e.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadClassic(rel) {
  const sandbox = { module: { exports: {} } };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  return sandbox.module.exports;
}
const QR = loadClassic('beam/qr.js');
const E = loadClassic('beam/engine.js');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const bytesEq = (a, b, m) => assert.equal(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'), m);

/* ---------- the three files ---------- */
function randomBytes(n, seed) {
  const r = E.rng(seed), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(r() * 256);
  return out;
}
const TEXT_1KB = (() => {
  let s = 'Beam e2e — a note that crosses the air gap by light.\n';
  let i = 1;
  while (E.utf8Encode(s).length < 1024) s += `line ${i++}: the quick brown fox 🦊 jumps over the lazy dog; ünïcödé ok.\n`;
  return E.utf8Encode(s);
})();
const FILES = [
  { label: '1 KB text', name: 'note.txt', type: 'text/plain', bytes: TEXT_1KB },
  { label: '20 KB random binary', name: 'blob.bin', type: 'application/octet-stream', bytes: randomBytes(20 * 1024, 20260404) },
  { label: '0-byte file', name: 'empty.dat', type: '', bytes: new Uint8Array(0) },
];
const PRESETS = ['s', 'l'].map((id) => E.PRESETS.find((p) => p.id === id));
assert.ok(PRESETS[0] && PRESETS[0].label === 'Small' && PRESETS[1] && PRESETS[1].label === 'Large', 'presets Small/Large exist');

/* ---------- the "screen" and the "camera" ---------- */
const SCALE = 4, QUIET = 4;
function rasterize(code) {
  const px = (code.size + QUIET * 2) * SCALE;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let r = 0; r < code.size; r++) {
    const row = code.modules[r];
    for (let c = 0; c < code.size; c++) {
      if (!row[c]) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        let i = (((r + QUIET) * SCALE + dy) * px + (c + QUIET) * SCALE) * 4;
        for (let dx = 0; dx < SCALE; dx++, i += 4) data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return { data, width: px, height: px };
}
function scan(code) {
  const img = rasterize(code);
  const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  return res ? res.data : null;
}

/**
 * Run one transfer end to end. Frames with seq % 7 === 0 are "missed by the
 * camera" — every 7th, starting with the very first, so even a one-chunk file
 * loses a frame and chunk 0 (the manifest) must come back via a repair frame.
 * Returns what the receiver ended up with plus stats.
 */
function transfer(file, preset, opts = {}) {
  const ec = opts.ec || preset.ec;
  const built = E.buildStream(file.bytes, { name: file.name, type: file.type, originalSize: file.bytes.length, compressed: false });
  const chunkBytes = E.chunkBytesFor(QR.capacity(preset.version, ec, 'alnum'));
  const ctx = E.makeContext(built.stream, chunkBytes);
  const dec = E.createDecoder();
  const events = [];
  let seq = 0, shown = 0, dropped = 0, frameLen = -1, manifestSeenAt = -1, complete = null;
  const limit = 20 * ctx.K + 50;                       // generous; the fountain finishes long before
  for (; seq < limit; seq++) {
    const text = E.encodeFrame(ctx, seq);
    assert.ok(/^[0-9A-Z $%*+\-.\/:]+$/.test(text), `frame ${seq} has a char outside BeamQR.ALNUM`);
    if (frameLen < 0) frameLen = text.length; else assert.equal(text.length, frameLen, 'every frame of a transfer has the same length');
    if (seq % 7 === 0) { dropped++; continue; }         // the camera missed this one
    const code = QR.encode(text, { version: preset.version, ec, mode: 'alnum' });
    assert.equal(code.version, preset.version, 'fixed version honoured');
    assert.equal(code.size, 17 + 4 * preset.version);
    const read = scan(code);
    assert.ok(read !== null, `jsQR found no code in frame ${seq} (v${code.version}, mask ${code.mask})`);
    assert.equal(read, text, `jsQR text differs from the encoded frame ${seq} (exact, spaces included)`);
    shown++;
    const frame = E.parseFrame(read);
    assert.ok(frame, `parseFrame rejected a jsQR-decoded frame ${seq}`);
    assert.equal(frame.tid, built.tid);
    assert.equal(frame.K, ctx.K);
    assert.equal(frame.seq, seq);
    assert.equal(frame.payload.length, chunkBytes);
    const ev = E.decoderPush(dec, frame);
    events.push(ev.type);
    if (manifestSeenAt < 0 && E.peekManifest(dec)) manifestSeenAt = seq;
    if (ev.type === 'complete') { complete = ev; break; }
  }
  assert.ok(complete, `transfer never completed within ${limit} frames (K=${ctx.K})`);
  const prog = E.decoderProgress(dec);
  const res = E.decoderResult(dec);
  return { built, ctx, dec, res, prog, events, seq, shown, dropped, frameLen, chunkBytes, manifestSeenAt, complete };
}

function checkManifest(m, file, built) {
  assert.equal(m.v, 1);
  assert.equal(m.n, E.safeFileName(file.name));
  assert.equal(m.t, file.type);
  assert.equal(m.s, file.bytes.length);
  assert.equal(m.b, file.bytes.length);
  assert.equal(m.z, 0);
  assert.equal(m.h, E.crc32Hex(file.bytes));
  assert.equal(JSON.stringify(m), JSON.stringify(built.manifest), 'receiver manifest === sender manifest');
}

/* ---------- the matrix: 3 files × 2 presets ---------- */
for (const preset of PRESETS) {
  for (const file of FILES) {
    test(`${preset.label} (v${preset.version}-${preset.ec}) × ${file.label}: bytes survive the air gap with every 7th frame dropped`, () => {
      const t = transfer(file, preset);
      bytesEq(t.res.fileBytes, file.bytes, 'received bytes differ from the sent file');
      checkManifest(t.res.manifest, file, t.built);
      assert.equal(E.crc32Hex(t.res.fileBytes), t.res.manifest.h, 'manifest.h is the CRC of the received bytes');
      assert.equal(t.res.stream.length, t.built.stream.length, 'reassembled stream trimmed to the exact length');
      bytesEq(t.res.stream, t.built.stream);
      // decoder bookkeeping
      assert.equal(t.events[0], t.ctx.K === 1 ? 'complete' : 'start', 'first frame starts the transfer');
      assert.equal(t.events.filter((e) => e === 'complete').length, 1, 'complete fires exactly once');
      assert.ok(!t.events.includes('bad') && !t.events.includes('switch') && !t.events.includes('dup'), 'no bad/switch/dup in a clean single transfer');
      assert.equal(t.prog.complete, true);
      assert.equal(t.prog.have, t.ctx.K);
      assert.equal(t.prog.pct, 100);
      assert.equal(t.prog.framesSeen, t.shown);
      assert.equal(t.prog.unique, t.shown);
      // the 7th-frame loss actually happened (frame 0 always) and was repaired by coded frames
      assert.equal(t.dropped, Math.floor(t.seq / 7) + 1, `expected drops (K=${t.ctx.K}, dropped=${t.dropped})`);
      assert.ok(t.seq >= t.ctx.K, 'losses force the receiver past the systematic pass');
      assert.ok(t.shown <= t.ctx.K + Math.ceil(0.6 * t.ctx.K) + 2, `overhead too high: ${t.shown} frames for K=${t.ctx.K}`);
      // chunk 0 was never shown directly, yet the manifest is readable once a repair frame resolves it
      assert.ok(t.manifestSeenAt > 0 && t.manifestSeenAt <= t.seq, 'peekManifest reveals the file');
      assert.equal(E.peekManifest(t.dec).n, t.res.manifest.n);
      // frame geometry
      assert.equal(t.frameLen, E.HEADER_LEN + t.chunkBytes * 1.5);
      assert.ok(t.frameLen <= QR.capacity(preset.version, preset.ec, 'alnum'), 'frame fits the chosen symbol');
      console.log(`      K=${t.ctx.K} chunk=${t.chunkBytes}B frame=${t.frameLen}ch shown=${t.shown} dropped=${t.dropped} last seq=${t.seq}`);
    });
  }
}

/* ---------- a few cross-cutting checks ---------- */
test('EC level M (the page\'s glare option) also round-trips through jsQR at Large', () => {
  const t = transfer(FILES[0], PRESETS[1], { ec: 'M' });
  bytesEq(t.res.fileBytes, FILES[0].bytes);
  assert.ok(t.chunkBytes < E.chunkBytesFor(QR.capacity(20, 'L', 'alnum')), 'M carries fewer bytes per frame than L');
});

test('frames read by jsQR contain spaces and are still accepted verbatim', () => {
  // Over a whole transfer some base45 digit is a space; the exact-equality assertion above already
  // covered each frame — here we make sure the case actually occurred so the assertion had teeth.
  const file = FILES[1], preset = PRESETS[0];
  const built = E.buildStream(file.bytes, { name: file.name, type: file.type, originalSize: file.bytes.length, compressed: false });
  const ctx = E.makeContext(built.stream, E.chunkBytesFor(QR.capacity(preset.version, 'L', 'alnum')));
  let withSpace = 0;
  for (let seq = 0; seq < Math.min(ctx.K, 12); seq++) {
    const text = E.encodeFrame(ctx, seq);
    if (text.indexOf(' ') < 0) continue;
    withSpace++;
    const read = scan(QR.encode(text, { version: preset.version, ec: 'L', mode: 'alnum' }));
    assert.equal(read, text);
    assert.ok(E.parseFrame(read));
  }
  assert.ok(withSpace > 0, 'expected at least one frame containing a space');
});

test('a frame jsQR misreads by one character is rejected by parseFrame, never fed to the decoder', () => {
  const built = E.buildStream(FILES[0].bytes, { name: 'note.txt', type: 'text/plain', originalSize: FILES[0].bytes.length, compressed: false });
  const ctx = E.makeContext(built.stream, E.chunkBytesFor(QR.capacity(10, 'L', 'alnum')));
  const text = E.encodeFrame(ctx, 0);
  const i = E.HEADER_LEN + 5;
  const flipped = text.slice(0, i) + (text[i] === 'A' ? 'B' : 'A') + text.slice(i + 1);
  assert.equal(E.parseFrame(flipped), null);
  assert.ok(E.parseFrame(text));
});

test('re-plan through the camera: Stop at Large, Start again at Small (same tid) — the receiver switches and finishes', () => {
  // tid = CRC(stream) is independent of the density, so the sender's Stop → lower density → Start
  // produces frames with the same tid but another K and frame size. The receiver must follow the
  // new plan (after two consistent frames) rather than report 'bad' for every frame forever.
  const file = FILES[1];
  const built = E.buildStream(file.bytes, { name: file.name, type: file.type, originalSize: file.bytes.length, compressed: false });
  const large = E.makeContext(built.stream, E.chunkBytesFor(QR.capacity(20, 'L', 'alnum')));
  const small = E.makeContext(built.stream, E.chunkBytesFor(QR.capacity(10, 'L', 'alnum')));
  assert.equal(large.tid, small.tid);
  assert.ok(small.K > large.K);
  const show = (ctx, version, seq) => {
    const text = E.encodeFrame(ctx, seq);
    const read = scan(QR.encode(text, { version, ec: 'L', mode: 'alnum' }));
    assert.equal(read, text);
    return E.parseFrame(read);
  };
  const dec = E.createDecoder(), events = [];
  for (let seq = 0; seq < 4; seq++) events.push(E.decoderPush(dec, show(large, 20, seq)).type);
  assert.deepEqual(events, ['start', 'progress', 'progress', 'progress']);
  assert.equal(E.decoderProgress(dec).K, large.K);
  // the sender stopped and restarted at Small: seq starts over
  const first = E.decoderPush(dec, show(small, 10, 0));
  assert.equal(first.type, 'bad'); assert.equal(first.replan, true);
  assert.equal(E.decoderProgress(dec).K, large.K, 'one frame does not reset');
  const second = E.decoderPush(dec, show(small, 10, 1));
  assert.equal(second.type, 'switch'); assert.equal(second.K, small.K); assert.equal(second.tid, small.tid);
  let ev = second, seq = 2, bads = 0;
  while (ev.type !== 'complete' && seq < 3 * small.K) { ev = E.decoderPush(dec, show(small, 10, seq++)); if (ev.type === 'bad') bads++; }
  assert.equal(ev.type, 'complete');
  assert.equal(bads, 0, 'no further bad frames once switched');
  const res = E.decoderResult(dec);
  bytesEq(res.fileBytes, file.bytes);
  assert.equal(res.manifest.n, file.name);
  console.log(`      Large K=${large.K} → Small K=${small.K}, completed after ${E.decoderProgress(dec).framesSeen} Small frames`);
});

test('the planner\'s K matches what the decoder actually needs', () => {
  for (const preset of PRESETS) for (const file of FILES) {
    const built = E.buildStream(file.bytes, { name: file.name, type: file.type, originalSize: file.bytes.length, compressed: false });
    const chunkBytes = E.chunkBytesFor(QR.capacity(preset.version, preset.ec, 'alnum'));
    const pl = E.plan({ streamLen: built.stream.length, chunkBytes, fps: 5 });
    assert.equal(pl.K, E.makeContext(built.stream, chunkBytes).K);
    assert.equal(pl.bytesPerFrame, chunkBytes);
    assert.equal(pl.cycleSeconds, pl.K / 5);
  }
});

/* ---- run ---- */
const t0 = Date.now();
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n${err.message}\n`);
    process.exitCode = 1;
  }
}
console.log(`\nbeam e2e: ${passed}/${tests.length} passed (${Date.now() - t0} ms)`);
if (passed !== tests.length) process.exit(1);
