/**
 * ApexCoin (APEX / AXC) — the loyalty-token maths shared by all three apps.
 * Single source for logic that was previously duplicated (and drifting) inline:
 * the earn rates, the tier ladder + progress bar (apexvip-client.html), the
 * checkout redemption ("pay with ApexCoin"), and the admin supply aggregation
 * (apexvip-admin.html). 1 coin is worth £1 when redeemed.
 *
 * Clients earn whole coins ("APEX"); drivers earn 2-decimal coins ("AXC").
 */

export const CLIENT_EARN_RATE = 0.05;
export const DRIVER_EARN_RATE = 0.02;

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Round to 2 decimals without float drift (0.1 + 0.2 → 0.3). */
export function round2(n: number): number {
  return Math.round(num(n) * 100) / 100;
}

/** Whole APEX a client earns on the cash portion of a fare (5%). */
export function clientCoinsEarned(farePaid: number): number {
  return Math.max(0, Math.round(num(farePaid) * CLIENT_EARN_RATE));
}

/** AXC (2 dp) a driver earns on a completed job's pay (2%). */
export function driverCoinsEarned(jobPay: number): number {
  return Math.max(0, round2(num(jobPay) * DRIVER_EARN_RATE));
}

export type ApexTier = 'Bronze' | 'Silver' | 'Gold' | 'Platinum';

/** The tier ladder, ascending. `min` is the balance that unlocks the tier. */
export const TIER_THRESHOLDS: ReadonlyArray<{ tier: ApexTier; min: number }> = [
  { tier: 'Bronze', min: 0 },
  { tier: 'Silver', min: 500 },
  { tier: 'Gold', min: 2000 },
  { tier: 'Platinum', min: 5000 },
];

export function apexTier(balance: number): ApexTier {
  const b = num(balance);
  let tier: ApexTier = 'Bronze';
  for (const t of TIER_THRESHOLDS) if (b >= t.min) tier = t.tier;
  return tier;
}

export function apexTierColor(tier: string): string {
  const colors: Record<string, string> = { Bronze: '#cd7f32', Silver: '#a8a9ad', Gold: '#ffffff', Platinum: '#b9f2ff' };
  return colors[tier] || colors.Bronze;
}

export interface TierProgress {
  tier: ApexTier;
  /** The next tier up, or null at Platinum. */
  next: ApexTier | null;
  /** Balance that unlocks `next` (null at Platinum). */
  target: number | null;
  /** Whole-percent progress toward `target` (100 at Platinum). */
  pct: number;
}

/** Where a balance sits on the ladder, for the "Progress to Silver" bar. */
export function tierProgress(balance: number): TierProgress {
  const b = Math.max(0, num(balance));
  const tier = apexTier(b);
  const idx = TIER_THRESHOLDS.findIndex((t) => t.tier === tier);
  const nextRung = TIER_THRESHOLDS[idx + 1];
  if (!nextRung) return { tier, next: null, target: null, pct: 100 };
  return { tier, next: nextRung.tier, target: nextRung.min, pct: Math.min(100, Math.floor((b / nextRung.min) * 100)) };
}

export interface CoinRedemption {
  /** Whole coins actually applied (never more than the balance or the fare). */
  redeemed: number;
  /** What's left to pay in cash after redemption. */
  cashDue: number;
  /** The balance after deducting `redeemed`. */
  newBalance: number;
}

/**
 * Apply a coin balance against a fare at £1 per coin. Redemption is in whole
 * coins, clamped so the balance never goes negative and the fare is never
 * overpaid. Junk inputs redeem nothing.
 */
export function applyCoinRedemption(fareTotal: number, balance: number): CoinRedemption {
  const fare = Math.max(0, Math.floor(num(fareTotal)));
  const bal = Math.max(0, num(balance));
  const redeemed = Math.min(Math.floor(bal), fare);
  return { redeemed, cashDue: fare - redeemed, newBalance: round2(bal - redeemed) };
}

/** Prepend a wallet transaction, keeping the newest `cap` entries. */
export function appendCoinTx<T>(history: T[] | null | undefined, tx: T, cap = 50): T[] {
  return [tx, ...(history || [])].slice(0, Math.max(1, cap));
}

/** A tracked analytics event, tolerant of the `e`/`event` key duplication. */
export interface CoinEventLike {
  e?: string;
  event?: string;
  amount?: number | string;
  axc?: number | string;
}

export interface CoinSupply {
  issued: number;
  redeemed: number;
  /** Coins live inside the apps: issued − redeemed − net-withdrawn on-chain. */
  circulating: number;
  /** Coins outside the apps as the AXC ERC-20: withdrawn − deposited. */
  onchain: number;
}

/**
 * Aggregate the coin supply from tracked events: client earns (`apex_earned`),
 * driver earns (the `axc` on `trip_completed`), redemptions from either app
 * (`apex_redeemed`), and the on-chain bridge flows (`apex_withdrawn` /
 * `apex_deposited`). No figure ever reads below zero.
 */
export function coinSupply(events: CoinEventLike[] | null | undefined): CoinSupply {
  let issued = 0;
  let redeemed = 0;
  let withdrawn = 0;
  let deposited = 0;
  for (const ev of events || []) {
    const name = ev?.e || ev?.event;
    if (name === 'apex_earned') issued += Math.max(0, num(ev.amount));
    else if (name === 'trip_completed') issued += Math.max(0, num(ev.axc));
    else if (name === 'apex_redeemed') redeemed += Math.max(0, num(ev.amount));
    else if (name === 'apex_withdrawn') withdrawn += Math.max(0, num(ev.amount));
    else if (name === 'apex_deposited') deposited += Math.max(0, num(ev.amount));
  }
  issued = round2(issued);
  redeemed = round2(redeemed);
  const onchain = Math.max(0, round2(withdrawn - deposited));
  return { issued, redeemed, circulating: Math.max(0, round2(issued - redeemed - onchain)), onchain };
}
