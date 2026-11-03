#!/usr/bin/env node
/**
 * Generates the Zenith app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as zenith/icon.svg: a
 * radial deep-night rounded square, the flat sky-dome horizon rings, a
 * four-star constellation figure and a few faint companion stars.
 *
 * Run: node scripts/gen-zenith-icons.mjs   (writes icon-180/192/512.png into zenith/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'zenith');

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
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

// design space is 512; geometry scaled up 8× from icon.svg's 64-grid
const RINGS = [[256, 256, 192, 16, '#31427a'], [256, 256, 112, 11, '#22305c']];
const FIGURE = [[144, 320], [208, 240], [272, 280], [352, 192]];
const STARS = [
  { x: 144, y: 320, r: 17, c: '#ffffff' },
  { x: 208, y: 240, r: 21, c: '#ffe9c4' },
  { x: 272, y: 280, r: 15, c: '#dfe8ff' },
  { x: 352, y: 192, r: 24, c: '#f2c76e' },
  { x: 192, y: 152, r: 10, c: '#aecbff' },
  { x: 360, y: 344, r: 12, c: '#dfe8ff' },
  { x: 288, y: 376, r: 9,  c: '#aecbff' },
];

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512;
  const corner = 112 * S;
  const aa = 1.0;
  const lineW = 6.4 * S;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square mask
      const qx = Math.abs(x - N / 2) - (N / 2 - corner);
      const qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // radial night: light pools near the upper middle, like the svg
      const d0 = Math.hypot(x - N * 0.5, y - N * 0.32) / (N * 0.85);
      let r = Math.round(lerp(0x1a, 0x07, clamp(d0, 0, 1)));
      let g = Math.round(lerp(0x2a, 0x0b, clamp(d0, 0, 1)));
      let b = Math.round(lerp(0x5c, 0x1a, clamp(d0, 0, 1)));

      // horizon rings
      for (const [cx, cy, rr, w, col] of RINGS) {
        const d = Math.abs(Math.hypot(x - cx * S, y - cy * S) - rr * S) - (w * S) / 2;
        const a = clamp(0.5 - d / aa, 0, 1);
        if (a > 0) { const [cr, cg, cb] = hex(col); r = Math.round(lerp(r, cr, a)); g = Math.round(lerp(g, cg, a)); b = Math.round(lerp(b, cb, a)); }
      }

      // constellation strokes
      for (let seg = 0; seg < FIGURE.length - 1; seg++) {
        const d = capsuleDist(x, y, FIGURE[seg][0] * S, FIGURE[seg][1] * S, FIGURE[seg + 1][0] * S, FIGURE[seg + 1][1] * S) - lineW;
        const a = clamp(0.5 - d / aa, 0, 1) * 0.85;
        if (a > 0) { const [cr, cg, cb] = hex('#7fb3ff'); r = Math.round(lerp(r, cr, a)); g = Math.round(lerp(g, cg, a)); b = Math.round(lerp(b, cb, a)); }
      }

      // stars, each with a soft glow
      for (const st of STARS) {
        const d = Math.hypot(x - st.x * S, y - st.y * S);
        const core = clamp(0.5 - (d - st.r * S) / aa, 0, 1);
        const glow = clamp(1 - d / (st.r * S * 2.6), 0, 1) * 0.25;
        const a = Math.max(core, glow);
        if (a > 0) { const [cr, cg, cb] = hex(st.c); r = Math.round(lerp(r, cr, a)); g = Math.round(lerp(g, cg, a)); b = Math.round(lerp(b, cb, a)); }
      }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`zenith/icon-${n}.png`);
}
