#!/usr/bin/env node
/**
 * Generates the Cortex app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-cusp-icons.mjs).
 * Rasterizes the same motif as cortex/icon.svg: a radial-dark rounded square
 * holding a firing neural node — a teal hub with six gradient synapses.
 *
 * Run: node scripts/gen-cortex-icons.mjs   (writes icon-180/192/512.png into cortex/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cortex');

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
const A = [0x6e, 0x8b, 0xff], B = [0x8b, 0x7c, 0xff], TEAL = [0x39, 0xe6, 0xb4];
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
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
  const R = 155 * s;                       // synapse ring radius
  const nodes = [];
  for (let i = 0; i < 6; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 3;
    nodes.push([c + R * Math.cos(ang), c + R * Math.sin(ang), i % 2 ? B : A]);
  }
  const nodeR = 30 * s, hubR = 52 * s, coreR = 24 * s, edgeHW = 7 * s;
  const aa = 1.6 * s;

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dist = Math.hypot(x - c, y - c);
    const rb = clamp(dist / (N * 0.72));
    let col = [lerp(0x16, 0x08, rb), lerp(0x1b, 0x0a, rb), lerp(0x2e, 0x14, rb)]; // radial dark bg

    // synapse edges: gradient from hub colour outward toward each node's colour
    for (const [nx, ny, nc] of nodes) {
      const d = distSeg(x, y, c, c, nx, ny);
      const cov = (1 - smooth(edgeHW - aa, edgeHW + aa, d)) * 0.9;
      if (cov > 0) {
        const f = clamp(Math.hypot(x - c, y - c) / R);
        const g = [lerp(TEAL[0], nc[0], f), lerp(TEAL[1], nc[1], f), lerp(TEAL[2], nc[2], f)];
        col = [lerp(col[0], g[0], cov), lerp(col[1], g[1], cov), lerp(col[2], g[2], cov)];
      }
    }
    // satellite nodes
    for (const [nx, ny, nc] of nodes) {
      const cov = 1 - smooth(nodeR - aa, nodeR + aa, Math.hypot(x - nx, y - ny));
      if (cov > 0) col = [lerp(col[0], nc[0], cov), lerp(col[1], nc[1], cov), lerp(col[2], nc[2], cov)];
    }
    // teal hub with a darker core
    const hcov = 1 - smooth(hubR - aa, hubR + aa, dist);
    if (hcov > 0) col = [lerp(col[0], TEAL[0], hcov), lerp(col[1], TEAL[1], hcov), lerp(col[2], TEAL[2], hcov)];
    const ccov = (1 - smooth(coreR - aa, coreR + aa, dist)) * 0.35;
    if (ccov > 0) col = [lerp(col[0], 0x0a, ccov), lerp(col[1], 0x0d, ccov), lerp(col[2], 0x18, ccov)];

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
