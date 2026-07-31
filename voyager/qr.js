/**
 * voyager/qr.js — a from-scratch QR code encoder, no dependencies.
 *
 * Why hand-roll a QR encoder? Voyager's 📱 hand-off draws a code on a canvas
 * so another device's camera can pick up the page you're reading — and in this
 * repo the rule is that anything algorithmic is a pure, unit-tested module.
 * The whole pipeline lives here: byte-mode segmentation, Reed–Solomon error
 * correction over GF(256), block interleaving, matrix construction (finders,
 * timing, alignment, format/version BCH), all eight masks and the penalty
 * scoring that picks between them.
 *
 * Scope, honestly stated: byte mode only (UTF-8), versions 1–10, EC level L —
 * that's up to 271 bytes, plenty for a URL. encode() throws beyond that.
 * Output is a plain boolean matrix; rendering is the caller's business.
 * Verified in tests by round-tripping through an independent decoder (jsQR).
 *
 * Runs as a browser global (window.VoyagerQR) and under Node vm for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoyagerQR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── version tables, EC level L ──
   * [data codewords, ecc per block, blocks in group1, data len g1, blocks g2, data len g2] */
  var VERSIONS = {
    1: { data: 19, ecc: 7, g1: 1, d1: 19, g2: 0, d2: 0 },
    2: { data: 34, ecc: 10, g1: 1, d1: 34, g2: 0, d2: 0 },
    3: { data: 55, ecc: 15, g1: 1, d1: 55, g2: 0, d2: 0 },
    4: { data: 80, ecc: 20, g1: 1, d1: 80, g2: 0, d2: 0 },
    5: { data: 108, ecc: 26, g1: 1, d1: 108, g2: 0, d2: 0 },
    6: { data: 136, ecc: 18, g1: 2, d1: 68, g2: 0, d2: 0 },
    7: { data: 156, ecc: 20, g1: 2, d1: 78, g2: 0, d2: 0 },
    8: { data: 194, ecc: 24, g1: 2, d1: 97, g2: 0, d2: 0 },
    9: { data: 232, ecc: 30, g1: 2, d1: 116, g2: 0, d2: 0 },
    10: { data: 274, ecc: 18, g1: 2, d1: 68, g2: 2, d2: 69 },
  };
  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

  /* ── GF(256), polynomial 0x11d ── */
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  }());
  function gmul(a, b) { return (a && b) ? EXP[LOG[a] + LOG[b]] : 0; }

  /** Reed–Solomon: generator polynomial for `n` ecc codewords. */
  function rsGenerator(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(g.length + 1);
      for (var k = 0; k < next.length; k++) next[k] = 0;
      for (var j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= gmul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }

  /** The ecc codewords for a data block (polynomial long division). */
  function rsEncode(data, n) {
    var gen = rsGenerator(n);
    var rem = data.slice().concat(new Array(n).fill(0));
    for (var i = 0; i < data.length; i++) {
      var lead = rem[i];
      if (!lead) continue;
      for (var j = 0; j < gen.length; j++) rem[i + j] ^= gmul(gen[j], lead);
    }
    return rem.slice(data.length);
  }

  /* ── bit stream ── */
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  function utf8Bytes(s) {
    s = String(s == null ? '' : s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.codePointAt(i);
      if (c > 0xffff) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  /** Smallest version whose byte capacity fits `len` bytes (count field included). */
  function pickVersion(len) {
    for (var v = 1; v <= 10; v++) {
      var countBits = v < 10 ? 8 : 16;
      var capacity = VERSIONS[v].data * 8 - 4 - countBits;
      if (len * 8 <= capacity) return v;
    }
    return 0;
  }

  /* ── matrix helpers: `null` = unset data module, true/false = fixed function module ── */
  function makeMatrix(size) {
    var m = new Array(size);
    for (var r = 0; r < size; r++) { m[r] = new Array(size); for (var c = 0; c < size; c++) m[r][c] = null; }
    return m;
  }

  function placeFinder(m, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                 (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[rr][cc] = !!on;
      }
    }
  }

  function placeAlignment(m, row, col) {
    for (var r = -2; r <= 2; r++) {
      for (var c = -2; c <= 2; c++) {
        m[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      }
    }
  }

  /** BCH-protected format info (EC level L = 01, plus the mask id). */
  function formatBits(mask) {
    var data = (1 << 3) | mask;             // L=01 → value 1 in the top two bits of 5
    var v = data << 10;
    var g = 0x537;                          // 10100110111
    for (var i = 14; i >= 10; i--) if ((v >>> i) & 1) v ^= g << (i - 10);
    return ((data << 10) | v) ^ 0x5412;     // mask 101010000010010
  }

  /** BCH-protected version info (v ≥ 7). */
  function versionBits(version) {
    var v = version << 12;
    var g = 0x1f25;                         // 1111100100101
    for (var i = 17; i >= 12; i--) if ((v >>> i) & 1) v ^= g << (i - 12);
    return (version << 12) | v;
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; },
  ];

  /** The standard four penalty rules — lowest total wins the mask. */
  function penalty(m) {
    var size = m.length, score = 0, r, c;
    // N1: runs of 5+ in rows and columns
    for (var dir = 0; dir < 2; dir++) {
      for (r = 0; r < size; r++) {
        var run = 1;
        for (c = 1; c < size; c++) {
          var cur = dir ? m[c][r] : m[r][c];
          var prev = dir ? m[c - 1][r] : m[r][c - 1];
          if (cur === prev) { run++; if (c === size - 1 && run >= 5) score += 3 + run - 5; }
          else { if (run >= 5) score += 3 + run - 5; run = 1; }
        }
      }
    }
    // N2: 2×2 blocks
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
      }
    }
    // N3: finder-like 1011101 with 0000 on a side
    var P1 = [true, false, true, true, true, false, true, false, false, false, false];
    var P2 = [false, false, false, false, true, false, true, true, true, false, true];
    for (r = 0; r < size; r++) {
      for (c = 0; c + 10 < size; c++) {
        var h1 = true, h2 = true, v1 = true, v2 = true;
        for (var k = 0; k < 11; k++) {
          if (m[r][c + k] !== P1[k]) h1 = false;
          if (m[r][c + k] !== P2[k]) h2 = false;
          if (m[c + k][r] !== P1[k]) v1 = false;
          if (m[c + k][r] !== P2[k]) v2 = false;
        }
        if (h1 || h2) score += 40;
        if (v1 || v2) score += 40;
      }
    }
    // N4: dark-module balance
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c]) dark++;
    var percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return score;
  }

  /**
   * Encode `text` (UTF-8) → { version, size, modules } where modules is a
   * size×size boolean matrix (true = dark). Throws when the text won't fit
   * in version 10 at EC level L (271 bytes).
   */
  function encode(text) {
    var bytes = utf8Bytes(text);
    var version = pickVersion(bytes.length);
    if (!version) throw new Error('too long for a hand-off code (max 271 bytes)');
    var spec = VERSIONS[version];

    // ── bitstream: mode, count, data, terminator, pad ──
    var buf = new BitBuf();
    buf.put(4, 4);                                        // byte mode
    buf.put(bytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);
    var capacityBits = spec.data * 8;
    var term = Math.min(4, capacityBits - buf.bits.length);
    buf.put(0, term);
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);
    var padToggle = true;
    while (buf.bits.length < capacityBits) { buf.put(padToggle ? 0xec : 0x11, 8); padToggle = !padToggle; }

    var codewords = [];
    for (var b = 0; b < buf.bits.length; b += 8) {
      var w = 0;
      for (var bb = 0; bb < 8; bb++) w = (w << 1) | buf.bits[b + bb];
      codewords.push(w);
    }

    // ── split into blocks, compute ecc, interleave ──
    var blocks = [], eccBlocks = [], at = 0, g;
    for (g = 0; g < spec.g1; g++) { blocks.push(codewords.slice(at, at + spec.d1)); at += spec.d1; }
    for (g = 0; g < spec.g2; g++) { blocks.push(codewords.slice(at, at + spec.d2)); at += spec.d2; }
    for (g = 0; g < blocks.length; g++) eccBlocks.push(rsEncode(blocks[g], spec.ecc));
    var interleaved = [];
    var maxData = Math.max(spec.d1, spec.d2 || 0);
    for (var col = 0; col < maxData; col++) for (g = 0; g < blocks.length; g++) if (col < blocks[g].length) interleaved.push(blocks[g][col]);
    for (var ec = 0; ec < spec.ecc; ec++) for (g = 0; g < eccBlocks.length; g++) interleaved.push(eccBlocks[g][ec]);

    // ── function modules ──
    var size = 17 + 4 * version;
    var m = makeMatrix(size);
    placeFinder(m, 0, 0); placeFinder(m, 0, size - 7); placeFinder(m, size - 7, 0);
    var centers = ALIGN[version];
    for (var ar = 0; ar < centers.length; ar++) {
      for (var ac = 0; ac < centers.length; ac++) {
        var cr = centers[ar], cc2 = centers[ac];
        if (m[cr][cc2] !== null) continue;               // would overlap a finder
        placeAlignment(m, cr, cc2);
      }
    }
    for (var t = 8; t < size - 8; t++) {                 // timing
      if (m[6][t] === null) m[6][t] = t % 2 === 0;
      if (m[t][6] === null) m[t][6] = t % 2 === 0;
    }
    m[size - 8][8] = true;                               // the always-dark module
    // reserve format areas so data placement skips them
    var fr;
    for (fr = 0; fr < 9; fr++) { if (m[8][fr] === null) m[8][fr] = false; if (m[fr][8] === null) m[fr][8] = false; }
    for (fr = 0; fr < 8; fr++) { if (m[8][size - 1 - fr] === null) m[8][size - 1 - fr] = false; if (m[size - 1 - fr][8] === null) m[size - 1 - fr][8] = false; }
    if (version >= 7) {
      var vb = versionBits(version);
      for (var vi = 0; vi < 18; vi++) {
        var bit = (vb >>> vi) & 1;
        m[Math.floor(vi / 3)][size - 11 + (vi % 3)] = !!bit;
        m[size - 11 + (vi % 3)][Math.floor(vi / 3)] = !!bit;
      }
    }

    // remember which modules are data (they get masked; function modules don't)
    var isData = [];
    for (var rr = 0; rr < size; rr++) { isData[rr] = []; for (var cc = 0; cc < size; cc++) isData[rr][cc] = m[rr][cc] === null; }

    // ── zigzag data placement ──
    var bitIdx = 0;
    var total = interleaved.length * 8;
    function nextBit() { var w = interleaved[bitIdx >> 3]; var bit2 = (w >>> (7 - (bitIdx & 7))) & 1; bitIdx++; return !!bit2; }
    var colPair = size - 1, upward = true;
    while (colPair > 0) {
      if (colPair === 6) colPair--;                      // vertical timing column is skipped whole
      for (var step = 0; step < size; step++) {
        var row = upward ? size - 1 - step : step;
        for (var side = 0; side < 2; side++) {
          var c3 = colPair - side;
          if (m[row][c3] !== null) continue;
          m[row][c3] = bitIdx < total ? nextBit() : false;
        }
      }
      upward = !upward;
      colPair -= 2;
    }

    // ── try all masks, keep the lowest penalty ──
    var best = null, bestScore = Infinity, bestMask = 0;
    for (var mk = 0; mk < 8; mk++) {
      var trial = [];
      for (var r2 = 0; r2 < size; r2++) {
        trial[r2] = [];
        for (var c4 = 0; c4 < size; c4++) {
          trial[r2][c4] = isData[r2][c4] ? (m[r2][c4] !== MASKS[mk](r2, c4)) : m[r2][c4];
        }
      }
      // paint this mask's format info before scoring — it's part of the symbol
      var fmt = formatBits(mk);
      for (var fb = 0; fb < 15; fb++) {              // fb = LSB index, per the spec
        var v3 = ((fmt >>> fb) & 1) === 1;
        // copy 1: around the top-left finder — LSBs run DOWN column 8 first
        if (fb < 6) trial[fb][8] = v3;
        else if (fb === 6) trial[7][8] = v3;
        else if (fb === 7) trial[8][8] = v3;
        else if (fb === 8) trial[8][7] = v3;
        else trial[8][14 - fb] = v3;
        // copy 2: LSBs run LEFT along row 8 from the right edge, then down
        // column 8 above the bottom-left finder (the dark module stays put)
        if (fb < 8) trial[8][size - 1 - fb] = v3;
        else trial[size - 15 + fb][8] = v3;
      }
      var score = penalty(trial);
      if (score < bestScore) { bestScore = score; best = trial; bestMask = mk; }
    }

    return { version: version, size: size, mask: bestMask, modules: best };
  }

  return { encode: encode, utf8Bytes: utf8Bytes, formatBits: formatBits, versionBits: versionBits };
}));
