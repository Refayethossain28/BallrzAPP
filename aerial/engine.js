/* Aerial — the pure "stream anything from the open internet" engine.
 * =====================================================================
 * Aerial is an internet media streaming app: live internet radio (the
 * community Radio Browser directory), podcasts (any RSS feed, the open
 * podcast directory), and TV & video (any HLS, MP4 or direct audio URL),
 * with no backend of its own. Every rule that decides what to play and
 * how — the M3U8 playlist grammar, adaptive-bitrate choice and live-edge
 * timing, the MPEG-TS demuxer and the fragmented-MP4 remuxer that feed
 * Media Source Extensions, the RSS/XML feed parser, the radio directory
 * queries and ranking, and the library reducers — lives HERE as pure,
 * deterministic, clock-injected functions with zero DOM and zero I/O.
 * Unit-tested in scripts/test-aerial-*.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

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

  /* ===== TS: MPEG-TS demuxer — PAT/PMT, PES, H.264 access units → AVCC, AAC/MP3 frames, ID3 ===== */
  var TS = (function () {
    'use strict';

    var TS_PACKET_SIZE = 188, TS_TIMESCALE = 90000;
    var PTS_WRAP = 8589934592;      // 2^33: PTS/DTS are 33-bit counters at 90 kHz; a jump beyond half of it is a lap
    var DEFAULT_FRAME_TICKS = 3000; // 30 fps; used only when no DTS delta is available yet
    var MAX_ERRORS = 100;           // junk input must not turn into a megabyte of error strings
    var MAX_PENDING_BYTES = 8 * 1024 * 1024; // an unbounded PES/NAL with no end in sight is a broken stream
    var MAX_SECTION_LENGTH = 1021;  // ISO 13818-1 §2.4.4.3

    // Stream types we care about (ISO 13818-1 table 2-34).
    var ST_MPEG1_AUDIO = 0x03, ST_MPEG2_AUDIO = 0x04, ST_PRIVATE_PES = 0x06, ST_AAC_ADTS = 0x0f, ST_ID3 = 0x15, ST_H264 = 0x1b;
    // PES stream_ids with no optional header (ISO 13818-1 §2.4.3.7).
    var NO_HEADER_STREAM_IDS = { 0xbc: 1, 0xbe: 1, 0xbf: 1, 0xf0: 1, 0xf1: 1, 0xf2: 1, 0xf8: 1, 0xff: 1 };
    // Non-VCL NAL types that open a new access unit when they follow a VCL NAL (H.264 §7.4.1.2.3).
    var AU_STARTERS = { 6: 1, 7: 1, 8: 1, 14: 1, 15: 1, 16: 1, 17: 1, 18: 1 };
    // Profiles whose SPS carries chroma_format_idc / bit depth / scaling lists (H.264 §7.3.2.1.1).
    var HIGH_PROFILES = { 100: 1, 110: 1, 122: 1, 244: 1, 44: 1, 83: 1, 86: 1, 118: 1, 128: 1, 138: 1, 139: 1, 134: 1, 135: 1 };
    // aspect_ratio_idc 1..16 (H.264 table E-1).
    var SAR_TABLE = [null, [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11], [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];
    var AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    var MPA_SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
    // kbps by [layer number][bitrate_index] (ISO 11172-3 / 13818-3 table B.1-ish; index 0 = free, 15 = invalid)
    var MPA_BITRATES_V1 = [
      null,
      [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // layer I
      [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],    // layer II
      [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]      // layer III
    ];
    var MPA_BITRATES_V2 = [
      null,
      [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],   // layer I
      [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],         // layer II
      [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]          // layer III
    ];

    /* ---------- bytes (cross-realm safe: no instanceof) ---------- */
    function toBytes(x) {
      if (isBytes(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
      if (Object.prototype.toString.call(x) === '[object ArrayBuffer]') return new Uint8Array(x);
      if (Array.isArray(x)) return Uint8Array.from(x, function (b) { return b & 0xff; });
      return null;
    }
    function concat(parts) { return parts.length === 1 ? parts[0] : UTIL.concatBytes(parts); }
    function hex2(n) { return (n < 16 ? '0' : '') + (n & 0xff).toString(16); }

    function pushError(errors, type, message, pid) {
      if (errors.length > MAX_ERRORS) return;
      if (errors.length === MAX_ERRORS) { errors.push({ type: 'overflow', message: 'further errors suppressed' }); return; }
      var e = { type: type, message: message };
      if (pid != null) e.pid = pid;
      errors.push(e);
    }

    /* ---------- state ---------- */
    function newAu() { return { nals: [], pts: null, dts: null, hasVcl: false, idr: false, recovery: false }; }
    function tsCreateState() {
      return {
        v: 1,
        leftover: null,                      // partial TS packet from the previous call
        pmtPid: null, programNumber: null, pcrPid: null,
        videoPid: null, audioPid: null, audioKind: null, id3Pid: null,
        ignoredStreams: [],
        cc: {},                              // pid → last continuity counter
        psi: {},                             // pid → { buf } section being gathered
        pes: {},                             // pid → { chunks, size, declared } PES being gathered
        video: {
          sps: null, pps: null, width: null, height: null, codec: null,
          pending: null, pendingTiming: null, // unterminated NAL (with its start code) + the PES timing it began in
          au: newAu(), lastPts: null, lastDts: null, lastDuration: null, junkLogged: false
        },
        audio: {
          codec: null, sampleRate: null, channels: null, config: null, samplesPerFrame: null,
          remainder: null, remainderPts: null, // frame bytes that did not complete in the last PES
          lastPts: null
        }
      };
    }
    // Deep copy of the state shape: primitives, arrays, plain objects and byte arrays only.
    function cloneValue(v) {
      if (v === null || typeof v !== 'object') return v;
      if (isBytes(v)) return new Uint8Array(v);
      if (Array.isArray(v)) return v.map(cloneValue);
      var out = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = cloneValue(v[k]);
      return out;
    }
    // The caller's state is never mutated: work on a copy with every expected key present,
    // so a stale or hand-rolled state cannot crash the demuxer.
    function normalizeState(state) {
      var fresh = tsCreateState();
      if (!state || typeof state !== 'object') return fresh;
      var out = {}, k;
      for (k in fresh) if (Object.prototype.hasOwnProperty.call(fresh, k)) out[k] = (k in state) ? cloneValue(state[k]) : fresh[k];
      ['video', 'audio'].forEach(function (track) {
        if (!out[track] || typeof out[track] !== 'object') { out[track] = fresh[track]; return; }
        for (k in fresh[track]) if (!(k in out[track])) out[track][k] = fresh[track][k];
      });
      var v = out.video, a = out.audio;
      ['pmtPid', 'programNumber', 'pcrPid', 'videoPid', 'audioPid', 'id3Pid'].forEach(function (k2) { out[k2] = numOrNull(out[k2]); });
      if (out.audioKind !== 'aac' && out.audioKind !== 'mp3') { out.audioKind = null; out.audioPid = null; }
      var au = v.au && typeof v.au === 'object' ? v.au : {}, nals = Array.isArray(au.nals) ? au.nals.filter(isBytes) : [];
      v.au = { nals: nals, pts: numOrNull(au.pts), dts: numOrNull(au.dts), hasVcl: nals.length > 0 && au.hasVcl === true, idr: au.idr === true, recovery: au.recovery === true };
      if (v.au.pts === null) v.au.dts = null; else if (v.au.dts === null) v.au.dts = v.au.pts;
      ['lastPts', 'lastDts', 'lastDuration', 'width', 'height'].forEach(function (k2) { v[k2] = numOrNull(v[k2]); });
      v.sps = bytesOrNull(v.sps); v.pps = bytesOrNull(v.pps); v.pending = bytesOrNull(v.pending);
      if (!v.pending || !(v.pendingTiming && typeof v.pendingTiming === 'object')) v.pendingTiming = null;
      else v.pendingTiming = { pts: numOrNull(v.pendingTiming.pts), dts: numOrNull(v.pendingTiming.dts), used: v.pendingTiming.used === true };
      ['sampleRate', 'channels', 'samplesPerFrame', 'remainderPts', 'lastPts'].forEach(function (k2) { a[k2] = numOrNull(a[k2]); });
      a.remainder = bytesOrNull(a.remainder);
      if (!a.config || typeof a.config !== 'object') a.config = null;
      out.leftover = bytesOrNull(out.leftover);
      ['cc', 'psi', 'pes'].forEach(function (k2) { if (!out[k2] || typeof out[k2] !== 'object') out[k2] = {}; });
      for (k in out.cc) if (typeof out.cc[k] !== 'number') delete out.cc[k];
      for (k in out.psi) if (!(out.psi[k] && isBytes(out.psi[k].buf))) delete out.psi[k];
      for (k in out.pes) {
        var e = out.pes[k];
        if (!(e && Array.isArray(e.chunks) && e.chunks.every(isBytes) && typeof e.size === 'number')) delete out.pes[k];
      }
      if (!Array.isArray(out.ignoredStreams)) out.ignoredStreams = [];
      return out;
    }
    function isBytes(x) { return !!x && ArrayBuffer.isView(x); }
    function bytesOrNull(x) { return isBytes(x) ? x : null; }
    function numOrNull(x) { return typeof x === 'number' && isFinite(x) ? x : null; }

    /* ---------- timestamps ---------- */
    // 33-bit PTS/DTS wrap every ~26.5 h; bring `pts` onto the same lap as `ref`.
    function tsUnwrapPts(pts, ref) {
      if (typeof pts !== 'number' || !isFinite(pts)) return pts;
      if (typeof ref !== 'number' || !isFinite(ref)) return pts;
      var laps = Math.round((pts - ref) / PTS_WRAP);
      return laps === 0 ? pts : pts - laps * PTS_WRAP;
    }
    // 5-byte PTS/DTS field: 0010/0011 PTS[32..30] marker PTS[29..15] marker PTS[14..0] marker.
    function readTimestamp(b, o) {
      var hi = (b[o] & 0x0e) >> 1;
      var lo = ((b[o + 1] << 22) | ((b[o + 2] & 0xfe) << 14) | (b[o + 3] << 7) | (b[o + 4] >> 1)) >>> 0;
      return hi * 1073741824 + lo;
    }

    /* ---------- PSI: PAT / PMT ---------- */
    function sectionBounds(s, tableId) {
      if (!s || s.length < 12) return { error: 'section too short' };
      if (s[0] !== tableId) return { error: 'unexpected table_id 0x' + hex2(s[0]) };
      var sectionLength = ((s[1] & 0x0f) << 8) | s[2];
      var end = 3 + sectionLength - 4; // CRC_32 excluded
      if (sectionLength > MAX_SECTION_LENGTH || end > s.length || end < 8) return { error: 'bad section_length ' + sectionLength };
      return { end: end, version: (s[5] >> 1) & 0x1f, current: (s[5] & 1) === 1 };
    }
    // Program Association Table → the PMT pid of the first program (ISO 13818-1 §2.4.4.3).
    function parsePat(section) {
      var s = toBytes(section), b = sectionBounds(s, 0x00);
      if (b.error) return { ok: false, error: 'pat: ' + b.error };
      var programs = [], pmtPid = null;
      for (var i = 8; i + 4 <= b.end; i += 4) {
        var programNumber = (s[i] << 8) | s[i + 1], pid = ((s[i + 2] & 0x1f) << 8) | s[i + 3];
        if (programNumber === 0) continue; // network information pid, not a program
        programs.push({ programNumber: programNumber, pid: pid });
        if (pmtPid === null) pmtPid = pid;
      }
      if (pmtPid === null) return { ok: false, error: 'pat: no programs' };
      return { ok: true, transportStreamId: (s[3] << 8) | s[4], version: b.version, current: b.current, programs: programs, pmtPid: pmtPid };
    }
    // Program Map Table → elementary streams with their stream_type and registration (ISO 13818-1 §2.4.4.8).
    function parsePmt(section) {
      var s = toBytes(section), b = sectionBounds(s, 0x02);
      if (b.error) return { ok: false, error: 'pmt: ' + b.error };
      if (b.end < 12) return { ok: false, error: 'pmt: section too short' };
      var pcrPid = ((s[8] & 0x1f) << 8) | s[9];
      var programInfoLength = ((s[10] & 0x0f) << 8) | s[11];
      var streams = [], i = 12 + programInfoLength;
      while (i + 5 <= b.end) {
        var streamType = s[i], pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2], esInfoLength = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
        var descriptors = s.subarray(i + 5, Math.min(i + 5 + esInfoLength, b.end)), registration = null;
        for (var j = 0; j + 2 <= descriptors.length; j += 2 + descriptors[j + 1]) {
          if (descriptors[j] === 0x05 && descriptors[j + 1] >= 4 && j + 6 <= descriptors.length) {
            registration = String.fromCharCode(descriptors[j + 2], descriptors[j + 3], descriptors[j + 4], descriptors[j + 5]);
          }
        }
        streams.push({ streamType: streamType, pid: pid, registration: registration });
        i += 5 + esInfoLength;
      }
      return { ok: true, programNumber: (s[3] << 8) | s[4], version: b.version, current: b.current, pcrPid: pcrPid, streams: streams };
    }

    function applyPat(st, pat) {
      if (!pat.ok || !pat.current) return;
      if (pat.pmtPid !== st.pmtPid) { delete st.psi[st.pmtPid]; delete st.cc[st.pmtPid]; st.pmtPid = pat.pmtPid; }
    }
    function applyPmt(st, pmt, out) {
      if (!pmt.ok || !pmt.current) return;
      var videoPid = null, audioPid = null, audioKind = null, id3Pid = null, ignored = [];
      for (var i = 0; i < pmt.streams.length; i++) {
        var s = pmt.streams[i], isMpa = s.streamType === ST_MPEG1_AUDIO || s.streamType === ST_MPEG2_AUDIO;
        var isId3 = s.streamType === ST_ID3 || (s.streamType === ST_PRIVATE_PES && s.registration === 'ID3 ');
        if (s.streamType === ST_H264 && videoPid === null) videoPid = s.pid;
        else if (s.streamType === ST_AAC_ADTS && audioPid === null) { audioPid = s.pid; audioKind = 'aac'; }
        else if (isMpa && audioPid === null) { audioPid = s.pid; audioKind = 'mp3'; }
        else if (isId3 && id3Pid === null) id3Pid = s.pid;
        else ignored.push({ pid: s.pid, streamType: s.streamType });
      }
      st.programNumber = pmt.programNumber;
      st.pcrPid = pmt.pcrPid;
      st.ignoredStreams = ignored;
      // A changed mapping (new encoder, new PMT version) ends the old elementary streams: emit what they
      // still hold, then start the new pids clean.
      if (videoPid !== st.videoPid) {
        flushPendingPes(st, st.videoPid, 'video', out);
        flushVideo(st, out);
        st.videoPid = videoPid;
      }
      if (audioPid !== st.audioPid || audioKind !== st.audioKind) {
        flushPendingPes(st, st.audioPid, 'audio', out);
        dropAudioRemainder(st, out);
        st.audioPid = audioPid; st.audioKind = audioKind;
        st.audio = tsCreateState().audio;
        if (audioKind === 'mp3') st.audio.codec = 'mp3';
      }
      if (id3Pid !== st.id3Pid) { flushPendingPes(st, st.id3Pid, 'id3', out); st.id3Pid = id3Pid; }
    }
    function flushPendingPes(st, pid, kind, out) {
      if (pid === null || !st.pes[pid]) return;
      flushPes(st, pid, kind, st.pes[pid], out);
      delete st.pes[pid];
    }
    // End of the video stream (flush or pid change): the held-back NAL is complete, and so is the access unit.
    function flushVideo(st, out) {
      var v = st.video;
      if (v.pending) {
        var end = trimTrailingZeros(v.pending, 3, v.pending.length);
        if (end > 3) pushNal(st, v.pending.subarray(3, end), v.pendingTiming, out);
        v.pending = null; v.pendingTiming = null;
      }
      if (v.au.hasVcl) emitAu(st, null, out); else v.au = newAu();
    }

    // Sections may span packets and a payload may hold the tail of one section before the next.
    function handleSection(st, pid, kind, pusi, payload, out) {
      var entry = st.psi[pid];
      if (pusi) {
        var pointer = payload[0];
        if (1 + pointer > payload.length) { pushError(out.errors, 'psi', 'pointer_field beyond payload', pid); return; }
        if (entry && pointer > 0) { entry.buf = concat([entry.buf, payload.subarray(1, 1 + pointer)]); tryParseSection(st, pid, kind, out); }
        st.psi[pid] = { buf: payload.slice(1 + pointer) };
      } else {
        if (!entry) return; // continuation of a section whose start we never saw
        entry.buf = concat([entry.buf, payload]);
      }
      tryParseSection(st, pid, kind, out);
    }
    function tryParseSection(st, pid, kind, out) {
      var entry = st.psi[pid];
      if (!entry || entry.buf.length < 3) return;
      if (entry.buf[0] === 0xff) { delete st.psi[pid]; return; } // stuffing: no section here
      var sectionLength = ((entry.buf[1] & 0x0f) << 8) | entry.buf[2];
      if (sectionLength > MAX_SECTION_LENGTH) { delete st.psi[pid]; pushError(out.errors, 'psi', 'section_length ' + sectionLength + ' out of range', pid); return; }
      if (entry.buf.length < 3 + sectionLength) return; // wait for the rest
      var section = entry.buf.subarray(0, 3 + sectionLength);
      delete st.psi[pid];
      var parsed = kind === 'pat' ? parsePat(section) : parsePmt(section);
      if (!parsed.ok) { pushError(out.errors, 'psi', parsed.error, pid); return; }
      if (kind === 'pat') applyPat(st, parsed); else applyPmt(st, parsed, out);
    }

    /* ---------- PES ---------- */
    function parsePesHeader(data) {
      if (data.length < 6 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return { ok: false, error: 'pes: missing start code' };
      var streamId = data[3];
      if (NO_HEADER_STREAM_IDS[streamId] === 1) return { ok: true, streamId: streamId, pts: null, dts: null, payloadStart: 6 };
      if (data.length < 9) return { ok: false, error: 'pes: header truncated' };
      if ((data[6] & 0xc0) !== 0x80) return { ok: false, error: 'pes: bad header marker' };
      var flags = data[7], headerLength = data[8], payloadStart = 9 + headerLength;
      if (payloadStart > data.length) return { ok: false, error: 'pes: header_data_length beyond packet' };
      var pts = null, dts = null;
      if (flags & 0x80) {
        if (headerLength < 5) return { ok: false, error: 'pes: PTS flagged but absent' };
        pts = readTimestamp(data, 9);
        if (flags & 0x40) {
          if (headerLength < 10) return { ok: false, error: 'pes: DTS flagged but absent' };
          dts = readTimestamp(data, 14);
        }
      }
      return { ok: true, streamId: streamId, pts: pts, dts: dts, payloadStart: payloadStart };
    }

    function pidKind(st, pid) {
      if (pid === 0) return 'pat';
      if (pid === st.pmtPid) return 'pmt';
      if (pid === st.videoPid) return 'video';
      if (pid === st.audioPid) return 'audio';
      if (pid === st.id3Pid) return 'id3';
      return null;
    }

    function handlePesPacket(st, pid, kind, pusi, payload, out) {
      var pend = st.pes[pid];
      if (pusi) {
        // An unbounded PES (packet_length 0, the norm for video) only ends when the next one starts.
        if (pend) { flushPes(st, pid, kind, pend, out); delete st.pes[pid]; }
        pend = st.pes[pid] = { chunks: [payload.slice()], size: payload.length, declared: null };
      } else {
        if (!pend) return; // joined mid-PES: nothing to attach these bytes to
        pend.chunks.push(payload.slice());
        pend.size += payload.length;
      }
      if (pend.declared === null && pend.size >= 6) {
        if (pend.chunks[0].length < 6) pend.chunks = [concat(pend.chunks)];
        pend.declared = (pend.chunks[0][4] << 8) | pend.chunks[0][5];
      }
      var complete = pend.declared !== null && pend.declared > 0 && pend.size >= 6 + pend.declared;
      if (complete || pend.size > MAX_PENDING_BYTES) {
        if (!complete) pushError(out.errors, 'pes', 'unbounded PES exceeded ' + MAX_PENDING_BYTES + ' bytes; flushed', pid);
        flushPes(st, pid, kind, pend, out);
        delete st.pes[pid];
      }
    }

    function flushPes(st, pid, kind, pend, out) {
      var data = concat(pend.chunks), truncated = false;
      if (pend.declared !== null && pend.declared > 0) {
        var total = 6 + pend.declared;
        if (data.length < total) { truncated = true; pushError(out.errors, 'pes', 'truncated PES: expected ' + total + ' bytes, got ' + data.length, pid); }
        else if (data.length > total) { pushError(out.errors, 'pes', (data.length - total) + ' bytes beyond PES_packet_length ignored', pid); data = data.subarray(0, total); }
      }
      var hdr = parsePesHeader(data);
      if (!hdr.ok) { pushError(out.errors, 'pes', hdr.error, pid); return; }
      var payload = data.subarray(hdr.payloadStart);
      // Unwrap against the newest media timestamp so a 33-bit wrap inside a state stays monotonic.
      var ref = kind === 'video' ? st.video.lastPts : kind === 'audio' ? st.audio.lastPts
        : (st.video.lastPts !== null ? st.video.lastPts : st.audio.lastPts);
      var pts = hdr.pts === null ? null : tsUnwrapPts(hdr.pts, ref);
      var dts = hdr.dts === null ? pts : tsUnwrapPts(hdr.dts, pts);
      if (kind === 'video' && pts !== null) st.video.lastPts = pts;
      try {
        if (kind === 'video') processVideoPes(st, payload, { pts: pts, dts: dts, used: false }, out, truncated);
        else if (kind === 'audio') processAudioPes(st, payload, pts, out, truncated);
        else out.id3.push({ pts: pts, data: payload.slice() });
      } catch (e) {
        // A bug in one elementary-stream parser must not take the whole segment down with it.
        pushError(out.errors, 'internal', String(e && e.message ? e.message : e), pid);
      }
    }

    /* ---------- H.264 NAL helpers ---------- */
    function nalType(nal) {
      var b = toBytes(nal);
      return b && b.length ? b[0] & 0x1f : -1;
    }
    // Positions just after each 00 00 01 start code.
    function findStartCodes(data) {
      var starts = [], i = 0, n = data.length;
      while (i + 2 < n) {
        var c = data[i + 2];
        if (c > 1) { i += 3; continue; }                                   // no start code can end here
        if (c === 1 && data[i] === 0 && data[i + 1] === 0) { starts.push(i + 3); i += 3; continue; }
        i++;
      }
      return starts;
    }
    function trimTrailingZeros(data, start, end) {
      while (end > start && data[end - 1] === 0) end--; // zero_byte of a 4-byte start code / trailing_zero_8bits
      return end;
    }
    // Annex B byte stream → NAL units (views into the input, trailing zero bytes removed, AUD kept).
    function splitNalUnits(annexB) {
      var data = toBytes(annexB), out = [];
      if (!data) return out;
      var starts = findStartCodes(data);
      for (var i = 0; i < starts.length; i++) {
        var end = trimTrailingZeros(data, starts[i], i + 1 < starts.length ? starts[i + 1] - 3 : data.length);
        if (end > starts[i]) out.push(data.subarray(starts[i], end));
      }
      return out;
    }
    // NALs → AVCC sample data: 4-byte big-endian length before each NAL (what avcC lengthSizeMinusOne=3 promises).
    function toAvcc(nals) {
      var list = Array.isArray(nals) ? nals : [], total = 0, i, n;
      for (i = 0; i < list.length; i++) { n = toBytes(list[i]); if (n) total += 4 + n.length; }
      var out = new Uint8Array(total), o = 0;
      for (i = 0; i < list.length; i++) {
        n = toBytes(list[i]);
        if (!n) continue;
        UTIL.writeU32be(out, o, n.length);
        out.set(n, o + 4);
        o += 4 + n.length;
      }
      return out;
    }
    // Drop emulation_prevention_three_byte (00 00 03 → 00 00) so exp-golomb fields can be read.
    function unescapeRbsp(bytes) {
      var b = toBytes(bytes);
      if (!b) return new Uint8Array(0);
      var out = new Uint8Array(b.length), o = 0, zeros = 0;
      for (var i = 0; i < b.length; i++) {
        var c = b[i];
        if (zeros >= 2 && c === 3) { zeros = 0; continue; }
        out[o++] = c;
        zeros = c === 0 ? zeros + 1 : 0;
      }
      return out.slice(0, o);
    }

    // MSB-first bit reader with exp-golomb; reading past the end flags `bad` instead of throwing.
    function bitReader(bytes) {
      var pos = 0, end = bytes.length * 8, r = { bad: false };
      r.u = function (n) {
        if (pos + n > end) { r.bad = true; pos = end; return 0; }
        var v = 0;
        for (var i = 0; i < n; i++) { v = v * 2 + ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1); pos++; }
        return v;
      };
      r.ue = function () {
        var zeros = 0;
        while (!r.bad && zeros < 32 && r.u(1) === 0) zeros++;
        if (zeros >= 32) { r.bad = true; return 0; }
        return Math.pow(2, zeros) - 1 + r.u(zeros);
      };
      r.se = function () { var k = r.ue(); return (k & 1) ? (k + 1) / 2 : -(k / 2); };
      return r;
    }
    function skipScalingList(r, size) {
      var lastScale = 8, nextScale = 8;
      for (var j = 0; j < size && !r.bad; j++) {
        if (nextScale !== 0) nextScale = ((lastScale + r.se()) % 256 + 256) % 256;
        lastScale = nextScale === 0 ? lastScale : nextScale;
      }
    }
    // Sequence parameter set (NAL type 7, header byte included) → dimensions, codec string, SAR (H.264 §7.3.2.1.1, §E.1.1).
    function parseSps(sps) {
      var nal = toBytes(sps);
      if (!nal || nal.length < 4) return { ok: false, error: 'sps: too short' };
      var r = bitReader(unescapeRbsp(nal.subarray(1)));
      var profileIdc = r.u(8), constraintFlags = r.u(8), levelIdc = r.u(8);
      if (r.ue() > 31) return { ok: false, error: 'sps: bad seq_parameter_set_id' };
      var chromaFormatIdc = 1, separateColourPlane = 0, bitDepthLuma = 8, bitDepthChroma = 8;
      if (HIGH_PROFILES[profileIdc] === 1) {
        chromaFormatIdc = r.ue();
        if (chromaFormatIdc > 3) return { ok: false, error: 'sps: bad chroma_format_idc' };
        if (chromaFormatIdc === 3) separateColourPlane = r.u(1);
        bitDepthLuma = r.ue() + 8;
        bitDepthChroma = r.ue() + 8;
        r.u(1); // qpprime_y_zero_transform_bypass_flag
        if (r.u(1)) { // seq_scaling_matrix_present_flag
          var lists = chromaFormatIdc !== 3 ? 8 : 12;
          for (var i = 0; i < lists && !r.bad; i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
        }
      }
      var log2MaxFrameNum = r.ue() + 4;
      if (log2MaxFrameNum > 16) return { ok: false, error: 'sps: bad log2_max_frame_num' };
      var picOrderCntType = r.ue();
      if (picOrderCntType === 0) {
        if (r.ue() + 4 > 16) return { ok: false, error: 'sps: bad log2_max_pic_order_cnt_lsb' };
      } else if (picOrderCntType === 1) {
        r.u(1); r.se(); r.se(); // delta_pic_order_always_zero_flag, offset_for_non_ref_pic, offset_for_top_to_bottom_field
        var cycle = r.ue();
        if (cycle > 255) return { ok: false, error: 'sps: bad num_ref_frames_in_pic_order_cnt_cycle' };
        for (var c = 0; c < cycle && !r.bad; c++) r.se();
      } else if (picOrderCntType > 2) return { ok: false, error: 'sps: bad pic_order_cnt_type' };
      var numRefFrames = r.ue();
      r.u(1); // gaps_in_frame_num_value_allowed_flag
      var widthMbs = r.ue() + 1, heightMapUnits = r.ue() + 1;
      var frameMbsOnly = r.u(1);
      if (!frameMbsOnly) r.u(1); // mb_adaptive_frame_field_flag
      r.u(1); // direct_8x8_inference_flag
      var cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
      if (r.u(1)) { cropLeft = r.ue(); cropRight = r.ue(); cropTop = r.ue(); cropBottom = r.ue(); }
      var sar = { n: 1, d: 1 };
      if (r.u(1) && r.u(1)) { // vui_parameters_present_flag, aspect_ratio_info_present_flag
        var idc = r.u(8);
        if (idc === 255) sar = { n: r.u(16), d: r.u(16) };
        else if (idc > 0 && idc <= 16) sar = { n: SAR_TABLE[idc][0], d: SAR_TABLE[idc][1] };
      }
      if (r.bad) return { ok: false, error: 'sps: truncated' };
      if (sar.n === 0 || sar.d === 0) sar = { n: 1, d: 1 };
      // Crop offsets count in chroma sample units; a field-coded stream crops two rows per unit (§7.4.2.1.1).
      var chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
      var subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1, subHeightC = chromaFormatIdc === 1 ? 2 : 1;
      var cropUnitX = chromaArrayType === 0 ? 1 : subWidthC;
      var cropUnitY = (chromaArrayType === 0 ? 1 : subHeightC) * (2 - frameMbsOnly);
      var width = widthMbs * 16 - cropUnitX * (cropLeft + cropRight);
      var height = (2 - frameMbsOnly) * heightMapUnits * 16 - cropUnitY * (cropTop + cropBottom);
      if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return { ok: false, error: 'sps: implausible dimensions' };
      return {
        ok: true, profileIdc: profileIdc, constraintFlags: constraintFlags, levelIdc: levelIdc,
        codec: 'avc1.' + hex2(profileIdc) + hex2(constraintFlags) + hex2(levelIdc),
        width: width, height: height, sar: sar,
        chromaFormatIdc: chromaFormatIdc, bitDepthLuma: bitDepthLuma, bitDepthChroma: bitDepthChroma,
        frameMbsOnly: frameMbsOnly === 1, log2MaxFrameNum: log2MaxFrameNum, picOrderCntType: picOrderCntType, numRefFrames: numRefFrames,
        crop: { left: cropLeft * cropUnitX, right: cropRight * cropUnitX, top: cropTop * cropUnitY, bottom: cropBottom * cropUnitY }
      };
    }
    // SEI (NAL type 6): does any payload carry a recovery point (type 6)? Such a frame is a safe decode start.
    function seiHasRecoveryPoint(nal) {
      var rbsp = unescapeRbsp(nal.subarray(1)), i = 0, n = rbsp.length;
      while (i + 1 < n) { // at least a type byte and a size byte left (the lone trailing 0x80 ends it)
        var type = 0, size = 0;
        while (i < n && rbsp[i] === 0xff) { type += 255; i++; }
        if (i >= n) break;
        type += rbsp[i++];
        while (i < n && rbsp[i] === 0xff) { size += 255; i++; }
        if (i >= n) break;
        size += rbsp[i++];
        if (type === 6) return true;
        i += size;
      }
      return false;
    }

    /* ---------- H.264 access-unit assembly ---------- */
    // A PES payload is one slice of a continuous Annex B stream: NALs may straddle PES packets, so the
    // trailing (unterminated) NAL is kept with the timing of the PES it began in.
    function processVideoPes(st, payload, timing, out, truncated) {
      var v = st.video, pendLen = v.pending ? v.pending.length : 0;
      var data = pendLen ? concat([v.pending, payload]) : payload;
      var starts = findStartCodes(data);
      if (!starts.length) {
        if (pendLen) {
          if (data.length > MAX_PENDING_BYTES) { pushError(out.errors, 'video', 'NAL exceeded ' + MAX_PENDING_BYTES + ' bytes without a start code; discarded'); v.pending = null; v.pendingTiming = null; return; }
          v.pending = data.slice();
        } else if (!v.junkLogged) { v.junkLogged = true; pushError(out.errors, 'video', data.length + ' bytes before the first start code ignored'); }
        return;
      }
      if (!pendLen && starts[0] > 3 && trimTrailingZeros(data, 0, starts[0] - 3) > 0 && !v.junkLogged) {
        v.junkLogged = true;
        pushError(out.errors, 'video', (starts[0] - 3) + ' bytes before the first start code ignored');
      }
      for (var i = 0; i + 1 < starts.length; i++) {
        var end = trimTrailingZeros(data, starts[i], starts[i + 1] - 3);
        if (end > starts[i]) pushNal(st, data.subarray(starts[i], end), starts[i] - 3 < pendLen ? v.pendingTiming : timing, out);
      }
      var last = starts[starts.length - 1];
      v.pendingTiming = last - 3 < pendLen ? v.pendingTiming : timing;
      v.pending = data.slice(last - 3);
      if (truncated) dropPendingNal(st, out);
    }
    // Bytes were lost at the end of a PES: whatever NAL was open there cannot be completed by the next PES.
    function dropPendingNal(st, out) {
      var v = st.video;
      if (!v.pending) return;
      pushError(out.errors, 'video', (v.pending.length - 3) + '-byte partial NAL after a truncated PES discarded', st.videoPid);
      v.pending = null; v.pendingTiming = null;
    }

    function pushNal(st, nal, timing, out) {
      var v = st.video, t = nal[0] & 0x1f;
      var isVcl = t === 1 || t === 5;
      // first_mb_in_slice is the first ue(v) of a slice header; ue(0) is the single bit '1'.
      var opensAu = t === 9 || (AU_STARTERS[t] === 1 && v.au.hasVcl) || (isVcl && v.au.hasVcl && nal.length > 1 && (nal[1] & 0x80) !== 0);
      if (opensAu && v.au.hasVcl) emitAu(st, timing, out);
      var au = v.au;
      // The PES timestamp belongs to the first access unit that starts in that PES — and only to it. Until the
      // AU has a picture, a later PES with its own timestamp wins (SPS/PPS carried over from a lost picture).
      if (!au.hasVcl && timing && timing.pts !== null && !timing.used) { au.pts = timing.pts; au.dts = timing.dts; timing.used = true; }
      if (t === 9) return; // AUD: a delimiter only, never part of the sample
      if (t === 7) recordSps(st, nal, out);
      else if (t === 8) { if (!v.pps || !UTIL.bytesEqual(v.pps, nal)) v.pps = nal.slice(); }
      else if (t === 6) { if (seiHasRecoveryPoint(nal)) au.recovery = true; }
      else if (t === 5) { au.idr = true; au.hasVcl = true; }
      else if (t === 1) au.hasVcl = true;
      au.nals.push(nal);
    }
    function recordSps(st, nal, out) {
      var v = st.video;
      if (v.sps && UTIL.bytesEqual(v.sps, nal)) return;
      v.sps = nal.slice();
      var info = parseSps(nal);
      if (!info.ok) { pushError(out.errors, 'video', info.error); return; }
      v.width = info.width; v.height = info.height; v.codec = info.codec;
    }
    // Close the access unit under construction. `nextTiming` is the PES timing of the AU that follows,
    // which gives the exact DTS delta; the final AU (flush) inherits the previous delta.
    function emitAu(st, nextTiming, out) {
      var v = st.video, au = v.au, pts = au.pts, dts = au.dts;
      if (pts === null) {
        dts = v.lastDts !== null ? v.lastDts + (v.lastDuration || DEFAULT_FRAME_TICKS) : 0;
        pts = dts;
        pushError(out.errors, 'video', 'access unit without PTS; timestamp extrapolated');
      }
      var nextDts = nextTiming && !nextTiming.used && nextTiming.dts !== null ? nextTiming.dts : null;
      var duration;
      if (nextDts !== null && nextDts > dts) duration = nextDts - dts;
      else {
        duration = v.lastDuration || DEFAULT_FRAME_TICKS;
        if (nextDts !== null) pushError(out.errors, 'video', 'DTS not increasing (' + dts + ' → ' + nextDts + '); duration estimated');
      }
      out.video.push({ pts: pts, dts: dts, cts: pts - dts, data: toAvcc(au.nals), key: au.idr || au.recovery, duration: duration });
      v.lastDts = dts;
      v.lastDuration = duration;
      v.au = newAu();
    }

    /* ---------- AAC ADTS / MPEG audio ---------- */
    // ADTS fixed+variable header (ISO 14496-3 §1.A.2.2).
    function parseAdts(bytes, offset) {
      var b = toBytes(bytes), o = offset | 0;
      if (!b || o < 0 || o + 7 > b.length) return { ok: false, error: 'adts: too short' };
      if (b[o] !== 0xff || (b[o + 1] & 0xf6) !== 0xf0) return { ok: false, error: 'adts: no sync' };
      var protectionAbsent = b[o + 1] & 1;
      var profile = (b[o + 2] >> 6) & 3, sampleRateIndex = (b[o + 2] >> 2) & 0x0f;
      var channels = ((b[o + 2] & 1) << 2) | ((b[o + 3] >> 6) & 3);
      var frameLength = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | ((b[o + 5] >> 5) & 7);
      var headerLength = protectionAbsent ? 7 : 9;
      if (sampleRateIndex > 12) return { ok: false, error: 'adts: reserved sampling_frequency_index' };
      if (frameLength < headerLength + 1) return { ok: false, error: 'adts: frame_length ' + frameLength + ' too small' };
      return {
        ok: true, frameLength: frameLength, headerLength: headerLength, objectType: profile + 1,
        sampleRateIndex: sampleRateIndex, sampleRate: AAC_SAMPLE_RATES[sampleRateIndex], channels: channels, crc: !protectionAbsent
      };
    }
    // MPEG-1/2/2.5 layer I/II/III frame header (ISO 11172-3 §2.4.1.3 / 13818-3).
    function parseMpegAudioHeader(bytes, offset) {
      var b = toBytes(bytes), o = offset | 0;
      if (!b || o < 0 || o + 4 > b.length) return { ok: false, error: 'mpa: too short' };
      if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return { ok: false, error: 'mpa: no sync' };
      var versionBits = (b[o + 1] >> 3) & 3, layerBits = (b[o + 1] >> 1) & 3;
      var bitrateIndex = (b[o + 2] >> 4) & 0x0f, sampleRateIndex = (b[o + 2] >> 2) & 3, padding = (b[o + 2] >> 1) & 1;
      var channelMode = (b[o + 3] >> 6) & 3;
      if (versionBits === 1 || layerBits === 0 || sampleRateIndex === 3) return { ok: false, error: 'mpa: reserved version/layer/sample rate' };
      if (bitrateIndex === 0 || bitrateIndex === 15) return { ok: false, error: 'mpa: free-format or invalid bitrate' };
      var version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5, layer = 4 - layerBits;
      var sampleRate = MPA_SAMPLE_RATES[version][sampleRateIndex];
      var bitrate = (version === 1 ? MPA_BITRATES_V1 : MPA_BITRATES_V2)[layer][bitrateIndex] * 1000;
      var samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
      var frameLength = layer === 1
        ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4
        : Math.floor(samplesPerFrame / 8 * bitrate / sampleRate) + padding;
      return {
        ok: true, frameLength: frameLength, sampleRate: sampleRate, channels: channelMode === 3 ? 1 : 2,
        samplesPerFrame: samplesPerFrame, bitrate: bitrate, version: version, layer: layer
      };
    }
    function parseAudioHeader(st, data, i) { return st.audioKind === 'aac' ? parseAdts(data, i) : parseMpegAudioHeader(data, i); }
    // Next plausible frame header at or after `from`; a sync pattern too close to the end to validate is kept as a remainder.
    function findAudioSync(st, data, from) {
      var aac = st.audioKind === 'aac', minHeader = aac ? 7 : 4;
      for (var j = from; j + 1 < data.length; j++) {
        if (data[j] !== 0xff) continue;
        if (aac ? (data[j + 1] & 0xf6) !== 0xf0 : (data[j + 1] & 0xe0) !== 0xe0) continue;
        if (j + minHeader > data.length || parseAudioHeader(st, data, j).ok) return j;
      }
      return -1;
    }
    function frameTicks(sampleRate, samplesPerFrame) { return samplesPerFrame * TS_TIMESCALE / sampleRate; }

    // A PES carries whole frames, usually several; the PES PTS is the first frame that starts in it and the
    // rest are spaced by the frame duration. A frame cut by the PES boundary completes in the next PES.
    function processAudioPes(st, payload, pesPts, out, truncated) {
      var a = st.audio, aac = st.audioKind === 'aac', remLen = a.remainder ? a.remainder.length : 0;
      var data = remLen ? concat([a.remainder, payload]) : payload, n = data.length;
      if (pesPts === null) {
        pesPts = a.lastPts !== null && a.sampleRate ? a.lastPts + Math.round(frameTicks(a.sampleRate, a.samplesPerFrame)) : (a.lastPts || 0);
        pushError(out.errors, 'audio', 'PES without PTS; timestamp extrapolated', st.audioPid);
      }
      var i = 0, inPes = 0, minHeader = aac ? 7 : 4;
      while (i < n) {
        if (n - i < minHeader) break; // header cut by the PES boundary → remainder
        var h = parseAudioHeader(st, data, i);
        if (!h.ok) {
          var j = findAudioSync(st, data, i + 1);
          if (j < 0) { pushError(out.errors, 'audio', (n - i) + ' bytes without a frame sync discarded', st.audioPid); i = n; break; }
          pushError(out.errors, 'audio', (j - i) + ' bytes skipped to resync', st.audioPid);
          i = j;
          continue;
        }
        if (i + h.frameLength > n) break; // frame body cut by the PES boundary → remainder
        var samplesPerFrame = aac ? 1024 : h.samplesPerFrame;
        var startedInRemainder = i < remLen;
        var pts = startedInRemainder ? a.remainderPts : pesPts + Math.round(inPes * frameTicks(h.sampleRate, samplesPerFrame));
        if (!startedInRemainder) inPes++;
        if (a.sampleRate !== h.sampleRate || a.channels !== h.channels || a.samplesPerFrame !== samplesPerFrame || (aac && (!a.config || a.config.objectType !== h.objectType))) {
          a.codec = aac ? 'mp4a.40.' + h.objectType : 'mp3';
          a.sampleRate = h.sampleRate; a.channels = h.channels; a.samplesPerFrame = samplesPerFrame;
          a.config = aac ? { objectType: h.objectType, sampleRateIndex: h.sampleRateIndex, channels: h.channels } : null;
        }
        var frame = aac ? data.slice(i + h.headerLength, i + h.frameLength) : data.slice(i, i + h.frameLength);
        out.audio.push({ pts: pts, dts: pts, data: frame, duration: samplesPerFrame });
        a.lastPts = pts;
        i += h.frameLength;
      }
      if (i < n) {
        if (!(i < remLen)) a.remainderPts = a.sampleRate ? pesPts + Math.round(inPes * frameTicks(a.sampleRate, a.samplesPerFrame)) : pesPts;
        a.remainder = data.slice(i);
      } else { a.remainder = null; a.remainderPts = null; }
      if (truncated) dropAudioRemainder(st, out);
    }
    function dropAudioRemainder(st, out) {
      var a = st.audio;
      if (!a.remainder) return;
      pushError(out.errors, 'audio', a.remainder.length + '-byte partial frame discarded', st.audioPid);
      a.remainder = null; a.remainderPts = null;
    }

    /* ---------- transport packets ---------- */
    function findSync(bytes, from) {
      var len = bytes.length;
      for (var p = from; p < len; p++) {
        if (bytes[p] === 0x47 && (p + TS_PACKET_SIZE >= len || bytes[p + TS_PACKET_SIZE] === 0x47)) return p;
      }
      return -1;
    }

    function handlePacket(st, bytes, pos, out) {
      var b1 = bytes[pos + 1], b3 = bytes[pos + 3];
      var pid = ((b1 & 0x1f) << 8) | bytes[pos + 2], afc = (b3 >> 4) & 3, cc = b3 & 0x0f;
      if (pid === 0x1fff || afc === 0) return; // null packet / reserved
      var kind = pidKind(st, pid);
      if (!kind) return;
      if (b1 & 0x80) { pushError(out.errors, 'tei', 'transport_error_indicator set; packet dropped', pid); return; }
      if (b3 & 0xc0) { pushError(out.errors, 'scrambled', 'scrambled packet dropped (no key)', pid); return; }
      var payloadStart = 4, discontinuity = false;
      if (afc & 2) {
        var afLength = bytes[pos + 4];
        if (afLength > 183) { pushError(out.errors, 'adaptation', 'adaptation_field_length ' + afLength + ' out of range', pid); return; }
        if (afLength > 0) discontinuity = (bytes[pos + 5] & 0x80) !== 0;
        payloadStart = 5 + afLength;
      }
      if (!(afc & 1) || payloadStart >= TS_PACKET_SIZE) return; // adaptation field only: carries no payload and no cc step
      var last = st.cc[pid];
      if (last !== undefined && !discontinuity && cc !== ((last + 1) & 0x0f)) {
        pushError(out.errors, 'continuity', 'continuity counter gap: expected ' + ((last + 1) & 0x0f) + ', got ' + cc, pid);
      }
      st.cc[pid] = cc;
      var pusi = (b1 & 0x40) !== 0, payload = bytes.subarray(pos + payloadStart, pos + TS_PACKET_SIZE);
      if (kind === 'pat' || kind === 'pmt') handleSection(st, pid, kind, pusi, payload, out);
      else handlePesPacket(st, pid, kind, pusi, payload, out);
    }

    function compactPending(st) {
      for (var pid in st.pes) if (st.pes[pid].chunks.length > 1) st.pes[pid].chunks = [concat(st.pes[pid].chunks)];
    }
    function finish(st, out) {
      var v = st.video, a = st.audio;
      return {
        state: st,
        video: st.videoPid !== null ? { codec: v.codec, sps: v.sps, pps: v.pps, width: v.width, height: v.height, timescale: TS_TIMESCALE, samples: out.video } : null,
        audio: st.audioPid !== null ? { codec: a.codec, sampleRate: a.sampleRate, channels: a.channels, config: a.config, timescale: a.sampleRate, samples: out.audio } : null,
        id3: out.id3,
        errors: out.errors
      };
    }

    // Demux one chunk of transport stream. Chunks may be cut anywhere; `state` carries what did not
    // complete (partial packet, PES, NAL, audio frame) into the next call. The input state is not mutated.
    function tsDemux(input, state) {
      var st = normalizeState(state), out = { video: [], audio: [], id3: [], errors: [] };
      var bytes = toBytes(input);
      if (!bytes) { pushError(out.errors, 'input', 'expected a Uint8Array'); return finish(st, out); }
      if (st.leftover && st.leftover.length) { bytes = concat([st.leftover, bytes]); st.leftover = null; }
      var len = bytes.length, pos = 0;
      while (pos < len) {
        if (bytes[pos] !== 0x47) {
          var p = findSync(bytes, pos + 1);
          if (p < 0) { pushError(out.errors, 'sync', 'no sync byte in the remaining ' + (len - pos) + ' bytes; discarded'); break; }
          pushError(out.errors, 'sync', (p - pos) + ' bytes skipped to resync at offset ' + p);
          pos = p;
        }
        if (len - pos < TS_PACKET_SIZE) { st.leftover = bytes.slice(pos); break; }
        handlePacket(st, bytes, pos, out);
        pos += TS_PACKET_SIZE;
      }
      compactPending(st);
      return finish(st, out);
    }

    // End of stream (or before discarding a state): complete every pending PES, NAL and access unit.
    function tsFlush(state) {
      var st = normalizeState(state), out = { video: [], audio: [], id3: [], errors: [] };
      if (st.leftover && st.leftover.length) {
        pushError(out.errors, 'sync', st.leftover.length + '-byte partial packet discarded');
        st.leftover = null;
      }
      var pids = Object.keys(st.pes).map(Number).sort(function (x, y) { return x - y; });
      for (var i = 0; i < pids.length; i++) {
        var kind = pidKind(st, pids[i]);
        if (kind && kind !== 'pat' && kind !== 'pmt') flushPendingPes(st, pids[i], kind, out);
        else delete st.pes[pids[i]];
      }
      flushVideo(st, out);
      dropAudioRemainder(st, out);
      return finish(st, out);
    }

    return {
      TS_PACKET_SIZE: TS_PACKET_SIZE, TS_TIMESCALE: TS_TIMESCALE,
      tsCreateState: tsCreateState, tsDemux: tsDemux, tsFlush: tsFlush, tsUnwrapPts: tsUnwrapPts,
      splitNalUnits: splitNalUnits, nalType: nalType, toAvcc: toAvcc, unescapeRbsp: unescapeRbsp, parseSps: parseSps,
      parseAdts: parseAdts, parseMpegAudioHeader: parseMpegAudioHeader, parsePat: parsePat, parsePmt: parsePmt
    };
  })();

  /* ===== MP4: fragmented-MP4 muxer (ISO 14496-12/14/15) + tolerant box parser ===== */
  var MP4 = (function () {
    'use strict';

    var concatBytes = UTIL.concatBytes, u16be = UTIL.u16be, u24be = UTIL.u24be, u32be = UTIL.u32be, u64be = UTIL.u64be;
    var writeU16be = UTIL.writeU16be, writeU32be = UTIL.writeU32be, writeU64be = UTIL.writeU64be;

    // AudioSpecificConfig samplingFrequencyIndex table (ISO 14496-3 §1.6.3.4).
    var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    // trun sample_flags (ISO 14496-12 §8.8.3.1): a sync sample depends on nothing (depends_on=2); every other
    // sample depends on another (depends_on=1) and carries the non-sync bit, which is what MSE keys seeking on.
    var SAMPLE_FLAG_KEY = 0x02000000, SAMPLE_FLAG_NONKEY = 0x01010000;
    var TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
    var TRUN_FLAGS_FULL = 0x000f01; // data-offset | duration | size | flags | composition-offset per sample
    // Identity transform in the 16.16 (and 2.30 for the last entry) fixed-point matrix layout.
    var MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
    var LANG_UND = 0x55c4; // 'und' packed as three 5-bit letters
    // Profiles whose avcC carries the chroma/bit-depth extension (14496-15 §5.3.3.1.2). 144 is the retired
    // High 4:4:4 profile from the 2010 text, 244 its High 4:4:4 Predictive successor; both are listed there.
    var AVC_HIGH_PROFILES = [100, 110, 122, 144, 244];
    // Real files nest at most ~6 deep (moov/trak/mdia/minf/stbl); the cap keeps a hostile "box inside box inside
    // box…" buffer from recursing until the stack dies, since every nested box costs only 8 bytes of input.
    var MAX_DEPTH = 12;
    // A trun with no per-sample fields (all defaults) is parsed into a sample list of this size at most, so a
    // junk sample_count of 4 billion cannot allocate 4 billion entries.
    var MAX_DEFAULT_SAMPLES = 65536;

    var CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, mvex: 1, moof: 1, traf: 1, dinf: 1, edts: 1, mfra: 1, meta: 1 };
    var VIDEO_ENTRIES = { avc1: 1, avc2: 1, avc3: 1, avc4: 1, hvc1: 1, hev1: 1, av01: 1, vp08: 1, vp09: 1, mp4v: 1, dvh1: 1, dvhe: 1, dva1: 1, dvav: 1, encv: 1 };
    var AUDIO_ENTRIES = { mp4a: 1, 'ac-3': 1, 'ec-3': 1, 'ac-4': 1, Opus: 1, fLaC: 1, alac: 1, '.mp3': 1, samr: 1, sawb: 1, enca: 1 };
    var FIXED_AUDIO_CODECS = { 'ac-3': 'ac-3', 'ec-3': 'ec-3', 'ac-4': 'ac-4', Opus: 'opus', fLaC: 'flac', alac: 'alac', '.mp3': 'mp3' };

    /* ---------- input coercion (cross-realm safe: instanceof fails across vm contexts) ---------- */
    function isArrayBuffer(x) { return Object.prototype.toString.call(x) === '[object ArrayBuffer]'; }
    function toBytes(x) {
      if (x == null) return null;
      if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
      if (isArrayBuffer(x)) return new Uint8Array(x);
      if (Array.isArray(x)) return new Uint8Array(x);
      return null;
    }
    function toUint(v, max) {
      v = +v;
      if (!(v >= 0)) return 0; // NaN, negative, non-numeric
      v = Math.floor(v);
      return max != null && v > max ? max : v;
    }
    function toInt32(v) {
      v = +v;
      if (v !== v) return 0;
      v = Math.trunc(v);
      return v > 0x7fffffff ? 0x7fffffff : v < -0x80000000 ? -0x80000000 : v;
    }
    function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    /* ---------- byte writers ---------- */
    function b8(v) { return new Uint8Array([v & 0xff]); }
    function b16(v) { var b = new Uint8Array(2); writeU16be(b, 0, v); return b; }
    function b32(v) { var b = new Uint8Array(4); writeU32be(b, 0, v); return b; }
    function b64(v) { var b = new Uint8Array(8); writeU64be(b, 0, v); return b; }
    function b32s(list) { var b = new Uint8Array(list.length * 4); for (var i = 0; i < list.length; i++) writeU32be(b, i * 4, list[i]); return b; }
    function zeros(n) { return new Uint8Array(n); }
    function fourcc(s) {
      s = (String(s == null ? '' : s) + '    ').slice(0, 4);
      var b = new Uint8Array(4);
      for (var i = 0; i < 4; i++) b[i] = s.charCodeAt(i) & 0xff;
      return b;
    }
    function cstr(s) { return concatBytes([UTIL.bytesOfText(s), b8(0)]); }
    function collectPayloads(args, from) {
      var parts = [];
      for (var i = from; i < args.length; i++) { var p = toBytes(args[i]); if (p) parts.push(p); }
      return parts;
    }

    // box = u32 size | 4cc type | payload…  Payloads are byte views, ArrayBuffers or arrays of byte values;
    // null/undefined payloads are skipped so optional pieces can be passed straight through.
    function mp4Box(type) {
      var parts = collectPayloads(arguments, 1), n = 8, i;
      for (i = 0; i < parts.length; i++) n += parts[i].length;
      var out = new Uint8Array(n);
      writeU32be(out, 0, n);
      out.set(fourcc(type), 4);
      for (i = 0, n = 8; i < parts.length; i++) { out.set(parts[i], n); n += parts[i].length; }
      return out;
    }
    // FullBox = box whose payload starts with u8 version | u24 flags.
    function mp4FullBox(type, version, flags) {
      var args = [type, b32(((toUint(version, 255) << 24) | toUint(flags, 0xffffff)) >>> 0)];
      return mp4Box.apply(null, args.concat(collectPayloads(arguments, 3)));
    }

    /* ---------- AAC AudioSpecificConfig ---------- */
    // Channel count → channel_configuration: identical for 1–7 (7 = 7.1 is 8 speakers), 8 → 7.
    function channelConfigOf(channels) {
      var n = toUint(channels, 8);
      return n === 8 ? 7 : n;
    }
    // 5 bits audioObjectType | 4 bits samplingFrequencyIndex | 4 bits channelConfiguration | 3 zero bits
    // (frameLengthFlag, dependsOnCoreCoder, extensionFlag) — the 2-byte form every AAC-LC/HE stream uses.
    function aacConfigBytes(objectType, sampleRateIndex, channels) {
      var ot = toUint(objectType, 31) || 2, sri = toUint(sampleRateIndex, 15), ch = channelConfigOf(channels);
      return new Uint8Array([(ot << 3) | (sri >> 1), ((sri & 1) << 7) | (ch << 3)]);
    }
    function rateIndexOf(sampleRate) {
      var best = 3, bestDist = Infinity; // 48 kHz when nothing is known
      for (var i = 0; i < AAC_RATES.length; i++) {
        var d = Math.abs(AAC_RATES[i] - sampleRate);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return best;
    }

    /* ---------- track normalisation ---------- */
    function normalizeTrack(t) {
      if (!t || typeof t !== 'object') return null;
      var type = t.type === 'video' || t.type === 'audio' ? t.type : null;
      var id = toUint(t.id, 0xffffffff), timescale = toUint(t.timescale, 0xffffffff);
      if (!type || !id || !timescale) return null;
      var out = { id: id, type: type, timescale: timescale };
      if (type === 'video') {
        var sps = toBytes(t.sps), pps = toBytes(t.pps);
        // avcC needs profile/compat/level from sps[1..3] and u16 lengths, so anything shorter or longer is junk.
        if (!sps || sps.length < 4 || sps.length > 0xffff || !pps || !pps.length || pps.length > 0xffff) return null;
        out.sps = sps; out.pps = pps;
        out.width = toUint(t.width, 0xffff); out.height = toUint(t.height, 0xffff);
        out.chromaFormat = t.chromaFormat == null ? 1 : toUint(t.chromaFormat, 3);
        var depth = t.bitDepth == null ? 8 : toUint(t.bitDepth, 15);
        out.bitDepthLuma = t.bitDepthLuma == null ? depth : toUint(t.bitDepthLuma, 15);
        out.bitDepthChroma = t.bitDepthChroma == null ? depth : toUint(t.bitDepthChroma, 15);
        if (out.bitDepthLuma < 8) out.bitDepthLuma = 8;
        if (out.bitDepthChroma < 8) out.bitDepthChroma = 8;
      } else {
        var a = t.audio && typeof t.audio === 'object' ? t.audio : {};
        var codec = String(t.codec == null ? '' : t.codec).toLowerCase();
        var sri = +a.sampleRateIndex, rate = toUint(a.sampleRate, 0xffffffff);
        // Indices 13/14 are reserved and 15 means "explicit rate", which the 2-byte config cannot carry.
        if (!(sri >= 0 && sri <= 12 && sri === Math.floor(sri))) sri = rateIndexOf(rate || timescale);
        out.audio = {
          mp3: codec === 'mp3' || codec.indexOf('mp4a.6b') === 0 || codec.indexOf('mp4a.69') === 0,
          objectType: toUint(a.objectType, 31) || 2,
          sampleRateIndex: sri,
          sampleRate: rate || AAC_RATES[sri],
          channels: toUint(a.channels, 0xffff) || 2,
          bitrate: toUint(a.bitrate, 0xffffffff)
        };
      }
      return out;
    }
    function normalizeTracks(tracks) {
      var out = [], seen = {};
      if (!Array.isArray(tracks)) return out;
      for (var i = 0; i < tracks.length; i++) {
        var t = normalizeTrack(tracks[i]);
        if (t && !seen[t.id]) { seen[t.id] = 1; out.push(t); } // a duplicate id would make an unplayable moov
      }
      return out;
    }

    /* ---------- init segment (ftyp + moov) ---------- */
    function ftyp() {
      // iso5 (64-bit tfdt, default-base-is-moof) with the brands every MSE implementation accepts.
      return mp4Box('ftyp', fourcc('iso5'), b32(1), fourcc('iso5'), fourcc('iso6'), fourcc('mp41'), fourcc('avc1'));
    }
    function mvhd(nextTrackId) {
      return mp4FullBox('mvhd', 0, 0,
        b32(0), b32(0),                 // creation / modification time: a live remux has no authored date
        b32(1000), b32(0),              // timescale 1000; duration 0 = the fragments define the timeline
        b32(0x00010000), b16(0x0100),   // rate 1.0, volume 1.0
        zeros(10),                      // reserved
        b32s(MATRIX), zeros(24),        // identity matrix, pre_defined[6]
        b32(nextTrackId));
    }
    function tkhd(t) {
      var video = t.type === 'video';
      return mp4FullBox('tkhd', 0, 7, // enabled | in_movie | in_preview
        b32(0), b32(0), b32(t.id), b32(0), b32(0), // times, track id, reserved, duration 0
        zeros(8), b16(0), b16(0),                  // reserved, layer, alternate_group
        b16(video ? 0 : 0x0100), b16(0),           // volume 1.0 only means something for audio
        b32s(MATRIX),
        b16(video ? t.width : 0), b16(0), b16(video ? t.height : 0), b16(0)); // 16.16 fixed point
    }
    function mdhd(t) {
      return mp4FullBox('mdhd', 0, 0, b32(0), b32(0), b32(t.timescale), b32(0), b16(LANG_UND), b16(0));
    }
    function hdlr(t) {
      var video = t.type === 'video';
      return mp4FullBox('hdlr', 0, 0, b32(0), fourcc(video ? 'vide' : 'soun'), zeros(12), cstr(video ? 'VideoHandler' : 'SoundHandler'));
    }
    function dinf() {
      // One self-contained data reference: the samples live in this file (flags 1).
      return mp4Box('dinf', mp4FullBox('dref', 0, 0, b32(1), mp4FullBox('url ', 0, 1)));
    }
    function avcC(t) {
      var sps = t.sps, pps = t.pps;
      var parts = ['avcC', b8(1), b8(sps[1]), b8(sps[2]), b8(sps[3]), // configurationVersion, profile, compat, level
        b8(0xff),                      // reserved 111111 | lengthSizeMinusOne 3 → 4-byte NAL length prefixes
        b8(0xe1), b16(sps.length), sps, // reserved 111 | 1 SPS
        b8(1), b16(pps.length), pps];
      if (AVC_HIGH_PROFILES.indexOf(sps[1]) !== -1) {
        parts.push(b8(0xfc | t.chromaFormat), b8(0xf8 | (t.bitDepthLuma - 8)), b8(0xf8 | (t.bitDepthChroma - 8)), b8(0)); // no SPS extensions
      }
      return mp4Box.apply(null, parts);
    }
    function avc1(t) {
      return mp4Box('avc1',
        zeros(6), b16(1),                   // reserved, data_reference_index → the single dref entry
        b16(0), b16(0), zeros(12),          // pre_defined, reserved, pre_defined[3]
        b16(t.width), b16(t.height),
        b32(0x00480000), b32(0x00480000),   // 72 dpi, 16.16
        b32(0), b16(1),                     // reserved, frame_count
        zeros(32),                          // compressorname (empty)
        b16(0x0018), b16(0xffff),           // depth 24, pre_defined -1
        avcC(t));
    }
    // 14496-1 expandable length: 7 bits per byte, high bit = "more bytes follow".
    function expandableLength(n) {
      var out = [n & 0x7f];
      for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 0x7f) | 0x80);
      return new Uint8Array(out);
    }
    function descriptor(tag) {
      var body = concatBytes(collectPayloads(arguments, 1));
      return concatBytes([b8(tag), expandableLength(body.length), body]);
    }
    function esds(a) {
      // MP3 in MP4 carries no DecoderSpecificInfo: the frame headers describe the stream (14496-14 §5.6).
      var dsi = a.mp3 ? null : descriptor(0x05, aacConfigBytes(a.objectType, a.sampleRateIndex, a.channels));
      var decoderConfig = descriptor(0x04,
        b8(a.mp3 ? 0x6b : 0x40),         // objectTypeIndication: MPEG-1 audio | MPEG-4 audio
        b8(0x15),                        // streamType 5 (audio) << 2 | upStream 0 | reserved 1
        zeros(3),                        // bufferSizeDB
        b32(a.bitrate), b32(a.bitrate),  // maxBitrate, avgBitrate (0 = unknown)
        dsi);
      var es = descriptor(0x03, b16(0), b8(0), decoderConfig, descriptor(0x06, b8(0x02))); // ES_ID 0, no flags, SL predefined 2
      return mp4FullBox('esds', 0, 0, es);
    }
    function mp4a(t) {
      var a = t.audio;
      return mp4Box('mp4a',
        zeros(6), b16(1),                       // reserved, data_reference_index
        zeros(8),                               // version, revision, vendor
        b16(a.channels), b16(16),               // channelcount, samplesize
        b16(0), b16(0),                         // pre_defined, reserved
        b16(a.sampleRate <= 0xffff ? a.sampleRate : 0), b16(0), // samplerate 16.16; mdhd carries rates this field cannot
        esds(a));
    }
    function stbl(t) {
      return mp4Box('stbl',
        mp4FullBox('stsd', 0, 0, b32(1), t.type === 'video' ? avc1(t) : mp4a(t)),
        mp4FullBox('stts', 0, 0, b32(0)),          // sample tables stay empty: every sample arrives in a moof
        mp4FullBox('stsc', 0, 0, b32(0)),
        mp4FullBox('stsz', 0, 0, b32(0), b32(0)),  // sample_size 0, sample_count 0
        mp4FullBox('stco', 0, 0, b32(0)));
    }
    function minf(t) {
      var header = t.type === 'video' ? mp4FullBox('vmhd', 0, 1, zeros(8)) : mp4FullBox('smhd', 0, 0, zeros(4));
      return mp4Box('minf', header, dinf(), stbl(t));
    }
    function trak(t) {
      return mp4Box('trak', tkhd(t), mp4Box('mdia', mdhd(t), hdlr(t), minf(t)));
    }
    function trex(t) {
      return mp4FullBox('trex', 0, 0, b32(t.id), b32(1), b32(0), b32(0), b32(0));
    }
    // → ftyp + moov for the given tracks, or null when no track is usable (MSE rejects a trackless moov).
    function mp4InitSegment(tracks) {
      var list = normalizeTracks(tracks);
      if (!list.length) return null;
      var maxId = 0, i;
      for (i = 0; i < list.length; i++) if (list[i].id > maxId) maxId = list[i].id;
      var boxes = ['moov', mvhd(maxId + 1)];
      for (i = 0; i < list.length; i++) boxes.push(trak(list[i]));
      boxes.push(mp4Box.apply(null, ['mvex'].concat(list.map(trex))));
      return concatBytes([ftyp(), mp4Box.apply(null, boxes)]);
    }

    /* ---------- media segment (moof + mdat) ---------- */
    // samples: [{data (bytes), duration (track timescale), cts (pts−dts, may be negative), key (bool)}].
    // Entries without byte data are skipped as junk; null when nothing is left or the track has no id.
    function mp4MediaSegment(track, samples, opts) {
      var id = track && typeof track === 'object' ? toUint(track.id, 0xffffffff) : 0;
      if (!id || !Array.isArray(samples)) return null;
      var list = [], total = 0, i, s;
      for (i = 0; i < samples.length; i++) {
        s = samples[i];
        var data = s && typeof s === 'object' ? toBytes(s.data) : null;
        if (!data || !data.length) continue;
        list.push({ data: data, duration: toUint(s.duration, 0xffffffff), cts: toInt32(s.cts), flags: s.key ? SAMPLE_FLAG_KEY : SAMPLE_FLAG_NONKEY });
        total += data.length;
      }
      var n = list.length;
      if (!n) return null;
      opts = opts && typeof opts === 'object' ? opts : {};
      var table = new Uint8Array(n * 16);
      for (i = 0; i < n; i++) {
        s = list[i];
        writeU32be(table, i * 16, s.duration);
        writeU32be(table, i * 16 + 4, s.data.length);
        writeU32be(table, i * 16 + 8, s.flags);
        writeU32be(table, i * 16 + 12, s.cts); // two's complement via >>> inside writeU32be
      }
      var moof = mp4Box('moof',
        mp4FullBox('mfhd', 0, 0, b32(toUint(opts.sequenceNumber, 0xffffffff) || 1)),
        mp4Box('traf',
          mp4FullBox('tfhd', 0, TFHD_DEFAULT_BASE_IS_MOOF, b32(id)),
          mp4FullBox('tfdt', 1, 0, b64(toUint(opts.baseMediaDecodeTime, 0x1fffffffffffff))),
          mp4FullBox('trun', 1, TRUN_FLAGS_FULL, b32(n), b32(0), table)));
      // data_offset is the 4 bytes just before the sample table (sample_count precedes it); with
      // default-base-is-moof it is relative to the moof start, so the first sample begins right after the mdat header.
      writeU32be(moof, moof.length - n * 16 - 4, moof.length + 8);
      var out = new Uint8Array(moof.length + 8 + total), o = moof.length;
      out.set(moof, 0);
      writeU32be(out, o, 8 + total);
      out.set(fourcc('mdat'), o + 4);
      for (i = 0, o += 8; i < n; i++) { out.set(list[i].data, o); o += list[i].data.length; }
      return out;
    }

    /* ---------- parser ---------- */
    function fourccAt(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
    function fullHeader(box, bytes, s, e) {
      if (e - s < 4) return false;
      box.version = bytes[s];
      box.flags = u24be(bytes, s + 1);
      return true;
    }
    function findChild(box, type) {
      var kids = box && box.children ? box.children : [];
      for (var i = 0; i < kids.length; i++) if (kids[i].type === type) return kids[i];
      return null;
    }
    function childrenOf(box, type) {
      return (box && box.children ? box.children : []).filter(function (b) { return b.type === type; });
    }

    function parseFull(box, bytes, s, e) { fullHeader(box, bytes, s, e); }
    function parseFtyp(box, bytes, s, e) {
      if (e - s < 8) return;
      box.majorBrand = fourccAt(bytes, s);
      box.minorVersion = u32be(bytes, s + 4);
      box.compatibleBrands = [];
      for (var p = s + 8; p + 4 <= e; p += 4) box.compatibleBrands.push(fourccAt(bytes, p));
    }
    function parseMvhd(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e)) return;
      var v1 = box.version === 1;
      if (e - s < (v1 ? 112 : 100)) return;
      box.timescale = u32be(bytes, s + (v1 ? 20 : 12));
      box.duration = v1 ? u64be(bytes, s + 24) : u32be(bytes, s + 16);
      box.nextTrackId = u32be(bytes, e - 4);
    }
    function parseTkhd(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e)) return;
      var v1 = box.version === 1;
      if (e - s < (v1 ? 96 : 84)) return;
      box.trackId = u32be(bytes, s + (v1 ? 20 : 12));
      box.duration = v1 ? u64be(bytes, s + 28) : u32be(bytes, s + 20);
      box.width = u32be(bytes, e - 8) / 65536;
      box.height = u32be(bytes, e - 4) / 65536;
    }
    function parseMdhd(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e)) return;
      var v1 = box.version === 1;
      if (e - s < (v1 ? 36 : 24)) return;
      box.timescale = u32be(bytes, s + (v1 ? 20 : 12));
      box.duration = v1 ? u64be(bytes, s + 24) : u32be(bytes, s + 16);
      var lang = u16be(bytes, s + (v1 ? 32 : 20));
      box.language = String.fromCharCode(0x60 + ((lang >> 10) & 31), 0x60 + ((lang >> 5) & 31), 0x60 + (lang & 31));
    }
    function parseHdlr(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e) || e - s < 24) return;
      box.handlerType = fourccAt(bytes, s + 8);
      box.name = UTIL.textOf(bytes.subarray(s + 24, e)).replace(/\0+$/, '');
    }
    function parseTrex(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e) || e - s < 24) return;
      box.trackId = u32be(bytes, s + 4);
      box.defaultSampleDescriptionIndex = u32be(bytes, s + 8);
      box.defaultSampleDuration = u32be(bytes, s + 12);
      box.defaultSampleSize = u32be(bytes, s + 16);
      box.defaultSampleFlags = u32be(bytes, s + 20);
    }
    function parseElst(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e) || e - s < 8) return;
      var v1 = box.version === 1, entrySize = v1 ? 20 : 12, count = u32be(bytes, s + 4), p = s + 8;
      box.entries = [];
      for (var i = 0; i < count && p + entrySize <= e; i++, p += entrySize) {
        // media_time is signed; -1 (an empty edit) is the only negative value the format defines, and a
        // 64-bit -1 cannot survive the double conversion in u64be, so the sign bit decides.
        var mediaTime = v1 ? ((u32be(bytes, p + 8) & 0x80000000) ? -1 : u64be(bytes, p + 8)) : (u32be(bytes, p + 4) | 0);
        box.entries.push({
          segmentDuration: v1 ? u64be(bytes, p) : u32be(bytes, p),
          mediaTime: mediaTime,
          mediaRate: (u16be(bytes, p + (v1 ? 16 : 8)) << 16 >> 16) + u16be(bytes, p + (v1 ? 18 : 10)) / 65536
        });
      }
      if (box.entries.length < count) box.truncated = true;
    }
    function parseMfhd(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e) || e - s < 8) return;
      box.sequenceNumber = u32be(bytes, s + 4);
    }
    function parseTfhd(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e) || e - s < 8) return;
      var f = box.flags, p = s + 8;
      box.trackId = u32be(bytes, s + 4);
      box.baseDataOffset = null; box.sampleDescriptionIndex = null;
      box.defaultSampleDuration = null; box.defaultSampleSize = null; box.defaultSampleFlags = null;
      box.durationIsEmpty = !!(f & 0x10000);
      box.defaultBaseIsMoof = !!(f & TFHD_DEFAULT_BASE_IS_MOOF);
      if ((f & 0x01) && p + 8 <= e) { box.baseDataOffset = u64be(bytes, p); p += 8; }
      if ((f & 0x02) && p + 4 <= e) { box.sampleDescriptionIndex = u32be(bytes, p); p += 4; }
      if ((f & 0x08) && p + 4 <= e) { box.defaultSampleDuration = u32be(bytes, p); p += 4; }
      if ((f & 0x10) && p + 4 <= e) { box.defaultSampleSize = u32be(bytes, p); p += 4; }
      if ((f & 0x20) && p + 4 <= e) { box.defaultSampleFlags = u32be(bytes, p); }
    }
    function parseTfdt(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e)) return;
      if (box.version === 1 && e - s >= 12) box.baseMediaDecodeTime = u64be(bytes, s + 4);
      else if (box.version !== 1 && e - s >= 8) box.baseMediaDecodeTime = u32be(bytes, s + 4);
    }
    function parseTrun(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e) || e - s < 8) return;
      var f = box.flags, p = s + 8, v1 = box.version === 1;
      var hasDur = !!(f & 0x100), hasSize = !!(f & 0x200), hasFlags = !!(f & 0x400), hasCts = !!(f & 0x800);
      var perSample = (hasDur ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlags ? 4 : 0) + (hasCts ? 4 : 0);
      box.sampleCount = u32be(bytes, s + 4);
      box.dataOffset = null; box.firstSampleFlags = null; box.samples = [];
      if ((f & 0x01) && p + 4 <= e) { box.dataOffset = u32be(bytes, p) | 0; p += 4; }
      if ((f & 0x04) && p + 4 <= e) { box.firstSampleFlags = u32be(bytes, p); p += 4; }
      var n = perSample ? box.sampleCount : Math.min(box.sampleCount, MAX_DEFAULT_SAMPLES);
      for (var i = 0; i < n; i++) {
        if (p + perSample > e) { box.truncated = true; break; }
        var smp = { duration: null, size: null, flags: null, cts: null };
        if (hasDur) { smp.duration = u32be(bytes, p); p += 4; }
        if (hasSize) { smp.size = u32be(bytes, p); p += 4; }
        if (hasFlags) { smp.flags = u32be(bytes, p); p += 4; }
        if (hasCts) { smp.cts = v1 ? (u32be(bytes, p) | 0) : u32be(bytes, p); p += 4; }
        box.samples.push(smp);
      }
      if (n < box.sampleCount) box.truncated = true;
    }
    function parseSidx(box, bytes, s, e) {
      if (!fullHeader(box, bytes, s, e)) return;
      var v1 = box.version === 1, head = v1 ? 32 : 24;
      if (e - s < head) return;
      box.referenceId = u32be(bytes, s + 4);
      box.timescale = u32be(bytes, s + 8);
      box.earliestPresentationTime = v1 ? u64be(bytes, s + 12) : u32be(bytes, s + 12);
      box.firstOffset = v1 ? u64be(bytes, s + 20) : u32be(bytes, s + 16);
      var count = u16be(bytes, s + head - 2), p = s + head;
      box.references = [];
      for (var i = 0; i < count && p + 12 <= e; i++, p += 12) {
        var a = u32be(bytes, p), c = u32be(bytes, p + 8);
        box.references.push({
          referenceType: a >>> 31, referencedSize: a & 0x7fffffff, subsegmentDuration: u32be(bytes, p + 4),
          startsWithSap: c >>> 31, sapType: (c >>> 28) & 7, sapDeltaTime: c & 0x0fffffff
        });
      }
      if (box.references.length < count) box.truncated = true;
    }

    /* ----- sample entries (stsd) and codec strings ----- */
    function parseAvcC(d) {
      if (d.length < 7) return null;
      var out = { configurationVersion: d[0], profile: d[1], compat: d[2], level: d[3], lengthSizeMinusOne: d[4] & 3, sps: [], pps: [], chromaFormat: null, bitDepthLuma: null, bitDepthChroma: null };
      var p = 6, n = d[5] & 31, i, len;
      for (i = 0; i < n && p + 2 <= d.length; i++) { len = u16be(d, p); p += 2; if (p + len > d.length) return out; out.sps.push(d.subarray(p, p + len)); p += len; }
      if (p >= d.length) return out;
      n = d[p++];
      for (i = 0; i < n && p + 2 <= d.length; i++) { len = u16be(d, p); p += 2; if (p + len > d.length) return out; out.pps.push(d.subarray(p, p + len)); p += len; }
      if (AVC_HIGH_PROFILES.indexOf(out.profile) !== -1 && p + 3 <= d.length) {
        out.chromaFormat = d[p] & 3;
        out.bitDepthLuma = (d[p + 1] & 7) + 8;
        out.bitDepthChroma = (d[p + 2] & 7) + 8;
      }
      return out;
    }
    function reverseBits32(v) {
      var r = 0;
      for (var i = 0; i < 32; i++) { r = (r << 1) | (v & 1); v >>>= 1; }
      return r >>> 0;
    }
    function parseHvcC(d) {
      if (d.length < 13) return null;
      return { profileSpace: d[1] >> 6, tier: (d[1] >> 5) & 1, profileIdc: d[1] & 31, compat: u32be(d, 2), constraints: d.subarray(6, 12), level: d[12] };
    }
    // 14496-15 Annex E.3: hvc1.<space><profile>.<compat flags bit-reversed, hex>.<L|H><level>[.<constraint bytes, trailing zeros dropped>]
    function hevcCodecString(type, h) {
      var s = type + '.' + ['', 'A', 'B', 'C'][h.profileSpace] + h.profileIdc + '.' + reverseBits32(h.compat).toString(16).toUpperCase() + '.' + (h.tier ? 'H' : 'L') + h.level;
      var last = h.constraints.length;
      while (last > 0 && h.constraints[last - 1] === 0) last--;
      for (var i = 0; i < last; i++) s += '.' + hex2(h.constraints[i]).toUpperCase();
      return s;
    }
    function av1CodecString(d) {
      if (d.length < 4) return 'av01';
      var profile = d[1] >> 5, level = d[1] & 31, tier = d[2] >> 7, high = (d[2] >> 6) & 1, twelve = (d[2] >> 5) & 1;
      return 'av01.' + profile + '.' + pad2(level) + (tier ? 'H' : 'M') + '.' + pad2(high ? (twelve ? 12 : 10) : 8);
    }
    function vp9CodecString(type, d) {
      // vpcC is a FullBox: profile, level, bitDepth(4)|chromaSubsampling(3)|fullRange(1) follow version/flags.
      if (d.length < 7) return type;
      return type + '.' + pad2(d[4]) + '.' + pad2(d[5]) + '.' + pad2(d[6] >> 4);
    }
    // 14496-1 descriptor header: tag, then an expandable length (ffmpeg always writes the 4-byte form 80 80 80 nn).
    function readDescriptor(d, p, end) {
      if (p + 2 > end) return null;
      var tag = d[p++], len = 0, b;
      for (var i = 0; i < 4; i++) {
        if (p >= end) return null;
        b = d[p++];
        len = len * 128 + (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return { tag: tag, start: p, end: Math.min(p + len, end) }; // an overstated length is clipped, not fatal
    }
    function parseAudioSpecificConfig(d) {
      if (!d || d.length < 2) return null;
      var pos = 0;
      function bits(n) {
        var v = 0;
        for (var i = 0; i < n; i++, pos++) { var byte = pos >> 3 < d.length ? d[pos >> 3] : 0; v = v * 2 + ((byte >> (7 - (pos & 7))) & 1); }
        return v;
      }
      var ot = bits(5);
      if (ot === 31) ot = 32 + bits(6);
      var sri = bits(4), rate = sri === 15 ? bits(24) : (sri < AAC_RATES.length ? AAC_RATES[sri] : null);
      return { audioObjectType: ot, samplingFrequencyIndex: sri, sampleRate: rate, channelConfiguration: bits(4) };
    }
    function parseEsds(d) {
      var out = { objectTypeIndication: null, streamType: null, maxBitrate: null, avgBitrate: null, decoderSpecificInfo: null, audioObjectType: null, samplingFrequencyIndex: null, sampleRate: null, channelConfiguration: null };
      var end = d.length;
      if (end < 4) return out;
      var es = readDescriptor(d, 4, end);
      if (!es || es.tag !== 0x03 || es.end - es.start < 3) return out;
      var p = es.start + 3, esFlags = d[es.start + 2];
      if (esFlags & 0x80) p += 2;                                  // dependsOn_ES_ID
      if (esFlags & 0x40) p += 1 + (p < es.end ? d[p] : 0);        // URL
      if (esFlags & 0x20) p += 2;                                  // OCR_ES_Id
      while (p < es.end) {
        var h = readDescriptor(d, p, es.end);
        if (!h) break;
        if (h.tag === 0x04 && h.end - h.start >= 13) {
          out.objectTypeIndication = d[h.start];
          out.streamType = d[h.start + 1] >> 2;
          out.maxBitrate = u32be(d, h.start + 5);
          out.avgBitrate = u32be(d, h.start + 9);
          for (var q = h.start + 13; q < h.end;) {
            var g = readDescriptor(d, q, h.end);
            if (!g) break;
            if (g.tag === 0x05) out.decoderSpecificInfo = d.subarray(g.start, g.end);
            q = g.end;
          }
        }
        p = h.end;
      }
      var oti = out.objectTypeIndication;
      if (out.decoderSpecificInfo && (oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68)) {
        var asc = parseAudioSpecificConfig(out.decoderSpecificInfo);
        if (asc) { out.audioObjectType = asc.audioObjectType; out.samplingFrequencyIndex = asc.samplingFrequencyIndex; out.sampleRate = asc.sampleRate; out.channelConfiguration = asc.channelConfiguration; }
      }
      return out;
    }
    function entryCodec(entry) {
      var t = entry.type, c;
      if (t === 'avc1' || t === 'avc2' || t === 'avc3' || t === 'avc4') {
        c = findChild(entry, 'avcC');
        entry.avcC = c ? parseAvcC(c.data) : null;
        // RFC 6381: <entry type>.<profile><compat><level> as 6 hex digits, e.g. avc1.64001f
        return entry.avcC ? t + '.' + hex2(entry.avcC.profile) + hex2(entry.avcC.compat) + hex2(entry.avcC.level) : t;
      }
      if (t === 'hvc1' || t === 'hev1') {
        c = findChild(entry, 'hvcC');
        entry.hvcC = c ? parseHvcC(c.data) : null;
        return entry.hvcC ? hevcCodecString(t, entry.hvcC) : t;
      }
      if (t === 'av01') { c = findChild(entry, 'av1C'); return c ? av1CodecString(c.data) : t; }
      if (t === 'vp08' || t === 'vp09') { c = findChild(entry, 'vpcC'); return c ? vp9CodecString(t, c.data) : t; }
      if (t === 'mp4a') {
        c = findChild(entry, 'esds');
        if (!c) { // QuickTime wraps esds in a 'wave' atom inside version-1 sound entries
          var wave = findChild(entry, 'wave');
          c = wave ? findChild({ children: parseRange(wave.data, 0, wave.data.length, MAX_DEPTH).boxes }, 'esds') : null;
        }
        entry.esds = c ? parseEsds(c.data) : null;
        var oti = entry.esds ? entry.esds.objectTypeIndication : null;
        // No usable esds: AAC-LC is what nearly every mp4a track is, and MSE needs the object type to accept it.
        if (oti == null) return 'mp4a.40.2';
        var ot = entry.esds.audioObjectType;
        return 'mp4a.' + hex2(oti) + (oti === 0x40 ? '.' + (ot == null ? 2 : ot) : '');
      }
      if (FIXED_AUDIO_CODECS[t]) return FIXED_AUDIO_CODECS[t];
      return t.trim();
    }
    function parseStsd(box, bytes, s, e, depth) {
      if (!fullHeader(box, bytes, s, e) || e - s < 8) return;
      box.entryCount = u32be(bytes, s + 4);
      box.entries = [];
      for (var p = s + 8; p + 8 <= e && box.entries.length < box.entryCount;) {
        var size = u32be(bytes, p), type = fourccAt(bytes, p + 4), body = p + 8;
        if (size < 8 || p + size > e) { box.truncated = true; break; }
        var entry = { type: type, size: size, offset: p, codec: null, children: [] }, kids = -1;
        if (VIDEO_ENTRIES[type]) {
          entry.kind = 'video';
          if (size >= 86) { entry.width = u16be(bytes, body + 24); entry.height = u16be(bytes, body + 26); kids = body + 78; }
        } else if (AUDIO_ENTRIES[type]) {
          entry.kind = 'audio';
          if (size >= 36) {
            var version = u16be(bytes, body + 8);
            entry.channels = u16be(bytes, body + 16);
            entry.sampleSize = u16be(bytes, body + 18);
            entry.sampleRate = u16be(bytes, body + 24); // integer part of the 16.16 field
            // QuickTime v1 adds 16 bytes of packet sizing; v2 replaces the rate/channel fields with 36 bytes.
            kids = body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
            if (version === 2 && size >= 72) {
              entry.channels = u32be(bytes, body + 40);
              entry.sampleRate = new DataView(bytes.buffer, bytes.byteOffset + body + 32, 8).getFloat64(0);
            }
          }
        } else {
          entry.kind = 'unknown';
          entry.data = bytes.subarray(body, p + size);
        }
        if (kids >= 0 && kids <= p + size) entry.children = parseRange(bytes, kids, p + size, depth + 1).boxes;
        entry.codec = entry.kind === 'unknown' ? type.trim() : entryCodec(entry);
        box.entries.push(entry);
        p += size;
      }
      if (box.entries.length < box.entryCount) box.truncated = true;
    }

    var DETAILS = {
      ftyp: parseFtyp, styp: parseFtyp, mvhd: parseMvhd, tkhd: parseTkhd, mdhd: parseMdhd, hdlr: parseHdlr,
      stsd: parseStsd, trex: parseTrex, elst: parseElst, mfhd: parseMfhd, tfhd: parseTfhd, tfdt: parseTfdt,
      trun: parseTrun, sidx: parseSidx,
      vmhd: parseFull, smhd: parseFull, dref: parseFull, stts: parseFull, stsc: parseFull, stsz: parseFull, stco: parseFull
    };

    // Fill the per-sample fields a trun leaves out from the tfhd defaults (and first_sample_flags), so a
    // consumer sees one resolved {duration,size,flags,cts} per sample whatever the muxer chose to omit.
    function resolveTraf(traf) {
      var tfhd = findChild(traf, 'tfhd');
      var truns = childrenOf(traf, 'trun');
      for (var i = 0; i < truns.length; i++) {
        var tr = truns[i];
        for (var j = 0; j < tr.samples.length; j++) {
          var smp = tr.samples[j];
          if (smp.duration == null && tfhd) smp.duration = tfhd.defaultSampleDuration;
          if (smp.size == null && tfhd) smp.size = tfhd.defaultSampleSize;
          if (smp.flags == null) smp.flags = j === 0 && tr.firstSampleFlags != null ? tr.firstSampleFlags : (tfhd ? tfhd.defaultSampleFlags : null);
          if (smp.cts == null) smp.cts = 0;
        }
      }
    }

    function parseRange(bytes, start, end, depth) {
      var boxes = [], truncated = false, p = start;
      while (p < end) {
        if (end - p < 8) { truncated = true; break; }
        var size = u32be(bytes, p), type = fourccAt(bytes, p + 4), header = 8;
        if (size === 1) {
          if (end - p < 16) { truncated = true; break; }
          size = u64be(bytes, p + 8);
          header = 16;
        } else if (size === 0) {
          size = end - p; // "extends to the end of the file"
        }
        if (size < header || size > end - p) { truncated = true; break; } // cut short, or a size that cannot be
        var box = { type: type, size: size, offset: p, headerSize: header }, bodyStart = p + header, bodyEnd = p + size;
        // ISO 'meta' is a FullBox; QuickTime's is not. Version 0 / flags 0 is the only ISO form, so four zero
        // bytes there mean "skip them", anything else means the children start immediately.
        if (type === 'meta' && bodyEnd - bodyStart >= 4 && u32be(bytes, bodyStart) === 0) {
          box.version = 0; box.flags = 0;
          bodyStart += 4;
        }
        if (CONTAINERS[type] && depth < MAX_DEPTH) {
          var inner = parseRange(bytes, bodyStart, bodyEnd, depth + 1);
          box.children = inner.boxes;
          if (inner.truncated) box.truncated = true;
          if (type === 'traf') resolveTraf(box);
        } else {
          box.data = bytes.subarray(bodyStart, bodyEnd);
          if (DETAILS[type]) DETAILS[type](box, bytes, bodyStart, bodyEnd, depth);
        }
        boxes.push(box);
        p += size;
      }
      return { boxes: boxes, truncated: truncated };
    }
    // → array of boxes (see parseRange) with a `truncated` property: true when the top-level walk stopped
    // before the end of the input (a partial last box, or a size that does not fit). Containers that stop
    // early carry their own `truncated: true`.
    function mp4ParseBoxes(input) {
      var bytes = toBytes(input);
      var r = bytes ? parseRange(bytes, 0, bytes.length, 0) : { boxes: [], truncated: false };
      r.boxes.truncated = r.truncated;
      return r.boxes;
    }
    // Depth-first search for the first box of a type. Starts from a parsed array or any box; descends through
    // `children` and through stsd `entries` (each a box-shaped sample entry with its own children), so
    // avcC / esds / hvcC are reachable the same way as moov / trak.
    function nestedOf(box) { return box.children || box.entries || null; }
    function mp4FindBox(boxes, type) {
      var list = Array.isArray(boxes) ? boxes : (boxes && nestedOf(boxes)) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].type === type) return list[i];
        var hit = nestedOf(list[i]) ? mp4FindBox(list[i], type) : null;
        if (hit) return hit;
      }
      return null;
    }

    /* ---------- init-segment queries ---------- */
    var HANDLER_KIND = { vide: 'video', soun: 'audio', text: 'text', sbtl: 'text', subt: 'text', clcp: 'text', meta: 'meta' };
    function mp4TracksFromInit(bytes) {
      var moov = mp4FindBox(mp4ParseBoxes(bytes), 'moov'), out = [];
      if (!moov) return out;
      var traks = childrenOf(moov, 'trak');
      for (var i = 0; i < traks.length; i++) {
        var tkhd = findChild(traks[i], 'tkhd'), mdia = findChild(traks[i], 'mdia');
        var mdhd = findChild(mdia, 'mdhd'), hdlr = findChild(mdia, 'hdlr');
        var stsd = findChild(findChild(findChild(mdia, 'minf'), 'stbl'), 'stsd');
        var entry = stsd && stsd.entries && stsd.entries.length ? stsd.entries[0] : null;
        var kind = hdlr && HANDLER_KIND[hdlr.handlerType] ? HANDLER_KIND[hdlr.handlerType] : (entry && entry.kind !== 'unknown' ? entry.kind : 'unknown');
        out.push({
          id: tkhd && tkhd.trackId != null ? tkhd.trackId : i + 1,
          type: kind,
          timescale: mdhd && mdhd.timescale ? mdhd.timescale : null,
          codec: entry ? entry.codec : null,
          duration: mdhd && mdhd.duration != null ? mdhd.duration : 0,
          language: mdhd && mdhd.language ? mdhd.language : 'und',
          width: entry && entry.width != null ? entry.width : (tkhd && tkhd.width ? Math.round(tkhd.width) : 0),
          height: entry && entry.height != null ? entry.height : (tkhd && tkhd.height ? Math.round(tkhd.height) : 0),
          sampleRate: entry && entry.esds && entry.esds.sampleRate ? entry.esds.sampleRate : (entry && entry.sampleRate ? entry.sampleRate : 0),
          channels: entry && entry.esds && entry.esds.channelConfiguration ? entry.esds.channelConfiguration : (entry && entry.channels ? entry.channels : 0)
        });
      }
      return out;
    }
    function mp4CodecsFromInit(bytes) {
      return mp4TracksFromInit(bytes).map(function (t) { return t.codec; }).filter(function (c) { return !!c; });
    }
    function mp4Tfdt(bytes) {
      var moofs = mp4ParseBoxes(bytes).filter(function (b) { return b.type === 'moof'; });
      for (var i = 0; i < moofs.length; i++) {
        var tfdt = mp4FindBox(moofs[i], 'tfdt');
        if (tfdt && tfdt.baseMediaDecodeTime != null) return tfdt.baseMediaDecodeTime;
      }
      return null;
    }
    function mp4Sidx(bytes) {
      var sidx = mp4FindBox(mp4ParseBoxes(bytes), 'sidx');
      if (!sidx || sidx.references == null) return null;
      return { referenceId: sidx.referenceId, timescale: sidx.timescale, earliestPresentationTime: sidx.earliestPresentationTime, firstOffset: sidx.firstOffset, references: sidx.references };
    }

    return {
      mp4Box: mp4Box, mp4FullBox: mp4FullBox,
      mp4InitSegment: mp4InitSegment, mp4MediaSegment: mp4MediaSegment,
      mp4ParseBoxes: mp4ParseBoxes, mp4FindBox: mp4FindBox,
      mp4CodecsFromInit: mp4CodecsFromInit, mp4TracksFromInit: mp4TracksFromInit,
      mp4Tfdt: mp4Tfdt, mp4Sidx: mp4Sidx,
      aacConfigBytes: aacConfigBytes
    };
  })();

  /* ===== HLS: M3U8 playlists (RFC 8216 + Apple extensions), adaptive bitrate, live timing, buffer maths ===== */
  var HLS = (function () {
    'use strict';

    var MAX_ERRORS = 50;                 // junk input must not turn into a megabyte of error strings
    var DEFAULT_TARGET_DURATION = 10;    // used only when a media playlist omits the (required) tag
    var FIRST_GUESS_BPS = 1500000;       // with no throughput sample yet, start no higher than 1.5 Mbps
    var DEFAULT_SAFETY = 0.8, DEFAULT_UP_HYSTERESIS = 1.25, UP_BUFFER_SEC = 20;
    var DEFAULT_FAST_HALF_LIFE = 3, DEFAULT_SLOW_HALF_LIFE = 9;
    var LIVE_HOLD_TARGETS = 3;           // RFC 8216 §6.3.3: start ≥ 3 target durations from the live end
    var MIN_RELOAD_MS = 1000;
    var BUFFER_TOLERANCE = 0.1;          // buffered ranges closer than this are one range (frame-gap noise)
    var KEEP_BEHIND_SEC = 30;            // how much played media stays appended for instant short seeks back
    var GAP_JUMP_STALL_MS = 1000, GAP_JUMP_MAX_AHEAD = 2, GAP_JUMP_NUDGE = 0.05;
    var VAR_RE = /\{\$([A-Za-z0-9_-]+)\}/g; // EXT-X-DEFINE variable reference
    var isNum = UTIL.isNum;

    /* ---------- small helpers ---------- */
    function num(v) { return isNum(v) ? v : null; }
    function positiveOr(v, d) { return isNum(v) && v > 0 ? v : d; }
    function str(v) { return v === undefined || v === null || v === '' ? null : String(v); }
    function yes(v) { return String(v == null ? '' : v).toUpperCase() === 'YES'; }
    function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function hasSegments(pl) { return !!(pl && typeof pl === 'object' && Array.isArray(pl.segments)); }
    function lastSeqOf(pl) { return pl.segments.length ? pl.segments[pl.segments.length - 1].seq : null; }
    // Target duration with a fallback, because every live-timing rule divides or multiplies by it.
    function targetOf(pl) {
      if (isNum(pl.targetDuration) && pl.targetDuration > 0) return pl.targetDuration;
      var max = 0;
      for (var i = 0; i < pl.segments.length; i++) if (isNum(pl.segments[i].duration) && pl.segments[i].duration > max) max = pl.segments[i].duration;
      return max > 0 ? Math.ceil(max) : DEFAULT_TARGET_DURATION;
    }
    function holdBackOf(pl) { return pl.serverControl && isNum(pl.serverControl.holdBack) && pl.serverControl.holdBack > 0 ? pl.serverControl.holdBack : 0; }
    function textInput(text) {
      if (typeof text === 'string') return text;
      if (text && ArrayBuffer.isView(text)) return UTIL.textOf(new Uint8Array(text.buffer, text.byteOffset, text.byteLength));
      if (Object.prototype.toString.call(text) === '[object ArrayBuffer]') return UTIL.textOf(new Uint8Array(text));
      return null;
    }

    /* ---------- attribute lists (RFC 8216 §4.2) ---------- */
    function convertAttr(name, value, quoted) {
      if (name === 'CODECS') return value.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
      var res = /^(\d+)x(\d+)$/i.exec(value);
      if (name === 'RESOLUTION' && res) return { width: +res[1], height: +res[2] };
      if (quoted) return value;
      if (/^0x[0-9a-f]+$/i.test(value)) return value;          // hex stays text: IVs are 128-bit, far beyond a double
      if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
      return value;
    }
    // "NAME=value,NAME="quoted, with comma",…" → object. Tolerant: whitespace, missing close quote, junk tokens.
    function hlsParseAttributes(input) {
      var out = {};
      if (typeof input !== 'string') return out;
      var s = input, i = 0, n = s.length;
      while (i < n) {
        while (i < n && (s[i] === ',' || s[i] === ' ' || s[i] === '\t')) i++;
        if (i >= n) break;
        var j = i;
        while (j < n && s[j] !== '=' && s[j] !== ',') j++;
        if (j >= n || s[j] === ',') { i = j; continue; }     // token without '=' is not an attribute
        var name = s.slice(i, j).trim().toUpperCase();
        i = j + 1;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        var value, quoted = false;
        if (s[i] === '"') {
          var close = s.indexOf('"', i + 1);
          if (close === -1) close = n;
          value = s.slice(i + 1, close); quoted = true;
          var comma = s.indexOf(',', close + 1);
          i = comma === -1 ? n : comma + 1;
        } else {
          var end = s.indexOf(',', i);
          if (end === -1) end = n;
          value = s.slice(i, end).trim();
          i = end + 1;
        }
        if (name) out[name] = convertAttr(name, value, quoted);
      }
      return out;
    }
    function codecList(v) {
      if (Array.isArray(v)) return v.filter(function (c) { return typeof c === 'string' && c; });
      if (typeof v === 'string') return convertAttr('CODECS', v, true);
      return [];
    }
    function resolutionOf(v) { return v && isNum(v.width) && isNum(v.height) ? { width: v.width, height: v.height } : null; }
    // "<n>[@<o>]" (EXT-X-BYTERANGE tag value and BYTERANGE attribute).
    function parseByteRange(v) {
      var m = /^\s*(\d+)\s*(?:@\s*(\d+)\s*)?$/.exec(String(v == null ? '' : v));
      return m ? { length: +m[1], offset: m[2] === undefined ? null : +m[2] } : null;
    }
    function queryParam(url, name) {
      var p = UTIL.splitUrl(url), parts = p && p.query ? p.query.slice(1).split('&') : [];
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf('=');
        if ((eq === -1 ? parts[i] : parts[i].slice(0, eq)) === name) return eq === -1 ? '' : parts[i].slice(eq + 1);
      }
      return null;
    }

    /* ---------- playlist parser ---------- */
    function hlsParse(text, baseUrl, opts) {
      opts = opts || {};
      var base = typeof baseUrl === 'string' ? baseUrl.trim() : '';
      var errors = [], overflow = 0, unsupported = [], unknownTags = [], vars = {};
      function err(lineNo, msg) { if (errors.length < MAX_ERRORS) errors.push((lineNo ? 'line ' + lineNo + ': ' : '') + msg); else overflow++; }
      function note(what) { if (unsupported.indexOf(what) === -1) unsupported.push(what); }
      function resolve(uri) { return base ? UTIL.resolveUrl(base, uri) : uri; }
      function invalid(why) { return { kind: 'invalid', url: base || null, errors: [why].concat(errors) }; }

      var src = textInput(text);
      if (src === null) return invalid('playlist is not text');
      var lines = src.replace(/^﻿/, '').split(/\r\n|\n|\r/);

      var version = null, independentSegments = false, startOffset = null;
      var variants = [], media = [], iFrameStreams = 0, sessionData = [], sessionKeys = [];
      var targetDuration = null, mediaSequence = 0, discontinuitySequence = 0, playlistType = null, endList = false, iFramesOnly = false;
      var segments = [], serverControl = null, partInf = null, partCount = 0, preloadHints = [], renditionReports = [], skippedSegments = 0, dateRanges = [];
      var sawMasterTags = false, sawMediaTags = false;
      // Tags apply to the NEXT URI line (EXTINF, BYTERANGE, …) or to every following segment (KEY, MAP, BITRATE).
      var pendingStreamInf = null, pendingInf = null, pendingByteRange = null, pendingDisc = false, pendingGap = false, pendingPdt = null;
      var key = null, map = null, bitrate = null, discCount = 0, nextPdt = null, clock = 0, lastSeg = null;

      function substitute(s, lineNo) {
        if (s.indexOf('{$') === -1) return s;
        return s.replace(VAR_RE, function (m, name) {
          if (hasOwn(vars, name)) return vars[name];
          err(lineNo, 'undefined variable {$' + name + '}');
          return m;
        });
      }
      function parseIv(v, lineNo) {
        if (v === undefined) return null;
        var s = String(v);
        if (!/^0x[0-9a-f]+$/i.test(s)) { err(lineNo, 'EXT-X-KEY IV is not a hex value'); return null; }
        var hex = s.slice(2);
        if (hex.length !== 32) err(lineNo, 'EXT-X-KEY IV is ' + (hex.length * 4) + '-bit, expected 128');
        // Read it as one big-endian 128-bit integer: short values are zero-extended, long ones keep the low bits.
        return UTIL.bytesOfHex(('00000000000000000000000000000000' + hex).slice(-32));
      }
      // Returns a key object, null for METHOD=NONE, or undefined when the tag is unusable.
      function parseKey(a, lineNo, tag) {
        var method = String(a.METHOD == null ? '' : a.METHOD).toUpperCase();
        if (!method) { err(lineNo, tag + ' without METHOD'); return undefined; }
        if (method === 'NONE') return null;
        var uri = typeof a.URI === 'string' ? a.URI : '';
        if (!uri) err(lineNo, tag + ' without URI');
        var keyFormat = str(a.KEYFORMAT) || 'identity';
        if (method !== 'AES-128') note(method);
        if (keyFormat !== 'identity') note('KEYFORMAT ' + keyFormat);
        return { method: method, uri: uri, url: uri ? resolve(uri) : null, iv: parseIv(a.IV, lineNo), keyFormat: keyFormat, keyFormatVersions: str(a.KEYFORMATVERSIONS) || '1' };
      }
      function parseDateRange(a, lineNo) {
        var id = str(a.ID), startDate = a['START-DATE'] === undefined ? null : UTIL.parseDate(a['START-DATE']);
        if (!id) { err(lineNo, 'EXT-X-DATERANGE without ID'); return; }
        if (startDate === null) { err(lineNo, 'EXT-X-DATERANGE without a valid START-DATE'); return; }
        var endDate = a['END-DATE'] === undefined ? null : UTIL.parseDate(a['END-DATE']);
        var known = { ID: 1, CLASS: 1, 'START-DATE': 1, 'END-DATE': 1, DURATION: 1, 'PLANNED-DURATION': 1, 'END-ON-NEXT': 1 }, attrs = {};
        Object.keys(a).forEach(function (k) { if (!known[k]) attrs[k] = a[k]; });
        dateRanges.push({ id: id, class: str(a.CLASS), startDate: startDate, endDate: endDate, duration: num(a.DURATION), plannedDuration: num(a['PLANNED-DURATION']), endOnNext: yes(a['END-ON-NEXT']), attrs: attrs });
      }
      function define(a, lineNo) {
        if (a.NAME !== undefined) {
          var name = String(a.NAME);
          if (!/^[A-Za-z0-9_-]+$/.test(name)) err(lineNo, 'EXT-X-DEFINE has an invalid NAME');
          else if (hasOwn(vars, name)) err(lineNo, 'EXT-X-DEFINE redefines ' + name);
          else if (a.VALUE === undefined) err(lineNo, 'EXT-X-DEFINE without VALUE');
          else vars[name] = String(a.VALUE);
        } else if (a.IMPORT !== undefined) {
          var im = String(a.IMPORT);
          if (opts.variables && hasOwn(opts.variables, im)) vars[im] = String(opts.variables[im]);
          else { note('EXT-X-DEFINE IMPORT'); err(lineNo, 'EXT-X-DEFINE IMPORT="' + im + '" has no value (pass the master playlist variables)'); }
        } else if (a.QUERYPARAM !== undefined) {
          var qp = String(a.QUERYPARAM), qv = queryParam(base, qp);
          if (qv !== null) vars[qp] = qv;
          else { note('EXT-X-DEFINE QUERYPARAM'); err(lineNo, 'EXT-X-DEFINE QUERYPARAM="' + qp + '" is not in the playlist URL'); }
        } else err(lineNo, 'EXT-X-DEFINE without NAME, IMPORT or QUERYPARAM');
      }
      function emitVariant(uri, lineNo) {
        var a = pendingStreamInf, bw = num(a.BANDWIDTH);
        pendingStreamInf = null;
        if (bw === null) { err(lineNo, 'EXT-X-STREAM-INF without BANDWIDTH'); bw = 0; }
        variants.push({
          uri: uri, url: resolve(uri), bandwidth: bw, averageBandwidth: num(a['AVERAGE-BANDWIDTH']), codecs: codecList(a.CODECS),
          resolution: resolutionOf(a.RESOLUTION), frameRate: num(a['FRAME-RATE']), audioGroup: str(a.AUDIO), subtitlesGroup: str(a.SUBTITLES),
          name: str(a.NAME), videoRange: str(a['VIDEO-RANGE']), index: variants.length
        });
      }
      function emitSegment(uri, lineNo) {
        var duration = pendingInf.duration, byteRange = null;
        if (pendingByteRange) {
          var offset = pendingByteRange.offset;
          if (offset === null) {
            // RFC 8216 §4.3.2.2: no offset means "right after the previous segment's range".
            if (lastSeg && lastSeg.byteRange) offset = lastSeg.byteRange.offset + lastSeg.byteRange.length;
            else { err(lineNo, 'EXT-X-BYTERANGE without offset and no previous byte range'); offset = 0; }
          }
          byteRange = { offset: offset, length: pendingByteRange.length };
        }
        var pdt = pendingPdt !== null ? pendingPdt : nextPdt;
        var seg = {
          seq: mediaSequence + skippedSegments + segments.length, uri: uri, url: resolve(uri), duration: duration, title: pendingInf.title,
          discontinuity: pendingDisc, discSeq: discontinuitySequence + discCount, byteRange: byteRange, map: map, key: key,
          programDateTime: pdt, start: clock, end: clock + duration, gap: pendingGap, bitrate: bitrate
        };
        segments.push(seg);
        clock = seg.end;
        nextPdt = pdt === null ? null : pdt + duration * 1000;
        lastSeg = seg;
        pendingInf = null; pendingByteRange = null; pendingDisc = false; pendingGap = false; pendingPdt = null;
      }
      function tag(name, value, lineNo) {
        var a;
        switch (name) {
          case 'EXTM3U': break;
          case 'EXT-X-VERSION':
            if (version !== null) err(lineNo, 'EXT-X-VERSION appears more than once');
            else if (!/^\d+$/.test(value.trim())) err(lineNo, 'EXT-X-VERSION is not an integer');
            else version = +value.trim();
            break;
          case 'EXT-X-INDEPENDENT-SEGMENTS': independentSegments = true; break;
          case 'EXT-X-START':
            a = hlsParseAttributes(value);
            if (num(a['TIME-OFFSET']) === null) err(lineNo, 'EXT-X-START without TIME-OFFSET');
            else startOffset = { timeOffset: a['TIME-OFFSET'], precise: yes(a.PRECISE) };
            break;
          case 'EXT-X-DEFINE': define(hlsParseAttributes(value), lineNo); break;

          /* master */
          case 'EXT-X-STREAM-INF':
            sawMasterTags = true;
            if (pendingStreamInf) err(lineNo - 1, 'EXT-X-STREAM-INF without URI');
            pendingStreamInf = hlsParseAttributes(value);
            break;
          case 'EXT-X-MEDIA':
            sawMasterTags = true;
            a = hlsParseAttributes(value);
            var type = str(a.TYPE), groupId = str(a['GROUP-ID']);
            if (!type || !groupId) { err(lineNo, 'EXT-X-MEDIA without TYPE or GROUP-ID'); break; }
            if (a.NAME === undefined) err(lineNo, 'EXT-X-MEDIA without NAME');
            var muri = str(a.URI), ch = parseInt(String(a.CHANNELS == null ? '' : a.CHANNELS), 10);
            media.push({
              type: type.toUpperCase(), groupId: groupId, name: str(a.NAME) || '', language: str(a.LANGUAGE), isDefault: yes(a.DEFAULT),
              autoselect: yes(a.AUTOSELECT), forced: yes(a.FORCED), uri: muri, url: muri ? resolve(muri) : null, channels: isNum(ch) ? ch : null
            });
            break;
          case 'EXT-X-I-FRAME-STREAM-INF': sawMasterTags = true; iFrameStreams++; break;
          case 'EXT-X-SESSION-DATA':
            sawMasterTags = true;
            a = hlsParseAttributes(value);
            if (!str(a['DATA-ID'])) { err(lineNo, 'EXT-X-SESSION-DATA without DATA-ID'); break; }
            if (a.VALUE === undefined && !str(a.URI)) err(lineNo, 'EXT-X-SESSION-DATA without VALUE or URI');
            sessionData.push({ dataId: String(a['DATA-ID']), value: a.VALUE === undefined ? null : String(a.VALUE), uri: str(a.URI), url: str(a.URI) ? resolve(a.URI) : null, language: str(a.LANGUAGE) });
            break;
          case 'EXT-X-SESSION-KEY':
            sawMasterTags = true;
            var sk = parseKey(hlsParseAttributes(value), lineNo, 'EXT-X-SESSION-KEY');
            if (sk) sessionKeys.push(sk);
            break;

          /* media */
          case 'EXTINF':
            sawMediaTags = true;
            var comma = value.indexOf(','), durText = (comma === -1 ? value : value.slice(0, comma)).trim();
            var dm = /^-?\d+(\.\d+)?/.exec(durText), duration = dm ? Number(dm[0]) : NaN;
            if (!isNum(duration)) { err(lineNo, 'EXTINF without a duration'); duration = targetDuration || 0; }
            else if (duration < 0) { err(lineNo, 'EXTINF duration is negative'); duration = 0; }
            if (pendingInf) err(lineNo - 1, 'EXTINF without URI');
            pendingInf = { duration: duration, title: comma === -1 ? null : str(value.slice(comma + 1).trim()) };
            break;
          case 'EXT-X-TARGETDURATION':
            sawMediaTags = true;
            var td = num(Number(value.trim()));
            if (td === null || td <= 0 || value.trim() === '') err(lineNo, 'EXT-X-TARGETDURATION is not a positive number');
            else targetDuration = Math.ceil(td);
            break;
          case 'EXT-X-MEDIA-SEQUENCE':
          case 'EXT-X-DISCONTINUITY-SEQUENCE':
            sawMediaTags = true;
            if (segments.length) { err(lineNo, name + ' must precede the first segment'); break; }
            if (!/^\d+$/.test(value.trim())) { err(lineNo, name + ' is not an integer'); break; }
            if (name === 'EXT-X-MEDIA-SEQUENCE') mediaSequence = +value.trim(); else discontinuitySequence = +value.trim();
            break;
          case 'EXT-X-PLAYLIST-TYPE':
            sawMediaTags = true;
            var pt = value.trim().toUpperCase();
            if (pt === 'VOD' || pt === 'EVENT') playlistType = pt; else err(lineNo, 'EXT-X-PLAYLIST-TYPE must be VOD or EVENT');
            break;
          case 'EXT-X-ENDLIST': sawMediaTags = true; endList = true; break;
          case 'EXT-X-I-FRAMES-ONLY': sawMediaTags = true; iFramesOnly = true; break;
          case 'EXT-X-BYTERANGE':
            sawMediaTags = true;
            pendingByteRange = parseByteRange(value);
            if (!pendingByteRange) err(lineNo, 'EXT-X-BYTERANGE is not <n>[@<o>]');
            break;
          case 'EXT-X-MAP':
            sawMediaTags = true;
            a = hlsParseAttributes(value);
            if (!str(a.URI)) { err(lineNo, 'EXT-X-MAP without URI'); break; }
            var mbr = a.BYTERANGE === undefined ? null : parseByteRange(a.BYTERANGE);
            if (a.BYTERANGE !== undefined && !mbr) err(lineNo, 'EXT-X-MAP BYTERANGE is not <n>[@<o>]');
            map = { uri: String(a.URI), url: resolve(a.URI), byteRange: mbr ? { offset: mbr.offset === null ? 0 : mbr.offset, length: mbr.length } : null };
            break;
          case 'EXT-X-KEY':
            sawMediaTags = true;
            var k = parseKey(hlsParseAttributes(value), lineNo, 'EXT-X-KEY');
            if (k !== undefined) key = k;
            break;
          case 'EXT-X-DISCONTINUITY': sawMediaTags = true; pendingDisc = true; discCount++; break;
          case 'EXT-X-GAP': sawMediaTags = true; pendingGap = true; break;
          case 'EXT-X-BITRATE':
            sawMediaTags = true;
            var kbps = num(Number(value.trim()));
            if (kbps === null || kbps <= 0 || value.trim() === '') err(lineNo, 'EXT-X-BITRATE is not a positive number'); else bitrate = kbps * 1000;
            break;
          case 'EXT-X-PROGRAM-DATE-TIME':
            sawMediaTags = true;
            var ms = UTIL.parseDate(value.trim());
            if (ms === null) err(lineNo, 'EXT-X-PROGRAM-DATE-TIME is not an ISO 8601 date'); else pendingPdt = ms;
            break;
          case 'EXT-X-DATERANGE': sawMediaTags = true; parseDateRange(hlsParseAttributes(value), lineNo); break;
          case 'EXT-X-SERVER-CONTROL':
            sawMediaTags = true;
            a = hlsParseAttributes(value);
            serverControl = { canSkipUntil: num(a['CAN-SKIP-UNTIL']), canSkipDateRanges: yes(a['CAN-SKIP-DATERANGES']), holdBack: num(a['HOLD-BACK']), partHoldBack: num(a['PART-HOLD-BACK']), canBlockReload: yes(a['CAN-BLOCK-RELOAD']) };
            break;
          case 'EXT-X-PART-INF':
            sawMediaTags = true;
            partInf = { partTarget: num(hlsParseAttributes(value)['PART-TARGET']) };
            note('EXT-X-PART');
            break;
          case 'EXT-X-PART': sawMediaTags = true; partCount++; note('EXT-X-PART'); break;
          case 'EXT-X-PRELOAD-HINT':
            sawMediaTags = true;
            a = hlsParseAttributes(value);
            preloadHints.push({ type: str(a.TYPE), uri: str(a.URI), url: str(a.URI) ? resolve(a.URI) : null, byteRangeStart: num(a['BYTERANGE-START']), byteRangeLength: num(a['BYTERANGE-LENGTH']) });
            note('EXT-X-PRELOAD-HINT');
            break;
          case 'EXT-X-RENDITION-REPORT':
            sawMediaTags = true;
            a = hlsParseAttributes(value);
            renditionReports.push({ uri: str(a.URI), url: str(a.URI) ? resolve(a.URI) : null, lastMsn: num(a['LAST-MSN']), lastPart: num(a['LAST-PART']) });
            break;
          case 'EXT-X-SKIP':
            sawMediaTags = true;
            var skipped = num(hlsParseAttributes(value)['SKIPPED-SEGMENTS']);
            if (segments.length || skipped === null || skipped < 0) err(lineNo, 'EXT-X-SKIP must precede the first segment and carry SKIPPED-SEGMENTS');
            else skippedSegments = Math.floor(skipped);
            note('EXT-X-SKIP');
            break;
          default:
            if (unknownTags.length < MAX_ERRORS && unknownTags.indexOf(name) === -1) unknownTags.push(name);
        }
      }

      var sawHeader = false, first = true;
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim(), lineNo = li + 1;
        if (!line) continue;
        if (first) {
          first = false;
          sawHeader = line.toUpperCase() === '#EXTM3U';
          if (!sawHeader) err(lineNo, 'missing #EXTM3U header');
        }
        if (line.charAt(0) === '#') {
          if (line.slice(0, 4).toUpperCase() !== '#EXT') continue;   // a comment
          var colon = line.indexOf(':');
          var name = (colon === -1 ? line.slice(1) : line.slice(1, colon)).trim().toUpperCase();
          var value = colon === -1 ? '' : line.slice(colon + 1);
          if (name !== 'EXT-X-DEFINE') value = substitute(value, lineNo);
          tag(name, value, lineNo);
          continue;
        }
        var uri = substitute(line, lineNo);
        if (pendingStreamInf) emitVariant(uri, lineNo);
        else if (pendingInf) emitSegment(uri, lineNo);
        else err(lineNo, 'URI without a preceding EXTINF or EXT-X-STREAM-INF: ' + UTIL.truncate(uri, 60));
      }
      if (pendingStreamInf) err(0, 'EXT-X-STREAM-INF without URI at end of playlist');
      if (pendingInf) err(0, 'EXTINF without URI at end of playlist');
      if (variants.length && segments.length) err(0, 'playlist mixes master and media tags');
      if (overflow) errors.push('…and ' + overflow + ' more error' + (overflow === 1 ? '' : 's'));

      if (variants.length) {
        return {
          kind: 'master', url: base || null, errors: errors, version: version === null ? 1 : version, independentSegments: independentSegments,
          variants: variants, media: media, iFrameStreams: iFrameStreams, sessionData: sessionData, sessionKeys: sessionKeys,
          startOffset: startOffset, variables: vars, unsupported: unsupported, unknownTags: unknownTags
        };
      }
      if (segments.length) {
        if (targetDuration === null) { errors.push('missing EXT-X-TARGETDURATION'); targetDuration = targetOf({ segments: segments }); }
        return {
          kind: 'media', url: base || null, errors: errors, version: version === null ? 1 : version, targetDuration: targetDuration,
          mediaSequence: mediaSequence, discontinuitySequence: discontinuitySequence, playlistType: playlistType, endList: endList, live: !endList,
          iFramesOnly: iFramesOnly, independentSegments: independentSegments, segments: segments, totalDuration: clock, startOffset: startOffset,
          encrypted: segments.some(function (s) { return !!s.key; }), unsupported: unsupported, serverControl: serverControl,
          partInf: partInf, partCount: partCount, preloadHints: preloadHints, renditionReports: renditionReports, skippedSegments: skippedSegments,
          dateRanges: dateRanges, variables: vars, unknownTags: unknownTags
        };
      }
      return invalid(sawMasterTags ? 'master playlist has no variants' : sawMediaTags ? 'media playlist has no segments' : sawHeader ? 'playlist has no variants or segments' : 'not an HLS playlist');
    }

    /* ---------- variants ---------- */
    function hlsVariantLabel(v) {
      if (!v || typeof v !== 'object') return '–';
      var parts = [], codecs = Array.isArray(v.codecs) ? v.codecs : [];
      var h = v.resolution && isNum(v.resolution.height) && v.resolution.height > 0 ? Math.round(v.resolution.height) : 0;
      if (h) {
        var fps = isNum(v.frameRate) ? Math.round(v.frameRate) : 0;
        parts.push(h + 'p' + (fps > 30 ? fps : ''));     // "1080p60" only when the rate is worth mentioning
      } else if (codecs.length && codecs.every(function (c) { return UTIL.codecKind(c) === 'audio'; })) parts.push('Audio');
      var br = UTIL.formatBitrate(isNum(v.averageBandwidth) && v.averageBandwidth > 0 ? v.averageBandwidth : v.bandwidth);
      if (br !== '–') parts.push(br);
      return parts.length ? parts.join(' · ') : '–';
    }
    function hlsSortVariants(variants) {
      var list = Array.isArray(variants) ? variants.filter(function (v) { return v && typeof v === 'object'; }) : [];
      return UTIL.stableSort(list, function (a, b) {
        var d = (isNum(a.bandwidth) ? a.bandwidth : 0) - (isNum(b.bandwidth) ? b.bandwidth : 0);
        if (d) return d;
        return (a.resolution && isNum(a.resolution.height) ? a.resolution.height : 0) - (b.resolution && isNum(b.resolution.height) ? b.resolution.height : 0);
      });
    }
    // Highest-bandwidth candidate satisfying pred; the first listed wins an exact tie (playlist order is author preference).
    function pick(list, pred) {
      var best = null;
      for (var i = 0; i < list.length; i++) if (pred(list[i]) && (best === null || list[i].bw > best.bw)) best = list[i];
      return best;
    }
    function lowest(list) {
      var best = list[0];
      for (var i = 1; i < list.length; i++) if (list[i].bw < best.bw) best = list[i];
      return best;
    }
    function hlsChooseVariant(variants, opts) {
      var list = Array.isArray(variants) ? variants : (variants && Array.isArray(variants.variants) ? variants.variants : []);
      opts = opts || {};
      var safety = positiveOr(opts.safety, DEFAULT_SAFETY), hysteresis = positiveOr(opts.upHysteresis, DEFAULT_UP_HYSTERESIS);
      var maxHeight = num(opts.maxHeight), maxBandwidth = num(opts.maxBandwidth);
      var supported = typeof opts.supportedCodecs === 'function' ? opts.supportedCodecs : null;
      var all = [];
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (v && typeof v === 'object' && isNum(v.bandwidth)) all.push({ i: i, bw: v.bandwidth, h: v.resolution && isNum(v.resolution.height) ? v.resolution.height : null, codecs: codecList(v.codecs) });
      }
      if (!all.length) return -1;
      // Codec support is a hard filter (the decoder cannot be argued with); if it rejects everything we still
      // answer with the lowest so the UI fails on a real append error rather than on nothing.
      var playable = all.filter(function (c) {
        if (!supported || !c.codecs.length) return true;
        try { return supported(c.codecs) !== false; } catch (e) { return true; }
      });
      if (!playable.length) playable = all;
      // Caps are preferences: they never drop below the lowest playable variant.
      var capped = playable.filter(function (c) { return (maxHeight === null || c.h === null || c.h <= maxHeight) && (maxBandwidth === null || c.bw <= maxBandwidth); });
      if (!capped.length) capped = [lowest(playable)];
      var current = null;
      if (isNum(opts.current)) for (var j = 0; j < capped.length; j++) if (capped[j].i === opts.current) current = capped[j];
      var bandwidth = num(opts.bandwidth);
      if (bandwidth === null || bandwidth <= 0) {
        if (current) return current.i;                      // nothing measured yet: no reason to move
        var guess = pick(capped, function (c) { return c.bw <= FIRST_GUESS_BPS; });
        return (guess || lowest(capped)).i;
      }
      var budget = bandwidth * safety;
      var target = pick(capped, function (c) { return c.bw <= budget; }) || lowest(capped);
      if (!current || target.bw <= current.bw) return target.i;   // down-switches are immediate
      if (positiveOr(opts.bufferedSec, 0) >= UP_BUFFER_SEC) return target.i;
      // Step up only as far as the extra headroom allows, so a jittery estimate does not oscillate.
      var up = pick(capped, function (c) { return c.bw > current.bw && c.bw * hysteresis <= budget; });
      return up ? up.i : current.i;
    }

    /* ---------- throughput estimate: duration-weighted EWMA, fast + slow half-lives ---------- */
    function ewmaState(state) {
      var s = state && typeof state === 'object' ? state : {};
      return {
        fastHalfLife: positiveOr(s.fastHalfLife, DEFAULT_FAST_HALF_LIFE), slowHalfLife: positiveOr(s.slowHalfLife, DEFAULT_SLOW_HALF_LIFE),
        fast: isNum(s.fast) ? s.fast : 0, slow: isNum(s.slow) ? s.slow : 0, weight: positiveOr(s.weight, 0), samples: isNum(s.samples) && s.samples > 0 ? Math.floor(s.samples) : 0
      };
    }
    function hlsEwmaCreate(fastSec, slowSec) { return ewmaState({ fastHalfLife: fastSec, slowHalfLife: slowSec }); }
    function hlsEwmaSample(state, bytes, ms) {
      var st = ewmaState(state);
      if (!isNum(bytes) || !isNum(ms) || bytes <= 0 || ms <= 0) return st;   // an aborted or instant fetch tells us nothing
      var sec = ms / 1000, bps = bytes * 8 / sec;
      var af = Math.pow(0.5, sec / st.fastHalfLife), as = Math.pow(0.5, sec / st.slowHalfLife);
      st.fast = af * st.fast + (1 - af) * bps;
      st.slow = as * st.slow + (1 - as) * bps;
      st.weight += sec;
      st.samples += 1;
      return st;
    }
    function hlsEwmaEstimate(state) {
      var st = ewmaState(state);
      if (st.samples < 1 || st.weight <= 0) return null;
      // Divide out the zero start value so the first sample is reported as itself, not as a fraction of it.
      var fast = st.fast / (1 - Math.pow(0.5, st.weight / st.fastHalfLife));
      var slow = st.slow / (1 - Math.pow(0.5, st.weight / st.slowHalfLife));
      return Math.min(fast, slow);
    }

    /* ---------- live timing ---------- */
    function hlsLiveEdge(pl) { return hasSegments(pl) && pl.segments.length ? pl.segments[pl.segments.length - 1].end : 0; }
    function hlsLiveStart(pl, opts) {
      if (!hasSegments(pl) || !pl.segments.length) return 0;
      var holdBack = opts && isNum(opts.holdBack) && opts.holdBack > 0 ? opts.holdBack : holdBackOf(pl);
      var start = hlsLiveEdge(pl) - Math.max(holdBack, LIVE_HOLD_TARGETS * targetOf(pl));
      return Math.max(0, pl.segments[0].start, start);
    }
    // RFC 8216 §6.3.4: wait one target duration after a changed playlist, half of one after an unchanged reload.
    function hlsReloadDelay(prev, next) {
      if (!hasSegments(next)) return MIN_RELOAD_MS;
      var changed = !hasSegments(prev) || lastSeqOf(prev) !== lastSeqOf(next) || prev.segments.length !== next.segments.length || !!prev.endList !== !!next.endList;
      return Math.max(MIN_RELOAD_MS, Math.round(targetOf(next) * (changed ? 1000 : 500)));
    }
    // Put a reloaded playlist on the timeline the player is already using: segments keep the start/end they
    // had before, new ones follow on, so currentTime never jumps when the window slides.
    function hlsMerge(prev, next) {
      if (!hasSegments(next)) return next;
      var out = Object.assign({}, next, { segments: next.segments.map(function (s) { return Object.assign({}, s); }), stale: false, advanced: next.segments.length, jumped: false });
      if (!hasSegments(prev) || !prev.segments.length || !out.segments.length) return out;
      var bySeq = new Map();
      prev.segments.forEach(function (s) { bySeq.set(s.seq, s); });
      var prevLast = prev.segments[prev.segments.length - 1], anchor = -1, anchorStart, i, s, t;
      for (i = 0; i < out.segments.length && anchor === -1; i++) if (bySeq.has(out.segments[i].seq)) anchor = i;
      if (anchor === -1) { anchor = 0; anchorStart = prevLast.end; out.jumped = true; }
      else {
        var shared = bySeq.get(out.segments[anchor].seq);
        anchorStart = shared.start;
        if (Math.abs(shared.duration - out.segments[anchor].duration) > 0.001) out.errors = (out.errors || []).concat(['segment ' + shared.seq + ' changed duration between reloads']);
      }
      for (i = anchor, t = anchorStart; i < out.segments.length; i++) { s = out.segments[i]; s.start = t; s.end = t + s.duration; t = s.end; }
      for (i = anchor - 1, t = anchorStart; i >= 0; i--) { s = out.segments[i]; s.end = t; s.start = t - s.duration; t = s.start; }
      out.stale = out.segments[out.segments.length - 1].seq < prevLast.seq;
      out.advanced = out.stale ? 0 : out.segments.filter(function (x) { return x.seq > prevLast.seq; }).length;
      return out;
    }
    function hlsSegmentAt(pl, t) {
      if (!hasSegments(pl) || !isNum(t)) return -1;
      var segs = pl.segments, lo = 0, hi = segs.length - 1;
      while (lo <= hi) {                                   // starts are ascending: binary search, then check the end
        var mid = (lo + hi) >> 1;
        if (segs[mid].start <= t) lo = mid + 1; else hi = mid - 1;
      }
      for (var i = hi; i >= 0 && segs[i].start <= t; i--) if (t < segs[i].end) return i;
      return -1;
    }
    // The segment after lastSeq, or the oldest one still listed when the player fell out of the live window.
    function hlsNextSegment(pl, lastSeq) {
      if (!hasSegments(pl)) return null;
      if (!isNum(lastSeq)) return pl.segments.length ? pl.segments[0] : null;
      for (var i = 0; i < pl.segments.length; i++) if (pl.segments[i].seq > lastSeq) return pl.segments[i];
      return null;
    }

    /* ---------- buffer maths ---------- */
    // Sorted, cleaned, and merged across sub-tolerance gaps: [[start, end], …].
    function normalizeRanges(buffered) {
      var raw = [];
      if (Array.isArray(buffered)) {
        for (var i = 0; i < buffered.length; i++) {
          var r = buffered[i];
          if (Array.isArray(r) && isNum(r[0]) && isNum(r[1]) && r[1] > r[0]) raw.push([r[0], r[1]]);
          else if (r && typeof r === 'object' && isNum(r.start) && isNum(r.end) && r.end > r.start) raw.push([r.start, r.end]);
        }
      }
      raw.sort(function (a, b) { return a[0] - b[0]; });
      var out = [];
      for (var j = 0; j < raw.length; j++) {
        var last = out[out.length - 1];
        if (last && raw[j][0] <= last[1] + BUFFER_TOLERANCE) last[1] = Math.max(last[1], raw[j][1]);
        else out.push(raw[j]);
      }
      return out;
    }
    function hlsBufferPlan(o) {
      o = o || {};
      var ranges = normalizeRanges(o.buffered), t = isNum(o.currentTime) ? o.currentTime : 0;
      var target = positiveOr(o.targetBuffer, 30), max = positiveOr(o.maxBuffer, 60);
      var cur = null, next = null, total = 0, i;
      for (i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        total += r[1] - r[0];
        if (r[0] - BUFFER_TOLERANCE <= t && t < r[1]) cur = r;
        else if (r[0] > t && !next) next = r;
      }
      var ahead = cur ? Math.max(0, cur[1] - t) : 0;
      var hole = next ? { start: cur ? cur[1] : t, end: next[0] } : null;
      var cut = t - KEEP_BEHIND_SEC, evictable = ranges.length > 0 && ranges[0][0] < cut;
      // A live stream's past is never replayed from the buffer; VOD keeps it until the whole buffer is too big.
      var evictBefore = evictable && (o.live ? true : total > max) ? cut : null;
      return { action: ahead < target ? 'load' : 'wait', bufferedAhead: UTIL.round(ahead, 3), holeAhead: hole, evictBefore: evictBefore };
    }
    function hlsGapJump(o) {
      o = o || {};
      if (!isNum(o.stalledMs) || o.stalledMs < GAP_JUMP_STALL_MS || !isNum(o.currentTime)) return null;
      if (isNum(o.readyState) && o.readyState >= 3) return null;   // HAVE_FUTURE_DATA: starved of nothing, so not a gap
      var ranges = normalizeRanges(o.buffered), t = o.currentTime;
      for (var i = 0; i < ranges.length; i++) {
        if (ranges[i][0] <= t && t < ranges[i][1] - BUFFER_TOLERANCE) return null;   // media ahead: a decoder stall, not a gap
        if (ranges[i][0] > t) return ranges[i][0] - t <= GAP_JUMP_MAX_AHEAD ? UTIL.round(ranges[i][0] + GAP_JUMP_NUDGE, 3) : null;
      }
      return null;
    }
    // RFC 8216 §5.2: without an explicit IV the key's IV is the media sequence number as a 128-bit big-endian integer.
    function hlsKeyIv(key, seq) {
      var iv = new Uint8Array(16);
      if (key && key.iv && key.iv.length === 16) {
        for (var i = 0; i < 16; i++) iv[i] = key.iv[i] & 0xff;
        return iv;
      }
      UTIL.writeU64be(iv, 8, isNum(seq) && seq > 0 ? Math.floor(seq) : 0);
      return iv;
    }
    function hlsTimestampOffset(o) {
      o = o || {};
      var start = isNum(o.segmentStart) ? o.segmentStart : 0;
      if (!isNum(o.firstDts) || !isNum(o.timescale) || o.timescale <= 0) return start;
      return start - o.firstDts / o.timescale;
    }

    /* ---------- renditions ---------- */
    function langOf(r) { return String(r.language == null ? '' : r.language).toLowerCase(); }
    function primaryLang(l) { return l.split('-')[0]; }
    function preferDefault(list) {
      for (var i = 0; i < list.length; i++) if (list[i].isDefault) return list[i];
      for (var j = 0; j < list.length; j++) if (list[j].autoselect) return list[j];
      return list[0];
    }
    function hlsSelectAudioRendition(media, variant, opts) {
      var list = Array.isArray(media) ? media : (media && Array.isArray(media.media) ? media.media : []);
      var group = variant && variant.audioGroup != null && variant.audioGroup !== '' ? String(variant.audioGroup) : null;
      if (!group) return null;
      var cands = list.filter(function (r) { return r && typeof r === 'object' && String(r.type).toUpperCase() === 'AUDIO' && r.groupId === group; });
      if (!cands.length) return null;
      var lang = opts && opts.language ? String(opts.language).toLowerCase() : '';
      if (lang) {
        // AUTOSELECT=NO renditions are only for explicit user picks, not language matching (RFC 8216 §4.3.4.1).
        var auto = cands.filter(function (r) { return r.autoselect || r.isDefault; });
        var exact = auto.filter(function (r) { return langOf(r) === lang; });
        var match = exact.length ? exact : auto.filter(function (r) { return langOf(r) && primaryLang(langOf(r)) === primaryLang(lang); });
        if (match.length) return preferDefault(match);
      }
      return preferDefault(cands);
    }
    function hlsLiveStatus(o) {
      o = o || {};
      var pl = o.playlist;
      if (!hasSegments(pl) || pl.endList) return { latencySec: 0, behindLive: false, stalledPlaylist: false };
      var td = targetOf(pl), t = isNum(o.currentTime) ? o.currentTime : 0;
      // The edge we know is as old as the last reload; the real one has moved on by that much.
      var elapsed = isNum(o.now) && isNum(o.lastReloadAt) ? Math.max(0, o.now - o.lastReloadAt) / 1000 : 0;
      var latency = Math.max(0, hlsLiveEdge(pl) + elapsed - t);
      var hold = Math.max(holdBackOf(pl), LIVE_HOLD_TARGETS * td);
      return { latencySec: UTIL.round(latency, 3), behindLive: latency > hold + 2 * td, stalledPlaylist: elapsed > LIVE_HOLD_TARGETS * td };
    }

    return {
      hlsParseAttributes: hlsParseAttributes, hlsParse: hlsParse,
      hlsVariantLabel: hlsVariantLabel, hlsSortVariants: hlsSortVariants, hlsChooseVariant: hlsChooseVariant,
      hlsEwmaCreate: hlsEwmaCreate, hlsEwmaSample: hlsEwmaSample, hlsEwmaEstimate: hlsEwmaEstimate,
      hlsLiveEdge: hlsLiveEdge, hlsLiveStart: hlsLiveStart, hlsReloadDelay: hlsReloadDelay, hlsMerge: hlsMerge,
      hlsSegmentAt: hlsSegmentAt, hlsNextSegment: hlsNextSegment, hlsBufferPlan: hlsBufferPlan, hlsGapJump: hlsGapJump,
      hlsKeyIv: hlsKeyIv, hlsTimestampOffset: hlsTimestampOffset, hlsSelectAudioRendition: hlsSelectAudioRendition, hlsLiveStatus: hlsLiveStatus
    };
  })();

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

  var E = {};
  Object.keys(UTIL).forEach(function (k) { if (E.hasOwnProperty(k)) throw new Error('AerialEngine: duplicate export ' + k + ' in UTIL'); E[k] = UTIL[k]; });
  Object.keys(TS).forEach(function (k) { if (E.hasOwnProperty(k)) throw new Error('AerialEngine: duplicate export ' + k + ' in TS'); E[k] = TS[k]; });
  Object.keys(MP4).forEach(function (k) { if (E.hasOwnProperty(k)) throw new Error('AerialEngine: duplicate export ' + k + ' in MP4'); E[k] = MP4[k]; });
  Object.keys(HLS).forEach(function (k) { if (E.hasOwnProperty(k)) throw new Error('AerialEngine: duplicate export ' + k + ' in HLS'); E[k] = HLS[k]; });
  Object.keys(RADIO).forEach(function (k) { if (E.hasOwnProperty(k)) throw new Error('AerialEngine: duplicate export ' + k + ' in RADIO'); E[k] = RADIO[k]; });
  E.util = UTIL;
  E.ts = TS;
  E.mp4 = MP4;
  E.hls = HLS;
  E.radio = RADIO;

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.AerialEngine = E;
})(typeof self !== 'undefined' ? self : this);
