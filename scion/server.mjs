#!/usr/bin/env node
/**
 * scion/server.mjs — the mission console's backend.
 *
 * The one place a PHONE touches the scion: a web page where you write a
 * mission brief, choose its powers, and watch the run arrive line by line.
 * Zero dependencies (Node 18+ http), matching the repo's ethos.
 *
 *   node scion/server.mjs            # http://localhost:8798
 *
 * The mission agent can EDIT FILES on this machine (that is its job), so
 * the server binds 127.0.0.1 by default. To drive it from an iPhone on
 * your own network, run HOST=0.0.0.0 node scion/server.mjs and open
 * http://<computer-ip>:8798 — only on a network you trust.
 *
 * One mission runs at a time (an agent editing files concurrently with
 * itself helps nobody); finished missions stay listed until restart.
 *
 * Env: PORT (8798) · HOST (127.0.0.1) · ANTHROPIC_API_KEY (live harness;
 * without it every mission is a free offline rehearsal).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  LINEAGE, SUCCESSOR, ANCESTOR, DEFAULT_LIMITS, EFFORT_LEVELS,
  newMission, missionRequest, isMissionId, debrief, sanitize,
} from './logic.mjs';
import { runMission, harnessStatus } from './harness.mjs';

const SRC = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8798;
const HOST = process.env.HOST || '127.0.0.1';
const HISTORY_MAX = 50;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ── missions live in memory: id → record ── */
const missions = new Map();
const newMissionId = () => `mission-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const runningMission = () => [...missions.values()].find((r) => r.status === 'running') ?? null;

function snapshot(rec) {
  return {
    id: rec.id,
    status: rec.status,
    brief: rec.brief,
    model: rec.model,
    powers: rec.powers,
    createdAt: rec.createdAt,
    events: rec.events,
    debrief: rec.debrief,
  };
}

async function launch(rec, missionOpts, runOpts) {
  const mission = newMission(rec.id, rec.brief, Date.now(), missionOpts);
  const say = (line) => {
    rec.events.push({ at: Date.now(), line: sanitize(line) });
    if (rec.events.length > 500) rec.events.splice(0, rec.events.length - 500);
  };
  try {
    const ended = await runMission(mission, runOpts, say);
    rec.status = ended.status;
    rec.debrief = debrief(ended, Date.now());
  } catch (err) {
    rec.status = 'failed';
    rec.debrief = `# mission ${rec.id} — failed\n\nserver error: ${sanitize(String(err?.message ?? err)).slice(0, 300)}`;
  }
  log(`mission ${rec.id}: ${rec.status}`);
}

/* ── http plumbing (house style, see automaton/server.mjs) ── */
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

/* ── the PWA shell: an allowlist, so no path ever escapes scion/ ── */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    try {
      const body = readFileSync(join(SRC, file));
      res.writeHead(200, { 'Content-Type': type });
      return res.end(body);
    } catch {
      return json(res, 404, { error: 'asset missing — run: npm run icons:scion' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const status = await harnessStatus();
    return json(res, 200, {
      ...status,
      ancestor: ANCESTOR,
      successor: SUCCESSOR,
      lineage: LINEAGE.map(({ id, title }) => ({ id, title })),
      defaults: { ...DEFAULT_LIMITS, effort: 'xhigh' },
      efforts: [...EFFORT_LEVELS],
      busy: Boolean(runningMission()),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/missions') {
    const list = [...missions.values()].slice(-HISTORY_MAX).reverse()
      .map(({ id, status, brief, model, powers, createdAt }) => ({ id, status, brief: brief.slice(0, 120), model, powers, createdAt }));
    return json(res, 200, { missions: list });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/mission/')) {
    const id = url.pathname.slice('/api/mission/'.length);
    if (!isMissionId(id)) return json(res, 400, { error: 'bad mission id' });
    const rec = missions.get(id);
    return rec ? json(res, 200, snapshot(rec)) : json(res, 404, { error: 'no such mission' });
  }
  if (req.method === 'POST' && url.pathname === '/api/mission') {
    if (runningMission()) return json(res, 409, { error: 'a mission is already running — one at a time' });
    let payload;
    try { payload = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad JSON' }); }
    const v = missionRequest(payload);
    if (!v.ok) return json(res, 400, { error: v.error });
    if (missions.size >= HISTORY_MAX) missions.delete(missions.keys().next().value);
    const rec = {
      id: newMissionId(),
      status: 'running',
      brief: v.brief,
      model: v.missionOpts.model,
      powers: v.missionOpts.powers,
      createdAt: Date.now(),
      events: [],
      debrief: null,
    };
    missions.set(rec.id, rec);
    log(`mission ${rec.id} accepted (${rec.powers}, ${rec.model})`);
    launch(rec, v.missionOpts, v.runOpts); // fire and forget; the page polls
    return json(res, 200, { id: rec.id });
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, async () => {
  const status = await harnessStatus();
  log(`Scion mission console: http://${HOST}:${PORT}  (harness: ${status.harness})`);
  if (status.harness === 'understudy') log('no credentials — missions rehearse offline; set ANTHROPIC_API_KEY to run live');
  if (HOST !== '127.0.0.1') log('⚠ bound beyond localhost — the mission agent can edit files; trusted networks only');
});
