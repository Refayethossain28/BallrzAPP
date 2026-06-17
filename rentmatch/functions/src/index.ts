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
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  buildTenancyAgreement, evaluateSigningCompliance, recomputeStage,
  tenancyDepositCapPence, PLATFORM_FEE_PENCE,
  type DealRecord, type EpcRating, type Party,
} from '@rentmatch/shared';

initializeApp();
const db = getFirestore();

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
 * M4: open the e-sign envelope (stage → signing), then capture each signature
 * from the provider's webhook. On the "envelope complete" event, charge the
 * landlord's saved card for the £100 fee (idempotency key = dealId). — seam.
 */
// export const openSigning = onCall(...)
// export const esignWebhook = onRequest(...)

/**
 * M5: Stripe `payment_intent.succeeded` for the landlord fee → mark the deal
 * completed and the listing let, store the executed PDF, email receipts. — seam.
 */
// export const stripeWebhook = onRequest(...)
