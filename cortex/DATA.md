# Cortex data provenance

Cortex is a Proof-of-Learning chain: **every node must recompute the loss on
byte-identical data**, or honest nodes would disagree and the chain would fork.
So datasets are not fetched at runtime — each one is **embedded verbatim** in
`cortex/datasets.js` and **pinned by SHA-256** in `scripts/test-cortex-logic.mjs`.
If a single byte changes, the test fails and the change is caught.

This document says exactly where each dataset comes from, and — just as
importantly — what is **real** and what is **simulated**. Nothing here is
dressed up as more than it is.

## What's embedded today

| dataset | real? | what one row is | label | rows | source |
|---|---|---|---|---|---|
| `onset` **(LIVE task)** | ✅ real | a country-year, 1945–1998 (7 covariates; year kept as split metadata) | 1 = a **civil war began** (RARE: 1.65%) | 6125 | Fearon & Laitin 2003 (APSR) via github.com/hail2thief/juanr `fearon.rda` |
| `war` | ✅ real | a militarized interstate confrontation | 1 = it turned **lethal**, 0 = it did not | 2324 | Correlates of War (`mmb_war`) via Rdatasets/`{stevedata}` |
| `banknote` | ✅ real | wavelet features of a banknote photo | 1/0 authenticity | 1372 | UCI Banknote Authentication |
| `phishing` | ✅ real | 30 URL/site signals | 1 = phishing | 3000 (sampled) | UCI Phishing Websites |
| `conflict` | ⚠️ **simulation** | a hypothetical country-period | 1 = conflict (SIMULATED) | 2000 | generated from published risk factors — **not real events** |

Each real dataset's exact bytes hash to a value pinned in the test suite. The
`conflict` **simulation** is deterministic and its generator output is pinned
too, but it is clearly flagged `synthetic: true` and titled "SIMULATION" so it
can never be mistaken for real conflict data. See the long comment above
`generateConflict()` in `datasets.js` for the risk factors it is grounded in
(Fearon & Laitin 2003; Collier & Hoeffler 2004; Hegre et al.; Uppsala ViEWS).

## The live task: real civil-war **onset**, honestly graded

The `onset` task answers the question this project circled for weeks:

> *Does a civil war begin in this country-year?*

on the **real Fearon & Laitin (2003) replication data** — the canonical academic
onset study, and the very paper whose risk factors our earlier `conflict`
simulation was modelled on. The simulation is now superseded by the real thing
(it stays embedded, clearly labelled, as a record of the honest path we took).

Provenance and preparation, in full:

- **Source:** Fearon, James D. & David D. Laitin. 2003. "Ethnicity, Insurgency,
  and Civil War." *American Political Science Review* 97(1): 75–90. Obtained
  from the maintained public mirror in Juan Tellez's `{juanr}` teaching package
  (`github.com/hail2thief/juanr`, `data/fearon.rda`) — the same
  GitHub-mirror provenance channel as our `war` dataset.
- **Preparation (deterministic, documented in `datasets.js`):** rows with any
  missing value dropped (6,610 → 6,125); the onset label binarised (F&L code
  `4` = multiple onsets → `1`); features rounded to 6 decimals. Both the
  feature/label bytes and the year column are SHA-256-pinned in the tests.
- **Honesty about imbalance:** onsets are RARE — 101 of 6,125 rows (1.65%).
  Raw accuracy is therefore a meaningless number (always-predict-peace scores
  98.3%). The network's honest metrics are **cross-entropy skill vs the
  always-peace baseline** and **risk ranking** (does a real onset score higher
  than a peace-year?).
- **The temporal split (the whole point):** the consensus task trains **only on
  years ≤ 1988**. Every row after 1988 is held out — the model is *never paid*
  to fit it — and the dashboard grades the tip model on that unseen future.
  That number is generalisation, not memorisation.

## Adding more onset data later (the same honest path)

Richer sources (UCDP/PRIO at `ucdp.uu.se`, ACLED at `acleddata.com`) require
registration and licence acceptance we cannot do for you. When you have a CSV,
the builder wires it in with the *same* integrity treatment:

```sh
# 1. See the CSV's columns:
node scripts/build-onset-dataset.mjs your-onset-data.csv

# 2. Write a config naming the feature columns + the onset label, then build:
node scripts/build-onset-dataset.mjs your-onset-data.csv onset.config.json > onset.block.js
```

The builder (`scripts/build-onset-dataset.mjs`):

1. cleans the CSV deterministically (drops rows with missing/non-numeric
   values, binarizes the label, rounds features),
2. computes the **pinned SHA-256** using the coin's own `sha256` — the exact
   value the test will assert, in the exact canonical form the other datasets
   use, and
3. prints a paste-ready `*_CSV` constant + `DATASETS` entry, plus the test
   assertions and the copy/task edits needed to make it live.

It never downloads or fabricates anything — it only transforms a file **you**
provide and verified. Fill in the real **source, version, and download date**
in the emitted `source:` line and in the table above before shipping.

## A deliberate caution

Real conflict *onset* forecasting is humanitarian early-warning work. It should
be done by domain experts with carefully-licensed data, and it should **not** be
turned into a gamified live prediction market — such markets can be manipulated
and can even be self-fulfilling. Cortex can learn the *shape* of these problems
honestly; treat any onset model here as a research and educational artifact, not
an operational forecast.
