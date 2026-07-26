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

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\natlas: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
