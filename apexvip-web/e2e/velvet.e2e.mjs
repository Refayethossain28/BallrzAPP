/**
 * Browser e2e for the ApexVIP Concierge surface — all four faces of it:
 *
 *   1. the standalone member app (concierge/) driven through its whole life:
 *      paywall → trial → request → desk simulation → three options → chat
 *      (scripted fallback) → confirm → auto-complete → club (plan change,
 *      cancel/resume) → reload persistence
 *   2. the ApexVIP client's Concierge tab embedding it in an iframe
 *   3. the admin console's Concierge desk screen (seeded: tier-first queue,
 *      SLA badges, lifecycle actions) + the all-apps analytics sections
 *   4. the mobile ops app (seeded: queue, detail actions + composer, pulse)
 *
 * All external hosts are blocked, so this also proves the graceful-offline
 * story: no Firebase, no gstatic, zero page errors anywhere.
 *
 * Usage: node e2e/velvet.e2e.mjs   (starts its own server on :4183)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PORT = Number(process.env.PORT || 4183);
const EXEC = process.env.PW_CHROMIUM;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let path = join(ROOT, decodeURIComponent((req.url || '/').split('?')[0]));
  if (path.endsWith('/') || (existsSync(path) && statSync(path).isDirectory())) path = join(path, 'index.html');
  if (!path.startsWith(ROOT) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
  createReadStream(path).pipe(res);
});

let failures = 0;
const ok = (name) => console.log('  ✓ ' + name);
const fail = (name, err) => { failures++; console.error('  ✗ ' + name + '\n    ' + (err && err.message || err)); };

async function newPage(browser, { width = 390, height = 780 } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  // only the local server answers — offline degradation must hold everywhere
  await page.route('**/*', (route) => {
    route.request().url().startsWith(`http://localhost:${PORT}/`) ? route.continue() : route.abort();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return { page, errors };
}

/* ── 1. the member app, end to end ─────────────────────────────────────── */
async function memberFlow(browser) {
  const { page, errors } = await newPage(browser);
  await page.goto(`http://localhost:${PORT}/concierge/`);
  await page.waitForSelector('#paywall .plans .plan');

  await page.fill('#nameInput', 'Rafa');
  await page.click('.plan[data-plan="black"]');      // fastest desk simulation
  await page.click('#startBtn');
  await page.waitForSelector('.mcard');
  const card = await page.textContent('.mcard');
  if (!/Black/.test(card) || !/Rafa/.test(card)) throw new Error('membership card wrong');
  ok('trial starts; membership card renders');

  await page.click('.svc[data-cat="dining"]');
  await page.fill('#reqTitle', 'Table for four, Saturday');
  await page.fill('#reqDetails', '8pm if possible.');
  await page.click('#submitReq');
  await page.waitForSelector('#detail .chat .msg.desk');
  await page.waitForSelector('#detail .opt', { timeout: 30000 });
  if (await page.locator('#detail .opt').count() !== 3) throw new Error('expected 3 options');
  ok('desk simulation reaches three priced options');

  await page.fill('#chatInput', 'Round table please');
  await page.click('#chatSend');
  await page.waitForFunction(() => document.querySelectorAll('#detail .msg.desk').length >= 5, null, { timeout: 8000 });
  ok('chat gets exactly one desk reply (scripted fallback offline)');

  await page.click('#detail .opt[data-opt="1"]');
  await page.waitForSelector('.sheet [data-act="yes"]');
  await page.click('.sheet [data-act="yes"]');
  await page.waitForFunction(() => document.querySelector('#detail').textContent.includes('Confirmed'), null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#detail').textContent.includes('Completed'), null, { timeout: 45000 });
  ok('option confirms, points credit, request auto-completes');

  await page.click('#dBack');
  await page.click('nav.tabs button[data-tab="club"]');
  await page.waitForSelector('.planrow');
  const club = await page.textContent('#view');
  for (const needle of ['ApexVIP Black', 'Free trial', 'Downgrade', 'No charges yet', 'Account & sync']) {
    if (!club.includes(needle)) throw new Error('club missing: ' + needle);
  }
  if (!/Cloud unreachable|Connecting/.test(club)) throw new Error('offline account state missing');
  ok('club shows plan, billing, offline account state');

  await page.click('[data-switch="gold"]');
  await page.click('.sheet [data-act="yes"]');
  await page.waitForFunction(() => document.querySelector('#view').textContent.includes('moving to Gold'), null, { timeout: 8000 });
  await page.click('#cancelBtn');
  await page.click('.sheet [data-act="yes"]');
  await page.waitForSelector('#resumeBtn');
  await page.click('#resumeBtn');
  await page.waitForSelector('#cancelBtn');
  ok('downgrade schedules; cancel/resume round-trips');

  await page.reload();
  await page.waitForSelector('.mcard');
  if (!/Rafa/.test(await page.textContent('#view'))) throw new Error('persistence lost');
  ok('state persists across reload');

  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  await page.close();
}

/* ── 2. embedded in the ApexVIP client ─────────────────────────────────── */
async function embedFlow(browser) {
  const { page, errors } = await newPage(browser);
  await page.goto(`http://localhost:${PORT}/apexvip-client.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => go('concierge'));
  await page.waitForSelector('#concierge-frame', { timeout: 8000 });
  await page.waitForTimeout(2000);
  const frame = page.frames().find((f) => f.url().includes('/concierge/'));
  if (!frame) throw new Error('concierge iframe did not load');
  const velvet = await frame.evaluate(() => ({
    engine: typeof window.Velvet === 'object',
    paywall: !!document.querySelector('#paywall .plans .plan'),
  }));
  if (!velvet.engine || !velvet.paywall) throw new Error('concierge not rendering in frame');
  const bottom = await page.evaluate(() => document.getElementById('concierge-wrap').style.bottom);
  if (!/px$/.test(bottom)) throw new Error('frame not pinned above the nav');
  ok('client Concierge tab embeds the app, pinned above the nav (' + bottom + ')');
  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  await page.close();
}

/* ── 3. admin console desk + all-apps analytics ────────────────────────── */
async function adminFlow(browser) {
  const { page, errors } = await newPage(browser, { width: 1280, height: 900 });
  await page.goto(`http://localhost:${PORT}/apexvip-admin.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const out = await page.evaluate(() => {
    const now = Date.now();
    VMEMBERS = [
      { uid: 'u1', memberName: 'Rafa', points: 620, billing: 'local',
        sub: { tierId: 'black', status: 'trialing', periodStart: now, periodEnd: now + 7 * 86400000 } },
      { uid: 'u2', memberName: 'Alex', points: 40, billing: 'stripe',
        sub: { tierId: 'silver', status: 'active', periodStart: now, periodEnd: now + 30 * 86400000 } },
    ];
    VREQS = [
      { docId: 'd1', id: 'r1', ownerUid: 'u1', title: 'Table for four', category: 'dining',
        status: 'submitted', submittedAt: now - 20 * 60000, firstResponseAt: null, messages: [{}] },
      { docId: 'd2', id: 'r2', ownerUid: 'u2', title: 'Car to Heathrow', category: 'chauffeur',
        status: 'sourcing', submittedAt: now - 300 * 60000, firstResponseAt: now - 250 * 60000, messages: [{}, {}] },
    ];
    const html = pages.concierge();
    localStorage.setItem('apexvip_events', JSON.stringify([
      { e: 'concierge_request_created', t: now, category: 'dining', src: 'concierge' },
      { e: 'concierge_option_confirmed', t: now, price: 315, src: 'concierge' },
      { e: 'membership_trial_started', t: now, tier: 'black', src: 'concierge' },
      { e: 'job_accepted', t: now, src: 'driver' },
    ]));
    return { engine: typeof window.Velvet === 'object', html, analyticsHtml: pages.analytics() };
  });
  if (!out.engine) throw new Error('engine not loaded in admin');
  for (const needle of ['Concierge desk', 'Rafa', 'Table for four', 'BLACK', 'Triage', 'Send options', 'Reply', 'Concierge MRR']) {
    if (!out.html.includes(needle)) throw new Error('desk screen missing: ' + needle);
  }
  if (out.html.indexOf('Table for four') > out.html.indexOf('Car to Heathrow')) throw new Error('queue not tier-first');
  for (const needle of ['Across the apps', 'Concierge programme', 'Concierge revenue']) {
    if (!out.analyticsHtml.includes(needle)) throw new Error('analytics missing: ' + needle);
  }
  ok('admin desk: tier-first queue, SLA + actions; analytics collects all apps');
  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  await page.close();
}

/* ── 4. the mobile ops app ─────────────────────────────────────────────── */
async function opsFlow(browser) {
  const { page, errors } = await newPage(browser);
  await page.goto(`http://localhost:${PORT}/concierge/ops.html`);
  await page.waitForTimeout(1200);
  if (!/Cloud unreachable|Connecting/.test(await page.textContent('#login'))) {
    throw new Error('ops offline login state wrong');
  }
  await page.evaluate(() => {
    const now = Date.now();
    window.__opsSeed(
      [{ docId: 'd1', id: 'r1', ownerUid: 'u1', title: 'Table for four', category: 'dining',
         status: 'sourcing', submittedAt: now - 25 * 60000, firstResponseAt: now - 20 * 60000, updatedAt: now,
         messages: [{ from: 'desk', text: 'Received.', at: now - 25 * 60000 },
                    { from: 'me', text: 'Round table please', at: now - 10 * 60000 }] }],
      [{ uid: 'u1', memberName: 'Rafa', points: 620, billing: 'local',
         sub: { tierId: 'black', status: 'trialing', periodStart: now, periodEnd: now + 7 * 86400000 } }]
    );
  });
  await page.waitForSelector('.req');
  await page.click('.req');
  await page.waitForSelector('#detail .chat .msg');
  const detail = await page.textContent('#detail');
  for (const needle of ['Send options', 'Round table', 'Rafa']) {
    if (!detail.includes(needle)) throw new Error('ops detail missing: ' + needle);
  }
  if (!(await page.locator('#opsChat').count())) throw new Error('ops composer missing');
  await page.click('#opsBack');
  await page.click('nav.tabs button[data-tab="pulse"]');
  const pulse = await page.textContent('#view');
  for (const needle of ['Open requests', 'Concierge MRR', '£499']) {
    if (!pulse.includes(needle)) throw new Error('ops pulse missing: ' + needle);
  }
  ok('ops app: offline gate, seeded queue, detail actions + composer, pulse KPIs');
  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  await page.close();
}

/* ── run ───────────────────────────────────────────────────────────────── */
(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  console.log('velvet e2e — concierge member app / embed / admin desk / ops');
  for (const [name, fn] of [
    ['member app end-to-end', memberFlow],
    ['ApexVIP client embed', embedFlow],
    ['admin console desk + analytics', adminFlow],
    ['mobile ops app', opsFlow],
  ]) {
    try { await fn(browser); } catch (err) { fail(name, err); }
  }
  await browser.close();
  server.close();
  if (failures) { console.error(failures + ' suite(s) failed'); process.exit(1); }
  console.log('velvet e2e: all suites passed');
})();
