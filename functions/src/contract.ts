/**
 * ApexVIP — callable contract (shared by the backend and the web client).
 *
 * One source of truth for every callable Cloud Function: its request `data` and
 * its `result`. The `data` side reuses the same input interfaces the handlers in
 * index.ts are typed against (./types.ts), so the request shapes are genuinely
 * shared. The `result` side mirrors exactly what each handler returns.
 *
 * The web build imports `ApexCallables` (see apexvip-web/src/apexClient.ts) to get
 * compile-time-checked calls — passing the wrong field, or reading a field the
 * function never returns, becomes a type error instead of a runtime surprise.
 *
 * Only *callable* functions appear here. The Firestore/schedule triggers
 * (onBookingWrite, onBookingCreated, remindExpiringDocs) are not client-callable.
 */

import type {
  GetHotelRatesInput,
  ProcessSquarePaymentInput,
  RefundSquarePaymentInput,
  ParseBookingInput,
} from './types.js';

// ── Result shapes ───────────────────────────────────────────────────────────

/** getHotelRates: a live quote, or `available:false` when there's no inventory. */
export type HotelRateResult =
  | { name?: string; currency: string; checkIn: string; available: false }
  | {
      nightly: number;
      from: number;
      total: number;
      nights: number;
      guests: number;
      currency: string;
      checkIn: string;
      available: true;
    };

export interface SquarePaymentResult {
  paymentId?: string;
  status?: string;
  receiptUrl: string | null;
}

export interface SquareCaptureResult {
  paymentId: string;
  status: string;
}

export interface SquareRefundResult {
  refundId?: string;
  status?: string;
}

export interface ReferralCodeResult {
  code: string;
}

export interface ApplyReferralResult {
  message: string;
  creditsAwarded: number;
}

export interface OkResult {
  ok: true;
}

/** checkFlightStatus: neutral (`available:false`) until a provider key is set. */
export interface FlightStatusResult {
  flight: string;
  available: boolean;
  delayed: boolean;
  delayMins: number;
  origin?: string;
  originCity?: string;
  originIata?: string;
  terminal?: string;
  belt?: string;
  scheduled?: string;
  estimated?: string;
  duration?: string;
}

export interface PayoutAccountResult {
  url: string;
  accountId: string;
  mock?: boolean;
}

export interface PayoutStatusResult {
  onboarded: boolean;
  payoutsEnabled: boolean;
  mock?: boolean;
}

export interface PayoutSettleResult {
  paid: number;
  count: number;
  currency?: string;
  transferId?: string | null;
  mock?: boolean;
}

/**
 * redeemApexCoins: the coins actually applied (server-clamped to the caller's
 * balance — may be less than requested) and the balance after deduction.
 */
export interface CoinRedeemResult {
  redeemed: number;
  balance: number;
}

/** redeemDriverCoins: AXC cashed out (1 AXC = £1, lands in driver_payouts as owed). */
export interface DriverCoinRedeemResult {
  redeemed: number;
  balance: number;
}

/** linkChainWallet: the checksummed, signature-verified wallet address. */
export interface LinkWalletResult {
  address: string;
}

/** withdrawCoinsOnchain: coins moved out as minted AXC (idempotent per key). */
export interface CoinWithdrawResult {
  withdrawn: number;
  txHash: string;
  balance: number;
  /** Block-explorer link for the mint tx ('' when no explorer configured). */
  explorer: string;
}

/** depositCoinsOnchain: coins credited back from a verified on-chain transfer. */
export interface CoinDepositResult {
  deposited: number;
  alreadyClaimed: boolean;
  balance: number;
}

/**
 * parseBookingIntent (ApexAI): the structured booking intent, or `{ reply }` in
 * driver mode. The exact fields mirror the client's `_parseIntentLocal` shape;
 * left open here because the model fills a variable subset.
 */
export interface BookingIntentResult {
  reply?: string;
  intent?: string;
  serviceType?: string;
  pickup?: string;
  dropoff?: string;
  airport?: string;
  flight?: string;
  date?: string;
  time?: string;
  vehicle?: string;
  passengers?: number;
  suggestedPickupTime?: string;
  stops?: Array<{ name: string; address?: string }>;
  paPassenger?: { name?: string; notes?: string };
  suggestions?: string[];
  modifyBookingRef?: string;
  modifyFields?: { date?: string; time?: string; pickup?: string; dropoff?: string };
  recurringPattern?: string;
  priceEstimate?: number;
  [key: string]: unknown;
}

// ── The callable map ────────────────────────────────────────────────────────

export interface CallableSpec<Data, Result> {
  data: Data;
  result: Result;
}

export interface ApexCallables {
  getHotelRates: CallableSpec<GetHotelRatesInput, HotelRateResult>;
  processSquarePayment: CallableSpec<ProcessSquarePaymentInput, SquarePaymentResult>;
  captureSquarePayment: CallableSpec<{ paymentId: string }, SquareCaptureResult>;
  refundSquarePayment: CallableSpec<RefundSquarePaymentInput, SquareRefundResult>;
  parseBookingIntent: CallableSpec<ParseBookingInput, BookingIntentResult>;
  generateReferralCode: CallableSpec<void, ReferralCodeResult>;
  applyReferralCode: CallableSpec<{ code: string }, ApplyReferralResult>;
  sendChauffeurMessage: CallableSpec<{ bookingRef: string; message: string; fromRole?: 'client' | 'driver' | 'concierge' }, OkResult>;
  submitTripRating: CallableSpec<{ rating: number; bookingRef: string; comment?: string; driverId?: string }, OkResult>;
  checkFlightStatus: CallableSpec<{ flight: string }, FlightStatusResult>;
  validateApplePayMerchant: CallableSpec<{ validationURL: string }, unknown>;
  createDriverPayoutAccount: CallableSpec<void, PayoutAccountResult>;
  getDriverPayoutStatus: CallableSpec<void, PayoutStatusResult>;
  payoutDriver: CallableSpec<{ driverId: string }, PayoutSettleResult>;
  redeemApexCoins: CallableSpec<{ amount: number; bookingRef: string }, CoinRedeemResult>;
  redeemDriverCoins: CallableSpec<void, DriverCoinRedeemResult>;
  linkChainWallet: CallableSpec<{ address: string; signature: string }, LinkWalletResult>;
  withdrawCoinsOnchain: CallableSpec<{ amount: number; address: string; idempotencyKey: string }, CoinWithdrawResult>;
  depositCoinsOnchain: CallableSpec<{ txHash: string }, CoinDepositResult>;
}

/** Every client-callable function name, as a union. */
export type ApexCallableName = keyof ApexCallables;
