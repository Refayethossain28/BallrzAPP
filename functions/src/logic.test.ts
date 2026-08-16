/**
 * Unit tests for the pure backend logic (functions/src/logic.ts).
 * Run: `npm test` (node --test with TypeScript type-stripping).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as vm from 'node:vm';
import {
  round5, isoPlusDays, computeFareBounds, driverEarning, dispatchPay,
  bookingEvent, bookingMessage, daysUntil, shouldRemind, flightHHMM,
  normalizeCommissionPct, clientCoinsEarned, driverCoinsEarned,
  clampCoinRedemption, round2, coinEarnRates, apexTierForBalance,
  bonusMonthKey, monthlyBonusForBalance, qualifiesForRatingBonus, milestoneBonusAt,
  makeProCode, validProCode, atlasProEmail, guardianEmail, validateClipSubmission, ytClipMeta,
} from './logic.ts';

test('ApexCoin earn rates: tiered % for clients, flat % at 2dp for drivers', () => {
  assert.equal(clientCoinsEarned(200), 6); // Bronze default 3%
  assert.equal(clientCoinsEarned(185, 5), 9); // Gold rate
  assert.equal(clientCoinsEarned(190, 5), 10);
  assert.equal(clientCoinsEarned(0, 6), 0);
  assert.equal(clientCoinsEarned(-40, 6), 0);
  assert.equal(clientCoinsEarned(200, NaN), 6); // junk rate → Bronze default
  assert.equal(driverCoinsEarned(152), 3.04); // default 2%
  assert.equal(driverCoinsEarned(95.55), 1.91);
  assert.equal(driverCoinsEarned(152, 3), 4.56);
  assert.equal(driverCoinsEarned(NaN), 0);
});

test('coinEarnRates + apexTierForBalance mirror the engine', () => {
  assert.deepEqual(coinEarnRates(null), { tiers: { Bronze: 3, Silver: 4, Gold: 5, Platinum: 6 }, driverPct: 2 });
  const tuned = coinEarnRates({ silverPct: 4.5, platinumPct: 99, driverPct: 'x' as unknown as number });
  assert.equal(tuned.tiers.Silver, 4.5);
  assert.equal(tuned.tiers.Platinum, 20); // clamped
  assert.equal(tuned.driverPct, 2); // junk → default
  assert.equal(apexTierForBalance(0), 'Bronze');
  assert.equal(apexTierForBalance(500), 'Silver');
  assert.equal(apexTierForBalance(2000), 'Gold');
  assert.equal(apexTierForBalance(5000), 'Platinum');
});

test('clampCoinRedemption: whole coins, never beyond the balance, junk-safe', () => {
  assert.equal(clampCoinRedemption(60, 100), 60);
  assert.equal(clampCoinRedemption(500, 95), 95);
  assert.equal(clampCoinRedemption(42.9, 100), 42);
  assert.equal(clampCoinRedemption(10, 42.75), 10);
  assert.equal(clampCoinRedemption(-5, 100), 0);
  assert.equal(clampCoinRedemption('junk', 100), 0);
  assert.equal(clampCoinRedemption(10, -3), 0);
});

test('round2 avoids float drift', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(3.045), 3.05);
});

test('round5 rounds to the nearest £5', () => {
  assert.equal(round5(12), 10);
  assert.equal(round5(13), 15);
  assert.equal(round5(995.4), 995);
});

test('isoPlusDays adds days and stays on the calendar', () => {
  assert.equal(isoPlusDays('2026-07-03', 2), '2026-07-05');
  assert.equal(isoPlusDays('2026-07-30', 3), '2026-08-02');
});

test('computeFareBounds: defaults', () => {
  assert.deepEqual(computeFareBounds({}), { floor: 19, ceiling: 3605 });
});

test('computeFareBounds: custom rate card', () => {
  assert.deepEqual(
    computeFareBounds({ min_fare_s: 50, min_fare_v: 60, day_v: 600, hourly_v_rate: 80, peak_surcharge_pct: 20 }),
    { floor: 25, ceiling: 3956 },
  );
});

test('driverEarning is 80%, baseFare preferred over price', () => {
  assert.equal(driverEarning({ baseFare: 100 }), 80);
  assert.equal(driverEarning({ price: 50 }), 40);
  assert.equal(driverEarning({ baseFare: 100, price: 50 }), 80);
  assert.equal(driverEarning({}), 0);
});

test('dispatchPay is 80% with a £95 default base', () => {
  assert.equal(dispatchPay({}), 76);
  assert.equal(dispatchPay({ baseFare: 200 }), 160);
});

test('subscription-model commission is adjustable and clamped to 0–50', () => {
  assert.equal(driverEarning({ baseFare: 100 }, 10), 90);   // admin sets 10%
  assert.equal(driverEarning({ baseFare: 100 }, 0), 100);   // pure subscription, 0% cut
  assert.equal(driverEarning({ baseFare: 100 }, 99), 50);   // clamped at 50
  assert.equal(driverEarning({ baseFare: 100 }, -5), 100);  // clamped at 0
  assert.equal(driverEarning({ baseFare: 100 }, NaN), 80);  // junk → default 20%
  assert.equal(dispatchPay({ baseFare: 200 }, 10), 180);
  assert.equal(normalizeCommissionPct(undefined), 20);
});

test('bookingEvent: create / delete / status transitions', () => {
  assert.equal(bookingEvent(null, { status: 'pending' }), 'received');
  assert.equal(bookingEvent({ status: 'pending' }, null), null);
  assert.equal(bookingEvent({ status: 'pending' }, { status: 'confirmed' }), 'confirmed');
  // The driver app's real vocabulary: claim → 'accepted', at pickup → 'arrived'.
  assert.equal(bookingEvent({ status: 'confirmed' }, { status: 'accepted' }), 'driver_assigned');
  assert.equal(bookingEvent({ status: 'accepted' }, { status: 'arrived' }), 'en_route');
  assert.equal(bookingEvent({ status: 'confirmed' }, { status: 'en_route' }), 'en_route');
  assert.equal(bookingEvent({ status: 'confirmed' }, { status: 'arriving' }), 'en_route');
  assert.equal(bookingEvent({ status: 'en_route' }, { status: 'completed' }), 'completed');
  assert.equal(bookingEvent({ status: 'pending' }, { status: 'cancelled' }), 'cancelled');
  assert.equal(bookingEvent({ status: 'pending' }, { status: 'pending' }), null); // no change
});

test('bookingEvent: driver assigned by name appearing', () => {
  assert.equal(bookingEvent({ status: 'confirmed' }, { status: 'confirmed', driverName: 'Sam' }), 'driver_assigned');
});

test('bookingMessage builds subject + body, unknown → null', () => {
  const [subject, body] = bookingMessage('received', { ref: 'APX-1', pickup: 'Mayfair', airport: 'Heathrow T5', date: '2026-07-01', time: '9am' })!;
  assert.match(subject, /received your booking/i);
  assert.match(body, /APX-1/);
  assert.match(body, /Mayfair → Heathrow T5/);
  assert.equal(bookingMessage('nonsense', {}), null);
});

test('daysUntil from a fixed clock', () => {
  const now = new Date('2026-06-29T12:00:00Z');
  assert.equal(daysUntil('2026-06-30', now), 1);
  assert.equal(daysUntil('2026-06-29', now), 0);
  assert.equal(daysUntil('2026-06-22', now), -7);
  assert.equal(daysUntil('not-a-date', now), null);
  assert.equal(daysUntil(undefined, now), null);
});

test('shouldRemind: milestones and weekly-after-expiry', () => {
  for (const d of [30, 14, 7, 3, 1, 0]) assert.equal(shouldRemind(d), true);
  assert.equal(shouldRemind(29), false);
  assert.equal(shouldRemind(-7), true);  // a week overdue
  assert.equal(shouldRemind(-14), true);
  assert.equal(shouldRemind(-3), false); // not a weekly mark
  assert.equal(shouldRemind(null), false);
});

test('flightHHMM extracts HH:MM from an ISO datetime', () => {
  assert.equal(flightHHMM('2026-06-29T07:35:00+00:00'), '07:35');
  assert.equal(flightHHMM(''), '');
  assert.equal(flightHHMM(undefined), '');
});

test('bonus policy: month key, tier bonuses, rating gate, milestones', () => {
  assert.equal(bonusMonthKey(new Date('2026-07-04T12:00:00Z')), '2026-07');
  assert.equal(bonusMonthKey(new Date('2026-01-01T00:30:00Z')), '2026-01');
  assert.equal(monthlyBonusForBalance(1999), 0);
  assert.equal(monthlyBonusForBalance(2000), 200);
  assert.equal(monthlyBonusForBalance(5000), 500);
  assert.ok(qualifiesForRatingBonus({ rating: 4.9, ratingCount: 5 }));
  assert.ok(!qualifiesForRatingBonus({ rating: 4.8, ratingCount: 50 }));
  assert.ok(!qualifiesForRatingBonus({ rating: 5, ratingCount: 4 }));
  assert.ok(!qualifiesForRatingBonus(null));
  assert.equal(milestoneBonusAt(50), 25);
  assert.equal(milestoneBonusAt(100), 25);
  assert.equal(milestoneBonusAt(49), 0);
  assert.equal(milestoneBonusAt(0), 0);
});

test('Atlas Pro codes: mint, verify, reject tampering — and mirror the app engine', () => {
  // deterministic mint
  let n = 0;
  const seq = [0.1, 0.5, 0.9, 0.2, 0.7, 0.3, 0.8, 0.05];
  const rand = () => seq[n++ % seq.length];
  const code = makeProCode(rand);
  assert.match(code, /^ATLS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
  assert.equal(validProCode(code), true);
  assert.equal(validProCode(code.toLowerCase()), true); // case-insensitive
  assert.equal(validProCode(code.replace(/-/g, ' ')), true); // punctuation-insensitive
  // tampering: flip one body character → checksum fails
  const flipped = code[5] === 'A' ? code.slice(0, 5) + 'B' + code.slice(6)
                                  : code.slice(0, 5) + 'A' + code.slice(6);
  assert.equal(validProCode(flipped), false);
  assert.equal(validProCode('ATLS-AAAA-AAAA-AA'), false);
  assert.equal(validProCode(''), false);
  assert.equal(validProCode(null), false);

  // parity with the app: the engine must accept every server-minted code,
  // and the server must accept every engine-minted code
  type Engine = { makeProCode: (r: () => number) => string; validProCode: (c: unknown) => boolean };
  const sandbox = { module: { exports: {} as Engine } };
  vm.createContext(sandbox);
  const enginePath = existsSync('../atlas/engine.js') ? '../atlas/engine.js' : 'atlas/engine.js';
  vm.runInContext(readFileSync(enginePath, 'utf8'), sandbox);
  const engine = sandbox.module.exports;
  for (let i = 0; i < 50; i++) {
    assert.equal(engine.validProCode(makeProCode()), true, 'engine must accept server codes');
    assert.equal(validProCode(engine.makeProCode(Math.random)), true, 'server must accept engine codes');
  }
});

test('Atlas Pro fulfilment email carries the code and the activation path', () => {
  const msg = atlasProEmail('ATLS-R6RH-K72D-7M');
  assert.match(msg.subject, /Atlas Pro/);
  assert.ok(msg.text.includes('ATLS-R6RH-K72D-7M'));
  assert.match(msg.text, /Settings/);
  assert.match(msg.text, /apexvip\.uk\/atlas/);
});

test('community clips: submission caps and unlisted YouTube metadata', () => {
  assert.equal(validateClipSubmission({ size: 5e6, contentType: 'video/webm', durS: 90 }).ok, true);
  assert.equal(validateClipSubmission({ size: 5e6, contentType: 'video/mp4', durS: 90 }).ok, true);
  assert.equal(validateClipSubmission({ size: 0, contentType: 'video/webm' }).ok, false);
  assert.equal(validateClipSubmission({ size: 300 * 1024 * 1024, contentType: 'video/webm' }).ok, false);
  assert.equal(validateClipSubmission({ size: 5e6, contentType: 'image/png' }).ok, false);
  assert.equal(validateClipSubmission({ size: 5e6, contentType: 'video/webm', durS: 3600 }).ok, false);

  const meta = ytClipMeta({ t: Date.UTC(2026, 7, 9, 14, 30), durS: 125 });
  assert.match(meta.snippet.title, /^Atlas dashcam — 2026-08-09 14:30 UTC$/);
  assert.ok(meta.snippet.description.includes('2:05'));
  assert.equal(meta.status.privacyStatus, 'unlisted'); // never public unseen
  assert.equal(meta.snippet.categoryId, '2');
});

test('guardianEmail: plain, complete, junk-safe', () => {
  const m = guardianEmail({ name: 'Rafa', lat: 51.5, lon: -0.12,
    watch: 'https://apexvip.uk/atlas/#watch=AB23CD', t: Date.UTC(2026, 7, 16, 12, 0) });
  assert.match(m.subject, /Rafa may need help/);
  assert.ok(m.text.includes('did not respond'));
  assert.ok(m.text.includes('51.50000, -0.12000'));
  assert.ok(m.text.includes('openstreetmap.org/?mlat=51.50000'));
  assert.ok(m.text.includes('#watch=AB23CD'));
  assert.ok(m.text.includes('emergency services'));
  // no name, no position (0,0 sentinel), no link — still a sane email
  const bare = guardianEmail({});
  assert.match(bare.subject, /An Atlas driver/);
  assert.ok(!bare.text.includes('undefined'));
  assert.ok(!guardianEmail({ lat: 0, lon: 0 }).text.includes('0.00000'));
});
