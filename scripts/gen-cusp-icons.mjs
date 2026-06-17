#!/usr/bin/env node
/**
 * Generates the Cusp app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-omni-icons.mjs).
 * Rasterizes the same motif as cusp/icon.svg: a radial-dark rounded square
 * holding a gradient dial ring with a single hand pointing to the one next
 * thing, plus a teal accent node.
 *
 * Run: node scripts/gen-cusp-icons.mjs   (writes icon-180/192/512.png into cusp/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cusp');

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
const STOPS = [[0, [0x6e, 0x8b, 0xff]], [0.5, [0x8b, 0x7c, 0xff]], [1, [0x39, 0xe6, 0xb4]]];
const TEAL = [0x39, 0xe6, 0xb4];
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
function grad(t) {
  t = clamp(t);
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], f = (t - a) / (b - a);
      return ca.map((v, k) => lerp(v, cb[k], f));
    }
  }
  return STOPS[STOPS.length - 1][1];
}
// distance from point (px,py) to segment a→b
function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const c1 = vx * wx + vy * wy, c2 = vx * vx + vy * vy;
  const t = c2 ? clamp(c1 / c2) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/* ---- the artwork (geometry in 512-space, scaled to N) ---- */
function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  const s = N / 512, c = N / 2;
  const R = 150 * s, ringHW = 11 * s;        // dial ring radius + half stroke
  const hub = 26 * s;                          // centre hub
  const handHW = 9 * s;                         // hand half-width
  const tip = [339.7 * s, 148.8 * s];           // hand tip (vertical, rotated 38°)
  const tail = [c - (tip[0] - c) * 0.12, c - (tip[1] - c) * 0.12]; // slight overhang past centre
  const acc = [368 * s, 150 * s], accR = 20 * s; // teal accent node
  const aa = 1.6 * s;

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dist = Math.hypot(x - c, y - c);
    const rb = clamp(dist / (N * 0.72));
    let col = [lerp(0x16, 0x08, rb), lerp(0x1b, 0x0a, rb), lerp(0x2e, 0x14, rb)]; // radial dark bg
    const g = grad((x + (N - y)) / (2 * N));     // diagonal brand gradient

    // brand coverage = ring ∪ hub ∪ hand
    let cov = 0;
    cov = Math.max(cov, 1 - smooth(ringHW - aa, ringHW + aa, Math.abs(dist - R)));
    cov = Math.max(cov, 1 - smooth(hub - aa, hub + aa, dist));
    cov = Math.max(cov, 1 - smooth(handHW - aa, handHW + aa, distSeg(x, y, tail[0], tail[1], tip[0], tip[1])));
    col = [lerp(col[0], g[0], cov), lerp(col[1], g[1], cov), lerp(col[2], g[2], cov)];

    // teal accent node on top
    const acov = 1 - smooth(accR - aa, accR + aa, Math.hypot(x - acc[0], y - acc[1]));
    col = [lerp(col[0], TEAL[0], acov), lerp(col[1], TEAL[1], acov), lerp(col[2], TEAL[2], acov)];

    const i = (y * N + x) * 4;
    buf[i] = Math.round(col[0]); buf[i + 1] = Math.round(col[1]); buf[i + 2] = Math.round(col[2]); buf[i + 3] = 255;
  }
  return buf;
}

for (const N of [180, 192, 512]) {
  const png = encodePNG(N, render(N));
  writeFileSync(join(OUT, `icon-${N}.png`), png);
  console.log(`wrote icon-${N}.png (${png.length} bytes)`);
}
