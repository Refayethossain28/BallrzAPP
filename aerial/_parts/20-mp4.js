/* ===== MP4: fragmented-MP4 muxer (ISO 14496-12/14/15) + tolerant box parser ===== */
var MP4 = (function () {
  'use strict';

  var concatBytes = UTIL.concatBytes, u16be = UTIL.u16be, u24be = UTIL.u24be, u32be = UTIL.u32be, u64be = UTIL.u64be;
  var writeU16be = UTIL.writeU16be, writeU32be = UTIL.writeU32be, writeU64be = UTIL.writeU64be;

  // AudioSpecificConfig samplingFrequencyIndex table (ISO 14496-3 §1.6.3.4).
  var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  // trun sample_flags (ISO 14496-12 §8.8.3.1): a sync sample depends on nothing (depends_on=2); every other
  // sample depends on another (depends_on=1) and carries the non-sync bit, which is what MSE keys seeking on.
  var SAMPLE_FLAG_KEY = 0x02000000, SAMPLE_FLAG_NONKEY = 0x01010000;
  var TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
  var TRUN_FLAGS_FULL = 0x000f01; // data-offset | duration | size | flags | composition-offset per sample
  // Identity transform in the 16.16 (and 2.30 for the last entry) fixed-point matrix layout.
  var MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  var LANG_UND = 0x55c4; // 'und' packed as three 5-bit letters
  // Profiles whose avcC carries the chroma/bit-depth extension (14496-15 §5.3.3.1.2). 144 is the retired
  // High 4:4:4 profile from the 2010 text, 244 its High 4:4:4 Predictive successor; both are listed there.
  var AVC_HIGH_PROFILES = [100, 110, 122, 144, 244];
  // Real files nest at most ~6 deep (moov/trak/mdia/minf/stbl); the cap keeps a hostile "box inside box inside
  // box…" buffer from recursing until the stack dies, since every nested box costs only 8 bytes of input.
  var MAX_DEPTH = 12;
  // A trun with no per-sample fields (all defaults) is parsed into a sample list of this size at most, so a
  // junk sample_count of 4 billion cannot allocate 4 billion entries.
  var MAX_DEFAULT_SAMPLES = 65536;

  var CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, mvex: 1, moof: 1, traf: 1, dinf: 1, edts: 1, mfra: 1, meta: 1 };
  var VIDEO_ENTRIES = { avc1: 1, avc2: 1, avc3: 1, avc4: 1, hvc1: 1, hev1: 1, av01: 1, vp08: 1, vp09: 1, mp4v: 1, dvh1: 1, dvhe: 1, dva1: 1, dvav: 1, encv: 1 };
  var AUDIO_ENTRIES = { mp4a: 1, 'ac-3': 1, 'ec-3': 1, 'ac-4': 1, Opus: 1, fLaC: 1, alac: 1, '.mp3': 1, samr: 1, sawb: 1, enca: 1 };
  var FIXED_AUDIO_CODECS = { 'ac-3': 'ac-3', 'ec-3': 'ec-3', 'ac-4': 'ac-4', Opus: 'opus', fLaC: 'flac', alac: 'alac', '.mp3': 'mp3' };

  /* ---------- input coercion (cross-realm safe: instanceof fails across vm contexts) ---------- */
  function isArrayBuffer(x) { return Object.prototype.toString.call(x) === '[object ArrayBuffer]'; }
  function toBytes(x) {
    if (x == null) return null;
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (isArrayBuffer(x)) return new Uint8Array(x);
    if (Array.isArray(x)) return new Uint8Array(x);
    return null;
  }
  function toUint(v, max) {
    v = +v;
    if (!(v >= 0)) return 0; // NaN, negative, non-numeric
    v = Math.floor(v);
    return max != null && v > max ? max : v;
  }
  function toInt32(v) {
    v = +v;
    if (v !== v) return 0;
    v = Math.trunc(v);
    return v > 0x7fffffff ? 0x7fffffff : v < -0x80000000 ? -0x80000000 : v;
  }
  function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- byte writers ---------- */
  function b8(v) { return new Uint8Array([v & 0xff]); }
  function b16(v) { var b = new Uint8Array(2); writeU16be(b, 0, v); return b; }
  function b32(v) { var b = new Uint8Array(4); writeU32be(b, 0, v); return b; }
  function b64(v) { var b = new Uint8Array(8); writeU64be(b, 0, v); return b; }
  function b32s(list) { var b = new Uint8Array(list.length * 4); for (var i = 0; i < list.length; i++) writeU32be(b, i * 4, list[i]); return b; }
  function zeros(n) { return new Uint8Array(n); }
  function fourcc(s) {
    s = (String(s == null ? '' : s) + '    ').slice(0, 4);
    var b = new Uint8Array(4);
    for (var i = 0; i < 4; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }
  function cstr(s) { return concatBytes([UTIL.bytesOfText(s), b8(0)]); }
  function collectPayloads(args, from) {
    var parts = [];
    for (var i = from; i < args.length; i++) { var p = toBytes(args[i]); if (p) parts.push(p); }
    return parts;
  }

  // box = u32 size | 4cc type | payload…  Payloads are byte views, ArrayBuffers or arrays of byte values;
  // null/undefined payloads are skipped so optional pieces can be passed straight through.
  function mp4Box(type) {
    var parts = collectPayloads(arguments, 1), n = 8, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n);
    writeU32be(out, 0, n);
    out.set(fourcc(type), 4);
    for (i = 0, n = 8; i < parts.length; i++) { out.set(parts[i], n); n += parts[i].length; }
    return out;
  }
  // FullBox = box whose payload starts with u8 version | u24 flags.
  function mp4FullBox(type, version, flags) {
    var args = [type, b32(((toUint(version, 255) << 24) | toUint(flags, 0xffffff)) >>> 0)];
    return mp4Box.apply(null, args.concat(collectPayloads(arguments, 3)));
  }

  /* ---------- AAC AudioSpecificConfig ---------- */
  // Channel count → channel_configuration: identical for 1–7 (7 = 7.1 is 8 speakers), 8 → 7.
  function channelConfigOf(channels) {
    var n = toUint(channels, 8);
    return n === 8 ? 7 : n;
  }
  // 5 bits audioObjectType | 4 bits samplingFrequencyIndex | 4 bits channelConfiguration | 3 zero bits
  // (frameLengthFlag, dependsOnCoreCoder, extensionFlag) — the 2-byte form every AAC-LC/HE stream uses.
  function aacConfigBytes(objectType, sampleRateIndex, channels) {
    var ot = toUint(objectType, 31) || 2, sri = toUint(sampleRateIndex, 15), ch = channelConfigOf(channels);
    return new Uint8Array([(ot << 3) | (sri >> 1), ((sri & 1) << 7) | (ch << 3)]);
  }
  function rateIndexOf(sampleRate) {
    var best = 3, bestDist = Infinity; // 48 kHz when nothing is known
    for (var i = 0; i < AAC_RATES.length; i++) {
      var d = Math.abs(AAC_RATES[i] - sampleRate);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  /* ---------- track normalisation ---------- */
  function normalizeTrack(t) {
    if (!t || typeof t !== 'object') return null;
    var type = t.type === 'video' || t.type === 'audio' ? t.type : null;
    var id = toUint(t.id, 0xffffffff), timescale = toUint(t.timescale, 0xffffffff);
    if (!type || !id || !timescale) return null;
    var out = { id: id, type: type, timescale: timescale };
    if (type === 'video') {
      var sps = toBytes(t.sps), pps = toBytes(t.pps);
      // avcC needs profile/compat/level from sps[1..3] and u16 lengths, so anything shorter or longer is junk.
      if (!sps || sps.length < 4 || sps.length > 0xffff || !pps || !pps.length || pps.length > 0xffff) return null;
      out.sps = sps; out.pps = pps;
      out.width = toUint(t.width, 0xffff); out.height = toUint(t.height, 0xffff);
      out.chromaFormat = t.chromaFormat == null ? 1 : toUint(t.chromaFormat, 3);
      var depth = t.bitDepth == null ? 8 : toUint(t.bitDepth, 15);
      out.bitDepthLuma = t.bitDepthLuma == null ? depth : toUint(t.bitDepthLuma, 15);
      out.bitDepthChroma = t.bitDepthChroma == null ? depth : toUint(t.bitDepthChroma, 15);
      if (out.bitDepthLuma < 8) out.bitDepthLuma = 8;
      if (out.bitDepthChroma < 8) out.bitDepthChroma = 8;
    } else {
      var a = t.audio && typeof t.audio === 'object' ? t.audio : {};
      var codec = String(t.codec == null ? '' : t.codec).toLowerCase();
      var sri = +a.sampleRateIndex, rate = toUint(a.sampleRate, 0xffffffff);
      // Indices 13/14 are reserved and 15 means "explicit rate", which the 2-byte config cannot carry.
      if (!(sri >= 0 && sri <= 12 && sri === Math.floor(sri))) sri = rateIndexOf(rate || timescale);
      out.audio = {
        mp3: codec === 'mp3' || codec.indexOf('mp4a.6b') === 0 || codec.indexOf('mp4a.69') === 0,
        objectType: toUint(a.objectType, 31) || 2,
        sampleRateIndex: sri,
        sampleRate: rate || AAC_RATES[sri],
        channels: toUint(a.channels, 0xffff) || 2,
        bitrate: toUint(a.bitrate, 0xffffffff)
      };
    }
    return out;
  }
  function normalizeTracks(tracks) {
    var out = [], seen = {};
    if (!Array.isArray(tracks)) return out;
    for (var i = 0; i < tracks.length; i++) {
      var t = normalizeTrack(tracks[i]);
      if (t && !seen[t.id]) { seen[t.id] = 1; out.push(t); } // a duplicate id would make an unplayable moov
    }
    return out;
  }

  /* ---------- init segment (ftyp + moov) ---------- */
  function ftyp() {
    // iso5 (64-bit tfdt, default-base-is-moof) with the brands every MSE implementation accepts.
    return mp4Box('ftyp', fourcc('iso5'), b32(1), fourcc('iso5'), fourcc('iso6'), fourcc('mp41'), fourcc('avc1'));
  }
  function mvhd(nextTrackId) {
    return mp4FullBox('mvhd', 0, 0,
      b32(0), b32(0),                 // creation / modification time: a live remux has no authored date
      b32(1000), b32(0),              // timescale 1000; duration 0 = the fragments define the timeline
      b32(0x00010000), b16(0x0100),   // rate 1.0, volume 1.0
      zeros(10),                      // reserved
      b32s(MATRIX), zeros(24),        // identity matrix, pre_defined[6]
      b32(nextTrackId));
  }
  function tkhd(t) {
    var video = t.type === 'video';
    return mp4FullBox('tkhd', 0, 7, // enabled | in_movie | in_preview
      b32(0), b32(0), b32(t.id), b32(0), b32(0), // times, track id, reserved, duration 0
      zeros(8), b16(0), b16(0),                  // reserved, layer, alternate_group
      b16(video ? 0 : 0x0100), b16(0),           // volume 1.0 only means something for audio
      b32s(MATRIX),
      b16(video ? t.width : 0), b16(0), b16(video ? t.height : 0), b16(0)); // 16.16 fixed point
  }
  function mdhd(t) {
    return mp4FullBox('mdhd', 0, 0, b32(0), b32(0), b32(t.timescale), b32(0), b16(LANG_UND), b16(0));
  }
  function hdlr(t) {
    var video = t.type === 'video';
    return mp4FullBox('hdlr', 0, 0, b32(0), fourcc(video ? 'vide' : 'soun'), zeros(12), cstr(video ? 'VideoHandler' : 'SoundHandler'));
  }
  function dinf() {
    // One self-contained data reference: the samples live in this file (flags 1).
    return mp4Box('dinf', mp4FullBox('dref', 0, 0, b32(1), mp4FullBox('url ', 0, 1)));
  }
  function avcC(t) {
    var sps = t.sps, pps = t.pps;
    var parts = ['avcC', b8(1), b8(sps[1]), b8(sps[2]), b8(sps[3]), // configurationVersion, profile, compat, level
      b8(0xff),                      // reserved 111111 | lengthSizeMinusOne 3 → 4-byte NAL length prefixes
      b8(0xe1), b16(sps.length), sps, // reserved 111 | 1 SPS
      b8(1), b16(pps.length), pps];
    if (AVC_HIGH_PROFILES.indexOf(sps[1]) !== -1) {
      parts.push(b8(0xfc | t.chromaFormat), b8(0xf8 | (t.bitDepthLuma - 8)), b8(0xf8 | (t.bitDepthChroma - 8)), b8(0)); // no SPS extensions
    }
    return mp4Box.apply(null, parts);
  }
  function avc1(t) {
    return mp4Box('avc1',
      zeros(6), b16(1),                   // reserved, data_reference_index → the single dref entry
      b16(0), b16(0), zeros(12),          // pre_defined, reserved, pre_defined[3]
      b16(t.width), b16(t.height),
      b32(0x00480000), b32(0x00480000),   // 72 dpi, 16.16
      b32(0), b16(1),                     // reserved, frame_count
      zeros(32),                          // compressorname (empty)
      b16(0x0018), b16(0xffff),           // depth 24, pre_defined -1
      avcC(t));
  }
  // 14496-1 expandable length: 7 bits per byte, high bit = "more bytes follow".
  function expandableLength(n) {
    var out = [n & 0x7f];
    for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 0x7f) | 0x80);
    return new Uint8Array(out);
  }
  function descriptor(tag) {
    var body = concatBytes(collectPayloads(arguments, 1));
    return concatBytes([b8(tag), expandableLength(body.length), body]);
  }
  function esds(a) {
    // MP3 in MP4 carries no DecoderSpecificInfo: the frame headers describe the stream (14496-14 §5.6).
    var dsi = a.mp3 ? null : descriptor(0x05, aacConfigBytes(a.objectType, a.sampleRateIndex, a.channels));
    var decoderConfig = descriptor(0x04,
      b8(a.mp3 ? 0x6b : 0x40),         // objectTypeIndication: MPEG-1 audio | MPEG-4 audio
      b8(0x15),                        // streamType 5 (audio) << 2 | upStream 0 | reserved 1
      zeros(3),                        // bufferSizeDB
      b32(a.bitrate), b32(a.bitrate),  // maxBitrate, avgBitrate (0 = unknown)
      dsi);
    var es = descriptor(0x03, b16(0), b8(0), decoderConfig, descriptor(0x06, b8(0x02))); // ES_ID 0, no flags, SL predefined 2
    return mp4FullBox('esds', 0, 0, es);
  }
  function mp4a(t) {
    var a = t.audio;
    return mp4Box('mp4a',
      zeros(6), b16(1),                       // reserved, data_reference_index
      zeros(8),                               // version, revision, vendor
      b16(a.channels), b16(16),               // channelcount, samplesize
      b16(0), b16(0),                         // pre_defined, reserved
      b16(a.sampleRate <= 0xffff ? a.sampleRate : 0), b16(0), // samplerate 16.16; mdhd carries rates this field cannot
      esds(a));
  }
  function stbl(t) {
    return mp4Box('stbl',
      mp4FullBox('stsd', 0, 0, b32(1), t.type === 'video' ? avc1(t) : mp4a(t)),
      mp4FullBox('stts', 0, 0, b32(0)),          // sample tables stay empty: every sample arrives in a moof
      mp4FullBox('stsc', 0, 0, b32(0)),
      mp4FullBox('stsz', 0, 0, b32(0), b32(0)),  // sample_size 0, sample_count 0
      mp4FullBox('stco', 0, 0, b32(0)));
  }
  function minf(t) {
    var header = t.type === 'video' ? mp4FullBox('vmhd', 0, 1, zeros(8)) : mp4FullBox('smhd', 0, 0, zeros(4));
    return mp4Box('minf', header, dinf(), stbl(t));
  }
  function trak(t) {
    return mp4Box('trak', tkhd(t), mp4Box('mdia', mdhd(t), hdlr(t), minf(t)));
  }
  function trex(t) {
    return mp4FullBox('trex', 0, 0, b32(t.id), b32(1), b32(0), b32(0), b32(0));
  }
  // → ftyp + moov for the given tracks, or null when no track is usable (MSE rejects a trackless moov).
  function mp4InitSegment(tracks) {
    var list = normalizeTracks(tracks);
    if (!list.length) return null;
    var maxId = 0, i;
    for (i = 0; i < list.length; i++) if (list[i].id > maxId) maxId = list[i].id;
    var boxes = ['moov', mvhd(maxId + 1)];
    for (i = 0; i < list.length; i++) boxes.push(trak(list[i]));
    boxes.push(mp4Box.apply(null, ['mvex'].concat(list.map(trex))));
    return concatBytes([ftyp(), mp4Box.apply(null, boxes)]);
  }

  /* ---------- media segment (moof + mdat) ---------- */
  // samples: [{data (bytes), duration (track timescale), cts (pts−dts, may be negative), key (bool)}].
  // Entries without byte data are skipped as junk; null when nothing is left or the track has no id.
  function mp4MediaSegment(track, samples, opts) {
    var id = track && typeof track === 'object' ? toUint(track.id, 0xffffffff) : 0;
    if (!id || !Array.isArray(samples)) return null;
    var list = [], total = 0, i, s;
    for (i = 0; i < samples.length; i++) {
      s = samples[i];
      var data = s && typeof s === 'object' ? toBytes(s.data) : null;
      if (!data || !data.length) continue;
      list.push({ data: data, duration: toUint(s.duration, 0xffffffff), cts: toInt32(s.cts), flags: s.key ? SAMPLE_FLAG_KEY : SAMPLE_FLAG_NONKEY });
      total += data.length;
    }
    var n = list.length;
    if (!n) return null;
    opts = opts && typeof opts === 'object' ? opts : {};
    var table = new Uint8Array(n * 16);
    for (i = 0; i < n; i++) {
      s = list[i];
      writeU32be(table, i * 16, s.duration);
      writeU32be(table, i * 16 + 4, s.data.length);
      writeU32be(table, i * 16 + 8, s.flags);
      writeU32be(table, i * 16 + 12, s.cts); // two's complement via >>> inside writeU32be
    }
    var moof = mp4Box('moof',
      mp4FullBox('mfhd', 0, 0, b32(toUint(opts.sequenceNumber, 0xffffffff) || 1)),
      mp4Box('traf',
        mp4FullBox('tfhd', 0, TFHD_DEFAULT_BASE_IS_MOOF, b32(id)),
        mp4FullBox('tfdt', 1, 0, b64(toUint(opts.baseMediaDecodeTime, 0x1fffffffffffff))),
        mp4FullBox('trun', 1, TRUN_FLAGS_FULL, b32(n), b32(0), table)));
    // data_offset is the 4 bytes just before the sample table (sample_count precedes it); with
    // default-base-is-moof it is relative to the moof start, so the first sample begins right after the mdat header.
    writeU32be(moof, moof.length - n * 16 - 4, moof.length + 8);
    var out = new Uint8Array(moof.length + 8 + total), o = moof.length;
    out.set(moof, 0);
    writeU32be(out, o, 8 + total);
    out.set(fourcc('mdat'), o + 4);
    for (i = 0, o += 8; i < n; i++) { out.set(list[i].data, o); o += list[i].data.length; }
    return out;
  }

  /* ---------- parser ---------- */
  function fourccAt(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
  function fullHeader(box, bytes, s, e) {
    if (e - s < 4) return false;
    box.version = bytes[s];
    box.flags = u24be(bytes, s + 1);
    return true;
  }
  function findChild(box, type) {
    var kids = box && box.children ? box.children : [];
    for (var i = 0; i < kids.length; i++) if (kids[i].type === type) return kids[i];
    return null;
  }
  function childrenOf(box, type) {
    return (box && box.children ? box.children : []).filter(function (b) { return b.type === type; });
  }

  function parseFull(box, bytes, s, e) { fullHeader(box, bytes, s, e); }
  function parseFtyp(box, bytes, s, e) {
    if (e - s < 8) return;
    box.majorBrand = fourccAt(bytes, s);
    box.minorVersion = u32be(bytes, s + 4);
    box.compatibleBrands = [];
    for (var p = s + 8; p + 4 <= e; p += 4) box.compatibleBrands.push(fourccAt(bytes, p));
  }
  function parseMvhd(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e)) return;
    var v1 = box.version === 1;
    if (e - s < (v1 ? 112 : 100)) return;
    box.timescale = u32be(bytes, s + (v1 ? 20 : 12));
    box.duration = v1 ? u64be(bytes, s + 24) : u32be(bytes, s + 16);
    box.nextTrackId = u32be(bytes, e - 4);
  }
  function parseTkhd(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e)) return;
    var v1 = box.version === 1;
    if (e - s < (v1 ? 96 : 84)) return;
    box.trackId = u32be(bytes, s + (v1 ? 20 : 12));
    box.duration = v1 ? u64be(bytes, s + 28) : u32be(bytes, s + 20);
    box.width = u32be(bytes, e - 8) / 65536;
    box.height = u32be(bytes, e - 4) / 65536;
  }
  function parseMdhd(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e)) return;
    var v1 = box.version === 1;
    if (e - s < (v1 ? 36 : 24)) return;
    box.timescale = u32be(bytes, s + (v1 ? 20 : 12));
    box.duration = v1 ? u64be(bytes, s + 24) : u32be(bytes, s + 16);
    var lang = u16be(bytes, s + (v1 ? 32 : 20));
    box.language = String.fromCharCode(0x60 + ((lang >> 10) & 31), 0x60 + ((lang >> 5) & 31), 0x60 + (lang & 31));
  }
  function parseHdlr(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e) || e - s < 24) return;
    box.handlerType = fourccAt(bytes, s + 8);
    box.name = UTIL.textOf(bytes.subarray(s + 24, e)).replace(/\0+$/, '');
  }
  function parseTrex(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e) || e - s < 24) return;
    box.trackId = u32be(bytes, s + 4);
    box.defaultSampleDescriptionIndex = u32be(bytes, s + 8);
    box.defaultSampleDuration = u32be(bytes, s + 12);
    box.defaultSampleSize = u32be(bytes, s + 16);
    box.defaultSampleFlags = u32be(bytes, s + 20);
  }
  function parseElst(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e) || e - s < 8) return;
    var v1 = box.version === 1, entrySize = v1 ? 20 : 12, count = u32be(bytes, s + 4), p = s + 8;
    box.entries = [];
    for (var i = 0; i < count && p + entrySize <= e; i++, p += entrySize) {
      // media_time is signed; -1 (an empty edit) is the only negative value the format defines, and a
      // 64-bit -1 cannot survive the double conversion in u64be, so the sign bit decides.
      var mediaTime = v1 ? ((u32be(bytes, p + 8) & 0x80000000) ? -1 : u64be(bytes, p + 8)) : (u32be(bytes, p + 4) | 0);
      box.entries.push({
        segmentDuration: v1 ? u64be(bytes, p) : u32be(bytes, p),
        mediaTime: mediaTime,
        mediaRate: (u16be(bytes, p + (v1 ? 16 : 8)) << 16 >> 16) + u16be(bytes, p + (v1 ? 18 : 10)) / 65536
      });
    }
    if (box.entries.length < count) box.truncated = true;
  }
  function parseMfhd(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e) || e - s < 8) return;
    box.sequenceNumber = u32be(bytes, s + 4);
  }
  function parseTfhd(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e) || e - s < 8) return;
    var f = box.flags, p = s + 8;
    box.trackId = u32be(bytes, s + 4);
    box.baseDataOffset = null; box.sampleDescriptionIndex = null;
    box.defaultSampleDuration = null; box.defaultSampleSize = null; box.defaultSampleFlags = null;
    box.durationIsEmpty = !!(f & 0x10000);
    box.defaultBaseIsMoof = !!(f & TFHD_DEFAULT_BASE_IS_MOOF);
    if ((f & 0x01) && p + 8 <= e) { box.baseDataOffset = u64be(bytes, p); p += 8; }
    if ((f & 0x02) && p + 4 <= e) { box.sampleDescriptionIndex = u32be(bytes, p); p += 4; }
    if ((f & 0x08) && p + 4 <= e) { box.defaultSampleDuration = u32be(bytes, p); p += 4; }
    if ((f & 0x10) && p + 4 <= e) { box.defaultSampleSize = u32be(bytes, p); p += 4; }
    if ((f & 0x20) && p + 4 <= e) { box.defaultSampleFlags = u32be(bytes, p); }
  }
  function parseTfdt(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e)) return;
    if (box.version === 1 && e - s >= 12) box.baseMediaDecodeTime = u64be(bytes, s + 4);
    else if (box.version !== 1 && e - s >= 8) box.baseMediaDecodeTime = u32be(bytes, s + 4);
  }
  function parseTrun(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e) || e - s < 8) return;
    var f = box.flags, p = s + 8, v1 = box.version === 1;
    var hasDur = !!(f & 0x100), hasSize = !!(f & 0x200), hasFlags = !!(f & 0x400), hasCts = !!(f & 0x800);
    var perSample = (hasDur ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlags ? 4 : 0) + (hasCts ? 4 : 0);
    box.sampleCount = u32be(bytes, s + 4);
    box.dataOffset = null; box.firstSampleFlags = null; box.samples = [];
    if ((f & 0x01) && p + 4 <= e) { box.dataOffset = u32be(bytes, p) | 0; p += 4; }
    if ((f & 0x04) && p + 4 <= e) { box.firstSampleFlags = u32be(bytes, p); p += 4; }
    var n = perSample ? box.sampleCount : Math.min(box.sampleCount, MAX_DEFAULT_SAMPLES);
    for (var i = 0; i < n; i++) {
      if (p + perSample > e) { box.truncated = true; break; }
      var smp = { duration: null, size: null, flags: null, cts: null };
      if (hasDur) { smp.duration = u32be(bytes, p); p += 4; }
      if (hasSize) { smp.size = u32be(bytes, p); p += 4; }
      if (hasFlags) { smp.flags = u32be(bytes, p); p += 4; }
      if (hasCts) { smp.cts = v1 ? (u32be(bytes, p) | 0) : u32be(bytes, p); p += 4; }
      box.samples.push(smp);
    }
    if (n < box.sampleCount) box.truncated = true;
  }
  function parseSidx(box, bytes, s, e) {
    if (!fullHeader(box, bytes, s, e)) return;
    var v1 = box.version === 1, head = v1 ? 32 : 24;
    if (e - s < head) return;
    box.referenceId = u32be(bytes, s + 4);
    box.timescale = u32be(bytes, s + 8);
    box.earliestPresentationTime = v1 ? u64be(bytes, s + 12) : u32be(bytes, s + 12);
    box.firstOffset = v1 ? u64be(bytes, s + 20) : u32be(bytes, s + 16);
    var count = u16be(bytes, s + head - 2), p = s + head;
    box.references = [];
    for (var i = 0; i < count && p + 12 <= e; i++, p += 12) {
      var a = u32be(bytes, p), c = u32be(bytes, p + 8);
      box.references.push({
        referenceType: a >>> 31, referencedSize: a & 0x7fffffff, subsegmentDuration: u32be(bytes, p + 4),
        startsWithSap: c >>> 31, sapType: (c >>> 28) & 7, sapDeltaTime: c & 0x0fffffff
      });
    }
    if (box.references.length < count) box.truncated = true;
  }

  /* ----- sample entries (stsd) and codec strings ----- */
  function parseAvcC(d) {
    if (d.length < 7) return null;
    var out = { configurationVersion: d[0], profile: d[1], compat: d[2], level: d[3], lengthSizeMinusOne: d[4] & 3, sps: [], pps: [], chromaFormat: null, bitDepthLuma: null, bitDepthChroma: null };
    var p = 6, n = d[5] & 31, i, len;
    for (i = 0; i < n && p + 2 <= d.length; i++) { len = u16be(d, p); p += 2; if (p + len > d.length) return out; out.sps.push(d.subarray(p, p + len)); p += len; }
    if (p >= d.length) return out;
    n = d[p++];
    for (i = 0; i < n && p + 2 <= d.length; i++) { len = u16be(d, p); p += 2; if (p + len > d.length) return out; out.pps.push(d.subarray(p, p + len)); p += len; }
    if (AVC_HIGH_PROFILES.indexOf(out.profile) !== -1 && p + 3 <= d.length) {
      out.chromaFormat = d[p] & 3;
      out.bitDepthLuma = (d[p + 1] & 7) + 8;
      out.bitDepthChroma = (d[p + 2] & 7) + 8;
    }
    return out;
  }
  function reverseBits32(v) {
    var r = 0;
    for (var i = 0; i < 32; i++) { r = (r << 1) | (v & 1); v >>>= 1; }
    return r >>> 0;
  }
  function parseHvcC(d) {
    if (d.length < 13) return null;
    return { profileSpace: d[1] >> 6, tier: (d[1] >> 5) & 1, profileIdc: d[1] & 31, compat: u32be(d, 2), constraints: d.subarray(6, 12), level: d[12] };
  }
  // 14496-15 Annex E.3: hvc1.<space><profile>.<compat flags bit-reversed, hex>.<L|H><level>[.<constraint bytes, trailing zeros dropped>]
  function hevcCodecString(type, h) {
    var s = type + '.' + ['', 'A', 'B', 'C'][h.profileSpace] + h.profileIdc + '.' + reverseBits32(h.compat).toString(16).toUpperCase() + '.' + (h.tier ? 'H' : 'L') + h.level;
    var last = h.constraints.length;
    while (last > 0 && h.constraints[last - 1] === 0) last--;
    for (var i = 0; i < last; i++) s += '.' + hex2(h.constraints[i]).toUpperCase();
    return s;
  }
  function av1CodecString(d) {
    if (d.length < 4) return 'av01';
    var profile = d[1] >> 5, level = d[1] & 31, tier = d[2] >> 7, high = (d[2] >> 6) & 1, twelve = (d[2] >> 5) & 1;
    return 'av01.' + profile + '.' + pad2(level) + (tier ? 'H' : 'M') + '.' + pad2(high ? (twelve ? 12 : 10) : 8);
  }
  function vp9CodecString(type, d) {
    // vpcC is a FullBox: profile, level, bitDepth(4)|chromaSubsampling(3)|fullRange(1) follow version/flags.
    if (d.length < 7) return type;
    return type + '.' + pad2(d[4]) + '.' + pad2(d[5]) + '.' + pad2(d[6] >> 4);
  }
  // 14496-1 descriptor header: tag, then an expandable length (ffmpeg always writes the 4-byte form 80 80 80 nn).
  function readDescriptor(d, p, end) {
    if (p + 2 > end) return null;
    var tag = d[p++], len = 0, b;
    for (var i = 0; i < 4; i++) {
      if (p >= end) return null;
      b = d[p++];
      len = len * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { tag: tag, start: p, end: Math.min(p + len, end) }; // an overstated length is clipped, not fatal
  }
  function parseAudioSpecificConfig(d) {
    if (!d || d.length < 2) return null;
    var pos = 0;
    function bits(n) {
      var v = 0;
      for (var i = 0; i < n; i++, pos++) { var byte = pos >> 3 < d.length ? d[pos >> 3] : 0; v = v * 2 + ((byte >> (7 - (pos & 7))) & 1); }
      return v;
    }
    var ot = bits(5);
    if (ot === 31) ot = 32 + bits(6);
    var sri = bits(4), rate = sri === 15 ? bits(24) : (sri < AAC_RATES.length ? AAC_RATES[sri] : null);
    return { audioObjectType: ot, samplingFrequencyIndex: sri, sampleRate: rate, channelConfiguration: bits(4) };
  }
  function parseEsds(d) {
    var out = { objectTypeIndication: null, streamType: null, maxBitrate: null, avgBitrate: null, decoderSpecificInfo: null, audioObjectType: null, samplingFrequencyIndex: null, sampleRate: null, channelConfiguration: null };
    var end = d.length;
    if (end < 4) return out;
    var es = readDescriptor(d, 4, end);
    if (!es || es.tag !== 0x03 || es.end - es.start < 3) return out;
    var p = es.start + 3, esFlags = d[es.start + 2];
    if (esFlags & 0x80) p += 2;                                  // dependsOn_ES_ID
    if (esFlags & 0x40) p += 1 + (p < es.end ? d[p] : 0);        // URL
    if (esFlags & 0x20) p += 2;                                  // OCR_ES_Id
    while (p < es.end) {
      var h = readDescriptor(d, p, es.end);
      if (!h) break;
      if (h.tag === 0x04 && h.end - h.start >= 13) {
        out.objectTypeIndication = d[h.start];
        out.streamType = d[h.start + 1] >> 2;
        out.maxBitrate = u32be(d, h.start + 5);
        out.avgBitrate = u32be(d, h.start + 9);
        for (var q = h.start + 13; q < h.end;) {
          var g = readDescriptor(d, q, h.end);
          if (!g) break;
          if (g.tag === 0x05) out.decoderSpecificInfo = d.subarray(g.start, g.end);
          q = g.end;
        }
      }
      p = h.end;
    }
    var oti = out.objectTypeIndication;
    if (out.decoderSpecificInfo && (oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68)) {
      var asc = parseAudioSpecificConfig(out.decoderSpecificInfo);
      if (asc) { out.audioObjectType = asc.audioObjectType; out.samplingFrequencyIndex = asc.samplingFrequencyIndex; out.sampleRate = asc.sampleRate; out.channelConfiguration = asc.channelConfiguration; }
    }
    return out;
  }
  function entryCodec(entry) {
    var t = entry.type, c;
    if (t === 'avc1' || t === 'avc2' || t === 'avc3' || t === 'avc4') {
      c = findChild(entry, 'avcC');
      entry.avcC = c ? parseAvcC(c.data) : null;
      // RFC 6381: <entry type>.<profile><compat><level> as 6 hex digits, e.g. avc1.64001f
      return entry.avcC ? t + '.' + hex2(entry.avcC.profile) + hex2(entry.avcC.compat) + hex2(entry.avcC.level) : t;
    }
    if (t === 'hvc1' || t === 'hev1') {
      c = findChild(entry, 'hvcC');
      entry.hvcC = c ? parseHvcC(c.data) : null;
      return entry.hvcC ? hevcCodecString(t, entry.hvcC) : t;
    }
    if (t === 'av01') { c = findChild(entry, 'av1C'); return c ? av1CodecString(c.data) : t; }
    if (t === 'vp08' || t === 'vp09') { c = findChild(entry, 'vpcC'); return c ? vp9CodecString(t, c.data) : t; }
    if (t === 'mp4a') {
      c = findChild(entry, 'esds');
      if (!c) { // QuickTime wraps esds in a 'wave' atom inside version-1 sound entries
        var wave = findChild(entry, 'wave');
        c = wave ? findChild({ children: parseRange(wave.data, 0, wave.data.length, MAX_DEPTH).boxes }, 'esds') : null;
      }
      entry.esds = c ? parseEsds(c.data) : null;
      var oti = entry.esds ? entry.esds.objectTypeIndication : null;
      // No usable esds: AAC-LC is what nearly every mp4a track is, and MSE needs the object type to accept it.
      if (oti == null) return 'mp4a.40.2';
      var ot = entry.esds.audioObjectType;
      return 'mp4a.' + hex2(oti) + (oti === 0x40 ? '.' + (ot == null ? 2 : ot) : '');
    }
    if (FIXED_AUDIO_CODECS[t]) return FIXED_AUDIO_CODECS[t];
    return t.trim();
  }
  function parseStsd(box, bytes, s, e, depth) {
    if (!fullHeader(box, bytes, s, e) || e - s < 8) return;
    box.entryCount = u32be(bytes, s + 4);
    box.entries = [];
    for (var p = s + 8; p + 8 <= e && box.entries.length < box.entryCount;) {
      var size = u32be(bytes, p), type = fourccAt(bytes, p + 4), body = p + 8;
      if (size < 8 || p + size > e) { box.truncated = true; break; }
      var entry = { type: type, size: size, offset: p, codec: null, children: [] }, kids = -1;
      if (VIDEO_ENTRIES[type]) {
        entry.kind = 'video';
        if (size >= 86) { entry.width = u16be(bytes, body + 24); entry.height = u16be(bytes, body + 26); kids = body + 78; }
      } else if (AUDIO_ENTRIES[type]) {
        entry.kind = 'audio';
        if (size >= 36) {
          var version = u16be(bytes, body + 8);
          entry.channels = u16be(bytes, body + 16);
          entry.sampleSize = u16be(bytes, body + 18);
          entry.sampleRate = u16be(bytes, body + 24); // integer part of the 16.16 field
          // QuickTime v1 adds 16 bytes of packet sizing; v2 replaces the rate/channel fields with 36 bytes.
          kids = body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
          if (version === 2 && size >= 72) {
            entry.channels = u32be(bytes, body + 40);
            entry.sampleRate = new DataView(bytes.buffer, bytes.byteOffset + body + 32, 8).getFloat64(0);
          }
        }
      } else {
        entry.kind = 'unknown';
        entry.data = bytes.subarray(body, p + size);
      }
      if (kids >= 0 && kids <= p + size) entry.children = parseRange(bytes, kids, p + size, depth + 1).boxes;
      entry.codec = entry.kind === 'unknown' ? type.trim() : entryCodec(entry);
      box.entries.push(entry);
      p += size;
    }
    if (box.entries.length < box.entryCount) box.truncated = true;
  }

  var DETAILS = {
    ftyp: parseFtyp, styp: parseFtyp, mvhd: parseMvhd, tkhd: parseTkhd, mdhd: parseMdhd, hdlr: parseHdlr,
    stsd: parseStsd, trex: parseTrex, elst: parseElst, mfhd: parseMfhd, tfhd: parseTfhd, tfdt: parseTfdt,
    trun: parseTrun, sidx: parseSidx,
    vmhd: parseFull, smhd: parseFull, dref: parseFull, stts: parseFull, stsc: parseFull, stsz: parseFull, stco: parseFull
  };

  // Fill the per-sample fields a trun leaves out from the tfhd defaults (and first_sample_flags), so a
  // consumer sees one resolved {duration,size,flags,cts} per sample whatever the muxer chose to omit.
  function resolveTraf(traf) {
    var tfhd = findChild(traf, 'tfhd');
    var truns = childrenOf(traf, 'trun');
    for (var i = 0; i < truns.length; i++) {
      var tr = truns[i];
      for (var j = 0; j < tr.samples.length; j++) {
        var smp = tr.samples[j];
        if (smp.duration == null && tfhd) smp.duration = tfhd.defaultSampleDuration;
        if (smp.size == null && tfhd) smp.size = tfhd.defaultSampleSize;
        if (smp.flags == null) smp.flags = j === 0 && tr.firstSampleFlags != null ? tr.firstSampleFlags : (tfhd ? tfhd.defaultSampleFlags : null);
        if (smp.cts == null) smp.cts = 0;
      }
    }
  }

  function parseRange(bytes, start, end, depth) {
    var boxes = [], truncated = false, p = start;
    while (p < end) {
      if (end - p < 8) { truncated = true; break; }
      var size = u32be(bytes, p), type = fourccAt(bytes, p + 4), header = 8;
      if (size === 1) {
        if (end - p < 16) { truncated = true; break; }
        size = u64be(bytes, p + 8);
        header = 16;
      } else if (size === 0) {
        size = end - p; // "extends to the end of the file"
      }
      if (size < header || size > end - p) { truncated = true; break; } // cut short, or a size that cannot be
      var box = { type: type, size: size, offset: p, headerSize: header }, bodyStart = p + header, bodyEnd = p + size;
      // ISO 'meta' is a FullBox; QuickTime's is not. Version 0 / flags 0 is the only ISO form, so four zero
      // bytes there mean "skip them", anything else means the children start immediately.
      if (type === 'meta' && bodyEnd - bodyStart >= 4 && u32be(bytes, bodyStart) === 0) {
        box.version = 0; box.flags = 0;
        bodyStart += 4;
      }
      if (CONTAINERS[type] && depth < MAX_DEPTH) {
        var inner = parseRange(bytes, bodyStart, bodyEnd, depth + 1);
        box.children = inner.boxes;
        if (inner.truncated) box.truncated = true;
        if (type === 'traf') resolveTraf(box);
      } else {
        box.data = bytes.subarray(bodyStart, bodyEnd);
        if (DETAILS[type]) DETAILS[type](box, bytes, bodyStart, bodyEnd, depth);
      }
      boxes.push(box);
      p += size;
    }
    return { boxes: boxes, truncated: truncated };
  }
  // → array of boxes (see parseRange) with a `truncated` property: true when the top-level walk stopped
  // before the end of the input (a partial last box, or a size that does not fit). Containers that stop
  // early carry their own `truncated: true`.
  function mp4ParseBoxes(input) {
    var bytes = toBytes(input);
    var r = bytes ? parseRange(bytes, 0, bytes.length, 0) : { boxes: [], truncated: false };
    r.boxes.truncated = r.truncated;
    return r.boxes;
  }
  // Depth-first search for the first box of a type. Starts from a parsed array or any box; descends through
  // `children` and through stsd `entries` (each a box-shaped sample entry with its own children), so
  // avcC / esds / hvcC are reachable the same way as moov / trak.
  function nestedOf(box) { return box.children || box.entries || null; }
  function mp4FindBox(boxes, type) {
    var list = Array.isArray(boxes) ? boxes : (boxes && nestedOf(boxes)) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].type === type) return list[i];
      var hit = nestedOf(list[i]) ? mp4FindBox(list[i], type) : null;
      if (hit) return hit;
    }
    return null;
  }

  /* ---------- init-segment queries ---------- */
  var HANDLER_KIND = { vide: 'video', soun: 'audio', text: 'text', sbtl: 'text', subt: 'text', clcp: 'text', meta: 'meta' };
  function mp4TracksFromInit(bytes) {
    var moov = mp4FindBox(mp4ParseBoxes(bytes), 'moov'), out = [];
    if (!moov) return out;
    var traks = childrenOf(moov, 'trak');
    for (var i = 0; i < traks.length; i++) {
      var tkhd = findChild(traks[i], 'tkhd'), mdia = findChild(traks[i], 'mdia');
      var mdhd = findChild(mdia, 'mdhd'), hdlr = findChild(mdia, 'hdlr');
      var stsd = findChild(findChild(findChild(mdia, 'minf'), 'stbl'), 'stsd');
      var entry = stsd && stsd.entries && stsd.entries.length ? stsd.entries[0] : null;
      var kind = hdlr && HANDLER_KIND[hdlr.handlerType] ? HANDLER_KIND[hdlr.handlerType] : (entry && entry.kind !== 'unknown' ? entry.kind : 'unknown');
      out.push({
        id: tkhd && tkhd.trackId != null ? tkhd.trackId : i + 1,
        type: kind,
        timescale: mdhd && mdhd.timescale ? mdhd.timescale : null,
        codec: entry ? entry.codec : null,
        duration: mdhd && mdhd.duration != null ? mdhd.duration : 0,
        language: mdhd && mdhd.language ? mdhd.language : 'und',
        width: entry && entry.width != null ? entry.width : (tkhd && tkhd.width ? Math.round(tkhd.width) : 0),
        height: entry && entry.height != null ? entry.height : (tkhd && tkhd.height ? Math.round(tkhd.height) : 0),
        sampleRate: entry && entry.esds && entry.esds.sampleRate ? entry.esds.sampleRate : (entry && entry.sampleRate ? entry.sampleRate : 0),
        channels: entry && entry.esds && entry.esds.channelConfiguration ? entry.esds.channelConfiguration : (entry && entry.channels ? entry.channels : 0)
      });
    }
    return out;
  }
  function mp4CodecsFromInit(bytes) {
    return mp4TracksFromInit(bytes).map(function (t) { return t.codec; }).filter(function (c) { return !!c; });
  }
  function mp4Tfdt(bytes) {
    var moofs = mp4ParseBoxes(bytes).filter(function (b) { return b.type === 'moof'; });
    for (var i = 0; i < moofs.length; i++) {
      var tfdt = mp4FindBox(moofs[i], 'tfdt');
      if (tfdt && tfdt.baseMediaDecodeTime != null) return tfdt.baseMediaDecodeTime;
    }
    return null;
  }
  function mp4Sidx(bytes) {
    var sidx = mp4FindBox(mp4ParseBoxes(bytes), 'sidx');
    if (!sidx || sidx.references == null) return null;
    return { referenceId: sidx.referenceId, timescale: sidx.timescale, earliestPresentationTime: sidx.earliestPresentationTime, firstOffset: sidx.firstOffset, references: sidx.references };
  }

  return {
    mp4Box: mp4Box, mp4FullBox: mp4FullBox,
    mp4InitSegment: mp4InitSegment, mp4MediaSegment: mp4MediaSegment,
    mp4ParseBoxes: mp4ParseBoxes, mp4FindBox: mp4FindBox,
    mp4CodecsFromInit: mp4CodecsFromInit, mp4TracksFromInit: mp4TracksFromInit,
    mp4Tfdt: mp4Tfdt, mp4Sidx: mp4Sidx,
    aacConfigBytes: aacConfigBytes
  };
})();
