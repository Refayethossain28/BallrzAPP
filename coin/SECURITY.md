# TimeCoin security self-audit

An honest security assessment of TimeCoin — what is cryptographically sound,
what is still early-stage, and what a professional auditor would flag before the
currency safeguards significant value. Every serious currency publishes its
security posture; this one hides nothing. **Conclusion up front: the consensus
and cryptography are real and tested, and the original Critical items have been
hardened — keys encrypt at rest (offered on first run), weak-randomness wallets
are refused outright, and settled history is final (`maxReorgDepth`) with
coinbase maturity and cheap-first chain validation on top — see the roadmap in
[`ROADMAP.md`](ROADMAP.md).** What remains High below (a small circle's total
hashpower, non-constant-time arithmetic, the relay as a chokepoint) still
means: fine for time and favours among people you trust, not yet a place to
store wealth.

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
  it. Coinbase outputs mature before they spend, and a finality window
  (`maxReorgDepth`) makes settled history irreversible. The test suite
  attacks each rule directly.

## What an auditor would flag

| # | Finding | Severity (if this were real money) |
| --- | --- | --- |
| 1 | **Private keys in browser storage.** ~~Unencrypted localStorage~~ **Hardened:** keys encrypt at rest behind a passphrase (AES-GCM, PBKDF2 · 210,000 iterations), the app *offers* encryption on first run and shows a 🔓 “not protected” badge until it's on, and backups are passphrase-encrypted `.blzwallet` files. Residual: encryption is declinable, and while a session is unlocked the keys are in memory — an XSS during use can still read them. Hardware-wallet-grade custody is out of scope for a browser app. | ~~Critical~~ → Medium (residual) |
| 2 | **Wallet entropy.** ~~`Math.random` fallback~~ **Fixed:** the fallback is gone — `generateWallet` now refuses to run at all without `crypto.getRandomValues` (tested: an environment without a CSPRNG throws instead of minting a guessable key). | ~~Critical~~ → Closed |
| 3 | **Trivial total hashpower.** Difficulty is tuned for phones, so one laptop can out-mine a whole circle. **Mitigated, not solved:** running nodes now refuse forks deeper than `maxReorgDepth` (100 blocks ≈ 1 hour), so settled history can no longer be rewritten out from under a circle — an attacker is limited to shallow reorgs (double-spends within the window, further blunted by 10-block coinbase maturity). Still open: a brand-new node bootstrapping from nothing will accept any heaviest valid chain (long-range attack), and shallow-reorg double-spends remain cheap. Bitcoin solves this with gigawatts; a circle solves it by being a circle — join relays you trust. | ~~Critical~~ → High |
| 4 | **Non-constant-time BigInt arithmetic.** Point multiplication timing leaks could reveal key bits to a co-resident attacker. Real implementations use constant-time field arithmetic. | High |
| 5 | **The relay is a central point of censorship.** `server.mjs` can't forge blocks, but it can drop or delay them. It is now hardened against denial-of-service (per-client token-bucket rate limiting keyed on `x-forwarded-for`, and a message buffer bounded by both count and bytes), but it has no authentication and remains a single point through which one circle's traffic flows. Real networks use many independent peers; the app mitigates this with a multi-relay pool and failover. | High |
| 6 | **Coinbase maturity.** ~~None~~ **Fixed:** mined coins now mature for `coinbaseMaturity` blocks (default 10 ≈ 6 minutes; Bitcoin uses 100) before the mempool, the consensus rules or the spendable-UTXO set will let them move. Residual: a reorg deeper than 10 (possible up to the 100-block finality window) could still orphan a fresh-subsidy spend; circles wanting Bitcoin's margin can raise the parameter. | ~~Medium~~ → Low (residual) |
| 7 | **`replaceChain` re-validates whole chains.** **Mitigated:** a cheap header pass (linkage, hash integrity, real proof-of-work, cumulative work) now runs first, so a junk chain is rejected for the cost of hashing its headers — making a node do full transaction validation requires actually doing the proof-of-work first, and the finality window caps how much history a candidate can rewrite anyway. Full incremental validation with checkpoints remains the long-term answer. | ~~Medium~~ → Low |
| 8 | **JSON serialisation.** Canonical enough here (fixed field order), but wire-format ambiguity is a classic source of consensus splits; real chains use strict binary formats. | Medium |
| 9 | **Address hash is double-SHA-256 truncated to 20 bytes** instead of RIPEMD-160(SHA-256). Fine cryptographically, but non-standard. | Info |
| 10 | **Portable reputation is signature-sound but not sybil-proof.** A receipt/vouch (`reputation.js`) proves *a key* signed it, and passports are re-verified locally so nothing can be forged or inflated — but one person with many keys can manufacture attestations about themselves. This is inherent to any web-of-trust. The app does **not** paper over it: it counts and shows *distinct authors* and, crucially, *how many of those you already know*, so a stranger's pile of self-issued receipts reads as exactly what it is. | Info |
| 11 | **Connecting to a neighbouring circle federates the social layer, not the coin chain — now enforced in code.** All circles share one genesis, so their blockchains are the *same* chain; if a relay you connected to for discovery could feed you its chain, a heavier one would silently reorg yours and your mined-TIME balance could vanish. That is prevented: relays added as a **neighbour** (`peer`) never exchange `chain`/`tx` messages in either direction (`CHAIN_TYPES` filter in `index.html` `netSend`/`relayPoll`), so mined TIME stays within your own circle and a neighbour can't reorg your chain or move your coins. Offers, reputation and net-zero favour-credit still federate. Bridges (`bridge.js`) move only mutual credit, whose residual risk is ordinary counterparty trust in the bridge (it could accept a favour in one circle and not forward it in the other), bounded by each circle's credit limit — a social risk, not a way to counterfeit money. | Info |
| 12 | **Neighbour-circle labels are self-asserted.** A `peer` announcement (a circle name + relay URL) is gossiped unsigned, so anyone can advertise a relay under a name that isn't theirs. Names are HTML-escaped (no injection), connecting is never automatic (you tap **Connect**), and — post-#11 — connecting only federates the social layer and can't touch your coins. So the worst case is being shown a relay under a misleading label: connect only to circles you actually recognise. A future signed-circle-identity scheme would close this. | Info |

## Scope

No custodial service, no networking beyond the relay, no privacy features (all
balances are public by design, like Bitcoin). Responsible disclosure is welcome —
report anything else you find by opening an issue; hardening this list is exactly
how the currency earns the trust it asks for.
