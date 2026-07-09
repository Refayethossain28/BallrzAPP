#!/usr/bin/env node
/**
 * Cortex relay — cross-device networking for the Proof-of-Learning chain.
 *
 * Same design as the TimeCoin relay (coin/server.mjs) and it REUSES that
 * hardened, tested server via `createRelay` — a dumb message forwarder that
 * never validates a block or holds a key, so consensus stays entirely in the
 * nodes (cortex/net.js + engine.js `replaceChain`). It also serves the Cortex
 * app, so deploying this one file gives a URL that IS a shared Cortex network.
 *
 * ── ⚠ TESTNET ONLY ───────────────────────────────────────────────────────────
 * Not safe as a real-value network yet: the model's forward pass uses floating-
 * point tanh/exp/log, which aren't guaranteed bit-identical across machines, so
 * honest nodes could disagree on a block and fork. A deterministic fixed-point
 * forward pass is the gate for a trustworthy network — see cortex/DEPLOY.md and
 * cortex/TRUSTLESS.md. Use this for local/testnet experimentation.
 *
 * Run:   node cortex/server.mjs            (PORT=8088)
 * Env:   PORT, SELF_URL, and the RELAY_* knobs documented in coin/server.mjs.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, startKeepAlive } from '../coin/server.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));

// The Cortex app + its modules. index.html loads ../coin/engine.js, which the
// browser requests as /coin/engine.js — served here from the sibling coin dir.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
  '/datasets.js': ['datasets.js', 'text/javascript; charset=utf-8'],
  '/holdout.js': ['holdout.js', 'text/javascript; charset=utf-8'],
  '/tournament.js': ['tournament.js', 'text/javascript; charset=utf-8'],
  '/prover.js': ['prover.js', 'text/javascript; charset=utf-8'],
  '/net.js': ['net.js', 'text/javascript; charset=utf-8'],
  '/coin/engine.js': ['../coin/engine.js', 'text/javascript; charset=utf-8'],
};

// The gossip message types cortex/net.js speaks (the relay only forwards these).
const TYPES = ['hello', 'chain', 'block', 'tx'];

export function createCortexRelay(opts = {}) {
  return createRelay({ ...opts, name: 'cortex-relay', types: TYPES, staticFiles: STATIC, dir: DIR });
}

// Boot when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = Number(process.env.PORT || 8088);
  const server = createCortexRelay();
  server.listen(PORT, () => {
    console.log(`cortex relay on :${PORT}  (⚠ testnet only — see cortex/DEPLOY.md)`);
    if (process.env.SELF_URL) startKeepAlive(process.env.SELF_URL);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
