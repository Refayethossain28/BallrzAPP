/**
 * Helix — an online, non-stationary, fairness-aware decision engine.
 *
 * ONE engine that learns *which choice is best* from live feedback, adapts when
 * the world changes underneath it, and provably never starves an eligible
 * option. Pure, deterministic, dependency-free. Works in the browser
 * (window.Helix) and under Node require / vm for tests — same UMD pattern as
 * apexvip-core.js / apexvip-lib.js. Unit-tested in scripts/test-helix-logic.mjs.
 *
 * ── What problem it solves ────────────────────────────────────────────────
 * Any app here repeatedly picks from a set of options and *later* learns how
 * good the pick was:
 *   • apexvip — which driver to offer a ride (accept-rate, ETA, rating)
 *   • rentmatch — which listings to float to the top of a feed (tap / save)
 *   • cusp — which task to surface "right now" (did the user do it?)
 *   • trading — which signal/strategy to weight (hit-rate, drift)
 * A/B tests are slow and waste traffic on the losing arm. A naive "show the
 * best-so-far" greedily locks onto an early fluke and never recovers. Helix is
 * the principled middle: it explores just enough to stay correct, exploits the
 * rest of the time, forgets stale evidence, and guarantees fairness.
 *
 * ── The algorithm (why it is strong AND unique) ───────────────────────────
 * 1. DISCOUNTED THOMPSON SAMPLING (Beta-Bernoulli).
 *    Each arm keeps a Beta(α,β) belief over its success probability. To choose,
 *    we draw a sample θ from every candidate's posterior and rank by θ. Arms we
 *    know little about have wide posteriors → they occasionally sample high →
 *    they get tried. This is the Bayesian-optimal explore/exploit trade and has
 *    matching-lower-bound regret guarantees (Agrawal & Goyal, 2012).
 *
 * 2. EXPONENTIAL RECENCY DECAY (the "non-stationary" part).
 *    Real preferences drift — a driver gets tired, a market turns, a season
 *    changes. Before every update an arm's evidence is decayed by `decay`^Δ
 *    toward the prior, where Δ is rounds elapsed (lazy, O(1), no per-round
 *    sweep). decay = 1 is the classic stationary bandit; decay < 1 makes the
 *    engine forget at a controlled half-life so it re-learns after a shift.
 *
 * 3. STARVATION GUARANTEE (the "fairness" part — bandits normally lack this).
 *    Pure Thompson sampling can, by chance, ignore a viable option for a long
 *    time. Helix tracks staleness (rounds since last selected) and force-
 *    promotes any arm past `starvationBudget`. THEOREM: with a budget of B and
 *    k picks per round, every eligible arm is selected at least once every
 *    B + ⌈n/k⌉ rounds — a hard, testable upper bound on neglect. This makes the
 *    engine safe for things humans notice: driver income fairness, listing
 *    exposure, not burying a task forever.
 *
 * Reproducibility: all randomness flows through one seeded PRNG (mulberry32) →
 * Box–Muller normals → Marsaglia–Tsang Gamma → Beta draws. Same seed + same
 * feedback ⇒ identical decisions, so behavior is replayable and unit-testable.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Helix = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ───────────────────────── seeded randomness ───────────────────────── */

  // mulberry32: tiny, fast, well-distributed 32-bit PRNG. Deterministic from a
  // numeric seed so a run is fully replayable. The whole state is one 32-bit
  // int, exposed via .state()/.setState() so a live stream position can be
  // snapshotted and resumed bit-for-bit (not just re-seeded from scratch).
  function mulberry32(seed) {
    let a = seed >>> 0;
    const next = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.state = function () { return a >>> 0; };
    next.setState = function (s) { a = s >>> 0; };
    return next;
  }

  // Hash an arbitrary string seed to a 32-bit int (FNV-1a), so callers can seed
  // with a human-readable string and still get a stable stream.
  function hashSeed(s) {
    if (typeof s === 'number') return s >>> 0;
    s = String(s == null ? 'helix' : s);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // Standard normal via Box–Muller (one of the pair; good enough, simple).
  function normal(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();   // (0,1) — avoid log(0)
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Gamma(shape, 1) via Marsaglia–Tsang (2000). Handles shape < 1 by the boost
  // identity G(a) = G(a+1) · U^(1/a). Rejection loop is bounded in expectation.
  function gamma(shape, rng) {
    if (shape <= 0) return 0;
    if (shape < 1) return gamma(shape + 1, rng) * Math.pow(rng() || 1e-12, 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (let guard = 0; guard < 1000; guard++) {
      let x, v;
      do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = rng();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
    return d; // numerically unreachable; return the mode as a safe fallback
  }

  // Beta(a, b) draw = X / (X + Y), X~Gamma(a), Y~Gamma(b). The workhorse sample
  // for a Beta-Bernoulli posterior.
  function betaSample(a, b, rng) {
    const x = gamma(a, rng);
    const y = gamma(b, rng);
    const s = x + y;
    return s > 0 ? x / s : 0.5;
  }

  /* ───────────────────────────── the engine ──────────────────────────── */

  function Helix(options) {
    options = options || {};
    const cfg = {
      decay: clamp(num(options.decay, 1), 0, 1),                 // 1 = stationary
      priorAlpha: Math.max(1e-6, num(options.priorAlpha, 1)),    // Beta prior (1,1)=uniform
      priorBeta: Math.max(1e-6, num(options.priorBeta, 1)),      //   = optimistic-ish
      starvationBudget: posIntOrInf(options.starvationBudget),   // ∞ = fairness off
      seed: hashSeed(options.seed),
    };
    let rng = mulberry32(cfg.seed);

    // arms: id -> { meta, succ, fail, lastUpdate, lastSelect, pulls }
    //   succ/fail are evidence ABOVE the prior; effective α = prior+succ (decayed).
    const arms = new Map();
    let round = 0; // monotonic decision clock — drives decay Δ and staleness.

    function ensure(id, meta) {
      let a = arms.get(id);
      if (!a) {
        a = { meta: meta || null, succ: 0, fail: 0, lastUpdate: round, lastSelect: -Infinity, pulls: 0 };
        arms.set(id, a);
      } else if (meta !== undefined) {
        a.meta = meta;
      }
      return a;
    }

    // Lazily pull an arm's decayed evidence up to the current round. Decaying
    // succ/fail toward 0 means the *effective* posterior relaxes toward the
    // prior — i.e. the engine forgets old outcomes at rate `decay` per round.
    function decayed(a) {
      if (cfg.decay >= 1) return { succ: a.succ, fail: a.fail };
      const dt = round - a.lastUpdate;
      if (dt <= 0) return { succ: a.succ, fail: a.fail };
      const f = Math.pow(cfg.decay, dt);
      return { succ: a.succ * f, fail: a.fail * f };
    }

    function posterior(a) {
      const d = decayed(a);
      return { alpha: cfg.priorAlpha + d.succ, beta: cfg.priorBeta + d.fail };
    }

    /* ── public: register / inspect ── */

    // Register or update an arm (and its opaque metadata). Idempotent.
    function arm(id, meta) { ensure(id, meta); return api; }

    function has(id) { return arms.has(id); }

    function remove(id) { return arms.delete(id); }

    function ids() { return Array.from(arms.keys()); }

    // Full posterior summary for one arm — handy for dashboards/debugging.
    function stats(id) {
      const a = arms.get(id);
      if (!a) return null;
      const { alpha, beta } = posterior(a);
      const n = alpha + beta;
      const mean = alpha / n;
      // Variance of Beta(α,β); sd ≈ posterior uncertainty (shrinks with evidence).
      const variance = (alpha * beta) / (n * n * (n + 1));
      return {
        id,
        meta: a.meta,
        mean,
        sd: Math.sqrt(variance),
        alpha,
        beta,
        pulls: a.pulls,
        staleness: a.lastSelect === -Infinity ? Infinity : round - a.lastSelect,
        // 95%-ish normal-approx interval, clamped to [0,1] (Beta is bounded).
        ci: [clamp(mean - 1.96 * Math.sqrt(variance), 0, 1),
             clamp(mean + 1.96 * Math.sqrt(variance), 0, 1)],
      };
    }

    /* ── public: the core decision ── */

    // Rank candidates and return the top-k arm ids for this round.
    //   candidates : array of ids (defaults to all registered arms)
    //   k          : how many to pick (default 1)
    // Side effects: advances the round clock and records selections (for
    // staleness/fairness accounting). `score()` below is the no-side-effect peek.
    function select(candidates, k) {
      const picked = rank(candidates, k);
      round += 1;
      for (const id of picked) {
        const a = arms.get(id);
        if (a) { a.lastSelect = round; a.pulls += 1; }
      }
      return picked;
    }

    // Pure ranking with the fairness floor applied, WITHOUT advancing the clock
    // or recording selections. Useful for previews and tests.
    function rank(candidates, k) {
      const list = (candidates && candidates.length ? candidates : ids())
        .filter((id) => arms.has(id));
      k = Math.max(1, Math.min(num(k, 1), list.length));
      if (!list.length) return [];

      // 1) Fairness floor: any arm past its starvation budget is force-promoted,
      //    most-starved first. This is what makes the staleness bound provable.
      const starved = [];
      const fresh = [];
      for (const id of list) {
        const a = arms.get(id);
        const st = a.lastSelect === -Infinity ? Infinity : round - a.lastSelect;
        if (cfg.starvationBudget !== Infinity && st >= cfg.starvationBudget) starved.push([id, st]);
        else fresh.push(id);
      }
      starved.sort((p, q) => q[1] - p[1]); // longest-neglected first

      const out = [];
      for (const [id] of starved) { if (out.length >= k) break; out.push(id); }

      // 2) Thompson sampling fills the remaining slots: draw θ ~ posterior for
      //    each remaining candidate and take the highest draws.
      if (out.length < k) {
        const need = k - out.length;
        const draws = fresh.map((id) => {
          const { alpha, beta } = posterior(arms.get(id));
          return [id, betaSample(alpha, beta, rng)];
        });
        draws.sort((p, q) => q[1] - p[1]);
        for (let i = 0; i < need && i < draws.length; i++) out.push(draws[i][0]);
      }
      return out;
    }

    // Deterministic, exploration-free ranking by posterior mean (greedy). The
    // "what does the engine currently believe is best" view — no randomness.
    function score(candidates) {
      const list = (candidates && candidates.length ? candidates : ids()).filter((id) => arms.has(id));
      return list
        .map((id) => ({ id, mean: stats(id).mean }))
        .sort((p, q) => q.mean - p.mean);
    }

    // Convenience: single best pick (records selection, like select).
    function best(candidates) { return select(candidates, 1)[0]; }

    /* ── public: feedback ── */

    // Record an outcome for an arm. reward ∈ [0,1] (1 = success, 0 = failure;
    // fractional values are valid — they split credit, the standard Bernoulli
    // generalization). The arm's evidence is decayed to the current round first,
    // so older outcomes have already faded by the configured rate.
    function reward(id, value) {
      const a = ensure(id);
      const r = clamp(num(value, 0), 0, 1);
      const d = decayed(a);
      a.succ = d.succ + r;
      a.fail = d.fail + (1 - r);
      a.lastUpdate = round;
      return api;
    }

    // Sugar for the two common cases.
    function win(id) { return reward(id, 1); }
    function lose(id) { return reward(id, 0); }

    /* ── public: persistence ── */

    // Serialize full state (including RNG seed/round) so a learner can be
    // paused, stored (localStorage / Firestore), and resumed bit-for-bit.
    function snapshot() {
      const armsOut = {};
      for (const [id, a] of arms) {
        armsOut[id] = { meta: a.meta, succ: a.succ, fail: a.fail,
          lastUpdate: a.lastUpdate, lastSelect: a.lastSelect, pulls: a.pulls };
      }
      return { v: 1, cfg: { decay: cfg.decay, priorAlpha: cfg.priorAlpha,
        priorBeta: cfg.priorBeta, starvationBudget: cfg.starvationBudget, seed: cfg.seed },
        round, rngState: rng.state(), arms: armsOut };
    }

    // Restore from snapshot(). Re-seeds the RNG so replay is exact.
    function restore(snap) {
      if (!snap || snap.v !== 1) throw new Error('Helix.restore: unrecognized snapshot');
      cfg.decay = snap.cfg.decay; cfg.priorAlpha = snap.cfg.priorAlpha;
      cfg.priorBeta = snap.cfg.priorBeta;
      // Infinity does not survive JSON; treat null/absent as "fairness off".
      cfg.starvationBudget = posIntOrInf(snap.cfg.starvationBudget);
      cfg.seed = snap.cfg.seed;
      rng = mulberry32(cfg.seed);
      if (snap.rngState != null) rng.setState(snap.rngState); // resume the exact stream position
      round = snap.round; arms.clear();
      for (const id of Object.keys(snap.arms)) {
        const a = snap.arms[id];
        arms.set(id, { meta: a.meta, succ: a.succ, fail: a.fail,
          lastUpdate: a.lastUpdate, lastSelect: a.lastSelect, pulls: a.pulls });
      }
      return api;
    }

    function getRound() { return round; }
    function config() { return Object.assign({}, cfg); }

    const api = { arm, has, remove, ids, stats, select, rank, score, best,
      reward, win, lose, snapshot, restore, round: getRound, config };
    return api;
  }

  /* ───────────────────────────── helpers ─────────────────────────────── */

  function num(v, d) { v = Number(v); return Number.isFinite(v) ? v : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function posIntOrInf(v) {
    if (v == null || v === Infinity) return Infinity;
    v = Math.floor(Number(v));
    return Number.isFinite(v) && v >= 1 ? v : Infinity;
  }

  // Expose internals for unit testing / advanced use.
  Helix.mulberry32 = mulberry32;
  Helix.hashSeed = hashSeed;
  Helix.betaSample = betaSample;
  Helix.gamma = gamma;
  Helix.version = '1.0.0';

  return Helix;
});
