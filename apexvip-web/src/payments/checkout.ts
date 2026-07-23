/**
 * ApexVIP card checkout orchestration.
 *
 * The Square payment flow from `runSquarePayment` in apexvip-client.html, lifted
 * out of the DOM/SDK so the sequencing is typed and testable:
 *
 *   tokenize card → SCA (verifyBuyer, non-fatal) → charge server-side
 *   (processSquarePayment, typed via the contract) → on backend error, store the
 *   token in pending_payments for manual capture → on no backend, demo mode.
 *
 * The Square SDK (`tokenize`, `verifyBuyer`) and Firestore (`storePending`) are
 * injected, so this module has no DOM or SDK dependency. The page keeps its
 * button states, haptics and rendering and just calls `runCheckout`.
 */

import type { ApexClient } from '../apexClient.ts';

/** What `card.tokenize()` resolves to (Square Web Payments SDK shape). */
export interface CardTokenizeResult {
  status: string; // 'OK' on success
  token?: string;
  errors?: Array<{ message: string }>;
}

export interface BuyerVerification {
  token?: string;
}

export interface BuyerContact {
  name?: string;
  email?: string;
}

/** The token + metadata stored for manual processing when the charge can't run. */
export interface PendingPayment {
  sourceId: string;
  verificationToken?: string;
  idempotencyKey: string;
  amount: number;
  currency: string;
  bookingRef: string;
  status: 'pending';
}

export interface CheckoutDeps {
  /** Tokenize the card entered in the Square card form. */
  tokenize: () => Promise<CardTokenizeResult>;
  /** Run SCA / 3-D Secure for the amount; may throw or return null (non-fatal). */
  verifyBuyer: (sourceId: string, amount: number, buyer: BuyerContact) => Promise<BuyerVerification | null>;
  /** Typed callable client, or null when Firebase is unavailable (demo mode). */
  backend: Pick<ApexClient, 'processSquarePayment'> | null;
  /** Fallback store (Firestore `pending_payments`) when the charge can't run. */
  storePending: (req: PendingPayment) => Promise<void>;
  /** Idempotency key factory (a retry must never double-charge). */
  newIdempotencyKey: () => string;
  /** Booking reference factory, e.g. "APX-1234". */
  newBookingRef: () => string;
}

export type CheckoutOutcome = 'charged' | 'stored_pending' | 'demo' | 'card_error';

export interface CheckoutResult {
  ok: boolean;
  ref: string;
  paymentId: string | null;
  outcome: CheckoutOutcome;
  /** Set on a card-tokenization failure. */
  error?: string;
}

export async function runCheckout(
  amount: number,
  buyer: BuyerContact,
  deps: CheckoutDeps,
): Promise<CheckoutResult> {
  // 1) Tokenize the card. A non-OK status is a user-facing card error.
  const tok = await deps.tokenize();
  if (tok.status !== 'OK' || !tok.token) {
    const error = tok.errors?.map((e) => e.message).join(', ') || 'Card error';
    return { ok: false, ref: '', paymentId: null, outcome: 'card_error', error };
  }
  const sourceId = tok.token;
  const ref = deps.newBookingRef();

  // 2) Strong Customer Authentication (SCA / 3-D Secure). Best-effort: if it
  //    throws or returns nothing, proceed without a verification token.
  let verificationToken: string | undefined;
  try {
    const vr = await deps.verifyBuyer(sourceId, amount, buyer);
    verificationToken = vr?.token || undefined;
  } catch {
    verificationToken = undefined;
  }

  // 3) Idempotency key so a retry never double-charges.
  const idempotencyKey = deps.newIdempotencyKey();

  // 4) Charge server-side via the typed callable; on error, store the token for
  //    manual capture; with no backend, this is demo mode.
  if (deps.backend) {
    try {
      const resp = await deps.backend.processSquarePayment({
        sourceId,
        verificationToken,
        idempotencyKey,
        amount,
        currency: 'GBP',
        bookingRef: ref,
      });
      return { ok: true, ref, paymentId: resp.paymentId ?? null, outcome: 'charged' };
    } catch {
      await deps.storePending({
        sourceId, verificationToken, idempotencyKey, amount, currency: 'GBP', bookingRef: ref, status: 'pending',
      }).catch(() => {});
      return { ok: true, ref, paymentId: null, outcome: 'stored_pending' };
    }
  }

  return { ok: true, ref, paymentId: null, outcome: 'demo' };
}
