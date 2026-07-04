/**
 * Browser e2e for the ApexCoin loyalty flows (same offline harness as
 * booking.e2e.mjs — repo served statically, all external hosts blocked).
 *
 * Client:  seeded APEX balance → booking flow → "Pay with ApexCoin" toggle
 *          appears, partial redemption reduces the cash due, full redemption
 *          hides the card form and confirms without charging; the balance is
 *          deducted and the redemption transaction recorded.
 * Driver:  a persisted AXC wallet survives a reload, and "Redeem as Cash"
 *          zeroes the balance and records the redemption.
 *
 * Usage: node e2e/coin.e2e.mjs   (starts its own server on :4182)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PORT = Number(process.env.PORT || 4182);
const EXEC = process.env.PW_CHROMIUM;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.png': 'image/png', '.json': 'application/json' };

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

async function newPage(seed = {}) {
  const page = await browser.newPage({ viewport: { width: 430, height: 880 } });
  await page.addInitScript((entries) => {
    localStorage.setItem('apex_consent', 'all');
    localStorage.setItem('apexvip_guide_seen', '1');
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, seed);
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  return { page, errors };
}

// Drive the client to the payment screen (same path booking.e2e.mjs guards).
async function toPayment(page) {
  await page.goto(`${BASE}/apexvip-client.html`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Explore as guest').click();
  await page.getByText('Where would you like to go?').waitFor({ timeout: 5000 });
  await page.locator(`[onclick="goBook('hourly')"]`).first().click();
  await page.locator('#bh_pu').waitFor({ timeout: 5000 });
  await page.locator('#bh_pu').fill('Mayfair, London W1');
  await page.getByText('4h · £', { exact: false }).click();
  await page.getByText('Select vehicle').click();
  await page.locator('.vcard').first().waitFor({ timeout: 5000 });
  await page.locator('.vcard').first().click();
  await page.locator('button', { hasText: 'Continue · £' }).first().click();
  const payBtn = page.getByText(/Continue to payment · £\d+/);
  await payBtn.waitFor({ timeout: 5000 });
  const total = Number(((await payBtn.textContent()) || '').match(/£(\d+)/)?.[1] || 0);
  await payBtn.click();
  await page.getByText(/Loading payment form|Pay £|Confirm ·/).waitFor({ timeout: 5000 });
  return total;
}

// ── 1. Client: partial redemption reduces the cash due ─────────────────────
try {
  const { page, errors } = await newPage({ apex_balance: '50' });
  const total = await toPayment(page);
  await page.getByText('Pay with ApexCoin').waitFor({ timeout: 5000 });
  pass('client: redemption toggle offered when a balance exists');

  await page.getByText('Pay with ApexCoin').click();
  await page.getByText(`−50 APEX applied`).waitFor({ timeout: 5000 });
  const btnLabel = (await page.locator('#sq-pay-btn').textContent()) || '';
  if (btnLabel.trim() !== `Pay £${total - 50}`) fail(`partial redemption: pay button says "${btnLabel}", want "Pay £${total - 50}"`);
  else pass(`client: partial redemption drops the charge to £${total - 50} of £${total}`);
  if (errors.length) fail(`client partial-redeem page errors: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
} catch (e) { fail('client partial redemption: ' + e.message); }

// ── 2. Client: full redemption skips the card and deducts the balance ──────
try {
  const { page, errors } = await newPage({ apex_balance: '5000' });
  const total = await toPayment(page);
  await page.getByText('Pay with ApexCoin').click();
  await page.getByText('No card needed').waitFor({ timeout: 5000 });
  pass('client: full redemption hides the card form');

  await page.locator('#sq-pay-btn', { hasText: `Confirm · ${total} APEX` }).click();
  await page.getByText('Booking Confirmed').waitFor({ timeout: 8000 });
  pass('client: fully-covered booking confirms without a charge');

  const wallet = await page.evaluate(() => ({
    balance: Number(localStorage.getItem('apex_balance')),
    txs: JSON.parse(localStorage.getItem('apex_txs') || '[]'),
  }));
  if (wallet.balance !== 5000 - total) fail(`balance after full redemption is ${wallet.balance}, want ${5000 - total}`);
  else pass(`client: balance deducted (5000 → ${wallet.balance})`);
  const redeemTx = wallet.txs.find((t) => t.type === 'redeem');
  if (!redeemTx || redeemTx.amount !== total) fail('redeem transaction missing or wrong amount');
  else pass(`client: redemption recorded in the wallet ledger (−${redeemTx.amount} APEX)`);
  if (errors.length) fail(`client full-redeem page errors: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
} catch (e) { fail('client full redemption: ' + e.message); }

// ── 3. Client: guests with no balance never see the toggle ─────────────────
try {
  const { page } = await newPage();
  await toPayment(page);
  if (await page.getByText('Pay with ApexCoin').count()) fail('client: toggle shown with a zero balance');
  else pass('client: no toggle for a zero balance');
  await page.close();
} catch (e) { fail('client zero-balance: ' + e.message); }

// ── 4. Driver: wallet persists across reloads; redeem zeroes it ────────────
try {
  const { page, errors } = await newPage({
    apexvip_axc: '12.34',
    apexvip_axc_history: JSON.stringify([{ desc: 'Airport Transfer', type: 'earn', amount: 12.34, date: '1 Jul' }]),
  });
  await page.goto(`${BASE}/apexvip-driver.html`, { waitUntil: 'domcontentloaded' });
  await page.locator('text=ApexVIP').first().waitFor({ timeout: 5000 });
  const loaded = await page.evaluate(() => ({ coin: S.apexcoin, hist: S._axcHistory.length }));
  if (loaded.coin !== 12.34 || loaded.hist !== 1) fail(`driver wallet did not restore (coin=${loaded.coin}, hist=${loaded.hist})`);
  else pass('driver: persisted AXC wallet restores on load');

  page.on('dialog', (d) => d.accept());
  const after = await page.evaluate(() => {
    redeemAxc();
    return { coin: S.apexcoin, stored: localStorage.getItem('apexvip_axc'), hist: S._axcHistory };
  });
  if (after.coin !== 0 || after.stored !== '0') fail(`driver redeem left coin=${after.coin}, stored=${after.stored}`);
  else pass('driver: Redeem as Cash zeroes the balance and persists it');
  if (after.hist[0]?.type !== 'redeem' || after.hist[0]?.amount !== 12.34) fail('driver redeem transaction missing from history');
  else pass('driver: redemption recorded in the wallet history');
  if (errors.length) fail(`driver page errors: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
} catch (e) { fail('driver wallet: ' + e.message); }

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll ApexCoin e2e checks passed');
