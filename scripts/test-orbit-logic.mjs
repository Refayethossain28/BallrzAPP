#!/usr/bin/env node
/**
 * Unit tests for orbit/engine.js — the Orbit super-app core: ride quotes,
 * surge, bidding, the trip state machine, cancel rules, food delivery,
 * parcels, the wallet ledger, Orbit+, rewards and price locks.
 * Run: node scripts/test-orbit-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// engine objects come from a vm realm, so compare by value, not prototype
const eq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'orbit', 'engine.js'), 'utf8'), sandbox, { filename: 'orbit/engine.js' });
const E = sandbox.module.exports;

// fixed clocks (UTC): Tue 2026-08-04 08:00 = morning rush; 13:00 = calm;
// Fri 2026-08-07 23:00 = nightlife; Wed 03:30 = night-owl.
const RUSH = Date.UTC(2026, 7, 4, 8, 0);
const CALM = Date.UTC(2026, 7, 4, 13, 0);
const NIGHTLIFE = Date.UTC(2026, 7, 7, 23, 0);
const NIGHTOWL = Date.UTC(2026, 7, 5, 3, 30);

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/* ── city & geometry ── */
test('roadKm: symmetric, winding, null for unknown places', () => {
  const d = E.roadKm('home', 'airport');
  assert.equal(d, E.roadKm('airport', 'home'));
  const a = E.place('home'), b = E.place('airport');
  const straight = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(d > straight, 'roads wind');
  assert.equal(E.roadKm('home', 'nowhere'), null);
});
test('pathPoints + posAlong interpolate from pickup to dropoff', () => {
  const pts = E.pathPoints('home', 'work');
  assert.equal(pts.length, 3);
  const start = E.posAlong(pts, 0), end = E.posAlong(pts, 1), mid = E.posAlong(pts, 0.5);
  eq(start, { x: E.place('home').x, y: E.place('home').y });
  eq(end, { x: E.place('work').x, y: E.place('work').y });
  assert.ok(mid.x !== start.x || mid.y !== start.y);
});

/* ── surge: honest & deterministic ── */
test('surge: rush hours, nightlife, night-owl discount, calm = 1.0', () => {
  eq(E.surgeAt(RUSH), { mult: 1.4, reason: 'Morning rush' });
  assert.equal(E.surgeAt(CALM).mult, 1.0);
  assert.equal(E.surgeAt(NIGHTLIFE).mult, 1.6);
  eq(E.surgeAt(NIGHTOWL), { mult: 0.9, reason: 'Night owl discount' });
});
test('traffic makes the same ride slower in the rush', () => {
  const calm = E.rideMins('home', 'airport', 'go', CALM);
  const rush = E.rideMins('home', 'airport', 'go', RUSH);
  assert.ok(rush > calm, `${rush} > ${calm}`);
});

/* ── quotes ── */
test('quote: breakdown sums to total (within a penny)', () => {
  const q = E.quote('home', 'airport', 'go', CALM);
  const sum = q.breakdown.reduce((s, l) => s + l.amount, 0);
  assert.ok(Math.abs(sum - q.total) < 0.011, `${sum} vs ${q.total}`);
});
test('quote: surge line appears only when surging', () => {
  const calm = E.quote('home', 'airport', 'go', CALM);
  const rush = E.quote('home', 'airport', 'go', RUSH);
  assert.ok(!calm.breakdown.some(l => /rush/i.test(l.label)));
  assert.ok(rush.breakdown.some(l => /Morning rush/.test(l.label)));
  assert.ok(rush.total > calm.total);
});
test('quote: minimum fare kicks in on tiny hops', () => {
  const q = E.quote('work', 'central', 'lux', CALM); // ~1.7 km in a Lux
  assert.ok(q.total >= E.rideClass('lux').minFare + E.BOOKING_FEE - 1e-9);
  assert.ok(q.breakdown.some(l => /Minimum fare/.test(l.label)));
});
test('quote: same question, same answer (deterministic); null for degenerate input', () => {
  eq(E.quote('home', 'airport', 'comfort', CALM), E.quote('home', 'airport', 'comfort', CALM));
  assert.equal(E.quote('home', 'home', 'go', CALM), null);
  assert.equal(E.quote('home', 'airport', 'warp', CALM), null);
});
test('quoteAll: one per class, Green has zero tailpipe CO2, Lux dearest', () => {
  const all = E.quoteAll('home', 'airport', CALM);
  assert.equal(all.length, E.RIDE_CLASSES.length);
  const green = all.find(q => q.classId === 'green');
  assert.equal(green.co2g, 0);
  const dearest = all.slice().sort((a, b) => b.total - a.total)[0];
  assert.equal(dearest.classId, 'lux');
});

/* ── drivers & bidding ── */
test('driversNear: seeded & stable, plausible ratings/ETAs', () => {
  const a = E.driversNear('home', 'go', 'day1');
  const b = E.driversNear('home', 'go', 'day1');
  eq(a, b);
  a.forEach(d => {
    assert.ok(d.rating >= 4.5 && d.rating <= 5);
    assert.ok(d.etaMin >= 1);
  });
  assert.notDeepStrictEqual(a, E.driversNear('home', 'go', 'day2'));
});
test('matchDriver picks the fastest arrival', () => {
  const pool = E.driversNear('home', 'go', 'day1');
  const best = E.matchDriver(pool);
  pool.forEach(d => assert.ok(best.etaMin <= d.etaMin));
});
test('bidding: lowball all-decline, near-quote all-accept, middle mixes counters', () => {
  const q = E.quote('home', 'airport', 'go', CALM);
  const pool = E.driversNear('home', 'go', 'day1');
  const low = E.bidResponses(q, q.total * 0.5, pool);
  assert.ok(low.every(r => r.kind === 'decline'));
  const high = E.bidResponses(q, q.total * 0.98, pool);
  assert.ok(high.every(r => r.kind === 'accept'));
  const mid = E.bidResponses(q, q.total * 0.8, pool);
  assert.ok(mid.some(r => r.kind !== 'decline'));
  mid.filter(r => r.kind === 'counter').forEach(r => {
    assert.ok(r.amount > q.total * 0.8 && r.amount <= q.total);
  });
});
test('bestBid prefers accepts; falls back to the cheapest counter', () => {
  const q = E.quote('home', 'airport', 'go', CALM);
  const pool = E.driversNear('home', 'go', 'day1');
  const best = E.bestBid(E.bidResponses(q, q.total * 0.98, pool));
  assert.equal(best.kind, 'accept');
  const counters = [
    { kind: 'counter', amount: 12, driver: { etaMin: 3, rating: 4.9 } },
    { kind: 'counter', amount: 11, driver: { etaMin: 5, rating: 4.7 } }
  ];
  assert.equal(E.bestBid(counters).amount, 11);
  assert.equal(E.bestBid([{ kind: 'decline', amount: null, driver: {} }]), null);
});

/* ── trip lifecycle & cancel rules ── */
test('trip advances through the full flow and stops at COMPLETED', () => {
  const q = E.quote('home', 'airport', 'go', CALM);
  const t = E.createTrip(q, E.matchDriver(E.driversNear('home', 'go', 'x')), q.total, CALM);
  assert.equal(t.status, 'REQUESTED');
  for (let i = 0; i < 10; i++) E.tripAdvance(t, CALM + i * 60000);
  assert.equal(t.status, 'COMPLETED');
  assert.equal(t.log.length, E.TRIP_FLOW.length);
});
test('cancel: free before match & in the 2-min grace, fees after', () => {
  const q = E.quote('home', 'airport', 'go', CALM);
  const mk = () => E.createTrip(q, { name: 'A' }, q.total, CALM);
  assert.equal(E.cancelQuote(mk(), CALM + 1000).fee, 0);
  const t = mk(); E.tripAdvance(t, CALM + 10000); // MATCHED at +10s
  assert.equal(E.cancelQuote(t, CALM + 60000).fee, 0);
  assert.equal(E.cancelQuote(t, CALM + 5 * 60000).fee, 4);
  E.tripAdvance(t, CALM + 6 * 60000); E.tripAdvance(t, CALM + 7 * 60000); // ARRIVED
  assert.equal(E.cancelQuote(t, CALM + 8 * 60000).fee, 5);
  E.tripAdvance(t, CALM + 9 * 60000); // IN_TRIP
  assert.equal(E.cancelQuote(t, CALM + 10 * 60000).fee, t.fare);
  E.cancelTrip(t, CALM + 10 * 60000);
  assert.equal(t.status, 'CANCELLED');
  assert.equal(E.cancelQuote(t, CALM + 11 * 60000), null);
});
test('safety: PIN is 4 digits, share code 6 chars, both deterministic', () => {
  assert.match(E.tripPin('TABC123'), /^\d{4}$/);
  assert.equal(E.tripPin('TABC123'), E.tripPin('TABC123'));
  assert.match(E.shareCode('TABC123'), /^[A-Z2-9]{6}$/);
  assert.notEqual(E.shareCode('TABC123'), E.shareCode('TXYZ999'));
});

/* ── scheduling & price lock ── */
test('schedule window: ≥30 min ahead, ≤7 days', () => {
  assert.equal(E.validateSchedule(CALM, CALM + 10 * 60000).ok, false);
  assert.equal(E.validateSchedule(CALM, CALM + 60 * 60000).ok, true);
  assert.equal(E.validateSchedule(CALM, CALM + 8 * 86400000).ok, false);
});
test('price lock: 5% fee (49p floor), honoured only within its window', () => {
  const q = E.quote('home', 'airport', 'comfort', CALM);
  const pl = E.priceLockQuote(q);
  assert.equal(pl.fee, Math.max(0.49, Math.round(q.total * 5) / 100));
  assert.equal(pl.locked, q.total);
  const lock = { untilMs: CALM + E.LOCK_DAYS * 86400000 };
  assert.ok(E.lockValid(lock, CALM + 86400000));
  assert.ok(!E.lockValid(lock, CALM + 8 * 86400000));
});

/* ── EAT ── */
test('eatQuote: fees itemised; Orbit+ waives delivery over the threshold', () => {
  const q = E.eatQuote('napoli', 'home', 22, { when: CALM });
  assert.ok(q.deliveryFee > 0);
  assert.equal(q.serviceFee, Math.min(3, Math.round(22 * 0.10 * 100) / 100));
  const plus = E.eatQuote('napoli', 'home', 22, { when: CALM, plus: true });
  assert.equal(plus.deliveryFee, 0);
  assert.ok(plus.total < q.total);
  const smallPlus = E.eatQuote('napoli', 'home', 9, { when: CALM, plus: true });
  assert.ok(smallPlus.deliveryFee > 0, 'threshold applies to Orbit+ too');
});
test('eatQuote: small-order fee under £8; WELCOME20 capped at £10', () => {
  const small = E.eatQuote('brew', 'home', 6, { when: CALM });
  assert.equal(small.smallOrderFee, 1.5);
  const promo = E.eatQuote('napoli', 'home', 80, { when: CALM, promo: 'WELCOME20' });
  assert.equal(promo.discount, 10);
});
test('order lifecycle walks PLACED→DELIVERED', () => {
  const o = { status: 'PLACED', log: [{ status: 'PLACED', ms: CALM }] };
  for (let i = 0; i < 9; i++) E.orderAdvance(o, CALM + i * 60000);
  assert.equal(o.status, 'DELIVERED');
  assert.equal(o.log.length, E.ORDER_FLOW.length);
});
test('DineOut: 20% with Orbit+, 10% without', () => {
  assert.equal(E.dineOutPct(true), 20);
  assert.equal(E.dineOutPct(false), 10);
});

/* ── SEND ── */
test('sendQuote: bigger parcels & longer hauls cost more; Orbit+ takes 10% off', () => {
  const s = E.sendQuote('home', 'work', 's');
  const l = E.sendQuote('home', 'work', 'l');
  assert.ok(l.total > s.total);
  const far = E.sendQuote('home', 'airport', 's');
  assert.ok(far.total > s.total);
  const plus = E.sendQuote('home', 'airport', 's', { plus: true });
  assert.ok(plus.total < far.total);
  assert.equal(E.sendQuote('home', 'home', 's'), null);
});
test('parcel job advances to DELIVERED', () => {
  const j = { status: 'BOOKED', log: [{ status: 'BOOKED', ms: CALM }] };
  for (let i = 0; i < 6; i++) E.sendAdvance(j, CALM + i * 60000);
  assert.equal(j.status, 'DELIVERED');
});

/* ── PAY ── */
test('wallet: balance derived from the ledger; spend guard', () => {
  const led = [E.makeTx('topup', 20, 'Top up', CALM), E.makeTx('ride', -7.5, 'Ride', CALM)];
  assert.equal(E.walletBalance(led), 12.5);
  assert.ok(E.canSpend(led, 12.5));
  assert.ok(!E.canSpend(led, 12.51));
});
test('splitBill: pennies distributed fairly, sums exactly', () => {
  const shares = E.splitBill(10, 3);
  eq(shares, [3.34, 3.33, 3.33]);
  assert.equal(Math.round(shares.reduce((a, b) => a + b) * 100), 1000);
  assert.equal(E.splitBill(10, 1), null);
});
test('cashback: 2% base, 10% with Orbit+', () => {
  assert.equal(E.rideCashback(20, false), 0.4);
  assert.equal(E.rideCashback(20, true), 2);
});

/* ── Orbit+ & rewards ── */
test('plusSavings adds up the four perk streams', () => {
  const saved = E.plusSavings({ rideSpend: 100, deliveriesSaved: 6, dineOutSpend: 40, parcelSpend: 20 });
  assert.equal(saved, 100 * 0.08 + 6 + 4 + 2);
});
test('points: per-£ rates by service; floor, never negative', () => {
  assert.equal(E.pointsFor('ride', 12.6), 63);
  assert.equal(E.pointsFor('eat', 10), 30);
  assert.equal(E.pointsFor('send', 4.9), 9);
  assert.equal(E.pointsFor('mystery', 100), 0);
});
test('tiers: thresholds and next-tier lookup', () => {
  assert.equal(E.tierFor(0).id, 'bronze');
  assert.equal(E.tierFor(1500).id, 'silver');
  assert.equal(E.tierFor(11999).id, 'gold');
  assert.equal(E.tierFor(12000).id, 'platinum');
  assert.equal(E.nextTier(1499).id, 'silver');
  assert.equal(E.nextTier(99999), null);
});
test('redeem: 500 pts → £2.50, whole blocks only', () => {
  eq(E.redeemQuote(1249), { blocks: 2, points: 1000, credit: 5 });
  assert.equal(E.redeemQuote(499).credit, 0);
});
/* ── MARKET (Quik groceries) ── */
test('quikQuote: fees itemised; Orbit+ waives the fee over £20; small-basket fee under £10', () => {
  const q = E.quikQuote('home', 25, { when: CALM });
  assert.equal(q.fee, E.QUIK_FEE);
  assert.equal(q.smallOrderFee, 0);
  const plus = E.quikQuote('home', 25, { when: CALM, plus: true });
  assert.equal(plus.fee, 0);
  const small = E.quikQuote('home', 6, { when: CALM });
  assert.equal(small.smallOrderFee, 1);
  assert.equal(small.total, Math.round((6 + E.QUIK_FEE + 1) * 100) / 100);
  assert.equal(E.quikQuote('home', 0), null);
});
test('quikQuote: 15-min promise near the store, honest ETA far away; rush slows it', () => {
  const near = E.quikQuote('home', 20, { when: CALM }); // Old Town → Home ≈ 2.6 km
  assert.ok(near.promise15, 'near drop inside the promise');
  assert.equal(near.lateCredit, E.QUIK_LATE_CREDIT);
  const far = E.quikQuote('airport', 20, { when: CALM });
  assert.ok(!far.promise15, 'airport is not a 15-min drop');
  assert.ok(E.quikQuote('beach', 20, { when: RUSH }).etaMin >= E.quikQuote('beach', 20, { when: CALM }).etaMin);
});
test('quik order lifecycle walks PLACED→DELIVERED', () => {
  const o = { status: 'PLACED', log: [{ status: 'PLACED', ms: CALM }] };
  for (let i = 0; i < 6; i++) E.quikAdvance(o, CALM + i * 60000);
  assert.equal(o.status, 'DELIVERED');
  assert.equal(o.log.length, E.QUIK_FLOW.length);
});
test('market catalog: every item priced above zero', () => {
  E.MARKET_AISLES.forEach(a => a.items.forEach(([name, price]) => {
    assert.ok(price > 0, name);
  }));
});

/* ── CAPTAIN mode ── */
test('captainEarn: 80/20 split that reconstructs the fare exactly', () => {
  const e = E.captainEarn(23.76);
  assert.equal(e.driver, 19.01);
  assert.equal(Math.round((e.driver + e.orbit) * 100) / 100, 23.76);
  assert.equal(E.CAPTAIN_CUT, 0.8);
});
test('captainOffers: seeded & stable, sane geometry, earn matches the 80% cut', () => {
  const a = E.captainOffers('shift1', CALM, 4);
  eq(a, E.captainOffers('shift1', CALM, 4));
  assert.equal(a.length, 4);
  a.forEach(o => {
    assert.notEqual(o.fromId, o.toId);
    assert.ok(o.fare > 0 && o.km > 0 && o.pickupKm > 0);
    assert.equal(o.earn, E.captainEarn(o.fare).driver);
  });
  assert.notDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(E.captainOffers('shift2', CALM, 4))));
});
test('acceptanceRate and day summary', () => {
  assert.equal(E.acceptanceRate(3, 4), 75);
  assert.equal(E.acceptanceRate(0, 0), null);
  const day = E.captainDaySummary([10, 15.5]);
  assert.equal(day.trips, 2);
  assert.equal(day.gross, 25.5);
  assert.equal(day.net, 20.4);
});

/* ── multi-stop rides ── */
test('multiStopQuote: legs sum, ONE booking fee, per-stop fee itemised', () => {
  const m = E.multiStopQuote(['home', 'central', 'airport'], 'go', CALM);
  const a = E.quote('home', 'central', 'go', CALM), b = E.quote('central', 'airport', 'go', CALM);
  assert.equal(m.legs.length, 2);
  assert.equal(m.km, Math.round((a.km + b.km) * 10) / 10);
  const expected = Math.round((a.total + b.total - E.BOOKING_FEE + E.STOP_FEE) * 100) / 100;
  assert.equal(m.total, expected);
  assert.ok(m.total < a.total + b.total, 'one booking beats two separate rides');
  assert.ok(m.breakdown.some(l => /extra stop/.test(l.label)));
  const sum = m.breakdown.reduce((s, l) => s + l.amount, 0);
  assert.ok(Math.abs(sum - m.total) < 0.02, `${sum} vs ${m.total}`);
});
test('multiStopQuote: validation — 2-4 stops, no repeats, known places', () => {
  assert.equal(E.multiStopQuote(['home'], 'go', CALM), null);
  assert.equal(E.multiStopQuote(['home', 'home'], 'go', CALM), null);
  assert.equal(E.multiStopQuote(['home', 'nowhere'], 'go', CALM), null);
  assert.equal(E.multiStopQuote(['home', 'work', 'mall', 'uni', 'park'], 'go', CALM), null);
  assert.ok(E.multiStopQuote(['home', 'work'], 'go', CALM));
});
test('pathThrough concatenates legs without duplicating join points', () => {
  const pts = E.pathThrough(['home', 'central', 'airport']);
  assert.equal(pts.length, 5); // 3 + 3 - 1 shared
  const end = pts[pts.length - 1];
  assert.equal(end.x, E.place('airport').x);
});

/* ── tips ── */
test('tips: 100% to the captain, no platform cut', () => {
  assert.equal(E.tipEarn(2), 2);
  assert.equal(E.tipEarn(2.505), 2.51);
});

/* ── route pass ── */
test('routePassQuote: 15% off per ride, price = 10 rides, savings honest', () => {
  const q = E.quote('home', 'work', 'go', CALM);
  const p = E.routePassQuote('home', 'work', 'go', CALM);
  assert.equal(p.perRide, Math.round(q.total * 0.85 * 100) / 100);
  assert.equal(p.price, Math.round(p.perRide * 10 * 100) / 100);
  assert.equal(p.saves, Math.round((q.total - p.perRide) * 10 * 100) / 100);
});
test('passCovers: route both directions, class-bound, expiry and rides-left enforced', () => {
  const pass = { fromId: 'home', toId: 'work', classId: 'go', left: 3, untilMs: CALM + 30 * 86400000 };
  assert.ok(E.passCovers(pass, 'home', 'work', 'go', CALM));
  assert.ok(E.passCovers(pass, 'work', 'home', 'go', CALM), 'return trips covered');
  assert.ok(!E.passCovers(pass, 'home', 'work', 'comfort', CALM));
  assert.ok(!E.passCovers(pass, 'home', 'airport', 'go', CALM));
  assert.ok(!E.passCovers({ ...pass, left: 0 }, 'home', 'work', 'go', CALM));
  assert.ok(!E.passCovers(pass, 'home', 'work', 'go', CALM + 31 * 86400000));
});

/* ── PayLater ── */
test('PayLater: charges accrue, £100 limit enforced with a reason', () => {
  const charges = [];
  assert.ok(E.plCharge(charges, 60, 'Ride', CALM));
  assert.equal(E.plDue(charges, CALM).due, 60);
  const deny = E.plCanCharge(charges, 45, CALM);
  assert.equal(deny.ok, false);
  assert.match(deny.why, /£100/);
  assert.equal(E.plCharge(charges, 45, 'Eat', CALM), null);
  assert.ok(E.plCanCharge(charges, 40, CALM).ok);
});
test('PayLater: settle clears the tab and returns the exact total', () => {
  const charges = [];
  E.plCharge(charges, 20.5, 'Ride', CALM);
  E.plCharge(charges, 10.25, 'Eat', CALM);
  assert.equal(E.plSettle(charges, CALM + 1000), 30.75);
  assert.equal(E.plDue(charges, CALM + 1000).due, 0);
  assert.ok(charges.every(c => c.settled));
  assert.equal(E.plSettle(charges, CALM + 2000), 0, 'second settle is a no-op');
});

/* ── referrals ── */
test('referralCode: deterministic per name, right shape', () => {
  assert.equal(E.referralCode('You'), E.referralCode('you '));
  assert.match(E.referralCode('You'), /^[A-Z2-9]{6}$/);
  assert.notEqual(E.referralCode('You'), E.referralCode('Amira'));
});
test('applyReferral: rejects own code, bad shapes and reuse; pays £5 once', () => {
  const own = E.referralCode('You');
  assert.equal(E.applyReferral(own, 'You', false).ok, false);
  assert.equal(E.applyReferral('AB', 'You', false).ok, false);
  assert.equal(E.applyReferral(E.referralCode('Amira'), 'You', true).ok, false);
  const ok = E.applyReferral(E.referralCode('Amira'), 'You', false);
  assert.equal(ok.ok, true);
  assert.equal(ok.bonus, 5);
});

/* ── Orbit Wheels ── */
test('stationDocks: deterministic per station+hour, bounded, stations only', () => {
  eq(E.stationDocks('central', CALM), E.stationDocks('central', CALM));
  const d = E.stationDocks('central', CALM);
  assert.ok(d.bikes >= 0 && d.bikes <= 8 && d.scooters >= 0 && d.scooters <= 6);
  assert.equal(E.stationDocks('home', CALM), null, 'home has no dock');
  assert.notDeepStrictEqual(
    JSON.parse(JSON.stringify(E.stationDocks('central', CALM))),
    JSON.parse(JSON.stringify(E.stationDocks('uni', CALM))));
});
test('wheelsQuote: unlock + per-min with a floor; scooter faster but dearer per min; 0 CO2', () => {
  const b = E.wheelsQuote('central', 'uni', 'bike', CALM);
  const s = E.wheelsQuote('central', 'uni', 'scooter', CALM);
  const bm = E.wheelMode('bike');
  assert.equal(b.total, Math.round(Math.max(bm.unlock + b.mins * bm.perMin, bm.minFare) * 100) / 100);
  assert.ok(s.mins < b.mins, 'scooter is quicker');
  assert.equal(b.co2g, 0);
  assert.equal(E.wheelsQuote('home', 'uni', 'bike', CALM), null, 'stations only');
  assert.equal(E.wheelsQuote('central', 'central', 'bike', CALM), null);
});

/* ── smart departure planner ── */
test('fareTimeline: right length, deterministic, rush windows cost more', () => {
  const midnightTue = Date.UTC(2026, 7, 4, 5, 0); // Tue 05:00 → spans morning rush
  const tl = E.fareTimeline('home', 'airport', 'go', midnightTue, 6, 30);
  assert.equal(tl.length, 13); // 6h at 30-min steps, inclusive
  eq(tl, E.fareTimeline('home', 'airport', 'go', midnightTue, 6, 30));
  const at5 = tl[0], at8 = tl.find(t => new Date(t.ms).getUTCHours() === 8);
  assert.ok(at8.total > at5.total, 'morning rush dearer than 5am');
  assert.equal(at8.surge.reason, 'Morning rush');
});
test('cheapestWindow finds the minimum honestly', () => {
  const tl = [{ ms: 1, total: 9 }, { ms: 2, total: 7 }, { ms: 3, total: 8 }];
  assert.equal(E.cheapestWindow(tl).ms, 2);
  assert.equal(E.cheapestWindow([]), null);
});

/* ── favourite captains ── */
test('matchDriver: favourites win; without favourites best-ETA still wins', () => {
  const pool = [
    { name: 'Amir', etaMin: 2, rating: 4.9 },
    { name: 'Layla', etaMin: 5, rating: 4.7 }
  ];
  assert.equal(E.matchDriver(pool).name, 'Amir');
  assert.equal(E.matchDriver(pool, ['Layla']).name, 'Layla', 'favourite beats faster ETA');
  assert.equal(E.matchDriver(pool, ['Nobody']).name, 'Amir');
});

/* ── business expenses ── */
test('expenseReport: filters month + business + completed, sums exactly, text report', () => {
  const mk = (fare, business, status, ms) => ({
    business, status, fare,
    startedMs: ms, quote: { fromId: 'home', toId: 'work' }
  });
  const AUG = Date.UTC(2026, 7, 10), SEP = Date.UTC(2026, 8, 10);
  const trips = [
    mk(10.5, true, 'COMPLETED', AUG),
    mk(4.25, true, 'COMPLETED', AUG),
    mk(99, false, 'COMPLETED', AUG),   // personal
    mk(50, true, 'CANCELLED', AUG),    // not completed
    mk(70, true, 'COMPLETED', SEP)     // wrong month
  ];
  const r = E.expenseReport(trips, '2026-08');
  assert.equal(r.count, 2);
  assert.equal(r.total, 14.75);
  assert.match(r.text, /Total: £14\.75 \(2 rides\)/);
  assert.match(r.text, /2026-08-10 {2}Home → The Exchange {2}£10\.50/);
});

/* ── the real marketplace protocol ── */
const REQ = () => E.mkRideRequest({ id: 'R1', riderUid: 'u-rider', riderName: 'Rafa', fromId: 'home', toId: 'airport', classId: 'go', fare: 23.5 }, CALM);
test('mkRideRequest: validates fields; rejects junk', () => {
  const r = REQ();
  assert.equal(r.status, 'OPEN');
  assert.equal(r.fare, 23.5);
  assert.ok(E.validRequest(r));
  assert.equal(E.mkRideRequest({ id: 'x', riderUid: 'u', fromId: 'home', toId: 'home', classId: 'go', fare: 5 }, CALM), null);
  assert.equal(E.mkRideRequest({ id: 'x', riderUid: 'u', fromId: 'home', toId: 'work', classId: 'warp', fare: 5 }, CALM), null);
  assert.equal(E.mkRideRequest({ id: 'x', riderUid: 'u', fromId: 'home', toId: 'work', classId: 'go', fare: -5 }, CALM), null);
  assert.ok(!E.validRequest({ status: 'HACKED' }));
});
test('claim: happy path; double-claim, self-drive and expired all rejected', () => {
  const cap = { uid: 'u-cap', name: 'Layla', car: 'Corolla', plate: 'M1', rating: 4.9 };
  const c1 = E.marketClaim(REQ(), cap, CALM + 1000);
  assert.ok(c1.ok);
  assert.equal(c1.ride.status, 'CLAIMED');
  assert.equal(c1.ride.captainUid, 'u-cap');
  assert.equal(E.marketClaim(c1.ride, { uid: 'u-other' }, CALM + 2000).ok, false, 'double claim');
  assert.equal(E.marketClaim(REQ(), { uid: 'u-rider' }, CALM + 1000).ok, false, 'self-drive');
  assert.equal(E.marketClaim(REQ(), cap, CALM + E.MARKET_OPEN_MS + 1).ok, false, 'expired');
  assert.ok(E.requestExpired(REQ(), CALM + E.MARKET_OPEN_MS + 1));
});
test('advance: only the assigned captain, strictly in order, stops at COMPLETED', () => {
  const cap = { uid: 'u-cap', name: 'Layla' };
  let r = E.marketClaim(REQ(), cap, CALM + 1000).ride;
  assert.equal(E.marketAdvance(r, 'u-rider').ok, false, 'rider cannot advance');
  assert.equal(E.marketAdvance(r, 'u-impostor').ok, false, 'impostor cannot advance');
  for (const want of ['ARRIVING', 'ARRIVED', 'IN_TRIP', 'COMPLETED']) {
    r = E.marketAdvance(r, 'u-cap').ride;
    assert.equal(r.status, want);
  }
  assert.equal(E.marketAdvance(r, 'u-cap').ok, false, 'complete is final');
  assert.equal(E.marketAdvance(REQ(), 'u-cap').ok, false, 'cannot advance an unclaimed request');
});
test('cancel: rider only, and never once the trip has started', () => {
  const cap = { uid: 'u-cap' };
  const open = REQ();
  assert.equal(E.marketCancel(open, 'u-cap').ok, false);
  assert.ok(E.marketCancel(open, 'u-rider').ok);
  let r = E.marketClaim(REQ(), cap, CALM + 1000).ride;
  assert.ok(E.marketCancel(r, 'u-rider').ok, 'cancellable while claimed');
  r = E.marketAdvance(r, 'u-cap').ride; // ARRIVING
  r = E.marketAdvance(r, 'u-cap').ride; // ARRIVED
  r = E.marketAdvance(r, 'u-cap').ride; // IN_TRIP
  assert.equal(E.marketCancel(r, 'u-rider').ok, false, 'in-trip is too late');
});
test('claim race: the rider tab applies the FIRST valid claim, ignores the rest', () => {
  const open = REQ();
  const a = E.marketClaim(open, { uid: 'u-a', name: 'A' }, CALM + 1000).ride;
  const b = E.marketClaim(open, { uid: 'u-b', name: 'B' }, CALM + 1000).ride;
  let state = E.marketResolveClaim(open, a, CALM + 1500);
  assert.equal(state.captainUid, 'u-a');
  state = E.marketResolveClaim(state, b, CALM + 1600);
  assert.equal(state.captainUid, 'u-a', 'second claim bounces');
  const tampered = { ...a, fare: 999 };
  assert.equal(E.marketResolveClaim(open, tampered, CALM + 1500).status, 'OPEN', 'fare tampering rejected');
});

/* ── Orbit Real: real-world geo, fares and requests ── */
test('geoKm: London→Paris is the real ~344 km; zero for same point', () => {
  const km = E.geoKm(51.5074, -0.1278, 48.8566, 2.3522);
  assert.ok(km > 330 && km < 355, 'got ' + km);
  assert.equal(E.geoKm(51.5, -0.12, 51.5, -0.12), 0);
});
test('realFare: same tariff card as the demo, real inputs; breakdown sums', () => {
  const f = E.realFare(10, 25, 'go', CALM);
  const cls = E.rideClass('go');
  const expected = Math.round((Math.max(cls.base + 10 * cls.perKm + 25 * cls.perMin, cls.minFare) + E.BOOKING_FEE) * 100) / 100;
  assert.equal(f.total, expected);
  const sum = f.breakdown.reduce((s, l) => s + l.amount, 0);
  assert.ok(Math.abs(sum - f.total) < 0.011);
  assert.ok(E.realFare(10, 25, 'go', RUSH).total > f.total, 'surge applies to real rides too');
  assert.equal(E.realFare(0, 25, 'go', CALM), null);
});
test('mkRealRequest: validates geo points; km defaults to haversine', () => {
  const r = E.mkRealRequest({
    id: 'RL1', riderUid: 'u-r', riderName: 'Rafa',
    from: { lat: 51.5074, lon: -0.1278, label: 'Trafalgar Square' },
    to: { lat: 51.5033, lon: -0.1195, label: 'Westminster' },
    classId: 'go', fare: 6.5
  }, CALM);
  assert.ok(E.validRealRequest(r));
  assert.equal(r.kind, 'real');
  assert.ok(r.km > 0.4 && r.km < 1.5, 'got ' + r.km);
  assert.equal(E.mkRealRequest({ id: 'x', riderUid: 'u', from: { lat: 99, lon: 0, label: 'bad' }, to: { lat: 0, lon: 0, label: 'ok' }, classId: 'go', fare: 5 }, CALM), null, 'lat out of range');
  assert.equal(E.mkRealRequest({ id: 'x', riderUid: 'u', from: { lat: 0, lon: 0 }, to: { lat: 1, lon: 1, label: 'ok' }, classId: 'go', fare: 5 }, CALM), null, 'label required');
});
test('real requests ride the SAME protocol: claim/advance/cancel guards hold', () => {
  const mk = () => E.mkRealRequest({
    id: 'RL2', riderUid: 'u-r', from: { lat: 51.5, lon: -0.12, label: 'A' },
    to: { lat: 51.52, lon: -0.10, label: 'B' }, classId: 'go', fare: 8
  }, CALM);
  const c = E.marketClaim(mk(), { uid: 'u-c', name: 'Layla' }, CALM + 1000);
  assert.ok(c.ok);
  assert.equal(E.marketClaim(c.ride, { uid: 'u-x' }, CALM + 2000).ok, false);
  assert.equal(E.marketAdvance(c.ride, 'u-x').ok, false);
  let r = c.ride;
  for (const want of ['ARRIVING', 'ARRIVED', 'IN_TRIP', 'COMPLETED']) {
    r = E.marketAdvance(r, 'u-c').ride;
    assert.equal(r.status, want);
  }
  assert.ok(!E.realExpired(mk(), CALM + E.REAL_OPEN_MS - 1), 'real window is 5 min');
  assert.ok(E.realExpired(mk(), CALM + E.REAL_OPEN_MS + 1));
  assert.equal(E.marketClaim(mk(), { uid: 'u-c' }, CALM + E.REAL_OPEN_MS + 1).ok, false);
});

test('fmtMoney formats sign and pence', () => {
  assert.equal(E.fmtMoney(7.5), '£7.50');
  assert.equal(E.fmtMoney(-3), '−£3.00');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (err) {
    console.error('FAIL - ' + name);
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
console.log(`\norbit engine: ${passed}/${tests.length} tests passed`);
