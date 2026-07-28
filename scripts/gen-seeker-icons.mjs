#!/usr/bin/env node
/**
 * Generates the Seeker app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-cusp-icons.mjs).
 * Rasterizes the same motif as seeker/icon.svg: a radial-dark rounded square
 * holding a gradient magnifying-glass ring with a handle and a gold spark at
 * the centre — the found thing.
 *
 * Run: node scripts/gen-seeker-icons.mjs   (writes icon-180/192/512.png into seeker/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'seeker');

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
// the brand ring gradient: blue → violet → gold, along x+y
function ringColor(t) {
  t = clamp(t, 0, 1);
  const stops = [[0x4d, 0x9f, 0xff], [0x9f, 0x6b, 0xff], [0xe8, 0xb3, 0x4c]];
  const seg = t < 0.55 ? 0 : 1;
  const lt = seg === 0 ? t / 0.55 : (t - 0.55) / 0.45;
  return [0, 1, 2].map((i) => Math.round(lerp(stops[seg][i], stops[seg + 1][i], lt)));
}
// signed distance to a capsule (segment with radius)
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 116 * S;
  const cx = 228 * S, cy = 222 * S, lensR = 108 * S, ringW = 34 * S;
  const hAx = 312 * S, hAy = 308 * S, hBx = 396 * S, hBy = 392 * S, hW = 23 * S;
  const sparkR = 14 * S;
  const aa = 1.0; // anti-alias feather in px

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
      let r = Math.round(lerp(0x14, 0x07, clamp(dTop, 0, 1)));
      let g = Math.round(lerp(0x20, 0x0a, clamp(dTop, 0, 1)));
      let b = Math.round(lerp(0x3d, 0x14, clamp(dTop, 0, 1)));

      const grad = clamp((x + y) / (2 * N), 0, 1);
      const [rr, rg, rb] = ringColor(grad);

      // lens glass tint (inside the ring)
      const dLens = Math.hypot(x - cx, y - cy);
      if (dLens < lensR - ringW / 2) {
        const t = 0.16 * (1 - dLens / lensR);
        r = Math.round(lerp(r, rr, t)); g = Math.round(lerp(g, rg, t)); b = Math.round(lerp(b, rb, t));
      }

      // handle (draw under the ring)
      const dH = capsuleDist(x, y, hAx, hAy, hBx, hBy) - hW;
      const aH = clamp(0.5 - dH / aa, 0, 1);
      if (aH > 0) { r = Math.round(lerp(r, rr, aH)); g = Math.round(lerp(g, rg, aH)); b = Math.round(lerp(b, rb, aH)); }

      // the ring itself
      const dRing = Math.abs(dLens - lensR) - ringW / 2;
      const aR = clamp(0.5 - dRing / aa, 0, 1);
      if (aR > 0) { r = Math.round(lerp(r, rr, aR)); g = Math.round(lerp(g, rg, aR)); b = Math.round(lerp(b, rb, aR)); }

      // glint on the upper-left of the ring glass
      const dG = Math.hypot(x - (cx - lensR * 0.38), y - (cy - lensR * 0.52));
      const aG = clamp(0.5 - (dG - lensR * 0.22) / (lensR * 0.18), 0, 1) * 0.35;
      if (aG > 0 && dLens < lensR) { r = Math.round(lerp(r, 0xdb, aG)); g = Math.round(lerp(g, 0xe9, aG)); b = Math.round(lerp(b, 0xff, aG)); }

      // gold spark at the centre — the found thing
      const dS = dLens - sparkR;
      const aS = clamp(0.5 - dS / aa, 0, 1);
      if (aS > 0) { r = Math.round(lerp(r, 0xe8, aS)); g = Math.round(lerp(g, 0xb3, aS)); b = Math.round(lerp(b, 0x4c, aS)); }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`seeker/icon-${n}.png`);
}
