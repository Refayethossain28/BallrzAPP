/**
 * Firestore data access for M1 (auth, properties/listings, search).
 *
 * For MVP a "listing" is denormalised (property facts + advert + the compliance
 * inputs the shared kernel needs). Browsing/search runs client-side over live
 * listings via `searchListings`; this moves behind an index/Algolia later.
 */
import {
  collection, doc, getDoc, getDocs, query, where, addDoc, setDoc, updateDoc,
  serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  evaluateListingCompliance,
  type ComplianceCheck, type ComplianceDoc, type EpcRating, type ListingSummary,
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

export interface CreateListingResult {
  id: string;
  status: Listing['status'];
  checks: ComplianceCheck[];
}

/**
 * Create a listing. The shared compliance kernel decides whether it can go
 * `live`; if any blocking statutory check fails it is saved as a `draft` and
 * the failing checks are returned so the UI can prompt the landlord.
 */
export async function createListing(input: NewListingInput): Promise<CreateListingResult> {
  // M1 records the attestations; actual document uploads land in M6.
  const docs: ComplianceDoc[] = [{ type: 'epc' }, { type: 'eicr' }];
  if (input.hasGasSupply) docs.push({ type: 'gas-safety' });
  const { checks, canGoLive } = evaluateListingCompliance({
    nation: 'england',
    epcRating: input.epcRating,
    hasGasSupply: input.hasGasSupply,
    smokeAlarmsPerStorey: input.smokeAlarmsPerStorey,
    coAlarmsWhereRequired: input.coAlarmsWhereRequired,
    docs,
  });
  const status: Listing['status'] = canGoLive ? 'live' : 'draft';
  const ref = await addDoc(listingsCol, {
    ...input,
    status,
    features: [input.furnished, `EPC ${input.epcRating}`, 'Available soon'],
    availableFrom: Timestamp.fromMillis(Date.now() + 14 * 86_400_000),
    createdAt: serverTimestamp(),
  });
  return { id: ref.id, status, checks };
}
