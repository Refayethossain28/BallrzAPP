#!/usr/bin/env node
/**
 * Builds zenith/catalog.js — the real-sky dataset behind Zenith — from the
 * public astronomy catalogs. Run once when the sources change; the output
 * is committed so the app and its tests never need the network.
 *
 * Sources (download them yourself, pass their paths):
 *   1. HYG star database v3 (https://astronexus.com/hyg, CC BY-SA)
 *      — every star to magnitude 6.5: the full naked-eye sky.
 *   2. d3-celestial data (https://github.com/ofrohn/d3-celestial, BSD-3,
 *      © Olaf Frohn) — all 88 IAU constellation stick figures + names.
 *   3. Messier catalog + bright DSOs from the same d3-celestial data
 *      (Messier data originally H. Frommert / SEDS).
 *
 * Usage:
 *   node scripts/build-zenith-catalog.mjs <dir with hyg.csv,
 *     constellations.lines.json, constellations.json, messier.json,
 *     dsos.bright.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'zenith', 'catalog.js');
const SRC = process.argv[2];
if (!SRC) { console.error('usage: build-zenith-catalog.mjs <source dir>'); process.exit(1); }

const MAG_LIMIT = 6.5;        // the naked-eye sky under pristine conditions
const NAME_MAG = 4.5;         // stars at least this bright carry a designation

/* ---------------- stars from HYG ---------------- */
const GREEK = { Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε', Zet: 'ζ', Eta: 'η',
  The: 'θ', Iot: 'ι', Kap: 'κ', Lam: 'λ', Mu: 'μ', Nu: 'ν', Xi: 'ξ', Omi: 'ο', Pi: 'π',
  Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ', Phi: 'φ', Chi: 'χ', Psi: 'ψ', Ome: 'ω' };

// Tiny CSV line parser (HYG has no quoted commas in the fields we read).
const csv = readFileSync(join(SRC, 'hyg.csv'), 'utf8').split('\n');
const header = csv[0].split(',');
const col = {};
header.forEach((h, i) => { col[h] = i; });

const cons = [];                // 88 three-letter abbreviations, index = conIdx
const conIdx = {};
function conIndex(abbr) {
  if (!(abbr in conIdx)) { conIdx[abbr] = cons.length; cons.push(abbr); }
  return conIdx[abbr];
}

const rows = [];
for (let i = 1; i < csv.length; i++) {
  if (!csv[i]) continue;
  const f = csv[i].split(',');
  const mag = parseFloat(f[col.mag]);
  const id = f[col.id];
  if (!isFinite(mag) || mag > MAG_LIMIT) continue;
  if (id === '0') continue;                       // the Sun — handled live by the engine
  const raDeg = parseFloat(f[col.ra]) * 15;       // HYG stores RA in hours
  const dec = parseFloat(f[col.dec]);
  if (!isFinite(raDeg) || !isFinite(dec)) continue;
  const ci = parseFloat(f[col.ci]);
  const proper = (f[col.proper] || '').trim();
  const bayer = (f[col.bayer] || '').trim();
  const flam = (f[col.flam] || '').trim();
  const con = (f[col.con] || '').trim();
  let desig = '';
  if (mag <= NAME_MAG && con) {
    if (bayer) desig = (GREEK[bayer.slice(0, 3)] || bayer) + (bayer.length > 3 ? bayer.slice(3) : '') + ' ' + con;
    else if (flam) desig = flam + ' ' + con;
  }
  rows.push({ ra: raDeg, dec, mag, ci: isFinite(ci) ? ci : 0, proper, desig, con });
}
rows.sort((a, b) => a.mag - b.mag);               // brightest first: magLimit = prefix

// Pack: flat number array, stride 5 → [raDeg, decDeg, mag, ci, conIdx].
// Names ride in sparse maps keyed by star index — most stars are anonymous.
const flat = [];
const names = {};     // proper names ("Sirius")
const desigs = {};    // designations ("α CMa")
rows.forEach((s, i) => {
  flat.push(+s.ra.toFixed(4), +s.dec.toFixed(4), +s.mag.toFixed(2), +s.ci.toFixed(2),
    s.con ? conIndex(s.con) : -1);
  if (s.proper) names[i] = s.proper;
  else if (s.desig) desigs[i] = s.desig;
  if (s.proper && s.desig) desigs[i] = s.desig;
});

/* ---------------- constellation figures + names ---------------- */
// d3-celestial GeoJSON: lon ∈ [−180, 180] where lon < 0 means RA = lon + 360.
const unlon = (lon) => (lon < 0 ? lon + 360 : lon);
const linesJson = JSON.parse(readFileSync(join(SRC, 'constellations.lines.json'), 'utf8'));
const namesJson = JSON.parse(readFileSync(join(SRC, 'constellations.json'), 'utf8'));
const conNames = {};
for (const f of namesJson.features) conNames[f.id] = f.properties.name;
const figures = [];
for (const f of linesJson.features) {
  // Serpens appears twice (Caput + Cauda) — keep both halves under one id.
  const polylines = (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates
    : [f.geometry.coordinates])
    .map((line) => line.map(([lon, dec]) => [+unlon(lon).toFixed(3), +dec.toFixed(3)]));
  figures.push({ id: f.id.replace(/[0-9]$/, ''), name: conNames[f.id.replace(/[0-9]$/, '')] || f.id, lines: polylines });
}

/* ---------------- deep-sky objects ---------------- */
const TYPE_NAMES = { gx: 'Galaxy', s: 'Spiral galaxy', e: 'Elliptical galaxy',
  i: 'Irregular galaxy', sd: 'Dwarf galaxy', oc: 'Open cluster', gc: 'Globular cluster',
  pn: 'Planetary nebula', snr: 'Supernova remnant', sfr: 'Star-forming nebula',
  en: 'Emission nebula', rn: 'Reflection nebula', bn: 'Nebula', nb: 'Nebula',
  dn: 'Dark nebula', ds: 'Double star', ast: 'Asterism', pos: 'Star group',
  'oc+en': 'Cluster + nebula' };

const dsos = [];
function addDso(f, idOverride) {
  const p = f.properties;
  const [lon, dec] = f.geometry.coordinates;
  const mag = parseFloat(p.mag);
  dsos.push({
    id: idOverride || f.id,
    name: p.alt || p.name || p.desig || f.id,
    desig: p.desig || '',
    type: p.type || 'nb',
    mag: isFinite(mag) ? +mag.toFixed(1) : 99,
    ra: +unlon(lon).toFixed(4), dec: +dec.toFixed(4),
    dim: p.dim || ''
  });
}
const messier = JSON.parse(readFileSync(join(SRC, 'messier.json'), 'utf8'));
for (const f of messier.features) addDso(f);
const bright = JSON.parse(readFileSync(join(SRC, 'dsos.bright.json'), 'utf8'));
for (const f of bright.features) {
  // Skip anything that is really a Messier object under another name:
  // same id modulo spacing ("M 31"), a Messier designation, or simply the
  // same patch of sky (within 0.3°) as an object we already carry.
  const normId = f.id.replace(/\s+/g, '');
  const desig = (f.properties.desig || '').replace(/\s+/g, '');
  const [lon, dec] = f.geometry.coordinates;
  const ra = unlon(lon);
  const dupe = dsos.some((d) =>
    d.id.replace(/\s+/g, '') === normId ||
    (desig && d.desig.replace(/\s+/g, '') === desig) ||
    (Math.abs(d.dec - dec) < 0.3 && Math.abs((((d.ra - ra) % 360) + 540) % 360 - 180) < 0.3));
  if (!dupe) addDso(f);
}
// A name that just repeats the id carries no information — blank it so
// the UI doesn't print "M39 — M39".
for (const d of dsos) {
  if (d.name.replace(/\s+/g, '') === d.id.replace(/\s+/g, '')) d.name = '';
}
dsos.sort((a, b) => a.mag - b.mag);

/* ---------------- emit ---------------- */
const out = `/* Zenith catalog — GENERATED by scripts/build-zenith-catalog.mjs. DO NOT EDIT.
 * ============================================================================
 * The real sky, compact and offline:
 *   STARS  — ${rows.length} stars complete to magnitude ${MAG_LIMIT} (the naked-eye sky),
 *            packed flat with stride ${5}: [raDeg, decDeg, mag, B−V, conIdx].
 *            J2000.0 positions; the engine precesses them to date.
 *   LINES  — all 88 IAU constellation stick figures (+ names).
 *   DSOS   — the 110 Messier objects + ${dsos.length - 110} bright extras.
 *
 * Data credits (keep when redistributing):
 *   • HYG star database v3 — astronexus.com/hyg (CC BY-SA). © David Nash.
 *   • Constellation figures & DSO set — d3-celestial data, BSD-3-Clause,
 *     © Olaf Frohn (github.com/ofrohn/d3-celestial).
 *   • Messier data originally compiled by H. Frommert / SEDS.
 */
(function (root) {
  'use strict';
  var C = {
    STAR_STRIDE: 5,
    STAR_COUNT: ${rows.length},
    STARS: ${JSON.stringify(flat)},
    STAR_NAMES: ${JSON.stringify(names)},
    STAR_DESIGS: ${JSON.stringify(desigs)},
    CONS: ${JSON.stringify(cons)},
    FIGURES: ${JSON.stringify(figures)},
    DSOS: ${JSON.stringify(dsos)},
    DSO_TYPES: ${JSON.stringify(TYPE_NAMES)}
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  root.ZenithCatalog = C;
})(typeof self !== 'undefined' ? self : this);
`;
writeFileSync(OUT, out);
console.log(`zenith/catalog.js: ${rows.length} stars (≤ mag ${MAG_LIMIT}), ` +
  `${Object.keys(names).length} proper names, ${Object.keys(desigs).length} designations, ` +
  `${figures.length} constellation figures, ${dsos.length} DSOs, ` +
  `${(out.length / 1024).toFixed(0)} KB`);
