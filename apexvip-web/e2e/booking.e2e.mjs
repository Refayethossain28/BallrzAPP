/**
 * Browser e2e for the core client booking flow (+ render checks on all 3 apps).
 *
 * Serves the repo root statically and drives the REAL prototype pages in
 * Chromium with all Firebase/network SDKs blocked — deterministic offline mode,
 * identical locally and in CI. Guards the money path's UI:
 *
 *   splash → explore as guest → guide skip → home → By the Hour →
 *   pickup + duration → vehicle select → booking summary (fare math) → payment
 *
 * plus: driver + admin apps load with zero page errors, and the client's
 * escaping helper is present (XSS regression canary).
 *
 * Usage: node e2e/booking.e2e.mjs   (starts its own server on :4181)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PORT = Number(process.env.PORT || 4181);
const EXEC = process.env.PW_CHROMIUM;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.png': 'image/png', '.json': 'application/json' };

// ── Tiny static server for the repo root ────────────────────────────────────
const server = http.createServer((req, res) => {
  const path = join(ROOT, decodeURIComponent((req.url || '/').split('?')[0]));
  if (!path.startsWith(ROOT) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
  createReadStream(path).pipe(res);
});
await new Promise((ok) => server.listen(PORT, ok));
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures++; };
const pass = (m) => console.log('✓ ' + m);

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 430, height: 880 } });
  // Deterministic first-run state: consent given, app tour already seen.
  await page.addInitScript(() => {
    localStorage.setItem('apex_consent', 'all');
    localStorage.setItem('apexvip_guide_seen', '1');
  });
  // Block every external host → Firebase never initialises; offline mode is
  // deterministic in CI and sandboxes alike. Local files always load.
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  return { page, errors };
}

// ── 1. Client: full booking flow to the payment screen ─────────────────────
try {
  const { page, errors } = await newPage();
  await page.goto(`${BASE}/apexvip-client.html`, { waitUntil: 'domcontentloaded' });

  await page.getByText('Explore as guest').click();
  await page.getByText('Where would you like to go?').waitFor({ timeout: 5000 });
  pass('client: home renders for a guest');

  await page.locator(`[onclick="goBook('hourly')"]`).first().click();
  await page.locator('#bh_pu').waitFor({ timeout: 5000 });
  await page.locator('#bh_pu').fill('Mayfair, London W1');
  await page.getByText('4h · £', { exact: false }).click();  // pick the 4-hour block
  await page.getByText('Select vehicle').click();
  pass('client: hourly booking form accepts pickup + duration');

  await page.locator('.vcard').first().waitFor({ timeout: 5000 });
  await page.locator('.vcard').first().click();
  await page.locator('button', { hasText: 'Continue · £' }).first().click();
  pass('client: vehicle selected');

  // Booking summary: VAT-inclusive fare math from the shared engine.
  const payBtn = page.getByText(/Continue to payment · £\d+/);
  await payBtn.waitFor({ timeout: 5000 });
  const label = (await payBtn.textContent()) || '';
  const total = Number((label.match(/£(\d+)/) || [])[1] || 0);
  if (total <= 0) fail(`summary total not a positive fare: "${label}"`);
  else pass(`client: booking summary shows fare (£${total})`);

  await payBtn.click();
  await page.getByText(/Loading payment form|Pay £/).waitFor({ timeout: 5000 });
  pass('client: payment screen reached');

  // XSS canary: the escaping helper must exist and neutralise markup.
  const escaped = await page.evaluate(() => typeof esc === 'function' && esc('<img onerror=x>') === '&lt;img onerror=x&gt;');
  if (!escaped) fail('client: esc() helper missing or broken'); else pass('client: esc() escaping helper intact');

  if (errors.length) fail(`client page errors: ${errors.slice(0, 3).join(' | ')}`);
  else pass('client: zero page errors through the whole flow');
  await page.close();
} catch (e) { fail('client flow: ' + e.message); }

// ── 2. Driver + admin: load clean (login screens, zero page errors) ────────
for (const [app, marker] of [['apexvip-driver.html', 'text=ApexVIP'], ['apexvip-admin.html', 'input[type=email]']]) {
  try {
    const { page, errors } = await newPage();
    await page.goto(`${BASE}/${app}`, { waitUntil: 'domcontentloaded' });
    await page.locator(marker).first().waitFor({ timeout: 5000 });
    const hasEsc = await page.evaluate(() => typeof esc === 'function');
    if (!hasEsc) fail(`${app}: esc() helper missing`);
    if (errors.length) fail(`${app} page errors: ${errors.slice(0, 3).join(' | ')}`);
    else pass(`${app}: renders with zero page errors`);
    await page.close();
  } catch (e) { fail(`${app}: ` + e.message); }
}

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll booking-flow e2e checks passed');
