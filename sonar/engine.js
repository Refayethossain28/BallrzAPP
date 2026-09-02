/* Sonar — an AI that searches the live web in real time.
 *
 * You ask a question; Sonar pings the live web and answers from what is out
 * there RIGHT NOW — streaming the answer word-by-word, narrating each web
 * search as it happens ("searching… found 8 results…"), and pinning a
 * numbered, clickable source onto every fact it takes from a page.
 *
 * This engine is every rule of the app and nothing else: building the
 * Anthropic Messages API request (the model's `web_search` tool does the
 * actual web browsing on Anthropic's servers), parsing the SSE byte stream,
 * reducing raw stream events into Sonar's own little event language (text /
 * searching / found / cite / turn), numbering and de-duplicating cited
 * sources, reconstructing assistant content blocks so a paused turn
 * (`pause_turn`) can be resumed, and rendering the answer safely (escape
 * first, decorate after). The same reducer runs in three places: the local
 * proxy server, the browser's bring-your-own-key mode, and the unit tests.
 *
 * Prototype honesty: offline mode does not search anything — offlineAnswer()
 * is a deterministic, clearly-labelled simulation so the app still does
 * something with zero network, per house rules.
 *
 * Pure and deterministic: `now` is always an argument — the engine never
 * reads the clock — and there is no DOM, no fetch, no storage in here.
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
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  /* ---------------- text safety ---------------- */

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Host of a URL without the URL constructor (the smoke sandbox has none).
  function domainOf(url) {
    var m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(String(url || ''));
    if (!m) return '';
    return m[1].replace(/^www\./i, '').toLowerCase().split('@').pop().split(':')[0];
  }

  // Canonical form for de-duplicating sources: scheme-less, hash-less,
  // trailing-slash-less, lowercased host. Two links to the same page count once.
  function canonicalURL(url) {
    var s = String(url || '').trim();
    s = s.replace(/#.*$/, '');
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)(.*)$/.exec(s);
    if (m) s = m[2].toLowerCase().replace(/^www\./, '') + m[3];
    if (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
    return s;
  }

  /* ---------------- what counts as an askable question ---------------- */

  var QUESTION_MAX = 2000;

  function validateQuestion(q) {
    var s = String(q == null ? '' : q).replace(/\s+/g, ' ').trim();
    if (!s) return { ok: false, reason: 'Ask something first — the web is waiting.' };
    if (s.length > QUESTION_MAX) return { ok: false, reason: 'Keep it under ' + QUESTION_MAX + ' characters — this is a question, not a manuscript.' };
    return { ok: true, question: s };
  }

  // The API only knows user/assistant turns of plain text. Never trust the
  // caller's shape: coerce roles, keep the last few turns, cap each one.
  function sanitizeHistory(list) {
    return (Array.isArray(list) ? list : []).slice(-12).map(function (m) {
      return {
        role: m && m.role === 'assistant' ? 'assistant' : 'user',
        content: String((m && m.content) || '').slice(0, 4000) || '(empty)',
      };
    });
  }

  /* ---------------- the request the proxy (or BYOK browser) sends ---------------- */

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function humanDate(now) {
    var d = new Date(now);
    return WEEKDAYS[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' +
      MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function systemPrompt(now) {
    return 'You are Sonar, a realtime web-search assistant. Today is ' +
      humanDate(now) + ' (UTC).\n' +
      'For anything that could have changed since your training — news, prices, ' +
      'scores, weather, releases, schedules, "latest" anything — use the ' +
      'web_search tool rather than answering from memory, and prefer fresh, ' +
      'primary sources. Cite a source for every fact you take from a page.\n' +
      'Answer tight and direct: lead with the answer, then the essentials. ' +
      'Plain text with occasional **bold**; short paragraphs or dash lists; no headings. ' +
      'If searches come back empty or contradictory, say so honestly instead of guessing.';
  }

  // Body for POST /v1/messages (streaming). The web_search tool is a SERVER
  // tool — Anthropic's infrastructure does the browsing, we never fetch
  // arbitrary URLs ourselves.
  function buildRequestBody(question, history, opts, now) {
    opts = opts || {};
    var messages = sanitizeHistory(history);
    messages.push({ role: 'user', content: String(question || '').slice(0, QUESTION_MAX) });
    return {
      model: String(opts.model || 'claude-opus-5'),
      max_tokens: Math.round(clamp(opts.maxTokens != null ? opts.maxTokens : 4096, 256, 8192)),
      system: systemPrompt(now),
      stream: true,
      tools: [{
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: Math.round(clamp(opts.maxSearches != null ? opts.maxSearches : 5, 1, 8)),
      }],
      messages: messages,
    };
  }

  /* ---------------- SSE parsing ---------------- */

  // Feed decoded text through; get back the unfinished carry plus every
  // complete `data: {...}` event. Pure: same (carry, text) in, same out.
  function sseParse(carry, text) {
    var buf = String(carry || '') + String(text || '');
    var events = [];
    var nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      var line = buf.slice(0, nl).replace(/\r$/, '').trim();
      buf = buf.slice(nl + 1);
      if (line.indexOf('data:') !== 0) continue; // event:/comment/keep-alive lines
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { events.push(JSON.parse(payload)); } catch (e) { /* split or junk line */ }
    }
    return { carry: buf, events: events };
  }

  /* ---------------- the stream reducer ----------------
   * Raw Anthropic stream events go in; Sonar's own events come out:
   *   {t:'thinking'}                       the model started reasoning
   *   {t:'searching'}                      a web search is being typed
   *   {t:'search', query}                  the search query, once complete
   *   {t:'found', count, top:[{url,title,domain}]}   results came back
   *   {t:'search_error', code}             the search itself failed
   *   {t:'text', text}                     a slice of the answer
   *   {t:'cite', n, url, title, domain}    a numbered source pin
   *   {t:'turn', stop}                     the message ended (end_turn / pause_turn / …)
   *   {t:'error', message}                 the stream reported an error
   * The reducer also keeps enough state to echo the assistant's content
   * blocks back verbatim, which is how a pause_turn gets resumed.
   */

  function initStream() {
    return {
      blocks: {},      // index -> block being assembled for this message
      order: [],       // block indexes in arrival order
      sources: [],     // numbered cited sources, kept across pause_turn resumes
      bySource: {},    // canonicalURL -> source entry
      answer: '',      // accumulated answer text
      stop: null,      // last stop_reason seen
      searches: 0,     // completed web searches
      thinkingSeen: false,
    };
  }

  function sourceFor(state, url, title) {
    var key = canonicalURL(url);
    var hit = state.bySource[key];
    if (hit) {
      if (!hit.title && title) hit.title = String(title).slice(0, 200);
      return hit;
    }
    var src = {
      n: state.sources.length + 1,
      url: String(url || ''),
      title: String(title || '').slice(0, 200),
      domain: domainOf(url),
    };
    state.sources.push(src);
    state.bySource[key] = src;
    return src;
  }

  function reduceEvent(state, evt) {
    var out = [];
    if (!evt || typeof evt !== 'object') return out;
    var block, delta;

    if (evt.type === 'message_start') {
      // A fresh message (first turn, or a pause_turn resume): new blocks,
      // but sources and answer text carry on.
      state.blocks = {};
      state.order = [];
      return out;
    }

    if (evt.type === 'content_block_start' && evt.content_block) {
      block = {};
      var raw = evt.content_block;
      for (var k in raw) if (Object.prototype.hasOwnProperty.call(raw, k)) block[k] = raw[k];
      if (block.type === 'text') { block.text = block.text || ''; block.citations = []; }
      if (block.type === 'thinking') block.thinking = block.thinking || '';
      if (block.type === 'server_tool_use') block.partialJSON = '';
      state.blocks[evt.index] = block;
      state.order.push(evt.index);

      if (block.type === 'thinking' && !state.thinkingSeen) {
        state.thinkingSeen = true;
        out.push({ t: 'thinking' });
      } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
        out.push({ t: 'searching' });
      } else if (block.type === 'web_search_tool_result') {
        // Server tool results arrive complete. Success content is a LIST of
        // results; an error is a single OBJECT — branch before indexing.
        var content = block.content;
        if (Array.isArray(content)) {
          state.searches += 1;
          var top = [];
          for (var i = 0; i < content.length && top.length < 3; i++) {
            var r = content[i] || {};
            if (r.url) top.push({ url: String(r.url), title: String(r.title || '').slice(0, 200), domain: domainOf(r.url) });
          }
          out.push({ t: 'found', count: content.length, top: top });
        } else {
          out.push({ t: 'search_error', code: String((content && content.error_code) || 'unavailable') });
        }
      }
      return out;
    }

    if (evt.type === 'content_block_delta' && evt.delta) {
      block = state.blocks[evt.index];
      if (!block) return out;
      delta = evt.delta;
      if (delta.type === 'text_delta' && block.type === 'text') {
        block.text += delta.text;
        state.answer += delta.text;
        out.push({ t: 'text', text: delta.text });
      } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
        block.thinking += delta.thinking || '';
      } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
        block.signature = delta.signature;
      } else if (delta.type === 'input_json_delta' && block.type === 'server_tool_use') {
        block.partialJSON += delta.partial_json || '';
      } else if (delta.type === 'citations_delta' && delta.citation) {
        var c = delta.citation;
        if (block.type === 'text') block.citations.push(c);
        if (c.url) {
          var src = sourceFor(state, c.url, c.title);
          out.push({ t: 'cite', n: src.n, url: src.url, title: src.title, domain: src.domain });
        }
      }
      return out;
    }

    if (evt.type === 'content_block_stop') {
      block = state.blocks[evt.index];
      if (block && block.type === 'server_tool_use') {
        try { block.input = JSON.parse(block.partialJSON || '{}'); } catch (e) { block.input = {}; }
        if (block.name === 'web_search') {
          out.push({ t: 'search', query: String((block.input && block.input.query) || '').slice(0, 300) });
        }
      }
      return out;
    }

    if (evt.type === 'message_delta' && evt.delta) {
      if (evt.delta.stop_reason) {
        state.stop = evt.delta.stop_reason;
        out.push({ t: 'turn', stop: state.stop });
      }
      return out;
    }

    if (evt.type === 'error') {
      out.push({ t: 'error', message: String((evt.error && evt.error.message) || 'stream error') });
      return out;
    }

    return out; // message_stop, ping, anything new — nothing to say
  }

  /* ---------------- echoing content back (pause_turn resume) ----------------
   * The server-side search loop caps at 10 iterations, then stops with
   * stop_reason "pause_turn". To resume, the SAME assistant content blocks are
   * sent back and the server picks up where it left off — no extra user turn.
   */
  function replayContent(state) {
    var content = [];
    for (var i = 0; i < state.order.length; i++) {
      var b = state.blocks[state.order[i]];
      if (!b) continue;
      if (b.type === 'text') {
        if (!b.text && !b.citations.length) continue; // empty text block is invalid to echo
        var t = { type: 'text', text: b.text };
        if (b.citations.length) t.citations = b.citations;
        content.push(t);
      } else if (b.type === 'thinking') {
        if (b.signature) content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
      } else if (b.type === 'redacted_thinking') {
        content.push({ type: 'redacted_thinking', data: b.data });
      } else if (b.type === 'server_tool_use') {
        content.push({ type: 'server_tool_use', id: b.id, name: b.name, input: b.input || {} });
      } else if (b.type === 'web_search_tool_result') {
        content.push({ type: 'web_search_tool_result', tool_use_id: b.tool_use_id, content: b.content });
      }
    }
    return content;
  }

  /* ---------------- rendering the answer ----------------
   * The UI keeps the streamed answer as segments: {text:'…'} slices in
   * arrival order with {cite:n} pins between them. Render = escape FIRST,
   * then decorate — the output contains only markup this engine created.
   */

  var CITE_MARK = '\u0001';

  function renderAnswerHTML(segments) {
    var parts = [];
    var cites = [];
    for (var i = 0; i < (segments || []).length; i++) {
      var seg = segments[i] || {};
      if (typeof seg.cite === 'number') {
        cites.push(seg.cite);
        parts.push(CITE_MARK + (cites.length - 1) + CITE_MARK);
      } else {
        parts.push(String(seg.text || '').replace(/\u0001/g, ''));
      }
    }
    var s = escapeHTML(parts.join(''));
    // mini-markdown: **bold** and `code`, nothing fancier.
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // paragraphs on blank lines, line breaks inside them
    s = '<p>' + s.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    // the source pins, escaped-safe because n is a number we assigned
    s = s.replace(/\u0001(\d+)\u0001/g, function (_, idx) {
      var n = cites[Number(idx)];
      return '<sup><button class="cite" type="button" data-action="jump-source" data-n="' + n + '">' + n + '</button></sup>';
    });
    return s;
  }

  /* ---------------- offline demo mode ----------------
   * No server, no key, no network — the prototype still answers, but it says
   * exactly what it is: a canned simulation, not the live web.
   */
  function offlineAnswer(question, now) {
    var q = String(question || '').trim() || 'that';
    var angles = [
      'the live sources disagree on the details, so a real run would open the top results and compare them',
      'a real run would search a couple of phrasings and lean on the freshest primary source',
      'this is the kind of question where yesterday’s answer is already stale, so live search matters',
    ];
    var angle = angles[hashStr('sonar-offline:' + q) % angles.length];
    return {
      simulated: true,
      answer: '**Offline demo mode** — no server and no API key, so nothing was actually searched.\n\n' +
        'Live, Sonar would ping the web for “' + q.slice(0, 120) + '” right now — ' + angle +
        ' — then stream back a short answer with a numbered source pinned to every fact.\n\n' +
        'Start the proxy (`npm run sonar`) or add your own API key in Settings to go live.',
      sources: [{
        n: 1,
        url: 'https://example.com/simulated',
        title: 'Simulated result (offline demo)',
        domain: 'example.com',
        simulated: true,
      }],
      ts: now,
    };
  }

  /* ---------------- small talk for the UI ---------------- */

  var SUGGESTIONS = [
    'What happened in the news today?',
    'What’s the weather in London right now?',
    'Who won the last Premier League match?',
    'What’s the latest Node.js LTS version?',
    'Any big tech releases this week?',
    'What time is sunset in Tokyo today?',
    'What’s trending on the web right now?',
    'Latest score in the Ashes?',
    'What movies are out in cinemas this weekend?',
    'Is there a train strike on today in the UK?',
    'What’s the GBP to USD rate right now?',
    'Any breaking science news today?',
  ];

  // Four fresh chips a day, rotating deterministically with the date.
  function dailySuggestions(now) {
    var iso = new Date(now).toISOString().slice(0, 10);
    var start = hashStr('sonar-day:' + iso) % SUGGESTIONS.length;
    var picks = [];
    for (var i = 0; i < 4; i++) picks.push(SUGGESTIONS[(start + i * 3) % SUGGESTIONS.length]);
    return picks;
  }

  function timeAgo(ts, now) {
    var d = Math.max(0, now - ts);
    if (d < MINUTE) return 'just now';
    if (d < HOUR) return Math.floor(d / MINUTE) + 'm ago';
    if (d < DAY) return Math.floor(d / HOUR) + 'h ago';
    return Math.floor(d / DAY) + 'd ago';
  }

  /* ---------------- exports ---------------- */

  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    QUESTION_MAX: QUESTION_MAX,
    hashStr: hashStr, rand01: rand01, clamp: clamp,
    escapeHTML: escapeHTML, domainOf: domainOf, canonicalURL: canonicalURL,
    validateQuestion: validateQuestion, sanitizeHistory: sanitizeHistory,
    humanDate: humanDate, systemPrompt: systemPrompt, buildRequestBody: buildRequestBody,
    sseParse: sseParse,
    initStream: initStream, reduceEvent: reduceEvent, replayContent: replayContent,
    renderAnswerHTML: renderAnswerHTML,
    offlineAnswer: offlineAnswer,
    SUGGESTIONS: SUGGESTIONS, dailySuggestions: dailySuggestions,
    timeAgo: timeAgo,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.SonarEngine = E;
})(typeof self !== 'undefined' ? self : this);
