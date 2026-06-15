#!/usr/bin/env node
/**
 * Headless smoke test for the single-file HTML prototypes.
 *
 * Why this exists: these prototypes are plain HTML with inline <script>. A bug
 * like calling an undefined helper (`el()`) is *syntactically* valid, so a parse
 * check passes — but it throws a ReferenceError at init, which silently kills the
 * rest of the script (e.g. the line that starts the render loop). That shipped
 * once and showed up as a blank screen on a phone.
 *
 * This test extracts every inline classic <script> and actually RUNS it in a
 * `vm` sandbox whose DOM is faked with permissive stubs, while real JS globals
 * (Math, Date, JSON, …) stay real. Any identifier the script references but never
 * defines is NOT stubbed, so it throws ReferenceError — exactly the bug class we
 * want to catch. Animation loops are neutered (requestAnimationFrame is a no-op),
 * so we only exercise the top-level init path, which is where these bugs live.
 *
 * Zero dependencies — Node built-ins only. Run: `npm test` or
 * `node scripts/smoke-prototypes.mjs`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---- find tracked-ish .html files (skip vcs/build dirs) ---- */
const SKIP = new Set(['.git', 'node_modules', '.claude']);
function findHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) findHtml(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

/* ---- pull inline classic scripts (skip src= and type=module) ---- */
function inlineScripts(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;                 // external
    if (/type\s*=\s*["']?module/i.test(attrs)) continue;    // ES module — skip
    blocks.push(m[2]);
  }
  return blocks;
}

/* ---- a DOM/browser stub that never throws on its own, so the only errors
       that surface are the script's genuine bugs (undefined identifiers). ---- */
function makeStub() {
  const fn = function () { return stub; };
  const stub = new Proxy(fn, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) return (hint) => (hint === 'string' ? '' : 0);
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.toStringTag) return 'Stub';
      if (key === 'toString') return () => '';
      if (key === 'valueOf') return () => 0;
      if (key === 'length') return 0;
      if (key === 'then') return undefined; // not a thenable
      return stub;
    },
    set() { return true; },
    apply() { return stub; },
    construct() { return stub; },
    has() { return true; },
  });
  return stub;
}

function makeSandbox() {
  const noop = () => {};
  const sandbox = {
    // real, safe JS globals
    Math, Date, JSON, Object, Array, String, Number, Boolean, Symbol, RegExp, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, Promise, URLSearchParams, console,
    // timers / frame loop neutered so init runs once and stops
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop, queueMicrotask: noop,
    // browser bits as harmless stubs / classes
    performance: { now: () => Date.now() },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: () => Promise.resolve(makeStub()),
    crypto: { getRandomValues: (a) => a, randomUUID: () => 'stub' },
    Image: class {}, Audio: class {}, Worker: class {}, WebSocket: class {},
    alert: noop, confirm: () => true, prompt: () => null,
    document: makeStub(), navigator: makeStub(), localStorage: makeStub(),
    sessionStorage: makeStub(), location: makeStub(), history: makeStub(),
    getComputedStyle: () => makeStub(),
    // window-as-EventTarget surface and common window props
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    matchMedia: () => makeStub(), scrollTo: noop, scrollBy: noop,
    devicePixelRatio: 2, innerWidth: 390, innerHeight: 780,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/* ---- run one file: each inline block in a shared context, like a browser ---- */
function smokeFile(path) {
  const html = readFileSync(path, 'utf8');
  const blocks = inlineScripts(html);
  if (blocks.length === 0) return { path, status: 'skip', reason: 'no inline script' };
  const context = vm.createContext(makeSandbox());
  for (let i = 0; i < blocks.length; i++) {
    try {
      vm.runInContext(blocks[i], context, { filename: `${path}#script${i + 1}`, timeout: 5000 });
    } catch (err) {
      return { path, status: 'fail', reason: `${err.name}: ${err.message}` };
    }
  }
  return { path, status: 'pass' };
}

/* ---- main ---- */
const files = findHtml(ROOT).sort();
let failed = 0, passed = 0, skipped = 0;
console.log(`smoke-testing ${files.length} HTML file(s)\n`);
for (const f of files) {
  const rel = relative(ROOT, f);
  const r = smokeFile(f);
  if (r.status === 'pass') { passed++; console.log(`  ✓ ${rel}`); }
  else if (r.status === 'skip') { skipped++; console.log(`  · ${rel}  (${r.reason})`); }
  else { failed++; console.log(`  ✗ ${rel}\n      ${r.reason}`); }
}
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
