/**
 * Cloud Functions entry point (M0 scaffold — seams only, no live wiring yet).
 *
 * Everything money- or state-related runs here under the Admin SDK so it
 * bypasses Firestore rules. The handlers below sketch the seams that M3–M5
 * fill in; each one leans on the shared, tested kernel for its logic.
 */
import {
  canTransition,
  evaluateSigningCompliance,
  buildTenancyAgreement,
  PLATFORM_FEE_PENCE,
  type DealSnapshot,
  type DealStage,
} from '@rentmatch/shared';

/**
 * Callable: advance a deal. Loads the deal, derives a DealSnapshot, and only
 * writes the new stage if the shared state machine allows it. (M3)
 */
export async function advanceDeal(_dealId: string, _to: DealStage): Promise<void> {
  // const deal = await loadDeal(dealId);
  // const snapshot: DealSnapshot = deriveSnapshot(deal);
  // const guard = canTransition(snapshot, to);
  // if (!guard.ok) throw new HttpsError('failed-precondition', guard.reason);
  // await writeStage(dealId, to); await appendEvent(dealId, ...);
  void canTransition;
  void buildTenancyAgreement;
  void evaluateSigningCompliance;
}

/**
 * E-sign webhook: on "envelope complete" (signature verified), capture the
 * landlord's saved card for the £100 fee via Stripe with an idempotency key of
 * the dealId, then let `payment_intent.succeeded` finish the deal. (M4 → M5)
 */
export async function onEsignComplete(_envelopeId: string): Promise<void> {
  // verify webhook signature → mark signatures
  // stripe.paymentIntents.create({ amount: PLATFORM_FEE_PENCE, currency: 'gbp', ... },
  //   { idempotencyKey: dealId });
  void PLATFORM_FEE_PENCE;
}

/**
 * Stripe webhook: on `payment_intent.succeeded` for the landlord fee, mark the
 * deal completed and the listing let, store the executed PDF, email receipts. (M5)
 */
export async function onStripeWebhook(_signature: string, _payload: string): Promise<void> {
  // verify signature → completeDeal(dealId)
  const _snapshot: DealSnapshot | null = null;
  void _snapshot;
}
