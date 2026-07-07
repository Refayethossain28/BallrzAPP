#!/usr/bin/env node
/**
 * Generates the BallrzCoin *Miner* app icons as real PNGs — no image libraries,
 * just Node's built-in zlib (same minimal PNG encoder as gen-concierge-icons.mjs).
 * A dark rounded tile with a warm glow and gold ring (same family as the coin),
 * but with a gold pickaxe so the miner installs as a visibly distinct app from
 * the wallet.
 *
 * Run: node scripts/gen-miner-icons.mjs   (writes miner-icon-180/192/512.png into coin/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'coin');

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

/* ---- painting helpers ---- */
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const edge = (d, feather) => clamp01(0.5 - d / feather);

function roundRectDist(x, y, N, r) {
  const hx = N / 2, hy = N / 2;
  const dx = Math.abs(x - hx) - (hx - r), dy = Math.abs(y - hy) - (hy - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}
// distance from point to a segment (all in the same units)
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / ((vx * vx + vy * vy) || 1));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// pickaxe geometry (512-unit space)
const HEAD_L = [166, 182], HEAD_C = [270, 92], HEAD_R = [372, 158];  // curved head (bows up)
const HANDLE_TOP = [271, 150], HANDLE_FOOT = [196, 392];             // straight shaft to head belly
// sample the head arc (quadratic Bézier) into a polyline once
const HEAD_PTS = [];
for (let s = 0; s <= 26; s++) {
  const t = s / 26, mt = 1 - t;
  HEAD_PTS.push([
    mt * mt * HEAD_L[0] + 2 * mt * t * HEAD_C[0] + t * t * HEAD_R[0],
    mt * mt * HEAD_L[1] + 2 * mt * t * HEAD_C[1] + t * t * HEAD_R[1],
  ]);
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const px = 1;
  const GOLD_HI = [240, 217, 140], GOLD = [212, 175, 55], GOLD_LO = [156, 122, 30];
  const u = (v) => (v / 512) * N;                   // svg units → device px

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const cardD = roundRectDist(x + 0.5, y + 0.5, N, u(112));
      const cardA = edge(cardD, px);
      if (cardA > 0) {
        const gx = (x - 0.30 * N) / N, gy = (y - 0.22 * N) / N;
        const t = clamp01(Math.hypot(gx, gy) / 1.05);
        let c = t < 0.55 ? mix([42, 32, 19], [18, 14, 8], t / 0.55) : mix([18, 14, 8], [10, 8, 6], (t - 0.55) / 0.45);

        const dc = Math.hypot(x - N / 2, y - N / 2);
        const diag = clamp01((x + y) / (2 * N));
        const goldAt = mix(GOLD_HI, GOLD_LO, diag);
        const ringA = edge(Math.abs(dc - u(168)) - u(5), px);
        if (ringA > 0) c = mix(c, goldAt, ringA);

        // curved head: min distance to the sampled arc, tapered thinner at the tips
        let headRaw = Infinity, bestT = 0;
        for (let s = 0; s < HEAD_PTS.length - 1; s++) {
          const A = HEAD_PTS[s], B = HEAD_PTS[s + 1];
          const d = segDist(x, y, u(A[0]), u(A[1]), u(B[0]), u(B[1]));
          if (d < headRaw) { headRaw = d; bestT = s / (HEAD_PTS.length - 1); }
        }
        const headThick = u(15) - u(7) * Math.abs(bestT - 0.5) * 2; // 15 at belly → 8 at tips
        const headD = headRaw - headThick;
        // straight handle (shaft) to the head belly
        const handleD = segDist(x, y, u(HANDLE_TOP[0]), u(HANDLE_TOP[1]), u(HANDLE_FOOT[0]), u(HANDLE_FOOT[1])) - u(15);
        const pick = Math.min(headD, handleD);
        const outlineA = edge(pick - u(3.5), px) * 0.6;             // dark rim for contrast
        if (outlineA > 0) c = mix(c, [8, 6, 4], outlineA);
        const pickA = edge(pick, px);
        if (pickA > 0) c = mix(c, goldAt, pickA);

        r = c[0]; g = c[1]; b = c[2]; a = 255 * cardA;
      }
      const i = (y * N + x) * 4;
      rgba[i] = Math.round(r); rgba[i + 1] = Math.round(g); rgba[i + 2] = Math.round(b); rgba[i + 3] = Math.round(a);
    }
  }
  return rgba;
}

for (const N of [180, 192, 512]) {
  const png = encodePNG(N, render(N));
  const file = join(OUT, `miner-icon-${N}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
