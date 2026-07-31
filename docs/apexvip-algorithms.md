# ApexVIP™ Proprietary Algorithms

**© 2026 ApexVIP. All rights reserved.**

This document and the source code it describes are original works of authorship
owned by ApexVIP. The source code is protected by copyright from the moment of
creation; this document serves as the formal specification and as supporting
material for a copyright registration deposit. Unauthorized copying,
modification, distribution, or use is prohibited.

| Algorithm | Module | Tests |
|---|---|---|
| ApexMatch™ | `apexvip-web/src/dispatch/match.ts` | `match.test.ts` (8 cases) |
| ApexPulse™ | `apexvip-web/src/demand/pulse.ts` | `pulse.test.ts` (6 cases) |
| ApexYield™ | `apexvip-web/src/pricing/yield.ts` | `yield.test.ts` (7 cases) |

All three are pure, deterministic TypeScript modules compiled into the shared
`ApexEngine` bundle and consumed by the ops console (dispatch ranking, demand
dashboard) — with no external services, so they run on-device and offline.

---

## 1 · ApexMatch™ — explainable driver–job matching

**Problem.** First-to-accept broadcast is a race that rewards whoever taps
fastest; nearest-driver dispatch ignores service quality. A luxury operation
needs the *right* chauffeur per job — and an answer to "why did Marco get it?"

**Method.** Each eligible driver receives a score in [0, 100] from six
factors, each normalized to [0, 1]:

1. **Performance** — customer rating under Bayesian shrinkage
   `r̂ = (n·r + K·prior)/(n + K)` with prior 4.6, K = 12, so small samples
   cannot outrank proven records.
2. **Reliability** — offer-acceptance rate under the same shrinkage
   (prior 0.75, K = 8).
3. **Proximity** — `e^(−km/6)` over the haversine distance; unknown positions
   score a neutral 0.5 rather than being punished.
4. **Fairness** — a saturating idle boost `min(1, log1p(idleMin)/log1p(240))`
   that spreads work across the fleet (driver retention as a scoring goal).
5. **Vehicle fit** — exact class 1.0 · luxury-compatible upgrade 0.7 ·
   physically unfit 0 (capacity gate: 5+ passengers require a V-Class).
6. **VIP affinity** — for gold/vip/black guests, performance is re-weighted
   ×1.5 and reliability ×1.25: marquee clients get the proven best.

Base weights: performance .30 · proximity .25 · reliability .20 · fairness
.15 · vehicle fit .10 (normalized after VIP re-weighting). **Hard gates**
(exclusion, not low scores): lapsed compliance, not online, capacity-unfit
vehicle. The result carries the full per-factor breakdown for the ops UI.

## 2 · ApexPulse™ — self-learning demand forecasting

**Problem.** Know when the busy windows are — from nothing but the operation's
own booking history, with zero ML infrastructure.

**Method.**
1. **Recency-weighted binning** — each booking adds weight
   `0.5^(ageDays/28)` (28-day half-life) to its hour-of-week bucket
   (168 buckets, Mon 00:00 → Sun 23:00).
2. **Circular smoothing** — convolution with kernel [.25, .5, .25] wrapping
   the week boundary, so a 17:00 rush warms its shoulders.
3. **Normalization to mean 1.0** — a bucket value of 2.4 reads "2.4× a
   typical hour", independent of fleet size.

**Derived signals:** `heatAt(when)` (instant intensity), `nextPeak(from)`
(the coming ≥1.25× local maximum within 24 h, with lead time and label,
e.g. "Fri 17:00 in 3 h"), and `goOnlineAdvice(when)` (chauffeur-facing
recommendation: strong ≥1.5× · good ≥1.1× · ramp when a peak is ≤2 h out ·
quiet otherwise, always naming the next peak). **Cold start:** below 25
weighted observations the model reports `ready:false` and consumers show
nothing rather than noise.

## 3 · ApexYield™ — brand-safe dynamic pricing

**Problem.** Ride-hail surge maximizes short-term revenue and burns luxury
trust. ApexYield is yield management under an explicit **brand-safety
contract**, every clause enforced in code:

1. **Hard cap** — multiplier ∈ [0.90, 1.35]; 35% is the absolute ceiling, and
   0.90 is a discreet quiet-hour courtesy, never a fire sale.
2. **Log damping** — `target = 1 + 0.25·ln(1 + pressure)`; doubling scarcity
   does *not* double the premium.
3. **Hysteresis** — at most ±0.05 movement per update; a watched quote never
   jumps under the guest's thumb.
4. **Quantization** — 0.05 steps, so a surged fare still reads as a price.
5. **Loyalty immunity** — gold-and-above members are never surged (discounts
   still apply): "members never pay surge" is a marketing asset priced into
   the model.
6. **Predictive pre-warm** — pressure = live open-jobs : idle-drivers ratio
   **plus** 0.3 × (ApexPulse heat − 1), so predictable rushes ramp gently
   before the queue forms.

The quote reports the applied multiplier, the uncapped target (telemetry),
the honest direction (rising/falling/steady), and whether loyalty protection
fired.

---

## Protecting this IP — practical notes (not legal advice)

- **Copyright exists automatically** in all of this code and this document.
  Registration (e.g. US Copyright Office, form TX, with source-code deposit)
  strengthens enforcement and statutory damages. The UK has no registration
  system — keep dated records (this git history is strong evidence of
  authorship and date).
- **Algorithms as ideas** are not protected by copyright — that is patent
  territory (hard for software in the UK/EU) or **trade secret** territory.
  Trade-secret protection requires actual secrecy: if this repository is
  public, these modules are published. To keep them secret, make the repo
  private and restrict access; the ™ markings assert brand claims either way.
- **Marks** — ApexMatch™, ApexPulse™, ApexYield™ (and ApexVIP™) are used here
  as unregistered marks; consider UK trademark registration for the names.
- Every module carries a copyright header and this document is the canonical
  specification. Consult an IP solicitor for registration/patent strategy.
