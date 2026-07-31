/*
 * TravelDeals Engine — the pure, deterministic core behind the flight & hotel
 * deals app. Everything that decides a price, scores a deal, forecasts a fare,
 * validates a booking or computes a refund lives here, clock-injected and
 * seeded, so the same search always returns the same answer and every rule is
 * unit-testable (scripts/test-deals-logic.mjs).
 *
 * Honesty note: with no server, fares are a *simulation* — a distance-based
 * price model over a real airport database (great-circle distances), with
 * advance-purchase and seasonality curves shaped like the real market. It is
 * a demo of the product, not a fare feed. Live mode (server.mjs + Amadeus
 * test API) swaps in real offers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DealsEngine = factory();
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

  /* ── airport database (real coords → real great-circle distances) ── */
  // code: [city, country-code, lat, lon, region]
  var AIRPORTS = {
    JFK: ['New York', 'US', 40.64, -73.78, 'NA'], BOS: ['Boston', 'US', 42.36, -71.01, 'NA'],
    ORD: ['Chicago', 'US', 41.97, -87.91, 'NA'], MIA: ['Miami', 'US', 25.80, -80.29, 'NA'],
    ATL: ['Atlanta', 'US', 33.64, -84.43, 'NA'], DFW: ['Dallas', 'US', 32.90, -97.04, 'NA'],
    DEN: ['Denver', 'US', 39.86, -104.67, 'NA'], LAS: ['Las Vegas', 'US', 36.08, -115.15, 'NA'],
    LAX: ['Los Angeles', 'US', 33.94, -118.41, 'NA'], SFO: ['San Francisco', 'US', 37.62, -122.38, 'NA'],
    SEA: ['Seattle', 'US', 47.45, -122.31, 'NA'], MCO: ['Orlando', 'US', 28.43, -81.31, 'NA'],
    IAH: ['Houston', 'US', 29.98, -95.34, 'NA'], PHX: ['Phoenix', 'US', 33.44, -112.01, 'NA'],
    YYZ: ['Toronto', 'CA', 43.68, -79.63, 'NA'], YVR: ['Vancouver', 'CA', 49.19, -123.18, 'NA'],
    MEX: ['Mexico City', 'MX', 19.44, -99.07, 'NA'], CUN: ['Cancún', 'MX', 21.04, -86.87, 'NA'],
    GRU: ['São Paulo', 'BR', -23.43, -46.47, 'SA'], EZE: ['Buenos Aires', 'AR', -34.82, -58.54, 'SA'],
    BOG: ['Bogotá', 'CO', 4.70, -74.15, 'SA'], LIM: ['Lima', 'PE', -12.02, -77.11, 'SA'],
    LHR: ['London', 'GB', 51.47, -0.45, 'EU'], MAN: ['Manchester', 'GB', 53.35, -2.28, 'EU'],
    EDI: ['Edinburgh', 'GB', 55.95, -3.37, 'EU'], DUB: ['Dublin', 'IE', 53.43, -6.25, 'EU'],
    CDG: ['Paris', 'FR', 49.01, 2.55, 'EU'], NCE: ['Nice', 'FR', 43.66, 7.22, 'EU'],
    AMS: ['Amsterdam', 'NL', 52.31, 4.76, 'EU'], FRA: ['Frankfurt', 'DE', 50.03, 8.56, 'EU'],
    MUC: ['Munich', 'DE', 48.35, 11.79, 'EU'], BER: ['Berlin', 'DE', 52.37, 13.51, 'EU'],
    ZRH: ['Zurich', 'CH', 47.46, 8.55, 'EU'], GVA: ['Geneva', 'CH', 46.24, 6.11, 'EU'],
    MAD: ['Madrid', 'ES', 40.47, -3.56, 'EU'], BCN: ['Barcelona', 'ES', 41.30, 2.08, 'EU'],
    LIS: ['Lisbon', 'PT', 38.77, -9.13, 'EU'], FCO: ['Rome', 'IT', 41.80, 12.24, 'EU'],
    MXP: ['Milan', 'IT', 45.63, 8.72, 'EU'], VCE: ['Venice', 'IT', 45.51, 12.35, 'EU'],
    VIE: ['Vienna', 'AT', 48.11, 16.57, 'EU'], PRG: ['Prague', 'CZ', 50.10, 14.26, 'EU'],
    WAW: ['Warsaw', 'PL', 52.17, 20.97, 'EU'], BUD: ['Budapest', 'HU', 47.44, 19.26, 'EU'],
    ARN: ['Stockholm', 'SE', 59.65, 17.92, 'EU'], CPH: ['Copenhagen', 'DK', 55.62, 12.65, 'EU'],
    OSL: ['Oslo', 'NO', 60.19, 11.10, 'EU'], HEL: ['Helsinki', 'FI', 60.32, 24.96, 'EU'],
    ATH: ['Athens', 'GR', 37.94, 23.94, 'EU'], IST: ['Istanbul', 'TR', 41.26, 28.74, 'EU'],
    DXB: ['Dubai', 'AE', 25.25, 55.36, 'ME'], AUH: ['Abu Dhabi', 'AE', 24.43, 54.65, 'ME'],
    DOH: ['Doha', 'QA', 25.27, 51.61, 'ME'], RUH: ['Riyadh', 'SA', 24.96, 46.70, 'ME'],
    JED: ['Jeddah', 'SA', 21.68, 39.16, 'ME'], AMM: ['Amman', 'JO', 31.72, 35.99, 'ME'],
    CAI: ['Cairo', 'EG', 30.12, 31.41, 'AF'], CMN: ['Casablanca', 'MA', 33.37, -7.59, 'AF'],
    JNB: ['Johannesburg', 'ZA', -26.14, 28.25, 'AF'], CPT: ['Cape Town', 'ZA', -33.96, 18.60, 'AF'],
    NBO: ['Nairobi', 'KE', -1.32, 36.93, 'AF'], LOS: ['Lagos', 'NG', 6.58, 3.32, 'AF'],
    DEL: ['Delhi', 'IN', 28.57, 77.10, 'AS'], BOM: ['Mumbai', 'IN', 19.09, 72.87, 'AS'],
    BLR: ['Bengaluru', 'IN', 13.20, 77.71, 'AS'], DAC: ['Dhaka', 'BD', 23.84, 90.40, 'AS'],
    SIN: ['Singapore', 'SG', 1.36, 103.99, 'AS'], KUL: ['Kuala Lumpur', 'MY', 2.75, 101.71, 'AS'],
    BKK: ['Bangkok', 'TH', 13.69, 100.75, 'AS'], HKT: ['Phuket', 'TH', 8.11, 98.31, 'AS'],
    SGN: ['Ho Chi Minh City', 'VN', 10.82, 106.66, 'AS'], MNL: ['Manila', 'PH', 14.51, 121.02, 'AS'],
    CGK: ['Jakarta', 'ID', -6.13, 106.66, 'AS'], DPS: ['Bali', 'ID', -8.75, 115.17, 'AS'],
    HKG: ['Hong Kong', 'HK', 22.31, 113.91, 'AS'], TPE: ['Taipei', 'TW', 25.08, 121.23, 'AS'],
    ICN: ['Seoul', 'KR', 37.46, 126.44, 'AS'], NRT: ['Tokyo', 'JP', 35.76, 140.39, 'AS'],
    HND: ['Tokyo', 'JP', 35.55, 139.78, 'AS'], KIX: ['Osaka', 'JP', 34.43, 135.24, 'AS'],
    PEK: ['Beijing', 'CN', 40.08, 116.58, 'AS'], PVG: ['Shanghai', 'CN', 31.14, 121.81, 'AS'],
    SYD: ['Sydney', 'AU', -33.95, 151.18, 'OC'], MEL: ['Melbourne', 'AU', -37.67, 144.84, 'OC'],
    BNE: ['Brisbane', 'AU', -27.38, 153.12, 'OC'], AKL: ['Auckland', 'NZ', -37.01, 174.79, 'OC']
  };
  // Metro / city aliases people actually type
  var CITY_ALIAS = { NYC: 'JFK', LON: 'LHR', PAR: 'CDG', TYO: 'HND', ROM: 'FCO', MIL: 'MXP', SAO: 'GRU', BUE: 'EZE', WAS: 'JFK', CHI: 'ORD', TOK: 'HND' };

  var AIRLINES = {
    NA: [['DL', 'Delta'], ['UA', 'United'], ['AA', 'American'], ['B6', 'JetBlue'], ['AS', 'Alaska'], ['AC', 'Air Canada'], ['WS', 'WestJet'], ['AM', 'Aeroméxico']],
    SA: [['LA', 'LATAM'], ['AV', 'Avianca'], ['G3', 'GOL'], ['AR', 'Aerolíneas']],
    EU: [['BA', 'British Airways'], ['LH', 'Lufthansa'], ['AF', 'Air France'], ['KL', 'KLM'], ['IB', 'Iberia'], ['LX', 'SWISS'], ['TK', 'Turkish'], ['FR', 'Ryanair'], ['U2', 'easyJet']],
    ME: [['EK', 'Emirates'], ['QR', 'Qatar Airways'], ['EY', 'Etihad'], ['SV', 'Saudia']],
    AF: [['ET', 'Ethiopian'], ['MS', 'EgyptAir'], ['KQ', 'Kenya Airways'], ['AT', 'Royal Air Maroc']],
    AS: [['SQ', 'Singapore Airlines'], ['CX', 'Cathay Pacific'], ['NH', 'ANA'], ['JL', 'JAL'], ['KE', 'Korean Air'], ['TG', 'Thai'], ['AI', 'Air India'], ['6E', 'IndiGo']],
    OC: [['QF', 'Qantas'], ['NZ', 'Air New Zealand'], ['VA', 'Virgin Australia']]
  };
  var HUBS = { NA: ['ATL', 'ORD', 'DFW'], SA: ['GRU', 'BOG'], EU: ['LHR', 'FRA', 'AMS', 'IST'], ME: ['DXB', 'DOH'], AF: ['CAI', 'NBO'], AS: ['SIN', 'HKG', 'ICN'], OC: ['SYD'] };

  var CABIN_MULT = { economy: 1, premium: 1.85, business: 3.4, first: 5.6 };
  var RATES = { USD: 1, GBP: 0.78, EUR: 0.92 };           // indicative, static
  var SYMBOL = { USD: '$', GBP: '£', EUR: '€' };

  /* ── date & geo helpers ─────────────────────────────────────────── */
  function parseISO(iso) { return new Date(iso + 'T00:00:00Z').getTime(); }
  function daysBetween(fromISO, toISO) { return Math.round((parseISO(toISO) - parseISO(fromISO)) / 86400000); }
  function addDays(iso, n) {
    var d = new Date(parseISO(iso) + n * 86400000);
    return d.toISOString().slice(0, 10);
  }
  function toRad(x) { return x * Math.PI / 180; }
  function haversineKm(a, b) {
    var la1 = toRad(a[0]), la2 = toRad(b[0]), dLa = la2 - la1, dLo = toRad(b[1] - a[1]);
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return Math.round(6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
  }
  function resolveAirport(code) {
    var c = String(code || '').toUpperCase().trim();
    if (CITY_ALIAS[c]) c = CITY_ALIAS[c];
    return AIRPORTS[c] ? c : null;
  }
  function airportInfo(code) {
    var c = resolveAirport(code);
    if (!c) return null;
    var a = AIRPORTS[c];
    return { code: c, city: a[0], cc: a[1], lat: a[2], lon: a[3], region: a[4] };
  }
  function flagEmoji(cc) {
    return String.fromCodePoint(127397 + cc.charCodeAt(0), 127397 + cc.charCodeAt(1));
  }

  /* ── the price model ────────────────────────────────────────────── */
  // Advance-purchase curve: the shape every fare analyst knows — steep inside
  // two weeks, cheapest 6–12 weeks out, slightly higher a long way out.
  function advanceFactor(daysOut) {
    if (daysOut < 0) return 1.6;
    if (daysOut < 3) return 1.55;
    if (daysOut < 7) return 1.42;
    if (daysOut < 14) return 1.22;
    if (daysOut < 21) return 1.1;
    if (daysOut < 45) return 1.0;
    if (daysOut < 90) return 0.92;
    return 0.97;
  }
  var MONTH_F = [0.95, 0.9, 0.95, 1.0, 1.02, 1.15, 1.25, 1.22, 1.02, 1.0, 0.95, 1.18];
  function seasonFactor(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    var f = MONTH_F[d.getUTCMonth()];
    var dow = d.getUTCDay();
    if (dow === 5 || dow === 0) f *= 1.07;       // Fri / Sun departures
    else if (dow === 2 || dow === 3) f *= 0.95;  // Tue / Wed are cheapest
    return f;
  }
  function basePrice(km, cabin) {
    return (26 + km * 0.085) * (CABIN_MULT[cabin] || 1);
  }
  // Deterministic market price for a one-way, if you booked on queryISO.
  function priceOn(origin, dest, travelISO, queryISO, cabin) {
    var o = airportInfo(origin), d = airportInfo(dest);
    if (!o || !d) return null;
    var km = haversineKm([o.lat, o.lon], [d.lat, d.lon]);
    var noise = 0.9 + rngFor(o.code + d.code + travelISO)() * 0.2;          // fixed per trip
    var wobble = 0.9 + rngFor('w:' + o.code + d.code + queryISO)() * 0.2;   // the market moves day to day
    var p = basePrice(km, cabin || 'economy') * advanceFactor(daysBetween(queryISO, travelISO)) * seasonFactor(travelISO) * noise * wobble;
    return Math.max(29, Math.round(p));
  }

  /* ── flight search ──────────────────────────────────────────────── */
  function routeAirlines(o, d) {
    var list = AIRLINES[o.region].concat(o.region === d.region ? [] : AIRLINES[d.region]);
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) if (!seen[list[i][0]]) { seen[list[i][0]] = 1; out.push(list[i]); }
    return out;
  }
  function fmtMin(m) { m = ((m % 1440) + 1440) % 1440; return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }

  function searchFlights(p) {
    var o = airportInfo(p.origin), d = airportInfo(p.dest);
    if (!o || !d) return { error: 'Unknown airport — try a code like JFK, LHR, DXB' };
    if (o.code === d.code) return { error: 'Origin and destination are the same' };
    if (daysBetween(p.today, p.depart) < 0) return { error: 'Departure date is in the past' };
    if (p.ret && daysBetween(p.depart, p.ret) < 0) return { error: 'Return is before departure' };

    var km = haversineKm([o.lat, o.lon], [d.lat, d.lon]);
    var durMin = Math.round(45 + km / 13.5);
    var airlines = routeAirlines(o, d);
    var market = priceOn(o.code, d.code, p.depart, p.today, p.cabin);
    var back = p.ret ? priceOn(d.code, o.code, p.ret, p.today, p.cabin) : 0;
    var rng = rngFor(o.code + d.code + p.depart + (p.ret || '') + (p.cabin || 'economy'));
    var n = 9 + Math.floor(rng() * 3);
    var offers = [];
    for (var i = 0; i < n; i++) {
      var al = airlines[Math.floor(rng() * airlines.length)];
      var stops = km > 7500 ? (rng() < 0.65 ? 1 : 0) : (rng() < 0.3 ? 1 : 0);
      var via = null, legDur = durMin;
      if (stops) {
        var hubs = HUBS[rng() < 0.5 ? o.region : d.region];
        via = hubs[Math.floor(rng() * hubs.length)];
        if (via === o.code || via === d.code) via = hubs[0] === via ? hubs[hubs.length - 1] : hubs[0];
        legDur = durMin + 95 + Math.floor(rng() * 75);
      }
      var f = 0.82 + rng() * 0.5 + (stops ? 0 : 0.12);
      var price = Math.round((market + back * 0.92) * f);
      var dep = 300 + Math.floor(rng() * 96) * 15;   // 05:00–23:45
      offers.push({
        id: o.code + d.code + p.depart + '-' + i,
        airline: { code: al[0], name: al[1] },
        fn: al[0] + (100 + Math.floor(rng() * 880)),
        dep: fmtMin(dep), arr: fmtMin(dep + legDur), nextDay: (dep + legDur) >= 1440,
        durMin: legDur, stops: stops, via: via,
        price: price, seatsLeft: 1 + Math.floor(rng() * 9),
        fares: [
          { brand: 'Saver', price: price, refundable: false, changes: false, bag: false, seat: false },
          { brand: 'Flex', price: Math.round(price * 1.24), refundable: true, changes: true, bag: true, seat: true },
          { brand: 'Premium', price: Math.round(price * 1.52), refundable: true, changes: true, bag: true, seat: true }
        ]
      });
    }
    offers.sort(function (a, b) { return a.price - b.price; });
    return { offers: offers, km: km, market: market + Math.round(back * 0.92), origin: o, dest: d };
  }

  /* ── price history, forecast, deal score ────────────────────────── */
  function priceHistory(p, days) {
    days = days || 60;
    var out = [];
    for (var k = days - 1; k >= 0; k--) {
      var q = addDays(p.today, -k);
      if (daysBetween(q, p.depart) < 0) continue;
      var v = priceOn(p.origin, p.dest, p.depart, q, p.cabin);
      if (p.ret) v += Math.round(priceOn(p.dest, p.origin, p.ret, q, p.cabin) * 0.92);
      out.push({ d: q, p: v });
    }
    return out;
  }
  function typical(history) {
    if (!history.length) return 0;
    var v = history.map(function (h) { return h.p; }).sort(function (a, b) { return a - b; });
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
  }
  function forecast(history, daysOut) {
    if (history.length < 10) return { advice: 'track', trend: 'flat', pct: 0, reason: 'Not enough history yet — tracking this route.' };
    var last7 = history.slice(-7), prior = history.slice(-21, -7);
    var avg = function (a) { return a.reduce(function (s, h) { return s + h.p; }, 0) / a.length; };
    var slope = (avg(last7) - avg(prior)) / typical(history);
    var curveAhead = advanceFactor(Math.max(0, daysOut - 14)) / advanceFactor(daysOut) - 1;
    var pct = Math.round((curveAhead + slope) * 100);
    if (daysOut <= 14) return { advice: 'buy', trend: 'rising', pct: Math.max(pct, 8), reason: 'Inside the 2-week advance-purchase window — fares rarely fall from here.' };
    if (slope < -0.015 && daysOut > 30) return { advice: 'wait', trend: 'falling', pct: pct, reason: 'Prices on this route have been drifting down and departure is far out.' };
    if (slope > 0.02 || pct > 6) return { advice: 'buy', trend: 'rising', pct: pct, reason: 'Prices are trending up — booking now beats the likely rise.' };
    return { advice: 'track', trend: 'flat', pct: pct, reason: 'Prices look stable — set a watch and we’ll flag any drop.' };
  }
  function dealScore(price, typ) {
    if (!typ) return 50;
    return Math.max(1, Math.min(99, Math.round(50 + ((typ - price) / typ) * 150)));
  }
  function scoreLabel(s) { return s >= 80 ? 'Exceptional deal' : s >= 65 ? 'Great deal' : s >= 45 ? 'Fair price' : 'Above typical'; }

  function flexGrid(p, span) {
    span = span || 3;
    var out = [];
    for (var k = -span; k <= span; k++) {
      var dt = addDays(p.depart, k);
      if (daysBetween(p.today, dt) < 0) continue;
      var v = priceOn(p.origin, p.dest, dt, p.today, p.cabin);
      if (p.ret) v += Math.round(priceOn(p.dest, p.origin, addDays(p.ret, k), p.today, p.cabin) * 0.92);
      out.push({ date: dt, price: v, offset: k });
    }
    var min = Math.min.apply(null, out.map(function (x) { return x.price; }));
    out.forEach(function (x) { x.best = x.price === min; });
    return out;
  }

  /* ── Everywhere search (Skyscanner-style explore) ───────────────── */
  function searchAnywhere(origin, today) {
    var o = airportInfo(origin);
    if (!o) return { error: 'Unknown origin airport' };
    var depart = addDays(today, 28), ret = addDays(today, 35);
    var out = [];
    for (var code in AIRPORTS) {
      if (code === o.code || AIRPORTS[code][0] === o.city) continue;
      var price = priceOn(o.code, code, depart, today, 'economy') +
                  Math.round(priceOn(code, o.code, ret, today, 'economy') * 0.92);
      var hist = priceHistory({ origin: o.code, dest: code, depart: depart, ret: ret, today: today, cabin: 'economy' }, 45);
      var typ = typical(hist);
      out.push({ code: code, city: AIRPORTS[code][0], cc: AIRPORTS[code][1], flag: flagEmoji(AIRPORTS[code][1]), price: price, typical: typ, score: dealScore(price, typ), depart: depart, ret: ret });
    }
    out.sort(function (a, b) { return b.score - a.score || a.price - b.price; });
    return { results: out.slice(0, 12), depart: depart, ret: ret };
  }

  /* ── seats ──────────────────────────────────────────────────────── */
  function seatMap(seed) {
    var rng = rngFor('seats:' + seed);
    var rows = [];
    for (var r = 1; r <= 14; r++) {
      var cls = r <= 3 ? 'front' : r === 8 ? 'exit' : 'std';
      var price = cls === 'front' ? 18 : cls === 'exit' ? 26 : 0;
      var seats = 'ABCDEF'.split('').map(function (L) {
        return { id: r + L, cls: cls, price: price, taken: rng() < 0.42 };
      });
      rows.push({ n: r, cls: cls, seats: seats });
    }
    return rows;
  }

  /* ── validation (Luhn included, from scratch) ───────────────────── */
  function luhn(num) {
    var s = String(num).replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(s)) return false;
    var sum = 0, alt = false;
    for (var i = s.length - 1; i >= 0; i--) {
      var d = s.charCodeAt(i) - 48;
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return sum % 10 === 0;
  }
  function validTraveler(t) {
    var e = [];
    if (!t.first || t.first.trim().length < 2) e.push('First name');
    if (!t.last || t.last.trim().length < 2) e.push('Last name');
    if (!t.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t.email)) e.push('Valid email');
    return e;
  }
  function validPayment(p, todayISO) {
    var e = [];
    if (!luhn(p.number)) e.push('Card number');
    var m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(p.expiry || '');
    if (!m || +m[1] < 1 || +m[1] > 12) e.push('Expiry (MM/YY)');
    else {
      var expEnd = Date.UTC(2000 + +m[2], +m[1], 1);
      if (expEnd <= parseISO(todayISO)) e.push('Card expired');
    }
    if (!/^\d{3,4}$/.test(p.cvv || '')) e.push('CVV');
    if (!p.name || p.name.trim().length < 3) e.push('Name on card');
    return e;
  }

  /* ── booking, refunds, loyalty ──────────────────────────────────── */
  var PNR_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789';
  function makePNR(seed) {
    var rng = rngFor('pnr:' + seed), s = '';
    for (var i = 0; i < 6; i++) s += PNR_ALPHABET[Math.floor(rng() * PNR_ALPHABET.length)];
    return s;
  }
  function priceBooking(q) {
    var base = q.farePrice * q.adults;
    var seats = (q.seats || []).reduce(function (s, x) { return s + (x.price || 0); }, 0);
    var bags = (q.bags || 0) * 35;
    var insurance = q.insurance ? 12 * q.adults : 0;
    var taxes = Math.round(base * 0.13) + 24;
    return { base: base, seats: seats, bags: bags, insurance: insurance, taxes: taxes,
             total: base + seats + bags + insurance + taxes };
  }
  var REFUND_RULES = { Saver: { refundPct: 0, creditPct: 60 }, Flex: { refundPct: 100, creditPct: 100 }, Premium: { refundPct: 100, creditPct: 100 } };
  function refundQuote(brand, total) {
    var r = REFUND_RULES[brand] || REFUND_RULES.Saver;
    return { refund: Math.round(total * r.refundPct / 100), credit: Math.round(total * r.creditPct / 100), rule: r };
  }
  function holdQuote(price, todayISO) {
    return { fee: Math.max(5, Math.round(price * 0.05)), expires: addDays(todayISO, 2) };
  }
  function pointsEarned(totalUSD) { return Math.round(totalUSD * 5); }
  var TIERS = [['Member', 0], ['Silver', 5000], ['Gold', 15000], ['Platinum', 40000]];
  function tierFor(points) {
    var t = TIERS[0], next = null;
    for (var i = 0; i < TIERS.length; i++) {
      if (points >= TIERS[i][1]) t = TIERS[i];
      else { next = TIERS[i]; break; }
    }
    return { name: t[0], floor: t[1], next: next ? next[0] : null, nextAt: next ? next[1] : null,
             pct: next ? Math.min(100, Math.round((points - t[1]) / (next[1] - t[1]) * 100)) : 100 };
  }
  // Booking.com-Genius-style stay discounts: 5 stays → 10%, 15 → 15%, 30 → 20%.
  function stayDiscountPct(stays) { return stays >= 30 ? 20 : stays >= 15 ? 15 : stays >= 5 ? 10 : 0; }

  /* ── hotels ─────────────────────────────────────────────────────── */
  var CITY_TIER1 = { 'New York': 1, London: 1, Paris: 1, Tokyo: 1, Dubai: 1, Singapore: 1, 'Hong Kong': 1, Sydney: 1, Zurich: 1, Geneva: 1 };
  var HOOD_FALLBACK = ['Old Town', 'Riverside', 'City Centre', 'Harbour District', 'Garden Quarter', 'Market Square'];
  var HOODS = { 'New York': ['Midtown', 'SoHo', 'Chelsea', 'Brooklyn'], London: ['Mayfair', 'Covent Garden', 'Shoreditch', 'Kensington'], Paris: ['Le Marais', 'Saint-Germain', 'Montmartre', 'Opéra'], Tokyo: ['Shinjuku', 'Shibuya', 'Ginza', 'Asakusa'], Dubai: ['Downtown', 'Marina', 'Jumeirah', 'Deira'], Rome: ['Trastevere', 'Monti', 'Prati', 'Centro'] };
  var HOTEL_TPL = ['Grand {H} Hotel', 'The {C} House', '{H} Plaza', 'Hotel {H}', '{H} Boutique Stay', 'The {H} Collection', '{C} Park Hotel', '{H} Suites', 'Maison {H}', '{H} Grand Palace', 'The {H} Residence', '{C} Skyline Hotel'];
  var AMENITY_POOL = ['Free WiFi', 'Pool', 'Gym', 'Spa', 'Restaurant', 'Bar', 'Room service', 'Airport shuttle', 'Parking', 'Pet friendly', 'Rooftop terrace', 'Laundry'];

  function searchHotels(p) {
    var a = airportInfo(p.city);
    if (!a) return { error: 'Unknown city — try a code like NYC, LON, PAR, DXB' };
    var nights = daysBetween(p.checkin, p.checkout);
    if (daysBetween(p.today, p.checkin) < 0) return { error: 'Check-in is in the past' };
    if (nights < 1) return { error: 'Check-out must be after check-in' };
    var adr = (CITY_TIER1[a.city] ? 205 : a.region === 'EU' || a.region === 'NA' ? 135 : 92);
    var hoods = HOODS[a.city] || HOOD_FALLBACK;
    var rng = rngFor('hotels:' + a.city + p.checkin);
    var season = seasonFactor(p.checkin);
    var hotels = [];
    for (var i = 0; i < 12; i++) {
      var stars = 2 + Math.floor(rng() * 4);
      var starF = [0, 0, 0.55, 0.75, 1.0, 1.6][stars];
      var hood = hoods[Math.floor(rng() * hoods.length)];
      var name = HOTEL_TPL[i].replace('{H}', hood).replace('{C}', a.city);
      var nightly = Math.max(38, Math.round(adr * starF * season * (0.8 + rng() * 0.45)));
      var rating = Math.min(9.8, Math.round((5.4 + stars * 0.7 + rng() * 1.5) * 10) / 10);
      var amenities = [];
      var start = Math.floor(rng() * 5);
      for (var k = 0; k < 4 + Math.floor(rng() * 4); k++) amenities.push(AMENITY_POOL[(start + k) % AMENITY_POOL.length]);
      var taxes = Math.round(nightly * nights * 0.11) + 4 * nights;
      hotels.push({
        id: a.city + '-' + i, name: name, stars: stars, rating: rating,
        reviews: 120 + Math.floor(rng() * 4600), hood: hood,
        distKm: Math.round((0.2 + rng() * 6.5) * 10) / 10,
        amenities: amenities, nightly: nightly, nights: nights, taxes: taxes,
        rates: [
          { plan: 'Room only', mult: 1, freeCancel: false, breakfast: false },
          { plan: 'Breakfast included', mult: 1.12, freeCancel: false, breakfast: true },
          { plan: 'Flexible + breakfast', mult: 1.22, freeCancel: true, breakfast: true }
        ]
      });
    }
    hotels.sort(function (x, y) { return x.nightly - y.nightly; });
    var med = hotels.map(function (h) { return h.nightly; }).sort(function (x, y) { return x - y; })[6];
    hotels.forEach(function (h) { h.score = dealScore(h.nightly, med * (0.9 + [0, 0, 0.55, 0.75, 1.0, 1.6][h.stars] / 3)); });
    return { hotels: hotels, city: a, nights: nights };
  }
  function priceHotel(q) {
    var room = Math.round(q.nightly * q.mult) * q.nights * q.rooms;
    var disc = Math.round(room * (q.discountPct || 0) / 100);
    var taxes = Math.round((room - disc) * 0.11) + 4 * q.nights * q.rooms;
    return { room: room, discount: disc, taxes: taxes, total: room - disc + taxes };
  }

  /* ── money, alerts, barcode ─────────────────────────────────────── */
  function convert(amt, from, to) { return Math.round(amt / RATES[from] * RATES[to]); }
  function fmtMoney(amt, cur) { return SYMBOL[cur] + Math.round(amt).toLocaleString('en-US'); }

  function alertsDue(watches, todayISO) {
    return watches.map(function (w) {
      var cur = priceOn(w.origin, w.dest, w.depart, todayISO, w.cabin || 'economy');
      if (w.ret) cur += Math.round(priceOn(w.dest, w.origin, w.ret, todayISO, w.cabin || 'economy') * 0.92);
      return { watch: w, current: cur, due: cur <= w.target && daysBetween(todayISO, w.depart) >= 0 };
    });
  }
  function barcode(seed, n) {
    var rng = rngFor('bar:' + seed), out = [];
    for (var i = 0; i < (n || 48); i++) out.push(1 + Math.floor(rng() * 3));
    return out;
  }

  return {
    version: '1.0.0',
    AIRPORTS: AIRPORTS, CITY_ALIAS: CITY_ALIAS, RATES: RATES, SYMBOL: SYMBOL,
    hashStr: hashStr, mulberry32: mulberry32, haversineKm: haversineKm,
    parseISO: parseISO, daysBetween: daysBetween, addDays: addDays,
    resolveAirport: resolveAirport, airportInfo: airportInfo, flagEmoji: flagEmoji,
    advanceFactor: advanceFactor, seasonFactor: seasonFactor, priceOn: priceOn,
    searchFlights: searchFlights, priceHistory: priceHistory, typical: typical,
    forecast: forecast, dealScore: dealScore, scoreLabel: scoreLabel, flexGrid: flexGrid,
    searchAnywhere: searchAnywhere, seatMap: seatMap,
    luhn: luhn, validTraveler: validTraveler, validPayment: validPayment,
    makePNR: makePNR, PNR_ALPHABET: PNR_ALPHABET, priceBooking: priceBooking,
    refundQuote: refundQuote, holdQuote: holdQuote,
    pointsEarned: pointsEarned, tierFor: tierFor, stayDiscountPct: stayDiscountPct,
    searchHotels: searchHotels, priceHotel: priceHotel,
    convert: convert, fmtMoney: fmtMoney, alertsDue: alertsDue, barcode: barcode
  };
}));
