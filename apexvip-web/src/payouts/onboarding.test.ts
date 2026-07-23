import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPayoutOnboarding, type OnboardingDeps } from './onboarding.ts';

function deps(over: Partial<OnboardingDeps> = {}): OnboardingDeps {
  return {
    backend: {
      createDriverPayoutAccount: async () => ({ url: 'https://connect.stripe.com/setup/abc', accountId: 'acct_1' }),
      getDriverPayoutStatus: async () => ({ onboarded: true, payoutsEnabled: true }),
    },
    payoutsEnabled: false,
    openUrl: () => {},
    ...over,
  };
}

test('no backend → unavailable (demo mode)', async () => {
  const r = await startPayoutOnboarding(deps({ backend: null }));
  assert.deepEqual(r, { outcome: 'unavailable' });
});

test('already enabled → does not call the backend', async () => {
  let called = false;
  const r = await startPayoutOnboarding(deps({
    payoutsEnabled: true,
    backend: {
      createDriverPayoutAccount: async () => { called = true; return { url: 'x', accountId: 'a' }; },
      getDriverPayoutStatus: async () => ({ onboarded: false, payoutsEnabled: false }),
    },
  }));
  assert.equal(r.outcome, 'already_active');
  assert.equal(called, false);
});

test('happy path opens the link and schedules a status refresh', async () => {
  let opened: string | null = null;
  let refreshed = false;
  const r = await startPayoutOnboarding(deps({
    openUrl: (u) => { opened = u; },
    scheduleStatusRefresh: (fn) => { void fn(); }, // run immediately in the test
    backend: {
      createDriverPayoutAccount: async () => ({ url: 'https://connect.stripe.com/setup/abc', accountId: 'acct_1' }),
      getDriverPayoutStatus: async () => { refreshed = true; return { onboarded: true, payoutsEnabled: true }; },
    },
  }));
  assert.deepEqual(r, { outcome: 'opened', url: 'https://connect.stripe.com/setup/abc' });
  assert.equal(opened, 'https://connect.stripe.com/setup/abc');
  assert.equal(refreshed, true);
});

test('no url returned → no_url, link not opened', async () => {
  let opened = false;
  const r = await startPayoutOnboarding(deps({
    openUrl: () => { opened = true; },
    backend: {
      createDriverPayoutAccount: async () => ({ url: '', accountId: 'acct_1' }),
      getDriverPayoutStatus: async () => ({ onboarded: false, payoutsEnabled: false }),
    },
  }));
  assert.equal(r.outcome, 'no_url');
  assert.equal(opened, false);
});

test('a backend error propagates to the caller', async () => {
  await assert.rejects(
    startPayoutOnboarding(deps({
      backend: {
        createDriverPayoutAccount: async () => { throw new Error('stripe down'); },
        getDriverPayoutStatus: async () => ({ onboarded: false, payoutsEnabled: false }),
      },
    })),
    /stripe down/,
  );
});
