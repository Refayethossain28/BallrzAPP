import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFlightNumber, isValidFlightNumber, demoFlightStatus, checkFlight,
  type FlightBackend,
} from './flight.ts';

test('normalizeFlightNumber uppercases and strips whitespace', () => {
  assert.equal(normalizeFlightNumber(' ba 249 '), 'BA249');
});

test('isValidFlightNumber matches 3–8 alphanumerics', () => {
  assert.equal(isValidFlightNumber('BA249'), true);
  assert.equal(isValidFlightNumber('EK1'), true); // 3 chars — the minimum
  assert.equal(isValidFlightNumber('EK'), false); // too short (2 chars)
  assert.equal(isValidFlightNumber('BA-249'), false); // hyphen
  assert.equal(isValidFlightNumber('BA2490000'), false); // 9 chars — too long
});

test('demoFlightStatus: odd last digit → delayed ~45 min', () => {
  assert.deepEqual(demoFlightStatus('BA249'), { flight: 'BA249', delayed: true, delayMins: 45, status: 'delayed', available: false });
  assert.deepEqual(demoFlightStatus('BA248'), { flight: 'BA248', delayed: false, delayMins: 0, status: 'on-time', available: false });
});

test('checkFlight: invalid input returns a neutral on-time result', async () => {
  const r = await checkFlight(null, 'x');
  assert.equal(r.status, 'on-time');
  assert.equal(r.available, false);
});

test('checkFlight: uses the live backend when it reports availability', async () => {
  const backend: FlightBackend = {
    checkFlightStatus: async ({ flight }) => ({ flight, available: true, delayed: true, delayMins: 20 }),
  };
  const r = await checkFlight(backend, 'ba249');
  assert.deepEqual(r, { flight: 'BA249', delayed: true, delayMins: 20, status: 'delayed', available: true });
});

test('checkFlight: backend "unavailable" falls back to the demo rule', async () => {
  const backend: FlightBackend = {
    checkFlightStatus: async ({ flight }) => ({ flight, available: false, delayed: false, delayMins: 0 }),
  };
  const r = await checkFlight(backend, 'BA249'); // odd → demo says delayed
  assert.equal(r.available, false);
  assert.equal(r.delayed, true);
  assert.equal(r.delayMins, 45);
});

test('checkFlight: a backend error falls back to the demo rule', async () => {
  const backend: FlightBackend = { checkFlightStatus: async () => { throw new Error('provider down'); } };
  const r = await checkFlight(backend, 'BA248'); // even → on-time
  assert.equal(r.status, 'on-time');
  assert.equal(r.available, false);
});

test('checkFlight offline uses the demo rule', async () => {
  const r = await checkFlight(null, 'BA249');
  assert.equal(r.delayed, true);
});
