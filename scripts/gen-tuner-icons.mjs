#!/usr/bin/env node
/**
 * Generates the Tuner app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (the same minimal PNG encoder as gen-aerial-icons.mjs:
 * IHDR + one deflated IDAT + IEND, CRC32 per chunk). Rasterizes the same
 * motif as tuner/icon.svg with anti-aliased signed-distance drawing: a rounded
 * warm near-black tile (brown glow from the upper middle), a brass tuning-dial
 * ring (r 17 around the hub at 32,34, graded #e0b25a → #f2cf80 up and to the
 * right), a pale needle from the hub pointing up-right at -50°, a brass hub
 * dot, and a red "on air" dot on the ring where the needle points. Writes
 * icon-180/192/512.png into tuner/.
 *
 * Run: node scripts/gen-tuner-icons.mjs
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tuner');

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
// signed distance to a ring of radius r and stroke 2·halfW
const ringDist = (px, py, cx, cy, r, halfW) => Math.abs(Math.hypot(px - cx, py - cy) - r) - halfW;

/* ---- the motif, in the SVG's 64-unit design space ---- */
const INK = rgb('#121010'), GLOW = rgb('#3a2b14');            // tile: brown glow → warm near-black rim
const BRASS0 = rgb('#e0b25a'), BRASS1 = rgb('#f2cf80');       // dial ring, graded along the up-right gradient
const NEEDLE = rgb('#f2ece3');                                 // pale needle
const HUB = rgb('#e0b25a');                                    // brass hub dot
const RED = rgb('#e5484d');                                    // the "on air" dot
const C = [32, 34];                                            // dial centre
const RING_R = 17, RING_W = 3.6, NEEDLE_W = 3.2, HUB_R = 2.8, DOT_R = 2.4;
const ANGLE = rad(-50);                                        // needle direction (y down, clockwise)
const NEEDLE_END = [C[0] + 13 * Math.cos(ANGLE), C[1] + 13 * Math.sin(ANGLE)];
const DOT = [C[0] + RING_R * Math.cos(ANGLE), C[1] + RING_R * Math.sin(ANGLE)];
const GRAD = [15, 51, 49, 17];                                 // x1 y1 x2 y2 of the brass gradient

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

      // radial tile: brown glow at the upper middle falling to warm near-black at the rim
      const d = clamp(Math.hypot(x - N * 0.5, y - N * 0.25) / (N * 0.9), 0, 1);
      const c = [lerp(GLOW[0], INK[0], d), lerp(GLOW[1], INK[1], d), lerp(GLOW[2], INK[2], d)];
      const paint = (col, dist) => {
        const a = clamp(0.5 - dist / aa, 0, 1);
        if (a > 0) { c[0] = lerp(c[0], col[0], a); c[1] = lerp(c[1], col[1], a); c[2] = lerp(c[2], col[2], a); }
      };

      // the dial ring, coloured by position along the up-right gradient (like the SVG's userSpaceOnUse gradient)
      const t = clamp(((px / S - GRAD[0]) * gx + (py / S - GRAD[1]) * gy) / gl, 0, 1);
      const brass = [lerp(BRASS0[0], BRASS1[0], t), lerp(BRASS0[1], BRASS1[1], t), lerp(BRASS0[2], BRASS1[2], t)];
      paint(brass, ringDist(px, py, C[0] * S, C[1] * S, RING_R * S, RING_W / 2 * S));

      // the needle and hub
      paint(NEEDLE, capsuleDist(px, py, C[0] * S, C[1] * S, NEEDLE_END[0] * S, NEEDLE_END[1] * S, NEEDLE_W / 2 * S));
      paint(HUB, Math.hypot(px - C[0] * S, py - C[1] * S) - HUB_R * S);

      // the red dot on the ring where the needle points
      paint(RED, Math.hypot(px - DOT[0] * S, py - DOT[1] * S) - DOT_R * S);

      rgba[i] = Math.round(c[0]); rgba[i + 1] = Math.round(c[1]); rgba[i + 2] = Math.round(c[2]);
      rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`tuner/icon-${n}.png`);
}
