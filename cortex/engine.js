/**
 * Cortex — a Proof-of-Learning blockchain
 * =======================================
 *
 * Bitcoin's proof-of-work asks miners to burn electricity on SHA-256 guesses
 * that are worthless the instant they're found. Their only job is to be *hard
 * to produce* and *easy to check*. Cortex keeps that asymmetry but makes the
 * hard part do something useful: instead of guessing hashes, a miner trains a
 * shared neural network, and a block is the proof that the network now knows
 * a little more than it did in the block before.
 *
 * The whole network agrees on ONE learning task — a fixed, seeded dataset and a
 * tiny multilayer perceptron (2→H→1, tanh hidden, sigmoid output). The genesis
 * block pins the task and a random starting set of weights. To mine the next
 * block you take the tip's weights, train them (gradient descent — the
 * expensive part) until the model's loss drops by at least `minImprovement`,
 * and publish the new weights. That's the "proof of learning".
 *
 *   • WORK IS USEFUL. The energy spent mining is spent teaching the shared
 *     model. When the chain finishes, the community owns a trained network.
 *   • HARD TO PRODUCE, CHEAP TO CHECK. Training runs thousands of gradient
 *     steps; verifying a block is a single forward pass to recompute the loss.
 *     You cannot lie about the loss — everyone recomputes it from your weights.
 *   • DIFFICULTY IS THE LEARNING CURVE. Early blocks are easy (loss falls
 *     fast); as the model converges, squeezing out another `minImprovement`
 *     gets exponentially harder — difficulty that comes from the problem
 *     itself, not an artificial target. When no block can improve on the tip,
 *     the model has converged and the chain is complete.
 *   • FORK CHOICE BY TOTAL LEARNING. The heaviest chain is the one that has
 *     learned the most (largest cumulative loss reduction), the exact analogue
 *     of Bitcoin's most-cumulative-work rule. The smartest chain wins.
 *
 * The cryptography is real: every block after genesis is signed with a
 * secp256k1 key and hash-linked to its parent with double-SHA-256, so the
 * sequence of model checkpoints is tamper-evident and every improvement is
 * attributable to the miner who did the work. Weights are quantised to a fixed
 * grid before hashing so every node hashes and scores identical bytes.
 *
 * Dependency-free. Reuses TimeCoin's cryptography (coin/engine.js) for hashing,
 * signatures and addresses — a wallet works here too. Loaded the UMD way; in
 * the browser it reads the global `BallrzCoin`, same in the Node test sandbox.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzCortex = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function coin() {
    var g = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this;
    if (g && g.BallrzCoin) return g.BallrzCoin;
    throw new Error('TimeCoin engine (coin/engine.js) must be loaded before cortex/engine.js');
  }

  var GENESIS_PREV = '0000000000000000000000000000000000000000000000000000000000000000';

  var DEFAULTS = {
    ticker: 'MIND',
    samples: 120,        // size of the shared dataset
    hidden: 6,           // hidden units in the shared MLP (2 -> H -> 1)
    noise: 0.15,         // label-flip probability, so loss can't reach 0
    minImprovement: 0.004, // a block must cut average loss by at least this much
    quantum: 1e-6        // weights are rounded to this grid before hashing/scoring
  };

  /* ======================================================================
   * Deterministic randomness — mulberry32, seeded from a string via SHA-256,
   * so the dataset and the starting weights are identical on every node.
   * ==================================================================== */
  function seedFrom(str) {
    var h = coin().sha256(String(str));
    return (parseInt(h.slice(0, 8), 16) >>> 0) || 1;
  }
  function mulberry32(a) {
    var s = a >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Standard normal via Box–Muller, driven by a mulberry32 stream.
  function gaussian(rng) {
    var u = 1 - rng(), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ======================================================================
   * The shared learning task: a deterministic, non-linearly-separable
   * dataset (a "noisy XOR" of the two quadrant signs) that a linear model
   * cannot solve — so the hidden layer genuinely has to learn something.
   * ==================================================================== */
  function makeTask(opts) {
    opts = opts || {};
    var t = {
      id: String(opts.id || 'cortex-genesis-task'),
      samples: opts.samples || DEFAULTS.samples,
      hidden: opts.hidden || DEFAULTS.hidden,
      noise: (opts.noise == null) ? DEFAULTS.noise : opts.noise,
      minImprovement: (opts.minImprovement == null) ? DEFAULTS.minImprovement : opts.minImprovement,
      quantum: opts.quantum || DEFAULTS.quantum,
      ticker: String(opts.ticker || DEFAULTS.ticker)
    };
    var rng = mulberry32(seedFrom('data:' + t.id));
    var X = [], y = [];
    for (var i = 0; i < t.samples; i++) {
      var x0 = rng() * 2 - 1, x1 = rng() * 2 - 1;
      var label = ((x0 > 0) !== (x1 > 0)) ? 1 : 0;       // XOR of the signs
      if (rng() < t.noise) label = 1 - label;             // flip some labels
      X.push([x0, x1]); y.push(label);
    }
    t.X = X; t.y = y;
    t.dim = 4 * t.hidden + 1; // W1 (H*2) + b1 (H) + W2 (H) + b2 (1)
    return t;
  }

  // A random starting network for the task, seeded so genesis is reproducible.
  function randomWeights(task, seedStr) {
    var rng = mulberry32(seedFrom('init:' + task.id + ':' + (seedStr || '')));
    var w = new Array(task.dim);
    for (var i = 0; i < task.dim; i++) w[i] = gaussian(rng) * 0.5;
    return quantise(w, task.quantum);
  }

  function quantise(w, q) {
    var out = new Array(w.length);
    for (var i = 0; i < w.length; i++) out[i] = Math.round(w[i] / q) * q;
    return out;
  }

  /* ======================================================================
   * The model: 2 -> H -> 1 MLP. Weight vector layout, forward pass, loss,
   * accuracy and a full-batch gradient-descent trainer.
   * ==================================================================== */
  function unpack(task, w) {
    var H = task.hidden, k = 0, i;
    var W1 = [], b1 = [], W2 = [];
    for (i = 0; i < H; i++) { W1.push([w[k++], w[k++]]); }
    for (i = 0; i < H; i++) { b1.push(w[k++]); }
    for (i = 0; i < H; i++) { W2.push(w[k++]); }
    var b2 = w[k++];
    return { W1: W1, b1: b1, W2: W2, b2: b2 };
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  // The model's probability that point x belongs to class 1 (for visualising
  // the decision boundary, and handy in tests).
  function predict(task, w, x) { return predictOne(unpack(task, w), x).p; }

  function predictOne(m, x) {
    var H = m.W2.length, s = m.b2, j;
    var a1 = new Array(H);
    for (j = 0; j < H; j++) {
      var z1 = m.W1[j][0] * x[0] + m.W1[j][1] * x[1] + m.b1[j];
      a1[j] = Math.tanh(z1);
      s += m.W2[j] * a1[j];
    }
    return { p: sigmoid(s), a1: a1 };
  }

  // Average binary cross-entropy over the whole dataset (clamped so log is finite).
  function loss(task, w) {
    var m = unpack(task, w), n = task.samples, sum = 0;
    for (var i = 0; i < n; i++) {
      var p = predictOne(m, task.X[i]).p;
      p = Math.min(1 - 1e-12, Math.max(1e-12, p));
      var yi = task.y[i];
      sum += -(yi * Math.log(p) + (1 - yi) * Math.log(1 - p));
    }
    return sum / n;
  }

  function accuracy(task, w) {
    var m = unpack(task, w), n = task.samples, ok = 0;
    for (var i = 0; i < n; i++) {
      var pred = predictOne(m, task.X[i]).p >= 0.5 ? 1 : 0;
      if (pred === task.y[i]) ok++;
    }
    return ok / n;
  }

  // One full-batch gradient-descent step; returns a fresh weight vector.
  function trainStep(task, w, lr) {
    var m = unpack(task, w), H = task.hidden, n = task.samples;
    var gW1 = [], gb1 = new Array(H), gW2 = new Array(H), gb2 = 0, j;
    for (j = 0; j < H; j++) { gW1.push([0, 0]); gb1[j] = 0; gW2[j] = 0; }
    for (var i = 0; i < n; i++) {
      var x = task.X[i], fwd = predictOne(m, x), dz2 = fwd.p - task.y[i];
      gb2 += dz2;
      for (j = 0; j < H; j++) {
        gW2[j] += dz2 * fwd.a1[j];
        var dz1 = dz2 * m.W2[j] * (1 - fwd.a1[j] * fwd.a1[j]); // tanh'
        gW1[j][0] += dz1 * x[0];
        gW1[j][1] += dz1 * x[1];
        gb1[j] += dz1;
      }
    }
    var out = new Array(task.dim), k = 0;
    for (j = 0; j < H; j++) { out[k++] = m.W1[j][0] - lr * gW1[j][0] / n; out[k++] = m.W1[j][1] - lr * gW1[j][1] / n; }
    for (j = 0; j < H; j++) { out[k++] = m.b1[j] - lr * gb1[j] / n; }
    for (j = 0; j < H; j++) { out[k++] = m.W2[j] - lr * gW2[j] / n; }
    out[k++] = m.b2 - lr * gb2 / n;
    return out;
  }

  // Train `steps` gradient steps from `w`, quantising the result to the task
  // grid so it hashes and scores identically everywhere.
  function train(task, w, steps, lr) {
    lr = lr || 0.5;
    var cur = w.slice();
    for (var s = 0; s < steps; s++) cur = trainStep(task, cur, lr);
    return quantise(cur, task.quantum);
  }

  /* ======================================================================
   * Blocks — hash-linked, signed checkpoints of the shared model.
   * ==================================================================== */
  function weightsHash(task, w) {
    var q = task.quantum;
    var s = w.map(function (x) { return (Math.round(x / q) * q).toFixed(9); }).join(',');
    return coin().sha256(s);
  }

  // The canonical, signature-covered, hash-linked string for a block. Field
  // order is fixed so every node hashes identical bytes. Excludes `sig`/`hash`.
  function canonical(b) {
    return [b.index, b.prevHash, b.taskId, b.weightsHash, b.loss.toFixed(9), b.miner, b.pubKey, b.at, b.nonce].join('|');
  }
  function blockHash(b) { return coin().sha256d(canonical(b)); }

  /* ======================================================================
   * The chain.
   *   new Chain(task, { genesisSeed })   builds the genesis checkpoint.
   *   chain.mineBlock({ privKey, ... })  trains the tip forward into a block.
   *   chain.addBlock(block)              verifies and appends (throws on bad).
   *   chain.replaceChain(blocks)         adopt a rival fork iff it learned more.
   * ==================================================================== */
  function Chain(task, opts) {
    if (!(this instanceof Chain)) return new Chain(task, opts);
    opts = opts || {};
    this.task = task;
    var w = randomWeights(task, opts.genesisSeed || '');
    var genesis = {
      index: 0,
      prevHash: GENESIS_PREV,
      taskId: task.id,
      weights: w,
      weightsHash: weightsHash(task, w),
      loss: round9(loss(task, w)),
      miner: '',
      pubKey: '',
      at: Number(opts.at || 0),
      nonce: 'genesis'
    };
    genesis.sig = '';
    genesis.hash = blockHash(genesis);
    this.blocks = [genesis];
    this.baselineLoss = genesis.loss;
  }

  function round9(x) { return Math.round(x * 1e9) / 1e9; }

  Chain.prototype.tip = function () { return this.blocks[this.blocks.length - 1]; };
  Chain.prototype.height = function () { return this.blocks.length - 1; };
  Chain.prototype.tipLoss = function () { return this.tip().loss; };
  Chain.prototype.tipWeights = function () { return this.tip().weights.slice(); };
  Chain.prototype.accuracy = function () { return accuracy(this.task, this.tip().weights); };
  // Total learning on this chain = how far loss has fallen from genesis. This is
  // the "cumulative work" the fork-choice rule maximises.
  Chain.prototype.cumulativeImprovement = function () { return round9(this.baselineLoss - this.tipLoss()); };

  // Train the tip's weights forward into a candidate block signed by `privKey`.
  // Keeps training (in rounds of `steps`) until the loss has dropped by at least
  // the task's minImprovement, up to `maxRounds`. Returns null if it can't beat
  // the tip (the model has effectively converged).
  Chain.prototype.mineBlock = function (opts) {
    var C = coin(), task = this.task, tip = this.tip();
    var pub = C.getPublicKey(opts.privKey);
    var miner = C.addressFromPublicKey(pub);
    var w = tip.weights.slice();
    var steps = opts.steps || 400, lr = opts.lr || 0.5;
    var need = tip.loss - task.minImprovement;
    var rounds = opts.maxRounds || 40, newLoss = tip.loss;
    for (var r = 0; r < rounds; r++) {
      w = train(task, w, steps, lr);
      newLoss = round9(loss(task, w));
      if (newLoss <= need) break;
    }
    if (newLoss > need) return null; // couldn't learn enough — chain has converged
    var block = {
      index: tip.index + 1,
      prevHash: tip.hash,
      taskId: task.id,
      weights: w,
      weightsHash: weightsHash(task, w),
      loss: newLoss,
      miner: miner,
      pubKey: pub,
      at: Number(opts.at || 0),
      nonce: String(opts.nonce == null ? tip.index + 1 : opts.nonce)
    };
    block.sig = C.sign(C.sha256(canonical(block)), opts.privKey);
    block.hash = blockHash(block);
    return block;
  };

  // Is `block` a valid successor to `prev` on this task? Recomputes everything
  // from the block's own weights — nothing is taken on trust.
  Chain.prototype.isValidBlock = function (block, prev) {
    var C = coin(), task = this.task;
    if (!block || typeof block !== 'object') return { ok: false, reason: 'not a block' };
    if (block.taskId !== task.id) return { ok: false, reason: 'wrong task' };
    if (block.index !== prev.index + 1) return { ok: false, reason: 'index not sequential' };
    if (block.prevHash !== prev.hash) return { ok: false, reason: 'does not link to parent' };
    if (!Array.isArray(block.weights) || block.weights.length !== task.dim) return { ok: false, reason: 'wrong weight shape' };
    if (block.weightsHash !== weightsHash(task, block.weights)) return { ok: false, reason: 'weights hash mismatch' };
    if (block.hash !== blockHash(block)) return { ok: false, reason: 'block hash mismatch' };
    // The heart of it: recompute the loss from the published weights.
    var actual = round9(loss(task, block.weights));
    if (Math.abs(actual - block.loss) > 1e-9) return { ok: false, reason: 'claimed loss is false' };
    // Proof of learning: the model must have genuinely improved by enough.
    if (block.loss > prev.loss - task.minImprovement + 1e-12) return { ok: false, reason: 'insufficient learning' };
    // Signature: the miner who claims the work must have signed it.
    if (!C.isValidAddress(block.miner)) return { ok: false, reason: 'bad miner address' };
    if (C.addressFromPublicKey(block.pubKey) !== block.miner) return { ok: false, reason: 'pubkey/miner mismatch' };
    try {
      if (!C.verify(C.sha256(canonical(block)), block.sig, block.pubKey)) return { ok: false, reason: 'bad signature' };
    } catch (e) { return { ok: false, reason: 'bad signature' }; }
    return { ok: true };
  };

  Chain.prototype.addBlock = function (block) {
    var v = this.isValidBlock(block, this.tip());
    if (!v.ok) throw new Error('rejected block: ' + v.reason);
    this.blocks.push(block);
    return true;
  };

  // Validate a whole candidate chain from genesis and return its total learning,
  // or null if any link is invalid. Used by fork choice.
  Chain.prototype.scoreChain = function (blocks) {
    if (!blocks || !blocks.length) return null;
    var g = blocks[0];
    if (g.index !== 0 || g.prevHash !== GENESIS_PREV || g.taskId !== this.task.id) return null;
    if (g.weightsHash !== weightsHash(this.task, g.weights) || g.hash !== blockHash(g)) return null;
    if (Math.abs(round9(loss(this.task, g.weights)) - g.loss) > 1e-9) return null;
    for (var i = 1; i < blocks.length; i++) {
      var v = this.isValidBlock(blocks[i], blocks[i - 1]);
      if (!v.ok) return null;
    }
    return round9(g.loss - blocks[blocks.length - 1].loss);
  };

  // Fork choice: adopt `blocks` iff it is valid, shares our genesis, and has
  // learned strictly more than the chain we currently hold (the heaviest =
  // smartest chain wins). Returns true if we switched.
  Chain.prototype.replaceChain = function (blocks) {
    if (blocks[0] && this.blocks[0] && blocks[0].hash !== this.blocks[0].hash) return false; // different genesis
    var theirs = this.scoreChain(blocks);
    if (theirs == null) return false;
    if (theirs <= this.cumulativeImprovement()) return false;
    this.blocks = blocks.slice();
    return true;
  };

  return {
    version: '1.0.0',
    DEFAULTS: DEFAULTS, GENESIS_PREV: GENESIS_PREV,
    // task & data
    makeTask: makeTask, randomWeights: randomWeights, quantise: quantise,
    // model
    loss: loss, accuracy: accuracy, predict: predict, train: train, trainStep: trainStep,
    // blocks
    weightsHash: weightsHash, canonical: canonical, blockHash: blockHash,
    // chain
    Chain: Chain
  };
});
