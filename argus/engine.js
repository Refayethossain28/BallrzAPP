/* Argus — the pure "eye on the world" engine.
 * =====================================================================
 * Argus is your own God's Eye View: a live, explorable globe of public
 * signals — aircraft transponders, ship beacons, satellite elements,
 * seismographs — drawn from scratch on a canvas with no map SDK and no
 * build step. Every rule that decides where a satellite is right now,
 * which half of the planet is in darkness, where a contact lands on the
 * screen, what a voice command means, how the OpenSky credit budget is
 * spent and how a view serialises into a shareable link lives HERE, as
 * pure, deterministic, clock-injected functions with zero DOM and zero
 * I/O — unit-tested in scripts/test-argus-logic.mjs, rendered by
 * index.html. The page owns fetch(), WebSocket, canvas and storage.
 *
 * By design there is no people search, no face recognition and no
 * tracking of individuals: contacts are vehicles and natural events.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
  var EARTH_KM = 6371;            // mean radius, used for distances and the globe
  var EARTH_EQ_KM = 6378.137;     // equatorial radius, used by the orbit model
  var MU = 398600.4418;           // km^3/s^2, Earth's gravitational parameter
  var J2 = 1.08262668e-3;         // Earth's oblateness term
  var PI = Math.PI, TWO_PI = 2 * Math.PI;

  /* ---------------- deterministic hashing / seeded randomness ---------------- */

  // FNV-1a 32-bit — stable across platforms, good spread for short strings.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // One deterministic float in [0,1) from any seed string.
  function rand01(seed) {
    var h = hashStr(seed);
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  }

  /* ---------------- small helpers ---------------- */

  function toRad(d) { return d * PI / 180; }
  function toDeg(r) { return r * 180 / PI; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(v, dflt) { var n = Number(v); return isFinite(n) ? n : dflt; }
  function wrapLon(lon) { return ((lon + 180) % 360 + 360) % 360 - 180; }
  function clampLat(lat) { return clamp(lat, -90, 90); }
  function mod(a, n) { return ((a % n) + n) % n; }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- geodesy ---------------- */

  function haversineKm(lat1, lon1, lat2, lon2) {
    var p1 = toRad(lat1), p2 = toRad(lat2);
    var dp = p2 - p1, dl = toRad(lon2 - lon1);
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Initial bearing from point 1 to point 2, degrees clockwise from north.
  function bearingDeg(lat1, lon1, lat2, lon2) {
    var p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return mod(toDeg(Math.atan2(y, x)), 360);
  }

  // Where you end up after travelling `km` along a great circle at `bearing`.
  function destination(lat, lon, bearing, km) {
    var d = km / EARTH_KM, b = toRad(bearing), p1 = toRad(lat), l1 = toRad(lon);
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    var l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: toDeg(p2), lon: wrapLon(toDeg(l2)) };
  }

  function compassPoint(bearing) {
    var pts = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return pts[Math.round(mod(bearing, 360) / 45) % 8];
  }

  function formatCoord(lat, lon) {
    lat = num(lat, 0); lon = num(lon, 0);
    return Math.abs(lat).toFixed(3) + '°' + (lat >= 0 ? 'N' : 'S') + ' ' +
           Math.abs(lon).toFixed(3) + '°' + (lon >= 0 ? 'E' : 'W');
  }

  function formatDist(km) {
    km = num(km, 0);
    if (km < 1) return Math.round(km * 1000) + ' m';
    if (km < 100) return km.toFixed(1) + ' km';
    return Math.round(km).toLocaleString('en-GB') + ' km';
  }

  function formatAlt(m) {
    m = num(m, NaN);
    if (!isFinite(m)) return '—';
    if (m >= 100000) return Math.round(m / 1000).toLocaleString('en-GB') + ' km';
    return Math.round(m).toLocaleString('en-GB') + ' m · FL' + String(Math.max(0, Math.round(m * 3.28084 / 100))).padStart(3, '0');
  }

  function formatSpeed(ms) {
    ms = num(ms, NaN);
    if (!isFinite(ms)) return '—';
    if (ms > 3000) return (ms / 1000).toFixed(2) + ' km/s';
    return Math.round(ms * 3.6) + ' km/h · ' + Math.round(ms * 1.943844) + ' kt';
  }

  function formatAge(ms) {
    ms = Math.max(0, num(ms, 0));
    if (ms < 45 * SECOND) return 'just now';
    if (ms < HOUR) return Math.round(ms / MINUTE) + ' min ago';
    if (ms < DAY) return Math.round(ms / HOUR) + ' h ago';
    return Math.round(ms / DAY) + ' d ago';
  }

  /* ---------------- real solar astronomy ---------------- */

  function solarDeclination(utcMs) {
    var start = Date.UTC(new Date(utcMs).getUTCFullYear(), 0, 0);
    var day = (utcMs - start) / DAY;
    return -23.44 * Math.cos(TWO_PI * (day + 10) / 365.24);
  }

  // Where the sun is directly overhead right now.
  function subsolarPoint(utcMs) {
    var lon = (12 - ((utcMs / HOUR) % 24)) * 15;
    return { lat: solarDeclination(utcMs), lon: wrapLon(lon) };
  }

  function solarElevation(lat, lon, utcMs) {
    var s = subsolarPoint(utcMs);
    var d = toRad(s.lat), phi = toRad(lat), ha = toRad(lon - s.lon);
    var sinEl = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(ha);
    return toDeg(Math.asin(clamp(sinEl, -1, 1)));
  }

  /* ---------------- the globe: orthographic projection ---------------- */
  // A view is { lat, lon, radius, cx, cy }: the point at the centre of the
  // screen, the sphere's radius in CSS pixels and the screen centre.

  function makeView(over) {
    var v = { lat: 30, lon: 0, radius: 300, cx: 0, cy: 0 };
    if (over) for (var k in over) if (isFinite(Number(over[k]))) v[k] = Number(over[k]);
    v.lat = clampLat(v.lat); v.lon = wrapLon(v.lon);
    return v;
  }

  // Unit vector in view space for a lat/lon: x right, y up, z toward viewer.
  function toViewVec(lat, lon, view) {
    var p = toRad(lat), l = toRad(lon - view.lon), p0 = toRad(view.lat);
    var cosP = Math.cos(p);
    var x = cosP * Math.sin(l);
    var y = Math.cos(p0) * Math.sin(p) - Math.sin(p0) * cosP * Math.cos(l);
    var z = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * cosP * Math.cos(l);
    return { x: x, y: y, z: z };
  }

  // Screen position of a point. `visible` is false on the far side.
  function project(lat, lon, view) {
    var v = toViewVec(lat, lon, view);
    return { x: view.cx + v.x * view.radius, y: view.cy - v.y * view.radius, z: v.z, visible: v.z > 0 };
  }

  // Screen → lat/lon, or null when the pixel is off the globe.
  function unproject(sx, sy, view) {
    var x = (sx - view.cx) / view.radius, y = -(sy - view.cy) / view.radius;
    var rr = x * x + y * y;
    if (rr > 1) return null;
    var z = Math.sqrt(1 - rr);
    var p0 = toRad(view.lat);
    var sinP = Math.cos(p0) * y + Math.sin(p0) * z;
    var lat = toDeg(Math.asin(clamp(sinP, -1, 1)));
    var lon = view.lon + toDeg(Math.atan2(x, Math.cos(p0) * z - Math.sin(p0) * y));
    return { lat: lat, lon: wrapLon(lon) };
  }

  // Drag the globe by a pixel delta: rotate so the ground follows the finger.
  function rotateView(view, dx, dy) {
    var degPerPx = 90 / Math.max(1, view.radius);
    return makeView({
      lat: clamp(view.lat + dy * degPerPx, -89, 89),
      lon: view.lon - dx * degPerPx,
      radius: view.radius, cx: view.cx, cy: view.cy
    });
  }

  // Zoom about the screen centre, bounded so the globe never vanishes or
  // becomes a single pixel of ocean.
  function zoomView(view, factor, minR, maxR) {
    var r = clamp(view.radius * (num(factor, 1) || 1), num(minR, 40), num(maxR, 200000));
    return makeView({ lat: view.lat, lon: view.lon, radius: r, cx: view.cx, cy: view.cy });
  }

  // Zoom toward a screen point, keeping the ground under it still.
  function zoomAt(view, factor, sx, sy, minR, maxR) {
    var before = unproject(sx, sy, view);
    var z = zoomView(view, factor, minR, maxR);
    if (!before) return z;
    var after = unproject(sx, sy, z);
    if (!after) return z;
    return makeView({ lat: z.lat + (before.lat - after.lat), lon: z.lon + (before.lon - after.lon), radius: z.radius, cx: z.cx, cy: z.cy });
  }

  // Fit the globe to a screen: the radius that shows the whole disc with a margin.
  function fitRadius(w, h, margin) {
    return Math.max(40, Math.min(w, h) / 2 - num(margin, 24));
  }

  // The lat/lon bounding box of what is on screen, or null when the whole
  // globe (or the horizon) is visible — feeds then fall back to global.
  function bboxOfView(view, w, h) {
    var corners = [[0, 0], [w, 0], [0, h], [w, h], [w / 2, 0], [w / 2, h], [0, h / 2], [w, h / 2]];
    var lamin = 90, lamax = -90, lomin = 180, lomax = -180;
    for (var i = 0; i < corners.length; i++) {
      var p = unproject(corners[i][0], corners[i][1], view);
      if (!p) return null;
      lamin = Math.min(lamin, p.lat); lamax = Math.max(lamax, p.lat);
      lomin = Math.min(lomin, p.lon); lomax = Math.max(lomax, p.lon);
    }
    if (lomax - lomin > 180) return null; // straddles the antimeridian: keep it simple, go global
    var c = unproject(w / 2, h / 2, view);
    if (c) { lamin = Math.min(lamin, c.lat); lamax = Math.max(lamax, c.lat); }
    return { lamin: lamin, lomin: lomin, lamax: lamax, lomax: lomax };
  }

  function inBbox(lat, lon, bbox) {
    if (!bbox) return true;
    return lat >= bbox.lamin && lat <= bbox.lamax && lon >= bbox.lomin && lon <= bbox.lomax;
  }

  // Decode the compact coastline table into rings of [lat, lon] pairs.
  function landRings(data) {
    var rings = (data && data.RINGS) || [], scale = (data && data.SCALE) || 100, out = [];
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i], ring = [];
      for (var j = 0; j + 1 < r.length; j += 2) ring.push([r[j + 1] / scale, r[j] / scale]);
      out.push(ring);
    }
    return out;
  }

  // Project a ring to screen space. Points on the far side are pushed to the
  // horizon so the fill stays sane; rings with nothing visible return null.
  function projectRing(ring, view) {
    var pts = [], any = false;
    for (var i = 0; i < ring.length; i++) {
      var v = toViewVec(ring[i][0], ring[i][1], view);
      var x = v.x, y = v.y;
      if (v.z < 0) {
        var m = Math.hypot(x, y) || 1;
        x /= m; y /= m;
      } else any = true;
      pts.push([view.cx + x * view.radius, view.cy - y * view.radius]);
    }
    return any ? pts : null;
  }

  function signedArea(poly) {
    var a = 0;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    return a / 2;
  }

  // Clip a ring to the near hemisphere and close every visible piece along
  // the horizon, so a landmass half behind the globe — or one that wraps a
  // pole, like Antarctica — fills exactly where its land is. Returns screen
  // polygons. The closure direction follows the ring's own winding: the
  // side of the coast that is land is the same side on screen.
  function clipRing(ring, view) {
    var n = ring.length, i;
    if (n < 3) return [];
    var vs = new Array(n), anyVis = false, allVis = true;
    for (i = 0; i < n; i++) {
      vs[i] = toViewVec(ring[i][0], ring[i][1], view);
      if (vs[i].z > 0) anyVis = true; else allVis = false;
    }
    var R = view.radius, cx = view.cx, cy = view.cy;
    var scr = function (v) { return [cx + v.x * R, cy - v.y * R]; };
    if (allVis) { var full = []; for (i = 0; i < n; i++) full.push(scr(vs[i])); return [full]; }
    if (!anyVis) return [];
    var start = 0;
    while (vs[start].z > 0) start++;
    var crossing = function (a, b) {
      var t = a.z / (a.z - b.z);
      var x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, m = Math.hypot(x, y) || 1;
      return { x: x / m, y: y / m };
    };
    var arcs = [], cur = null, k;
    for (k = 0; k < n; k++) {
      var a = vs[(start + k) % n], b = vs[(start + k + 1) % n];
      if (a.z <= 0 && b.z > 0) { var e = crossing(a, b); cur = { entry: Math.atan2(e.y, e.x), pts: [scr(e), scr(b)] }; }
      else if (a.z > 0 && b.z > 0) { if (cur) cur.pts.push(scr(b)); }
      else if (a.z > 0 && b.z <= 0 && cur) { var x = crossing(a, b); cur.pts.push(scr(x)); cur.exit = Math.atan2(x.y, x.x); arcs.push(cur); cur = null; }
    }
    if (!arcs.length) return [];
    var step = Math.max(0.02, Math.min(0.12, 6 / R));
    var build = function (dir) {
      var polys = [], used = [];
      for (var s = 0; s < arcs.length; s++) {
        if (used[s]) continue;
        var poly = [], ai = s, guard = 0;
        while (!used[ai] && guard++ <= arcs.length) {
          used[ai] = true;
          var arc = arcs[ai];
          for (var p = 0; p < arc.pts.length; p++) poly.push(arc.pts[p]);
          var best = ai, bestD = TWO_PI;
          for (var j = 0; j < arcs.length; j++) {
            var d = mod(dir * (arcs[j].entry - arc.exit), TWO_PI);
            if (d < 1e-9) d = j === ai ? TWO_PI : 0;
            if (d < bestD) { bestD = d; best = j; }
          }
          var m = Math.max(1, Math.ceil(bestD / step));
          for (var q = 1; q < m; q++) { var ang = arc.exit + dir * bestD * q / m; poly.push([cx + Math.cos(ang) * R, cy - Math.sin(ang) * R]); }
          ai = best;
        }
        polys.push(poly);
      }
      return polys;
    };
    // the ring's winding in lon/lat decides which side of the coast is land
    var ll = 0;
    for (i = 0, k = n - 1; i < n; k = i++) ll += ring[k][1] * ring[i][0] - ring[i][1] * ring[k][0];
    var want = ll > 0 ? -1 : 1; // y is down on screen, so the sign flips
    var polys = build(1), total = 0;
    for (i = 0; i < polys.length; i++) total += signedArea(polys[i]);
    if ((total > 0 ? 1 : -1) !== want) polys = build(-1);
    return polys;
  }

  // Ray-cast point-in-polygon on screen coordinates (for tests and hit checks).
  function pointInPolygon(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Is this lat/lon on land, as drawn in this view? (any clipped polygon of any ring)
  function landAtScreen(rings, view, x, y) {
    for (var i = 0; i < rings.length; i++) {
      var polys = clipRing(rings[i], view);
      for (var j = 0; j < polys.length; j++) if (pointInPolygon(x, y, polys[j])) return true;
    }
    return false;
  }

  // Meridians and parallels as lat/lon polylines.
  function graticule(step) {
    step = num(step, 15) || 15;
    var lines = [], lat, lon;
    for (lon = -180; lon < 180; lon += step) {
      var mer = [];
      for (lat = -90; lat <= 90; lat += 5) mer.push([lat, lon]);
      lines.push(mer);
    }
    for (lat = -90 + step; lat < 90; lat += step) {
      var par = [];
      for (lon = -180; lon <= 180; lon += 5) par.push([lat, lon]);
      lines.push(par);
    }
    return lines;
  }

  // The sunlit part of the disc as a screen-space polygon: the visible half
  // of the terminator (a great circle 90° from the subsolar point) closed by
  // the arc of the horizon on the sun's side. Fill the disc XOR this to
  // shade the night.
  function dayRegion(view, utcMs, n) {
    n = num(n, 90) || 90;
    var sun = subsolarPoint(utcMs);
    var s = toViewVec(sun.lat, sun.lon, view);
    var horiz = Math.hypot(s.x, s.y);
    var b, a;
    if (horiz < 1e-9) { b = { x: 1, y: 0, z: 0 }; }
    else b = { x: -s.y / horiz, y: s.x / horiz, z: 0 };
    a = { x: s.y * b.z - s.z * b.y, y: s.z * b.x - s.x * b.z, z: s.x * b.y - s.y * b.x }; // s × b, ⊥ both
    var pts = [], R = view.radius;
    var t0 = a.z >= 0 ? -PI / 2 : PI / 2;
    for (var i = 0; i <= n; i++) {
      var t = t0 + PI * i / n;
      var x = a.x * Math.cos(t) + b.x * Math.sin(t), y = a.y * Math.cos(t) + b.y * Math.sin(t);
      pts.push([view.cx + x * R, view.cy - y * R]);
    }
    // close along the horizon through the sun's screen direction
    var end = pts[pts.length - 1], start = pts[0];
    var angEnd = Math.atan2(end[1] - view.cy, end[0] - view.cx);
    var angStart = Math.atan2(start[1] - view.cy, start[0] - view.cx);
    var sunAng = horiz < 1e-9 ? angEnd + PI / 2 : Math.atan2(-s.y, s.x);
    // walk from angEnd to angStart in the direction that passes sunAng
    var cw = mod(angStart - angEnd, TWO_PI), sunOff = mod(sunAng - angEnd, TWO_PI);
    var dir = sunOff <= cw ? 1 : -1, span = dir === 1 ? cw : TWO_PI - cw;
    for (var j = 1; j < n; j++) {
      var ang = angEnd + dir * span * j / n;
      pts.push([view.cx + Math.cos(ang) * R, view.cy + Math.sin(ang) * R]);
    }
    return { points: pts, sunVisible: s.z > 0, sunScreen: { x: view.cx + s.x * R, y: view.cy - s.y * R } };
  }

  // A deterministic starfield for the space behind the globe.
  function starfield(seed, count, w, h) {
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push({ x: rand01(seed + ':x' + i) * w, y: rand01(seed + ':y' + i) * h,
                 r: 0.4 + rand01(seed + ':r' + i) * 1.1, a: 0.25 + rand01(seed + ':a' + i) * 0.75 });
    }
    return out;
  }

  /* ---------------- visual styles (the "sensor" modes) ---------------- */

  var STYLES = [
    { key: 'optical', label: 'Optical', hotkey: '1', sea: '#0c1b36', seaDeep: '#050a18', land: '#203c2c', coast: '#7fb894',
      grid: 'rgba(130,170,230,0.14)', night: 'rgba(1,3,12,0.62)', text: '#e3ebff', accent: '#8fd3ff', glow: 'rgba(110,170,255,0.35)',
      air: '#ffd166', mil: '#ff5c5c', ship: '#5ec8ff', sat: '#e6b3ff', quake: '#ff7a45', fire: '#ff9f1c', filter: '', scanlines: false },
    { key: 'nvg', label: 'Night vision', hotkey: '2', sea: '#03160a', seaDeep: '#010a04', land: '#0f4a1d', coast: '#5cff8a',
      grid: 'rgba(90,255,140,0.16)', night: 'rgba(0,10,0,0.45)', text: '#b6ffcb', accent: '#5cff8a', glow: 'rgba(60,255,120,0.35)',
      air: '#d8ffe0', mil: '#ffffff', ship: '#9dffb8', sat: '#e8ffe8', quake: '#ffffff', fire: '#ffffff', filter: 'contrast(1.15) brightness(1.05)', scanlines: true },
    { key: 'flir', label: 'FLIR', hotkey: '3', sea: '#0a0212', seaDeep: '#03000a', land: '#3a0a5e', coast: '#c23a9a',
      grid: 'rgba(255,170,90,0.14)', night: 'rgba(0,0,0,0.35)', text: '#ffe0b8', accent: '#ffb347', glow: 'rgba(255,120,40,0.3)',
      air: '#ffffff', mil: '#fff6a0', ship: '#ffcf70', sat: '#ffd9c0', quake: '#ffffff', fire: '#ffffff', filter: 'saturate(1.2)', scanlines: false },
    { key: 'crt', label: 'CRT', hotkey: '4', sea: '#071020', seaDeep: '#03060f', land: '#1b3a3a', coast: '#7fe7d6',
      grid: 'rgba(120,230,220,0.16)', night: 'rgba(0,2,8,0.6)', text: '#c9fff6', accent: '#7fe7d6', glow: 'rgba(120,230,220,0.3)',
      air: '#fff3a0', mil: '#ff7b7b', ship: '#8be0ff', sat: '#f0d0ff', quake: '#ffb07a', fire: '#ffc36b', filter: 'contrast(1.1)', scanlines: true },
    { key: 'noir', label: 'Noir', hotkey: '5', sea: '#111111', seaDeep: '#050505', land: '#3a3a3a', coast: '#c8c8c8',
      grid: 'rgba(255,255,255,0.12)', night: 'rgba(0,0,0,0.55)', text: '#f2f2f2', accent: '#ffffff', glow: 'rgba(255,255,255,0.2)',
      air: '#ffffff', mil: '#ffffff', ship: '#dddddd', sat: '#eeeeee', quake: '#ffffff', fire: '#ffffff', filter: 'grayscale(1) contrast(1.2)', scanlines: false }
  ];

  function styleByKey(key) {
    for (var i = 0; i < STYLES.length; i++) if (STYLES[i].key === key) return STYLES[i];
    return STYLES[0];
  }
  function styleByHotkey(k) {
    for (var i = 0; i < STYLES.length; i++) if (STYLES[i].hotkey === String(k)) return STYLES[i];
    return null;
  }

  /* ---------------- layers & feeds ---------------- */
  // Every layer says where its data comes from, whether a key is needed and
  // how often it may be polled. The page reads this table to build the rail.

  var LAYERS = [
    { key: 'air', label: 'Aircraft', emoji: '✈️', source: 'OpenSky Network', keyless: true, pollMs: 60 * SECOND,
      about: 'Live ADS-B transponders. Anonymous OpenSky allows ~400 credits a day; Argus budgets them.' },
    { key: 'mil', label: 'Military', emoji: '🛡️', source: 'adsb.lol', keyless: true, pollMs: 90 * SECOND,
      about: 'Aircraft on military ICAO ranges, from the adsb.lol community feed.' },
    { key: 'ship', label: 'Ships', emoji: '🚢', source: 'AISStream', keyless: false, pollMs: 0,
      about: 'Live AIS position reports over a WebSocket. Needs a free aisstream.io key.' },
    { key: 'sat', label: 'Satellites', emoji: '🛰️', source: 'CelesTrak', keyless: true, pollMs: 6 * HOUR,
      about: 'Orbital elements propagated on-device every frame. Bundled catalogue works offline.' },
    { key: 'quake', label: 'Earthquakes', emoji: '🌍', source: 'USGS', keyless: true, pollMs: 5 * MINUTE,
      about: 'Every quake of the last 24 hours, sized by magnitude.' },
    { key: 'fire', label: 'Fires', emoji: '🔥', source: 'NASA FIRMS', keyless: false, pollMs: 30 * MINUTE,
      about: 'Active fire detections (VIIRS, last 24 h). Needs a free FIRMS map key.' }
  ];

  function layerByKey(key) {
    for (var i = 0; i < LAYERS.length; i++) if (LAYERS[i].key === key) return LAYERS[i];
    return null;
  }

  function pollDue(lastTs, now, intervalMs) {
    if (!intervalMs) return false;
    return !lastTs || now - lastTs >= intervalMs;
  }

  /* ----- OpenSky (aircraft) ----- */

  var OPENSKY_DAILY_CREDITS = 400; // anonymous allowance

  function openSkyUrl(bbox) {
    var u = 'https://opensky-network.org/api/states/all';
    if (bbox) u += '?lamin=' + bbox.lamin.toFixed(3) + '&lomin=' + bbox.lomin.toFixed(3) +
                    '&lamax=' + bbox.lamax.toFixed(3) + '&lomax=' + bbox.lomax.toFixed(3);
    return u;
  }

  // OpenSky charges by area: 1 credit up to 25 deg², 2 up to 100, 3 up to 400, 4 beyond / global.
  function openSkyCredits(bbox) {
    if (!bbox) return 4;
    var area = Math.max(0, bbox.lamax - bbox.lamin) * Math.max(0, bbox.lomax - bbox.lomin);
    return area <= 25 ? 1 : area <= 100 ? 2 : area <= 400 ? 3 : 4;
  }

  // A rolling 24-hour credit ledger: [{ts, cost}]. Returns what is left and
  // whether a call costing `cost` may go ahead right now.
  function creditBudget(ledger, now, cost, limit) {
    limit = num(limit, OPENSKY_DAILY_CREDITS);
    var kept = [], spent = 0;
    for (var i = 0; i < (ledger || []).length; i++) {
      var e = ledger[i];
      if (e && now - e.ts < DAY) { kept.push(e); spent += num(e.cost, 0); }
    }
    var remaining = Math.max(0, limit - spent);
    return { ledger: kept, spent: spent, remaining: remaining, allowed: num(cost, 0) <= remaining };
  }

  // OpenSky state vector columns (documented order).
  function parseOpenSky(json, now) {
    var states = (json && json.states) || [], out = [];
    var t = (json && json.time) ? json.time * SECOND : now;
    for (var i = 0; i < states.length; i++) {
      var s = states[i];
      if (!s || s[6] == null || s[5] == null) continue;
      var lat = num(s[6], NaN), lon = num(s[5], NaN);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      out.push({
        id: 'air:' + String(s[0] || ('x' + i)).trim(),
        kind: 'air', src: 'opensky',
        label: String(s[1] || '').trim() || String(s[0] || '').toUpperCase(),
        icao: String(s[0] || ''), country: String(s[2] || ''),
        lat: lat, lon: lon,
        alt: s[13] != null ? num(s[13], null) : (s[7] != null ? num(s[7], null) : null),
        speed: s[9] != null ? num(s[9], null) : null,
        heading: s[10] != null ? num(s[10], null) : null,
        vrate: s[11] != null ? num(s[11], null) : null,
        onGround: !!s[8],
        ts: s[3] ? s[3] * SECOND : t
      });
    }
    return out;
  }

  /* ----- adsb.lol (military) ----- */

  function adsbMilUrl() { return 'https://api.adsb.lol/v2/mil'; }

  function parseAdsbLol(json, now) {
    var ac = (json && json.ac) || [], out = [];
    for (var i = 0; i < ac.length; i++) {
      var a = ac[i];
      var lat = num(a && a.lat, NaN), lon = num(a && a.lon, NaN);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      var altFt = a.alt_baro === 'ground' ? 0 : num(a.alt_geom != null ? a.alt_geom : a.alt_baro, NaN);
      out.push({
        id: 'mil:' + String(a.hex || ('x' + i)),
        kind: 'mil', src: 'adsb.lol',
        label: String(a.flight || a.r || a.hex || '').trim(),
        type: String(a.t || ''), reg: String(a.r || ''), desc: String(a.desc || ''),
        lat: lat, lon: lon,
        alt: isFinite(altFt) ? altFt * 0.3048 : null,
        speed: a.gs != null ? num(a.gs, 0) * 0.514444 : null,
        heading: a.track != null ? num(a.track, null) : (a.true_heading != null ? num(a.true_heading, null) : null),
        onGround: a.alt_baro === 'ground',
        ts: now - num(a.seen, 0) * SECOND
      });
    }
    return out;
  }

  /* ----- USGS (earthquakes) ----- */

  function usgsUrl(period) {
    var p = { day: 'all_day', week: '2.5_week', hour: 'all_hour' }[period] || 'all_day';
    return 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/' + p + '.geojson';
  }

  function parseQuakes(geojson, now) {
    var feats = (geojson && geojson.features) || [], out = [];
    for (var i = 0; i < feats.length; i++) {
      var f = feats[i], g = f && f.geometry, p = (f && f.properties) || {};
      if (!g || !g.coordinates || g.coordinates.length < 2) continue;
      var lon = num(g.coordinates[0], NaN), lat = num(g.coordinates[1], NaN);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      var ts = num(p.time, now);
      out.push({
        id: 'quake:' + String(f.id || i), kind: 'quake', src: 'usgs',
        label: 'M' + num(p.mag, 0).toFixed(1) + ' ' + String(p.place || 'unknown place'),
        mag: num(p.mag, 0), place: String(p.place || ''), depthKm: num(g.coordinates[2], 0),
        lat: lat, lon: lon, ts: ts, age: Math.max(0, now - ts), tsunami: !!p.tsunami, url: String(p.url || '')
      });
    }
    out.sort(function (a, b) { return b.mag - a.mag; });
    return out;
  }

  // Radius in px for a quake marker: small tremors stay dots, big ones bloom.
  function quakeRadiusPx(mag) { return 2 + Math.pow(Math.max(0, num(mag, 0)), 1.6) * 0.9; }

  /* ----- NASA FIRMS (fires) ----- */

  function firmsUrl(key, days) {
    return 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' + encodeURIComponent(String(key || '').trim()) +
           '/VIIRS_SNPP_NRT/world/' + clamp(Math.round(num(days, 1)), 1, 5);
  }

  function parseCSV(text) {
    var lines = String(text || '').replace(/\r/g, '').split('\n').filter(function (l) { return l.trim(); });
    if (!lines.length) return [];
    var head = lines[0].split(','), rows = [];
    for (var i = 1; i < lines.length; i++) {
      var cells = lines[i].split(','), row = {};
      for (var j = 0; j < head.length; j++) row[head[j].trim()] = (cells[j] || '').trim();
      rows.push(row);
    }
    return rows;
  }

  function parseFires(csvText, now) {
    var rows = parseCSV(csvText), out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], lat = num(r.latitude, NaN), lon = num(r.longitude, NaN);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      var ts = now;
      if (r.acq_date && r.acq_time) {
        var hh = r.acq_time.padStart(4, '0');
        var parsed = Date.parse(r.acq_date + 'T' + hh.slice(0, 2) + ':' + hh.slice(2, 4) + ':00Z');
        if (isFinite(parsed)) ts = parsed;
      }
      out.push({ id: 'fire:' + i, kind: 'fire', src: 'firms', label: 'Fire · FRP ' + num(r.frp, 0).toFixed(0) + ' MW',
                 lat: lat, lon: lon, frp: num(r.frp, 0), confidence: String(r.confidence || ''), daynight: String(r.daynight || ''), ts: ts });
    }
    return out;
  }

  /* ----- AISStream (ships) ----- */

  function aisSubscribeMessage(key, bbox) {
    var box = bbox ? [[bbox.lamin, bbox.lomin], [bbox.lamax, bbox.lomax]] : [[-90, -180], [90, 180]];
    return { APIKey: String(key || '').trim(), BoundingBoxes: [box], FilterMessageTypes: ['PositionReport'] };
  }

  function parseAIS(msg, now) {
    if (!msg || msg.MessageType !== 'PositionReport') return null;
    var pr = (msg.Message && msg.Message.PositionReport) || {}, meta = msg.MetaData || {};
    var lat = num(pr.Latitude != null ? pr.Latitude : meta.latitude, NaN);
    var lon = num(pr.Longitude != null ? pr.Longitude : meta.longitude, NaN);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    var cog = num(pr.Cog, NaN), sog = num(pr.Sog, NaN), th = num(pr.TrueHeading, NaN);
    return {
      id: 'ship:' + String(meta.MMSI || pr.UserID || 'unknown'), kind: 'ship', src: 'ais',
      label: String(meta.ShipName || '').trim() || ('MMSI ' + String(meta.MMSI || pr.UserID || '?')),
      mmsi: String(meta.MMSI || pr.UserID || ''), lat: lat, lon: lon, alt: 0,
      speed: isFinite(sog) && sog < 102.3 ? sog * 0.514444 : null,
      heading: isFinite(th) && th < 360 ? th : (isFinite(cog) && cog < 360 ? cog : null),
      navStatus: num(pr.NavigationalStatus, null), ts: now
    };
  }

  // Merge a batch of fresh contacts into the roster keyed by id, drop stale
  // ones and cap the roster so a firehose can't eat the browser.
  function mergeContacts(roster, incoming, now, staleMs, cap) {
    var byId = {}, i;
    for (i = 0; i < (roster || []).length; i++) byId[roster[i].id] = roster[i];
    for (i = 0; i < (incoming || []).length; i++) if (incoming[i] && incoming[i].id) byId[incoming[i].id] = incoming[i];
    var out = [];
    for (var id in byId) if (!staleMs || now - byId[id].ts <= staleMs) out.push(byId[id]);
    out.sort(function (a, b) { return b.ts - a.ts; });
    if (cap && out.length > cap) out = out.slice(0, cap);
    return out;
  }

  /* ---------------- satellites: elements → position ---------------- */
  // A simplified SGP model: Keplerian motion with the secular J2 drift of the
  // node, the perigee and the mean anomaly. Good to a few tens of km over a
  // day for LEO — plenty for a globe at this scale, and it is honest about
  // being an approximation in the HUD. Elements are refreshed from CelesTrak.

  function celestrakUrl(group) {
    var g = /^[a-z0-9-]+$/i.test(String(group || '')) ? group : 'stations';
    return 'https://celestrak.org/NORAD/elements/gp.php?GROUP=' + g + '&FORMAT=json';
  }

  function issUrl() { return 'https://api.wheretheiss.at/v1/satellites/25544'; }

  // CelesTrak GP (JSON OMM) → elements. Angles in degrees, mm in rev/day.
  function parseGP(arr) {
    var out = [];
    for (var i = 0; i < (arr || []).length; i++) {
      var g = arr[i];
      if (!g || !isFinite(num(g.MEAN_MOTION, NaN))) continue;
      var epoch = Date.parse(String(g.EPOCH || '').replace(/(\.\d{3})\d+/, '$1') + (/Z$/.test(String(g.EPOCH || '')) ? '' : 'Z'));
      if (!isFinite(epoch)) continue;
      out.push({
        id: 'sat:' + String(g.NORAD_CAT_ID || i), kind: 'sat', src: 'celestrak',
        label: String(g.OBJECT_NAME || ('NORAD ' + g.NORAD_CAT_ID)).trim(), norad: num(g.NORAD_CAT_ID, 0),
        epoch: epoch, inc: num(g.INCLINATION, 0), raan: num(g.RA_OF_ASC_NODE, 0), ecc: num(g.ECCENTRICITY, 0),
        argp: num(g.ARG_OF_PERICENTER, 0), ma: num(g.MEAN_ANOMALY, 0), mm: num(g.MEAN_MOTION, 0)
      });
    }
    return out;
  }

  // Two-line element sets (3 lines with the name) → the same element shape.
  function parseTLE(text) {
    var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+$/, ''); }).filter(Boolean);
    var out = [], name = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.charAt(0) === '1' && l.charAt(1) === ' ' && i + 1 < lines.length && lines[i + 1].charAt(0) === '2') {
        var l1 = l, l2 = lines[i + 1];
        var yy = num(l1.slice(18, 20), 0), doy = num(l1.slice(20, 32), 1);
        var year = yy < 57 ? 2000 + yy : 1900 + yy;
        var epoch = Date.UTC(year, 0, 1) + (doy - 1) * DAY;
        var norad = num(l1.slice(2, 7), 0);
        out.push({
          id: 'sat:' + norad, kind: 'sat', src: 'tle', label: name || ('NORAD ' + norad), norad: norad, epoch: epoch,
          inc: num(l2.slice(8, 16), 0), raan: num(l2.slice(17, 25), 0), ecc: num('0.' + l2.slice(26, 33).trim(), 0),
          argp: num(l2.slice(34, 42), 0), ma: num(l2.slice(43, 51), 0), mm: num(l2.slice(52, 63), 0)
        });
        name = null; i++;
      } else name = l.trim();
    }
    return out;
  }

  // Greenwich mean sidereal time in degrees (IAU 1982 polynomial).
  function gmstDeg(utcMs) {
    var jd = utcMs / DAY + 2440587.5;
    var d = jd - 2451545.0, T = d / 36525;
    var g = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T * T * T / 38710000;
    return mod(g, 360);
  }

  function solveKepler(M, e) {
    var E = e < 0.8 ? M : PI;
    for (var i = 0; i < 30; i++) {
      var dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= dE;
      if (Math.abs(dE) < 1e-12) break;
    }
    return E;
  }

  // Position of a satellite at `utcMs`: geographic sub-point, altitude, speed
  // and the ECI/ECEF vectors (km). Returns null for unusable elements.
  function propagate(el, utcMs) {
    if (!el || !isFinite(num(el.mm, NaN)) || el.mm <= 0) return null;
    var n = el.mm * TWO_PI / 86400;                     // rad/s
    var a = Math.pow(MU / (n * n), 1 / 3);              // km
    var e = clamp(num(el.ecc, 0), 0, 0.99), inc = toRad(el.inc);
    var p = a * (1 - e * e), k = J2 * EARTH_EQ_KM * EARTH_EQ_KM / (p * p);
    var cosI = Math.cos(inc);
    var raanDot = -1.5 * n * k * cosI;
    var argpDot = 0.75 * n * k * (5 * cosI * cosI - 1);
    var mDot = n * (1 + 0.75 * k * Math.sqrt(1 - e * e) * (3 * cosI * cosI - 1));
    var dt = (utcMs - el.epoch) / 1000;
    var M = mod(toRad(el.ma) + mDot * dt, TWO_PI);
    var raan = toRad(el.raan) + raanDot * dt, argp = toRad(el.argp) + argpDot * dt;
    var E = solveKepler(M, e);
    var nu = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e);
    var r = a * (1 - e * Math.cos(E));
    // perifocal position & velocity
    var xp = r * Math.cos(nu), yp = r * Math.sin(nu);
    var h = Math.sqrt(MU * p);
    var vxp = -MU / h * Math.sin(nu), vyp = MU / h * (e + Math.cos(nu));
    var cO = Math.cos(raan), sO = Math.sin(raan), cw = Math.cos(argp), sw = Math.sin(argp), ci = cosI, si = Math.sin(inc);
    var R11 = cO * cw - sO * sw * ci, R12 = -cO * sw - sO * cw * ci;
    var R21 = sO * cw + cO * sw * ci, R22 = -sO * sw + cO * cw * ci;
    var R31 = sw * si, R32 = cw * si;
    var eci = { x: R11 * xp + R12 * yp, y: R21 * xp + R22 * yp, z: R31 * xp + R32 * yp };
    var vel = { x: R11 * vxp + R12 * vyp, y: R21 * vxp + R22 * vyp, z: R31 * vxp + R32 * vyp };
    var g = toRad(gmstDeg(utcMs)), cg = Math.cos(g), sg = Math.sin(g);
    var ecef = { x: cg * eci.x + sg * eci.y, y: -sg * eci.x + cg * eci.y, z: eci.z };
    var rr = Math.hypot(ecef.x, ecef.y, ecef.z);
    return {
      lat: toDeg(Math.asin(clamp(ecef.z / rr, -1, 1))), lon: wrapLon(toDeg(Math.atan2(ecef.y, ecef.x))),
      altKm: rr - EARTH_EQ_KM, speedKmS: Math.hypot(vel.x, vel.y, vel.z),
      periodMin: TWO_PI / n / 60, eci: eci, ecef: ecef
    };
  }

  // A satellite as a contact the HUD understands (alt in metres, speed in m/s).
  function satContact(el, utcMs) {
    var p = propagate(el, utcMs);
    if (!p) return null;
    return { id: el.id, kind: 'sat', src: el.src, label: el.label, norad: el.norad, lat: p.lat, lon: p.lon,
             alt: p.altKm * 1000, speed: p.speedKmS * 1000, heading: null, periodMin: p.periodMin, ts: utcMs, epoch: el.epoch };
  }

  // Sub-satellite path from `from` to `to` in `n` steps, as [lat, lon] pairs.
  function groundTrack(el, from, to, n) {
    n = Math.max(2, Math.round(num(n, 120)));
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var p = propagate(el, from + (to - from) * i / n);
      if (p) pts.push([p.lat, p.lon]);
    }
    return pts;
  }

  // Observer ECEF on a sphere of EARTH_EQ_KM (adequate for look angles here).
  function observerEcef(lat, lon) {
    var p = toRad(lat), l = toRad(lon);
    return { x: EARTH_EQ_KM * Math.cos(p) * Math.cos(l), y: EARTH_EQ_KM * Math.cos(p) * Math.sin(l), z: EARTH_EQ_KM * Math.sin(p) };
  }

  // Elevation / azimuth / range from an observer to a satellite position.
  function lookAngles(pos, lat, lon) {
    var o = observerEcef(lat, lon);
    var dx = pos.ecef.x - o.x, dy = pos.ecef.y - o.y, dz = pos.ecef.z - o.z;
    var p = toRad(lat), l = toRad(lon);
    var sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l);
    var south = sp * cl * dx + sp * sl * dy - cp * dz;
    var east = -sl * dx + cl * dy;
    var up = cp * cl * dx + cp * sl * dy + sp * dz;
    var range = Math.hypot(dx, dy, dz);
    return { elevation: toDeg(Math.asin(clamp(up / range, -1, 1))), azimuth: mod(toDeg(Math.atan2(east, -south)), 360), rangeKm: range };
  }

  // The next time the satellite rises above `minEl` degrees for an observer,
  // scanning ahead in `stepSec` steps for up to `maxHours`. Returns null if
  // it never does (e.g. a low-inclination orbit seen from the poles).
  function nextPass(el, lat, lon, from, opts) {
    opts = opts || {};
    var minEl = num(opts.minEl, 10), step = num(opts.stepSec, 30) * SECOND, maxT = from + num(opts.maxHours, 24) * HOUR;
    var rise = null, maxE = -90, maxAt = null, wasUp = false;
    for (var t = from; t <= maxT; t += step) {
      var p = propagate(el, t);
      if (!p) return null;
      var la = lookAngles(p, lat, lon), up = la.elevation >= minEl;
      if (up && !wasUp) { rise = t; maxE = la.elevation; maxAt = t; }
      if (up && la.elevation > maxE) { maxE = la.elevation; maxAt = t; }
      if (!up && wasUp) return { rise: rise, set: t, maxElevation: maxE, maxAt: maxAt, durationMs: t - rise };
      wasUp = up;
    }
    return rise ? { rise: rise, set: null, maxElevation: maxE, maxAt: maxAt, durationMs: null } : null;
  }

  // A bundled catalogue so the sky is never empty offline. Epochs are a fixed
  // snapshot (the HUD shows their age); CelesTrak refreshes them online.
  var BUNDLED_SATS = [
    { id: 'sat:25544', kind: 'sat', src: 'bundled', label: 'ISS (ZARYA)', norad: 25544, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 51.6416, raan: 247.4627, ecc: 0.0006703, argp: 130.536, ma: 325.028, mm: 15.49 },
    { id: 'sat:20580', kind: 'sat', src: 'bundled', label: 'HUBBLE SPACE TELESCOPE', norad: 20580, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 28.4697, raan: 103.5, ecc: 0.000276, argp: 200.1, ma: 159.9, mm: 15.14 },
    { id: 'sat:48274', kind: 'sat', src: 'bundled', label: 'TIANGONG (CSS)', norad: 48274, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 41.4718, raan: 12.3, ecc: 0.000553, argp: 44.2, ma: 315.9, mm: 15.61 },
    { id: 'sat:43013', kind: 'sat', src: 'bundled', label: 'NOAA 20 (JPSS-1)', norad: 43013, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 98.7, raan: 200.2, ecc: 0.000159, argp: 90.1, ma: 270.0, mm: 14.19 },
    { id: 'sat:39634', kind: 'sat', src: 'bundled', label: 'SENTINEL-1A', norad: 39634, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 98.18, raan: 275.0, ecc: 0.000137, argp: 80.0, ma: 280.0, mm: 14.59 },
    { id: 'sat:27424', kind: 'sat', src: 'bundled', label: 'AQUA', norad: 27424, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 98.2, raan: 60.0, ecc: 0.00012, argp: 95.0, ma: 265.0, mm: 14.57 },
    { id: 'sat:25994', kind: 'sat', src: 'bundled', label: 'TERRA', norad: 25994, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 98.1, raan: 330.0, ecc: 0.00011, argp: 85.0, ma: 275.0, mm: 14.57 },
    { id: 'sat:36411', kind: 'sat', src: 'bundled', label: 'GPS IIF-1 (NAVSTAR 65)', norad: 36411, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 55.0, raan: 150.0, ecc: 0.004, argp: 30.0, ma: 330.0, mm: 2.0057 },
    { id: 'sat:41866', kind: 'sat', src: 'bundled', label: 'GOES 16', norad: 41866, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 0.05, raan: 270.0, ecc: 0.0001, argp: 0.0, ma: 165.0, mm: 1.00272 },
    { id: 'sat:37846', kind: 'sat', src: 'bundled', label: 'GALILEO-FM1', norad: 37846, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 56.0, raan: 40.0, ecc: 0.0003, argp: 120.0, ma: 240.0, mm: 1.7047 },
    { id: 'sat:33591', kind: 'sat', src: 'bundled', label: 'NOAA 19', norad: 33591, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 99.1, raan: 120.0, ecc: 0.0014, argp: 60.0, ma: 300.0, mm: 14.13 },
    { id: 'sat:40697', kind: 'sat', src: 'bundled', label: 'SENTINEL-2A', norad: 40697, epoch: Date.UTC(2026, 8, 20, 12, 0, 0), inc: 98.57, raan: 310.0, ecc: 0.0001, argp: 90.0, ma: 270.0, mm: 14.31 }
  ];

  /* ---------------- simulation (offline demo, clearly labelled) ---------------- */
  // Deterministic traffic that moves along great circles: every contact's
  // origin, heading and speed come from the seed, its position from the clock.

  var SIM_LANES = [
    // [lat, lon, name] — busy places a simulated flight or ship departs from
    [51.47, -0.46, 'LHR'], [40.64, -73.78, 'JFK'], [25.25, 55.36, 'DXB'], [35.55, 139.78, 'HND'], [1.36, 103.99, 'SIN'],
    [33.94, -118.41, 'LAX'], [-33.95, 151.18, 'SYD'], [49.01, 2.55, 'CDG'], [50.03, 8.57, 'FRA'], [-23.43, -46.47, 'GRU'],
    [19.08, 72.87, 'BOM'], [41.98, -87.9, 'ORD'], [55.97, 37.41, 'SVO'], [30.12, 31.41, 'CAI'], [-26.14, 28.24, 'JNB'],
    [22.31, 113.92, 'HKG'], [37.46, 126.44, 'ICN'], [43.66, -79.63, 'YYZ'], [4.7, -74.15, 'BOG'], [24.43, 54.65, 'AUH']
  ];
  var SIM_PORTS = [[51.95, 4.05, 'Rotterdam'], [1.26, 103.85, 'Singapore'], [31.23, 121.5, 'Shanghai'], [33.73, -118.26, 'Long Beach'],
    [25.0, 55.06, 'Jebel Ali'], [53.55, 9.97, 'Hamburg'], [22.3, 114.17, 'Hong Kong'], [-33.86, 151.2, 'Sydney'], [40.68, -74.15, 'Newark'], [35.45, 139.65, 'Yokohama']];
  var SIM_AIRLINES = ['BAW', 'UAE', 'DLH', 'AFR', 'SIA', 'QTR', 'UAL', 'DAL', 'JAL', 'ANA', 'CPA', 'KLM', 'ETD', 'AAL', 'QFA'];
  var SIM_SHIPS = ['EVER GIVEN', 'MSC OSCAR', 'MAERSK MC-KINNEY', 'CMA CGM MARCO POLO', 'OOCL HONG KONG', 'COSCO SHIPPING UNIVERSE', 'HMM ALGECIRAS', 'ONE APUS', 'MOL TRIUMPH', 'YANG MING WISDOM'];

  function simContacts(seed, now, count) {
    seed = String(seed || 'argus'); count = Math.max(0, Math.round(num(count, 60)));
    var out = [];
    for (var i = 0; i < count; i++) {
      var k = seed + ':' + i, roll = rand01(k + ':kind');
      var kind = roll < 0.72 ? 'air' : roll < 0.92 ? 'ship' : 'mil';
      var pool = kind === 'ship' ? SIM_PORTS : SIM_LANES;
      var from = pool[Math.floor(rand01(k + ':from') * pool.length)];
      var to = pool[Math.floor(rand01(k + ':to') * pool.length)];
      if (to === from) to = pool[(pool.indexOf(from) + 1) % pool.length];
      var heading = bearingDeg(from[0], from[1], to[0], to[1]);
      var speed = kind === 'ship' ? 6 + rand01(k + ':spd') * 6 : kind === 'mil' ? 180 + rand01(k + ':spd') * 120 : 210 + rand01(k + ':spd') * 50;
      var total = haversineKm(from[0], from[1], to[0], to[1]);
      var elapsedKm = mod(rand01(k + ':phase') * total + (now / 1000) * speed / 1000, Math.max(1, total));
      var pos = destination(from[0], from[1], heading, elapsedKm);
      var label = kind === 'ship' ? SIM_SHIPS[Math.floor(rand01(k + ':name') * SIM_SHIPS.length)]
        : kind === 'mil' ? 'RCH' + String(100 + Math.floor(rand01(k + ':name') * 899))
        : SIM_AIRLINES[Math.floor(rand01(k + ':name') * SIM_AIRLINES.length)] + String(10 + Math.floor(rand01(k + ':num') * 989));
      out.push({ id: 'sim:' + kind + ':' + i, kind: kind, src: 'sim', sim: true, label: label, lat: pos.lat, lon: pos.lon,
                 alt: kind === 'ship' ? 0 : 9000 + Math.round(rand01(k + ':alt') * 3000), speed: speed, heading: heading, ts: now,
                 route: from[2] + ' → ' + to[2] });
    }
    return out;
  }

  /* ---------------- HUD analysis ---------------- */

  function contactsNear(contacts, lat, lon, radiusKm, limit) {
    var out = [];
    for (var i = 0; i < (contacts || []).length; i++) {
      var c = contacts[i], d = haversineKm(lat, lon, c.lat, c.lon);
      if (d <= radiusKm) out.push({ contact: c, distanceKm: d, bearing: bearingDeg(lat, lon, c.lat, c.lon) });
    }
    out.sort(function (a, b) { return a.distanceKm - b.distanceKm; });
    return limit ? out.slice(0, limit) : out;
  }

  function nearest(contacts, lat, lon, kind) {
    var best = null;
    for (var i = 0; i < (contacts || []).length; i++) {
      var c = contacts[i];
      if (kind && c.kind !== kind) continue;
      var d = haversineKm(lat, lon, c.lat, c.lon);
      if (!best || d < best.distanceKm) best = { contact: c, distanceKm: d, bearing: bearingDeg(lat, lon, c.lat, c.lon) };
    }
    return best;
  }

  function countByKind(contacts, bbox) {
    var counts = {};
    for (var i = 0; i < (contacts || []).length; i++) {
      var c = contacts[i];
      if (!inBbox(c.lat, c.lon, bbox)) continue;
      counts[c.kind] = (counts[c.kind] || 0) + 1;
    }
    return counts;
  }

  var KIND_LABELS = { air: 'aircraft', mil: 'military aircraft', ship: 'ships', sat: 'satellites', quake: 'earthquakes', fire: 'fires' };

  function summarize(contacts, bbox) {
    var counts = countByKind(contacts, bbox), parts = [];
    ['air', 'mil', 'ship', 'sat', 'quake', 'fire'].forEach(function (k) {
      if (counts[k]) parts.push(counts[k].toLocaleString('en-GB') + ' ' + KIND_LABELS[k]);
    });
    var maxQ = null;
    for (var i = 0; i < (contacts || []).length; i++) {
      var c = contacts[i];
      if (c.kind === 'quake' && inBbox(c.lat, c.lon, bbox) && (!maxQ || c.mag > maxQ.mag)) maxQ = c;
    }
    return { counts: counts, text: parts.length ? parts.join(' · ') : 'no contacts', strongestQuake: maxQ };
  }

  // The lines the HUD shows for a selected contact.
  function describeContact(c, now) {
    if (!c) return [];
    var rows = [];
    var kindName = { air: 'Aircraft', mil: 'Military aircraft', ship: 'Vessel', sat: 'Satellite', quake: 'Earthquake', fire: 'Active fire' }[c.kind] || 'Contact';
    rows.push(['Type', kindName + (c.sim ? ' · SIMULATED' : '')]);
    rows.push(['Position', formatCoord(c.lat, c.lon)]);
    if (c.kind === 'quake') {
      rows.push(['Magnitude', 'M' + num(c.mag, 0).toFixed(1)]);
      rows.push(['Depth', num(c.depthKm, 0).toFixed(0) + ' km']);
      rows.push(['When', formatAge(now - c.ts)]);
      if (c.tsunami) rows.push(['Tsunami', 'advisory issued']);
    } else if (c.kind === 'sat') {
      rows.push(['Altitude', Math.round(c.alt / 1000).toLocaleString('en-GB') + ' km']);
      rows.push(['Speed', (c.speed / 1000).toFixed(2) + ' km/s']);
      if (c.periodMin) rows.push(['Period', Math.round(c.periodMin) + ' min']);
      rows.push(['Elements', (c.src === 'bundled' ? 'bundled snapshot, ' : 'CelesTrak, ') + formatAge(now - c.epoch)]);
    } else if (c.kind === 'fire') {
      rows.push(['Radiative power', num(c.frp, 0).toFixed(0) + ' MW']);
      rows.push(['Detected', formatAge(now - c.ts)]);
    } else {
      if (c.type) rows.push(['Aircraft', c.type + (c.desc ? ' · ' + c.desc : '')]);
      if (c.route) rows.push(['Route', c.route]);
      rows.push(['Altitude', c.onGround ? 'on the ground' : formatAlt(c.alt)]);
      rows.push(['Speed', formatSpeed(c.speed)]);
      if (c.heading != null) rows.push(['Heading', Math.round(c.heading) + '° ' + compassPoint(c.heading)]);
      if (c.vrate != null && Math.abs(c.vrate) > 0.5) rows.push(['Climb', (c.vrate > 0 ? '+' : '') + Math.round(c.vrate * 196.85) + ' ft/min']);
      if (c.country) rows.push(['Registered', c.country]);
      if (c.mmsi) rows.push(['MMSI', c.mmsi]);
      rows.push(['Seen', formatAge(now - c.ts)]);
    }
    rows.push(['Source', { opensky: 'OpenSky Network', 'adsb.lol': 'adsb.lol', ais: 'AISStream', celestrak: 'CelesTrak', bundled: 'bundled catalogue', usgs: 'USGS', firms: 'NASA FIRMS', sim: 'simulation', tle: 'TLE' }[c.src] || c.src || '—']);
    return rows;
  }

  // Screen placement for the contacts on the visible hemisphere, with a
  // detection box for the mesh. Off-screen and far-side contacts are dropped.
  function visibleContacts(contacts, view, w, h, pad) {
    pad = num(pad, 20);
    var out = [];
    for (var i = 0; i < (contacts || []).length; i++) {
      var c = contacts[i], p = project(c.lat, c.lon, view);
      if (!p.visible || p.x < -pad || p.y < -pad || p.x > w + pad || p.y > h + pad) continue;
      var size = c.kind === 'quake' ? quakeRadiusPx(c.mag) + 4 : c.kind === 'sat' ? 9 : 7;
      out.push({ contact: c, x: p.x, y: p.y, size: size, box: [p.x - size, p.y - size, size * 2, size * 2] });
    }
    return out;
  }

  // The contact under a tap, if any within `hitPx`.
  function hitTest(placed, sx, sy, hitPx) {
    hitPx = num(hitPx, 18);
    var best = null, bd = hitPx;
    for (var i = 0; i < (placed || []).length; i++) {
      var d = Math.hypot(placed[i].x - sx, placed[i].y - sy);
      if (d <= bd) { bd = d; best = placed[i]; }
    }
    return best;
  }

  /* ---------------- places & commands ---------------- */

  var PLACES = [
    ['London', 51.507, -0.128], ['Paris', 48.857, 2.352], ['Berlin', 52.52, 13.405], ['Madrid', 40.417, -3.703], ['Rome', 41.903, 12.496],
    ['Amsterdam', 52.37, 4.895], ['Istanbul', 41.008, 28.978], ['Moscow', 55.756, 37.617], ['Dubai', 25.204, 55.27], ['Riyadh', 24.713, 46.675],
    ['Cairo', 30.044, 31.236], ['Lagos', 6.524, 3.379], ['Nairobi', -1.286, 36.817], ['Johannesburg', -26.204, 28.047], ['Mumbai', 19.076, 72.878],
    ['Delhi', 28.614, 77.209], ['Dhaka', 23.81, 90.412], ['Singapore', 1.352, 103.82], ['Jakarta', -6.209, 106.846], ['Bangkok', 13.756, 100.502],
    ['Hong Kong', 22.319, 114.169], ['Shanghai', 31.23, 121.474], ['Beijing', 39.904, 116.407], ['Seoul', 37.567, 126.978], ['Tokyo', 35.676, 139.65],
    ['Sydney', -33.869, 151.209], ['Auckland', -36.848, 174.763], ['Los Angeles', 34.052, -118.244], ['San Francisco', 37.775, -122.419],
    ['Seattle', 47.606, -122.332], ['Chicago', 41.878, -87.63], ['New York', 40.713, -74.006], ['Miami', 25.762, -80.192], ['Toronto', 43.653, -79.383],
    ['Mexico City', 19.433, -99.133], ['Bogotá', 4.711, -74.072], ['Lima', -12.046, -77.043], ['São Paulo', -23.551, -46.633], ['Buenos Aires', -34.604, -58.382],
    ['Reykjavík', 64.147, -21.942], ['Anchorage', 61.218, -149.9], ['Honolulu', 21.307, -157.858], ['Texas', 31.0, -100.0], ['California', 36.8, -119.4],
    ['Europe', 50.0, 10.0], ['Africa', 5.0, 20.0], ['Asia', 35.0, 95.0], ['Australia', -25.0, 134.0], ['South America', -15.0, -60.0], ['North America', 45.0, -100.0],
    ['Atlantic', 30.0, -40.0], ['Pacific', 0.0, -160.0], ['Indian Ocean', -20.0, 75.0], ['Arctic', 85.0, 0.0], ['Antarctica', -82.0, 0.0],
    ['Ukraine', 49.0, 32.0], ['Taiwan', 23.7, 121.0], ['Persian Gulf', 26.5, 52.0], ['Red Sea', 20.0, 38.5], ['Suez', 30.5, 32.35], ['Panama', 9.1, -79.7],
    ['Gibraltar', 36.1, -5.35], ['Malacca', 2.5, 101.5], ['Hormuz', 26.6, 56.3], ['English Channel', 50.3, -1.0], ['Baltic', 58.0, 20.0], ['Mediterranean', 35.0, 18.0]
  ];

  function findPlace(query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    var best = null;
    for (var i = 0; i < PLACES.length; i++) {
      var name = PLACES[i][0].toLowerCase();
      if (name === q) return { name: PLACES[i][0], lat: PLACES[i][1], lon: PLACES[i][2] };
      if (!best && (name.indexOf(q) === 0 || q.indexOf(name) >= 0)) best = { name: PLACES[i][0], lat: PLACES[i][1], lon: PLACES[i][2] };
    }
    return best;
  }

  // Free-form "lat, lon" or "51.5 -0.1" input → a point.
  function parseLatLon(text) {
    var m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text || ''));
    if (!m) return null;
    var lat = Number(m[1]), lon = Number(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { name: formatCoord(lat, lon), lat: lat, lon: lon };
  }

  var KIND_WORDS = [
    ['air', /\b(flights?|planes?|aircraft|airliners?|jets?)\b/],
    ['mil', /\b(military|mil|fighters?|warplanes?|tankers?)\b/],
    ['ship', /\b(ships?|vessels?|boats?|tankers?|cargo|shipping)\b/],
    ['sat', /\b(satellites?|sats?|orbit(?:al)?|iss|space station)\b/],
    ['quake', /\b(earthquakes?|quakes?|seismic|tremors?)\b/],
    ['fire', /\b(fires?|wildfires?|hotspots?)\b/]
  ];
  function kindFromText(t) {
    for (var i = 0; i < KIND_WORDS.length; i++) if (KIND_WORDS[i][1].test(t)) return KIND_WORDS[i][0];
    return null;
  }
  var STYLE_WORDS = [
    ['nvg', /\b(nvg|night ?vision|green)\b/], ['flir', /\b(flir|thermal|infrared|ir|ironbow)\b/],
    ['crt', /\b(crt|scanlines?|retro)\b/], ['noir', /\b(noir|black and white|mono(?:chrome)?)\b/],
    ['optical', /\b(optical|normal|colou?r|default|day)\b/]
  ];

  // The command grammar for the voice/typed console. Pure: returns an
  // action for the page to perform, never performs it.
  function parseCommand(text) {
    var raw = String(text || '').trim();
    var t = raw.toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
    if (!t) return { type: 'noop' };
    if (/^(help|what can (you|i) (do|say)|commands?)$/.test(t)) return { type: 'help' };
    if (/^(stop|release|untrack|stop tracking|clear|cancel)$/.test(t)) return { type: 'untrack' };
    if (/\b(tour|orbit the (globe|earth|world)|spin|auto ?rotate|cinematic)\b/.test(t)) return { type: 'tour', on: !/\b(stop|off|end)\b/.test(t) };
    if (/\b(where am i|my location|locate me|find me|home)\b/.test(t)) return { type: 'locate' };
    if (/\b(zoom out to (the )?(globe|world|earth)|globe view|whole (planet|world|earth)|zoom all the way out)\b/.test(t)) return { type: 'zoom', factor: 0 };
    var zm = /\b(zoom|closer|further|farther|back off)\b/.exec(t);
    if (zm) {
      // "zoom in on Dubai" is a fly-to, "zoom in" alone is a step
      var rest = t.replace(/\b(zoom|in|out|on|to|at|over|closer|further|farther|back off|away|the|a|please|me)\b/g, ' ').replace(/\s+/g, ' ').trim();
      var zp = rest ? (parseLatLon(rest) || findPlace(rest)) : null;
      if (zp) return { type: 'goto', place: zp, zoom: 'close' };
      return { type: 'zoom', factor: /\b(out|further|farther|back off|away)\b/.test(t) ? 0.5 : 2 };
    }
    for (var i = 0; i < STYLE_WORDS.length; i++) {
      if (/\b(switch|change|go|set|turn|enter|view|mode|vision|style|filter|sensor)\b/.test(t) && STYLE_WORDS[i][1].test(t)) return { type: 'style', key: STYLE_WORDS[i][0] };
    }
    var mesh = /\b(detection (mesh|boxes)|bounding boxes|mesh)\b/.exec(t);
    if (mesh) return { type: 'mesh', on: !/\b(hide|off|disable|remove|no)\b/.test(t) };
    var kind = kindFromText(t);
    var howMany = /\b(how many|count|number of)\b/.test(t);
    if (howMany && kind) {
      var pm = /\b(?:over|in|near|around|above|off|by)\s+(.+)$/.exec(t);
      var place = pm ? (findPlace(pm[1]) || parseLatLon(pm[1])) : null;
      return { type: 'count', kind: kind, place: place, placeText: pm ? pm[1] : null };
    }
    if (/\b(track|follow|lock(?: on(?:to)?)?|ride|cockpit|jump to|show me the)\b/.test(t) && (kind || /\b(nearest|closest|biggest|strongest|largest|highest|fastest)\b/.test(t))) {
      var pick = /\b(biggest|strongest|largest)\b/.test(t) ? 'strongest' : /\b(highest)\b/.test(t) ? 'highest' : /\b(fastest)\b/.test(t) ? 'fastest' : 'nearest';
      if (/\b(iss|space station)\b/.test(t)) return { type: 'track', kind: 'sat', pick: 'iss' };
      return { type: 'track', kind: kind || 'air', pick: pick };
    }
    if (/\b(next pass|when (does|will|is) .*(pass|overhead|over me|visible)|pass over)\b/.test(t)) return { type: 'pass', pick: /\b(iss|space station)\b/.test(t) ? 'iss' : 'nearest' };
    if (kind && /\b(show|hide|enable|disable|turn (on|off)|toggle|layer|only|remove|add)\b/.test(t)) {
      var on = !/\b(hide|disable|turn off|remove|off)\b/.test(t);
      return { type: 'layer', kind: kind, on: on, only: /\b(only|just)\b/.test(t) };
    }
    var go = /^(?:(?:please )?(?:go|take me|fly|jump|pan|navigate|move|head|travel|zoom|look|point|show me|show|centre|center|focus)\s+(?:me\s+)?(?:to|on|at|over|towards?)?\s*)(.+)$/.exec(t);
    var target = go ? go[1] : t;
    target = target.replace(/^(the|a)\s+/, '');
    var found = parseLatLon(target) || findPlace(target);
    if (found) return { type: 'goto', place: found, zoom: /\b(zoom|closer|close)\b/.test(t) ? 'close' : 'region' };
    return { type: 'unknown', text: raw };
  }

  var HELP_LINES = [
    '"take me to Tokyo" · "go to 51.5, -0.1" · "zoom out to globe"',
    '"switch to night vision" · "FLIR mode" · "CRT" · "noir" · "optical"',
    '"show ships" · "hide earthquakes" · "only satellites"',
    '"track the nearest flight" · "follow the ISS" · "track the strongest quake"',
    '"how many flights over Texas" · "how many ships near Singapore"',
    '"next ISS pass" · "detection mesh on" · "tour" · "where am I" · "stop"'
  ];

  /* ---------------- shareable state ---------------- */

  var DEFAULT_LAYERS = ['air', 'mil', 'sat', 'quake'];
  var LAYER_KEYS = LAYERS.map(function (l) { return l.key; });

  function defaultState() {
    return { lat: 30, lon: 0, zoom: 1, style: 'optical', layers: DEFAULT_LAYERS.slice(), track: null, mesh: false };
  }

  // A compact hash fragment for the current scene: "#lat=..&lon=..&z=..&s=nvg&l=air,sat&t=sat:25544&m=1"
  function serializeState(state) {
    var s = state || {}, parts = [];
    parts.push('lat=' + clampLat(num(s.lat, 0)).toFixed(3));
    parts.push('lon=' + wrapLon(num(s.lon, 0)).toFixed(3));
    parts.push('z=' + clamp(num(s.zoom, 1), 0.5, 400).toFixed(2));
    if (s.style && s.style !== 'optical') parts.push('s=' + styleByKey(s.style).key);
    var layers = (s.layers || []).filter(function (k) { return LAYER_KEYS.indexOf(k) >= 0; });
    parts.push('l=' + (layers.length ? layers.join(',') : 'none'));
    if (s.track) parts.push('t=' + encodeURIComponent(String(s.track)));
    if (s.mesh) parts.push('m=1');
    return '#' + parts.join('&');
  }

  function parseState(hash) {
    var st = defaultState(), h = String(hash || '').replace(/^#/, '');
    if (!h) return st;
    var kv = {};
    h.split('&').forEach(function (p) {
      var i = p.indexOf('='); if (i < 0) return;
      try { kv[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1)); } catch (e) { /* ignore junk */ }
    });
    if (kv.lat != null) st.lat = clampLat(num(kv.lat, st.lat));
    if (kv.lon != null) st.lon = wrapLon(num(kv.lon, st.lon));
    if (kv.z != null) st.zoom = clamp(num(kv.z, 1), 0.5, 400);
    if (kv.s) st.style = styleByKey(kv.s).key;
    if (kv.l != null) st.layers = kv.l === 'none' ? [] : kv.l.split(',').filter(function (k) { return LAYER_KEYS.indexOf(k) >= 0; });
    if (kv.t) st.track = String(kv.t).slice(0, 64);
    st.mesh = kv.m === '1';
    return st;
  }

  /* ---------------- tour (scene director) ---------------- */

  // Slow auto-rotation for the cinematic tour; pure in dt.
  function autoRotate(view, dtMs, degPerSec) {
    return makeView({ lat: view.lat, lon: view.lon + num(degPerSec, 4) * dtMs / 1000, radius: view.radius, cx: view.cx, cy: view.cy });
  }

  // Ease one view toward another (for "fly to" moves): t in [0,1].
  function easeView(from, to, t) {
    t = clamp(num(t, 0), 0, 1);
    var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    var dlon = wrapLon(to.lon - from.lon);
    var logR = Math.log(from.radius) + (Math.log(to.radius) - Math.log(from.radius)) * e;
    return makeView({ lat: from.lat + (to.lat - from.lat) * e, lon: from.lon + dlon * e, radius: Math.exp(logR), cx: to.cx, cy: to.cy });
  }

  // Keys as the page stores them: trimmed, bounded, never containing markup.
  function sanitizeKey(v) {
    return String(v == null ? '' : v).trim().replace(/[<>"'\s]/g, '').slice(0, 128);
  }

  var api = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY, EARTH_KM: EARTH_KM, EARTH_EQ_KM: EARTH_EQ_KM,
    hashStr: hashStr, rand01: rand01, escapeHTML: escapeHTML, clamp: clamp, wrapLon: wrapLon, mod: mod,
    haversineKm: haversineKm, bearingDeg: bearingDeg, destination: destination, compassPoint: compassPoint,
    formatCoord: formatCoord, formatDist: formatDist, formatAlt: formatAlt, formatSpeed: formatSpeed, formatAge: formatAge,
    solarDeclination: solarDeclination, subsolarPoint: subsolarPoint, solarElevation: solarElevation,
    makeView: makeView, toViewVec: toViewVec, project: project, unproject: unproject, rotateView: rotateView, zoomView: zoomView, zoomAt: zoomAt,
    fitRadius: fitRadius, bboxOfView: bboxOfView, inBbox: inBbox, landRings: landRings, projectRing: projectRing, clipRing: clipRing, signedArea: signedArea, pointInPolygon: pointInPolygon, landAtScreen: landAtScreen, graticule: graticule,
    dayRegion: dayRegion, starfield: starfield,
    STYLES: STYLES, styleByKey: styleByKey, styleByHotkey: styleByHotkey,
    LAYERS: LAYERS, layerByKey: layerByKey, pollDue: pollDue,
    OPENSKY_DAILY_CREDITS: OPENSKY_DAILY_CREDITS, openSkyUrl: openSkyUrl, openSkyCredits: openSkyCredits, creditBudget: creditBudget, parseOpenSky: parseOpenSky,
    adsbMilUrl: adsbMilUrl, parseAdsbLol: parseAdsbLol,
    usgsUrl: usgsUrl, parseQuakes: parseQuakes, quakeRadiusPx: quakeRadiusPx,
    firmsUrl: firmsUrl, parseCSV: parseCSV, parseFires: parseFires,
    aisSubscribeMessage: aisSubscribeMessage, parseAIS: parseAIS, mergeContacts: mergeContacts,
    celestrakUrl: celestrakUrl, issUrl: issUrl, parseGP: parseGP, parseTLE: parseTLE, gmstDeg: gmstDeg, solveKepler: solveKepler,
    propagate: propagate, satContact: satContact, groundTrack: groundTrack, lookAngles: lookAngles, nextPass: nextPass, BUNDLED_SATS: BUNDLED_SATS,
    simContacts: simContacts,
    contactsNear: contactsNear, nearest: nearest, countByKind: countByKind, summarize: summarize, describeContact: describeContact,
    visibleContacts: visibleContacts, hitTest: hitTest,
    PLACES: PLACES, findPlace: findPlace, parseLatLon: parseLatLon, parseCommand: parseCommand, HELP_LINES: HELP_LINES,
    DEFAULT_LAYERS: DEFAULT_LAYERS, defaultState: defaultState, serializeState: serializeState, parseState: parseState,
    autoRotate: autoRotate, easeView: easeView, sanitizeKey: sanitizeKey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ArgusEngine = api;
})(typeof self !== 'undefined' ? self : this);
