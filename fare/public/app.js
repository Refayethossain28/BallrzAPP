/**
 * fare/public/app.js — the Fare UI. All rendering + API calls; every business
 * rule (money, totals, validation, statuses) comes from engine.js (FareEngine).
 * Built for one-thumb phone use: the job form is chips first, typing last.
 */
(function (root) {
  'use strict';
  var E = root.FareEngine;
  if (!E) return;

  /* ── tiny helpers ── */
  var esc = E.escapeHtml;
  var $ = function (id) { return document.getElementById(id); };
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  function localDate(d) { d = d || new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function localTime(d) { d = d || new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

  var toastTimer = 0;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 2600);
  }

  /* ── state ── */
  var state = {
    tab: 'jobs',            // jobs | invoices | clients | settings | jobform | clientform | login
    settings: null, clients: [], jobs: [], jobsTotal: 0, invoices: [], uninvoiced: [],
    emailLog: [],
    me: null,               // /api/me: account, access, billing/email availability
    month: localDate().slice(0, 7), clientFilter: 0,
    form: null,             // job form model {id, clientId, extras:[], routes:[]}
    clientForm: null,       // {id} while editing a client
    loginSent: '',          // email address a sign-in link went to
    devLink: '',            // dev-mode magic link (no email provider configured)
  };

  /* ── API (session or owner-key auth; optionally pointed at a remote Fare
        server, so the static copy in the hub can drive a hosted backend) ── */
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function getKey() { return lsGet('fareKey'); }
  function getSession() { return lsGet('fareSession'); }
  function getServer() { return lsGet('fareServer').trim().replace(/\/+$/, ''); }
  // For <a>/location downloads, where headers can't travel.
  function authedUrl(url) {
    var s = getSession(), k = getKey();
    var q = s ? 'session=' + encodeURIComponent(s) : k ? 'key=' + encodeURIComponent(k) : '';
    return getServer() + (q ? url + (url.indexOf('?') >= 0 ? '&' : '?') + q : url);
  }
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (getSession()) init.headers['x-fare-session'] = getSession();
    if (getKey()) init.headers['x-fare-key'] = getKey();
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(getServer() + path, init).then(function (res) {
      return res.json().then(function (data) {
        if (res.status === 401) {
          state.tab = 'login';
          render();
          throw new Error((data && data.error) || 'sign in to continue');
        }
        if (res.status >= 400) throw new Error((data && data.error) || ('request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  /* ── data loading ── */
  function loadCore() {
    return Promise.all([api('/api/settings'), api('/api/clients'), api('/api/me')]).then(function (r) {
      state.settings = r[0];
      state.clients = r[1];
      state.me = r[2];
    });
  }
  function loadJobs() {
    var q = '/api/jobs?month=' + state.month + (state.clientFilter ? '&client=' + state.clientFilter : '');
    return api(q).then(function (r) { state.jobs = r.jobs; state.jobsTotal = r.total; });
  }
  function loadInvoices() {
    return api('/api/invoices').then(function (r) {
      state.invoices = r.invoices;
      state.uninvoiced = r.uninvoiced;
      state.emailLog = r.emailLog || [];
    });
  }

  /* ── rendering ── */
  function render() {
    var tabs = document.querySelectorAll ? document.querySelectorAll('#tabs button') : [];
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].className = tabs[i].getAttribute('data-tab') === state.tab ? 'on' : '';
    }
    $('fab').style.display = state.tab === 'jobs' || state.tab === 'invoices' ? '' : 'none';
    var html = '';
    if (state.tab === 'login') html = viewLogin();
    else if (state.tab === 'jobs') html = viewJobs();
    else if (state.tab === 'invoices') html = viewInvoices();
    else if (state.tab === 'clients') html = viewClients();
    else if (state.tab === 'settings') html = viewSettings();
    else if (state.tab === 'jobform') html = viewJobForm();
    else if (state.tab === 'clientform') html = viewClientForm();
    // Trial over / payment failed → everything still readable, writes gated.
    if (state.tab !== 'login' && state.me && state.me.access && state.me.access.readOnly) {
      html = '<div class="card" style="border-color:rgba(224,168,58,.5)"><b>Read-only</b>' +
        '<div class="muted small">' + esc(state.me.access.reason || '') + '</div>' +
        (state.me.billing && state.me.billing.enabled
          ? '<button class="btn-sm gold" style="margin-top:8px" data-act="subscribe">Subscribe — £9.99/month</button>' : '') +
        '</div>' + html;
    }
    $('view').innerHTML = html;
    if (typeof scrollTo === 'function') scrollTo(0, 0);
  }

  function clientName(id) {
    var c = (state.clients || []).filter(function (x) { return x.id === id; })[0];
    return c ? c.name : 'Client ' + id;
  }

  /* ---- Login (magic link) ---- */
  function viewLogin() {
    if (state.loginSent) {
      return '<div class="card" style="margin-top:24px"><b>Check your email</b>' +
        '<p class="muted small">We sent a sign-in link to <b>' + esc(state.loginSent) + '</b>. ' +
        'Tap it on this device — it works once and lasts 15 minutes.</p>' +
        (state.devLink
          ? '<p class="muted small">Dev mode (no email provider configured):</p>' +
            '<button class="primary" data-act="dev-link">Open sign-in link</button>'
          : '') +
        '<button class="secondary" data-act="login-again">Use a different email</button></div>';
    }
    return '<div class="card" style="margin-top:24px"><b>Sign in to Fare</b>' +
      '<p class="muted small">Your jobs, clients and invoices live in your own account. ' +
      'No password — we email you a sign-in link.</p>' +
      '<label class="f">Email</label><input id="login-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com">' +
      '<button class="primary" data-act="send-link">Email me a sign-in link</button>' +
      '<p class="muted small">New here? The same button starts your free 30-day trial — no card needed.</p></div>';
  }

  /* ---- Jobs tab ---- */
  function viewJobs() {
    var chips = '<div class="chips">' +
      '<button class="chip' + (!state.clientFilter ? ' on' : '') + '" data-act="filter-client" data-id="0">All clients</button>' +
      (state.clients || []).map(function (c) {
        return '<button class="chip' + (state.clientFilter === c.id ? ' on' : '') + '" data-act="filter-client" data-id="' + c.id + '">' + esc(c.name) + '</button>';
      }).join('') + '</div>';

    var jobs = state.jobs || [];
    var cards = jobs.length ? jobs.map(function (j) {
      var extras = (j.extras || []).map(function (e) { return esc(E.extraLabel(e)); }).join(' · ');
      var wait = j.waitMinutes ? j.waitMinutes + ' min wait' : '';
      var sub = [wait, extras].filter(Boolean).join(' · ');
      return '<div class="card tap" data-act="edit-job" data-id="' + j.id + '">' +
        '<div class="row"><div><b>' + esc(clientName(j.clientId)) + '</b>' +
        '<div class="muted small">' + esc(E.formatDayLabel(j.date)) + (j.time ? ' · ' + esc(j.time) : '') + '</div></div>' +
        '<div style="text-align:right"><span class="amount">' + E.formatMoney(E.jobTotal(j)) + '</span>' +
        (j.invoiceId ? '<div><span class="pill invoiced">invoiced</span></div>' : '') + '</div></div>' +
        '<div class="muted small" style="margin-top:6px">' + esc(j.pickup || '?') + ' → ' + esc(j.dropoff || '?') + '</div>' +
        (sub ? '<div class="muted small">' + sub + '</div>' : '') +
        '</div>';
    }).join('') : '<div class="empty">No jobs in ' + esc(E.monthLabel(state.month)) + '.<br>Tap <b class="gold">+</b> to log one in seconds.</div>';

    return '<div class="monthbar">' +
      '<button data-act="month-prev">‹</button><b>' + esc(E.monthLabel(state.month)) + '</b><button data-act="month-next">›</button></div>' +
      chips +
      '<div class="totalbar"><span class="muted">' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's') +
      (state.clientFilter ? ' · ' + esc(clientName(state.clientFilter)) : '') + '</span>' +
      '<span class="amount">' + E.formatMoney(state.jobsTotal || 0) + '</span></div>' +
      cards;
  }

  /* ---- Job form (the ≤30-second flow) ---- */
  function newJobForm() {
    var lastClient = Number((function () { try { return localStorage.getItem('fareLastClient'); } catch (e) { return 0; } })()) || 0;
    return {
      id: 0, clientId: 0, routes: [],
      date: localDate(), time: localTime(),
      pickup: '', dropoff: '', fare: '',
      waitMinutes: 0, waitRate: null, // null → resolve from client/settings on pick
      extras: [], notes: '',
      pendingClient: lastClient,
    };
  }

  function resolveWaitRate(clientId) {
    var c = (state.clients || []).filter(function (x) { return x.id === clientId; })[0];
    if (c && c.waitRate) return c.waitRate;
    return (state.settings && state.settings.defaultWaitRate) || 0;
  }

  function pickClient(id) {
    var f = state.form;
    f.clientId = id;
    if (f.waitRate === null || !f.id) f.waitRate = resolveWaitRate(id);
    f.routes = [];
    render();
    api('/api/routes?client=' + id).then(function (routes) {
      if (state.form === f && f.clientId === id) { f.routes = routes; render(); }
    }).catch(function () { /* suggestions are optional */ });
  }

  function viewJobForm() {
    var f = state.form;
    var clientChips = '<div class="chips">' + (state.clients || []).map(function (c) {
      return '<button class="chip' + (f.clientId === c.id ? ' on' : '') + '" data-act="pick-client" data-id="' + c.id + '">' + esc(c.name) + '</button>';
    }).join('') + '<button class="chip ghost" data-act="new-client">+ New client</button></div>';

    var routeChips = f.clientId && (f.routes || []).length
      ? '<label class="f">Regular routes — tap to fill</label><div class="chips">' + f.routes.map(function (r, i) {
        return '<button class="chip" data-act="pick-route" data-id="' + i + '">' +
          esc(r.pickup || '?') + ' → ' + esc(r.dropoff || '?') + ' · ' + E.formatMoney(r.fare) +
          (r.count > 1 ? ' ×' + r.count : '') + '</button>';
      }).join('') + '</div>' : '';

    var extraRows = (E.EXTRA_TYPES || []).map(function (t) {
      var current = (f.extras || []).filter(function (e) { return e.type === t.key; })[0];
      var on = !!current;
      var chip = '<button class="chip' + (on ? ' on' : '') + '" data-act="toggle-extra" data-id="' + t.key + '">' + esc(t.label) + '</button>';
      return { chip: chip, row: on ? ('<div class="grid2" style="margin-top:8px">' +
        (t.key === 'other'
          ? '<input id="extra-label-other" placeholder="What was it?" value="' + esc(current.label || '') + '">'
          : '<div style="align-self:center" class="muted">' + esc(t.label) + '</div>') +
        '<input id="extra-amount-' + t.key + '" inputmode="decimal" placeholder="£" value="' +
        (current.amount ? (current.amount / 100) : '') + '"></div>') : '' };
    });

    return '<button class="back" data-act="back-jobs">‹ Jobs</button>' +
      '<h2 style="margin:6px 0 2px">' + (f.id ? 'Edit job' : 'New job') + '</h2>' +
      '<label class="f">Client</label>' + clientChips + routeChips +
      '<div class="grid2"><div><label class="f">Date</label><input type="date" id="jf-date" value="' + esc(f.date) + '"></div>' +
      '<div><label class="f">Time</label><input type="time" id="jf-time" value="' + esc(f.time) + '"></div></div>' +
      '<label class="f">Pickup</label><input id="jf-pickup" placeholder="e.g. Home / Claridge’s" value="' + esc(f.pickup) + '">' +
      '<label class="f">Drop-off</label><input id="jf-dropoff" placeholder="e.g. Heathrow T5" value="' + esc(f.dropoff) + '">' +
      '<label class="f">Fare (£)</label><input id="jf-fare" inputmode="decimal" placeholder="0.00" value="' + esc(f.fare) + '">' +
      '<label class="f">Waiting time — chargeable per hour, pro-rata</label>' +
      '<div class="stepper"><button data-act="wait-minus">−15</button>' +
      '<input id="jf-wait" inputmode="numeric" style="text-align:center" value="' + (f.waitMinutes || 0) + '">' +
      '<button data-act="wait-plus">+15</button><span class="muted small">min</span></div>' +
      '<label class="f">Waiting rate (£/hour)</label><input id="jf-waitrate" inputmode="decimal" value="' +
      ((f.waitRate || 0) ? (f.waitRate / 100) : '') + '" placeholder="0">' +
      '<label class="f">Extras</label><div class="chips">' + extraRows.map(function (x) { return x.chip; }).join('') + '</div>' +
      extraRows.map(function (x) { return x.row; }).join('') +
      '<label class="f">Notes (optional)</label><input id="jf-notes" value="' + esc(f.notes) + '">' +
      '<button class="primary" data-act="save-job">Save job</button>' +
      (f.id ? '<button class="secondary danger" data-act="delete-job">Delete job</button>' : '');
  }

  function readJobForm() {
    var f = state.form;
    f.date = $('jf-date').value;
    f.time = $('jf-time').value;
    f.pickup = $('jf-pickup').value;
    f.dropoff = $('jf-dropoff').value;
    f.fare = $('jf-fare').value;
    f.waitMinutes = Math.max(0, Math.round(Number($('jf-wait').value)) || 0);
    var rate = E.parseMoney($('jf-waitrate').value);
    f.waitRate = rate === null ? 0 : rate;
    f.notes = $('jf-notes').value;
    f.extras = (f.extras || []).map(function (e) {
      var amtEl = $('extra-amount-' + e.type);
      var amount = amtEl ? E.parseMoney(amtEl.value) : e.amount;
      var out = { type: e.type, amount: amount === null ? 0 : amount };
      if (e.type === 'other') {
        var lab = $('extra-label-other');
        out.label = lab ? lab.value : e.label;
      }
      return out;
    });
  }

  function saveJob() {
    readJobForm();
    var f = state.form;
    var payload = {
      clientId: f.clientId, date: f.date, time: f.time, pickup: f.pickup, dropoff: f.dropoff,
      fare: f.fare, waitMinutes: f.waitMinutes, waitRate: f.waitRate, extras: f.extras, notes: f.notes,
    };
    var req = f.id ? api('/api/jobs/' + f.id, { method: 'PUT', body: payload })
      : api('/api/jobs', { method: 'POST', body: payload });
    req.then(function (job) {
      try { localStorage.setItem('fareLastClient', String(f.clientId)); } catch (e) { /* fine */ }
      state.month = E.monthKey(job.date) || state.month;
      state.tab = 'jobs';
      state.form = null;
      toast('Job saved — ' + E.formatMoney(E.jobTotal(job)));
      loadJobs().then(render);
    }).catch(function (err) { toast(err.message); });
  }

  /* ---- Invoices tab ---- */
  function viewInvoices() {
    var ready = (state.uninvoiced || []).length
      ? '<div class="section">Ready to invoice</div>' + state.uninvoiced.map(function (g) {
        return '<div class="card"><div class="row"><div><b>' + esc(g.clientName) + '</b>' +
          '<div class="muted small">' + esc(E.monthLabel(g.month)) + ' · ' + g.count + ' job' + (g.count === 1 ? '' : 's') + '</div></div>' +
          '<div style="text-align:right"><div class="amount">' + E.formatMoney(g.total) + '</div>' +
          '<button class="btn-sm gold" style="margin-top:6px" data-act="generate" data-id="' + g.clientId + '|' + g.month + '">Generate</button>' +
          '</div></div></div>';
      }).join('')
      : '';

    var today = localDate();
    var sends = {};
    (state.emailLog || []).forEach(function (e) {
      if (!e.invoiceId) return;
      var s = sends[e.invoiceId] || { invoice: 0, reminder: 0 };
      if (e.kind === 'invoice') s.invoice++;
      if (e.kind === 'reminder') s.reminder++;
      sends[e.invoiceId] = s;
    });
    var canEmail = state.me && state.me.email && state.me.email.enabled;
    var list = (state.invoices || []).length
      ? '<div class="section">Invoices</div>' + state.invoices.map(function (inv) {
        var st = inv.derivedStatus || E.invoiceStatus(inv, today);
        var sent = sends[inv.id];
        var sentLine = sent
          ? '<div class="muted small">' +
            (sent.invoice ? 'Emailed ×' + sent.invoice : '') +
            (sent.reminder ? (sent.invoice ? ' · ' : '') + 'Chased ×' + sent.reminder : '') + '</div>'
          : '';
        return '<div class="card"><div class="row"><div><b>' + esc(inv.displayNumber) + '</b> <span class="pill ' + st + '">' + st + '</span>' +
          '<div class="muted small">' + esc((inv.snapshot && inv.snapshot.client && inv.snapshot.client.name) || clientName(inv.clientId)) +
          ' · ' + esc(E.monthLabel(inv.period)) + '</div>' +
          '<div class="muted small">Issued ' + esc(E.formatDayLabel(inv.issueDate)) + ' · due ' + esc(E.formatDayLabel(inv.dueDate)) +
          (inv.paidDate ? ' · paid ' + esc(E.formatDayLabel(inv.paidDate)) : '') + '</div>' + sentLine + '</div>' +
          '<span class="amount">' + E.formatMoney(inv.total) + '</span></div>' +
          '<div class="chips" style="padding-top:10px">' +
          '<button class="btn-sm" data-act="pdf" data-id="' + inv.id + '">⬇ PDF</button>' +
          (canEmail && inv.status !== 'paid'
            ? '<button class="btn-sm" data-act="email-inv" data-id="' + inv.id + '">📧 Email' + (sent && sent.invoice ? ' again' : '') + '</button>'
            : '') +
          (inv.status === 'paid'
            ? '<button class="btn-sm" data-act="mark-sent" data-id="' + inv.id + '">Mark unpaid</button>'
            : '<button class="btn-sm" data-act="mark-paid" data-id="' + inv.id + '">Mark paid</button>') +
          '<button class="btn-sm danger" data-act="void" data-id="' + inv.id + '">Void</button>' +
          '</div></div>';
      }).join('')
      : '<div class="empty">No invoices yet.<br>Log jobs, then generate a month’s invoice per client in one tap.</div>';

    return ready + list;
  }

  /* ---- Clients tab ---- */
  function viewClients() {
    var cards = (state.clients || []).length ? state.clients.map(function (c) {
      var bits = ['Pays in ' + c.termsDays + ' days'];
      if (c.waitRate) bits.push('Waiting ' + E.formatMoney(c.waitRate) + '/hr');
      if (c.email) bits.push(c.email);
      return '<div class="card tap" data-act="edit-client" data-id="' + c.id + '"><b>' + esc(c.name) + '</b>' +
        '<div class="muted small">' + esc(bits.join(' · ')) + '</div></div>';
    }).join('') : '<div class="empty">No clients yet — add your first.</div>';
    return '<button class="primary" data-act="new-client" style="margin-top:8px">+ Add client</button>' + cards;
  }

  function viewClientForm() {
    var id = state.clientForm && state.clientForm.id;
    var c = id ? (state.clients || []).filter(function (x) { return x.id === id; })[0] || {} : {};
    return '<button class="back" data-act="back-clients">‹ Clients</button>' +
      '<h2 style="margin:6px 0 2px">' + (id ? 'Edit client' : 'New client') + '</h2>' +
      '<label class="f">Name</label><input id="cf-name" value="' + esc(c.name || '') + '">' +
      '<label class="f">Email</label><input id="cf-email" type="email" value="' + esc(c.email || '') + '">' +
      '<label class="f">Billing address</label><textarea id="cf-address">' + esc(c.address || '') + '</textarea>' +
      '<div class="grid2"><div><label class="f">Payment terms (days)</label>' +
      '<input id="cf-terms" inputmode="numeric" value="' + (c.termsDays != null ? c.termsDays : (state.settings ? state.settings.defaultTermsDays : 14)) + '"></div>' +
      '<div><label class="f">Waiting rate (£/hr)</label>' +
      '<input id="cf-waitrate" inputmode="decimal" value="' + (c.waitRate ? c.waitRate / 100 : '') + '" placeholder="default"></div></div>' +
      '<label class="f">Notes</label><textarea id="cf-notes">' + esc(c.notes || '') + '</textarea>' +
      '<div class="switch"><span>Never auto-chase this client</span><input type="checkbox" id="cf-chase-optout"' + (c.chaseOptout ? ' checked' : '') + '></div>' +
      '<button class="primary" data-act="save-client">Save client</button>' +
      (id ? '<button class="secondary danger" data-act="archive-client" data-id="' + id + '">Archive client</button>' : '');
  }

  function saveClient() {
    var id = state.clientForm && state.clientForm.id;
    var rate = E.parseMoney($('cf-waitrate').value);
    var payload = {
      name: $('cf-name').value, email: $('cf-email').value, address: $('cf-address').value,
      termsDays: Number($('cf-terms').value), waitRate: rate === null ? 0 : rate,
      notes: $('cf-notes').value,
      chaseOptout: !!$('cf-chase-optout').checked,
    };
    var req = id ? api('/api/clients/' + id, { method: 'PUT', body: payload })
      : api('/api/clients', { method: 'POST', body: payload });
    req.then(function () {
      toast('Client saved');
      return loadCore();
    }).then(function () {
      // if we came from the job form, go back there with the newest client picked
      if (state.form) {
        state.tab = 'jobform';
        var newest = (state.clients || []).reduce(function (a, c) { return c.id > (a && a.id || 0) ? c : a; }, null);
        if (!id && newest) pickClient(newest.id); else render();
      } else {
        state.tab = 'clients';
        render();
      }
      state.clientForm = null;
    }).catch(function (err) { toast(err.message); });
  }

  /* ---- Settings tab ---- */
  function viewAccount() {
    var me = state.me || {};
    var acct = me.account || {};
    var access = me.access || {};
    var bits = [];
    if (acct.status === 'active') bits.push('<span class="pill paid">subscribed</span>');
    else if (access.readOnly) bits.push('<span class="pill overdue">read-only</span>');
    else if (acct.status === 'trial' && access.trialDaysLeft != null) {
      bits.push('<span class="pill sent">trial · ' + access.trialDaysLeft + ' day' + (access.trialDaysLeft === 1 ? '' : 's') + ' left</span>');
    }
    var buttons = '';
    if (me.billing && me.billing.enabled) {
      if (acct.status === 'active') buttons += '<button class="btn-sm" data-act="billing-portal">Manage billing</button>';
      else buttons += '<button class="btn-sm gold" data-act="subscribe">Subscribe — £9.99/month</button>';
    }
    if (me.via === 'session') buttons += '<button class="btn-sm" data-act="sign-out">Sign out</button>';
    return '<div class="section">Account</div><div class="card"><div class="row"><div>' +
      '<b>' + esc(acct.email || 'Owner (API key)') + '</b>' +
      (me.via === 'key' && !acct.email
        ? '<div class="muted small">Sign in with your email once to attach this data to your account.</div>' : '') +
      '</div><div>' + bits.join(' ') + '</div></div>' +
      (buttons ? '<div class="chips" style="padding-top:10px">' + buttons + '</div>' : '') +
      '</div>';
  }

  function viewSettings() {
    var s = state.settings || {};
    return viewAccount() +
      '<div class="section">Your business (appears on invoices)</div>' +
      '<label class="f">Business name</label><input id="st-name" value="' + esc(s.businessName || '') + '">' +
      '<label class="f">Your name</label><input id="st-owner" value="' + esc(s.ownerName || '') + '">' +
      '<label class="f">Address</label><textarea id="st-address">' + esc(s.address || '') + '</textarea>' +
      '<div class="grid2"><div><label class="f">Phone</label><input id="st-phone" value="' + esc(s.phone || '') + '"></div>' +
      '<div><label class="f">Email</label><input id="st-email" value="' + esc(s.email || '') + '"></div></div>' +
      '<label class="f">Logo (shown top-right of the PDF)</label>' +
      (s.logo ? '<p><img class="logo-preview" src="' + s.logo + '" alt="logo"> <button class="btn-sm" data-act="clear-logo">Remove</button></p>' : '') +
      '<input type="file" id="st-logo" accept="image/*">' +
      '<div class="section">Bank details (invoice footer)</div>' +
      '<label class="f">Account name</label><input id="st-acctname" value="' + esc(s.bankAccountName || '') + '">' +
      '<div class="grid2"><div><label class="f">Sort code</label><input id="st-sort" value="' + esc(s.bankSortCode || '') + '"></div>' +
      '<div><label class="f">Account number</label><input id="st-acctno" value="' + esc(s.bankAccountNumber || '') + '"></div></div>' +
      '<label class="f">Bank name</label><input id="st-bank" value="' + esc(s.bankName || '') + '">' +
      '<div class="section">Invoicing</div>' +
      '<div class="grid2"><div><label class="f">Invoice prefix</label><input id="st-prefix" value="' + esc(s.invoicePrefix || 'INV-') + '"></div>' +
      '<div><label class="f">Next number</label><input id="st-next" inputmode="numeric" value="' + (s.nextNumber || 1) + '"></div></div>' +
      '<div class="switch"><span>VAT registered</span><input type="checkbox" id="st-vat"' + (s.vatEnabled ? ' checked' : '') + '></div>' +
      '<div class="grid2"><div><label class="f">VAT number</label><input id="st-vatno" value="' + esc(s.vatNumber || '') + '"></div>' +
      '<div><label class="f">VAT rate %</label><input id="st-vatrate" inputmode="decimal" value="' + (s.vatRatePct != null ? s.vatRatePct : 20) + '"></div></div>' +
      '<div class="grid2"><div><label class="f">Default waiting £/hr</label><input id="st-waitrate" inputmode="decimal" value="' +
      (s.defaultWaitRate ? s.defaultWaitRate / 100 : '') + '"></div>' +
      '<div><label class="f">Default terms (days)</label><input id="st-terms" inputmode="numeric" value="' + (s.defaultTermsDays != null ? s.defaultTermsDays : 14) + '"></div></div>' +
      '<label class="f">Invoice footer note</label><input id="st-footer" placeholder="e.g. Thank you for your business" value="' + esc(s.footerNote || '') + '">' +
      '<div class="section">Payment chasing</div>' +
      '<div class="switch"><span>Auto-chase overdue invoices by email</span><input type="checkbox" id="st-chase"' + (s.chaseEnabled ? ' checked' : '') + '></div>' +
      '<p class="muted small">Once an invoice passes its due date, a polite reminder (with the PDF attached) goes to the client, then again every few days — until it’s marked paid, the limit is reached, or the client is opted out.</p>' +
      '<div class="grid2"><div><label class="f">Days between reminders</label><input id="st-chase-days" inputmode="numeric" value="' + (s.chaseIntervalDays != null ? s.chaseIntervalDays : 7) + '"></div>' +
      '<div><label class="f">Max reminders</label><input id="st-chase-max" inputmode="numeric" value="' + (s.chaseMax != null ? s.chaseMax : 3) + '"></div></div>' +
      (state.me && state.me.email && !state.me.email.enabled
        ? '<p class="muted small">⚠ Email sending isn’t configured on this server yet (RESEND_API_KEY) — chasing stays off until it is.</p>' : '') +
      '<button class="primary" data-act="save-settings">Save settings</button>' +
      '<div class="section">Your data</div>' +
      '<button class="secondary" data-act="backup">Download backup (JSON)</button>' +
      '<p class="muted small">Back up regularly — it’s your whole business in one file. Restore by POSTing it to /api/restore (see README).</p>';
  }

  function readSettingsForm() {
    var s = Object.assign({}, state.settings || {});
    s.businessName = $('st-name').value;
    s.ownerName = $('st-owner').value;
    s.address = $('st-address').value;
    s.phone = $('st-phone').value;
    s.email = $('st-email').value;
    s.bankAccountName = $('st-acctname').value;
    s.bankSortCode = $('st-sort').value;
    s.bankAccountNumber = $('st-acctno').value;
    s.bankName = $('st-bank').value;
    s.invoicePrefix = $('st-prefix').value;
    s.nextNumber = Number($('st-next').value);
    s.vatEnabled = !!$('st-vat').checked;
    s.vatNumber = $('st-vatno').value;
    s.vatRatePct = Number($('st-vatrate').value);
    var wr = E.parseMoney($('st-waitrate').value);
    s.defaultWaitRate = wr === null ? 0 : wr;
    s.defaultTermsDays = Number($('st-terms').value);
    s.footerNote = $('st-footer').value;
    s.chaseEnabled = !!$('st-chase').checked;
    s.chaseIntervalDays = Number($('st-chase-days').value);
    s.chaseMax = Number($('st-chase-max').value);
    return s;
  }

  function handleLogoFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var maxW = 400;
        var scale = Math.min(1, maxW / img.width);
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // JPEG has no alpha — white ground
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        state.settings.logo = canvas.toDataURL('image/jpeg', 0.85);
        toast('Logo ready — tap Save settings');
        render();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  /* ── actions (event delegation) ── */
  function handle(act, id, el) {
    if (act === 'filter-client') { state.clientFilter = Number(id) || 0; loadJobs().then(render); }
    else if (act === 'month-prev') { state.month = E.shiftMonth(state.month, -1); loadJobs().then(render); }
    else if (act === 'month-next') { state.month = E.shiftMonth(state.month, 1); loadJobs().then(render); }
    else if (act === 'edit-job') {
      var j = (state.jobs || []).filter(function (x) { return x.id === Number(id); })[0];
      if (!j) return;
      if (j.invoiceId) { toast('This job is on an invoice — void the invoice to edit it.'); return; }
      state.form = {
        id: j.id, clientId: j.clientId, routes: [], date: j.date, time: j.time,
        pickup: j.pickup, dropoff: j.dropoff, fare: j.fare ? String(j.fare / 100) : '',
        waitMinutes: j.waitMinutes, waitRate: j.waitRate, extras: (j.extras || []).slice(), notes: j.notes,
      };
      state.tab = 'jobform';
      render();
      pickClient(j.clientId);
    }
    else if (act === 'back-jobs') { state.tab = 'jobs'; state.form = null; render(); }
    else if (act === 'pick-client') { readJobForm(); pickClient(Number(id)); }
    else if (act === 'pick-route') {
      readJobForm();
      var r = (state.form.routes || [])[Number(id)];
      if (!r) return;
      state.form.pickup = r.pickup;
      state.form.dropoff = r.dropoff;
      state.form.fare = r.fare ? String(r.fare / 100) : '';
      if (r.waitRate) state.form.waitRate = r.waitRate;
      state.form.extras = (r.extras || []).slice();
      render();
    }
    else if (act === 'toggle-extra') {
      readJobForm();
      var f = state.form;
      var existing = (f.extras || []).filter(function (e) { return e.type === id; })[0];
      if (existing) f.extras = f.extras.filter(function (e) { return e.type !== id; });
      else {
        var t = (E.EXTRA_TYPES || []).filter(function (x) { return x.key === id; })[0] || {};
        f.extras = (f.extras || []).concat([{ type: id, amount: t.defaultAmount || 0, label: '' }]);
      }
      render();
    }
    else if (act === 'wait-minus' || act === 'wait-plus') {
      readJobForm();
      state.form.waitMinutes = Math.max(0, state.form.waitMinutes + (act === 'wait-plus' ? 15 : -15));
      render();
    }
    else if (act === 'save-job') {
      if (!state.form.clientId) { toast('Pick a client first'); return; }
      saveJob();
    }
    else if (act === 'delete-job') {
      if (!confirm('Delete this job?')) return;
      api('/api/jobs/' + state.form.id, { method: 'DELETE' }).then(function () {
        state.tab = 'jobs'; state.form = null;
        toast('Job deleted');
        loadJobs().then(render);
      }).catch(function (err) { toast(err.message); });
    }
    else if (act === 'generate') {
      var parts = String(id).split('|');
      api('/api/invoices', { method: 'POST', body: { clientId: Number(parts[0]), month: parts[1] } })
        .then(function (inv) {
          toast('Invoice ' + inv.displayNumber + ' created — ' + E.formatMoney(inv.total));
          return loadInvoices();
        }).then(render)
        .catch(function (err) { toast(err.message); });
    }
    else if (act === 'pdf') { location.href = authedUrl('/api/invoices/' + Number(id) + '/pdf'); }
    else if (act === 'email-inv') {
      var target = (state.invoices || []).filter(function (x) { return x.id === Number(id); })[0];
      if (!confirm('Email ' + (target ? target.displayNumber : 'this invoice') + ' (PDF attached) to the client now?')) return;
      api('/api/invoices/' + Number(id) + '/email', { method: 'POST', body: {} })
        .then(function (r) { toast(r.sent ? 'Emailed to ' + r.to : 'Logged (dev mode) — to ' + r.to); return loadInvoices(); })
        .then(render)
        .catch(function (err) { toast(err.message); });
    }
    else if (act === 'mark-paid' || act === 'mark-sent') {
      api('/api/invoices/' + Number(id), { method: 'PATCH', body: { status: act === 'mark-paid' ? 'paid' : 'sent' } })
        .then(function () { return loadInvoices(); }).then(render)
        .catch(function (err) { toast(err.message); });
    }
    else if (act === 'void') {
      if (!confirm('Void this invoice? Its jobs go back to "ready to invoice"; the number is not reused.')) return;
      api('/api/invoices/' + Number(id), { method: 'DELETE' })
        .then(function () { toast('Invoice voided'); return loadInvoices(); }).then(render)
        .catch(function (err) { toast(err.message); });
    }
    else if (act === 'new-client') {
      if (state.tab === 'jobform') readJobForm();
      state.clientForm = { id: 0 };
      state.tab = 'clientform';
      render();
    }
    else if (act === 'edit-client') { state.clientForm = { id: Number(id) }; state.tab = 'clientform'; render(); }
    else if (act === 'back-clients') {
      state.clientForm = null;
      state.tab = state.form ? 'jobform' : 'clients';
      render();
    }
    else if (act === 'save-client') { saveClient(); }
    else if (act === 'archive-client') {
      if (!confirm('Archive this client? Their history stays; they leave the pickers.')) return;
      api('/api/clients/' + Number(id), { method: 'PUT', body: { archived: true } })
        .then(function () { state.clientForm = null; state.tab = 'clients'; return loadCore(); })
        .then(render).catch(function (err) { toast(err.message); });
    }
    else if (act === 'save-settings') {
      api('/api/settings', { method: 'PUT', body: readSettingsForm() }).then(function (s) {
        state.settings = s;
        toast('Settings saved');
        render();
      }).catch(function (err) { toast(err.message); });
    }
    else if (act === 'clear-logo') { state.settings.logo = null; toast('Logo removed — tap Save settings'); render(); }
    else if (act === 'backup') { location.href = authedUrl('/api/backup'); }
    else if (act === 'send-link') {
      var addr = String($('login-email').value || '').trim();
      if (!E.validEmail(addr)) { toast('Enter a valid email address'); return; }
      api('/api/auth/request', { method: 'POST', body: { email: addr } }).then(function (r) {
        state.loginSent = addr;
        state.devLink = r.devLink || '';
        render();
      }).catch(function (err) { toast(err.message); });
    }
    else if (act === 'login-again') { state.loginSent = ''; state.devLink = ''; render(); }
    else if (act === 'dev-link') { if (state.devLink) location.href = state.devLink; }
    else if (act === 'sign-out') {
      api('/api/auth/logout', { method: 'POST', body: {} }).catch(function () { /* best effort */ });
      lsSet('fareSession', '');
      state.me = null;
      state.tab = 'login';
      state.loginSent = '';
      render();
    }
    else if (act === 'subscribe') {
      api('/api/billing/checkout', { method: 'POST', body: {} })
        .then(function (r) { if (r.url) location.href = r.url; })
        .catch(function (err) { toast(err.message); });
    }
    else if (act === 'billing-portal') {
      api('/api/billing/portal', { method: 'POST', body: {} })
        .then(function (r) { if (r.url) location.href = r.url; })
        .catch(function (err) { toast(err.message); });
    }
    else if (act === 'save-server') {
      var url = String($('srv-url').value || '').trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
      try { localStorage.setItem('fareServer', url); } catch (e) { /* private mode */ }
      location.reload();
    }
  }

  /* ── boot ── */
  function boot() {
    document.addEventListener('click', function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act],[data-tab]') : null;
      if (!el) return;
      var tab = el.getAttribute('data-tab');
      if (tab) {
        state.tab = tab;
        state.form = null;
        state.clientForm = null;
        render();
        var reload = tab === 'jobs' ? loadJobs() : tab === 'invoices' ? loadInvoices() : loadCore();
        reload.then(render).catch(function () { /* offline: show what we have */ });
        return;
      }
      var act = el.getAttribute('data-act');
      if (act) { ev.preventDefault(); try { handle(act, el.getAttribute('data-id'), el); } catch (err) { toast(String(err.message || err)); } }
    });
    document.addEventListener('change', function (ev) {
      if (ev.target && ev.target.id === 'st-logo' && ev.target.files && ev.target.files[0]) {
        handleLogoFile(ev.target.files[0]);
      }
    });
    $('fab').addEventListener('click', function () {
      state.form = newJobForm();
      state.tab = 'jobform';
      render();
      if (state.form.pendingClient && (state.clients || []).some(function (c) { return c.id === state.form.pendingClient; })) {
        pickClient(state.form.pendingClient);
      }
    });
    // deep links (also used by the manifest's home-screen shortcuts):
    // #jobs #invoices #clients #settings #new (straight into the job form)
    var hash = String((location && location.hash) || '').replace('#', '');
    if (hash === 'new') { state.form = newJobForm(); state.tab = 'jobform'; }
    else if (['jobs', 'invoices', 'clients', 'settings'].indexOf(hash) >= 0) state.tab = hash;
    var search = String((location && location.search) || '');
    if (search.indexOf('billing=success') >= 0) { state.tab = 'settings'; toast('Subscription active — thank you!'); }
    loadCore()
      .then(function () { return Promise.all([loadJobs(), loadInvoices()]); })
      .then(render)
      .catch(function (err) {
        // A 401 already switched to the sign-in screen — leave it be.
        if (state.tab === 'login') return;
        // No API here (e.g. the static copy in the Ballrz hub) or the server
        // is down — offer to connect to a hosted Fare server instead.
        $('view').innerHTML =
          '<div class="empty" style="padding-bottom:10px">Could not reach a Fare server here.<br>' +
          '<span class="small">' + esc(String(err && err.message || err)) + '</span></div>' +
          '<div class="card"><b>Connect to your Fare server</b>' +
          '<p class="muted small">Fare keeps your jobs and invoices on your own server (see fare/README.md). ' +
          'Enter its address once — this page remembers it.</p>' +
          '<input id="srv-url" inputmode="url" placeholder="e.g. https://fare-xxxx.onrender.com" value="' + esc(getServer()) + '">' +
          '<button class="primary" data-act="save-server">Connect</button>' +
          '<p class="muted small">Running it yourself? <code>node fare/server.mjs</code> then open that address.</p></div>';
      });
  }

  root.FareApp = { boot: boot };
})(typeof self !== 'undefined' ? self : this);
