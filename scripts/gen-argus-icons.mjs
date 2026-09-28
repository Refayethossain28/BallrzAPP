#!/usr/bin/env node
/**
 * Generates the Argus app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as argus/icon.svg: a
 * radial-dark rounded square, the almond eye outlined in cyan, an iris that
 * is the planet (blue gradient with green land), a black pupil with a
 * highlight, and one violet orbit with its satellite.
 *
 * Run: node scripts/gen-argus-icons.mjs   (writes icon-180/192/512.png into argus/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'argus');

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
const mix = (c, to, a) => [Math.round(lerp(c[0], to[0], a)), Math.round(lerp(c[1], to[1], a)), Math.round(lerp(c[2], to[2], a))];
const CYAN = [0x8f, 0xd3, 0xff], VIOLET = [0xe6, 0xb3, 0xff], LAND = [0x2f, 0x8f, 0x6a], EYE = [0x0a, 0x12, 0x26], PUPIL = [0x04, 0x07, 0x0f];

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512, aa = 1.0, corner = 116 * S;
  const cx = 256 * S, cy = 256 * S;
  // the almond: intersection of two discs of radius 250 centred 150 above / below the middle
  const R = 250 * S, off = 150 * S;
  const almond = (x, y) => Math.max(Math.hypot(x - cx, y - (cy - off)) - R, Math.hypot(x - cx, y - (cy + off)) - R);
  const irisR = 78 * S, pupilR = 26 * S;
  // land blobs on the iris (centre, radius)
  const blobs = [[236, 226, 17], [282, 276, 19], [218, 274, 10]].map(([x, y, r]) => [x * S, y * S, r * S]);
  // the orbit: ellipse rx 124 ry 36 rotated -22°
  const ang = -22 * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang), rx = 124 * S, ry = 36 * S;
  const orbitDist = (x, y) => {
    const dx = x - cx, dy = y - cy;
    const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
    const k = Math.hypot(u / rx, v / ry);
    return (k - 1) * Math.min(rx, ry); // approx pixel distance to the ring
  };
  const satX = 371 * S, satY = 209 * S, satR = 10 * S;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const qx = Math.abs(x - N / 2) - (N / 2 - corner), qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      const dTop = clamp(Math.hypot(x - N * 0.5, y - N * 0.18) / (N * 0.9), 0, 1);
      let c = [Math.round(lerp(0x16, 0x04, dTop)), Math.round(lerp(0x20, 0x07, dTop)), Math.round(lerp(0x3d, 0x0f, dTop))];

      // eye fill + cyan outline (14px stroke centred on the edge)
      const dA = almond(x, y);
      c = mix(c, EYE, clamp(0.5 - dA / aa, 0, 1));
      c = mix(c, CYAN, clamp(0.5 - (Math.abs(dA) - 7 * S) / aa, 0, 1));

      // iris: the planet
      const dI = Math.hypot(x - cx, y - cy) - irisR;
      if (dI < 1) {
        const t = clamp(Math.hypot(x - (cx - 0.24 * irisR), y - (cy - 0.32 * irisR)) / (1.4 * irisR), 0, 1);
        let iris = t < 0.55 ? mix([0x3f, 0x8f, 0xe6], [0x0f, 0x3f, 0x8f], t / 0.55) : mix([0x0f, 0x3f, 0x8f], [0x06, 0x1a, 0x3d], (t - 0.55) / 0.45);
        for (const [bx, by, br] of blobs) iris = mix(iris, LAND, 0.9 * clamp(0.5 - (Math.hypot(x - bx, y - by) - br) / aa, 0, 1));
        c = mix(c, iris, clamp(0.5 - dI / aa, 0, 1));
      }
      c = mix(c, CYAN, clamp(0.5 - (Math.abs(dI) - 2 * S) / aa, 0, 1));
      // pupil + highlight
      c = mix(c, PUPIL, clamp(0.5 - (Math.hypot(x - cx, y - cy) - pupilR) / aa, 0, 1));
      c = mix(c, [255, 255, 255], 0.85 * clamp(0.5 - (Math.hypot(x - 244 * S, y - 244 * S) - 7 * S) / aa, 0, 1));
      // orbit ring + satellite
      c = mix(c, VIOLET, 0.9 * clamp(0.5 - (Math.abs(orbitDist(x, y)) - 2.5 * S) / aa, 0, 1));
      c = mix(c, VIOLET, clamp(0.5 - (Math.hypot(x - satX, y - satY) - satR) / aa, 0, 1));

      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`argus/icon-${n}.png`);
}
