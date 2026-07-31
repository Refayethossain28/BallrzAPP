#!/usr/bin/env node
/**
 * Generates the "LLM from scratch" app icons as real PNGs — no image libraries,
 * just Node's built-in zlib (same minimal PNG encoder as gen-cusp-icons.mjs).
 * Rasterizes the same motif as llm-from-scratch/web/icon.svg: a radial-dark
 * rounded square holding a tiny neural net (3 inputs → 1 hidden → 2 outputs)
 * drawn in the page's amber brand gradient — the model "thinking".
 *
 * Run: node scripts/gen-llm-icons.mjs   (writes icon-180/192/512.png into web/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'llm-from-scratch', 'web');

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
const STOPS = [[0, [0xf5, 0xa5, 0x24]], [0.55, [0xff, 0x7a, 0x45]], [1, [0xff, 0xd2, 0x7a]]];
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
function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const c1 = vx * wx + vy * wy, c2 = vx * vx + vy * vy;
  const t = c2 ? clamp(c1 / c2) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/* ---- the artwork (geometry in 512-space, scaled to N) ---- */
// nodes: 3 inputs, 1 hidden (big), 2 outputs — matches icon.svg
const NODES = [
  [150, 150, 26], [150, 256, 26], [150, 362, 26],
  [256, 256, 40], [372, 180, 26], [372, 332, 26],
];
const EDGES = [
  [0, 3], [1, 3], [2, 3], [3, 4], [3, 5],
];

function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  const s = N / 512, c = N / 2;
  const edgeHW = 5 * s, aa = 1.6 * s;

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dist = Math.hypot(x - c, y - c);
    const rb = clamp(dist / (N * 0.72));
    let col = [lerp(0x14, 0x08, rb), lerp(0x19, 0x0a, rb), lerp(0x26, 0x12, rb)]; // radial dark bg
    const g = grad((x + (N - y)) / (2 * N));    // diagonal brand gradient

    let cov = 0;
    for (const [a, b] of EDGES) {
      const A = NODES[a], B = NODES[b];
      cov = Math.max(cov, 0.85 * (1 - smooth(edgeHW - aa, edgeHW + aa,
        distSeg(x, y, A[0] * s, A[1] * s, B[0] * s, B[1] * s))));
    }
    for (const [nx, ny, r] of NODES) {
      cov = Math.max(cov, 1 - smooth(r * s - aa, r * s + aa, Math.hypot(x - nx * s, y - ny * s)));
    }
    col = [lerp(col[0], g[0], cov), lerp(col[1], g[1], cov), lerp(col[2], g[2], cov)];

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
