#!/usr/bin/env node
/**
 * Generates the Ultra app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as ultra/icon.svg: a
 * radial-dark rounded square, four console-colour quads rotated 45° like
 * the N64 logo, and an N64 cartridge with a label and a gold dot.
 *
 * Run: node scripts/gen-ultra-icons.mjs   (writes icon-180/192/512.png into ultra/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'ultra');

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
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---- helpers (unit space: 512x512, like icon.svg) ---- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// signed distance to a rounded rect (negative inside)
function roundRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// coverage from a signed distance with ~1px anti-aliasing (px units passed in)
const cov = (d, aa) => clamp(0.5 - d / aa, 0, 1);

const QUADS = [ // {cx, cy in rotated frame} colors: blue red yellow green
  { x: -28, y: -28, c: [0x4f, 0x7d, 0xf9] },
  { x: 28, y: -28, c: [0xe9, 0x4b, 0x5a] },
  { x: -28, y: 28, c: [0xf2, 0xb6, 0x34] },
  { x: 28, y: 28, c: [0x3e, 0xc4, 0x6d] },
];
const COS45 = Math.SQRT1_2;

function shade(x, y, aa) {
  // background: radial navy inside a rounded square
  const bgD = roundRectDist(x, y, 256, 256, 256, 256, 112);
  const bgA = cov(bgD, aa);
  if (bgA <= 0) return [0, 0, 0, 0];
  const rad = Math.hypot(x - 256, y - 195) / 410;
  let R = 0x23 + (0x0b - 0x23) * clamp(rad, 0, 1);
  let G = 0x23 + (0x0b - 0x23) * clamp(rad, 0, 1);
  let B = 0x38 + (0x14 - 0x38) * clamp(rad, 0, 1);

  const put = (d, c, alpha = 1) => {
    const a = cov(d, aa) * alpha;
    if (a > 0) { R += (c[0] - R) * a; G += (c[1] - G) * a; B += (c[2] - B) * a; }
  };

  // four quads, rotated 45° about (256,148)
  for (const q of QUADS) {
    const dx = x - 256, dy = y - 148;
    const rx = dx * COS45 + dy * COS45, ry = -dx * COS45 + dy * COS45; // un-rotate
    put(roundRectDist(rx, ry, q.x, q.y, 22, 22, 10), q.c);
  }

  // cartridge shell with a vertical shade
  const shellT = clamp((y - 252) / 150, 0, 1);
  const shell = [0x3a + (0x23 - 0x3a) * shellT, 0x3a + (0x23 - 0x3a) * shellT, 0x54 + (0x3a - 0x54) * shellT];
  put(roundRectDist(x, y, 256, 327, 130, 75, 18), shell);
  put(roundRectDist(x, y, 256, 391, 130, 11, 8), [0x17, 0x17, 0x2a]);   // base band
  put(roundRectDist(x, y, 256, 415, 80, 13, 8), [0x10, 0x10, 0x20]);    // plug
  put(roundRectDist(x, y, 144, 314, 4, 48, 4), [0x1b, 0x1b, 0x2e]);     // grips
  put(roundRectDist(x, y, 368, 314, 4, 48, 4), [0x1b, 0x1b, 0x2e]);
  put(roundRectDist(x, y, 256, 319, 100, 41, 10), [0x0e, 0x0e, 0x1c]);  // label
  put(roundRectDist(x, y, 231, 302, 59, 6, 6), [0xe8, 0xe8, 0xf2]);     // title line
  put(roundRectDist(x, y, 213, 325, 41, 5, 5), [0x55, 0x55, 0x6e]);     // sub line
  put(Math.hypot(x - 330, y - 318) - 18, [0xf2, 0xb6, 0x34]);           // gold dot

  return [Math.round(R), Math.round(G), Math.round(B), Math.round(bgA * 255)];
}

function renderIcon(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const scale = 512 / N, aa = scale * 1.2;
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const [r, g, b, a] = shade((px + 0.5) * scale, (py + 0.5) * scale, aa);
      const o = (py * N + px) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return encodePNG(N, rgba);
}

for (const N of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${N}.png`), renderIcon(N));
  console.log(`ultra/icon-${N}.png`);
}
