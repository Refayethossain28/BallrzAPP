/**
 * Velvet — the subscription VIP concierge (concierge/) backend.
 *
 * Real billing for the membership: Stripe Billing (Checkout for sign-up, the
 * Billing Portal for self-serve management, a webhook to mirror truth). The
 * client never talks to Stripe directly and never decides its own entitlement
 * when real billing is on — the webhook writes the subscription state into
 * `velvet_members/{uid}` and the app renders whatever Firestore says.
 *
 * Money-path invariants:
 *   - Prices are defined HERE (and created in Stripe by lookup_key), never
 *     taken from the client. They must match concierge/engine.js TIERS.
 *   - Invoices are recorded idempotently by Stripe invoice id, and points are
 *     awarded in the same transaction, so a webhook retry can't double-award.
 *   - With no STRIPE_SECRET_KEY set, createVelvetCheckout falls back to a mock
 *     flow (server-written trial) so the whole loop is testable without keys —
 *     same convention as the driver-payout functions.
 *
 * Client fallback contract: if these functions are absent or error, the app
 * keeps its fully-local simulated billing — a partial deploy never breaks it.
 */
import { onCall, onRequest, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import * as admin from 'firebase-admin';
import type Stripe from 'stripe';
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, stripeClient } from './stripe.js';

const REGION = 'us-central1';
const DAY_MS = 86400000;
const TRIAL_DAYS = 7;
const DEFAULT_RETURN = 'https://refayethossain28.github.io/BallrzAPP/concierge/';

// Server-side source of truth for tier pricing — must match concierge/engine.js TIERS.
const VELVET_TIERS: Record<string, { name: string; pricePence: number; pointsMultiplier: number }> = {
  silver: { name: 'Silver', pricePence: 4900, pointsMultiplier: 1 },
  gold: { name: 'Gold', pricePence: 19900, pointsMultiplier: 1.5 },
  black: { name: 'Black', pricePence: 49900, pointsMultiplier: 2 },
};

function db() { return admin.firestore(); }
function memberRef(uid: string) { return db().doc(`velvet_members/${uid}`); }

/** Only send members to https (or localhost dev) URLs the client asked for. */
function safeReturnUrl(u: unknown): string {
  const s = typeof u === 'string' ? u : '';
  return /^https:\/\/[^\s]+$/.test(s) || /^http:\/\/localhost(:\d+)?\//.test(s) ? s : DEFAULT_RETURN;
}

function customerIdOf(c: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!c) return null;
  return typeof c === 'string' ? c : c.id;
}

async function uidForCustomer(customerId: string): Promise<string | null> {
  const q = await db().collection('velvet_members')
    .where('stripeCustomerId', '==', customerId).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}

/** Find the recurring Price for a tier by lookup_key, creating product+price on first use. */
async function findOrCreatePrice(stripe: Stripe, tierId: string): Promise<string> {
  const key = `velvet_${tierId}_monthly`;
  const existing = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  if (existing.data.length) return existing.data[0].id;
  const t = VELVET_TIERS[tierId];
  const product = await stripe.products.create({
    name: `Velvet ${t.name} membership`,
    metadata: { app: 'velvet', tier: tierId },
  });
  const price = await stripe.prices.create({
    product: product.id,
    currency: 'gbp',
    unit_amount: t.pricePence,
    recurring: { interval: 'month' },
    lookup_key: key,
    metadata: { app: 'velvet', tier: tierId },
  });
  return price.id;
}

/** Start (or restart) a Velvet membership — returns a Stripe Checkout URL. */
export const createVelvetCheckout = onCall(
  { secrets: [STRIPE_SECRET_KEY], region: REGION },
  async (request: CallableRequest<{ tier?: string; successUrl?: string; cancelUrl?: string }>) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to subscribe');
    const uid = request.auth.uid;
    const tierId = String((request.data && request.data.tier) || '');
    if (!VELVET_TIERS[tierId]) throw new HttpsError('invalid-argument', 'Unknown tier');

    const stripe = stripeClient();
    if (!stripe) {
      // Mock mode: no key configured — the server itself grants the trial, so
      // the end-to-end loop (checkout → webhook → Firestore → client) is
      // exercisable before Stripe is connected.
      const now = Date.now();
      await memberRef(uid).set({
        billing: 'stripe-mock',
        sub: {
          tierId, status: 'trialing', startedAt: now,
          periodStart: now, periodEnd: now + TRIAL_DAYS * DAY_MS,
          cancelAtPeriodEnd: false, pendingTierId: null, endedAt: null,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      logger.info('createVelvetCheckout mock trial', { uid, tierId });
      return { mock: true };
    }

    const price = await findOrCreatePrice(stripe, tierId);
    const snap = await memberRef(uid).get();
    let customerId = (snap.data() || {}).stripeCustomerId as string | undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: (request.auth.token.email as string | undefined) || undefined,
        metadata: { app: 'velvet', uid },
      });
      customerId = customer.id;
      await memberRef(uid).set({ stripeCustomerId: customerId }, { merge: true });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price, quantity: 1 }],
      subscription_data: { trial_period_days: TRIAL_DAYS, metadata: { app: 'velvet', uid, tier: tierId } },
      metadata: { app: 'velvet', uid, tier: tierId },
      success_url: safeReturnUrl(request.data && request.data.successUrl),
      cancel_url: safeReturnUrl(request.data && request.data.cancelUrl),
      allow_promotion_codes: true,
    });
    return { url: session.url };
  }
);

/** Self-serve billing management (upgrade/downgrade/cancel/cards) — Billing Portal URL. */
export const createVelvetPortal = onCall(
  { secrets: [STRIPE_SECRET_KEY], region: REGION },
  async (request: CallableRequest<{ returnUrl?: string }>) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first');
    const stripe = stripeClient();
    if (!stripe) return { mock: true };
    const snap = await memberRef(request.auth.uid).get();
    const customerId = (snap.data() || {}).stripeCustomerId as string | undefined;
    if (!customerId) throw new HttpsError('failed-precondition', 'No billing account yet — subscribe first');
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: safeReturnUrl(request.data && request.data.returnUrl),
    });
    return { url: session.url };
  }
);

/* ------------------------------------------------------------------ *
 *  Webhook — Stripe is the source of truth; mirror it into Firestore  *
 * ------------------------------------------------------------------ */

function tierFromSubscription(sub: Stripe.Subscription): string {
  const metaTier = sub.metadata && sub.metadata.tier;
  if (metaTier && VELVET_TIERS[metaTier]) return metaTier;
  const key = sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.lookup_key;
  const m = /^velvet_(\w+)_monthly$/.exec(key || '');
  return m && VELVET_TIERS[m[1]] ? m[1] : 'silver';
}

function mapStatus(s: Stripe.Subscription.Status): 'trialing' | 'active' | 'canceled' {
  if (s === 'trialing') return 'trialing';
  if (s === 'active' || s === 'past_due') return 'active';
  return 'canceled'; // canceled | unpaid | incomplete | incomplete_expired | paused
}

async function mirrorSubscription(sub: Stripe.Subscription): Promise<void> {
  let uid = (sub.metadata && sub.metadata.uid) || null;
  const customerId = customerIdOf(sub.customer);
  if (!uid && customerId) uid = await uidForCustomer(customerId);
  if (!uid) { logger.warn('velvet webhook: subscription with no resolvable uid', { sub: sub.id }); return; }
  const status = mapStatus(sub.status);
  await memberRef(uid).set({
    billing: 'stripe',
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    sub: {
      tierId: tierFromSubscription(sub),
      status,
      startedAt: (sub.start_date || sub.created) * 1000,
      periodStart: sub.current_period_start * 1000,
      periodEnd: sub.current_period_end * 1000,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      pendingTierId: null,
      endedAt: status === 'canceled' ? (sub.ended_at ? sub.ended_at * 1000 : sub.current_period_end * 1000) : null,
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/** Record a paid invoice once (by Stripe invoice id) and award points atomically. */
async function recordInvoice(inv: Stripe.Invoice): Promise<void> {
  if (!inv.id || !inv.amount_paid || inv.amount_paid <= 0) return;
  const customerId = customerIdOf(inv.customer);
  const uid = customerId ? await uidForCustomer(customerId) : null;
  if (!uid) { logger.warn('velvet webhook: invoice with no resolvable uid', { invoice: inv.id }); return; }

  const line = inv.lines && inv.lines.data[0];
  const key = (line && line.price && line.price.lookup_key) || '';
  const m = /^velvet_(\w+)_monthly$/.exec(key);
  const tierId = m && VELVET_TIERS[m[1]] ? m[1] : 'silver';
  const points = Math.floor((inv.amount_paid / 100) * VELVET_TIERS[tierId].pointsMultiplier);

  const invRef = memberRef(uid).collection('invoices').doc(inv.id);
  await db().runTransaction(async (tx) => {
    const existing = await tx.get(invRef);
    if (existing.exists) return; // webhook retry — already recorded
    tx.set(invRef, {
      tierId,
      amountPence: inv.amount_paid,
      at: (inv.status_transitions && inv.status_transitions.paid_at ? inv.status_transitions.paid_at : inv.created) * 1000,
      periodStart: line && line.period ? line.period.start * 1000 : null,
      periodEnd: line && line.period ? line.period.end * 1000 : null,
      description: `Velvet ${VELVET_TIERS[tierId].name} membership`,
      stripeInvoiceId: inv.id,
      hostedInvoiceUrl: inv.hosted_invoice_url || null,
    });
    tx.set(memberRef(uid), {
      points: admin.firestore.FieldValue.increment(points),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

export const velvetStripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET], region: REGION },
  async (req, res) => {
    const stripe = stripeClient();
    const whsec = STRIPE_WEBHOOK_SECRET.value();
    if (!stripe || !whsec) { res.status(503).send('Stripe not configured'); return; }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody, String(req.headers['stripe-signature'] || ''), whsec);
    } catch (err) {
      logger.warn('velvet webhook: bad signature', { err: (err as Error).message });
      res.status(400).send('Bad signature');
      return;
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const uid = session.metadata && session.metadata.uid;
          const customerId = customerIdOf(session.customer);
          if (uid && customerId) {
            await memberRef(uid).set({
              billing: 'stripe',
              stripeCustomerId: customerId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          }
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          await mirrorSubscription(event.data.object as Stripe.Subscription);
          break;
        case 'invoice.paid':
          await recordInvoice(event.data.object as Stripe.Invoice);
          break;
        default:
          break; // uninteresting event — acknowledge and move on
      }
      res.json({ received: true });
    } catch (err) {
      logger.error('velvet webhook', (err as Error).message);
      res.status(500).send('Webhook handler failed');
    }
  }
);
