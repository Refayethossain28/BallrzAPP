#!/usr/bin/env node
/**
 * fare/server.mjs — the Fare API + static host. Zero dependencies:
 * node:http for the server, node:sqlite for the data, public/engine.js for
 * every business rule, pdf.mjs for invoice PDFs, email.mjs (Resend) for
 * sending, stripe.mjs for subscriptions, chase.mjs for payment reminders.
 *
 *   node fare/server.mjs            # http://localhost:8797
 *
 * v2 is multi-tenant. Requests authenticate as one of:
 *   - x-fare-session header (or ?session= on download links) — a signed-in
 *     driver, created by the magic-link flow (/api/auth/*)
 *   - x-fare-key / ?key= matching FARE_KEY — the owner's API key, mapped to
 *     account 1 (keeps v1 phones and curl backups working)
 *
 * Env:
 *   PORT (8797) · HOST (0.0.0.0) · FARE_DB_PATH (fare/data/fare.db)
 *   FARE_KEY               owner API key (see above)
 *   FARE_APP_URL           public URL for links in emails/redirects
 *   RESEND_API_KEY, FARE_EMAIL_FROM          → email.mjs
 *   STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET → stripe.mjs
 * With no Stripe key, billing is off and every account has full access; with
 * no Resend key, emails print to the log (dev mode).
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import E from './engine-node.mjs';
import { invoicePdf } from './pdf.mjs';
import * as store from './db.mjs';
import * as auth from './auth.mjs';
import * as email from './email.mjs';
import * as billing from './stripe.mjs';
import { startChaser } from './chase.mjs';

const SRC = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8797;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.FARE_DB_PATH || join(SRC, 'data', 'fare.db');
const KEY = process.env.FARE_KEY || '';
const APP_URL = (process.env.FARE_APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const db = store.openDb(DB_PATH);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ── helpers ── */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// CORS lets the static copy of the app (e.g. the Ballrz hub on Pages) drive
// this server from another origin. Data stays guarded by sessions/FARE_KEY.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-fare-key, x-fare-session',
  'Access-Control-Max-Age': '86400',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(obj));
}
const bad = (res, msg, code = 400) => sendJson(res, code, { error: msg });

function sendHtml(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readRaw(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req, limit) {
  const raw = await readRaw(req, limit);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
  catch { throw new Error('invalid JSON'); }
}

const todayISO = () => E.isoDate(Date.now());
const settingsFor = (accountId) => E.normaliseSettings(store.getSettings(db, accountId));

/* ── who is calling? ── */

function resolveAccount(req, url) {
  const session = req.headers['x-fare-session'] || url.searchParams.get('session') || '';
  if (session) {
    const account = auth.accountForSession(db, session);
    if (account) return { account, via: 'session' };
  }
  const key = req.headers['x-fare-key'] || url.searchParams.get('key') || '';
  if (KEY && key === KEY) return { account: store.ensureOwnerAccount(db), via: 'key' };
  return null;
}

/* ── API routing ── */

async function api(req, res, url) {
  const path = url.pathname;
  if (path === '/api/health') return sendJson(res, 200, { ok: true });

  /* ---- auth (no account required) ---- */
  if (path === '/api/auth/request' && req.method === 'POST') {
    const body = await readBody(req, 4096);
    const addr = String(body.email || '').trim().toLowerCase();
    if (!E.validEmail(addr)) return bad(res, 'Enter a valid email address.');
    if (auth.loginRateLimited(addr)) return bad(res, 'Too many sign-in emails — try again in 15 minutes.', 429);
    const token = auth.issueLoginToken(db, addr);
    const link = `${APP_URL}/auth/link?token=${encodeURIComponent(token)}`;
    try {
      const result = await email.sendLoginLink({ to: addr, link });
      log(`auth: sign-in link → ${addr}${result.dev ? ' (dev mode)' : ''}`);
      // In dev mode (no email provider) surface the link so local testing works.
      return sendJson(res, 200, { ok: true, sent: !result.dev, ...(result.dev ? { devLink: link } : {}) });
    } catch (err) {
      log(`auth: send failed for ${addr}: ${err.message}`);
      return bad(res, 'Could not send the sign-in email — try again shortly.', 502);
    }
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    auth.signOut(db, req.headers['x-fare-session'] || '');
    return sendJson(res, 200, { ok: true });
  }

  /* ---- Stripe webhook (authenticated by signature, not session) ---- */
  if (path === '/api/billing/webhook' && req.method === 'POST') {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!secret) return bad(res, 'webhook not configured', 501);
    const payload = (await readRaw(req)).toString('utf8');
    const event = billing.verifyWebhook(payload, req.headers['stripe-signature'], secret);
    if (!event) return bad(res, 'invalid signature', 400);
    const update = billing.billingUpdateForEvent(event);
    if (update) {
      const account = update.accountId
        ? store.getAccount(db, update.accountId)
        : store.getAccountByStripeCustomer(db, update.customerId);
      if (account) {
        store.updateAccountBilling(db, account.id, {
          status: update.status,
          stripeCustomerId: update.customerId,
          stripeSubscriptionId: update.subscriptionId,
        });
        log(`billing: account ${account.id} → ${update.status} (${event.type})`);
      }
    }
    return sendJson(res, 200, { received: true });
  }

  /* ---- everything below needs an account ---- */
  const who = resolveAccount(req, url);
  if (!who) return bad(res, 'sign in to continue', 401);
  const account = who.account;
  const access = E.accountAccess(account, todayISO(), billing.billingEnabled());
  const seg = path.split('/').filter(Boolean); // ['api', 'jobs', '3', ...]
  const id = seg[2] ? Math.round(Number(seg[2])) : 0;

  // Read-only accounts (trial over / payment failed) can still see and export
  // everything — they just can't write. Billing endpoints stay open so they
  // can fix it.
  const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
  const billingPath = seg[1] === 'billing' || seg[1] === 'auth';
  if (access.readOnly && isWrite && !billingPath) {
    return sendJson(res, 402, { error: access.reason, readOnly: true });
  }

  /* me */
  if (path === '/api/me' && req.method === 'GET') {
    return sendJson(res, 200, {
      account: { id: account.id, email: account.email, status: account.status },
      access: { ...access, trialDaysLeft: E.trialDaysLeft(account, todayISO()) },
      billing: { enabled: billing.billingEnabled() },
      email: { enabled: email.emailEnabled() },
      via: who.via,
    });
  }

  /* billing */
  if (path === '/api/billing/checkout' && req.method === 'POST') {
    if (!billing.billingEnabled()) return bad(res, 'billing is not configured on this server', 501);
    const checkoutUrl = await billing.createCheckout({ account, appUrl: APP_URL });
    return sendJson(res, 200, { url: checkoutUrl });
  }
  if (path === '/api/billing/portal' && req.method === 'POST') {
    if (!billing.billingEnabled()) return bad(res, 'billing is not configured on this server', 501);
    const portalUrl = await billing.createPortal({ account, appUrl: APP_URL });
    return sendJson(res, 200, { url: portalUrl });
  }

  /* settings */
  if (path === '/api/settings' && req.method === 'GET') return sendJson(res, 200, settingsFor(account.id));
  if (path === '/api/settings' && req.method === 'PUT') {
    const s = E.normaliseSettings(await readBody(req));
    store.saveSettings(db, account.id, s);
    return sendJson(res, 200, s);
  }

  /* clients */
  if (path === '/api/clients' && req.method === 'GET') {
    return sendJson(res, 200, store.listClients(db, account.id, { includeArchived: url.searchParams.get('all') === '1' }));
  }
  if (path === '/api/clients' && req.method === 'POST') {
    const v = E.validateClient(await readBody(req));
    if (!v.ok) return bad(res, v.error);
    return sendJson(res, 201, store.createClient(db, account.id, v.client));
  }
  if (seg[1] === 'clients' && id && req.method === 'PUT') {
    if (!store.getClient(db, account.id, id)) return bad(res, 'no such client', 404);
    const body = await readBody(req);
    if (typeof body.archived === 'boolean' && Object.keys(body).length === 1) {
      return sendJson(res, 200, store.setClientArchived(db, account.id, id, body.archived));
    }
    const v = E.validateClient(body);
    if (!v.ok) return bad(res, v.error);
    return sendJson(res, 200, store.updateClient(db, account.id, id, v.client));
  }

  /* jobs */
  if (path === '/api/jobs' && req.method === 'GET') {
    const jobs = store.listJobs(db, account.id, {
      clientId: Number(url.searchParams.get('client')) || 0,
      month: url.searchParams.get('month') || '',
      uninvoiced: url.searchParams.get('uninvoiced') === '1',
    });
    return sendJson(res, 200, { jobs, total: E.sumJobs(jobs) });
  }
  if (path === '/api/jobs' && req.method === 'POST') {
    const clientIds = store.listClients(db, account.id, { includeArchived: true }).map((c) => c.id);
    const v = E.validateJob(await readBody(req), clientIds);
    if (!v.ok) return bad(res, v.error);
    return sendJson(res, 201, store.createJob(db, account.id, v.job));
  }
  if (seg[1] === 'jobs' && id && (req.method === 'PUT' || req.method === 'DELETE')) {
    const existing = store.getJob(db, account.id, id);
    if (!existing) return bad(res, 'no such job', 404);
    if (existing.invoiceId) return bad(res, 'job is on an invoice — void the invoice first', 409);
    if (req.method === 'DELETE') { store.deleteJob(db, account.id, id); return sendJson(res, 200, { ok: true }); }
    const clientIds = store.listClients(db, account.id, { includeArchived: true }).map((c) => c.id);
    const v = E.validateJob(await readBody(req), clientIds);
    if (!v.ok) return bad(res, v.error);
    return sendJson(res, 200, store.updateJob(db, account.id, id, v.job));
  }

  /* remembered routes for the ≤30-second job form */
  if (path === '/api/routes' && req.method === 'GET') {
    const clientId = Number(url.searchParams.get('client')) || 0;
    const jobs = store.listJobs(db, account.id, { clientId, limit: 300 });
    return sendJson(res, 200, E.routeSuggestions(jobs, clientId));
  }

  /* invoices */
  if (path === '/api/invoices' && req.method === 'GET') {
    const today = todayISO();
    const invoices = store.listInvoices(db, account.id).map((inv) => ({ ...inv, derivedStatus: E.invoiceStatus(inv, today) }));
    const uninvoiced = E.uninvoicedGroups(
      store.listJobs(db, account.id, { uninvoiced: true }),
      store.listClients(db, account.id, { includeArchived: true })
    );
    return sendJson(res, 200, { invoices, uninvoiced, emailLog: store.listEmailLog(db, account.id) });
  }
  if (path === '/api/invoices' && req.method === 'POST') {
    const body = await readBody(req);
    const client = store.getClient(db, account.id, Math.round(Number(body.clientId)));
    if (!client) return bad(res, 'no such client', 404);
    if (!/^\d{4}-\d{2}$/.test(String(body.month || ''))) return bad(res, 'month must be YYYY-MM');
    const jobs = store.listJobs(db, account.id, { clientId: client.id, month: body.month, uninvoiced: true });
    const s = settingsFor(account.id);
    const built = E.buildInvoice({ client, jobs, settings: s, todayISO: todayISO(), month: body.month, number: s.nextNumber });
    if (!built.ok) return bad(res, built.error, 409);
    const created = store.createInvoice(db, account.id, built.invoice, jobs.map((j) => j.id), s);
    log(`invoice ${created.displayNumber} → ${client.name} ${body.month} ${E.formatMoney(created.total)} (account ${account.id})`);
    return sendJson(res, 201, created);
  }
  if (seg[1] === 'invoices' && id && seg[3] === 'pdf' && req.method === 'GET') {
    const inv = store.getInvoice(db, account.id, id);
    if (!inv) return bad(res, 'no such invoice', 404);
    const pdf = invoicePdf(inv, { logoDataUrl: settingsFor(account.id).logo });
    const client = (inv.snapshot?.client?.name || 'client').replace(/[^\w-]+/g, '-');
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${inv.displayNumber}-${client}.pdf"`,
      'Cache-Control': 'no-store',
      ...CORS,
    });
    return res.end(pdf);
  }
  if (seg[1] === 'invoices' && id && seg[3] === 'email' && req.method === 'POST') {
    const inv = store.getInvoice(db, account.id, id);
    if (!inv) return bad(res, 'no such invoice', 404);
    const client = store.getClient(db, account.id, inv.clientId);
    const to = (client && client.email) || inv.snapshot?.client?.email || '';
    if (!E.validEmail(to)) return bad(res, 'This client has no valid email address — add one first.');
    const s = settingsFor(account.id);
    const pdf = invoicePdf(inv, { logoDataUrl: s.logo });
    const result = await email.sendInvoice({
      to,
      replyTo: s.email || account.email || undefined,
      businessName: s.businessName,
      clientName: inv.snapshot?.client?.name || (client && client.name) || 'client',
      invoice: inv, pdf,
      formatMoney: E.formatMoney, formatDateLong: E.formatDateLong,
    });
    store.logEmail(db, account.id, { invoiceId: inv.id, kind: 'invoice', recipient: to, providerId: result.id });
    log(`emailed ${inv.displayNumber} → ${to}${result.dev ? ' (dev mode)' : ''} (account ${account.id})`);
    return sendJson(res, 200, { ok: true, sent: !result.dev, to });
  }
  if (seg[1] === 'invoices' && id && req.method === 'PATCH') {
    const inv = store.getInvoice(db, account.id, id);
    if (!inv) return bad(res, 'no such invoice', 404);
    const body = await readBody(req);
    if (body.status !== 'sent' && body.status !== 'paid') return bad(res, "status must be 'sent' or 'paid'");
    const paidDate = body.status === 'paid' ? (E.validIsoDate(body.paidDate) ? body.paidDate : todayISO()) : null;
    return sendJson(res, 200, store.setInvoiceStatus(db, account.id, id, body.status, paidDate));
  }
  if (seg[1] === 'invoices' && id && req.method === 'DELETE') {
    const inv = store.getInvoice(db, account.id, id);
    if (!inv) return bad(res, 'no such invoice', 404);
    store.voidInvoice(db, account.id, id);
    log(`voided invoice ${inv.displayNumber} (account ${account.id})`);
    return sendJson(res, 200, { ok: true });
  }

  /* backup / restore */
  if (path === '/api/backup' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="fare-backup-${todayISO()}.json"`,
      'Cache-Control': 'no-store',
      ...CORS,
    });
    return res.end(JSON.stringify(store.dumpAll(db, account.id), null, 1));
  }
  if (path === '/api/restore' && req.method === 'POST') {
    store.restoreAll(db, account.id, await readBody(req, 20 * 1024 * 1024));
    return sendJson(res, 200, { ok: true });
  }

  return bad(res, 'not found', 404);
}

/* ── magic-link landing (non-API: the emailed link opens this page) ── */

function authLink(res, url) {
  const token = url.searchParams.get('token') || '';
  const redeemed = token ? auth.redeemLoginToken(db, token) : null;
  if (!redeemed) {
    return sendHtml(res, 400, `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
      <body style="background:#0c1118;color:#e9edf3;font-family:-apple-system,sans-serif;text-align:center;padding:60px 24px">
      <h2>That sign-in link has expired</h2><p style="color:#8d97a7">Links work once and last 15 minutes.</p>
      <p><a href="/" style="color:#d4af37">Request a new one</a></p></body>`);
  }
  log(`auth: account ${redeemed.account.id} signed in (${redeemed.account.email})`);
  // Store the session where the app reads it, then enter the app.
  return sendHtml(res, 200, `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
    <body style="background:#0c1118;color:#e9edf3;font-family:-apple-system,sans-serif;text-align:center;padding:60px 24px">
    <h2>Signing you in…</h2>
    <script>
      try { localStorage.setItem('fareSession', ${JSON.stringify(redeemed.session)}); } catch (e) {}
      location.replace('/');
    </script></body>`);
}

/* ── static files ── */

function serveStatic(res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  file = normalize(file).replace(/^([.]{2}[/\\])+/, '');
  const full = join(SRC, 'public', file);
  if (!full.startsWith(join(SRC, 'public')) || !existsSync(full)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  const ext = full.slice(full.lastIndexOf('.'));
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
  });
  res.end(readFileSync(full));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((err) => {
      if (!res.headersSent) bad(res, String(err.message || err), err.message === 'body too large' ? 413 : 500);
    });
    return;
  }
  if (url.pathname === '/auth/link' && req.method === 'GET') return authLink(res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('method not allowed');
  }
  serveStatic(res, url.pathname);
});

setInterval(() => store.pruneAuth(db), 6 * 3600 * 1000).unref?.();
startChaser(db, { log });

server.listen(PORT, HOST, () => {
  log(`Fare listening on http://localhost:${PORT}  (db: ${DB_PATH})`);
  log(`  auth: magic links${email.emailEnabled() ? ' via Resend' : ' in DEV mode (links print here)'}${KEY ? ' + owner key' : ''}`);
  log(`  billing: ${billing.billingEnabled() ? 'Stripe enabled' : 'disabled — all accounts have full access'}`);
});
