/* Docket — the pure "deal with my paperwork" engine.
 * =====================================================================
 * Docket is a virtual assistant for the paper that lands on your doormat:
 * snap a photo of a document, tell Docket the important lines it says, and
 * every rule that decides WHAT it is (classification), HOW URGENT it is
 * (the importance pile), WHAT IT MEANS FOR YOU (the briefing and the
 * play-it-in-your-favour tips), and HOW TO ACT on it (drafted letters,
 * discounts, deadlines, the daily digest) lives HERE as pure,
 * deterministic, clock-injected functions with zero DOM and zero I/O —
 * unit-tested in scripts/test-docket-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  /* ---------------- tiny utilities ---------------- */

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatMoney(n, cur) {
    if (!isFinite(Number(n))) return '';
    var v = Math.round(Number(n) * 100) / 100;
    var s = v.toFixed(2).replace(/\.00$/, '');
    s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (cur || '£') + s;
  }

  function timeAgo(ts, now) {
    var d = Math.max(0, (now || 0) - (ts || 0));
    if (d < MINUTE) return 'just now';
    if (d < HOUR) return Math.floor(d / MINUTE) + 'm ago';
    if (d < DAY) return Math.floor(d / HOUR) + 'h ago';
    if (d < 7 * DAY) return Math.floor(d / DAY) + 'd ago';
    return Math.floor(d / (7 * DAY)) + 'w ago';
  }

  /* ---------------- calendar helpers (all UTC, all pure) ---------------- */

  function parseISO(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var ms = Date.UTC(y, mo - 1, d);
    var chk = new Date(ms);
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
    return ms;
  }

  function toISO(ms) {
    var d = new Date(ms);
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
  }

  function isoPlusDays(iso, days) {
    var ms = parseISO(iso);
    if (ms == null) return null;
    return toISO(ms + days * DAY);
  }

  // Whole calendar days between "now" and a due DATE (both flattened to UTC
  // midnight): 0 = due today, negative = overdue by that many days.
  function daysUntil(dueISO, now) {
    var due = parseISO(dueISO);
    if (due == null) return null;
    return Math.round((due - Math.floor(now / DAY) * DAY) / DAY);
  }

  function formatDateISO(iso) {
    var ms = parseISO(iso);
    if (ms == null) return String(iso || '');
    var d = new Date(ms);
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  /* ---------------- what a document can BE: the category playbooks ---------------- */
  // Every category carries the assistant's knowledge: how heavy it sits in
  // the pile (weight), how to recognise it (kw), what it's for (what), why
  // it can't be ignored (why), the play-it-in-your-favour moves (favour),
  // and which letters Docket can draft for it (actions).
  var CATEGORIES = [
    { key: 'fine', label: 'Fine / penalty', emoji: '🚨', weight: 78,
      kw: ['penalty charge', 'pcn', 'parking charge', 'fixed penalty', 'fine', 'contravention', 'speeding', 'penalty notice', 'bus lane', 'congestion charge'],
      what: 'A penalty notice — someone official (or someone acting official) says you owe money for a parking, traffic or similar contravention.',
      why: 'Penalties run on a timer: pay-early discounts expire, then the full amount is demanded, then it can escalate to enforcement with extra fees stacked on top.',
      favour: [
        'Check the discount window first — most penalty notices halve if you pay within 14 days, so a quick decision is worth real money.',
        'Look for grounds to challenge before paying: unclear or missing signage, a valid ticket or permit, loading/alighting, or errors on the notice itself (wrong plate, wrong location) can get it cancelled entirely.',
        'A formal challenge usually pauses the clock — the discount is typically re-offered if the appeal is rejected, so appealing rarely costs you the discount.',
        'Never just ignore it: unanswered notices grow, not disappear.'
      ],
      actions: ['appeal', 'extension', 'query'] },

    { key: 'debt', label: 'Debt / final demand', emoji: '⚠️', weight: 85,
      kw: ['debt', 'arrears', 'final demand', 'final notice', 'collection', 'collections', 'outstanding balance', 'default notice', 'bailiff', 'enforcement agent', 'county court', 'ccj'],
      what: 'A demand for money someone claims you already owe — a final notice, arrears letter or a debt collector chasing a balance.',
      why: 'Left alone this is the kind of letter that turns into court claims, default marks on your credit file and doorstep enforcement — but answered early, almost all of it is negotiable.',
      favour: [
        'Make them prove it before you pay a penny: you are entitled to ask for evidence of the original agreement and a full breakdown of how the sum was calculated.',
        'If the debt is real, offer a payment plan you can actually keep — collectors routinely accept instalments and often freeze interest to get a deal.',
        'Check the age of the debt: very old debts can be unenforceable, and paying or acknowledging one can restart the clock.',
        'Keep everything in writing — letters, not phone calls, are what protect you later.'
      ],
      actions: ['query', 'extension', 'complaint'] },

    { key: 'tax', label: 'Tax / official', emoji: '🏛️', weight: 72,
      kw: ['hmrc', 'tax return', 'self assessment', 'council tax', 'tax code', 'p60', 'p45', 'national insurance', 'vat', 'tax year', 'rebate', 'taxable'],
      what: 'A letter from the tax authority or council — a return to file, a code change, a bill, or sometimes money coming back to you.',
      why: 'Tax deadlines carry automatic penalties that grow with lateness, and mistakes in your tax code quietly cost you every month until corrected.',
      favour: [
        'Check it before you accept it — tax code errors and estimated bills are common, and a short query letter can move the number in your direction.',
        'If it mentions a rebate or overpayment, claim it promptly and only ever through official channels.',
        'If you can’t pay in full, ask for a "time to pay" arrangement BEFORE the deadline — asking early is treated far better than missing it.',
        'Keep this document: tax paperwork is the one pile you’ll be asked to produce years later.'
      ],
      actions: ['query', 'extension', 'confirm'] },

    { key: 'legal', label: 'Legal / court', emoji: '⚖️', weight: 90,
      kw: ['court', 'summons', 'claim form', 'solicitor', 'legal proceedings', 'hearing', 'tribunal', 'witness', 'jury', 'injunction', 'prosecution', 'legal action'],
      what: 'A legal document — a court claim, summons, hearing date or solicitor’s letter that has formal deadlines attached.',
      why: 'Court paperwork is the most unforgiving kind: miss the response window and judgment can be entered against you by default, without anyone hearing your side.',
      favour: [
        'Diary the response deadline today — replying in time, even briefly, keeps every option open; silence loses by default.',
        'Acknowledging a claim usually buys you extra days to file a full defence — use that mechanism rather than rushing.',
        'Get free advice before paying or admitting anything: Citizens Advice and law centres deal with these letters daily.',
        'Respond to the sender exactly as instructed on the form — the reference number goes on everything.'
      ],
      actions: ['query', 'extension'] },

    { key: 'bill', label: 'Bill / utility', emoji: '💡', weight: 55,
      kw: ['bill', 'invoice', 'electricity', 'energy', 'gas', 'water', 'broadband', 'tariff', 'kwh', 'meter reading', 'direct debit', 'standing charge', 'payment due'],
      what: 'A bill for a service you use — energy, water, phone, broadband or similar — asking for payment by a date.',
      why: 'Unpaid bills add late fees and can hit your credit file, but bills are also where quiet overcharging lives: estimated readings and expired tariffs cost real money.',
      favour: [
        'Check whether the reading is ESTIMATED — submitting an actual meter reading before paying often shrinks the bill on the spot.',
        'Compare the tariff with what’s on offer: a bill is your annual reminder to threaten to switch, and retention deals go to the people who ask.',
        'If the amount looks wrong, dispute it in writing before the due date — a genuinely disputed bill usually can’t be enforced while it’s being investigated.',
        'Struggling this month? Suppliers must offer payment plans — asking first keeps your credit record clean.'
      ],
      actions: ['dispute', 'extension', 'complaint'] },

    { key: 'bank', label: 'Bank / finance', emoji: '🏦', weight: 50,
      kw: ['bank', 'statement', 'interest rate', 'overdraft', 'account number', 'sort code', 'credit card', 'loan', 'mortgage', 'apr', 'annual summary'],
      what: 'A letter from a bank or lender — a statement, a rate change, or terms being varied on an account you hold.',
      why: 'Rate-change letters are where money leaks: a savings rate quietly dropping or a mortgage deal ending costs far more than most bills.',
      favour: [
        'Scan for the words "your rate is changing" — that line is the entire letter, and it’s your cue to shop around.',
        'A deal ending (fixed rate, intro offer) means the clock is running: switching before the rollover date is worth real money.',
        'Check statements for subscriptions and charges you don’t recognise — write and reclaim anything wrong, banks refund more often than people ask.',
        'Keep annual summaries; shred the rest once checked.'
      ],
      actions: ['query', 'complaint'] },

    { key: 'insurance', label: 'Insurance', emoji: '🛡️', weight: 52,
      kw: ['insurance', 'policy', 'premium', 'renewal', 'excess', 'insurer', 'cover', 'no claims', 'claim reference'],
      what: 'An insurance document — usually a renewal quote for a policy you already hold, or paperwork about a claim.',
      why: 'Auto-renewal is priced for people who don’t read the letter: loyal customers routinely pay more than new ones for identical cover.',
      favour: [
        'NEVER auto-renew without checking: get two comparison quotes, then call your insurer and ask them to beat the best one — they usually try.',
        'Check the premium against last year’s — a silent increase with no claims is pure loyalty tax.',
        'Confirm the excess and cover still match your life before the renewal date locks in.',
        'If it’s a claim letter, respond by the stated date and keep photos and receipts of everything.'
      ],
      actions: ['cancel', 'query', 'complaint'] },

    { key: 'medical', label: 'Medical / health', emoji: '🩺', weight: 68,
      kw: ['appointment', 'hospital', 'clinic', 'nhs', 'gp', 'doctor', 'screening', 'referral', 'prescription', 'dental', 'vaccination', 'blood test'],
      what: 'A health letter — an appointment, screening invitation, referral or results that may need booking or confirming.',
      why: 'Missed appointments often go to the back of the queue, and screening invitations are exactly the letters that matter most when ignored.',
      favour: [
        'Confirm or rebook the moment you read it — slots given up early get you a better replacement than no-shows do.',
        'Can’t make the date? Rearranging in advance keeps your place in the queue; missing it can mean a fresh referral.',
        'Take the letter (and its reference number) to the appointment.',
        'Screening invitations are free early warnings — book them like they’re urgent, because one day one will be.'
      ],
      actions: ['confirm', 'query'] },

    { key: 'benefits', label: 'Benefits / support', emoji: '🤝', weight: 70,
      kw: ['benefit', 'universal credit', 'pension', 'allowance', 'entitlement', 'dwp', 'support payment', 'winter fuel', 'housing benefit', 'claim review'],
      what: 'A letter about money you receive or could claim — benefits, pension, allowances, or a review of an existing claim.',
      why: 'These letters usually have reply-by dates that decide whether payments continue — and unclaimed entitlements are money you’re owed but not getting.',
      favour: [
        'Reply by the stated date even if you’re missing evidence — a partial reply on time beats a complete one late, and protects the claim.',
        'If it reduces or stops a payment, you normally have a short window to ask for a reconsideration — appeal rates are surprisingly good for those who try.',
        'Letters inviting you to claim are worth taking seriously: entitlement is use-it-or-lose-it money.',
        'Photograph everything you send back, and post with proof if it’s paper.'
      ],
      actions: ['query', 'extension', 'complaint'] },

    { key: 'subscription', label: 'Subscription / renewal', emoji: '🔁', weight: 40,
      kw: ['subscription', 'membership', 'renew automatically', 'auto-renew', 'free trial', 'price change', 'monthly plan', 'will renew', 'renewal date'],
      what: 'A subscription or membership notice — a renewal coming up, a price rise, or a trial about to become a paid plan.',
      why: 'Subscriptions are engineered to renew silently — the letter/email arriving at all is your one scheduled chance to decide on purpose.',
      favour: [
        'Ask the only question that matters: did you use it last month? If not, cancel before the renewal date on the notice.',
        'Price rise? Contact them and ask for the old rate or a retention offer — cancelling-then-rejoining is often cheaper too.',
        'Cancel in writing and keep the confirmation, so a "we kept charging you" is winnable later.',
        'If you keep it, diary the NEXT renewal date now.'
      ],
      actions: ['cancel', 'query'] },

    { key: 'housing', label: 'Home / tenancy', emoji: '🏠', weight: 65,
      kw: ['tenancy', 'landlord', 'rent', 'lease', 'deposit', 'eviction', 'notice to quit', 'section 21', 'service charge', 'letting', 'inventory'],
      what: 'A letter about your home — rent, tenancy terms, deposits, service charges or (most seriously) a notice about your tenancy ending.',
      why: 'Housing letters carry some of the strictest legal timelines there are, and tenants have far more rights than most landlords’ letters admit.',
      favour: [
        'A rent rise or eviction notice must follow strict legal form and notice periods — many are invalid as served, so get it checked before accepting it.',
        'Deposits must be protected in a scheme; if yours wasn’t, that’s leverage that can be worth up to 3× the deposit.',
        'Reply in writing and keep copies — tenancy disputes are won on paper trails.',
        'Free help exists (Shelter, Citizens Advice) and landlords know it — mentioning you’ve taken advice changes the tone fast.'
      ],
      actions: ['query', 'complaint', 'extension'] },

    { key: 'delivery', label: 'Delivery / notice', emoji: '📦', weight: 25,
      kw: ['delivery', 'parcel', 'collection', 'sorting office', 'while you were out', 'redelivery', 'tracking', 'customs charge', 'depot'],
      what: 'A delivery card or notice — a parcel waiting somewhere, a redelivery to book, or (careful) a customs/handling charge.',
      why: 'Parcels get returned to sender after a holding period — and fake "pay a small customs fee" cards are one of the most common scams in the pile.',
      favour: [
        'Note the holding deadline — uncollected parcels go back, usually after 1–3 weeks.',
        'Asked to PAY to release a parcel? Verify on the courier’s official site or app, typed in yourself — never via a link or QR code printed on the card.',
        'Genuine customs charges on real orders do happen; check them against what you actually bought.',
        'Book redelivery to a neighbour or locker and stop the card pile forming.'
      ],
      actions: ['query'] },

    { key: 'junk', label: 'Junk / marketing', emoji: '🗑️', weight: 5,
      kw: ['exclusive offer', 'limited time', 'act now', 'you have been selected', 'winner', 'prize draw', 'no obligation', 'special offer', 'discount code', 'unsubscribe'],
      what: 'Marketing dressed up as something important — offers, prize draws and "you have been selected" letters.',
      why: 'Its only power is the minutes it steals — and the pressure tactics ("act now!") it borrows from real deadlines to make you rush.',
      favour: [
        'Real institutions don’t need urgency theatre — "act now or lose out" is the signature of junk (or worse, a scam).',
        'Never call numbers or scan QR codes from unsolicited mail; if it claims to be your bank, contact the bank via the number on your card.',
        'Recycle it. If it keeps coming, opt out with the mail preference service.',
        'If it asked for personal details or payment, treat it as a scam and report it.'
      ],
      actions: [] },

    { key: 'other', label: 'Document', emoji: '📄', weight: 35,
      kw: [],
      what: 'A document Docket couldn’t confidently classify — worth a human skim of the letterhead and the boldest line.',
      why: 'Unclassified doesn’t mean unimportant: check who sent it and whether any date or amount appears.',
      favour: [
        'Find the sender and the ask: who wrote this, and what do they want you to do?',
        'Circle any date or amount — if either exists, this belongs higher up the pile.',
        'If it’s genuinely information-only, file or recycle it and enjoy the empty pile.',
        'Add the key lines to Docket and it will re-read it for you.'
      ],
      actions: ['query'] }
  ];

  var CAT_BY_KEY = {};
  for (var ci = 0; ci < CATEGORIES.length; ci++) CAT_BY_KEY[CATEGORIES[ci].key] = CATEGORIES[ci];

  function categoryByKey(key) { return CAT_BY_KEY[key] || CAT_BY_KEY.other; }

  /* ---------------- reading the document: classification ---------------- */
  // Keyword scoring over the text the user typed/pasted (or OCR fed in).
  // Multi-word phrases score double — "penalty charge" is stronger evidence
  // than "charge". Deterministic: ties break by category order above.
  function classifyDocument(text) {
    var t = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
    var best = null, bestScore = 0;
    for (var i = 0; i < CATEGORIES.length; i++) {
      var c = CATEGORIES[i];
      var score = 0, hits = [];
      for (var k = 0; k < c.kw.length; k++) {
        if (t.indexOf(c.kw[k]) !== -1) {
          score += c.kw[k].indexOf(' ') !== -1 ? 2 : 1;
          hits.push(c.kw[k]);
        }
      }
      if (score > bestScore) { bestScore = score; best = { key: c.key, label: c.label, emoji: c.emoji, score: score, hits: hits }; }
    }
    if (!best) {
      var o = CAT_BY_KEY.other;
      return { key: o.key, label: o.label, emoji: o.emoji, score: 0, hits: [], confidence: 'low' };
    }
    best.confidence = bestScore >= 4 ? 'high' : bestScore >= 2 ? 'medium' : 'low';
    return best;
  }

  // Escalation language pushes ANY document up the pile, whatever its category.
  var ESCALATION_RE = /final notice|final demand|court|bailiff|enforcement agent|debt collect|summons|legal action|prosecution|default notice|last reminder|urgent action/;
  function escalationWords(text) {
    var t = String(text || '').toLowerCase();
    var m = t.match(ESCALATION_RE);
    return m ? m[0] : null;
  }

  /* ---------------- reading the document: amounts ---------------- */
  // Every currency figure in the text, each with its nearby context. An
  // amount sitting next to "due / total / pay / balance" beats a bigger
  // number in the small print.
  var AMOUNT_RE = /([£$€])\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  var AMOUNT_CTX_RE = /due|owe|owing|pay|payable|total|balance|outstanding|amount|charge|remit/;

  function extractAmount(text) {
    var s = String(text || '');
    var found = [], m;
    AMOUNT_RE.lastIndex = 0;
    while ((m = AMOUNT_RE.exec(s)) !== null) {
      var val = parseFloat(m[2].replace(/,/g, ''));
      if (!isFinite(val) || val <= 0) continue;
      var ctx = s.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
      found.push({ amount: val, currency: m[1], priority: AMOUNT_CTX_RE.test(ctx) ? 2 : 1 });
    }
    if (!found.length) return null;
    var best = found[0];
    for (var i = 1; i < found.length; i++) {
      var f = found[i];
      if (f.priority > best.priority || (f.priority === best.priority && f.amount > best.amount)) best = f;
    }
    return { amount: best.amount, currency: best.currency, label: formatMoney(best.amount, best.currency) };
  }

  /* ---------------- reading the document: deadlines ---------------- */
  var MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function monthIndex(name) {
    var n = String(name).slice(0, 3).toLowerCase();
    for (var i = 0; i < 12; i++) if (MONTHS3[i] === n) return i;
    return -1;
  }
  var DUE_CTX_RE = /(by|before|due|deadline|no later than|on or before|expires?( on)?|until|pay)\s*(date)?[:\s]*$/;

  // Finds the due date in the text: absolute dates in "30 September 2026",
  // "September 30, 2026" and "30/09/2026" (day-first) forms, plus relative
  // "within 14 days" windows counted from when the document arrived. A date
  // sitting after "by / due / no later than" outranks other dates; among
  // equals, the SOONEST deadline wins (the safe assumption).
  function extractDueDate(text, receivedMs) {
    var s = String(text || '');
    var cands = [], m;

    var push = function (y, mo, d, idx) {
      if (mo < 0 || mo > 11) return;
      var ms = Date.UTC(y, mo, d);
      var chk = new Date(ms);
      if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo || chk.getUTCDate() !== d) return;
      var ctx = s.slice(Math.max(0, idx - 30), idx).toLowerCase();
      cands.push({ ms: ms, priority: DUE_CTX_RE.test(ctx.replace(/\s+/g, ' ')) ? 2 : 1 });
    };

    var reWordy = /(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})/gi;
    while ((m = reWordy.exec(s)) !== null) push(+m[3], monthIndex(m[2]), +m[1], m.index);

    var reUS = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/gi;
    while ((m = reUS.exec(s)) !== null) push(+m[3], monthIndex(m[1]), +m[2], m.index);

    var reNum = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/g;
    while ((m = reNum.exec(s)) !== null) {
      var y = +m[3]; if (y < 100) y += 2000;
      push(y, +m[2] - 1, +m[1], m.index);
    }

    if (isFinite(receivedMs)) {
      var reWithin = /within\s+(?:the\s+next\s+)?(\d{1,3})\s+days|in\s+the\s+next\s+(\d{1,3})\s+days|(\d{1,3})\s+days\s+of\s+the\s+date\s+of\s+this/gi;
      while ((m = reWithin.exec(s)) !== null) {
        var n = +(m[1] || m[2] || m[3]);
        if (n > 0 && n <= 366) cands.push({ ms: Math.floor(receivedMs / DAY) * DAY + n * DAY, priority: 2 });
      }
    }

    if (!cands.length) return null;
    var best = cands[0];
    for (var i = 1; i < cands.length; i++) {
      var c = cands[i];
      if (c.priority > best.priority || (c.priority === best.priority && c.ms < best.ms)) best = c;
    }
    return toISO(best.ms);
  }

  function extractReference(text) {
    var m = /(?:ref(?:erence)?|account|case|notice|invoice|policy|claim)\b\s*(?:number|no\.?|#)?\s*[:\-]?\s*((?=[A-Z\/\-]{0,19}\d)[A-Z0-9][A-Z0-9\/\-]{3,19})/i.exec(String(text || ''));
    return m ? m[1] : null;
  }

  /* ---------------- adding a document: validation & shaping ---------------- */
  function deriveTitle(categoryKey, sender) {
    var c = categoryByKey(categoryKey);
    return c.label + (sender ? ' — ' + sender : '');
  }

  // A docket entry needs SOMETHING to work with: a photo, or the key lines
  // typed in. Everything else — category, amount, due date, reference — is
  // read from the text, and each can be overridden by the human.
  function validateDocument(d, now) {
    d = d || {};
    var text = String(d.text == null ? '' : d.text).trim();
    var sender = String(d.sender == null ? '' : d.sender).trim();
    var hasPhoto = !!d.photo;
    if (!hasPhoto && !text) return { ok: false, reason: 'Give Docket something to read — a photo, or type the key lines the document says.' };
    if (text.length > 4000) return { ok: false, reason: 'Keep the text under 4000 characters — just the important lines.' };
    if (sender.length > 60) return { ok: false, reason: 'Sender: 60 characters max.' };

    var cls = classifyDocument(text);
    var category = d.category && CAT_BY_KEY[d.category] ? d.category : cls.key;
    var amt = extractAmount(text);
    var due = d.dueDate && parseISO(d.dueDate) != null ? d.dueDate : extractDueDate(text, now);
    return {
      ok: true,
      doc: {
        text: text, sender: sender, photo: d.photo || null,
        category: category, classified: cls,
        title: String(d.title || '').trim() || deriveTitle(category, sender),
        amount: amt ? amt.amount : (isFinite(Number(d.amount)) && Number(d.amount) > 0 ? Number(d.amount) : null),
        currency: amt ? amt.currency : (d.currency || '£'),
        dueDate: due || null,
        ref: extractReference(text),
        escalation: escalationWords(text),
        status: 'open', ts: now
      }
    };
  }

  /* ---------------- the pile: importance scoring & triage ---------------- */

  // Where a deadline stands right now, as a band the UI can colour.
  function deadlineStatus(doc, now) {
    if (!doc || !doc.dueDate) return { state: 'none', days: null, label: 'No deadline found' };
    var days = daysUntil(doc.dueDate, now);
    if (days == null) return { state: 'none', days: null, label: 'No deadline found' };
    if (days < 0) return { state: 'overdue', days: days, label: (-days) + ' day' + (days === -1 ? '' : 's') + ' overdue' };
    if (days === 0) return { state: 'today', days: 0, label: 'Due TODAY' };
    if (days <= 3) return { state: 'urgent', days: days, label: 'Due in ' + days + ' day' + (days === 1 ? '' : 's') };
    if (days <= 7) return { state: 'soon', days: days, label: 'Due in ' + days + ' days' };
    return { state: 'ok', days: days, label: 'Due ' + formatDateISO(doc.dueDate) };
  }

  // The number that orders the pile. Category weight is the floor; the
  // deadline is the accelerant; money at stake and escalation language add
  // pressure; snoozing dampens; dealing with it removes it from the race.
  function importanceScore(doc, now) {
    var c = categoryByKey(doc.category);
    if (doc.status && doc.status !== 'open') {
      return { score: 0, reasons: [{ label: 'Dealt with', pts: 0 }] };
    }
    var reasons = [{ label: c.emoji + ' ' + c.label, pts: c.weight }];
    var score = c.weight;

    var dl = deadlineStatus(doc, now);
    var dPts = 0;
    if (dl.state === 'overdue') dPts = Math.min(80, 60 + 2 * (-dl.days));
    else if (dl.state === 'today') dPts = 55;
    else if (dl.state === 'urgent') dPts = 45;
    else if (dl.state === 'soon') dPts = 30;
    else if (dl.state === 'ok' && dl.days <= 14) dPts = 15;
    if (dPts) reasons.push({ label: dl.label, pts: dPts });
    score += dPts;

    if (doc.amount) {
      var aPts = Math.round(Math.min(25, 8 * Math.log(1 + doc.amount) / Math.LN10));
      reasons.push({ label: formatMoney(doc.amount, doc.currency) + ' at stake', pts: aPts });
      score += aPts;
    }

    if (doc.escalation) {
      reasons.push({ label: 'Says “' + doc.escalation + '”', pts: 25 });
      score += 25;
    }

    if (doc.snoozedUntil && doc.snoozedUntil > now) {
      var kept = Math.round(score * 0.25);
      reasons.push({ label: 'Snoozed until ' + formatDateISO(toISO(doc.snoozedUntil)), pts: kept - score });
      score = kept;
    }
    return { score: score, reasons: reasons };
  }

  // The whole pile, most important first, each entry banded for the UI:
  // 'now' (overdue/today/≤3 days or score ≥ 110), 'week', 'later', 'done'.
  function triage(docs, now) {
    var out = [];
    for (var i = 0; i < (docs || []).length; i++) {
      var doc = docs[i];
      var imp = importanceScore(doc, now);
      var dl = deadlineStatus(doc, now);
      var band;
      if (doc.status && doc.status !== 'open') band = 'done';
      else if (dl.state === 'overdue' || dl.state === 'today' || dl.state === 'urgent' || imp.score >= 110) band = 'now';
      else if (dl.state === 'soon' || imp.score >= 70) band = 'week';
      else band = 'later';
      out.push({ doc: doc, score: imp.score, reasons: imp.reasons, deadline: dl, band: band });
    }
    out.sort(function (a, b) {
      return b.score - a.score || (b.doc.ts || 0) - (a.doc.ts || 0) ||
        (String(a.doc.id) < String(b.doc.id) ? -1 : String(a.doc.id) > String(b.doc.id) ? 1 : 0);
    });
    return out;
  }

  /* ---------------- money you can claw back ---------------- */
  // The concrete win Docket can spot without being told: penalty notices
  // typically halve inside the 14-day discount window from arrival.
  function potentialSaving(doc, now) {
    if (!doc || doc.category !== 'fine' || !doc.amount) return null;
    if (doc.status && doc.status !== 'open') return null;
    var windowEnd = Math.floor((doc.ts || 0) / DAY) * DAY + 14 * DAY;
    if (now >= windowEnd) return null;
    var save = Math.round(doc.amount * 50) / 100;
    var daysLeft = Math.ceil((windowEnd - now) / DAY);
    return {
      save: save, label: formatMoney(save, doc.currency),
      until: toISO(windowEnd), daysLeft: daysLeft,
      line: 'Likely 50% discount window: paying in the next ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') +
            ' would typically cost ' + formatMoney(doc.amount - save, doc.currency) + ' instead of ' + formatMoney(doc.amount, doc.currency) + '.'
    };
  }

  /* ---------------- the briefing: the assistant explains one document ---------------- */
  function briefing(doc, now) {
    var c = categoryByKey(doc.category);
    var dl = deadlineStatus(doc, now);
    var saving = potentialSaving(doc, now);

    var whyExtra = [];
    if (doc.escalation) whyExtra.push('This one uses escalation language (“' + doc.escalation + '”) — it belongs at the top of the pile.');
    if (doc.amount) whyExtra.push('There’s ' + formatMoney(doc.amount, doc.currency) + ' at stake.');

    var deadlineLine = null;
    if (dl.state === 'overdue') deadlineLine = '⏰ The deadline has passed (' + dl.label.toLowerCase() + '). Acting today still beats acting tomorrow — late responses are weighed better than none.';
    else if (dl.state === 'today') deadlineLine = '⏰ This is due TODAY — deal with it before anything else in the pile.';
    else if (dl.state === 'urgent' || dl.state === 'soon') deadlineLine = '⏰ ' + dl.label + ' (' + formatDateISO(doc.dueDate) + ').';
    else if (dl.state === 'ok') deadlineLine = '🗓️ ' + dl.label + ' — ' + dl.days + ' days to play with.';

    var favour = c.favour.slice();
    if (saving) favour.unshift(saving.line);

    var suggested = [];
    for (var i = 0; i < c.actions.length; i++) {
      var a = DRAFT_KINDS[c.actions[i]];
      if (a) suggested.push({ kind: c.actions[i], label: a.label, emoji: a.emoji });
    }

    return {
      title: doc.title || deriveTitle(doc.category, doc.sender),
      emoji: c.emoji, category: c.label,
      what: c.what,
      why: c.why + (whyExtra.length ? ' ' + whyExtra.join(' ') : ''),
      deadlineLine: deadlineLine,
      favour: favour,
      saving: saving,
      suggested: suggested
    };
  }

  /* ---------------- acting on it: the letters Docket drafts ---------------- */
  var DRAFT_KINDS = {
    appeal:    { label: 'Challenge / appeal it', emoji: '⚔️' },
    query:     { label: 'Make them prove it',    emoji: '🔍' },
    extension: { label: 'Ask for time / a plan', emoji: '🕰️' },
    dispute:   { label: 'Dispute the amount',    emoji: '🧾' },
    cancel:    { label: 'Cancel it',             emoji: '✂️' },
    complaint: { label: 'Formal complaint',      emoji: '📣' },
    confirm:   { label: 'Confirm / get it in writing', emoji: '🖊️' }
  };

  function draftAction(doc, kind, me, now) {
    me = me || {};
    var name = String(me.name || '').trim() || '[Your name]';
    var sender = doc.sender || 'Sir or Madam';
    var ref = doc.ref || '[reference number on the document]';
    var amtLine = doc.amount ? ' of ' + formatMoney(doc.amount, doc.currency) : '';
    var dueLine = doc.dueDate ? formatDateISO(doc.dueDate) : null;
    var today = formatDateISO(toISO(now));
    var head = today + '\n\nDear ' + sender + ',\n\nRe: ' + (doc.title || 'your recent letter') + ' — reference ' + ref + '\n\n';
    var foot = '\n\nPlease confirm receipt of this letter in writing.\n\nYours faithfully,\n' + name;
    var subject = '', body = '', tip = '';

    if (kind === 'appeal') {
      subject = 'Formal challenge — reference ' + ref;
      body = head +
        'I am writing to formally challenge the above notice' + amtLine + '.\n\n' +
        'I ask you to cancel it on the following grounds:\n' +
        '1. [Your strongest ground — e.g. signage was missing or unclear, a valid ticket/permit was held, the event did not happen as described, or the notice contains errors.]\n' +
        '2. [List the evidence you attach: photos, receipts, tickets, statements.]\n\n' +
        'Please treat this as a formal representation. I understand no enforcement action should be taken, and any early-payment discount should be held open, while this challenge is considered.' + foot;
      tip = 'Fill in the bracketed lines with your actual grounds and attach evidence — specific beats long.';
    } else if (kind === 'query') {
      subject = 'Request for evidence — reference ' + ref;
      body = head +
        'I have received your letter' + amtLine + ' and I do not acknowledge any liability at this stage.\n\n' +
        'Before I take any further step, please provide:\n' +
        '1. A full breakdown showing exactly how the sum claimed was calculated;\n' +
        '2. Copies of the original documents or agreement this claim is based on;\n' +
        '3. Evidence that you are entitled to pursue this matter with me.\n\n' +
        'Until this evidence is provided I consider the matter unsubstantiated, and I expect no enforcement or collection activity in the meantime.' + foot;
      tip = 'Making them prove it is always legitimate — a surprising number of demands quietly go away at this step.';
    } else if (kind === 'extension') {
      subject = 'Request for more time — reference ' + ref;
      body = head +
        'I want to resolve this matter' + amtLine + ', and I am contacting you promptly' + (dueLine ? ' ahead of the stated date of ' + dueLine : '') + '.\n\n' +
        'I am not able to settle it in full by that date. I ask you to agree to either:\n' +
        '1. An extension of the deadline; or\n' +
        '2. A payment plan of [amount you can genuinely afford] per month.\n\n' +
        'I ask that no additional fees, interest or enforcement action be applied while an arrangement is agreed, and that this proactive contact is noted on my file.' + foot;
      tip = 'Offer only what you can actually keep to — a kept small plan beats a broken big one.';
    } else if (kind === 'dispute') {
      subject = 'Bill dispute — reference ' + ref;
      body = head +
        'I am formally disputing the amount' + amtLine + ' shown on this bill.\n\n' +
        '1. Please provide an itemised breakdown of how it was calculated;\n' +
        '2. If it is based on an estimated reading, here is my actual reading: [reading + date];\n' +
        '3. Please confirm the tariff applied and since when.\n\n' +
        'I understand the disputed amount should not be pursued, and my account should not be adversely affected, while this dispute is investigated. I will of course pay any undisputed portion.' + foot;
      tip = 'Send an actual meter reading with this if you have one — it settles most billing disputes instantly.';
    } else if (kind === 'cancel') {
      subject = 'Cancellation notice — reference ' + ref;
      body = head +
        'I am cancelling with effect from the end of the current period' + (dueLine ? ' (renewal date ' + dueLine + ')' : '') + '.\n\n' +
        '1. Please confirm the cancellation in writing, with the final date of service;\n' +
        '2. Take no further payments; I am withdrawing any authority to charge my account after the final date;\n' +
        '3. Refund any amount taken for service beyond that date.\n\n' +
        'This notice is given ahead of the renewal date and no further contract term is accepted.' + foot;
      tip = 'Keep their confirmation — it wins any "we kept charging you" dispute later.';
    } else if (kind === 'complaint') {
      subject = 'Formal complaint — reference ' + ref;
      body = head +
        'Please treat this letter as a FORMAL COMPLAINT and log it under your complaints procedure.\n\n' +
        'What happened: [one or two factual sentences — dates, amounts, what went wrong].\n' +
        'What I want: [what would put it right — e.g. a correction, a refund' + (doc.amount ? ' of ' + formatMoney(doc.amount, doc.currency) : '') + ', or an explanation].\n\n' +
        'Please send your final response within your published timescale. If the matter is not resolved, I will escalate it to the relevant ombudsman or regulator, as is my right.' + foot;
      tip = 'The word "formal complaint" starts a regulated clock at most institutions — it moves you out of the ordinary queue.';
    } else if (kind === 'confirm') {
      subject = 'Written confirmation requested — reference ' + ref;
      body = head +
        'Further to this matter' + amtLine + ', please provide written confirmation of the current position — including anything agreed, anything paid, and whether any further action is required from me' + (dueLine ? ' before ' + dueLine : '') + '.\n\n' +
        'I would like this for my records, and I will rely on your confirmation.' + foot;
      tip = 'Paper trails win disputes that memories lose — file the reply with the photo of the original.';
    } else {
      return null;
    }
    return { kind: kind, label: (DRAFT_KINDS[kind] || {}).label || kind, subject: subject, body: body, tip: tip };
  }

  function mailtoLink(draft, to) {
    return 'mailto:' + encodeURIComponent(to || '') +
      '?subject=' + encodeURIComponent(draft.subject || '') +
      '&body=' + encodeURIComponent(draft.body || '');
  }

  /* ---------------- the digest: the assistant sums up the pile ---------------- */
  function assistantDigest(docs, now) {
    var t = triage(docs, now);
    var open = 0, overdue = 0, dueSoon = 0, atStake = 0, saved = 0, doneCount = 0;
    var top = null;
    for (var i = 0; i < t.length; i++) {
      var e = t[i];
      if (e.band === 'done') {
        doneCount++;
        if (e.doc.savedAmount) saved += e.doc.savedAmount;
        continue;
      }
      open++;
      if (!top) top = e;
      if (e.deadline.state === 'overdue') overdue++;
      else if (e.deadline.state === 'today' || e.deadline.state === 'urgent' || e.deadline.state === 'soon') dueSoon++;
      if (e.doc.amount) atStake += e.doc.amount;
    }
    var parts = [];
    if (!open) {
      parts.push(doneCount ? 'Pile clear — everything is dealt with. Snap the next thing that comes through the door.'
                           : 'Nothing in the pile yet. Snap your first document and Docket will read it, rank it and fight your corner.');
    } else {
      var s = open + ' open document' + (open === 1 ? '' : 's');
      if (overdue) s += ' — ' + overdue + ' OVERDUE';
      else if (dueSoon) s += ' — ' + dueSoon + ' due within the week';
      s += '.';
      parts.push(s);
      if (atStake) parts.push(formatMoney(atStake, '£') + ' at stake across the pile.');
      if (top) parts.push('Start with “' + (top.doc.title || 'the top item') + '”' +
        (top.deadline.state === 'overdue' || top.deadline.state === 'today' ? ' — ' + top.deadline.label.toLowerCase() + '.' : '.'));
    }
    if (saved) parts.push('You’ve saved ' + formatMoney(saved, '£') + ' with Docket so far. 🎉');
    return {
      open: open, overdue: overdue, dueSoon: dueSoon, done: doneCount,
      atStake: atStake, atStakeLabel: atStake ? formatMoney(atStake, '£') : '',
      saved: saved, savedLabel: saved ? formatMoney(saved, '£') : '',
      topId: top ? top.doc.id : null,
      headline: parts.join(' ')
    };
  }

  /* ---------------- exports ---------------- */
  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    CATEGORIES: CATEGORIES, DRAFT_KINDS: DRAFT_KINDS,
    escapeHTML: escapeHTML, formatMoney: formatMoney, timeAgo: timeAgo,
    parseISO: parseISO, toISO: toISO, isoPlusDays: isoPlusDays, daysUntil: daysUntil, formatDateISO: formatDateISO,
    categoryByKey: categoryByKey, classifyDocument: classifyDocument, escalationWords: escalationWords,
    extractAmount: extractAmount, extractDueDate: extractDueDate, extractReference: extractReference,
    deriveTitle: deriveTitle, validateDocument: validateDocument,
    deadlineStatus: deadlineStatus, importanceScore: importanceScore, triage: triage,
    potentialSaving: potentialSaving, briefing: briefing,
    draftAction: draftAction, mailtoLink: mailtoLink,
    assistantDigest: assistantDigest
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.DocketEngine = E;
})(typeof self !== 'undefined' ? self : this);
