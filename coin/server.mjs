#!/usr/bin/env node
/**
 * TimeCoin relay — cross-device networking for the blockchain.
 *
 * Real Bitcoin nodes gossip blocks and transactions peer-to-peer. Browsers
 * can't accept inbound connections, so (like most browser "p2p" systems) the
 * nodes meet at a tiny relay instead: every node POSTs its messages here and
 * polls for everyone else's. The relay is dumb on purpose — it never validates
 * a block, never holds a key and can't mint a coin; consensus stays entirely
 * in the nodes, which verify everything and adopt only the heaviest valid
 * chain (coin/engine.js `replaceChain`). A malicious relay can censor or delay
 * messages, but it cannot forge money — the same trust model as a Bitcoin
 * node behind someone else's network.
 *
 * It also serves the coin app itself, so deploying this one file to Render/
 * Railway (see DEPLOY.md) gives you a URL that IS a shared TimeCoin network:
 * anyone who opens it gets the app, and the app auto-detects that its own
 * origin is a relay and connects — zero configuration.
 *
 * Hardened for more than a handful of users, still zero-dependency:
 *   • the message buffer is bounded by BOTH count and bytes, so memory can't
 *     grow without limit no matter how much traffic arrives;
 *   • POST /msg is rate-limited per client (token bucket), keyed on the real
 *     client IP via x-forwarded-for so one flooder can't drown everyone or the
 *     box — legitimate "announce my chain/offers" bursts still pass;
 *   • /status exposes live metrics for monitoring;
 *   • an optional self-ping (SELF_URL) keeps a free-tier host from sleeping;
 *   • SIGTERM shuts down cleanly on redeploy.
 *
 * Run:  node coin/server.mjs   (PORT=8087). Deploy anywhere Node ≥18 runs.
 * Env:  PORT, SELF_URL, RELAY_MAX_HELD, RELAY_MAX_BYTES, RELAY_RATE_CAP,
 *       RELAY_RATE_REFILL.
 *
 * API (JSON, CORS open):
 *   GET  /status      → { ok, name, seq, held, ...metrics }   health
 *   GET  /msgs?since=N→ { seq, msgs: [...] }                  messages after N
 *   POST /msg         → { ok, seq } | 429 { retryAfter }      body: {type,...}
 *   GET  /            → the TimeCoin app (plus its scripts)
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
  '/mutual.js': ['mutual.js', 'text/javascript; charset=utf-8'],
  '/config.js': ['config.js', 'text/javascript; charset=utf-8'],
  '/qr.js': ['qr.js', 'text/javascript; charset=utf-8'],
  '/reputation.js': ['reputation.js', 'text/javascript; charset=utf-8'],
  '/bridge.js': ['bridge.js', 'text/javascript; charset=utf-8'],
  '/why.html': ['why.html', 'text/html; charset=utf-8'],
  '/guide.html': ['guide.html', 'text/html; charset=utf-8'],
  '/mine.html': ['mine.html', 'text/html; charset=utf-8'],
  '/join': ['join.html', 'text/html; charset=utf-8'],
  '/join.html': ['join.html', 'text/html; charset=utf-8'],
  '/SAFETY.md': ['SAFETY.md', 'text/markdown; charset=utf-8'],
  '/SECURITY.md': ['SECURITY.md', 'text/markdown; charset=utf-8'],
  '/wordlist.js': ['wordlist.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/miner.webmanifest': ['miner.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/miner-icon-180.png': ['miner-icon-180.png', 'image/png'],
  '/miner-icon-192.png': ['miner-icon-192.png', 'image/png'],
  '/miner-icon-512.png': ['miner-icon-512.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

const MAX_BODY = 5 * 1024 * 1024;  // hard cap per request (a whole chain fits)
const TYPES = new Set(['hello', 'chain', 'tx', 'offer', 'offer-remove', 'deal', 'id', 'credit', 'limits', 'chat', 'group', 'rep', 'peer']);

// Build a relay HTTP server (not yet listening). All state lives in this
// closure so the function is side-effect-free and unit-testable.
export function createRelay(opts = {}) {
  const MAX_HELD = opts.maxHeld ?? Number(process.env.RELAY_MAX_HELD || 3000);
  const MAX_BYTES = opts.maxBytes ?? Number(process.env.RELAY_MAX_BYTES || 64 * 1024 * 1024);
  const RATE_CAP = opts.rateCapacity ?? Number(process.env.RELAY_RATE_CAP || 150);   // burst tokens per IP
  const RATE_REFILL = opts.rateRefill ?? Number(process.env.RELAY_RATE_REFILL || 30); // tokens/sec refill
  const now = opts.now || (() => Date.now());

  let seq = 0;
  let heldBytes = 0;
  const ring = [];                 // [{ seq, msg, bytes }]
  const buckets = new Map();       // ip → { tokens, last }
  const started = now();
  const metrics = { posts: 0, rejectedRate: 0, rejectedBad: 0, gets: 0 };

  function push(msg, bytes) {
    ring.push({ seq: ++seq, msg, bytes });
    heldBytes += bytes;
    // Evict oldest until BOTH bounds hold — memory can never run away.
    while (ring.length > MAX_HELD || (heldBytes > MAX_BYTES && ring.length > 1)) {
      heldBytes -= ring.shift().bytes;
    }
    return seq;
  }

  // Token-bucket rate limit. Returns true if allowed.
  function allow(ip) {
    const t = now();
    let b = buckets.get(ip);
    if (!b) { b = { tokens: RATE_CAP, last: t }; buckets.set(ip, b); }
    b.tokens = Math.min(RATE_CAP, b.tokens + ((t - b.last) / 1000) * RATE_REFILL);
    b.last = t;
    if (b.tokens >= 1) { b.tokens -= 1; return true; }
    return false;
  }
  // Drop buckets that have been idle a while, so the map can't grow forever.
  const prune = setInterval(() => {
    const cutoff = now() - 15 * 60 * 1000;
    for (const [ip, b] of buckets) if (b.last < cutoff) buckets.delete(ip);
  }, 5 * 60 * 1000);
  if (prune.unref) prune.unref();

  function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  function json(res, code, obj, extraHeaders) {
    res.writeHead(code, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(JSON.stringify(obj));
  }

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    const url = new URL(req.url, 'http://relay');

    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, {
        ok: true, name: 'timecoin-relay', seq, held: ring.length,
        heldBytes, maxHeld: MAX_HELD, maxBytes: MAX_BYTES,
        clients: buckets.size, uptimeMs: now() - started, ...metrics,
      });
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      try {
        const [file, type] = STATIC[url.pathname];
        const body = readFileSync(join(DIR, file));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        return res.end(body);
      } catch {
        return json(res, 404, { ok: false, error: 'app file missing' });
      }
    }

    if (req.method === 'GET' && url.pathname === '/msgs') {
      metrics.gets++;
      const since = Number(url.searchParams.get('since') || 0);
      const msgs = ring.filter((e) => e.seq > since).map((e) => e.msg);
      return json(res, 200, { seq, msgs });
    }

    if (req.method === 'POST' && url.pathname === '/msg') {
      if (!allow(clientIp(req))) {
        metrics.rejectedRate++;
        return json(res, 429, { ok: false, error: 'rate limited', retryAfter: 1 }, { 'retry-after': '1' });
      }
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        let msg;
        try { msg = JSON.parse(raw.toString('utf8')); }
        catch { metrics.rejectedBad++; return json(res, 400, { ok: false, error: 'bad json' }); }
        if (!msg || !TYPES.has(msg.type)) { metrics.rejectedBad++; return json(res, 400, { ok: false, error: 'bad message type' }); }
        metrics.posts++;
        return json(res, 200, { ok: true, seq: push(msg, raw.length) });
      });
      req.on('error', () => { try { res.destroy(); } catch {} });
      return;
    }

    return json(res, 404, { ok: false, error: 'not found' });
  });

  server.on('close', () => clearInterval(prune));
  return server;
}

// Optional keep-warm: free hosts (Render's free tier) sleep after ~15 idle
// minutes; a periodic self-request keeps the network reachable for a circle.
export function startKeepAlive(url, everyMs = 10 * 60 * 1000) {
  if (!url || typeof fetch !== 'function') return null;
  const base = String(url).replace(/\/+$/, '');
  const timer = setInterval(() => { fetch(base + '/status').catch(() => {}); }, everyMs);
  if (timer.unref) timer.unref();
  return timer;
}

// Start only when run directly (`node coin/server.mjs`), not when imported by a test.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const PORT = Number(process.env.PORT || 8087);
  const server = createRelay();
  server.listen(PORT, () => {
    console.log(`🪙 TimeCoin node+relay listening on http://localhost:${PORT}`);
    console.log('   Open that URL — it serves the coin app already connected to this relay.');
  });
  startKeepAlive(process.env.SELF_URL);
  process.on('SIGTERM', () => { console.log('SIGTERM — shutting down'); server.close(() => process.exit(0)); });
}
