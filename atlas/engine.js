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
      if (s.crossTrack <= max) out.push({ alongM: s.alongM, lat: c.lat, lon: c.lon, kmh: c.kmh == null ? null : c.kmh });
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

  /**
   * Overspeed state machine with hysteresis: 5 % + 1 km/h of tolerance, and
   * you must stay over it for 3 s before the (single) spoken warning — GPS
   * blips never nag. `over` is the immediate visual state.
   * → {state, over, warn}
   */
  function overspeedUpdate(state, speedKmh, limitKmh, dtS) {
    state = state || { overS: 0, warned: false };
    if (limitKmh == null) return { state: { overS: 0, warned: false }, over: false, warn: false };
    var tol = limitKmh * 1.05 + 1;
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
  };
});
