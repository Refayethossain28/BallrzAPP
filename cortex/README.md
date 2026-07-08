# Cortex — a Proof-of-Learning blockchain

**AI cryptography on its own blockchain.** Cortex is a small, dependency-free
blockchain whose consensus mechanism *is* machine learning. Where Bitcoin's
miners burn electricity solving hash puzzles that are thrown away the instant
they're found, Cortex miners train a shared neural network — and a block is the
cryptographic proof that the network now knows a little more than it did before.

The work is hard to produce and cheap to check (the same asymmetry that makes
proof-of-work possible), except here the work is *useful*: when the chain
finishes, the community owns a trained model that everyone helped build and
anyone can independently verify.

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
dataset and a tiny neural network (a 2→H→1 multilayer perceptron with a `tanh`
hidden layer and a `sigmoid` output). The **genesis block** pins the task and a
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

## Using the engine

```js
const Cortex = require('./cortex/engine.js'); // needs global BallrzCoin loaded first

const task  = Cortex.makeTask({ id: 'my-task' });          // shared dataset + model shape
const chain = new Cortex.Chain(task, { genesisSeed: 'g' }); // genesis checkpoint

// mine: train the tip forward into a signed block
const block = chain.mineBlock({ privKey, steps: 400 });
chain.addBlock(block);                    // verifies, then appends

chain.height();                 // number of blocks mined
chain.tipLoss();                // the shared model's current loss
chain.accuracy();               // its accuracy on the task
chain.cumulativeImprovement();  // total learning = the chain's "weight"

// converge on the smartest chain
chain.replaceChain(rivalBlocks); // adopts it iff it learned strictly more
```

`mineBlock` returns `null` once the model has effectively converged and no
block can clear the `minImprovement` bar — that's the chain reaching its
natural end.

## Demo

Open `cortex/index.html` in a browser (it loads `../coin/engine.js` then
`engine.js`). Press **Mine a block** to train the shared network one block at a
time and watch the decision boundary bend to fit a noisy XOR — a shape no
straight line can separate — while loss falls and accuracy climbs block over
block.

## Tests

```
npm run test:cortex     # just this prototype
npm test                # the whole prototype suite (includes Cortex)
```

The suite covers dataset/weight determinism, that training actually reduces
loss and lifts accuracy, block signing and hash-linking, every rejection path
(false loss, no learning, wrong signer, broken link), and cumulative-learning
fork choice.

## Honest limitations

This is a self-contained **prototype**, not a production chain:

- **Float determinism.** Verification relies on every node computing the same
  loss from the same quantised weights. JavaScript doubles are deterministic
  across V8 engines, and weights are quantised, but a fully robust deployment
  would fix the arithmetic (e.g. fixed-point) across all clients.
- **One task per chain.** The dataset and model are fixed at genesis. A real
  system would rotate tasks, hold out a private test set to stop overfitting the
  public data, and cap block size as models grow.
- **No networking here.** The engine is the consensus core; peer gossip would
  reuse TimeCoin's relay (`coin/server.mjs`) the way the other layers do.
