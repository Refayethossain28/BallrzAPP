# Cortex: a Proof-of-Learning blockchain

*Version 1 — testnet. This is a working prototype, not audited software and not
money; read `SECURITY.md` and `AUDIT.md` before treating it as anything more.*

## Abstract

Bitcoin secures its ledger by making miners burn electricity on hashes that are
useful only as proof of expenditure. Cortex replaces that burned work with
**learning**: to mine a block you train a shared neural network, and the block
is accepted only if it genuinely reduced the model's loss on a fixed, public
dataset. The reward — a token called **MIND** — is proportional to the learning
contributed. The chain of blocks *is* the model's training history, each
checkpoint cryptographically signed and independently verifiable. The result is
a consensus mechanism whose "work" leaves behind something the world can use: a
trained, community-owned model.

## 1. Proof-of-Learning

A task fixes a dataset `(X, y)` and a model architecture (a multilayer
perceptron). The genesis block holds deterministic starting weights. To extend
the chain, a miner trains from the tip's weights and publishes a new block
containing the improved weights, the loss they achieve, and a reward claim.

Verification is the crux and it is cheap and trustless: every node **recomputes**
the loss from the block's own weights in a single forward pass and rejects any
block whose claimed loss is false, or that did not lower the loss by at least a
minimum margin. You cannot fake learning, because the proof *is* the improved
model and anyone can re-measure it.

**Fork choice** maximises cumulative learning: the chain that has reduced the
loss most from genesis wins. This is the direct analogue of Bitcoin's
heaviest-chain rule, with "cumulative work" replaced by "cumulative loss
reduction".

## 2. Determinism (why honest nodes don't fork)

Verification only works if every node computes the *identical* loss. Floating-
point `exp/log/tanh` are not guaranteed bit-identical across CPUs and language
runtimes, so Cortex computes the forward pass and loss using deterministic
transcendentals built only from IEEE-754 operations that *are* guaranteed
correctly-rounded (`+ − × ÷ √`). Genesis weights are drawn with an Irwin–Hall
approximation (sums of a seeded integer PRNG), avoiding transcendentals
entirely. A pinned set of reference values is checked on every machine
(`test-cortex-determinism`), and an independent Python re-implementation
(`validator.py`) reproduces the same losses — two witnesses that the
consensus arithmetic is portable.

## 3. MIND: emission bounded by knowledge

Mining mints MIND to the block's payout address, `round((prevLoss − newLoss) ×
rewardPerLoss)` base units. Two consequences follow from the rule itself:

- **You are paid for teaching, not for showing up.** A block that barely moves
  the model earns almost nothing; a block that cuts the loss a lot earns a lot.
- **Supply is bounded by what the model can learn** — there is no arbitrary cap
  to argue about, because the cap *is* the total learnable loss.

### 3.1 The 10-year emission schedule

Left alone, a fast miner would drain the entire learnable budget in a day. So a
task may carry an **emission schedule**: a consensus function `allowedLoss(t)`
that releases the model's learnable loss over real time with a fixed half-life.
A block whose loss dips below the schedule at its timestamp is **invalid** —
no amount of compute can learn ahead of the curve. Learning *accrues* between
blocks, so whoever mines next collects everything released since the last block,
and emissions halve each half-life exactly as Bitcoin's subsidy does.

The live network (`cortex-warnet-v4`) uses a 2.3-year half-life and a 0.32-loss
budget: ~50% of the 960,000-MIND cap emitted in the first 2.3 years, ~95% within
10 years, a thin tail after. A 12-year simulation tracks this curve to within a
percentage point (`README.md` records the numbers).

Block timestamps are therefore consensus-relevant. They are judged against
**network time** — the median of peers' clocks, clamped to ±10 minutes — so one
node with a wrong clock follows the network instead of forking, while a Sybil
majority still cannot shift time more than the clamp.

## 4. The token and transfers

MIND moves between addresses as secp256k1-signed transfers carried inside
blocks. Balances are strictly non-negative; each `(sender, nonce)` pair is
usable once (replay protection); the set of transfers in a block is committed by
a `txsRoot` folded into the signed block hash. A block that overdraws a sender
or replays a nonce is rejected whole. Honest miners fold only transfers that
verify and apply cleanly, so a junk transfer cannot stall the network
(`AUDIT.md` §4).

## 5. Mining client vs wallet (real separation)

The block's **payout address** is chosen by the producer and travels inside the
signed block — a Bitcoin-style coinbase. This lets the **mining client** sign
blocks with a disposable *rig key* that holds no funds and pay every reward to a
**wallet address it holds no spending key for**. A lost or compromised mining
device cannot spend the MIND it earned. The wallet app is the only holder of the
spending key.

## 6. Cryptography

secp256k1 ECDSA (RFC 6979 deterministic nonces, low-S normalised), SHA-256 and
base58check addresses are provided by the independently-audited `@noble`
libraries (`vendor/noble-crypto.js`), which back all pages, the miner worker and
the headless node. The engine also ships a hand-rolled implementation of the
same primitives, kept as an educational, differentially-tested fallback: a
differential suite proves the two produce byte-identical hashes, keys, addresses
and signatures, so a mixed network cannot fork over crypto.

## 7. Networking

Nodes gossip four message types — `hello`, `chain`, `block`, `tx` — over a
transport-agnostic layer that runs on an HTTP relay, a browser BroadcastChannel,
or an in-memory bus. Relays are **dumb forwarders**: they can delay or censor,
never forge, because every node re-validates everything. Clients can home on
several relays at once; a node on two relays bridges them, so independently
operated relays merge into one network with no single chokepoint.

## 8. Honest limitations

Cortex is a **testnet**. It has had no independent security audit; MIND has no
market and no value; the model is a small research classifier, not frontier AI;
and the open trust gaps (timestamp replay on offline replay, no Sybil cost,
browser key storage) are enumerated in `SECURITY.md` and `AUDIT.md`. What is
real is the mechanism: mining that produces a verifiable, shared, useful model
instead of burned hashes — and everything in this paper is implemented, tested,
and independently re-validated, not aspirational.

## 9. Roadmap to a real network

An independent audit; audited-crypto-only (drop the hand-rolled fallback from
the consensus path); verifiable time (median-time-past or an external beacon);
Sybil resistance; a hardware/OS-keychain signer; and — the hardest, and not a
coding task — a community that mines, holds and values MIND because the model
being trained is worth something to them. That last point is why the choice of
*what the network learns* matters more than any line of code here.
