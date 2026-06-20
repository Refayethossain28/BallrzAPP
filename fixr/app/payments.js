// Payments + driver settlement — processor-agnostic (your Stripe, no forced
// merchant). On trip completion we capture the fare AND settle the driver's
// cut via Stripe Connect; Fixr keeps a ~0.5% platform fee. That take-rate
// is the business model (see ../MODEL.md).
//
// Real Stripe when STRIPE_SECRET_KEY is set; a mock split otherwise, so the
// full split runs end-to-end without secrets. The driver's share only moves
// for real if the driver has a Connect account (resources.stripe_account_id).

import Stripe from "stripe";

let stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

export function paymentsMode() {
  return process.env.STRIPE_SECRET_KEY ? "stripe" : "mock";
}

const PLATFORM_FEE_BPS = 50;   // ~0.5% Fixr take-rate
const DRIVER_SHARE_PCT = 0.70; // of the fare, settled to the driver

// Compute the money split for a completed fare.
export function splitFor(amount) {
  const platformFee = Math.round((amount * PLATFORM_FEE_BPS) / 100) / 100; // 2 dp
  const driverShare = Math.round(amount * DRIVER_SHARE_PCT);
  const operatorNet = Math.round((amount - driverShare - platformFee) * 100) / 100;
  return { platformFee, driverShare, operatorNet };
}

/**
 * Capture the fare and settle the driver.
 * @param {object} request  the request row (needs quote_amount, type, client_name, id)
 * @param {object|null} driver  assigned resource (may carry stripe_account_id)
 */
export async function captureAndSettle(request, driver) {
  const amount = request.quote_amount;
  if (!amount || amount <= 0) {
    return { provider: "mock", status: "skipped", platformFee: 0, driverShare: 0, operatorNet: 0 };
  }
  const split = splitFor(amount);
  const s = getStripe();

  if (s) {
    // 1. Capture the fare on the platform account.
    const intent = await s.paymentIntents.create({
      amount: amount * 100,
      currency: "usd",
      capture_method: "automatic",
      metadata: { request_id: request.id, platform_fee: String(split.platformFee) },
      description: `Fixr ${request.type} — ${request.client_name}`,
    });

    // 2. Settle the driver's cut via Connect, if they're onboarded.
    let transfer_ref = null;
    if (driver?.stripe_account_id && split.driverShare > 0) {
      const transfer = await s.transfers.create({
        amount: split.driverShare * 100,
        currency: "usd",
        destination: driver.stripe_account_id,
        transfer_group: request.id,
        metadata: { request_id: request.id },
      });
      transfer_ref = transfer.id;
    }
    return {
      provider: "stripe", provider_ref: intent.id, transfer_ref,
      status: intent.status, settled: Boolean(transfer_ref), ...split,
    };
  }

  // Mock: compute the split so the lifecycle and audit trail are complete.
  return {
    provider: "mock",
    provider_ref: "pi_mock_" + request.id,
    transfer_ref: driver ? "tr_mock_" + request.id : null,
    status: "succeeded",
    settled: Boolean(driver),
    ...split,
  };
}
