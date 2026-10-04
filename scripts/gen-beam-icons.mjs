#!/usr/bin/env node
/**
 * Generates the Beam app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as beam/icon.svg: a
 * near-black rounded square with a faint radial glow top-left, an amber QR
 * finder pattern (outer ring, light gap, 3x3 core) at the lower-left, and
 * three tapered light rays — teal fading to amber — fanning up-right from the
 * finder's corner: a file leaving one phone's screen as light.
 *
 * Run: node scripts/gen-beam-icons.mjs   (writes icon-180/192/512.png into beam/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'beam');

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
const AMBER = [0xff, 0xb0, 0x20];
const TEAL = [0x5e, 0xea, 0xd4];
// signed distance to an axis-aligned box (negative inside)
function boxDist(px, py, x0, y0, x1, y1) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
  const qx = Math.abs(px - cx) - hw, qy = Math.abs(py - cy) - hh;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}
// signed distance to a convex polygon given counter- or clockwise (negative inside)
function polyDist(px, py, pts) {
  let d = Infinity, inside = true, sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const ex = bx - ax, ey = by - ay;
    const t = clamp(((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey), 0, 1);
    d = Math.min(d, Math.hypot(px - (ax + ex * t), py - (ay + ey * t)));
    const s = Math.sign(ex * (py - ay) - ey * (px - ax));
    if (s !== 0) { if (sign === 0) sign = s; else if (s !== sign) inside = false; }
  }
  return inside ? -d : d;
}

/* ---- motif geometry, 512 design space (identical to beam/icon.svg) ---- */
const FINDER = { x0: 92, y0: 224, x1: 288, y1: 420, module: 28 }; // 7x7 modules, centre 190,322
const RAY_A = [292, 220], RAY_B = [470, 60]; // gradient axis: teal at the finder → amber at the tip
const RAYS = [
  { pts: [[296.0, 224.5], [482.1, 78.4], [452.7, 45.7], [288.0, 215.5]], op: 0.95 },
  { pts: [[294.1, 225.6], [500.6, 167.5], [485.6, 126.1], [289.9, 214.4]], op: 0.70 },
  { pts: [[297.4, 222.6], [405.6, 37.3], [366.0, 18.0], [286.6, 217.4]], op: 0.45 },
];

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512;
  const corner = 116 * S;
  const aa = 1.0; // anti-alias feather in px
  const m = FINDER.module * S;
  const fx0 = FINDER.x0 * S, fy0 = FINDER.y0 * S, fx1 = FINDER.x1 * S, fy1 = FINDER.y1 * S;
  const rays = RAYS.map((r) => ({ op: r.op, pts: r.pts.map(([x, y]) => [x * S, y * S]) }));
  const gax = RAY_A[0] * S, gay = RAY_A[1] * S, gbx = RAY_B[0] * S - gax, gby = RAY_B[1] * S - gay;
  const gLen2 = gbx * gbx + gby * gby;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const px = x + 0.5, py = y + 0.5;
      // rounded-square mask
      const qx = Math.abs(px - N / 2) - (N / 2 - corner);
      const qy = Math.abs(py - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // near-black background with a faint radial glow top-left (cx 20%, cy 15%, r 95%)
      const g = clamp(Math.hypot(px - N * 0.20, py - N * 0.15) / (N * 0.95), 0, 1);
      let r = lerp(0x1b, 0x0a, g), gg = lerp(0x24, 0x0e, g), b = lerp(0x46, 0x1a, g);

      // the three light rays (drawn under the finder), teal → amber along the fan axis
      for (const ray of rays) {
        const d = polyDist(px, py, ray.pts);
        const a = clamp(0.5 - d / aa, 0, 1) * ray.op;
        if (a > 0) {
          const t = clamp(((px - gax) * gbx + (py - gay) * gby) / gLen2, 0, 1);
          r = lerp(r, lerp(TEAL[0], AMBER[0], t), a);
          gg = lerp(gg, lerp(TEAL[1], AMBER[1], t), a);
          b = lerp(b, lerp(TEAL[2], AMBER[2], t), a);
        }
      }

      // QR finder pattern: outer 7x7 minus the 5x5 light gap, plus the 3x3 core
      const dOuter = boxDist(px, py, fx0, fy0, fx1, fy1);
      const dGap = boxDist(px, py, fx0 + m, fy0 + m, fx1 - m, fy1 - m);
      const dCore = boxDist(px, py, fx0 + 2 * m, fy0 + 2 * m, fx1 - 2 * m, fy1 - 2 * m);
      const dRing = Math.max(dOuter, -dGap); // ring = outer ∩ ¬gap
      const dFinder = Math.min(dRing, dCore);
      const aF = clamp(0.5 - dFinder / aa, 0, 1);
      if (aF > 0) { r = lerp(r, AMBER[0], aF); gg = lerp(gg, AMBER[1], aF); b = lerp(b, AMBER[2], aF); }

      rgba[i] = Math.round(r); rgba[i + 1] = Math.round(gg); rgba[i + 2] = Math.round(b); rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`beam/icon-${n}.png`);
}
