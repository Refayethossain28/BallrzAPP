#!/usr/bin/env node
/**
 * Tests for voyager/proxy.js and voyager/server.mjs — the "full browser" proxy
 * that lets Voyager open sites which refuse to be framed.
 *
 * Two layers:
 *   1. Pure unit tests of proxy.js (URL rewriting, CSS, srcset, header
 *      stripping, SSRF host guard) in a vm sandbox with the real URL global.
 *   2. A live integration test: it spins up a tiny origin server that sends
 *      `X-Frame-Options: DENY` (the exact thing that blocks YouTube et al.),
 *      runs voyager/server.mjs in front of it, and asserts the proxy strips
 *      the framing header, rewrites the page's links back through itself, and
 *      injects the chrome bridge — i.e. the page that a frame would refuse now
 *      loads. SSRF guard is disabled via VOYAGER_ALLOW_PRIVATE for loopback.
 *
 * Run: node scripts/test-voyager-proxy.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---- load proxy.js with the globals it needs (URL) ---- */
const sandbox = { module: { exports: {} }, URL, TextDecoder, console };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'voyager', 'proxy.js'), 'utf8'), sandbox, { filename: 'voyager/proxy.js' });
const P = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/* ════════ unit: URL rewriting ════════ */

test('absolutize resolves relative URLs and rejects inert schemes', () => {
  assert.equal(P.absolutize('b.html', 'https://ex.com/a/'), 'https://ex.com/a/b.html');
  assert.equal(P.absolutize('/x', 'https://ex.com/a/'), 'https://ex.com/x');
  assert.equal(P.absolutize('//cdn.com/x.js', 'https://ex.com/'), 'https://cdn.com/x.js');
  assert.equal(P.absolutize('#frag', 'https://ex.com/'), null);
  assert.equal(P.absolutize('javascript:1', 'https://ex.com/'), null);
  assert.equal(P.absolutize('data:x', 'https://ex.com/'), null);
  assert.equal(P.absolutize('mailto:a@b.c', 'https://ex.com/'), null);
});

test('proxify wraps absolute http(s) once, leaves others', () => {
  assert.equal(P.proxify('https://a.com/x', '/proxy'), '/proxy?url=' + encodeURIComponent('https://a.com/x'));
  assert.equal(P.proxify('/proxy?url=already', '/proxy'), '/proxy?url=already'); // idempotent
  assert.equal(P.proxify('data:x', '/proxy'), 'data:x');
});

test('proxify threads a key-carrying proxyPath onto every link (&url=)', () => {
  assert.equal(P.proxify('https://a.com/x', '/proxy?key=SECRET'),
    '/proxy?key=SECRET&url=' + encodeURIComponent('https://a.com/x'));
  // idempotent with the key present too
  assert.equal(P.proxify('/proxy?key=SECRET&url=already', '/proxy?key=SECRET'), '/proxy?key=SECRET&url=already');
});

test('rewriteHtml routes href/src/action, srcset, styles, and strips base/CSP', () => {
  const html = '<html><head>' +
    '<base href="https://ex.com/a/">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src none">' +
    '</head><body>' +
    '<a href="b.html">x</a>' +
    '<img src="/i.png" srcset="/s1.png 1x, /s2.png 2x">' +
    '<form action="/search"></form>' +
    '<div style="background:url(bg.png)"></div>' +
    '<style>@import "c.css"; .h{background:url(\'h.png\')}</style>' +
    '</body></html>';
  const out = P.rewriteHtml(html, 'https://ex.com/a/page', '/proxy');
  assert.ok(!/<base/i.test(out), 'base tag removed');
  assert.ok(!/content-security-policy/i.test(out), 'CSP meta removed');
  assert.ok(out.includes('href="/proxy?url=' + encodeURIComponent('https://ex.com/a/b.html')), 'link proxied against <base>');
  assert.ok(out.includes('src="/proxy?url=' + encodeURIComponent('https://ex.com/i.png')), 'img src proxied');
  assert.ok(out.includes(encodeURIComponent('https://ex.com/s2.png')), 'srcset proxied');
  assert.ok(out.includes('action="/proxy?url=' + encodeURIComponent('https://ex.com/search')), 'form action proxied');
  assert.ok(/url\("\/proxy\?url=[^"]*bg\.png/.test(out), 'inline style url() proxied');
  assert.ok(/@import "\/proxy\?url=/.test(out), '@import proxied');
  assert.ok(out.includes('parent.postMessage') && out.includes('closest'), 'client shim injected');
});

test('rewriteHtml with no <base> resolves against the page URL', () => {
  const out = P.rewriteHtml('<a href="next">n</a>', 'https://ex.com/dir/page.html', '/proxy');
  assert.ok(out.includes('/proxy?url=' + encodeURIComponent('https://ex.com/dir/next')));
});

test('isDroppedHeader targets exactly the framing/transport headers', () => {
  for (const h of ['x-frame-options', 'Content-Security-Policy', 'content-length', 'content-encoding', 'set-cookie', 'strict-transport-security'])
    assert.equal(P.isDroppedHeader(h), true, h + ' should be dropped');
  for (const h of ['content-type', 'cache-control', 'date', 'etag'])
    assert.equal(P.isDroppedHeader(h), false, h + ' should be kept');
});

test('isBlockedHost stops private / loopback / metadata, allows public', () => {
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1'])
    assert.equal(P.isBlockedHost(h), true, h + ' should be blocked');
  for (const h of ['youtube.com', 'example.com', '8.8.8.8', 'news.ycombinator.com'])
    assert.equal(P.isBlockedHost(h), false, h + ' should be allowed');
});

test('content-type classifiers', () => {
  assert.equal(P.isHtml('text/html; charset=utf-8'), true);
  assert.equal(P.isCss('text/css'), true);
  assert.equal(P.isHtml('image/png'), false);
});

test('originAllowed gates a deployed proxy to its app origins', () => {
  const allow = ['https://refayethossain28.github.io'];
  assert.equal(P.originAllowed('https://refayethossain28.github.io', allow), true);
  assert.equal(P.originAllowed('https://refayethossain28.github.io/voyager/', allow), true); // Referer URL reduced to origin
  assert.equal(P.originAllowed('https://evil.example', allow), false);
  assert.equal(P.originAllowed('', allow), false);        // deployed proxy rejects origin-less requests
  assert.equal(P.originAllowed('', []), true);            // no allowlist (localhost) → unrestricted
  assert.equal(P.originAllowed('https://anything.example', []), true);
});

/* ════════ integration: real proxy in front of a framing-refusing origin ════════ */

function listen(server, port) {
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res(server.address().port)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function integration() {
  // origin that refuses to be framed, exactly like YouTube/Google do
  const origin = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
      res.end('<html><head><title>Secret HQ</title></head><body><h1>hi</h1><a href="/page2">next</a><img src="pic.png"></body></html>');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Page 2</title>ok');
    }
  });
  const originPort = await listen(origin, 0);

  // the Voyager proxy server in front of it (private hosts allowed for the loopback origin)
  const proxyPort = 8799;
  const srv = spawn(process.execPath, [join(ROOT, 'voyager', 'server.mjs')], {
    env: Object.assign({}, process.env, { PORT: String(proxyPort), HOST: '127.0.0.1', VOYAGER_ALLOW_PRIVATE: '1' }),
    stdio: 'ignore',
  });
  try {
    // wait for the server to accept connections
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${proxyPort}/__voyager/ping`); if (r.ok) break; } catch (e) {}
      await sleep(100);
    }

    // ping identifies the server (this is what the app auto-detects)
    const ping = await (await fetch(`http://127.0.0.1:${proxyPort}/__voyager/ping`)).json();
    assert.equal(ping.voyager, true);

    // static app is served
    const app = await fetch(`http://127.0.0.1:${proxyPort}/`);
    assert.ok((await app.text()).includes('Voyager'), 'serves the app');

    // THE POINT: fetch the framing-refusing origin through the proxy
    const target = `http://127.0.0.1:${originPort}/`;
    const proxied = await fetch(`http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(target)}`);
    assert.equal(proxied.headers.get('x-frame-options'), null, 'X-Frame-Options stripped');
    assert.equal(proxied.headers.get('content-security-policy'), null, 'CSP stripped');
    const body = await proxied.text();
    assert.ok(body.includes('Secret HQ'), 'page content passed through');
    assert.ok(body.includes('parent.postMessage'), 'chrome bridge injected');
    assert.ok(body.includes('/proxy?url=' + encodeURIComponent(`http://127.0.0.1:${originPort}/page2`)), 'in-page link rewritten through proxy');
    assert.ok(body.includes('/proxy?url=' + encodeURIComponent(`http://127.0.0.1:${originPort}/pic.png`)), 'relative asset rewritten');

    // SSRF guard: with the override OFF it would block; assert the classifier the server uses
    assert.equal(P.isBlockedHost('127.0.0.1'), true, 'loopback is blocked unless overridden');

    console.log('  ✓ integration: proxy strips framing headers, rewrites links, serves a frame-refusing page');
    passed++;
  } finally {
    srv.kill();
    origin.close();
  }
}

async function integrationKeyed() {
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' });
    res.end('<html><head><title>Locked HQ</title></head><body><h1>hi</h1><a href="/next">go</a></body></html>');
  });
  const originPort = await listen(origin, 0);

  const proxyPort = 8798;
  const KEY = 'test-secret-123';
  const srv = spawn(process.execPath, [join(ROOT, 'voyager', 'server.mjs')], {
    env: Object.assign({}, process.env, { PORT: String(proxyPort), HOST: '127.0.0.1', VOYAGER_ALLOW_PRIVATE: '1', PROXY_KEY: KEY }),
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${proxyPort}/__voyager/ping`); if (r.ok) break; } catch (e) {}
      await sleep(100);
    }
    const target = `http://127.0.0.1:${originPort}/`;
    const enc = encodeURIComponent(target);

    // no key → 403 Locked
    const noKey = await fetch(`http://127.0.0.1:${proxyPort}/proxy?url=${enc}`);
    assert.equal(noKey.status, 403, 'request without key is rejected');

    // wrong key → 403
    const badKey = await fetch(`http://127.0.0.1:${proxyPort}/proxy?url=${enc}&key=nope`);
    assert.equal(badKey.status, 403, 'wrong key is rejected');

    // right key → 200, framing stripped, and rewritten links carry the key
    const ok = await fetch(`http://127.0.0.1:${proxyPort}/proxy?key=${KEY}&url=${enc}`);
    assert.equal(ok.status, 200, 'correct key is accepted');
    assert.equal(ok.headers.get('x-frame-options'), null, 'framing header stripped');
    const body = await ok.text();
    assert.ok(body.includes('Locked HQ'), 'content served with the key');
    assert.ok(body.includes(`/proxy?key=${KEY}&url=` + encodeURIComponent(`http://127.0.0.1:${originPort}/next`)),
      'in-page links carry the key so navigation stays authorised');

    console.log('  ✓ integration (keyed): PROXY_KEY blocks keyless requests and threads the key through links');
    passed++;
  } finally {
    srv.kill();
    origin.close();
  }
}

/* ---- run ---- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n${err.message}\n`); process.exitCode = 1; }
}
try { await integration(); }
catch (err) { console.error(`  ✗ integration\n${err.stack || err.message}\n`); process.exitCode = 1; }
try { await integrationKeyed(); }
catch (err) { console.error(`  ✗ integration (keyed)\n${err.stack || err.message}\n`); process.exitCode = 1; }

console.log(`\nvoyager proxy: ${passed}/${tests.length + 2} passed`);
if (process.exitCode) process.exit(1);
