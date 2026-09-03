#!/usr/bin/env node
/**
 * Generates the Reckon app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as reckon/icon.svg: a
 * dark rounded square holding a gold pound coin with a brand-blue pie slice
 * cut from it — the share that's actually yours — a dark rim, and a bold
 * dark £ built from strokes.
 *
 * Run: node scripts/gen-reckon-icons.mjs   (writes icon-180/192/512.png into reckon/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'reckon');

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
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1), 0, 1);
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 112 * S;
  const aa = 1.0;
  const cx = 256 * S, cy = 256 * S, R = 150 * S;

  // £ strokes in design space: stem with hooked top, mid crossbar, base bar
  const STROKES = [
    [258, 178, 258, 318, 17], // stem
    [258, 178, 292, 168, 15], // top hook
    [218, 258, 296, 258, 14], // mid crossbar
    [212, 330, 312, 330, 15], // base bar
  ];

  // slice: from angle -90° (up) sweeping clockwise to +26° (matches icon.svg)
  const A0 = -Math.PI / 2, A1 = Math.PI * 26 / 180;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square mask
      const qx = Math.abs(x - N / 2) - (N / 2 - corner);
      const qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // dark background, light falling from the top-left
      const t = clamp((x + y) / (2 * N), 0, 1);
      let r = Math.round(lerp(0x12, 0x0a, t));
      let g = Math.round(lerp(0x1b, 0x0d, t));
      let b = Math.round(lerp(0x36, 0x16, t));

      const d = Math.hypot(x - cx, y - cy);
      if (d < R + aa) {
        const aCoin = clamp(0.5 - (d - R) / aa, 0, 1);
        // gold coin, gradient along x+y
        const gt = clamp(((x - cx) + (y - cy)) / (2 * R) * 0.5 + 0.5, 0, 1);
        let cr = Math.round(lerp(0xf3, 0xc9, gt));
        let cg = Math.round(lerp(0xcd, 0x8f, gt));
        let cb = Math.round(lerp(0x7a, 0x2e, gt));

        // the kept slice in brand blue→violet
        let ang = Math.atan2(y - cy, x - cx); // -π..π, 0 = right
        const inSlice = ang >= A0 && ang <= A1;
        if (inSlice) {
          cr = Math.round(lerp(0x4d, 0x8f, gt)); cg = Math.round(lerp(0xd8, 0x7c, gt)); cb = Math.round(lerp(0xff, 0xf7, gt));
        }

        // dark rim + inner ring
        const rim = clamp(0.5 - (Math.abs(d - R + 7 * S) - 7 * S) / aa, 0, 1);
        const ring = clamp(0.5 - (Math.abs(d - 118 * S) - 3 * S) / aa, 0, 1) * 0.35;
        // £ strokes
        let ink = 0;
        for (const [ax, ay, bx, by, w] of STROKES) {
          const sd = capsuleDist(x, y, ax * S, ay * S, bx * S, by * S) - w * S;
          ink = Math.max(ink, clamp(0.5 - sd / aa, 0, 1));
        }
        const dark = Math.max(rim, ring, ink);
        if (dark > 0) {
          cr = Math.round(lerp(cr, 0x0a, dark)); cg = Math.round(lerp(cg, 0x0d, dark)); cb = Math.round(lerp(cb, 0x16, dark));
        }
        r = Math.round(lerp(r, cr, aCoin)); g = Math.round(lerp(g, cg, aCoin)); b = Math.round(lerp(b, cb, aCoin));
      }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`reckon/icon-${n}.png`);
}
