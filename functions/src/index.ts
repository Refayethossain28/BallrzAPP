/**
 * ApexVIP Cloud Functions — getHotelRates and the rest of the ApexVIP backend.
 *
 * Live hotel pricing for the client app (`apexvip-client.html`). The browser must
 * never hold the Amadeus secret, so the client calls this callable function, which
 * proxies Amadeus server-side and returns a quote in the exact shape the client's
 * `fetchHotelRate()` expects. If this function is absent or errors, the client
 * silently falls back to its local estimate — so a partial deploy never breaks the UI.
 *
 * Firebase Functions v2 (2nd gen). Node 20 provides a global `fetch`.
 *
 * TypeScript: source lives in `src/`, builds to `lib/index.js` (esbuild). The
 * Firestore document shapes are in `./types.ts`; cast a snapshot's `.data()` to
 * one of them at the read boundary. Behaviour is identical to the prior index.js —
 * this port only adds types.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { onDocumentWritten, onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import * as https from 'node:https';
import Anthropic from '@anthropic-ai/sdk';
import * as admin from 'firebase-admin';

import { STRIPE_SECRET_KEY, stripeClient } from './stripe.js';
// Velvet — the subscription VIP concierge (concierge/): Stripe Billing
// checkout + portal + webhook. Deployed alongside the ApexVIP functions.
export { createVelvetCheckout, createVelvetPortal, velvetStripeWebhook } from './velvet.js';
// ApexCoin on-chain bridge (apexchain/ApexCoin.sol): withdraw APEX as a real
// ERC-20, deposit it back. See ./chain.ts.
export { linkChainWallet, withdrawCoinsOnchain, depositCoinsOnchain } from './chain.js';

import {
  round5, isoPlusDays, computeFareBounds, driverEarning, dispatchPay,
  bookingEvent, bookingMessage, daysUntil, shouldRemind, flightHHMM,
  normalizeCommissionPct, clientCoinsEarned, driverCoinsEarned,
  clampCoinRedemption, round2, coinEarnRates, apexTierForBalance,
  bonusMonthKey, monthlyBonusForBalance, qualifiesForRatingBonus, milestoneBonusAt,
  DRIVER_RATING_BONUS,
  type CoinEarnRates, type CoinRateSettings,
} from './logic.js';

/**
 * Business model (settings/business): 'commission' (default — platform keeps a
 * fixed 20% of each fare) or 'subscription' (clients + drivers pay a monthly
 * fee; the admin sets the per-trip commission, which can be 0). Cached briefly
 * per warm instance so booking-triggered functions don't re-read every event.
 */
let _bizCache: { commissionPct: number; at: number } | null = null;
async function platformCommissionPct(): Promise<number> {
  if (_bizCache && Date.now() - _bizCache.at < 60_000) return _bizCache.commissionPct;
  let pct = 20;
  try {
    const doc = await admin.firestore().doc('settings/business').get();
    const d = doc.exists ? (doc.data() as { model?: string; commissionPct?: number }) : {};
    pct = d.model === 'subscription' ? normalizeCommissionPct(d.commissionPct) : 20;
  } catch { /* default to the commission model's 20% */ }
  _bizCache = { commissionPct: pct, at: Date.now() };
  return pct;
}

// ApexCoin earn rates (settings/coins, admin-tunable, tiered for clients) —
// cached briefly per warm instance like the business settings above.
let _coinRateCache: { rates: CoinEarnRates; at: number } | null = null;
async function platformCoinRates(): Promise<CoinEarnRates> {
  if (_coinRateCache && Date.now() - _coinRateCache.at < 60_000) return _coinRateCache.rates;
  let s: CoinRateSettings | null = null;
  try {
    const doc = await admin.firestore().doc('settings/coins').get();
    if (doc.exists) s = doc.data() as CoinRateSettings;
  } catch { /* defaults below */ }
  const rates = coinEarnRates(s);
  _coinRateCache = { rates, at: Date.now() };
  return rates;
}

import type {
  Booking,
  CoinLedgerEntry,
  Driver,
  DriverPayout,
  GetHotelRatesInput,
  ParseBookingInput,
  Pricing,
  ProcessSquarePaymentInput,
  RefundSquarePaymentInput,
  User,
  Vehicle,
} from './types.js';

/** Normalize an unknown thrown value to a message string for logging. */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Anthropic client, memoized per warm instance (keyed by the resolved secret).
// Powers parseBookingIntent (ApexAI concierge).
let _anthropic: Anthropic | null = null;
let _anthropicKey: string | null = null;
function anthropicClient(apiKey: string): Anthropic {
  if (!_anthropic || _anthropicKey !== apiKey) {
    _anthropic = new Anthropic({ apiKey });
    _anthropicKey = apiKey;
  }
  return _anthropic;
}

// Secrets — set once with: firebase functions:secrets:set AMADEUS_CLIENT_ID
const AMADEUS_CLIENT_ID = defineSecret('AMADEUS_CLIENT_ID');
const AMADEUS_CLIENT_SECRET = defineSecret('AMADEUS_CLIENT_SECRET');

// Square — set with: firebase functions:secrets:set SQUARE_ACCESS_TOKEN
const SQUARE_ACCESS_TOKEN = defineSecret('SQUARE_ACCESS_TOKEN');

// Lingua (language app) — set with: firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// Stripe Connect — driver payouts. The secret + lazy client are shared with the
// Velvet membership billing and live in ./stripe.ts (a secret param may only be
// defined once per name).
// Where Stripe returns the driver after onboarding (their app).
const PAYOUT_RETURN_URL = process.env.PAYOUT_RETURN_URL || 'https://refayethossain28.github.io/BallrzAPP/apexvip-driver.html';
async function isAdminUid(uid: string): Promise<boolean> {
  try { const u = await admin.firestore().doc(`users/${uid}`).get(); return u.exists && (u.data() as User | undefined)?.role === 'admin'; }
  catch (_) { return false; }
}

// Test by default (free, limited inventory). For production set AMADEUS_HOST to
// https://api.amadeus.com via a functions/.env file or --set-env-vars.
const AMADEUS_HOST = process.env.AMADEUS_HOST || 'https://test.api.amadeus.com';

// In-memory OAuth2 token cache (per warm instance)
let _token: { value: string; expiresAt: number } | null = null;

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  if (_token && _token.expiresAt > Date.now() + 60_000) return _token.value;
  const res = await fetch(`${AMADEUS_HOST}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Amadeus auth failed: ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in?: number };
  _token = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 1799) * 1000,
  };
  return _token.value;
}

export const getHotelRates = onCall(
  { secrets: [AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET], region: 'us-central1' },
  async (request: CallableRequest<GetHotelRatesInput>) => {
    const { name, lat, lng, checkIn, nights = 1, guests = 2, currency = 'GBP' } =
      request.data || {};

    if (lat == null || lng == null || !checkIn) {
      throw new HttpsError('invalid-argument', 'lat, lng and checkIn are required');
    }

    const nightCount = Math.max(1, Math.min(14, Number(nights) || 1));
    const adults = Math.max(1, Math.min(9, Number(guests) || 2));
    const checkOut = isoPlusDays(checkIn, nightCount);

    let token: string;
    try {
      token = await getToken(AMADEUS_CLIENT_ID.value(), AMADEUS_CLIENT_SECRET.value());
    } catch (err) {
      logger.error('Amadeus auth error', err);
      throw new HttpsError('unavailable', 'Hotel rate provider is unavailable');
    }
    const auth = { Authorization: `Bearer ${token}` };

    // 1) Resolve the nearest Amadeus hotelId(s) by geocode.
    const geoUrl =
      `${AMADEUS_HOST}/v1/reference-data/locations/hotels/by-geocode` +
      `?latitude=${lat}&longitude=${lng}&radius=1&radiusUnit=KM&hotelSource=ALL`;
    let hotelIds: string[] = [];
    try {
      const geoRes = await fetch(geoUrl, { headers: auth });
      if (geoRes.ok) {
        const geo = await geoRes.json() as { data?: Array<{ hotelId?: string }> };
        hotelIds = (geo.data || []).slice(0, 8).map((h) => h.hotelId).filter(Boolean) as string[];
      } else {
        logger.warn(`geocode ${geoRes.status} for ${name}`);
      }
    } catch (err) {
      logger.error('geocode error', err);
    }
    if (!hotelIds.length) return { name, currency, checkIn, available: false };

    // 2) Live offers for the stay.
    const offUrl =
      `${AMADEUS_HOST}/v3/shopping/hotel-offers` +
      `?hotelIds=${hotelIds.join(',')}` +
      `&checkInDate=${checkIn}&checkOutDate=${checkOut}` +
      `&adults=${adults}&roomQuantity=1&currency=${currency}&bestRateOnly=true`;

    let offers: number[] = [];
    try {
      const offRes = await fetch(offUrl, { headers: auth });
      if (offRes.ok) {
        const off = await offRes.json() as { data?: Array<{ offers?: Array<{ price?: { total?: string } }> }> };
        for (const entry of off.data || []) {
          for (const o of entry.offers || []) {
            const total = parseFloat((o.price && o.price.total) as string);
            if (!Number.isNaN(total)) offers.push(total);
          }
        }
      } else {
        // 4xx here usually means no availability for these dates/occupancy.
        logger.info(`no offers (${offRes.status}) for ${name} ${checkIn}`);
      }
    } catch (err) {
      logger.error('hotel-offers error', err);
    }

    if (!offers.length) return { name, currency, checkIn, available: false };

    // price.total is the whole-stay total per offer → derive nightly.
    const lowestTotal = Math.min(...offers);
    return {
      nightly: round5(lowestTotal / nightCount),
      from: round5(lowestTotal / nightCount),
      total: round5(lowestTotal),
      nights: nightCount,
      guests: adults,
      currency,
      checkIn,
      available: true,
    };
  }
);

// ── Payments (Square) ───────────────────────────────────────────────────────
// The browser tokenizes the card and runs SCA (verifyBuyer); these functions
// hold the Square access token and perform the charge server-side. We talk to
// Square's REST API directly via global fetch (no extra dependency).
//
// Model: PRE-AUTH on booking (autocomplete:false) → CAPTURE on trip completion →
// REFUND per the cancellation policy. Amounts are recomputed/validated here —
// never trust the client's amount in production.

const SQUARE_HOST = process.env.SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || '';
const SQUARE_API_VERSION = '2024-10-17';

// firebase-admin — initialized once at module load so every function (payments,
// notifications, dispatch) can reach Firestore/Auth. Guarded against double-init.
if (!admin.apps.length) admin.initializeApp();

// A Square REST error carries the HTTP status + structured error list.
interface SquareErrorDetail { detail?: string; code?: string }
class SquareError extends Error {
  squareStatus?: number;
  squareErrors?: SquareErrorDetail[];
}

// Plausible-fare bounds derived from settings/pricing. We can't always recompute
// the exact fare here (point-to-point fares depend on live route data the client
// holds), so we read the operator's pricing and reject any charge that falls
// outside a sane floor/ceiling — defeating amount tampering and runaway charges.
async function fareBounds(): Promise<{ floor: number; ceiling: number }> {
  let p: Pricing = {};
  try {
    const snap = await admin.firestore().doc('settings/pricing').get();
    if (snap.exists) p = (snap.data() as Pricing) || {};
  } catch (_) { /* settings unreadable → fall back to defaults below */ }
  return computeFareBounds(p);
}

// Confirm the caller owns (or is staff for) the booking tied to a Square payment.
// Used by capture/refund, which act on money already authorized against a booking.
async function assertPaymentOwnership(uid: string, paymentId: string): Promise<void> {
  const db = admin.firestore();
  // Staff (admin/driver) may capture/refund any booking.
  try {
    const u = await db.doc(`users/${uid}`).get();
    const role = u.exists && (u.data() as User | undefined)?.role;
    if (role === 'admin' || role === 'driver') return;
  } catch (_) { /* fall through to ownership check */ }
  const q = await db.collection('bookings').where('squarePaymentId', '==', paymentId).limit(1).get();
  if (q.empty) throw new HttpsError('not-found', 'No booking matches this payment');
  if ((q.docs[0].data() as Booking).clientId !== uid) {
    throw new HttpsError('permission-denied', 'You do not own this payment');
  }
}

async function squareFetch(path: string, body: unknown, token: string): Promise<any> {
  const res = await fetch(`${SQUARE_HOST}/v2${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Square-Version': SQUARE_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as { errors?: SquareErrorDetail[] } & Record<string, any>;
  if (!res.ok) {
    const msg = (data.errors && data.errors.map((e) => e.detail || e.code).join('; ')) || `Square ${res.status}`;
    const err = new SquareError(msg); err.squareStatus = res.status; err.squareErrors = data.errors; throw err;
  }
  return data;
}

function toMinorUnits(amount: unknown): number {
  const n = Math.round(Number(amount) * 100);
  if (!Number.isFinite(n) || n <= 0) throw new HttpsError('invalid-argument', 'Invalid amount');
  return n;
}

// Authorize (pre-auth) a payment. Capture later with captureSquarePayment.
export const processSquarePayment = onCall(
  { secrets: [SQUARE_ACCESS_TOKEN], region: 'us-central1' },
  async (request: CallableRequest<ProcessSquarePaymentInput>) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to pay');
    const d = request.data || {};
    if (!d.sourceId || !d.idempotencyKey) {
      throw new HttpsError('invalid-argument', 'sourceId and idempotencyKey are required');
    }
    // SECURITY: never trust the client amount blindly. We validate it against the
    // operator's pricing (settings/pricing) and reject anything outside a sane
    // floor/ceiling, defeating both undercharge tampering and runaway charges.
    const amount = toMinorUnits(d.amount);
    const { floor, ceiling } = await fareBounds();
    const gbp = amount / 100;
    if (gbp < floor || gbp > ceiling) {
      logger.warn('processSquarePayment rejected amount', { uid: request.auth.uid, gbp, floor, ceiling });
      throw new HttpsError('invalid-argument', 'Amount outside the permitted fare range');
    }
    const body = {
      source_id: d.sourceId,
      idempotency_key: String(d.idempotencyKey),
      amount_money: { amount, currency: d.currency || 'GBP' },
      autocomplete: false, // pre-auth; capture on trip completion
      reference_id: d.bookingRef || undefined,
      verification_token: d.verificationToken || undefined,
      location_id: SQUARE_LOCATION_ID || undefined,
    };
    try {
      const out = await squareFetch('/payments', body, SQUARE_ACCESS_TOKEN.value());
      const p = out.payment || {};
      return { paymentId: p.id, status: p.status, receiptUrl: p.receipt_url || null };
    } catch (err) {
      const se = err as SquareError;
      logger.error('processSquarePayment', se.message, se.squareErrors || '');
      throw new HttpsError(se.squareStatus === 402 ? 'failed-precondition' : 'unavailable', se.message);
    }
  }
);

// Capture a previously authorized payment when the trip completes.
export const captureSquarePayment = onCall(
  { secrets: [SQUARE_ACCESS_TOKEN], region: 'us-central1' },
  async (request: CallableRequest<{ paymentId?: string }>) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    const paymentId = request.data && request.data.paymentId;
    if (!paymentId) throw new HttpsError('invalid-argument', 'paymentId is required');
    await assertPaymentOwnership(request.auth.uid, paymentId);
    try {
      const out = await squareFetch(`/payments/${encodeURIComponent(paymentId)}/complete`, {}, SQUARE_ACCESS_TOKEN.value());
      return { paymentId, status: (out.payment && out.payment.status) || 'COMPLETED' };
    } catch (err) {
      logger.error('captureSquarePayment', errMessage(err));
      throw new HttpsError('unavailable', errMessage(err));
    }
  }
);

// Refund a captured payment (full or partial) per the cancellation policy.
export const refundSquarePayment = onCall(
  { secrets: [SQUARE_ACCESS_TOKEN], region: 'us-central1' },
  async (request: CallableRequest<RefundSquarePaymentInput>) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    const d = request.data || {};
    if (!d.paymentId || !d.idempotencyKey) {
      throw new HttpsError('invalid-argument', 'paymentId and idempotencyKey are required');
    }
    await assertPaymentOwnership(request.auth.uid, d.paymentId);
    const body = {
      idempotency_key: String(d.idempotencyKey),
      payment_id: d.paymentId,
      amount_money: { amount: toMinorUnits(d.amount), currency: d.currency || 'GBP' },
      reason: d.reason || 'Cancellation',
    };
    try {
      const out = await squareFetch('/refunds', body, SQUARE_ACCESS_TOKEN.value());
      const r = out.refund || {};
      return { refundId: r.id, status: r.status };
    } catch (err) {
      logger.error('refundSquarePayment', errMessage(err));
      throw new HttpsError('unavailable', errMessage(err));
    }
  }
);

// ── Booking-lifecycle notifications ─────────────────────────────────────────
// Firestore-triggered: emails (SendGrid) and texts (Twilio) the client as their
// booking moves through its lifecycle. Providers are called directly via fetch.
// All credentials are secrets; if a provider isn't configured it's skipped, so a
// partial setup never errors. Set the non-secret from-address/number via env.

const SENDGRID_API_KEY   = defineSecret('SENDGRID_API_KEY');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN  = defineSecret('TWILIO_AUTH_TOKEN');

const NOTIFY_FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || 'concierge@apexvip.com';
const NOTIFY_FROM_NAME  = process.env.NOTIFY_FROM_NAME  || 'ApexVIP';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const OPS_EMAIL = process.env.OPS_EMAIL || NOTIFY_FROM_EMAIL; // fleet/compliance inbox

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const key = SENDGRID_API_KEY.value();
  if (!key || !to) return;
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: NOTIFY_FROM_EMAIL, name: NOTIFY_FROM_NAME },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
  });
  if (!res.ok) logger.warn('SendGrid', res.status, await res.text().catch(() => ''));
}

async function sendSms(to: string, body: string): Promise<void> {
  const sid = TWILIO_ACCOUNT_SID.value(), tok = TWILIO_AUTH_TOKEN.value();
  if (!sid || !tok || !TWILIO_FROM_NUMBER || !to) return;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
  });
  if (!res.ok) logger.warn('Twilio', res.status, await res.text().catch(() => ''));
}

export const onBookingWrite = onDocumentWritten(
  { document: 'bookings/{bookingId}', secrets: [SENDGRID_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN], region: 'us-central1' },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() as Booking : null;
    const after  = event.data && event.data.after  && event.data.after.exists  ? event.data.after.data()  as Booking : null;
    const kind = bookingEvent(before, after);
    if (!kind) return;
    // On completion, record the driver's earning to the payout ledger
    // (idempotent — one entry per booking). Settled later via payoutDriver.
    // Share = 80% under the commission model, admin-set under subscription.
    if (kind === 'completed' && after && after.driverId) {
      try {
        const amount = driverEarning(after, await platformCommissionPct());
        if (amount > 0) {
          const entry: DriverPayout = {
            driverId: after.driverId,
            bookingRef: after.ref || event.params.bookingId,
            amount, currency: after.currency || 'GBP',
            status: 'owed',
            source: 'trip', // distinguishes trips from AXC cash-outs for the milestone count
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          await admin.firestore().collection('driver_payouts').doc(event.params.bookingId).set(entry, { merge: true });
          // ApexCoin: the driver earns a % of their pay (admin-tunable, default
          // 2%). The deterministic ledger id makes this idempotent — create()
          // throws if the trip already paid out coins (onDocumentWritten can
          // fire more than once).
          const axc = driverCoinsEarned(amount, (await platformCoinRates()).driverPct);
          if (axc > 0) {
            await creditCoins({
              ledgerId: `driverearn_${event.params.bookingId}`,
              balanceRef: admin.firestore().doc(`drivers/${after.driverId}`),
              balanceField: 'apexcoin',
              entry: { uid: after.driverId, role: 'driver', type: 'earn', amount: axc, reason: after.serviceLabel || 'Trip', ref: after.ref || event.params.bookingId },
            });
          }
          // Milestone: every 50th completed trip pays a 25 AXC bonus. The count
          // includes only trip rows (not AXC cash-outs); the deterministic
          // ledger id `milestone_{uid}_{count}` makes trigger re-fires no-ops.
          try {
            const count = (await admin.firestore().collection('driver_payouts')
              .where('driverId', '==', after.driverId).where('source', '==', 'trip')
              .count().get()).data().count;
            const bonus = milestoneBonusAt(count);
            if (bonus > 0) {
              await creditCoins({
                ledgerId: `milestone_${after.driverId}_${count}`,
                balanceRef: admin.firestore().doc(`drivers/${after.driverId}`),
                balanceField: 'apexcoin',
                entry: { uid: after.driverId, role: 'driver', type: 'earn', amount: bonus, reason: `Milestone · ${count} trips` },
              });
              logger.info('driver milestone bonus', { driverId: after.driverId, count, bonus });
            }
          } catch (err) { logger.error('milestone bonus', errMessage(err)); }
        }
      } catch (err) { logger.error('payout ledger', errMessage(err)); }
    }
    const msg = bookingMessage(kind, after as Booking);
    if (!msg) return;
    const [subject, text] = msg;
    const a = after as Booking;
    const email = a.clientEmail || a.email || '';
    const phone = a.clientPhone || a.phone || '';
    try {
      await Promise.all([ sendEmail(email, subject, text), sendSms(phone, `ApexVIP: ${text}`) ]);
      logger.info('booking notification sent', { kind, ref: a.ref || event.params.bookingId });
    } catch (err) {
      logger.error('onBookingWrite', errMessage(err));
    }
  }
);


/* ===========================================================================
 * parseBookingIntent — ApexAI concierge brain (apexvip-client.html + driver app)
 *
 * The client's ApexAI chat and the driver assistant call this. It uses Claude to
 * turn a free-text request ("collect me from Mayfair tomorrow at 9 for Heathrow
 * T5, BA247") into the exact structured intent the client already consumes —
 * `{intent, reply, serviceType, pickup, dropoff, airport, flight, date, time, …}`
 * — by forcing a single structured tool call. If this function is absent or
 * errors, the client falls back to its on-device `_parseIntentLocal` parser, so a
 * partial deploy never breaks the chat. Uses the Anthropic SDK server-side; the
 * browser never holds the Anthropic key.
 *
 * Note: hotel discovery is resolved on-device before this is called, so we focus
 * on rides, quotes, modifications, recurring trips, flight updates and chat.
 * =========================================================================== */
const APEXAI_MODEL = process.env.APEXAI_MODEL || 'claude-opus-4-8';

const APEXAI_INTENT_TOOL: Anthropic.Tool = {
  name: 'booking_intent',
  description: 'Return the structured booking intent parsed from the guest\'s message, plus a warm concierge reply.',
  input_schema: {
    type: 'object',
    properties: {
      reply:       { type: 'string', description: 'A short, warm reply in the voice of a luxury London chauffeur concierge. Confirm what you understood, or ask for the one missing detail. Never invent a booking that was not requested.' },
      intent:      { type: 'string', enum: ['book', 'quote', 'modify', 'recurring', 'flight_update', 'suggest', 'chat'], description: 'The guest\'s primary intent.' },
      serviceType: { type: 'string', enum: ['airport', 'hourly', 'day', 'point'], description: 'airport = airport transfer; hourly = by the hour; day = full-day chauffeur; point = point-to-point A→B.' },
      pickup:      { type: 'string', description: 'Pickup address/area exactly as the guest gave it. Empty if not stated.' },
      dropoff:     { type: 'string', description: 'Destination (non-airport). Empty if not stated.' },
      airport:     { type: 'string', description: 'Airport + terminal if relevant, e.g. "Heathrow T5", "Gatwick North", "London City Airport". Empty otherwise.' },
      flight:      { type: 'string', description: 'Flight number in uppercase with no space, e.g. "BA247". Empty if none.' },
      date:        { type: 'string', description: 'Travel date resolved to ISO YYYY-MM-DD using the provided current date. Empty if not stated.' },
      time:        { type: 'string', description: 'Pickup time as "HH:MM" (24h) or "3pm". Empty if not stated.' },
      vehicle:     { type: 'string', description: 'Requested vehicle if named, e.g. "Mercedes S-Class", "V-Class". Empty otherwise.' },
      passengers:  { type: 'integer', description: 'Passenger count if stated, else 0.' },
      suggestedPickupTime: { type: 'string', description: 'If a flight/airport is involved, a sensible pickup time accounting for travel + check-in, as "HH:MM". Empty otherwise.' },
      stops: {
        type: 'array',
        description: 'For multi-stop / day itineraries, the ordered stops. Empty for simple trips.',
        items: { type: 'object', properties: { name: { type: 'string' }, address: { type: 'string' } }, required: ['name'] },
      },
      paPassenger: {
        type: 'object',
        description: 'Set only if the guest is booking on behalf of someone else (a personal-assistant booking).',
        properties: { name: { type: 'string' }, notes: { type: 'string' } },
      },
      suggestions:  { type: 'array', description: 'For intent "suggest": 2–4 curated experience or destination ideas.', items: { type: 'string' } },
      modifyBookingRef: { type: 'string', description: 'For intent "modify": the booking reference (e.g. "APX-1234") to change.' },
      modifyFields: {
        type: 'object',
        description: 'For intent "modify": only the fields to change.',
        properties: { date: { type: 'string' }, time: { type: 'string' }, pickup: { type: 'string' }, dropoff: { type: 'string' } },
      },
      recurringPattern: { type: 'string', description: 'For intent "recurring": a short human description of the cadence, e.g. "every weekday 07:30".' },
      priceEstimate:    { type: 'number', description: 'For intent "quote": a rough £ estimate if you can infer one, else 0.' },
    },
    required: ['reply', 'intent'],
  },
};

async function apexCallClaude(p: ParseBookingInput, apiKey: string): Promise<Record<string, unknown>> {
  const { message, history, trips, now, mode, context } = p;
  const today = (typeof now === 'string' && now) || new Date().toISOString();

  if (mode === 'driver') {
    const sys =
      'You are ApexAI, the in-app assistant for an ApexVIP chauffeur driver. Be concise, ' +
      'practical and supportive — help with their jobs, earnings, schedule, going on/offline, ' +
      'navigation tips and app questions. Plain text only, a few sentences at most.' +
      (context ? ` Driver context: ${JSON.stringify(context).slice(0, 600)}.` : '');
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: APEXAI_MODEL,
      max_tokens: 400,
      system: sys,
      messages: [{ role: 'user', content: String(message || '').slice(0, 1000) }],
    };
    const data = await anthropicMessages(body, apiKey);
    const text = data.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { reply: text || 'How can I help with your next job?' };
  }

  if (mode === 'velvet') {
    // Velvet (concierge/) — the all-in-one VIP concierge desk. Free-text chat
    // inside one request thread; the desk (not the model) issues options,
    // prices and confirmations, so the persona must never invent them.
    const sys =
      'You are ApexAI, the live assistant on the ApexVIP Concierge desk — the all-in-one VIP concierge ' +
      '(travel, dining, events & tickets, chauffeur, personal shopping, home & errands, wellness, gifting). ' +
      `The current date/time is ${today} (Europe/London). ` +
      'You are chatting inside a single concierge request thread. Be warm, discreet and brief — 2–4 sentences, ' +
      'in the voice of a five-star concierge. Answer questions, refine the brief, and offer concrete, tasteful ' +
      'ideas for the request at hand. For chauffeur or ride needs, capture the details and say the desk will ' +
      'arrange the car with ApexVIP. Never invent confirmed bookings, availability or prices — priced options ' +
      'and confirmations only ever come from the desk itself. Plain text only.' +
      (context ? ` The request brief: ${JSON.stringify(context).slice(0, 800)}.` : '');
    const turns: Anthropic.MessageParam[] = (Array.isArray(history) ? history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-8)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
    turns.push({ role: 'user', content: String(message || '').slice(0, 1000) });
    const data = await anthropicMessages({
      model: APEXAI_MODEL,
      max_tokens: 500,
      system: sys,
      messages: turns,
    }, apiKey);
    const text = data.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { reply: text || 'Of course — leave it with me.' };
  }

  const sys =
    'You are ApexAI, the concierge brain for ApexVIP — a discreet luxury chauffeur service in London. ' +
    `The current date/time is ${today} (Europe/London). ` +
    'Parse the guest\'s message into a booking intent and call the booking_intent tool. ' +
    'Resolve relative dates ("tomorrow", "Friday") to ISO YYYY-MM-DD from the current date. ' +
    'Airports map to a terminal label (e.g. "Heathrow T5"). Flight numbers are uppercase, no space (e.g. "BA247"). ' +
    'Choose serviceType: airport for airport transfers, hourly for by-the-hour, day for full-day hire, point for a ' +
    'simple A→B journey. Only fill fields the guest actually stated — never invent an address, time or destination. ' +
    'Keep "reply" warm, brief and in the voice of a five-star chauffeur concierge.';

  const turns: Anthropic.MessageParam[] = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-8)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
  if (Array.isArray(trips) && trips.length) {
    turns.unshift({ role: 'user', content: `(For context, my recent/upcoming trips: ${JSON.stringify(trips).slice(0, 1200)})` });
    turns.push({ role: 'assistant', content: 'Noted — I have your trips for reference.' });
  }
  turns.push({ role: 'user', content: String(message || '').slice(0, 1000) });

  const data = await anthropicMessages({
    model: APEXAI_MODEL,
    max_tokens: 1024,
    system: sys,
    messages: turns,
    tools: [APEXAI_INTENT_TOOL],
    tool_choice: { type: 'tool', name: 'booking_intent' },
  }, apiKey);

  const toolUse = data.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) throw new Error('model returned no structured result');
  return (toolUse.input || {}) as Record<string, unknown>;
}

async function anthropicMessages(body: Anthropic.MessageCreateParamsNonStreaming, apiKey: string): Promise<Anthropic.Message> {
  return anthropicClient(apiKey).messages.create(body);
}

export const parseBookingIntent = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: 'us-central1' },
  async (request: CallableRequest<ParseBookingInput>) => {
    const p = request.data || {};
    if (typeof p.message !== 'string' || !p.message.trim()) {
      throw new HttpsError('invalid-argument', 'message is required');
    }
    if (p.message.length > 1000) throw new HttpsError('invalid-argument', 'message too long (max 1000 chars)');
    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) throw new HttpsError('failed-precondition', 'ANTHROPIC_API_KEY not configured.');
    try {
      // Returned object IS the callable result, so the client reads it directly as
      // `res.data.intent`, `res.data.reply`, … (matches _parseIntentLocal's shape).
      return await apexCallClaude(p, apiKey);
    } catch (err) {
      logger.error('parseBookingIntent', errMessage(err));
      // Throw so the client cleanly falls back to its on-device parser.
      throw new HttpsError('unavailable', errMessage(err));
    }
  }
);

/* ===========================================================================
 * App-facing callables — consolidated from gen-1
 *
 * v2 ports of the gen-1 functions the apps call that had no source in this repo.
 * All are now implemented: referral / chat / rating are Firestore-backed,
 * checkFlightStatus is live via AviationStack, and validateApplePayMerchant does
 * the real mutual-TLS handshake (it only needs the merchant cert provisioned).
 * ⚠️ A gen-1 version of each may still be LIVE — reconcile against the recovered
 * source (functions/recovered/README.md) before deploying, or you'll regress live
 * behaviour. All enforce auth + input validation.
 * =========================================================================== */
const FLIGHT_API_KEY = defineSecret('FLIGHT_API_KEY');
const APPLE_PAY_CERT = defineSecret('APPLE_PAY_MERCHANT_CERT'); // PEM cert
const APPLE_PAY_KEY  = defineSecret('APPLE_PAY_MERCHANT_KEY');  // PEM private key

// Non-secret Apple Pay identity (set via functions/.env). The merchant id +
// the domain the Apple Pay sheet runs on are sent in the validation request.
const APPLE_PAY_MERCHANT_ID = process.env.APPLE_PAY_MERCHANT_ID || '';
const APPLE_PAY_DISPLAY_NAME = process.env.APPLE_PAY_DISPLAY_NAME || 'ApexVIP';
const APPLE_PAY_DOMAIN = process.env.APPLE_PAY_DOMAIN || 'refayethossain28.github.io';

// Mutual-TLS POST to Apple's validationURL with the merchant identity cert/key.
// Returns Apple's merchant-session JSON verbatim (the client hands it to
// completeMerchantValidation). The caller has already verified the URL is Apple's.
function appleMerchantSession(validationURL: string, cert: string, key: string): Promise<unknown> {
  const u = new URL(validationURL);
  const payload = JSON.stringify({
    merchantIdentifier: APPLE_PAY_MERCHANT_ID,
    displayName: APPLE_PAY_DISPLAY_NAME,
    initiative: 'web',
    initiativeContext: APPLE_PAY_DOMAIN,
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'POST',
        cert,
        key,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`Apple ${res.statusCode}: ${body.slice(0, 300)}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Apple returned a non-JSON merchant session')); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Resolve a booking by its short ref ("APX-1234") OR its Firestore doc id.
async function resolveBooking(refOrId: string | undefined): Promise<FirebaseFirestore.DocumentSnapshot | null> {
  const db = admin.firestore();
  if (refOrId) {
    const byId = await db.collection('bookings').doc(String(refOrId)).get();
    if (byId.exists) return byId;
    const q = await db.collection('bookings').where('ref', '==', String(refOrId)).limit(1).get();
    if (!q.empty) return q.docs[0];
  }
  return null;
}

async function isStaff(uid: string): Promise<boolean> {
  try {
    const u = await admin.firestore().doc(`users/${uid}`).get();
    const role = u.exists && (u.data() as User | undefined)?.role;
    return role === 'admin' || role === 'driver';
  } catch (_) { return false; }
}

// generateReferralCode — returns the caller's stable referral code, minting one
// on first use and persisting it to their profile.
export const generateReferralCode = onCall({ region: 'us-central1' }, async (request: CallableRequest) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const ref = admin.firestore().doc(`users/${uid}`);
  const snap = await ref.get();
  const existing = snap.exists && (snap.data() as User | undefined)?.referralCode;
  if (existing) return { code: existing };
  // Deterministic, human-friendly code derived from the uid.
  const code = 'APX-' + uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase().padEnd(6, 'X');
  await ref.set({ referralCode: code }, { merge: true });
  return { code };
});

// applyReferralCode — credits both the new user and the referrer once. Blocks
// self-referral and double-application.
export const applyReferralCode = onCall({ region: 'us-central1' }, async (request: CallableRequest<{ code?: string }>) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const code = String((request.data || {}).code || '').trim().toUpperCase();
  if (!code) throw new HttpsError('invalid-argument', 'code is required');
  const db = admin.firestore();
  const me = db.doc(`users/${uid}`);
  const meSnap = await me.get();
  if (meSnap.exists && (meSnap.data() as User | undefined)?.referredBy) {
    throw new HttpsError('failed-precondition', 'A referral code has already been applied.');
  }
  const q = await db.collection('users').where('referralCode', '==', code).limit(1).get();
  if (q.empty) throw new HttpsError('not-found', 'That referral code is not valid.');
  const referrer = q.docs[0];
  if (referrer.id === uid) throw new HttpsError('failed-precondition', 'You cannot use your own code.');
  const CREDIT = 50;
  const inc = admin.firestore.FieldValue.increment(CREDIT);
  const at = admin.firestore.FieldValue.serverTimestamp();
  const ledger = db.collection('coin_ledger');
  await Promise.all([
    me.set({ referredBy: referrer.id, apexBalance: inc }, { merge: true }),
    referrer.ref.set({ apexBalance: inc }, { merge: true }),
    // Ledger rows so the bonus shows in both users' live transaction feeds.
    // Deterministic ids; double-application is already blocked via referredBy.
    ledger.doc(`referral_${uid}`).set({ uid, role: 'client', type: 'earn', amount: CREDIT, reason: 'Referral bonus', at }),
    ledger.doc(`referral_${uid}_referrer`).set({ uid: referrer.id, role: 'client', type: 'earn', amount: CREDIT, reason: 'Referral bonus', at }),
  ]);
  return { message: `Referral applied — you and your friend each earned ${CREDIT} APEX.`, creditsAwarded: CREDIT };
});

// sendChauffeurMessage — append a chat message to the booking thread. Only the
// booking's client, its driver, or staff may post.
export const sendChauffeurMessage = onCall({ region: 'us-central1' }, async (request: CallableRequest<{ bookingRef?: string; message?: string; fromRole?: string }>) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const d = request.data || {};
  const text = String(d.message || '').trim();
  if (!d.bookingRef || !text) throw new HttpsError('invalid-argument', 'bookingRef and message are required');
  if (text.length > 2000) throw new HttpsError('invalid-argument', 'message too long');
  const booking = await resolveBooking(d.bookingRef);
  if (!booking) throw new HttpsError('not-found', 'Booking not found');
  const b = (booking.data() as Booking) || {};
  if (b.clientId !== uid && b.driverId !== uid && !(await isStaff(uid))) {
    throw new HttpsError('permission-denied', 'Not your booking');
  }
  await booking.ref.collection('messages').add({
    senderId: uid,
    fromRole: ['client', 'driver', 'concierge'].includes(d.fromRole as string) ? d.fromRole : 'client',
    text,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

// submitTripRating — record the guest's rating on the booking and roll it into
// the driver's running average.
export const submitTripRating = onCall({ region: 'us-central1' }, async (request: CallableRequest<{ rating?: number; bookingRef?: string; comment?: string; driverId?: string }>) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const d = request.data || {};
  const rating = Math.round(Number(d.rating));
  if (!(rating >= 1 && rating <= 5)) throw new HttpsError('invalid-argument', 'rating must be 1–5');
  const booking = await resolveBooking(d.bookingRef);
  if (!booking) throw new HttpsError('not-found', 'Booking not found');
  const b = (booking.data() as Booking) || {};
  if (b.clientId !== uid && !(await isStaff(uid))) throw new HttpsError('permission-denied', 'Not your booking');
  const comment = String(d.comment || '').slice(0, 1000);
  await booking.ref.set({ rating, ratingComment: comment, ratedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const driverId = d.driverId || b.driverId;
  if (driverId) {
    // Maintain a simple running mean: ratingSum / ratingCount.
    await admin.firestore().runTransaction(async (tx) => {
      const dRef = admin.firestore().doc(`drivers/${driverId}`);
      const dSnap = await tx.get(dRef);
      const cur = dSnap.exists ? (dSnap.data() as Driver) : {} as Driver;
      const count = (Number(cur.ratingCount) || 0) + 1;
      const sum = (Number(cur.ratingSum) || 0) + rating;
      tx.set(dRef, { ratingCount: count, ratingSum: sum, rating: Math.round((sum / count) * 10) / 10 }, { merge: true });
    });
  }
  return { ok: true };
});

// checkFlightStatus — live flight status via AviationStack (swap the provider by
// changing this one function + FLIGHT_API_KEY). With the key unset it returns a
// neutral shape so the client falls back to its demo data. Public (no auth) —
// read-only and the provider key never leaves the server.
export const checkFlightStatus = onCall({ secrets: [FLIGHT_API_KEY], region: 'us-central1' }, async (request: CallableRequest<{ flight?: string }>) => {
  const flight = String((request.data || {}).flight || '').toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9]{3,8}$/.test(flight)) throw new HttpsError('invalid-argument', 'invalid flight number');
  const key = FLIGHT_API_KEY.value();
  if (!key) {
    // No provider configured yet — neutral result; client uses its own demo fallback.
    return { flight, delayed: false, delayMins: 0, available: false };
  }
  let f: any;
  try {
    const url = `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(key)}` +
      `&flight_iata=${encodeURIComponent(flight)}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`aviationstack ${res.status}`);
    const data = await res.json() as { error?: { message?: string }; data?: any[] };
    if (data && data.error) throw new Error(data.error.message || 'provider error');
    f = (data.data || [])[0];
  } catch (err) {
    logger.warn('checkFlightStatus', errMessage(err));
    // Soft-fail to neutral so the client falls back rather than erroring the UI.
    return { flight, delayed: false, delayMins: 0, available: false };
  }
  if (!f) return { flight, delayed: false, delayMins: 0, available: false };
  const dep = f.departure || {}, arr = f.arrival || {};
  const delayMins = Math.max(0, Number(dep.delay) || Number(arr.delay) || 0);
  const delayed = f.flight_status === 'delayed' || delayMins >= 15;
  return {
    flight,
    available: true,
    delayed,
    delayMins,
    origin:     dep.airport || '',
    originCity: dep.airport || dep.iata || '',
    originIata: dep.iata || '',
    terminal:   dep.terminal || '',
    belt:       arr.baggage || '',
    scheduled:  flightHHMM(dep.scheduled),
    estimated:  flightHHMM(dep.estimated || dep.scheduled),
    duration:   '',
  };
});

// validateApplePayMerchant — performs Apple Pay merchant validation server-side.
// The browser can't hold the merchant identity cert, so it sends Apple's
// validationURL here; we mutual-TLS POST to it with the cert/key and return the
// merchant session. Requires APPLE_PAY_MERCHANT_CERT / _KEY (PEM secrets) and the
// APPLE_PAY_MERCHANT_ID env; until those are provisioned it fails closed with a
// clear message and the client falls back to the card form.
export const validateApplePayMerchant = onCall(
  { secrets: [APPLE_PAY_CERT, APPLE_PAY_KEY], region: 'us-central1' },
  async (request: CallableRequest<{ validationURL?: string }>) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    const url = String((request.data || {}).validationURL || '');
    // SSRF guard: only ever POST the merchant cert to an Apple host.
    if (!/^https:\/\/[a-z0-9.-]*apple\.com\//i.test(url)) {
      throw new HttpsError('invalid-argument', 'invalid validationURL');
    }
    const cert = APPLE_PAY_CERT.value();
    const key = APPLE_PAY_KEY.value();
    if (!cert || !key) {
      throw new HttpsError('failed-precondition', 'Apple Pay merchant certificate not configured.');
    }
    if (!APPLE_PAY_MERCHANT_ID) {
      throw new HttpsError('failed-precondition', 'APPLE_PAY_MERCHANT_ID is not set.');
    }
    try {
      // Returned verbatim to the client → session.completeMerchantValidation(...).
      return await appleMerchantSession(url, cert, key);
    } catch (err) {
      logger.error('validateApplePayMerchant', errMessage(err));
      throw new HttpsError('unavailable', 'Apple Pay merchant validation failed');
    }
  }
);


// ── Dispatch ────────────────────────────────────────────────────────────────
// Turns a new booking into a driver-visible open_job. The client writes only to
// `bookings`; the driver app watches `open_jobs` (status:'open', by market) and
// claims one via a transaction. Without this bridge a booking never reaches a
// driver. Idempotent: the open_job id == the booking id.

export const onBookingCreated = onDocumentCreated('bookings/{bookingId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const b = (snap.data() as Booking) || {};

  // Only broadcast bookings that still need a driver and have a pickup.
  if (b.status && !['confirmed', 'pending', 'paid'].includes(b.status)) return;
  if (!b.pickup) return;

  const openRef = admin.firestore().collection('open_jobs').doc(event.params.bookingId);
  if ((await openRef.get()).exists) return; // already dispatched

  // Driver pay: 80% of the fare under the commission model, or the admin-set
  // split under the subscription model (matches the driver/admin UI quote).
  const pay = dispatchPay(b, await platformCommissionPct());

  await openRef.set({
    status: 'open',
    market: b.location || 'london',
    bookingDocId: event.params.bookingId,
    bookingRef: b.ref || '',
    clientId: b.clientId || '',
    clientName: b.clientName || 'Client',
    type: b.serviceType || 'airport',
    serviceLabel: b.serviceLabel || 'Airport Transfer',
    pickup: b.pickup || '',
    dropoff: b.dropoff || b.airport || '',
    date: b.date || '',
    time: b.time || 'Now',
    vehicle: b.vehicle || 'S-Class',
    flight: b.flight || '',
    notes: (b.concierge && b.concierge.instructions) || '',
    pay,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info('dispatched open_job', { booking: event.params.bookingId, market: b.location || 'london' });
});

/* ===========================================================================
 * remindExpiringDocs — daily compliance watchdog
 *
 * Scans every driver's approved documents (drivers/{id}.compliance.docs) and their
 * vehicles (vehicles where driverId == id) for expiry. Emails the driver + the ops
 * inbox at 30/14/7/3/1 days out, on the day, and weekly once expired. Also
 * recomputes drivers/{id}.compliance.compliant each day so an expired credential
 * or MOT/road-tax auto-flips the driver out of service within 24h (the apps gate
 * Go-Online + dispatch on that flag). See docs/apexvip-driver-compliance.md.
 * =========================================================================== */
const COMPLIANCE_EXPIRY_DOCS = ['licence', 'pco', 'insurance', 'dbs', 'badge']; // v5c has no expiry
const COMPLIANCE_ALL_DOCS = ['licence', 'pco', 'insurance', 'dbs', 'v5c', 'badge'];

export const remindExpiringDocs = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'Europe/London', secrets: [SENDGRID_API_KEY], region: 'us-central1' },
  async () => {
    const db = admin.firestore();
    const drivers = await db.collection('drivers').get();
    let emailed = 0, recomputed = 0;

    for (const snap of drivers.docs) {
      const d = (snap.data() as Driver) || {};
      const verdict = (d.compliance && d.compliance.docs) || {};
      const items: Array<{ label: string; dl: number }> = []; // {label, dl}

      // Credential documents.
      let docsOk = COMPLIANCE_ALL_DOCS.every((k) => verdict[k] && verdict[k].approved);
      for (const k of COMPLIANCE_EXPIRY_DOCS) {
        const a = verdict[k];
        if (!a || !a.approved) continue;
        const dl = daysUntil(a.expiresAt);
        if (dl == null || dl < 0) docsOk = false;
        if (shouldRemind(dl)) items.push({ label: k.toUpperCase(), dl: dl as number });
      }

      // Vehicles — at least one active vehicle with MOT + road tax in date.
      const vehicles = await db.collection('vehicles').where('driverId', '==', snap.id).get();
      let vehicleOk = false;
      vehicles.forEach((v) => {
        const x = (v.data() as Vehicle) || {};
        if (x.active === false) return;
        const mot = daysUntil(x.motExpiry), tax = daysUntil(x.taxExpiry);
        if (mot != null && mot >= 0 && tax != null && tax >= 0) vehicleOk = true;
        const reg = x.reg || 'vehicle';
        if (shouldRemind(mot)) items.push({ label: `${reg} MOT`, dl: mot as number });
        if (shouldRemind(tax)) items.push({ label: `${reg} road tax`, dl: tax as number });
      });

      const compliant = docsOk && vehicleOk;
      // Keep the authoritative flag fresh (drives the Go-Online / dispatch gate).
      if (d.compliance && d.compliance.compliant !== compliant) {
        await snap.ref.set({ compliance: { compliant } }, { merge: true }).catch(() => {});
        recomputed++;
      }

      if (items.length) {
        const lines = items
          .sort((a, b) => a.dl - b.dl)
          .map((i) => `• ${i.label}: ${i.dl < 0 ? `EXPIRED ${-i.dl} day(s) ago` : i.dl === 0 ? 'expires today' : `expires in ${i.dl} day(s)`}`)
          .join('\n');
        const driverEmail = d.email || '';
        const subject = 'ApexVIP — action needed: documents expiring';
        const body = `Some of your ApexVIP credentials need attention:\n\n${lines}\n\n` +
          `Please upload renewals in the driver app (Profile → Documents). Expired items take you off-duty until re-approved.`;
        try {
          await Promise.all([
            driverEmail ? sendEmail(driverEmail, subject, body) : Promise.resolve(),
            sendEmail(OPS_EMAIL, `Compliance: ${d.name || snap.id}`, `${d.name || snap.id}\n\n${lines}`),
          ]);
          emailed++;
        } catch (err) { logger.error('remindExpiringDocs email', errMessage(err)); }
      }
    }
    logger.info('remindExpiringDocs', { drivers: drivers.size, emailed, recomputed });
  }
);

/* ===========================================================================
 * Driver payouts — Stripe Connect Express (ported from fixr/app/connect.js)
 *
 * ApexVIP collects fares via Square; this is the *payout* rail to drivers. A
 * driver self-onboards a Stripe Express connected account (KYC + bank details);
 * completed trips accrue 80% to a per-driver ledger (driver_payouts, written by
 * onBookingWrite); an admin settles a driver's balance with payoutDriver.
 *
 * Funding note: a Stripe transfer draws the platform's Stripe balance. Because
 * fares are taken in Square, fund the Stripe balance (top-up / payout schedule)
 * or move charges to Stripe before relying on automatic transfers. With no
 * STRIPE_SECRET_KEY set, all three run in a mock mode so the flow is testable.
 * See docs/apexvip-driver-payouts.md.
 * =========================================================================== */

// Driver starts (or resumes) payout onboarding — returns a hosted Stripe link.
export const createDriverPayoutAccount = onCall(
  { secrets: [STRIPE_SECRET_KEY], region: 'us-central1' },
  async (request: CallableRequest) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    const uid = request.auth.uid;
    const dref = admin.firestore().doc(`drivers/${uid}`);
    const d = ((await dref.get()).data() as Driver) || {};
    const stripe = stripeClient();
    if (!stripe) {
      const accountId = (d.payout && d.payout.accountId) || ('acct_mock_' + uid.slice(0, 10));
      await dref.set({ payout: { provider: 'stripe', accountId, status: 'active', payoutsEnabled: true, mock: true } }, { merge: true });
      return { url: `${PAYOUT_RETURN_URL}?payout=mock`, accountId, mock: true };
    }
    let accountId = d.payout && d.payout.accountId;
    if (!accountId) {
      const acct = await stripe.accounts.create({
        type: 'express', business_type: 'individual',
        capabilities: { transfers: { requested: true } },
        metadata: { driverId: uid, name: d.name || '' },
      });
      accountId = acct.id;
      await dref.set({ payout: { provider: 'stripe', accountId, status: 'onboarding' } }, { merge: true });
    }
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${PAYOUT_RETURN_URL}?payout=refresh`,
      return_url: `${PAYOUT_RETURN_URL}?payout=done`,
      type: 'account_onboarding',
    });
    return { url: link.url, accountId };
  }
);

// Driver / app polls onboarding status; mirrors it onto drivers/{uid}.payout.
export const getDriverPayoutStatus = onCall(
  { secrets: [STRIPE_SECRET_KEY], region: 'us-central1' },
  async (request: CallableRequest) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    const uid = request.auth.uid;
    const dref = admin.firestore().doc(`drivers/${uid}`);
    const d = ((await dref.get()).data() as Driver) || {};
    const accountId = d.payout && d.payout.accountId;
    if (!accountId) return { onboarded: false, payoutsEnabled: false };
    const stripe = stripeClient();
    if (!stripe) return { onboarded: true, payoutsEnabled: true, mock: true };
    const acct = await stripe.accounts.retrieve(accountId);
    const payoutsEnabled = !!(acct.details_submitted && acct.payouts_enabled);
    const status = payoutsEnabled ? 'active' : (acct.details_submitted ? 'restricted' : 'onboarding');
    await dref.set({ payout: { status, detailsSubmitted: !!acct.details_submitted, payoutsEnabled } }, { merge: true });
    return { onboarded: !!acct.details_submitted, payoutsEnabled };
  }
);

// Admin settles a driver's owed balance: one Stripe transfer + mark entries paid.
export const payoutDriver = onCall(
  { secrets: [STRIPE_SECRET_KEY], region: 'us-central1' },
  async (request: CallableRequest<{ driverId?: string }>) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    if (!(await isAdminUid(request.auth.uid))) throw new HttpsError('permission-denied', 'Admin only');
    const driverId = String((request.data || {}).driverId || '');
    if (!driverId) throw new HttpsError('invalid-argument', 'driverId is required');
    const db = admin.firestore();
    const owed = await db.collection('driver_payouts').where('driverId', '==', driverId).where('status', '==', 'owed').get();
    if (owed.empty) return { paid: 0, count: 0 };
    const currency = ((owed.docs[0].data() as DriverPayout).currency || 'GBP').toLowerCase();
    const total = owed.docs.reduce((s, x) => s + (Number((x.data() as DriverPayout).amount) || 0), 0);
    const d = ((await db.doc(`drivers/${driverId}`).get()).data() as Driver) || {};
    const accountId = d.payout && d.payout.accountId;
    const stripe = stripeClient();
    let transferId: string | null = null;
    if (stripe) {
      if (!accountId || !(d.payout && d.payout.payoutsEnabled)) {
        throw new HttpsError('failed-precondition', 'Driver has not completed payout onboarding');
      }
      try {
        const tr = await stripe.transfers.create({ amount: total * 100, currency, destination: accountId, metadata: { driverId } });
        transferId = tr.id;
      } catch (err) {
        throw new HttpsError('failed-precondition', 'Stripe transfer failed: ' + errMessage(err));
      }
    }
    const batch = db.batch();
    owed.docs.forEach((x) => batch.set(x.ref, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), transferId }, { merge: true }));
    await batch.commit();
    // Append-only audit entry (server-side, can't be tampered with client-side).
    await db.collection('audit_log').add({
      ts: admin.firestore.FieldValue.serverTimestamp(),
      actorUid: request.auth.uid, actorName: 'Admin (server)',
      action: 'payout', target: driverId,
      detail: `${currency.toUpperCase()} ${total} · ${owed.size} trip(s)${stripe ? ' · ' + transferId : ' · mock'}`,
    }).catch(() => {});
    return { paid: total, count: owed.size, currency: currency.toUpperCase(), transferId, mock: !stripe };
  }
);

/* ===========================================================================
 * ApexCoin — the server-authoritative loyalty ledger
 *
 * Balances live where only the Admin SDK can write them (firestore.rules
 * blocks self-writes): clients on users/{uid}.apexBalance, drivers on
 * drivers/{uid}.apexcoin. Every movement is a row in the append-only
 * `coin_ledger`; booking-triggered awards use DETERMINISTIC ledger ids +
 * create(), so a re-fired trigger can never double-award.
 *
 * Earn:   awardBookingCoins (client, 5% of the cash portion) and the
 *         completed-trip branch of onBookingWrite (driver, 2% of their pay).
 * Redeem: redeemApexCoins (client pays with coins at checkout, transactional,
 *         clamped to their balance) and redeemDriverCoins (driver cashes out;
 *         the £ lands in driver_payouts as 'owed', settled by payoutDriver).
 *
 * The apps preview the same maths from the shared engine (src/coin/coin.ts —
 * mirrored in ./logic.ts) but the ledger here is the source of truth.
 * =========================================================================== */

/** Ledger ids embed user-supplied refs — keep them within Firestore doc-id rules. */
function coinLedgerId(...parts: string[]): string {
  return parts.join('_').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 500);
}

/**
 * Atomically append a ledger row and move the balance. `delta` defaults to
 * +amount (an earn); redemptions pass a negative delta. Returns false if the
 * deterministic ledger row already exists (already credited — a no-op).
 */
async function creditCoins(opts: {
  ledgerId: string;
  balanceRef: FirebaseFirestore.DocumentReference;
  balanceField: string;
  entry: Omit<CoinLedgerEntry, 'at'>;
  delta?: number;
}): Promise<boolean> {
  const db = admin.firestore();
  const ledgerRef = db.collection('coin_ledger').doc(opts.ledgerId);
  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ledgerRef);
      if (existing.exists) throw new Error('coin-ledger-exists');
      tx.set(ledgerRef, { ...opts.entry, at: admin.firestore.FieldValue.serverTimestamp() });
      tx.set(opts.balanceRef, { [opts.balanceField]: admin.firestore.FieldValue.increment(opts.delta ?? opts.entry.amount) }, { merge: true });
    });
    return true;
  } catch (err) {
    if (errMessage(err) === 'coin-ledger-exists') return false;
    throw err;
  }
}

// Client earn: 5% of the cash portion of every confirmed booking. Runs on the
// same document event as dispatch (onBookingCreated) but is deliberately its
// own trigger so a dispatch early-return can never skip the award.
export const awardBookingCoins = onDocumentCreated('bookings/{bookingId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const b = (snap.data() as Booking) || {};
  if (!b.clientId) return;
  if (b.status && !['confirmed', 'pending', 'paid'].includes(b.status)) return;
  const fare = Number(b.price) || 0;
  if (fare <= 0) return;
  try {
    // The cash portion = fare minus any coins redeemed against this booking.
    // The redemption callable wrote its ledger row BEFORE the booking doc, so
    // reading it here is not a race.
    const [redeemRow, userSnap, rates] = await Promise.all([
      admin.firestore().doc(`coin_ledger/${coinLedgerId('redeem', b.clientId, b.ref || event.params.bookingId)}`).get(),
      admin.firestore().doc(`users/${b.clientId}`).get(),
      platformCoinRates(),
    ]);
    const redeemed = redeemRow.exists ? Number((redeemRow.data() as CoinLedgerEntry).amount) || 0 : 0;
    // Tiered earn: the client's CURRENT tier picks the % (3/4/5/6 by default).
    const tier = apexTierForBalance((userSnap.data() as User | undefined)?.apexBalance);
    const earn = clientCoinsEarned(fare - redeemed, rates.tiers[tier]);
    if (earn <= 0) return;
    const credited = await creditCoins({
      ledgerId: coinLedgerId('earn', event.params.bookingId),
      balanceRef: admin.firestore().doc(`users/${b.clientId}`),
      balanceField: 'apexBalance',
      entry: { uid: b.clientId, role: 'client', type: 'earn', amount: earn, reason: `Trip booking · ${tier} ${rates.tiers[tier]}%`, ref: b.ref || event.params.bookingId },
    });
    if (credited) logger.info('awardBookingCoins', { booking: event.params.bookingId, earn, redeemed, tier });
  } catch (err) { logger.error('awardBookingCoins', errMessage(err)); }
});

// Client redemption — "pay with ApexCoin" at checkout. Transactional: the
// balance can never go negative, and the deterministic ledger id makes a
// retried call return the original result instead of double-deducting.
export const redeemApexCoins = onCall({ region: 'us-central1' }, async (request: CallableRequest<{ amount?: number; bookingRef?: string }>) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const d = request.data || {};
  const requested = Math.floor(Number(d.amount));
  const bookingRef = String(d.bookingRef || '').trim();
  if (!Number.isFinite(requested) || requested <= 0 || requested > 100000) {
    throw new HttpsError('invalid-argument', 'amount must be a positive number of coins');
  }
  if (!bookingRef) throw new HttpsError('invalid-argument', 'bookingRef is required');
  const db = admin.firestore();
  const ledgerRef = db.doc(`coin_ledger/${coinLedgerId('redeem', uid, bookingRef)}`);
  const userRef = db.doc(`users/${uid}`);
  return db.runTransaction(async (tx) => {
    const [prior, userSnap] = await Promise.all([tx.get(ledgerRef), tx.get(userRef)]);
    const balance = Math.max(0, Number((userSnap.data() as User | undefined)?.apexBalance) || 0);
    if (prior.exists) {
      // Idempotent retry — the coins for this booking were already applied.
      return { redeemed: Number((prior.data() as CoinLedgerEntry).amount) || 0, balance };
    }
    const redeemed = clampCoinRedemption(requested, balance);
    if (redeemed <= 0) return { redeemed: 0, balance };
    tx.set(ledgerRef, {
      uid, role: 'client', type: 'redeem', amount: redeemed, reason: 'Trip payment', ref: bookingRef,
      at: admin.firestore.FieldValue.serverTimestamp(),
    } satisfies CoinLedgerEntry);
    tx.set(userRef, { apexBalance: admin.firestore.FieldValue.increment(-redeemed) }, { merge: true });
    return { redeemed, balance: balance - redeemed };
  });
});

// Driver cash-out: zero the AXC wallet and drop the £ into driver_payouts as
// 'owed' — the SAME rail trip earnings use, so payoutDriver settles it with
// the next Stripe transfer. No more "the desk will sort it": it's in the ledger.
export const redeemDriverCoins = onCall({ region: 'us-central1' }, async (request: CallableRequest) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const db = admin.firestore();
  const driverRef = db.doc(`drivers/${uid}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(driverRef);
    if (!snap.exists) throw new HttpsError('failed-precondition', 'No driver profile');
    const balance = round2(Math.max(0, Number((snap.data() as Driver).apexcoin) || 0));
    if (balance <= 0) return { redeemed: 0, balance: 0 };
    tx.set(driverRef, { apexcoin: 0 }, { merge: true });
    tx.set(db.collection('coin_ledger').doc(), {
      uid, role: 'driver', type: 'redeem', amount: balance, reason: 'Cash redemption',
      at: admin.firestore.FieldValue.serverTimestamp(),
    } satisfies CoinLedgerEntry);
    tx.set(db.collection('driver_payouts').doc(), {
      driverId: uid, bookingRef: 'AXC redemption', amount: balance, currency: 'GBP',
      status: 'owed', source: 'axc',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    } satisfies DriverPayout);
    return { redeemed: balance, balance: 0 };
  });
});

/* ===========================================================================
 * ApexCoin recurring bonuses — the amounts the apps advertise, paid for real.
 *
 * On the 1st of each month (Europe/London): Gold members get 200 APEX,
 * Platinum 500, and drivers rated ≥4.9 over ≥5 rated trips get 10 AXC.
 * One deterministic ledger row per user per month (`monthly_{YYYY-MM}_{uid}` /
 * `ratingbonus_{YYYY-MM}_{uid}`) makes the run idempotent — re-running a
 * month is a no-op. `runCoinBonuses` lets an admin trigger the same run on
 * demand (and is how the emulator test drives it).
 * =========================================================================== */

async function awardMonthlyCoinBonuses(now: Date): Promise<{ month: string; clients: number; drivers: number }> {
  const db = admin.firestore();
  const month = bonusMonthKey(now);
  let clients = 0;
  let drivers = 0;

  // Client tier bonuses — everyone at Gold or above (balance ≥ 2000).
  const gold = await db.collection('users').where('apexBalance', '>=', 2000).get();
  for (const snap of gold.docs) {
    const bonus = monthlyBonusForBalance((snap.data() as User).apexBalance);
    if (bonus <= 0) continue;
    const tier = apexTierForBalance((snap.data() as User).apexBalance);
    const credited = await creditCoins({
      ledgerId: coinLedgerId('monthly', month, snap.id),
      balanceRef: snap.ref,
      balanceField: 'apexBalance',
      entry: { uid: snap.id, role: 'client', type: 'earn', amount: bonus, reason: `${tier} monthly bonus` },
    }).catch((err) => { logger.error('monthly client bonus', snap.id, errMessage(err)); return false; });
    if (credited) clients++;
  }

  // Top-rated driver bonus — rating ≥ 4.9 across ≥ 5 rated trips.
  const rated = await db.collection('drivers').where('rating', '>=', 4.9).get();
  for (const snap of rated.docs) {
    const d = snap.data() as Driver;
    if (!qualifiesForRatingBonus(d)) continue;
    const credited = await creditCoins({
      ledgerId: coinLedgerId('ratingbonus', month, snap.id),
      balanceRef: snap.ref,
      balanceField: 'apexcoin',
      entry: { uid: snap.id, role: 'driver', type: 'earn', amount: DRIVER_RATING_BONUS, reason: 'Top-rated driver bonus' },
    }).catch((err) => { logger.error('rating bonus', snap.id, errMessage(err)); return false; });
    if (credited) drivers++;
  }

  logger.info('awardMonthlyCoinBonuses', { month, clients, drivers });
  return { month, clients, drivers };
}

export const monthlyCoinBonuses = onSchedule(
  { schedule: '0 6 1 * *', timeZone: 'Europe/London', region: 'us-central1' },
  async () => { await awardMonthlyCoinBonuses(new Date()); },
);

// Admin-triggered run of the same month's bonuses (idempotent, so safe).
export const runCoinBonuses = onCall({ region: 'us-central1' }, async (request: CallableRequest) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  if (!(await isAdminUid(request.auth.uid))) throw new HttpsError('permission-denied', 'Admin only');
  return awardMonthlyCoinBonuses(new Date());
});

/* ===========================================================================
 * coinSupplyStats — the public transparency figures.
 *
 * Aggregated straight from the append-only coin_ledger (the source of truth,
 * unlike the apps' device-local event feeds): issued, redeemed, in-app and
 * on-chain circulation, plus the public chain config so anyone can check
 * that the AXC contract's totalSupply() equals `onchain`. No auth — it
 * exposes only totals, no per-user data. Cached per warm instance.
 * =========================================================================== */

let _supplyCache: { stats: Record<string, unknown>; at: number } | null = null;
export const coinSupplyStats = onCall({ region: 'us-central1' }, async () => {
  if (_supplyCache && Date.now() - _supplyCache.at < 300_000) return _supplyCache.stats;
  const db = admin.firestore();
  const sumOf = async (type: string): Promise<number> => {
    const agg = await db.collection('coin_ledger').where('type', '==', type)
      .aggregate({ total: admin.firestore.AggregateField.sum('amount') }).get();
    return round2(Number(agg.data().total) || 0);
  };
  const [issued, redeemed, withdrawn, deposited] = await Promise.all([
    sumOf('earn'), sumOf('redeem'), sumOf('withdraw'), sumOf('deposit'),
  ]);
  const onchain = Math.max(0, round2(withdrawn - deposited));
  let chain: Record<string, unknown> = {};
  try {
    const snap = await db.doc('settings/chain').get();
    const s = snap.exists ? (snap.data() as Record<string, unknown>) : {};
    if (s.enabled && s.contractAddress) {
      chain = { contractAddress: s.contractAddress, chainId: s.chainId || null, explorerBase: s.explorerBase || '' };
    }
  } catch { /* chain info optional */ }
  const stats = {
    issued, redeemed, onchain,
    circulating: Math.max(0, round2(issued - redeemed - onchain)),
    chain,
    at: new Date().toISOString(),
  };
  _supplyCache = { stats, at: Date.now() };
  return stats;
});
