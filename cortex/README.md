# Cortex — a Proof-of-Learning blockchain

**AI cryptography on its own blockchain.** Cortex is a small, dependency-free
blockchain whose consensus mechanism *is* machine learning. Where Bitcoin's
miners burn electricity solving hash puzzles that are thrown away the instant
they're found, Cortex miners train a shared neural network — and a block is the
cryptographic proof that the network now knows a little more than it did before.

The work is hard to produce and cheap to check (the same asymmetry that makes
proof-of-work possible), except here the work is *useful*: when the chain
finishes, the community owns a trained model that everyone helped build and
anyone can independently verify. Miners are paid for that work in **MIND**, a
spendable token whose entire supply is minted in proportion to how much the
network actually learned.

```
coin/engine.js   ← SHA-256, secp256k1 ECDSA, addresses (reused, unchanged)
        │
        ▼
cortex/engine.js ← the Proof-of-Learning chain (this prototype)
cortex/index.html← a live browser demo: mine blocks, watch the model learn
scripts/test-cortex-logic.mjs ← the test suite
```

## The idea in one paragraph

Everyone on the network agrees on **one learning task**: a fixed, seeded
dataset and a neural network — a general feedforward MLP of shape
`[inputs, …hidden…, 1]` with `tanh` hidden layers and a `sigmoid` output, from a
25-parameter toy up to arbitrarily deep and wide (see *Choosing the tier*). The
**genesis block** pins the task and a
random set of starting weights. To mine the next block you take the tip's
weights, **train them with gradient descent** until the model's average loss
drops by at least `minImprovement`, and publish the new weights. Anyone can
verify your block with a **single forward pass** that recomputes the loss — you
cannot lie about how much the model improved. The block is signed with a
secp256k1 key and hash-linked to its parent, so the chain of model checkpoints
is tamper-evident and every improvement is attributable to whoever earned it.

## Why this is a real consensus mechanism, not a gimmick

| Property | Bitcoin (Proof-of-Work) | Cortex (Proof-of-Learning) |
| --- | --- | --- |
| The hard task | Find a nonce so `sha256d(block) < target` | Find weights that cut the model's loss by `minImprovement` |
| Verifying it | One hash | One forward pass (recompute the loss) |
| Is the work useful? | No — pure heat | **Yes — the shared model gets smarter** |
| Where difficulty comes from | An artificial target that's retuned | **The learning curve itself** — the closer to convergence, the harder |
| Fork choice | Most cumulative work | **Most cumulative learning** (largest total loss reduction) |
| When does it end? | Never (target keeps adjusting) | When no block can improve on the tip — **the model has converged** |

The key security property is that **claims are recomputed, never trusted**.
A block states its loss, but every node recalculates that loss from the block's
own published weights. Forge a lower number and the block is rejected as
*"claimed loss is false"*. Republish the parent's weights to skip the work and
it's rejected as *"insufficient learning"*. Keep someone else's weights but put
your address on them and the signature check rejects it. Fork choice validates
the *entire* rival chain from genesis before adopting it, and only switches if
the rival has genuinely learned more.

## The cryptography

Cortex does not reinvent the crypto — it reuses TimeCoin's
(`coin/engine.js`), the same way `coin/mutual.js` and `coin/bridge.js` do:

- **Hash-linking** — each block commits to `sha256d` of its parent, so history
  can't be rewritten without redoing every block after the change.
- **secp256k1 ECDSA signatures** — a block is signed over its canonical bytes,
  binding the improvement to the miner's address. The same wallet works across
  TimeCoin and Cortex.
- **Deterministic quantisation** — weights are rounded to a fixed grid
  (`quantum`, default 1e-6) before hashing and scoring, so every node hashes and
  evaluates byte-identical inputs and reaches the same verdict.

## MIND — the spendable token

Learning isn't just scored, it's **paid**. Mining a block mints **MIND** to the
miner in proportion to the learning it contributed: exactly `REWARD_PER_LOSS`
base units for every `1.0` of average loss the block removed (one MIND divides
into 1,000,000 base units, "synapses"). Two consequences fall straight out of
that rule:

- **You're paid for teaching, not for showing up.** A block that barely moves
  the model earns barely any MIND; a block that cuts the loss a lot earns a lot.
- **The money supply is bounded by knowledge.** Total MIND ever minted can't
  exceed `(genesis loss) × REWARD_PER_LOSS`, and it stops growing the moment the
  model converges. There's no arbitrary cap to argue about — the cap *is* how
  much the network can learn.

MIND then moves between wallets as ordinary **secp256k1-signed transfers**
carried inside blocks. Balances are strictly non-negative — a block containing a
transfer that would overdraw its sender, or that replays a `(from, nonce)` pair,
is rejected whole, exactly like an invalid transaction in a Bitcoin block. The
transfers in a block are committed to by a `txsRoot` folded into the block hash,
so the miner signs the spends along with the model checkpoint.

## Using the engine

```js
const Cortex = require('./cortex/engine.js'); // needs global BallrzCoin loaded first

const task  = Cortex.makeTask({ id: 'my-task' });          // synthetic task + model shape
// ...or pick a production-cost tier: 'toy' (default) | 'small' | 'medium' | 'large'
// const task = Cortex.makeTask({ id: 'my-task', scale: 'medium' });
// ...or train on a real dataset (needs cortex/datasets.js loaded):
// const task = Cortex.makeTask({ id: 'my-task', dataset: 'banknote', layers: [16] });
const chain = new Cortex.Chain(task, { genesisSeed: 'g' }); // genesis checkpoint

// mine: train the tip forward into a signed block — miner earns MIND
const block = chain.mineBlock({ privKey, steps: 400 });
chain.addBlock(block);                    // verifies learning + economics, then appends

chain.height();                 // number of blocks mined
chain.tipLoss();                // the shared model's current loss
chain.accuracy();               // its accuracy on the task
chain.cumulativeImprovement();  // total learning = the chain's "weight"

// the MIND token
chain.balanceOf(addr);          // spendable balance, base units
chain.totalSupply();            // all MIND minted so far
Cortex.formatMind(units);       // e.g. 1900000 -> "1.9 MIND"

// spend: sign a transfer, hand it to a miner to include in their next block
const tx = Cortex.signTransfer({ privKey, to: payeeAddr, amount: 500000, at, nonce: 'n1' });
chain.addBlock(chain.mineBlock({ privKey: minerKey, steps: 400, txs: [tx] }));

// converge on the smartest chain (balances are rebuilt from the adopted chain)
chain.replaceChain(rivalBlocks); // adopts it iff it learned strictly more
```

`mineBlock` returns `null` once the model has effectively converged and no
block can clear the `minImprovement` bar — that's the chain reaching its
natural end, and the point at which MIND issuance stops for good.

## Training on real data

The synthetic XOR is great for a visual demo, but Cortex can mine against a
**genuine dataset** — then the "useful work" isn't a toy, it's a model the
community actually wants. `cortex/datasets.js` embeds real data verbatim (it
**cannot** be fetched at runtime: every validator must recompute the loss on
byte-identical data, so consensus requires the data to be pinned in the repo):

| Dataset | Rows | Features | Task | Source |
| --- | --- | --- | --- | --- |
| `banknote` | 1,372 | 4 | genuine vs forged banknotes, from wavelet features of the photos | [UCI Banknote Authentication](https://archive.ics.uci.edu/dataset/267/banknote+authentication) |

```js
const task = Cortex.makeTask({ id: 'notes', dataset: 'banknote', layers: [16] });
// inputs (4) and sample count (1372) come from the data; features are z-score
// standardised deterministically. Mining then trains a real forgery detector —
// it clears ~99% accuracy in a few hundred gradient steps.
```

Two properties make this safe for consensus:

- **Byte-identical & pinned.** The embedded CSV's SHA-256 is checked in the test
  suite, so any accidental corruption fails the build. Feature standardisation
  (per-feature mean/variance) is computed from the data itself, so every node
  derives the same scaled inputs.
- **Verification is unchanged.** A block still just publishes weights; validators
  recompute the loss on the fixed real dataset in one forward pass. You can't
  fake a diagnosis any more than you could fake a loss on the synthetic task.

You can also inject your own data without touching the datasets module —
`Cortex.makeTask({ data: { name, features: [[…]], labels: [0|1,…] } })`.

### Rewarding generalisation, not memorisation (commit–reveal)

The base reward tracks *training* loss — and with a finite, fully-public dataset
you cannot tell a model that generalised from one that memorised every row
(any subset of public data is, by definition, data a memoriser has seen).
Measuring generalisation needs data the miner hasn't seen, which
`cortex/holdout.js` provides through a **commit–reveal** scheme:

1. **Seal** (once, by the task author) — a slice of data is withheld from the
   chain and split into test batches; only a *hiding commitment* `H(salt‖batch)`
   for each is published. `prepareHoldout()` does this deterministically.
2. **Commit** (by the miner) — train on the public train set, publish
   `H(weights)` **before** the batch for this height is revealed.
3. **Reveal** (by the author) — publish the salt + batch; anyone checks it
   matches the published commitment, then scores the committed model on it.
   Reward = how much it beats the parent model on that fresh, unseen batch.

`settle()` enforces both bindings: the weights must match the miner's commitment
(so it can't tune to the batch after seeing it — tested), and the revealed batch
must match its published commitment (so the author can't swap in an easier one —
tested). A genuinely trained model earns MIND on data it never saw (>90% held-out
accuracy in the tests); a model that did nothing earns zero.

> **This layer is not trustless.** It depends on a party who prepares the sealed
> batches and reveals them honestly, in order, without leaking or training on
> them — the unavoidable price of measuring generalisation, since anything
> validators can recompute, miners can see. It also yields only *k* honest
> blocks (one per sealed batch): fresh test data is a consumable resource. The
> base chain keeps its "pure math, anyone verifies" property; commit–reveal
> trades some of that for a guarantee the base layer cannot give. Use it where a
> trusted data provider is acceptable.

## Production cost & economics

A miner's cost is **CPU time spent training** — real compute, hence real
electricity. There's no artificial hash target and no ASIC advantage; the cost
is exactly the work of finding weights that lower the shared model's loss, and
unlike hash-guessing **none of it is wasted** — every step also improves the
public model. Reproduce the numbers below with `npm run bench:cortex`.

**Unit costs** (this demo task: 120 samples, 6 hidden units, 25 weights):

| Operation | Cost | Role |
| --- | --- | --- |
| One gradient step | ~0.23 ms | the unit of *mining* work |
| One forward-pass loss check | ~0.33 ms | the *learning-verification* |
| secp256k1 sign / verify | ~16 / ~30 ms | fixed per-block crypto, same as any signed chain |

**The cost curve — mining gets exponentially dearer as the model matures.**
Reward is proportional to loss removed, but the *floor* per block is fixed
(`minImprovement × REWARD_PER_LOSS` = 0.004 MIND). Early blocks clear that floor
in one cheap round of training; near convergence, each extra 0.004 of loss takes
thousands of steps:

| Block | Time to mine | Reward | Cost per MIND |
| --- | --- | --- | --- |
| #1 (fresh) | ~55 ms | 0.064 MIND | ~850 ms/MIND |
| #29 (converged) | ~750 ms | 0.004 MIND | ~188,000 ms/MIND |

So earning a MIND at convergence costs **~200× more** than at the start. That
rising cost *is* the difficulty curve — it comes from diminishing returns on
learning, not an artificial retarget — and it's why issuance naturally stops:
marginal cost per MIND climbs toward infinity as the model runs out of things to
learn.

**The asymmetry** that makes it consensus-grade: a mature block costs
**~2,300× its own learning-verification** (thousands of gradient steps to
produce, one forward pass to check).

### What does that cost in USD?

Two honest points first:

1. **MIND has no market price.** There's no exchange, no fiat pair, no trading.
   Everything below is *production cost* (a cost basis), which in a rational
   market would floor the price — it does not set one. What a MIND is *worth*
   would be whatever a community decides, the same way TimeCoin anchors value to
   time and favours rather than dollars.
2. **Production cost is a design parameter, not an emergent constant.** You dial
   it by choosing how big a model and dataset the network commits to at genesis.
   The prototype's model is 25 weights, so its cost is essentially zero; a
   serious task costs real money. There is no single number — only a range you
   choose.

Measured and projected (`FLOPs/block ≈ 6 × params × samples-processed`, run on a
100 TFLOP/s accelerator at $1.5/GPU-hour):

| Scenario | Params | FLOPs / block | Time / block | **USD / block** |
| --- | --- | --- | --- | --- |
| **This prototype** | 25 | ~1.8 M | <1 ms | ~$0 (measured: $5e-7) |
| Small model | 100 K | 600 G | ~6 ms | ~$0.000003 |
| Medium model | 10 M | 6 P | ~60 s | ~$0.03 |
| Large model | 1 B | 60 E | ~167 h | ~$250 |

### Choosing the production-cost tier

Because per-block cost is dominated by `O(samples × params)` work, a deployment
sets how expensive mining is by choosing a **scale** at genesis
(`Cortex.makeTask({ scale })`) rather than hand-tuning numbers. Each tier grows
input dimension, depth, width and dataset size together — measured cost per
gradient step (`npm run bench:cortex`):

| Scale | Architecture | Samples | Params | µs / step | vs toy | ~1,000-step block |
| --- | --- | --- | --- | --- | --- | --- |
| `toy` (default) | 2→6→1 | 120 | 25 | ~310 | 1× | ~0.3 s |
| `small` | 4→16→1 | 500 | 97 | ~2,600 | ~8× | ~2.6 s |
| `medium` | 6→24→24→1 | 1,500 | 793 | ~25,000 | ~80× | ~25 s |
| `large` | 8→48→48→1 | 4,000 | 2,833 | ~145,000 | ~470× | ~2.4 min |

The model is a **general MLP**, so scale isn't capped by the architecture — pass
your own `{ inputs, layers: [w1, w2, …] }` for any depth/width you like; the cost
just follows the parameter count. The presets stop at `large` only so the
benchmark stays runnable in seconds, not because the engine can't go bigger. The
classification target is always the same 2-D XOR of the first two features (the
rest are distractors), so every size stays learnable — what changes is purely
how much compute a block costs. To reach the dollars-per-block rows in the
projection table above you'd pick a much larger `layers`, which is now just a
config value, not a code change.

### So what's the production cost when the coin is mature?

This is two layered things:

- **Within one chain**, "mature" means near convergence: cost per block climbs
  ~14× (and cost per MIND ~200×) versus a fresh chain, because the model is
  running out of learnable signal. In USD that's still whatever the *task scale*
  above implies — a mature block on the "medium" task costs on the order of a
  few cents; on the "large" task, a few hundred dollars.
- **Across deployments**, a "mature" (production-serious) Cortex would pick a
  large task on purpose, landing in the dollars-to-hundreds-of-dollars-per-block
  range — which is the point: the cost has to be high enough that the MIND
  reward is worth competing for, and low enough that the learning is worth doing.

## Demo

Open `cortex/index.html` in a browser (it loads `../coin/engine.js` then
`engine.js`). Press **Mine a block** to train the shared network one block at a
time and watch the decision boundary bend to fit a noisy XOR — a shape no
straight line can separate — while loss falls and accuracy climbs block over
block.

## Tests

```
npm run test:cortex          # engine: model, chain, MIND token
npm run test:cortex-holdout  # commit–reveal generalisation layer
npm test                     # the whole prototype suite (includes Cortex)
npm run bench:cortex         # production-cost benchmark (not part of the test gate)
```

The suite (20 tests) covers dataset/weight determinism, that training actually
reduces loss and lifts accuracy, block signing and hash-linking, every learning
rejection path (false loss, no learning, wrong signer, broken link),
cumulative-learning fork choice, and the full **MIND token layer**: rewards
proportional to learning, supply bounded by knowledge, signed transfers that
conserve value, and every economic rejection path (overdraft, replayed nonce,
self-minted reward, tampered transfer).

## Honest limitations

This is a self-contained **prototype**, not a production chain:

- **Float determinism.** Verification relies on every node computing the same
  loss from the same quantised weights. JavaScript doubles are deterministic
  across V8 engines, and weights are quantised, but a fully robust deployment
  would fix the arithmetic (e.g. fixed-point) across all clients.
- **One task per chain.** The dataset and model are fixed at genesis. A real
  system would rotate tasks and cap block size as models grow.
- **The base reward is scored on the full public dataset**, so it rewards
  fitting the visible data — a big enough model could memorise rather than
  generalise. The **commit–reveal layer** (`cortex/holdout.js`, above) fixes this
  where a trusted data provider is acceptable: it rewards loss on withheld
  batches revealed only after weights are committed, so only genuine
  generalisation earns MIND. It is not trustless (see that section) and yields a
  finite number of honest blocks; a fully trustless version would need a live
  fresh-data feed or a beacon-driven reveal, which no finite public dataset can
  provide.
- **No networking here.** The engine is the consensus core; peer gossip would
  reuse TimeCoin's relay (`coin/server.mjs`) the way the other layers do.
