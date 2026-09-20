#!/usr/bin/env node
/**
 * Generates the Rumble app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as rumble/icon.svg: a
 * radial-dark rounded square, a gold and a crimson round bar (the health
 * bars), two original fighter wedges lunging at each other with gold
 * glove dots, and the clash spark between them.
 *
 * Run: node scripts/gen-rumble-icons.mjs   (writes icon-180/192/512.png into rumble/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'rumble');

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
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}
// distance to a filled convex quad (0 inside, else nearest edge)
function quadDist(px, py, pts) {
  let inside = true, sign = 0, best = Infinity;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (i === 0) sign = Math.sign(cross) || 1;
    else if (Math.sign(cross) !== sign && cross !== 0) inside = false;
    if (cross === 0 && i > 0) { /* colinear edge — fine */ }
    best = Math.min(best, capsuleDist(px, py, ax, ay, bx, by));
  }
  return inside ? 0 : best;
}
// distance to a 4-point sparkle (union of two thin diamonds)
function sparkDist(px, py, cx, cy, r, w) {
  const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
  const d1 = dx / w + dy / r - 1;
  const d2 = dx / r + dy / w - 1;
  return Math.min(d1, d2) * Math.min(w, r) * 0.7;
}

const TEAL = [0x19, 0xc8, 0xb4], CRIMSON = [0xd9, 0x4a, 0x5e];
const GOLD = [0xff, 0xe2, 0x5e], SPARKC = [0xff, 0xf6, 0xd8];

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 116 * S;
  const aa = 1.0;

  // geometry from icon.svg
  const leftBody = [[96, 400], [176, 208], [226, 260], [186, 400]].map(([x, y]) => [x * S, y * S]);
  const rightBody = [[416, 400], [336, 208], [286, 260], [326, 400]].map(([x, y]) => [x * S, y * S]);

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
      const dTop = Math.hypot(x - N * 0.5, y - N * 0.22) / (N * 0.9);
      let r = Math.round(lerp(0x1b, 0x0a, clamp(dTop, 0, 1)));
      let g = Math.round(lerp(0x20, 0x0c, clamp(dTop, 0, 1)));
      let b = Math.round(lerp(0x38, 0x16, clamp(dTop, 0, 1)));

      const paint = (d, col, op = 1) => {
        const a = clamp(0.5 - d / aa, 0, 1) * op;
        if (a > 0) { r = Math.round(lerp(r, col[0], a)); g = Math.round(lerp(g, col[1], a)); b = Math.round(lerp(b, col[2], a)); }
      };

      // health bars (rounded capsules)
      paint(capsuleDist(x, y, 87 * S, 107 * S, 215 * S, 107 * S) - 11 * S, GOLD);
      paint(capsuleDist(x, y, 297 * S, 107 * S, 425 * S, 107 * S) - 11 * S, CRIMSON);

      // fighter bodies
      paint(quadDist(x, y, leftBody), TEAL);
      paint(quadDist(x, y, rightBody), CRIMSON);
      // heads
      paint(Math.hypot(x - 185 * S, y - 185 * S) - 34 * S, TEAL);
      paint(Math.hypot(x - 327 * S, y - 185 * S) - 34 * S, CRIMSON);
      // gloves
      paint(Math.hypot(x - 245 * S, y - 252 * S) - 26 * S, GOLD);
      paint(Math.hypot(x - 267 * S, y - 252 * S) - 26 * S, GOLD);

      // the clash spark
      paint(sparkDist(x, y, 256 * S, 252 * S, 56 * S, 13 * S), SPARKC);

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`rumble/icon-${n}.png`);
}
