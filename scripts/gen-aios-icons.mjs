#!/usr/bin/env node
/**
 * Generates the AIOS app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-cortex-icons.mjs).
 * Rasterizes the same motif as aios/icon.svg: a radial-dark rounded square
 * with a violet→teal orbit ring, four orbiting process nodes, and a glowing
 * four-point AI star at the core.
 *
 * Run: node scripts/gen-aios-icons.mjs   (writes icon-180/192/512.png into aios/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'aios');

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
const VIOLET = [0x8b, 0x7c, 0xff], TEAL = [0x39, 0xe6, 0xb4];
const BLUE = [0x5f, 0xb9, 0xff], PURPLE = [0xb0, 0x7c, 0xff];
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const mix = (a, b, f) => [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/* ---- the artwork (geometry in 512-space, scaled to N) ---- */
function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  const s = N / 512, c = N / 2;
  const RING = 150 * s, RINGW = 10 * s;
  const nodes = [ // orbiting processes: [x, y, r, color]
    [256, 106, 17, VIOLET],
    [406, 256, 13, BLUE],
    [256, 406, 15, TEAL],
    [106, 256, 11, PURPLE]
  ].map(([x, y, r, col]) => [x * s, y * s, r * s, col]);

  // four-point star at the core: |x|^0.6 + |y|^0.6 metric gives the concave points
  const STAR = 84 * s;
  const starDist = (dx, dy) => Math.pow(Math.abs(dx), 0.6) + Math.pow(Math.abs(dy), 0.6) - Math.pow(STAR, 0.6);

  const corner = 116 * s;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square mask
      const ex = Math.max(Math.abs(x - c) - (c - corner), 0);
      const ey = Math.max(Math.abs(y - c) - (c - corner), 0);
      const dCorner = Math.hypot(ex, ey) - corner;
      const alpha = 1 - smooth(-1.5 * s, 1.5 * s, dCorner);
      if (alpha <= 0) { buf[i + 3] = 0; continue; }

      // radial-dark background
      const dl = Math.hypot(x - N * 0.34, y - N * 0.26) / N;
      let col = mix([0x1a, 0x1f, 0x3d], [0x07, 0x09, 0x1a], smooth(0, 0.75, dl));

      const dx = x - c, dy = y - c;
      const dCenter = Math.hypot(dx, dy);

      // orbit ring: violet→teal gradient along the diagonal
      const ringD = Math.abs(dCenter - RING) - RINGW / 2;
      const ringA = 1 - smooth(-1 * s, 1.5 * s, ringD);
      if (ringA > 0) {
        const f = clamp((dx + dy + N) / (2 * N));
        col = mix(col, mix(VIOLET, TEAL, f), ringA * 0.85);
      }

      // core glow
      const glow = Math.exp(-Math.pow(dCenter / (110 * s), 2)) * 0.55;
      col = mix(col, [0xb8, 0xad, 0xff], glow);

      // the star
      const sd = starDist(dx, dy);
      if (sd < 0) {
        const edge = 1 - smooth(-2.5 * s, 0, sd);
        col = mix(col, [0xff, 0xff, 0xff], clamp(1 - edge * 0.15));
      }

      // orbiting nodes (drawn over the ring)
      for (const [nx, ny, nr, ncol] of nodes) {
        const nd = Math.hypot(x - nx, y - ny) - nr;
        const na = 1 - smooth(-1 * s, 1.5 * s, nd);
        if (na > 0) col = mix(col, ncol, na);
      }

      buf[i] = Math.round(col[0]); buf[i + 1] = Math.round(col[1]); buf[i + 2] = Math.round(col[2]);
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

for (const N of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${N}.png`), encodePNG(N, render(N)));
  console.log(`aios/icon-${N}.png`);
}
