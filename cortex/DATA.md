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
| `war` **(LIVE task)** | ✅ real | a militarized interstate confrontation | 1 = it turned **lethal**, 0 = it did not | 2324 | Correlates of War (`mmb_war`) via Rdatasets/`{stevedata}` |
| `banknote` | ✅ real | wavelet features of a banknote photo | 1/0 authenticity | 1372 | UCI Banknote Authentication |
| `phishing` | ✅ real | 30 URL/site signals | 1 = phishing | 3000 (sampled) | UCI Phishing Websites |
| `conflict` | ⚠️ **simulation** | a hypothetical country-period | 1 = conflict (SIMULATED) | 2000 | generated from published risk factors — **not real events** |

Each real dataset's exact bytes hash to a value pinned in the test suite. The
`conflict` **simulation** is deterministic and its generator output is pinned
too, but it is clearly flagged `synthetic: true` and titled "SIMULATION" so it
can never be mistaken for real conflict data. See the long comment above
`generateConflict()` in `datasets.js` for the risk factors it is grounded in
(Fearon & Laitin 2003; Collier & Hoeffler 2004; Hegre et al.; Uppsala ViEWS).

## The live task: conflict **lethality**, not **onset**

The `war` task answers a real, learnable question on verified data:

> *Given a militarized confrontation between states is already happening, does
> it turn lethal?*

It does **not** answer the more valuable **onset** question — *will a conflict
break out at all?* — because that requires data we will not embed until it is
verified (below).

## Adding real conflict **onset** data (the honest path)

Onset forecasting is the prediction most worth having, and its canonical
sources are:

- **UCDP / PRIO Armed Conflict Dataset** — the academic standard, `ucdp.uu.se`
  (free for research; cite the version).
- **ACLED** — Armed Conflict Location & Event Data, `acleddata.com`
  (registration + attribution required).

We do **not** ship an onset dataset, on purpose: this project will not embed or
hash-pin conflict data it has not verified, and these sources require you to
download under their licence. When you have a real CSV, the builder wires it in
with the *same* integrity treatment as `war`/`banknote`/`phishing`:

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
