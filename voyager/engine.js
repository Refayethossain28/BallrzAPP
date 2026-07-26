/**
 * Voyager — the internet browser
 * ==============================
 *
 * "Make me an internet browser." A browser, stripped to its truth, is not the
 * rendering engine (your device already has one of those) — it's the *chrome*:
 * the omnibox that decides whether you typed an address or a question, the
 * tabs and their back/forward stacks, the history that remembers where you've
 * been and learns which places matter to you, the bookmarks, the session that
 * survives a restart. This engine is that chrome, as pure functions over
 * plain state — the app UI is just a skin over it, and the actual page pixels
 * come from a sandboxed <iframe> driven by the host browser's real renderer.
 *
 * Design rules (stated so the tests can pin them):
 *
 *   • THE OMNIBOX IS A CLASSIFIER. classify() turns whatever a human types
 *     into exactly one of: a URL (something navigable), an internal page
 *     (voyager://…), or a search (everything else, rewritten through the
 *     chosen engine's template). "example.com" is a URL; "example com" is a
 *     search; "what is example.com" is a search. The rules are spelled out
 *     next to the function and every edge is unit-tested.
 *
 *   • ONE DOOR INTO NAVIGATION. navigate() is the single way a tab moves:
 *     it truncates the forward stack (branching rewrites the future, like
 *     every real browser), records history (unless the tab is private or the
 *     page internal), and never mutates its input — every operation returns
 *     a fresh state object.
 *
 *   • HISTORY IS A LEDGER, RANKING IS DERIVED. Visits are appended raw
 *     (url, title, ts); frecency — the classic visits-weighted-by-recency
 *     score — is computed from the ledger on demand for suggestions and top
 *     sites. No cached counters to drift out of sync.
 *
 *   • PRIVATE MEANS ABSENT. An incognito tab writes nothing to history,
 *     nothing to top sites, and is dropped entirely by serialize(); restore()
 *     of a session that somehow contains one discards it. Privacy by
 *     construction, not by cleanup.
 *
 *   • DETERMINISTIC. No Date.now() and no Math.random() in here — "now" is
 *     always an argument and tab ids come from a counter in the state, so
 *     same inputs ⇒ same browser, byte for byte. That's what makes it
 *     unit-testable.
 *
 * Honesty note: this is a real browser *shell* over your device's real web
 * engine. Sites that forbid being embedded (X-Frame-Options / CSP
 * frame-ancestors — most big login pages do) will refuse to render inside
 * it; the UI detects the silence and offers to open them in a full tab.
 * Stated here so nobody mistakes an iframe for Chromium.
 *
 * UMD so it runs in the browser (window.Voyager) and under Node/vm for tests —
 * same pattern as vault/engine.js. Framework-free, dependency-free.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Voyager = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;               // session schema version for serialize/restore
  var INTERNAL = 'voyager://';   // our chrome pages live on this scheme
  var HISTORY_CAP = 2000;        // ledger cap — oldest visits fall off

  /* Internal pages the chrome renders natively (no iframe). */
  var INTERNAL_PAGES = {
    start: 'Start page',
    history: 'History',
    bookmarks: 'Bookmarks',
    settings: 'Settings',
    about: 'About Voyager',
  };

  /* The search engines a user can pick in Settings. %s is the query slot. */
  var SEARCH_ENGINES = [
    { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
    { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s' },
    { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
    { id: 'brave', name: 'Brave Search', template: 'https://search.brave.com/search?q=%s' },
    { id: 'startpage', name: 'Startpage', template: 'https://www.startpage.com/sp/search?query=%s' },
    { id: 'ecosia', name: 'Ecosia', template: 'https://www.ecosia.org/search?q=%s' },
  ];

  /* ════════════════════════ URLs ════════════════════════ */

  /** True if the string already carries an explicit scheme we navigate to. */
  function hasScheme(s) {
    return /^(https?|ftp|file):\/\//i.test(s) || /^data:/i.test(s) || s.toLowerCase().indexOf(INTERNAL) === 0;
  }

  /** Is this one label that browsers treat as a host on its own? */
  function isBareHost(s) {
    return s === 'localhost' || /^localhost:\d{1,5}$/.test(s);
  }

  /** Dotted-quad IPv4, optionally with :port. */
  function isIPv4(s) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d{1,5})?$/.exec(s);
    if (!m) return false;
    for (var i = 1; i <= 4; i++) if (Number(m[i]) > 255) return false;
    return true;
  }

  /**
   * Does this look like a hostname a DNS lookup could resolve? At least one
   * dot, a plausible final label (2+ letters), no spaces, no illegal chars.
   * Optionally followed by :port and/or /path?query#hash.
   */
  function looksLikeHost(s) {
    var m = /^([a-z0-9¡-￿]([a-z0-9¡-￿-]*[a-z0-9¡-￿])?\.)+([a-z¡-￿]{2,})(:\d{1,5})?([/?#].*)?$/i.exec(s);
    return !!m;
  }

  /**
   * Is this a Tor hidden service — a `.onion` address? The final host label
   * is literally "onion" (v2 was 16 base32 chars, v3 is 56; we accept any
   * non-empty label so both, and vanity subdomains, resolve). Recognising
   * these is honest classification, not a promise we can route them — see
   * torGatewayUrl and the app's dark-web notes.
   */
  function isOnion(url) {
    var host = hostOf(url) || String(url == null ? '' : url).toLowerCase().split(/[/?#]/)[0];
    return /(^|\.)[a-z2-7]+\.onion$/i.test(host) || /(^|\.)onion$/i.test(host);
  }

  /**
   * THE OMNIBOX CLASSIFIER. One typed string in, one decision out:
   *   { kind: 'url',      url }  — navigable address (scheme added if missing)
   *   { kind: 'internal', url }  — voyager:// chrome page
   *   { kind: 'search',   url, query } — everything else via the engine template
   *   { kind: 'empty' }          — nothing usable
   */
  function classify(input, opts) {
    opts = opts || {};
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return { kind: 'empty' };

    var lower = raw.toLowerCase();
    if (lower.indexOf(INTERNAL) === 0) {
      var page = lower.slice(INTERNAL.length).replace(/\/+$/, '') || 'start';
      return INTERNAL_PAGES[page]
        ? { kind: 'internal', url: INTERNAL + page }
        : { kind: 'search', url: searchUrl(opts.engine, raw), query: raw };
    }

    // Anything with a space can't be a URL a human typed — it's a question.
    if (!/\s/.test(raw)) {
      if (hasScheme(raw)) return { kind: 'url', url: raw };
      var beforePath = raw.split(/[/?#]/)[0];
      if (isBareHost(beforePath) || isIPv4(beforePath) || looksLikeHost(raw)) {
        return { kind: 'url', url: 'https://' + raw };
      }
    }
    return { kind: 'search', url: searchUrl(opts.engine, raw), query: raw };
  }

  /** Expand a search-engine template for a query. Unknown engine → first one. */
  function searchUrl(engineId, query) {
    var eng = SEARCH_ENGINES[0];
    for (var i = 0; i < SEARCH_ENGINES.length; i++) {
      if (SEARCH_ENGINES[i].id === engineId) { eng = SEARCH_ENGINES[i]; break; }
    }
    return eng.template.replace('%s', encodeURIComponent(String(query == null ? '' : query)));
  }

  /** Host part of a URL ('' for internal/data/unparseable). */
  function hostOf(url) {
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(url == null ? '' : url));
    if (!m) return '';
    if (String(url).toLowerCase().indexOf(INTERNAL) === 0) return '';
    var host = m[1];
    var at = host.lastIndexOf('@');           // strip user:pass@
    if (at !== -1) host = host.slice(at + 1);
    var colon = host.lastIndexOf(':');        // strip :port (not IPv6-bracketed)
    if (colon !== -1 && host.indexOf(']') === -1) host = host.slice(0, colon);
    return host.toLowerCase();
  }

  /**
   * What the omnibox shows at rest: https:// and www. are stripped (the
   * boring default), but http:// stays visible — it's a warning, not noise.
   */
  function displayUrl(url) {
    var s = String(url == null ? '' : url);
    if (s.toLowerCase().indexOf(INTERNAL) === 0) return s;
    if (/^https:\/\//i.test(s)) s = s.slice(8).replace(/^www\./i, '');
    else if (/^http:\/\//i.test(s)) s = 'http://' + s.slice(7).replace(/^www\./i, '');
    return s.replace(/\/$/, '');
  }

  /**
   * Security posture for the chip next to the omnibox. Onion services are
   * checked first: Tor encrypts and authenticates them end-to-end by the
   * address itself, so a plain-http .onion is NOT the "insecure" warning a
   * plain-http clearnet site is — it gets its own posture.
   */
  function securityOf(url) {
    var s = String(url == null ? '' : url).toLowerCase();
    if (s.indexOf(INTERNAL) === 0) return 'internal';
    if (isOnion(url)) return 'onion';
    if (s.indexOf('https://') === 0) return 'secure';
    if (s.indexOf('http://') === 0) return 'insecure';
    return 'neutral';
  }

  /**
   * Rewrite a `.onion` URL to reach it through a Tor2web-style gateway host
   * (e.g. gateway "onion.ws" turns `http://abc…d.onion/p` into
   * `https://abc…d.onion.ws/p`). This is the ONLY way a sandboxed frame with
   * no Tor circuit of its own can pull hidden-service content — and it is a
   * real privacy trade: the gateway operator sees the traffic Tor would have
   * hidden. Returns the URL unchanged when it isn't an onion address or no
   * gateway is set, so it's always safe to call. Gateways are always https
   * (the gateway↔you hop is clearnet TLS; the gateway↔onion hop is Tor).
   */
  function torGatewayUrl(url, gateway) {
    var g = String(gateway == null ? '' : gateway).trim().replace(/^https?:\/\//i, '').replace(/^\.+|\/+$/g, '');
    if (!g || !isOnion(url)) return url;
    var s = String(url).replace(/^[a-z]+:\/\//i, '');           // drop scheme
    // Gateways are named to sit in the .onion TLD's place: "onion.ws" turns
    // abc.onion into abc.onion.ws. So the trailing `.onion` becomes `.` + gateway.
    return 'https://' + s.replace(/\.onion(?=$|[:/?#])/i, '.' + g);
  }

  /**
   * Wrap a clearnet http(s) URL so it loads through the full-browser proxy
   * (voyager/server.mjs): base "http://localhost:8790/proxy" turns
   * https://youtube.com into …/proxy?url=<encoded>. A no-op when there's no
   * proxy base or the URL isn't http(s) (internal pages, onion, data: …).
   */
  function proxyUrl(url, base) {
    var b = String(base == null ? '' : base).trim().replace(/\/+$/, '');
    var s = String(url == null ? '' : url);
    if (!b || !/^https?:\/\//i.test(s)) return s;
    return b + '?url=' + encodeURIComponent(s);
  }

  /**
   * THE ONE PLACE that decides what a tab's <iframe> actually loads for a given
   * address, given the current settings:
   *   • internal voyager:// pages are handled by the chrome, returned as-is;
   *   • .onion goes through the Tor gateway (the proxy has no Tor circuit);
   *   • otherwise, if a proxy base is set, clearnet pages load through it
   *     (this is what lets framing-refusers like YouTube open);
   *   • else the URL loads directly (plain framing browser).
   */
  function resolveFrameSrc(url, opts) {
    opts = opts || {};
    var s = String(url == null ? '' : url);
    if (s.toLowerCase().indexOf(INTERNAL) === 0) return s;
    if (isOnion(s)) return torGatewayUrl(s, opts.torGateway);
    if (opts.proxyBase && /^https?:\/\//i.test(s)) return proxyUrl(s, opts.proxyBase);
    return s;
  }

  /* ════════════════════════ browser state ════════════════════════ */

  /** A fresh browser: one tab on the start page. */
  function createBrowser(opts) {
    opts = opts || {};
    var state = {
      v: VERSION,
      nextId: 1,
      tabs: [],
      activeId: null,
      history: [],      // append-only: {url, title, ts}
      bookmarks: [],    // {url, title, ts}
      settings: {
        engine: opts.engine || 'duckduckgo',
        home: opts.home || INTERNAL + 'start',
        torGateway: opts.torGateway || '',   // '' = off; a bare host like "onion.ws" routes .onion
        proxy: opts.proxy || '',             // '' = auto-detect local server; a URL forces it; 'off' disables
      },
    };
    return newTab(state, { ts: opts.ts });
  }

  function makeTab(id, url, opts) {
    return {
      id: id,
      stack: [url],          // the tab's own timeline…
      pos: 0,                // …and where in it we stand
      title: '',
      incognito: !!(opts && opts.incognito),
      zoom: 100,
      openedAt: (opts && opts.ts) || null,
    };
  }

  function getTab(state, id) {
    for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].id === id) return state.tabs[i];
    return null;
  }

  function activeTab(state) { return getTab(state, state.activeId); }

  function tabUrl(tab) { return tab ? tab.stack[tab.pos] : null; }

  /** Open a tab. Foreground by default; background:true keeps focus put. */
  function newTab(state, opts) {
    opts = opts || {};
    var url = opts.url || state.settings.home || INTERNAL + 'start';
    var tab = makeTab(state.nextId, url, opts);
    var next = shallow(state);
    next.nextId = state.nextId + 1;
    next.tabs = state.tabs.concat([tab]);
    if (!opts.background) next.activeId = tab.id;
    // Opening straight onto a real page is a visit too (e.g. "open in new tab").
    if (opts.url) next = recordVisit(next, tab, opts.url, opts.title, opts.ts);
    return next;
  }

  /**
   * Close a tab. Focus falls to the right-hand neighbour, else the left one —
   * the way every real browser does it. Closing the last tab opens a fresh
   * start tab, so the browser is never empty.
   */
  function closeTab(state, id) {
    var idx = -1;
    for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].id === id) { idx = i; break; }
    if (idx === -1) return state;
    var next = shallow(state);
    next.tabs = state.tabs.slice(0, idx).concat(state.tabs.slice(idx + 1));
    if (next.tabs.length === 0) return newTab(next, {});
    if (state.activeId === id) {
      var neighbour = next.tabs[Math.min(idx, next.tabs.length - 1)];
      next.activeId = neighbour.id;
    }
    return next;
  }

  function activateTab(state, id) {
    if (!getTab(state, id) || state.activeId === id) return state;
    var next = shallow(state);
    next.activeId = id;
    return next;
  }

  /* ════════════════════════ navigation ════════════════════════ */

  /**
   * THE ONE DOOR. Move a tab to a URL: everything after the current position
   * is discarded (you can't go "forward" to a future you just rewrote), the
   * visit lands in history unless the tab is private or the page internal.
   * Navigating to the exact URL the tab is already on is a reload — position
   * unchanged, but the visit still counts.
   */
  function navigate(state, tabId, url, opts) {
    opts = opts || {};
    var tab = getTab(state, tabId);
    if (!tab || !url) return state;
    var next = shallow(state);
    var t = shallow(tab);
    if (tabUrl(tab) !== url) {
      t.stack = tab.stack.slice(0, tab.pos + 1).concat([url]);
      t.pos = t.stack.length - 1;
    }
    t.title = opts.title || '';
    next.tabs = replaceTab(state.tabs, t);
    return recordVisit(next, t, url, opts.title, opts.ts);
  }

  /** The page told us its real <title> — remember it on the tab AND fix up history. */
  function setTitle(state, tabId, title) {
    var tab = getTab(state, tabId);
    if (!tab) return state;
    var next = shallow(state);
    var t = shallow(tab);
    t.title = String(title == null ? '' : title);
    next.tabs = replaceTab(state.tabs, t);
    if (!tab.incognito) {
      var url = tabUrl(tab);
      for (var i = next.history.length - 1; i >= 0; i--) {
        if (next.history[i].url === url) {
          var h = next.history.slice();
          h[i] = { url: url, title: t.title, ts: next.history[i].ts };
          next.history = h;
          break;
        }
      }
    }
    return next;
  }

  function canBack(tab) { return !!tab && tab.pos > 0; }
  function canForward(tab) { return !!tab && tab.pos < tab.stack.length - 1; }

  function back(state, tabId) { return step(state, tabId, -1); }
  function forward(state, tabId) { return step(state, tabId, +1); }

  function step(state, tabId, delta) {
    var tab = getTab(state, tabId);
    if (!tab) return state;
    var pos = tab.pos + delta;
    if (pos < 0 || pos >= tab.stack.length) return state;
    var next = shallow(state);
    var t = shallow(tab);
    t.pos = pos;
    t.title = '';
    next.tabs = replaceTab(state.tabs, t);
    return next;
  }

  /** Zoom is clamped to the familiar 25%–500% and snapped to whole percents. */
  function setZoom(state, tabId, zoom) {
    var tab = getTab(state, tabId);
    if (!tab) return state;
    var z = Math.round(Number(zoom) || 100);
    z = Math.max(25, Math.min(500, z));
    var next = shallow(state);
    var t = shallow(tab);
    t.zoom = z;
    next.tabs = replaceTab(state.tabs, t);
    return next;
  }

  /* ════════════════════════ history ════════════════════════ */

  /** Append to the ledger — unless private tab, internal page, or a repeat of the last visit to the same URL. */
  function recordVisit(state, tab, url, title, ts) {
    if (tab.incognito) return state;
    if (String(url).toLowerCase().indexOf(INTERNAL) === 0) return state;
    var last = state.history[state.history.length - 1];
    if (last && last.url === url) return state;   // consecutive dedupe (reload spam)
    var next = shallow(state);
    next.history = state.history.concat([{ url: url, title: title || '', ts: ts || null }]);
    if (next.history.length > HISTORY_CAP) next.history = next.history.slice(next.history.length - HISTORY_CAP);
    return next;
  }

  function clearHistory(state) {
    var next = shallow(state);
    next.history = [];
    return next;
  }

  /** Remove every visit to one URL (the per-row ✕ in the History page). */
  function deleteFromHistory(state, url) {
    var next = shallow(state);
    next.history = state.history.filter(function (h) { return h.url !== url; });
    return next;
  }

  /** Newest-first unique URLs, optionally filtered — the History page's list. */
  function historyEntries(state, query) {
    var q = String(query == null ? '' : query).toLowerCase().trim();
    var seen = {};
    var out = [];
    for (var i = state.history.length - 1; i >= 0; i--) {
      var h = state.history[i];
      if (seen[h.url]) { seen[h.url].visits++; continue; }
      if (q && h.url.toLowerCase().indexOf(q) === -1 && h.title.toLowerCase().indexOf(q) === -1) continue;
      var entry = { url: h.url, title: h.title, ts: h.ts, visits: 1 };
      seen[h.url] = entry;
      out.push(entry);
    }
    return out;
  }

  /* ════════════════════════ bookmarks ════════════════════════ */

  function isBookmarked(state, url) {
    for (var i = 0; i < state.bookmarks.length; i++) if (state.bookmarks[i].url === url) return true;
    return false;
  }

  /** The star: add if absent, remove if present. Internal pages can't be starred. */
  function toggleBookmark(state, url, title, ts) {
    if (!url || String(url).toLowerCase().indexOf(INTERNAL) === 0) return state;
    var next = shallow(state);
    if (isBookmarked(state, url)) {
      next.bookmarks = state.bookmarks.filter(function (b) { return b.url !== url; });
    } else {
      next.bookmarks = state.bookmarks.concat([{ url: url, title: title || displayUrl(url), ts: ts || null }]);
    }
    return next;
  }

  /* ════════════════════════ ranking: frecency ════════════════════════ */

  /**
   * The classic score: every visit contributes, recent visits contribute
   * more. Buckets (≤1d ×4, ≤7d ×2, ≤30d ×1, older ×0.5) rather than a decay
   * curve — simple, explainable, and stable under test.
   */
  function frecency(visits, nowTs) {
    var score = 0;
    for (var i = 0; i < visits.length; i++) {
      var age = (nowTs || 0) - (visits[i].ts || 0);
      var days = age / 86400000;
      score += days <= 1 ? 4 : days <= 7 ? 2 : days <= 30 ? 1 : 0.5;
    }
    return score;
  }

  /** Group history by URL → [{url, title, visits[], score}], best first. */
  function rankedSites(state, nowTs) {
    var byUrl = {};
    var order = [];
    for (var i = 0; i < state.history.length; i++) {
      var h = state.history[i];
      if (!byUrl[h.url]) { byUrl[h.url] = { url: h.url, title: h.title, visits: [] }; order.push(h.url); }
      byUrl[h.url].visits.push(h);
      if (h.title) byUrl[h.url].title = h.title;   // latest non-empty title wins
    }
    var out = [];
    for (var j = 0; j < order.length; j++) {
      var site = byUrl[order[j]];
      site.score = frecency(site.visits, nowTs);
      out.push(site);
    }
    out.sort(function (a, b) { return b.score - a.score || b.visits.length - a.visits.length; });
    return out;
  }

  /** The start page's grid: your most-frecent sites, one per host. */
  function topSites(state, n, nowTs) {
    var ranked = rankedSites(state, nowTs);
    var seen = {};
    var out = [];
    for (var i = 0; i < ranked.length && out.length < (n || 8); i++) {
      var host = hostOf(ranked[i].url) || ranked[i].url;
      if (seen[host]) continue;
      seen[host] = true;
      out.push({ url: ranked[i].url, title: ranked[i].title || host, host: host });
    }
    return out;
  }

  /**
   * Omnibox suggestions while typing: bookmarks and history whose url/title
   * contain the text (host-prefix matches first, then frecency), capped, and
   * always ending with the "search for …" escape hatch.
   */
  function suggest(state, input, opts) {
    opts = opts || {};
    var limit = opts.limit || 6;
    var nowTs = opts.nowTs || 0;
    var q = String(input == null ? '' : input).toLowerCase().trim();
    var out = [];
    if (!q) return out;

    var ranked = rankedSites(state, nowTs);
    var starred = {};
    for (var b = 0; b < state.bookmarks.length; b++) starred[state.bookmarks[b].url] = state.bookmarks[b];

    // Bookmarks not in history still deserve to surface — give them a seat.
    for (var s = 0; s < state.bookmarks.length; s++) {
      var bm = state.bookmarks[s];
      var inHistory = false;
      for (var r = 0; r < ranked.length; r++) if (ranked[r].url === bm.url) { inHistory = true; break; }
      if (!inHistory) ranked.push({ url: bm.url, title: bm.title, visits: [], score: 0 });
    }

    var scoredMatches = [];
    for (var i = 0; i < ranked.length; i++) {
      var site = ranked[i];
      var host = hostOf(site.url);
      var hay = (site.url + ' ' + (site.title || '')).toLowerCase();
      if (hay.indexOf(q) === -1) continue;
      var hostPrefix = host.indexOf(q) === 0 || host.indexOf('www.' + q) === 0 ? 1 : 0;
      var starBoost = starred[site.url] ? 2 : 0;
      scoredMatches.push({ site: site, key: hostPrefix * 1000 + site.score + starBoost });
    }
    scoredMatches.sort(function (a, b) { return b.key - a.key; });
    for (var m = 0; m < scoredMatches.length && out.length < limit - 1; m++) {
      var it = scoredMatches[m].site;
      out.push({
        kind: starred[it.url] ? 'bookmark' : 'history',
        url: it.url,
        title: it.title || displayUrl(it.url),
      });
    }

    var cls = classify(input, { engine: state.settings.engine });
    if (cls.kind === 'url' || cls.kind === 'internal') {
      out.unshift({ kind: 'goto', url: cls.url, title: 'Go to ' + displayUrl(cls.url) });
      if (out.length > limit - 1) out = out.slice(0, limit - 1);
    }
    out.push({ kind: 'search', url: searchUrl(state.settings.engine, input), title: 'Search for “' + String(input).trim() + '”', query: String(input).trim() });
    return out;
  }

  /* ════════════════════════ settings ════════════════════════ */

  function setSetting(state, key, value) {
    if (key !== 'engine' && key !== 'home' && key !== 'torGateway' && key !== 'proxy') return state;
    if (key === 'engine') {
      var ok = false;
      for (var i = 0; i < SEARCH_ENGINES.length; i++) if (SEARCH_ENGINES[i].id === value) ok = true;
      if (!ok) return state;
    }
    if (key === 'torGateway') {
      // Store a bare host ("onion.ws"): no scheme, no leading dots, no path.
      value = String(value == null ? '' : value).trim().replace(/^https?:\/\//i, '').replace(/^\.+|\/.*$/g, '');
    }
    if (key === 'proxy') {
      // '', 'off', or a base URL (trailing slash trimmed).
      value = String(value == null ? '' : value).trim().replace(/\/+$/, '');
    }
    var next = shallow(state);
    next.settings = shallow(state.settings);
    next.settings[key] = value;
    return next;
  }

  /* ════════════════════════ session ════════════════════════ */

  /** Persistable JSON. Incognito tabs are simply not part of the story. */
  function serialize(state) {
    var tabs = [];
    for (var i = 0; i < state.tabs.length; i++) {
      var t = state.tabs[i];
      if (t.incognito) continue;
      tabs.push({ id: t.id, stack: t.stack.slice(), pos: t.pos, title: t.title, zoom: t.zoom, openedAt: t.openedAt });
    }
    var activeId = state.activeId;
    var activeSurvives = false;
    for (var j = 0; j < tabs.length; j++) if (tabs[j].id === activeId) activeSurvives = true;
    return JSON.stringify({
      v: VERSION,
      nextId: state.nextId,
      tabs: tabs,
      activeId: activeSurvives ? activeId : (tabs.length ? tabs[0].id : null),
      history: state.history,
      bookmarks: state.bookmarks,
      settings: state.settings,
    });
  }

  /** Rebuild a browser from serialize() output; anything broken → fresh browser. */
  function restore(json, opts) {
    var data;
    try { data = JSON.parse(json); } catch (e) { return createBrowser(opts); }
    if (!data || data.v !== VERSION || !Array.isArray(data.tabs)) return createBrowser(opts);
    var tabs = [];
    var maxId = 0;
    for (var i = 0; i < data.tabs.length; i++) {
      var t = data.tabs[i];
      if (!t || t.incognito || !Array.isArray(t.stack) || !t.stack.length) continue;
      var pos = Math.max(0, Math.min(t.stack.length - 1, Number(t.pos) || 0));
      tabs.push({ id: t.id, stack: t.stack, pos: pos, title: String(t.title || ''), incognito: false, zoom: Math.max(25, Math.min(500, Number(t.zoom) || 100)), openedAt: t.openedAt || null });
      if (t.id > maxId) maxId = t.id;
    }
    var state = {
      v: VERSION,
      nextId: Math.max(Number(data.nextId) || 1, maxId + 1),
      tabs: tabs,
      activeId: null,
      history: Array.isArray(data.history) ? data.history : [],
      bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [],
      settings: {
        engine: (data.settings && data.settings.engine) || 'duckduckgo',
        home: (data.settings && data.settings.home) || INTERNAL + 'start',
        torGateway: (data.settings && data.settings.torGateway) || '',
        proxy: (data.settings && data.settings.proxy) || '',
      },
    };
    if (tabs.length === 0) return newTab(state, {});
    state.activeId = getTab(state, data.activeId) ? data.activeId : tabs[0].id;
    return state;
  }

  /* ════════════════════════ plumbing ════════════════════════ */

  function shallow(obj) {
    var out = {};
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  }

  function replaceTab(tabs, tab) {
    var out = tabs.slice();
    for (var i = 0; i < out.length; i++) if (out[i].id === tab.id) { out[i] = tab; break; }
    return out;
  }

  return {
    VERSION: VERSION,
    INTERNAL: INTERNAL,
    INTERNAL_PAGES: INTERNAL_PAGES,
    SEARCH_ENGINES: SEARCH_ENGINES,
    classify: classify,
    searchUrl: searchUrl,
    hostOf: hostOf,
    isOnion: isOnion,
    displayUrl: displayUrl,
    securityOf: securityOf,
    torGatewayUrl: torGatewayUrl,
    proxyUrl: proxyUrl,
    resolveFrameSrc: resolveFrameSrc,
    createBrowser: createBrowser,
    newTab: newTab,
    closeTab: closeTab,
    activateTab: activateTab,
    getTab: getTab,
    activeTab: activeTab,
    tabUrl: tabUrl,
    navigate: navigate,
    setTitle: setTitle,
    canBack: canBack,
    canForward: canForward,
    back: back,
    forward: forward,
    setZoom: setZoom,
    clearHistory: clearHistory,
    deleteFromHistory: deleteFromHistory,
    historyEntries: historyEntries,
    isBookmarked: isBookmarked,
    toggleBookmark: toggleBookmark,
    frecency: frecency,
    topSites: topSites,
    suggest: suggest,
    setSetting: setSetting,
    serialize: serialize,
    restore: restore,
  };
});
