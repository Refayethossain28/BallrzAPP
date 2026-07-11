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

## The pages (mining & wallet links)

Cortex ships one app plus a dashboard and demo, all sharing one wallet + chain
(synced live between tabs, and across devices when served by a relay):

| Page | What | Path |
| --- | --- | --- |
| **Mining client** | trains the net; pays rewards to YOUR payout address (holds no spending key) | `/mine.html` |
| **Wallet** | the only holder of your key: balance, send/receive, encrypted backup | `/wallet.html` |
| Launcher | links to both (kept for installs of the old merged app) | `/app.html` |
| Network dashboard | the chain, the model, who's teaching it | `/network.html` |
| Visual demo | the decision-boundary visualisation | `/index.html` |

The separation is real, not cosmetic: the mining client signs blocks with a
disposable **rig key** and the block's coinbase pays the **payout address** you
configure — so a mining device never holds, and cannot leak, the key that owns
your MIND. (Headless: `PAYTO=<wallet address> npm run cortex:node`.)

**Install them as apps (PWA):** both pages are installable — green icon =
Mining client, blue = Wallet — each with a service worker-cached shell (never
the relay traffic, which must stay live). iPhone/iPad: open the page in Safari
→ Share → **Add to Home Screen**. Android/Chrome: menu → **Install app** (or
the address-bar install icon). Desktop Chrome/Edge: the ⊕ install icon in the
address bar. Offline, the apps still open with your chain (it lives in
localStorage); mining works locally and gossips when you're back online.

Where those links resolve:

- **Local (now):** `npm run cortex:relay`, then `http://localhost:8088/mine.html`
  and `http://localhost:8088/wallet.html`.
- **GitHub Pages (after this branch merges to `main`):** the site auto-publishes
  the `cortex/` folder, so
  `https://refayethossain28.github.io/BallrzAPP/cortex/mine.html` and
  `…/cortex/wallet.html`. (Static hosting: tabs in one browser sync over
  BroadcastChannel; for cross-device mining paste a relay URL / serve from one.)
- **Your deployed relay:** `https://<your-cortex-relay>/mine.html` and
  `…/wallet.html` — a shared network anyone can open.

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

Same flow as TimeCoin (`coin/DEPLOY.md`). One important detail: the Cortex relay
**reuses `coin/server.mjs` and serves `/coin/engine.js` from the sibling
folder**, so deploy from the **repo root** (don't isolate to `cortex/`):

1. Go to [dashboard.render.com](https://dashboard.render.com) and sign in with GitHub.
2. **New → Web Service**, pick the **BallrzAPP** repository.
3. Choose the **branch** (a branch works before merging — e.g. this PR's branch).
4. Fill in exactly:
   - **Root Directory:** *(leave empty — repo root)*
   - **Build Command:** *(leave empty — zero dependencies, nothing to build)*
   - **Start Command:** `node cortex/server.mjs`
   - **Instance Type:** `Free`
5. Click **Deploy Web Service** and wait for it to go live.
6. Optional: in the Environment tab set `SELF_URL=https://<your-service>.onrender.com`
   so the free instance pings itself and doesn't sleep after 15 idle minutes.

You get a URL like `https://your-cortex.onrender.com`:

- `…/mine.html` — mining client  ·  `…/wallet.html` — wallet  ·  `…/network.html` — dashboard  ·  `…/` — demo
- `…/status` — relay health JSON (check `"name": "cortex-relay"` to confirm it's up)

Anyone who opens those pages is on **your shared network** — browsers auto-detect
that their origin is a relay and connect. Headless miners join it with
`RELAY=https://your-cortex.onrender.com npm run cortex:node`. `PORT` is set by
the host automatically; the `RELAY_*` tuning env vars are documented in
`coin/server.mjs`. Any other Node ≥18 host (Railway, Fly.io, a VPS with
`PORT=80 node cortex/server.mjs`) works the same way — just deploy the whole
repo, not the `cortex/` folder alone.

**Multiple relays (no single chokepoint):** deploy the same service on a second
host, then home clients on both — `RELAY=https://relay-1,…//relay-2` for a
headless node, or in the browser console `CortexApp` apps expose
`app.addRelay('https://relay-2')` (persisted in localStorage). A node homed on
two relays **bridges** them: blocks arriving on one are re-gossiped to the
other, so the networks merge and survive either relay dying. Every node still
validates everything — relays remain dumb forwarders that can only delay or
censor, never forge.

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
