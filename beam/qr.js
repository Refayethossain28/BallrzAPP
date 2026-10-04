/**
 * beam/qr.js — a from-scratch QR code encoder, no dependencies. The full spec.
 *
 * Why hand-roll a QR encoder? Beam moves a file between two phones by painting
 * a fast loop of QR codes on one screen and reading them with the other's
 * camera — the encoder IS the radio. It has to run many times a second, at a
 * fixed version the user picked, in an offline page with no CDN, and in this
 * repo the rule is that anything algorithmic is a pure, unit-tested module.
 * voyager/qr.js proved the approach (v1–10, byte mode, level L — enough for a
 * URL); Beam needs the whole table: 177×177 symbols, every error-correction
 * level, and the alphanumeric mode its base45 frames are designed around
 * (5.5 bits a character instead of 8). So this is the same pipeline, grown
 * up: segment encoding, Reed–Solomon over GF(256) with cached generators,
 * block splitting and interleaving, matrix construction (finders, timing,
 * alignment grid, format/version BCH), all eight masks and the four penalty
 * rules, over a flat Uint8Array so a v30 frame encodes in a few milliseconds.
 *
 * Scope, honestly stated: versions 1–40, EC L/M/Q/H, ONE segment per symbol in
 * numeric, alphanumeric or byte (UTF-8) mode. No Kanji, no ECI, no mixed-mode
 * segmentation (Beam's frames are pure alphanumeric, so the optimiser would
 * never fire), no structured append, no Micro QR. encode() throws rather than
 * emit a code that would not fit. Output is a plain boolean matrix (plus a
 * toSVG helper); drawing on a canvas is the page's business. Every table and
 * formula follows ISO/IEC 18004 as laid out in Project Nayuki's qrcodegen, and
 * the tests round-trip every matrix through an independent decoder (jsQR).
 *
 * Runs as a browser global (window.BeamQR) and under Node vm for tests.
 */
(function (root) {
  'use strict';

  /* ── alphabet & levels ── */
  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  var ALNUM_INDEX = {};
  for (var ai = 0; ai < ALNUM.length; ai++) ALNUM_INDEX[ALNUM.charAt(ai)] = ai;

  // ecBits = the two-bit level indicator in the format information; idx = row in the tables below
  var EC_LEVELS = { L: { bits: 1, idx: 0 }, M: { bits: 0, idx: 1 }, Q: { bits: 3, idx: 2 }, H: { bits: 2, idx: 3 } };

  /* ── ISO 18004 Table 9 (index = version − 1; rows L, M, Q, H) ── */
  var ECC_PER_BLOCK = [
    [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  var NUM_BLOCKS = [
    [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  // mode indicator + character-count field widths for versions 1–9 / 10–26 / 27–40
  var MODES = {
    numeric: { id: 1, count: [10, 12, 14] },
    alnum: { id: 2, count: [9, 11, 13] },
    byte: { id: 4, count: [8, 16, 16] },
  };

  /* ── argument checks (the page passes user-chosen settings straight in) ── */
  function checkVersion(v) {
    if (typeof v !== 'number' || v !== Math.floor(v) || v < 1 || v > 40) throw new Error('version must be an integer 1..40, got ' + v);
  }
  function checkEc(ec) {
    if (!Object.prototype.hasOwnProperty.call(EC_LEVELS, ec)) throw new Error("ec must be 'L', 'M', 'Q' or 'H', got " + ec);
  }
  function checkMode(mode) {
    if (!Object.prototype.hasOwnProperty.call(MODES, mode)) throw new Error("mode must be 'numeric', 'alnum' or 'byte', got " + mode);
  }

  /* ── symbol geometry & codeword budgets ── */
  function sizeOf(version) { return 17 + 4 * version; }

  /** Data-carrying modules once finders, timing, alignment, format and version areas are removed. */
  function rawDataModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) {
      var a = Math.floor(v / 7) + 2;
      r -= (25 * a - 10) * a - 55;
      if (v >= 7) r -= 36;
    }
    return r;
  }
  function totalCodewords(version) { checkVersion(version); return Math.floor(rawDataModules(version) / 8); }
  function dataCodewords(version, ec) {
    checkVersion(version); checkEc(ec);
    var e = EC_LEVELS[ec].idx;
    return totalCodewords(version) - ECC_PER_BLOCK[e][version - 1] * NUM_BLOCKS[e][version - 1];
  }
  /** The Table 9 cells themselves: { eccPerBlock, numBlocks } for a version/level (exposed so tests can pin each cell). */
  function blockStructure(version, ec) {
    checkVersion(version); checkEc(ec);
    var e = EC_LEVELS[ec].idx;
    return { eccPerBlock: ECC_PER_BLOCK[e][version - 1], numBlocks: NUM_BLOCKS[e][version - 1] };
  }
  function countBits(mode, version) { return MODES[mode].count[version < 10 ? 0 : version < 27 ? 1 : 2]; }

  /** Alignment pattern centre coordinates (both axes share them); none for v1. */
  function alignmentPositions(version) {
    checkVersion(version);
    if (version === 1) return [];
    var n = Math.floor(version / 7) + 2;
    var size = sizeOf(version);
    var step = version === 32 ? 26 : Math.ceil((4 * version + 4) / (2 * n - 2)) * 2;
    var out = [6];
    for (var i = n - 2; i >= 0; i--) out.push(size - 7 - step * i);
    return out;
  }

  /** How many characters of `mode` fit at version/level (the spec's Table 7). */
  function capacity(version, ec, mode) {
    checkVersion(version); checkEc(ec); checkMode(mode);
    var D = dataCodewords(version, ec) * 8 - 4 - countBits(mode, version);
    var rem;
    if (mode === 'numeric') { rem = D % 10; return Math.floor(D / 10) * 3 + (rem >= 7 ? 2 : rem >= 4 ? 1 : 0); }
    if (mode === 'alnum') { rem = D % 11; return Math.floor(D / 11) * 2 + (rem >= 6 ? 1 : 0); }
    return Math.floor(D / 8);
  }

  /** Bits needed for the data part of a single segment of `n` chars (or bytes). */
  function segmentBits(mode, n) {
    if (mode === 'numeric') { var r = n % 3; return 10 * Math.floor(n / 3) + (r === 2 ? 7 : r === 1 ? 4 : 0); }
    if (mode === 'alnum') return 11 * Math.floor(n / 2) + 6 * (n % 2);
    return 8 * n;
  }

  /* ── GF(256), reduction polynomial 0x11d ── */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  }());

  /** Reed–Solomon generator polynomial for `n` ecc codewords, coefficients after the leading 1; cached per n. */
  var GENERATORS = {};
  function rsGenerator(n) {
    var cached = GENERATORS[n];
    if (cached) return cached;
    var g = new Uint8Array(n);           // starts as the monic polynomial 1 (all lower coefficients 0)
    g[n - 1] = 1;
    var rootPow = 1;                      // α^i
    for (var i = 0; i < n; i++) {
      // multiply g by (x − α^i): g[j] = g[j+1] ^ g[j]·α^i  (shift left, subtract scaled copy)
      for (var j = 0; j < n; j++) {
        var scaled = g[j] ? EXP[LOG[g[j]] + LOG[rootPow]] : 0;
        g[j] = (j + 1 < n ? g[j + 1] : 0) ^ scaled;
      }
      rootPow = rootPow & 0x80 ? ((rootPow << 1) ^ 0x11d) & 0xff : rootPow << 1;
    }
    GENERATORS[n] = g;
    return g;
  }

  /** The `eccLen` error-correction codewords for one data block (polynomial long division). */
  function rsEncode(data, eccLen) {
    if (typeof eccLen !== 'number' || eccLen < 1 || eccLen > 255) throw new Error('eccLen must be 1..255');
    var gen = rsGenerator(eccLen);
    var rem = new Uint8Array(eccLen);
    for (var i = 0; i < data.length; i++) {
      var factor = (data[i] ^ rem[0]) & 0xff;
      for (var k = 0; k + 1 < eccLen; k++) rem[k] = rem[k + 1];
      rem[eccLen - 1] = 0;
      if (!factor) continue;
      var lf = LOG[factor];
      for (var j = 0; j < eccLen; j++) if (gen[j]) rem[j] ^= EXP[LOG[gen[j]] + lf];
    }
    return rem;
  }

  /* ── bit writer over a fixed-size codeword buffer ── */
  function BitBuf(nBytes) { this.buf = new Uint8Array(nBytes); this.len = 0; }
  BitBuf.prototype.put = function (value, n) {
    for (var i = n - 1; i >= 0; i--) {
      if ((value >>> i) & 1) this.buf[this.len >> 3] |= 0x80 >> (this.len & 7);
      this.len++;
    }
  };

  /** UTF-8 bytes of a JS string. Surrogate pairs combine; a lone surrogate becomes U+FFFD (EF BF BD), as TextEncoder does. */
  function utf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        else c = 0xfffd;                                     // high surrogate not followed by a low one
      } else if (c >= 0xd800 && c <= 0xdfff) {
        c = 0xfffd;                                          // lone low surrogate, or a high one at the very end
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function isNumeric(text) { return /^[0-9]+$/.test(text); }
  function isAlnum(text) {
    for (var i = 0; i < text.length; i++) if (!Object.prototype.hasOwnProperty.call(ALNUM_INDEX, text.charAt(i))) return false;
    return true;
  }
  function detectMode(text) { return isNumeric(text) ? 'numeric' : isAlnum(text) ? 'alnum' : 'byte'; }

  /** Write one segment's mode indicator, count and data into the buffer. */
  function writeSegment(buf, mode, text, bytes, version) {
    buf.put(MODES[mode].id, 4);
    var i;
    if (mode === 'numeric') {
      buf.put(text.length, countBits(mode, version));
      for (i = 0; i + 3 <= text.length; i += 3) buf.put(parseInt(text.substr(i, 3), 10), 10);
      var rest = text.length - i;
      if (rest === 2) buf.put(parseInt(text.substr(i, 2), 10), 7);
      else if (rest === 1) buf.put(parseInt(text.substr(i, 1), 10), 4);
    } else if (mode === 'alnum') {
      buf.put(text.length, countBits(mode, version));
      for (i = 0; i + 2 <= text.length; i += 2) buf.put(ALNUM_INDEX[text.charAt(i)] * 45 + ALNUM_INDEX[text.charAt(i + 1)], 11);
      if (i < text.length) buf.put(ALNUM_INDEX[text.charAt(i)], 6);
    } else {
      buf.put(bytes.length, countBits(mode, version));
      for (i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);
    }
  }

  /* ── BCH-protected format & version information (placement verified in voyager/qr.js) ── */
  function formatBits(ec, mask) {
    checkEc(ec);
    if (typeof mask !== 'number' || mask < 0 || mask > 7 || mask !== Math.floor(mask)) throw new Error('mask must be 0..7');
    var data = (EC_LEVELS[ec].bits << 3) | mask;
    var v = data << 10;
    var g = 0x537;                          // 10100110111
    for (var i = 14; i >= 10; i--) if ((v >>> i) & 1) v ^= g << (i - 10);
    return ((data << 10) | v) ^ 0x5412;     // 101010000010010
  }

  function versionBits(version) {
    checkVersion(version);
    var v = version << 12;
    var g = 0x1f25;                         // 1111100100101
    for (var i = 17; i >= 12; i--) if ((v >>> i) & 1) v ^= g << (i - 12);
    return (version << 12) | v;
  }

  /* ── function patterns on a flat matrix (mod = module colour, fn = 1 where reserved) ── */
  function placeFinder(mod, fn, size, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                 (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        mod[rr * size + cc] = on ? 1 : 0;
        fn[rr * size + cc] = 1;
      }
    }
  }

  function placeAlignment(mod, fn, size, row, col) {
    for (var r = -2; r <= 2; r++) {
      for (var c = -2; c <= 2; c++) {
        var i = (row + r) * size + col + c;
        mod[i] = Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0;
        fn[i] = 1;
      }
    }
  }

  /** Both copies of the 15 format bits — see voyager/qr.js for the derivation of the coordinates. */
  function paintFormat(m, size, ec, mask) {
    var fmt = formatBits(ec, mask);
    for (var fb = 0; fb < 15; fb++) {
      var bit = (fmt >>> fb) & 1;
      // copy 1: around the top-left finder — LSBs run DOWN column 8 first
      if (fb < 6) m[fb * size + 8] = bit;
      else if (fb === 6) m[7 * size + 8] = bit;
      else if (fb === 7) m[8 * size + 8] = bit;
      else if (fb === 8) m[8 * size + 7] = bit;
      else m[8 * size + 14 - fb] = bit;
      // copy 2: LSBs run LEFT along row 8 from the right edge, then down column 8 above the bottom-left finder
      if (fb < 8) m[8 * size + size - 1 - fb] = bit;
      else m[(size - 15 + fb) * size + 8] = bit;
    }
  }

  /** Mask condition for module (r, c) under pattern `mk` — 1 means flip. */
  function maskBit(mk, r, c) {
    switch (mk) {
      case 0: return (r + c) % 2 === 0 ? 1 : 0;
      case 1: return r % 2 === 0 ? 1 : 0;
      case 2: return c % 3 === 0 ? 1 : 0;
      case 3: return (r + c) % 3 === 0 ? 1 : 0;
      case 4: return ((r >> 1) + Math.floor(c / 3)) % 2 === 0 ? 1 : 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0 ? 1 : 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0 ? 1 : 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0 ? 1 : 0;
    }
  }

  /** The standard four penalty rules on a flat 0/1 matrix — lowest total wins the mask. */
  function penalty(m, size) {
    var score = 0, r, c, i, run, cur, prev, dark = 0;
    // N1: runs of 5+ identical modules in rows and columns (3 + run − 5 each)
    for (r = 0; r < size; r++) {
      run = 1; prev = m[r * size];
      for (c = 1; c < size; c++) {
        cur = m[r * size + c];
        if (cur === prev) run++;
        else { if (run >= 5) score += run - 2; run = 1; prev = cur; }
      }
      if (run >= 5) score += run - 2;
    }
    for (c = 0; c < size; c++) {
      run = 1; prev = m[c];
      for (r = 1; r < size; r++) {
        cur = m[r * size + c];
        if (cur === prev) run++;
        else { if (run >= 5) score += run - 2; run = 1; prev = cur; }
      }
      if (run >= 5) score += run - 2;
    }
    // N2: 2×2 blocks of one colour
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        i = r * size + c; cur = m[i];
        if (cur === m[i + 1] && cur === m[i + size] && cur === m[i + size + 1]) score += 3;
      }
    }
    // N3: finder-like 1:1:3:1:1 (1011101) with four light modules on one side, per row and column
    var k, ok1, ok2;
    for (r = 0; r < size; r++) {
      for (c = 0; c + 10 < size; c++) {
        i = r * size + c;
        ok1 = true; ok2 = true;
        for (k = 0; k < 11; k++) {
          cur = m[i + k];
          if (cur !== N3_A[k]) ok1 = false;
          if (cur !== N3_B[k]) ok2 = false;
          if (!ok1 && !ok2) break;
        }
        if (ok1 || ok2) score += 40;
      }
    }
    for (c = 0; c < size; c++) {
      for (r = 0; r + 10 < size; r++) {
        i = r * size + c;
        ok1 = true; ok2 = true;
        for (k = 0; k < 11; k++) {
          cur = m[i + k * size];
          if (cur !== N3_A[k]) ok1 = false;
          if (cur !== N3_B[k]) ok2 = false;
          if (!ok1 && !ok2) break;
        }
        if (ok1 || ok2) score += 40;
      }
    }
    // N4: dark-module balance, 10 per 5 % step away from 50 %
    var n = size * size;
    for (i = 0; i < n; i++) dark += m[i];
    score += Math.floor(Math.abs((dark * 100) / n - 50) / 5) * 10;
    return score;
  }
  var N3_A = new Uint8Array([1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]);
  var N3_B = new Uint8Array([0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]);

  /** The N1..N4 penalty score of a size×size matrix given as rows of booleans/0-1 (the shape encode() returns). */
  function maskPenalty(modules) {
    if (!modules || typeof modules.length !== 'number' || !modules.length) throw new Error('maskPenalty needs a non-empty square matrix');
    var size = modules.length, flat = new Uint8Array(size * size);
    for (var r = 0; r < size; r++) {
      var row = modules[r];
      if (!row || row.length !== size) throw new Error('maskPenalty needs a square matrix (row ' + r + ')');
      for (var c = 0; c < size; c++) flat[r * size + c] = row[c] ? 1 : 0;
    }
    return penalty(flat, size);
  }

  /**
   * Encode `text` → { version, ec, mode, size, mask, modules }.
   * opts: ec ('L' default), version (fixed) or minVersion/maxVersion, mode (force), mask (force 0..7).
   * modules is a size×size array of boolean rows, true = dark. Throws Error(/too long/) when it won't fit.
   */
  function encode(text, opts) {
    opts = opts || {};
    text = String(text == null ? '' : text);
    var ec = opts.ec == null ? 'L' : opts.ec;
    checkEc(ec);
    var e = EC_LEVELS[ec].idx;

    // ── mode ──
    var mode = opts.mode == null ? detectMode(text) : opts.mode;
    checkMode(mode);
    if (mode === 'numeric' && !isNumeric(text)) throw new Error('numeric mode needs digits only');
    if (mode === 'alnum' && !isAlnum(text)) throw new Error('alnum mode needs characters from BeamQR.ALNUM only');
    var bytes = mode === 'byte' ? utf8Bytes(text) : null;
    var nChars = mode === 'byte' ? bytes.length : text.length;
    var dataBits = segmentBits(mode, nChars);

    // ── version ──
    var minV, maxV;
    if (opts.version != null) { checkVersion(opts.version); minV = maxV = opts.version; }
    else {
      minV = opts.minVersion == null ? 1 : opts.minVersion;
      maxV = opts.maxVersion == null ? 40 : opts.maxVersion;
      checkVersion(minV); checkVersion(maxV);
      if (minV > maxV) throw new Error('minVersion exceeds maxVersion');
    }
    var version = 0;
    for (var v = minV; v <= maxV; v++) {
      if (4 + countBits(mode, v) + dataBits <= dataCodewords(v, ec) * 8) { version = v; break; }
    }
    if (!version) {
      throw new Error('too long: ' + nChars + ' ' + (mode === 'byte' ? 'bytes' : 'chars') + ' in ' + mode + ' mode exceeds ' +
        (minV === maxV ? 'version ' + minV : 'every version up to ' + maxV) + ' at EC ' + ec +
        ' (max ' + capacity(maxV, ec, mode) + ')');
    }
    var mask = opts.mask;
    if (mask != null && (typeof mask !== 'number' || mask < 0 || mask > 7 || mask !== Math.floor(mask))) throw new Error('mask must be 0..7');

    // ── bitstream: segment, terminator, byte-align, pad codewords ──
    var nData = dataCodewords(version, ec);
    var buf = new BitBuf(nData);
    writeSegment(buf, mode, text, bytes, version);
    buf.len += Math.min(4, nData * 8 - buf.len);            // terminator (zeros)
    buf.len = (buf.len + 7) & ~7;                           // byte boundary (zeros)
    for (var p = buf.len >> 3, toggle = 0; p < nData; p++, toggle ^= 1) buf.buf[p] = toggle ? 0x11 : 0xec;
    var data = buf.buf;

    // ── split into blocks, compute ecc, interleave ──
    var eccLen = ECC_PER_BLOCK[e][version - 1];
    var nBlocks = NUM_BLOCKS[e][version - 1];
    var total = totalCodewords(version);
    var shortLen = Math.floor(total / nBlocks);             // whole-block length of the short blocks
    var numShort = nBlocks - (total % nBlocks);
    var shortData = shortLen - eccLen;
    var interleaved = new Uint8Array(total);
    var blockStarts = new Array(nBlocks), blockLens = new Array(nBlocks), eccs = new Array(nBlocks);
    var at = 0, b;
    for (b = 0; b < nBlocks; b++) {
      blockLens[b] = shortData + (b < numShort ? 0 : 1);
      blockStarts[b] = at;
      eccs[b] = rsEncode(data.subarray(at, at + blockLens[b]), eccLen);
      at += blockLens[b];
    }
    var out = 0, col;
    for (col = 0; col <= shortData; col++) {
      for (b = 0; b < nBlocks; b++) if (col < blockLens[b]) interleaved[out++] = data[blockStarts[b] + col];
    }
    for (col = 0; col < eccLen; col++) for (b = 0; b < nBlocks; b++) interleaved[out++] = eccs[b][col];

    // ── function modules ──
    var size = sizeOf(version), n = size * size;
    var mod = new Uint8Array(n), fn = new Uint8Array(n);
    placeFinder(mod, fn, size, 0, 0); placeFinder(mod, fn, size, 0, size - 7); placeFinder(mod, fn, size, size - 7, 0);
    var centres = alignmentPositions(version), ar, ac;
    for (ar = 0; ar < centres.length; ar++) {
      for (ac = 0; ac < centres.length; ac++) {
        if (fn[centres[ar] * size + centres[ac]]) continue;      // the three that overlap finders
        placeAlignment(mod, fn, size, centres[ar], centres[ac]);
      }
    }
    var t, i;
    for (t = 8; t < size - 8; t++) {                            // timing patterns
      i = 6 * size + t; if (!fn[i]) { mod[i] = t % 2 === 0 ? 1 : 0; fn[i] = 1; }
      i = t * size + 6; if (!fn[i]) { mod[i] = t % 2 === 0 ? 1 : 0; fn[i] = 1; }
    }
    mod[(size - 8) * size + 8] = 1; fn[(size - 8) * size + 8] = 1;   // the always-dark module
    var fr;                                                     // reserve the format areas (painted per mask)
    for (fr = 0; fr < 9; fr++) { fn[8 * size + fr] = 1; fn[fr * size + 8] = 1; }
    for (fr = 0; fr < 8; fr++) { fn[8 * size + size - 1 - fr] = 1; fn[(size - 1 - fr) * size + 8] = 1; }
    if (version >= 7) {
      var vb = versionBits(version);
      for (var vi = 0; vi < 18; vi++) {
        var bit = (vb >>> vi) & 1;
        var a1 = Math.floor(vi / 3) * size + size - 11 + (vi % 3);
        var a2 = (size - 11 + (vi % 3)) * size + Math.floor(vi / 3);
        mod[a1] = bit; fn[a1] = 1; mod[a2] = bit; fn[a2] = 1;
      }
    }

    // ── zigzag data placement (two columns at a time, up then down, skipping the timing column) ──
    var bitIdx = 0, totalBits = total * 8;
    var right = size - 1, upward = true;
    while (right > 0) {
      if (right === 6) right--;
      for (var step = 0; step < size; step++) {
        var row = upward ? size - 1 - step : step;
        for (var side = 0; side < 2; side++) {
          i = row * size + right - side;
          if (fn[i]) continue;
          if (bitIdx < totalBits) { mod[i] = (interleaved[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1; bitIdx++; }
          else mod[i] = 0;                                          // remainder bits
        }
      }
      upward = !upward;
      right -= 2;
    }

    // ── masking: a forced mask, or the lowest penalty of all eight ──
    var best = null, bestScore = Infinity, bestMask = 0;
    var first = mask == null ? 0 : mask, last = mask == null ? 7 : mask;
    for (var mk = first; mk <= last; mk++) {
      var trial = new Uint8Array(n);
      for (var r = 0, idx = 0; r < size; r++) {
        for (var c = 0; c < size; c++, idx++) trial[idx] = fn[idx] ? mod[idx] : mod[idx] ^ maskBit(mk, r, c);
      }
      paintFormat(trial, size, ec, mk);                            // part of the symbol, so part of the score
      var score = mask == null ? penalty(trial, size) : 0;
      if (score < bestScore) { bestScore = score; best = trial; bestMask = mk; }
    }

    var modules = new Array(size);
    for (var rr = 0; rr < size; rr++) {
      var rowArr = new Array(size), base = rr * size;
      for (var cc = 0; cc < size; cc++) rowArr[cc] = best[base + cc] === 1;
      modules[rr] = rowArr;
    }
    return { version: version, ec: ec, mode: mode, size: size, mask: bestMask, modules: modules };
  }

  /** An SVG string: white background, quiet zone, every dark module in one <path>. */
  function toSVG(code, moduleSize, quiet) {
    if (quiet == null) quiet = 4;
    moduleSize = moduleSize || 4;
    var side = code.size + quiet * 2, px = side * moduleSize;
    var d = [];
    for (var r = 0; r < code.size; r++) {
      var row = code.modules[r];
      for (var c = 0; c < code.size; c++) if (row[c]) d.push('M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z');
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 ' + side + ' ' + side +
      '" shape-rendering="crispEdges"><rect width="' + side + '" height="' + side + '" fill="#fff"/><path d="' + d.join('') + '" fill="#000"/></svg>';
  }

  var api = {
    ALNUM: ALNUM,
    capacity: capacity,
    dataCodewords: dataCodewords,
    totalCodewords: totalCodewords,
    blockStructure: blockStructure,
    encode: encode,
    toSVG: toSVG,
    formatBits: formatBits,
    versionBits: versionBits,
    alignmentPositions: alignmentPositions,
    rsEncode: rsEncode,
    maskPenalty: maskPenalty,
    utf8Bytes: utf8Bytes,
    detectMode: detectMode,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BeamQR = api;
})(typeof self !== 'undefined' ? self : this);
