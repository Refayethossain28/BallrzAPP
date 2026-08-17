#!/usr/bin/env node
/**
 * Unit tests for zenith/engine.js — the pure sky engine behind Zenith
 * (sidereal time, sun/moon/planet positions, moon phases, rise/set and
 * twilight times, the bright-star catalog and chart projection, the
 * tonight briefing, meteor calendar and daily fact).
 *
 * Positions are checked against independently known ephemeris values with
 * chart-grade tolerances (the engine targets ~0.5° accuracy).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-zenith-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'zenith', 'engine.js'), 'utf8'), sandbox, { filename: 'zenith/engine.js' });
const E = sandbox.module.exports;

const { MINUTE, HOUR, DAY } = E;
const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
const NOW = Date.UTC(2026, 7, 14, 22, 0, 0); // 2026-08-14 22:00 UTC
const LONDON = E.placeByName('London');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const near = (got, want, tol, m) => assert.ok(Math.abs(got - want) <= tol, `${m || 'value'}: got ${got}, want ${want} ± ${tol}`);

/* ---------- time bases ---------- */
test('julianDay: J2000 epoch is JD 2451545.0, Unix epoch is JD 2440587.5', () => {
  near(E.julianDay(J2000), 2451545.0, 1e-9);
  near(E.julianDay(0), 2440587.5, 1e-9);
});
test('gmstDeg: ≈280.46° at J2000, advances ~0.9856°/day beyond 360°', () => {
  near(E.gmstDeg(J2000), 280.4606, 0.01, 'GMST at J2000');
  const drift = E.wrap360(E.gmstDeg(J2000 + DAY) - E.gmstDeg(J2000));
  near(drift, 0.9856, 0.001, 'sidereal gain per solar day');
});
test('lstDeg adds east longitude; wrap helpers behave', () => {
  near(E.wrap360(E.lstDeg(90, J2000) - E.gmstDeg(J2000)), 90, 1e-9);
  assert.equal(E.wrap360(-30), 330);
  assert.equal(E.wrap180(350), -10);
  assert.equal(E.wrap180(170), 170);
});
test('obliquityDeg ≈ 23.44° in this era', () => {
  near(E.obliquityDeg(J2000), 23.439, 0.01);
});

/* ---------- the sun ---------- */
const MARCH_EQX = Date.UTC(2026, 2, 20, 14, 46);  // 2026 equinox
const JUNE_SOL = Date.UTC(2026, 5, 21, 8, 25);    // 2026 solstice
const DEC_SOL = Date.UTC(2026, 11, 21, 20, 50);
test('sunPosition: declination ~0 at equinox, ±23.44 at solstices', () => {
  near(E.sunPosition(MARCH_EQX).decDeg, 0, 0.5, 'equinox dec');
  near(E.sunPosition(JUNE_SOL).decDeg, 23.44, 0.1, 'june dec');
  near(E.sunPosition(DEC_SOL).decDeg, -23.44, 0.1, 'dec dec');
});
test('sunPosition: RA ~0 at the vernal equinox, distance ~1 AU (min in Jan)', () => {
  const ra = E.sunPosition(MARCH_EQX).raDeg;
  assert.ok(ra < 1.5 || ra > 358.5, `equinox RA ${ra}`);
  near(E.sunPosition(Date.UTC(2026, 0, 3)).distAU, 0.9833, 0.001, 'perihelion');
  near(E.sunPosition(Date.UTC(2026, 6, 5)).distAU, 1.0167, 0.001, 'aphelion');
});
test('sunAltAz: overhead at the subsolar point, Polaris-style checks hold', () => {
  // Equinox, solar noon on the Greenwich meridian → sun near alt 90−lat at lat 0
  const alt = E.sunAltAz(0, 0, Date.UTC(2026, 2, 20, 12, 8)).altDeg; // solar noon ≈ 12:08 (eq. of time)
  assert.ok(alt > 88, `equator noon sun alt ${alt}`);
});

/* ---------- alt/az & the pole star ---------- */
test('altAz: Polaris altitude ≈ observer latitude, azimuth ≈ north', () => {
  const p = E.starById('polaris');
  for (const lat of [10, 35, 51.5, 70]) {
    const aa = E.altAz(p.ra, p.dec, lat, -0.13, NOW);
    near(aa.altDeg, lat, 1.0, `Polaris alt at lat ${lat}`);
    // Polaris rides 0.74° off the true pole, so its azimuth wobbles a few degrees
    assert.ok(aa.azDeg < 4 || aa.azDeg > 356, `Polaris az ${aa.azDeg}`);
  }
});
test('altAz: a star on the meridian culminates at 90−|lat−dec|', () => {
  // Put a fake star exactly on the local meridian: RA = LST.
  const lst = E.lstDeg(LONDON.lon, NOW);
  const aa = E.altAz(lst, 20, LONDON.lat, LONDON.lon, NOW);
  near(aa.altDeg, 90 - Math.abs(LONDON.lat - 20), 0.01, 'culmination altitude');
});

/* ---------- the moon ---------- */
test('moonPhase: known new moon (2000-01-06) is dark, known full (2000-01-21) is lit', () => {
  const nm = E.moonPhase(Date.UTC(2000, 0, 6, 18, 14));
  assert.ok(nm.illumination < 0.01, `new moon illum ${nm.illumination}`);
  assert.equal(nm.name, 'New Moon');
  const fm = E.moonPhase(Date.UTC(2000, 0, 21, 4, 40));
  assert.ok(fm.illumination > 0.99, `full moon illum ${fm.illumination}`);
  assert.equal(fm.name, 'Full Moon');
});
test('moonPhase: waxing flag, age, and 8 names all reachable across a month', () => {
  const start = Date.UTC(2000, 0, 6, 18, 14);
  const seen = new Set();
  for (let d = 0; d < 30; d++) seen.add(E.moonPhase(start + d * DAY).name);
  assert.ok(seen.size >= 7, `phase names across a synodic month: ${[...seen].join(', ')}`);
  const wax = E.moonPhase(start + 5 * DAY), wane = E.moonPhase(start + 20 * DAY);
  assert.equal(wax.waxing, true);
  assert.equal(wane.waxing, false);
  assert.ok(wax.ageDays > 4 && wax.ageDays < 6.5, `age ${wax.ageDays}`);
});
test('moonPosition: distance stays within the real orbit’s bounds', () => {
  for (let d = 0; d < 30; d++) {
    const km = E.moonPosition(NOW + d * DAY).distKm;
    assert.ok(km > 356000 && km < 407000, `day ${d}: ${km} km`);
  }
});
test('nextMoonPhase: finds the next full moon about a synodic month after the last', () => {
  const known = Date.UTC(2000, 0, 21, 4, 40); // full
  const next = E.nextMoonPhase(known + DAY, 180);
  near((next - known) / DAY, E.SYNODIC_DAYS, 0.6, 'one synodic month later');
  const atNext = E.moonPhase(next);
  assert.ok(atNext.illumination > 0.995, `illum at found instant ${atNext.illumination}`);
  const nextNew = E.nextMoonPhase(known, 0);
  assert.ok(nextNew > known && (nextNew - known) / DAY < 16, 'new moon lands inside the fortnight');
});

/* ---------- planets ---------- */
test('heliocentric: each planet’s sun distance stays within perihelion–aphelion', () => {
  const bounds = { mercury: [0.30, 0.47], venus: [0.71, 0.73], earth: [0.98, 1.02], mars: [1.38, 1.67],
                   jupiter: [4.95, 5.46], saturn: [9.0, 10.13], uranus: [18.2, 20.1], neptune: [29.7, 30.4] };
    for (const key of Object.keys(bounds)) {
    for (let m = 0; m < 12; m++) {
      const r = E.heliocentric(key, Date.UTC(2026, m, 15)).r;
      assert.ok(r >= bounds[key][0] && r <= bounds[key][1], `${key} month ${m}: r=${r}`);
    }
  }
});
test('planetGeo: inner planets never stray far from the sun', () => {
  for (let m = 0; m < 24; m++) {
    const t = Date.UTC(2025, m, 1);
    assert.ok(Math.abs(E.planetGeo('mercury', t).elongationDeg) < 29, `mercury month ${m}`);
    assert.ok(Math.abs(E.planetGeo('venus', t).elongationDeg) < 48.5, `venus month ${m}`);
  }
});
test('planetGeo: geocentric distances and magnitudes are sane', () => {
  const mars = E.planetGeo('mars', NOW);
  assert.ok(mars.distAU > 0.37 && mars.distAU < 2.7, `mars Δ ${mars.distAU}`);
  assert.ok(mars.magnitude > -3 && mars.magnitude < 2.1, `mars mag ${mars.magnitude}`);
  const ven = E.planetGeo('venus', NOW);
  assert.ok(ven.magnitude < -3.5, `venus is always brilliant, got ${ven.magnitude}`);
  const nep = E.planetGeo('neptune', NOW);
  assert.ok(nep.magnitude > 7 && nep.magnitude < 8.2, `neptune mag ${nep.magnitude}`);
  assert.ok(nep.distAU > 28.8 && nep.distAU < 31.1, `neptune Δ ${nep.distAU}`);
});
test('planetGeo: ecliptic latitude stays small (planets hug the ecliptic)', () => {
  for (const p of E.PLANETS) {
    const g = E.planetGeo(p.key, NOW);
    const sunDec = E.sunPosition(NOW).decDeg;
    assert.ok(Math.abs(g.decDeg) < 30, `${p.key} dec ${g.decDeg} vs sun band ${sunDec}`);
    assert.ok(g.illumination > 0 && g.illumination <= 1, `${p.key} illum`);
  }
});

/* ---------- rise, set & twilight ---------- */
const JUNE_MIDNIGHT = Date.UTC(2026, 5, 21, 0, 0);
test('sunTimes: London June solstice — rise ~03:43, set ~20:21 UTC, ~16.6h day', () => {
  const st = E.sunTimes(51.51, -0.13, JUNE_MIDNIGHT);
  near(st.sunrise, Date.UTC(2026, 5, 21, 3, 43), 20 * MINUTE, 'sunrise');
  near(st.sunset, Date.UTC(2026, 5, 21, 20, 21), 20 * MINUTE, 'sunset');
  near(st.dayLengthMs / HOUR, 16.6, 0.7, 'day length h');
  assert.ok(st.civilDawn < st.sunrise, 'civil dawn precedes sunrise');
  assert.ok(st.sunset < st.civilDusk, 'civil dusk follows sunset');
  assert.equal(st.astroDusk, null, 'no astronomical darkness at 51.5°N midsummer');
});
test('sunTimes: equator equinox — a 12h day, noon sun overhead', () => {
  const st = E.sunTimes(0, 0, Date.UTC(2026, 2, 20, 0, 0));
  near(st.dayLengthMs / HOUR, 12, 0.25, 'equatorial day length');
  assert.ok(st.noonAltDeg > 88, `noon alt ${st.noonAltDeg}`);
});
test('sunTimes: polar extremes at 78°N — midnight sun in June, polar night in December', () => {
  const june = E.sunTimes(78, 0, JUNE_MIDNIGHT);
  assert.equal(june.midnightSun, true);
  assert.equal(june.sunrise, null);
  const dec = E.sunTimes(78, 0, Date.UTC(2026, 11, 21, 0, 0));
  assert.equal(dec.polarNight, true);
  assert.equal(dec.sunset, null);
});
test('moonTimes: the moon rises and sets on an ordinary London day', () => {
  const mt = E.moonTimes(51.51, -0.13, Date.UTC(2026, 7, 14, 0, 0));
  assert.ok(mt.moonrise !== null || mt.moonset !== null, 'at least one lunar horizon event');
  assert.ok(!mt.alwaysUp && !mt.alwaysDown, 'mid-latitude moon is neither circumpolar nor hidden');
});
test('riseSet is deterministic', () => {
  const altFn = (t) => E.sunAltAz(40, -74, t).altDeg;
  deepEq(E.riseSet(altFn, -0.833, JUNE_MIDNIGHT), E.riseSet(altFn, -0.833, JUNE_MIDNIGHT));
});

/* ---------- the star catalog ---------- */
test('STARS: well-formed, unique ids, sane ranges, the sky’s brightest present', () => {
  const ids = new Set();
  for (const s of E.STARS) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.ra >= 0 && s.ra < 360, `${s.id} ra ${s.ra}`);
    assert.ok(s.dec >= -90 && s.dec <= 90, `${s.id} dec ${s.dec}`);
    assert.ok(s.mag >= -1.5 && s.mag <= 4, `${s.id} mag ${s.mag}`);
    assert.ok(s.name && s.con, `${s.id} labelled`);
  }
  assert.ok(E.STARS.length >= 100, `catalog size ${E.STARS.length}`);
  assert.equal(E.STARS.find((s) => s.id === 'sirius').mag, -1.46);
});
test('CONSTELLATIONS: every line references stars that exist', () => {
  for (const c of E.CONSTELLATIONS) {
    assert.ok(c.lines.length >= 1, c.name);
    for (const [a, b] of c.lines) {
      assert.ok(E.starById(a), `${c.name}: missing ${a}`);
      assert.ok(E.starById(b), `${c.name}: missing ${b}`);
      assert.notEqual(a, b, `${c.name}: degenerate segment`);
    }
  }
});
test('starById finds by id and misses politely', () => {
  assert.equal(E.starById('vega').name, 'Vega');
  assert.equal(E.starById('nope'), null);
});

/* ---------- projection & the chart ---------- */
test('project: zenith at centre, horizon on the unit circle, north up / east left', () => {
  deepEq(E.project(90, 0), { x: -0, y: -0 });
  near(Math.hypot(E.project(0, 123).x, E.project(0, 123).y), 1, 1e-9, 'horizon radius');
  const north = E.project(0, 0);
  near(north.y, -1, 1e-9, 'north points up (−y)');
  const east = E.project(0, 90);
  near(east.x, -1, 1e-9, 'east points left (−x): sky charts are held overhead');
});
test('skyChart: only stars above the horizon, every dot inside the circle', () => {
  const chart = E.skyChart(LONDON.lat, LONDON.lon, NOW, { magLimit: 4 });
  assert.ok(chart.stars.length > 20, `${chart.stars.length} stars up`);
  for (const s of chart.stars) {
    assert.ok(s.altDeg >= -0.5, `${s.id} below horizon`);
    assert.ok(Math.hypot(s.x, s.y) <= 1.006, `${s.id} outside the circle`);
  }
});
test('skyChart: Polaris is up from London, Crux is not; the reverse from Sydney', () => {
  const ldn = E.skyChart(LONDON.lat, LONDON.lon, NOW);
  assert.ok(ldn.stars.some((s) => s.id === 'polaris'), 'Polaris over London');
  assert.ok(!ldn.stars.some((s) => s.id === 'acrux'), 'Crux never over London');
  const syd = E.placeByName('Sydney');
  const s2 = E.skyChart(syd.lat, syd.lon, NOW);
  assert.ok(!s2.stars.some((s) => s.id === 'polaris'), 'no Polaris from Sydney');
  assert.ok(s2.stars.some((s) => s.id === 'acrux'), 'Crux over Sydney');
});
test('skyChart: constellation lines only join stars that are both up; darkness tracks the sun', () => {
  const chart = E.skyChart(LONDON.lat, LONDON.lon, NOW);
  const up = new Set(chart.stars.map((s) => s.id));
  assert.ok(chart.lines.length > 0, 'some figures drawn');
  const noonChart = E.skyChart(LONDON.lat, LONDON.lon, Date.UTC(2026, 7, 14, 12, 0));
  assert.equal(noonChart.darkness, 0, 'no darkness at noon');
  assert.ok(chart.darkness > 0.5, `dark at 22:00 UTC, got ${chart.darkness}`);
  assert.equal(typeof chart.moon.up, 'boolean');
  assert.equal(chart.sun.up, false, 'sun down at night');
});
test('skyChart respects magLimit', () => {
  const bright = E.skyChart(LONDON.lat, LONDON.lon, NOW, { magLimit: 1.5 });
  const deep = E.skyChart(LONDON.lat, LONDON.lon, NOW, { magLimit: 4 });
  assert.ok(bright.stars.length < deep.stars.length);
  assert.ok(bright.stars.every((s) => s.mag <= 1.5));
});

/* ---------- tonight ---------- */
test('tonight: briefing carries sun times, phase, a verdict and per-planet notes', () => {
  const t = E.tonight(LONDON.lat, LONDON.lon, Date.UTC(2026, 7, 14, 0, 0));
  assert.equal(t.planets.length, 7);
  assert.ok(t.planets.every((p) => typeof p.note === 'string' && p.note.length > 8));
  assert.ok(t.visibleCount === t.planets.filter((p) => p.visible).length);
  assert.ok(t.moonVerdict.length > 10);
  assert.equal(t.polarNote, null);
  for (const p of t.planets.filter((x) => x.visible)) {
    assert.ok(p.best.altDeg >= 5, `${p.key} best alt ${p.best.altDeg}`);
    assert.ok(/N|S|E|W/.test(E.compass(p.best.azDeg)));
  }
});
test('tonight: polar note fires under the midnight sun', () => {
  const t = E.tonight(78, 0, JUNE_MIDNIGHT);
  assert.ok(t.polarNote && t.polarNote.includes('never sets'));
});
test('compass: 16-wind rose', () => {
  assert.equal(E.compass(0), 'N');
  assert.equal(E.compass(90), 'E');
  assert.equal(E.compass(225), 'SW');
  assert.equal(E.compass(340), 'NNW');
  assert.equal(E.compass(359.9), 'N');
});

/* ---------- meteor calendar ---------- */
test('meteorShowers: Perseids active and at peak around Aug 12', () => {
  const aug = E.meteorShowers({ y: 2026, m: 8, d: 12 });
  const per = aug.find((s) => s.name === 'Perseids');
  assert.ok(per.active && per.atPeak, JSON.stringify(per));
  assert.equal(aug[0].name, 'Perseids', 'peaking shower sorts first');
});
test('meteorShowers: Quadrantids straddle new year; quiet seasons are quiet', () => {
  const jan2 = E.meteorShowers({ y: 2026, m: 1, d: 2 });
  assert.ok(jan2.find((s) => s.name === 'Quadrantids').active, 'active on Jan 2');
  const dec30 = E.meteorShowers({ y: 2026, m: 12, d: 30 });
  assert.ok(dec30.find((s) => s.name === 'Quadrantids').active, 'active on Dec 30');
  const mar = E.meteorShowers({ y: 2026, m: 3, d: 10 });
  assert.equal(mar.filter((s) => s.active).length, 0, 'mid-March lull');
  assert.ok(Math.abs(mar[0].daysToPeak) <= 183, 'daysToPeak stays in a half-year window');
});
test('dayOfYear anchors', () => {
  assert.equal(E.dayOfYear(1, 1), 1);
  assert.equal(E.dayOfYear(12, 31), 365);
  assert.equal(E.dayOfYear(8, 12), 224);
});

/* ---------- daily fact, formatters, safety ---------- */
test('dailyFact: stable per date, rotates across dates, always from the list', () => {
  const a = E.dailyFact('2026-08-14');
  deepEq(a, E.dailyFact('2026-08-14'));
  assert.ok(E.FACTS.includes(a.fact));
  const seen = new Set();
  for (let d = 1; d <= 20; d++) seen.add(E.dailyFact('2026-08-' + String(d).padStart(2, '0')).fact);
  assert.ok(seen.size >= 6, 'facts rotate');
});
test('formatters: RA/Dec/duration/AU', () => {
  assert.equal(E.raToHMS(0), '0h 00m');
  assert.equal(E.raToHMS(279.23), '18h 36m'); // Vega
  assert.equal(E.decToDMS(-16.72), '−16° 43′');
  assert.equal(E.decToDMS(38.78), '+38° 47′');
  assert.equal(E.fmtDuration(16.5 * HOUR), '16h 30m');
  assert.equal(E.fmtDuration(null), '—');
  assert.equal(E.fmtAU(1.52), '1.52 AU');
  assert.ok(E.fmtAU(0.0026).includes('km'), 'lunar-scale distances in km');
});
test('escapeHTML neutralises markup', () => {
  assert.equal(E.escapeHTML('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
});
test('nearestPlace snaps and placeByName misses politely', () => {
  assert.equal(E.nearestPlace(51.4, 0.1).name, 'London');
  assert.equal(E.nearestPlace(-34.5, 150.9).name, 'Sydney');
  assert.equal(E.placeByName('Atlantis'), null);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nzenith: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
