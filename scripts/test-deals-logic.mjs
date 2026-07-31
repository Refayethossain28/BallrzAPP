#!/usr/bin/env node
/**
 * Unit tests for deals-app/engine.js — the TravelDeals price model, forecast,
 * booking, refund and loyalty core. Run: node scripts/test-deals-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'deals-app', 'engine.js'), 'utf8'), sandbox, { filename: 'deals-app/engine.js' });
const E = sandbox.module.exports;

const TODAY = '2026-07-31';
const DEPART = '2026-09-15';
const RET = '2026-09-22';

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/* ── geo & dates ── */
test('haversine: JFK→LHR is the real ~5540 km', () => {
  const j = E.airportInfo('JFK'), l = E.airportInfo('LHR');
  const km = E.haversineKm([j.lat, j.lon], [l.lat, l.lon]);
  assert.ok(km > 5400 && km < 5700, 'got ' + km);
});
test('daysBetween & addDays round-trip', () => {
  assert.equal(E.daysBetween(TODAY, DEPART), 46);
  assert.equal(E.addDays(TODAY, 46), DEPART);
  assert.equal(E.addDays('2026-12-30', 3), '2027-01-02');
});
test('city aliases resolve (NYC→JFK, LON→LHR)', () => {
  assert.equal(E.resolveAirport('nyc'), 'JFK');
  assert.equal(E.resolveAirport('LON'), 'LHR');
  assert.equal(E.resolveAirport('XXX'), null);
});
test('flag emoji from country code', () => {
  assert.equal(E.flagEmoji('GB'), '🇬🇧');
});

/* ── price model ── */
test('priceOn is deterministic', () => {
  const a = E.priceOn('JFK', 'LHR', DEPART, TODAY, 'economy');
  const b = E.priceOn('JFK', 'LHR', DEPART, TODAY, 'economy');
  assert.equal(a, b);
  assert.ok(a > 100 && a < 2000, 'sane transatlantic economy: ' + a);
});
test('cabins are ordered: economy < premium < business < first', () => {
  const p = c => E.priceOn('JFK', 'LHR', DEPART, TODAY, c);
  assert.ok(p('economy') < p('premium') && p('premium') < p('business') && p('business') < p('first'));
});
test('advance-purchase curve: last-minute costs more than 2 months out', () => {
  assert.ok(E.advanceFactor(2) > E.advanceFactor(60));
  assert.ok(E.advanceFactor(60) < E.advanceFactor(10));
});
test('longer routes cost more', () => {
  const short = E.priceOn('LHR', 'CDG', DEPART, TODAY, 'economy');
  const long = E.priceOn('LHR', 'SYD', DEPART, TODAY, 'economy');
  assert.ok(long > short * 3, short + ' vs ' + long);
});

/* ── flight search ── */
test('searchFlights: deterministic, sorted by price, sane shape', () => {
  const p = { origin: 'JFK', dest: 'LHR', depart: DEPART, ret: RET, cabin: 'economy', adults: 1, today: TODAY };
  const r1 = E.searchFlights(p), r2 = E.searchFlights(p);
  assert.deepEqual(r1.offers.map(o => o.id), r2.offers.map(o => o.id));
  assert.ok(r1.offers.length >= 9);
  for (let i = 1; i < r1.offers.length; i++) assert.ok(r1.offers[i].price >= r1.offers[i - 1].price);
  const o = r1.offers[0];
  assert.ok(/^\d\d:\d\d$/.test(o.dep) && /^\d\d:\d\d$/.test(o.arr));
  assert.equal(o.fares.length, 3);
  assert.ok(o.fares[1].price > o.fares[0].price && o.fares[2].price > o.fares[1].price);
  assert.ok(o.fares[1].refundable && !o.fares[0].refundable);
});
test('searchFlights rejects bad input', () => {
  assert.ok(E.searchFlights({ origin: 'JFK', dest: 'JFK', depart: DEPART, today: TODAY }).error);
  assert.ok(E.searchFlights({ origin: 'JFK', dest: 'LHR', depart: '2020-01-01', today: TODAY }).error);
  assert.ok(E.searchFlights({ origin: 'JFK', dest: 'LHR', depart: DEPART, ret: '2026-09-01', today: TODAY }).error);
});
test('a stopping flight has a via airport and longer duration', () => {
  const r = E.searchFlights({ origin: 'JFK', dest: 'SIN', depart: DEPART, cabin: 'economy', adults: 1, today: TODAY });
  const withStop = r.offers.find(o => o.stops === 1);
  assert.ok(withStop, 'ultra-long-haul should include 1-stop offers');
  assert.ok(withStop.via && withStop.via !== 'JFK' && withStop.via !== 'SIN');
});

/* ── history, forecast, deal score ── */
test('priceHistory covers the window and is deterministic', () => {
  const p = { origin: 'JFK', dest: 'LHR', depart: DEPART, today: TODAY, cabin: 'economy' };
  const h = E.priceHistory(p, 60);
  assert.equal(h.length, 60);
  assert.equal(h[h.length - 1].d, TODAY);
  assert.deepEqual(h, E.priceHistory(p, 60));
});
test('forecast: inside 2 weeks always says buy', () => {
  const p = { origin: 'JFK', dest: 'LHR', depart: E.addDays(TODAY, 10), today: TODAY, cabin: 'economy' };
  const f = E.forecast(E.priceHistory(p, 60), 10);
  assert.equal(f.advice, 'buy');
});
test('dealScore: below typical scores high, above scores low', () => {
  assert.ok(E.dealScore(80, 100) > 65);
  assert.ok(E.dealScore(130, 100) < 35);
  assert.equal(E.dealScore(100, 100), 50);
});
test('flexGrid marks the cheapest day and spans ±3', () => {
  const g = E.flexGrid({ origin: 'JFK', dest: 'LHR', depart: DEPART, today: TODAY, cabin: 'economy' }, 3);
  assert.equal(g.length, 7);
  assert.equal(g.filter(x => x.best).length >= 1, true);
  const min = Math.min(...g.map(x => x.price));
  assert.ok(g.find(x => x.best).price === min);
});
test('searchAnywhere returns 12 scored destinations, no self', () => {
  const r = E.searchAnywhere('LHR', TODAY);
  assert.equal(r.results.length, 12);
  assert.ok(!r.results.find(x => x.code === 'LHR' || x.city === 'London'));
  for (const x of r.results) assert.ok(x.score >= 1 && x.score <= 99 && x.flag.length > 0);
  const scores = new Set(r.results.map(x => x.score));
  assert.ok(scores.size > 3, 'scores should vary, got ' + [...scores].join(','));
});

/* ── seats & validation ── */
test('seatMap: 14 rows × 6, exit row 8 priced, deterministic', () => {
  const m = E.seatMap('bookseed');
  assert.equal(m.length, 14);
  assert.equal(m[7].cls, 'exit');
  assert.ok(m[7].seats[0].price > 0);
  assert.equal(m[3].seats[2].price, 0);
  assert.deepEqual(m, E.seatMap('bookseed'));
});
test('luhn accepts real test PANs, rejects garbage', () => {
  assert.ok(E.luhn('4242 4242 4242 4242'));
  assert.ok(E.luhn('5555555555554444'));
  assert.ok(!E.luhn('4242424242424241'));
  assert.ok(!E.luhn('abcd'));
});
test('traveler & payment validation', () => {
  assert.equal(E.validTraveler({ first: 'Ada', last: 'Lovelace', email: 'ada@calc.io' }).length, 0);
  assert.ok(E.validTraveler({ first: 'A', last: '', email: 'nope' }).length === 3);
  assert.equal(E.validPayment({ number: '4242424242424242', expiry: '12/28', cvv: '123', name: 'Ada L' }, TODAY).length, 0);
  assert.ok(E.validPayment({ number: '4242424242424242', expiry: '01/20', cvv: '123', name: 'Ada L' }, TODAY).includes('Card expired'));
});

/* ── booking, refunds, loyalty ── */
test('PNR: 6 chars, unambiguous alphabet, deterministic', () => {
  const p = E.makePNR('trip-1');
  assert.equal(p.length, 6);
  for (const ch of p) assert.ok(E.PNR_ALPHABET.includes(ch), ch);
  assert.equal(p, E.makePNR('trip-1'));
  assert.notEqual(p, E.makePNR('trip-2'));
});
test('priceBooking totals add up', () => {
  const q = E.priceBooking({ farePrice: 200, adults: 2, seats: [{ price: 18 }, { price: 0 }], bags: 1, insurance: true });
  assert.equal(q.base, 400);
  assert.equal(q.seats, 18); assert.equal(q.bags, 35); assert.equal(q.insurance, 24);
  assert.equal(q.total, q.base + q.seats + q.bags + q.insurance + q.taxes);
});
test('refund rules: Saver credit-only, Flex full refund', () => {
  const s = E.refundQuote('Saver', 500), f = E.refundQuote('Flex', 500);
  assert.equal(s.refund, 0); assert.equal(s.credit, 300);
  assert.equal(f.refund, 500);
});
test('fare freeze: 5% fee, £5 floor, 48h expiry', () => {
  assert.equal(E.holdQuote(400, TODAY).fee, 20);
  assert.equal(E.holdQuote(40, TODAY).fee, 5);
  assert.equal(E.holdQuote(400, TODAY).expires, E.addDays(TODAY, 2));
});
test('loyalty: points and tier ladder', () => {
  assert.equal(E.pointsEarned(200), 1000);
  assert.equal(E.tierFor(0).name, 'Member');
  assert.equal(E.tierFor(5000).name, 'Silver');
  assert.equal(E.tierFor(39999).name, 'Gold');
  assert.equal(E.tierFor(40000).name, 'Platinum');
  assert.equal(E.tierFor(40000).next, null);
});
test('stay discounts ladder 0/10/15/20', () => {
  assert.equal(E.stayDiscountPct(0), 0);
  assert.equal(E.stayDiscountPct(5), 10);
  assert.equal(E.stayDiscountPct(15), 15);
  assert.equal(E.stayDiscountPct(31), 20);
});

/* ── hotels ── */
test('searchHotels: 12 stays, sorted by nightly, deterministic', () => {
  const p = { city: 'PAR', checkin: DEPART, checkout: RET, guests: 2, rooms: 1, today: TODAY };
  const r = E.searchHotels(p);
  assert.equal(r.hotels.length, 12);
  assert.equal(r.nights, 7);
  for (let i = 1; i < 12; i++) assert.ok(r.hotels[i].nightly >= r.hotels[i - 1].nightly);
  assert.deepEqual(r.hotels.map(h => h.id), E.searchHotels(p).hotels.map(h => h.id));
  const h = r.hotels[0];
  assert.ok(h.stars >= 2 && h.stars <= 5 && h.rating <= 9.8);
  assert.equal(h.rates.length, 3);
  assert.ok(h.rates[2].freeCancel && !h.rates[0].freeCancel);
});
test('searchHotels rejects bad dates', () => {
  assert.ok(E.searchHotels({ city: 'PAR', checkin: RET, checkout: DEPART, today: TODAY }).error);
  assert.ok(E.searchHotels({ city: 'ZZZ', checkin: DEPART, checkout: RET, today: TODAY }).error);
});
test('priceHotel applies stay discount before taxes', () => {
  const q = E.priceHotel({ nightly: 100, mult: 1, nights: 4, rooms: 1, discountPct: 10 });
  assert.equal(q.room, 400);
  assert.equal(q.discount, 40);
  assert.equal(q.total, q.room - q.discount + q.taxes);
});

/* ── money, alerts, barcode ── */
test('currency conversion round-trips within £1', () => {
  const gbp = E.convert(1000, 'USD', 'GBP');
  assert.ok(Math.abs(E.convert(gbp, 'GBP', 'USD') - 1000) <= 1);
  assert.equal(E.fmtMoney(1234, 'GBP'), '£1,234');
});
test('alertsDue fires only at-or-below target', () => {
  const cur = E.priceOn('JFK', 'LHR', DEPART, TODAY, 'economy');
  const a = E.alertsDue([{ origin: 'JFK', dest: 'LHR', depart: DEPART, target: cur }], TODAY);
  const b = E.alertsDue([{ origin: 'JFK', dest: 'LHR', depart: DEPART, target: cur - 1 }], TODAY);
  assert.equal(a[0].due, true);
  assert.equal(b[0].due, false);
});
test('barcode: deterministic widths 1–3', () => {
  const b = E.barcode('BCDFGH');
  assert.equal(b.length, 48);
  for (const w of b) assert.ok(w >= 1 && w <= 3);
  assert.deepEqual(b, E.barcode('BCDFGH'));
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (err) { console.error('FAIL - ' + name + '\n  ' + err.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' deals engine tests passed');
if (passed !== tests.length) process.exit(1);
