#!/usr/bin/env node
/**
 * Generates the Ballrz Hub app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as the other
 * gen-*-icons.mjs scripts). Rasterizes the same motif as hub/icon.svg: a
 * radial-dark rounded square holding a 2×2 launcher grid of gradient tiles
 * (blue, purple, teal, gold).
 *
 * Run: node scripts/gen-hub-icons.mjs   (writes icon-180/192/512.png into hub/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'hub');

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
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// signed distance to a rounded rect centred at (cx,cy), half-size (hw,hh), radius r
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// tile gradients: [top-left colour, bottom-right colour] (matches hub/icon.svg)
const TILES = [
  [[0x8f, 0xa6, 0xff], [0x54, 0x70, 0xe6]], // blue      (top-left)
  [[0xa7, 0x98, 0xff], [0x6f, 0x5f, 0xe0]], // purple    (top-right)
  [[0x5c, 0xf0, 0xc8], [0x22, 0xc4, 0x97]], // teal      (bottom-left)
  [[0xff, 0xd9, 0x7a], [0xdf, 0xa6, 0x2e]]  // gold      (bottom-right)
];

function renderIcon(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const aa = 1.25 / N * 512;                     // anti-alias width in 512-space
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // work in the 512 viewBox space of icon.svg
      const px = (x + 0.5) / N * 512, py = (y + 0.5) / N * 512;

      // background: radial dark gradient inside a rounded square
      const dBg = sdRoundRect(px, py, 256, 256, 256, 256, 112);
      const bgA = 1 - smooth(-aa, aa, dBg);
      const dr = Math.hypot(px - 358, py + 51) / 614;   // radial from (70%, -10%)
      const f = smooth(0, 0.6, dr);
      let R = lerp(0x1b, 0x0b, f), G = lerp(0x24, 0x0e, f), B = lerp(0x40, 0x17, f);

      // 2×2 launcher tiles: centres at 184/328, half-size 56, radius 30
      for (let i = 0; i < 4; i++) {
        const cx = i % 2 ? 328 : 184, cy = i < 2 ? 184 : 328;
        const d = sdRoundRect(px, py, cx, cy, 56, 56, 30);
        const cover = 1 - smooth(-aa, aa, d);
        if (cover <= 0) continue;
        const g = clamp(((px - (cx - 56)) + (py - (cy - 56))) / 224);   // ↘ gradient
        const [ca, cb] = TILES[i];
        R = lerp(R, lerp(ca[0], cb[0], g), cover);
        G = lerp(G, lerp(ca[1], cb[1], g), cover);
        B = lerp(B, lerp(ca[2], cb[2], g), cover);
      }

      const o = (y * N + x) * 4;
      rgba[o] = Math.round(R); rgba[o + 1] = Math.round(G); rgba[o + 2] = Math.round(B);
      rgba[o + 3] = Math.round(bgA * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const N of [180, 192, 512]) {
  const file = join(OUT, `icon-${N}.png`);
  writeFileSync(file, renderIcon(N));
  console.log(`wrote ${file}`);
}
