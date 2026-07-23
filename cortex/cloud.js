/* Cortex — optional cloud layer (accounts + real Pro billing)
 * ============================================================
 * Everything cloud-side lives behind this file so the app itself stays
 * local-first: with no config (or no network, or nothing deployed) every call
 * here is a safe no-op and Cortex behaves exactly as the pure offline demo.
 *
 * What it adds when ./config.js points at a Firebase project:
 *   Accounts   email/password sign-up & sign-in, or one-tap guest (anonymous).
 *   Membership the member doc (cortex_members/{uid}) mirrors the local Pro
 *              subscription; a live snapshot listener feeds remote changes
 *              back so a membership follows the member across devices.
 *   Billing    Stripe Billing via the Cloud Functions in functions/src/cortex.ts:
 *              startCheckout() → hosted Checkout (7-day trial), openPortal() →
 *              Billing Portal. The webhook writes subscription truth into the
 *              member doc; when billing === 'stripe' this file never pushes
 *              sub/billing up (and the security rules enforce it).
 *
 * Loads the same compat SDK the sibling apps use (9.23.0), lazily and only
 * when init() runs with a config present. Classic script — smoke-sandbox safe:
 * top level only defines window.CortexCloud.
 */
(function () {
  'use strict';

  var FB_VER = '9.23.0';
  var cfg = (typeof window !== 'undefined' && window.CORTEX_FIREBASE_CONFIG) || null;
  var region = (typeof window !== 'undefined' && window.CORTEX_FUNCTIONS_REGION) || 'us-central1';

  var H = {};                                   // init() handlers
  var auth = null, db = null, fns = null;
  var unsubs = [];
  var pendingState = null, pushTimer = null;

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
  };
  if (typeof window !== 'undefined') window.CortexCloud = cloud;

  function noAuth() { return Promise.reject(new Error('Cloud is not available')); }
  function setStatus(s) { cloud.status = s; if (H.onStatus) try { H.onStatus(s); } catch (e) {} }

  /* ---- lazy compat SDK loader (same pattern as concierge/cloud.js) ---- */
  var sdkState = 0, sdkCbs = [];                // 0 idle · 1 loading · 2 ok · 3 failed
  function loadSdk(cb) {
    if (typeof firebase !== 'undefined' && firebase.auth && firebase.firestore && firebase.functions) { cb(true); return; }
    if (sdkState === 2) { cb(true); return; }
    if (sdkState === 3) { cb(false); return; }
    sdkCbs.push(cb);
    if (sdkState === 1) return;
    sdkState = 1;
    var parts = ['app', 'auth', 'firestore', 'functions'];
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

  /* ---- live member mirror ---- */
  function detach() {
    for (var i = 0; i < unsubs.length; i++) try { unsubs[i](); } catch (e) {}
    unsubs = [];
  }

  function attach(uid) {
    unsubs.push(db.collection('cortex_members').doc(uid).onSnapshot(function (s) {
      var m = s.exists ? s.data() : null;
      cloud.serverBilled = !!(m && (m.billing === 'stripe' || m.billing === 'stripe-mock'));
      if (H.onRemote) try {
        H.onRemote(m ? { billing: m.billing || 'local', sub: m.sub || null } : null);
      } catch (e) {}
    }, function (e) { cloud.lastError = e; }));
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
    // Once the Stripe webhook owns billing, the client never writes entitlement
    // fields (the rules would reject the whole update if it tried).
    if (cloud.serverBilled) return;
    db.collection('cortex_members').doc(uid).set({
      billing: s.billing || 'local',
      sub: s.sub || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(function (e) { cloud.lastError = e; });
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
  function startCheckout() {
    return callFn('createCortexCheckout', { successUrl: hereUrl(), cancelUrl: hereUrl() });
  }
  /** Returns {url} for the Stripe Billing Portal, or {mock:true}. */
  function openPortal() {
    return callFn('createCortexPortal', { returnUrl: hereUrl() });
  }
})();
