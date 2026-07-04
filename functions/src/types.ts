/**
 * ApexVIP — Firestore document shapes & callable I/O types.
 *
 * These describe the documents the Cloud Functions read and write. They are the
 * single place to see (and correct) the field names the three apps and the
 * backend must agree on — the reconciliation hazard called out in
 * docs/apexvip-backend-consolidation.md. All fields are optional because
 * documents are written incrementally from several clients; the functions defend
 * with `|| default` exactly as before. Cast a snapshot's `.data()` to one of
 * these at the read boundary, e.g. `snap.data() as Booking`.
 */

import type { FieldValue, Timestamp } from 'firebase-admin/firestore';

/** A Firestore timestamp as it can appear when read back (or being written). */
export type Stamp = Timestamp | FieldValue;

export type UserRole = 'admin' | 'driver' | 'client';

/** users/{uid} */
export interface User {
  role?: UserRole;
  referralCode?: string;
  referredBy?: string;
  apexBalance?: number;
  /** Signature-verified external wallet (set only by linkChainWallet) —
   *  the sole wallet whose on-chain deposits credit this account. */
  chainAddress?: string;
}

/** bookings/{bookingId} — the central object the three apps share. */
export interface Booking {
  status?: string; // 'pending'|'confirmed'|'paid'|'driver_assigned'|'en_route'|'arriving'|'completed'|'cancelled'
  ref?: string;
  bookingRef?: string;
  squarePaymentId?: string;

  clientId?: string;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  email?: string;
  phone?: string;

  driverId?: string;
  driverName?: string;

  baseFare?: number;
  price?: number;
  currency?: string;
  /** APEX applied against this fare at checkout (set by the client for display;
   *  the authoritative deduction is the coin_ledger redeem row). */
  apexRedeemed?: number;

  pickup?: string;
  dropoff?: string;
  airport?: string;
  date?: string;
  time?: string;

  serviceType?: string;
  serviceLabel?: string;
  vehicle?: string;
  flight?: string;
  location?: string; // market, e.g. 'london'
  concierge?: { instructions?: string };

  rating?: number;
  ratingComment?: string;
  ratedAt?: Stamp;
}

/** open_jobs/{bookingId} — a booking surfaced to the driver app for claiming. */
export interface OpenJob {
  status: 'open' | string;
  market: string;
  bookingDocId: string;
  bookingRef: string;
  clientId: string;
  clientName: string;
  type: string;
  serviceLabel: string;
  pickup: string;
  dropoff: string;
  date: string;
  time: string;
  vehicle: string;
  flight: string;
  notes: string;
  pay: number;
  createdAt: Stamp;
}

/** A single vetted credential under drivers/{id}.compliance.docs. */
export interface ComplianceDoc {
  approved?: boolean;
  expiresAt?: string; // ISO YYYY-MM-DD
}

export interface DriverPayoutProfile {
  provider?: 'stripe' | string;
  accountId?: string;
  status?: 'onboarding' | 'active' | 'restricted' | string;
  detailsSubmitted?: boolean;
  payoutsEnabled?: boolean;
  mock?: boolean;
}

/** drivers/{driverId} */
export interface Driver {
  name?: string;
  email?: string;
  rating?: number;
  ratingCount?: number;
  ratingSum?: number;
  /** AXC wallet balance — written only by the coin ledger functions. */
  apexcoin?: number;
  compliance?: {
    compliant?: boolean;
    docs?: Record<string, ComplianceDoc>;
  };
  payout?: DriverPayoutProfile;
}

/**
 * coin_ledger/{id} — the append-only ApexCoin ledger, one row per earn/redeem.
 * Written exclusively by Cloud Functions (deterministic ids make the
 * booking-triggered awards idempotent); a user may read their own rows.
 */
export interface CoinLedgerEntry {
  uid: string;
  role: 'client' | 'driver';
  type: 'earn' | 'redeem' | 'withdraw' | 'deposit';
  amount: number;
  reason: string;
  ref?: string;
  at?: Stamp;
  /** On-chain rows: the mint/deposit transaction hash + confirmation state. */
  txHash?: string;
  status?: 'confirmed' | string;
}

/** vehicles/{id} */
export interface Vehicle {
  driverId?: string;
  reg?: string;
  active?: boolean;
  motExpiry?: string; // ISO YYYY-MM-DD
  taxExpiry?: string; // ISO YYYY-MM-DD
}

/** driver_payouts/{bookingId} — the 80%-per-trip earnings ledger. */
export interface DriverPayout {
  driverId: string;
  bookingRef: string;
  amount: number;
  currency: string;
  status: 'owed' | 'paid';
  createdAt?: Stamp;
  paidAt?: Stamp;
  transferId?: string | null;
}

/** settings/pricing — operator rate card used to bound a charge. */
export interface Pricing {
  min_fare_s?: number;
  min_fare_v?: number;
  day_v?: number;
  hourly_v_rate?: number;
  peak_surcharge_pct?: number;
}

/** audit_log/{auto} — append-only governance trail. */
export interface AuditEntry {
  ts: Stamp;
  actorUid: string;
  actorName: string;
  action: string;
  target: string;
  detail: string;
}

// ── Callable request payloads ───────────────────────────────────────────────
// The apps send these as `request.data`. Validated at the top of each handler.

export interface GetHotelRatesInput {
  name?: string;
  lat?: number;
  lng?: number;
  checkIn?: string;
  nights?: number;
  guests?: number;
  currency?: string;
}

export interface ProcessSquarePaymentInput {
  sourceId?: string;
  idempotencyKey?: string;
  amount?: number;
  currency?: string;
  bookingRef?: string;
  verificationToken?: string;
}

export interface RefundSquarePaymentInput {
  paymentId?: string;
  idempotencyKey?: string;
  amount?: number;
  currency?: string;
  reason?: string;
}

export interface ChatTurn {
  role?: string;
  content?: string;
}

export interface ParseBookingInput {
  message?: string;
  history?: ChatTurn[];
  trips?: unknown[];
  now?: string;
  mode?: string;
  context?: unknown;
}
