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
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import * as admin from 'firebase-admin';
import { randomBytes } from 'node:crypto';
import type Stripe from 'stripe';
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, stripeClient } from './stripe.js';
import { SENDGRID_API_KEY } from './email.js';
import { makeProCode, validProCode, atlasProEmail, guardianEmail, ytClipMeta, validateClipSubmission as logicValidateClip } from './logic.js';

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

/* --------------------- Atlas community clip channel ----------------------
 * A driver's dashcam clip → the Atlas YouTube channel, with review between.
 *
 * Flow: the app uploads the clip to Storage (atlas_clips/{uid}/…, rules
 * enforce owner + size + video type), then calls this endpoint with the
 * user's Firebase ID token. We validate, push the video to YouTube with the
 * CHANNEL's stored OAuth refresh token as UNLISTED, log the submission in
 * Firestore (atlas_clip_subs), delete the Storage copy, and return the
 * YouTube URL. The channel owner reviews unlisted uploads and publishes the
 * good ones — nothing goes public unseen.
 *
 * Setup: atlas/YOUTUBE.md (channel, Google Cloud OAuth client, refresh
 * token via scripts/mint-youtube-token.mjs, secrets, quota honesty).
 */
export const YT_CLIENT_ID = defineSecret('ATLAS_YT_CLIENT_ID');
export const YT_CLIENT_SECRET = defineSecret('ATLAS_YT_CLIENT_SECRET');
export const YT_REFRESH_TOKEN = defineSecret('ATLAS_YT_REFRESH_TOKEN');

async function ytAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: YT_CLIENT_ID.value(),
      client_secret: YT_CLIENT_SECRET.value(),
      refresh_token: YT_REFRESH_TOKEN.value(),
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('token refresh failed: ' + res.status);
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error('no access token');
  return json.access_token;
}

const CLIP_CORS = ['https://apexvip.uk', 'http://localhost:8899', 'capacitor://localhost'];

export const atlasClipPublish = onRequest(
  { secrets: [YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN],
    region: REGION, memory: '1GiB', timeoutSeconds: 540 },
  async (req, res) => {
    const origin = String(req.headers.origin || '');
    if (CLIP_CORS.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).send('POST only'); return; }
    if (!YT_CLIENT_ID.value() || !YT_CLIENT_SECRET.value() || !YT_REFRESH_TOKEN.value()) {
      res.status(503).json({ error: 'channel uploads not configured' }); return;
    }
    try {
      // the caller must be the signed-in owner of the uploaded file
      const idToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const decoded = await admin.auth().verifyIdToken(idToken).catch(() => null);
      if (!decoded) { res.status(401).json({ error: 'sign-in required' }); return; }
      const { path, durS } = (req.body || {}) as { path?: string; durS?: number };
      if (!path || !new RegExp('^atlas_clips/' + decoded.uid + '/[\\w.-]+$').test(path)) {
        res.status(400).json({ error: 'bad path' }); return;
      }
      const file = admin.storage().bucket().file(path);
      const [meta] = await file.getMetadata();
      const check = logicValidateClip({ size: Number(meta.size), contentType: String(meta.contentType || ''), durS: Number(durS) || 0 });
      if (!check.ok) { res.status(400).json({ error: check.reason }); return; }

      const token = await ytAccessToken();
      const body = ytClipMeta({ t: Date.now(), durS: Number(durS) || 0 });
      const init = await fetch(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': String(meta.contentType || 'video/webm'),
            'X-Upload-Content-Length': String(meta.size),
          },
          body: JSON.stringify(body),
        });
      if (!init.ok) {
        const detail = await init.text().catch(() => '');
        logger.error('yt init failed', init.status, detail.slice(0, 500));
        res.status(502).json({ error: init.status === 403 ? 'YouTube quota reached — try tomorrow' : 'YouTube rejected the upload' });
        return;
      }
      const session = init.headers.get('location');
      if (!session) { res.status(502).json({ error: 'no upload session' }); return; }
      const [data] = await file.download(); // ≤200MB by rules+check; memory is 1GiB
      const up = await fetch(session, {
        method: 'PUT',
        headers: { 'Content-Type': String(meta.contentType || 'video/webm') },
        body: data,
      });
      if (!up.ok) {
        logger.error('yt upload failed', up.status);
        res.status(502).json({ error: 'upload to YouTube failed' }); return;
      }
      const video = await up.json() as { id?: string };
      const url = 'https://youtu.be/' + video.id;
      await admin.firestore().collection('atlas_clip_subs').doc(String(video.id)).set({
        uid: decoded.uid, size: Number(meta.size), durS: Number(durS) || 0,
        url, status: 'unlisted-pending-review',
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
      await file.delete().catch(() => {});
      logger.info('atlas clip published (unlisted)', { video: video.id, uid: decoded.uid });
      res.json({ url, review: true });
    } catch (err) {
      logger.error('atlas clip publish', (err as Error).message);
      res.status(500).json({ error: 'something went wrong — the clip is still on your phone' });
    }
  }
);

/**
 * 🛡 Guardian crash alerts — the automatic half of Atlas's crash detection.
 *
 * The app only writes an atlas_guardian doc when a driver failed to answer
 * the 30-second crash countdown (rules validate every field and the
 * collection is write-only for clients). This trigger emails the driver's
 * chosen emergency contact with the position and the live watch link, then
 * stamps the doc so retries never double-send. If SendGrid isn't
 * configured the doc still records the attempt for manual follow-up.
 */
export const atlasGuardianAlert = onDocumentCreated(
  { document: 'atlas_guardian/{alertId}', region: REGION, secrets: [SENDGRID_API_KEY] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() as { email?: string; name?: string; lat?: number; lon?: number; watch?: string; t?: number; sent?: boolean };
    if (d.sent) return; // replayed event — already handled
    const to = String(d.email || '').trim();
    if (!to || !to.includes('@')) return;
    const key = SENDGRID_API_KEY.value();
    if (!key) { logger.warn('guardian alert: SENDGRID_API_KEY not set — alert NOT emailed', { id: snap.id }); return; }
    const msg = guardianEmail(d);
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: ATLAS_FROM_EMAIL, name: 'Atlas Guardian' },
        subject: msg.subject,
        content: [{ type: 'text/plain', value: msg.text }],
      }),
    });
    if (!res.ok) {
      logger.error('guardian alert email failed', res.status, await res.text().catch(() => ''));
      return;
    }
    await snap.ref.set({ sent: true, sentAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    logger.info('guardian alert emailed', { id: snap.id });
  }
);
