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

// Lingua (language app) — set with: firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

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

const { onDocumentWritten, onDocumentCreated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

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

/* ===========================================================================
 * linguaAI — hosted Claude proxy for the Lingua language app (lingua/index.html)
 *
 * Mirrors lingua/server.mjs but as a callable Cloud Function so the *live* web
 * link can use Claude without anyone running a local proxy. The browser never
 * holds the Anthropic key — it calls this function, which forces a structured
 * tool call for Translate/Teach (deterministic JSON to render) and lets Claude
 * answer in prose for free-form Ask. If absent or erroring, the client falls
 * back to its offline starter set, so a partial deploy never breaks the UI.
 *
 * Deploy:  firebase functions:secrets:set ANTHROPIC_API_KEY
 *          firebase deploy --only functions:linguaAI
 * =========================================================================== */
const LINGUA_MODEL = process.env.LINGUA_MODEL || 'claude-opus-4-8';

const LINGUA_TRANSLATE_TOOL = {
  name: 'translation_result',
  description: 'Return a precise translation with pronunciation and useful learner notes.',
  input_schema: {
    type: 'object',
    properties: {
      translation:   { type: 'string', description: 'The translated text in the target language/dialect, in its native script.' },
      pronunciation: { type: 'string', description: 'Romanized pronunciation. Empty if the target already uses Latin script.' },
      literal:       { type: 'string', description: 'A word-for-word literal gloss when it differs interestingly; otherwise empty.' },
      register:      { type: 'string', description: "Formality/register note, e.g. 'casual', 'polite/formal', 'spoken only'." },
      notes:         { type: 'string', description: 'One short note on dialect-specific word choice, gender, or usage. Empty if nothing notable.' },
    },
    required: ['translation'],
  },
};
const LINGUA_LESSON_TOOL = {
  name: 'lesson',
  description: 'Return a short, level-appropriate, dialect-aware mini lesson on the requested topic.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      intro: { type: 'string', description: 'One or two sentences of context.' },
      items: {
        type: 'array',
        description: '5–8 example phrases/words for the topic.',
        items: {
          type: 'object',
          properties: {
            phrase:        { type: 'string', description: 'The phrase in the target language/dialect (native script).' },
            pronunciation: { type: 'string', description: 'Romanized pronunciation. Empty if Latin script.' },
            meaning:       { type: 'string', description: 'English meaning / when to use it.' },
          },
          required: ['phrase', 'meaning'],
        },
      },
      tip:         { type: 'string', description: 'One practical learning or cultural tip.' },
      dialectNote: { type: 'string', description: 'How this differs in the requested dialect vs. the standard. Empty if not applicable.' },
    },
    required: ['title', 'items'],
  },
};

function linguaTargetLabel(p) {
  return p.dialect ? `${p.targetName} (${p.dialect} dialect)` : p.targetName;
}

const LINGUA_PRACTICE_TOOL = {
  name: 'practice_set',
  description: 'Return a set of vocabulary/phrase cards for flashcard and quiz practice.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: '8–10 useful items for the requested topic & level.',
        items: {
          type: 'object',
          properties: {
            front:         { type: 'string', description: 'The English prompt / meaning to test recall from.' },
            back:          { type: 'string', description: 'The answer in the target language/dialect (native script).' },
            pronunciation: { type: 'string', description: 'Romanized pronunciation. Empty if Latin script.' },
          },
          required: ['front', 'back'],
        },
      },
    },
    required: ['items'],
  },
};
const LINGUA_CHAT_TOOL = {
  name: 'tutor_reply',
  description: 'Reply as a friendly native-speaker tutor in the target dialect, and gently correct the learner.',
  input_schema: {
    type: 'object',
    properties: {
      reply:         { type: 'string', description: "Conversational reply in the target language/dialect (native script). Short and natural for the learner's level." },
      pronunciation: { type: 'string', description: 'Romanized pronunciation of the reply. Empty if Latin script.' },
      english:       { type: 'string', description: 'A brief English gloss of the reply.' },
      correction:    { type: 'string', description: "A short, encouraging correction of the learner's last message if needed. Empty if it was fine." },
    },
    required: ['reply'],
  },
};

// Returns { sys, messages, tools, force }. Chat passes a conversation; everything
// else is a single user turn.
function linguaBuildRequest(p) {
  if (p.mode === 'translate') {
    const sys =
      'You are an expert translator and dialectologist. Translate accurately into the ' +
      'EXACT requested language and dialect, using the natural phrasing a native speaker of ' +
      'that specific variety would use (not just the standard form). Use the correct native script. ' +
      'Provide romanized pronunciation for non-Latin scripts. Be precise and never invent words.';
    const user =
      `Translate the following from ${p.sourceName} into ${linguaTargetLabel(p)}.` +
      (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '') +
      `\n\nText:\n${JSON.stringify(p.text || '')}`;
    return { sys, messages: [{ role: 'user', content: user }], tools: [LINGUA_TRANSLATE_TOOL], force: 'translation_result' };
  }
  if (p.mode === 'teach') {
    const sys =
      'You are a patient, accurate language tutor. Produce a short, practical mini-lesson ' +
      "for the requested topic, tailored to the learner's level and to the SPECIFIC dialect " +
      'requested (use that variety\'s real vocabulary and pronunciation, not only the standard). ' +
      'Use correct native script and give romanized pronunciation for non-Latin scripts.';
    const user =
      `Teach a ${p.level} learner the topic "${p.topic}" in ${linguaTargetLabel(p)}.` +
      (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '');
    return { sys, messages: [{ role: 'user', content: user }], tools: [LINGUA_LESSON_TOOL], force: 'lesson' };
  }
  if (p.mode === 'practice') {
    const sys =
      'You are a language tutor building flashcards. Produce genuinely useful, correct items ' +
      'for the SPECIFIC dialect requested, with native script and romanized pronunciation for ' +
      "non-Latin scripts. Vary the items; keep them appropriate to the learner's level.";
    const user =
      `Create a practice set of about ${p.count || 10} items on "${p.topic}" for a ${p.level} ` +
      `learner of ${linguaTargetLabel(p)}.` + (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '');
    return { sys, messages: [{ role: 'user', content: user }], tools: [LINGUA_PRACTICE_TOOL], force: 'practice_set' };
  }
  if (p.mode === 'chat') {
    const sys =
      `You are a warm, encouraging native-speaker conversation partner and tutor for a ${p.level || 'beginner'} ` +
      `learner of ${linguaTargetLabel(p)}.` + (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '') +
      " Stay in character as a friendly local. Reply in the target dialect's natural everyday speech, " +
      "kept short and simple for the learner's level. Always provide romanized pronunciation and a brief " +
      'English gloss. If the learner\'s last message has a mistake, add a short kind correction; otherwise leave it empty. ' +
      'Keep the conversation going with a simple question.';
    const history = Array.isArray(p.messages) ? p.messages : [];
    const messages = history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    if (!messages.length) messages.push({ role: 'user', content: '(Start the conversation with a friendly greeting and a simple question.)' });
    return { sys, messages, tools: [LINGUA_CHAT_TOOL], force: 'tutor_reply' };
  }
  const sys =
    'You are an expert, accurate language teacher. Answer the learner\'s question about the ' +
    'language/dialect clearly and concisely. Give examples in native script with romanized ' +
    'pronunciation where helpful. If the question is about a specific dialect, answer for that variety.';
  const user =
    `Language: ${linguaTargetLabel(p)}.` +
    (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '') +
    `\n\nQuestion: ${p.question || ''}`;
  return { sys, messages: [{ role: 'user', content: user }], tools: null, force: null };
}

async function linguaCallClaude(p, apiKey) {
  const { sys, messages, tools, force } = linguaBuildRequest(p);
  const body = {
    model: LINGUA_MODEL,
    max_tokens: 1500,
    system: sys,
    messages,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = { type: 'tool', name: force };
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const blocks = data.content || [];
  if (tools) {
    const toolUse = blocks.find((b) => b.type === 'tool_use');
    if (!toolUse) throw new Error('model returned no structured result');
    return toolUse.input || {};
  }
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { answer: text };
}

exports.linguaAI = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: 'us-central1' },
  async (request) => {
    const p = request.data || {};
    const ALLOWED = ['translate', 'teach', 'ask', 'practice', 'chat'];
    const mode = ALLOWED.indexOf(p.mode) >= 0 ? p.mode : 'translate';
    // Light input caps to bound cost/abuse on a public callable.
    if (typeof p.text === 'string' && p.text.length > 4000) {
      throw new HttpsError('invalid-argument', 'Text too long (max 4000 chars).');
    }
    if (typeof p.question === 'string' && p.question.length > 1000) {
      throw new HttpsError('invalid-argument', 'Question too long (max 1000 chars).');
    }
    if (Array.isArray(p.messages) && p.messages.length > 40) {
      p.messages = p.messages.slice(-40); // cap conversation length
    }
    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) throw new HttpsError('failed-precondition', 'ANTHROPIC_API_KEY not configured.');
    try {
      const result = await linguaCallClaude({ ...p, mode }, apiKey);
      return { ok: true, result };
    } catch (err) {
      logger.error('linguaAI', err.message);
      // Return ok:false (not a thrown error) so the client cleanly falls back offline.
      return { ok: false, error: String(err.message || err) };
    }
  }
);

/* ===========================================================================
 * Ripple server-side delivery — push, scheduled dispatch & disappearing sweep
 *
 *  • ripplePushOnMessage  — pushes a web notification the moment a message
 *    becomes deliverable: on create, OR when a scheduled message is released
 *    (scheduledAt cleared). Reads recipients' FCM tokens from the private
 *    `ripple_push/{uid}` collection via the Admin SDK and prunes dead tokens.
 *  • rippleMaintenance    — a 1-minute cron that (a) releases scheduled messages
 *    whose time has come even if the author is offline, and (b) hard-deletes
 *    expired disappearing messages so they're gone server-side, not just hidden.
 *
 * No secrets or external services — just Firebase Cloud Messaging + Firestore.
 * ======================================================================== */
// onDocumentWritten + firebase-admin are already required above (see onBookingWrite).
const { onSchedule } = require('firebase-functions/v2/scheduler');

const RIPPLE_LINK = 'https://refayethossain28.github.io/BallrzAPP/ripple/';

function ripplePreview(m) {
  if (!m) return 'New message';
  if (m.deleted) return 'Message unsent';
  if (m.type === 'image') return '📷 Photo';
  if (m.type === 'voice') return '🎤 Voice message';
  if (m.type === 'poll') return '📊 ' + ((m.meta && m.meta.question) || 'Poll');
  if (m.enc) return '🔒 New message'; // end-to-end encrypted: server can't read it
  const t = String(m.text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New message';
  return t.length > 120 ? t.slice(0, 117) + '…' : t;
}

// Push a message to every member except its sender. Loads tokens, sends, prunes.
async function sendRipplePush(db, chatId, m) {
  const chatSnap = await db.collection('ripple_chats').doc(chatId).get();
  if (!chatSnap.exists) return;
  const chat = chatSnap.data();
  const recipients = (chat.members || []).filter((uid) => uid && uid !== m.senderId);
  if (!recipients.length) return;

  const tokenOwner = {};
  await Promise.all(recipients.map(async (uid) => {
    try {
      const ps = await db.collection('ripple_push').doc(uid).get();
      const toks = (ps.exists && ps.data().fcmTokens) || [];
      toks.forEach((t) => { if (t) tokenOwner[t] = uid; });
    } catch (e) { /* skip */ }
  }));
  const tokens = Object.keys(tokenOwner);
  if (!tokens.length) return;

  const senderName = (m.meta && m.meta.fromName) || 'Someone';
  const isGroup = chat.type === 'group';
  const title = isGroup ? (chat.name || 'New message') : senderName;
  const body = (isGroup ? senderName + ': ' : '') + ripplePreview(m);

  let res;
  try {
    res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { chatId, url: RIPPLE_LINK },
      webpush: {
        fcmOptions: { link: RIPPLE_LINK },
        notification: { icon: RIPPLE_LINK + 'icon-192.png', badge: RIPPLE_LINK + 'icon-192.png', tag: chatId },
      },
    });
  } catch (err) {
    logger.error('sendRipplePush', err.message);
    return;
  }

  const dead = {};
  res.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/invalid-argument') {
      const uid = tokenOwner[tokens[i]];
      (dead[uid] = dead[uid] || []).push(tokens[i]);
    }
  });
  await Promise.all(Object.keys(dead).map((uid) =>
    db.collection('ripple_push').doc(uid).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead[uid]),
    }).catch(() => {})
  ));
  logger.info('ripplePush', { chatId, sent: res.successCount, failed: res.failureCount });
}

const isPendingAt = (m, t) => !!(m && m.scheduledAt && m.scheduledAt > t);

exports.ripplePushOnMessage = onDocumentWritten(
  { document: 'ripple_chats/{chatId}/messages/{messageId}', region: 'us-central1' },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after || after.type === 'system') return; // deleted or system → no push

    const t = Date.now();
    const becameDeliverable =
      (!before && !isPendingAt(after, t)) ||                 // freshly created & due
      (before && isPendingAt(before, t) && !isPendingAt(after, t)); // scheduled → released
    if (!becameDeliverable) return; // edits, reactions, read receipts, etc.

    await sendRipplePush(admin.firestore(), event.params.chatId, after);
  }
);

exports.rippleMaintenance = onSchedule(
  { schedule: 'every 1 minutes', region: 'us-central1' },
  async () => {
    const db = admin.firestore();
    const now = Date.now();

    // (a) Release scheduled messages whose time has come (author may be offline).
    // Clearing scheduledAt makes them deliverable; the onWritten trigger above
    // then fires the push.
    try {
      const due = await db.collectionGroup('messages')
        .where('scheduledAt', '<=', now).limit(450).get();
      const batch = db.batch();
      let n = 0;
      due.forEach((doc) => {
        const m = doc.data();
        if (!m.scheduledAt) return;
        batch.update(doc.ref, { scheduledAt: null, state: 'delivered', ts: now });
        n++;
      });
      if (n) { await batch.commit(); logger.info('rippleMaintenance released', n); }
    } catch (err) { logger.warn('rippleMaintenance release', err.message); }

    // (b) Hard-delete disappearing messages whose expireAt has passed, so they
    // truly vanish server-side (clients already hide them locally).
    try {
      const gone = await db.collectionGroup('messages')
        .where('expireAt', '<=', now).limit(450).get();
      const batch = db.batch();
      let n = 0;
      gone.forEach((doc) => {
        const m = doc.data();
        if (!m.expireAt) return;
        batch.delete(doc.ref);
        n++;
      });
      if (n) { await batch.commit(); logger.info('rippleMaintenance swept', n); }
    } catch (err) { logger.warn('rippleMaintenance sweep', err.message); }
  }
);

/* ===========================================================================
 * ripplePushOnCall — ring the callee on a new incoming WebRTC call, even when
 * their app is closed. High-urgency web push to the callee's FCM tokens; tapping
 * it opens Ripple, which picks up the still-ringing call via its live listener.
 * ======================================================================== */
exports.ripplePushOnCall = onDocumentCreated(
  { document: 'ripple_calls/{callId}', region: 'us-central1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const c = snap.data();
    if (!c || c.status !== 'ringing' || !c.callee) return;

    const db = admin.firestore();
    let tokens = [];
    try {
      const ps = await db.collection('ripple_push').doc(c.callee).get();
      tokens = (ps.exists && ps.data().fcmTokens) || [];
    } catch (e) { return; }
    if (!tokens.length) return;

    const title = c.video ? '📹 Incoming video call' : '📞 Incoming call';
    const body = (c.callerName || 'Someone') + ' is calling…';
    let res;
    try {
      res = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: { type: 'call', callId: event.params.callId, url: RIPPLE_LINK },
        webpush: {
          headers: { Urgency: 'high', TTL: '40' },
          fcmOptions: { link: RIPPLE_LINK },
          notification: {
            icon: RIPPLE_LINK + 'icon-192.png', badge: RIPPLE_LINK + 'icon-192.png',
            tag: 'call-' + event.params.callId, requireInteraction: true,
            vibrate: [300, 200, 300, 200, 300],
          },
        },
      });
    } catch (err) { logger.error('ripplePushOnCall', err.message); return; }

    // prune permanently-invalid tokens
    const dead = [];
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument') dead.push(tokens[i]);
    });
    if (dead.length) {
      await db.collection('ripple_push').doc(c.callee)
        .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) }).catch(() => {});
    }
    logger.info('ripplePushOnCall', { callId: event.params.callId, sent: res.successCount });
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

  // Driver pay ≈ 70% of the pre-VAT fare (tune to your commercials).
  const pay = Math.round((Number(b.baseFare) || Number(b.price) || 95) * 0.7);

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
