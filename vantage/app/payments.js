// Payments — processor-agnostic by design (your Stripe, no forced merchant).
// Real Stripe PaymentIntent when STRIPE_SECRET_KEY is set; a mock capture
// otherwise, so the full request lifecycle runs end-to-end without secrets.
//
// Phase 1.5: swap captureForRequest() to create a Stripe Connect transfer that
// settles the driver's cut — that take-rate is the actual business model.

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

// ~0.5% platform fee — the Vantage take-rate (see MODEL.md).
const PLATFORM_FEE_BPS = 50;

export async function captureForRequest(request) {
  const amount = request.quote_amount;
  if (!amount || amount <= 0) {
    return { provider: "mock", status: "skipped", platformFee: 0 };
  }
  const platformFee = Math.round((amount * PLATFORM_FEE_BPS) / 10000 * 100) / 100;

  const s = getStripe();
  if (s) {
    const intent = await s.paymentIntents.create({
      amount: amount * 100, // cents
      currency: "usd",
      capture_method: "automatic",
      metadata: { request_id: request.id, platform_fee: String(platformFee) },
      description: `Vantage ${request.type} — ${request.client_name}`,
    });
    return { provider: "stripe", provider_ref: intent.id, status: intent.status, platformFee };
  }

  return {
    provider: "mock",
    provider_ref: "mock_" + request.id,
    status: "succeeded",
    platformFee,
  };
}
