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
 * The four subsystems
 * -------------------
 *   VFS       a hierarchical virtual file system — directories, files,
 *             timestamps, path resolution with `.` and `..`, move/copy with
 *             cycle protection, search — fully serializable so the desktop
 *             can persist it on-device.
 *   Processes a window manager's brain: spawn/focus/minimize/close with a
 *             z-order stack, singleton-per-app rules (Notes is per-file) and
 *             deterministic cascade placement.
 *   Shell     a real tokenizer (quotes, redirection) and a coreutils-style
 *             command set (ls, cd, cat, echo >, mkdir -p, rm -r, mv, cp,
 *             find, ps, kill, open …) executed against the VFS + processes.
 *   Intent    the AI layer that works with no network and no key: a
 *   router    rule-based natural-language router ("open notes", "what's
 *             18% of 240", "set a timer for 5 minutes", "note that …") with
 *             a from-scratch arithmetic parser — no eval(), ever. The
 *             desktop's optional Live AI mode swaps in a real model behind
 *             the same action vocabulary, so the OS treats both identically.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AiosKernel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ══════════════════════════ App registry ══════════════════════════ */

  var APPS = [
    { id: 'files',     name: 'Files',     emoji: '🗂️', desc: 'Browse the virtual file system' },
    { id: 'terminal',  name: 'Terminal',  emoji: '⌨️', desc: 'The AIOS shell' },
    { id: 'notes',     name: 'Notes',     emoji: '📝', desc: 'Edit text files' },
    { id: 'assistant', name: 'Assistant', emoji: '✦',  desc: 'Talk to the OS in plain English' },
    { id: 'monitor',   name: 'Monitor',   emoji: '📊', desc: 'Processes and system state' },
    { id: 'settings',  name: 'Settings',  emoji: '⚙️', desc: 'Personalise AIOS' },
    { id: 'about',     name: 'About',     emoji: '🛈',  desc: 'About this OS' }
  ];
  // Spoken names the intent router also accepts, per app.
  var APP_SYNONYMS = {
    files: ['files', 'file manager', 'finder', 'explorer', 'file system'],
    terminal: ['terminal', 'shell', 'console', 'command line', 'cli'],
    notes: ['notes', 'note', 'notepad', 'editor', 'text editor'],
    assistant: ['assistant', 'ai', 'chat', 'help me'],
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

  /* ══════════════════════════ Boot & persistence ══════════════════════════ */

  var WELCOME =
    'Welcome to AIOS — the AI operating system.\n' +
    '\n' +
    'Everything here runs on your device: the file system, the window\n' +
    'manager, the shell and the assistant are all part of one small,\n' +
    'deterministic kernel.\n' +
    '\n' +
    'Things to try:\n' +
    '  • Open the Terminal and type `help`.\n' +
    '  • Ask the Assistant to "set a timer for 2 minutes" or\n' +
    '    "note that AIOS is alive".\n' +
    '  • Press Ctrl/Cmd-K anywhere and just say what you want.\n';

  function createFS(now) {
    var fs = { root: dirNode(now) };
    fsMkdir(fs, '/home/user/notes', now, { parents: true });
    fsMkdir(fs, '/home/user/projects', now, { parents: true });
    fsMkdir(fs, '/etc', now);
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
      settings: { owner: 'user', accent: 'violet' },
      bootedAt: now
    };
  }

  /** Persist only what is durable: the disk and the settings. Windows are
   *  runtime state — a reboot starts with a clean desktop, like a real OS. */
  function serialize(state) {
    return JSON.stringify({ v: 1, fs: state.fs, cwd: state.cwd, settings: state.settings });
  }

  function deserialize(json, now) {
    var state = boot(now);
    try {
      var data = JSON.parse(json);
      if (!data || data.v !== 1 || !data.fs || !data.fs.root || data.fs.root.type !== 'dir') return state;
      state.fs = data.fs;
      if (typeof data.cwd === 'string' && fsGet(state.fs, data.cwd)) state.cwd = data.cwd;
      if (data.settings && typeof data.settings === 'object') {
        if (typeof data.settings.owner === 'string' && data.settings.owner) state.settings.owner = data.settings.owner.slice(0, 24);
        if (ACCENTS.indexOf(data.settings.accent) !== -1) state.settings.accent = data.settings.accent;
      }
    } catch (e) { /* corrupt snapshot → fresh boot */ }
    return state;
  }

  /* ══════════════════════════ Processes / windows ══════════════════════════ */

  function procKey(appId, arg) { return appId === 'notes' && arg ? appId + ':' + arg : appId; }

  /** Spawn (or refocus) an app. Apps are singletons; Notes is one window per
   *  file. Placement cascades deterministically from the spawn ordinal. */
  function spawn(state, appId, arg) {
    var app = appById(appId);
    if (!app) return { ok: false, error: 'no such app: ' + appId };
    var key = procKey(appId, arg);
    for (var i = 0; i < state.procs.length; i++) {
      if (procKey(state.procs[i].app, state.procs[i].arg) === key) {
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

  /** The window that owns the keyboard: highest z among the unminimized. */
  function topProc(state) {
    var top = null;
    for (var i = 0; i < state.procs.length; i++) {
      var p = state.procs[i];
      if (!p.minimized && (!top || p.z > top.z)) top = p;
    }
    return top;
  }

  /* ══════════════════════════ Shell ══════════════════════════ */

  /** Tokenize a command line: whitespace-separated, '"' and "'" quote, and
   *  the redirection operators > and >> are their own tokens even unspaced. */
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
      cur += ch; has = true;
    }
    push();
    return toks;
  }

  var HELP = [
    'AIOS shell — commands:',
    '  ls [path]        list a directory        pwd              print working dir',
    '  cd [path]        change directory        cat <file>       print a file',
    '  echo <text> [> f | >> f]                 write / append with redirection',
    '  mkdir [-p] <dir> make directories        touch <file>     create empty file',
    '  rm [-r] <path>   remove                  mv <a> <b>       move / rename',
    '  cp <a> <b>       copy                    find <text>      search file names',
    '  open <app|file>  open an app or file     ps / kill <pid>  processes',
    '  ai <request>     ask the OS in English   date · whoami · uname · clear · help'
  ];

  /** Execute one command line against the OS state. Returns
   *  { out: string[], error: bool, effects: [{type:'open'|'clear'|'timer'|...}] }. */
  function execCommand(state, input, now) {
    var toks = tokenize(String(input || ''));
    if (!toks.length) return { out: [], error: false, effects: [] };
    var cmd = toks[0], args = toks.slice(1);
    var out = [], effects = [];
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

      case 'echo': {
        var gt = args.indexOf('>'), ap = args.indexOf('>>');
        var op = ap !== -1 ? '>>' : (gt !== -1 ? '>' : null);
        var at = ap !== -1 ? ap : gt;
        if (op) {
          var file = args[at + 1];
          if (!file) return err('echo: missing file after ' + op);
          var text = args.slice(0, at).join(' ');
          var w = fsWrite(state.fs, P(file), text + '\n', now, { append: op === '>>' });
          if (!w.ok) return err('echo: ' + w.error);
          return { out: [], error: false, effects: [] };
        }
        return { out: [args.join(' ')], error: false, effects: [] };
      }

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
          var rmr = fsRemove(state.fs, P(targets[x]), { recursive: rec });
          if (!rmr.ok) return err('rm: ' + rmr.error);
        }
        return { out: [], error: false, effects: [] };
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
        out.push('PID  APP        TITLE');
        for (var pi = 0; pi < state.procs.length; pi++) {
          var pr = state.procs[pi];
          out.push(String(pr.pid).padEnd(4) + ' ' + pr.app.padEnd(10) + ' ' + pr.title + (pr.minimized ? '  (minimized)' : ''));
        }
        return { out: out, error: false, effects: [] };
      }

      case 'kill': {
        var pid = parseInt(args[0], 10);
        if (!pid || !findProc(state, pid)) return err('kill: no such pid: ' + args[0]);
        closeProc(state, pid);
        return { out: ['killed ' + pid], error: false, effects: [] };
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
        return err(cmd + ': command not found — try `help`, or `ai ' + input.replace(/`/g, '') + '`');
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
   *   open_app, calc, timer, note, search, mkdir, time, set_name,
   *   set_accent, help, chat (the fallback).
   */
  function routeIntent(text) {
    var raw = String(text || '').trim();
    var t = raw.toLowerCase();
    if (!raw) return { type: 'chat' };

    // help
    if (/^(help|what can you do|commands)\b/.test(t)) return { type: 'help' };

    // time & date
    if (/\b(what time|the time|time is it|today'?s date|what day)\b/.test(t)) return { type: 'time' };

    // timer: "set a timer for 5 minutes", "remind me in 90 seconds", "timer 10"
    var tm = /(?:timer|remind me|countdown|alarm)(?:\s+(?:for|in|of))?\s+(.+)/.exec(t);
    if (/\b(timer|remind me|countdown|alarm)\b/.test(t)) {
      var secs = parseDuration(tm ? tm[1] : t);
      if (secs) {
        var label = /(?:to|about)\s+(.+)$/.exec(tm ? tm[1] : '');
        return { type: 'timer', seconds: secs, label: label ? label[1].replace(/[.?!]+$/, '') : '' };
      }
    }

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

  /**
   * The assistant: route the utterance, EXECUTE it against the OS state, and
   * return { reply, actions } — actions are the same effect objects the shell
   * emits, so the desktop applies both through one code path.
   */
  function assistant(state, text, now) {
    var intent = routeIntent(text);
    switch (intent.type) {
      case 'help':
        return {
          reply: 'I am the OS. Try:\n' +
            '  • "open the terminal" / "open notes"\n' +
            '  • "what\'s 18% of 240" or any arithmetic\n' +
            '  • "set a timer for 5 minutes"\n' +
            '  • "note that the demo is on Friday"\n' +
            '  • "create a folder called invoices"\n' +
            '  • "find welcome" to search your files\n' +
            '  • "call me Ada" · "set the accent to teal"',
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

      case 'set_name':
        state.settings.owner = intent.name.slice(0, 24);
        return { reply: 'Done — I\'ll call you ' + state.settings.owner + '.', actions: [] };

      case 'set_accent':
        state.settings.accent = intent.accent;
        return { reply: 'Accent set to ' + intent.accent + '.', actions: [{ type: 'accent', accent: intent.accent }] };

      default:
        return {
          reply: 'I run this OS, so I\'m best at doing things: opening apps, taking notes, timers, maths, and finding files. Say "help" for the full list' +
            ' — or enable Live AI in my window for open conversation.',
          actions: []
        };
    }
  }

  /* ══════════════════════════ exports ══════════════════════════ */

  return {
    VERSION: VERSION,
    APPS: APPS,
    ACCENTS: ACCENTS,
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
    fsMove: fsMove,
    fsCopy: fsCopy,
    fsList: fsList,
    fsFind: fsFind,
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
    topProc: topProc,
    // shell
    tokenize: tokenize,
    execCommand: execCommand,
    // intelligence
    calcEval: calcEval,
    parseDuration: parseDuration,
    routeIntent: routeIntent,
    matchApp: matchApp,
    assistant: assistant,
    slugify: slugify
  };
});
