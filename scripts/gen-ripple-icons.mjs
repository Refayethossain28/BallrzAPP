#!/usr/bin/env node
/**
 * Generates the Ripple app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder as gen-cusp-icons.mjs). Rasterizes the
 * same motif as ripple/icon.svg: a radial-dark rounded square holding a brand
 * gradient speech bubble (rounded body + tail) with three typing dots knocked
 * out of it, plus two teal "ripple" rings spreading from the top-right.
 *
 * Run: node scripts/gen-ripple-icons.mjs  (writes icon-180/192/512.png into ripple/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'ripple');

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

/* ---- gradient + sdf helpers (geometry in 512-space, scaled to N) ---- */
const STOPS = [[0, [0x6e, 0x8b, 0xff]], [0.5, [0x8b, 0x7c, 0xff]], [1, [0x39, 0xe6, 0xb4]]];
const TEAL = [0x39, 0xe6, 0xb4];
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
function grad(t) {
  t = clamp(t);
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const a = STOPS[i - 1][0], ca = STOPS[i - 1][1], b = STOPS[i][0], cb = STOPS[i][1], f = (t - a) / (b - a);
      return ca.map((v, k) => lerp(v, cb[k], f));
    }
  }
  return STOPS[STOPS.length - 1][1];
}
// signed distance to a rounded rectangle (negative inside)
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// signed distance to a triangle (negative inside) — iq's formula
function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax, e0y = by - ay, e1x = cx - bx, e1y = cy - by, e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay, v1x = px - bx, v1y = py - by, v2x = px - cx, v2y = py - cy;
  const cl = (vx, vy, ex, ey) => { const t = clamp((vx * ex + vy * ey) / (ex * ex + ey * ey)); return [vx - ex * t, vy - ey * t]; };
  const p0 = cl(v0x, v0y, e0x, e0y), p1 = cl(v1x, v1y, e1x, e1y), p2 = cl(v2x, v2y, e2x, e2y);
  const s = Math.sign(e0x * e2y - e0y * e2x);
  const d = Math.min(
    Math.min(p0[0] * p0[0] + p0[1] * p0[1], p1[0] * p1[0] + p1[1] * p1[1]), p2[0] * p2[0] + p2[1] * p2[1]);
  const sy = Math.min(
    Math.min(s * (v0x * e0y - v0y * e0x), s * (v1x * e1y - v1y * e1x)), s * (v2x * e2y - v2y * e2x));
  return -Math.sqrt(d) * Math.sign(sy);
}

/* ---- the artwork ---- */
function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  const s = N / 512, c = N / 2, aa = 1.4 * s;
  const ring = [[392 * s, 128 * s, 58 * s, 5 * s, 0.5], [392 * s, 128 * s, 92 * s, 4 * s, 0.22]];
  const dots = [[196 * s, 240 * s], [256 * s, 240 * s], [316 * s, 240 * s]];
  const dotR = 20 * s;

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dist = Math.hypot(x - c, y - c);
    const rb = clamp(dist / (N * 0.72));
    let col = [lerp(0x16, 0x08, rb), lerp(0x1b, 0x0a, rb), lerp(0x2e, 0x14, rb)]; // radial dark bg
    const g = grad((x + (N - y)) / (2 * N));

    // teal ripple rings (behind the bubble)
    for (const [rx, ry, R, hwStroke, op] of ring) {
      const cov = (1 - smooth(hwStroke - aa, hwStroke + aa, Math.abs(Math.hypot(x - rx, y - ry) - R))) * op;
      col = [lerp(col[0], TEAL[0], cov), lerp(col[1], TEAL[1], cov), lerp(col[2], TEAL[2], cov)];
    }

    // bubble = rounded body ∪ tail triangle
    const body = sdRoundRect(x, y, c, 240 * s, 120 * s, 90 * s, 60 * s);
    const tail = sdTriangle(x, y, 198 * s, 318 * s, 150 * s, 394 * s, 240 * s, 326 * s);
    const bubbleSdf = Math.min(body, tail);
    let cov = 1 - smooth(-aa, aa, bubbleSdf);

    // knock the three typing dots out of the bubble
    let hole = 0;
    for (const [dx, dy] of dots) hole = Math.max(hole, 1 - smooth(dotR - aa, dotR + aa, Math.hypot(x - dx, y - dy)));
    cov *= (1 - hole);

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
