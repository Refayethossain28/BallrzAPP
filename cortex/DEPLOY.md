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

1. ~~**Deterministic forward pass**~~ — ✅ **done.** `engine.js` computes the
   forward pass and loss with deterministic transcendentals (IEEE-754 ops only)
   and a transcendental-free genesis init; `test:cortex-determinism` pins exact
   cross-machine reference values. Nodes now agree to the bit.
2. **Persistence** — save/restore `node.snapshot()` to disk/localStorage.
3. **Browser node** — load `net.js` in `index.html` and auto-connect when served
   by a relay (as the coin app does), so opening the URL makes you a live node.
4. **Security review + key encryption** before any value (see `coin/SECURITY.md`).
5. **Bootstrap value** — a currency is only worth something once a circle uses
   it; `coin/CIRCLE.md` is the playbook.
6. **Tournament layer** (optional) — needs a real decentralised outcome oracle
   (`TRUSTLESS.md`), a product decision.
