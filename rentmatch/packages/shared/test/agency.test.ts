import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rollupAgency, withinSeatAllowance, AGENT_INCLUDED_SEATS, type AgencyClientSnapshot,
} from '../src/agency.ts';

const clients: AgencyClientSnapshot[] = [
  { landlordId: 'a', landlordName: 'Alice', properties: 3, certsToAction: 1, arrearsPence: 0 },
  { landlordId: 'b', landlordName: 'Bob', properties: 5, certsToAction: 0, arrearsPence: 240_000 },
  { landlordId: 'c', landlordName: 'Cara', properties: 2, certsToAction: 2, arrearsPence: 0 },
];

test('rollup sums the book of business', () => {
  const r = rollupAgency(clients);
  assert.equal(r.clientCount, 3);
  assert.equal(r.totalProperties, 10);
  assert.equal(r.totalCertsToAction, 3);
  assert.equal(r.totalArrearsPence, 240_000);
});

test('clients are ordered worst-first: most arrears, then most certs to action', () => {
  const r = rollupAgency(clients);
  assert.equal(r.clients[0].landlordId, 'b'); // has the arrears
  assert.equal(r.clients[1].landlordId, 'c'); // no arrears but more certs than Alice
  assert.equal(r.clients[2].landlordId, 'a');
});

test('an empty agency rolls up to zeros', () => {
  const r = rollupAgency([]);
  assert.deepEqual(
    [r.clientCount, r.totalProperties, r.totalCertsToAction, r.totalArrearsPence],
    [0, 0, 0, 0],
  );
});

test('seat allowance gates the included team size', () => {
  assert.equal(withinSeatAllowance(AGENT_INCLUDED_SEATS), true);
  assert.equal(withinSeatAllowance(AGENT_INCLUDED_SEATS + 1), false);
});
