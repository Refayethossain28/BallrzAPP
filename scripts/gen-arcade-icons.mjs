#!/usr/bin/env node
/**
 * Generates the Arcade app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as arcade/icon.svg: a
 * radial-dark rounded square holding a gradient-ringed screen with two
 * glowing scanlines, a gradient d-pad cross, and the console's two round
 * buttons — gold A, violet B.
 *
 * Run: node scripts/gen-arcade-icons.mjs   (writes icon-180/192/512.png into arcade/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'arcade');

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
// the brand gradient: cyan → violet → gold, along x+y
function brandColor(t) {
  t = clamp(t, 0, 1);
  const stops = [[0x4d, 0xd8, 0xff], [0x8f, 0x7c, 0xf7], [0xe8, 0xb3, 0x4c]];
  const seg = t < 0.55 ? 0 : 1;
  const lt = seg === 0 ? t / 0.55 : (t - 0.55) / 0.45;
  return [0, 1, 2].map((i) => Math.round(lerp(stops[seg][i], stops[seg + 1][i], lt)));
}
// distance to a capsule (segment; caller subtracts the radius)
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}
// signed distance to a rounded-rect border (negative inside)
function roundRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 116 * S;
  const aa = 1.0; // anti-alias feather in px

  // screen ring (from icon.svg geometry: x116 y88 w280 h128 r22, stroke 18)
  const scrCx = 256 * S, scrCy = 152 * S, scrHw = 140 * S, scrHh = 64 * S, scrR = 22 * S, scrW = 18 * S;
  // scanlines inside the screen
  const LINES = [
    [163, 135, 269, 135, [0x4d, 0xd8, 0xff], 1.0],
    [163, 169, 225, 169, [0x8f, 0x7c, 0xf7], 0.8],
  ];
  const lineW = 7 * S;
  // d-pad arms (horizontal and vertical capsules, r 26)
  const dpadR = 26 * S;
  const DPAD = [
    [136, 340, 216, 340],
    [176, 300, 176, 380],
  ];
  // buttons
  const BUTTONS = [
    [340, 316, 30, [0xe8, 0xb3, 0x4c]],
    [404, 364, 30, [0x8f, 0x7c, 0xf7]],
  ];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square mask
      const qx = Math.abs(x - N / 2) - (N / 2 - corner);
      const qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // radial-dark background (light falls from the upper middle)
      const dTop = Math.hypot(x - N * 0.5, y - N * 0.18) / (N * 0.9);
      let r = Math.round(lerp(0x16, 0x0a, clamp(dTop, 0, 1)));
      let g = Math.round(lerp(0x20, 0x0d, clamp(dTop, 0, 1)));
      let b = Math.round(lerp(0x3d, 0x16, clamp(dTop, 0, 1)));

      const grad = clamp((x + y) / (2 * N), 0, 1);
      const [br, bg, bb] = brandColor(grad);

      // scanlines inside the screen
      for (const [ax, ay, bx2, by2, col, op] of LINES) {
        const d = capsuleDist(x, y, ax * S, ay * S, bx2 * S, by2 * S) - lineW;
        const a = clamp(0.5 - d / aa, 0, 1) * op;
        if (a > 0) { r = Math.round(lerp(r, col[0], a)); g = Math.round(lerp(g, col[1], a)); b = Math.round(lerp(b, col[2], a)); }
      }

      // the screen's gradient ring
      const dScr = Math.abs(roundRectDist(x, y, scrCx, scrCy, scrHw, scrHh, scrR)) - scrW / 2;
      const aScr = clamp(0.5 - dScr / aa, 0, 1);
      if (aScr > 0) { r = Math.round(lerp(r, br, aScr)); g = Math.round(lerp(g, bg, aScr)); b = Math.round(lerp(b, bb, aScr)); }

      // the d-pad cross
      for (const [ax, ay, bx2, by2] of DPAD) {
        const d = capsuleDist(x, y, ax * S, ay * S, bx2 * S, by2 * S) - dpadR;
        const a = clamp(0.5 - d / aa, 0, 1);
        if (a > 0) { r = Math.round(lerp(r, br, a)); g = Math.round(lerp(g, bg, a)); b = Math.round(lerp(b, bb, a)); }
      }

      // the two round buttons
      for (const [cx, cy, rad, col] of BUTTONS) {
        const d = Math.hypot(x - cx * S, y - cy * S) - rad * S;
        const a = clamp(0.5 - d / aa, 0, 1);
        if (a > 0) { r = Math.round(lerp(r, col[0], a)); g = Math.round(lerp(g, col[1], a)); b = Math.round(lerp(b, col[2], a)); }
      }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`arcade/icon-${n}.png`);
}
