/**
 * Vault — the digital bank
 * ========================
 *
 * "Make me a full-on digital bank." A bank, stripped to its truth, is a
 * *ledger with rules*: an append-only list of transactions, and pure functions
 * that decide what may be appended (enough funds? card frozen? over the
 * limit?) and what the list means (balances, interest, insights). This engine
 * is that ledger and those rules — the app UI is just a skin over it.
 *
 * Design rules (stated so the tests can pin them):
 *
 *   • MONEY IS INTEGER PENCE. Every amount everywhere is a whole number of
 *     pence — no floats touch a balance, ever. £12.34 is 1234. Formatting to
 *     "£12.34" happens only at the display edge (fmt).
 *
 *   • THE LEDGER IS THE TRUTH. Balances are never stored; balanceOf() derives
 *     them by folding the transaction list (double-entry style: each txn has a
 *     `from` and `to` account id, either may be null for the outside world).
 *     You cannot get the cached-balance-out-of-sync bug if there is no cache.
 *
 *   • POSTING IS THE GATE. post() is the single door into the ledger. It
 *     validates: positive amount, sufficient funds (pots can never go
 *     negative; the current account may go down to −arrangedOverdraft), card
 *     frozen / per-purchase / daily card limits. It returns a new state or a
 *     typed error — it never throws and never mutates its input.
 *
 *   • DETERMINISTIC. No Date.now(), no Math.random() inside the engine —
 *     "now" is always an argument and randomness comes from a caller-supplied
 *     rng (mulberry32 for the demo seed), so same inputs ⇒ same ledger, to
 *     the penny. That's what makes the money maths unit-testable.
 *
 * The real-world maths is real: card numbers carry a valid Luhn check digit,
 * account IBANs carry genuine ISO 13616 mod-97 check digits, savings interest
 * compounds daily from the quoted AER ((1+AER)^(1/365)−1), and standing
 * orders clamp month-ends the way banks do (anchored on the 31st ⇒ pays
 * Feb 28, then back to Mar 31 — the anchor day is remembered, not eroded).
 *
 * Honesty note: this is a demo bank. Money here is simulated, and the PIN
 * "hash" (salted FNV-1a) is a courtesy lock for a toy ledger in localStorage,
 * not real credential storage — stated here so nobody mistakes it for one.
 *
 * UMD so it runs in the browser (window.Vault) and under Node/vm for tests —
 * same pattern as drip/engine.js. Framework-free, dependency-free.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Vault = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ════════════════════════ money ════════════════════════ */

  /** Format integer pence as "£1,234.56" (sign-aware; showPlus for credits). */
  function fmt(pence, opts) {
    opts = opts || {};
    var n = Math.round(Number(pence) || 0);
    var neg = n < 0; if (neg) n = -n;
    var pounds = String(Math.floor(n / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var p = String(n % 100); if (p.length < 2) p = '0' + p;
    return (neg ? '−' : opts.showPlus ? '+' : '') + '£' + pounds + '.' + p;
  }

  /** Parse a user-typed amount ("12", "12.3", "£1,234.56") to pence, or null. */
  function parseAmount(str) {
    var s = String(str == null ? '' : str).trim().replace(/[£,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var dot = s.indexOf('.');
    var pounds = dot === -1 ? s : s.slice(0, dot);
    var pn = dot === -1 ? '00' : (s.slice(dot + 1) + '0').slice(0, 2);
    var pence = parseInt(pounds, 10) * 100 + parseInt(pn, 10);
    return pence > 0 && pence <= 100000000000 ? pence : null; // cap at £1bn
  }

  /** Round-up-to-the-next-pound remainder: 350 → 50, 400 → 0. */
  function roundUp(pence) {
    var r = (Math.round(Number(pence) || 0)) % 100;
    return r === 0 ? 0 : 100 - r;
  }

  /* ════════════════════════ deterministic rng ════════════════════════ */

  /** mulberry32 — a tiny seedable PRNG so demo data is reproducible. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randDigits(rng, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += Math.floor(rng() * 10);
    return s;
  }

  /* ════════════════════════ card & account numbers ════════════════════════ */

  /** Luhn check digit for a digit string (the digit that makes it valid). */
  function luhnDigit(digits) {
    var sum = 0, dbl = true;
    for (var i = digits.length - 1; i >= 0; i--) {
      var d = digits.charCodeAt(i) - 48;
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    return String((10 - (sum % 10)) % 10);
  }
  function luhnValid(pan) {
    var s = String(pan).replace(/\s/g, '');
    if (!/^\d{12,19}$/.test(s)) return false;
    return luhnDigit(s.slice(0, -1)) === s.slice(-1);
  }

  /** A virtual debit card: Luhn-valid PAN, MM/YY expiry 4 years out, CVV. */
  function makeCard(rng, nowISO) {
    var body = '4929' + randDigits(rng, 11); // 4929… reads as a Visa-style demo BIN
    var pan = body + luhnDigit(body);
    var d = parseISO(nowISO);
    var yy = String((d.y + 4) % 100); if (yy.length < 2) yy = '0' + yy;
    var mm = String(d.m); if (mm.length < 2) mm = '0' + mm;
    return {
      pan: pan,
      expiry: mm + '/' + yy,
      cvv: randDigits(rng, 3),
      frozen: false,
      limitPerTx: 50000,   // £500 per purchase
      limitDaily: 100000   // £1,000 per day
    };
  }
  function maskPan(pan) { return '•••• •••• •••• ' + String(pan).slice(-4); }
  function groupPan(pan) { return String(pan).replace(/(.{4})/g, '$1 ').trim(); }

  function makeSortCode(rng) {
    // 04-xx-xx: the range UK challenger banks actually live in
    return '04-' + randDigits(rng, 2) + '-' + randDigits(rng, 2);
  }
  function makeAccountNumber(rng) { return randDigits(rng, 8); }

  /** ISO 13616 mod-97 over a (possibly huge) numeric string. */
  function mod97(numStr) {
    var rem = 0;
    for (var i = 0; i < numStr.length; i++) rem = (rem * 10 + (numStr.charCodeAt(i) - 48)) % 97;
    return rem;
  }
  /** Genuine GB IBAN for a sort code + account number (bank code VAUL). */
  function ibanFor(sortCode, accountNumber) {
    var bban = 'VAUL' + String(sortCode).replace(/\D/g, '') + String(accountNumber);
    // check digits: move "GB00" to the end, letters → 10..35, 98 − mod 97
    var rearranged = bban + 'GB00';
    var expanded = '';
    for (var i = 0; i < rearranged.length; i++) {
      var c = rearranged[i];
      expanded += c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c;
    }
    var check = 98 - mod97(expanded);
    return 'GB' + (check < 10 ? '0' + check : String(check)) + bban;
  }
  function ibanValid(iban) {
    var s = String(iban).replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(s)) return false;
    var rearranged = s.slice(4) + s.slice(0, 4);
    var expanded = '';
    for (var i = 0; i < rearranged.length; i++) {
      var c = rearranged[i];
      expanded += c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c;
    }
    return mod97(expanded) === 1;
  }

  /* ════════════════════════ dates (UTC, ISO strings) ════════════════════════ */

  function parseISO(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : { y: 1970, m: 1, d: 1 };
  }
  function toISO(y, m, d) {
    var mm = m < 10 ? '0' + m : '' + m, dd = d < 10 ? '0' + d : '' + d;
    return y + '-' + mm + '-' + dd;
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function isoPlusDays(iso, days) {
    var p = parseISO(iso);
    var t = Date.UTC(p.y, p.m - 1, p.d) + days * 86400000;
    var d = new Date(t);
    return toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  function daysBetween(a, b) {
    var pa = parseISO(a), pb = parseISO(b);
    return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
  }
  function monthKey(iso) { return String(iso).slice(0, 7); }

  /**
   * The next monthly occurrence after `iso`, anchored on `anchorDay` (1–31).
   * Banks clamp, they don't erode: anchored on the 31st pays Feb 28 but goes
   * BACK to the 31st in March, because the anchor day is remembered.
   */
  function nextMonthly(iso, anchorDay) {
    var p = parseISO(iso);
    var y = p.y, m = p.m + 1;
    if (m > 12) { m = 1; y++; }
    return toISO(y, m, Math.min(anchorDay, daysInMonth(y, m)));
  }

  /* ════════════════════════ state ════════════════════════ */

  /**
   * Open the bank: a current account, a first savings pot, a virtual card and
   * real-looking account rails. Deterministic given (rng, nowISO).
   */
  function openBank(opts) {
    var rng = opts.rng, nowISO = opts.nowISO;
    var sortCode = makeSortCode(rng), accountNumber = makeAccountNumber(rng);
    return {
      v: 1,
      name: String(opts.name || 'You').slice(0, 40),
      createdISO: nowISO,
      pin: null, // set via setPin
      sortCode: sortCode,
      accountNumber: accountNumber,
      iban: ibanFor(sortCode, accountNumber),
      accounts: [
        { id: 'current', kind: 'current', name: 'Current account', overdraft: 0 },
        { id: 'pot-1', kind: 'savings', name: 'Rainy day', aerPct: 4.0, goal: 50000, lastAccrualISO: nowISO }
      ],
      card: makeCard(rng, nowISO),
      roundUpsTo: null, // pot id, or null = off
      txns: [],         // append-only; the truth
      orders: [],       // standing orders
      contacts: [],
      seq: 0            // txn id counter (deterministic ids)
    };
  }

  /* ---- PIN (demo-grade lock; see honesty note in the header) ---- */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
  }
  function hashPin(pin, salt) { return fnv1a(String(salt) + '·' + String(pin)); }
  function setPin(state, pin, salt) {
    var s = clone(state);
    s.pin = { salt: String(salt), hash: hashPin(pin, salt) };
    return s;
  }
  function verifyPin(state, pin) {
    return !!(state.pin && hashPin(pin, state.pin.salt) === state.pin.hash);
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function accountById(state, id) {
    for (var i = 0; i < state.accounts.length; i++) if (state.accounts[i].id === id) return state.accounts[i];
    return null;
  }

  /* ════════════════════════ the ledger ════════════════════════ */

  /** Fold the ledger: sum of everything in, minus everything out. */
  function balanceOf(state, accountId) {
    var bal = 0;
    for (var i = 0; i < state.txns.length; i++) {
      var t = state.txns[i];
      if (t.to === accountId) bal += t.amount;
      if (t.from === accountId) bal -= t.amount;
    }
    return bal;
  }
  function totalBalance(state) {
    var sum = 0;
    for (var i = 0; i < state.accounts.length; i++) sum += balanceOf(state, state.accounts[i].id);
    return sum;
  }

  /** Card spend already posted on the given ISO day (for the daily limit). */
  function cardSpentOn(state, dayISO) {
    var day = String(dayISO).slice(0, 10), sum = 0;
    for (var i = 0; i < state.txns.length; i++) {
      var t = state.txns[i];
      if (t.method === 'card' && String(t.ts).slice(0, 10) === day) sum += t.amount;
    }
    return sum;
  }

  /**
   * The single gate into the ledger. txn: { amount, from, to, desc, category?,
   * method?, ts }. Returns { state, txn } or { error: 'code', message }.
   * Never throws, never mutates.
   */
  function post(state, txn) {
    var amount = Math.round(Number(txn.amount) || 0);
    if (amount <= 0) return { error: 'bad-amount', message: 'Amount must be positive.' };
    if (txn.from && !accountById(state, txn.from)) return { error: 'no-account', message: 'Unknown source account.' };
    if (txn.to && !accountById(state, txn.to)) return { error: 'no-account', message: 'Unknown destination account.' };
    if (!txn.from && !txn.to) return { error: 'no-account', message: 'A transaction needs at least one side.' };
    if (txn.from && txn.from === txn.to) return { error: 'same-account', message: 'Source and destination are the same.' };

    if (txn.method === 'card') {
      if (state.card.frozen) return { error: 'card-frozen', message: 'Your card is frozen.' };
      if (amount > state.card.limitPerTx) return { error: 'card-limit', message: 'Over your per-purchase limit of ' + fmt(state.card.limitPerTx) + '.' };
      if (cardSpentOn(state, txn.ts) + amount > state.card.limitDaily) {
        return { error: 'card-daily', message: 'That would pass your daily card limit of ' + fmt(state.card.limitDaily) + '.' };
      }
    }

    if (txn.from) {
      var acct = accountById(state, txn.from);
      var floor = acct.kind === 'current' ? -(acct.overdraft || 0) : 0; // pots never go negative
      if (balanceOf(state, txn.from) - amount < floor) {
        return { error: 'insufficient', message: 'Not enough in ' + acct.name + '.' };
      }
    }

    var s = clone(state);
    s.seq++;
    var posted = {
      id: 'tx' + s.seq,
      ts: String(txn.ts),
      amount: amount,
      from: txn.from || null,
      to: txn.to || null,
      desc: String(txn.desc || '').slice(0, 80),
      category: txn.category || categorise(txn.desc || '', txn),
      method: txn.method || 'transfer'
    };
    s.txns.push(posted);
    return { state: s, txn: posted };
  }

  /**
   * A card purchase with optional round-up: the spend posts from `current`,
   * and if round-ups are on, the to-the-next-pound remainder hops into the
   * round-up pot as a second txn (only if the spare change is actually there).
   */
  function cardPurchase(state, amount, merchant, ts) {
    var r = post(state, { amount: amount, from: 'current', to: null, desc: merchant, method: 'card', ts: ts });
    if (r.error) return r;
    var up = roundUp(amount);
    if (r.state.roundUpsTo && up > 0 && accountById(r.state, r.state.roundUpsTo)) {
      var r2 = post(r.state, { amount: up, from: 'current', to: r.state.roundUpsTo, desc: 'Round-up · ' + merchant, category: 'savings', method: 'roundup', ts: ts });
      if (!r2.error) return { state: r2.state, txn: r.txn, roundUpTxn: r2.txn };
    }
    return r;
  }

  /* ════════════════════════ pots & interest ════════════════════════ */

  function createPot(state, opts) {
    var s = clone(state);
    var n = 1;
    for (var i = 0; i < s.accounts.length; i++) {
      var m = /^pot-(\d+)$/.exec(s.accounts[i].id);
      if (m && +m[1] >= n) n = +m[1] + 1;
    }
    s.accounts.push({
      id: 'pot-' + n, kind: 'savings',
      name: String(opts.name || 'Pot').slice(0, 30),
      aerPct: Number(opts.aerPct) >= 0 ? Number(opts.aerPct) : 4.0,
      goal: Math.max(0, Math.round(Number(opts.goal) || 0)),
      lastAccrualISO: opts.nowISO
    });
    return s;
  }

  /**
   * Daily-compounded interest from the quoted AER, accrued for the whole days
   * between each pot's lastAccrualISO and toISO on the pot's current balance:
   * interest = ⌊bal·((1+AER/100)^(days/365) − 1)⌋ — the closed form of "daily
   * rate (1+AER)^(1/365)−1 compounded for `days`", written directly so that
   * exactly 365 days yields exactly the AER (no float drift via the daily
   * rate). Floored to whole pence; sub-penny accruals wait (lastAccrualISO
   * doesn't advance) so slow drips aren't rounded away forever.
   */
  function accrueInterest(state, toISOdate) {
    var s = state, day = String(toISOdate).slice(0, 10);
    for (var i = 0; i < state.accounts.length; i++) {
      var pot = state.accounts[i];
      if (pot.kind !== 'savings' || !(pot.aerPct > 0)) continue;
      var days = daysBetween(pot.lastAccrualISO, day);
      if (days <= 0) continue;
      var bal = balanceOf(s, pot.id);
      if (bal <= 0) { s = clone(s); accountById(s, pot.id).lastAccrualISO = day; continue; }
      var interest = Math.floor(bal * (Math.pow(1 + pot.aerPct / 100, days / 365) - 1));
      if (interest < 1) continue; // sub-penny: keep accruing from the old date
      var res = post(s, { amount: interest, from: null, to: pot.id, desc: 'Interest · ' + pot.aerPct.toFixed(1) + '% AER', category: 'interest', method: 'interest', ts: day + 'T00:00:00Z' });
      if (res.error) continue;
      s = res.state;
      accountById(s, pot.id).lastAccrualISO = day;
    }
    return s;
  }

  /* ════════════════════════ standing orders ════════════════════════ */

  function addOrder(state, opts) {
    var s = clone(state);
    var day = parseISO(opts.startISO).d;
    s.orders.push({
      id: 'so' + (s.orders.length + 1) + '-' + s.seq,
      to: String(opts.to || 'Payee').slice(0, 40),
      amount: Math.round(Number(opts.amount) || 0),
      freq: opts.freq === 'weekly' ? 'weekly' : 'monthly',
      anchorDay: day,
      nextISO: String(opts.startISO).slice(0, 10),
      desc: String(opts.desc || opts.to || 'Standing order').slice(0, 60),
      active: true
    });
    return s;
  }

  /**
   * Post every occurrence due on or before nowISO (catch-up safe: reopening
   * the app after a fortnight runs the missed ones in order). Skips — without
   * advancing — when funds are short, so the payment retries next open.
   */
  function runDueOrders(state, nowISO) {
    var s = state, day = String(nowISO).slice(0, 10), postedList = [];
    for (var guard = 0; guard < 400; guard++) {
      var due = null;
      for (var i = 0; i < s.orders.length; i++) {
        var o = s.orders[i];
        if (o.active && o.nextISO <= day && (!due || o.nextISO < due.nextISO)) due = o;
      }
      if (!due) break;
      var res = post(s, { amount: due.amount, from: 'current', to: null, desc: due.desc, category: categorise(due.desc), method: 'standing-order', ts: due.nextISO + 'T08:00:00Z' });
      if (res.error) break; // short of funds: stop, keep nextISO so it retries
      s = res.state;
      postedList.push(res.txn);
      s = clone(s);
      for (var j = 0; j < s.orders.length; j++) {
        if (s.orders[j].id === due.id) {
          s.orders[j].nextISO = due.freq === 'weekly'
            ? isoPlusDays(due.nextISO, 7)
            : nextMonthly(due.nextISO, due.anchorDay);
        }
      }
    }
    return { state: s, posted: postedList };
  }

  /**
   * Compact an overgrown ledger without changing a single balance: the oldest
   * transactions beyond `keep` are folded into one "Balance brought forward"
   * entry per affected account. Needed where a bank that lives for years must
   * stay inside a storage limit (the online bank's Firestore document);
   * balances are always derived from the ledger, so the fold must conserve
   * them exactly — the tests pin this.
   */
  function compact(state, keep) {
    keep = Math.max(0, Math.round(Number(keep) || 0));
    if (state.txns.length <= keep) return state;
    var s = clone(state);
    var removed = s.txns.slice(0, s.txns.length - keep);
    var kept = s.txns.slice(s.txns.length - keep);
    var net = {};
    for (var i = 0; i < removed.length; i++) {
      var t = removed[i];
      if (t.to) net[t.to] = (net[t.to] || 0) + t.amount;
      if (t.from) net[t.from] = (net[t.from] || 0) - t.amount;
    }
    var cutTs = removed[removed.length - 1].ts;
    var synth = [];
    for (var k in net) {
      if (net[k] === 0) continue;
      s.seq++;
      synth.push({
        id: 'bf' + s.seq, ts: cutTs, amount: Math.abs(net[k]),
        from: net[k] < 0 ? k : null, to: net[k] > 0 ? k : null,
        desc: 'Balance brought forward', category: 'transfers', method: 'carried'
      });
    }
    s.txns = synth.concat(kept);
    return s;
  }

  /* ════════════════════════ insight ════════════════════════ */

  var CATEGORIES = {
    groceries:  { label: 'Groceries',     icon: '🛒', words: ['tesco', 'sainsbury', 'aldi', 'lidl', 'asda', 'waitrose', 'morrisons', 'co-op', 'coop', 'grocer', 'supermarket'] },
    eating:     { label: 'Eating out',    icon: '🍽️', words: ['pret', 'greggs', 'mcdonald', 'nando', 'kfc', 'deliveroo', 'just eat', 'uber eats', 'costa', 'starbucks', 'cafe', 'caffe', 'coffee', 'restaurant', 'pizza', 'kebab'] },
    transport:  { label: 'Transport',     icon: '🚇', words: ['tfl', 'uber', 'bolt', 'trainline', 'rail', 'bus', 'shell', 'bp ', 'esso', 'petrol', 'parking'] },
    shopping:   { label: 'Shopping',      icon: '🛍️', words: ['amazon', 'ebay', 'asos', 'argos', 'ikea', 'zara', 'h&m', 'primark', 'currys', 'boots'] },
    bills:      { label: 'Bills & home',  icon: '🏠', words: ['rent', 'mortgage', 'council tax', 'octopus', 'edf', 'british gas', 'thames water', 'o2', 'vodafone', 'ee ', 'giffgaff', 'virgin media', 'insurance'] },
    subs:       { label: 'Subscriptions', icon: '📺', words: ['netflix', 'spotify', 'disney', 'prime', 'icloud', 'youtube', 'gym', 'membership'] },
    income:     { label: 'Income',        icon: '💷', words: ['salary', 'payroll', 'wages', 'refund', 'top up', 'top-up'] },
    savings:    { label: 'Savings',       icon: '🐖', words: ['round-up', 'pot transfer'] },
    interest:   { label: 'Interest',      icon: '✨', words: ['interest'] },
    transfers:  { label: 'Transfers',     icon: '↔️', words: ['transfer', 'sent to', 'from '] },
    other:      { label: 'Other',         icon: '💳', words: [] }
  };

  function categorise(desc, txn) {
    var d = String(desc || '').toLowerCase();
    for (var key in CATEGORIES) {
      var words = CATEGORIES[key].words;
      for (var i = 0; i < words.length; i++) {
        // match at a word start only — 'tfl' must not fire inside "netflix"
        var re = new RegExp('(^|[^a-z0-9])' + words[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (re.test(d)) return key;
      }
    }
    if (txn && !txn.from) return 'income';
    return 'other';
  }

  /** True spend only: money that left the bank (to: null), excluding pot moves. */
  function spendByCategory(state, month) {
    var out = {};
    for (var i = 0; i < state.txns.length; i++) {
      var t = state.txns[i];
      if (t.to !== null || monthKey(t.ts) !== month) continue;
      out[t.category] = (out[t.category] || 0) + t.amount;
    }
    var list = [];
    for (var k in out) list.push({ category: k, label: (CATEGORIES[k] || CATEGORIES.other).label, icon: (CATEGORIES[k] || CATEGORIES.other).icon, amount: out[k] });
    list.sort(function (a, b) { return b.amount - a.amount; });
    return list;
  }

  function inOut(state, month) {
    var moneyIn = 0, moneyOut = 0;
    for (var i = 0; i < state.txns.length; i++) {
      var t = state.txns[i];
      if (monthKey(t.ts) !== month) continue;
      if (t.from === null) moneyIn += t.amount;   // arrived from outside
      if (t.to === null) moneyOut += t.amount;    // left the bank
    }
    return { moneyIn: moneyIn, moneyOut: moneyOut, net: moneyIn - moneyOut };
  }

  /* ════════════════════════ statements ════════════════════════ */

  function csvEscape(v) {
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** A per-account statement with a running balance, oldest first. */
  function toCSV(state, accountId) {
    var rows = ['Date,Description,Category,In,Out,Balance'];
    var bal = 0;
    for (var i = 0; i < state.txns.length; i++) {
      var t = state.txns[i];
      var credit = t.to === accountId ? t.amount : 0;
      var debit = t.from === accountId ? t.amount : 0;
      if (!credit && !debit) continue;
      bal += credit - debit;
      rows.push([
        String(t.ts).slice(0, 10), csvEscape(t.desc), (CATEGORIES[t.category] || CATEGORIES.other).label,
        credit ? (credit / 100).toFixed(2) : '', debit ? (debit / 100).toFixed(2) : '', (bal / 100).toFixed(2)
      ].join(','));
    }
    return rows.join('\n');
  }

  /* ════════════════════════ demo history ════════════════════════ */

  /**
   * Seed ~3 months of believable life into the ledger, ending "today":
   * monthly salary, rent standing order, weekly-ish groceries, coffees,
   * transport, a few subscriptions — all deterministic from the rng seed.
   */
  function seedDemo(state, rng, nowISO) {
    var today = String(nowISO).slice(0, 10);
    var start = isoPlusDays(today, -92);
    var s = clone(state);
    // the story starts 92 days ago, so the pot's interest clock does too
    for (var ai = 0; ai < s.accounts.length; ai++) {
      if (s.accounts[ai].kind === 'savings') s.accounts[ai].lastAccrualISO = start;
    }
    var p = function (txn) { var r = post(s, txn); if (!r.error) s = r.state; };

    var merchants = [
      ['Tesco Express', 900, 3400], ['Sainsbury’s Local', 800, 2900], ['Pret A Manger', 380, 780],
      ['Costa Coffee', 300, 520], ['TfL Travel', 280, 560], ['Amazon', 700, 4200],
      ['Deliveroo', 1400, 2800], ['Boots', 400, 1600], ['Greggs', 210, 460]
    ];
    var salaryDay = 28;

    for (var d = 0; d <= 92; d++) {
      var iso = isoPlusDays(start, d);
      var pd = parseISO(iso);
      var payDay = Math.min(salaryDay, daysInMonth(pd.y, pd.m));
      if (pd.d === payDay) {
        p({ amount: 264500, from: null, to: 'current', desc: 'Salary · Northline Studio', category: 'income', method: 'faster-payment', ts: iso + 'T06:30:00Z' });
      }
      if (pd.d === 1) {
        p({ amount: 92500, from: 'current', to: null, desc: 'Rent · Flat 4', category: 'bills', method: 'standing-order', ts: iso + 'T08:00:00Z' });
      }
      if (pd.d === 5) p({ amount: 1099, from: 'current', to: null, desc: 'Netflix', category: 'subs', method: 'card', ts: iso + 'T04:10:00Z' });
      if (pd.d === 7) p({ amount: 1199, from: 'current', to: null, desc: 'Spotify', category: 'subs', method: 'card', ts: iso + 'T04:12:00Z' });
      if (pd.d === 15) p({ amount: 20000, from: 'current', to: 'pot-1', desc: 'Pot transfer · Rainy day', category: 'savings', method: 'transfer', ts: iso + 'T09:00:00Z' });

      // day-to-day card spend, 0–2 purchases a day
      var n = rng() < 0.35 ? 0 : rng() < 0.75 ? 1 : 2;
      for (var k = 0; k < n; k++) {
        var m = merchants[Math.floor(rng() * merchants.length)];
        var amt = m[1] + Math.floor(rng() * (m[2] - m[1]));
        var hh = 9 + Math.floor(rng() * 11);
        p({ amount: amt, from: 'current', to: null, desc: m[0], method: 'card', ts: iso + 'T' + (hh < 10 ? '0' + hh : hh) + ':' + (rng() < 0.5 ? '15' : '45') + ':00Z' });
      }
    }

    s = accrueInterest(s, today);
    s = addOrder(s, { to: 'Landlord', amount: 92500, freq: 'monthly', startISO: nextMonthly(today, 1), desc: 'Rent · Flat 4' });
    s = clone(s);
    s.contacts = [
      { name: 'Amelia Khan', sortCode: '04-00-72', accountNumber: '18334911' },
      { name: 'Josh Carter', sortCode: '04-00-04', accountNumber: '55010268' },
      { name: 'Mum', sortCode: '20-45-45', accountNumber: '73920014' }
    ];
    return s;
  }

  /* ════════════════════════ exports ════════════════════════ */

  return {
    fmt: fmt, parseAmount: parseAmount, roundUp: roundUp,
    mulberry32: mulberry32,
    luhnDigit: luhnDigit, luhnValid: luhnValid, makeCard: makeCard, maskPan: maskPan, groupPan: groupPan,
    makeSortCode: makeSortCode, makeAccountNumber: makeAccountNumber, ibanFor: ibanFor, ibanValid: ibanValid, mod97: mod97,
    parseISO: parseISO, isoPlusDays: isoPlusDays, daysBetween: daysBetween, daysInMonth: daysInMonth,
    monthKey: monthKey, nextMonthly: nextMonthly,
    openBank: openBank, hashPin: hashPin, setPin: setPin, verifyPin: verifyPin,
    accountById: accountById, balanceOf: balanceOf, totalBalance: totalBalance,
    post: post, cardPurchase: cardPurchase, cardSpentOn: cardSpentOn,
    createPot: createPot, accrueInterest: accrueInterest, compact: compact,
    addOrder: addOrder, runDueOrders: runDueOrders,
    CATEGORIES: CATEGORIES, categorise: categorise, spendByCategory: spendByCategory, inOut: inOut,
    toCSV: toCSV, seedDemo: seedDemo
  };
});
