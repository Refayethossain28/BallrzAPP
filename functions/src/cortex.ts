/**
 * Cortex Pro — the brain-gym (cortex/) subscription backend.
 *
 * Real billing for Cortex Pro: Stripe Billing (Checkout for sign-up, the
 * Billing Portal for self-serve management, a webhook to mirror truth). The
 * client never talks to Stripe directly and never decides its own entitlement
 * when real billing is on — the webhook writes the subscription state into
 * `cortex_members/{uid}` and the app renders whatever Firestore says.
 *
 * Money-path invariants (same convention as velvet.ts):
 *   - The price is defined HERE (and created in Stripe by lookup_key), never
 *     taken from the client. It must match cortex/engine.js PRO.
 *   - Invoices are recorded idempotently by Stripe invoice id, so a webhook
 *     retry can't double-record.
 *   - With no STRIPE_SECRET_KEY set, createCortexCheckout falls back to a mock
 *     flow (server-written trial) so the whole loop is testable without keys.
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
const DEFAULT_RETURN = 'https://refayethossain28.github.io/BallrzAPP/cortex/';

// Server-side source of truth for the plan — must match cortex/engine.js PRO.
const CORTEX_PLAN = { name: 'Cortex Pro', pricePence: 399, lookupKey: 'cortex_pro_monthly' };

function db() { return admin.firestore(); }
function memberRef(uid: string) { return db().doc(`cortex_members/${uid}`); }

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
  const q = await db().collection('cortex_members')
    .where('stripeCustomerId', '==', customerId).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}

/** Find the recurring Price by lookup_key, creating product+price on first use. */
async function findOrCreatePrice(stripe: Stripe): Promise<string> {
  const key = CORTEX_PLAN.lookupKey;
  const existing = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  if (existing.data.length) return existing.data[0].id;
  const product = await stripe.products.create({
    name: CORTEX_PLAN.name,
    metadata: { app: 'cortex' },
  });
  const price = await stripe.prices.create({
    product: product.id,
    currency: 'gbp',
    unit_amount: CORTEX_PLAN.pricePence,
    recurring: { interval: 'month' },
    lookup_key: key,
    metadata: { app: 'cortex' },
  });
  return price.id;
}

/** Start (or restart) Cortex Pro — returns a Stripe Checkout URL. */
export const createCortexCheckout = onCall(
  { secrets: [STRIPE_SECRET_KEY], region: REGION },
  async (request: CallableRequest<{ successUrl?: string; cancelUrl?: string }>) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to subscribe');
    const uid = request.auth.uid;

    const stripe = stripeClient();
    if (!stripe) {
      // Mock mode: no key configured — the server itself grants the trial, so
      // the end-to-end loop (checkout → webhook → Firestore → client) is
      // exercisable before Stripe is connected.
      const now = Date.now();
      await memberRef(uid).set({
        billing: 'stripe-mock',
        sub: {
          status: 'trialing', startedAt: now,
          periodStart: now, periodEnd: now + TRIAL_DAYS * DAY_MS,
          cancelAtPeriodEnd: false, endedAt: null,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      logger.info('createCortexCheckout mock trial', { uid });
      return { mock: true };
    }

    const price = await findOrCreatePrice(stripe);
    const snap = await memberRef(uid).get();
    let customerId = (snap.data() || {}).stripeCustomerId as string | undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: (request.auth.token.email as string | undefined) || undefined,
        metadata: { app: 'cortex', uid },
      });
      customerId = customer.id;
      await memberRef(uid).set({ stripeCustomerId: customerId }, { merge: true });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price, quantity: 1 }],
      subscription_data: { trial_period_days: TRIAL_DAYS, metadata: { app: 'cortex', uid } },
      metadata: { app: 'cortex', uid },
      success_url: safeReturnUrl(request.data && request.data.successUrl),
      cancel_url: safeReturnUrl(request.data && request.data.cancelUrl),
      allow_promotion_codes: true,
    });
    return { url: session.url };
  }
);

/** Self-serve billing management (cancel/resume/cards) — Billing Portal URL. */
export const createCortexPortal = onCall(
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

function mapStatus(s: Stripe.Subscription.Status): 'trialing' | 'active' | 'canceled' {
  if (s === 'trialing') return 'trialing';
  if (s === 'active' || s === 'past_due') return 'active';
  return 'canceled'; // canceled | unpaid | incomplete | incomplete_expired | paused
}

/** Only mirror subscriptions that belong to this app (metadata or lookup key). */
function isCortexSubscription(sub: Stripe.Subscription): boolean {
  if (sub.metadata && sub.metadata.app === 'cortex') return true;
  const key = sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.lookup_key;
  return key === CORTEX_PLAN.lookupKey;
}

async function mirrorSubscription(sub: Stripe.Subscription): Promise<void> {
  if (!isCortexSubscription(sub)) return;
  let uid = (sub.metadata && sub.metadata.uid) || null;
  const customerId = customerIdOf(sub.customer);
  if (!uid && customerId) uid = await uidForCustomer(customerId);
  if (!uid) { logger.warn('cortex webhook: subscription with no resolvable uid', { sub: sub.id }); return; }
  const status = mapStatus(sub.status);
  await memberRef(uid).set({
    billing: 'stripe',
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    sub: {
      status,
      startedAt: (sub.start_date || sub.created) * 1000,
      periodStart: sub.current_period_start * 1000,
      periodEnd: sub.current_period_end * 1000,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      endedAt: status === 'canceled' ? (sub.ended_at ? sub.ended_at * 1000 : sub.current_period_end * 1000) : null,
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/** Record a paid invoice once (by Stripe invoice id). */
async function recordInvoice(inv: Stripe.Invoice): Promise<void> {
  if (!inv.id || !inv.amount_paid || inv.amount_paid <= 0) return;
  const line = inv.lines && inv.lines.data[0];
  const key = (line && line.price && line.price.lookup_key) || '';
  if (key !== CORTEX_PLAN.lookupKey) return; // another app's invoice
  const customerId = customerIdOf(inv.customer);
  const uid = customerId ? await uidForCustomer(customerId) : null;
  if (!uid) { logger.warn('cortex webhook: invoice with no resolvable uid', { invoice: inv.id }); return; }

  const invRef = memberRef(uid).collection('invoices').doc(inv.id);
  await db().runTransaction(async (tx) => {
    const existing = await tx.get(invRef);
    if (existing.exists) return; // webhook retry — already recorded
    tx.set(invRef, {
      amountPence: inv.amount_paid,
      at: (inv.status_transitions && inv.status_transitions.paid_at ? inv.status_transitions.paid_at : inv.created) * 1000,
      periodStart: line && line.period ? line.period.start * 1000 : null,
      periodEnd: line && line.period ? line.period.end * 1000 : null,
      description: CORTEX_PLAN.name,
      stripeInvoiceId: inv.id,
      hostedInvoiceUrl: inv.hosted_invoice_url || null,
    });
    tx.set(memberRef(uid), {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

export const cortexStripeWebhook = onRequest(
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
      logger.warn('cortex webhook: bad signature', { err: (err as Error).message });
      res.status(400).send('Bad signature');
      return;
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const uid = session.metadata && session.metadata.uid;
          const customerId = customerIdOf(session.customer);
          if (session.metadata && session.metadata.app === 'cortex' && uid && customerId) {
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
      logger.error('cortex webhook', (err as Error).message);
      res.status(500).send('Webhook handler failed');
    }
  }
);
