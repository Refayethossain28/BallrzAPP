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

  var VERSION = '2.0.0';
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
    '  • Press Ctrl/Cmd-K anywhere and just say what you want.\n';

  function createFS(now) {
    var fs = { root: dirNode(now), trash: {} };
    fsMkdir(fs, '/home/user/notes', now, { parents: true });
    fsMkdir(fs, '/home/user/projects', now, { parents: true });
    fsMkdir(fs, '/etc', now);
    fsMkdir(fs, TRASH, now);
    fsWrite(fs, '/home/user/notes/welcome.txt', WELCOME, now);
    fsWrite(fs, '/etc/motd', 'AIOS ' + VERSION + ' — the OS that listens.', now);
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
      settings: { owner: 'user', accent: 'violet' },
      bootedAt: now
    };
  }

  /** Persist what is durable: the disk, settings and automations. Windows
   *  are runtime state — a reboot starts with a clean desktop, like a real OS. */
  function serialize(state) {
    return JSON.stringify({
      v: 2,
      fs: state.fs,
      cwd: state.cwd,
      settings: state.settings,
      automations: state.automations,
      nextAutoId: state.nextAutoId
    });
  }

  function deserialize(json, now) {
    var state = boot(now);
    try {
      var data = JSON.parse(json);
      if (!data || (data.v !== 1 && data.v !== 2) || !data.fs || !data.fs.root || data.fs.root.type !== 'dir') return state;
      state.fs = data.fs;
      if (!state.fs.trash || typeof state.fs.trash !== 'object') state.fs.trash = {};
      if (!fsGet(state.fs, TRASH)) fsMkdir(state.fs, TRASH, now); // v1 disks predate the trash
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
    } catch (e) { /* corrupt snapshot → fresh boot */ }
    return state;
  }

  /* ══════════════════════════ Processes / windows ══════════════════════════ */

  function procKey(appId, arg) { return appId === 'notes' && arg ? appId + ':' + arg : appId; }

  /** Spawn (or refocus) an app on the CURRENT workspace. Apps are singletons
   *  per workspace-agnostic key; re-spawning pulls the window to the active
   *  workspace. Placement cascades deterministically from the spawn ordinal. */
  function spawn(state, appId, arg) {
    var app = appById(appId);
    if (!app) return { ok: false, error: 'no such app: ' + appId };
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
    'Pipes:  any command | grep [-i|-v] <text> | head [-n N] | tail [-n N]',
    '        | sort [-r] | uniq [-c] | wc      Redirect:  any pipeline > file (>> appends)',
    'Also: date · whoami · uname · clear · help'
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

  /**
   * Execute one command line — including `a | b | c` pipelines and a
   * trailing `> file` / `>> file` redirection on any pipeline. Returns
   * { out: string[], error: bool, effects: [{type:'open'|'clear'|'timer'|...}] }.
   */
  function execCommand(state, input, now) {
    var toks = tokenize(String(input || ''));
    if (!toks.length) return { out: [], error: false, effects: [] };

    // `every` and `ai` take a whole command / sentence as their argument —
    // pipes and redirection belong to THAT inner command, not this line
    // (`every 1h echo tick >> log.txt` must store the >> too).
    if (toks[0] === 'every' || toks[0] === 'ai') return runSimple(state, toks, now);

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
    fsTree: fsTree,
    // kernel
    boot: boot,
    serialize: serialize,
    deserialize: deserialize,
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
