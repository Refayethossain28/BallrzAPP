/**
 * Drip — the passive income engine
 * ================================
 *
 * "Make something that can passively generate money." You can't conjure money
 * from code — anything promising that is a scam. What you *can* build is the
 * machine that every real passive income stream secretly is:
 *
 *          capital ──(yield)──▶ income ──(reinvest?)──▶ back into capital
 *
 * A savings account, a dividend portfolio, a rental flat, a book royalty and a
 * digital product are all the same little machine with different dials. Drip
 * models each stream with one unified, honest parameterisation:
 *
 *   capital          £ working for you (0 for pure-royalty streams)
 *   yieldPct         income rate on capital, %/yr (paid monthly as /12)
 *   incomeMonthly    £/mo produced directly (royalties, products) — used when
 *                    the stream has no capital yield
 *   incomeGrowthPct  %/yr the income *rate* changes — dividend growth, rent
 *                    reviews (+), or royalty decay (−)
 *   capitalGrowthPct %/yr the capital itself appreciates (price growth,
 *                    property appreciation) independent of reinvestment
 *   contribMonthly   £/mo you add from active income (the "drip in")
 *   reinvest         plow income back into capital (DRIP) instead of taking
 *                    it as cash — this is where compounding comes from
 *   hoursMonthly     honest upkeep hours — "passive" is a spectrum, and this
 *                    is the dial that measures it
 *
 * The engine then answers the questions that actually matter:
 *
 *   project()         month-by-month simulation of income & capital, nominal
 *                     and inflation-adjusted (real)
 *   crossover         the **freedom date**: the first month projected passive
 *                     income covers your (inflation-growing) expenses
 *   coverage()        how much of this month's bills the drip already pays
 *   passivity()       income-weighted 0..1 score of how passive the portfolio
 *                     truly is, plus your effective £/hr on upkeep
 *   diversification() 1 − Herfindahl concentration of income across streams
 *
 * Everything is pure and deterministic: same streams + same options ⇒ the same
 * projection, to the pound. No Date.now(), no randomness, no hidden state —
 * which is what makes it unit-testable and the numbers on screen auditable.
 *
 * Rate conventions (stated so the tests can pin them):
 *   • yieldPct pays simple monthly twelfths: income = capital × yieldPct/1200.
 *     (That's how dividend yields and rent are quoted; compounding then comes
 *     from reinvestment, not from the quote.)
 *   • growth/inflation rates compound: monthly = (1+pct/100)^(1/12) − 1, so
 *     twelve months of growth equals exactly the annual figure.
 *
 * UMD so it runs in the browser (window.Drip) and under Node/vm for tests —
 * same pattern as cusp/engine.js. Framework-free, dependency-free.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Drip = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var round2 = function (x) { return Math.round(x * 100) / 100; };
  var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };

  /** Compounding monthly rate for an annual percentage (2.5 → ~0.00206). */
  function mRate(annualPct) {
    var r = 1 + (Number(annualPct) || 0) / 100;
    if (r <= 0) return -1; // −100%/yr or worse: the stream is dead in a year
    return Math.pow(r, 1 / 12) - 1;
  }

  /**
   * Honest starting points for the classic streams. Presets are *defaults for
   * the dials*, not promises — every figure is editable and the projection
   * only ever reflects what the user typed.
   */
  var PRESETS = {
    savings:  { name: 'High-interest savings', icon: '🏦', capital: 5000,  yieldPct: 4.5, incomeGrowthPct: 0,   capitalGrowthPct: 0,   reinvest: true,  hoursMonthly: 0 },
    dividend: { name: 'Dividend portfolio',    icon: '📈', capital: 10000, yieldPct: 3.5, incomeGrowthPct: 5,   capitalGrowthPct: 4,   reinvest: true,  hoursMonthly: 1 },
    bond:     { name: 'Bonds / gilts',         icon: '🧾', capital: 5000,  yieldPct: 4.8, incomeGrowthPct: 0,   capitalGrowthPct: 0,   reinvest: false, hoursMonthly: 0 },
    rental:   { name: 'Rental property',       icon: '🏠', capital: 60000, yieldPct: 6,   incomeGrowthPct: 3,   capitalGrowthPct: 3,   reinvest: false, hoursMonthly: 4 },
    royalty:  { name: 'Royalties (book/music)', icon: '🎼', capital: 0, incomeMonthly: 150, incomeGrowthPct: -20, capitalGrowthPct: 0, reinvest: false, hoursMonthly: 0 },
    product:  { name: 'Digital product',       icon: '💾', capital: 0, incomeMonthly: 300, incomeGrowthPct: -5,  capitalGrowthPct: 0,  reinvest: false, hoursMonthly: 6 },
    custom:   { name: 'Custom stream',         icon: '✨', capital: 0, incomeMonthly: 100, incomeGrowthPct: 0,   capitalGrowthPct: 0,  reinvest: false, hoursMonthly: 0 }
  };

  /** Fill a stream with safe defaults; never mutates the input. */
  function normalize(s) {
    s = s || {};
    var out = {
      id: s.id != null ? String(s.id) : 's',
      name: s.name || 'Stream',
      type: PRESETS[s.type] ? s.type : 'custom',
      capital: Math.max(0, Number(s.capital) || 0),
      yieldPct: Math.max(0, Number(s.yieldPct) || 0),
      incomeMonthly: Math.max(0, Number(s.incomeMonthly) || 0),
      incomeGrowthPct: Number(s.incomeGrowthPct) || 0,
      capitalGrowthPct: Number(s.capitalGrowthPct) || 0,
      contribMonthly: Math.max(0, Number(s.contribMonthly) || 0),
      reinvest: !!s.reinvest,
      hoursMonthly: Math.max(0, Number(s.hoursMonthly) || 0)
    };
    return out;
  }

  /** Is this stream driven by capital × yield (vs direct monthly income)? */
  function isYieldStream(s) { return s.capital > 0 && s.yieldPct > 0; }

  /** £/mo the stream produces right now, before any simulation. */
  function monthlyIncome(s) {
    s = normalize(s);
    return isYieldStream(s) ? s.capital * s.yieldPct / 1200 : s.incomeMonthly;
  }

  /**
   * The simulation. Walks month by month; for each stream each month:
   *   1. income   = capital × yield/1200   (or the direct income state)
   *   2. reinvest ? capital += income : cash += income
   *   3. capital += contribMonthly                (your drip in)
   *   4. capital ×= 1 + mRate(capitalGrowthPct)   (appreciation)
   *   5. the income rate grows: yield/income ×= 1 + mRate(incomeGrowthPct)
   *
   * opts: { months=360, expenses=0, inflationPct=2.5 }
   * Returns {
   *   rows: [{ i, income, incomeReal, expenses, capital, cash, byStream }],
   *   crossoverIndex,   // first month income ≥ inflation-grown expenses, −1 if never
   *   incomeNow, capitalNow
   * }
   * Month 0 is "this month, as things stand" (income before any growth).
   */
  function project(streams, opts) {
    opts = opts || {};
    var months = Math.max(1, Math.min(1200, Math.floor(opts.months != null ? opts.months : 360)));
    var expenses0 = Math.max(0, Number(opts.expenses) || 0);
    var infM = mRate(opts.inflationPct != null ? opts.inflationPct : 2.5);

    var st = (streams || []).map(normalize).map(function (s) {
      return { s: s, capital: s.capital, yieldPct: s.yieldPct, incomeM: s.incomeMonthly };
    });

    var rows = [], crossoverIndex = -1, cash = 0;
    for (var i = 0; i < months; i++) {
      var income = 0, capitalTot = 0, byStream = {};
      for (var k = 0; k < st.length; k++) {
        var x = st[k], s = x.s;
        // Yield mode is decided on the *evolving* capital, so a stream you
        // build from £0 by contributions starts paying once capital exists.
        var yieldMode = x.capital > 0 && x.yieldPct > 0;
        var inc = yieldMode ? x.capital * x.yieldPct / 1200 : x.incomeM;
        income += inc;
        byStream[s.id] = round2(inc);

        if (s.reinvest) x.capital += inc; else cash += inc;
        x.capital += s.contribMonthly;
        x.capital *= 1 + mRate(s.capitalGrowthPct);
        var g = 1 + mRate(s.incomeGrowthPct);
        if (yieldMode) x.yieldPct = Math.max(0, x.yieldPct * g);
        else x.incomeM = Math.max(0, x.incomeM * g);
        capitalTot += x.capital;
      }
      var infF = Math.pow(1 + infM, i);
      var exp = expenses0 * infF;
      if (crossoverIndex < 0 && expenses0 > 0 && income >= exp) crossoverIndex = i;
      rows.push({
        i: i,
        income: round2(income),
        incomeReal: round2(income / infF),
        expenses: round2(exp),
        capital: round2(capitalTot),
        cash: round2(cash),
        byStream: byStream
      });
    }
    return {
      rows: rows,
      crossoverIndex: crossoverIndex,
      incomeNow: rows[0].income,
      capitalNow: round2(st.reduce(function (a, x) { return a + x.s.capital; }, 0))
    };
  }

  /** Fraction of monthly expenses the drip covers today (1 = free). */
  function coverage(streams, expenses) {
    expenses = Number(expenses) || 0;
    if (expenses <= 0) return 1;
    var inc = (streams || []).reduce(function (a, s) { return a + monthlyIncome(s); }, 0);
    return inc / expenses;
  }

  /**
   * How passive is the portfolio, honestly? Each stream's passivity is
   * 1/(1 + hours/10): 0 h/mo ⇒ 1.0, 10 h/mo ⇒ 0.5, a part-time job ⇒ →0.
   * The portfolio score income-weights the streams (a huge truly-passive
   * stream should outweigh a tiny needy one). Also reports total upkeep hours
   * and the effective hourly rate your "passive" income really pays.
   */
  function passivity(streams) {
    var ns = (streams || []).map(normalize);
    var totInc = 0, totHrs = 0, wsum = 0;
    for (var i = 0; i < ns.length; i++) {
      var inc = monthlyIncome(ns[i]);
      totInc += inc; totHrs += ns[i].hoursMonthly;
      wsum += inc * (1 / (1 + ns[i].hoursMonthly / 10));
    }
    var score = totInc > 0 ? clamp01(wsum / totInc)
      : (ns.length ? clamp01(ns.reduce(function (a, s) { return a + 1 / (1 + s.hoursMonthly / 10); }, 0) / ns.length) : 1);
    return {
      score: Math.round(score * 100) / 100,
      hoursMonthly: round2(totHrs),
      hourly: totHrs > 0 ? round2(totInc / totHrs) : null
    };
  }

  /**
   * 1 − Herfindahl index of income shares, rescaled by stream count so it
   * reads as "how evenly is the drip spread": one stream ⇒ 0, n equal
   * streams ⇒ 1. Concentration is the classic passive-income failure mode
   * (the algorithm change / the tenant leaves / the rate cut).
   */
  function diversification(streams) {
    var incs = (streams || []).map(monthlyIncome).filter(function (x) { return x > 0; });
    var n = incs.length;
    if (n <= 1) return 0;
    var tot = incs.reduce(function (a, b) { return a + b; }, 0);
    var h = incs.reduce(function (a, x) { var f = x / tot; return a + f * f; }, 0);
    return Math.round((1 - h) / (1 - 1 / n) * 100) / 100;
  }

  /* ------------------------------------------------------------------ *
   *  Plan vs reality — logging what actually dripped                     *
   * ------------------------------------------------------------------ */

  /** {y,m} ⇄ 'YYYY-MM' keys for calendar months. */
  function ymKey(d) { return d.y + '-' + (d.m < 10 ? '0' : '') + d.m; }
  function parseYM(key) {
    var m = /^(\d{4})-(\d{1,2})$/.exec(String(key || ''));
    if (!m) return null;
    var mm = +m[2];
    if (mm < 1 || mm > 12) return null;
    return { y: +m[1], m: mm };
  }

  /** Signed whole months from start {y,m} to a 'YYYY-MM' key (may be <0). */
  function monthIndex(start, key) {
    var d = parseYM(key);
    if (!d) return null;
    return (d.y * 12 + d.m) - (start.y * 12 + start.m);
  }

  /**
   * Compare what actually dripped against what the current plan projected.
   * entries: [{ ym: 'YYYY-MM', streamId, amount }] — one row per stream per
   * month (the UI replaces rather than double-logs). Months outside the plan
   * (before start, past the horizon) get projected:null instead of a made-up
   * number. Returns rows (newest first) and an honesty summary: total actual,
   * total projected over the same months, and their ratio (1 = on plan).
   */
  function trackRecord(entries, streams, opts) {
    opts = opts || {};
    var start = opts.start || { y: 2026, m: 1 };
    var p = project(streams, opts);
    var byYm = {};
    (entries || []).forEach(function (e) {
      var d = parseYM(e && e.ym);
      if (!d) return;
      var k = ymKey(d), amt = Math.max(0, Number(e.amount) || 0);
      byYm[k] = (byYm[k] || 0) + amt;
    });
    var rows = Object.keys(byYm).sort().reverse().map(function (k) {
      var i = monthIndex(start, k);
      var proj = (i != null && i >= 0 && i < p.rows.length) ? p.rows[i].income : null;
      return {
        ym: k,
        actual: round2(byYm[k]),
        projected: proj,
        delta: proj == null ? null : round2(byYm[k] - proj)
      };
    });
    var withProj = rows.filter(function (r) { return r.projected != null; });
    var at = withProj.reduce(function (a, r) { return a + r.actual; }, 0);
    var pt = withProj.reduce(function (a, r) { return a + r.projected; }, 0);
    return {
      rows: rows,
      summary: {
        months: withProj.length,
        actualTotal: round2(at),
        projectedTotal: round2(pt),
        ratio: pt > 0 ? Math.round(at / pt * 100) / 100 : null
      }
    };
  }

  /* ------------------------------------------------------------------ *
   *  What if? — scenario builders + comparer                            *
   * ------------------------------------------------------------------ */

  /** Copy of the streams with DRIP switched on everywhere. */
  function scenarioReinvestAll(streams) {
    return (streams || []).map(function (s) {
      var n = normalize(s); n.reinvest = true; return n;
    });
  }

  /** id of the stream where the next pound works hardest (highest yield). */
  function bestYieldStreamId(streams) {
    var ns = (streams || []).map(normalize), best = null;
    for (var i = 0; i < ns.length; i++) {
      if (ns[i].yieldPct > 0 && (best == null || ns[i].yieldPct > best.yieldPct)) best = ns[i];
    }
    return best ? best.id : null;
  }

  /** Copy with £extra/mo contributed to the highest-yield stream. */
  function scenarioAddContrib(streams, extra) {
    extra = Math.max(0, Number(extra) || 0);
    var target = bestYieldStreamId(streams);
    return (streams || []).map(function (s) {
      var n = normalize(s);
      if (n.id === target && extra > 0) n.contribMonthly += extra;
      return n;
    });
  }

  /**
   * Run the classic what-ifs side by side: as-is, DRIP everything, +£extra/mo
   * into the highest-yield stream, and both. Each result carries the income
   * in the final projected month and the freedom-date crossover, so the UI
   * can show exactly what each habit buys.
   */
  function compare(streams, opts, extra) {
    if (extra == null) extra = 100;
    var defs = [
      { key: 'base',    label: 'As things stand',        ss: (streams || []).map(normalize) },
      { key: 'drip',    label: 'Reinvest everything',    ss: scenarioReinvestAll(streams) },
      { key: 'contrib', label: '+£' + Math.round(extra) + '/mo in', ss: scenarioAddContrib(streams, extra) },
      { key: 'both',    label: 'Both',                   ss: scenarioAddContrib(scenarioReinvestAll(streams), extra) }
    ];
    return defs.map(function (d) {
      var p = project(d.ss, opts);
      return {
        key: d.key,
        label: d.label,
        incomeEnd: p.rows[p.rows.length - 1].income,
        crossoverIndex: p.crossoverIndex
      };
    });
  }

  /** Month index → { y, m } from a start {y, m(1-12)}. Pure calendar math. */
  function monthAt(start, i) {
    var t = (start.y * 12 + (start.m - 1)) + i;
    return { y: Math.floor(t / 12), m: (t % 12) + 1 };
  }

  var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthLabel(start, i) {
    var d = monthAt(start, i);
    return MONTHS_SHORT[d.m - 1] + ' ' + d.y;
  }

  /** One call for the whole dashboard. opts as project(), plus start {y,m}. */
  function summarize(streams, opts) {
    opts = opts || {};
    var p = project(streams, opts);
    var cov = coverage(streams, opts.expenses);
    return {
      incomeNow: p.incomeNow,
      yearNow: round2(p.incomeNow * 12),
      capitalNow: p.capitalNow,
      coverage: cov,
      crossoverIndex: p.crossoverIndex,
      freedomLabel: p.crossoverIndex < 0 ? null
        : (opts.start ? monthLabel(opts.start, p.crossoverIndex) : String(p.crossoverIndex)),
      passivity: passivity(streams),
      diversification: diversification(streams),
      projection: p
    };
  }

  return {
    PRESETS: PRESETS,
    mRate: mRate,
    normalize: normalize,
    isYieldStream: isYieldStream,
    monthlyIncome: monthlyIncome,
    project: project,
    coverage: coverage,
    passivity: passivity,
    diversification: diversification,
    monthAt: monthAt,
    monthLabel: monthLabel,
    summarize: summarize,
    ymKey: ymKey,
    parseYM: parseYM,
    monthIndex: monthIndex,
    trackRecord: trackRecord,
    scenarioReinvestAll: scenarioReinvestAll,
    bestYieldStreamId: bestYieldStreamId,
    scenarioAddContrib: scenarioAddContrib,
    compare: compare
  };
});
