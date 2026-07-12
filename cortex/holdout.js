/**
 * Cortex commit–reveal — rewarding generalisation, not memorisation.
 * ==================================================================
 *
 * Cortex's base reward tracks *training* loss, so on real data a miner is paid
 * for fitting the data it can see — and with a finite, fully-public dataset you
 * literally cannot tell a model that generalised from one that memorised every
 * row. Measuring generalisation needs data the miner has NOT seen. This module
 * adds that, via commit–reveal:
 *
 *   1. SEAL (once, by the task author).  A slice of the data is withheld from
 *      the chain and split into test batches T₁…T_k. Only a *hiding commitment*
 *      to each batch — H(salt_i ‖ batch_i) — is published (e.g. in genesis).
 *      The salts and batches themselves stay secret with the author.
 *   2. COMMIT (by the miner).  The miner trains on the public train set and
 *      publishes H(weights) — binding itself to a specific model — BEFORE the
 *      batch for this height is revealed.
 *   3. REVEAL (by the author).  Salt and batch T_N are published. Anyone checks
 *      H(salt ‖ batch) equals the committed value (so the batch is authentic,
 *      not cherry-picked), then recomputes the committed model's loss on T_N.
 *      Reward = how much it beats the parent model on that fresh, unseen batch.
 *
 * Because the weights were committed before T_N was revealed, a miner cannot
 * tune to the test data; a memoriser of the train set gains nothing on T_N.
 * Only genuine generalisation earns MIND.
 *
 * ── THE TRUST MODEL (read this) ──────────────────────────────────────────────
 * This is NOT trustless. It rests on a party who prepares and withholds the
 * sealed batches and reveals them honestly, in order, without leaking them or
 * training on them. That is a real trust assumption — the price of measuring
 * generalisation at all, since anything validators can recompute, miners can
 * see. It also yields only k honest blocks (one per sealed batch): fresh test
 * data is a consumable resource. Cortex's base layer keeps its "pure math,
 * anyone can verify" property; this layer trades some of it for a guarantee the
 * base layer cannot give. Use it where a trusted data provider is acceptable.
 *
 * Dependency-free UMD. Reuses BallrzCoin (hashing) and BallrzCortex (the model:
 * loss/standardiseRows/blockReward). Loaded the usual way.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzCortexHoldout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function g() { return (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this; }
  function coin() { var c = g() && g().BallrzCoin; if (c) return c; throw new Error('coin/engine.js must be loaded before holdout.js'); }
  function cortex() { var c = g() && g().BallrzCortex; if (c) return c; throw new Error('cortex/engine.js must be loaded before holdout.js'); }

  // Deterministic PRNG seeded from a string (mulberry32 over SHA-256), so a
  // prepared holdout is reproducible from its seed.
  function rngFrom(str) {
    var s = (parseInt(coin().sha256(String(str)).slice(0, 8), 16) >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function permutation(n, seed) {
    var idx = new Array(n), i, j, tmp; for (i = 0; i < n; i++) idx[i] = i;
    var rnd = rngFrom(seed);
    for (i = n - 1; i > 0; i--) { j = Math.floor(rnd() * (i + 1)); tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; }
    return idx;
  }

  // Canonical bytes for a batch, and the hiding commitment over it.
  function canonBatch(features, labels) {
    return features.map(function (r) { return r.join(','); }).join(';') + '||' + labels.join(',');
  }
  function commit(salt, features, labels) {
    return coin().sha256(String(salt) + '|' + canonBatch(features, labels));
  }
  function verifyReveal(commitment, salt, features, labels) {
    return commitment === commit(salt, features, labels);
  }

  // Commitment to a set of weights — the miner binds to one model before reveal.
  function commitWeights(w) {
    return coin().sha256(w.map(function (x) { return Number(x).toFixed(9); }).join(','));
  }

  // Split raw data into a public train set and k sealed test batches. The
  // returned `commitments` are PUBLIC (publish them at genesis); `sealed`
  // (batches + salts) is the SECRET the author withholds until each reveal.
  //   opts: { features, labels, testFraction=0.3, batches=1, seed }
  function prepareHoldout(opts) {
    var features = opts.features, labels = opts.labels;
    var n = features.length, testFraction = opts.testFraction == null ? 0.3 : opts.testFraction;
    var k = Math.max(1, opts.batches || 1), seed = String(opts.seed || 'holdout');
    var idx = permutation(n, 'split:' + seed);
    var nTest = Math.floor(n * testFraction);
    var testIdx = idx.slice(0, nTest), trainIdx = idx.slice(nTest);
    var train = { features: trainIdx.map(function (i) { return features[i]; }), labels: trainIdx.map(function (i) { return labels[i]; }) };
    var sealed = [], commitments = [], per = Math.floor(nTest / k) || 1, b;
    for (b = 0; b < k; b++) {
      var start = b * per, end = b === k - 1 ? nTest : start + per;
      var bi = testIdx.slice(start, end);
      var bf = bi.map(function (i) { return features[i]; }), bl = bi.map(function (i) { return labels[i]; });
      var salt = coin().sha256(seed + ':salt:' + b);
      var c = commit(salt, bf, bl);
      sealed.push({ index: b, features: bf, labels: bl, salt: salt, commit: c });
      commitments.push(c);
    }
    return { train: train, sealed: sealed, commitments: commitments, testFraction: testFraction, batches: k };
  }

  // Settle one commit–reveal round. Verifies both commitments, then scores the
  // committed model against the parent on the freshly revealed batch.
  //   opts: { task, parentWeights, weights, weightsCommitment,
  //           batchCommitment, reveal: { salt, features, labels } }
  // Returns { ok, reason, baseLoss, testLoss, testAccuracy, improvement, reward }.
  // `reward` is in MIND base units (improvement × REWARD_PER_LOSS), ≥ 0.
  function settle(opts) {
    var X = cortex(), r = opts.reveal;
    // (1) the miner must not have changed its weights after committing
    if (opts.weightsCommitment !== commitWeights(opts.weights)) return { ok: false, reason: 'weights do not match the commitment' };
    // (2) the revealed batch must be the one committed up front (authentic, not cherry-picked)
    if (!verifyReveal(opts.batchCommitment, r.salt, r.features, r.labels)) return { ok: false, reason: 'revealed batch does not match its commitment' };
    // (3) score both models on the unseen batch, standardised on the train stats
    var Z = X.standardizeRows(opts.task, r.features), y = r.labels.map(function (v) { return v ? 1 : 0; });
    var testLoss = round9(X.loss(opts.task, opts.weights, Z, y));
    var baseLoss = round9(X.loss(opts.task, opts.parentWeights, Z, y));
    var testAcc = X.accuracy(opts.task, opts.weights, Z, y);
    var improvement = Math.max(0, round9(baseLoss - testLoss));
    var reward = Math.max(0, Math.round(improvement * X.REWARD_PER_LOSS));
    return { ok: true, baseLoss: baseLoss, testLoss: testLoss, testAccuracy: testAcc, improvement: improvement, reward: reward };
  }

  function round9(x) { return Math.round(x * 1e9) / 1e9; }

  /* ----------------------------------------------------------------------
   * Beacon-driven reveal — removing the revealer's discretion.
   * ----------------------------------------------------------------------
   * Plain settle() lets the author choose which sealed batch to reveal. A
   * BEACON — an unpredictable value fixed only AFTER the miner commits, e.g. a
   * future block hash — takes that choice away: the batch index is derived from
   * the beacon, so the author can only reveal the batch the beacon names (and
   * the commitment check forces it to be the authentic one). This removes two
   * trust needs — cherry-picking an easy batch, and reordering/replaying
   * reveals — and, because the beacon postdates the commit, stops a miner
   * precomputing against a known challenge.
   *
   * What it does NOT remove: someone still has to WITHHOLD the sealed data and
   * not leak it or train on it. A beacon cannot conjure unseen data out of a
   * public dataset, so this narrows the trust surface — it does not reach
   * trustlessness. Fully trustless generalisation would need a live external
   * data feed the beacon draws fresh samples from, which a fixed dataset can't
   * be. The temporal ordering (beacon fixed after commit) is a network-protocol
   * assumption; the checkable cryptography is here.
   * ==================================================================== */
  function beaconSelect(beacon, k) {
    // 8 hex chars = 32 bits, exact as a JS integer, so the low bits `% k` needs
    // are preserved (a wider slice overflows 2^53 and biases the result to 0).
    return (parseInt(coin().sha256('beacon:' + String(beacon)).slice(0, 8), 16) >>> 0) % k;
  }

  // Like settle(), but the scored batch is chosen by the beacon rather than by
  // the caller: the reveal must be for commitments[beaconSelect(beacon, k)].
  // Revealing any other batch — even an authentic one — fails the commitment
  // check inside settle(). Adds `batchIndex` to the result.
  function settleWithBeacon(opts) {
    var k = opts.commitments.length;
    if (!k) return { ok: false, reason: 'no sealed commitments' };
    var idx = beaconSelect(opts.beacon, k);
    var res = settle({
      task: opts.task, parentWeights: opts.parentWeights, weights: opts.weights,
      weightsCommitment: opts.weightsCommitment, batchCommitment: opts.commitments[idx],
      reveal: opts.reveal
    });
    res.batchIndex = idx;
    return res;
  }

  return {
    version: '1.1.0',
    canonBatch: canonBatch, commit: commit, verifyReveal: verifyReveal,
    commitWeights: commitWeights, prepareHoldout: prepareHoldout, settle: settle,
    beaconSelect: beaconSelect, settleWithBeacon: settleWithBeacon
  };
});
