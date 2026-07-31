#!/usr/bin/env node
/**
 * Generates the Graft app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-drip-icons.mjs).
 * Rasterizes the same motif as graft/icon.svg: a radial-dark rounded square,
 * a gold coin, and an ember→gold arrow rising out of it (earnings going up).
 *
 * Run: node scripts/gen-graft-icons.mjs   (writes icon-180/192/512.png into graft/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'graft');

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
const EMBER = [0xff, 0x9d, 0x42];
const GOLD2 = [0xff, 0xdd, 0x87];
const COINGOLD = [0xf5, 0xc0, 0x4a];
const COINFACE = [0x1c, 0x12, 0x09];
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const mix = (ca, cb, f) => ca.map((v, i) => lerp(v, cb[i], f));

// distance from point (px,py) to segment a→b, plus the projection parameter t
function segInfo(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy));
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return { d: Math.hypot(dx, dy), t };
}

// signed distance to a rounded square centred in the unit box
function roundedRect(u, v, half, r) {
  const qx = Math.abs(u - 0.5) - (half - r), qy = Math.abs(v - 0.5) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function draw(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const px = 1 / N;

  // motif geometry in unit space (matches icon.svg proportions)
  const COIN = { x: 164 / 512, y: 348 / 512, r: 66 / 512, face: 44 / 512, core: 16 / 512 };
  const TIP = { x: 366 / 512, y: 146 / 512 };
  const SHAFT = { ax: COIN.x, ay: COIN.y, bx: TIP.x, by: TIP.y };
  const ARM1 = { ax: 258 / 512, ay: 146 / 512, bx: TIP.x, by: TIP.y }; // horizontal arm
  const ARM2 = { ax: TIP.x, ay: 254 / 512, bx: TIP.x, by: TIP.y };     // vertical arm
  const W = 26 / 512; // half stroke width (stroke-width 52)

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N, v = (y + 0.5) / N;

      // rounded-square tile with a warm radial glow from the top
      const rr = roundedRect(u, v, 0.5, 0.219);
      const tileA = 1 - smooth(-px, px, rr);
      const glow = 1 - clamp(Math.hypot(u - 0.5, v - 0.12) / 0.95);
      let c = mix([0x13, 0x0c, 0x07], [0x2c, 0x1a, 0x0b], smooth(0, 1, glow));

      // coin: gold ring, dark face, gold core
      const dc = Math.hypot(u - COIN.x, v - COIN.y);
      c = mix(c, COINGOLD, 1 - smooth(COIN.r - px, COIN.r + px, dc));
      c = mix(c, COINFACE, 1 - smooth(COIN.face - px, COIN.face + px, dc));
      c = mix(c, COINGOLD, 1 - smooth(COIN.core - px, COIN.core + px, dc));

      // arrow: shaft + two head arms, ember→gold along the rise
      for (const seg of [SHAFT, ARM1, ARM2]) {
        const s = segInfo(u, v, seg.ax, seg.ay, seg.bx, seg.by);
        const cover = 1 - smooth(W - px, W + px, s.d);
        if (cover > 0) {
          // colour by height: lower = ember, higher = gold
          const f = clamp((COIN.y - (seg.ay + (seg.by - seg.ay) * s.t)) / (COIN.y - TIP.y));
          c = mix(c, mix(EMBER, GOLD2, f), cover);
        }
      }

      const o = (y * N + x) * 4;
      rgba[o] = Math.round(c[0]); rgba[o + 1] = Math.round(c[1]); rgba[o + 2] = Math.round(c[2]);
      rgba[o + 3] = Math.round(255 * tileA);
    }
  }
  return rgba;
}

for (const N of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${N}.png`), encodePNG(N, draw(N)));
  console.log(`graft/icon-${N}.png`);
}
