#!/usr/bin/env node
/**
 * Unit tests for zenith/engine.js + zenith/catalog.js — the professional
 * sky engine behind Zenith. Positions are pinned against independently
 * published ephemeris values, including Jean Meeus's worked examples
 * (Astronomical Algorithms: 25.a sun, 47.a moon, 44.a Galilean moons),
 * J2000 sidereal time, solstice/equinox geometry, real moon-phase
 * instants, and the catalog's own integrity (8,900 HYG stars, 88 IAU
 * constellations, the Messier catalog).
 *
 * Loaded in a vm sandbox (repo is type:module) exactly as a browser
 * loads the classic scripts: catalog first, engine second.
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
vm.runInContext(readFileSync(join(ROOT, 'zenith', 'catalog.js'), 'utf8'), sandbox, { filename: 'zenith/catalog.js' });
const CAT = sandbox.module.exports;
sandbox.module = { exports: {} };
vm.runInContext(readFileSync(join(ROOT, 'zenith', 'engine.js'), 'utf8'), sandbox, { filename: 'zenith/engine.js' });
const E = sandbox.module.exports;
E.setCatalog(CAT);

const { MINUTE, HOUR, DAY } = E;
const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
const NOW = Date.UTC(2026, 10, 5, 22, 0, 0); // 2026-11-05 22:00 UTC
const LONDON = E.placeByName('London');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const near = (got, want, tol, m) => assert.ok(Math.abs(got - want) <= tol, `${m || 'value'}: got ${got}, want ${want} ± ${tol}`);

/* ================= time bases ================= */
test('julianDay: J2000 epoch is JD 2451545.0, Unix epoch is JD 2440587.5', () => {
  near(E.julianDay(J2000), 2451545.0, 1e-9);
  near(E.julianDay(0), 2440587.5, 1e-9);
});
test('gmstDeg ≈ 280.4606° at J2000; sidereal day gains ~0.9856°', () => {
  near(E.gmstDeg(J2000), 280.4606, 0.01, 'GMST at J2000');
  near(E.wrap360(E.gmstDeg(J2000 + DAY) - E.gmstDeg(J2000)), 0.9856, 0.001);
});
test('nutation: Δψ and Δε stay within ±20″/±10″ and oscillate', () => {
  const vals = [];
  for (let y = 0; y < 19; y++) {
    const n = E.nutation(Date.UTC(2008 + y, 5, 1));
    assert.ok(Math.abs(n.dpsiDeg) < 20 / 3600, `dpsi ${n.dpsiDeg * 3600}″`);
    assert.ok(Math.abs(n.depsDeg) < 10 / 3600 + 1e-6, `deps ${n.depsDeg * 3600}″`);
    vals.push(n.dpsiDeg);
  }
  assert.ok(Math.min(...vals) < 0 && Math.max(...vals) > 0, 'Δψ changes sign across the 18.6-year cycle');
});
test('true obliquity ≈ 23.44°; apparent ST differs from mean by the equation of the equinoxes', () => {
  near(E.trueObliquityDeg(J2000), 23.439, 0.01);
  const diff = E.wrap180(E.gastDeg(NOW) - E.gmstDeg(NOW));
  assert.ok(Math.abs(diff) < 0.006 && diff !== 0, `eq. of equinoxes ${diff}°`);
});

/* ================= precession ================= */
test('precessJ2000: identity at J2000, ~50.3″/yr of general precession', () => {
  const p0 = E.precessJ2000(100, 20, J2000);
  near(p0.raDeg, 100, 1e-6); near(p0.decDeg, 20, 1e-6);
  // a star on the ecliptic plane moves ~0.3556° in longitude over 25.45 yr
  const p = E.precessJ2000(0, 0, NOW);
  const shift = E.separationDeg(0, 0, p.raDeg, p.decDeg);
  near(shift, 50.29 * 26.85 / 3600, 0.03, 'total precession shift since 2000');
});
test('precessJ2000: Polaris closes on the pole — separation ≈ 0.62° in 2026 (was 0.736° in 2000)', () => {
  const p = E.precessJ2000(37.9546, 89.2641, NOW);
  const sep = E.separationDeg(p.raDeg, p.decDeg, 0, 90);
  assert.ok(sep > 0.58 && sep < 0.68, `sep ${sep}`);
  const sep2000 = E.separationDeg(37.9546, 89.2641, 0, 90);
  assert.ok(sep < sep2000, 'the pole star is still improving');
});

/* ================= the sun (Meeus 25.a) ================= */
test('sunPosition vs Meeus example 25.a: 1992 Oct 13.0 TD → apparent λ ≈ 199.909°', () => {
  const s = E.sunPosition(Date.UTC(1992, 9, 13));
  near(s.lambdaDeg, 199.90895, 0.01, 'apparent solar longitude');
  near(s.distAU, 0.99761, 0.0005, 'radius vector');
});
const MARCH_EQX = Date.UTC(2026, 2, 20, 14, 46);
const JUNE_SOL = Date.UTC(2026, 5, 21, 8, 25);
const DEC_SOL = Date.UTC(2026, 11, 21, 20, 50);
test('sunPosition: dec ~0 at equinox, ±23.44° at the solstices', () => {
  near(E.sunPosition(MARCH_EQX).decDeg, 0, 0.1, 'equinox dec');
  near(E.sunPosition(JUNE_SOL).decDeg, 23.44, 0.05, 'june dec');
  near(E.sunPosition(DEC_SOL).decDeg, -23.44, 0.05, 'dec dec');
});

/* ================= the moon (Meeus 47.a) ================= */
test('moonPosition vs Meeus example 47.a: 1992 Apr 12.0 TD', () => {
  const m = E.moonPosition(Date.UTC(1992, 3, 12));
  near(m.lambdaDeg, 133.167265, 0.005, 'apparent λ (3″ truncation error measured)');
  near(m.betaDeg, -3.229126, 0.006, 'β');
  near(m.distKm, 368409.7, 25, 'distance km');
});
test('moonPosition: horizontal parallax ~0.9–1.0°, semi-diameter ~15–17′', () => {
  for (let d = 0; d < 28; d += 4) {
    const m = E.moonPosition(NOW + d * DAY);
    assert.ok(m.parallaxDeg > 0.88 && m.parallaxDeg < 1.03, `day ${d} parallax ${m.parallaxDeg}°`);
    assert.ok(m.semiDiamDeg > 0.24 && m.semiDiamDeg < 0.29, `day ${d} semi-diameter ${m.semiDiamDeg}°`);
  }
});
test('moonAltAz: topocentric moon sits LOWER than geocentric by up to ~1°', () => {
  const mt = E.moonTimes(LONDON.lat, LONDON.lon, Date.UTC(2026, 10, 5));
  const at = E.moonAltAz(LONDON.lat, LONDON.lon, mt.transit);
  assert.ok(at.geocentricAltDeg - at.altDeg > 0.3, `parallax drop ${at.geocentricAltDeg - at.altDeg}`);
  assert.ok(at.geocentricAltDeg - at.altDeg < 1.1);
});
test('moonPhase: real instants — new 2000-01-06 18:14, full 2000-01-21 04:40', () => {
  const nm = E.moonPhase(Date.UTC(2000, 0, 6, 18, 14));
  assert.ok(nm.illumination < 0.01, `new illum ${nm.illumination}`);
  assert.equal(nm.name, 'New Moon');
  const fm = E.moonPhase(Date.UTC(2000, 0, 21, 4, 40));
  assert.ok(fm.illumination > 0.99, `full illum ${fm.illumination}`);
  assert.equal(fm.name, 'Full Moon');
  assert.ok(fm.magnitude < -12, `full moon magnitude ${fm.magnitude}`);
});
test('nextMoonPhase: one synodic month between consecutive fulls, minute-level landing', () => {
  const known = Date.UTC(2000, 0, 21, 4, 40);
  const next = E.nextMoonPhase(known + DAY, 180);
  near((next - known) / DAY, E.SYNODIC_DAYS, 0.6);
  assert.ok(E.moonPhase(next).illumination > 0.995);
});

/* ================= planets ================= */
test('heliocentric r within perihelion–aphelion for all 8, all year', () => {
  const bounds = { mercury: [0.30, 0.47], venus: [0.71, 0.73], earth: [0.98, 1.02], mars: [1.38, 1.67],
                   jupiter: [4.95, 5.46], saturn: [9.0, 10.13], uranus: [18.2, 20.1], neptune: [29.7, 30.4] };
  for (const key of Object.keys(bounds)) {
    for (let m = 0; m < 12; m++) {
      const r = E.heliocentric(key, Date.UTC(2026, m, 15)).r;
      assert.ok(r >= bounds[key][0] && r <= bounds[key][1], `${key} month ${m}: r=${r}`);
    }
  }
});
test('planetGeo: Mercury ≤29°, Venus ≤48.5° from the sun across two years', () => {
  for (let m = 0; m < 24; m++) {
    const t = Date.UTC(2025, m, 1);
    assert.ok(Math.abs(E.planetGeo('mercury', t).elongationDeg) < 29, `mercury month ${m}`);
    assert.ok(Math.abs(E.planetGeo('venus', t).elongationDeg) < 48.5, `venus month ${m}`);
  }
});
test('planetGeo: magnitudes and distances in their physical ranges', () => {
  const ven = E.planetGeo('venus', NOW);
  assert.ok(ven.magnitude < -3.5, `venus ${ven.magnitude}`);
  const nep = E.planetGeo('neptune', NOW);
  assert.ok(nep.magnitude > 7 && nep.magnitude < 8.2, `neptune ${nep.magnitude}`);
  assert.ok(nep.distAU > 28.8 && nep.distAU < 31.1);
  const mars = E.planetGeo('mars', NOW);
  assert.ok(mars.distAU > 0.37 && mars.distAU < 2.7);
});

/* ================= Galilean satellites (Meeus 44.a) ================= */
test('galileanMoons vs Meeus example 44.a: 1992 Dec 16.0 TD', () => {
  const g = E.galileanMoons(Date.UTC(1992, 11, 16));
  const by = {}; for (const m of g) by[m.key] = m;
  near(by.io.x, -3.44, 0.1, 'Io X');
  near(by.europa.x, 7.44, 0.1, 'Europa X');
  near(by.ganymede.x, 1.24, 0.1, 'Ganymede X');
  near(by.callisto.x, 7.08, 0.1, 'Callisto X');
});
test('galileanMoons: elongations bounded by each orbit, Io repeats after its period', () => {
  for (let d = 0; d < 20; d++) {
    const g = E.galileanMoons(NOW + d * DAY);
    const bounds = { io: 6.0, europa: 9.6, ganymede: 15.2, callisto: 26.6 };
    for (const m of g) assert.ok(Math.abs(m.x) <= bounds[m.key], `${m.key} day ${d}: ${m.x}`);
  }
  const a = E.galileanMoons(NOW)[0].x;
  const b = E.galileanMoons(NOW + 1.769138 * DAY)[0].x;
  near(b, a, 0.5, 'Io back near its spot one period later');
});

/* ================= refraction & separation ================= */
test('refractionDeg: ~34′ at the horizon, ~1′ at 45°, ~0 at the zenith', () => {
  near(E.refractionDeg(0) * 60, 34, 6, 'horizon');
  near(E.refractionDeg(45) * 60, 1, 0.3, '45°');
  assert.ok(E.refractionDeg(89) * 60 < 0.2, 'zenith');
});
test('separationDeg: zero to itself, 90° pole-to-equator, Mizar–Alcor ≈ 12′', () => {
  assert.equal(E.separationDeg(10, 20, 10, 20), 0);
  near(E.separationDeg(0, 90, 123, 0), 90, 1e-9);
  near(E.separationDeg(200.98, 54.93, 201.31, 54.99) * 60, 12, 2, 'Mizar–Alcor arcmin');
});

/* ================= rise, set & twilight ================= */
test('sunTimes: London June solstice — rise ~03:43, set ~20:21 UTC', () => {
  const st = E.sunTimes(51.51, -0.13, Date.UTC(2026, 5, 21, 0, 0));
  near(st.sunrise, Date.UTC(2026, 5, 21, 3, 43), 20 * MINUTE, 'sunrise');
  near(st.sunset, Date.UTC(2026, 5, 21, 20, 21), 20 * MINUTE, 'sunset');
  assert.equal(st.astroDusk, null, 'no astronomical darkness at 51.5°N midsummer');
});
test('sunTimes: polar extremes at 78°N', () => {
  assert.equal(E.sunTimes(78, 0, Date.UTC(2026, 5, 21)).midnightSun, true);
  assert.equal(E.sunTimes(78, 0, Date.UTC(2026, 11, 21)).polarNight, true);
});
test('moonTimes: topocentric moon rises/sets on an ordinary London day', () => {
  const mt = E.moonTimes(51.51, -0.13, Date.UTC(2026, 10, 5, 0, 0));
  assert.ok(mt.moonrise !== null || mt.moonset !== null);
  assert.ok(!mt.alwaysUp && !mt.alwaysDown);
});

/* ================= the catalog ================= */
test('catalog: 8,900+ stars, complete and sorted bright-to-faint, all fields sane', () => {
  assert.ok(CAT.STAR_COUNT >= 8500, `count ${CAT.STAR_COUNT}`);
  assert.equal(CAT.STARS.length, CAT.STAR_COUNT * CAT.STAR_STRIDE);
  let lastMag = -2;
  for (let i = 0; i < CAT.STAR_COUNT; i++) {
    const o = i * CAT.STAR_STRIDE;
    const ra = CAT.STARS[o], dec = CAT.STARS[o + 1], mag = CAT.STARS[o + 2];
    assert.ok(ra >= 0 && ra < 360, `star ${i} ra ${ra}`);
    assert.ok(dec >= -90 && dec <= 90, `star ${i} dec ${dec}`);
    assert.ok(mag >= lastMag - 1e-9, `sorted at ${i}`);
    lastMag = mag;
  }
  assert.ok(CAT.STARS[2] <= -1.4, 'Sirius leads');
});
test('catalog: the famous stars are present at their real positions', () => {
  const sirius = E.starByName('Sirius');
  near(sirius.ra, 101.287, 0.01); near(sirius.dec, -16.716, 0.01); near(sirius.mag, -1.44, 0.1);
  const vega = E.starByName('Vega');
  near(vega.ra, 279.235, 0.01); near(vega.dec, 38.784, 0.01);
  const polaris = E.starByName('Polaris');
  near(polaris.dec, 89.264, 0.01);
  assert.ok(E.namedStars().length >= 100, 'proper names survive the pack');
  assert.equal(E.starByName('NotAStar'), null);
});
test('catalog: all 88 IAU constellations are drawn (Serpens in two halves)', () => {
  const ids = new Set(CAT.FIGURES.map((f) => f.id));
  assert.equal(ids.size, 88, `constellations ${ids.size}`);
  assert.equal(CAT.FIGURES.filter((f) => f.id === 'Ser').length, 2, 'Caput + Cauda');
  for (const f of CAT.FIGURES) {
    assert.ok(f.lines.length >= 1, f.id);
    for (const line of f.lines) {
      assert.ok(line.length >= 2, `${f.id} degenerate polyline`);
      for (const [ra, dec] of line) {
        assert.ok(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90, `${f.id} vertex ${ra},${dec}`);
      }
    }
  }
});
test('catalog: the full Messier catalog, correctly placed', () => {
  const ms = CAT.DSOS.filter((d) => /^M\d+$/.test(d.id));
  assert.equal(ms.length, 110, `Messier count ${ms.length}`);
  const m31 = E.dsoById('M31');
  near(m31.ra, 10.68, 0.05, 'M31 RA'); near(m31.dec, 41.27, 0.05, 'M31 dec');
  near(m31.mag, 3.4, 0.2);
  const m42 = E.dsoById('M42');
  near(m42.ra, 83.82, 0.1, 'M42 RA'); near(m42.dec, -5.39, 0.1, 'M42 dec');
  const m45 = E.dsoById('M45');
  near(m45.ra, 56.9, 0.5, 'Pleiades RA'); near(m45.dec, 24.1, 0.5, 'Pleiades dec');
  for (const d of CAT.DSOS) assert.ok(d.type in CAT.DSO_TYPES, `type ${d.type} unmapped (${d.id})`);
});

/* ================= search ================= */
test('searchObjects: finds planets, Messier ids, star names and designations', () => {
  assert.equal(E.searchObjects('jupiter')[0].kind, 'planet');
  assert.equal(E.searchObjects('m31')[0].id, 'M31');
  assert.equal(E.searchObjects('M 31'.replace(' ', ''))[0].id, 'M31');
  assert.equal(E.searchObjects('sirius')[0].name, 'Sirius');
  assert.equal(E.searchObjects('α CMa')[0].name, 'α CMa');
  assert.equal(E.searchObjects('orion nebula')[0].id, 'M42');
  assert.equal(E.searchObjects('moon')[0].kind, 'moon');
  deepEq(E.searchObjects(''), []);
  assert.ok(E.searchObjects('andromeda').some((r) => r.id === 'M31'));
});

/* ================= the chart ================= */
test('project: zenith centre, horizon unit circle, north up, east left', () => {
  near(Math.hypot(E.project(90, 0).x, E.project(90, 0).y), 0, 1e-9);
  near(Math.hypot(E.project(0, 123).x, E.project(0, 123).y), 1, 1e-9);
  near(E.project(0, 0).y, -1, 1e-9);
  near(E.project(0, 90).x, -1, 1e-9);
});
test('skyChart: hundreds of stars up, all above horizon and inside the circle', () => {
  const chart = E.skyChart(LONDON.lat, LONDON.lon, NOW, { magLimit: 5.5 });
  assert.ok(chart.stars.length > 800, `${chart.stars.length} stars`);
  for (const s of chart.stars) {
    assert.ok(s.altDeg >= -0.5, `star ${s.i} below horizon`);
    assert.ok(Math.hypot(s.x, s.y) <= 1.01, `star ${s.i} outside circle`);
  }
  assert.ok(chart.lines.length > 100, 'figures drawn');
  assert.ok(chart.dsos.length > 10, 'DSOs plotted');
});
test('skyChart: hemispheres — Polaris over London, Crux over Sydney, never both', () => {
  const ldn = E.skyChart(LONDON.lat, LONDON.lon, NOW, { magLimit: 4 });
  assert.ok(ldn.stars.some((s) => s.name === 'Polaris'));
  assert.ok(!ldn.stars.some((s) => s.name === 'Acrux'));
  const syd = E.placeByName('Sydney');
  const s2 = E.skyChart(syd.lat, syd.lon, NOW, { magLimit: 4 });
  assert.ok(!s2.stars.some((s) => s.name === 'Polaris'));
  assert.ok(s2.stars.some((s) => s.name === 'Acrux'));
});
test('skyChart: magLimit honoured via the sorted catalog; grid renders on demand', () => {
  const bright = E.skyChart(LONDON.lat, LONDON.lon, NOW, { magLimit: 2 });
  assert.ok(bright.stars.every((s) => s.mag <= 2));
  const grid = E.skyChart(LONDON.lat, LONDON.lon, NOW, { magLimit: 1, grid: true });
  assert.ok(grid.grid.length > 50, 'equatorial grid segments');
  const noGrid = E.skyChart(LONDON.lat, LONDON.lon, NOW, { magLimit: 1 });
  assert.equal(noGrid.grid.length, 0);
});
test('precession scale: the equinox drifts ~1.4° per century along the ecliptic', () => {
  const p = E.precessJ2000(0, 0, Date.UTC(2100, 0, 1, 12));
  near(E.separationDeg(0, 0, p.raDeg, p.decDeg), 1.396, 0.04, 'century shift');
  const chart = E.skyChart(LONDON.lat, LONDON.lon, NOW, { magLimit: 3 });
  assert.ok(chart.stars.length > 30, 'charts keep working across epochs');
});

/* ================= planning ================= */
test('limitingMagnitude: Bortle 1 → 7.8, Bortle 9 → 3.6, monotonic', () => {
  assert.equal(E.limitingMagnitude(1), 7.8);
  assert.equal(E.limitingMagnitude(9), 3.6);
  for (let b = 1; b < 9; b++) assert.ok(E.limitingMagnitude(b) > E.limitingMagnitude(b + 1));
});
test('altitudeCurve: tracks a star across the night, peaks near transit', () => {
  const vega = E.starByName('Vega');
  const curve = E.altitudeCurve({ ra: vega.ra, dec: vega.dec }, LONDON.lat, LONDON.lon,
    Date.UTC(2026, 10, 5, 17, 0), 14, 30);
  assert.equal(curve.length, 29);
  const maxAlt = Math.max(...curve.map((p) => p.altDeg));
  // Vega from London culminates at 90 − |51.5 − 38.8| ≈ 77°
  assert.ok(maxAlt < 78, `max ${maxAlt}`);
  assert.ok(curve.every((p) => typeof p.sunAltDeg === 'number'));
});
test('tonightTargets: a ranked, deterministic plan with real objects', () => {
  const plan = E.tonightTargets(LONDON.lat, LONDON.lon, Date.UTC(2026, 10, 5, 12, 0), { bortle: 4, limit: 10 });
  assert.ok(plan.targets.length >= 5, `targets ${plan.targets.length}`);
  assert.ok(plan.darkEnd > plan.darkStart);
  assert.equal(plan.limitingMag, 6.3);
  for (const t of plan.targets) {
    assert.ok(t.bestAltDeg >= (t.kind === 'planet' ? 10 : 25), `${t.id} alt ${t.bestAltDeg}`);
    assert.ok(t.bestMs >= plan.darkStart && t.bestMs <= plan.darkEnd, `${t.id} best time in the dark`);
    assert.ok(t.score > 0 && typeof t.typeName === 'string');
  }
  const scores = plan.targets.map((t) => t.score);
  deepEq(scores, [...scores].sort((a, b) => b - a), 'sorted by score');
  deepEq(plan, E.tonightTargets(LONDON.lat, LONDON.lon, Date.UTC(2026, 10, 5, 12, 0), { bortle: 4, limit: 10 }), 'deterministic');
});
test('tonightTargets: darker site surfaces fainter targets', () => {
  const city = E.tonightTargets(LONDON.lat, LONDON.lon, Date.UTC(2026, 10, 5, 12, 0), { bortle: 8, limit: 30 });
  const dark = E.tonightTargets(LONDON.lat, LONDON.lon, Date.UTC(2026, 10, 5, 12, 0), { bortle: 2, limit: 30 });
  const faintest = (p) => Math.max(...p.targets.filter((t) => t.kind === 'dso').map((t) => t.mag));
  assert.ok(faintest(dark) >= faintest(city), `dark ${faintest(dark)} vs city ${faintest(city)}`);
});

/* ================= polar alignment ================= */
test('polarisClock: separation matches 2026 reality, dial advances with sidereal time', () => {
  const pc = E.polarisClock(LONDON.lat, LONDON.lon, NOW);
  assert.ok(pc.sepDeg > 0.58 && pc.sepDeg < 0.68, `sep ${pc.sepDeg}`);
  assert.ok(/^\d{1,2}:\d{2}$/.test(pc.clock), pc.clock);
  assert.equal(pc.visible, true);
  near(pc.altDeg, LONDON.lat, 1.2, 'Polaris altitude ≈ latitude');
  const later = E.polarisClock(LONDON.lat, LONDON.lon, NOW + 6 * HOUR);
  const dialMoved = E.wrap360(later.dialDeg - pc.dialDeg);
  near(dialMoved, 90.25, 2, 'dial turns 90° in 6 sidereal-ish hours');
  assert.equal(E.polarisClock(-33, 151, NOW).visible, false, 'no Polaris from Sydney');
});

/* ================= calculators ================= */
test('fovCalc: full-frame on 500mm ≈ 4.1°×2.7°; pixel scale and sampling verdicts', () => {
  const r = E.fovCalc({ focalMm: 500, sensorWmm: 36, sensorHmm: 24, pixelUm: 4.3 });
  near(r.fovWDeg, 4.12, 0.1); near(r.fovHDeg, 2.75, 0.1);
  near(r.pixelScaleArcsec, 1.77, 0.05);
  assert.equal(r.sampling, 'well sampled for typical seeing');
  const over = E.fovCalc({ focalMm: 2800, sensorWmm: 23.5, sensorHmm: 15.7, pixelUm: 3.8 });
  assert.ok(over.pixelScaleArcsec < 1 && over.sampling.indexOf('oversampled') === 0);
  assert.equal(E.fovCalc({ focalMm: 0, sensorWmm: 36, sensorHmm: 24 }), null);
});
test('eyepieceCalc: 1200/25 = 48×, true field, exit pupil', () => {
  const r = E.eyepieceCalc({ focalMm: 1200, epFocalMm: 25, epAfovDeg: 68, apertureMm: 200 });
  assert.equal(r.magnification, 48);
  near(r.trueFovDeg, 68 / 48, 0.01);
  near(r.exitPupilMm, 200 / 48, 0.1);
  assert.equal(r.maxUseful, 400);
  assert.equal(r.note, '');
});

/* ================= meteors, fact, formatters ================= */
test('meteorShowers: Perseids peak Aug 12; Quadrantids straddle new year', () => {
  const aug = E.meteorShowers({ y: 2026, m: 8, d: 12 });
  assert.ok(aug[0].name === 'Perseids' && aug[0].atPeak);
  assert.ok(E.meteorShowers({ y: 2026, m: 1, d: 2 }).find((s) => s.name === 'Quadrantids').active);
  assert.ok(E.meteorShowers({ y: 2026, m: 12, d: 30 }).find((s) => s.name === 'Quadrantids').active);
  assert.equal(E.meteorShowers({ y: 2026, m: 3, d: 10 }).filter((s) => s.active).length, 0);
});
test('dailyFact stable per date; compass rose; formatters', () => {
  deepEq(E.dailyFact('2026-11-05'), E.dailyFact('2026-11-05'));
  assert.equal(E.compass(0), 'N');
  assert.equal(E.compass(225), 'SW');
  assert.equal(E.raToHMS(279.23446), '18h 36m 56s'); // Vega
  assert.equal(E.decToDMS(-16.72), '−16° 43′');
  assert.equal(E.fmtDuration(16.5 * HOUR), '16h 30m');
  assert.ok(E.fmtAU(0.0026).includes('km'));
  assert.equal(E.escapeHTML('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
});
test('tonight briefing still carries sun times, phase, verdicts (v1 API)', () => {
  const t = E.tonight(LONDON.lat, LONDON.lon, Date.UTC(2026, 10, 5, 0, 0));
  assert.equal(t.planets.length, 7);
  assert.ok(t.planets.every((p) => typeof p.note === 'string'));
  assert.ok(t.moonVerdict.length > 10);
  assert.ok(E.tonight(78, 0, Date.UTC(2026, 5, 21)).polarNote.includes('never sets'));
});

/* ================= run ================= */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nzenith: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
