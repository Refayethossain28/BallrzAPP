# Cortex — audit-readiness package

**This is NOT an independent security audit.** It is the self-review and
threat-model dossier an external auditor would want on day one, written by the
same author who wrote the code — so it carries all the bias that implies. An
independent audit (the real milestone) still has to be done by someone who is
not us. What follows is the map to make that audit faster and cheaper, plus an
honest account of a self-review pass and what it found.

## 1. What Cortex is (one paragraph for the auditor)

A Proof-of-Learning blockchain. Mining = training a shared neural network;
a block is a signed model checkpoint whose reward is proportional to the loss
it removed. Consensus: every node recomputes the loss from the block's own
weights (nothing trusted), fork choice maximises cumulative learning, and a
10-year emission schedule rations how fast learning may be absorbed. The token
(MIND) moves as secp256k1-signed transfers inside blocks. Cryptography is the
audited `@noble` libraries (`cortex/vendor/noble-crypto.js`); the engine's
hand-rolled crypto is a differentially-tested fallback. See `WHITEPAPER.md` for
the full design and `README.md` for the code tour.

## 2. Consensus invariants (what must always hold)

An auditor should try to break each of these; each has a test that asserts it.

1. **Loss is recomputed, never trusted.** `isValidBlock` recomputes the loss
   from `block.weights` and rejects any mismatch >1e-9. (`test-cortex-logic`:
   "a block lying about its loss is rejected".)
2. **Real learning per block.** `block.loss ≤ prev.loss − minImprovement`.
3. **Bounded, schedule-gated emission.** Reward `= round((prevLoss − newLoss) ×
   rewardPerLoss)`; with a schedule, `block.loss ≥ allowedLoss(block.at)` — no
   compute can mint ahead of the curve. Total supply ≤ `budget × rewardPerLoss`
   forever. (`test-cortex-logic`: the emission-schedule suite.)
4. **Determinism.** The forward pass/loss use only IEEE-754 correctly-rounded
   ops (`detExp/detLn/detTanh/detSigmoid`); genesis init avoids transcendentals.
   Two conforming machines agree bit-for-bit. (`test-cortex-determinism`, and
   the independent Python port in `validator.py` agreeing is a second witness.)
5. **Coinbase integrity.** `block.miner` (payout) is inside the signed
   canonical form; redirecting it breaks the signature. The signer (`pubKey`)
   need not equal the payout — that is the wallet/miner separation, by design.
6. **Ledger safety.** Non-negative balances, `(from,nonce)` used once, transfers
   committed by `txsRoot` inside the block hash. Overdraft/replay/tamper all
   rejected. (`test-cortex-logic` ledger suite.)
7. **No time-travel minting.** Block timestamps are validated against
   network-adjusted time (median of peers, ±10-min clamp); future-dated blocks
   are dropped. (`test-cortex-net` network-time suite.)

## 3. Trust model / attack surface

| Surface | Assumption | Mitigation | Residual risk |
| --- | --- | --- | --- |
| Relay | dumb forwarder | every node re-validates; multi-relay + bridge nodes remove the single chokepoint | a relay can still delay/censor what it forwards |
| Time | honest-majority clocks | median-of-peers, ±10-min clamp | offline chain replay can't re-check "future" (§5); no median-time-past |
| Sybil | — | emission schedule caps issuance regardless of miner count | no PoW/PoS cost to running many nodes; fork choice is learning, not stake |
| Keys | browser localStorage / encrypted keyfile | mining client holds only a disposable rig key; wallet key never on the miner | localStorage is XSS-reachable; no hardware signer |
| Crypto | `@noble` is correct | audited upstream; differential-tested vs the built-in | our ~40-line adapter is not itself audited |
| Data | dataset is byte-identical | embedded verbatim, SHA-256 pinned in tests | a dataset swap is a new chain, not an attack on an existing one |

## 4. Self-review pass — findings

A focused adversarial read of the consensus + networking code. One material
finding, fixed in this same change set:

- **[FIXED] Mempool poisoning → network-wide mining stall (DoS).** `mineBlock`
  folded the mempool verbatim, and `net.js` pooled transfers without verifying
  them. A single junk or unfunded (but well-signed) transfer, gossiped once,
  would be included by every honest miner and make their next block invalid —
  stalling mining until the mempool cleared. **Fix:** `net.js` verifies a
  transfer (`verifyTransfer` + `txId` match) before pooling/relaying, and
  `mineBlock` folds only transfers that both verify and apply cleanly against
  the current ledger (balance + unused nonce), so an honest miner always emits
  a valid block. Regression tests in `test-cortex-net` ("mempool hardening").
  The ledger rules themselves were always safe (a forged block carrying an
  overdraft/replay is still rejected — `test-cortex-logic`); this was an
  availability bug, not a soundness one.

Reviewed and found acceptable for a testnet (documented, not fixed here):
relay censorship, Sybil cost, localStorage key exposure, and the timestamp
replay gap (§5). These are the honest gaps a production deployment must close.

## 5. Known gaps (do not deploy as real money until these close)

1. **No independent audit.** The whole point of this file. Highest priority.
2. **Timestamp replay.** Live nodes reject blocks >5 min ahead of network time,
   but a node replaying an old chain from disk cannot re-check wall-clock, so a
   secretly-built future-dated fork validates later. Bitcoin uses
   median-time-past + PoW cost; Cortex has neither yet.
3. **No Sybil/DoS cost.** Running many nodes is free; the emission schedule
   caps *issuance* but not *influence*. Fork choice is cumulative learning, with
   no stake or work backing it.
4. **Adapter + build trust.** `vendor/noble-crypto.js` is a checked-in esbuild
   bundle; reproduce it (§6) rather than trusting the committed bytes.
5. **Key storage.** Browser localStorage; no hardware/OS-keychain signer.

## 6. Reproducing the vendored crypto bundle

Do not trust the committed `cortex/vendor/noble-crypto.js` bytes — rebuild them:

```sh
mkdir noble-build && cd noble-build
npm init -y
npm i @noble/secp256k1@3.1.0 @noble/hashes@2.2.0 esbuild
# write entry.js exactly as documented at the top of vendor/noble-crypto.js
npx esbuild entry.js --bundle --format=iife --outfile=noble-crypto.js
```

Then confirm equivalence to the hand-rolled reference:

```sh
node scripts/test-cortex-crypto.mjs   # identical hashes/keys/addresses/signatures
```

## 7. How to validate the live chain yourself

```sh
# JS engine (built-in path) + audited path agree — differential test:
node scripts/test-cortex-crypto.mjs
# A fully independent implementation (Python, zero shared code) re-checks a chain:
python3 cortex/validator.py <your-node-DATA-snapshot>.json
# The whole consensus suite:
npm run test:cortex && npm run test:cortex-crypto && npm run test:cortex-pyvalidator \
  && npm run test:cortex-net && npm run test:cortex-relay && npm run test:cortex-determinism
```

## 8. Scope for an external audit (suggested)

In priority order: (1) the consensus core `cortex/engine.js` — block validation,
fork choice, emission schedule, ledger; (2) `cortex/net.js` — sync, mempool,
network time; (3) the crypto boundary — `coin/engine.js` provider dispatch and
the `vendor/noble-crypto.js` adapter; (4) determinism of the forward pass across
target platforms. The Python `validator.py` is a useful oracle: any block the
two implementations disagree on is a bug in at least one.
