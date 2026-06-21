/**
 * ApexVIP Cloud Functions — getHotelRates
 *
 * Live hotel pricing for the client app (`apexvip-client.html`). The browser must
 * never hold the Amadeus secret, so the client calls this callable function, which
 * proxies Amadeus server-side and returns a quote in the exact shape the client's
 * `fetchHotelRate()` expects. If this function is absent or errors, the client
 * silently falls back to its local estimate — so a partial deploy never breaks the UI.
 *
 * Firebase Functions v2 (2nd gen). Node 20 provides a global `fetch`.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const Anthropic = require('@anthropic-ai/sdk');

// Anthropic client, memoized per warm instance (keyed by the resolved secret).
// Powers parseBookingIntent (ApexAI concierge).
let _anthropic = null, _anthropicKey = null;
function anthropicClient(apiKey) {
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

// Stripe Connect — driver payouts. Set with: firebase functions:secrets:set STRIPE_SECRET_KEY
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
// Where Stripe returns the driver after onboarding (their app).
const PAYOUT_RETURN_URL = process.env.PAYOUT_RETURN_URL || 'https://refayethossain28.github.io/BallrzAPP/apexvip-driver.html';
// Lazy Stripe client (null when no key → callers fall back to a mock flow).
let _stripe = null, _stripeKey = null;
function stripeClient() {
  const k = STRIPE_SECRET_KEY.value();
  if (!k) return null;
  if (!_stripe || _stripeKey !== k) { _stripe = require('stripe')(k); _stripeKey = k; }
  return _stripe;
}
async function isAdminUid(uid) {
  try { const u = await require('firebase-admin').firestore().doc(`users/${uid}`).get(); return u.exists && (u.data() || {}).role === 'admin'; }
  catch (_) { return false; }
}

// Test by default (free, limited inventory). For production set AMADEUS_HOST to
// https://api.amadeus.com via a functions/.env file or --set-env-vars.
const AMADEUS_HOST = process.env.AMADEUS_HOST || 'https://test.api.amadeus.com';

// In-memory OAuth2 token cache (per warm instance)
let _token = null; // { value, expiresAt }

async function getToken(clientId, clientSecret) {
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
  const data = await res.json();
  _token = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 1799) * 1000,
  };
  return _token.value;
}

function isoPlusDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const round5 = (x) => Math.round(x / 5) * 5;

exports.getHotelRates = onCall(
  { secrets: [AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET], region: 'us-central1' },
  async (request) => {
    const { name, lat, lng, checkIn, nights = 1, guests = 2, currency = 'GBP' } =
      request.data || {};

    if (lat == null || lng == null || !checkIn) {
      throw new HttpsError('invalid-argument', 'lat, lng and checkIn are required');
    }

    const nightCount = Math.max(1, Math.min(14, Number(nights) || 1));
    const adults = Math.max(1, Math.min(9, Number(guests) || 2));
    const checkOut = isoPlusDays(checkIn, nightCount);

    let token;
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
    let hotelIds = [];
    try {
      const geoRes = await fetch(geoUrl, { headers: auth });
      if (geoRes.ok) {
        const geo = await geoRes.json();
        hotelIds = (geo.data || []).slice(0, 8).map((h) => h.hotelId).filter(Boolean);
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

    let offers = [];
    try {
      const offRes = await fetch(offUrl, { headers: auth });
      if (offRes.ok) {
        const off = await offRes.json();
        for (const entry of off.data || []) {
          for (const o of entry.offers || []) {
            const total = parseFloat(o.price && o.price.total);
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
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

// Plausible-fare bounds derived from settings/pricing. We can't always recompute
// the exact fare here (point-to-point fares depend on live route data the client
// holds), so we read the operator's pricing and reject any charge that falls
// outside a sane floor/ceiling — defeating amount tampering and runaway charges.
async function fareBounds() {
  let p = {};
  try {
    const snap = await admin.firestore().doc('settings/pricing').get();
    if (snap.exists) p = snap.data() || {};
  } catch (_) { /* settings unreadable → fall back to defaults below */ }
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const minFare = Math.min(num(p.min_fare_s, 38), num(p.min_fare_v, 50));
  const dayV    = num(p.day_v, 550);
  const hourlyV = num(p.hourly_v_rate, 75);
  const peak    = 1 + num(p.peak_surcharge_pct, 15) / 100;
  // Ceiling: the most expensive realistic single booking — a full day or a long
  // hourly hire at peak, plus generous headroom for multi-day/multi-stop trips.
  const ceiling = Math.max(dayV, hourlyV * 12) * peak * 3 + 500;
  const floor   = Math.max(5, Math.floor(minFare * 0.5));
  return { floor, ceiling };
}

// Confirm the caller owns (or is staff for) the booking tied to a Square payment.
// Used by capture/refund, which act on money already authorized against a booking.
async function assertPaymentOwnership(uid, paymentId) {
  const db = admin.firestore();
  // Staff (admin/driver) may capture/refund any booking.
  try {
    const u = await db.doc(`users/${uid}`).get();
    const role = u.exists && (u.data() || {}).role;
    if (role === 'admin' || role === 'driver') return;
  } catch (_) { /* fall through to ownership check */ }
  const q = await db.collection('bookings').where('squarePaymentId', '==', paymentId).limit(1).get();
  if (q.empty) throw new HttpsError('not-found', 'No booking matches this payment');
  if ((q.docs[0].data() || {}).clientId !== uid) {
    throw new HttpsError('permission-denied', 'You do not own this payment');
  }
}

async function squareFetch(path, body, token) {
  const res = await fetch(`${SQUARE_HOST}/v2${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Square-Version': SQUARE_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.errors && data.errors.map(e => e.detail || e.code).join('; ')) || `Square ${res.status}`;
    const err = new Error(msg); err.squareStatus = res.status; err.squareErrors = data.errors; throw err;
  }
  return data;
}

function toMinorUnits(amount) {
  const n = Math.round(Number(amount) * 100);
  if (!Number.isFinite(n) || n <= 0) throw new HttpsError('invalid-argument', 'Invalid amount');
  return n;
}

// Authorize (pre-auth) a payment. Capture later with captureSquarePayment.
exports.processSquarePayment = onCall(
  { secrets: [SQUARE_ACCESS_TOKEN], region: 'us-central1' },
  async (request) => {
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
      logger.error('processSquarePayment', err.message, err.squareErrors || '');
      throw new HttpsError(err.squareStatus === 402 ? 'failed-precondition' : 'unavailable', err.message);
    }
  }
);

// Capture a previously authorized payment when the trip completes.
exports.captureSquarePayment = onCall(
  { secrets: [SQUARE_ACCESS_TOKEN], region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    const paymentId = request.data && request.data.paymentId;
    if (!paymentId) throw new HttpsError('invalid-argument', 'paymentId is required');
    await assertPaymentOwnership(request.auth.uid, paymentId);
    try {
      const out = await squareFetch(`/payments/${encodeURIComponent(paymentId)}/complete`, {}, SQUARE_ACCESS_TOKEN.value());
      return { paymentId, status: (out.payment && out.payment.status) || 'COMPLETED' };
    } catch (err) {
      logger.error('captureSquarePayment', err.message);
      throw new HttpsError('unavailable', err.message);
    }
  }
);

// Refund a captured payment (full or partial) per the cancellation policy.
exports.refundSquarePayment = onCall(
  { secrets: [SQUARE_ACCESS_TOKEN], region: 'us-central1' },
  async (request) => {
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
      logger.error('refundSquarePayment', err.message);
      throw new HttpsError('unavailable', err.message);
    }
  }
);

// ── Booking-lifecycle notifications ─────────────────────────────────────────
// Firestore-triggered: emails (SendGrid) and texts (Twilio) the client as their
// booking moves through its lifecycle. Providers are called directly via fetch.
// All credentials are secrets; if a provider isn't configured it's skipped, so a
// partial setup never errors. Set the non-secret from-address/number via env.

const { onDocumentWritten, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');

const SENDGRID_API_KEY   = defineSecret('SENDGRID_API_KEY');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN  = defineSecret('TWILIO_AUTH_TOKEN');

const NOTIFY_FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || 'concierge@apexvip.com';
const NOTIFY_FROM_NAME  = process.env.NOTIFY_FROM_NAME  || 'ApexVIP';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const OPS_EMAIL = process.env.OPS_EMAIL || NOTIFY_FROM_EMAIL; // fleet/compliance inbox

async function sendEmail(to, subject, text) {
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

async function sendSms(to, body) {
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

// Decide which lifecycle message (if any) this write represents.
function bookingEvent(before, after) {
  if (!after) return null;                                   // deleted
  if (!before) return 'received';                            // newly created
  if (before.status !== after.status) {
    switch (after.status) {
      case 'confirmed':       return 'confirmed';
      case 'driver_assigned': return 'driver_assigned';
      case 'en_route':
      case 'arriving':        return 'en_route';
      case 'completed':       return 'completed';
      case 'cancelled':       return 'cancelled';
      default: return null;
    }
  }
  if (!before.driverName && after.driverName) return 'driver_assigned';
  return null;
}

function bookingMessage(event, b) {
  const ref = b.ref || b.bookingRef || '';
  const route = [b.pickup, b.dropoff || b.airport].filter(Boolean).join(' → ');
  const when = [b.date, b.time].filter(Boolean).join(' ');
  const M = {
    received:        ['We\'ve received your booking', `Thank you — we've received your ApexVIP booking ${ref}. ${route}${when ? ' · ' + when : ''}. We'll confirm your chauffeur shortly.`],
    confirmed:       ['Your booking is confirmed', `Your ApexVIP journey ${ref} is confirmed. ${route}${when ? ' · ' + when : ''}.`],
    driver_assigned: ['Your chauffeur is assigned', `${b.driverName || 'Your chauffeur'} will be looking after you for booking ${ref}${b.vehicle ? ' in a ' + b.vehicle : ''}.`],
    en_route:        ['Your chauffeur is on the way', `Your ApexVIP chauffeur is en route for booking ${ref}. ${route}.`],
    completed:       ['Thank you for travelling with ApexVIP', `Your journey ${ref} is complete. A receipt is available in the app. We hope to welcome you again soon.`],
    cancelled:       ['Your booking has been cancelled', `Your ApexVIP booking ${ref} has been cancelled. Any eligible refund will follow per our cancellation policy.`],
  };
  return M[event] || null;
}

exports.onBookingWrite = onDocumentWritten(
  { document: 'bookings/{bookingId}', secrets: [SENDGRID_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN], region: 'us-central1' },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const after  = event.data && event.data.after  && event.data.after.exists  ? event.data.after.data()  : null;
    const kind = bookingEvent(before, after);
    if (!kind) return;
    // On completion, record the driver's 80% earning to the payout ledger
    // (idempotent — one entry per booking). Settled later via payoutDriver.
    if (kind === 'completed' && after && after.driverId) {
      try {
        const amount = Math.round((Number(after.baseFare) || Number(after.price) || 0) * 0.8);
        if (amount > 0) {
          await admin.firestore().collection('driver_payouts').doc(event.params.bookingId).set({
            driverId: after.driverId,
            bookingRef: after.ref || event.params.bookingId,
            amount, currency: after.currency || 'GBP',
            status: 'owed',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      } catch (err) { logger.error('payout ledger', err.message); }
    }
    const msg = bookingMessage(kind, after);
    if (!msg) return;
    const [subject, text] = msg;
    const email = after.clientEmail || after.email || '';
    const phone = after.clientPhone || after.phone || '';
    try {
      await Promise.all([ sendEmail(email, subject, text), sendSms(phone, `ApexVIP: ${text}`) ]);
      logger.info('booking notification sent', { kind, ref: after.ref || event.params.bookingId });
    } catch (err) {
      logger.error('onBookingWrite', err.message);
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

const APEXAI_INTENT_TOOL = {
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

async function apexCallClaude({ message, history, trips, now, mode, context }, apiKey) {
  const today = (typeof now === 'string' && now) || new Date().toISOString();

  if (mode === 'driver') {
    const sys =
      'You are ApexAI, the in-app assistant for an ApexVIP chauffeur driver. Be concise, ' +
      'practical and supportive — help with their jobs, earnings, schedule, going on/offline, ' +
      'navigation tips and app questions. Plain text only, a few sentences at most.' +
      (context ? ` Driver context: ${JSON.stringify(context).slice(0, 600)}.` : '');
    const body = {
      model: APEXAI_MODEL,
      max_tokens: 400,
      system: sys,
      messages: [{ role: 'user', content: String(message || '').slice(0, 1000) }],
    };
    const data = await anthropicMessages(body, apiKey);
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { reply: text || 'How can I help with your next job?' };
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

  const turns = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content }));
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

  const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('model returned no structured result');
  return toolUse.input || {};
}

async function anthropicMessages(body, apiKey) {
  return anthropicClient(apiKey).messages.create(body);
}

exports.parseBookingIntent = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: 'us-central1' },
  async (request) => {
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
      logger.error('parseBookingIntent', err.message);
      // Throw so the client cleanly falls back to its on-device parser.
      throw new HttpsError('unavailable', String(err.message || err));
    }
  }
);

/* ===========================================================================
 * App-facing callables — CONSOLIDATION STUBS
 *
 * v2 ports of the gen-1 functions the apps call that had no source in this repo.
 * The referral / chat / rating ones are working Firestore implementations; the
 * flight-status and Apple-Pay ones need an external provider/cert and are honest
 * stubs (TODO). ⚠️ A gen-1 version of each is currently LIVE — reconcile against
 * the recovered source (functions/recovered/README.md) before deploying any of
 * these, or you'll regress live behaviour. All enforce auth + input validation.
 * =========================================================================== */
const FLIGHT_API_KEY = defineSecret('FLIGHT_API_KEY');
const APPLE_PAY_CERT = defineSecret('APPLE_PAY_MERCHANT_CERT'); // PEM cert
const APPLE_PAY_KEY  = defineSecret('APPLE_PAY_MERCHANT_KEY');  // PEM private key

// Resolve a booking by its short ref ("APX-1234") OR its Firestore doc id.
async function resolveBooking(refOrId) {
  const db = admin.firestore();
  if (refOrId) {
    const byId = await db.collection('bookings').doc(String(refOrId)).get();
    if (byId.exists) return byId;
    const q = await db.collection('bookings').where('ref', '==', String(refOrId)).limit(1).get();
    if (!q.empty) return q.docs[0];
  }
  return null;
}

async function isStaff(uid) {
  try {
    const u = await admin.firestore().doc(`users/${uid}`).get();
    const role = u.exists && (u.data() || {}).role;
    return role === 'admin' || role === 'driver';
  } catch (_) { return false; }
}

// generateReferralCode — returns the caller's stable referral code, minting one
// on first use and persisting it to their profile.
exports.generateReferralCode = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const ref = admin.firestore().doc(`users/${uid}`);
  const snap = await ref.get();
  const existing = snap.exists && (snap.data() || {}).referralCode;
  if (existing) return { code: existing };
  // Deterministic, human-friendly code derived from the uid.
  const code = 'APX-' + uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase().padEnd(6, 'X');
  await ref.set({ referralCode: code }, { merge: true });
  return { code };
});

// applyReferralCode — credits both the new user and the referrer once. Blocks
// self-referral and double-application.
exports.applyReferralCode = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const code = String((request.data || {}).code || '').trim().toUpperCase();
  if (!code) throw new HttpsError('invalid-argument', 'code is required');
  const db = admin.firestore();
  const me = db.doc(`users/${uid}`);
  const meSnap = await me.get();
  if (meSnap.exists && (meSnap.data() || {}).referredBy) {
    throw new HttpsError('failed-precondition', 'A referral code has already been applied.');
  }
  const q = await db.collection('users').where('referralCode', '==', code).limit(1).get();
  if (q.empty) throw new HttpsError('not-found', 'That referral code is not valid.');
  const referrer = q.docs[0];
  if (referrer.id === uid) throw new HttpsError('failed-precondition', 'You cannot use your own code.');
  const CREDIT = 50;
  const inc = admin.firestore.FieldValue.increment(CREDIT);
  await Promise.all([
    me.set({ referredBy: referrer.id, apexBalance: inc }, { merge: true }),
    referrer.ref.set({ apexBalance: inc }, { merge: true }),
  ]);
  return { message: `Referral applied — you and your friend each earned ${CREDIT} APEX.`, creditsAwarded: CREDIT };
});

// sendChauffeurMessage — append a chat message to the booking thread. Only the
// booking's client, its driver, or staff may post.
exports.sendChauffeurMessage = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const d = request.data || {};
  const text = String(d.message || '').trim();
  if (!d.bookingRef || !text) throw new HttpsError('invalid-argument', 'bookingRef and message are required');
  if (text.length > 2000) throw new HttpsError('invalid-argument', 'message too long');
  const booking = await resolveBooking(d.bookingRef);
  if (!booking) throw new HttpsError('not-found', 'Booking not found');
  const b = booking.data() || {};
  if (b.clientId !== uid && b.driverId !== uid && !(await isStaff(uid))) {
    throw new HttpsError('permission-denied', 'Not your booking');
  }
  await booking.ref.collection('messages').add({
    senderId: uid,
    fromRole: ['client', 'driver', 'concierge'].includes(d.fromRole) ? d.fromRole : 'client',
    text,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

// submitTripRating — record the guest's rating on the booking and roll it into
// the driver's running average.
exports.submitTripRating = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const d = request.data || {};
  const rating = Math.round(Number(d.rating));
  if (!(rating >= 1 && rating <= 5)) throw new HttpsError('invalid-argument', 'rating must be 1–5');
  const booking = await resolveBooking(d.bookingRef);
  if (!booking) throw new HttpsError('not-found', 'Booking not found');
  const b = booking.data() || {};
  if (b.clientId !== uid && !(await isStaff(uid))) throw new HttpsError('permission-denied', 'Not your booking');
  const comment = String(d.comment || '').slice(0, 1000);
  await booking.ref.set({ rating, ratingComment: comment, ratedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const driverId = d.driverId || b.driverId;
  if (driverId) {
    // Maintain a simple running mean: ratingSum / ratingCount.
    await admin.firestore().runTransaction(async (tx) => {
      const dRef = admin.firestore().doc(`drivers/${driverId}`);
      const dSnap = await tx.get(dRef);
      const cur = dSnap.exists ? (dSnap.data() || {}) : {};
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
const flightHHMM = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : '');
exports.checkFlightStatus = onCall({ secrets: [FLIGHT_API_KEY], region: 'us-central1' }, async (request) => {
  const flight = String((request.data || {}).flight || '').toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9]{3,8}$/.test(flight)) throw new HttpsError('invalid-argument', 'invalid flight number');
  const key = FLIGHT_API_KEY.value();
  if (!key) {
    // No provider configured yet — neutral result; client uses its own demo fallback.
    return { flight, delayed: false, delayMins: 0, available: false };
  }
  let f;
  try {
    const url = `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(key)}` +
      `&flight_iata=${encodeURIComponent(flight)}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`aviationstack ${res.status}`);
    const data = await res.json();
    if (data && data.error) throw new Error(data.error.message || 'provider error');
    f = (data.data || [])[0];
  } catch (err) {
    logger.warn('checkFlightStatus', err.message);
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

// validateApplePayMerchant — STUB. Apple Pay on the web requires POSTing to the
// session's validationURL with the merchant identity certificate. That cert/key
// must be provisioned (APPLE_PAY_MERCHANT_CERT / _KEY) before this can run.
// The client aborts the Apple Pay sheet on failure, so throwing here is safe.
exports.validateApplePayMerchant = onCall(
  { secrets: [APPLE_PAY_CERT, APPLE_PAY_KEY], region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    const url = String((request.data || {}).validationURL || '');
    if (!/^https:\/\/[a-z0-9.-]*apple\.com\//i.test(url)) {
      throw new HttpsError('invalid-argument', 'invalid validationURL');
    }
    if (!APPLE_PAY_CERT.value() || !APPLE_PAY_KEY.value()) {
      throw new HttpsError('failed-precondition', 'Apple Pay merchant certificate not configured.');
    }
    // TODO: mutual-TLS POST to `url` with the merchant cert/key and return Apple's
    // merchant session JSON verbatim (the client passes it to completeMerchantValidation).
    throw new HttpsError('unimplemented', 'Apple Pay merchant validation not yet wired — see functions/recovered/README.md');
  }
);


// ── Dispatch ────────────────────────────────────────────────────────────────
// Turns a new booking into a driver-visible open_job. The client writes only to
// `bookings`; the driver app watches `open_jobs` (status:'open', by market) and
// claims one via a transaction. Without this bridge a booking never reaches a
// driver. Idempotent: the open_job id == the booking id.

exports.onBookingCreated = onDocumentCreated('bookings/{bookingId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const b = snap.data() || {};

  // Only broadcast bookings that still need a driver and have a pickup.
  if (b.status && !['confirmed', 'pending', 'paid'].includes(b.status)) return;
  if (!b.pickup) return;

  const openRef = admin.firestore().collection('open_jobs').doc(event.params.bookingId);
  if ((await openRef.get()).exists) return; // already dispatched

  // Driver pay = 80% of the fare (matches the rate quoted in the driver/admin UI).
  const pay = Math.round((Number(b.baseFare) || Number(b.price) || 95) * 0.8);

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
const REMIND_DAYS = new Set([30, 14, 7, 3, 1, 0]);

function daysUntil(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d)) return null;
  const now = new Date(); now.setUTCHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}
// True when today is a reminder milestone for this many days-left.
const shouldRemind = (dl) => dl != null && (REMIND_DAYS.has(dl) || (dl < 0 && dl % 7 === 0));

exports.remindExpiringDocs = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'Europe/London', secrets: [SENDGRID_API_KEY], region: 'us-central1' },
  async () => {
    const db = admin.firestore();
    const drivers = await db.collection('drivers').get();
    let emailed = 0, recomputed = 0;

    for (const snap of drivers.docs) {
      const d = snap.data() || {};
      const verdict = (d.compliance && d.compliance.docs) || {};
      const items = []; // {label, dl}

      // Credential documents.
      let docsOk = COMPLIANCE_ALL_DOCS.every((k) => verdict[k] && verdict[k].approved);
      for (const k of COMPLIANCE_EXPIRY_DOCS) {
        const a = verdict[k];
        if (!a || !a.approved) continue;
        const dl = daysUntil(a.expiresAt);
        if (dl == null || dl < 0) docsOk = false;
        if (shouldRemind(dl)) items.push({ label: k.toUpperCase(), dl });
      }

      // Vehicles — at least one active vehicle with MOT + road tax in date.
      const vehicles = await db.collection('vehicles').where('driverId', '==', snap.id).get();
      let vehicleOk = false;
      vehicles.forEach((v) => {
        const x = v.data() || {};
        if (x.active === false) return;
        const mot = daysUntil(x.motExpiry), tax = daysUntil(x.taxExpiry);
        if (mot != null && mot >= 0 && tax != null && tax >= 0) vehicleOk = true;
        const reg = x.reg || 'vehicle';
        if (shouldRemind(mot)) items.push({ label: `${reg} MOT`, dl: mot });
        if (shouldRemind(tax)) items.push({ label: `${reg} road tax`, dl: tax });
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
        } catch (err) { logger.error('remindExpiringDocs email', err.message); }
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
exports.createDriverPayoutAccount = onCall(
  { secrets: [STRIPE_SECRET_KEY], region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    const uid = request.auth.uid;
    const dref = admin.firestore().doc(`drivers/${uid}`);
    const d = (await dref.get()).data() || {};
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
exports.getDriverPayoutStatus = onCall(
  { secrets: [STRIPE_SECRET_KEY], region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    const uid = request.auth.uid;
    const dref = admin.firestore().doc(`drivers/${uid}`);
    const d = (await dref.get()).data() || {};
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
exports.payoutDriver = onCall(
  { secrets: [STRIPE_SECRET_KEY], region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    if (!(await isAdminUid(request.auth.uid))) throw new HttpsError('permission-denied', 'Admin only');
    const driverId = String((request.data || {}).driverId || '');
    if (!driverId) throw new HttpsError('invalid-argument', 'driverId is required');
    const db = admin.firestore();
    const owed = await db.collection('driver_payouts').where('driverId', '==', driverId).where('status', '==', 'owed').get();
    if (owed.empty) return { paid: 0, count: 0 };
    const currency = (owed.docs[0].data().currency || 'GBP').toLowerCase();
    const total = owed.docs.reduce((s, x) => s + (Number(x.data().amount) || 0), 0);
    const d = (await db.doc(`drivers/${driverId}`).get()).data() || {};
    const accountId = d.payout && d.payout.accountId;
    const stripe = stripeClient();
    let transferId = null;
    if (stripe) {
      if (!accountId || !(d.payout && d.payout.payoutsEnabled)) {
        throw new HttpsError('failed-precondition', 'Driver has not completed payout onboarding');
      }
      try {
        const tr = await stripe.transfers.create({ amount: total * 100, currency, destination: accountId, metadata: { driverId } });
        transferId = tr.id;
      } catch (err) {
        throw new HttpsError('failed-precondition', 'Stripe transfer failed: ' + err.message);
      }
    }
    const batch = db.batch();
    owed.docs.forEach((x) => batch.set(x.ref, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), transferId }, { merge: true }));
    await batch.commit();
    return { paid: total, count: owed.size, currency: currency.toUpperCase(), transferId, mock: !stripe };
  }
);
