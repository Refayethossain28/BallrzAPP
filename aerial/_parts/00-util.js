/* ===== UTIL: text, urls, media classification, formatting, bytes ===== */
var UTIL = (function () {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  /* ---------- hashing / seeded randomness ---------- */
  // FNV-1a 32-bit — stable across platforms, good spread for short strings.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }
  // One deterministic float in [0,1) from any seed string.
  function rand01(seed) {
    var h = hashStr(seed);
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  }

  /* ---------- numbers ---------- */
  function clamp(v, lo, hi) { v = +v; if (!(v === v)) v = lo; return v < lo ? lo : v > hi ? hi : v; }
  function round(n, dp) { var m = Math.pow(10, dp || 0); return Math.round((+n + Number.EPSILON) * m) / m; }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }

  /* ---------- text ---------- */
  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function truncate(text, n) {
    text = String(text == null ? '' : text);
    n = n || 120;
    if (text.length <= n) return text;
    var cut = text.slice(0, n - 1);
    var sp = cut.lastIndexOf(' ');
    if (sp > n * 0.6) cut = cut.slice(0, sp);
    return cut.replace(/[\s.,;:!?-]+$/, '') + '…';
  }
  function slug(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }
  function collapseWs(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  /* ---------- arrays ---------- */
  function uniq(arr) {
    var seen = new Map(), out = [];
    for (var i = 0; i < (arr || []).length; i++) {
      var k = typeof arr[i] === 'object' && arr[i] !== null ? JSON.stringify(arr[i]) : (typeof arr[i]) + ':' + String(arr[i]);
      if (!seen.has(k)) { seen.set(k, 1); out.push(arr[i]); }
    }
    return out;
  }
  // Stable sort (Array.prototype.sort is stable in modern engines, but keep the index tie-break explicit).
  function stableSort(arr, cmp) {
    return (arr || []).map(function (v, i) { return { v: v, i: i }; })
      .sort(function (a, b) { return cmp(a.v, b.v) || (a.i - b.i); })
      .map(function (x) { return x.v; });
  }
  function sortBy(arr, keyFn, desc) {
    return stableSort(arr, function (a, b) {
      var ka = keyFn(a), kb = keyFn(b);
      if (ka === kb) return 0;
      if (ka == null) return 1;
      if (kb == null) return -1;
      var r = ka < kb ? -1 : 1;
      return desc ? -r : r;
    });
  }

  /* ---------- URLs (pure, no URL constructor so it behaves the same everywhere) ---------- */
  var URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/([^\/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/;
  function splitUrl(u) {
    var m = URL_RE.exec(String(u == null ? '' : u).trim());
    if (!m) return null;
    return { scheme: m[1] || '', authority: m[2] ? (m[3] || '') : null, path: m[4] || '', query: m[5] || '', fragment: m[6] || '' };
  }
  function removeDotSegments(path) {
    var out = [], parts = path.split('/');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '.') { if (i === parts.length - 1) out.push(''); continue; }
      if (p === '..') { if (out.length > 1 || (out.length === 1 && out[0] !== '')) out.pop(); if (i === parts.length - 1) out.push(''); continue; }
      out.push(p);
    }
    return out.join('/');
  }
  function mergePath(basePath, hasAuthority, rel) {
    if (hasAuthority && basePath === '') return '/' + rel;
    var idx = basePath.lastIndexOf('/');
    return idx === -1 ? rel : basePath.slice(0, idx + 1) + rel;
  }
  // RFC 3986 §5.2 reference resolution. base must be absolute; returns rel unchanged if it is absolute.
  function resolveUrl(base, rel) {
    rel = String(rel == null ? '' : rel).trim();
    base = String(base == null ? '' : base).trim();
    var r = splitUrl(rel), b = splitUrl(base);
    if (!r) return rel;
    if (r.scheme) {
      return r.scheme + (r.authority !== null ? '//' + r.authority : '') + removeDotSegments(r.path) + r.query + r.fragment;
    }
    if (!b || !b.scheme) return rel;
    var scheme = b.scheme, authority, path, query;
    if (r.authority !== null) {
      authority = r.authority; path = removeDotSegments(r.path); query = r.query;
    } else {
      authority = b.authority;
      if (r.path === '') {
        path = b.path; query = r.query !== '' ? r.query : b.query;
      } else {
        path = r.path.charAt(0) === '/' ? removeDotSegments(r.path) : removeDotSegments(mergePath(b.path, b.authority !== null, r.path));
        query = r.query;
      }
    }
    return scheme + (authority !== null ? '//' + authority : '') + path + query + r.fragment;
  }
  function urlOrigin(url) {
    var p = splitUrl(url);
    if (!p || !p.scheme || p.authority === null) return '';
    return p.scheme + '//' + p.authority.replace(/^[^@]*@/, '');
  }
  function urlHost(url) {
    var o = urlOrigin(url);
    if (!o) return '';
    return o.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/:\d+$/, '').toLowerCase();
  }
  function urlPath(url) { var p = splitUrl(url); return p ? p.path : ''; }
  function isHttpUrl(s) { return /^https?:\/\/[^\s/?#]+/i.test(String(s == null ? '' : s).trim()); }
  function isHttps(url) { return /^https:\/\//i.test(String(url == null ? '' : url).trim()); }
  // An http:// stream on an https:// page is blocked by every browser (mixed content).
  function isMixedContent(url, pageProtocol) {
    return String(pageProtocol || '').toLowerCase().indexOf('https') === 0 && /^http:\/\//i.test(String(url == null ? '' : url).trim());
  }
  function httpsUpgrade(url) { return String(url == null ? '' : url).trim().replace(/^http:\/\//i, 'https://'); }

  /* ---------- media classification ---------- */
  var EXT_KIND = {
    m3u8: 'hls', m3u: 'playlist', pls: 'playlist', mpd: 'dash',
    mp3: 'audio', aac: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', flac: 'audio', wav: 'audio', weba: 'audio',
    mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', ts: 'video', mkv: 'video', ogv: 'video'
  };
  var EXT_MIME = {
    m3u8: 'application/vnd.apple.mpegurl', m3u: 'audio/x-mpegurl', pls: 'audio/x-scpls', mpd: 'application/dash+xml',
    mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav', weba: 'audio/webm',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ts: 'video/mp2t', mkv: 'video/x-matroska', ogv: 'video/ogg'
  };
  function extOf(url) {
    var path = urlPath(url) || String(url == null ? '' : url).split(/[?#]/)[0];
    var m = /\.([a-zA-Z0-9]{1,5})$/.exec(path);
    return m ? m[1].toLowerCase() : '';
  }
  // Decide what a URL is from its extension, then its content-type. Unknown stays unknown:
  // the UI then tries the <audio>/<video> element and reports honestly if it fails.
  function classifyMedia(url, contentType) {
    var ext = extOf(url), ct = String(contentType || '').toLowerCase().split(';')[0].trim();
    var kind = EXT_KIND[ext] || 'unknown';
    var mime = EXT_MIME[ext] || ct || '';
    if (kind === 'unknown' && ct) {
      if (/mpegurl/.test(ct)) kind = 'hls';
      else if (ct === 'application/dash+xml') kind = 'dash';
      else if (ct === 'audio/x-scpls' || ct === 'audio/x-mpegurl') kind = 'playlist';
      else if (ct.indexOf('audio/') === 0) kind = 'audio';
      else if (ct.indexOf('video/') === 0) kind = 'video';
      else if (ct === 'application/ogg') kind = 'audio';
    }
    if (kind === 'unknown' && /^https?:\/\/[^\/]+(\/[^?#]*)?$/i.test(String(url || '')) && !ext) {
      // Shoutcast/Icecast mounts ("http://host:8000/stream", "/;") are usually audio.
      if (/:\d+\/|\/;|\/stream\b|\/live\b|\/listen\b|\/radio\b/i.test(String(url))) kind = 'audio';
    }
    return { kind: kind, ext: ext, mime: mime };
  }
  // .pls / .m3u / stream-list .m3u8 files resolve to the stream URLs they list.
  function parsePlaylistFile(text, baseUrl) {
    var out = [], lines = String(text == null ? '' : text).replace(/^﻿/, '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var m = /^File\d*\s*=\s*(.+)$/i.exec(line);
      if (m) { line = m[1].trim(); }
      else if (line.charAt(0) === '#' || line.charAt(0) === '[' || /^(Title|Length|NumberOfEntries|Version)\d*\s*=/i.test(line)) continue;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(line) || baseUrl) {
        var u = baseUrl ? resolveUrl(baseUrl, line) : line;
        if (isHttpUrl(u) && out.indexOf(u) === -1) out.push(u);
      }
    }
    return out;
  }
  // Which player to use for a classified URL, given what this browser can do.
  function playerStrategy(o) {
    o = o || {};
    var kind = o.kind || 'unknown';
    if (kind === 'dash') return { strategy: 'unsupported', reason: 'MPEG-DASH (.mpd) manifests are not supported — use an HLS (.m3u8) or direct media URL.' };
    if (kind === 'hls') {
      if (o.nativeHls) return { strategy: 'native-hls', reason: 'This browser plays HLS natively.' };
      if (o.mse) return { strategy: 'mse-hls', reason: 'Playing HLS with the built-in engine (Media Source Extensions).' };
      return { strategy: 'unsupported', reason: 'This browser can play neither HLS natively nor through Media Source Extensions.' };
    }
    if (kind === 'playlist') return { strategy: 'playlist', reason: 'A playlist file — resolve it to the streams it lists first.' };
    return { strategy: 'direct', reason: kind === 'unknown' ? 'Unknown format — trying the browser\'s media element directly.' : 'Direct ' + kind + ' playback.' };
  }
  function codecKind(codec) {
    var c = String(codec == null ? '' : codec).toLowerCase();
    if (/^(avc[13]|hvc1|hev1|av01|vp0?9|vp8|dvh[1e]|mp4v)/.test(c)) return 'video';
    if (/^(mp4a|ac-3|ec-3|opus|vorbis|flac|mp3|alac)/.test(c)) return 'audio';
    if (/^(wvtt|stpp|tx3g)/.test(c)) return 'text';
    return 'unknown';
  }
  function mimeForCodecs(codecs) {
    codecs = (codecs || []).filter(function (c) { return c && codecKind(c) !== 'text'; });
    var hasVideo = codecs.some(function (c) { return codecKind(c) === 'video'; });
    var container = hasVideo || codecs.length === 0 ? 'video/mp4' : 'audio/mp4';
    return codecs.length ? container + '; codecs="' + codecs.join(',') + '"' : container;
  }

  /* ---------- formatting ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function formatDuration(sec) {
    if (!isNum(sec) || sec < 0) return '–';
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }
  function formatClock(sec) { return isNum(sec) ? '-' + formatDuration(Math.max(0, sec)) : '–'; }
  function formatBytes(n) {
    if (!isNum(n) || n < 0) return '–';
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1024 * 1024) return round(n / 1024, n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return round(n / 1048576, n < 10485760 ? 1 : 0) + ' MB';
    return round(n / 1073741824, 1) + ' GB';
  }
  function formatBitrate(bps) {
    if (!isNum(bps) || bps <= 0) return '–';
    if (bps < 1e6) return Math.round(bps / 1000) + ' kbps';
    return round(bps / 1e6, 1) + ' Mbps';
  }
  function formatCount(n) {
    if (!isNum(n)) return '0';
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n < 1e4 ? round(n / 1000, 1) : Math.round(n / 1000)) + 'k';
    return round(n / 1e6, 1) + 'M';
  }
  function timeAgo(ts, now) {
    if (!isNum(ts) || !isNum(now)) return '';
    var d = now - ts;
    if (d < 45 * SECOND) return 'just now';
    if (d < HOUR) return Math.round(d / MINUTE) + 'm ago';
    if (d < DAY) return Math.round(d / HOUR) + 'h ago';
    if (d < 30 * DAY) return Math.round(d / DAY) + 'd ago';
    if (d < 365 * DAY) return Math.round(d / (30 * DAY)) + 'mo ago';
    return Math.round(d / (365 * DAY)) + 'y ago';
  }
  function formatDate(ts) {
    if (!isNum(ts)) return '';
    var d = new Date(ts);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var TZ = { ut: 0, utc: 0, gmt: 0, z: 0, est: -5, edt: -4, cst: -6, cdt: -5, mst: -7, mdt: -6, pst: -8, pdt: -7, bst: 1, cet: 1, cest: 2 };
  // RFC 822/2822 ("Tue, 14 Aug 2026 12:00:00 +0000") and ISO 8601 → ms epoch, or null. Deterministic, no locale.
  function parseDate(str) {
    if (isNum(str)) return str;
    str = String(str == null ? '' : str).trim();
    if (!str) return null;
    var m = /^(?:[A-Za-z]{3},?\s*)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([A-Za-z]{1,4}|[+-]\d{4})?$/.exec(str);
    if (m && MONTHS.hasOwnProperty(m[2].toLowerCase())) {
      var year = +m[3]; if (year < 100) year += year < 50 ? 2000 : 1900;
      var ms = Date.UTC(year, MONTHS[m[2].toLowerCase()], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      var tz = m[7] ? m[7] : '+0000', off = 0;
      if (/^[+-]\d{4}$/.test(tz)) off = (tz.charAt(0) === '-' ? -1 : 1) * ((+tz.slice(1, 3)) * 60 + (+tz.slice(3, 5)));
      else if (TZ.hasOwnProperty(tz.toLowerCase())) off = TZ[tz.toLowerCase()] * 60;
      return ms - off * MINUTE;
    }
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(str);
    if (m) {
      var ms2 = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0);
      var z = m[8], off2 = 0;
      if (z && z.toUpperCase() !== 'Z') { var zz = z.replace(':', ''); off2 = (zz.charAt(0) === '-' ? -1 : 1) * ((+zz.slice(1, 3)) * 60 + (+zz.slice(3, 5))); }
      return ms2 - off2 * MINUTE;
    }
    var t = Date.parse(str);
    return isNum(t) ? t : null;
  }

  /* ---------- bytes ---------- */
  function concatBytes(arrays) {
    var n = 0, i;
    for (i = 0; i < arrays.length; i++) n += arrays[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arrays.length; i++) { out.set(arrays[i], o); o += arrays[i].length; }
    return out;
  }
  function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function hexOf(bytes) {
    var s = '';
    for (var i = 0; i < (bytes ? bytes.length : 0); i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  function bytesOfHex(hex) {
    hex = String(hex == null ? '' : hex).replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
    var out = new Uint8Array(hex.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function u16be(b, o) { return ((b[o] << 8) | b[o + 1]) >>> 0; }
  function u24be(b, o) { return ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0; }
  function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function u64be(b, o) { return u32be(b, o) * 4294967296 + u32be(b, o + 4); }
  function writeU16be(b, o, v) { b[o] = (v >>> 8) & 0xff; b[o + 1] = v & 0xff; }
  function writeU32be(b, o, v) { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff; }
  function writeU64be(b, o, v) { writeU32be(b, o, Math.floor(v / 4294967296)); writeU32be(b, o + 4, v >>> 0); }
  function bytesOfText(s) {
    s = String(s == null ? '' : s);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00); out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  function textOf(bytes) {
    if (!bytes) return '';
    if (typeof TextDecoder !== 'undefined') { try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { /* fall through */ } }
    var s = '', i = 0, c, c2, c3, c4;
    while (i < bytes.length) {
      c = bytes[i++];
      if (c < 0x80) s += String.fromCharCode(c);
      else if (c < 0xe0) { c2 = bytes[i++]; s += String.fromCharCode(((c & 31) << 6) | (c2 & 63)); }
      else if (c < 0xf0) { c2 = bytes[i++]; c3 = bytes[i++]; s += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63)); }
      else { c2 = bytes[i++]; c3 = bytes[i++]; c4 = bytes[i++]; var cp = ((c & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63) - 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
    }
    return s;
  }
  function safeJsonParse(s, fallback) { try { var v = JSON.parse(s); return v === undefined ? fallback : v; } catch (e) { return fallback; } }

  return {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    hashStr: hashStr, rand01: rand01, clamp: clamp, round: round, isNum: isNum,
    escapeHTML: escapeHTML, truncate: truncate, slug: slug, collapseWs: collapseWs,
    uniq: uniq, stableSort: stableSort, sortBy: sortBy,
    splitUrl: splitUrl, resolveUrl: resolveUrl, urlOrigin: urlOrigin, urlHost: urlHost, urlPath: urlPath, extOf: extOf,
    isHttpUrl: isHttpUrl, isHttps: isHttps, isMixedContent: isMixedContent, httpsUpgrade: httpsUpgrade,
    classifyMedia: classifyMedia, parsePlaylistFile: parsePlaylistFile, playerStrategy: playerStrategy,
    codecKind: codecKind, mimeForCodecs: mimeForCodecs,
    formatDuration: formatDuration, formatClock: formatClock, formatBytes: formatBytes, formatBitrate: formatBitrate,
    formatCount: formatCount, timeAgo: timeAgo, formatDate: formatDate, parseDate: parseDate,
    concatBytes: concatBytes, bytesEqual: bytesEqual, hexOf: hexOf, bytesOfHex: bytesOfHex,
    u16be: u16be, u24be: u24be, u32be: u32be, u64be: u64be, writeU16be: writeU16be, writeU32be: writeU32be, writeU64be: writeU64be,
    bytesOfText: bytesOfText, textOf: textOf, safeJsonParse: safeJsonParse
  };
})();
