import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newDealRecord, recomputeStage, deriveSnapshot, awaitingAgreement,
  bothSigned, awaitingFee, type DealRecord,
} from '../src/deal.ts';

function fullyAgreed(): DealRecord {
  return {
    ...newDealRecord(),
    viewing: { ts: 1, status: 'confirmed', proposedBy: 'renter' },
    agreed: { renter: true, landlord: true },
    contractDrafted: true,
    esignEnvelopeOpen: true,
  };
}

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

test('a contract sent for signing sits at the signing stage', () => {
  assert.equal(recomputeStage(fullyAgreed()), 'signing');
});

test('one signature is not full execution and stays at signing', () => {
  const d: DealRecord = { ...fullyAgreed(), signed: { renter: 111, landlord: null } };
  assert.equal(bothSigned(d), false);
  assert.equal(recomputeStage(d), 'signing');
});

test('both signed but unpaid is awaitingFee, still at signing (not completed)', () => {
  const d: DealRecord = { ...fullyAgreed(), signed: { renter: 111, landlord: 222 }, feePaid: false };
  assert.equal(bothSigned(d), true);
  assert.equal(awaitingFee(d), true);
  assert.equal(recomputeStage(d), 'signing');
});

test('both signed AND fee paid completes the deal', () => {
  const d: DealRecord = { ...fullyAgreed(), signed: { renter: 111, landlord: 222 }, feePaid: true };
  assert.equal(awaitingFee(d), false);
  assert.equal(recomputeStage(d), 'completed');
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
