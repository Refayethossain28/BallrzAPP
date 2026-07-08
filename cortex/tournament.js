/**
 * Cortex forecasting tournament — trust-MINIMISED generalisation rewards.
 * =======================================================================
 *
 * The fixed-dataset layers (engine.js, holdout.js) can measure generalisation
 * only by trusting someone to withhold data. This module implements the design
 * scoped in TRUSTLESS.md: score models on the *future*, so the future itself
 * withholds the labels and no miner can train on data that does not exist yet.
 *
 * A round runs OPEN → COMMIT → LOCK → RESOLVE → SCORE:
 *   OPEN     features for an event are published (outcome unknown).
 *   COMMIT   miners stake MIND and publish H(weights) — binding to a model
 *            BEFORE the outcome is known.
 *   LOCK     entries close.
 *   REVEAL   miners reveal weights; must match their commitment.
 *   RESOLVE  the realised label arrives, carried by a signed OUTCOME ORACLE
 *            attestation bound to the round's committed features.
 *   SCORE    each model's loss on (features, outcome) is recomputed; reward =
 *            predictive skill vs a base-rate baseline; anti-skill stake slashed.
 *
 * Phases from TRUSTLESS.md, all here:
 *   1  round state machine + feature commitment (offline-testable, no trust)
 *   2  skill-based reward + staking/slashing (reuses MIND; no trust)
 *   3  pluggable outcome oracle + a reference signed-feed adapter (TRUST ENTERS)
 *
 * ── TRUST (unchanged from the scoping study) ─────────────────────────────────
 * This is trust-MINIMISED, not trustless. It removes the data-withholding trust
 * but relocates trust to the OUTCOME ORACLE that reports realised labels. The
 * reference adapter here is a single signing key (`config.oraclePubKey`); a real
 * deployment would use a decentralised/threshold oracle and a dispute window. A
 * mock feed + oracle is included so the whole mechanism is exercised offline
 * with no real-world trust — that is what the tests drive.
 *
 * Dependency-free UMD. Reuses BallrzCoin (crypto), BallrzCortex (model:
 * makeTask/train/loss/predict/archOf/dimOf) and BallrzCortexHoldout
 * (commitWeights). Registers global BallrzCortexTournament.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzCortexTournament = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function G() { return (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this; }
  function coin() { var c = G() && G().BallrzCoin; if (c) return c; throw new Error('coin/engine.js must be loaded first'); }
  function cortex() { var c = G() && G().BallrzCortex; if (c) return c; throw new Error('cortex/engine.js must be loaded first'); }
  function holdout() { var c = G() && G().BallrzCortexHoldout; if (c) return c; throw new Error('cortex/holdout.js must be loaded first'); }

  function round9(x) { return Math.round(x * 1e9) / 1e9; }
  function mulberry32(seedStr) {
    var s = (parseInt(coin().sha256(String(seedStr)).slice(0, 8), 16) >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---- feature / label commitments ------------------------------------- */
  function featuresHashOf(features) { return coin().sha256(features.map(function (r) { return r.join(','); }).join(';')); }
  function labelsHashOf(labels) { return coin().sha256(labels.join(',')); }

  /* ---- Phase 3: the outcome oracle (reference: a single signing key) ----
   * An oracle attests that `labels` are the realised outcome for a round's
   * committed features. Anyone verifies the signature against the configured
   * oracle public key — so the label is as trustworthy as that key/quorum. */
  function signOutcome(oraclePrivKey, round, featuresHash, labels) {
    var C = coin(), lh = labelsHashOf(labels);
    var msg = C.sha256([round, featuresHash, lh].join('|'));
    return { round: round, featuresHash: featuresHash, labelsHash: lh, sig: C.sign(msg, oraclePrivKey), pubKey: C.getPublicKey(oraclePrivKey) };
  }
  function verifyOutcome(att, oraclePubKey, featuresHash, labels) {
    var C = coin();
    if (!att || att.featuresHash !== featuresHash) return false;
    if (att.labelsHash !== labelsHashOf(labels)) return false;
    if (att.pubKey !== oraclePubKey) return false;
    var msg = C.sha256([att.round, att.featuresHash, att.labelsHash].join('|'));
    try { return C.verify(msg, att.sig, att.pubKey); } catch (e) { return false; }
  }

  /* ---- model spec + a miner's training helper -------------------------- */
  function modelSpec(inputs, layers) {
    var X = cortex(), arch = X.archOf(inputs, layers);
    return { inputs: inputs, layers: layers.slice(), arch: arch, dim: X.dimOf(arch) };
  }
  // Train a model on resolved history — the PUBLIC past rounds. Uses the raw
  // (un-standardised) feature space so the weights score identically at SCORE.
  function trainOnHistory(spec, history, opts) {
    opts = opts || {};
    var X = cortex(), feats = [], labs = [];
    history.forEach(function (r) { r.features.forEach(function (row, i) { feats.push(row); labs.push(r.labels[i]); }); });
    if (!feats.length) return X.randomWeights({ arch: spec.arch, dim: spec.dim, id: 'empty' }, opts.seed || 'm');
    var task = X.makeTask({ id: opts.id || 'miner', data: { name: 'hist', features: feats, labels: labs }, layers: spec.layers, standardize: false });
    var w = X.randomWeights(task, opts.seed || 'm');
    return X.train(task, w, opts.steps || 800, opts.lr || 0.5);
  }

  /* ---- Phase 1+2: the tournament state machine ------------------------- */
  // config: { inputs, layers, stake, slashFraction=0.5, skillThreshold=0.01,
  //           rewardScale=REWARD_PER_LOSS, balances={addr:units},
  //   oracle (phase 3/4): oraclePubKey  — single-signer, OR
  //                       oracleCommittee:[pubKey…] + oracleThreshold:m (m-of-n),
  //   anti-abuse (phase 4): maxEntries=0 (unlimited), scoreSampleSize=0 (score
  //                       all), disputeBond=0 }
  function create(config) {
    var committee = config.oracleCommittee ? config.oracleCommittee.slice() : (config.oraclePubKey ? [config.oraclePubKey] : []);
    return {
      spec: modelSpec(config.inputs, config.layers),
      oracleCommittee: committee,
      oracleThreshold: config.oracleThreshold == null ? (committee.length ? 1 : 0) : config.oracleThreshold,
      stake: Math.floor(config.stake || 0),
      slashFraction: config.slashFraction == null ? 0.5 : config.slashFraction,
      // Noise dead-zone: skill within ±skillThreshold of the baseline earns and
      // loses nothing, so luck (a random model beating base-rate by chance) is
      // not paid and only genuine skill clears the bar.
      skillThreshold: config.skillThreshold == null ? 0.01 : config.skillThreshold,
      rewardScale: config.rewardScale || cortex().REWARD_PER_LOSS,
      maxEntries: config.maxEntries || 0,            // 0 = unlimited (phase 4 cap)
      scoreSampleSize: config.scoreSampleSize || 0,  // 0 = score all samples
      disputeBond: Math.floor(config.disputeBond || 0),
      balances: Object.assign({}, config.balances || {}),
      rounds: {},
      minted: 0, burned: 0
    };
  }

  // Phase 3/4 oracle: does `attestations` carry ≥ threshold valid, DISTINCT
  // committee members all attesting `labels` for this round's features?
  function committeeAgrees(T, featuresHash, labels, attestations) {
    var seen = {}, count = 0;
    (attestations || []).forEach(function (att) {
      if (!att || T.oracleCommittee.indexOf(att.pubKey) < 0 || seen[att.pubKey]) return;
      if (verifyOutcome(att, att.pubKey, featuresHash, labels)) { seen[att.pubKey] = 1; count++; }
    });
    return count >= T.oracleThreshold && T.oracleThreshold > 0;
  }
  function balanceOf(T, addr) { return T.balances[addr] || 0; }
  function roundOf(T, r) { var rs = T.rounds[r]; if (!rs) throw new Error('no such round: ' + r); return rs; }

  // OPEN: publish this round's features (outcome not yet known).
  function openRound(T, opts) {
    if (T.rounds[opts.round]) throw new Error('round already open: ' + opts.round);
    T.rounds[opts.round] = {
      round: opts.round, state: 'OPEN',
      features: opts.features, featuresHash: featuresHashOf(opts.features),
      entries: {}, order: [], outcome: null, results: null
    };
    return T.rounds[opts.round];
  }

  // COMMIT: stake MIND and bind to a model via H(weights), signed. Outcome unknown.
  function commitEntry(T, opts) {
    var C = coin(), rs = roundOf(T, opts.round);
    if (rs.state !== 'OPEN') throw new Error('round not open for entries');
    var pub = C.getPublicKey(opts.privKey), miner = C.addressFromPublicKey(pub);
    if (rs.entries[miner]) throw new Error('already entered this round');
    if (T.maxEntries && rs.order.length >= T.maxEntries) throw new Error('round is full (entry cap reached)');
    if (balanceOf(T, miner) < T.stake) throw new Error('insufficient MIND to stake');
    var wc = String(opts.weightsCommitment);
    var sig = C.sign(C.sha256([opts.round, wc, miner].join('|')), opts.privKey);
    T.balances[miner] = balanceOf(T, miner) - T.stake;               // stake → escrow
    rs.entries[miner] = { miner: miner, pubKey: pub, weightsCommitment: wc, stake: T.stake, sig: sig, weights: null, revealed: false };
    rs.order.push(miner);
    return rs.entries[miner];
  }

  function lockRound(T, r) { var rs = roundOf(T, r); if (rs.state !== 'OPEN') throw new Error('cannot lock'); rs.state = 'LOCK'; return rs; }

  // REVEAL: the weights must match the pre-outcome commitment (no post-hoc tuning).
  function revealEntry(T, opts) {
    var rs = roundOf(T, opts.round);
    if (rs.state !== 'LOCK') throw new Error('reveal only after lock, before resolve');
    var e = rs.entries[opts.miner]; if (!e) throw new Error('no entry for ' + opts.miner);
    if (holdout().commitWeights(opts.weights) !== e.weightsCommitment) throw new Error('weights do not match the commitment');
    e.weights = opts.weights.slice(); e.revealed = true;
    return e;
  }

  // RESOLVE (attested path): bring the realised label on-chain, verified by a
  // threshold of the oracle committee. Accepts a single `attestation` (1-of-1)
  // or an `attestations` array (m-of-n). For the optimistic path with disputes,
  // use proposeOutcome / disputeOutcome / finalizeOutcome instead.
  function resolveRound(T, opts) {
    var rs = roundOf(T, opts.round);
    if (rs.state !== 'LOCK') throw new Error('resolve only after lock');
    var atts = opts.attestations || (opts.attestation ? [opts.attestation] : []);
    if (!committeeAgrees(T, rs.featuresHash, opts.labels, atts)) throw new Error('outcome attestation invalid (needs threshold committee agreement)');
    rs.outcome = opts.labels.map(function (v) { return v ? 1 : 0; });
    rs.attestations = atts; rs.state = 'RESOLVE';
    return rs;
  }

  // Binary cross-entropy of always predicting the base rate — the skill baseline.
  function baselineLoss(labels) {
    var n = labels.length, p = 0, i; for (i = 0; i < n; i++) p += labels[i]; p /= n;
    p = Math.min(1 - 1e-12, Math.max(1e-12, p));
    return -(p * Math.log(p) + (1 - p) * Math.log(1 - p));
  }

  // SCORE: reward predictive skill on the realised outcome; slash anti-skill.
  // Skill = baselineLoss − modelLoss, judged against a ±skillThreshold dead zone:
  //   • skill >  +threshold  → mint round(skill×scale) MIND, return stake, share the pot
  //   • skill <  −threshold  → slash slashFraction of the stake (into the pot)
  //   • |skill| ≤ threshold   → neutral: stake returned, nothing minted or slashed
  //   • never revealed        → forfeit the whole stake (into the pot)
  // The pot (slashed + forfeited MIND) is redistributed to rewarded miners in
  // proportion to skill, or burned if there were none. Deterministic (entry order).
  function scoreRound(T, r, opts) {
    opts = opts || {};
    var X = cortex(), rs = roundOf(T, r), thr = T.skillThreshold;
    if (rs.state !== 'RESOLVE') throw new Error('round not resolved');
    // Phase 4: score every entry on the SAME beacon-selected subset of samples,
    // cutting validator cost. The beacon (unpredictable at commit) removes any
    // ability to target which samples get scored. Falls back to all samples.
    var Xs = rs.features, ys = rs.outcome;
    if (T.scoreSampleSize && T.scoreSampleSize < rs.features.length && opts.beacon != null) {
      var pick = beaconSample(opts.beacon, rs.features.length, T.scoreSampleSize);
      Xs = pick.map(function (i) { return rs.features[i]; });
      ys = pick.map(function (i) { return rs.outcome[i]; });
    }
    var base = round9(baselineLoss(ys)), results = [], pot = 0, totalPos = 0, i, m, e;
    for (i = 0; i < rs.order.length; i++) {
      m = rs.order[i]; e = rs.entries[m];
      if (!e.revealed) { pot += e.stake; results.push({ miner: m, status: 'forfeit', revealed: false, skill: null, reward: 0, returned: 0, slashed: e.stake }); continue; }
      var entryLoss = round9(X.loss(T.spec, e.weights, Xs, ys));
      var skill = round9(base - entryLoss);
      if (skill > thr) { totalPos += skill; results.push({ miner: m, status: 'reward', revealed: true, skill: skill, entryLoss: entryLoss, reward: 0, returned: e.stake, slashed: 0 }); }
      else if (skill < -thr) { var slash = Math.round(e.stake * T.slashFraction); pot += slash; results.push({ miner: m, status: 'slash', revealed: true, skill: skill, entryLoss: entryLoss, reward: 0, returned: e.stake - slash, slashed: slash }); }
      else { results.push({ miner: m, status: 'neutral', revealed: true, skill: skill, entryLoss: entryLoss, reward: 0, returned: e.stake, slashed: 0 }); }
    }
    var potLeft = pot;
    for (i = 0; i < results.length; i++) {
      var res = results[i];
      if (res.status === 'reward') {
        var minted = Math.round(res.skill * T.rewardScale);
        var bonus = totalPos > 0 ? Math.floor(pot * (res.skill / totalPos)) : 0;
        res.reward = minted; res.bonus = bonus; potLeft -= bonus;
        T.balances[res.miner] = balanceOf(T, res.miner) + res.returned + minted + bonus;
        T.minted += minted;
      } else {
        T.balances[res.miner] = balanceOf(T, res.miner) + res.returned;
      }
    }
    if (potLeft > 0 && totalPos === 0) { T.burned += potLeft; potLeft = 0; } // nobody earned it
    rs.state = 'SCORE'; rs.results = results; rs.baselineLoss = base;
    return { round: r, baselineLoss: base, results: results, scoredSamples: Xs.length, minted: results.reduce(function (s, x) { return s + x.reward + (x.bonus || 0); }, 0) };
  }

  // Beacon-seeded selection of `k` distinct sample indices out of `n` (partial
  // Fisher–Yates). Deterministic in the beacon; unpredictable before it exists.
  function beaconSample(beacon, n, k) {
    var idx = new Array(n), i, j, tmp; for (i = 0; i < n; i++) idx[i] = i;
    var rnd = mulberry32('sample:' + String(beacon));
    var take = Math.min(k, n);
    for (i = 0; i < take; i++) { j = i + Math.floor(rnd() * (n - i)); tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; }
    return idx.slice(0, take).sort(function (a, b) { return a - b; });
  }

  /* ---- Phase 4: optimistic resolution with a dispute window ------------
   * The attested resolveRound() needs the committee every round. The optimistic
   * path is cheaper and reduces trust further: ANYONE may propose an outcome
   * with a bond; if no one disputes within the window, it stands (the committee
   * is never troubled). If someone disputes (also bonded), the committee is the
   * backstop — its threshold attestation decides the truth, and the wrong side's
   * bond is slashed to the right side. Trust drops to "an honest party will
   * dispute a bad proposal, and the committee adjudicates honestly."
   *   proposeOutcome → (optional) disputeOutcome → finalizeOutcome → SCORE
   */
  function proposeOutcome(T, opts) {
    var C = coin(), rs = roundOf(T, opts.round);
    if (rs.state !== 'LOCK') throw new Error('propose only after lock');
    var pub = C.getPublicKey(opts.privKey), who = C.addressFromPublicKey(pub);
    var bond = Math.floor(opts.bond == null ? T.disputeBond : opts.bond);
    if (balanceOf(T, who) < bond) throw new Error('insufficient MIND to bond the proposal');
    T.balances[who] = balanceOf(T, who) - bond;
    rs.proposal = { who: who, labels: opts.labels.map(function (v) { return v ? 1 : 0; }), labelsHash: labelsHashOf(opts.labels.map(function (v) { return v ? 1 : 0; })), bond: bond };
    rs.state = 'PROPOSED';
    return rs.proposal;
  }
  function disputeOutcome(T, opts) {
    var C = coin(), rs = roundOf(T, opts.round);
    if (rs.state !== 'PROPOSED') throw new Error('nothing to dispute');
    var lab = opts.labels.map(function (v) { return v ? 1 : 0; });
    if (labelsHashOf(lab) === rs.proposal.labelsHash) throw new Error('dispute must differ from the proposal');
    var pub = C.getPublicKey(opts.privKey), who = C.addressFromPublicKey(pub);
    var bond = Math.floor(opts.bond == null ? T.disputeBond : opts.bond);
    if (balanceOf(T, who) < bond) throw new Error('insufficient MIND to bond the dispute');
    T.balances[who] = balanceOf(T, who) - bond;
    rs.dispute = { who: who, labels: lab, labelsHash: labelsHashOf(lab), bond: bond };
    rs.state = 'DISPUTED';
    return rs.dispute;
  }
  // Close the window. Undisputed: proposal stands, bond refunded. Disputed:
  // committee attestation (`labels`+`attestations`) is authoritative; the side
  // matching it is refunded and paid the loser's bond, the other is slashed.
  function finalizeOutcome(T, opts) {
    opts = opts || {};
    var rs = roundOf(T, opts.round);
    if (rs.state === 'PROPOSED') {
      T.balances[rs.proposal.who] = balanceOf(T, rs.proposal.who) + rs.proposal.bond; // refund
      rs.outcome = rs.proposal.labels; rs.resolution = 'undisputed'; rs.state = 'RESOLVE';
      return rs;
    }
    if (rs.state !== 'DISPUTED') throw new Error('no open proposal to finalize');
    if (!committeeAgrees(T, rs.featuresHash, opts.labels, opts.attestations)) throw new Error('dispute needs threshold committee agreement to settle');
    var truth = labelsHashOf(opts.labels.map(function (v) { return v ? 1 : 0; }));
    var p = rs.proposal, d = rs.dispute, pot = p.bond + d.bond;
    var winner = (p.labelsHash === truth) ? p.who : (d.labelsHash === truth) ? d.who : null;
    if (winner) { T.balances[winner] = balanceOf(T, winner) + pot; } // right side takes both bonds
    else { T.burned += pot; }                                        // neither matched: bonds burned
    rs.outcome = opts.labels.map(function (v) { return v ? 1 : 0; });
    rs.resolution = 'disputed'; rs.winner = winner; rs.state = 'RESOLVE';
    return rs;
  }

  /* ---- Phase 1: a mock feed + oracle, for offline end-to-end testing ----
   * Deterministic features; the label is a learnable function (2-D XOR of the
   * first two features, extra inputs are distractors) so a model trained on
   * resolved history genuinely predicts future rounds. The "future" outcome is
   * only produced by the oracle at resolve time. NOT for production — it is how
   * the mechanism is exercised without any real-world trust. */
  function mockFeed(opts) {
    opts = opts || {};
    var C = coin(), inputs = opts.inputs || 3, m = opts.samples || 60, noise = opts.noise == null ? 0.1 : opts.noise;
    var seed = String(opts.seed || 'feed');
    var oracle = C.walletFromPrivateKey(opts.oracleKey || '0000000000000000000000000000000000000000000000000000000000000007');
    function round(n) {
      var rng = mulberry32(seed + ':' + n), features = [], labels = [], i, d;
      for (i = 0; i < m; i++) {
        var row = new Array(inputs); for (d = 0; d < inputs; d++) row[d] = round9(rng() * 2 - 1);
        var label = ((row[0] > 0) !== (row[1] > 0)) ? 1 : 0;
        if (rng() < noise) label = 1 - label;
        features.push(row); labels.push(label);
      }
      return { round: n, features: features, labels: labels };
    }
    return { inputs: inputs, oracle: oracle, round: round };
  }

  return {
    version: '1.0.0',
    // oracle (Phase 3)
    signOutcome: signOutcome, verifyOutcome: verifyOutcome,
    featuresHashOf: featuresHashOf, labelsHashOf: labelsHashOf,
    // model + miner helper
    modelSpec: modelSpec, trainOnHistory: trainOnHistory,
    // tournament (Phase 1+2)
    create: create, balanceOf: balanceOf,
    openRound: openRound, commitEntry: commitEntry, lockRound: lockRound,
    revealEntry: revealEntry, resolveRound: resolveRound, scoreRound: scoreRound,
    baselineLoss: baselineLoss,
    // anti-abuse & governance (Phase 4)
    committeeAgrees: committeeAgrees, beaconSample: beaconSample,
    proposeOutcome: proposeOutcome, disputeOutcome: disputeOutcome, finalizeOutcome: finalizeOutcome,
    // offline harness (Phase 1)
    mockFeed: mockFeed
  };
});
