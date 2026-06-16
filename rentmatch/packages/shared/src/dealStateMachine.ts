/**
 * The deal lifecycle, enforced server-side. Clients propose transitions; a
 * Cloud Function calls `canTransition` and only writes the new stage when it
 * returns `{ ok: true }`. Keeping this pure makes it unit-testable and lets the
 * web client preview which actions are available without trusting the client.
 */
import type { DealStage } from './types.ts';

/** Forward path through a successful deal (excludes the terminal `cancelled`). */
export const DEAL_STAGES: readonly DealStage[] = [
  'enquiry',
  'viewing',
  'agreed',
  'contract',
  'signing',
  'completed',
];

/** Legal next-stages from each stage. Cancellation is allowed until completion. */
export const ALLOWED_TRANSITIONS: Record<DealStage, DealStage[]> = {
  enquiry: ['viewing', 'cancelled'],
  viewing: ['agreed', 'cancelled'],
  agreed: ['contract', 'cancelled'],
  contract: ['signing', 'cancelled'],
  signing: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/**
 * The minimal slice of a deal the state machine needs. The Cloud Function
 * derives these booleans from Firestore documents (viewing, signatures,
 * payment) before asking whether a transition is allowed.
 */
export interface DealSnapshot {
  stage: DealStage;
  hasConfirmedViewing: boolean;
  agreedByRenter: boolean;
  agreedByLandlord: boolean;
  contractDrafted: boolean;
  esignEnvelopeOpen: boolean;
  signedByRenter: boolean;
  signedByLandlord: boolean;
  /** True once the Stripe £100 PaymentIntent has succeeded. */
  landlordFeePaid: boolean;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/** Whether `deal` may move to `to`, and why not if it can't. */
export function canTransition(deal: DealSnapshot, to: DealStage): GuardResult {
  const from = deal.stage;
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    return { ok: false, reason: `Illegal transition: ${from} → ${to}` };
  }
  if (to === 'cancelled') return { ok: true };

  switch (to) {
    case 'viewing':
      return deal.hasConfirmedViewing
        ? { ok: true }
        : { ok: false, reason: 'A viewing must be confirmed first' };
    case 'agreed':
      return deal.agreedByRenter && deal.agreedByLandlord
        ? { ok: true }
        : { ok: false, reason: 'Both parties must agree to proceed' };
    case 'contract':
      return deal.contractDrafted
        ? { ok: true }
        : { ok: false, reason: 'The tenancy agreement has not been drafted' };
    case 'signing':
      return deal.esignEnvelopeOpen
        ? { ok: true }
        : { ok: false, reason: 'The e-signature envelope is not open' };
    case 'completed':
      if (!(deal.signedByRenter && deal.signedByLandlord)) {
        return { ok: false, reason: 'Both parties must sign the agreement' };
      }
      if (!deal.landlordFeePaid) {
        return { ok: false, reason: 'The landlord £100 platform fee is not captured' };
      }
      return { ok: true };
    default:
      return { ok: false, reason: `Unknown target stage: ${to}` };
  }
}

/** Convenience: the furthest forward stage a deal currently qualifies for. */
export function highestReachableStage(deal: DealSnapshot): DealStage {
  let stage: DealStage = 'enquiry';
  const probe: DealSnapshot = { ...deal, stage };
  for (let i = 1; i < DEAL_STAGES.length; i++) {
    const next = DEAL_STAGES[i];
    if (!canTransition(probe, next).ok) break;
    stage = next;
    probe.stage = next;
  }
  return stage;
}
