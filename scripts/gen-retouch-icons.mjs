#!/usr/bin/env node
/**
 * Generates the Retouch app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as retouch/icon.svg: a
 * graphite rounded square holding a blue photo frame whose left half is
 * still "before" (dimmed), a white before/after divider down the middle,
 * mountains on the horizon and a sun that has already been warmed.
 *
 * Run: node scripts/gen-retouch-icons.mjs   (writes icon-180/192/512.png into retouch/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'retouch');

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
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---- helpers ---- */
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function roundRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// point-in-polygon (even-odd) for the mountain silhouette
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function mix(dst, col, a) { dst[0] = Math.round(lerp(dst[0], col[0], a)); dst[1] = Math.round(lerp(dst[1], col[1], a)); dst[2] = Math.round(lerp(dst[2], col[2], a)); }

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512, corner = 116 * S, aa = 1.0;
  const MOUNTAIN = [[130, 352], [212, 252], [268, 318], [306, 280], [382, 352]].map(([x, y]) => [x * S, y * S]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    const mask = clamp(0.5 - (roundRectDist(x, y, N / 2, N / 2, N / 2, N / 2, corner)) / aa, 0, 1);
    if (mask <= 0) { rgba[i + 3] = 0; continue; }
    const c = [0x1f, 0x22, 0x26];
    // blue photo frame
    const dFrame = roundRectDist(x, y, 256 * S, 256 * S, 168 * S, 136 * S, 36 * S);
    const aFrame = clamp(0.5 - dFrame / aa, 0, 1);
    if (aFrame > 0) mix(c, [0x2f, 0x6f, 0xe4], aFrame);
    // the "before" half: dimmed on the left of the divider
    if (aFrame > 0 && x < 256 * S) mix(c, [0x24, 0x26, 0x2b], 0.55 * aFrame);
    // mountains
    if (inPoly(x, y, MOUNTAIN)) {
      const inside = Math.min(1, aFrame);
      mix(c, [0xdf, 0xe8, 0xff], inside);
      if (x < 256 * S) mix(c, [0x24, 0x26, 0x2b], 0.55 * inside);
    }
    // the sun (already warmed)
    const dSun = Math.hypot(x - 338 * S, y - 196 * S) - 30 * S;
    const aSun = clamp(0.5 - dSun / aa, 0, 1);
    if (aSun > 0) mix(c, [0xff, 0xd5, 0x6a], aSun);
    // divider
    if (y >= 104 * S && y <= 408 * S) {
      const dDiv = Math.abs(x - 256 * S) - 2 * S;
      const aDiv = clamp(0.5 - dDiv / aa, 0, 1);
      if (aDiv > 0) mix(c, [0xff, 0xff, 0xff], aDiv);
    }
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = Math.round(mask * 255);
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`retouch/icon-${n}.png`);
}
