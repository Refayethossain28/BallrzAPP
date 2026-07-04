/* Velvet — optional cloud layer (accounts, sync, real billing)
 * =============================================================
 * Everything cloud-side lives behind this file so the app itself stays
 * local-first: with no config (or no network, or nothing deployed) every call
 * here is a safe no-op and Velvet behaves exactly as the pure offline demo.
 *
 * What it adds when ../concierge/config.js points at a Firebase project:
 *   Accounts   email/password sign-up & sign-in, or one-tap guest (anonymous).
 *   Sync       the member doc (velvet_members/{uid}) and one doc per request
 *              (velvet_requests/{id}) mirror the local state; live snapshot
 *              listeners feed remote changes back and the app reconciles them
 *              with the pure engine mergeStates()/mergeRequests() helpers —
 *              so a real concierge desk (an admin updating request docs) shows
 *              up in the member's thread in real time.
 *   Billing    Stripe Billing via the Cloud Functions in functions/src/velvet.ts:
 *              startCheckout() → hosted Checkout (7-day trial), openPortal() →
 *              Billing Portal. The webhook writes subscription truth into the
 *              member doc; when billing === 'stripe' this file never pushes
 *              sub/billing/invoices up (and the security rules enforce it).
 *
 * Loads the same compat SDK the sibling apps use (9.23.0), lazily and only
 * when init() runs with a config present. Classic script — smoke-sandbox safe:
 * top level only defines window.VelvetCloud.
 */
(function () {
  'use strict';

  var FB_VER = '9.23.0';
  var cfg = (typeof window !== 'undefined' && window.VELVET_FIREBASE_CONFIG) || null;
  var region = (typeof window !== 'undefined' && window.VELVET_FUNCTIONS_REGION) || 'us-central1';

  var H = {};                                   // init() handlers
  var auth = null, db = null, fns = null;
  var unsubs = [];
  var remote = { member: undefined, invoices: null, requests: null };
  var pendingState = null, pushTimer = null, pushedReq = {};

  var cloud = {
    status: cfg ? 'idle' : 'off',               // off|idle|loading|signedout|on|error
    user: null,
    lastError: null,
    serverBilled: false,                        // true once the Stripe webhook owns the sub
    enabled: function () { return !!cfg; },
    init: init,
    signUp: function (email, pass) { return auth ? auth.createUserWithEmailAndPassword(email, pass) : noAuth(); },
    signIn: function (email, pass) { return auth ? auth.signInWithEmailAndPassword(email, pass) : noAuth(); },
    signInGuest: function () { return auth ? auth.signInAnonymously() : noAuth(); },
    signOut: function () { return auth ? auth.signOut() : noAuth(); },
    push: schedulePush,
    startCheckout: startCheckout,
    openPortal: openPortal,
    askDesk: askDesk,
    track: track,
    dispatchChauffeur: dispatchChauffeur,
    reportError: reportError,
  };
  if (typeof window !== 'undefined') window.VelvetCloud = cloud;

  function noAuth() { return Promise.reject(new Error('Cloud is not available')); }

  /* ---- crash reporting — same `errors` collection the other apps use ---- */
  var _errCount = 0;
  function reportError(where, err) {
    try {
      if (!db || _errCount >= 10) return;      // capped so a render loop can't spam
      _errCount++;
      db.collection('errors').add({
        app: 'concierge', where: String(where || ''),
        message: String((err && err.message) || err || '').slice(0, 500),
        stack: String((err && err.stack) || '').slice(0, 1500),
        url: (typeof location !== 'undefined' && location.href) || '',
        ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
        at: Date.now(),
      }).catch(function () {});
    } catch (e) {}
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('error', function (e) { reportError('window', e.error || e.message); });
    window.addEventListener('unhandledrejection', function (e) { reportError('promise', e.reason); });
  }
  function setStatus(s) { cloud.status = s; if (H.onStatus) try { H.onStatus(s); } catch (e) {} }

  /* ---- lazy compat SDK loader (same pattern as ripple/) ---- */
  var sdkState = 0, sdkCbs = [];                // 0 idle · 1 loading · 2 ok · 3 failed
  function loadSdk(cb) {
    if (typeof firebase !== 'undefined' && firebase.auth && firebase.firestore && firebase.functions) { cb(true); return; }
    if (sdkState === 2) { cb(true); return; }
    if (sdkState === 3) { cb(false); return; }
    sdkCbs.push(cb);
    if (sdkState === 1) return;
    sdkState = 1;
    var parts = ['app', 'auth', 'firestore', 'functions', 'app-check'];
    var i = 0;
    function finish(ok) {
      sdkState = ok ? 2 : 3;
      var cbs = sdkCbs; sdkCbs = [];
      for (var c = 0; c < cbs.length; c++) try { cbs[c](ok); } catch (e) {}
    }
    (function next() {
      if (i >= parts.length) { finish(true); return; }
      var s = document.createElement('script');
      s.src = 'https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-' + parts[i] + '-compat.js';
      s.async = false;
      s.onload = function () { i++; next(); };
      s.onerror = function () { finish(false); };
      (document.head || document.documentElement).appendChild(s);
    })();
  }

  /* ---- boot ---- */
  function init(handlers) {
    H = handlers || {};
    if (!cfg) { setStatus('off'); return; }
    setStatus('loading');
    loadSdk(function (ok) {
      if (!ok) { setStatus('error'); return; }
      try {
        var app = firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
        // App Check (reCAPTCHA v3) — abuse protection for the backend. Off
        // until a site key is set in config.js; see SETUP.md.
        try {
          if (window.VELVET_APPCHECK_KEY && firebase.appCheck) {
            firebase.appCheck().activate(window.VELVET_APPCHECK_KEY, true);
          }
        } catch (e) {}
        auth = firebase.auth(app);
        db = firebase.firestore(app);
        fns = app.functions ? app.functions(region) : null;
      } catch (e) { cloud.lastError = e; setStatus('error'); return; }
      auth.onAuthStateChanged(function (u) {
        detach();
        cloud.user = u ? { uid: u.uid, email: u.email || null, isAnonymous: !!u.isAnonymous } : null;
        if (H.onAuth) try { H.onAuth(cloud.user); } catch (e) {}
        if (!u) { cloud.serverBilled = false; setStatus('signedout'); return; }
        setStatus('on');
        attach(u.uid);
      });
    });
  }

  /* ---- live mirrors ---- */
  function detach() {
    for (var i = 0; i < unsubs.length; i++) try { unsubs[i](); } catch (e) {}
    unsubs = [];
    remote = { member: undefined, invoices: null, requests: null };
    pushedReq = {};
  }

  function attach(uid) {
    var onErr = function (e) { cloud.lastError = e; };
    unsubs.push(db.collection('velvet_members').doc(uid).onSnapshot(function (s) {
      remote.member = s.exists ? s.data() : null;
      cloud.serverBilled = !!(remote.member &&
        (remote.member.billing === 'stripe' || remote.member.billing === 'stripe-mock'));
      emitRemote();
    }, onErr));
    unsubs.push(db.collection('velvet_members').doc(uid).collection('invoices').onSnapshot(function (q) {
      var out = [];
      q.forEach(function (d) { out.push(d.data()); });
      remote.invoices = out;
      emitRemote();
    }, onErr));
    unsubs.push(db.collection('velvet_requests').where('ownerUid', '==', uid).onSnapshot(function (q) {
      var out = [];
      q.forEach(function (d) { out.push(d.data()); });
      remote.requests = out;
      emitRemote();
    }, onErr));
  }

  /** Shape the three mirrors into one member-state the app can merge. */
  function emitRemote() {
    if (remote.member === undefined) return;    // member snapshot not in yet
    var m = remote.member || {};
    var state = {
      memberName: m.memberName || '',
      memberSince: m.memberSince || 0,
      billing: m.billing || 'local',
      sub: m.sub || null,
      invoices: (m.invoices || []).concat(remote.invoices || []),
      requests: remote.requests || [],
      points: m.points || 0,
      spentPence: m.spentPence || 0,
    };
    if (H.onRemote) try { H.onRemote(state); } catch (e) {}
  }

  /* ---- push (debounced, echo-safe) ---- */
  function schedulePush(state) {
    if (!db || !cloud.user || !state) return;
    pendingState = state;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, 900);
  }

  function doPush() {
    if (!db || !cloud.user || !pendingState) return;
    var s = pendingState, uid = cloud.user.uid;
    var member = {
      memberName: s.memberName || '',
      memberSince: s.memberSince || 0,
      billing: s.billing || 'local',
      sub: s.sub || null,
      invoices: s.invoices || [],
      points: s.points || 0,
      spentPence: s.spentPence || 0,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    // Once the Stripe webhook owns billing, the client never writes entitlement
    // fields (the rules would reject the whole update if it tried).
    if (cloud.serverBilled) { delete member.billing; delete member.sub; delete member.invoices; }

    var batch = db.batch();
    batch.set(db.collection('velvet_members').doc(uid), member, { merge: true });
    var reqs = s.requests || [];
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      if (!r || !r.id) continue;
      var key = JSON.stringify(r);
      if (pushedReq[r.id] === key) continue;    // unchanged since last push
      pushedReq[r.id] = key;
      batch.set(db.collection('velvet_requests').doc(r.id), Object.assign({}, r, { ownerUid: uid }));
    }
    batch.commit().catch(function (e) { cloud.lastError = e; });
  }

  /* ---- Stripe Billing via Cloud Functions ---- */
  function callFn(name, data) {
    if (!fns) return Promise.reject(new Error('Cloud Functions unavailable'));
    return fns.httpsCallable(name)(data).then(function (r) { return r.data || {}; });
  }
  function hereUrl() {
    try { return String(location.href).split('#')[0]; } catch (e) { return ''; }
  }
  /** Returns {url} to redirect to, or {mock:true} when the server granted a mock trial. */
  function startCheckout(tierId) {
    return callFn('createVelvetCheckout', { tier: tierId, successUrl: hereUrl(), cancelUrl: hereUrl() });
  }
  /** Returns {url} for the Stripe Billing Portal, or {mock:true}. */
  function openPortal() {
    return callFn('createVelvetPortal', { returnUrl: hereUrl() });
  }

  /* ---- analytics — the shared ApexVIP pipeline ---- */
  /** Same contract as track() in the client/driver/admin apps: append to the
   *  apexvip_events localStorage log and, when the cloud is up and the user is
   *  signed in, mirror to the shared Firestore `analytics` collection that the
   *  admin app aggregates. Fire-and-forget; never throws. */
  function track(event, props) {
    try {
      var ev = Object.assign({ e: event, event: event, t: Date.now(), ts: Date.now(), src: 'concierge' }, props || {});
      var key = 'apexvip_events';
      var arr = JSON.parse(localStorage.getItem(key) || '[]');
      arr.push(ev);
      if (arr.length > 2000) arr.splice(0, arr.length - 2000);
      localStorage.setItem(key, JSON.stringify(arr));
      if (db && cloud.user) db.collection('analytics').add(ev).catch(function () {});
    } catch (e) {}
  }

  /* ---- chauffeur hand-off — into the ApexVIP dispatch pipeline ---- */
  /** A confirmed chauffeur request becomes a real ApexVIP booking (same shape
   *  the client app writes), so the existing onBookingCreated Cloud Function
   *  broadcasts it to the driver app and it appears in the admin's Bookings.
   *  Resolves the booking ref; rejects when the cloud isn't available. */
  function dispatchChauffeur(request, option, memberName) {
    if (!db || !cloud.user) return Promise.reject(new Error('Cloud is not available'));
    var pounds = Math.round((option.pricePence || 0) / 100);
    var ref = 'APX-C' + String(Math.floor(1000 + Math.random() * 9000));
    return db.collection('bookings').add({
      ref: ref,
      clientId: cloud.user.uid,
      clientName: memberName || 'Concierge member',
      clientEmail: cloud.user.email || '',
      serviceType: 'point',
      serviceLabel: 'Concierge chauffeur — ' + (option.name || ''),
      pickup: request.title || '',
      dropoff: request.details || '',
      airport: '', flight: '', date: '', time: '',
      vehicle: option.name || 'Chauffeur',
      vehicleId: '',
      price: pounds,
      baseFare: pounds,
      discount: 0,
      vat: Math.round(pounds / 6),
      promoApplied: false,
      status: 'confirmed',
      squarePaymentId: null,
      paymentStatus: 'pending',
      driverName: '', driverRating: null, driverPlate: '',
      location: 'london',
      concierge: { source: 'concierge-app', requestId: request.id, option: option.name || '' },
      paMode: false, paPassenger: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).then(function () {
      track('booking_confirmed', { price: pounds, service: 'point', vehicle: option.name || 'Chauffeur', user: memberName || 'Concierge member' });
      return ref;
    });
  }

  /* ---- ApexAI — the live desk brain ---- */
  /** Ask ApexAI (the same parseBookingIntent function the ApexVIP client uses,
   *  in its Velvet persona). payload: {message, history, now, context}.
   *  Resolves {reply}; rejects when the cloud/function is unavailable — the
   *  app then falls back to the scripted desk. */
  function askDesk(payload) {
    return callFn('parseBookingIntent', Object.assign({ mode: 'velvet' }, payload || {}));
  }
})();
