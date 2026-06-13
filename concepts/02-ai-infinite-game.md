# Concept 2 — AI Infinite Game

> A hyper-casual game with infinite, AI-generated levels that adapt to exactly
> your skill. It never runs out and it's never too hard or too easy. The
> contrarian bet: fastest possible path to a billion users, because games need
> zero network and zero trust.

---

## Part A — Product Spec

### The bet
Games hit scale faster than utilities — no contacts to invite, no trust to
earn, no account required to feel value in the first 5 seconds. The classic
hyper-casual ceiling is **content runs out** and **difficulty curves are
one-size-fits-all**. AI removes both ceilings:

- **Infinite content:** levels are generated, not authored, so you never hit
  "the end."
- **Personalized difficulty:** the generator targets *your* flow channel — hard
  enough to engage, easy enough not to rage-quit — per player, per session.

### Core loop (must be felt in 5 seconds)
1. Open app → you're already playing (no menu, no login).
2. One-thumb mechanic (swipe/tap), instantly understood.
3. Level ends → next level generated *while you played the last one*, tuned to
   how you just performed.
4. Streak / near-miss tension keeps you on "one more."

### The personalization engine (the actual product)
Track a small per-player skill vector (reaction time, accuracy, preferred
pacing, where they fail). The generator picks the next level's parameters to
keep predicted win-probability in the **flow band (~55–70%)** — winnable, but
not trivial. This is the entire moat: a generic level generator is a
commodity; one that keeps *you specifically* in flow is sticky.

### Honest weakness
**Retention.** Games churn harder than messaging — there's no network locking
you in. We counter with:
- **Daily personalized challenge** (a reason to return at a set time).
- **Cosmetic progression** (identity investment, not pay-to-win).
- **Generated "level of the day"** shared by a code, so players can compare runs
  on the *same* generated level — a lightweight social hook without requiring a
  social graph.

### Monetization
Rewarded video + cosmetic IAP. **No pay-to-win, no forced interstitials that
break flow** — the generation cost per session is real (see architecture), so
the model has to cover inference cost without poisoning retention. Cosmetics
and opt-in rewarded ads do; nag-screens don't.

### Non-goals (v1)
- No multiplayer realtime (huge cost, kills the "zero network" advantage).
- No user-generated content (moderation burden; the AI *is* the content
  engine).

---

## Part B — Architecture Sketch

### The cost reality that shapes everything
Per-session LLM/diffusion generation is **too expensive and too slow** to run
live for a free hyper-casual game at scale. So the architecture is built around
**not generating per-frame at runtime.** Two-tier:

```
 ┌──────────────┐   skill vector    ┌──────────────────────┐
 │  Game client │ ────────────────▶ │  Level selector       │
 │ (engine,     │                   │  (on-device, cheap)   │
 │  on-device)  │ ◀──────────────── │  picks from prefetched │
 └──────────────┘   next level       │  generated pool        │
        │                            └───────────┬───────────┘
        │ telemetry (skill updates)              │ refills async
        ▼                                        ▼
 ┌──────────────┐                    ┌──────────────────────┐
 │  Analytics   │                    │  Generation pipeline  │  (offline / batched)
 │  + skill     │                    │  AI generates a LARGE  │
 │  model       │ ─────────────────▶ │  library of parameter- │
 └──────────────┘   tunes generator  │  ized levels; tagged   │
                                     │  by difficulty vector  │
                                     └──────────────────────┘
```

### Key design decisions

**1. Generate offline, select online.** The AI produces a huge **library** of
parameterized levels, each tagged with a difficulty/feel vector. At runtime the
device just *selects* the level whose vector best matches the player's current
flow target — a cheap nearest-match, no inference in the hot path. This is the
single most important decision: it makes the unit economics work.

**2. Skill model runs on-device.** The per-player skill vector updates locally
from gameplay telemetry; no round-trip needed to pick the next level. Server
gets aggregated telemetry to improve the *generator*, not to make per-level
decisions.

**3. The generator is the asset, and it's a feedback loop.** Aggregate
telemetry ("levels in this region of difficulty space cause rage-quits") feeds
back to retune what the offline pipeline produces. Over time the library skews
toward levels that empirically hold players in flow. That data advantage
compounds and is hard for a cloner to replicate.

**4. Prefetch a pool to the device.** Ship the next N candidate levels ahead of
time so play works **offline and on bad networks** — preserving the zero-network
advantage and eliminating latency from the loop.

### Tech choices (defaults)
- **Engine:** Unity or Godot for cross-platform 2D with a tiny footprint;
  hyper-casual lives or dies on install size and time-to-first-play.
- **Generation pipeline:** offline/batch. Procedural parameter generation
  steered by an LLM/eval loop, **not** real-time diffusion. The LLM's job is to
  design and label the *parameter space* and grade generated levels for "fun,"
  not to render frames.
- **Backend:** thin. Telemetry ingest + a job that periodically refills/retunes
  the level library and pushes pools to clients. This can be small and cheap —
  most compute is offline and amortized across all players.
- **No account required** to play; optional sign-in only to sync cosmetics.

### Build order (smallest first slice)
1. **One mechanic + a hand-authored difficulty ramp.** Prove the core loop is
   fun *before* any AI. If a human-tuned ramp isn't fun, AI tuning won't save
   it.
2. **On-device skill model + select-from-a-fixed-pool.** Prove that adapting
   difficulty per player measurably improves session length vs. the fixed ramp.
3. **Offline generation pipeline** to grow the pool from hundreds to effectively
   infinite, with the telemetry feedback loop.
4. Daily challenge + cosmetics + shareable level codes.

### What would kill it
- Generating in the hot path → cost and latency both sink it. The offline
  library is not optional.
- "Infinite but samey" — if generated levels feel like reskins, novelty (the
  whole pitch) collapses. The generator must produce genuine variety, graded by
  the fun-eval loop, not just parameter noise.
- Treating it as a tech demo. The mechanic has to be fun with zero AI first;
  the AI raises the ceiling, it doesn't create the floor.
