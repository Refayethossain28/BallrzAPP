/**
 * Velvet — the Membership Engine
 * ==============================
 *
 * The deterministic core of Velvet, the all-in-one VIP concierge. Everything
 * that involves money, entitlements or state lives here — pure functions of
 * (state, now) — so the subscription business model is auditable and
 * unit-testable rather than scattered through UI handlers.
 *
 * What it owns
 * ------------
 *   Tiers          Silver / Gold / Black — price, request quota, first-response
 *                  SLA, points multiplier, perks. The product IS the tier list.
 *   Subscription   7-day free trial → 30-day billing periods. Renewal rolls
 *                  periods forward and emits invoices; cancel takes effect at
 *                  period end (resume undoes it); upgrades apply immediately
 *                  with a prorated charge, downgrades apply at renewal.
 *   Quota          Requests per 30-day period, per tier (Black is unlimited).
 *   Requests       A strict lifecycle state machine:
 *                  submitted → triaged → sourcing → options → confirmed → completed,
 *                  cancellable any time before confirmation.
 *   SLA            First-response deadline per tier (Black 15 min → Silver 4 h),
 *                  with met / ok / warning / breached states.
 *   Priority       Queue ordering = tier rank first, then time waited.
 *   Desk           A deterministic concierge-desk simulator: staged progress
 *                  delays (faster for higher tiers), scripted desk messages and
 *                  three seeded, priced options per request — same request id
 *                  always yields the same options.
 *   Points         1 pt per £1 spent × tier multiplier, with named status
 *                  levels (Member → Insider → Icon → Legend).
 *
 * All money is integer pence. All times are epoch ms and `now` is always an
 * argument — the engine never reads the clock, so the same inputs always give
 * the same answer. UMD so it runs in the browser (window.Velvet) and under
 * Node/vm for tests — same pattern as cusp/engine.js.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Velvet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN = 60000, DAY = 86400000;
  var PERIOD_DAYS = 30, TRIAL_DAYS = 7;

  /* ------------------------------------------------------------------ *
   *  Tiers — the product                                                *
   * ------------------------------------------------------------------ */
  var TIERS = {
    silver: {
      id: 'silver', name: 'Silver', rank: 1, pricePence: 4900,
      requestsPerMonth: 5, slaMinutes: 240, pointsMultiplier: 1,
      tagline: 'Your life, handled.',
      perks: ['5 requests / month', 'First response within 4 hours',
              'All 8 concierge services', '1 point per £1 spent'],
    },
    gold: {
      id: 'gold', name: 'Gold', rank: 2, pricePence: 19900,
      requestsPerMonth: 20, slaMinutes: 60, pointsMultiplier: 1.5,
      tagline: 'Skip every queue.',
      perks: ['20 requests / month', 'First response within 1 hour',
              'Priority over Silver members', '1.5× points on everything',
              'Dedicated dining & events desk'],
    },
    black: {
      id: 'black', name: 'Black', rank: 3, pricePence: 49900,
      requestsPerMonth: null, slaMinutes: 15, pointsMultiplier: 2,
      tagline: 'Nothing is unavailable.',
      perks: ['Unlimited requests', 'First response within 15 minutes',
              'Front of every queue, 24/7', '2× points on everything',
              'Off-market access: sold-out tables, closed doors'],
    },
  };
  var TIER_ORDER = ['silver', 'gold', 'black'];

  function tier(id) {
    var t = TIERS[id];
    if (!t) throw new Error('unknown tier: ' + id);
    return t;
  }

  /* ------------------------------------------------------------------ *
   *  Subscription lifecycle                                             *
   * ------------------------------------------------------------------ */

  /** Start a membership on a 7-day free trial. No charge until the trial ends. */
  function startSubscription(tierId, now) {
    tier(tierId); // validate
    return {
      tierId: tierId,
      status: 'trialing',              // trialing | active | canceled
      startedAt: now,
      periodStart: now,
      periodEnd: now + TRIAL_DAYS * DAY,
      cancelAtPeriodEnd: false,
      pendingTierId: null,             // downgrade waiting for renewal
      endedAt: null,
    };
  }

  /**
   * Roll the subscription forward to `now`. Each elapsed period boundary either
   * ends the membership (if cancellation was scheduled) or renews it — applying
   * any pending downgrade and emitting an invoice for the new period.
   * Pure: returns { sub, invoices } without touching the input.
   */
  function advance(sub, now) {
    var s = Object.assign({}, sub);
    var invoices = [];
    while (s.status !== 'canceled' && now >= s.periodEnd) {
      if (s.cancelAtPeriodEnd) {
        s.status = 'canceled';
        s.endedAt = s.periodEnd;
        break;
      }
      if (s.pendingTierId) { s.tierId = s.pendingTierId; s.pendingTierId = null; }
      var t = tier(s.tierId);
      var start = s.periodEnd;
      s.status = 'active';
      s.periodStart = start;
      s.periodEnd = start + PERIOD_DAYS * DAY;
      invoices.push({
        tierId: t.id, amountPence: t.pricePence, at: start,
        periodStart: start, periodEnd: s.periodEnd,
        description: t.name + ' membership — 30 days',
      });
    }
    return { sub: s, invoices: invoices };
  }

  /** Unused fraction of the current period, clamped to [0,1]. */
  function remainingFraction(sub, now) {
    var len = sub.periodEnd - sub.periodStart;
    if (len <= 0) return 0;
    var f = (sub.periodEnd - now) / len;
    return Math.min(1, Math.max(0, f));
  }

  /** Prorated charge (pence) to move up a tier for the rest of the period. Never negative. */
  function prorationPence(fromTierId, toTierId, sub, now) {
    var diff = tier(toTierId).pricePence - tier(fromTierId).pricePence;
    return Math.max(0, Math.round(diff * remainingFraction(sub, now)));
  }

  /**
   * Change tier. Upgrades are immediate: on a paid plan you pay the prorated
   * difference now (an invoice is returned); on trial you just switch — the
   * first charge lands at trial end. Downgrades are scheduled for renewal so
   * the member keeps what they paid for. Returns { sub, invoice|null }.
   */
  function changeTier(sub, newTierId, now) {
    var to = tier(newTierId);
    var s = Object.assign({}, sub);
    if (s.status === 'canceled') throw new Error('membership has ended');
    if (newTierId === s.tierId) { s.pendingTierId = null; return { sub: s, invoice: null }; }
    var from = tier(s.tierId);
    if (to.rank > from.rank) {                         // upgrade — immediate
      var charge = s.status === 'trialing' ? 0 : prorationPence(s.tierId, newTierId, s, now);
      s.tierId = newTierId;
      s.pendingTierId = null;
      var invoice = charge > 0 ? {
        tierId: newTierId, amountPence: charge, at: now,
        periodStart: now, periodEnd: s.periodEnd,
        description: 'Upgrade to ' + to.name + ' — prorated for ' +
                     Math.ceil((s.periodEnd - now) / DAY) + ' days',
      } : null;
      return { sub: s, invoice: invoice };
    }
    s.pendingTierId = newTierId;                       // downgrade — at renewal
    return { sub: s, invoice: null };
  }

  /** Schedule cancellation at period end. Membership stays live until then. */
  function cancel(sub) {
    return Object.assign({}, sub, { cancelAtPeriodEnd: true });
  }

  /** Undo a scheduled cancellation (only before the period actually ends). */
  function resume(sub) {
    if (sub.status === 'canceled') throw new Error('membership has ended');
    return Object.assign({}, sub, { cancelAtPeriodEnd: false });
  }

  function isLive(sub) { return !!sub && sub.status !== 'canceled'; }

  function trialDaysLeft(sub, now) {
    if (sub.status !== 'trialing') return 0;
    return Math.max(0, Math.ceil((sub.periodEnd - now) / DAY));
  }

  /* ------------------------------------------------------------------ *
   *  Quota                                                              *
   * ------------------------------------------------------------------ */

  /** Requests consumed in the current period. Cancelled requests are refunded. */
  function usedInPeriod(requests, periodStart, periodEnd) {
    var n = 0;
    for (var i = 0; i < requests.length; i++) {
      var r = requests[i];
      if (r.submittedAt >= periodStart && r.submittedAt < periodEnd && r.status !== 'cancelled') n++;
    }
    return n;
  }

  /** Requests left this period — null means unlimited (Black). */
  function remainingQuota(tierId, used) {
    var q = tier(tierId).requestsPerMonth;
    return q == null ? null : Math.max(0, q - used);
  }

  function canSubmit(tierId, used) {
    var left = remainingQuota(tierId, used);
    return left == null || left > 0;
  }

  /* ------------------------------------------------------------------ *
   *  Concierge services                                                 *
   * ------------------------------------------------------------------ */
  var CATEGORIES = [
    { id: 'travel',    name: 'Travel',            emoji: '✈️', blurb: 'Flights, suites, itineraries' },
    { id: 'dining',    name: 'Dining',            emoji: '🍽️', blurb: 'Impossible tables, private chefs' },
    { id: 'events',    name: 'Events & tickets',  emoji: '🎟️', blurb: 'Sold-out shows, boxes, premieres' },
    { id: 'chauffeur', name: 'Chauffeur',         emoji: '🚗', blurb: 'Cars on call, airport runs' },
    { id: 'shopping',  name: 'Personal shopping', emoji: '🛍️', blurb: 'Sourcing, styling, waitlists' },
    { id: 'home',      name: 'Home & errands',    emoji: '🏠', blurb: 'Trades, deliveries, day-to-day' },
    { id: 'wellness',  name: 'Wellness',          emoji: '💆', blurb: 'Spas, trainers, retreats' },
    { id: 'gifting',   name: 'Gifting',           emoji: '🎁', blurb: 'The perfect thing, wrapped' },
  ];
  function category(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
    throw new Error('unknown category: ' + id);
  }

  /* ------------------------------------------------------------------ *
   *  Request lifecycle                                                  *
   * ------------------------------------------------------------------ */
  var FLOW = ['submitted', 'triaged', 'sourcing', 'options', 'confirmed', 'completed'];
  var STATUS_LABEL = {
    submitted: 'Received', triaged: 'With your concierge', sourcing: 'Sourcing',
    options: 'Options ready', confirmed: 'Confirmed', completed: 'Completed',
    cancelled: 'Cancelled',
  };

  function canTransition(from, to) {
    var i = FLOW.indexOf(from);
    if (to === 'cancelled') return i >= 0 && i < FLOW.indexOf('confirmed');
    return i >= 0 && FLOW[i + 1] === to;
  }

  /** Apply a transition or throw — the UI can never invent an illegal state. */
  function transition(request, to, now) {
    if (!canTransition(request.status, to)) {
      throw new Error('illegal transition ' + request.status + ' → ' + to);
    }
    var r = Object.assign({}, request, { status: to, updatedAt: now });
    if (to === 'triaged' && r.firstResponseAt == null) r.firstResponseAt = now;
    if (to === 'completed') r.completedAt = now;
    return r;
  }

  /* ------------------------------------------------------------------ *
   *  SLA — first response, per tier                                     *
   * ------------------------------------------------------------------ */
  function slaDeadline(submittedAt, tierId) {
    return submittedAt + tier(tierId).slaMinutes * MIN;
  }

  /** met | breached (after response) · ok | warning | breached (still waiting). */
  function slaState(submittedAt, tierId, now, firstResponseAt) {
    var deadline = slaDeadline(submittedAt, tierId);
    if (firstResponseAt != null) return firstResponseAt <= deadline ? 'met' : 'breached';
    if (now > deadline) return 'breached';
    var window = deadline - submittedAt;
    return (deadline - now) < 0.25 * window ? 'warning' : 'ok';
  }

  /* ------------------------------------------------------------------ *
   *  Priority queue — tier first, then patience                         *
   * ------------------------------------------------------------------ */
  function priorityScore(request, tierRank, now) {
    var waitedMin = Math.max(0, (now - request.submittedAt) / MIN);
    return tierRank * 100000 + waitedMin;
  }

  /** Highest priority first. A Black member always outranks a Gold one. */
  function queueOrder(entries, now) {
    return entries.slice().sort(function (a, b) {
      return priorityScore(b.request, b.tierRank, now) - priorityScore(a.request, a.tierRank, now);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Desk simulation — deterministic                                    *
   * ------------------------------------------------------------------ */

  /** FNV-1a — a stable seed so a request always gets the same options. */
  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /** Stage delays (ms) after submission. Higher tiers move visibly faster. */
  function deskDelays(tierId) {
    var f = 4 - tier(tierId).rank;                     // black 1× · gold 2× · silver 3×
    return { triaged: 4000 * f, sourcing: 9000 * f, options: 16000 * f };
  }

  var OPTION_TEMPLATES = {
    travel: [
      { name: 'The smart route',   detail: 'Direct flights, 5★ boutique stay, transfers arranged' },
      { name: 'The signature trip', detail: 'Business cabin, suite with a view, private guide day one' },
      { name: 'The once-in-a-lifetime', detail: 'First cabin, penthouse suite, every door opened' },
    ],
    dining: [
      { name: 'A brilliant table',  detail: 'Prime-time booking at a critics’ favourite' },
      { name: 'The impossible seat', detail: 'Chef’s counter at the hardest book in town' },
      { name: 'Private chef at home', detail: 'Tasting menu cooked in your kitchen, staff included' },
    ],
    events: [
      { name: 'Great seats',        detail: 'Centre block, official allocation' },
      { name: 'The box',            detail: 'Private box with hosting and drinks' },
      { name: 'Money-can’t-buy', detail: 'Backstage / paddock / courtside access' },
    ],
    chauffeur: [
      { name: 'Executive saloon',   detail: 'Mercedes E-Class, suited driver, bottled water' },
      { name: 'First class',        detail: 'S-Class or 7 Series, meet & greet included' },
      { name: 'The full detail',    detail: 'Range Rover + security-trained driver on standby all day' },
    ],
    shopping: [
      { name: 'Tracked down',       detail: 'The exact piece sourced and delivered' },
      { name: 'Styled & sourced',   detail: 'Personal shopper edit, three options couriered' },
      { name: 'Waitlist jumped',    detail: 'Allocation secured direct from the maison' },
    ],
    home: [
      { name: 'Handled this week',  detail: 'Vetted specialist booked, keys managed' },
      { name: 'Handled tomorrow',   detail: 'Priority call-out, project-managed end to end' },
      { name: 'Handled today',      detail: 'Same-day crew, photos on completion' },
    ],
    wellness: [
      { name: 'The reset',          detail: 'Spa day at a five-star house, treatments booked' },
      { name: 'The programme',      detail: 'Trainer + nutritionist, four weeks, at your address' },
      { name: 'The retreat',        detail: 'Long weekend retreat, flights and transfers included' },
    ],
    gifting: [
      { name: 'Thoughtful',         detail: 'Curated, wrapped and hand-delivered with your note' },
      { name: 'Unforgettable',      detail: 'Personalised commission from a named artisan' },
      { name: 'The grand gesture',  detail: 'The kind of gift that becomes the story' },
    ],
  };
  var OPTION_BASE_PENCE = {
    travel: 120000, dining: 18000, events: 35000, chauffeur: 9500,
    shopping: 25000, home: 12000, wellness: 20000, gifting: 15000,
  };
  var OPTION_STEP = [1, 1.7, 2.8];

  function round5Pounds(pence) { return Math.round(pence / 500) * 500; }

  /** Three seeded, priced options — same request id in, same options out. */
  function proposeOptions(request) {
    var tpl = OPTION_TEMPLATES[request.category];
    var base = OPTION_BASE_PENCE[request.category];
    if (!tpl) throw new Error('unknown category: ' + request.category);
    var out = [];
    for (var i = 0; i < tpl.length; i++) {
      var jitter = 0.85 + (hash(request.id + ':' + i) % 31) / 100;   // 0.85 – 1.15
      out.push({
        id: request.id + ':opt' + i,
        name: tpl[i].name,
        detail: tpl[i].detail,
        pricePence: round5Pounds(base * OPTION_STEP[i] * jitter),
      });
    }
    return out;
  }

  var DESK_LINES = {
    submitted: function (r) {
      return 'Received — your ' + category(r.category).name.toLowerCase() +
             ' request is with us. A concierge is being assigned now.';
    },
    triaged: function (r, name) {
      return 'Hello' + (name ? ' ' + name : '') + ', this is Alexandra from the ' +
             category(r.category).name + ' desk. I’m personally handling “' +
             r.title + '” — give me a moment while I work my contacts.';
    },
    sourcing: function (r) {
      return 'Quick update — I’m holding availability with two of my best ' +
             category(r.category).name.toLowerCase() + ' contacts. Pricing options with you shortly.';
    },
    options: function () {
      return 'Done — I’ve secured three options for you, best value to best-in-class. ' +
             'Tap one to review and confirm; I’ll hold all three until you decide.';
    },
    confirmed: function (r) {
      var opt = r.chosenOption;
      return 'Confirmed: ' + (opt ? '“' + opt.name + '”' : 'your selection') +
             '. Every detail is booked under your membership — confirmation is in your timeline.';
    },
    completed: function () {
      return 'All wrapped up — I hope it was perfect. Your points have been credited. ' +
             'It’s always a pleasure; ask for Alexandra any time.';
    },
    cancelled: function () {
      return 'No problem at all — I’ve released the holds and closed this request. ' +
             'The request has been returned to your monthly allowance.';
    },
  };

  /** The desk's scripted message when a request reaches a stage. */
  function deskLine(request, stage, memberName) {
    var f = DESK_LINES[stage];
    if (!f) throw new Error('no desk line for stage: ' + stage);
    return f(request, memberName);
  }

  /* ------------------------------------------------------------------ *
   *  Points & status                                                    *
   * ------------------------------------------------------------------ */
  var STATUS_LEVELS = [
    { name: 'Member', min: 0 },
    { name: 'Insider', min: 500 },
    { name: 'Icon', min: 2000 },
    { name: 'Legend', min: 10000 },
  ];

  /** 1 point per £1 spent, times the tier multiplier. */
  function pointsEarned(pence, tierId) {
    return Math.floor((pence / 100) * tier(tierId).pointsMultiplier);
  }

  function statusFor(points) {
    var s = STATUS_LEVELS[0];
    for (var i = 0; i < STATUS_LEVELS.length; i++) if (points >= STATUS_LEVELS[i].min) s = STATUS_LEVELS[i];
    return s;
  }

  /** Points to the next status level — null at the top. */
  function pointsToNext(points) {
    for (var i = 0; i < STATUS_LEVELS.length; i++) {
      if (points < STATUS_LEVELS[i].min) return STATUS_LEVELS[i].min - points;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   *  Money formatting — no Intl, deterministic everywhere               *
   * ------------------------------------------------------------------ */
  function fmtGBP(pence) {
    var neg = pence < 0;
    var p = Math.abs(Math.round(pence));
    var pounds = Math.floor(p / 100), rem = p % 100;
    var s = String(pounds).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (rem) s += '.' + (rem < 10 ? '0' : '') + rem;
    return (neg ? '−£' : '£') + s;
  }

  return {
    MIN: MIN, DAY: DAY, PERIOD_DAYS: PERIOD_DAYS, TRIAL_DAYS: TRIAL_DAYS,
    TIERS: TIERS, TIER_ORDER: TIER_ORDER, tier: tier,
    startSubscription: startSubscription, advance: advance,
    remainingFraction: remainingFraction, prorationPence: prorationPence,
    changeTier: changeTier, cancel: cancel, resume: resume,
    isLive: isLive, trialDaysLeft: trialDaysLeft,
    usedInPeriod: usedInPeriod, remainingQuota: remainingQuota, canSubmit: canSubmit,
    CATEGORIES: CATEGORIES, category: category,
    FLOW: FLOW, STATUS_LABEL: STATUS_LABEL, canTransition: canTransition, transition: transition,
    slaDeadline: slaDeadline, slaState: slaState,
    priorityScore: priorityScore, queueOrder: queueOrder,
    hash: hash, deskDelays: deskDelays, proposeOptions: proposeOptions, deskLine: deskLine,
    STATUS_LEVELS: STATUS_LEVELS, pointsEarned: pointsEarned, statusFor: statusFor,
    pointsToNext: pointsToNext, fmtGBP: fmtGBP,
  };
});
