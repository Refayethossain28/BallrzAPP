/**
 * fare/stripe.mjs — subscriptions via Stripe's HTTPS API. Zero dependencies:
 * form-encoded fetch()es and a hand-rolled webhook signature check
 * (HMAC-SHA256 over `${t}.${payload}`, per Stripe's spec).
 *
 * Env:
 *   STRIPE_SECRET_KEY      enables billing (sk_live_… / sk_test_…)
 *   STRIPE_PRICE_ID        the £9.99/mo recurring price (price_…). If unset,
 *                          a "Fare" product + £9.99 GBP monthly price is
 *                          created once on first checkout and reused.
 *   STRIPE_WEBHOOK_SECRET  from the webhook endpoint config (whsec_…)
 *
 * Without STRIPE_SECRET_KEY billing is off and every account has full access
 * — the pre-launch mode.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.stripe.com/v1';

export function billingEnabled() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function form(params, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') parts.push(form(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

async function stripe(path, params, method = 'POST') {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'POST' ? form(params || {}) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`stripe ${path} failed (${res.status}): ${data?.error?.message || 'unknown'}`);
  return data;
}

/* ── price: use the configured one, or create £9.99/mo once and reuse ── */

let cachedPriceId = '';
export async function priceId() {
  if (process.env.STRIPE_PRICE_ID) return process.env.STRIPE_PRICE_ID;
  if (cachedPriceId) return cachedPriceId;
  const existing = await stripe('/prices/search?' + form({
    query: `lookup_key:"fare-monthly" AND active:"true"`,
  }), null, 'GET');
  if (existing.data?.length) return (cachedPriceId = existing.data[0].id);
  const price = await stripe('/prices', {
    currency: 'gbp',
    unit_amount: 999,
    lookup_key: 'fare-monthly',
    recurring: { interval: 'month' },
    product_data: { name: 'Fare — chauffeur invoicing' },
  });
  return (cachedPriceId = price.id);
}

/* ── checkout + portal ── */

export async function createCheckout({ account, appUrl }) {
  const params = {
    mode: 'subscription',
    'line_items[0][price]': await priceId(),
    'line_items[0][quantity]': 1,
    success_url: `${appUrl}/?billing=success`,
    cancel_url: `${appUrl}/?billing=cancelled`,
    client_reference_id: String(account.id),
    'metadata[account_id]': String(account.id),
  };
  if (account.stripeCustomerId) params.customer = account.stripeCustomerId;
  else if (account.email) params.customer_email = account.email;
  const session = await stripe('/checkout/sessions', params);
  return session.url;
}

export async function createPortal({ account, appUrl }) {
  if (!account.stripeCustomerId) throw new Error('no billing on file yet — subscribe first');
  const session = await stripe('/billing_portal/sessions', {
    customer: account.stripeCustomerId,
    return_url: `${appUrl}/`,
  });
  return session.url;
}

/* ── webhook ── */

// Verify Stripe-Signature ("t=…,v1=…") against the raw payload. Pure —
// injectable clock for tests. → parsed event object, or null if invalid.
export function verifyWebhook(payload, sigHeader, secret, nowMs = Date.now(), toleranceSec = 300) {
  const parts = Object.fromEntries(
    String(sigHeader || '').split(',').map((p) => p.split('=').map((s) => s.trim())).filter((p) => p.length === 2)
  );
  const t = Number(parts.t);
  if (!t || !parts.v1) return null;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return null;
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(payload); } catch { return null; }
}

// Map a Stripe event to the account-status change it implies. Pure.
// → {customerId?, accountId?, status, subscriptionId?} | null (not relevant)
export function billingUpdateForEvent(event) {
  const obj = event?.data?.object || {};
  switch (event?.type) {
    case 'checkout.session.completed':
      return {
        accountId: Number(obj.client_reference_id || obj.metadata?.account_id) || null,
        customerId: obj.customer || null,
        subscriptionId: obj.subscription || null,
        status: 'active',
      };
    case 'customer.subscription.updated': {
      const map = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled' };
      return { customerId: obj.customer || null, subscriptionId: obj.id || null, status: map[obj.status] || 'past_due' };
    }
    case 'customer.subscription.deleted':
      return { customerId: obj.customer || null, subscriptionId: obj.id || null, status: 'canceled' };
    default:
      return null;
  }
}
