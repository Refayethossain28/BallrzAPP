import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPulse, heatAt, nextPeak, goOnlineAdvice, hourOfWeek } from './pulse.ts';

// Fixed "now": Friday 2026-07-10 12:00 local.
const NOW = new Date(2026, 6, 10, 12, 0, 0);
/** A booking `weeksAgo` at the given local day (0=Sun…5=Fri…) and hour. */
const at = (weeksAgo: number, day: number, hour: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - weeksAgo * 7 - ((NOW.getDay() - day + 7) % 7));
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

// Six weeks of a Friday-17:00 rush plus background noise.
const HISTORY: number[] = [];
for (let w = 1; w <= 6; w++) {
  for (let i = 0; i < 8; i++) HISTORY.push(at(w, 5, 17)); // Friday 5pm rush
  HISTORY.push(at(w, 2, 10), at(w, 3, 14), at(w, 1, 9)); // scattered baseline
}

test('hourOfWeek: Monday 00:00 is bucket 0, Sunday 23:00 is 167', () => {
  assert.equal(hourOfWeek(new Date(2026, 6, 6, 0, 0)), 0);    // Mon
  assert.equal(hourOfWeek(new Date(2026, 6, 12, 23, 0)), 167); // Sun
});

test('the profile finds the Friday-17:00 rush and normalizes to mean 1', () => {
  const p = buildPulse(HISTORY, NOW);
  assert.ok(p.ready);
  const friday5 = new Date(2026, 6, 10, 17, 0);
  const tuesday3am = new Date(2026, 6, 7, 3, 0);
  assert.ok(heatAt(p, friday5) > 3, String(heatAt(p, friday5)));
  assert.ok(heatAt(p, tuesday3am) < 0.5);
  const mean = p.buckets.reduce((a, b) => a + b, 0) / 168;
  assert.ok(Math.abs(mean - 1) < 1e-9);
});

test('smoothing warms the shoulders of a peak', () => {
  const p = buildPulse(HISTORY, NOW);
  assert.ok(heatAt(p, new Date(2026, 6, 10, 16, 0)) > 1); // 4pm pre-rush
  assert.ok(heatAt(p, new Date(2026, 6, 10, 18, 0)) > 1); // 6pm tail
});

test('recency decay: the same rush 20 weeks ago counts far less', () => {
  const old: number[] = [];
  for (let w = 20; w <= 25; w++) for (let i = 0; i < 8; i++) old.push(at(w, 5, 17));
  const pOld = buildPulse(old, NOW);
  const pNew = buildPulse(HISTORY, NOW);
  assert.ok(pNew.mass > pOld.mass * 5);
});

test('nextPeak names the coming Friday rush with lead time', () => {
  const p = buildPulse(HISTORY, NOW);
  const peak = nextPeak(p, NOW); // Friday noon → peak at 17:00 (5h away)
  assert.ok(peak);
  assert.equal(peak!.label, 'Fri 17:00');
  assert.equal(peak!.hoursAway, 5);
});

test('advice: quiet-with-forecast at noon, strong inside the rush, honest cold start', () => {
  const p = buildPulse(HISTORY, NOW);
  const noon = goOnlineAdvice(p, NOW);
  assert.ok(['quiet', 'good', 'ramp'].includes(noon.level));
  assert.match(noon.reason, /Fri 17:00|typical/);
  const rush = goOnlineAdvice(p, new Date(2026, 6, 10, 17, 0));
  assert.equal(rush.level, 'strong');
  const cold = goOnlineAdvice(buildPulse([], NOW), NOW);
  assert.equal(cold.level, 'quiet');
  assert.match(cold.reason, /Not enough booking history/);
});

test('nextPeak returns the NEXT local peak, not the tallest in the window', () => {
  // Small Friday 14:00 bump (soon) + big Saturday 10:00 rush (later).
  const two: number[] = [];
  for (let w = 1; w <= 6; w++) {
    for (let i = 0; i < 4; i++) two.push(at(w, 5, 14)); // Fri 2pm — smaller
    for (let i = 0; i < 9; i++) two.push(at(w, 6, 10)); // Sat 10am — bigger
  }
  const p2 = buildPulse(two, NOW); // NOW = Friday 12:00
  const peak = nextPeak(p2, NOW);
  assert.ok(peak);
  assert.equal(peak!.label, 'Fri 14:00'); // the NEXT one, 2h away
  assert.equal(peak!.hoursAway, 2);
});
