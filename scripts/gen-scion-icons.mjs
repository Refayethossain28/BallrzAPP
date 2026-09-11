#!/usr/bin/env node
/**
 * Generates the Scion app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-sonar-icons.mjs). Rasterizes the same motif as scion/icon.svg: a
 * radial-dark rounded square and a gold three-point crown — the succession —
 * with a gem on each point, the tallest (the successor) shining brightest.
 *
 * Run: node scripts/gen-scion-icons.mjs   (writes icon-180/192/512.png into scion/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scion');

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
const clamp01 = (t) => clamp(t, 0, 1);

// the brand gradient: pale gold → deep gold, upper-left to lower-right
function goldColor(N, x, y) {
  const t = clamp01((x + y) / (2 * N));
  return [Math.round(lerp(0xe9, 0xb0, t)), Math.round(lerp(0xc8, 0x8c, t)), Math.round(lerp(0x7d, 0x3a, t))];
}

// signed distance to a triangle (negative inside)
function triDist(px, py, ax, ay, bx, by, cx, cy) {
  const seg = (vx, vy, ex, ey) => {
    const t = clamp01((vx * ex + vy * ey) / (ex * ex + ey * ey));
    const dx = vx - ex * t, dy = vy - ey * t;
    return dx * dx + dy * dy;
  };
  const e0x = bx - ax, e0y = by - ay, e1x = cx - bx, e1y = cy - by, e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay, v1x = px - bx, v1y = py - by, v2x = px - cx, v2y = py - cy;
  const d = Math.sqrt(Math.min(seg(v0x, v0y, e0x, e0y), seg(v1x, v1y, e1x, e1y), seg(v2x, v2y, e2x, e2y)));
  const c0 = v0x * e0y - v0y * e0x, c1 = v1x * e1y - v1y * e1x, c2 = v2x * e2y - v2y * e2x;
  const inside = (c0 >= 0 && c1 >= 0 && c2 >= 0) || (c0 <= 0 && c1 <= 0 && c2 <= 0);
  return inside ? -d : d;
}

// signed distance to a rounded rectangle (center cx,cy half-size hx,hy corner r)
function rrectDist(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r), qy = Math.abs(py - cy) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 116 * S;
  const aa = 1.0; // anti-alias feather in px

  // the crown (from icon.svg): band + three points, gems on the tips
  const SPIKES = [
    [140 * S, 344 * S, 214 * S, 344 * S, 162 * S, 214 * S], // left point
    [216 * S, 344 * S, 296 * S, 344 * S, 256 * S, 158 * S], // the successor — tallest
    [298 * S, 344 * S, 372 * S, 344 * S, 350 * S, 214 * S], // right point
  ];
  const GEMS = [
    [162 * S, 206 * S, 20 * S, 0.85],
    [256 * S, 146 * S, 26 * S, 1.0], // brightest — the scion itself
    [350 * S, 206 * S, 20 * S, 0.85],
  ];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square mask
      const rd = rrectDist(x, y, N / 2, N / 2, N / 2, N / 2, corner);
      const mask = clamp01(0.5 - rd / aa);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // radial-dark ink background (light falls from the upper middle)
      const dTop = clamp01(Math.hypot(x - N * 0.5, y - N * 0.2) / (N * 0.95));
      let r = Math.round(lerp(0x2a, 0x0e, dTop));
      let g = Math.round(lerp(0x24, 0x0c, dTop));
      let b = Math.round(lerp(0x45, 0x16, dTop));

      const [gr, gg, gb] = goldColor(N, x, y);

      // crown body: the band and the three points, one union
      let d = rrectDist(x, y, 256 * S, 372 * S, 120 * S, 28 * S, 12 * S);
      for (const [ax, ay, bx, by, cx, cy] of SPIKES) d = Math.min(d, triDist(x, y, ax, ay, bx, by, cx, cy));
      const aCrown = clamp01(0.5 - d / aa);
      if (aCrown > 0) { r = Math.round(lerp(r, gr, aCrown)); g = Math.round(lerp(g, gg, aCrown)); b = Math.round(lerp(b, gb, aCrown)); }

      // gems: brighter gold dots on the points
      for (const [cx, cy, rad, op] of GEMS) {
        const dg = Math.hypot(x - cx, y - cy) - rad;
        const ag = clamp01(0.5 - dg / aa) * op;
        if (ag > 0) { r = Math.round(lerp(r, 0xf6, ag)); g = Math.round(lerp(g, 0xdf, ag)); b = Math.round(lerp(b, 0x9a, ag)); }
      }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`scion/icon-${n}.png`);
}
