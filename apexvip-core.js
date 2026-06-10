/**
 * ApexVIP Core Engine v1.0
 * Copyright © 2026 ApexVIP Ltd. All rights reserved.
 *
 * ApexYield™  — Multi-signal luxury demand yield algorithm
 * PrestigeMatch™ — Driver-client-vehicle compatibility scoring
 *
 * This source code and its specific expression, formula weighting, event
 * calendars, demand curve construction, and scoring methodology constitute
 * original creative work protected by copyright law (Copyright, Designs
 * and Patents Act 1988; UAE Federal Law No. 38 of 2021 on Copyright).
 * Reproduction, adaptation, or use in competing products is prohibited
 * without written licence from ApexVIP Ltd.
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ApexCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // APEX YIELD™
  // Produces a price multiplier by blending four independent signal layers:
  //   L1 — Intraday demand curve (24-point spline)
  //   L2 — Day-of-week seasonality
  //   L3 — Named-event proximity calendar (London + Dubai)
  //   L4 — Vehicle class elasticity ceiling
  // ─────────────────────────────────────────────────────────────────────────

  // L1: 24-hour demand index (empirically shaped for luxury transport)
  // Peak: 18:00-21:00 (theatre/dinner runs); trough: 02:00-04:00
  const _HOURLY = [
    0.20, 0.14, 0.10, 0.10, 0.16, 0.28,   // 00-05
    0.48, 0.72, 0.88, 0.78, 0.66, 0.61,   // 06-11
    0.60, 0.59, 0.54, 0.61, 0.76, 0.91,   // 12-17
    1.00, 0.97, 0.86, 0.74, 0.59, 0.38,   // 18-23
  ];

  // L2: Day-of-week index (0=Sun … 6=Sat)
  const _DOW = [1.14, 0.84, 0.79, 0.83, 0.89, 1.22, 1.28];

  // L3: Named event calendar [month, startDay, spanDays, label, radiusKm, peakMultiplier]
  // Dual-market: London events use radiusKm centred on WC2; Dubai on DIFC
  const _EVENTS = [
    // ── Global / both markets ──────────────────────────────────────────────
    [ 1,  1, 1, "New Year's Day",          5, 2.80],
    [12, 24, 1, "Christmas Eve",           4, 2.10],
    [12, 25, 1, "Christmas Day",           4, 2.90],
    [12, 26, 1, "Boxing Day",              4, 1.85],
    [12, 31, 1, "New Year's Eve",          6, 3.00],
    // ── London ────────────────────────────────────────────────────────────
    [ 2, 14, 1, "Valentine's Day",         3, 1.45],
    [ 4, 18, 2, "Easter Weekend",          5, 1.55],
    [ 5,  5, 3, "Coronation Season",       6, 1.60],
    [ 6,  1,14, "Wimbledon Fortnight",    15, 1.85],
    [ 6, 14, 1, "Wimbledon Final",        15, 2.30],
    [ 6, 17, 5, "Royal Ascot",            22, 2.10],
    [ 7,  1, 5, "Henley Royal Regatta",    9, 1.65],
    [ 9, 13, 5, "London Fashion Week",     5, 1.75],
    [ 9, 12, 1, "Frieze Art Fair",         5, 1.55],
    [10, 11, 5, "BFI London Film Festival",4, 1.60],
    [11,  4, 2, "Bonfire Night Period",    5, 1.80],
    // ── Dubai ─────────────────────────────────────────────────────────────
    [ 1, 14,30, "Dubai Shopping Festival",20, 1.65],
    [ 3,  1, 3, "Art Dubai",               5, 1.75],
    [ 3, 22, 1, "Dubai World Cup",        32, 2.30],
    [ 5, 14, 3, "Dubai Summer Surprise",  15, 1.40],
    [10, 13, 5, "GITEX Global",           12, 1.95],
    [11, 17, 5, "Dubai Airshow",          18, 1.80],
    [11, 25, 3, "Formula E Dubai",        10, 1.90],
    [12, 17, 2, "UAE National Day",       10, 2.05],
  ];

  // L4: Vehicle class elasticity — Phantom buyers are less price-sensitive;
  // surge tapers off above 2× to protect conversion on flagship bookings
  const _ELASTICITY = { s: 1.00, v: 0.96, r: 0.68, phantom: 0.68 };

  /**
   * apexYield(params) → { multiplier, label, signals }
   *
   * @param {Object} params
   * @param {string} params.date       "YYYY-MM-DD"
   * @param {string} params.time       "HH:MM"
   * @param {string} params.vehicle    "s"|"v"|"r"|"phantom"
   * @param {string} [params.market]   "london"|"dubai" (default "london")
   * @returns {{ multiplier:number, label:string, signals:Object }}
   */
  function apexYield({ date, time, vehicle = 's', market = 'london' }) {
    const d = new Date(`${date}T${time || '12:00'}:00`);
    if (isNaN(d)) return { multiplier: 1.0, label: 'Standard', signals: {} };

    const hour  = d.getHours();
    const dow   = d.getDay();
    const month = d.getMonth() + 1;
    const day   = d.getDate();

    // L1 × L2 base
    const L1 = _HOURLY[hour];
    const L2 = _DOW[dow];
    const timeBase = L1 * L2;

    // L3: find the highest-impact active event
    let L3 = 1.0, activeEvent = null;
    for (const [em, esd, span, label, , mult] of _EVENTS) {
      if (em === month && day >= esd && day < esd + span) {
        if (mult > L3) { L3 = mult; activeEvent = label; }
      }
    }

    // L4: vehicle elasticity
    const vk = vehicle.toLowerCase().replace('-','').replace(' ','');
    const L4 = _ELASTICITY[vk] ?? _ELASTICITY.s;

    // Blend formula:
    //   When timeBase is high (busy period), event multipliers stack harder.
    //   When timeBase is low (off-peak), event impact is dampened (sqrt blend).
    const blended = timeBase >= 0.75
      ? timeBase * L3 * L4
      : timeBase * Math.pow(L3, 0.55) * L4;

    // Map to [1.0, 3.0] via calibrated affine transform
    const raw = 0.88 + blended * 1.38;
    const multiplier = Math.min(3.0, Math.max(1.0, Math.round(raw * 20) / 20));

    // Human label tiers
    const label = multiplier >= 2.5 ? 'Surge'
      : multiplier >= 1.75 ? 'High Demand'
      : multiplier >= 1.25 ? 'Peak'
      : 'Standard';

    return {
      multiplier,
      label,
      signals: { L1_hourly: L1, L2_dow: L2, L3_event: L3, L4_elasticity: L4, activeEvent },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRESTIGE MATCH™
  // Scores each available driver for a given booking across six dimensions,
  // producing an ordered shortlist for admin dispatch or auto-assignment.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * prestigeMatch(booking, drivers) → drivers[] sorted by matchScore desc
   *
   * Scoring dimensions (max 100 pts):
   *   D1 — Service rating          0-25 pts
   *   D2 — Vehicle class fit       0-22 pts
   *   D3 — ETA proximity           0-18 pts
   *   D4 — Corporate account link  0-15 pts
   *   D5 — Repeat client affinity  0-12 pts
   *   D6 — Availability penalty    −50 pts if busy
   *
   * @param {Object} booking
   * @param {string} booking.vehicleClass  "S-Class"|"V-Class"|"Rolls-Royce Phantom"
   * @param {string} [booking.corporateId]
   * @param {string} [booking.clientId]
   * @param {string} [booking.flightNum]   presence boosts punctuality weight
   * @param {Object[]} drivers
   * @returns {Object[]}  drivers with added .matchScore and .matchBreakdown
   */
  function prestigeMatch(booking, drivers) {
    if (!Array.isArray(drivers) || !drivers.length) return [];

    const vReq = (booking.vehicleClass || '').toLowerCase();
    const isAirport = booking.tripType === 'airport' || !!booking.flightNum;

    // Vehicle affinity matrix [requested → driver vehicle → score]
    const _V = {
      's-class':              { 's-class': 22, 'v-class':  8, 'rolls-royce phantom': 14 },
      'v-class':              { 's-class': 12, 'v-class': 22, 'rolls-royce phantom':  7 },
      'rolls-royce phantom':  { 's-class':  4, 'v-class':  0, 'rolls-royce phantom': 22 },
    };
    const vKey = Object.keys(_V).find(k => vReq.includes(k.split('-')[0])) || 's-class';

    return drivers.map(driver => {
      const dv = (driver.vehicle || '').toLowerCase();
      let D1 = 0, D2 = 0, D3 = 0, D4 = 0, D5 = 0, penalty = 0;

      // D1 — Rating (max 25)
      const rating = parseFloat(driver.rating) || 4.0;
      D1 = Math.round(((rating - 1) / 4) * 25);

      // D2 — Vehicle fit (max 22) — airport trips weight punctuality over luxury
      const rawVScore = (_V[vKey]?.[dv]) ?? 8;
      D2 = isAirport ? Math.round(rawVScore * 0.85) : rawVScore;

      // D3 — ETA (max 18) — linear decay 0→30 min window
      const eta = Math.max(0, parseFloat(driver.etaMinutes) || 12);
      D3 = Math.round(Math.max(0, 18 - (eta / 30) * 18));

      // D4 — Corporate affinity (max 15)
      if (booking.corporateId) {
        const linked = driver.corporateIds || [];
        if (linked.includes(booking.corporateId)) D4 = 15;
        else if (linked.length > 0) D4 = 5; // experienced with corporates
      }

      // D5 — Repeat client (max 12)
      const past = driver.pastClients || [];
      if (booking.clientId && past.includes(booking.clientId)) D5 = 12;
      else if (past.length >= 10) D5 = 3; // experienced driver bonus

      // Availability penalty
      if (driver.status === 'busy') penalty = 50;

      const matchScore = Math.max(0, D1 + D2 + D3 + D4 + D5 - penalty);

      return {
        ...driver,
        matchScore,
        matchBreakdown: { rating: D1, vehicle: D2, eta: D3, corporate: D4, repeat: D5, penalty },
      };
    }).sort((a, b) => b.matchScore - a.matchScore);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SILENT SERVICE™ — preference memory engine
  // Learns client patterns from booking history; returns a profile + prefill.
  // ─────────────────────────────────────────────────────────────────────────
  function silentService(history) {
    if (!Array.isArray(history) || !history.length) return null;
    const count = (arr) => arr.reduce((m, v) => { if (v) m[v] = (m[v] || 0) + 1; return m; }, {});
    const top = (m, n = 3) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

    const pickups   = count(history.map(b => b.pickup));
    const dropoffs  = count(history.map(b => b.dropoff || b.airport));
    const services  = count(history.map(b => b.serviceType));
    const vehicles  = count(history.map(b => b.vehicle));
    const hours     = count(history.map(b => (b.time || '').slice(0, 2)).filter(Boolean));

    // Requirements that appear in ≥40% of day bookings become "always" prefs
    const dayBookings = history.filter(b => b.serviceType === 'day' && b.concierge);
    const reqFreq = {};
    dayBookings.forEach(b => (b.concierge.requirements || []).forEach(r => { reqFreq[r] = (reqFreq[r] || 0) + 1; }));
    const alwaysReqs = Object.entries(reqFreq)
      .filter(([, c]) => dayBookings.length && c / dayBookings.length >= 0.4)
      .map(([k]) => k);

    const topService = top(services, 1)[0] || 'airport';
    return {
      bookings: history.length,
      topPickups:   top(pickups),
      topDropoffs:  top(dropoffs),
      preferredService: topService,
      preferredVehicle: top(vehicles, 1)[0] || null,
      preferredHour:    top(hours, 1)[0] || null,
      alwaysRequirements: alwaysReqs,
      // Two-tap prefill suggestion
      prefill: {
        serviceType: topService,
        pickup:  top(pickups, 1)[0]  || '',
        dropoff: top(dropoffs, 1)[0] || '',
        time:    (top(hours, 1)[0] || '10') + ':00',
        requirements: alwaysReqs,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // APEX ETA™ — certainty-calibrated arrival buffering
  // Luxury optimises for *certainty*, not speed. Buffer scales by stakes.
  // ─────────────────────────────────────────────────────────────────────────
  // Percentile buffer factors by trip stakes (applied to base travel time)
  const _ETA_STAKES = {
    flight:     { pct: 0.97, factor: 0.45, floor: 20, label: 'Flight departure' },
    eurostar:   { pct: 0.95, factor: 0.40, floor: 15, label: 'Rail departure'   },
    event:      { pct: 0.93, factor: 0.30, floor: 12, label: 'Timed engagement' },
    restaurant: { pct: 0.90, factor: 0.22, floor: 8,  label: 'Reservation'      },
    general:    { pct: 0.85, factor: 0.15, floor: 5,  label: 'General'          },
  };

  function apexETA({ baseMinutes, tripType = 'general', hour = 12 }) {
    const s = _ETA_STAKES[tripType] || _ETA_STAKES.general;
    // Congestion widening: rush hours inflate variance
    const congestion = (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 19) ? 1.35 : 1.0;
    const buffer = Math.max(s.floor, Math.round(baseMinutes * s.factor * congestion));
    return {
      baseMinutes,
      bufferMinutes: buffer,
      totalMinutes: baseMinutes + buffer,
      confidence: s.pct,
      stakes: s.label,
      promise: 'Arrive ' + buffer + ' min early — ' + Math.round(s.pct * 100) + '% on-time certainty',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // QUIET ROUTE™ — comfort-weighted route scoring
  // Scores candidate routes by glide quality, not just speed.
  // route: { minutes, stopsPerKm, roughSegments, scenicKm, totalKm }
  // ─────────────────────────────────────────────────────────────────────────
  function quietRoute(routes, { maxExtraMinutes = 8 } = {}) {
    if (!Array.isArray(routes) || !routes.length) return [];
    const fastest = Math.min(...routes.map(r => r.minutes));
    return routes.map(r => {
      const extra = r.minutes - fastest;
      const flow      = Math.max(0, 40 - (r.stopsPerKm || 1.5) * 14);          // 0-40: fewer stop-starts
      const smooth    = Math.max(0, 30 - (r.roughSegments || 0) * 6);          // 0-30: surface quality
      const scenic    = Math.min(20, ((r.scenicKm || 0) / (r.totalKm || 1)) * 40); // 0-20
      const timeCost  = extra > maxExtraMinutes ? (extra - maxExtraMinutes) * 4 : 0;
      const comfortScore = Math.max(0, Math.round(flow + smooth + scenic + 10 - timeCost));
      return { ...r, comfortScore, extraMinutes: extra,
        breakdown: { flow: Math.round(flow), smooth: Math.round(smooth), scenic: Math.round(scenic), timeCost: Math.round(timeCost) } };
    }).sort((a, b) => b.comfortScore - a.comfortScore);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // APEX LIFETIME™ — client value tiering (RFM + growth trend)
  // Tiers: Member → Gold → Black. Feeds PrestigeMatch + surge caps.
  // ─────────────────────────────────────────────────────────────────────────
  function apexLifetime(clientBookings, now = Date.now()) {
    if (!Array.isArray(clientBookings) || !clientBookings.length)
      return { tier: 'Member', score: 0, breakdown: {} };
    const spend = clientBookings.reduce((s, b) => s + (parseFloat(b.price) || 0), 0);
    const times = clientBookings.map(b => new Date(b.date || b.createdAt || now).getTime()).filter(t => !isNaN(t));
    const daysSinceLast = times.length ? Math.floor((now - Math.max(...times)) / 86400000) : 999;

    const R = daysSinceLast <= 14 ? 25 : daysSinceLast <= 45 ? 18 : daysSinceLast <= 90 ? 10 : 2;
    const F = Math.min(25, clientBookings.length * 2.5);
    const M = spend >= 10000 ? 30 : spend >= 4000 ? 22 : spend >= 1500 ? 14 : spend >= 500 ? 8 : 3;
    // Growth: last-90-day spend vs prior 90 days
    const cut = now - 90 * 86400000;
    const recent = clientBookings.filter(b => new Date(b.date || b.createdAt || 0).getTime() >= cut)
      .reduce((s, b) => s + (parseFloat(b.price) || 0), 0);
    const prior = spend - recent;
    const G = recent > prior * 1.2 ? 20 : recent > prior * 0.8 ? 12 : 5;

    const score = Math.round(R + F + M + G);
    const tier = score >= 75 ? 'Black' : score >= 45 ? 'Gold' : 'Member';
    return { tier, score, spend: Math.round(spend), breakdown: { recency: R, frequency: F, monetary: M, growth: G } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FLEET PULSE™ — predictive driver positioning
  // Converts the ApexYield event calendar into staging recommendations.
  // ─────────────────────────────────────────────────────────────────────────
  const _STAGING = {
    "Wimbledon Fortnight": 'Wimbledon Village / SW19', "Wimbledon Final": 'Wimbledon Village / SW19',
    "Royal Ascot": 'Windsor & Ascot approaches', "Henley Royal Regatta": 'Henley-on-Thames',
    "London Fashion Week": 'Soho & The Strand', "Frieze Art Fair": "Regent's Park perimeter",
    "BFI London Film Festival": 'South Bank & Leicester Sq', "New Year's Eve": 'Mayfair & Knightsbridge',
    "Dubai World Cup": 'Meydan approaches', "GITEX Global": 'DWTC & Sheikh Zayed Rd',
    "Dubai Airshow": 'DWC corridor', "Formula E Dubai": 'Downtown & DIFC',
    "Dubai Shopping Festival": 'Dubai Mall & MoE', "Art Dubai": 'Madinat Jumeirah',
  };

  function fleetPulse(dateStr, { market = 'london', idleDrivers = 0 } = {}) {
    const d = new Date(dateStr + 'T12:00:00');
    if (isNaN(d)) return [];
    const month = d.getMonth() + 1, day = d.getDate();
    const recs = [];
    for (const [em, esd, span, label, , mult] of _EVENTS) {
      if (em === month && day >= esd && day < esd + span) {
        const zone = _STAGING[label];
        if (!zone) continue;
        const cars = Math.max(1, Math.round(idleDrivers * Math.min(0.6, (mult - 1) * 0.5)));
        recs.push({ event: label, zone, expectedSurge: mult,
          suggestedCars: cars,
          window: mult >= 2 ? 'Stage 90 min before peak' : 'Stage 45 min before peak' });
      }
    }
    return recs.sort((a, b) => b.expectedSurge - a.expectedSurge);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // APEX GUARD™ — cancellation / no-show risk scoring
  // ─────────────────────────────────────────────────────────────────────────
  function apexGuard(booking, clientHistory = []) {
    let risk = 0;
    const reasons = [];
    const total = clientHistory.length;
    const cancelled = clientHistory.filter(b => b.status === 'cancelled').length;
    if (total >= 3 && cancelled / total > 0.25) { risk += 35; reasons.push('Cancellation history'); }
    else if (cancelled > 0) { risk += 12; reasons.push('Prior cancellation'); }
    if (total === 0) { risk += 18; reasons.push('First booking'); }
    if (booking.paymentStatus !== 'paid') { risk += 22; reasons.push('Unpaid at booking'); }
    // Lead time: same-day low risk; >14 days ahead drifts
    const lead = (new Date(booking.date + 'T' + (booking.time || '12:00')) - Date.now()) / 86400000;
    if (lead > 14) { risk += 15; reasons.push('Long lead time'); }
    if (booking.time) { const h = parseInt(booking.time); if (h >= 22 || h <= 4) { risk += 10; reasons.push('Late-night pickup'); } }
    const score = Math.min(100, risk);
    const level = score >= 55 ? 'high' : score >= 30 ? 'medium' : 'low';
    return { score, level, reasons,
      action: level === 'high' ? 'Require confirmation 3h before pickup'
            : level === 'medium' ? 'Send gentle confirmation nudge'
            : 'No action — trusted booking' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONCIERGE AUTOPLAN™ — itinerary ordering optimiser
  // Fixed-time stops are anchors; flexible stops slot between them by
  // category opening-hours heuristics + greedy nearest-window assignment.
  // ─────────────────────────────────────────────────────────────────────────
  const _CATEGORY_WINDOWS = {
    breakfast: [8, 10], collection: [9, 17], shopping: [10, 18], gallery: [10, 17],
    lunch: [12, 14], business: [9, 17], spa: [10, 19], dinner: [19, 21], errand: [9, 17],
  };

  function _guessCategory(text) {
    const t = (text || '').toLowerCase();
    if (/breakfast|brunch/.test(t)) return 'breakfast';
    if (/lunch/.test(t)) return 'lunch';
    if (/dinner|restaurant/.test(t)) return 'dinner';
    if (/shop|harrods|selfridges|bond st|boutique/.test(t)) return 'shopping';
    if (/galler|museum|exhibit/.test(t)) return 'gallery';
    if (/spa|salon|barber|groom/.test(t)) return 'spa';
    if (/collect|pick ?up|dry clean|tailor|jewell?er/.test(t)) return 'collection';
    if (/meeting|office|bank|sign/.test(t)) return 'business';
    return 'errand';
  }

  function autoPlan(stops, { dayStart = 9, dayEnd = 19 } = {}) {
    if (!Array.isArray(stops) || !stops.length) return [];
    const fixed = [], flexible = [];
    stops.forEach((s, i) => {
      const item = { ...s, _i: i, category: s.category || _guessCategory(s.place + ' ' + (s.note || '')) };
      if (s.time) { item._h = parseInt(s.time); fixed.push(item); } else flexible.push(item);
    });
    fixed.sort((a, b) => a._h - b._h);

    // Score each flexible stop's affinity to each open hour slot, place greedily
    const taken = new Set(fixed.map(f => f._h));
    const placed = [];
    flexible.forEach(f => {
      const [wo, wc] = _CATEGORY_WINDOWS[f.category] || [dayStart, dayEnd];
      let best = null, bestDist = 1e9;
      for (let h = dayStart; h <= dayEnd; h++) {
        if (taken.has(h)) continue;
        const mid = (wo + wc) / 2;
        const dist = h >= wo && h <= wc ? Math.abs(h - mid) : Math.abs(h - mid) + 6; // out-of-window penalty
        if (dist < bestDist) { bestDist = dist; best = h; }
      }
      if (best !== null) { taken.add(best); f._h = best; placed.push(f); }
    });

    return [...fixed, ...placed].sort((a, b) => a._h - b._h)
      .map(s => ({ time: (s.time || String(s._h).padStart(2, '0') + ':00'), place: s.place,
        note: s.note || '', category: s.category, anchored: !!s.time }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DISCRETE MODE™ — privacy-weighted dispatch for high-profile clients
  // ─────────────────────────────────────────────────────────────────────────
  function discreteMode(booking, drivers) {
    const ranked = prestigeMatch(booking, drivers).map(d => {
      let privacyScore = 0;
      if (d.ndaSigned) privacyScore += 30;
      if ((d.yearsService || 0) >= 3) privacyScore += 10;
      if ((d.rating || 0) >= 4.8) privacyScore += 10;
      if (d.mediaTrained) privacyScore += 15;
      return { ...d, privacyScore, discreteTotal: d.matchScore + privacyScore };
    }).sort((a, b) => b.discreteTotal - a.discreteTotal);
    return {
      drivers: ranked,
      // Driver-facing preview is masked until acceptance
      maskedPreview: { client: 'Private Client', pickup: (booking.pickup || '').split(',')[0],
        dropoff: 'Disclosed on acceptance', notes: 'Discrete service protocol applies' },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────
  return {
    version: '2.0.0',
    apexYield,
    prestigeMatch,
    silentService,
    apexETA,
    quietRoute,
    apexLifetime,
    fleetPulse,
    apexGuard,
    autoPlan,
    discreteMode,
    // Expose raw tables for testing / visualisation
    _HOURLY,
    _DOW,
    _EVENTS,
    _ELASTICITY,
  };
});
