# Trustless generalisation — a scoping study

> **Status: phases 1–5 now built** — 1–4 in [`tournament.js`](tournament.js),
> 5 in [`prover.js`](prover.js) (offline, on a mock feed + oracle; see the phase
> table in §6). This document remains the design of record and is deliberately
> honest about the one place trust cannot be removed, only relocated, and about
> phase 5 being *probabilistic* verification-cost reduction, not a succinct
> zk proof. A *real* decentralised outcome-oracle deployment is still the one
> remaining trust decision, and is a product choice, not code.

## 1. Why we need a different system

Cortex's base chain rewards *training* loss, which is fully trustless (anyone
recomputes it) but rewards fitting the visible data — it cannot tell
generalisation from memorisation. The `holdout.js` commit–reveal layer measures
generalisation, but only by having a trusted party **withhold** test data.

There is a theorem-shaped reason we keep hitting a wall:

> **You cannot measure generalisation trustlessly on a fixed, public dataset.**
> Generalisation is performance on data *outside* the training set. Trustless
> verification requires validators to recompute the score, which requires the
> data to be public. Any public data is data a miner could have trained on. So
> the test data must be *both* public-for-verification *and* unavailable-at-
> training-time — a contradiction for any dataset that exists at genesis.

The only escape is data that **does not exist yet when the miner commits** and
becomes public **later**. That is not a patch to the current design; it is a
different machine. This document scopes that machine.

## 2. The key idea: let the future withhold the data

Stop trying to hide a static test set. Instead score models on **future events**:

1. At time *t*, publish **features** for an event whose **outcome is not yet
   known** (e.g. today's market/sensor/telemetry snapshot).
2. Miners commit models (or predictions) for that event **before** *t+Δ*.
3. At *t+Δ* reality produces the **label** (the outcome), which an external
   process makes public and verifiable.
4. Score each committed model on the realised outcome. Reward predictive skill.

No one has to be trusted to *withhold* the label: the future withholds it
inherently, and no miner can train on data that does not exist. This turns
Cortex into a **decentralised forecasting tournament** — the same shape as
[Numerai](https://numer.ai) (crowdsourced models staked and scored on future
market returns) and the broad "proof of useful work / prediction market"
literature. We should treat that as prior art, not reinvent it.

## 3. Architecture: a forecasting-tournament chain

Block/round lifecycle (one *round* per prediction horizon):

```
 OPEN        features_t published (with a commitment), outcome unknown
   │         miners train on all HISTORICAL rounds (fully public — fine, those are settled)
   ▼
 COMMIT      miner publishes H(prediction) or H(weights) + stake, signed        ← beacon window opens
   │         (beacon from a future block hash fixes any per-round randomness)
   ▼
 LOCK        commit window closes; no more entries for this round
   ▼
 RESOLVE     at t+Δ the outcome label arrives via an outcome oracle (§4)
   ▼
 SCORE       validators recompute each model's loss on (features_t, outcome);
   │         reward = skill vs baseline / vs field; stake slashed for anti-skill
   ▼
 SETTLE      MIND minted to skilful predictors; round joins the public history
```

### What Cortex already gives us (reuse, unchanged)

| Need | Reuse |
| --- | --- |
| Hashing, signatures, addresses, wallets | `coin/engine.js` (secp256k1, SHA-256) |
| Spendable reward token, bounded issuance | MIND (`engine.js`) |
| Hash-linked, signed, tamper-evident blocks | `engine.js` `Chain` |
| Commit before reveal; weight/prediction binding | `holdout.js` `commit` / `commitWeights` / `settle` |
| Unpredictable, discretion-free selection | `holdout.js` `beaconSelect` |
| The model + deterministic scoring | `engine.js` `loss` / `predict` / `standardizeRows` |
| Staking/slashing & reputation primitives | `coin/reputation.js` (already in the repo) |

### What is genuinely new (must build)

1. **Round scheduler** — OPEN→COMMIT→LOCK→RESOLVE→SCORE state machine keyed to
   wall-clock horizons, not just block height.
2. **Feature feed** — a way to publish features_t and commit to them so inputs
   can't be altered after the fact.
3. **Outcome oracle** — the mechanism that brings the realised label on-chain
   (this is the crux; see §4).
4. **Skill-based reward & staking** — reward = predictive skill relative to a
   baseline or the field (a scoring rule, e.g. proper log-loss vs the median
   entry); stake to enter, slash persistent anti-skill to stop spam/Sybil.
5. **Scoring scale** — validators must re-score every entry each round; needs
   an entry cap, aggregation, or succinct proofs if entry counts grow.

## 4. Where the trust actually goes (the honest part)

We removed the *data-withholding* trust. We did **not** remove trust entirely —
we relocated it to the **outcome oracle**: someone/something must report the
realised label, and validators must agree on it.

| Design | Trust required | Trustless? |
| --- | --- | --- |
| Base chain (train loss) | none | ✅ but doesn't measure generalisation |
| `holdout.js` commit–reveal | data withholder: no-leak + honest reveal | ❌ |
| `holdout.js` + beacon | data withholder: no-leak (discretion removed) | ❌ (narrower) |
| **This design** | **outcome oracle: reports labels honestly** | ⚠️ *as trustless as its oracle* |

The good news: "get an exogenous real-world outcome on-chain honestly" is a
**well-studied, separable problem** with real decentralised solutions
(Chainlink-style oracle networks, Schelling-point oracles like UMA/Kleros,
optimistic-oracle + dispute games). So the residual trust is (a) reducible to an
honest-majority / staked-dispute assumption rather than a single party, and (b)
not Cortex's to invent — we consume an oracle as a dependency.

Best-case honesty: this is **trust-minimised, not trustless.** For outcomes that
are objective and cheaply attestable (crypto prices, sports scores, block
contents, published statistics) the oracle assumption is mild. For subjective or
manipulable outcomes it is not — pick tasks accordingly.

## 5. Hard / open problems (do not hand-wave these)

- **Oracle capture & manipulation.** If the outcome can be influenced by a
  wealthy actor (thin markets, low-liquidity feeds), prediction skill becomes
  manipulation skill. Restrict to deep, exogenous outcomes; use dispute windows.
- **Data poisoning of features.** Whoever supplies features_t could bias them.
  Mitigate with multiple independent feeds + on-chain commitment + staking.
- **Scoring cost / DoS.** N entries × M samples re-scored by every validator
  each round. Needs caps, sampling with a beacon, or (ambitiously) zk proofs of
  correct scoring.
- **Cold-start & liquidity.** A tournament needs enough skilled entrants for
  "skill vs field" to mean anything; MIND has to bootstrap value first.
- **Continuous vs batched labels.** Some outcomes resolve in seconds, some in
  weeks; the round machine must handle multiple horizons.
- **Front-running the reveal.** Whoever sees the outcome first (oracle operators)
  must not also mine — needs role separation and/or commit ordering by beacon.
- **Determinism across nodes.** Same float-determinism caveat as today, now over
  a live feed; canonicalise feature encoding and quantise as the base chain does.

## 6. Phased plan

Each phase is independently useful and testable; stop at any point.

| Phase | Deliverable | Status | New trust |
| --- | --- | --- | --- |
| **0** | commit–reveal + beacon on a fixed dataset | ✅ shipped (`holdout.js`) | data withholder |
| **1** | Round state machine + feature commitment, driven by a *mock* feed | ✅ built (`tournament.js`) | none new (mock) |
| **2** | Skill-based scoring rule + staking/slashing | ✅ built (`tournament.js`) | none new |
| **3** | Pluggable outcome-oracle interface + a reference signed-feed adapter | ✅ built (`tournament.js`) | **the oracle** |
| **4** | Anti-abuse: entry caps, beacon-sampled scoring, m-of-n committee + optimistic dispute window | ✅ built (`tournament.js`) | committee honest-majority + dispute quorum |
| **5** | cut validator scoring cost: committed transcript + beacon spot-checks + fraud proofs | ✅ built (`prover.js`) — probabilistic, not zk-succinct | — |

Phases 1–4 are implemented and driven end-to-end **offline** by
`scripts/test-cortex-tournament.mjs` on a deterministic mock feed + oracle: a
model trained on resolved history earns MIND predicting an unseen future round;
a confidently-wrong model is slashed; noise-level skill lands in a dead zone and
earns nothing. Phase 4 hardens it: an entry cap and beacon-sampled scoring bound
the per-round work; the single-key oracle generalises to an **m-of-n committee**;
and an **optimistic dispute window** (propose → dispute → finalise, with bonds)
means the committee is only invoked when a proposal is challenged, with the wrong
side's bond slashed to the right side. Trust is thereby reduced to "an honest
party will dispute a bad proposal, and the committee adjudicates honestly" — but
still not removed. Phase 5 (`prover.js`) then cuts the *cost* of checking a
score: the scorer commits a per-sample loss transcript in one Merkle root, a
beacon spot-checks k ≪ M samples, and any single mismatch is a fraud proof — so
a validator re-runs the model on k samples instead of all M. This is
*probabilistic* soundness (a reward-relevant lie is caught with high probability;
`verifyFull` is the exact backstop), NOT a succinct zk proof — that would need
zk-SNARKs of NN inference, which a from-scratch repo can't honestly claim. A
*real* committee/oracle deployment is the one remaining trust decision, and is a
product choice, not code.

## 7. Recommendation

- If the goal is a **compelling, honest demonstration** of trustless-*er*
  generalisation: build **Phases 1–2** with a mock/replayable feed. It proves
  the mechanism end-to-end, stays offline-testable like the rest of the repo,
  and adds no new trust. This is the recommended next step if we continue.
- If the goal is a **real deployment**: it depends on choosing a task whose
  outcome oracle you're comfortable trusting (Phase 3+). That is a product
  decision about acceptable trust, not a coding decision.
- What we should **not** do is claim the fixed-dataset layers are trustless, or
  build an oracle and imply it removes trust rather than relocating it.

The honest one-line summary: **fully trustless generalisation is unreachable;
trust-*minimised* generalisation is reachable by scoring predictions of the
future and depending on a decentralised outcome oracle — a forecasting
tournament, not a patch to the current chain.**
