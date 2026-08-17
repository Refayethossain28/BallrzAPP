/* Zenith — the pure sky engine.
 * =====================================================================
 * Zenith is a pocket planetarium: point it at any place and moment and it
 * tells you what the sky is doing — where every naked-eye planet sits, the
 * moon's phase and rise/set, the sun's twilights, a plottable chart of the
 * brightest stars and constellations, tonight's highlights and the meteor
 * calendar. Every equation lives HERE as pure, deterministic, clock-injected
 * functions with zero DOM and zero I/O — unit-tested in
 * scripts/test-zenith-logic.mjs, rendered by index.html.
 *
 * Positional accuracy targets a star chart, not a telescope mount: the
 * low-precision series here (Meeus / Astronomical Almanac, JPL approximate
 * Keplerian elements 1800–2050) land the sun within ~1', the moon within
 * ~0.3° and the planets within ~0.5° — far below what the eye can split.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
  var DEG = Math.PI / 180;

  /* ---------------- deterministic hashing ---------------- */
  // FNV-1a 32-bit — stable across platforms; picks the fact of the day.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- angles & time bases ---------------- */
  function wrap360(d) { return ((d % 360) + 360) % 360; }
  function wrap180(d) { var w = wrap360(d); return w > 180 ? w - 360 : w; }

  // Julian day from a JS timestamp; T = Julian centuries since J2000.0.
  function julianDay(ms) { return ms / DAY + 2440587.5; }
  function centuries(ms) { return (julianDay(ms) - 2451545.0) / 36525; }

  // Greenwich mean sidereal time, in degrees — the sky's own clock.
  function gmstDeg(ms) {
    var d = julianDay(ms) - 2451545.0;
    var T = d / 36525;
    return wrap360(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T * T * T / 38710000);
  }
  function lstDeg(lon, ms) { return wrap360(gmstDeg(ms) + (Number(lon) || 0)); }

  function obliquityDeg(ms) { return 23.439291 - 0.0130042 * centuries(ms); }

  // Ecliptic (λ, β) → equatorial (RA, Dec), all in degrees.
  function eclToEq(lambda, beta, ms) {
    var e = obliquityDeg(ms) * DEG, l = lambda * DEG, b = beta * DEG;
    var sinDec = Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l);
    var y = Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e);
    return {
      raDeg: wrap360(Math.atan2(y, Math.cos(l)) / DEG),
      decDeg: Math.asin(Math.max(-1, Math.min(1, sinDec))) / DEG
    };
  }

  // Equatorial → horizontal for an observer. Azimuth from north through east.
  function altAz(raDeg, decDeg, lat, lon, ms) {
    var H = (lstDeg(lon, ms) - raDeg) * DEG;
    var phi = (Number(lat) || 0) * DEG, dec = decDeg * DEG;
    var sinAlt = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
    var alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
    var az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) / DEG + 180;
    return { altDeg: alt / DEG, azDeg: wrap360(az) };
  }

  /* ---------------- the sun ---------------- */
  // Low-precision solar position (Astronomical Almanac): good to ~1'.
  function sunPosition(ms) {
    var n = julianDay(ms) - 2451545.0;
    var L = wrap360(280.460 + 0.9856474 * n);
    var g = wrap360(357.528 + 0.9856003 * n) * DEG;
    var lambda = wrap360(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
    var dist = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
    var eq = eclToEq(lambda, 0, ms);
    return { lambdaDeg: lambda, raDeg: eq.raDeg, decDeg: eq.decDeg, distAU: dist };
  }

  function sunAltAz(lat, lon, ms) {
    var s = sunPosition(ms);
    return altAz(s.raDeg, s.decDeg, lat, lon, ms);
  }

  /* ---------------- the moon ---------------- */
  // Truncated ELP series (Meeus ch.47 main terms): ~0.3° in longitude.
  function moonPosition(ms) {
    var T = centuries(ms);
    var Lp = wrap360(218.3164477 + 481267.88123421 * T);   // mean longitude
    var D = wrap360(297.8501921 + 445267.1114034 * T);     // mean elongation
    var M = wrap360(357.5291092 + 35999.0502909 * T);      // sun mean anomaly
    var Mp = wrap360(134.9633964 + 477198.8675055 * T);    // moon mean anomaly
    var F = wrap360(93.2720950 + 483202.0175233 * T);      // argument of latitude
    var d = D * DEG, m = M * DEG, mp = Mp * DEG, f = F * DEG;
    var lambda = Lp
      + 6.288774 * Math.sin(mp)
      + 1.274027 * Math.sin(2 * d - mp)
      + 0.658314 * Math.sin(2 * d)
      + 0.213618 * Math.sin(2 * mp)
      - 0.185116 * Math.sin(m)
      - 0.114332 * Math.sin(2 * f)
      + 0.058793 * Math.sin(2 * d - 2 * mp)
      + 0.057066 * Math.sin(2 * d - m - mp)
      + 0.053322 * Math.sin(2 * d + mp)
      + 0.045758 * Math.sin(2 * d - m);
    var beta = 5.128122 * Math.sin(f)
      + 0.280602 * Math.sin(mp + f)
      + 0.277693 * Math.sin(mp - f)
      + 0.173237 * Math.sin(2 * d - f);
    var distKm = 385000.56
      - 20905.355 * Math.cos(mp)
      - 3699.111 * Math.cos(2 * d - mp)
      - 2955.968 * Math.cos(2 * d)
      - 569.925 * Math.cos(2 * mp);
    var eq = eclToEq(wrap360(lambda), beta, ms);
    return { lambdaDeg: wrap360(lambda), betaDeg: beta, raDeg: eq.raDeg, decDeg: eq.decDeg, distKm: distKm };
  }

  var SYNODIC_DAYS = 29.530588861;
  var PHASE_NAMES = [
    { name: 'New Moon',        emoji: '🌑' },
    { name: 'Waxing Crescent', emoji: '🌒' },
    { name: 'First Quarter',   emoji: '🌓' },
    { name: 'Waxing Gibbous',  emoji: '🌔' },
    { name: 'Full Moon',       emoji: '🌕' },
    { name: 'Waning Gibbous',  emoji: '🌖' },
    { name: 'Last Quarter',    emoji: '🌗' },
    { name: 'Waning Crescent', emoji: '🌘' }
  ];

  // Phase from the sun–moon elongation D: illumination is (1−cos D)/2,
  // the 8 names split D into 45° buckets centred on the cardinal phases.
  function moonPhase(ms) {
    var moon = moonPosition(ms), sun = sunPosition(ms);
    var D = wrap360(moon.lambdaDeg - sun.lambdaDeg);
    var illum = (1 - Math.cos(D * DEG)) / 2;
    var idx = Math.floor(wrap360(D + 22.5) / 45) % 8;
    var p = PHASE_NAMES[idx];
    return {
      elongationDeg: D,
      illumination: illum,
      ageDays: D / 360 * SYNODIC_DAYS,
      waxing: D < 180,
      name: p.name, emoji: p.emoji,
      distKm: moon.distKm
    };
  }

  // Next moment the elongation hits `targetDeg` (0 = new, 180 = full,
  // 90/270 = quarters). The elongation climbs ~12.19°/day, so predict from
  // the mean rate then tighten with a few corrector passes — deterministic,
  // no scanning, lands within a minute.
  function nextMoonPhase(ms, targetDeg) {
    var ratePerMs = 360 / (SYNODIC_DAYS * DAY);
    var elong = function (t) { return wrap360(moonPosition(t).lambdaDeg - sunPosition(t).lambdaDeg); };
    var t = ms + wrap360(targetDeg - elong(ms)) / ratePerMs;
    if (t - ms < MINUTE) t += SYNODIC_DAYS * DAY; // already exactly there: find the next one
    for (var i = 0; i < 8; i++) t += wrap180(targetDeg - elong(t)) / ratePerMs;
    return t;
  }

  /* ---------------- the planets ---------------- */
  // JPL approximate Keplerian elements, valid 1800–2050. Per planet:
  // [a AU, e, I°, L°, ϖ°, Ω°] at J2000 and their per-century rates.
  var ELEMENTS = {
    mercury: { el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
               rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
    venus:   { el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
               rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
    earth:   { el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
               rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0] },
    mars:    { el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
               rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
    jupiter: { el: [5.20288700, 0.04838624, 1.30439695, 34.39664051, 14.72847983, 100.47390909],
               rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
    saturn:  { el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
               rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
    uranus:  { el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
               rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
    neptune: { el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
               rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] }
  };

  var PLANETS = [
    { key: 'mercury', name: 'Mercury', emoji: '☿️', color: '#b8a690' },
    { key: 'venus',   name: 'Venus',   emoji: '♀️', color: '#e8d9a8' },
    { key: 'mars',    name: 'Mars',    emoji: '♂️', color: '#e0704a' },
    { key: 'jupiter', name: 'Jupiter', emoji: '♃',  color: '#d9b38c' },
    { key: 'saturn',  name: 'Saturn',  emoji: '♄',  color: '#e6cf9a' },
    { key: 'uranus',  name: 'Uranus',  emoji: '♅',  color: '#9fd8d8' },
    { key: 'neptune', name: 'Neptune', emoji: '♆',  color: '#7aa0e8' }
  ];

  function solveKepler(Mdeg, e) {
    var M = wrap180(Mdeg) * DEG;
    var E = M + e * Math.sin(M);
    for (var i = 0; i < 12; i++) {
      var dE = (M - (E - e * Math.sin(E))) / (1 - e * Math.cos(E));
      E += dE;
      if (Math.abs(dE) < 1e-9) break;
    }
    return E;
  }

  // Heliocentric ecliptic position (J2000 frame) of one body, in AU.
  function heliocentric(key, ms) {
    var body = ELEMENTS[key];
    var T = centuries(ms);
    var a = body.el[0] + body.rate[0] * T, e = body.el[1] + body.rate[1] * T;
    var I = (body.el[2] + body.rate[2] * T) * DEG;
    var L = body.el[3] + body.rate[3] * T;
    var wBar = body.el[4] + body.rate[4] * T;
    var Om = (body.el[5] + body.rate[5] * T) * DEG;
    var w = (wBar - body.el[5] - body.rate[5] * T) * DEG; // argument of perihelion
    var E = solveKepler(L - wBar, e);
    var xp = a * (Math.cos(E) - e);                       // in the orbital plane
    var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    var cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
    var x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
    var y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
    var z = (sw * sI) * xp + (cw * sI) * yp;
    return { x: x, y: y, z: z, r: Math.sqrt(x * x + y * y + z * z),
             lonDeg: wrap360(Math.atan2(y, x) / DEG), latDeg: Math.asin(z / Math.sqrt(x * x + y * y + z * z)) / DEG };
  }

  // Visual magnitude (Meeus-style fits; Saturn's rings ignored — chart-grade).
  var MAG = {
    mercury: function (r, d, i) { return -0.42 + 5 * Math.log10(r * d) + 0.0380 * i - 0.000273 * i * i + 0.000002 * i * i * i; },
    venus:   function (r, d, i) { return -4.40 + 5 * Math.log10(r * d) + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i * i * i; },
    mars:    function (r, d, i) { return -1.52 + 5 * Math.log10(r * d) + 0.016 * i; },
    jupiter: function (r, d, i) { return -9.40 + 5 * Math.log10(r * d) + 0.005 * i; },
    saturn:  function (r, d, i) { return -8.88 + 5 * Math.log10(r * d) + 0.044 * i; },
    uranus:  function (r, d)    { return -7.19 + 5 * Math.log10(r * d); },
    neptune: function (r, d)    { return -6.87 + 5 * Math.log10(r * d); }
  };

  // Where a planet is in OUR sky: geocentric RA/Dec, distance, elongation
  // from the sun (east positive = evening sky), phase angle and magnitude.
  function planetGeo(key, ms) {
    var p = heliocentric(key, ms), earth = heliocentric('earth', ms);
    var gx = p.x - earth.x, gy = p.y - earth.y, gz = p.z - earth.z;
    var delta = Math.sqrt(gx * gx + gy * gy + gz * gz);
    var lambda = wrap360(Math.atan2(gy, gx) / DEG);
    var beta = Math.asin(gz / delta) / DEG;
    var eq = eclToEq(lambda, beta, ms);
    var sunLambda = sunPosition(ms).lambdaDeg;
    var elong = wrap180(lambda - sunLambda);
    var R = earth.r;
    var cosPhase = (p.r * p.r + delta * delta - R * R) / (2 * p.r * delta);
    var phaseAngle = Math.acos(Math.max(-1, Math.min(1, cosPhase))) / DEG;
    return {
      key: key, raDeg: eq.raDeg, decDeg: eq.decDeg,
      distAU: delta, sunDistAU: p.r,
      elongationDeg: elong, phaseAngleDeg: phaseAngle,
      illumination: (1 + Math.cos(phaseAngle * DEG)) / 2,
      magnitude: Math.round(MAG[key](p.r, delta, phaseAngle) * 10) / 10
    };
  }

  /* ---------------- rise, set & twilight ---------------- */
  // Generic horizon-crossing scanner over one 24h window: sample the body's
  // altitude, catch sign changes against `horizonDeg`, bisect each crossing
  // to the minute. Robust at the poles (alwaysUp / alwaysDown instead of NaN).
  function riseSet(altFn, horizonDeg, startMs) {
    var STEP = 10 * MINUTE;
    var events = [];
    var prev = altFn(startMs) - horizonDeg;
    var maxAlt = prev + horizonDeg, maxAt = startMs;
    for (var t = startMs + STEP; t <= startMs + DAY; t += STEP) {
      var cur = altFn(t) - horizonDeg;
      if (cur + horizonDeg > maxAlt) { maxAlt = cur + horizonDeg; maxAt = t; }
      if ((prev <= 0 && cur > 0) || (prev > 0 && cur <= 0)) {
        var lo = t - STEP, hi = t;
        for (var i = 0; i < 20; i++) {
          var mid = (lo + hi) / 2;
          if (((altFn(mid) - horizonDeg) > 0) === (cur > 0)) hi = mid; else lo = mid;
        }
        events.push({ type: cur > 0 ? 'rise' : 'set', ms: Math.round((lo + hi) / 2) });
      }
      prev = cur;
    }
    var rise = null, set = null;
    for (var j = 0; j < events.length; j++) {
      if (events[j].type === 'rise' && rise === null) rise = events[j].ms;
      if (events[j].type === 'set' && set === null) set = events[j].ms;
    }
    return {
      rise: rise, set: set,
      alwaysUp: events.length === 0 && prev > 0,
      alwaysDown: events.length === 0 && prev <= 0,
      transit: maxAt, transitAltDeg: maxAlt
    };
  }

  // The sun's whole day at one spot: rise/set (refraction −0.833°), civil,
  // nautical and astronomical twilight, solar noon, day length and the two
  // polar extremes. `startMs` should be local midnight-ish; any moment works.
  function sunTimes(lat, lon, startMs) {
    var alt = function (t) { return sunAltAz(lat, lon, t).altDeg; };
    var day = riseSet(alt, -0.833, startMs);
    var civil = riseSet(alt, -6, startMs);
    var nautical = riseSet(alt, -12, startMs);
    var astro = riseSet(alt, -18, startMs);
    return {
      sunrise: day.rise, sunset: day.set,
      civilDawn: civil.rise, civilDusk: civil.set,
      nauticalDawn: nautical.rise, nauticalDusk: nautical.set,
      astroDawn: astro.rise, astroDusk: astro.set,
      solarNoon: day.transit, noonAltDeg: Math.round(day.transitAltDeg * 10) / 10,
      dayLengthMs: (day.rise !== null && day.set !== null)
        ? (day.set > day.rise ? day.set - day.rise : day.set - day.rise + DAY) : null,
      midnightSun: day.alwaysUp, polarNight: day.alwaysDown
    };
  }

  function moonTimes(lat, lon, startMs) {
    var alt = function (t) { var m = moonPosition(t); return altAz(m.raDeg, m.decDeg, lat, lon, t).altDeg; };
    var r = riseSet(alt, 0.125, startMs); // upper limb + refraction, minus parallax ≈ +0.125°
    return { moonrise: r.rise, moonset: r.set, alwaysUp: r.alwaysUp, alwaysDown: r.alwaysDown, transit: r.transit };
  }

  /* ---------------- the bright-star catalog ---------------- */
  // The ~110 brightest / most structural naked-eye stars (J2000, degrees).
  // `bv` is the B−V colour index the chart tints star dots with.
  var STARS = [
    { id: 'sirius', name: 'Sirius', con: 'CMa', ra: 101.29, dec: -16.72, mag: -1.46, bv: 0.00 },
    { id: 'canopus', name: 'Canopus', con: 'Car', ra: 95.99, dec: -52.70, mag: -0.74, bv: 0.15 },
    { id: 'rigilkent', name: 'Rigil Kentaurus', con: 'Cen', ra: 219.90, dec: -60.83, mag: -0.27, bv: 0.71 },
    { id: 'arcturus', name: 'Arcturus', con: 'Boo', ra: 213.92, dec: 19.18, mag: -0.05, bv: 1.23 },
    { id: 'vega', name: 'Vega', con: 'Lyr', ra: 279.23, dec: 38.78, mag: 0.03, bv: 0.00 },
    { id: 'capella', name: 'Capella', con: 'Aur', ra: 79.17, dec: 46.00, mag: 0.08, bv: 0.80 },
    { id: 'rigel', name: 'Rigel', con: 'Ori', ra: 78.63, dec: -8.20, mag: 0.13, bv: -0.03 },
    { id: 'procyon', name: 'Procyon', con: 'CMi', ra: 114.83, dec: 5.22, mag: 0.34, bv: 0.42 },
    { id: 'achernar', name: 'Achernar', con: 'Eri', ra: 24.43, dec: -57.24, mag: 0.46, bv: -0.16 },
    { id: 'betelgeuse', name: 'Betelgeuse', con: 'Ori', ra: 88.79, dec: 7.41, mag: 0.50, bv: 1.85 },
    { id: 'hadar', name: 'Hadar', con: 'Cen', ra: 210.96, dec: -60.37, mag: 0.61, bv: -0.23 },
    { id: 'altair', name: 'Altair', con: 'Aql', ra: 297.70, dec: 8.87, mag: 0.77, bv: 0.22 },
    { id: 'acrux', name: 'Acrux', con: 'Cru', ra: 186.65, dec: -63.10, mag: 0.76, bv: -0.24 },
    { id: 'aldebaran', name: 'Aldebaran', con: 'Tau', ra: 68.98, dec: 16.51, mag: 0.85, bv: 1.54 },
    { id: 'antares', name: 'Antares', con: 'Sco', ra: 247.35, dec: -26.43, mag: 0.96, bv: 1.83 },
    { id: 'spica', name: 'Spica', con: 'Vir', ra: 201.30, dec: -11.16, mag: 0.97, bv: -0.24 },
    { id: 'pollux', name: 'Pollux', con: 'Gem', ra: 116.33, dec: 28.03, mag: 1.14, bv: 1.00 },
    { id: 'fomalhaut', name: 'Fomalhaut', con: 'PsA', ra: 344.41, dec: -29.62, mag: 1.16, bv: 0.09 },
    { id: 'deneb', name: 'Deneb', con: 'Cyg', ra: 310.36, dec: 45.28, mag: 1.25, bv: 0.09 },
    { id: 'mimosa', name: 'Mimosa', con: 'Cru', ra: 191.93, dec: -59.69, mag: 1.25, bv: -0.23 },
    { id: 'regulus', name: 'Regulus', con: 'Leo', ra: 152.09, dec: 11.97, mag: 1.35, bv: -0.11 },
    { id: 'adhara', name: 'Adhara', con: 'CMa', ra: 104.66, dec: -28.97, mag: 1.50, bv: -0.21 },
    { id: 'castor', name: 'Castor', con: 'Gem', ra: 113.65, dec: 31.89, mag: 1.58, bv: 0.03 },
    { id: 'shaula', name: 'Shaula', con: 'Sco', ra: 263.40, dec: -37.10, mag: 1.62, bv: -0.22 },
    { id: 'gacrux', name: 'Gacrux', con: 'Cru', ra: 187.79, dec: -57.11, mag: 1.64, bv: 1.59 },
    { id: 'bellatrix', name: 'Bellatrix', con: 'Ori', ra: 81.28, dec: 6.35, mag: 1.64, bv: -0.22 },
    { id: 'elnath', name: 'Elnath', con: 'Tau', ra: 81.57, dec: 28.61, mag: 1.65, bv: -0.13 },
    { id: 'miaplacidus', name: 'Miaplacidus', con: 'Car', ra: 138.30, dec: -69.72, mag: 1.67, bv: 0.00 },
    { id: 'alnilam', name: 'Alnilam', con: 'Ori', ra: 84.05, dec: -1.20, mag: 1.69, bv: -0.18 },
    { id: 'alnair', name: 'Alnair', con: 'Gru', ra: 332.06, dec: -46.96, mag: 1.74, bv: -0.13 },
    { id: 'alnitak', name: 'Alnitak', con: 'Ori', ra: 85.19, dec: -1.94, mag: 1.77, bv: -0.20 },
    { id: 'alioth', name: 'Alioth', con: 'UMa', ra: 193.51, dec: 55.96, mag: 1.77, bv: -0.02 },
    { id: 'dubhe', name: 'Dubhe', con: 'UMa', ra: 165.93, dec: 61.75, mag: 1.79, bv: 1.07 },
    { id: 'mirfak', name: 'Mirfak', con: 'Per', ra: 51.08, dec: 49.86, mag: 1.80, bv: 0.48 },
    { id: 'wezen', name: 'Wezen', con: 'CMa', ra: 107.10, dec: -26.39, mag: 1.83, bv: 0.68 },
    { id: 'kausaustralis', name: 'Kaus Australis', con: 'Sgr', ra: 276.04, dec: -34.38, mag: 1.85, bv: -0.03 },
    { id: 'avior', name: 'Avior', con: 'Car', ra: 125.63, dec: -59.51, mag: 1.86, bv: 1.28 },
    { id: 'alkaid', name: 'Alkaid', con: 'UMa', ra: 206.89, dec: 49.31, mag: 1.86, bv: -0.19 },
    { id: 'sargas', name: 'Sargas', con: 'Sco', ra: 264.33, dec: -43.00, mag: 1.87, bv: 0.40 },
    { id: 'menkalinan', name: 'Menkalinan', con: 'Aur', ra: 89.88, dec: 44.95, mag: 1.90, bv: 0.03 },
    { id: 'atria', name: 'Atria', con: 'TrA', ra: 252.17, dec: -69.03, mag: 1.92, bv: 1.44 },
    { id: 'alhena', name: 'Alhena', con: 'Gem', ra: 99.43, dec: 16.40, mag: 1.92, bv: 0.00 },
    { id: 'peacock', name: 'Peacock', con: 'Pav', ra: 306.41, dec: -56.74, mag: 1.94, bv: -0.20 },
    { id: 'mirzam', name: 'Mirzam', con: 'CMa', ra: 95.67, dec: -17.96, mag: 1.98, bv: -0.23 },
    { id: 'alphard', name: 'Alphard', con: 'Hya', ra: 141.90, dec: -8.66, mag: 1.98, bv: 1.44 },
    { id: 'polaris', name: 'Polaris', con: 'UMi', ra: 37.95, dec: 89.26, mag: 1.98, bv: 0.60 },
    { id: 'hamal', name: 'Hamal', con: 'Ari', ra: 31.79, dec: 23.46, mag: 2.00, bv: 1.15 },
    { id: 'diphda', name: 'Diphda', con: 'Cet', ra: 10.90, dec: -17.99, mag: 2.02, bv: 1.02 },
    { id: 'mizar', name: 'Mizar', con: 'UMa', ra: 200.98, dec: 54.93, mag: 2.04, bv: 0.02 },
    { id: 'mirach', name: 'Mirach', con: 'And', ra: 17.43, dec: 35.62, mag: 2.05, bv: 1.58 },
    { id: 'alpheratz', name: 'Alpheratz', con: 'And', ra: 2.10, dec: 29.09, mag: 2.06, bv: -0.11 },
    { id: 'nunki', name: 'Nunki', con: 'Sgr', ra: 283.82, dec: -26.30, mag: 2.06, bv: -0.22 },
    { id: 'menkent', name: 'Menkent', con: 'Cen', ra: 211.67, dec: -36.37, mag: 2.06, bv: 1.01 },
    { id: 'rasalhague', name: 'Rasalhague', con: 'Oph', ra: 263.73, dec: 12.56, mag: 2.07, bv: 0.16 },
    { id: 'kochab', name: 'Kochab', con: 'UMi', ra: 222.68, dec: 74.16, mag: 2.08, bv: 1.47 },
    { id: 'algieba', name: 'Algieba', con: 'Leo', ra: 154.99, dec: 19.84, mag: 2.08, bv: 1.13 },
    { id: 'saiph', name: 'Saiph', con: 'Ori', ra: 86.94, dec: -9.67, mag: 2.09, bv: -0.17 },
    { id: 'tiaki', name: 'Tiaki', con: 'Gru', ra: 340.67, dec: -46.88, mag: 2.11, bv: 1.61 },
    { id: 'algol', name: 'Algol', con: 'Per', ra: 47.04, dec: 40.96, mag: 2.12, bv: -0.05 },
    { id: 'denebola', name: 'Denebola', con: 'Leo', ra: 177.26, dec: 14.57, mag: 2.14, bv: 0.09 },
    { id: 'muhlifain', name: 'Muhlifain', con: 'Cen', ra: 190.38, dec: -48.96, mag: 2.17, bv: -0.01 },
    { id: 'suhail', name: 'Suhail', con: 'Vel', ra: 137.00, dec: -43.43, mag: 2.21, bv: 1.66 },
    { id: 'sadr', name: 'Sadr', con: 'Cyg', ra: 305.56, dec: 40.26, mag: 2.23, bv: 0.68 },
    { id: 'mintaka', name: 'Mintaka', con: 'Ori', ra: 83.00, dec: -0.30, mag: 2.23, bv: -0.22 },
    { id: 'alphecca', name: 'Alphecca', con: 'CrB', ra: 233.67, dec: 26.71, mag: 2.23, bv: -0.02 },
    { id: 'eltanin', name: 'Eltanin', con: 'Dra', ra: 269.15, dec: 51.49, mag: 2.23, bv: 1.52 },
    { id: 'schedar', name: 'Schedar', con: 'Cas', ra: 10.13, dec: 56.54, mag: 2.24, bv: 1.17 },
    { id: 'naos', name: 'Naos', con: 'Pup', ra: 120.90, dec: -40.00, mag: 2.25, bv: -0.27 },
    { id: 'almach', name: 'Almach', con: 'And', ra: 30.97, dec: 42.33, mag: 2.26, bv: 1.37 },
    { id: 'caph', name: 'Caph', con: 'Cas', ra: 2.29, dec: 59.15, mag: 2.27, bv: 0.34 },
    { id: 'dschubba', name: 'Dschubba', con: 'Sco', ra: 240.08, dec: -22.62, mag: 2.29, bv: -0.12 },
    { id: 'larawag', name: 'Larawag', con: 'Sco', ra: 252.54, dec: -34.29, mag: 2.29, bv: 1.15 },
    { id: 'merak', name: 'Merak', con: 'UMa', ra: 165.46, dec: 56.38, mag: 2.37, bv: 0.03 },
    { id: 'izar', name: 'Izar', con: 'Boo', ra: 221.25, dec: 27.07, mag: 2.37, bv: 0.97 },
    { id: 'ankaa', name: 'Ankaa', con: 'Phe', ra: 6.57, dec: -42.31, mag: 2.38, bv: 1.09 },
    { id: 'girtab', name: 'Girtab', con: 'Sco', ra: 265.62, dec: -39.03, mag: 2.39, bv: -0.17 },
    { id: 'enif', name: 'Enif', con: 'Peg', ra: 326.05, dec: 9.88, mag: 2.39, bv: 1.53 },
    { id: 'scheat', name: 'Scheat', con: 'Peg', ra: 345.94, dec: 28.08, mag: 2.42, bv: 1.67 },
    { id: 'sabik', name: 'Sabik', con: 'Oph', ra: 257.59, dec: -15.72, mag: 2.43, bv: 0.06 },
    { id: 'phecda', name: 'Phecda', con: 'UMa', ra: 178.46, dec: 53.69, mag: 2.44, bv: 0.00 },
    { id: 'aludra', name: 'Aludra', con: 'CMa', ra: 111.02, dec: -29.30, mag: 2.45, bv: -0.08 },
    { id: 'alderamin', name: 'Alderamin', con: 'Cep', ra: 319.64, dec: 62.59, mag: 2.46, bv: 0.22 },
    { id: 'navi', name: 'Navi', con: 'Cas', ra: 14.18, dec: 60.72, mag: 2.47, bv: -0.15 },
    { id: 'aljanah', name: 'Aljanah', con: 'Cyg', ra: 311.55, dec: 33.97, mag: 2.48, bv: 1.03 },
    { id: 'markab', name: 'Markab', con: 'Peg', ra: 346.19, dec: 15.21, mag: 2.49, bv: -0.04 },
    { id: 'zosma', name: 'Zosma', con: 'Leo', ra: 168.53, dec: 20.52, mag: 2.56, bv: 0.13 },
    { id: 'arneb', name: 'Arneb', con: 'Lep', ra: 83.18, dec: -17.82, mag: 2.58, bv: 0.21 },
    { id: 'gienah', name: 'Gienah', con: 'Crv', ra: 183.95, dec: -17.54, mag: 2.59, bv: -0.11 },
    { id: 'ascella', name: 'Ascella', con: 'Sgr', ra: 285.65, dec: -29.88, mag: 2.60, bv: 0.08 },
    { id: 'zubeneschamali', name: 'Zubeneschamali', con: 'Lib', ra: 229.25, dec: -9.38, mag: 2.61, bv: -0.07 },
    { id: 'acrab', name: 'Acrab', con: 'Sco', ra: 241.36, dec: -19.81, mag: 2.62, bv: -0.07 },
    { id: 'unukalhai', name: 'Unukalhai', con: 'Ser', ra: 236.07, dec: 6.43, mag: 2.63, bv: 1.17 },
    { id: 'sheratan', name: 'Sheratan', con: 'Ari', ra: 28.66, dec: 20.81, mag: 2.64, bv: 0.13 },
    { id: 'phact', name: 'Phact', con: 'Col', ra: 84.91, dec: -34.07, mag: 2.65, bv: -0.12 },
    { id: 'muphrid', name: 'Muphrid', con: 'Boo', ra: 208.67, dec: 18.40, mag: 2.68, bv: 0.58 },
    { id: 'ruchbah', name: 'Ruchbah', con: 'Cas', ra: 21.45, dec: 60.24, mag: 2.68, bv: 0.13 },
    { id: 'kausmedia', name: 'Kaus Media', con: 'Sgr', ra: 275.25, dec: -29.83, mag: 2.70, bv: 1.38 },
    { id: 'tarazed', name: 'Tarazed', con: 'Aql', ra: 296.56, dec: 10.61, mag: 2.72, bv: 1.52 },
    { id: 'zubenelgenubi', name: 'Zubenelgenubi', con: 'Lib', ra: 222.72, dec: -16.04, mag: 2.75, bv: 0.15 },
    { id: 'kornephoros', name: 'Kornephoros', con: 'Her', ra: 247.55, dec: 21.49, mag: 2.77, bv: 0.95 },
    { id: 'rastaban', name: 'Rastaban', con: 'Dra', ra: 262.61, dec: 52.30, mag: 2.79, bv: 0.98 },
    { id: 'kausborealis', name: 'Kaus Borealis', con: 'Sgr', ra: 276.99, dec: -25.42, mag: 2.81, bv: 1.04 },
    { id: 'algenib', name: 'Algenib', con: 'Peg', ra: 3.31, dec: 15.18, mag: 2.83, bv: -0.19 },
    { id: 'vindemiatrix', name: 'Vindemiatrix', con: 'Vir', ra: 195.54, dec: 10.96, mag: 2.83, bv: 0.93 },
    { id: 'deltacru', name: 'Imai', con: 'Cru', ra: 183.79, dec: -58.75, mag: 2.79, bv: -0.19 },
    { id: 'deltacyg', name: 'Fawaris', con: 'Cyg', ra: 296.24, dec: 45.13, mag: 2.87, bv: -0.03 },
    { id: 'denebalgedi', name: 'Deneb Algedi', con: 'Cap', ra: 326.76, dec: -16.13, mag: 2.87, bv: 0.29 },
    { id: 'tejat', name: 'Tejat', con: 'Gem', ra: 95.74, dec: 22.51, mag: 2.88, bv: 1.62 },
    { id: 'gomeisa', name: 'Gomeisa', con: 'CMi', ra: 111.79, dec: 8.29, mag: 2.90, bv: -0.10 },
    { id: 'corcaroli', name: 'Cor Caroli', con: 'CVn', ra: 194.01, dec: 38.32, mag: 2.90, bv: -0.06 },
    { id: 'pherkad', name: 'Pherkad', con: 'UMi', ra: 230.18, dec: 71.83, mag: 3.05, bv: 0.06 },
    { id: 'mebsuta', name: 'Mebsuta', con: 'Gem', ra: 100.98, dec: 25.13, mag: 3.06, bv: 1.38 },
    { id: 'albireo', name: 'Albireo', con: 'Cyg', ra: 292.68, dec: 27.96, mag: 3.08, bv: 1.09 },
    { id: 'megrez', name: 'Megrez', con: 'UMa', ra: 183.86, dec: 57.03, mag: 3.31, bv: 0.08 },
    { id: 'sulafat', name: 'Sulafat', con: 'Lyr', ra: 284.74, dec: 32.69, mag: 3.24, bv: -0.05 },
    { id: 'sheliak', name: 'Sheliak', con: 'Lyr', ra: 282.52, dec: 33.36, mag: 3.45, bv: 0.00 },
    { id: 'alshain', name: 'Alshain', con: 'Aql', ra: 298.83, dec: 6.41, mag: 3.71, bv: 0.86 },
    { id: 'wasat', name: 'Wasat', con: 'Gem', ra: 110.03, dec: 21.98, mag: 3.53, bv: 0.34 }
  ];

  // Stick figures: each constellation is a list of [starId, starId] segments.
  var CONSTELLATIONS = [
    { name: 'Orion', lines: [['betelgeuse', 'bellatrix'], ['betelgeuse', 'alnitak'], ['bellatrix', 'mintaka'],
      ['alnitak', 'alnilam'], ['alnilam', 'mintaka'], ['alnitak', 'saiph'], ['mintaka', 'rigel'], ['rigel', 'saiph']] },
    { name: 'Ursa Major', lines: [['alkaid', 'mizar'], ['mizar', 'alioth'], ['alioth', 'megrez'],
      ['megrez', 'phecda'], ['phecda', 'merak'], ['merak', 'dubhe'], ['dubhe', 'megrez']] },
    { name: 'Ursa Minor', lines: [['polaris', 'kochab'], ['kochab', 'pherkad']] },
    { name: 'Cassiopeia', lines: [['caph', 'schedar'], ['schedar', 'navi'], ['navi', 'ruchbah'], ['ruchbah', 'segin']] },
    { name: 'Cygnus', lines: [['deneb', 'sadr'], ['sadr', 'albireo'], ['sadr', 'aljanah'], ['sadr', 'deltacyg']] },
    { name: 'Lyra', lines: [['vega', 'sheliak'], ['sheliak', 'sulafat'], ['sulafat', 'vega']] },
    { name: 'Aquila', lines: [['altair', 'tarazed'], ['altair', 'alshain']] },
    { name: 'Scorpius', lines: [['dschubba', 'acrab'], ['dschubba', 'antares'], ['antares', 'larawag'],
      ['larawag', 'girtab'], ['girtab', 'shaula'], ['girtab', 'sargas']] },
    { name: 'Sagittarius', lines: [['kausaustralis', 'kausmedia'], ['kausmedia', 'kausborealis'],
      ['kausborealis', 'nunki'], ['nunki', 'ascella'], ['ascella', 'kausaustralis']] },
    { name: 'Leo', lines: [['regulus', 'algieba'], ['algieba', 'zosma'], ['zosma', 'denebola'], ['denebola', 'regulus']] },
    { name: 'Gemini', lines: [['castor', 'pollux'], ['pollux', 'wasat'], ['wasat', 'alhena'],
      ['castor', 'mebsuta'], ['mebsuta', 'tejat']] },
    { name: 'Taurus', lines: [['aldebaran', 'elnath']] },
    { name: 'Canis Major', lines: [['sirius', 'mirzam'], ['sirius', 'adhara'], ['adhara', 'wezen'], ['wezen', 'aludra']] },
    { name: 'Crux', lines: [['acrux', 'gacrux'], ['mimosa', 'deltacru']] },
    { name: 'Pegasus', lines: [['markab', 'scheat'], ['scheat', 'alpheratz'], ['alpheratz', 'algenib'],
      ['algenib', 'markab'], ['markab', 'enif']] },
    { name: 'Andromeda', lines: [['alpheratz', 'mirach'], ['mirach', 'almach']] },
    { name: 'Boötes', lines: [['arcturus', 'izar'], ['arcturus', 'muphrid'], ['izar', 'alphecca']] },
    { name: 'Auriga', lines: [['capella', 'menkalinan'], ['menkalinan', 'elnath'], ['elnath', 'capella']] },
    { name: 'Perseus', lines: [['mirfak', 'algol']] },
    { name: 'Libra', lines: [['zubenelgenubi', 'zubeneschamali']] }
  ];
  // Cassiopeia's fifth star, small but structural.
  STARS.push({ id: 'segin', name: 'Segin', con: 'Cas', ra: 28.60, dec: 63.67, mag: 3.38, bv: -0.15 });

  var starIndex = null;
  function starById(id) {
    if (!starIndex) {
      starIndex = {};
      for (var i = 0; i < STARS.length; i++) starIndex[STARS[i].id] = STARS[i];
    }
    return starIndex[id] || null;
  }

  /* ---------------- the chart projection ---------------- */
  // Zenith-centred azimuthal equidistant: the zenith is (0,0), the horizon
  // the unit circle, north up, east LEFT — sky charts mirror paper maps
  // because you hold them overhead.
  function project(altDeg, azDeg) {
    var r = (90 - altDeg) / 90;
    var az = azDeg * DEG;
    return { x: -r * Math.sin(az), y: -r * Math.cos(az) };
  }

  // Everything plottable right now from one spot: stars above the horizon
  // (with chart x/y), constellation segments with both ends up, planets,
  // the moon (with phase) and the sun. One call renders the whole chart.
  function skyChart(lat, lon, ms, opts) {
    opts = opts || {};
    var magLimit = opts.magLimit == null ? 4 : opts.magLimit;
    var minAlt = opts.minAltDeg == null ? -0.5 : opts.minAltDeg;
    var placed = {};
    var stars = [];
    for (var i = 0; i < STARS.length; i++) {
      var s = STARS[i];
      if (s.mag > magLimit) continue;
      var aa = altAz(s.ra, s.dec, lat, lon, ms);
      if (aa.altDeg < minAlt) continue;
      var p = project(aa.altDeg, aa.azDeg);
      var row = { id: s.id, name: s.name, con: s.con, mag: s.mag, bv: s.bv,
                  altDeg: aa.altDeg, azDeg: aa.azDeg, x: p.x, y: p.y };
      placed[s.id] = row;
      stars.push(row);
    }
    var lines = [];
    for (var c = 0; c < CONSTELLATIONS.length; c++) {
      var con = CONSTELLATIONS[c];
      for (var l = 0; l < con.lines.length; l++) {
        var a = placed[con.lines[l][0]], b = placed[con.lines[l][1]];
        if (a && b) lines.push({ con: con.name, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }
    var planets = [];
    for (var q = 0; q < PLANETS.length; q++) {
      var meta = PLANETS[q];
      var g = planetGeo(meta.key, ms);
      var paa = altAz(g.raDeg, g.decDeg, lat, lon, ms);
      if (paa.altDeg < minAlt) continue;
      var pp = project(paa.altDeg, paa.azDeg);
      planets.push({ key: meta.key, name: meta.name, emoji: meta.emoji, color: meta.color,
                     mag: g.magnitude, altDeg: paa.altDeg, azDeg: paa.azDeg, x: pp.x, y: pp.y });
    }
    var moon = moonPosition(ms);
    var maa = altAz(moon.raDeg, moon.decDeg, lat, lon, ms);
    var mp = project(maa.altDeg, maa.azDeg);
    var phase = moonPhase(ms);
    var sun = sunAltAz(lat, lon, ms);
    var sp = project(sun.altDeg, sun.azDeg);
    return {
      stars: stars, lines: lines, planets: planets,
      moon: { altDeg: maa.altDeg, azDeg: maa.azDeg, x: mp.x, y: mp.y, up: maa.altDeg >= minAlt,
              illumination: phase.illumination, emoji: phase.emoji, name: phase.name, waxing: phase.waxing },
      sun: { altDeg: sun.altDeg, azDeg: sun.azDeg, x: sp.x, y: sp.y, up: sun.altDeg >= -0.833 },
      // sky darkness drives the chart's background: 1 deep night → 0 daylight
      darkness: sun.altDeg >= 0 ? 0 : Math.min(1, -sun.altDeg / 18)
    };
  }

  /* ---------------- tonight: the evening briefing ---------------- */
  // What's actually worth stepping outside for between dusk and dawn:
  // each planet's best moment while the sky is dark, the moon's night, and
  // human sentences the Tonight tab prints verbatim.
  function tonight(lat, lon, ms) {
    var st = sunTimes(lat, lon, ms);
    var mt = moonTimes(lat, lon, ms);
    var phase = moonPhase(ms);
    var darkStart = st.astroDusk || st.nauticalDusk || st.civilDusk || st.sunset;
    var darkEnd = st.astroDawn || st.nauticalDawn || st.civilDawn || st.sunrise;
    var windowStart = darkStart !== null && darkStart !== undefined ? darkStart : ms;
    var windowLen = DAY / 2;
    var planets = [];
    for (var i = 0; i < PLANETS.length; i++) {
      var meta = PLANETS[i];
      var best = null;
      for (var t = windowStart; t <= windowStart + windowLen; t += 30 * MINUTE) {
        if (sunAltAz(lat, lon, t).altDeg > -6) continue; // sky not dark enough
        var g = planetGeo(meta.key, t);
        var aa = altAz(g.raDeg, g.decDeg, lat, lon, t);
        if (aa.altDeg < 5) continue;
        if (!best || aa.altDeg > best.altDeg) {
          best = { altDeg: aa.altDeg, azDeg: aa.azDeg, ms: t, mag: g.magnitude, elongationDeg: g.elongationDeg };
        }
      }
      planets.push({
        key: meta.key, name: meta.name, emoji: meta.emoji, color: meta.color,
        visible: !!best, best: best,
        note: best
          ? meta.name + ' up to ' + Math.round(best.altDeg) + '° in the ' + compass(best.azDeg) + ', mag ' + best.mag
          : meta.name + ' is lost in the sun’s glare tonight'
      });
    }
    var visible = planets.filter(function (p) { return p.visible; });
    // moonlight verdict for faint-object hunters
    var moonVerdict;
    if (phase.illumination < 0.15) moonVerdict = 'Dark skies — the Milky Way and faint meteors are on.';
    else if (phase.illumination < 0.6) moonVerdict = 'Some moonlight; bright targets still shine through.';
    else moonVerdict = 'A bright moon washes out faint targets — chase planets and doubles instead.';
    return {
      sun: st, moon: mt, phase: phase, planets: planets,
      visibleCount: visible.length,
      moonVerdict: moonVerdict,
      polarNote: st.midnightSun ? 'The sun never sets today — no true night at this latitude.'
        : st.polarNight ? 'The sun never rises today — the sky stays dark around the clock.' : null
    };
  }

  var WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compass(azDeg) { return WINDS[Math.round(wrap360(azDeg) / 22.5) % 16]; }

  /* ---------------- the meteor calendar ---------------- */
  // Month/day are peak dates (they drift less than a day year to year —
  // calendar-grade). ZHR is the idealised zenith hourly rate.
  var SHOWERS = [
    { name: 'Quadrantids',        peak: [1, 3],   from: [12, 28], to: [1, 12],  zhr: 110, radiant: 'Boötes' },
    { name: 'Lyrids',             peak: [4, 22],  from: [4, 14],  to: [4, 30],  zhr: 18,  radiant: 'Lyra' },
    { name: 'Eta Aquariids',      peak: [5, 6],   from: [4, 19],  to: [5, 28],  zhr: 50,  radiant: 'Aquarius' },
    { name: 'Delta Aquariids',    peak: [7, 30],  from: [7, 12],  to: [8, 23],  zhr: 25,  radiant: 'Aquarius' },
    { name: 'Perseids',           peak: [8, 12],  from: [7, 17],  to: [8, 24],  zhr: 100, radiant: 'Perseus' },
    { name: 'Orionids',           peak: [10, 21], from: [10, 2],  to: [11, 7],  zhr: 20,  radiant: 'Orion' },
    { name: 'Southern Taurids',   peak: [11, 5],  from: [9, 10],  to: [11, 20], zhr: 5,   radiant: 'Taurus' },
    { name: 'Leonids',            peak: [11, 17], from: [11, 6],  to: [11, 30], zhr: 15,  radiant: 'Leo' },
    { name: 'Geminids',           peak: [12, 14], from: [12, 4],  to: [12, 17], zhr: 150, radiant: 'Gemini' },
    { name: 'Ursids',             peak: [12, 22], from: [12, 17], to: [12, 26], zhr: 10,  radiant: 'Ursa Minor' }
  ];

  function dayOfYear(month, day) {
    var cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    return cum[month - 1] + day;
  }

  // Active and upcoming showers for a UTC date {y, m, d}. Handles the
  // year-straddling Quadrantids window.
  function meteorShowers(dateUTC) {
    var doy = dayOfYear(dateUTC.m, dateUTC.d);
    var out = [];
    for (var i = 0; i < SHOWERS.length; i++) {
      var s = SHOWERS[i];
      var from = dayOfYear(s.from[0], s.from[1]), to = dayOfYear(s.to[0], s.to[1]);
      var peak = dayOfYear(s.peak[0], s.peak[1]);
      var active = from <= to ? (doy >= from && doy <= to) : (doy >= from || doy <= to);
      var untilPeak = peak - doy;
      if (untilPeak < -183) untilPeak += 365;
      if (untilPeak > 182) untilPeak -= 365;
      out.push({
        name: s.name, zhr: s.zhr, radiant: s.radiant,
        peakMonth: s.peak[0], peakDay: s.peak[1],
        active: active, atPeak: active && Math.abs(untilPeak) <= 1,
        daysToPeak: untilPeak
      });
    }
    out.sort(function (a, b) {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return Math.abs(a.daysToPeak) - Math.abs(b.daysToPeak);
    });
    return out;
  }

  /* ---------------- one sky fact a day ---------------- */
  var FACTS = [
    'Light from Sirius left it 8.6 years ago — you are looking at the past.',
    'The moon drifts about 3.8 cm farther from Earth every year.',
    'Betelgeuse is so large that, put where the sun is, it would swallow Mars.',
    'On a moonless night the unaided eye can see about 2,500 stars at once.',
    'Venus spins backwards — its sun rises in the west.',
    'A day on Mercury (sunrise to sunrise) lasts 176 Earth days.',
    'Neutron stars can spin 700 times a second.',
    'Saturn is less dense than water — it would float, given a big enough sea.',
    'The Andromeda galaxy is the farthest thing most eyes can see: 2.5 million light-years.',
    'Jupiter’s Great Red Spot is a storm wider than Earth, raging for centuries.',
    'Polaris hasn’t always been the pole star — in 12,000 years it will be Vega.',
    'Meteors you see are usually sand-grain sized, burning 80 km up.',
    'The sun makes up 99.86% of the solar system’s mass.',
    'Olympus Mons on Mars is nearly three times the height of Everest.',
    'A teaspoon of neutron-star matter would weigh about a billion tonnes.',
    'Uranus rolls around the sun on its side, tipped 98 degrees.',
    'The nearest star system, Alpha Centauri, is a 4.2 light-year walk away.',
    'Mercury and Venus are the only planets with no moons at all.',
    'Some of the stars you see tonight may have already died — their light hasn’t caught up.',
    'The Milky Way and Andromeda will merge in about 4.5 billion years.'
  ];

  function dailyFact(isoDate) {
    var idx = hashStr('zenith-day:' + String(isoDate)) % FACTS.length;
    return { date: String(isoDate), fact: FACTS[idx], index: idx };
  }

  /* ---------------- places ---------------- */
  // The location picker's offline list; geolocation snaps to the nearest.
  var PLACES = [
    { name: 'London',       cc: 'GB', flag: '🇬🇧', lat: 51.51,  lon: -0.13 },
    { name: 'New York',     cc: 'US', flag: '🇺🇸', lat: 40.71,  lon: -74.01 },
    { name: 'Los Angeles',  cc: 'US', flag: '🇺🇸', lat: 34.05,  lon: -118.24 },
    { name: 'Tokyo',        cc: 'JP', flag: '🇯🇵', lat: 35.68,  lon: 139.69 },
    { name: 'Sydney',       cc: 'AU', flag: '🇦🇺', lat: -33.87, lon: 151.21 },
    { name: 'Cape Town',    cc: 'ZA', flag: '🇿🇦', lat: -33.92, lon: 18.42 },
    { name: 'Mumbai',       cc: 'IN', flag: '🇮🇳', lat: 19.08,  lon: 72.88 },
    { name: 'São Paulo',    cc: 'BR', flag: '🇧🇷', lat: -23.55, lon: -46.63 },
    { name: 'Cairo',        cc: 'EG', flag: '🇪🇬', lat: 30.04,  lon: 31.24 },
    { name: 'Reykjavík',    cc: 'IS', flag: '🇮🇸', lat: 64.15,  lon: -21.94 },
    { name: 'Singapore',    cc: 'SG', flag: '🇸🇬', lat: 1.35,   lon: 103.82 },
    { name: 'Paris',        cc: 'FR', flag: '🇫🇷', lat: 48.86,  lon: 2.35 },
    { name: 'Mexico City',  cc: 'MX', flag: '🇲🇽', lat: 19.43,  lon: -99.13 },
    { name: 'Nairobi',      cc: 'KE', flag: '🇰🇪', lat: -1.29,  lon: 36.82 },
    { name: 'Auckland',     cc: 'NZ', flag: '🇳🇿', lat: -36.85, lon: 174.76 },
    { name: 'Anchorage',    cc: 'US', flag: '🇺🇸', lat: 61.22,  lon: -149.90 }
  ];

  function placeByName(name) {
    for (var i = 0; i < PLACES.length; i++) if (PLACES[i].name === name) return PLACES[i];
    return null;
  }

  function nearestPlace(lat, lon) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < PLACES.length; i++) {
      var p = PLACES[i];
      var dLat = (p.lat - lat), dLon = wrap180(p.lon - lon) * Math.cos(lat * DEG);
      var d = dLat * dLat + dLon * dLon;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /* ---------------- formatters ---------------- */
  function raToHMS(raDeg) {
    var h = wrap360(raDeg) / 15;
    var H = Math.floor(h), M = Math.floor((h - H) * 60);
    return H + 'h ' + (M < 10 ? '0' : '') + M + 'm';
  }
  function decToDMS(decDeg) {
    var sign = decDeg < 0 ? '−' : '+';
    var a = Math.abs(decDeg);
    var D = Math.floor(a), M = Math.round((a - D) * 60);
    if (M === 60) { D += 1; M = 0; }
    return sign + D + '° ' + (M < 10 ? '0' : '') + M + '′';
  }
  function fmtDuration(ms) {
    if (ms == null) return '—';
    var h = Math.floor(ms / HOUR), m = Math.round((ms % HOUR) / MINUTE);
    if (m === 60) { h += 1; m = 0; }
    return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
  }
  function fmtAU(au) {
    return au < 0.01 ? (Math.round(au * 149597870.7 / 1000) * 1000).toLocaleString() + ' km'
      : (Math.round(au * 100) / 100) + ' AU';
  }

  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY, SYNODIC_DAYS: SYNODIC_DAYS,
    STARS: STARS, CONSTELLATIONS: CONSTELLATIONS, PLANETS: PLANETS, SHOWERS: SHOWERS,
    FACTS: FACTS, PLACES: PLACES, PHASE_NAMES: PHASE_NAMES,
    hashStr: hashStr, escapeHTML: escapeHTML,
    wrap360: wrap360, wrap180: wrap180,
    julianDay: julianDay, centuries: centuries, gmstDeg: gmstDeg, lstDeg: lstDeg,
    obliquityDeg: obliquityDeg, eclToEq: eclToEq, altAz: altAz,
    sunPosition: sunPosition, sunAltAz: sunAltAz,
    moonPosition: moonPosition, moonPhase: moonPhase, nextMoonPhase: nextMoonPhase,
    solveKepler: solveKepler, heliocentric: heliocentric, planetGeo: planetGeo,
    riseSet: riseSet, sunTimes: sunTimes, moonTimes: moonTimes,
    starById: starById, project: project, skyChart: skyChart,
    tonight: tonight, compass: compass,
    meteorShowers: meteorShowers, dayOfYear: dayOfYear, dailyFact: dailyFact,
    placeByName: placeByName, nearestPlace: nearestPlace,
    raToHMS: raToHMS, decToDMS: decToDMS, fmtDuration: fmtDuration, fmtAU: fmtAU
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.ZenithEngine = E;
})(typeof self !== 'undefined' ? self : this);
