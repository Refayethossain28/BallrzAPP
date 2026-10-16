#!/usr/bin/env node
/**
 * Unit tests for the TS section of aerial/engine.js — the MPEG-TS demuxer
 * (PAT/PMT, PES with PTS/DTS, H.264 access-unit assembly → AVCC samples,
 * AAC ADTS / MP3 frames, ID3 timed metadata, state threading across chunks).
 * Synthetic streams come from the tiny packetiser below; when ffmpeg/ffprobe
 * are on PATH, real fixtures are generated into a temp dir and every sample is
 * checked against ffprobe's packet list.
 * Run: node scripts/_parts/assemble.mjs && node scripts/_parts/test-ts.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEngine, runner, deepEq } from './harness.mjs';

const E = loadEngine();
const { test, run, assert } = runner('ts');
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0); // fixed clock (the demuxer takes no clock; kept for house convention)
const WRAP = 2 ** 33;

/* ================= helpers: bytes ================= */
const cat = (...parts) => {
  const arrs = parts.map(p => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const avcc = nals => cat(...nals.flatMap(n => [be32(n.length), n]));
// Deterministic filler with no 0x00 and no 0xFF bytes (so it can never fake a start code or an audio sync).
function filler(n, seed) {
  const out = new Uint8Array(n); let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = 1 + (s >>> 24) % 254; }
  return out;
}
function randomBytes(n, seed) {
  const out = new Uint8Array(n); let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = s >>> 24; }
  return out;
}

/* ================= helpers: H.264 bit writer + SPS encoder ================= */
function bitWriter() {
  const bits = [];
  const w = {
    u(n, v) { for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) & 1); },
    ue(v) { const x = v + 1, len = Math.floor(Math.log2(x)); for (let i = 0; i < len; i++) bits.push(0); w.u(len + 1, x); },
    se(v) { w.ue(v > 0 ? 2 * v - 1 : -2 * v); },
    rbsp() { bits.push(1); while (bits.length % 8) bits.push(0); const out = new Uint8Array(bits.length / 8); for (let i = 0; i < bits.length; i++) out[i >> 3] |= bits[i] << (7 - (i & 7)); return out; },
  };
  return w;
}
function escapeRbsp(rbsp) {
  const out = []; let zeros = 0;
  for (const b of rbsp) { if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; } out.push(b); zeros = b === 0 ? zeros + 1 : 0; }
  return Uint8Array.from(out);
}
const HIGH = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
function encodeSps(o) {
  const w = bitWriter();
  w.u(8, o.profileIdc); w.u(8, o.constraintFlags ?? 0); w.u(8, o.levelIdc);
  w.ue(o.spsId ?? 0);
  if (HIGH.has(o.profileIdc)) {
    const cf = o.chromaFormatIdc ?? 1;
    w.ue(cf);
    if (cf === 3) w.u(1, o.separateColourPlane ?? 0);
    w.ue(o.bitDepthLumaMinus8 ?? 0); w.ue(o.bitDepthChromaMinus8 ?? 0); w.u(1, 0);
    if (o.scalingLists) {
      w.u(1, 1);
      const lists = cf !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) {
        const present = i % 2 === 0; w.u(1, present ? 1 : 0);
        if (!present) continue;
        const size = i < 6 ? 16 : 64;
        // a real-looking list: a few deltas then a zero delta (use default for the rest)
        for (let j = 0; j < size; j++) { if (j < 4) w.se(j === 3 ? -(8 + 3 * 1) : 1); else break; }
      }
    } else w.u(1, 0);
  }
  w.ue((o.log2MaxFrameNum ?? 4) - 4);
  const poc = o.pocType ?? 0;
  w.ue(poc);
  if (poc === 0) w.ue((o.log2MaxPocLsb ?? 6) - 4);
  else if (poc === 1) { w.u(1, 0); w.se(o.offsetNonRef ?? -1); w.se(o.offsetTopBottom ?? 2); const cyc = o.pocCycle ?? []; w.ue(cyc.length); for (const v of cyc) w.se(v); }
  w.ue(o.numRefFrames ?? 1); w.u(1, 0);
  w.ue(o.widthMbs - 1); w.ue(o.heightMapUnits - 1);
  const fmo = o.frameMbsOnly ?? 1; w.u(1, fmo);
  if (!fmo) w.u(1, o.mbaff ?? 0);
  w.u(1, 1);
  if (o.crop) { w.u(1, 1); for (const c of o.crop) w.ue(c); } else w.u(1, 0);
  if (o.sar) {
    w.u(1, 1); w.u(1, 1); w.u(8, o.sar.idc);
    if (o.sar.idc === 255) { w.u(16, o.sar.n); w.u(16, o.sar.d); }
    w.u(1, 0); w.u(1, 0); w.u(1, 0); w.u(1, 0); w.u(1, 0); w.u(1, 0); w.u(1, 0); // overscan/video signal/chroma loc/timing/nal hrd/vcl hrd/pic struct (all absent)
  } else w.u(1, 0);
  const rbsp = w.rbsp();
  return { nal: cat([0x67], escapeRbsp(rbsp)), rbsp };
}
const SPS_BASE = encodeSps({ profileIdc: 66, constraintFlags: 0xc0, levelIdc: 30, widthMbs: 20, heightMapUnits: 15 }).nal; // 320x240
const PPS = Uint8Array.from([0x68, 0xce, 0x38, 0x80]);
const AUD = Uint8Array.from([0x09, 0xf0]);
const SEI_USER = Uint8Array.from([0x06, 0x05, 0x02, 0xaa, 0xbb, 0x80]);
const SEI_RECOVERY = Uint8Array.from([0x06, 0x06, 0x01, 0x80, 0x80]);
const idrSlice = (n, seed) => cat([0x65, 0x88, 0x84], filler(n, seed));        // first_mb_in_slice = 0
const pSlice = (n, seed) => cat([0x41, 0x9a, 0x22], filler(n, seed));          // first_mb_in_slice = 0
const pSlice2 = (n, seed) => cat([0x41, 0x40, 0x22], filler(n, seed));         // first_mb_in_slice = 1 (same picture)
const annexB = (nals, four = true) => cat(...nals.flatMap(n => [four ? [0, 0, 0, 1] : [0, 0, 1], n]));

/* ================= helpers: audio frames ================= */
function adtsFrame(body, { srIndex = 3, channels = 1, profile = 1, crc = false } = {}) {
  const len = body.length + (crc ? 9 : 7);
  const h = [0xff, 0xf0 | (crc ? 0 : 1), (profile << 6) | (srIndex << 2) | (channels >> 2), ((channels & 3) << 6) | (len >> 11), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc];
  if (crc) h.push(0, 0);
  return cat(h, body);
}
// MPEG-1 layer III, 128 kbps, 44.1 kHz, stereo → 417 bytes (418 padded)
function mp3Frame(seed, padding = 0, stereo = true) {
  const len = 417 + padding;
  return cat([0xff, 0xfb, 0x90 | (padding << 1), stereo ? 0x00 : 0xc0], filler(len - 4, seed));
}

/* ================= helpers: TS packetiser ================= */
function crc32mpeg(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b << 24; for (let i = 0; i < 8; i++) crc = ((crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1)) >>> 0; }
  return crc >>> 0;
}
function psiSection(tableId, idExt, body) {
  const len = 5 + body.length + 4;
  const all = [tableId, 0xb0 | (len >> 8), len & 0xff, idExt >> 8, idExt & 0xff, 0xc1, 0, 0, ...body];
  return cat(all, be32(crc32mpeg(all)));
}
const patSection = (programs = [[1, 0x1000]]) => psiSection(0, 1, programs.flatMap(([num, pid]) => [num >> 8, num & 0xff, 0xe0 | (pid >> 8), pid & 0xff]));
const pmtSection = (streams, pcrPid = 0x100, programNumber = 1) => psiSection(2, programNumber, [
  0xe0 | (pcrPid >> 8), pcrPid & 0xff, 0xf0, 0,
  ...streams.flatMap(s => { const d = s.descriptors || []; return [s.type, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0 | (d.length >> 8), d.length & 0xff, ...d]; }),
]);
function tsField(v, prefix) {
  const lo = v % 32768, mid = Math.floor(v / 32768) % 32768, hi = Math.floor(v / 2 ** 30) % 8;
  return [(prefix << 4) | (hi << 1) | 1, mid >> 7, ((mid & 0x7f) << 1) | 1, lo >> 7, ((lo & 0x7f) << 1) | 1];
}
function pes(streamId, payload, { pts = null, dts = null, unbounded = false, noHeader = false } = {}) {
  if (noHeader) { const len = payload.length; return cat([0, 0, 1, streamId, len >> 8, len & 0xff], payload); }
  let flags = 0, hdr = [];
  if (pts !== null && dts !== null && dts !== pts) { flags = 0xc0; hdr = [...tsField(pts, 3), ...tsField(dts, 1)]; }
  else if (pts !== null) { flags = 0x80; hdr = tsField(pts, 2); }
  const body = [0x80, flags, hdr.length, ...hdr, ...payload];
  const len = unbounded ? 0 : body.length;
  return cat([0, 0, 1, streamId, len >> 8, len & 0xff], body);
}
function tsPacket(pid, cc, payload, { pusi = false, afOnly = false, afFlags = 0 } = {}) {
  const pkt = new Uint8Array(188).fill(0xff);
  pkt[0] = 0x47; pkt[1] = (pusi ? 0x40 : 0) | (pid >> 8); pkt[2] = pid & 0xff;
  if (afOnly) { pkt[3] = 0x20 | cc; pkt[4] = 183; pkt[5] = afFlags; return pkt; }
  const room = 184 - payload.length;
  if (room === 0) { pkt[3] = 0x10 | cc; pkt.set(payload, 4); return pkt; }
  pkt[3] = 0x30 | cc; pkt[4] = room - 1; if (room - 1 > 0) pkt[5] = afFlags;
  pkt.set(payload, 4 + room);
  return pkt;
}
class Mux {
  constructor() { this.cc = {}; this.packets = []; }
  next(pid) { this.cc[pid] = ((this.cc[pid] ?? -1) + 1) & 15; return this.cc[pid]; }
  es(pid, data) { // one PES (or PSI payload) → packets; first carries PUSI
    let off = 0, first = true;
    do {
      const chunk = data.subarray(off, Math.min(off + 184, data.length));
      this.packets.push(tsPacket(pid, this.next(pid), chunk, { pusi: first }));
      off += chunk.length; first = false;
    } while (off < data.length);
    return this;
  }
  psi(pid, section) { return this.es(pid, cat([0], section)); }
  afOnly(pid, afFlags = 0x10) { this.packets.push(tsPacket(pid, this.cc[pid] ?? 0, null, { afOnly: true, afFlags })); return this; }
  raw(pkt) { this.packets.push(pkt); return this; }
  bytes() { return cat(...this.packets); }
}
const VID = 0x100, AUD_PID = 0x101, ID3_PID = 0x102;
const PMT_AV = pmtSection([{ type: 0x1b, pid: VID }, { type: 0x0f, pid: AUD_PID }, { type: 0x15, pid: ID3_PID }, { type: 0x24, pid: 0x103 }]);

/* ================= the reference synthetic stream ================= */
const IDR = idrSlice(300, 7), P1 = pSlice(120, 11), P1b = pSlice2(60, 13), P2 = pSlice(90, 17);
const AAC_BODIES = [filler(50, 21), filler(60, 22), filler(70, 23), filler(40, 24), filler(45, 25)];
const ID3_DATA = cat([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10], filler(10, 31));
function buildReference({ basePts = 90000, four = true } = {}) {
  const m = new Mux();
  m.psi(0, patSection()).psi(0x1000, PMT_AV);
  m.es(VID, pes(0xe0, annexB([AUD, SPS_BASE, PPS, SEI_USER, IDR], four), { pts: basePts, unbounded: true }));
  m.es(AUD_PID, pes(0xc0, cat(adtsFrame(AAC_BODIES[0]), adtsFrame(AAC_BODIES[1]), adtsFrame(AAC_BODIES[2])), { pts: basePts }));
  m.es(ID3_PID, pes(0xbd, ID3_DATA, { pts: basePts }));
  m.es(VID, pes(0xe0, annexB([AUD, P1, P1b], four), { pts: (basePts + 3600) % WRAP, unbounded: true }));
  m.es(AUD_PID, pes(0xc0, cat(adtsFrame(AAC_BODIES[3]), adtsFrame(AAC_BODIES[4])), { pts: (basePts + 3 * 1920) % WRAP }));
  m.es(VID, pes(0xe0, annexB([AUD, P2], four), { pts: (basePts + 7200) % WRAP, unbounded: true }));
  m.psi(0, patSection()).psi(0x1000, PMT_AV);
  return m.bytes();
}
const REF = buildReference();
const EXPECT_VIDEO = (base = 90000) => [
  { pts: base, dts: base, cts: 0, key: true, duration: 3600, data: hex(avcc([SPS_BASE, PPS, SEI_USER, IDR])) },
  { pts: base + 3600, dts: base + 3600, cts: 0, key: false, duration: 3600, data: hex(avcc([P1, P1b])) },
  { pts: base + 7200, dts: base + 7200, cts: 0, key: false, duration: 3600, data: hex(avcc([P2])) },
];
const EXPECT_AUDIO = (base = 90000) => AAC_BODIES.map((b, i) => ({ pts: base + i * 1920, dts: base + i * 1920, duration: 1024, data: hex(b) }));
const viewSamples = s => s.map(x => ({ pts: x.pts, dts: x.dts, cts: x.cts, key: x.key, duration: x.duration, data: hex(x.data) }));
const viewAudio = s => s.map(x => ({ pts: x.pts, dts: x.dts, duration: x.duration, data: hex(x.data) }));
// Demux `chunks` sequentially with state threading, then flush; returns merged output.
function demuxAll(chunks, state = E.tsCreateState()) {
  const out = { video: [], audio: [], id3: [], errors: [], results: [] };
  let st = state, last = null;
  for (const c of chunks) { last = E.tsDemux(c, st); st = last.state; collect(out, last); }
  const fin = E.tsFlush(st); collect(out, fin);
  out.state = fin.state; out.videoTrack = fin.video; out.audioTrack = fin.audio; out.last = last;
  return out;
}
function collect(out, r) {
  if (r.video) out.video.push(...r.video.samples);
  if (r.audio) out.audio.push(...r.audio.samples);
  out.id3.push(...r.id3); out.errors.push(...r.errors); out.results.push(r);
}
const cut = (bytes, offsets) => offsets.map((o, i) => bytes.subarray(o, offsets[i + 1] ?? bytes.length));

/* ================= tests: primitives ================= */
test('tsCreateState is plain, fresh each time, and not mutated by tsDemux', () => {
  const a = E.tsCreateState(), b = E.tsCreateState();
  assert.notEqual(a, b);
  deepEq(a, b);
  const before = JSON.stringify(a);
  const r = E.tsDemux(REF, a);
  assert.equal(JSON.stringify(a), before, 'input state untouched');
  assert.notEqual(r.state, a);
  assert.equal(r.state.videoPid, VID);
});

test('tsUnwrapPts handles 33-bit wrap in both directions and null refs', () => {
  assert.equal(E.tsUnwrapPts(100, WRAP - 100), WRAP + 100);
  assert.equal(E.tsUnwrapPts(WRAP - 100, 100), -100);
  assert.equal(E.tsUnwrapPts(5, null), 5);
  assert.equal(E.tsUnwrapPts(5, undefined), 5);
  assert.equal(E.tsUnwrapPts(12345, 12345), 12345);
  assert.equal(E.tsUnwrapPts(12345, 12345 + 2 ** 31), 12345);
  assert.equal(E.tsUnwrapPts(WRAP + 10, WRAP + 10 + 3 * WRAP), 4 * WRAP + 10);
  assert.ok(Number.isNaN(E.tsUnwrapPts(NaN, 1)));
});

test('splitNalUnits: 3/4-byte start codes, trailing zeros trimmed, leading junk ignored', () => {
  const nals = E.splitNalUnits(cat([0xaa, 0xbb], [0, 0, 0, 1], AUD, [0, 0, 1], SPS_BASE, [0, 0, 0, 0, 1], PPS, [0, 0]));
  deepEq(nals.map(hex), [hex(AUD), hex(SPS_BASE), hex(PPS)]);
  deepEq(nals.map(n => E.nalType(n)), [9, 7, 8]);
  deepEq(E.splitNalUnits(new Uint8Array(0)), []);
  deepEq(E.splitNalUnits(filler(50, 1)), []);
  deepEq(E.splitNalUnits(null), []);
  deepEq(E.splitNalUnits('nope'), []);
  deepEq(E.splitNalUnits(Uint8Array.from([0, 0, 1, 0, 0, 1])), []);
  assert.equal(E.nalType(new Uint8Array(0)), -1);
  assert.equal(E.nalType(null), -1);
  assert.equal(E.nalType([0x65]), 5);
});

test('toAvcc prefixes each NAL with a 4-byte length; junk entries skipped', () => {
  assert.equal(hex(E.toAvcc([AUD, PPS])), hex(avcc([AUD, PPS])));
  assert.equal(E.toAvcc([]).length, 0);
  assert.equal(E.toAvcc(null).length, 0);
  assert.equal(hex(E.toAvcc([null, PPS, 'x'])), hex(avcc([PPS])));
  const big = filler(70000, 3);
  assert.equal(hex(E.toAvcc([big]).subarray(0, 4)), '00011170');
});

test('unescapeRbsp removes emulation prevention bytes only after two zeros', () => {
  deepEq(Array.from(E.unescapeRbsp([0, 0, 3, 1])), [0, 0, 1]);
  deepEq(Array.from(E.unescapeRbsp([0, 0, 3])), [0, 0]);
  deepEq(Array.from(E.unescapeRbsp([0, 3, 0, 0, 3, 3])), [0, 3, 0, 0, 3]);
  deepEq(Array.from(E.unescapeRbsp([0, 0, 0, 3, 0, 0, 3, 0])), [0, 0, 0, 0, 0, 0]);
  deepEq(Array.from(E.unescapeRbsp([1, 2, 3])), [1, 2, 3]);
  assert.equal(E.unescapeRbsp(null).length, 0);
  assert.equal(E.unescapeRbsp(new Uint8Array(0)).length, 0);
});

/* ================= tests: parseSps ================= */
test('parseSps: baseline 320x240, codec string, default SAR', () => {
  const s = E.parseSps(SPS_BASE);
  assert.equal(s.ok, true);
  assert.equal(s.profileIdc, 66); assert.equal(s.constraintFlags, 0xc0); assert.equal(s.levelIdc, 30);
  assert.equal(s.codec, 'avc1.42c01e');
  assert.equal(s.width, 320); assert.equal(s.height, 240);
  deepEq(s.sar, { n: 1, d: 1 });
  assert.equal(s.frameMbsOnly, true); assert.equal(s.chromaFormatIdc, 1); assert.equal(s.picOrderCntType, 0);
  assert.equal(E.parseSps(Array.from(SPS_BASE)).width, 320, 'accepts plain arrays');
});

test('parseSps: high profile with scaling lists, frame cropping to 1080, extended SAR', () => {
  const { nal } = encodeSps({ profileIdc: 100, constraintFlags: 0, levelIdc: 40, chromaFormatIdc: 1, scalingLists: true, log2MaxFrameNum: 8, widthMbs: 120, heightMapUnits: 68, crop: [0, 0, 0, 4], numRefFrames: 4, sar: { idc: 255, n: 64, d: 45 } });
  const s = E.parseSps(nal);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.codec, 'avc1.640028');
  assert.equal(s.width, 1920); assert.equal(s.height, 1080);
  deepEq(s.sar, { n: 64, d: 45 });
  assert.equal(s.log2MaxFrameNum, 8); assert.equal(s.numRefFrames, 4);
  deepEq(s.crop, { left: 0, right: 0, top: 0, bottom: 8 });
});

test('parseSps: SAR table index, pic_order_cnt_type 1 cycle, level 1b style hex', () => {
  const { nal } = encodeSps({ profileIdc: 77, constraintFlags: 0x40, levelIdc: 9, widthMbs: 11, heightMapUnits: 9, pocType: 1, pocCycle: [1, -2, 3, 0], sar: { idc: 2 } });
  const s = E.parseSps(nal);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.codec, 'avc1.4d4009');
  assert.equal(s.width, 176); assert.equal(s.height, 144);
  assert.equal(s.picOrderCntType, 1);
  deepEq(s.sar, { n: 12, d: 11 });
});

test('parseSps: chroma-aware crop units (4:4:4 separate planes, 4:2:2, interlaced 4:2:0)', () => {
  const p444 = E.parseSps(encodeSps({ profileIdc: 244, levelIdc: 51, chromaFormatIdc: 3, separateColourPlane: 1, widthMbs: 10, heightMapUnits: 5, crop: [1, 1, 2, 0] }).nal);
  assert.equal(p444.ok, true, p444.error);
  assert.equal(p444.width, 158); assert.equal(p444.height, 78); assert.equal(p444.chromaFormatIdc, 3);
  const p422 = E.parseSps(encodeSps({ profileIdc: 122, levelIdc: 41, chromaFormatIdc: 2, bitDepthLumaMinus8: 2, bitDepthChromaMinus8: 2, widthMbs: 10, heightMapUnits: 5, crop: [0, 1, 0, 1] }).nal);
  assert.equal(p422.ok, true, p422.error);
  assert.equal(p422.width, 158); assert.equal(p422.height, 79); assert.equal(p422.bitDepthLuma, 10);
  const interlaced = E.parseSps(encodeSps({ profileIdc: 77, levelIdc: 40, widthMbs: 120, heightMapUnits: 34, frameMbsOnly: 0, mbaff: 1, crop: [0, 0, 0, 2] }).nal);
  assert.equal(interlaced.ok, true, interlaced.error);
  assert.equal(interlaced.width, 1920); assert.equal(interlaced.height, 1080); assert.equal(interlaced.frameMbsOnly, false);
  const p444full = E.parseSps(encodeSps({ profileIdc: 244, levelIdc: 51, chromaFormatIdc: 3, scalingLists: true, widthMbs: 4, heightMapUnits: 4 }).nal);
  assert.equal(p444full.ok, true, p444full.error);
  assert.equal(p444full.width, 64);
});

test('parseSps: emulation-prevention bytes inside the SPS are removed before parsing', () => {
  // Find deterministic parameters whose RBSP needs escaping, so the escape path is really exercised.
  let found = null;
  // 00 00 0x needs at least 22 zero bits in a row, i.e. an exp-golomb codeNum >= 2^22 at the right alignment
  for (const v of [2097152, 3000000, 4194304]) for (let spsId = 0; spsId < 8 && !found; spsId++) {
    const e = encodeSps({ profileIdc: 100, levelIdc: 31, spsId, widthMbs: 40, heightMapUnits: 30, pocType: 1, pocCycle: [-v, -v, v * 2] });
    if (e.nal.length > e.rbsp.length + 1) found = e;
  }
  assert.ok(found, 'an SPS needing escaping exists');
  const s = E.parseSps(found.nal);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.width, 640); assert.equal(s.height, 480);
});

test('parseSps: truncated, junk, empty and non-byte input are rejected without throwing', () => {
  assert.equal(E.parseSps(SPS_BASE.subarray(0, 6)).ok, false);
  assert.equal(E.parseSps(new Uint8Array(0)).ok, false);
  assert.equal(E.parseSps(null).ok, false);
  assert.equal(E.parseSps('sps').ok, false);
  assert.equal(E.parseSps(Uint8Array.from([0x67, 100, 0, 30, 0xff, 0xff, 0xff, 0xff])).ok, false, 'chroma_format_idc overflow');
  for (let seed = 1; seed <= 40; seed++) { const r = E.parseSps(cat([0x67], randomBytes(12 + seed, seed))); assert.equal(typeof r.ok, 'boolean'); }
  // all-zero body: exp-golomb never terminates → flagged, not an infinite loop
  assert.equal(E.parseSps(new Uint8Array(64)).ok, false);
});

/* ================= tests: audio headers ================= */
test('parseAdts: fields, CRC variant, offsets, and every rejection path', () => {
  const f = adtsFrame(filler(50, 1), { srIndex: 4, channels: 2, profile: 1 });
  const h = E.parseAdts(f, 0);
  deepEq(h, { ok: true, frameLength: 57, headerLength: 7, objectType: 2, sampleRateIndex: 4, sampleRate: 44100, channels: 2, crc: false });
  const c = E.parseAdts(cat(filler(5, 2), adtsFrame(filler(10, 3), { crc: true, profile: 0, srIndex: 11, channels: 6 })), 5);
  assert.equal(c.ok, true); assert.equal(c.headerLength, 9); assert.equal(c.frameLength, 19); assert.equal(c.objectType, 1); assert.equal(c.sampleRate, 8000); assert.equal(c.channels, 6); assert.equal(c.crc, true);
  assert.equal(E.parseAdts(f, 1).ok, false, 'no sync at offset 1');
  assert.equal(E.parseAdts(f, f.length - 3).ok, false, 'too short');
  assert.equal(E.parseAdts(f, -1).ok, false);
  assert.equal(E.parseAdts(null, 0).ok, false);
  const badSr = Uint8Array.from(f); badSr[2] = (1 << 6) | (13 << 2); assert.equal(E.parseAdts(badSr, 0).ok, false, 'reserved sampling index');
  const badLayer = Uint8Array.from(f); badLayer[1] = 0xf7; assert.equal(E.parseAdts(badLayer, 0).ok, false, 'layer must be 0');
  const tiny = Uint8Array.from(f); tiny[3] = 0x40; tiny[4] = 0; tiny[5] = 0x1f | (5 << 5); assert.equal(E.parseAdts(tiny, 0).ok, false, 'frame_length smaller than header');
});

test('parseMpegAudioHeader: MPEG-1/2/2.5 layers, padding, mono, rejections', () => {
  deepEq(E.parseMpegAudioHeader(mp3Frame(1), 0), { ok: true, frameLength: 417, sampleRate: 44100, channels: 2, samplesPerFrame: 1152, bitrate: 128000, version: 1, layer: 3 });
  assert.equal(E.parseMpegAudioHeader(mp3Frame(1, 1), 0).frameLength, 418);
  assert.equal(E.parseMpegAudioHeader(mp3Frame(1, 0, false), 0).channels, 1);
  const v2l3 = E.parseMpegAudioHeader([0xff, 0xf3, 0x90, 0x00], 0);
  deepEq(v2l3, { ok: true, frameLength: 261, sampleRate: 22050, channels: 2, samplesPerFrame: 576, bitrate: 80000, version: 2, layer: 3 });
  const v25l3 = E.parseMpegAudioHeader([0xff, 0xe3, 0x94, 0x00], 0);
  assert.equal(v25l3.ok, true); assert.equal(v25l3.version, 2.5); assert.equal(v25l3.sampleRate, 12000); assert.equal(v25l3.samplesPerFrame, 576);
  const l1 = E.parseMpegAudioHeader([0xff, 0xff, 0x90, 0x00], 0);
  deepEq(l1, { ok: true, frameLength: 312, sampleRate: 44100, channels: 2, samplesPerFrame: 384, bitrate: 288000, version: 1, layer: 1 });
  const l2 = E.parseMpegAudioHeader([0xff, 0xfd, 0x90, 0x00], 0);
  assert.equal(l2.layer, 2); assert.equal(l2.bitrate, 160000); assert.equal(l2.samplesPerFrame, 1152); assert.equal(l2.frameLength, 522);
  assert.equal(E.parseMpegAudioHeader([0xff, 0xfb, 0x00, 0x00], 0).ok, false, 'free format');
  assert.equal(E.parseMpegAudioHeader([0xff, 0xfb, 0xf0, 0x00], 0).ok, false, 'bad bitrate index');
  assert.equal(E.parseMpegAudioHeader([0xff, 0xeb, 0x90, 0x00], 0).ok, false, 'reserved version');
  assert.equal(E.parseMpegAudioHeader([0xff, 0xf9, 0x90, 0x00], 0).ok, false, 'reserved layer');
  assert.equal(E.parseMpegAudioHeader([0xff, 0xfb, 0x9c, 0x00], 0).ok, false, 'reserved sample rate');
  assert.equal(E.parseMpegAudioHeader([0xff, 0xfb, 0x90], 0).ok, false, 'short');
  assert.equal(E.parseMpegAudioHeader([0xfe, 0xfb, 0x90, 0x00], 0).ok, false, 'no sync');
  assert.equal(E.parseMpegAudioHeader(undefined, 0).ok, false);
});

/* ================= tests: PAT / PMT ================= */
test('parsePat: programs, network pid skipped, first program wins; junk rejected', () => {
  const p = E.parsePat(patSection([[0, 0x10], [7, 0x1234], [8, 0x1235]]));
  assert.equal(p.ok, true); assert.equal(p.pmtPid, 0x1234); assert.equal(p.current, true); assert.equal(p.transportStreamId, 1);
  deepEq(p.programs, [{ programNumber: 7, pid: 0x1234 }, { programNumber: 8, pid: 0x1235 }]);
  assert.equal(E.parsePat(patSection([[0, 0x10]])).ok, false, 'no programs');
  assert.equal(E.parsePat(pmtSection([{ type: 0x1b, pid: 1 }])).ok, false, 'wrong table id');
  assert.equal(E.parsePat(new Uint8Array(5)).ok, false);
  assert.equal(E.parsePat(null).ok, false);
  const bad = Uint8Array.from(patSection()); bad[1] = 0xbf; bad[2] = 0xff; assert.equal(E.parsePat(bad).ok, false, 'section_length overflow');
});

test('parsePmt: stream types, pids, registration descriptor, pcr pid', () => {
  const sec = pmtSection([
    { type: 0x1b, pid: 0x41 }, { type: 0x0f, pid: 0x42 },
    { type: 0x06, pid: 0x43, descriptors: [0x05, 4, 0x49, 0x44, 0x33, 0x20, 0x0a, 1, 0x00] },
    { type: 0x81, pid: 0x44, descriptors: [0x0a, 4, 0x65, 0x6e, 0x67, 0] },
  ], 0x41, 3);
  const p = E.parsePmt(sec);
  assert.equal(p.ok, true); assert.equal(p.programNumber, 3); assert.equal(p.pcrPid, 0x41);
  deepEq(p.streams, [
    { streamType: 0x1b, pid: 0x41, registration: null }, { streamType: 0x0f, pid: 0x42, registration: null },
    { streamType: 0x06, pid: 0x43, registration: 'ID3 ' }, { streamType: 0x81, pid: 0x44, registration: null },
  ]);
  assert.equal(E.parsePmt(patSection()).ok, false);
  assert.equal(E.parsePmt(sec.subarray(0, 10)).ok, false);
  assert.equal(E.parsePmt('x').ok, false);
  const trunc = Uint8Array.from(sec); trunc[11] = 0xff; assert.equal(E.parsePmt(trunc).ok, true, 'program_info_length past end yields no streams, no throw');
  deepEq(E.parsePmt(trunc).streams, []);
});

/* ================= tests: the reference stream end to end ================= */
test('reference stream: PAT→PMT mapping, ignored streams, track metadata', () => {
  const r = E.tsDemux(REF);
  deepEq(r.errors, []);
  assert.equal(r.state.pmtPid, 0x1000); assert.equal(r.state.videoPid, VID); assert.equal(r.state.audioPid, AUD_PID); assert.equal(r.state.id3Pid, ID3_PID);
  assert.equal(r.state.audioKind, 'aac'); assert.equal(r.state.pcrPid, VID); assert.equal(r.state.programNumber, 1);
  deepEq(r.state.ignoredStreams, [{ pid: 0x103, streamType: 0x24 }]);
  assert.equal(r.video.codec, 'avc1.42c01e'); assert.equal(r.video.width, 320); assert.equal(r.video.height, 240); assert.equal(r.video.timescale, 90000);
  assert.equal(hex(r.video.sps), hex(SPS_BASE)); assert.equal(hex(r.video.pps), hex(PPS));
  assert.equal(r.audio.codec, 'mp4a.40.2'); assert.equal(r.audio.sampleRate, 48000); assert.equal(r.audio.channels, 1); assert.equal(r.audio.timescale, 48000);
  deepEq(r.audio.config, { objectType: 2, sampleRateIndex: 3, channels: 1 });
});

test('reference stream: video AUs → AVCC samples (AUD dropped, SPS/PPS/SEI kept), last AU on flush', () => {
  const r = E.tsDemux(REF);
  deepEq(viewSamples(r.video.samples), EXPECT_VIDEO().slice(0, 1), 'AU1 closed by AU2; AU2 waits for the still-open last PES');
  assert.ok(r.state.pes[VID], 'last unbounded PES still pending');
  const fin = E.tsFlush(r.state);
  deepEq(fin.errors, []);
  deepEq(viewSamples(fin.video.samples), EXPECT_VIDEO().slice(1), 'flush closes the pending PES and the last AU (inherits duration)');
  assert.equal(fin.state.pes[VID], undefined);
  assert.equal(fin.video.codec, 'avc1.42c01e');
  deepEq(viewSamples(E.tsFlush(fin.state).video.samples), [], 'second flush is a no-op');
});

test('reference stream: AAC frames with per-frame PTS, raw bodies, ID3 metadata', () => {
  const o = demuxAll([REF]);
  deepEq(o.errors, []);
  deepEq(viewAudio(o.audio), EXPECT_AUDIO());
  deepEq(o.id3.map(x => ({ pts: x.pts, data: hex(x.data) })), [{ pts: 90000, data: hex(ID3_DATA) }]);
});

test('determinism: the same input gives byte-identical output', () => {
  const a = demuxAll([REF]), b = demuxAll([REF]);
  deepEq({ v: viewSamples(a.video), a: viewAudio(a.audio), e: a.errors, s: a.state }, { v: viewSamples(b.video), a: viewAudio(b.audio), e: b.errors, s: b.state });
});

test('3-byte start codes produce the same samples as 4-byte ones', () => {
  const o = demuxAll([buildReference({ four: false })]);
  deepEq(o.errors, []);
  deepEq(viewSamples(o.video), EXPECT_VIDEO());
});

test('chunked at arbitrary byte offsets (mid-packet, mid-PES, mid-NAL) equals one-shot', () => {
  const one = demuxAll([REF]);
  const offsets = [[0, 1, 100, 377, 1000, 1511], [0, 200, 201, 202, 1888], [0, 187, 188, 189, 2000, 2001]];
  for (const offs of offsets) {
    const parts = demuxAll(cut(REF, offs));
    deepEq(parts.errors, [], 'offsets ' + offs);
    deepEq(viewSamples(parts.video), viewSamples(one.video), 'video ' + offs);
    deepEq(viewAudio(parts.audio), viewAudio(one.audio), 'audio ' + offs);
    deepEq(parts.id3.map(x => x.pts), one.id3.map(x => x.pts));
    deepEq(parts.state, one.state, 'final state identical');
  }
  // one byte at a time for the first 600 bytes (PAT, PMT and most of the first video PES)
  const chunks = []; for (let i = 0; i < 600; i++) chunks.push(REF.subarray(i, i + 1)); chunks.push(REF.subarray(600));
  const tiny = demuxAll(chunks);
  deepEq(tiny.errors, []);
  deepEq(viewSamples(tiny.video), viewSamples(one.video));
  deepEq(viewAudio(tiny.audio), viewAudio(one.audio));
});

test('PES split across packets and across tsDemux calls completes with state threading', () => {
  // the IDR PES spans 3 packets; cut inside its second packet and inside the audio PES
  const firstVideoPkt = 188 * 2;
  const o = demuxAll(cut(REF, [0, firstVideoPkt + 188 + 50, firstVideoPkt + 188 * 3 + 120]));
  deepEq(o.errors, []);
  deepEq(viewSamples(o.video), EXPECT_VIDEO());
  deepEq(viewAudio(o.audio), EXPECT_AUDIO());
  // a chunk that ends mid-PES yields nothing for that PES yet
  const r1 = E.tsDemux(REF.subarray(0, firstVideoPkt + 188 + 50));
  deepEq(r1.video.samples, []);
  assert.equal(r1.state.leftover.length, 50);
  assert.ok(r1.state.pes[VID], 'PES pending in state');
});

test('garbage before the first sync byte is skipped (logged), output unchanged', () => {
  const junk = randomBytes(333, 99);
  const o = demuxAll([cat(junk, REF)]);
  assert.ok(o.errors.some(e => e.type === 'sync'), JSON.stringify(o.errors));
  deepEq(viewSamples(o.video), EXPECT_VIDEO());
  deepEq(viewAudio(o.audio), EXPECT_AUDIO());
  // junk between packets (resync mid-stream)
  const mid = cat(REF.subarray(0, 188 * 4), filler(77, 5), REF.subarray(188 * 4));
  const o2 = demuxAll([mid]);
  assert.equal(o2.errors.filter(e => e.type === 'sync').length, 1);
  deepEq(viewSamples(o2.video), EXPECT_VIDEO());
});

test('truncated last packet stays in state and is discarded with an error on flush', () => {
  const r = E.tsDemux(REF.subarray(0, REF.length - 100));
  assert.equal(r.state.leftover.length, 88);
  deepEq(r.errors, []);
  const fin = E.tsFlush(r.state);
  assert.equal(fin.state.leftover, null);
  assert.ok(fin.errors.some(e => e.type === 'sync' && /partial packet/.test(e.message)));
  deepEq(viewSamples(fin.video.samples), EXPECT_VIDEO().slice(1));
  // trailing junk that is not a packet start is dropped with an error, not kept as leftover
  const r2 = E.tsDemux(cat(REF, filler(10, 8)));
  assert.equal(r2.state.leftover, null);
  assert.ok(r2.errors.some(e => e.type === 'sync'));
});

test('continuity counter gaps are logged per pid but demuxing continues', () => {
  const bytes = Uint8Array.from(REF);
  // packet index 3 is the second packet of the first video PES: bump its cc by 2
  const pkt = 188 * 3, idx = pkt + 3;
  assert.equal(((bytes[pkt + 1] & 0x1f) << 8) | bytes[pkt + 2], VID, 'test targets a video packet');
  assert.equal(bytes[pkt + 1] & 0x40, 0, 'and not a PES start');
  bytes[idx] = (bytes[idx] & 0xf0) | ((bytes[idx] + 2) & 0x0f);
  const o = demuxAll([bytes]);
  const gaps = o.errors.filter(e => e.type === 'continuity');
  assert.equal(gaps.length, 2, 'one gap going in, one coming back: ' + JSON.stringify(o.errors));
  assert.equal(gaps[0].pid, VID);
  deepEq(viewSamples(o.video), EXPECT_VIDEO());
  deepEq(viewAudio(o.audio), EXPECT_AUDIO());
});

test('adaptation-field-only packets (PCR carriers) are ignored and do not count as cc steps', () => {
  const m = new Mux();
  m.psi(0, patSection()).psi(0x1000, PMT_AV);
  m.afOnly(VID, 0x10).afOnly(VID, 0x10);
  m.es(VID, pes(0xe0, annexB([AUD, SPS_BASE, PPS, IDR]), { pts: 1000, unbounded: true }));
  m.afOnly(VID, 0x50);
  m.es(VID, pes(0xe0, annexB([AUD, P1]), { pts: 4600, unbounded: true }));
  m.afOnly(AUD_PID);
  const o = demuxAll([m.bytes()]);
  deepEq(o.errors, []);
  deepEq(viewSamples(o.video).map(s => [s.pts, s.key, s.duration]), [[1000, true, 3600], [4600, false, 3600]]);
});

test('PTS wraparound inside one state: samples stay monotonic across 2^33', () => {
  const base = WRAP - 3600;
  const o = demuxAll([buildReference({ basePts: base })]);
  deepEq(o.errors, []);
  deepEq(viewSamples(o.video).map(s => [s.pts, s.dts, s.duration]), [[base, base, 3600], [WRAP, WRAP, 3600], [WRAP + 3600, WRAP + 3600, 3600]]);
  deepEq(viewAudio(o.audio).map(s => s.pts), [0, 1, 2, 3, 4].map(i => base + i * 1920));
  assert.equal(o.id3[0].pts, base);
});

test('B-frames: DTS < PTS gives cts, durations from DTS deltas', () => {
  const m = new Mux();
  m.psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }]));
  const aus = [[7200, 0, [AUD, SPS_BASE, PPS, IDR]], [18000, 3600, [AUD, pSlice(30, 1)]], [10800, 7200, [AUD, pSlice(30, 2)]], [14400, 10800, [AUD, pSlice(30, 3)]]];
  for (const [pts, dts, nals] of aus) m.es(VID, pes(0xe0, annexB(nals), { pts, dts, unbounded: true }));
  const o = demuxAll([m.bytes()]);
  deepEq(o.errors, []);
  deepEq(viewSamples(o.video).map(s => [s.pts, s.dts, s.cts, s.key, s.duration]), [[7200, 0, 7200, true, 3600], [18000, 3600, 14400, false, 3600], [10800, 7200, 3600, false, 3600], [14400, 10800, 3600, false, 3600]]);
  assert.equal(o.audioTrack, null, 'no audio stream in PMT');
});

test('keyframe rules: IDR, recovery-point SEI without IDR, plain P frame', () => {
  const m = new Mux();
  m.psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }]));
  m.es(VID, pes(0xe0, annexB([AUD, SPS_BASE, PPS, SEI_RECOVERY, pSlice(40, 1)]), { pts: 0, unbounded: true }));
  m.es(VID, pes(0xe0, annexB([AUD, SEI_USER, pSlice(40, 2)]), { pts: 3600, unbounded: true }));
  m.es(VID, pes(0xe0, annexB([AUD, IDR]), { pts: 7200, unbounded: true }));
  const o = demuxAll([m.bytes()]);
  deepEq(o.errors, []);
  deepEq(viewSamples(o.video).map(s => s.key), [true, false, true]);
  // single sample in a state → default 3000-tick duration
  const single = demuxAll([new Mux().psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }])).es(VID, pes(0xe0, annexB([SPS_BASE, PPS, IDR]), { pts: 500, unbounded: true })).bytes()]);
  deepEq(viewSamples(single.video).map(s => [s.pts, s.duration, s.key]), [[500, 3000, true]]);
});

test('access-unit boundaries without AUDs: first_mb_in_slice==0 and SPS/PPS/SEI after a VCL NAL', () => {
  const m = new Mux();
  m.psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }]));
  // AU1 and AU2 share one PES (no AUD): AU2's timestamp must be extrapolated and reported
  m.es(VID, pes(0xe0, annexB([SPS_BASE, PPS, IDR, pSlice(30, 1), pSlice2(20, 2)]), { pts: 0, unbounded: true }));
  // AU3 starts with an SPS after a VCL NAL, in its own PES
  m.es(VID, pes(0xe0, annexB([SPS_BASE, PPS, pSlice(30, 3)]), { pts: 7200, unbounded: true }));
  const o = demuxAll([m.bytes()]);
  assert.equal(o.errors.length, 1); assert.equal(o.errors[0].type, 'video');
  const v = viewSamples(o.video);
  deepEq(v.map(s => [s.pts, s.dts, s.duration, s.key]), [[0, 0, 3000, true], [3000, 3000, 4200, false], [7200, 7200, 4200, false]]);
  assert.equal(v[1].data, hex(avcc([pSlice(30, 1), pSlice2(20, 2)])), 'second slice of the same picture stays in the AU');
});

test('NAL straddling two bounded PES packets (and three tsDemux calls) is reassembled', () => {
  const m = new Mux();
  m.psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }]));
  const big = idrSlice(900, 5), es = annexB([AUD, SPS_BASE, PPS, big]);
  const half = 400;
  m.es(VID, pes(0xe0, es.subarray(0, half), { pts: 100 }));              // bounded PES, ends mid-NAL
  m.es(VID, pes(0xe0, es.subarray(half), {}));                           // continuation: no PTS at all
  m.es(VID, pes(0xe0, annexB([AUD, pSlice(20, 6)]), { pts: 3700 }));
  const bytes = m.bytes();
  for (const chunks of [[bytes], cut(bytes, [0, 500, 800, 1300])]) {
    const o = demuxAll(chunks);
    deepEq(o.errors, []);
    deepEq(viewSamples(o.video), [
      { pts: 100, dts: 100, cts: 0, key: true, duration: 3600, data: hex(avcc([SPS_BASE, PPS, big])) },
      { pts: 3700, dts: 3700, cts: 0, key: false, duration: 3600, data: hex(avcc([pSlice(20, 6)])) },
    ]);
  }
});

test('AAC frame cut by a PES boundary completes in the next PES with the right PTS', () => {
  const m = new Mux();
  m.psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x0f, pid: AUD_PID }]));
  const f = [adtsFrame(filler(100, 1)), adtsFrame(filler(100, 2)), adtsFrame(filler(100, 3))];
  const all = cat(...f), splitAt = f[0].length + 60;
  m.es(AUD_PID, pes(0xc0, all.subarray(0, splitAt), { pts: 1000 }));
  m.es(AUD_PID, pes(0xc0, all.subarray(splitAt), { pts: 1000 + 2 * 1920 })); // PTS of the first frame STARTING here
  // and a frame whose header itself is cut (3 bytes in the first PES)
  const g = [adtsFrame(filler(30, 4)), adtsFrame(filler(30, 5))], gall = cat(...g);
  m.es(AUD_PID, pes(0xc0, gall.subarray(0, g[0].length + 3), { pts: 1000 + 3 * 1920 }));
  m.es(AUD_PID, pes(0xc0, gall.subarray(g[0].length + 3), { pts: 1000 + 5 * 1920 }));
  const bytes = m.bytes();
  for (const chunks of [[bytes], cut(bytes, [0, 300, 301, 700])]) {
    const o = demuxAll(chunks);
    deepEq(o.errors, []);
    deepEq(viewAudio(o.audio).map(s => [s.pts, s.data.length / 2]), [[1000, 100], [2920, 100], [4840, 100], [6760, 30], [8680, 30]]);
    assert.equal(o.audioTrack.sampleRate, 48000);
    assert.equal(o.videoTrack, null);
  }
});

test('MP3 in TS (stream type 0x03): frames split on headers, 1152-sample durations, 44.1 kHz PTS spacing', () => {
  const m = new Mux();
  m.psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x03, pid: AUD_PID }]));
  const frames = [mp3Frame(1), mp3Frame(2, 1), mp3Frame(3), mp3Frame(4, 1)];
  m.es(AUD_PID, pes(0xc0, cat(frames[0], frames[1], frames[2]), { pts: 5000 }));
  m.es(AUD_PID, pes(0xc0, frames[3], { pts: 5000 + 7053 }));
  const r0 = E.tsDemux(m.bytes().subarray(0, 188 * 2));
  assert.equal(r0.audio.codec, 'mp3', 'codec known from the PMT before any frame');
  assert.equal(r0.audio.sampleRate, null);
  const o = demuxAll([m.bytes()]);
  deepEq(o.errors, []);
  assert.equal(o.audioTrack.codec, 'mp3'); assert.equal(o.audioTrack.sampleRate, 44100); assert.equal(o.audioTrack.channels, 2); assert.equal(o.audioTrack.config, null); assert.equal(o.audioTrack.timescale, 44100);
  deepEq(viewAudio(o.audio), frames.map((f, i) => ({ pts: 5000 + Math.round(i * 1152 * 90000 / 44100), dts: 5000 + Math.round(i * 1152 * 90000 / 44100), duration: 1152, data: hex(f) })));
  // MPEG-2 audio stream type (0x04) also maps to mp3
  const m2 = new Mux().psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x04, pid: AUD_PID }]));
  assert.equal(E.tsDemux(m2.bytes()).audio.codec, 'mp3');
});

test('audio: junk between frames is resynced, PES without PTS is extrapolated, both logged', () => {
  const m = new Mux();
  m.psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x0f, pid: AUD_PID }]));
  m.es(AUD_PID, pes(0xc0, cat(adtsFrame(filler(20, 1)), filler(13, 9), adtsFrame(filler(20, 2))), { pts: 100 }));
  m.es(AUD_PID, pes(0xc0, adtsFrame(filler(20, 3)), {}));
  m.es(AUD_PID, pes(0xc0, filler(40, 4), { pts: 9999 })); // no frame at all
  const o = demuxAll([m.bytes()]);
  deepEq(viewAudio(o.audio).map(s => s.pts), [100, 2020, 3940]);
  deepEq(o.errors.map(e => e.type), ['audio', 'audio', 'audio']);
  assert.match(o.errors[0].message, /13 bytes skipped/);
  assert.match(o.errors[1].message, /without PTS/);
  assert.match(o.errors[2].message, /without a frame sync/);
});

test('ID3 via private PES (0x06) with an "ID3 " registration descriptor; several tags', () => {
  const m = new Mux();
  m.psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }, { type: 0x06, pid: ID3_PID, descriptors: [0x05, 4, 0x49, 0x44, 0x33, 0x20] }]));
  m.es(ID3_PID, pes(0xbd, ID3_DATA, { pts: 10 }));
  m.es(ID3_PID, pes(0xbd, filler(300, 2), { pts: 20 }));
  const o = demuxAll([m.bytes()]);
  deepEq(o.errors, []);
  assert.equal(o.state.id3Pid, ID3_PID);
  deepEq(o.id3.map(x => [x.pts, x.data.length]), [[10, ID3_DATA.length], [20, 300]]);
});

test('PMT with no supported streams: tracks null, everything listed as ignored', () => {
  const m = new Mux().psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x24, pid: 0x41 }, { type: 0x81, pid: 0x42 }, { type: 0x11, pid: 0x43 }]));
  m.es(0x41, pes(0xe0, filler(100, 1), { pts: 1 }));
  const r = E.tsDemux(m.bytes());
  deepEq(r.errors, []);
  assert.equal(r.video, null); assert.equal(r.audio, null);
  deepEq(r.state.ignoredStreams, [{ pid: 0x41, streamType: 0x24 }, { pid: 0x42, streamType: 0x81 }, { pid: 0x43, streamType: 0x11 }]);
  // a second H.264 / AAC stream is ignored, the first of each kind is used
  const r2 = E.tsDemux(new Mux().psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: 0x50 }, { type: 0x1b, pid: 0x51 }, { type: 0x0f, pid: 0x52 }, { type: 0x03, pid: 0x53 }])).bytes());
  assert.equal(r2.state.videoPid, 0x50); assert.equal(r2.state.audioPid, 0x52); assert.equal(r2.state.audioKind, 'aac');
  deepEq(r2.state.ignoredStreams, [{ pid: 0x51, streamType: 0x1b }, { pid: 0x53, streamType: 0x03 }]);
});

test('PSI section spanning two packets and a pointer_field offset both parse', () => {
  const many = []; for (let i = 0; i < 60; i++) many.push({ type: 0x24, pid: 0x200 + i });
  many.push({ type: 0x1b, pid: VID });
  const bigPmt = pmtSection(many);
  assert.ok(bigPmt.length > 184, 'fixture PMT spans packets');
  const m = new Mux().psi(0, patSection()).psi(0x1000, bigPmt);
  const r = E.tsDemux(m.bytes());
  deepEq(r.errors, []);
  assert.equal(r.state.videoPid, VID); assert.equal(r.state.ignoredStreams.length, 60);
  // pointer_field = 3 with three stuffing bytes before the PAT
  const m2 = new Mux();
  m2.packets.push(tsPacket(0, 0, cat([3, 0xff, 0xff, 0xff], patSection()), { pusi: true }));
  m2.psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }]));
  assert.equal(E.tsDemux(m2.bytes()).state.videoPid, VID);
});

test('PES header problems are reported, not thrown; stream ids without a header carry no PTS', () => {
  const m = new Mux().psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }, { type: 0x15, pid: ID3_PID }]));
  m.es(VID, pes(0xe0, annexB([AUD, SPS_BASE, PPS, IDR]), { pts: 0, unbounded: true }));
  m.packets.push(tsPacket(VID, m.next(VID), cat([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 0], filler(20, 1)), { pusi: true })); // PTS flagged, header_data_length 0
  m.packets.push(tsPacket(VID, m.next(VID), filler(100, 2), { pusi: true }));                                          // PUSI without a start code
  m.es(ID3_PID, pes(0xbf, ID3_DATA, { noHeader: true }));                                                            // private_stream_2: no optional header
  m.es(VID, pes(0xe0, annexB([AUD, pSlice(20, 3)]), { pts: 3600, unbounded: true }));
  const o = demuxAll([m.bytes()]);
  deepEq(o.errors.map(e => e.type), ['pes', 'pes', 'pes']);
  assert.match(o.errors[0].message, /PTS flagged/); assert.match(o.errors[1].message, /truncated/); assert.match(o.errors[2].message, /missing start code/);
  deepEq(viewSamples(o.video).map(s => [s.pts, s.key]), [[0, true], [3600, false]]);
  deepEq(o.id3.map(x => [x.pts, hex(x.data)]), [[null, hex(ID3_DATA)]]);
});

test('bounded PES cut short by the next PUSI is flagged as truncated and still parsed', () => {
  const m = new Mux().psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x0f, pid: AUD_PID }]));
  const full = pes(0xc0, cat(adtsFrame(filler(30, 1)), adtsFrame(filler(30, 2))), { pts: 100 });
  m.packets.push(tsPacket(AUD_PID, m.next(AUD_PID), full.subarray(0, 60), { pusi: true }));
  m.es(AUD_PID, pes(0xc0, adtsFrame(filler(30, 3)), { pts: 100 + 2 * 1920 }));
  const o = demuxAll([m.bytes()]);
  assert.equal(o.errors.filter(e => e.type === 'pes' && /truncated/.test(e.message)).length, 1);
  deepEq(viewAudio(o.audio).map(s => s.pts), [100, 3940], 'first frame of the cut PES survives, the partial one is dropped');
  deepEq(o.errors.map(e => e.type), ['pes', 'audio']);
  assert.match(o.errors[1].message, /partial frame discarded/);
  // same for video: a truncated bounded PES drops its open NAL instead of gluing it to the next PES
  const mv = new Mux().psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }]));
  const vfull = pes(0xe0, annexB([AUD, SPS_BASE, PPS, IDR]), { pts: 0 });
  mv.packets.push(tsPacket(VID, mv.next(VID), vfull.subarray(0, 150), { pusi: true }));
  mv.es(VID, pes(0xe0, annexB([AUD, pSlice(20, 3)]), { pts: 3600 }));
  const ov = demuxAll([mv.bytes()]);
  deepEq(ov.errors.map(e => e.type), ['pes', 'video']);
  deepEq(viewSamples(ov.video).map(s => [s.pts, s.key, s.data === hex(avcc([SPS_BASE, PPS, pSlice(20, 3)]))]), [[3600, false, true]], 'the cut IDR is gone, SPS/PPS carried into the next AU with its timing');
  assert.equal(hex(ov.videoTrack.sps), hex(SPS_BASE));
});

test('transport_error_indicator, scrambled, null and unknown-pid packets are ignored safely', () => {
  const m = new Mux().psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }]));
  const tei = tsPacket(VID, 0, filler(184, 1), { pusi: true }); tei[1] |= 0x80; m.raw(tei);
  const scr = tsPacket(VID, 1, filler(184, 2), { pusi: true }); scr[3] |= 0x80; m.raw(scr);
  m.raw(tsPacket(0x1fff, 0, filler(184, 3)));
  m.raw(tsPacket(0x777, 0, filler(184, 4), { pusi: true }));
  const rsv = tsPacket(VID, 2, filler(184, 5)); rsv[3] &= 0xcf; m.raw(rsv); // adaptation_field_control 00
  m.es(VID, pes(0xe0, annexB([AUD, SPS_BASE, PPS, IDR]), { pts: 0, unbounded: true }));
  const o = demuxAll([m.bytes()]);
  deepEq(o.errors.map(e => e.type), ['tei', 'scrambled']);
  deepEq(viewSamples(o.video).map(s => [s.pts, s.key]), [[0, true]]);
});

test('PMT change mid-stream remaps pids and resets half-built data', () => {
  const m = new Mux().psi(0, patSection()).psi(0x1000, pmtSection([{ type: 0x1b, pid: VID }]));
  m.es(VID, pes(0xe0, annexB([AUD, SPS_BASE, PPS, IDR]), { pts: 0, unbounded: true }));
  m.packets.push(tsPacket(VID, m.next(VID), annexB([AUD]).subarray(0, 3), { pusi: true })); // dangling partial PES
  m.psi(0x1000, pmtSection([{ type: 0x1b, pid: 0x300 }, { type: 0x0f, pid: 0x301 }]));
  m.es(0x300, pes(0xe0, annexB([AUD, SPS_BASE, PPS, IDR]), { pts: 9000, unbounded: true }));
  m.es(0x301, pes(0xc0, adtsFrame(filler(10, 1)), { pts: 9000 }));
  const o = demuxAll([m.bytes()]);
  assert.equal(o.state.videoPid, 0x300); assert.equal(o.state.audioPid, 0x301);
  deepEq(viewSamples(o.video).map(s => [s.pts, s.key, s.duration]), [[0, true, 3000], [9000, true, 3000]], 'old stream flushed on remap');
  deepEq(viewAudio(o.audio).map(s => s.pts), [9000]);
  deepEq(o.errors.map(e => e.type), ['pes'], 'only the dangling 3-byte PES is reported');
});

test('junk input never throws: random bytes, fake syncs, text, empty, null, objects', () => {
  const shapes = [];
  const inputs = [new Uint8Array(0), randomBytes(10000, 1), randomBytes(100000, 2), filler(5000, 3), Uint8Array.from('not a transport stream'.split('').map(c => c.charCodeAt(0))), null, undefined, 'string', 42, {}, [], [1, 2, 3], REF.buffer, new DataView(REF.buffer)];
  // every 188th byte is 0x47 but the rest is noise: PAT/PMT/PES parsers see garbage
  const fake = randomBytes(188 * 40, 4); for (let i = 0; i < fake.length; i += 188) { fake[i] = 0x47; fake[i + 1] &= 0x1f; }
  inputs.push(fake);
  for (const inp of inputs) {
    const r = E.tsDemux(inp);
    assert.ok(r && Array.isArray(r.errors) && Array.isArray(r.id3) && r.state, 'result shape');
    assert.ok(r.errors.length <= 101, 'errors are capped');
    const f = E.tsFlush(r.state);
    assert.ok(Array.isArray(f.errors));
    shapes.push(JSON.stringify({ v: r.video, a: r.audio }));
    // a state that went through junk still demuxes a good stream
    const o = demuxAll([REF], f.state);
    if (o.video.length) deepEq(viewSamples(o.video).map(s => s.pts), [90000, 93600, 97200]);
  }
  assert.ok(E.tsDemux('string').errors[0].type === 'input');
  assert.ok(E.tsDemux(randomBytes(3000, 7)).errors.some(e => e.type === 'sync'));
  // junk states: every slot that should hold bytes, numbers or buffers filled with the wrong thing
  const junkStates = [null, 1, 'x', {}, [], { v: 1, video: null, pes: 'nope' }, { leftover: 'abc' }, { videoPid: VID },
    { pes: { 7: 1, 8: { chunks: 'x' }, 9: { chunks: [1, 2], size: 2 } }, psi: { 0: 'z', 1: { buf: 3 } }, cc: { 1: 'a', 2: null } },
    { video: { au: 5, pending: 'x', sps: 'sps', pps: 7, pendingTiming: {} }, audio: { remainder: [1, 2], config: 'c' } },
    { video: { au: { nals: [1, 'x', null], hasVcl: true }, lastDuration: 'abc', lastDts: {} }, audio: { sampleRate: 'hz', lastPts: [] }, audioKind: 'opus', audioPid: 'a', videoPid: '1' },
    { video: { pending: new Uint8Array([0, 0, 1, 0x65, 0x88]), pendingTiming: 'now' } }];
  for (const st of junkStates) {
    const r = E.tsDemux(REF, st);
    assert.ok(Array.isArray(r.errors));
    assert.ok(Array.isArray(E.tsFlush(r.state).errors));
    // a junk state may legitimately hold a real pending NAL (last case): it is emitted first, with an error
    const good = demuxAll([REF], st);
    deepEq(viewSamples(good.video).slice(-3), EXPECT_VIDEO(), 'good stream after junk state ' + JSON.stringify(st));
    assert.ok(good.video.length === 3 || good.errors.some(e => e.type === 'video'), 'extra samples come with an error');
    deepEq(viewAudio(good.audio), EXPECT_AUDIO());
  }
});

test('junk payloads on real pids: random PES bodies and random PSI sections', () => {
  const m = new Mux().psi(0, patSection()).psi(0x1000, PMT_AV);
  for (let i = 0; i < 20; i++) {
    m.es(VID, pes(0xe0, randomBytes(500 + i * 37, 100 + i), { pts: i * 3600, unbounded: i % 2 === 0 }));
    m.es(AUD_PID, pes(0xc0, randomBytes(300 + i * 13, 200 + i), { pts: i * 1920 }));
    m.es(ID3_PID, pes(0xbd, randomBytes(50, 300 + i), { pts: i }));
    m.psi(0x1000, randomBytes(100, 400 + i));
    m.psi(0, randomBytes(60, 500 + i));
  }
  const bytes = m.bytes();
  const o = demuxAll([bytes]);
  assert.ok(o.errors.length > 0 && o.errors.length <= 102);
  const chunked = demuxAll(cut(bytes, [0, 777, 5000, 12345]));
  deepEq(viewSamples(chunked.video), viewSamples(o.video), 'junk is deterministic across chunking too');
  deepEq(viewAudio(chunked.audio), viewAudio(o.audio));
});

/* ================= tests: real fixtures via ffmpeg / ffprobe ================= */
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
if (!haveFfmpeg) {
  console.log('  (ffmpeg/ffprobe not on PATH — skipping real-fixture cross-checks)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'aerial-ts-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const V = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25'];
  const A = (sr = 48000) => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${sr}`];
  const X264 = (profile, extra) => ['-c:v', 'libx264', '-profile:v', profile, '-pix_fmt', 'yuv420p', '-g', '25', ...extra];
  const FIXTURES = {
    baseline: [...V, ...A(), '-t', '2', ...X264('baseline', ['-bf', '0']), '-c:a', 'aac', '-b:a', '64k'],
    high: [...V, ...A(), '-t', '2', ...X264('high', ['-bf', '2', '-x264-params', 'bframes=2:b-pyramid=0']), '-c:a', 'aac', '-b:a', '64k'],
    audio: [...A(), '-t', '2', '-c:a', 'aac', '-b:a', '64k'],
    mp3: [...V, ...A(44100), '-t', '2', ...X264('baseline', ['-bf', '0']), '-c:a', 'libmp3lame', '-b:a', '64k'],
  };
  const files = {};
  for (const [name, args] of Object.entries(FIXTURES)) {
    const out = join(dir, name + '.ts');
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args, '-f', 'mpegts', out]);
    if (r.status !== 0) { console.log(`  (ffmpeg failed for ${name}: ${r.stderr}) — skipping`); continue; }
    files[name] = readFileSync(out);
  }
  const probe = (file, ...args) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', ...args, file]).stdout);
  const PROFILE_IDC = { 'Baseline': 66, 'Constrained Baseline': 66, 'Main': 77, 'Extended': 88, 'High': 100, 'High 10': 110, 'High 4:2:2': 122, 'High 4:4:4 Predictive': 244 };

  for (const name of Object.keys(files)) {
    const file = join(dir, name + '.ts'), bytes = new Uint8Array(files[name]);
    const streams = probe(file, '-show_streams').streams;
    const vStream = streams.find(s => s.codec_type === 'video'), aStream = streams.find(s => s.codec_type === 'audio');
    const vPackets = vStream ? probe(file, '-show_packets', '-select_streams', 'v:0').packets : [];
    const aPackets = aStream ? probe(file, '-show_packets', '-select_streams', 'a:0').packets : [];

    test(`ffmpeg ${name}: demuxes cleanly and matches ffprobe streams`, () => {
      const o = demuxAll([bytes]);
      deepEq(o.errors, []);
      if (vStream) {
        assert.ok(o.videoTrack, 'video track present');
        assert.equal(o.videoTrack.width, vStream.width); assert.equal(o.videoTrack.height, vStream.height);
        const sps = E.parseSps(o.videoTrack.sps);
        assert.equal(sps.ok, true);
        assert.equal(sps.width, vStream.width); assert.equal(sps.height, vStream.height);
        assert.equal(sps.profileIdc, PROFILE_IDC[vStream.profile], 'profile ' + vStream.profile);
        assert.equal(sps.levelIdc, vStream.level);
        if (vStream.profile === 'Constrained Baseline') assert.ok(sps.constraintFlags & 0x40, 'constraint_set1_flag');
        assert.equal(o.videoTrack.codec, 'avc1.' + [sps.profileIdc, sps.constraintFlags, sps.levelIdc].map(n => n.toString(16).padStart(2, '0')).join(''));
        assert.equal(E.nalType(o.videoTrack.sps), 7); assert.equal(E.nalType(o.videoTrack.pps), 8);
        assert.equal(o.videoTrack.timescale, 90000);
      } else assert.equal(o.videoTrack, null);
      if (aStream) {
        assert.ok(o.audioTrack, 'audio track present');
        assert.equal(o.audioTrack.sampleRate, +aStream.sample_rate);
        assert.equal(o.audioTrack.channels, aStream.channels);
        assert.equal(o.audioTrack.timescale, +aStream.sample_rate);
        assert.equal(o.audioTrack.codec, aStream.codec_name === 'aac' ? 'mp4a.40.2' : 'mp3');
        if (aStream.codec_name === 'aac') deepEq(o.audioTrack.config, { objectType: 2, sampleRateIndex: E.parseAdts(adtsFrame(new Uint8Array(1), { srIndex: [96000, 88200, 64000, 48000, 44100].indexOf(+aStream.sample_rate) }), 0).sampleRateIndex, channels: aStream.channels });
      }
    });

    if (vStream) test(`ffmpeg ${name}: every video sample's pts/dts/keyframe matches ffprobe packets`, () => {
      const o = demuxAll([bytes]);
      assert.equal(o.video.length, vPackets.length, 'sample count');
      for (let i = 0; i < vPackets.length; i++) {
        const s = o.video[i], p = vPackets[i];
        assert.equal(s.pts, +p.pts, `pts of sample ${i}`); assert.equal(s.dts, +p.dts, `dts of sample ${i}`);
        assert.equal(s.cts, s.pts - s.dts);
        assert.equal(s.key, p.flags.includes('K'), `key flag of sample ${i}`);
        assert.equal(s.duration, +p.duration, `duration of sample ${i}`);
        assert.ok(s.data.length > 4);
        // sample data is AVCC: walk the length prefixes to the end exactly, no AUD inside
        let off = 0; const types = [];
        while (off < s.data.length) { const n = E.u32be(s.data, off); types.push(s.data[off + 4] & 0x1f); off += 4 + n; }
        assert.equal(off, s.data.length, 'AVCC lengths add up');
        assert.ok(!types.includes(9), 'AUD dropped');
        assert.ok(types.some(t => t === 1 || t === 5), 'has a slice');
      }
      assert.equal(o.video.filter(s => s.key).length, vPackets.filter(p => p.flags.includes('K')).length);
      if (name === 'high') assert.ok(o.video.some(s => s.cts > 0), 'B-frames give positive cts');
      assert.equal(hex(o.video[0].data).indexOf(hex(o.videoTrack.sps)) > 0, true, 'first sample carries the SPS inline');
    });

    if (aStream) test(`ffmpeg ${name}: audio frame count and PTS match ffprobe packets`, () => {
      const o = demuxAll([bytes]);
      assert.equal(o.audio.length, aPackets.length, 'frame count');
      const spf = aStream.codec_name === 'aac' ? 1024 : 1152;
      for (let i = 0; i < aPackets.length; i++) {
        const s = o.audio[i], p = aPackets[i];
        assert.ok(Math.abs(s.pts - +p.pts) <= 1, `pts of frame ${i}: ${s.pts} vs ${p.pts}`);
        assert.equal(s.dts, s.pts);
        assert.equal(s.duration, spf);
        assert.ok(s.data.length > 0);
        if (aStream.codec_name === 'aac') assert.equal(s.data.length, +p.size - 7, `raw frame ${i} is the ADTS frame minus its header`);
        else assert.equal(s.data.length, +p.size, `mp3 frame ${i} size`);
      }
    });

    test(`ffmpeg ${name}: chunked at arbitrary offsets with state threading equals one-shot`, () => {
      const one = demuxAll([bytes]);
      for (const offs of [[0, 1001, 50007], [0, 7, 8, 9, 33333, 70001], [0, Math.floor(bytes.length / 3) + 5, Math.floor(2 * bytes.length / 3) + 11]]) {
        const parts = demuxAll(cut(bytes, offs.filter(o2 => o2 < bytes.length)));
        deepEq(parts.errors, []);
        deepEq(viewSamples(parts.video), viewSamples(one.video), 'video ' + offs);
        deepEq(viewAudio(parts.audio), viewAudio(one.audio), 'audio ' + offs);
        assert.equal(parts.results.length, offs.filter(o2 => o2 < bytes.length).length + 1);
        deepEq(parts.state, one.state);
      }
    });
  }
}

test('fixed clock is unused by the demuxer (pure): results do not depend on NOW', () => {
  assert.equal(typeof NOW, 'number');
  deepEq(viewSamples(demuxAll([REF]).video), EXPECT_VIDEO());
});

run();
