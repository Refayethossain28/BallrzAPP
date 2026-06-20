// Stripe Connect onboarding for drivers. Creates an Express connected account
// and a hosted onboarding link the driver completes to receive payouts.
// Mock fallback (no STRIPE_SECRET_KEY) sets a fake account id and returns a
// local stub URL, so the self-onboarding flow runs end-to-end without secrets.

import Stripe from "stripe";

let stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

// Returns { accountId, url } — `url` is where the driver finishes onboarding.
export async function createOnboardingLink(driver, baseUrl) {
  const s = getStripe();
  if (s) {
    let accountId = driver.stripe_account_id;
    if (!accountId) {
      const account = await s.accounts.create({
        type: "express",
        business_type: "individual",
        capabilities: { transfers: { requested: true } },
        metadata: { driver_id: driver.id, driver_name: driver.name },
      });
      accountId = account.id;
    }
    const link = await s.accountLinks.create({
      account: accountId,
      refresh_url: `${baseUrl}/driver/?d=${driver.id}`,
      return_url: `${baseUrl}/driver/?d=${driver.id}&onboarded=1`,
      type: "account_onboarding",
    });
    return { accountId, url: link.url, provider: "stripe" };
  }

  // Mock: pretend the driver onboarded successfully.
  const accountId = "acct_mock_" + driver.id;
  return { accountId, url: `${baseUrl}/driver/?d=${driver.id}&onboarded=1`, provider: "mock" };
}

export async function accountStatus(driver) {
  if (!driver.stripe_account_id) return { connected: false };
  const s = getStripe();
  if (s && !driver.stripe_account_id.startsWith("acct_mock_")) {
    const acct = await s.accounts.retrieve(driver.stripe_account_id);
    return {
      connected: true,
      account_id: acct.id,
      payouts_enabled: acct.payouts_enabled,
      details_submitted: acct.details_submitted,
    };
  }
  return { connected: true, account_id: driver.stripe_account_id, payouts_enabled: true, mock: true };
}
