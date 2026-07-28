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
  var MEMORY_CAP = 150;          // remembered pages kept (oldest evicted)
  var MEMORY_TEXT_CAP = 6000;    // chars of readable text stored per page (for search + snapshot)

  /* Internal pages the chrome renders natively (no iframe). */
  var INTERNAL_PAGES = {
    start: 'Start page',
    history: 'History',
    bookmarks: 'Bookmarks',
    reading: 'Reading list',
    memory: 'Memory',
    reader: 'Reader',
    changes: 'What changed',
    stats: 'Your numbers',
    site: 'Site settings',
    settings: 'Settings',
    about: 'About Voyager',
  };

  /* The search engines a user can pick in Settings. %s is the query slot.
   * First is the default: Seeker — the repo's own search engine, so searches
   * stay in the family (and it frames happily, being a static page). */
  var SEARCH_ENGINES = [
    { id: 'seeker', name: 'Seeker', template: 'https://refayethossain28.github.io/BallrzAPP/seeker/?q=%s' },
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
    var sep = b.indexOf('?') === -1 ? '?' : '&';   // base may carry ?key=… on a locked proxy
    return b + sep + 'url=' + encodeURIComponent(s);
  }

  /**
   * Make a user-typed proxy value forgiving: add https:// if missing, drop a
   * trailing slash, and append the `/proxy` path if they only pasted the host
   * (so "voyager-proxy.onrender.com" and ".../proxy?key=x" both just work). A
   * query string (the optional ?key=…) is preserved. '' / 'off' pass through.
   */
  function normalizeProxyBase(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s || s.toLowerCase() === 'off') return s ? 'off' : '';
    var q = '';
    var qi = s.indexOf('?');
    if (qi !== -1) { q = s.slice(qi); s = s.slice(0, qi); }
    s = s.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    if (!/\/proxy$/i.test(s)) s += '/proxy';
    return s + q;
  }

  /** Seconds from a YouTube time param: "90", "1m30s", "1h2m3s". */
  function ytSeconds(t) {
    t = String(t == null ? '' : t);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    var h = /(\d+)h/.exec(t), m = /(\d+)m/.exec(t), s = /(\d+)s/.exec(t);
    return (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (s ? +s[1] : 0);
  }

  /**
   * Some sites will never allow raw framing but publish an embeddable player
   * that WILL — YouTube is the big one. Map a YouTube watch / shorts / youtu.be
   * / live link to its privacy-friendly embed player, which is *designed* to be
   * framed and plays video with no proxy and no server. Returns null for
   * anything that isn't a recognised video URL. Regex-only (no URL global) so
   * it stays vm-safe and deterministic like the rest of the engine.
   */
  function videoEmbedUrl(url) {
    var s = String(url == null ? '' : url).trim();
    var m = /^(?:https?:\/\/)?([^\/?#]+)([^?#]*)(\?[^#]*)?/i.exec(s);
    if (!m) return null;
    var host = m[1].split('@').pop().split(':')[0].replace(/^www\./i, '').toLowerCase();
    var path = m[2] || '', query = m[3] || '';
    var id = null;
    if (host === 'youtu.be') {
      id = path.replace(/^\/+/, '').split(/[/?#]/)[0];
    } else if (/^(m\.|music\.)?youtube(-nocookie)?\.com$/.test(host)) {
      if (/^\/watch\/?$/.test(path)) { var vm = /[?&]v=([^&]+)/.exec(query); id = vm ? vm[1] : null; }
      else { var pm = /^\/(?:shorts|embed|v|live|e)\/([^\/?#]+)/.exec(path); id = pm ? pm[1] : null; }
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    var tm = /[?&](?:t|start)=([0-9hms]+)/i.exec(query);
    var start = tm ? ytSeconds(tm[1]) : 0;
    return 'https://www.youtube-nocookie.com/embed/' + id + (start ? '?start=' + start : '');
  }

  /**
   * THE ONE PLACE that decides what a tab's <iframe> actually loads for a given
   * address, given the current settings:
   *   • internal voyager:// pages are handled by the chrome, returned as-is;
   *   • a recognised video (YouTube…) loads its embeddable player — this is
   *     what makes a YouTube link actually play, with or without a server;
   *   • .onion goes through the Tor gateway (the proxy has no Tor circuit);
   *   • otherwise, if a proxy base is set, clearnet pages load through it
   *     (this is what lets other framing-refusers open);
   *   • else the URL loads directly (plain framing browser).
   */
  function resolveFrameSrc(url, opts) {
    opts = opts || {};
    var s = String(url == null ? '' : url);
    if (s.toLowerCase().indexOf(INTERNAL) === 0) return s;
    var embed = videoEmbedUrl(s);
    if (embed) return embed;
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
      reading: [],      // read-later queue: {url, title, ts, read}
      memory: [],       // remembered pages: {url, title, text, words, ts}
      shortcuts: [],    // custom start-page tiles: {url, title}
      sites: {},        // per-site overrides, keyed by host: {zoom?, blockTrackers?, remember?}
      highlights: [],   // marker-pen passages: {url, text, ts}
      follows: [],      // followed feeds: {feedUrl, siteUrl, title, items, updatedTs}
      spaces: [{ id: 1, name: 'Home', lastActiveId: null }],  // named workspaces
      activeSpace: 1,
      nextSpaceId: 2,
      splitId: null,    // a second tab shown beside the active one (same space)
      settings: {
        engine: opts.engine || 'seeker',
        engineChosen: false,   // flips when the user picks one in Settings
        home: opts.home || INTERNAL + 'start',
        torGateway: opts.torGateway || '',   // '' = off; a bare host like "onion.ws" routes .onion
        proxy: opts.proxy || '',             // '' = auto-detect local server; a URL forces it; 'off' disables
        theme: opts.theme || 'dark',         // dark | light | auto
        accent: opts.accent || 'cyan',       // named accent (see ACCENTS)
        blockTrackers: opts.blockTrackers !== false, // ad/tracker blocking through the proxy (default on)
        remember: opts.remember !== false,   // capture readable pages into memory (default on)
        startName: opts.startName || '',     // optional greeting name on the start page
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
      pinned: false,
      space: (opts && opts.space) || 1,
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
    tab.space = opts.space || state.activeSpace || 1;   // new tabs open in the space you're in
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
    // Pinning is protection: a pinned tab can't be closed — unpin it first.
    if (state.tabs[idx].pinned) return state;
    var space = state.tabs[idx].space || 1;
    var next = shallow(state);
    next.tabs = state.tabs.slice(0, idx).concat(state.tabs.slice(idx + 1));
    if (state.splitId === id) next.splitId = null;   // closing a pane dissolves the split
    // Never-empty holds PER SPACE: closing a space's last tab respawns a fresh one there.
    var siblings = next.tabs.filter(function (t) { return (t.space || 1) === space; });
    if (!siblings.length) return newTab(next, { space: space });
    if (state.activeId === id) {
      // Focus falls to the right-hand neighbour WITHIN the space, else the left one.
      var after = null, before = null;
      for (var j = 0; j < next.tabs.length; j++) {
        if ((next.tabs[j].space || 1) !== space) continue;
        if (j >= idx && !after) after = next.tabs[j];
        if (j < idx) before = next.tabs[j];
      }
      next.activeId = (after || before).id;
    }
    return next;
  }

  function activateTab(state, id) {
    var tab = getTab(state, id);
    if (!tab || state.activeId === id) return state;
    var next = shallow(state);
    next.activeId = id;
    // Jumping to a tab in another space (palette, tab sheet) follows it there.
    if ((tab.space || 1) !== state.activeSpace) next.activeSpace = tab.space || 1;
    return next;
  }

  /* ════════════════════════ split view ════════════════════════
   * Two tabs side by side — compare sources, write from a reference, watch
   * while you read. The split partner must live in the active tab's space;
   * closing either side, or leaving the space, dissolves the split. */

  function setSplit(state, tabId) {
    if (tabId == null) {
      if (state.splitId == null) return state;
      var off = shallow(state); off.splitId = null; return off;
    }
    var tab = getTab(state, tabId);
    var active = activeTab(state);
    if (!tab || !active || tab.id === active.id) return state;
    if ((tab.space || 1) !== (active.space || 1)) return state;   // same desk only
    if (state.splitId === tabId) return state;
    var next = shallow(state);
    next.splitId = tabId;
    return next;
  }

  /** The tab shown in the second pane, or null when the split is off/broken. */
  function splitTab(state) {
    if (state.splitId == null) return null;
    var tab = getTab(state, state.splitId);
    var active = activeTab(state);
    if (!tab || !active || tab.id === active.id) return null;
    if ((tab.space || 1) !== (active.space || 1)) return null;
    return tab;
  }

  /* ════════════════════════ workspaces ════════════════════════
   * Named spaces — Work, Research, a rabbit hole — each with its own tabs.
   * One browser, several mental desks; switching desks never loses a tab. */

  function getSpace(state, id) {
    for (var i = 0; i < (state.spaces || []).length; i++) if (state.spaces[i].id === id) return state.spaces[i];
    return null;
  }

  function spaceTabs(state, id) {
    return state.tabs.filter(function (t) { return (t.space || 1) === id; });
  }

  /** Create a space, switch to it, and open its first tab (never empty). */
  function addSpace(state, name, opts) {
    opts = opts || {};
    name = String(name == null ? '' : name).trim().slice(0, 24) || 'Space ' + state.nextSpaceId;
    var next = shallow(state);
    next.spaces = state.spaces.concat([{ id: state.nextSpaceId, name: name, lastActiveId: null }]);
    next.nextSpaceId = state.nextSpaceId + 1;
    next.spaces = rememberSpaceFocus(next.spaces, state.activeSpace, state.activeId);
    next.activeSpace = state.nextSpaceId;
    return newTab(next, { ts: opts.ts, space: state.nextSpaceId });
  }

  function renameSpace(state, id, name) {
    name = String(name == null ? '' : name).trim().slice(0, 24);
    if (!name || !getSpace(state, id)) return state;
    var next = shallow(state);
    next.spaces = state.spaces.map(function (s) {
      if (s.id !== id) return s;
      var ns = shallow(s); ns.name = name; return ns;
    });
    return next;
  }

  function rememberSpaceFocus(spaces, spaceId, activeId) {
    return spaces.map(function (s) {
      if (s.id !== spaceId) return s;
      var ns = shallow(s); ns.lastActiveId = activeId; return ns;
    });
  }

  /** Switch desks: focus returns to the tab you last used there. */
  function switchSpace(state, id) {
    if (!getSpace(state, id) || state.activeSpace === id) return state;
    var next = shallow(state);
    next.spaces = rememberSpaceFocus(state.spaces, state.activeSpace, state.activeId);
    next.activeSpace = id;
    var tabs = spaceTabs(next, id);
    if (!tabs.length) return newTab(next, { space: id });
    var sp = getSpace(next, id);
    var last = sp && sp.lastActiveId != null ? tabs.filter(function (t) { return t.id === sp.lastActiveId; })[0] : null;
    next.activeId = (last || tabs[0]).id;
    return next;
  }

  /**
   * Remove a space and close its tabs. Refused for the last space, and for a
   * space holding pinned tabs — pins are promises, unpin before demolishing.
   */
  function removeSpace(state, id) {
    if (!getSpace(state, id) || state.spaces.length <= 1) return state;
    var doomed = spaceTabs(state, id);
    for (var i = 0; i < doomed.length; i++) if (doomed[i].pinned) return state;
    var next = shallow(state);
    next.spaces = state.spaces.filter(function (s) { return s.id !== id; });
    next.tabs = state.tabs.filter(function (t) { return (t.space || 1) !== id; });
    if (state.activeSpace === id) {
      next.activeSpace = next.spaces[0].id;
      var tabs = spaceTabs(next, next.activeSpace);
      if (!tabs.length) return newTab(next, { space: next.activeSpace });
      var sp = getSpace(next, next.activeSpace);
      var last = sp && sp.lastActiveId != null ? tabs.filter(function (t) { return t.id === sp.lastActiveId; })[0] : null;
      next.activeId = (last || tabs[0]).id;
    } else if (!getTab(next, next.activeId)) {
      var fallback = spaceTabs(next, next.activeSpace);
      if (fallback.length) next.activeId = fallback[0].id;
    }
    return next;
  }

  /**
   * Pin / unpin a tab. Pinned tabs live at the front of the strip (in the
   * order they were pinned), survive ⌘W and the ✕ button, and ride along in
   * the saved session. Private tabs can't be pinned — pinning is a promise of
   * permanence, and a private tab's whole point is to vanish.
   */
  function togglePin(state, id) {
    var tab = getTab(state, id);
    if (!tab || tab.incognito) return state;
    var t = shallow(tab);
    t.pinned = !tab.pinned;
    var rest = [];
    for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].id !== id) rest.push(state.tabs[i]);
    var lastPinned = -1;
    for (var j = 0; j < rest.length; j++) if (rest[j].pinned) lastPinned = j;
    var next = shallow(state);
    // pin → after the existing pinned block; unpin → first of the unpinned
    next.tabs = rest.slice(0, lastPinned + 1).concat([t]).concat(rest.slice(lastPinned + 1));
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
    // Zoom follows the site, the way Chrome's does: a saved override applies
    // the moment you arrive, everywhere else is 100%. Private tabs stay on
    // their own per-tab zoom and never touch the shared map.
    if (!t.incognito) t.zoom = siteSetting(state, url, 'zoom') || 100;
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

  /**
   * Zoom is clamped to the familiar 25%–500% and snapped to whole percents.
   * In a normal tab on a real site the choice is remembered for that site
   * (100% clears the memory — the default isn't an override); private tabs
   * zoom themselves without leaving a trace.
   */
  function setZoom(state, tabId, zoom) {
    var tab = getTab(state, tabId);
    if (!tab) return state;
    var z = Math.round(Number(zoom) || 100);
    z = Math.max(25, Math.min(500, z));
    var next = shallow(state);
    var t = shallow(tab);
    t.zoom = z;
    next.tabs = replaceTab(state.tabs, t);
    if (!tab.incognito) next = setSiteSetting(next, tabUrl(tab) || '', 'zoom', z);
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

  /* ════════════════════════ reading list ════════════════════════ */

  function inReading(state, url) {
    for (var i = 0; i < state.reading.length; i++) if (state.reading[i].url === url) return true;
    return false;
  }

  /** Save-for-later, distinct from bookmarks: a queue you work through and tick off. */
  function addReading(state, url, title, ts) {
    if (!url || String(url).toLowerCase().indexOf(INTERNAL) === 0 || inReading(state, url)) return state;
    var next = shallow(state);
    next.reading = state.reading.concat([{ url: url, title: title || displayUrl(url), ts: ts || null, read: false }]);
    return next;
  }

  function removeReading(state, url) {
    var next = shallow(state);
    next.reading = state.reading.filter(function (r) { return r.url !== url; });
    return next;
  }

  /** Toggle an item's read/unread flag (immutably). */
  function toggleReadingRead(state, url) {
    var next = shallow(state);
    next.reading = state.reading.map(function (r) {
      return r.url === url ? { url: r.url, title: r.title, ts: r.ts, read: !r.read } : r;
    });
    return next;
  }

  /** The reading list newest-first; unread before read. */
  function readingList(state) {
    var items = state.reading.slice();
    items.sort(function (a, b) {
      if (!!a.read !== !!b.read) return a.read ? 1 : -1;   // unread first
      return (b.ts || 0) - (a.ts || 0);                     // newest first
    });
    return items;
  }

  /* ════════════════════════ web memory ════════════════════════ */
  /* The thing no mainstream browser does: a private, on-device, full-text-
   * searchable memory of the readable text of pages you actually read — so you
   * can find "that article" by what it *said*, and re-open a clean offline
   * copy even after the page is paywalled, changed or gone. Never records
   * private tabs or internal pages. Capped so localStorage can't run away. */

  function inMemory(state, url) {
    for (var i = 0; i < state.memory.length; i++) if (state.memory[i].url === url) return true;
    return false;
  }

  /** Remember a page's readable text (replaces any prior copy of the same URL). */
  function rememberPage(state, entry, ts) {
    if (!entry || !entry.url || String(entry.url).toLowerCase().indexOf(INTERNAL) === 0) return state;
    var text = String(entry.text || '').slice(0, MEMORY_TEXT_CAP);
    if (!text) return state;
    var rec = {
      url: entry.url,
      title: entry.title || displayUrl(entry.url),
      text: text,
      words: Number(entry.words) || text.split(/\s+/).length,
      ts: ts || null,
    };
    var next = shallow(state);
    next.memory = state.memory.filter(function (m) { return m.url !== entry.url; }).concat([rec]);
    if (next.memory.length > MEMORY_CAP) next.memory = next.memory.slice(next.memory.length - MEMORY_CAP);
    return next;
  }

  function forgetMemory(state, url) {
    var next = shallow(state);
    next.memory = state.memory.filter(function (m) { return m.url !== url; });
    return next;
  }

  function clearMemory(state) { var next = shallow(state); next.memory = []; return next; }

  function memoryEntry(state, url) {
    for (var i = 0; i < state.memory.length; i++) if (state.memory[i].url === url) return state.memory[i];
    return null;
  }

  /**
   * Full-text search over remembered pages. Ranks by how many of the query
   * terms hit the title (weighted) and body, lightly boosted by recency, and
   * returns a highlighted-around snippet of the first match. Empty query lists
   * everything newest-first.
   */
  function searchMemory(state, query, opts) {
    opts = opts || {};
    var limit = opts.limit || 50;
    var terms = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < state.memory.length; i++) {
      var m = state.memory[i];
      var title = (m.title || '').toLowerCase();
      var text = (m.text || '').toLowerCase();
      var score = 0, firstAt = -1;
      if (!terms.length) {
        score = 1;
      } else {
        for (var t = 0; t < terms.length; t++) {
          var term = terms[t];
          var inTitle = title.indexOf(term) !== -1;
          var at = text.indexOf(term);
          if (!inTitle && at === -1) { score = 0; firstAt = -1; break; } // require every term (AND)
          if (inTitle) score += 8;
          if (at !== -1) { score += 2; if (firstAt === -1 || at < firstAt) firstAt = at; }
        }
      }
      if (score <= 0) continue;
      out.push({ url: m.url, title: m.title, ts: m.ts, words: m.words, score: score, snippet: snippetAround(m.text, firstAt, terms) });
    }
    out.sort(function (a, b) { return b.score - a.score || (b.ts || 0) - (a.ts || 0); });
    if (out.length > limit) out = out.slice(0, limit);
    return out;
  }

  /** A ~180-char window of text around the first matched term, trimmed to words. */
  function snippetAround(text, at, terms) {
    text = String(text || '');
    if (at < 0) { at = 0; }
    var start = Math.max(0, at - 70);
    var slice = text.slice(start, start + 200).replace(/\s+/g, ' ').trim();
    if (start > 0) slice = '…' + slice.replace(/^\S*\s/, '');
    if (start + 200 < text.length) slice = slice.replace(/\s\S*$/, '') + '…';
    return slice;
  }

  /* ════════════════════════ time travel: what changed ════════════════════
   * Web memory keeps the text you actually read. When the same page comes
   * back different, a paragraph-level diff shows exactly what was edited —
   * the quiet rewrites (news edits, price changes, ToS tweaks) browsers
   * normally let slip past. */

  function paragraphsOf(text) {
    var out = [];
    var parts = String(text == null ? '' : text).split(/\n\n+/);
    for (var i = 0; i < parts.length; i++) { var p = parts[i].trim(); if (p) out.push(p); }
    return out;
  }

  /**
   * Paragraph-level LCS diff. Returns the merged story in order:
   * [{type:'same'|'removed'|'added', text}] — 'removed' is what you read,
   * 'added' is what the page says now.
   */
  function diffTexts(oldText, newText) {
    var a = paragraphsOf(oldText), b = paragraphsOf(newText);
    var n = a.length, m = b.length;
    var L = [];                                     // (n+1)×(m+1) LCS lengths
    for (var i = n; i >= 0; i--) {
      L[i] = [];
      for (var j = m; j >= 0; j--) {
        if (i === n || j === m) L[i][j] = 0;
        else if (a[i] === b[j]) L[i][j] = L[i + 1][j + 1] + 1;
        else L[i][j] = Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    var out = [], x = 0, y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) { out.push({ type: 'same', text: a[x] }); x++; y++; }
      else if (L[x + 1][y] >= L[x][y + 1]) { out.push({ type: 'removed', text: a[x] }); x++; }
      else { out.push({ type: 'added', text: b[y] }); y++; }
    }
    while (x < n) out.push({ type: 'removed', text: a[x++] });
    while (y < m) out.push({ type: 'added', text: b[y++] });
    return out;
  }

  /**
   * Has `url` changed since it was read? null when there's nothing to compare
   * (not remembered, no text, or identical); else {sinceTs, added, removed,
   * parts} — parts being the full diffTexts story for rendering.
   */
  function pageChanges(state, url, newText) {
    var mem = memoryEntry(state, url);
    if (!mem || !mem.text) return null;
    var fresh = String(newText == null ? '' : newText).slice(0, MEMORY_TEXT_CAP);
    if (!fresh || fresh === mem.text) return null;
    var parts = diffTexts(mem.text, fresh);
    var added = 0, removed = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'added') added++;
      else if (parts[i].type === 'removed') removed++;
    }
    if (!added && !removed) return null;
    return { sinceTs: mem.ts || null, added: added, removed: removed, parts: parts };
  }

  /* ════════════════════════ TL;DR: extractive summary ════════════════════ */

  var STOPWORDS = ('the a an and or but if then else of to in on at by for with from as is are was were be been ' +
    'being it its this that these those he she they them his her their we you your i me my our us not no yes do ' +
    'does did done can could will would may might must shall should have has had having there here when where ' +
    'what which who whom whose why how all any both each few more most other some such only own same so than ' +
    'too very just about into over under again further once s t don now').split(' ');
  var STOP = {};
  for (var sw = 0; sw < STOPWORDS.length; sw++) STOP[STOPWORDS[sw]] = 1;

  function sentencesOf(text) {
    var out = [];
    var m = String(text == null ? '' : text).replace(/\n+/g, ' ').match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [];
    for (var i = 0; i < m.length; i++) { var s = m[i].trim(); if (s) out.push(s); }
    return out;
  }

  /**
   * The gist, extracted not generated: sentences scored by how many of the
   * text's own significant words they carry (frequency-weighted, length-
   * normalised, early sentences nudged up), top N returned in reading order.
   * Deterministic, offline, no model — the summary is the article's own words.
   */
  function summarize(text, opts) {
    var want = (opts && opts.sentences) || 3;
    var sents = sentencesOf(text);
    if (sents.length <= want) return sents.join(' ');
    var freq = {}, i, w;
    for (i = 0; i < sents.length; i++) {
      var words = sents[i].toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
      for (var j = 0; j < words.length; j++) { w = words[j]; if (!STOP[w]) freq[w] = (freq[w] || 0) + 1; }
    }
    var scored = [];
    for (i = 0; i < sents.length; i++) {
      var ws = sents[i].toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
      var score = 0, kept = 0;
      for (var k = 0; k < ws.length; k++) { if (!STOP[ws[k]]) { score += freq[ws[k]]; kept++; } }
      score = kept ? score / Math.sqrt(kept) : 0;
      if (i === 0) score *= 1.35;                    // openers usually orient the reader
      else if (i === 1) score *= 1.15;
      scored.push({ i: i, score: score });
    }
    scored.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    var picked = scored.slice(0, want).map(function (s) { return s.i; }).sort(function (a, b) { return a - b; });
    var out = [];
    for (i = 0; i < picked.length; i++) out.push(sents[picked[i]]);
    return out.join(' ');
  }

  /* ════════════════════════ ask your memory ════════════════════════
   * A question in, an answer out — extracted verbatim from pages you've
   * actually read, with the sources named. No model, no cloud: the corpus is
   * your memory, the answer is a quote. */

  /**
   * Answer a question from remembered pages. Scores each memory hit's
   * sentences by how many significant question terms they carry (frequency-
   * free — the question drives, not the document), returns up to two of the
   * best sentences (each from its own page allowed) plus their sources.
   * null when the question has no significant terms or nothing matches.
   */
  function askMemory(state, question, opts) {
    opts = opts || {};
    var terms = String(question == null ? '' : question).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
    terms = terms.filter(function (w) { return !STOP[w]; });
    if (!terms.length) return null;
    // Best-effort retrieval — questions carry words the page won't ("long",
    // "why"), so rank pages by how many terms they DO carry, not AND-match.
    var pages = [];
    for (var pm = 0; pm < state.memory.length; pm++) {
      var cand = state.memory[pm];
      var hay = ((cand.title || '') + ' ' + (cand.text || '')).toLowerCase();
      var got = 0;
      for (var pt = 0; pt < terms.length; pt++) if (hay.indexOf(terms[pt]) !== -1) got++;
      if (got) pages.push({ url: cand.url, got: got, ts: cand.ts || 0 });
    }
    if (!pages.length) return null;
    pages.sort(function (a, b) { return b.got - a.got || b.ts - a.ts; });
    if (pages.length > (opts.pages || 3)) pages = pages.slice(0, opts.pages || 3);
    var best = [];
    for (var p = 0; p < pages.length; p++) {
      var mem = memoryEntry(state, pages[p].url);
      if (!mem || !mem.text) continue;
      var sents = sentencesOf(mem.text);
      for (var i = 0; i < sents.length; i++) {
        var low = sents[i].toLowerCase();
        var hit = 0;
        for (var t = 0; t < terms.length; t++) if (low.indexOf(terms[t]) !== -1) hit++;
        if (!hit) continue;
        var words = low.match(/[a-z][a-z'-]{2,}/g) || [];
        // coverage first, then density — a tight sentence beats a rambling one
        best.push({ score: hit * 100 + (words.length ? Math.round(100 * hit / Math.sqrt(words.length)) : 0),
                    text: sents[i], url: mem.url, title: mem.title });
      }
    }
    if (!best.length) return null;
    best.sort(function (a, b) { return b.score - a.score; });
    var picked = [];
    for (var b2 = 0; b2 < best.length && picked.length < 2; b2++) {
      if (picked.length && best[b2].score < best[0].score * 0.5) break;   // don't pad with weak lines
      picked.push(best[b2]);
    }
    var sources = [];
    var srcSeen = {};
    for (var s2 = 0; s2 < picked.length; s2++) {
      if (srcSeen[picked[s2].url]) continue;
      srcSeen[picked[s2].url] = true;
      sources.push({ url: picked[s2].url, title: picked[s2].title });
    }
    return { answer: picked.map(function (x) { return x.text; }).join(' '), sources: sources };
  }

  /* ════════════════════════ per-site settings ════════════════════════
   * Overrides keyed by site (host minus www.): zoom sticks to the site the way
   * Chrome's does, and tracker-blocking / memory-capture can be flipped for one
   * site without touching the global switch. Absent key = use the global. */

  /** The site key for a URL or bare host: lowercased host, www. stripped. */
  function siteOf(urlOrHost) {
    var s = String(urlOrHost == null ? '' : urlOrHost).trim();
    var host = s.indexOf('://') !== -1 ? hostOf(s) : s.toLowerCase().split(/[/?#]/)[0];
    return host.replace(/^www\./, '');
  }

  /** One override for a URL/host, or undefined when the global should rule. */
  function siteSetting(state, urlOrHost, key) {
    var site = (state.sites || {})[siteOf(urlOrHost)];
    return site ? site[key] : undefined;
  }

  /**
   * Set (or clear, with value === undefined/null) one per-site override.
   * zoom clamps to 25–500 and 100 clears itself — the default isn't an override.
   */
  function setSiteSetting(state, urlOrHost, key, value) {
    var host = siteOf(urlOrHost);
    var allowed = { zoom: 1, blockTrackers: 1, remember: 1 };
    if (!host || !allowed[key]) return state;
    if (key === 'zoom' && value != null) {
      value = Math.max(25, Math.min(500, Math.round(Number(value) || 100)));
      if (value === 100) value = null;
    }
    if ((key === 'blockTrackers' || key === 'remember') && value != null) value = !!value;
    var next = shallow(state);
    next.sites = shallow(state.sites || {});
    var site = shallow(next.sites[host] || {});
    if (value == null) delete site[key]; else site[key] = value;
    var empty = true;
    for (var k in site) if (Object.prototype.hasOwnProperty.call(site, k)) { empty = false; break; }
    if (empty) delete next.sites[host]; else next.sites[host] = site;
    return next;
  }

  function clearSiteSettings(state, urlOrHost) {
    var host = siteOf(urlOrHost);
    if (!host || !(state.sites || {})[host]) return state;
    var next = shallow(state);
    next.sites = shallow(state.sites);
    delete next.sites[host];
    return next;
  }

  /**
   * The tracker receipt: tally how many tracker requests a site's pages have
   * carried (the proxy counts them per page; this remembers). Lives in the
   * same per-site map, shown on voyager://site.
   */
  function recordTrackers(state, url, n) {
    var host = siteOf(url);
    n = Math.floor(Number(n) || 0);
    if (!host || n <= 0) return state;
    var next = shallow(state);
    next.sites = shallow(state.sites || {});
    var site = shallow(next.sites[host] || {});
    site.trackersSeen = (site.trackersSeen || 0) + n;
    next.sites[host] = site;
    return next;
  }

  /* ════════════════════════ swipe gestures ════════════════════════ */

  /**
   * Classify a completed touch drag: a decisively horizontal swipe of at least
   * minDist px (default 70) is 'back' (rightward — dragging the past back in)
   * or 'forward' (leftward); anything shorter or too vertical is null.
   */
  function swipeAction(dx, dy, opts) {
    var minDist = (opts && opts.minDist) || 70;
    dx = Number(dx) || 0; dy = Number(dy) || 0;
    if (Math.abs(dx) < minDist || Math.abs(dx) < 2 * Math.abs(dy)) return null;
    return dx > 0 ? 'back' : 'forward';
  }

  /* ════════════════════════ highlights ════════════════════════
   * Marker-pen for the web: passages you select in Reader are kept on-device,
   * re-inked every time you return, and they survive the live page dying —
   * they belong to YOUR copy. */

  var HIGHLIGHT_CAP = 400;        // total kept (oldest fall off)
  var HIGHLIGHT_TEXT_CAP = 500;   // chars per highlight

  function addHighlight(state, url, text, ts) {
    if (!url || String(url).toLowerCase().indexOf(INTERNAL) === 0) return state;
    text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, HIGHLIGHT_TEXT_CAP);
    if (!text) return state;
    for (var i = 0; i < state.highlights.length; i++) {
      if (state.highlights[i].url === url && state.highlights[i].text === text) return state;
    }
    var next = shallow(state);
    next.highlights = state.highlights.concat([{ url: url, text: text, ts: ts || null }]);
    if (next.highlights.length > HIGHLIGHT_CAP) next.highlights = next.highlights.slice(next.highlights.length - HIGHLIGHT_CAP);
    return next;
  }

  function removeHighlight(state, url, text) {
    var next = shallow(state);
    next.highlights = state.highlights.filter(function (h) { return !(h.url === url && h.text === text); });
    return next;
  }

  function highlightsFor(state, url) {
    return state.highlights.filter(function (h) { return h.url === url; });
  }

  /* ════════════════════════ follows: sites that come to you ═══════════════
   * A from-scratch feed follower — no account, no algorithm, no unread-count
   * anxiety. The proxy discovers a site's RSS/Atom feed; the engine keeps the
   * follows and merges their newest items for the start page. */

  var FOLLOW_CAP = 30;            // feeds followed
  var FOLLOW_ITEM_CAP = 20;       // items kept per feed

  function normFeedItems(items) {
    var out = [];
    for (var i = 0; i < (items || []).length && out.length < FOLLOW_ITEM_CAP; i++) {
      var it = items[i];
      if (!it || !it.url || !/^https?:/i.test(String(it.url))) continue;
      out.push({ title: String(it.title || '').slice(0, 200) || displayUrl(it.url), url: it.url, ts: Number(it.ts) || null });
    }
    return out;
  }

  function isFollowed(state, feedOrSiteUrl) {
    var s = String(feedOrSiteUrl || '');
    var host = siteOf(s);
    for (var i = 0; i < state.follows.length; i++) {
      var f = state.follows[i];
      if (f.feedUrl === s || (host && (siteOf(f.siteUrl) === host || siteOf(f.feedUrl) === host))) return true;
    }
    return false;
  }

  function addFollow(state, feed, ts) {
    if (!feed || !feed.feedUrl || !/^https?:/i.test(String(feed.feedUrl))) return state;
    for (var i = 0; i < state.follows.length; i++) if (state.follows[i].feedUrl === feed.feedUrl) return state;
    var next = shallow(state);
    next.follows = state.follows.concat([{
      feedUrl: feed.feedUrl,
      siteUrl: feed.siteUrl || feed.feedUrl,
      title: String(feed.title || '').slice(0, 80) || siteOf(feed.feedUrl) || displayUrl(feed.feedUrl),
      items: normFeedItems(feed.items),
      updatedTs: ts || null,
    }]);
    if (next.follows.length > FOLLOW_CAP) next.follows = next.follows.slice(next.follows.length - FOLLOW_CAP);
    return next;
  }

  function removeFollow(state, feedOrSiteUrl) {
    var host = siteOf(String(feedOrSiteUrl || ''));
    var next = shallow(state);
    next.follows = state.follows.filter(function (f) {
      return f.feedUrl !== feedOrSiteUrl && !(host && (siteOf(f.siteUrl) === host || siteOf(f.feedUrl) === host));
    });
    return next;
  }

  /** Fresh items for an already-followed feed (a refresh), newest kept. */
  function updateFollow(state, feedUrl, items, ts) {
    var next = shallow(state);
    var changed = false;
    next.follows = state.follows.map(function (f) {
      if (f.feedUrl !== feedUrl) return f;
      changed = true;
      var nf = shallow(f);
      nf.items = normFeedItems(items);
      nf.updatedTs = ts || null;
      return nf;
    });
    return changed ? next : state;
  }

  /** The start-page river: every follow's items merged, newest first. */
  function followedItems(state, limit) {
    var out = [];
    for (var i = 0; i < state.follows.length; i++) {
      var f = state.follows[i];
      for (var j = 0; j < f.items.length; j++) {
        out.push({ title: f.items[j].title, url: f.items[j].url, ts: f.items[j].ts, source: f.title });
      }
    }
    out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (limit && out.length > limit) out = out.slice(0, limit);
    return out;
  }

  /* ════════════════════════ start-page shortcuts ════════════════════════ */

  function addShortcut(state, url, title) {
    if (!url || String(url).toLowerCase().indexOf(INTERNAL) === 0) return state;
    for (var i = 0; i < state.shortcuts.length; i++) if (state.shortcuts[i].url === url) return state;
    var next = shallow(state);
    next.shortcuts = state.shortcuts.concat([{ url: url, title: title || displayUrl(url) }]);
    return next;
  }

  function removeShortcut(state, url) {
    var next = shallow(state);
    next.shortcuts = state.shortcuts.filter(function (s) { return s.url !== url; });
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

  /* ════════════════════════ command palette (⌘K) ════════════════════════ */

  /** The quick actions the palette can run, matched by name/keyword. */
  var COMMANDS = [
    { id: 'newtab', title: 'New tab', keys: 'new tab open' },
    { id: 'newprivate', title: 'New private tab', keys: 'private incognito new tab' },
    { id: 'reading', title: 'Reading list', keys: 'reading list read later' },
    { id: 'bookmarks', title: 'Bookmarks', keys: 'bookmarks stars saved' },
    { id: 'history', title: 'History', keys: 'history recent visited' },
    { id: 'settings', title: 'Settings', keys: 'settings preferences options theme proxy' },
    { id: 'clearhistory', title: 'Clear history', keys: 'clear delete history' },
  ];

  /**
   * The ⌘K palette: one box to jump anywhere. Blends open tabs, this browser's
   * reading list, bookmarks and frecent history, plus the quick actions above —
   * ranked so the most useful match leads. Empty query returns your open tabs
   * and unread reading items (a "where was I" board).
   */
  function commandSearch(state, input, opts) {
    opts = opts || {};
    var limit = opts.limit || 10;
    var nowTs = opts.nowTs || 0;
    var q = String(input == null ? '' : input).toLowerCase().trim();
    var out = [];

    // open tabs first — switching is the most common intent
    for (var t = 0; t < state.tabs.length; t++) {
      var tab = state.tabs[t];
      var turl = tabUrl(tab);
      var ttitle = tab.title || displayUrl(turl);
      var thay = (ttitle + ' ' + turl).toLowerCase();
      if (q && thay.indexOf(q) === -1) continue;
      out.push({ kind: 'tab', id: tab.id, title: ttitle, url: turl, incognito: tab.incognito, score: 10000 - t });
    }

    // quick actions
    for (var c = 0; c < COMMANDS.length; c++) {
      var cmd = COMMANDS[c];
      if (q && (cmd.title.toLowerCase() + ' ' + cmd.keys).indexOf(q) === -1) continue;
      out.push({ kind: 'action', id: cmd.id, title: cmd.title, score: q ? 5000 : 10 });
    }

    // reading list (unread lead)
    for (var r = 0; r < state.reading.length; r++) {
      var it = state.reading[r];
      if (q && (it.title + ' ' + it.url).toLowerCase().indexOf(q) === -1) continue;
      out.push({ kind: 'reading', url: it.url, title: it.title, read: it.read, score: (it.read ? 1000 : 3000) - r });
    }

    // bookmarks + frecent history (dedup against everything already shown)
    var seen = {};
    for (var s = 0; s < out.length; s++) if (out[s].url) seen[out[s].url] = true;
    for (var b = 0; b < state.bookmarks.length; b++) {
      var bm = state.bookmarks[b];
      if (seen[bm.url]) continue;
      if (q && (bm.title + ' ' + bm.url).toLowerCase().indexOf(q) === -1) continue;
      seen[bm.url] = true;
      out.push({ kind: 'bookmark', url: bm.url, title: bm.title, score: 2000 });
    }
    if (q) {
      // remembered pages matched by their *contents* — the unique bit
      var mem = searchMemory(state, q, { limit: 4 });
      for (var mm = 0; mm < mem.length; mm++) {
        if (seen[mem[mm].url]) continue;
        seen[mem[mm].url] = true;
        out.push({ kind: 'memory', url: mem[mm].url, title: mem[mm].title, snippet: mem[mm].snippet, score: 1500 });
      }
      var ranked = rankedSites(state, nowTs);
      for (var h = 0; h < ranked.length; h++) {
        var site = ranked[h];
        if (seen[site.url]) continue;
        if ((site.url + ' ' + (site.title || '')).toLowerCase().indexOf(q) === -1) continue;
        seen[site.url] = true;
        out.push({ kind: 'history', url: site.url, title: site.title || displayUrl(site.url), score: 100 + site.score });
      }
    }

    out.sort(function (a, b) { return b.score - a.score; });
    if (out.length > limit) out = out.slice(0, limit);
    return out;
  }

  /* ════════════════════════ settings ════════════════════════ */

  var THEMES = ['dark', 'light', 'auto'];
  var ACCENTS = [
    { id: 'cyan', name: 'Cyan', hi: '#4cc9f0', lo: '#5b7bff' },
    { id: 'violet', name: 'Violet', hi: '#b07cf7', lo: '#6e8bff' },
    { id: 'mint', name: 'Mint', hi: '#3ce6b0', lo: '#22b8e6' },
    { id: 'gold', name: 'Gold', hi: '#f5c04a', lo: '#f78c3b' },
    { id: 'rose', name: 'Rose', hi: '#ff6b9a', lo: '#ff6b7a' },
  ];

  function setSetting(state, key, value) {
    var allowed = { engine: 1, home: 1, torGateway: 1, proxy: 1, theme: 1, accent: 1, blockTrackers: 1, remember: 1, startName: 1 };
    if (!allowed[key]) return state;
    if (key === 'engine') {
      var ok = false;
      for (var i = 0; i < SEARCH_ENGINES.length; i++) if (SEARCH_ENGINES[i].id === value) ok = true;
      if (!ok) return state;
    }
    if (key === 'theme' && THEMES.indexOf(value) === -1) return state;
    if (key === 'accent') {
      var accOk = false;
      for (var a = 0; a < ACCENTS.length; a++) if (ACCENTS[a].id === value) accOk = true;
      if (!accOk) return state;
    }
    if (key === 'blockTrackers' || key === 'remember') value = !!value;
    if (key === 'startName') value = String(value == null ? '' : value).slice(0, 40);
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
    // Remember that the engine was *chosen*, not defaulted — so a future
    // change of Voyager's default never overrides a deliberate pick.
    if (key === 'engine') next.settings.engineChosen = true;
    return next;
  }

  /* ════════════════════════ your numbers ════════════════════════
   * The dashboard browsers never give you honestly: everything computed
   * on-device from your own ledgers, nothing phoned home to make it. */

  function browsingStats(state, nowTs) {
    nowTs = nowTs || 0;
    var hosts = {}, distinct = 0;
    for (var i = 0; i < state.history.length; i++) {
      var h = hostOf(state.history[i].url);
      if (h && !hosts[h]) { hosts[h] = true; distinct++; }
    }
    var wordsRead = 0;
    for (var m = 0; m < state.memory.length; m++) wordsRead += Number(state.memory[m].words) || 0;
    var trackersSeen = 0;
    for (var k in (state.sites || {})) {
      if (Object.prototype.hasOwnProperty.call(state.sites, k)) trackersSeen += Number(state.sites[k].trackersSeen) || 0;
    }
    // Reading streak: consecutive days with at least one visit, counting back
    // from today (or yesterday, if today hasn't started yet).
    var days = {};
    for (var v = 0; v < state.history.length; v++) {
      var ts = Number(state.history[v].ts);
      if (ts > 0) days[Math.floor(ts / 86400000)] = true;
    }
    var today = Math.floor(nowTs / 86400000);
    var streak = 0, cursor = days[today] ? today : today - 1;
    while (days[cursor]) { streak++; cursor--; }
    return {
      visits: state.history.length,
      sites: distinct,
      wordsRead: wordsRead,
      pagesRemembered: state.memory.length,
      highlights: state.highlights.length,
      follows: state.follows.length,
      trackersSeen: trackersSeen,
      streakDays: streak,
      topSites: topSites(state, 5, nowTs),
    };
  }

  /* ════════════════════════ session ════════════════════════ */

  /** Persistable JSON. Incognito tabs are simply not part of the story. */
  function serialize(state) {
    var tabs = [];
    for (var i = 0; i < state.tabs.length; i++) {
      var t = state.tabs[i];
      if (t.incognito) continue;
      tabs.push({ id: t.id, stack: t.stack.slice(), pos: t.pos, title: t.title, pinned: !!t.pinned, space: t.space || 1, zoom: t.zoom, openedAt: t.openedAt });
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
      reading: state.reading,
      memory: state.memory,
      shortcuts: state.shortcuts,
      sites: state.sites || {},
      highlights: state.highlights || [],
      follows: state.follows || [],
      spaces: state.spaces || [{ id: 1, name: 'Home', lastActiveId: null }],
      activeSpace: state.activeSpace || 1,
      nextSpaceId: state.nextSpaceId || 2,
      splitId: state.splitId != null ? state.splitId : null,
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
      tabs.push({ id: t.id, stack: t.stack, pos: pos, title: String(t.title || ''), incognito: false, pinned: !!t.pinned, space: Number(t.space) || 1, zoom: Math.max(25, Math.min(500, Number(t.zoom) || 100)), openedAt: t.openedAt || null });
      if (t.id > maxId) maxId = t.id;
    }
    // Workspaces: validate the stored list (legacy sessions get the one Home
    // space), and re-home any tab whose space no longer exists.
    var spaces = [];
    if (Array.isArray(data.spaces)) {
      for (var sp = 0; sp < data.spaces.length; sp++) {
        var s0 = data.spaces[sp];
        if (s0 && Number(s0.id) > 0 && s0.name) spaces.push({ id: Number(s0.id), name: String(s0.name).slice(0, 24), lastActiveId: s0.lastActiveId != null ? s0.lastActiveId : null });
      }
    }
    if (!spaces.length) spaces = [{ id: 1, name: 'Home', lastActiveId: null }];
    var spaceIds = {};
    for (var si = 0; si < spaces.length; si++) spaceIds[spaces[si].id] = true;
    var maxSpace = 0;
    for (var sm = 0; sm < spaces.length; sm++) if (spaces[sm].id > maxSpace) maxSpace = spaces[sm].id;
    for (var ti = 0; ti < tabs.length; ti++) if (!spaceIds[tabs[ti].space]) tabs[ti].space = spaces[0].id;
    var state = {
      v: VERSION,
      nextId: Math.max(Number(data.nextId) || 1, maxId + 1),
      tabs: tabs,
      activeId: null,
      history: Array.isArray(data.history) ? data.history : [],
      bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [],
      reading: Array.isArray(data.reading) ? data.reading : [],
      memory: Array.isArray(data.memory) ? data.memory : [],
      shortcuts: Array.isArray(data.shortcuts) ? data.shortcuts : [],
      sites: (data.sites && typeof data.sites === 'object' && !Array.isArray(data.sites)) ? data.sites : {},
      highlights: Array.isArray(data.highlights) ? data.highlights : [],
      follows: Array.isArray(data.follows) ? data.follows : [],
      spaces: spaces,
      activeSpace: spaceIds[Number(data.activeSpace)] ? Number(data.activeSpace) : spaces[0].id,
      nextSpaceId: Math.max(Number(data.nextSpaceId) || 2, maxSpace + 1),
      settings: {
        // The stored engine, with one honest migration: 'duckduckgo' that was
        // never explicitly chosen is just the old default frozen into a saved
        // session — upgrade it to Seeker. A deliberate pick (engineChosen,
        // stamped by setSetting) is kept forever, whatever the default becomes.
        engine: (function () {
          var stored = (data.settings && data.settings.engine) || 'seeker';
          var chosen = !!(data.settings && data.settings.engineChosen);
          return (stored === 'duckduckgo' && !chosen) ? 'seeker' : stored;
        })(),
        engineChosen: !!(data.settings && data.settings.engineChosen),
        home: (data.settings && data.settings.home) || INTERNAL + 'start',
        torGateway: (data.settings && data.settings.torGateway) || '',
        proxy: (data.settings && data.settings.proxy) || '',
        theme: (data.settings && THEMES.indexOf(data.settings.theme) !== -1) ? data.settings.theme : 'dark',
        accent: (data.settings && data.settings.accent) || 'cyan',
        blockTrackers: !(data.settings && data.settings.blockTrackers === false),
        remember: !(data.settings && data.settings.remember === false),
        startName: (data.settings && String(data.settings.startName || '').slice(0, 40)) || '',
      },
    };
    if (tabs.length === 0) return newTab(state, {});
    state.activeId = getTab(state, data.activeId) ? data.activeId : tabs[0].id;
    state.activeSpace = getTab(state, state.activeId).space || 1;   // desk follows the active tab
    state.splitId = getTab(state, data.splitId) ? data.splitId : null;
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
    normalizeProxyBase: normalizeProxyBase,
    videoEmbedUrl: videoEmbedUrl,
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
    inReading: inReading,
    addReading: addReading,
    removeReading: removeReading,
    toggleReadingRead: toggleReadingRead,
    readingList: readingList,
    inMemory: inMemory,
    rememberPage: rememberPage,
    forgetMemory: forgetMemory,
    clearMemory: clearMemory,
    memoryEntry: memoryEntry,
    searchMemory: searchMemory,
    addShortcut: addShortcut,
    removeShortcut: removeShortcut,
    togglePin: togglePin,
    getSpace: getSpace,
    spaceTabs: spaceTabs,
    setSplit: setSplit,
    splitTab: splitTab,
    browsingStats: browsingStats,
    addSpace: addSpace,
    renameSpace: renameSpace,
    switchSpace: switchSpace,
    removeSpace: removeSpace,
    diffTexts: diffTexts,
    pageChanges: pageChanges,
    summarize: summarize,
    askMemory: askMemory,
    recordTrackers: recordTrackers,
    addHighlight: addHighlight,
    removeHighlight: removeHighlight,
    highlightsFor: highlightsFor,
    isFollowed: isFollowed,
    addFollow: addFollow,
    removeFollow: removeFollow,
    updateFollow: updateFollow,
    followedItems: followedItems,
    siteOf: siteOf,
    siteSetting: siteSetting,
    setSiteSetting: setSiteSetting,
    clearSiteSettings: clearSiteSettings,
    swipeAction: swipeAction,
    frecency: frecency,
    topSites: topSites,
    suggest: suggest,
    commandSearch: commandSearch,
    COMMANDS: COMMANDS,
    THEMES: THEMES,
    ACCENTS: ACCENTS,
    setSetting: setSetting,
    serialize: serialize,
    restore: restore,
  };
});
