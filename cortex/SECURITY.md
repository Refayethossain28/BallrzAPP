# Cortex — security disclosures

Honest, unhidden limitations — the risk disclosures any serious network owes its
users, in the style of `coin/SECURITY.md`. Cortex is a **prototype / testnet**.
The consensus *math* is now fork-safe (see #0), but several things below must be
addressed before anyone holds real value. Severity is this-is-a-prototype
relative.

## 0. Consensus determinism — ADDRESSED ✅

The headline risk (two honest nodes computing different losses and forking) is
fixed: the forward pass and loss use deterministic software transcendentals
built only from IEEE-754 correctly-rounded ops, with a transcendental-free
genesis init. `scripts/test-cortex-determinism.mjs` pins exact reference doubles
every conforming platform must reproduce. A platform whose floating point is
non-conforming will fail that suite — which is the point; it must not validate
the chain.

## 1. No independent security audit — HIGH

None of this has had an *independent* security review, and that remains the #1
gate before real value. What HAS changed:

- **Cryptography is now the audited `@noble` libraries** by default
  (`vendor/noble-crypto.js` bundles `@noble/secp256k1` + `@noble/hashes`,
  independently audited and used across the Ethereum ecosystem). The engine's
  from-scratch secp256k1/SHA-256 is now a *fallback*, proven byte-identical by
  `scripts/test-cortex-crypto.mjs`. Our ~40-line adapter around `@noble` is not
  itself audited — reproduce the bundle per `AUDIT.md` §6 rather than trusting
  the committed bytes.
- **A self-review pass and audit-readiness dossier exist** (`AUDIT.md`): threat
  model, consensus invariants, and a fixed finding (mempool-poisoning DoS). A
  self-review is not an independent audit — it shares the author's blind spots.
- **A second, independent implementation** (`validator.py`, pure Python, zero
  shared code) re-validates the chain, so consensus bugs in one engine can't
  silently become "the rules".

Still: do not secure real value until an independent audit is done.

## 2. Key storage — MEDIUM (mitigated)

`cortex/keystore.js` encrypts private keys at rest (SHA-256 KDF + stream cipher
+ HMAC), and `node.mjs` never writes a plaintext key. But: the KDF is iterated
SHA-256, not a memory-hard function (scrypt/argon2), so a *weak passphrase* is
still brute-forcible; keys are decrypted into process/tab memory to sign; and
there is no hardware-wallet support. Use a strong passphrase; treat a hot node's
key as hot.

## 3. Relay trust — LOW (by design)

The relay (`server.mjs`) is a dumb forwarder: it can censor or delay messages
but cannot forge a block or mint MIND (every node re-validates and adopts only
the heaviest-learning valid chain). Run your own relay if censorship matters;
nodes can point at several.

## 4. Sybil / DoS — MEDIUM

Mitigations exist (relay rate-limiting + memory bounds; tournament stake + entry
caps; prover spot-checks bound validation cost) but aren't exhaustively
hardened. Block-validation cost is bounded by the task size, which the genesis
fixes; a hostile actor spamming invalid blocks is rate-limited, not eliminated.
No peer scoring/banning yet.

## 5. The tournament's outcome oracle — HIGH (if used)

The forecasting-tournament layer (`tournament.js`) is **not trustless**: it
depends on an outcome oracle (single key, or an m-of-n committee with an
optimistic dispute window) to report realised labels honestly. See
`TRUSTLESS.md`. The base proof-of-learning chain does not use it.

## 6. Overfitting on the base reward — MEDIUM

The base chain rewards *training* loss, so on real data it rewards fitting the
visible data — a large enough model could memorise. The commit–reveal layer
(`holdout.js`) rewards generalisation but needs a trusted data withholder. Pick
the layer that matches your trust assumptions.

## 7. Economic value — INFORMATIONAL

MIND has no intrinsic value and no market. Like TimeCoin, any value is whatever a
community agrees to; issuance is bounded by learning, not backed by anything.
Bootstrapping is social (see `coin/CIRCLE.md`).

## 8. Emission-schedule timestamps — MEDIUM

The 10-year schedule (warnet-v3) makes block **timestamps consensus-relevant**:
`allowedLoss(block.at)` caps how much a block may learn. Two honest weaknesses:

- **Future-dating.** A miner could post-date `at` to unlock budget early. Live
  nodes reject blocks more than 5 minutes ahead of their local clock
  (`net.js`), the same loose-clock assumption Bitcoin makes — but a node
  **replaying an old chain from disk cannot re-check this**, so a future-dated
  fork built in secret would validate later. Bitcoin's median-time-past +
  difficulty makes this expensive; here it is only the relay-time check.
- **Clock skew.** A miner whose clock runs behind simply earns slightly less;
  more than 5 minutes ahead and peers drop their blocks until real time
  catches up.

Acceptable for a testnet; a real deployment would need verifiable time
(median-of-peers time, or an external beacon).

## 9. Persistence & availability — LOW

`node.mjs` persists the chain as a JSON snapshot; a corrupt snapshot is simply
not adopted (validated via `replaceChain`), but there's no automatic backup,
compaction, or multi-file recovery. Back up your data file and keyfile.

## Reporting

This is a prototype in a concepts monorepo; there is no bug-bounty. If you build
on it, get the crypto and consensus reviewed first.
