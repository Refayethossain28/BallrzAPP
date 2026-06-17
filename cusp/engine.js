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

  return {
    version: '1.0.0',
    WEIGHTS: WEIGHTS, LOADS: LOADS, URGENCY_HORIZON_H: URGENCY_HORIZON_H,
    loadValue: loadValue, circadianEnergy: circadianEnergy,
    isEligible: isEligible, rotRisk: rotRisk,
    score: score, rank: rank, planWindow: planWindow
  };
});
