/**
 * AIOS — the AI Operating System kernel
 * =====================================
 *
 * The deterministic core of AIOS, an operating system that boots in the
 * browser and whose shell speaks both bash *and* English. Everything the
 * desktop does — every file created, window opened, command executed and
 * assistant request understood — passes through the pure functions in this
 * file. Nothing here touches the DOM, the clock or the network: the current
 * time is always passed in, so the same calls always produce the same OS
 * state, and every subsystem is unit-tested (scripts/test-aios-logic.mjs).
 *
 * The subsystems
 * --------------
 *   VFS       a hierarchical virtual file system — directories, files,
 *             timestamps, path resolution with `.` and `..`, move/copy with
 *             cycle protection, search, and a real TRASH: `rm` moves to
 *             /trash with the origin remembered, so `restore` can undo it.
 *   Processes a window manager's brain: spawn/focus/minimize/close with a
 *             z-order stack, maximize and left/right snap states, singleton-
 *             per-app rules (Notes is per-file), deterministic cascade
 *             placement — across THREE virtual workspaces.
 *   Shell     a real tokenizer (quotes, redirection, PIPES) and a coreutils-
 *             style command set: ls, cd, cat, echo, mkdir -p, rm, mv, cp,
 *             find, tree, ps, kill, open — composable through `|` with
 *             grep/head/tail/wc/sort/uniq filters, and `>` / `>>`
 *             redirection on ANY pipeline, not just echo.
 *   Automations  the OS runs itself: `every 30m <command>` schedules any
 *             shell command on an interval — and because `ai` is a shell
 *             command, plain English can be scheduled too. Due-ness is a
 *             pure function of (state, now).
 *   Intent    the AI layer that works with no network and no key: a
 *   router    rule-based natural-language router ("open notes", "what's
 *             18% of 240", "convert 5 km to miles", "90 days from now",
 *             "set a timer for 5 minutes", "note that …", compound
 *             "…then…" chains) with a from-scratch arithmetic parser — no
 *             eval(), ever. The desktop's optional Live AI mode swaps in a
 *             real model behind the same action vocabulary, so the OS
 *             treats both identically.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AiosKernel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '5.0.0';
  var JOURNAL_CAP = 300;
  var RUN_DEPTH_CAP = 8;
  var SCRIPT_STEP_CAP = 100000; // total statements one `run` may execute — kills infinite loops
  var DESKTOP = '/home/user/Desktop';
  var APPS_DIR = '/apps';
  var WS_COUNT = 3;
  var TRASH = '/trash';

  /* ══════════════════════════ App registry ══════════════════════════ */

  var APPS = [
    { id: 'files',       name: 'Files',       emoji: '🗂️', desc: 'Browse the virtual file system' },
    { id: 'terminal',    name: 'Terminal',    emoji: '⌨️', desc: 'The AIOS shell — pipes and all' },
    { id: 'notes',       name: 'Notes',       emoji: '📝', desc: 'Edit text files' },
    { id: 'assistant',   name: 'Assistant',   emoji: '✦',  desc: 'Talk to the OS in plain English' },
    { id: 'calc',        name: 'Calculator',  emoji: '🧮', desc: 'A real calculator — no eval, ever' },
    { id: 'automations', name: 'Automations', emoji: '🤖', desc: 'Schedule the OS to run itself' },
    { id: 'paint',       name: 'Paint',       emoji: '🎨', desc: 'Draw on a canvas, save to the disk' },
    { id: 'camera',      name: 'Camera',      emoji: '📷', desc: 'Take a photo (your device camera)' },
    { id: 'arcade',      name: 'Arcade',      emoji: '🕹️', desc: 'Play the Ballrz games inside AIOS' },
    { id: 'store',       name: 'App Store',   emoji: '🛍️', desc: 'Install & manage apps' },
    { id: 'monitor',     name: 'Monitor',     emoji: '📊', desc: 'Processes and system state' },
    { id: 'settings',    name: 'Settings',    emoji: '⚙️', desc: 'Personalise AIOS' },
    { id: 'about',       name: 'About',       emoji: '🛈',  desc: 'About this OS' }
  ];
  // Spoken names the intent router also accepts, per app.
  var APP_SYNONYMS = {
    files: ['files', 'file manager', 'finder', 'explorer', 'file system', 'trash'],
    terminal: ['terminal', 'shell', 'console', 'command line', 'cli'],
    notes: ['notes', 'note', 'notepad', 'editor', 'text editor'],
    assistant: ['assistant', 'ai', 'chat', 'help me'],
    calc: ['calculator', 'calc'],
    automations: ['automations', 'automation', 'scheduler', 'cron', 'robots'],
    paint: ['paint', 'draw', 'drawing', 'canvas', 'sketch'],
    camera: ['camera', 'photo', 'selfie', 'webcam'],
    arcade: ['arcade', 'games', 'play', 'game'],
    store: ['app store', 'store', 'apps', 'marketplace'],
    monitor: ['monitor', 'system monitor', 'task manager', 'activity monitor', 'processes'],
    settings: ['settings', 'preferences', 'options', 'config'],
    about: ['about', 'info', 'credits']
  };
  function appById(id) {
    for (var i = 0; i < APPS.length; i++) if (APPS[i].id === id) return APPS[i];
    return null;
  }

  /* ══════════════════════════ VFS ══════════════════════════ */

  function dirNode(now) { return { type: 'dir', mtime: now, children: {} }; }
  function fileNode(content, now) { return { type: 'file', mtime: now, content: String(content) }; }

  /** Resolve `p` against `cwd` into a canonical absolute path ('/a/b'). */
  function normalizePath(cwd, p) {
    p = String(p == null ? '' : p).trim();
    if (!p) return cwd || '/';
    if (p === '~') p = '/home/user';
    else if (p.slice(0, 2) === '~/') p = '/home/user/' + p.slice(2);
    var base = p[0] === '/' ? [] : String(cwd || '/').split('/').filter(Boolean);
    var parts = p.split('/').filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === '.') continue;
      if (seg === '..') { base.pop(); continue; } // '..' at root stays at root
      base.push(seg);
    }
    return '/' + base.join('/');
  }

  function splitPath(abs) {
    var parts = abs.split('/').filter(Boolean);
    var name = parts.pop() || '';
    return { parent: '/' + parts.join('/'), name: name };
  }

  function fsGet(fs, path) {
    var parts = path.split('/').filter(Boolean);
    var node = fs.root;
    for (var i = 0; i < parts.length; i++) {
      if (!node || node.type !== 'dir') return null;
      node = node.children[parts[i]];
    }
    return node || null;
  }

  function badName(name) {
    return !name || name === '.' || name === '..' || name.indexOf('/') !== -1;
  }

  function fsMkdir(fs, path, now, opts) {
    opts = opts || {};
    var parts = path.split('/').filter(Boolean);
    if (!parts.length) return { ok: false, error: 'cannot create /' };
    var node = fs.root;
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i], last = i === parts.length - 1;
      if (badName(name)) return { ok: false, error: 'bad name: ' + name };
      var child = node.children[name];
      if (!child) {
        if (!last && !opts.parents) return { ok: false, error: 'no such directory: ' + name };
        child = node.children[name] = dirNode(now);
        node.mtime = now;
      } else if (child.type !== 'dir') {
        return { ok: false, error: 'not a directory: ' + name };
      } else if (last && !opts.parents) {
        return { ok: false, error: 'already exists: ' + path };
      }
      node = child;
    }
    return { ok: true };
  }

  function fsWrite(fs, path, content, now, opts) {
    opts = opts || {};
    var sp = splitPath(path);
    if (badName(sp.name)) return { ok: false, error: 'bad file name' };
    var parent = fsGet(fs, sp.parent);
    if (!parent || parent.type !== 'dir') return { ok: false, error: 'no such directory: ' + sp.parent };
    var existing = parent.children[sp.name];
    if (existing && existing.type === 'dir') return { ok: false, error: 'is a directory: ' + path };
    if (existing && opts.append) existing.content += String(content);
    else parent.children[sp.name] = fileNode(existing && opts.append ? existing.content : content, now);
    parent.children[sp.name].mtime = now;
    parent.mtime = now;
    return { ok: true };
  }

  function fsRead(fs, path) {
    var node = fsGet(fs, path);
    if (!node) return { ok: false, error: 'no such file: ' + path };
    if (node.type !== 'file') return { ok: false, error: 'is a directory: ' + path };
    return { ok: true, content: node.content };
  }

  /** PERMANENT removal — the shell's `rm` goes through fsTrash instead. */
  function fsRemove(fs, path, opts) {
    opts = opts || {};
    if (path === '/') return { ok: false, error: 'cannot remove /' };
    var sp = splitPath(path);
    var parent = fsGet(fs, sp.parent);
    if (!parent || parent.type !== 'dir' || !parent.children[sp.name]) return { ok: false, error: 'no such file or directory: ' + path };
    var node = parent.children[sp.name];
    if (node.type === 'dir' && Object.keys(node.children).length && !opts.recursive) {
      return { ok: false, error: 'directory not empty: ' + path + ' (use rm -r)' };
    }
    delete parent.children[sp.name];
    if (fs.trash && (path + '/').indexOf(TRASH + '/') === 0) {
      // purged straight out of the trash — forget its origin record
      var tn = path.slice(TRASH.length + 1).split('/')[0];
      if (path === TRASH + '/' + tn) delete fs.trash[tn];
    }
    return { ok: true };
  }

  function cloneNode(node) { return JSON.parse(JSON.stringify(node)); }

  /** mv/cp share destination logic: an existing dir target means "into it". */
  function resolveDest(fs, from, to) {
    var destNode = fsGet(fs, to);
    if (destNode && destNode.type === 'dir') to = normalizePath(to, splitPath(from).name);
    return to;
  }

  function fsMove(fs, from, to, now) {
    if (from === '/') return { ok: false, error: 'cannot move /' };
    var node = fsGet(fs, from);
    if (!node) return { ok: false, error: 'no such file or directory: ' + from };
    to = resolveDest(fs, from, to);
    if (to === from) return { ok: true };
    if (node.type === 'dir' && (to + '/').indexOf(from + '/') === 0) {
      return { ok: false, error: 'cannot move a directory into itself' };
    }
    var w = placeNode(fs, to, node, now);
    if (!w.ok) return w;
    fsRemove(fs, from, { recursive: true });
    return { ok: true, to: to };
  }

  function fsCopy(fs, from, to, now) {
    var node = fsGet(fs, from);
    if (!node) return { ok: false, error: 'no such file or directory: ' + from };
    to = resolveDest(fs, from, to);
    if (to === from) return { ok: false, error: 'source and destination are the same' };
    if (node.type === 'dir' && (to + '/').indexOf(from + '/') === 0) {
      return { ok: false, error: 'cannot copy a directory into itself' };
    }
    return placeNode(fs, to, cloneNode(node), now);
  }

  function placeNode(fs, path, node, now) {
    var sp = splitPath(path);
    if (badName(sp.name)) return { ok: false, error: 'bad name' };
    var parent = fsGet(fs, sp.parent);
    if (!parent || parent.type !== 'dir') return { ok: false, error: 'no such directory: ' + sp.parent };
    var existing = parent.children[sp.name];
    if (existing && existing.type === 'dir') return { ok: false, error: 'destination exists: ' + path };
    node.mtime = now;
    parent.children[sp.name] = node;
    parent.mtime = now;
    return { ok: true };
  }

  /* ---- trash: rm you can undo ---- */

  /** Move a path into /trash, remembering where it came from. Anything
   *  already inside /trash is out of scope — callers purge with fsRemove. */
  function fsTrash(fs, path, now) {
    if (path === '/' || path === TRASH) return { ok: false, error: 'cannot trash ' + path };
    if ((path + '/').indexOf(TRASH + '/') === 0) return { ok: false, error: 'already in the trash' };
    var node = fsGet(fs, path);
    if (!node) return { ok: false, error: 'no such file or directory: ' + path };
    if (!fsGet(fs, TRASH)) fsMkdir(fs, TRASH, now);
    if (!fs.trash) fs.trash = {};
    var base = splitPath(path).name, name = base, n = 2;
    while (fsGet(fs, TRASH + '/' + name)) name = base + '-' + (n++);
    var mv = fsMove(fs, path, TRASH + '/' + name, now);
    if (!mv.ok) return mv;
    fs.trash[name] = path;
    return { ok: true, name: name, origin: path };
  }

  /** Put a trashed entry back where it was (recreating parents if needed). */
  function fsRestore(fs, name, now) {
    if (!fs.trash || !fs.trash[name] || !fsGet(fs, TRASH + '/' + name)) {
      return { ok: false, error: 'nothing in the trash called: ' + name };
    }
    var origin = fs.trash[name];
    if (fsGet(fs, origin)) return { ok: false, error: 'cannot restore — ' + origin + ' exists again' };
    fsMkdir(fs, splitPath(origin).parent, now, { parents: true });
    var mv = fsMove(fs, TRASH + '/' + name, origin, now);
    if (!mv.ok) return mv;
    delete fs.trash[name];
    return { ok: true, origin: origin };
  }

  function fsEmptyTrash(fs, now) {
    var t = fsGet(fs, TRASH), count = 0;
    if (t) { count = Object.keys(t.children).length; t.children = {}; t.mtime = now; }
    fs.trash = {};
    return { ok: true, count: count };
  }

  function nodeSize(node) {
    if (node.type === 'file') return node.content.length;
    var n = 0;
    for (var k in node.children) n += nodeSize(node.children[k]);
    return n;
  }

  /** Directory listing: dirs first, then files, each alphabetical. */
  function fsList(fs, path) {
    var node = fsGet(fs, path);
    if (!node) return { ok: false, error: 'no such directory: ' + path };
    if (node.type !== 'dir') return { ok: false, error: 'not a directory: ' + path };
    var out = [];
    for (var name in node.children) {
      var c = node.children[name];
      out.push({ name: name, type: c.type, size: nodeSize(c), mtime: c.mtime });
    }
    out.sort(function (a, b) {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return { ok: true, entries: out };
  }

  /** Case-insensitive name search over the whole tree; returns sorted paths. */
  function fsFind(fs, query) {
    var q = String(query || '').toLowerCase();
    var hits = [];
    (function walk(node, path) {
      for (var name in node.children) {
        var child = node.children[name];
        var p = path + '/' + name;
        if (name.toLowerCase().indexOf(q) !== -1) hits.push(p + (child.type === 'dir' ? '/' : ''));
        if (child.type === 'dir') walk(child, p);
      }
    })(fs.root, '');
    return hits.sort();
  }

  /** Full-text search: case-insensitive substring over every FILE's content.
   *  Returns [{path, line, text}] sorted by path then line, capped at 200. */
  function fsGrep(fs, query) {
    var q = String(query || '').toLowerCase();
    var hits = [];
    (function walk(node, path) {
      for (var name in node.children) {
        var child = node.children[name];
        var p = path + '/' + name;
        if (child.type === 'dir') { walk(child, p); continue; }
        var ls = child.content.split('\n');
        for (var i = 0; i < ls.length && hits.length < 200; i++) {
          if (ls[i].toLowerCase().indexOf(q) !== -1) hits.push({ path: p, line: i + 1, text: ls[i].trim().slice(0, 120) });
        }
      }
    })(fs.root, '');
    return hits.sort(function (a, b) {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.line - b.line;
    });
  }

  /** ASCII tree of a directory, dirs first — the shell's `tree`. */
  function fsTree(fs, path) {
    var node = fsGet(fs, path);
    if (!node) return { ok: false, error: 'no such directory: ' + path };
    if (node.type !== 'dir') return { ok: false, error: 'not a directory: ' + path };
    var lines = [path === '/' ? '/' : splitPath(path).name + '/'];
    (function walk(n, prefix) {
      var names = Object.keys(n.children).sort(function (a, b) {
        var ta = n.children[a].type, tb = n.children[b].type;
        if (ta !== tb) return ta === 'dir' ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (var i = 0; i < names.length; i++) {
        var last = i === names.length - 1;
        var child = n.children[names[i]];
        lines.push(prefix + (last ? '└─ ' : '├─ ') + names[i] + (child.type === 'dir' ? '/' : ''));
        if (child.type === 'dir') walk(child, prefix + (last ? '   ' : '│  '));
      }
    })(node, '');
    return { ok: true, lines: lines };
  }

  /* ══════════════════════════ Boot & persistence ══════════════════════════ */

  var WELCOME =
    'Welcome to AIOS — the AI operating system.\n' +
    '\n' +
    'Everything here runs on your device: the file system, the window\n' +
    'manager, the shell and the assistant are all part of one small,\n' +
    'deterministic kernel.\n' +
    '\n' +
    'Things to try:\n' +
    '  • Open the Terminal and type `help`. Pipes work: ls | grep txt\n' +
    '  • Ask the Assistant to "set a timer for 2 minutes",\n' +
    '    "convert 5 km to miles", or "note that AIOS is alive".\n' +
    '  • `rm` is safe here — deleted files go to /trash, `restore` undoes.\n' +
    '  • Schedule the OS: every 30m ai note that stretch your legs\n' +
    '  • Write a SCRIPT: any text file of commands, then `run backup.sh`.\n' +
    '    Variables ($NAME via `set`), aliases and a `journal` included.\n' +
    '  • Press Ctrl/Cmd-K anywhere and just say what you want.\n';

  var GETTING_STARTED =
    '# Welcome to AIOS ✦\n' +
    '\n' +
    'This file lives on your **Desktop** — drag its icon anywhere,\n' +
    'right-click it (or the wallpaper) for a menu, and press the\n' +
    '👁 button below to see this note rendered.\n' +
    '\n' +
    '## Point and click\n' +
    '- **✦ menu** (top-left) — every app, one click\n' +
    '- **Right-click the desktop** — new files and folders right here\n' +
    '- **Drag icons** — the OS remembers where you put them\n' +
    '- Deleting is safe: everything goes to the 🗑 **trash**, restorable\n' +
    '\n' +
    '## Or just say it\n' +
    'Press `Ctrl/Cmd-K` and type — or tap 🎙 and speak:\n' +
    '- *"set a timer for 5 minutes"*\n' +
    '- *"convert 5 km to miles"*\n' +
    '- *"note that the demo is on Friday"*\n' +
    '\n' +
    '## Or program it\n' +
    'The Terminal is a real shell — pipes, variables, aliases,\n' +
    'and executable scripts (`run build.sh`). Type `help` there.\n';

  function createFS(now) {
    var fs = { root: dirNode(now), trash: {} };
    fsMkdir(fs, '/home/user/notes', now, { parents: true });
    fsMkdir(fs, '/home/user/projects', now, { parents: true });
    fsMkdir(fs, DESKTOP, now, { parents: true });
    fsMkdir(fs, '/etc', now);
    fsMkdir(fs, TRASH, now);
    fsMkdir(fs, APPS_DIR, now);
    fsWrite(fs, '/home/user/notes/welcome.txt', WELCOME, now);
    fsWrite(fs, DESKTOP + '/Getting started.md', GETTING_STARTED, now);
    fsWrite(fs, '/etc/motd', 'AIOS ' + VERSION + ' — the OS that listens.', now);
    // Two apps ship pre-installed — proof the SDK is real: each is just a
    // JSON manifest whose buttons run AIOS shell commands.
    fsWrite(fs, APPS_DIR + '/tip.app', JSON.stringify({
      name: 'Tip Calculator', emoji: '💸', desc: 'Split a bill with tip — built from shell commands.',
      ui: [
        { type: 'label', text: 'Split a bill, with tip.' },
        { type: 'number', name: 'bill', placeholder: 'Bill amount' },
        { type: 'number', name: 'pct', placeholder: 'Tip % (e.g. 15)', value: '15' },
        { type: 'number', name: 'people', placeholder: 'Split between', value: '2' },
        { type: 'button', text: 'Calculate', run: 'echo "Each pays $(( ($bill + $bill * $pct / 100) / $people ))"' },
        { type: 'output' }
      ]
    }, null, 2), now);
    fsWrite(fs, APPS_DIR + '/dice.app', JSON.stringify({
      name: 'Dice', emoji: '🎲', desc: 'Roll a die — writes the roll to a note.',
      ui: [
        { type: 'label', text: 'Roll a six-sided die. Each roll is journaled.' },
        { type: 'button', text: 'Roll 🎲', run: 'echo "You rolled a $(( 1 + 3 ))!"' },
        { type: 'output' }
      ]
    }, null, 2), now);
    return fs;
  }

  var ACCENTS = ['violet', 'teal', 'blue', 'rose', 'amber'];

  function boot(now) {
    return {
      fs: createFS(now),
      cwd: '/home/user',
      procs: [],
      nextPid: 1,
      zTop: 0,
      ws: 1,
      automations: [],
      nextAutoId: 1,
      env: {},
      aliases: {},
      journal: [],
      desktop: {},
      installed: [],
      widgets: ['clock', 'notes'],
      notices: [],
      settings: { owner: 'user', accent: 'violet' },
      bootedAt: now
    };
  }

  /* ══════════════════════════ Notification Centre ══════════════════════════
   * Every notification the OS shows is also a durable record on the state —
   * a ring buffer with unread tracking, so the shade/bell can show history
   * across reboots (like a phone's notification centre, but serialized and
   * unit-tested like everything else here). */
  var NOTICE_CAP = 100;

  function pushNotice(state, title, body, now) {
    if (!title && !body) return null;
    var n = { t: now, title: String(title || '').slice(0, 60), body: String(body || '').slice(0, 200), read: false };
    state.notices.push(n);
    if (state.notices.length > NOTICE_CAP) state.notices.splice(0, state.notices.length - NOTICE_CAP);
    return n;
  }
  function unreadNotices(state) {
    var c = 0;
    for (var i = 0; i < state.notices.length; i++) if (!state.notices[i].read) c++;
    return c;
  }
  function markNoticesRead(state) {
    for (var i = 0; i < state.notices.length; i++) state.notices[i].read = true;
  }
  function clearNotices(state) { state.notices = []; }

  /** Append to the system journal (ring buffer, JOURNAL_CAP entries). */
  function logJournal(state, kind, text, now) {
    if (!text) return;
    state.journal.push({ t: now, k: String(kind).slice(0, 8), x: String(text).slice(0, 200) });
    if (state.journal.length > JOURNAL_CAP) state.journal.splice(0, state.journal.length - JOURNAL_CAP);
  }

  /** Persist what is durable: the disk, settings and automations. Windows
   *  are runtime state — a reboot starts with a clean desktop, like a real OS. */
  function serialize(state) {
    return JSON.stringify({
      v: 4,
      fs: state.fs,
      cwd: state.cwd,
      settings: state.settings,
      automations: state.automations,
      nextAutoId: state.nextAutoId,
      env: state.env,
      aliases: state.aliases,
      journal: state.journal,
      desktop: state.desktop,
      installed: state.installed,
      widgets: state.widgets,
      notices: state.notices
    });
  }

  function deserialize(json, now) {
    var state = boot(now);
    try {
      var data = JSON.parse(json);
      if (!data || !(data.v >= 1 && data.v <= 4) || !data.fs || !data.fs.root || data.fs.root.type !== 'dir') return state;
      state.fs = data.fs;
      if (!state.fs.trash || typeof state.fs.trash !== 'object') state.fs.trash = {};
      if (!fsGet(state.fs, TRASH)) fsMkdir(state.fs, TRASH, now); // v1 disks predate the trash
      if (!fsGet(state.fs, DESKTOP)) fsMkdir(state.fs, DESKTOP, now, { parents: true }); // pre-GUI disks predate the Desktop
      if (!fsGet(state.fs, APPS_DIR)) fsMkdir(state.fs, APPS_DIR, now); // pre-4.0 disks predate /apps
      if (typeof data.cwd === 'string' && fsGet(state.fs, data.cwd)) state.cwd = data.cwd;
      if (data.settings && typeof data.settings === 'object') {
        if (typeof data.settings.owner === 'string' && data.settings.owner) state.settings.owner = data.settings.owner.slice(0, 24);
        if (ACCENTS.indexOf(data.settings.accent) !== -1) state.settings.accent = data.settings.accent;
      }
      if (Array.isArray(data.automations)) {
        for (var i = 0; i < data.automations.length; i++) {
          var a = data.automations[i];
          if (a && typeof a.command === 'string' && typeof a.everySeconds === 'number' && a.everySeconds >= 60) {
            state.automations.push({
              id: typeof a.id === 'number' ? a.id : state.nextAutoId,
              command: a.command.slice(0, 400),
              everySeconds: Math.round(a.everySeconds),
              lastRun: typeof a.lastRun === 'number' ? a.lastRun : now,
              enabled: a.enabled !== false
            });
          }
        }
        state.nextAutoId = Math.max.apply(null, [1].concat(state.automations.map(function (a) { return a.id + 1; })));
        if (typeof data.nextAutoId === 'number' && data.nextAutoId > state.nextAutoId) state.nextAutoId = data.nextAutoId;
      }
      var k;
      if (data.env && typeof data.env === 'object') {
        for (k in data.env) {
          if (/^[A-Za-z_]\w*$/.test(k) && typeof data.env[k] === 'string') state.env[k] = data.env[k].slice(0, 400);
        }
      }
      if (data.aliases && typeof data.aliases === 'object') {
        for (k in data.aliases) {
          if (/^[A-Za-z_][\w-]*$/.test(k) && typeof data.aliases[k] === 'string') state.aliases[k] = data.aliases[k].slice(0, 400);
        }
      }
      if (Array.isArray(data.journal)) {
        for (var j = 0; j < data.journal.length && state.journal.length < JOURNAL_CAP; j++) {
          var e2 = data.journal[j];
          if (e2 && typeof e2.t === 'number' && typeof e2.k === 'string' && typeof e2.x === 'string') {
            state.journal.push({ t: e2.t, k: e2.k.slice(0, 8), x: e2.x.slice(0, 200) });
          }
        }
      }
      if (data.desktop && typeof data.desktop === 'object') {
        for (k in data.desktop) {
          var pos = data.desktop[k];
          if (pos && isFinite(pos.x) && isFinite(pos.y)) setIconPos(state, k, pos.x, pos.y);
        }
      }
      if (Array.isArray(data.installed)) {
        for (var ii = 0; ii < data.installed.length; ii++) installWebapp(state, data.installed[ii]);
      }
      if (Array.isArray(data.widgets)) {
        state.widgets = [];
        for (var wi = 0; wi < data.widgets.length; wi++) addWidget(state, data.widgets[wi]);
      }
      if (Array.isArray(data.notices)) {
        for (var ni = 0; ni < data.notices.length && state.notices.length < NOTICE_CAP; ni++) {
          var nn = data.notices[ni];
          if (nn && typeof nn.t === 'number' && (typeof nn.title === 'string' || typeof nn.body === 'string')) {
            state.notices.push({ t: nn.t, title: String(nn.title || '').slice(0, 60),
              body: String(nn.body || '').slice(0, 200), read: nn.read === true });
          }
        }
      }
    } catch (e) { /* corrupt snapshot → fresh boot */ }
    return state;
  }

  /* ══════════════════════════ Ballrz catalog ══════════════════════════
   * Every app in the Ballrz repo, launchable from inside AIOS: the App Store
   * lists them and each opens as a `webapp` window/sheet hosting the real
   * app in a sandboxed frame. URLs are relative to /aios/ so they resolve on
   * the published site, the custom domain and a local checkout alike.
   * NOTE: '../apex/' and '../llm/' exist only on the published site — the
   * pages workflow builds rentmatch → /apex/ and llm-from-scratch → /llm/
   * (see .github/workflows/pages.yml); the integrity test knows the aliases.
   * `cat` groups apps into App Store shelves (see BALLRZ_CATEGORIES). */

  var BALLRZ_APPS = [
    { id: 'apexvip',    name: 'ApexVIP',        emoji: '✨', cat: 'apexvip', url: '../apexvip/',            desc: 'The cinematic luxury chauffeur site.' },
    { id: 'client',     name: 'ApexVIP Client', emoji: '🚘', cat: 'apexvip', url: '../apexvip-client.html', desc: 'Book a chauffeur, track your driver live.' },
    { id: 'driver',     name: 'ApexVIP Driver', emoji: '🛞', cat: 'apexvip', url: '../apexvip-driver.html', desc: 'Accept & manage jobs, live GPS, earnings.' },
    { id: 'ops',        name: 'ApexVIP Ops',    emoji: '🎛️', cat: 'apexvip', url: '../apexvip-admin.html',  desc: 'Dispatch, fleet, analytics & payouts.' },
    { id: 'concierge',  name: 'Concierge',      emoji: '🛎️', cat: 'apexvip', url: '../concierge/',          desc: 'One membership, everything handled.' },
    { id: 'founding',   name: 'Founding',       emoji: '🎟️', cat: 'apexvip', url: '../apexvip-join/',       desc: 'Founding memberships — join ApexVIP.' },
    { id: 'drivewithus', name: 'Drive with us', emoji: '🤝', cat: 'apexvip', url: '../drivers/',            desc: 'Recruiting — keep 80% of every fare.' },
    { id: 'fixr',       name: 'Fixr',           emoji: '🚙', cat: 'apexvip', url: '../fixr/',               desc: 'Luxury transport + concierge — the static demo.' },
    { id: 'ballrz',     name: 'Ballrz',         emoji: '⚽', cat: 'games',   url: '../ballrz/',             desc: 'Football, all of it — a full career mode plus real live scores.' },
    { id: 'console',    name: 'Console',        emoji: '👾', cat: 'games',   url: '../arcade/',             desc: 'A pocket console — Serpent, 2048 and Breaker, plus emulator slots.' },
    { id: 'ultra',      name: 'Ultra',          emoji: '🎮', cat: 'games',   url: '../ultra/',              desc: 'N64 & Dreamcast emulation — real CPU interpreters in the browser.' },
    { id: 'volley',     name: 'Volley',         emoji: '🏐', cat: 'games',   url: '../volley/',             desc: 'Reflex training in two-minute bursts — drills, ranks, bests.' },
    { id: 'imposter',   name: 'Imposter',       emoji: '🕵️', cat: 'games',   url: '../imposter/',           desc: 'Pass-and-play social deduction.' },
    { id: 'flow',       name: 'Flow',           emoji: '🌊', cat: 'games',   url: '../concepts/prototypes/flow-game/', desc: 'Adaptive tap arcade.' },
    { id: 'cortex',     name: 'Cortex',         emoji: '🧩', cat: 'games',   url: '../cortex/',             desc: 'The daily brain gym — five adaptive drills.' },
    { id: 'automaton',  name: 'Automaton',      emoji: '🤖', cat: 'ai',      url: '../automaton/',          desc: 'The AI that dies if it doesn’t earn.' },
    { id: 'myownai',    name: 'ApexAI',         emoji: '⚡', cat: 'ai',      url: '../llm/',                desc: 'A GPT built from first principles, on-device.' },
    { id: 'sonar',      name: 'Sonar',          emoji: '📡', cat: 'ai',      url: '../sonar/',              desc: 'AI web search — every fact pinned to a numbered source.' },
    { id: 'tokens',     name: 'Tokens',         emoji: '🧮', cat: 'ai',      url: '../tokens/',             desc: 'The AI token meter — count a prompt, price it, budget it.' },
    { id: 'axon',       name: 'Axon',           emoji: '🕸️', cat: 'ai',      url: '../axon/',               desc: 'Train your own neural network — watch every synapse learn.' },
    { id: 'synapse',    name: 'Synapse',        emoji: '🧬', cat: 'ai',      url: '../synapse/',            desc: 'The AI cryptocurrency — asking is a transaction, answering is mining.' },
    { id: 'vault',      name: 'Vault',          emoji: '🏦', cat: 'money',   url: '../vault/',              desc: 'A full digital bank with a crypto desk.' },
    { id: 'drip',       name: 'Drip',           emoji: '💧', cat: 'money',   url: '../drip/',               desc: 'The passive income engine.' },
    { id: 'graft',      name: 'Graft',          emoji: '⚒️', cat: 'money',   url: '../graft/',              desc: 'The income engine — hustle, plan, invoice.' },
    { id: 'timecoin',   name: 'TimeCoin',       emoji: '🪙', cat: 'money',   url: '../coin/',               desc: 'A Bitcoin built from raw bytes — mine in-browser.' },
    { id: 'neura',      name: 'Neura',          emoji: '🧠', cat: 'money',   url: '../neura/',              desc: 'The chain that thinks — Proof of Intelligence.' },
    { id: 'fxsignal',   name: 'FX Signal Pro',  emoji: '📈', cat: 'money',   url: '../trading-app/fx-signal-pro.html', desc: 'Currency-pair trading signals.' },
    { id: 'charter',    name: 'Charter',        emoji: '📜', cat: 'money',   url: '../charter/',            desc: 'Mint preferred stock — term sheet, certificate, cap table.' },
    { id: 'apex',       name: 'Apex',           emoji: '🏘️', cat: 'money',   url: '../apex/',               desc: 'The UK landlord OS.' },
    { id: 'apexsite',   name: 'Apex Site',      emoji: '🏠', cat: 'money',   url: '../apex-site/',          desc: 'The landlord OS marketing site.' },
    { id: 'voyager',    name: 'Voyager',        emoji: '🧭', cat: 'web',     url: '../voyager/',            desc: 'The internet browser — tabs, omnibox, memory.' },
    { id: 'seeker',     name: 'Seeker',         emoji: '🔎', cat: 'web',     url: '../seeker/',             desc: 'The search engine — BM25 ranking, instant answers.' },
    { id: 'magpie',     name: 'Magpie',         emoji: '🐦‍⬛', cat: 'web',     url: '../magpie/',             desc: 'The web scraper — point it at a page, it finds the lists.' },
    { id: 'ripple',     name: 'Ripple',         emoji: '💬', cat: 'social',  url: '../ripple/',             desc: 'The private messenger that puts you in control.' },
    { id: 'bloom',      name: 'Bloom',          emoji: '🌸', cat: 'social',  url: '../bloom/',              desc: 'The social network that’s on your side — you own the algorithm.' },
    { id: 'glimpse',    name: 'Glimpse',        emoji: '🔭', cat: 'social',  url: '../glimpse/',            desc: 'Share what you’re seeing — a feed that hops the globe.' },
    { id: 'intro',      name: 'Intro',          emoji: '🎴', cat: 'social',  url: '../intro/',              desc: 'Your digital business card — QR, NFC, Wallet.' },
    { id: 'atlas',      name: 'Atlas',          emoji: '🗺️', cat: 'travel',  url: '../atlas/',              desc: 'Your own satnav — voice turn-by-turn.' },
    { id: 'orbit',      name: 'Orbit',          emoji: '🪐', cat: 'travel',  url: '../orbit/',              desc: 'The everything app — rides, food, parcels, wallet.' },
    { id: 'dealsapp',   name: 'TravelDeals',    emoji: '✈️', cat: 'travel',  url: '../deals-app/',          desc: 'Flights & hotels — forecasts, deal scores, e-tickets.' },
    { id: 'cusp',       name: 'Cusp',           emoji: '🎯', cat: 'life',    url: '../cusp/',               desc: 'What to do right now — the salience engine.' },
    { id: 'lifeline',   name: 'Lifeline',       emoji: '🚨', cat: 'life',    url: '../lifeline/',           desc: 'Emergency first aid that works offline.' },
    { id: 'peak',       name: 'Peak',           emoji: '⛰️', cat: 'life',    url: '../peak/',               desc: 'Training, fuel and sleep in one honest daily score.' },
    { id: 'lingua',     name: 'Lingua',         emoji: '🗣️', cat: 'life',    url: '../lingua/',             desc: 'The fluency engine — every language.' },
    { id: 'babel',      name: 'Babel',          emoji: '🐟', cat: 'life',    url: '../babel/',              desc: 'The universal translator — 36 languages, fully offline.' },
    { id: 'parrot',     name: 'Parrot',         emoji: '🦜', cat: 'life',    url: '../parrot/',             desc: 'Your pocket voice board — record once, play forever.' },
    { id: 'omni',       name: 'Omni',           emoji: '🧰', cat: 'tools',   url: '../omni/',               desc: 'The do-everything app.' },
    { id: 'splitbill',  name: 'Split the bill', emoji: '🧾', cat: 'tools',   url: '../concepts/prototypes/concierge-split/', desc: 'AI concierge — agree a split, fire requests.' },
    { id: 'appsuite',   name: 'App Suite',      emoji: '🗂️', cat: 'tools',   url: '../apps/',               desc: '13 self-contained demo apps, one per category.' }
  ];

  /** App Store shelves, in display order. Every entry's `cat` must be one of
   *  these ids — the integrity test enforces it. */
  var BALLRZ_CATEGORIES = [
    { id: 'games',   name: 'Games & Arcade' },
    { id: 'ai',      name: 'AI & Frontier' },
    { id: 'money',   name: 'Money & Markets' },
    { id: 'travel',  name: 'Travel & Places' },
    { id: 'social',  name: 'Social' },
    { id: 'life',    name: 'Life & Health' },
    { id: 'web',     name: 'Internet' },
    { id: 'tools',   name: 'Tools' },
    { id: 'apexvip', name: 'ApexVIP Fleet' }
  ];

  /** The Store's curated front shelf — hand-picked, order matters. */
  var FEATURED_APPS = ['ballrz', 'ultra', 'orbit', 'voyager', 'vault', 'babel', 'atlas', 'bloom'];

  /** Case-folded catalog search: matches id/name/desc/category, best first.
   *  Pure and deterministic — shared by the Store search field and Ask AIOS. */
  function searchCatalog(query) {
    var q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    var scored = [];
    for (var i = 0; i < BALLRZ_APPS.length; i++) {
      var a = BALLRZ_APPS[i];
      var name = a.name.toLowerCase(), id = a.id.toLowerCase();
      var s = 0;
      if (id === q || name === q) s = 5;
      else if (name.indexOf(q) === 0 || id.indexOf(q) === 0) s = 4;
      else if (name.indexOf(q) !== -1) s = 3;
      else if (a.desc.toLowerCase().indexOf(q) !== -1) s = 2;
      else if (a.cat === q) s = 1;
      if (s) scored.push({ s: s, i: i, a: a });
    }
    scored.sort(function (x, y) { return y.s - x.s || x.i - y.i; });
    return scored.map(function (e) { return e.a; });
  }

  /** Which shell to show — pure so the "iPhone rotated to landscape must NOT
   *  become a macOS desktop" rule is unit-testable. `forced` is the user's
   *  explicit layout choice ('phone'|'desktop'|anything else = auto). */
  function decideLayout(width, coarsePointer, standalone, forced) {
    if (forced === 'phone') return 'phone';
    if (forced === 'desktop') return 'desktop';
    if (standalone && coarsePointer) return 'phone'; // an installed phone stays a phone, even in landscape
    if (width <= 640) return 'phone';
    if (coarsePointer && width < 820) return 'phone';
    return 'desktop';
  }

  function ballrzAppById(id) {
    for (var i = 0; i < BALLRZ_APPS.length; i++) if (BALLRZ_APPS[i].id === id) return BALLRZ_APPS[i];
    return null;
  }

  /** Install a catalog app to the home screen (phone springboard + desktop
   *  ✦ menu). The install list is ordered, deduped and persisted. */
  function installWebapp(state, id) {
    if (!ballrzAppById(id)) return { ok: false, error: 'no such app: ' + id };
    if (state.installed.indexOf(id) !== -1) return { ok: true, already: true };
    state.installed.push(id);
    return { ok: true };
  }

  function uninstallWebapp(state, id) {
    var i = state.installed.indexOf(id);
    if (i === -1) return false;
    state.installed.splice(i, 1);
    return true;
  }

  function isInstalled(state, id) { return state.installed.indexOf(id) !== -1; }

  /* ══════════════════════════ Home-screen widgets ══════════════════════════
   * Glanceable cards on the home screen (phone springboard and desktop
   * wallpaper). Which widgets you keep is persisted state; what each one
   * shows is a pure function of (state, now), so every card is testable. */

  var WIDGETS = [
    { id: 'clock',       name: 'Clock',       emoji: '🕰', desc: 'Time and date, big' },
    { id: 'notes',       name: 'Latest note', emoji: '📝', desc: 'Your most recent note, tap to open' },
    { id: 'automations', name: 'Automations', emoji: '🤖', desc: 'What the OS runs next' },
    { id: 'system',      name: 'System',      emoji: '📊', desc: 'Kernel, disk and journal at a glance' }
  ];
  function widgetById(id) {
    for (var i = 0; i < WIDGETS.length; i++) if (WIDGETS[i].id === id) return WIDGETS[i];
    return null;
  }

  function addWidget(state, id) {
    if (!widgetById(id)) return { ok: false, error: 'no such widget: ' + id };
    if (state.widgets.indexOf(id) !== -1) return { ok: true, already: true };
    state.widgets.push(id);
    return { ok: true };
  }

  function removeWidget(state, id) {
    var i = state.widgets.indexOf(id);
    if (i === -1) return false;
    state.widgets.splice(i, 1);
    return true;
  }

  /** The data a widget shows, computed purely from OS state + the clock. */
  function widgetData(state, id, now) {
    if (id === 'clock') {
      var d = new Date(now);
      return { ts: now, iso: d.toISOString() };
    }
    if (id === 'notes') {
      var r = fsList(state.fs, '/home/user/notes');
      var best = null;
      if (r.ok) {
        for (var i = 0; i < r.entries.length; i++) {
          var e = r.entries[i];
          if (e.type === 'file' && (!best || e.mtime > best.mtime)) best = e;
        }
      }
      if (!best) return { empty: true };
      var content = fsRead(state.fs, '/home/user/notes/' + best.name).content || '';
      return {
        empty: false,
        path: '/home/user/notes/' + best.name,
        title: best.name.replace(/\.(txt|md)$/, ''),
        preview: content.split('\n').filter(function (l) { return l.trim(); }).slice(0, 3)
      };
    }
    if (id === 'automations') {
      var enabled = state.automations.filter(function (a) { return a.enabled; });
      if (!enabled.length) return { count: 0 };
      var next = null, nextIn = Infinity;
      for (var j = 0; j < enabled.length; j++) {
        var due = Math.max(0, enabled[j].lastRun + enabled[j].everySeconds * 1000 - now);
        if (due < nextIn) { nextIn = due; next = enabled[j]; }
      }
      return { count: enabled.length, nextIn: Math.round(nextIn / 1000), nextCommand: next.command };
    }
    if (id === 'system') {
      var last = state.journal.length ? state.journal[state.journal.length - 1] : null;
      return {
        version: VERSION,
        windows: state.procs.length,
        diskBytes: serialize(state).length,
        installed: state.installed.length,
        lastJournal: last ? last.x : null
      };
    }
    return null;
  }

  /* ══════════════════════════ Mobile home screen ══════════════════════════
   * The phone shell (a springboard of app icons, one fullscreen app at a
   * time) is a different presentation of the SAME kernel — the desktop's
   * windows and the phone's home screen both just spawn procs and run the
   * same app renderers. These pure helpers describe the home layout so the
   * ordering is deterministic and testable. */

  // The four apps pinned to the phone's bottom dock, in order.
  var DOCK_FAVORITES = ['files', 'assistant', 'terminal', 'store'];

  /** The phone home screen: { dock, grid }. dock is the pinned favourites;
   *  grid is every other built-in app followed by every installed user app.
   *  Each entry is { id, arg, emoji, name } and opens with spawn(id, arg). */
  function springboard(state) {
    var dock = [], grid = [];
    for (var i = 0; i < APPS.length; i++) {
      var a = APPS[i];
      var entry = { id: a.id, arg: null, emoji: a.emoji, name: a.name };
      if (DOCK_FAVORITES.indexOf(a.id) !== -1) continue; // placed via dock order below
      grid.push(entry);
    }
    for (var d = 0; d < DOCK_FAVORITES.length; d++) {
      var app = appById(DOCK_FAVORITES[d]);
      if (app) dock.push({ id: app.id, arg: null, emoji: app.emoji, name: app.name });
    }
    var user = listApps(state);
    for (var u = 0; u < user.length; u++) grid.push({ id: 'userapp', arg: user[u].id, emoji: user[u].emoji, name: user[u].name });
    for (var w = 0; w < state.installed.length; w++) {
      var hub = ballrzAppById(state.installed[w]);
      if (hub) grid.push({ id: 'webapp', arg: hub.id, emoji: hub.emoji, name: hub.name });
    }
    return { dock: dock, grid: grid };
  }

  /* ══════════════════════════ Desktop icons ══════════════════════════ */

  /** What's on the desktop: the entries of ~/Desktop (dirs first, sorted). */
  function desktopEntries(state) {
    var r = fsList(state.fs, DESKTOP);
    return r.ok ? r.entries : [];
  }

  /** Deterministic default layout: icons flow down the left edge in
   *  columns of six, like a real desktop. */
  function defaultIconPos(index) {
    return { x: 14 + Math.floor(index / 6) * 92, y: 12 + (index % 6) * 96 };
  }

  /** Where an icon sits: wherever the user dragged it, else its grid slot. */
  function iconPos(state, name, index) {
    return state.desktop[name] || defaultIconPos(index);
  }

  function setIconPos(state, name, x, y) {
    if (badName(name)) return false;
    state.desktop[name] = {
      x: Math.max(0, Math.min(6000, Math.round(Number(x) || 0))),
      y: Math.max(0, Math.min(6000, Math.round(Number(y) || 0)))
    };
    return true;
  }

  /** Forget positions of icons whose file is gone (renamed, trashed…). */
  function pruneIconPos(state) {
    var names = {};
    var entries = desktopEntries(state);
    for (var i = 0; i < entries.length; i++) names[entries[i].name] = true;
    for (var n in state.desktop) if (!names[n]) delete state.desktop[n];
  }

  /* ══════════════════════════ Processes / windows ══════════════════════════ */

  // Notes is one window per file; user apps and hub webapps are one per id.
  function procKey(appId, arg) { return (appId === 'notes' || appId === 'userapp' || appId === 'webapp') && arg ? appId + ':' + arg : appId; }

  /** Spawn (or refocus) an app on the CURRENT workspace. Apps are singletons
   *  per workspace-agnostic key; re-spawning pulls the window to the active
   *  workspace. Placement cascades deterministically from the spawn ordinal. */
  function spawn(state, appId, arg) {
    // synthetic host windows: userapp = an installed .app manifest (arg = id),
    // webapp = a Ballrz Hub app in a frame (arg = catalog id)
    var app = appId === 'userapp' ? readApp(state, arg)
            : appId === 'webapp' ? ballrzAppById(arg)
            : appById(appId);
    if (!app) return { ok: false, error: 'no such app: ' + (appId === 'userapp' || appId === 'webapp' ? arg : appId) };
    var key = procKey(appId, arg);
    for (var i = 0; i < state.procs.length; i++) {
      if (procKey(state.procs[i].app, state.procs[i].arg) === key) {
        state.procs[i].ws = state.ws;
        focusProc(state, state.procs[i].pid);
        return { ok: true, proc: state.procs[i], existing: true };
      }
    }
    var n = state.nextPid;
    var proc = {
      pid: n,
      app: appId,
      title: appId === 'notes' && arg ? splitPath(arg).name : app.name,
      emoji: (appId === 'userapp' || appId === 'webapp') ? app.emoji : null,
      arg: arg || null,
      x: 36 + ((n - 1) * 28) % 168,
      y: 30 + ((n - 1) * 24) % 144,
      minimized: false,
      max: false,
      snap: null,
      ws: state.ws,
      z: ++state.zTop
    };
    state.nextPid++;
    state.procs.push(proc);
    return { ok: true, proc: proc, existing: false };
  }

  function findProc(state, pid) {
    for (var i = 0; i < state.procs.length; i++) if (state.procs[i].pid === pid) return state.procs[i];
    return null;
  }

  function focusProc(state, pid) {
    var p = findProc(state, pid);
    if (!p) return false;
    p.minimized = false;
    p.z = ++state.zTop;
    return true;
  }

  function minimizeProc(state, pid) {
    var p = findProc(state, pid);
    if (!p) return false;
    p.minimized = true;
    return true;
  }

  function closeProc(state, pid) {
    for (var i = 0; i < state.procs.length; i++) {
      if (state.procs[i].pid === pid) { state.procs.splice(i, 1); return true; }
    }
    return false;
  }

  /** Toggle maximize; a snapped window un-snaps into full. */
  function maximizeProc(state, pid) {
    var p = findProc(state, pid);
    if (!p) return false;
    p.max = !p.max || !!p.snap;
    p.snap = null;
    if (p.max) focusProc(state, pid);
    return true;
  }

  /** Tile to the left or right half; snapping again to the same side unsnaps. */
  function snapProc(state, pid, side) {
    var p = findProc(state, pid);
    if (!p || (side !== 'left' && side !== 'right')) return false;
    p.snap = p.snap === side ? null : side;
    p.max = false;
    focusProc(state, pid);
    return true;
  }

  /** Called when the user drags a window: it leaves any tiled state. */
  function floatProc(state, pid) {
    var p = findProc(state, pid);
    if (!p) return false;
    p.max = false;
    p.snap = null;
    return true;
  }

  function switchWorkspace(state, n) {
    n = Math.max(1, Math.min(WS_COUNT, Math.round(Number(n) || 1)));
    state.ws = n;
    return n;
  }

  function moveToWorkspace(state, pid, n) {
    var p = findProc(state, pid);
    if (!p) return false;
    p.ws = Math.max(1, Math.min(WS_COUNT, Math.round(Number(n) || 1)));
    return true;
  }

  /** The window that owns the keyboard: highest z among the unminimized on
   *  the ACTIVE workspace. */
  function topProc(state) {
    var top = null;
    for (var i = 0; i < state.procs.length; i++) {
      var p = state.procs[i];
      if (!p.minimized && p.ws === state.ws && (!top || p.z > top.z)) top = p;
    }
    return top;
  }

  /* ══════════════════════════ Automations ══════════════════════════ */

  /** Schedule `command` to run every `everySeconds` (min 60). Pure data —
   *  the desktop's ticker asks dueAutomations() what to run. */
  function addAutomation(state, command, everySeconds, now) {
    command = String(command || '').trim().slice(0, 400);
    everySeconds = Math.round(Number(everySeconds) || 0);
    if (!command) return { ok: false, error: 'automation needs a command' };
    if (everySeconds < 60) return { ok: false, error: 'minimum interval is 1 minute' };
    var auto = { id: state.nextAutoId++, command: command, everySeconds: everySeconds, lastRun: now, enabled: true };
    state.automations.push(auto);
    return { ok: true, automation: auto };
  }

  function removeAutomation(state, id) {
    for (var i = 0; i < state.automations.length; i++) {
      if (state.automations[i].id === id) { state.automations.splice(i, 1); return true; }
    }
    return false;
  }

  function toggleAutomation(state, id, enabled) {
    for (var i = 0; i < state.automations.length; i++) {
      if (state.automations[i].id === id) {
        state.automations[i].enabled = enabled == null ? !state.automations[i].enabled : !!enabled;
        return true;
      }
    }
    return false;
  }

  /** Which automations are due at `now`? Marks them run. Deterministic. */
  function dueAutomations(state, now) {
    var due = [];
    for (var i = 0; i < state.automations.length; i++) {
      var a = state.automations[i];
      if (a.enabled && now - a.lastRun >= a.everySeconds * 1000) {
        a.lastRun = now;
        due.push(a);
      }
    }
    return due;
  }

  /* ══════════════════════════ Shell ══════════════════════════ */

  /** Tokenize a command line: whitespace-separated, '"' and "'" quote, and
   *  the operators > >> | are their own tokens even unspaced. */
  function tokenize(input) {
    var toks = [], cur = '', quote = null, has = false;
    var push = function () { if (has) { toks.push(cur); cur = ''; has = false; } };
    for (var i = 0; i < input.length; i++) {
      var ch = input[i];
      if (quote) {
        if (ch === quote) quote = null;
        else { cur += ch; }
        has = true;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
      if (ch === ' ' || ch === '\t') { push(); continue; }
      if (ch === '>') {
        push();
        if (input[i + 1] === '>') { toks.push('>>'); i++; } else toks.push('>');
        continue;
      }
      if (ch === '|') { push(); toks.push('|'); continue; }
      cur += ch; has = true;
    }
    push();
    return toks;
  }

  var HELP = [
    'AIOS shell — commands:',
    '  ls [path]        list a directory        pwd              print working dir',
    '  cd [path]        change directory        cat <file>       print a file',
    '  echo <text>      print text              tree [path]      draw the disk',
    '  mkdir [-p] <dir> make directories        touch <file>     create empty file',
    '  rm <path>        move to /trash          restore <name>   undo an rm',
    '  trash            list the trash          trash empty      purge it',
    '  mv <a> <b>       move / rename           cp <a> <b>       copy',
    '  find <text>      search file names       open <app|file>  open something',
    '  ps / kill <pid>  processes               ws [1-3]         workspaces',
    '  every <t> <cmd>  schedule a command      automations      list schedules',
    '  unschedule <id>  remove a schedule       ai <request>     speak English',
    '  run <file> [a…]  execute a script        search <text>    search file CONTENTS',
    '  set NAME=value   shell variables ($NAME) env · unset      list / remove them',
    '  alias name=cmd   command shorthand       journal [n]      the system log',
    'Pipes:  any command | grep [-i|-v] <text> | head [-n N] | tail [-n N]',
    '        | sort [-r] | uniq [-c] | wc      Redirect:  any pipeline > file (>> appends)',
    '  app <list|install|remove|open> …        manage installed apps',
    '  write <file> <text> (\\n = newline)      author whole files in one command',
    '  timer <t> [label]   set a timer         theme <accent>   set the look',
    '  name [you]          who you are         widget <list|add|remove> home cards',
    '  notices [clear]     notification centre history (● = unread)',
    '  web <query>         internet research      scrape <url> [file]  page → CSV rows',
    'Scripts: text files with a real language — let/if/elif/else/while/func/end,',
    '  $((maths)), $1-$9/$@ args, # comments.  run backup.sh   (see /apps for examples)',
    'Also: date · whoami · uname · clear · help  ·  Builtins: $USER $HOME $CWD $WS'
  ];

  /** Filter stages usable after a `|`. Each maps input lines → output lines. */
  function runFilter(cmd, args, lines) {
    switch (cmd) {
      case 'grep': {
        var insensitive = false, invert = false;
        while (args[0] === '-i' || args[0] === '-v') {
          if (args.shift() === '-i') insensitive = true; else invert = true;
        }
        var pat = args.join(' ');
        if (!pat) return { ok: false, error: 'grep: missing pattern' };
        var needle = insensitive ? pat.toLowerCase() : pat;
        return {
          ok: true,
          lines: lines.filter(function (l) {
            var hay = insensitive ? l.toLowerCase() : l;
            return (hay.indexOf(needle) !== -1) !== invert;
          })
        };
      }
      case 'head': case 'tail': {
        var n = 10;
        if (args[0] === '-n') n = parseInt(args[1], 10);
        else if (args[0]) n = parseInt(args[0], 10);
        if (!isFinite(n) || n < 0) return { ok: false, error: cmd + ': bad count' };
        return { ok: true, lines: cmd === 'head' ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n)) };
      }
      case 'wc': {
        var words = 0, chars = 0;
        for (var i = 0; i < lines.length; i++) {
          words += lines[i].split(/\s+/).filter(Boolean).length;
          chars += lines[i].length + 1;
        }
        return { ok: true, lines: [lines.length + ' lines, ' + words + ' words, ' + chars + ' chars'] };
      }
      case 'sort': {
        var out = lines.slice().sort();
        if (args[0] === '-r') out.reverse();
        return { ok: true, lines: out };
      }
      case 'uniq': {
        var count = args[0] === '-c', res = [], prev = null, c = 0;
        var flush = function () { if (prev !== null) res.push(count ? c + ' ' + prev : prev); };
        for (var j = 0; j < lines.length; j++) {
          if (lines[j] === prev) c++;
          else { flush(); prev = lines[j]; c = 1; }
        }
        flush();
        return { ok: true, lines: res };
      }
      default:
        return { ok: false, error: cmd + ': not a filter — pipes accept grep, head, tail, wc, sort, uniq' };
    }
  }
  var FILTERS = { grep: 1, head: 1, tail: 1, wc: 1, sort: 1, uniq: 1 };

  var BUILTINS = ['help', 'pwd', 'ls', 'tree', 'cd', 'cat', 'echo', 'mkdir', 'touch', 'rm', 'trash', 'restore',
    'mv', 'cp', 'find', 'open', 'ps', 'kill', 'ws', 'every', 'automations', 'unschedule', 'set', 'unset', 'env',
    'alias', 'unalias', 'run', 'search', 'journal', 'date', 'whoami', 'uname', 'clear', 'ai',
    'set', 'let', 'app', 'timer', 'theme', 'name', 'widget', 'write', 'notices', 'grep', 'head', 'tail', 'wc', 'sort', 'uniq'];
  function runSimpleKnows(name) { return BUILTINS.indexOf(name) !== -1; }

  /* ══════════════════════════ AIOS Script ══════════════════════════
   * A small, real, deterministic language layered on the shell. A script is
   * still a text file of shell commands — but now it also understands blocks:
   *
   *   let x = 3 + 4            # a variable (lives in the shell env, so $x works)
   *   if $x > 5               # comparisons ==, !=, <, >, <=, >=; also `exists PATH`,
   *     echo big              #   `not <cond>`, and bare truthiness (non-empty/non-zero)
   *   else
   *     echo small
   *   end
   *   while $n > 0            # loops, bounded by a global step cap so nothing hangs
   *     set n=$(($n - 1))
   *   end
   *   func greet              # define a new command; $1..$9/$@ are its arguments
   *     echo hello $1
   *   end
   *   greet world            # ...then call it like any built-in
   *
   * Everything is interpreted against the same kernel the terminal uses, so a
   * script has exactly a user's powers — and it is pure and unit-tested. */

  /** Parse a flat line list into a block AST. Returns {nodes, i} where i is the
   *  index just past the matching terminator (from `stops`). */
  function parseBlock(lines, i, stops) {
    var nodes = [];
    while (i < lines.length) {
      var raw = lines[i];
      var line = raw.replace(/\s+#.*$/, '').trim(); // strip trailing comments
      if (!line || line[0] === '#') { i++; continue; }
      var head = line.split(/\s+/)[0];
      if (stops.indexOf(head) !== -1) return { nodes: nodes, i: i, stop: head };
      // a terminator with no matching opener is a syntax error, not a command
      if (head === 'end' || head === 'else' || head === 'elif') throw new Error('line ' + (i + 1) + ': stray `' + head + '`');

      if (head === 'if') {
        var thenB = parseBlock(lines, i + 1, ['else', 'elif', 'end']);
        var node = { type: 'if', cond: line.slice(2).trim(), then: thenB.nodes, elifs: [], els: null };
        var cur = thenB;
        while (cur.stop === 'elif') {
          var eb = parseBlock(lines, cur.i + 1, ['else', 'elif', 'end']);
          node.elifs.push({ cond: lines[cur.i].trim().slice(4).trim(), body: eb.nodes });
          cur = eb;
        }
        if (cur.stop === 'else') {
          var elseB = parseBlock(lines, cur.i + 1, ['end']);
          node.els = elseB.nodes;
          cur = elseB;
        }
        if (cur.stop !== 'end') throw new Error('line ' + (i + 1) + ': `if` without `end`');
        nodes.push(node);
        i = cur.i + 1;
      } else if (head === 'while') {
        var body = parseBlock(lines, i + 1, ['end']);
        if (body.stop !== 'end') throw new Error('line ' + (i + 1) + ': `while` without `end`');
        nodes.push({ type: 'while', cond: line.slice(5).trim(), body: body.nodes });
        i = body.i + 1;
      } else if (head === 'func') {
        var fname = line.split(/\s+/)[1];
        if (!fname || !/^[A-Za-z_][\w-]*$/.test(fname)) throw new Error('line ' + (i + 1) + ': func needs a name');
        var fbody = parseBlock(lines, i + 1, ['end']);
        if (fbody.stop !== 'end') throw new Error('line ' + (i + 1) + ': `func` without `end`');
        nodes.push({ type: 'func', name: fname, body: fbody.nodes });
        i = fbody.i + 1;
      } else {
        nodes.push({ type: 'cmd', text: line });
        i++;
      }
    }
    return { nodes: nodes, i: i, stop: null };
  }

  /** Evaluate a boolean condition (already the text after `if`/`while`). */
  function evalCond(state, expr, now) {
    expr = String(expr || '').trim();
    if (/^not\s+/.test(expr)) return !evalCond(state, expr.slice(4), now);
    var ex = /^exists\s+(.+)$/.exec(expr);
    if (ex) return !!fsGet(state.fs, normalizePath(state.cwd, expandVars(state, ex[1].trim())));
    var s = expandVars(state, expr).trim();
    var m = /^(.*?)\s*(==|!=|<=|>=|<|>)\s*(.*)$/.exec(s);
    if (m) {
      var l = m[1].trim(), op = m[2], r = m[3].trim();
      var ln = calcEval(l), rn = calcEval(r);
      if (ln !== null && rn !== null) {
        return op === '==' ? ln === rn : op === '!=' ? ln !== rn : op === '<' ? ln < rn :
               op === '>' ? ln > rn : op === '<=' ? ln <= rn : ln >= rn;
      }
      return op === '==' ? l === r : op === '!=' ? l !== r : op === '<' ? l < r :
             op === '>' ? l > r : op === '<=' ? l <= r : l >= r;
    }
    // bare truthiness: non-empty and not "0"/"false"
    return s !== '' && s !== '0' && s.toLowerCase() !== 'false';
  }

  /** Substitute $(( arithmetic )) then $1..$9/$@ positional args in a line. */
  function subScriptLine(state, line, sargs) {
    line = line.replace(/\$\(\(([\s\S]*?)\)\)/g, function (_, e) {
      var v = calcEval(expandVars(state, e));
      return v === null ? '0' : fmtNum(v);
    });
    return line.replace(/\$@/g, sargs.join(' ')).replace(/\$([1-9])\b/g, function (_, n) { return sargs[Number(n) - 1] || ''; });
  }

  /** Execute a parsed block. `ctx` carries the step budget and script args. */
  function execNodes(state, nodes, ctx, now) {
    var out = [], fx = [];
    for (var i = 0; i < nodes.length; i++) {
      if (++ctx.steps > SCRIPT_STEP_CAP) return { out: out.concat(['script exceeded ' + SCRIPT_STEP_CAP + ' steps — stopped']), error: true, effects: fx };
      var node = nodes[i];
      if (node.type === 'func') { ctx.funcs[node.name] = node.body; continue; }
      if (node.type === 'cmd') {
        var line = subScriptLine(state, node.text, ctx.args);
        var head = line.split(/\s+/)[0];
        var r;
        if (ctx.funcs[head]) {
          // calling a user-defined function: its own $1..$9/$@ from the call args
          var callArgs = tokenize(subScriptLine(state, line, ctx.args)).slice(1);
          r = execNodes(state, ctx.funcs[head], { steps: ctx.steps, funcs: ctx.funcs, args: callArgs }, now);
          ctx.steps = (r._steps != null ? r._steps : ctx.steps);
        } else {
          r = execCommand(state, line, now);
        }
        out = out.concat(r.out); fx = fx.concat(r.effects);
        if (r.error) { out.push(ctx.name + ': line stopped: ' + node.text.trim()); return { out: out, error: true, effects: fx }; }
      } else if (node.type === 'if') {
        var branch = null;
        if (evalCond(state, node.cond, now)) branch = node.then;
        else {
          for (var e = 0; e < node.elifs.length; e++) if (evalCond(state, node.elifs[e].cond, now)) { branch = node.elifs[e].body; break; }
          if (!branch) branch = node.els;
        }
        if (branch) {
          var ri = execNodes(state, branch, ctx, now);
          out = out.concat(ri.out); fx = fx.concat(ri.effects);
          if (ri.error) return { out: out, error: true, effects: fx };
        }
      } else if (node.type === 'while') {
        while (evalCond(state, node.cond, now)) {
          if (++ctx.steps > SCRIPT_STEP_CAP) return { out: out.concat(['script exceeded ' + SCRIPT_STEP_CAP + ' steps — stopped']), error: true, effects: fx };
          var rw = execNodes(state, node.body, ctx, now);
          out = out.concat(rw.out); fx = fx.concat(rw.effects);
          if (rw.error) return { out: out, error: true, effects: fx };
        }
      }
    }
    return { out: out, error: false, effects: fx, _steps: ctx.steps };
  }

  /** Run a script's source. Shared by `run <file>` and app logic. */
  function runScript(state, source, sargs, name, now) {
    var lines = String(source || '').split('\n');
    var ast;
    try { ast = parseBlock(lines, 0, []); }
    catch (e) { return { out: [name + ': ' + e.message], error: true, effects: [] }; }
    if (ast.stop) return { out: [name + ': stray `' + ast.stop + '`'], error: true, effects: [] };
    var ctx = { steps: 0, funcs: {}, args: sargs || [], name: name };
    var r = execNodes(state, ast.nodes, ctx, now);
    return { out: r.out, error: r.error, effects: r.effects };
  }

  /**
   * Execute one command line — including `a | b | c` pipelines and a
   * trailing `> file` / `>> file` redirection on any pipeline. Returns
   * { out: string[], error: bool, effects: [{type:'open'|'clear'|'timer'|...}] }.
   */
  /** $VAR expansion: builtins ($USER, $HOME, $CWD, $WS) then the shell
   *  environment; unknown variables expand to '' like a real shell. */
  function expandVars(state, str) {
    // $(( arithmetic )) first (its inner text may reference $VARs), then $VARs.
    str = String(str).replace(/\$\(\(([\s\S]*?)\)\)/g, function (_, e) {
      var v = calcEval(expandVars(state, e));
      return v === null ? '0' : fmtNum(v);
    });
    return str.replace(/\$([A-Za-z_]\w*)/g, function (_, name) {
      if (name === 'USER') return state.settings.owner;
      if (name === 'HOME') return '/home/user';
      if (name === 'CWD' || name === 'PWD') return state.cwd;
      if (name === 'WS') return String(state.ws);
      return Object.prototype.hasOwnProperty.call(state.env, name) ? state.env[name] : '';
    });
  }

  function execCommand(state, input, now) {
    var raw = String(input || '');

    // alias expansion: first word, string-level (aliases may contain pipes),
    // bounded and cycle-proof
    var seen = {};
    for (var hops = 0; hops < 5; hops++) {
      var am = /^\s*([A-Za-z_][\w-]*)/.exec(raw);
      if (!am || !state.aliases[am[1]] || seen[am[1]]) break;
      seen[am[1]] = true;
      raw = raw.replace(am[1], state.aliases[am[1]]);
    }

    // $VAR expansion — except where the argument is itself a command or
    // sentence that must stay raw: `alias` definitions keep their $ for
    // later, `every` expands at RUN time, `ai` takes English verbatim, and
    // `write` authors files — a script's $n must land on disk as $n.
    var fw = /^\s*(\S+)/.exec(raw);
    var firstWord = fw ? fw[1] : '';
    if (firstWord !== 'ai' && firstWord !== 'every' && firstWord !== 'alias' && firstWord !== 'write') raw = expandVars(state, raw);

    var toks = tokenize(raw);
    if (!toks.length) return { out: [], error: false, effects: [] };

    // the system journal sees every top-level command (script lines are
    // sub-commands; `ai` is journaled by the assistant itself)
    if (!state._runDepth && toks[0] !== 'ai' && toks[0] !== 'journal') logJournal(state, 'sh', raw.trim(), now);

    // `every`, `ai` and `alias` take a whole command / sentence as their
    // argument — pipes and redirection belong to THAT inner command, not
    // this line (`every 1h echo tick >> log.txt` must store the >>, and
    // `alias texts=ls | grep txt` must store the pipe).
    if (toks[0] === 'every' || toks[0] === 'ai' || toks[0] === 'alias' || toks[0] === 'write') return runSimple(state, toks, now);

    // trailing redirection applies to the whole pipeline
    var redirect = null;
    for (var r = 0; r < toks.length; r++) {
      if (toks[r] === '>' || toks[r] === '>>') {
        if (r !== toks.length - 2) return { out: [(toks[r]) + ': redirection must end the command'], error: true, effects: [] };
        redirect = { op: toks[r], file: toks[r + 1] };
        toks = toks.slice(0, r);
        break;
      }
    }
    if (redirect && !redirect.file) return { out: ['missing file after ' + redirect.op], error: true, effects: [] };

    // split into pipeline stages
    var stages = [[]];
    for (var t = 0; t < toks.length; t++) {
      if (toks[t] === '|') { stages.push([]); continue; }
      stages[stages.length - 1].push(toks[t]);
    }
    for (var s = 0; s < stages.length; s++) {
      if (!stages[s].length) return { out: ['empty command in pipeline'], error: true, effects: [] };
    }

    // first stage: a real command — or a filter fed by a trailing file
    // argument (`grep error log.txt`, `head -n 3 notes/welcome.txt`)
    var first = stages[0];
    var res;
    if (FILTERS[first[0]]) {
      var fargs = first.slice(1);
      var lines = [];
      if (fargs.length) {
        var fr = fsRead(state.fs, normalizePath(state.cwd, fargs[fargs.length - 1]));
        if (fr.ok) { lines = fr.content.split('\n'); fargs = fargs.slice(0, -1); }
      }
      var ff = runFilter(first[0], fargs, lines);
      res = ff.ok ? { out: ff.lines, error: false, effects: [] } : { out: [ff.error], error: true, effects: [] };
    } else {
      res = runSimple(state, first, now);
    }
    if (res.error) return res;

    // subsequent stages must be filters
    var out = res.out;
    for (var st = 1; st < stages.length; st++) {
      var f = runFilter(stages[st][0], stages[st].slice(1), out);
      if (!f.ok) return { out: [f.error], error: true, effects: [] };
      out = f.lines;
    }

    if (redirect) {
      var w = fsWrite(state.fs, normalizePath(state.cwd, redirect.file), out.join('\n') + (out.length ? '\n' : ''), now, { append: redirect.op === '>>' });
      if (!w.ok) return { out: [w.error], error: true, effects: res.effects };
      return { out: [], error: false, effects: res.effects };
    }
    return { out: out, error: res.error, effects: res.effects };
  }

  /** One plain (non-pipeline) command. */
  function runSimple(state, toks, now) {
    var cmd = toks[0], args = toks.slice(1);
    var out = [];
    var err = function (msg) { return { out: [msg], error: true, effects: [] }; };
    var P = function (p) { return normalizePath(state.cwd, p); };

    switch (cmd) {
      case 'help': return { out: HELP.slice(), error: false, effects: [] };

      case 'pwd': return { out: [state.cwd], error: false, effects: [] };

      case 'ls': {
        var r = fsList(state.fs, P(args[0] || '.'));
        if (!r.ok) return err('ls: ' + r.error);
        for (var i = 0; i < r.entries.length; i++) {
          var e = r.entries[i];
          out.push(e.type === 'dir' ? e.name + '/' : e.name + '  (' + e.size + ' B)');
        }
        if (!out.length) out.push('(empty)');
        return { out: out, error: false, effects: [] };
      }

      case 'tree': {
        var tr = fsTree(state.fs, P(args[0] || '.'));
        if (!tr.ok) return err('tree: ' + tr.error);
        return { out: tr.lines, error: false, effects: [] };
      }

      case 'cd': {
        var to = P(args[0] || '~');
        var node = fsGet(state.fs, to);
        if (!node) return err('cd: no such directory: ' + (args[0] || '~'));
        if (node.type !== 'dir') return err('cd: not a directory: ' + args[0]);
        state.cwd = to;
        return { out: [], error: false, effects: [] };
      }

      case 'cat': {
        if (!args.length) return err('cat: which file?');
        for (var c = 0; c < args.length; c++) {
          var rr = fsRead(state.fs, P(args[c]));
          if (!rr.ok) return err('cat: ' + rr.error);
          out = out.concat(rr.content.split('\n'));
        }
        return { out: out, error: false, effects: [] };
      }

      case 'echo':
        return { out: [args.join(' ')], error: false, effects: [] };

      case 'mkdir': {
        var parents = args[0] === '-p';
        var dirs = parents ? args.slice(1) : args;
        if (!dirs.length) return err('mkdir: which directory?');
        for (var d = 0; d < dirs.length; d++) {
          var m = fsMkdir(state.fs, P(dirs[d]), now, { parents: parents });
          if (!m.ok) return err('mkdir: ' + m.error);
        }
        return { out: [], error: false, effects: [] };
      }

      case 'touch': {
        if (!args.length) return err('touch: which file?');
        for (var t = 0; t < args.length; t++) {
          var path = P(args[t]);
          if (fsGet(state.fs, path)) { fsGet(state.fs, path).mtime = now; continue; }
          var tw = fsWrite(state.fs, path, '', now);
          if (!tw.ok) return err('touch: ' + tw.error);
        }
        return { out: [], error: false, effects: [] };
      }

      case 'rm': {
        var rec = args[0] === '-r' || args[0] === '-rf';
        var targets = rec ? args.slice(1) : args;
        if (!targets.length) return err('rm: which path?');
        for (var x = 0; x < targets.length; x++) {
          var full = P(targets[x]);
          if ((full + '/').indexOf(TRASH + '/') === 0 || full === TRASH) {
            // inside the trash: permanent
            var rmr = fsRemove(state.fs, full, { recursive: rec });
            if (!rmr.ok) return err('rm: ' + rmr.error);
            out.push('purged ' + full);
          } else {
            var tres = fsTrash(state.fs, full, now);
            if (!tres.ok) return err('rm: ' + tres.error);
            out.push(full + ' → /trash/' + tres.name + '  (restore ' + tres.name + ' to undo)');
          }
        }
        return { out: out, error: false, effects: [] };
      }

      case 'trash': {
        if (args[0] === 'empty') {
          var em = fsEmptyTrash(state.fs, now);
          return { out: ['trash emptied — ' + em.count + ' item' + (em.count === 1 ? '' : 's') + ' gone forever'], error: false, effects: [] };
        }
        var tl = fsList(state.fs, TRASH);
        if (!tl.ok || !tl.entries.length) return { out: ['(trash is empty)'], error: false, effects: [] };
        for (var ti = 0; ti < tl.entries.length; ti++) {
          var te = tl.entries[ti];
          out.push(te.name + (te.type === 'dir' ? '/' : '') + '  ← was ' + (state.fs.trash[te.name] || '?'));
        }
        return { out: out, error: false, effects: [] };
      }

      case 'restore': {
        if (!args.length) return err('restore: which trash item? (see `trash`)');
        var rs = fsRestore(state.fs, args[0], now);
        if (!rs.ok) return err('restore: ' + rs.error);
        return { out: ['restored to ' + rs.origin], error: false, effects: [] };
      }

      case 'mv': case 'cp': {
        if (args.length !== 2) return err(cmd + ': usage: ' + cmd + ' <from> <to>');
        var op2 = cmd === 'mv' ? fsMove : fsCopy;
        var mres = op2(state.fs, P(args[0]), P(args[1]), now);
        if (!mres.ok) return err(cmd + ': ' + mres.error);
        return { out: [], error: false, effects: [] };
      }

      case 'find': {
        if (!args.length) return err('find: search for what?');
        var hits = fsFind(state.fs, args.join(' '));
        return { out: hits.length ? hits : ['(no matches)'], error: false, effects: [] };
      }

      case 'open': {
        if (!args.length) return err('open: open what? (' + APPS.map(function (a) { return a.id; }).join(', ') + ', or a file)');
        var what = args.join(' ');
        // Exact app name first, then a real path — so `open notes/welcome.txt`
        // opens the FILE, not the Notes app its path happens to mention.
        var appHit = matchApp(what, { exact: true });
        if (appHit) return { out: ['opening ' + appHit.name + '…'], error: false, effects: [{ type: 'open', app: appHit.id }] };
        var fpath = P(what);
        var fnode = fsGet(state.fs, fpath);
        if (fnode && fnode.type === 'file') return { out: ['opening ' + fpath + '…'], error: false, effects: [{ type: 'open', app: 'notes', arg: fpath }] };
        if (fnode && fnode.type === 'dir') return { out: ['opening ' + fpath + '…'], error: false, effects: [{ type: 'open', app: 'files', arg: fpath }] };
        var fuzzy = matchApp(what);
        if (fuzzy) return { out: ['opening ' + fuzzy.name + '…'], error: false, effects: [{ type: 'open', app: fuzzy.id }] };
        return err('open: no such app or file: ' + what);
      }

      case 'ps': {
        if (!state.procs.length) return { out: ['(no windows open)'], error: false, effects: [] };
        out.push('PID  WS  APP          TITLE');
        for (var pi = 0; pi < state.procs.length; pi++) {
          var pr = state.procs[pi];
          out.push(String(pr.pid).padEnd(4) + ' ' + String(pr.ws).padEnd(3) + ' ' + pr.app.padEnd(12) + ' ' + pr.title + (pr.minimized ? '  (minimized)' : ''));
        }
        return { out: out, error: false, effects: [] };
      }

      case 'kill': {
        var pid = parseInt(args[0], 10);
        if (!pid || !findProc(state, pid)) return err('kill: no such pid: ' + args[0]);
        closeProc(state, pid);
        return { out: ['killed ' + pid], error: false, effects: [] };
      }

      case 'ws': {
        if (!args.length) return { out: ['workspace ' + state.ws + ' of ' + WS_COUNT], error: false, effects: [] };
        var n = parseInt(args[0], 10);
        if (!n || n < 1 || n > WS_COUNT) return err('ws: pick 1–' + WS_COUNT);
        switchWorkspace(state, n);
        return { out: ['switched to workspace ' + n], error: false, effects: [] };
      }

      case 'every': {
        if (args.length < 2) return err('every: usage: every <interval> <command…>  e.g. every 30m ai note that stretch');
        var secs = parseDuration(args[0]);
        if (!secs) return err('every: bad interval: ' + args[0]);
        var aRes = addAutomation(state, args.slice(1).join(' '), secs, now);
        if (!aRes.ok) return err('every: ' + aRes.error);
        return {
          out: ['automation #' + aRes.automation.id + ': every ' + fmtDuration(secs) + ' → ' + aRes.automation.command],
          error: false, effects: []
        };
      }

      case 'automations': {
        if (!state.automations.length) return { out: ['(no automations — try: every 30m ai note that stretch)'], error: false, effects: [] };
        out.push('ID  EVERY        COMMAND');
        for (var ai2 = 0; ai2 < state.automations.length; ai2++) {
          var au = state.automations[ai2];
          out.push(String(au.id).padEnd(3) + ' ' + fmtDuration(au.everySeconds).padEnd(12) + ' ' + au.command + (au.enabled ? '' : '  (paused)'));
        }
        return { out: out, error: false, effects: [] };
      }

      case 'unschedule': {
        var uid = parseInt(args[0], 10);
        if (!uid || !removeAutomation(state, uid)) return err('unschedule: no automation #' + args[0]);
        return { out: ['removed automation #' + uid], error: false, effects: [] };
      }

      case 'set': {
        var sm2 = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(args.join(' '));
        if (!sm2) return err('set: usage: set NAME=value   (then use $NAME anywhere)');
        state.env[sm2[1]] = sm2[2].slice(0, 400);
        return { out: [], error: false, effects: [] };
      }

      case 'let': {
        // `let x = 3 + 4` — evaluate the arithmetic, store the number.
        var lm = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(args.join(' '));
        if (!lm) return err('let: usage: let NAME = <arithmetic>');
        var lv = calcEval(expandVars(state, lm[2]));
        if (lv === null) return err('let: not a number: ' + lm[2]);
        state.env[lm[1]] = fmtNum(lv);
        return { out: [], error: false, effects: [] };
      }

      case 'unset': {
        if (!args[0] || !Object.prototype.hasOwnProperty.call(state.env, args[0])) return err('unset: no such variable: ' + (args[0] || ''));
        delete state.env[args[0]];
        return { out: [], error: false, effects: [] };
      }

      case 'env': {
        out.push('USER=' + state.settings.owner, 'HOME=/home/user', 'CWD=' + state.cwd, 'WS=' + state.ws);
        var envKeys = Object.keys(state.env).sort();
        for (var ek = 0; ek < envKeys.length; ek++) out.push(envKeys[ek] + '=' + state.env[envKeys[ek]]);
        return { out: out, error: false, effects: [] };
      }

      case 'alias': {
        if (!args.length) {
          var aKeys = Object.keys(state.aliases).sort();
          if (!aKeys.length) return { out: ['(no aliases — try: alias ll=ls | sort)'], error: false, effects: [] };
          for (var ak = 0; ak < aKeys.length; ak++) out.push(aKeys[ak] + '=' + state.aliases[aKeys[ak]]);
          return { out: out, error: false, effects: [] };
        }
        var adef = /^([A-Za-z_][\w-]*)=([\s\S]+)$/.exec(args.join(' '));
        if (!adef) return err('alias: usage: alias name=command');
        if (runSimpleKnows(adef[1])) return err('alias: refusing to shadow the built-in `' + adef[1] + '`');
        state.aliases[adef[1]] = adef[2].slice(0, 400);
        return { out: [], error: false, effects: [] };
      }

      case 'unalias': {
        if (!args[0] || !state.aliases[args[0]]) return err('unalias: no such alias: ' + (args[0] || ''));
        delete state.aliases[args[0]];
        return { out: [], error: false, effects: [] };
      }

      case 'run': {
        if (!args.length) return err('run: which script? (any text file of shell commands; # comments; $1-$9 and $@ for arguments)');
        var spath = P(args[0]);
        var sr = fsRead(state.fs, spath);
        if (!sr.ok) return err('run: ' + sr.error);
        var depth = state._runDepth || 0;
        if (depth >= RUN_DEPTH_CAP) return err('run: scripts nested too deep (max ' + RUN_DEPTH_CAP + ')');
        var sargs = args.slice(1);
        state._runDepth = depth + 1;
        try {
          return runScript(state, sr.content, sargs, splitPath(spath).name, now);
        } finally { state._runDepth = depth; }
      }

      case 'search': {
        if (!args.length) return err('search: search file CONTENTS for what? (find searches names)');
        var sq = args.join(' ');
        var gh = fsGrep(state.fs, sq);
        if (!gh.length) return { out: ['(no file contains “' + sq + '”)'], error: false, effects: [] };
        for (var gi = 0; gi < gh.length; gi++) out.push(gh[gi].path + ':' + gh[gi].line + ':  ' + gh[gi].text);
        return { out: out, error: false, effects: [] };
      }

      case 'app': {
        var sub = args[0] || 'list';
        if (sub === 'list') {
          var apps = listApps(state);
          if (!apps.length) return { out: ['(no apps installed — .app manifests live in /apps)'], error: false, effects: [] };
          for (var appi = 0; appi < apps.length; appi++) out.push(apps[appi].emoji + ' ' + apps[appi].id + '  — ' + apps[appi].name);
          return { out: out, error: false, effects: [] };
        }
        if (sub === 'open') {
          if (!args[1] || !readApp(state, args[1])) return err('app: no app: ' + (args[1] || ''));
          return { out: ['opening ' + args[1] + '…'], error: false, effects: [{ type: 'open', app: 'userapp', arg: args[1] }] };
        }
        if (sub === 'install') {
          if (!args[1]) return err('app: install <file.app | hub-app-id> — a manifest, or a Ballrz app for the home screen');
          // a Ballrz catalog id installs the hub app to the home screen
          if (ballrzAppById(args[1]) && !fsGet(state.fs, P(args[1]))) {
            var iw = installWebapp(state, args[1]);
            return { out: [iw.already ? args[1] + ' is already on the home screen' : 'installed ' + args[1] + ' to the home screen'], error: false, effects: [] };
          }
          var src = P(args[1]);
          var srd = fsRead(state.fs, src);
          if (!srd.ok) return err('app: ' + srd.error);
          var parsed = parseApp(srd.content);
          if (!parsed) return err('app: not a valid .app manifest (needs JSON with a "name")');
          if (!fsGet(state.fs, APPS_DIR)) fsMkdir(state.fs, APPS_DIR, now);
          var id = splitPath(src).name.replace(/\.app$/, '').replace(/[^a-z0-9_-]/gi, '-');
          fsWrite(state.fs, APPS_DIR + '/' + id + '.app', srd.content, now);
          return { out: ['installed ' + id + ' — open it from the ✦ menu or `app open ' + id + '`'], error: false, effects: [] };
        }
        if (sub === 'remove') {
          if (args[1] && readApp(state, args[1])) {
            fsRemove(state.fs, APPS_DIR + '/' + args[1] + '.app', {});
            return { out: ['removed ' + args[1]], error: false, effects: [] };
          }
          if (args[1] && uninstallWebapp(state, args[1])) {
            return { out: ['removed ' + args[1] + ' from the home screen'], error: false, effects: [] };
          }
          return err('app: no app: ' + (args[1] || ''));
        }
        return err('app: usage: app <list|open|install|remove> …');
      }

      case 'journal': {
        var jn = args[0] ? parseInt(args[0], 10) : 20;
        if (!isFinite(jn) || jn < 1) return err('journal: bad count');
        var ent = state.journal.slice(-jn);
        if (!ent.length) return { out: ['(journal is empty)'], error: false, effects: [] };
        for (var ji = 0; ji < ent.length; ji++) {
          out.push(new Date(ent[ji].t).toISOString().slice(11, 19) + '  ' + ent[ji].k.padEnd(3) + ' ' + ent[ji].x);
        }
        return { out: out, error: false, effects: [] };
      }

      case 'timer': {
        // `timer 5m tea` — same effect the assistant's spoken timers emit
        if (!args.length) return err('timer: usage: timer <duration> [label…]  e.g. timer 5m tea');
        var tsecs = parseDuration(args[0]);
        if (!tsecs) return err('timer: bad duration: ' + args[0]);
        var tlabel = args.slice(1).join(' ') || 'Timer';
        return {
          out: ['timer set for ' + fmtDuration(tsecs) + (tlabel !== 'Timer' ? ' — ' + tlabel : '')],
          error: false, effects: [{ type: 'timer', seconds: tsecs, label: tlabel }]
        };
      }

      case 'theme': {
        if (!args[0]) return { out: ['accent: ' + state.settings.accent + '  (options: ' + ACCENTS.join(', ') + ')'], error: false, effects: [] };
        if (ACCENTS.indexOf(args[0]) === -1) return err('theme: pick one of: ' + ACCENTS.join(', '));
        state.settings.accent = args[0];
        return { out: ['accent set to ' + args[0]], error: false, effects: [{ type: 'accent', accent: args[0] }] };
      }

      case 'name': {
        if (!args.length) return { out: [state.settings.owner], error: false, effects: [] };
        state.settings.owner = args.join(' ').slice(0, 24);
        return { out: ['hello, ' + state.settings.owner], error: false, effects: [] };
      }

      case 'widget': {
        var wsub = args[0] || 'list';
        if (wsub === 'list') {
          for (var wl = 0; wl < WIDGETS.length; wl++) {
            out.push((state.widgets.indexOf(WIDGETS[wl].id) !== -1 ? '✓ ' : '  ') + WIDGETS[wl].id.padEnd(12) + WIDGETS[wl].desc);
          }
          return { out: out, error: false, effects: [] };
        }
        if (wsub === 'add') {
          var wa = addWidget(state, args[1] || '');
          if (!wa.ok) return err('widget: ' + wa.error);
          return { out: [wa.already ? args[1] + ' is already on the home screen' : 'added ' + args[1] + ' to the home screen'], error: false, effects: [] };
        }
        if (wsub === 'remove') {
          if (!removeWidget(state, args[1] || '')) return err('widget: not on the home screen: ' + (args[1] || ''));
          return { out: ['removed ' + args[1]], error: false, effects: [] };
        }
        return err('widget: usage: widget <list|add|remove> [id]');
      }

      case 'notices': {
        if (args[0] === 'clear') { clearNotices(state); return { out: ['notification centre cleared'], error: false, effects: [] }; }
        if (!state.notices.length) return { out: ['no notifications'], error: false, effects: [] };
        var nOut = [];
        for (var nc = state.notices.length - 1; nc >= 0 && nOut.length < 20; nc--) {
          var nv = state.notices[nc];
          nOut.push((nv.read ? '  ' : '● ') + nv.title + (nv.body ? ' — ' + nv.body : ''));
        }
        return { out: nOut, error: false, effects: [] };
      }

      case 'write': {
        // `write <file> <content>` — \n in the content becomes a real newline,
        // so scripts, notes and .app manifests can be authored in ONE command
        // (echo can only append a line at a time). This is what lets the
        // Live AI build whole programs for the user.
        if (args.length < 2) return err('write: usage: write <file> <content…>  (\\n makes a new line)');
        var wpath = P(args[0]);
        var wtext = args.slice(1).join(' ').replace(/\\n/g, '\n');
        var wres = fsWrite(state.fs, wpath, wtext + (wtext.endsWith('\n') ? '' : '\n'), now);
        if (!wres.ok) return err('write: ' + wres.error);
        return { out: ['wrote ' + wpath + ' (' + wtext.split('\n').length + ' lines)'], error: false, effects: [] };
      }

      case 'date': return { out: [new Date(now).toString()], error: false, effects: [] };
      case 'whoami': return { out: [state.settings.owner], error: false, effects: [] };
      case 'uname': return { out: ['AIOS kernel ' + VERSION + ' (browser)'], error: false, effects: [] };
      case 'clear': return { out: [], error: false, effects: [{ type: 'clear' }] };

      case 'ai': {
        if (!args.length) return err('ai: ask me something — e.g. `ai set a timer for 5 minutes`');
        var a = assistant(state, args.join(' '), now);
        return { out: a.reply.split('\n'), error: false, effects: a.actions };
      }

      default:
        return err(cmd + ': command not found — try `help`, or `ai ' + toks.join(' ').replace(/`/g, '') + '`');
    }
  }

  /* ══════════════════════════ Arithmetic (no eval, ever) ══════════════════════════ */

  /** Recursive-descent parser: + − × ÷ % ^ with precedence, parens, unary
   *  minus, decimals. Returns a finite number or null on any syntax error. */
  function calcEval(expr) {
    var s = String(expr || '')
      .replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
      .replace(/\s+/g, '');
    if (!s || /[^0-9+\-*/%^().]/.test(s)) return null;
    var i = 0;
    function peek() { return s[i]; }
    function parseExpr() {
      var v = parseTerm();
      while (v !== null && (peek() === '+' || peek() === '-')) {
        var op = s[i++], r = parseTerm();
        if (r === null) return null;
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function parseTerm() {
      var v = parseFactor();
      while (v !== null && (peek() === '*' || peek() === '/' || peek() === '%')) {
        var op = s[i++], r = parseFactor();
        if (r === null) return null;
        v = op === '*' ? v * r : op === '/' ? v / r : v % r;
      }
      return v;
    }
    function parseFactor() { // right-associative power
      var v = parseUnary();
      if (v !== null && peek() === '^') { i++; var r = parseFactor(); if (r === null) return null; v = Math.pow(v, r); }
      return v;
    }
    function parseUnary() {
      if (peek() === '-') { i++; var v = parseUnary(); return v === null ? null : -v; }
      if (peek() === '+') { i++; return parseUnary(); }
      return parseAtom();
    }
    function parseAtom() {
      if (peek() === '(') {
        i++;
        var v = parseExpr();
        if (v === null || peek() !== ')') return null;
        i++;
        return v;
      }
      var m = /^\d+(\.\d+)?|^\.\d+/.exec(s.slice(i));
      if (!m) return null;
      i += m[0].length;
      return parseFloat(m[0]);
    }
    var out = parseExpr();
    if (out === null || i !== s.length || !isFinite(out)) return null;
    return out;
  }

  /** "1h 30m", "90 seconds", "5 min", bare "10" (= minutes) → seconds. */
  function parseDuration(text) {
    var s = String(text || '').toLowerCase();
    var total = 0, found = false;
    var re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      found = true;
      var n = parseFloat(m[1]), u = m[2][0];
      total += u === 'h' ? n * 3600 : u === 'm' ? n * 60 : n;
    }
    if (!found) {
      var bare = /(\d+(?:\.\d+)?)/.exec(s);
      if (!bare) return null;
      total = parseFloat(bare[1]) * 60;
    }
    total = Math.round(total);
    return total > 0 ? total : null;
  }

  /* ══════════════════════════ App SDK ══════════════════════════
   * A third-party app IS a file on the disk: /apps/<id>.app, a JSON manifest
   * describing a name, an icon, and a declarative UI of widgets. Buttons run
   * AIOS shell commands (so an app has exactly a user's powers — it can only
   * call the kernel, nothing else), $input values flow in, output flows back.
   * Installing an app is copying its manifest into /apps; the launcher reads
   * that directory. No code is ever eval'd — the UI is data, the actions are
   * shell strings run through the unit-tested interpreter. */

  var APP_WIDGETS = { label: 1, input: 1, button: 1, output: 1, number: 1 };

  /** Validate + normalise a manifest object into a safe app, or return null. */
  function normalizeApp(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var name = typeof obj.name === 'string' ? obj.name.slice(0, 40).trim() : '';
    if (!name) return null;
    var ui = Array.isArray(obj.ui) ? obj.ui.slice(0, 40) : [];
    var widgets = [];
    for (var i = 0; i < ui.length; i++) {
      var w = ui[i];
      if (!w || !APP_WIDGETS[w.type]) continue;
      var out = { type: w.type };
      if (typeof w.text === 'string') out.text = w.text.slice(0, 200);
      if (typeof w.name === 'string' && /^[A-Za-z_]\w*$/.test(w.name)) out.name = w.name;
      if (typeof w.placeholder === 'string') out.placeholder = w.placeholder.slice(0, 80);
      if (typeof w.run === 'string') out.run = w.run.slice(0, 400);
      if (typeof w.value === 'string') out.value = w.value.slice(0, 200);
      widgets.push(out);
    }
    return {
      name: name,
      emoji: typeof obj.emoji === 'string' ? obj.emoji.slice(0, 4) : '🧩',
      desc: typeof obj.desc === 'string' ? obj.desc.slice(0, 120) : '',
      ui: widgets
    };
  }

  function parseApp(text) {
    try { return normalizeApp(JSON.parse(text)); } catch (e) { return null; }
  }

  /** Every installed app: the .app files in /apps, id = filename without ext. */
  function listApps(state) {
    var r = fsList(state.fs, APPS_DIR);
    if (!r.ok) return [];
    var apps = [];
    for (var i = 0; i < r.entries.length; i++) {
      var e = r.entries[i];
      if (e.type !== 'file' || !/\.app$/.test(e.name)) continue;
      var rd = fsRead(state.fs, APPS_DIR + '/' + e.name);
      var app = rd.ok ? parseApp(rd.content) : null;
      if (app) { app.id = e.name.replace(/\.app$/, ''); apps.push(app); }
    }
    return apps;
  }

  function readApp(state, id) {
    var rd = fsRead(state.fs, APPS_DIR + '/' + id + '.app');
    if (!rd.ok) return null;
    var app = parseApp(rd.content);
    if (app) app.id = id;
    return app;
  }

  /* ══════════════════════════ Markdown ══════════════════════════ */

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** A small, safe Markdown renderer for Notes preview: #/##/### headings,
   *  **bold**, *italic*, `code`, ``` blocks, - lists, [text](https://…)
   *  links. ALL input is HTML-escaped first — a note can never inject
   *  markup — and links are restricted to http(s). */
  function renderMarkdown(md) {
    var lines = String(md || '').split('\n');
    var html = [], inCode = false, inList = false;
    function inline(s) {
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return s;
    }
    function closeList() { if (inList) { html.push('</ul>'); inList = false; } }
    for (var i = 0; i < lines.length; i++) {
      var rawLine = lines[i];
      if (/^```/.test(rawLine.trim())) {
        closeList();
        html.push(inCode ? '</code></pre>' : '<pre><code>');
        inCode = !inCode;
        continue;
      }
      var l = escapeHtml(rawLine);
      if (inCode) { html.push(l); continue; }
      var h = /^(#{1,3})\s+(.*)$/.exec(l);
      if (h) { closeList(); html.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }
      var li = /^[-*]\s+(.*)$/.exec(l);
      if (li) {
        if (!inList) { html.push('<ul>'); inList = true; }
        html.push('<li>' + inline(li[1]) + '</li>');
        continue;
      }
      closeList();
      if (l.trim()) html.push('<p>' + inline(l) + '</p>');
    }
    closeList();
    if (inCode) html.push('</code></pre>');
    return html.join('\n');
  }

  /* ══════════════════════════ Unit conversion ══════════════════════════ */

  // canonical factors: length→metres, mass→grams, data→bytes, time→seconds
  var UNITS = {
    km: { d: 'length', f: 1000, name: 'km' }, kilometre: { d: 'length', f: 1000, name: 'km' }, kilometer: { d: 'length', f: 1000, name: 'km' },
    m: { d: 'length', f: 1, name: 'm' }, metre: { d: 'length', f: 1, name: 'm' }, meter: { d: 'length', f: 1, name: 'm' },
    cm: { d: 'length', f: 0.01, name: 'cm' }, mm: { d: 'length', f: 0.001, name: 'mm' },
    mi: { d: 'length', f: 1609.344, name: 'miles' }, mile: { d: 'length', f: 1609.344, name: 'miles' },
    ft: { d: 'length', f: 0.3048, name: 'ft' }, foot: { d: 'length', f: 0.3048, name: 'ft' }, feet: { d: 'length', f: 0.3048, name: 'ft' },
    yd: { d: 'length', f: 0.9144, name: 'yd' }, yard: { d: 'length', f: 0.9144, name: 'yd' },
    inch: { d: 'length', f: 0.0254, name: 'in' }, inches: { d: 'length', f: 0.0254, name: 'in' }, 'in': { d: 'length', f: 0.0254, name: 'in' },
    kg: { d: 'mass', f: 1000, name: 'kg' }, kilogram: { d: 'mass', f: 1000, name: 'kg' },
    g: { d: 'mass', f: 1, name: 'g' }, gram: { d: 'mass', f: 1, name: 'g' },
    mg: { d: 'mass', f: 0.001, name: 'mg' },
    lb: { d: 'mass', f: 453.59237, name: 'lb' }, lbs: { d: 'mass', f: 453.59237, name: 'lb' }, pound: { d: 'mass', f: 453.59237, name: 'lb' }, pounds: { d: 'mass', f: 453.59237, name: 'lb' },
    oz: { d: 'mass', f: 28.349523125, name: 'oz' }, ounce: { d: 'mass', f: 28.349523125, name: 'oz' }, ounces: { d: 'mass', f: 28.349523125, name: 'oz' },
    st: { d: 'mass', f: 6350.29318, name: 'stone' }, stone: { d: 'mass', f: 6350.29318, name: 'stone' },
    b: { d: 'data', f: 1, name: 'B' }, kb: { d: 'data', f: 1024, name: 'KB' }, mb: { d: 'data', f: 1048576, name: 'MB' },
    gb: { d: 'data', f: 1073741824, name: 'GB' }, tb: { d: 'data', f: 1099511627776, name: 'TB' },
    c: { d: 'temp', name: '°C' }, celsius: { d: 'temp', name: '°C' }, '°c': { d: 'temp', name: '°C' },
    f: { d: 'temp', name: '°F' }, fahrenheit: { d: 'temp', name: '°F' }, '°f': { d: 'temp', name: '°F' },
    k: { d: 'temp', name: 'K' }, kelvin: { d: 'temp', name: 'K' }
  };

  function toCelsius(v, u) { return u === '°C' ? v : u === '°F' ? (v - 32) * 5 / 9 : v - 273.15; }
  function fromCelsius(v, u) { return u === '°C' ? v : u === '°F' ? v * 9 / 5 + 32 : v + 273.15; }

  /** "convert 5 km to miles" / "100f in c" / "2 gb in mb" → conversion or null. */
  function convertUnits(text) {
    var m = /(-?\d+(?:\.\d+)?)\s*°?\s*([a-z°]+)\s+(?:to|in|as)\s+°?\s*([a-z°]+)/.exec(String(text || '').toLowerCase());
    if (!m) return null;
    var v = parseFloat(m[1]);
    var from = UNITS[m[2]] || UNITS[m[2].replace(/s$/, '')];
    var to = UNITS[m[3]] || UNITS[m[3].replace(/s$/, '')];
    if (!from || !to || from.d !== to.d) return null;
    var out;
    if (from.d === 'temp') out = fromCelsius(toCelsius(v, from.name), to.name);
    else out = v * from.f / to.f;
    out = Math.round(out * 1e6) / 1e6;
    return { value: out, from: from.name, to: to.name, input: v };
  }

  /* ══════════════════════════ Date arithmetic ══════════════════════════ */

  var DAY_MS = 86400000;

  /** "90 days from now" / "3 weeks ago" / "in 2 months" (UTC) → info or null. */
  function dateMath(text, now) {
    var t = String(text || '').toLowerCase();
    var m = /(\d+)\s+(day|week|month|year)s?\s+(from now|from today|ago)/.exec(t) ||
            /in\s+(\d+)\s+(day|week|month|year)s?\b/.exec(t);
    if (!m) return null;
    var n = parseInt(m[1], 10), unit = m[2];
    var sign = m[3] === 'ago' ? -1 : 1;
    var d = new Date(now);
    if (unit === 'day') d = new Date(now + sign * n * DAY_MS);
    else if (unit === 'week') d = new Date(now + sign * n * 7 * DAY_MS);
    else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + sign * n);
    else d.setUTCFullYear(d.getUTCFullYear() + sign * n);
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return {
      ts: d.getTime(),
      text: days[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear(),
      phrase: n + ' ' + unit + (n === 1 ? '' : 's') + ' ' + (sign < 0 ? 'ago' : 'from now')
    };
  }

  /* ══════════════════════════ Intent router ══════════════════════════ */

  function matchApp(text, opts) {
    var exact = opts && opts.exact;
    var t = String(text || '').toLowerCase().trim().replace(/^the\s+/, '');
    var best = null, bestLen = 0;
    for (var id in APP_SYNONYMS) {
      var syns = APP_SYNONYMS[id];
      for (var i = 0; i < syns.length; i++) {
        var syn = syns[i];
        if ((t === syn || (!exact && t.indexOf(syn) !== -1)) && syn.length > bestLen) {
          best = appById(id); bestLen = syn.length;
        }
      }
    }
    return best;
  }

  /** Strip filler so "what is 2+2?" and "please calculate 2+2" both parse. */
  function calcCandidate(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/what\s*(is|'s|s)?|how much is|calculate|compute|equals?|please|\?|=/g, ' ')
      .trim();
  }

  /** Percent phrasing: "18% of 240" → 43.2 (handled before the raw parser). */
  function percentOf(text) {
    var m = /(\d+(?:\.\d+)?)\s*(?:%|percent)\s*of\s*(\d+(?:\.\d+)?)/.exec(String(text).toLowerCase());
    if (!m) return null;
    // kill float noise: 18% of 240 is 43.2, not 43.199999999999996
    return Math.round((parseFloat(m[1]) / 100) * parseFloat(m[2]) * 1e9) / 1e9;
  }

  /**
   * The offline AI: map an utterance to one typed intent.
   * Returns { type, ...args } — type is one of:
   *   open_app, calc, convert, datemath, timer, note, search, mkdir, time,
   *   workspace, set_name, set_accent, help, chat (the fallback).
   */
  function routeIntent(text) {
    var raw = String(text || '').trim();
    var t = raw.toLowerCase();
    if (!raw) return { type: 'chat' };

    // help
    if (/^(help|what can you do|commands)\b/.test(t)) return { type: 'help' };

    // time & date
    if (/\b(what time|the time|time is it|today'?s date|what day is it)\b/.test(t)) return { type: 'time' };

    // unit conversion before arithmetic ("5 km to miles" has no operator)
    var conv = convertUnits(t);
    if (conv) return { type: 'convert', conv: conv };

    // date arithmetic ("what date is 90 days from now")
    var dm = /\b\d+\s+(?:day|week|month|year)s?\s+(?:from now|from today|ago)\b/.test(t) || /\bin\s+\d+\s+(?:day|week|month|year)s?\b/.test(t);
    if (dm && !/\btimer|remind|every\b/.test(t)) return { type: 'datemath', text: t };

    // timer: "set a timer for 5 minutes", "remind me in 90 seconds", "timer 10"
    var tm = /(?:timer|remind me|countdown|alarm)(?:\s+(?:for|in|of))?\s+(.+)/.exec(t);
    if (/\b(timer|remind me|countdown|alarm)\b/.test(t)) {
      var secs = parseDuration(tm ? tm[1] : t);
      if (secs) {
        var label = /(?:to|about)\s+(.+)$/.exec(tm ? tm[1] : '');
        return { type: 'timer', seconds: secs, label: label ? label[1].replace(/[.?!]+$/, '') : '' };
      }
    }

    // workspaces: "switch to workspace 2", "go to desktop 3"
    var wm = /(?:workspace|desktop)\s+(\d)/.exec(t);
    if (wm && /\b(switch|go to|workspace|desktop|move to)\b/.test(t)) return { type: 'workspace', n: parseInt(wm[1], 10) };

    // notes: "note that X", "write down X", "take a note: X", "note about X"
    var nm = /^(?:take a note|make a note|write down|note|jot down|remember)\s*(?:that|about|of|:)?\s+(.+)$/.exec(raw.replace(/^please\s+/i, ''));
    if (nm) return { type: 'note', text: nm[1].replace(/[.?!]+$/, '') };

    // new folder: "create a folder called X", "new folder X", "make a directory X"
    var fm = /(?:create|make|new)\s+(?:a\s+)?(?:folder|directory|dir)\s*(?:called|named|:)?\s+(.+)/.exec(raw.replace(/^please\s+/i, ''));
    if (fm) return { type: 'mkdir', name: fm[1].replace(/[.?!"']+$/, '').replace(/^["']/, '') };

    // content search: "search for milk in my notes", "find budget in my files"
    var cs = /^(?:find|search|grep)\s*(?:for)?\s+(.+?)\s+in\s+(?:my\s+)?(?:files|notes|documents|disk)\b/.exec(t);
    if (cs) return { type: 'content_search', q: cs[1].replace(/["']/g, '') };

    // search: "find invoices", "search for welcome", "where is my note about x"
    var sm = /^(?:find|search|look)\s*(?:for|up)?\s+(.+)$/.exec(t) || /where(?:'s| is| are)\s+(?:my\s+)?(.+)$/.exec(t);
    if (sm) return { type: 'search', q: sm[1].replace(/[.?!]+$/, '').replace(/^(the|my|a)\s+/, '') };

    // personalisation
    var name = /(?:call me|my name is|i am|i'm)\s+([a-z][a-z0-9 _-]{0,23})/i.exec(raw);
    if (name) return { type: 'set_name', name: name[1].trim() };
    var acc = new RegExp('\\b(' + ACCENTS.join('|') + ')\\b').exec(t);
    if (acc && /\b(accent|theme|colou?r|wallpaper)\b/.test(t)) return { type: 'set_accent', accent: acc[1] };

    // open an app: "open notes", "launch the terminal", "show settings"
    var om = /^(?:open|launch|start|show|go to|run)\s+(.+)$/.exec(t);
    if (om) {
      var app = matchApp(om[1]);
      if (app) return { type: 'open_app', app: app.id };
    }

    // arithmetic — percent phrasing first, then the raw parser
    var pct = percentOf(t);
    if (pct !== null) return { type: 'calc', value: pct, expr: raw };
    var cand = calcCandidate(raw);
    if (/[0-9]/.test(cand) && /[+\-*/%^×÷−]/.test(cand)) {
      var val = calcEval(cand);
      if (val !== null) return { type: 'calc', value: val, expr: cand };
    }

    // bare app name still opens it ("terminal", "the files")
    var bare = matchApp(t);
    if (bare && t.split(/\s+/).length <= 3) return { type: 'open_app', app: bare.id };

    return { type: 'chat' };
  }

  function slugify(text) {
    var s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return s || 'note';
  }

  function fmtNum(n) {
    var r = Math.round(n * 1e6) / 1e6;
    return String(r);
  }

  function fmtDuration(secs) {
    if (secs % 3600 === 0) return (secs / 3600) + (secs === 3600 ? ' hour' : ' hours');
    if (secs % 60 === 0) return (secs / 60) + (secs === 60 ? ' minute' : ' minutes');
    return secs + ' seconds';
  }

  /** Execute ONE routed intent against the OS state. */
  function runIntent(state, intent, text, now) {
    switch (intent.type) {
      case 'help':
        return {
          reply: 'I am the OS. Try:\n' +
            '  • "open the terminal" / "open notes"\n' +
            '  • "what\'s 18% of 240" or any arithmetic\n' +
            '  • "convert 5 km to miles" · "100f in c" · "2gb in mb"\n' +
            '  • "what date is 90 days from now"\n' +
            '  • "set a timer for 5 minutes"\n' +
            '  • "note that the demo is on Friday"\n' +
            '  • "create a folder called invoices" then "open the files"\n' +
            '  • "find welcome" to search your files\n' +
            '  • "switch to workspace 2" · "call me Ada" · "set the accent to teal"\n' +
            'Chain steps with "then". The Terminal can do even more — pipes,\n' +
            'trash/restore, and `every 30m <cmd>` automations.',
          actions: []
        };

      case 'time': {
        var d = new Date(now);
        return { reply: 'It is ' + d.toUTCString() + '.', actions: [] };
      }

      case 'open_app': {
        var app = appById(intent.app);
        return { reply: 'Opening ' + app.name + '.', actions: [{ type: 'open', app: intent.app }] };
      }

      case 'calc':
        return { reply: intent.expr.trim() + ' = ' + fmtNum(intent.value), actions: [] };

      case 'convert': {
        var cv = intent.conv;
        return { reply: cv.input + ' ' + cv.from + ' = ' + cv.value + ' ' + cv.to, actions: [] };
      }

      case 'datemath': {
        var dmr = dateMath(intent.text, now);
        if (!dmr) return { reply: 'I couldn\'t work out that date.', actions: [] };
        return { reply: dmr.phrase + ' is ' + dmr.text + '.', actions: [] };
      }

      case 'timer':
        return {
          reply: 'Timer set for ' + fmtDuration(intent.seconds) + (intent.label ? ' — ' + intent.label : '') + '. I\'ll notify you.',
          actions: [{ type: 'timer', seconds: intent.seconds, label: intent.label || 'Timer' }]
        };

      case 'note': {
        var base = '/home/user/notes/' + slugify(intent.text.split(/\s+/).slice(0, 5).join(' '));
        var path = base + '.txt', n = 2;
        while (fsGet(state.fs, path)) path = base + '-' + (n++) + '.txt';
        fsWrite(state.fs, path, intent.text + '\n', now);
        return { reply: 'Noted — saved to ' + path + '.', actions: [{ type: 'open', app: 'notes', arg: path }] };
      }

      case 'mkdir': {
        var dir = normalizePath(state.cwd, slugify(intent.name));
        var made = fsMkdir(state.fs, dir, now, { parents: true });
        if (!made.ok) return { reply: 'I couldn\'t: ' + made.error, actions: [] };
        return { reply: 'Created ' + dir + '/.', actions: [{ type: 'open', app: 'files', arg: dir }] };
      }

      case 'search': {
        var hits = fsFind(state.fs, intent.q);
        if (!hits.length) return { reply: 'Nothing on the disk matches “' + intent.q + '”.', actions: [] };
        return {
          reply: 'Found ' + hits.length + ' match' + (hits.length === 1 ? '' : 'es') + ':\n  ' + hits.slice(0, 8).join('\n  ') + (hits.length > 8 ? '\n  …' : ''),
          actions: []
        };
      }

      case 'content_search': {
        var chits = fsGrep(state.fs, intent.q);
        if (!chits.length) return { reply: 'No file contains “' + intent.q + '”.', actions: [] };
        var clines = chits.slice(0, 8).map(function (h) { return h.path + ':' + h.line + ' — ' + h.text; });
        return {
          reply: 'Found “' + intent.q + '” in ' + chits.length + ' place' + (chits.length === 1 ? '' : 's') + ':\n  ' + clines.join('\n  ') + (chits.length > 8 ? '\n  …' : ''),
          actions: []
        };
      }

      case 'workspace':
        switchWorkspace(state, intent.n);
        return { reply: 'Workspace ' + state.ws + '.', actions: [] };

      case 'set_name':
        state.settings.owner = intent.name.slice(0, 24);
        return { reply: 'Done — I\'ll call you ' + state.settings.owner + '.', actions: [] };

      case 'set_accent':
        state.settings.accent = intent.accent;
        return { reply: 'Accent set to ' + intent.accent + '.', actions: [{ type: 'accent', accent: intent.accent }] };

      default:
        return {
          reply: 'I run this OS, so I\'m best at doing things: opening apps, taking notes, timers, maths, conversions, dates, and finding files. Say "help" for the full list' +
            ' — or enable Live AI in my window for open conversation.',
          actions: []
        };
    }
  }

  /**
   * The assistant: route the utterance, EXECUTE it against the OS state, and
   * return { reply, actions }. Compound requests chain with "then":
   * "create a folder called reports then open the files" runs both, in order.
   * (A leading note is never split — "note that do X then Y" stays one note.)
   */
  function assistant(state, text, now) {
    var raw = String(text || '');
    if (raw.trim()) logJournal(state, 'ai', raw.trim(), now);
    var segs = raw.split(/\s+(?:and\s+then|then)\s+/i);
    if (segs.length > 1 && routeIntent(segs[0]).type !== 'note') {
      var replies = [], actions = [];
      for (var i = 0; i < segs.length; i++) {
        var r = runIntent(state, routeIntent(segs[i]), segs[i], now);
        replies.push(r.reply);
        actions = actions.concat(r.actions);
      }
      return { reply: replies.join('\n'), actions: actions };
    }
    return runIntent(state, routeIntent(raw), raw, now);
  }

  /* ══════════════════════════ exports ══════════════════════════ */

  return {
    VERSION: VERSION,
    APPS: APPS,
    ACCENTS: ACCENTS,
    WS_COUNT: WS_COUNT,
    TRASH: TRASH,
    DESKTOP: DESKTOP,
    appById: appById,
    // vfs
    normalizePath: normalizePath,
    splitPath: splitPath,
    createFS: createFS,
    fsGet: fsGet,
    fsMkdir: fsMkdir,
    fsWrite: fsWrite,
    fsRead: fsRead,
    fsRemove: fsRemove,
    fsTrash: fsTrash,
    fsRestore: fsRestore,
    fsEmptyTrash: fsEmptyTrash,
    fsMove: fsMove,
    fsCopy: fsCopy,
    fsList: fsList,
    fsFind: fsFind,
    fsGrep: fsGrep,
    fsTree: fsTree,
    // kernel
    boot: boot,
    serialize: serialize,
    deserialize: deserialize,
    // ballrz catalog
    BALLRZ_APPS: BALLRZ_APPS,
    BALLRZ_CATEGORIES: BALLRZ_CATEGORIES,
    FEATURED_APPS: FEATURED_APPS,
    searchCatalog: searchCatalog,
    decideLayout: decideLayout,
    ballrzAppById: ballrzAppById,
    installWebapp: installWebapp,
    uninstallWebapp: uninstallWebapp,
    isInstalled: isInstalled,
    // widgets
    WIDGETS: WIDGETS,
    widgetById: widgetById,
    addWidget: addWidget,
    removeWidget: removeWidget,
    widgetData: widgetData,
    // notification centre
    pushNotice: pushNotice,
    unreadNotices: unreadNotices,
    markNoticesRead: markNoticesRead,
    clearNotices: clearNotices,
    // mobile home screen
    DOCK_FAVORITES: DOCK_FAVORITES,
    springboard: springboard,
    // desktop icons
    desktopEntries: desktopEntries,
    defaultIconPos: defaultIconPos,
    iconPos: iconPos,
    setIconPos: setIconPos,
    pruneIconPos: pruneIconPos,
    // processes
    spawn: spawn,
    findProc: findProc,
    focusProc: focusProc,
    minimizeProc: minimizeProc,
    closeProc: closeProc,
    maximizeProc: maximizeProc,
    snapProc: snapProc,
    floatProc: floatProc,
    switchWorkspace: switchWorkspace,
    moveToWorkspace: moveToWorkspace,
    topProc: topProc,
    // automations
    addAutomation: addAutomation,
    removeAutomation: removeAutomation,
    toggleAutomation: toggleAutomation,
    dueAutomations: dueAutomations,
    // shell
    tokenize: tokenize,
    execCommand: execCommand,
    runScript: runScript,
    evalCond: evalCond,
    expandVars: expandVars,
    // app sdk
    APPS_DIR: APPS_DIR,
    parseApp: parseApp,
    normalizeApp: normalizeApp,
    listApps: listApps,
    readApp: readApp,
    logJournal: logJournal,
    renderMarkdown: renderMarkdown,
    // intelligence
    calcEval: calcEval,
    parseDuration: parseDuration,
    convertUnits: convertUnits,
    dateMath: dateMath,
    routeIntent: routeIntent,
    matchApp: matchApp,
    assistant: assistant,
    slugify: slugify
  };
});
