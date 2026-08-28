#!/usr/bin/env node
/**
 * Generates the Parrot app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as parrot/icon.svg: a
 * radial-dark rounded square, a green play beak throwing three sound rings,
 * and the gold spark of the phrase it kept — a voice, replayed.
 *
 * Run: node scripts/gen-parrot-icons.mjs   (writes icon-180/192/512.png into parrot/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'parrot');

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
// the voice gradient: spring green → teal, along x+y
function voiceColor(t) {
  t = clamp(t, 0, 1);
  const a = [0x3f, 0xe3, 0xa6], b = [0x2d, 0xd4, 0xbf];
  return [0, 1, 2].map((i) => Math.round(lerp(a[i], b[i], t)));
}
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}
// distance to a filled triangle (0 inside, else distance to nearest edge)
function triDist(px, py, ax, ay, bx, by, cx2, cy2) {
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx2 - bx) * (py - by) - (cy2 - by) * (px - bx);
  const s3 = (ax - cx2) * (py - cy2) - (ay - cy2) * (px - cx2);
  const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  if (inside) return 0;
  return Math.min(capsuleDist(px, py, ax, ay, bx, by),
    capsuleDist(px, py, bx, by, cx2, cy2), capsuleDist(px, py, cx2, cy2, ax, ay));
}
// distance to a round-capped arc: center (cx,cy), radius R, half-width w,
// swept ±halfAngle around the +x axis
function arcDist(px, py, cx, cy, R, w, halfAngle) {
  const dx = px - cx, dy = py - cy;
  const r = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  if (Math.abs(ang) <= halfAngle) return Math.abs(r - R) - w;
  // outside the sweep: distance to the round end caps
  const ex = cx + R * Math.cos(halfAngle), eyTop = cy - R * Math.sin(halfAngle), eyBot = cy + R * Math.sin(halfAngle);
  return Math.min(Math.hypot(px - ex, py - eyTop), Math.hypot(px - ex, py - eyBot)) - w;
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

  const arcCx = 296 * S, arcCy = 256 * S;
  const HALF = 55 * Math.PI / 180;
  const RINGS = [
    [70 * S, 0.95],
    [110 * S, 0.65],
    [150 * S, 0.4],
  ];
  const ringW = 11 * S; // half of the 22px stroke

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square mask
      const qx = Math.abs(x - N / 2) - (N / 2 - corner);
      const qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // radial-dark background (green light falls from the upper middle)
      const dTop = Math.hypot(x - N * 0.5, y - N * 0.18) / (N * 0.95);
      let r = Math.round(lerp(0x14, 0x08, clamp(dTop, 0, 1)));
      let g = Math.round(lerp(0x24, 0x11, clamp(dTop, 0, 1)));
      let b = Math.round(lerp(0x1d, 0x0d, clamp(dTop, 0, 1)));

      const [vr, vg, vb] = voiceColor(clamp((x + y) / (2 * N), 0, 1));

      // the play beak
      const dTri = triDist(x, y, 150 * S, 176 * S, 150 * S, 336 * S, 286 * S, 256 * S);
      const aTri = clamp(0.5 - (dTri - 0.5) / aa, 0, 1);
      if (aTri > 0) { r = Math.round(lerp(r, vr, aTri)); g = Math.round(lerp(g, vg, aTri)); b = Math.round(lerp(b, vb, aTri)); }

      // three sound rings, fading outward
      for (const [R, op] of RINGS) {
        const d = arcDist(x, y, arcCx, arcCy, R, ringW, HALF);
        const a = clamp(0.5 - d / aa, 0, 1) * op;
        if (a > 0) { r = Math.round(lerp(r, vr, a)); g = Math.round(lerp(g, vg, a)); b = Math.round(lerp(b, vb, a)); }
      }

      // the gold spark it kept
      const dS = sparkDist(x, y, 420 * S, 128 * S, 46 * S, 13 * S);
      const aS = clamp(0.5 - dS / aa, 0, 1);
      if (aS > 0) { r = Math.round(lerp(r, 0xfb, aS)); g = Math.round(lerp(g, 0xbf, aS)); b = Math.round(lerp(b, 0x24, aS)); }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`parrot/icon-${n}.png`);
}
