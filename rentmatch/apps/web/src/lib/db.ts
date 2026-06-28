/**
 * Firestore data access for M1 (auth, properties/listings, search).
 *
 * For MVP a "listing" is denormalised (property facts + advert + the compliance
 * inputs the shared kernel needs). Browsing/search runs client-side over live
 * listings via `searchListings`; this moves behind an index/Algolia later.
 */
import {
  collection, doc, getDoc, getDocs, query, where, addDoc, setDoc, updateDoc,
  serverTimestamp, Timestamp, onSnapshot, orderBy, or,
  type Unsubscribe,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from './firebase';
import {
  newDealRecord, recomputeStage,
  type ComplianceCheck, type ComplianceDoc, type ComplianceDocType, type DealParty,
  type DealRecord, type DealViewing, type EpcRating, type ListingSummary, type Subscription,
  type TenancyAgreement,
} from '@rentmatch/shared';

export type Role = 'renter' | 'landlord';

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  roles: { renter: boolean; landlord: boolean };
  activeRole: Role;
}

/** A full listing document (browsing fields + advert + compliance inputs). */
export interface Listing extends ListingSummary {
  street: string;
  desc: string;
  features: string[];
  landlordId: string;
  hasGasSupply: boolean;
  smokeAlarmsPerStorey: boolean;
  coAlarmsWhereRequired: boolean;
  complianceDocs: ComplianceDoc[];
}

const listingsCol = collection(db, 'listings');
const usersCol = collection(db, 'users');

/* ---- users ---- */

export async function ensureUserProfile(
  uid: string,
  email: string,
  displayName: string,
): Promise<UserProfile> {
  const ref = doc(usersCol, uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data() as UserProfile;
  const profile: UserProfile = {
    uid,
    email,
    displayName,
    roles: { renter: true, landlord: true },
    activeRole: 'renter',
  };
  await setDoc(ref, { ...profile, createdAt: serverTimestamp() });
  return profile;
}

export async function setActiveRole(uid: string, role: Role): Promise<void> {
  await updateDoc(doc(usersCol, uid), { activeRole: role });
}

/** The landlord's subscription as mirrored from Stripe by the billing webhook. */
export async function fetchSubscription(uid: string): Promise<Subscription | null> {
  const snap = await getDoc(doc(usersCol, uid));
  return (snap.data()?.subscription as Subscription | undefined) ?? null;
}

/* ---- listings ---- */

function toMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === 'number') return value;
  return Date.now();
}

function mapListing(id: string, data: Record<string, unknown>): Listing {
  return {
    id,
    title: String(data.title ?? ''),
    street: String(data.street ?? ''),
    area: String(data.area ?? ''),
    city: String(data.city ?? ''),
    postcode: String(data.postcode ?? ''),
    type: String(data.type ?? 'Flat'),
    beds: Number(data.beds ?? 0),
    baths: Number(data.baths ?? 1),
    rentPence: Number(data.rentPence ?? 0),
    furnished: String(data.furnished ?? 'Unfurnished'),
    epcRating: (data.epcRating ?? 'D') as EpcRating,
    availableFrom: toMillis(data.availableFrom),
    createdAt: toMillis(data.createdAt),
    status: (data.status ?? 'draft') as Listing['status'],
    desc: String(data.desc ?? ''),
    features: Array.isArray(data.features) ? (data.features as string[]) : [],
    landlordId: String(data.landlordId ?? ''),
    hasGasSupply: Boolean(data.hasGasSupply),
    smokeAlarmsPerStorey: Boolean(data.smokeAlarmsPerStorey),
    coAlarmsWhereRequired: Boolean(data.coAlarmsWhereRequired),
    complianceDocs: Array.isArray(data.complianceDocs) ? (data.complianceDocs as ComplianceDoc[]) : [],
  };
}

export async function fetchLiveListings(): Promise<Listing[]> {
  const snap = await getDocs(query(listingsCol, where('status', '==', 'live')));
  return snap.docs.map((d) => mapListing(d.id, d.data()));
}

export async function fetchListing(id: string): Promise<Listing | null> {
  const snap = await getDoc(doc(listingsCol, id));
  return snap.exists() ? mapListing(snap.id, snap.data()) : null;
}

export async function fetchLandlordListings(landlordId: string): Promise<Listing[]> {
  const snap = await getDocs(query(listingsCol, where('landlordId', '==', landlordId)));
  return snap.docs
    .map((d) => mapListing(d.id, d.data()))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export interface NewListingInput {
  landlordId: string;
  title: string;
  street: string;
  area: string;
  city: string;
  postcode: string;
  type: string;
  beds: number;
  baths: number;
  rentPence: number;
  furnished: string;
  epcRating: EpcRating;
  desc: string;
  hasGasSupply: boolean;
  smokeAlarmsPerStorey: boolean;
  coAlarmsWhereRequired: boolean;
}

/**
 * Create a listing as a `draft`. It only goes `live` once the landlord uploads
 * the required compliance documents and calls the server-authoritative
 * `publishListing` Cloud Function (clients can't set `status` directly).
 */
export async function createListing(input: NewListingInput): Promise<{ id: string }> {
  const ref = await addDoc(listingsCol, {
    ...input,
    status: 'draft',
    complianceDocs: [] as ComplianceDoc[],
    features: [input.furnished, `EPC ${input.epcRating}`, 'Available soon'],
    availableFrom: Timestamp.fromMillis(Date.now() + 14 * 86_400_000),
    createdAt: serverTimestamp(),
  });
  return { id: ref.id };
}

/** Default validity windows for each compliance document type. */
const DOC_VALIDITY_MS: Partial<Record<ComplianceDocType, number>> = {
  'gas-safety': 365 * 86_400_000, // annual
  eicr: 5 * 365 * 86_400_000, // 5-yearly
  epc: 10 * 365 * 86_400_000, // 10-yearly
};

/**
 * Upload a compliance document to Storage and record its metadata on the
 * listing (deduped by type). Status stays unchanged — publishing is a separate,
 * server-side step.
 */
export async function uploadComplianceDoc(
  listing: Listing,
  type: ComplianceDocType,
  file: File,
): Promise<void> {
  const path = `compliance/${listing.landlordId}/${listing.id}/${type}.pdf`;
  const r = storageRef(storage, path);
  await uploadBytes(r, file);
  const fileRef = await getDownloadURL(r);
  const now = Date.now();
  const expiresAt = DOC_VALIDITY_MS[type] != null ? now + DOC_VALIDITY_MS[type]! : undefined;

  const snap = await getDoc(doc(listingsCol, listing.id));
  const current = (snap.data()?.complianceDocs ?? []) as ComplianceDoc[];
  const next: ComplianceDoc[] = [
    ...current.filter((d) => d.type !== type),
    { type, issuedAt: now, ...(expiresAt ? { expiresAt } : {}), reference: fileRef },
  ];
  await updateDoc(doc(listingsCol, listing.id), { complianceDocs: next });
}

/* ---- deals, messaging & viewings (M2) ---- */

/** A deal document as stored in Firestore (DealRecord + ids and display data). */
export interface Deal extends DealRecord {
  id: string;
  listingId: string;
  renterId: string;
  landlordId: string;
  renterName: string;
  landlordName: string;
  listingArea: string;
  listingCity: string;
  rentPence: number;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  senderId: string;
  senderRole: DealParty | 'system';
  text: string;
  ts: number;
}

const dealsCol = collection(db, 'deals');
const toMs = (v: unknown): number => (v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : Date.now());

function mapDeal(id: string, d: Record<string, unknown>): Deal {
  const rec = newDealRecord();
  return {
    id,
    listingId: String(d.listingId ?? ''),
    renterId: String(d.renterId ?? ''),
    landlordId: String(d.landlordId ?? ''),
    renterName: String(d.renterName ?? 'Renter'),
    landlordName: String(d.landlordName ?? 'Landlord'),
    listingArea: String(d.listingArea ?? ''),
    listingCity: String(d.listingCity ?? ''),
    rentPence: Number(d.rentPence ?? 0),
    stage: (d.stage ?? 'enquiry') as Deal['stage'],
    viewing: (d.viewing as DealViewing | null) ?? null,
    agreed: (d.agreed as Deal['agreed']) ?? rec.agreed,
    contractDrafted: Boolean(d.contractDrafted),
    esignEnvelopeOpen: Boolean(d.esignEnvelopeOpen),
    signed: (d.signed as Deal['signed']) ?? rec.signed,
    feePaid: Boolean(d.feePaid),
    createdAt: toMs(d.createdAt),
    updatedAt: toMs(d.updatedAt),
  };
}

/** Find an existing renter↔listing deal, or create one with an opening message. */
export async function createOrGetDeal(
  listing: Listing,
  renter: { uid: string; name: string },
): Promise<string> {
  const existing = await getDocs(
    query(dealsCol, where('listingId', '==', listing.id), where('renterId', '==', renter.uid)),
  );
  if (!existing.empty) return existing.docs[0].id;

  const landlordSnap = await getDoc(doc(usersCol, listing.landlordId));
  const landlordName = landlordSnap.exists() ? String(landlordSnap.data().displayName ?? 'Landlord') : 'Landlord';

  const ref = await addDoc(dealsCol, {
    ...newDealRecord(),
    listingId: listing.id,
    renterId: renter.uid,
    landlordId: listing.landlordId,
    renterName: renter.name,
    landlordName,
    listingArea: listing.area,
    listingCity: listing.city,
    rentPence: listing.rentPence,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await sendMessage(ref.id, renter.uid, 'renter', "Hi, I'm interested in this property — is it still available?");
  await addSystemMessage(ref.id, 'Enquiry started. Say hello and arrange a viewing.');
  return ref.id;
}

/** Live subscription to the deals a user is part of, in either role. */
export function watchUserDeals(uid: string, cb: (deals: Deal[]) => void): Unsubscribe {
  const q = query(dealsCol, or(where('renterId', '==', uid), where('landlordId', '==', uid)));
  return onSnapshot(q, (snap) => {
    const deals = snap.docs.map((d) => mapDeal(d.id, d.data())).sort((a, b) => b.updatedAt - a.updatedAt);
    cb(deals);
  });
}

export function watchDeal(dealId: string, cb: (deal: Deal | null) => void): Unsubscribe {
  return onSnapshot(doc(dealsCol, dealId), (snap) => cb(snap.exists() ? mapDeal(snap.id, snap.data()) : null));
}

export function watchMessages(dealId: string, cb: (messages: Message[]) => void): Unsubscribe {
  const q = query(collection(dealsCol, dealId, 'messages'), orderBy('ts', 'asc'));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((m) => {
      const data = m.data();
      return {
        id: m.id,
        senderId: String(data.senderId ?? ''),
        senderRole: (data.senderRole ?? 'system') as Message['senderRole'],
        text: String(data.text ?? ''),
        ts: toMs(data.ts),
      };
    }));
  });
}

export async function sendMessage(dealId: string, senderId: string, senderRole: DealParty, text: string): Promise<void> {
  await addDoc(collection(dealsCol, dealId, 'messages'), { senderId, senderRole, text, ts: serverTimestamp() });
  await updateDoc(doc(dealsCol, dealId), { updatedAt: serverTimestamp() });
}

async function addSystemMessage(dealId: string, text: string): Promise<void> {
  await addDoc(collection(dealsCol, dealId, 'messages'), { senderId: 'system', senderRole: 'system', text, ts: serverTimestamp() });
}

/** Re-derive and persist the stage from the deal's facts, then nudge updatedAt. */
async function syncStage(deal: Deal, patch: Partial<DealRecord>): Promise<void> {
  const next: DealRecord = { ...deal, ...patch };
  await updateDoc(doc(dealsCol, deal.id), {
    ...patch,
    stage: recomputeStage(next),
    updatedAt: serverTimestamp(),
  });
}

export async function proposeViewing(deal: Deal, by: DealParty, ts: number): Promise<void> {
  await syncStage(deal, { viewing: { ts, status: 'proposed', proposedBy: by } });
  await addSystemMessage(deal.id, `${by === 'renter' ? deal.renterName : deal.landlordName} proposed a viewing for ${new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`);
}

export async function confirmViewing(deal: Deal): Promise<void> {
  if (!deal.viewing) return;
  await syncStage(deal, { viewing: { ...deal.viewing, status: 'confirmed' } });
  await addSystemMessage(deal.id, 'Viewing confirmed. ✅');
}

export async function agreeToProceed(deal: Deal, party: DealParty): Promise<void> {
  const agreed = { ...deal.agreed, [party]: true };
  await syncStage(deal, { agreed });
  const name = party === 'renter' ? deal.renterName : deal.landlordName;
  await addSystemMessage(deal.id, `${name} agreed to proceed to a tenancy.`);
  if (agreed.renter && agreed.landlord) {
    await addSystemMessage(deal.id, 'Both parties have agreed terms. The landlord can now draft the tenancy agreement.');
  }
}

/* ---- contracts (M3) ---- */

export interface Contract {
  dealId: string;
  renterId: string;
  landlordId: string;
  version: number;
  agreement: TenancyAgreement;
  compliance: ComplianceCheck[];
  feePence: number;
}

const contractsCol = collection(db, 'contracts');

export async function fetchContract(dealId: string): Promise<Contract | null> {
  const snap = await getDoc(doc(contractsCol, dealId));
  if (!snap.exists()) return null;
  const d = snap.data();
  return {
    dealId,
    renterId: String(d.renterId ?? ''),
    landlordId: String(d.landlordId ?? ''),
    version: Number(d.version ?? 1),
    agreement: d.agreement as TenancyAgreement,
    compliance: (d.compliance as ComplianceCheck[]) ?? [],
    feePence: Number(d.feePence ?? 0),
  };
}
