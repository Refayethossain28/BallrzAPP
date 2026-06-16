const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { ApiError, SquareClient: Client, SquareEnvironment: Environment } = require('square');

admin.initializeApp();
const db = admin.firestore();

const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: Environment.Production,
});

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' },
});

function twilioClient() {
  const sid = process.env.TWILIO_SID, auth = process.env.TWILIO_AUTH;
  if (!sid || !auth) return null;
  return require('twilio')(sid, auth);
}

const AVIATION_KEY = process.env.AVIATION_KEY || '';

async function sendPushNotification(uid, title, body, data = {}) {
  try {
    const tokenDoc = await db.collection('fcm_tokens').doc(uid).get();
    if (!tokenDoc.exists) return;
    const token = tokenDoc.data().token;
    if (!token) return;
    await admin.messaging().send({
      token,
      notification: { title, body },
      data: { ...Object.fromEntries(Object.entries(data).map(([k,v])=>[k,String(v)])) },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });
  } catch(e) {
    console.warn('Push notification failed:', e.message);
  }
}

async function isAdminUser(uid) {
  try {
    const doc = await db.collection('users').doc(uid).get();
    return doc.exists && doc.data().role === 'admin';
  } catch { return false; }
}

// ── 1. processSquarePayment ────────────────────────────────────────────────
exports.processSquarePayment = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { sourceId, amount, bookingRef } = request.data;
  if (!sourceId || !amount || !bookingRef)
    throw new HttpsError('invalid-argument', 'Missing required fields');

  try {
    const { result } = await squareClient.payments.create({
      sourceId,
      // Stable key: same bookingRef + uid always maps to one payment attempt
      idempotencyKey: `${bookingRef}-${request.auth.uid}`,
      amountMoney: { amount: Math.round(amount * 100), currency: 'GBP' },
      locationId: '1ZX0F29TX12HB',
      note: `ApexVIP Booking ${bookingRef}`,
    });
    const payment = result.payment;
    const snap = await db.collection('bookings').where('ref', '==', bookingRef).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.update({
        squarePaymentId: payment.id, paymentStatus: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    return { success: true, paymentId: payment.id };
  } catch (err) {
    const msg = err instanceof ApiError ? (err.errors?.[0]?.detail || err.message) : err.message;
    throw new HttpsError('internal', msg);
  }
});

// ── 2. processCheckoutPayment ──────────────────────────────────────────────
exports.processCheckoutPayment = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { token, amount, currency, bookingRef } = request.data;
  if (!token || !amount || !bookingRef)
    throw new HttpsError('invalid-argument', 'Missing fields');

  const secretKey = process.env.CHECKOUT_SECRET_KEY;
  if (!secretKey) {
    await db.collection('pending_payments').add({
      token, amount, currency: currency || 'AED', bookingRef,
      gateway: 'checkout.com', status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true, paymentId: null, queued: true };
  }

  const fetch = require('node-fetch');
  const resp = await fetch('https://api.checkout.com/payments', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: { type: 'token', token },
      amount: Math.round(amount * 100),
      currency: currency || 'AED',
      reference: bookingRef,
      description: `ApexVIP Dubai ${bookingRef}`,
    }),
  });
  const result = await resp.json();
  if (!resp.ok) throw new HttpsError('internal', result.error_codes?.join(', ') || 'Payment failed');

  const bSnap = await db.collection('bookings').where('ref', '==', bookingRef).limit(1).get();
  if (!bSnap.empty) {
    await bSnap.docs[0].ref.update({
      checkoutPaymentId: result.id,
      paymentStatus: result.status === 'Authorized' ? 'paid' : result.status,
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return { success: true, paymentId: result.id };
});

// ── 3. onBookingCreated ────────────────────────────────────────────────────
exports.onBookingCreated = onDocumentCreated('bookings/{bookingId}', async (event) => {
  const snap = event.data;
  if (!snap) return null;
  const b = snap.data();
  const ref = b.ref || event.params.bookingId;
  const currency = b.market === 'dubai' ? 'AED' : '£';

  const clientEmail = b.clientEmail || b.email;
  if (clientEmail) {
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#000;color:#fff;padding:32px 24px;border-radius:12px">
        <div style="font-family:Georgia,serif;font-size:32px;font-weight:300;letter-spacing:2px;color:#D4A843;margin-bottom:6px">ApexVIP</div>
        <div style="font-size:12px;color:#888;letter-spacing:3px;margin-bottom:28px">BOOKING CONFIRMED</div>
        <p style="font-size:16px;color:#ccc">Dear ${b.clientName || 'Valued Client'},</p>
        <p style="font-size:14px;color:#999;margin-bottom:24px">Your booking is confirmed. Your chauffeur will contact you 30 minutes before pickup.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <tr><td style="padding:10px 0;border-bottom:1px solid #222;font-size:13px;color:#888">Reference</td><td style="padding:10px 0;border-bottom:1px solid #222;font-size:14px;font-weight:700;color:#D4A843;text-align:right">${ref}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #222;font-size:13px;color:#888">Service</td><td style="padding:10px 0;border-bottom:1px solid #222;font-size:14px;text-align:right">${b.serviceLabel || 'Airport Transfer'}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #222;font-size:13px;color:#888">Pickup</td><td style="padding:10px 0;border-bottom:1px solid #222;font-size:14px;text-align:right">${b.pickup || '—'}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #222;font-size:13px;color:#888">Drop-off</td><td style="padding:10px 0;border-bottom:1px solid #222;font-size:14px;text-align:right">${b.airport || b.dropoff || '—'}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #222;font-size:13px;color:#888">Date & Time</td><td style="padding:10px 0;border-bottom:1px solid #222;font-size:14px;text-align:right">${b.date || '—'} ${b.time || ''}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #222;font-size:13px;color:#888">Vehicle</td><td style="padding:10px 0;border-bottom:1px solid #222;font-size:14px;text-align:right">${b.vehicle || 'Mercedes S-Class'}</td></tr>
          <tr><td style="padding:10px 0;font-size:13px;color:#888">Total</td><td style="padding:10px 0;font-size:20px;font-weight:800;color:#D4A843;text-align:right">${currency}${b.price || '—'}</td></tr>
        </table>
        <p style="font-size:12px;color:#666;line-height:1.7">Cancellations must be made at least 24 hours before pickup to avoid charges.</p>
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #222;font-size:11px;color:#444;text-align:center">ApexVIP · Luxury Chauffeur Services</div>
      </div>`;
    try {
      await mailer.sendMail({
        from: `"ApexVIP" <${process.env.SMTP_USER}>`,
        to: clientEmail, subject: `Booking Confirmed — ${ref}`, html,
      });
    } catch (e) { console.warn('Email failed:', e.message); }
  }

  if (b.market === 'dubai' && b.clientPhone) {
    const twilio = twilioClient();
    if (twilio) {
      try {
        await twilio.messages.create({
          from: `whatsapp:${process.env.TWILIO_WA_FROM}`,
          to: `whatsapp:${b.clientPhone}`,
          body: `✅ *ApexVIP Dubai — Booking Confirmed*\n\nRef: *${ref}*\nPickup: ${b.pickup || '—'}\nDrop-off: ${b.airport || b.dropoff || '—'}\nDate: ${b.date || '—'} ${b.time || ''}\nVehicle: ${b.vehicle || 'Mercedes S-Class'}\nTotal: AED ${b.price || '—'}\n\nYour chauffeur will contact you 30 min before pickup. 🚗`,
        });
      } catch (e) { console.warn('WhatsApp failed:', e.message); }
    }
  }

  if (b.driverId) {
    await db.collection('jobs').add({
      driverId: b.driverId, bookingRef: ref, bookingId: event.params.bookingId,
      clientId: b.clientId || '', clientName: b.clientName || '',
      type: b.serviceType || 'airport', serviceLabel: b.serviceLabel || 'Airport Transfer',
      pickup: b.pickup || '', dropoff: b.airport || b.dropoff || '',
      date: b.date || '', time: b.time || '', flight: b.flight || '',
      vehicle: b.vehicle || '', pay: b.price || 0, notes: b.notes || '',
      status: 'pending', market: b.market || 'london',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(e => console.warn('Job create failed:', e.message));

    const tokenDoc = await db.collection('fcm_tokens').doc(b.driverId).get().catch(() => null);
    if (tokenDoc && tokenDoc.exists && tokenDoc.data().token) {
      await admin.messaging().send({
        token: tokenDoc.data().token,
        notification: { title: '🚗 New Job Assigned', body: `${b.serviceLabel || 'Transfer'} · ${b.pickup || '?'} → ${b.airport || b.dropoff || '?'} · ${b.date || ''} ${b.time || ''}` },
        data: { screen: 'home', type: 'assigned_job' },
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      }).catch(e => console.warn('Driver FCM failed:', e.message));
    }
  } else {
    // Check dispatch mode — manual mode skips broadcast
    const modeDoc = await db.collection('settings').doc('dispatch').get().catch(() => null);
    const dispatchMode = modeDoc && modeDoc.exists ? modeDoc.data().mode : 'broadcast';
    if (dispatchMode !== 'manual') {
    await db.collection('open_jobs').add({
      bookingDocId: event.params.bookingId, bookingRef: ref, status: 'open',
      pickup: b.pickup || '', dropoff: b.airport || b.dropoff || '',
      date: b.date || '', time: b.time || '',
      serviceLabel: b.serviceLabel || 'Airport Transfer',
      type: b.serviceType || 'airport',
      clientId: b.clientId || '', clientName: b.clientName || '',
      notes: b.notes || '',
      price: b.price || 0, pay: b.price || 0, flight: b.flight || '', market: b.market || 'london',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(e => console.warn('open_jobs create failed:', e.message));
    await snap.ref.update({ status: 'offered' }).catch(() => {});

    const onlineSnap = await db.collection('drivers').where('status', '==', 'online').get().catch(() => null);
    if (onlineSnap && !onlineSnap.empty) {
      const notifBody = `${b.serviceLabel || 'Airport Transfer'} · ${b.pickup || '?'} → ${b.airport || b.dropoff || '?'} · ${b.date || ''} ${b.time || ''}`;
      const sends = onlineSnap.docs.map(async d => {
        const tok = await db.collection('fcm_tokens').doc(d.id).get().catch(() => null);
        if (!tok || !tok.exists || !tok.data().token) return;
        return admin.messaging().send({
          token: tok.data().token,
          notification: { title: '🚗 New Job Available', body: notifBody },
          data: { screen: 'home', type: 'new_job', bookingRef: ref },
          android: { priority: 'high' },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        }).catch(e => console.warn('Driver FCM failed:', d.id, e.message));
      });
      await Promise.allSettled(sends);
    }
    }
  }

  return null;
});

// ── 4. handleCancellation ─────────────────────────────────────────────────
exports.handleCancellation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { bookingRef } = request.data;
  if (!bookingRef) throw new HttpsError('invalid-argument', 'bookingRef required');

  const snap = await db.collection('bookings').where('ref', '==', bookingRef).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'Booking not found');

  const doc = snap.docs[0];
  const b = doc.data();
  if (b.clientId !== request.auth.uid && !(await isAdminUser(request.auth.uid)))
    throw new HttpsError('permission-denied', 'Not authorised');

  let fee = 0;
  if (b.date && b.time) {
    // Normalise 12h format (e.g. "2:30 PM") to 24h ("14:30") before parsing
    const timeStr = b.time.includes('M')
      ? (() => {
          const [t, m] = b.time.split(' ');
          let [h, min] = t.split(':').map(Number);
          if (m === 'PM' && h < 12) h += 12;
          if (m === 'AM' && h === 12) h = 0;
          return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
        })()
      : b.time;
    const hoursUntil = (new Date(`${b.date}T${timeStr}`).getTime() - Date.now()) / 3_600_000;
    if (!isNaN(hoursUntil) && hoursUntil < 24) fee = Math.round((b.price || 0) * 0.5);
  }

  await doc.ref.update({
    status: 'cancelled', cancellationFee: fee,
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(), cancelledBy: request.auth.uid,
  });

  if (b.squarePaymentId && fee === 0) {
    try {
      await squareClient.refunds.refundPayment({
        idempotencyKey: `refund-${bookingRef}-${Date.now()}`,
        paymentId: b.squarePaymentId,
        amountMoney: { amount: Math.round((b.price || 0) * 100), currency: 'GBP' },
        reason: 'Client cancellation — full refund',
      });
      await doc.ref.update({ paymentStatus: 'refunded' });
    } catch (e) { console.warn('Refund failed:', e.message); }
  }

  return { success: true, cancellationFee: fee };
});

// ── 5. checkFlightStatus ──────────────────────────────────────────────────
exports.checkFlightStatus = onCall(async (request) => {
  // Accept both 'flight' (client app) and 'flightNumber' (legacy callers)
  const flightNumber = request.data.flight || request.data.flightNumber;
  if (!flightNumber) throw new HttpsError('invalid-argument', 'flight required');
  if (!AVIATION_KEY) return { demo: true, status: 'scheduled', delayed: false };

  const fetch = require('node-fetch');
  const iata = flightNumber.replace(/\s/g, '').toUpperCase();
  try {
    const resp = await fetch(`https://api.aviationstack.com/v1/flights?access_key=${AVIATION_KEY}&flight_iata=${iata}&limit=1`);
    const json = await resp.json();
    const f = json?.data?.[0];
    if (!f) return { status: 'unknown', delayed: false };
    return {
      status: f.flight_status,
      delayed: (f.departure?.delay || 0) > 15,
      delayMins: f.departure?.delay || 0,
      estimated: f.departure?.estimated || f.departure?.scheduled,
      airline: f.airline?.name,
    };
  } catch (e) {
    return { status: 'unknown', delayed: false };
  }
});

// ── 6. onBookingStatusChange ──────────────────────────────────────────────
exports.onBookingStatusChange = onDocumentUpdated('bookings/{bookingId}', async (event) => {
  const before = event.data.before.data(), after = event.data.after.data();
  if (before.status === after.status) return null;

  const msgs = {
    accepted:  { title: 'Driver Assigned',   body: `${after.driverName || 'Your driver'} is confirmed.` },
    en_route:  { title: 'Driver En Route',    body: `${after.driverName || 'Your driver'} is on the way.` },
    arrived:   { title: 'Driver Arrived',     body: 'Your chauffeur has arrived at the pickup point.' },
    onboard:   { title: 'Trip Started',       body: 'Enjoy your journey.' },
    completed: { title: 'Trip Complete',      body: 'Thank you for choosing ApexVIP.' },
    cancelled: { title: 'Booking Cancelled',  body: `Booking ${after.ref || ''} has been cancelled.` },
  };

  const msg = msgs[after.status];
  if (!msg || !after.clientId) return null;

  const tokenDoc = await db.collection('fcm_tokens').doc(after.clientId).get().catch(() => null);
  if (!tokenDoc || !tokenDoc.exists) return null;

  await admin.messaging().send({
    token: tokenDoc.data().token,
    notification: { title: msg.title, body: msg.body },
    data: { screen: 'active-trip', bookingId: event.params.bookingId },
    android: { priority: 'high' },
    apns: { payload: { aps: { badge: 1, sound: 'default' } } },
  }).catch(e => console.warn('FCM push failed:', e.message));

  return null;
});

// ── 7. assignDriverToBooking ──────────────────────────────────────────────
exports.assignDriverToBooking = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { bookingRef, driverId } = request.data;
  if (!bookingRef || !driverId) throw new HttpsError('invalid-argument', 'Missing fields');

  const [bSnap, dSnap] = await Promise.all([
    db.collection('bookings').where('ref', '==', bookingRef).limit(1).get(),
    db.collection('users').doc(driverId).get(),
  ]);
  if (bSnap.empty) throw new HttpsError('not-found', 'Booking not found');
  if (!dSnap.exists) throw new HttpsError('not-found', 'Driver not found');

  const b = bSnap.docs[0].data(), d = dSnap.data();
  await bSnap.docs[0].ref.update({
    driverId, driverName: d.name || 'Driver', driverPlate: d.plate || '',
    driverRating: d.rating || 4.9, status: 'accepted',
    assignedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Cancel any broadcast open_jobs for this booking so drivers stop seeing it
  const openJobsSnap = await db.collection('open_jobs')
    .where('bookingDocId', '==', bSnap.docs[0].id).where('status', '==', 'open').get().catch(() => null);
  if (openJobsSnap && !openJobsSnap.empty) {
    const batch = db.batch();
    openJobsSnap.docs.forEach(d => batch.update(d.ref, { status: 'cancelled' }));
    await batch.commit().catch(e => console.warn('open_jobs cancel:', e.message));
  }

  const jobRef = await db.collection('jobs').add({
    driverId, bookingRef, bookingId: bSnap.docs[0].id,
    clientId: b.clientId || '', clientName: b.clientName || '',
    type: b.serviceType || 'airport', serviceLabel: b.serviceLabel || 'Airport Transfer',
    pickup: b.pickup || '', dropoff: b.airport || b.dropoff || '',
    date: b.date || '', time: b.time || '', flight: b.flight || '',
    vehicle: b.vehicle || '', pay: b.price || 0,
    notes: b.notes || '', market: b.market || 'london',
    status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const tokenDoc = await db.collection('fcm_tokens').doc(driverId).get().catch(() => null);
  if (tokenDoc && tokenDoc.exists) {
    await admin.messaging().send({
      token: tokenDoc.data().token,
      notification: { title: 'New Job Request', body: `${b.serviceLabel || 'Transfer'} · ${b.pickup || '?'} → ${b.airport || b.dropoff || '?'}` },
      data: { screen: 'jobs', jobId: jobRef.id },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    }).catch(() => {});
  }

  return { success: true, jobId: jobRef.id };
});

// ── 8. parseBookingIntent (AI Concierge) ─────────────────────────────────
exports.parseBookingIntent = onCall(async (request) => {
  const { message, history, trips, now } = request.data;
  if (!message || typeof message !== 'string')
    throw new HttpsError('invalid-argument', 'message required');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpsError('failed-precondition', 'ANTHROPIC_API_KEY not configured');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.Anthropic({ apiKey });

  const tripsCtx = Array.isArray(trips) && trips.length
    ? trips.slice(0,10).map(t=>`• ${t.ref}: ${t.pickup||'?'} → ${t.dropoff||t.airport||'?'}, ${t.date||'?'} ${t.time||''} [${t.status}]`).join('\n')
    : 'No booking history.';

  const systemPrompt = `You are the ApexVIP AI Concierge for a premium chauffeur service in London and Dubai.
You handle bookings, price quotes, destination suggestions, booking modifications, recurring schedules, and trip queries.

══ INTENT — set the "intent" field:
"book"          new booking
"quote"         price enquiry
"modify"        change/cancel existing booking
"query"         question about past/upcoming trips
"suggest"       destination ideas
"recurring"     repeating schedule
"flight_update" flight delay/change
"chat"          general conversation

══ PRICING GUIDE (GBP):
Central London → Heathrow/Gatwick: S-Class £195, V-Class £245, Phantom £490
Central ↔ Central (within M25): S-Class £85-130, V-Class £115-165, Phantom £300-400
→ Stansted/Luton: S-Class £165, V-Class £210
Hourly: S-Class £75/hr, V-Class £95/hr, Phantom £185/hr (2hr minimum)
Day hire: S-Class £680, V-Class £850, Phantom £1,600

══ SMART PICKUP TIME (set suggestedPickupTime HH:MM):
Heathrow/Gatwick: flight minus 3h30. Add 30min if 07-09 or 17-19.
Stansted/Luton: flight minus 3h. London City: flight minus 2h.

══ CLIENT TRIP HISTORY:
${tripsCtx}

══ CURRENT DATE/TIME: ${now || new Date().toISOString()}

Return ONLY valid JSON:
{
  "intent": string,
  "serviceType": "airport"|"hourly"|"day"|"aviation"|null,
  "pickup": string|null, "dropoff": string|null, "airport": string|null,
  "flight": string|null, "date": string|null, "time": string|null,
  "suggestedPickupTime": string|null,
  "vehicle": "S-Class"|"V-Class"|"Phantom"|null,
  "passengers": number|null, "notes": string|null,
  "stops": [{"name":string,"address":string}]|null,
  "recurringPattern": {"frequency":string,"dayOfWeek":string,"time":string}|null,
  "paPassenger": {"name":string,"notes":string}|null,
  "priceEstimate": number|null,
  "modifyBookingRef": string|null,
  "modifyFields": object|null,
  "suggestions": [{"name":string,"type":string,"address":string,"notes":string}]|null,
  "reply": string
}`;

  const priorMsgs = Array.isArray(history)
    ? history.filter(m=>m.role==='user'||m.role==='assistant').slice(-8)
        .map(m=>({role:m.role, content:String(m.content)}))
    : [];

  const resp = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 800,
    system: systemPrompt,
    messages: [...priorMsgs, { role: 'user', content: message }]
  });

  let parsed = null;
  try {
    const text = resp.content[0].type === 'text' ? resp.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    parsed = { intent:'chat', reply: 'I understand you need assistance. Could you tell me where you\'d like to go?' };
  }

  await db.collection('analytics').add({
    event: 'ai_concierge_used',
    uid: request.auth ? request.auth.uid : null,
    messageLength: message.length,
    intent: parsed?.intent || null,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});

  return parsed || { intent:'chat', reply: 'Could you share your pickup address, destination and date?' };
});

// ── 9. submitTripRating ───────────────────────────────────────────────────
exports.submitTripRating = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { bookingRef, rating, comment, driverId } = request.data;
  if (!bookingRef || !rating)
    throw new HttpsError('invalid-argument', 'bookingRef and rating required');

  const clampedRating = Math.min(5, Math.max(1, Number(rating)));

  await db.collection('ratings').add({
    bookingRef, clientId: request.auth.uid, driverId: driverId || null,
    rating: clampedRating,
    comment: comment || '',
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  if (driverId) {
    // Transaction keeps increment + average recompute atomic, preventing race conditions
    await db.runTransaction(async tx => {
      const dRef = db.collection('drivers').doc(driverId);
      const dSnap = await tx.get(dRef);
      if (!dSnap.exists) return;
      const d = dSnap.data();
      const newTotal = (d.ratingTotal || 0) + clampedRating;
      const newCount = (d.ratingCount || 0) + 1;
      const newAvg = Math.round(newTotal / newCount * 10) / 10;
      tx.update(dRef, { ratingTotal: newTotal, ratingCount: newCount, rating: newAvg });
    }).catch(e => console.warn('Rating transaction failed:', e.message));
  }

  return { success: true };
});

// ── 10. sendChauffeurMessage ──────────────────────────────────────────────
exports.sendChauffeurMessage = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { bookingRef, message, fromRole } = request.data;
  if (!bookingRef || !message)
    throw new HttpsError('invalid-argument', 'bookingRef and message required');

  const msgDoc = await db.collection('bookings').where('ref', '==', bookingRef).limit(1).get();
  if (msgDoc.empty) throw new HttpsError('not-found', 'Booking not found');

  const bookingId = msgDoc.docs[0].id;
  await db.collection('bookings').doc(bookingId).collection('messages').add({
    from: request.auth.uid,
    fromRole: fromRole || 'client',
    message,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    read: false
  });

  return { success: true };
});

// ── 11. hotelConciergeBook ────────────────────────────────────────────────
exports.hotelConciergeBook = onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) { res.status(401).json({ error: 'API key required' }); return; }

  const keySnap = await db.collection('api_keys').where('key', '==', apiKey).where('active', '==', true).limit(1).get();
  if (keySnap.empty) { res.status(403).json({ error: 'Invalid or inactive API key' }); return; }

  const partner = keySnap.docs[0].data();
  const { guestName, guestPhone, pickup, dropoff, airport, date, time, vehicle, flight, notes } = req.body;
  if (!guestName || !pickup || !date || !time) {
    res.status(400).json({ error: 'Required: guestName, pickup, date, time' });
    return;
  }

  const ref = 'APX-HTL-' + Date.now().toString(36).toUpperCase().slice(-5) + Math.floor(100 + Math.random() * 900);
  await db.collection('bookings').add({
    ref, source: 'hotel_api', partnerName: partner.name || 'Hotel Partner',
    clientName: guestName, clientPhone: guestPhone || '',
    pickup, dropoff: dropoff || '', airport: airport || '',
    date, time, flight: flight || '',
    vehicle: vehicle || 'Mercedes S-Class',
    notes: notes || '', status: 'confirmed', price: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.status(201).json({ success: true, ref, message: `Booking confirmed. Reference: ${ref}`, estimatedArrival: '15 minutes' });
});

// ── 12. whatsappWebhook ───────────────────────────────────────────────────
exports.whatsappWebhook = onRequest(async (req, res) => {
  // Verify the request is genuinely from Twilio
  const twilio = require('twilio');
  const authToken = process.env.TWILIO_AUTH;
  if (authToken) {
    const signature = req.headers['x-twilio-signature'] || '';
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const valid = twilio.validateRequest(authToken, signature, url, req.body || {});
    if (!valid) { res.status(403).send('Forbidden'); return; }
  }

  const { Body, From, ProfileName } = req.body;
  if (!Body || !From) { res.status(400).send('Bad request'); return; }

  const msg = Body.trim().toLowerCase();
  const phone = From.replace('whatsapp:', '');
  let reply = '';

  if (msg.includes('book') || msg.includes('car') || msg.includes('pickup') || msg.includes('airport') || msg.includes('heathrow') || msg.includes('gatwick')) {
    let parsed = null;
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
      const resp = await client.messages.create({
        model: 'claude-opus-4-5', max_tokens: 256,
        system: 'Extract booking details from this WhatsApp message. Return JSON only: { pickup, dropoff, date, time, flight }. Use null for unknown fields.',
        messages: [{ role: 'user', content: Body }]
      });
      const text = resp.content[0]?.text || '';
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch(e) {}

    if (parsed?.pickup || parsed?.dropoff) {
      const ref = 'APX-WA-' + Math.floor(1000 + Math.random() * 9000);
      await db.collection('bookings').add({
        ref, source: 'whatsapp', clientName: ProfileName || 'WhatsApp Client',
        clientPhone: phone, pickup: parsed.pickup || 'To be confirmed',
        dropoff: parsed.dropoff || '', date: parsed.date || '',
        time: parsed.time || '', flight: parsed.flight || '',
        vehicle: 'Mercedes S-Class', status: 'pending_confirm',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
      reply = `✦ *ApexVIP* — Perfect, ${ProfileName || 'valued guest'}.\n\nRef: *${ref}*\n📍 From: ${parsed.pickup || 'To confirm'}\n📍 To: ${parsed.dropoff || 'To confirm'}\n📅 ${parsed.date || 'Date TBC'} at ${parsed.time || 'Time TBC'}\n\nA member of our team will confirm within 5 minutes.`;
    } else {
      reply = `✦ *ApexVIP Concierge*\n\nTo book, tell me:\n• Pickup location\n• Destination\n• Date and time\n\nExample: _"Car from Claridge's to Heathrow T5 tomorrow at 6am"_`;
    }
  } else if (msg.includes('cancel')) {
    reply = `✦ *ApexVIP* — To cancel, provide your reference number (e.g. APX-1234).`;
  } else if (msg.includes('hello') || msg.includes('hi') || msg === 'start') {
    reply = `✦ *Welcome to ApexVIP Concierge*\n\nTell me where you need to go.\n\nBook online: https://refayethossain28.github.io/BallrzAPP/apexvip-client.html`;
  } else {
    reply = `✦ *ApexVIP* — Tell me where you'd like to go and I'll arrange everything.`;
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
});

// ── 13. generateReferralCode / applyReferralCode ──────────────────────────
exports.generateReferralCode = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const existing = await db.collection('referrals').where('ownerId', '==', uid).limit(1).get();
  if (!existing.empty) return { code: existing.docs[0].data().code };
  const code = 'APEX' + uid.slice(0,4).toUpperCase() + Math.floor(100 + Math.random() * 900);
  await db.collection('referrals').add({
    code, ownerId: uid, uses: 0, creditsEarned: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { code };
});

exports.applyReferralCode = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const { code } = request.data;
  if (!code) throw new HttpsError('invalid-argument', 'code required');
  const snap = await db.collection('referrals').where('code', '==', code.toUpperCase()).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'Invalid referral code');
  const ref = snap.docs[0];
  const refData = ref.data();
  if (refData.ownerId === request.auth.uid) throw new HttpsError('invalid-argument', 'Cannot use your own referral code');
  const used = await db.collection('referral_uses').where('code', '==', code).where('uid', '==', request.auth.uid).limit(1).get();
  if (!used.empty) throw new HttpsError('already-exists', 'You have already used this code');
  await db.collection('referral_uses').add({ code, uid: request.auth.uid, timestamp: admin.firestore.FieldValue.serverTimestamp() });
  await ref.ref.update({ uses: admin.firestore.FieldValue.increment(1), creditsEarned: admin.firestore.FieldValue.increment(100) });
  await db.collection('users').doc(refData.ownerId).update({ apexBalance: admin.firestore.FieldValue.increment(100) }).catch(() => {});
  await db.collection('users').doc(request.auth.uid).update({ apexBalance: admin.firestore.FieldValue.increment(50) }).catch(() => {});
  return { success: true, creditsAwarded: 50, message: 'You\'ve received 50 APEX credits!' };
});

// ── 14. notifyBookingConfirmed ────────────────────────────────────────────
exports.notifyBookingConfirmed = onCall(async (request) => {
  const { bookingRef, clientId, serviceType, pickup, dropoff, date, time } = request.data;
  if (!clientId || !bookingRef) throw new HttpsError('invalid-argument', 'clientId and bookingRef required');
  const svcLabel = { airport: 'Airport Transfer', hourly: 'By the Hour', day: 'Full Day' }[serviceType] || 'Booking';
  await sendPushNotification(clientId, '✓ Booking Confirmed',
    `${svcLabel} on ${date || 'your date'} at ${time || 'your time'} — ref ${bookingRef}`,
    { screen: 'trips', bookingRef });
  return { sent: true };
});

// ── 15. notifyDriverAssigned ──────────────────────────────────────────────
exports.notifyDriverAssigned = onCall(async (request) => {
  const { clientId, driverName, vehicle, plate, bookingRef } = request.data;
  if (!clientId) throw new HttpsError('invalid-argument', 'clientId required');
  await sendPushNotification(clientId, '🚗 Driver Assigned',
    `${driverName} · ${vehicle} · ${plate} is your chauffeur`,
    { screen: 'active-trip', bookingRef: bookingRef || '' });
  return { sent: true };
});

// ── 16. notifyDriverArriving ──────────────────────────────────────────────
exports.notifyDriverArriving = onCall(async (request) => {
  const { clientId, driverName, minutesAway, bookingRef } = request.data;
  if (!clientId) throw new HttpsError('invalid-argument', 'clientId required');
  await sendPushNotification(clientId, `🏁 Driver ${minutesAway || 5} min away`,
    `${driverName} is nearly there — please make your way to the pickup point`,
    { screen: 'active-trip', bookingRef: bookingRef || '' });
  return { sent: true };
});
