# BallrzCoin (BLZ) — a toy cryptocurrency built like Bitcoin

A complete proof-of-work cryptocurrency implemented from raw bytes up, with **zero
dependencies**: the crypto, the ledger and the consensus rules all live in
[`engine.js`](engine.js), and [`index.html`](index.html) is a single-file node UI
(wallets, miner, mempool, block explorer).

## What's real about it

The same building blocks Bitcoin uses, implemented from their specs and verified
against published test vectors in [`../scripts/test-coin-logic.mjs`](../scripts/test-coin-logic.mjs):

| Piece | Implementation |
| --- | --- |
| Hashing | SHA-256 from FIPS 180-4 (plus double-SHA-256 everywhere Bitcoin uses it) |
| Signatures | ECDSA over **secp256k1** — Bitcoin's exact curve — with compressed public keys, RFC 6979 deterministic nonces and low-S normalisation (BIP-62) |
| Addresses | base58check with a version byte and 4-byte checksum (addresses start with `B`) |
| Ledger | UTXO model: coins are unspent outputs; transactions consume them with signed inputs |
| Blocks | Merkle root over transaction ids; header hashed with double-SHA-256 |
| Mining | Proof of work against a 256-bit target; difficulty retargets every 10 blocks, clamped to ×4 per step like Bitcoin |
| Money supply | 0.05 BLZ subsidy halving every 210 blocks — **only 21 BLZ will ever exist**, a million times scarcer than Bitcoin's 21,000,000 — with fees paid to the miner |
| Consensus | Fork choice by **cumulative work** (`replaceChain`), so independent nodes converge |

Open `index.html` in two browser tabs: each tab is a node with its own copy of the
chain, syncing blocks and transactions over `BroadcastChannel`. Mine in one tab and
watch the other adopt the heavier chain.

## What's simplified

This is a teaching prototype, **not money**. Relative to real Bitcoin: no Script
language (outputs pay a pubkey hash directly), no coinbase maturity delay, JSON
instead of the wire format, double-SHA-256-truncated instead of RIPEMD-160 for
address hashing, browser-grade key storage (localStorage), and the network is a
polling relay rather than true p2p gossip. The full honest list — with
severities, as a real auditor would write them — is in [`SECURITY.md`](SECURITY.md),
and [`ROADMAP.md`](ROADMAP.md) explains what separates this from a real
currency (spoiler: mostly things that aren't software).

## Run a real multi-device network

Tabs in one browser sync automatically. To connect nodes on **different
devices**, run the zero-dependency relay and point nodes at it:

```sh
node coin/server.mjs                  # starts the relay on :8087
```

then set `relayUrl` in [`config.js`](config.js) (e.g. `'http://localhost:8087'`,
or an `https://` URL if you deploy `server.mjs` to Render/Railway). The relay
is deliberately dumb — it forwards messages but can't forge a block or touch a
key; every node re-validates everything and adopts only the heaviest valid
chain. A page served over `https://` (like GitHub Pages) can only call an
`https://` relay.

## Run the tests

```sh
npm run test:coin        # 31 tests: crypto vectors, consensus rules, fork choice
```
