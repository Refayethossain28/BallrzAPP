#!/usr/bin/env node
/**
 * Generates the Voyager app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-vault-icons.mjs). Rasterizes the same motif as voyager/icon.svg: a
 * deep-space rounded tile, a blue globe with meridian/equator lines, a tilted
 * cyan→mint orbit ring passing behind and in front of it, and a small gold
 * voyager riding the ring.
 *
 * Run: node scripts/gen-voyager-icons.mjs   (writes icon-180/192/512.png into voyager/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'voyager');

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

/* ---- palette & helpers ---- */
const CYAN = [0x4c, 0xc9, 0xf0];
const MINT = [0x3c, 0xe6, 0xb0];
const GOLD = [0xf5, 0xc0, 0x4a];
const BLUE_HI = [0x5b, 0x7b, 0xff];
const BLUE_LO = [0x1c, 0x2f, 0x7a];
const MERIDIAN = [0xa8, 0xc4, 0xff];
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const mix = (c1, c2, f) => [lerp(c1[0], c2[0], f), lerp(c1[1], c2[1], f), lerp(c1[2], c2[2], f)];
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/** Rounded-rect SDF for the tile. */
function tileAlpha(x, y, N) {
  const r = N * 0.227;
  const hx = N / 2 - 0.5, hy = N / 2 - 0.5;
  const dx = Math.abs(x - hx) - (hx - r), dy = Math.abs(y - hy) - (hy - r);
  const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
  return 1 - smooth(-0.8, 0.8, d);
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const cx = N / 2, cy = N / 2;
  const R = N * 0.2305;                 // planet radius (118/512)
  const ringA = N * 0.371, ringB = N * 0.1445; // orbit semi-axes (190/512, 74/512)
  const ringW = N * 0.0166;             // half-width of the ring stroke
  const tilt = -24 * Math.PI / 180;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const voyR = N * 0.0508;              // the gold voyager (26/512)
  // ring-frame position of the voyager: leftmost point of the ellipse
  const voyX = cx + (-ringA) * cosT - 0 * sinT;
  const voyY = cy + (-ringA) * sinT + 0 * cosT;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const aTile = tileAlpha(x, y, N);
      const o = (y * N + x) * 4;
      if (aTile <= 0) { rgba[o + 3] = 0; continue; }

      // background: radial glow toward top-left
      const gd = Math.hypot(x - N * 0.35, y - N * 0.25) / (N * 0.9);
      let col = mix([0x17, 0x22, 0x47], [0x07, 0x0b, 0x16], smooth(0, 0.75, gd));

      // ring-frame coordinates (rotate the point back by the tilt)
      const rx = (x - cx) * cosT + (y - cy) * sinT;
      const ry = -(x - cx) * sinT + (y - cy) * cosT;
      // implicit ellipse distance (normalized, good enough at these widths)
      const e = Math.hypot(rx / ringA, ry / ringB);
      const dRing = Math.abs(e - 1) * Math.min(ringA * Math.abs(rx / ringA), ringB) || Math.abs(e - 1) * ringB;
      const nearRing = Math.abs(e - 1) < 0.16;
      const ringCol = mix(CYAN, MINT, clamp((rx / ringA + 1) / 2));
      const ringAlpha = nearRing ? 1 - smooth(ringW * 0.8, ringW * 1.6, Math.abs(e - 1) * ringB / 0.62) : 0;
      const ringBehind = ry < 0; // upper half in ring frame passes behind the planet

      // ring behind the planet (dimmed), before planet is drawn
      if (ringAlpha > 0 && ringBehind) col = mix(col, ringCol, ringAlpha * 0.45);

      // the planet
      const pd = Math.hypot(x - cx, y - cy);
      if (pd < R + 1) {
        const aP = 1 - smooth(R - 0.8, R + 0.8, pd);
        const shade = clamp(((x - cx) + (y - cy)) / (2 * R) / 1.4 + 0.5);
        let pCol = mix(BLUE_HI, BLUE_LO, shade);
        // meridian (vertical ellipse) + equator (horizontal ellipse) + limb
        const eq = Math.abs(Math.hypot((x - cx) / R, (y - cy) / (R * 0.39)) - 1);
        const me = Math.abs(Math.hypot((x - cx) / (R * 0.39), (y - cy) / R) - 1);
        const limb = Math.abs(pd - R) / R;
        const lineA = Math.max(1 - smooth(0.02, 0.09, eq), 1 - smooth(0.02, 0.09, me), (1 - smooth(0.01, 0.05, limb)) * 0.7);
        pCol = mix(pCol, MERIDIAN, lineA * 0.5);
        col = mix(col, pCol, aP);
      }

      // ring in front of the planet
      if (ringAlpha > 0 && !ringBehind) col = mix(col, ringCol, ringAlpha);

      // the gold voyager riding the ring (drawn on top)
      const vd = Math.hypot(x - voyX, y - voyY);
      if (vd < voyR + 1) {
        const aV = 1 - smooth(voyR - 0.8, voyR + 0.8, vd);
        let vCol = GOLD;
        const hd = Math.hypot(x - (voyX - voyR * 0.3), y - (voyY - voyR * 0.3));
        vCol = mix(vCol, [0xff, 0xff, 0xff], (1 - smooth(0, voyR * 0.5, hd)) * 0.85);
        col = mix(col, vCol, aV);
      }

      rgba[o] = Math.round(col[0]);
      rgba[o + 1] = Math.round(col[1]);
      rgba[o + 2] = Math.round(col[2]);
      rgba[o + 3] = Math.round(255 * aTile);
    }
  }
  return rgba;
}

for (const N of [180, 192, 512]) {
  const png = encodePNG(N, render(N));
  const file = join(OUT, `icon-${N}.png`);
  writeFileSync(file, png);
  console.log(`  wrote voyager/icon-${N}.png (${png.length} bytes)`);
}
