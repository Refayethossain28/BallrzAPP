/* Tokens — the pure "what will this prompt cost" engine.
 * =====================================================================
 * Tokens is an LLM token counter, cost estimator and usage budgeter:
 * paste text, see roughly how many tokens it is, what a request costs on
 * every current Claude model, what prompt caching would save, and how
 * your month's AI spend is tracking against a budget. Every rule lives
 * HERE as pure, deterministic, clock-injected functions with zero DOM
 * and zero I/O — unit-tested in scripts/test-tokens-logic.mjs, rendered
 * by index.html.
 *
 * Pricing is the public Anthropic list price (USD per million tokens),
 * cached from the docs on 2026-06-24. The token estimate is a heuristic
 * (roughly 4 chars ≈ 1 token, code-aware) — exact counts come from the
 * provider's count_tokens API; the UI says so.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  /* ---------------- the model catalog ---------------- */
  // context/maxOut in tokens; inPerM/outPerM in USD per 1M tokens.
  // Sonnet 5 launched with introductory pricing through 2026-08-31 —
  // priceFor() applies it by the injected clock, never the wall clock.
  var MODELS = [
    { id: 'claude-fable-5',    name: 'Claude Fable 5',    tier: 'Frontier', context: 1000000, maxOut: 128000, inPerM: 10, outPerM: 50 },
    { id: 'claude-opus-5',     name: 'Claude Opus 5',     tier: 'Opus',     context: 1000000, maxOut: 128000, inPerM: 5,  outPerM: 25 },
    { id: 'claude-opus-4-8',   name: 'Claude Opus 4.8',   tier: 'Opus',     context: 1000000, maxOut: 128000, inPerM: 5,  outPerM: 25 },
    { id: 'claude-opus-4-7',   name: 'Claude Opus 4.7',   tier: 'Opus',     context: 1000000, maxOut: 128000, inPerM: 5,  outPerM: 25 },
    { id: 'claude-opus-4-6',   name: 'Claude Opus 4.6',   tier: 'Opus',     context: 1000000, maxOut: 128000, inPerM: 5,  outPerM: 25 },
    { id: 'claude-sonnet-5',   name: 'Claude Sonnet 5',   tier: 'Sonnet',   context: 1000000, maxOut: 128000, inPerM: 3,  outPerM: 15,
      intro: { inPerM: 2, outPerM: 10, untilISO: '2026-08-31' } },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'Sonnet',   context: 1000000, maxOut: 128000, inPerM: 3,  outPerM: 15 },
    { id: 'claude-haiku-4-5',  name: 'Claude Haiku 4.5',  tier: 'Haiku',    context: 200000,  maxOut: 64000,  inPerM: 1,  outPerM: 5 }
  ];

  function modelById(id) {
    for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i];
    return null;
  }

  // Effective per-million prices for a model at a given moment. Intro
  // pricing holds through the END of its 'until' day, UTC.
  function priceFor(id, now) {
    var m = modelById(id);
    if (!m) return null;
    if (m.intro) {
      var parts = m.intro.untilISO.split('-');
      var end = Date.UTC(+parts[0], +parts[1] - 1, +parts[2]) + DAY; // exclusive
      if (now < end) return { inPerM: m.intro.inPerM, outPerM: m.intro.outPerM, intro: true, untilISO: m.intro.untilISO };
    }
    return { inPerM: m.inPerM, outPerM: m.outPerM, intro: false };
  }

  /* ---------------- estimating tokens from text ---------------- */
  // A deliberate heuristic, not a tokenizer: English prose runs ~4 chars
  // per token, code and symbol-dense text runs denser (more tokens per
  // char). We blend a character estimate with a word estimate and bump
  // for symbol density — deterministic, monotonic-ish, and honest about
  // being approximate (the UI labels it "≈").
  function estimateTokens(text) {
    var s = String(text == null ? '' : text);
    if (!s) return 0;
    var chars = s.length;
    var words = 0, m = s.match(/\S+/g);
    if (m) words = m.length;
    var symbols = (s.match(/[{}()\[\]<>;:=+\-*/\\|#$%^&@~`"']/g) || []).length;
    var byChars = chars / 4;
    var byWords = words * 4 / 3;
    var est = Math.max(byChars, byWords) + symbols * 0.35;
    return Math.max(1, Math.round(est));
  }

  function textStats(text) {
    var s = String(text == null ? '' : text);
    return {
      chars: s.length,
      words: s ? (s.match(/\S+/g) || []).length : 0,
      lines: s ? s.split('\n').length : 0,
      tokens: estimateTokens(s)
    };
  }

  /* ---------------- what a request costs ---------------- */
  function costOf(id, inTokens, outTokens, now) {
    var p = priceFor(id, now);
    if (!p) return null;
    var inT = Math.max(0, Number(inTokens) || 0);
    var outT = Math.max(0, Number(outTokens) || 0);
    var input = inT / 1e6 * p.inPerM;
    var output = outT / 1e6 * p.outPerM;
    return { id: id, input: input, output: output, total: input + output, price: p };
  }

  // Every model priced for the same request, cheapest first (stable:
  // ties keep catalog order, i.e. the more capable model first).
  function compareModels(inTokens, outTokens, now) {
    var out = [];
    for (var i = 0; i < MODELS.length; i++) {
      var m = MODELS[i];
      var c = costOf(m.id, inTokens, outTokens, now);
      out.push({
        model: m, cost: c,
        fit: contextFit(m.id, (Number(inTokens) || 0) + (Number(outTokens) || 0))
      });
    }
    out.sort(function (a, b) { return a.cost.total - b.cost.total || MODELS.indexOf(a.model) - MODELS.indexOf(b.model); });
    return out;
  }

  function contextFit(id, tokens) {
    var m = modelById(id);
    if (!m) return null;
    var t = Math.max(0, Number(tokens) || 0);
    return { context: m.context, pct: Math.min(1, t / m.context), fits: t <= m.context };
  }

  /* ---------------- prompt caching: is it worth it? ---------------- */
  // List economics: cache reads ~0.1× input price; writes 1.25× for the
  // 5-minute TTL, 2× for the 1-hour TTL. For N requests sharing one
  // cached prefix: 1 write + (N−1) reads vs N full-price passes.
  var CACHE = { readX: 0.1, writeX: { '5m': 1.25, '1h': 2 } };

  function cachePlan(id, prefixTokens, requests, ttl, now) {
    var p = priceFor(id, now);
    if (!p) return null;
    var n = Math.max(1, Math.floor(Number(requests) || 1));
    var toks = Math.max(0, Number(prefixTokens) || 0);
    var writeX = CACHE.writeX[ttl] || CACHE.writeX['5m'];
    var per = toks / 1e6 * p.inPerM;                    // one uncached pass
    var uncached = per * n;
    var cached = per * writeX + per * CACHE.readX * (n - 1);
    var saving = uncached - cached;
    return {
      requests: n, ttl: writeX === CACHE.writeX['1h'] ? '1h' : '5m',
      uncached: uncached, cached: cached, saving: saving,
      savingPct: uncached > 0 ? saving / uncached : 0,
      worthIt: saving > 0
    };
  }

  /* ---------------- the ledger: your month in tokens ---------------- */
  // Entries are plain objects: { ts, model, inTokens, outTokens, note }.
  // Spend is priced at the entry's own timestamp, so an August Sonnet 5
  // call keeps its intro price even when viewed in September.
  function validateEntry(e, now) {
    e = e || {};
    var m = modelById(String(e.model || ''));
    if (!m) return { ok: false, reason: 'Pick a model.' };
    var inT = Math.floor(Number(e.inTokens));
    var outT = Math.floor(Number(e.outTokens));
    if (!isFinite(inT) || inT < 0) inT = 0;
    if (!isFinite(outT) || outT < 0) outT = 0;
    if (inT === 0 && outT === 0) return { ok: false, reason: 'Log some tokens — input, output or both.' };
    var note = String(e.note == null ? '' : e.note).trim().slice(0, 80);
    return { ok: true, entry: { ts: Number(e.ts) || now, model: m.id, inTokens: inT, outTokens: outT, note: note } };
  }

  function entryCost(e) {
    var c = costOf(e.model, e.inTokens, e.outTokens, e.ts || 0);
    return c ? c.total : 0;
  }

  function monthKey(ts) {
    var d = new Date(ts);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).replace(/^(\d)$/, '0$1');
  }

  // Everything the budget card needs for the month `now` sits in:
  // per-model rollup, month-to-date spend, and a straight-line
  // projection from the burn rate so far.
  function monthReport(entries, now) {
    var key = monthKey(now);
    var d = new Date(now);
    var daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    var dayOfMonth = d.getUTCDate();
    var spend = 0, inT = 0, outT = 0, count = 0, byModel = {};
    for (var i = 0; i < (entries || []).length; i++) {
      var e = entries[i];
      if (monthKey(e.ts || 0) !== key) continue;
      var cost = entryCost(e);
      spend += cost; inT += e.inTokens || 0; outT += e.outTokens || 0; count++;
      var bm = byModel[e.model] || (byModel[e.model] = { model: e.model, spend: 0, inTokens: 0, outTokens: 0, count: 0 });
      bm.spend += cost; bm.inTokens += e.inTokens || 0; bm.outTokens += e.outTokens || 0; bm.count++;
    }
    var models = [];
    for (var id in byModel) models.push(byModel[id]);
    models.sort(function (a, b) { return b.spend - a.spend; });
    return {
      monthKey: key, count: count, spend: spend, inTokens: inT, outTokens: outT,
      byModel: models,
      projected: dayOfMonth > 0 ? spend / dayOfMonth * daysInMonth : spend,
      dayOfMonth: dayOfMonth, daysInMonth: daysInMonth
    };
  }

  function budgetStatus(report, budgetUSD) {
    var budget = Number(budgetUSD);
    if (!isFinite(budget) || budget <= 0) return { hasBudget: false };
    var pct = report.spend / budget;
    var status = 'ok';
    if (report.spend > budget) status = 'over';
    else if (report.projected > budget) status = 'warn';
    return {
      hasBudget: true, budget: budget, pct: Math.min(1, pct), status: status,
      left: Math.max(0, budget - report.spend),
      projectedPct: budget > 0 ? report.projected / budget : 0
    };
  }

  /* ---------------- little formatters ---------------- */
  // Money at token scale needs sub-cent honesty: $12.40, $0.0042, <$0.0001.
  function formatUSD(x) {
    var v = Number(x) || 0;
    if (v === 0) return '$0';
    if (v < 0.0001) return '<$0.0001';
    if (v < 0.01) return '$' + v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (v < 100) return '$' + v.toFixed(2);
    return '$' + Math.round(v).toLocaleString('en-US');
  }

  function formatTokens(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    if (n < 1000) return String(n);
    if (n < 1000000) return (Math.round(n / 100) / 10) + 'k';
    return (Math.round(n / 100000) / 10) + 'M';
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    MODELS: MODELS, CACHE: CACHE,
    modelById: modelById, priceFor: priceFor,
    estimateTokens: estimateTokens, textStats: textStats,
    costOf: costOf, compareModels: compareModels, contextFit: contextFit,
    cachePlan: cachePlan,
    validateEntry: validateEntry, entryCost: entryCost,
    monthKey: monthKey, monthReport: monthReport, budgetStatus: budgetStatus,
    formatUSD: formatUSD, formatTokens: formatTokens, escapeHTML: escapeHTML
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.TokensEngine = E;
})(typeof self !== 'undefined' ? self : this);
