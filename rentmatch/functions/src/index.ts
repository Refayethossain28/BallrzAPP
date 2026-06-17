/**
 * Cloud Functions — server-authoritative deal logic.
 *
 * `draftContract` is the first real transition moved off the client: only the
 * landlord, only when both parties have agreed, can generate the tenancy
 * agreement. It runs the shared compliance + contract kernel under the Admin
 * SDK (bypassing Firestore rules), writes the immutable contract, advances the
 * deal, and appends an audit event. The e-sign (M4) and Stripe £100 fee (M5)
 * handlers below remain seams that build on this same pattern.
 */
import { onCall, onRequest, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import Stripe from 'stripe';
import {
  buildTenancyAgreement, evaluateListingCompliance, evaluateSigningCompliance, recomputeStage,
  tenancyDepositCapPence, buildNotification, PLATFORM_FEE_PENCE,
  type ComplianceDoc, type DealRecord, type EpcRating, type Party,
} from '@rentmatch/shared';

initializeApp();
const db = getFirestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');

type StoredDeal = DealRecord & {
  listingId: string;
  renterId: string;
  landlordId: string;
  renterName: string;
  landlordName: string;
};

interface DraftRequest {
  dealId: string;
}

export const draftContract = onCall(async (req: CallableRequest<DraftRequest>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const dealId = req.data?.dealId;
  if (!dealId) throw new HttpsError('invalid-argument', 'dealId is required.');

  const dealRef = db.doc(`deals/${dealId}`);
  const dealSnap = await dealRef.get();
  if (!dealSnap.exists) throw new HttpsError('not-found', 'Deal not found.');
  const deal = dealSnap.data() as StoredDeal;

  if (deal.landlordId !== uid) {
    throw new HttpsError('permission-denied', 'Only the landlord can draft the agreement.');
  }
  if (!(deal.agreed?.renter && deal.agreed?.landlord)) {
    throw new HttpsError('failed-precondition', 'Both parties must agree before drafting.');
  }
  if (deal.contractDrafted) {
    throw new HttpsError('failed-precondition', 'The agreement has already been drafted.');
  }

  const listingSnap = await db.doc(`listings/${deal.listingId}`).get();
  if (!listingSnap.exists) throw new HttpsError('not-found', 'Listing not found.');
  const listing = listingSnap.data() as Record<string, unknown>;

  const [landlordSnap, renterSnap] = await Promise.all([
    db.doc(`users/${deal.landlordId}`).get(),
    db.doc(`users/${deal.renterId}`).get(),
  ]);
  const landlord: Party = { name: deal.landlordName, email: String(landlordSnap.data()?.email ?? '') };
  const tenant: Party = { name: deal.renterName, email: String(renterSnap.data()?.email ?? '') };

  const monthlyRentPence = Number(listing.rentPence ?? 0);

  // Statutory pre-signing gate (How to Rent / Right to Rent become real in M6).
  const { checks, canSign } = evaluateSigningCompliance({
    nation: 'england',
    monthlyRentPence,
    proposedDepositPence: tenancyDepositCapPence(monthlyRentPence),
    howToRentServed: true,
    rightToRentChecked: true,
  });
  if (!canSign) {
    throw new HttpsError('failed-precondition', 'Statutory pre-signing checks are not met.');
  }

  const agreement = buildTenancyAgreement({
    nation: 'england',
    landlord,
    tenant,
    propertyAddress: `${listing.street}, ${listing.area}, ${listing.city}, ${listing.postcode}`,
    monthlyRentPence,
    startDate: Date.now() + 14 * 86_400_000,
    termMonths: 12,
    furnished: (listing.furnished as 'Furnished' | 'Unfurnished' | 'Part-furnished') ?? 'Unfurnished',
    epcRating: (listing.epcRating as EpcRating) ?? 'D',
  });

  await db.doc(`contracts/${dealId}`).set({
    dealId,
    renterId: deal.renterId,
    landlordId: deal.landlordId,
    version: 1,
    agreement,
    compliance: checks,
    feePence: PLATFORM_FEE_PENCE,
    draftedAt: FieldValue.serverTimestamp(),
  });

  const nextStage = recomputeStage({ ...deal, contractDrafted: true });
  await dealRef.update({
    contractDrafted: true,
    stage: nextStage,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await dealRef.collection('events').add({
    type: 'contract_drafted',
    actor: uid,
    at: FieldValue.serverTimestamp(),
  });
  await dealRef.collection('messages').add({
    senderId: 'system',
    senderRole: 'system',
    text: 'Tenancy agreement drafted and shared with both parties for review.',
    ts: FieldValue.serverTimestamp(),
  });

  return { contractId: dealId, stage: nextStage };
});

/**
 * M4 — open the e-signature envelope. Landlord-only, once the contract is
 * drafted. In production this calls the e-sign provider's API to create an
 * envelope for both signers; here we record the envelope and advance the deal
 * to `signing`. The provider's hosted signing + webhook replace `recordSignature`.
 */
export const openSigning = onCall(async (req: CallableRequest<DraftRequest>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const dealId = req.data?.dealId;
  if (!dealId) throw new HttpsError('invalid-argument', 'dealId is required.');

  const dealRef = db.doc(`deals/${dealId}`);
  const dealSnap = await dealRef.get();
  if (!dealSnap.exists) throw new HttpsError('not-found', 'Deal not found.');
  const deal = dealSnap.data() as StoredDeal;

  if (deal.landlordId !== uid) throw new HttpsError('permission-denied', 'Only the landlord can send for signing.');
  if (!deal.contractDrafted) throw new HttpsError('failed-precondition', 'Draft the agreement first.');
  if (deal.esignEnvelopeOpen) throw new HttpsError('failed-precondition', 'Already sent for signing.');

  const envelopeId = `env_${dealId}`; // provider envelope id — seam
  await db.doc(`contracts/${dealId}`).update({
    esign: {
      provider: 'demo',
      envelopeId,
      sentAt: FieldValue.serverTimestamp(),
      signers: { renter: 'sent', landlord: 'sent' },
    },
  });

  const nextStage = recomputeStage({ ...deal, esignEnvelopeOpen: true });
  await dealRef.update({ esignEnvelopeOpen: true, stage: nextStage, updatedAt: FieldValue.serverTimestamp() });
  await dealRef.collection('events').add({ type: 'signing_opened', actor: uid, at: FieldValue.serverTimestamp() });
  await dealRef.collection('messages').add({
    senderId: 'system', senderRole: 'system',
    text: 'Tenancy agreement sent for e-signature.', ts: FieldValue.serverTimestamp(),
  });
  return { stage: nextStage, envelopeId };
});

/**
 * M4 — record a party's signature. Stands in for the e-sign provider's
 * "signed" webhook: in production the verified webhook calls this path. The
 * deal stays at `signing` even once both have signed — completion waits on the
 * £100 fee (M5), exactly as the shared completion guard requires.
 */
export const recordSignature = onCall(async (req: CallableRequest<DraftRequest>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const dealId = req.data?.dealId;
  if (!dealId) throw new HttpsError('invalid-argument', 'dealId is required.');

  const dealRef = db.doc(`deals/${dealId}`);
  const dealSnap = await dealRef.get();
  if (!dealSnap.exists) throw new HttpsError('not-found', 'Deal not found.');
  const deal = dealSnap.data() as StoredDeal;

  const party = deal.renterId === uid ? 'renter' : deal.landlordId === uid ? 'landlord' : null;
  if (!party) throw new HttpsError('permission-denied', 'You are not a party to this deal.');
  if (!deal.esignEnvelopeOpen) throw new HttpsError('failed-precondition', 'The agreement is not open for signing.');
  if (deal.signed?.[party] != null) throw new HttpsError('failed-precondition', 'You have already signed.');

  const now = Date.now();
  const signed = { ...deal.signed, [party]: now };
  const nextStage = recomputeStage({ ...deal, signed });

  await dealRef.update({
    [`signed.${party}`]: now,
    stage: nextStage,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`contracts/${dealId}`).update({ [`esign.signers.${party}`]: 'signed' });
  await dealRef.collection('events').add({ type: 'signed', actor: uid, party, at: FieldValue.serverTimestamp() });

  const name = party === 'renter' ? deal.renterName : deal.landlordName;
  await dealRef.collection('messages').add({
    senderId: 'system', senderRole: 'system',
    text: `${name} signed the tenancy agreement.`, ts: FieldValue.serverTimestamp(),
  });
  const fullyExecuted = signed.renter != null && signed.landlord != null;
  if (fullyExecuted) {
    await dealRef.collection('messages').add({
      senderId: 'system', senderRole: 'system',
      text: `Both parties have signed. The landlord's ${'£100'} platform fee will be charged to complete the tenancy.`,
      ts: FieldValue.serverTimestamp(),
    });
  }
  return { stage: nextStage, bothSigned: fullyExecuted };
});

/* ---- M5: the £100 landlord fee on full execution ---- */

async function getOrCreateCustomer(landlordId: string, email: string): Promise<string> {
  const ref = db.doc(`users/${landlordId}`);
  const existing = (await ref.get()).data()?.stripeCustomerId as string | undefined;
  if (existing) return existing;
  const customer = await stripe.customers.create({ email, metadata: { landlordId } });
  await ref.update({ stripeCustomerId: customer.id });
  return customer.id;
}

/**
 * Mark a deal completed once its £100 fee is captured. Idempotent and
 * transactional, so the synchronous charge path and the Stripe webhook can both
 * call it safely. Completing the deal also flips the listing to `let`.
 */
async function completeDeal(dealId: string, paymentIntentId: string): Promise<void> {
  const dealRef = db.doc(`deals/${dealId}`);
  const didComplete = await db.runTransaction(async (tx) => {
    const snap = await tx.get(dealRef);
    if (!snap.exists) return false;
    const deal = snap.data() as StoredDeal;
    if (deal.feePaid) return false; // already done — idempotent
    tx.update(dealRef, {
      feePaid: true,
      stage: recomputeStage({ ...deal, feePaid: true }),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(db.doc(`listings/${deal.listingId}`), { status: 'let' });
    tx.set(
      db.doc(`payments/${dealId}`),
      { status: 'succeeded', stripePaymentIntentId: paymentIntentId, paidAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return true;
  });
  if (!didComplete) return;
  await dealRef.collection('events').add({ type: 'completed', at: FieldValue.serverTimestamp(), paymentIntentId });
  await dealRef.collection('messages').add({
    senderId: 'system', senderRole: 'system',
    text: 'The £100 platform fee was paid. The tenancy is fully executed and in force. 🎉',
    ts: FieldValue.serverTimestamp(),
  });
}

/** Save a landlord card for the off-session fee charge (Stripe SetupIntent). */
export const createSetupIntent = onCall(async (req: CallableRequest) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const email = (req.auth?.token.email as string | undefined) ?? '';
  const customerId = await getOrCreateCustomer(uid, email);
  const si = await stripe.setupIntents.create({
    customer: customerId,
    usage: 'off_session',
    payment_method_types: ['card'],
  });
  return { clientSecret: si.client_secret };
});

/**
 * Charge the landlord's £100 fee on full execution. Landlord-only, requires
 * both signatures and an unpaid deal. Charges the saved card off-session with an
 * idempotency key of the dealId so retries never double-bill. On success the
 * deal completes immediately; the Stripe webhook reconciles durably.
 */
export const chargePlatformFee = onCall(async (req: CallableRequest<DraftRequest>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const dealId = req.data?.dealId;
  if (!dealId) throw new HttpsError('invalid-argument', 'dealId is required.');

  const dealRef = db.doc(`deals/${dealId}`);
  const dealSnap = await dealRef.get();
  if (!dealSnap.exists) throw new HttpsError('not-found', 'Deal not found.');
  const deal = dealSnap.data() as StoredDeal;

  if (deal.landlordId !== uid) throw new HttpsError('permission-denied', 'Only the landlord pays the platform fee.');
  if (!(deal.signed?.renter != null && deal.signed?.landlord != null)) {
    throw new HttpsError('failed-precondition', 'Both parties must sign before the fee is charged.');
  }
  if (deal.feePaid) throw new HttpsError('failed-precondition', 'The fee has already been paid.');

  const email = (req.auth?.token.email as string | undefined) ?? '';
  const customerId = await getOrCreateCustomer(uid, email);
  const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  if (cards.data.length === 0) {
    throw new HttpsError('failed-precondition', 'Add a card before paying the £100 fee.');
  }

  const intent = await stripe.paymentIntents.create(
    {
      amount: PLATFORM_FEE_PENCE,
      currency: 'gbp',
      customer: customerId,
      payment_method: cards.data[0].id,
      off_session: true,
      confirm: true,
      description: `RentMatch platform fee — tenancy ${dealId}`,
      metadata: { dealId, landlordId: uid },
    },
    { idempotencyKey: `fee_${dealId}` },
  );

  await db.doc(`payments/${dealId}`).set(
    {
      dealId,
      landlordId: uid,
      amountPence: PLATFORM_FEE_PENCE,
      currency: 'gbp',
      stripePaymentIntentId: intent.id,
      status: intent.status,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  if (intent.status === 'succeeded') await completeDeal(dealId, intent.id);
  return { status: intent.status };
});

/** Stripe webhook — durable source of truth for fee capture. */
export const stripeWebhook = onRequest(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig as string, secret);
  } catch {
    res.status(400).send('Webhook signature verification failed.');
    return;
  }
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object as Stripe.PaymentIntent;
    const dealId = pi.metadata?.dealId;
    if (dealId) await completeDeal(dealId, pi.id);
  }
  res.json({ received: true });
});

/* ---- M6: compliance documents + notifications ---- */

interface PublishRequest {
  listingId: string;
}

/**
 * Server-authoritative listing publish. Re-runs the shared compliance gate
 * against the documents actually uploaded to the listing and only then flips it
 * `live`; otherwise it stays `draft`. Clients can edit a listing but can't set
 * its status (Firestore rules), so this is the single way a listing goes live.
 */
export const publishListing = onCall(async (req: CallableRequest<PublishRequest>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const listingId = req.data?.listingId;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId is required.');

  const ref = db.doc(`listings/${listingId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found.');
  const listing = snap.data() as Record<string, unknown>;
  if (listing.landlordId !== uid) throw new HttpsError('permission-denied', 'Not your listing.');

  const docs = (Array.isArray(listing.complianceDocs) ? listing.complianceDocs : []) as ComplianceDoc[];
  const { checks, canGoLive } = evaluateListingCompliance({
    nation: 'england',
    epcRating: (listing.epcRating as EpcRating) ?? 'D',
    hasGasSupply: Boolean(listing.hasGasSupply),
    smokeAlarmsPerStorey: Boolean(listing.smokeAlarmsPerStorey),
    coAlarmsWhereRequired: Boolean(listing.coAlarmsWhereRequired),
    docs,
  });

  const status = canGoLive ? 'live' : 'draft';
  await ref.update({ status, complianceCheckedAt: FieldValue.serverTimestamp() });
  return { status, checks };
});

/** Store a Web Push (FCM) token for the signed-in user. */
export const registerPushToken = onCall(async (req: CallableRequest<{ token: string }>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const token = req.data?.token;
  if (!token) throw new HttpsError('invalid-argument', 'token is required.');
  await db.doc(`users/${uid}`).set({ pushTokens: FieldValue.arrayUnion(token) }, { merge: true });
  return { ok: true };
});

/**
 * Notify the counterparty when a (non-system) message is posted. Builds the copy
 * from the shared kernel and fans out to the recipient's FCM tokens; an email
 * channel would hang off the same point. Best-effort — failures never block the
 * write that triggered it.
 */
export const onDealMessageCreated = onDocumentCreated('deals/{dealId}/messages/{msgId}', async (event) => {
  const msg = event.data?.data();
  if (!msg || msg.senderRole === 'system') return;

  const dealSnap = await db.doc(`deals/${event.params.dealId}`).get();
  if (!dealSnap.exists) return;
  const deal = dealSnap.data() as StoredDeal & { listingArea?: string; listingCity?: string };

  const senderIsRenter = msg.senderRole === 'renter';
  const recipientId = senderIsRenter ? deal.landlordId : deal.renterId;
  const fromName = senderIsRenter ? deal.renterName : deal.landlordName;
  const listingLabel = [deal.listingArea, deal.listingCity].filter(Boolean).join(', ') || 'your enquiry';

  const note = buildNotification('message', { fromName, listingLabel, preview: String(msg.text ?? '') });

  const tokens = ((await db.doc(`users/${recipientId}`).get()).data()?.pushTokens ?? []) as string[];
  if (tokens.length === 0) return; // no devices registered yet
  try {
    await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: note.title, body: note.body },
      data: { dealId: event.params.dealId },
    });
  } catch {
    // best-effort; an email fallback (e.g. Postmark/SendGrid) would go here.
  }
});
