# Deploy a Cortex network

One deploy gives a URL that **is** a shared Cortex network: open it on any
device and you get the app, already connected to the relay, mining the same
proof-of-learning chain and gossiping blocks and MIND transfers.

> ## ⚠ TESTNET ONLY — read before deploying with any value
> Cortex is **not** safe as a real-value network yet. Consensus needs every node
> to recompute the **identical** loss from identical weights, but the model's
> forward pass uses floating-point `tanh`/`exp`/`log`, which are **not** promised
> to be bit-identical across CPUs, OSes, or JS-engine versions. Two honest nodes
> could therefore disagree on whether a block is valid and the chain would fork.
>
> **The gate for a trustworthy network is a deterministic (fixed-point) forward
> pass** (see `TRUSTLESS.md` and the roadmap below). Until that lands, deploy
> only as a local/testnet experiment — for playing with the mechanics, not for
> holding value. Keys also sit unencrypted in the browser (same limitation as
> `coin/SECURITY.md` #1).

## What's built (and what isn't)

| Piece | Status |
| --- | --- |
| Consensus core (validate, mine, fork-choice) | ✅ `engine.js` |
| Gossip node: broadcast/ingest blocks & txs, converge | ✅ `net.js` |
| Relay (dumb message forwarder, serves the app) | ✅ `server.mjs` (reuses the hardened `coin/server.mjs`) |
| HTTP transport for a node | ✅ `net.js` `httpTransport` |
| **Deterministic forward pass (fork-safe consensus)** | ❌ **the blocker** |
| Persistent on-disk chain storage | ⚠ blocks are JSON; wiring is left to the host |
| Browser auto-connect UI | ⚠ `index.html` is a standalone demo; add `net.js` + a poll loop to make it a live node |

## Run a local testnet (now)

```sh
# start the relay (serves the app + forwards messages)
npm run cortex:relay            # → http://localhost:8088
```

Then run two nodes against it from Node (the mechanism the tests exercise):

```js
import { readFileSync } from 'node:fs'; import vm from 'node:vm';
const ROOT = '/path/to/BallrzAPP';
const box = { module: { exports: {} } }; box.self = box; vm.createContext(box);
const load = (p, g) => { box.module = { exports: {} };
  vm.runInContext(readFileSync(ROOT+'/'+p,'utf8'), box, {filename:p});
  if (g) box[g] = box.module.exports; return box.module.exports; };
load('coin/engine.js', 'BallrzCoin'); load('cortex/datasets.js', 'BallrzCortexData');
const X = load('cortex/engine.js', 'BallrzCortex');
const Net = load('cortex/net.js', 'BallrzCortexNet');

const BASE = 'http://localhost:8088';
const wallet = box.BallrzCoin.generateWallet();
const t = Net.httpTransport(BASE, { fetch });
const node = Net.createNode({ id: 'me', chain: new X.Chain(X.makeTask({ id: 'mainnet' }), { genesisSeed: 'genesis' }), send: (m) => t.send(m) });

setInterval(() => t.poll((m) => node.receive(m)), 1500);        // pull peers' messages
node.hello();                                                   // sync on join
node.mineAndBroadcast({ privKey: wallet.privateKey, steps: 400, nonce: 'b' + node.chain.height() });
```

Every node must build the **same genesis** — same `makeTask({ id })` and
`genesisSeed` — or they're on different chains.

## Deploy the relay to the internet (Render free tier, ~5 min)

Identical to the TimeCoin flow (`coin/DEPLOY.md`), pointed at `cortex`:

1. [dashboard.render.com](https://dashboard.render.com) → **New → Web Service**, pick the **BallrzAPP** repo.
2. **Root Directory:** `cortex` · **Build Command:** *(empty)* · **Start Command:** `node server.mjs` · **Instance:** Free.
3. Deploy. Zero dependencies, nothing to build.

You get a URL like `https://your-cortex.onrender.com` that serves the app and is
the relay. `PORT` is set by the host; optional `SELF_URL` keeps a free host awake
(see `coin/server.mjs` for the `RELAY_*` tuning env vars — the relay is shared).

## Roadmap to a *real* (not testnet) network

1. **Deterministic forward pass** — replace float `tanh`/`exp`/`log` + BCE with
   fixed-point/integer math and defined rounding, so every node agrees bit-for-
   bit. This is the one true blocker.
2. **Persistence** — save/restore `node.snapshot()` to disk/localStorage.
3. **Browser node** — load `net.js` in `index.html` and auto-connect when served
   by a relay (as the coin app does), so opening the URL makes you a live node.
4. **Security review + key encryption** before any value (see `coin/SECURITY.md`).
5. **Bootstrap value** — a currency is only worth something once a circle uses
   it; `coin/CIRCLE.md` is the playbook.
6. **Tournament layer** (optional) — needs a real decentralised outcome oracle
   (`TRUSTLESS.md`), a product decision.
