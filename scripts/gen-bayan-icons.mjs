#!/usr/bin/env node
/**
 * Generates the Bayan app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as bayan/icon.svg: a
 * midnight-indigo rounded square holding a gold calligraphic bāʾ bowl
 * with its upturned right tip and the dot beneath — the first letter of
 * بيان and of the basmala — with a four-point gold star above.
 *
 * Run: node scripts/gen-bayan-icons.mjs   (writes icon-180/192/512.png into bayan/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bayan');

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
// the brand gold: light amber → deep amber, along x+y
function goldColor(t) {
  t = clamp(t, 0, 1);
  return [Math.round(lerp(0xe8, 0xc9, t)), Math.round(lerp(0xc4, 0x8f, t)), Math.round(lerp(0x76, 0x2e, t))];
}
// distance to a capsule (segment; caller subtracts the radius)
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}
// distance to a stroked circular arc (angles in degrees, y-down screen space)
function arcDist(px, py, cx, cy, R, a0, a1) {
  const dx = px - cx, dy = py - cy;
  const ang = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180, +90 is straight down
  if (ang >= a0 && ang <= a1) return Math.abs(Math.hypot(dx, dy) - R);
  const p0 = [cx + R * Math.cos(a0 * Math.PI / 180), cy + R * Math.sin(a0 * Math.PI / 180)];
  const p1 = [cx + R * Math.cos(a1 * Math.PI / 180), cy + R * Math.sin(a1 * Math.PI / 180)];
  return Math.min(Math.hypot(px - p0[0], py - p0[1]), Math.hypot(px - p1[0], py - p1[1]));
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

  // bowl geometry (from icon.svg): endpoints (401,249)-(111,249), R=160,
  // so the center sits at (256, 249 − √(160²−145²)) ≈ (256, 181.4).
  const bowlCx = 256 * S, bowlCy = 181.36 * S, bowlR = 160 * S;
  const bowlA0 = 25.0, bowlA1 = 155.0; // through the bottom (90° is down)
  const strokeW = 17 * S;              // half of the 34-wide stroke

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square mask
      const qx = Math.abs(x - N / 2) - (N / 2 - corner);
      const qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // midnight-indigo radial background, lit from the upper left
      const dTop = clamp(Math.hypot(x - N * 0.35, y - N * 0.22) / (N * 0.95), 0, 1);
      let r = Math.round(lerp(0x23, 0x0b, dTop));
      let g = Math.round(lerp(0x2c, 0x0e, dTop));
      let b = Math.round(lerp(0x52, 0x1c, dTop));

      const [gr, gg, gb] = goldColor(clamp((x + y) / (2 * N), 0, 1));

      // the bāʾ bowl + its upturned right tip (one stroked path, round caps)
      const dBowl = Math.min(
        arcDist(x, y, bowlCx, bowlCy, bowlR, bowlA0, bowlA1),
        capsuleDist(x, y, 401 * S, 185 * S, 401 * S, 249 * S)
      ) - strokeW;
      const aBowl = clamp(0.5 - dBowl / aa, 0, 1);
      if (aBowl > 0) { r = Math.round(lerp(r, gr, aBowl)); g = Math.round(lerp(g, gg, aBowl)); b = Math.round(lerp(b, gb, aBowl)); }

      // the dot beneath the bowl
      const dDot = Math.hypot(x - 256 * S, y - 400 * S) - 23 * S;
      const aDot = clamp(0.5 - dDot / aa, 0, 1);
      if (aDot > 0) { r = Math.round(lerp(r, gr, aDot)); g = Math.round(lerp(g, gg, aDot)); b = Math.round(lerp(b, gb, aDot)); }

      // the four-point star above
      const dS = sparkDist(x, y, 160 * S, 154 * S, 36 * S, 12 * S);
      const aS = clamp(0.5 - dS / aa, 0, 1);
      if (aS > 0) { r = Math.round(lerp(r, 0xe8, aS)); g = Math.round(lerp(g, 0xc4, aS)); b = Math.round(lerp(b, 0x76, aS)); }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`bayan/icon-${n}.png`);
}
