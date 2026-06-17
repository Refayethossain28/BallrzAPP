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

// Secrets — set once with: firebase functions:secrets:set AMADEUS_CLIENT_ID
const AMADEUS_CLIENT_ID = defineSecret('AMADEUS_CLIENT_ID');
const AMADEUS_CLIENT_SECRET = defineSecret('AMADEUS_CLIENT_SECRET');

// Square — set with: firebase functions:secrets:set SQUARE_ACCESS_TOKEN
const SQUARE_ACCESS_TOKEN = defineSecret('SQUARE_ACCESS_TOKEN');

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
    const d = request.data || {};
    if (!d.sourceId || !d.idempotencyKey) {
      throw new HttpsError('invalid-argument', 'sourceId and idempotencyKey are required');
    }
    // SECURITY: in production, recompute the fare from your pricing settings using
    // d.bookingRef and ignore the client amount. The scaffold accepts it as-is.
    const amount = toMinorUnits(d.amount);
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
    const paymentId = request.data && request.data.paymentId;
    if (!paymentId) throw new HttpsError('invalid-argument', 'paymentId is required');
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
    const d = request.data || {};
    if (!d.paymentId || !d.idempotencyKey) {
      throw new HttpsError('invalid-argument', 'paymentId and idempotencyKey are required');
    }
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

const { onDocumentWritten } = require('firebase-functions/v2/firestore');

const SENDGRID_API_KEY   = defineSecret('SENDGRID_API_KEY');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN  = defineSecret('TWILIO_AUTH_TOKEN');

const NOTIFY_FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || 'concierge@apexvip.com';
const NOTIFY_FROM_NAME  = process.env.NOTIFY_FROM_NAME  || 'ApexVIP';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';

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
