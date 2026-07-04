# BallrzCoin security self-audit

An honest assessment of what is cryptographically sound in this codebase, what
is demo-grade, and what a professional auditor would flag before anyone treated
this as more than a teaching toy. **Conclusion up front: the consensus math is
real, the operational security is deliberately not.** Do not hold anything of
value with it.

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
| 5 | **The relay is a central point of censorship.** `server.mjs` can't forge blocks, but it can drop or delay them, and it has no rate-limiting or authentication — one noisy client can flood it. Real networks use many independent peers. | High |
| 6 | **No coinbase maturity.** Freshly mined coins are spendable immediately; on a real network a reorg would invalidate downstream spends (Bitcoin makes miners wait 100 blocks). | Medium |
| 7 | **`replaceChain` re-validates whole chains.** An attacker can post long junk chains to burn CPU (validation is bounded but repeated). Real nodes validate incrementally with checkpoints. | Medium |
| 8 | **JSON serialisation.** Canonical enough here (fixed field order), but wire-format ambiguity is a classic source of consensus splits; real chains use strict binary formats. | Medium |
| 9 | **Address hash is double-SHA-256 truncated to 20 bytes** instead of RIPEMD-160(SHA-256). Fine cryptographically, but non-standard. | Info |

## Scope

No custody, no networking beyond the toy relay, no privacy features (all
balances are public by design, like Bitcoin). Report anything else you find by
opening an issue — finding holes in it is the whole point of a teaching chain.
