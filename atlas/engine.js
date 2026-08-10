/**
 * Atlas — the Navigation Engine
 * =============================
 *
 * Everything a satnav has to get *right* lives here, pure and deterministic:
 * no DOM, no network, no clock of its own. The UI (index.html) is just a lens
 * over this engine — it feeds in GPS fixes (or simulator ticks) and renders
 * whatever comes back. That split is what makes a satnav testable: "does it
 * say 'turn left' at the right moment?" is a unit test, not a road test.
 *
 * What's inside
 * -------------
 *   Geodesy      haversine distance, initial bearing, destination point,
 *                compass names — WGS-84 mean-radius spherical model, plenty
 *                for guidance (errors are centimetres over guidance scales).
 *   Polyline     Google/OSRM encoded-polyline codec (precision 5/6), written
 *                from the spec — routes travel as compact strings.
 *   Tile maths   Web-Mercator lat/lon ⇄ tile/world-pixel mapping that drives
 *                the from-scratch canvas slippy map.
 *   Route model  buildRoute() normalises an OSRM response into geometry +
 *                cumulative distances + maneuvers located *on* the geometry,
 *                so progress along the line is a single number (metres).
 *   Snapping     snapToRoute() projects a GPS fix onto the route polyline
 *                (windowed search around the last known segment, full rescan
 *                fallback) → snapped point, cross-track error, metres along.
 *   Guidance     guidanceUpdate() is the turn-by-turn state machine: which
 *                maneuver is next, when to speak (three distance bands that
 *                scale with speed so motorway warnings come earlier), spoken-
 *                once bookkeeping, off-route detection with hysteresis,
 *                arrival detection, remaining distance / duration / ETA.
 *   Phrasing     instructionText() / voiceLine() turn OSRM maneuver types
 *                into human English ("At the roundabout, take the 2nd exit
 *                onto High Street (A23)"), with metric or imperial distances.
 *   Simulator    simulateTick() drives a position along a route at a chosen
 *                speed — the offline demo mode, and the test harness's car.
 *   Places       rankPlaces() scores saved/recent destinations for search.
 *
 * UMD so it runs in the browser (window.Atlas) and under Node/vm for tests —
 * same pattern as cusp/engine.js. Pure, deterministic, framework-free.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Atlas = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================ geodesy ================================ */

  var EARTH_R = 6371008.8;          // WGS-84 mean radius, metres
  var DEG = Math.PI / 180;

  /** Great-circle distance in metres between {lat,lon} points (haversine). */
  function haversine(a, b) {
    var dLat = (b.lat - a.lat) * DEG, dLon = (b.lon - a.lon) * DEG;
    var s = Math.sin(dLat / 2), t = Math.sin(dLon / 2);
    var h = s * s + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * t * t;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** Initial great-circle bearing a→b, degrees clockwise from north, [0,360). */
  function bearing(a, b) {
    var dLon = (b.lon - a.lon) * DEG;
    var la = a.lat * DEG, lb = b.lat * DEG;
    var y = Math.sin(dLon) * Math.cos(lb);
    var x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dLon);
    return ((Math.atan2(y, x) / DEG) + 360) % 360;
  }

  /** Point reached from `a` travelling `distM` metres on `bearingDeg`. */
  function destinationPoint(a, bearingDeg, distM) {
    var d = distM / EARTH_R, brg = bearingDeg * DEG;
    var la = a.lat * DEG, lo = a.lon * DEG;
    var lat2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(brg));
    var lon2 = lo + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(la),
                               Math.cos(d) - Math.sin(la) * Math.sin(lat2));
    return { lat: lat2 / DEG, lon: ((lon2 / DEG) + 540) % 360 - 180 };
  }

  /** Smallest signed angular difference b−a in degrees, range (−180, 180]. */
  function angleDiff(a, b) {
    var d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }

  var COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  /** 'north' | 'north-east' | … for a bearing in degrees. */
  function compassName(bearingDeg) {
    return COMPASS[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
  }

  /* ============================ polyline codec ============================ */
  // Google encoded-polyline algorithm (OSRM's wire format), from the spec.

  /** Decode an encoded polyline into [{lat,lon}]. precision 5 (default) or 6. */
  function decodePolyline(str, precision) {
    var factor = Math.pow(10, precision || 5);
    var pts = [], lat = 0, lon = 0, i = 0;
    while (i < str.length) {
      var result = 0, shift = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      result = 0; shift = 0;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lon += (result & 1) ? ~(result >> 1) : (result >> 1);
      pts.push({ lat: lat / factor, lon: lon / factor });
    }
    return pts;
  }

  /** Encode [{lat,lon}] as a polyline string (round-trips with decode). */
  function encodePolyline(pts, precision) {
    var factor = Math.pow(10, precision || 5);
    var out = '', prevLat = 0, prevLon = 0;
    function emit(v) {
      v = v < 0 ? ~(v << 1) : (v << 1);
      while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      out += String.fromCharCode(v + 63);
    }
    for (var i = 0; i < pts.length; i++) {
      var la = Math.round(pts[i].lat * factor), lo = Math.round(pts[i].lon * factor);
      emit(la - prevLat); emit(lo - prevLon);
      prevLat = la; prevLon = lo;
    }
    return out;
  }

  /* ============================== tile maths ============================== */
  // Web-Mercator. World space = pixels at a given zoom with 256-px tiles, so
  // tile (x,y) covers world pixels [x*256,(x+1)*256) × [y*256,(y+1)*256).

  var TILE = 256;

  /** {lat,lon} → world-pixel {x,y} at integer/float zoom. */
  function lonLatToWorld(p, zoom) {
    var scale = TILE * Math.pow(2, zoom);
    var x = (p.lon + 180) / 360 * scale;
    var s = Math.sin(p.lat * DEG);
    var y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
    return { x: x, y: y };
  }

  /** world-pixel {x,y} at zoom → {lat,lon}. Inverse of lonLatToWorld. */
  function worldToLonLat(w, zoom) {
    var scale = TILE * Math.pow(2, zoom);
    var lon = w.x / scale * 360 - 180;
    var n = Math.PI - 2 * Math.PI * w.y / scale;
    var lat = Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) / DEG;
    return { lat: lat, lon: lon };
  }

  /** Which tile a world-pixel falls in: {tx,ty} integers (clamped to grid). */
  function tileForWorld(w, zoom) {
    var n = Math.pow(2, zoom);
    var tx = Math.floor(w.x / TILE), ty = Math.floor(w.y / TILE);
    return { tx: Math.min(n - 1, Math.max(0, tx)), ty: Math.min(n - 1, Math.max(0, ty)) };
  }

  /** Ground metres represented by one world pixel at this lat+zoom. */
  function metresPerPixel(lat, zoom) {
    return Math.cos(lat * DEG) * 2 * Math.PI * EARTH_R / (TILE * Math.pow(2, zoom));
  }

  /* =============================== route model ============================ */

  /**
   * Normalise one OSRM route (json.routes[i]) into the engine's route model:
   *   geometry  [{lat,lon}] decoded from route.geometry (precision 5)
   *   cum       cumulative metres along geometry, cum[0]=0 … cum[n-1]=total
   *   totalM    geometry length in metres (authoritative for progress)
   *   totalS    OSRM's duration estimate, seconds
   *   steps     [{type, modifier, exit, name, alongM, distM, durS, instruction, icon}]
   *             alongM = metres along geometry where the maneuver happens —
   *             each maneuver location is snapped to the nearest geometry
   *             vertex so "distance to turn" is exact on our own line.
   * Throws on a route with no geometry.
   */
  function buildRoute(osrm, opts) {
    opts = opts || {};
    var geometry = typeof osrm.geometry === 'string'
      ? decodePolyline(osrm.geometry, opts.precision || 5)
      : (osrm.geometry.coordinates || []).map(function (c) { return { lat: c[1], lon: c[0] }; });
    if (geometry.length < 2) throw new Error('route has no geometry');

    var cum = [0];
    for (var i = 1; i < geometry.length; i++) cum.push(cum[i - 1] + haversine(geometry[i - 1], geometry[i]));
    var totalM = cum[cum.length - 1];

    var steps = [], searchFrom = 0;
    (osrm.legs || []).forEach(function (leg) {
      (leg.steps || []).forEach(function (s) {
        var m = s.maneuver || {};
        var loc = m.location ? { lat: m.location[1], lon: m.location[0] } : geometry[searchFrom];
        // snap the maneuver to the nearest geometry vertex at/after the last one
        var best = searchFrom, bestD = Infinity;
        for (var g = searchFrom; g < geometry.length; g++) {
          var d = haversine(loc, geometry[g]);
          if (d < bestD) { bestD = d; best = g; }
          if (bestD < 5 && d > bestD + 50) break; // locked on and moving away — stop early
        }
        searchFrom = best;
        var step = {
          type: m.type || 'continue',
          modifier: m.modifier || '',
          exit: m.exit || 0,
          bearingAfter: m.bearing_after || 0,
          name: roadName(s),
          alongM: cum[best],
          distM: s.distance || 0,
          durS: s.duration || 0,
          lanes: parseLanes(s),
        };
        step.instruction = instructionText(step);
        step.icon = maneuverIcon(step.type, step.modifier);
        steps.push(step);
      });
    });
    if (steps.length === 0) {
      steps = [
        { type: 'depart', modifier: '', exit: 0, bearingAfter: bearing(geometry[0], geometry[1]), name: '', alongM: 0, distM: totalM, durS: osrm.duration || 0 },
        { type: 'arrive', modifier: '', exit: 0, bearingAfter: 0, name: '', alongM: totalM, distM: 0, durS: 0 },
      ];
      steps.forEach(function (s) { s.instruction = instructionText(s); s.icon = maneuverIcon(s.type, s.modifier); });
    }
    return { geometry: geometry, cum: cum, totalM: totalM, totalS: osrm.duration || 0, steps: steps };
  }

  /** "High Street (A23)" | "A23" | "" from an OSRM step. */
  function roadName(s) {
    var name = (s.name || '').trim(), ref = (s.ref || '').trim().split(';')[0];
    if (name && ref && name !== ref) return name + ' (' + ref + ')';
    return name || ref;
  }

  /* ============================== snapping ================================ */

  /** Project p onto segment a→b in *world* space terms — done in a local
   *  equirectangular frame (fine at guidance scales). Returns {t, point, dist}. */
  function projectOnSegment(p, a, b) {
    var kx = Math.cos(((a.lat + b.lat) / 2) * DEG); // shrink lon by cos(lat)
    var ax = a.lon * kx, ay = a.lat, bx = b.lon * kx, by = b.lat;
    var px = p.lon * kx, py = p.lat;
    var vx = bx - ax, vy = by - ay;
    var L2 = vx * vx + vy * vy;
    var t = L2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / L2;
    t = Math.max(0, Math.min(1, t));
    var q = { lat: ay + vy * t, lon: (ax + vx * t) / kx };
    return { t: t, point: q, dist: haversine(p, q) };
  }

  /**
   * Snap a fix to the route. hintIndex = last known segment (the search
   * looks ±WINDOW segments around it and only rescans the whole line when
   * the windowed match is poor — O(1) amortised per fix).
   * → {index, t, point, crossTrack, alongM}
   */
  var SNAP_WINDOW = 40;
  function snapToRoute(route, p, hintIndex) {
    var g = route.geometry, cum = route.cum;
    function scan(from, to) {
      var best = null;
      for (var i = from; i < to; i++) {
        var pr = projectOnSegment(p, g[i], g[i + 1]);
        // prefer the earliest segment on ties so we never leap forward on
        // self-overlapping routes (out-and-back roads)
        if (!best || pr.dist < best.crossTrack - 0.01) {
          best = { index: i, t: pr.t, point: pr.point, crossTrack: pr.dist };
        }
      }
      return best;
    }
    var hinted = null;
    if (typeof hintIndex === 'number' && hintIndex >= 0) {
      hinted = scan(Math.max(0, hintIndex - 4), Math.min(g.length - 1, hintIndex + SNAP_WINDOW));
    }
    var best = (hinted && hinted.crossTrack <= 50) ? hinted : scan(0, g.length - 1);
    best.alongM = cum[best.index] + (cum[best.index + 1] - cum[best.index]) * best.t;
    return best;
  }

  /** Position + heading on the route at `alongM` metres (clamped). */
  function pointAtAlong(route, alongM) {
    var cum = route.cum, g = route.geometry;
    var m = Math.max(0, Math.min(route.totalM, alongM));
    var lo = 0, hi = cum.length - 1;
    while (lo + 1 < hi) { var mid = (lo + hi) >> 1; if (cum[mid] <= m) lo = mid; else hi = mid; }
    var span = cum[lo + 1] - cum[lo];
    var t = span === 0 ? 0 : (m - cum[lo]) / span;
    return {
      lat: g[lo].lat + (g[lo + 1].lat - g[lo].lat) * t,
      lon: g[lo].lon + (g[lo + 1].lon - g[lo].lon) * t,
      heading: bearing(g[lo], g[lo + 1]),
      index: lo,
    };
  }

  /* ============================== phrasing ================================ */

  var ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];
  var MODIFIER_TEXT = {
    'left': 'left', 'right': 'right',
    'slight left': 'slightly left', 'slight right': 'slightly right',
    'sharp left': 'sharp left', 'sharp right': 'sharp right',
    'straight': 'straight', 'uturn': 'a U-turn',
  };

  /** Display instruction for a step — deterministic English. */
  function instructionText(step) {
    var name = step.name, onto = name ? ' onto ' + name : '';
    var on = name ? ' on ' + name : '';
    var mod = MODIFIER_TEXT[step.modifier] || step.modifier || '';
    switch (step.type) {
      case 'depart': return 'Head ' + compassName(step.bearingAfter) + on;
      case 'arrive':
        if (step.modifier === 'left') return 'You have arrived — your destination is on the left';
        if (step.modifier === 'right') return 'You have arrived — your destination is on the right';
        return 'You have arrived at your destination';
      case 'roundabout': case 'rotary':
        return 'At the roundabout, take the ' + (ORDINALS[step.exit] || 'correct') + ' exit' + onto;
      case 'exit roundabout': case 'exit rotary': return 'Exit the roundabout' + onto;
      case 'merge': return 'Merge ' + (mod || 'ahead') + onto;
      case 'on ramp': return 'Take the ramp ' + (mod ? mod + ' ' : '') + (name ? 'onto ' + name : 'ahead');
      case 'off ramp': return 'Take the exit ' + (mod ? mod + ' ' : '') + (name ? 'onto ' + name : 'ahead');
      case 'fork': return 'Keep ' + (mod || 'ahead') + ' at the fork' + onto;
      case 'end of road': return 'At the end of the road, turn ' + (mod || 'ahead') + onto;
      case 'new name': case 'continue':
        if (step.modifier === 'uturn') return 'Make a U-turn' + (name ? ' and continue on ' + name : '');
        return 'Continue ' + (mod && mod !== 'straight' ? mod : 'straight') + on;
      case 'turn':
        if (step.modifier === 'uturn') return 'Make a U-turn' + (name ? ' and continue on ' + name : '');
        if (step.modifier === 'straight') return 'Continue straight' + on;
        return 'Turn ' + mod + onto;
      default:
        return (mod ? 'Keep ' + mod : 'Continue') + (name ? ' on ' + name : '');
    }
  }

  /** Stable icon key for a maneuver — the UI maps these to arrow glyphs. */
  function maneuverIcon(type, modifier) {
    if (type === 'arrive') return 'arrive';
    if (type === 'depart') return 'depart';
    if (type === 'roundabout' || type === 'rotary') return 'roundabout';
    if (type === 'exit roundabout' || type === 'exit rotary') return 'roundabout';
    if (modifier === 'uturn') return 'uturn';
    var side = /left/.test(modifier || '') ? 'left' : /right/.test(modifier || '') ? 'right' : '';
    if (type === 'merge') return side ? 'merge-' + side : 'straight';
    if (type === 'on ramp' || type === 'off ramp') return side ? 'ramp-' + side : 'straight';
    if (/slight/.test(modifier || '')) return 'slight-' + side;
    if (/sharp/.test(modifier || '')) return 'sharp-' + side;
    if (side) return side;
    return 'straight';
  }

  /* ============================= formatting =============================== */

  var MILE = 1609.344, YARD = 0.9144, FOOT = 0.3048;

  /** "240 m" / "1.2 km" (metric) · "150 yd" / "1.2 mi" (imperial). */
  function fmtDist(m, units) {
    m = Math.max(0, m);
    if (units === 'imperial') {
      var mi = m / MILE;
      if (mi < 0.18) { var yd = Math.max(10, Math.round(m / YARD / 10) * 10); return yd + ' yd'; }
      return (mi < 10 ? (Math.round(mi * 10) / 10).toFixed(1) : String(Math.round(mi))) + ' mi';
    }
    if (m < 950) { return Math.max(10, Math.round(m / 10) * 10) + ' m'; }
    var km = m / 1000;
    return (km < 10 ? (Math.round(km * 10) / 10).toFixed(1) : String(Math.round(km))) + ' km';
  }

  /** Spoken distance — whole words, no abbreviations, sensible rounding. */
  function speakDist(m, units) {
    if (units === 'imperial') {
      var mi = m / MILE;
      if (mi >= 0.22) {
        var q = Math.round(mi * 4) / 4;
        if (q === 0.25) return 'a quarter of a mile';
        if (q === 0.5) return 'half a mile';
        if (q === 0.75) return 'three quarters of a mile';
        var r = q < 3 ? (Math.round(mi * 10) / 10) : Math.round(mi);
        return r + (r === 1 ? ' mile' : ' miles');
      }
      return Math.max(10, Math.round(m / YARD / 10) * 10) + ' yards';
    }
    if (m >= 950) {
      var km = Math.round(m / 100) / 10;
      if (km === 1) return '1 kilometre';
      return (km < 10 ? km : Math.round(km)) + ' kilometres';
    }
    return Math.max(10, Math.round(m / 10) * 10) + ' metres';
  }

  /** "45 s" | "12 min" | "1 h 05 min". */
  function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' s';
    var min = Math.round(s / 60);
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), r = min % 60;
    return h + ' h ' + (r < 10 ? '0' : '') + r + ' min';
  }

  /** Arrival wall-clock "14:32" from an injected now (ms) + seconds ahead. */
  function etaClock(nowMs, aheadS) {
    var d = new Date(nowMs + aheadS * 1000);
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /* ============================== guidance ================================ */

  // Announcement bands. Thresholds grow with speed so a motorway "prepare"
  // fires ~35 s out, while town driving keeps the classic 700 m / 180 m / 25 m.
  function announceBands(speedMS) {
    var v = Math.max(0, speedMS || 0);
    return {
      now: Math.max(30, v * 4),        // "Turn left now"
      soon: Math.max(180, v * 12),     // "In 200 metres, turn left"
      prepare: Math.max(700, v * 35),  // "In 1.2 kilometres, turn left"
    };
  }
  var BAND_RANK = { prepare: 1, soon: 2, now: 3 };

  var OFF_ROUTE_M = 45;        // cross-track beyond this counts as a miss…
  var OFF_ROUTE_FIXES = 3;     // …this many consecutive misses = off route
  var ARRIVE_M = 25;           // within this of the end = arrived

  /** Fresh guidance state for a route. */
  function startGuidance() {
    return { segIndex: 0, stepIndex: 0, spoken: {}, offCount: 0, offRoute: false, arrived: false, speed: 0 };
  }

  /** Remaining {distM, durS} from `alongM`, interpolating OSRM durations. */
  function remaining(route, alongM) {
    var m = Math.max(0, Math.min(route.totalM, alongM));
    var distM = route.totalM - m;
    var durS = 0, steps = route.steps;
    for (var i = 0; i < steps.length; i++) {
      var start = steps[i].alongM;
      var end = (i + 1 < steps.length) ? steps[i + 1].alongM : route.totalM;
      if (end <= m) continue;
      if (start >= m) { durS += steps[i].durS; continue; }
      var span = end - start;
      durS += span > 0 ? steps[i].durS * ((end - m) / span) : 0;
    }
    return { distM: distM, durS: durS };
  }

  /**
   * The heart of turn-by-turn. Pure: (state, route, fix, opts) → result.
   * fix = {lat, lon, speed (m/s, optional), heading (optional)}.
   * opts = {units: 'metric'|'imperial'}.
   *
   * Returns { state (new), snapped, alongM, crossTrack, stepIndex, nextStep,
   *           distToNext, remainingM, remainingS, announce: null|{band,text},
   *           offRoute, arrived }.
   * `announce` fires each band at most once per maneuver, highest band wins
   * (a fast approach that jumps straight to 'now' skips the earlier lines).
   */
  function guidanceUpdate(state, route, fix, opts) {
    opts = opts || {};
    var units = opts.units || 'metric';
    var speed = typeof fix.speed === 'number' && isFinite(fix.speed) && fix.speed >= 0
      ? state.speed * 0.6 + fix.speed * 0.4 : state.speed;

    var snap = snapToRoute(route, fix, state.segIndex);
    var alongM = snap.alongM;

    // --- off-route hysteresis ---
    var offCount = snap.crossTrack > OFF_ROUTE_M ? state.offCount + 1 : 0;
    var offRoute = offCount >= OFF_ROUTE_FIXES;

    // --- which maneuver is next? steps[i].alongM passed ⇒ step i is current ---
    var steps = route.steps, stepIndex = state.stepIndex;
    // never move backwards (GPS jitter); advance while we've passed the next maneuver
    while (stepIndex + 1 < steps.length && alongM >= steps[stepIndex + 1].alongM - 2) stepIndex++;
    var nextIdx = Math.min(stepIndex + 1, steps.length - 1);
    var nextStep = steps[nextIdx];
    var distToNext = Math.max(0, nextStep.alongM - alongM);

    // --- arrival ---
    var arrived = state.arrived ||
      (route.totalM - alongM <= Math.max(ARRIVE_M, speed * 2) && snap.crossTrack <= OFF_ROUTE_M);

    // --- announcements (skip when off route or already arrived) ---
    var announce = null;
    var spoken = state.spoken;
    if (!offRoute && !arrived && nextIdx > stepIndex) {
      var bands = announceBands(speed);
      var band = distToNext <= bands.now ? 'now'
               : distToNext <= bands.soon ? 'soon'
               : distToNext <= bands.prepare ? 'prepare' : null;
      // the final "You have arrived" line belongs to the arrival event below,
      // so the arrive step only gets its look-ahead bands ("you will arrive")
      if (nextStep.type === 'arrive' && band === 'now') band = null;
      var already = spoken[nextIdx] || 0;
      if (band && BAND_RANK[band] > already) {
        spoken = Object.assign({}, spoken);
        spoken[nextIdx] = BAND_RANK[band];
        announce = { band: band, text: voiceLine(nextStep, band, units, steps[nextIdx + 1], distToNext) };
      }
    }
    if (arrived && !state.arrived) {
      announce = { band: 'now', text: steps[steps.length - 1].instruction };
    }

    var rem = remaining(route, alongM);
    return {
      state: { segIndex: snap.index, stepIndex: stepIndex, spoken: spoken, offCount: offCount,
               offRoute: offRoute, arrived: arrived, speed: speed },
      snapped: snap.point, alongM: alongM, crossTrack: snap.crossTrack,
      stepIndex: stepIndex, nextStep: nextStep, distToNext: distToNext,
      remainingM: rem.distM, remainingS: rem.durS,
      announce: announce, offRoute: offRoute, arrived: arrived,
    };
  }

  /** The spoken line for a band. 'now' chains the following maneuver when
   *  it's hard on this one's heels ("Turn left, then turn right"). */
  function voiceLine(step, band, units, followingStep, distToNext) {
    var core = step.instruction;
    if (band === 'now') {
      var line = core;
      if (followingStep && followingStep.type !== 'arrive' && step.distM <= 220) {
        line += ', then ' + lowerFirst(followingStep.instruction);
      }
      return line;
    }
    if (step.type === 'arrive') {
      var side = step.modifier === 'left' ? ', on the left' : step.modifier === 'right' ? ', on the right' : '';
      return 'In ' + speakDist(distToNext, units) + ', you will arrive at your destination' + side;
    }
    return 'In ' + speakDist(distToNext, units) + ', ' + lowerFirst(core);
  }
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

  /* ============================== simulator =============================== */

  /**
   * Deterministic demo driver: advance `dtS` seconds along the route at
   * `speedMS` (eases down for the last 60 m). state = {alongM}.
   * → {lat, lon, heading, alongM, speed, done}
   */
  function simulateTick(route, state, dtS, speedMS) {
    var v = Math.max(0.5, speedMS || 12);
    var left = route.totalM - state.alongM;
    if (left < 60) v = Math.max(2, v * left / 60); // brake for arrival
    var alongM = Math.min(route.totalM, state.alongM + v * dtS);
    var p = pointAtAlong(route, alongM);
    return { lat: p.lat, lon: p.lon, heading: p.heading, alongM: alongM, speed: v, done: alongM >= route.totalM };
  }

  /* ============================ sun-glare forecast ========================= */
  // No other satnav warns you about this: compute where the sun will be for
  // each stretch of the route *at the moment you'll drive it*, and flag the
  // stretches where you'll be driving into a low sun. Standard low-precision
  // solar ephemeris (NOAA/Meeus form, ~0.01° — vastly better than needed).

  function norm360(x) { return ((x % 360) + 360) % 360; }

  /** Sun {azimuth (° from north, clockwise), elevation (°)} at ms/lat/lon. */
  function sunPosition(ms, lat, lon) {
    var d = ms / 86400000 - 10957.5;                       // days since J2000.0
    var g = norm360(357.529 + 0.98560028 * d) * DEG;       // mean anomaly
    var q = norm360(280.459 + 0.98564736 * d);             // mean longitude
    var L = norm360(q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    var e = (23.439 - 0.00000036 * d) * DEG;               // obliquity
    var RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    var dec = Math.asin(Math.sin(e) * Math.sin(L));
    var gmst = 18.697374558 + 24.06570982441908 * d;       // sidereal, hours
    var H = norm360(gmst * 15 + lon) * DEG - RA;           // hour angle
    var la = lat * DEG;
    var elev = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
    var az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(la) - Math.tan(dec) * Math.cos(la));
    return { azimuth: norm360(az / DEG + 180), elevation: elev / DEG };
  }

  /** Seconds of driving needed to reach `alongM` (inverse of remaining()). */
  function timeAtAlong(route, alongM) {
    return Math.max(0, route.totalS - remaining(route, alongM).durS);
  }

  var GLARE_MAX_ELEV = 22, GLARE_MIN_ELEV = -1, GLARE_CONE = 28;

  /**
   * Stretches of the route where the driver faces a low sun, given a departure
   * time. → [{startM, endM, durS}] (merged consecutive segments).
   */
  function glareSegments(route, departMs) {
    var g = route.geometry, cum = route.cum, out = [], open = null;
    for (var i = 0; i < g.length - 1; i++) {
      var heading = bearing(g[i], g[i + 1]);
      var t = departMs + timeAtAlong(route, cum[i]) * 1000;
      var sun = sunPosition(t, g[i].lat, g[i].lon);
      var glare = sun.elevation > GLARE_MIN_ELEV && sun.elevation < GLARE_MAX_ELEV &&
                  Math.abs(angleDiff(heading, sun.azimuth)) < GLARE_CONE;
      if (glare) {
        if (!open) open = { startM: cum[i], endM: cum[i + 1] };
        else open.endM = cum[i + 1];
      } else if (open) { out.push(open); open = null; }
    }
    if (open) out.push(open);
    out.forEach(function (s) {
      s.durS = Math.max(0, timeAtAlong(route, s.endM) - timeAtAlong(route, s.startM));
    });
    return out;
  }

  /* =========================== co-driver pace notes ======================== */
  // Rally co-drivers grade corners 1 (hairpin) … 6 (barely a kink). Atlas
  // reads the grades straight off the route geometry, so any road becomes a
  // stage: "left 4", "right 2 into left 3". Pure curvature analysis.

  var NOTE_GRADES = [ // [min total angle °, grade]
    [110, 1], [85, 2], [60, 3], [40, 4], [25, 5], [12, 6],
  ];

  /** [{alongM, side, grade, angleDeg}] — corners graded rally-style. */
  function paceNotes(route) {
    var g = route.geometry, cum = route.cum, raw = [];
    for (var i = 1; i < g.length - 1; i++) {
      var a = angleDiff(bearing(g[i - 1], g[i]), bearing(g[i], g[i + 1]));
      if (Math.abs(a) < 4) continue;
      raw.push({ alongM: cum[i], angle: a });
    }
    // merge same-direction bends closer than 30 m into one corner
    var merged = [];
    raw.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && (r.angle > 0) === (last.angle > 0) && r.alongM - last.endM < 30) {
        last.angle += r.angle; last.endM = r.alongM;
      } else merged.push({ alongM: r.alongM, endM: r.alongM, angle: r.angle });
    });
    var notes = [];
    merged.forEach(function (m) {
      var abs = Math.abs(m.angle);
      for (var k = 0; k < NOTE_GRADES.length; k++) {
        if (abs >= NOTE_GRADES[k][0]) {
          notes.push({ alongM: m.alongM, side: m.angle > 0 ? 'right' : 'left',
                       grade: NOTE_GRADES[k][1], angleDeg: Math.round(abs) });
          break;
        }
      }
    });
    return notes;
  }

  /** "left 4" — or "left 4 into right 3" when the next corner crowds in. */
  function paceNoteLine(note, nextNote) {
    var line = note.side + ' ' + note.grade;
    if (nextNote && nextNote.alongM - note.alongM < 120) {
      line += ' into ' + nextNote.side + ' ' + nextNote.grade;
    }
    return line;
  }

  /* ========================= ghost mode (dead reckoning) =================== */

  /** GPS gone (tunnel, canyon)? Keep the car moving along the route at its
   *  last known speed. → a synthetic fix {lat, lon, heading, speed, ghost}. */
  function ghostAdvance(route, alongM, speedMS, dtS) {
    var m = Math.min(route.totalM, alongM + Math.max(0, speedMS) * dtS);
    var p = pointAtAlong(route, m);
    return { lat: p.lat, lon: p.lon, heading: p.heading, speed: speedMS, alongM: m, ghost: true };
  }

  /* ========================= flight recorder + GPX ========================= */

  var TRACK_MIN_STEP_M = 6, TRACK_SOFT_CAP = 18000, TRACK_COARSE_STEP_M = 25;

  /** A fresh on-device drive recording. */
  function newTrack(nowMs) { return { startedAt: nowMs, points: [] }; }

  /** Append a fix (thinned: ≥6 m apart, coarser once the track is huge). */
  function trackAdd(track, fix, nowMs) {
    var pts = track.points, last = pts[pts.length - 1];
    var minStep = pts.length >= TRACK_SOFT_CAP ? TRACK_COARSE_STEP_M : TRACK_MIN_STEP_M;
    if (last && haversine(last, fix) < minStep) return false;
    pts.push({ lat: fix.lat, lon: fix.lon, t: nowMs,
               v: typeof fix.speed === 'number' && isFinite(fix.speed) ? fix.speed : null });
    return true;
  }

  /** Honest drive stats: distance, moving vs total time, avg/max speed, stops. */
  function trackStats(track, nowMs) {
    var pts = track.points;
    var distM = 0, movingS = 0, maxV = 0, stops = 0, inStop = false;
    for (var i = 1; i < pts.length; i++) {
      var d = haversine(pts[i - 1], pts[i]);
      var dt = Math.max(0.001, (pts[i].t - pts[i - 1].t) / 1000);
      var v = d / dt;
      distM += d;
      if (v > 0.8) { movingS += dt; inStop = false; }
      else if (!inStop) { stops++; inStop = true; }
      maxV = Math.max(maxV, pts[i].v != null ? pts[i].v : v);
    }
    var totalS = pts.length ? Math.max(0, ((nowMs || pts[pts.length - 1].t) - track.startedAt) / 1000) : 0;
    return { distM: distM, movingS: movingS, totalS: totalS,
             avgKmh: movingS > 0 ? (distM / movingS) * 3.6 : 0, maxKmh: maxV * 3.6, stops: stops };
  }

  /** A real GPX 1.1 document for the recorded drive — opens in any GPS app. */
  function trackToGPX(track, name) {
    var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var out = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Atlas" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      '<trk><name>' + esc(name || 'Atlas drive') + '</name><trkseg>\n';
    track.points.forEach(function (p) {
      out += '<trkpt lat="' + p.lat.toFixed(6) + '" lon="' + p.lon.toFixed(6) + '">' +
             '<time>' + new Date(p.t).toISOString() + '</time></trkpt>\n';
    });
    return out + '</trkseg></trk>\n</gpx>\n';
  }

  /* ============================== trail-back =============================== */

  /**
   * Turn a recorded track into a guidance route that retraces it backwards —
   * navigation home with no routing server and no network. Turn steps are
   * synthesised from the geometry's own corners.
   */
  function routeBack(points, speedMS) {
    var v = Math.max(0.5, speedMS || 1.4);
    var geometry = [];
    for (var i = points.length - 1; i >= 0; i--) {
      var p = { lat: points[i].lat, lon: points[i].lon };
      var last = geometry[geometry.length - 1];
      if (!last || haversine(last, p) >= 3) geometry.push(p);
    }
    if (geometry.length < 2) throw new Error('track too short to trace back');
    var cum = [0];
    for (var j = 1; j < geometry.length; j++) cum.push(cum[j - 1] + haversine(geometry[j - 1], geometry[j]));
    var totalM = cum[cum.length - 1];
    var route = { geometry: geometry, cum: cum, totalM: totalM, totalS: totalM / v, steps: [] };
    var steps = [{ type: 'depart', modifier: '', exit: 0,
                   bearingAfter: bearing(geometry[0], geometry[1]), name: '', alongM: 0 }];
    paceNotes(route).forEach(function (n) {
      if (n.grade > 4) return; // only real turns become instructions
      steps.push({ type: 'turn', modifier: n.grade === 1 ? 'sharp ' + n.side : n.side,
                   exit: 0, bearingAfter: 0, name: '', alongM: n.alongM });
    });
    steps.push({ type: 'arrive', modifier: '', exit: 0, bearingAfter: 0, name: '', alongM: totalM });
    for (var k = 0; k < steps.length; k++) {
      var end = k + 1 < steps.length ? steps[k + 1].alongM : totalM;
      steps[k].distM = Math.max(0, end - steps[k].alongM);
      steps[k].durS = steps[k].distM / v;
      steps[k].instruction = instructionText(steps[k]);
      steps[k].icon = maneuverIcon(steps[k].type, steps[k].modifier);
    }
    route.steps = steps;
    return route;
  }

  /* ================================ dashcam ================================ */
  // The camera work is browser API, but everything deterministic about the
  // dashcam lives here: the telemetry lines burned into each frame, the
  // filename a clip saves under, and the honest storage estimate.

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** "2026-07-26 22:13:45" in the viewer's local time — the frame stamp. */
  function fmtTimestamp(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
           pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /**
   * The telemetry block burned into each dashcam frame.
   * info = {timeStr, lat, lon, speedMS, units, instruction?, distToNextM?}
   * → array of strings (top line first).
   */
  function dashcamLines(info) {
    var shown = info.units === 'imperial' ? info.speedMS * 2.23694 : info.speedMS * 3.6;
    var unit = info.units === 'imperial' ? 'mph' : 'km/h';
    var lines = [
      info.timeStr + '  ·  ' + Math.round(Math.max(0, shown)) + ' ' + unit,
      info.lat.toFixed(5) + ', ' + info.lon.toFixed(5),
    ];
    if (info.instruction) {
      lines.push('Next: ' + info.instruction +
        (typeof info.distToNextM === 'number' ? ' — ' + fmtDist(info.distToNextM, info.units) : ''));
    }
    return lines;
  }

  /** "atlas-dashcam-20260726-2213-trafalgar-square.webm" — UTC, slugged. */
  function dashcamFilename(ms, destName) {
    var d = new Date(ms);
    var stamp = '' + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
                '-' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
    var slug = (destName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
               .replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
    return 'atlas-dashcam-' + stamp + (slug ? '-' + slug : '') + '.webm';
  }

  /** Honest storage estimate in MB for a recording (default ~2.5 Mbps). */
  function recordingEstimateMB(durS, kbps) {
    var mb = Math.max(0, durS) * (kbps || 2500) / 8 / 1000;
    return Math.round(mb * 10) / 10;
  }

  /** "500 B" / "255 KB" / "1.2 MB" / "2.5 GB" — decimal units. */
  function fmtBytes(n) {
    n = Math.max(0, n || 0);
    if (n < 1000) return Math.round(n) + ' B';
    if (n < 1e6) return Math.round(n / 1e3) + ' KB';
    if (n < 1e9) return (Math.round(n / 1e5) / 10).toFixed(1) + ' MB';
    return (Math.round(n / 1e8) / 10).toFixed(1) + ' GB';
  }

  /**
   * Which stored clips to delete so the vault respects its limits. Newest
   * clips win; the single newest clip is always kept, whatever its size.
   * clips = [{id, t, size}] → array of ids to delete (oldest casualties).
   */
  function pruneClips(clips, limits) {
    var maxCount = (limits && limits.maxCount) || 12;
    var maxBytes = (limits && limits.maxBytes) || 800e6;
    var sorted = clips.slice().sort(function (a, b) { return b.t - a.t || (b.id > a.id ? 1 : -1); });
    var bytes = 0, drop = [];
    for (var i = 0; i < sorted.length; i++) {
      bytes += sorted[i].size || 0;
      if (i === 0) continue; // the newest clip always survives
      if (i >= maxCount || bytes > maxBytes) drop.push(sorted[i].id);
    }
    return drop;
  }

  /* ====================== speed limits & speed cameras ===================== */
  // OpenStreetMap knows the legal limit of most roads (maxspeed=*) and the
  // position of fixed speed cameras (highway=speed_camera). The UI fetches
  // the raw data; everything decidable lives here: parsing OSM limit values,
  // matching ways/cameras onto the route line, and the warning state machines.
  // Honesty note: warnings are only as good as the map data — obey signage.

  /** OSM maxspeed value → km/h, or null when unknown/unlimited/uncoded. */
  function parseMaxspeed(v) {
    if (v == null) return null;
    v = String(v).trim().toLowerCase();
    if (!v || v === 'none' || v === 'signals' || v === 'variable' || v === 'default') return null;
    if (v === 'walk') return 10;
    var m = /^(\d+(?:\.\d+)?)\s*mph$/.exec(v);
    if (m) return Math.round(parseFloat(m[1]) * 1.609344 * 10) / 10;
    m = /^(\d+(?:\.\d+)?)(?:\s*km\/h)?$/.exec(v);
    if (m) return parseFloat(m[1]);
    return null;
  }

  var LIMIT_SNAP_M = 30, LIMIT_PARALLEL_DEG = 40;

  /**
   * Match speed-limit ways onto the route: for each route vertex, the nearest
   * way segment within 30 m that runs roughly parallel to the road wins; runs
   * of the same limit merge into segments. ways = [{kmh, geometry:[{lat,lon}]}]
   * → [{startM, endM, kmh}] sorted along the route.
   */
  function mapLimitsToRoute(route, ways) {
    var g = route.geometry, cum = route.cum;
    var segs = [];
    ways.forEach(function (w) {
      if (w.kmh == null || !w.geometry || w.geometry.length < 2) return;
      for (var i = 0; i < w.geometry.length - 1; i++) {
        var a = w.geometry[i], b = w.geometry[i + 1];
        segs.push({ a: a, b: b, kmh: w.kmh, brg: bearing(a, b),
          minLat: Math.min(a.lat, b.lat), maxLat: Math.max(a.lat, b.lat),
          minLon: Math.min(a.lon, b.lon), maxLon: Math.max(a.lon, b.lon) });
      }
    });
    var padLat = 0.0005, padLon = 0.001; // ~55 m gate before exact maths
    var limitAt = [];
    for (var vi = 0; vi < g.length; vi++) {
      var p = g[vi];
      var heading = vi < g.length - 1 ? bearing(p, g[vi + 1]) : bearing(g[vi - 1], p);
      var best = null, bestD = LIMIT_SNAP_M;
      for (var si = 0; si < segs.length; si++) {
        var s = segs[si];
        if (p.lat < s.minLat - padLat || p.lat > s.maxLat + padLat ||
            p.lon < s.minLon - padLon || p.lon > s.maxLon + padLon) continue;
        var dd = Math.abs(angleDiff(heading, s.brg));
        if (dd > LIMIT_PARALLEL_DEG && dd < 180 - LIMIT_PARALLEL_DEG) continue; // crossing road
        var pr = projectOnSegment(p, s.a, s.b);
        if (pr.dist < bestD) { bestD = pr.dist; best = s.kmh; }
      }
      limitAt.push(best);
    }
    var out = [], open = null;
    for (var i2 = 0; i2 < limitAt.length; i2++) {
      var k = limitAt[i2], end = cum[Math.min(i2 + 1, cum.length - 1)];
      if (open && open.kmh === k) { open.endM = end; continue; }
      if (open) out.push(open);
      open = k != null ? { startM: cum[i2], endM: end, kmh: k } : null;
    }
    if (open) out.push(open);
    return out;
  }

  /** The limit in force at `alongM`, or null where the map is silent. */
  function limitAtAlong(segments, alongM) {
    for (var i = 0; i < segments.length; i++) {
      if (alongM >= segments[i].startM - 1 && alongM <= segments[i].endM + 1) return segments[i].kmh;
    }
    return null;
  }

  /**
   * Snap camera points onto the route (≤45 m off the line counts — cameras
   * stand on the verge), dedupe within 30 m. cams = [{lat, lon, kmh?}]
   * → [{alongM, lat, lon, kmh}] sorted along the route.
   */
  function mapCamerasToRoute(route, cams, maxDistM) {
    var max = maxDistM || 45;
    var out = [];
    cams.forEach(function (c) {
      var s = snapToRoute(route, c);
      if (s.crossTrack <= max) out.push({ alongM: s.alongM, lat: c.lat, lon: c.lon, kmh: c.kmh == null ? null : c.kmh, avg: !!c.avg });
    });
    out.sort(function (a, b) { return a.alongM - b.alongM; });
    return out.filter(function (c, i) { return i === 0 || c.alongM - out[i - 1].alongM > 30; });
  }

  /** The next camera at/after `alongM` (15 m of grace behind you). */
  function cameraNext(cameras, alongM) {
    for (var i = 0; i < cameras.length; i++) {
      if (cameras[i].alongM > alongM - 15) return { cam: cameras[i], distM: Math.max(0, cameras[i].alongM - alongM) };
    }
    return null;
  }

  /* -------- average speed camera zones (SPECS-style enforcement) -------- */
  // In these zones the law measures your AVERAGE between camera pairs, not
  // your instantaneous speed — so Atlas does too. Zones come from OSM two
  // ways: enforcement relations with from/to endpoints, and chains of
  // cameras tagged average (consecutive pairs become zones, like the
  // commercial satnavs infer them).

  var AVG_PAIR_MIN_M = 120, AVG_PAIR_MAX_M = 8000;

  function mergeZones(zones) {
    zones.sort(function (a, b) { return a.startM - b.startM; });
    var out = [];
    zones.forEach(function (z) {
      var last = out[out.length - 1];
      if (last && z.startM <= last.endM + 30) {
        last.endM = Math.max(last.endM, z.endM);
        if (z.kmh != null && (last.kmh == null || z.kmh < last.kmh)) last.kmh = z.kmh;
      } else out.push({ startM: z.startM, endM: z.endM, kmh: z.kmh == null ? null : z.kmh });
    });
    return out;
  }

  /** Chain consecutive average-tagged cameras on the route into zones.
   *  cams = mapped cameras [{alongM, kmh, avg}]; limits fill a missing kmh. */
  function pairAvgCameras(cams, limits) {
    var avg = (cams || []).filter(function (c) { return c.avg; })
      .sort(function (a, b) { return a.alongM - b.alongM; });
    var zones = [];
    for (var i = 0; i + 1 < avg.length; i++) {
      var a = avg[i], b = avg[i + 1], gap = b.alongM - a.alongM;
      if (gap < AVG_PAIR_MIN_M || gap > AVG_PAIR_MAX_M) continue;
      var kmh = a.kmh != null ? a.kmh : b.kmh != null ? b.kmh
              : limits ? limitAtAlong(limits, (a.alongM + b.alongM) / 2) : null;
      zones.push({ startM: a.alongM, endM: b.alongM, kmh: kmh });
    }
    return mergeZones(zones);
  }

  /** An enforcement relation's from/to endpoints snapped onto the route.
   *  → {startM, endM, kmh} or null when it doesn't lie on this route. */
  function zoneFromEndpoints(route, from, to, kmh, tolM) {
    var tol = tolM || 60;
    var s1 = snapToRoute(route, from), s2 = snapToRoute(route, to);
    if (s1.crossTrack > tol || s2.crossTrack > tol) return null;
    var a = Math.min(s1.alongM, s2.alongM), b = Math.max(s1.alongM, s2.alongM);
    if (b - a < AVG_PAIR_MIN_M) return null;
    return { startM: a, endM: b, kmh: kmh == null ? null : kmh };
  }

  /**
   * The zone state machine, driven per fix. Your zone average is distance
   * covered inside the zone over time inside it — exactly what the cameras
   * compute. Events: 'enter' | 'over' (once, re-armed when you drop back
   * under the limit) | 'exit' (carries your final average).
   * → {state, event, zone, avgKmh}
   */
  function avgZoneUpdate(state, zones, alongM, nowMs) {
    state = state || { idx: -1, startM: 0, startT: 0, warned: false };
    var idx = -1;
    for (var i = 0; i < (zones || []).length; i++) {
      if (alongM >= zones[i].startM - 5 && alongM <= zones[i].endM + 5) { idx = i; break; }
    }
    if (idx !== state.idx) {
      if (state.idx >= 0) { // leaving a zone (possibly straight into another)
        var z0 = zones[state.idx];
        var elapsed = (nowMs - state.startT) / 1000;
        var finalAvg = elapsed > 1 ? ((Math.min(alongM, z0.endM) - state.startM) / elapsed) * 3.6 : null;
        return { state: { idx: -1, startM: 0, startT: 0, warned: false },
                 event: 'exit', zone: z0, avgKmh: finalAvg != null && finalAvg >= 0 ? finalAvg : null };
      }
      return { state: { idx: idx, startM: alongM, startT: nowMs, warned: false },
               event: 'enter', zone: zones[idx], avgKmh: null };
    }
    if (idx < 0) return { state: state, event: null, zone: null, avgKmh: null };
    var z = zones[idx];
    var dist = alongM - state.startM, secs = (nowMs - state.startT) / 1000;
    var avg = secs > 3 && dist > 30 ? (dist / secs) * 3.6 : null;
    var next = state, event = null;
    if (avg != null && z.kmh != null) {
      if (avg > z.kmh * 1.03 + 1 && !state.warned) {
        next = { idx: state.idx, startM: state.startM, startT: state.startT, warned: true };
        event = 'over';
      } else if (avg <= z.kmh && state.warned) {
        next = { idx: state.idx, startM: state.startM, startT: state.startT, warned: false };
      }
    }
    return { state: next, event: event, zone: z, avgKmh: avg };
  }

  /**
   * Overspeed state machine with hysteresis: 5 % + 1 km/h of tolerance, and
   * you must stay over it for 3 s before the (single) spoken warning — GPS
   * blips never nag. `over` is the immediate visual state.
   * → {state, over, warn}
   */
  function overspeedUpdate(state, speedKmh, limitKmh, dtS, bufferKmh) {
    state = state || { overS: 0, warned: false };
    if (limitKmh == null) return { state: { overS: 0, warned: false }, over: false, warn: false };
    var tol = limitKmh * 1.05 + 1 + (typeof bufferKmh === 'number' && bufferKmh > 0 ? bufferKmh : 0);
    if (speedKmh <= tol) {
      return { state: { overS: 0, warned: false }, over: speedKmh > limitKmh + 0.5, warn: false };
    }
    var overS = state.overS + Math.max(0, dtS || 0);
    var warn = !state.warned && overS >= 3;
    return { state: { overS: overS, warned: state.warned || warn }, over: true, warn: warn };
  }

  /* ============================ personal pace ============================== */
  // Routers predict an average driver. Atlas learns the ratio between *your*
  // drives and the prediction (EMA, clamped) and scales future ETAs by it —
  // an ETA that converges on the truth about you.

  function updatePace(pace, predictedS, actualS) {
    if (!(predictedS > 60) || !(actualS > 60)) return pace || 1; // too short to learn from
    var ratio = Math.max(0.5, Math.min(2, actualS / predictedS));
    var next = (pace || 1) * 0.7 + ratio * 0.3;
    return Math.round(Math.max(0.6, Math.min(1.6, next)) * 1000) / 1000;
  }

  /* ========================== Pro + drive history ========================= */
  // The business layer, engine-grade like everything else: offline-verifiable
  // unlock codes (sellable through any payment link — no server needed to
  // redeem), the free/Pro entitlement table, and drive-history stats.

  var PRO_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function proChecksum(body) {
    var h = 7;
    for (var i = 0; i < body.length; i++) h = (h * 33 + body.charCodeAt(i) * (i + 3)) % 923521;
    return PRO_ALPHABET[h % 31] + PRO_ALPHABET[Math.floor(h / 31) % 31];
  }

  /** "ATLS-XXXX-XXXX-CC" — deterministic with an injected rand. */
  function makeProCode(rand) {
    rand = rand || Math.random;
    var body = '';
    for (var i = 0; i < 8; i++) body += PRO_ALPHABET[Math.floor(rand() * 31) % 31];
    return 'ATLS-' + body.slice(0, 4) + '-' + body.slice(4) + '-' + proChecksum(body);
  }

  /** Normalise + verify an unlock code offline. → true/false. */
  function validProCode(code) {
    if (typeof code !== 'string') return false;
    var s = code.toUpperCase().replace(/[\s-]/g, '');
    if (s.length !== 14 || s.slice(0, 4) !== 'ATLS') return false;
    var body = s.slice(4, 12), check = s.slice(12);
    for (var i = 0; i < body.length; i++) if (PRO_ALPHABET.indexOf(body[i]) < 0) return false;
    return proChecksum(body) === check;
  }

  /** What each tier gets. One table, no scattered magic numbers. */
  function entitlements(pro) {
    return pro
      ? { clips: 30, offlinePacks: 6, proBadge: true }
      : { clips: 12, offlinePacks: 1, proBadge: false };
  }

  /**
   * Lifetime driving stats from the drive log (records saved on arrival:
   * {t, distM, movingS}). `now` injected for the this-week window.
   */
  function driveStatsSummary(drives, now) {
    var s = { count: 0, distM: 0, movingS: 0, avgKmh: 0, longestM: 0, weekCount: 0, weekDistM: 0 };
    (drives || []).forEach(function (d) {
      if (!d || typeof d.distM !== 'number') return;
      s.count++;
      s.distM += d.distM;
      s.movingS += d.movingS || 0;
      if (d.distM > s.longestM) s.longestM = d.distM;
      if (now - d.t < 7 * 86400000) { s.weekCount++; s.weekDistM += d.distM; }
    });
    s.avgKmh = s.movingS > 0 ? (s.distM / s.movingS) * 3.6 : 0;
    return s;
  }

  /* ============================== music player ============================ */
  // Drive-time music from the user's own files. The pure parts live here:
  // a from-scratch ID3v2 tag reader (title/artist/album from an MP3's first
  // bytes), deterministic shuffle, and the queue-advance state machine.

  function id3Text(enc, bytes) {
    var i, out = '';
    if (enc === 0) { // ISO-8859-1
      for (i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
      return out;
    }
    if (enc === 3) { // UTF-8
      i = 0;
      while (i < bytes.length) {
        var b = bytes[i];
        if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
        else if (b < 0xe0) { out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
        else if (b < 0xf0) { out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
        else { // astral → surrogate pair
          var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
          cp -= 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
          i += 4;
        }
      }
      return out;
    }
    // UTF-16: enc 1 has a BOM, enc 2 is big-endian without one
    var le = enc === 1 && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
    var start = enc === 1 && bytes.length >= 2 && (bytes[0] === 0xff || bytes[0] === 0xfe) ? 2 : 0;
    for (i = start; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(le ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }

  /** Read title/artist/album from an MP3's leading bytes (ID3v2.3/2.4).
   *  → {title?, artist?, album?} or null when there is no usable tag. */
  function parseID3(bytes) {
    if (!bytes || bytes.length < 10) return null;
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null; // "ID3"
    var ver = bytes[3];
    if (ver < 3 || ver > 4) return null;
    var size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    var end = Math.min(bytes.length, 10 + size);
    var pos = 10;
    if (bytes[5] & 0x40) { // extended header — skip it
      var ext = ver === 4
        ? ((bytes[pos] & 0x7f) << 21) | ((bytes[pos + 1] & 0x7f) << 14) | ((bytes[pos + 2] & 0x7f) << 7) | (bytes[pos + 3] & 0x7f)
        : ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) + 4;
      pos += ext;
    }
    var MAP = { TIT2: 'title', TPE1: 'artist', TALB: 'album' };
    var out = {};
    while (pos + 10 <= end) {
      var id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      var fsz = ver === 4
        ? ((bytes[pos + 4] & 0x7f) << 21) | ((bytes[pos + 5] & 0x7f) << 14) | ((bytes[pos + 6] & 0x7f) << 7) | (bytes[pos + 7] & 0x7f)
        : (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7];
      pos += 10;
      if (fsz <= 0 || pos + fsz > end) break;
      var key = MAP[id];
      if (key && !out[key]) {
        out[key] = id3Text(bytes[pos], bytes.subarray(pos + 1, pos + fsz)).replace(/ +$/g, '').trim();
      }
      pos += fsz;
    }
    return (out.title || out.artist || out.album) ? out : null;
  }

  /** Fisher–Yates with an injected rand — a full deterministic permutation. */
  function makeShuffleOrder(n, rand) {
    rand = rand || Math.random;
    var order = [];
    for (var i = 0; i < n; i++) order.push(i);
    for (var j = n - 1; j > 0; j--) {
      var k = Math.floor(rand() * (j + 1)) % (j + 1);
      var t = order[j]; order[j] = order[k]; order[k] = t;
    }
    return order;
  }

  /**
   * Which track plays next. state = {idx, count, repeat: 'off'|'all'|'one',
   * shuffle: order[]|null, dir: 1|-1, ended: bool (track finished naturally)}.
   * → next index, or null to stop (end of queue, repeat off).
   */
  function nextTrack(state) {
    if (!state || !state.count) return null;
    if (state.repeat === 'one' && state.ended) return state.idx;
    var pos = state.shuffle ? state.shuffle.indexOf(state.idx) : state.idx;
    if (pos < 0) pos = 0;
    var npos = pos + (state.dir || 1);
    if (npos >= state.count) {
      if (state.repeat !== 'all') return null;
      npos = 0;
    }
    if (npos < 0) npos = state.count - 1;
    return state.shuffle ? state.shuffle[npos] : npos;
  }

  /** "3:45" | "1:02:03" for a track position/length in seconds. */
  function fmtTrackTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = (h && m < 10 ? '0' : '') + m, ss = (sec < 10 ? '0' : '') + sec;
    return (h ? h + ':' : '') + mm + ':' + ss;
  }

  /* ============================= offline packs ============================ */
  // Which tiles cover a route's corridor, per zoom — the shopping list for
  // an offline download. Highest zooms first (navigation needs them most),
  // deduped, honestly capped with a truncation flag.

  function corridorTiles(route, opts) {
    opts = opts || {};
    var minZ = opts.minZ || 12, maxZ = opts.maxZ || 17;
    var bufferM = opts.bufferM || 260, cap = opts.cap || 1200;
    var seen = {}, out = [], truncated = false;
    for (var z = maxZ; z >= minZ && !truncated; z--) {
      var mpp = metresPerPixel(route.geometry[0].lat, z);
      var tileM = mpp * TILE;
      var step = Math.max(60, tileM / 3);
      var r = Math.min(2, Math.round(bufferM / tileM));
      var n = Math.pow(2, z);
      for (var m = 0; m <= route.totalM && !truncated; m += step) {
        var w = lonLatToWorld(pointAtAlong(route, m), z);
        var t = tileForWorld(w, z);
        for (var dx = -r; dx <= r; dx++) {
          for (var dy = -r; dy <= r; dy++) {
            var ty = t.ty + dy;
            if (ty < 0 || ty >= n) continue;
            var tx = (((t.tx + dx) % n) + n) % n;
            var key = z + '/' + tx + '/' + ty;
            if (seen[key]) continue;
            seen[key] = 1;
            if (out.length >= cap) { truncated = true; break; }
            out.push({ z: z, x: tx, y: ty });
          }
          if (truncated) break;
        }
      }
    }
    return { tiles: out, truncated: truncated };
  }

  /** Honest size estimate for a pack: tiles × styles × ~30 KB. → MB */
  function packEstimateMB(tileCount, stylesCount, avgKB) {
    return Math.round(tileCount * (stylesCount || 1) * (avgKB || 30) / 1000 * 10) / 10;
  }

  /* ============================ lane guidance ============================= */
  // OSRM steps carry OSM's turn-lane data: each maneuver's first intersection
  // lists the approach lanes with their painted arrows and whether that lane
  // works for this maneuver. We normalise it into a little model the HUD can
  // draw as a lane bar — lit lanes are yours.

  /** OSRM lane indication → our arrow-icon key. */
  function laneIconKey(dir) {
    var map = {
      'left': 'left', 'right': 'right', 'straight': 'straight', 'none': 'straight',
      'slight left': 'slight-left', 'slight right': 'slight-right',
      'sharp left': 'sharp-left', 'sharp right': 'sharp-right',
      'uturn': 'uturn', 'merge to left': 'merge-left', 'merge to right': 'merge-right',
    };
    return map[dir] || 'straight';
  }

  /**
   * Lanes for a raw OSRM step's maneuver, reading intersections[0].lanes.
   * → [{icon, dirs, on}] left-to-right, or null when the map has no lane data.
   * The icon prefers the indication that is actually valid for the maneuver.
   */
  function parseLanes(rawStep) {
    var ix = rawStep && rawStep.intersections && rawStep.intersections[0];
    var lanes = ix && ix.lanes;
    if (!lanes || !lanes.length) return null;
    var out = [];
    for (var i = 0; i < lanes.length; i++) {
      var ln = lanes[i];
      var dirs = (ln.indications && ln.indications.length ? ln.indications : ['none']).slice(0, 3);
      var pick = dirs[0];
      if (ln.valid && ln.valid_indication) pick = ln.valid_indication; // OSRM ≥5.23
      out.push({ icon: laneIconKey(pick), dirs: dirs, on: !!ln.valid });
    }
    return out;
  }

  /* ============================ junction views ============================ */
  // Honest junction views: not photographs — auto-generated schematics. The
  // UI fetches the real surrounding roads once per complex maneuver; the
  // maths here projects everything into a local frame centred on the
  // junction and rotated so you always approach from the bottom.

  /** Steps that deserve a junction view. → array of step indexes. */
  function junctionCandidates(steps) {
    var out = [];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (s.type === 'roundabout' || s.type === 'rotary' || s.type === 'fork' ||
          s.type === 'end of road' || /^sharp/.test(s.modifier || '')) out.push(i);
    }
    return out;
  }

  /**
   * Project the scene around a maneuver into a local metres frame: origin at
   * the junction, +up (−y) is the direction you approach from. ways =
   * [[{lat,lon},…]]. → {roads: [[{x,y}]], path: [{x,y}], r} with everything
   * clipped to radiusM. Pure — the UI just scales and strokes it.
   */
  function buildJunctionView(route, step, ways, radiusM) {
    var r = radiusM || 120;
    var c = pointAtAlong(route, step.alongM);
    var approach = pointAtAlong(route, Math.max(0, step.alongM - 30));
    var up = bearing(approach, c) * DEG;
    var cosU = Math.cos(up), sinU = Math.sin(up);
    var kLon = 111320 * Math.cos(c.lat * DEG), kLat = 110540;
    function proj(p) {
      var ex = (p.lon - c.lon) * kLon, ny = (p.lat - c.lat) * kLat; // metres E, N
      // rotate so the approach bearing points up the screen (−y)
      return { x: ex * cosU - ny * sinU, y: -(ex * sinU + ny * cosU) };
    }
    function clipLine(pts) {
      var segs = [], cur = [];
      for (var i = 0; i < pts.length; i++) {
        var q = proj(pts[i]);
        if (Math.hypot(q.x, q.y) <= r * 1.25) cur.push(q);
        else if (cur.length > 1) { segs.push(cur); cur = []; }
        else cur = [];
      }
      if (cur.length > 1) segs.push(cur);
      return segs;
    }
    var roads = [];
    (ways || []).forEach(function (w) { clipLine(w).forEach(function (s) { roads.push(s); }); });
    // the route's own thread through the junction
    var pathPts = [];
    for (var m = Math.max(0, step.alongM - r); m <= Math.min(route.totalM, step.alongM + r); m += 8) {
      pathPts.push(pointAtAlong(route, m));
    }
    var path = clipLine(pathPts)[0] || [];
    return { roads: roads, path: path, r: r };
  }

  /* ============================= 3D buildings ============================= */
  // True extruded buildings on the 2D canvas, the classic 2.5D way: every
  // footprint corner gets a roof point pushed away from the camera by an
  // amount that grows with the building's height and the zoom — walls are
  // quads between ground and roof edges, shaded by a fixed NW light. The
  // maths is here (testable); the UI fetches OSM footprints and paints.

  /** Building height in metres from OSM tags: height= wins, else levels×3,
   *  else a modest default. Clamped [3, 150] so bad data can't go skyline. */
  function buildingHeightM(tags) {
    tags = tags || {};
    var h = parseFloat(String(tags.height || '').replace(/m$/i, '').trim());
    if (!isFinite(h)) {
      var lv = parseFloat(tags['building:levels']);
      h = isFinite(lv) ? lv * 3 : 8;
    }
    return Math.min(150, Math.max(3, h));
  }

  /**
   * How far (as a fraction of the corner's distance from the viewpoint) a
   * roof corner leans away from the camera. Perspective from a virtual
   * camera ~60 tile-widths up: taller buildings lean more, zooming out
   * flattens the city. Clamped so skyscrapers never smear across the map.
   */
  function roofFactor(heightM, lat, zoom) {
    var mpp = metresPerPixel(lat, zoom);          // ground metres per pixel
    var cameraPx = 1400;                          // virtual camera height, px
    var hPx = heightM / mpp;                      // building height in px
    return Math.min(0.22, hPx / cameraPx);
  }

  /** Wall brightness 0..1 for an edge a→b (screen coords, y down): fixed
   *  light from the NW, so north/west faces read brighter. */
  function wallShade(ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len = Math.hypot(dx, dy) || 1;
    // outward normal for counter-clockwise polygons: (dy, -dx)
    var nx = dy / len, ny = -dx / len;
    var lx = -0.6, ly = -0.8; // light direction: from NW (up-left on screen)
    var d = nx * lx + ny * ly;
    return Math.max(0, Math.min(1, 0.62 + 0.38 * d));
  }

  /* ============================= live traffic ============================= */
  // Two honest layers. (1) LIVE INCIDENTS — real disruptions (TfL's open feed
  // for London, or TomTom with a key) snapped onto the route with per-severity
  // delay estimates. (2) TYPICAL TRAFFIC — a deterministic rush-hour model
  // (clock injected) that scales ETAs the way roads actually breathe, clearly
  // labelled "typical". The UI fetches; everything decidable lives here.

  /** Delay estimate for an incident: provider's value wins, else severity
   *  1 (minor) … 4 (severe) maps to a conservative default. Seconds. */
  function incidentDelayS(sev, providedS) {
    if (typeof providedS === 'number' && isFinite(providedS) && providedS >= 0) return Math.min(3600, providedS);
    return { 1: 30, 2: 90, 3: 240, 4: 480 }[sev] || 90;
  }

  /**
   * Snap incidents onto the route. Each incident = {points:[{lat,lon}], sev,
   * kind, text, delayS?} — any of its points within `tolM` (default 50 m)
   * attaches it at that alongM. Deduped (same kind within 80 m), sorted.
   * → [{alongM, sev, kind, text, delayS}]
   */
  function mapIncidentsToRoute(route, incidents, tolM) {
    var tol = tolM || 50;
    var out = [];
    (incidents || []).forEach(function (inc) {
      var pts = inc.points || [];
      var best = null;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
        var s = snapToRoute(route, p);
        if (s.crossTrack <= tol && (!best || s.crossTrack < best.crossTrack)) {
          best = { crossTrack: s.crossTrack, alongM: s.alongM };
        }
      }
      if (best) {
        out.push({ alongM: best.alongM, sev: inc.sev || 2, kind: inc.kind || 'Incident',
                   text: inc.text || '', delayS: incidentDelayS(inc.sev || 2, inc.delayS) });
      }
    });
    out.sort(function (a, b) { return a.alongM - b.alongM; });
    return out.filter(function (x, i) {
      return i === 0 || x.alongM - out[i - 1].alongM > 80 || x.kind !== out[i - 1].kind;
    });
  }

  /**
   * Typical congestion multiplier for a local hour + day-of-week (0=Sun).
   * Weekday peaks ~08:30 (×1.30) and ~17:30 (×1.35), free-flowing nights
   * (×0.92), gentle weekend midday bump. Deterministic, bounded [0.9, 1.4].
   */
  function typicalTrafficFactor(hour, dow) {
    var h = ((hour % 24) + 24) % 24;
    var weekend = dow === 0 || dow === 6;
    if (weekend) {
      if (h >= 11 && h <= 16) return 1.1;
      if (h >= 22 || h <= 6) return 0.92;
      return 1.0;
    }
    var am = Math.exp(-Math.pow(h - 8.5, 2) / 2.2);   // morning peak bell
    var pm = Math.exp(-Math.pow(h - 17.5, 2) / 2.6);  // evening peak bell
    var f = 1.0 + 0.30 * am + 0.35 * pm;
    if (h >= 22 || h <= 5) f = 0.92;
    return Math.min(1.4, Math.max(0.9, Math.round(f * 1000) / 1000));
  }

  /** Whole-route traffic view: {durS (adjusted), delayS, factor}. */
  function trafficAdjust(route, mapped, factor) {
    var f = factor || 1;
    var delayS = (mapped || []).reduce(function (a, m) { return a + m.delayS; }, 0);
    return { durS: route.totalS * f + delayS, delayS: delayS, factor: f };
  }

  /** Remaining seconds from `alongM` including typical factor + incidents
   *  still ahead of you. */
  function remainingWithTraffic(route, alongM, mapped, factor) {
    var base = remaining(route, alongM).durS * (factor || 1);
    (mapped || []).forEach(function (m) { if (m.alongM > alongM - 15) base += m.delayS; });
    return base;
  }

  /** The next incident at/after `alongM` — same contract as cameraNext. */
  function nextIncident(mapped, alongM) {
    for (var i = 0; i < (mapped || []).length; i++) {
      if (mapped[i].alongM > alongM - 15) {
        return { inc: mapped[i], distM: Math.max(0, mapped[i].alongM - alongM) };
      }
    }
    return null;
  }

  /* ================================ convoy ================================ */
  // Road-trip mode: drivers who share a convoy code see each other live on
  // the map. Transport is the UI's job (BroadcastChannel between tabs,
  // Firestore across devices); everything decidable is here — codes,
  // deterministic avatars, beacon validation with newest-wins merging,
  // staleness pruning and the formation stats.

  var CONVOY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1

  /** A 6-char convoy code from an injected rand() (deterministic in tests). */
  function makeConvoyCode(rand) {
    rand = rand || Math.random;
    var s = '';
    for (var i = 0; i < 6; i++) {
      s += CONVOY_ALPHABET[Math.floor(rand() * CONVOY_ALPHABET.length) % CONVOY_ALPHABET.length];
    }
    return s;
  }

  /** Normalise user input to a valid code, or null. */
  function validConvoyCode(s) {
    if (typeof s !== 'string') return null;
    s = s.toUpperCase().replace(/[\s-]/g, '');
    if (s.length !== 6) return null;
    for (var i = 0; i < s.length; i++) if (CONVOY_ALPHABET.indexOf(s[i]) < 0) return null;
    return s;
  }

  /** Pull a convoy code out of a share link / hash / raw code. */
  function parseConvoyLink(s) {
    if (typeof s !== 'string') return null;
    var m = /convoy=([A-Za-z0-9-]{4,12})/.exec(s);
    if (m) return validConvoyCode(m[1]);
    return validConvoyCode(s.replace(/^#/, ''));
  }

  var CONVOY_CARS = ['🚗', '🚙', '🛻', '🚐', '🏎', '🚕', '🚓', '🚌'];
  var CONVOY_COLORS = ['#38bdf8', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#fb7185', '#4ade80', '#f97316'];

  /** Deterministic {emoji, color} for a member id — same id, same car. */
  function convoyAvatar(id) {
    var h = 5381;
    id = String(id || '');
    for (var i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
    return { emoji: CONVOY_CARS[h % CONVOY_CARS.length], color: CONVOY_COLORS[(h >>> 3) % CONVOY_COLORS.length] };
  }

  /**
   * Merge one incoming beacon into the members map. Pure and defensive:
   * malformed beacons and our own echoes are ignored, an older timestamp
   * never overwrites a newer one, names are clamped, clocks from the future
   * are pulled back. → a NEW members object (input untouched).
   */
  function applyBeacon(members, b, selfId, now) {
    if (!b || typeof b !== 'object') return members;
    if (typeof b.id !== 'string' || !b.id || b.id === selfId) return members;
    if (typeof b.lat !== 'number' || typeof b.lon !== 'number' ||
        !isFinite(b.lat) || !isFinite(b.lon) ||
        b.lat < -90 || b.lat > 90 || b.lon < -180 || b.lon > 180) return members;
    var ts = typeof b.ts === 'number' && isFinite(b.ts) ? Math.min(b.ts, now + 60000) : now;
    var prev = members[b.id];
    if (prev && ts < prev.ts) return members;
    var next = {};
    for (var k in members) next[k] = members[k];
    next[b.id] = {
      id: b.id,
      name: (typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'Driver').slice(0, 24),
      lat: b.lat, lon: b.lon,
      heading: typeof b.heading === 'number' && isFinite(b.heading) ? b.heading : null,
      speed: typeof b.speed === 'number' && isFinite(b.speed) && b.speed >= 0 ? b.speed : null,
      etaS: typeof b.etaS === 'number' && isFinite(b.etaS) && b.etaS >= 0 ? b.etaS : null,
      arrived: !!b.arrived,
      ts: ts,
    };
    // 🎶 optional DJ payload: what this member is playing right now
    var mu = b.music;
    if (mu && typeof mu === 'object' && typeof mu.title === 'string' && mu.title.trim()) {
      next[b.id].music = {
        title: mu.title.trim().slice(0, 80),
        artist: (typeof mu.artist === 'string' ? mu.artist.trim() : '').slice(0, 80),
        durS: typeof mu.durS === 'number' && isFinite(mu.durS) && mu.durS > 0 ? mu.durS : null,
        posS: typeof mu.posS === 'number' && isFinite(mu.posS) && mu.posS >= 0 ? mu.posS : 0,
        playing: !!mu.playing,
        at: ts,
      };
    }
    return next;
  }

  var CONVOY_TTL_MS = 45000;

  /** Drop members whose beacons have gone silent. → a new object. */
  function pruneMembers(members, now, ttlMs) {
    var ttl = ttlMs || CONVOY_TTL_MS;
    var next = {};
    for (var k in members) if (now - members[k].ts <= ttl) next[k] = members[k];
    return next;
  }

  /**
   * The formation, from where you sit: every other member with distance and
   * bearing from `self` ({lat,lon}|null) and beacon age, nearest first
   * (unknown distances last).
   */
  function convoyStats(members, self, now) {
    var out = [];
    for (var k in members) {
      var m = members[k];
      var distM = self ? haversine(self, m) : null;
      out.push({ member: m, distM: distM, brgDeg: self ? bearing(self, m) : null,
                 staleS: Math.max(0, (now - m.ts) / 1000) });
    }
    out.sort(function (a, b) {
      if (a.distM == null && b.distM == null) return a.member.id < b.member.id ? -1 : 1;
      if (a.distM == null) return 1;
      if (b.distM == null) return -1;
      return a.distM - b.distM;
    });
    return out;
  }


  /* ============================ convoy chat ============================== */

  /** Normalize outgoing chat text: trimmed, collapsed whitespace, ≤400 chars.
   *  Returns null when nothing sayable remains. */
  function chatText(s) {
    if (typeof s !== 'string') return null;
    var t = s.replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > 400 ? t.slice(0, 399) + '…' : t;
  }

  /** Build a convoy chat message — text ({text}) or voice ({audio, durS}).
   *  Validates and clamps; returns null when the payload is unsendable.
   *  Voice caps: 1–30s, data-URL ≤ 900k chars (~650KB of opus). */
  function chatMsg(now, selfId, name, payload) {
    if (!selfId || !payload) return null;
    var m = { kind: 'chat', id: selfId + '-' + now + '-' + ((now % 997)),
              from: selfId, name: String(name || 'Driver').slice(0, 24), t: now };
    if (payload.text != null) {
      var t = chatText(payload.text);
      if (!t) return null;
      m.text = t;
      return m;
    }
    if (typeof payload.audio === 'string' && payload.audio.indexOf('data:audio') === 0) {
      var dur = Math.round(Number(payload.durS) || 0);
      if (dur < 1 || dur > 30 || payload.audio.length > 900000) return null;
      m.audio = payload.audio; m.durS = dur;
      return m;
    }
    return null;
  }

  /** Is a received message shaped like a chat message, fresh (±6h), and not
   *  from one of our own ids? */
  function validChatMsg(m, selfIds, now) {
    if (!m || m.kind !== 'chat' || !m.id || !m.from || typeof m.t !== 'number') return false;
    if (Math.abs(now - m.t) > 6 * 3600e3) return false;
    if (!m.text && !(m.audio && m.durS)) return false;
    for (var i = 0; i < (selfIds || []).length; i++) if (m.from === selfIds[i]) return false;
    return true;
  }

  /** Merge a message into the list: dedupes by id (BroadcastChannel and the
   *  cloud both deliver), drops stale, sorts by time, keeps the newest 60.
   *  Returns the same array when nothing changed. */
  function pruneChat(list, msg, now) {
    list = list || [];
    if (msg) {
      for (var i = 0; i < list.length; i++) if (list[i].id === msg.id) { msg = null; break; }
    }
    var next = msg ? list.concat([msg]) : list.slice();
    var fresh = [];
    for (var j = 0; j < next.length; j++) {
      if (now - next[j].t <= 6 * 3600e3) fresh.push(next[j]);
    }
    if (!msg && fresh.length === list.length) return list;
    fresh.sort(function (a, b) { return a.t - b.t; });
    return fresh.slice(-60);
  }

  /** Compact relative age for chat rows: 'now', '45s', '5 min', '2 h'. */
  function agoShort(t, now) {
    var s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 10) return 'now';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + ' min';
    return Math.round(s / 3600) + ' h';
  }


  /* ========================= convoy music (DJ mode) ====================== */

  /** Normalized identity of a song for matching across libraries:
   *  lowercase, punctuation-free 'title|artist'. */
  function trackKey(title, artist) {
    var norm = function (s) {
      return String(s || '').toLowerCase()
        .replace(/\(.*?\)|\[.*?\]/g, ' ')      // (remaster), [live] etc.
        .replace(/feat\..*$|ft\..*$/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ').trim();
    };
    return norm(title) + '|' + norm(artist);
  }

  /** Find the DJ's song in a local library ([{title, name, artist}]).
   *  Exact title+artist key first, then title alone. → index or -1. */
  function findLocalTrack(tracks, beaconMusic) {
    if (!beaconMusic || !beaconMusic.title || !tracks) return -1;
    var want = trackKey(beaconMusic.title, beaconMusic.artist);
    var wantTitle = want.split('|')[0];
    var titleOnly = -1;
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      var key = trackKey(t.title || t.name, t.artist);
      if (key === want) return i;
      if (titleOnly < 0 && wantTitle && key.split('|')[0] === wantTitle) titleOnly = i;
    }
    return titleOnly;
  }

  /** Where the DJ's playhead is NOW, given their last music beacon. */
  function djTarget(mu, now) {
    if (!mu) return 0;
    var pos = mu.posS + (mu.playing ? Math.max(0, (now - mu.at) / 1000) : 0);
    if (mu.durS != null) pos = Math.min(pos, mu.durS);
    return pos;
  }

  /** What a listener's player should do to stay with the DJ.
   *  → 'pause' | 'play' | 'seek' | 'ok'. Seeks only beyond 2.5s drift, so
   *  ordinary network jitter never causes stutter. */
  function syncAdjust(currentS, targetS, djPlaying, listenerPaused) {
    if (!djPlaying) return listenerPaused ? 'ok' : 'pause';
    if (listenerPaused) return 'play';
    return Math.abs(currentS - targetS) > 2.5 ? 'seek' : 'ok';
  }


  /** Spoken-text guard for places where street names aren't in Latin script
   *  (Dubai, Moscow, Tokyo…): the on-screen banner shows the real name, but
   *  an English TTS voice garbles it — so the SPOKEN line drops the name and
   *  keeps the manoeuvre. Latin-named streets pass through untouched. */
  function speechSafe(text) {
    if (typeof text !== 'string') return text;
    var m = text.match(/^(.*?)\s(onto|on|and continue on)\s(.+)$/);
    if (!m) return text;
    var nonLatin = /[\u0400-\u04FF\u0530-\u058F\u0590-\u08FF\u0900-\u109F\u0E00-\u0E7F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;
    return nonLatin.test(m[3]) ? m[1] : text;
  }

  /* ================================ places ================================ */

  /**
   * Rank saved/recent places for a query. Pinned kinds (home/work) lead when
   * the query is empty; text match beats frequency beats recency. Pure —
   * `now` is injected. place = {name, addr, kind?, uses?, lastUsed?}.
   */
  function rankPlaces(places, query, now) {
    var q = (query || '').trim().toLowerCase();
    var scored = [];
    for (var i = 0; i < places.length; i++) {
      var p = places[i];
      var name = (p.name || '').toLowerCase(), addr = (p.addr || '').toLowerCase();
      var text = 0;
      if (q) {
        if (name.indexOf(q) === 0) text = 3;
        else if (name.indexOf(q) > 0) text = 2;
        else if (addr.indexOf(q) >= 0) text = 1;
        if (text === 0) continue;
      }
      var pin = (p.kind === 'home' || p.kind === 'work') ? 1.5 : 0;
      var freq = Math.min(10, p.uses || 0) * 0.08;
      var ageDays = p.lastUsed ? Math.max(0, (now - p.lastUsed) / 86400000) : 365;
      var recency = Math.max(0, 0.8 - ageDays * 0.02);
      scored.push({ place: p, score: text * 2 + pin + freq + recency, i: i });
    }
    scored.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    return scored.map(function (s) { return s.place; });
  }

  /** Parse "51.5074, -0.1278" style direct coordinate input → {lat,lon}|null. */
  function parseCoord(str) {
    var m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(str || '');
    if (!m) return null;
    var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat: lat, lon: lon };
  }

  /* ================================ export ================================ */

  return {
    EARTH_R: EARTH_R, TILE: TILE,
    OFF_ROUTE_M: OFF_ROUTE_M, OFF_ROUTE_FIXES: OFF_ROUTE_FIXES, ARRIVE_M: ARRIVE_M,
    haversine: haversine, bearing: bearing, destinationPoint: destinationPoint,
    angleDiff: angleDiff, compassName: compassName,
    decodePolyline: decodePolyline, encodePolyline: encodePolyline,
    lonLatToWorld: lonLatToWorld, worldToLonLat: worldToLonLat,
    tileForWorld: tileForWorld, metresPerPixel: metresPerPixel,
    buildRoute: buildRoute, roadName: roadName,
    projectOnSegment: projectOnSegment, snapToRoute: snapToRoute, pointAtAlong: pointAtAlong,
    instructionText: instructionText, maneuverIcon: maneuverIcon,
    fmtDist: fmtDist, speakDist: speakDist, fmtDur: fmtDur, etaClock: etaClock,
    announceBands: announceBands, startGuidance: startGuidance, remaining: remaining,
    guidanceUpdate: guidanceUpdate, voiceLine: voiceLine,
    simulateTick: simulateTick, rankPlaces: rankPlaces, parseCoord: parseCoord,
    sunPosition: sunPosition, timeAtAlong: timeAtAlong, glareSegments: glareSegments,
    paceNotes: paceNotes, paceNoteLine: paceNoteLine, ghostAdvance: ghostAdvance,
    newTrack: newTrack, trackAdd: trackAdd, trackStats: trackStats, trackToGPX: trackToGPX,
    routeBack: routeBack, updatePace: updatePace,
    fmtTimestamp: fmtTimestamp, dashcamLines: dashcamLines,
    dashcamFilename: dashcamFilename, recordingEstimateMB: recordingEstimateMB,
    fmtBytes: fmtBytes, pruneClips: pruneClips,
    parseMaxspeed: parseMaxspeed, mapLimitsToRoute: mapLimitsToRoute, limitAtAlong: limitAtAlong,
    mapCamerasToRoute: mapCamerasToRoute, cameraNext: cameraNext, overspeedUpdate: overspeedUpdate,
    pairAvgCameras: pairAvgCameras, zoneFromEndpoints: zoneFromEndpoints, avgZoneUpdate: avgZoneUpdate,
    makeProCode: makeProCode, validProCode: validProCode,
    entitlements: entitlements, driveStatsSummary: driveStatsSummary,
    parseID3: parseID3, makeShuffleOrder: makeShuffleOrder,
    nextTrack: nextTrack, fmtTrackTime: fmtTrackTime,
    corridorTiles: corridorTiles, packEstimateMB: packEstimateMB,
    laneIconKey: laneIconKey, parseLanes: parseLanes,
    junctionCandidates: junctionCandidates, buildJunctionView: buildJunctionView,
    buildingHeightM: buildingHeightM, roofFactor: roofFactor, wallShade: wallShade,
    incidentDelayS: incidentDelayS, mapIncidentsToRoute: mapIncidentsToRoute,
    typicalTrafficFactor: typicalTrafficFactor, trafficAdjust: trafficAdjust,
    remainingWithTraffic: remainingWithTraffic, nextIncident: nextIncident,
    makeConvoyCode: makeConvoyCode, validConvoyCode: validConvoyCode, parseConvoyLink: parseConvoyLink,
    convoyAvatar: convoyAvatar, applyBeacon: applyBeacon, pruneMembers: pruneMembers, convoyStats: convoyStats,
    chatText: chatText, chatMsg: chatMsg, validChatMsg: validChatMsg, pruneChat: pruneChat, agoShort: agoShort,
    trackKey: trackKey, findLocalTrack: findLocalTrack, djTarget: djTarget, syncAdjust: syncAdjust,
    speechSafe: speechSafe,
  };
});
