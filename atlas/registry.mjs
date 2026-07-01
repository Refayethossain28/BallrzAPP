#!/usr/bin/env node
/**
 * Atlas Central Registry + Scheduler.
 *
 * A single zero-dependency Node process that:
 *   - stores the live state of every Node Agent (in memory, keyed by node id),
 *   - serves a visible dashboard at `/`,
 *   - accepts heartbeats at `POST /register`,
 *   - and routes task requests from Hermes at `POST /schedule` by picking the
 *     best healthy node (see core.mjs) and dispatching through the Ray adapter.
 *
 * The core decisions (normalise / health / capability match / selection) live
 * in core.mjs and are unit-tested. This file is just the plumbing: HTTP in,
 * HTTP out, plus a stale-node sweeper so the dashboard never shows a ghost.
 *
 *   Run:  node atlas/registry.mjs           # listens on :8795
 *   Env:  ATLAS_PORT, ATLAS_STALE_MS (default 15000)
 *
 * Zero dependencies — Node built-ins only.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeReport, selectNode, summarize, nodeStatus } from './core.mjs';
import { dispatch } from './ray-adapter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ATLAS_PORT) || 8795;
const STALE_MS = Number(process.env.ATLAS_STALE_MS) || 15000;
const DROP_MS = STALE_MS * 4; // forget a node entirely after it's been gone a while

/** In-memory registry: id -> canonical node record. */
const nodes = new Map();

function now() { return Date.now(); }

function snapshot() {
  const t = now();
  return [...nodes.values()]
    .map((n) => ({ ...n, status: nodeStatus(n, t, STALE_MS) }))
    .sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0));
}

/* ---- tiny HTTP helpers ---- */
function sendJson(res, code, body) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(s);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/* ---- routes ---- */
async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  // Dashboard
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = readFileSync(join(HERE, 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      return sendJson(res, 500, { ok: false, error: 'dashboard missing' });
    }
  }

  // Liveness of the registry itself
  if (req.method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, nodes: nodes.size, staleMs: STALE_MS });
  }

  // Full node state — used by the dashboard and by Hermes to inspect the fleet
  if (req.method === 'GET' && pathname === '/api/nodes') {
    return sendJson(res, 200, {
      ok: true,
      summary: summarize([...nodes.values()], now(), STALE_MS),
      nodes: snapshot(),
    });
  }

  // Node Agent heartbeat / registration
  if (req.method === 'POST' && pathname === '/register') {
    let raw;
    try { raw = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    const node = normalizeReport(raw, now());
    if (node.hostname === 'unknown' && !raw.id) {
      return sendJson(res, 400, { ok: false, error: 'report needs a hostname or id' });
    }
    nodes.set(node.id, node);
    return sendJson(res, 200, { ok: true, id: node.id, status: nodeStatus(node, now(), STALE_MS) });
  }

  // Hermes task request → select node → dispatch through Ray → return result
  if (req.method === 'POST' && pathname === '/schedule') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    const decision = selectNode([...nodes.values()], body, now(), STALE_MS);
    if (!decision.node) {
      // 503: the request was valid, we just have nowhere healthy to run it.
      return sendJson(res, 503, { ok: false, scheduled: false, reason: decision.reason, required: decision.required });
    }
    let result;
    try {
      result = await dispatch(decision.node, body.task ?? body);
    } catch (e) {
      return sendJson(res, 502, { ok: false, scheduled: true, node: decision.node.id, error: `dispatch failed: ${e.message}` });
    }
    return sendJson(res, 200, {
      ok: true,
      scheduled: true,
      node: { id: decision.node.id, hostname: decision.node.hostname, ip: decision.node.ip },
      reason: decision.reason,
      candidates: decision.candidates,
      result, // this is what returns to Hermes (spec step 7)
    });
  }

  return sendJson(res, 404, { ok: false, error: `no route for ${req.method} ${pathname}` });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { sendJson(res, 500, { ok: false, error: String(e && e.message || e) }); } catch { /* already sent */ }
  });
});

// Forget nodes we haven't heard from in a long time, so the fleet view is honest.
const sweeper = setInterval(() => {
  const cutoff = now() - DROP_MS;
  for (const [id, n] of nodes) if (n.lastSeen < cutoff) nodes.delete(id);
}, Math.max(1000, Math.floor(STALE_MS / 2)));
sweeper.unref?.();

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Atlas registry on http://localhost:${PORT}  (dashboard at /, stale after ${STALE_MS}ms)`);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
