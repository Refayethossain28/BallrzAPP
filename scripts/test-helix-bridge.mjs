#!/usr/bin/env node
/**
 * Unit tests for helix/helix-bridge.js — the localStorage-backed glue that
 * each app uses to get a named, auto-persisting Helix engine. Both helix.js and
 * the bridge are loaded into one vm sandbox (so the bridge sees `Helix` on the
 * sandbox global, exactly like a browser <script src> pair), and the sandbox is
 * given a fake localStorage so persistence can be exercised.
 *
 * Run: node scripts/test-helix-bridge.mjs   (or npm test)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A minimal, spec-faithful localStorage so we can test persistence + reload.
function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _size: () => map.size,
  };
}

// Build a fresh sandbox with helix.js + helix-bridge.js loaded, sharing one
// localStorage. `ls` lets a test simulate "no localStorage" (private mode).
function makeApp(ls) {
  // No `module` global ⇒ both UMD files take the browser branch: helix.js sets
  // self.Helix, the bridge sets self.HelixBridge and reads self.Helix — exactly
  // the <script src> pair a real page loads.
  const sandbox = {};
  sandbox.self = sandbox;
  if (ls !== null) sandbox.localStorage = ls === undefined ? fakeLocalStorage() : ls;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, 'helix', 'helix.js'), 'utf8'), sandbox, { filename: 'helix.js' });
  vm.runInContext(readFileSync(join(ROOT, 'helix', 'helix-bridge.js'), 'utf8'), sandbox, { filename: 'helix-bridge.js' });
  return sandbox; // sandbox.HelixBridge + sandbox.Helix
}

let passed = 0;
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('available() true when Helix is loaded', () => {
  const { HelixBridge } = makeApp();
  assert.equal(HelixBridge.available(), true);
});

test('engine() returns a working, memoized engine', () => {
  const { HelixBridge } = makeApp();
  const e1 = HelixBridge.engine('feed');
  const e2 = HelixBridge.engine('feed');
  assert.ok(e1, 'engine created');
  assert.equal(e1, e2, 'same name ⇒ same instance (memoized)');
  e1.arm('a').arm('b');
  assert.ok(e1.best(), 'engine actually decides');
});

test('reward() auto-creates engine + arm and learns', () => {
  const { HelixBridge } = makeApp();
  assert.equal(HelixBridge.reward('feed', 'x', 1), true);
  const e = HelixBridge.engine('feed');
  assert.ok(e.has('x'), 'arm auto-registered');
  assert.ok(e.stats('x').mean > 0.5, 'a win raised the belief');
});

test('persistence survives a reload (new bridge, same localStorage)', () => {
  const ls = fakeLocalStorage();
  // Session 1: teach the engine that "good" wins and "bad" loses.
  const app1 = makeApp(ls);
  for (let i = 0; i < 20; i++) { app1.HelixBridge.reward('disp', 'good', 1); app1.HelixBridge.reward('disp', 'bad', 0); }
  const meanGood1 = app1.HelixBridge.engine('disp').stats('good').mean;
  assert.ok(ls._size() > 0, 'something was persisted');

  // Session 2: a brand-new page (fresh bridge) reading the SAME storage.
  const app2 = makeApp(ls);
  const e2 = app2.HelixBridge.engine('disp');
  assert.ok(e2.has('good') && e2.has('bad'), 'arms restored from storage');
  assert.ok(Math.abs(e2.stats('good').mean - meanGood1) < 1e-9, 'belief restored exactly');
  assert.ok(e2.stats('good').mean > e2.stats('bad').mean, 'learning carried over');
});

test('separate names are isolated and stored under distinct keys', () => {
  const ls = fakeLocalStorage();
  const { HelixBridge } = makeApp(ls);
  HelixBridge.reward('appA', 'x', 1);
  HelixBridge.reward('appB', 'x', 0);
  assert.notEqual(HelixBridge.engine('appA').stats('x').mean, HelixBridge.engine('appB').stats('x').mean);
  assert.ok(ls.getItem('helix.appA'), 'appA stored');
  assert.ok(ls.getItem('helix.appB'), 'appB stored');
});

test('reset() clears the engine and its stored snapshot', () => {
  const ls = fakeLocalStorage();
  const { HelixBridge } = makeApp(ls);
  HelixBridge.reward('tmp', 'x', 1);
  assert.ok(ls.getItem('helix.tmp'));
  HelixBridge.reset('tmp');
  assert.equal(ls.getItem('helix.tmp'), null, 'snapshot removed');
  // Re-creating starts fresh (uniform prior).
  const e = HelixBridge.engine('tmp');
  assert.ok(!e.has('x'), 'no carryover after reset');
});

test('degrades gracefully with NO localStorage (private mode / Node)', () => {
  const { HelixBridge } = makeApp(null); // no localStorage in sandbox
  assert.equal(HelixBridge.available(), true, 'engine still works in-memory');
  assert.equal(HelixBridge.reward('mem', 'x', 1), true, 'reward works');
  assert.equal(HelixBridge.persist('mem'), false, 'persist is a safe no-op');
  assert.ok(HelixBridge.engine('mem').stats('x').mean > 0.5, 'still learns in-memory');
});

test('a corrupt stored snapshot is ignored, not thrown', () => {
  const ls = fakeLocalStorage();
  ls.setItem('helix.bad', '{not valid json');
  const { HelixBridge } = makeApp(ls);
  const e = HelixBridge.engine('bad'); // must not throw
  assert.ok(e, 'fell back to a fresh engine');
  assert.deepEqual(Array.from(e.ids()), [], 'no arms from the garbage snapshot');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n      ${err.message}`); process.exitCode = 1; }
}
console.log(`\nhelix-bridge: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exitCode = 1;
