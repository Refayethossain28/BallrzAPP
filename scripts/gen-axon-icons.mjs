#!/usr/bin/env node
/**
 * Generates the Axon app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as axon/icon.svg: a
 * radial-dark rounded square holding the smallest possible mind — two cyan
 * sense nodes feeding three violet hidden neurons firing one gold answer,
 * synapses thick or thin by their learned weight.
 *
 * Run: node scripts/gen-axon-icons.mjs   (writes icon-180/192/512.png into axon/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'axon');

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
// the brand gradient along x+y: cyan → violet → gold (matches icon.svg's #g)
function brandColor(t) {
  t = clamp(t, 0, 1);
  const stops = [[0x4d, 0xd8, 0xff], [0x8f, 0x7c, 0xf7], [0xe8, 0xb3, 0x4c]];
  const seg = t < 0.55 ? 0 : 1;
  const lt = seg === 0 ? t / 0.55 : (t - 0.55) / 0.45;
  return [0, 1, 2].map((i) => Math.round(lerp(stops[seg][i], stops[seg + 1][i], lt)));
}
// distance to a segment (capsule body — the caller subtracts the half-width)
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}

/* ---- the motif, in icon.svg's 512-space ---- */
const IN = [[128, 188], [128, 324]];                    // cyan senses, r 34, stroke 14
const HID = [[256, 118], [256, 256], [256, 394]];       // violet hidden, r 30, stroke 13
const OUT_NODE = [388, 256];                            // gold answer, r 42, stroke 16, core 13
const LINKS = [
  [IN[0], HID[0], 14], [IN[0], HID[1], 7], [IN[0], HID[2], 10],
  [IN[1], HID[0], 6], [IN[1], HID[1], 15], [IN[1], HID[2], 8],
  [HID[0], OUT_NODE, 9], [HID[1], OUT_NODE, 16], [HID[2], OUT_NODE, 7],
];
const CYAN = [0x4d, 0xd8, 0xff], VIOLET = [0x8f, 0x7c, 0xf7], GOLD = [0xe8, 0xb3, 0x4c];
const NIGHT = [0x0a, 0x0d, 0x16];

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 116 * S;
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
      let r = Math.round(lerp(0x17, 0x0a, clamp(dTop, 0, 1)));
      let g = Math.round(lerp(0x12, 0x0d, clamp(dTop, 0, 1)));
      let b = Math.round(lerp(0x36, 0x16, clamp(dTop, 0, 1)));

      const paint = (a, col) => {
        if (a <= 0) return;
        r = Math.round(lerp(r, col[0], a)); g = Math.round(lerp(g, col[1], a)); b = Math.round(lerp(b, col[2], a));
      };

      // synapses, coloured by the brand gradient at this pixel
      const grad = brandColor((x + y) / (2 * N));
      for (const [[ax, ay], [bx, by], w] of LINKS) {
        const d = capsuleDist(x, y, ax * S, ay * S, bx * S, by * S) - (w / 2) * S;
        paint(clamp(0.5 - d / aa, 0, 1), grad);
      }

      // node rings: dark core + coloured stroke (paint core after links so
      // the synapses stop at the membrane, like the svg)
      const ring = ([cx, cy], rad, stroke, col) => {
        const dc = Math.hypot(x - cx * S, y - cy * S);
        paint(clamp(0.5 - (dc - rad * S) / aa, 0, 1), NIGHT);              // core disc
        paint(clamp(0.5 - (Math.abs(dc - rad * S) - (stroke / 2) * S) / aa, 0, 1), col); // ring
      };
      for (const p of IN) ring(p, 34, 14, CYAN);
      for (const p of HID) ring(p, 30, 13, VIOLET);
      ring(OUT_NODE, 42, 16, GOLD);
      // the gold spark of the answer
      const dSpark = Math.hypot(x - OUT_NODE[0] * S, y - OUT_NODE[1] * S) - 13 * S;
      paint(clamp(0.5 - dSpark / aa, 0, 1), GOLD);

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`axon/icon-${n}.png`);
}
