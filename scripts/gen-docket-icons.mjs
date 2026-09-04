#!/usr/bin/env node
/**
 * Generates the Docket app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as docket/icon.svg: a
 * radial-dark rounded square holding a pile of two page cards (the one
 * behind faded, the document on top stroked in the amber→orange brand
 * gradient with text lines) and the assistant's green tick badge —
 * paperwork, dealt with.
 *
 * Run: node scripts/gen-docket-icons.mjs   (writes icon-180/192/512.png into docket/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docket');

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
// the brand gradient: amber → burnt orange, along x+y
function brandColor(t) {
  t = clamp(t, 0, 1);
  return [Math.round(lerp(0xf2, 0xe8, t)), Math.round(lerp(0xb0, 0x82, t)), Math.round(lerp(0x4a, 0x5a, t))];
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

  // geometry from icon.svg
  const back = { cx: 274 * S, cy: 236 * S, hw: 106 * S, hh: 134 * S, r: 22 * S, w: 14 * S };
  const front = { cx: 238 * S, cy: 274 * S, hw: 106 * S, hh: 134 * S, r: 22 * S, w: 18 * S };
  const LINES = [
    [170, 204, 306, 204, [0xf2, 0xb0, 0x4a], 1.0],
    [170, 256, 288, 256, [0xe8, 0x82, 0x5a], 0.85],
    [170, 308, 306, 308, [0xe8, 0x82, 0x5a], 0.55],
  ];
  const lineW = 8 * S;
  const tick = { cx: 376 * S, cy: 376 * S, r: 86 * S };
  const CHECK = [[336, 378, 366, 408], [366, 408, 420, 344]];
  const checkW = 11 * S;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square mask
      const qx = Math.abs(x - N / 2) - (N / 2 - corner);
      const qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // radial-dark warm background (light falls from the upper middle)
      const dTop = Math.hypot(x - N * 0.5, y - N * 0.18) / (N * 0.9);
      let r = Math.round(lerp(0x2c, 0x12, clamp(dTop, 0, 1)));
      let g = Math.round(lerp(0x23, 0x10, clamp(dTop, 0, 1)));
      let b = Math.round(lerp(0x13, 0x0c, clamp(dTop, 0, 1)));

      const [br, bg, bb] = brandColor(clamp((x + y) / (2 * N), 0, 1));

      // the page behind, faded
      const dBack = Math.abs(roundRectDist(x, y, back.cx, back.cy, back.hw, back.hh, back.r)) - back.w / 2;
      const aBack = clamp(0.5 - dBack / aa, 0, 1) * 0.28;
      if (aBack > 0) { r = Math.round(lerp(r, 0xf2, aBack)); g = Math.round(lerp(g, 0xb0, aBack)); b = Math.round(lerp(b, 0x4a, aBack)); }

      // the document on top: brand-gradient ring
      const dFront = Math.abs(roundRectDist(x, y, front.cx, front.cy, front.hw, front.hh, front.r)) - front.w / 2;
      const aFront = clamp(0.5 - dFront / aa, 0, 1);
      if (aFront > 0) { r = Math.round(lerp(r, br, aFront)); g = Math.round(lerp(g, bg, aFront)); b = Math.round(lerp(b, bb, aFront)); }

      // its text lines
      for (const [ax, ay, bx2, by2, col, op] of LINES) {
        const d = capsuleDist(x, y, ax * S, ay * S, bx2 * S, by2 * S) - lineW;
        const a = clamp(0.5 - d / aa, 0, 1) * op;
        if (a > 0) { r = Math.round(lerp(r, col[0], a)); g = Math.round(lerp(g, col[1], a)); b = Math.round(lerp(b, col[2], a)); }
      }

      // the assistant's tick badge, drawn last so it sits on top of the pile
      const dTick = Math.hypot(x - tick.cx, y - tick.cy) - tick.r;
      const aTick = clamp(0.5 - dTick / aa, 0, 1);
      if (aTick > 0) { r = Math.round(lerp(r, 0x58, aTick)); g = Math.round(lerp(g, 0xcf, aTick)); b = Math.round(lerp(b, 0x8e, aTick)); }
      for (const [ax, ay, bx2, by2] of CHECK) {
        const d = capsuleDist(x, y, ax * S, ay * S, bx2 * S, by2 * S) - checkW;
        const a = clamp(0.5 - d / aa, 0, 1) * aTick;
        if (a > 0) { r = Math.round(lerp(r, 0x12, a)); g = Math.round(lerp(g, 0x10, a)); b = Math.round(lerp(b, 0x0c, a)); }
      }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`docket/icon-${n}.png`);
}
