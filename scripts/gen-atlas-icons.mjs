#!/usr/bin/env node
/**
 * Generates the Atlas app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-cusp-icons.mjs).
 * Rasterizes the same motif as atlas/icon.svg: a radial-dark rounded square
 * with a faint map grid, a gradient route line with rounded corners from an
 * origin dot to a red destination pin.
 *
 * Run: node scripts/gen-atlas-icons.mjs   (writes icon-180/192/512.png into atlas/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'atlas');

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

/* ---- helpers (all coordinates in 0..512 design space) ---- */
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const L2 = vx * vx + vy * vy;
  const t = L2 === 0 ? 0 : clamp((wx * vx + wy * vy) / L2);
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return { d: Math.hypot(dx, dy), t };
}

/* the route path from icon.svg, sampled densely (quadratic corners) */
const PATH = (() => {
  const raw = [
    [128, 424], [128, 300], // vertical leg
    'q', [128, 268], [160, 268],
    [256, 268],
    'q', [288, 268], [288, 236],
    [288, 160],
    'q', [288, 128], [320, 128],
    [372, 128],
  ];
  const pts = [];
  let cur = null;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 'q') {
      const c = raw[i + 1], e = raw[i + 2];
      for (let s = 1; s <= 12; s++) {
        const t = s / 12, u = 1 - t;
        pts.push([u * u * cur[0] + 2 * u * t * c[0] + t * t * e[0],
                  u * u * cur[1] + 2 * u * t * c[1] + t * t * e[1]]);
      }
      cur = e; i += 2;
    } else { pts.push(raw[i]); cur = raw[i]; }
  }
  return pts;
})();
function routeDist(x, y) {
  let best = Infinity, bt = 0, acc = 0, total = 0;
  const lens = [];
  for (let i = 1; i < PATH.length; i++) {
    const L = Math.hypot(PATH[i][0] - PATH[i - 1][0], PATH[i][1] - PATH[i - 1][1]);
    lens.push(L); total += L;
  }
  for (let i = 1; i < PATH.length; i++) {
    const r = distSeg(x, y, PATH[i - 1][0], PATH[i - 1][1], PATH[i][0], PATH[i][1]);
    if (r.d < best) { best = r.d; bt = (acc + r.t * lens[i - 1]) / total; }
    acc += lens[i - 1];
  }
  return { d: best, t: bt };
}

/* route gradient: blue → sky → mint along the path */
const STOPS = [[0, [0x2f, 0x7f, 0xf6]], [0.6, [0x38, 0xbd, 0xf8]], [1, [0x34, 0xd3, 0x99]]];
function grad(t) {
  t = clamp(t);
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], f = (t - a) / (b - a || 1);
      return ca.map((v, k) => lerp(v, cb[k], f));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

function roundedRectDist(x, y, N) {
  const r = 116, hw = 256 - r;
  const dx = Math.abs(x - 256) - hw, dy = Math.abs(y - 256) - hw;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
}

/* destination pin (teardrop at 400,132 head r≈54, tip ≈ 222) */
function pinAlpha(x, y) {
  const hx = 400, hy = 130, R = 55;
  const head = Math.hypot(x - hx, y - hy) - R;
  // triangle tail: from circle sides down to tip (400, 222)
  const tipY = 222;
  let tail = Infinity;
  if (y > hy && y < tipY + 6) {
    const half = R * 0.92 * clamp((tipY - y) / (tipY - hy));
    tail = Math.abs(x - hx) - half;
  }
  return 1 - smooth(-1.5, 1.5, Math.min(head, tail));
}

function render(N) {
  const S = 512 / N;
  const rgba = Buffer.alloc(N * N * 4);
  const AA = 2; // 2×2 supersample
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < AA; sy++) for (let sx = 0; sx < AA; sx++) {
        const x = (px + (sx + 0.5) / AA) * S, y = (py + (sy + 0.5) / AA) * S;
        const dRect = roundedRectDist(x, y, N);
        const inside = 1 - smooth(-S, S, dRect);
        if (inside <= 0) { continue; }
        // background: radial navy
        const rr = Math.hypot(x - 512 * 0.35, y - 512 * 0.25) / (512 * 0.9);
        let cr = lerp(0x16, 0x0b, clamp(rr)), cg = lerp(0x22, 0x0f, clamp(rr)), cb2 = lerp(0x3f, 0x1c, clamp(rr));
        // faint grid
        const gx = Math.min(Math.abs(x - 96), Math.abs(x - 256), Math.abs(x - 416));
        const gy = Math.min(Math.abs(y - 128), Math.abs(y - 288), Math.abs(y - 432));
        const grid = Math.max(1 - smooth(1.5, 4.5, gx), 1 - smooth(1.5, 4.5, gy)) * 0.5;
        cr = lerp(cr, 0x23, grid); cg = lerp(cg, 0x32, grid); cb2 = lerp(cb2, 0x52, grid);
        // route casing + stroke
        const rd = routeDist(x, y);
        const casing = 1 - smooth(27, 31, rd.d);
        if (casing > 0) { cr = lerp(cr, 0x0b, casing); cg = lerp(cg, 0x1a, casing); cb2 = lerp(cb2, 0x33, casing); }
        const stroke = 1 - smooth(16, 20, rd.d);
        if (stroke > 0) { const c = grad(rd.t); cr = lerp(cr, c[0], stroke); cg = lerp(cg, c[1], stroke); cb2 = lerp(cb2, c[2], stroke); }
        // origin dot
        const od = Math.hypot(x - 128, y - 424);
        const ow = 1 - smooth(28, 32, od);
        if (ow > 0) { cr = lerp(cr, 255, ow); cg = lerp(cg, 255, ow); cb2 = lerp(cb2, 255, ow); }
        const oi = 1 - smooth(17, 21, od);
        if (oi > 0) { cr = lerp(cr, 0x2f, oi); cg = lerp(cg, 0x7f, oi); cb2 = lerp(cb2, 0xf6, oi); }
        // destination pin
        const pa = pinAlpha(x, y);
        if (pa > 0) { cr = lerp(cr, 0xef, pa); cg = lerp(cg, 0x44, pa); cb2 = lerp(cb2, 0x44, pa); }
        const pd = Math.hypot(x - 400, y - 130);
        const pw = 1 - smooth(18, 22, pd);
        if (pw > 0) { cr = lerp(cr, 255, pw); cg = lerp(cg, 255, pw); cb2 = lerp(cb2, 255, pw); }
        r += cr * inside; g += cg * inside; b += cb2 * inside; a += inside;
      }
      const n = AA * AA, o = (py * N + px) * 4;
      const al = a / n;
      rgba[o] = al > 0 ? Math.round(r / a) : 0;
      rgba[o + 1] = al > 0 ? Math.round(g / a) : 0;
      rgba[o + 2] = al > 0 ? Math.round(b / a) : 0;
      rgba[o + 3] = Math.round(al * 255);
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
