#!/usr/bin/env node
/**
 * Generate Babel's PWA icons — the babel fish swimming through the
 * universal ring, hearing sound waves, speaking a gold spark back.
 * No image libraries, just Node's built-in zlib (same minimal PNG
 * encoder approach as gen-magpie-icons.mjs).
 * Run: node scripts/gen-babel-icons.mjs (writes icon-180/192/512.png into babel/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'babel');

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

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// the brand gradient: aurora cyan → violet → gold, along x+y
function brandColor(t) {
  t = clamp(t, 0, 1);
  const stops = [[0x4d, 0xe1, 0xff], [0x9f, 0x6b, 0xf7], [0xe8, 0xb3, 0x4c]];
  const seg = t < 0.55 ? 0 : 1;
  const lt = seg === 0 ? t / 0.55 : (t - 0.55) / 0.45;
  return [0, 1, 2].map((i) => Math.round(lerp(stops[seg][i], stops[seg + 1][i], lt)));
}

// distance to a filled triangle (0 inside, else distance to nearest edge)
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}
function triDist(px, py, ax, ay, bx, by, cx2, cy2) {
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx2 - bx) * (py - by) - (cy2 - by) * (px - bx);
  const s3 = (ax - cx2) * (py - cy2) - (ay - cy2) * (px - cx2);
  const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  if (inside) return 0;
  return Math.min(capsuleDist(px, py, ax, ay, bx, by),
    capsuleDist(px, py, bx, by, cx2, cy2), capsuleDist(px, py, cx2, cy2, ax, ay));
}
// distance to a 4-point sparkle (union of two thin diamonds)
function sparkDist(px, py, cx, cy, r, w) {
  const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
  const d1 = dx / w + dy / r - 1;
  const d2 = dx / r + dy / w - 1;
  return Math.min(d1, d2) * Math.min(w, r) * 0.7;
}
// distance along a circular arc between angles a0..a1 (radians)
function arcDist(px, py, cx, cy, r, a0, a1) {
  const dx = px - cx, dy = py - cy;
  const ang = Math.atan2(dy, dx);
  if (ang >= a0 && ang <= a1) return Math.abs(Math.hypot(dx, dy) - r);
  const e0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
  const e1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  return Math.min(Math.hypot(px - e0[0], py - e0[1]), Math.hypot(px - e1[0], py - e1[1]));
}
// signed distance to an ellipse fill (approximate, in output px)
function ellipseDist(px, py, cx, cy, rx, ry) {
  return (Math.hypot((px - cx) / rx, (py - cy) / ry) - 1) * Math.min(rx, ry);
}

function render(N) {
  const S = N / 512, aa = 1.0;
  const rgba = Buffer.alloc(N * N * 4);
  const ringR = 150 * S, ringW = 18 * S;
  const corner = 116 * S;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square icon mask
      const qx = Math.abs(x - N / 2) - (N / 2 - corner), qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // background: light falls from the top
      const glow = clamp(Math.hypot(x - 0.5 * N, y - 0.18 * N) / (0.9 * N), 0, 1);
      let r = Math.round(lerp(0x14, 0x0b, glow));
      let g = Math.round(lerp(0x1d, 0x0e, glow));
      let b = Math.round(lerp(0x3c, 0x1a, glow));

      const grad = brandColor(clamp((x + y) / (2 * N), 0, 1));
      const paint = (d, col, op) => {
        const a = clamp(0.5 - d / aa, 0, 1) * (op == null ? 1 : op);
        if (a > 0) { r = Math.round(lerp(r, col[0], a)); g = Math.round(lerp(g, col[1], a)); b = Math.round(lerp(b, col[2], a)); }
      };

      // the universal ring
      paint(Math.abs(Math.hypot(x - 256 * S, y - 256 * S) - ringR) - ringW / 2, grad);
      // sound waves, upper left
      paint(arcDist(x, y, 256 * S, 256 * S, 190 * S, -Math.PI * 0.92, -Math.PI * 0.62) - 6 * S, [0x4d, 0xe1, 0xff], 0.85);
      paint(arcDist(x, y, 256 * S, 256 * S, 228 * S, -Math.PI * 0.9, -Math.PI * 0.64) - 6 * S, [0x9f, 0x6b, 0xff], 0.55);
      // the babel fish: body, tail, eye
      paint(ellipseDist(x, y, 240 * S, 256 * S, 96 * S, 52 * S), grad);
      paint(triDist(x, y, 322 * S, 256 * S, 396 * S, 208 * S, 396 * S, 304 * S), grad);
      paint(Math.hypot(x - 196 * S, y - 242 * S) - 13 * S, [0x0b, 0x0e, 0x1a]);
      // the spoken spark
      paint(sparkDist(x, y, 372 * S, 390 * S, 42 * S, 12 * S), [0xe8, 0xb3, 0x4c]);

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b;
      rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`babel/icon-${n}.png`);
}
