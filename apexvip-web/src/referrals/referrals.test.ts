import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReferralCode, demoReferralCode, referralErrorMessage, loadReferralCode, applyReferral,
  type ReferralBackend,
} from './referrals.ts';

test('normalizeReferralCode trims and uppercases', () => {
  assert.equal(normalizeReferralCode('  apx-abc '), 'APX-ABC');
});

test('demoReferralCode uses the uid prefix, or DEMO', () => {
  assert.equal(demoReferralCode('abcd1234'), 'APEXABCD247');
  assert.equal(demoReferralCode(undefined), 'APEXDEMO247');
});

test('referralErrorMessage maps known errors', () => {
  assert.match(referralErrorMessage(new Error('A referral code has already been applied.')), /already used/i);
  assert.match(referralErrorMessage(new Error('code not-found here')), /invalid code/i);
  assert.match(referralErrorMessage(new Error('boom')), /could not apply/i);
});

test('loadReferralCode returns the demo code when offline', async () => {
  assert.equal(await loadReferralCode(null, 'abcd99'), 'APEXABCD247');
});

test('loadReferralCode returns the live code from the backend', async () => {
  const backend: ReferralBackend = {
    generateReferralCode: async () => ({ code: 'APX-XYZ123' }),
    applyReferralCode: async () => ({ message: '', creditsAwarded: 0 }),
  };
  assert.equal(await loadReferralCode(backend), 'APX-XYZ123');
});

test('applyReferral: empty code is rejected without a backend call', async () => {
  let called = false;
  const backend: ReferralBackend = {
    generateReferralCode: async () => ({ code: '' }),
    applyReferralCode: async () => { called = true; return { message: 'x', creditsAwarded: 50 }; },
  };
  const r = await applyReferral(backend, '   ');
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('applyReferral: success returns the prefixed message + credits', async () => {
  const backend: ReferralBackend = {
    generateReferralCode: async () => ({ code: '' }),
    applyReferralCode: async ({ code }) => {
      assert.equal(code, 'FRIEND50'); // normalized
      return { message: 'Referral applied — you both earned 50 APEX.', creditsAwarded: 50 };
    },
  };
  const r = await applyReferral(backend, ' friend50 ');
  assert.equal(r.ok, true);
  assert.match(r.message, /^✓ Referral applied/);
  assert.equal(r.creditsAwarded, 50);
});

test('applyReferral: a backend error becomes a friendly message', async () => {
  const backend: ReferralBackend = {
    generateReferralCode: async () => ({ code: '' }),
    applyReferralCode: async () => { throw new Error('A referral code has already been applied.'); },
  };
  const r = await applyReferral(backend, 'USED1');
  assert.equal(r.ok, false);
  assert.match(r.message, /already used/i);
  assert.equal(r.creditsAwarded, 0);
});
