/* CoinQR — a tiny, dependency-free QR Code (Model 2) encoder.
 * (Verbatim copy of ripple/qr.js with the global renamed; that encoder is
 * verified bit-for-bit against a reference library by scripts/test-ripple-qr.mjs.)
 * ============================================================
 * Byte mode, error-correction level L, versions 1–9 (plenty for a short URL).
 * Returns a square matrix of booleans (true = dark module); the caller adds the
 * quiet zone and renders. Classic script: exposes `self.CoinQR` (browser) and
 * `module.exports` (Node test sandbox). Pure and deterministic.
 *
 * Implements: byte-mode bitstream, Reed–Solomon over GF(256) (prim 0x11d),
 * block split + interleave, function-pattern placement (finders, separators,
 * timing, alignment, dark module), BCH format info, and best-mask selection by
 * the four standard penalty rules.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CoinQR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Galois field GF(256), primitive polynomial 0x11d ----
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // Reed–Solomon ECC codewords for `data` (array of bytes), `ecLen` symbols.
  function rsEncode(data, ecLen) {
    // generator polynomial
    var gen = [1];
    for (var d = 0; d < ecLen; d++) {
      var ng = new Array(gen.length + 1).fill(0);
      for (var i = 0; i < gen.length; i++) {
        ng[i] ^= gmul(gen[i], EXP[d]);
        ng[i + 1] ^= gen[i];
      }
      gen = ng;
    }
    var res = data.slice().concat(new Array(ecLen).fill(0));
    for (var p = 0; p < data.length; p++) {
      var coef = res[p];
      if (coef !== 0) for (var j = 0; j < gen.length; j++) res[p + j] ^= gmul(gen[j], coef);
    }
    return res.slice(data.length);
  }

  // ---- version table (ECC level L): [totalData, eccPerBlock, numBlocks] ----
  // (all chosen versions use equal-sized blocks)
  var VL = {
    1: [19, 7, 1], 2: [34, 10, 1], 3: [55, 15, 1], 4: [80, 20, 1], 5: [108, 26, 1],
    6: [136, 18, 2], 7: [156, 20, 2], 8: [194, 24, 2], 9: [232, 30, 2]
  };
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46]
  };

  function toBytes(str) {
    // UTF-8 encode
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }

  function chooseVersion(len) {
    for (var v = 1; v <= 9; v++) {
      var data = VL[v][0];
      var ccBits = v <= 9 ? 8 : 16;            // char-count bits for byte mode
      var capacity = data * 8 - 4 - ccBits;    // minus mode indicator + count
      if (len * 8 <= capacity) return v;
    }
    return null; // too long for the supported range
  }

  // ---- bit buffer ----
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, len) { for (var i = len - 1; i >= 0; i--) this.bits.push((val >> i) & 1); };

  function buildCodewords(bytes, version) {
    var totalData = VL[version][0];
    var bb = new BitBuf();
    bb.put(0b0100, 4);                 // byte mode
    bb.put(bytes.length, version <= 9 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);
    // terminator
    var cap = totalData * 8;
    var term = Math.min(4, cap - bb.bits.length);
    bb.put(0, term);
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);
    // codewords
    var cw = [];
    for (i = 0; i < bb.bits.length; i += 8) {
      var b = 0; for (var j = 0; j < 8; j++) b = (b << 1) | bb.bits[i + j];
      cw.push(b);
    }
    // pad
    var pads = [0xec, 0x11], pi = 0;
    while (cw.length < totalData) { cw.push(pads[pi & 1]); pi++; }
    return cw;
  }

  // split into blocks, append ECC, interleave
  function interleave(dataCw, version) {
    var ecLen = VL[version][1], nBlocks = VL[version][2];
    var perBlock = dataCw.length / nBlocks;
    var dBlocks = [], eBlocks = [];
    for (var b = 0; b < nBlocks; b++) {
      var blk = dataCw.slice(b * perBlock, (b + 1) * perBlock);
      dBlocks.push(blk);
      eBlocks.push(rsEncode(blk, ecLen));
    }
    var out = [];
    for (var i = 0; i < perBlock; i++) for (b = 0; b < nBlocks; b++) out.push(dBlocks[b][i]);
    for (i = 0; i < ecLen; i++) for (b = 0; b < nBlocks; b++) out.push(eBlocks[b][i]);
    return out;
  }

  // ---- matrix ----
  function makeMatrix(size) {
    var m = [], used = [];
    for (var r = 0; r < size; r++) { m.push(new Array(size).fill(false)); used.push(new Array(size).fill(false)); }
    return { m: m, used: used, size: size };
  }
  function setF(M, r, c, v) { M.m[r][c] = v; M.used[r][c] = true; }
  function placeFinder(M, r, c) {
    for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
      var rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= M.size || cc >= M.size) continue;
      var inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
      var inCore = (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
      setF(M, rr, cc, inRing || inCore);
    }
  }
  function placeAlignment(M, version) {
    var pos = ALIGN[version]; if (!pos.length) return;
    var size = M.size;
    function inFinder(r, c) { // the three corner finder zones (8x8)
      return (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
    }
    for (var a = 0; a < pos.length; a++) for (var b = 0; b < pos.length; b++) {
      var r = pos[a], c = pos[b];
      if (inFinder(r, c)) continue; // overlaps a finder pattern → omit
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        var ring = Math.max(Math.abs(dr), Math.abs(dc));
        setF(M, r + dr, c + dc, ring !== 1);
      }
    }
  }
  function reserveFormat(M) {
    var size = M.size;
    for (var i = 0; i < 9; i++) { if (!M.used[8][i]) M.used[8][i] = true; if (!M.used[i][8]) M.used[i][8] = true; }
    for (i = 0; i < 8; i++) { M.used[size - 1 - i][8] = true; M.used[8][size - 1 - i] = true; }
    setF(M, size - 8, 8, true); // dark module
  }
  function placeFunctionPatterns(M, version) {
    var size = M.size;
    placeFinder(M, 0, 0); placeFinder(M, 0, size - 7); placeFinder(M, size - 7, 0);
    // timing
    for (var i = 8; i < size - 8; i++) { if (!M.used[6][i]) setF(M, 6, i, i % 2 === 0); if (!M.used[i][6]) setF(M, i, 6, i % 2 === 0); }
    placeAlignment(M, version);
    reserveFormat(M);
  }

  function placeData(M, codewords) {
    var size = M.size, bitIdx = 0, total = codewords.length * 8;
    function bitAt(i) { return (codewords[i >> 3] >> (7 - (i & 7))) & 1; }
    var col = size - 1, upward = true;
    while (col > 0) {
      if (col === 6) col--; // skip vertical timing column
      for (var k = 0; k < size; k++) {
        var row = upward ? size - 1 - k : k;
        for (var c2 = 0; c2 < 2; c2++) {
          var cc = col - c2;
          if (M.used[row][cc]) continue;
          var dark = bitIdx < total ? bitAt(bitIdx) === 1 : false; // remainder bits = 0
          M.m[row][cc] = dark; M.used[row][cc] = true; bitIdx++;
        }
      }
      col -= 2; upward = !upward;
    }
  }

  function maskFn(n, r, c) {
    switch (n) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return (r * c) % 2 + (r * c) % 3 === 0;
      case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      case 7: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    }
    return false;
  }

  // BCH-encoded 15-bit format info for ECC level L + mask n.
  function formatBits(mask) {
    var ecBits = 0b01; // level L
    var data = (ecBits << 3) | mask;        // 5 bits
    var rem = data << 10;
    var g = 0b10100110111;
    for (var i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= g << (i - 10);
    var bits = ((data << 10) | rem) ^ 0b101010000010010;
    return bits; // 15 bits, MSB first = bit14..bit0
  }
  function placeFormat(M, mask) {
    var size = M.size, bits = formatBits(mask);
    function bit(i) { return (bits >> i) & 1; } // i=0 is LSB
    // top-left: horizontal (row 8) and vertical (col 8)
    var positions1 = [ // [r,c] for bits 14..0 around top-left
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
    ];
    for (var i = 0; i < 15; i++) { var p = positions1[i]; M.m[p[0]][p[1]] = bit(14 - i) === 1; M.used[p[0]][p[1]] = true; }
    // split copy: around top-right and bottom-left
    for (i = 0; i < 8; i++) { M.m[8][size - 1 - i] = bit(i) === 1; M.used[8][size - 1 - i] = true; }
    for (i = 0; i < 7; i++) { M.m[size - 7 + i][8] = bit(14 - i) === 1; M.used[size - 7 + i][8] = true; }
  }

  function penalty(m) {
    var n = m.length, score = 0, r, c, i;
    // rule 1: runs of 5+ same colour
    for (r = 0; r < n; r++) {
      var runC = 1, runR = 1;
      for (c = 1; c < n; c++) {
        if (m[r][c] === m[r][c - 1]) { runC++; if (runC === 5) score += 3; else if (runC > 5) score++; } else runC = 1;
        if (m[c][r] === m[c - 1][r]) { runR++; if (runR === 5) score += 3; else if (runR > 5) score++; } else runR = 1;
      }
    }
    // rule 2: 2x2 blocks
    for (r = 0; r < n - 1; r++) for (c = 0; c < n - 1; c++)
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    // rule 3: finder-like patterns 1:1:3:1:1 with 4 light
    var pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    var pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    function match(arr, off, pat) { for (var k = 0; k < 11; k++) if (arr[off + k] !== pat[k]) return false; return true; }
    for (r = 0; r < n; r++) for (c = 0; c <= n - 11; c++) {
      var rowArr = m[r], colArr = [];
      if (match(rowArr, c, pat1) || match(rowArr, c, pat2)) score += 40;
    }
    for (c = 0; c < n; c++) for (r = 0; r <= n - 11; r++) {
      var ca = []; for (i = 0; i < 11; i++) ca.push(m[r + i][c]);
      if (match(ca, 0, pat1) || match(ca, 0, pat2)) score += 40;
    }
    // rule 4: dark proportion
    var dark = 0; for (r = 0; r < n; r++) for (c = 0; c < n; c++) if (m[r][c]) dark++;
    var pct = dark * 100 / (n * n);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function build(version, codewords) {
    var size = 17 + 4 * version;
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var M = makeMatrix(size);
      placeFunctionPatterns(M, version);
      placeData(M, codewords);
      // apply mask to data modules only (function modules already placed & used
      // before data — but used[] is true for them, so mask only data). We mask by
      // recomputing on a copy where we know which are data: rebuild used map.
      var fM = makeMatrix(size); placeFunctionPatterns(fM, version);
      for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) {
        if (!fM.used[r][c] && maskFn(mask, r, c)) M.m[r][c] = !M.m[r][c];
      }
      placeFormat(M, mask);
      var sc = penalty(M.m);
      if (sc < bestScore) { bestScore = sc; best = M.m; }
    }
    return best;
  }

  function encode(text) {
    var bytes = toBytes(String(text == null ? '' : text));
    var version = chooseVersion(bytes.length);
    if (!version) return null; // too long
    var dataCw = buildCodewords(bytes, version);
    var codewords = interleave(dataCw, version);
    var modules = build(version, codewords);
    return { version: version, size: modules.length, modules: modules };
  }

  // Render a QR result to an SVG string (with quiet zone). `px` = module size.
  function toSVG(qr, px, opts) {
    opts = opts || {};
    var quiet = opts.quiet == null ? 4 : opts.quiet;
    var n = qr.size, dim = (n + quiet * 2) * px;
    var dark = opts.dark || '#000', light = opts.light || '#fff';
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
      '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">';
    s += '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>';
    s += '<path fill="' + dark + '" d="';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.modules[r][c]) {
      var x = (c + quiet) * px, y = (r + quiet) * px;
      s += 'M' + x + ' ' + y + 'h' + px + 'v' + px + 'h' + (-px) + 'z';
    }
    s += '"/></svg>';
    return s;
  }

  return { encode: encode, toSVG: toSVG };
});
