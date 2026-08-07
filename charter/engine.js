/**
 * Charter — mint your own preferred convertible stock
 * ===================================================
 *
 * "Create for me a preferred convertible stock." A share class isn't an app —
 * it's a bundle of *rights* written down in a company's charter. Charter lets
 * you mint one: define a series of convertible preferred stock the way a real
 * term sheet does, and this engine computes everything those rights imply.
 *
 * The instrument, in one line: an investor puts money in and receives
 * preferred shares that (a) accrue a dividend, (b) stand ahead of common in a
 * sale or liquidation for a guaranteed *liquidation preference*, and (c) can
 * convert into common stock at a set conversion price — so the holder takes
 * whichever is worth more at exit. That max(preference, convert) choice is
 * the whole economics of venture preferred stock, and it's what the
 * waterfall below computes.
 *
 * Dials on the series (all standard term-sheet terms):
 *   investment       £ invested in the round
 *   preMoney         £ pre-money valuation ⇒ price/share = preMoney ÷ common
 *   commonShares     founders' fully-diluted common before the round
 *   dividendPct      %/yr dividend on the investment
 *   cumulative       cumulative dividends accrue whether or not declared;
 *                    non-cumulative ones vanish each year undeclared
 *   prefMultiple     liquidation preference (1× is market, 2–3× is downside
 *                    protection with teeth)
 *   participation    'none'   — non-participating: preference OR convert
 *                    'full'   — participating: preference AND pro-rata share
 *                    'capped' — participating up to a cap (× investment)
 *   participationCap the cap multiple when participation === 'capped'
 *   conversionPrice  starts at the issue price (ratio 1:1) and only moves
 *                    down via anti-dilution in a down round
 *   antiDilution     'none' | 'broad' (broad-based weighted average — the
 *                    market standard) | 'ratchet' (full ratchet — brutal)
 *
 * What the engine answers:
 *   waterfall()      at a given exit value, does the holder take the
 *                    preference route or convert, and who gets what
 *   breakevenExit()  the exit value where converting starts to win
 *   downRound()      the new conversion price after a lower-priced round,
 *                    under each anti-dilution regime (formulas pinned in tests)
 *   payoutCurve()    preferred vs common payout across exit values (chart)
 *   capTable()       as-converted ownership
 *   termSheet()      the series rendered as term-sheet lines
 *
 * Pure and deterministic: same series + same inputs ⇒ same numbers, to the
 * penny. No Date.now(), no randomness — the issue date is passed in by the
 * UI. UMD so it runs in the browser (window.Charter) and under Node/vm for
 * tests — same pattern as drip/engine.js. Framework-free, dependency-free.
 *
 * Honesty note: this is a working model of the standard economics, not legal
 * advice — a real instrument is created by a company's board, its charter
 * documents and a lawyer.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Charter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var round2 = function (x) { return Math.round(x * 100) / 100; };

  var PARTICIPATION = ['none', 'full', 'capped'];
  var ANTIDILUTION = ['none', 'broad', 'ratchet'];

  var num = function (v, fallback, min) {
    var n = Number(v);
    if (!isFinite(n)) n = fallback;
    if (min !== undefined && n < min) n = min;
    return n;
  };

  /* ---- the series ---------------------------------------------------- */

  function normalize(raw) {
    raw = raw || {};
    var s = {
      company: String(raw.company || 'Acme Ltd'),
      seriesName: String(raw.seriesName || 'Series A Preferred'),
      holder: String(raw.holder || 'The Investor'),
      investment: num(raw.investment, 1000000, 1),
      preMoney: num(raw.preMoney, 4000000, 1),
      commonShares: Math.max(1, Math.round(num(raw.commonShares, 1000000, 1))),
      dividendPct: num(raw.dividendPct, 8, 0),
      cumulative: raw.cumulative !== false,
      prefMultiple: num(raw.prefMultiple, 1, 0.25),
      participation: PARTICIPATION.indexOf(raw.participation) >= 0 ? raw.participation : 'none',
      participationCap: num(raw.participationCap, 3, 1),
      antiDilution: ANTIDILUTION.indexOf(raw.antiDilution) >= 0 ? raw.antiDilution : 'broad',
      issueDate: String(raw.issueDate || '2026-01-01'),
    };
    var pps = s.preMoney / s.commonShares;
    // conversion price starts at the issue price (1:1) unless already adjusted
    s.conversionPrice = num(raw.conversionPrice, pps, 0.000001);
    if (s.conversionPrice > pps) s.conversionPrice = pps; // never adjusts upward
    return s;
  }

  function pricePerShare(s) { return s.preMoney / s.commonShares; }
  function sharesFor(s) { return Math.max(1, Math.floor(s.investment / pricePerShare(s))); }
  function postMoney(s) { return s.preMoney + s.investment; }

  /* conversion ratio = original issue price ÷ (possibly adjusted) conversion
     price — 1.0 at issue, rises only through anti-dilution */
  function conversionRatio(s) { return pricePerShare(s) / s.conversionPrice; }
  function asConvertedShares(s) { return Math.round(sharesFor(s) * conversionRatio(s)); }
  function prorataFrac(s) {
    var ac = asConvertedShares(s);
    return ac / (s.commonShares + ac);
  }

  /* ---- dividends & preference ---------------------------------------- */

  /* cumulative preferred dividends accrue simple (non-compounding) on the
     investment — the market-standard quote */
  function accruedDividend(s, years) {
    years = num(years, 0, 0);
    if (!s.cumulative || s.dividendPct <= 0) return 0;
    return round2(s.investment * (s.dividendPct / 100) * years);
  }

  function preferenceAmount(s, years) {
    return round2(s.investment * s.prefMultiple + accruedDividend(s, years));
  }

  /* ---- the liquidation waterfall -------------------------------------- */

  /* At exit, the holder takes max(preference route, convert route):
       preference route — non-participating: min(exit, preference);
         participating: preference + pro-rata of the remainder, capped at
         participationCap × investment when the series is capped (and a capped
         holder can always convert instead, so the cap never traps them below
         the convert route)
       convert route — pro-rata (as-converted) share of the whole exit */
  function waterfall(s, exitValue, years) {
    exitValue = num(exitValue, 0, 0);
    var pref = preferenceAmount(s, years);
    var frac = prorataFrac(s);
    var convertPayout = frac * exitValue;

    var prefRoute = Math.min(exitValue, pref);
    if (s.participation !== 'none' && exitValue > pref) {
      prefRoute = pref + frac * (exitValue - pref);
      if (s.participation === 'capped') {
        prefRoute = Math.min(prefRoute, s.participationCap * s.investment);
      }
    }

    var payout = Math.max(prefRoute, convertPayout);
    var route = convertPayout > prefRoute ? 'convert' : 'preference';
    return {
      exitValue: round2(exitValue),
      preference: pref,
      prorataPct: round2(frac * 100),
      preferencePayout: round2(prefRoute),
      convertPayout: round2(convertPayout),
      payout: round2(payout),
      route: route,
      common: round2(exitValue - payout),
      moic: s.investment > 0 ? round2(payout / s.investment) : 0,
    };
  }

  /* the exit value where converting starts to beat the preference route:
       non-participating — preference ÷ pro-rata fraction
       participating      — never (Infinity): pref + pro-rata beats pro-rata
       capped             — where pro-rata × exit passes the cap */
  function breakevenExit(s, years) {
    var frac = prorataFrac(s);
    if (frac <= 0) return Infinity;
    if (s.participation === 'full') return Infinity;
    if (s.participation === 'capped') return round2((s.participationCap * s.investment) / frac);
    return round2(preferenceAmount(s, years) / frac);
  }

  /* ---- anti-dilution --------------------------------------------------
     A later round priced *below* the conversion price triggers protection:
       full ratchet — conversion price drops straight to the new price
       broad-based weighted average — NCP = OCP × (A + B) / (A + C)
         A = fully-diluted shares before the new round (common + as-converted)
         B = shares the new money would have bought at the old price
         C = shares actually issued in the new round                        */
  function downRound(s, newPrice, newShares) {
    newPrice = num(newPrice, 0, 0.000001);
    newShares = Math.max(1, Math.round(num(newShares, 1, 1)));
    var out = {};
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k];
    if (newPrice >= s.conversionPrice || s.antiDilution === 'none') return out;
    if (s.antiDilution === 'ratchet') {
      out.conversionPrice = newPrice;
      return out;
    }
    var A = s.commonShares + asConvertedShares(s);
    var B = (newPrice * newShares) / s.conversionPrice;
    var C = newShares;
    out.conversionPrice = s.conversionPrice * ((A + B) / (A + C));
    return out;
  }

  /* ---- reporting ------------------------------------------------------ */

  function payoutCurve(s, years, maxExit, steps) {
    steps = Math.max(2, Math.round(num(steps, 60, 2)));
    maxExit = num(maxExit, postMoney(s) * 4, 1);
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var exitValue = (maxExit * i) / steps;
      var w = waterfall(s, exitValue, years);
      pts.push({ exit: round2(exitValue), preferred: w.payout, common: w.common, route: w.route });
    }
    return pts;
  }

  function capTable(s) {
    var ac = asConvertedShares(s);
    var total = s.commonShares + ac;
    return [
      { holder: 'Founders — common', shares: s.commonShares, pct: round2((s.commonShares / total) * 100) },
      { holder: s.seriesName + ' — as converted', shares: ac, pct: round2((ac / total) * 100) },
    ];
  }

  var money = function (n) {
    var neg = n < 0 ? '−' : '';
    n = Math.abs(n);
    var whole = Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return neg + '£' + whole;
  };
  var qty = function (n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); };

  var PARTICIPATION_LABEL = {
    none: 'Non-participating — take the preference OR convert, whichever is greater',
    full: 'Participating — take the preference AND a pro-rata share of the rest',
    capped: 'Participating, capped',
  };
  var ANTIDILUTION_LABEL = {
    none: 'None',
    broad: 'Broad-based weighted average',
    ratchet: 'Full ratchet',
  };

  function termSheet(s) {
    var pps = pricePerShare(s);
    var rows = [
      { term: 'Issuer', detail: s.company },
      { term: 'Security', detail: s.seriesName + ' — convertible preferred stock' },
      { term: 'Investment', detail: money(s.investment) },
      { term: 'Valuation', detail: money(s.preMoney) + ' pre-money · ' + money(postMoney(s)) + ' post-money' },
      { term: 'Price per share', detail: '£' + pps.toFixed(4) },
      { term: 'Shares issued', detail: qty(sharesFor(s)) + ' preferred shares' },
      { term: 'Ownership (as converted)', detail: round2(prorataFrac(s) * 100).toFixed(2) + '%' },
      { term: 'Dividend', detail: s.dividendPct > 0 ? s.dividendPct + '% per annum, ' + (s.cumulative ? 'cumulative' : 'non-cumulative') : 'None' },
      { term: 'Liquidation preference', detail: s.prefMultiple.toFixed(1).replace(/\.0$/, '') + '× the investment' + (s.cumulative && s.dividendPct > 0 ? ' plus accrued dividends' : '') + ', ahead of common' },
      { term: 'Participation', detail: PARTICIPATION_LABEL[s.participation] + (s.participation === 'capped' ? ' at ' + s.participationCap + '× the investment' : '') },
      { term: 'Conversion', detail: 'Convertible into common at any time at £' + s.conversionPrice.toFixed(4) + ' per share (ratio ' + conversionRatio(s).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + ':1)' },
      { term: 'Mandatory conversion', detail: 'Automatic on a qualified IPO or majority-of-preferred vote' },
      { term: 'Anti-dilution', detail: ANTIDILUTION_LABEL[s.antiDilution] },
      { term: 'Voting', detail: 'Votes with common on an as-converted basis' },
      { term: 'Issue date', detail: s.issueDate },
    ];
    return rows;
  }

  /* deterministic certificate number — FNV-1a over the identity fields */
  function certificateNo(s) {
    var str = s.company + '|' + s.seriesName + '|' + s.holder + '|' + sharesFor(s) + '|' + s.issueDate;
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return 'PCS-' + ('00000000' + h.toString(16).toUpperCase()).slice(-8);
  }

  return {
    PARTICIPATION: PARTICIPATION,
    ANTIDILUTION: ANTIDILUTION,
    PARTICIPATION_LABEL: PARTICIPATION_LABEL,
    ANTIDILUTION_LABEL: ANTIDILUTION_LABEL,
    round2: round2,
    money: money,
    qty: qty,
    normalize: normalize,
    pricePerShare: pricePerShare,
    sharesFor: sharesFor,
    postMoney: postMoney,
    conversionRatio: conversionRatio,
    asConvertedShares: asConvertedShares,
    prorataFrac: prorataFrac,
    accruedDividend: accruedDividend,
    preferenceAmount: preferenceAmount,
    waterfall: waterfall,
    breakevenExit: breakevenExit,
    downRound: downRound,
    payoutCurve: payoutCurve,
    capTable: capTable,
    termSheet: termSheet,
    certificateNo: certificateNo,
  };
});
