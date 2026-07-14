# Neura (NEURA) — the chain that thinks

**An AI-native cryptocurrency designed as a store of value.** 21,000,000 coins,
fixed forever, issued on Bitcoin's exact halving curve — and one new consensus
rule: **Proof of Intelligence**. Every block must advance the chain's shared
neural network by one verifiable training step, so the same energy that secures
the money also grows a mind the whole network co-owns.

Open [`index.html`](index.html) (or the
[live demo](https://refayethossain28.github.io/BallrzAPP/neura/)) — create a
wallet, mine, and watch the **mind of the chain** learn to paint its own mark.
The story in one scroll: [the website](https://refayethossain28.github.io/BallrzAPP/neura/promo.html)
([`promo.html`](promo.html)) — its hero is the real network training live on
the page.

## The idea in one paragraph

Bitcoin's insight was that provable scarcity plus proof-of-work makes money no
one can print. Neura keeps that whole design — it is built directly on the
repo's from-scratch Bitcoin engine ([`../coin/engine.js`](../coin/engine.js):
FIPS 180-4 SHA-256, secp256k1 ECDSA with RFC 6979, base58check, a UTXO ledger,
merkle trees, difficulty retargeting, heaviest-chain fork choice, all verified
against published test vectors) — and adds one question: *what if the work that
secures the chain also had to be intelligent?* On Neura, a block is only valid
if its miner ran one exact SGD training step of the chain's neural network and
committed the resulting weights' hash into the block. Every node re-runs the
step to check it. The network's mind is consensus state: everyone agrees, block
by block, on what the chain has learned.

## Proof of Intelligence — how it actually works

1. **The mind is shared state.** A small MLP (2→32→32→1) lives at every node.
   Its genesis weights are derived from the genesis message, so all nodes start
   with the identical mind. Its job: learn to paint the Neura mark (a ring
   around an N), defined as an exact signed-distance field.
2. **Each block must train it.** To mine block *H*, you must apply one training
   step — 16 SGD updates on mini-batches drawn from a PRNG seeded by
   `sha256("NeuraPoI|" + H + "|" + prevHash)`. The batch is fixed by the previous
   block's hash **before mining starts**, so it can't be cherry-picked.
3. **The learning is sealed by the work.** The trained weights' SHA-256 goes in
   the coinbase as `PoI1|<hash>`; the coinbase id feeds the merkle root, which
   feeds the block hash, which the proof-of-work grinds against. Tampering with
   the commitment invalidates the PoW.
4. **Every node verifies by re-deriving.** Validation re-runs the training step
   locally and compares hashes. There is no way to fake, skip, or approximate
   the learning — the step is bit-deterministic (see below), so one wrong float
   anywhere is a different hash and a rejected block.
5. **Fork choice respects both.** Chains compete by cumulative proof-of-work,
   Nakamoto-style — but a chain containing even one invalid Proof of
   Intelligence is rejected outright, no matter how much work it carries
   (tested: `a HEAVIER chain with fake intelligence is still rejected`).

**Why it's bit-deterministic across machines:** consensus code can only use
operations IEEE 754 defines exactly — `+ − × ÷`, `sqrt`, `abs`, `min`, `max`,
comparisons. No `Math.exp`, `sin` or `tanh` (their results vary by JS engine
and would fork the chain), hence ReLU activations, an MSE loss, a
distance-field target, an integer PRNG (sfc32), and explicit little-endian
serialisation. Two nodes on different CPUs and browsers derive identical
weights from the same chain. ([`brain.js`](brain.js) documents every choice.)

## Monetary policy — the store-of-value design

| Property | Value |
| --- | --- |
| Hard cap | **21,000,000 NEURA** — enforced by consensus, like Bitcoin's 21M |
| Subsidy | 50 NEURA at block 1, **halving every 210,000 blocks** (Bitcoin's exact curve) |
| Premine | **None.** The genesis coinbase pays nobody; supply starts at 0 |
| Smallest unit | 1 spark = 0.00001 NEURA (integer arithmetic throughout — no float money) |
| Block target | 15 s, difficulty retargeting every 10 blocks (×4 clamp, like Bitcoin) |
| Fees | Paid to the miner, on top of the subsidy |

The store-of-value case: money holds value when nobody can print more of it and
when the cost of attacking its history exceeds the reward. Neura's supply is a
consensus rule, not a promise; its history is defended by proof-of-work; and
its issuance only ever happened because someone did the work — mining is
joining, and each block leaves a permanent trace in what the chain knows.
Anchoring the community story to the shared mind — a thing that visibly grows
and that no one can own alone — is what makes people *want* to hold a piece.

## What "involves AI" honestly means here

The on-chain network is deliberately small (≈1,200 parameters) so that **every
node can afford to verify every training step** — verifiable AI, not big AI.
That trade-off is the honest heart of the design: verification costs the same
as the work (validators re-run the step), which bounds how much intelligence a
block can carry. The interesting property isn't the model's size; it's that
**training happens under consensus**: the learning curve is part of the chain's
history, reorgs literally rewind the mind, and the "smartest chain" and the
"heaviest chain" grow together.

## Run it

```sh
open neura/index.html          # or serve the repo root and visit /neura/
```

- **Mine & train:** one button does both jobs — 🧠 think (the required training
  step), then ⛏ grind (the proof-of-work). Reward: 50 NEURA + fees.
- **The mind:** the hero logo and the mind panel are rendered from the live
  consensus weights — at genesis it's noise; the mark emerges over a few
  hundred blocks. The synapse score (0→100) tracks it.
- **Network:** open a second tab — each tab is an independent node; they gossip
  blocks and transactions over `BroadcastChannel` and converge on the heaviest
  valid chain. The chain and wallets persist in `localStorage`.
- **Dedicated miner** ([`mine.html`](mine.html)): for leaving a device running.
  It holds **no keys and can't spend** — paste a payout address from the app
  (or follow the app's prefilled `?pay=` link), press start, and it thinks,
  grinds and pays rewards to that address, keeping the screen awake where the
  browser allows. It joins the same tab-to-tab network as the app.

Tests — the brain's determinism, the PoI rules under attack (missing, forged
and stale commitments; a heavier chain with fake intelligence), the 21M cap,
transfers, double-spends, fork choice and JSON round-trips:

```sh
npm run test:neura             # 17 tests, zero dependencies
```

## Known limitations — read before you trust it with value

Neura is a real, working implementation, and an early one. Everything that is
true of TimeCoin's security posture ([`../coin/SECURITY.md`](../coin/SECURITY.md))
is true here: browser-grade key storage (unencrypted localStorage), JSON
instead of a wire format, no Script language, tab-level gossip rather than true
p2p. Neura adds its own honest caveats:

- **Verification replays training.** Syncing a chain of N blocks re-runs N
  training steps (~20 ms each), so full validation of very long chains is slow
  by design. A production design would checkpoint verified weights.
- **PoI adds usefulness, not extra security.** The security budget is still the
  proof-of-work; the training step is cheap relative to expected hashing. What
  PoI guarantees is that the chain's mind can't be faked — not that mining is
  mostly AI work.
- **No market, no price.** NEURA is not listed, not sold, and not an
  investment. It's a working thesis about what an AI-native store of value
  would have to look like — with every claim enforceable in ~600 lines you can
  read.

## Files

| File | What it is |
| --- | --- |
| [`brain.js`](brain.js) | The deterministic neural network: sfc32 PRNG, ReLU MLP, SDF target, exact serialisation |
| [`engine.js`](engine.js) | The Neura chain: PARAMS, Proof-of-Intelligence validation, PoI-aware fork choice |
| [`index.html`](index.html) | The whole node in one file: landing page, wallets, miner, explorer, the mind |
| [`mine.html`](mine.html) | The dedicated miner — keyless, mines to a pasted address, for always-on devices |
| [`promo.html`](promo.html) | The website — a one-page pitch whose hero is the real network training live |
| [`../scripts/test-neura-logic.mjs`](../scripts/test-neura-logic.mjs) | The test suite (`npm run test:neura`) |
