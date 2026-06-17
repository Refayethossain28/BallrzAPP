/**
 * Cusp — the Salience Engine
 * ==========================
 *
 * The proprietary algorithm at the heart of Cusp. Every other to-do app *lists*
 * your tasks; a calendar *schedules* fixed events. Neither one answers the
 * question you actually have a hundred times a day: of everything on my plate,
 * what should I do *right now*? Cusp answers it, and — crucially — it shows its
 * work, so the recommendation is auditable rather than a black box.
 *
 * The engine scores every eligible task as a single, time-varying **salience**
 * value built from six independent "fields". Each field is normalised to ~0..1
 * and they are combined with fixed, interpretable weights (see WEIGHTS). Nothing
 * here is random and nothing is learned behind your back: the same backlog +
 * the same moment always produces the same answer, and every point of that
 * answer can be traced back to a field. That determinism is what makes the
 * recommendation defensible — and what makes it unit-testable.
 *
 * The six fields
 * --------------
 *   I  Importance    how much you said this matters (1..5 → 0..1).
 *   U  Urgency       deadline *tightness* = effort needed ÷ time left, not just
 *                    "time left". A 3-hour task due in 4 hours outranks a 5-min
 *                    task due in 4 hours. Overdue ⇒ 1. No deadline ⇒ a gentle
 *                    floor so undated work never becomes invisible.
 *   E  Energy fit    match cognitive load to your current energy: deep work when
 *                    you're sharp, light work when you're fried. fit = 1−|load−energy|.
 *   W  Window fit    does it fit the minutes you actually have free? Quick wins
 *                    that slot into a small gap score high; a 2-hour task can't
 *                    win a 15-minute window — except a *deep* task gets partial
 *                    credit, because starting the big rock is worth something.
 *   M  Momentum      context-switching is expensive. Staying in the project you
 *                    just touched earns a bonus; jumping cold costs you.
 *   S  Staleness     a slow anti-rot nudge so nothing languishes forever, plus a
 *                    separate decision-hygiene flag for tasks you keep skipping.
 *
 * salience = wI·I + wU·U + wE·E + wW·W + wM·M + wS·S      (then ×100 for display)
 *
 * UMD so it runs in the browser (window.Cusp) and under Node/vm for tests —
 * same pattern as apexvip-lib.js. Pure, deterministic, framework-free.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Cusp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HOUR = 3600000, DAY = 86400000;

  // Field weights — sum to 1. Tuned so a tight deadline can dominate while
  // importance still carries the most weight among "calm" tasks.
  var WEIGHTS = { I: 0.22, U: 0.30, E: 0.18, W: 0.16, M: 0.08, S: 0.06 };

  // How far out a deadline still produces ordering pressure (beyond this, the
  // urgency field is essentially flat and importance/energy decide).
  var URGENCY_HORIZON_H = 14 * 24; // 14 days

  // Cognitive load buckets → a 0..1 demand on your attention.
  var LOADS = { light: 0.25, medium: 0.55, deep: 0.90 };

  var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
  var round = function (x, n) { var p = Math.pow(10, n || 0); return Math.round(x * p) / p; };

  function loadValue(load) {
    if (typeof load === 'number') return clamp01(load);
    return LOADS[load] != null ? LOADS[load] : LOADS.medium;
  }

  /**
   * Circadian energy default for a given local hour (0..23) → 0..1.
   * A smooth, defensible curve: a deep trough overnight, a morning climb to a
   * late-morning peak, the well-known early-afternoon dip, a smaller "second
   * wind", then an evening decline. This is the *default* only — the user can
   * override it with a single slider, and the override always wins. No hidden
   * learning, so the number on screen is always the number the engine used.
   */
  function circadianEnergy(hour) {
    var h = ((hour % 24) + 24) % 24;
    // Primary wake cycle peaking ~10:30, plus a gentle post-siesta bump ~17:00,
    // all gated by a night-time floor so 3am never looks like prime focus time.
    var main = Math.cos((h - 10.5) / 24 * 2 * Math.PI);        // -1..1, peak at 10.5
    var bump = 0.35 * Math.cos((h - 17) / 24 * 2 * Math.PI);   // small second wind
    var raw = 0.52 + 0.42 * main + 0.10 * bump;
    if (h < 6) raw *= 0.45 + 0.09 * h;   // hard floor through the small hours
    return round(clamp01(raw), 3);
  }

  /**
   * Eligible = not done, not currently snoozed (skipped a moment ago), and all
   * dependencies done. `now` is optional; omit it to ignore snoozes.
   */
  function isEligible(task, doneSet, now) {
    if (task.done) return false;
    if (now != null && task.snoozeUntil && task.snoozeUntil > now) return false;
    var deps = task.deps || [];
    for (var i = 0; i < deps.length; i++) if (!doneSet.has(deps[i])) return false;
    return true;
  }

  /** True when a task is rotting: chronically skipped or long-stale and untouched. */
  function rotRisk(task, now) {
    if (task.done) return false;
    var ageDays = (now - (task.createdAt || now)) / DAY;
    return (task.skips || 0) >= 3 || (ageDays >= 21 && (task.skips || 0) >= 1);
  }

  /**
   * Score the six fields for one task in a given context. Returns the raw field
   * values (0..1), the weighted salience (0..100), and human-readable reasons.
   *
   * ctx = { now, windowMin, energy (0..1), lastProject }
   */
  function score(task, ctx) {
    var now = ctx.now, windowMin = Math.max(1, ctx.windowMin || 30);
    var energy = ctx.energy != null ? clamp01(ctx.energy) : circadianEnergy(new Date(now).getHours());
    var effort = Math.max(1, task.effort || 30);          // minutes
    var load = loadValue(task.load);
    var reasons = [];

    // I — importance
    var I = clamp01((task.importance || 3) / 5);

    // U — urgency as deadline *tightness* (effort needed ÷ time left)
    var U;
    if (task.due == null) {
      U = 0.15; // undated floor: present, but it loses to anything with a clock
    } else {
      var hLeft = (task.due - now) / HOUR;
      if (hLeft <= 0) { U = 1; reasons.push('overdue'); }
      else {
        var requiredH = effort / 60;
        var tightness = requiredH / hLeft;                       // 1 ⇒ only just enough time
        var proximity = 0.12 * clamp01(1 - hLeft / URGENCY_HORIZON_H); // gentle "closer = nudge"
        U = clamp01(tightness + proximity);
        if (hLeft <= 24) reasons.push(hLeft <= 1 ? 'due within the hour'
                          : 'due in ' + Math.round(hLeft) + 'h');
        else if (tightness >= 0.5) reasons.push('not much slack left to finish it');
      }
    }

    // E — energy fit (load matched to current energy)
    var E = clamp01(1 - Math.abs(load - energy));
    if (E >= 0.8) reasons.push(load >= 0.8 ? 'you’re sharp enough for deep work'
                   : load <= 0.3 ? 'an easy win for your current energy'
                   : 'a good fit for your energy right now');
    else if (load - energy >= 0.35) reasons.push('heavy for your current energy');

    // W — window fit (does it fit the minutes you actually have?)
    var ratio = windowMin / effort;
    var W;
    if (ratio >= 1) { W = 1; reasons.push('fits your ' + windowMin + '-min window'); }
    else if (load >= 0.8) { W = clamp01(0.4 + 0.3 * ratio); reasons.push('won’t finish now, but worth starting'); }
    else { W = clamp01(ratio); }

    // M — momentum (context-switch cost)
    var M;
    if (!ctx.lastProject) M = 0.8;
    else if (task.project && task.project === ctx.lastProject) { M = 1; reasons.push('keeps you in “' + task.project + '”'); }
    else M = 0.6;

    // S — staleness (slow anti-rot nudge, capped)
    var ageDays = (now - (task.createdAt || now)) / DAY;
    var S = clamp01(ageDays / 14) * 0.5;

    var salience = WEIGHTS.I * I + WEIGHTS.U * U + WEIGHTS.E * E +
                   WEIGHTS.W * W + WEIGHTS.M * M + WEIGHTS.S * S;

    return {
      id: task.id,
      salience: round(salience * 100, 1),
      parts: { I: round(I, 3), U: round(U, 3), E: round(E, 3), W: round(W, 3), M: round(M, 3), S: round(S, 3) },
      // weighted contribution of each field to the final score, for the "Why this?" bar
      contrib: {
        I: round(WEIGHTS.I * I * 100, 1), U: round(WEIGHTS.U * U * 100, 1),
        E: round(WEIGHTS.E * E * 100, 1), W: round(WEIGHTS.W * W * 100, 1),
        M: round(WEIGHTS.M * M * 100, 1), S: round(WEIGHTS.S * S * 100, 1)
      },
      reasons: reasons,
      rot: rotRisk(task, now)
    };
  }

  /**
   * Rank a backlog for a moment. Returns eligible tasks sorted by salience
   * (desc), each annotated with its score breakdown, plus the blocked tasks
   * (held back by unmet deps) so the UI can show why they're hidden.
   */
  function rank(tasks, ctx) {
    var doneSet = new Set();
    for (var i = 0; i < tasks.length; i++) if (tasks[i].done) doneSet.add(tasks[i].id);

    var ranked = [], blocked = [], snoozed = [];
    for (var j = 0; j < tasks.length; j++) {
      var t = tasks[j];
      if (t.done) continue;
      if (t.snoozeUntil && t.snoozeUntil > ctx.now) { snoozed.push(t); continue; }
      if (!isEligible(t, doneSet)) { blocked.push(t); continue; }
      ranked.push(Object.assign({ task: t }, score(t, ctx)));
    }
    ranked.sort(function (a, b) {
      if (b.salience !== a.salience) return b.salience - a.salience;
      return (a.task.createdAt || 0) - (b.task.createdAt || 0); // stable-ish tiebreak: oldest first
    });
    return { ranked: ranked, blocked: blocked, snoozed: snoozed };
  }

  /**
   * Greedily pack the highest-salience tasks that fit the available window into
   * a "right now" plan, in score order, until the time runs out. A task that's
   * too big for the remaining time is skipped (but a later, smaller one can
   * still slot in). Returns the chosen items and the minutes they consume.
   */
  function planWindow(ranked, windowMin) {
    var remaining = Math.max(1, windowMin || 30), plan = [], used = 0;
    for (var i = 0; i < ranked.length; i++) {
      var effort = Math.max(1, ranked[i].task.effort || 30);
      if (effort <= remaining) { plan.push(ranked[i]); remaining -= effort; used += effort; }
    }
    return { plan: plan, usedMin: used, leftMin: remaining };
  }

  // Maximum number of window-fitting candidates the optimiser will reason about
  // exactly. A single short window only ever fits a handful of tasks, so this is
  // generous; past it we fall back to the greedy packer rather than ever hang.
  var OPT_MAX_CANDIDATES = 22;
  var OPT_MAX_STATES = 200000;

  /**
   * planOptimal — the right-now optimiser
   * =====================================
   *
   * `planWindow` is greedy: it grabs the highest-salience task that still fits
   * and moves on. That is fast but provably leaves value on the table — one big
   * "best" task can crowd out two smaller tasks that together deliver more — and
   * it is blind to dependency chains, because it only ever sees tasks that are
   * *already* eligible.
   *
   * `planOptimal` answers the sharper question: of everything I could touch,
   * which set actually maximises the salience I deliver before this window runs
   * out? It is exact, not greedy — a precedence-constrained 0/1 knapsack solved
   * over the time budget — so for any backlog that fits the window it returns a
   * plan whose total salience is provably ≥ the greedy one.
   *
   * The unique part: it plans **unlock chains**. A high-value task gated by a
   * quick prerequisite is invisible to every "list the eligible tasks" planner.
   * Here, if doing the 5-minute unblocker *and then* its payoff both fit your
   * window, the optimiser will schedule the pair — in the right order — and tell
   * you which tasks it unlocked. No order is assumed: a chosen set is only ever
   * emitted in a valid topological order, deps before dependents.
   *
   * Deterministic and auditable like the rest of the engine: same backlog + same
   * moment ⇒ same plan, every time, and it reports exactly how much salience it
   * gained over the greedy pick so the upgrade is never a black box. Pass the
   * *whole* task list (not just the ranked/eligible slice) so it can see, and
   * plan through, the blockers.
   *
   * Returns: { plan, usedMin, leftMin, totalSalience, unlocked, gainedVsGreedy,
   *            optimal } — `plan` items are shaped exactly like `score()` output
   * with a `.task`, so any UI that renders `planWindow` renders this unchanged.
   */
  function planOptimal(tasks, ctx) {
    var now = ctx.now, windowMin = Math.max(1, ctx.windowMin || 30);

    var doneSet = new Set(), byId = {};
    for (var i = 0; i < tasks.length; i++) {
      byId[tasks[i].id] = tasks[i];
      if (tasks[i].done) doneSet.add(tasks[i].id);
    }

    // Schedulable = not done, not snoozed. Score each (salience is well-defined
    // whether or not its deps are met — a blocked task still has a "worth").
    var sched = [], schedSet = new Set(), info = {};
    for (var k = 0; k < tasks.length; k++) {
      var t = tasks[k];
      if (t.done) continue;
      if (t.snoozeUntil && t.snoozeUntil > now) continue;
      var so = score(t, ctx);
      info[t.id] = { task: t, value: so.salience, effort: Math.max(1, t.effort || 30), score: so };
      sched.push(t); schedSet.add(t.id);
    }

    var unmetDeps = function (task) {
      var out = [], deps = task.deps || [];
      for (var d = 0; d < deps.length; d++) if (!doneSet.has(deps[d])) out.push(deps[d]);
      return out;
    };

    // Reachable-now = every unmet dep is itself a schedulable, reachable task
    // (so the whole prerequisite closure can be done inside this window). A dep
    // that is snoozed, missing, or part of a cycle is a hard wall ⇒ unreachable.
    var reach = {};
    var reachable = function (id, stack) {
      if (reach[id] != null) return reach[id];
      if (stack[id]) return false;                 // dependency cycle
      stack[id] = true;
      var task = byId[id], um = task ? unmetDeps(task) : [], ok = true;
      for (var d = 0; d < um.length; d++) {
        if (!schedSet.has(um[d]) || !reachable(um[d], stack)) { ok = false; break; }
      }
      stack[id] = false;
      return (reach[id] = ok);
    };

    // Candidate pool: reachable schedulable tasks that could plausibly fit.
    // Deterministic order (salience desc, then oldest, then id) fixes the bit
    // layout so the search — and its tiebreaks — are fully reproducible.
    var cand = [];
    for (var s = 0; s < sched.length; s++) {
      var id = sched[s].id;
      if (info[id].effort > windowMin && unmetDeps(sched[s]).length === 0) continue; // can never fit alone
      if (reachable(id, {})) cand.push(info[id]);
    }
    cand.sort(function (a, b) {
      if (b.value !== a.value) return b.value - a.value;
      if ((a.task.createdAt || 0) !== (b.task.createdAt || 0)) return (a.task.createdAt || 0) - (b.task.createdAt || 0);
      return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
    });
    if (cand.length > OPT_MAX_CANDIDATES) cand = cand.slice(0, OPT_MAX_CANDIDATES);

    // Build dependency bitmasks over the candidate set. Drop (iteratively) any
    // candidate whose unmet dep didn't make the pool — it can't be satisfied.
    var bit = {}, n;
    for (var pass = 0; pass < cand.length + 1; pass++) {
      bit = {}; for (n = 0; n < cand.length; n++) bit[cand[n].task.id] = n;
      var kept = [];
      for (n = 0; n < cand.length; n++) {
        var um = unmetDeps(cand[n].task), allIn = true;
        for (var u = 0; u < um.length; u++) if (bit[um[u]] == null) { allIn = false; break; }
        if (allIn) kept.push(cand[n]);
      }
      if (kept.length === cand.length) break;
      cand = kept;
    }
    var N = cand.length;
    bit = {}; for (n = 0; n < N; n++) bit[cand[n].task.id] = n;
    var depMask = new Array(N), eff = new Array(N), val = new Array(N);
    for (n = 0; n < N; n++) {
      var dm = 0, um2 = unmetDeps(cand[n].task);
      for (var x = 0; x < um2.length; x++) dm |= (1 << bit[um2[x]]);
      depMask[n] = dm; eff[n] = cand[n].effort; val[n] = cand[n].value;
    }

    var greedy = greedyValue(cand, depMask, eff, val, windowMin, doneSet);

    // Exact search over precedence-valid, budget-feasible subsets. Each subset's
    // effort and value are a pure function of its bitmask, so we enumerate
    // reachable masks once (adding one ready task at a time) and keep the best.
    // Bounded by OPT_MAX_STATES; on overflow we return the greedy plan honestly.
    var best = { mask: 0, val: 0, eff: 0, cnt: 0 }, bailed = false;
    if (N > 0 && N <= 31) {
      var seen = new Set([0]), stackArr = [0];
      while (stackArr.length) {
        var mask = stackArr.pop();
        var curE = 0, curV = 0, cnt = 0;
        for (n = 0; n < N; n++) if (mask & (1 << n)) { curE += eff[n]; curV += val[n]; cnt++; }
        if (better(curV, cnt, mask, best)) best = { mask: mask, val: curV, eff: curE, cnt: cnt };
        for (n = 0; n < N; n++) {
          if (mask & (1 << n)) continue;
          if ((depMask[n] & mask) !== depMask[n]) continue;     // prerequisites first
          if (curE + eff[n] > windowMin) continue;              // must fit the window
          var nm = mask | (1 << n);
          if (!seen.has(nm)) {
            seen.add(nm);
            if (seen.size > OPT_MAX_STATES) { bailed = true; break; }
            stackArr.push(nm);
          }
        }
        if (bailed) break;
      }
    }

    if (bailed) {
      var gp = greedyPlan(cand, depMask, eff, windowMin, doneSet);
      return { plan: gp.plan, usedMin: gp.used, leftMin: windowMin - gp.used,
        totalSalience: round(gp.val, 1), unlocked: [], gainedVsGreedy: 0, optimal: false };
    }

    // Emit the winning set deps-first: repeatedly release a chosen task once all
    // its unmet deps are already done or already placed; ties by salience.
    var chosenIds = [], placed = new Set(), order = [];
    for (n = 0; n < N; n++) if (best.mask & (1 << n)) chosenIds.push(cand[n].task.id);
    while (order.length < chosenIds.length) {
      var ready = [];
      for (var c = 0; c < chosenIds.length; c++) {
        var cid = chosenIds[c];
        if (placed.has(cid)) continue;
        var um3 = unmetDeps(byId[cid]), ok = true;
        for (var y = 0; y < um3.length; y++) if (!placed.has(um3[y])) { ok = false; break; }
        if (ok) ready.push(cid);
      }
      ready.sort(function (a, b) { return info[b].value - info[a].value; });
      var pick = ready[0]; placed.add(pick); order.push(pick);
    }

    var plan = [], unlocked = [], used = 0;
    for (var o = 0; o < order.length; o++) {
      var it = info[order[o]];
      used += it.effort;
      if (unmetDeps(it.task).length) unlocked.push(it.task.id);
      plan.push(Object.assign({ task: it.task }, it.score));
    }

    return {
      plan: plan, usedMin: used, leftMin: windowMin - used,
      totalSalience: round(best.val, 1),
      unlocked: unlocked,
      gainedVsGreedy: round(best.val - greedy, 1),
      optimal: true
    };
  }

  // Deterministic "is candidate plan A better than incumbent B?" — more salience
  // wins; ties break to the leaner plan, then to the lexicographically smaller
  // mask (which, given the value-desc bit order, prefers the punchier tasks).
  function better(v, cnt, mask, b) {
    if (v !== b.val) return v > b.val;
    if (cnt !== b.cnt) return cnt < b.cnt;
    return mask < b.mask;
  }

  // Greedy baseline restricted to what's eligible right now (deps already done),
  // packed by salience — i.e. exactly what planWindow delivers — so the optimiser
  // can report an honest, like-for-like uplift.
  function greedyPlan(cand, depMask, eff, windowMin, doneSet) {
    var rem = windowMin, plan = [], used = 0, total = 0;
    for (var i = 0; i < cand.length; i++) {
      if (depMask[i] !== 0) continue;               // not eligible without scheduling a prereq
      if (eff[i] <= rem) {
        plan.push(Object.assign({ task: cand[i].task }, cand[i].score));
        rem -= eff[i]; used += eff[i]; total += cand[i].value;
      }
    }
    return { plan: plan, used: used, val: total };
  }
  function greedyValue(cand, depMask, eff, val, windowMin, doneSet) {
    return greedyPlan(cand, depMask, eff, windowMin, doneSet).val;
  }

  return {
    version: '1.1.0',
    WEIGHTS: WEIGHTS, LOADS: LOADS, URGENCY_HORIZON_H: URGENCY_HORIZON_H,
    OPT_MAX_CANDIDATES: OPT_MAX_CANDIDATES,
    loadValue: loadValue, circadianEnergy: circadianEnergy,
    isEligible: isEligible, rotRisk: rotRisk,
    score: score, rank: rank, planWindow: planWindow, planOptimal: planOptimal
  };
});
