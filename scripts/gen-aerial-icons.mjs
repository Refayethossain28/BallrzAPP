#!/usr/bin/env node
/**
 * Generates the Aerial app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-quotient-icons.mjs: IHDR + one deflated IDAT + IEND, CRC32 per chunk).
 * Rasterizes the same motif as aerial/icon.svg with anti-aliased
 * signed-distance drawing: a rounded night-navy → indigo tile (radial glow
 * from the upper middle), a slim pale aerial mast (capsule) standing on a
 * small base, three concentric electric-cyan broadcast arcs (round-capped ring
 * sectors clipped to a 45° sweep, -65° → -20°) rising from the mast tip to the
 * upper right with a #3ee0ff → #7cf0ff gradient along the sweep, and a tiny
 * warm amber beacon on the tip. Writes icon-180/192/512.png into aerial/.
 *
 * Run: node scripts/gen-aerial-icons.mjs
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'aerial');

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
const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rad = (deg) => deg * Math.PI / 180;
// signed distance to a rounded rect (negative inside)
function roundRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// signed distance to a capsule: the segment a→b thickened by halfW, round ends
function capsuleDist(px, py, ax, ay, bx, by, halfW) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t)) - halfW;
}
// signed distance to a round-capped arc: the ring of radius r around (cx, cy),
// clipped to the angular sector a0..a1 (SVG orientation: y down, angles clockwise)
function arcDist(px, py, cx, cy, r, a0, a1, halfW) {
  const dx = px - cx, dy = py - cy;
  const mid = (a0 + a1) / 2, half = (a1 - a0) / 2;
  let rel = Math.atan2(dy, dx) - mid;
  rel = Math.atan2(Math.sin(rel), Math.cos(rel)); // wrap to [-π, π]
  if (Math.abs(rel) <= half) return Math.abs(Math.hypot(dx, dy) - r) - halfW; // inside the sweep: ring
  const a = rel < 0 ? a0 : a1;                                                  // outside: nearest round cap
  return Math.hypot(px - (cx + r * Math.cos(a)), py - (cy + r * Math.sin(a))) - halfW;
}

/* ---- the motif, in the SVG's 64-unit design space ---- */
const NAVY = rgb('#0b1020'), INDIGO = rgb('#2a2f7a');       // tile: indigo glow → night-navy rim
const MAST = rgb('#e6ebff');                                 // pale mast + base
const CYAN0 = rgb('#3ee0ff'), CYAN1 = rgb('#7cf0ff');        // arcs, graded along the sweep
const AMBER = rgb('#ffb454');                                // beacon
const TIP = [25, 28];                                        // mast tip = arc centre
const MAST_BOTTOM = 52, BASE_X = [19, 31];
const MAST_W = 3.2, ARC_W = 3.6, DOT_R = 2.6;
const ARC_R = [8, 15, 22];
const A0 = rad(-65), A1 = rad(-20);                          // the 45° sweep, upper right
const GRAD = [25, 28, 47, 6];                                // x1 y1 x2 y2 of the cyan gradient

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 64;
  const corner = 14 * S;
  const aa = 1.0; // one-pixel anti-aliasing ramp on every edge
  const gx = GRAD[2] - GRAD[0], gy = GRAD[3] - GRAD[1], gl = gx * gx + gy * gy;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const px = x + 0.5, py = y + 0.5;
      const rd = roundRectDist(px, py, N / 2, N / 2, N / 2, N / 2, corner);
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // radial tile: indigo glow at the upper middle falling to night navy at the rim
      const d = clamp(Math.hypot(x - N * 0.5, y - N * 0.25) / (N * 0.9), 0, 1);
      const c = [lerp(INDIGO[0], NAVY[0], d), lerp(INDIGO[1], NAVY[1], d), lerp(INDIGO[2], NAVY[2], d)];
      const paint = (col, dist) => {
        const a = clamp(0.5 - dist / aa, 0, 1);
        if (a > 0) { c[0] = lerp(c[0], col[0], a); c[1] = lerp(c[1], col[1], a); c[2] = lerp(c[2], col[2], a); }
      };

      // mast (capsule from the tip down) and its small base
      paint(MAST, capsuleDist(px, py, TIP[0] * S, TIP[1] * S, TIP[0] * S, MAST_BOTTOM * S, MAST_W / 2 * S));
      paint(MAST, capsuleDist(px, py, BASE_X[0] * S, MAST_BOTTOM * S, BASE_X[1] * S, MAST_BOTTOM * S, MAST_W / 2 * S));

      // three broadcast arcs, coloured by position along the up-right gradient (like the SVG's userSpaceOnUse gradient)
      const t = clamp(((px / S - GRAD[0]) * gx + (py / S - GRAD[1]) * gy) / gl, 0, 1);
      const cyan = [lerp(CYAN0[0], CYAN1[0], t), lerp(CYAN0[1], CYAN1[1], t), lerp(CYAN0[2], CYAN1[2], t)];
      for (const r of ARC_R) paint(cyan, arcDist(px, py, TIP[0] * S, TIP[1] * S, r * S, A0, A1, ARC_W / 2 * S));

      // the amber beacon on the tip
      paint(AMBER, Math.hypot(px - TIP[0] * S, py - TIP[1] * S) - DOT_R * S);

      rgba[i] = Math.round(c[0]); rgba[i + 1] = Math.round(c[1]); rgba[i + 2] = Math.round(c[2]);
      rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`aerial/icon-${n}.png`);
}
