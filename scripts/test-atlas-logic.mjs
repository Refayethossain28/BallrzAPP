#!/usr/bin/env node
/**
 * Unit tests for atlas/engine.js — the pure navigation engine behind Atlas,
 * the satnav. Geodesy, the polyline codec, Web-Mercator tile maths, route
 * building from OSRM JSON, snapping, the turn-by-turn guidance state machine
 * (bands, off-route hysteresis, arrival), phrasing, formatting, the demo
 * simulator and place ranking. Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-atlas-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'atlas', 'engine.js'), 'utf8'), sandbox, { filename: 'atlas/engine.js' });
const A = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ` (${a} vs ${b} ±${tol})`);
// deepEqual across the vm realm boundary trips on prototypes — compare shape
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

/* ------------------------------- geodesy -------------------------------- */

test('haversine: London→Paris ≈ 344 km; zero for identical points', () => {
  const london = { lat: 51.5074, lon: -0.1278 }, paris = { lat: 48.8566, lon: 2.3522 };
  near(A.haversine(london, paris), 343900, 2500);
  assert.equal(A.haversine(london, london), 0);
});

test('bearing: cardinal directions come out right', () => {
  const o = { lat: 51.5, lon: -0.1 };
  near(A.bearing(o, { lat: 52.5, lon: -0.1 }), 0, 0.1, 'north');
  near(A.bearing(o, { lat: 50.5, lon: -0.1 }), 180, 0.1, 'south');
  near(A.bearing(o, { lat: 51.5, lon: 0.9 }), 90, 0.5, 'east');
});

test('destinationPoint inverts haversine+bearing', () => {
  const o = { lat: 51.5, lon: -0.1 };
  const p = A.destinationPoint(o, 63, 12345);
  near(A.haversine(o, p), 12345, 1);
  near(A.bearing(o, p), 63, 0.1);
});

test('angleDiff: signed smallest difference, wraps correctly', () => {
  assert.equal(A.angleDiff(350, 10), 20);
  assert.equal(A.angleDiff(10, 350), -20);
  assert.equal(A.angleDiff(0, 180), 180);
  assert.equal(A.angleDiff(90, 90), 0);
});

test('compassName: 8-wind rose with wrap', () => {
  assert.equal(A.compassName(0), 'north');
  assert.equal(A.compassName(44), 'north-east');
  assert.equal(A.compassName(89), 'east');
  assert.equal(A.compassName(359), 'north');
  assert.equal(A.compassName(225), 'south-west');
});

/* ---------------------------- polyline codec ---------------------------- */

test('decodePolyline matches the published Google reference vector', () => {
  const pts = A.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(pts.length, 3);
  near(pts[0].lat, 38.5, 1e-9); near(pts[0].lon, -120.2, 1e-9);
  near(pts[1].lat, 40.7, 1e-9); near(pts[1].lon, -120.95, 1e-9);
  near(pts[2].lat, 43.252, 1e-9); near(pts[2].lon, -126.453, 1e-9);
});

test('encodePolyline round-trips (precision 5 and 6)', () => {
  const pts = [{ lat: 51.5074, lon: -0.1278 }, { lat: 51.5033, lon: -0.1196 }, { lat: 51.5007, lon: -0.1246 }];
  for (const prec of [5, 6]) {
    const back = A.decodePolyline(A.encodePolyline(pts, prec), prec);
    for (let i = 0; i < pts.length; i++) {
      near(back[i].lat, pts[i].lat, 1 / 10 ** prec);
      near(back[i].lon, pts[i].lon, 1 / 10 ** prec);
    }
  }
  assert.equal(A.encodePolyline(A.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
});

/* ------------------------------ tile maths ------------------------------ */

test('lonLatToWorld: origin and edges at zoom 0/1', () => {
  const c = A.lonLatToWorld({ lat: 0, lon: 0 }, 0);
  near(c.x, 128, 1e-6); near(c.y, 128, 1e-6);
  near(A.lonLatToWorld({ lat: 0, lon: 180 }, 1).x, 512, 1e-6);
  near(A.lonLatToWorld({ lat: 85.0511287798066, lon: 0 }, 0).y, 0, 1e-6, 'mercator top');
});

test('worldToLonLat inverts lonLatToWorld', () => {
  const p = { lat: 51.5074, lon: -0.1278 };
  for (const z of [3, 10, 17]) {
    const back = A.worldToLonLat(A.lonLatToWorld(p, z), z);
    near(back.lat, p.lat, 1e-9); near(back.lon, p.lon, 1e-9);
  }
});

test('tileForWorld: clamps to the grid and floors correctly', () => {
  same(A.tileForWorld({ x: 300, y: 5 }, 1), { tx: 1, ty: 0 });
  same(A.tileForWorld({ x: -5, y: 99999 }, 1), { tx: 0, ty: 1 });
});

test('metresPerPixel: ~156 km/px at z0 equator, halves per zoom, shrinks with cos(lat)', () => {
  near(A.metresPerPixel(0, 0), 156368, 200);
  near(A.metresPerPixel(0, 1) * 2, A.metresPerPixel(0, 0), 1e-6);
  assert.ok(A.metresPerPixel(60, 10) < A.metresPerPixel(0, 10) * 0.51);
});

/* ------------------------ synthetic OSRM route -------------------------- */
// A 1500 m L: 1000 m due north on Start Road, right turn, 500 m due east on
// End Road. Geometry every 100 m — built with the engine's own geodesy.

function makeRoute() {
  const base = { lat: 51.5, lon: -0.1 };
  const geometry = [];
  for (let m = 0; m <= 1000; m += 100) geometry.push(A.destinationPoint(base, 0, m));
  const corner = geometry[geometry.length - 1];
  for (let m = 100; m <= 500; m += 100) geometry.push(A.destinationPoint(corner, 90, m));
  const end = geometry[geometry.length - 1];
  const osrm = {
    geometry: A.encodePolyline(geometry),
    distance: 1500, duration: 160,
    legs: [{ steps: [
      { name: 'Start Road', distance: 1000, duration: 100,
        maneuver: { location: [base.lon, base.lat], type: 'depart', bearing_after: 0 } },
      { name: 'End Road', ref: 'B100', distance: 500, duration: 60,
        maneuver: { location: [corner.lon, corner.lat], type: 'turn', modifier: 'right' } },
      { name: '', distance: 0, duration: 0,
        maneuver: { location: [end.lon, end.lat], type: 'arrive', modifier: 'right' } },
    ] }],
  };
  return { route: A.buildRoute(osrm), base, corner, end };
}

test('buildRoute: geometry, cumulative distances and located maneuvers', () => {
  const { route } = makeRoute();
  assert.equal(route.geometry.length, 16);
  near(route.totalM, 1500, 2);
  assert.equal(route.steps.length, 3);
  near(route.steps[0].alongM, 0, 1);
  near(route.steps[1].alongM, 1000, 2, 'turn located at the corner');
  near(route.steps[2].alongM, route.totalM, 2, 'arrive at the end');
  assert.equal(route.steps[1].instruction, 'Turn right onto End Road (B100)');
  assert.equal(route.steps[1].icon, 'right');
  assert.equal(route.steps[0].instruction, 'Head north on Start Road');
});

test('buildRoute: GeoJSON geometry and stepless routes still work', () => {
  const r = A.buildRoute({
    geometry: { coordinates: [[-0.1, 51.5], [-0.1, 51.509]] }, duration: 60, legs: [],
  });
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].type, 'depart');
  assert.equal(r.steps[1].type, 'arrive');
  near(r.totalM, 1001, 5);
  assert.throws(() => A.buildRoute({ geometry: { coordinates: [] } }));
});

test('roadName: name + first ref, deduped', () => {
  assert.equal(A.roadName({ name: 'High Street', ref: 'A23;A203' }), 'High Street (A23)');
  assert.equal(A.roadName({ name: 'A23', ref: 'A23' }), 'A23');
  assert.equal(A.roadName({ name: '', ref: 'M25' }), 'M25');
  assert.equal(A.roadName({}), '');
});

/* ------------------------------- snapping ------------------------------- */

test('snapToRoute: on-route point snaps with ~zero cross-track and right alongM', () => {
  const { route, base } = makeRoute();
  const p = A.destinationPoint(base, 0, 450);
  const s = A.snapToRoute(route, p);
  near(s.crossTrack, 0, 1);
  near(s.alongM, 450, 2);
  assert.equal(s.index, 4);
});

test('snapToRoute: off-route point reports honest cross-track', () => {
  const { route, base } = makeRoute();
  const off = A.destinationPoint(A.destinationPoint(base, 0, 500), 90, 80); // 80 m east of the northward leg
  const s = A.snapToRoute(route, off);
  near(s.crossTrack, 80, 2);
  near(s.alongM, 500, 5);
});

test('snapToRoute: hint keeps us on the earlier pass of a route', () => {
  const { route } = makeRoute();
  const p = A.pointAtAlong(route, 300);
  const hinted = A.snapToRoute(route, { lat: p.lat, lon: p.lon }, 2);
  near(hinted.alongM, 300, 2);
});

test('pointAtAlong: interpolates position and heading, clamps at the ends', () => {
  const { route } = makeRoute();
  const mid = A.pointAtAlong(route, 1250);
  near(mid.heading, 90, 1, 'heading east after the turn');
  near(A.pointAtAlong(route, -50).lat, route.geometry[0].lat, 1e-9);
  near(A.pointAtAlong(route, 1e9).lat, route.geometry[15].lat, 1e-9);
});

/* ------------------------------- phrasing ------------------------------- */

test('instructionText: the maneuver vocabulary reads like a human', () => {
  const t = (type, modifier, name, extra) =>
    A.instructionText(Object.assign({ type, modifier, name: name || '', exit: 0, bearingAfter: 0 }, extra));
  assert.equal(t('turn', 'left', 'High Street'), 'Turn left onto High Street');
  assert.equal(t('turn', 'slight right', ''), 'Turn slightly right');
  assert.equal(t('turn', 'uturn', 'A23'), 'Make a U-turn and continue on A23');
  assert.equal(t('roundabout', '', 'A23', { exit: 2 }), 'At the roundabout, take the 2nd exit onto A23');
  assert.equal(t('exit roundabout', '', 'A23'), 'Exit the roundabout onto A23');
  assert.equal(t('merge', 'left', 'M4'), 'Merge left onto M4');
  assert.equal(t('off ramp', 'left', 'A312'), 'Take the exit left onto A312');
  assert.equal(t('end of road', 'right', 'Mill Lane'), 'At the end of the road, turn right onto Mill Lane');
  assert.equal(t('fork', 'slight left', 'A40'), 'Keep slightly left at the fork onto A40');
  assert.equal(t('arrive', 'right', ''), 'You have arrived — your destination is on the right');
  assert.equal(t('new name', 'straight', 'Kings Road'), 'Continue straight on Kings Road');
  assert.equal(t('depart', '', 'Baker Street', { bearingAfter: 92 }), 'Head east on Baker Street');
});

test('maneuverIcon: stable keys for the UI', () => {
  assert.equal(A.maneuverIcon('turn', 'left'), 'left');
  assert.equal(A.maneuverIcon('turn', 'slight right'), 'slight-right');
  assert.equal(A.maneuverIcon('turn', 'sharp left'), 'sharp-left');
  assert.equal(A.maneuverIcon('roundabout', ''), 'roundabout');
  assert.equal(A.maneuverIcon('merge', 'slight left'), 'merge-left');
  assert.equal(A.maneuverIcon('off ramp', 'right'), 'ramp-right');
  assert.equal(A.maneuverIcon('turn', 'uturn'), 'uturn');
  assert.equal(A.maneuverIcon('arrive', ''), 'arrive');
  assert.equal(A.maneuverIcon('continue', ''), 'straight');
});

/* ------------------------------ formatting ------------------------------ */

test('fmtDist: metric and imperial banding', () => {
  assert.equal(A.fmtDist(4, 'metric'), '10 m');
  assert.equal(A.fmtDist(243, 'metric'), '240 m');
  assert.equal(A.fmtDist(1234, 'metric'), '1.2 km');
  assert.equal(A.fmtDist(23456, 'metric'), '23 km');
  assert.equal(A.fmtDist(150, 'imperial'), '160 yd');
  assert.equal(A.fmtDist(1609.344, 'imperial'), '1.0 mi');
  assert.equal(A.fmtDist(20 * 1609.344, 'imperial'), '20 mi');
});

test('speakDist: whole words, quarter-mile poetry', () => {
  assert.equal(A.speakDist(200, 'metric'), '200 metres');
  assert.equal(A.speakDist(1000, 'metric'), '1 kilometre');
  assert.equal(A.speakDist(2340, 'metric'), '2.3 kilometres');
  assert.equal(A.speakDist(402, 'imperial'), 'a quarter of a mile');
  assert.equal(A.speakDist(804, 'imperial'), 'half a mile');
  assert.equal(A.speakDist(100, 'imperial'), '110 yards');
});

test('fmtDur + etaClock: durations and injected-clock arrival time', () => {
  assert.equal(A.fmtDur(45), '45 s');
  assert.equal(A.fmtDur(720), '12 min');
  assert.equal(A.fmtDur(3900), '1 h 05 min');
  const now = Date.UTC(2026, 6, 26, 14, 0, 0);
  const eta = A.etaClock(now, 32 * 60);
  assert.ok(/^\d{2}:\d{2}$/.test(eta), 'HH:MM shaped: ' + eta);
  assert.equal(A.etaClock(now, 32 * 60 + 30).slice(-2), A.etaClock(now, 32 * 60).slice(-2));
});

/* ------------------------------- guidance ------------------------------- */

test('announceBands scale with speed but never shrink below town defaults', () => {
  const town = A.announceBands(8), motorway = A.announceBands(31);
  assert.equal(town.prepare, 700); assert.equal(town.soon, 180);
  near(motorway.prepare, 31 * 35, 1);
  assert.ok(motorway.now > town.now);
});

test('guidance: full drive announces prepare → soon → now → arrive, each once', () => {
  const { route } = makeRoute();
  let st = A.startGuidance();
  const heard = [];
  for (let along = 0; along <= route.totalM + 1; along += 10) {
    const p = A.pointAtAlong(route, Math.min(along, route.totalM));
    const r = A.guidanceUpdate(st, route, { lat: p.lat, lon: p.lon, speed: 10 }, { units: 'metric' });
    st = r.state;
    if (r.announce) heard.push([r.announce.band, r.announce.text]);
    if (r.arrived) break;
  }
  const bands = heard.map((h) => h[0]);
  same(bands, ['prepare', 'soon', 'now', 'prepare', 'soon', 'now'], 'got: ' + JSON.stringify(heard));
  assert.ok(/^In \d+ metres, turn right onto End Road \(B100\)$/.test(heard[0][1]), heard[0][1]);
  assert.equal(heard[2][1], 'Turn right onto End Road (B100)');
  assert.ok(/^In .+, you will arrive at your destination, on the right$/.test(heard[3][1]), heard[3][1]);
  assert.equal(heard[5][1], 'You have arrived — your destination is on the right');
});

test('guidance: fast approach skips straight to "now" without a double-speak', () => {
  const { route } = makeRoute();
  let st = A.startGuidance();
  // one far fix, then jump right on top of the turn
  let p = A.pointAtAlong(route, 100);
  st = A.guidanceUpdate(st, route, { lat: p.lat, lon: p.lon, speed: 10 }).state;
  p = A.pointAtAlong(route, 990);
  const r = A.guidanceUpdate(st, route, { lat: p.lat, lon: p.lon, speed: 10 });
  assert.equal(r.announce.band, 'now');
  const again = A.guidanceUpdate(r.state, route, { lat: p.lat, lon: p.lon, speed: 10 });
  assert.equal(again.announce, null, 'no repeat at the same band');
});

test('guidance: off-route needs 3 consecutive bad fixes (hysteresis), then clears', () => {
  const { route, base } = makeRoute();
  let st = A.startGuidance();
  const off = A.destinationPoint(A.destinationPoint(base, 0, 300), 90, 100);
  let r;
  for (let i = 0; i < 2; i++) { r = A.guidanceUpdate(st, route, { lat: off.lat, lon: off.lon, speed: 5 }); st = r.state; }
  assert.equal(r.offRoute, false, 'two bad fixes are not enough');
  r = A.guidanceUpdate(st, route, { lat: off.lat, lon: off.lon, speed: 5 }); st = r.state;
  assert.equal(r.offRoute, true, 'third bad fix trips it');
  const back = A.pointAtAlong(route, 320);
  r = A.guidanceUpdate(st, route, { lat: back.lat, lon: back.lon, speed: 5 });
  assert.equal(r.offRoute, false, 'one good fix clears the counter');
});

test('guidance: stepIndex never regresses on GPS jitter', () => {
  const { route } = makeRoute();
  let st = A.startGuidance();
  let p = A.pointAtAlong(route, 1050);
  st = A.guidanceUpdate(st, route, { lat: p.lat, lon: p.lon, speed: 10 }).state;
  assert.equal(st.stepIndex, 1, 'past the turn');
  p = A.pointAtAlong(route, 995); // jitter back before the corner
  const r = A.guidanceUpdate(st, route, { lat: p.lat, lon: p.lon, speed: 10 });
  assert.equal(r.stepIndex, 1, 'still on step 1');
});

test('remaining: proportional duration interpolation', () => {
  const { route } = makeRoute();
  near(A.remaining(route, 0).durS, 160, 1);
  near(A.remaining(route, 0).distM, route.totalM, 0.01);
  const half = A.remaining(route, 500);
  near(half.durS, 110, 2, 'half of step 0 (50 s) + step 1 (60 s)');
  near(A.remaining(route, route.totalM).durS, 0, 0.01);
});

test('voiceLine: chains "then" only for hard-on-the-heels maneuvers', () => {
  const stepA = { type: 'turn', modifier: 'left', name: 'A Road', exit: 0, bearingAfter: 0, distM: 90,
    instruction: 'Turn left onto A Road' };
  const stepB = { type: 'turn', modifier: 'right', name: 'B Road', exit: 0, bearingAfter: 0, distM: 500,
    instruction: 'Turn right onto B Road' };
  assert.equal(A.voiceLine(stepA, 'now', 'metric', stepB, 20), 'Turn left onto A Road, then turn right onto B Road');
  const farA = Object.assign({}, stepA, { distM: 800 });
  assert.equal(A.voiceLine(farA, 'now', 'metric', stepB, 20), 'Turn left onto A Road');
  assert.equal(A.voiceLine(stepB, 'soon', 'metric', null, 200), 'In 200 metres, turn right onto B Road');
});

/* ------------------------------ simulator ------------------------------- */

test('simulateTick: deterministic, advances at speed, brakes and arrives', () => {
  const { route } = makeRoute();
  let s = { alongM: 0 }, ticks = 0, lastSpeed = Infinity;
  const a1 = A.simulateTick(route, { alongM: 0 }, 1, 12);
  const a2 = A.simulateTick(route, { alongM: 0 }, 1, 12);
  assert.deepEqual(a1, a2, 'same input, same output');
  near(a1.alongM, 12, 0.01);
  while (ticks++ < 500) {
    const r = A.simulateTick(route, s, 1, 15);
    if (r.alongM > route.totalM - 60) assert.ok(r.speed <= lastSpeed + 1e-9, 'braking near the end');
    lastSpeed = r.speed; s = { alongM: r.alongM };
    if (r.done) break;
  }
  assert.ok(ticks < 500, 'arrives');
  near(s.alongM, route.totalM, 0.01);
});

test('simulator drives the guidance to arrival end-to-end', () => {
  const { route } = makeRoute();
  let sim = { alongM: 0 }, st = A.startGuidance(), heard = [], guard = 0, arrived = false;
  while (guard++ < 1000) {
    const f = A.simulateTick(route, sim, 1, 13);
    sim = { alongM: f.alongM };
    const r = A.guidanceUpdate(st, route, { lat: f.lat, lon: f.lon, speed: f.speed });
    st = r.state;
    if (r.announce) heard.push(r.announce.band);
    if (r.arrived) { arrived = true; break; }
  }
  assert.ok(arrived, 'simulated drive arrives');
  assert.ok(heard.includes('prepare') && heard.includes('soon') && heard.includes('now'), heard.join(','));
});

/* -------------------------------- places -------------------------------- */

test('rankPlaces: pinned home/work lead an empty query; text match dominates', () => {
  const NOW = Date.UTC(2026, 6, 26);
  const places = [
    { name: 'Gym', addr: 'York Way', uses: 9, lastUsed: NOW - 86400000 },
    { name: 'Home', addr: '1 Rose Lane', kind: 'home', uses: 2, lastUsed: NOW - 10 * 86400000 },
    { name: 'Work', addr: 'City Tower', kind: 'work', uses: 2, lastUsed: NOW - 10 * 86400000 },
    { name: 'Yoga studio', addr: 'Mill Road', uses: 1, lastUsed: NOW - 86400000 },
  ];
  const empty = A.rankPlaces(places, '', NOW);
  same([...empty.slice(0, 2).map((p) => p.name)].sort(), ['Home', 'Work']);
  const yo = A.rankPlaces(places, 'yo', NOW);
  assert.equal(yo[0].name, 'Yoga studio', 'prefix beats frequency');
  same(yo.map((p) => p.name), ['Yoga studio', 'Gym'], 'addr match (York Way) included');
  assert.equal(A.rankPlaces(places, 'zzz', NOW).length, 0);
});

test('parseCoord: accepts "lat, lon", rejects junk and out-of-range', () => {
  same(A.parseCoord('51.5074, -0.1278'), { lat: 51.5074, lon: -0.1278 });
  same(A.parseCoord(' 40.7  -74 '), { lat: 40.7, lon: -74 });
  assert.equal(A.parseCoord('91, 0'), null);
  assert.equal(A.parseCoord('0, 181'), null);
  assert.equal(A.parseCoord('High Street'), null);
});

/* --------------------- the features no other satnav has ------------------ */

test('sunPosition: London equinox — south at noon, below horizon at midnight', () => {
  const london = { lat: 51.5074, lon: -0.1278 };
  const noon = A.sunPosition(Date.UTC(2026, 2, 20, 12, 0), london.lat, london.lon);
  near(noon.elevation, 38.5, 3, 'noon elevation ≈ 90 − lat at equinox');
  near(noon.azimuth, 180, 6, 'sun due south at noon');
  const midnight = A.sunPosition(Date.UTC(2026, 2, 20, 0, 0), london.lat, london.lon);
  assert.ok(midnight.elevation < -30, 'deep below horizon at midnight');
  const morning = A.sunPosition(Date.UTC(2026, 2, 20, 7, 0), london.lat, london.lon);
  assert.ok(morning.elevation > -2 && morning.elevation < 15, 'low sun just after sunrise');
  near(morning.azimuth, 97, 10, 'rises roughly due east at equinox');
});

test('timeAtAlong: 0 at the start, totalS at the end, monotonic', () => {
  const { route } = makeRoute();
  near(A.timeAtAlong(route, 0), 0, 0.01);
  near(A.timeAtAlong(route, route.totalM), route.totalS, 0.01);
  assert.ok(A.timeAtAlong(route, 400) < A.timeAtAlong(route, 900));
});

test('glareSegments: driving east into a low morning sun glares; north does not', () => {
  const base = { lat: 51.5, lon: -0.1 };
  const mk = (brg) => {
    const g = [];
    for (let m = 0; m <= 2000; m += 200) g.push(A.destinationPoint(base, brg, m));
    return A.buildRoute({ geometry: { coordinates: g.map((p) => [p.lon, p.lat]) }, duration: 200, legs: [] });
  };
  const dawn = Date.UTC(2026, 2, 20, 7, 0); // low sun ~due east over London
  const east = A.glareSegments(mk(90), dawn);
  assert.ok(east.length >= 1, 'eastbound at dawn glares');
  near(east[0].startM, 0, 1);
  assert.ok(east[0].durS > 0, 'glare stretch has a duration');
  assert.equal(A.glareSegments(mk(0), dawn).length, 0, 'northbound at dawn is clean');
  assert.equal(A.glareSegments(mk(90), Date.UTC(2026, 2, 20, 0, 0)).length, 0, 'no glare at night');
});

test('paceNotes: corners graded rally-style with correct sides', () => {
  const base = { lat: 51.5, lon: -0.1 };
  const g = [];
  let cur = base, brg = 0;
  const leg = (turn, dist) => {
    brg += turn;
    for (let m = 100; m <= dist; m += 100) g.push(A.destinationPoint(cur, brg, m));
    cur = g[g.length - 1];
  };
  g.push(base);
  leg(0, 400); leg(90, 400); leg(-45, 400); leg(15, 400);
  const route = A.buildRoute({ geometry: { coordinates: g.map((p) => [p.lon, p.lat]) }, duration: 100, legs: [] });
  const notes = A.paceNotes(route);
  assert.equal(notes.length, 3, JSON.stringify(notes));
  assert.equal(notes[0].side, 'right'); assert.equal(notes[0].grade, 2, '90° = grade 2');
  assert.equal(notes[1].side, 'left'); assert.equal(notes[1].grade, 4, '45° = grade 4');
  assert.equal(notes[2].side, 'right'); assert.equal(notes[2].grade, 6, '15° = grade 6 kink');
  assert.ok(notes[0].alongM < notes[1].alongM && notes[1].alongM < notes[2].alongM);
});

test('paceNoteLine: chains "into" only when corners crowd together', () => {
  const a = { alongM: 100, side: 'left', grade: 4 };
  const b = { alongM: 180, side: 'right', grade: 3 };
  const c = { alongM: 600, side: 'right', grade: 3 };
  assert.equal(A.paceNoteLine(a, b), 'left 4 into right 3');
  assert.equal(A.paceNoteLine(a, c), 'left 4');
  assert.equal(A.paceNoteLine(b), 'right 3');
});

test('ghostAdvance: dead reckoning rides the route and clamps at the end', () => {
  const { route } = makeRoute();
  const f = A.ghostAdvance(route, 500, 15, 2);
  assert.equal(f.ghost, true);
  near(f.alongM, 530, 0.01);
  near(A.haversine(f, A.pointAtAlong(route, 530)), 0, 0.5, 'on the line');
  near(f.heading, 0, 1, 'still northbound');
  near(A.ghostAdvance(route, route.totalM - 5, 20, 10).alongM, route.totalM, 0.01, 'clamps');
});

test('flight recorder: thinning, stats and a well-formed GPX', () => {
  const T0 = Date.UTC(2026, 6, 26, 9, 0, 0);
  const base = { lat: 51.5, lon: -0.1 };
  const track = A.newTrack(T0);
  for (let s = 0; s <= 100; s++) {
    const p = A.destinationPoint(base, 0, s * 10); // 10 m/s due north
    A.trackAdd(track, { lat: p.lat, lon: p.lon, speed: 10 }, T0 + s * 1000);
  }
  assert.ok(!A.trackAdd(track, track.points[track.points.length - 1], T0 + 101000), 'dupe rejected');
  const st = A.trackStats(track, T0 + 101000);
  near(st.distM, 1000, 5);
  near(st.avgKmh, 36, 2);
  near(st.maxKmh, 36, 1);
  assert.equal(st.stops, 0);
  const gpx = A.trackToGPX(track, 'Test <drive>');
  assert.ok(gpx.startsWith('<?xml'), 'xml prolog');
  assert.ok(gpx.includes('<name>Test &lt;drive&gt;</name>'), 'name escaped');
  assert.equal((gpx.match(/<trkpt /g) || []).length, track.points.length);
  assert.ok(gpx.includes('2026-07-26T09:00:00.000Z'), 'ISO times');
});

test('routeBack: retraces a recorded L-shape in reverse with a synthesised turn', () => {
  const base = { lat: 51.5, lon: -0.1 };
  const pts = [];
  for (let m = 0; m <= 500; m += 50) { const p = A.destinationPoint(base, 0, m); pts.push({ lat: p.lat, lon: p.lon, t: m }); }
  const corner = pts[pts.length - 1];
  for (let m = 50; m <= 400; m += 50) { const p = A.destinationPoint(corner, 90, m); pts.push({ lat: p.lat, lon: p.lon, t: 500 + m }); }
  const route = A.routeBack(pts, 1.4);
  near(route.totalM, 900, 5);
  near(route.totalS, 900 / 1.4, 2);
  near(route.geometry[0].lat, pts[pts.length - 1].lat, 1e-9, 'starts where you are');
  near(route.geometry[route.geometry.length - 1].lat, base.lat, 1e-9, 'ends at the origin');
  const turns = route.steps.filter((s) => s.type === 'turn');
  assert.equal(turns.length, 1, 'one corner → one instruction');
  assert.equal(turns[0].modifier, 'left', 'outbound right turn is a left on the way back');
  assert.throws(() => A.routeBack([{ lat: 51.5, lon: -0.1, t: 0 }], 1.4));
});

test('dashcam: telemetry lines carry time, position, speed and next turn', () => {
  const lines = A.dashcamLines({ timeStr: '2026-07-26 22:13:45', lat: 51.50735, lon: -0.1279,
    speedMS: 13.06, units: 'metric', instruction: 'Turn right onto End Road', distToNextM: 200 });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '2026-07-26 22:13:45  ·  47 km/h');
  assert.equal(lines[1], '51.50735, -0.12790');
  assert.equal(lines[2], 'Next: Turn right onto End Road — 200 m');
  const mph = A.dashcamLines({ timeStr: 't', lat: 0, lon: 0, speedMS: 13.06, units: 'imperial' });
  assert.equal(mph.length, 2, 'no instruction → two lines');
  assert.ok(mph[0].endsWith('29 mph'), mph[0]);
});

test('dashcam: fmtTimestamp shape and dashcamFilename slugging (UTC)', () => {
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(A.fmtTimestamp(Date.UTC(2026, 6, 26, 22, 13, 45))));
  const ms = Date.UTC(2026, 6, 26, 22, 13, 45);
  assert.equal(A.dashcamFilename(ms, 'Trafalgar Square, London!'), 'atlas-dashcam-20260726-2213-trafalgar-square-london.webm');
  assert.equal(A.dashcamFilename(ms, ''), 'atlas-dashcam-20260726-2213.webm');
  assert.equal(A.dashcamFilename(ms, '§§§'), 'atlas-dashcam-20260726-2213.webm');
});

test('dashcam: recordingEstimateMB is honest arithmetic', () => {
  near(A.recordingEstimateMB(60), 18.8, 0.05, '1 min at 2.5 Mbps');
  near(A.recordingEstimateMB(600, 1000), 75, 0.1);
  assert.equal(A.recordingEstimateMB(-5), 0);
});

test('dashcam vault: fmtBytes banding', () => {
  assert.equal(A.fmtBytes(0), '0 B');
  assert.equal(A.fmtBytes(500), '500 B');
  assert.equal(A.fmtBytes(254625), '255 KB');
  assert.equal(A.fmtBytes(1.23e6), '1.2 MB');
  assert.equal(A.fmtBytes(2.5e9), '2.5 GB');
});

test('dashcam vault: pruneClips keeps newest, enforces count and byte caps', () => {
  const mk = (n, size) => Array.from({ length: n }, (_, i) => ({ id: i + 1, t: 1000 + i, size: size || 10 }));
  same(A.pruneClips([], {}), []);
  // count cap: 15 clips, keep the 12 newest (t high = new) → drop ids 1..3
  same([...A.pruneClips(mk(15), { maxCount: 12, maxBytes: 1e9 })].sort((a, b) => a - b), [1, 2, 3]);
  // byte cap: 5 × 100 B with a 250 B budget → keep the 2 newest, drop 3 oldest
  same([...A.pruneClips(mk(5, 100), { maxCount: 99, maxBytes: 250 })].sort((a, b) => a - b), [1, 2, 3]);
  // a single oversized newest clip is never dropped
  same(A.pruneClips([{ id: 7, t: 5, size: 999 }], { maxCount: 3, maxBytes: 100 }), []);
  // ...but an oversized newest still evicts everything older
  same([...A.pruneClips([{ id: 1, t: 1, size: 10 }, { id: 2, t: 9, size: 999 }], { maxCount: 5, maxBytes: 100 })], [1]);
});

test('parseMaxspeed: OSM limit vocabulary → km/h', () => {
  near(A.parseMaxspeed('30 mph'), 48.3, 0.05);
  assert.equal(A.parseMaxspeed('50'), 50);
  assert.equal(A.parseMaxspeed('50 km/h'), 50);
  assert.equal(A.parseMaxspeed('walk'), 10);
  assert.equal(A.parseMaxspeed('none'), null);
  assert.equal(A.parseMaxspeed('signals'), null);
  assert.equal(A.parseMaxspeed('GB:urban'), null);
  assert.equal(A.parseMaxspeed(''), null);
  assert.equal(A.parseMaxspeed(null), null);
});

test('mapLimitsToRoute: parallel nearby ways map on; far or crossing ways do not', () => {
  const { route, base } = makeRoute(); // 1000 m north then 500 m east
  const northWay = (offM, fromM, toM, kmh) => {
    const g = [];
    for (let m = fromM; m <= toM; m += 100) {
      g.push(A.destinationPoint(A.destinationPoint(base, 0, m), 90, offM));
    }
    return { kmh, geometry: g };
  };
  const ways = [
    northWay(5, 0, 500, 48.3),          // 30 mph beside the first half
    northWay(4, 500, 1000, 32.2),       // 20 mph beside the second half
    northWay(200, 0, 1000, 100),        // a parallel road 200 m away — ignored
    { kmh: 60, geometry: [A.destinationPoint(A.destinationPoint(base, 0, 300), 90, -50),
                          A.destinationPoint(A.destinationPoint(base, 0, 300), 90, 50)] }, // crossing road — ignored
  ];
  const segs = A.mapLimitsToRoute(route, ways);
  assert.equal(segs.length, 2, JSON.stringify(segs));
  assert.equal(segs[0].kmh, 48.3); near(segs[0].startM, 0, 1); near(segs[0].endM, 500, 60);
  assert.equal(segs[1].kmh, 32.2); near(segs[1].endM, 1000, 60);
  assert.equal(A.limitAtAlong(segs, 200), 48.3);
  assert.equal(A.limitAtAlong(segs, 700), 32.2);
  assert.equal(A.limitAtAlong(segs, 1400), null, 'the eastward leg has no mapped limit');
});

test('mapCamerasToRoute + cameraNext: verge cameras snap on, far ones do not', () => {
  const { route, base } = makeRoute();
  const at = (m, offM) => A.destinationPoint(A.destinationPoint(base, 0, m), 90, offM);
  const cams = [
    { ...at(600, 10), kmh: 32.2 },
    { ...at(605, 12) },              // 5 m later — deduped
    { ...at(300, 200) },             // 200 m off the road — ignored
  ];
  const mapped = A.mapCamerasToRoute(route, cams);
  assert.equal(mapped.length, 1, JSON.stringify(mapped));
  near(mapped[0].alongM, 600, 5);
  assert.equal(mapped[0].kmh, 32.2);
  const next = A.cameraNext(mapped, 100);
  near(next.distM, 500, 5);
  assert.equal(A.cameraNext(mapped, 700), null, 'camera behind you is silent');
});

test('overspeedUpdate: tolerance, 3 s hysteresis, single warning, resets under limit', () => {
  let st = null, r;
  r = A.overspeedUpdate(st, 33, 32.2, 1);          // 1 km/h over: visually over, no warning
  assert.equal(r.over, true); assert.equal(r.warn, false); st = r.state;
  r = A.overspeedUpdate(null, 45, 32.2, 1); st = r.state;   // well over: clock starts
  assert.equal(r.warn, false, '1 s over is not enough');
  r = A.overspeedUpdate(st, 45, 32.2, 1); st = r.state;
  r = A.overspeedUpdate(st, 45, 32.2, 1); st = r.state;
  assert.equal(r.warn, true, 'warns after 3 s over');
  r = A.overspeedUpdate(st, 45, 32.2, 1); st = r.state;
  assert.equal(r.warn, false, 'warns once');
  r = A.overspeedUpdate(st, 20, 32.2, 1); st = r.state;
  assert.equal(r.over, false, 'back under');
  r = A.overspeedUpdate(st, 45, 32.2, 3);
  assert.equal(r.warn, true, 're-arms after dropping under the limit');
  assert.equal(A.overspeedUpdate(r.state, 45, 32.2, 1).warn, false, 'still warns once per episode');
  assert.equal(A.overspeedUpdate(null, 200, null, 1).over, false, 'no limit, no judgement');
});

test('pro: unlock codes generate, verify offline, and reject tampering', () => {
  let seed = 99;
  const lcg = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const code = A.makeProCode(lcg);
  assert.ok(/^ATLS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}$/.test(code), code);
  assert.equal(A.validProCode(code), true);
  assert.equal(A.validProCode(code.toLowerCase().replace(/-/g, ' ')), true, 'normalises case/spacing');
  // flip one body character → checksum fails
  const bad = code.slice(0, 5) + (code[5] === 'A' ? 'B' : 'A') + code.slice(6);
  assert.equal(A.validProCode(bad), false, 'tampered code rejected');
  assert.equal(A.validProCode('ATLS-AAAA-AAAA-ZZ'), false);
  assert.equal(A.validProCode('hello'), false);
  assert.equal(A.validProCode(null), false);
  // codes are distinct across draws
  const codes = new Set();
  for (let i = 0; i < 50; i++) codes.add(A.makeProCode(lcg));
  assert.equal(codes.size, 50);
  // entitlement table
  assert.equal(A.entitlements(false).clips, 12);
  assert.equal(A.entitlements(true).clips, 30);
  assert.ok(A.entitlements(true).offlinePacks > A.entitlements(false).offlinePacks);
});

test('drive history: lifetime + this-week stats from the log', () => {
  const NOW = Date.UTC(2026, 7, 8);
  const day = 86400000;
  const drives = [
    { t: NOW - 2 * day, distM: 10000, movingS: 1000 },  // this week
    { t: NOW - 5 * day, distM: 5000, movingS: 600 },    // this week
    { t: NOW - 30 * day, distM: 42000, movingS: 3600 }, // long ago, longest
    { t: NOW - 40 * day, distM: 0, movingS: 0 },
    null,
  ];
  const s = A.driveStatsSummary(drives, NOW);
  assert.equal(s.count, 4);
  assert.equal(s.distM, 57000);
  assert.equal(s.weekCount, 2);
  assert.equal(s.weekDistM, 15000);
  assert.equal(s.longestM, 42000);
  near(s.avgKmh, 57000 / 5200 * 3.6, 0.1);
  assert.equal(A.driveStatsSummary([], NOW).count, 0);
});

test('music: parseID3 reads v2.3 tags in latin1, UTF-8 and UTF-16', () => {
  // hand-build an ID3v2.3 tag: header + TIT2 (utf8) + TPE1 (latin1) + TALB (utf16le BOM)
  const frames = [];
  const frame = (id, encByte, textBytes) => {
    const body = [encByte, ...textBytes];
    const sz = body.length;
    return [...[...id].map((c) => c.charCodeAt(0)),
      (sz >>> 24) & 0xff, (sz >>> 16) & 0xff, (sz >>> 8) & 0xff, sz & 0xff, 0, 0, ...body];
  };
  const utf8 = (s) => [...Buffer.from(s, 'utf8')];
  const latin1 = (s) => [...Buffer.from(s, 'latin1')];
  const utf16 = (s) => [0xff, 0xfe, ...Buffer.from(s, 'utf16le')];
  frames.push(...frame('TIT2', 3, utf8('Naïve Song 🎵')));
  frames.push(...frame('TPE1', 0, latin1('Café Band')));
  frames.push(...frame('TALB', 1, utf16('Road Trip')));
  const size = frames.length;
  const tag = new Uint8Array([
    0x49, 0x44, 0x33, 3, 0, 0,
    (size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f,
    ...frames, 0xff, 0xfb, 0x90, 0x00, // a fake mp3 frame after the tag
  ]);
  const meta = A.parseID3(tag);
  assert.equal(meta.title, 'Naïve Song 🎵');
  assert.equal(meta.artist, 'Café Band');
  assert.equal(meta.album, 'Road Trip');
  assert.equal(A.parseID3(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), null, 'no tag → null');
  assert.equal(A.parseID3(null), null);
});

test('music: deterministic shuffle + queue advance with repeat modes', () => {
  let seed = 7;
  const lcg = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const order = A.makeShuffleOrder(8, lcg);
  assert.equal(order.length, 8);
  same([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7], 'a real permutation');
  seed = 7;
  same(A.makeShuffleOrder(8, lcg), order, 'same seed, same order');
  // ordered queue
  assert.equal(A.nextTrack({ idx: 0, count: 3, repeat: 'off', shuffle: null, dir: 1 }), 1);
  assert.equal(A.nextTrack({ idx: 2, count: 3, repeat: 'off', shuffle: null, dir: 1 }), null, 'end stops');
  assert.equal(A.nextTrack({ idx: 2, count: 3, repeat: 'all', shuffle: null, dir: 1 }), 0, 'repeat wraps');
  assert.equal(A.nextTrack({ idx: 0, count: 3, repeat: 'off', shuffle: null, dir: -1 }), 2, 'prev wraps back');
  assert.equal(A.nextTrack({ idx: 1, count: 3, repeat: 'one', shuffle: null, dir: 1, ended: true }), 1, 'repeat-one loops the track');
  assert.equal(A.nextTrack({ idx: 1, count: 3, repeat: 'one', shuffle: null, dir: 1, ended: false }), 2, 'manual skip beats repeat-one');
  // shuffled queue follows the order array
  const sh = [2, 0, 1];
  assert.equal(A.nextTrack({ idx: 2, count: 3, repeat: 'off', shuffle: sh, dir: 1 }), 0);
  assert.equal(A.nextTrack({ idx: 1, count: 3, repeat: 'all', shuffle: sh, dir: 1 }), 2, 'wraps to the shuffle head');
  assert.equal(A.nextTrack({ idx: 0, count: 0 }), null);
  assert.equal(A.fmtTrackTime(225), '3:45');
  assert.equal(A.fmtTrackTime(3723), '1:02:03');
  assert.equal(A.fmtTrackTime(0), '0:00');
});

test('offline packs: corridorTiles covers the route per zoom, deduped and capped', () => {
  const { route } = makeRoute(); // 1.5 km L-shape
  const plan = A.corridorTiles(route, { minZ: 12, maxZ: 17, bufferM: 260, cap: 1200 });
  assert.ok(plan.tiles.length > 20 && plan.tiles.length <= 1200, 'plausible count: ' + plan.tiles.length);
  assert.equal(plan.truncated, false);
  const zooms = new Set(plan.tiles.map((t) => t.z));
  for (let z = 12; z <= 17; z++) assert.ok(zooms.has(z), 'zoom ' + z + ' present');
  const keys = plan.tiles.map((t) => t.z + '/' + t.x + '/' + t.y);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate tiles');
  // high zoom needs more tiles than low zoom for the same corridor
  const at17 = plan.tiles.filter((t) => t.z === 17).length;
  const at12 = plan.tiles.filter((t) => t.z === 12).length;
  assert.ok(at17 > at12, `z17 ${at17} > z12 ${at12}`);
  // cap honours the flag and keeps the highest zooms (nav needs them most)
  const small = A.corridorTiles(route, { minZ: 12, maxZ: 17, cap: 15 });
  assert.equal(small.truncated, true);
  assert.equal(small.tiles.length, 15);
  assert.ok(small.tiles.every((t) => t.z === 17), 'cap fills highest zoom first');
  assert.equal(A.packEstimateMB(100, 2, 30), 6);
  assert.equal(A.packEstimateMB(0), 0);
});

test('lane guidance: parseLanes reads OSRM lane data, valid lanes light up', () => {
  const raw = { intersections: [{ lanes: [
    { indications: ['left'], valid: false },
    { indications: ['straight', 'left'], valid: true, valid_indication: 'straight' },
    { indications: [], valid: false },
  ] }] };
  const lanes = A.parseLanes(raw);
  assert.equal(lanes.length, 3);
  assert.equal(lanes[0].icon, 'left'); assert.equal(lanes[0].on, false);
  assert.equal(lanes[1].icon, 'straight'); assert.equal(lanes[1].on, true, 'valid lane lit');
  assert.equal(lanes[2].icon, 'straight', 'no indication → straight');
  assert.equal(A.parseLanes({ intersections: [{}] }), null, 'no lane data → null');
  assert.equal(A.parseLanes({}), null);
  assert.equal(A.laneIconKey('slight right'), 'slight-right');
  assert.equal(A.laneIconKey('uturn'), 'uturn');
  assert.equal(A.laneIconKey('weird'), 'straight');
});

test('lane guidance: buildRoute attaches lanes to steps', () => {
  const base = { lat: 51.5, lon: -0.1 };
  const g = [base, A.destinationPoint(base, 0, 500), A.destinationPoint(base, 0, 1000)];
  const r = A.buildRoute({
    geometry: A.encodePolyline(g), duration: 100,
    legs: [{ steps: [
      { name: 'A', distance: 500, duration: 50, maneuver: { location: [base.lon, base.lat], type: 'depart', bearing_after: 0 } },
      { name: 'B', distance: 500, duration: 50,
        maneuver: { location: [g[1].lon, g[1].lat], type: 'turn', modifier: 'right' },
        intersections: [{ lanes: [{ indications: ['right'], valid: true }, { indications: ['left'], valid: false }] }] },
      { name: '', distance: 0, duration: 0, maneuver: { location: [g[2].lon, g[2].lat], type: 'arrive' } },
    ] }],
  });
  assert.equal(r.steps[0].lanes, null);
  assert.equal(r.steps[1].lanes.length, 2);
  assert.equal(r.steps[1].lanes[0].on, true);
});

test('junction views: candidates picked, scene projected approach-up', () => {
  const { route } = makeRoute(); // north 1000 m, then right turn east
  // synthesize a sharp turn step to check candidate filtering
  const cands = A.junctionCandidates([
    { type: 'depart', modifier: '' }, { type: 'roundabout', modifier: '' },
    { type: 'turn', modifier: 'sharp left' }, { type: 'turn', modifier: 'left' },
    { type: 'fork', modifier: 'slight right' }, { type: 'arrive', modifier: '' },
  ]);
  same(cands, [1, 2, 4]);
  // the real turn at 1000 m: approach is northbound, so "up" is north
  const turn = route.steps[1];
  const base = { lat: 51.5, lon: -0.1 };
  const crossroad = []; // an east–west road through the junction
  for (let m = -100; m <= 100; m += 20) crossroad.push(A.destinationPoint(A.destinationPoint(base, 0, 1000), 90, m));
  const scene = A.buildJunctionView(route, turn, [crossroad], 120);
  assert.ok(scene.roads.length >= 1, 'crossroad survives clipping');
  // crossroad runs east–west through origin → its points sit near y≈0, x spans ±
  const road = scene.roads[0];
  const xs = road.map((p) => p.x), ys = road.map((p) => p.y);
  assert.ok(Math.max(...xs) > 60 && Math.min(...xs) < -60, 'spans east–west');
  assert.ok(Math.max(...ys.map(Math.abs)) < 10, 'flat across the junction');
  // the route path enters from the bottom (+y = behind us) and exits right (+x = east)
  assert.ok(scene.path.length > 5);
  assert.ok(scene.path[0].y > 60, 'approach comes up from the bottom');
  const last = scene.path[scene.path.length - 1];
  assert.ok(last.x > 60 && Math.abs(last.y) < 25, 'exit heads out to the right');
});

test('3D buildings: height parsing, perspective factor, wall shading', () => {
  assert.equal(A.buildingHeightM({ height: '25' }), 25);
  assert.equal(A.buildingHeightM({ height: '25 m' }), 25);
  assert.equal(A.buildingHeightM({ 'building:levels': '4' }), 12);
  assert.equal(A.buildingHeightM({}), 8, 'modest default');
  assert.equal(A.buildingHeightM({ height: '9999' }), 150, 'clamped');
  assert.equal(A.buildingHeightM({ height: 'tall' }), 8, 'junk → default');
  // taller buildings lean more; zooming out flattens; always bounded
  const lat = 51.5;
  assert.ok(A.roofFactor(60, lat, 17) > A.roofFactor(10, lat, 17));
  assert.ok(A.roofFactor(30, lat, 17) > A.roofFactor(30, lat, 15), 'zoom in → more lean');
  assert.ok(A.roofFactor(150, lat, 19) <= 0.4, 'clamped');
  assert.ok(A.roofFactor(3, lat, 12) >= 0);
  // NW light: a north-facing wall (edge running west→east seen from south,
  // i.e. outward normal up-screen) is brighter than a south-facing one
  const northFace = A.wallShade(0, 0, 10, 0);   // normal (0,-1): toward light
  const southFace = A.wallShade(10, 0, 0, 0);   // normal (0, 1): away
  assert.ok(northFace > southFace);
  for (const s of [northFace, southFace]) assert.ok(s >= 0 && s <= 1);
});

test('typicalTrafficFactor: peaks, nights and weekends behave like real roads', () => {
  const tue = 2, sat = 6;
  const amPeak = A.typicalTrafficFactor(8.5, tue), pmPeak = A.typicalTrafficFactor(17.5, tue);
  const shoulder = A.typicalTrafficFactor(11, tue), night = A.typicalTrafficFactor(3, tue);
  assert.ok(pmPeak > amPeak, 'evening peak is the worst');
  assert.ok(amPeak > shoulder && shoulder > night, 'peak > midday > night');
  near(night, 0.92, 0.001);
  for (let h = 0; h < 24; h++) for (const d of [0, 2, 6]) {
    const f = A.typicalTrafficFactor(h, d);
    assert.ok(f >= 0.9 && f <= 1.4, `bounded: h${h} d${d} = ${f}`);
  }
  assert.ok(A.typicalTrafficFactor(13, sat) > A.typicalTrafficFactor(13, 0) - 0.001, 'weekend midday bump');
  assert.equal(A.typicalTrafficFactor(8.5, sat) < amPeak, true, 'no weekday rush on Saturday');
});

test('incidentDelayS: provider delay wins, severity defaults otherwise', () => {
  assert.equal(A.incidentDelayS(4, 120), 120);
  assert.equal(A.incidentDelayS(1), 30);
  assert.equal(A.incidentDelayS(4), 480);
  assert.equal(A.incidentDelayS(9), 90, 'unknown severity → moderate default');
  assert.equal(A.incidentDelayS(2, 999999), 3600, 'capped at an hour');
});

test('mapIncidentsToRoute: snaps points and lines, ignores far, dedupes', () => {
  const { route, base } = makeRoute();
  const at = (m, off) => A.destinationPoint(A.destinationPoint(base, 0, m), 90, off || 0);
  const incidents = [
    { points: [at(400, 10)], sev: 3, kind: 'Roadworks', text: 'Lane closed' },
    { points: [at(430, 12)], sev: 3, kind: 'Roadworks', text: 'dupe nearby' },
    { points: [at(200, 500)], sev: 4, kind: 'Accident', text: 'far away — ignored' },
    { points: [at(800, 400), at(820, 8), at(840, 400)], sev: 2, kind: 'Congestion', text: 'one point on route' },
  ];
  const mapped = A.mapIncidentsToRoute(route, incidents);
  assert.equal(mapped.length, 2, JSON.stringify(mapped));
  near(mapped[0].alongM, 400, 5);
  assert.equal(mapped[0].delayS, 240);
  near(mapped[1].alongM, 820, 5);
  assert.equal(mapped[1].kind, 'Congestion');
});

test('average zones: camera chaining, relation endpoints, overlap merge', () => {
  const cams = [
    { alongM: 100, kmh: 80.5, avg: true },
    { alongM: 2100, kmh: null, avg: true },
    { alongM: 4100, kmh: null, avg: true },
    { alongM: 4200, kmh: null, avg: false },   // ordinary camera — not chained
    { alongM: 20000, kmh: null, avg: true },   // 16 km gap — too far to pair
  ];
  const zones = A.pairAvgCameras(cams, null);
  assert.equal(zones.length, 1, 'chained pairs merge into one continuous zone: ' + JSON.stringify(zones));
  assert.equal(zones[0].startM, 100);
  assert.equal(zones[0].endM, 4100);
  assert.equal(zones[0].kmh, 80.5, 'limit from the tagged camera');
  // limits fallback when no camera carries a limit
  const z2 = A.pairAvgCameras([{ alongM: 0, avg: true, kmh: null }, { alongM: 1000, avg: true, kmh: null }],
    [{ startM: 0, endM: 1200, kmh: 48.3 }]);
  assert.equal(z2[0].kmh, 48.3);
  // relation endpoints snap onto the route
  const { route, base } = makeRoute();
  const at = (m, off) => A.destinationPoint(A.destinationPoint(base, 0, m), 90, off || 0);
  const rel = A.zoneFromEndpoints(route, at(200, 5), at(800, 8), 32.2);
  near(rel.startM, 200, 5); near(rel.endM, 800, 5); assert.equal(rel.kmh, 32.2);
  assert.equal(A.zoneFromEndpoints(route, at(200, 500), at(800, 5), 32.2), null, 'off-route endpoint rejected');
});

test('average zones: enter → live average → over-warn once → exit with final avg', () => {
  const zones = [{ startM: 1000, endM: 3000, kmh: 50 }];
  const T0 = 1000000;
  let st = null, r;
  r = A.avgZoneUpdate(st, zones, 500, T0);
  assert.equal(r.event, null); st = r.state;
  r = A.avgZoneUpdate(st, zones, 1005, T0); st = r.state;
  assert.equal(r.event, 'enter'); assert.equal(r.zone.kmh, 50);
  // 1005→1505 in 30 s = 60 km/h — over a 50 limit
  r = A.avgZoneUpdate(st, zones, 1505, T0 + 30000); st = r.state;
  near(r.avgKmh, 60, 0.5);
  assert.equal(r.event, 'over', 'average over the limit warns');
  r = A.avgZoneUpdate(st, zones, 1705, T0 + 42000); st = r.state;
  assert.equal(r.event, null, 'warns once');
  // slow right down: by 90 s total we are at 2255 m → avg exactly 50 → re-armed
  r = A.avgZoneUpdate(st, zones, 2255, T0 + 90000); st = r.state;
  near(r.avgKmh, 50, 0.1);
  assert.equal(r.event, null);
  // speed up again → warns a second time (re-armed)
  r = A.avgZoneUpdate(st, zones, 2955, T0 + 120000); st = r.state;
  assert.equal(r.event, 'over', 're-armed after dropping under');
  // exit past the end
  r = A.avgZoneUpdate(st, zones, 3100, T0 + 130000); st = r.state;
  assert.equal(r.event, 'exit');
  near(r.avgKmh, (3000 - 1005) / 130 * 3.6, 1, 'final average uses the zone end');
  assert.equal(st.idx, -1);
});

test('trafficAdjust + remainingWithTraffic + nextIncident: the arithmetic', () => {
  const { route } = makeRoute(); // totalS 160
  const mapped = [{ alongM: 400, sev: 3, kind: 'Roadworks', text: '', delayS: 240 },
                  { alongM: 1200, sev: 2, kind: 'Congestion', text: '', delayS: 90 }];
  const adj = A.trafficAdjust(route, mapped, 1.25);
  near(adj.durS, 160 * 1.25 + 330, 0.5);
  assert.equal(adj.delayS, 330);
  const remAt800 = A.remainingWithTraffic(route, 800, mapped, 1.25);
  const baseRem = A.remaining(route, 800).durS * 1.25;
  near(remAt800, baseRem + 90, 0.5, 'only the incident still ahead counts');
  const nxt = A.nextIncident(mapped, 500);
  assert.equal(nxt.inc.kind, 'Congestion');
  near(nxt.distM, 700, 0.5);
  assert.equal(A.nextIncident(mapped, 1300), null);
  near(A.trafficAdjust(route, [], 1).durS, 160, 0.01, 'no traffic, no change');
});

test('convoy codes: deterministic generation, normalisation, link parsing', () => {
  let seed = 42;
  const lcg = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const code = A.makeConvoyCode(lcg);
  assert.equal(code.length, 6);
  assert.equal(A.validConvoyCode(code), code, 'generated codes are valid');
  seed = 42;
  assert.equal(A.makeConvoyCode(lcg), code, 'same seed, same code');
  assert.equal(A.validConvoyCode(' k7m2qd '), 'K7M2QD', 'normalises case and space');
  assert.equal(A.validConvoyCode('K7M2Q'), null, 'wrong length');
  assert.equal(A.validConvoyCode('K7M2QO'), null, 'O is not in the alphabet');
  assert.equal(A.parseConvoyLink('https://apexvip.uk/atlas/#convoy=K7M2QD'), 'K7M2QD');
  assert.equal(A.parseConvoyLink('#convoy=k7m2qd'), 'K7M2QD');
  assert.equal(A.parseConvoyLink('K7M2QD'), 'K7M2QD', 'raw code accepted');
  assert.equal(A.parseConvoyLink('hello world'), null);
});

test('convoyAvatar: deterministic car + colour per id', () => {
  const a = A.convoyAvatar('driver-1'), b = A.convoyAvatar('driver-1'), c = A.convoyAvatar('driver-2');
  assert.equal(a.emoji, b.emoji); assert.equal(a.color, b.color);
  assert.ok(typeof a.emoji === 'string' && a.emoji.length > 0);
  assert.ok(/^#[0-9a-f]{6}$/i.test(a.color));
  assert.ok(a.emoji !== c.emoji || a.color !== c.color, 'different ids differ somewhere');
});

test('applyBeacon: validates, ignores self and stale, newest wins, clamps name', () => {
  const NOW = 1000000;
  let m = {};
  m = A.applyBeacon(m, { id: 'a', name: 'Aisha', lat: 51.5, lon: -0.1, ts: NOW - 1000 }, 'me', NOW);
  assert.equal(Object.keys(m).length, 1);
  assert.equal(m.a.name, 'Aisha');
  assert.equal(A.applyBeacon(m, { id: 'me', lat: 51.5, lon: -0.1 }, 'me', NOW), m, 'own echo ignored');
  assert.equal(A.applyBeacon(m, { id: 'b', lat: 99, lon: 0 }, 'me', NOW), m, 'bad latitude rejected');
  assert.equal(A.applyBeacon(m, null, 'me', NOW), m);
  const stale = A.applyBeacon(m, { id: 'a', name: 'Old', lat: 51, lon: -0.1, ts: NOW - 60000 }, 'me', NOW);
  assert.equal(stale.a.name, 'Aisha', 'older beacon never overwrites');
  const upd = A.applyBeacon(m, { id: 'a', name: '  ' + 'x'.repeat(60), lat: 51.6, lon: -0.2, ts: NOW }, 'me', NOW);
  assert.equal(upd.a.lat, 51.6, 'newer beacon wins');
  assert.equal(upd.a.name.length, 24, 'name clamped');
  assert.ok(upd !== m && m.a.lat === 51.5, 'input map untouched');
  const future = A.applyBeacon({}, { id: 'c', lat: 0, lon: 0, ts: NOW + 999999 }, 'me', NOW);
  assert.ok(future.c.ts <= NOW + 60000, 'future clocks pulled back');
});

test('pruneMembers + convoyStats: silence drops you; nearest-first formation', () => {
  const NOW = 5000000;
  const base = { lat: 51.5, lon: -0.1 };
  const at = (m) => A.destinationPoint(base, 0, m);
  let members = {};
  members = A.applyBeacon(members, { id: 'near', name: 'Near', ...at(100), ts: NOW - 2000 }, 'me', NOW);
  members = A.applyBeacon(members, { id: 'far', name: 'Far', ...at(900), ts: NOW - 2000 }, 'me', NOW);
  members = A.applyBeacon(members, { id: 'gone', name: 'Gone', ...at(50), ts: NOW - 60000 }, 'me', NOW - 50000);
  const alive = A.pruneMembers(members, NOW);
  assert.equal(Object.keys(alive).length, 2, 'silent member pruned');
  const stats = A.convoyStats(alive, base, NOW);
  assert.equal(stats[0].member.id, 'near');
  assert.equal(stats[1].member.id, 'far');
  near(stats[0].distM, 100, 2);
  near(A.angleDiff(stats[1].brgDeg, 0), 0, 1, 'due north of me');
  near(stats[0].staleS, 2, 0.01);
  const noSelf = A.convoyStats(alive, null, NOW);
  assert.equal(noSelf.length, 2);
  assert.equal(noSelf[0].distM, null);
});

test('updatePace: learns your speed honestly and stays clamped', () => {
  assert.equal(A.updatePace(1, 30, 600), 1, 'too short to learn from');
  const slower = A.updatePace(1, 600, 900);
  assert.ok(slower > 1.1 && slower < 1.2, 'drifts toward 1.5 gently: ' + slower);
  let p = 1;
  for (let i = 0; i < 50; i++) p = A.updatePace(p, 600, 6000);
  assert.equal(p, 1.6, 'upper clamp');
  for (let i = 0; i < 50; i++) p = A.updatePace(p, 6000, 600);
  assert.equal(p, 0.6, 'lower clamp');
});

/* --------------------------------- run ---------------------------------- */

test('EV: range maths and a charge stop before the reserve runs dry', () => {
  // 60 kWh at 80% and 160 Wh/km → 270 km usable (after the 10% haircut)
  near(A.evUsableRangeM({ batteryKWh: 60, socPct: 80, whPerKm: 160 }), 270000, 1000);
  assert.equal(A.evUsableRangeM({ batteryKWh: 0, socPct: 80 }), null);
  // a straight 100 km route; range 60 km → needs a stop
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push({ lat: 51 + i * 0.009, lon: 0 }); // ~1 km apart
  const route = { geometry: pts, cum: pts.map((_, i) => i * 1000.4), totalM: 100040, totalS: 4000, steps: [] };
  route.cum = [0]; for (let i = 1; i < pts.length; i++) route.cum.push(route.cum[i-1] + A.haversine(pts[i-1], pts[i]));
  route.totalM = route.cum[route.cum.length - 1];
  const chargers = [
    { lat: 51 + 30 * 0.009, lon: 0.001, tags: { name: 'GridServe 30' } },  // ~30 km in
    { lat: 51 + 45 * 0.009, lon: 0.001, tags: { name: 'GridServe 45' } },  // ~45 km in
    { lat: 51 + 80 * 0.009, lon: 0.001, tags: { name: 'Too Far 80' } },    // beyond reach
  ];
  const plan = A.evChargePlan(route, 60000, chargers);
  assert.equal(plan.needed, true);
  assert.equal(plan.stop.charger.tags.name, 'GridServe 45'); // furthest reachable
  assert.ok(plan.remainingAfterM > 50000);
  // short hop: no stop
  assert.equal(A.evChargePlan({ totalM: 20000, geometry: pts.slice(0, 3), cum: [0, 1000, 2000] }, 60000, chargers).needed, false);
  // no reachable charger → honest null stop
  assert.equal(A.evChargePlan(route, 60000, [chargers[2]]).stop, null);
});

test('clearance: low bridge on-route flags a van, car passes, formats parse', () => {
  assert.equal(A.parseMetres('3.5'), 3.5);
  assert.equal(A.parseMetres('3.5 m'), 3.5);
  near(A.parseMetres(`11'6"`), 3.51, 0.02);
  assert.equal(A.parseMetres('default'), null);
  const pts = []; for (let i = 0; i <= 20; i++) pts.push({ lat: 51 + i * 0.001, lon: 0 });
  const route = { geometry: pts, cum: [0], steps: [] };
  for (let i = 1; i < pts.length; i++) route.cum.push(route.cum[i-1] + A.haversine(pts[i-1], pts[i]));
  route.totalM = route.cum[route.cum.length - 1];
  const bridge = { tags: { maxheight: '3.4', name: 'Old Rail Bridge' },
                   geometry: [{ lat: 51.01, lon: 0 }, { lat: 51.011, lon: 0 }] };
  const farBridge = { tags: { maxheight: '3.0' }, geometry: [{ lat: 51.01, lon: 0.05 }] }; // off-route
  const tall = A.vehicleHazards(route, [bridge, farBridge], { heightM: 3.6 });
  assert.equal(tall.length, 1);
  assert.equal(tall[0].kind, 'height');
  assert.equal(tall[0].limit, 3.4);
  assert.equal(tall[0].name, 'Old Rail Bridge');
  assert.equal(A.vehicleHazards(route, [bridge], { heightM: 2.0 }).length, 0); // car fits
  const heavy = A.vehicleHazards(route, [{ tags: { maxweight: '7.5' }, geometry: bridge.geometry }], { weightT: 12 });
  assert.equal(heavy[0].kind, 'weight');
  assert.equal(A.vehicleHazards(route, [bridge], null).length, 0);
});

test('road reports: build, validate, snap to route, expire honestly', () => {
  const now = 1000000000;
  const r = A.buildReport(now, 'uid1', 'crash', { lat: 51.500049, lon: -0.120051 });
  assert.equal(r.kind, 'crash');
  assert.equal(r.lat, 51.50005); // 5dp ≈ 1 m — enough to mark a hazard, nothing more
  assert.equal(A.buildReport(now, 'u', 'aliens', { lat: 1, lon: 1 }), null);
  assert.equal(A.buildReport(now, 'u', 'crash', { lat: NaN, lon: 1 }), null);
  assert.equal(A.validReport(r, now + 3600e3), true);          // 1h old — alive
  assert.equal(A.validReport(r, now + 3 * 3600e3), false);     // 3h old — expired
  assert.equal(A.validReport({ ...r, t: now + 600e3 }, now), false); // from the future
  const pts = []; for (let i = 0; i <= 20; i++) pts.push({ lat: 51 + i * 0.001, lon: 0 });
  const route = { geometry: pts, cum: [0], steps: [] };
  for (let i = 1; i < pts.length; i++) route.cum.push(route.cum[i-1] + A.haversine(pts[i-1], pts[i]));
  route.totalM = route.cum[route.cum.length - 1];
  const mapped = A.mapReportsToRoute(route, [
    { kind: 'crash', lat: 51.005, lon: 0, t: now },
    { kind: 'crash', lat: 51.0055, lon: 0, t: now },   // dupe within 120m — dropped
    { kind: 'roadworks', lat: 51.012, lon: 0, t: now },
    { kind: 'hazard', lat: 51.01, lon: 0.03, t: now }, // off-route — dropped
  ]);
  assert.equal(mapped.length, 2);
  const nxt = A.reportNext(mapped, 200);
  assert.equal(nxt.report.kind, 'crash');
  assert.ok(nxt.distM > 300);
});

test('steering: the wheel follows the bend ahead, straight means centred', () => {
  const mk = (pts) => {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i-1] + A.haversine(pts[i-1], pts[i]));
    return { geometry: pts, cum, totalM: cum[cum.length-1], steps: [] };
  };
  // due-north straight road
  const straight = mk(Array.from({ length: 20 }, (_, i) => ({ lat: 51 + i * 0.001, lon: 0 })));
  near(A.steeringAngle(straight, 200), 0, 2);
  // right-angle right turn ~30m ahead
  const turnPts = [];
  for (let i = 0; i <= 10; i++) turnPts.push({ lat: 51 + i * 0.0003, lon: 0 });          // north ~333m
  for (let i = 1; i <= 10; i++) turnPts.push({ lat: 51.003, lon: i * 0.0003 });          // then east
  const turn = mk(turnPts);
  const before = turn.cum[10] - 12; // just before the corner
  assert.ok(A.steeringAngle(turn, before) > 40, 'right turn → wheel right');
  // mirrored left turn steers negative
  const leftPts = turnPts.map((p) => ({ lat: p.lat, lon: -p.lon }));
  const left = mk(leftPts);
  assert.ok(A.steeringAngle(left, before) < -40, 'left turn → wheel left');
  // clamped and junk-safe
  assert.ok(Math.abs(A.steeringAngle(turn, before, 200)) <= 120);
  assert.equal(A.steeringAngle(null, 0), 0);
  assert.equal(A.steeringAngle(straight, straight.totalM), 0); // at the end
});

test('carHeading: cars steer smoothly round corners, no snap-pivot', () => {
  const mk = (pts) => {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i-1] + A.haversine(pts[i-1], pts[i]));
    return { geometry: pts, cum, totalM: cum[cum.length-1], steps: [] };
  };
  // straight north road: chord heading equals the segment heading
  const straight = mk(Array.from({ length: 20 }, (_, i) => ({ lat: 51 + i * 0.001, lon: 0 })));
  near(A.carHeading(straight, 500), 0, 1);
  // north-then-east right-angle corner
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push({ lat: 51 + i * 0.0003, lon: 0 });
  for (let i = 1; i <= 10; i++) pts.push({ lat: 51.003, lon: i * 0.0003 });
  const turn = mk(pts);
  const cornerM = turn.cum[10];
  // well before / after the corner: aligned with each leg
  near(A.carHeading(turn, cornerM - 50), 0, 2);
  near(A.carHeading(turn, cornerM + 50), 90, 2);
  // ON the corner the chord splits the difference — mid-turn, not snapped
  const mid = A.carHeading(turn, cornerM, 6);
  assert.ok(mid > 25 && mid < 65, `mid-corner heading ${mid.toFixed(1)} should be between the legs`);
  // and it rotates monotonically through the bend — that's the steering
  let prev = -1;
  for (let m = cornerM - 3; m <= cornerM + 3; m += 1) {
    const h = A.carHeading(turn, m, 6);
    assert.ok(h >= prev - 0.01, `heading should only wind on through the corner (${h} after ${prev})`);
    prev = h;
  }
  // junk-safe: no route, and route ends
  assert.equal(A.carHeading(null, 10), 0);
  assert.ok(isFinite(A.carHeading(turn, 0)) && isFinite(A.carHeading(turn, turn.totalM)));
});

test('traffic density: the game road carries the real signal', () => {
  const quiet = A.trafficDensity(1.0, 0);
  const rush = A.trafficDensity(1.18, 0);
  const jam = A.trafficDensity(1.35, 3);
  assert.ok(quiet < rush && rush < jam);
  near(quiet, 1.1, 0.01);
  assert.ok(A.trafficDensity(2.5, 9) <= 6);            // capped
  near(A.trafficDensity(NaN, 'x'), 1.1, 0.01);         // junk-safe
  // and the count follows: same 10km road, quiet vs jammed
  const qCars = A.trafficCars(10000, 0, quiet).length;
  const jCars = A.trafficCars(10000, 0, jam).length;
  assert.ok(jCars > qCars, `jam ${jCars} should beat quiet ${qCars}`);
});

test('ambient traffic: deterministic, moving, bounded, game-only cosmetics', () => {
  const a = A.trafficCars(5000, 60000);
  const b = A.trafficCars(5000, 60000);
  same(a.map((c) => c.alongM.toFixed(2)), b.map((c) => c.alongM.toFixed(2))); // same clock ⇒ same world
  assert.ok(a.length >= 2 && a.length <= 18);
  assert.ok(a.every((c) => c.alongM >= 0 && c.alongM <= 5000));
  assert.ok(a.some((c) => c.dir === 1) && a.some((c) => c.dir === -1));
  // ten seconds later every car has moved the right way
  const later = A.trafficCars(5000, 70000);
  for (let i = 0; i < a.length; i++) {
    const want = a[i].dir * (a[i].kmh / 3.6) * 10;
    let dm = later[i].alongM - a[i].alongM;
    if (dm > 2500) dm -= 5000; if (dm < -2500) dm += 5000; // wrap
    near(dm, want, 2);
  }
  // oncoming cars sit in the other lane; short routes have no traffic
  assert.ok(a.filter((c) => c.dir === -1).every((c) => c.laneM > 3));
  assert.equal(A.trafficCars(300, 60000).length, 0);
  // longer roads carry more cars, capped
  assert.ok(A.trafficCars(20000, 0).length >= A.trafficCars(5000, 0).length);
  assert.ok(A.trafficCars(900000, 0).length <= 18);
});

test('calm routes: motorway cruise beats junction soup, guard caps the cost', () => {
  const cruise = { totalM: 20000, totalS: 900, steps: [
    { type: 'depart' }, { type: 'on ramp', modifier: 'right' },
    { type: 'off ramp', modifier: 'left' }, { type: 'arrive' }] };
  const soup = { totalM: 4000, totalS: 800, steps: [
    { type: 'depart' }, { type: 'turn', modifier: 'left' }, { type: 'roundabout', exit: 2 },
    { type: 'merge', modifier: 'right' }, { type: 'fork', modifier: 'left' },
    { type: 'turn', modifier: 'sharp right' }, { type: 'turn', modifier: 'uturn' },
    { type: 'end of road', modifier: 'left' }, { type: 'arrive' }] };
  const cs = A.calmScore(cruise), ss = A.calmScore(soup);
  assert.ok(cs.score > ss.score + 20, `cruise ${cs.score} should beat soup ${ss.score}`);
  assert.ok(ss.heavy >= 4);
  // calmest picks the calm one when the price is fair…
  assert.equal(A.calmestRoute([soup, cruise]).idx, 1);
  // …but never quietly doubles the journey
  const slowCruise = { ...cruise, totalS: 2400 };
  assert.equal(A.calmestRoute([soup, slowCruise]).idx, 0);
});

test('honest ETA: uncertainty admits urban mess, rush edges and incidents', () => {
  const cruise = { totalM: 20000, totalS: 1800, steps: [{ type: 'depart' }, { type: 'arrive' }] };
  const quiet = A.etaBand(cruise, new Date(2026, 7, 9, 3, 0).getTime()); // 3am Sunday
  assert.ok(quiet.lowS < quiet.durS && quiet.durS < quiet.highS);
  assert.ok(quiet.highS - quiet.durS > quiet.durS - quiet.lowS); // late likelier than early
  assert.equal(quiet.label, 'steady');
  const jam = { ...cruise, steps: Array.from({ length: 40 }, () => ({ type: 'turn', modifier: 'left' })),
    totalM: 5000,
    traffic: { adj: { durS: 2400, delayS: 600 }, mapped: [{}, {}, {}], factor: 1.3 } };
  const messy = A.etaBand(jam, new Date(2026, 7, 12, 7, 30).getTime()); // Wednesday rush build-up
  assert.ok(messy.sigmaS > quiet.sigmaS * 2);
  assert.ok(messy.label !== 'steady');
  assert.equal(messy.durS, 2400); // band sits on the traffic-adjusted time
});

test('parking: closer + public + structured wins; private and far sink', () => {
  const dest = { lat: 51.5, lon: -0.12 };
  const spots = [
    { lat: 51.5008, lon: -0.1215, tags: { parking: 'multi-storey', name: 'Q-Park' } },   // ~140m
    { lat: 51.5003, lon: -0.1204, tags: { parking: 'surface', access: 'private' } },     // ~45m but private
    { lat: 51.5002, lon: -0.1208, tags: { parking: 'surface', fee: 'no' } },             // ~60m, free
    { lat: 51.52, lon: -0.12, tags: { parking: 'surface' } },                            // ~2.2km — dropped
  ];
  const ranked = A.rankParking(spots, dest);
  assert.ok(ranked.length >= 2 && ranked.length <= 3);
  assert.equal(ranked[0].fee, 'no'); // near free surface beats all
  assert.ok(ranked.every((p) => p.distM <= 600));
  assert.ok(ranked[ranked.length - 1].score >= ranked[0].score);
  const walk = A.walkInfo({ lat: 51.5008, lon: -0.1215 , }, dest);
  assert.ok(walk.distM > 80 && walk.distM < 250);
  assert.ok(walk.minutes >= 1 && walk.minutes <= 3);
  assert.ok(typeof walk.dir === 'string' && walk.dir.length > 0);
});

test('speechSafe: Arabic street names drop from speech, Latin ones stay', () => {
  assert.equal(A.speechSafe('Turn left onto \u0634\u0627\u0631\u0639 \u0627\u0644\u0634\u064a\u062e \u0632\u0627\u064a\u062f'), 'Turn left');
  assert.equal(A.speechSafe('In 200 metres, at the roundabout, take the 2nd exit onto \u0634\u0627\u0631\u0639 2'),
               'In 200 metres, at the roundabout, take the 2nd exit');
  assert.equal(A.speechSafe('Head north on \u0634\u0627\u0631\u0639 \u062e\u0644\u064a\u0641\u0629'), 'Head north');
  assert.equal(A.speechSafe('Make a U-turn and continue on \u041d\u0435\u0432\u0441\u043a\u0438\u0439'), 'Make a U-turn');
  assert.equal(A.speechSafe('Turn left onto Sheikh Zayed Road'), 'Turn left onto Sheikh Zayed Road');
  assert.equal(A.speechSafe('You have arrived at your destination'), 'You have arrived at your destination');
  assert.equal(A.speechSafe('Continue straight on Baker Street'), 'Continue straight on Baker Street');
});

test('overspeed buffer: warnings arm later where enforcement allows a margin', () => {
  // limit 100: default tolerance is 106; with a +20 buffer it becomes 126
  let r = A.overspeedUpdate(null, 115, 100, 1, 20);
  assert.equal(r.warn, false); // inside the buffer — no nag
  assert.equal(r.over, true);  // bubble still shows you are over the limit
  let st = null, warned = false;
  for (let i = 0; i < 4; i++) { const x = A.overspeedUpdate(st, 130, 100, 1, 20); st = x.state; warned = warned || x.warn; }
  assert.equal(warned, true);  // beyond limit+buffer for 3s — warn once
  // no buffer behaves exactly as before
  st = null; warned = false;
  for (let i = 0; i < 4; i++) { const x = A.overspeedUpdate(st, 115, 100, 1, 0); st = x.state; warned = warned || x.warn; }
  assert.equal(warned, true);
  // and inside the buffer it never warns, however long
  st = null; warned = false;
  for (let i = 0; i < 10; i++) { const x = A.overspeedUpdate(st, 115, 100, 1, 20); st = x.state; warned = warned || x.warn; }
  assert.equal(warned, false);
});

test('convoy DJ: track matching survives messy metadata', () => {
  assert.equal(A.trackKey('Midnight Drive (Remastered 2019)', 'Neon Coast'), 'midnight drive|neon coast');
  assert.equal(A.trackKey('Midnight Drive feat. KLLO', 'NEON COAST'), 'midnight drive|neon coast');
  const lib = [
    { name: 'track01', title: 'Getaway', artist: 'The Marlows' },
    { name: 'Midnight Drive - Neon Coast', title: 'Midnight Drive', artist: 'Neon Coast' },
    { name: 'midnight-drive-live', title: 'Midnight Drive [Live]', artist: '' },
  ];
  assert.equal(A.findLocalTrack(lib, { title: 'Midnight Drive', artist: 'Neon Coast' }), 1);
  assert.equal(A.findLocalTrack(lib, { title: 'Midnight  DRIVE!', artist: 'someone else' }), 1); // title fallback
  assert.equal(A.findLocalTrack(lib, { title: 'Unknown Song', artist: 'Nobody' }), -1);
  assert.equal(A.findLocalTrack([], { title: 'x' }), -1);
});

test('convoy DJ: playhead projection and drift correction', () => {
  const mu = { title: 'x', posS: 60, playing: true, at: 100000, durS: 200 };
  near(A.djTarget(mu, 100000), 60, 0.01);
  near(A.djTarget(mu, 110000), 70, 0.01);          // 10s later
  near(A.djTarget({ ...mu, playing: false }, 110000), 60, 0.01); // paused holds
  near(A.djTarget({ ...mu, posS: 195 }, 110000), 200, 0.01);     // clamped to length
  assert.equal(A.syncAdjust(70.4, 70, true, false), 'ok');       // jitter tolerated
  assert.equal(A.syncAdjust(65, 70, true, false), 'seek');       // real drift
  assert.equal(A.syncAdjust(70, 70, true, true), 'play');
  assert.equal(A.syncAdjust(70, 70, false, false), 'pause');
  assert.equal(A.syncAdjust(70, 70, false, true), 'ok');
});

test('convoy DJ: beacons carry validated music, plain beacons stay clean', () => {
  const b = { id: 'p1', name: 'Aisha', lat: 51.5, lon: -0.1, ts: 1000,
              music: { title: '  Midnight Drive  ', artist: 'Neon Coast', durS: 222, posS: 34.5, playing: true } };
  const m = A.applyBeacon({}, b, 'me', 1000);
  assert.equal(m.p1.music.title, 'Midnight Drive');
  assert.equal(m.p1.music.playing, true);
  near(m.p1.music.posS, 34.5, 0.01);
  const junk = A.applyBeacon({}, { ...b, music: { title: '', posS: 'x' } }, 'me', 1000);
  assert.equal(junk.p1.music, undefined); // junk payload dropped, beacon kept
  const plain = A.applyBeacon({}, { id: 'p2', name: 'M', lat: 1, lon: 1, ts: 1000 }, 'me', 1000);
  assert.equal('music' in plain.p2, false);
});

test('convoy chat: build, validate, clamp — text and voice', () => {
  assert.equal(A.chatText('  slow   down,  camera ahead  '), 'slow down, camera ahead');
  assert.equal(A.chatText(''), null);
  assert.equal(A.chatText('x'.repeat(500)).length, 400);
  const m = A.chatMsg(1000, 't1', 'Rafa', { text: 'fuel stop next services?' });
  assert.equal(m.kind, 'chat');
  assert.equal(m.from, 't1');
  assert.equal(m.text, 'fuel stop next services?');
  assert.equal(A.chatMsg(1000, 't1', 'Rafa', { text: '   ' }), null);
  const name = A.chatMsg(1000, 't1', 'x'.repeat(60), { text: 'hi' }).name;
  assert.equal(name.length, 24);
  const v = A.chatMsg(2000, 't1', 'Rafa', { audio: 'data:audio/webm;base64,AAAA', durS: 4.4 });
  assert.equal(v.durS, 4);
  assert.ok(v.audio.startsWith('data:audio'));
  assert.equal(A.chatMsg(2000, 't1', 'R', { audio: 'data:audio/webm;base64,AAAA', durS: 45 }), null);
  assert.equal(A.chatMsg(2000, 't1', 'R', { audio: 'data:text/html;base64,AAAA', durS: 5 }), null);
  assert.equal(A.chatMsg(2000, 't1', 'R', { audio: 'data:audio/webm;base64,' + 'A'.repeat(950000), durS: 5 }), null);
});

test('convoy chat: receive-side validation, dedupe, ordering, ageing', () => {
  const now = 100000;
  const mk = (id, t, from) => ({ kind: 'chat', id, from: from || 'peer', name: 'P', text: 'hi', t });
  assert.equal(A.validChatMsg(mk('a', now), ['me', 'fb-me'], now), true);
  assert.equal(A.validChatMsg(mk('a', now, 'me'), ['me'], now), false); // own echo
  assert.equal(A.validChatMsg(mk('a', now - 7 * 3600e3), ['me'], now), false); // stale
  assert.equal(A.validChatMsg({ kind: 'chat', id: 'x', from: 'p', t: now }, ['me'], now), false); // no body
  assert.equal(A.validChatMsg({ id: 'x', from: 'p', text: 'hi', t: now }, [], now), false); // wrong kind

  let list = A.pruneChat([], mk('m1', now - 50), now);
  list = A.pruneChat(list, mk('m2', now - 10), now);
  const deduped = A.pruneChat(list, mk('m1', now - 50), now); // duplicate id — no change in content
  assert.equal(deduped.length, 2);
  list = A.pruneChat(list, mk('m0', now - 90), now);
  same(list.map((m) => m.id), ['m0', 'm1', 'm2']); // time-sorted
  // capacity: 60 newest survive
  let big = [];
  for (let i = 0; i < 70; i++) big = A.pruneChat(big, mk('b' + i, now - 70 + i), now);
  assert.equal(big.length, 60);
  assert.equal(big[0].id, 'b10');
  assert.equal(A.agoShort(now - 3000, now), 'now');
  assert.equal(A.agoShort(now - 45000, now), '45s');
  assert.equal(A.agoShort(now - 5 * 60000, now), '5 min');
  assert.equal(A.agoShort(now - 2 * 3600e3, now), '2 h');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\natlas: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
