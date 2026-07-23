/**
 * Unit tests for the ApexAI local intent parser + orchestration.
 * Run: `npm test` (node --test with TypeScript type-stripping).
 *
 * A fixed `now` (2026-06-28, a Sunday) makes date resolution deterministic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntentLocal, type ConciergeContext, type Hotel } from './intent.ts';
import { resolveConcierge } from './concierge.ts';

const NOW = new Date('2026-06-28T12:00:00Z'); // Sunday
const ctx = (over: Partial<ConciergeContext> = {}): ConciergeContext => ({ now: NOW, ...over });

test('airport transfer with pickup: "to Heathrow from central London"', () => {
  // No trailing "?" — the address pattern stops at punctuation/end, so a trailing
  // "?" would be captured into the pickup (a known quirk of the source parser).
  const r = parseIntentLocal('A car to Heathrow from central London', ctx());
  assert.equal(r.serviceType, 'airport');
  assert.equal(r.airport, 'Heathrow T5');
  assert.equal(r.pickup, 'central London');
});

test('flight number + time + airport + relative date', () => {
  const r = parseIntentLocal('My flight is BA249 at 7am tomorrow from Heathrow', ctx());
  assert.equal(r.flight, 'BA249');
  assert.equal(r.serviceType, 'airport');
  assert.equal(r.airport, 'Heathrow T5');
  assert.equal(r.time, '7am');
  assert.equal(r.date, '2026-06-29'); // tomorrow
});

test('specific Heathrow terminal is preserved', () => {
  const r = parseIntentLocal('Collect me for Heathrow Terminal 3', ctx());
  assert.equal(r.airport, 'Heathrow T3');
});

test('4-digit military time "at 1700" → "17:00" and is NOT read as a flight', () => {
  const r = parseIntentLocal('Pick me up at 1700 to Gatwick', ctx());
  assert.equal(r.time, '17:00');
  assert.equal(r.flight, null); // "1700" must not match the flight pattern
  assert.equal(r.airport, 'Gatwick North');
});

test('hourly hire', () => {
  const r = parseIntentLocal('I need a car by the hour this afternoon', ctx());
  assert.equal(r.serviceType, 'hourly');
});

test('full-day chauffeur', () => {
  const r = parseIntentLocal('Book a full-day chauffeur', ctx());
  assert.equal(r.serviceType, 'day');
});

test('"from X to Y" point-to-point captures both ends', () => {
  const r = parseIntentLocal('Take me from The Savoy to Harrods', ctx());
  assert.equal(r.pickup, 'The Savoy');
  assert.equal(r.dropoff, 'Harrods');
});

test('context-aware follow-up: a bare postcode becomes the pickup', () => {
  const prev = { serviceType: 'airport', airport: 'Heathrow T5' };
  const r = parseIntentLocal('SW17 8SX', ctx({ prev }));
  assert.equal(r.pickup, 'SW17 8SX');
  assert.equal(r.airport, 'Heathrow T5'); // carried over from the prior turn
  assert.equal(r.serviceType, 'airport');
});

// ── Quotes — answered on-device from the rate card ──────────────────────────
const RATE_CARD = {
  airport_s: 185, airport_v: 225, heathrow_s: 185, heathrow_v: 225,
  gatwick_s: 195, gatwick_v: 235, city_s: 125, city_v: 155,
  hourly_s_rate: 65, hourly_v_rate: 75, day_s: 450, day_v: 550,
  min_fare_s: 38, per_km_s: 2.2, min_fare_v: 50, per_km_v: 2.75,
};
const qctx = (over: Partial<ConciergeContext> = {}): ConciergeContext => ({ now: NOW, rateCard: RATE_CARD, ...over });

test('quote: "how much for a V-Class to Heathrow tomorrow at 1700?" prices from the card', () => {
  const r = parseIntentLocal('How much for a v class to Heathrow tomorrow at 1700?', qctx());
  assert.equal(r.intent, 'quote');
  assert.equal(r.serviceType, 'airport');
  assert.equal(r.airport, 'Heathrow T5');
  assert.match(r.reply, /£225/);       // heathrow_v
  assert.match(r.reply, /V-Class/);
});

test('quote: S-Class is the default vehicle and uses the terminal-specific fare', () => {
  const r = parseIntentLocal('What does a car to Gatwick cost?', qctx());
  assert.equal(r.intent, 'quote');
  assert.match(r.reply, /£195/);       // gatwick_s
});

test('quote: hourly rate', () => {
  const r = parseIntentLocal('How much is hourly hire in a V-Class?', qctx());
  assert.equal(r.intent, 'quote');
  assert.match(r.reply, /£75/);        // hourly_v_rate
  assert.match(r.reply, /per hour/i);
});

test('quote: full day', () => {
  const r = parseIntentLocal('Price for a full-day chauffeur?', qctx());
  assert.equal(r.intent, 'quote');
  assert.match(r.reply, /£450/);       // day_s
});

test('quote: generic ask with no route lists headline rates', () => {
  const r = parseIntentLocal('How much are your rates?', qctx());
  assert.equal(r.intent, 'quote');
  assert.match(r.reply, /£185/);       // airport_s headline
});

test('quote falls back gracefully when no rate card is supplied', () => {
  const r = parseIntentLocal('How much to Heathrow?', ctx()); // no rateCard
  assert.equal(r.intent, 'quote');
  assert.match(r.reply, /confirm the exact fare/i);
});

test('a normal booking (no price words) is NOT treated as a quote', () => {
  const r = parseIntentLocal('Car to Heathrow from Mayfair', qctx());
  assert.notEqual(r.intent, 'quote');
  assert.equal(r.pickup, 'Mayfair');
});

test('hotel discovery runs only with a hotel context', () => {
  const hotels: Hotel[] = [
    { area: 'Mayfair', rating: 5 },
    { area: 'Mayfair', rating: 4 },
    { area: 'Soho', rating: 5 },
  ];
  const hotel = { hotels, estimateRate: () => ({ nightly: 600 }) };
  const r = parseIntentLocal('Find me a hotel in Mayfair', ctx({ hotel }));
  assert.equal(r.intent, 'hotel');
  assert.ok(r.hotels && r.hotels.length > 0);
  assert.ok(r.hotels!.every((h) => h.area === 'Mayfair'));
});

test('a ride TO a hotel is NOT hotel discovery', () => {
  const hotel = { hotels: [{ area: 'Mayfair', rating: 5 }], estimateRate: () => ({ nightly: 600 }) };
  const r = parseIntentLocal('Drive me to my hotel in Mayfair', ctx({ hotel }));
  assert.notEqual(r.intent, 'hotel'); // "drive me" is a ride signal
});

test('empty-ish request asks for details', () => {
  const r = parseIntentLocal('Hello', ctx());
  assert.equal(r.serviceType, null);
  assert.match(r.reply, /pickup address/i);
});

// ── Orchestration ───────────────────────────────────────────────────────────

test('resolveConcierge falls back to local parser when no backend', async () => {
  const r = await resolveConcierge(
    { message: 'Car to Heathrow from Mayfair' },
    { backend: null, context: ctx() },
  );
  assert.equal((r as { airport?: string }).airport, 'Heathrow T5');
});

test('resolveConcierge prefers the backend when available', async () => {
  let called = false;
  const backend = {
    parseBookingIntent: async () => { called = true; return { reply: 'From the cloud', intent: 'book' }; },
  };
  const r = await resolveConcierge(
    { message: 'Car to Heathrow', now: NOW.toISOString() },
    { backend, context: ctx() },
  );
  assert.equal(called, true);
  assert.equal(r.reply, 'From the cloud');
});

test('resolveConcierge falls back to local when the backend throws', async () => {
  const backend = {
    parseBookingIntent: async () => { throw new Error('functions unavailable'); },
  };
  const r = await resolveConcierge(
    { message: 'Car to Gatwick' },
    { backend, context: ctx() },
  );
  assert.equal((r as { airport?: string }).airport, 'Gatwick North');
});

test('resolveConcierge keeps hotel discovery local even with a backend', async () => {
  let called = false;
  const backend = { parseBookingIntent: async () => { called = true; return { reply: 'cloud' }; } };
  const hotel = { hotels: [{ area: 'Mayfair', rating: 5 }], estimateRate: () => ({ nightly: 600 }) };
  const r = await resolveConcierge(
    { message: 'Find me a hotel in Mayfair' },
    { backend, context: ctx({ hotel }) },
  );
  assert.equal(called, false); // never hit the backend for a stay
  assert.equal((r as { intent?: string }).intent, 'hotel');
});
