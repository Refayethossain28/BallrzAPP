/* ===== RADIO: Radio Browser directory queries + station normalisation, ranking and rules ===== */
var RADIO = (function () {
  'use strict';

  // Public mirrors of the community directory. The API recommends discovering mirrors through DNS SRV,
  // which a browser cannot do, so the UI walks this fixed list and fails over on error. The 'all.' alias is
  // DNS round-robin over the same mirrors and goes last, as a final shot once every named mirror failed.
  var RADIO_SERVERS = [
    'https://de1.api.radio-browser.info',
    'https://de2.api.radio-browser.info',
    'https://fi1.api.radio-browser.info',
    'https://at1.api.radio-browser.info',
    'https://nl1.api.radio-browser.info',
    'https://all.api.radio-browser.info'
  ];
  // The directory counts at most one click per station per listener in a 10-minute window, so reporting
  // more often is wasted traffic (and a flapping stream must not inflate a station's click count).
  var RADIO_CLICK_INTERVAL = 10 * UTIL.MINUTE;
  var DEFAULT_LIMIT = 50;
  var MAX_LIMIT = 1000;      // far more than a phone list shows; keeps a junk limit from asking for the whole directory
  var MAX_NAME = 200;        // names arrive padded and occasionally stuffed; one station must not blow up a list row
  var MAX_TAGS = 40;
  var MAX_UUIDS = 100;       // byuuid is a GET; keep the URL well under common 2k limits
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // Every `order` the search endpoint accepts → whether "bigger is better", i.e. the default for `reverse`.
  var ORDERS = {
    name: false, url: false, homepage: false, favicon: false, tags: false, country: false, state: false, language: false,
    codec: false, random: false,
    votes: true, bitrate: true, lastcheckok: true, lastchecktime: true, clicktimestamp: true, clickcount: true,
    clicktrend: true, changetimestamp: true
  };

  /* ---------- input coercion: the API sends numbers as strings in places, and callers send anything ---------- */
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v)) ? String(v) : ''; }
  function text(v, max) { return UTIL.collapseWs(str(v)).slice(0, max || MAX_NAME); }
  function num(v, dflt) {
    if (typeof v === 'string') v = v.trim() === '' ? NaN : Number(v);
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  }
  function int(v, dflt) { var n = num(v, NaN); return n === n ? (Math.trunc(n) || 0) : dflt; }
  function flag(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
  function boolOrNull(v) { return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null; }
  function first(a, b) { return a !== undefined && a !== null ? a : b; }
  // "a, B ,,c" or ['a','B'] → ['a','b','c']: lowercased, trimmed, empties dropped, unique, capped.
  function splitList(v, max) {
    var parts = Array.isArray(v) ? v.map(str) : str(v).split(',');
    return UTIL.uniq(parts.map(function (p) { return text(p, 60).toLowerCase(); }).filter(Boolean)).slice(0, max || MAX_TAGS);
  }
  function httpUrl(v) { v = str(v).trim(); return UTIL.isHttpUrl(v) ? v : ''; }
  function clampLimit(v, dflt) { return UTIL.clamp(int(v, dflt || DEFAULT_LIMIT), 1, MAX_LIMIT); }
  function uuidOf(v) { v = str(v).trim().toLowerCase(); return UUID_RE.test(v) ? v : ''; }

  /* ---------- URL builders ---------- */
  // encodeURIComponent throws on a lone surrogate (a truncated emoji from a sloppy paste); swap those for
  // U+FFFD so a query string is always produced.
  function wellFormed(s) {
    var out = '', i, c, d;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (d >= 0xdc00 && d <= 0xdfff) { out += s.charAt(i) + s.charAt(i + 1); i++; }
        else out += '�';
      } else if (c >= 0xdc00 && c <= 0xdfff) out += '�';
      else out += s.charAt(i);
    }
    return out;
  }
  function enc(s) { return encodeURIComponent(wellFormed(String(s))); }
  // One query value as the API wants it, or null to leave the parameter out entirely (the API treats a
  // present-but-empty parameter as a filter for the empty string, which matches nothing).
  function paramValue(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return isFinite(v) ? String(v) : null;
    if (typeof v === 'string') return v === '' ? null : v;
    if (Array.isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) {
        var p = Array.isArray(v[i]) ? null : paramValue(v[i]);
        if (p !== null) parts.push(p);
      }
      return parts.length ? parts.join(',') : null;
    }
    return null;
  }
  function serverBase(server) {
    var s = str(server).trim().replace(/\/+$/, '');
    return UTIL.isHttpUrl(s) ? s : RADIO_SERVERS[0];
  }
  function radioUrl(server, path, params) {
    var p = str(path).trim().split(/[?#]/)[0];
    if (p.charAt(0) !== '/') p = '/' + p;
    var qs = [];
    if (isObj(params)) {
      Object.keys(params).forEach(function (k) {
        var v = paramValue(params[k]);
        if (k !== '' && v !== null) qs.push(enc(k) + '=' + enc(v));
      });
    }
    return serverBase(server) + p + (qs.length ? '?' + qs.join('&') : '');
  }
  function radioNextServer(i) {
    var n = int(i, -1);
    return n < 0 || n >= RADIO_SERVERS.length - 1 ? 0 : n + 1;
  }
  function radioSearchUrl(server, q) {
    q = isObj(q) ? q : {};
    var order = text(q.order).toLowerCase();
    if (!ORDERS.hasOwnProperty(order)) order = 'votes';
    var cc = text(q.countrycode, 8).toUpperCase();
    var offset = int(q.offset, 0), bitrateMin = int(q.bitrateMin, 0), bitrateMax = int(q.bitrateMax, 0);
    var hideBroken = boolOrNull(q.hideBroken);
    // Parameter order is fixed so the same query always yields the same URL (cache keys, tests).
    return radioUrl(server, '/json/stations/search', {
      name: text(q.name) || null,
      nameExact: boolOrNull(q.nameExact),
      tag: text(q.tag, 60).toLowerCase() || null,
      tagExact: boolOrNull(q.tagExact),
      tagList: splitList(q.tagList),
      country: text(q.country, 80) || null,
      countryExact: boolOrNull(q.countryExact),
      countrycode: /^[A-Z]{2}$/.test(cc) ? cc : null,
      state: text(q.state, 80) || null,
      language: text(q.language, 60).toLowerCase() || null,
      languageExact: boolOrNull(q.languageExact),
      codec: text(q.codec, 16).toUpperCase() || null,
      bitrateMin: bitrateMin > 0 ? bitrateMin : null,
      bitrateMax: bitrateMax > 0 ? bitrateMax : null,
      has_geo_info: boolOrNull(q.hasGeo),
      is_https: boolOrNull(q.isHttps),
      order: order,
      reverse: typeof q.reverse === 'boolean' ? q.reverse : ORDERS[order],
      offset: offset > 0 ? offset : null,
      limit: clampLimit(q.limit),
      hidebroken: hideBroken === null ? true : hideBroken
    });
  }
  function radioTopUrl(server, kind, limit) {
    var n = clampLimit(limit);
    kind = text(kind, 16).toLowerCase();
    // There is no "trending" list endpoint; a search ordered by click trend is the documented equivalent.
    if (kind === 'trend') return radioSearchUrl(server, { order: 'clicktrend', reverse: true, limit: n });
    return radioUrl(server, '/json/stations/' + (kind === 'clicks' ? 'topclick' : 'topvote') + '/' + n, { hidebroken: true });
  }
  function radioTagsUrl(server, opts) {
    opts = isObj(opts) ? opts : {};
    var order = text(opts.order, 16).toLowerCase() === 'name' ? 'name' : 'stationcount';
    return radioUrl(server, '/json/tags', { order: order, reverse: order === 'stationcount', limit: clampLimit(opts.limit, 100), hidebroken: true });
  }
  function radioCountriesUrl(server) { return radioUrl(server, '/json/countries', { order: 'stationcount', reverse: true, hidebroken: true }); }
  function radioLanguagesUrl(server) { return radioUrl(server, '/json/languages', { order: 'stationcount', reverse: true, hidebroken: true }); }
  // Click and vote take a path segment, so only a real UUID may go there (a built-in 'starter:' id or any
  // other junk yields null and the UI simply does not report).
  function radioClickUrl(server, uuid) { var u = uuidOf(uuid); return u ? radioUrl(server, '/json/url/' + u) : null; }
  function radioVoteUrl(server, uuid) { var u = uuidOf(uuid); return u ? radioUrl(server, '/json/vote/' + u) : null; }
  function radioByUuidUrl(server, uuids) {
    var ids = UTIL.uniq((Array.isArray(uuids) ? uuids : [uuids]).map(uuidOf).filter(Boolean)).slice(0, MAX_UUIDS);
    return ids.length ? radioUrl(server, '/json/stations/byuuid', { uuids: ids }) : null;
  }

  /* ---------- station normalisation ---------- */
  // Accepts a raw directory record or an already-normalised station (library items get re-normalised when
  // they come back from storage), so every field is read under both names.
  function radioNormalizeStation(raw) {
    if (!isObj(raw)) return null;
    var id = text(raw.stationuuid, 80) || text(raw.id, 80);
    // url_resolved is the stream the directory's checker actually reached after following any .pls/.m3u
    // redirect, so it is the one most likely to play; fall back to the listed url when it is missing or junk.
    var url = httpUrl(raw.url_resolved) || httpUrl(raw.url);
    if (!id || !url) return null;
    var codec = text(raw.codec, 16).toUpperCase() || 'UNKNOWN';
    var language = text(first(raw.language, ''), 120).toLowerCase();
    var lat = num(raw.geo_lat, NaN), lon = num(raw.geo_long, NaN);
    var geoKnown = lat === lat && lon === lon && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
    if (!geoKnown && isObj(raw.geo)) {
      lat = num(raw.geo.lat, NaN); lon = num(raw.geo.lon, NaN);
      geoKnown = lat === lat && lon === lon && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
    }
    return {
      type: 'radio',
      id: id,
      name: text(raw.name) || UTIL.urlHost(url) || 'Unknown station',
      url: url,
      homepage: httpUrl(raw.homepage),
      favicon: httpUrl(raw.favicon),
      tags: splitList(raw.tags),
      country: text(raw.country, 80),
      countryCode: text(first(raw.countrycode, raw.countryCode), 8).toUpperCase(),
      state: text(raw.state, 80),
      language: language,
      languages: Array.isArray(raw.languages) ? splitList(raw.languages, 10) : splitList(language, 10),
      codec: codec,
      bitrate: Math.max(0, int(raw.bitrate, 0)),
      votes: Math.max(0, int(raw.votes, 0)),
      clicks: Math.max(0, int(first(raw.clickcount, raw.clicks), 0)),
      clickTrend: int(first(raw.clicktrend, raw.clickTrend), 0),
      https: UTIL.isHttps(url),
      hls: flag(raw.hls) || codec === 'HLS' || UTIL.classifyMedia(url).kind === 'hls',
      ok: flag(first(raw.lastcheckok, raw.ok)),
      sslError: flag(first(raw.ssl_error, raw.sslError)),
      geo: geoKnown ? { lat: lat, lon: lon } : null
    };
  }
  function dedupeKey(st) { return text(st.name).toLowerCase() + '|' + UTIL.urlHost(str(st.url)); }
  // The directory lists the same station many times (http and https mounts, re-submissions with different
  // casing); the most-voted copy is the one listeners actually use. Equal votes → prefer the https copy, which
  // is the only one an https page can play at all; otherwise the earlier entry stays.
  function betterCopy(a, b) {
    var va = Math.max(0, int(a.votes, 0)), vb = Math.max(0, int(b.votes, 0));
    if (va !== vb) return va > vb;
    return UTIL.isHttps(str(a.url)) && !UTIL.isHttps(str(b.url));
  }
  function radioDedupe(list) {
    if (!Array.isArray(list)) return [];
    var slot = new Map(), out = [];
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      if (!isObj(st)) continue;
      var key = dedupeKey(st), at = slot.get(key);
      if (at === undefined) { slot.set(key, out.length); out.push(st); }
      else if (betterCopy(st, out[at])) out[at] = st;
    }
    return out;
  }
  // Votes are the directory's durable popularity signal; clicks are noisier (one listener, many sessions) so
  // they weigh a tenth; a click trend is the week-over-week delta and small, so it is scaled up to surface
  // what is rising right now. Rounded so float noise (0.1 * 30 ≠ 3 exactly) cannot break ties.
  function score(st) { return UTIL.round(Math.max(0, num(st.votes, 0)) + 0.1 * Math.max(0, num(st.clicks, 0)) + 50 * num(st.clickTrend, 0), 6); }
  function cmpText(a, b) { return a === b ? 0 : a < b ? -1 : 1; }
  function radioRank(list) {
    if (!Array.isArray(list)) return [];
    return UTIL.stableSort(list.filter(isObj), function (a, b) {
      return (score(b) - score(a))
        || cmpText(text(a.name).toLowerCase(), text(b.name).toLowerCase())
        || cmpText(str(a.id), str(b.id));
    });
  }
  function radioNormalizeList(rawArray) {
    if (!Array.isArray(rawArray)) return [];
    return radioRank(radioDedupe(rawArray.map(radioNormalizeStation).filter(Boolean)));
  }
  // Expects normalised stations. A bitrate of 0 means "unknown": it fails a minimum (the listener asked for a
  // quality floor, and an unknown stream cannot promise it) but passes a maximum (data saver should not hide
  // half the directory). Codec entries match as prefixes so 'AAC' also keeps 'AAC+'.
  function radioFilter(list, opts) {
    if (!Array.isArray(list)) return [];
    opts = isObj(opts) ? opts : {};
    var minBr = Math.max(0, num(opts.minBitrate, 0)), maxBr = Math.max(0, num(opts.maxBitrate, 0));
    var codecs = splitList(opts.codecs, 16).map(function (c) { return c.toUpperCase(); });
    return list.filter(function (st) {
      if (!isObj(st)) return false;
      if (opts.httpsOnly && !UTIL.isHttps(str(st.url))) return false;
      if (opts.onlineOnly && !st.ok) return false;
      var br = Math.max(0, int(st.bitrate, 0));
      if (minBr > 0 && br < minBr) return false;
      if (maxBr > 0 && br > maxBr) return false;
      if (codecs.length) {
        var codec = text(st.codec, 16).toUpperCase();
        if (!codecs.some(function (c) { return codec.indexOf(c) === 0; })) return false;
      }
      return true;
    });
  }
  function radioStreamKind(st) {
    if (!isObj(st)) return 'direct';
    return flag(st.hls) || UTIL.classifyMedia(str(st.url)).kind === 'hls' ? 'hls' : 'direct';
  }
  function radioBadge(st) {
    if (!isObj(st)) return '';
    if (radioStreamKind(st) === 'hls') return 'HLS';
    var parts = [], br = int(st.bitrate, 0), codec = text(st.codec, 16).toUpperCase();
    if (br > 0) parts.push(br + 'k');
    if (codec && codec !== 'UNKNOWN') parts.push(codec);
    return parts.join(' ');
  }
  // Never clicked → allowed; otherwise only once the interval has passed. An unknown clock means we cannot
  // tell, and a click we cannot justify is better skipped than sent.
  function radioClickAllowed(lastClickTs, now) {
    var last = num(lastClickTs, NaN);
    if (last !== last) return true;
    var t = num(now, NaN);
    return t === t && t - last >= RADIO_CLICK_INTERVAL;
  }

  /* ---------- curated browse lists ---------- */
  // Tags are the directory's own most-used spellings (lowercase, spaces); aliases are what people type.
  function genre(tag, label, emoji, aliases) { return { tag: tag, label: label, emoji: emoji, aliases: aliases || [] }; }
  var RADIO_GENRES = [
    genre('pop', 'Pop', '🎤'),
    genre('rock', 'Rock', '🎸'),
    genre('jazz', 'Jazz', '🎷'),
    genre('classical', 'Classical', '🎻'),
    genre('news', 'News', '📰'),
    genre('talk', 'Talk', '🎙️'),
    genre('sports', 'Sports', '⚽', ['sport']),
    genre('hip hop', 'Hip hop', '🧢', ['hiphop', 'hip-hop', 'rap']),
    genre('electronic', 'Electronic', '🎛️', ['electro', 'electronica']),
    genre('dance', 'Dance', '💃', ['edm']),
    genre('house', 'House', '🏠'),
    genre('techno', 'Techno', '🤖'),
    genre('lofi', 'Lo-fi', '🎧', ['lo-fi', 'lo fi', 'lofi hip hop']),
    genre('chillout', 'Chillout', '🌙', ['chill', 'chill out', 'downtempo']),
    genre('ambient', 'Ambient', '🌌'),
    genre('lounge', 'Lounge', '🍸'),
    genre('country', 'Country', '🤠'),
    genre('latin', 'Latin', '🌶️', ['latino', 'latina']),
    genre('reggae', 'Reggae', '🌴'),
    genre('metal', 'Metal', '🤘', ['heavy metal']),
    genre('blues', 'Blues', '🎺'),
    genre('soul', 'Soul', '❤️', ['rnb', 'r&b']),
    genre('folk', 'Folk', '🪕'),
    genre('kids', 'Kids', '🧸', ['children']),
    genre('world music', 'World', '🌍', ['world']),
    genre('80s', '80s', '📼', ['eighties', '1980s']),
    genre('oldies', 'Oldies', '📻'),
    genre('christian', 'Christian', '✝️', ['gospel']),
    genre('top 40', 'Top 40', '🔝', ['top40', 'hits', 'charts'])
  ];
  // Two regional-indicator letters render as the flag everywhere; deriving them from the code rules out typos.
  function flagOf(code) { return String.fromCodePoint(0x1f1e6 + code.charCodeAt(0) - 65, 0x1f1e6 + code.charCodeAt(1) - 65); }
  function country(code, name, aliases) { return { code: code, name: name, flag: flagOf(code), aliases: aliases || [] }; }
  var RADIO_COUNTRIES = [
    country('US', 'United States', ['usa', 'america', 'american', 'united states of america']),
    country('GB', 'United Kingdom', ['uk', 'britain', 'british', 'england', 'scotland', 'wales']),
    country('DE', 'Germany', ['deutschland', 'german']),
    country('FR', 'France', ['french']),
    country('ES', 'Spain', ['españa', 'espana', 'spanish']),
    country('IT', 'Italy', ['italia', 'italian']),
    country('NL', 'Netherlands', ['holland', 'dutch', 'the netherlands']),
    country('BE', 'Belgium', ['belgian']),
    country('CH', 'Switzerland', ['swiss', 'schweiz', 'suisse']),
    country('AT', 'Austria', ['österreich', 'osterreich', 'austrian']),
    country('SE', 'Sweden', ['sverige', 'swedish']),
    country('NO', 'Norway', ['norge', 'norwegian']),
    country('DK', 'Denmark', ['danmark', 'danish']),
    country('FI', 'Finland', ['suomi', 'finnish']),
    country('IE', 'Ireland', ['irish', 'eire']),
    country('PL', 'Poland', ['polska', 'polish']),
    country('CZ', 'Czechia', ['czech', 'czech republic']),
    country('HU', 'Hungary', ['hungarian', 'magyar']),
    country('PT', 'Portugal', ['portuguese']),
    country('GR', 'Greece', ['greek', 'hellas']),
    country('TR', 'Turkey', ['türkiye', 'turkiye', 'turkish']),
    country('RU', 'Russia', ['russian']),
    country('UA', 'Ukraine', ['ukrainian']),
    country('BR', 'Brazil', ['brasil', 'brazilian']),
    country('MX', 'Mexico', ['méxico', 'mexican']),
    country('AR', 'Argentina', ['argentine', 'argentinian']),
    country('CA', 'Canada', ['canadian']),
    country('AU', 'Australia', ['australian', 'aussie']),
    country('NZ', 'New Zealand', ['kiwi']),
    country('JP', 'Japan', ['japanese', 'nippon']),
    country('KR', 'South Korea', ['korea', 'korean']),
    country('CN', 'China', ['chinese']),
    country('IN', 'India', ['indian']),
    country('ZA', 'South Africa')
  ];
  // Built-in first-paint list: SomaFM's https Icecast mounts. These are the known public mounts as of 2026
  // (this sandbox cannot reach the internet to re-verify them); mounts move and ice1 is one of several
  // hosts, so the UI must treat any failure as an ordinary stream error, not a bug. No other provider is
  // bundled. Shape matches radioNormalizeStation so the same list/badge/filter code applies.
  function starter(channel, name, tags) {
    return {
      type: 'radio', id: 'starter:' + channel, name: name,
      url: 'https://ice1.somafm.com/' + channel + '-128-mp3', homepage: 'https://somafm.com/' + channel + '/', favicon: '',
      tags: tags, country: 'United States', countryCode: 'US', state: 'California', language: 'english', languages: ['english'],
      codec: 'MP3', bitrate: 128, votes: 0, clicks: 0, clickTrend: 0, https: true, hls: false, ok: true, sslError: false, geo: null,
      starter: true
    };
  }
  var RADIO_STARTER = [
    starter('groovesalad', 'SomaFM Groove Salad', ['ambient', 'downtempo', 'chillout', 'electronic']),
    starter('dronezone', 'SomaFM Drone Zone', ['ambient', 'drone', 'space', 'atmospheric']),
    starter('lush', 'SomaFM Lush', ['vocal', 'electronic', 'downtempo', 'chillout']),
    starter('secretagent', 'SomaFM Secret Agent', ['lounge', 'spy', 'jazz', 'downtempo']),
    starter('indiepop', 'SomaFM Indie Pop Rocks!', ['indie', 'pop', 'rock', 'alternative']),
    starter('deepspaceone', 'SomaFM Deep Space One', ['ambient', 'space', 'electronic', 'experimental']),
    starter('defcon', 'SomaFM DEF CON Radio', ['electronic', 'hacker', 'techno', 'industrial']),
    starter('beatblender', 'SomaFM Beat Blender', ['deep house', 'downtempo', 'electronic', 'chillout']),
    starter('spacestation', 'SomaFM Space Station Soma', ['ambient', 'electronic', 'space', 'mid-tempo']),
    starter('thetrip', 'SomaFM The Trip', ['progressive house', 'trance', 'electronic', 'dance']),
    starter('folkfwd', 'SomaFM Folk Forward', ['folk', 'indie', 'acoustic', 'alt-folk']),
    starter('bootliquor', 'SomaFM Boot Liquor', ['americana', 'country', 'roots', 'alt-country'])
  ];

  /* ---------- search planning ---------- */
  // phrase (lowercase, one or more words) → genre | country, built once; MAX_PHRASE is the longest phrase in
  // either index so the n-gram scan never tries lengths nothing could match. Codes live in their own index
  // because a bare two-letter code is only trusted when it is unambiguous (see codeMatch).
  var GENRE_INDEX = new Map(), COUNTRY_INDEX = new Map(), CODE_INDEX = new Map(), MAX_PHRASE = 1;
  function index(map, phrases, item) {
    phrases.forEach(function (p) {
      p = p.toLowerCase();
      if (!map.has(p)) map.set(p, item);
      MAX_PHRASE = Math.max(MAX_PHRASE, p.split(' ').length);
    });
  }
  RADIO_GENRES.forEach(function (g) { index(GENRE_INDEX, [g.tag, g.label].concat(g.aliases), g); });
  RADIO_COUNTRIES.forEach(function (c) { index(COUNTRY_INDEX, [c.name].concat(c.aliases), c); CODE_INDEX.set(c.code.toLowerCase(), c); });
  // Lowercase codes that are also everyday words ('jazz in paris', 'make it funky', 'radio de música'): those
  // count as a country only when typed in capitals; every other code ('nl', 'fr', 'jp') is taken as typed.
  var AMBIGUOUS_CODES = { in: 1, it: 1, at: 1, no: 1, be: 1, us: 1, de: 1, es: 1, se: 1, ie: 1 };
  function codeMatch(token) {
    var low = token.toLowerCase(), c = CODE_INDEX.get(low);
    if (!c) return null;
    return AMBIGUOUS_CODES[low] && token !== token.toUpperCase() ? null : c;
  }
  function radioSearchPlan(query) {
    var tokens = text(query, 200).split(/[\s,;]+/)
      .map(function (t) { return t.replace(/^["'(\[]+|["')\]]+$/g, ''); })
      .filter(Boolean);
    if (!tokens.length) return null;
    var rest = [], tags = [], found = null;
    for (var i = 0; i < tokens.length;) {
      var hit = null;
      // Longest phrase first, so 'hip hop' is one genre rather than 'hip' + 'hop', and 'new zealand' is a country.
      for (var n = Math.min(MAX_PHRASE, tokens.length - i); n >= 1 && !hit; n--) {
        var phrase = tokens.slice(i, i + n).join(' ').toLowerCase();
        var g = GENRE_INDEX.get(phrase);
        if (g) { hit = { n: n, tag: g.tag }; break; }
        var c = COUNTRY_INDEX.get(phrase) || (n === 1 ? codeMatch(tokens[i]) : null);
        // A second country cannot be queried (the API takes one), so it stays part of the name.
        if (c && !found) { hit = { n: n, country: c }; break; }
      }
      if (!hit) { rest.push(tokens[i]); i++; continue; }
      if (hit.tag) { if (tags.indexOf(hit.tag) === -1) tags.push(hit.tag); }
      else found = hit.country;
      i += hit.n;
    }
    return {
      name: rest.join(' '),
      tag: tags.length ? tags[0] : null,
      tags: tags,
      country: found ? found.name : null,
      countrycode: found ? found.code : null
    };
  }

  return {
    RADIO_SERVERS: RADIO_SERVERS, RADIO_CLICK_INTERVAL: RADIO_CLICK_INTERVAL,
    radioNextServer: radioNextServer, radioUrl: radioUrl, radioSearchUrl: radioSearchUrl, radioTopUrl: radioTopUrl,
    radioTagsUrl: radioTagsUrl, radioCountriesUrl: radioCountriesUrl, radioLanguagesUrl: radioLanguagesUrl,
    radioClickUrl: radioClickUrl, radioVoteUrl: radioVoteUrl, radioByUuidUrl: radioByUuidUrl,
    radioNormalizeStation: radioNormalizeStation, radioNormalizeList: radioNormalizeList,
    radioDedupe: radioDedupe, radioRank: radioRank, radioFilter: radioFilter,
    radioBadge: radioBadge, radioStreamKind: radioStreamKind, radioClickAllowed: radioClickAllowed,
    RADIO_GENRES: RADIO_GENRES, RADIO_COUNTRIES: RADIO_COUNTRIES, RADIO_STARTER: RADIO_STARTER,
    radioSearchPlan: radioSearchPlan
  };
})();
