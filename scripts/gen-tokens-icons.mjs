#!/usr/bin/env node
/**
 * Generates the Tokens app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as tokens/icon.svg: a
 * radial-dark rounded square holding a gradient token coin with an inner
 * ring, three tick lines streaming off it getting shorter (the meter
 * counting down), and the gold spark of the last token.
 *
 * Run: node scripts/gen-tokens-icons.mjs   (writes icon-180/192/512.png into tokens/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tokens');

/* ---- minimal PNG (RGBA, no palette) ---- */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(N, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---- helpers ---- */
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// the brand gradient: cyan → violet → gold, along x+y
function brandColor(t) {
  t = clamp(t, 0, 1);
  const stops = [[0x4d, 0xd8, 0xff], [0x8f, 0x7c, 0xf7], [0xe8, 0xb3, 0x4c]];
  const seg = t < 0.55 ? 0 : 1;
  const lt = seg === 0 ? t / 0.55 : (t - 0.55) / 0.45;
  return [0, 1, 2].map((i) => Math.round(lerp(stops[seg][i], stops[seg + 1][i], lt)));
}
// distance from a point to a segment (capsules are segment + radius)
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}
// distance to a 4-point sparkle (union of two thin diamonds)
function sparkDist(px, py, cx, cy, r, w) {
  const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
  const d1 = dx / w + dy / r - 1;   // tall diamond
  const d2 = dx / r + dy / w - 1;   // wide diamond
  return Math.min(d1, d2) * Math.min(w, r) * 0.7; // approx px distance
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 116 * S;
  const aa = 1.0; // anti-alias feather in px

  // coin + rings (from icon.svg geometry)
  const coinX = 196 * S, coinY = 256 * S;
  const ringR = 108 * S, ringW = 20 * S;
  const innerR = 56 * S, innerW = 12 * S;
  // the meter lines: [ax, ay, bx, by, color|null(=violet), opacity]
  const LINES = [
    [342, 196, 426, 196, [0x4d, 0xd8, 0xff], 1.0],
    [342, 256, 402, 256, null, 0.85],
    [342, 316, 378, 316, null, 0.5],
  ];
  const lineW = 8 * S;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square mask
      const qx = Math.abs(x - N / 2) - (N / 2 - corner);
      const qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // radial-dark background (light falls from the upper middle)
      const dTop = Math.hypot(x - N * 0.5, y - N * 0.18) / (N * 0.9);
      let r = Math.round(lerp(0x16, 0x0a, clamp(dTop, 0, 1)));
      let g = Math.round(lerp(0x20, 0x0d, clamp(dTop, 0, 1)));
      let b = Math.round(lerp(0x3d, 0x16, clamp(dTop, 0, 1)));

      const grad = clamp((x + y) / (2 * N), 0, 1);
      const [br, bg, bb] = brandColor(grad);

      // the token coin: outer ring, then the fainter inner ring
      const dCoin = Math.hypot(x - coinX, y - coinY);
      const aRing = clamp(0.5 - (Math.abs(dCoin - ringR) - ringW / 2) / aa, 0, 1);
      if (aRing > 0) { r = Math.round(lerp(r, br, aRing)); g = Math.round(lerp(g, bg, aRing)); b = Math.round(lerp(b, bb, aRing)); }
      const aInner = clamp(0.5 - (Math.abs(dCoin - innerR) - innerW / 2) / aa, 0, 1) * 0.55;
      if (aInner > 0) { r = Math.round(lerp(r, br, aInner)); g = Math.round(lerp(g, bg, aInner)); b = Math.round(lerp(b, bb, aInner)); }

      // the meter lines counting down
      for (const [ax, ay, bx2, by2, col, op] of LINES) {
        const d = capsuleDist(x, y, ax * S, ay * S, bx2 * S, by2 * S) - lineW;
        const a = clamp(0.5 - d / aa, 0, 1) * op;
        if (a > 0) {
          const [lr, lg, lb] = col || [0x8f, 0x7c, 0xf7];
          r = Math.round(lerp(r, lr, a)); g = Math.round(lerp(g, lg, a)); b = Math.round(lerp(b, lb, a));
        }
      }

      // the gold spark: the last token
      const dS = sparkDist(x, y, 424 * S, 400 * S, 44 * S, 13 * S);
      const aS = clamp(0.5 - dS / aa, 0, 1);
      if (aS > 0) { r = Math.round(lerp(r, 0xe8, aS)); g = Math.round(lerp(g, 0xb3, aS)); b = Math.round(lerp(b, 0x4c, aS)); }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`tokens/icon-${n}.png`);
}
