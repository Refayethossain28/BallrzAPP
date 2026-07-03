/**
 * Shared Stripe plumbing — one secret, one lazy client, used by both the
 * driver-payout functions (index.ts) and the Velvet membership billing
 * (velvet.ts). Secrets are params and may only be defined once per name,
 * so they live here rather than in either consumer.
 *
 * Set with:
 *   firebase functions:secrets:set STRIPE_SECRET_KEY
 *   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET   (Velvet webhook only)
 *
 * With no STRIPE_SECRET_KEY set, stripeClient() returns null and every caller
 * falls back to a mock flow, so the whole backend stays testable without keys.
 */
import Stripe from 'stripe';
import { defineSecret } from 'firebase-functions/params';

export const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
export const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

let _stripe: Stripe | null = null;
let _stripeKey: string | null = null;
export function stripeClient(): Stripe | null {
  const k = STRIPE_SECRET_KEY.value();
  if (!k) return null;
  if (!_stripe || _stripeKey !== k) { _stripe = new Stripe(k); _stripeKey = k; }
  return _stripe;
}
