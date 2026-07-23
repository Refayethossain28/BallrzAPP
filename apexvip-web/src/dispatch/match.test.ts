import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, rankDrivers, vehicleFit, haversineKm, type MatchDriver } from './match.ts';

const D = (over: Partial<MatchDriver> = {}): MatchDriver => ({
  id: over.id || 'd1', rating: 4.8, ratingCount: 100, acceptRate: 0.9, offerCount: 50,
  idleMinutes: 60, vehicle: 'S-Class', compliant: true, status: 'online', ...over,
});

test('hard gates: non-compliant, offline, and capacity-unfit drivers are excluded', () => {
  assert.equal(matchScore(D({ compliant: false }), {}), null);
  assert.equal(matchScore(D({ status: 'ontrip' }), {}), null);
  assert.equal(matchScore(D({ vehicle: 'S-Class' }), { passengers: 6 }), null); // 6 pax needs a V
  assert.ok(matchScore(D({ vehicle: 'V-Class' }), { passengers: 6 }));
});

test('Bayesian smoothing: a 5.0-from-2-trips rookie does not outrank 4.9-from-400', () => {
  const rookie = matchScore(D({ id: 'rookie', rating: 5.0, ratingCount: 2 }), {})!;
  const veteran = matchScore(D({ id: 'vet', rating: 4.9, ratingCount: 400 }), {})!;
  assert.ok(veteran.factors.performance > rookie.factors.performance);
});

test('proximity decays with distance; unknown positions are neutral', () => {
  const job = { lat: 51.5074, lng: -0.1278 };
  const near = matchScore(D({ id: 'near', lat: 51.51, lng: -0.13 }), job)!;
  const far = matchScore(D({ id: 'far', lat: 51.65, lng: -0.4 }), job)!;
  const unknown = matchScore(D({ id: 'unk' }), job)!;
  assert.ok(near.factors.proximity > far.factors.proximity);
  assert.equal(unknown.factors.proximity, 0.5);
});

test('fairness: long-idle drivers get a saturating boost', () => {
  const fresh = matchScore(D({ idleMinutes: 0 }), {})!;
  const waiting = matchScore(D({ idleMinutes: 120 }), {})!;
  const allDay = matchScore(D({ idleMinutes: 240 }), {})!;
  const forever = matchScore(D({ idleMinutes: 2400 }), {})!;
  assert.equal(fresh.factors.fairness, 0);
  assert.ok(waiting.factors.fairness > 0.5 && waiting.factors.fairness < 1);
  assert.equal(allDay.factors.fairness, 1);
  assert.equal(forever.factors.fairness, 1); // saturates — no infinite hoarding
});

test('VIP affinity: for a black-tier guest the better performer wins over the nearer one', () => {
  const job = { lat: 51.5074, lng: -0.1278, clientTier: 'black' };
  const nearAverage = D({ id: 'near', rating: 4.2, ratingCount: 200, lat: 51.509, lng: -0.128 });
  const farExcellent = D({ id: 'star', rating: 5.0, ratingCount: 300, lat: 51.55, lng: -0.20 });
  const vip = rankDrivers([nearAverage, farExcellent], job);
  assert.equal(vip[0].id, 'star');
  // For a standard guest the proximity gap flips the ranking the other way.
  const std = rankDrivers([nearAverage, farExcellent], { ...job, clientTier: 'standard' });
  assert.equal(std[0].id, 'near');
});

test('vehicle fit: exact 1, luxury upgrade 0.7, group job in a saloon 0', () => {
  assert.equal(vehicleFit('S-Class', { vehicle: 'S-Class' }), 1);
  assert.equal(vehicleFit('V-Class', { vehicle: 'S-Class' }), 0.7);
  assert.equal(vehicleFit('S-Class', { vehicle: 'E-Class' }), 0.7);
  assert.equal(vehicleFit('S-Class', { vehicle: 'V-Class' }), 0);
});

test('ranking is deterministic and best-first with a full breakdown', () => {
  const ranked = rankDrivers([D({ id: 'b', rating: 4.5 }), D({ id: 'a', rating: 5.0, ratingCount: 300 })], {});
  assert.equal(ranked[0].id, 'a');
  assert.ok(ranked[0].score >= ranked[1].score);
  assert.ok(ranked[0].score >= 0 && ranked[0].score <= 100);
  for (const k of ['performance', 'reliability', 'proximity', 'fairness', 'vehicleFit'] as const) {
    assert.ok(ranked[0].factors[k] >= 0 && ranked[0].factors[k] <= 1, k);
  }
});

test('haversine: London → Heathrow is ~23 km', () => {
  const km = haversineKm(51.5074, -0.1278, 51.47, -0.4543);
  assert.ok(km > 20 && km < 27, String(km));
});

test('non-numeric acceptRate cannot poison the score into NaN', () => {
  const bad = matchScore(D({ id: 'bad', acceptRate: NaN }), {})!;
  assert.ok(Number.isFinite(bad.score), String(bad.score));
  const worded = matchScore(D({ id: 'w', acceptRate: '90%' as unknown as number }), {})!;
  assert.ok(Number.isFinite(worded.score));
  // Ranking stays deterministic with a poisoned driver in the pool.
  const r = rankDrivers([D({ id: 'bad', acceptRate: NaN }), D({ id: 'ok' })], {});
  assert.equal(r.length, 2);
  assert.ok(r.every(x => Number.isFinite(x.score)));
});
