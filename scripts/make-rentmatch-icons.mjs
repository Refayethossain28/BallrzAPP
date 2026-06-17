#!/usr/bin/env node
/**
 * Generates RentMatch PWA icons (PNG) with zero dependencies — Node's built-in
 * zlib only. Draws a teal→violet house glyph on a dark gradient tile and
 * encodes it as a truecolor (opaque) PNG, so it works as both an Android
 * maskable icon and an iOS apple-touch-icon (which dislikes transparency).
 *
 * Run: node scripts/make-rentmatch-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---- CRC32 (PNG chunk checksums) ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/* ---- colour helpers ---- */
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

const TEAL = [52, 225, 192];
const VIOLET = [123, 140, 255];
const BG_TOP = [22, 32, 58];
const BG_BOT = [10, 14, 24];

/* house geometry in normalised [0,1] coords */
function sign(px, py, p1, p2) {
  return (px - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (py - p2[1]);
}
function pointInTriangle(px, py, a, b, c) {
  const b1 = sign(px, py, a, b) < 0;
  const b2 = sign(px, py, b, c) < 0;
  const b3 = sign(px, py, c, a) < 0;
  return b1 === b2 && b2 === b3;
}

const ROOF_APEX = [0.5, 0.26];
const ROOF_L = [0.16, 0.52];
const ROOF_R = [0.84, 0.52];
const BODY = { x0: 0.26, x1: 0.74, y0: 0.5, y1: 0.78 };
const DOOR = { x0: 0.44, x1: 0.56, y0: 0.6, y1: 0.78 };

function inHouse(x, y) {
  if (x >= DOOR.x0 && x <= DOOR.x1 && y >= DOOR.y0 && y <= DOOR.y1) return false; // door cut-out
  if (x >= BODY.x0 && x <= BODY.x1 && y >= BODY.y0 && y <= BODY.y1) return true;
  if (pointInTriangle(x, y, ROOF_APEX, ROOF_L, ROOF_R)) return true;
  return false;
}

/** Colour for a normalised point (with the background gradient). */
function colourAt(x, y) {
  if (inHouse(x, y)) {
    const t = clamp((x - ROOF_L[0]) / (ROOF_R[0] - ROOF_L[0]));
    return mix(TEAL, VIOLET, t);
  }
  return mix(BG_TOP, BG_BOT, clamp(y));
}

function renderPng(size) {
  const SS = 2; // 2x2 supersampling for smoother edges
  const row = 1 + size * 3; // filter byte + RGB
  const raw = Buffer.alloc(row * size);
  for (let py = 0; py < size; py++) {
    raw[py * row] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (px + (sx + 0.5) / SS) / size;
          const ny = (py + (sy + 0.5) / SS) / size;
          const c = colourAt(nx, ny);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS;
      const o = py * row + 1 + px * 3;
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolor RGB
  // bytes 10-12 already 0 (compression, filter, interlace)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  const out = join(ROOT, `rentmatch-icon-${size}.png`);
  writeFileSync(out, renderPng(size));
  console.log(`wrote rentmatch-icon-${size}.png`);
}
