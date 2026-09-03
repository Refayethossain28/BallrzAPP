#!/usr/bin/env node
/**
 * Generates the Sonar app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as sonar/icon.svg: a
 * radial-dark rounded square, three sonar ping arcs radiating from the
 * emitter dot toward the upper right, and the gold blip it just found.
 *
 * Run: node scripts/gen-sonar-icons.mjs   (writes icon-180/192/512.png into sonar/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'sonar');

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
// the brand gradient: cyan → green, running lower-left to upper-right
function brandColor(N, x, y) {
  const t = clamp((x + (N - y)) / (2 * N), 0, 1);
  return [Math.round(lerp(0x4d, 0x3e, t)), Math.round(lerp(0xd8, 0xcf, t)), Math.round(lerp(0xff, 0x8e, t))];
}
// distance to an arc of circle (cx,cy,r) spanning [a1,a2] radians, round caps
function arcDist(px, py, cx, cy, r, a1, a2) {
  const dx = px - cx, dy = py - cy;
  const ang = Math.atan2(dy, dx);
  if (ang >= a1 && ang <= a2) return Math.abs(Math.hypot(dx, dy) - r);
  const e1x = cx + r * Math.cos(a1), e1y = cy + r * Math.sin(a1);
  const e2x = cx + r * Math.cos(a2), e2y = cy + r * Math.sin(a2);
  return Math.min(Math.hypot(px - e1x, py - e1y), Math.hypot(px - e2x, py - e2y));
}
// distance to a 4-point sparkle (union of two thin diamonds)
function sparkDist(px, py, cx, cy, r, w) {
  const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
  const d1 = dx / w + dy / r - 1;   // tall diamond
  const d2 = dx / r + dy / w - 1;   // wide diamond
  return Math.min(d1, d2) * Math.min(w, r) * 0.7; // approx px distance
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 116 * S;
  const aa = 1.0; // anti-alias feather in px

  // ping geometry (from icon.svg): emitter at (166,346), arcs spanning -95°…5°
  const ex = 166 * S, ey = 346 * S;
  const A1 = -95 * Math.PI / 180, A2 = 5 * Math.PI / 180;
  const ARCS = [[90, 1.0], [150, 0.7], [210, 0.45]];
  const arcW = 13 * S; // half of the 26-unit stroke

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
      let r = Math.round(lerp(0x10, 0x0a, clamp(dTop, 0, 1)));
      let g = Math.round(lerp(0x23, 0x0d, clamp(dTop, 0, 1)));
      let b = Math.round(lerp(0x3a, 0x16, clamp(dTop, 0, 1)));

      const [br, bg, bb] = brandColor(N, x, y);

      // the three ping arcs, fading outward
      for (const [radius, op] of ARCS) {
        const d = arcDist(x, y, ex, ey, radius * S, A1, A2) - arcW;
        const a = clamp(0.5 - d / aa, 0, 1) * op;
        if (a > 0) { r = Math.round(lerp(r, br, a)); g = Math.round(lerp(g, bg, a)); b = Math.round(lerp(b, bb, a)); }
      }

      // the emitter dot
      const dDot = Math.hypot(x - ex, y - ey) - 34 * S;
      const aDot = clamp(0.5 - dDot / aa, 0, 1);
      if (aDot > 0) { r = Math.round(lerp(r, br, aDot)); g = Math.round(lerp(g, bg, aDot)); b = Math.round(lerp(b, bb, aDot)); }

      // the gold blip it just found
      const dS = sparkDist(x, y, 400 * S, 118 * S, 44 * S, 13 * S);
      const aS = clamp(0.5 - dS / aa, 0, 1);
      if (aS > 0) { r = Math.round(lerp(r, 0xe8, aS)); g = Math.round(lerp(g, 0xb3, aS)); b = Math.round(lerp(b, 0x4c, aS)); }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`sonar/icon-${n}.png`);
}
