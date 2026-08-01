/* Bloom — the pure social engine.
 * =================================================================
 * Every rule that decides what you see, what trends, what your garden
 * grows into, and when the app nudges you lives here — as pure,
 * deterministic, clock-injected functions with zero DOM and zero I/O,
 * so all of it is unit-testable (scripts/test-bloom-logic.mjs) and all
 * of it can be SHOWN to the user. Bloom's whole premise is that the
 * algorithm belongs to the person scrolling; this file is that
 * algorithm, and index.html just renders it.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

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
    // xorshift a couple of rounds so nearby seeds don't correlate
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  }

  /* ---------------- text: escaping, rendering, extraction ---------------- */

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var TAG_RE = /(^|[^\w&])#([\p{L}\p{N}_]{2,30})/gu;
  var MENTION_RE = /(^|[^\w@])@([a-z0-9_]{2,20})/gi;
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

  function extractMentions(text) {
    var out = [], seen = {}, m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(String(text || ''))) !== null) {
      var h = m[2].toLowerCase();
      if (!seen[h]) { seen[h] = 1; out.push(h); }
    }
    return out;
  }

  // Escape FIRST, then decorate. Output contains only markup we created.
  function renderText(text) {
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
    s = s.replace(MENTION_RE, function (_all, pre, handle) {
      return pre + '<span class="mention" data-handle="' + handle.toLowerCase() + '">@' + handle + '</span>';
    });
    s = s.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    s = s.replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  var MAX_POST = 500;
  function validatePost(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return { ok: false, reason: 'Say something first.' };
    if (t.length > MAX_POST) return { ok: false, reason: 'Keep it under ' + MAX_POST + ' characters (' + t.length + ' now).' };
    return { ok: true, text: t };
  }

  /* ---------------- the feed: a ranking the user owns ---------------- */
  //
  // Four sliders, 0..100, each one a real term in the score — not a vibe:
  //   fresh — how hard recency decays the feed
  //   close — how much the people you actually talk with rise
  //   spark — how much serendipity (great posts from strangers) is invited in
  //   calm  — how hard heated/outraged posts sink
  // Every scored post carries a `reasons` receipt whose parts SUM to the score,
  // so "Why am I seeing this?" is an audit, not a shrug.

  var DEFAULT_WEIGHTS = { fresh: 60, close: 60, spark: 35, calm: 60, chrono: false };

  function postScore(post, ctx, weights, now) {
    var w = weights || DEFAULT_WEIGHTS;
    var reasons = [];
    var score = 0;

    // Recency: exponential decay, half-life 18h at fresh=50 (shorter when
    // fresher-hungry, longer when relaxed). Up to `fresh` points.
    var ageH = Math.max(0, (now - (post.ts || 0)) / HOUR);
    var half = 36 - 0.36 * (w.fresh || 0); // fresh 0 → 36h, 100 → ~0? clamp
    if (half < 6) half = 6;
    var recency = (w.fresh || 0) * Math.pow(0.5, ageH / half);
    if (recency >= 0.5) {
      score += recency;
      reasons.push({ key: 'fresh', label: 'Posted ' + timeAgo(post.ts, now), pts: round1(recency) });
    }

    // Closeness: who you actually exchange with. ctx.closeness maps
    // authorId → 0..1 (the app derives it from real interactions).
    var c = (ctx.closeness && ctx.closeness[post.authorId]) || 0;
    if (c > 0) {
      var closePts = (w.close || 0) * c;
      score += closePts;
      reasons.push({ key: 'close', label: 'You and ' + (post.authorName || 'they') + ' interact often', pts: round1(closePts) });
    }

    // Following: a modest, fixed floor so the people you chose stay present
    // even when you never react to them.
    var follows = ctx.following && ctx.following.indexOf(post.authorId) !== -1;
    if (follows) {
      score += 12;
      reasons.push({ key: 'follow', label: 'You follow ' + (post.authorName || 'them'), pts: 12 });
    }

    // Interests: tags you told Bloom you care about.
    var tags = post.tags || extractTags(post.text);
    if (ctx.interests && ctx.interests.length && tags.length) {
      var hits = [];
      for (var i = 0; i < tags.length; i++) {
        if (ctx.interests.indexOf(tags[i]) !== -1) hits.push('#' + tags[i]);
      }
      if (hits.length) {
        var intPts = Math.min(20, 10 * hits.length);
        score += intPts;
        reasons.push({ key: 'interest', label: 'Matches your interest ' + hits.join(' '), pts: intPts });
      }
    }

    // Spark: deterministic serendipity for authors you DON'T follow — the
    // same post gets the same luck all day (seeded by post id + the date),
    // so the feed doesn't reshuffle under your thumb.
    if (!follows && (w.spark || 0) > 0) {
      var daySeed = Math.floor(now / DAY);
      var luck = rand01('spark:' + post.id + ':' + daySeed);
      if (luck > 0.72) {
        var sparkPts = (w.spark || 0) * (luck - 0.72) / 0.28;
        score += sparkPts;
        reasons.push({ key: 'spark', label: 'Serendipity — a voice outside your circle', pts: round1(sparkPts) });
      }
    }

    // Calm: heated writing sinks in proportion to how heated it reads and how
    // much calm you asked for. Transparent — the receipt says so.
    var heat = heatCheck(post.text || '');
    if (heat.level > 0 && (w.calm || 0) > 0) {
      var calmPts = -((w.calm || 0) * 0.35 * heat.level);
      score += calmPts;
      reasons.push({ key: 'calm', label: 'Turned down: reads heated', pts: round1(calmPts) });
    }

    return { score: round1(score), reasons: reasons };
  }

  function rankFeed(posts, ctx, weights, now) {
    var w = weights || DEFAULT_WEIGHTS;
    var scored = [];
    for (var i = 0; i < posts.length; i++) {
      var p = posts[i];
      if (!audienceCan(p, ctx.myId, ctx)) continue;
      if (w.chrono) {
        scored.push({ post: p, score: 0, reasons: [{ key: 'chrono', label: 'Chronological — newest first', pts: 0 }] });
      } else {
        var s = postScore(p, ctx, w, now);
        scored.push({ post: p, score: s.score, reasons: s.reasons });
      }
    }
    scored.sort(function (a, b) {
      if (w.chrono) return (b.post.ts || 0) - (a.post.ts || 0);
      if (b.score !== a.score) return b.score - a.score;
      return (b.post.ts || 0) - (a.post.ts || 0);
    });
    return scored;
  }

  /* ---------------- audiences (Circles) ---------------- */
  // post.audience: 'everyone' (default) | 'followers' | 'inner'
  // ctx: { myId, followerOf?: {authorId: true}, innerOf?: {authorId: true} }
  function audienceCan(post, viewerId, ctx) {
    var aud = post.audience || 'everyone';
    if (aud === 'everyone') return true;
    if (post.authorId === viewerId) return true;
    if (aud === 'followers') return !!(ctx && ctx.followerOf && ctx.followerOf[post.authorId]);
    if (aud === 'inner') return !!(ctx && ctx.innerOf && ctx.innerOf[post.authorId]);
    return false;
  }

  /* ---------------- caught up: the feed has an end ---------------- */
  // Split a ranked/plain feed at the "you're all caught up" line: everything
  // newer than the last visit is fresh; the rest is the archive below the line.
  function caughtUpSplit(items, lastVisitTs) {
    var fresh = [], older = [];
    for (var i = 0; i < items.length; i++) {
      var ts = items[i].post ? items[i].post.ts : items[i].ts;
      if ((ts || 0) > (lastVisitTs || 0)) fresh.push(items[i]);
      else older.push(items[i]);
    }
    return { fresh: fresh, older: older };
  }

  /* ---------------- heat check: kindness has a compiler warning ---------------- */
  // On-device, transparent, and humble: it never blocks, it asks. Looks at
  // insult vocabulary, accusatory second person, shouting caps and !!! runs.
  var INSULTS = ['idiot', 'stupid', 'dumb', 'moron', 'loser', 'pathetic', 'trash',
    'garbage', 'clown', 'fool', 'shut up', 'hate you', 'worst', 'disgusting',
    'braindead', 'worthless', 'imbecile', 'liar', 'fraud', 'scum'];
  var ACCUSE_RE = /\byou (always|never|people|all|lot)\b/i;

  function heatCheck(text) {
    var t = String(text || '');
    var lower = t.toLowerCase();
    var pts = 0, reasons = [];

    var found = [];
    for (var i = 0; i < INSULTS.length; i++) {
      if (lower.indexOf(INSULTS[i]) !== -1) found.push(INSULTS[i]);
    }
    if (found.length) { pts += 2 * found.length; reasons.push('name-calling ("' + found[0] + '")'); }

    if (ACCUSE_RE.test(t)) { pts += 1; reasons.push('sweeping accusation ("you always/never…")'); }

    var letters = t.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= 12) {
      var caps = letters.replace(/[^A-Z]/g, '').length;
      if (caps / letters.length > 0.6) { pts += 1; reasons.push('all-caps shouting'); }
    }
    if (/!{3,}/.test(t)) { pts += 1; reasons.push('a lot of exclamation'); }

    var level = pts >= 4 ? 2 : pts >= 2 ? 1 : 0;
    var suggestion = level === 2
      ? 'This reads like it was written at full temperature. Bloom will post it if you want — but would future-you send it?'
      : level === 1
        ? 'This might land harsher than you mean it to. Want a second look before it posts?'
        : null;
    return { level: level, points: pts, reasons: reasons, suggestion: suggestion };
  }

  /* ---------------- trending, with receipts ---------------- */
  // Score per tag = Σ over posts exp(-age/12h). Every entry carries its own
  // receipt (posts, distinct voices, freshest post) — trends you can audit.
  function trendingTopics(posts, now, opts) {
    var limit = (opts && opts.limit) || 6;
    var byTag = {};
    for (var i = 0; i < posts.length; i++) {
      var p = posts[i];
      if ((p.audience || 'everyone') !== 'everyone') continue; // private posts never trend
      var tags = p.tags || extractTags(p.text);
      if (!tags.length) continue;
      var age = Math.max(0, now - (p.ts || 0));
      var wgt = Math.exp(-age / (12 * HOUR));
      for (var j = 0; j < tags.length; j++) {
        var t = tags[j];
        var e = byTag[t] || (byTag[t] = { tag: t, score: 0, posts: 0, authors: {}, latestTs: 0 });
        e.score += wgt;
        e.posts += 1;
        e.authors[p.authorId || '?'] = 1;
        if ((p.ts || 0) > e.latestTs) e.latestTs = p.ts || 0;
      }
    }
    var list = [];
    for (var k in byTag) {
      var en = byTag[k];
      var voices = 0; for (var a in en.authors) voices++;
      list.push({ tag: en.tag, score: round1(en.score), posts: en.posts, voices: voices, latestTs: en.latestTs });
    }
    list.sort(function (a, b) { return b.score - a.score || b.posts - a.posts || (a.tag < b.tag ? -1 : 1); });
    return list.slice(0, limit);
  }

  /* ---------------- the Garden: growth from giving ---------------- */
  // The only "score" in Bloom measures what you GIVE — comments weigh most,
  // reactions least, posting sits between. Scrolling earns nothing.
  function givingScore(stats) {
    var s = stats || {};
    return Math.max(0, Math.round(
      4 * (s.commentsGiven || 0) +
      2 * (s.postsMade || 0) +
      1 * (s.reactionsGiven || 0)
    ));
  }

  var GARDEN = [
    { min: 0,   name: 'Seed',    emoji: '🌰', hint: 'Say hello — comment on something that moved you.' },
    { min: 10,  name: 'Sprout',  emoji: '🌱', hint: 'It’s growing. Keep giving more than you take.' },
    { min: 30,  name: 'Seedling',emoji: '🌿', hint: 'Real conversations make real roots.' },
    { min: 60,  name: 'Bud',     emoji: '🪴', hint: 'People notice you show up for them.' },
    { min: 100, name: 'Bloom',   emoji: '🌸', hint: 'You give more than you scroll. Rare.' },
    { min: 180, name: 'Garden',  emoji: '🌷', hint: 'A whole corner of Bloom is warmer because of you.' },
    { min: 300, name: 'Grove',   emoji: '🌳', hint: 'The highest stage. Communities grow in your shade.' }
  ];

  function gardenStage(score) {
    var cur = GARDEN[0], next = null;
    for (var i = 0; i < GARDEN.length; i++) {
      if (score >= GARDEN[i].min) cur = GARDEN[i];
      else { next = GARDEN[i]; break; }
    }
    var progress = 1;
    if (next) progress = (score - cur.min) / (next.min - cur.min);
    return { name: cur.name, emoji: cur.emoji, hint: cur.hint, min: cur.min,
             next: next ? { name: next.name, min: next.min, needed: next.min - score } : null,
             progress: Math.max(0, Math.min(1, progress)) };
  }

  /* ---------------- Spark: one honest prompt a day ---------------- */
  var PROMPTS = [
    'What made you laugh today?',
    'Share one thing you learned this week.',
    'What are you quietly proud of right now?',
    'Show the view from where you are — no staging.',
    'Who helped you recently? Thank them here.',
    'What’s a small thing that made today better?',
    'What are you looking forward to?',
    'Recommend one thing — a book, a song, a street.',
    'What did you almost not share? Share it.',
    'What’s something you changed your mind about?',
    'Describe today in exactly five words.',
    'What would you tell yourself a year ago?',
    'What’s the best thing you ate this week?',
    'One photo, zero filters. What’s in front of you?',
    'What skill are you slowly getting better at?',
    'Ask a question you genuinely want answered.'
  ];

  function sparkPrompt(isoDate) {
    var idx = hashStr('spark-day:' + String(isoDate)) % PROMPTS.length;
    return { date: String(isoDate), prompt: PROMPTS[idx], index: idx };
  }

  /* ---------------- activity: grouped, humane notifications ---------------- */
  // Collapse same (type, target) events within a 6h window into one line:
  // "Maya and 3 others reacted to your post" — never 40 pings.
  function groupActivity(events, now) {
    var sorted = events.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var groups = [];
    var index = {};
    for (var i = 0; i < sorted.length; i++) {
      var e = sorted[i];
      var key = e.type + ':' + (e.targetId || '');
      var g = index[key];
      if (g && g.latestTs - (e.ts || 0) < 6 * HOUR) {
        if (g.actorIds.indexOf(e.actorId) === -1) {
          g.actorIds.push(e.actorId);
          g.actors.push(e.actorName || e.actorId);
        }
        g.count++;
      } else {
        g = { type: e.type, targetId: e.targetId || '', targetText: e.targetText || '',
              actorIds: [e.actorId], actors: [e.actorName || e.actorId],
              latestTs: e.ts || 0, count: 1, emoji: e.emoji || '' };
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
    var verb =
      g.type === 'react'   ? 'reacted ' + (g.emoji || '💛') + ' to your post' :
      g.type === 'comment' ? 'commented on your post' :
      g.type === 'follow'  ? (g.actors.length > 1 ? 'started following you' : 'started following you') :
      g.type === 'mention' ? 'mentioned you' :
      g.type === 'repost'  ? 'shared your post' : 'interacted with you';
    return who + ' ' + verb;
  }

  /* ---------------- session timekeeper: the app that says "enough" ---------------- */
  function sessionAdvice(msActive) {
    var m = msActive / MINUTE;
    if (m >= 40) return { level: 2, minutes: Math.floor(m), msg: 'You’ve been here ' + Math.floor(m) + ' minutes. Bloom will still be here later — the day won’t be.' };
    if (m >= 20) return { level: 1, minutes: Math.floor(m), msg: Math.floor(m) + ' minutes this session. All caught up is a real place — you’ve probably reached it.' };
    return { level: 0, minutes: Math.floor(m), msg: null };
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

  /* ---------------- closeness from an interaction ledger ---------------- */
  // The app records {authorId, kind} interactions; closeness is a saturating
  // curve so no one can "max out" — comments count double.
  function closenessMap(interactions) {
    var raw = {};
    for (var i = 0; i < (interactions || []).length; i++) {
      var it = interactions[i];
      raw[it.authorId] = (raw[it.authorId] || 0) + (it.kind === 'comment' ? 2 : 1);
    }
    var out = {};
    for (var k in raw) out[k] = round2(1 - Math.exp(-raw[k] / 6));
    return out;
  }
  function round2(x) { return Math.round(x * 100) / 100; }

  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    MAX_POST: MAX_POST, DEFAULT_WEIGHTS: DEFAULT_WEIGHTS, PROMPTS: PROMPTS, GARDEN: GARDEN,
    hashStr: hashStr, rand01: rand01,
    escapeHTML: escapeHTML, renderText: renderText,
    extractTags: extractTags, extractMentions: extractMentions, validatePost: validatePost,
    postScore: postScore, rankFeed: rankFeed, audienceCan: audienceCan,
    caughtUpSplit: caughtUpSplit, heatCheck: heatCheck, trendingTopics: trendingTopics,
    givingScore: givingScore, gardenStage: gardenStage, sparkPrompt: sparkPrompt,
    groupActivity: groupActivity, sessionAdvice: sessionAdvice,
    formatCount: formatCount, timeAgo: timeAgo, closenessMap: closenessMap
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.BloomEngine = E;
})(typeof self !== 'undefined' ? self : this);
