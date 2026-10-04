/* Beam — the pure protocol engine behind file transfer by QR code.
 * =====================================================================
 * Beam moves a file from one phone to another using only the screen and
 * the camera: the sender shows a fast loop of QR codes, the receiver's
 * camera reads them and reassembles the file. Everything that decides
 * WHAT goes into each code and HOW the receiver puts the pieces back
 * together lives here, as pure, deterministic functions with zero DOM,
 * zero I/O and zero clock:
 *
 *   - primitives: UTF-8, base45 (RFC 9285), CRC-32, FNV-1a, mulberry32
 *   - stream & manifest: [u16 manifestLen][manifest JSON][file bytes]
 *   - chunking: fixed-size, zero-padded chunks of the stream
 *   - fountain code: Luby Transform with a systematic prefix and a robust
 *     soliton degree distribution — both phones derive the same neighbour
 *     set for a frame from (K, seq) alone, so nothing has to be negotiated
 *   - frame codec: 23-char header + base45 payload, every char in the QR
 *     alphanumeric set, every frame of a transfer the same length
 *   - peeling decoder: strips known chunks from each incoming equation and
 *     propagates every resolution through the pending ones (work queue),
 *     plus an inactivation step — Gaussian elimination over GF(2) on the
 *     pending equations — so the last few chunks resolve as soon as the
 *     frames seen have full rank instead of waiting for a lucky degree-1 frame
 *   - planning, ETA and formatters (clock-injected: elapsed is passed in)
 *
 * engine.js does NOT depend on qr.js; the page passes the QR capacity in.
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner
 * (scripts/test-beam-logic.mjs). ES5 syntax + typed arrays only.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* constants                                                           */
  /* ------------------------------------------------------------------ */

  // The 45 QR alphanumeric characters, spec order — also the RFC 9285 base45 alphabet.
  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  var MAGIC = 'B1';
  var TID_LEN = 6;      // base45 of 4 bytes
  var K_WIDTH = 4;      // base36
  var SEQ_WIDTH = 5;    // base36
  var CRC_LEN = 6;      // base45 of 4 bytes
  var HEADER_LEN = MAGIC.length + TID_LEN + K_WIDTH + SEQ_WIDTH + CRC_LEN; // 23
  var K_MAX = Math.pow(36, K_WIDTH) - 1;     // 1,679,615
  var SEQ_MAX = Math.pow(36, SEQ_WIDTH) - 1; // 60,466,175

  var MAX_NAME = 180;
  var SOLITON_C = 0.1, SOLITON_DELTA = 0.5;
  var PENDING_CAP_FACTOR = 4; // pending equations are capped at 4×K (oldest dropped)
  var GE_MAX_UNKNOWN = 2048;  // joint elimination is attempted while this many chunks are still unknown
  // One elimination pass resolves at most this many chunks' data; the rest continue on the next
  // push, so a late joiner on a multi-MB file never freezes the receiver for seconds at once.
  var GE_COLUMNS_PER_PUSH = 64;

  var PRESETS = [
    { id: 's', label: 'Small', version: 10, ec: 'L', hint: 'any camera, slow' },
    { id: 'm', label: 'Medium', version: 15, ec: 'L', hint: 'good default' },
    { id: 'l', label: 'Large', version: 20, ec: 'L', hint: 'steady hands, modern phone' },
    { id: 'xl', label: 'XL', version: 25, ec: 'L', hint: 'bright screen, close up' },
    { id: 'max', label: 'Max', version: 30, ec: 'L', hint: 'tripod territory' }
  ];
  var DEFAULT_PRESET = 'l';
  var FPS_MIN = 2, FPS_MAX = 12, FPS_DEFAULT = 5;

  /* ------------------------------------------------------------------ */
  /* deterministic hashing / seeded randomness                           */
  /* ------------------------------------------------------------------ */

  // FNV-1a 32-bit — house convention; stable across platforms.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // mulberry32 — deterministic floats in [0,1). Integer maths via Math.imul and >>>0;
  // the final division by 2^32 is exact in IEEE doubles, so every platform agrees.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ */
  /* UTF-8 (hand-rolled: TextEncoder is not in every sandbox)            */
  /* ------------------------------------------------------------------ */

  function utf8Encode(str) {
    str = String(str == null ? '' : str);
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        else c = 0xfffd;
      } else if (c >= 0xd800 && c <= 0xdfff) {
        c = 0xfffd; // lone surrogate
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    var out = '', i = 0, n = bytes.length, c, need, cp, j, ok;
    while (i < n) {
      c = bytes[i];
      if (c < 0x80) { out += String.fromCharCode(c); i++; continue; }
      if (c >= 0xc2 && c <= 0xdf) { need = 1; cp = c & 0x1f; }
      else if (c >= 0xe0 && c <= 0xef) { need = 2; cp = c & 0x0f; }
      else if (c >= 0xf0 && c <= 0xf4) { need = 3; cp = c & 0x07; }
      else { out += '�'; i++; continue; }
      ok = i + need < n; // all continuation bytes present
      if (ok) {
        for (j = 1; j <= need; j++) {
          var b = bytes[i + j];
          if ((b & 0xc0) !== 0x80) { ok = false; break; }
          cp = (cp << 6) | (b & 63);
        }
      }
      if (!ok || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ||
          (need === 2 && cp < 0x800) || (need === 3 && cp < 0x10000)) {
        out += '�'; i++; continue;
      }
      if (cp >= 0x10000) {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else out += String.fromCharCode(cp);
      i += need + 1;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* base45 — RFC 9285                                                   */
  /* ------------------------------------------------------------------ */

  var B45_VAL = {};
  for (var bi = 0; bi < ALNUM.length; bi++) B45_VAL[ALNUM.charAt(bi)] = bi;

  // Two bytes → 16-bit n → three chars (least significant first); a trailing byte → two chars.
  function base45Encode(bytes) {
    var out = '', i, n, len = bytes.length;
    for (i = 0; i + 1 < len; i += 2) {
      n = bytes[i] * 256 + bytes[i + 1];
      out += ALNUM.charAt(n % 45) + ALNUM.charAt(Math.floor(n / 45) % 45) + ALNUM.charAt(Math.floor(n / 2025));
    }
    if (i < len) {
      n = bytes[i];
      out += ALNUM.charAt(n % 45) + ALNUM.charAt(Math.floor(n / 45));
    }
    return out;
  }

  function b45v(ch) {
    var v = B45_VAL[ch];
    if (v === undefined) throw new Error('base45: bad character "' + ch + '"');
    return v;
  }

  function base45Decode(str) {
    str = String(str == null ? '' : str);
    var len = str.length, rem = len % 3;
    if (rem === 1) throw new Error('base45: bad length ' + len);
    var out = new Uint8Array(Math.floor(len / 3) * 2 + (rem === 2 ? 1 : 0));
    var o = 0, i, n;
    for (i = 0; i + 2 < len; i += 3) {
      n = b45v(str.charAt(i)) + b45v(str.charAt(i + 1)) * 45 + b45v(str.charAt(i + 2)) * 2025;
      if (n > 65535) throw new Error('base45: triplet value out of range');
      out[o++] = n >> 8; out[o++] = n & 255;
    }
    if (rem === 2) {
      n = b45v(str.charAt(i)) + b45v(str.charAt(i + 1)) * 45;
      if (n > 255) throw new Error('base45: pair value out of range');
      out[o++] = n;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* CRC-32 (IEEE 802.3, table-driven)                                   */
  /* ------------------------------------------------------------------ */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256), c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF, i, n = bytes.length;
    for (i = 0; i < n; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function crc32Hex(bytes) {
    var h = crc32(bytes).toString(16);
    while (h.length < 8) h = '0' + h;
    return h;
  }

  function u32be(n) {
    n = n >>> 0;
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }

  // Both the transfer id and the per-frame payload check are "base45 of the 4 BE bytes of a CRC-32".
  function crcTag(bytes) { return base45Encode(u32be(crc32(bytes))); }

  /* ------------------------------------------------------------------ */
  /* base36 (UPPERCASE, fixed width)                                     */
  /* ------------------------------------------------------------------ */

  function toBase36(n, width) {
    if (typeof n !== 'number' || n < 0 || n !== Math.floor(n) || !isFinite(n)) throw new Error('toBase36: bad number');
    var s = n.toString(36).toUpperCase();
    if (width) {
      if (s.length > width) throw new Error('toBase36: ' + n + ' does not fit width ' + width);
      while (s.length < width) s = '0' + s;
    }
    return s;
  }

  function fromBase36(s) {
    s = String(s);
    if (!/^[0-9A-Z]+$/.test(s)) throw new Error('fromBase36: bad digits');
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      n = n * 36 + (c < 65 ? c - 48 : c - 55);
    }
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* stream & manifest                                                   */
  /* ------------------------------------------------------------------ */

  function safeFileName(name) {
    var s = String(name == null ? '' : name);
    // strip path separators, C0/C1 control characters and the invisible Unicode direction/format
    // controls (ALM, LRM/RLM, bidi embeddings/overrides/isolates, BOM) — a name is attacker-controlled
    // across the air gap and an RLO would render "invoice\u202egnp.exe" as "invoiceexe.png";
    // then collapse whitespace and trim
    s = s.replace(/[\\\/\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
    if (s.length > MAX_NAME) {
      s = s.slice(0, MAX_NAME);
      var last = s.charCodeAt(s.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1); // never leave a dangling high surrogate
      s = s.replace(/[\s.]+$/g, '');
    }
    return s || 'beam-file';
  }

  function isHex8(s) { return typeof s === 'string' && /^[0-9a-f]{8}$/.test(s); }

  function buildStream(fileBytes, meta) {
    meta = meta || {};
    if (!fileBytes || typeof fileBytes.length !== 'number') throw new Error('buildStream: fileBytes required');
    var compressed = !!meta.compressed;
    var h;
    if (meta.originalCrcHex != null) {
      if (!isHex8(meta.originalCrcHex)) throw new Error('buildStream: originalCrcHex must be 8 lowercase hex chars');
      h = meta.originalCrcHex;
    } else if (compressed) {
      throw new Error('buildStream: compressed streams need originalCrcHex (CRC of the uncompressed bytes)');
    } else {
      h = crc32Hex(fileBytes);
    }
    var originalSize = (typeof meta.originalSize === 'number' && meta.originalSize >= 0) ? Math.floor(meta.originalSize) : fileBytes.length;
    var manifest = {
      v: 1,
      n: safeFileName(meta.name),
      t: String(meta.type == null ? '' : meta.type).slice(0, 255),
      s: originalSize,
      b: fileBytes.length,
      z: compressed ? 1 : 0,
      h: h
    };
    var mbytes = utf8Encode(JSON.stringify(manifest));
    if (mbytes.length > 65535) throw new Error('buildStream: manifest too large');
    var stream = new Uint8Array(2 + mbytes.length + fileBytes.length);
    stream[0] = mbytes.length >> 8; stream[1] = mbytes.length & 255;
    stream.set(mbytes, 2);
    stream.set(fileBytes, 2 + mbytes.length);
    return { stream: stream, manifest: manifest, tid: crcTag(stream) };
  }

  // Reads and validates the manifest at the head of a stream (or a prefix of one).
  // Returns { manifest, manifestLen, dataStart } or throws a human message.
  function readManifest(stream) {
    if (!stream || stream.length < 2) throw new Error('Stream too short for a manifest length');
    var ml = (stream[0] << 8) | stream[1];
    if (ml === 0) throw new Error('Empty manifest');
    if (2 + ml > stream.length) throw new Error('Manifest is cut off');
    var manifest;
    try { manifest = JSON.parse(utf8Decode(stream.subarray(2, 2 + ml))); }
    catch (e) { throw new Error('Manifest is not valid JSON'); }
    if (!manifest || typeof manifest !== 'object' || manifest.v !== 1) throw new Error('Unknown manifest version');
    if (typeof manifest.b !== 'number' || manifest.b < 0 || manifest.b !== Math.floor(manifest.b)) throw new Error('Manifest has a bad byte length');
    manifest.n = safeFileName(manifest.n);
    manifest.t = String(manifest.t == null ? '' : manifest.t);
    manifest.s = (typeof manifest.s === 'number' && manifest.s >= 0) ? manifest.s : manifest.b;
    manifest.z = manifest.z ? 1 : 0;
    manifest.h = isHex8(manifest.h) ? manifest.h : '';
    return { manifest: manifest, manifestLen: ml, dataStart: 2 + ml };
  }

  function parseStream(stream, expectedLen) {
    var m = readManifest(stream);
    var total = m.dataStart + m.manifest.b;
    if (total > stream.length) throw new Error('File bytes are cut off (manifest says ' + m.manifest.b + ' bytes)');
    if (expectedLen != null && expectedLen !== total) throw new Error('Stream length mismatch');
    return { manifest: m.manifest, fileBytes: stream.slice(m.dataStart, total) };
  }

  function streamLength(stream) {
    var m = readManifest(stream);
    return m.dataStart + m.manifest.b;
  }

  /* ------------------------------------------------------------------ */
  /* chunking & capacity                                                 */
  /* ------------------------------------------------------------------ */

  function chunkBytesFor(alnumChars) {
    var n = Math.floor((alnumChars - HEADER_LEN) / 3) * 2;
    if (!(n >= 2)) throw new Error('QR capacity too small for a Beam frame');
    return n;
  }

  function chunkCount(streamLen, chunkBytes) {
    return Math.max(1, Math.ceil(streamLen / chunkBytes));
  }

  function chunkAt(stream, i, chunkBytes) {
    var out = new Uint8Array(chunkBytes);
    var start = i * chunkBytes;
    if (start < stream.length) out.set(stream.subarray(start, Math.min(stream.length, start + chunkBytes)), 0);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* fountain code — Luby Transform, systematic prefix, robust soliton   */
  /* ------------------------------------------------------------------ */

  // Natural log with a fixed-length series: +,-,*,/ are correctly rounded everywhere,
  // Math.log is only "implementation-approximated" — and both phones MUST build the
  // same table. x = m·2^e with m∈[1,2); ln(m) = 2·atanh((m-1)/(m+1)), |y| ≤ 1/3.
  var LN2 = 0.6931471805599453;
  function ln(x) {
    var e = 0;
    while (x >= 2) { x /= 2; e++; }
    while (x < 1) { x *= 2; e--; }
    var y = (x - 1) / (x + 1), y2 = y * y, term = y, sum = 0;
    for (var k = 0; k < 40; k++) { sum += term / (2 * k + 1); term *= y2; }
    return 2 * sum + e * LN2;
  }

  // Single-entry memo: each side only ever works on one K at a time, and a per-K map would let a
  // hostile screen (parseFrame accepts any K ≤ 1,679,615 — the header is outside the payload CRC)
  // pin a ~13 MB table per distinct K forever and crash the receiver tab.
  var solitonCacheK = -1, solitonCacheTable = null;

  // Unnormalised robust soliton mass for degree d (ideal soliton ρ + the τ spike term).
  function solitonMass(d, K, R, spike, spikeTau) {
    var rho = d === 1 ? 1 / K : 1 / (d * (d - 1));
    if (d < spike) return rho + R / (d * K);
    if (d === spike) return rho + spikeTau;
    return rho;
  }

  // Cumulative robust soliton distribution for K chunks: cum[d] = P(degree ≤ d), cum[0] = 0, cum[K] = 1.
  function solitonTable(K) {
    if (K === solitonCacheK && solitonCacheTable) return solitonCacheTable;
    var cum = new Array(K + 1), d;
    if (K <= 1) {
      cum[0] = 0; cum[1] = 1;
    } else {
      var R = SOLITON_C * ln(K / SOLITON_DELTA) * Math.sqrt(K);
      var spike = Math.floor(K / R);
      var spikeTau = Math.max(0, R * ln(R / SOLITON_DELTA) / K);
      // Two passes (normaliser, then cumulative) in the same d order — the same operations in the
      // same order on both phones, and no second K-length array.
      var beta = 0;
      for (d = 1; d <= K; d++) beta += solitonMass(d, K, R, spike, spikeTau);
      var acc = 0;
      cum[0] = 0;
      for (d = 1; d <= K; d++) { acc += solitonMass(d, K, R, spike, spikeTau) / beta; cum[d] = acc; }
      cum[K] = 1; // absorb rounding so a draw in [0,1) always lands
    }
    solitonCacheK = K; solitonCacheTable = cum;
    return cum;
  }

  function sampleDegree(r, K) {
    var cum = solitonTable(K), u = r(), lo = 1, hi = K;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] > u) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  // Floyd's algorithm: d distinct integers in [0, n), uniform over subsets, O(d), deterministic.
  function sampleDistinct(r, n, d) {
    var set = {}, out = [];
    for (var j = n - d; j < n; j++) {
      var t = Math.floor(r() * (j + 1));
      if (set[t] === 1) { set[j] = 1; out.push(j); }
      else { set[t] = 1; out.push(t); }
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function frameNeighbors(seq, K) {
    if (seq < K) return [seq];
    var r = rng(hashStr('beam:' + K + ':' + seq));
    var d = K === 1 ? 1 : sampleDegree(r, K);
    return sampleDistinct(r, K, d);
  }

  function framePayload(stream, seq, K, chunkBytes) {
    var idx = frameNeighbors(seq, K);
    var out = chunkAt(stream, idx[0], chunkBytes);
    for (var j = 1; j < idx.length; j++) {
      var start = idx[j] * chunkBytes, end = Math.min(stream.length, start + chunkBytes);
      for (var p = start, q = 0; p < end; p++, q++) out[q] ^= stream[p];
    }
    return out;
  }

  function makeContext(stream, chunkBytes) {
    if (!stream || typeof stream.length !== 'number') throw new Error('makeContext: stream required');
    if (typeof chunkBytes !== 'number' || chunkBytes < 2 || chunkBytes % 2 !== 0) throw new Error('makeContext: chunkBytes must be an even integer ≥ 2');
    var K = chunkCount(stream.length, chunkBytes);
    if (K > K_MAX) throw new Error('makeContext: too many chunks (' + K + ')');
    return { stream: stream, tid: crcTag(stream), K: K, chunkBytes: chunkBytes };
  }

  /* ------------------------------------------------------------------ */
  /* frame codec                                                         */
  /* ------------------------------------------------------------------ */

  function encodeFrame(ctx, seq) {
    if (seq < 0 || seq > SEQ_MAX || seq !== Math.floor(seq)) throw new Error('encodeFrame: seq out of range');
    var payload = framePayload(ctx.stream, seq, ctx.K, ctx.chunkBytes);
    return MAGIC + ctx.tid + toBase36(ctx.K, K_WIDTH) + toBase36(seq, SEQ_WIDTH) + crcTag(payload) + base45Encode(payload);
  }

  var ALNUM_RE = /^[0-9A-Z $%*+\-.\/:]+$/;

  // Returns { tid, K, seq, payload } or null. Never throws — the camera hands us garbage.
  function parseFrame(text) {
    try {
      if (typeof text !== 'string') return null;
      if (text.length < HEADER_LEN + 3 || (text.length - HEADER_LEN) % 3 !== 0) return null;
      if (!ALNUM_RE.test(text)) return null;
      if (text.slice(0, 2) !== MAGIC) return null;
      var tid = text.slice(2, 8);
      if (base45Decode(tid).length !== 4) return null;
      var K = fromBase36(text.slice(8, 12));
      if (K === 0) return null;
      var seq = fromBase36(text.slice(12, 17));
      if (seq > SEQ_MAX) return null;
      var crcText = text.slice(17, 23);
      var payload = base45Decode(text.slice(23));
      if (payload.length < 2 || payload.length % 2 !== 0) return null;
      if (crcTag(payload) !== crcText) return null;
      return { tid: tid, K: K, seq: seq, payload: payload };
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* decoder — peeling / belief propagation                              */
  /* ------------------------------------------------------------------ */

  function createDecoder(opts) {
    opts = opts || {};
    return {
      elimination: !(opts.elimination === false),   // tests compare peeling alone vs. peeling + elimination
      pendingCapFactor: (typeof opts.pendingCapFactor === 'number' && opts.pendingCapFactor > 0) ? opts.pendingCapFactor : PENDING_CAP_FACTOR,
      solveColumns: (typeof opts.solveColumns === 'number' && opts.solveColumns >= 1) ? opts.solveColumns : GE_COLUMNS_PER_PUSH,
      nextSolveAt: 0,    // unique-frame count at which the next elimination attempt is allowed
      solveMore: false,  // the last elimination pass hit solveColumns and left resolvable chunks for the next push
      evicted: 0,        // pending equations dropped by the memory cap
      replan: null,      // candidate { K, chunkBytes, seq } seen with our tid but another plan (see decoderPush)
      tid: null, K: 0, chunkBytes: 0,
      chunks: [],        // Uint8Array per resolved chunk, undefined otherwise
      have: 0,
      seen: {},          // seq → 1
      framesSeen: 0, unique: 0, redundant: 0,
      pending: [],       // live equations { idx: [unknown chunk indices], data: Uint8Array, dead: bool }
      byChunk: {},       // chunk index → [equations that still mention it]
      complete: false,
      manifest: null     // cached by peekManifest
    };
  }

  function resetDecoder(dec, tid, K, chunkBytes) {
    dec.tid = tid; dec.K = K; dec.chunkBytes = chunkBytes;
    dec.chunks = new Array(K);
    dec.have = 0;
    dec.seen = {};
    dec.framesSeen = 0; dec.unique = 0; dec.redundant = 0;
    dec.pending = []; dec.byChunk = {};
    dec.nextSolveAt = 0; dec.solveMore = false;
    dec.evicted = 0;
    dec.replan = null;
    dec.complete = false;
    dec.manifest = null;
  }

  // target ^= src, a word at a time when both views are 4-byte aligned (chunk buffers always are;
  // chunkBytes is only guaranteed even, so the tail is done bytewise).
  function xorInto(target, src) {
    var n = target.length, i = 0;
    if (n >= 32 && (target.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0 && src.length >= n) {
      var words = n >>> 2;
      var t32 = new Uint32Array(target.buffer, target.byteOffset, words);
      var s32 = new Uint32Array(src.buffer, src.byteOffset, words);
      for (var w = 0; w < words; w++) t32[w] ^= s32[w];
      i = words << 2;
    }
    for (; i < n; i++) target[i] ^= src[i];
  }

  function resolveChunk(dec, i, data, resolved, queue) {
    dec.chunks[i] = data;
    dec.have++;
    resolved.push(i);
    queue.push(i);
  }

  // Strip known chunks, then resolve or park. Returns { resolved: [chunk indices], redundant: bool }.
  function absorb(dec, idx, payload) {
    var data = new Uint8Array(dec.chunkBytes);
    data.set(payload);
    var unknown = [], j, i;
    for (j = 0; j < idx.length; j++) {
      i = idx[j];
      if (dec.chunks[i]) xorInto(data, dec.chunks[i]); else unknown.push(i);
    }
    var resolved = [], queue = [];
    if (unknown.length === 0) return { resolved: resolved, redundant: true };
    if (unknown.length === 1) {
      resolveChunk(dec, unknown[0], data, resolved, queue);
    } else {
      var eq = { idx: unknown, data: data, dead: false };
      dec.pending.push(eq);
      for (j = 0; j < unknown.length; j++) {
        (dec.byChunk[unknown[j]] || (dec.byChunk[unknown[j]] = [])).push(eq);
      }
      // Memory bound: never hold more than pendingCapFactor×K (default PENDING_CAP_FACTOR×K)
      // equations — drop the oldest. Dead equations are skipped wherever byChunk still lists them.
      var cap = Math.max(1, Math.ceil(dec.pendingCapFactor * dec.K));
      while (dec.pending.length > cap) { dec.pending.shift().dead = true; dec.evicted++; }
      return { resolved: resolved, redundant: false };
    }
    propagate(dec, queue, resolved);
    return { resolved: resolved, redundant: false };
  }

  function compactPending(dec) {
    var live = [];
    for (var j = 0; j < dec.pending.length; j++) if (!dec.pending[j].dead) live.push(dec.pending[j]);
    dec.pending = live;
  }

  // Work queue: every resolution may collapse pending equations to degree 1, which resolves
  // more chunks, which collapses more equations…
  function propagate(dec, queue, resolved) {
    var died = false, j;
    while (queue.length) {
      var c = queue.pop();
      var list = dec.byChunk[c];
      if (!list) continue;
      delete dec.byChunk[c];
      for (j = 0; j < list.length; j++) {
        var e = list[j];
        if (e.dead) continue;
        var pos = e.idx.indexOf(c);
        if (pos < 0) continue;
        e.idx.splice(pos, 1);
        xorInto(e.data, dec.chunks[c]);
        if (e.idx.length === 1) {
          var r = e.idx[0];
          e.dead = true; died = true;
          if (!dec.chunks[r]) resolveChunk(dec, r, e.data, resolved, queue);
        } else if (e.idx.length === 0) {
          e.dead = true; died = true;
        }
      }
    }
    if (died) compactPending(dec);
  }

  function popcount(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }

  // Inactivation step. Peeling alone only advances when an equation shrinks to ONE unknown — that
  // wait is the "stuck at 70 %" tail a receiver sees near the end. Once there are at least as many
  // pending equations as unknown chunks they usually already pin every chunk down jointly, so solve
  // them over GF(2): reduced row echelon on a bit matrix (cheap), tracking which original rows make
  // up each reduced row, then XOR chunk data only for the columns that actually resolve.
  // The data XOR is the expensive half (every resolved column combines ~P/2 chunk-sized rows once the
  // matrix is dense), so at most maxColumns (default: unlimited) are materialised per call; when some
  // are left over the result carries `truncated: true` and the caller runs again on the next push.
  // Returns [{ chunk, data }] — the caller feeds them through the normal resolve/propagate path.
  function solvePending(dec, maxColumns) {
    var U = dec.K - dec.have;
    if (U <= 0 || U > GE_MAX_UNKNOWN) return [];
    if (!(typeof maxColumns === 'number' && maxColumns >= 1)) maxColumns = Infinity;
    var eqs = [], i, j, r;
    for (i = 0; i < dec.pending.length; i++) if (!dec.pending[i].dead) eqs.push(dec.pending[i]);
    var P = eqs.length;
    if (P < U) return [];
    var col = {}, cols = [];
    for (i = 0; i < dec.K; i++) if (!dec.chunks[i]) { col[i] = cols.length; cols.push(i); }
    var W = (U + 31) >>> 5, WP = (P + 31) >>> 5;
    var bits = new Array(P), comb = new Array(P), pivot = new Int32Array(P);
    for (r = 0; r < P; r++) {
      var b = new Uint32Array(W), cmb = new Uint32Array(WP), idx = eqs[r].idx;
      for (j = 0; j < idx.length; j++) { var cc = col[idx[j]]; b[cc >>> 5] |= (1 << (cc & 31)); }
      cmb[r >>> 5] |= (1 << (r & 31));
      bits[r] = b; comb[r] = cmb; pivot[r] = -1;
    }
    var pivots = [];
    for (var c = 0; c < U; c++) {
      var w = c >>> 5, m = 1 << (c & 31), p = -1;
      for (r = 0; r < P; r++) if (pivot[r] < 0 && (bits[r][w] & m)) { p = r; break; }
      if (p < 0) continue;
      pivot[p] = c; pivots.push(p);
      var pb = bits[p], pc = comb[p], k;
      for (r = 0; r < P; r++) {
        if (r === p || !(bits[r][w] & m)) continue;
        var rb = bits[r], rc = comb[r];
        for (k = 0; k < W; k++) rb[k] ^= pb[k];
        for (k = 0; k < WP; k++) rc[k] ^= pc[k];
      }
    }
    var out = [];
    for (i = 0; i < pivots.length; i++) {
      var row = pivots[i], ones = 0, k2;
      for (k2 = 0; k2 < W; k2++) ones += popcount(bits[row][k2]);
      if (ones !== 1) continue;                     // still entangled with a column no equation pins down
      if (out.length >= maxColumns) { out.truncated = true; break; }
      var data = new Uint8Array(dec.chunkBytes), rc2 = comb[row];
      for (r = 0; r < P; r++) if (rc2[r >>> 5] & (1 << (r & 31))) xorInto(data, eqs[r].data);
      out.push({ chunk: cols[pivot[row]], data: data });
    }
    return out;
  }

  // Try elimination when it can pay off; throttled so a big transfer does not re-run it every frame.
  // A pass that hit the per-push column budget leaves solveMore set and may run again on the very
  // next push (the frames in between still count: everything they resolve shrinks the next system).
  function maybeEliminate(dec, resolved) {
    if (!dec.elimination || dec.have >= dec.K) return;
    var U = dec.K - dec.have;
    if (U > GE_MAX_UNKNOWN || dec.pending.length < U || dec.unique < dec.nextSolveAt) return;
    dec.nextSolveAt = dec.unique + Math.max(1, U >>> 4);
    var sol = solvePending(dec, dec.solveColumns);
    dec.solveMore = !!sol.truncated;
    if (dec.solveMore) dec.nextSolveAt = dec.unique;
    if (!sol.length) return;
    var queue = [];
    for (var i = 0; i < sol.length; i++) if (!dec.chunks[sol[i].chunk]) resolveChunk(dec, sol[i].chunk, sol[i].data, resolved, queue);
    propagate(dec, queue, resolved);
  }

  function decoderPush(dec, frame) {
    if (!frame || typeof frame.tid !== 'string' || !frame.payload) return { type: 'bad', reason: 'not a frame' };
    var started = false, switched = false;
    if (dec.tid === null) {
      resetDecoder(dec, frame.tid, frame.K, frame.payload.length);
      started = true;
    } else if (frame.tid !== dec.tid) {
      resetDecoder(dec, frame.tid, frame.K, frame.payload.length);
      switched = true;
    } else if (frame.K !== dec.K || frame.payload.length !== dec.chunkBytes) {
      // Same file, different plan: tid is CRC-32(stream) and ignores chunkBytes, so when the sender
      // stops and restarts at another density the tid stays while K and the frame size change.
      // Treat that as a re-plan — reset and report 'switch' like a new tid — rather than rejecting
      // every frame forever. The header is outside the payload CRC, so one frame is not proof: two
      // frames with distinct seq that agree on the new (K, chunkBytes) are; the first is 'bad'.
      dec.framesSeen++;
      var rp = dec.replan;
      if (rp && rp.K === frame.K && rp.chunkBytes === frame.payload.length && rp.seq !== frame.seq) {
        resetDecoder(dec, frame.tid, frame.K, frame.payload.length);
        switched = true;
      } else {
        dec.replan = { K: frame.K, chunkBytes: frame.payload.length, seq: frame.seq };
        return {
          type: 'bad', replan: true,
          reason: frame.K !== dec.K ? 'K changed within transfer (' + frame.K + ' vs ' + dec.K + ')' : 'frame size changed within transfer'
        };
      }
    }
    dec.framesSeen++;
    dec.replan = null; // a frame consistent with the current plan clears a lone mismatch
    if (dec.complete) return { type: 'done' };
    if (dec.seen[frame.seq] === 1) return { type: 'dup' };
    if (frame.seq < 0 || frame.seq > SEQ_MAX || frame.seq !== Math.floor(frame.seq)) return { type: 'bad', reason: 'seq out of range' };
    dec.seen[frame.seq] = 1;
    dec.unique++;
    var idx = frameNeighbors(frame.seq, dec.K);
    var res = absorb(dec, idx, frame.payload);
    if (res.redundant) dec.redundant++;
    if (!res.redundant || dec.solveMore) maybeEliminate(dec, res.resolved);
    var ev;
    if (dec.have >= dec.K) {
      dec.complete = true;
      ev = { type: 'complete', have: dec.K, K: dec.K, resolved: res.resolved };
      // A first (or switching) frame that completes the set — K===1 — reports completion
      // rather than start/switch; it carries tid so the UI still learns the transfer.
      if (started || switched) { ev.tid = dec.tid; ev.started = started; ev.switched = switched; }
    } else if (started) {
      ev = { type: 'start', tid: dec.tid, K: dec.K, have: dec.have, resolved: res.resolved };
    } else if (switched) {
      ev = { type: 'switch', tid: dec.tid, K: dec.K, have: dec.have, resolved: res.resolved };
    } else if (res.redundant) {
      ev = { type: 'redundant' };
    } else {
      ev = { type: 'progress', have: dec.have, K: dec.K, resolved: res.resolved, pending: dec.pending.length };
    }
    return ev;
  }

  function decoderProgress(dec) {
    var K = dec.K || 0;
    return {
      tid: dec.tid, K: K, have: dec.have,
      pct: K ? Math.round(dec.have / K * 1000) / 10 : 0,
      framesSeen: dec.framesSeen, unique: dec.unique, redundant: dec.redundant,
      pending: dec.pending.length, complete: dec.complete
    };
  }

  function decoderHas(dec) {
    var out = new Uint8Array(dec.K || 0);
    for (var i = 0; i < out.length; i++) out[i] = dec.chunks[i] ? 1 : 0;
    return out;
  }

  function decoderResult(dec) {
    if (!dec.complete) throw new Error('transfer not complete');
    var full = new Uint8Array(dec.K * dec.chunkBytes);
    for (var i = 0; i < dec.K; i++) full.set(dec.chunks[i], i * dec.chunkBytes);
    var len;
    try { len = streamLength(full); } catch (e) { throw new Error('corrupt transfer'); }
    if (len > full.length) throw new Error('corrupt transfer');
    var stream = full.slice(0, len);
    if (crcTag(stream) !== dec.tid) throw new Error('corrupt transfer');
    var parsed = parseStream(stream, len);
    return { stream: stream, manifest: parsed.manifest, fileBytes: parsed.fileBytes };
  }

  // The manifest, as soon as the contiguous prefix of chunks covers it; null until then.
  function peekManifest(dec) {
    if (dec.manifest) return dec.manifest;
    if (!dec.tid || !dec.chunks[0]) return null;
    var cb = dec.chunkBytes, ml;
    if (cb >= 2) ml = (dec.chunks[0][0] << 8) | dec.chunks[0][1];
    else if (dec.chunks[1]) ml = (dec.chunks[0][0] << 8) | dec.chunks[1][0];
    else return null;
    var need = 2 + ml, chunksNeeded = Math.ceil(need / cb);
    if (chunksNeeded > dec.K) return null;
    var buf = new Uint8Array(chunksNeeded * cb);
    for (var i = 0; i < chunksNeeded; i++) {
      if (!dec.chunks[i]) return null;
      buf.set(dec.chunks[i], i * cb);
    }
    try { dec.manifest = readManifest(buf).manifest; } catch (e) { return null; }
    return dec.manifest;
  }

  /* ------------------------------------------------------------------ */
  /* planning, ETA, formatters (clock-injected)                          */
  /* ------------------------------------------------------------------ */

  function plan(opts) {
    var chunkBytes = opts.chunkBytes, fps = opts.fps || FPS_DEFAULT;
    var K = chunkCount(opts.streamLen || 0, chunkBytes);
    var cycleSeconds = K / fps;
    return {
      K: K, bytesPerFrame: chunkBytes, bytesPerSecond: chunkBytes * fps,
      cycleSeconds: cycleSeconds, estimateSeconds: cycleSeconds * 1.15
    };
  }

  // Seconds remaining from the observed useful-frame (chunk) rate; null before 2 useful frames.
  function eta(o) {
    var have = o.have || 0, K = o.K || 0, elapsed = (o.elapsedMs || 0) / 1000;
    if (K <= 0) return null;
    if (have >= K) return 0;
    if (have < 2 || (o.framesSeen || 0) < 2 || elapsed <= 0) return null;
    var rate = have / elapsed;              // chunks per second so far
    var remaining = K - have;
    // Late chunks arrive slower (repair frames are only sometimes useful): pad by 15 %.
    return Math.ceil(remaining / rate * 1.15);
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 0) n = 0;
    if (n < 1024) return Math.round(n) + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'], u = -1;
    do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
    return (n < 10 ? n.toFixed(1) : String(Math.round(n))) + ' ' + units[u];
  }

  function formatDuration(seconds) {
    seconds = Math.round(Number(seconds) || 0);
    if (seconds < 0) seconds = 0;
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) {
      var m = Math.floor(seconds / 60), s = seconds % 60;
      return s ? m + 'm ' + s + 's' : m + 'm';
    }
    var h = Math.floor(seconds / 3600), mm = Math.floor((seconds % 3600) / 60);
    return mm ? h + 'h ' + mm + 'm' : h + 'h';
  }

  function formatPct(n) {
    n = Number(n) || 0;
    if (n < 0) n = 0; if (n > 100) n = 100;
    return Math.round(n) + '%';
  }

  function extOf(name) {
    var s = String(name == null ? '' : name).toLowerCase();
    var m = /\.([a-z0-9]{1,8})$/.exec(s);
    return m ? m[1] : '';
  }

  var EXT_KIND = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image', heif: 'image', avif: 'image', bmp: 'image', svg: 'image',
    mp4: 'video', mov: 'video', m4v: 'video', webm: 'video', mkv: 'video', avi: 'video',
    mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', opus: 'audio',
    txt: 'text', md: 'text', csv: 'text', json: 'text', xml: 'text', html: 'text', htm: 'text', js: 'text', css: 'text', log: 'text', vcf: 'text', ics: 'text',
    pdf: 'pdf',
    zip: 'archive', gz: 'archive', tgz: 'archive', '7z': 'archive', rar: 'archive', bz2: 'archive', xz: 'archive', tar: 'archive'
  };

  function fileKind(type, name) {
    var t = String(type == null ? '' : type).toLowerCase();
    if (t === 'application/pdf') return 'pdf';
    if (t.indexOf('image/') === 0) return 'image';
    if (t.indexOf('video/') === 0) return 'video';
    if (t.indexOf('audio/') === 0) return 'audio';
    if (t.indexOf('text/') === 0 || t === 'application/json' || t === 'application/xml') return 'text';
    if (/zip|compressed|x-tar|x-7z|x-rar|gzip|bzip/.test(t)) return 'archive';
    return EXT_KIND[extOf(name)] || 'other';
  }

  var NO_COMPRESS_EXT = { jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1, heic: 1, heif: 1, avif: 1, mp4: 1, mov: 1, m4v: 1, webm: 1, mkv: 1,
    mp3: 1, m4a: 1, aac: 1, ogg: 1, opus: 1, flac: 1, zip: 1, gz: 1, tgz: 1, '7z': 1, rar: 1, bz2: 1, xz: 1, pdf: 1 };
  var NO_COMPRESS_TYPE = /^(image\/(jpeg|png|gif|webp|heic|heif|avif)|video\/|audio\/|application\/(pdf|zip|gzip|x-gzip|x-7z-compressed|x-rar-compressed|x-bzip2|x-xz|vnd\.rar))/;

  // Already-compressed kinds gain nothing from deflate; the page keeps deflated bytes only if smaller anyway.
  function shouldCompress(type, name) {
    var t = String(type == null ? '' : type).toLowerCase();
    if (NO_COMPRESS_TYPE.test(t)) return false;
    if (NO_COMPRESS_EXT[extOf(name)]) return false;
    return true;
  }

  function imageShrinkTarget(size) {
    size = Number(size) || 0;
    var note = size > 0 && size < 150 * 1024
      ? 'Already small — a smaller copy may not help much.'
      : 'Resized to 1280 px on the long edge as a JPEG — a photo becomes a few hundred KB instead of several MB.';
    return { maxEdge: 1280, quality: 0.72, note: note };
  }

  /* ------------------------------------------------------------------ */

  var api = {
    ALNUM: ALNUM, MAGIC: MAGIC, HEADER_LEN: HEADER_LEN, TID_LEN: TID_LEN, K_MAX: K_MAX, SEQ_MAX: SEQ_MAX,
    MAX_NAME: MAX_NAME, SOLITON_C: SOLITON_C, SOLITON_DELTA: SOLITON_DELTA, PENDING_CAP_FACTOR: PENDING_CAP_FACTOR,
    GE_MAX_UNKNOWN: GE_MAX_UNKNOWN, GE_COLUMNS_PER_PUSH: GE_COLUMNS_PER_PUSH,
    PRESETS: PRESETS, DEFAULT_PRESET: DEFAULT_PRESET, FPS_MIN: FPS_MIN, FPS_MAX: FPS_MAX, FPS_DEFAULT: FPS_DEFAULT,
    // primitives
    utf8Encode: utf8Encode, utf8Decode: utf8Decode,
    base45Encode: base45Encode, base45Decode: base45Decode,
    crc32: crc32, crc32Hex: crc32Hex, hashStr: hashStr, rng: rng,
    toBase36: toBase36, fromBase36: fromBase36,
    // stream & manifest
    buildStream: buildStream, parseStream: parseStream, streamLength: streamLength, safeFileName: safeFileName,
    // chunking
    chunkBytesFor: chunkBytesFor, chunkCount: chunkCount, chunkAt: chunkAt,
    // fountain code & frames
    solitonTable: solitonTable, frameNeighbors: frameNeighbors, framePayload: framePayload,
    makeContext: makeContext, encodeFrame: encodeFrame, parseFrame: parseFrame,
    // decoder
    createDecoder: createDecoder, decoderPush: decoderPush, decoderProgress: decoderProgress,
    decoderHas: decoderHas, decoderResult: decoderResult, peekManifest: peekManifest, solvePending: solvePending,
    // planning & formatters
    plan: plan, eta: eta, formatBytes: formatBytes, formatDuration: formatDuration, formatPct: formatPct,
    fileKind: fileKind, shouldCompress: shouldCompress, imageShrinkTarget: imageShrinkTarget
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BeamEngine = api;
})(typeof self !== 'undefined' ? self : this);
