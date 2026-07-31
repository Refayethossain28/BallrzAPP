/**
 * The persisted deal record and pure helpers to derive its state. The web
 * client and the Cloud Functions both store/read this shape; stage is always a
 * function of the underlying facts (`recomputeStage`) rather than set freely,
 * so client and server never disagree on where a deal stands.
 */
import type { DealStage } from './types.ts';
import { highestReachableStage, type DealSnapshot } from './dealStateMachine.ts';

export type DealParty = 'renter' | 'landlord';

export interface DealViewing {
  ts: number; // epoch ms of the proposed slot
  status: 'proposed' | 'confirmed';
  proposedBy: DealParty;
}

/** The persisted deal document (excluding ids/metadata held by the app). */
export interface DealRecord {
  stage: DealStage;
  viewing: DealViewing | null;
  agreed: { renter: boolean; landlord: boolean };
  contractDrafted: boolean;
  esignEnvelopeOpen: boolean;
  signed: { renter: number | null; landlord: number | null };
  feePaid: boolean;
}

export const STAGE_LABELS: Record<DealStage, string> = {
  enquiry: 'Enquiry',
  viewing: 'Viewing',
  agreed: 'Terms agreed',
  contract: 'Contract',
  signing: 'Signing',
  completed: 'Let agreed',
  cancelled: 'Cancelled',
};

export function deriveSnapshot(d: DealRecord): DealSnapshot {
  return {
    stage: d.stage,
    hasConfirmedViewing: !!d.viewing && d.viewing.status === 'confirmed',
    agreedByRenter: d.agreed.renter,
    agreedByLandlord: d.agreed.landlord,
    contractDrafted: d.contractDrafted,
    esignEnvelopeOpen: d.esignEnvelopeOpen,
    signedByRenter: d.signed.renter != null,
    signedByLandlord: d.signed.landlord != null,
    landlordFeePaid: d.feePaid,
  };
}

/** The stage a deal currently qualifies for, derived from its facts. */
export function recomputeStage(d: DealRecord): DealStage {
  return highestReachableStage(deriveSnapshot(d));
}

/** A fresh enquiry-stage deal record. */
export function newDealRecord(): DealRecord {
  return {
    stage: 'enquiry',
    viewing: null,
    agreed: { renter: false, landlord: false },
    contractDrafted: false,
    esignEnvelopeOpen: false,
    signed: { renter: null, landlord: null },
    feePaid: false,
  };
}

/** Whether the given party still needs to record their agreement to proceed. */
export function awaitingAgreement(d: DealRecord, party: DealParty): boolean {
  return !d.agreed[party];
}

/** Whether both parties have signed (the agreement is fully executed). */
export function bothSigned(d: DealRecord): boolean {
  return d.signed.renter != null && d.signed.landlord != null;
}

/**
 * Fully executed but not yet completed — both have signed but the landlord's
 * £100 fee has not been captured. This is the precise point M5's charge fires.
 */
export function awaitingFee(d: DealRecord): boolean {
  return bothSigned(d) && !d.feePaid;
}
