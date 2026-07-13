/*!
 * ApexMatch™ — proprietary driver–job matching algorithm.
 * © 2026 ApexVIP. All rights reserved. Unauthorized copying, modification,
 * distribution, or use of this file, via any medium, is strictly prohibited.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES
 * Ranks every eligible chauffeur for a specific job with an explainable,
 * deterministic score in [0, 100]. Unlike first-to-accept broadcast (a race)
 * or nearest-driver dispatch (ignores service quality), ApexMatch balances
 * SIX weighted factors so the *right* chauffeur gets the job — and the ops
 * team can see exactly why:
 *
 *   1. PERFORMANCE  — Bayesian-smoothed customer rating. A 5.0 from 2 trips
 *      must not outrank a 4.9 from 400, so the observed mean is shrunk toward
 *      a prior (4.6) with strength K=12: r̂ = (n·r + K·prior) / (n + K).
 *   2. RELIABILITY  — smoothed offer-acceptance rate (same shrinkage, prior
 *      0.75, K=8). Declines are a real dispatch cost; chronic decliners sink.
 *   3. PROXIMITY    — exponential decay over haversine distance,
 *      e^(−km / 6). At 0 km → 1.0, ~6 km → 0.37, ~12 km → 0.14. Unknown
 *      positions score a neutral 0.5 rather than being punished.
 *   4. FAIRNESS     — a saturating idle boost, min(1, log1p(idleMin) /
 *      log1p(240)). A driver idle 4+ hours reaches full boost; freshly
 *      occupied drivers score near 0. This spreads work across the fleet so
 *      top performers can't starve everyone else (driver retention is a
 *      first-class business goal, not an afterthought).
 *   5. VEHICLE FIT  — exact requested class 1.0, luxury-compatible upgrade
 *      0.7 (an S-Class can serve an E-Class request; a V-Class can serve any
 *      group), incompatible 0 (a saloon can never take a 6-person job).
 *   6. VIP AFFINITY — for gold/vip/black-tier guests the performance factor
 *      is re-weighted ×1.5 and reliability ×1.25, so marquee clients are
 *      preferentially served by the fleet's proven best.
 *
 * HARD GATES (score = excluded, never just "low"):
 *   · driver not compliant (documents lapsed)  · driver offline or on a trip
 *   · vehicle physically cannot serve the job (capacity)
 *
 * The output carries a full per-factor breakdown for the ops console —
 * explainability is a feature: "why did Marco get this job?" must always
 * have an answer.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface MatchDriver {
  id: string;
  /** Mean customer rating 1–5 and how many ratings back it. */
  rating?: number;
  ratingCount?: number;
  /** Offers accepted / offers received (0–1) and volume. */
  acceptRate?: number;
  offerCount?: number;
  /** Minutes since this driver's last completed trip (or came online). */
  idleMinutes?: number;
  /** Last known position (from driver_locations). */
  lat?: number;
  lng?: number;
  /** 'S-Class' | 'V-Class' | 'E-Class' | free text. */
  vehicle?: string;
  /** Compliance verdict — non-compliant drivers are excluded outright. */
  compliant?: boolean;
  /** 'online' | 'ontrip' | 'offline' */
  status?: string;
}

export interface MatchJob {
  /** Requested vehicle class (defaults to S-Class). */
  vehicle?: string;
  /** Passenger count, if known — drives the capacity gate. */
  passengers?: number;
  /** Pickup position, if geocoded. */
  lat?: number;
  lng?: number;
  /** Guest loyalty tier: 'standard' | 'gold' | 'vip' | 'black'. */
  clientTier?: string;
}

export interface MatchFactors {
  performance: number;
  reliability: number;
  proximity: number;
  fairness: number;
  vehicleFit: number;
}

export interface MatchResult {
  id: string;
  /** 0–100, rounded to one decimal. */
  score: number;
  factors: MatchFactors;
  driver: MatchDriver;
}

/** Great-circle distance in km (haversine). Exported for reuse. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Bayesian shrinkage of an observed mean toward a prior. */
function shrink(mean: number, n: number, prior: number, k: number): number {
  return (n * mean + k * prior) / (n + k);
}

const RATING_PRIOR = 4.6;
const RATING_K = 12;
const ACCEPT_PRIOR = 0.75;
const ACCEPT_K = 8;
const PROXIMITY_SCALE_KM = 6;
const FAIRNESS_SATURATION_MIN = 240;

/** Base factor weights (sum needn't be 1 — the score normalizes). */
const WEIGHTS: MatchFactors = {
  performance: 0.30,
  reliability: 0.20,
  proximity: 0.25,
  fairness: 0.15,
  vehicleFit: 0.10,
};

const VIP_TIERS = new Set(['gold', 'vip', 'vvip', 'black', 'platinum']);

function vehicleClass(v: unknown): 's' | 'v' | 'e' | 'other' {
  const s = String(v ?? '').toLowerCase();
  if (/v[\s-]?class|mpv|van|sprinter|people/.test(s)) return 'v';
  if (/s[\s-]?class/.test(s)) return 's';
  if (/e[\s-]?class/.test(s)) return 'e';
  return 'other';
}

/** 1 exact · 0.7 compatible luxury upgrade · 0 physically unfit. */
export function vehicleFit(driverVehicle: unknown, job: MatchJob): number {
  const want = vehicleClass(job.vehicle || 'S-Class');
  const have = vehicleClass(driverVehicle);
  const pax = Number(job.passengers) || 0;
  // Capacity gate: 5+ passengers require a V-Class, full stop.
  if (pax >= 5 && have !== 'v') return 0;
  if (have === want) return 1;
  // Upgrades that flatter the guest: S serves E; V serves anything.
  if (have === 'v') return want === 'v' ? 1 : 0.7;
  if (have === 's' && want === 'e') return 0.7;
  // A saloon can't serve a V-Class (group) request.
  if (want === 'v') return 0;
  return 0.4; // unknown ↔ unknown: usable but unpreferred
}

/**
 * Score one driver for one job. Returns null when a hard gate excludes them.
 */
export function matchScore(driver: MatchDriver, job: MatchJob): MatchResult | null {
  // Hard gates — these are not low scores, they are non-candidates.
  if (driver.compliant === false) return null;
  if (driver.status && driver.status !== 'online') return null;
  const fit = vehicleFit(driver.vehicle, job);
  if (fit === 0) return null;

  const perf01 = Math.max(0, Math.min(1,
    (shrink(Number(driver.rating) || RATING_PRIOR, Number(driver.ratingCount) || 0, RATING_PRIOR, RATING_K) - 3) / 2));
  const rel01 = Math.max(0, Math.min(1,
    shrink(Number(driver.acceptRate ?? ACCEPT_PRIOR), Number(driver.offerCount) || 0, ACCEPT_PRIOR, ACCEPT_K)));
  const prox01 = (Number.isFinite(driver.lat) && Number.isFinite(driver.lng) &&
                  Number.isFinite(job.lat) && Number.isFinite(job.lng))
    ? Math.exp(-haversineKm(driver.lat!, driver.lng!, job.lat!, job.lng!) / PROXIMITY_SCALE_KM)
    : 0.5;
  const fair01 = Math.min(1, Math.log1p(Math.max(0, Number(driver.idleMinutes) || 0)) / Math.log1p(FAIRNESS_SATURATION_MIN));

  const factors: MatchFactors = {
    performance: perf01, reliability: rel01, proximity: prox01, fairness: fair01, vehicleFit: fit,
  };

  // VIP affinity re-weighting: marquee guests get the proven best.
  const vip = VIP_TIERS.has(String(job.clientTier || '').toLowerCase());
  const w: MatchFactors = {
    performance: WEIGHTS.performance * (vip ? 1.5 : 1),
    reliability: WEIGHTS.reliability * (vip ? 1.25 : 1),
    proximity: WEIGHTS.proximity,
    fairness: WEIGHTS.fairness,
    vehicleFit: WEIGHTS.vehicleFit,
  };
  const totalW = w.performance + w.reliability + w.proximity + w.fairness + w.vehicleFit;
  const raw = (factors.performance * w.performance + factors.reliability * w.reliability +
    factors.proximity * w.proximity + factors.fairness * w.fairness + factors.vehicleFit * w.vehicleFit) / totalW;

  return { id: driver.id, score: Math.round(raw * 1000) / 10, factors, driver };
}

/** Rank every eligible driver for a job, best first. */
export function rankDrivers(drivers: MatchDriver[], job: MatchJob): MatchResult[] {
  return (drivers || [])
    .map((d) => matchScore(d, job))
    .filter((r): r is MatchResult => r !== null)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
