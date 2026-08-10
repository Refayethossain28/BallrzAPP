#!/usr/bin/env node
/**
 * Generates the Magpie app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-seeker-icons.mjs). Rasterizes the same motif as magpie/icon.svg: a
 * radial-dark rounded square holding a gradient page card with data lines,
 * the magpie's beak plucking the top row, and the gold spark it flew off
 * with — the shiny thing.
 *
 * Run: node scripts/gen-magpie-icons.mjs   (writes icon-180/192/512.png into magpie/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'magpie');

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
// signed distance to a capsule (segment with radius handled by caller)
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
// distance to a filled triangle (0 inside, else distance to nearest edge)
function triDist(px, py, ax, ay, bx, by, cx2, cy2) {
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx2 - bx) * (py - by) - (cy2 - by) * (px - bx);
  const s3 = (ax - cx2) * (py - cy2) - (ay - cy2) * (px - cx2);
  const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  if (inside) return 0;
  return Math.min(capsuleDist(px, py, ax, ay, bx, by),
    capsuleDist(px, py, bx, by, cx2, cy2), capsuleDist(px, py, cx2, cy2, ax, ay));
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

  // page card + lines (from icon.svg geometry)
  const cardCx = 224 * S, cardCy = 262 * S, cardHw = 106 * S, cardHh = 134 * S, cardR = 22 * S, cardW = 18 * S;
  const LINES = [
    [156, 192, 292, 192, [0x4d, 0xd8, 0xff], 1.0],
    [156, 244, 268, 244, null, 0.9],
    [156, 296, 292, 296, null, 0.65],
    [156, 348, 240, 348, null, 0.4],
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

      // data lines inside the card
      for (const [ax, ay, bx2, by2, col, op] of LINES) {
        const d = capsuleDist(x, y, ax * S, ay * S, bx2 * S, by2 * S) - lineW;
        const a = clamp(0.5 - d / aa, 0, 1) * op;
        if (a > 0) {
          const [lr, lg, lb] = col || [0x8f, 0x7c, 0xf7];
          r = Math.round(lerp(r, lr, a)); g = Math.round(lerp(g, lg, a)); b = Math.round(lerp(b, lb, a));
        }
      }

      // the card border ring
      const dCard = Math.abs(roundRectDist(x, y, cardCx, cardCy, cardHw, cardHh, cardR)) - cardW / 2;
      const aCard = clamp(0.5 - dCard / aa, 0, 1);
      if (aCard > 0) { r = Math.round(lerp(r, br, aCard)); g = Math.round(lerp(g, bg, aCard)); b = Math.round(lerp(b, bb, aCard)); }

      // the beak, plucking the shiny row
      const dBeak = Math.min(
        triDist(x, y, 402 * S, 128 * S, 322 * S, 192 * S, 368 * S, 182 * S),
        triDist(x, y, 402 * S, 236 * S, 322 * S, 192 * S, 368 * S, 182 * S));
      const aBeak = clamp(0.5 - (dBeak - 0.5) / aa, 0, 1);
      if (aBeak > 0) { r = Math.round(lerp(r, br, aBeak)); g = Math.round(lerp(g, bg, aBeak)); b = Math.round(lerp(b, bb, aBeak)); }

      // the gold spark it flew off with
      const dS = sparkDist(x, y, 396 * S, 348 * S, 48 * S, 14 * S);
      const aS = clamp(0.5 - dS / aa, 0, 1);
      if (aS > 0) { r = Math.round(lerp(r, 0xe8, aS)); g = Math.round(lerp(g, 0xb3, aS)); b = Math.round(lerp(b, 0x4c, aS)); }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`magpie/icon-${n}.png`);
}
