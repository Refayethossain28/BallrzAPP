const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { ApiError, Client, Environment } = require('square');

admin.initializeApp();
const db = admin.firestore();

// ── Square (London) ────────────────────────────────────────────────────────
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: Environment.Production,
});

// ── Email (set SMTP_USER + SMTP_PASS env vars) ─────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' },
});

// ── Twilio WhatsApp (set TWILIO_SID, TWILIO_AUTH, TWILIO_WA_FROM) ──────────
function twilioClient() {
  const sid = process.env.TWILIO_SID, auth = process.env.TWILIO_AUTH;
  if (!sid || !auth) return null;
  return require('twilio')(sid, auth);
}

// ── AviationStack flight tracking (set AVIATION_KEY) ──────────────────────
const AVIATION_KEY = process.env.AVIATION_KEY || '';

// ──────────────────────────────────────────────────────────────────────────
// 1. processSquarePayment  (London)
// ──────────────────────────────────────────────────────────────────────────
exports.processSquarePayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  const { sourceId, amount, bookingRef } = data;
  if (!sourceId || !amount || !bookingRef)
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields');

  try {
    const { result } = await squareClient.paymentsApi.createPayment({
      sourceId,
      idempotencyKey: `${bookingRef}-${Date.now()}`,
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
    throw new functions.https.HttpsError('internal', msg);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 2. processCheckoutPayment  (Dubai — Checkout.com)
//    Set CHECKOUT_SECRET_KEY env var for live processing
// ──────────────────────────────────────────────────────────────────────────
exports.processCheckoutPayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  const { token, amount, currency, bookingRef } = data;
  if (!token || !amount || !bookingRef)
    throw new functions.https.HttpsError('invalid-argument', 'Missing fields');

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
  if (!resp.ok) throw new functions.https.HttpsError('internal', result.error_codes?.join(', ') || 'Payment failed');

  const snap = await db.collection('bookings').where('ref', '==', bookingRef).limit(1).get();
  if (!snap.empty) {
    await snap.docs[0].ref.update({
      checkoutPaymentId: result.id,
      paymentStatus: result.status === 'Authorized' ? 'paid' : result.status,
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return { success: true, paymentId: result.id };
});

// ──────────────────────────────────────────────────────────────────────────
// 3. onBookingCreated — Firestore trigger
//    Sends email, WhatsApp (Dubai), creates driver job doc
// ──────────────────────────────────────────────────────────────────────────
exports.onBookingCreated = functions.firestore
  .document('bookings/{bookingId}')
  .onCreate(async (snap, context) => {
    const b = snap.data();
    const ref = b.ref || context.params.bookingId;
    const currency = b.market === 'dubai' ? 'AED' : '£';

    // Email confirmation
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

    // WhatsApp (Dubai)
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

    // Create driver job
    if (b.driverId) {
      await db.collection('jobs').add({
        driverId: b.driverId, bookingRef: ref, bookingId: context.params.bookingId,
        clientId: b.clientId || '', clientName: b.clientName || '',
        type: b.serviceType || 'airport', serviceLabel: b.serviceLabel || 'Airport Transfer',
        pickup: b.pickup || '', dropoff: b.airport || b.dropoff || '',
        date: b.date || '', time: b.time || '', flight: b.flight || '',
        vehicle: b.vehicle || '', pay: b.price || 0, notes: b.notes || '',
        status: 'pending', market: b.market || 'london',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => console.warn('Job create failed:', e.message));
    }

    return null;
  });

// ──────────────────────────────────────────────────────────────────────────
// 4. handleCancellation — cancels booking + issues refund if paid within policy
// ──────────────────────────────────────────────────────────────────────────
exports.handleCancellation = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  const { bookingRef } = data;
  if (!bookingRef) throw new functions.https.HttpsError('invalid-argument', 'bookingRef required');

  const snap = await db.collection('bookings').where('ref', '==', bookingRef).limit(1).get();
  if (snap.empty) throw new functions.https.HttpsError('not-found', 'Booking not found');

  const doc = snap.docs[0];
  const b = doc.data();
  if (b.clientId !== context.auth.uid && !(await isAdminUser(context.auth.uid)))
    throw new functions.https.HttpsError('permission-denied', 'Not authorised');

  let fee = 0;
  if (b.date && b.time) {
    const hoursUntil = (new Date(`${b.date}T${b.time}`).getTime() - Date.now()) / 3_600_000;
    if (hoursUntil < 24) fee = Math.round((b.price || 0) * 0.5);
  }

  await doc.ref.update({
    status: 'cancelled', cancellationFee: fee,
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(), cancelledBy: context.auth.uid,
  });

  if (b.squarePaymentId && fee === 0) {
    try {
      await squareClient.refundsApi.refundPayment({
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

// ──────────────────────────────────────────────────────────────────────────
// 5. checkFlightStatus — AviationStack API
// ──────────────────────────────────────────────────────────────────────────
exports.checkFlightStatus = functions.https.onCall(async (data, _context) => {
  const { flightNumber } = data;
  if (!flightNumber) throw new functions.https.HttpsError('invalid-argument', 'flightNumber required');
  if (!AVIATION_KEY) return { demo: true, status: 'scheduled', delayed: false };

  const fetch = require('node-fetch');
  const iata = flightNumber.replace(/\s/g, '').toUpperCase();
  try {
    const resp = await fetch(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_KEY}&flight_iata=${iata}&limit=1`);
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

// ──────────────────────────────────────────────────────────────────────────
// 6. onBookingStatusChange — push notification to client when status changes
// ──────────────────────────────────────────────────────────────────────────
exports.onBookingStatusChange = functions.firestore
  .document('bookings/{bookingId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data(), after = change.after.data();
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
      data: { screen: 'active-trip', bookingId: context.params.bookingId },
      apns: { payload: { aps: { badge: 1, sound: 'default' } } },
    }).catch(e => console.warn('FCM push failed:', e.message));

    return null;
  });

// ──────────────────────────────────────────────────────────────────────────
// 7. assignDriverToBooking — admin callable
// ──────────────────────────────────────────────────────────────────────────
exports.assignDriverToBooking = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  const { bookingRef, driverId } = data;
  if (!bookingRef || !driverId) throw new functions.https.HttpsError('invalid-argument', 'Missing fields');

  const [bSnap, dSnap] = await Promise.all([
    db.collection('bookings').where('ref', '==', bookingRef).limit(1).get(),
    db.collection('users').doc(driverId).get(),
  ]);
  if (bSnap.empty) throw new functions.https.HttpsError('not-found', 'Booking not found');
  if (!dSnap.exists) throw new functions.https.HttpsError('not-found', 'Driver not found');

  const b = bSnap.docs[0].data(), d = dSnap.data();
  await bSnap.docs[0].ref.update({
    driverId, driverName: d.name || 'Driver', driverPlate: d.plate || '',
    driverRating: d.rating || 4.9, status: 'accepted',
    assignedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const jobRef = await db.collection('jobs').add({
    driverId, bookingRef, bookingId: bSnap.docs[0].id,
    clientId: b.clientId, clientName: b.clientName,
    type: b.serviceType || 'airport', serviceLabel: b.serviceLabel,
    pickup: b.pickup, dropoff: b.airport || b.dropoff,
    date: b.date, time: b.time, flight: b.flight || '',
    vehicle: b.vehicle, pay: b.price || 0,
    status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const tokenDoc = await db.collection('fcm_tokens').doc(driverId).get().catch(() => null);
  if (tokenDoc && tokenDoc.exists) {
    await admin.messaging().send({
      token: tokenDoc.data().token,
      notification: { title: 'New Job Request', body: `${b.serviceLabel} · ${b.pickup} → ${b.airport || b.dropoff}` },
      data: { screen: 'jobs', jobId: jobRef.id },
    }).catch(() => {});
  }

  return { success: true, jobId: jobRef.id };
});

// ──────────────────────────────────────────────────────────────────────────
// Helper
// ──────────────────────────────────────────────────────────────────────────
async function isAdminUser(uid) {
  try {
    const doc = await db.collection('users').doc(uid).get();
    return doc.exists && doc.data().role === 'admin';
  } catch { return false; }
}
