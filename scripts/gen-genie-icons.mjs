#!/usr/bin/env node
/**
 * Generates the Genie app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as genie/icon.svg: a
 * genie's lamp in lamp-amber and gold — body, spout, handle ring, lid and
 * knob — throwing a soft glow on a deep indigo rounded square, with a curl
 * of smoke rising from the spout. Every shape is a signed-distance field,
 * anti-aliased over a one-pixel feather.
 *
 * Run: node scripts/gen-genie-icons.mjs   (writes icon-180/192/512.png into genie/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'genie');

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
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// the palette, straight from icon.svg
const INK_TOP = hex('#1b1638'), INK_BOTTOM = hex('#0d0b1a');   // deep indigo, lit from the upper middle
const AMBER = hex('#f2b544');                                    // lamp-amber: the glow
const GOLD_HI = hex('#f6d88a'), GOLD_LO = hex('#c48a2a');        // the lamp's gold, top → bottom
const SMOKE = hex('#f6df9a'), KNOB = hex('#f6df9a'), SHINE = hex('#fbe7ad');

// distance to a segment (a capsule once the caller subtracts a radius)
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}
// signed distance to a rounded rect (negative inside)
function roundRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
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
// a convex quad = two triangles sharing the a–c diagonal
function quadDist(px, py, a, b, c, d) {
  return Math.min(triDist(px, py, a[0], a[1], b[0], b[1], c[0], c[1]),
    triDist(px, py, a[0], a[1], c[0], c[1], d[0], d[1]));
}
// signed distance to an ellipse, first-order (exact enough at the edge, which is all AA needs)
function ellipseDist(px, py, cx, cy, rx, ry) {
  const dx = px - cx, dy = py - cy;
  const f = Math.hypot(dx / rx, dy / ry) - 1;
  const g = Math.hypot(dx / (rx * rx), dy / (ry * ry));
  return g > 1e-9 ? f / g : -Math.min(rx, ry);
}
// signed distance to a ring (a circle's stroke), negative inside the stroke
function ringDist(px, py, cx, cy, r, w) { return Math.abs(Math.hypot(px - cx, py - cy) - r) - w / 2; }
// a cubic Bézier sampled into n+1 points
function bezier(p0, p1, p2, p3, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}
// the smoke path from icon.svg: M 64 238 C 50 214, 58 190, 84 172 C 108 156, 104 128, 84 112 C 72 100, 84 84, 104 80
const SMOKE_PTS = [
  ...bezier([64, 238], [50, 214], [58, 190], [84, 172], 10),
  ...bezier([84, 172], [108, 156], [104, 128], [84, 112], 10).slice(1),
  ...bezier([84, 112], [72, 100], [84, 84], [104, 80], 8).slice(1),
];

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512; // design space is 512
  const corner = 116 * S;
  const aa = 1.0; // anti-alias feather in px

  const lampColor = (y) => {
    const t = clamp((y / S - 248) / (412 - 248), 0, 1);
    return [0, 1, 2].map((i) => Math.round(lerp(GOLD_HI[i], GOLD_LO[i], t)));
  };
  const SPOUT = [[160, 296], [66, 244], [60, 270], [150, 340]].map(([x, y]) => [x * S, y * S]);
  const smokeW = 7 * S; // half of the SVG's 14px stroke

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // rounded-square mask
      const qx = Math.abs(x - N / 2) - (N / 2 - corner);
      const qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // deep indigo, lit from the upper middle (radial, like the SVG's #ink)
      const dTop = clamp(Math.hypot(x - N * 0.5, y - N * 0.22) / (N * 0.95), 0, 1);
      let r = lerp(INK_TOP[0], INK_BOTTOM[0], dTop);
      let g = lerp(INK_TOP[1], INK_BOTTOM[1], dTop);
      let b = lerp(INK_TOP[2], INK_BOTTOM[2], dTop);
      const paint = ([cr, cg, cb], a) => { if (a > 0) { r = lerp(r, cr, a); g = lerp(g, cg, a); b = lerp(b, cb, a); } };

      // the soft glow the lamp throws
      const tg = Math.hypot(x - 250 * S, y - 320 * S) / (220 * S);
      const glow = tg < 0.55 ? lerp(0.42, 0.12, tg / 0.55) : lerp(0.12, 0, clamp((tg - 0.55) / 0.45, 0, 1));
      paint(AMBER, clamp(glow, 0, 1));

      // the curl of smoke: a chain of capsules, fading as it rises
      let smokeA = 0;
      for (let k = 0; k + 1 < SMOKE_PTS.length; k++) {
        const [ax, ay] = SMOKE_PTS[k], [bx, by] = SMOKE_PTS[k + 1];
        const d = capsuleDist(x, y, ax * S, ay * S, bx * S, by * S) - smokeW;
        const op = lerp(0.8, 0.45, k / (SMOKE_PTS.length - 2));
        smokeA = Math.max(smokeA, clamp(0.5 - d / aa, 0, 1) * op);
      }
      paint(SMOKE, smokeA);

      // the lamp, back to front: spout, handle ring, body, foot, lid, knob
      const gold = lampColor(y);
      paint(gold, clamp(0.5 - (quadDist(x, y, SPOUT[0], SPOUT[1], SPOUT[2], SPOUT[3]) - 0.5) / aa, 0, 1));
      paint(gold, clamp(0.5 - ringDist(x, y, 372 * S, 318 * S, 44 * S, 20 * S) / aa, 0, 1));
      paint(gold, clamp(0.5 - ellipseDist(x, y, 250 * S, 330 * S, 120 * S, 62 * S) / aa, 0, 1));
      paint(gold, clamp(0.5 - roundRectDist(x, y, 250 * S, 400 * S, 60 * S, 12 * S, 10 * S) / aa, 0, 1));
      paint(gold, clamp(0.5 - ellipseDist(x, y, 250 * S, 268 * S, 46 * S, 16 * S) / aa, 0, 1));
      paint(KNOB, clamp(0.5 - (Math.hypot(x - 250 * S, y - 248 * S) - 11 * S) / aa, 0, 1));

      // the shine on the body
      paint(SHINE, clamp(0.5 - ellipseDist(x, y, 212 * S, 306 * S, 38 * S, 12 * S) / aa, 0, 1) * 0.5);

      rgba[i] = Math.round(r); rgba[i + 1] = Math.round(g); rgba[i + 2] = Math.round(b); rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`genie/icon-${n}.png`);
}
