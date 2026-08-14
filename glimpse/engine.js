/* Glimpse — the pure "what the world is seeing" engine.
 * =====================================================================
 * Glimpse is a social platform with one job: let anyone share what is in
 * front of their eyes, right now, with the whole world — and let everyone
 * else look through those windows. Every rule that decides how the world
 * feed hops between countries, what time of day it is outside someone
 * else's window, how far away a glimpse was taken, and how your passport
 * fills up lives HERE, as pure, deterministic, clock-injected functions
 * with zero DOM and zero I/O — unit-tested in
 * scripts/test-glimpse-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
  var EARTH_KM = 6371;

  /* ---------------- deterministic hashing / seeded randomness ---------------- */

  // FNV-1a 32-bit — stable across platforms, good spread for short strings.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s);
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

  /* ---------------- text: escaping and caption rendering ---------------- */

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var TAG_RE = /(^|[^\w&])#([\p{L}\p{N}_]{2,30})/gu;
  var URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

  function extractTags(text) {
    var out = [], seen = {}, m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(String(text || ''))) !== null) {
      var t = m[2].toLowerCase();
      if (!seen[t]) { seen[t] = 1; out.push(t); }
    }
    return out;
  }

  // Escape FIRST, then decorate. Output contains only markup we created.
  function renderCaption(text) {
    var s = escapeHTML(text);
    s = s.replace(URL_RE, function (u) {
      var clean = u.replace(/[.,;:!?]+$/, '');
      var trail = u.slice(clean.length);
      var label = clean.replace(/^https?:\/\//, '');
      if (label.length > 40) label = label.slice(0, 37) + '…';
      return '<a href="' + clean + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' + trail;
    });
    s = s.replace(TAG_RE, function (_all, pre, tag) {
      return pre + '<span class="tag" data-tag="' + tag.toLowerCase() + '">#' + tag + '</span>';
    });
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  /* ---------------- account registration (cloud mode) ---------------- */
  // Glimpse's live world is real, registered people — one account, one
  // handle. Pure validation here; Firebase Auth does the credential work.
  var HANDLE_RE = /^[a-z0-9_]{2,20}$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function normalizeHandle(h) {
    return String(h == null ? '' : h).trim().toLowerCase().replace(/^@/, '');
  }

  function validateAccount(a) {
    a = a || {};
    var errors = [];
    var name = String(a.name == null ? '' : a.name).trim();
    var handle = normalizeHandle(a.handle);
    var email = String(a.email == null ? '' : a.email).trim();
    var password = String(a.password == null ? '' : a.password);
    if (!name) errors.push('Add your name.');
    else if (name.length > 30) errors.push('Name: 30 characters max.');
    if (!HANDLE_RE.test(handle)) errors.push('Handle: 2–20 lowercase letters, numbers or _ only.');
    if (!EMAIL_RE.test(email)) errors.push('That email doesn’t look right.');
    if (password.length < 8) errors.push('Password: at least 8 characters.');
    if (errors.length) return { ok: false, errors: errors };
    return { ok: true, name: name, handle: handle, email: email };
  }

  /* ---------------- a glimpse: what one pair of eyes is seeing ---------------- */
  // A glimpse is (what you see) + (where you are). The "what" is a photo
  // and/or a caption; the "where" is a named place with real coordinates —
  // that's what turns a post into a window the world can look through.
  var MAX_CAPTION = 280;

  function validateGlimpse(g) {
    g = g || {};
    var caption = String(g.caption == null ? '' : g.caption).trim();
    var hasPhoto = !!g.photo;
    if (!caption && !hasPhoto) return { ok: false, reason: 'Show us something — a photo or a few words about what you’re seeing.' };
    if (caption.length > MAX_CAPTION) return { ok: false, reason: 'Keep it under ' + MAX_CAPTION + ' characters (' + caption.length + ' now).' };
    var p = g.place || {};
    var lat = Number(p.lat), lon = Number(p.lon);
    if (!p.name || !isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { ok: false, reason: 'A glimpse needs a place — pick where you’re looking from.' };
    }
    return { ok: true, caption: caption, place: { name: String(p.name), country: String(p.country || ''), cc: String(p.cc || ''), flag: String(p.flag || ''), lat: lat, lon: lon } };
  }

  /* ---------------- geography: how far, which way ---------------- */

  function toRad(d) { return d * Math.PI / 180; }

  function haversineKm(a, b) {
    var dLat = toRad((b.lat || 0) - (a.lat || 0));
    var dLon = toRad((b.lon || 0) - (a.lon || 0));
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(a.lat || 0)) * Math.cos(toRad(b.lat || 0)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearingDeg(a, b) {
    var la1 = toRad(a.lat || 0), la2 = toRad(b.lat || 0);
    var dLon = toRad((b.lon || 0) - (a.lon || 0));
    var y = Math.sin(dLon) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  var WINDS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function compassDir(deg) {
    return WINDS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }

  function formatKm(km) {
    if (km < 1) return Math.max(1, Math.round(km * 1000)) + ' m';
    if (km < 100) return Math.round(km) + ' km';
    return String(Math.round(km)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' km';
  }

  /* ---------------- solar time: what the sky looks like out that window ---------------- */
  // Longitude IS a clock: the sun crosses 15° per hour. Good to well under
  // an hour everywhere — plenty to say "it's dusk outside her window" and
  // paint the sky the right colour, with zero timezone tables shipped.
  function solarHour(lon, utcMs) {
    var h = (utcMs / HOUR) % 24 + (Number(lon) || 0) / 15;
    return ((h % 24) + 24) % 24;
  }

  var TODS = [
    { key: 'dawn',  label: 'dawn',    emoji: '🌅' },
    { key: 'day',   label: 'daytime', emoji: '☀️' },
    { key: 'dusk',  label: 'evening', emoji: '🌆' },
    { key: 'night', label: 'night',   emoji: '🌙' }
  ];

  function timeOfDay(hour) {
    var h = ((hour % 24) + 24) % 24;
    if (h >= 5 && h < 8) return TODS[0];
    if (h >= 8 && h < 17) return TODS[1];
    if (h >= 17 && h < 21) return TODS[2];
    return TODS[3];
  }

  function timeOfDayAt(lon, utcMs) { return timeOfDay(solarHour(lon, utcMs)); }

  /* ---------------- the world feed: a scroll that circles the globe ---------------- */
  //
  // Most feeds show you more of what you just saw. Glimpse's world feed does
  // the opposite: it is built to make each flick of the thumb LAND SOMEWHERE
  // ELSE. Greedy selection — every slot picks the highest-value glimpse where
  //   value = recency × diversity, and diversity decays each time a country
  // or an author has already appeared in this scroll. A fresh window from a
  // country you haven't hit yet beats the fourth photo from the same street.
  // Fully deterministic: same posts + same clock = same journey.
  var HALF_LIFE_H = 12;

  function worldFeed(glimpses, opts, now) {
    opts = opts || {};
    var limit = opts.limit || 50;
    var seen = opts.seenCC || {};        // ccs the viewer's passport already holds
    var pool = [];
    for (var i = 0; i < glimpses.length; i++) {
      var g = glimpses[i];
      var ageH = Math.max(0, (now - (g.ts || 0)) / HOUR);
      pool.push({ g: g, base: 100 * Math.pow(0.5, ageH / HALF_LIFE_H) });
    }
    var ccPicks = {}, authorPicks = {};
    var out = [];
    while (out.length < limit && pool.length) {
      var bestIdx = -1, bestVal = -1;
      for (var j = 0; j < pool.length; j++) {
        var it = pool[j];
        var cc = (it.g.place && it.g.place.cc) || '?';
        var mult = 1 / (1 + 2 * (ccPicks[cc] || 0) + 3 * (authorPicks[it.g.authorId] || 0));
        var bonus = (!seen[cc] && !ccPicks[cc]) ? 12 : 0;
        var val = it.base * mult + bonus;
        if (val > bestVal + 1e-9 ||
            (Math.abs(val - bestVal) <= 1e-9 && bestIdx >= 0 &&
             ((it.g.ts || 0) > (pool[bestIdx].g.ts || 0) ||
              ((it.g.ts || 0) === (pool[bestIdx].g.ts || 0) && String(it.g.id) < String(pool[bestIdx].g.id))))) {
          bestVal = val; bestIdx = j;
        }
      }
      var pick = pool.splice(bestIdx, 1)[0];
      var pcc = (pick.g.place && pick.g.place.cc) || '?';
      var reasons = [{ key: 'fresh', label: 'Seen ' + timeAgo(pick.g.ts, now), pts: round1(pick.base) }];
      if (!ccPicks[pcc]) {
        reasons.push({ key: 'hop', label: 'First window from ' + ((pick.g.place && pick.g.place.country) || 'there') + ' this scroll', pts: 0 });
        if (!seen[pcc]) reasons.push({ key: 'new-horizon', label: 'A country your passport hasn’t seen yet', pts: 12 });
      }
      ccPicks[pcc] = (ccPicks[pcc] || 0) + 1;
      authorPicks[pick.g.authorId] = (authorPicks[pick.g.authorId] || 0) + 1;
      out.push({ glimpse: pick.g, score: round1(bestVal), reasons: reasons });
    }
    return out;
  }

  // Annotate consecutive world-feed items with the "hop" between them, so the
  // UI can draw the journey: "✈️ 9,600 km to Japan".
  function feedHops(items) {
    var hops = [null];
    for (var i = 1; i < items.length; i++) {
      var a = items[i - 1].glimpse.place, b = items[i].glimpse.place;
      if (!a || !b) { hops.push(null); continue; }
      var km = haversineKm(a, b);
      if (km < 50 || (a.cc && b.cc && a.cc === b.cc)) { hops.push(null); continue; }
      hops.push({ km: km, label: formatKm(km) + ' ' + compassDir(bearingDeg(a, b)) + ' to ' + (b.name || 'the next window') + (b.flag ? ' ' + b.flag : '') });
    }
    return hops;
  }

  /* ---------------- the near feed: windows around you ---------------- */
  function nearFeed(glimpses, here, now) {
    var out = [];
    for (var i = 0; i < glimpses.length; i++) {
      var g = glimpses[i];
      if (!g.place) continue;
      var km = haversineKm(here, g.place);
      out.push({
        glimpse: g, km: km,
        dir: compassDir(bearingDeg(here, g.place)),
        distanceLabel: km < 25 ? 'right around you' : formatKm(km) + ' ' + compassDir(bearingDeg(here, g.place)) + ' of you'
      });
    }
    out.sort(function (a, b) { return a.km - b.km || (b.glimpse.ts || 0) - (a.glimpse.ts || 0); });
    return out;
  }

  /* ---------------- the world map: every window on one wall ---------------- */
  // Equirectangular grid: each cell knows how many glimpses it holds, which
  // scene is freshest, and what the sky looks like there right now.
  function worldMapCells(glimpses, cols, rows, now) {
    cols = cols || 12; rows = rows || 6;
    var byKey = {};
    for (var i = 0; i < glimpses.length; i++) {
      var p = glimpses[i].place;
      if (!p) continue;
      var x = Math.min(cols - 1, Math.max(0, Math.floor((p.lon + 180) / 360 * cols)));
      var y = Math.min(rows - 1, Math.max(0, Math.floor((90 - p.lat) / 180 * rows)));
      var k = x + ':' + y;
      var c = byKey[k] || (byKey[k] = { x: x, y: y, count: 0, latestTs: 0, emoji: '', places: {} });
      c.count++;
      c.places[p.name || '?'] = 1;
      if ((glimpses[i].ts || 0) >= c.latestTs) {
        c.latestTs = glimpses[i].ts || 0;
        c.emoji = (glimpses[i].scene && glimpses[i].scene.emoji) || '📍';
        c.name = p.name || '';
        c.flag = p.flag || '';
      }
    }
    var cells = [];
    for (var key in byKey) {
      var cell = byKey[key];
      var lonCenter = (cell.x + 0.5) / cols * 360 - 180;
      cell.tod = timeOfDayAt(lonCenter, now);
      var n = 0; for (var q in cell.places) n++;
      cell.placeCount = n;
      cells.push(cell);
    }
    cells.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    return { cols: cols, rows: rows, cells: cells };
  }

  // The sun strip: for each map column, what time of day is it there now.
  function sunStrip(cols, now) {
    var out = [];
    for (var x = 0; x < cols; x++) {
      var lonCenter = (x + 0.5) / cols * 360 - 180;
      out.push(timeOfDayAt(lonCenter, now));
    }
    return out;
  }

  /* ---------------- the passport: how much world you've seen ---------------- */
  // The only score in Glimpse counts WINDOWS, not likes: distinct countries
  // whose glimpses you've genuinely looked through (or posted from).
  function passport(seenCC) {
    var list = [];
    for (var cc in (seenCC || {})) {
      if (seenCC[cc]) list.push({ cc: cc, flag: seenCC[cc].flag || '', country: seenCC[cc].country || cc });
    }
    list.sort(function (a, b) { return a.country < b.country ? -1 : a.country > b.country ? 1 : 0; });
    return list;
  }

  var HORIZONS = [
    { min: 0,  name: 'Windowsill',   emoji: '🪟', hint: 'Open your first window — share what you’re seeing, or look through someone else’s.' },
    { min: 1,  name: 'First Light',  emoji: '🌄', hint: 'One country seen. The world is wide — keep scrolling it.' },
    { min: 3,  name: 'Wanderer',     emoji: '🚶', hint: 'Three countries through the glass. It’s becoming a habit.' },
    { min: 6,  name: 'Pathfinder',   emoji: '🧭', hint: 'Six countries. You cross an ocean before breakfast.' },
    { min: 12, name: 'Globetrotter', emoji: '🌍', hint: 'Twelve countries seen. Your feed has a passport of its own.' },
    { min: 20, name: 'Worldeye',     emoji: '🛰️', hint: 'The highest horizon. Very little happens on Earth without you glancing at it.' }
  ];

  function horizonStage(countries) {
    var n = Math.max(0, countries | 0);
    var cur = HORIZONS[0], next = null;
    for (var i = 0; i < HORIZONS.length; i++) {
      if (n >= HORIZONS[i].min) cur = HORIZONS[i];
      else { next = HORIZONS[i]; break; }
    }
    var progress = 1;
    if (next) progress = (n - cur.min) / (next.min - cur.min);
    return { name: cur.name, emoji: cur.emoji, hint: cur.hint, min: cur.min,
             next: next ? { name: next.name, min: next.min, needed: next.min - n } : null,
             progress: Math.max(0, Math.min(1, progress)) };
  }

  /* ---------------- finding people: search by name or handle ---------------- */
  // Pure ranking over a candidate list — the app feeds it demo personas plus
  // whatever live profiles it has fetched. Exact handle beats handle prefix
  // beats name prefix beats substring; ties break alphabetically by handle so
  // results never reshuffle under the keyboard.
  function searchUsers(query, users, opts) {
    var q = normalizeHandle(query);           // trims, lowercases, strips a leading @
    var wantHandle = /^@/.test(String(query == null ? '' : query).trim());
    if (!q) return [];
    var limit = (opts && opts.limit) || 10;
    var out = [];
    for (var i = 0; i < (users || []).length; i++) {
      var u = users[i];
      var handle = String(u.handle || '').toLowerCase();
      var name = String(u.name || '').toLowerCase();
      var score = 0, match = '';
      if (handle === q) { score = 100; match = 'handle'; }
      else if (handle.indexOf(q) === 0) { score = 70; match = 'handle'; }
      else if (!wantHandle && name.indexOf(q) === 0) { score = 60; match = 'name'; }
      else if (!wantHandle && nameWordStarts(name, q)) { score = 50; match = 'name'; }
      else if (handle.indexOf(q) !== -1) { score = 40; match = 'handle'; }
      else if (!wantHandle && name.indexOf(q) !== -1) { score = 30; match = 'name'; }
      if (!score) continue;
      out.push({ user: u, score: score, match: match });
    }
    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var ha = String(a.user.handle || ''), hb = String(b.user.handle || '');
      return ha < hb ? -1 : ha > hb ? 1 : 0;
    });
    return out.slice(0, limit);
  }
  function nameWordStarts(name, q) {
    var words = name.split(/\s+/);
    for (var i = 1; i < words.length; i++) if (words[i].indexOf(q) === 0) return true;
    return false;
  }

  /* ---------------- activity: quiet, grouped notifications ---------------- */
  // Never forty pings. Events of the same kind on the same target within a
  // 6-hour window collapse into one line — "Maya and 2 others reacted to
  // your post" — newest first, each group carrying a human sentence.
  function groupActivity(events, now) {
    var sorted = (events || []).slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var groups = [], index = {};
    for (var i = 0; i < sorted.length; i++) {
      var e = sorted[i];
      var key = e.type + ':' + (e.targetId || '');
      var g = index[key];
      if (g && g.latestTs - (e.ts || 0) < 6 * HOUR) {
        if (g.actorIds.indexOf(e.actorId) === -1) {
          g.actorIds.push(e.actorId);
          g.actors.push(e.actorName || 'Someone');
        }
        g.count++;
      } else {
        g = { type: e.type, targetId: e.targetId || '', targetLabel: e.targetLabel || '',
              actorIds: [e.actorId], actors: [e.actorName || 'Someone'],
              latestTs: e.ts || 0, count: 1, emoji: e.emoji || '', placeName: e.placeName || '' };
        index[key] = g;
        groups.push(g);
      }
    }
    for (var j = 0; j < groups.length; j++) groups[j].text = activityText(groups[j]);
    return groups;
  }

  function activityText(g) {
    var who = g.actors[0];
    if (g.actors.length === 2) who = g.actors[0] + ' and ' + g.actors[1];
    else if (g.actors.length > 2) who = g.actors[0] + ' and ' + (g.actors.length - 1) + ' others';
    if (g.type === 'react') {
      return who + ' reacted' + (g.actors.length === 1 && g.emoji ? ' ' + g.emoji : '') + ' to your post' +
             (g.targetLabel ? ' “' + g.targetLabel + '”' : '');
    }
    if (g.type === 'near') {
      if (g.actors.length === 1) return who + ' posted from ' + (g.placeName || 'near you') + ' — close to your window';
      return who + ' posted near you';
    }
    return who + ' did something';
  }

  function unreadActivity(events, readTs) {
    var n = 0;
    for (var i = 0; i < (events || []).length; i++) {
      if ((events[i].ts || 0) > (readTs || 0)) n++;
    }
    return n;
  }

  /* ---------------- one honest prompt a day ---------------- */
  var PROMPTS = [
    'Show us your sky, exactly as it is right now.',
    'What’s out the nearest window? No tidying.',
    'Point at something blue where you are.',
    'The street you walk most — show it to a stranger.',
    'What does lunch look like where you live?',
    'Show the light where you are right now.',
    'Something old that you can see from here.',
    'Something growing within ten steps of you.',
    'Look up. Whatever’s there — share it.',
    'Water, wherever you can find it today.',
    'The most ordinary thing in front of you.',
    'The farthest thing you can see from where you stand.',
    'Where would you sit a visitor? Show us the spot.',
    'A colour that owns today where you are.',
    'Show us your weather — let someone feel it.',
    'The view you stopped noticing. Notice it.'
  ];

  function dailyPrompt(isoDate) {
    var idx = hashStr('glimpse-day:' + String(isoDate)) % PROMPTS.length;
    return { date: String(isoDate), prompt: PROMPTS[idx], index: idx };
  }

  /* ---------------- little formatters ---------------- */
  function formatCount(n) {
    n = n || 0;
    if (n < 1000) return String(n);
    if (n < 1000000) return (Math.floor(n / 100) / 10) + 'k';
    return (Math.floor(n / 100000) / 10) + 'm';
  }

  function timeAgo(ts, now) {
    var d = Math.max(0, (now || 0) - (ts || 0));
    if (d < MINUTE) return 'just now';
    if (d < HOUR) return Math.floor(d / MINUTE) + 'm ago';
    if (d < DAY) return Math.floor(d / HOUR) + 'h ago';
    if (d < 7 * DAY) return Math.floor(d / DAY) + 'd ago';
    return Math.floor(d / (7 * DAY)) + 'w ago';
  }

  function round1(x) { return Math.round(x * 10) / 10; }

  /* ---------------- places: real coordinates for real cities ---------------- */
  // The place picker offers these to people who'd rather not share GPS, and
  // geolocation snaps to the nearest one for its country and flag.
  var PLACES = [
    { name: 'Tokyo',          country: 'Japan',          cc: 'JP', flag: '🇯🇵', lat: 35.68,  lon: 139.69 },
    { name: 'London',         country: 'United Kingdom', cc: 'GB', flag: '🇬🇧', lat: 51.51,  lon: -0.13 },
    { name: 'New York',       country: 'United States',  cc: 'US', flag: '🇺🇸', lat: 40.71,  lon: -74.01 },
    { name: 'Lagos',          country: 'Nigeria',        cc: 'NG', flag: '🇳🇬', lat: 6.52,   lon: 3.38 },
    { name: 'Rio de Janeiro', country: 'Brazil',         cc: 'BR', flag: '🇧🇷', lat: -22.91, lon: -43.17 },
    { name: 'Sydney',         country: 'Australia',      cc: 'AU', flag: '🇦🇺', lat: -33.87, lon: 151.21 },
    { name: 'Mumbai',         country: 'India',          cc: 'IN', flag: '🇮🇳', lat: 19.08,  lon: 72.88 },
    { name: 'Cairo',          country: 'Egypt',          cc: 'EG', flag: '🇪🇬', lat: 30.04,  lon: 31.24 },
    { name: 'Reykjavík',      country: 'Iceland',        cc: 'IS', flag: '🇮🇸', lat: 64.15,  lon: -21.94 },
    { name: 'Mexico City',    country: 'Mexico',         cc: 'MX', flag: '🇲🇽', lat: 19.43,  lon: -99.13 },
    { name: 'Nairobi',        country: 'Kenya',          cc: 'KE', flag: '🇰🇪', lat: -1.29,  lon: 36.82 },
    { name: 'Seoul',          country: 'South Korea',    cc: 'KR', flag: '🇰🇷', lat: 37.57,  lon: 126.98 },
    { name: 'Paris',          country: 'France',         cc: 'FR', flag: '🇫🇷', lat: 48.86,  lon: 2.35 },
    { name: 'Vancouver',      country: 'Canada',         cc: 'CA', flag: '🇨🇦', lat: 49.28,  lon: -123.12 },
    { name: 'Istanbul',       country: 'Türkiye',        cc: 'TR', flag: '🇹🇷', lat: 41.01,  lon: 28.98 },
    { name: 'Dhaka',          country: 'Bangladesh',     cc: 'BD', flag: '🇧🇩', lat: 23.81,  lon: 90.41 },
    { name: 'Auckland',       country: 'New Zealand',    cc: 'NZ', flag: '🇳🇿', lat: -36.85, lon: 174.76 },
    { name: 'Cape Town',      country: 'South Africa',   cc: 'ZA', flag: '🇿🇦', lat: -33.92, lon: 18.42 },
    { name: 'Buenos Aires',   country: 'Argentina',      cc: 'AR', flag: '🇦🇷', lat: -34.60, lon: -58.38 },
    { name: 'Rome',           country: 'Italy',          cc: 'IT', flag: '🇮🇹', lat: 41.90,  lon: 12.50 }
  ];

  function placeByName(name) {
    for (var i = 0; i < PLACES.length; i++) if (PLACES[i].name === name) return PLACES[i];
    return null;
  }

  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    MAX_CAPTION: MAX_CAPTION, PLACES: PLACES, PROMPTS: PROMPTS, HORIZONS: HORIZONS,
    hashStr: hashStr, rand01: rand01,
    escapeHTML: escapeHTML, renderCaption: renderCaption, extractTags: extractTags,
    normalizeHandle: normalizeHandle, validateAccount: validateAccount, validateGlimpse: validateGlimpse,
    haversineKm: haversineKm, bearingDeg: bearingDeg, compassDir: compassDir, formatKm: formatKm,
    solarHour: solarHour, timeOfDay: timeOfDay, timeOfDayAt: timeOfDayAt,
    worldFeed: worldFeed, feedHops: feedHops, nearFeed: nearFeed,
    worldMapCells: worldMapCells, sunStrip: sunStrip,
    passport: passport, horizonStage: horizonStage, dailyPrompt: dailyPrompt, searchUsers: searchUsers,
    groupActivity: groupActivity, unreadActivity: unreadActivity,
    formatCount: formatCount, timeAgo: timeAgo,
    placeByName: placeByName
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.GlimpseEngine = E;
})(typeof self !== 'undefined' ? self : this);
