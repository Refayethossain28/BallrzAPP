#!/usr/bin/env node
/**
 * Unit tests for aios/engine.js — the AIOS kernel. Covers the four
 * subsystems: the virtual file system (paths, mkdir/write/read/rm/mv/cp,
 * listing, search, serialization), the process/window manager (spawn
 * singletons, z-order focus, minimize/close), the shell (tokenizer,
 * coreutils commands, redirection, effects), and the offline intelligence
 * (the no-eval arithmetic parser, duration parsing, the intent router and
 * the assistant's real side effects on OS state).
 * Loaded in a vm sandbox (repo is type:module). Run: node scripts/test-aios-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'aios', 'engine.js'), 'utf8'), sandbox, { filename: 'aios/engine.js' });
const K = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const T0 = Date.UTC(2026, 6, 24, 12, 0, 0); // fixed clock — the kernel never reads one
// Values built inside the vm realm have foreign prototypes, so strict deep
// equality against test-realm literals always fails — compare JSON shapes.
const deq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);

/* ══════════ paths ══════════ */

test('normalizePath resolves ., .., ~, relative and absolute paths', () => {
  assert.equal(K.normalizePath('/home/user', 'notes'), '/home/user/notes');
  assert.equal(K.normalizePath('/home/user', '/etc'), '/etc');
  assert.equal(K.normalizePath('/home/user', '..'), '/home');
  assert.equal(K.normalizePath('/home/user', '../../..'), '/', '.. clamps at root');
  assert.equal(K.normalizePath('/home/user', './a/./b/../c'), '/home/user/a/c');
  assert.equal(K.normalizePath('/etc', '~'), '/home/user');
  assert.equal(K.normalizePath('/etc', '~/notes'), '/home/user/notes');
  assert.equal(K.normalizePath('/a', ''), '/a', 'empty path = stay put');
  assert.equal(K.normalizePath('/a/b', 'x//y///z'), '/a/b/x/y/z', 'duplicate slashes collapse');
});

test('splitPath separates parent and leaf', () => {
  deq(K.splitPath('/a/b/c'), { parent: '/a/b', name: 'c' });
  deq(K.splitPath('/c'), { parent: '/', name: 'c' });
});

/* ══════════ VFS ══════════ */

test('boot seeds a disk: home dirs, welcome note, motd', () => {
  const st = K.boot(T0);
  assert.equal(st.cwd, '/home/user');
  assert.equal(K.fsGet(st.fs, '/home/user/notes').type, 'dir');
  assert.ok(K.fsRead(st.fs, '/home/user/notes/welcome.txt').content.includes('AIOS'));
  assert.ok(K.fsRead(st.fs, '/etc/motd').ok);
});

test('mkdir: plain requires parent, -p builds the chain, dup rejected', () => {
  const fs = K.createFS(T0);
  assert.equal(K.fsMkdir(fs, '/a/b/c', T0).ok, false, 'missing parents');
  assert.equal(K.fsMkdir(fs, '/a/b/c', T0, { parents: true }).ok, true);
  assert.equal(K.fsGet(fs, '/a/b/c').type, 'dir');
  assert.equal(K.fsMkdir(fs, '/a/b/c', T0).ok, false, 'already exists');
  assert.equal(K.fsMkdir(fs, '/a/b/c', T0, { parents: true }).ok, true, '-p is idempotent');
  assert.equal(K.fsMkdir(fs, '/etc/motd/x', T0, { parents: true }).ok, false, 'file in the way');
});

test('write/read/append round-trip; dir targets rejected', () => {
  const fs = K.createFS(T0);
  assert.equal(K.fsWrite(fs, '/home/user/a.txt', 'one', T0).ok, true);
  assert.equal(K.fsRead(fs, '/home/user/a.txt').content, 'one');
  assert.equal(K.fsWrite(fs, '/home/user/a.txt', 'two', T0 + 1).ok, true, 'overwrite');
  assert.equal(K.fsRead(fs, '/home/user/a.txt').content, 'two');
  K.fsWrite(fs, '/home/user/a.txt', '+three', T0 + 2, { append: true });
  assert.equal(K.fsRead(fs, '/home/user/a.txt').content, 'two+three');
  assert.equal(K.fsWrite(fs, '/home/user/notes', 'x', T0).ok, false, 'target is a dir');
  assert.equal(K.fsWrite(fs, '/nowhere/a.txt', 'x', T0).ok, false, 'parent missing');
  assert.equal(K.fsRead(fs, '/home/user/notes').ok, false, 'read a dir fails');
  assert.equal(K.fsRead(fs, '/ghost').ok, false);
});

test('rm: empty dir ok, non-empty needs -r, / protected', () => {
  const fs = K.createFS(T0);
  assert.equal(K.fsRemove(fs, '/').ok, false);
  assert.equal(K.fsRemove(fs, '/home/user/notes').ok, false, 'not empty');
  assert.equal(K.fsRemove(fs, '/home/user/notes', { recursive: true }).ok, true);
  assert.equal(K.fsGet(fs, '/home/user/notes'), null);
  assert.equal(K.fsRemove(fs, '/home/user/projects').ok, true, 'empty dir, no -r needed');
  assert.equal(K.fsRemove(fs, '/ghost').ok, false);
});

test('mv renames, moves into an existing dir, refuses self-swallowing', () => {
  const fs = K.createFS(T0);
  K.fsWrite(fs, '/home/user/a.txt', 'hi', T0);
  assert.equal(K.fsMove(fs, '/home/user/a.txt', '/home/user/b.txt', T0).ok, true, 'rename');
  assert.equal(K.fsGet(fs, '/home/user/a.txt'), null);
  const into = K.fsMove(fs, '/home/user/b.txt', '/home/user/notes', T0);
  assert.equal(into.ok, true);
  assert.equal(into.to, '/home/user/notes/b.txt', 'existing dir target means into it');
  assert.equal(K.fsRead(fs, '/home/user/notes/b.txt').content, 'hi');
  assert.equal(K.fsMove(fs, '/home', '/home/user/inside', T0).ok, false, 'dir into its own subtree');
  assert.equal(K.fsMove(fs, '/ghost', '/x', T0).ok, false);
});

test('cp deep-copies — editing the copy leaves the original alone', () => {
  const fs = K.createFS(T0);
  K.fsMkdir(fs, '/home/user/proj', T0);
  K.fsWrite(fs, '/home/user/proj/f.txt', 'v1', T0);
  assert.equal(K.fsCopy(fs, '/home/user/proj', '/home/user/proj2', T0).ok, true);
  K.fsWrite(fs, '/home/user/proj2/f.txt', 'v2', T0);
  assert.equal(K.fsRead(fs, '/home/user/proj/f.txt').content, 'v1', 'original untouched');
  assert.equal(K.fsCopy(fs, '/home/user/proj', '/home/user/proj', T0).ok, false, 'self copy');
});

test('ls sorts dirs first then files, both alphabetical, with sizes', () => {
  const fs = K.createFS(T0);
  K.fsWrite(fs, '/home/user/zz.txt', '12345', T0);
  K.fsWrite(fs, '/home/user/aa.txt', '1', T0);
  const r = K.fsList(fs, '/home/user');
  assert.equal(r.ok, true);
  const names = r.entries.map((e) => e.name);
  deq(names, ['Desktop', 'notes', 'projects', 'aa.txt', 'zz.txt']);
  assert.equal(r.entries.find((e) => e.name === 'zz.txt').size, 5);
  assert.equal(K.fsList(fs, '/etc/motd').ok, false, 'ls a file fails');
});

test('find is case-insensitive, marks dirs with a trailing /', () => {
  const fs = K.createFS(T0);
  K.fsMkdir(fs, '/home/user/Invoices', T0);
  K.fsWrite(fs, '/home/user/Invoices/inv-jan.txt', '', T0);
  const hits = K.fsFind(fs, 'INV');
  deq(hits, ['/home/user/Invoices/', '/home/user/Invoices/inv-jan.txt']);
  deq(K.fsFind(fs, 'zzz-nope'), []);
});

test('serialize → deserialize round-trips the disk, cwd and settings; junk falls back to a fresh boot', () => {
  const st = K.boot(T0);
  K.fsWrite(st.fs, '/home/user/keep.txt', 'kept', T0);
  st.cwd = '/etc';
  st.settings.owner = 'Ada';
  st.settings.accent = 'teal';
  K.spawn(st, 'terminal');
  const st2 = K.deserialize(K.serialize(st), T0 + 999);
  assert.equal(K.fsRead(st2.fs, '/home/user/keep.txt').content, 'kept');
  assert.equal(st2.cwd, '/etc');
  assert.equal(st2.settings.owner, 'Ada');
  assert.equal(st2.settings.accent, 'teal');
  assert.equal(st2.procs.length, 0, 'windows are runtime state, not persisted');
  const fresh = K.deserialize('{"corrupt', T0);
  assert.ok(K.fsRead(fresh.fs, '/home/user/notes/welcome.txt').ok, 'corrupt snapshot → fresh boot');
  const hostile = K.deserialize(JSON.stringify({ v: 1, fs: { root: { type: 'file', content: 'x' } } }), T0);
  assert.equal(hostile.fs.root.type, 'dir', 'invalid root rejected');
});

/* ══════════ processes ══════════ */

test('spawn: cascade placement, singleton per app, focus bumps z', () => {
  const st = K.boot(T0);
  const a = K.spawn(st, 'terminal');
  const b = K.spawn(st, 'files');
  assert.equal(a.proc.pid, 1);
  assert.equal(b.proc.pid, 2);
  assert.ok(b.proc.z > a.proc.z, 'newer window on top');
  assert.notDeepEqual([a.proc.x, a.proc.y], [b.proc.x, b.proc.y], 'cascade offsets');
  const again = K.spawn(st, 'terminal');
  assert.equal(again.existing, true);
  assert.equal(st.procs.length, 2, 'no duplicate window');
  assert.ok(again.proc.z > b.proc.z, 're-spawn refocuses');
  assert.equal(K.spawn(st, 'nope').ok, false);
});

test('notes is one window per file; different files coexist', () => {
  const st = K.boot(T0);
  const a = K.spawn(st, 'notes', '/home/user/a.txt');
  const b = K.spawn(st, 'notes', '/home/user/b.txt');
  assert.equal(st.procs.length, 2);
  assert.equal(a.proc.title, 'a.txt');
  const again = K.spawn(st, 'notes', '/home/user/a.txt');
  assert.equal(again.existing, true);
  assert.equal(st.procs.length, 2);
  assert.ok(b.proc.pid !== again.proc.pid);
});

test('minimize hides from topProc; focus restores; close removes', () => {
  const st = K.boot(T0);
  const a = K.spawn(st, 'terminal').proc;
  const b = K.spawn(st, 'files').proc;
  assert.equal(K.topProc(st).pid, b.pid);
  K.minimizeProc(st, b.pid);
  assert.equal(K.topProc(st).pid, a.pid, 'minimized window yields the top');
  K.focusProc(st, b.pid);
  assert.equal(b.minimized, false, 'focus un-minimizes');
  assert.equal(K.topProc(st).pid, b.pid);
  K.closeProc(st, a.pid);
  assert.equal(st.procs.length, 1);
  assert.equal(K.findProc(st, a.pid), null);
  K.minimizeProc(st, b.pid);
  assert.equal(K.topProc(st), null, 'everything minimized → no top');
});

/* ══════════ shell ══════════ */

test('tokenize: quotes group, redirection splits even unspaced', () => {
  deq(K.tokenize('echo hello world'), ['echo', 'hello', 'world']);
  deq(K.tokenize('echo "hello world" \'x y\''), ['echo', 'hello world', 'x y']);
  deq(K.tokenize('echo hi>f.txt'), ['echo', 'hi', '>', 'f.txt']);
  deq(K.tokenize('echo hi >> f.txt'), ['echo', 'hi', '>>', 'f.txt']);
  deq(K.tokenize('echo ">not redirect"'), ['echo', '>not redirect']);
  deq(K.tokenize('  '), []);
});

test('shell: pwd/cd/ls/cat walk the disk; errors are marked', () => {
  const st = K.boot(T0);
  deq(K.execCommand(st, 'pwd', T0).out, ['/home/user']);
  assert.equal(K.execCommand(st, 'cd notes', T0).error, false);
  assert.equal(st.cwd, '/home/user/notes');
  assert.ok(K.execCommand(st, 'ls', T0).out.some((l) => l.startsWith('welcome.txt')));
  assert.ok(K.execCommand(st, 'cat welcome.txt', T0).out.join('\n').includes('AIOS'));
  assert.equal(K.execCommand(st, 'cd /ghost', T0).error, true);
  assert.equal(st.cwd, '/home/user/notes', 'failed cd does not move');
  assert.equal(K.execCommand(st, 'cat /ghost', T0).error, true);
  assert.equal(K.execCommand(st, 'blorp', T0).error, true, 'unknown command');
});

test('shell: echo redirection writes and appends via the VFS', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'echo hello world > hi.txt', T0);
  assert.equal(K.fsRead(st.fs, '/home/user/hi.txt').content, 'hello world\n');
  K.execCommand(st, 'echo again >> hi.txt', T0);
  assert.equal(K.fsRead(st.fs, '/home/user/hi.txt').content, 'hello world\nagain\n');
  deq(K.execCommand(st, 'echo plain', T0).out, ['plain']);
  assert.equal(K.execCommand(st, 'echo x >', T0).error, true, 'missing file');
});

test('shell: mkdir -p, touch, mv, cp, find compose; rm moves to the trash', () => {
  const st = K.boot(T0);
  assert.equal(K.execCommand(st, 'mkdir -p a/b/c', T0).error, false);
  assert.equal(K.execCommand(st, 'touch a/b/c/f.txt', T0).error, false);
  assert.equal(K.execCommand(st, 'mv a/b/c/f.txt a/g.txt', T0).error, false);
  assert.equal(K.execCommand(st, 'cp a/g.txt a/h.txt', T0).error, false);
  assert.ok(K.execCommand(st, 'find g.txt', T0).out.includes('/home/user/a/g.txt'));
  assert.equal(K.execCommand(st, 'rm a', T0).error, false, 'rm is safe now — whole dirs go to the trash');
  assert.equal(K.fsGet(st.fs, '/home/user/a'), null);
  assert.equal(K.fsGet(st.fs, '/trash/a').type, 'dir', 'landed in the trash intact');
});

test('shell: open resolves apps, files and dirs into open effects', () => {
  const st = K.boot(T0);
  const app = K.execCommand(st, 'open terminal', T0);
  deq(app.effects, [{ type: 'open', app: 'terminal' }]);
  const file = K.execCommand(st, 'open notes/welcome.txt', T0);
  deq(file.effects, [{ type: 'open', app: 'notes', arg: '/home/user/notes/welcome.txt' }]);
  const dir = K.execCommand(st, 'open /etc', T0);
  deq(dir.effects, [{ type: 'open', app: 'files', arg: '/etc' }]);
  assert.equal(K.execCommand(st, 'open nonsense-xyz', T0).error, true);
});

test('shell: ps lists windows, kill closes them, clear emits its effect', () => {
  const st = K.boot(T0);
  deq(K.execCommand(st, 'ps', T0).out, ['(no windows open)']);
  const p = K.spawn(st, 'files').proc;
  const ps = K.execCommand(st, 'ps', T0);
  assert.ok(ps.out.some((l) => l.includes('files')));
  assert.equal(K.execCommand(st, 'kill ' + p.pid, T0).error, false);
  assert.equal(st.procs.length, 0);
  assert.equal(K.execCommand(st, 'kill 99', T0).error, true);
  deq(K.execCommand(st, 'clear', T0).effects, [{ type: 'clear' }]);
  deq(K.execCommand(st, 'whoami', T0).out, ['user']);
});

/* ══════════ arithmetic — the no-eval parser ══════════ */

test('calcEval: precedence, parens, unary, power, decimals, unicode ops', () => {
  assert.equal(K.calcEval('2+3*4'), 14);
  assert.equal(K.calcEval('(2+3)*4'), 20);
  assert.equal(K.calcEval('-3+10'), 7);
  assert.equal(K.calcEval('2^10'), 1024);
  assert.equal(K.calcEval('2^3^2'), 512, 'power is right-associative');
  assert.equal(K.calcEval('10%3'), 1);
  assert.equal(K.calcEval('1.5*2'), 3);
  assert.equal(K.calcEval('7×6'), 42);
  assert.equal(K.calcEval('84÷2'), 42);
  assert.equal(K.calcEval('50−8'), 42);
});

test('calcEval rejects junk instead of guessing', () => {
  assert.equal(K.calcEval('2+'), null);
  assert.equal(K.calcEval('(2+3'), null);
  assert.equal(K.calcEval('2**3'), null);
  assert.equal(K.calcEval('alert(1)'), null, 'letters never reach a parser');
  assert.equal(K.calcEval('1/0'), null, 'non-finite result rejected');
  assert.equal(K.calcEval(''), null);
});

test('parseDuration: units, combos, bare numbers mean minutes', () => {
  assert.equal(K.parseDuration('5 minutes'), 300);
  assert.equal(K.parseDuration('90s'), 90);
  assert.equal(K.parseDuration('1h 30m'), 5400);
  assert.equal(K.parseDuration('2 hours'), 7200);
  assert.equal(K.parseDuration('10'), 600, 'bare number = minutes');
  assert.equal(K.parseDuration('1.5 min'), 90);
  assert.equal(K.parseDuration('no numbers here'), null);
  assert.equal(K.parseDuration('0 seconds'), null, 'zero-length timer rejected');
});

/* ══════════ intent router ══════════ */

test('routeIntent: open apps by name, synonym or bare mention', () => {
  deq(K.routeIntent('open the terminal'), { type: 'open_app', app: 'terminal' });
  assert.equal(K.routeIntent('launch file manager').app, 'files');
  assert.equal(K.routeIntent('show task manager').app, 'monitor');
  assert.equal(K.routeIntent('notepad').app, 'notes', 'bare synonym opens too');
  assert.equal(K.routeIntent('open the pod bay doors').type, 'chat', 'unknown app falls through');
});

test('routeIntent: maths, percent phrasing, time, timers', () => {
  assert.equal(K.routeIntent("what's 2+2?").value, 4);
  assert.equal(K.routeIntent('calculate (3+4)*2').value, 14);
  assert.equal(K.routeIntent('18% of 240').value, 43.2);
  assert.equal(K.routeIntent('what time is it').type, 'time');
  const t = K.routeIntent('set a timer for 5 minutes');
  assert.equal(t.type, 'timer');
  assert.equal(t.seconds, 300);
  assert.equal(K.routeIntent('remind me in 90 seconds to stretch').seconds, 90);
});

test('routeIntent: notes, folders, search, personalisation', () => {
  const n = K.routeIntent('note that the demo is on Friday');
  assert.equal(n.type, 'note');
  assert.equal(n.text, 'the demo is on Friday');
  assert.equal(K.routeIntent('write down buy milk').text, 'buy milk');
  const f = K.routeIntent('create a folder called invoices');
  assert.equal(f.type, 'mkdir');
  assert.equal(f.name, 'invoices');
  const s = K.routeIntent('find welcome');
  assert.equal(s.type, 'search');
  assert.equal(s.q, 'welcome');
  deq(K.routeIntent('call me Ada'), { type: 'set_name', name: 'Ada' });
  deq(K.routeIntent('set the accent to teal'), { type: 'set_accent', accent: 'teal' });
  assert.equal(K.routeIntent('teal').type, 'chat', 'a colour alone is not a theme command');
  assert.equal(K.routeIntent('help').type, 'help');
  assert.equal(K.routeIntent('tell me a story').type, 'chat');
});

/* ══════════ the assistant executes ══════════ */

test('assistant: notes really land on the disk, with collision-safe names', () => {
  const st = K.boot(T0);
  const a = K.assistant(st, 'note that buy milk', T0);
  assert.ok(a.reply.includes('/home/user/notes/buy-milk.txt'));
  assert.equal(K.fsRead(st.fs, '/home/user/notes/buy-milk.txt').content, 'buy milk\n');
  deq(a.actions, [{ type: 'open', app: 'notes', arg: '/home/user/notes/buy-milk.txt' }]);
  const b = K.assistant(st, 'note that buy milk', T0);
  assert.ok(b.reply.includes('buy-milk-2.txt'), 'second identical note gets a new name');
  assert.ok(K.fsRead(st.fs, '/home/user/notes/buy-milk-2.txt').ok);
});

test('assistant: folders, search, calc, timer, settings all execute', () => {
  const st = K.boot(T0);
  K.assistant(st, 'create a folder called Tax Returns', T0);
  assert.equal(K.fsGet(st.fs, '/home/user/tax-returns').type, 'dir', 'slugified into the cwd');
  const s = K.assistant(st, 'find welcome', T0);
  assert.ok(s.reply.includes('/home/user/notes/welcome.txt'));
  assert.ok(K.assistant(st, 'what is 6*7', T0).reply.includes('= 42'));
  const t = K.assistant(st, 'set a timer for 2 minutes', T0);
  deq(t.actions, [{ type: 'timer', seconds: 120, label: 'Timer' }]);
  K.assistant(st, 'call me Grace', T0);
  assert.equal(st.settings.owner, 'Grace');
  K.assistant(st, 'set the theme to rose', T0);
  assert.equal(st.settings.accent, 'rose');
  const open = K.assistant(st, 'open settings', T0);
  deq(open.actions, [{ type: 'open', app: 'settings' }]);
  assert.ok(K.assistant(st, 'sing me a song', T0).reply.length > 0, 'fallback still replies');
});

test('shell ai command goes through the same assistant', () => {
  const st = K.boot(T0);
  const r = K.execCommand(st, 'ai set a timer for 1 minutes', T0);
  assert.equal(r.error, false);
  deq(r.effects, [{ type: 'timer', seconds: 60, label: 'Timer' }]);
});

/* ══════════ v2: pipes & filters ══════════ */

test('tokenize splits | into its own token, even unspaced', () => {
  deq(K.tokenize('ls|grep txt'), ['ls', '|', 'grep', 'txt']);
  deq(K.tokenize('cat f | head -n 3'), ['cat', 'f', '|', 'head', '-n', '3']);
  deq(K.tokenize('echo "a|b"'), ['echo', 'a|b'], 'quoted pipe is literal');
});

test('pipelines: ls | grep | head compose over the disk', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'touch alpha.txt beta.txt gamma.log', T0);
  const r = K.execCommand(st, 'ls | grep txt', T0);
  assert.equal(r.error, false);
  assert.equal(r.out.length, 2);
  assert.ok(r.out[0].startsWith('alpha.txt'));
  deq(K.execCommand(st, 'ls | grep txt | head -n 1', T0).out.length, 1);
  const wc = K.execCommand(st, 'ls | wc', T0).out[0];
  assert.ok(wc.startsWith('6 lines'), `Desktop/ notes/ projects/ + 3 files, got: ${wc}`);
  assert.equal(K.execCommand(st, 'ls | frobnicate', T0).error, true, 'unknown filter is an error');
});

test('filters: grep -i/-v, tail, sort -r, uniq -c behave', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'echo B > f.txt', T0);
  K.execCommand(st, 'echo a >> f.txt', T0);
  K.execCommand(st, 'echo a >> f.txt', T0);
  deq(K.execCommand(st, 'cat f.txt | grep -i b', T0).out, ['B']);
  deq(K.execCommand(st, 'cat f.txt | grep -v a', T0).out, ['B', ''], 'trailing newline line survives -v');
  deq(K.execCommand(st, 'cat f.txt | head -n 3 | sort', T0).out, ['B', 'a', 'a']);
  deq(K.execCommand(st, 'cat f.txt | head -n 3 | sort -r | uniq -c', T0).out, ['2 a', '1 B']);
  deq(K.execCommand(st, 'cat f.txt | tail -n 2', T0).out, ['a', '']);
});

test('filters accept a trailing file argument as input', () => {
  const st = K.boot(T0);
  const r = K.execCommand(st, 'grep Terminal notes/welcome.txt', T0);
  assert.equal(r.error, false);
  assert.ok(r.out.length >= 1 && r.out[0].includes('Terminal'));
  assert.equal(K.execCommand(st, 'head -n 1 notes/welcome.txt', T0).out[0], 'Welcome to AIOS — the AI operating system.');
});

test('redirection works on ANY pipeline, not just echo', () => {
  const st = K.boot(T0);
  assert.equal(K.execCommand(st, 'ls | grep notes > listing.txt', T0).error, false);
  assert.ok(K.fsRead(st.fs, '/home/user/listing.txt').content.includes('notes/'));
  K.execCommand(st, 'pwd >> listing.txt', T0);
  assert.ok(K.fsRead(st.fs, '/home/user/listing.txt').content.includes('/home/user'));
  assert.equal(K.execCommand(st, 'ls > x > y', T0).error, true, 'redirection must end the command');
});

test('tree draws the hierarchy, dirs first', () => {
  const st = K.boot(T0);
  const r = K.execCommand(st, 'tree ~', T0);
  assert.equal(r.error, false);
  deq(r.out, ['user/', '├─ Desktop/', '│  └─ Getting started.md', '├─ notes/', '│  └─ welcome.txt', '└─ projects/']);
});

/* ══════════ v2: trash ══════════ */

test('rm → trash with origin remembered; restore puts it back', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'echo precious > keep.txt', T0);
  const rm = K.execCommand(st, 'rm keep.txt', T0);
  assert.equal(rm.error, false);
  assert.ok(rm.out[0].includes('/trash/keep.txt'));
  assert.equal(K.fsGet(st.fs, '/home/user/keep.txt'), null);
  assert.ok(K.execCommand(st, 'trash', T0).out[0].includes('was /home/user/keep.txt'));
  assert.equal(K.execCommand(st, 'restore keep.txt', T0).error, false);
  assert.equal(K.fsRead(st.fs, '/home/user/keep.txt').content, 'precious\n');
  assert.deepEqual(JSON.parse(JSON.stringify(st.fs.trash)), {}, 'origin record cleared');
  assert.equal(K.execCommand(st, 'restore keep.txt', T0).error, true, 'nothing left to restore');
});

test('trash: name collisions, purge inside trash, empty, protections', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'touch a.txt', T0);
  K.execCommand(st, 'rm a.txt', T0);
  K.execCommand(st, 'touch a.txt', T0);
  const second = K.execCommand(st, 'rm a.txt', T0);
  assert.ok(second.out[0].includes('/trash/a.txt-2'), 'second delete gets a fresh name');
  assert.equal(K.fsGet(st.fs, '/trash/a.txt-2').type, 'file');
  const purge = K.execCommand(st, 'rm /trash/a.txt', T0);
  assert.ok(purge.out[0].startsWith('purged'), 'rm inside the trash is permanent');
  assert.equal(st.fs.trash['a.txt'], undefined, 'purge forgets the origin');
  const em = K.execCommand(st, 'trash empty', T0);
  assert.ok(em.out[0].includes('1 item'));
  deq(K.execCommand(st, 'trash', T0).out, ['(trash is empty)']);
  assert.equal(K.fsTrash(st.fs, '/', T0).ok, false);
  assert.equal(K.fsTrash(st.fs, '/trash', T0).ok, false);
  // restore refuses to clobber a recreated file
  K.execCommand(st, 'touch b.txt', T0);
  K.execCommand(st, 'rm b.txt', T0);
  K.execCommand(st, 'touch b.txt', T0);
  assert.equal(K.execCommand(st, 'restore b.txt', T0).error, true);
});

/* ══════════ v2: workspaces & window states ══════════ */

test('workspaces: spawn tags the active ws, topProc is per-workspace', () => {
  const st = K.boot(T0);
  const a = K.spawn(st, 'terminal').proc;
  K.switchWorkspace(st, 2);
  const b = K.spawn(st, 'files').proc;
  assert.equal(a.ws, 1);
  assert.equal(b.ws, 2);
  assert.equal(K.topProc(st).pid, b.pid, 'ws2 sees only its own window');
  K.switchWorkspace(st, 1);
  assert.equal(K.topProc(st).pid, a.pid);
  assert.equal(K.switchWorkspace(st, 99), K.WS_COUNT, 'clamped high');
  assert.equal(K.switchWorkspace(st, -3), 1, 'clamped low');
  K.moveToWorkspace(st, a.pid, 3);
  assert.equal(a.ws, 3);
  const ws = K.execCommand(st, 'ws 2', T0);
  assert.equal(ws.error, false);
  assert.equal(st.ws, 2);
  assert.equal(K.execCommand(st, 'ws 9', T0).error, true);
  assert.ok(K.execCommand(st, 'ps', T0).out[0].includes('WS'), 'ps shows the workspace column');
  // re-spawning an app pulls its window to the active workspace
  K.spawn(st, 'terminal');
  assert.equal(a.ws, 2);
});

test('maximize toggles, snap tiles, drag floats everything again', () => {
  const st = K.boot(T0);
  const p = K.spawn(st, 'files').proc;
  K.maximizeProc(st, p.pid);
  assert.equal(p.max, true);
  K.maximizeProc(st, p.pid);
  assert.equal(p.max, false);
  K.snapProc(st, p.pid, 'left');
  assert.equal(p.snap, 'left');
  K.snapProc(st, p.pid, 'right');
  assert.equal(p.snap, 'right');
  K.snapProc(st, p.pid, 'right');
  assert.equal(p.snap, null, 'same side again unsnaps');
  K.snapProc(st, p.pid, 'left');
  K.maximizeProc(st, p.pid);
  assert.equal(p.max, true);
  assert.equal(p.snap, null, 'maximize clears snap');
  K.floatProc(st, p.pid);
  assert.equal(p.max, false);
});

/* ══════════ v2: automations ══════════ */

test('automations: add, due exactly on schedule, toggle, remove', () => {
  const st = K.boot(T0);
  const a = K.addAutomation(st, 'echo tick >> log.txt', 300, T0);
  assert.equal(a.ok, true);
  assert.equal(K.addAutomation(st, 'echo x', 30, T0).ok, false, 'sub-minute rejected');
  assert.equal(K.addAutomation(st, '', 300, T0).ok, false);
  deq(K.dueAutomations(st, T0 + 299000).map((x) => x.id), [], 'not yet');
  deq(K.dueAutomations(st, T0 + 300000).map((x) => x.id), [a.automation.id], 'due on the dot');
  deq(K.dueAutomations(st, T0 + 300000).map((x) => x.id), [], 'running resets the clock');
  deq(K.dueAutomations(st, T0 + 600000).map((x) => x.id), [a.automation.id]);
  K.toggleAutomation(st, a.automation.id, false);
  deq(K.dueAutomations(st, T0 + 9e9).map((x) => x.id), [], 'paused never fires');
  K.toggleAutomation(st, a.automation.id);
  assert.equal(st.automations[0].enabled, true);
  assert.equal(K.removeAutomation(st, a.automation.id), true);
  assert.equal(st.automations.length, 0);
});

test('every/automations/unschedule shell commands; scheduled `ai` really executes', () => {
  const st = K.boot(T0);
  const r = K.execCommand(st, 'every 30m ai note that stretch your legs', T0);
  assert.equal(r.error, false);
  assert.ok(r.out[0].includes('every 30 minutes'));
  assert.ok(K.execCommand(st, 'automations', T0).out[1].includes('ai note that stretch'));
  assert.equal(K.execCommand(st, 'every nonsense echo x', T0).error, true);
  const due = K.dueAutomations(st, T0 + 1800000);
  assert.equal(due.length, 1);
  const run = K.execCommand(st, due[0].command, T0 + 1800000);
  assert.equal(run.error, false);
  assert.ok(K.fsRead(st.fs, '/home/user/notes/stretch-your-legs.txt').ok, 'English ran on schedule');
  assert.equal(K.execCommand(st, 'unschedule ' + due[0].id, T0).error, false);
  assert.equal(st.automations.length, 0);
  assert.equal(K.execCommand(st, 'unschedule 42', T0).error, true);
});

test('automations survive serialize → deserialize; hostile entries dropped', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'every 1h echo tick >> tick.txt', T0);
  const st2 = K.deserialize(K.serialize(st), T0);
  assert.equal(st2.automations.length, 1);
  assert.equal(st2.automations[0].command, 'echo tick >> tick.txt');
  assert.equal(st2.automations[0].everySeconds, 3600);
  assert.ok(st2.nextAutoId > st2.automations[0].id, 'ids keep counting upward');
  const hostile = K.deserialize(JSON.stringify({
    v: 2, fs: K.boot(T0).fs,
    automations: [{ command: 'echo x', everySeconds: 1 }, { command: 42, everySeconds: 600 }, null]
  }), T0);
  assert.equal(hostile.automations.length, 0, 'sub-minute and malformed entries dropped');
});

/* ══════════ v2: conversions, dates, compound intents ══════════ */

test('convertUnits: length, mass, temperature, data — and refusals', () => {
  assert.equal(K.convertUnits('5 km to miles').value, 3.106856);
  assert.equal(K.convertUnits('convert 100 f in c').value, 37.777778);
  assert.equal(K.convertUnits('0c to k').value, 273.15);
  assert.equal(K.convertUnits('2 kg in lbs').value, 4.409245);
  assert.equal(K.convertUnits('2gb to mb').value, 2048);
  assert.equal(K.convertUnits('12 inches to cm').value, 30.48);
  assert.equal(K.convertUnits('5 km to kg'), null, 'cross-dimension refused');
  assert.equal(K.convertUnits('5 blorps to miles'), null);
  const i = K.routeIntent('convert 5 km to miles');
  assert.equal(i.type, 'convert');
  assert.equal(i.conv.value, 3.106856);
});

test('dateMath: days/weeks/months/years, forward and back, from a fixed clock', () => {
  assert.equal(K.dateMath('90 days from now', T0).text, 'Thursday, 22 Oct 2026');
  assert.equal(K.dateMath('in 2 weeks', T0).text, 'Friday, 7 Aug 2026');
  assert.equal(K.dateMath('3 months from now', T0).text, 'Saturday, 24 Oct 2026');
  assert.equal(K.dateMath('1 year ago', T0).text, 'Thursday, 24 Jul 2025');
  assert.equal(K.dateMath('sometime soon', T0), null);
  assert.equal(K.routeIntent('what date is 90 days from now').type, 'datemath');
  assert.equal(K.routeIntent('remind me in 5 minutes').type, 'timer', 'timers keep priority over date math');
});

test('assistant chains "then"; a note containing "then" is never split', () => {
  const st = K.boot(T0);
  const r = K.assistant(st, 'create a folder called reports then open the files', T0);
  assert.equal(K.fsGet(st.fs, '/home/user/reports').type, 'dir');
  deq(r.actions.map((a) => a.app), ['files', 'files']);
  assert.ok(r.reply.includes('Created') && r.reply.includes('Opening Files'));
  const n = K.assistant(st, 'note that shower then breakfast then gym', T0);
  assert.ok(n.reply.includes('shower-then-breakfast'), 'the note stayed whole');
  assert.equal(K.fsRead(st.fs, '/home/user/notes/note-that-shower-then-breakfast.txt').ok, false, 'sanity: name from content words');
  assert.ok(K.fsFind(st.fs, 'shower').length === 1);
  const ws = K.assistant(st, 'switch to workspace 2', T0);
  assert.equal(st.ws, 2);
  assert.ok(ws.reply.includes('Workspace 2'));
});

/* ══════════ v3: variables, aliases, scripts, journal, search, markdown ══════════ */

test('shell variables: set/env/unset, $VAR expansion, builtins, unknown → empty', () => {
  const st = K.boot(T0);
  assert.equal(K.execCommand(st, 'set project=apollo mission', T0).error, false);
  deq(K.execCommand(st, 'echo working on $project', T0).out, ['working on apollo mission']);
  assert.ok(K.execCommand(st, 'env', T0).out.includes('project=apollo mission'));
  deq(K.execCommand(st, 'echo $USER at $CWD ws $WS', T0).out, ['user at /home/user ws 1']);
  deq(K.execCommand(st, 'echo [$nope]', T0).out, ['[]'], 'unknown variable expands to empty');
  assert.equal(K.execCommand(st, 'mkdir $project', T0).error, false, 'expansion works in any command');
  assert.equal(K.fsGet(st.fs, '/home/user/apollo').type, 'dir');
  assert.equal(K.execCommand(st, 'unset project', T0).error, false);
  deq(K.execCommand(st, 'echo $project', T0).out, ['']);
  assert.equal(K.execCommand(st, 'unset project', T0).error, true);
  assert.equal(K.execCommand(st, 'set 9bad=x', T0).error, true, 'names must start with a letter');
});

test('aliases: define/list/use/unalias; pipes inside; cycles bounded; builtins protected', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'touch a.txt b.txt c.log', T0);
  assert.equal(K.execCommand(st, 'alias texts=ls | grep txt', T0).error, false);
  deq(K.execCommand(st, 'texts', T0).out.length, 2, 'alias body may contain a pipeline');
  deq(K.execCommand(st, 'texts | head -n 1', T0).out.length, 1, 'caller can extend the pipeline');
  assert.ok(K.execCommand(st, 'alias', T0).out[0].startsWith('texts='));
  assert.equal(K.execCommand(st, 'alias ls=rm -r /', T0).error, true, 'built-ins cannot be shadowed');
  K.execCommand(st, 'alias loop=loop', T0);
  assert.equal(K.execCommand(st, 'loop', T0).error, true, 'self-alias terminates as unknown command, no hang');
  assert.equal(K.execCommand(st, 'unalias texts', T0).error, false);
  assert.equal(K.execCommand(st, 'texts', T0).error, true);
});

test('alias definitions keep their $ — expansion happens at USE time', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'alias whereami=echo $USER in $CWD', T0);
  K.execCommand(st, 'cd /etc', T0);
  deq(K.execCommand(st, 'whereami', T0).out, ['user in /etc']);
});

test('run: scripts execute line by line with # comments and $1/$@ args', () => {
  const st = K.boot(T0);
  K.fsWrite(st.fs, '/home/user/setup.sh',
    '# project scaffold\nmkdir -p $1/src\necho hello from $@ > $1/readme.txt\nls $1\n', T0);
  const r = K.execCommand(st, 'run setup.sh apollo two', T0);
  assert.equal(r.error, false);
  assert.equal(K.fsGet(st.fs, '/home/user/apollo/src').type, 'dir');
  assert.equal(K.fsRead(st.fs, '/home/user/apollo/readme.txt').content, 'hello from apollo two\n');
  assert.ok(r.out.some((l) => l.startsWith('src/')), 'script output is aggregated');
});

test('run: errors report the line and stop; depth capped; missing script', () => {
  const st = K.boot(T0);
  K.fsWrite(st.fs, '/home/user/bad.sh', 'echo one\ncat /ghost\necho never', T0);
  const r = K.execCommand(st, 'run bad.sh', T0);
  assert.equal(r.error, true);
  assert.ok(r.out.some((l) => l.includes('bad.sh: line stopped: cat /ghost')));
  assert.ok(!r.out.includes('never'), 'stops at the failing line');
  K.fsWrite(st.fs, '/home/user/fork.sh', 'run fork.sh', T0);
  const rec = K.execCommand(st, 'run fork.sh', T0);
  assert.equal(rec.error, true, 'self-running script hits the depth cap, no hang');
  assert.ok(rec.out.join(' ').includes('too deep'));
  assert.equal(st._runDepth, 0, 'depth unwinds cleanly');
  assert.equal(K.execCommand(st, 'run ghost.sh', T0).error, true);
});

test('journal: commands and assistant logged, viewable, capped, persisted', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'echo hello', T0);
  K.assistant(st, 'what is 2+2', T0 + 1000);
  const j = K.execCommand(st, 'journal', T0 + 2000);
  assert.ok(j.out.some((l) => l.includes('sh  echo hello')));
  assert.ok(j.out.some((l) => l.includes('ai  what is 2+2')));
  assert.ok(j.out[0].startsWith('12:00:00'), 'UTC timestamps from the fixed clock');
  for (let i = 0; i < 350; i++) K.logJournal(st, 'sh', 'filler ' + i, T0);
  assert.equal(st.journal.length, 300, 'ring buffer caps at 300');
  const st2 = K.deserialize(K.serialize(st), T0);
  assert.equal(st2.journal.length, 300, 'journal survives reboot');
  deq(K.execCommand(K.boot(T0), 'journal', T0).out, ['(journal is empty)']);
});

test('search: full-text content search, shell and spoken', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'echo the launch code is 1234 > secret.txt', T0);
  const r = K.execCommand(st, 'search launch CODE', T0);
  assert.equal(r.error, false);
  assert.ok(r.out[0].includes('/home/user/secret.txt:1:'), 'path:line of the hit');
  const g = K.fsGrep(st.fs, 'operating system');
  assert.ok(g.some((h) => h.path === '/home/user/notes/welcome.txt' && h.line === 1));
  const i = K.routeIntent('search for launch code in my files');
  assert.equal(i.type, 'content_search');
  assert.equal(i.q, 'launch code');
  assert.ok(K.assistant(st, 'find 1234 in my notes', T0).reply.includes('secret.txt:1'));
  assert.equal(K.routeIntent('find welcome').type, 'search', 'name search unchanged');
});

test('serialize v3 round-trips env and aliases; hostile entries dropped', () => {
  const st = K.boot(T0);
  K.execCommand(st, 'set city=London', T0);
  K.execCommand(st, 'alias ll=ls', T0);
  const st2 = K.deserialize(K.serialize(st), T0);
  deq(st2.env, { city: 'London' });
  deq(st2.aliases, { ll: 'ls' });
  const hostile = K.deserialize(JSON.stringify({
    v: 3, fs: K.boot(T0).fs,
    env: { good: 'x', 'bad name': 'y', evil: 42 },
    aliases: { ok: 'ls', 'no/pe': 'x' },
    journal: [{ t: 'not-a-number', k: 'sh', x: 'bad' }, { t: T0, k: 'sh', x: 'good' }]
  }), T0);
  deq(hostile.env, { good: 'x' });
  deq(hostile.aliases, { ok: 'ls' });
  assert.equal(hostile.journal.length, 1);
});

test('renderMarkdown: structure renders, HTML is always escaped, links http-only', () => {
  const html = K.renderMarkdown('# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n```\nlet x = 1 < 2;\n```\n[site](https://example.com) [evil](javascript:alert(1))\n<script>alert(1)</script>');
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<strong>bold</strong>') && html.includes('<em>em</em>') && html.includes('<code>code</code>'));
  assert.ok(html.includes('<ul>') && html.includes('<li>one</li>'));
  assert.ok(html.includes('let x = 1 &lt; 2;'), 'code blocks escape HTML');
  assert.ok(html.includes('<a href="https://example.com"'));
  assert.ok(!html.includes('href="javascript'), 'non-http link never becomes an anchor href');
  assert.ok(!html.includes('<script'), 'raw HTML is neutralised');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(K.renderMarkdown(''), '');
});

/* ══════════ v3.1: the graphical desktop ══════════ */

test('Desktop is seeded with a Getting started note; old disks grow one on load', () => {
  const st = K.boot(T0);
  assert.equal(K.fsGet(st.fs, K.DESKTOP).type, 'dir');
  const entries = K.desktopEntries(st);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Getting started.md');
  assert.ok(K.fsRead(st.fs, K.DESKTOP + '/Getting started.md').content.includes('Right-click'));
  // a pre-GUI snapshot (no Desktop dir) gains one without losing data
  const old = K.boot(T0);
  K.fsRemove(old.fs, K.DESKTOP, { recursive: true });
  K.fsWrite(old.fs, '/home/user/keep.txt', 'kept', T0);
  const upgraded = K.deserialize(K.serialize(old), T0);
  assert.equal(K.fsGet(upgraded.fs, K.DESKTOP).type, 'dir', 'Desktop recreated');
  assert.equal(K.fsRead(upgraded.fs, '/home/user/keep.txt').content, 'kept');
});

test('icon layout: deterministic column grid, drags stick, positions clamp and persist', () => {
  const st = K.boot(T0);
  deq(K.defaultIconPos(0), { x: 14, y: 12 });
  deq(K.defaultIconPos(5), { x: 14, y: 12 + 5 * 96 }, 'flows down first');
  deq(K.defaultIconPos(6), { x: 14 + 92, y: 12 }, 'then wraps to the next column');
  deq(K.iconPos(st, 'Getting started.md', 0), { x: 14, y: 12 }, 'unplaced icon uses its slot');
  K.setIconPos(st, 'Getting started.md', 400.6, -50);
  deq(K.iconPos(st, 'Getting started.md', 0), { x: 401, y: 0 }, 'rounded and clamped');
  const st2 = K.deserialize(K.serialize(st), T0);
  deq(K.iconPos(st2, 'Getting started.md', 0), { x: 401, y: 0 }, 'position survives reboot');
  const hostile = K.deserialize(JSON.stringify({ v: 4, fs: K.boot(T0).fs, desktop: { 'a.txt': { x: 'NaN-ish', y: 5 }, 'b/ad': { x: 1, y: 1 }, 'c.txt': { x: 99999, y: 3 } } }), T0);
  deq(hostile.desktop, { 'c.txt': { x: 6000, y: 3 } }, 'bad names and non-finite positions dropped, huge ones clamped');
});

test('pruneIconPos forgets icons whose file is gone; mv onto a file clobbers (unix)', () => {
  const st = K.boot(T0);
  K.fsWrite(st.fs, K.DESKTOP + '/a.txt', 'A', T0);
  K.setIconPos(st, 'a.txt', 100, 100);
  K.setIconPos(st, 'Getting started.md', 200, 200);
  K.fsTrash(st.fs, K.DESKTOP + '/a.txt', T0);
  K.pruneIconPos(st);
  deq(Object.keys(st.desktop), ['Getting started.md']);
  // rename = fsMove; renaming ONTO an existing file overwrites, like mv(1)
  K.fsWrite(st.fs, K.DESKTOP + '/x.txt', 'X', T0);
  K.fsWrite(st.fs, K.DESKTOP + '/y.txt', 'Y', T0);
  assert.equal(K.fsMove(st.fs, K.DESKTOP + '/x.txt', K.DESKTOP + '/y.txt', T0).ok, true);
  assert.equal(K.fsRead(st.fs, K.DESKTOP + '/y.txt').content, 'X');
});

/* ══════════ v4: the AIOS Script language ══════════ */

test('let evaluates arithmetic into a variable; interoperates with $expansion', () => {
  const st = K.boot(T0);
  assert.equal(K.execCommand(st, 'let x = 3 + 4 * 2', T0).error, false);
  deq(K.execCommand(st, 'echo $x', T0).out, ['11']);
  assert.equal(K.execCommand(st, 'let x = $x * 10', T0).error, false);
  deq(K.execCommand(st, 'echo $x', T0).out, ['110']);
  assert.equal(K.execCommand(st, 'let bad = hello', T0).error, true);
});

test('script: if / elif / else branches on comparisons and exists', () => {
  const st = K.boot(T0);
  const run = (src) => K.runScript(st, src, [], 'test', T0);
  deq(run('let n = 5\nif $n > 10\n echo big\nelif $n > 3\n echo mid\nelse\n echo small\nend').out, ['mid']);
  deq(run('if exists /home/user/notes\n echo yes\nend').out, ['yes']);
  deq(run('if exists /ghost\n echo yes\nelse\n echo no\nend').out, ['no']);
  deq(run('if not exists /ghost\n echo clear\nend').out, ['clear']);
  deq(run('if apple == apple\n echo same\nend').out, ['same'], 'string equality');
});

test('script: while loops run and terminate; the step cap kills infinite loops', () => {
  const st = K.boot(T0);
  const r = K.runScript(st, 'let n = 3\nwhile $n > 0\n echo tick $n\n let n = $n - 1\nend\necho done', [], 't', T0);
  deq(r.out, ['tick 3', 'tick 2', 'tick 1', 'done']);
  assert.equal(r.error, false);
  const inf = K.runScript(st, 'while 1\n echo x\nend', [], 't', T0);
  assert.equal(inf.error, true);
  assert.ok(inf.out[inf.out.length - 1].includes('exceeded'), 'infinite loop is bounded, never hangs');
});

test('script: func defines a callable command with its own $1..$9/$@ args', () => {
  const st = K.boot(T0);
  const r = K.runScript(st, 'func greet\n echo hello $1 and $2\nend\ngreet Ada Bob', [], 't', T0);
  deq(r.out, ['hello Ada and Bob']);
  // a func can build on the OS: make a project scaffold
  K.runScript(st, 'func scaffold\n mkdir -p $1/src\n echo $1 > $1/name.txt\nend\nscaffold apollo', [], 't', T0);
  assert.equal(K.fsGet(st.fs, '/home/user/apollo/src').type, 'dir');
  assert.equal(K.fsRead(st.fs, '/home/user/apollo/name.txt').content, 'apollo\n');
});

test('script: $(( arithmetic )) substitutes inline, and malformed blocks error cleanly', () => {
  const st = K.boot(T0);
  deq(K.runScript(st, 'echo $(( 6 * 7 ))', [], 't', T0).out, ['42']);
  assert.equal(K.runScript(st, 'if $x > 1\n echo hi', [], 't', T0).error, true, 'unclosed if');
  assert.ok(K.runScript(st, 'end', [], 't', T0).out[0].includes('stray'), 'stray end');
});

test('run wires the interpreter to a file, with $1/$@ from the command line', () => {
  const st = K.boot(T0);
  K.fsWrite(st.fs, '/home/user/greet.sh', 'func hi\n echo hi $1\nend\nhi $1\nlet sum = $2 + $3\necho $sum', T0);
  const r = K.execCommand(st, 'run greet.sh World 20 22', T0);
  assert.equal(r.error, false);
  deq(r.out, ['hi World', '42']);
});

/* ══════════ v4: the App SDK ══════════ */

test('apps ship pre-installed as .app manifests in /apps; listApps reads them', () => {
  const st = K.boot(T0);
  const apps = K.listApps(st);
  const ids = apps.map((a) => a.id).sort();
  deq(ids, ['dice', 'tip']);
  const tip = K.readApp(st, 'tip');
  assert.equal(tip.name, 'Tip Calculator');
  assert.ok(tip.ui.some((w) => w.type === 'button' && w.run.includes('$bill')));
  assert.equal(K.readApp(st, 'ghost'), null);
});

test('app command: list, open (→ userapp effect), install, remove', () => {
  const st = K.boot(T0);
  assert.ok(K.execCommand(st, 'app list', T0).out.some((l) => l.includes('tip')));
  deq(K.execCommand(st, 'app open dice', T0).effects, [{ type: 'open', app: 'userapp', arg: 'dice' }]);
  assert.equal(K.execCommand(st, 'app open ghost', T0).error, true);
  // install a new app from a manifest file on the disk
  K.fsWrite(st.fs, '/home/user/clock.app', JSON.stringify({ name: 'Clock', emoji: '🕰', ui: [{ type: 'button', text: 'Now', run: 'date' }] }), T0);
  assert.equal(K.execCommand(st, 'app install clock.app', T0).error, false);
  assert.equal(K.readApp(st, 'clock').name, 'Clock');
  assert.ok(K.listApps(st).map((a) => a.id).includes('clock'));
  assert.equal(K.execCommand(st, 'app remove clock', T0).error, false);
  assert.equal(K.readApp(st, 'clock'), null);
  assert.equal(K.execCommand(st, 'app install /home/user/notes/welcome.txt', T0).error, true, 'non-manifest rejected');
});

test('normalizeApp is strict: bad manifests rejected, widgets/strings capped', () => {
  assert.equal(K.parseApp('not json'), null);
  assert.equal(K.parseApp('{"ui":[]}'), null, 'name required');
  const a = K.normalizeApp({ name: 'X'.repeat(99), ui: [{ type: 'button', text: 'y', run: 'z' }, { type: 'evil', run: 'rm -rf /' }, { type: 'label' }] });
  assert.equal(a.name.length, 40, 'name capped');
  assert.equal(a.ui.length, 2, 'unknown widget types dropped');
  assert.equal(a.ui[0].type, 'button');
  assert.equal(a.emoji, '🧩', 'default icon');
  const big = K.normalizeApp({ name: 'big', ui: new Array(100).fill({ type: 'label', text: 'x' }) });
  assert.ok(big.ui.length <= 40, 'widget count capped');
});

test('userapp windows are one-per-app-id and carry the app emoji', () => {
  const st = K.boot(T0);
  const a = K.spawn(st, 'userapp', 'tip');
  assert.equal(a.ok, true);
  assert.equal(a.proc.title, 'Tip Calculator');
  assert.equal(a.proc.emoji, '💸');
  const again = K.spawn(st, 'userapp', 'tip');
  assert.equal(again.existing, true, 'singleton per app id');
  const other = K.spawn(st, 'userapp', 'dice');
  assert.equal(other.existing, false);
  assert.equal(st.procs.length, 2);
  assert.equal(K.spawn(st, 'userapp', 'ghost').ok, false, 'unknown app id refused');
});

test('the two seeded apps actually compute when their buttons run', () => {
  const st = K.boot(T0);
  // tip: bill 100, 15%, 2 people → each pays (100+15)/2 = 57
  K.execCommand(st, 'set bill=100', T0);
  K.execCommand(st, 'set pct=15', T0);
  K.execCommand(st, 'set people=2', T0);
  const tip = K.readApp(st, 'tip');
  const btn = tip.ui.find((w) => w.type === 'button');
  deq(K.execCommand(st, btn.run, T0).out, ['Each pays 57.5']);
});

console.log('── aios kernel unit tests ──');
let failed = 0;
for (const [n, f] of tests) {
  try { f(); passed++; console.log('  ✓ ' + n); }
  catch (e) { failed++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
