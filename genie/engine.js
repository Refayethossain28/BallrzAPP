/* Genie — the agent that does what you tell it: the pure engine.
 * =====================================================================
 * Genie is a personal, always-on AI agent. It lives on your own machine
 * (or a server), takes instructions from a phone-friendly console, and
 * carries them out with the full Claude Code tool set through the Claude
 * Agent SDK — shell, files, web, subagents. It remembers things, keeps
 * standing orders on a cron-grade clock, and asks before it does anything
 * you told it to ask about.
 *
 * Every RULE of the app lives here and nothing else does: what counts as a
 * slash command, how "every weekday at 08:30" becomes a firing time, which
 * shell commands are destructive enough to wait for a tap, how a trust
 * level plus an "always allow" rule turns into allow/ask/deny, how the raw
 * Agent SDK message stream folds into Genie's own small event language,
 * what the memory file looks like, what the system prompt says, and how
 * the offline rehearsal is scripted. The server (server.mjs) owns disk,
 * network, clocks and randomness; the console (index.html) owns the DOM;
 * both call in here. The unit test (scripts/test-genie-logic.mjs) loads
 * this file in a vm sandbox with a fixed clock.
 *
 * Pure and deterministic on purpose: every time-dependent function takes
 * `now` (ms epoch) as an argument, ids come from FNV-1a hashing rather than
 * Math.random(), and there is no DOM, no fetch, no storage, no Date.now()
 * anywhere in this file. Rendering is escape-first, decorate-after: the
 * HTML this engine emits contains only markup it created itself.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 * ES2018-compatible: var, function declarations, no optional chaining,
 * no modules.
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  /* ====================================================================
   * 1. Constants — models, modes, limits, the tool roster
   * ==================================================================== */

  // Prices are USD per million tokens. The cost meter multiplies these by
  // the usage the SDK reports; unknown model ids fall back to the default.
  var MODELS = [
    { id: 'claude-opus-5',     label: 'Opus 5',     inPerMTok: 5,  outPerMTok: 25, cacheReadPerMTok: 0.5,  cacheWritePerMTok: 6.25, note: 'the default — best all-rounder' },
    { id: 'claude-fable-5-1',  label: 'Fable 5.1',  inPerMTok: 10, outPerMTok: 50, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.5, note: 'most capable' },
    { id: 'claude-sonnet-5',   label: 'Sonnet 5',   inPerMTok: 2,  outPerMTok: 10, cacheReadPerMTok: 0.2,  cacheWritePerMTok: 2.5,  note: 'fast' },
    { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  inPerMTok: 1,  outPerMTok: 5,  cacheReadPerMTok: 0.1,  cacheWritePerMTok: 1.25, note: 'cheapest' }
  ];
  var DEFAULT_MODEL = 'claude-opus-5';

  // The three trust levels. Ask is the seatbelt, Trust is the daily driver,
  // Auto is "do whatever I tell it" — the console makes you confirm that one.
  var MODES = ['ask', 'trust', 'auto'];
  var DEFAULT_MODE = 'trust';
  var MODE_INFO = {
    ask:   { label: 'Ask',   blurb: 'reads freely; every write, command and web call waits for your tap' },
    trust: { label: 'Trust', blurb: 'acts freely; only destructive commands wait for your tap' },
    auto:  { label: 'Auto',  blurb: 'never asks — do whatever I tell it' }
  };

  var EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  var DEFAULT_EFFORT = 'high';
  var DEFAULT_LIMITS = { maxTurns: 200, maxUsd: 20 };

  // How risky a tool call is, least to most. `danger` is exec plus a
  // destructive command — the one level even Trust mode stops for.
  // `question` is not a risk at all: the agent wants an answer from the
  // owner (AskUserQuestion), so it waits for a tap in every mode, Auto too.
  var RISK_LEVELS = ['read', 'write', 'exec', 'network', 'danger', 'question'];

  var MEMORY_MAX = 200;     // memory entries
  var PROMPT_MAX = 20000;   // chars in one prompt
  var OUTPUT_MAX = 4000;    // chars kept per tool result event

  // The in-process MCP tools the server hands the agent. They are Genie's
  // own hands (memory, standing orders, notifications), so the policy never
  // makes the owner approve them.
  var GENIE_TOOLS = [
    'mcp__genie__remember', 'mcp__genie__forget',
    'mcp__genie__schedule', 'mcp__genie__unschedule', 'mcp__genie__list_schedules',
    'mcp__genie__notify'
  ];

  // Built-in slash commands, in the order the console's autocomplete shows them.
  var COMMANDS = [
    { name: 'help',       args: '',                   blurb: 'what Genie can do and how to talk to it' },
    { name: 'new',        args: '',                   blurb: 'start a fresh conversation' },
    { name: 'stop',       args: '',                   blurb: 'stop the run in this conversation' },
    { name: 'status',     args: '',                   blurb: 'driver, model, mode, cwd, cost so far' },
    { name: 'mode',       args: '<ask|trust|auto>',   blurb: 'how much Genie asks before acting' },
    { name: 'model',      args: '<id>',               blurb: 'switch the model' },
    { name: 'effort',     args: '<level>',            blurb: 'low · medium · high · xhigh · max' },
    { name: 'cwd',        args: '<path>',             blurb: 'change the working directory' },
    { name: 'remember',   args: '<fact>',             blurb: 'add a durable fact to memory' },
    { name: 'forget',     args: '<n|all>',            blurb: 'remove memory entry n (or all)' },
    { name: 'memory',     args: '',                   blurb: 'show what Genie remembers' },
    { name: 'schedule',   args: '<when> <task>',      blurb: 'add a standing order (every 30m · daily at 09:00 · cron …)' },
    { name: 'schedules',  args: '',                   blurb: 'list standing orders' },
    { name: 'unschedule', args: '<id>',               blurb: 'remove a standing order' },
    { name: 'commands',   args: '',                   blurb: 'list custom commands' },
    { name: 'run',        args: '<id>',               blurb: 'run a standing order now' }
  ];
  var BUILTIN_NAMES = {};
  for (var ci = 0; ci < COMMANDS.length; ci++) BUILTIN_NAMES[COMMANDS[ci].name] = true;

  /* ====================================================================
   * 2. Deterministic hashing / seeded randomness
   * ==================================================================== */

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

  // Eight base36 chars from two hashes of the seed. Real ids are minted by
  // the server with crypto; these exist so the rehearsal is reproducible.
  function shortId(seed) {
    var a = hashStr(seed).toString(36);
    var b = hashStr('genie:' + seed).toString(36);
    return (a + b + '00000000').slice(0, 8);
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  /* ====================================================================
   * 3. Text safety & rendering
   * ==================================================================== */

  // Terminal escape sequences (CSI, OSC, two-byte ESC forms, 8-bit CSI)
  // and every control character except newline and tab. Tool output is
  // full of the former; the latter are how injected text hides.
  var ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x9b[0-9;?]*[ -\/]*[@-~]/g;
  var CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

  function sanitize(s) {
    s = String(s == null ? '' : s);
    return s.replace(/\r\n/g, '\n').replace(ANSI_RE, '').replace(CTRL_RE, '');
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    n = Math.max(1, Number(n) || 0);
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }

  // Bare URLs are matched on ALREADY-ESCAPED text, so they must stop at the
  // entities that escaping produced as well as at raw delimiters.
  var MD_URL_RE = /\bhttps?:\/\/(?:(?!&quot;|&lt;|&gt;|&#39;)[^\s<>"'`)\]])+/g;
  var MD_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  var MARK = '\u0001'; // stash marker — sanitize() strips \x01 from input, so it can't be forged

  // Inline decoration of one escaped line: code → links → bold → italic.
  // Code and links are stashed first so nothing decorates their insides.
  function inlineMD(s) {
    var stash = [];
    function keep(html) { stash.push(html); return MARK + (stash.length - 1) + MARK; }
    s = s.replace(/`([^`\n]+)`/g, function (_, code) { return keep('<code>' + code + '</code>'); });
    s = s.replace(MD_LINK_RE, function (_, label, href) {
      return keep('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
    });
    s = s.replace(MD_URL_RE, function (u) {
      var clean = u.replace(/[.,;:!?]+$/, '');
      var trail = u.slice(clean.length);
      return keep('<a href="' + clean + '" target="_blank" rel="noopener noreferrer">' + clean + '</a>') + trail;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    // Restore stashed pieces; a link label may itself hold stashed code, so loop.
    for (var pass = 0; pass < 4 && s.indexOf(MARK) >= 0; pass++) {
      s = s.replace(/\u0001(\d+)\u0001/g, function (_, i) { return stash[Number(i)] || ''; });
    }
    return s.replace(/\u0001/g, '');
  }

  // Markdown → HTML. Escape FIRST (the whole text), then recognise blocks
  // line by line on the escaped text, then decorate inline. Output never
  // contains unescaped input, and only http(s) ever becomes an href.
  function renderMarkdown(text) {
    var lines = escapeHTML(sanitize(text)).split('\n');
    var out = [], para = [], quote = [];
    function flushPara() { if (para.length) { out.push('<p>' + para.map(inlineMD).join('<br>') + '</p>'); para = []; } }
    function flushQuote() { if (quote.length) { out.push('<blockquote>' + quote.map(inlineMD).join('<br>') + '</blockquote>'); quote = []; } }

    // Lists nest by indentation: a deeper item opens a child list INSIDE the
    // open <li>, a shallower one closes back out, so "1. step / - detail /
    // 2. step" keeps its numbering. An ordered list that starts at N ≠ 1
    // carries start="N" so a list split by a paragraph or a code block reads on.
    var lists = [], listHtml = '';
    function openList(tag, indent, start) {
      lists.push({ tag: tag, indent: indent });
      listHtml += '<' + tag + (tag === 'ol' && start !== 1 ? ' start="' + start + '"' : '') + '>';
    }
    function closeList() { listHtml += '</li></' + lists.pop().tag + '>'; }
    function listItem(tag, indent, start, item) {
      var top = lists.length ? lists[lists.length - 1] : null;
      // Dedent: close inner lists until the item fits. An item that is still
      // deeper than the enclosing item stays a sibling in the list it lands in,
      // and a list that began indented is not closed by dedenting past it.
      while (top && indent < top.indent) {
        var parent = lists.length > 1 ? lists[lists.length - 2] : null;
        if (!parent || indent >= parent.indent + 2) break;
        closeList(); top = lists.length ? lists[lists.length - 1] : null;
      }
      if (top && indent >= top.indent + 2) openList(tag, indent, start);          // deeper: nest inside the open item
      else if (top && top.tag === tag) listHtml += '</li>';                       // a sibling
      else { if (top) closeList(); openList(tag, indent, start); }                // a different kind of list here
      listHtml += '<li>' + inlineMD(item);
    }
    function flushList() {
      while (lists.length) closeList();
      if (listHtml) { out.push(listHtml); listHtml = ''; }
    }
    function indentOf(ws) { return ws.replace(/\t/g, '    ').length; }
    function flushAll() { flushPara(); flushQuote(); flushList(); }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], m;
      // A fence is three or more backticks plus an info string (language,
      // then anything: a title, a filename, attributes). It closes only on a
      // line of at least as many backticks, so a ```` fence can show ``` inside.
      if ((m = /^\s*(`{3,})([^`]*)$/.exec(line))) {
        flushAll();
        var ticks = m[1].length;
        var lang = (/^[\w+#.-]*/.exec(m[2].trim()) || [''])[0].toLowerCase().replace(/[^\w-]/g, '');
        var closer = new RegExp('^\\s*`{' + ticks + ',}\\s*$');
        var code = [];
        i++;
        while (i < lines.length && !closer.test(lines[i])) { code.push(lines[i]); i++; }
        out.push('<pre><code' + (lang ? ' class="lang-' + lang + '"' : '') + '>' + code.join('\n') + '</code></pre>');
        continue;
      }
      if (!line.trim()) { flushAll(); continue; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
      if ((m = /^(#{1,3})\s+(.+)$/.exec(line))) {
        flushAll();
        out.push('<h' + m[1].length + '>' + inlineMD(m[2].trim()) + '</h' + m[1].length + '>');
        continue;
      }
      if ((m = /^&gt;\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); continue; }
      if ((m = /^(\s*)[-*]\s+(.+)$/.exec(line))) {
        flushPara(); flushQuote();
        listItem('ul', indentOf(m[1]), 1, m[2]);
        continue;
      }
      if ((m = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line))) {
        flushPara(); flushQuote();
        listItem('ol', indentOf(m[1]), Number(m[2]), m[3]);
        continue;
      }
      flushQuote(); flushList();
      para.push(line);
    }
    flushAll();
    return out.join('\n');
  }

  function oneLine(s, n) {
    return truncate(sanitize(s).replace(/\s+/g, ' ').trim(), n || 160);
  }

  function isGenieTool(name) {
    return /^mcp__genie__/.test(String(name || ''));
  }

  function firstStringArg(input) {
    for (var k in input) {
      if (Object.prototype.hasOwnProperty.call(input, k) && typeof input[k] === 'string' && input[k].trim()) return input[k];
    }
    return '';
  }

  function compactJSON(input) {
    try { return JSON.stringify(input); } catch (e) { return String(input); }
  }

  // AskUserQuestion input is { questions: [{ question, header, options, multiSelect }] };
  // the first question's text is what a card or a title shows.
  function firstQuestion(input) {
    var qs = input && Array.isArray(input.questions) ? input.questions : [];
    var q = qs.length ? qs[0] : null;
    return q ? String((q && typeof q === 'object' ? q.question : q) || '') : '';
  }

  // The one line a tool card shows under the tool name.
  function summarizeInput(toolName, input) {
    input = (input && typeof input === 'object') ? input : {};
    var name = String(toolName || '');
    var s = '';
    switch (name) {
      case 'Bash': s = input.command; break;
      case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': case 'NotebookRead':
        s = input.file_path || input.notebook_path; break;
      case 'Glob': case 'Grep':
        s = input.pattern ? String(input.pattern) + (input.path ? ' in ' + input.path : '') : (input.path || ''); break;
      case 'LS': s = input.path; break;
      case 'WebSearch': s = input.query; break;
      case 'WebFetch': s = input.url; break;
      case 'Task': case 'Agent': s = input.description || String(input.prompt || '').slice(0, 200); break;
      case 'TodoWrite': s = (Array.isArray(input.todos) ? input.todos.length : 0) + ' todos'; break;
      case 'Skill': s = input.skill || input.command || input.name; break;
      case 'AskUserQuestion': s = firstQuestion(input); break;
      default:
        // Genie's own tools read best by their first string argument; anything
        // else (an MCP tool we do not know) shows its compact JSON input.
        s = isGenieTool(name) ? firstStringArg(input) : '';
        if (!s) s = compactJSON(input);
    }
    if (s == null || s === '') s = compactJSON(input);
    if (s === '{}') s = '';
    return oneLine(s, 160);
  }

  function toolIcon(toolName) {
    var name = String(toolName || '');
    if (isGenieTool(name)) return '🪔';
    switch (name) {
      case 'Bash': return '💻';
      case 'Read': case 'NotebookRead': return '📖';
      case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return '✍️';
      case 'Glob': case 'Grep': case 'LS': return '🔍';
      case 'WebSearch': case 'WebFetch': return '🌐';
      case 'Task': case 'Agent': return '🧞';
      case 'TodoWrite': case 'TodoRead': return '✅';
      case 'AskUserQuestion': return '❓';
      default: return '🔧';
    }
  }

  function formatUsd(n) {
    n = Number(n) || 0;
    if (n === 0) return '$0.00'; // a free run reads as free, not as four zeros
    return '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2));
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatDuration(ms) {
    var s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return m + 'm ' + pad2(s) + 's';
    var h = Math.floor(m / 60); m = m % 60;
    return h + 'h ' + pad2(m) + 'm';
  }

  // "5 min ago" for the past, "in 5 min" for the future (next run of a schedule).
  function relTime(now, then) {
    var d = Number(now) - Number(then);
    if (!isFinite(d)) return '';
    var future = d < 0;
    d = Math.abs(d);
    var s;
    if (d < MINUTE) return future ? 'any moment' : 'just now';
    if (d < HOUR) s = Math.floor(d / MINUTE) + ' min';
    else if (d < DAY) s = Math.floor(d / HOUR) + ' h';
    else if (d < 2 * DAY) return future ? 'tomorrow' : 'yesterday';
    else s = Math.floor(d / DAY) + ' d';
    return future ? 'in ' + s : s + ' ago';
  }

  /* ====================================================================
   * 4. Slash commands
   * ==================================================================== */

  var COMMAND_RE = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/;

  function parseCommand(text) {
    var s = String(text == null ? '' : text).trim();
    var m = COMMAND_RE.exec(s);
    if (!m) return { kind: 'prompt', text: s };
    var name = m[1].toLowerCase();
    var cmd = { kind: 'command', name: name, args: (m[2] || '').trim(), raw: s };
    if (!BUILTIN_NAMES[name]) cmd.builtin = false; // the server tries custom commands, then "unknown command"
    return cmd;
  }

  function helpText() {
    var lines = ['**Genie** — the agent that does what you tell it. Type anything and it acts. Commands:', ''];
    for (var i = 0; i < COMMANDS.length; i++) {
      var c = COMMANDS[i];
      lines.push('- `/' + c.name + (c.args ? ' ' + c.args : '') + '` — ' + c.blurb);
    }
    lines.push('');
    lines.push('Schedules: `every 30m` · `every 2h` · `daily at 09:00` · `weekdays at 08:30` · `every mon,wed,fri at 7am` · `cron 0 9 * * 1-5`.');
    lines.push('Modes: **Ask** taps for every write/command/web call · **Trust** taps only for destructive commands · **Auto** never asks.');
    return lines.join('\n');
  }

  /* ====================================================================
   * 5. Schedules — "every weekday at 08:30", cron-grade, clock-injected
   * ==================================================================== */

  var UNIT_MS = {
    s: SECOND, sec: SECOND, secs: SECOND, second: SECOND, seconds: SECOND,
    m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
    h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
    d: DAY, day: DAY, days: DAY,
    w: 7 * DAY, wk: 7 * DAY, wks: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY
  };
  var UNIT_SRC = '(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)';
  var DAY_NAMES = {
    sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, wed: 3,
    thursday: 4, thurs: 4, thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6
  };
  var DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // A day name is a whole word: "mon" is Monday, "monthly" and "monitor" are not.
  // A list is names joined by , / & and; an item may be a range: "mon-fri", "fri to sun".
  var DAY_SRC = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)';
  var DAY_RANGE_SEP = '\\s*(?:-|–|\\bto\\b|\\bthrough\\b)\\s*';
  var DAYITEM_SRC = DAY_SRC + 's?\\b(?:' + DAY_RANGE_SEP + DAY_SRC + 's?\\b)?';
  var DAYLIST_SRC = '(' + DAYITEM_SRC + '(?:\\s*(?:,|/|&|\\band\\b)\\s*' + DAYITEM_SRC + ')*)';
  var MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  // "at 9", "at 09:30", "at 7pm", "at 7:15 a.m.", "at 9p.m.", "at noon", "at midnight".
  // The time ends where a word does not follow — a lookahead rather than \b,
  // because \b never holds after the dot of "p.m.".
  var TIME_SRC = '(?:(noon|midnight)|(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?)(?!\\w)';
  var AT_SRC = '(?:\\s+at\\s+' + TIME_SRC + ')';
  var SCHEDULE_HINT = 'every 30m · every 2h · daily at 09:00 · weekdays at 08:30 · every mon,wed,fri at 7am · cron 0 9 * * 1-5';

  function rx(src) { return new RegExp(src, 'i'); }

  var SCHED_EVERY_N   = rx('^\\s*every\\s+(\\d+(?:\\.\\d+)?)\\s*' + UNIT_SRC + '\\b');
  var SCHED_EVERY_1   = rx('^\\s*every\\s+' + UNIT_SRC + '\\b');
  var SCHED_HOURLY    = rx('^\\s*hourly\\b');
  var SCHED_DAILY     = rx('^\\s*(every\\s+day|each\\s+day|daily)' + AT_SRC + '?');
  var SCHED_PARTOFDAY = rx('^\\s*every\\s+(morning|afternoon|evening|night)' + AT_SRC + '?');
  var SCHED_WEEKPART  = rx('^\\s*(?:every\\s+|on\\s+)?(weekdays?|workdays?|weekends?)' + AT_SRC + '?');
  var SCHED_DAYS      = rx('^\\s*(?:every\\s+|on\\s+)?' + DAYLIST_SRC + AT_SRC + '?');
  var SCHED_AT        = rx('^\\s*at\\s+' + TIME_SRC);
  var SCHED_CRON      = rx('^\\s*cron\\s+(\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+)(?=\\s|$)');
  var SCHED_SEP       = /^\s*[:,\-–—]?\s*/;
  // Calendar periods the grammar does not speak: point at cron instead of guessing.
  var SCHED_PERIOD    = rx('^\\s*(?:every\\s+|each\\s+)?(month(?:ly)?|year(?:ly)?|annually|quarter(?:ly)?)\\b');

  // Groups from TIME_SRC (offset `o` = index of the first group) → {hour, minute} | {error}
  function clockFrom(m, o, fallback) {
    if (!m[o] && !m[o + 1]) return fallback ? { hour: fallback.hour, minute: fallback.minute } : null;
    if (m[o]) return m[o].toLowerCase() === 'noon' ? { hour: 12, minute: 0 } : { hour: 0, minute: 0 };
    var hour = Number(m[o + 1]), minute = m[o + 2] ? Number(m[o + 2]) : 0;
    var ap = (m[o + 3] || '').toLowerCase().replace(/\./g, '');
    if (ap) {
      if (hour < 1 || hour > 12) return { error: 'hour must be 1–12 with am/pm' };
      if (ap === 'am' && hour === 12) hour = 0;
      else if (ap === 'pm' && hour !== 12) hour += 12;
    } else if (hour > 23) return { error: 'hour must be 0–23' };
    if (minute > 59) return { error: 'minute must be 0–59' };
    return { hour: hour, minute: minute };
  }

  var NINE = { hour: 9, minute: 0 };

  function dayNumber(word) {
    var w = String(word).trim();
    var d = DAY_NAMES[w];
    if (d == null) d = DAY_NAMES[w.replace(/s$/, '')];
    return d == null ? null : d;
  }

  var DAY_RANGE_RE = new RegExp('^(\\S+?)' + DAY_RANGE_SEP + '(\\S+)$', 'i');

  function daysFrom(listText) {
    var out = [], seen = {};
    var parts = String(listText).toLowerCase().split(/\s*(?:,|\/|&|\band\b)\s*/);
    function add(d) { if (!seen[d]) { seen[d] = 1; out.push(d); } }
    for (var i = 0; i < parts.length; i++) {
      var r = DAY_RANGE_RE.exec(parts[i].trim());
      var from = dayNumber(r ? r[1] : parts[i]), to = r ? dayNumber(r[2]) : from;
      if (from == null || to == null) continue;
      for (var d = from; ; d = (d + 1) % 7) { add(d); if (d === to) break; } // a range wraps: "fri-mon" is Fri, Sat, Sun, Mon
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function normDays(days) {
    var out = [], seen = {};
    (Array.isArray(days) ? days : []).forEach(function (d) {
      d = Number(d);
      if (d >= 0 && d <= 6 && !seen[d]) { seen[d] = 1; out.push(d); }
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function fail(error) { return { ok: false, error: error }; }

  function finishSchedule(schedule, consumed, text, tz) {
    schedule.label = describeSchedule(schedule);
    schedule.tzOffsetMin = tz;
    var rest = text.slice(consumed);
    var sep = SCHED_SEP.exec(rest);
    if (sep) consumed += sep[0].length;
    return { ok: true, schedule: schedule, consumed: consumed };
  }

  function everySchedule(n, unit, consumed, text, tz) {
    var ms = Math.round(n * (UNIT_MS[String(unit).toLowerCase()] || 0));
    if (!(ms > 0)) return fail('that interval makes no sense');
    if (ms < MINUTE) return fail('minimum interval is 60 s (try "every 1m")');
    return finishSchedule({ kind: 'every', everyMs: ms }, consumed, text, tz);
  }

  function dailySchedule(clock, days, consumed, text, tz) {
    if (!clock) return fail('say when — e.g. "at 09:00"');
    if (clock.error) return fail(clock.error);
    return finishSchedule({ kind: 'daily', hour: clock.hour, minute: clock.minute, days: days }, consumed, text, tz);
  }

  // Human schedule text → schedule object + how many chars it used up.
  function parseSchedule(text, opts) {
    text = String(text == null ? '' : text);
    var tz = (opts && isFinite(Number(opts.tzOffsetMin))) ? Number(opts.tzOffsetMin) : 0;
    var all = [0, 1, 2, 3, 4, 5, 6];
    var m;

    if ((m = SCHED_CRON.exec(text))) {
      var parsed = parseCron(m[1]);
      if (!parsed.ok) return fail(parsed.error);
      return finishSchedule({ kind: 'cron', expr: parsed.expr }, m[0].length, text, tz);
    }
    if ((m = SCHED_PERIOD.exec(text))) return fail('"' + m[1].toLowerCase() + '" needs cron — e.g. "cron 0 9 1 * *" for the 1st of every month at 09:00');
    if ((m = SCHED_HOURLY.exec(text))) return everySchedule(1, 'h', m[0].length, text, tz);
    if ((m = SCHED_PARTOFDAY.exec(text))) {
      var part = m[1].toLowerCase();
      var dflt = part === 'morning' ? NINE : part === 'afternoon' ? { hour: 14, minute: 0 } : part === 'evening' ? { hour: 18, minute: 0 } : { hour: 22, minute: 0 };
      return dailySchedule(clockFrom(m, 2, dflt), all, m[0].length, text, tz);
    }
    if ((m = SCHED_DAILY.exec(text))) {
      var clock = clockFrom(m, 2, null);
      if (!clock) {
        if (/^daily$/i.test(m[1])) clock = NINE;             // "daily" alone → 09:00
        else return everySchedule(1, 'day', m[0].length, text, tz); // "every day" alone → every 24 h
      }
      return dailySchedule(clock, all, m[0].length, text, tz);
    }
    if ((m = SCHED_WEEKPART.exec(text))) {
      var wp = m[1].toLowerCase();
      var days = /^weekend/.test(wp) ? [0, 6] : [1, 2, 3, 4, 5];
      return dailySchedule(clockFrom(m, 2, NINE), days, m[0].length, text, tz);
    }
    if ((m = SCHED_EVERY_N.exec(text))) return everySchedule(Number(m[1]), m[2], m[0].length, text, tz);
    if ((m = SCHED_EVERY_1.exec(text))) return everySchedule(1, m[1], m[0].length, text, tz);
    if ((m = SCHED_DAYS.exec(text))) {
      var list = daysFrom(m[1]);
      if (!list.length) return fail('which days? e.g. "every mon,wed,fri at 7am"');
      return dailySchedule(clockFrom(m, 2, NINE), list, m[0].length, text, tz);
    }
    if ((m = SCHED_AT.exec(text))) return dailySchedule(clockFrom(m, 1, null), all, m[0].length, text, tz);
    return fail('could not read a schedule from "' + oneLine(text, 40) + '" — try: ' + SCHEDULE_HINT);
  }

  function clockText(h, m) { return pad2(h) + ':' + pad2(m); }

  function describeSchedule(schedule) {
    if (!schedule) return '';
    if (schedule.kind === 'every') {
      var ms = Number(schedule.everyMs) || 0;
      if (ms >= DAY && ms % DAY === 0) return 'every ' + (ms / DAY) + ' d';
      if (ms >= HOUR && ms % HOUR === 0) return 'every ' + (ms / HOUR) + ' h';
      if (ms >= MINUTE && ms % MINUTE === 0) return 'every ' + (ms / MINUTE) + ' min';
      return 'every ' + Math.round(ms / SECOND) + ' s';
    }
    if (schedule.kind === 'daily') {
      var at = clockText(Number(schedule.hour) || 0, Number(schedule.minute) || 0);
      var days = normDays(schedule.days);
      var key = days.join(',');
      if (key === '0,1,2,3,4,5,6' || !days.length) return 'daily at ' + at;
      if (key === '1,2,3,4,5') return 'weekdays at ' + at;
      if (key === '0,6') return 'weekends at ' + at;
      return 'on ' + days.map(function (d) { return DAY_SHORT[d]; }).join(', ') + ' at ' + at;
    }
    if (schedule.kind === 'cron') return 'cron ' + String(schedule.expr || '');
    return '';
  }

  /* ---- cron: a real five-field parser ---- */

  var CRON_DEFS = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day of month', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
    { name: 'day of week', min: 0, max: 7, names: DAY_NAMES } // 7 folds to Sunday
  ];

  function cronAtom(tok, def) {
    if (/^\d+$/.test(tok)) return Number(tok);
    if (def.names) {
      var n = def.names[tok.toLowerCase().slice(0, 3)];
      if (n != null && tok.length <= 9 && def.names[tok.toLowerCase()] != null) return n;
      if (n != null && tok.length === 3) return n;
    }
    return NaN;
  }

  // One cron field → { star, set } where set[v] === true for every matching value.
  // `?` (the Quartz spelling of "any") is `*`. `star` follows Vixie cron: a
  // field that STARTS with `*` (so `*/2` too) counts as unrestricted when the
  // two day fields decide between AND and OR.
  function parseCronField(spec, def) {
    spec = String(spec == null ? '' : spec).trim();
    if (spec === '?') spec = '*';
    if (!spec) return { ok: false, error: def.name + ': empty field' };
    var size = def.name === 'day of week' ? 7 : def.max + 1;
    var set = [];
    for (var v = 0; v < size; v++) set[v] = false;
    var star = spec.charAt(0) === '*';
    var items = spec.split(',');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var m = /^([^/]+)(?:\/(\d+))?$/.exec(item);
      if (!m) return { ok: false, error: def.name + ': bad item "' + item + '"' };
      var lo, hi, step = m[2] != null ? Number(m[2]) : 1;
      if (m[2] != null && !(step >= 1)) return { ok: false, error: def.name + ': step must be ≥ 1' };
      var range = m[1];
      if (range === '*') { lo = def.min; hi = def.max; }
      else {
        var r = /^([^-]+)-([^-]+)$/.exec(range);
        if (r) { lo = cronAtom(r[1], def); hi = cronAtom(r[2], def); }
        else { lo = cronAtom(range, def); hi = m[2] != null ? def.max : lo; }
      }
      if (isNaN(lo) || isNaN(hi)) return { ok: false, error: def.name + ': cannot read "' + item + '"' };
      if (lo < def.min || hi > def.max) return { ok: false, error: def.name + ': "' + item + '" is outside ' + def.min + '–' + def.max };
      if (lo > hi) return { ok: false, error: def.name + ': range "' + item + '" runs backwards' };
      for (v = lo; v <= hi; v += step) set[v % size] = true;
    }
    return { ok: true, star: star, set: set };
  }

  function parseCron(expr) {
    var parts = String(expr == null ? '' : expr).trim().split(/\s+/);
    if (parts.length !== 5 || !parts[0]) return { ok: false, error: 'cron needs 5 fields: minute hour day-of-month month day-of-week' };
    var fields = {}, keys = ['minute', 'hour', 'dom', 'month', 'dow'];
    for (var i = 0; i < 5; i++) {
      var f = parseCronField(parts[i], CRON_DEFS[i]);
      if (!f.ok) return f;
      fields[keys[i]] = f;
    }
    return { ok: true, expr: parts.join(' '), fields: fields };
  }

  // Vixie semantics: when BOTH day fields are restricted, either may match;
  // when either is a star, both must.
  function cronDayMatches(f, d) {
    var domOk = f.dom.set[d.getUTCDate()] === true;
    var dowOk = f.dow.set[d.getUTCDay()] === true;
    if (f.dom.star || f.dow.star) return domOk && dowOk;
    return domOk || dowOk;
  }

  function cronFields(x) {
    if (!x) return null;
    if (typeof x === 'string') { var p = parseCron(x); return p.ok ? p.fields : null; }
    if (x.fields) return x.fields;
    if (x.kind === 'cron') return cronFields(x.expr);
    if (x.minute && x.hour) return x;
    return null;
  }

  // `localDate` is a Date whose UTC fields hold the schedule's LOCAL time
  // (i.e. new Date(utcMs + tzOffsetMin * MINUTE)), read with getUTC*.
  function cronMatches(fields, localDate) {
    var f = cronFields(fields);
    if (!f || !localDate) return false;
    var d = localDate instanceof Date ? localDate : new Date(Number(localDate));
    if (isNaN(d.getTime())) return false;
    return f.minute.set[d.getUTCMinutes()] === true &&
      f.hour.set[d.getUTCHours()] === true &&
      f.month.set[d.getUTCMonth() + 1] === true &&
      cronDayMatches(f, d);
  }

  // Next firing strictly after `now`, or null when nothing matches within a year.
  function nextRun(schedule, now) {
    if (!schedule) return null;
    now = Number(now);
    if (!isFinite(now)) return null;
    if (schedule.kind === 'every') return now + Math.max(MINUTE, Number(schedule.everyMs) || 0);

    var tz = (Number(schedule.tzOffsetMin) || 0) * MINUTE;
    var local = now + tz;
    var t = Math.floor(local / MINUTE) * MINUTE + MINUTE; // first whole minute after now
    var limit = t + 366 * DAY;

    if (schedule.kind === 'daily') {
      var days = normDays(schedule.days);
      if (!days.length) days = [0, 1, 2, 3, 4, 5, 6];
      var hour = clamp(schedule.hour, 0, 23), minute = clamp(schedule.minute, 0, 59);
      var dayStart = Math.floor(t / DAY) * DAY;
      for (var i = 0; i <= 367; i++) {
        var cand = dayStart + i * DAY + hour * HOUR + minute * MINUTE;
        if (cand < t) continue;
        if (days.indexOf(new Date(cand).getUTCDay()) >= 0) return cand - tz;
      }
      return null;
    }

    if (schedule.kind === 'cron') {
      var f = cronFields(schedule.expr);
      if (!f) return null;
      while (t < limit) {
        var d = new Date(t);
        var y = d.getUTCFullYear(), mo = d.getUTCMonth(), dd = d.getUTCDate(), h = d.getUTCHours();
        if (!f.month.set[mo + 1]) { t = Date.UTC(y, mo + 1, 1); continue; }
        if (!cronDayMatches(f, d)) { t = Date.UTC(y, mo, dd + 1); continue; }
        if (!f.hour.set[h]) { t = Date.UTC(y, mo, dd, h + 1); continue; }
        if (!f.minute.set[d.getUTCMinutes()]) { t += MINUTE; continue; }
        return t - tz;
      }
      return null;
    }
    return null;
  }

  // The server calls this with lastRunAt so an `every` cadence stays anchored
  // to the last firing rather than to "whenever the scheduler noticed".
  function nextFrom(schedule, fromMs) {
    return nextRun(schedule, fromMs);
  }

  function validateTask(task) {
    var s = sanitize(task).trim();
    if (!s) return fail('the task is empty — what should Genie do?');
    if (s.length > 2000) return fail('keep the task under 2000 characters');
    return { ok: true, task: s };
  }

  function newSchedule(o) {
    o = o || {};
    return {
      id: String(o.id || ''),
      task: String(o.task || ''),
      schedule: o.schedule,
      createdAt: Number(o.now) || 0,
      lastRunAt: null,
      nextRunAt: nextRun(o.schedule, o.now),
      enabled: true,
      runs: 0,
      conversationId: o.conversationId || null
    };
  }

  function afterRun(record, now) {
    var copy = {};
    for (var k in record) if (Object.prototype.hasOwnProperty.call(record, k)) copy[k] = record[k];
    copy.lastRunAt = Number(now);
    copy.runs = (Number(record.runs) || 0) + 1;
    copy.nextRunAt = nextRun(record.schedule, now);
    return copy;
  }

  function dueSchedules(list, now) {
    now = Number(now);
    return (Array.isArray(list) ? list : []).filter(function (s) {
      return s && s.enabled !== false && s.nextRunAt != null && Number(s.nextRunAt) <= now;
    });
  }

  /* ====================================================================
   * 6. Permission policy — what waits for a tap
   * ==================================================================== */

  var READ_TOOLS = {
    Read: 1, Glob: 1, Grep: 1, LS: 1, NotebookRead: 1, TodoWrite: 1, TodoRead: 1, Task: 1, Agent: 1,
    Skill: 1, ListMcpResourcesTool: 1, ReadMcpResourceTool: 1,
    mcp__genie__list_schedules: 1, mcp__genie__notify: 1
  };
  var WRITE_TOOLS = {
    Write: 1, Edit: 1, MultiEdit: 1, NotebookEdit: 1,
    mcp__genie__remember: 1, mcp__genie__forget: 1, mcp__genie__schedule: 1, mcp__genie__unschedule: 1
  };
  var NETWORK_TOOLS = { WebSearch: 1, WebFetch: 1 };

  /* ---- the destructive-command table ----
   * Each rule is { re, reason }. dangerousCommand() normalises whitespace
   * (a newline stays a newline — its own separator, so a heredoc's SQL can
   * put WHERE on the next line), blanks the quoted text that is data rather
   * than command (commit messages, search patterns), and tries the rules in
   * order — so the table IS the policy, and can be audited line by line.
   * Fragments used more than once are spelled out here so the rules stay
   * readable:
   *   SEG   — "stay inside this shell segment" (never cross ; & | or a newline)
   *   CMD   — "in command position": start of line/segment, after sudo/exec…,
   *           the string handed to `sh -c`, or anything `ssh host …` runs.
   *           A quote on its own is NOT command position: `grep "halt" src/`
   *           searches for a word, it does not halt anything.
   *   HOME  — the owner's home in any spelling (~, $HOME, /home/x, /Users/x, /root)
   * All rules are case-insensitive except the one that must tell -D from -d.
   */
  var SEG = '[^;&|\\n]*';
  var CMD = '(?:^|[;&|({`\\n]\\s*|\\b(?:sudo|exec|nohup|then|do|else|time|command|builtin|env|doas)\\s+|' +
    '\\b(?:sh|bash|zsh|dash|ksh|fish)\\s+(?:-\\S+\\s+)*-[a-z]*c\\s+["\']?|\\bssh\\s[^;&|\\n"\']*[\\s"\'])';
  var HOME = '(?:~|\\$home|\\$\\{home\\}|/home/[^/\\s"\']+|/root|/users/[^/\\s"\']+)';
  var HOMEROOT = '(?:~|\\$home|\\$\\{home\\})';
  // rm targets: /, /x, /x/y (≤ 2 segments); the home directory or up to two
  // levels under it, in any spelling and with the quote of "$HOME"/x tolerated;
  // *, ., ./, ./*; any chain of .. (../.., ../../) optionally ending in /*; .git
  var RM_TARGET = '(?:' +
    '/(?:[^/\\s"\']+(?:/[^/\\s"\']+)?)?/?' + '|' +
    HOME + '["\']?(?:/[^/\\s"\']*){0,2}/?' + '|' +
    '\\*|\\.(?:/\\*?)?|\\.\\.(?:/\\.\\.)*(?:/\\*?)?|\\.git/?' +
  ')';
  var END = '(?=\\s|$|[;&|)])';
  // recursive chmod/chown targets: /, /*, home, or a top-level system directory
  var ROOTISH = '(?:/\\*?|' + HOMEROOT + '/?\\*?|/(?:usr|etc|var|bin|sbin|lib|lib64|boot|home|root|opt|sys|proc|dev|srv|mnt|system|library|applications)/?\\*?)';
  // files nobody should write into without a tap
  var SENSITIVE = '(?:/etc/|' + HOME + '/\\.ssh\\b|' + HOME + '/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile|bash_login|zshenv)\\b)';
  var KEYVARS = '(?:anthropic_api_key|genie_key|claude_code_oauth_token)';

  var DANGER_RULES = [
    { re: rx('--no-preserve-root'), reason: 'rm with --no-preserve-root' },
    { re: rx('\\brm(?=' + SEG + '\\s-(?:-recursive|[a-z]*r))(?=' + SEG + '\\s-(?:-force|[a-z]*f))' + SEG + '\\s["\']?' + RM_TARGET + '["\']?' + END), reason: 'deletes recursively at or near the root, your home, the current directory or .git' },
    { re: rx(CMD + 'sudo\\b'), reason: 'runs as root (sudo)' },
    { re: rx(CMD + 'su(?:\\s|$)'), reason: 'switches user (su)' },
    { re: rx('\\bmkfs(?:\\.\\w+)?\\b'), reason: 'formats a filesystem (mkfs)' },
    { re: rx('\\b(?:wipefs|fdisk|sfdisk|parted|shred)\\b'), reason: 'rewrites a disk or partition table' },
    { re: rx('\\bdd\\b' + SEG + '\\bif='), reason: 'raw disk copy (dd if=)' },
    { re: rx('(?:>\\s*|\\bof=)/dev/(?:sd|nvme|hd|xvd|vd|disk|mmcblk)'), reason: 'writes straight to a block device' },
    { re: rx(CMD + '(?:shutdown|reboot|halt|poweroff|init\\s+[06])\\b'), reason: 'powers off or reboots the machine' },
    { re: rx('\\bchmod(?=' + SEG + '\\s(?:-[a-z]*r\\b|--recursive))' + SEG + '\\s["\']?' + ROOTISH + '["\']?' + END), reason: 'recursive chmod on a system path' },
    { re: rx('\\bchown(?=' + SEG + '\\s(?:-[a-z]*r\\b|--recursive))' + SEG + '\\s["\']?' + ROOTISH + '["\']?' + END), reason: 'recursive chown on a system path' },
    { re: rx('\\bgit\\s+push\\b' + SEG + '(?:\\s--force(?:-with-lease)?\\b|\\s-f\\b|\\s\\+\\S)'), reason: 'force-push rewrites remote history' },
    { re: rx('\\bgit\\s+push\\b' + SEG + '(?:\\s--delete\\b|\\s-d\\b|\\s:\\S)'), reason: 'deletes a remote branch' },
    { re: rx('\\bgit\\s+reset\\b' + SEG + '--hard'), reason: 'git reset --hard discards uncommitted work' },
    { re: rx('\\bgit\\s+clean\\b(?=' + SEG + '\\s-[a-z]*f)(?=' + SEG + '\\s-[a-z]*d)'), reason: 'git clean -fd deletes untracked files and folders' },
    { re: new RegExp('\\b[gG][iI][tT]\\s+[bB][rR][aA][nN][cC][hH]\\b[^;&|]*\\s-[a-zA-Z]*D\\b'), reason: 'git branch -D deletes a branch even when unmerged' },
    { re: rx('\\bgit\\s+(?:checkout|restore)\\s+(?:--\\s+)?\\.' + END), reason: 'discards every local change' },
    { re: rx('\\bgit\\s+stash\\s+(?:drop|clear)\\b'), reason: 'throws away stashed work' },
    { re: rx('\\b(?:curl|wget)\\b[^|]*\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh|dash|ksh|fish)\\b'), reason: 'pipes a download straight into a shell' },
    { re: rx('\\bbase64\\s+(?:-d|-D|--decode)\\b[^|]*\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh)\\b'), reason: 'decodes and runs hidden code' },
    { re: rx('\\b(?:eval|sh|bash|zsh|source)\\s+(?:-c\\s+)?["\']?\\$\\(\\s*(?:curl|wget)\\b'), reason: 'evaluates a download as code' },
    { re: rx('\\b(?:sh|bash|zsh|source)\\s+<\\(\\s*(?:curl|wget)\\b'), reason: 'runs a download via process substitution' },
    { re: rx(':\\s*\\(\\s*\\)\\s*\\{'), reason: 'fork bomb' },
    { re: rx('\\bkill\\s+(?:-9|-kill|-sigkill|-s\\s+(?:sig)?kill)\\s+-1\\b'), reason: 'kills every process you own' },
    { re: rx('\\bpkill\\b(?=' + SEG + '\\s-9\\b)(?=' + SEG + '\\s-f\\b)'), reason: 'force-kills processes by pattern' },
    { re: rx(CMD + 'killall\\b'), reason: 'kills processes by name' },
    { re: rx('\\bdrop\\s+(?:table|database|schema)\\b'), reason: 'DROP TABLE / DATABASE' },
    { re: rx('\\btruncate\\s+table\\b'), reason: 'TRUNCATE TABLE' },
    // the WHERE may sit on a later line of a heredoc, so this lookahead crosses newlines
    { re: rx('\\bdelete\\s+from\\s+[\\w."`\\[\\]]+(?![^;|&]*\\bwhere\\b)'), reason: 'DELETE without a WHERE clause' },
    { re: rx('\\bcrontab\\b' + SEG + '\\s-[a-z]*r\\b'), reason: 'crontab -r wipes every cron job' },
    { re: rx('\\bhistory\\s+-c\\b'), reason: 'clears the shell history' },
    { re: rx('(?:>{1,2}|\\btee\\b(?:\\s+-a)?)\\s*["\']?' + SENSITIVE), reason: 'writes into a sensitive file (ssh, shell profile, /etc)' },
    { re: rx('\\b(?:cp|mv|ln|rsync|install)\\b' + SEG + '\\s["\']?' + SENSITIVE + '[^\\s;&|]*["\']?\\s*(?=$|[;&|)])'), reason: 'copies into a sensitive location (ssh, shell profile, /etc)' },
    { re: rx('\\bsed\\b(?=' + SEG + '\\s-[a-z]*i)' + SEG + '\\s["\']?' + SENSITIVE), reason: 'edits a sensitive file in place' },
    { re: rx('\\brm\\b' + SEG + '\\s["\']?' + SENSITIVE), reason: 'deletes a sensitive file' },
    { re: rx('\\b(?:cat|less|more|head|tail|bat|base64|xxd|od|hexdump|strings|curl|scp|cp)\\b' + SEG + HOME + '/\\.ssh/id_[a-z0-9_]+\\b(?!\\.pub)'), reason: 'reads a private SSH key' },
    { re: rx('\\bnpm\\s+publish\\b'), reason: 'publishes a package to the registry' },
    { re: rx('\\bdocker\\s+system\\s+prune\\b'), reason: 'docker system prune' },
    { re: rx('\\bdocker\\s+(?:container\\s+)?rm\\b' + SEG + '\\s(?:-[a-z]*f\\b|--force\\b)'), reason: 'force-removes containers' },
    { re: rx('\\bdocker\\s+volume\\s+(?:rm|prune)\\b'), reason: 'deletes docker volumes' },
    { re: rx('\\bterraform\\s+destroy\\b'), reason: 'terraform destroy' },
    { re: rx('\\bterraform\\s+apply\\b' + SEG + '-auto-approve'), reason: 'terraform apply without review' },
    { re: rx('\\bkubectl\\s+delete\\b'), reason: 'kubectl delete' },
    // the key rules read the quoted data too: a key in a search pattern or a commit message is still leaving
    { re: rx('\\bexport\\s+' + KEYVARS + '\\b'), reason: 'sets or exposes an API key', inData: true },
    { re: rx('\\$\\{?' + KEYVARS + '\\b'), reason: 'expands an API key into a command', inData: true },
    { re: rx('\\b(?:printenv|grep|rg|env)\\b' + SEG + KEYVARS), reason: 'looks up an API key', inData: true },
    { re: rx(HOME + '/(?:\\.genie/key|\\.claude/\\.credentials\\.json)\\b'), reason: 'touches the Genie key or Claude credentials', inData: true }
  ];

  // Quoted text that is an argument's DATA, never a command: what follows a
  // commit-message or search-pattern flag, and the pattern a grep-family tool
  // takes. It is blanked before the table runs so `git commit -m "drop table
  // migration"` and `rg "sudo" docs/` read as the everyday commands they are.
  var QUOTED = '("(?:[^"\\\\]|\\\\.)*"|\'[^\']*\')';
  var DATA_ARGS = [
    new RegExp('(\\s-[a-z]*m\\s*|\\s--message(?:=|\\s+)|\\s--grep(?:=|\\s+)|\\s--regexp(?:=|\\s+))' + QUOTED, 'gi'),
    new RegExp('(\\b(?:grep|egrep|fgrep|rg|ag|ack)\\b(?:\\s+-[^\\s"\']*)*\\s+(?:-e\\s+)?)' + QUOTED, 'gi')
  ];

  function dangerousCommand(cmd) {
    var s = String(cmd == null ? '' : cmd)
      .replace(/\\\r?\n/g, ' ')        // a backslash continuation joins the lines
      .replace(/[^\S\n]+/g, ' ')       // blanks collapse; newlines stay as separators
      .replace(/\s*\n\s*/g, ' \n ')
      .trim();
    if (!s) return { danger: false, reason: '' };
    var raw = s;
    for (var d = 0; d < DATA_ARGS.length; d++) s = s.replace(DATA_ARGS[d], '$1""');
    for (var i = 0; i < DANGER_RULES.length; i++) {
      var rule = DANGER_RULES[i];
      if (rule.re.test(rule.inData ? raw : s)) return { danger: true, reason: rule.reason };
    }
    return { danger: false, reason: '' };
  }

  function classifyTool(name, input) {
    name = String(name || '');
    input = (input && typeof input === 'object') ? input : {};
    if (READ_TOOLS[name]) return { level: 'read', reason: 'reads only' };
    if (WRITE_TOOLS[name]) return { level: 'write', reason: isGenieTool(name) ? 'changes Genie\'s memory or standing orders' : 'writes a file' };
    if (NETWORK_TOOLS[name]) return { level: 'network', reason: 'reaches the web' };
    if (name === 'AskUserQuestion') return { level: 'question', reason: 'the agent is asking you something' };
    if (name === 'Bash') {
      var dc = dangerousCommand(input.command);
      if (dc.danger) return { level: 'danger', reason: dc.reason };
      return { level: 'exec', reason: 'runs a shell command' };
    }
    if (/^mcp__/.test(name)) return { level: 'exec', reason: 'calls an MCP tool' };
    return { level: 'exec', reason: 'unknown tool — treated as a command' };
  }

  /* ---- "always allow" / deny rules ----
   * A rule's `match` is one of three things: '*' (any call of that tool), a
   * prefix ending in a bare '*' (owner-authored, e.g. 'npm *'), or an exact
   * string. A rule minted from the "Always allow" button is always exact:
   * ruleKey() escapes a command's own trailing star as '\*' ('git add \*'),
   * and matchRule() reads that back as the literal command.
   */

  // The part of a tool call a rule is matched against ('' when the tool has nothing specific).
  function ruleValue(name, input) {
    input = (input && typeof input === 'object') ? input : {};
    switch (String(name || '')) {
      case 'Bash': return sanitize(input.command).replace(/\s+/g, ' ').trim();
      case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return String(input.file_path || input.notebook_path || '');
      case 'WebFetch': return String(input.url || '');
      default: return '';
    }
  }

  function ruleKey(name, input) {
    var value = ruleValue(name, input);
    if (!value) return String(name || '') + ':*';
    if (value.charAt(value.length - 1) === '*') value = value.slice(0, -1) + '\\*';
    return String(name || '') + ':' + value;
  }

  function isPrefixRule(rule) {
    var m = rule.match;
    return m !== '*' && m.length > 1 && m.charAt(m.length - 1) === '*' && m.charAt(m.length - 2) !== '\\';
  }

  // An exact rule names one full command or path — never a prefix, never a wildcard.
  function isExactRule(rule) {
    return rule.match !== '*' && !isPrefixRule(rule);
  }

  function validRule(r) {
    return !!(r && typeof r === 'object' && typeof r.tool === 'string' && r.tool.trim() &&
      typeof r.match === 'string' && r.match.trim() && (r.behavior === 'allow' || r.behavior === 'deny'));
  }

  function normRule(r) {
    return { tool: r.tool.trim(), match: r.match.trim(), behavior: r.behavior };
  }

  // 'Bash:npm test' + behavior → a rule object (the server's "always" path).
  function ruleFromKey(key, behavior) {
    var s = String(key || '');
    var i = s.indexOf(':');
    if (i <= 0) return null;
    return { tool: s.slice(0, i), match: s.slice(i + 1), behavior: behavior === 'deny' ? 'deny' : 'allow' };
  }

  function matchRule(rule, name, value) {
    if (rule.tool !== '*' && rule.tool !== name) return false;
    var m = rule.match;
    if (m === '*') return true;
    if (isPrefixRule(rule)) return value.indexOf(m.slice(0, -1)) === 0;
    if (/\\\*$/.test(m)) return value === m.slice(0, -2) + '*';
    return value === m;
  }

  // Deny rules win over allow rules, whatever their order.
  function findRule(rules, name, input) {
    if (!Array.isArray(rules) || !rules.length) return null;
    name = String(name || '');
    var value = ruleValue(name, input);
    var allow = null;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!validRule(r) || !matchRule(r, name, value)) continue;
      if (r.behavior === 'deny') return r;
      if (!allow) allow = r;
    }
    return allow;
  }

  function addRule(rules, rule, behavior) {
    var list = (Array.isArray(rules) ? rules : []).filter(validRule).map(normRule);
    if (typeof rule === 'string') rule = ruleFromKey(rule, behavior);
    if (!validRule(rule)) return list;
    rule = normRule(rule);
    for (var i = 0; i < list.length; i++) {
      if (list[i].tool === rule.tool && list[i].match === rule.match && list[i].behavior === rule.behavior) return list;
    }
    list.push(rule);
    return list;
  }

  function removeRule(rules, idx) {
    var list = (Array.isArray(rules) ? rules : []).slice();
    idx = Number(idx);
    if (idx >= 0 && idx < list.length) list.splice(idx, 1);
    return list;
  }

  // The whole policy in one place: a question always waits for the owner;
  // then rules (deny beats allow, and an allow rule clears a DESTRUCTIVE
  // command only when it names that exact command — a prefix or wildcard
  // rule must not wave through `git status; rm -rf /`); then Genie's own
  // tools; then the mode.
  function decide(o) {
    o = o || {};
    var mode = MODES.indexOf(o.mode) >= 0 ? o.mode : DEFAULT_MODE;
    var name = String(o.name || '');
    var input = (o.input && typeof o.input === 'object') ? o.input : {};
    var c = classifyTool(name, input);
    if (c.level === 'question') return { behavior: 'ask', level: 'question', reason: c.reason };
    var rule = findRule(o.rules, name, input);
    if (rule && rule.behavior === 'deny') return { behavior: 'deny', level: c.level, reason: 'denied by rule ' + rule.tool + ':' + rule.match };
    if (rule && (c.level !== 'danger' || isExactRule(rule))) return { behavior: 'allow', level: c.level, reason: 'allowed by rule ' + rule.tool + ':' + rule.match };
    if (isGenieTool(name)) return { behavior: 'allow', level: c.level, reason: 'Genie\'s own tool' };
    if (mode === 'auto') return { behavior: 'allow', level: c.level, reason: 'auto mode' };
    if (c.level === 'danger') return { behavior: 'ask', level: 'danger', reason: c.reason };
    if (mode === 'trust') return { behavior: 'allow', level: c.level, reason: 'trust mode' };
    if (c.level === 'read') return { behavior: 'allow', level: 'read', reason: 'reads never ask' };
    return { behavior: 'ask', level: c.level, reason: c.reason };
  }

  function sdkPermissionMode(mode) {
    return mode === 'auto' ? 'bypassPermissions' : 'default';
  }

  // The sentence on the approval card.
  function askTitle(name, input, level, reason) {
    name = String(name || '');
    if (level === 'question' || name === 'AskUserQuestion') return 'Genie has a question for you';
    var summary = summarizeInput(name, input);
    if (level === 'danger') return '⚠️ Destructive: `' + summary + '` — ' + (reason || 'this can\'t be undone');
    switch (name) {
      case 'Bash': return 'Genie wants to run `' + summary + '`';
      case 'Write': return 'Genie wants to write ' + summary;
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'Genie wants to edit ' + summary;
      case 'WebFetch': return 'Genie wants to fetch ' + summary;
      case 'WebSearch': return 'Genie wants to search the web for “' + summary + '”';
      case 'Task': case 'Agent': return 'Genie wants to send a subagent: ' + summary;
    }
    if (isGenieTool(name)) return 'Genie wants to ' + name.replace(/^mcp__genie__/, '').replace(/_/g, ' ') + (summary ? ': ' + summary : '');
    return 'Genie wants to use ' + name + (summary ? ': ' + summary : '');
  }

  /* ====================================================================
   * 7. Stream reducer — Agent SDK messages → Genie events
   * ==================================================================== */

  function initRun(runId) {
    return {
      runId: runId, sessionId: null, model: null, text: '', streaming: {}, tools: {},
      cost: 0, turns: 0, stop: null, subtype: null, result: null, errors: [], denials: [], events: 0
    };
  }

  // Tool output as the card shows it: sanitized, capped, with the overflow counted.
  function clipOutput(s) {
    s = sanitize(s);
    if (s.length <= OUTPUT_MAX) return s;
    return s.slice(0, OUTPUT_MAX) + '\n… (+' + (s.length - OUTPUT_MAX) + ' chars)';
  }

  function resultText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      var parts = [];
      for (var i = 0; i < content.length; i++) {
        var b = content[i];
        if (!b) continue;
        if (typeof b === 'string') parts.push(b);
        else if (b.type === 'text') parts.push(String(b.text == null ? '' : b.text));
        else if (b.type === 'image') parts.push('[image]');
        else if (b.type) parts.push('[' + b.type + ']');
      }
      return parts.join('\n');
    }
    if (typeof content === 'object') return compactJSON(content);
    return String(content);
  }

  function reduceInner(state, msg, now) {
    var out = [];
    if (!msg || typeof msg !== 'object') return out;
    var type = msg.type;
    var parent = msg.parent_tool_use_id || null;

    if (type === 'system') {
      if (msg.subtype === 'init') {
        state.sessionId = msg.session_id || state.sessionId;
        state.model = msg.model || state.model;
        out.push({
          t: 'init', sessionId: msg.session_id || null, model: msg.model || null,
          tools: Array.isArray(msg.tools) ? msg.tools.slice() : [], cwd: msg.cwd || null,
          permissionMode: msg.permissionMode || null, version: msg.claude_code_version || null
        });
      } else if (msg.subtype === 'status') {
        var st = msg.status || msg.message || msg.text;
        if (st) out.push({ t: 'status', text: oneLine(st, 200) });
      } else if (msg.subtype === 'task_notification') {
        var sum = msg.summary || msg.message || msg.status;
        if (sum) out.push({ t: 'status', text: oneLine(sum, 200) });
      } else if (msg.subtype === 'compact_boundary') {
        var trig = msg.compact_metadata && msg.compact_metadata.trigger;
        out.push({ t: 'status', text: 'context compacted' + (trig ? ' (' + trig + ')' : '') });
      }
      return out;
    }

    if (type === 'stream_event') {
      var ev = msg.event;
      if (!ev || typeof ev !== 'object') return out;
      var key = (parent || '') + ':' + (ev.index == null ? 0 : ev.index);
      if (ev.type === 'message_start') {
        if (ev.message && ev.message.id) state.currentMsgId = ev.message.id;
      } else if (ev.type === 'content_block_start') {
        var cb = ev.content_block || {};
        state.streaming[key] = { type: cb.type || 'text', parent: parent };
        if (cb.type === 'thinking') out.push({ t: 'thinking', on: true });
      } else if (ev.type === 'content_block_delta') {
        var delta = ev.delta || {};
        if (delta.type === 'text_delta') {
          // Deltas are for the screen only; the canonical text arrives whole in
          // the assistant message, so nothing is accumulated here.
          var txt = String(delta.text == null ? '' : delta.text);
          if (txt) out.push({ t: 'text', text: txt, parent: parent });
        } else if (delta.type === 'thinking_delta') {
          var th = String(delta.thinking == null ? '' : delta.thinking);
          if (th) out.push({ t: 'thinking', text: th });
        }
        // input_json_delta, signature_delta: nothing to show
      } else if (ev.type === 'content_block_stop') {
        var blk = state.streaming[key];
        if (blk && blk.type === 'thinking') out.push({ t: 'thinking', on: false });
        delete state.streaming[key];
      }
      return out; // message_delta, message_stop: nothing to show
    }

    if (type === 'assistant') {
      var am = msg.message || {};
      var content = Array.isArray(am.content) ? am.content : [];
      var msgId = am.id || state.currentMsgId || null;
      for (var i = 0; i < content.length; i++) {
        var b = content[i];
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          var full = String(b.text == null ? '' : b.text);
          if (full.trim()) out.push({ t: 'text_final', text: sanitize(full), parent: parent, msgId: msgId });
        } else if (b.type === 'tool_use') {
          var tid = String(b.id || ('tool_' + shortId(msgId + ':' + i)));
          var tname = String(b.name || 'tool');
          var tinput = (b.input && typeof b.input === 'object') ? b.input : {};
          state.tools[tid] = { name: tname, input: tinput, parent: parent, startedAt: now };
          out.push({ t: 'tool', id: tid, name: tname, input: tinput, summary: summarizeInput(tname, tinput), icon: toolIcon(tname), parent: parent });
        }
      }
      return out;
    }

    if (type === 'user') {
      var um = msg.message || {};
      var uc = um.content;
      if (!Array.isArray(uc)) return out; // plain prompt echo — the server already emitted `user`
      for (var j = 0; j < uc.length; j++) {
        var r = uc[j];
        if (!r || r.type !== 'tool_result') continue;
        var rid = String(r.tool_use_id || '');
        var known = state.tools[rid];
        if (known) { known.endedAt = now; known.isError = !!r.is_error; }
        out.push({
          t: 'tool_result', id: rid, output: clipOutput(resultText(r.content)),
          isError: !!r.is_error, parent: parent || (known ? known.parent : null) || null
        });
      }
      return out;
    }

    if (type === 'tool_progress') {
      out.push({
        t: 'progress', id: String(msg.tool_use_id || ''), name: String(msg.tool_name || ''),
        elapsed: Number(msg.elapsed_time_seconds) || 0, parent: parent
      });
      return out;
    }

    if (type === 'result') {
      var subtype = String(msg.subtype || 'unknown');
      var isErr = !!msg.is_error;
      var denials = (Array.isArray(msg.permission_denials) ? msg.permission_denials : []).map(function (d) {
        d = d || {};
        return { tool: String(d.tool_name || ''), summary: summarizeInput(d.tool_name, d.tool_input) };
      });
      var errors = (Array.isArray(msg.errors) ? msg.errors : []).map(function (e) { return oneLine(typeof e === 'string' ? e : compactJSON(e), 400); });
      state.subtype = subtype;
      state.stop = msg.stop_reason || null;
      state.cost = Number(msg.total_cost_usd) || 0;
      state.turns = Number(msg.num_turns) || 0;
      state.result = msg.result == null ? null : String(msg.result);
      state.errors = errors;
      state.denials = denials;
      if (msg.session_id) state.sessionId = msg.session_id;
      out.push({
        t: 'result', ok: subtype === 'success' && !isErr, subtype: subtype,
        result: state.result == null ? '' : sanitize(state.result),
        cost: state.cost, turns: state.turns, durationMs: Number(msg.duration_ms) || 0,
        denials: denials, errors: errors, sessionId: msg.session_id || state.sessionId || null,
        stop: state.stop
      });
      return out;
    }

    return out; // anything else: nothing to show
  }

  // Never throws — a malformed message is worth nothing, not a crashed run.
  function reduce(state, msg, now) {
    if (!state || typeof state !== 'object') return [];
    var out;
    try { out = reduceInner(state, msg, Number(now) || 0); } catch (e) { out = []; }
    state.events = (state.events || 0) + out.length;
    return out;
  }

  var TRANSCRIPT_TYPES = {
    user: 1, text_final: 1, tool: 1, tool_result: 1, ask: 1, ask_resolved: 1, notify: 1,
    system: 1, result: 1, error: 1, run_start: 1, run_end: 1, init: 1
  };

  function transcriptEvent(evt) {
    return !!(evt && TRANSCRIPT_TYPES[evt.t]);
  }

  // Stored events → the compact list a history view renders. Tool results
  // and approval decisions fold into the card they belong to.
  function foldTranscript(events) {
    var items = [], byTool = {}, byAsk = {};
    (Array.isArray(events) ? events : []).forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      var at = e.at == null ? null : e.at;
      switch (e.t) {
        case 'user':
          items.push({ role: 'user', text: String(e.text || ''), at: at }); break;
        case 'text_final':
          items.push({ role: 'assistant', text: String(e.text || ''), parent: e.parent || null, msgId: e.msgId || null, at: at }); break;
        case 'tool': {
          var card = { role: 'tool', id: e.id, name: e.name, summary: e.summary, icon: e.icon || toolIcon(e.name), input: e.input, parent: e.parent || null, output: null, isError: null, at: at };
          byTool[e.id] = card; items.push(card); break;
        }
        case 'tool_result': {
          var hit = byTool[e.id];
          if (hit) { hit.output = e.output; hit.isError = !!e.isError; }
          else items.push({ role: 'tool', id: e.id, name: '', summary: '', icon: '🔧', input: null, parent: e.parent || null, output: e.output, isError: !!e.isError, at: at });
          break;
        }
        case 'ask': {
          var ask = { role: 'ask', requestId: e.requestId, toolId: e.toolId, name: e.name, summary: e.summary, title: e.title, level: e.level, reason: e.reason,
            kind: e.kind || 'permission', questions: e.questions || null, decision: null, by: null, answers: null, at: at };
          byAsk[e.requestId] = ask; items.push(ask); break;
        }
        case 'ask_resolved': {
          var a = byAsk[e.requestId];
          if (a) { a.decision = e.decision; a.by = e.by; a.answers = e.answers || null; }
          break;
        }
        case 'system': case 'status':
          items.push({ role: 'system', kind: e.t, text: String(e.text || ''), at: at }); break;
        case 'notify':
          items.push({ role: 'system', kind: 'notify', text: String(e.title || '') + (e.body ? ' — ' + e.body : ''), at: at }); break;
        case 'error':
          items.push({ role: 'system', kind: 'error', text: String(e.message || ''), at: at }); break;
        case 'result':
          items.push({ role: 'result', ok: !!e.ok, subtype: e.subtype, cost: Number(e.cost) || 0, turns: Number(e.turns) || 0, durationMs: Number(e.durationMs) || 0, denials: e.denials || [], errors: e.errors || [], at: at }); break;
        case 'run_end':
          if (e.status && e.status !== 'done') items.push({ role: 'system', kind: 'run_end', text: 'run ' + e.status, at: at });
          break;
        default: break; // run_start, init, text, thinking, progress, ping
      }
    });
    return items;
  }

  /* ====================================================================
   * 8. Cost
   * ==================================================================== */

  function priceFor(model) {
    var id = String(model || '');
    for (var i = 0; i < MODELS.length; i++) {
      if (MODELS[i].id === id) return withKnown(MODELS[i], true);
    }
    return withKnown(MODELS[0], false);
  }

  function withKnown(entry, known) {
    var o = {};
    for (var k in entry) if (Object.prototype.hasOwnProperty.call(entry, k)) o[k] = entry[k];
    o.known = known;
    return o;
  }

  function costOf(usage, model) {
    usage = usage || {};
    var p = priceFor(model);
    var usd = (Number(usage.input_tokens) || 0) * p.inPerMTok +
      (Number(usage.output_tokens) || 0) * p.outPerMTok +
      (Number(usage.cache_read_input_tokens) || 0) * p.cacheReadPerMTok +
      (Number(usage.cache_creation_input_tokens) || 0) * p.cacheWritePerMTok;
    return Math.round(usd / 1e6 * 1e6) / 1e6;
  }

  /* ====================================================================
   * 9. Memory — one markdown file, one bullet per fact
   * ==================================================================== */

  var MEMORY_HEADING = '# Genie memory';
  var MEMORY_LINE_RE = /^\s*[-*]\s+(?:\[(\d{4}-\d{2}-\d{2})\]\s*)?(.+?)\s*$/;

  function memoryParse(text) {
    var lines = String(text == null ? '' : text).split('\n');
    var items = [];
    for (var i = 0; i < lines.length; i++) {
      var m = MEMORY_LINE_RE.exec(lines[i]);
      if (!m) continue;
      items.push({ n: items.length + 1, fact: m[2], date: m[1] || null });
    }
    return items;
  }

  function isoDate(now) {
    var d = new Date(Number(now) || 0);
    return isNaN(d.getTime()) ? '1970-01-01' : d.toISOString().slice(0, 10);
  }

  function memoryText(items) {
    var out = [MEMORY_HEADING, ''];
    for (var i = 0; i < items.length; i++) out.push('- ' + (items[i].date ? '[' + items[i].date + '] ' : '') + items[i].fact);
    return out.join('\n') + '\n';
  }

  function memoryAdd(text, fact, now) {
    var f = sanitize(fact).replace(/\s+/g, ' ').trim();
    if (!f) return fail('nothing to remember');
    if (f.length > 500) return fail('keep a memory under 500 characters');
    var items = memoryParse(text);
    for (var i = 0; i < items.length; i++) {
      if (items[i].fact.toLowerCase() === f.toLowerCase()) return fail('already remembered (#' + items[i].n + ')');
    }
    if (items.length >= MEMORY_MAX) return fail('memory is full (' + MEMORY_MAX + ' entries) — /forget something first');
    var item = { n: items.length + 1, fact: f, date: isoDate(now) };
    items.push(item);
    return { ok: true, text: memoryText(items), item: item };
  }

  function memoryForget(text, n) {
    var items = memoryParse(text);
    if (n === 'all' || n === '*') return { ok: true, text: memoryText([]), removed: items };
    var idx = Number(n);
    if (!(idx >= 1 && idx <= items.length) || idx !== Math.floor(idx)) return fail('no memory #' + String(n) + (items.length ? ' (1–' + items.length + ')' : ' — memory is empty'));
    var removed = items.splice(idx - 1, 1)[0];
    for (var i = 0; i < items.length; i++) items[i].n = i + 1;
    return { ok: true, text: memoryText(items), removed: removed };
  }

  // Bullets for the system prompt, most recent last, oldest dropped first to fit.
  function memoryForPrompt(text, maxChars) {
    var max = Number(maxChars) > 0 ? Number(maxChars) : 6000;
    var items = memoryParse(text);
    var lines = items.map(function (it) { return '- ' + (it.date ? '[' + it.date + '] ' : '') + it.fact; });
    while (lines.length && lines.join('\n').length > max) lines.shift();
    return lines.join('\n');
  }

  /* ====================================================================
   * 10. System prompt — what Genie is told on top of the Claude Code preset
   * ==================================================================== */

  function isoLocal(now, tzOffsetMin) {
    var tz = Number(tzOffsetMin) || 0;
    var d = new Date((Number(now) || 0) + tz * MINUTE);
    if (isNaN(d.getTime())) return '';
    var sign = tz < 0 ? '-' : '+', a = Math.abs(tz);
    return DAY_SHORT[d.getUTCDay()] + ' ' + d.toISOString().slice(0, 16) + sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
  }

  function buildSystemAppend(o) {
    o = o || {};
    var owner = sanitize(o.owner).trim() || 'the owner';
    var mode = MODES.indexOf(o.mode) >= 0 ? o.mode : DEFAULT_MODE;
    var info = MODE_INFO[mode];
    var lines = [];
    lines.push('# Genie');
    lines.push('You are Genie, ' + owner + '\'s personal agent — the agent that does what they tell it. You ACT: when asked for something, do it (run the command, edit the file, fetch the page, write the report) rather than describing how it could be done. Take the shortest sensible path, and finish the job.');
    lines.push('Approvals are handled by the harness. Never ask for permission in prose — call the tool; if the owner declines, adapt or say briefly what you would need. When you truly need the owner to choose or fill in a detail, use the AskUserQuestion tool: it reaches their phone. Report what you did plainly and briefly: what changed, what you found, what is left.');
    lines.push('Durable facts about the owner, their machine or their preferences go through `mcp__genie__remember` (never edit the memory file by hand); `mcp__genie__forget` removes one. Standing orders go through `mcp__genie__schedule` with `when` + `task` — when grammar: ' + SCHEDULE_HINT + '; `mcp__genie__unschedule` and `mcp__genie__list_schedules` manage them. Use `mcp__genie__notify` for a phone notification when a long job finishes or needs the owner\'s attention.');
    lines.push('Now: ' + isoLocal(o.now, o.tzOffsetMin) + ' (owner\'s local time). Mode: ' + info.label + ' — ' + info.blurb + '.' + (o.cwd ? ' Working directory: ' + sanitize(o.cwd).trim() + '.' : ''));
    if (o.driver === 'rehearsal') lines.push('This is a rehearsal: no tool runs for real.');

    var mem = typeof o.memory === 'string' ? memoryForPrompt(o.memory) : (Array.isArray(o.memory) ? o.memory.map(function (m) { return '- ' + sanitize(typeof m === 'string' ? m : (m && m.fact) || '').trim(); }).filter(function (l) { return l !== '- '; }).join('\n') : '');
    if (mem) { lines.push(''); lines.push('## What you remember'); lines.push(mem); }

    var scheds = (Array.isArray(o.schedules) ? o.schedules : []).filter(function (s) { return s && s.enabled !== false; });
    if (scheds.length) {
      lines.push(''); lines.push('## Standing orders');
      scheds.forEach(function (s) {
        var desc = s.schedule ? describeSchedule(s.schedule) : (s.label || '');
        lines.push('- [' + sanitize(s.id).trim() + '] ' + desc + ' — ' + oneLine(s.task, 200) + (s.nextRunAt ? ' (next: ' + isoLocal(s.nextRunAt, o.tzOffsetMin) + ')' : ''));
      });
    }

    var cmds = (Array.isArray(o.commands) ? o.commands : []).filter(function (c) { return c && c.name; });
    if (cmds.length) {
      lines.push(''); lines.push('## Custom commands (the owner types these)');
      cmds.forEach(function (c) { lines.push('- /' + sanitize(c.name).trim() + (c.description ? ' — ' + oneLine(c.description, 120) : '')); });
    }
    return lines.join('\n');
  }

  /* ====================================================================
   * 11. Conversations & validation
   * ==================================================================== */

  function isConversationId(id) { return /^c[0-9a-z]{8,24}$/.test(String(id || '')); }
  function isScheduleId(id) { return /^s[0-9a-z]{6,24}$/.test(String(id || '')); }
  function isRunId(id) { return /^r[0-9a-z]{6,24}$/.test(String(id || '')); }
  function isRequestId(id) { return /^q[0-9a-z]{6,24}$/.test(String(id || '')); }

  function titleFrom(prompt) {
    var lines = sanitize(prompt).split('\n');
    var first = '';
    for (var i = 0; i < lines.length; i++) { if (lines[i].trim()) { first = lines[i].replace(/\s+/g, ' ').trim(); break; } }
    if (!first) return 'New conversation';
    if (first.length <= 48) return first;
    var cut = first.slice(0, 48);
    if (first.charAt(48) !== ' ') {           // mid-word: back up to the last whole word
      var sp = cut.lastIndexOf(' ');
      if (sp > 20) cut = cut.slice(0, sp);
    }
    return cut.replace(/[\s,;:.!?-]+$/, '') + '…';
  }

  function newConversation(o) {
    o = o || {};
    var now = Number(o.now) || 0;
    return {
      id: String(o.id || ''),
      title: sanitize(o.title).trim() || 'New conversation',
      createdAt: now, updatedAt: now,
      sessionId: null, runs: 0, cost: 0, status: 'idle',
      source: o.source === 'schedule' ? 'schedule' : 'user',
      scheduleId: o.scheduleId || null
    };
  }

  function validatePrompt(text) {
    var s = sanitize(text).trim();
    if (!s) return fail('say something first');
    if (s.length > PROMPT_MAX) return fail('keep it under ' + PROMPT_MAX + ' characters (' + s.length + ' now)');
    return { ok: true, text: s };
  }

  function validateCwd(path) {
    var s = String(path == null ? '' : path).trim();
    if (!s) return fail('the working directory is empty');
    if (s.length > 400) return fail('path too long (400 max)');
    if (/[\0\n\r]/.test(s)) return fail('path contains a control character');
    if (!/^(?:\/|[A-Za-z]:\\)/.test(s)) return fail('the working directory must be an absolute path');
    return { ok: true, cwd: s };
  }

  function validateModel(id) {
    var s = String(id == null ? '' : id).trim();
    for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === s) return { ok: true, model: s };
    return fail('unknown model "' + oneLine(s, 40) + '" — one of ' + MODELS.map(function (m) { return m.id; }).join(', '));
  }

  function validateMode(m) {
    var s = String(m == null ? '' : m).trim().toLowerCase();
    if (MODES.indexOf(s) >= 0) return { ok: true, mode: s };
    return fail('mode must be ask, trust or auto');
  }

  function validateEffort(e) {
    var s = String(e == null ? '' : e).trim().toLowerCase();
    if (EFFORTS.indexOf(s) >= 0) return { ok: true, effort: s };
    return fail('effort must be one of ' + EFFORTS.join(', '));
  }

  function defaultSettings() {
    return { mode: DEFAULT_MODE, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, cwd: null, owner: 'you', maxTurns: DEFAULT_LIMITS.maxTurns, maxUsd: DEFAULT_LIMITS.maxUsd, rules: [] };
  }

  // Validate a settings patch and apply it. Unknown keys are ignored;
  // `changed` lists only the keys whose value actually moved.
  function applySettings(current, patch) {
    var base = defaultSettings();
    current = current || {};
    for (var k in current) if (Object.prototype.hasOwnProperty.call(current, k)) base[k] = current[k];
    patch = (patch && typeof patch === 'object') ? patch : {};
    var next = {}, changed = [], v;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) next[k] = base[k];

    if (Object.prototype.hasOwnProperty.call(patch, 'mode')) { v = validateMode(patch.mode); if (!v.ok) return v; next.mode = v.mode; }
    if (Object.prototype.hasOwnProperty.call(patch, 'model')) { v = validateModel(patch.model); if (!v.ok) return v; next.model = v.model; }
    if (Object.prototype.hasOwnProperty.call(patch, 'effort')) { v = validateEffort(patch.effort); if (!v.ok) return v; next.effort = v.effort; }
    if (Object.prototype.hasOwnProperty.call(patch, 'cwd')) {
      if (patch.cwd == null || patch.cwd === '') next.cwd = null;
      else { v = validateCwd(patch.cwd); if (!v.ok) return v; next.cwd = v.cwd; }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'owner')) {
      var owner = sanitize(patch.owner).replace(/\s+/g, ' ').trim();
      if (!owner) return fail('owner cannot be empty');
      if (owner.length > 60) return fail('owner name: 60 characters max');
      next.owner = owner;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'maxTurns')) {
      var mt = Number(patch.maxTurns);
      if (!isFinite(mt) || mt < 1 || mt > 1000 || mt !== Math.floor(mt)) return fail('maxTurns must be a whole number from 1 to 1000');
      next.maxTurns = mt;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'maxUsd')) {
      var mu = Number(patch.maxUsd);
      if (!isFinite(mu) || mu < 0.1 || mu > 1000) return fail('maxUsd must be between 0.1 and 1000');
      next.maxUsd = mu;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'rules')) {
      if (!Array.isArray(patch.rules)) return fail('rules must be an array');
      for (var i = 0; i < patch.rules.length; i++) if (!validRule(patch.rules[i])) return fail('rule #' + (i + 1) + ' needs tool, match and behavior (allow|deny)');
      next.rules = patch.rules.map(normRule);
    }
    for (k in next) {
      if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
      if (JSON.stringify(next[k]) !== JSON.stringify(base[k])) changed.push(k);
    }
    return { ok: true, settings: next, changed: changed };
  }

  /* ====================================================================
   * 12. Custom commands — GENIE_HOME/commands/<name>.md
   * ==================================================================== */

  function parseCommandFile(name, body) {
    var text = sanitize(body).replace(/^\uFEFF/, '');
    var lines = text.split('\n');
    var description = '';
    var m = lines.length ? /^#\s*(.*)$/.exec(lines[0]) : null;
    if (m) { description = m[1].trim(); lines.shift(); }
    var template = lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    return { name: String(name || '').toLowerCase().replace(/\.md$/, ''), description: description, template: template };
  }

  function splitArgs(args) {
    var out = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g, m;
    var s = String(args == null ? '' : args);
    while ((m = re.exec(s)) !== null) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
    return out;
  }

  // Template + args → prompt. $ARGUMENTS is everything; $1…$9 are words.
  // A template with no placeholders gets the arguments appended so nothing
  // the owner typed is silently dropped.
  function expandCommand(cmd, args) {
    var template = String((cmd && cmd.template) || '');
    var all = String(args == null ? '' : args).trim();
    var words = splitArgs(all);
    var used = /\$ARGUMENTS\b|\$[1-9]\b/.test(template);
    var out = template.replace(/\$ARGUMENTS\b/g, all).replace(/\$([1-9])\b/g, function (_, n) { return words[Number(n) - 1] || ''; });
    if (!used && all) out = out + (out ? '\n\n' : '') + all;
    return out;
  }

  /* ====================================================================
   * 13. Rehearsal — the honest offline run
   * ==================================================================== */

  var REHEARSAL_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task'];
  var VERBS = ['run', 'check', 'fix', 'write', 'build', 'test', 'deploy', 'find', 'search', 'read', 'summarize', 'summarise',
    'list', 'install', 'update', 'upgrade', 'create', 'make', 'add', 'remove', 'delete', 'rename', 'refactor', 'review',
    'open', 'send', 'clean', 'report', 'ping', 'look', 'show', 'tell', 'explain', 'compare', 'draft', 'plan', 'monitor',
    'watch', 'count', 'convert', 'download', 'fetch', 'generate', 'organize', 'organise', 'backup', 'back', 'sync', 'analyze',
    'analyse', 'migrate', 'set', 'get', 'commit', 'push', 'pull', 'merge', 'restart', 'start', 'stop', 'schedule', 'remind'];
  var STOP = { the: 1, a: 1, an: 1, and: 1, or: 1, of: 1, to: 1, in: 1, on: 1, for: 1, with: 1, my: 1, me: 1, it: 1, is: 1, this: 1, that: 1,
    please: 1, can: 1, you: 1, could: 1, would: 1, then: 1, at: 1, by: 1, from: 1, into: 1, up: 1, all: 1, every: 1, some: 1, i: 1, we: 1,
    do: 1, be: 1, are: 1, was: 1, not: 1, so: 1, if: 1, as: 1, about: 1, what: 1, how: 1, when: 1, also: 1, just: 1 };

  function planFor(prompt) {
    var words = String(prompt || '').toLowerCase().replace(/[^\p{L}\p{N}\s_./-]/gu, ' ').split(/\s+/).filter(Boolean);
    var verb = 'handle', nouns = [];
    for (var i = 0; i < words.length; i++) {
      if (verb === 'handle' && VERBS.indexOf(words[i]) >= 0) { verb = words[i]; continue; }
      if (!STOP[words[i]] && words[i].length > 2 && nouns.length < 3) nouns.push(words[i]);
    }
    var subject = nouns.length ? nouns.join(' ') : 'the request';
    var seed = hashStr('rehearsal:' + prompt);
    var looks = ['Look around first: check the working directory and anything that already relates to ' + subject + '.',
      'Get the lay of the land: read what is already there about ' + subject + ' before touching it.',
      'Start by finding the relevant files and context for ' + subject + '.'];
    var does = ['Do it: ' + verb + ' ' + subject + ', running the real commands and editing the real files.',
      'Then ' + verb + ' ' + subject + ' — the actual work, with the shell and file tools.',
      'Act: ' + verb + ' ' + subject + ', checking the result as it goes.'];
    var reports = ['Report back plainly: what changed, what was found, and anything left for you.',
      'Finish with a short, honest summary — and a notification if it took a while.',
      'Wrap up with what was done and what, if anything, needs your decision.'];
    return [looks[seed % 3], does[(seed >> 3) % 3], reports[(seed >> 6) % 3]];
  }

  function zeroUsage() {
    return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  }

  function chunk3(text) {
    var n = Math.max(3, Math.min(4, Math.ceil(text.length / 40)));
    var size = Math.ceil(text.length / n), out = [];
    for (var i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  var REHEARSAL_CLOSING = 'Rehearsal complete. Set ANTHROPIC_API_KEY (or log in with `claude`) and restart to make this real.';

  // The one question the rehearsal asks, when the prompt mentions asking —
  // so the question card, its answers and the driver's answer plumbing can
  // be exercised without a model.
  var REHEARSAL_QUESTION = {
    question: 'Which way should the rehearsal go?', header: 'Path',
    options: [{ label: 'Quick', description: 'the short route' }, { label: 'Thorough', description: 'the long route' }],
    multiSelect: false
  };

  function rehearsalScript(prompt, o) {
    o = o || {};
    prompt = String(prompt == null ? '' : prompt);
    var mode = MODES.indexOf(o.mode) >= 0 ? o.mode : DEFAULT_MODE;
    var cwd = o.cwd || '/';
    var sid = 'rehearsal-' + shortId(prompt);
    var n = 0;
    function uuid() { n++; return 'rehearsal-' + shortId(prompt + ':' + n) + '-' + pad2(n); }
    function ev(event) { return { type: 'stream_event', event: event, parent_tool_use_id: null, session_id: sid, uuid: uuid() }; }

    var plan = planFor(prompt);
    var intro = '🎭 Rehearsal mode — no SDK or credentials, so nothing runs for real. Here is how Genie would take this on:\n\n' +
      '1. ' + plan[0] + '\n2. ' + plan[1] + '\n3. ' + plan[2];
    var head = oneLine(prompt, 60).replace(/["'`\\$]/g, '');
    var asks = /\bask\b/i.test(prompt);
    var toolId = 'toolu_rehearsal_' + shortId(prompt);
    var questionId = 'toolu_rehearsal_q_' + shortId(prompt);
    var msg1 = 'msg_rehearsal_' + shortId(prompt + ':1'), msg2 = 'msg_rehearsal_' + shortId(prompt + ':2'), msg3 = 'msg_rehearsal_' + shortId(prompt + ':3');
    var msgQ = 'msg_rehearsal_' + shortId(prompt + ':q');
    var script = [];

    script.push({
      type: 'system', subtype: 'init', session_id: sid, model: 'rehearsal', tools: REHEARSAL_TOOLS.slice(), cwd: cwd,
      permissionMode: sdkPermissionMode(mode), claude_code_version: 'rehearsal', apiKeySource: 'none',
      mcp_servers: [], slash_commands: [], agents: [], uuid: uuid()
    });

    script.push(ev({ type: 'message_start', message: { id: msg1, type: 'message', role: 'assistant', model: 'rehearsal', content: [], usage: zeroUsage() } }));
    script.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    var chunks = chunk3(intro);
    for (var i = 0; i < chunks.length; i++) script.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunks[i] } }));
    script.push(ev({ type: 'content_block_stop', index: 0 }));
    script.push(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: zeroUsage() }));
    script.push(ev({ type: 'message_stop' }));
    script.push({
      type: 'assistant', parent_tool_use_id: null, session_id: sid, uuid: uuid(),
      message: { id: msg1, type: 'message', role: 'assistant', model: 'rehearsal', content: [{ type: 'text', text: intro }], stop_reason: 'end_turn', usage: zeroUsage() }
    });

    if (asks) {
      // The driver substitutes the owner's answer (or the decline) for 'no answer'.
      script.push({
        type: 'assistant', parent_tool_use_id: null, session_id: sid, uuid: uuid(),
        message: {
          id: msgQ, type: 'message', role: 'assistant', model: 'rehearsal', stop_reason: 'tool_use', usage: zeroUsage(),
          content: [{ type: 'tool_use', id: questionId, name: 'AskUserQuestion', input: { questions: [REHEARSAL_QUESTION] } }]
        }
      });
      script.push({
        type: 'user', parent_tool_use_id: null, session_id: sid, uuid: uuid(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: questionId, content: 'no answer', is_error: false }] }
      });
    }

    script.push({
      type: 'assistant', parent_tool_use_id: null, session_id: sid, uuid: uuid(),
      message: {
        id: msg2, type: 'message', role: 'assistant', model: 'rehearsal', stop_reason: 'tool_use', usage: zeroUsage(),
        content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'echo "rehearsal: ' + head + '"', description: 'rehearsal step' } }]
      }
    });
    script.push({
      type: 'user', parent_tool_use_id: null, session_id: sid, uuid: uuid(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'rehearsal — nothing was executed', is_error: false }] }
    });
    script.push({
      type: 'assistant', parent_tool_use_id: null, session_id: sid, uuid: uuid(),
      message: { id: msg3, type: 'message', role: 'assistant', model: 'rehearsal', content: [{ type: 'text', text: REHEARSAL_CLOSING }], stop_reason: 'end_turn', usage: zeroUsage() }
    });
    script.push({
      type: 'result', subtype: 'success', is_error: false, result: REHEARSAL_CLOSING, num_turns: asks ? 3 : 2, total_cost_usd: 0,
      duration_ms: 1200, duration_api_ms: 0, usage: zeroUsage(), permission_denials: [], errors: [], stop_reason: 'end_turn',
      session_id: sid, uuid: uuid()
    });
    return script;
  }

  /* ====================================================================
   * 14. Misc — auth token, list-view summaries, the status chip
   * ==================================================================== */

  // Bearer header wins over ?key=. `query` may be a query string, a URL, or a parsed object.
  function pickToken(o) {
    o = o || {};
    var m = /^\s*bearer\s+(\S+)\s*$/i.exec(String(o.authorization || ''));
    if (m) return m[1];
    var q = o.query;
    if (q && typeof q === 'object') return q.key ? String(q.key) : null;
    var qs = String(q == null ? '' : q);
    if (qs.indexOf('?') >= 0) qs = qs.slice(qs.indexOf('?') + 1);
    var mm = /(?:^|&)key=([^&#]*)/.exec(qs.replace(/^&/, ''));
    if (mm && mm[1]) { try { return decodeURIComponent(mm[1]); } catch (e) { return mm[1]; } }
    return null;
  }

  function runSummary(events) {
    var s = { tools: 0, cost: 0, turns: 0, status: 'idle' };
    (Array.isArray(events) ? events : []).forEach(function (e) {
      if (!e) return;
      if (e.t === 'tool') s.tools++;
      else if (e.t === 'result') { s.cost = Number(e.cost) || 0; s.turns = Number(e.turns) || 0; }
      else if (e.t === 'run_start') s.status = 'running';
      else if (e.t === 'run_end') s.status = e.status || 'done';
    });
    return s;
  }

  function statusChip(o) {
    o = o || {};
    if (o.live) return 'live · ' + String(o.model || DEFAULT_MODEL);
    if (o.driver === 'rehearsal') return 'rehearsal';
    if (o.driver === 'live') return 'live · ' + String(o.model || DEFAULT_MODEL);
    return 'offline';
  }

  /* ====================================================================
   * exports
   * ==================================================================== */

  var api = {
    VERSION: VERSION,
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    MODELS: MODELS, DEFAULT_MODEL: DEFAULT_MODEL,
    MODES: MODES, DEFAULT_MODE: DEFAULT_MODE, MODE_INFO: MODE_INFO,
    EFFORTS: EFFORTS, DEFAULT_EFFORT: DEFAULT_EFFORT, DEFAULT_LIMITS: DEFAULT_LIMITS,
    RISK_LEVELS: RISK_LEVELS, MEMORY_MAX: MEMORY_MAX, PROMPT_MAX: PROMPT_MAX, OUTPUT_MAX: OUTPUT_MAX,
    GENIE_TOOLS: GENIE_TOOLS, COMMANDS: COMMANDS,
    // text
    sanitize: sanitize, escapeHTML: escapeHTML, renderMarkdown: renderMarkdown,
    summarizeInput: summarizeInput, toolIcon: toolIcon, truncate: truncate,
    formatUsd: formatUsd, formatDuration: formatDuration, relTime: relTime,
    // hashing
    hashStr: hashStr, rand01: rand01, shortId: shortId,
    // commands
    parseCommand: parseCommand, helpText: helpText,
    // schedules
    parseSchedule: parseSchedule, describeSchedule: describeSchedule, nextRun: nextRun, nextFrom: nextFrom,
    parseCron: parseCron, cronMatches: cronMatches, newSchedule: newSchedule, afterRun: afterRun,
    dueSchedules: dueSchedules, validateTask: validateTask,
    // policy
    classifyTool: classifyTool, dangerousCommand: dangerousCommand, DANGER_RULES: DANGER_RULES,
    ruleKey: ruleKey, ruleFromKey: ruleFromKey, findRule: findRule, addRule: addRule, removeRule: removeRule, validRule: validRule,
    decide: decide, sdkPermissionMode: sdkPermissionMode, askTitle: askTitle, isGenieTool: isGenieTool,
    // reducer
    initRun: initRun, reduce: reduce, transcriptEvent: transcriptEvent, foldTranscript: foldTranscript, clipOutput: clipOutput,
    // cost
    priceFor: priceFor, costOf: costOf,
    // memory
    memoryParse: memoryParse, memoryAdd: memoryAdd, memoryForget: memoryForget, memoryForPrompt: memoryForPrompt,
    // system prompt
    buildSystemAppend: buildSystemAppend, isoLocal: isoLocal,
    // conversations & validation
    isConversationId: isConversationId, isScheduleId: isScheduleId, isRunId: isRunId, isRequestId: isRequestId,
    newConversation: newConversation, titleFrom: titleFrom, validatePrompt: validatePrompt, validateCwd: validateCwd,
    validateModel: validateModel, validateMode: validateMode, validateEffort: validateEffort,
    applySettings: applySettings, defaultSettings: defaultSettings,
    // custom commands
    parseCommandFile: parseCommandFile, expandCommand: expandCommand,
    // rehearsal
    rehearsalScript: rehearsalScript,
    // misc
    pickToken: pickToken, runSummary: runSummary, statusChip: statusChip
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GenieEngine = api;
})(typeof self !== 'undefined' ? self : this);
