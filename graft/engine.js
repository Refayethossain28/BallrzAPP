/**
 * Graft — the income engine
 * =========================
 *
 * "Generate income for me." No app can conjure money — anything that claims to
 * is a scam. What an app *can* do is shorten the honest path from what you
 * already have (hours, skills, a bit of cash) to money actually arriving:
 *
 *      hours + skills + start-cash ──▶ the right hustle ──▶ a plan ──▶
 *      logged earnings ──▶ an invoice that gets you paid
 *
 * Graft is the active-income sibling of Drip (the passive income engine).
 * Drip models money that works while you sleep; Graft is for money you go
 * out and earn. Four pieces, all pure and deterministic:
 *
 *   HUSTLES      an honest catalog of real UK side hustles — realistic £/hr
 *                ranges (not "£10k/mo with AI" nonsense), true start-up
 *                costs, and how long until the first pound actually lands
 *   recommend()  scores the catalog against *your* profile — hours a week,
 *                cash to start, skills, and whether you want fast cash or
 *                something that scales
 *   plan()       turns a monthly target into a weekly hours plan across the
 *                hustles you picked, highest £/hr first, and says plainly
 *                whether the target is feasible in your hours
 *   tracker      month totals, effective £/hr, best earner and a weekly
 *                streak from the earnings you log
 *   invoice      line-item totals with discount and VAT, and a stable
 *                invoice reference — because earning it is half the job;
 *                billing for it is the other half
 *   tradingAllowance()  the honest UK tax note: the first £1,000/yr of
 *                trading income is tax-free; above that you must report
 *
 * Everything is deterministic: no Date.now(), no randomness — "today" is
 * always a parameter, which is what makes the maths unit-testable.
 *
 * Rate conventions (stated so the tests can pin them):
 *   • a week of hustle hours converts to a month as ×52/12 (not ×4)
 *   • effective £/hr = earned ÷ hours over the same window
 *   • VAT applies after the discount, on the discounted subtotal
 *
 * UMD so it runs in the browser (window.Graft) and under Node/vm for tests —
 * same pattern as drip/engine.js. Framework-free, dependency-free.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Graft = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var round2 = function (x) { return Math.round(x * 100) / 100; };
  var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };

  /** £-formatter without Intl (the smoke sandbox has no Intl, and neither do
   *  some older WebViews). money(1234.5) → '£1,234.50'; money(1200, true) → '£1,200'. */
  function money(x, whole) {
    x = Number(x) || 0;
    var neg = x < 0; if (neg) x = -x;
    var s = whole ? String(Math.round(x)) : x.toFixed(2);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '−£' : '£') + parts.join('.');
  }

  /* ------------------------------------------------------------------ *
   *  The catalog — honest numbers, stated ranges, real start-up costs.
   *  rate: [low, high] £/hr you can realistically expect once going.
   *  startCost: £ to get started properly. firstPayDays: typical days
   *  until the FIRST pound lands. scalable 0..1: how far past trading
   *  hours-for-pounds this can grow. skills: what it leans on ([] = anyone).
   * ------------------------------------------------------------------ */
  var HUSTLES = [
    { id: 'delivery',    name: 'Food & parcel delivery',      icon: '🛵', cat: 'gig',
      rate: [9, 16],  startCost: 60,  firstPayDays: 7,  scalable: 0.1,  skills: ['driving'],
      blurb: 'Deliveroo, Uber Eats, Just Eat, Amazon Flex. Sign up, pass checks, earn this week. Evenings and weekends pay best.' },
    { id: 'dogwalking',  name: 'Dog walking & pet sitting',   icon: '🐕', cat: 'local',
      rate: [10, 20], startCost: 0,   firstPayDays: 7,  scalable: 0.25, skills: [],
      blurb: 'Rover, Tailster, or just your neighbourhood. Walk two dogs at once and the £/hr doubles.' },
    { id: 'carvaleting', name: 'Mobile car valeting',         icon: '🚿', cat: 'local',
      rate: [15, 30], startCost: 150, firstPayDays: 7,  scalable: 0.3,  skills: [],
      blurb: 'A kit, a bucket and a postcode. £25–60 a car, driveway to driveway. Repeat customers are the whole game.' },
    { id: 'flipping',    name: 'Reselling & flipping',        icon: '📦', cat: 'sell',
      rate: [10, 30], startCost: 100, firstPayDays: 7,  scalable: 0.6,  skills: [],
      blurb: 'Buy under-priced (car boots, marketplace, clearance), sell right (eBay, Vinted, Depop). Margin is made when you buy.' },
    { id: 'marketstall', name: 'Market stall / baking',       icon: '🧁', cat: 'sell',
      rate: [8, 20],  startCost: 150, firstPayDays: 7,  scalable: 0.3,  skills: ['cooking'],
      blurb: 'Weekend markets, food fairs, school fetes. Register as a food business (free) if you sell food.' },
    { id: 'handyman',    name: 'Handyman & assembly jobs',    icon: '🔧', cat: 'local',
      rate: [15, 40], startCost: 100, firstPayDays: 10, scalable: 0.2,  skills: ['diy'],
      blurb: 'TaskRabbit, Airtasker: flat-pack, mounting, small fixes. Reviews compound — the first five jobs set your rate.' },
    { id: 'tutoring',    name: 'Online & local tutoring',     icon: '📚', cat: 'freelance',
      rate: [15, 40], startCost: 0,   firstPayDays: 14, scalable: 0.4,  skills: ['teaching'],
      blurb: 'MyTutor, Tutorful, or direct. GCSE maths/science and 11+ are in constant demand. Group sessions scale the £/hr.' },
    { id: 'va',          name: 'Virtual assistant',           icon: '🗂️', cat: 'freelance',
      rate: [12, 25], startCost: 0,   firstPayDays: 14, scalable: 0.3,  skills: ['admin'],
      blurb: 'Inbox, diary, bookings, invoicing for small businesses. Start on Upwork/PeoplePerHour, move clients to retainers.' },
    { id: 'spacerental', name: 'Rent out what you own',       icon: '🏠', cat: 'sell',
      rate: [5, 25],  startCost: 0,   firstPayDays: 14, scalable: 0.7,  skills: [],
      blurb: 'Spare room (Rent a Room: first £7,500/yr tax-free), driveway (JustPark), tools & gear (Fat Llama). Assets you already have.' },
    { id: 'writing',     name: 'Copy & content writing',      icon: '✍️', cat: 'freelance',
      rate: [15, 45], startCost: 0,   firstPayDays: 21, scalable: 0.5,  skills: ['writing'],
      blurb: 'Web copy, product descriptions, newsletters, case studies. Niche beats generalist — pick an industry you know.' },
    { id: 'design',      name: 'Design & branding gigs',      icon: '🎨', cat: 'freelance',
      rate: [20, 60], startCost: 0,   firstPayDays: 21, scalable: 0.5,  skills: ['design'],
      blurb: 'Logos, decks, social kits, packaging. A portfolio of three fake-brand projects beats an empty "I do design".' },
    { id: 'socialmedia', name: 'Social media management',     icon: '📱', cat: 'freelance',
      rate: [15, 35], startCost: 0,   firstPayDays: 21, scalable: 0.55, skills: ['social'],
      blurb: 'Local businesses will pay monthly for someone to just *do it*. Three clients on retainer is a real income.' },
    { id: 'photography', name: 'Event & portrait photography', icon: '📷', cat: 'freelance',
      rate: [20, 60], startCost: 300, firstPayDays: 21, scalable: 0.4,  skills: ['photo'],
      blurb: 'Headshots, small events, property photos for agents. If you already own a camera the start cost is ~£0.' },
    { id: 'webdev',      name: 'Freelance web development',   icon: '💻', cat: 'freelance',
      rate: [25, 75], startCost: 0,   firstPayDays: 30, scalable: 0.6,  skills: ['coding'],
      blurb: 'Sites, fixes, automations, Shopify. The highest floor in the catalog — slow to land the first client, then compounding.' },
    { id: 'privatehire', name: 'Private-hire driving',        icon: '🚘', cat: 'gig',
      rate: [12, 22], startCost: 400, firstPayDays: 30, scalable: 0.15, skills: ['driving'],
      blurb: 'Uber/Bolt or a local operator. Licence + checks take weeks and cost real money — steady after that.' },
    { id: 'printondemand', name: 'Print-on-demand shop',      icon: '👕', cat: 'digital',
      rate: [5, 20],  startCost: 30,  firstPayDays: 45, scalable: 0.8,  skills: ['design'],
      blurb: 'Designs on shirts/mugs via Printful or Redbubble — no stock. Honest read: most shops earn little; the win is upside, not wages.' },
    { id: 'digitalproducts', name: 'Digital products & templates', icon: '💾', cat: 'digital',
      rate: [5, 40],  startCost: 0,   firstPayDays: 60, scalable: 0.9,  skills: ['coding', 'design', 'writing'],
      blurb: 'Notion templates, spreadsheets, presets, plugins on Gumroad/Etsy. Make it once, sell it forever — but the first sale is slow.' },
    { id: 'course',      name: 'Online course / YouTube',     icon: '🎬', cat: 'digital',
      rate: [3, 50],  startCost: 50,  firstPayDays: 90, scalable: 0.95, skills: ['teaching', 'video'],
      blurb: 'The slowest first pound in the catalog and the highest ceiling. Only pick this alongside something that pays now.' }
  ];

  /** Skill tags the catalog leans on — the UI renders these as chips. */
  var SKILLS = ['driving', 'writing', 'coding', 'design', 'teaching', 'admin', 'diy', 'photo', 'social', 'video', 'cooking'];

  var byId = {};
  for (var i = 0; i < HUSTLES.length; i++) byId[HUSTLES[i].id] = HUSTLES[i];
  function hustle(id) { return byId[id] || null; }

  var rateMid = function (h) { return (h.rate[0] + h.rate[1]) / 2; };

  /* ------------------------------------------------------------------ *
   *  The matcher
   * ------------------------------------------------------------------ */

  /**
   * Score one hustle 0..100 against a profile:
   *   { hoursWeekly, cash, wants: 'fast'|'scale', skills: ['coding', ...] }
   *
   * Weighted blend, normalised so a perfect fit is 100:
   *   pay     ×35  — mid £/hr against a £40/hr ceiling
   *   speed   ×30 (fast) / ×10 (scale) — days to first pound vs a 90-day worst case
   *   scale   ×30 (scale) / ×10 (fast) — the hustle's scalability
   *   skills  ×20 — 1 if you have a listed skill, 0.7 if none required, 0.15 mismatch
   * Then, if you can't afford the start cost, the whole score is cut to 35% —
   * unaffordable is a fact, not a preference.
   */
  function matchScore(h, profile) {
    var p = profile || {};
    var wants = p.wants === 'scale' ? 'scale' : 'fast';
    var pay = clamp01(rateMid(h) / 40);
    var speed = 1 - clamp01(h.firstPayDays / 90);
    var scale = clamp01(h.scalable);
    var skills = p.skills || [];
    var needs = h.skills || [];
    var skill = needs.length === 0 ? 0.7 : 0.15;
    for (var i = 0; i < needs.length; i++) if (skills.indexOf(needs[i]) !== -1) { skill = 1; break; }
    var sw = wants === 'fast' ? 30 : 10;
    var cw = wants === 'scale' ? 30 : 10;
    var total = (pay * 35 + speed * sw + scale * cw + skill * 20) / (35 + sw + cw + 20);
    var affordable = h.startCost <= (Number(p.cash) || 0);
    if (!affordable) total *= 0.35;
    return Math.round(total * 100);
  }

  /**
   * Rank the whole catalog for a profile. Returns [{ hustle, score, affordable,
   * reasons: [...] }] sorted best-first (ties break on faster first pound).
   */
  function recommend(profile) {
    var p = profile || {};
    var cash = Number(p.cash) || 0;
    var out = [];
    for (var i = 0; i < HUSTLES.length; i++) {
      var h = HUSTLES[i];
      var reasons = [];
      if (h.firstPayDays <= 7) reasons.push('first £ within a week');
      if (h.startCost === 0) reasons.push('£0 to start');
      else if (h.startCost > cash) reasons.push('needs ' + money(h.startCost, true) + ' to start');
      if (h.scalable >= 0.6) reasons.push('scales past hours-for-£');
      var needs = h.skills || [];
      for (var k = 0; k < needs.length; k++) {
        if ((p.skills || []).indexOf(needs[k]) !== -1) { reasons.push('uses your ' + needs[k]); break; }
      }
      out.push({ hustle: h, score: matchScore(h, p), affordable: h.startCost <= cash, reasons: reasons });
    }
    out.sort(function (a, b) {
      return (b.score - a.score) || (a.hustle.firstPayDays - b.hustle.firstPayDays) ||
             (a.hustle.id < b.hustle.id ? -1 : 1);
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   *  The planner
   * ------------------------------------------------------------------ */

  var weeklyToMonthly = function (weeklyGBP) { return weeklyGBP * 52 / 12; };

  /**
   * Turn a monthly target into a weekly hours plan.
   *   target       £/month you want
   *   picks        [{ id, rate, capWeekly? }] — your hustles, your honest £/hr,
   *                and an optional cap on hours/week you'll give each one
   *   hoursWeekly  total hours/week you actually have
   *
   * Allocation is greedy by £/hr (highest first) — the arithmetic of "least
   * hours to hit the number". Returns rows with hours & expected £/mo, plus
   * feasible / shortfall / spare hours so the UI can be honest about the gap.
   */
  function plan(target, picks, hoursWeekly) {
    target = Math.max(0, Number(target) || 0);
    var budget = Math.max(0, Number(hoursWeekly) || 0);
    var sorted = (picks || []).slice().filter(function (pk) { return (Number(pk.rate) || 0) > 0; });
    sorted.sort(function (a, b) { return (b.rate - a.rate) || (a.id < b.id ? -1 : 1); });

    var rows = [], monthly = 0, hoursUsed = 0;
    for (var i = 0; i < sorted.length; i++) {
      var pk = sorted[i];
      var rate = Number(pk.rate) || 0;
      var cap = pk.capWeekly == null ? Infinity : Math.max(0, Number(pk.capWeekly) || 0);
      var remainingGBP = target - monthly;
      if (remainingGBP <= 0 || budget - hoursUsed <= 0) {
        rows.push({ id: pk.id, rate: rate, hoursWeekly: 0, monthly: 0 });
        continue;
      }
      // hours/week needed for the remaining £/mo at this rate
      var need = (remainingGBP * 12 / 52) / rate;
      var hrs = Math.min(need, cap, budget - hoursUsed);
      hrs = Math.round(hrs * 10) / 10; // tenth-of-an-hour granularity
      var m = round2(weeklyToMonthly(hrs * rate));
      rows.push({ id: pk.id, rate: rate, hoursWeekly: hrs, monthly: m });
      monthly += m;
      hoursUsed = Math.round((hoursUsed + hrs) * 10) / 10;
    }
    monthly = round2(monthly);
    var shortfall = round2(Math.max(0, target - monthly));
    // Tenth-of-an-hour rounding can leave a few pence of "shortfall" on a
    // perfectly feasible plan — treat within-a-pound-ish as hit.
    var feasible = target === 0 || shortfall <= Math.max(1, target * 0.005);
    return {
      rows: rows, monthly: monthly, hoursUsed: hoursUsed,
      hoursSpare: Math.round((budget - hoursUsed) * 10) / 10,
      feasible: feasible, shortfall: feasible ? 0 : shortfall
    };
  }

  /* ------------------------------------------------------------------ *
   *  The tracker — entries are { id, dateISO: 'YYYY-MM-DD', hustleId,
   *  amount, hours }. "Today" is always passed in, never read from a clock.
   * ------------------------------------------------------------------ */

  var monthKey = function (iso) { return String(iso || '').slice(0, 7); };

  /** Totals for one month key ('2026-07'): earned, hours, effective £/hr, per-hustle split. */
  function monthTotals(entries, mk) {
    var earned = 0, hours = 0, byHustle = {};
    for (var i = 0; i < (entries || []).length; i++) {
      var e = entries[i];
      if (monthKey(e.dateISO) !== mk) continue;
      var amt = Number(e.amount) || 0;
      earned += amt;
      hours += Number(e.hours) || 0;
      byHustle[e.hustleId] = round2((byHustle[e.hustleId] || 0) + amt);
    }
    return {
      earned: round2(earned), hours: Math.round(hours * 10) / 10,
      rate: hours > 0 ? round2(earned / hours) : 0, byHustle: byHustle
    };
  }

  /** The hustle id that earned most in a month (null if nothing logged). */
  function bestEarner(entries, mk) {
    var by = monthTotals(entries, mk).byHustle;
    var best = null, top = 0;
    for (var id in by) if (by[id] > top) { top = by[id]; best = id; }
    return best;
  }

  /** Sum of all logged earnings in a calendar year ('2026') — feeds the tax note. */
  function yearTotal(entries, year) {
    var earned = 0;
    for (var i = 0; i < (entries || []).length; i++) {
      if (String(entries[i].dateISO || '').slice(0, 4) === String(year)) earned += Number(entries[i].amount) || 0;
    }
    return round2(earned);
  }

  /** ISO-8601 week key for a date string — deterministic, no locale, no Intl.
   *  weekKey('2026-01-01') → '2026-W01' (the Thursday rule). */
  function weekKey(iso) {
    var p = String(iso).split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    var day = d.getUTCDay() || 7;             // Mon=1..Sun=7
    d.setUTCDate(d.getUTCDate() + 4 - day);   // shift to this week's Thursday
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    var week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return d.getUTCFullYear() + '-W' + (week < 10 ? '0' : '') + week;
  }

  /** Days shift on a calendar date, ISO in → ISO out (UTC, DST-proof). */
  function isoShiftDays(iso, days) {
    var p = String(iso).split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + days));
    var mm = d.getUTCMonth() + 1, dd = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
  }

  /**
   * Consecutive weeks (ending at today's week) with at least one entry.
   * The current week counts if it has an entry; an empty current week doesn't
   * break a streak that ran up to last week — you might just not have logged yet.
   */
  function streakWeeks(entries, todayISO) {
    var weeks = {};
    for (var i = 0; i < (entries || []).length; i++) weeks[weekKey(entries[i].dateISO)] = true;
    var streak = 0;
    var cursor = String(todayISO);
    if (!weeks[weekKey(cursor)]) cursor = isoShiftDays(cursor, -7); // grace for the current week
    while (weeks[weekKey(cursor)]) { streak++; cursor = isoShiftDays(cursor, -7); }
    return streak;
  }

  /* ------------------------------------------------------------------ *
   *  The invoice — because "generate income" ends with getting paid.
   * ------------------------------------------------------------------ */

  /**
   * Totals for invoice lines [{ desc, qty, unit }] with optional
   * { discountPct, vatPct }. VAT applies to the discounted subtotal.
   */
  function invoiceTotals(lines, opts) {
    var o = opts || {};
    var subtotal = 0;
    for (var i = 0; i < (lines || []).length; i++) {
      subtotal += (Number(lines[i].qty) || 0) * (Number(lines[i].unit) || 0);
    }
    var discount = subtotal * clamp01((Number(o.discountPct) || 0) / 100);
    var net = subtotal - discount;
    var vat = net * Math.max(0, (Number(o.vatPct) || 0)) / 100;
    return {
      subtotal: round2(subtotal), discount: round2(discount),
      net: round2(net), vat: round2(vat), total: round2(net + vat)
    };
  }

  /** Stable reference: invoiceRef(7, '2026-07-28') → 'INV-2026-007'. */
  function invoiceRef(seq, dateISO) {
    var n = Math.max(1, Math.round(Number(seq) || 1));
    var s = String(n); while (s.length < 3) s = '0' + s;
    return 'INV-' + String(dateISO).slice(0, 4) + '-' + s;
  }

  /* ------------------------------------------------------------------ *
   *  The honest tax note — UK trading allowance.
   * ------------------------------------------------------------------ */

  /**
   * First £1,000/yr of trading income is tax-free (UK trading allowance);
   * above it you must register for Self Assessment. Not tax advice — a nudge.
   */
  function tradingAllowance(annualGBP) {
    var a = Math.max(0, Number(annualGBP) || 0);
    return {
      allowance: 1000,
      taxFree: round2(Math.min(a, 1000)),
      above: round2(Math.max(0, a - 1000)),
      mustReport: a > 1000
    };
  }

  return {
    HUSTLES: HUSTLES, SKILLS: SKILLS, hustle: hustle, rateMid: rateMid,
    matchScore: matchScore, recommend: recommend,
    plan: plan, weeklyToMonthly: weeklyToMonthly,
    monthKey: monthKey, monthTotals: monthTotals, bestEarner: bestEarner,
    yearTotal: yearTotal, weekKey: weekKey, isoShiftDays: isoShiftDays,
    streakWeeks: streakWeeks,
    invoiceTotals: invoiceTotals, invoiceRef: invoiceRef,
    tradingAllowance: tradingAllowance, money: money
  };
});
