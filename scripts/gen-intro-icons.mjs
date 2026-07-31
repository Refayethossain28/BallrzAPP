#!/usr/bin/env node
/**
 * Generates the Intro app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-omni-icons.mjs).
 * Rasterizes the same motif as intro/icon.svg: a radial-dark rounded square
 * holding a tilted gold→coral business card with an avatar circle and text
 * bars pressed into it.
 *
 * Run: node scripts/gen-intro-icons.mjs   (writes icon-180/192/512.png into intro/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'intro');

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
const GOLD = [0xf0, 0xb4, 0x5c], CORAL = [0xff, 0x8a, 0x5c], INK = [0x2b, 0x15, 0x08];
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const mix = (a, b, f) => [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
// signed distance to a rounded rectangle centred at 0,0 (half-size hw/hh, corner r)
function sdRoundRect(x, y, hw, hh, r) {
  const qx = Math.abs(x) - hw + r, qy = Math.abs(y) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/* ---- the artwork (geometry in 512-space, scaled to N) ---- */
function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  const s = N / 512, c = N / 2;
  const aa = 1.6 * s;
  const rot = -9 * Math.PI / 180, cos = Math.cos(rot), sin = Math.sin(rot);
  // card geometry in card-space (centred on the icon centre)
  const cardHW = 158 * s, cardHH = 106 * s, cardR = 26 * s;
  const avatar = [-93 * s, -34 * s, 38 * s];                                    // cx, cy, r
  const bars = [ // [cx, cy, hw, hh, alpha]
    [37 * s, -44 * s, 75 * s, 12 * s, 0.82],
    [11 * s, -13 * s, 49 * s, 7 * s, 0.5],
    [-43 * s, 43.5 * s, 88 * s, 7.5 * s, 0.5],
    [-65 * s, 71.5 * s, 66 * s, 7.5 * s, 0.5],
  ];
  const cornerR = 116 * s;

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    // squircle-ish app tile
    const tile = 1 - smooth(-aa, aa, sdRoundRect(x - c, y - c, c, c, cornerR));
    if (tile <= 0) { buf[i + 3] = 0; continue; }
    // radial dark background
    const rb = clamp(Math.hypot(x - c, y - (0.28 * N)) / (N * 0.85));
    let col = mix([0x1c, 0x16, 0x26], [0x0b, 0x0d, 0x14], smooth(0, 1, rb));
    // into card space
    const dx = x - c, dy = y - c;
    const cx = dx * cos + dy * sin, cy = -dx * sin + dy * cos;
    const cardCov = 1 - smooth(-aa, aa, sdRoundRect(cx, cy - 0 * s, cardHW, cardHH, cardR));
    if (cardCov > 0) {
      const t = clamp((cx + cardHW) / (2 * cardHW) * 0.75 + (cy + cardHH) / (2 * cardHH) * 0.25);
      let card = mix(GOLD, CORAL, t);
      // pressed-in ink details
      let inkA = 0.82 * (1 - smooth(avatar[2] - aa, avatar[2] + aa, Math.hypot(cx - avatar[0], cy - avatar[1])));
      for (const [bx, by, hw, hh, alpha] of bars) {
        inkA = Math.max(inkA, alpha * (1 - smooth(-aa, aa, sdRoundRect(cx - bx, cy - by, hw, hh, hh))));
      }
      card = mix(card, INK, inkA);
      col = mix(col, card, cardCov);
    }
    buf[i] = Math.round(col[0]); buf[i + 1] = Math.round(col[1]); buf[i + 2] = Math.round(col[2]);
    buf[i + 3] = Math.round(255 * tile);
  }
  return buf;
}

for (const N of [180, 192, 512]) {
  const png = encodePNG(N, render(N));
  writeFileSync(join(OUT, `icon-${N}.png`), png);
  console.log(`wrote icon-${N}.png (${png.length} bytes)`);
}
