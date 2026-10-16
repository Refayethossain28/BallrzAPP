/* ===== LIBRARY: favourites, recents, resume, subscriptions, queue, settings, sleep timer — immutable reducers ===== */
var LIBRARY = (function () {
  'use strict';

  var VERSION = 1;
  var TYPES = { radio: 1, podcast: 1, video: 1, show: 1 };
  var PLAYABLE = { radio: 1, podcast: 1, video: 1 };   // a show is a feed, not a stream: it can be favourited, not queued or played
  var CAP = { favourites: 500, recents: 60, queue: 200, subscriptions: 500, resume: 500 };
  // One stored string. Show notes run to tens of KB per episode and a library keeps hundreds of items in
  // localStorage, so text is cut hard. URLs get a separate, larger budget: tracking-wrapped podcast enclosure
  // URLs regularly pass 300 chars, and cutting a URL corrupts the item's key and makes it unplayable.
  var MAX_TEXT = 300;
  var MAX_URL = 2048;
  var MAX_KEY = 'podcast:'.length + MAX_URL + 1 + MAX_URL;   // a guid-less episode is keyed by feed URL + enclosure URL
  var MAX_TAGS = 8;
  var MAX_TAG = 60;
  var MAX_SHARE_TITLE = 200;
  var MAX_HASH = 16384;      // longer than any link shareLink can produce; keeps a hostile hash from being scanned in full
  var RESUME_MIN_SEC = 10;   // a tap-and-skip is not a listening session worth resuming
  var FINISHED_RATIO = 0.95; // outros and end credits: the last 5% counts as heard
  var MAX_SLEEP_MIN = 24 * 60;
  var KEY_RE = /^(radio|podcast|video|show):./;
  var CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
  var IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };

  var LIB_KEYS = ['v', 'favourites', 'recents', 'resume', 'subscriptions', 'queue', 'settings', 'sleep', 'updatedAt'];
  var SETTING_DEFAULTS = { httpsOnly: true, dataSaver: false, maxHeight: 1080, autoplay: true, theme: 'auto', visualiser: true, startTab: 'radio' };
  var SETTING_KEYS = Object.keys(SETTING_DEFAULTS);   // fixed order so a settings object always serialises the same way
  var SETTING_CHOICES = { maxHeight: [360, 480, 720, 1080, 2160], theme: ['auto', 'light', 'dark'], startTab: ['radio', 'podcasts', 'tv', 'library'] };

  /* ---------- input coercion: items arrive from the directory, feeds, storage and pastes, so every field is read defensively ---------- */
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  // Own properties only: a JSON object with a "__proto__" key, or a polluted prototype, must not feed values in.
  function get(o, k) { return isObj(o) && hasOwn(o, k) ? o[k] : undefined; }
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v)) ? String(v) : ''; }
  function num(v) {
    if (typeof v === 'string') v = v.trim() === '' ? NaN : Number(v);
    return typeof v === 'number' && isFinite(v) ? v : NaN;
  }
  // A cut never ends on a high surrogate: that would leave an unpaired code unit that encodeURIComponent rejects.
  function cap(s, max) {
    if (s.length <= max) return s;
    s = s.slice(0, max);
    var c = s.charCodeAt(s.length - 1);
    return c >= 0xd800 && c <= 0xdbff ? s.slice(0, -1) : s;
  }
  // Control characters: the whitespace kind (tab, newline…) becomes a space, the rest (NUL, escapes) vanish.
  function text(v, max) {
    var clean = str(v).replace(CONTROL_RE, function (c) { return /\s/.test(c) ? ' ' : ''; });
    return cap(UTIL.collapseWs(clean), max || MAX_TEXT);
  }
  function httpUrl(v) {
    v = str(v).trim();
    return v.length <= MAX_URL && UTIL.isHttpUrl(v) && !/[\s\u0000-\u001f\u007f]/.test(v) ? v : '';
  }
  function stamp(v) { var n = num(v); return n >= 0 ? n : NaN; }
  // Reducers stamp with the clock they are given; a missing clock falls back to the library's own last stamp,
  // so timestamps never go backwards and nothing is silently dropped for want of a `now`.
  function stampOf(now, lib) { var t = stamp(now); return t === t ? t : lib.updatedAt; }
  function tagsOf(v) {
    var parts = Array.isArray(v) ? v : str(v).split(',');
    var out = [];
    for (var i = 0; i < parts.length && out.length < MAX_TAGS; i++) {
      var t = text(parts[i], MAX_TAG).toLowerCase();
      if (t && out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }
  function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  // encodeURIComponent throws on a lone surrogate (a truncated emoji from a sloppy paste); swap those for U+FFFD.
  function enc(s) {
    try { return encodeURIComponent(s); } catch (e) { /* lone surrogate: repair below */ }
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { out += s.slice(i, i + 2); i++; }
      else out += (c >= 0xd800 && c <= 0xdfff) ? '�' : s.charAt(i);
    }
    return encodeURIComponent(out);
  }
  // A hand-typed link may carry a stray "%": decode every valid escape run and keep the rest as typed.
  function dec(s) {
    try { return decodeURIComponent(s); } catch (e) { /* fall back to run-wise decoding */ }
    return s.replace(/(%[0-9a-fA-F]{2})+/g, function (run) { try { return decodeURIComponent(run); } catch (e2) { return run; } });
  }

  /* ---------- items and keys ---------- */
  function feedUrlOf(item) { return httpUrl(get(item, 'feedUrl')) || httpUrl(get(get(item, 'show'), 'feedUrl')); }
  function libraryItemKey(item) {
    if (typeof item === 'string') return KEY_RE.test(item) && item.length <= MAX_KEY ? item : null;
    if (!isObj(item)) return null;
    var id, url;
    switch (get(item, 'type')) {
      case 'radio':
        id = text(get(item, 'id'));
        return id ? 'radio:' + id : null;
      case 'podcast':
        // Some feeds ship items without a guid; the enclosure URL is then the only stable identity.
        id = text(get(item, 'id')) || httpUrl(get(item, 'url'));
        url = feedUrlOf(item);
        return id && url ? 'podcast:' + url + '#' + id : null;
      case 'video':
        url = httpUrl(get(item, 'url'));
        return url ? 'video:' + url : null;
      case 'show':
        url = httpUrl(get(item, 'feedUrl'));
        return url ? 'show:' + url : null;
    }
    return null;
  }
  // A show is identified by its feed; accept a show, an episode (→ its show), a feed URL or a key.
  function showKeyOf(x) {
    if (typeof x === 'string') {
      var s = x.trim();
      if (s.indexOf('show:') === 0) return libraryItemKey(s);
      var u = httpUrl(s);
      return u ? 'show:' + u : null;
    }
    var f = feedUrlOf(x);
    return f ? 'show:' + f : null;
  }
  // Only what the UI renders and plays survives into storage, in a fixed field order (stable JSON, stable tests).
  function libraryCompactItem(item) {
    if (!isObj(item)) return null;
    var type = get(item, 'type');
    if (!hasOwn(TYPES, type)) return null;
    var out = { type: type }, v;
    if ((v = text(get(item, 'id')))) out.id = v;
    if ((v = text(get(item, 'name')))) out.name = v;
    if ((v = text(get(item, 'title')))) out.title = v;
    if ((v = httpUrl(get(item, 'url')))) out.url = v;
    if ((v = feedUrlOf(item))) out.feedUrl = v;
    if ((v = httpUrl(get(item, 'image')))) out.image = v;
    if ((v = httpUrl(get(item, 'favicon')))) out.favicon = v;
    if ((v = text(get(item, 'author')))) out.author = v;
    if ((v = httpUrl(get(item, 'homepage')))) out.homepage = v;
    if ((v = text(get(item, 'country')))) out.country = v;
    if ((v = text(get(item, 'codec'), 16).toUpperCase())) out.codec = v;
    if ((v = Math.trunc(num(get(item, 'bitrate')))) > 0) out.bitrate = v;
    // The player picks native/MSE HLS for a station from this flag (radioStreamKind); without it a stored HLS
    // station whose URL does not end in .m3u8 would be fed to <audio> as a direct stream and fail.
    if (type === 'radio' && get(item, 'hls') === true) out.hls = true;
    if ((v = tagsOf(get(item, 'tags'))).length) out.tags = v;
    if ((v = num(get(item, 'duration'))) > 0) out.duration = v;
    if ((v = Math.trunc(num(get(item, 'published')))) > 0) out.published = v;
    var show = get(item, 'show');
    if (isObj(show)) {
      var s = {};
      if ((v = text(get(show, 'title')))) s.title = v;
      if ((v = httpUrl(get(show, 'feedUrl')))) s.feedUrl = v;
      if ((v = httpUrl(get(show, 'image')))) s.image = v;
      if (Object.keys(s).length) out.show = s;
    }
    return libraryItemKey(out) ? out : null;
  }
  function entryOf(item, at) {
    var c = libraryCompactItem(item);
    if (c) c.updatedAt = at;
    return c;
  }
  function indexOfKey(list, key) {
    for (var i = 0; i < list.length; i++) if (libraryItemKey(list[i]) === key) return i;
    return -1;
  }
  function without(list, key) { return list.filter(function (e) { return libraryItemKey(e) !== key; }); }
  // Drop the oldest entries by updatedAt until the list fits, keeping the survivors in their order. Ties go
  // against the later index: lists are kept newest-first, so a later position is the older entry.
  function capByAge(list, max) {
    if (list.length <= max) return list;
    var order = list.map(function (e, i) { return i; }).sort(function (a, b) { return (list[a].updatedAt - list[b].updatedAt) || (b - a); });
    var drop = new Set(order.slice(0, list.length - max));
    return list.filter(function (e, i) { return !drop.has(i); });
  }
  function resumeEntry(position, duration, at) {
    var d = num(duration), p = num(position);
    // Unknown or live (Infinity) duration: nothing to resume into. Below the minimum: not a session.
    if (!(d > 0) || !(p >= RESUME_MIN_SEC)) return null;
    if (p > d) p = d;
    return { position: p, duration: d, finished: p / d >= FINISHED_RATIO, updatedAt: at };
  }
  // Copy a resume map keeping only well-formed keys, so a "__proto__" or "constructor" own key can never ride along.
  function cloneResume(src) {
    var out = {};
    Object.keys(src).forEach(function (k) { if (KEY_RE.test(k) && k.length <= MAX_KEY) out[k] = src[k]; });
    return out;
  }
  function capResume(map) {
    var keys = Object.keys(map);
    if (keys.length <= CAP.resume) return map;
    var entries = keys.map(function (k) { return { k: k, updatedAt: map[k].updatedAt }; });
    var kept = capByAge(entries, CAP.resume), out = {};
    kept.forEach(function (e) { out[e.k] = map[e.k]; });
    return out;
  }

  /* ---------- settings ---------- */
  function validSetting(key, value) {
    if (!hasOwn(SETTING_DEFAULTS, key)) return undefined;
    if (typeof SETTING_DEFAULTS[key] === 'boolean') return typeof value === 'boolean' ? value : undefined;
    var choices = SETTING_CHOICES[key];
    // maxHeight comes from a <select>, whose value is a string: "720" is as good as 720.
    var v = key === 'maxHeight' ? num(value) : value;
    return choices.indexOf(v) !== -1 ? v : undefined;
  }
  // The valid explicit keys of a raw settings object, and the full settings they imply over the defaults.
  function normalizeSettings(raw) {
    var explicit = {}, settings = {};
    SETTING_KEYS.forEach(function (k) {
      var v = validSetting(k, get(raw, k));
      if (v !== undefined) explicit[k] = v;
      settings[k] = v !== undefined ? v : SETTING_DEFAULTS[k];
    });
    return { settings: settings, explicit: explicit };
  }
  function settingsWith(settings, patch) {
    var out = {};
    SETTING_KEYS.forEach(function (k) { out[k] = hasOwn(patch, k) ? patch[k] : settings[k]; });
    return out;
  }

  /* ---------- the library object ---------- */
  function libraryEmpty() {
    return {
      v: VERSION, favourites: [], recents: [], resume: {}, subscriptions: [], queue: [],
      settings: settingsWith(SETTING_DEFAULTS, {}), sleep: null, updatedAt: 0
    };
  }
  // Duplicate keys (a hand-edited or merged file): the newest stamp wins, in the first occurrence's position.
  function normalizeStamped(raw, max, allow) {
    if (!Array.isArray(raw)) return [];
    var out = [], at = new Map();
    for (var i = 0; i < raw.length; i++) {
      var e = libraryCompactItem(raw[i]);
      if (!e || !allow(e.type)) continue;
      var t = stamp(get(raw[i], 'updatedAt'));
      e.updatedAt = t === t ? t : 0;
      var k = libraryItemKey(e), idx = at.get(k);
      if (idx === undefined) { at.set(k, out.length); out.push(e); }
      else if (e.updatedAt > out[idx].updatedAt) out[idx] = e;
    }
    return capByAge(out, max);
  }
  // The queue is positional: the front plays next, so a cap keeps the front rather than the newest.
  function normalizeQueue(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [], seen = new Set();
    for (var i = 0; i < raw.length && out.length < CAP.queue; i++) {
      var e = libraryCompactItem(raw[i]);
      if (!e || !hasOwn(PLAYABLE, e.type)) continue;
      var k = libraryItemKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  }
  function normalizeResume(raw) {
    var out = {};
    if (!isObj(raw)) return out;
    Object.keys(raw).forEach(function (k) {
      if (!KEY_RE.test(k) || k.length > MAX_KEY) return;
      var r = raw[k];
      var at = stamp(get(r, 'updatedAt'));
      var e = resumeEntry(get(r, 'position'), get(r, 'duration'), at === at ? at : 0);
      if (e) out[k] = e;
    });
    return capResume(out);
  }
  function normalizeSleep(raw) {
    var endsAt = stamp(get(raw, 'endsAt'));
    if (!(endsAt > 0)) return null;
    var startedAt = stamp(get(raw, 'startedAt'));
    if (!(startedAt <= endsAt)) startedAt = endsAt;
    var minutes = num(get(raw, 'minutes'));
    if (!(minutes > 0)) minutes = (endsAt - startedAt) / UTIL.MINUTE;
    return { startedAt: startedAt, endsAt: endsAt, minutes: Math.min(minutes, MAX_SLEEP_MIN) };
  }
  // Any JSON value → a valid library. There is one storage version so far; a future `v` migrates here, and
  // every older or hand-edited shape is covered by "missing or wrong → default, oversize → capped".
  function normalize(raw) {
    if (!isObj(raw)) return libraryEmpty();
    var at = stamp(get(raw, 'updatedAt'));
    return {
      v: VERSION,
      favourites: normalizeStamped(get(raw, 'favourites'), CAP.favourites, function (t) { return hasOwn(TYPES, t); }),
      recents: normalizeStamped(get(raw, 'recents'), CAP.recents, function (t) { return hasOwn(PLAYABLE, t); }),
      resume: normalizeResume(get(raw, 'resume')),
      subscriptions: normalizeStamped(get(raw, 'subscriptions'), CAP.subscriptions, function (t) { return t === 'show'; }),
      queue: normalizeQueue(get(raw, 'queue')),
      settings: normalizeSettings(get(raw, 'settings')).settings,
      sleep: normalizeSleep(get(raw, 'sleep')),
      updatedAt: at === at ? at : 0
    };
  }
  // Reducers trust a library that has the right containers (every library the engine hands out does) and
  // rebuild anything else, so a junk `lib` costs one normalisation rather than a throw.
  function isLib(x) {
    return isObj(x) && Array.isArray(x.favourites) && Array.isArray(x.recents) && isObj(x.resume) &&
      Array.isArray(x.subscriptions) && Array.isArray(x.queue) && isObj(x.settings) && hasOwn(x, 'sleep') && UTIL.isNum(x.updatedAt);
  }
  function asLib(lib) { return isLib(lib) ? lib : normalize(lib); }
  // Every change produces a new library object; the input is never touched. Keys are written in one fixed
  // order so two libraries with the same content serialise identically.
  function touch(lib, patch, at) {
    var out = {};
    LIB_KEYS.forEach(function (k) { out[k] = hasOwn(patch, k) ? patch[k] : lib[k]; });
    out.v = VERSION;
    out.updatedAt = at;
    return out;
  }

  /* ---------- favourites ---------- */
  function isFavourite(lib, item) {
    lib = asLib(lib);
    var key = libraryItemKey(item);
    return key !== null && indexOfKey(lib.favourites, key) !== -1;
  }
  function toggleFavourite(lib, item, now) {
    lib = asLib(lib);
    var key = libraryItemKey(item);
    if (!key) return lib;
    var at = stampOf(now, lib);
    if (indexOfKey(lib.favourites, key) !== -1) return touch(lib, { favourites: without(lib.favourites, key) }, at);
    var entry = entryOf(item, at);
    if (!entry) return lib;
    return touch(lib, { favourites: capByAge([entry].concat(lib.favourites), CAP.favourites) }, at);
  }

  /* ---------- recents and resume ---------- */
  function recordPlay(lib, item, now) {
    lib = asLib(lib);
    var at = stampOf(now, lib);
    var entry = entryOf(item, at);
    if (!entry || !hasOwn(PLAYABLE, entry.type)) return lib;
    var rest = without(lib.recents, libraryItemKey(entry));
    return touch(lib, { recents: capByAge([entry].concat(rest), CAP.recents) }, at);
  }
  function setResume(lib, key, position, duration, now) {
    lib = asLib(lib);
    key = libraryItemKey(key);
    if (!key) return lib;
    var at = stampOf(now, lib);
    var entry = resumeEntry(position, duration, at);
    if (!entry) return lib;
    var resume = cloneResume(lib.resume);
    resume[key] = entry;
    return touch(lib, { resume: capResume(resume) }, at);
  }
  function getResume(lib, key) {
    lib = asLib(lib);
    key = libraryItemKey(key);
    if (!key || !hasOwn(lib.resume, key)) return null;
    var r = lib.resume[key];
    return isObj(r) ? { position: r.position, duration: r.duration, finished: r.finished === true, updatedAt: r.updatedAt } : null;
  }
  function clearResume(lib, key, now) {
    lib = asLib(lib);
    key = libraryItemKey(key);
    if (!key || !hasOwn(lib.resume, key)) return lib;
    var resume = cloneResume(lib.resume);
    delete resume[key];
    return touch(lib, { resume: resume }, stampOf(now, lib));
  }
  // Unfinished podcast episodes the listener has started, most recently listened first, each carrying its
  // resume data. Recents supply the item data; an episode that has fallen out of recents is no longer "recent".
  function continueListening(lib) {
    lib = asLib(lib);
    var found = [];
    lib.recents.forEach(function (e, i) {
      if (get(e, 'type') !== 'podcast') return;
      var key = libraryItemKey(e);
      var r = key && hasOwn(lib.resume, key) ? lib.resume[key] : null;
      if (!isObj(r) || r.finished === true) return;
      found.push({ item: e, resume: r, i: i });
    });
    found.sort(function (a, b) { return (b.resume.updatedAt - a.resume.updatedAt) || (a.i - b.i); });
    return found.map(function (f) {
      var out = {};
      Object.keys(f.item).forEach(function (k) { out[k] = f.item[k]; });
      out.resume = { position: f.resume.position, duration: f.resume.duration, finished: false, updatedAt: f.resume.updatedAt };
      return out;
    });
  }

  /* ---------- subscriptions ---------- */
  function isSubscribed(lib, show) {
    lib = asLib(lib);
    var key = showKeyOf(show);
    return key !== null && indexOfKey(lib.subscriptions, key) !== -1;
  }
  function subscribe(lib, show, now) {
    lib = asLib(lib);
    // An episode subscribes its show; a parsed feed or OPML row ({title, feedUrl}) is a show without a type.
    var src = get(show, 'type') === 'podcast' && isObj(get(show, 'show')) ? get(show, 'show') : show;
    if (!isObj(src)) return lib;
    var plain = {};
    Object.keys(src).forEach(function (k) { if (k !== '__proto__') plain[k] = src[k]; });
    plain.type = 'show';
    var at = stampOf(now, lib);
    var entry = entryOf(plain, at);
    if (!entry || indexOfKey(lib.subscriptions, libraryItemKey(entry)) !== -1) return lib;
    return touch(lib, { subscriptions: capByAge([entry].concat(lib.subscriptions), CAP.subscriptions) }, at);
  }
  function unsubscribe(lib, show, now) {
    lib = asLib(lib);
    var key = showKeyOf(show);
    if (!key || indexOfKey(lib.subscriptions, key) === -1) return lib;
    return touch(lib, { subscriptions: without(lib.subscriptions, key) }, stampOf(now, lib));
  }
  // Refresh a subscription's metadata from a fetched feed. The feed URL and type are pinned (they are the
  // identity) and the entry keeps its subscribed-at stamp, so a refresh never changes eviction order.
  function updateShow(lib, feedUrl, patch, now) {
    lib = asLib(lib);
    var key = showKeyOf(feedUrl);
    if (!key || !isObj(patch)) return lib;
    var idx = indexOfKey(lib.subscriptions, key);
    if (idx === -1) return lib;
    var cur = lib.subscriptions[idx], merged = {};
    Object.keys(cur).forEach(function (k) { merged[k] = cur[k]; });
    Object.keys(patch).forEach(function (k) { if (k !== '__proto__') merged[k] = patch[k]; });
    merged.type = 'show';
    merged.feedUrl = cur.feedUrl;
    var next = entryOf(merged, cur.updatedAt);
    if (!next || sameJson(next, cur)) return lib;
    var subs = lib.subscriptions.slice();
    subs[idx] = next;
    return touch(lib, { subscriptions: subs }, stampOf(now, lib));
  }

  /* ---------- queue ---------- */
  // A full queue ignores the add: the front is what plays next, so evicting it would lose the one item the
  // listener is about to hear, and evicting the back would drop something they just added.
  function queueAdd(lib, item, now) {
    lib = asLib(lib);
    var entry = libraryCompactItem(item);
    if (!entry || !hasOwn(PLAYABLE, entry.type)) return lib;
    if (indexOfKey(lib.queue, libraryItemKey(entry)) !== -1 || lib.queue.length >= CAP.queue) return lib;
    return touch(lib, { queue: lib.queue.concat([entry]) }, stampOf(now, lib));
  }
  function queueRemove(lib, key, now) {
    lib = asLib(lib);
    key = libraryItemKey(key);
    if (!key || indexOfKey(lib.queue, key) === -1) return lib;
    return touch(lib, { queue: without(lib.queue, key) }, stampOf(now, lib));
  }
  function queueMove(lib, from, to, now) {
    lib = asLib(lib);
    var a = num(from), b = num(to), n = lib.queue.length;
    if (!(a >= 0 && a < n && b >= 0 && b < n) || a !== Math.trunc(a) || b !== Math.trunc(b) || a === b) return lib;
    var q = lib.queue.slice();
    q.splice(b, 0, q.splice(a, 1)[0]);
    return touch(lib, { queue: q }, stampOf(now, lib));
  }
  function queueShift(lib, now) {
    lib = asLib(lib);
    if (!lib.queue.length) return { lib: lib, item: null };
    return { lib: touch(lib, { queue: lib.queue.slice(1) }, stampOf(now, lib)), item: lib.queue[0] };
  }
  function queueClear(lib, now) {
    lib = asLib(lib);
    return lib.queue.length ? touch(lib, { queue: [] }, stampOf(now, lib)) : lib;
  }

  /* ---------- settings ---------- */
  function setSetting(lib, key, value, now) {
    lib = asLib(lib);
    var v = validSetting(key, value);
    if (v === undefined || get(lib.settings, key) === v) return lib;
    var patch = {};
    patch[key] = v;
    return touch(lib, { settings: settingsWith(lib.settings, patch) }, stampOf(now, lib));
  }

  /* ---------- sleep timer ---------- */
  function startSleep(lib, minutes, now) {
    lib = asLib(lib);
    var at = stamp(now), m = num(minutes);
    if (!(at === at) || !(m > 0)) return lib;
    m = Math.min(m, MAX_SLEEP_MIN);
    return touch(lib, { sleep: { startedAt: at, endsAt: at + Math.round(m * UTIL.MINUTE), minutes: m } }, at);
  }
  function sleepRemaining(lib, now) {
    if (!isObj(lib) || !isObj(lib.sleep)) return null;
    var at = stamp(now), endsAt = stamp(lib.sleep.endsAt);
    if (!(at === at) || !(endsAt === endsAt)) return null;
    // Ceil, so the only moment that reads 0 is at or after the deadline itself.
    return Math.max(0, Math.ceil((endsAt - at) / UTIL.SECOND));
  }
  function sleepExpired(lib, now) { return sleepRemaining(lib, now) === 0; }
  function cancelSleep(lib, now) {
    lib = asLib(lib);
    return lib.sleep === null || lib.sleep === undefined ? lib : touch(lib, { sleep: null }, stampOf(now, lib));
  }

  /* ---------- persistence ---------- */
  // Always writes a normalised library: whatever is on disk is readable, bounded and free of junk.
  function librarySerialize(lib) { return JSON.stringify(normalize(lib)); }
  function libraryDeserialize(json) { return normalize(typeof json === 'string' ? UTIL.safeJsonParse(json, null) : json); }
  // A portable snapshot: the sleep timer is a moment on one device and does not travel.
  function libraryExport(lib) {
    var n = normalize(lib);
    return { app: 'aerial', v: VERSION, updatedAt: n.updatedAt, favourites: n.favourites, recents: n.recents, resume: n.resume, subscriptions: n.subscriptions, queue: n.queue, settings: n.settings };
  }
  // Union by key; where both sides hold a key, the newer stamp wins (ties keep the local copy). The result is
  // re-ordered newest-first because two devices' lists interleave.
  function mergeStamped(local, incoming, max) {
    var byKey = new Map();
    local.forEach(function (e) { byKey.set(libraryItemKey(e), e); });
    incoming.forEach(function (e) {
      var k = libraryItemKey(e), cur = byKey.get(k);
      if (!cur || e.updatedAt > cur.updatedAt) byKey.set(k, e);
    });
    var merged = UTIL.stableSort(Array.from(byKey.values()), function (a, b) { return b.updatedAt - a.updatedAt; });
    return capByAge(merged, max);
  }
  function mergeResume(local, incoming) {
    var out = cloneResume(local);
    Object.keys(incoming).forEach(function (k) {
      if (!hasOwn(out, k) || incoming[k].updatedAt > out[k].updatedAt) out[k] = incoming[k];
    });
    return capResume(out);
  }
  function mergeQueue(local, incoming) {
    var out = local.slice();
    incoming.forEach(function (e) {
      if (out.length < CAP.queue && indexOfKey(out, libraryItemKey(e)) === -1) out.push(e);
    });
    return out;
  }
  function libraryImport(lib, incoming, now) {
    lib = asLib(lib);
    var raw = typeof incoming === 'string' ? UTIL.safeJsonParse(incoming, null) : incoming;
    if (!isObj(raw)) return lib;
    var inc = normalize(raw);
    var merged = {
      favourites: mergeStamped(lib.favourites, inc.favourites, CAP.favourites),
      recents: mergeStamped(lib.recents, inc.recents, CAP.recents),
      resume: mergeResume(lib.resume, inc.resume),
      subscriptions: mergeStamped(lib.subscriptions, inc.subscriptions, CAP.subscriptions),
      queue: mergeQueue(lib.queue, inc.queue),
      // Settings are personal: only a value the snapshot explicitly and validly carries replaces this device's.
      settings: settingsWith(lib.settings, normalizeSettings(get(raw, 'settings')).explicit)
    };
    var changed = Object.keys(merged).some(function (k) { return !sameJson(merged[k], lib[k]); });
    return changed ? touch(lib, merged, stampOf(now, lib)) : lib;
  }

  /* ---------- lock screen, sharing, stats ---------- */
  function artworkOf(src) {
    return src ? [{ src: src, sizes: '', type: IMAGE_MIME[UTIL.extOf(src)] || '' }] : [];
  }
  function joinParts(parts, sep) { return parts.filter(Boolean).join(sep); }
  // What the lock screen and notification show. Always a complete object: the UI hands it straight to MediaMetadata.
  function mediaSessionMetadata(item, show) {
    var sh = isObj(show) ? show : get(item, 'show');
    var type = get(item, 'type'), host = UTIL.urlHost(str(get(item, 'url')));
    var title, artist, album, art;
    if (type === 'radio') {
      title = text(get(item, 'name')) || text(get(item, 'title')) || host;
      artist = joinParts([text(get(item, 'country')), tagsOf(get(item, 'tags')).slice(0, 3).join(', ')], ' · ');
      album = 'Aerial radio';
      art = httpUrl(get(item, 'favicon')) || httpUrl(get(item, 'image'));
    } else if (type === 'podcast') {
      title = text(get(item, 'title')) || text(get(item, 'name'));
      artist = text(get(sh, 'title')) || text(get(item, 'author')) || 'Podcast';
      album = text(get(item, 'author')) || text(get(sh, 'author')) || 'Aerial podcasts';
      art = httpUrl(get(item, 'image')) || httpUrl(get(sh, 'image'));
    } else if (type === 'show') {
      title = text(get(item, 'title')) || text(get(item, 'name'));
      artist = text(get(item, 'author'));
      album = 'Aerial podcasts';
      art = httpUrl(get(item, 'image'));
    } else {
      title = text(get(item, 'title')) || text(get(item, 'name')) || host;
      artist = host;
      album = 'Aerial';
      art = httpUrl(get(item, 'image')) || httpUrl(get(item, 'favicon'));
    }
    return { title: title || 'Aerial', artist: artist, album: album, artwork: artworkOf(art) };
  }
  function shareLink(item, baseUrl) {
    if (!isObj(item)) return null;
    var type = get(item, 'type');
    var url = type === 'show' ? httpUrl(get(item, 'feedUrl')) : httpUrl(get(item, 'url'));
    if (!url) return null;
    var base = str(baseUrl).trim();
    var hash = base.indexOf('#');
    if (hash !== -1) base = base.slice(0, hash);
    var parts = ['play=' + enc(url)];
    var title = cap(text(get(item, 'name')) || text(get(item, 'title')), MAX_SHARE_TITLE);
    if (title) parts.push('title=' + enc(title));
    if (hasOwn(TYPES, type)) parts.push('type=' + type);
    return base + '#' + parts.join('&');
  }
  // The first occurrence of each parameter decides, valid or not, so a second `play` smuggled in behind a
  // junk one cannot become the stream. Only http(s) may play: javascript:, data: and friends yield null.
  function parseShareHash(hash) {
    if (typeof hash !== 'string' || hash.length > MAX_HASH) return null;
    var h = hash, i = h.indexOf('#');
    if (i !== -1) h = h.slice(i + 1);
    var out = { url: null, title: '', type: null }, seen = {};
    h.split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      var k = dec(eq === -1 ? pair : pair.slice(0, eq)).trim();
      var v = eq === -1 ? '' : dec(pair.slice(eq + 1));
      if (k !== 'play' && k !== 'title' && k !== 'type') return;
      if (hasOwn(seen, k)) return;
      seen[k] = true;
      if (k === 'play') out.url = httpUrl(v) || null;
      else if (k === 'title') out.title = cap(text(v), MAX_SHARE_TITLE);
      else out.type = hasOwn(TYPES, v) ? v : null;
    });
    return out.url ? out : null;
  }
  function libraryStats(lib) {
    lib = asLib(lib);
    var byType = { radio: 0, podcast: 0, video: 0, show: 0 };
    lib.favourites.forEach(function (e) { var t = get(e, 'type'); if (hasOwn(byType, t)) byType[t]++; });
    var keys = Object.keys(lib.resume), finished = 0;
    keys.forEach(function (k) { if (isObj(lib.resume[k]) && lib.resume[k].finished === true) finished++; });
    return {
      favourites: lib.favourites.length, favouritesByType: byType, recents: lib.recents.length,
      subscriptions: lib.subscriptions.length, queue: lib.queue.length,
      resume: keys.length, inProgress: keys.length - finished, finished: finished
    };
  }

  return {
    LIBRARY_VERSION: VERSION, LIBRARY_CAPS: CAP,
    libraryEmpty: libraryEmpty, libraryItemKey: libraryItemKey, libraryCompactItem: libraryCompactItem,
    toggleFavourite: toggleFavourite, isFavourite: isFavourite, recordPlay: recordPlay,
    setResume: setResume, getResume: getResume, clearResume: clearResume, continueListening: continueListening,
    subscribe: subscribe, unsubscribe: unsubscribe, isSubscribed: isSubscribed, updateShow: updateShow,
    queueAdd: queueAdd, queueRemove: queueRemove, queueMove: queueMove, queueShift: queueShift, queueClear: queueClear,
    setSetting: setSetting, startSleep: startSleep, sleepRemaining: sleepRemaining, cancelSleep: cancelSleep, sleepExpired: sleepExpired,
    librarySerialize: librarySerialize, libraryDeserialize: libraryDeserialize, libraryExport: libraryExport, libraryImport: libraryImport,
    mediaSessionMetadata: mediaSessionMetadata, shareLink: shareLink, parseShareHash: parseShareHash, libraryStats: libraryStats
  };
})();
