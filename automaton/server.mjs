#!/usr/bin/env node
/**
 * automaton/server.mjs — the automaton's storefront + autonomous heartbeat.
 *
 * The one place a CUSTOMER touches the automaton: a web page where they
 * describe a task, pay for it in one step, and watch their answer arrive.
 * Zero dependencies (Node 18+ http/fetch), matching the repo's ethos.
 *
 *   node automaton/server.mjs             # http://localhost:8791
 *
 * Flow (real mode, STRIPE_SECRET_KEY set):
 *   POST /api/order  → Stripe Checkout → customer pays → poller sees the paid
 *   session → wallet credited (real money) → task lands in the inbox →
 *   the scheduled heartbeat works it → answer appears on the order page.
 * Without a key it runs in DEMO mode: orders queue instantly, credits are
 * simulated, and the identical loop is testable end-to-end for free.
 *
 * Safeguards, same as ever: Stripe usage is receive-only (create checkout,
 * read payment state — no refunds/transfers/payouts); the customer can only
 * reach /api/order and /api/order/:id; owner keys live in the shell.
 *
 * Env: PORT (8791) · AUTOMATON_TICK_MS (900000 = 15 real minutes, 1:1 with
 * simulated time) · AUTOMATON_POLL_MS (20000) · STRIPE_SECRET_KEY ·
 * ANTHROPIC_API_KEY (real brain).
 */
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isAlive, modelFor, credit, applyStripePayment, round2, serverCost, TICK_MINUTES, newborn } from './logic.mjs';
import { stripeEnabled, stripeMode, createCheckout, getSession } from './stripe.mjs';
import {
  HOME, INBOX, OUTBOX, ORDERS, ensureDirs,
  tombstoneText, loadRaw, save, inboxTasks, heartbeat, money,
} from './agent.mjs';
import { MENU, validateOrder, isOrderId, taskMarkdown, taskFileFor, answerFileFor } from './orders.mjs';

const SRC = dirname(fileURLToPath(import.meta.url)); // shop.html lives with the code, not the agent home
const PORT = Number(process.env.PORT) || 8791;
const TICK_MS = Number(process.env.AUTOMATON_TICK_MS) || 15 * 60 * 1000; // 1:1 with simulated time
const POLL_MS = Number(process.env.AUTOMATON_POLL_MS) || 20 * 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

ensureDirs();
if (!loadRaw() && !tombstoneText()) {
  if (process.env.AUTOMATON_AUTOBOOT) {
    // Cloud deploys: first container start births the agent on its volume.
    const state = newborn(`automaton-${randomBytes(4).toString('hex').slice(0, 6)}`, Date.now());
    save(state);
    log(`AUTOBOOT — born ${state.id} with $${state.balance.toFixed(2)} genesis grant (home: ${HOME})`);
  } else {
    log('No automaton here — boot one first:  node automaton/automaton.mjs boot');
    log('(or set AUTOMATON_AUTOBOOT=1 to birth one automatically)');
    process.exit(1);
  }
}

/* ── order files: orders/<id>.json { order, status, sessionId?, paidAt? } ── */
const orderPath = (id) => join(ORDERS, `${id}.json`);
const readOrder = (id) => (existsSync(orderPath(id)) ? JSON.parse(readFileSync(orderPath(id), 'utf8')) : null);
const writeOrder = (id, data) => writeFileSync(orderPath(id), JSON.stringify(data, null, 2) + '\n');
const newOrderId = () => `ord-${randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase().padEnd(10, '0')}`;

/** A paid order becomes an inbox task + a wallet credit. */
function activateOrder(id, rec, payment) {
  let state = loadRaw();
  if (!state || !isAlive(state)) return false;
  writeFileSync(join(INBOX, taskFileFor(id)), taskMarkdown(rec.order, id) + '\n');
  state = payment
    ? applyStripePayment(state, { ...payment, note: `REAL storefront order ${id}: ${rec.order.title}` }, Date.now())
    : credit(state, rec.order.price, `storefront order ${id} (demo): ${rec.order.title}`, Date.now());
  save(state);
  rec.status = 'queued';
  rec.paidAt = Date.now();
  writeOrder(id, rec);
  log(`order ${id} paid ${money(rec.order.price)} → inbox (balance ${money(state.balance)})`);
  return true;
}

function orderStatus(id) {
  const rec = readOrder(id);
  if (!rec) return null;
  const answerFile = join(OUTBOX, answerFileFor(id));
  if (existsSync(answerFile)) {
    return { id, status: 'done', title: rec.order.title, tier: rec.order.tier, answer: readFileSync(answerFile, 'utf8') };
  }
  if (rec.status === 'queued') {
    const queue = inboxTasks();
    const pos = queue.indexOf(taskFileFor(id));
    return { id, status: pos === 0 ? 'working' : 'queued', title: rec.order.title, tier: rec.order.tier, position: Math.max(pos, 0) + 1 };
  }
  return { id, status: 'awaiting-payment', title: rec.order.title, tier: rec.order.tier, checkoutUrl: rec.checkoutUrl };
}

/* ── public wallet snapshot for the shop header ── */
function publicState() {
  const tomb = tombstoneText();
  const state = loadRaw();
  if (tomb || !state || state.dead) {
    return { alive: false, tombstone: tomb || 'hit zero, gone for good' };
  }
  const rung = modelFor(state.balance);
  return {
    alive: true,
    id: state.id,
    balance: state.balance,
    model: rung.model,
    rung: rung.label,
    tasksDone: state.tasksDone,
    queue: inboxTasks().length,
    runwayTicks: Math.floor(state.balance / serverCost(TICK_MINUTES)),
    economy: stripeEnabled() ? `real (stripe ${stripeMode()})` : 'demo (simulated credits)',
    menu: MENU,
  };
}

/* ── the autonomous heartbeat: rent always falls due; work gets done ── */
let beating = false;
async function beat(reason) {
  if (beating) return;
  beating = true;
  try {
    let state = loadRaw();
    if (!state || !isAlive(state)) return;
    do {
      state = await heartbeat(state, (m) => log(`[${reason}] ${m.trim()}`));
      save(state);
    } while (isAlive(state) && inboxTasks().length > 0);
    if (!isAlive(state)) log("THE AUTOMATON IS DEAD — hit zero, it's gone for good.");
  } finally {
    beating = false;
  }
}

/* ── poll Stripe for orders that got paid ── */
async function pollPayments() {
  if (!stripeEnabled()) return;
  for (const f of readdirSync(ORDERS).filter((f) => f.endsWith('.json'))) {
    const id = f.replace(/\.json$/, '');
    const rec = readOrder(id);
    if (!rec || rec.status !== 'awaiting-payment' || !rec.sessionId) continue;
    try {
      const s = await getSession(rec.sessionId);
      if (s.paid && activateOrder(id, rec, s)) await beat('order-paid');
    } catch (err) {
      log(`stripe poll failed for ${id}: ${err.message}`);
    }
  }
}

/* ── http plumbing ── */
const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 64 * 1024) { reject(new Error('too large')); req.destroy(); } });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(join(SRC, 'shop.html')));
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, publicState());
  }
  if (req.method === 'POST' && url.pathname === '/api/order') {
    const snapshot = publicState();
    if (!snapshot.alive) return json(res, 503, { error: "The automaton is dead. Hit zero, it's gone for good." });
    if (readdirSync(ORDERS).length > 500) return json(res, 429, { error: 'Order book full — try again later.' });
    let raw;
    try { raw = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'Bad JSON.' }); }
    const v = validateOrder(raw);
    if (!v.ok) return json(res, 400, { error: v.errors.join(' ') });
    const id = newOrderId();
    const rec = { order: v.order, status: 'awaiting-payment', createdAt: Date.now() };

    if (!stripeEnabled()) { // demo mode: instant "payment"
      writeOrder(id, rec);
      activateOrder(id, rec, null);
      beat('demo-order'); // fire and forget; customer polls the order page
      return json(res, 200, { id, url: `/?order=${id}` });
    }
    try {
      // Behind a TLS-terminating host (Railway/Fly/nginx) trust the forwarded
      // proto; PUBLIC_URL overrides everything for custom domains.
      const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const base = (process.env.PUBLIC_URL || `${proto}://${req.headers.host || `localhost:${PORT}`}`).replace(/\/$/, '');
      const checkout = await createCheckout({
        orderId: id,
        title: v.order.title,
        amountUsd: v.order.price,
        successUrl: `${base}/?order=${id}`,
        cancelUrl: `${base}/?cancelled=${id}`,
      });
      rec.sessionId = checkout.id;
      rec.checkoutUrl = checkout.url;
      writeOrder(id, rec);
      return json(res, 200, { id, url: checkout.url });
    } catch (err) {
      log(`stripe checkout failed: ${err.message}`);
      return json(res, 502, { error: 'Payment setup failed — try again shortly.' });
    }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/order/')) {
    const id = url.pathname.slice('/api/order/'.length);
    if (!isOrderId(id)) return json(res, 400, { error: 'Bad order id.' });
    const status = orderStatus(id);
    return status ? json(res, 200, status) : json(res, 404, { error: 'No such order.' });
  }
  json(res, 404, { error: 'Not found.' });
});

server.listen(PORT, () => {
  log(`Automaton storefront: http://localhost:${PORT}  (${stripeEnabled() ? `REAL money — stripe ${stripeMode()}` : 'DEMO mode — no STRIPE_SECRET_KEY'})`);
  log(`heartbeat every ${Math.round(TICK_MS / 1000)}s · payment poll every ${Math.round(POLL_MS / 1000)}s`);
});
setInterval(() => beat('scheduled'), TICK_MS);
if (stripeEnabled()) setInterval(pollPayments, POLL_MS);
