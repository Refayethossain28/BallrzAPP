/**
 * Context engineering for the ApexAI concierge.
 *
 * The model is only as good as what it knows about the guest. This assembles a
 * compact, bounded, privacy-conscious context object from client state — saved
 * places, preferences, loyalty tier, the live rate card, current location — so
 * the concierge can resolve "take me home", quote accurately from real prices,
 * address the guest by name, and honour their cabin preferences, instead of
 * guessing. It is intentionally pure and size-capped: no PII beyond a first name
 * and labelled places, and hard limits so a hostile state can't bloat the prompt.
 */

export interface SavedPlace { label?: string; addr?: string }
export interface ConciergeContextInput {
  name?: string;
  tier?: string;
  savedAddresses?: SavedPlace[];
  prefs?: Record<string, unknown>;
  /** The client's PRICES rate card (only a curated subset is forwarded). */
  rateCard?: Record<string, number>;
  /** Current pickup/location label, if the guest has one set or granted GPS. */
  location?: string;
}

export interface ConciergeContext {
  guest?: { firstName?: string; tier?: string };
  saved?: Array<{ label: string; addr: string }>;
  prefs?: { temperature?: string; music?: string; convo?: string; discrete?: boolean };
  rateCard?: Record<string, number>;
  location?: string;
}

const s = (v: unknown, max = 80): string => String(v ?? '').trim().slice(0, max);

// Only these rate keys are forwarded — enough to quote every service, no noise.
const RATE_KEYS = [
  'airport_s', 'airport_v', 'hourly_s_rate', 'hourly_v_rate',
  'day_s', 'day_v', 'per_km_s', 'per_km_v', 'min_fare_s', 'min_fare_v',
] as const;

/** First name only — the concierge greets by first name, never full identity. */
export function firstName(name: unknown): string {
  return s(name).split(/\s+/)[0] || '';
}

/**
 * Build the bounded context object sent to parseBookingIntent. Returns undefined
 * when there's nothing useful to send (so we don't pad the prompt with empties).
 */
export function buildConciergeContext(input: ConciergeContextInput | null | undefined): ConciergeContext | undefined {
  if (!input) return undefined;
  const ctx: ConciergeContext = {};

  const fn = firstName(input.name);
  const tier = s(input.tier, 20);
  if (fn || tier) ctx.guest = { ...(fn ? { firstName: fn } : {}), ...(tier ? { tier } : {}) };

  const saved = (Array.isArray(input.savedAddresses) ? input.savedAddresses : [])
    .filter((a) => a && s(a.addr))
    .slice(0, 6)
    .map((a) => ({ label: s(a.label, 24) || 'Saved', addr: s(a.addr, 120) }));
  if (saved.length) ctx.saved = saved;

  const p = input.prefs;
  if (p && typeof p === 'object') {
    const prefs: ConciergeContext['prefs'] = {};
    if (p.temperature != null) prefs.temperature = s(p.temperature, 20);
    if (p.music != null) prefs.music = s(p.music, 20);
    if (p.convo != null) prefs.convo = s(p.convo, 20);
    if (p.discrete != null) prefs.discrete = !!p.discrete;
    if (Object.keys(prefs).length) ctx.prefs = prefs;
  }

  if (input.rateCard && typeof input.rateCard === 'object') {
    const rc: Record<string, number> = {};
    for (const k of RATE_KEYS) {
      const v = Number(input.rateCard[k]);
      if (Number.isFinite(v) && v > 0) rc[k] = Math.round(v * 100) / 100;
    }
    if (Object.keys(rc).length) ctx.rateCard = rc;
  }

  const loc = s(input.location, 120);
  if (loc) ctx.location = loc;

  return Object.keys(ctx).length ? ctx : undefined;
}
