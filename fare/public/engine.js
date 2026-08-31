/**
 * fare/public/engine.js — every business rule of Fare, the chauffeur
 * job-logging + invoicing app, as pure functions. Zero DOM, zero I/O,
 * zero clock: money is integer pence, time arrives as ISO strings or an
 * injected `now`. The same file runs in the browser (<script src>), in
 * the Node server (createRequire), and in the vm test sandbox.
 */
(function (root) {
  'use strict';

  /* ───────────────────────── money (integer pence) ───────────────────────── */

  // '90', '£1,234.5', ' 12.50 ' → pence; junk/negative → null
  function parseMoney(input) {
    if (typeof input === 'number' && isFinite(input) && input >= 0) return Math.round(input * 100);
    if (typeof input !== 'string') return null;
    var s = input.replace(/[£\s,]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  }

  function formatMoney(pence) {
    if (typeof pence !== 'number' || !isFinite(pence)) pence = 0;
    var neg = pence < 0;
    pence = Math.abs(Math.round(pence));
    var pounds = String(Math.floor(pence / 100));
    var out = '';
    while (pounds.length > 3) { out = ',' + pounds.slice(-3) + out; pounds = pounds.slice(0, -3); }
    out = pounds + out;
    return (neg ? '-£' : '£') + out + '.' + String(pence % 100).padStart(2, '0');
  }

  /* ─────────────────────────────── dates ─────────────────────────────── */

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function isoDate(now) { // ms since epoch → 'YYYY-MM-DD' (UTC)
    var d = new Date(now);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') +
      '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  function validIsoDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
  function validTime(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }

  // Calendar-safe day arithmetic: '2026-01-31' + 14 → '2026-02-14'
  function addDaysISO(iso, days) {
    var t = Date.parse(iso + 'T00:00:00Z') + days * 86400000;
    return isoDate(t);
  }

  function monthKey(isoOrMonth) { return String(isoOrMonth || '').slice(0, 7); }

  function monthLabel(key) { // '2026-08' → 'August 2026'
    var m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
    if (!m) return String(key || '');
    return (MONTHS[+m[2] - 1] || m[2]) + ' ' + m[1];
  }

  function shiftMonth(key, delta) { // '2026-01' + (-1) → '2025-12'
    var m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
    if (!m) return key;
    var n = (+m[1]) * 12 + (+m[2] - 1) + delta;
    var y = Math.floor(n / 12), mo = n % 12;
    return y + '-' + String(mo + 1).padStart(2, '0');
  }

  function formatDayLabel(iso) { // '2026-08-31' → 'Mon 31 Aug'
    if (!validIsoDate(iso)) return String(iso || '');
    var d = new Date(iso + 'T00:00:00Z');
    return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3);
  }

  function formatDateLong(iso) { // '2026-08-31' → '31 August 2026'
    if (!validIsoDate(iso)) return String(iso || '');
    var d = new Date(iso + 'T00:00:00Z');
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  /* ─────────────────────────────── extras ─────────────────────────────── */

  var EXTRA_TYPES = [
    { key: 'parking', label: 'Parking' },
    { key: 'airport', label: 'Airport drop-off' },
    { key: 'ulez', label: 'ULEZ', defaultAmount: 1250 },
    { key: 'tolls', label: 'Tolls' },
    { key: 'other', label: 'Other' },
  ];

  function extraLabel(extra) {
    if (extra.type === 'other' && extra.label) return String(extra.label);
    for (var i = 0; i < EXTRA_TYPES.length; i++) if (EXTRA_TYPES[i].key === extra.type) return EXTRA_TYPES[i].label;
    return extra.type || 'Extra';
  }

  function normaliseExtras(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length && out.length < 20; i++) {
      var e = raw[i] || {};
      var known = EXTRA_TYPES.some(function (t) { return t.key === e.type; });
      var amount = typeof e.amount === 'number' && isFinite(e.amount) && e.amount >= 0 ? Math.round(e.amount) : null;
      if (!known || amount === null || amount === 0) continue;
      var item = { type: e.type, amount: amount };
      if (e.type === 'other') item.label = String(e.label || 'Other').slice(0, 60);
      out.push(item);
    }
    return out;
  }

  /* ───────────────────────────── job maths ───────────────────────────── */

  // Waiting is chargeable pro-rata per minute at an hourly rate (in pence).
  function waitCharge(minutes, ratePerHourPence) {
    minutes = Math.max(0, Math.round(minutes || 0));
    ratePerHourPence = Math.max(0, Math.round(ratePerHourPence || 0));
    return Math.round(minutes * ratePerHourPence / 60);
  }

  function extrasTotal(extras) {
    return (extras || []).reduce(function (s, e) { return s + (e.amount || 0); }, 0);
  }

  function jobTotal(job) {
    return (job.fare || 0) + waitCharge(job.waitMinutes, job.waitRate) + extrasTotal(job.extras);
  }

  function sumJobs(jobs) {
    return (jobs || []).reduce(function (s, j) { return s + jobTotal(j); }, 0);
  }

  function filterJobs(jobs, opts) {
    opts = opts || {};
    return (jobs || []).filter(function (j) {
      if (opts.clientId && j.clientId !== opts.clientId) return false;
      if (opts.month && monthKey(j.date) !== opts.month) return false;
      return true;
    });
  }

  function sortJobs(jobs) { // newest first
    return (jobs || []).slice().sort(function (a, b) {
      var ka = (a.date || '') + 'T' + (a.time || '00:00');
      var kb = (b.date || '') + 'T' + (b.time || '00:00');
      return ka < kb ? 1 : ka > kb ? -1 : (b.id || 0) - (a.id || 0);
    });
  }

  /* ─────────────────── remembered routes (taps, not typing) ─────────────────── */

  // A client's regular routes, learned from their job history: deduped by
  // pickup→dropoff, most-used first, each carrying the latest fare/wait/extras
  // as a one-tap template for the job form.
  function routeSuggestions(jobs, clientId, limit) {
    limit = limit || 6;
    var byKey = {}, order = [];
    var sorted = sortJobs(filterJobs(jobs, { clientId: clientId })); // newest first
    for (var i = 0; i < sorted.length; i++) {
      var j = sorted[i];
      if (!j.pickup && !j.dropoff) continue;
      var key = (j.pickup || '').trim().toLowerCase() + '→' + (j.dropoff || '').trim().toLowerCase();
      if (!byKey[key]) {
        byKey[key] = {
          pickup: j.pickup || '', dropoff: j.dropoff || '', fare: j.fare || 0,
          waitRate: j.waitRate || 0, extras: (j.extras || []).slice(), count: 0,
        };
        order.push(key);
      }
      byKey[key].count++;
    }
    return order.map(function (k) { return byKey[k]; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, limit);
  }

  /* ───────────────────────────── validation ───────────────────────────── */

  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }

  function validateClient(input) {
    input = input || {};
    var name = str(input.name, 80);
    if (!name) return { ok: false, error: 'Client name is required.' };
    var terms = Math.round(Number(input.termsDays));
    if (!isFinite(terms) || terms < 0 || terms > 365) terms = 14;
    var waitRate = typeof input.waitRate === 'number' && isFinite(input.waitRate) && input.waitRate >= 0
      ? Math.round(input.waitRate) : 0;
    return {
      ok: true,
      client: {
        name: name,
        email: str(input.email, 120),
        address: str(input.address, 400),
        termsDays: terms,
        waitRate: waitRate,
        notes: str(input.notes, 600),
      },
    };
  }

  function validateJob(input, clientIds) {
    input = input || {};
    var clientId = Math.round(Number(input.clientId));
    if (!clientId || (clientIds && clientIds.indexOf(clientId) < 0)) return { ok: false, error: 'Pick a client.' };
    if (!validIsoDate(input.date)) return { ok: false, error: 'Job needs a valid date.' };
    var time = validTime(input.time) ? input.time : '';
    var fare = typeof input.fare === 'number' ? Math.round(input.fare) : parseMoney(input.fare);
    if (fare === null || fare < 0) return { ok: false, error: 'Fare must be a valid amount (0 or more).' };
    var waitMinutes = Math.round(Number(input.waitMinutes));
    if (!isFinite(waitMinutes) || waitMinutes < 0 || waitMinutes > 24 * 60) waitMinutes = 0;
    var waitRate = typeof input.waitRate === 'number' && isFinite(input.waitRate) && input.waitRate >= 0
      ? Math.round(input.waitRate) : 0;
    return {
      ok: true,
      job: {
        clientId: clientId,
        date: input.date,
        time: time,
        pickup: str(input.pickup, 160),
        dropoff: str(input.dropoff, 160),
        fare: fare,
        waitMinutes: waitMinutes,
        waitRate: waitRate,
        extras: normaliseExtras(input.extras),
        notes: str(input.notes, 400),
      },
    };
  }

  var SETTINGS_DEFAULTS = {
    businessName: '', ownerName: '', address: '', phone: '', email: '',
    logo: null,                 // data:image/jpeg;base64,… (embedded in the PDF)
    bankAccountName: '', bankSortCode: '', bankAccountNumber: '', bankName: '',
    invoicePrefix: 'INV-', nextNumber: 1,
    vatEnabled: false, vatNumber: '', vatRatePct: 20,
    defaultWaitRate: 0,         // pence per hour, prefilled on new jobs
    defaultTermsDays: 14,
    footerNote: '',
  };

  function normaliseSettings(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var s = {};
    for (var k in SETTINGS_DEFAULTS) {
      s[k] = raw[k] == null ? SETTINGS_DEFAULTS[k] : raw[k];
    }
    s.businessName = str(s.businessName, 120);
    s.ownerName = str(s.ownerName, 120);
    s.address = str(s.address, 400);
    s.phone = str(s.phone, 40);
    s.email = str(s.email, 120);
    s.bankAccountName = str(s.bankAccountName, 120);
    s.bankSortCode = str(s.bankSortCode, 12);
    s.bankAccountNumber = str(s.bankAccountNumber, 16);
    s.bankName = str(s.bankName, 80);
    s.invoicePrefix = str(s.invoicePrefix, 12) || 'INV-';
    s.nextNumber = Math.max(1, Math.round(Number(s.nextNumber)) || 1);
    s.vatEnabled = !!s.vatEnabled;
    s.vatNumber = str(s.vatNumber, 20);
    var rate = Number(s.vatRatePct);
    s.vatRatePct = isFinite(rate) && rate >= 0 && rate <= 100 ? Math.round(rate * 100) / 100 : 20;
    s.defaultWaitRate = Math.max(0, Math.round(Number(s.defaultWaitRate)) || 0);
    var terms = Math.round(Number(s.defaultTermsDays));
    s.defaultTermsDays = isFinite(terms) && terms >= 0 && terms <= 365 ? terms : 14;
    s.footerNote = str(s.footerNote, 300);
    s.logo = typeof s.logo === 'string' && /^data:image\/jpeg;base64,/.test(s.logo) && s.logo.length < 400000
      ? s.logo : null;
    return s;
  }

  /* ───────────────────────────── invoicing ───────────────────────────── */

  function formatInvoiceNumber(prefix, n) {
    return String(prefix || '') + String(Math.max(1, Math.round(n) || 1)).padStart(4, '0');
  }

  // Group a client's uninvoiced jobs by month → the "ready to invoice" list.
  function uninvoicedGroups(jobs, clients) {
    var names = {};
    (clients || []).forEach(function (c) { names[c.id] = c.name; });
    var groups = {}, order = [];
    (jobs || []).forEach(function (j) {
      if (j.invoiceId) return;
      var key = j.clientId + '|' + monthKey(j.date);
      if (!groups[key]) {
        groups[key] = { clientId: j.clientId, clientName: names[j.clientId] || ('Client ' + j.clientId), month: monthKey(j.date), count: 0, total: 0 };
        order.push(key);
      }
      groups[key].count++;
      groups[key].total += jobTotal(j);
    });
    return order.map(function (k) { return groups[k]; })
      .sort(function (a, b) { return a.month < b.month ? 1 : a.month > b.month ? -1 : a.clientName < b.clientName ? -1 : 1; });
  }

  // One tap: a client's jobs for one month → a complete, self-contained
  // invoice snapshot (business + client details frozen at generation time,
  // so later edits never change an issued invoice).
  function buildInvoice(opts) {
    var client = opts.client, jobs = opts.jobs || [], settings = normaliseSettings(opts.settings);
    var todayISO = validIsoDate(opts.todayISO) ? opts.todayISO : isoDate(opts.now || 0);
    if (!client) return { ok: false, error: 'Unknown client.' };
    if (!jobs.length) return { ok: false, error: 'No uninvoiced jobs for that month.' };
    var month = opts.month || monthKey(jobs[0].date);
    var lines = sortJobs(jobs).reverse().map(function (j) { // oldest first on the invoice
      return {
        jobId: j.id,
        date: j.date, time: j.time || '',
        pickup: j.pickup || '', dropoff: j.dropoff || '',
        fare: j.fare || 0,
        waitMinutes: j.waitMinutes || 0,
        waitRate: j.waitRate || 0,
        waitCharge: waitCharge(j.waitMinutes, j.waitRate),
        extras: (j.extras || []).map(function (e) { return { type: e.type, label: extraLabel(e), amount: e.amount }; }),
        total: jobTotal(j),
      };
    });
    var subtotal = lines.reduce(function (s, l) { return s + l.total; }, 0);
    var vatAmount = settings.vatEnabled ? Math.round(subtotal * settings.vatRatePct / 100) : 0;
    var termsDays = client.termsDays == null ? settings.defaultTermsDays : client.termsDays;
    var number = Math.max(1, Math.round(opts.number) || settings.nextNumber);
    return {
      ok: true,
      invoice: {
        number: number,
        displayNumber: formatInvoiceNumber(settings.invoicePrefix, number),
        clientId: client.id,
        period: month,
        issueDate: todayISO,
        dueDate: addDaysISO(todayISO, termsDays),
        termsDays: termsDays,
        status: 'sent',
        subtotal: subtotal,
        vatEnabled: settings.vatEnabled,
        vatRatePct: settings.vatRatePct,
        vatAmount: vatAmount,
        total: subtotal + vatAmount,
        snapshot: {
          termsDays: termsDays,
          business: {
            name: settings.businessName, ownerName: settings.ownerName, address: settings.address,
            phone: settings.phone, email: settings.email, vatNumber: settings.vatNumber,
          },
          client: { name: client.name, address: client.address || '', email: client.email || '' },
          bank: {
            accountName: settings.bankAccountName, sortCode: settings.bankSortCode,
            accountNumber: settings.bankAccountNumber, bankName: settings.bankName,
          },
          footerNote: settings.footerNote,
          lines: lines,
        },
      },
    };
  }

  // Stored status is only 'sent' | 'paid'; overdue is derived from the clock.
  function invoiceStatus(inv, todayISO) {
    if (inv.status === 'paid') return 'paid';
    if (inv.dueDate && todayISO > inv.dueDate) return 'overdue';
    return 'sent';
  }

  /* ─────────────────────────────── misc ─────────────────────────────── */

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var api = {
    parseMoney: parseMoney, formatMoney: formatMoney,
    isoDate: isoDate, validIsoDate: validIsoDate, validTime: validTime,
    addDaysISO: addDaysISO, monthKey: monthKey, monthLabel: monthLabel, shiftMonth: shiftMonth,
    formatDayLabel: formatDayLabel, formatDateLong: formatDateLong,
    EXTRA_TYPES: EXTRA_TYPES, extraLabel: extraLabel, normaliseExtras: normaliseExtras,
    waitCharge: waitCharge, extrasTotal: extrasTotal, jobTotal: jobTotal, sumJobs: sumJobs,
    filterJobs: filterJobs, sortJobs: sortJobs, routeSuggestions: routeSuggestions,
    validateClient: validateClient, validateJob: validateJob,
    SETTINGS_DEFAULTS: SETTINGS_DEFAULTS, normaliseSettings: normaliseSettings,
    formatInvoiceNumber: formatInvoiceNumber, uninvoicedGroups: uninvoicedGroups,
    buildInvoice: buildInvoice, invoiceStatus: invoiceStatus,
    escapeHtml: escapeHtml,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FareEngine = api;
})(typeof self !== 'undefined' ? self : this);
