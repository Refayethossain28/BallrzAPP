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
devices**, run the zero-dependency relay — which also serves the app itself:

```sh
node coin/server.mjs                  # open http://localhost:8087 → the app, pre-connected
```

Deploy that one file to Render's free tier and you have a shareable network
URL — the 5-minute walkthrough is in [`DEPLOY.md`](DEPLOY.md). Nodes can also
join a relay three other ways: an invite link (`?relay=…`, shown in the app's
Network panel), pasting the URL into the Network panel, or `relayUrl` in
[`config.js`](config.js). The relay is deliberately dumb — it forwards messages
but can't forge a block or touch a key; every node re-validates everything and
adopts only the heaviest valid chain. A page served over `https://` (like
GitHub Pages) can only call an `https://` relay.

Wallet cards have a **QR button**: it encodes a `?pay=<address>` link, so a
friend scanning it opens the app with your wallet prefilled as the recipient.
The Send form has a **📷 Scan a friend’s QR** button: where the browser supports
`BarcodeDetector` (Chrome/Android) it opens the camera and reads their address
in-app; elsewhere (e.g. iOS Safari) it explains that the phone’s own Camera app
scans the same QR, since it’s a payment link.
The page also shows a live **leaderboard** (top holders by share of supply) and
a **halving countdown** toward the 21 BLZ issuance limit.

**Barter — offers board:** post something you'll do or give for BLZ (“🎂 Bake a
cake — 2 BLZ”) and pay others for theirs. Offers gossip across the network like
transactions (they live off-chain — an offer is a notice, not money), and a
**Pay** button prefills the send form with the poster's address and price; you
sign and mine to confirm as usual. BLZ is only worth what your circle agrees, so
agree a shared price list — that social agreement is what turns the coin into a
working barter currency (like a LETS scheme or a babysitting co-op). Keep it to
goods and favours, not cash.

**Protection against a no-show seller** — because on-chain payments are final,
the barter board adds three safeguards for the "I paid and they ghosted" case:

- **Deals & reputation.** Paying an offer opens a *deal* with a lifecycle
  (funded → confirm received → complete). Confirming delivery permanently adds a
  ✓ to the seller's public reputation, shown on every offer they post. Deals and
  reputation gossip over the network so the whole circle sees who's reliable.
- **🛡 Escrow.** Instead of paying the seller directly, pay a mutually-trusted
  third party; they release the coins to the seller once you confirm delivery,
  or refund you if it falls through. Trust-based custody — right-sized for a
  close circle (the agent is a person you both trust, not a smart contract).
- **Pay on delivery** — the simplest of all: just pay *after* you receive the
  favour. No code needed; it's the recommended default among friends.

(A fully trustless version — 2-of-3 multi-signature escrow, where no single
party can abscond with the funds — is the natural next step and would live in
the engine itself; the trust-based escrow above covers a friend circle without
it.)

Wallets can be backed up and restored: **🔑 Keys** reveals a wallet's private
key, **🖨 Paper wallet** prints a cold-storage card (address QR on one half,
private-key QR on the other), and **⬇ Import wallet** restores a key on any
device — the balance follows automatically once the node syncs the chain,
because coins live on the blockchain and the key is just the proof of
ownership. (Keys at rest in the browser are still unencrypted — SECURITY.md #1;
a paper wallet protects against loss, not against someone reading your screen.)

## Run the tests

```sh
npm run test:coin        # 31 tests: crypto vectors, consensus rules, fork choice
```
