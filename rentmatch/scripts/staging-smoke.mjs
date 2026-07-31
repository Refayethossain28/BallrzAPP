#!/usr/bin/env node
/**
 * Real-credential staging smoke — exercises the live payment rails in TEST mode
 * to prove the integrations work end-to-end (the emulator e2e uses a Stripe
 * stub; this uses the real API with test keys). Each rail is gated on its
 * credential, so the script skips cleanly (exit 0) when a key is absent.
 *
 *   STRIPE_TEST_SECRET_KEY=sk_test_… \
 *   GOCARDLESS_ACCESS_TOKEN=sandbox_… GOCARDLESS_ENV=sandbox \
 *   node scripts/staging-smoke.mjs
 *
 * No SDKs — plain fetch — so it has no install step and matches the functions.
 */

let failures = 0;
const log = (m) => console.log(m);
const fail = (m) => { console.error(`✗ ${m}`); failures++; };

/** Stripe: create + confirm a £100 PaymentIntent with a test card → succeeded. */
async function stripeSmoke() {
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  if (!key) { log('· Stripe: skipped (set STRIPE_TEST_SECRET_KEY)'); return; }
  if (!key.startsWith('sk_test_')) { fail('Stripe: refusing to run against a non-test key'); return; }

  const body = new URLSearchParams({
    amount: '10000',
    currency: 'gbp',
    payment_method: 'pm_card_visa',
    confirm: 'true',
    'automatic_payment_methods[enabled]': 'true',
    'automatic_payment_methods[allow_redirects]': 'never',
    description: 'Apex staging smoke — £100 platform fee',
  });
  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (res.ok && data.status === 'succeeded') log(`✓ Stripe: £100 test PaymentIntent succeeded (${data.id})`);
  else fail(`Stripe: ${res.status} ${data.error?.message ?? data.status}`);
}

/** GoCardless: a sandbox auth/connectivity check (list creditors). */
async function gocardlessSmoke() {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) { log('· GoCardless: skipped (set GOCARDLESS_ACCESS_TOKEN)'); return; }
  const base = process.env.GOCARDLESS_ENV === 'live'
    ? 'https://api.gocardless.com'
    : 'https://api-sandbox.gocardless.com';
  const res = await fetch(`${base}/creditors`, {
    headers: { Authorization: `Bearer ${token}`, 'GoCardless-Version': '2015-07-06' },
  });
  if (res.ok) log('✓ GoCardless: sandbox credentials valid (listed creditors)');
  else fail(`GoCardless: ${res.status} ${await res.text()}`);
}

await stripeSmoke();
await gocardlessSmoke();

if (failures > 0) { console.error(`\n${failures} staging smoke check(s) failed.`); process.exit(1); }
log('\nStaging smoke OK.');
