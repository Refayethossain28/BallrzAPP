#!/usr/bin/env node
/**
 * BallrzCoin relay — cross-device networking for the toy blockchain.
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
 * Zero dependencies. Run:            node coin/server.mjs   (PORT=8087)
 * Then point nodes at it:            coin/config.js → relayUrl
 * Deploy anywhere Node runs (Render, Railway, a Raspberry Pi). Use HTTPS in
 * production — a page served over https:// may not call an http:// relay.
 *
 * API (JSON, CORS open):
 *   GET  /            → { ok, name, seq, held }         health/status
 *   GET  /msgs?since=N→ { seq, msgs: [...] }            messages after N
 *   POST /msg         → { ok, seq }                     body: {type, from, ...}
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8087);
const MAX_HELD = 200;            // ring buffer of recent messages
const MAX_BODY = 5 * 1024 * 1024; // a whole toy chain fits comfortably
const TYPES = new Set(['hello', 'chain', 'tx']);

let seq = 0;
const ring = []; // [{ seq, msg }]

function push(msg) {
  ring.push({ seq: ++seq, msg });
  while (ring.length > MAX_HELD) ring.shift();
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, 'http://relay');

  if (req.method === 'GET' && url.pathname === '/') {
    return json(res, 200, { ok: true, name: 'ballrzcoin-relay', seq, held: ring.length });
  }

  if (req.method === 'GET' && url.pathname === '/msgs') {
    const since = Number(url.searchParams.get('since') || 0);
    const msgs = ring.filter((e) => e.seq > since).map((e) => e.msg);
    return json(res, 200, { seq, msgs });
  }

  if (req.method === 'POST' && url.pathname === '/msg') {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return json(res, 400, { ok: false, error: 'bad json' }); }
      if (!msg || !TYPES.has(msg.type)) return json(res, 400, { ok: false, error: 'bad message type' });
      push(msg);
      return json(res, 200, { ok: true, seq });
    });
    return;
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`🪙 BallrzCoin relay listening on http://localhost:${PORT}`);
  console.log('   Point coin/config.js relayUrl at this address to join nodes across devices.');
});
