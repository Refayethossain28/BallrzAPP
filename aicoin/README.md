# AI Token (AIT) — mine AI tokens, spend them on real AI

A cryptocurrency blockchain whose miners mine **AI tokens** — and whose tokens
are **redeemable**: the base unit, the **spark** (1 AIT = 100,000 sparks), is
pegged one-to-one to the model token, and a confirmed on-chain receipt runs a
real GPT **on your own device**, streaming exactly the tokens you paid for.

> **1 spark = 1 model token of inference — and you can actually redeem it.**

[`index.html`](index.html) is a single-file full node: wallet, proof-of-work
miner, mempool, **AI desk** (quote → pay → run), **notary**, and block
explorer. Every browser tab is an independent node; run
[`server.mjs`](server.mjs) and every *device* can join the same network from
one URL.

## The full loop

1. **Mine** — grind double-SHA-256 nonces; each block found pays its coinbase
   (128 AIT + fees) to your wallet. Every AIT in existence was mined.
2. **Pay** — type a prompt; the quote uses the model's *real BPE tokenizer*.
   The payment carries a burned commitment to `sha256d(prompt)`, proving what
   was bought without revealing it.
3. **Redeem** — once the receipt confirms, **Run** it: the from-scratch GPT
   ([`../llm-from-scratch`](../llm-from-scratch/README.md) — a 5-layer
   transformer ported to plain JS, no server, no API key) generates
   token-by-token on your device and stops at exactly the budget you paid for.
   Input tokens count against the budget, like any real inference API.

No company, no API key, no trust: the meter is consensus rules, the AI is
local, and the money is proof-of-work.

## How it works

AIT runs on the same dependency-free consensus core as its sibling
[TimeCoin](../coin/README.md) ([`../coin/engine.js`](../coin/engine.js) —
SHA-256 from FIPS 180-4, secp256k1 ECDSA with RFC 6979 nonces, base58check,
UTXO ledger, merkle trees, Bitcoin-style retargeting, fork choice by
cumulative work, verified against published test vectors).
[`engine.js`](engine.js) adds the AI layer:

| Piece | Design |
| --- | --- |
| Block reward | **128 AIT**, halving every 131,072 (2^17) blocks |
| Supply cap | 128 × 2^17 × 2 = **2^25 = 33,554,432 AIT** — ~3.36 trillion model tokens will ever exist, all mined |
| The peg | 1 spark = 1 model token; balances read directly as compute |
| Burn receipts | Whole cost → `base58check(sha256d(prompt)[0..20])`: provably unspendable, provider-neutral, deflationary |
| Provider receipts | Cost → any provider's address **+ 1 spark** burned to the prompt's commitment address, binding payment↔prompt — providers earn real AIT for serving inference, no address is privileged |
| Verifying | Reveal prompt + txId (+ provider address, if any): anyone re-derives the commitment and checks the confirmed amounts |
| **Notary** | The same commitment generalised to any content: burn 1 spark to `commitmentAddress(sha256d(bytes))` and the block's PoW timestamps that **this exact document existed** — verifiable forever from content + txId, revealing nothing until you choose |

## Run a network

```
npm run aicoin        # → http://localhost:8091
```

One process serves the app, both engines, the GPT runtime + weights, **and** a
gossip relay (TimeCoin's hardened `createRelay`, reused as a library: bounded
memory, per-IP rate limiting). A page opened from that URL auto-connects to its
own origin; other devices add the URL in the explorer's Network panel (or open
`…?relay=URL`). The relay is dumb by design — it forwards messages but can't
forge a spark; every node re-validates everything and adopts only the heaviest
chain. Same-browser tabs also sync directly over `BroadcastChannel`.

## Tests

```
npm run test:aicoin        # chain, peg, receipts, provider mode, notary, fork choice
npm run test:aicoin-relay  # the node+relay server: app serving + gossip API
```

The consensus core is covered by TimeCoin's vector tests
([`../scripts/test-coin-logic.mjs`](../scripts/test-coin-logic.mjs)).

## Honest limitations

A working prototype, not production money. It inherits TimeCoin's openly
documented gaps (browser-grade key storage, JSON serialisation, no script
language — see [`../coin/SECURITY.md`](../coin/SECURITY.md)). AIT-specific:

- **Redemption is local-first.** Your own node always honours a confirmed
  receipt against the bundled model. A *third-party* provider honouring
  provider-mode receipts is an economic promise, not a consensus rule — the
  chain proves payment, not delivery.
- **Token counts are claims.** A receipt states how many tokens were bought;
  a provider should verify usage against it before serving. (Your local node
  enforces the budget exactly.)
- The bundled model is a tiny from-scratch GPT trained on a small corpus —
  it demonstrates real, metered inference, not frontier quality.
- The spark/token peg is a protocol constant, not a market price; real
  inference costs float.
