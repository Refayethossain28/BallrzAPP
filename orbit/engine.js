/*
 * Orbit Engine — the pure, deterministic core of the everything app.
 * Rides (quotes, surge, bidding, matching, the trip state machine, cancel
 * rules, safety codes), food delivery (fees, promos, order lifecycle),
 * courier parcels, the wallet ledger (top-ups, transfers, split bills,
 * cashback), Orbit+ membership, rewards points & tiers, price locks and
 * scheduled rides all live here — clock-injected and seeded, so the same
 * question always gets the same answer and every rule is unit-testable
 * (scripts/test-orbit-logic.mjs).
 *
 * Honesty note: with no server there is no real fleet — drivers, couriers
 * and kitchens are a deterministic simulation shaped like the real market
 * (per-km/per-min tariffs, rush-hour surge, bid floors). It demonstrates
 * the product; it does not dispatch real cars.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrbitEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── seeded determinism ─────────────────────────────────────────── */
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rngFor(key) { return mulberry32(hashStr(key)); }

  /* ── clock (UTC parts so tests are timezone-proof) ──────────────── */
  function partsOf(ms) {
    var d = new Date(ms);
    return { dow: d.getUTCDay(), hour: d.getUTCHours(), min: d.getUTCMinutes(), ms: ms };
  }

  /* ── Meridian — the city (km grid; the map draws from this too) ─── */
  var PLACES = [
    { id: 'home',     name: 'Home',              emoji: '🏠', x: 5.2,  y: 6.4,  kind: 'home' },
    { id: 'work',     name: 'The Exchange',      emoji: '🏢', x: 8.9,  y: 4.1,  kind: 'work' },
    { id: 'airport',  name: 'Meridian Airport',  emoji: '✈️', x: 15.6, y: 10.8, kind: 'airport' },
    { id: 'central',  name: 'Central Station',   emoji: '🚉', x: 8.0,  y: 5.6,  kind: 'station' },
    { id: 'harbour',  name: 'Old Harbour',       emoji: '⚓', x: 11.2, y: 8.4,  kind: 'sight' },
    { id: 'mall',     name: 'Galleria Mall',     emoji: '🛍️', x: 6.8,  y: 3.2,  kind: 'mall' },
    { id: 'uni',      name: 'City University',   emoji: '🎓', x: 3.4,  y: 4.5,  kind: 'campus' },
    { id: 'stadium',  name: 'Crescent Stadium',  emoji: '🏟️', x: 12.4, y: 3.6,  kind: 'stadium' },
    { id: 'park',     name: 'Meridian Park',     emoji: '🌳', x: 4.6,  y: 2.4,  kind: 'park' },
    { id: 'medcity',  name: 'St. Vera Hospital', emoji: '🏥', x: 9.8,  y: 7.6,  kind: 'hospital' },
    { id: 'souk',     name: 'Spice Souk',        emoji: '🏮', x: 10.4, y: 6.2,  kind: 'market' },
    { id: 'marina',   name: 'West Marina',       emoji: '⛵', x: 1.8,  y: 8.2,  kind: 'sight' },
    { id: 'tower',    name: 'Aurora Tower',      emoji: '🗼', x: 9.4,  y: 5.0,  kind: 'sight' },
    { id: 'beach',    name: 'Palm Beach',        emoji: '🏖️', x: 13.8, y: 12.2, kind: 'sight' },
    { id: 'oldtown',  name: 'Old Town',          emoji: '🏛️', x: 7.2,  y: 7.0,  kind: 'sight' },
    { id: 'techpark', name: 'Nova Tech Park',    emoji: '💾', x: 13.0, y: 5.8,  kind: 'work' }
  ];
  var PLACE_BY_ID = {};
  PLACES.forEach(function (p) { PLACE_BY_ID[p.id] = p; });
  function place(id) { return PLACE_BY_ID[id] || null; }

  var WINDING = 1.27; // straight line → real streets
  function roadKm(fromId, toId) {
    var a = place(fromId), b = place(toId);
    if (!a || !b) return null;
    var km = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)) * WINDING;
    return Math.round(km * 10) / 10;
  }

  /* two-bend street path for the map + trip animation */
  function pathPoints(fromId, toId) {
    var a = place(fromId), b = place(toId);
    if (!a || !b) return [];
    var midX = { x: b.x, y: a.y };
    return [{ x: a.x, y: a.y }, midX, { x: b.x, y: b.y }];
  }
  function pathLen(pts) {
    var L = 0;
    for (var i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return L;
  }
  function posAlong(pts, frac) {
    if (!pts.length) return null;
    if (frac <= 0) return { x: pts[0].x, y: pts[0].y };
    var total = pathLen(pts), walked = Math.min(frac, 1) * total;
    for (var i = 1; i < pts.length; i++) {
      var seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (walked <= seg && seg > 0) {
        var t = walked / seg;
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
      }
      walked -= seg;
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  }

  /* ── ride classes ───────────────────────────────────────────────── */
  var RIDE_CLASSES = [
    { id: 'moto',    name: 'Moto',    emoji: '🏍️', seats: 1, base: 1.20, perKm: 0.55, perMin: 0.10, minFare: 3.00,  kmh: 34, co2: 45,  blurb: 'Beat the traffic' },
    { id: 'mini',    name: 'Mini',    emoji: '🚗', seats: 3, base: 1.80, perKm: 0.82, perMin: 0.14, minFare: 4.50,  kmh: 26, co2: 105, blurb: 'Small & savvy' },
    { id: 'go',      name: 'Go',      emoji: '🚙', seats: 4, base: 2.40, perKm: 1.05, perMin: 0.17, minFare: 5.50,  kmh: 27, co2: 125, blurb: 'Everyday rides' },
    { id: 'comfort', name: 'Comfort', emoji: '🚘', seats: 4, base: 3.40, perKm: 1.38, perMin: 0.22, minFare: 7.50,  kmh: 27, co2: 132, blurb: 'Newer cars, top drivers' },
    { id: 'xl',      name: 'XL',      emoji: '🚐', seats: 6, base: 4.20, perKm: 1.72, perMin: 0.27, minFare: 9.50,  kmh: 25, co2: 175, blurb: 'Room for six' },
    { id: 'lux',     name: 'Lux',     emoji: '🏎️', seats: 4, base: 6.50, perKm: 2.60, perMin: 0.42, minFare: 15.00, kmh: 28, co2: 160, blurb: 'Arrive in style' },
    { id: 'green',   name: 'Green',   emoji: '🍃', seats: 4, base: 2.60, perKm: 1.10, perMin: 0.17, minFare: 5.80,  kmh: 27, co2: 0,   blurb: '100% electric' }
  ];
  var CLASS_BY_ID = {};
  RIDE_CLASSES.forEach(function (c) { CLASS_BY_ID[c.id] = c; });
  function rideClass(id) { return CLASS_BY_ID[id] || null; }

  var BOOKING_FEE = 0.90;

  /* ── surge — honest, deterministic, always with a reason ────────── */
  function surgeAt(when) {
    var p = typeof when === 'number' ? partsOf(when) : when;
    var weekday = p.dow >= 1 && p.dow <= 5;
    if (weekday && p.hour >= 7 && p.hour < 9)   return { mult: 1.4, reason: 'Morning rush' };
    if (weekday && p.hour >= 17 && p.hour < 19) return { mult: 1.5, reason: 'Evening rush' };
    var fri = p.dow === 5, sat = p.dow === 6;
    if ((fri || sat) && p.hour >= 22)           return { mult: 1.6, reason: 'Weekend nightlife' };
    if ((sat || p.dow === 0) && p.hour < 2)     return { mult: 1.6, reason: 'Weekend nightlife' };
    if (p.hour >= 2 && p.hour < 5)              return { mult: 0.9, reason: 'Night owl discount' };
    return { mult: 1.0, reason: null };
  }

  /* traffic factor: rides take longer in the rush the surge already knows about */
  function trafficFactor(when) {
    var s = surgeAt(when);
    return s.reason && s.mult > 1 ? 1 + (s.mult - 1) * 0.6 : 1;
  }

  function rideMins(fromId, toId, classId, when) {
    var km = roadKm(fromId, toId), cls = rideClass(classId);
    if (km == null || !cls) return null;
    return Math.max(4, Math.round((km / cls.kmh) * 60 * trafficFactor(when)));
  }

  function co2g(fromId, toId, classId) {
    var km = roadKm(fromId, toId), cls = rideClass(classId);
    if (km == null || !cls) return null;
    return Math.round(km * cls.co2);
  }

  /* ── the quote: upfront, itemised, surge shown honestly ─────────── */
  function quote(fromId, toId, classId, when) {
    var km = roadKm(fromId, toId), cls = rideClass(classId);
    if (km == null || !cls || fromId === toId) return null;
    var mins = rideMins(fromId, toId, classId, when);
    var s = surgeAt(when);
    var metered = cls.base + km * cls.perKm + mins * cls.perMin;
    var surged = metered * s.mult;
    var subtotal = Math.max(surged, cls.minFare);
    var total = Math.round((subtotal + BOOKING_FEE) * 100) / 100;
    var breakdown = [
      { label: 'Base fare', amount: cls.base },
      { label: km + ' km × £' + cls.perKm.toFixed(2), amount: Math.round(km * cls.perKm * 100) / 100 },
      { label: mins + ' min × £' + cls.perMin.toFixed(2), amount: Math.round(mins * cls.perMin * 100) / 100 }
    ];
    if (s.mult !== 1) breakdown.push({ label: (s.reason || 'Demand') + ' ×' + s.mult.toFixed(1), amount: Math.round((surged - metered) * 100) / 100 });
    if (subtotal > surged) breakdown.push({ label: 'Minimum fare top-up', amount: Math.round((subtotal - surged) * 100) / 100 });
    breakdown.push({ label: 'Booking fee', amount: BOOKING_FEE });
    return {
      fromId: fromId, toId: toId, classId: classId, km: km, mins: mins,
      surge: s, total: total, breakdown: breakdown,
      co2g: co2g(fromId, toId, classId)
    };
  }
  function quoteAll(fromId, toId, when) {
    return RIDE_CLASSES.map(function (c) { return quote(fromId, toId, c.id, when); }).filter(Boolean);
  }

  /* ── Orbit Wheels: docked bikes & e-scooters ────────────────────── */
  var WHEELS = [
    { id: 'bike',    name: 'Bike',      emoji: '🚲', unlock: 0.50, perMin: 0.18, kmh: 14, minFare: 1.50 },
    { id: 'scooter', name: 'E-scooter', emoji: '🛴', unlock: 1.00, perMin: 0.25, kmh: 18, minFare: 2.00 }
  ];
  function wheelMode(id) { for (var i = 0; i < WHEELS.length; i++) if (WHEELS[i].id === id) return WHEELS[i]; return null; }
  var STATION_IDS = ['central', 'uni', 'park', 'oldtown', 'harbour', 'mall', 'tower'];
  function isStation(placeId) { return STATION_IDS.indexOf(placeId) !== -1; }
  function stationDocks(stationId, whenMs) {
    if (!isStation(stationId)) return null;
    var p = partsOf(whenMs);
    var rng = rngFor('dock:' + stationId + ':' + p.dow + ':' + p.hour);
    return { bikes: Math.floor(rng() * 9), scooters: Math.floor(rng() * 7) };
  }
  function wheelsQuote(fromId, toId, modeId, whenMs) {
    var mode = wheelMode(modeId);
    if (!mode || !isStation(fromId) || !isStation(toId) || fromId === toId) return null;
    var km = roadKm(fromId, toId);
    var mins = Math.max(3, Math.round((km / mode.kmh) * 60));
    var price = Math.round(Math.max(mode.unlock + mins * mode.perMin, mode.minFare) * 100) / 100;
    return { fromId: fromId, toId: toId, modeId: modeId, km: km, mins: mins, total: price, co2g: 0 };
  }

  /* ── the smart departure planner: surge, scanned honestly ───────── */
  function fareTimeline(fromId, toId, classId, startMs, hours, stepMin) {
    var H = hours || 12, step = (stepMin || 30) * 60000, out = [];
    for (var ms = startMs; ms <= startMs + H * 3600000; ms += step) {
      var q = quote(fromId, toId, classId, ms);
      if (!q) return null;
      out.push({ ms: ms, total: q.total, surge: q.surge });
    }
    return out;
  }
  function cheapestWindow(timeline) {
    if (!timeline || !timeline.length) return null;
    var best = timeline[0];
    timeline.forEach(function (t) { if (t.total < best.total) best = t; });
    return best;
  }

  /* ── expenses: business rides, one monthly report ───────────────── */
  function expenseReport(trips, month) {
    var lines = [];
    var total = 0;
    (trips || []).forEach(function (t) {
      if (!t.business || t.status !== 'COMPLETED') return;
      if (monthKey(t.startedMs) !== month) return;
      var label = place(t.quote.fromId).name + ' → ' + place(t.quote.toId).name;
      lines.push({ label: label, amount: t.fare, ms: t.startedMs });
      total += t.fare;
    });
    total = Math.round(total * 100) / 100;
    var text = 'Orbit business rides — ' + month + '\n' +
      lines.map(function (l) {
        return new Date(l.ms).toISOString().slice(0, 10) + '  ' + l.label + '  £' + l.amount.toFixed(2);
      }).join('\n') + (lines.length ? '\n' : '') + 'Total: £' + total.toFixed(2) + ' (' + lines.length + ' rides)';
    return { month: month, count: lines.length, total: total, lines: lines, text: text };
  }

  /* ── multi-stop rides: one booking, several legs ────────────────── */
  var STOP_FEE = 0.60; // per extra stop — covers the wait, shown as a line item
  function multiStopQuote(stopIds, classId, when) {
    if (!Array.isArray(stopIds) || stopIds.length < 2 || stopIds.length > 4) return null;
    for (var i = 0; i < stopIds.length; i++) {
      if (!place(stopIds[i])) return null;
      if (i > 0 && stopIds[i] === stopIds[i - 1]) return null;
    }
    var legs = [];
    for (var j = 1; j < stopIds.length; j++) {
      var q = quote(stopIds[j - 1], stopIds[j], classId, when);
      if (!q) return null;
      legs.push(q);
    }
    var extraStops = stopIds.length - 2;
    var km = 0, mins = 0, sum = 0, co2 = 0;
    legs.forEach(function (l) { km += l.km; mins += l.mins; sum += l.total; co2 += l.co2g; });
    // one booking fee for the whole journey, not one per leg
    var total = Math.round((sum - BOOKING_FEE * (legs.length - 1) + extraStops * STOP_FEE) * 100) / 100;
    var breakdown = legs.map(function (l, k) {
      return { label: 'Leg ' + (k + 1) + ': ' + place(l.fromId).name + ' → ' + place(l.toId).name, amount: Math.round((l.total - BOOKING_FEE) * 100) / 100 };
    });
    if (extraStops > 0) breakdown.push({ label: extraStops + ' extra stop' + (extraStops > 1 ? 's' : '') + ' × £' + STOP_FEE.toFixed(2), amount: Math.round(extraStops * STOP_FEE * 100) / 100 });
    breakdown.push({ label: 'Booking fee (one, not per leg)', amount: BOOKING_FEE });
    return {
      stops: stopIds.slice(), legs: legs, classId: classId,
      fromId: stopIds[0], toId: stopIds[stopIds.length - 1],
      km: Math.round(km * 10) / 10, mins: mins, co2g: co2,
      surge: legs[0].surge, total: total, breakdown: breakdown
    };
  }
  function pathThrough(stopIds) {
    var pts = [];
    for (var i = 1; i < stopIds.length; i++) {
      var seg = pathPoints(stopIds[i - 1], stopIds[i]);
      pts = pts.concat(i === 1 ? seg : seg.slice(1));
    }
    return pts;
  }

  /* ── tipping: 100% to the captain, always ───────────────────────── */
  var TIP_PRESETS = [1, 2, 3];
  function tipEarn(tip) { return Math.round(tip * 100) / 100; } // no platform cut on tips

  /* ── Route Pass: 10 rides on a route, 15% off, 30 days ──────────── */
  var PASS_RIDES = 10, PASS_DISCOUNT = 0.15, PASS_DAYS = 30;
  function routePassQuote(fromId, toId, classId, when) {
    var q = quote(fromId, toId, classId, when);
    if (!q) return null;
    var perRide = Math.round(q.total * (1 - PASS_DISCOUNT) * 100) / 100;
    return {
      fromId: fromId, toId: toId, classId: classId,
      rides: PASS_RIDES, days: PASS_DAYS, perRide: perRide,
      price: Math.round(perRide * PASS_RIDES * 100) / 100,
      saves: Math.round((q.total - perRide) * PASS_RIDES * 100) / 100
    };
  }
  function passCovers(pass, fromId, toId, classId, nowMs) {
    if (!pass || pass.left <= 0 || nowMs > pass.untilMs) return false;
    if (pass.classId !== classId) return false;
    // a route pass works in both directions
    return (pass.fromId === fromId && pass.toId === toId) || (pass.fromId === toId && pass.toId === fromId);
  }

  /* ── PayLater: this month's tab, settled in one payment ─────────── */
  var PAYLATER_LIMIT = 100;
  function monthKey(nowMs) {
    var d = new Date(nowMs);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }
  function plDue(charges, nowMs) {
    var mk = monthKey(nowMs), due = 0;
    (charges || []).forEach(function (c) { if (!c.settled) due += c.amount; });
    return { month: mk, due: Math.round(due * 100) / 100 };
  }
  function plCanCharge(charges, amount, nowMs) {
    if (!(amount > 0)) return { ok: false, why: 'Nothing to charge' };
    var due = plDue(charges, nowMs).due;
    if (due + amount > PAYLATER_LIMIT + 1e-9) {
      return { ok: false, why: 'That would pass your £' + PAYLATER_LIMIT + ' PayLater limit (£' + due.toFixed(2) + ' already on the tab)' };
    }
    return { ok: true, why: null };
  }
  function plCharge(charges, amount, label, nowMs) {
    var chk = plCanCharge(charges, amount, nowMs);
    if (!chk.ok) return null;
    charges.push({ amount: Math.round(amount * 100) / 100, label: label, ms: nowMs, month: monthKey(nowMs), settled: false });
    return charges;
  }
  function plSettle(charges, nowMs) {
    var total = 0;
    (charges || []).forEach(function (c) { if (!c.settled) { total += c.amount; c.settled = true; c.settledMs = nowMs; } });
    return Math.round(total * 100) / 100;
  }

  /* ── referrals: give £5, get £5, once ───────────────────────────── */
  var REFERRAL_BONUS = 5;
  function referralCode(name) {
    var abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var h = hashStr('ref:' + String(name).toLowerCase().trim()), out = '';
    for (var i = 0; i < 6; i++) { out += abc[h % abc.length]; h = Math.floor(h / abc.length) + i * 13; }
    return out;
  }
  function applyReferral(code, ownName, alreadyUsed) {
    var c = String(code || '').toUpperCase().trim();
    if (alreadyUsed) return { ok: false, why: 'You\'ve already used a referral code' };
    if (!/^[A-Z2-9]{6}$/.test(c)) return { ok: false, why: 'Codes are 6 letters/numbers' };
    if (c === referralCode(ownName)) return { ok: false, why: 'That\'s your own code 🙂' };
    return { ok: true, why: null, bonus: REFERRAL_BONUS };
  }

  /* ── the driver pool (seeded, stable per pickup+day) ────────────── */
  var DRIVER_FIRST = ['Amir', 'Layla', 'Omar', 'Fatima', 'Yusuf', 'Nadia', 'Karim', 'Sofia', 'Hassan', 'Amina', 'Tariq', 'Zara', 'Marco', 'Elena', 'Dele', 'Priya'];
  var DRIVER_CARS = { moto: ['Honda PCX', 'Yamaha NMAX'], mini: ['Toyota Aygo', 'Kia Picanto', 'Fiat 500'], go: ['Toyota Corolla', 'Honda Civic', 'Nissan Sentra'], comfort: ['Toyota Camry', 'VW Passat', 'Skoda Superb'], xl: ['Kia Carnival', 'Toyota Sienna', 'VW Sharan'], lux: ['Mercedes E-Class', 'BMW 5 Series', 'Lexus ES'], green: ['Tesla Model 3', 'Nissan Leaf', 'BYD Seal'] };
  function driversNear(pickupId, classId, seedKey) {
    var rng = rngFor('drv:' + pickupId + ':' + classId + ':' + (seedKey || ''));
    var cars = DRIVER_CARS[classId] || DRIVER_CARS.go;
    var n = 5 + Math.floor(rng() * 3), out = [];
    for (var i = 0; i < n; i++) {
      var name = DRIVER_FIRST[Math.floor(rng() * DRIVER_FIRST.length)];
      out.push({
        id: 'd' + i,
        name: name,
        car: cars[Math.floor(rng() * cars.length)],
        plate: 'M' + (100 + Math.floor(rng() * 900)) + ' ' + String.fromCharCode(65 + Math.floor(rng() * 26)) + String.fromCharCode(65 + Math.floor(rng() * 26)) + String.fromCharCode(65 + Math.floor(rng() * 26)),
        rating: Math.round((4.55 + rng() * 0.44) * 100) / 100,
        trips: 300 + Math.floor(rng() * 9000),
        kmAway: Math.round((0.3 + rng() * 2.6) * 10) / 10,
        etaMin: 0
      });
    }
    out.forEach(function (d) { d.etaMin = Math.max(1, Math.round(d.kmAway / 0.45)); });
    return out;
  }
  function matchDriver(drivers, favNames) {
    if (!drivers || !drivers.length) return null;
    var favs = favNames || [];
    return drivers.slice().sort(function (a, b) {
      var fa = favs.indexOf(a.name) !== -1 ? 0 : 1, fb = favs.indexOf(b.name) !== -1 ? 0 : 1;
      return (fa - fb) || (a.etaMin - b.etaMin) || (b.rating - a.rating);
    })[0];
  }

  /* ── Fair Fare — inDrive-style bidding, honest floors ───────────── */
  var BID_FLOOR = 0.72; // below this drivers won't move — their time has a price
  function bidResponses(q, offer, drivers) {
    var ratio = offer / q.total;
    return drivers.map(function (d) {
      var r = rngFor('bid:' + d.name + d.plate + Math.round(offer * 100));
      var appetite = BID_FLOOR + (5 - d.rating) * 0.2 + r() * 0.18; // hungrier drivers accept lower
      if (ratio >= 0.97 || ratio >= appetite + 0.1) return { driver: d, kind: 'accept', amount: Math.round(offer * 100) / 100 };
      if (ratio < BID_FLOOR) return { driver: d, kind: 'decline', amount: null };
      if (ratio >= appetite) return { driver: d, kind: 'accept', amount: Math.round(offer * 100) / 100 };
      var counter = Math.min(q.total, offer + (q.total - offer) * (0.4 + r() * 0.35));
      return { driver: d, kind: 'counter', amount: Math.round(counter * 100) / 100 };
    });
  }
  function bestBid(responses) {
    var accepts = responses.filter(function (r) { return r.kind === 'accept'; });
    if (accepts.length) return accepts.sort(function (a, b) { return (a.driver.etaMin - b.driver.etaMin) || (b.driver.rating - a.driver.rating); })[0];
    var counters = responses.filter(function (r) { return r.kind === 'counter'; });
    if (counters.length) return counters.sort(function (a, b) { return (a.amount - b.amount) || (a.driver.etaMin - b.driver.etaMin); })[0];
    return null;
  }

  /* ── the trip state machine ─────────────────────────────────────── */
  var TRIP_FLOW = ['REQUESTED', 'MATCHED', 'ARRIVING', 'ARRIVED', 'IN_TRIP', 'COMPLETED'];
  function createTrip(q, driver, fare, nowMs) {
    return {
      id: 'T' + (nowMs % 1e9).toString(36).toUpperCase() + hashStr(q.fromId + q.toId + nowMs).toString(36).slice(0, 3).toUpperCase(),
      quote: q, driver: driver, fare: Math.round(fare * 100) / 100,
      status: 'REQUESTED', startedMs: nowMs, log: [{ status: 'REQUESTED', ms: nowMs }]
    };
  }
  function tripAdvance(trip, nowMs) {
    var i = TRIP_FLOW.indexOf(trip.status);
    if (i < 0 || i >= TRIP_FLOW.length - 1) return trip;
    trip.status = TRIP_FLOW[i + 1];
    trip.log.push({ status: trip.status, ms: nowMs });
    return trip;
  }
  function cancelQuote(trip, nowMs) {
    if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED') return null;
    if (trip.status === 'REQUESTED') return { fee: 0, reason: 'No driver assigned yet — cancel free' };
    var matchedAt = null;
    trip.log.forEach(function (l) { if (l.status === 'MATCHED') matchedAt = l.ms; });
    if (trip.status === 'MATCHED' || trip.status === 'ARRIVING') {
      if (matchedAt != null && nowMs - matchedAt <= 2 * 60000) return { fee: 0, reason: 'Within the 2-minute grace window' };
      return { fee: 4.00, reason: 'Your driver is already on the way' };
    }
    if (trip.status === 'ARRIVED') return { fee: 5.00, reason: 'Your driver is waiting at the pickup' };
    return { fee: Math.round(trip.fare * 100) / 100, reason: 'Trip already in progress — full fare applies' };
  }
  function cancelTrip(trip, nowMs) {
    var cq = cancelQuote(trip, nowMs);
    if (!cq) return trip;
    trip.status = 'CANCELLED';
    trip.cancelFee = cq.fee;
    trip.log.push({ status: 'CANCELLED', ms: nowMs });
    return trip;
  }

  /* ── safety: PIN + share code, deterministic from the trip id ───── */
  function tripPin(tripId) { return String(1000 + hashStr('pin:' + tripId) % 9000); }
  function shareCode(tripId) {
    var abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', h = hashStr('share:' + tripId), out = '';
    for (var i = 0; i < 6; i++) { out += abc[h % abc.length]; h = Math.floor(h / abc.length) + i * 7; }
    return out;
  }

  /* ── scheduling & price lock ────────────────────────────────────── */
  function validateSchedule(nowMs, whenMs) {
    var diff = whenMs - nowMs;
    if (diff < 30 * 60000) return { ok: false, why: 'Pick a time at least 30 minutes from now' };
    if (diff > 7 * 86400000) return { ok: false, why: 'You can book up to 7 days ahead' };
    return { ok: true, why: null };
  }
  var LOCK_FEE_PCT = 0.05, LOCK_DAYS = 7;
  function priceLockQuote(q) {
    var fee = Math.max(0.49, Math.round(q.total * LOCK_FEE_PCT * 100) / 100);
    return { fee: fee, days: LOCK_DAYS, locked: q.total };
  }
  function lockValid(lock, nowMs) { return !!lock && nowMs <= lock.untilMs; }

  /* ── EAT — kitchens of Meridian ─────────────────────────────────── */
  var RESTAURANTS = [
    { id: 'zaytoon',  name: 'Zaytoon Grill',     emoji: '🥙', cuisine: 'Lebanese', at: 'souk',    rating: 4.8, price: 2, prepMin: 14, dineOut: true,
      menu: [['Mixed grill', 13.5], ['Shawarma wrap', 7.2], ['Falafel mezze', 8.9], ['Fattoush', 5.4], ['Baklava', 4.2]] },
    { id: 'wok',      name: 'Golden Wok',        emoji: '🥡', cuisine: 'Chinese', at: 'oldtown', rating: 4.6, price: 1, prepMin: 12, dineOut: false,
      menu: [['Kung pao chicken', 9.8], ['Veg chow mein', 7.5], ['Salt & pepper tofu', 8.2], ['Egg fried rice', 4.5], ['Prawn crackers', 2.8]] },
    { id: 'napoli',   name: 'Forno di Napoli',   emoji: '🍕', cuisine: 'Italian', at: 'tower',   rating: 4.9, price: 2, prepMin: 16, dineOut: true,
      menu: [['Margherita', 9.5], ['Diavola', 11.8], ['Truffle funghi', 13.2], ['Burrata', 7.8], ['Tiramisu', 5.5]] },
    { id: 'sakura',   name: 'Sakura Sushi',      emoji: '🍣', cuisine: 'Japanese', at: 'marina', rating: 4.7, price: 3, prepMin: 18, dineOut: true,
      menu: [['Salmon set (12)', 16.5], ['Dragon roll', 12.9], ['Chicken katsu don', 10.8], ['Miso soup', 3.2], ['Mochi', 4.8]] },
    { id: 'burger',   name: 'Patty Palace',      emoji: '🍔', cuisine: 'Burgers', at: 'mall',    rating: 4.5, price: 1, prepMin: 10, dineOut: false,
      menu: [['Smash double', 8.9], ['Chicken deluxe', 8.2], ['Halloumi burger', 7.9], ['Loaded fries', 4.9], ['Shake', 4.2]] },
    { id: 'tandoor',  name: 'Tandoor Nights',    emoji: '🍛', cuisine: 'Indian', at: 'uni',     rating: 4.7, price: 2, prepMin: 17, dineOut: true,
      menu: [['Butter chicken', 11.5], ['Lamb biryani', 12.8], ['Dal makhani', 8.5], ['Garlic naan', 3.2], ['Gulab jamun', 3.9]] },
    { id: 'verde',    name: 'Casa Verde',        emoji: '🥗', cuisine: 'Healthy', at: 'park',   rating: 4.6, price: 2, prepMin: 9, dineOut: false,
      menu: [['Buddha bowl', 9.9], ['Chicken caesar', 9.2], ['Açaí bowl', 7.5], ['Green juice', 4.5], ['Protein bites', 3.8]] },
    { id: 'elpaso',   name: 'El Paso Cantina',   emoji: '🌮', cuisine: 'Mexican', at: 'stadium', rating: 4.4, price: 1, prepMin: 11, dineOut: false,
      menu: [['Taco trio', 8.7], ['Chicken burrito', 9.4], ['Loaded nachos', 7.9], ['Elote', 4.2], ['Churros', 4.5]] },
    { id: 'pearl',    name: 'Pearl of Arabia',   emoji: '🫖', cuisine: 'Emirati', at: 'harbour', rating: 4.9, price: 3, prepMin: 20, dineOut: true,
      menu: [['Lamb machboos', 15.8], ['Grilled hammour', 17.5], ['Luqaimat', 5.2], ['Karak chai', 2.5], ['Hummus royale', 6.8]] },
    { id: 'brew',     name: 'Brew & Bloom',      emoji: '☕', cuisine: 'Café', at: 'central',  rating: 4.5, price: 1, prepMin: 7, dineOut: false,
      menu: [['Flat white', 3.4], ['Avocado toast', 6.9], ['Granola bowl', 5.8], ['Banana bread', 3.5], ['Iced matcha', 4.2]] }
  ];
  var REST_BY_ID = {};
  RESTAURANTS.forEach(function (r) { REST_BY_ID[r.id] = r; });
  function restaurant(id) { return REST_BY_ID[id] || null; }

  var EAT_SMALL_ORDER_MIN = 8, EAT_SMALL_ORDER_FEE = 1.5;
  var EAT_FREE_DELIVERY_MIN = 15; // Orbit+ perk threshold
  function eatQuote(restId, dropId, basketTotal, opts) {
    var r = restaurant(restId);
    if (!r || !place(dropId)) return null;
    opts = opts || {};
    var km = roadKm(r.at, dropId);
    var delivery = Math.round((1.2 + km * 0.45) * 100) / 100;
    var freeDelivery = !!opts.plus && basketTotal >= EAT_FREE_DELIVERY_MIN;
    if (freeDelivery) delivery = 0;
    var small = basketTotal > 0 && basketTotal < EAT_SMALL_ORDER_MIN ? EAT_SMALL_ORDER_FEE : 0;
    var service = Math.min(3, Math.round(basketTotal * 0.10 * 100) / 100);
    var discount = 0;
    if (opts.promo === 'WELCOME20') discount = Math.min(10, Math.round(basketTotal * 0.20 * 100) / 100);
    var total = Math.round((basketTotal + delivery + small + service - discount) * 100) / 100;
    var courierMins = Math.max(4, Math.round((km / 30) * 60 * trafficFactor(opts.when != null ? opts.when : 0)));
    return {
      restId: restId, km: km, deliveryFee: delivery, freeDelivery: freeDelivery,
      smallOrderFee: small, serviceFee: service, discount: discount,
      basket: Math.round(basketTotal * 100) / 100, total: total,
      etaMin: r.prepMin + courierMins
    };
  }
  var ORDER_FLOW = ['PLACED', 'COOKING', 'COURIER_ON_WAY', 'ALMOST_THERE', 'DELIVERED'];
  function orderAdvance(order, nowMs) {
    var i = ORDER_FLOW.indexOf(order.status);
    if (i < 0 || i >= ORDER_FLOW.length - 1) return order;
    order.status = ORDER_FLOW[i + 1];
    order.log.push({ status: order.status, ms: nowMs });
    return order;
  }
  function dineOutPct(plus) { return plus ? 20 : 10; }

  /* ── SEND — parcels ─────────────────────────────────────────────── */
  var PARCEL_SIZES = [
    { id: 's', name: 'Small',  emoji: '✉️', maxKg: 2,  mult: 1.0, blurb: 'Documents, keys, a phone' },
    { id: 'm', name: 'Medium', emoji: '📦', maxKg: 8,  mult: 1.35, blurb: 'A shoebox or two' },
    { id: 'l', name: 'Large',  emoji: '🧳', maxKg: 20, mult: 1.8, blurb: 'A suitcase-sized box' }
  ];
  function parcelSize(id) { for (var i = 0; i < PARCEL_SIZES.length; i++) if (PARCEL_SIZES[i].id === id) return PARCEL_SIZES[i]; return null; }
  function sendQuote(fromId, toId, sizeId, opts) {
    var km = roadKm(fromId, toId), size = parcelSize(sizeId);
    if (km == null || !size || fromId === toId) return null;
    opts = opts || {};
    var base = (2.2 + km * 0.75) * size.mult;
    if (opts.plus) base *= 0.9;
    var total = Math.round(Math.max(base, 3.5) * 100) / 100;
    return { km: km, sizeId: sizeId, total: total, insuredTo: 100, etaMin: Math.max(6, Math.round((km / 28) * 60)) + 6 };
  }
  var SEND_FLOW = ['BOOKED', 'PICKING_UP', 'ON_THE_WAY', 'DELIVERED'];
  function sendAdvance(job, nowMs) {
    var i = SEND_FLOW.indexOf(job.status);
    if (i < 0 || i >= SEND_FLOW.length - 1) return job;
    job.status = SEND_FLOW[i + 1];
    job.log.push({ status: job.status, ms: nowMs });
    return job;
  }

  /* ── PAY — the wallet is a ledger, balance is derived ───────────── */
  function walletBalance(ledger) {
    var b = 0;
    (ledger || []).forEach(function (t) { b += t.amount; });
    return Math.round(b * 100) / 100;
  }
  function makeTx(kind, amount, label, nowMs) {
    return { kind: kind, amount: Math.round(amount * 100) / 100, label: label, ms: nowMs };
  }
  function canSpend(ledger, amount) { return walletBalance(ledger) >= amount - 1e-9; }
  function splitBill(total, people) {
    if (!(people >= 2) || !(total > 0)) return null;
    var pennies = Math.round(total * 100), each = Math.floor(pennies / people), rem = pennies - each * people;
    var shares = [];
    for (var i = 0; i < people; i++) shares.push((each + (i < rem ? 1 : 0)) / 100);
    return shares;
  }
  var CASHBACK_PCT = { base: 2, plus: 10 };
  function rideCashback(fare, plus) {
    return Math.round(fare * (plus ? CASHBACK_PCT.plus : CASHBACK_PCT.base)) / 100;
  }

  /* ── Orbit+ membership ──────────────────────────────────────────── */
  var PLUS_PRICE = 9.99, PLUS_TRIAL_DAYS = 30;
  var PLUS_PERKS = [
    '10% of every ride fare back as Orbit Cash (vs 2%)',
    'Free food delivery on baskets over £' + EAT_FREE_DELIVERY_MIN,
    '20% off the bill at DineOut partner restaurants (vs 10%)',
    '10% off every parcel',
    'Priority driver matching in surge'
  ];
  function plusSavings(month) {
    var m = month || {};
    var rides = m.rideSpend || 0, deliveries = m.deliveriesSaved || 0, dineOut = m.dineOutSpend || 0, parcels = m.parcelSpend || 0;
    var saved = rides * (CASHBACK_PCT.plus - CASHBACK_PCT.base) / 100 + deliveries + dineOut * 0.10 + parcels * 0.10;
    return Math.round(saved * 100) / 100;
  }

  /* ── rewards: points & tiers ────────────────────────────────────── */
  var POINTS_PER_POUND = { ride: 5, eat: 3, send: 2, pay: 1 };
  function pointsFor(kind, amount) {
    var rate = POINTS_PER_POUND[kind] || 0;
    return Math.max(0, Math.floor(amount * rate));
  }
  var TIERS = [
    { id: 'bronze',   name: 'Bronze',   at: 0,     perk: 'Member pricing' },
    { id: 'silver',   name: 'Silver',   at: 1500,  perk: '+10% bonus points' },
    { id: 'gold',     name: 'Gold',     at: 5000,  perk: 'Free monthly delivery + priority support' },
    { id: 'platinum', name: 'Platinum', at: 12000, perk: 'Free Comfort upgrades + lounge invites' }
  ];
  function tierFor(points) {
    var t = TIERS[0];
    TIERS.forEach(function (x) { if (points >= x.at) t = x; });
    return t;
  }
  function nextTier(points) {
    for (var i = 0; i < TIERS.length; i++) if (points < TIERS[i].at) return TIERS[i];
    return null;
  }
  var REDEEM_RATE = { points: 500, credit: 2.5 };
  function redeemQuote(points) {
    var blocks = Math.floor(points / REDEEM_RATE.points);
    return { blocks: blocks, points: blocks * REDEEM_RATE.points, credit: Math.round(blocks * REDEEM_RATE.credit * 100) / 100 };
  }

  /* ── MARKET — Quik groceries from the Old Town dark store ───────── */
  var MARKET_STORE_AT = 'oldtown';
  var MARKET_AISLES = [
    { id: 'fresh',  name: 'Fresh', emoji: '🥬', items: [['Bananas (6)', 1.2], ['Avocado', 1.5], ['Cherry tomatoes', 2.1], ['Baby spinach', 1.8], ['Lemons (3)', 1.4]] },
    { id: 'bakery', name: 'Bakery', emoji: '🥐', items: [['Sourdough loaf', 3.2], ['Croissants (4)', 3.8], ['Bagels (5)', 2.9]] },
    { id: 'dairy',  name: 'Dairy & eggs', emoji: '🥛', items: [['Milk 2L', 1.9], ['Free-range eggs (12)', 3.4], ['Greek yoghurt', 2.6], ['Halloumi', 3.1]] },
    { id: 'pantry', name: 'Pantry', emoji: '🍝', items: [['Spaghetti 500g', 1.6], ['Passata', 1.3], ['Olive oil 500ml', 5.8], ['Basmati rice 1kg', 3.2]] },
    { id: 'snacks', name: 'Snacks & drinks', emoji: '🥤', items: [['Dark chocolate', 2.4], ['Salted crisps', 1.9], ['Sparkling water (6)', 3.0], ['Orange juice 1L', 2.7]] },
    { id: 'home',   name: 'Household', emoji: '🧻', items: [['Kitchen roll (2)', 2.2], ['Washing-up liquid', 1.8], ['Toothpaste', 2.5]] }
  ];
  var QUIK_FEE = 1.99, QUIK_FREE_MIN = 20, QUIK_SMALL_MIN = 10, QUIK_SMALL_FEE = 1.0;
  var QUIK_PROMISE_MIN = 15, QUIK_LATE_CREDIT = 2.0, QUIK_PICK_MIN = 4;
  function quikQuote(dropId, basketTotal, opts) {
    if (!place(dropId) || !(basketTotal > 0)) return null;
    opts = opts || {};
    var km = roadKm(MARKET_STORE_AT, dropId);
    var etaMin = QUIK_PICK_MIN + Math.max(2, Math.round((km / 32) * 60 * trafficFactor(opts.when != null ? opts.when : 0)));
    var fee = opts.plus && basketTotal >= QUIK_FREE_MIN ? 0 : QUIK_FEE;
    var small = basketTotal < QUIK_SMALL_MIN ? QUIK_SMALL_FEE : 0;
    var total = Math.round((basketTotal + fee + small) * 100) / 100;
    return {
      km: km, etaMin: etaMin, promise15: etaMin <= QUIK_PROMISE_MIN, lateCredit: QUIK_LATE_CREDIT,
      basket: Math.round(basketTotal * 100) / 100, fee: fee, smallOrderFee: small, total: total
    };
  }
  var QUIK_FLOW = ['PLACED', 'PACKING', 'RIDER_ON_WAY', 'DELIVERED'];
  function quikAdvance(order, nowMs) {
    var i = QUIK_FLOW.indexOf(order.status);
    if (i < 0 || i >= QUIK_FLOW.length - 1) return order;
    order.status = QUIK_FLOW[i + 1];
    order.log.push({ status: order.status, ms: nowMs });
    return order;
  }

  /* ── CAPTAIN — the driver's side of the marketplace ─────────────── */
  var CAPTAIN_CUT = 0.80; // captains keep 80p in the pound, always shown
  function captainEarn(fare) {
    var driver = Math.round(fare * CAPTAIN_CUT * 100) / 100;
    return { driver: driver, orbit: Math.round((fare - driver) * 100) / 100 };
  }
  function captainOffers(seedKey, when, n) {
    var rng = rngFor('cap:' + seedKey);
    var out = [], count = n || 4;
    for (var i = 0; i < count; i++) {
      var from = PLACES[Math.floor(rng() * PLACES.length)];
      var to = PLACES[Math.floor(rng() * PLACES.length)];
      if (from.id === to.id) { to = PLACES[(PLACES.indexOf(to) + 1) % PLACES.length]; }
      var clsPool = ['go', 'go', 'go', 'comfort', 'mini', 'green'];
      var cls = clsPool[Math.floor(rng() * clsPool.length)];
      var q = quote(from.id, to.id, cls, when);
      if (!q) { i--; continue; }
      out.push({
        id: 'O' + i + hashStr(seedKey + i).toString(36).slice(0, 4).toUpperCase(),
        fromId: from.id, toId: to.id, classId: cls,
        fare: q.total, km: q.km, mins: q.mins,
        pickupKm: Math.round((0.4 + rng() * 2.4) * 10) / 10,
        surge: q.surge, expiresSec: 15,
        earn: captainEarn(q.total).driver
      });
    }
    return out;
  }
  function acceptanceRate(accepted, seen) {
    if (!(seen > 0)) return null;
    return Math.round((accepted / seen) * 100);
  }
  function captainDaySummary(fares) {
    var gross = 0;
    (fares || []).forEach(function (f) { gross += f; });
    gross = Math.round(gross * 100) / 100;
    var net = captainEarn(gross).driver;
    return { trips: (fares || []).length, gross: gross, net: net };
  }

  /* ── misc ───────────────────────────────────────────────────────── */
  function fmtMoney(n) {
    var sign = n < 0 ? '−' : '';
    return sign + '£' + Math.abs(n).toFixed(2);
  }

  return {
    version: '1.3.0',
    WHEELS: WHEELS, wheelMode: wheelMode, STATION_IDS: STATION_IDS, isStation: isStation,
    stationDocks: stationDocks, wheelsQuote: wheelsQuote,
    fareTimeline: fareTimeline, cheapestWindow: cheapestWindow,
    expenseReport: expenseReport,
    STOP_FEE: STOP_FEE, multiStopQuote: multiStopQuote, pathThrough: pathThrough,
    TIP_PRESETS: TIP_PRESETS, tipEarn: tipEarn,
    PASS_RIDES: PASS_RIDES, PASS_DISCOUNT: PASS_DISCOUNT, PASS_DAYS: PASS_DAYS,
    routePassQuote: routePassQuote, passCovers: passCovers,
    PAYLATER_LIMIT: PAYLATER_LIMIT, monthKey: monthKey, plDue: plDue,
    plCanCharge: plCanCharge, plCharge: plCharge, plSettle: plSettle,
    REFERRAL_BONUS: REFERRAL_BONUS, referralCode: referralCode, applyReferral: applyReferral,
    MARKET_STORE_AT: MARKET_STORE_AT, MARKET_AISLES: MARKET_AISLES,
    QUIK_FEE: QUIK_FEE, QUIK_FREE_MIN: QUIK_FREE_MIN, QUIK_SMALL_MIN: QUIK_SMALL_MIN,
    QUIK_PROMISE_MIN: QUIK_PROMISE_MIN, QUIK_LATE_CREDIT: QUIK_LATE_CREDIT,
    quikQuote: quikQuote, QUIK_FLOW: QUIK_FLOW, quikAdvance: quikAdvance,
    CAPTAIN_CUT: CAPTAIN_CUT, captainEarn: captainEarn, captainOffers: captainOffers,
    acceptanceRate: acceptanceRate, captainDaySummary: captainDaySummary,
    hashStr: hashStr, mulberry32: mulberry32, rngFor: rngFor, partsOf: partsOf,
    PLACES: PLACES, place: place, roadKm: roadKm, WINDING: WINDING,
    pathPoints: pathPoints, pathLen: pathLen, posAlong: posAlong,
    RIDE_CLASSES: RIDE_CLASSES, rideClass: rideClass, BOOKING_FEE: BOOKING_FEE,
    surgeAt: surgeAt, trafficFactor: trafficFactor, rideMins: rideMins, co2g: co2g,
    quote: quote, quoteAll: quoteAll,
    driversNear: driversNear, matchDriver: matchDriver,
    BID_FLOOR: BID_FLOOR, bidResponses: bidResponses, bestBid: bestBid,
    TRIP_FLOW: TRIP_FLOW, createTrip: createTrip, tripAdvance: tripAdvance,
    cancelQuote: cancelQuote, cancelTrip: cancelTrip,
    tripPin: tripPin, shareCode: shareCode,
    validateSchedule: validateSchedule, LOCK_FEE_PCT: LOCK_FEE_PCT, LOCK_DAYS: LOCK_DAYS,
    priceLockQuote: priceLockQuote, lockValid: lockValid,
    RESTAURANTS: RESTAURANTS, restaurant: restaurant, eatQuote: eatQuote,
    ORDER_FLOW: ORDER_FLOW, orderAdvance: orderAdvance, dineOutPct: dineOutPct,
    EAT_FREE_DELIVERY_MIN: EAT_FREE_DELIVERY_MIN,
    PARCEL_SIZES: PARCEL_SIZES, parcelSize: parcelSize, sendQuote: sendQuote,
    SEND_FLOW: SEND_FLOW, sendAdvance: sendAdvance,
    walletBalance: walletBalance, makeTx: makeTx, canSpend: canSpend, splitBill: splitBill,
    CASHBACK_PCT: CASHBACK_PCT, rideCashback: rideCashback,
    PLUS_PRICE: PLUS_PRICE, PLUS_TRIAL_DAYS: PLUS_TRIAL_DAYS, PLUS_PERKS: PLUS_PERKS, plusSavings: plusSavings,
    POINTS_PER_POUND: POINTS_PER_POUND, pointsFor: pointsFor,
    TIERS: TIERS, tierFor: tierFor, nextTier: nextTier, REDEEM_RATE: REDEEM_RATE, redeemQuote: redeemQuote,
    fmtMoney: fmtMoney
  };
}));
