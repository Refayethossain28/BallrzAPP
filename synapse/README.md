# Synapse (SYN) — the AI cryptocurrency

**Money minted by answering.** On Synapse, asking is a transaction, answering
is mining, and every answer is re-checked by consensus: a block is only valid
if every node, re-running the chain's model on the same seed and prompt, gets
the same answer byte-for-byte — **Proof of Inference**. Coins enter the world
only through served answers and leave your wallet only to buy them: the
currency *is* the compute.

Open [`index.html`](index.html) (or the
[live demo](https://refayethossain28.github.io/BallrzAPP/synapse/)) — create a
wallet from a secret phrase, mine the first block, ask the chain a question
with a fee attached, and watch the next block pay whoever answered it.

## The idea in one paragraph

The repo already holds two coins that answer "what backs the money?" in
different ways: [TimeCoin](../coin/) (pure proof-of-work, a Bitcoin built from
raw bytes) and [Neura](../neura/) (proof-of-work that must also *train* a
shared neural network). Synapse asks the third question: *what if the economy,
not just the consensus, were made of AI work?* Here the demand side is
prompts — anyone can attach a fee in SYN to a question — and the supply side
is inference: a miner serves every pending question, seals the prompt+answer
pairs into a block, grinds a light proof-of-work, and collects the fees plus a
halving block subsidy. Because the model is a pure function of
`(previous block hash, prompt)`, answers are consensus state: validation
re-runs the model, and a chain containing even one faked answer is rejected no
matter how much work it carries. The result is a currency whose every unit was
minted by a verified act of answering.

## Proof of Inference — how it actually works

1. **Asking is a transaction.** An ask carries the asker's address, the
   prompt (≤ 280 chars) and a fee in SYN. It waits in the mempool until a
   miner serves it.
2. **The seed is fixed before mining starts.** Answers are generated from the
   *previous* block's hash, so a miner can't shop around for a seed that
   produces answers it likes — the same commit-before-you-know discipline as
   Neura's training batches.
3. **Answering is mining.** The miner runs the model on every affordable
   pending ask, seals `(promptId, answer)` pairs into the block beside the
   asks, and grinds a nonce until the block hash clears the proof-of-work
   target.
4. **Every node verifies by re-inference.** Validation re-derives the block
   hash, re-checks the proof-of-work, re-computes every balance — and re-runs
   the model on every prompt. One character of difference in one answer is a
   rejected block. You cannot fake the thinking, skip it, or edit it after
   the fact.
5. **The money follows the answers.** Fees flow from askers to the miner who
   answered; the subsidy mints new SYN on a fixed curve. The UI's
   "re-verify the whole chain" button runs the full validation — every hash,
   every proof-of-work, every inference — on your device.

## Monetary policy

| Rule | Value |
|---|---|
| Block subsidy | 50 SYN, halving every 1,000 blocks |
| Hard cap | 99,994 SYN — the floor-halved series' exact sum (just under 100k, the same way Bitcoin's cap is just under 21M) |
| Premine | None — the genesis mints nothing; every coin is earned by answering |
| Units | 1 SYN = 1,000 mills (integer arithmetic throughout; no float money) |
| Fees | Asker-chosen, ≥ 0; a block serves only asks the asker can actually pay for, cumulative per asker |

## Prototype honesty — what is real and what stands in

This is a **concept prototype**, and the engine's header says so in plain
text. What is real: the consensus rule (re-inference as a validity condition),
the ledger discipline (balances, cumulative fee checks, subsidy verification,
full-chain validation from a pinned genesis), and the monetary policy — all
pinned by [19 unit tests](../scripts/test-synapse-logic.mjs), including one
that forges an answer and watches consensus reject it. What stands in:

- **The model** is a tiny seeded template-and-lexicon oracle, not a real LLM.
  It exists to be *deterministic* so consensus can re-check it. Swapping in a
  real model means swapping in deterministic (integer/fixed-point) inference —
  the consensus rule doesn't change.
- **Hashes** are iterated FNV-1a, not SHA-256, and **spend authorization** is
  enforced by the app holding your secret on-device, not ECDSA signatures.
  [`../coin/engine.js`](../coin/engine.js) implements the production-grade
  versions of both (FIPS 180-4 SHA-256, secp256k1 with RFC 6979) — Neura shows
  how to build on that core, and Synapse could be rebased onto it the same way.
- **The network** is one device. There is no P2P layer; your chain lives in
  your browser's localStorage.

**SYN is not tradeable and not an investment.** Making any token exchangeable
for real money is a legal and regulatory undertaking (securities, promotions
and money-transmission rules vary by jurisdiction) before it is an engineering
one. What is for sale here is the *product concept and codebase* — see the
[portfolio catalog](../docs/portfolio.md) and
[due-diligence pack](../docs/due-diligence.md).

## Why this concept is worth owning

Inference-backed currency is a genuinely current idea: decentralized AI
marketplaces need exactly this loop — pay to ask, earn to answer, verify the
answer trustlessly. Synapse is that loop reduced to its smallest working form:
a single readable engine ([`engine.js`](engine.js), ~330 lines, zero
dependencies) where the economics can be studied, tested and demonstrated end
to end, plus an installable offline PWA that makes the pitch self-serve.

## Architecture

Same shape as every prototype in this portfolio:

- [`engine.js`](engine.js) — every rule of the currency as pure, deterministic,
  clock-injected functions. Zero DOM, zero I/O, classic script (browser
  `<script>`, smoke sandbox, and `module.exports` from one file).
- [`index.html`](index.html) — the whole UI: wallet, ask, mine, ledger
  explorer with full-chain re-verification. State in localStorage only.
- [`sw.js`](sw.js) + [`manifest.json`](manifest.json) — installable,
  offline-first PWA.
- [`../scripts/test-synapse-logic.mjs`](../scripts/test-synapse-logic.mjs) —
  the 19-test suite CI runs on every push (`npm run test:synapse`).
- [`../scripts/gen-synapse-icons.mjs`](../scripts/gen-synapse-icons.mjs) —
  zero-dependency PNG icon generator (`npm run icons:synapse`).

## Run it

```sh
# the app: any static server (or just open synapse/index.html)
npx serve .

# the tests
npm run test:synapse
```

> **© Refayet Hossain — all rights reserved.** Part of the BallrzAPP
> portfolio, available for acquisition or commercial licensing — see the
> [repo README](../README.md).
