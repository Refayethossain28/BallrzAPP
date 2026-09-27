#!/usr/bin/env node
/**
 * Unit tests for argus/engine.js — the pure "eye on the world" engine behind
 * Argus (geodesy, the sun and the terminator, the orthographic globe
 * projection, coastline decoding, satellite propagation from orbital
 * elements, feed parsers for OpenSky / adsb.lol / USGS / CelesTrak / TLE /
 * AISStream / FIRMS, the OpenSky credit budget, the offline simulation, HUD
 * analysis, the voice-command grammar and the shareable-scene codec).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-argus-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'argus', 'land.js'), 'utf8'), sandbox, { filename: 'argus/land.js' });
const LAND = sandbox.module.exports;
sandbox.module = { exports: {} };
vm.runInContext(readFileSync(join(ROOT, 'argus', 'engine.js'), 'utf8'), sandbox, { filename: 'argus/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0); // 2026-09-27 12:00 UTC
const { SECOND, MINUTE, HOUR, DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, (m || '') + ` expected ${a} ≈ ${b} (±${tol})`);

const ISS = E.BUNDLED_SATS[0];
const view = (o) => E.makeView(Object.assign({ lat: 51.5, lon: -0.1, radius: 300, cx: 400, cy: 300 }, o));

/* ---------- hashing & text ---------- */
test('hashStr/rand01 are deterministic and spread', () => {
  assert.equal(E.hashStr('argus'), E.hashStr('argus'));
  assert.notEqual(E.hashStr('argus'), E.hashStr('argos'));
  const r = E.rand01('seed:1');
  assert.ok(r >= 0 && r < 1);
  assert.notEqual(r, E.rand01('seed:2'));
});
test('escapeHTML neutralises markup', () => {
  assert.equal(E.escapeHTML('<b a="1">&\'</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;');
});

/* ---------- geodesy ---------- */
test('haversine: London→Paris ≈ 344 km, bearing south-east', () => {
  near(E.haversineKm(51.507, -0.128, 48.857, 2.352), 344, 3);
  near(E.bearingDeg(51.507, -0.128, 48.857, 2.352), 148, 2);
  assert.equal(E.compassPoint(148), 'SE');
});
test('destination is the inverse of haversine + bearing', () => {
  const d = E.destination(51.507, -0.128, 148.1, 344);
  near(d.lat, 48.857, 0.05); near(d.lon, 2.352, 0.08);
  assert.equal(E.destination(0, 179, 90, 300).lon < 0, true, 'wraps across the antimeridian');
});
test('formatters: coordinates, distance, altitude, speed, age', () => {
  assert.equal(E.formatCoord(51.507, -0.128), '51.507°N 0.128°W');
  assert.equal(E.formatDist(0.42), '420 m');
  assert.equal(E.formatDist(12.34), '12.3 km');
  assert.equal(E.formatDist(1234), '1,234 km');
  assert.equal(E.formatAlt(10668), '10,668 m · FL350');
  assert.equal(E.formatAlt(420000), '420 km');
  assert.equal(E.formatSpeed(250), '900 km/h · 486 kt');
  assert.equal(E.formatSpeed(7660), '7.66 km/s');
  assert.equal(E.formatAge(10 * SECOND), 'just now');
  assert.equal(E.formatAge(5 * MINUTE), '5 min ago');
  assert.equal(E.formatAge(3 * HOUR), '3 h ago');
  assert.equal(E.formatAge(2 * DAY), '2 d ago');
});

/* ---------- the sun ---------- */
test('subsolar point: noon UTC puts the sun on Greenwich; declination follows the season', () => {
  const s = E.subsolarPoint(NOW);
  near(s.lon, 0, 0.01);
  near(s.lat, -1.5, 1.5, 'late September: sun just south of the equator');
  near(E.subsolarPoint(Date.UTC(2026, 5, 21, 12)).lat, 23.4, 0.3, 'June solstice');
  near(Math.abs(E.subsolarPoint(Date.UTC(2026, 0, 1, 0)).lon), 180, 0.01, 'midnight UTC → antimeridian');
});
test('solarElevation: noon at the subsolar point is 90°, antipode is −90°', () => {
  near(E.solarElevation(E.subsolarPoint(NOW).lat, 0, NOW), 90, 0.01);
  near(E.solarElevation(-E.subsolarPoint(NOW).lat, 180, NOW), -90, 0.01);
  assert.ok(E.solarElevation(51.5, -0.1, NOW) > 30, 'London midday in September is well lit');
  assert.ok(E.solarElevation(51.5, -0.1, NOW + 12 * HOUR) < -20, 'and dark at midnight');
});

/* ---------- projection ---------- */
test('project: the view centre lands on the screen centre, the far side is invisible', () => {
  const v = view();
  const p = E.project(51.5, -0.1, v);
  near(p.x, 400, 1e-9); near(p.y, 300, 1e-9); assert.equal(p.visible, true);
  assert.equal(E.project(-51.5, 179.9, v).visible, false, 'antipode');
  const north = E.project(89, -0.1, v);
  assert.ok(north.y < 300 && north.visible, 'north is up');
  const east = E.project(51.5, 40, v);
  assert.ok(east.x > 400, 'east is right');
});
test('unproject inverts project on the visible disc and is null off the globe', () => {
  const v = view();
  for (const [lat, lon] of [[51.5, -0.1], [60, 30], [20, -40], [0, 0]]) {
    const p = E.project(lat, lon, v);
    const back = E.unproject(p.x, p.y, v);
    near(back.lat, lat, 1e-6); near(back.lon, lon, 1e-6);
  }
  assert.equal(E.unproject(400 + 301, 300, v), null);
  assert.equal(E.unproject(400, 300 - 300, v) !== null, true, 'the rim is on the globe');
});
test('rotateView follows the finger; zoom is clamped', () => {
  const v = view();
  const r = E.rotateView(v, 30, 0);
  assert.ok(r.lon < v.lon, 'dragging right rotates the globe so the ground moves right (centre moves west)');
  const u = E.rotateView(v, 0, -30);
  assert.ok(u.lat < v.lat, 'dragging up shows more of the south');
  assert.equal(E.rotateView(view({ lat: 88 }), 0, 500).lat, 89, 'latitude clamps at 89');
  assert.equal(E.zoomView(v, 100, 40, 1000).radius, 1000);
  assert.equal(E.zoomView(v, 0.0001, 40, 1000).radius, 40);
  const z = E.zoomAt(v, 2, 500, 250, 40, 100000);
  const before = E.unproject(500, 250, v), after = E.unproject(500, 250, z);
  near(after.lat, before.lat, 0.5); near(after.lon, before.lon, 0.5);
});
test('fitRadius and bboxOfView: whole globe → null, zoomed → a tight box', () => {
  assert.equal(E.fitRadius(800, 600, 24), 276);
  assert.equal(E.bboxOfView(view({ radius: 200 }), 800, 600), null, 'globe smaller than the screen');
  const b = E.bboxOfView(view({ radius: 3000 }), 800, 600);
  assert.ok(b && b.lamin > 44 && b.lamax < 58 && b.lomin > -15 && b.lomax < 15);
  assert.equal(E.inBbox(51.5, 0, b), true);
  assert.equal(E.inBbox(20, 0, b), false);
  assert.equal(E.inBbox(20, 0, null), true);
});
test('landRings decodes the coastline table; projectRing pushes the far side to the rim', () => {
  const rings = E.landRings(LAND);
  assert.ok(rings.length > 100, 'over a hundred landmasses');
  const flat = rings.flat();
  assert.ok(flat.every(([lat, lon]) => Math.abs(lat) <= 90 && Math.abs(lon) <= 180));
  const v = view();
  const pr = E.projectRing([[51, 0], [52, 1], [51, 1], [-51, 179]], v);
  assert.equal(pr.length, 4);
  near(Math.hypot(pr[3][0] - 400, pr[3][1] - 300), 300, 1e-6, 'antipodal point sits on the rim');
  assert.equal(E.projectRing([[-51, 179], [-50, 178]], v), null, 'nothing visible → null');
});
test('clipRing: fully visible rings pass through; partial rings close along the horizon on the land side', () => {
  const rings = E.landRings(LAND);
  const v = view({ lat: 30, lon: 0, radius: 276, cx: 400, cy: 300 });
  // Iceland-sized ring, fully visible from the default view: one polygon, same vertex count
  const iceland = rings.find((r) => r.some(([lat, lon]) => lat > 64 && lat < 66.5 && lon > -20 && lon < -17) && r.length < 40);
  assert.ok(iceland, 'found Iceland');
  const ip = E.clipRing(iceland, v);
  assert.equal(ip.length, 1); assert.equal(ip[0].length, iceland.length);
  assert.ok(E.signedArea(ip[0]) > 0, 'screen winding of a fully visible ring is the reference sign');
  // known land is inside the union of clipped polygons, known sea is not
  const on = (lat, lon, vv) => { const p = E.project(lat, lon, vv); return E.landAtScreen(rings, vv, p.x, p.y); };
  assert.equal(on(55.75, 37.6, v), true, 'Moscow');
  assert.equal(on(48.86, 2.35, v), true, 'Paris');
  assert.equal(on(23, 12, v), true, 'Sahara');
  assert.equal(on(30, -40, v), false, 'mid-Atlantic');
  assert.equal(on(-20, 60, v), false, 'Indian Ocean');
  // Eurasia is cut by the horizon here: a partial ring still reports the right side
  const eurasia = rings.reduce((a, b) => (a.length > b.length ? a : b));
  assert.ok(E.clipRing(eurasia, v).length >= 1);
  assert.notEqual(E.clipRing(eurasia, v)[0].length, eurasia.length, 'partially clipped');
  // the South Pacific view that used to fill the screen with Antarctica
  const sp = view({ lat: -48.4, lon: -88.4, radius: 1104, cx: 640, cy: 400 });
  assert.equal(on(-48.4, -88.4, sp), false, 'open ocean off Chile');
  assert.equal(on(-33.4, -70.6, sp), true, 'Santiago');
  assert.equal(on(-75, -90, sp), true, 'Antarctic interior');
  // straight down onto the south pole: Antarctica is a proper cap, the Southern Ocean is sea
  const pole = view({ lat: -89, lon: 0, radius: 300, cx: 400, cy: 300 });
  assert.equal(on(-88, 10, pole), true, 'near the pole');
  assert.equal(on(-60, 0, pole), false, 'Southern Ocean');
  assert.equal(on(-60, 120, pole), false, 'Southern Ocean, other side');
  // nothing visible → no polygons
  deepEq(E.clipRing([[-51, 179], [-50, 178], [-52, 178]], view()), []);
  assert.equal(E.pointInPolygon(1, 1, [[0, 0], [2, 0], [2, 2], [0, 2]]), true);
  assert.equal(E.pointInPolygon(3, 1, [[0, 0], [2, 0], [2, 2], [0, 2]]), false);
});
test('graticule covers the globe; starfield is deterministic', () => {
  const g = E.graticule(30);
  assert.equal(g.length, 12 + 5);
  deepEq(E.starfield('s', 3, 100, 100), E.starfield('s', 3, 100, 100));
  assert.ok(E.starfield('s', 50, 100, 100).every((s) => s.x >= 0 && s.x <= 100 && s.y >= 0 && s.y <= 100));
});
test('dayRegion: a closed polygon whose lit side holds the sunlit ground and not the dark side', () => {
  // noon UTC: sun over Greenwich. Look at lon 60 so both 30°E (lit) and 120°E (past the terminator) are on the near side.
  const v = view({ lat: 0, lon: 60 });
  const day = E.dayRegion(v, NOW, 90);
  assert.equal(day.points.length, 91 + 89);
  assert.equal(day.sunVisible, true, 'the subsolar point is 60° from the view centre');
  const inPoly = (pt, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  assert.equal(inPoly([day.sunScreen.x, day.sunScreen.y], day.points), true, 'the sun itself is lit');
  const lit = E.project(0, 30, v), dark = E.project(0, 120, v), edge = E.project(0, 85, v);
  assert.equal(lit.visible && dark.visible, true);
  assert.equal(inPoly([lit.x, lit.y], day.points), true, '30°E at noon is day');
  assert.equal(inPoly([dark.x, dark.y], day.points), false, '120°E at noon UTC is night');
  assert.equal(inPoly([edge.x, edge.y], day.points), true, 'just short of the terminator is still lit');
  // sun behind the globe: still a valid closed region, sun flagged invisible
  const night = E.dayRegion(view({ lat: 0, lon: 180 }), NOW, 60);
  assert.equal(night.sunVisible, false);
  assert.equal(night.points.length, 61 + 59);
  const midnight = E.project(0, 180, view({ lat: 0, lon: 180 }));
  assert.equal(inPoly([midnight.x, midnight.y], night.points), false, 'the antipode of the sun is dark');
});

/* ---------- styles & layers ---------- */
test('styles and layers resolve by key and hotkey with safe fallbacks', () => {
  assert.equal(E.styleByKey('nvg').label, 'Night vision');
  assert.equal(E.styleByKey('nope').key, 'optical');
  assert.equal(E.styleByHotkey('3').key, 'flir');
  assert.equal(E.styleByHotkey('9'), null);
  assert.equal(E.LAYERS.length, 6);
  assert.equal(E.layerByKey('ship').keyless, false);
  assert.equal(E.layerByKey('quake').keyless, true);
  assert.equal(E.layerByKey('x'), null);
  assert.equal(E.pollDue(0, NOW, MINUTE), true);
  assert.equal(E.pollDue(NOW - 30 * SECOND, NOW, MINUTE), false);
  assert.equal(E.pollDue(NOW - 2 * MINUTE, NOW, MINUTE), true);
  assert.equal(E.pollDue(0, NOW, 0), false, 'push feeds are never polled');
});

/* ---------- OpenSky ---------- */
test('openSkyUrl + credits: global costs 4, a small box costs 1', () => {
  assert.equal(E.openSkyUrl(null), 'https://opensky-network.org/api/states/all');
  const box = { lamin: 50, lomin: -2, lamax: 53, lomax: 2 };
  assert.equal(E.openSkyUrl(box), 'https://opensky-network.org/api/states/all?lamin=50.000&lomin=-2.000&lamax=53.000&lomax=2.000');
  assert.equal(E.openSkyCredits(null), 4);
  assert.equal(E.openSkyCredits(box), 1);
  assert.equal(E.openSkyCredits({ lamin: 40, lomin: -10, lamax: 49, lomax: 0 }), 2);
  assert.equal(E.openSkyCredits({ lamin: 30, lomin: -10, lamax: 49, lomax: 10 }), 3);
  assert.equal(E.openSkyCredits({ lamin: 0, lomin: -30, lamax: 49, lomax: 10 }), 4);
});
test('creditBudget: rolling 24 h, refuses when spent, forgets old entries', () => {
  const ledger = [{ ts: NOW - 25 * HOUR, cost: 4 }, { ts: NOW - HOUR, cost: 4 }, { ts: NOW - 2 * HOUR, cost: 1 }];
  const b = E.creditBudget(ledger, NOW, 4);
  assert.equal(b.spent, 5);
  assert.equal(b.remaining, 395);
  assert.equal(b.ledger.length, 2, 'the day-old entry is dropped');
  assert.equal(b.allowed, true);
  const full = Array.from({ length: 100 }, (_, i) => ({ ts: NOW - i * MINUTE, cost: 4 }));
  const f = E.creditBudget(full, NOW, 4);
  assert.equal(f.remaining, 0);
  assert.equal(f.allowed, false);
  assert.equal(E.creditBudget(null, NOW, 0).allowed, true);
});
test('parseOpenSky: state vectors → contacts, nulls skipped, units preserved', () => {
  const json = { time: 1790510400, states: [
    ['4b1805', 'SWR123  ', 'Switzerland', 1790510390, 1790510395, 8.55, 47.45, 10668.0, false, 245.5, 90.0, -2.1, null, 10900.0, '1000', false, 0],
    ['abcd', 'NOPOS', 'X', 1790510390, 1790510395, null, null, null, true, null, null, null, null, null, null, false, 0],
    ['ground1', '', 'UK', 1790510390, 1790510395, -0.46, 51.47, null, true, 3.0, 180.0, null, null, null, null, false, 0]
  ] };
  const out = E.parseOpenSky(json, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'air:4b1805');
  assert.equal(out[0].label, 'SWR123');
  assert.equal(out[0].alt, 10900, 'geometric altitude preferred');
  assert.equal(out[0].speed, 245.5);
  assert.equal(out[0].heading, 90);
  assert.equal(out[0].vrate, -2.1);
  assert.equal(out[0].ts, 1790510390 * 1000);
  assert.equal(out[1].label, 'GROUND1', 'no callsign → icao upper-cased');
  assert.equal(out[1].onGround, true);
  assert.equal(out[1].alt, null);
  deepEq(E.parseOpenSky(null, NOW), []);
});

/* ---------- adsb.lol ---------- */
test('parseAdsbLol: feet → metres, knots → m/s, ground handled', () => {
  const out = E.parseAdsbLol({ ac: [
    { hex: 'ae1234', flight: 'RCH441 ', r: '05-1234', t: 'C17', desc: 'BOEING C-17A', lat: 38.9, lon: -77.0, alt_baro: 25000, gs: 400, track: 270, seen: 5 },
    { hex: 'ae9999', lat: 'x', lon: 0 },
    { hex: 'ae5555', lat: 51.1, lon: -1.2, alt_baro: 'ground', gs: 0, seen: 0 }
  ] }, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'mil:ae1234');
  assert.equal(out[0].kind, 'mil');
  near(out[0].alt, 7620, 0.01);
  near(out[0].speed, 205.78, 0.01);
  assert.equal(out[0].ts, NOW - 5000);
  assert.equal(out[1].onGround, true);
  assert.equal(out[1].alt, 0);
  assert.equal(out[1].label, 'ae5555');
});

/* ---------- USGS ---------- */
test('parseQuakes: sorted by magnitude, age computed, radius grows with magnitude', () => {
  const gj = { features: [
    { id: 'a', properties: { mag: 4.2, place: '10 km S of X', time: NOW - 3 * HOUR, tsunami: 0 }, geometry: { coordinates: [-120.1, 36.2, 8.5] } },
    { id: 'b', properties: { mag: 6.1, place: 'near Y', time: NOW - HOUR, tsunami: 1 }, geometry: { coordinates: [142.0, 38.3, 30] } },
    { id: 'c', properties: { mag: 1.0 }, geometry: null }
  ] };
  const q = E.parseQuakes(gj, NOW);
  assert.equal(q.length, 2);
  assert.equal(q[0].id, 'quake:b');
  assert.equal(q[0].label, 'M6.1 near Y');
  assert.equal(q[0].tsunami, true);
  assert.equal(q[0].age, HOUR);
  assert.equal(q[1].depthKm, 8.5);
  assert.ok(E.quakeRadiusPx(6) > E.quakeRadiusPx(4) && E.quakeRadiusPx(4) > E.quakeRadiusPx(1));
  assert.equal(E.usgsUrl('day'), 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
  assert.equal(E.usgsUrl('bogus'), E.usgsUrl('day'));
});

/* ---------- FIRMS ---------- */
test('parseCSV + parseFires: rows → contacts with acquisition timestamps', () => {
  const csv = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n' +
              '-15.5,28.3,340.1,0.4,0.4,2026-09-27,0135,N,VIIRS,n,2.0NRT,300.2,12.6,N\n' +
              'bad,row\n' +
              '34.1,-118.2,355.0,0.5,0.4,2026-09-27,2010,N,VIIRS,h,2.0NRT,310,88.4,D\n';
  const rows = E.parseCSV(csv);
  assert.equal(rows.length, 3);
  const fires = E.parseFires(csv, NOW);
  assert.equal(fires.length, 2);
  assert.equal(fires[0].ts, Date.UTC(2026, 8, 27, 1, 35));
  assert.equal(fires[1].frp, 88.4);
  assert.equal(fires[1].label, 'Fire · FRP 88 MW');
  assert.equal(E.firmsUrl('KEY 1', 9), 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/KEY%201/VIIRS_SNPP_NRT/world/5');
  deepEq(E.parseCSV(''), []);
});

/* ---------- AIS ---------- */
test('AIS: subscribe message and PositionReport parsing with sentinel values', () => {
  const sub = E.aisSubscribeMessage(' key ', { lamin: 50, lomin: -2, lamax: 53, lomax: 2 });
  deepEq(sub, { APIKey: 'key', BoundingBoxes: [[[50, -2], [53, 2]]], FilterMessageTypes: ['PositionReport'] });
  deepEq(E.aisSubscribeMessage('k', null).BoundingBoxes, [[[-90, -180], [90, 180]]]);
  const msg = { MessageType: 'PositionReport', MetaData: { MMSI: 235000001, ShipName: 'EVER GIVEN  ', latitude: 51.95, longitude: 4.05 },
    Message: { PositionReport: { Latitude: 51.95, Longitude: 4.05, Cog: 92.5, Sog: 12.3, TrueHeading: 511, NavigationalStatus: 0 } } };
  const c = E.parseAIS(msg, NOW);
  assert.equal(c.id, 'ship:235000001');
  assert.equal(c.label, 'EVER GIVEN');
  near(c.speed, 12.3 * 0.514444, 1e-9);
  assert.equal(c.heading, 92.5, 'heading 511 = unavailable → fall back to COG');
  assert.equal(E.parseAIS({ MessageType: 'ShipStaticData' }, NOW), null);
  assert.equal(E.parseAIS({ MessageType: 'PositionReport', Message: { PositionReport: { Latitude: 91, Longitude: 0 } } }, NOW), null);
});
test('mergeContacts: newest wins by id, stale dropped, capped', () => {
  const roster = [{ id: 'a', ts: NOW - 30 * MINUTE }, { id: 'b', ts: NOW - MINUTE }];
  const m = E.mergeContacts(roster, [{ id: 'a', ts: NOW }, { id: 'c', ts: NOW - 2 * MINUTE }], NOW, 20 * MINUTE, 10);
  deepEq(m.map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(m[0].ts, NOW, 'a refreshed');
  const capped = E.mergeContacts([], Array.from({ length: 5 }, (_, i) => ({ id: 'x' + i, ts: NOW - i })), NOW, 0, 3);
  assert.equal(capped.length, 3);
  assert.equal(capped[0].id, 'x0');
});

/* ---------- satellites ---------- */
test('gmstDeg matches the J2000 reference (280.46° at 2000-01-01 12:00 UTC)', () => {
  near(E.gmstDeg(Date.UTC(2000, 0, 1, 12)), 280.4606, 0.001);
  near(E.gmstDeg(Date.UTC(2000, 0, 1, 12) + DAY), 280.4606 + 0.98565, 0.001, 'one day = one sidereal day + 0.9856°');
});
test('solveKepler: circular orbit is the identity, eccentric orbits converge', () => {
  near(E.solveKepler(1.234, 0), 1.234, 1e-12);
  const e = 0.7, E1 = E.solveKepler(2.0, e);
  near(E1 - e * Math.sin(E1), 2.0, 1e-9);
});
test('propagate the ISS: ~420 km up, 7.66 km/s, 93-minute period, |lat| ≤ inclination, track drifts west', () => {
  const p = E.propagate(ISS, NOW);
  near(p.altKm, 420, 15); near(p.speedKmS, 7.66, 0.03); near(p.periodMin, 92.96, 0.1);
  assert.ok(Math.abs(p.lat) <= ISS.inc + 0.01);
  let maxLat = 0;
  for (let t = 0; t < 100 * MINUTE; t += MINUTE) maxLat = Math.max(maxLat, Math.abs(E.propagate(ISS, NOW + t).lat));
  near(maxLat, ISS.inc, 0.5, 'reaches its inclination once per orbit');
  const p2 = E.propagate(ISS, NOW + p.periodMin * MINUTE);
  near(p2.lat, p.lat, 1.5, 'back to the same latitude after one orbit');
  near(E.wrapLon(p2.lon - p.lon), -23.3, 1.5, 'Earth turned ~23° east underneath');
  assert.equal(E.propagate({ mm: 0 }, NOW), null);
  assert.equal(E.propagate(null, NOW), null);
});
test('propagate a geostationary element: ~35,786 km up and almost still over its longitude', () => {
  const goes = E.BUNDLED_SATS.find((s) => s.label === 'GOES 16');
  const a = E.propagate(goes, NOW), b = E.propagate(goes, NOW + 6 * HOUR);
  near(a.altKm, 35786, 120);
  near(E.wrapLon(b.lon - a.lon), 0, 1.5, 'stays put over six hours');
  near(a.speedKmS, 3.07, 0.05);
});
test('satContact/groundTrack/lookAngles/nextPass', () => {
  const c = E.satContact(ISS, NOW);
  assert.equal(c.kind, 'sat'); assert.equal(c.norad, 25544); near(c.alt / 1000, 420, 15);
  const tr = E.groundTrack(ISS, NOW, NOW + 30 * MINUTE, 10);
  assert.equal(tr.length, 11);
  // an observer directly under the satellite sees it at the zenith
  const p = E.propagate(ISS, NOW);
  const la = E.lookAngles(p, p.lat, p.lon);
  near(la.elevation, 90, 0.5); near(la.rangeKm, p.altKm, 25);
  const far = E.lookAngles(p, -p.lat, E.wrapLon(p.lon + 180));
  assert.ok(far.elevation < -80, 'antipode: far below the horizon');
  // a pass exists that contains NOW for that observer
  const pass = E.nextPass(ISS, p.lat, p.lon, NOW - 10 * MINUTE, { minEl: 10, stepSec: 30, maxHours: 1 });
  assert.ok(pass && pass.rise <= NOW && pass.maxElevation > 80, 'the overhead pass is found');
  assert.ok(pass.durationMs > 3 * MINUTE && pass.durationMs < 12 * MINUTE, 'a LEO pass lasts minutes');
  assert.equal(E.nextPass(ISS, 89, 0, NOW, { minEl: 10, maxHours: 3, stepSec: 60 }), null, 'never rises 10° at the pole');
  assert.equal(E.nextPass({ mm: 0 }, 0, 0, NOW), null);
});
test('parseGP and parseTLE read the same ISS elements', () => {
  const gp = E.parseGP([{ OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, EPOCH: '2026-09-20T12:00:00.000000', MEAN_MOTION: 15.49, ECCENTRICITY: 0.0006703,
    INCLINATION: 51.6416, RA_OF_ASC_NODE: 247.4627, ARG_OF_PERICENTER: 130.536, MEAN_ANOMALY: 325.028 }, { OBJECT_NAME: 'junk' }]);
  assert.equal(gp.length, 1);
  assert.equal(gp[0].epoch, Date.UTC(2026, 8, 20, 12));
  assert.equal(gp[0].id, 'sat:25544');
  const tle = E.parseTLE('ISS (ZARYA)\n' +
    '1 25544U 98067A   26263.50000000  .00016717  00000-0  10270-3 0  9005\n' +
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49000000 12345\n');
  assert.equal(tle.length, 1);
  assert.equal(tle[0].label, 'ISS (ZARYA)');
  assert.equal(tle[0].norad, 25544);
  near(tle[0].epoch, Date.UTC(2026, 8, 20, 12), 1000, 'day 263.5 of 2026');
  near(tle[0].inc, 51.6416, 1e-9); near(tle[0].ecc, 0.0006703, 1e-9); near(tle[0].mm, 15.49, 1e-9);
  const a = E.propagate(gp[0], NOW), b = E.propagate(tle[0], NOW);
  near(a.lat, b.lat, 0.05); near(a.lon, b.lon, 0.05);
  assert.equal(E.celestrakUrl('stations'), 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json');
  assert.equal(E.celestrakUrl('../evil'), E.celestrakUrl('stations'), 'unsafe group names fall back');
});

/* ---------- simulation ---------- */
test('simContacts: deterministic, labelled, moving along real routes', () => {
  const a = E.simContacts('demo', NOW, 40), b = E.simContacts('demo', NOW, 40);
  deepEq(a, b);
  assert.equal(a.length, 40);
  assert.ok(a.every((c) => c.sim && c.src === 'sim' && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180));
  const kinds = new Set(a.map((c) => c.kind));
  assert.ok(kinds.has('air') && kinds.has('ship'));
  const later = E.simContacts('demo', NOW + 10 * MINUTE, 40);
  const moved = E.haversineKm(a[0].lat, a[0].lon, later[0].lat, later[0].lon);
  near(moved, a[0].speed * 600 / 1000, 5, 'ten minutes at its speed');
  assert.equal(a[0].label, later[0].label);
  assert.notEqual(JSON.stringify(E.simContacts('other', NOW, 3)), JSON.stringify(E.simContacts('demo', NOW, 3)));
});

/* ---------- HUD analysis ---------- */
const CONTACTS = [
  { id: 'air:1', kind: 'air', label: 'BAW1', lat: 51.6, lon: -0.2, alt: 9000, speed: 240, heading: 90, ts: NOW - 20 * SECOND, src: 'opensky', country: 'UK' },
  { id: 'air:2', kind: 'air', label: 'AFR2', lat: 48.9, lon: 2.4, alt: 11000, speed: 260, heading: 180, ts: NOW, src: 'opensky' },
  { id: 'ship:1', kind: 'ship', label: 'BOAT', lat: 51.9, lon: 4.0, alt: 0, speed: 6, heading: 45, ts: NOW, src: 'ais', mmsi: '1' },
  { id: 'quake:1', kind: 'quake', label: 'M5.2 x', lat: -41.3, lon: 174.8, mag: 5.2, depthKm: 10, ts: NOW - HOUR, src: 'usgs' },
  { id: 'quake:2', kind: 'quake', label: 'M2.1 y', lat: 51.0, lon: 1.0, mag: 2.1, depthKm: 3, ts: NOW - 2 * HOUR, src: 'usgs' },
  { id: 'sat:25544', kind: 'sat', label: 'ISS', lat: 10, lon: 10, alt: 420000, speed: 7660, periodMin: 93, ts: NOW, src: 'bundled', epoch: NOW - 7 * DAY, norad: 25544 }
];
test('contactsNear / nearest / countByKind / summarize', () => {
  const near1 = E.contactsNear(CONTACTS, 51.5, -0.1, 400);
  deepEq(near1.map((n) => n.contact.id), ['air:1', 'quake:2', 'ship:1', 'air:2']);
  assert.equal(E.contactsNear(CONTACTS, 51.5, -0.1, 400, 2).length, 2);
  assert.equal(E.nearest(CONTACTS, 51.5, -0.1, 'ship').contact.id, 'ship:1');
  assert.equal(E.nearest(CONTACTS, 51.5, -0.1, 'fire'), null);
  deepEq(E.countByKind(CONTACTS, null), { air: 2, ship: 1, quake: 2, sat: 1 });
  deepEq(E.countByKind(CONTACTS, { lamin: 50, lamax: 53, lomin: -1, lomax: 5 }), { air: 1, ship: 1, quake: 1 });
  const s = E.summarize(CONTACTS, null);
  assert.equal(s.text, '2 aircraft · 1 ships · 1 satellites · 2 earthquakes');
  assert.equal(s.strongestQuake.id, 'quake:1');
  assert.equal(E.summarize([], null).text, 'no contacts');
});
test('describeContact: kind-specific rows, no markup, honest sources', () => {
  const air = E.describeContact(CONTACTS[0], NOW);
  deepEq(air.map((r) => r[0]), ['Type', 'Position', 'Altitude', 'Speed', 'Heading', 'Registered', 'Seen', 'Source']);
  assert.equal(air[0][1], 'Aircraft');
  assert.equal(air[4][1], '90° E');
  assert.equal(air[7][1], 'OpenSky Network');
  const q = E.describeContact(CONTACTS[3], NOW);
  assert.equal(q[2][1], 'M5.2');
  assert.equal(q[4][1], '1 h ago');
  const sat = E.describeContact(CONTACTS[5], NOW);
  assert.equal(sat[2][1], '420 km');
  assert.equal(sat[5][1], 'bundled snapshot, 7 d ago');
  const sim = E.describeContact({ kind: 'ship', sim: true, lat: 0, lon: 0, ts: NOW, src: 'sim' }, NOW);
  assert.equal(sim[0][1], 'Vessel · SIMULATED');
  deepEq(E.describeContact(null, NOW), []);
});
test('visibleContacts + hitTest: only the near hemisphere, on screen, with boxes', () => {
  const v = view();
  const placed = E.visibleContacts(CONTACTS, v, 800, 600, 20);
  const ids = placed.map((p) => p.contact.id);
  assert.ok(ids.includes('air:1') && ids.includes('ship:1'));
  assert.ok(!ids.includes('quake:1'), 'New Zealand is on the far side');
  const p0 = placed.find((p) => p.contact.id === 'air:1');
  assert.equal(p0.box.length, 4);
  assert.equal(E.hitTest(placed, p0.x + 3, p0.y - 2, 18).contact.id, 'air:1');
  assert.equal(E.hitTest(placed, p0.x + 300, p0.y + 300, 18), null);
});

/* ---------- places & commands ---------- */
test('findPlace / parseLatLon', () => {
  assert.equal(E.findPlace('tokyo').name, 'Tokyo');
  assert.equal(E.findPlace('new').name, 'New York', 'prefix match');
  assert.equal(E.findPlace('the city of paris france').name, 'Paris', 'contains match');
  assert.equal(E.findPlace('atlantis'), null);
  deepEq(E.parseLatLon('51.5, -0.1'), { name: '51.500°N 0.100°W', lat: 51.5, lon: -0.1 });
  assert.equal(E.parseLatLon('95, 0'), null);
  assert.equal(E.parseLatLon('hello'), null);
});
test('parseCommand: navigation, zoom, styles, layers, tracking, counting, passes, misc', () => {
  const c = E.parseCommand;
  deepEq(c('Take me to Tokyo.'), { type: 'goto', place: { name: 'Tokyo', lat: 35.676, lon: 139.65 }, zoom: 'region' });
  assert.equal(c('zoom in on Dubai').zoom, 'close');
  assert.equal(c('zoom in on Dubai').place.name, 'Dubai');
  assert.equal(c('zoom in on 51.5, -0.1').place.lat, 51.5);
  assert.equal(c('go to 40.7, -74').place.lat, 40.7);
  assert.equal(c('Singapore').type, 'goto');
  deepEq(c('zoom out to the globe'), { type: 'zoom', factor: 0 });
  assert.equal(c('zoom out').factor, 0.5);
  assert.equal(c('zoom in').factor, 2);
  assert.equal(c('switch to night vision').key, 'nvg');
  assert.equal(c('enter flir mode').key, 'flir');
  assert.equal(c('go noir').key, 'noir');
  assert.equal(c('turn on CRT mode').key, 'crt');
  assert.equal(c('back to normal view').key, 'optical');
  deepEq(c('show ships'), { type: 'layer', kind: 'ship', on: true, only: false });
  deepEq(c('hide the earthquakes'), { type: 'layer', kind: 'quake', on: false, only: false });
  deepEq(c('only satellites'), { type: 'layer', kind: 'sat', on: true, only: true });
  deepEq(c('track the nearest flight'), { type: 'track', kind: 'air', pick: 'nearest' });
  deepEq(c('follow the ISS'), { type: 'track', kind: 'sat', pick: 'iss' });
  deepEq(c('lock on to the strongest earthquake'), { type: 'track', kind: 'quake', pick: 'strongest' });
  deepEq(c('ride the highest satellite'), { type: 'track', kind: 'sat', pick: 'highest' });
  const cnt = c('how many flights over Texas?');
  assert.equal(cnt.type, 'count'); assert.equal(cnt.kind, 'air'); assert.equal(cnt.place.name, 'Texas');
  assert.equal(c('how many ships').place, null);
  assert.equal(c('how many ships near nowhereville').placeText, 'nowhereville');
  assert.equal(c('when is the next ISS pass').pick, 'iss');
  deepEq(c('detection mesh on'), { type: 'mesh', on: true });
  deepEq(c('hide the mesh'), { type: 'mesh', on: false });
  deepEq(c('tour'), { type: 'tour', on: true });
  deepEq(c('stop the tour'), { type: 'tour', on: false });
  assert.equal(c('where am I').type, 'locate');
  assert.equal(c('stop').type, 'untrack');
  assert.equal(c('help').type, 'help');
  assert.equal(c('').type, 'noop');
  deepEq(c('make me a sandwich'), { type: 'unknown', text: 'make me a sandwich' });
  assert.ok(E.HELP_LINES.length >= 5);
});

/* ---------- shareable state ---------- */
test('serializeState/parseState round-trip, defaults, junk tolerance', () => {
  const st = { lat: 51.5, lon: -0.1, zoom: 3, style: 'nvg', layers: ['air', 'sat', 'bogus'], track: 'sat:25544', mesh: true };
  const h = E.serializeState(st);
  assert.equal(h, '#lat=51.500&lon=-0.100&z=3.00&s=nvg&l=air,sat&t=sat%3A25544&m=1');
  const back = E.parseState(h);
  assert.equal(back.lat, 51.5); assert.equal(back.zoom, 3); assert.equal(back.style, 'nvg');
  deepEq(back.layers, ['air', 'sat']); assert.equal(back.track, 'sat:25544'); assert.equal(back.mesh, true);
  deepEq(E.parseState(''), E.defaultState());
  deepEq(E.parseState('#l=none').layers, []);
  const junk = E.parseState('#lat=999&lon=-720&z=abc&s=<script>&l=,,&t=%E0%A4%A&m=2');
  assert.equal(junk.lat, 90); assert.equal(junk.lon, 0); assert.equal(junk.zoom, 1);
  assert.equal(junk.style, 'optical'); deepEq(junk.layers, []); assert.equal(junk.mesh, false);
  assert.equal(E.serializeState({ lat: 0, lon: 0, zoom: 1, style: 'optical', layers: [] }), '#lat=0.000&lon=0.000&z=1.00&l=none');
});

/* ---------- tour & easing ---------- */
test('autoRotate turns east; easeView interpolates the short way round with log zoom', () => {
  const v = view({ lon: 170 });
  near(E.autoRotate(v, 1000, 4).lon, 174, 1e-9);
  near(E.autoRotate(v, 5000, 4).lon, -170, 1e-9, 'wraps');
  const from = view({ lat: 0, lon: 170, radius: 100 }), to = view({ lat: 0, lon: -170, radius: 400 });
  near(E.easeView(from, to, 0).lon, 170, 1e-9);
  near(E.easeView(from, to, 1).lon, -170, 1e-9);
  near(Math.abs(E.easeView(from, to, 0.5).lon), 180, 1e-6, 'crosses the antimeridian, not the long way');
  near(E.easeView(from, to, 0.5).radius, 200, 1e-6, 'geometric midpoint of the zoom');
  assert.equal(E.sanitizeKey(' ab<c>"d e \n'), 'abcde');
  assert.equal(E.sanitizeKey('x'.repeat(200)).length, 128);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + (err && err.message)); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} argus tests passed`);
if (passed !== tests.length) process.exit(1);
