/* Tuner engine — every rule of the IPTV player, as pure functions.
 *
 * Tuner plays playlists the user already has: an M3U/M3U8 link, an Xtream
 * Codes login, or a playlist file. This file holds everything that can be
 * decided without a browser — playlist parsing (M3U attributes, names with
 * commas, #EXTGRP), classification into live / movie / episode, series
 * grouping from "Show S01E02" style names, the Xtream Codes API → item mapping
 * and stream URL building, search matching, favourites, watch history and the
 * resume rule, next/previous stepping, the player's error copy, and the
 * "open in VLC" link. Zero DOM, zero network, zero storage; every
 * time-dependent function takes `now`. tuner/index.html owns the rest.
 *
 * Classic script (not a module): exports `module.exports` for the test runner
 * and `self.TunerEngine` for the page. Tests: scripts/test-tuner-logic.mjs. */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var RESUME_MIN = 20;        // seconds watched before a position is worth resuming
  var RESUME_TAIL = 30;       // seconds from the end past which playback restarts instead
  var RECENT_MAX = 40;        // watch-history entries kept per device
  var FIT_MODES = ['contain', 'cover', 'fill'];
  var FIT_LABELS = { contain: 'Fit', cover: 'Zoom', fill: 'Stretch' };

  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  /* ------------------------------------------------------------------ text */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  // djb2 → base36: a short, stable id for a stream URL (same URL, same id, every load)
  function hash(s) {
    var h = 5381; s = String(s || '');
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function initials(name) {
    var w = String(name || '').replace(/[^a-z0-9 ]/gi, ' ').trim().split(/\s+/).filter(Boolean);
    return (w.length ? w.slice(0, 2).map(function (x) { return x[0]; }).join('') : '?').toUpperCase();
  }
  function fmtTime(seconds) {
    var s = Math.max(0, Math.floor(seconds || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(x).padStart(2, '0');
  }
  function ago(ts, now) {
    var m = Math.round((now - ts) / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24);
    return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  }
  function hostOf(url) {
    var m = /^[a-z][a-z0-9+.\-]*:\/\/(?:[^@\/?#]*@)?([^\/?#:]+)/i.exec(String(url || '').trim());
    return m ? m[1] : 'Playlist';
  }
  function isAdult(group) {
    return /(^|[^a-z])(xxx|adult|adults|porn|18\+|\+18|erotic|erotica)([^a-z]|$)/i.test(group || '');
  }

  /* ------------------------------------------------------------- playlists */
  // "The Crown S02E03 Lisbon", "The Crown - S02 E04", "Planet Earth 1x02" → parts
  function parseSeriesName(name) {
    var s = String(name || '');
    var m = /^(.*?)[\s._\-–:]*\bS(\d{1,2})\s*[._\-–: ]*E(\d{1,3})\b[\s._\-–:]*(.*)$/i.exec(s)
         || /^(.*?)[\s._\-–:]*\b(\d{1,2})x(\d{1,3})\b[\s._\-–:]*(.*)$/i.exec(s);
    if (!m) return null;
    var title = m[1].replace(/[\s._\-–:|]+$/, '').trim();
    return { title: title || s.trim(), season: Number(m[2]), episode: Number(m[3]), epTitle: m[4].trim() };
  }
  // live | movie | ep — from the stream URL first (Xtream paths, file extensions), then the group name
  function classify(name, url, group) {
    var g = String(group || '').toLowerCase(), u = String(url || '').toLowerCase();
    var sx = parseSeriesName(name);
    if (/\/series\//.test(u) || sx) return { k: 'ep', sx: sx };
    if (/\/live\//.test(u)) return { k: 'live', sx: null };
    if (/\/movies?\//.test(u)) return { k: 'movie', sx: null };
    if (/\.(mp4|mkv|avi|mov|m4v|webm|wmv|flv)(\?|#|$)/.test(u)) return { k: 'movie', sx: null };
    if (/(^|[^a-z])(movies?|films?|vod|cinema)([^a-z]|$)/.test(g)) return { k: 'movie', sx: null };
    if (/(^|[^a-z])(series|serie|shows?)([^a-z]|$)/.test(g)) return { k: 'ep', sx: null };
    return { k: 'live', sx: null };
  }
  function makeItem(name, url, logo, group, tid) {
    var c = classify(name, url, group);
    var it = { id: hash(url), n: String(name || '').trim() || 'Untitled', u: url, l: logo || '',
               g: String(group || '').trim() || 'Uncategorised', k: c.k };
    if (tid) it.tid = tid;
    if (c.k === 'ep') {
      var sx = c.sx || { title: it.n, season: 1, episode: 0, epTitle: '' };
      it.sk = 'm' + hash(slug(sx.title) + '|' + it.g);
      it.st = sx.title; it.se = sx.season; it.ep = sx.episode;
      if (sx.epTitle) it.et = sx.epTitle;
    }
    return it;
  }
  function fileName(url) {
    var last = String(url || '').split('/').pop() || '';
    last = last.split('?')[0].split('#')[0];
    try { return decodeURIComponent(last); } catch (e) { return last; }
  }
  // Extended M3U: "#EXTINF:-1 attr="…" …,Display name" then the stream URL on the next line.
  // The display name starts at the first comma OUTSIDE quotes (attribute values and names may contain commas).
  function parseM3U(text) {
    var lines = String(text || '').split(/\r?\n/);
    var items = [], cur = null, grp = '';
    var attrRe = /([\w-]+)="([^"]*)"/g;
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (!line) continue;
      if (/^#EXTINF/i.test(line)) {
        var body = line.slice(8), inQ = false, idx = -1;
        for (var i = 0; i < body.length; i++) {
          var ch = body[i];
          if (ch === '"') inQ = !inQ; else if (ch === ',' && !inQ) { idx = i; break; }
        }
        var head = idx < 0 ? body : body.slice(0, idx), name = idx < 0 ? '' : body.slice(idx + 1).trim();
        var attrs = {}, m; attrRe.lastIndex = 0;
        while ((m = attrRe.exec(head))) attrs[m[1].toLowerCase()] = m[2];
        cur = { n: name || attrs['tvg-name'] || '', l: attrs['tvg-logo'] || '', g: attrs['group-title'] || grp || '', tid: attrs['tvg-id'] || '' };
      } else if (/^#EXTGRP:/i.test(line)) {
        grp = line.slice(8).trim();
        if (cur && !cur.g) cur.g = grp;
      } else if (line.charAt(0) === '#') {
        continue; // #EXTM3U, #EXTVLCOPT and friends
      } else {
        if (!cur) cur = { n: '', l: '', g: grp || '', tid: '' };
        items.push(makeItem(cur.n || fileName(line) || 'Untitled', line, cur.l, cur.g, cur.tid));
        cur = null;
      }
    }
    return items;
  }
  function countKinds(items) {
    var c = { live: 0, movie: 0, series: 0 }, sk = {};
    (items || []).forEach(function (i) {
      if (i.k === 'live') c.live++;
      else if (i.k === 'movie') c.movie++;
      else if (i.k === 'series') c.series++;
      else if (i.k === 'ep') sk[i.sk] = 1;
    });
    c.series += Object.keys(sk).length;
    return c;
  }
  // The browsable shape of a playlist: live channels (numbered), movies, series (episodes grouped
  // under their show, Xtream series shells kept for lazy loading) and the category counts of each.
  function buildIndex(items, opts) {
    var hide = !!(opts && opts.hideAdult);
    var byId = {}, live = [], movie = [], series = {}, order = [];
    var gl = {}, gm = {}, gs = {}, lo = [], mo = [], so = [];
    var bump = function (map, ord, g) { if (!(g in map)) { map[g] = 0; ord.push(g); } map[g]++; };
    var num = 0;
    (items || []).forEach(function (it) {
      byId[it.id] = it;
      if (hide && isAdult(it.g)) return;
      if (it.k === 'live') {
        if (!it.num) it.num = ++num; else num = Math.max(num, it.num);
        live.push(it); bump(gl, lo, it.g);
      } else if (it.k === 'movie') {
        movie.push(it); bump(gm, mo, it.g);
      } else if (it.k === 'ep') {
        var s = series[it.sk];
        if (!s) { s = { key: it.sk, title: it.st || it.n, logo: it.l, g: it.g, eps: [], x: null }; series[it.sk] = s; order.push(it.sk); bump(gs, so, it.g); }
        s.eps.push(it);
        if (!s.logo && it.l) s.logo = it.l;
      } else if (it.k === 'series') {
        series[it.id] = { key: it.id, title: it.n, logo: it.l, g: it.g, eps: null, x: it.x }; order.push(it.id); bump(gs, so, it.g);
      }
    });
    var list = order.map(function (k) { var s = series[k]; if (s.eps) s.eps.sort(byEpisode); return s; });
    var pairs = function (map, ord) { return ord.map(function (g) { return [g, map[g]]; }); };
    return { byId: byId, live: live, movie: movie, series: list, seriesByKey: series,
             groups: { live: pairs(gl, lo), movie: pairs(gm, mo), series: pairs(gs, so) } };
  }
  function byEpisode(a, b) { return (a.se - b.se) || (a.ep - b.ep); }
  function epLabel(e) { return 'S' + String(e.se || 1).padStart(2, '0') + ' E' + String(e.ep || 0).padStart(2, '0'); }
  function seasonsOf(series) {
    var seen = {}, out = [];
    (series && series.eps || []).forEach(function (e) { if (!seen[e.se]) { seen[e.se] = 1; out.push(e.se); } });
    return out.sort(function (a, b) { return a - b; });
  }

  /* ---------------------------------------------------------- Xtream Codes */
  // "host:8080", "http://host:8080/c/", "http://host:8080/get.php?username=…" → "http://host:8080"
  function normalizeServer(s) {
    s = String(s || '').trim();
    if (!s) throw err('input', 'Enter the server address.');
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    var m = /^(https?):\/\/(?:[^@\/?#]*@)?([^\/?#\s]+)/i.exec(s);
    if (!m || !/^(\[[0-9a-f:.]+\]|[a-z0-9][a-z0-9.\-]*)(:\d{1,5})?$/i.test(m[2])) {
      throw err('input', 'That server address doesn’t look right. Use the form http://host:port');
    }
    return m[1].toLowerCase() + '://' + m[2];
  }
  function queryParam(s, key) {
    var m = new RegExp('[?&]' + key + '=([^&#]*)', 'i').exec(String(s || ''));
    if (!m) return null;
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return m[1]; }
  }
  // A pasted M3U / player_api link carries everything a login needs
  function xtreamFromText(s) {
    var u = queryParam(s, 'username'), p = queryParam(s, 'password');
    if (!u || !p) return null;
    try { return { server: normalizeServer(s), username: u, password: p }; } catch (e) { return null; }
  }
  function xtreamApiUrl(base, user, pass, action, extra) {
    return base + '/player_api.php?username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass)
      + (action ? '&action=' + action : '') + (extra || '');
  }
  function xtreamStreamUrl(base, user, pass, kind, id, ext) {
    var U = encodeURIComponent(user), P = encodeURIComponent(pass);
    if (kind === 'live') return base + '/live/' + U + '/' + P + '/' + id + '.m3u8';
    if (kind === 'movie') return base + '/movie/' + U + '/' + P + '/' + id + '.' + (ext || 'mp4');
    return base + '/series/' + U + '/' + P + '/' + id + '.' + (ext || 'mp4');
  }
  // player_api.php answers {user_info:{auth:1,status:"Active"}}; anything else is a refusal
  function xtreamAuthCheck(auth) {
    if (!auth || !auth.user_info || String(auth.user_info.auth) !== '1') throw err('auth', 'The server rejected that username or password.');
    var st = auth.user_info.status;
    if (st && String(st).toLowerCase() !== 'active') throw err('auth', 'This account is ' + String(st).toLowerCase() + '. Contact your provider.');
    return true;
  }
  function catNamer(list) {
    var map = {};
    (Array.isArray(list) ? list : []).forEach(function (c) { if (c) map[String(c.category_id)] = String(c.category_name || 'Uncategorised'); });
    return function (id) { return map[String(id)] || 'Uncategorised'; };
  }
  // The six catalogue calls → one item list (live, movies, series shells whose episodes load on demand)
  function xtreamItems(base, user, pass, r) {
    r = r || {};
    var arr = function (x) { return Array.isArray(x) ? x : []; };
    var lcat = catNamer(r.liveCategories), vcat = catNamer(r.vodCategories), scat = catNamer(r.seriesCategories);
    var items = [];
    arr(r.liveStreams).forEach(function (c) {
      if (!c || c.stream_id == null) return;
      var it = { id: 'l' + c.stream_id, n: String(c.name || 'Untitled'), u: xtreamStreamUrl(base, user, pass, 'live', c.stream_id),
                 l: c.stream_icon || '', g: lcat(c.category_id), k: 'live' };
      if (Number(c.num)) it.num = Number(c.num);
      if (c.epg_channel_id) it.tid = c.epg_channel_id;
      items.push(it);
    });
    arr(r.vodStreams).forEach(function (c) {
      if (!c || c.stream_id == null) return;
      var it = { id: 'm' + c.stream_id, n: String(c.name || 'Untitled'), u: xtreamStreamUrl(base, user, pass, 'movie', c.stream_id, c.container_extension),
                 l: c.stream_icon || '', g: vcat(c.category_id), k: 'movie' };
      if (c.rating) it.r = c.rating;
      items.push(it);
    });
    arr(r.series).forEach(function (c) {
      if (!c || c.series_id == null) return;
      items.push({ id: 's' + c.series_id, n: String(c.name || 'Untitled'), l: c.cover || '', g: scat(c.category_id), k: 'series', x: c.series_id });
    });
    return items;
  }
  // get_series_info → episodes, whether the panel keys them by season or lists them flat
  function xtreamEpisodes(base, user, pass, series, info) {
    var eps = info && info.episodes;
    if (!eps) return [];
    if (!Array.isArray(eps)) eps = Object.keys(eps).map(function (k) { return eps[k]; });
    var flat = [];
    eps.forEach(function (v) {
      if (Array.isArray(v)) flat = flat.concat(v);
      else if (v && typeof v === 'object') flat = flat.concat(Object.keys(v).map(function (k) { return v[k]; }));
    });
    return flat.filter(function (e) { return e && e.id != null; }).map(function (e) {
      var it = { id: 'e' + e.id, n: String(e.title || ('Episode ' + e.episode_num)), u: xtreamStreamUrl(base, user, pass, 'ep', e.id, e.container_extension),
                 l: (e.info && e.info.movie_image) || series.logo || '', g: series.g, k: 'ep', sk: series.key, st: series.title,
                 se: Number(e.season) || 1, ep: Number(e.episode_num) || 0 };
      if (e.info && e.info.duration) it.d = e.info.duration;
      return it;
    }).sort(byEpisode);
  }

  /* --------------------------------------------------------------- playback */
  // Live channels without a file extension are HLS on every panel we know; .m3u8 anywhere is HLS
  function isHlsUrl(url, kind) {
    var u = String(url || '');
    return /\.m3u8(\?|#|$)/i.test(u) || (kind === 'live' && !/\.[a-z0-9]{2,4}(\?|#|$)/i.test(u));
  }
  function isMixedContent(url, secure) { return !!secure && /^http:\/\//i.test(String(url || '')); }
  function netHint(url, secure) {
    if (isMixedContent(url, secure)) return 'This app is open over https, so the browser blocks plain http:// addresses. Open the file directly in Safari or Chrome instead, or ask your provider for https links.';
    return 'The server may be offline, the link may have expired, or the provider doesn’t allow browser players (CORS). Copy the link and open it in VLC to check it.';
  }
  // <video>.error.code → what to tell the viewer (2 network, 3 decode, 4 unsupported)
  function mediaErrorMessage(code, url, secure) {
    if (code === 4) return { title: 'Format not supported', msg: 'This browser can’t play this type of stream. Raw .ts streams and some .mkv/.avi files only play in apps like VLC. ' + netHint(url, secure) };
    if (code === 2) return { title: 'Connection lost', msg: netHint(url, secure) };
    if (code === 3) return { title: 'Couldn’t decode the video', msg: 'The stream loaded, but this browser can’t decode it. Try VLC.' };
    return { title: 'Playback failed', msg: netHint(url, secure) };
  }
  function vlcUrl(url, ios) {
    return ios ? 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(url) : 'vlc://' + url;
  }
  function fitNext(cur) { return FIT_MODES[(FIT_MODES.indexOf(cur) + 1) % FIT_MODES.length]; }
  function fitLabel(mode) { return FIT_LABELS[mode] || FIT_LABELS.contain; }
  function stepIndex(ids, currentId, dir) {
    var i = (ids || []).indexOf(currentId);
    if (i < 0) return -1;
    var j = i + dir;
    return j < 0 || j >= ids.length ? -1 : j;
  }

  /* ----------------------------------------------------- library & history */
  // Every word of the query must appear in the slugged name ("bbc one" matches "BBC One HD")
  function searchMatch(query, name) {
    var q = slug(query);
    if (q.length < 2) return false;
    var s = slug(name), words = q.split(' ');
    for (var i = 0; i < words.length; i++) if (s.indexOf(words[i]) < 0) return false;
    return true;
  }
  function search(index, query, limit) {
    var lim = limit || 80, q = slug(query);
    if (q.length < 2) return { live: [], movie: [], series: [] };
    var take = function (arr, key) { var out = []; for (var i = 0; i < arr.length && out.length < lim; i++) if (searchMatch(q, arr[i][key])) out.push(arr[i]); return out; };
    return { live: take(index.live, 'n'), movie: take(index.movie, 'n'), series: take(index.series, 'title') };
  }
  function toggleFav(list, id) {
    var out = (list || []).filter(function (x) { return x !== id; });
    var on = out.length === (list || []).length;
    if (on) out.unshift(id);
    return { list: out, on: on };
  }
  // The favourite of an episode is its series
  function favTarget(item) { return item.k === 'ep' ? item.sk : item.id; }
  function snapshot(it) {
    var o = { id: it.id, n: it.n, u: it.u, l: it.l, g: it.g, k: it.k };
    if (it.k === 'ep') { o.sk = it.sk; o.st = it.st; o.se = it.se; o.ep = it.ep; if (it.et) o.et = it.et; }
    return o;
  }
  // Move (or add) an item to the front of the watch history, keeping its last position unless given a new one
  function touchRecent(recent, pid, item, pos, dur, now) {
    var prev = null, out = [];
    (recent || []).forEach(function (r) { if (r.pid === pid && r.id === item.id) prev = r; else out.push(r); });
    out.unshift({ pid: pid, id: item.id, k: item.k, at: now,
                  pos: pos == null ? (prev ? prev.pos : 0) : pos,
                  dur: dur == null ? (prev ? prev.dur : 0) : dur, it: snapshot(item) });
    return out.slice(0, RECENT_MAX);
  }
  function continueWatching(recent, pid, limit) {
    return (recent || []).filter(function (r) { return r.pid === pid && (r.k === 'movie' || r.k === 'ep') && r.it; }).slice(0, limit || 12);
  }
  function recentLive(recent, pid, limit) {
    return (recent || []).filter(function (r) { return r.pid === pid && r.k === 'live' && r.it; }).slice(0, limit || 10);
  }
  // Resume only when there is something to resume into: past the opening and not into the credits
  function resumeAt(entry, duration) {
    if (!entry || !(entry.pos > RESUME_MIN)) return null;
    if (!(duration > 0) || !isFinite(duration)) return null;
    return entry.pos < duration - RESUME_TAIL ? entry.pos : null;
  }
  function progressPct(pos, dur) { return dur > 0 ? Math.min(100, Math.round(pos / dur * 100)) : 0; }
  function minutesLeft(pos, dur) { return dur > 0 ? Math.max(0, Math.round((dur - pos) / 60)) : 0; }

  var api = {
    VERSION: VERSION, RESUME_MIN: RESUME_MIN, RESUME_TAIL: RESUME_TAIL, RECENT_MAX: RECENT_MAX, FIT_MODES: FIT_MODES,
    escapeHtml: escapeHtml, slug: slug, hash: hash, initials: initials, fmtTime: fmtTime, ago: ago, hostOf: hostOf, isAdult: isAdult,
    parseSeriesName: parseSeriesName, classify: classify, makeItem: makeItem, fileName: fileName, parseM3U: parseM3U,
    countKinds: countKinds, buildIndex: buildIndex, epLabel: epLabel, seasonsOf: seasonsOf,
    normalizeServer: normalizeServer, queryParam: queryParam, xtreamFromText: xtreamFromText, xtreamApiUrl: xtreamApiUrl,
    xtreamStreamUrl: xtreamStreamUrl, xtreamAuthCheck: xtreamAuthCheck, xtreamItems: xtreamItems, xtreamEpisodes: xtreamEpisodes,
    isHlsUrl: isHlsUrl, isMixedContent: isMixedContent, netHint: netHint, mediaErrorMessage: mediaErrorMessage, vlcUrl: vlcUrl,
    fitNext: fitNext, fitLabel: fitLabel, stepIndex: stepIndex,
    searchMatch: searchMatch, search: search, toggleFav: toggleFav, favTarget: favTarget, snapshot: snapshot,
    touchRecent: touchRecent, continueWatching: continueWatching, recentLive: recentLive, resumeAt: resumeAt,
    progressPct: progressPct, minutesLeft: minutesLeft
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TunerEngine = api;
})(typeof self !== 'undefined' ? self : this);
