/* Reckon — the pure UK self-assessment tax engine.
 * =====================================================================
 * Reckon answers the one question every self-employed person dreads:
 * "how much of this money is actually mine?" Every rule lives HERE as
 * pure, deterministic, clock-injected functions with zero DOM and zero
 * I/O — the rate cards per tax year, income tax with the personal-
 * allowance taper, Class 4 (and post-2024 Class 2) National Insurance,
 * the trading-allowance-vs-expenses choice, HMRC mileage rates,
 * payments on account, the filing-deadline calendar, and the per-payment
 * "put this much aside" recommendation. Unit-tested in
 * scripts/test-reckon-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var DAY = 24 * 60 * 60 * 1000;

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function clampMoney(n) { n = Number(n); return isFinite(n) && n > 0 ? n : 0; }

  /* ---------------- rate cards ----------------
   * One card per tax year. Sources: HMRC published rates for each year.
   * Adding a year = adding a card; nothing else changes. */
  var RATES = {
    '2024-25': {
      year: '2024-25',
      start: { y: 2024, m: 4, d: 6 }, end: { y: 2025, m: 4, d: 5 },
      personalAllowance: 12570,
      taperFloor: 100000,          // allowance shrinks £1 per £2 above this
      basicBand: 37700,            // taxable income taxed at basicRate
      additionalOver: 125140,      // taxable income above this at additionalRate
      basicRate: 0.20, higherRate: 0.40, additionalRate: 0.45,
      class4: { lpl: 12570, upl: 50270, mainRate: 0.06, upperRate: 0.02 },
      class2: { weekly: 3.45, smallProfits: 6725, mandatory: false },
      tradingAllowance: 1000,
      mileage: { first: 0.45, after: 0.25, threshold: 10000 },
      poaThreshold: 1000,          // bill above this ⇒ payments on account
    },
    '2025-26': {
      year: '2025-26',
      start: { y: 2025, m: 4, d: 6 }, end: { y: 2026, m: 4, d: 5 },
      personalAllowance: 12570,
      taperFloor: 100000,
      basicBand: 37700,
      additionalOver: 125140,
      basicRate: 0.20, higherRate: 0.40, additionalRate: 0.45,
      class4: { lpl: 12570, upl: 50270, mainRate: 0.06, upperRate: 0.02 },
      class2: { weekly: 3.50, smallProfits: 6845, mandatory: false },
      tradingAllowance: 1000,
      mileage: { first: 0.45, after: 0.25, threshold: 10000 },
      poaThreshold: 1000,
    },
  };
  var DEFAULT_YEAR = '2025-26';

  function taxYears() { return Object.keys(RATES); }
  function rateCard(year) { return RATES[year] || RATES[DEFAULT_YEAR]; }

  // Which tax year a UTC timestamp falls in ('2025-26' for 2025-04-06 → 2026-04-05).
  function taxYearFor(now) {
    var d = new Date(now);
    var y = d.getUTCFullYear();
    var startY = (d.getUTCMonth() + 1 > 4 || (d.getUTCMonth() + 1 === 4 && d.getUTCDate() >= 6)) ? y : y - 1;
    var key = startY + '-' + String((startY + 1) % 100).padStart(2, '0');
    return RATES[key] ? key : DEFAULT_YEAR;
  }

  /* ---------------- deductions ---------------- */

  // HMRC simplified mileage: 45p for the first 10,000 business miles, 25p after.
  function mileageDeduction(miles, card) {
    card = card || rateCard();
    miles = clampMoney(miles);
    var m = card.mileage;
    var first = Math.min(miles, m.threshold);
    return round2(first * m.first + Math.max(0, miles - m.threshold) * m.after);
  }

  // Trading allowance is claimed INSTEAD of all expenses (incl. mileage) and
  // cannot create a loss. Returns whichever deduction leaves less tax to pay.
  function bestDeduction(income, expenses, miles, card) {
    card = card || rateCard();
    income = clampMoney(income);
    var actual = round2(clampMoney(expenses) + mileageDeduction(miles, card));
    var allowance = Math.min(card.tradingAllowance, income);
    return actual >= allowance
      ? { amount: actual, method: 'expenses' }
      : { amount: allowance, method: 'trading-allowance' };
  }

  /* ---------------- income tax ---------------- */

  // Personal allowance after the £100k taper: £1 lost per £2 of income above.
  function personalAllowance(income, card) {
    card = card || rateCard();
    var excess = Math.max(0, clampMoney(income) - card.taperFloor);
    return round2(Math.max(0, card.personalAllowance - excess / 2));
  }

  // Income tax on trading profit, banded. Returns the full band breakdown.
  function incomeTax(profit, card) {
    card = card || rateCard();
    profit = clampMoney(profit);
    var allowance = personalAllowance(profit, card);
    var taxable = round2(Math.max(0, profit - allowance));
    // Band edges are on taxable income; the additional-rate edge net of the
    // (fully tapered-away) allowance is simply the headline threshold.
    var basicTop = card.basicBand;
    var higherTop = card.additionalOver;
    var bands = [
      { name: 'basic', rate: card.basicRate, amount: round2(Math.min(taxable, basicTop)) },
      { name: 'higher', rate: card.higherRate, amount: round2(Math.max(0, Math.min(taxable, higherTop) - basicTop)) },
      { name: 'additional', rate: card.additionalRate, amount: round2(Math.max(0, taxable - higherTop)) },
    ].filter(function (b) { return b.amount > 0; });
    var total = 0;
    for (var i = 0; i < bands.length; i++) {
      bands[i].tax = round2(bands[i].amount * bands[i].rate);
      total += bands[i].tax;
    }
    return { allowance: allowance, taxable: taxable, bands: bands, total: round2(total) };
  }

  /* ---------------- National Insurance ---------------- */

  function class4NI(profit, card) {
    card = card || rateCard();
    profit = clampMoney(profit);
    var c = card.class4;
    var main = Math.max(0, Math.min(profit, c.upl) - c.lpl) * c.mainRate;
    var upper = Math.max(0, profit - c.upl) * c.upperRate;
    return round2(main + upper);
  }

  // Class 2 is abolished as a charge from April 2024: profits over the small-
  // profits threshold earn the NI credit free; below it, paying voluntarily
  // (52 × weekly) protects the State Pension record.
  function class2NI(profit, card) {
    card = card || rateCard();
    profit = clampMoney(profit);
    var c = card.class2;
    var credited = profit >= c.smallProfits;
    return {
      due: 0,
      credited: credited,
      voluntary: credited ? 0 : round2(c.weekly * 52),
      note: credited
        ? 'Profits are over the small-profits threshold — your NI record is credited automatically, nothing to pay.'
        : 'Profits are under £' + c.smallProfits + ' — consider paying voluntary Class 2 (£' + round2(c.weekly * 52) + '/yr) to protect your State Pension.',
    };
  }

  /* ---------------- the whole bill ---------------- */

  // What one extra pound of profit costs right now (tax + Class 4), including
  // the 60% trap where the allowance taper bites.
  function marginalRate(profit, card) {
    card = card || rateCard();
    var here = incomeTax(profit, card).total + class4NI(profit, card);
    var there = incomeTax(profit + 100, card).total + class4NI(profit + 100, card);
    return Math.max(0, Math.round(((there - here) / 100) * 1000) / 1000);
  }

  function computeBill(input) {
    input = input || {};
    var card = rateCard(input.taxYear);
    var income = clampMoney(input.income);
    var ded = bestDeduction(income, input.expenses, input.miles, card);
    var profit = round2(Math.max(0, income - ded.amount));
    var tax = incomeTax(profit, card);
    var ni4 = class4NI(profit, card);
    var ni2 = class2NI(profit, card);
    var total = round2(tax.total + ni4);
    return {
      taxYear: card.year,
      income: round2(income),
      deduction: ded.amount,
      deductionMethod: ded.method,
      profit: profit,
      allowance: tax.allowance,
      taxable: tax.taxable,
      bands: tax.bands,
      incomeTax: tax.total,
      class4: ni4,
      class2: ni2,
      total: total,
      takeHome: round2(profit - total),
      effectiveRate: profit > 0 ? Math.round((total / profit) * 1000) / 1000 : 0,
      marginalRate: marginalRate(profit, card),
      // pence to set aside per £1 that comes in (bill over gross income)
      setAsidePerPound: income > 0 ? Math.round((total / income) * 100) / 100 : 0,
    };
  }

  // How much of ONE new payment to put aside, given the year so far: the
  // marginal bill it creates, not the average — early pounds are allowance,
  // later pounds are 40%.
  function setAsideForPayment(payment, ytd, taxYear) {
    payment = clampMoney(payment);
    ytd = ytd || {};
    var before = computeBill({ income: ytd.income, expenses: ytd.expenses, miles: ytd.miles, taxYear: taxYear });
    var after = computeBill({
      income: clampMoney(ytd.income) + payment,
      expenses: ytd.expenses, miles: ytd.miles, taxYear: taxYear,
    });
    var extra = round2(Math.max(0, after.total - before.total));
    return {
      payment: round2(payment),
      setAside: extra,
      keep: round2(payment - extra),
      rate: payment > 0 ? Math.round((extra / payment) * 100) / 100 : 0,
      billAfter: after.total,
    };
  }

  /* ---------------- payments on account ---------------- */

  // HMRC schedule: if last year's bill was over the threshold you have already
  // been charged two 50% payments on account toward this year; this year's
  // balancing payment settles the difference on 31 Jan, alongside the first
  // 50% POA for next year, with the second the following 31 July.
  function paymentSchedule(thisYearBill, lastYearBill, taxYear) {
    var card = rateCard(taxYear);
    thisYearBill = round2(clampMoney(thisYearBill));
    lastYearBill = round2(clampMoney(lastYearBill));
    var paidOnAccount = lastYearBill > card.poaThreshold ? lastYearBill : 0;
    var balancing = round2(thisYearBill - paidOnAccount); // negative = refund
    var poaNext = thisYearBill > card.poaThreshold ? round2(thisYearBill / 2) : 0;
    return {
      paidOnAccount: paidOnAccount,
      balancing: balancing,
      poaNext: poaNext,
      january: round2(Math.max(0, balancing) + poaNext),
      july: poaNext,
      refund: balancing < 0 ? round2(-balancing) : 0,
    };
  }

  /* ---------------- deadlines (clock-injected) ---------------- */

  // The recurring self-assessment calendar, as the NEXT occurrence of each
  // deadline at `now` (UTC ms), soonest first.
  function deadlines(now) {
    var d = new Date(now);
    var y = d.getUTCFullYear();
    function next(m, day) { // next occurrence of a fixed month/day, UTC
      var t = Date.UTC(y, m - 1, day);
      return t >= now ? t : Date.UTC(y + 1, m - 1, day);
    }
    var yearEndingBefore = function (ts) { // the tax year a deadline settles
      return taxYearFor(ts - 365 * DAY);
    };
    var list = [
      { id: 'register', label: 'Register for self-assessment', ts: next(10, 5),
        detail: 'Deadline to tell HMRC you were self-employed in the tax year that ended 5 April.' },
      { id: 'paper', label: 'Paper tax return', ts: next(10, 31),
        detail: 'Only if you file on paper — online buys you three more months.' },
      { id: 'online', label: 'Online return + pay your bill', ts: next(1, 31),
        detail: 'File the ' + yearEndingBefore(next(1, 31)) + ' return, pay the balance and the first payment on account.' },
      { id: 'poa2', label: 'Second payment on account', ts: next(7, 31),
        detail: 'The second 50% instalment toward the current year’s bill.' },
    ];
    list.sort(function (a, b) { return a.ts - b.ts; });
    for (var i = 0; i < list.length; i++) {
      list[i].daysLeft = Math.ceil((list[i].ts - now) / DAY);
    }
    return list;
  }

  /* ---------------- formatting ---------------- */

  function fmtGBP(n) {
    n = round2(n);
    var neg = n < 0; n = Math.abs(n);
    var s = n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (s.slice(-3) === '.00') s = s.slice(0, -3);
    return (neg ? '−£' : '£') + s;
  }

  function fmtPct(r) { return (Math.round(r * 1000) / 10) + '%'; }

  var api = {
    DAY: DAY,
    RATES: RATES,
    DEFAULT_YEAR: DEFAULT_YEAR,
    taxYears: taxYears,
    rateCard: rateCard,
    taxYearFor: taxYearFor,
    round2: round2,
    mileageDeduction: mileageDeduction,
    bestDeduction: bestDeduction,
    personalAllowance: personalAllowance,
    incomeTax: incomeTax,
    class4NI: class4NI,
    class2NI: class2NI,
    marginalRate: marginalRate,
    computeBill: computeBill,
    setAsideForPayment: setAsideForPayment,
    paymentSchedule: paymentSchedule,
    deadlines: deadlines,
    fmtGBP: fmtGBP,
    fmtPct: fmtPct,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ReckonEngine = api;
})(typeof self !== 'undefined' ? self : this);
