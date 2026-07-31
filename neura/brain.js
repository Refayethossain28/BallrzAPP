/*
 * Neura Brain — the neural network that lives on the NEURA blockchain.
 *
 * Every block on the Neura chain must perform one verifiable training step of
 * this network ("Proof of Intelligence"): the miner advances the shared
 * weights by a deterministic SGD step whose mini-batch is derived from the
 * previous block's hash, and commits the hash of the resulting weights into
 * the block. Every node re-runs the same step to validate it, so the weights
 * are consensus state — the whole network agrees, block by block, on one
 * slowly-improving mind.
 *
 * Determinism is the load-bearing property. Two nodes on different machines
 * must produce bit-identical weights from the same chain, so this file only
 * ever uses operations IEEE 754 defines exactly (+, -, *, /, Math.sqrt,
 * Math.abs, Math.min, Math.max, comparisons) — never Math.exp / sin / tanh,
 * whose results are implementation-defined and could fork the chain between
 * browsers. Hence ReLU activations, a mean-squared-error loss, and a target
 * image built from distances (which need only sqrt). Randomness comes from
 * sfc32, a pure integer PRNG seeded from a hash.
 *
 * What the network learns: a tiny MLP f(x, y) → brightness is trained to
 * paint the Neura mark — a ring around the letter N — defined as an exact
 * signed-distance field. It's a genuinely learned image, not a lookup: at
 * genesis the canvas is noise, and every mined block sharpens it.
 *
 * UMD: exposes `self.NeuraBrain` in the browser and `module.exports` in the
 * Node test sandbox. Zero dependencies.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.NeuraBrain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ======================================================================
   * Architecture & training constants — consensus parameters. Changing any
   * of these is a hard fork: every node must run identical values.
   * ==================================================================== */
  var LAYERS = [2, 32, 32, 1];   // (x, y) → hidden → hidden → brightness
  var STEPS_PER_BLOCK = 16;      // SGD steps each block must perform
  var BATCH = 48;                // samples per step
  var LEARNING_RATE = 0.05;      // decays with steps taken — see trainStep
  var LR_DECAY = 8000;           // lr = LEARNING_RATE / (1 + steps/LR_DECAY)
  var EVAL_GRID = 32;            // evalLoss samples a fixed 32×32 grid

  /* ======================================================================
   * Deterministic PRNG — sfc32, pure uint32 arithmetic. Seeded from 32 hex
   * chars (e.g. a block hash), so "randomness" is agreed by consensus.
   * ==================================================================== */
  function prngFromHex(seedHex) {
    var s = String(seedHex);
    while (s.length < 32) s += '9e3779b97f4a7c15'; // pad short seeds
    var a = parseInt(s.slice(0, 8), 16) >>> 0;
    var b = parseInt(s.slice(8, 16), 16) >>> 0;
    var c = parseInt(s.slice(16, 24), 16) >>> 0;
    var d = parseInt(s.slice(24, 32), 16) >>> 0;
    function next() { // sfc32 core — returns uint32
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      var t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return t >>> 0;
    }
    for (var i = 0; i < 12; i++) next(); // scramble the seed in
    return {
      uint32: next,
      // Uniform in [0, 1): an exact power-of-two division, so bit-reproducible.
      float: function () { return next() / 4294967296; },
      // Uniform in [-1, 1).
      coord: function () { return next() / 2147483648 - 1; }
    };
  }

  /* ======================================================================
   * The target: the Neura mark as an exact signed-distance field.
   * A ring (the network's boundary) around the letter N (for Neura),
   * built from |·|, min, max and sqrt only.
   * ==================================================================== */
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    var qx = px - (ax + dx * t), qy = py - (ay + dy * t);
    return Math.sqrt(qx * qx + qy * qy);
  }

  /** Target brightness at (x, y) ∈ [-1, 1]² — 1 on the mark, 0 elsewhere. */
  function targetAt(x, y) {
    // Ring: |distance from centre − 0.80| within the stroke.
    var r = Math.sqrt(x * x + y * y);
    var d = Math.abs(r - 0.80);
    // Letter N: left post, diagonal, right post.
    d = Math.min(d, segDist(x, y, -0.34, -0.44, -0.34, 0.44));
    d = Math.min(d, segDist(x, y, -0.34, 0.44, 0.34, -0.44));
    d = Math.min(d, segDist(x, y, 0.34, -0.44, 0.34, 0.44));
    // Soft-edged stroke: brightness falls linearly across the edge band.
    var STROKE = 0.075, SOFT = 0.06;
    return Math.max(0, Math.min(1, 1 - (d - STROKE) / SOFT));
  }

  /* ======================================================================
   * The network — weights as flat Float64Arrays, forward/backward written
   * out longhand. brain = { w: [W1, b1, W2, b2, W3, b3], steps: n }
   * ==================================================================== */
  function initBrain(seedHex) {
    var rng = prngFromHex(seedHex);
    var w = [];
    for (var l = 0; l + 1 < LAYERS.length; l++) {
      var fanIn = LAYERS[l], fanOut = LAYERS[l + 1];
      var scale = Math.sqrt(6 / (fanIn + fanOut)); // Glorot-uniform
      var W = new Float64Array(fanIn * fanOut);
      for (var i = 0; i < W.length; i++) W[i] = (rng.float() * 2 - 1) * scale;
      w.push(W, new Float64Array(fanOut)); // biases start at zero
    }
    return { w: w, steps: 0 };
  }

  function clone(brain) {
    return { w: brain.w.map(function (a) { return new Float64Array(a); }), steps: brain.steps };
  }

  /** Forward pass for one point; keeps activations for backprop. */
  function forward(w, x, y) {
    var acts = [new Float64Array([x, y])];
    var input = acts[0];
    for (var l = 0; l < w.length; l += 2) {
      var W = w[l], b = w[l + 1], fanIn = input.length, fanOut = b.length;
      var out = new Float64Array(fanOut);
      for (var j = 0; j < fanOut; j++) {
        var sum = b[j];
        for (var i = 0; i < fanIn; i++) sum += input[i] * W[i * fanOut + j];
        // ReLU on hidden layers, linear output on the last.
        out[j] = (l + 2 < w.length) ? Math.max(0, sum) : sum;
      }
      acts.push(out);
      input = out;
    }
    return acts;
  }

  /**
   * One consensus training step: STEPS_PER_BLOCK mini-batch SGD updates on
   * batches drawn from the seeded PRNG. Mutates and returns `brain`.
   * The same (weights, seedHex) always yields bit-identical weights.
   */
  function trainStep(brain, seedHex) {
    var rng = prngFromHex(seedHex);
    var w = brain.w;
    for (var s = 0; s < STEPS_PER_BLOCK; s++) {
      // Accumulate gradients over the batch.
      var grads = w.map(function (a) { return new Float64Array(a.length); });
      for (var n = 0; n < BATCH; n++) {
        var x = rng.coord(), y = rng.coord();
        var t = targetAt(x, y);
        var acts = forward(w, x, y);
        var out = acts[acts.length - 1][0];
        // d(MSE)/d(out), MSE = (out − t)²  (per-sample; batch-averaged below)
        var delta = new Float64Array([2 * (out - t)]);
        for (var l = w.length - 2; l >= 0; l -= 2) {
          var input = acts[l / 2], hidden = acts[l / 2 + 1];
          var W = w[l], gW = grads[l], gB = grads[l + 1];
          var fanIn = input.length, fanOut = delta.length;
          var nextDelta = new Float64Array(fanIn);
          for (var j = 0; j < fanOut; j++) {
            var dj = delta[j];
            gB[j] += dj;
            for (var i = 0; i < fanIn; i++) {
              gW[i * fanOut + j] += input[i] * dj;
              nextDelta[i] += W[i * fanOut + j] * dj;
            }
          }
          if (l > 0) { // gate through the previous layer's ReLU
            for (var k = 0; k < fanIn; k++) if (input[k] <= 0) nextDelta[k] = 0;
          }
          delta = nextDelta;
        }
      }
      // Deterministic decay (division only): late blocks fine-tune rather
      // than overwrite what the chain has already learned.
      var lr = LEARNING_RATE / (1 + brain.steps / LR_DECAY) / BATCH;
      for (var g = 0; g < w.length; g++) {
        var wa = w[g], ga = grads[g];
        for (var p = 0; p < wa.length; p++) wa[p] -= lr * ga[p];
      }
      brain.steps++;
    }
    return brain;
  }

  /** Mean-squared error over a fixed EVAL_GRID×EVAL_GRID lattice. */
  function evalLoss(brain) {
    var sum = 0, N = EVAL_GRID;
    for (var iy = 0; iy < N; iy++) {
      for (var ix = 0; ix < N; ix++) {
        var x = (ix + 0.5) / N * 2 - 1, y = (iy + 0.5) / N * 2 - 1;
        var acts = forward(brain.w, x, y);
        var e = acts[acts.length - 1][0] - targetAt(x, y);
        sum += e * e;
      }
    }
    return sum / (N * N);
  }

  /** Render the brain's current picture as a size×size Float64Array in [0,1]. */
  function render(brain, size) {
    var img = new Float64Array(size * size);
    for (var iy = 0; iy < size; iy++) {
      for (var ix = 0; ix < size; ix++) {
        var x = (ix + 0.5) / size * 2 - 1, y = (iy + 0.5) / size * 2 - 1;
        var acts = forward(brain.w, x, y);
        img[iy * size + ix] = Math.max(0, Math.min(1, acts[acts.length - 1][0]));
      }
    }
    return img;
  }

  /** Render the target mark the same way, for side-by-side display. */
  function renderTarget(size) {
    var img = new Float64Array(size * size);
    for (var iy = 0; iy < size; iy++) {
      for (var ix = 0; ix < size; ix++) {
        var x = (ix + 0.5) / size * 2 - 1, y = (iy + 0.5) / size * 2 - 1;
        img[iy * size + ix] = targetAt(x, y);
      }
    }
    return img;
  }

  /* ======================================================================
   * Serialisation — the exact bytes that get hashed into blocks. Explicit
   * little-endian via DataView, so the hex is identical on every platform.
   * ==================================================================== */
  function serialize(brain) {
    var total = 0, i;
    for (i = 0; i < brain.w.length; i++) total += brain.w[i].length;
    var buf = new ArrayBuffer(4 + total * 8);
    var view = new DataView(buf);
    view.setUint32(0, brain.steps, true);
    var off = 4;
    for (i = 0; i < brain.w.length; i++) {
      var a = brain.w[i];
      for (var j = 0; j < a.length; j++) { view.setFloat64(off, a[j], true); off += 8; }
    }
    var bytes = new Uint8Array(buf), hex = '', HEXC = '0123456789abcdef';
    for (i = 0; i < bytes.length; i++) hex += HEXC[bytes[i] >> 4] + HEXC[bytes[i] & 15];
    return hex;
  }

  function deserialize(hex) {
    if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/.test(hex)) throw new Error('bad brain hex');
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    var view = new DataView(bytes.buffer);
    var brain = { w: [], steps: view.getUint32(0, true) };
    var off = 4;
    for (var l = 0; l + 1 < LAYERS.length; l++) {
      var W = new Float64Array(LAYERS[l] * LAYERS[l + 1]);
      var b = new Float64Array(LAYERS[l + 1]);
      for (var j = 0; j < W.length; j++) { W[j] = view.getFloat64(off, true); off += 8; }
      for (var k = 0; k < b.length; k++) { b[k] = view.getFloat64(off, true); off += 8; }
      brain.w.push(W, b);
    }
    if (off !== bytes.length) throw new Error('brain hex has wrong length');
    return brain;
  }

  /* ====================================================================== */
  return {
    version: '1.0.0',
    LAYERS: LAYERS,
    STEPS_PER_BLOCK: STEPS_PER_BLOCK,
    BATCH: BATCH,
    LEARNING_RATE: LEARNING_RATE,
    LR_DECAY: LR_DECAY,
    EVAL_GRID: EVAL_GRID,
    prngFromHex: prngFromHex,
    targetAt: targetAt,
    initBrain: initBrain,
    clone: clone,
    trainStep: trainStep,
    evalLoss: evalLoss,
    render: render,
    renderTarget: renderTarget,
    serialize: serialize,
    deserialize: deserialize
  };
});
