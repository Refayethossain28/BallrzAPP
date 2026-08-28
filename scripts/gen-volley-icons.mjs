#!/usr/bin/env node
/**
 * Generates the Volley app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as volley/icon.svg: a
 * radial-dark rounded square, the three scoring rings of a target, and a
 * green ball streaking in for the bullseye with a cyan motion trail.
 *
 * Run: node scripts/gen-volley-icons.mjs   (writes icon-180/192/512.png into volley/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'volley');

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
// distance to a segment (capsules are this minus a radius)
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 116 * S;
  const aa = 1.0; // anti-alias feather in px

  // geometry, straight from icon.svg
  const tx = 330 * S, ty = 196 * S;                       // target centre
  const bx = 186 * S, by = 376 * S, br = 48 * S;          // the ball
  const TRAIL = [
    [66, 452, 136, 392, 0.45],
    [106, 448, 160, 402, 0.7],
  ];

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
      const dTop = clamp(Math.hypot(x - N * 0.5, y - N * 0.18) / (N * 0.9), 0, 1);
      let r = Math.round(lerp(0x10, 0x07, dTop));
      let g = Math.round(lerp(0x20, 0x0b, dTop));
      let b = Math.round(lerp(0x3a, 0x14, dTop));

      const dT = Math.hypot(x - tx, y - ty);
      // outer ring — pink
      let a = clamp(0.5 - (Math.abs(dT - 110 * S) - 9 * S) / aa, 0, 1);
      if (a > 0) { r = Math.round(lerp(r, 0xff, a)); g = Math.round(lerp(g, 0x5c, a)); b = Math.round(lerp(b, 0x8f, a)); }
      // inner ring — gold
      a = clamp(0.5 - (Math.abs(dT - 66 * S) - 7 * S) / aa, 0, 1);
      if (a > 0) { r = Math.round(lerp(r, 0xff, a)); g = Math.round(lerp(g, 0xd1, a)); b = Math.round(lerp(b, 0x66, a)); }
      // bullseye — filled gold
      a = clamp(0.5 - (dT - 26 * S) / aa, 0, 1);
      if (a > 0) { r = Math.round(lerp(r, 0xff, a)); g = Math.round(lerp(g, 0xd1, a)); b = Math.round(lerp(b, 0x66, a)); }

      // cyan motion trail
      for (const [ax, ay, bx2, by2, op] of TRAIL) {
        const d = capsuleDist(x, y, ax * S, ay * S, bx2 * S, by2 * S) - 7 * S;
        const at = clamp(0.5 - d / aa, 0, 1) * op;
        if (at > 0) { r = Math.round(lerp(r, 0x4d, at)); g = Math.round(lerp(g, 0xd8, at)); b = Math.round(lerp(b, 0xff, at)); }
      }

      // the ball, lit from its upper-left
      const dB = Math.hypot(x - bx, y - by);
      a = clamp(0.5 - (dB - br) / aa, 0, 1);
      if (a > 0) {
        const lt = clamp(Math.hypot(x - (bx - br * 0.35), y - (by - br * 0.35)) / (br * 1.6), 0, 1);
        const cr = Math.round(lerp(0xae, 0x2f, lt));
        const cg = Math.round(lerp(0xfc, 0xae, lt));
        const cb = Math.round(lerp(0xcf, 0x6e, lt));
        r = Math.round(lerp(r, cr, a)); g = Math.round(lerp(g, cg, a)); b = Math.round(lerp(b, cb, a));
      }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`volley/icon-${n}.png`);
}
