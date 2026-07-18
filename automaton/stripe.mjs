/**
 * automaton/stripe.mjs — the automaton's real-money rail.
 *
 * Zero-dependency Stripe REST client (Node 18+ fetch), matching the repo's
 * key-stays-server-side ethos. With STRIPE_SECRET_KEY set, every inbox task
 * can be billed as a shareable Stripe Payment Link; when someone actually
 * pays, `collect` credits the wallet with the real amount.
 *
 * Deliberately receive-only: this module can create payment links and READ
 * completed checkout sessions. It contains no refund, transfer, or payout
 * calls — money can only flow toward the automaton, never out of it. The
 * human runs `bill` and `collect`; the agent never touches the rail alone.
 */

const API = 'https://api.stripe.com';

export function stripeEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function stripeMode() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) return 'off';
  return key.startsWith('sk_live_') ? 'LIVE' : 'test';
}

/**
 * Flatten a nested object into Stripe's form encoding:
 * { line_items: [{ price: 'p', quantity: 1 }] }
 *   -> line_items[0][price]=p&line_items[0][quantity]=1
 * Exported for unit tests.
 */
export function form(data, prefix = '', out = []) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) =>
        typeof v === 'object' ? form(v, `${name}[${i}]`, out)
          : out.push(`${name}[${i}]=${encodeURIComponent(v)}`));
    } else if (typeof value === 'object') {
      form(value, name, out);
    } else {
      out.push(`${name}=${encodeURIComponent(value)}`);
    }
  }
  return out.join('&');
}

async function stripeCall(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? form(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Stripe ${method} ${path}: HTTP ${res.status} — ${text.slice(0, 120).trim()}`);
  }
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path}: ${json.error?.message || res.status}`);
  }
  return json;
}

/** Create a shareable Payment Link for one bounty task. */
export async function createBountyLink({ automatonId, taskFile, title, bountyUsd }) {
  const price = await stripeCall('POST', '/v1/prices', {
    currency: 'usd',
    unit_amount: Math.round(bountyUsd * 100),
    product_data: { name: `Automaton bounty: ${title}` },
  });
  const link = await stripeCall('POST', '/v1/payment_links', {
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { automaton_id: automatonId, automaton_task: taskFile },
  });
  return { id: link.id, url: link.url };
}

/** All PAID checkout sessions created from one payment link. */
export async function paidSessionsFor(paymentLinkId) {
  const res = await stripeCall(
    'GET',
    `/v1/checkout/sessions?payment_link=${encodeURIComponent(paymentLinkId)}&limit=100`,
  );
  return (res.data || [])
    .filter((s) => s.payment_status === 'paid')
    .map((s) => ({ sessionId: s.id, amountCents: s.amount_total, currency: s.currency }));
}
