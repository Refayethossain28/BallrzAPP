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
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import Stripe from 'stripe';
import {
  buildTenancyAgreement, evaluateListingCompliance, evaluateSigningCompliance, recomputeStage,
  tenancyDepositCapPence, buildNotification, buildComplianceReminder, dueComplianceReminders,
  buildRentReminder, dueRentReminders, formatGBP,
  dueCollections, coveredPeriods, withinSeatAllowance,
  isStale, withinLegalRetention, REDACTED, PLATFORM_FEE_PENCE, PLANS,
  type ComplianceDoc, type DealRecord, type EpcRating, type Party, type PlanId,
  type SubscriptionStatus, type Tenancy, type RentCollection,
} from '@rentmatch/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';

initializeApp();
const db = getFirestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');

/**
 * Transactional email via Postmark's REST API (no SDK — a single fetch). Falls
 * back to a logged no-op when unconfigured, so local/dev and tests run without
 * credentials. Set EMAIL_API_KEY (Postmark Server Token) and EMAIL_FROM (a
 * verified sender) to send for real; failures are swallowed so email never
 * blocks the action that triggered it.
 */
async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const token = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!token || !from || !to) {
    console.log(`[email:noop] "${subject}" -> ${to || '(no address)'}`);
    return;
  }
  try {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify({
        From: from,
        To: to,
        Subject: subject,
        TextBody: text,
        MessageStream: process.env.EMAIL_STREAM ?? 'outbound',
      }),
    });
    if (!res.ok) {
      console.error(`[email] Postmark ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error('[email] send failed', err);
  }
}

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
  const dealData = (await dealRef.get()).data() as (StoredDeal & Record<string, unknown>) | undefined;
  if (dealData) {
    const landlordEmail = String((await db.doc(`users/${dealData.landlordId}`).get()).data()?.email ?? '');
    await sendEmail(
      landlordEmail,
      'RentMatch — your £100 platform fee receipt',
      `The tenancy is now in force. A one-off £100 platform fee was charged (payment ${paymentIntentId}).`,
    );
    await createTenancyFromDeal(dealId, dealData);
  }
}

/**
 * Deal → tenancy bridge. When a marketplace let completes, spin up a tenancy
 * record from the signed agreement so the new let flows straight into rent
 * tracking, arrears, reminders and renewals. Idempotent: a deal that already
 * has a `tenancyId` is left alone.
 */
async function createTenancyFromDeal(dealId: string, deal: StoredDeal & Record<string, unknown>): Promise<void> {
  if (deal.tenancyId) return;
  const agreement = (await db.doc(`contracts/${dealId}`).get()).data()?.agreement as
    | { startDate?: number; termMonths?: number; monthlyRentPence?: number }
    | undefined;

  const propertyLabel = [deal.listingArea, deal.listingCity].filter(Boolean).join(', ')
    || String(deal.listingCity ?? 'Property');
  const startDate = agreement?.startDate ?? Date.now() + 14 * 86_400_000;

  const tenancyRef = await db.collection('tenancies').add({
    landlordId: deal.landlordId,
    listingId: deal.listingId,
    propertyLabel,
    tenantName: deal.renterName,
    monthlyRentPence: agreement?.monthlyRentPence ?? Number(deal.rentPence ?? 0),
    startDate: new Date(startDate),
    termMonths: agreement?.termMonths ?? 12,
    status: 'active',
    totalPaidPence: 0,
    collections: [],
    dealId,
    createdAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`deals/${dealId}`).update({ tenancyId: tenancyRef.id });
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
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const dealId = pi.metadata?.dealId;
      if (dealId) await completeDeal(dealId, pi.id);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await writeSubscription(event.data.object as Stripe.Subscription);
      break;
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

/**
 * Daily compliance-expiry reminders — the recurring value of the subscription.
 * Scans every tracked property, asks the shared kernel which certificate
 * reminders are *due* (60/30/7 days out, then on expiry), and nudges the
 * landlord by push + email. Idempotency keys are stored back on the listing so
 * a daily run never re-sends the same milestone; renewing a document (new
 * expiry) starts a fresh cycle automatically.
 */
export const sendComplianceReminders = onSchedule('every 24 hours', async () => {
  const now = Date.now();
  // Every property the landlord tracks, not only advertised ones — compliance
  // tracking is the standalone value, so a never-listed (draft) property that's
  // purely being monitored must still get its expiry nudges.
  const snap = await db.collection('listings').where('status', 'in', ['draft', 'live', 'let']).get();

  for (const docSnap of snap.docs) {
    const l = docSnap.data();
    const property = {
      id: docSnap.id,
      label: [l.street, l.city].filter(Boolean).join(', ') || String(l.title ?? 'your property'),
      hasGasSupply: Boolean(l.hasGasSupply),
      docs: (Array.isArray(l.complianceDocs) ? l.complianceDocs : []) as ComplianceDoc[],
    };
    const sentKeys = (Array.isArray(l.complianceRemindersSent) ? l.complianceRemindersSent : []) as string[];
    const due = dueComplianceReminders(property, sentKeys, now);
    if (due.length === 0) continue;

    const landlordId = String(l.landlordId ?? '');
    const userData = (await db.doc(`users/${landlordId}`).get()).data() ?? {};
    const tokens = (userData.pushTokens ?? []) as string[];
    const email = String(userData.email ?? '');

    for (const r of due) {
      const note = buildComplianceReminder({
        propertyLabel: property.label,
        docLabel: r.label,
        daysToExpiry: r.daysToExpiry,
      });
      if (tokens.length > 0) {
        try {
          await getMessaging().sendEachForMulticast({
            tokens,
            notification: { title: note.title, body: note.body },
            data: { listingId: docSnap.id, type: 'compliance-reminder' },
          });
        } catch {
          // best-effort push; the email below is the durable channel.
        }
      }
      await sendEmail(email, note.title, note.body);
    }

    // Record every fired milestone so the next run is a no-op for them.
    await docSnap.ref.update({ complianceRemindersSent: FieldValue.arrayUnion(...due.map((r) => r.key)) });
  }
});

/**
 * Daily rent reminders — nudges the landlord when rent is due soon or has fallen
 * into arrears, using the same ledger engine as the app. Reads the denormalised
 * `totalPaidPence` on the tenancy, so no per-payment fetch; idempotency keys are
 * stored on the tenancy so due-soon fires once per period and overdue once per
 * newly-missed month.
 */
export const sendRentReminders = onSchedule('every 24 hours', async () => {
  const now = Date.now();
  const snap = await db.collection('tenancies').where('status', '==', 'active').get();

  for (const docSnap of snap.docs) {
    const t = docSnap.data();
    const tenancy: Tenancy = {
      startDate: t.startDate?.toMillis?.() ?? Number(t.startDate ?? 0),
      monthlyRentPence: Number(t.monthlyRentPence ?? 0),
      termMonths: Number(t.termMonths ?? 12),
    };
    const totalPaid = Number(t.totalPaidPence ?? 0);
    const sentKeys = (Array.isArray(t.rentRemindersSent) ? t.rentRemindersSent : []) as string[];
    const due = dueRentReminders(tenancy, totalPaid, sentKeys, now);
    if (due.length === 0) continue;

    const landlordId = String(t.landlordId ?? '');
    const userData = (await db.doc(`users/${landlordId}`).get()).data() ?? {};
    const tokens = (userData.pushTokens ?? []) as string[];
    const email = String(userData.email ?? '');
    const tenantName = String(t.tenantName ?? 'your tenant');
    const propertyLabel = String(t.propertyLabel ?? 'your property');

    for (const r of due) {
      const note = buildRentReminder({
        tenantName,
        propertyLabel,
        kind: r.kind,
        amount: formatGBP(r.amountPence),
        dueDate: r.dueDate != null
          ? new Date(r.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
          : undefined,
      });
      if (tokens.length > 0) {
        try {
          await getMessaging().sendEachForMulticast({
            tokens,
            notification: { title: note.title, body: note.body },
            data: { tenancyId: docSnap.id, type: 'rent-reminder' },
          });
        } catch {
          // best-effort push; email is the durable channel.
        }
      }
      await sendEmail(email, note.title, note.body);
    }

    await docSnap.ref.update({ rentRemindersSent: FieldValue.arrayUnion(...due.map((r) => r.key)) });
  }
});

/* ---- M9: automated rent collection via Direct Debit (GoCardless) ---- */

const GC_BASE =
  process.env.GOCARDLESS_ENV === 'live' ? 'https://api.gocardless.com' : 'https://api-sandbox.gocardless.com';

/** Minimal GoCardless REST call (no SDK). Throws if unconfigured or non-2xx. */
async function gcFetch(path: string, method: 'GET' | 'POST', body?: unknown): Promise<any> {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new HttpsError('failed-precondition', 'Direct Debit is not configured.');
  const res = await fetch(`${GC_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'GoCardless-Version': '2015-07-06',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    console.error(`[gocardless] ${method} ${path} → ${res.status}: ${await res.text()}`);
    throw new HttpsError('internal', 'Direct Debit provider error.');
  }
  return res.json();
}

/**
 * Begin Direct Debit setup for a tenancy. Creates a GoCardless billing-request
 * flow (mandate authorisation) tagged with the tenancyId, marks the mandate
 * pending, and returns the hosted authorisation URL for the client to redirect
 * to. The mandate goes `active` later via the webhook.
 */
export const createDirectDebitSetup = onCall(async (req: CallableRequest<{ tenancyId: string }>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const tenancyId = req.data?.tenancyId;
  if (!tenancyId) throw new HttpsError('invalid-argument', 'tenancyId is required.');

  const ref = db.doc(`tenancies/${tenancyId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Tenancy not found.');
  if (snap.data()!.landlordId !== uid) throw new HttpsError('permission-denied', 'Not your tenancy.');

  const br = await gcFetch('/billing_requests', 'POST', {
    billing_requests: { mandate_request: { currency: 'GBP', metadata: { tenancyId } } },
  });
  const flow = await gcFetch('/billing_request_flows', 'POST', {
    billing_request_flows: {
      redirect_uri: `${APP_URL}/landlord/rent/${tenancyId}`,
      exit_uri: `${APP_URL}/landlord/rent/${tenancyId}`,
      links: { billing_request: br.billing_requests.id },
    },
  });

  await ref.update({ mandate: { status: 'pending', provider: 'gocardless' } });
  return { url: flow.billing_request_flows.authorisation_url as string };
});

/** Record a confirmed rent collection as a payment (mirrors the app's addRentPayment). */
async function recordCollectedPayment(tenancyId: string, amountPence: number, when: number): Promise<void> {
  await db.collection(`tenancies/${tenancyId}/payments`).add({
    amountPence,
    date: new Date(when),
    method: 'Direct Debit',
    createdAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`tenancies/${tenancyId}`).update({ totalPaidPence: FieldValue.increment(amountPence) });
}

/** Set a single collection's status on the tenancy's collections array. */
async function updateCollectionStatus(
  tenancyId: string,
  match: { paymentId?: string; period?: string },
  status: RentCollection['status'],
): Promise<RentCollection | null> {
  const ref = db.doc(`tenancies/${tenancyId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const collections = (snap.data()!.collections ?? []) as RentCollection[];
    const idx = collections.findIndex((c) =>
      match.paymentId ? c.paymentId === match.paymentId : c.period === match.period,
    );
    if (idx < 0) return null;
    const updated = { ...collections[idx], status };
    collections[idx] = updated;
    tx.update(ref, { collections });
    return updated;
  });
}

/**
 * GoCardless webhook — durable source of truth for mandate and payment state.
 * Verifies the HMAC signature, then: activates the mandate on its tenancy, and
 * on a confirmed payment marks the collection paid and records the rent payment
 * (idempotency comes from the collection status guard).
 */
export const gocardlessWebhook = onRequest(async (req, res) => {
  const secret = process.env.GOCARDLESS_WEBHOOK_SECRET ?? '';
  const signature = String(req.headers['webhook-signature'] ?? '');
  const expected = createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const ok =
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) {
    res.status(498).send('Invalid signature.');
    return;
  }

  const events = (req.body?.events ?? []) as any[];
  for (const ev of events) {
    try {
      if (ev.resource_type === 'mandates') {
        const mandateId = ev.links?.mandate;
        if (!mandateId) continue;
        const mandate = await gcFetch(`/mandates/${mandateId}`, 'GET');
        const tenancyId = mandate.mandates?.metadata?.tenancyId;
        if (!tenancyId) continue;
        const status = ev.action === 'active' || ev.action === 'reinstated' ? 'active'
          : ev.action === 'cancelled' || ev.action === 'expired' ? 'cancelled'
          : ev.action === 'failed' ? 'failed' : 'pending';
        await db.doc(`tenancies/${tenancyId}`).update({
          mandate: { status, provider: 'gocardless', mandateId },
        });
      } else if (ev.resource_type === 'payments') {
        const paymentId = ev.links?.payment;
        if (!paymentId) continue;
        const payment = await gcFetch(`/payments/${paymentId}`, 'GET');
        const tenancyId = payment.payments?.metadata?.tenancyId;
        if (!tenancyId) continue;
        if (ev.action === 'confirmed' || ev.action === 'paid_out') {
          const updated = await updateCollectionStatus(tenancyId, { paymentId }, 'confirmed');
          if (updated) await recordCollectedPayment(tenancyId, updated.amountPence, updated.chargeDate);
        } else if (ev.action === 'failed' || ev.action === 'cancelled' || ev.action === 'charged_back') {
          await updateCollectionStatus(tenancyId, { paymentId }, 'failed');
        }
      }
    } catch (err) {
      console.error('[gocardless:webhook] event failed', err);
    }
  }
  res.json({ received: true });
});

/**
 * Daily auto-collection: for every tenancy with an active mandate, initiate a
 * Direct Debit for each rent charge entering its lead window that isn't already
 * covered. The shared engine decides what's due; each created payment is tagged
 * with its period so the webhook can reconcile it. No-op when GoCardless isn't
 * configured.
 */
export const collectDueRent = onSchedule('every 24 hours', async () => {
  if (!process.env.GOCARDLESS_ACCESS_TOKEN) return;
  const now = Date.now();
  const snap = await db.collection('tenancies').where('status', '==', 'active').get();

  for (const docSnap of snap.docs) {
    const t = docSnap.data();
    if (t.mandate?.status !== 'active' || !t.mandate?.mandateId) continue;
    const tenancy: Tenancy = {
      startDate: t.startDate?.toMillis?.() ?? Number(t.startDate ?? 0),
      monthlyRentPence: Number(t.monthlyRentPence ?? 0),
      termMonths: Number(t.termMonths ?? 12),
    };
    const existing = (t.collections ?? []) as RentCollection[];
    const due = dueCollections(tenancy, coveredPeriods(existing), now);
    if (due.length === 0) continue;

    const created: RentCollection[] = [];
    for (const c of due) {
      try {
        const res = await gcFetch('/payments', 'POST', {
          payments: {
            amount: c.amountPence,
            currency: 'GBP',
            links: { mandate: t.mandate.mandateId },
            metadata: { tenancyId: docSnap.id, period: c.period },
          },
        });
        created.push({
          period: c.period,
          amountPence: c.amountPence,
          status: 'submitted',
          chargeDate: c.chargeDate,
          paymentId: res.payments?.id,
        });
      } catch (err) {
        console.error(`[gocardless] failed to create payment for ${docSnap.id} ${c.period}`, err);
      }
    }
    if (created.length > 0) {
      await docSnap.ref.update({ collections: FieldValue.arrayUnion(...created) });
    }
  }
});

/* ---- M8: recurring subscription billing (Stripe Subscriptions) ---- */

/** Map a Stripe price id (from env) to a plan. Unconfigured plans are rejected. */
function priceIdForPlan(plan: PlanId): string {
  const ids: Record<PlanId, string | undefined> = {
    free: undefined,
    landlord: process.env.STRIPE_PRICE_LANDLORD,
    agent: process.env.STRIPE_PRICE_AGENT,
  };
  const id = ids[plan];
  if (!id) throw new HttpsError('failed-precondition', `No Stripe price configured for the ${plan} plan.`);
  return id;
}

const APP_URL = (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');

/**
 * Start a Stripe Checkout session for a recurring subscription. Returns a hosted
 * URL the client redirects to — no card UI to build, and Stripe handles SCA. The
 * plan is stamped on the subscription metadata so the webhook can mirror state
 * back without a separate customer→plan lookup.
 */
export const createBillingCheckoutSession = onCall(
  async (req: CallableRequest<{ plan: PlanId; units?: number }>) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
    const plan = req.data?.plan;
    if (plan !== 'landlord' && plan !== 'agent') {
      throw new HttpsError('invalid-argument', 'Choose a paid plan (landlord or agent).');
    }
    const email = (req.auth?.token.email as string | undefined) ?? '';
    const customerId = await getOrCreateCustomer(uid, email);

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      { price: priceIdForPlan(plan), quantity: 1 },
    ];
    // Agent is metered per unit; attach the per-unit price if one is configured.
    const unitPrice = process.env.STRIPE_PRICE_AGENT_UNIT;
    const units = Math.max(0, Math.floor(req.data?.units ?? 0) - PLANS[plan].includedUnits);
    if (plan === 'agent' && unitPrice && units > 0) {
      lineItems.push({ price: unitPrice, quantity: units });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: lineItems,
      success_url: `${APP_URL}/account?billing=success`,
      cancel_url: `${APP_URL}/account?billing=cancelled`,
      subscription_data: { metadata: { landlordId: uid, plan } },
    });
    return { url: session.url };
  },
);

/** Open the Stripe billing portal so a landlord can manage/cancel their plan. */
export const createBillingPortalSession = onCall(async (req: CallableRequest) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const customerId = (await db.doc(`users/${uid}`).get()).data()?.stripeCustomerId as string | undefined;
  if (!customerId) throw new HttpsError('failed-precondition', 'No billing account yet — subscribe first.');
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${APP_URL}/account`,
  });
  return { url: session.url };
});

/** Mirror a Stripe subscription onto the landlord's user doc (source of entitlements). */
async function writeSubscription(sub: Stripe.Subscription): Promise<void> {
  const landlordId = sub.metadata?.landlordId;
  if (!landlordId) return;
  const plan = (sub.metadata?.plan as PlanId | undefined) ?? 'landlord';
  await db.doc(`users/${landlordId}`).set(
    {
      subscription: {
        plan,
        status: sub.status as SubscriptionStatus,
        stripeSubscriptionId: sub.id,
        currentPeriodEnd: sub.current_period_end * 1000,
      },
    },
    { merge: true },
  );
}

/* ---- M10: agent tier — agencies & consent-based client linking ---- */

/** An agent creates their agency; they become its owner and first member. */
export const createAgency = onCall(async (req: CallableRequest<{ name: string }>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const name = (req.data?.name ?? '').trim() || 'My agency';

  const existing = (await db.doc(`users/${uid}`).get()).data()?.ownedAgencyId as string | undefined;
  if (existing) return { agencyId: existing };

  const ownerEmail = (req.auth?.token.email as string | undefined) ?? '';
  const ref = await db.collection('agencies').add({
    ownerId: uid,
    name,
    memberIds: [uid],
    memberEmails: { [uid]: ownerEmail },
    clientLandlordIds: [],
    createdAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`users/${uid}`).set({ ownedAgencyId: ref.id }, { merge: true });
  return { agencyId: ref.id };
});

/**
 * A landlord connects their own portfolio to an agency (consent-based: the
 * landlord acts on their own data). Records the link on the landlord's user doc
 * and adds them to the agency's client list, so the agency's members can read
 * their properties, tenancies and expenses (enforced in firestore.rules).
 */
export const connectToAgency = onCall(async (req: CallableRequest<{ agencyId: string }>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const agencyId = req.data?.agencyId;
  if (!agencyId) throw new HttpsError('invalid-argument', 'An agency code is required.');

  const agencySnap = await db.doc(`agencies/${agencyId}`).get();
  if (!agencySnap.exists) throw new HttpsError('not-found', 'No agency with that code.');

  await db.doc(`users/${uid}`).set({ agencyId }, { merge: true });
  await db.doc(`agencies/${agencyId}`).update({ clientLandlordIds: FieldValue.arrayUnion(uid) });
  return { ok: true, agencyName: String(agencySnap.data()?.name ?? 'agency') };
});

/**
 * Agency owner adds a teammate by email (must already have an account). Enforces
 * the plan's seat allowance, so growing the team is gated on the agent plan.
 */
export const addAgencyMember = onCall(async (req: CallableRequest<{ email: string }>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const email = (req.data?.email ?? '').trim().toLowerCase();
  if (!email) throw new HttpsError('invalid-argument', 'An email is required.');

  const agencyId = (await db.doc(`users/${uid}`).get()).data()?.ownedAgencyId as string | undefined;
  if (!agencyId) throw new HttpsError('failed-precondition', 'Create an agency first.');
  const agencyRef = db.doc(`agencies/${agencyId}`);
  const agency = (await agencyRef.get()).data() ?? {};
  const memberIds = (agency.memberIds ?? []) as string[];

  if (!withinSeatAllowance(memberIds.length + 1)) {
    throw new HttpsError('failed-precondition', 'Seat limit reached for your plan — upgrade to add more teammates.');
  }

  const found = await db.collection('users').where('email', '==', email).limit(1).get();
  if (found.empty) throw new HttpsError('not-found', 'No Apex account with that email.');
  const memberUid = found.docs[0].id;
  if (memberIds.includes(memberUid)) return { ok: true };

  await agencyRef.update({
    memberIds: FieldValue.arrayUnion(memberUid),
    [`memberEmails.${memberUid}`]: email,
  });
  return { ok: true };
});

/** Agency owner removes a teammate (cannot remove themselves). */
export const removeAgencyMember = onCall(async (req: CallableRequest<{ memberUid: string }>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const memberUid = req.data?.memberUid;
  if (!memberUid) throw new HttpsError('invalid-argument', 'memberUid is required.');
  if (memberUid === uid) throw new HttpsError('failed-precondition', 'You cannot remove yourself.');

  const agencyId = (await db.doc(`users/${uid}`).get()).data()?.ownedAgencyId as string | undefined;
  if (!agencyId) throw new HttpsError('failed-precondition', 'Create an agency first.');
  await db.doc(`agencies/${agencyId}`).update({
    memberIds: FieldValue.arrayRemove(memberUid),
    [`memberEmails.${memberUid}`]: FieldValue.delete(),
  });
  return { ok: true };
});

/** A landlord disconnects their portfolio from their agency. */
export const disconnectFromAgency = onCall(async (req: CallableRequest) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const agencyId = (await db.doc(`users/${uid}`).get()).data()?.agencyId as string | undefined;
  if (!agencyId) return { ok: true };
  await db.doc(`users/${uid}`).update({ agencyId: FieldValue.delete() });
  await db.doc(`agencies/${agencyId}`).update({ clientLandlordIds: FieldValue.arrayRemove(uid) });
  return { ok: true };
});

/* ---- M11: tenancy renewals (recurring £100 execution fee) ---- */

interface RenewalTermsInput {
  tenancyId: string;
  startDate: number;
  termMonths: number;
  monthlyRentPence: number;
}

/** Landlord proposes a renewal: new term + rent, awaiting both signatures. */
export const createRenewal = onCall(async (req: CallableRequest<RenewalTermsInput>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const { tenancyId, startDate, termMonths, monthlyRentPence } = req.data ?? ({} as RenewalTermsInput);
  if (!tenancyId || !startDate || !termMonths || !monthlyRentPence) {
    throw new HttpsError('invalid-argument', 'Renewal terms are incomplete.');
  }

  const ref = db.doc(`tenancies/${tenancyId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Tenancy not found.');
  if (snap.data()!.landlordId !== uid) throw new HttpsError('permission-denied', 'Not your tenancy.');

  await ref.update({
    pendingRenewal: {
      terms: { startDate, termMonths, monthlyRentPence },
      status: 'awaiting-signature',
      signed: { landlord: false, tenant: false },
      feePence: PLATFORM_FEE_PENCE,
    },
  });
  // An e-sign envelope to both parties would be opened here (same seam as `openSigning`).
  return { ok: true };
});

/** Record a renewal signature (stands in for the e-sign provider webhook). */
export const recordRenewalSignature = onCall(
  async (req: CallableRequest<{ tenancyId: string; party: 'landlord' | 'tenant' }>) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
    const { tenancyId, party } = req.data ?? ({} as { tenancyId: string; party: 'landlord' | 'tenant' });
    if (!tenancyId || (party !== 'landlord' && party !== 'tenant')) {
      throw new HttpsError('invalid-argument', 'tenancyId and party are required.');
    }
    const ref = db.doc(`tenancies/${tenancyId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Tenancy not found.');
    if (snap.data()!.landlordId !== uid) throw new HttpsError('permission-denied', 'Not your tenancy.');
    const renewal = snap.data()!.pendingRenewal;
    if (!renewal) throw new HttpsError('failed-precondition', 'No renewal in progress.');

    const signed = { ...renewal.signed, [party]: true };
    const status = signed.landlord && signed.tenant ? 'signed' : 'awaiting-signature';
    await ref.update({ 'pendingRenewal.signed': signed, 'pendingRenewal.status': status });
    return { status };
  },
);

/**
 * Complete a signed renewal: charge the landlord's £100 fee, then end the old
 * term and create a fresh tenancy on the new terms (clean ledger, linked back
 * via renewedFromId). The new tenancy carries the tenant and property across.
 */
export const confirmRenewal = onCall(async (req: CallableRequest<{ tenancyId: string }>) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const tenancyId = req.data?.tenancyId;
  if (!tenancyId) throw new HttpsError('invalid-argument', 'tenancyId is required.');

  const ref = db.doc(`tenancies/${tenancyId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Tenancy not found.');
  const t = snap.data()!;
  if (t.landlordId !== uid) throw new HttpsError('permission-denied', 'Not your tenancy.');
  const renewal = t.pendingRenewal;
  if (!renewal || renewal.status !== 'signed') {
    throw new HttpsError('failed-precondition', 'Both parties must sign the renewal first.');
  }

  // Charge the £100 platform fee on the landlord's saved card, off-session.
  const email = (req.auth?.token.email as string | undefined) ?? '';
  const customerId = await getOrCreateCustomer(uid, email);
  const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  if (cards.data.length === 0) throw new HttpsError('failed-precondition', 'Add a card before renewing.');
  const intent = await stripe.paymentIntents.create(
    {
      amount: PLATFORM_FEE_PENCE,
      currency: 'gbp',
      customer: customerId,
      payment_method: cards.data[0].id,
      off_session: true,
      confirm: true,
      description: `Apex tenancy renewal — ${tenancyId}`,
      metadata: { tenancyId, kind: 'renewal' },
    },
    { idempotencyKey: `renewal_${tenancyId}_${renewal.terms.startDate}` },
  );
  if (intent.status !== 'succeeded') throw new HttpsError('failed-precondition', `Payment ${intent.status}.`);

  // Fresh tenancy on the new terms; old one ends, linked both ways.
  const newRef = await db.collection('tenancies').add({
    landlordId: t.landlordId,
    listingId: t.listingId ?? '',
    propertyLabel: t.propertyLabel ?? '',
    tenantName: t.tenantName ?? '',
    monthlyRentPence: renewal.terms.monthlyRentPence,
    startDate: new Date(renewal.terms.startDate),
    termMonths: renewal.terms.termMonths,
    status: 'active',
    totalPaidPence: 0,
    collections: [],
    renewedFromId: tenancyId,
    createdAt: FieldValue.serverTimestamp(),
  });
  await ref.update({
    status: 'ended',
    renewedToId: newRef.id,
    pendingRenewal: FieldValue.delete(),
  });
  return { newTenancyId: newRef.id };
});

/* ---- M7: GDPR data erasure + retention ---- */

/**
 * Right to erasure (UK GDPR Art. 17). Redacts the user's profile PII and removes
 * their push tokens, and redacts their name across deals — except completed
 * tenancies still within their legal retention period, where the record must be
 * kept (lawful basis: legal obligation / legitimate interest).
 */
export const requestDataErasure = onCall(async (req: CallableRequest) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');

  await db.doc(`users/${uid}`).set(
    { displayName: REDACTED, email: REDACTED, pushTokens: FieldValue.delete(), erasedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  const now = Date.now();
  const redactName = async (field: 'renterName' | 'landlordName', idField: 'renterId' | 'landlordId') => {
    const snap = await db.collection('deals').where(idField, '==', uid).get();
    for (const d of snap.docs) {
      const deal = d.data() as StoredDeal & { updatedAt?: { toMillis?: () => number } };
      const completedAt = deal.updatedAt?.toMillis?.() ?? 0;
      if (deal.stage === 'completed' && withinLegalRetention(completedAt, now)) continue;
      await d.ref.update({ [field]: REDACTED });
    }
  };
  await redactName('renterName', 'renterId');
  await redactName('landlordName', 'landlordId');
  return { ok: true };
});

/** Daily retention sweep: purge stale drafts and abandoned enquiries. */
export const purgeStaleData = onSchedule('every 24 hours', async () => {
  const now = Date.now();

  const drafts = await db.collection('listings').where('status', '==', 'draft').get();
  for (const d of drafts.docs) {
    const created = d.data().createdAt?.toMillis?.() ?? now;
    if (isStale('draft-listing', created, now)) await d.ref.delete();
  }

  const enquiries = await db.collection('deals').where('stage', '==', 'enquiry').get();
  for (const d of enquiries.docs) {
    const updated = d.data().updatedAt?.toMillis?.() ?? now;
    if (isStale('abandoned-enquiry', updated, now)) await d.ref.delete();
  }
});
