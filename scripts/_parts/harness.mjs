// Shared test harness for the Aerial part tests (dev-only).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function loadEngine() {
  const sandbox = { module: { exports: {} }, TextEncoder, TextDecoder, console };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, 'aerial', 'engine.js'), 'utf8'), sandbox, { filename: 'aerial/engine.js' });
  return sandbox.module.exports;
}
export const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
export function runner(name) {
  const tests = [];
  const test = (n, f) => tests.push([n, f]);
  const run = () => {
    let passed = 0, failed = 0;
    for (const [n, f] of tests) {
      try { f(); passed++; console.log(`  ✓ ${n}`); }
      catch (e) { failed++; console.log(`  ✗ ${n}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`); }
    }
    console.log(`\n${name}: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  };
  return { test, run, assert };
}
