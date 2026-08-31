#!/usr/bin/env node
/**
 * fare/server.mjs — the Fare API + static host. Zero dependencies:
 * node:http for the server, node:sqlite for the data, public/engine.js for
 * every business rule, pdf.mjs for the invoice PDFs.
 *
 *   node fare/server.mjs            # http://localhost:8797
 *
 * Env:
 *   PORT          listen port (default 8797)
 *   HOST          bind address (default 0.0.0.0)
 *   FARE_DB_PATH  SQLite file (default fare/data/fare.db) — point it at a
 *                 mounted persistent disk in production
 *   FARE_KEY      optional shared secret; when set, every /api call must
 *                 carry it (x-fare-key header or ?key=) — set this the day
 *                 the app goes on the public internet
 *
 * v2 seams, deliberately kept: invoices are frozen snapshots (safe to email
 * later), statuses are stored+derived (payment chasing), and this API layer
 * is the single door a future multi-user/auth build swaps in behind.
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import E from './engine-node.mjs';
import { invoicePdf } from './pdf.mjs';
import * as store from './db.mjs';

const SRC = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8797;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.FARE_DB_PATH || join(SRC, 'data', 'fare.db');
const KEY = process.env.FARE_KEY || '';

const db = store.openDb(DB_PATH);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ── helpers ── */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const bad = (res, msg, code = 400) => sendJson(res, code, { error: msg });

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const todayISO = () => E.isoDate(Date.now());

function settings() { return E.normaliseSettings(store.getSettings(db)); }

/* ── API routing ── */

async function api(req, res, url) {
  const path = url.pathname;
  if (path === '/api/health') return sendJson(res, 200, { ok: true });

  if (KEY) {
    const given = req.headers['x-fare-key'] || url.searchParams.get('key') || '';
    if (given !== KEY) return bad(res, 'unauthorised — missing or wrong key', 401);
  }

  const seg = path.split('/').filter(Boolean); // ['api', 'jobs', '3', ...]
  const id = seg[2] ? Math.round(Number(seg[2])) : 0;

  /* settings */
  if (path === '/api/settings' && req.method === 'GET') return sendJson(res, 200, settings());
  if (path === '/api/settings' && req.method === 'PUT') {
    const body = await readBody(req);
    const s = E.normaliseSettings(body);
    // the invoice counter only moves forward via invoicing (or explicitly here)
    store.saveSettings(db, s);
    return sendJson(res, 200, s);
  }

  /* clients */
  if (path === '/api/clients' && req.method === 'GET') {
    return sendJson(res, 200, store.listClients(db, { includeArchived: url.searchParams.get('all') === '1' }));
  }
  if (path === '/api/clients' && req.method === 'POST') {
    const v = E.validateClient(await readBody(req));
    if (!v.ok) return bad(res, v.error);
    return sendJson(res, 201, store.createClient(db, v.client));
  }
  if (seg[1] === 'clients' && id && req.method === 'PUT') {
    if (!store.getClient(db, id)) return bad(res, 'no such client', 404);
    const body = await readBody(req);
    if (typeof body.archived === 'boolean' && Object.keys(body).length === 1) {
      return sendJson(res, 200, store.setClientArchived(db, id, body.archived));
    }
    const v = E.validateClient(body);
    if (!v.ok) return bad(res, v.error);
    return sendJson(res, 200, store.updateClient(db, id, v.client));
  }

  /* jobs */
  if (path === '/api/jobs' && req.method === 'GET') {
    const jobs = store.listJobs(db, {
      clientId: Number(url.searchParams.get('client')) || 0,
      month: url.searchParams.get('month') || '',
      uninvoiced: url.searchParams.get('uninvoiced') === '1',
    });
    return sendJson(res, 200, { jobs, total: E.sumJobs(jobs) });
  }
  if (path === '/api/jobs' && req.method === 'POST') {
    const v = E.validateJob(await readBody(req), store.listClients(db, { includeArchived: true }).map((c) => c.id));
    if (!v.ok) return bad(res, v.error);
    return sendJson(res, 201, store.createJob(db, v.job));
  }
  if (seg[1] === 'jobs' && id && (req.method === 'PUT' || req.method === 'DELETE')) {
    const existing = store.getJob(db, id);
    if (!existing) return bad(res, 'no such job', 404);
    if (existing.invoiceId) return bad(res, 'job is on an invoice — void the invoice first', 409);
    if (req.method === 'DELETE') { store.deleteJob(db, id); return sendJson(res, 200, { ok: true }); }
    const v = E.validateJob(await readBody(req), store.listClients(db, { includeArchived: true }).map((c) => c.id));
    if (!v.ok) return bad(res, v.error);
    return sendJson(res, 200, store.updateJob(db, id, v.job));
  }

  /* remembered routes for the ≤30-second job form */
  if (path === '/api/routes' && req.method === 'GET') {
    const clientId = Number(url.searchParams.get('client')) || 0;
    const jobs = store.listJobs(db, { clientId, limit: 300 });
    return sendJson(res, 200, E.routeSuggestions(jobs, clientId));
  }

  /* invoices */
  if (path === '/api/invoices' && req.method === 'GET') {
    const today = todayISO();
    const invoices = store.listInvoices(db).map((inv) => ({ ...inv, derivedStatus: E.invoiceStatus(inv, today) }));
    const uninvoiced = E.uninvoicedGroups(store.listJobs(db, { uninvoiced: true }), store.listClients(db, { includeArchived: true }));
    return sendJson(res, 200, { invoices, uninvoiced });
  }
  if (path === '/api/invoices' && req.method === 'POST') {
    const body = await readBody(req);
    const client = store.getClient(db, Math.round(Number(body.clientId)));
    if (!client) return bad(res, 'no such client', 404);
    if (!/^\d{4}-\d{2}$/.test(String(body.month || ''))) return bad(res, 'month must be YYYY-MM');
    const jobs = store.listJobs(db, { clientId: client.id, month: body.month, uninvoiced: true });
    const s = settings();
    const built = E.buildInvoice({ client, jobs, settings: s, todayISO: todayISO(), month: body.month, number: s.nextNumber });
    if (!built.ok) return bad(res, built.error, 409);
    const created = store.createInvoice(db, built.invoice, jobs.map((j) => j.id), s);
    log(`invoice ${created.displayNumber} → ${client.name} ${body.month} ${E.formatMoney(created.total)}`);
    return sendJson(res, 201, created);
  }
  if (seg[1] === 'invoices' && id && seg[3] === 'pdf' && req.method === 'GET') {
    const inv = store.getInvoice(db, id);
    if (!inv) return bad(res, 'no such invoice', 404);
    const pdf = invoicePdf(inv, { logoDataUrl: settings().logo });
    const client = (inv.snapshot?.client?.name || 'client').replace(/[^\w-]+/g, '-');
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${inv.displayNumber}-${client}.pdf"`,
      'Cache-Control': 'no-store',
    });
    return res.end(pdf);
  }
  if (seg[1] === 'invoices' && id && req.method === 'PATCH') {
    const inv = store.getInvoice(db, id);
    if (!inv) return bad(res, 'no such invoice', 404);
    const body = await readBody(req);
    if (body.status !== 'sent' && body.status !== 'paid') return bad(res, "status must be 'sent' or 'paid'");
    const paidDate = body.status === 'paid' ? (E.validIsoDate(body.paidDate) ? body.paidDate : todayISO()) : null;
    return sendJson(res, 200, store.setInvoiceStatus(db, id, body.status, paidDate));
  }
  if (seg[1] === 'invoices' && id && req.method === 'DELETE') {
    const inv = store.getInvoice(db, id);
    if (!inv) return bad(res, 'no such invoice', 404);
    store.voidInvoice(db, id);
    log(`voided invoice ${inv.displayNumber} (jobs released, number not reused)`);
    return sendJson(res, 200, { ok: true });
  }

  /* backup / restore */
  if (path === '/api/backup' && req.method === 'GET') {
    const dump = store.dumpAll(db);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="fare-backup-${todayISO()}.json"`,
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify(dump, null, 1));
  }
  if (path === '/api/restore' && req.method === 'POST') {
    const dump = await readBody(req, 20 * 1024 * 1024);
    store.restoreAll(db, dump);
    return sendJson(res, 200, { ok: true });
  }

  return bad(res, 'not found', 404);
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
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((err) => {
      if (!res.headersSent) bad(res, String(err.message || err), err.message === 'body too large' ? 413 : 500);
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('method not allowed');
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  log(`Fare listening on http://localhost:${PORT}  (db: ${DB_PATH}${KEY ? ', key required' : ''})`);
});
