#!/usr/bin/env node
/**
 * Tests for beam/qr.js — the from-scratch QR encoder that is Beam's "radio".
 * The strongest possible check: every matrix is rendered to pixels and decoded
 * by an INDEPENDENT decoder (jsQR), at every version 1–40 and every EC level.
 * If the Reed–Solomon maths, block interleaving, alignment grid, masking or
 * format/version bits were wrong anywhere, the round-trip would fail. The
 * spec tables (capacities, alignment rows, BCH vectors) are asserted against
 * the published ISO 18004 numbers as well, so a wrong table that happens to be
 * self-consistent cannot hide behind a lenient decoder.
 * Run: node scripts/test-beam-qr.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'beam', 'qr.js'), 'utf8'), sandbox, { filename: 'beam/qr.js' });
const QR = sandbox.module.exports;

/* jsQR 1.4.0 ships one typo in its version table: v23's alignment centres read
 * [6, 30, 54, 74, 102] where ISO 18004 (and every other decoder) has 78. It only
 * bites at level L — the misplaced function mask garbles more codewords than 9
 * blocks × 15 corrections can absorb — so stock jsQR cannot read a correct v23-L
 * symbol from ANY encoder. For that one cell we decode with a copy of the same
 * jsQR source with that single token fixed. Everything else uses stock jsQR, and
 * a test below asserts the typo is still there so the workaround retires itself. */
const JSQR_SRC_PATH = createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js');
const JSQR_SRC = readFileSync(JSQR_SRC_PATH, 'utf8');
const JSQR_V23_TYPO = 'alignmentPatternCenters: [6, 30, 54, 74, 102]';
const jsQRv23 = (() => {
  if (!JSQR_SRC.includes(JSQR_V23_TYPO)) return jsQR;                 // upstream fixed it → no patch needed
  const sb = { module: { exports: {} } }; sb.self = sb; vm.createContext(sb);
  vm.runInContext(JSQR_SRC.replace(JSQR_V23_TYPO, 'alignmentPatternCenters: [6, 30, 54, 78, 102]'), sb, { filename: 'jsQR-v23-patched.js' });
  return typeof sb.jsQR === 'function' ? sb.jsQR : sb.jsQR.default;
})();

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/** Render a module matrix to RGBA pixels (scale 4, quiet zone 4 modules) — same as test-voyager-qr.mjs. */
function rasterize(code) {
  const scale = 4, quiet = 4;
  const px = (code.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let r = 0; r < code.size; r++) {
    for (let c = 0; c < code.size; c++) {
      if (!code.modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const y = (r + quiet) * scale + dy, x = (c + quiet) * scale + dx;
          const i = (y * px + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: px, height: px };
}

function decode(code, decoder) {
  const img = rasterize(code);
  return (decoder || (code.version === 23 ? jsQRv23 : jsQR))(img.data, img.width, img.height);
}

function roundTrip(text, opts) {
  const code = QR.encode(text, opts);
  const decoded = decode(code);
  assert.ok(decoded, `decoder found no QR (v${code.version} ${code.ec} ${code.mode}, mask ${code.mask})`);
  assert.equal(decoded.data, text, `round-trip mismatch at v${code.version} ${code.ec} ${code.mode}, mask ${code.mask}`);
  return code;
}

/** Deterministic pseudo-text of exactly `n` chars from an alphabet (no clock, no Math.random). */
function fill(alphabet, n, seed) {
  let x = (seed * 2654435761 + 12345) >>> 0, out = '';
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out += alphabet[x % alphabet.length];
  }
  return out;
}
const DIGITS = '0123456789';

/* ---- spec tables ---- */

test('BCH vectors match the published spec values', () => {
  assert.equal(QR.formatBits('L', 0), 0x77c4);        // EC L, mask 0 → 111011111000100
  assert.equal(QR.formatBits('M', 0), 0x5412);        // all-zero data → just the XOR mask
  assert.equal(QR.formatBits('H', 7), 0x083b);        // EC H, mask 7 → 000100000111011
  assert.equal(QR.versionBits(7), 0x07c94);           // version 7 → 000111110010010100
  assert.equal(QR.versionBits(40), 0x28c69);          // version 40 → 101000110001101001
  assert.throws(() => QR.formatBits('X', 0));
  assert.throws(() => QR.formatBits('L', 8));
  assert.throws(() => QR.versionBits(41));
});

test('data codeword counts match ISO 18004 Table 7', () => {
  assert.equal(QR.dataCodewords(1, 'L'), 19);
  assert.equal(QR.dataCodewords(1, 'H'), 9);
  assert.equal(QR.dataCodewords(10, 'L'), 274);
  assert.equal(QR.dataCodewords(10, 'H'), 122);
  assert.equal(QR.dataCodewords(27, 'Q'), 808);
  assert.equal(QR.dataCodewords(23, 'L'), 1094);
  assert.equal(QR.dataCodewords(40, 'L'), 2956);
  assert.equal(QR.dataCodewords(40, 'M'), 2334);
  assert.equal(QR.dataCodewords(40, 'Q'), 1666);
  assert.equal(QR.dataCodewords(40, 'H'), 1276);
  assert.equal(QR.totalCodewords(40), 3706);
  // every (version, level) is consistent: data + ecc·blocks = total, all positive
  for (let v = 1; v <= 40; v++) for (const ec of 'LMQH') assert.ok(QR.dataCodewords(v, ec) > 0 && QR.dataCodewords(v, ec) < QR.totalCodewords(v));
});

test('capacity spot-checks from the spec (§2)', () => {
  assert.equal(QR.capacity(1, 'L', 'byte'), 17);
  assert.equal(QR.capacity(10, 'L', 'byte'), 271);
  assert.equal(QR.capacity(20, 'L', 'byte'), 858);
  assert.equal(QR.capacity(30, 'L', 'byte'), 1732);
  assert.equal(QR.capacity(40, 'L', 'byte'), 2953);
  assert.equal(QR.capacity(40, 'H', 'byte'), 1273);
  assert.equal(QR.capacity(10, 'L', 'alnum'), 395);
  assert.equal(QR.capacity(15, 'L', 'alnum'), 758);
  assert.equal(QR.capacity(20, 'L', 'alnum'), 1249);
  assert.equal(QR.capacity(25, 'L', 'alnum'), 1853);
  assert.equal(QR.capacity(30, 'L', 'alnum'), 2520);
  assert.equal(QR.capacity(40, 'L', 'alnum'), 4296);
  assert.equal(QR.capacity(1, 'H', 'alnum'), 10);
  assert.equal(QR.capacity(40, 'L', 'numeric'), 7089);
  assert.equal(QR.capacity(1, 'L', 'numeric'), 41);
  // monotone in version, decreasing in EC strength
  for (const mode of ['numeric', 'alnum', 'byte']) {
    for (let v = 2; v <= 40; v++) assert.ok(QR.capacity(v, 'L', mode) > QR.capacity(v - 1, 'L', mode), `${mode} v${v} not growing`);
    for (let v = 1; v <= 40; v++) assert.ok(QR.capacity(v, 'L', mode) > QR.capacity(v, 'M', mode) && QR.capacity(v, 'M', mode) > QR.capacity(v, 'Q', mode) && QR.capacity(v, 'Q', mode) > QR.capacity(v, 'H', mode));
  }
});

test('capacity / dataCodewords throw on bad arguments', () => {
  assert.throws(() => QR.capacity(0, 'L', 'byte'), /version/);
  assert.throws(() => QR.capacity(41, 'L', 'byte'), /version/);
  assert.throws(() => QR.capacity(2.5, 'L', 'byte'), /version/);
  assert.throws(() => QR.capacity('10', 'L', 'byte'), /version/);
  assert.throws(() => QR.capacity(1, 'X', 'byte'), /ec/);
  assert.throws(() => QR.capacity(1, 'l', 'byte'), /ec/);
  assert.throws(() => QR.capacity(1, 'L', 'kanji'), /mode/);
  assert.throws(() => QR.dataCodewords(1, 'Z'), /ec/);
});

test('alignment pattern positions match the known rows and the spec formula', () => {
  deepEq(QR.alignmentPositions(1), []);
  deepEq(QR.alignmentPositions(2), [6, 18]);
  deepEq(QR.alignmentPositions(7), [6, 22, 38]);
  deepEq(QR.alignmentPositions(14), [6, 26, 46, 66]);
  deepEq(QR.alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  deepEq(QR.alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
  for (let v = 2; v <= 40; v++) {
    const p = QR.alignmentPositions(v), size = 17 + 4 * v;
    assert.equal(p.length, Math.floor(v / 7) + 2, `v${v} count`);
    assert.equal(p[0], 6); assert.equal(p[p.length - 1], size - 7);
    // the spec lets the FIRST gap be shorter (v15: 6, 26, 48, 70); every later gap is the even step
    for (let i = 3; i < p.length; i++) assert.equal(p[i] - p[i - 1], p[2] - p[1], `v${v} uneven spacing`);
    if (v !== 32) assert.ok(p[1] - p[0] <= p[p.length - 1] - p[p.length - 2], `v${v} first gap too wide`);   // v32 is the spec's hard-coded exception (step 26, first gap 28)
    assert.equal((p[p.length - 1] - p[p.length - 2]) % 2, 0, `v${v} odd step`);
  }
  deepEq(QR.alignmentPositions(15), [6, 26, 48, 70]);
  deepEq(QR.alignmentPositions(23), [6, 30, 54, 78, 102]);
});

test('block structure agrees with jsQR\'s own version table for all 40 versions × 4 levels', () => {
  // parse the decoder's table straight out of its source: an independent copy of ISO 18004 Table 9
  const re = /versionNumber: (\d+),[\s\S]*?errorCorrectionLevels: \[([\s\S]*?)\n {8}\],/g;
  let m, cells = 0;
  while ((m = re.exec(JSQR_SRC))) {
    const v = +m[1];
    const levels = [...m[2].matchAll(/ecCodewordsPerBlock: (\d+),\s*ecBlocks: \[([\s\S]*?)\]/g)];
    assert.equal(levels.length, 4, `jsQR v${v} levels`);
    levels.forEach((lv, i) => {
      const ec = 'LMQH'[i], ecc = +lv[1];
      const blocks = [...lv[2].matchAll(/numBlocks: (\d+), dataCodewordsPerBlock: (\d+)/g)].map((b) => [+b[1], +b[2]]);
      const nBlocks = blocks.reduce((s, b) => s + b[0], 0), data = blocks.reduce((s, b) => s + b[0] * b[1], 0);
      assert.equal(QR.dataCodewords(v, ec), data, `v${v}${ec} data codewords`);
      assert.equal(QR.totalCodewords(v), data + nBlocks * ecc, `v${v}${ec} total codewords`);
      // the ecc-per-block and block-count cells themselves: the ecc bytes a one-block encode emits must be `ecc` long
      assert.equal(QR.rsEncode(new Uint8Array(blocks[0][1]), ecc).length, ecc);
      cells++;
    });
  }
  assert.equal(cells, 160);
});

test('jsQR 1.4.0 v23 alignment typo: documented, narrowly worked around, self-retiring', () => {
  const m = /versionNumber: 23,\s*alignmentPatternCenters: \[([^\]]*)\]/.exec(JSQR_SRC);
  const theirs = m[1].split(',').map((x) => +x.trim());
  if (jsQRv23 !== jsQR) {
    deepEq(theirs, [6, 30, 54, 74, 102], 'jsQR table changed — re-check whether the v23 workaround is still needed');
  } else {
    deepEq(theirs, [6, 30, 54, 78, 102]);
  }
  // every other version's alignment row agrees with jsQR's table (v1 is its [0] placeholder for none)
  const re = /versionNumber: (\d+),\s*alignmentPatternCenters: \[([^\]]*)\]/g;
  let row, rows = 0;
  while ((row = re.exec(JSQR_SRC))) {
    const v = +row[1]; if (v === 23 && jsQRv23 !== jsQR) { rows++; continue; }
    deepEq(v === 1 ? [] : row[2].split(',').map((x) => +x.trim()), QR.alignmentPositions(v), `v${v} alignment row`);
    rows++;
  }
  assert.equal(rows, 40);
  // the stronger levels at v23 survive the typo with STOCK jsQR — the workaround is only ever used for the L cell
  for (const ec of ['M', 'Q', 'H']) {
    const text = fill(QR.ALNUM, QR.capacity(23, ec, 'alnum'), 2300 + ec.charCodeAt(0));
    const code = QR.encode(text, { version: 23, ec });
    const dec = decode(code, jsQR);
    assert.ok(dec && dec.data === text, `stock jsQR could not read v23 ${ec}`);
  }
});

test('Reed–Solomon: the textbook v1-M "HELLO WORLD" block yields the published ECC', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  deepEq(Array.from(QR.rsEncode(data, 10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  assert.equal(QR.rsEncode(new Uint8Array(50), 30).length, 30);
  deepEq(Array.from(QR.rsEncode([0, 0, 0], 7)), [0, 0, 0, 0, 0, 0, 0]);   // zero data → zero remainder
  assert.throws(() => QR.rsEncode([1], 0));
});

/* ---- round-trips through the independent decoder ---- */

test('every version 1–40 at L: alphanumeric text at exact capacity round-trips, picking that version', () => {
  for (let v = 1; v <= 40; v++) {
    const cap = QR.capacity(v, 'L', 'alnum');
    const text = fill(QR.ALNUM, cap, v);
    const code = roundTrip(text, { ec: 'L' });
    assert.equal(code.version, v, `expected auto version ${v}, got ${code.version}`);
    assert.equal(code.mode, 'alnum');
    assert.equal(code.ec, 'L');
    assert.equal(code.size, 17 + 4 * v);
  }
});

test('versions 1,5,7,10,14,21,27,33,40 at M/Q/H round-trip at exact capacity', () => {
  for (const v of [1, 5, 7, 10, 14, 21, 27, 33, 40]) {
    for (const ec of ['M', 'Q', 'H']) {
      const cap = QR.capacity(v, ec, 'alnum');
      const code = roundTrip(fill(QR.ALNUM, cap, v * 10 + ec.charCodeAt(0)), { ec, version: v });
      assert.equal(code.version, v); assert.equal(code.ec, ec);
    }
  }
});

test('numeric mode: auto-detected, all three remainder lengths, small and large', () => {
  const c1 = roundTrip('41', {});                              // 2-digit remainder (7 bits)
  assert.equal(c1.mode, 'numeric'); assert.equal(c1.version, 1);
  assert.equal(roundTrip('7', {}).mode, 'numeric');            // 1-digit remainder (4 bits)
  assert.equal(roundTrip('123456', {}).mode, 'numeric');       // whole groups only
  assert.equal(roundTrip(fill(DIGITS, 41, 1)).version, 1);     // v1 L exact numeric capacity
  assert.equal(roundTrip('0000000000000000000').mode, 'numeric'); // leading zeros survive
  const big = roundTrip(fill(DIGITS, QR.capacity(27, 'L', 'numeric'), 27), { ec: 'L' });
  assert.equal(big.version, 27);                               // 14-bit count field
  const mid = roundTrip(fill(DIGITS, 1000, 3), { ec: 'Q' });
  assert.ok(mid.version >= 10 && mid.version < 27);            // 12-bit count field
});

test('byte mode: UTF-8 (accents, emoji, CJK) and the full 8-bit range round-trip', () => {
  assert.equal(roundTrip('https://example.com/café?q=🧭 beam').mode, 'byte');
  roundTrip('日本語テキスト 🚀📡✨', { ec: 'Q' });
  roundTrip('lowercase forces byte mode', {});
  roundTrip('x'.repeat(QR.capacity(9, 'L', 'byte')), { ec: 'L' });                 // 8-bit count at v9
  assert.equal(roundTrip('y'.repeat(QR.capacity(10, 'L', 'byte')), { ec: 'L' }).version, 10); // 16-bit count
  assert.equal(roundTrip('z'.repeat(QR.capacity(40, 'H', 'byte')), { ec: 'H' }).version, 40);
});

test('fixed version option: short text in a big symbol, exact size, still decodes', () => {
  const code = roundTrip('B1', { version: 12 });
  assert.equal(code.version, 12); assert.equal(code.size, 65);
  const c30 = roundTrip('HELLO', { version: 30, ec: 'M' });
  assert.equal(c30.size, 137);
  assert.throws(() => QR.encode('x', { version: 0 }), /version/);
  assert.throws(() => QR.encode('x', { version: 41 }), /version/);
});

test('minVersion / maxVersion bound the automatic choice', () => {
  assert.equal(QR.encode('HI', { minVersion: 5 }).version, 5);
  assert.equal(QR.encode(fill(QR.ALNUM, 300, 9), { maxVersion: 9 }).version, 9);
  assert.throws(() => QR.encode(fill(QR.ALNUM, 400, 9), { maxVersion: 9 }), /too long/);
  assert.throws(() => QR.encode('x', { minVersion: 9, maxVersion: 3 }), /minVersion/);
});

test('forced mask 0..7: every pattern decodes and is reported', () => {
  const text = 'B1' + fill(QR.ALNUM, 300, 77);
  for (let mask = 0; mask < 8; mask++) {
    const code = roundTrip(text, { mask, version: 10 });
    assert.equal(code.mask, mask);
  }
  for (let mask = 0; mask < 8; mask++) assert.equal(roundTrip('MASK' + mask, { mask }).mask, mask);
  assert.throws(() => QR.encode('x', { mask: 8 }), /mask/);
  assert.throws(() => QR.encode('x', { mask: -1 }), /mask/);
});

test('auto mask picks a pattern in 0..7 and different content can land on different masks', () => {
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const code = QR.encode(fill(QR.ALNUM, 60, 1000 + i), { version: 4 });
    assert.ok(code.mask >= 0 && code.mask <= 7);
    seen.add(code.mask);
  }
  assert.ok(seen.size > 1, 'penalty scoring never varied the mask');
});

test('forced mode: byte for digits, and impossible forcings throw', () => {
  const code = roundTrip('12345', { mode: 'byte' });
  assert.equal(code.mode, 'byte');
  assert.equal(roundTrip('12345', { mode: 'alnum' }).mode, 'alnum');
  assert.throws(() => QR.encode('12A', { mode: 'numeric' }), /numeric/);
  assert.throws(() => QR.encode('abc', { mode: 'alnum' }), /alnum/);
  assert.throws(() => QR.encode('abc', { mode: 'kanji' }), /mode/);
  assert.equal(QR.detectMode('123'), 'numeric');
  assert.equal(QR.detectMode('AB 1$'), 'alnum');
  assert.equal(QR.detectMode('ab'), 'byte');
});

test('exact capacity boundary at a fixed version: cap fits, cap+1 throws /too long/', () => {
  for (const [v, ec, mode, alphabet] of [[1, 'L', 'alnum', QR.ALNUM], [1, 'H', 'alnum', QR.ALNUM], [10, 'L', 'alnum', QR.ALNUM],
    [20, 'L', 'alnum', QR.ALNUM], [30, 'L', 'alnum', QR.ALNUM], [1, 'L', 'numeric', DIGITS], [40, 'L', 'numeric', DIGITS],
    [1, 'L', 'byte', 'x'], [9, 'L', 'byte', 'x'], [10, 'L', 'byte', 'x'], [26, 'M', 'byte', 'x'], [27, 'Q', 'byte', 'x'], [40, 'H', 'byte', 'x']]) {
    const cap = QR.capacity(v, ec, mode);
    const ok = QR.encode(fill(alphabet, cap, v), { version: v, ec, mode });
    assert.equal(ok.version, v);
    assert.throws(() => QR.encode(fill(alphabet, cap + 1, v), { version: v, ec, mode }), /too long/, `v${v} ${ec} ${mode} cap+1 did not throw`);
  }
});

test('beyond version 40: an honest throw, not a corrupt code', () => {
  assert.throws(() => QR.encode(fill(QR.ALNUM, 4297, 1)), /too long/);
  QR.encode(fill(QR.ALNUM, 4296, 1));                               // the boundary itself fits
  assert.throws(() => QR.encode(fill(DIGITS, 7090, 1)), /too long/);
  assert.throws(() => QR.encode('x'.repeat(2954)), /too long/);
  assert.throws(() => QR.encode('x'.repeat(1274), { ec: 'H' }), /too long/);
});

test('empty text encodes (v1) and the result is deterministic', () => {
  const a = QR.encode('', {}), b = QR.encode('', {});
  assert.equal(a.version, 1);
  deepEq(a, b);
  const c = QR.encode(fill(QR.ALNUM, 500, 5), { ec: 'M' }), d = QR.encode(fill(QR.ALNUM, 500, 5), { ec: 'M' });
  deepEq(c, d);
});

/* ---- structure ---- */

test('every emitted matrix is square with only booleans and the fixed function patterns in place', () => {
  for (const v of [1, 2, 7, 21, 40]) {
    const code = QR.encode('BEAM', { version: v });
    const m = code.modules, size = code.size;
    assert.equal(m.length, size);
    for (const row of m) { assert.equal(row.length, size); for (const cell of row) assert.equal(typeof cell, 'boolean'); }
    // finder corners
    for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      assert.equal(m[r0][c0], true); assert.equal(m[r0 + 3][c0 + 3], true); assert.equal(m[r0 + 1][c0 + 1], false);
    }
    assert.equal(m[size - 8][8], true, 'dark module');
    for (let t = 8; t < size - 8; t++) { assert.equal(m[6][t], t % 2 === 0, 'timing row'); assert.equal(m[t][6], t % 2 === 0, 'timing col'); }
    // alignment centres (those not under a finder) are dark with a light ring
    const p = QR.alignmentPositions(v);
    for (const r of p) for (const c of p) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      assert.equal(m[r][c], true); assert.equal(m[r - 1][c], false); assert.equal(m[r - 2][c - 2], true);
    }
  }
});

test('toSVG: one path for the dark modules, white background, quiet zone', () => {
  const code = QR.encode('SVG TEST', { version: 2 });
  const svg = QR.toSVG(code, 5);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('width="165" height="165"'));           // (25 + 8) × 5
  assert.ok(svg.includes('viewBox="0 0 33 33"'));
  assert.ok(svg.includes('fill="#fff"'));
  assert.equal((svg.match(/<path /g) || []).length, 1);
  let dark = 0; for (const row of code.modules) for (const c of row) if (c) dark++;
  assert.equal((svg.match(/M\d+ \d+h1v1h-1z/g) || []).length, dark);
  assert.ok(svg.includes('M4 4h1v1h-1z'), 'top-left finder module offset by the quiet zone');
  const tight = QR.toSVG(code, 2, 0);
  assert.ok(tight.includes('width="50" height="50"') && tight.includes('M0 0h1v1h-1z'));
});

test('ALNUM is the 45-character spec alphabet in spec order', () => {
  assert.equal(QR.ALNUM, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:');
  assert.equal(QR.ALNUM.length, 45);
  assert.equal(new Set(QR.ALNUM).size, 45);
});

/* ---- performance (the sender encodes one of these per frame) ---- */

test('timing: a v30 alnum frame with auto mask encodes in < 150 ms', () => {
  const text = fill(QR.ALNUM, QR.capacity(30, 'L', 'alnum'), 30);
  QR.encode(text, { version: 30, ec: 'L', mode: 'alnum' });    // warm-up
  const runs = 5; let best = Infinity, total = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    QR.encode(text, { version: 30, ec: 'L', mode: 'alnum' });
    const ms = performance.now() - t0;
    total += ms; if (ms < best) best = ms;
  }
  console.log(`    v30 alnum encode (auto mask): best ${best.toFixed(1)} ms, mean ${(total / runs).toFixed(1)} ms over ${runs} runs`);
  assert.ok(best < 150, `v30 encode took ${best.toFixed(1)} ms`);
});

/* ---- run ---- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n${err.message}\n`);
    process.exitCode = 1;
  }
}
console.log(`\nbeam qr: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
