#!/usr/bin/env node
/**
 * End-to-end UI verification for Voyager in a real Chromium, with a mock
 * proxy server whose liveness can be toggled — so the sleeping-free-tier
 * story is tested for real: basic-mode card with no proxy, waking card and
 * veil while the proxy sleeps, AUTOMATIC reload the moment it wakes, and the
 * core browse/memory/reader journey through a healthy proxy.
 *
 * Lives in the repo (not a scratchpad) so it survives environments.
 * Run: node scripts/verify-voyager-ui.mjs
 * Chromium: uses Playwright's own browser if installed; else set
 * VOYAGER_CHROME=/path/to/chrome (auto-detects /opt/pw-browsers too).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));

function loadPlaywright() {
  const candidates = ['playwright', 'playwright-core',
    path.join(ROOT, 'apexvip-web', 'node_modules', 'playwright'),
    '/opt/node22/lib/node_modules/playwright'];
  for (const c of candidates) { try { return require(c); } catch (e) {} }
  throw new Error('playwright not found — npm i -D playwright or set NODE_PATH');
}
function chromeExecutable() {
  if (process.env.VOYAGER_CHROME) return process.env.VOYAGER_CHROME;
  const base = '/opt/pw-browsers';
  try {
    const hit = fs.readdirSync(base).find((d) => /^chromium-\d+$/.test(d));
    if (hit) {
      for (const sub of ['chrome-linux', 'chrome-linux64']) {
        const p = path.join(base, hit, sub, 'chrome');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (e) {}
  return undefined; // let Playwright resolve its own install
}

/* ── the mock world: static app + toggleable proxy ── */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const state = { proxyAwake: true, servePing: true };
const hung = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const servePage = (res2, target) => {
    res2.writeHead(200, { 'content-type': 'text/html' });
    res2.end(`<!doctype html><meta charset=utf8><title>Mock page</title>
      <body><h1>Mock page</h1><p>Entanglement links distant nodes for testing.</p>
      <script>parent.postMessage({voyager:'loaded', url:${JSON.stringify(target)}, title:'Mock page', trackers:0}, '*');</script>`);
  };
  if (u.pathname === '/__voyager/ping') {
    if (!state.servePing) { res.writeHead(404); return res.end('nf'); }
    if (!state.proxyAwake) { hung.push({ res, u }); return; }   // asleep: hang, like a cold instance
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ voyager: true }));
  }
  if (u.pathname === '/proxy') {
    if (!state.proxyAwake) { hung.push({ res, u }); return; }
    return servePage(res, u.searchParams.get('url') || 'http://site.test/');
  }
  if (u.pathname === '/reader') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ url: u.searchParams.get('url'), title: 'Mock page',
      text: 'Entanglement links distant nodes for testing.\n\nSecond paragraph of prose.', html: '', words: 12, images: [] }));
  }
  if (u.pathname === '/feeds') { res.writeHead(404); return res.end('nf'); }
  const p = u.pathname === '/' ? '/index.html' : u.pathname;
  const fp = path.join(ROOT, 'voyager', p);
  if (!fp.startsWith(path.join(ROOT, 'voyager')) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'text/plain' });
  fs.createReadStream(fp).pipe(res);
});

const results = [];
const check = (name, cond) => { results.push([name, !!cond]); console.log((cond ? '  ✓' : '  ✗'), name); };

const pw = loadPlaywright();
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await pw.chromium.launch({ executablePath: chromeExecutable() });
const errors = [];

/* ════ scenario 1: no proxy anywhere → honest basic-mode card ════ */
{
  state.servePing = false;                                     // static host: no ping endpoint
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('S1 ' + e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(async () => { const rs = await navigator.serviceWorker.getRegistrations(); for (const r of rs) await r.unregister(); });
  await page.waitForTimeout(400);
  check('basic mode: start page says big sites need the proxy',
    (await page.textContent('#internal')).includes('Basic mode'));
  await page.close();
}

/* ════ scenario 2: remote proxy configured but ASLEEP → waking card, waking veil, auto-recovery ════ */
{
  state.servePing = true;
  state.proxyAwake = false;
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('S2 ' + e.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((b) => {
    localStorage.clear();
    S = Voyager.setSetting(S, 'proxy', b + '/proxy');          // a "remote" proxy (same mock, toggleable)
    persist();
  }, base);
  await page.reload({ waitUntil: 'domcontentloaded' });
  // boot warm-up pings a sleeping proxy → the start page says "waking"
  await page.waitForFunction(() => document.getElementById('internal').textContent.includes('Waking the full browser'), null, { timeout: 20000 });
  check('sleeping proxy: start page shows the waking card', true);

  // navigating while asleep → waking veil (not "won't be framed"), then auto-load on wake
  await page.evaluate(() => { navTo('http://site.test/article'); });
  await page.waitForFunction(() => document.getElementById('veilTitle').textContent.includes('Waking'), null, { timeout: 15000 });
  check('stalled load is diagnosed as a sleeping proxy, not a refusing site', true);
  state.proxyAwake = true;                                     // the instance comes up
  // a real cold-start router eventually SERVES the held requests — do the same
  hung.splice(0).forEach(({ res, u }) => {
    try {
      if (u.pathname === '/proxy') servePage(res, u.searchParams.get('url') || 'http://site.test/');
      else { res.writeHead(503); res.end(); }                  // aborted pings just close
    } catch (e) {}
  });
  await page.waitForFunction(() => document.getElementById('veil').className.indexOf('on') === -1, null, { timeout: 25000 });
  check('page loads AUTOMATICALLY the moment the proxy wakes', true);
  check('a loaded page marks the proxy healthy', await page.evaluate(() => proxyHealth === 'ok'));

  /* ════ scenario 3 (same page): healthy-proxy journey — browse, remember, read, find ════ */
  await page.waitForTimeout(500);
  check('auto-capture remembered the page via /reader', await page.evaluate(() =>
    Voyager.inMemory(S, 'http://site.test/article')));
  await page.evaluate(() => { navTo('voyager://memory'); });
  await page.waitForSelector('#memSearch');
  await page.fill('#memSearch', 'entanglement');
  await page.waitForTimeout(200);
  check('memory search finds the page by a body word', !!(await page.$('#internal .mem-hit')));
  await page.click('#internal .mem-hit [data-readmem]');
  await page.waitForSelector('.reader .rbody');
  check('offline reader opens from memory', (await page.textContent('.reader .rbody')).includes('Entanglement'));
  await page.keyboard.press('Control+f');
  await page.fill('#findInput', 'entanglement');
  await page.waitForTimeout(200);
  check('⌘F finds and counts matches', (await page.textContent('#findCount')).includes('/'));
  await page.keyboard.press('Escape');

  /* ════ scenario 4: proxy dies for good → honest "unreachable", retry works ════ */
  await page.waitForTimeout(11000);                            // let the boot warm-up chain end (it stops once alive)
  state.proxyAwake = false;
  await page.evaluate(() => { proxyHealth = 'down'; navTo('voyager://start'); });
  await page.waitForTimeout(300);
  check('dead proxy: start page says unreachable with a retry button',
    (await page.textContent('#internal')).includes('unreachable') && !!(await page.$('[data-act="retryproxy"]')));
  state.proxyAwake = true;
  await page.click('[data-act="retryproxy"]');
  await page.waitForFunction(() => proxyHealth === 'ok', null, { timeout: 10000 });
  check('retry ping flips health back to ok', true);
  await page.close();
}

check('no page errors across scenarios', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));

await browser.close();
server.close();
const passed = results.filter((r) => r[1]).length;
console.log(`\nvoyager ui: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
