/* Parrot — the pure voice-board engine.
 * =====================================================================
 * Parrot is a pocket voice board: record a voice once (or import a
 * pre-recorded one), and play it back forever — tap a tile, run the
 * whole board as a queue, shuffle it, repeat it. Every rule that
 * decides how a clip is named, validated, coloured, sorted, searched,
 * queued and displayed lives HERE, as pure, deterministic,
 * clock-injected functions with zero DOM and zero I/O — unit-tested in
 * scripts/test-parrot-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  var MIN_CLIP_MS = 500;            // shorter than this is a pocket tap, not a voice
  var MAX_CLIP_MS = 5 * MINUTE;     // a voice board holds phrases, not podcasts
  var MAX_NAME = 40;

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

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- names: what a voice is called ---------------- */

  function cleanName(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function validateName(name, existingNames) {
    var n = cleanName(name);
    if (!n) return { ok: false, reason: 'Give this voice a name.' };
    if (n.length > MAX_NAME) return { ok: false, reason: 'Keep the name under ' + MAX_NAME + ' characters.' };
    var lower = n.toLowerCase();
    for (var i = 0; i < (existingNames || []).length; i++) {
      if (cleanName(existingNames[i]).toLowerCase() === lower) {
        return { ok: false, reason: 'You already have a voice called that.' };
      }
    }
    return { ok: true, name: n };
  }

  // Fresh recordings arrive as "Take N" — the next free number.
  function defaultName(existingNames) {
    var max = 0, m;
    for (var i = 0; i < (existingNames || []).length; i++) {
      m = /^take\s+(\d+)$/i.exec(cleanName(existingNames[i]));
      if (m && Number(m[1]) > max) max = Number(m[1]);
    }
    return 'Take ' + (max + 1);
  }

  // Imports keep their filename but never collide: "Hello" → "Hello 2" → "Hello 3".
  function uniqueName(name, existingNames) {
    var base = cleanName(name);
    if (!base) return defaultName(existingNames);
    if (base.length > MAX_NAME) base = cleanName(base.slice(0, MAX_NAME));
    if (validateName(base, existingNames).ok) return base;
    for (var n = 2; n <= 999; n++) {
      var candidate = base.slice(0, MAX_NAME - (' ' + n).length) + ' ' + n;
      if (validateName(candidate, existingNames).ok) return candidate;
    }
    // 999 collisions deep: fall back to a stable hash suffix.
    return base.slice(0, MAX_NAME - 9) + ' ' + hashStr(base).toString(36);
  }

  /* ---------------- a clip: one pre-recorded voice ---------------- */

  function validateRecording(durationMs) {
    var ms = Number(durationMs) || 0;
    if (ms < MIN_CLIP_MS) return { ok: false, reason: 'Too quick — hold it for at least half a second.' };
    if (ms > MAX_CLIP_MS) return { ok: false, reason: 'Five minutes max — a voice board holds phrases, not podcasts.' };
    return { ok: true };
  }

  function makeClip(input, now) {
    input = input || {};
    var name = cleanName(input.name);
    var durationMs = Math.max(0, Math.round(Number(input.durationMs) || 0));
    var bytes = Math.max(0, Math.round(Number(input.bytes) || 0));
    var id = 'v' + now.toString(36) + '-' +
             hashStr(name + ':' + bytes + ':' + durationMs).toString(36);
    return {
      id: id, name: name, durationMs: durationMs, bytes: bytes,
      type: String(input.type || ''), ts: now, plays: 0
    };
  }

  // Every voice gets a stable colour and face from its id alone — the tiles
  // look the same on every device, every session, with nothing stored.
  var FEATHERS = ['🦜', '🎙️', '📣', '🔊', '🗣️', '🎧', '📻', '🎺', '🥁', '🐦'];

  function clipStyle(id) {
    return {
      hue: hashStr('parrot-hue:' + String(id)) % 360,
      emoji: FEATHERS[hashStr('parrot-face:' + String(id)) % FEATHERS.length]
    };
  }

  /* ---------------- the board: sorting, searching ---------------- */

  var SORTS = ['newest', 'oldest', 'name', 'longest'];

  function sortClips(clips, mode) {
    var out = (clips || []).slice();
    var by = {
      newest:  function (a, b) { return (b.ts || 0) - (a.ts || 0) || cmpId(a, b); },
      oldest:  function (a, b) { return (a.ts || 0) - (b.ts || 0) || cmpId(a, b); },
      name:    function (a, b) {
        var an = cleanName(a.name).toLowerCase(), bn = cleanName(b.name).toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : cmpId(a, b);
      },
      longest: function (a, b) { return (b.durationMs || 0) - (a.durationMs || 0) || (b.ts || 0) - (a.ts || 0) || cmpId(a, b); }
    };
    out.sort(by[mode] || by.newest);
    return out;
  }
  function cmpId(a, b) {
    var ai = String(a.id || ''), bi = String(b.id || '');
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }

  function filterClips(clips, query) {
    var q = cleanName(query).toLowerCase();
    if (!q) return (clips || []).slice();
    var out = [];
    for (var i = 0; i < (clips || []).length; i++) {
      if (cleanName(clips[i].name).toLowerCase().indexOf(q) !== -1) out.push(clips[i]);
    }
    return out;
  }

  /* ---------------- the queue: play the whole board ---------------- */
  // Deterministic Fisher–Yates: the same seed always deals the same shuffle,
  // so tests (and a re-render mid-queue) can reproduce the exact order.
  function buildQueue(clips, opts) {
    opts = opts || {};
    var ids = [];
    for (var i = 0; i < (clips || []).length; i++) ids.push(clips[i].id);
    if (opts.shuffle) {
      for (var j = ids.length - 1; j > 0; j--) {
        var k = Math.floor(rand01(String(opts.seed || '') + ':' + j) * (j + 1));
        var t = ids[j]; ids[j] = ids[k]; ids[k] = t;
      }
    }
    return ids;
  }

  var REPEATS = ['off', 'all', 'one'];

  function nextRepeat(mode) {
    var i = REPEATS.indexOf(mode);
    return REPEATS[(i + 1) % REPEATS.length];
  }

  // Where the queue goes after position `index` finishes (dir +1) or the
  // listener skips back (dir -1). Returns the next index, or -1 for "done".
  function stepQueue(length, index, dir, repeat) {
    length = Math.max(0, length | 0);
    if (length === 0) return -1;
    if (repeat === 'one' && dir !== -1) return index;
    var n = (index | 0) + (dir === -1 ? -1 : 1);
    if (n < 0) return repeat === 'all' ? length - 1 : -1;
    if (n >= length) return repeat === 'all' ? 0 : -1;
    return n;
  }

  /* ---------------- waveforms & progress ---------------- */
  // Fold raw sample data down to N bucket peaks in [0,1] — the bars a tile
  // draws. Normalised to the loudest bucket so quiet clips still show shape.
  function normalizePeaks(samples, buckets) {
    buckets = Math.max(1, buckets | 0) || 48;
    var out = [], b;
    for (b = 0; b < buckets; b++) out.push(0);
    var n = (samples && samples.length) | 0;
    if (!n) return out;
    for (b = 0; b < buckets; b++) {
      var start = Math.floor(b * n / buckets);
      var end = Math.max(start + 1, Math.floor((b + 1) * n / buckets));
      var peak = 0;
      for (var i = start; i < end && i < n; i++) {
        var v = Math.abs(Number(samples[i]) || 0);
        if (v > peak) peak = v;
      }
      out[b] = peak;
    }
    var max = 0;
    for (b = 0; b < buckets; b++) if (out[b] > max) max = out[b];
    if (max > 0) for (b = 0; b < buckets; b++) out[b] = Math.round(out[b] / max * 1000) / 1000;
    return out;
  }

  // A clip with no decodable audio still gets a plausible, stable waveform.
  function pseudoPeaks(id, buckets) {
    buckets = Math.max(1, buckets | 0) || 48;
    var out = [];
    for (var b = 0; b < buckets; b++) {
      var env = Math.sin((b + 0.5) / buckets * Math.PI);           // louder in the middle
      out.push(Math.round((0.25 + 0.75 * rand01(String(id) + ':' + b)) * env * 1000) / 1000);
    }
    return out;
  }

  function playbackProgress(positionMs, durationMs) {
    var d = Number(durationMs) || 0;
    if (d <= 0) return 0;
    return Math.max(0, Math.min(1, (Number(positionMs) || 0) / d));
  }

  /* ---------------- little formatters ---------------- */

  function formatClock(ms) {
    var s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var ss = sec < 10 ? '0' + sec : String(sec);
    if (h > 0) return h + ':' + (m < 10 ? '0' + m : String(m)) + ':' + ss;
    return m + ':' + ss;
  }

  function formatBytes(n) {
    n = Math.max(0, Number(n) || 0);
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1024 * 1024) return (Math.round(n / 1024 * 10) / 10) + ' KB';
    return (Math.round(n / (1024 * 1024) * 10) / 10) + ' MB';
  }

  function timeAgo(ts, now) {
    var d = Math.max(0, (now || 0) - (ts || 0));
    if (d < MINUTE) return 'just now';
    if (d < HOUR) return Math.floor(d / MINUTE) + 'm ago';
    if (d < DAY) return Math.floor(d / HOUR) + 'h ago';
    if (d < 7 * DAY) return Math.floor(d / DAY) + 'd ago';
    return Math.floor(d / (7 * DAY)) + 'w ago';
  }

  function libraryStats(clips) {
    var count = (clips || []).length, totalMs = 0, totalBytes = 0;
    for (var i = 0; i < count; i++) {
      totalMs += Number(clips[i].durationMs) || 0;
      totalBytes += Number(clips[i].bytes) || 0;
    }
    var label = count === 0 ? 'No voices yet'
      : count + (count === 1 ? ' voice' : ' voices') + ' · ' + formatClock(totalMs);
    return { count: count, totalMs: totalMs, totalBytes: totalBytes, label: label };
  }

  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    MIN_CLIP_MS: MIN_CLIP_MS, MAX_CLIP_MS: MAX_CLIP_MS, MAX_NAME: MAX_NAME,
    FEATHERS: FEATHERS, SORTS: SORTS, REPEATS: REPEATS,
    hashStr: hashStr, rand01: rand01, escapeHTML: escapeHTML,
    cleanName: cleanName, validateName: validateName, defaultName: defaultName, uniqueName: uniqueName,
    validateRecording: validateRecording, makeClip: makeClip, clipStyle: clipStyle,
    sortClips: sortClips, filterClips: filterClips,
    buildQueue: buildQueue, nextRepeat: nextRepeat, stepQueue: stepQueue,
    normalizePeaks: normalizePeaks, pseudoPeaks: pseudoPeaks, playbackProgress: playbackProgress,
    formatClock: formatClock, formatBytes: formatBytes, timeAgo: timeAgo,
    libraryStats: libraryStats
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.ParrotEngine = E;
})(typeof self !== 'undefined' ? self : this);
