/**
 * Subscription billing — the recurring revenue layer. Plans, prices and
 * entitlements live here as pure data + functions so the web client, the Cloud
 * Functions and any future surface agree on what a landlord is paying for and
 * what they're allowed to do. Money is integer **pence** (GBP), as elsewhere.
 */

export type PlanId = 'free' | 'landlord' | 'agent';

export interface Plan {
  id: PlanId;
  name: string;
  /** Flat monthly price in pence, before any per-unit charges. */
  basePence: number;
  /** Monthly price in pence for each unit beyond `includedUnits`. */
  perUnitPence: number;
  /** Units covered by `basePence` at no extra charge. */
  includedUnits: number;
  /** Maximum properties this plan may track (Infinity = unlimited). */
  maxUnits: number;
  blurb: string;
  features: string[];
}

/**
 * The ladder: Free lands the landlord (1 property, compliance tracking only),
 * Landlord is the core flat plan, Agent adds per-unit scale + team use.
 * Prices match `docs/rentmatch-revenue-plan.md`.
 */
export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    basePence: 0,
    perUnitPence: 0,
    includedUnits: 1,
    maxUnits: 1,
    blurb: 'Track one property and never miss a certificate.',
    features: ['1 property', 'Compliance dashboard', 'Expiry reminders'],
  },
  landlord: {
    id: 'landlord',
    name: 'Landlord',
    basePence: 9_900, // £99 / month, flat
    perUnitPence: 0,
    includedUnits: 10,
    maxUnits: 10,
    blurb: 'Everything to run a small portfolio compliantly.',
    features: [
      'Up to 10 properties',
      'Compliance dashboard + reminders',
      'Tenancy e-signing',
      'Document vault',
    ],
  },
  agent: {
    id: 'agent',
    name: 'Agent',
    basePence: 4_900, // £49 / month base…
    perUnitPence: 600, // …+ £6 / unit
    includedUnits: 0,
    maxUnits: Number.POSITIVE_INFINITY,
    blurb: 'Manage many landlords at scale, with your team.',
    features: [
      'Unlimited properties',
      'Multi-landlord & team seats',
      'Branded tenant comms',
      'Everything in Landlord',
    ],
  },
};

export const PAID_PLAN_IDS: readonly PlanId[] = ['landlord', 'agent'];

/** Monthly price (pence) for a plan tracking `units` properties. */
export function monthlyPricePence(planId: PlanId, units: number): number {
  const plan = PLANS[planId];
  const billableUnits = Math.max(0, units - plan.includedUnits);
  return plan.basePence + billableUnits * plan.perUnitPence;
}

/** Whether a plan is allowed to track `units` properties. */
export function canTrackUnits(planId: PlanId, units: number): boolean {
  return units <= PLANS[planId].maxUnits;
}

/** Cheapest plan that can legally hold `units` properties — the upgrade target. */
export function smallestPlanFor(units: number): PlanId {
  if (canTrackUnits('free', units)) return 'free';
  if (canTrackUnits('landlord', units)) return 'landlord';
  return 'agent';
}

/* ---- subscription state (mirrored from Stripe onto the user doc) ---- */

/** The Stripe subscription statuses we care about, plus `none`. */
export type SubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired';

export interface Subscription {
  plan: PlanId;
  status: SubscriptionStatus;
  stripeSubscriptionId?: string;
  /** Epoch ms the current paid period ends. */
  currentPeriodEnd?: number;
}

/** A subscription that currently grants paid features. */
export function isSubscriptionActive(sub: Subscription | null | undefined): boolean {
  return sub != null && (sub.status === 'active' || sub.status === 'trialing');
}

/** The plan whose features apply right now — paid plan if active, else Free. */
export function effectivePlan(sub: Subscription | null | undefined): PlanId {
  return isSubscriptionActive(sub) ? sub!.plan : 'free';
}
