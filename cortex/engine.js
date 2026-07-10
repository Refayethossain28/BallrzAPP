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

  // MIND — the chain's spendable token.
  // ------------------------------------
  // One MIND divides into 1,000,000 base units ("synapses"). Mining a block
  // mints MIND *to the miner in proportion to the learning it contributed* —
  // exactly REWARD_PER_LOSS base units for every 1.0 of average loss the block
  // removed. So the reward is earned by teaching the shared model, not by
  // showing up, and the TOTAL money supply is bounded by the total knowledge
  // the network can ever create: it can never exceed (genesis loss × REWARD)
  // and stops growing the moment the model converges. MIND then moves between
  // wallets as ordinary secp256k1-signed transfers carried inside blocks, with
  // balances that can never go negative — you cannot spend MIND you have not
  // earned or been paid.
  var MIND = 1000000;            // base units ("synapses") in one MIND
  var REWARD_PER_LOSS = MIND;    // base units minted per 1.0 of average loss removed (1.0 loss → 1 MIND)

  var DEFAULTS = {
    ticker: 'MIND',
    samples: 120,        // size of the shared dataset
    hidden: 6,           // hidden units in the shared MLP (2 -> H -> 1)
    noise: 0.15,         // label-flip probability, so loss can't reach 0
    minImprovement: 0.004, // a block must cut average loss by at least this much
    quantum: 1e-6        // weights are rounded to this grid before hashing/scoring
  };

  // Base units minted for lowering the model's average loss from `prevLoss` to
  // `newLoss`. Always positive for a valid block (it must improve by at least
  // the task's minImprovement). This is the coinbase reward.
  function blockReward(task, prevLoss, newLoss) {
    var scale = (task && task.rewardPerLoss != null) ? task.rewardPerLoss : REWARD_PER_LOSS;
    return Math.max(0, Math.round((prevLoss - newLoss) * scale));
  }

  // Format a base-unit amount as a human MIND string, e.g. 1900000 -> "1.9 MIND".
  function formatMind(units, ticker) {
    var sign = units < 0 ? '-' : '', abs = Math.abs(units);
    var whole = Math.floor(abs / MIND);
    var frac = String(abs % MIND + MIND).slice(1).replace(/0+$/, '');
    return sign + whole + (frac ? '.' + frac : '') + ' ' + (ticker || DEFAULTS.ticker);
  }

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
  // Deterministic approximate standard normal (Irwin–Hall: sum of 12 uniforms
  // minus 6). Only additions on the integer PRNG stream, so genesis weights are
  // bit-identical on every machine — unlike Box–Muller's Math.log/cos.
  function gaussian(rng) {
    var s = 0; for (var i = 0; i < 12; i++) s += rng(); return s - 6;
  }

  /* ======================================================================
   * Deterministic transcendentals — the fork-safety layer.
   * ----------------------------------------------------------------------
   * IEEE-754 guarantees + − × ÷ √ are correctly rounded, so they give
   * bit-identical results on every conforming CPU/OS/JS engine. Math.exp/log/
   * tanh are NOT so guaranteed and can differ in the last ULP across platforms,
   * which would let two honest nodes disagree on a block's loss and fork the
   * chain. So the consensus path (forward pass, loss) uses these software
   * implementations built ONLY from the guaranteed ops. Accuracy vs Math.* is
   * ~1e-10 (checked in scripts/test-cortex-determinism.mjs); determinism is
   * exact. Training may be slower, but every node agrees to the bit.
   * ==================================================================== */
  var LN2 = 0.6931471805599453;
  function pow2(k) { var r = 1.0, b = k < 0 ? 0.5 : 2.0, n = k < 0 ? -k : k; while (n-- > 0) r *= b; return r; }
  function dexp(x) {
    if (x > 709) x = 709; if (x < -745) x = -745;
    var k = Math.round(x / LN2), r = x - k * LN2, t = 1, s = 1;   // |r| ≤ LN2/2
    for (var i = 1; i <= 9; i++) { t *= r / i; s += t; }           // Taylor, deg 9
    return s * pow2(k);
  }
  function dln(x) {
    if (x <= 0) return -Infinity;
    var e = 0, m = x;
    while (m >= 2) { m *= 0.5; e++; } while (m < 1) { m *= 2; e--; } // m ∈ [1,2)
    var u = (m - 1) / (m + 1), u2 = u * u, term = u, sum = 0;        // ln(m)=2·atanh(u)
    for (var i = 1; i <= 21; i += 2) { sum += term / i; term *= u2; }
    return e * LN2 + 2 * sum;
  }
  function dtanh(x) { var ax = x < 0 ? -x : x; if (ax > 20) return x < 0 ? -1 : 1; var e = dexp(-2 * ax), r = (1 - e) / (1 + e); return x < 0 ? -r : r; }
  function dsigmoid(x) { if (x >= 0) return 1 / (1 + dexp(-x)); var e = dexp(x); return e / (1 + e); }

  /* ======================================================================
   * Task-scale presets — the production-cost tier.
   * ----------------------------------------------------------------------
   * The model is a general feedforward MLP: `inputs` features → any number of
   * hidden `layers` (tanh) → 1 sigmoid output. A miner's cost per block is
   * dominated by O(samples × params) work per gradient step, so a deployment
   * picks how expensive mining is by picking a scale — width, depth, input
   * dimension and dataset size all grow together — rather than hand-tuning.
   * The classification target is always the same 2-D XOR of the first two
   * features (extra inputs are distractors the network must learn to ignore),
   * so every tier stays learnable no matter how big the model gets. `scale`
   * sets inputs/layers/samples/minImprovement; any explicit option overrides.
   * ==================================================================== */
  var SCALES = {
    toy:    { inputs: 2,  layers: [6],           samples: 120,  minImprovement: 0.004 }, // 25 params — demo/default
    small:  { inputs: 4,  layers: [16],          samples: 500,  minImprovement: 0.003 }, // ~97 params
    medium: { inputs: 6,  layers: [24, 24],      samples: 1500, minImprovement: 0.002 }, // ~793 params
    large:  { inputs: 8,  layers: [48, 48],      samples: 4000, minImprovement: 0.0015 } // ~2833 params, 2 hidden layers
  };

  // Full layer sizes [inputs, ...hidden, 1] and the flat weight-vector length.
  function archOf(inputs, layers) { return [inputs].concat(layers).concat([1]); }
  function dimOf(arch) {
    var d = 0;
    for (var i = 0; i < arch.length - 1; i++) d += arch[i] * arch[i + 1] + arch[i + 1]; // W + b per layer
    return d;
  }

  // The embedded real-dataset module (cortex/datasets.js), read as a global the
  // same UMD way as the coin engine. Only needed when a named dataset is used.
  function datasetLib() {
    var g = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this;
    if (g && g.BallrzCortexData) return g.BallrzCortexData;
    throw new Error('cortex/datasets.js must be loaded before using a named dataset');
  }

  // Per-feature z-score standardisation, computed deterministically from the
  // data itself so every node derives identical scaled inputs. Real features
  // live on wildly different ranges; without this, training barely moves.
  function standardise(features) {
    var n = features.length, dim = features[0].length, mean = new Array(dim).fill(0), std = new Array(dim).fill(0), i, d;
    for (i = 0; i < n; i++) for (d = 0; d < dim; d++) mean[d] += features[i][d];
    for (d = 0; d < dim; d++) mean[d] /= n;
    for (i = 0; i < n; i++) for (d = 0; d < dim; d++) { var e = features[i][d] - mean[d]; std[d] += e * e; }
    for (d = 0; d < dim; d++) std[d] = Math.sqrt(std[d] / n) || 1; // guard a constant feature
    var out = new Array(n);
    for (i = 0; i < n; i++) { var row = new Array(dim); for (d = 0; d < dim; d++) row[d] = (features[i][d] - mean[d]) / std[d]; out[i] = row; }
    return { X: out, mean: mean, std: std };
  }

  /* ======================================================================
   * The shared learning task. Two flavours, both fully deterministic:
   *   • synthetic (default) — a seeded "noisy XOR" of the first two features,
   *     which a linear model can't solve, so the hidden layer must learn;
   *   • a real dataset — pass { dataset: 'banknote' } (looked up from the
   *     embedded, byte-identical cortex/datasets.js) or { data: {features,
   *     labels} }. Real features are z-score standardised deterministically.
   * The model shape (inputs/layers) still comes from scale/opts, so you choose
   * how big — and thus how costly — the network is independently of the data.
   * ==================================================================== */
  function makeTask(opts) {
    opts = opts || {};
    var preset = DEFAULTS; // toy-equivalent
    if (opts.scale != null) {
      preset = SCALES[String(opts.scale)];
      if (!preset) throw new Error('unknown task scale: ' + opts.scale + ' (use ' + Object.keys(SCALES).join('/') + ')');
    }
    // Resolve a real dataset if requested (direct data wins over a named lookup).
    var real = opts.data ? opts.data : (opts.dataset ? datasetLib().get(String(opts.dataset)) : null);

    // Hidden-layer widths: explicit `layers`, else legacy single `hidden`, else preset.
    var layers = opts.layers || (opts.hidden ? [opts.hidden] : (preset.layers || [preset.hidden || DEFAULTS.hidden]));
    var t = {
      id: String(opts.id || 'cortex-genesis-task'),
      scale: opts.scale != null ? String(opts.scale) : 'toy',
      layers: layers.slice(),
      hidden: layers[0], // kept for backward-compatible readers
      noise: (opts.noise == null) ? DEFAULTS.noise : opts.noise,
      minImprovement: (opts.minImprovement == null) ? (preset.minImprovement == null ? DEFAULTS.minImprovement : preset.minImprovement) : opts.minImprovement,
      quantum: opts.quantum || DEFAULTS.quantum,
      rewardPerLoss: (opts.rewardPerLoss == null) ? REWARD_PER_LOSS : Number(opts.rewardPerLoss),
      ticker: String(opts.ticker || DEFAULTS.ticker)
    };

    /* Emission schedule (optional, consensus-critical when set): rations how
     * fast the chain may absorb learning, Bitcoin-style. allowedLoss(t) decays
     * from the genesis loss toward (genesisLoss − budget) with the given
     * half-life; a block whose loss undercuts the schedule at its timestamp is
     * INVALID — no amount of compute can learn ahead of schedule. Emissions
     * therefore halve every halfLifeMs: ~50% of all MIND in the first
     * half-life, ~97% after five. Set budget to (at most) the loss the model
     * can actually shed, and the practical ceiling lands at ≈ 4–5 half-lives. */
    if (opts.schedule) {
      var sch = opts.schedule;
      t.schedule = {
        startAt: Number(sch.startAt),                 // fixed epoch ms — same constant on every node
        halfLifeMs: Number(sch.halfLifeMs),           // emission half-life
        budget: Number(sch.budget),                   // total loss the schedule will ever release
        minIntervalMs: Number(sch.minIntervalMs == null ? 60000 : sch.minIntervalMs)
      };
      if (!(t.schedule.startAt > 0) || !(t.schedule.halfLifeMs > 0) || !(t.schedule.budget > 0)) {
        throw new Error('schedule needs positive startAt, halfLifeMs and budget');
      }
    }

    if (real) {
      // Real dataset: inputs and sample count come from the data itself.
      if (!real.features || !real.features.length) throw new Error('dataset has no rows');
      t.dataset = real.name || String(opts.dataset || 'custom');
      t.datasetTitle = real.title || t.dataset;
      t.datasetSource = real.source || '';
      t.featureNames = real.featureNames || null;
      t.inputs = real.features[0].length;
      t.samples = real.features.length;
      if (opts.standardize === false) {
        // Raw features (used by the tournament, where miners and scorers must
        // share one un-normalised feature space).
        t.X = real.features.map(function (r) { return r.slice(); });
      } else {
        var sd = standardise(real.features);
        t.featureStats = { mean: sd.mean, std: sd.std };
        t.X = sd.X;
      }
      t.y = real.labels.map(function (v) { return v ? 1 : 0; });
    } else {
      // Synthetic noisy-XOR (the default / demo task).
      t.inputs = opts.inputs || preset.inputs || 2;
      t.samples = opts.samples || preset.samples || DEFAULTS.samples;
      var rng = mulberry32(seedFrom('data:' + t.id));
      var X = [], y = [];
      for (var i = 0; i < t.samples; i++) {
        var x = new Array(t.inputs);
        for (var d = 0; d < t.inputs; d++) x[d] = rng() * 2 - 1;
        var label = ((x[0] > 0) !== (x[1] > 0)) ? 1 : 0;    // 2-D XOR of the first two features
        if (rng() < t.noise) label = 1 - label;             // flip some labels
        X.push(x); y.push(label);
      }
      t.X = X; t.y = y;
    }
    t.arch = archOf(t.inputs, t.layers);
    t.dim = dimOf(t.arch);
    return t;
  }

  // A random starting network for the task, seeded so genesis is reproducible.
  // Weights use Xavier-style scaling (1/sqrt(fan-in)) so deep nets don't start
  // saturated; biases start at 0.
  function randomWeights(task, seedStr) {
    var rng = mulberry32(seedFrom('init:' + task.id + ':' + (seedStr || '')));
    var arch = task.arch, w = [], li;
    for (li = 0; li < arch.length - 1; li++) {
      var inN = arch[li], outN = arch[li + 1], scale = 1 / Math.sqrt(inN);
      for (var o = 0; o < outN; o++) for (var inp = 0; inp < inN; inp++) w.push(gaussian(rng) * scale); // W row-major
      for (var b = 0; b < outN; b++) w.push(0);                                                          // biases
    }
    return quantise(w, task.quantum);
  }

  function quantise(w, q) {
    var out = new Array(w.length);
    for (var i = 0; i < w.length; i++) out[i] = Math.round(w[i] / q) * q;
    return out;
  }

  /* ======================================================================
   * The model: a general feedforward MLP — [inputs, ...hidden, 1], tanh on
   * hidden layers, sigmoid output, binary cross-entropy loss. Weight vector
   * layout, forward pass, loss, accuracy and a full-batch backprop trainer.
   * The flat weight vector stores, layer by layer, W row-major (out×in) then
   * the biases — so a 2→6→1 net has the exact same layout as the original.
   * ==================================================================== */
  function sigmoid(z) { return dsigmoid(z); } // deterministic

  // Slice the flat vector into per-layer { W:[out][in], b:[out], act }.
  function unpack(task, w) {
    var arch = task.arch, k = 0, layers = [], li, o, inp;
    for (li = 0; li < arch.length - 1; li++) {
      var inN = arch[li], outN = arch[li + 1], W = new Array(outN), b = new Array(outN);
      for (o = 0; o < outN; o++) { var row = new Array(inN); for (inp = 0; inp < inN; inp++) row[inp] = w[k++]; W[o] = row; }
      for (o = 0; o < outN; o++) b[o] = w[k++];
      layers.push({ W: W, b: b, inN: inN, outN: outN, act: li === arch.length - 2 ? 'sigmoid' : 'tanh' });
    }
    return layers;
  }

  // Forward pass for one sample; returns the class-1 probability and the
  // activation of every layer (acts[0] = input, acts[L] = [p]) for backprop.
  function forwardOne(layers, x) {
    var acts = [x], a = x, li, o, inp;
    for (li = 0; li < layers.length; li++) {
      var L = layers[li], out = new Array(L.outN);
      for (o = 0; o < L.outN; o++) {
        var s = L.b[o], row = L.W[o];
        for (inp = 0; inp < L.inN; inp++) s += row[inp] * a[inp];
        out[o] = L.act === 'sigmoid' ? dsigmoid(s) : dtanh(s);
      }
      acts.push(out); a = out;
    }
    return { p: a[0], acts: acts };
  }

  // The model's probability that point x belongs to class 1 (for visualising
  // the decision boundary, and handy in tests).
  function predict(task, w, x) { return forwardOne(unpack(task, w), x).p; }

  // Binary cross-entropy of one sample (clamped, deterministic). The single
  // source of truth for per-sample loss — reused by the prover so its transcript
  // mean equals this loss exactly.
  function sampleLoss(task, w, x, y) {
    var p = forwardOne(unpack(task, w), x).p;
    p = Math.min(1 - 1e-12, Math.max(1e-12, p));
    return -(y * dln(p) + (1 - y) * dln(1 - p));
  }

  // Average binary cross-entropy. Scores task.X by default, or any supplied
  // (Xs, ys) — e.g. a held-out batch for commit–reveal.
  function loss(task, w, Xs, ys) {
    Xs = Xs || task.X; ys = ys || task.y;
    var layers = unpack(task, w), n = Xs.length, sum = 0;
    for (var i = 0; i < n; i++) {
      var p = forwardOne(layers, Xs[i]).p;
      p = Math.min(1 - 1e-12, Math.max(1e-12, p));
      sum += -(ys[i] * dln(p) + (1 - ys[i]) * dln(1 - p));
    }
    return sum / n;
  }

  function accuracy(task, w, Xs, ys) {
    Xs = Xs || task.X; ys = ys || task.y;
    var layers = unpack(task, w), n = Xs.length, ok = 0;
    for (var i = 0; i < n; i++) {
      var pred = forwardOne(layers, Xs[i]).p >= 0.5 ? 1 : 0;
      if (pred === ys[i]) ok++;
    }
    return ok / n;
  }

  // Standardise raw feature rows with a task's stored (train-set) stats, so a
  // held-out batch is scored on exactly the scale the model was trained on.
  // Rows pass through unchanged for a synthetic task (no stats).
  function standardizeRows(task, rawRows) {
    if (!task.featureStats) return rawRows.map(function (r) { return r.slice(); });
    var m = task.featureStats.mean, s = task.featureStats.std;
    return rawRows.map(function (r) {
      var out = new Array(r.length);
      for (var d = 0; d < r.length; d++) out[d] = (r[d] - m[d]) / s[d];
      return out;
    });
  }

  // One full-batch gradient-descent step over all layers; returns a fresh
  // weight vector. Standard backprop: sigmoid+BCE gives dz = p − y at the
  // output, tanh' = (1 − a²) propagates it back through the hidden layers.
  function trainStep(task, w, lr) {
    var layers = unpack(task, w), n = task.samples, li, o, inp;
    var gW = [], gb = []; // zero-initialised gradient accumulators, same shape as W/b
    for (li = 0; li < layers.length; li++) {
      var Lz = layers[li], gWl = new Array(Lz.outN), gbl = new Array(Lz.outN);
      for (o = 0; o < Lz.outN; o++) { gWl[o] = new Array(Lz.inN).fill(0); gbl[o] = 0; }
      gW.push(gWl); gb.push(gbl);
    }
    for (var i = 0; i < n; i++) {
      var f = forwardOne(layers, task.X[i]), acts = f.acts;
      var delta = [acts[layers.length][0] - task.y[i]]; // dL/dz at the sigmoid output
      for (li = layers.length - 1; li >= 0; li--) {
        var L = layers[li], aPrev = acts[li];
        for (o = 0; o < L.outN; o++) {
          gb[li][o] += delta[o];
          var grow = gW[li][o];
          for (inp = 0; inp < L.inN; inp++) grow[inp] += delta[o] * aPrev[inp];
        }
        if (li > 0) {
          var nd = new Array(L.inN);
          for (inp = 0; inp < L.inN; inp++) {
            var acc = 0;
            for (o = 0; o < L.outN; o++) acc += L.W[o][inp] * delta[o];
            nd[inp] = acc * (1 - aPrev[inp] * aPrev[inp]); // tanh' of the previous layer's output
          }
          delta = nd;
        }
      }
    }
    var out = new Array(task.dim), k = 0;
    for (li = 0; li < layers.length; li++) {
      var Lo = layers[li];
      for (o = 0; o < Lo.outN; o++) for (inp = 0; inp < Lo.inN; inp++) out[k++] = Lo.W[o][inp] - lr * gW[li][o][inp] / n;
      for (o = 0; o < Lo.outN; o++) out[k++] = Lo.b[o] - lr * gb[li][o] / n;
    }
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

  /* ----------------------------------------------------------------------
   * MIND transfers — secp256k1-signed spends carried inside blocks. A block
   * pays its miner the coinbase reward, then applies its transfers in order;
   * the ledger (below) rejects any transfer that would overdraw the sender.
   * -------------------------------------------------------------------- */
  function txCanonical(tx) { return [tx.from, tx.to, tx.amount, tx.at, tx.nonce].join('|'); }
  function txId(tx) { return coin().sha256d(txCanonical(tx) + '|' + tx.pubKey + '|' + tx.sig); }

  // Sign a transfer of `amount` base units from the holder of privKey to `to`.
  // `at`/`nonce` are supplied (deterministic, so the ledger is fully testable);
  // (from, nonce) may be used only once on the chain, which stops replay.
  function signTransfer(opts) {
    var C = coin(), pub = C.getPublicKey(opts.privKey);
    var tx = {
      from: C.addressFromPublicKey(pub), to: String(opts.to),
      amount: Math.floor(opts.amount), at: Number(opts.at || 0),
      nonce: String(opts.nonce), pubKey: pub
    };
    tx.sig = C.sign(C.sha256(txCanonical(tx)), opts.privKey);
    tx.id = txId(tx);
    return tx;
  }

  // A transfer is well-formed iff addresses are valid and distinct, the amount
  // is a positive integer, the public key matches `from`, and the signature
  // verifies. (Sufficient balance is a ledger rule, checked when it's applied.)
  function verifyTransfer(tx) {
    var C = coin();
    if (!tx || typeof tx !== 'object') return false;
    if (!C.isValidAddress(tx.from) || !C.isValidAddress(tx.to) || tx.from === tx.to) return false;
    if (!Number.isInteger(tx.amount) || tx.amount <= 0) return false;
    if (!tx.pubKey || C.addressFromPublicKey(tx.pubKey) !== tx.from) return false;
    try { return C.verify(C.sha256(txCanonical(tx)), tx.sig, tx.pubKey); }
    catch (e) { return false; }
  }

  // Commitment to a block's transfers, folded into the block hash so the set of
  // spends is tamper-evident and signed by the miner along with everything else.
  function txsRoot(txs) { return coin().sha256((txs || []).map(function (t) { return t.id; }).join('|')); }

  // The canonical, signature-covered, hash-linked string for a block. Field
  // order is fixed so every node hashes identical bytes. Excludes `sig`/`hash`.
  function canonical(b) {
    return [b.index, b.prevHash, b.taskId, b.weightsHash, b.loss.toFixed(9),
            b.reward, b.txsRoot, b.miner, b.pubKey, b.at, b.nonce].join('|');
  }
  function blockHash(b) { return coin().sha256d(canonical(b)); }

  /* ----------------------------------------------------------------------
   * The MIND ledger — positive balances derived by folding a chain: each
   * block credits the coinbase reward to its miner, then its transfers move
   * value between wallets. A transfer that would overdraw the sender, or
   * reuse a (from, nonce) pair, makes the whole block invalid (as in Bitcoin).
   * -------------------------------------------------------------------- */
  function emptyLedger() { return { bal: {}, used: {} }; }
  function cloneLedger(L) {
    var out = emptyLedger(), k;
    for (k in L.bal) if (L.bal.hasOwnProperty(k)) out.bal[k] = L.bal[k];
    for (k in L.used) if (L.used.hasOwnProperty(k)) out.used[k] = L.used[k];
    return out;
  }
  // Apply one block's economics to ledger `L` in place. Genesis mints nothing.
  function applyEconomics(L, block) {
    if (block.index === 0) return { ok: true };
    L.bal[block.miner] = (L.bal[block.miner] || 0) + block.reward; // coinbase
    var txs = block.txs || [];
    for (var i = 0; i < txs.length; i++) {
      var tx = txs[i], key = tx.from + '|' + tx.nonce;
      if (L.used[key]) return { ok: false, reason: 'duplicate transfer nonce' };
      if ((L.bal[tx.from] || 0) < tx.amount) return { ok: false, reason: 'overdraft: spending MIND that is not there' };
      L.used[key] = 1;
      L.bal[tx.from] -= tx.amount;
      L.bal[tx.to] = (L.bal[tx.to] || 0) + tx.amount;
    }
    return { ok: true };
  }

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
      reward: 0,        // genesis mints no MIND
      txs: [],
      txsRoot: txsRoot([]),
      miner: '',
      pubKey: '',
      at: Number(opts.at || 0),
      nonce: 'genesis'
    };
    genesis.sig = '';
    genesis.hash = blockHash(genesis);
    this.blocks = [genesis];
    this.baselineLoss = genesis.loss;
    this.ledger = emptyLedger(); // MIND balances, folded as blocks are added
  }

  function round9(x) { return Math.round(x * 1e9) / 1e9; }

  // The emission schedule's allowed loss at time `atMs` (consensus when the
  // task has a schedule): genesisLoss − budget·(1 − 2^(−Δt/halfLife)), built
  // only from IEEE ops + detExp so every node computes the identical double.
  Chain.prototype.allowedLoss = function (atMs) {
    var s = this.task.schedule;
    if (!s) return -Infinity;
    var dt = Number(atMs) - s.startAt;
    if (!(dt > 0)) return this.baselineLoss;
    var remaining = s.budget * dexp(-(dt / s.halfLifeMs) * LN2); // budget · 2^(−dt/H)
    return round9(this.baselineLoss - s.budget + remaining);
  };

  // Can a block be mined at `atMs`? Returns { open, need, allowed, waitMs }:
  // `need` is the loss a block must reach (tip − minImprovement), `allowed` the
  // schedule floor, `waitMs` how long until enough learning has accrued.
  // waitMs === Infinity means the schedule's budget is spent — the ceiling.
  Chain.prototype.mineWindow = function (atMs) {
    var tip = this.tip(), s = this.task.schedule;
    var need = round9(tip.loss - this.task.minImprovement);
    if (!s) return { open: true, need: need, allowed: -Infinity, waitMs: 0 };
    var at = Number(atMs);
    var allowed = this.allowedLoss(at);
    var prevAt = tip.index === 0 ? s.startAt : tip.at;
    var gate = prevAt + s.minIntervalMs - at; // min block interval
    if (allowed <= need) return { open: gate <= 0, need: need, allowed: allowed, waitMs: Math.max(0, gate) };
    // Not enough accrued yet: when does the schedule reach `need`?
    var frac = (need - (this.baselineLoss - s.budget)) / s.budget; // remaining fraction then
    if (!(frac > 0)) return { open: false, need: need, allowed: allowed, waitMs: Infinity }; // budget spent
    var when = s.startAt + (-s.halfLifeMs * (dln(frac) / LN2));
    return { open: false, need: need, allowed: allowed, waitMs: Math.max(gate, when - at) };
  };

  Chain.prototype.tip = function () { return this.blocks[this.blocks.length - 1]; };
  Chain.prototype.height = function () { return this.blocks.length - 1; };
  Chain.prototype.tipLoss = function () { return this.tip().loss; };
  Chain.prototype.tipWeights = function () { return this.tip().weights.slice(); };
  Chain.prototype.accuracy = function () { return accuracy(this.task, this.tip().weights); };
  // Total learning on this chain = how far loss has fallen from genesis. This is
  // the "cumulative work" the fork-choice rule maximises.
  Chain.prototype.cumulativeImprovement = function () { return round9(this.baselineLoss - this.tipLoss()); };

  // MIND ledger queries.
  Chain.prototype.balanceOf = function (addr) { return this.ledger.bal[addr] || 0; };
  Chain.prototype.totalSupply = function () {
    var s = 0, b = this.ledger.bal; for (var k in b) if (b.hasOwnProperty(k)) s += b[k]; return s;
  };

  // Train the tip's weights forward into a candidate block signed by `privKey`.
  // Keeps training (in rounds of `steps`) until the loss has dropped by at least
  // the task's minImprovement, up to `maxRounds`. Returns null if it can't beat
  // the tip (the model has effectively converged).
  Chain.prototype.mineBlock = function (opts) {
    var C = coin(), task = this.task, tip = this.tip();
    var pub = C.getPublicKey(opts.privKey);
    var miner = C.addressFromPublicKey(pub);
    var at = Number(opts.at || 0);
    var allowed = -Infinity;
    if (task.schedule) {
      if (!this.mineWindow(at).open) return null; // schedule: nothing accrued yet (or interval gate)
      allowed = this.allowedLoss(at);
    }
    var w = tip.weights.slice();
    var steps = opts.steps || 400, lr = opts.lr || 0.5;
    var need = tip.loss - task.minImprovement;
    var rounds = opts.maxRounds || 40, newLoss = tip.loss;
    var wPrev = w;
    for (var r = 0; r < rounds; r++) {
      wPrev = w;
      w = train(task, w, steps, lr);
      newLoss = round9(loss(task, w));
      if (opts.onRound) opts.onRound(r + 1, newLoss, need); // progress hook (mining-side only; consensus unaffected)
      if (newLoss <= need) break;
    }
    if (newLoss > need) return null; // couldn't learn enough — chain has converged
    if (newLoss < allowed) {
      // Trained PAST the schedule floor — the block would be "ahead of
      // schedule" and invalid. Pull back along the trained direction: bisect
      // the quantised interpolation between wPrev (loss > need, since the loop
      // breaks on the first round that clears it) and the overshooting w until
      // the loss lands inside [allowed, need].
      var lo = 0, hi = 1, found = null;
      for (var it = 0; it < 64 && found === null; it++) {
        var mid = (lo + hi) / 2, wm = new Array(w.length);
        for (var i2 = 0; i2 < w.length; i2++) wm[i2] = wPrev[i2] + mid * (w[i2] - wPrev[i2]);
        wm = quantise(wm, task.quantum);
        var lm = round9(loss(task, wm));
        if (lm > need) lo = mid;
        else if (lm < allowed) hi = mid;
        else found = { w: wm, loss: lm };
      }
      if (found === null) return null; // window narrower than the weight grid — accrue more and retry
      w = found.w; newLoss = found.loss;
    }
    var txs = (opts.txs || []).slice();
    var block = {
      index: tip.index + 1,
      prevHash: tip.hash,
      taskId: task.id,
      weights: w,
      weightsHash: weightsHash(task, w),
      loss: newLoss,
      reward: blockReward(task, tip.loss, newLoss), // MIND earned for this block's learning
      txs: txs,
      txsRoot: txsRoot(txs),
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
    // Emission schedule (when the task has one): a block may not be dated
    // before the minimum interval after its parent, and may not have learned
    // below the schedule's allowed loss at its own timestamp — compute cannot
    // buy MIND faster than the schedule releases it.
    if (task.schedule) {
      var prevAt = prev.index === 0 ? task.schedule.startAt : prev.at;
      if (!(block.at >= prevAt + task.schedule.minIntervalMs)) return { ok: false, reason: 'too soon after previous block' };
      if (block.loss < this.allowedLoss(block.at) - 1e-9) return { ok: false, reason: 'ahead of schedule' };
    }
    // Coinbase: the reward must be exactly what this block's learning earns.
    if (block.reward !== blockReward(task, prev.loss, block.loss)) return { ok: false, reason: 'wrong block reward' };
    // Transfers: well-formed set, committed to by txsRoot, no in-block nonce reuse.
    var txs = block.txs || [];
    if (!Array.isArray(txs)) return { ok: false, reason: 'bad transfer list' };
    if (block.txsRoot !== txsRoot(txs)) return { ok: false, reason: 'transfers root mismatch' };
    var seen = {};
    for (var t = 0; t < txs.length; t++) {
      if (!verifyTransfer(txs[t])) return { ok: false, reason: 'invalid transfer' };
      var nk = txs[t].from + '|' + txs[t].nonce;
      if (seen[nk]) return { ok: false, reason: 'duplicate transfer in block' };
      seen[nk] = 1;
    }
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
    var L = cloneLedger(this.ledger);       // apply to a copy, so a bad spend can't corrupt state
    var e = applyEconomics(L, block);
    if (!e.ok) throw new Error('rejected block: ' + e.reason);
    this.blocks.push(block);
    this.ledger = L;
    return true;
  };

  // Validate a whole candidate chain from genesis: returns { improvement, ledger }
  // (total learning + the resulting MIND balances) or null if any link — the
  // hash chain, the learning proof, a signature, the coinbase, or a spend — is
  // invalid. Used by fork choice.
  Chain.prototype.scoreChain = function (blocks) {
    if (!blocks || !blocks.length) return null;
    var g = blocks[0];
    if (g.index !== 0 || g.prevHash !== GENESIS_PREV || g.taskId !== this.task.id) return null;
    if (g.weightsHash !== weightsHash(this.task, g.weights) || g.hash !== blockHash(g)) return null;
    if (Math.abs(round9(loss(this.task, g.weights)) - g.loss) > 1e-9) return null;
    if (g.reward || (g.txs && g.txs.length) || g.txsRoot !== txsRoot(g.txs || [])) return null; // genesis mints nothing
    var L = emptyLedger();
    for (var i = 1; i < blocks.length; i++) {
      var v = this.isValidBlock(blocks[i], blocks[i - 1]);
      if (!v.ok) return null;
      var e = applyEconomics(L, blocks[i]);
      if (!e.ok) return null;
    }
    return { improvement: round9(g.loss - blocks[blocks.length - 1].loss), ledger: L };
  };

  // Fork choice: adopt `blocks` iff it is valid, shares our genesis, and has
  // learned strictly more than the chain we currently hold (the heaviest =
  // smartest chain wins). Returns true if we switched.
  Chain.prototype.replaceChain = function (blocks) {
    if (blocks[0] && this.blocks[0] && blocks[0].hash !== this.blocks[0].hash) return false; // different genesis
    var scored = this.scoreChain(blocks);
    if (scored == null) return false;
    if (scored.improvement <= this.cumulativeImprovement()) return false;
    this.blocks = blocks.slice();
    this.ledger = scored.ledger; // adopt the rival's balances along with its blocks
    return true;
  };

  return {
    version: '1.1.0',
    DEFAULTS: DEFAULTS, GENESIS_PREV: GENESIS_PREV,
    MIND: MIND, REWARD_PER_LOSS: REWARD_PER_LOSS, SCALES: SCALES,
    // task & data
    makeTask: makeTask, randomWeights: randomWeights, quantise: quantise,
    archOf: archOf, dimOf: dimOf,
    // model
    loss: loss, sampleLoss: sampleLoss, accuracy: accuracy, predict: predict, train: train, trainStep: trainStep,
    standardizeRows: standardizeRows,
    // deterministic transcendentals (fork-safety) — exact on every IEEE platform
    detExp: dexp, detLn: dln, detTanh: dtanh, detSigmoid: dsigmoid,
    // blocks
    weightsHash: weightsHash, canonical: canonical, blockHash: blockHash,
    // MIND token
    blockReward: blockReward, formatMind: formatMind,
    signTransfer: signTransfer, verifyTransfer: verifyTransfer, txId: txId, txsRoot: txsRoot,
    // chain
    Chain: Chain
  };
});
