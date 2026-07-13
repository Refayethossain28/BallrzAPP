#!/usr/bin/env node
/**
 * AI Token node+relay — one file, a whole network.
 *
 * Serves the AIT full-node app (with the consensus core AND the from-scratch
 * GPT model, so a fresh device gets everything from one URL) and relays
 * blockchain gossip between nodes that can't reach each other directly.
 *
 * The relay logic is TimeCoin's hardened relay (../coin/server.mjs
 * `createRelay`), reused as a library — bounded memory, per-IP token-bucket
 * rate limiting, /status metrics; see its header and scripts/test-relay.mjs.
 * The relay stays dumb on purpose: it never validates a block and can't mint
 * a spark. Consensus lives in the nodes, which adopt only the heaviest valid
 * chain.
 *
 * Run:    node aicoin/server.mjs        (PORT=8091)
 * Deploy: anywhere Node ≥18 runs (see ../coin/DEPLOY.md — same recipe).
 * API:    GET /msgs?since=N · POST /msg · GET /status  (relay)
 *         GET /…            (the app, engines, GPT runtime + weights)
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../coin/server.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..');

// The app refers to its dependencies with parent-relative paths
// (../coin/engine.js, ../llm-from-scratch/web/…) so it also works straight
// off the filesystem; URL normalisation folds those onto these routes.
const STATIC = {
  '/': ['aicoin/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['aicoin/index.html', 'text/html; charset=utf-8'],
  '/engine.js': ['aicoin/engine.js', 'text/javascript; charset=utf-8'],
  '/README.md': ['aicoin/README.md', 'text/markdown; charset=utf-8'],
  '/coin/engine.js': ['coin/engine.js', 'text/javascript; charset=utf-8'],
  '/llm-from-scratch/web/gpt.js': ['llm-from-scratch/web/gpt.js', 'text/javascript; charset=utf-8'],
  '/llm-from-scratch/web/model.json': ['llm-from-scratch/web/model.json', 'application/json; charset=utf-8'],
};

export function createNode(opts = {}) {
  const relay = createRelay(opts); // owns /msg, /msgs, /status (and state)
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      try {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
        res.end(readFileSync(join(ROOT, file)));
      } catch (err) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
      }
      return;
    }
    relay.emit('request', req, res); // /msg, /msgs, /status, CORS preflights
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.PORT || 8091);
  const server = createNode();
  server.listen(PORT, () => {
    console.log(`🧠 AI Token node+relay listening on http://localhost:${PORT}`);
    console.log('   open it in a browser to run a full node (miner + wallet + AI desk)');
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
