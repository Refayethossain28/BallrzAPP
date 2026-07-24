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
  deq(names, ['notes', 'projects', 'aa.txt', 'zz.txt']);
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
  assert.ok(wc.startsWith('5 lines'), `notes/ projects/ + 3 files, got: ${wc}`);
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
  deq(r.out, ['user/', '├─ notes/', '│  └─ welcome.txt', '└─ projects/']);
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

console.log('── aios kernel unit tests ──');
let failed = 0;
for (const [n, f] of tests) {
  try { f(); passed++; console.log('  ✓ ' + n); }
  catch (e) { failed++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
