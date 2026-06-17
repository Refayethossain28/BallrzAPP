/**
 * ApexVIP Lib — shared pure helpers extracted from the client app.
 *
 * First slice of the single-file → modules migration: the hotel-rate estimate
 * engine. Pure, deterministic, framework-free, and unit-tested
 * (scripts/test-apexvip-lib.mjs). UMD so it works in the browser (window.ApexLib)
 * and under Node require/vm for tests — same pattern as apexvip-core.js.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ApexLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Cache key for a quoted stay.
  function hotelRateKey(name, checkIn, nights, guests) {
    return `${name}|${checkIn}|${nights}|${guests}`;
  }

  // Deterministic 0..1 from a string seed, so a given hotel+date is stable across renders.
  function seed01(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  }

  // Local dynamic price estimate: varies by date, weekend, season, demand/lead-time,
  // occupancy and length-of-stay. Returns the same shape the live Cloud Function does.
  function estimateHotelRate(hotel, checkIn, nights, guests) {
    nights = Math.max(1, nights || 1); guests = Math.max(1, guests || 2);
    const SEASON = [null, .85, .85, .92, 1.0, 1.05, 1.12, 1.15, 1.10, 1.05, 1.0, .9, 1.08]; // by month 1..12
    const start = checkIn ? new Date(checkIn + 'T12:00:00') : new Date();
    const today = new Date(); today.setHours(12, 0, 0, 0);
    let sum = 0, minNightly = Infinity;
    for (let i = 0; i < nights; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const dow = d.getDay();
      const weekend = (dow === 5 || dow === 6) ? 1.12 : (dow === 0 ? 1.0 : 0.97); // Fri/Sat premium, midweek softer
      const season = SEASON[d.getMonth() + 1];
      const noise = 0.95 + seed01(hotel.name + d.toISOString().slice(0, 10)) * 0.12; // stable ±
      const nightly = hotel.base * season * weekend * noise;
      sum += nightly; minNightly = Math.min(minNightly, nightly);
    }
    const leadDays = Math.round((start - today) / 86400000);
    const demand = leadDays <= 2 ? 1.08 : leadDays <= 10 ? 1.03 : leadDays >= 60 ? 0.96 : 1.0; // last-minute up, advance down
    const occ = guests >= 3 ? 1.10 : 1.0;
    const los = nights >= 7 ? 0.92 : nights >= 3 ? 0.96 : 1.0; // longer-stay discount
    const factor = demand * occ * los;
    sum *= factor; minNightly *= factor;
    const r5 = n => Math.round(n / 5) * 5;
    return {
      nightly: r5(sum / nights), from: r5(minNightly), total: r5(sum),
      nights, guests, currency: 'GBP', checkIn: start.toISOString().slice(0, 10),
      available: true, live: false, fetchedAt: Date.now()
    };
  }

  return { version: '1.0.0', hotelRateKey, seed01, estimateHotelRate };
});
