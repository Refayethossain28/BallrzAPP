/* Axon — your own neural network, built from raw math.
 * =====================================================================
 * Axon puts a real multi-layer perceptron in your pocket: you choose the
 * brain's shape, feed it patterns (built-in or dots you draw yourself),
 * and watch it learn — every forward pass, every gradient, every nudge of
 * every synapse happens HERE, in plain JavaScript, with no ML library and
 * no network. Everything is pure and deterministic: weights are born from
 * a seeded PRNG, shuffles are seeded per epoch, and the same seed + the
 * same data always grows the exact same mind — unit-tested (including a
 * numeric gradient check against the backprop) in
 * scripts/test-axon-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 * Plain arrays only (no typed arrays) so it runs in every sandbox.
 */
(function (root) {
  'use strict';

  /* ---------------- deterministic hashing / seeded randomness ---------------- */

  // FNV-1a 32-bit — stable across platforms, good spread for short strings.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // A deterministic stream of floats in [0,1) from any seed (mulberry32).
  function rng(seed) {
    var h = hashStr(String(seed));
    return function () {
      h = (h + 0x6D2B79F5) >>> 0;
      var t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Standard normal via Box–Muller, fed by a seeded stream.
  function gaussian(r) {
    var u = 1 - r(); // (0,1] so log never sees 0
    var v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---------------- text safety ---------------- */

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- what the network senses ---------------- */
  // Every example is a dot on the [-1,1]² canvas. 'xy' feeds the raw
  // coordinates; 'rich' adds the classic hand-crafted senses (x², y², x·y)
  // that let a small net see circles and saddles it would otherwise need
  // more neurons to bend into shape.
  var FEATURE_MODES = {
    xy:   { size: 2, label: 'raw (x, y)' },
    rich: { size: 5, label: 'extra senses (x², y², x·y)' }
  };

  function featurize(pt, mode) {
    var x = Number(pt.x) || 0, y = Number(pt.y) || 0;
    if (mode === 'rich') return [x, y, x * x, y * y, x * y];
    return [x, y];
  }

  /* ---------------- activations ---------------- */
  // f is the neuron's squash; df its derivative given both the pre-activation
  // z and the cached output a (whichever is cheaper for that function).
  var ACTS = {
    tanh:    { f: function (z) { return Math.tanh(z); },
               df: function (z, a) { return 1 - a * a; } },
    relu:    { f: function (z) { return z > 0 ? z : 0; },
               df: function (z) { return z > 0 ? 1 : 0; },
               gain: Math.SQRT2 },
    sigmoid: { f: function (z) { return 1 / (1 + Math.exp(-z)); },
               df: function (z, a) { return a * (1 - a); } }
  };

  /* ---------------- the network itself ---------------- */
  // Plain JSON-able object: sizes[0] is the sense count, sizes at the end is
  // always CLASSES (softmax head). weights[l][i][j] connects neuron j of
  // layer l to neuron i of layer l+1; vW/vb are momentum velocities (never
  // serialized — they're training scratch, not identity).
  var CLASSES = 3;

  function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }
  function zeroMat(rows, cols) { var m = []; for (var i = 0; i < rows; i++) m.push(zeros(cols)); return m; }

  function createNet(opts) {
    opts = opts || {};
    var features = FEATURE_MODES[opts.features] ? opts.features : 'xy';
    var activation = ACTS[opts.activation] ? opts.activation : 'tanh';
    var hidden = (opts.hidden && opts.hidden.length ? opts.hidden : [8]).map(function (n) {
      return Math.max(1, Math.min(32, n | 0));
    });
    var seed = String(opts.seed == null ? 'axon' : opts.seed);
    var sizes = [FEATURE_MODES[features].size].concat(hidden, [CLASSES]);
    var r = rng('axon-init:' + seed);
    var gain = ACTS[activation].gain || 1;
    var weights = [], biases = [];
    for (var l = 0; l < sizes.length - 1; l++) {
      var scale = gain / Math.sqrt(sizes[l]);
      var W = [];
      for (var i = 0; i < sizes[l + 1]; i++) {
        var row = [];
        for (var j = 0; j < sizes[l]; j++) row.push(gaussian(r) * scale);
        W.push(row);
      }
      weights.push(W);
      biases.push(zeros(sizes[l + 1]));
    }
    return {
      v: 1, sizes: sizes, features: features, activation: activation,
      seed: seed, epochs: 0,
      weights: weights, biases: biases,
      vW: weights.map(function (W) { return zeroMat(W.length, W[0].length); }),
      vb: biases.map(function (b) { return zeros(b.length); })
    };
  }

  function paramCount(net) {
    var n = 0;
    for (var l = 0; l < net.weights.length; l++) {
      n += net.weights[l].length * net.weights[l][0].length + net.biases[l].length;
    }
    return n;
  }

  function describe(net) {
    return net.sizes.join(' → ') + ' · ' + paramCount(net) + ' parameters';
  }

  function maxAbsW(net) {
    var m = 0;
    for (var l = 0; l < net.weights.length; l++) {
      for (var i = 0; i < net.weights[l].length; i++) {
        for (var j = 0; j < net.weights[l][i].length; j++) {
          var a = Math.abs(net.weights[l][i][j]);
          if (a > m) m = a;
        }
      }
    }
    return m;
  }

  /* ---------------- forward pass ---------------- */

  function softmax(z) {
    var m = -Infinity, i;
    for (i = 0; i < z.length; i++) if (z[i] > m) m = z[i];
    var sum = 0, out = [];
    for (i = 0; i < z.length; i++) { out.push(Math.exp(z[i] - m)); sum += out[i]; }
    for (i = 0; i < z.length; i++) out[i] /= sum;
    return out;
  }

  // Full trace: as[0] is the sense vector, as[last] the class probabilities.
  function forward(net, pt) {
    var act = ACTS[net.activation];
    var a = featurize(pt, net.features);
    var as = [a], zs = [];
    for (var l = 0; l < net.weights.length; l++) {
      var W = net.weights[l], b = net.biases[l], z = [];
      for (var i = 0; i < W.length; i++) {
        var s = b[i];
        for (var j = 0; j < a.length; j++) s += W[i][j] * a[j];
        z.push(s);
      }
      zs.push(z);
      a = l === net.weights.length - 1 ? softmax(z) : z.map(act.f);
      as.push(a);
    }
    return { as: as, zs: zs, probs: a };
  }

  function predict(net, pt) {
    var probs = forward(net, pt).probs;
    var k = 0;
    for (var i = 1; i < probs.length; i++) if (probs[i] > probs[k]) k = i;
    return { k: k, p: probs[k], probs: probs };
  }

  /* ---------------- loss & gradients (the actual calculus) ---------------- */
  var EPS_LOG = 1e-12;

  // Mean cross-entropy over a batch — the number training pushes downhill.
  function lossOf(net, points) {
    var sum = 0;
    for (var i = 0; i < points.length; i++) {
      var p = forward(net, points[i]).probs[points[i].k | 0] || 0;
      sum += -Math.log(Math.max(EPS_LOG, p));
    }
    return points.length ? sum / points.length : 0;
  }

  // Backprop over a batch: returns mean gradients plus the batch's loss and
  // hit count (measured BEFORE the update, i.e. honest training metrics).
  // Softmax + cross-entropy collapse to the famously clean delta = p − onehot.
  function backprop(net, points) {
    var act = ACTS[net.activation];
    var L = net.weights.length;
    var dW = net.weights.map(function (W) { return zeroMat(W.length, W[0].length); });
    var db = net.biases.map(function (b) { return zeros(b.length); });
    var loss = 0, correct = 0;
    for (var n = 0; n < points.length; n++) {
      var pt = points[n], y = pt.k | 0;
      var f = forward(net, pt);
      var probs = f.probs;
      loss += -Math.log(Math.max(EPS_LOG, probs[y] || 0));
      var best = 0;
      for (var c = 1; c < probs.length; c++) if (probs[c] > probs[best]) best = c;
      if (best === y) correct++;
      var delta = probs.slice();
      delta[y] -= 1;
      for (var l = L - 1; l >= 0; l--) {
        var aPrev = f.as[l];
        for (var i = 0; i < delta.length; i++) {
          db[l][i] += delta[i];
          for (var j = 0; j < aPrev.length; j++) dW[l][i][j] += delta[i] * aPrev[j];
        }
        if (l > 0) {
          var prev = zeros(net.sizes[l]);
          for (var jj = 0; jj < prev.length; jj++) {
            var s = 0;
            for (var ii = 0; ii < delta.length; ii++) s += net.weights[l][ii][jj] * delta[ii];
            prev[jj] = s * act.df(f.zs[l - 1][jj], f.as[l][jj]);
          }
          delta = prev;
        }
      }
    }
    var inv = points.length ? 1 / points.length : 0;
    for (var l2 = 0; l2 < L; l2++) {
      for (var i2 = 0; i2 < db[l2].length; i2++) {
        db[l2][i2] *= inv;
        for (var j2 = 0; j2 < dW[l2][i2].length; j2++) dW[l2][i2][j2] *= inv;
      }
    }
    return { dW: dW, db: db, loss: loss * inv, correct: correct };
  }

  // Momentum SGD, in place: v ← μv − η∇, w ← w + v.
  function applyGrads(net, grads, opts) {
    var lr = (opts && opts.lr) || 0.1;
    var mu = opts && opts.momentum != null ? opts.momentum : 0.9;
    for (var l = 0; l < net.weights.length; l++) {
      for (var i = 0; i < net.weights[l].length; i++) {
        net.vb[l][i] = mu * net.vb[l][i] - lr * grads.db[l][i];
        net.biases[l][i] += net.vb[l][i];
        for (var j = 0; j < net.weights[l][i].length; j++) {
          net.vW[l][i][j] = mu * net.vW[l][i][j] - lr * grads.dW[l][i][j];
          net.weights[l][i][j] += net.vW[l][i][j];
        }
      }
    }
  }

  // Can this data teach anything? (Custom drawn dots go through this.)
  function trainable(points) {
    if (!points || points.length < 4) return { ok: false, reason: 'Give it at least 4 dots to learn from.' };
    var seen = {}, kinds = 0;
    for (var i = 0; i < points.length; i++) {
      var k = points[i].k | 0;
      if (!seen[k]) { seen[k] = 1; kinds++; }
    }
    if (kinds < 2) return { ok: false, reason: 'It needs at least two different colours — one class is nothing to tell apart.' };
    return { ok: true };
  }

  // One full pass over the data in seeded mini-batches. Mutates the net,
  // bumps net.epochs, returns that pass's mean loss and accuracy.
  function trainEpoch(net, points, opts) {
    var check = trainable(points);
    if (!check.ok) return null;
    var batchSize = (opts && opts.batch) || 16;
    var idx = [], i;
    for (i = 0; i < points.length; i++) idx.push(i);
    var r = rng('axon-shuffle:' + net.seed + ':' + net.epochs);
    for (i = idx.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    var loss = 0, correct = 0;
    for (var start = 0; start < idx.length; start += batchSize) {
      var batch = [];
      for (i = start; i < Math.min(idx.length, start + batchSize); i++) batch.push(points[idx[i]]);
      var g = backprop(net, batch);
      loss += g.loss * batch.length;
      correct += g.correct;
      applyGrads(net, g, opts);
    }
    net.epochs++;
    return { loss: loss / points.length, accuracy: correct / points.length };
  }

  function evaluate(net, points) {
    var loss = 0, correct = 0;
    for (var i = 0; i < points.length; i++) {
      var pr = predict(net, points[i]);
      loss += -Math.log(Math.max(EPS_LOG, pr.probs[points[i].k | 0] || 0));
      if (pr.k === (points[i].k | 0)) correct++;
    }
    var n = points.length || 1;
    return { loss: loss / n, accuracy: correct / n, correct: correct, total: points.length };
  }

  /* ---------------- patterns to learn ---------------- */
  // Every generator is a pure function of (n, seed): same call, same dots.
  // All dots live in [-1,1]²; k is the class (0..2).
  var DATASETS = [
    { key: 'xor',    label: 'Checker',  emoji: '🏁', classes: 2, hint: 'Opposite corners agree — the classic pattern a single neuron can never learn.' },
    { key: 'rings',  label: 'Bullseye', emoji: '🎯', classes: 2, hint: 'An island inside a ring. No straight line can cut this — the net must learn a circle.' },
    { key: 'blobs',  label: 'Islands',  emoji: '🏝️', classes: 3, hint: 'Three clouds, three classes. The warm-up — even a tiny brain gets this.' },
    { key: 'waves',  label: 'Waves',    emoji: '🌊', classes: 2, hint: 'Above the wave or below it — the boundary itself is a curve.' },
    { key: 'spiral', label: 'Spiral',   emoji: '🌀', classes: 3, hint: 'Three arms wound together — the hardest pattern here. Give it a bigger brain and time.' }
  ];

  function makeDataset(kind, opts) {
    opts = opts || {};
    var n = Math.max(8, Math.min(400, opts.n || 120));
    var seed = String(opts.seed == null ? 'axon-data' : opts.seed);
    var r = rng('axon-' + kind + ':' + seed);
    var pts = [], i, t, a, rad;
    if (kind === 'rings') {
      for (i = 0; i < n; i++) {
        var inner = i % 2 === 0;
        a = r() * 2 * Math.PI;
        rad = inner ? 0.38 * Math.sqrt(r()) : 0.62 + 0.3 * r();
        pts.push({ x: rad * Math.cos(a), y: rad * Math.sin(a), k: inner ? 0 : 1 });
      }
    } else if (kind === 'blobs') {
      var centers = [[-0.55, -0.45], [0.6, -0.35], [0.02, 0.62]];
      for (i = 0; i < n; i++) {
        var c = i % 3;
        pts.push({
          x: clamp(centers[c][0] + gaussian(r) * 0.17, -1, 1),
          y: clamp(centers[c][1] + gaussian(r) * 0.17, -1, 1),
          k: c
        });
      }
    } else if (kind === 'waves') {
      for (i = 0; i < n; i++) {
        var wx = r() * 2 - 1;
        var crest = Math.sin(wx * 3.1) * 0.45;
        var above = i % 2 === 0;
        var off = 0.12 + 0.5 * r();
        pts.push({ x: wx, y: clamp(crest + (above ? off : -off), -1, 1), k: above ? 0 : 1 });
      }
    } else if (kind === 'spiral') {
      for (i = 0; i < n; i++) {
        var arm = i % 3;
        t = (Math.floor(i / 3) + 0.5) / Math.max(1, Math.ceil(n / 3));
        rad = 0.12 + 0.82 * t;
        a = t * 3.6 + arm * (2 * Math.PI / 3) + gaussian(r) * 0.05;
        pts.push({ x: clamp(rad * Math.cos(a), -1, 1), y: clamp(rad * Math.sin(a), -1, 1), k: arm });
      }
    } else { // 'xor' — the checkerboard
      for (i = 0; i < n; i++) {
        var qx = (r() * 2 - 1), qy = (r() * 2 - 1);
        // push dots off the axes so the pattern is honest, not a coin toss
        qx += qx >= 0 ? 0.08 : -0.08; qy += qy >= 0 ? 0.08 : -0.08;
        qx = clamp(qx, -1, 1); qy = clamp(qy, -1, 1);
        pts.push({ x: qx, y: qy, k: (qx >= 0) !== (qy >= 0) ? 1 : 0 });
      }
    }
    return pts;
  }

  /* ---------------- the decision map ---------------- */
  // The net's current opinion of every point on the canvas: res×res cells,
  // row-major from the TOP-LEFT (gy=0 is y=+1, matching canvas coordinates),
  // each with the winning class k and its confidence p.
  function decisionGrid(net, res) {
    res = Math.max(8, Math.min(128, res || 48));
    var k = [], p = [];
    for (var gy = 0; gy < res; gy++) {
      var y = 1 - 2 * (gy + 0.5) / res;
      for (var gx = 0; gx < res; gx++) {
        var x = -1 + 2 * (gx + 0.5) / res;
        var pr = predict(net, { x: x, y: y });
        k.push(pr.k);
        p.push(pr.p);
      }
    }
    return { res: res, k: k, p: p };
  }

  /* ---------------- identity: your network has a name ---------------- */
  var ADJ = ['Tiny', 'Brave', 'Curious', 'Sparky', 'Plucky', 'Quiet',
             'Swift', 'Bright', 'Mighty', 'Gentle', 'Dizzy', 'Lucky'];
  var MINDS = ['Lovelace', 'Turing', 'Hopper', 'Curie', 'Shannon', 'Babbage',
               'Hebb', 'Rosenblatt', 'McCulloch', 'Pitts', 'Boole', 'Bayes'];

  function netName(seed) {
    var h = hashStr('axon-name:' + String(seed));
    return ADJ[h % ADJ.length] + ' ' + MINDS[Math.floor(h / ADJ.length) % MINDS.length];
  }

  // One honest line about how the learning is going.
  function coachLine(stats) {
    if (!stats || !stats.epochs) return 'Fresh synapses — it hasn’t seen a single example yet. Press train.';
    var acc = stats.accuracy || 0;
    if (acc < 0.55) return 'Still guessing — coin-flip territory. Let it keep looking.';
    if (acc < 0.75) return 'Something’s clicking — it’s caught the rough shape.';
    if (acc < 0.9) return 'Learning fast now. The boundary is bending into place.';
    if (acc < 0.99) return 'Nearly there — just the awkward dots on the edges left.';
    return 'Learned it. Every dot lands on the right side — try a harder pattern.';
  }

  /* ---------------- saving the mind ---------------- */
  // Identity only (shape, senses, seed, learned weights) — momentum is scratch.
  function serialize(net) {
    return JSON.stringify({
      v: 1, sizes: net.sizes, features: net.features, activation: net.activation,
      seed: net.seed, epochs: net.epochs, weights: net.weights, biases: net.biases
    });
  }

  function deserialize(str) {
    var o;
    try { o = JSON.parse(str); } catch (e) { return { ok: false, reason: 'not JSON' }; }
    if (!o || o.v !== 1 || !FEATURE_MODES[o.features] || !ACTS[o.activation]) return { ok: false, reason: 'unknown format' };
    var sizes = o.sizes;
    if (!Array.isArray(sizes) || sizes.length < 2 ||
        sizes[0] !== FEATURE_MODES[o.features].size || sizes[sizes.length - 1] !== CLASSES) {
      return { ok: false, reason: 'bad shape' };
    }
    for (var s = 0; s < sizes.length; s++) {
      // every layer must hold at least one neuron — a zero-width layer would
      // leave empty weight matrices that blow up downstream
      if (typeof sizes[s] !== 'number' || sizes[s] !== Math.floor(sizes[s]) || sizes[s] < 1) {
        return { ok: false, reason: 'bad shape' };
      }
    }
    if (!Array.isArray(o.weights) || o.weights.length !== sizes.length - 1 ||
        !Array.isArray(o.biases) || o.biases.length !== sizes.length - 1) {
      return { ok: false, reason: 'bad shape' };
    }
    for (var l = 0; l < o.weights.length; l++) {
      var W = o.weights[l], b = o.biases[l];
      if (!Array.isArray(W) || W.length !== sizes[l + 1] || !Array.isArray(b) || b.length !== sizes[l + 1]) return { ok: false, reason: 'bad shape' };
      for (var i = 0; i < W.length; i++) {
        if (!Array.isArray(W[i]) || W[i].length !== sizes[l]) return { ok: false, reason: 'bad shape' };
        if (!isFiniteNum(b[i])) return { ok: false, reason: 'bad number' };
        for (var j = 0; j < W[i].length; j++) if (!isFiniteNum(W[i][j])) return { ok: false, reason: 'bad number' };
      }
    }
    return {
      ok: true,
      net: {
        v: 1, sizes: sizes.slice(), features: o.features, activation: o.activation,
        seed: String(o.seed == null ? 'axon' : o.seed),
        epochs: Math.max(0, o.epochs | 0),
        weights: o.weights, biases: o.biases,
        vW: o.weights.map(function (W) { return zeroMat(W.length, W[0].length); }),
        vb: o.biases.map(function (b) { return zeros(b.length); })
      }
    };
  }

  function isFiniteNum(x) { return typeof x === 'number' && isFinite(x); }

  /* ---------------- little formatters ---------------- */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function fmtPct(p) { return Math.round(clamp(p || 0, 0, 1) * 100) + '%'; }
  function fmtLoss(l) { return (isFiniteNum(l) ? l : 0).toFixed(3); }
  function fmtEpochs(n) {
    n = n || 0;
    if (n < 1000) return String(n);
    return (Math.floor(n / 100) / 10) + 'k';
  }

  var E = {
    CLASSES: CLASSES, DATASETS: DATASETS, FEATURE_MODES: FEATURE_MODES,
    hashStr: hashStr, rng: rng, gaussian: gaussian, escapeHTML: escapeHTML,
    featurize: featurize,
    createNet: createNet, paramCount: paramCount, describe: describe, maxAbsW: maxAbsW,
    softmax: softmax, forward: forward, predict: predict,
    lossOf: lossOf, backprop: backprop, applyGrads: applyGrads,
    trainable: trainable, trainEpoch: trainEpoch, evaluate: evaluate,
    makeDataset: makeDataset, decisionGrid: decisionGrid,
    netName: netName, coachLine: coachLine,
    serialize: serialize, deserialize: deserialize,
    clamp: clamp, fmtPct: fmtPct, fmtLoss: fmtLoss, fmtEpochs: fmtEpochs
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.AxonEngine = E;
})(typeof self !== 'undefined' ? self : this);
