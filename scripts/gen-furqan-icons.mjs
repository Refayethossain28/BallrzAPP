#!/usr/bin/env node
/**
 * Generates the Furqan app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as furqan/icon.svg: a
 * radial-dark rounded square holding an open book — two cream pages dipping
 * toward a darker fold, three gold lines of text on each — with a small gold
 * rub el hizb (a square over a 45° square, dark dot in the middle) floating
 * above it: the verse on the page, and the ornament that marks where it is.
 * Writes icon-180/192/512.png into furqan/.
 *
 * Run: node scripts/gen-furqan-icons.mjs
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'furqan');

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
// the gold: #d9a441 at the book's bottom-left corner → #f0c75e past its top-right
// (the same user-space gradient the SVG uses for the text lines and the star)
function goldColor(xd, yd) {
  const t = clamp(((xd - 98) * 316 + (yd - 408) * -314) / (316 * 316 + 314 * 314), 0, 1);
  return [Math.round(lerp(0xd9, 0xf0, t)), Math.round(lerp(0xa4, 0xc7, t)), Math.round(lerp(0x41, 0x5e, t))];
}
// paper #f5efe1, shading toward the fold over the inner 60 units of each page
function paperColor(s) {
  return [Math.round(lerp(0xf5, 0xeb, s)), Math.round(lerp(0xef, 0xe2, s)), Math.round(lerp(0xe1, 0xcd, s))];
}
// distance to a capsule (segment with radius handled by caller)
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}
// signed distance to a rounded-rect border (negative inside)
function roundRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// signed distance to a convex polygon (negative inside), points as [x, y]
function convexPolyDist(px, py, pts) {
  let pos = false, neg = false, d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const s = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (s > 0) pos = true; else if (s < 0) neg = true;
    d = Math.min(d, capsuleDist(px, py, ax, ay, bx, by));
  }
  return pos && neg ? d : -d;
}
// signed distance to an axis-aligned square of half-side a, centred on the origin
function boxDist(dx, dy, a) {
  const qx = Math.abs(dx) - a, qy = Math.abs(dy) - a;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}
// the rub el hizb: a square over the same square turned 45°, with a hole of radius h cut out
function rubDist(px, py, cx, cy, a, h) {
  const dx = px - cx, dy = py - cy;
  const u = (dx + dy) * Math.SQRT1_2, v = (dy - dx) * Math.SQRT1_2;
  return Math.max(Math.min(boxDist(dx, dy, a), boxDist(u, v, a)), h - Math.hypot(dx, dy));
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 116 * S;
  const aa = 1.0; // anti-alias feather in px

  // the pages (from icon.svg geometry: the path points, grown by the 12-wide round-joined stroke)
  const PAGE_L = [[104, 214], [244, 238], [244, 402], [104, 378]].map(([x, y]) => [x * S, y * S]);
  const PAGE_R = [[408, 214], [268, 238], [268, 402], [408, 378]].map(([x, y]) => [x * S, y * S]);
  const pageGrow = 6 * S;
  // three lines of text on each page
  const LINES = [
    [134, 270, 220, 270], [134, 308, 220, 308], [134, 346, 194, 346],
    [292, 270, 378, 270], [292, 308, 378, 308], [318, 346, 378, 346],
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
      const paint = ([cr, cg, cb], a) => { r = Math.round(lerp(r, cr, a)); g = Math.round(lerp(g, cg, a)); b = Math.round(lerp(b, cb, a)); };
      const xd = x / S; // back to design units, for the gradients

      // the fold, under the pages
      const dFold = roundRectDist(x, y, 256 * S, 320 * S, 10 * S, 88 * S, 0);
      const aFold = clamp(0.5 - dFold / aa, 0, 1);
      if (aFold > 0) paint([0xe3, 0xd9, 0xc3], aFold);

      // the two pages, shaded toward the fold
      const dL = convexPolyDist(x, y, PAGE_L) - pageGrow;
      const aL = clamp(0.5 - dL / aa, 0, 1);
      if (aL > 0) paint(paperColor(clamp((xd - 190) / 60, 0, 1)), aL);
      const dR = convexPolyDist(x, y, PAGE_R) - pageGrow;
      const aR = clamp(0.5 - dR / aa, 0, 1);
      if (aR > 0) paint(paperColor(clamp((322 - xd) / 60, 0, 1)), aR);

      // the lines of text
      for (const [ax, ay, bx2, by2] of LINES) {
        const d = capsuleDist(x, y, ax * S, ay * S, bx2 * S, by2 * S) - lineW;
        const a = clamp(0.5 - d / aa, 0, 1);
        if (a > 0) paint(goldColor(xd, y / S), a);
      }

      // the rub el hizb above the book
      const dStar = rubDist(x, y, 256 * S, 134 * S, 28 * S, 8 * S);
      const aStar = clamp(0.5 - dStar / aa, 0, 1);
      if (aStar > 0) paint(goldColor(xd, y / S), aStar);

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`furqan/icon-${n}.png`);
}
