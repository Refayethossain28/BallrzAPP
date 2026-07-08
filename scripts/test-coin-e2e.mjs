#!/usr/bin/env node
/**
 * TimeCoin end-to-end regression guard — drives the REAL coin/index.html in a
 * headless browser against an in-process relay, locking in the fixes that were
 * hardest to get right (and that hand-review caught regressing more than once):
 *
 *   • a favour receipt is issued ONLY by the buyer's own authorising action —
 *     never auto-signed from a gossiped 'released' status (receipt forgery);
 *   • a neighbouring (peer) circle can share offers/reputation but can NOT reorg
 *     your chain or rewrite your credit limits (circle money isolation).
 *
 * Zero production dependencies: Playwright is a CI/dev-only tool, resolved from
 * node_modules or a well-known path. Run: node scripts/test-coin-e2e.mjs
 */
import { existsSync } from 'node:fs';
import { createRelay } from '../coin/server.mjs';

// Resolve Playwright from node_modules (CI) or the preinstalled path (this dev box).
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
const EXE = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const launchOpts = existsSync(EXE) ? { executablePath: EXE } : {};

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } };

async function boot(opts) {
  const server = createRelay({ rateCapacity: 100000, ...(opts || {}) });
  await new Promise((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const newPage = async (browser) => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return { page, errors };
};

const browser = await chromium.launch(launchOpts);

// ── Group 1: receipt is only issued by the buyer's own authorising action ──
{
  const A = await boot();
  const { page, errors } = await newPage(browser);
  await page.goto(A.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  if (!(await page.evaluate(() => document.querySelectorAll('#sendFrom option').length > 0))) {
    await page.click('#newWallet').catch(() => {}); await page.waitForTimeout(400);
  }
  const me = await page.evaluate(() => document.querySelector('#addrList option')?.value);
  // Seed: two deals I genuinely funded (fundedByMe), both in 'funded' state.
  const { S, atk } = await page.evaluate((me) => {
    const C = window.BallrzCoin;
    const S = C.walletFromPrivateKey('00'.repeat(31) + '05').address;
    const atk = C.walletFromPrivateKey('00'.repeat(31) + '06').address;
    localStorage.setItem('ballrzcoin.deals.v1', JSON.stringify({
      dealX: { id: 'dealX', title: 'real favour', price: C.COIN, buyer: me, seller: S, mode: 'direct', status: 'funded', at: Date.now() },
      dealY: { id: 'dealY', title: 'attacker favour', price: C.COIN, buyer: me, seller: atk, mode: 'direct', status: 'funded', at: Date.now() },
    }));
    localStorage.setItem('ballrzcoin.funded.v1', JSON.stringify({ dealX: 1, dealY: 1 }));
    return { S, atk };
  }, me);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  // ATTACK: re-gossip dealY as 'released' (I funded it, attacker is the seller).
  await page.evaluate(({ me, atk }) => fetch(location.origin + '/msg', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'deal', from: 'atk', deal: { id: 'dealY', title: 'x', price: 1, buyer: me, seller: atk, mode: 'direct', status: 'released', at: Date.now() + 9e6 } }),
  }), { me, atk });
  await page.waitForTimeout(2200);
  // LEGIT: I click "Confirm received" on dealX.
  const clicked = await page.evaluate(() => { const b = document.querySelector('[data-deal-release]'); if (b) { b.click(); return true; } return false; });
  await page.waitForTimeout(1200);
  const msgs = (await (await fetch(A.url + '/msgs?since=0')).json()).msgs;
  const receipts = msgs.filter((m) => m.type === 'rep' && m.rep && m.rep.kind === 'receipt' && m.rep.from === me);
  ok('a re-gossiped "released" status does NOT forge a receipt', receipts.filter((m) => m.rep.subject === atk).length === 0);
  ok('the buyer\'s own "Confirm received" DOES issue a receipt', clicked && receipts.filter((m) => m.rep.subject === S).length === 1);
  ok('group 1 produced no page errors', errors.length === 0);
  await page.close(); await A.close();
}

// ── Group 2: a neighbouring (peer) circle can't touch your money ──
{
  const A = await boot(); const B = await boot();
  const { page, errors } = await newPage(browser);
  await page.goto(A.url, { waitUntil: 'domcontentloaded' });        // home = A
  await page.waitForTimeout(800);
  const startH = await page.evaluate(() => (new window.BallrzCoin.Blockchain({})).blocks.length - 1);
  // Build a heavier chain + an offer + a hostile credit-limits map, post all to B.
  const heavier = await page.evaluate((B) => {
    const C = window.BallrzCoin;
    const bc = new C.Blockchain({}); const w = C.generateWallet();
    bc.minePendingTransactions(w.address); bc.minePendingTransactions(w.address);
    const post = (m) => fetch(B + '/msg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) });
    post({ type: 'chain', from: 'seed', blocks: bc.blocks });
    post({ type: 'offer', from: 'seed', offer: { id: 'nb1', title: 'Neighbour lift', desc: '', price: C.COIN, address: w.address, pubKey: w.publicKey, name: 'B', category: '', circle: 'Beta', at: Date.now() } });
    post({ type: 'limits', from: 'seed', limits: { [w.address]: 999 }, at: Date.now() + 9e6 });
    return { blocks: bc.blocks, height: bc.blocks.length - 1 };
  }, B.url);
  const limBefore = await page.evaluate(() => localStorage.getItem('ballrzcoin.credlimits.v1'));
  // Connect to B as a neighbour.
  await page.evaluate((B) => {
    document.getElementById('peerRelay').value = B;
    document.getElementById('peerName').value = 'Beta';
    document.getElementById('peerAdd').click();
    const btn = document.querySelector('[data-peer-connect]'); if (btn) btn.click();
  }, B.url);
  await page.waitForTimeout(3600);
  const peerH = await page.evaluate(() => document.querySelectorAll('#blockPicker option').length - 1);
  const offers = await page.evaluate(() => document.getElementById('offers').textContent);
  const limAfter = await page.evaluate(() => localStorage.getItem('ballrzcoin.credlimits.v1'));
  ok('a neighbour\'s heavier chain is NOT adopted (no reorg)', peerH === startH);
  ok('a neighbour\'s offer DOES federate (discovery works)', /Neighbour lift/.test(offers));
  ok('a neighbour\'s credit-limits map is NOT ingested', limAfter === limBefore);
  // Sanity: the same chain on a HOME relay IS adopted.
  await page.evaluate((blocks) => fetch(location.origin + '/msg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'chain', from: 'home', blocks }) }), heavier.blocks);
  await page.waitForTimeout(3400);
  const homeH = await page.evaluate(() => document.querySelectorAll('#blockPicker option').length - 1);
  ok('the same chain from a HOME relay IS adopted', homeH === heavier.height);
  ok('group 2 produced no page errors', errors.length === 0);
  await page.close(); await A.close(); await B.close();
}

await browser.close();
console.log('\ncoin e2e: ' + passed + '/' + (passed + failed) + ' passed');
process.exit(failed ? 1 : 0);
