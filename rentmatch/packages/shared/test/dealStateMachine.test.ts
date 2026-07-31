import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  highestReachableStage,
  type DealSnapshot,
} from '../src/dealStateMachine.ts';

const base: DealSnapshot = {
  stage: 'enquiry',
  hasConfirmedViewing: false,
  agreedByRenter: false,
  agreedByLandlord: false,
  contractDrafted: false,
  esignEnvelopeOpen: false,
  signedByRenter: false,
  signedByLandlord: false,
  landlordFeePaid: false,
};

test('illegal jumps are rejected', () => {
  assert.equal(canTransition(base, 'completed').ok, false);
  assert.equal(canTransition({ ...base, stage: 'enquiry' }, 'contract').ok, false);
});

test('enquiry → viewing needs a confirmed viewing', () => {
  assert.equal(canTransition(base, 'viewing').ok, false);
  assert.equal(canTransition({ ...base, hasConfirmedViewing: true }, 'viewing').ok, true);
});

test('viewing → agreed needs both parties', () => {
  const v: DealSnapshot = { ...base, stage: 'viewing', hasConfirmedViewing: true };
  assert.equal(canTransition({ ...v, agreedByRenter: true }, 'agreed').ok, false);
  assert.equal(
    canTransition({ ...v, agreedByRenter: true, agreedByLandlord: true }, 'agreed').ok,
    true,
  );
});

test('completion requires BOTH signatures AND the £100 fee', () => {
  const s: DealSnapshot = { ...base, stage: 'signing', esignEnvelopeOpen: true };
  assert.equal(canTransition({ ...s, signedByRenter: true, signedByLandlord: true }, 'completed').ok, false, 'no fee → blocked');
  assert.equal(canTransition({ ...s, signedByLandlord: true, landlordFeePaid: true }, 'completed').ok, false, 'one signature → blocked');
  assert.equal(
    canTransition(
      { ...s, signedByRenter: true, signedByLandlord: true, landlordFeePaid: true },
      'completed',
    ).ok,
    true,
  );
});

test('cancellation allowed until completed, not after', () => {
  assert.equal(canTransition({ ...base, stage: 'agreed' }, 'cancelled').ok, true);
  assert.equal(canTransition({ ...base, stage: 'completed' }, 'cancelled').ok, false);
});

test('highestReachableStage walks the funnel', () => {
  assert.equal(highestReachableStage(base), 'enquiry');
  assert.equal(highestReachableStage({ ...base, hasConfirmedViewing: true }), 'viewing');
  const fully: DealSnapshot = {
    ...base,
    hasConfirmedViewing: true,
    agreedByRenter: true,
    agreedByLandlord: true,
    contractDrafted: true,
    esignEnvelopeOpen: true,
    signedByRenter: true,
    signedByLandlord: true,
    landlordFeePaid: true,
  };
  assert.equal(highestReachableStage(fully), 'completed');
});
