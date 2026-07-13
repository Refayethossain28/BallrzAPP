/*!
 * ApexYield™ — proprietary dynamic-pricing algorithm for luxury ground
 * transport. © 2026 ApexVIP. All rights reserved. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN THESIS
 * Ride-hail surge optimizes short-term revenue and burns trust. A luxury
 * marque cannot do that: a Mayfair guest who sees 2.3× once never books
 * again. ApexYield is yield management under a BRAND-SAFETY CONTRACT —
 * the multiplier is bounded, moves smoothly, is honest about direction,
 * and always resolves to a price that *looks* deliberate.
 *
 * THE CONTRACT (each rule is deliberate and enforced in code):
 *   1. HARD CAP    — multiplier lives in [0.90, 1.35]. A 35% premium is the
 *      absolute ceiling regardless of scarcity; a 10% "quiet hour" courtesy
 *      is the floor (a discreet reward, never a fire sale).
 *   2. LOG DAMPING — target = 1 + 0.25·ln(1 + pressure), where pressure is
 *      the open-jobs : idle-drivers ratio. Doubling scarcity does NOT double
 *      the premium: the response flattens exactly where gouging would start.
 *   3. HYSTERESIS  — each update moves at most ±0.05 from the previous
 *      multiplier. Two guests quoting a minute apart see the same market,
 *      and the price a guest watches never jumps under their thumb.
 *   4. QUANTIZED   — the result rounds to 0.05 steps, and applied fares
 *      re-round to the elegant £5 grid (via the fare engine), so a surged
 *      price still reads as a price, not a formula (£195, never £187.43).
 *   5. LOYALTY IMMUNITY — members (gold and above) are quoted floor(mult,
 *      1.0): loyalty means never paying the surge, a marketing asset priced
 *      into the model rather than bolted on.
 *   6. DEMAND-AWARE, NOT DEMAND-BLIND — the ApexPulse heat signal feeds the
 *      pressure term at 30% strength, so predictable rushes (Friday 17:00)
 *      pre-warm capacity gently instead of spiking when the queue is
 *      already long. Reactive + predictive in one term.
 *
 * PRESSURE TERM
 *   pressure = (openJobs / max(1, idleDrivers)) + 0.3·max(0, heat − 1)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface YieldInput {
  /** Unclaimed open jobs right now. */
  openJobs: number;
  /** Online, idle (not on-trip) drivers right now. */
  idleDrivers: number;
  /** ApexPulse heat for this moment (1.0 = typical); optional. */
  heat?: number;
  /** The multiplier currently in force (for hysteresis); default 1.0. */
  previous?: number;
  /** Guest tier — gold and above are never surged. */
  clientTier?: string;
}

export interface YieldQuote {
  /** The multiplier to apply, obeying the full brand-safety contract. */
  multiplier: number;
  /** The uncapped target the market data asked for (for ops telemetry). */
  target: number;
  /** 'rising' | 'falling' | 'steady' — honest direction for the quote UI. */
  direction: 'rising' | 'falling' | 'steady';
  /** True when the guest's tier exempted them from a premium. */
  loyaltyProtected: boolean;
}

export const YIELD_FLOOR = 0.90;
export const YIELD_CAP = 1.35;
export const YIELD_STEP = 0.05;
const DAMPING = 0.25;
const HEAT_WEIGHT = 0.3;
const IMMUNE_TIERS = new Set(['gold', 'vip', 'vvip', 'black', 'platinum']);

const quantize = (v: number) => Math.round(v / YIELD_STEP) * YIELD_STEP;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Compute the surge multiplier for the current market moment. */
export function yieldMultiplier(input: YieldInput): YieldQuote {
  const open = Math.max(0, Number(input.openJobs) || 0);
  const idle = Math.max(0, Number(input.idleDrivers) || 0);
  const heat = Number.isFinite(input.heat) ? Math.max(0, input.heat!) : 1;
  const prev = clamp(Number(input.previous) || 1, YIELD_FLOOR, YIELD_CAP);

  // Pressure: live scarcity plus a gentle predictive pre-warm from ApexPulse.
  const pressure = open / Math.max(1, idle) + HEAT_WEIGHT * Math.max(0, heat - 1);

  // Log-damped target under the hard cap; a genuinely dead market (no jobs,
  // spare drivers, cool forecast) eases to the courtesy floor.
  let target = 1 + DAMPING * Math.log1p(pressure);
  if (open === 0 && idle >= 3 && heat < 0.8) target = YIELD_FLOOR;
  target = clamp(target, YIELD_FLOOR, YIELD_CAP);

  // Hysteresis: at most one step per update toward the target.
  const stepped = clamp(target, prev - YIELD_STEP, prev + YIELD_STEP);
  let multiplier = clamp(quantize(stepped), YIELD_FLOOR, YIELD_CAP);

  // Loyalty immunity: members never pay a premium (discounts still apply).
  const loyaltyProtected = IMMUNE_TIERS.has(String(input.clientTier || '').toLowerCase()) && multiplier > 1;
  if (loyaltyProtected) multiplier = 1;

  const direction = multiplier > prev + 1e-9 ? 'rising' : multiplier < prev - 1e-9 ? 'falling' : 'steady';
  return {
    multiplier: Math.round(multiplier * 100) / 100,
    target: Math.round(target * 100) / 100,
    direction,
    loyaltyProtected,
  };
}
