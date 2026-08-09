/**
 * Atlas Pro fulfilment — the automated shop half of the offline unlock-code
 * system (the app half verifies codes on-device, see atlas/engine.js).
 *
 * Flow: a Stripe Payment Link (metadata product=atlas-pro) completes checkout
 * → Stripe calls this webhook → we mint a code, record the sale in Firestore
 * (atlas_pro_sales/{sessionId} — the ledger doubles as idempotency, so Stripe
 * retries never mint or mail twice), and email the code to the buyer via
 * SendGrid. If email isn't configured or fails, the sale is still recorded
 * with the code so it can be sent by hand from the ledger.
 *
 * Setup (one-time): atlas/SELLING.md walks through the Payment Link, the
 * webhook endpoint, and the secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 * SENDGRID_API_KEY, optional ATLAS_FROM_EMAIL env).
 */
import { onRequest } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import * as admin from 'firebase-admin';
import { randomBytes } from 'node:crypto';
import type Stripe from 'stripe';
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, stripeClient } from './stripe.js';
import { SENDGRID_API_KEY } from './email.js';
import { makeProCode, validProCode, atlasProEmail } from './logic.js';

const REGION = 'us-central1';
const ATLAS_FROM_EMAIL = process.env.ATLAS_FROM_EMAIL || 'atlas@apexvip.uk';

const cryptoRand = () => randomBytes(4).readUInt32BE(0) / 2 ** 32;

async function emailCode(to: string, code: string): Promise<boolean> {
  const key = SENDGRID_API_KEY.value();
  if (!key || !to) return false;
  const msg = atlasProEmail(code);
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: ATLAS_FROM_EMAIL, name: 'Atlas' },
      subject: msg.subject,
      content: [{ type: 'text/plain', value: msg.text }],
    }),
  });
  if (!res.ok) logger.warn('atlas pro email', res.status, await res.text().catch(() => ''));
  return res.ok;
}

export const atlasProWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SENDGRID_API_KEY], region: REGION },
  async (req, res) => {
    const stripe = stripeClient();
    const whsec = STRIPE_WEBHOOK_SECRET.value();
    if (!stripe || !whsec) { res.status(503).send('Stripe not configured'); return; }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody, String(req.headers['stripe-signature'] || ''), whsec);
    } catch (err) {
      logger.warn('atlas webhook: bad signature', { err: (err as Error).message });
      res.status(400).send('Bad signature');
      return;
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const product = (session.metadata && session.metadata.product) || '';
        // this endpoint only fulfils Atlas Pro — other products' sessions
        // (Velvet, bookings) are acknowledged and left to their own webhooks
        if (product === 'atlas-pro' && session.payment_status === 'paid') {
          const email = (session.customer_details && session.customer_details.email) ||
                        session.customer_email || '';
          const ref = admin.firestore().collection('atlas_pro_sales').doc(session.id);
          // transaction = idempotency: the first webhook delivery mints the
          // code; retries see the doc and change nothing
          const { code, fresh } = await admin.firestore().runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists) return { code: String(snap.get('code')), fresh: false };
            const minted = makeProCode(cryptoRand);
            if (!validProCode(minted)) throw new Error('minted an invalid code');
            tx.set(ref, {
              code: minted,
              email,
              amount: session.amount_total,
              currency: session.currency,
              emailed: false,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return { code: minted, fresh: true };
          });
          if (fresh) {
            const sent = await emailCode(email, code);
            await ref.set({ emailed: sent }, { merge: true });
            logger.info('atlas pro sale fulfilled', { session: session.id, emailed: sent });
          }
        }
      }
      res.json({ received: true });
    } catch (err) {
      logger.error('atlas webhook', (err as Error).message);
      res.status(500).send('Webhook handler failed');
    }
  }
);
