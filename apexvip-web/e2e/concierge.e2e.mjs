/**
 * Browser e2e for the lifted ApexAI concierge screen.
 *
 * Loads the built page in Chromium, checks the greeting + example chips render,
 * sends a message, and asserts a typed assistant reply + the "understood" intent
 * summary appear — i.e. the on-device parser brain is wired through the UI. Runs
 * fully offline (no Firebase), so it exercises the local-engine path.
 *
 * Usage: BASE_URL=http://localhost:4178 SHOT=e2e/concierge.png node e2e/concierge.e2e.mjs
 * (npm run test:e2e starts a preview server and runs this.)
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://localhost:4178';
const SHOT = process.env.SHOT || 'e2e/concierge.png';
const EXEC = process.env.PW_CHROMIUM; // optional explicit binary path

const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
const page = await browser.newPage({ viewport: { width: 430, height: 880 } });
const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  // Greeting + example chips present on first load.
  await page.getByText("I'm your ApexVIP concierge", { exact: false }).waitFor({ timeout: 5000 });
  const chips = await page.locator('.ax-chip').count();
  if (chips < 4) fail(`expected example chips, found ${chips}`); else console.log(`✓ ${chips} example chips rendered`);

  // Send a ride request → typed reply + understood-summary.
  await page.getByTestId('input').fill('A car to Heathrow from Mayfair tomorrow at 9am');
  await page.getByTestId('send').click();

  const reply = page.locator('.ax-assistant .ax-bubble').last();
  await reply.waitFor({ timeout: 5000 });
  const replyText = (await reply.textContent())?.trim() || '';
  if (!replyText) fail('no assistant reply rendered'); else console.log('✓ assistant reply:', JSON.stringify(replyText.slice(0, 80)));

  const summary = page.locator('.ax-system .ax-bubble').last();
  await summary.waitFor({ timeout: 5000 });
  const summaryText = (await summary.textContent())?.trim() || '';
  if (!/Heathrow/i.test(summaryText)) fail(`summary missing the parsed destination: ${summaryText}`);
  else console.log('✓ understood summary:', JSON.stringify(summaryText));

  // Chips should be gone once the conversation starts.
  if (await page.locator('.ax-chip').count() !== 0) fail('example chips should disappear after first message');
  else console.log('✓ chips cleared after first message');

  await page.screenshot({ path: SHOT, fullPage: true });
  console.log('✓ screenshot →', SHOT);
} catch (err) {
  fail(err?.message || String(err));
} finally {
  await browser.close();
}

if (process.exitCode) { console.error('\nE2E FAILED'); } else { console.log('\nE2E PASSED'); }
