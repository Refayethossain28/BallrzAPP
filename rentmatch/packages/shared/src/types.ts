/**
 * Core domain types for RentMatch, shared by the web client, the Cloud
 * Functions and any future native app. Framework-agnostic on purpose.
 */

/** UK nations — tenancy law diverges by nation. */
export type Nation = 'england' | 'wales' | 'scotland' | 'northern-ireland';

/** The legal tenancy instrument used in each nation. */
export type TenancyType =
  | 'assured-shorthold' // England (Housing Act 1988) — the MVP path
  | 'occupation-contract' // Wales (Renting Homes (Wales) Act 2016, from Dec 2022)
  | 'private-residential' // Scotland (Private Housing (Tenancies) (Scotland) Act 2016)
  | 'private-tenancy'; // Northern Ireland (Private Tenancies Act (NI) 2022)

/** Lifecycle stages of a landlord ↔ renter deal. */
export type DealStage =
  | 'enquiry'
  | 'viewing'
  | 'agreed'
  | 'contract'
  | 'signing'
  | 'completed'
  | 'cancelled';

/** EPC energy-efficiency band. F and G cannot legally be let (MEES). */
export type EpcRating = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

/** Documents whose presence/validity gate listing or signing. */
export type ComplianceDocType =
  | 'epc'
  | 'gas-safety'
  | 'eicr'
  | 'how-to-rent'
  | 'right-to-rent'
  | 'deposit-protection';

export interface ComplianceDoc {
  type: ComplianceDocType;
  /** epoch ms the document was issued */
  issuedAt?: number;
  /** epoch ms the document expires; absent ⇒ never expires */
  expiresAt?: number;
  reference?: string;
}

export interface Party {
  name: string;
  email: string;
}
