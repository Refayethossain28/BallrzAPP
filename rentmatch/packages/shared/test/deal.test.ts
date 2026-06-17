import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newDealRecord, recomputeStage, deriveSnapshot, awaitingAgreement, type DealRecord,
} from '../src/deal.ts';

test('a fresh deal is at enquiry', () => {
  const d = newDealRecord();
  assert.equal(d.stage, 'enquiry');
  assert.equal(recomputeStage(d), 'enquiry');
});

test('a merely proposed viewing does not advance the stage', () => {
  const d: DealRecord = { ...newDealRecord(), viewing: { ts: 1, status: 'proposed', proposedBy: 'renter' } };
  assert.equal(recomputeStage(d), 'enquiry');
});

test('a confirmed viewing advances to viewing', () => {
  const d: DealRecord = { ...newDealRecord(), viewing: { ts: 1, status: 'confirmed', proposedBy: 'landlord' } };
  assert.equal(recomputeStage(d), 'viewing');
});

test('both parties agreeing (after a confirmed viewing) reaches agreed', () => {
  const d: DealRecord = {
    ...newDealRecord(),
    viewing: { ts: 1, status: 'confirmed', proposedBy: 'renter' },
    agreed: { renter: true, landlord: true },
  };
  assert.equal(recomputeStage(d), 'agreed');
});

test('one-sided agreement does not reach agreed', () => {
  const d: DealRecord = {
    ...newDealRecord(),
    viewing: { ts: 1, status: 'confirmed', proposedBy: 'renter' },
    agreed: { renter: true, landlord: false },
  };
  assert.equal(recomputeStage(d), 'viewing');
  assert.equal(awaitingAgreement(d, 'landlord'), true);
  assert.equal(awaitingAgreement(d, 'renter'), false);
});

test('deriveSnapshot maps signatures/payment to booleans', () => {
  const d: DealRecord = {
    ...newDealRecord(),
    signed: { renter: 123, landlord: null },
    feePaid: false,
  };
  const s = deriveSnapshot(d);
  assert.equal(s.signedByRenter, true);
  assert.equal(s.signedByLandlord, false);
  assert.equal(s.landlordFeePaid, false);
});
