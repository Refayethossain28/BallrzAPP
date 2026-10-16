// Tests for the MP4 section of the Aerial engine: fragmented-MP4 muxer (init + media segments) and the
// tolerant box parser. Byte layouts are checked against hand-computed hex (ISO 14496-12/14/15), and when
// ffmpeg/ffprobe are installed a real fMP4 is demuxed with the parser, re-muxed with the muxer, and the
// result is verified by ffprobe/ffmpeg (streams, packets, frame counts, clean decode).
// mp4ParseBoxes returns an ARRAY of boxes carrying a boolean `truncated` property (not {boxes, truncated}).
// Run: node scripts/_parts/assemble.mjs && node scripts/_parts/test-mp4.mjs
import { loadEngine, runner, deepEq } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const E = loadEngine();
const { test, run, assert } = runner('mp4');
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

/* ---------- helpers (independent of the engine's writers) ---------- */
const H = (s) => s.replace(/\s+/g, '').toLowerCase();          // spaced hex → compact hex
const hex = (b) => E.hexOf(b);
const u32 = (n) => (n >>> 0).toString(16).padStart(8, '0');
const u16 = (n) => (n & 0xffff).toString(16).padStart(4, '0');
const u64 = (n) => u32(Math.floor(n / 4294967296)) + u32(n >>> 0);
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
// Test-side box builder: computes the size from the hex payload, so sizes are derived here, not in the engine.
const box = (type, ...hexParts) => { const body = H(hexParts.join('')); return u32(8 + body.length / 2) + ascii(type) + body; };
const full = (type, version, flags, ...hexParts) => box(type, u32((version << 24) | flags), ...hexParts);
const bytesOf = (hexStr) => E.bytesOfHex(H(hexStr));
const bytesEq = (a, b, m) => assert.equal(hex(a), hex(b), m);
const strip = (b) => { const { data, children, ...rest } = b; return rest; }; // box details without views

const SPS = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x6a, 0x02, 0x02, 0x02, 0x80, 0x00, 0x00, 0x03, 0x00, 0x80, 0x00, 0x00, 0x19, 0x07, 0x8c, 0x18, 0xcb]);
const PPS = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]);
const VIDEO = { id: 1, type: 'video', timescale: 90000, width: 640, height: 360, sps: SPS, pps: PPS };
const AUDIO = { id: 2, type: 'audio', timescale: 48000, codec: 'mp4a.40.2', audio: { objectType: 2, sampleRateIndex: 3, sampleRate: 48000, channels: 2 } };
const MP3 = { id: 3, type: 'audio', timescale: 44100, codec: 'mp3', audio: { sampleRate: 44100, channels: 2 } };
const SAMPLES2 = [
  { data: new Uint8Array([1, 2, 3]), duration: 3000, cts: 3600, key: true },
  { data: new Uint8Array([4, 5]), duration: 3000, cts: -3600, key: false }
];

/* ---------- hand-computed expectations ---------- */
const MATRIX = '00010000 00000000 00000000 00000000 00010000 00000000 00000000 00000000 40000000';
const FTYP = '00000020 66747970 69736f35 00000001 69736f35 69736f36 6d703431 61766331';
const MVHD = '0000006c 6d766864 00000000 00000000 00000000 000003e8 00000000 00010000 0100 0000 00000000 00000000 ' + MATRIX + ' 00000000 00000000 00000000 00000000 00000000 00000000 00000003';
const TREX1 = '00000020 74726578 00000000 00000001 00000001 00000000 00000000 00000000';
const AVCC = '01 64 00 1f ff e1 001c ' + hex(SPS) + ' 01 0006 ' + hex(PPS) + ' fd f8 f8 00';
const ESDS_AAC = '00000027 65736473 00000000 03 19 0000 00 04 11 40 15 000000 00000000 00000000 05 02 1190 06 01 02';
const ESDS_MP3 = '00000023 65736473 00000000 03 15 0000 00 04 0d 6b 15 000000 00000000 00000000 06 01 02';
function expectedInit() {
  const avc1 = box('avc1', '000000000000 0001 0000 0000 000000000000000000000000 0280 0168 00480000 00480000 00000000 0001', '00'.repeat(32), '0018 ffff', box('avcC', AVCC));
  const mp4a = box('mp4a', '000000000000 0001 0000000000000000 0002 0010 0000 0000 bb80 0000', ESDS_AAC);
  const emptyTables = full('stts', 0, 0, '00000000') + full('stsc', 0, 0, '00000000') + full('stsz', 0, 0, '00000000 00000000') + full('stco', 0, 0, '00000000');
  const dinf = box('dinf', full('dref', 0, 0, '00000001', full('url ', 0, 1)));
  const trak = (id, video) => box('trak',
    full('tkhd', 0, 7, '00000000 00000000', u32(id), '00000000 00000000 00000000 00000000 0000 0000', video ? '0000' : '0100', '0000', MATRIX, video ? '02800000 01680000' : '00000000 00000000'),
    box('mdia',
      full('mdhd', 0, 0, '00000000 00000000', u32(video ? 90000 : 48000), '00000000 55c4 0000'),
      full('hdlr', 0, 0, '00000000', ascii(video ? 'vide' : 'soun'), '000000000000000000000000', ascii(video ? 'VideoHandler' : 'SoundHandler'), '00'),
      box('minf', video ? full('vmhd', 0, 1, '0000000000000000') : full('smhd', 0, 0, '00000000'), dinf,
        box('stbl', full('stsd', 0, 0, '00000001', video ? avc1 : mp4a), emptyTables))));
  return FTYP + box('moov', MVHD, trak(1, true), trak(2, false), box('mvex', TREX1, TREX1.replace('00000001 00000001', '00000002 00000001')));
}
const EXPECTED_INIT = H(expectedInit());
// moof(2 samples) = 8 + mfhd 16 + traf(8 + tfhd 16 + tfdt 20 + trun 52) = 120 → data_offset 128 (0x80)
const MOOF2 = '00000078 6d6f6f66 00000010 6d666864 00000000 00000007 00000060 74726166 00000010 74666864 00020000 00000001 00000014 74666474 01000000 0000000000000bb8 00000034 7472756e 01000f01 00000002 00000080 00000bb8 00000003 02000000 00000e10 00000bb8 00000002 01010000 fffff1f0';
const MDAT2 = '0000000d 6d646174 0102030405';

/* ===================== mp4Box / mp4FullBox ===================== */
test('mp4Box: size + type + payloads, in order', () => {
  bytesEq(E.mp4Box('free', new Uint8Array([1, 2]), [3], new Uint8Array([4]).buffer), bytesOf('0000000c 66726565 01020304'));
  bytesEq(E.mp4Box('skip'), bytesOf('00000008 736b6970'));
});
test('mp4Box: junk payloads skipped, odd types padded/truncated, never throws', () => {
  bytesEq(E.mp4Box('free', null, undefined, 'nope', {}, 42), bytesOf('00000008 66726565'));
  bytesEq(E.mp4Box('ab'), bytesOf('00000008 61622020'));
  bytesEq(E.mp4Box('toolong'), bytesOf('00000008 746f6f6c'));
  bytesEq(E.mp4Box(null), bytesOf('00000008 20202020'));
  bytesEq(E.mp4Box('wrap', [256, -1, 1.7]), bytesOf('0000000b 77726170 00ff01'));
});
test('mp4FullBox: version/flags header then payloads', () => {
  bytesEq(E.mp4FullBox('tfdt', 1, 0, new Uint8Array(8)), bytesOf('00000014 74666474 01000000 0000000000000000'));
  bytesEq(E.mp4FullBox('tfhd', 0, 0x020000, [0, 0, 0, 1]), bytesOf('00000010 74666864 00020000 00000001'));
  bytesEq(E.mp4FullBox('x', 300, 0x1ffffff), bytesOf('0000000c 78202020 ffffffff'), 'version/flags clamped to their widths');
  bytesEq(E.mp4FullBox('x', 'junk', null), bytesOf('0000000c 78202020 00000000'));
});

/* ===================== init segment ===================== */
test('init: ftyp bytes exactly (iso5 / 1 / iso5 iso6 mp41 avc1)', () => {
  bytesEq(E.mp4InitSegment([VIDEO]).subarray(0, 32), bytesOf(FTYP));
});
test('init: whole ftyp+moov byte-for-byte against the hand-built layout', () => {
  const init = E.mp4InitSegment([VIDEO, AUDIO]);
  assert.equal(init.length, 1116);
  assert.equal(hex(init), EXPECTED_INIT);
});
test('init: mvhd / trex / avcC / esds boxes exactly', () => {
  const init = E.mp4InitSegment([VIDEO, AUDIO]);
  const boxes = E.mp4ParseBoxes(init);
  const slice = (b) => init.subarray(b.offset, b.offset + b.size);
  bytesEq(slice(E.mp4FindBox(boxes, 'mvhd')), bytesOf(MVHD));
  const trexes = E.mp4FindBox(boxes, 'mvex').children;
  bytesEq(slice(trexes[0]), bytesOf(TREX1));
  assert.equal(trexes.length, 2);
  assert.equal(E.mp4FindBox(boxes, 'avcC').size, 57);
  bytesEq(E.mp4FindBox(boxes, 'avcC').data, bytesOf(AVCC));
  bytesEq(slice(E.mp4FindBox(boxes, 'esds')), bytesOf(ESDS_AAC));
});
test('init: parsed structure and fields', () => {
  const boxes = E.mp4ParseBoxes(E.mp4InitSegment([VIDEO, AUDIO]));
  assert.equal(boxes.truncated, false);
  deepEq(boxes.map((b) => b.type), ['ftyp', 'moov']);
  const moov = boxes[1];
  deepEq(moov.children.map((b) => b.type), ['mvhd', 'trak', 'trak', 'mvex']);
  deepEq(strip(moov.children[0]), { type: 'mvhd', size: 108, offset: 40, headerSize: 8, version: 0, flags: 0, timescale: 1000, duration: 0, nextTrackId: 3 });
  const [vt, at] = moov.children.slice(1, 3);
  deepEq(vt.children.map((b) => b.type), ['tkhd', 'mdia']);
  deepEq(vt.children[1].children.map((b) => b.type), ['mdhd', 'hdlr', 'minf']);
  deepEq(E.mp4FindBox(vt, 'minf').children.map((b) => b.type), ['vmhd', 'dinf', 'stbl']);
  deepEq(E.mp4FindBox(at, 'minf').children.map((b) => b.type), ['smhd', 'dinf', 'stbl']);
  deepEq(E.mp4FindBox(vt, 'stbl').children.map((b) => b.type + ':' + b.size), ['stsd:159', 'stts:16', 'stsc:16', 'stsz:20', 'stco:16']);
  const tk = E.mp4FindBox(vt, 'tkhd');
  deepEq([tk.flags, tk.trackId, tk.duration, tk.width, tk.height], [7, 1, 0, 640, 360]);
  const tka = E.mp4FindBox(at, 'tkhd');
  deepEq([tka.trackId, tka.width, tka.height], [2, 0, 0]);
  deepEq([E.mp4FindBox(vt, 'mdhd').timescale, E.mp4FindBox(vt, 'mdhd').language, E.mp4FindBox(at, 'mdhd').timescale], [90000, 'und', 48000]);
  deepEq([E.mp4FindBox(vt, 'hdlr').handlerType, E.mp4FindBox(vt, 'hdlr').name, E.mp4FindBox(at, 'hdlr').handlerType, E.mp4FindBox(at, 'hdlr').name], ['vide', 'VideoHandler', 'soun', 'SoundHandler']);
  assert.equal(E.mp4FindBox(vt, 'vmhd').flags, 1);
  const dref = E.mp4FindBox(vt, 'dref');
  assert.equal(dref.size, 28);
  const stsd = E.mp4FindBox(vt, 'stsd');
  assert.equal(stsd.entryCount, 1);
  const entry = stsd.entries[0];
  deepEq([entry.type, entry.kind, entry.codec, entry.width, entry.height], ['avc1', 'video', 'avc1.64001f', 640, 360]);
  deepEq([entry.avcC.profile, entry.avcC.compat, entry.avcC.level, entry.avcC.lengthSizeMinusOne, entry.avcC.chromaFormat, entry.avcC.bitDepthLuma, entry.avcC.bitDepthChroma], [100, 0, 31, 3, 1, 8, 8]);
  bytesEq(entry.avcC.sps[0], SPS); bytesEq(entry.avcC.pps[0], PPS);
  const ae = E.mp4FindBox(at, 'stsd').entries[0];
  deepEq([ae.type, ae.kind, ae.codec, ae.channels, ae.sampleSize, ae.sampleRate], ['mp4a', 'audio', 'mp4a.40.2', 2, 16, 48000]);
  deepEq(strip(ae.esds).decoderSpecificInfo, { 0: 0x11, 1: 0x90 });
  deepEq([ae.esds.objectTypeIndication, ae.esds.streamType, ae.esds.maxBitrate, ae.esds.avgBitrate, ae.esds.audioObjectType, ae.esds.samplingFrequencyIndex, ae.esds.sampleRate, ae.esds.channelConfiguration], [0x40, 5, 0, 0, 2, 3, 48000, 2]);
});
test('init: avcC skips the chroma extension for non-high profiles', () => {
  const sps = new Uint8Array(SPS); sps[1] = 66; sps[2] = 0xc0; sps[3] = 30; // Baseline
  const init = E.mp4InitSegment([{ ...VIDEO, sps }]);
  const avcC = E.mp4FindBox(E.mp4ParseBoxes(init), 'avcC');
  assert.equal(avcC.size, 53);
  assert.equal(hex(avcC.data), H('01 42 c0 1e ff e1 001c ' + hex(sps) + ' 01 0006 ' + hex(PPS)));
  deepEq(E.mp4CodecsFromInit(init), ['avc1.42c01e']);
  const chroma = E.mp4InitSegment([{ ...VIDEO, chromaFormat: 3, bitDepth: 10 }]);
  assert.equal(hex(E.mp4FindBox(E.mp4ParseBoxes(chroma), 'avcC').data.subarray(-4)), 'fffafa00');
  const split = E.mp4InitSegment([{ ...VIDEO, bitDepthLuma: 12, bitDepthChroma: 9 }]);
  assert.equal(hex(E.mp4FindBox(E.mp4ParseBoxes(split), 'avcC').data.subarray(-4)), 'fdfcf900');
  const parsed = E.mp4FindBox(E.mp4ParseBoxes(chroma), 'stsd').entries[0].avcC;
  deepEq([parsed.chromaFormat, parsed.bitDepthLuma, parsed.bitDepthChroma], [3, 10, 10]);
  const base = E.mp4FindBox(E.mp4ParseBoxes(init), 'stsd').entries[0].avcC;
  deepEq([base.chromaFormat, base.bitDepthLuma, base.bitDepthChroma], [null, null, null], 'no extension on Baseline');
});
test('init: mp3 audio uses objectTypeIndication 0x6b and no DecoderSpecificInfo', () => {
  const init = E.mp4InitSegment([MP3]);
  const boxes = E.mp4ParseBoxes(init);
  const esds = E.mp4FindBox(boxes, 'esds');
  bytesEq(init.subarray(esds.offset, esds.offset + esds.size), bytesOf(ESDS_MP3));
  deepEq(E.mp4CodecsFromInit(init), ['mp4a.6b']);
  deepEq(E.mp4CodecsFromInit(E.mp4InitSegment([{ ...MP3, codec: 'mp4a.6B' }])), ['mp4a.6b']);
  assert.equal(E.mp4FindBox(boxes, 'mdhd').timescale, 44100);
  assert.equal(E.mp4FindBox(boxes, 'stsd').entries[0].sampleRate, 44100);
  assert.equal(E.mp4FindBox(boxes, 'mvhd').nextTrackId, 4);
});
test('init: audio defaults — rate index derived from the rate, rate from the index, 96 kHz past the 16-bit field, bitrate', () => {
  let e = E.mp4FindBox(E.mp4ParseBoxes(E.mp4InitSegment([{ id: 1, type: 'audio', timescale: 44100, audio: { sampleRate: 44100, channels: 1 } }])), 'stsd').entries[0];
  deepEq([e.esds.samplingFrequencyIndex, e.esds.sampleRate, e.esds.channelConfiguration, e.esds.audioObjectType, e.channels], [4, 44100, 1, 2, 1]);
  e = E.mp4FindBox(E.mp4ParseBoxes(E.mp4InitSegment([{ id: 1, type: 'audio', timescale: 22050, audio: { sampleRateIndex: 7 } }])), 'stsd').entries[0];
  deepEq([e.esds.samplingFrequencyIndex, e.esds.sampleRate, e.sampleRate, e.channels], [7, 22050, 22050, 2]);
  e = E.mp4FindBox(E.mp4ParseBoxes(E.mp4InitSegment([{ id: 1, type: 'audio', timescale: 32000, audio: {} }])), 'stsd').entries[0];
  deepEq([e.esds.samplingFrequencyIndex, e.esds.sampleRate], [5, 32000], 'timescale is the rate when nothing else says');
  const hi = E.mp4InitSegment([{ id: 1, type: 'audio', timescale: 96000, audio: { objectType: 5, sampleRate: 96000, channels: 6, bitrate: 128000 } }]);
  e = E.mp4FindBox(E.mp4ParseBoxes(hi), 'stsd').entries[0];
  deepEq([e.sampleRate, e.esds.samplingFrequencyIndex, e.esds.sampleRate, e.esds.audioObjectType, e.esds.channelConfiguration, e.esds.avgBitrate, e.esds.maxBitrate], [0, 0, 96000, 5, 6, 128000, 128000]);
  deepEq(E.mp4TracksFromInit(hi).map((t) => [t.sampleRate, t.channels, t.codec]), [[96000, 6, 'mp4a.40.5']]);
  e = E.mp4FindBox(E.mp4ParseBoxes(E.mp4InitSegment([{ id: 1, type: 'audio', timescale: 48000, audio: { channels: 8, sampleRateIndex: 15, sampleRate: 48000 } }])), 'stsd').entries[0];
  deepEq([e.channels, e.esds.channelConfiguration, e.esds.samplingFrequencyIndex], [8, 7, 3], '8 channels → configuration 7; index 15 is not encodable so it comes from the rate');
});
test('init: junk tracks → null, junk entries dropped, duplicate ids dropped', () => {
  for (const junk of [null, undefined, 0, 'x', {}, [], [null], [{}], [{ type: 'video' }], [{ id: 1, type: 'video', timescale: 90000 }],
    [{ id: 1, type: 'video', timescale: 90000, sps: new Uint8Array(3), pps: PPS }], [{ id: 1, type: 'video', timescale: 90000, sps: SPS, pps: new Uint8Array(0) }],
    [{ id: 0, type: 'audio', timescale: 48000 }], [{ id: 1, type: 'audio', timescale: 0 }], [{ id: 1, type: 'text', timescale: 1000 }], [{ id: -1, type: 'audio', timescale: 'x' }]]) {
    assert.equal(E.mp4InitSegment(junk), null, JSON.stringify(junk));
  }
  const init = E.mp4InitSegment([null, VIDEO, 'junk', { ...AUDIO, id: 1 }, AUDIO, { id: 2, type: 'audio', timescale: 48000 }]);
  deepEq(E.mp4TracksFromInit(init).map((t) => [t.id, t.type]), [[1, 'video'], [2, 'audio']]);
  const sloppy = E.mp4InitSegment([{ id: '7', type: 'video', timescale: '90000', width: '1920.9', height: -5, sps: Array.from(SPS), pps: PPS.buffer }]);
  const t = E.mp4TracksFromInit(sloppy)[0];
  deepEq([t.id, t.timescale, t.width, t.height, t.codec], [7, 90000, 1920, 0, 'avc1.64001f']);
  assert.equal(E.mp4FindBox(E.mp4ParseBoxes(sloppy), 'mvhd').nextTrackId, 8);
});
test('init: deterministic', () => {
  bytesEq(E.mp4InitSegment([VIDEO, AUDIO]), E.mp4InitSegment([VIDEO, AUDIO]));
  bytesEq(E.mp4InitSegment([MP3]), E.mp4InitSegment([MP3]));
});

/* ===================== media segment ===================== */
test('media: two-sample moof+mdat byte-for-byte (trun v1 with signed cts, data_offset = moof + 8)', () => {
  const seg = E.mp4MediaSegment(VIDEO, SAMPLES2, { sequenceNumber: 7, baseMediaDecodeTime: 3000 });
  assert.equal(hex(seg), H(MOOF2 + MDAT2));
  assert.equal(seg.length, 133);
});
test('media: parsed fields, resolved samples and mdat payload', () => {
  const seg = E.mp4MediaSegment(VIDEO, SAMPLES2, { sequenceNumber: 7, baseMediaDecodeTime: 3000 });
  const boxes = E.mp4ParseBoxes(seg);
  deepEq(boxes.map((b) => b.type + ':' + b.size), ['moof:120', 'mdat:13']);
  deepEq(boxes[0].children.map((b) => b.type), ['mfhd', 'traf']);
  deepEq(boxes[0].children[1].children.map((b) => b.type), ['tfhd', 'tfdt', 'trun']);
  assert.equal(E.mp4FindBox(boxes, 'mfhd').sequenceNumber, 7);
  deepEq(strip(E.mp4FindBox(boxes, 'tfhd')), { type: 'tfhd', size: 16, offset: 32, headerSize: 8, version: 0, flags: 0x020000, trackId: 1, baseDataOffset: null, sampleDescriptionIndex: null, defaultSampleDuration: null, defaultSampleSize: null, defaultSampleFlags: null, durationIsEmpty: false, defaultBaseIsMoof: true });
  deepEq(strip(E.mp4FindBox(boxes, 'tfdt')), { type: 'tfdt', size: 20, offset: 48, headerSize: 8, version: 1, flags: 0, baseMediaDecodeTime: 3000 });
  const trun = E.mp4FindBox(boxes, 'trun');
  deepEq([trun.version, trun.flags, trun.sampleCount, trun.dataOffset, trun.firstSampleFlags], [1, 0x000f01, 2, 128, null]);
  deepEq(trun.samples, [{ duration: 3000, size: 3, flags: 0x02000000, cts: 3600 }, { duration: 3000, size: 2, flags: 0x01010000, cts: -3600 }]);
  bytesEq(boxes[1].data, new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(boxes[0].offset + trun.dataOffset, boxes[1].offset + 8, 'first sample starts at the mdat payload');
  assert.equal(E.mp4Tfdt(seg), 3000);
});
test('media: 64-bit baseMediaDecodeTime and large sequence numbers survive', () => {
  const bmdt = NOW * 90; // 90 kHz ticks of a wall-clock epoch: well past 2^32, under 2^53
  const seg = E.mp4MediaSegment(AUDIO, [{ data: [9], duration: 1024, key: true }], { sequenceNumber: 0xfffffffe, baseMediaDecodeTime: bmdt });
  assert.equal(hex(E.mp4FindBox(E.mp4ParseBoxes(seg), 'tfdt').data), '01000000' + u64(bmdt));
  assert.equal(E.mp4Tfdt(seg), bmdt);
  assert.equal(E.mp4FindBox(E.mp4ParseBoxes(seg), 'mfhd').sequenceNumber, 0xfffffffe);
  assert.equal(E.mp4FindBox(E.mp4ParseBoxes(seg), 'tfhd').trackId, 2);
});
test('media: many samples, every key/non-key flag and cts sign round-trips', () => {
  const samples = [];
  for (let i = 0; i < 300; i++) samples.push({ data: new Uint8Array(i % 7 + 1).fill(i & 0xff), duration: 3000 + (i % 3), cts: (i % 5 - 2) * 3000, key: i % 25 === 0 });
  const seg = E.mp4MediaSegment(VIDEO, samples, { sequenceNumber: 3, baseMediaDecodeTime: 90000 });
  const boxes = E.mp4ParseBoxes(seg);
  assert.equal(boxes[0].size, 88 + 16 * 300);
  const trun = E.mp4FindBox(boxes, 'trun');
  assert.equal(trun.dataOffset, boxes[0].size + 8);
  deepEq(trun.samples, samples.map((s) => ({ duration: s.duration, size: s.data.length, flags: s.key ? 0x02000000 : 0x01010000, cts: s.cts })));
  bytesEq(boxes[1].data, E.concatBytes(samples.map((s) => s.data)));
});
test('media: defaults and clamping (missing opts, NaN duration, cts beyond int32, negative bmdt)', () => {
  const seg = E.mp4MediaSegment({ id: 5 }, [{ data: [1], duration: 'x', cts: 1e12 }, { data: [2], duration: -4, cts: -1e12 }, { data: [3], duration: 2 ** 40, cts: 1.9 }]);
  const boxes = E.mp4ParseBoxes(seg);
  assert.equal(E.mp4FindBox(boxes, 'mfhd').sequenceNumber, 1);
  assert.equal(E.mp4FindBox(boxes, 'tfdt').baseMediaDecodeTime, 0);
  deepEq(E.mp4FindBox(boxes, 'trun').samples, [{ duration: 0, size: 1, flags: 0x01010000, cts: 0x7fffffff }, { duration: 0, size: 1, flags: 0x01010000, cts: -0x80000000 }, { duration: 0xffffffff, size: 1, flags: 0x01010000, cts: 1 }]);
  assert.equal(E.mp4Tfdt(E.mp4MediaSegment(VIDEO, SAMPLES2, { baseMediaDecodeTime: -5 })), 0);
});
test('media: junk input → null, junk samples skipped', () => {
  for (const [t, s] of [[null, SAMPLES2], [{}, SAMPLES2], [{ id: 0 }, SAMPLES2], [VIDEO, null], [VIDEO, 'abc'], [VIDEO, []], [VIDEO, [null, 1, 'x', {}, { data: null }, { data: new Uint8Array(0) }]]]) {
    assert.equal(E.mp4MediaSegment(t, s), null);
  }
  const seg = E.mp4MediaSegment(VIDEO, [null, { data: [7, 7], duration: 1, key: true }, 'junk', { data: 'junk' }, { data: new Uint8Array(0) }, { data: [8], duration: 2 }]);
  deepEq(E.mp4FindBox(E.mp4ParseBoxes(seg), 'trun').samples, [{ duration: 1, size: 2, flags: 0x02000000, cts: 0 }, { duration: 2, size: 1, flags: 0x01010000, cts: 0 }]);
  bytesEq(E.mp4ParseBoxes(seg)[1].data, new Uint8Array([7, 7, 8]));
});
test('media: deterministic', () => {
  const a = E.mp4MediaSegment(VIDEO, SAMPLES2, { sequenceNumber: 2, baseMediaDecodeTime: 6000 });
  const b = E.mp4MediaSegment(VIDEO, SAMPLES2, { sequenceNumber: 2, baseMediaDecodeTime: 6000 });
  bytesEq(a, b);
});

/* ===================== parser: tolerance ===================== */
test('parse: empty / null / junk input never throws and returns an untruncated empty list', () => {
  for (const junk of [null, undefined, 0, 'ftyp', {}, [], new Uint8Array(0), new ArrayBuffer(0)]) {
    const r = E.mp4ParseBoxes(junk);
    deepEq(r, []); assert.equal(r.truncated, false, String(junk));
  }
});
test('parse: every prefix of an init and a media segment parses without throwing; truncated iff cut mid-box', () => {
  const init = E.mp4InitSegment([VIDEO, AUDIO]);
  const seg = E.mp4MediaSegment(VIDEO, SAMPLES2, { sequenceNumber: 1, baseMediaDecodeTime: 0 });
  for (const [buf, bounds] of [[init, [0, 32, init.length]], [seg, [0, 120, seg.length]]]) {
    for (let n = 0; n <= buf.length; n++) {
      const r = E.mp4ParseBoxes(buf.subarray(0, n));
      assert.equal(r.truncated, !bounds.includes(n), 'prefix ' + n);
      assert.equal(r.length, bounds.filter((b) => b > 0 && b <= n).length, 'boxes at prefix ' + n);
    }
  }
});
test('parse: size 0 runs to the end; largesize (size 1) read as 64-bit', () => {
  const r = E.mp4ParseBoxes(bytesOf('00000000 66726565 aabbccdd'));
  deepEq(r.map(strip), [{ type: 'free', size: 12, offset: 0, headerSize: 8 }]);
  assert.equal(hex(r[0].data), 'aabbccdd');
  const big = E.mp4ParseBoxes(bytesOf('00000001 66726565 00000000 00000014 01020304 00000008 736b6970'));
  deepEq(big.map(strip), [{ type: 'free', size: 20, offset: 0, headerSize: 16 }, { type: 'skip', size: 8, offset: 20, headerSize: 8 }]);
  assert.equal(hex(big[0].data), '01020304');
  assert.equal(big.truncated, false);
  const cut = E.mp4ParseBoxes(bytesOf('00000001 66726565 00000000'));
  deepEq(cut, []); assert.equal(cut.truncated, true, 'largesize header itself cut short');
  const huge = E.mp4ParseBoxes(bytesOf('00000001 66726565 7fffffff ffffffff 01'));
  deepEq(huge, []); assert.equal(huge.truncated, true, 'largesize beyond the buffer');
});
test('parse: impossible sizes (below the header, past the end) stop the walk and set truncated', () => {
  for (const h of ['00000003 66726565 00000000', '00000007 66726565', '00000009 66726565', 'ffffffff 6d6f6f76 00000000', '00000001 6d6f6f76 00000000 00000004']) {
    const r = E.mp4ParseBoxes(bytesOf(h));
    deepEq(r, [], h); assert.equal(r.truncated, true, h);
  }
  const r = E.mp4ParseBoxes(bytesOf('00000008 66726565 00000010 736b6970 0000'));
  deepEq(r.map((b) => b.type), ['free']); assert.equal(r.truncated, true, 'good box followed by a cut one');
  const container = E.mp4ParseBoxes(bytesOf('00000014 6d6f6f76 00000014 6d766864 00000000'));
  assert.equal(container.truncated, false, 'the moov itself is complete');
  deepEq(container[0].children, []);
  assert.equal(container[0].truncated, true, 'its child was cut');
});
test('parse: seeded random junk and junk with real box headers never throw or hang', () => {
  let seed = 0x2545f491;
  const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 16 & 0xff; };
  for (let round = 0; round < 60; round++) {
    const buf = new Uint8Array(1 + (round * 37) % 700);
    for (let i = 0; i < buf.length; i++) buf[i] = next();
    if (round % 3 === 0) for (let i = 0; i + 8 <= buf.length; i += 40) buf.set(bytesOf('0000002' + (i % 8) + ['6d6f6f76', '7472616b', '7472756e', '73747364', '65736473', '6d657461'][i % 6]), i);
    const r = E.mp4ParseBoxes(buf);
    assert.ok(Array.isArray(r) && typeof r.truncated === 'boolean');
    deepEq(r, E.mp4ParseBoxes(buf), 'deterministic');
    E.mp4CodecsFromInit(buf); E.mp4TracksFromInit(buf); E.mp4Tfdt(buf); E.mp4Sidx(buf);
  }
});
test('parse: a 5000-deep nest of container headers is cut off by the depth cap instead of the stack', () => {
  const n = 5000, buf = new Uint8Array(8 * n);
  for (let i = 0; i < n; i++) { E.writeU32be(buf, i * 8, 8 * (n - i)); buf.set(bytesOf('6d6f6f76'), i * 8 + 4); }
  const r = E.mp4ParseBoxes(buf);
  let depth = 0, b = r[0];
  while (b.children) { depth++; b = b.children[0]; }
  assert.equal(depth, 12);
  assert.equal(b.data.length, 8 * (n - 13), 'the box below the cap is a leaf holding the rest');
  assert.equal(r.truncated, false);
});
test('parse: ISO meta (FullBox) and QuickTime meta both descend into their children', () => {
  const iso = E.mp4ParseBoxes(E.mp4FullBox('meta', 0, 0, E.mp4FullBox('hdlr', 0, 0, new Uint8Array(4), E.bytesOfText('mdir'), new Uint8Array(12), [0])));
  deepEq(iso[0].children.map((b) => [b.type, b.handlerType]), [['hdlr', 'mdir']]);
  deepEq([iso[0].version, iso[0].flags], [0, 0]);
  const qt = E.mp4ParseBoxes(E.mp4Box('meta', E.mp4FullBox('hdlr', 0, 0, new Uint8Array(4), E.bytesOfText('mdta'), new Uint8Array(12), [0])));
  deepEq(qt[0].children.map((b) => [b.type, b.handlerType]), [['hdlr', 'mdta']]);
});
test('parse: box details tolerate short payloads (fields simply absent, no throw)', () => {
  for (const type of ['mvhd', 'tkhd', 'mdhd', 'hdlr', 'trex', 'elst', 'mfhd', 'tfhd', 'tfdt', 'trun', 'sidx', 'stsd', 'ftyp']) {
    for (let n = 0; n < 12; n++) {
      const r = E.mp4ParseBoxes(E.mp4Box(type, new Uint8Array(n)));
      assert.equal(r.length, 1, type + ' ' + n);
    }
  }
  const tfdt = E.mp4ParseBoxes(E.mp4FullBox('tfdt', 1, 0, new Uint8Array(4)))[0];
  assert.equal(tfdt.baseMediaDecodeTime, undefined, 'v1 needs 8 bytes');
  assert.equal(E.mp4ParseBoxes(E.mp4FullBox('tfdt', 0, 0, [0, 0, 1, 0]))[0].baseMediaDecodeTime, 256, 'v0 is 32-bit');
});

/* ===================== parser: fragment details ===================== */
test('parse: trun fields resolved from tfhd defaults and first_sample_flags (the ffmpeg layout)', () => {
  const traf = E.mp4Box('traf',
    E.mp4FullBox('tfhd', 0, 0x020038, bytesOf(u32(1) + u32(1024) + u32(100) + u32(0x02000000))),
    E.mp4FullBox('tfdt', 0, 0, bytesOf(u32(2048))),
    E.mp4FullBox('trun', 0, 0x205, bytesOf(u32(3) + u32(200) + u32(0x01010000) + u32(10) + u32(20) + u32(30))));
  const t = E.mp4ParseBoxes(E.mp4Box('moof', E.mp4FullBox('mfhd', 0, 0, [0, 0, 0, 9]), traf));
  const tfhd = E.mp4FindBox(t, 'tfhd');
  deepEq([tfhd.trackId, tfhd.defaultSampleDuration, tfhd.defaultSampleSize, tfhd.defaultSampleFlags, tfhd.defaultBaseIsMoof, tfhd.baseDataOffset], [1, 1024, 100, 0x02000000, true, null]);
  const trun = E.mp4FindBox(t, 'trun');
  deepEq([trun.version, trun.flags, trun.sampleCount, trun.dataOffset, trun.firstSampleFlags], [0, 0x205, 3, 200, 0x01010000]);
  deepEq(trun.samples, [{ duration: 1024, size: 10, flags: 0x01010000, cts: 0 }, { duration: 1024, size: 20, flags: 0x02000000, cts: 0 }, { duration: 1024, size: 30, flags: 0x02000000, cts: 0 }]);
  assert.equal(E.mp4FindBox(t, 'tfdt').baseMediaDecodeTime, 2048);
  assert.equal(E.mp4FindBox(t, 'mfhd').sequenceNumber, 9);
  assert.equal(E.mp4Tfdt(E.mp4Box('moof', E.mp4FullBox('mfhd', 0, 0, [0, 0, 0, 9]), traf)), 2048);
});
test('parse: tfhd with every optional field; trun v0 cts unsigned, negative data_offset signed; trun with no per-sample fields', () => {
  const tfhd = E.mp4ParseBoxes(E.mp4FullBox('tfhd', 0, 0x01003b, bytesOf(u32(4) + u64(2 ** 40 + 5) + u32(2) + u32(512) + u32(99) + u32(0x01010000))))[0];
  deepEq([tfhd.trackId, tfhd.baseDataOffset, tfhd.sampleDescriptionIndex, tfhd.defaultSampleDuration, tfhd.defaultSampleSize, tfhd.defaultSampleFlags, tfhd.durationIsEmpty, tfhd.defaultBaseIsMoof], [4, 2 ** 40 + 5, 2, 512, 99, 0x01010000, true, false]);
  const v0 = E.mp4ParseBoxes(E.mp4FullBox('trun', 0, 0x801, bytesOf(u32(1) + 'fffffff8' + 'fffff1f0')))[0];
  deepEq([v0.dataOffset, v0.samples], [-8, [{ duration: null, size: null, flags: null, cts: 4294963696 }]]);
  const v1 = E.mp4ParseBoxes(E.mp4FullBox('trun', 1, 0x801, bytesOf(u32(1) + 'fffffff8' + 'fffff1f0')))[0];
  deepEq(v1.samples, [{ duration: null, size: null, flags: null, cts: -3600 }]);
  const bare = E.mp4ParseBoxes(E.mp4FullBox('trun', 0, 0, bytesOf(u32(3))))[0];
  deepEq(bare.samples, [{ duration: null, size: null, flags: null, cts: null }, { duration: null, size: null, flags: null, cts: null }, { duration: null, size: null, flags: null, cts: null }]);
  const bomb = E.mp4ParseBoxes(E.mp4FullBox('trun', 0, 0, bytesOf('ffffffff')))[0];
  assert.equal(bomb.samples.length, 65536); assert.equal(bomb.truncated, true);
  const short = E.mp4ParseBoxes(E.mp4FullBox('trun', 1, 0x301, bytesOf(u32(5) + u32(0) + u32(1) + u32(2) + u32(3) + u32(4) + '0000')))[0];
  deepEq(short.samples, [{ duration: 1, size: 2, flags: null, cts: null }, { duration: 3, size: 4, flags: null, cts: null }]);
  assert.equal(short.truncated, true);
});
test('parse: sidx and elst details; mp4Sidx', () => {
  const sidx = E.mp4FullBox('sidx', 0, 0, bytesOf(u32(1) + u32(90000) + u32(0) + u32(0) + '0000' + '0002' + u32(1000) + u32(90000) + u32(0x90000000) + u32(0x80000000 | 2000) + u32(45000) + u32(0)));
  deepEq(E.mp4Sidx(E.concatBytes([E.mp4Box('styp', E.bytesOfText('msdh'), [0, 0, 0, 0]), sidx])), {
    referenceId: 1, timescale: 90000, earliestPresentationTime: 0, firstOffset: 0,
    references: [{ referenceType: 0, referencedSize: 1000, subsegmentDuration: 90000, startsWithSap: 1, sapType: 1, sapDeltaTime: 0 },
      { referenceType: 1, referencedSize: 2000, subsegmentDuration: 45000, startsWithSap: 0, sapType: 0, sapDeltaTime: 0 }]
  });
  const v1 = E.mp4ParseBoxes(E.mp4FullBox('sidx', 1, 0, bytesOf(u32(2) + u32(1000) + u64(2 ** 33) + u64(2 ** 32 + 1) + '0000 0001' + u32(5) + u32(6) + u32(0))))[0];
  deepEq([v1.earliestPresentationTime, v1.firstOffset, v1.references.length], [2 ** 33, 2 ** 32 + 1, 1]);
  assert.equal(E.mp4Sidx(E.mp4InitSegment([VIDEO])), null);
  assert.equal(E.mp4Sidx(E.mp4Box('sidx', [0])), null, 'a sidx too short to hold its header');
  const styp = E.mp4ParseBoxes(E.mp4Box('styp', E.bytesOfText('msdh'), [0, 0, 0, 0], E.bytesOfText('msix')))[0];
  deepEq([styp.majorBrand, styp.minorVersion, styp.compatibleBrands], ['msdh', 0, ['msix']]);
  const elst = E.mp4ParseBoxes(E.mp4Box('edts', E.mp4FullBox('elst', 0, 0, bytesOf(u32(2) + u32(1000) + 'ffffffff' + '0001 0000' + u32(2000) + u32(1024) + '0001 8000'))))[0].children[0];
  deepEq(elst.entries, [{ segmentDuration: 1000, mediaTime: -1, mediaRate: 1 }, { segmentDuration: 2000, mediaTime: 1024, mediaRate: 1.5 }]);
  const elst1 = E.mp4ParseBoxes(E.mp4FullBox('elst', 1, 0, bytesOf(u32(1) + u64(2 ** 35) + 'ffffffff ffffffff' + '0001 0000')))[0];
  deepEq(elst1.entries, [{ segmentDuration: 2 ** 35, mediaTime: -1, mediaRate: 1 }]);
});

/* ===================== codec strings / tracks ===================== */
const videoEntry = (type, w, h, ...kids) => { const body = new Uint8Array(78); body[7] = 1; E.writeU16be(body, 24, w); E.writeU16be(body, 26, h); return E.mp4Box(type, body, ...kids); };
const audioEntry = (type, ch, rate, ...kids) => { const body = new Uint8Array(28); body[7] = 1; E.writeU16be(body, 16, ch); E.writeU16be(body, 18, 16); E.writeU16be(body, 24, rate); return E.mp4Box(type, body, ...kids); };
const fakeInit = (handler, ...entries) => E.mp4Box('moov', E.mp4Box('trak', E.mp4Box('mdia',
  E.mp4FullBox('hdlr', 0, 0, new Uint8Array(4), E.bytesOfText(handler), new Uint8Array(12), [0]),
  E.mp4Box('minf', E.mp4Box('stbl', E.mp4FullBox('stsd', 0, 0, bytesOf(u32(entries.length)), ...entries))))));
test('codecs: hvc1/hev1 from hvcC, av01 from av1C, vp09 from vpcC, avc3', () => {
  const hvcC = E.mp4Box('hvcC', bytesOf('01 01 60000000 b00000000000 5d 0000 00 00 00 00 00 00'));
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('hvc1', 1920, 1080, hvcC))), ['hvc1.1.6.L93.B0']);
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('hev1', 1920, 1080, E.mp4Box('hvcC', bytesOf('01 02 20000000 90000000 0000 7b'))))), ['hev1.2.4.L123.90'], 'Main 10: profile 2, compat bit 2 → 4, tier main');
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('hvc1', 100, 100, E.mp4Box('hvcC', bytesOf('01 a1 60000000 900000000000 78'))))), ['hvc1.B1.6.H120.90'], 'profile space B, high tier');
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('hvc1', 100, 100, E.mp4Box('hvcC', [1, 1])))), ['hvc1'], 'hvcC too short → bare type');
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('av01', 100, 100, E.mp4Box('av1C', bytesOf('81 08 0c 00'))))), ['av01.0.08M.08']);
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('av01', 100, 100, E.mp4Box('av1C', bytesOf('81 4d c0 00'))))), ['av01.2.13H.10']);
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('vp09', 100, 100, E.mp4FullBox('vpcC', 1, 0, bytesOf('00 0a 81 01 01 0000'))))), ['vp09.00.10.08']);
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('vp09', 100, 100))), ['vp09']);
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('avc3', 100, 100, E.mp4Box('avcC', bytesOf('01 4d 40 1e ff e1 0002 6742 01 0001 68'))))), ['avc3.4d401e']);
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('avc1', 100, 100, E.mp4Box('avcC', [1, 2])))), ['avc1'], 'avcC too short → bare type');
  deepEq(E.mp4CodecsFromInit(fakeInit('vide', videoEntry('mp4v', 100, 100))), ['mp4v']);
  deepEq(E.mp4TracksFromInit(fakeInit('vide', videoEntry('hvc1', 1920, 1080, hvcC))).map((t) => [t.id, t.type, t.timescale, t.width, t.height]), [[1, 'video', null, 1920, 1080]], 'missing tkhd/mdhd tolerated');
});
test('codecs: audio sample entries (ac-3, ec-3, Opus, fLaC, alac, .mp3, mp4a variants, esds with 4-byte lengths, esds inside wave)', () => {
  for (const [type, codec] of [['ac-3', 'ac-3'], ['ec-3', 'ec-3'], ['Opus', 'opus'], ['fLaC', 'flac'], ['alac', 'alac'], ['.mp3', 'mp3'], ['ac-4', 'ac-4']]) {
    deepEq(E.mp4CodecsFromInit(fakeInit('soun', audioEntry(type, 2, 48000, E.mp4Box('dac3', [0, 0, 0])))), [codec], type);
  }
  const ffmpegEsds = E.mp4FullBox('esds', 0, 0, bytesOf('03 80808022 0000 00 04 80808014 40 15 000000 00000000 00000000 05 80808002 1190 06 80808001 02'));
  const entry = E.mp4FindBox(E.mp4ParseBoxes(fakeInit('soun', audioEntry('mp4a', 2, 48000, ffmpegEsds))), 'stsd').entries[0];
  deepEq([entry.codec, entry.esds.objectTypeIndication, entry.esds.audioObjectType, entry.esds.samplingFrequencyIndex, entry.esds.sampleRate, entry.esds.channelConfiguration], ['mp4a.40.2', 0x40, 2, 3, 48000, 2]);
  const he = E.mp4FullBox('esds', 0, 0, bytesOf('03 19 0000 00 04 11 40 15 000000 00000000 00000000 05 02 2b11 06 01 02'));
  deepEq(E.mp4CodecsFromInit(fakeInit('soun', audioEntry('mp4a', 2, 48000, he))), ['mp4a.40.5'], 'HE-AAC object type 5, explicit');
  const escaped = E.mp4FullBox('esds', 0, 0, bytesOf('03 1b 0000 00 04 13 40 15 000000 00000000 00000000 05 04 f8 00 c4 00 06 01 02'));
  deepEq(E.mp4CodecsFromInit(fakeInit('soun', audioEntry('mp4a', 2, 48000, escaped))), ['mp4a.40.32'], 'object type 31 escape → 32 + 6 bits');
  const mp2 = E.mp4FullBox('esds', 0, 0, bytesOf('03 15 0000 00 04 0d 69 15 000000 00000000 00000000 06 01 02'));
  deepEq(E.mp4CodecsFromInit(fakeInit('soun', audioEntry('mp4a', 2, 44100, mp2))), ['mp4a.69']);
  const mpeg2aac = E.mp4FullBox('esds', 0, 0, bytesOf('03 19 0000 00 04 11 67 15 000000 00000000 00000000 05 02 1190 06 01 02'));
  deepEq(E.mp4CodecsFromInit(fakeInit('soun', audioEntry('mp4a', 2, 48000, mpeg2aac))), ['mp4a.67']);
  deepEq(E.mp4CodecsFromInit(fakeInit('soun', audioEntry('mp4a', 2, 48000))), ['mp4a.40.2'], 'no esds at all → AAC-LC');
  deepEq(E.mp4CodecsFromInit(fakeInit('soun', audioEntry('mp4a', 2, 48000, E.mp4FullBox('esds', 0, 0, [3, 1, 0])))), ['mp4a.40.2'], 'esds without a decoder config → AAC-LC');
  deepEq(E.mp4CodecsFromInit(fakeInit('soun', audioEntry('mp4a', 2, 48000, E.mp4FullBox('esds', 0, 0, bytesOf('03 e0 0000 00 04'))))), ['mp4a.40.2'], 'overstated descriptor length is clipped');
  const dependent = E.mp4FullBox('esds', 0, 0, bytesOf('03 1d 0001 e0 0007 03 6162 63 0002 04 0d 6b 15 000000 00000000 00000000 06 01 02'));
  deepEq(E.mp4CodecsFromInit(fakeInit('soun', audioEntry('mp4a', 2, 44100, dependent))), ['mp4a.6b'], 'ES flags: dependsOn, URL and OCR fields skipped');
  // QuickTime: a version-1 sound entry with 16 extra bytes and esds wrapped in 'wave'
  const v1body = new Uint8Array(44); v1body[7] = 1; E.writeU16be(v1body, 8, 1); E.writeU16be(v1body, 16, 2); E.writeU16be(v1body, 24, 44100);
  const wave = E.mp4Box('wave', E.mp4Box('frma', E.bytesOfText('mp4a')), he, E.mp4Box('\0\0\0\0'));
  const qt = E.mp4FindBox(E.mp4ParseBoxes(fakeInit('soun', E.mp4Box('mp4a', v1body, wave))), 'stsd').entries[0];
  deepEq([qt.codec, qt.channels, qt.sampleRate, qt.children.map((b) => b.type)], ['mp4a.40.5', 2, 44100, ['wave']]);
  const v2body = new Uint8Array(64); v2body[7] = 1; E.writeU16be(v2body, 8, 2); E.writeU16be(v2body, 16, 3); E.writeU32be(v2body, 40, 6);
  new DataView(v2body.buffer).setFloat64(32, 96000);
  const v2 = E.mp4FindBox(E.mp4ParseBoxes(fakeInit('soun', E.mp4Box('mp4a', v2body, he))), 'stsd').entries[0];
  deepEq([v2.codec, v2.channels, v2.sampleRate], ['mp4a.40.5', 6, 96000]);
  deepEq(E.mp4CodecsFromInit(fakeInit('soun', E.mp4Box('mp4a', new Uint8Array(10)))), ['mp4a.40.2'], 'undersized entry');
});
test('tracks: mp4TracksFromInit / mp4CodecsFromInit on the muxer output, text/unknown handlers, mime integration', () => {
  const init = E.mp4InitSegment([VIDEO, AUDIO, MP3]);
  deepEq(E.mp4TracksFromInit(init), [
    { id: 1, type: 'video', timescale: 90000, codec: 'avc1.64001f', duration: 0, language: 'und', width: 640, height: 360, sampleRate: 0, channels: 0 },
    { id: 2, type: 'audio', timescale: 48000, codec: 'mp4a.40.2', duration: 0, language: 'und', width: 0, height: 0, sampleRate: 48000, channels: 2 },
    { id: 3, type: 'audio', timescale: 44100, codec: 'mp4a.6b', duration: 0, language: 'und', width: 0, height: 0, sampleRate: 44100, channels: 2 }]);
  deepEq(E.mp4CodecsFromInit(init), ['avc1.64001f', 'mp4a.40.2', 'mp4a.6b']);
  assert.equal(E.mimeForCodecs(E.mp4CodecsFromInit(E.mp4InitSegment([AUDIO]))), 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(E.mimeForCodecs(E.mp4CodecsFromInit(init)), 'video/mp4; codecs="avc1.64001f,mp4a.40.2,mp4a.6b"');
  deepEq(E.mp4TracksFromInit(fakeInit('sbtl', E.mp4Box('tx3g', new Uint8Array(30)))).map((t) => [t.type, t.codec]), [['text', 'tx3g']]);
  deepEq(E.mp4TracksFromInit(fakeInit('zzzz', E.mp4Box('abcd', new Uint8Array(4)))).map((t) => [t.type, t.codec]), [['unknown', 'abcd']]);
  deepEq(E.mp4TracksFromInit(E.mp4Box('moov', E.mp4Box('trak'))), [{ id: 1, type: 'unknown', timescale: null, codec: null, duration: 0, language: 'und', width: 0, height: 0, sampleRate: 0, channels: 0 }]);
  deepEq(E.mp4TracksFromInit(E.mp4MediaSegment(VIDEO, SAMPLES2)), []);
  deepEq(E.mp4CodecsFromInit(null), []);
  deepEq(E.mp4TracksFromInit(E.mp4Box('moov', E.mp4Box('trak', E.mp4Box('mdia', E.mp4Box('minf', E.mp4Box('stbl', E.mp4FullBox('stsd', 0, 0, [0, 0, 0, 2], videoEntry('avc1', 1, 1), E.mp4Box('bad', [1]).subarray(0, 6)))))))).map((t) => t.codec), ['avc1'], 'second entry cut short');
});
test('tfdt: first tfdt across several moofs, null when absent', () => {
  const a = E.mp4MediaSegment(VIDEO, SAMPLES2, { sequenceNumber: 1, baseMediaDecodeTime: 111 });
  const b = E.mp4MediaSegment(AUDIO, SAMPLES2, { sequenceNumber: 2, baseMediaDecodeTime: 222 });
  assert.equal(E.mp4Tfdt(E.concatBytes([b, a])), 222);
  assert.equal(E.mp4Tfdt(E.concatBytes([E.mp4InitSegment([VIDEO]), a])), 111);
  assert.equal(E.mp4Tfdt(E.mp4InitSegment([VIDEO])), null);
  assert.equal(E.mp4Tfdt(null), null);
  assert.equal(E.mp4Tfdt(E.mp4Box('moof', E.mp4Box('traf', E.mp4Box('tfdt', [1])))), null, 'a tfdt too short to read');
  assert.equal(E.mp4FindBox(E.mp4ParseBoxes(a), 'nope'), null);
  assert.equal(E.mp4FindBox(null, 'moof'), null);
});
test('aacConfigBytes: table of known configs and junk defaults', () => {
  for (const [args, want] of [[[2, 3, 2], '1190'], [[2, 4, 1], '1208'], [[5, 3, 2], '2990'], [[2, 11, 1], '1588'], [[2, 3, 8], '11b8'], [[2, 3, 6], '11b0'],
    [[undefined, undefined, undefined], '1000'], [['x', -1, 99], '1038'], [[0, 3, 2], '1190'], [[31, 15, 15], 'ffb8'], [[40, 20, 20], 'ffb8']]) {
    assert.equal(hex(E.aacConfigBytes(...args)), want, JSON.stringify(args));
  }
});

/* ===================== real file via ffmpeg/ffprobe ===================== */
let fixture; // undefined = not built yet, null = tools missing
function notice(msg) { console.log('      (notice: ' + msg + ')'); }
function realFixture() {
  if (fixture !== undefined) return fixture;
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) { notice('ffmpeg not found — real-file cases skipped'); return (fixture = null); }
  const dir = mkdtempSync(join(tmpdir(), 'aerial-mp4-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'real.mp4');
  const enc = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '25', '-bf', '2', '-c:a', 'aac', '-b:a', '64k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+separate_moof', '-frag_duration', '1000000', '-f', 'mp4', src], { encoding: 'utf8' });
  if (enc.status !== 0) { notice('ffmpeg could not encode the reference (' + (enc.stderr || '').trim() + ') — real-file cases skipped'); return (fixture = null); }
  const bytes = new Uint8Array(readFileSync(src));
  const boxes = E.mp4ParseBoxes(bytes);
  const moofs = boxes.filter((b) => b.type === 'moof');
  const init = bytes.subarray(0, moofs[0].offset);
  const tracks = E.mp4TracksFromInit(init);
  const entries = E.mp4FindBox(boxes, 'moov').children.filter((b) => b.type === 'trak').map((tr) => E.mp4FindBox(tr, 'stsd').entries[0]);
  // Rebuild the muxer's track descriptions from what the parser pulled out of the source moov.
  const muxTracks = tracks.map((t, i) => {
    const e = entries[i];
    if (t.type === 'video') return { id: t.id, type: 'video', timescale: t.timescale, width: e.width, height: e.height, sps: e.avcC.sps[0], pps: e.avcC.pps[0], chromaFormat: e.avcC.chromaFormat ?? 1, bitDepthLuma: e.avcC.bitDepthLuma ?? 8, bitDepthChroma: e.avcC.bitDepthChroma ?? 8 };
    return { id: t.id, type: 'audio', timescale: t.timescale, codec: t.codec, audio: { objectType: e.esds.audioObjectType, sampleRateIndex: e.esds.samplingFrequencyIndex, sampleRate: e.esds.sampleRate, channels: e.esds.channelConfiguration, bitrate: e.esds.avgBitrate } };
  });
  // Every sample of every fragment, in file order: timing from tfdt/trun (resolved against tfhd), bytes from mdat.
  const fragments = [];
  for (const moof of moofs) {
    const seq = E.mp4FindBox(moof, 'mfhd').sequenceNumber;
    for (const traf of moof.children.filter((b) => b.type === 'traf')) {
      const tfhd = E.mp4FindBox(traf, 'tfhd'), tfdt = E.mp4FindBox(traf, 'tfdt');
      const base = tfhd.baseDataOffset != null ? tfhd.baseDataOffset : moof.offset; // default-base-is-moof (or first traf)
      let pos = base;
      const samples = [];
      for (const trun of traf.children.filter((b) => b.type === 'trun')) {
        if (trun.dataOffset != null) pos = base + trun.dataOffset;
        for (const s of trun.samples) {
          samples.push({ data: bytes.subarray(pos, pos + s.size), duration: s.duration, cts: s.cts, key: (s.flags & 0x00010000) === 0, flags: s.flags, size: s.size });
          pos += s.size;
        }
      }
      fragments.push({ trackId: tfhd.trackId, seq, bmdt: tfdt.baseMediaDecodeTime, samples });
    }
  }
  const myInit = E.mp4InitSegment(muxTracks);
  const segments = fragments.map((f) => E.mp4MediaSegment(muxTracks.find((t) => t.id === f.trackId), f.samples, { sequenceNumber: f.seq, baseMediaDecodeTime: f.bmdt }));
  const remuxed = E.concatBytes([myInit, ...segments]);
  const out = join(dir, 'remuxed.mp4');
  writeFileSync(out, Buffer.from(remuxed.buffer, remuxed.byteOffset, remuxed.byteLength));
  return (fixture = { src, out, bytes, boxes, init, tracks, entries, muxTracks, fragments, myInit, segments, remuxed });
}
function ffprobe(file, args) {
  const r = spawnSync('ffprobe', ['-v', 'error', ...args, '-of', 'json', file], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, 'ffprobe failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}
const packetShape = (p) => ({ pts: p.pts, dts: p.dts, duration: p.duration, size: p.size, flags: p.flags });
test('ffmpeg: the source parses as expected (2 tracks, ffmpeg trun/tfhd layout, all fragments)', () => {
  const f = realFixture(); if (!f) return;
  assert.equal(f.boxes.truncated, false);
  deepEq(f.boxes.map((b) => b.type).filter((t, i, a) => a.indexOf(t) === i), ['ftyp', 'moov', 'moof', 'mdat', 'mfra']);
  deepEq(f.tracks.map((t) => [t.id, t.type, t.timescale, t.codec, t.width, t.height, t.sampleRate, t.channels]), [[1, 'video', 12800, 'avc1.64000c', 320, 180, 0, 0], [2, 'audio', 48000, 'mp4a.40.2', 0, 0, 48000, 1]]);
  deepEq([f.entries[0].avcC.sps.length, f.entries[0].avcC.pps.length, f.entries[0].avcC.chromaFormat, f.entries[0].avcC.bitDepthLuma, f.entries[0].avcC.lengthSizeMinusOne], [1, 1, 1, 8, 3]);
  deepEq([f.entries[1].esds.objectTypeIndication, f.entries[1].esds.audioObjectType, f.entries[1].esds.samplingFrequencyIndex, f.entries[1].esds.channelConfiguration], [0x40, 2, 3, 1]);
  assert.ok(f.entries[1].esds.avgBitrate > 0);
  const counts = {};
  for (const fr of f.fragments) counts[fr.trackId] = (counts[fr.trackId] || 0) + fr.samples.length;
  deepEq(counts, { 1: 50, 2: 95 });
  assert.ok(f.fragments.every((fr) => fr.samples.every((s) => s.data.length === s.size && s.size > 0 && s.duration > 0)));
  assert.ok(f.fragments.some((fr) => fr.samples.some((s) => s.cts > 0)), 'B-frames give composition offsets');
  assert.equal(E.mp4Tfdt(f.bytes), 0);
  // the parser's byte accounting is exact: the last sample of every fragment ends at the end of its mdat
  for (const moof of f.boxes.filter((b) => b.type === 'moof')) {
    const mdat = f.boxes.find((b) => b.type === 'mdat' && b.offset > moof.offset);
    const trun = E.mp4FindBox(moof, 'trun');
    assert.equal(moof.offset + trun.dataOffset + trun.samples.reduce((n, s) => n + s.size, 0), mdat.offset + mdat.size);
  }
});
test('ffmpeg: codec strings of the re-muxed init equal the source (and a round trip of the init parses identically)', () => {
  const f = realFixture(); if (!f) return;
  deepEq(E.mp4CodecsFromInit(f.myInit), E.mp4CodecsFromInit(f.init));
  deepEq(E.mp4CodecsFromInit(f.myInit), ['avc1.64000c', 'mp4a.40.2']);
  deepEq(E.mp4TracksFromInit(f.myInit), E.mp4TracksFromInit(f.init));
  const mine = E.mp4FindBox(E.mp4ParseBoxes(f.myInit), 'avcC'), theirs = E.mp4FindBox(f.boxes, 'avcC');
  bytesEq(mine.data, theirs.data, 'avcC reproduced byte for byte');
  const myAudioTrak = E.mp4FindBox(E.mp4ParseBoxes(f.myInit), 'moov').children.filter((b) => b.type === 'trak')[1];
  const myEsds = E.mp4FindBox(myAudioTrak, 'stsd').entries[0].esds, theirsEsds = f.entries[1].esds;
  const shape = (e) => [e.objectTypeIndication, e.streamType, e.audioObjectType, e.samplingFrequencyIndex, e.sampleRate, e.channelConfiguration, e.avgBitrate, e.maxBitrate];
  deepEq(shape(myEsds), shape(theirsEsds));
  // ffmpeg writes the 5-byte AudioSpecificConfig (core + an explicit "no SBR" sync extension); the muxer
  // writes the 2-byte core, which carries the same object type / rate / channels.
  bytesEq(myEsds.decoderSpecificInfo, theirsEsds.decoderSpecificInfo.subarray(0, 2), 'AudioSpecificConfig core reproduced byte for byte');
  assert.equal(myEsds.decoderSpecificInfo.length, 2);
});
test('ffmpeg: round trip — parsing the re-muxed segments reproduces the sample table fed in', () => {
  const f = realFixture(); if (!f) return;
  const boxes = E.mp4ParseBoxes(f.remuxed);
  assert.equal(boxes.truncated, false);
  const moofs = boxes.filter((b) => b.type === 'moof');
  assert.equal(moofs.length, f.fragments.length);
  moofs.forEach((moof, i) => {
    const fr = f.fragments[i], trun = E.mp4FindBox(moof, 'trun'), tfhd = E.mp4FindBox(moof, 'tfhd');
    deepEq([E.mp4FindBox(moof, 'mfhd').sequenceNumber, tfhd.trackId, tfhd.flags, E.mp4FindBox(moof, 'tfdt').baseMediaDecodeTime, E.mp4FindBox(moof, 'tfdt').version], [fr.seq, fr.trackId, 0x020000, fr.bmdt, 1]);
    deepEq(trun.samples, fr.samples.map((s) => ({ duration: s.duration, size: s.size, flags: s.flags, cts: s.cts })));
    const mdat = boxes.find((b) => b.type === 'mdat' && b.offset > moof.offset);
    assert.equal(moof.offset + trun.dataOffset, mdat.offset + 8);
    bytesEq(mdat.data, E.concatBytes(fr.samples.map((s) => s.data)));
  });
  bytesEq(E.concatBytes([f.myInit, ...f.fragments.map((fr) => E.mp4MediaSegment(f.muxTracks.find((t) => t.id === fr.trackId), fr.samples, { sequenceNumber: fr.seq, baseMediaDecodeTime: fr.bmdt }))]), f.remuxed, 'deterministic');
});
test('ffmpeg: ffprobe -show_streams on the re-mux: h264 High 320x180 + aac 48000 Hz, same channels and time bases as the source', () => {
  const f = realFixture(); if (!f) return;
  const mine = ffprobe(f.out, ['-show_streams']).streams, src = ffprobe(f.src, ['-show_streams']).streams;
  assert.equal(mine.length, 2);
  deepEq([mine[0].codec_name, mine[0].profile, mine[0].width, mine[0].height, mine[0].codec_type, mine[0].time_base], ['h264', 'High', 320, 180, 'video', src[0].time_base]);
  deepEq([mine[1].codec_name, mine[1].sample_rate, mine[1].channels, mine[1].codec_type, mine[1].time_base], ['aac', '48000', src[1].channels, 'audio', src[1].time_base]);
  deepEq([mine[0].level, mine[0].pix_fmt, mine[0].has_b_frames, mine[1].profile, mine[1].channel_layout], [src[0].level, src[0].pix_fmt, src[0].has_b_frames, src[1].profile, src[1].channel_layout]);
  deepEq([mine[0].tags.handler_name, mine[1].tags.handler_name, mine[0].tags.language], ['VideoHandler', 'SoundHandler', 'und']);
});
test('ffmpeg: ffprobe -show_packets: packet count, pts, dts, duration, size and key flags per stream equal the source', () => {
  const f = realFixture(); if (!f) return;
  const mine = ffprobe(f.out, ['-show_packets']).packets, src = ffprobe(f.src, ['-show_packets']).packets;
  for (const idx of [0, 1]) {
    const a = mine.filter((p) => p.stream_index === idx).map(packetShape), b = src.filter((p) => p.stream_index === idx).map(packetShape);
    assert.equal(a.length, idx === 0 ? 50 : 95);
    deepEq(a, b, 'stream ' + idx);
  }
});
test('ffmpeg: ffprobe -count_frames: decoded frame and packet counts equal the source', () => {
  const f = realFixture(); if (!f) return;
  const shape = (s) => s.streams.map((x) => [x.codec_type, x.nb_read_frames, x.nb_read_packets]);
  const args = ['-count_frames', '-count_packets', '-show_entries', 'stream=codec_type,nb_read_frames,nb_read_packets'];
  const mine = shape(ffprobe(f.out, args));
  deepEq(mine, shape(ffprobe(f.src, args)));
  deepEq(mine, [['video', '50', '50'], ['audio', '95', '95']]);
});
test('ffmpeg: "ffmpeg -v error -i remuxed.mp4 -f null -" decodes end to end without a single error', () => {
  const f = realFixture(); if (!f) return;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', f.out, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal((r.stderr || '').trim(), '');
  assert.equal((r.stdout || '').trim(), '');
});

run();
