#!/usr/bin/env node
/**
 * Atlas Node Agent — runs on each machine on the LAN and heartbeats its state
 * to the Central Registry.
 *
 * It reports exactly the fields the spec asks for: hostname, IP, CPU cores, RAM,
 * GPU name, VRAM, installed services, capabilities, current load and a health
 * status. Hardware facts come from Node's `os` module; GPU details and the
 * capability/service lists are declared by the operator (env vars or a JSON
 * config), because *what a box can do* is a deployment decision, not something
 * to guess. Current load is derived from the OS load average.
 *
 *   Run:  node atlas/agent.mjs
 *   Env:  ATLAS_REGISTRY   registry base URL   (default http://localhost:8795)
 *         ATLAS_INTERVAL   heartbeat ms        (default 5000)
 *         ATLAS_CAPS       comma list          e.g. "ocr,embeddings,vision"
 *         ATLAS_SERVICES   comma list          e.g. "postgres,qdrant"
 *         ATLAS_GPU        GPU name            e.g. "RTX 4090"
 *         ATLAS_VRAM_MB    VRAM in MB          e.g. "24576"
 *         ATLAS_CONFIG     path to JSON with any of the above keys
 *         ATLAS_NODE_ID    override node id    (default hostname)
 *
 * Zero dependencies — Node built-ins only.
 */
import os from 'node:os';
import { readFileSync } from 'node:fs';

const REGISTRY = (process.env.ATLAS_REGISTRY || 'http://localhost:8795').replace(/\/$/, '');
const INTERVAL = Number(process.env.ATLAS_INTERVAL) || 5000;

function fromConfig() {
  if (!process.env.ATLAS_CONFIG) return {};
  try { return JSON.parse(readFileSync(process.env.ATLAS_CONFIG, 'utf8')); }
  catch (e) { console.error(`agent: could not read ATLAS_CONFIG: ${e.message}`); return {}; }
}

function csv(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** First non-internal IPv4 address, so the registry/Ray can reach this box. */
function primaryIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

/** Load average (1-min) normalised to 0..1 by core count. Windows reports 0. */
function currentLoad() {
  const cores = os.cpus().length || 1;
  const [one] = os.loadavg();
  if (!one) return 0; // no loadavg on this platform
  return Math.min(1, one / cores);
}

/** Build the report. `cfg` (from ATLAS_CONFIG) is the lowest-priority source. */
function buildReport(cfg) {
  const totalRamMB = Math.round(os.totalmem() / (1024 * 1024));
  return {
    id: process.env.ATLAS_NODE_ID || cfg.id || os.hostname(),
    hostname: os.hostname(),
    ip: cfg.ip || primaryIp(),
    cpuCores: os.cpus().length,
    ramMB: totalRamMB,
    gpuName: process.env.ATLAS_GPU || cfg.gpuName || '',
    vramMB: Number(process.env.ATLAS_VRAM_MB || cfg.vramMB || 0),
    services: process.env.ATLAS_SERVICES ? csv(process.env.ATLAS_SERVICES) : (cfg.services || []),
    capabilities: process.env.ATLAS_CAPS ? csv(process.env.ATLAS_CAPS) : (cfg.capabilities || []),
    load: currentLoad(),
    health: 'ok',
  };
}

async function heartbeat(cfg) {
  const report = buildReport(cfg);
  try {
    const res = await fetch(`${REGISTRY}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    console.log(`heartbeat ok  ${report.id}  load=${report.load.toFixed(2)}  status=${body.status || '?'}`);
  } catch (e) {
    console.error(`heartbeat failed → ${REGISTRY}: ${e.message}`);
  }
}

async function main() {
  const cfg = fromConfig();
  console.log(`Atlas agent for ${buildReport(cfg).id} → ${REGISTRY}  (every ${INTERVAL}ms)`);
  await heartbeat(cfg);
  const timer = setInterval(() => heartbeat(cfg), INTERVAL);
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
}

// Only run the loop when executed directly (keeps buildReport importable/testable).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { buildReport, currentLoad, primaryIp };
