/* ===== TS: MPEG-TS demuxer — PAT/PMT, PES, H.264 access units → AVCC, AAC/MP3 frames, ID3 ===== */
var TS = (function () {
  'use strict';

  var TS_PACKET_SIZE = 188, TS_TIMESCALE = 90000;
  var PTS_WRAP = 8589934592;      // 2^33: PTS/DTS are 33-bit counters at 90 kHz; a jump beyond half of it is a lap
  var DEFAULT_FRAME_TICKS = 3000; // 30 fps; used only when no DTS delta is available yet
  var MAX_ERRORS = 100;           // junk input must not turn into a megabyte of error strings
  var MAX_PENDING_BYTES = 8 * 1024 * 1024; // an unbounded PES/NAL with no end in sight is a broken stream
  var MAX_SECTION_LENGTH = 1021;  // ISO 13818-1 §2.4.4.3

  // Stream types we care about (ISO 13818-1 table 2-34).
  var ST_MPEG1_AUDIO = 0x03, ST_MPEG2_AUDIO = 0x04, ST_PRIVATE_PES = 0x06, ST_AAC_ADTS = 0x0f, ST_ID3 = 0x15, ST_H264 = 0x1b;
  // PES stream_ids with no optional header (ISO 13818-1 §2.4.3.7).
  var NO_HEADER_STREAM_IDS = { 0xbc: 1, 0xbe: 1, 0xbf: 1, 0xf0: 1, 0xf1: 1, 0xf2: 1, 0xf8: 1, 0xff: 1 };
  // Non-VCL NAL types that open a new access unit when they follow a VCL NAL (H.264 §7.4.1.2.3).
  var AU_STARTERS = { 6: 1, 7: 1, 8: 1, 14: 1, 15: 1, 16: 1, 17: 1, 18: 1 };
  // Profiles whose SPS carries chroma_format_idc / bit depth / scaling lists (H.264 §7.3.2.1.1).
  var HIGH_PROFILES = { 100: 1, 110: 1, 122: 1, 244: 1, 44: 1, 83: 1, 86: 1, 118: 1, 128: 1, 138: 1, 139: 1, 134: 1, 135: 1 };
  // aspect_ratio_idc 1..16 (H.264 table E-1).
  var SAR_TABLE = [null, [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11], [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];
  var AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  var MPA_SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
  // kbps by [layer number][bitrate_index] (ISO 11172-3 / 13818-3 table B.1-ish; index 0 = free, 15 = invalid)
  var MPA_BITRATES_V1 = [
    null,
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // layer I
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],    // layer II
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]      // layer III
  ];
  var MPA_BITRATES_V2 = [
    null,
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],   // layer I
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],         // layer II
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]          // layer III
  ];

  /* ---------- bytes (cross-realm safe: no instanceof) ---------- */
  function toBytes(x) {
    if (isBytes(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (Object.prototype.toString.call(x) === '[object ArrayBuffer]') return new Uint8Array(x);
    if (Array.isArray(x)) return Uint8Array.from(x, function (b) { return b & 0xff; });
    return null;
  }
  function concat(parts) { return parts.length === 1 ? parts[0] : UTIL.concatBytes(parts); }
  function hex2(n) { return (n < 16 ? '0' : '') + (n & 0xff).toString(16); }

  function pushError(errors, type, message, pid) {
    if (errors.length > MAX_ERRORS) return;
    if (errors.length === MAX_ERRORS) { errors.push({ type: 'overflow', message: 'further errors suppressed' }); return; }
    var e = { type: type, message: message };
    if (pid != null) e.pid = pid;
    errors.push(e);
  }

  /* ---------- state ---------- */
  function newAu() { return { nals: [], pts: null, dts: null, hasVcl: false, idr: false, recovery: false }; }
  function tsCreateState() {
    return {
      v: 1,
      leftover: null,                      // partial TS packet from the previous call
      pmtPid: null, programNumber: null, pcrPid: null,
      videoPid: null, audioPid: null, audioKind: null, id3Pid: null,
      ignoredStreams: [],
      cc: {},                              // pid → last continuity counter
      psi: {},                             // pid → { buf } section being gathered
      pes: {},                             // pid → { chunks, size, declared } PES being gathered
      video: {
        sps: null, pps: null, width: null, height: null, codec: null,
        pending: null, pendingTiming: null, // unterminated NAL (with its start code) + the PES timing it began in
        au: newAu(), lastPts: null, lastDts: null, lastDuration: null, junkLogged: false
      },
      audio: {
        codec: null, sampleRate: null, channels: null, config: null, samplesPerFrame: null,
        remainder: null, remainderPts: null, // frame bytes that did not complete in the last PES
        lastPts: null
      }
    };
  }
  // Deep copy of the state shape: primitives, arrays, plain objects and byte arrays only.
  function cloneValue(v) {
    if (v === null || typeof v !== 'object') return v;
    if (isBytes(v)) return new Uint8Array(v);
    if (Array.isArray(v)) return v.map(cloneValue);
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = cloneValue(v[k]);
    return out;
  }
  // The caller's state is never mutated: work on a copy with every expected key present,
  // so a stale or hand-rolled state cannot crash the demuxer.
  function normalizeState(state) {
    var fresh = tsCreateState();
    if (!state || typeof state !== 'object') return fresh;
    var out = {}, k;
    for (k in fresh) if (Object.prototype.hasOwnProperty.call(fresh, k)) out[k] = (k in state) ? cloneValue(state[k]) : fresh[k];
    ['video', 'audio'].forEach(function (track) {
      if (!out[track] || typeof out[track] !== 'object') { out[track] = fresh[track]; return; }
      for (k in fresh[track]) if (!(k in out[track])) out[track][k] = fresh[track][k];
    });
    var v = out.video, a = out.audio;
    ['pmtPid', 'programNumber', 'pcrPid', 'videoPid', 'audioPid', 'id3Pid'].forEach(function (k2) { out[k2] = numOrNull(out[k2]); });
    if (out.audioKind !== 'aac' && out.audioKind !== 'mp3') { out.audioKind = null; out.audioPid = null; }
    var au = v.au && typeof v.au === 'object' ? v.au : {}, nals = Array.isArray(au.nals) ? au.nals.filter(isBytes) : [];
    v.au = { nals: nals, pts: numOrNull(au.pts), dts: numOrNull(au.dts), hasVcl: nals.length > 0 && au.hasVcl === true, idr: au.idr === true, recovery: au.recovery === true };
    if (v.au.pts === null) v.au.dts = null; else if (v.au.dts === null) v.au.dts = v.au.pts;
    ['lastPts', 'lastDts', 'lastDuration', 'width', 'height'].forEach(function (k2) { v[k2] = numOrNull(v[k2]); });
    v.sps = bytesOrNull(v.sps); v.pps = bytesOrNull(v.pps); v.pending = bytesOrNull(v.pending);
    if (!v.pending || !(v.pendingTiming && typeof v.pendingTiming === 'object')) v.pendingTiming = null;
    else v.pendingTiming = { pts: numOrNull(v.pendingTiming.pts), dts: numOrNull(v.pendingTiming.dts), used: v.pendingTiming.used === true };
    ['sampleRate', 'channels', 'samplesPerFrame', 'remainderPts', 'lastPts'].forEach(function (k2) { a[k2] = numOrNull(a[k2]); });
    a.remainder = bytesOrNull(a.remainder);
    if (!a.config || typeof a.config !== 'object') a.config = null;
    out.leftover = bytesOrNull(out.leftover);
    ['cc', 'psi', 'pes'].forEach(function (k2) { if (!out[k2] || typeof out[k2] !== 'object') out[k2] = {}; });
    for (k in out.cc) if (typeof out.cc[k] !== 'number') delete out.cc[k];
    for (k in out.psi) if (!(out.psi[k] && isBytes(out.psi[k].buf))) delete out.psi[k];
    for (k in out.pes) {
      var e = out.pes[k];
      if (!(e && Array.isArray(e.chunks) && e.chunks.every(isBytes) && typeof e.size === 'number')) delete out.pes[k];
    }
    if (!Array.isArray(out.ignoredStreams)) out.ignoredStreams = [];
    return out;
  }
  function isBytes(x) { return !!x && ArrayBuffer.isView(x); }
  function bytesOrNull(x) { return isBytes(x) ? x : null; }
  function numOrNull(x) { return typeof x === 'number' && isFinite(x) ? x : null; }

  /* ---------- timestamps ---------- */
  // 33-bit PTS/DTS wrap every ~26.5 h; bring `pts` onto the same lap as `ref`.
  function tsUnwrapPts(pts, ref) {
    if (typeof pts !== 'number' || !isFinite(pts)) return pts;
    if (typeof ref !== 'number' || !isFinite(ref)) return pts;
    var laps = Math.round((pts - ref) / PTS_WRAP);
    return laps === 0 ? pts : pts - laps * PTS_WRAP;
  }
  // 5-byte PTS/DTS field: 0010/0011 PTS[32..30] marker PTS[29..15] marker PTS[14..0] marker.
  function readTimestamp(b, o) {
    var hi = (b[o] & 0x0e) >> 1;
    var lo = ((b[o + 1] << 22) | ((b[o + 2] & 0xfe) << 14) | (b[o + 3] << 7) | (b[o + 4] >> 1)) >>> 0;
    return hi * 1073741824 + lo;
  }

  /* ---------- PSI: PAT / PMT ---------- */
  function sectionBounds(s, tableId) {
    if (!s || s.length < 12) return { error: 'section too short' };
    if (s[0] !== tableId) return { error: 'unexpected table_id 0x' + hex2(s[0]) };
    var sectionLength = ((s[1] & 0x0f) << 8) | s[2];
    var end = 3 + sectionLength - 4; // CRC_32 excluded
    if (sectionLength > MAX_SECTION_LENGTH || end > s.length || end < 8) return { error: 'bad section_length ' + sectionLength };
    return { end: end, version: (s[5] >> 1) & 0x1f, current: (s[5] & 1) === 1 };
  }
  // Program Association Table → the PMT pid of the first program (ISO 13818-1 §2.4.4.3).
  function parsePat(section) {
    var s = toBytes(section), b = sectionBounds(s, 0x00);
    if (b.error) return { ok: false, error: 'pat: ' + b.error };
    var programs = [], pmtPid = null;
    for (var i = 8; i + 4 <= b.end; i += 4) {
      var programNumber = (s[i] << 8) | s[i + 1], pid = ((s[i + 2] & 0x1f) << 8) | s[i + 3];
      if (programNumber === 0) continue; // network information pid, not a program
      programs.push({ programNumber: programNumber, pid: pid });
      if (pmtPid === null) pmtPid = pid;
    }
    if (pmtPid === null) return { ok: false, error: 'pat: no programs' };
    return { ok: true, transportStreamId: (s[3] << 8) | s[4], version: b.version, current: b.current, programs: programs, pmtPid: pmtPid };
  }
  // Program Map Table → elementary streams with their stream_type and registration (ISO 13818-1 §2.4.4.8).
  function parsePmt(section) {
    var s = toBytes(section), b = sectionBounds(s, 0x02);
    if (b.error) return { ok: false, error: 'pmt: ' + b.error };
    if (b.end < 12) return { ok: false, error: 'pmt: section too short' };
    var pcrPid = ((s[8] & 0x1f) << 8) | s[9];
    var programInfoLength = ((s[10] & 0x0f) << 8) | s[11];
    var streams = [], i = 12 + programInfoLength;
    while (i + 5 <= b.end) {
      var streamType = s[i], pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2], esInfoLength = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
      var descriptors = s.subarray(i + 5, Math.min(i + 5 + esInfoLength, b.end)), registration = null;
      for (var j = 0; j + 2 <= descriptors.length; j += 2 + descriptors[j + 1]) {
        if (descriptors[j] === 0x05 && descriptors[j + 1] >= 4 && j + 6 <= descriptors.length) {
          registration = String.fromCharCode(descriptors[j + 2], descriptors[j + 3], descriptors[j + 4], descriptors[j + 5]);
        }
      }
      streams.push({ streamType: streamType, pid: pid, registration: registration });
      i += 5 + esInfoLength;
    }
    return { ok: true, programNumber: (s[3] << 8) | s[4], version: b.version, current: b.current, pcrPid: pcrPid, streams: streams };
  }

  function applyPat(st, pat) {
    if (!pat.ok || !pat.current) return;
    if (pat.pmtPid !== st.pmtPid) { delete st.psi[st.pmtPid]; delete st.cc[st.pmtPid]; st.pmtPid = pat.pmtPid; }
  }
  function applyPmt(st, pmt, out) {
    if (!pmt.ok || !pmt.current) return;
    var videoPid = null, audioPid = null, audioKind = null, id3Pid = null, ignored = [];
    for (var i = 0; i < pmt.streams.length; i++) {
      var s = pmt.streams[i], isMpa = s.streamType === ST_MPEG1_AUDIO || s.streamType === ST_MPEG2_AUDIO;
      var isId3 = s.streamType === ST_ID3 || (s.streamType === ST_PRIVATE_PES && s.registration === 'ID3 ');
      if (s.streamType === ST_H264 && videoPid === null) videoPid = s.pid;
      else if (s.streamType === ST_AAC_ADTS && audioPid === null) { audioPid = s.pid; audioKind = 'aac'; }
      else if (isMpa && audioPid === null) { audioPid = s.pid; audioKind = 'mp3'; }
      else if (isId3 && id3Pid === null) id3Pid = s.pid;
      else ignored.push({ pid: s.pid, streamType: s.streamType });
    }
    st.programNumber = pmt.programNumber;
    st.pcrPid = pmt.pcrPid;
    st.ignoredStreams = ignored;
    // A changed mapping (new encoder, new PMT version) ends the old elementary streams: emit what they
    // still hold, then start the new pids clean.
    if (videoPid !== st.videoPid) {
      flushPendingPes(st, st.videoPid, 'video', out);
      flushVideo(st, out);
      st.videoPid = videoPid;
    }
    if (audioPid !== st.audioPid || audioKind !== st.audioKind) {
      flushPendingPes(st, st.audioPid, 'audio', out);
      dropAudioRemainder(st, out);
      st.audioPid = audioPid; st.audioKind = audioKind;
      st.audio = tsCreateState().audio;
      if (audioKind === 'mp3') st.audio.codec = 'mp3';
    }
    if (id3Pid !== st.id3Pid) { flushPendingPes(st, st.id3Pid, 'id3', out); st.id3Pid = id3Pid; }
  }
  function flushPendingPes(st, pid, kind, out) {
    if (pid === null || !st.pes[pid]) return;
    flushPes(st, pid, kind, st.pes[pid], out);
    delete st.pes[pid];
  }
  // End of the video stream (flush or pid change): the held-back NAL is complete, and so is the access unit.
  function flushVideo(st, out) {
    var v = st.video;
    if (v.pending) {
      var end = trimTrailingZeros(v.pending, 3, v.pending.length);
      if (end > 3) pushNal(st, v.pending.subarray(3, end), v.pendingTiming, out);
      v.pending = null; v.pendingTiming = null;
    }
    if (v.au.hasVcl) emitAu(st, null, out); else v.au = newAu();
  }

  // Sections may span packets and a payload may hold the tail of one section before the next.
  function handleSection(st, pid, kind, pusi, payload, out) {
    var entry = st.psi[pid];
    if (pusi) {
      var pointer = payload[0];
      if (1 + pointer > payload.length) { pushError(out.errors, 'psi', 'pointer_field beyond payload', pid); return; }
      if (entry && pointer > 0) { entry.buf = concat([entry.buf, payload.subarray(1, 1 + pointer)]); tryParseSection(st, pid, kind, out); }
      st.psi[pid] = { buf: payload.slice(1 + pointer) };
    } else {
      if (!entry) return; // continuation of a section whose start we never saw
      entry.buf = concat([entry.buf, payload]);
    }
    tryParseSection(st, pid, kind, out);
  }
  function tryParseSection(st, pid, kind, out) {
    var entry = st.psi[pid];
    if (!entry || entry.buf.length < 3) return;
    if (entry.buf[0] === 0xff) { delete st.psi[pid]; return; } // stuffing: no section here
    var sectionLength = ((entry.buf[1] & 0x0f) << 8) | entry.buf[2];
    if (sectionLength > MAX_SECTION_LENGTH) { delete st.psi[pid]; pushError(out.errors, 'psi', 'section_length ' + sectionLength + ' out of range', pid); return; }
    if (entry.buf.length < 3 + sectionLength) return; // wait for the rest
    var section = entry.buf.subarray(0, 3 + sectionLength);
    delete st.psi[pid];
    var parsed = kind === 'pat' ? parsePat(section) : parsePmt(section);
    if (!parsed.ok) { pushError(out.errors, 'psi', parsed.error, pid); return; }
    if (kind === 'pat') applyPat(st, parsed); else applyPmt(st, parsed, out);
  }

  /* ---------- PES ---------- */
  function parsePesHeader(data) {
    if (data.length < 6 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return { ok: false, error: 'pes: missing start code' };
    var streamId = data[3];
    if (NO_HEADER_STREAM_IDS[streamId] === 1) return { ok: true, streamId: streamId, pts: null, dts: null, payloadStart: 6 };
    if (data.length < 9) return { ok: false, error: 'pes: header truncated' };
    if ((data[6] & 0xc0) !== 0x80) return { ok: false, error: 'pes: bad header marker' };
    var flags = data[7], headerLength = data[8], payloadStart = 9 + headerLength;
    if (payloadStart > data.length) return { ok: false, error: 'pes: header_data_length beyond packet' };
    var pts = null, dts = null;
    if (flags & 0x80) {
      if (headerLength < 5) return { ok: false, error: 'pes: PTS flagged but absent' };
      pts = readTimestamp(data, 9);
      if (flags & 0x40) {
        if (headerLength < 10) return { ok: false, error: 'pes: DTS flagged but absent' };
        dts = readTimestamp(data, 14);
      }
    }
    return { ok: true, streamId: streamId, pts: pts, dts: dts, payloadStart: payloadStart };
  }

  function pidKind(st, pid) {
    if (pid === 0) return 'pat';
    if (pid === st.pmtPid) return 'pmt';
    if (pid === st.videoPid) return 'video';
    if (pid === st.audioPid) return 'audio';
    if (pid === st.id3Pid) return 'id3';
    return null;
  }

  function handlePesPacket(st, pid, kind, pusi, payload, out) {
    var pend = st.pes[pid];
    if (pusi) {
      // An unbounded PES (packet_length 0, the norm for video) only ends when the next one starts.
      if (pend) { flushPes(st, pid, kind, pend, out); delete st.pes[pid]; }
      pend = st.pes[pid] = { chunks: [payload.slice()], size: payload.length, declared: null };
    } else {
      if (!pend) return; // joined mid-PES: nothing to attach these bytes to
      pend.chunks.push(payload.slice());
      pend.size += payload.length;
    }
    if (pend.declared === null && pend.size >= 6) {
      if (pend.chunks[0].length < 6) pend.chunks = [concat(pend.chunks)];
      pend.declared = (pend.chunks[0][4] << 8) | pend.chunks[0][5];
    }
    var complete = pend.declared !== null && pend.declared > 0 && pend.size >= 6 + pend.declared;
    if (complete || pend.size > MAX_PENDING_BYTES) {
      if (!complete) pushError(out.errors, 'pes', 'unbounded PES exceeded ' + MAX_PENDING_BYTES + ' bytes; flushed', pid);
      flushPes(st, pid, kind, pend, out);
      delete st.pes[pid];
    }
  }

  function flushPes(st, pid, kind, pend, out) {
    var data = concat(pend.chunks), truncated = false;
    if (pend.declared !== null && pend.declared > 0) {
      var total = 6 + pend.declared;
      if (data.length < total) { truncated = true; pushError(out.errors, 'pes', 'truncated PES: expected ' + total + ' bytes, got ' + data.length, pid); }
      else if (data.length > total) { pushError(out.errors, 'pes', (data.length - total) + ' bytes beyond PES_packet_length ignored', pid); data = data.subarray(0, total); }
    }
    var hdr = parsePesHeader(data);
    if (!hdr.ok) { pushError(out.errors, 'pes', hdr.error, pid); return; }
    var payload = data.subarray(hdr.payloadStart);
    // Unwrap against the newest media timestamp so a 33-bit wrap inside a state stays monotonic.
    var ref = kind === 'video' ? st.video.lastPts : kind === 'audio' ? st.audio.lastPts
      : (st.video.lastPts !== null ? st.video.lastPts : st.audio.lastPts);
    var pts = hdr.pts === null ? null : tsUnwrapPts(hdr.pts, ref);
    var dts = hdr.dts === null ? pts : tsUnwrapPts(hdr.dts, pts);
    if (kind === 'video' && pts !== null) st.video.lastPts = pts;
    try {
      if (kind === 'video') processVideoPes(st, payload, { pts: pts, dts: dts, used: false }, out, truncated);
      else if (kind === 'audio') processAudioPes(st, payload, pts, out, truncated);
      else out.id3.push({ pts: pts, data: payload.slice() });
    } catch (e) {
      // A bug in one elementary-stream parser must not take the whole segment down with it.
      pushError(out.errors, 'internal', String(e && e.message ? e.message : e), pid);
    }
  }

  /* ---------- H.264 NAL helpers ---------- */
  function nalType(nal) {
    var b = toBytes(nal);
    return b && b.length ? b[0] & 0x1f : -1;
  }
  // Positions just after each 00 00 01 start code.
  function findStartCodes(data) {
    var starts = [], i = 0, n = data.length;
    while (i + 2 < n) {
      var c = data[i + 2];
      if (c > 1) { i += 3; continue; }                                   // no start code can end here
      if (c === 1 && data[i] === 0 && data[i + 1] === 0) { starts.push(i + 3); i += 3; continue; }
      i++;
    }
    return starts;
  }
  function trimTrailingZeros(data, start, end) {
    while (end > start && data[end - 1] === 0) end--; // zero_byte of a 4-byte start code / trailing_zero_8bits
    return end;
  }
  // Annex B byte stream → NAL units (views into the input, trailing zero bytes removed, AUD kept).
  function splitNalUnits(annexB) {
    var data = toBytes(annexB), out = [];
    if (!data) return out;
    var starts = findStartCodes(data);
    for (var i = 0; i < starts.length; i++) {
      var end = trimTrailingZeros(data, starts[i], i + 1 < starts.length ? starts[i + 1] - 3 : data.length);
      if (end > starts[i]) out.push(data.subarray(starts[i], end));
    }
    return out;
  }
  // NALs → AVCC sample data: 4-byte big-endian length before each NAL (what avcC lengthSizeMinusOne=3 promises).
  function toAvcc(nals) {
    var list = Array.isArray(nals) ? nals : [], total = 0, i, n;
    for (i = 0; i < list.length; i++) { n = toBytes(list[i]); if (n) total += 4 + n.length; }
    var out = new Uint8Array(total), o = 0;
    for (i = 0; i < list.length; i++) {
      n = toBytes(list[i]);
      if (!n) continue;
      UTIL.writeU32be(out, o, n.length);
      out.set(n, o + 4);
      o += 4 + n.length;
    }
    return out;
  }
  // Drop emulation_prevention_three_byte (00 00 03 → 00 00) so exp-golomb fields can be read.
  function unescapeRbsp(bytes) {
    var b = toBytes(bytes);
    if (!b) return new Uint8Array(0);
    var out = new Uint8Array(b.length), o = 0, zeros = 0;
    for (var i = 0; i < b.length; i++) {
      var c = b[i];
      if (zeros >= 2 && c === 3) { zeros = 0; continue; }
      out[o++] = c;
      zeros = c === 0 ? zeros + 1 : 0;
    }
    return out.slice(0, o);
  }

  // MSB-first bit reader with exp-golomb; reading past the end flags `bad` instead of throwing.
  function bitReader(bytes) {
    var pos = 0, end = bytes.length * 8, r = { bad: false };
    r.u = function (n) {
      if (pos + n > end) { r.bad = true; pos = end; return 0; }
      var v = 0;
      for (var i = 0; i < n; i++) { v = v * 2 + ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1); pos++; }
      return v;
    };
    r.ue = function () {
      var zeros = 0;
      while (!r.bad && zeros < 32 && r.u(1) === 0) zeros++;
      if (zeros >= 32) { r.bad = true; return 0; }
      return Math.pow(2, zeros) - 1 + r.u(zeros);
    };
    r.se = function () { var k = r.ue(); return (k & 1) ? (k + 1) / 2 : -(k / 2); };
    return r;
  }
  function skipScalingList(r, size) {
    var lastScale = 8, nextScale = 8;
    for (var j = 0; j < size && !r.bad; j++) {
      if (nextScale !== 0) nextScale = ((lastScale + r.se()) % 256 + 256) % 256;
      lastScale = nextScale === 0 ? lastScale : nextScale;
    }
  }
  // Sequence parameter set (NAL type 7, header byte included) → dimensions, codec string, SAR (H.264 §7.3.2.1.1, §E.1.1).
  function parseSps(sps) {
    var nal = toBytes(sps);
    if (!nal || nal.length < 4) return { ok: false, error: 'sps: too short' };
    var r = bitReader(unescapeRbsp(nal.subarray(1)));
    var profileIdc = r.u(8), constraintFlags = r.u(8), levelIdc = r.u(8);
    if (r.ue() > 31) return { ok: false, error: 'sps: bad seq_parameter_set_id' };
    var chromaFormatIdc = 1, separateColourPlane = 0, bitDepthLuma = 8, bitDepthChroma = 8;
    if (HIGH_PROFILES[profileIdc] === 1) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc > 3) return { ok: false, error: 'sps: bad chroma_format_idc' };
      if (chromaFormatIdc === 3) separateColourPlane = r.u(1);
      bitDepthLuma = r.ue() + 8;
      bitDepthChroma = r.ue() + 8;
      r.u(1); // qpprime_y_zero_transform_bypass_flag
      if (r.u(1)) { // seq_scaling_matrix_present_flag
        var lists = chromaFormatIdc !== 3 ? 8 : 12;
        for (var i = 0; i < lists && !r.bad; i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
    var log2MaxFrameNum = r.ue() + 4;
    if (log2MaxFrameNum > 16) return { ok: false, error: 'sps: bad log2_max_frame_num' };
    var picOrderCntType = r.ue();
    if (picOrderCntType === 0) {
      if (r.ue() + 4 > 16) return { ok: false, error: 'sps: bad log2_max_pic_order_cnt_lsb' };
    } else if (picOrderCntType === 1) {
      r.u(1); r.se(); r.se(); // delta_pic_order_always_zero_flag, offset_for_non_ref_pic, offset_for_top_to_bottom_field
      var cycle = r.ue();
      if (cycle > 255) return { ok: false, error: 'sps: bad num_ref_frames_in_pic_order_cnt_cycle' };
      for (var c = 0; c < cycle && !r.bad; c++) r.se();
    } else if (picOrderCntType > 2) return { ok: false, error: 'sps: bad pic_order_cnt_type' };
    var numRefFrames = r.ue();
    r.u(1); // gaps_in_frame_num_value_allowed_flag
    var widthMbs = r.ue() + 1, heightMapUnits = r.ue() + 1;
    var frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1); // mb_adaptive_frame_field_flag
    r.u(1); // direct_8x8_inference_flag
    var cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    if (r.u(1)) { cropLeft = r.ue(); cropRight = r.ue(); cropTop = r.ue(); cropBottom = r.ue(); }
    var sar = { n: 1, d: 1 };
    if (r.u(1) && r.u(1)) { // vui_parameters_present_flag, aspect_ratio_info_present_flag
      var idc = r.u(8);
      if (idc === 255) sar = { n: r.u(16), d: r.u(16) };
      else if (idc > 0 && idc <= 16) sar = { n: SAR_TABLE[idc][0], d: SAR_TABLE[idc][1] };
    }
    if (r.bad) return { ok: false, error: 'sps: truncated' };
    if (sar.n === 0 || sar.d === 0) sar = { n: 1, d: 1 };
    // Crop offsets count in chroma sample units; a field-coded stream crops two rows per unit (§7.4.2.1.1).
    var chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
    var subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1, subHeightC = chromaFormatIdc === 1 ? 2 : 1;
    var cropUnitX = chromaArrayType === 0 ? 1 : subWidthC;
    var cropUnitY = (chromaArrayType === 0 ? 1 : subHeightC) * (2 - frameMbsOnly);
    var width = widthMbs * 16 - cropUnitX * (cropLeft + cropRight);
    var height = (2 - frameMbsOnly) * heightMapUnits * 16 - cropUnitY * (cropTop + cropBottom);
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return { ok: false, error: 'sps: implausible dimensions' };
    return {
      ok: true, profileIdc: profileIdc, constraintFlags: constraintFlags, levelIdc: levelIdc,
      codec: 'avc1.' + hex2(profileIdc) + hex2(constraintFlags) + hex2(levelIdc),
      width: width, height: height, sar: sar,
      chromaFormatIdc: chromaFormatIdc, bitDepthLuma: bitDepthLuma, bitDepthChroma: bitDepthChroma,
      frameMbsOnly: frameMbsOnly === 1, log2MaxFrameNum: log2MaxFrameNum, picOrderCntType: picOrderCntType, numRefFrames: numRefFrames,
      crop: { left: cropLeft * cropUnitX, right: cropRight * cropUnitX, top: cropTop * cropUnitY, bottom: cropBottom * cropUnitY }
    };
  }
  // SEI (NAL type 6): does any payload carry a recovery point (type 6)? Such a frame is a safe decode start.
  function seiHasRecoveryPoint(nal) {
    var rbsp = unescapeRbsp(nal.subarray(1)), i = 0, n = rbsp.length;
    while (i + 1 < n) { // at least a type byte and a size byte left (the lone trailing 0x80 ends it)
      var type = 0, size = 0;
      while (i < n && rbsp[i] === 0xff) { type += 255; i++; }
      if (i >= n) break;
      type += rbsp[i++];
      while (i < n && rbsp[i] === 0xff) { size += 255; i++; }
      if (i >= n) break;
      size += rbsp[i++];
      if (type === 6) return true;
      i += size;
    }
    return false;
  }

  /* ---------- H.264 access-unit assembly ---------- */
  // A PES payload is one slice of a continuous Annex B stream: NALs may straddle PES packets, so the
  // trailing (unterminated) NAL is kept with the timing of the PES it began in.
  function processVideoPes(st, payload, timing, out, truncated) {
    var v = st.video, pendLen = v.pending ? v.pending.length : 0;
    var data = pendLen ? concat([v.pending, payload]) : payload;
    var starts = findStartCodes(data);
    if (!starts.length) {
      if (pendLen) {
        if (data.length > MAX_PENDING_BYTES) { pushError(out.errors, 'video', 'NAL exceeded ' + MAX_PENDING_BYTES + ' bytes without a start code; discarded'); v.pending = null; v.pendingTiming = null; return; }
        v.pending = data.slice();
      } else if (!v.junkLogged) { v.junkLogged = true; pushError(out.errors, 'video', data.length + ' bytes before the first start code ignored'); }
      return;
    }
    if (!pendLen && starts[0] > 3 && trimTrailingZeros(data, 0, starts[0] - 3) > 0 && !v.junkLogged) {
      v.junkLogged = true;
      pushError(out.errors, 'video', (starts[0] - 3) + ' bytes before the first start code ignored');
    }
    for (var i = 0; i + 1 < starts.length; i++) {
      var end = trimTrailingZeros(data, starts[i], starts[i + 1] - 3);
      if (end > starts[i]) pushNal(st, data.subarray(starts[i], end), starts[i] - 3 < pendLen ? v.pendingTiming : timing, out);
    }
    var last = starts[starts.length - 1];
    v.pendingTiming = last - 3 < pendLen ? v.pendingTiming : timing;
    v.pending = data.slice(last - 3);
    if (truncated) dropPendingNal(st, out);
  }
  // Bytes were lost at the end of a PES: whatever NAL was open there cannot be completed by the next PES.
  function dropPendingNal(st, out) {
    var v = st.video;
    if (!v.pending) return;
    pushError(out.errors, 'video', (v.pending.length - 3) + '-byte partial NAL after a truncated PES discarded', st.videoPid);
    v.pending = null; v.pendingTiming = null;
  }

  function pushNal(st, nal, timing, out) {
    var v = st.video, t = nal[0] & 0x1f;
    var isVcl = t === 1 || t === 5;
    // first_mb_in_slice is the first ue(v) of a slice header; ue(0) is the single bit '1'.
    var opensAu = t === 9 || (AU_STARTERS[t] === 1 && v.au.hasVcl) || (isVcl && v.au.hasVcl && nal.length > 1 && (nal[1] & 0x80) !== 0);
    if (opensAu && v.au.hasVcl) emitAu(st, timing, out);
    var au = v.au;
    // The PES timestamp belongs to the first access unit that starts in that PES — and only to it. Until the
    // AU has a picture, a later PES with its own timestamp wins (SPS/PPS carried over from a lost picture).
    if (!au.hasVcl && timing && timing.pts !== null && !timing.used) { au.pts = timing.pts; au.dts = timing.dts; timing.used = true; }
    if (t === 9) return; // AUD: a delimiter only, never part of the sample
    if (t === 7) recordSps(st, nal, out);
    else if (t === 8) { if (!v.pps || !UTIL.bytesEqual(v.pps, nal)) v.pps = nal.slice(); }
    else if (t === 6) { if (seiHasRecoveryPoint(nal)) au.recovery = true; }
    else if (t === 5) { au.idr = true; au.hasVcl = true; }
    else if (t === 1) au.hasVcl = true;
    au.nals.push(nal);
  }
  function recordSps(st, nal, out) {
    var v = st.video;
    if (v.sps && UTIL.bytesEqual(v.sps, nal)) return;
    v.sps = nal.slice();
    var info = parseSps(nal);
    if (!info.ok) { pushError(out.errors, 'video', info.error); return; }
    v.width = info.width; v.height = info.height; v.codec = info.codec;
  }
  // Close the access unit under construction. `nextTiming` is the PES timing of the AU that follows,
  // which gives the exact DTS delta; the final AU (flush) inherits the previous delta.
  function emitAu(st, nextTiming, out) {
    var v = st.video, au = v.au, pts = au.pts, dts = au.dts;
    if (pts === null) {
      dts = v.lastDts !== null ? v.lastDts + (v.lastDuration || DEFAULT_FRAME_TICKS) : 0;
      pts = dts;
      pushError(out.errors, 'video', 'access unit without PTS; timestamp extrapolated');
    }
    var nextDts = nextTiming && !nextTiming.used && nextTiming.dts !== null ? nextTiming.dts : null;
    var duration;
    if (nextDts !== null && nextDts > dts) duration = nextDts - dts;
    else {
      duration = v.lastDuration || DEFAULT_FRAME_TICKS;
      if (nextDts !== null) pushError(out.errors, 'video', 'DTS not increasing (' + dts + ' → ' + nextDts + '); duration estimated');
    }
    out.video.push({ pts: pts, dts: dts, cts: pts - dts, data: toAvcc(au.nals), key: au.idr || au.recovery, duration: duration });
    v.lastDts = dts;
    v.lastDuration = duration;
    v.au = newAu();
  }

  /* ---------- AAC ADTS / MPEG audio ---------- */
  // ADTS fixed+variable header (ISO 14496-3 §1.A.2.2).
  function parseAdts(bytes, offset) {
    var b = toBytes(bytes), o = offset | 0;
    if (!b || o < 0 || o + 7 > b.length) return { ok: false, error: 'adts: too short' };
    if (b[o] !== 0xff || (b[o + 1] & 0xf6) !== 0xf0) return { ok: false, error: 'adts: no sync' };
    var protectionAbsent = b[o + 1] & 1;
    var profile = (b[o + 2] >> 6) & 3, sampleRateIndex = (b[o + 2] >> 2) & 0x0f;
    var channels = ((b[o + 2] & 1) << 2) | ((b[o + 3] >> 6) & 3);
    var frameLength = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | ((b[o + 5] >> 5) & 7);
    var headerLength = protectionAbsent ? 7 : 9;
    if (sampleRateIndex > 12) return { ok: false, error: 'adts: reserved sampling_frequency_index' };
    if (frameLength < headerLength + 1) return { ok: false, error: 'adts: frame_length ' + frameLength + ' too small' };
    return {
      ok: true, frameLength: frameLength, headerLength: headerLength, objectType: profile + 1,
      sampleRateIndex: sampleRateIndex, sampleRate: AAC_SAMPLE_RATES[sampleRateIndex], channels: channels, crc: !protectionAbsent
    };
  }
  // MPEG-1/2/2.5 layer I/II/III frame header (ISO 11172-3 §2.4.1.3 / 13818-3).
  function parseMpegAudioHeader(bytes, offset) {
    var b = toBytes(bytes), o = offset | 0;
    if (!b || o < 0 || o + 4 > b.length) return { ok: false, error: 'mpa: too short' };
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return { ok: false, error: 'mpa: no sync' };
    var versionBits = (b[o + 1] >> 3) & 3, layerBits = (b[o + 1] >> 1) & 3;
    var bitrateIndex = (b[o + 2] >> 4) & 0x0f, sampleRateIndex = (b[o + 2] >> 2) & 3, padding = (b[o + 2] >> 1) & 1;
    var channelMode = (b[o + 3] >> 6) & 3;
    if (versionBits === 1 || layerBits === 0 || sampleRateIndex === 3) return { ok: false, error: 'mpa: reserved version/layer/sample rate' };
    if (bitrateIndex === 0 || bitrateIndex === 15) return { ok: false, error: 'mpa: free-format or invalid bitrate' };
    var version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5, layer = 4 - layerBits;
    var sampleRate = MPA_SAMPLE_RATES[version][sampleRateIndex];
    var bitrate = (version === 1 ? MPA_BITRATES_V1 : MPA_BITRATES_V2)[layer][bitrateIndex] * 1000;
    var samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
    var frameLength = layer === 1
      ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4
      : Math.floor(samplesPerFrame / 8 * bitrate / sampleRate) + padding;
    return {
      ok: true, frameLength: frameLength, sampleRate: sampleRate, channels: channelMode === 3 ? 1 : 2,
      samplesPerFrame: samplesPerFrame, bitrate: bitrate, version: version, layer: layer
    };
  }
  function parseAudioHeader(st, data, i) { return st.audioKind === 'aac' ? parseAdts(data, i) : parseMpegAudioHeader(data, i); }
  // Next plausible frame header at or after `from`; a sync pattern too close to the end to validate is kept as a remainder.
  function findAudioSync(st, data, from) {
    var aac = st.audioKind === 'aac', minHeader = aac ? 7 : 4;
    for (var j = from; j + 1 < data.length; j++) {
      if (data[j] !== 0xff) continue;
      if (aac ? (data[j + 1] & 0xf6) !== 0xf0 : (data[j + 1] & 0xe0) !== 0xe0) continue;
      if (j + minHeader > data.length || parseAudioHeader(st, data, j).ok) return j;
    }
    return -1;
  }
  function frameTicks(sampleRate, samplesPerFrame) { return samplesPerFrame * TS_TIMESCALE / sampleRate; }

  // A PES carries whole frames, usually several; the PES PTS is the first frame that starts in it and the
  // rest are spaced by the frame duration. A frame cut by the PES boundary completes in the next PES.
  function processAudioPes(st, payload, pesPts, out, truncated) {
    var a = st.audio, aac = st.audioKind === 'aac', remLen = a.remainder ? a.remainder.length : 0;
    var data = remLen ? concat([a.remainder, payload]) : payload, n = data.length;
    if (pesPts === null) {
      pesPts = a.lastPts !== null && a.sampleRate ? a.lastPts + Math.round(frameTicks(a.sampleRate, a.samplesPerFrame)) : (a.lastPts || 0);
      pushError(out.errors, 'audio', 'PES without PTS; timestamp extrapolated', st.audioPid);
    }
    var i = 0, inPes = 0, minHeader = aac ? 7 : 4;
    while (i < n) {
      if (n - i < minHeader) break; // header cut by the PES boundary → remainder
      var h = parseAudioHeader(st, data, i);
      if (!h.ok) {
        var j = findAudioSync(st, data, i + 1);
        if (j < 0) { pushError(out.errors, 'audio', (n - i) + ' bytes without a frame sync discarded', st.audioPid); i = n; break; }
        pushError(out.errors, 'audio', (j - i) + ' bytes skipped to resync', st.audioPid);
        i = j;
        continue;
      }
      if (i + h.frameLength > n) break; // frame body cut by the PES boundary → remainder
      var samplesPerFrame = aac ? 1024 : h.samplesPerFrame;
      var startedInRemainder = i < remLen;
      var pts = startedInRemainder ? a.remainderPts : pesPts + Math.round(inPes * frameTicks(h.sampleRate, samplesPerFrame));
      if (!startedInRemainder) inPes++;
      if (a.sampleRate !== h.sampleRate || a.channels !== h.channels || a.samplesPerFrame !== samplesPerFrame || (aac && (!a.config || a.config.objectType !== h.objectType))) {
        a.codec = aac ? 'mp4a.40.' + h.objectType : 'mp3';
        a.sampleRate = h.sampleRate; a.channels = h.channels; a.samplesPerFrame = samplesPerFrame;
        a.config = aac ? { objectType: h.objectType, sampleRateIndex: h.sampleRateIndex, channels: h.channels } : null;
      }
      var frame = aac ? data.slice(i + h.headerLength, i + h.frameLength) : data.slice(i, i + h.frameLength);
      // Every AAC/MP3 frame is a random access point. The muxer writes the sync flag from `key`, so a sample
      // without it would be written as non-sync (depends_on=1) — an audio track MSE cannot seek in.
      out.audio.push({ pts: pts, dts: pts, data: frame, duration: samplesPerFrame, key: true });
      a.lastPts = pts;
      i += h.frameLength;
    }
    if (i < n) {
      if (!(i < remLen)) a.remainderPts = a.sampleRate ? pesPts + Math.round(inPes * frameTicks(a.sampleRate, a.samplesPerFrame)) : pesPts;
      a.remainder = data.slice(i);
    } else { a.remainder = null; a.remainderPts = null; }
    if (truncated) dropAudioRemainder(st, out);
  }
  function dropAudioRemainder(st, out) {
    var a = st.audio;
    if (!a.remainder) return;
    pushError(out.errors, 'audio', a.remainder.length + '-byte partial frame discarded', st.audioPid);
    a.remainder = null; a.remainderPts = null;
  }

  /* ---------- transport packets ---------- */
  function findSync(bytes, from) {
    var len = bytes.length;
    for (var p = from; p < len; p++) {
      if (bytes[p] === 0x47 && (p + TS_PACKET_SIZE >= len || bytes[p + TS_PACKET_SIZE] === 0x47)) return p;
    }
    return -1;
  }

  function handlePacket(st, bytes, pos, out) {
    var b1 = bytes[pos + 1], b3 = bytes[pos + 3];
    var pid = ((b1 & 0x1f) << 8) | bytes[pos + 2], afc = (b3 >> 4) & 3, cc = b3 & 0x0f;
    if (pid === 0x1fff || afc === 0) return; // null packet / reserved
    var kind = pidKind(st, pid);
    if (!kind) return;
    if (b1 & 0x80) { pushError(out.errors, 'tei', 'transport_error_indicator set; packet dropped', pid); return; }
    if (b3 & 0xc0) { pushError(out.errors, 'scrambled', 'scrambled packet dropped (no key)', pid); return; }
    var payloadStart = 4, discontinuity = false;
    if (afc & 2) {
      var afLength = bytes[pos + 4];
      if (afLength > 183) { pushError(out.errors, 'adaptation', 'adaptation_field_length ' + afLength + ' out of range', pid); return; }
      if (afLength > 0) discontinuity = (bytes[pos + 5] & 0x80) !== 0;
      payloadStart = 5 + afLength;
    }
    if (!(afc & 1) || payloadStart >= TS_PACKET_SIZE) return; // adaptation field only: carries no payload and no cc step
    var last = st.cc[pid];
    if (last !== undefined && !discontinuity && cc !== ((last + 1) & 0x0f)) {
      pushError(out.errors, 'continuity', 'continuity counter gap: expected ' + ((last + 1) & 0x0f) + ', got ' + cc, pid);
    }
    st.cc[pid] = cc;
    var pusi = (b1 & 0x40) !== 0, payload = bytes.subarray(pos + payloadStart, pos + TS_PACKET_SIZE);
    if (kind === 'pat' || kind === 'pmt') handleSection(st, pid, kind, pusi, payload, out);
    else handlePesPacket(st, pid, kind, pusi, payload, out);
  }

  function compactPending(st) {
    for (var pid in st.pes) if (st.pes[pid].chunks.length > 1) st.pes[pid].chunks = [concat(st.pes[pid].chunks)];
  }
  function finish(st, out) {
    var v = st.video, a = st.audio;
    return {
      state: st,
      video: st.videoPid !== null ? { codec: v.codec, sps: v.sps, pps: v.pps, width: v.width, height: v.height, timescale: TS_TIMESCALE, samples: out.video } : null,
      audio: st.audioPid !== null ? { codec: a.codec, sampleRate: a.sampleRate, channels: a.channels, config: a.config, timescale: a.sampleRate, samples: out.audio } : null,
      id3: out.id3,
      errors: out.errors
    };
  }

  // Demux one chunk of transport stream. Chunks may be cut anywhere; `state` carries what did not
  // complete (partial packet, PES, NAL, audio frame) into the next call. The input state is not mutated.
  function tsDemux(input, state) {
    var st = normalizeState(state), out = { video: [], audio: [], id3: [], errors: [] };
    var bytes = toBytes(input);
    if (!bytes) { pushError(out.errors, 'input', 'expected a Uint8Array'); return finish(st, out); }
    if (st.leftover && st.leftover.length) { bytes = concat([st.leftover, bytes]); st.leftover = null; }
    var len = bytes.length, pos = 0;
    while (pos < len) {
      if (bytes[pos] !== 0x47) {
        var p = findSync(bytes, pos + 1);
        if (p < 0) { pushError(out.errors, 'sync', 'no sync byte in the remaining ' + (len - pos) + ' bytes; discarded'); break; }
        pushError(out.errors, 'sync', (p - pos) + ' bytes skipped to resync at offset ' + p);
        pos = p;
      }
      if (len - pos < TS_PACKET_SIZE) { st.leftover = bytes.slice(pos); break; }
      handlePacket(st, bytes, pos, out);
      pos += TS_PACKET_SIZE;
    }
    compactPending(st);
    return finish(st, out);
  }

  // End of stream (or before discarding a state): complete every pending PES, NAL and access unit.
  function tsFlush(state) {
    var st = normalizeState(state), out = { video: [], audio: [], id3: [], errors: [] };
    if (st.leftover && st.leftover.length) {
      pushError(out.errors, 'sync', st.leftover.length + '-byte partial packet discarded');
      st.leftover = null;
    }
    var pids = Object.keys(st.pes).map(Number).sort(function (x, y) { return x - y; });
    for (var i = 0; i < pids.length; i++) {
      var kind = pidKind(st, pids[i]);
      if (kind && kind !== 'pat' && kind !== 'pmt') flushPendingPes(st, pids[i], kind, out);
      else delete st.pes[pids[i]];
    }
    flushVideo(st, out);
    dropAudioRemainder(st, out);
    return finish(st, out);
  }

  return {
    TS_PACKET_SIZE: TS_PACKET_SIZE, TS_TIMESCALE: TS_TIMESCALE,
    tsCreateState: tsCreateState, tsDemux: tsDemux, tsFlush: tsFlush, tsUnwrapPts: tsUnwrapPts,
    splitNalUnits: splitNalUnits, nalType: nalType, toAvcc: toAvcc, unescapeRbsp: unescapeRbsp, parseSps: parseSps,
    parseAdts: parseAdts, parseMpegAudioHeader: parseMpegAudioHeader, parsePat: parsePat, parsePmt: parsePmt
  };
})();
