# Helix — an online, non-stationary, fairness-aware decision engine

> One small, dependency-free engine that learns *which choice is best* from live
> feedback, adapts when the world changes underneath it, and **provably** never
> starves an eligible option.

- **`helix.js`** — the engine (UMD: `window.Helix` in the browser, `require()`/`vm` in Node). Zero dependencies, fully deterministic.
- **`demo.html`** — an interactive, in-browser demo. Open it and watch the engine learn.
- **`../scripts/test-helix-logic.mjs`** — 23 unit tests (`npm run test:helix`).

---

## Why this exists

Every app in this repo repeatedly **picks from a set of options** and only
*later* learns how good the pick was:

| App | The repeated choice | The feedback signal |
|-----|---------------------|---------------------|
| **apexvip** | which driver to offer a ride | accept? on-time? rating? |
| **rentmatch** | which listings to float to the top | tap / save / inquiry |
| **cusp** | which task to surface "right now" | did the user do it? |
| **trading-app** | which signal/strategy to weight | realized hit-rate / PnL |

The naive approaches both fail:

- **A/B testing** is slow and pours traffic into the *losing* arm for the whole test.
- **Greedy "show the best-so-far"** locks onto an early fluke and never recovers — and when the world shifts, it never notices.

Helix is the principled middle. It explores *just enough* to stay correct,
exploits the rest of the time, **forgets stale evidence** so it tracks change,
and gives a **hard fairness guarantee** so it's safe for things humans notice
(driver income, listing exposure, not burying a task forever).

---

## The algorithm

Three ideas, composed into one clean engine:

### 1. Discounted Thompson Sampling (the learner)
Each option ("arm") keeps a **Beta(α, β)** belief over its success probability.
To choose, Helix draws a sample `θ ~ Beta(α, β)` from *every* candidate and ranks
by `θ`. Options it knows little about have wide posteriors → they occasionally
sample high → they get tried. This is the Bayesian-optimal explore/exploit
trade, with matching-lower-bound regret guarantees (Agrawal & Goyal, 2012).

### 2. Exponential recency decay (the adaptation)
Real preferences drift. Before each update, an arm's evidence is multiplied by
`decay^Δ` (Δ = rounds elapsed) — lazily, in O(1), no per-round sweep. This pulls
the posterior back toward the prior at a controlled half-life.

- `decay = 1` → the classic **stationary** bandit (never forgets).
- `decay < 1` → **non-stationary**: old outcomes fade, so the engine re-learns after a shift.

### 3. Starvation guarantee (the fairness floor)
Pure Thompson sampling can, by chance, neglect a viable option for a long time.
Helix tracks **staleness** (rounds since last selected) and force-promotes any
arm past `starvationBudget`, most-neglected first.

> **Theorem.** With budget `B`, `n` arms, and `k` picks per round, every eligible
> arm is selected at least once every **`B + ⌈n/k⌉`** rounds.

A hard, testable upper bound on neglect — verified in the test suite.

### Reproducibility
All randomness flows through one seeded PRNG (mulberry32) → Box–Muller normals →
Marsaglia–Tsang Gamma → Beta draws. **Same seed + same feedback ⇒ identical
decisions.** State (including the PRNG stream position) round-trips through
`snapshot()` / `restore()`, so a learner can be paused, stored, and resumed
bit-for-bit.

---

## Quick start

```js
const Helix = require('./helix/helix.js'); // or <script src> → window.Helix

const engine = Helix({
  seed: 'dispatch-v1',   // reproducible
  decay: 0.98,           // forget slowly → adapt to drift
  starvationBudget: 40,  // no eligible arm waits > ~40+ rounds
});

engine.arm('driver-A').arm('driver-B').arm('driver-C');

// each dispatch:
const pick = engine.best();          // explore/exploit choice
// ... offer the ride to `pick`, observe what happened ...
engine.reward(pick, accepted ? 1 : 0);

// rank the top 3 for a feed instead of one pick:
const feed = engine.select(['l1', 'l2', 'l3', 'l4'], 3);

// inspect the current belief (for dashboards):
engine.stats('driver-A'); // { mean, sd, ci:[lo,hi], alpha, beta, pulls, staleness }

// persist / resume:
localStorage.setItem('helix', JSON.stringify(engine.snapshot()));
engine.restore(JSON.parse(localStorage.getItem('helix')));
```

## API

| Method | Purpose |
|--------|---------|
| `Helix(opts)` | create engine. `opts`: `decay` (0–1], `starvationBudget`, `priorAlpha`, `priorBeta`, `seed` |
| `arm(id, meta?)` | register/update an option (chainable) |
| `select(cands?, k=1)` | pick top-`k` (Thompson + fairness); **advances the clock & records selections** |
| `best(cands?)` | shorthand for `select(cands, 1)[0]` |
| `rank(cands?, k=1)` | same ranking **without** side effects (preview/test) |
| `score(cands?)` | exploration-free ranking by posterior mean (deterministic) |
| `reward(id, v)` | record outcome `v ∈ [0,1]` (fractional credit allowed) |
| `win(id)` / `lose(id)` | sugar for `reward(id, 1)` / `reward(id, 0)` |
| `stats(id)` | full posterior summary, or `null` |
| `snapshot()` / `restore(s)` | exact serialize / resume |
| `has` · `remove` · `ids` · `round` · `config` | bookkeeping |

## Tuning

| Goal | Setting |
|------|---------|
| Stable world, maximize long-run reward | `decay: 1` |
| Tastes/markets drift | `decay: 0.95–0.99` (lower = faster forgetting) |
| Guarantee exposure / fairness | `starvationBudget: N` (smaller = more even) |
| Optimistic cold-start (try new arms more) | raise `priorAlpha` |

## Tests

```bash
npm run test:helix   # 23 unit tests
npm test             # the whole repo suite (includes Helix)
```

The suite asserts the claims above directly: Beta/Gamma samplers match their
theoretical means, Thompson sampling converges and keeps regret sub-linear,
`decay` recovers after the world flips (where a stationary learner stays stuck),
and the starvation bound `B + ⌈n/k⌉` is never exceeded.
