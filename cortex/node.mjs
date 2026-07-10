#!/usr/bin/env node
/**
 * Cortex node — a headless mining node you deploy.
 *
 * Connects to a relay, syncs the chain, mines Proof-of-Learning blocks, gossips
 * them, and PERSISTS the chain to a JSON file so it survives restarts. This is
 * what you run (alongside cortex/server.mjs) to operate a real network node.
 *
 * Run:
 *   RELAY=https://your-cortex.onrender.com \
 *   DATA=./cortex-chain.json \
 *   KEYFILE=./wallet.json CORTEX_PASSPHRASE='…' \   # optional; else a key is generated + saved encrypted
 *   node cortex/node.mjs
 *
 * Env: RELAY, DATA, TASK_ID, GENESIS_SEED, STEPS, MINE_MS, POLL_MS, KEYFILE,
 *      CORTEX_PASSPHRASE.
 *
 * ⚠ Testnet: the consensus math is now deterministic (fork-safe), but keys/
 *   persistence here are basic and unaudited — see cortex/SECURITY.md.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// Load the browser-UMD Cortex modules in a shared vm sandbox (they're not ESM).
function loadModules(root = REPO) {
  const box = { module: { exports: {} } }; box.self = box;
  if (typeof globalThis !== 'undefined' && globalThis.crypto) box.crypto = globalThis.crypto; // for keystore's RNG
  vm.createContext(box);
  const load = (p, g) => { box.module = { exports: {} }; vm.runInContext(readFileSync(join(root, p), 'utf8'), box, { filename: p }); const m = box.module.exports; if (g) box[g] = m; return m; };
  const Coin = load('coin/engine.js', 'BallrzCoin');
  load('cortex/datasets.js', 'BallrzCortexData');
  const X = load('cortex/engine.js', 'BallrzCortex');
  const Net = load('cortex/net.js', 'BallrzCortexNet');
  const Keystore = load('cortex/keystore.js', 'BallrzCortexKeystore');
  return { Coin, X, Net, Keystore };
}

// Resolve a wallet: explicit key, or an encrypted keyfile, or generate one and
// save it encrypted (never plaintext) when a passphrase is provided.
function resolveWallet({ Coin, Keystore }, opts) {
  if (opts.privKey) return Coin.walletFromPrivateKey(opts.privKey);
  if (opts.keyFile && existsSync(opts.keyFile)) {
    if (!opts.passphrase) throw new Error('KEYFILE is encrypted — set CORTEX_PASSPHRASE');
    return Coin.walletFromPrivateKey(Keystore.decryptKey(JSON.parse(readFileSync(opts.keyFile, 'utf8')), opts.passphrase));
  }
  const w = Coin.generateWallet();
  if (opts.keyFile && opts.passphrase) writeFileSync(opts.keyFile, JSON.stringify(Keystore.encryptKey(w.privateKey, opts.passphrase), null, 2));
  return w;
}

// Boot a node (no timers). Returns handles the CLI loop and tests both use.
export function bootNode(opts = {}) {
  const mods = loadModules(opts.root);
  const { X, Net } = mods;
  // Defaults match the browser app (cortex/app.js) so a headless node joins the
  // SAME chain: "scamnet" — the phishing-detection task. An explicit taskId
  // without a dataset gets the synthetic task (used by tests / custom nets).
  const useMainnet = !opts.taskId;
  const taskId = opts.taskId || 'cortex-scamnet-v1';
  const genesisSeed = opts.genesisSeed || 'cortex-genesis';
  const dataset = opts.dataset ?? (useMainnet ? 'phishing' : undefined);
  const layers = opts.layers ?? (useMainnet ? [16] : undefined);
  const task = X.makeTask({ id: taskId, ...(dataset ? { dataset } : {}), ...(layers ? { layers } : {}) });
  const wallet = resolveWallet(mods, opts);

  let chain;
  if (opts.dataFile && existsSync(opts.dataFile)) {
    const snap = JSON.parse(readFileSync(opts.dataFile, 'utf8'));
    if (snap.taskId !== taskId) throw new Error(`data file is for task "${snap.taskId}", not "${taskId}"`);
    chain = Net.loadChain(task, snap.blocks, { genesisSeed });
  } else {
    chain = new X.Chain(task, { genesisSeed });
  }

  const fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const transport = opts.relay ? Net.httpTransport(opts.relay, { fetch: fetchImpl }) : { send() {}, poll() { return Promise.resolve(0); } };
  const node = Net.createNode({ id: opts.id || wallet.address.slice(0, 10), chain, send: (m) => transport.send(m) });

  const save = () => { if (opts.dataFile) writeFileSync(opts.dataFile, JSON.stringify(node.snapshot())); };

  return {
    mods, wallet, task, node, transport, save,
    sync: () => { node.hello(); return transport.poll((m) => node.receive(m)); },
    poll: () => transport.poll((m) => node.receive(m)),
    mine: (o) => { const blk = node.mineAndBroadcast({ privKey: wallet.privateKey, steps: opts.steps || 400, nonce: 'b' + node.chain.height(), ...(o || {}) }); save(); return blk; },
    balance: () => X.formatMind(node.chain.balanceOf(wallet.address)),
  };
}

// CLI: run forever, polling + mining on intervals, persisting each block.
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = {
    relay: process.env.RELAY, dataFile: process.env.DATA || './cortex-chain.json',
    taskId: process.env.TASK_ID, genesisSeed: process.env.GENESIS_SEED,
    steps: Number(process.env.STEPS || 400), keyFile: process.env.KEYFILE, passphrase: process.env.CORTEX_PASSPHRASE,
  };
  if (!opts.relay) { console.error('set RELAY=<relay url> (see cortex/DEPLOY.md)'); process.exit(1); }
  const h = bootNode(opts);
  const pollMs = Number(process.env.POLL_MS || 1500), mineMs = Number(process.env.MINE_MS || 8000);
  console.log(`cortex node ${h.node.id} → ${opts.relay}  (⚠ testnet — cortex/SECURITY.md)`);
  console.log(`wallet ${h.wallet.address} · height ${h.node.chain.height()} · ${h.balance()}`);
  h.sync();
  const pt = setInterval(() => h.poll().catch(() => {}), pollMs);
  const mt = setInterval(() => {
    try { const b = h.mine(); if (b) console.log(`mined #${b.index}  loss ${b.loss.toFixed(4)}  ${h.balance()}`); else console.log('model converged — nothing to mine'); }
    catch (e) { /* a rival block landed first; next poll reconciles */ }
  }, mineMs);
  const stop = () => { clearInterval(pt); clearInterval(mt); h.save(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
