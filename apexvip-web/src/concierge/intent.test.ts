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
