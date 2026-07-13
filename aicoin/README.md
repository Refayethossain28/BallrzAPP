# AI Token (AIT) — the proof-of-work chain where miners mine AI tokens

A cryptocurrency blockchain whose miners mine **AI tokens**: currency pegged to
the atom of AI inference, the model token. The base unit is the **spark**
(1 AIT = 100,000 sparks), and the peg is one line long:

> **1 spark = 1 model token of inference.**

Mine a block and the coinbase pays you AIT; your balance *is* a metered right
to computation. [`index.html`](index.html) is a single-file full node — wallet,
miner, mempool, inference desk and block explorer — and every browser tab you
open is another independent node on the network.

## How it works

AIT doesn't reimplement a blockchain: it is a second chain on the same
dependency-free consensus core as its sibling [TimeCoin](../coin/README.md)
([`../coin/engine.js`](../coin/engine.js) — SHA-256 from FIPS 180-4, secp256k1
ECDSA with RFC 6979 nonces, base58check addresses, a UTXO ledger, merkle trees,
Bitcoin-style difficulty retargeting and fork choice by cumulative work, all
verified against published test vectors). [`engine.js`](engine.js) adds what
makes it an *AI* token:

| Piece | Design |
| --- | --- |
| Mining | Ordinary proof-of-work: grind double-SHA-256 nonces until the block hash meets the target; difficulty retargets every 10 blocks toward one block per 15 s |
| Block reward | **128 AIT**, halving every 131,072 (2^17) blocks |
| Supply cap | 128 × 2^17 × 2 = **2^25 = 33,554,432 AIT** — a power of two, as befits a machine currency; ~3.36 trillion model tokens will ever exist, all of them mined |
| The peg | 1 spark = 1 model token, so 1 AIT buys 100,000 tokens of inference and balances read directly as compute |
| Paying for AI | **Prompt-commitment receipts**: burn the cost to `base58check(sha256d(prompt)[0..20])` — an address derived from the prompt's hash, not from any key |
| Verifying a receipt | Reveal the prompt + txId; anyone re-derives the address and checks the confirmed transaction paid ≥ `costForTokens(n)` sparks |

Burning to a prompt-derived address does three jobs at once: the payment is
provably unspendable (no key exists for a hash-derived address), it commits to
the *exact* prompt on chain without revealing it, and it makes inference
deflationary — every question asked shrinks the AIT supply. There is no
privileged treasury address, so the chain stays neutral between inference
providers.

## Try it

Open [`index.html`](index.html) in a browser (or two tabs — nodes gossip over
`BroadcastChannel` and converge on the chain with the most cumulative work):

1. **Mine** — start the miner and watch the hashrate; each block found pays
   128 AIT to your wallet.
2. **Spend on inference** — type a prompt, get a quote in sparks, and pay; the
   receipt shows up with its confirmation count.
3. **Verify** — paste a txId + revealed prompt + token count to check a
   receipt the way an inference provider would.

## Tests

The consensus core is covered by TimeCoin's vector tests
([`../scripts/test-coin-logic.mjs`](../scripts/test-coin-logic.mjs)); the AI
layer — monetary schedule and cap, mining rewards, the peg, commitment
addresses, receipt verification and its failure modes, fees and fork choice —
by [`../scripts/test-aicoin-logic.mjs`](../scripts/test-aicoin-logic.mjs):

```
npm run test:aicoin
```

## Honest limitations

This is a working prototype, not production money. It inherits TimeCoin's
openly documented gaps — browser-grade key storage, JSON serialisation, no
script language, tab-local networking unless you run the relay — listed with
severities in [`../coin/SECURITY.md`](../coin/SECURITY.md). Two AIT-specific
caveats: token counts in receipts are what the buyer *claims* to be buying
(a provider should verify usage against the receipt before serving), and the
spark/token peg is a protocol constant, not a market price.
