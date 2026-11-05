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

const Proxy = (() => {        // repo is type:module — load the UMD via a vm sandbox, like the unit tests
  const vm = require('node:vm');
  const sb = { module: { exports: {} } }; sb.self = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'voyager', 'proxy.js'), 'utf8'), sb, { filename: 'voyager/proxy.js' });
  return sb.module.exports;
})();

const STEALTH_RAW = `<html><head><title>Stealth</title></head><body>
<h1>Stealth test page with plenty of visible text so the blank detector stays quiet.</h1>
<div id="status"></div>
<script>
var seen = (function(){ try { return localStorage.getItem('visited') || (/visited=1/.test(document.cookie) ? '1' : ''); } catch(e){ return 'ERR'; } })();
var el = document.getElementById('status');
el.textContent = seen ? 'RECOGNISED' : 'FIRST VISIT';
try { localStorage.setItem('visited','1'); document.cookie = 'visited=1; path=/'; } catch(e){}
el.textContent += (localStorage.getItem('visited')==='1' && /visited=1/.test(document.cookie)) ? ' (writes ok)' : ' (writes broken)';
</script></body></html>`;

const HOSTILE_RAW = `<html><head><title>Hostile</title></head><body>
<h1>Hostile SPA page with plenty of visible prose so the blank detector stays quiet here.</h1>
<div id="box"></div>
<form id="sf" action="/find"><input name="q" id="q"></form>
<script>
// the SPA pattern that used to defeat the shim: swallow events, no preventDefault
document.getElementById('box').addEventListener('click', function (e) { e.stopPropagation(); });
document.getElementById('sf').addEventListener('submit', function (e) { e.stopPropagation(); });
// and a link inserted AFTER load — the server rewriter never saw it
var a = document.createElement('a'); a.id = 'dyn'; a.textContent = 'next'; a.href = '/dyn/page2';
document.getElementById('box').appendChild(a);
</script></body></html>`;

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

// Module scope: the wake-up splice (test code) serves held requests with this
// too — inside the handler it was out of scope there, the ReferenceError was
// swallowed, and the held frame request hung forever (a 50/50 flake at wake).
const servePage = (res2, target) => {
    res2.writeHead(200, { 'content-type': 'text/html' });
    if (String(target).includes('emptyapp')) {
      // an app shell that "loads" but paints nothing — the YouTube-homepage case
      return res2.end(`<!doctype html><meta charset=utf8><title>Shell</title>
        <body><div id="app"></div>
        <script>parent.postMessage({voyager:'loaded', url:${JSON.stringify(target)}, title:'Shell', trackers:0}, '*');</script>`);
    }
    res2.end(`<!doctype html><meta charset=utf8><title>Mock page</title>
      <body><h1>Mock page</h1><p>Entanglement links distant nodes for testing.</p>
      <script>parent.postMessage({voyager:'loaded', url:${JSON.stringify(target)}, title:'Mock page', trackers:0}, '*');</script>`);
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (process.env.VGR_DEBUG) console.log('[mock]', u.pathname, state.proxyAwake ? 'awake' : 'ASLEEP', u.searchParams.get('url') || '');
  if (u.pathname === '/__voyager/ping') {
    if (!state.servePing) { res.writeHead(404); return res.end('nf'); }
    if (!state.proxyAwake) { hung.push({ res, u }); return; }   // asleep: hang, like a cold instance
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ voyager: true }));
  }
  if (u.pathname === '/proxy') {
    if (!state.proxyAwake) { hung.push({ res, u }); return; }
    // fold GET-form fields into the target, exactly like the real server
    const folded = Proxy.mergeFormQuery([...u.searchParams]);
    const target = (folded && folded.merged) || 'http://site.test/';
    if (target.includes('hostile.test/find')) {
      // echo where the form actually landed, query and all
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><meta charset=utf8><title>Found</title>
        <body><h1>FOUND</h1><p id="echo">${target}</p>
        <p>Plenty of result prose so the blank detector stays quiet on this page too.</p>
        <script>parent.postMessage({voyager:'loaded', url:${JSON.stringify(target)}, title:'Found', trackers:0}, '*');</script>`);
    }
    if (target.includes('hostile.test')) {
      // the REAL rewrite pipeline, so the shim's default-action backstop is live
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(Proxy.rewriteHtml(HOSTILE_RAW, target, '/proxy'));
    }
    if (target.includes('slowspa.test')) {
      // fires 'load' with an EMPTY shell and hydrates 2.5s later — the SPA way
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><meta charset=utf8><title>SlowSPA</title>
        <body><div id="app"></div>
        <script>parent.postMessage({voyager:'loaded', url:${JSON.stringify(target)}, title:'SlowSPA', trackers:0}, '*');
        setTimeout(function () { document.getElementById('app').innerHTML =
          '<h1>Hydrated now</h1><p>Plenty of text appears after a slow client-side boot, well past any single early sample.</p>'; }, 2500);</script>`);
    }
    if (target.includes('nested.test')) {
      // a path that serves Voyager ITSELF into the frame (sw fallback / self-link)
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(fs.readFileSync(path.join(ROOT, 'voyager', 'index.html'), 'utf8'));
    }
    if (target.includes('stealth.test')) {
      // the REAL rewrite pipeline, so the shim's amnesia decoys are present
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(Proxy.rewriteHtml(STEALTH_RAW, target, '/proxy'));
    }
    return servePage(res, target);
  }
  if (u.pathname === '/reader') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ url: u.searchParams.get('url'), title: 'Mock page',
      text: 'Entanglement links distant nodes for testing.\n\nSecond paragraph of prose.', html: '', words: 12, images: [] }));
  }
  if (u.pathname === '/feeds') { res.writeHead(404); return res.end('nf'); }
  if (u.pathname === '/sibling/') {
    // a same-origin sibling app (Seeker-like): handles its own search submit in-page
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><meta charset=utf8><title>Sibling</title>
      <body><h1>Sibling app</h1><form id="f"><input id="q" name="q"></form><div id="out">idle</div>
      <script>document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();
        document.getElementById('out').textContent='RESULTS for '+document.getElementById('q').value;});</script>`);
  }
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
  page.on('pageerror', (e) => {
    // the self-frame guard halts a nested copy by throwing on purpose — that
    // deliberate bow-out is the fix working, not a defect
    if (!String(e.message).includes('voyager-in-voyager')) errors.push('S2 ' + e.message);
  });
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

  /* ════ scenario 3r: a browser must never recurse — Voyager served into its
     own frame bows out and the outer browser comes home with a toast ════ */
  await page.evaluate(() => { navTo('http://nested.test/'); });
  await page.waitForFunction(() => Voyager.tabUrl(Voyager.activeTab(S)) === 'voyager://start', null, { timeout: 8000 });
  check('nested Voyager bows out and the outer browser comes home', true);
  check('the escape explains itself', await page.evaluate(() =>
    document.getElementById('toast').textContent.includes('already here')));
  check('the dead-end address is remembered as Voyager itself', await page.evaluate(() =>
    (S.selfUrls || []).some((u) => u.includes('nested.test'))));
  check('…and never shows as a Top Sites tile', await page.evaluate(() =>
    Voyager.topSites(S, 8).every((t) => !String(t.url).includes('nested.test'))));

  /* ════ scenario 3s: 👻 amnesia — a site that plants recognition data meets
     fresh decoys on every visit, and never touches the app's real storage ════ */
  await page.evaluate(() => { navTo('http://stealth.test/'); });
  await page.waitForFunction(() => {
    try { const s = document.getElementById('frame').contentDocument.getElementById('status'); return s && s.textContent.length > 0; }
    catch (e) { return false; }
  }, null, { timeout: 8000 });
  check('stealth page: first visit reads clean, in-page writes still work', await page.evaluate(() =>
    document.getElementById('frame').contentDocument.getElementById('status').textContent === 'FIRST VISIT (writes ok)'));
  await page.evaluate(() => { navTo('http://site.test/elsewhere'); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { navTo('http://stealth.test/'); });
  await page.waitForFunction(() => {
    try { const s = document.getElementById('frame').contentDocument.getElementById('status'); return s && s.textContent.length > 0; }
    catch (e) { return false; }
  }, null, { timeout: 8000 });
  check('👻 return visit is indistinguishable from the first', await page.evaluate(() =>
    document.getElementById('frame').contentDocument.getElementById('status').textContent === 'FIRST VISIT (writes ok)'));
  check('the decoys kept the site out of the app\'s REAL storage', await page.evaluate(() =>
    localStorage.getItem('visited') === null && !/visited=1/.test(document.cookie)));

  /* ════ scenario 3a: a SAME-ORIGIN sibling app frames natively — never proxied,
     and its in-page search works untouched (the Seeker regression) ════ */
  await page.evaluate((b) => { navTo(b + '/sibling/'); }, base);
  await page.waitForTimeout(600);
  check('same-origin sibling loads DIRECT, not through the proxy', await page.evaluate(() =>
    document.getElementById('frame').getAttribute('src').indexOf('/proxy?url=') === -1));
  await page.evaluate(() => {
    const doc = document.getElementById('frame').contentDocument;
    doc.getElementById('q').value = 'cats';
    doc.getElementById('f').dispatchEvent(new doc.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  check('sibling app\'s own search runs in place', await page.evaluate(() =>
    document.getElementById('frame').contentDocument.getElementById('out').textContent === 'RESULTS for cats'));
  check('submitting did not hijack the tab elsewhere', await page.evaluate((b) =>
    Voyager.tabUrl(Voyager.activeTab(S)) === b + '/sibling/', base));

  /* ════ scenario 3b: an app shell that loads EMPTY → the honest blank bar ════ */
  await page.evaluate(() => { navTo('http://www.youtube.com/emptyapp'); });
  await page.waitForFunction(() => document.getElementById('blankbar').className.includes('on'), null, { timeout: 8000 });
  check('empty app shell raises the honest blank bar', true);
  check('blank bar knows YouTube videos still play', (await page.textContent('#blankMsg')).includes('videos'));
  await page.evaluate(() => { navTo('http://site.test/article2'); });
  await page.waitForTimeout(2200);
  check('a real page never triggers the blank bar', await page.evaluate(() =>
    !document.getElementById('blankbar').className.includes('on')));

  /* ════ scenario 3c: 🧹 clear site data — one button and websites meet a
     stranger: cookies evicted, session storage dropped, Voyager's own kept ════ */
  await page.evaluate(() => {
    document.cookie = 'tracker=42; path=/';
    document.cookie = 'sid=deadbeef';
    sessionStorage.setItem('spy', '1');
    navTo('voyager://settings');
  });
  await page.waitForSelector('[data-act="forgetsites"]', { timeout: 5000 });
  await page.click('[data-act="forgetsites"]');
  await page.waitForTimeout(300);
  check('🧹 every cookie is gone', await page.evaluate(() =>
    !/tracker=42/.test(document.cookie) && !/sid=deadbeef/.test(document.cookie)));
  check('session storage is empty', await page.evaluate(() => sessionStorage.length === 0));
  check('Voyager\'s own tabs/history/settings survive the sweep', await page.evaluate(() =>
    localStorage.getItem('voyager.session.v1') !== null));
  check('the sweep announces itself', await page.evaluate(() =>
    document.getElementById('toast').textContent.includes('stranger')));

  /* ════ scenario 3d: hostile SPA — a page that SWALLOWS events (stopPropagation,
     no preventDefault) still cannot escape the proxy: the attributes themselves
     are safe, so default actions land proxied with their queries intact ════ */
  await page.evaluate(() => { navTo('http://hostile.test/'); });
  await page.waitForFunction(() => {
    try { return !!document.getElementById('frame').contentDocument.getElementById('dyn'); }
    catch (e) { return false; }
  }, null, { timeout: 8000 });
  let hframe = await (await page.$('#frame')).contentFrame();
  await hframe.click('#dyn');
  await page.waitForFunction(() => Voyager.tabUrl(Voyager.activeTab(S)) === 'http://hostile.test/dyn/page2', null, { timeout: 8000 });
  check('a dynamic link whose click the page swallows STILL lands proxied', true);
  check('…and the 👻 ghost promise holds (the frame rides the proxy)', await page.evaluate(() =>
    String(document.getElementById('frame').contentWindow.location.href).includes('/proxy?url=')));
  await page.evaluate(() => { navTo('http://hostile.test/'); });
  await page.waitForFunction(() => {
    try { return !!document.getElementById('frame').contentDocument.getElementById('q'); }
    catch (e) { return false; }
  }, null, { timeout: 8000 });
  hframe = await (await page.$('#frame')).contentFrame();
  await hframe.fill('#q', 'cats');
  await hframe.evaluate(() => document.getElementById('sf').requestSubmit());
  await page.waitForFunction(() => {
    try { return (document.getElementById('frame').contentDocument.body.textContent || '').includes('FOUND'); }
    catch (e) { return false; }
  }, null, { timeout: 8000 });
  check('a GET form whose submit the page swallows reaches its target WITH the query', await page.evaluate(() =>
    document.getElementById('frame').contentDocument.getElementById('echo').textContent.includes('/find?q=cats')));

  /* ════ scenario 3e: a slow-hydrating SPA never gets the false "loaded empty" bar ════ */
  await page.evaluate(() => { navTo('http://slowspa.test/'); });
  await page.waitForTimeout(3300);                             // past the old single 1.5s sample AND the 2.5s hydration
  check('a slow-hydrating SPA never sees the "loaded empty" banner', await page.evaluate(() =>
    !document.getElementById('blankbar').className.includes('on')));
  await page.waitForTimeout(3000);                             // past the second (warning) sample too
  check('…even after the second look', await page.evaluate(() =>
    !document.getElementById('blankbar').className.includes('on')));

  /* ════ scenario 3f: recursion in the SPLIT pane dissolves the split —
     the main tab, mid-read elsewhere, is never hijacked ════ */
  await page.evaluate(() => { navTo('http://site.test/mainread'); });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    var reading = S.activeId;
    commit(Voyager.newTab(S, { url: 'http://nested.test/split-copy', ts: Date.now() }));
    var partner = S.activeId;
    commit(Voyager.activateTab(S, reading));
    commit(Voyager.setSplit(S, partner));
  });
  await page.waitForFunction(() => !Voyager.splitTab(S), null, { timeout: 8000 });
  check('nested Voyager in the SPLIT pane dissolves the split', true);
  check('…and the split pane\'s dead-end address is remembered too', await page.evaluate(() =>
    (S.selfUrls || []).some((u) => u.includes('nested.test/split-copy'))));
  check('…without hijacking the main tab', await page.evaluate(() =>
    Voyager.tabUrl(Voyager.activeTab(S)) === 'http://site.test/mainread'));
  check('…and says why', await page.evaluate(() =>
    document.getElementById('toast').textContent.includes('closed the split')));

  /* ════ scenario 3g: 🧹 with a split open — both panes reload, nothing is hijacked ════ */
  await page.evaluate(() => {
    var reading = S.activeId;
    commit(Voyager.newTab(S, { url: 'http://site.test/pane2', ts: Date.now() }));
    var partner = S.activeId;
    commit(Voyager.activateTab(S, reading));
    commit(Voyager.setSplit(S, partner));
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => { doForgetSites(); });
  await page.waitForTimeout(900);
  check('🧹 with a split open: panes reload, nothing is hijacked', await page.evaluate(() => {
    var sp = Voyager.splitTab(S);
    var src = document.getElementById('frame2').getAttribute('src') || '';
    return Voyager.tabUrl(Voyager.activeTab(S)) === 'http://site.test/mainread' &&
      !!sp && src.includes('/proxy?url=') &&
      document.getElementById('toast').textContent.includes('stranger');
  }));
  await page.evaluate(() => { commit(Voyager.setSplit(S, null)); });

  /* ════ scenario 3h: stalls are diagnosed by HOW the page loads — only a load
     that rides the proxy may be blamed on the proxy ════ */
  check('stalled .onion / same-origin loads are never blamed on the proxy', await page.evaluate(() => {
    var seen = ''; var orig = showVeil;
    showVeil = function (m) { seen = m; };
    var out;
    try {
      frameStalled('http://abcdefghijklmnop.onion/');
      var onion = seen; seen = '';
      frameStalled(location.origin + '/sibling/');
      var sib = seen; seen = '';
      frameStalled('http://plain.test/never-current');          // proxied → waking (wakeStep bails: not current)
      out = onion + '|' + sib + '|' + seen;
    } finally { showVeil = orig; }
    return out === 'blocked|blocked|waking';
  }));
  check('a finished load retires the wake-loop generation (stale pings stand down)', await page.evaluate(() => {
    var g = wakeGen; stopWakeLoop(); return wakeGen === g + 1;
  }));
  await page.evaluate(() => { hideVeil(); navTo('voyager://start'); });

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
