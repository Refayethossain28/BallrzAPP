# TimeCoin security self-audit

An honest security assessment of TimeCoin — what is cryptographically sound,
what is still early-stage, and what a professional auditor would flag before the
currency safeguards significant value. Every serious currency publishes its
security posture; this one hides nothing. **Conclusion up front: the consensus
and cryptography are real and tested; the operational security (key storage,
network, hashpower) is early and still being hardened — see the roadmap in
[`ROADMAP.md`](ROADMAP.md).** Until the Critical items below are addressed, treat
TIME like cash in an unlocked drawer: fine for everyday time and favours among
people you trust, not yet a place to store wealth.

## What is genuinely sound

- **SHA-256 / HMAC-SHA256** — implemented from FIPS 180-4 / RFC 2104 and
  verified against published test vectors (FIPS examples, RFC 4231) in
  `scripts/test-coin-logic.mjs`.
- **ECDSA on secp256k1** — Bitcoin's curve. Nonces are RFC 6979 deterministic
  (no RNG at signing time, so the Sony-PS3-class repeated-nonce catastrophe is
  structurally impossible), signatures are low-S normalised (BIP-62
  malleability), and the implementation reproduces the classic RFC 6979
  secp256k1 test vector byte-for-byte.
- **Consensus rules** — every block is fully validated by every node: proof of
  work against the exact expected target, merkle commitment, coinbase value ≤
  subsidy + fees, every input's signature and ownership, no double-spends,
  median-time-past timestamps. Fork choice is by cumulative work, and
  `replaceChain` re-validates a candidate chain from genesis before adopting
  it. The test suite attacks each rule directly.

## What an auditor would flag

| # | Finding | Severity (if this were real money) |
| --- | --- | --- |
| 1 | **Private keys in `localStorage`, unencrypted.** Any XSS, browser extension or person at the keyboard can read them. Real wallets encrypt keys at rest behind a passphrase or hardware. | Critical |
| 2 | **Wallet entropy is demo-grade.** `generateWallet` mixes `crypto.getRandomValues` with `Math.random` as a fallback; if the CSPRNG were absent, keys would be guessable. | Critical |
| 3 | **Trivial total hashpower.** Difficulty is tuned for a phone to mine in seconds, so *anyone* can out-mine the whole network and rewrite history (a 51% attack costs one laptop). Bitcoin's security budget is measured in gigawatts. | Critical |
| 4 | **Non-constant-time BigInt arithmetic.** Point multiplication timing leaks could reveal key bits to a co-resident attacker. Real implementations use constant-time field arithmetic. | High |
| 5 | **The relay is a central point of censorship.** `server.mjs` can't forge blocks, but it can drop or delay them. It is now hardened against denial-of-service (per-client token-bucket rate limiting keyed on `x-forwarded-for`, and a message buffer bounded by both count and bytes), but it has no authentication and remains a single point through which one circle's traffic flows. Real networks use many independent peers; the app mitigates this with a multi-relay pool and failover. | High |
| 6 | **No coinbase maturity.** Freshly mined coins are spendable immediately; on a real network a reorg would invalidate downstream spends (Bitcoin makes miners wait 100 blocks). | Medium |
| 7 | **`replaceChain` re-validates whole chains.** An attacker can post long junk chains to burn CPU (validation is bounded but repeated). Real nodes validate incrementally with checkpoints. | Medium |
| 8 | **JSON serialisation.** Canonical enough here (fixed field order), but wire-format ambiguity is a classic source of consensus splits; real chains use strict binary formats. | Medium |
| 9 | **Address hash is double-SHA-256 truncated to 20 bytes** instead of RIPEMD-160(SHA-256). Fine cryptographically, but non-standard. | Info |
| 10 | **Portable reputation is signature-sound but not sybil-proof.** A receipt/vouch (`reputation.js`) proves *a key* signed it, and passports are re-verified locally so nothing can be forged or inflated — but one person with many keys can manufacture attestations about themselves. This is inherent to any web-of-trust. The app does **not** paper over it: it counts and shows *distinct authors* and, crucially, *how many of those you already know*, so a stranger's pile of self-issued receipts reads as exactly what it is. | Info |
| 11 | **Circle bridges move mutual credit, not scarce coins — and rest on trust in the bridge.** Only mutual credit bridges between circles (`bridge.js`): it's net-zero and limit-bounded, so a forwarding leg can't mint value (its signed nonce commits to the incoming leg, and the bridge is provably net-zero across the two circles). Mined TIME is deliberately **not** bridgeable, so one circle's supply can't leak into another. The residual risk is ordinary counterparty trust: the bridge could accept a favour in circle A and simply not forward it in circle B. That is a social risk between two people, not a way to counterfeit money — and each circle's credit limit still caps how far the bridge can go negative. | Info |

## Scope

No custodial service, no networking beyond the relay, no privacy features (all
balances are public by design, like Bitcoin). Responsible disclosure is welcome —
report anything else you find by opening an issue; hardening this list is exactly
how the currency earns the trust it asks for.
