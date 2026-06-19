/**
 * Ripple — the Messaging Engine
 * =============================
 *
 * The pure, deterministic core behind Ripple, a private messenger that aims to
 * beat the incumbents (WhatsApp et al.) not on reach but on *control*: messages
 * you can schedule, edit, unsend and auto-expire; rich text and slash commands;
 * inline polls; instant full-text search across every chat; and a transport
 * layer that's swappable (a local demo peer today, a real cloud backend the
 * moment you drop in a config — see ./SETUP.md).
 *
 * Everything in this file is framework-free, side-effect-free and deterministic:
 * no DOM, no clock reads except where a `now` is passed in, no randomness except
 * where a `seed`/`id` is passed in. That's what makes the product logic — the
 * bit that's easy to get subtly wrong (search ranking, disappearing-message
 * expiry, scheduled dispatch, reaction toggling, sync de-duplication) — fully
 * unit-testable. The UI in index.html is a thin shell over these functions;
 * persistence (localStorage), encryption (WebCrypto) and transport live there.
 *
 * Loaded the same UMD way as cusp/engine.js and apexvip-lib.js, so it runs both
 * in the browser (`self.Ripple`) and in the Node test sandbox (`module.exports`).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Ripple = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SECOND = 1000, MINUTE = 60000, HOUR = 3600000, DAY = 86400000;

  /* ---------- small helpers ---------- */
  var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* A tiny deterministic id: callers pass a `now` (ms) and optional `rand`
     (0..1). Without a rand it's still unique-enough within a millisecond by
     appending a monotonic counter the caller can supply. Kept pure so tests
     can pin it exactly. */
  var _ctr = 0;
  function makeId(prefix, now, rand) {
    var t = (now == null ? 0 : now).toString(36);
    var r = (rand == null ? (++_ctr) : Math.floor(rand * 1e6)).toString(36);
    return (prefix || 'id') + '_' + t + '_' + r;
  }

  /* ---------- factories ---------- */
  function createChat(opts) {
    opts = opts || {};
    return {
      id: opts.id || makeId('c', opts.now),
      type: opts.type || 'dm',              // 'dm' | 'group' | 'saved'
      name: opts.name || 'New chat',
      avatar: opts.avatar || '💬',          // emoji or data-url
      members: opts.members || [],          // user ids
      pinned: !!opts.pinned,
      muted: !!opts.muted,
      archived: !!opts.archived,
      disappearSec: opts.disappearSec || 0, // 0 = off; else seconds-to-live
      accent: opts.accent || null,          // per-chat theme override
      draft: opts.draft || '',
      createdAt: opts.now || 0
    };
  }

  function createMessage(opts) {
    opts = opts || {};
    var ts = opts.ts != null ? opts.ts : (opts.now || 0);
    var expireAt = opts.expireAt != null ? opts.expireAt : null;
    if (expireAt == null && opts.disappearSec) expireAt = ts + opts.disappearSec * SECOND;
    return {
      id: opts.id || makeId('m', ts, opts.rand),
      chatId: opts.chatId,
      senderId: opts.senderId,
      type: opts.type || 'text',            // text|voice|image|poll|system
      text: opts.text || '',
      ts: ts,
      state: opts.state || 'sent',          // sending|sent|delivered|read|failed
      reactions: opts.reactions || {},      // { emoji: [userId,...] }
      replyTo: opts.replyTo || null,        // message id
      editedAt: opts.editedAt || null,
      deleted: !!opts.deleted,
      starred: !!opts.starred,
      expireAt: expireAt,                   // disappearing
      scheduledAt: opts.scheduledAt || null,// if > ts, hold until due
      readBy: opts.readBy || [],
      meta: opts.meta || {}                 // poll/voice/image payloads
    };
  }

  /* ---------- rich text: a small, safe markdown → HTML ---------- */
  /* Supports *bold*, _italic_, ~strike~, `code`, links, @mentions and emoji.
     Returns SAFE html (input is escaped first). Order matters: we tokenise on
     the escaped string so user angle-brackets can never inject markup. */
  function renderText(raw, opts) {
    opts = opts || {};
    var s = escapeHtml(raw);
    // links first (before italic underscores can eat URL underscores)
    s = s.replace(/\b(https?:\/\/[^\s<]+)/g, function (m) {
      var safe = m.replace(/"/g, '%22');
      return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + m + '</a>';
    });
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~([^~\n]+)~/g, '<del>$1</del>');
    // @mentions — only highlight known member handles when provided
    if (opts.members && opts.members.length) {
      var names = opts.members.map(function (m) { return escapeRegExp(m.handle || m.name || m); }).filter(Boolean);
      if (names.length) {
        var re = new RegExp('@(' + names.join('|') + ')\\b', 'g');
        s = s.replace(re, '<span class="mention">@$1</span>');
      }
    }
    return s;
  }

  /* Detect @mentions present in a body (returns handles, lowercased, unique). */
  function extractMentions(raw) {
    var out = [], seen = {}, m, re = /@([a-z0-9_]{2,32})/gi;
    while ((m = re.exec(raw || '')) !== null) {
      var h = m[1].toLowerCase();
      if (!seen[h]) { seen[h] = 1; out.push(h); }
    }
    return out;
  }

  /* ---------- slash commands ---------- */
  /* Parse a leading "/command args" into a structured intent. Unknown commands
     return {cmd:null} so the UI can fall back to sending literal text. */
  function parseCommand(raw) {
    var text = (raw || '').trim();
    if (text[0] !== '/') return { cmd: null, text: raw };
    var sp = text.indexOf(' ');
    var name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
    var rest = sp === -1 ? '' : text.slice(sp + 1).trim();
    switch (name) {
      case 'shrug': return { cmd: 'append', text: (rest ? rest + ' ' : '') + '¯\\_(ツ)_/¯' };
      case 'me': return { cmd: 'action', text: rest };                 // emote
      case 'poll': return parsePoll(rest);                              // /poll Q? a | b | c
      case 'remind': return parseRemind(rest);                         // /remind 10m text
      case 'shout': return { cmd: 'append', text: rest.toUpperCase() };
      case 'clear': return { cmd: 'clear' };
      case 'expire': return { cmd: 'expire', seconds: parseDuration(rest) };
      case 'giphy': return { cmd: 'giphy', query: rest };
      default: return { cmd: 'unknown', name: name, text: raw };
    }
  }

  function parsePoll(rest) {
    // "Question? opt1 | opt2 | opt3"  — question ends at first "?" or before opts
    var parts = rest.split('|').map(function (p) { return p.trim(); }).filter(Boolean);
    if (parts.length < 2) return { cmd: 'error', error: 'A poll needs a question and at least two options.' };
    var first = parts.shift();
    var q = first, lead = first;
    var qm = first.lastIndexOf('?');
    if (qm !== -1 && qm < first.length - 1) {
      // an option was glued to the question without a pipe — keep it simple, treat all after '?' as first option
      q = first.slice(0, qm + 1);
      lead = first.slice(qm + 1).trim();
      if (lead) parts.unshift(lead);
    } else { q = first; }
    return { cmd: 'poll', question: q, options: parts };
  }

  function parseRemind(rest) {
    var m = rest.match(/^(\S+)\s+([\s\S]+)$/);
    if (!m) return { cmd: 'error', error: 'Usage: /remind 10m Take the cake out' };
    var secs = parseDuration(m[1]);
    if (!secs) return { cmd: 'error', error: 'I did not understand "' + m[1] + '". Try 10m, 2h, 1d.' };
    return { cmd: 'remind', seconds: secs, text: m[2].trim() };
  }

  /* "10m"/"2h"/"90s"/"1d"/"45" → seconds (bare number = minutes). */
  function parseDuration(s) {
    s = (s || '').trim().toLowerCase();
    var m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|hour|d|day|w|week)?s?$/);
    if (!m) return 0;
    var n = parseFloat(m[1]); var u = m[2] || 'm';
    var mult = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, hour: 3600, d: 86400, day: 86400, w: 604800, week: 604800 };
    return Math.round(n * (mult[u] || 60));
  }

  /* ---------- reactions, edit, unsend ---------- */
  /* Toggle a user's reaction; mutates a copy is the caller's job — we mutate the
     passed message's reactions map and return it for chaining convenience. */
  function toggleReaction(msg, emoji, userId) {
    var r = msg.reactions || (msg.reactions = {});
    var list = r[emoji] || (r[emoji] = []);
    var i = list.indexOf(userId);
    if (i === -1) list.push(userId); else list.splice(i, 1);
    if (list.length === 0) delete r[emoji];
    return msg;
  }

  function reactionSummary(msg) {
    var r = msg.reactions || {}, out = [];
    for (var k in r) if (r.hasOwnProperty(k) && r[k].length) out.push({ emoji: k, count: r[k].length });
    out.sort(function (a, b) { return b.count - a.count; });
    return out;
  }

  function editMessage(msg, newText, now) {
    if (msg.deleted) return msg;
    msg.text = newText;
    msg.editedAt = now;
    return msg;
  }

  /* Unsend ("delete for everyone"): keep the record so ordering/threads hold,
     but blank the content. Distinct from a hard local delete. */
  function unsendMessage(msg, now) {
    msg.deleted = true;
    msg.text = '';
    msg.type = 'system';
    msg.meta = { unsentAt: now, was: msg.type };
    msg.reactions = {};
    return msg;
  }

  /* ---------- disappearing + scheduled ---------- */
  function isExpired(msg, now) {
    return !!(msg.expireAt && msg.expireAt <= now);
  }
  function isPending(msg, now) {
    return !!(msg.scheduledAt && msg.scheduledAt > now);
  }
  /* Partition a message list at `now`: live (visible), due (scheduled and now
     ready to send), expired (to be removed). Pure — returns id lists. */
  function tick(messages, now) {
    var live = [], due = [], expired = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (isExpired(m, now)) { expired.push(m.id); continue; }
      if (isPending(m, now)) continue;            // still scheduled, not shown yet
      if (m.scheduledAt && m.scheduledAt <= now) due.push(m.id); // just became due
      live.push(m);
    }
    return { live: live, due: due, expired: expired };
  }

  /* ---------- polls ---------- */
  function votePoll(msg, optionIndex, userId) {
    if (msg.type !== 'poll') return msg;
    var votes = msg.meta.votes || (msg.meta.votes = {});
    // single-choice: remove this user from any other option first
    for (var k in votes) if (votes.hasOwnProperty(k)) {
      var idx = votes[k].indexOf(userId);
      if (idx !== -1 && Number(k) !== optionIndex) votes[k].splice(idx, 1);
    }
    var list = votes[optionIndex] || (votes[optionIndex] = []);
    var i = list.indexOf(userId);
    if (i === -1) list.push(userId); else list.splice(i, 1);
    return msg;
  }
  function pollTally(msg) {
    var opts = (msg.meta && msg.meta.options) || [];
    var votes = (msg.meta && msg.meta.votes) || {};
    var total = 0, counts = opts.map(function (_, i) { var c = (votes[i] || []).length; total += c; return c; });
    return opts.map(function (label, i) {
      return { label: label, count: counts[i], pct: total ? Math.round(counts[i] / total * 100) : 0 };
    });
  }

  /* ---------- search ---------- */
  function tokenize(s) {
    return (s || '').toLowerCase().match(/[a-z0-9@#]+/g) || [];
  }
  /* Rank: every query token must appear (AND). Score rewards exact-phrase hits,
     whole-word hits and recency. Returns sorted [{message, score, snippet}]. */
  function searchMessages(messages, query, opts) {
    opts = opts || {};
    var q = (query || '').trim().toLowerCase();
    if (!q) return [];
    var qTokens = tokenize(q);
    if (!qTokens.length) return [];
    var now = opts.now || 0;
    var results = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.deleted || m.type === 'system') continue;
      var hay = (m.text || '').toLowerCase();
      var ok = true, score = 0;
      for (var t = 0; t < qTokens.length; t++) {
        var tok = qTokens[t];
        var at = hay.indexOf(tok);
        if (at === -1) { ok = false; break; }
        score += 1;
        if (new RegExp('\\b' + escapeRegExp(tok) + '\\b').test(hay)) score += 0.5; // whole word
      }
      if (!ok) continue;
      if (hay.indexOf(q) !== -1) score += 2;                       // exact phrase
      if (now) score += clamp01(1 - (now - m.ts) / (30 * DAY)) * 0.5; // mild recency
      results.push({ message: m, score: score, snippet: snippet(m.text, qTokens[0]) });
    }
    results.sort(function (a, b) { return b.score - a.score || b.message.ts - a.message.ts; });
    return results;
  }
  function snippet(text, token, span) {
    text = text || ''; span = span || 32;
    var at = text.toLowerCase().indexOf((token || '').toLowerCase());
    if (at === -1) return text.slice(0, span * 2);
    var start = Math.max(0, at - span), end = Math.min(text.length, at + token.length + span);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }

  /* ---------- chat list summaries ---------- */
  function lastVisible(messages, now) {
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      if (isExpired(m, now) || isPending(m, now)) continue;
      return m;
    }
    return null;
  }
  function unreadCount(messages, meId, now) {
    var n = 0;
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.senderId === meId || m.deleted) continue;
      if (isExpired(m, now) || isPending(m, now)) continue;
      if ((m.readBy || []).indexOf(meId) === -1) n++;
    }
    return n;
  }
  function previewText(msg) {
    if (!msg) return '';
    if (msg.deleted) return '🚫 This message was unsent';
    switch (msg.type) {
      case 'voice': return '🎤 Voice message' + (msg.meta && msg.meta.dur ? ' · ' + formatDur(msg.meta.dur) : '');
      case 'image': return '📷 Photo';
      case 'poll': return '📊 ' + ((msg.meta && msg.meta.question) || 'Poll');
      case 'system': return msg.text || '—';
      default: return (msg.text || '').replace(/\n+/g, ' ');
    }
  }
  /* Build the ordered sidebar: pinned first, then by last-activity desc.
     Each entry carries preview + unread + timestamp. */
  function summarizeChats(chats, messagesByChat, meId, now) {
    var rows = chats.filter(function (c) { return !c.archived; }).map(function (c) {
      var msgs = messagesByChat[c.id] || [];
      var last = lastVisible(msgs, now);
      return {
        chat: c,
        last: last,
        preview: previewText(last),
        unread: c.muted ? 0 : unreadCount(msgs, meId, now),
        ts: last ? last.ts : c.createdAt
      };
    });
    rows.sort(function (a, b) {
      if (!!a.chat.pinned !== !!b.chat.pinned) return a.chat.pinned ? -1 : 1;
      return b.ts - a.ts;
    });
    return rows;
  }
  function totalUnread(chats, messagesByChat, meId, now) {
    return chats.reduce(function (sum, c) {
      if (c.muted || c.archived) return sum;
      return sum + unreadCount(messagesByChat[c.id] || [], meId, now);
    }, 0);
  }

  /* ---------- sync / merge (for the swappable cloud transport) ---------- */
  /* De-duplicate by id, prefer the most-recently-edited copy, keep ts order.
     This is what lets a local store and a remote store reconcile cleanly. */
  function mergeMessages(a, b) {
    var byId = {};
    function take(list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i], cur = byId[m.id];
        if (!cur) { byId[m.id] = m; continue; }
        var mEdit = m.editedAt || m.ts, cEdit = cur.editedAt || cur.ts;
        if (m.deleted && !cur.deleted) byId[m.id] = m;
        else if (mEdit > cEdit) byId[m.id] = m;
      }
    }
    take(a || []); take(b || []);
    var out = [];
    for (var k in byId) if (byId.hasOwnProperty(k)) out.push(byId[k]);
    out.sort(function (x, y) { return x.ts - y.ts || (x.id < y.id ? -1 : 1); });
    return out;
  }

  /* ---------- time formatting ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function formatDur(sec) {
    sec = Math.round(sec || 0);
    return Math.floor(sec / 60) + ':' + pad(sec % 60);
  }
  /* WhatsApp-style relative clock for the sidebar. Deterministic given now. */
  function relativeTime(ts, now) {
    if (!ts) return '';
    var d = now - ts;
    if (d < MINUTE) return 'now';
    if (d < HOUR) return Math.floor(d / MINUTE) + 'm';
    var a = new Date(ts), b = new Date(now);
    var sameDay = a.toDateString() === b.toDateString();
    if (sameDay) return pad(a.getHours()) + ':' + pad(a.getMinutes());
    var yest = new Date(now - DAY);
    if (a.toDateString() === yest.toDateString()) return 'Yesterday';
    if (d < 7 * DAY) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][a.getDay()];
    return pad(a.getDate()) + '/' + pad(a.getMonth() + 1) + '/' + (a.getFullYear() % 100);
  }
  /* A day-divider label for the message timeline. */
  function dayLabel(ts, now) {
    var a = new Date(ts), b = new Date(now), yest = new Date(now - DAY);
    if (a.toDateString() === b.toDateString()) return 'Today';
    if (a.toDateString() === yest.toDateString()) return 'Yesterday';
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][a.getMonth()] +
      ' ' + a.getDate() + (a.getFullYear() !== b.getFullYear() ? ', ' + a.getFullYear() : '');
  }
  /* Group a chronological message list into [{label, items:[...]}] by day. */
  function groupByDay(messages, now) {
    var groups = [], cur = null;
    for (var i = 0; i < messages.length; i++) {
      var lbl = dayLabel(messages[i].ts, now);
      if (!cur || cur.label !== lbl) { cur = { label: lbl, items: [] }; groups.push(cur); }
      cur.items.push(messages[i]);
    }
    return groups;
  }

  /* ---------- the demo peer ("Echo"): a deterministic auto-responder so the
     app is fully alive offline, with no backend. Rule-based, no randomness
     unless a seed is passed. This is ONLY the demo transport; real chats use
     the cloud transport in index.html / SETUP.md. ---------- */
  function autoReply(incomingText, ctx) {
    ctx = ctx || {};
    var t = (incomingText || '').trim();
    var low = t.toLowerCase();
    if (!t) return "Still there? 👀";
    if (/\b(hi|hey|hello|yo|salaam|salam|hola)\b/.test(low)) return 'Hey! 👋 Ripple feels nicer than the green app already, right?';
    if (/\?$/.test(t)) {
      if (/when|time/.test(low)) return 'However long it takes — and you can schedule a reply so future-you does not forget.';
      if (/where/.test(low)) return 'Drop a 📍 and I will find it. (Location sharing is on the roadmap.)';
      if (/how are you|how's it going|hows it going/.test(low)) return 'Encrypted and unbothered. You?';
      return 'Good question. Try long-pressing my last message — you can react, reply, star or even unsend.';
    }
    if (/\bthank|thanks|cheers|ty\b/.test(low)) return 'Any time. 💙';
    if (/\b(bye|gtg|later|cya)\b/.test(low)) return 'Catch you later. Your draft saves automatically if you head out.';
    if (/love|❤|💙|😍/.test(low)) return '🥰 right back at you.';
    if (/\bpoll\b/.test(low)) return 'Polls are built in — type "/poll Pizza tonight? Yes | No | Maybe".';
    if (/\bsecret|private|encrypt/.test(low)) return 'Flip on App Lock in Settings — everything gets sealed with AES-GCM, keyed from your passphrase (PBKDF2). 🔐';
    if (t.length < 4) return t + '? 🙂';
    // default: a light reflection so the conversation feels responsive
    var openers = ['Love that.', 'Makes sense.', 'Oh nice —', 'Totally.', 'Go on…'];
    var idx = ctx.seed != null ? Math.abs(ctx.seed) % openers.length : (t.length % openers.length);
    return openers[idx] + ' ' + reflect(t);
  }
  function reflect(t) {
    var s = t.replace(/\bi am\b/gi, 'you are').replace(/\bi'm\b/gi, "you're")
      .replace(/\bmy\b/gi, 'your').replace(/\bme\b/gi, 'you').replace(/\bI\b/g, 'you');
    if (s.length > 80) s = s.slice(0, 77).trim() + '…';
    return /[.!?…]$/.test(s) ? s : s + '.';
  }

  return {
    version: '1.0.0',
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    makeId: makeId, createChat: createChat, createMessage: createMessage,
    escapeHtml: escapeHtml, renderText: renderText, extractMentions: extractMentions,
    parseCommand: parseCommand, parseDuration: parseDuration,
    toggleReaction: toggleReaction, reactionSummary: reactionSummary,
    editMessage: editMessage, unsendMessage: unsendMessage,
    isExpired: isExpired, isPending: isPending, tick: tick,
    votePoll: votePoll, pollTally: pollTally,
    tokenize: tokenize, searchMessages: searchMessages, snippet: snippet,
    lastVisible: lastVisible, unreadCount: unreadCount, previewText: previewText,
    summarizeChats: summarizeChats, totalUnread: totalUnread, mergeMessages: mergeMessages,
    formatDur: formatDur, relativeTime: relativeTime, dayLabel: dayLabel, groupByDay: groupByDay,
    autoReply: autoReply
  };
});
