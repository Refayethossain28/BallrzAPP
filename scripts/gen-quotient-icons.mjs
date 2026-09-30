#!/usr/bin/env node
/**
 * Generates the Quotient app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as quotient/icon.svg: a
 * radial-dark indigo rounded square holding a 3×3 matrix of pale cells with
 * the last one missing — replaced by the amber ring of the cell to find.
 *
 * Run: node scripts/gen-quotient-icons.mjs   (writes icon-180/192/512.png into quotient/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'quotient');

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
// signed distance to a rounded rect (negative inside)
function roundRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 64; // design space is the SVG's 64
  const corner = 14 * S;
  const aa = 1.0;
  // the eight known cells (SVG geometry), each 10×10 with rx 2.5
  const CELLS = [];
  for (const y of [13, 27, 41]) for (const x of [13, 27, 41]) if (!(x === 41 && y === 41)) CELLS.push([x + 5, y + 5]);
  const RING = [46 * S, 46 * S, 5.5 * S, 2.6 * S];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const rd = roundRectDist(x + 0.5, y + 0.5, N / 2, N / 2, N / 2, N / 2, corner);
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // radial-dark indigo (light falls from the upper middle)
      const d = clamp(Math.hypot(x - N * 0.5, y - N * 0.2) / (N * 0.9), 0, 1);
      let r = Math.round(lerp(0x2a, 0x12, d));
      let g = Math.round(lerp(0x2f, 0x14, d));
      let b = Math.round(lerp(0x6b, 0x2e, d));

      // pale cells
      for (const [cx, cy] of CELLS) {
        const dc = roundRectDist(x + 0.5, y + 0.5, cx * S, cy * S, 5 * S, 5 * S, 2.5 * S);
        const a = clamp(0.5 - dc / aa, 0, 1);
        if (a > 0) { r = Math.round(lerp(r, 0xe9, a)); g = Math.round(lerp(g, 0xec, a)); b = Math.round(lerp(b, 0xff, a)); }
      }
      // the amber ring
      const dr = Math.abs(Math.hypot(x + 0.5 - RING[0], y + 0.5 - RING[1]) - RING[2]) - RING[3] / 2;
      const ar = clamp(0.5 - dr / aa, 0, 1);
      if (ar > 0) { r = Math.round(lerp(r, 0xff, ar)); g = Math.round(lerp(g, 0xb4, ar)); b = Math.round(lerp(b, 0x54, ar)); }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`quotient/icon-${n}.png`);
}
