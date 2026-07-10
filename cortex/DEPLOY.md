# Deploy a Cortex network

One deploy gives a URL that **is** a shared Cortex network: open it on any
device and you get the app, already connected to the relay, mining the same
proof-of-learning chain and gossiping blocks and MIND transfers.

> ## ⚠ Still testnet — but the fork-safety gate is now CLOSED
> The headline consensus blocker is fixed. The forward pass and loss no longer
> call `Math.tanh`/`exp`/`log` (which aren't bit-identical across machines);
> they use **deterministic software transcendentals built only from IEEE-754
> correctly-rounded ops** (`engine.js`), and genesis weights use a
> transcendental-free init. `scripts/test-cortex-determinism.mjs` pins exact
> reference doubles that every conforming platform must reproduce, so two honest
> nodes now agree on a block's loss to the bit — no fork from arithmetic drift.
>
> It is **still not a real-value network**, but for the *remaining* reasons, not
> consensus math: keys sit unencrypted in the browser (`coin/SECURITY.md` #1),
> there's no persistence wiring or security audit yet, and MIND has no value
> until a circle uses it. Deploy as a testnet you can trust for correctness;
> don't hold value until the roadmap's remaining items are done.

## What's built (and what isn't)

| Piece | Status |
| --- | --- |
| Consensus core (validate, mine, fork-choice) | ✅ `engine.js` |
| Gossip node: broadcast/ingest blocks & txs, converge | ✅ `net.js` |
| Relay (dumb message forwarder, serves the app) | ✅ `server.mjs` (reuses the hardened `coin/server.mjs`) |
| HTTP transport for a node | ✅ `net.js` `httpTransport` |
| **Deterministic forward pass (fork-safe consensus)** | ✅ `engine.js` det transcendentals + pinned refs (`test:cortex-determinism`) |
| Deployable headless mining node | ✅ `node.mjs` (`npm run cortex:node`) |
| Persistent on-disk chain storage | ✅ `node.mjs` (JSON snapshot, restored on restart) |
| Encrypted key at rest | ✅ `keystore.js` (passphrase; no plaintext key on disk) |
| Browser auto-connect UI | ⚠ `index.html` is a standalone demo; add `net.js` + a poll loop to make it a live node |
| Independent security audit | ❌ not done — see `SECURITY.md` |

## Run a local testnet (now)

```sh
# 1. start the relay (serves the app + forwards messages)
npm run cortex:relay                         # → http://localhost:8088

# 2. start one or more mining nodes against it (each in its own shell)
RELAY=http://localhost:8088 DATA=./node1.json TASK_ID=mainnet \
  KEYFILE=./wallet1.json CORTEX_PASSPHRASE='a strong passphrase' \
  npm run cortex:node

RELAY=http://localhost:8088 DATA=./node2.json TASK_ID=mainnet \
  KEYFILE=./wallet2.json CORTEX_PASSPHRASE='another strong passphrase' \
  npm run cortex:node
```

Each node syncs on join, mines Proof-of-Learning blocks, gossips them, persists
its chain to `DATA` (restored on restart), and stores its key **encrypted** in
`KEYFILE` (never plaintext). Every node must agree on the **genesis** — same
`TASK_ID` and `GENESIS_SEED` — or they're on different chains. Env knobs:
`STEPS`, `MINE_MS`, `POLL_MS`.

For embedding in your own program, `cortex/node.mjs` exports `bootNode(opts)`
returning `{ node, wallet, mine, poll, sync, save, balance }`.

## Deploy the relay to the internet (Render free tier, ~5 min)

Identical to the TimeCoin flow (`coin/DEPLOY.md`), pointed at `cortex`:

1. [dashboard.render.com](https://dashboard.render.com) → **New → Web Service**, pick the **BallrzAPP** repo.
2. **Root Directory:** `cortex` · **Build Command:** *(empty)* · **Start Command:** `node server.mjs` · **Instance:** Free.
3. Deploy. Zero dependencies, nothing to build.

You get a URL like `https://your-cortex.onrender.com` that serves the app and is
the relay. `PORT` is set by the host; optional `SELF_URL` keeps a free host awake
(see `coin/server.mjs` for the `RELAY_*` tuning env vars — the relay is shared).

## Roadmap to a *real* (not testnet) network

1. ~~**Deterministic forward pass**~~ — ✅ **done.** `engine.js` computes the
   forward pass and loss with deterministic transcendentals (IEEE-754 ops only)
   and a transcendental-free genesis init; `test:cortex-determinism` pins exact
   cross-machine reference values. Nodes now agree to the bit.
2. ~~**Persistence**~~ — ✅ done (`node.mjs` JSON snapshots, restored on restart).
3. ~~**Key encryption**~~ — ✅ done (`keystore.js`; `node.mjs` stores keys encrypted).
4. **Browser node** — load `net.js` in `index.html` and auto-connect when served
   by a relay, so opening the URL makes you a live node (headless `node.mjs`
   already does this server-side).
5. **Independent security audit** before any value — the crypto and consensus
   need human review (see `SECURITY.md`). This is not something code can self-certify.
6. **Bootstrap value** — a currency is only worth something once a circle uses
   it; `coin/CIRCLE.md` is the playbook.
7. **Tournament layer** (optional) — needs a real decentralised outcome oracle
   (`TRUSTLESS.md`), a product decision.

See **`SECURITY.md`** for the full, honest limitation list.
