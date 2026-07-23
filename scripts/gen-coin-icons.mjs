#!/usr/bin/env node
/**
 * Generates the TimeCoin *wallet* app icons as real PNGs — no image libraries,
 * just Node's built-in zlib (same minimal PNG encoder as gen-miner-icons.mjs).
 * A gold coin bearing a clock face on a dark tile: coin + time = TimeCoin. Same
 * gold-on-dark family as the miner's pickaxe, so the two installed apps read as
 * a set.
 *
 * Run: node scripts/gen-coin-icons.mjs
 *   → coin/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'coin');

/* ---- minimal PNG (RGBA) ---- */
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

/* ---- painting helpers ---- */
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const edge = (d, feather) => clamp01(0.5 - d / feather);
function roundRectDist(x, y, N, r) {
  const hx = N / 2, hy = N / 2;
  const dx = Math.abs(x - hx) - (hx - r), dy = Math.abs(y - hy) - (hy - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / ((vx * vx + vy * vy) || 1));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// clock geometry in 512-unit space (centre 256,256). Hands set to 10:10.
const C = 256;
const pt = (r, deg) => [C + r * Math.sin(deg * Math.PI / 180), C - r * Math.cos(deg * Math.PI / 180)];
const MIN_END = pt(150, 60);    // minute hand → "2"
const HOUR_END = pt(104, 305);  // hour hand   → past "10"
const TICKS = [];
for (let i = 0; i < 12; i++) TICKS.push({ p: pt(170, i * 30), major: i % 3 === 0 });

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const px = 1;
  const INK = [23, 19, 12];
  const GOLD_HI = [247, 227, 150], GOLD = [224, 176, 60], GOLD_LO = [150, 108, 32];
  const u = (v) => (v / 512) * N;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c = [11, 14, 20];                    // dark tile ground (#0b0e14)
      let a = 0;
      const cardA = edge(roundRectDist(x + 0.5, y + 0.5, N, u(96)), px);
      if (cardA > 0) {
        a = 255 * cardA;
        const dc = Math.hypot(x - N / 2, y - N / 2);

        // gold coin disc (radius 204) with a lit top-left, a bright rim and a thin inner shade
        const coinA = edge(dc - u(204), px);
        if (coinA > 0) {
          const gx = (x - 0.34 * N) / N, gy = (y - 0.30 * N) / N;   // light from top-left
          const t = clamp01(Math.hypot(gx, gy) / 0.9);
          let coin = mix(GOLD_HI, GOLD, clamp01(t * 1.15));
          coin = mix(coin, GOLD_LO, clamp01((t - 0.7) / 0.3) * 0.6);
          const rimA = edge(Math.abs(dc - u(198)) - u(3), px);       // bright outer rim
          if (rimA > 0) coin = mix(coin, GOLD_HI, rimA * 0.8);
          const shadeA = edge(Math.abs(dc - u(182)) - u(2), px);     // faint inner ring
          if (shadeA > 0) coin = mix(coin, GOLD_LO, shadeA * 0.5);
          c = mix(c, coin, coinA);

          // ---- clock face, dark ink on the gold ----
          // tick marks
          let ink = 0;
          for (const tk of TICKS) {
            const d = Math.hypot(x - u(tk.p[0]), y - u(tk.p[1])) - u(tk.major ? 11 : 5);
            ink = Math.max(ink, edge(d, px));
          }
          // hour + minute hands (capsules) and centre hub
          ink = Math.max(ink, edge(segDist(x, y, u(C), u(C), u(HOUR_END[0]), u(HOUR_END[1])) - u(11), px));
          ink = Math.max(ink, edge(segDist(x, y, u(C), u(C), u(MIN_END[0]), u(MIN_END[1])) - u(7.5), px));
          ink = Math.max(ink, edge(Math.hypot(x - u(C), y - u(C)) - u(16), px));
          if (ink > 0) c = mix(c, INK, ink * coinA);
          // tiny gold pin at the very centre
          const pin = edge(Math.hypot(x - u(C), y - u(C)) - u(6), px);
          if (pin > 0) c = mix(c, GOLD_HI, pin * coinA);
        }
      }
      const i = (y * N + x) * 4;
      rgba[i] = Math.round(c[0]); rgba[i + 1] = Math.round(c[1]); rgba[i + 2] = Math.round(c[2]); rgba[i + 3] = Math.round(a);
    }
  }
  return rgba;
}

const jobs = [
  [192, 'icon-192.png'],
  [512, 'icon-512.png'],
  [512, 'icon-maskable-512.png'],   // full-bleed dark tile → safe to mask
  [180, 'apple-touch-icon.png'],
];
for (const [N, name] of jobs) {
  const png = encodePNG(N, render(N));
  writeFileSync(join(OUT, name), png);
  console.log(`wrote coin/${name} (${png.length} bytes)`);
}
