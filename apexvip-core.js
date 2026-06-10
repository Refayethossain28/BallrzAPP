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
  // Public API
  // ─────────────────────────────────────────────────────────────────────────
  return {
    version: '1.0.0',
    apexYield,
    prestigeMatch,
    // Expose raw tables for testing / visualisation
    _HOURLY,
    _DOW,
    _EVENTS,
    _ELASTICITY,
  };
});
