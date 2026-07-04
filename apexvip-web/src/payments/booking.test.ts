import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBookingPayload, SERVICE_LABELS } from './booking.ts';

const BASE = {
  ref: 'APX-1234', clientId: 'uid1', clientName: 'Alex', clientEmail: 'a@b.c',
  booking: { serviceType: 'hourly', pickup: 'Mayfair' },
  fare: { total: 260, base: 236, discount: 0, vat: 43.33 },
};

test('maps service labels and embeds the fare figures', () => {
  const p = buildBookingPayload(BASE);
  assert.equal(p.serviceLabel, 'By the Hour');
  assert.equal(p.price, 260);
  assert.equal(p.baseFare, 236);
  assert.equal(p.vat, 43.33);
  assert.equal(p.status, 'confirmed');
  assert.equal(p.location, 'london');
});

test('unknown service falls back to Airport Transfer; labels cover all types', () => {
  const p = buildBookingPayload({ ...BASE, booking: { serviceType: 'mystery', pickup: 'X' } });
  assert.equal(p.serviceLabel, 'Airport Transfer');
  for (const k of ['airport', 'hourly', 'day', 'point']) assert.ok(SERVICE_LABELS[k]);
});

test('payment status derives from the Square payment id', () => {
  assert.equal(buildBookingPayload(BASE).paymentStatus, 'pending');
  assert.equal(buildBookingPayload({ ...BASE, squarePaymentId: 'sq_1' }).paymentStatus, 'paid');
});

test('PA passenger only rides along in PA mode', () => {
  const pa = { name: 'VIP' };
  assert.equal(buildBookingPayload({ ...BASE, paMode: true, paPassenger: pa }).paPassenger, pa);
  assert.equal(buildBookingPayload({ ...BASE, paMode: false, paPassenger: pa }).paPassenger, null);
});

test('guards: requires clientId and a pickup or airport', () => {
  assert.throws(() => buildBookingPayload({ ...BASE, clientId: '' }));
  assert.throws(() => buildBookingPayload({ ...BASE, booking: { serviceType: 'airport' } }));
  assert.ok(buildBookingPayload({ ...BASE, booking: { serviceType: 'airport', airport: 'Heathrow T5' } }));
});
