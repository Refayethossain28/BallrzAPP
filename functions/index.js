const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { ApiError, Client, Environment } = require('square');

admin.initializeApp();

const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: Environment.Production,
});

exports.processSquarePayment = functions.https.onCall(async (data, context) => {
  const { sourceId, amount, bookingRef } = data;

  if (!sourceId || !amount || !bookingRef) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields');
  }

  try {
    const { result } = await squareClient.paymentsApi.createPayment({
      sourceId,
      idempotencyKey: `${bookingRef}-${Date.now()}`,
      amountMoney: {
        amount: Math.round(amount * 100), // convert £ to pence
        currency: 'GBP',
      },
      locationId: '1ZX0F29TX12HB',
      note: `ApexVIP Booking ${bookingRef}`,
    });

    const payment = result.payment;

    await admin.firestore().collection('bookings')
      .where('ref', '==', bookingRef).limit(1).get()
      .then(snap => {
        if (!snap.empty) {
          snap.docs[0].ref.update({
            squarePaymentId: payment.id,
            paymentStatus: 'paid',
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }).catch(() => {});

    return { success: true, paymentId: payment.id, status: payment.status };
  } catch (error) {
    if (error instanceof ApiError) {
      const msg = error.errors?.[0]?.detail || error.message;
      throw new functions.https.HttpsError('internal', msg);
    }
    throw new functions.https.HttpsError('internal', error.message);
  }
});
