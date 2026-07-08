/**
 * Cortex scoring proofs — cutting the cost of verifying a score (phase 5).
 * ========================================================================
 *
 * Every layer so far makes each validator re-run the model on ALL samples to
 * check a claimed loss: M forward passes per entry, per round. Phase 5's goal
 * is to let a validator be convinced a score is right WITHOUT redoing all M.
 *
 * ── What this is (and isn't) ────────────────────────────────────────────────
 * A true *succinct* proof (verify in O(1)/O(log)) means a zk-SNARK of neural-
 * network inference — heavy, library-dependent, and open research. It does not
 * belong in a from-scratch, dependency-free repo, and claiming otherwise would
 * be dishonest. What IS buildable here, and genuinely cuts the expensive work,
 * is a COMMITTED TRANSCRIPT + SPOT-CHECK + FRAUD-PROOF scheme:
 *
 *   1. The scorer computes a per-sample loss ℓ_i for every sample, commits the
 *      whole transcript in one Merkle root R, and publishes (loss, R).
 *   2. A beacon (unpredictable at commit time) selects k ≪ M sample indices.
 *   3. The scorer reveals the leaves; a verifier (a) recomputes R from them
 *      (transcript integrity, O(M) hashing — cheap), (b) checks loss == mean of
 *      the leaves (aggregation, O(M) adds — cheap), and (c) RE-RUNS THE MODEL on
 *      only the k sampled indices, checking each matches its leaf.
 *
 * Validator cost drops from M forward passes to **k forward passes** (plus cheap
 * O(M) hashing/adds). Soundness is PROBABILISTIC, not cryptographic: to claim a
 * false loss the scorer must publish corrupted leaves, and a spot-check catches
 * a fraction-f corruption with probability 1−(1−f)^k. Because a leaf's loss is
 * bounded, moving the aggregate by Δ forces f ≳ Δ/range corrupted leaves, so a
 * reward-relevant lie is caught with high probability; a single caught mismatch
 * is a fraud proof that rejects (and, on a live chain, slashes) the scorer. Any
 * party may instead run the exact O(M) `verifyFull` as the authoritative check.
 *
 * Dependency-free UMD. Reuses BallrzCoin (sha256, merkleRoot) and BallrzCortex
 * (predict). Registers global BallrzCortexProver.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzCortexProver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function G() { return (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this; }
  function coin() { var c = G() && G().BallrzCoin; if (c) return c; throw new Error('coin/engine.js must be loaded first'); }
  function cortex() { var c = G() && G().BallrzCortex; if (c) return c; throw new Error('cortex/engine.js must be loaded first'); }

  function round9(x) { return Math.round(x * 1e9) / 1e9; }

  // Per-sample binary cross-entropy, clamped identically to engine.loss so the
  // mean of the transcript equals engine.loss exactly.
  function sampleLoss(spec, w, x, y) {
    var p = cortex().predict(spec, w, x);
    p = Math.min(1 - 1e-12, Math.max(1e-12, p));
    return round9(-(y * Math.log(p) + (1 - y) * Math.log(1 - p)));
  }

  function leafHash(i, loss) { return coin().sha256(i + '|' + Number(loss).toFixed(9)); }
  function rootOf(leaves) {
    var hashes = new Array(leaves.length);
    for (var i = 0; i < leaves.length; i++) hashes[i] = leafHash(i, leaves[i]);
    return coin().merkleRoot(hashes);
  }
  function meanOf(leaves) { var s = 0; for (var i = 0; i < leaves.length; i++) s += leaves[i]; return round9(s / leaves.length); }

  // Beacon-seeded selection of k distinct indices from n (partial Fisher–Yates).
  function sample(beacon, n, k) {
    var idx = new Array(n), i, j, tmp; for (i = 0; i < n; i++) idx[i] = i;
    var s = (parseInt(coin().sha256('score-sample:' + String(beacon)).slice(0, 8), 16) >>> 0) || 1;
    var rnd = function () { s = (s + 0x6D2B79F5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    var take = Math.min(k, n);
    for (i = 0; i < take; i++) { j = i + Math.floor(rnd() * (n - i)); tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; }
    return idx.slice(0, take).sort(function (a, b) { return a - b; });
  }

  // The scorer's job (the expensive step, done once): run the model on all
  // samples and commit the transcript. Returns { loss, leaves, root }.
  function scoreWithProof(spec, w, X, y) {
    var leaves = new Array(X.length);
    for (var i = 0; i < X.length; i++) leaves[i] = sampleLoss(spec, w, X[i], y[i]);
    return { loss: meanOf(leaves), leaves: leaves, root: rootOf(leaves), samples: X.length };
  }

  // Authoritative O(M) check — recompute everything (the fraud-proof path).
  function verifyFull(spec, w, X, y, proof) {
    if (!proof || !Array.isArray(proof.leaves) || proof.leaves.length !== X.length) return { ok: false, reason: 'transcript wrong length' };
    if (rootOf(proof.leaves) !== proof.root) return { ok: false, reason: 'transcript root mismatch' };
    for (var i = 0; i < X.length; i++) if (sampleLoss(spec, w, X[i], y[i]) !== proof.leaves[i]) return { ok: false, reason: 'leaf ' + i + ' is false' };
    if (meanOf(proof.leaves) !== proof.loss) return { ok: false, reason: 'claimed loss is not the transcript mean' };
    return { ok: true, checked: X.length };
  }

  // Cheap probabilistic check — O(M) hashing/adds + k forward passes.
  //   opts: { beacon, k }.  Returns { ok, reason, checked, soundness } where
  //   soundness(f) is the catch probability for a fraction-f leaf corruption.
  function verifySampled(spec, w, X, y, proof, opts) {
    opts = opts || {};
    var k = opts.k || 16;
    if (!proof || !Array.isArray(proof.leaves) || proof.leaves.length !== X.length) return { ok: false, reason: 'transcript wrong length' };
    if (rootOf(proof.leaves) !== proof.root) return { ok: false, reason: 'transcript root mismatch' };      // O(M) hash
    if (meanOf(proof.leaves) !== proof.loss) return { ok: false, reason: 'claimed loss is not the transcript mean' }; // O(M) add
    var idx = sample(opts.beacon == null ? 'default' : opts.beacon, X.length, k);
    for (var s = 0; s < idx.length; s++) {                                                                   // k forward passes
      var i = idx[s];
      if (sampleLoss(spec, w, X[i], y[i]) !== proof.leaves[i]) return { ok: false, reason: 'spot-check failed at leaf ' + i + ' (fraud proof)', fraudIndex: i };
    }
    return { ok: true, checked: idx.length, samples: X.length, soundness: function (f) { return round9(1 - Math.pow(1 - f, idx.length)); } };
  }

  // Catch probability for a corruption that shifts the mean loss by `delta`,
  // given per-leaf losses bounded by `range` (so ≥ delta/range fraction must be
  // corrupted). Honest statement of what k spot-checks buy you.
  function soundnessForMeanShift(k, delta, range) {
    var f = Math.min(1, Math.abs(delta) / (range || 1));
    return round9(1 - Math.pow(1 - f, k));
  }

  return {
    version: '1.0.0',
    sampleLoss: sampleLoss, leafHash: leafHash, rootOf: rootOf, meanOf: meanOf, sample: sample,
    scoreWithProof: scoreWithProof, verifyFull: verifyFull, verifySampled: verifySampled,
    soundnessForMeanShift: soundnessForMeanShift
  };
});
