#!/usr/bin/env node
/**
 * Generates the Peak app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as peak/icon.svg: a
 * dark-sky rounded square, a gold score-sun, a cool back ridge, and the
 * front summit carrying the move-green → summit-gold gradient with a
 * snowcap.
 *
 * Run: node scripts/gen-peak-icons.mjs   (writes icon-180/192/512.png into peak/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'peak');

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
const mix = (a, b, t) => [0, 1, 2].map((i) => lerp(a[i], b[i], clamp(t, 0, 1)));

// Is (x,y) inside the triangle a-b-c? Barycentric sign test.
function inTri(px, py, a, b, c) {
  const s = (p, q) => (px - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (py - q[1]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/* ---- the motif, sampled in 512-space with 2x2 supersampling ---- */
function pixel(x, y) {
  // rounded-square mask
  const R = 112, N = 512;
  const cx = clamp(x, R, N - R), cy = clamp(y, R, N - R);
  const dx = x - cx, dy = y - cy;
  if (dx * dx + dy * dy > R * R) return [0, 0, 0, 0];

  // sky gradient (top-left steel blue → near-black)
  let col = mix([0x12, 0x2c, 0x40], [0x0a, 0x0f, 0x14], (x + y) / (2 * N));

  // gold sun
  const sdx = x - 368, sdy = y - 150;
  if (sdx * sdx + sdy * sdy < 46 * 46) col = [0xff, 0xd1, 0x66];

  // back ridge (cool blue), quad as two triangles
  const B1 = [96, 400], B2 = [268, 148], B3 = [332, 244], B4 = [392, 400];
  if (inTri(x, y, B1, B2, B3) || inTri(x, y, B1, B3, B4)) {
    col = mix([0x17, 0x3a, 0x52], [0x2b, 0x6b, 0x8f], (400 - y) / 252);
  }

  // front summit: green base → gold tip
  const F1 = [56, 400], F2 = [208, 176], F3 = [360, 400];
  if (inTri(x, y, F1, F2, F3)) {
    const t = (400 - y) / 224; // 0 at base, 1 at tip
    col = t < 0.7 ? mix([0x1c, 0x8f, 0x63], [0x3d, 0xdc, 0x97], t / 0.7)
                  : mix([0x3d, 0xdc, 0x97], [0xff, 0xd1, 0x66], (t - 0.7) / 0.3);
    // snowcap: a small zigzag band under the tip
    if (y < 214 && inTri(x, y, [186, 208], [208, 176], [230, 208])) {
      const zig = Math.abs(((x - 186) % 22) - 11) / 11; // jagged lower edge
      if (y < 208 - zig * 10 + 8) col = [0xea, 0xf7, 0xf0];
    }
  }
  return [col[0], col[1], col[2], 255];
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const scale = 512 / N;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const p = pixel((x + ox) * scale, (y + oy) * scale);
        r += p[0]; g += p[1]; b += p[2]; a += p[3];
      }
      const i = (y * N + x) * 4;
      rgba[i] = Math.round(r / 4); rgba[i + 1] = Math.round(g / 4);
      rgba[i + 2] = Math.round(b / 4); rgba[i + 3] = Math.round(a / 4);
    }
  }
  return rgba;
}

for (const N of [180, 192, 512]) {
  const png = encodePNG(N, render(N));
  const file = join(OUT, `icon-${N}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
