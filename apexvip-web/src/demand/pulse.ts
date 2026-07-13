/*!
 * ApexPulse™ — proprietary demand-forecasting algorithm.
 * © 2026 ApexVIP. All rights reserved. Unauthorized copying, modification,
 * distribution, or use of this file, via any medium, is strictly prohibited.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES
 * Learns the operation's weekly demand rhythm from nothing but its own booking
 * timestamps and turns it into actionable signals: when the coming peaks are,
 * whether a driver should go online now, and a 168-hour heat profile for the
 * ops dashboard. No external data, no ML infrastructure — a deterministic
 * model that improves with every booking and can run on-device.
 *
 * HOW IT WORKS
 *   1. RECENCY-WEIGHTED BINNING — each historical booking contributes weight
 *      w = 0.5^(ageDays / 28) (28-day half-life) to its hour-of-week bucket
 *      (0 = Mon 00:00 … 167 = Sun 23:00). The operation's *current* rhythm
 *      dominates; last season's fades smoothly instead of falling off a cliff.
 *   2. CIRCULAR SMOOTHING — the 168 buckets are convolved with the kernel
 *      [0.25, 0.5, 0.25] wrapping around the week boundary, so a 17:00 rush
 *      also warms 16:00 and 18:00 (bookings are placed ahead of travel).
 *   3. NORMALIZATION — the profile is scaled to mean 1.0. A bucket at 2.4
 *      reads "2.4× a typical hour"; robust regardless of fleet size.
 *
 * SIGNALS DERIVED FROM THE PROFILE
 *   · heatAt(profile, when)         — instant intensity for any Date
 *   · nextPeak(profile, from)       — the next local maximum ≥ 1.25× mean in
 *     the coming 24 h, with lead time ("Friday 17:00, in 3 h")
 *   · goOnlineAdvice(profile, when) — chauffeur-facing recommendation with a
 *     plain-English reason, driven by current heat and the ramp to the next
 *     peak. Thresholds: ≥1.5 STRONG · ≥1.1 GOOD · peak within 2 h RAMP ·
 *     else QUIET (with the next peak named, so quiet is still informative).
 *
 * COLD START — below MIN_SAMPLES (25) weighted observations the model
 * declares itself unready (ready:false) instead of hallucinating a rhythm
 * from noise. Consumers show nothing rather than nonsense.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface PulseProfile {
  /** 168 buckets, Mon 00:00 → Sun 23:00, normalized to mean 1.0. */
  buckets: number[];
  /** Total decayed weight observed — the model's confidence mass. */
  mass: number;
  /** False until enough signal exists to trust the profile. */
  ready: boolean;
}

export interface PulsePeak {
  /** Hour-of-week index of the peak bucket. */
  bucket: number;
  /** Intensity relative to a typical hour (≥ 1.25 by construction). */
  intensity: number;
  /** Whole hours from `from` until the peak (0 = this hour). */
  hoursAway: number;
  /** Human label, e.g. "Fri 17:00". */
  label: string;
}

export interface PulseAdvice {
  level: 'strong' | 'good' | 'ramp' | 'quiet';
  /** Plain-English, chauffeur-facing reason. */
  reason: string;
  /** Current intensity (1.0 = typical hour). */
  heat: number;
  peak: PulsePeak | null;
}

const HALF_LIFE_DAYS = 28;
const KERNEL = [0.25, 0.5, 0.25];
const MIN_SAMPLES = 25;
const PEAK_THRESHOLD = 1.25;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Hour-of-week bucket (0 = Monday 00:00) for a Date. */
export function hourOfWeek(d: Date): number {
  return ((d.getDay() + 6) % 7) * 24 + d.getHours();
}

/**
 * Build the demand profile from booking timestamps (ms epochs or Dates).
 * `now` is injectable for determinism.
 */
export function buildPulse(timestamps: Array<number | Date>, now: Date = new Date()): PulseProfile {
  const raw = new Array<number>(168).fill(0);
  let mass = 0;
  const nowMs = now.getTime();
  for (const t of timestamps || []) {
    const ms = t instanceof Date ? t.getTime() : Number(t);
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    const ageDays = (nowMs - ms) / 86400000;
    const w = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    raw[hourOfWeek(new Date(ms))] += w;
    mass += w;
  }
  // Circular smoothing.
  const smoothed = raw.map((_, i) =>
    KERNEL[0] * raw[(i + 167) % 168] + KERNEL[1] * raw[i] + KERNEL[2] * raw[(i + 1) % 168]);
  // Normalize to mean 1.0 (guard the empty profile).
  const mean = smoothed.reduce((a, b) => a + b, 0) / 168;
  const buckets = mean > 0 ? smoothed.map((v) => v / mean) : smoothed;
  return { buckets, mass, ready: mass >= MIN_SAMPLES };
}

/** Demand intensity at a moment (1.0 = typical hour). */
export function heatAt(profile: PulseProfile, when: Date): number {
  if (!profile || !profile.ready) return 1;
  return Math.round(profile.buckets[hourOfWeek(when)] * 100) / 100;
}

/** The next local peak (≥1.25× typical) in the coming 24 h, or null. */
export function nextPeak(profile: PulseProfile, from: Date): PulsePeak | null {
  if (!profile || !profile.ready) return null;
  const start = hourOfWeek(from);
  let best: PulsePeak | null = null;
  for (let h = 0; h < 24; h++) {
    const b = (start + h) % 168;
    const v = profile.buckets[b];
    if (v >= PEAK_THRESHOLD && (!best || v > best.intensity)) {
      best = {
        bucket: b,
        intensity: Math.round(v * 100) / 100,
        hoursAway: h,
        label: `${DAYS[Math.floor(b / 24)]} ${String(b % 24).padStart(2, '0')}:00`,
      };
    }
  }
  return best;
}

/** Chauffeur-facing "should I go online?" recommendation. */
export function goOnlineAdvice(profile: PulseProfile, when: Date = new Date()): PulseAdvice {
  const heat = heatAt(profile, when);
  const peak = nextPeak(profile, when);
  if (!profile || !profile.ready) {
    return { level: 'quiet', reason: 'Not enough booking history yet — patterns appear as trips come in.', heat: 1, peak: null };
  }
  if (heat >= 1.5) return { level: 'strong', reason: `Demand is running ${heat}× a typical hour right now.`, heat, peak };
  if (heat >= 1.1) return { level: 'good', reason: `Demand is a little above typical (${heat}×).`, heat, peak };
  if (peak && peak.hoursAway <= 2) {
    return { level: 'ramp', reason: `A peak is building — ${peak.label} usually runs ${peak.intensity}× typical.`, heat, peak };
  }
  return {
    level: 'quiet',
    reason: peak ? `Quiet now — the next busy window is ${peak.label} (${peak.intensity}× typical).` : 'Quiet — no strong pattern in the next 24 hours.',
    heat, peak,
  };
}
