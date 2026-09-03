#!/usr/bin/env node
/* server.mjs — Sonar's live proxy: the AI that searches the web in real time.
 *
 * The page asks a question; this proxy asks Claude with the `web_search`
 * SERVER tool (the browsing happens on Anthropic's infrastructure — this
 * process never fetches arbitrary URLs itself, so there is no SSRF surface
 * here), parses the SSE stream with the same pure engine the page and the
 * tests use, and forwards Sonar's own events to the browser as NDJSON — one
 * JSON object per line: hello / thinking / searching / search / found /
 * cite / text / turn / done / error. When the server-side search loop pauses
 * (stop_reason "pause_turn"), the proxy echoes the assistant blocks back and
 * resumes, invisibly to the page.
 *
 * Zero dependencies: Node 18+ built-in http + fetch, matching the repo's
 * ethos (the engine is evaluated in a node:vm sandbox, as everywhere else).
 *
 * Run:  ANTHROPIC_API_KEY=sk-ant-... node sonar/server.mjs   (or: npm run sonar)
 * Then: open http://localhost:8794
 *
 * Endpoints:
 *   GET  /api/health   → { ok, live, model }        (live=false without a key)
 *   POST /api/ask      → NDJSON stream              { question, history? }
 *   GET  /*            → sonar/ static files, same-origin so no CORS
 *
 * Honesty & safety: the API key stays server-side and is never echoed; a
 * missing key is not fatal (the page degrades to offline demo mode); replies
 * are capped (max_tokens, searches, question length, history depth) and a
 * tiny per-IP rate limit keeps a public proxy's blast radius small; binds to
 * 127.0.0.1 by default — deploy with HOST=0.0.0.0 knowingly.
 */
import http from 'node:http';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8794;
const HOST = process.env.HOST || '127.0.0.1'; // deploy with HOST=0.0.0.0
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
// Latest most capable model by default — live answers are the whole point.
const MODEL = process.env.SONAR_MODEL || 'claude-opus-5';
// Overridable so the proxy test can stand in a fake Anthropic upstream.
const API_URL = process.env.SONAR_API_URL || 'https://api.anthropic.com/v1/messages';

// A public proxy holds YOUR key — keep the blast radius small.
const MAX_TOKENS = Number(process.env.SONAR_MAX_TOKENS || 4096);
const MAX_SEARCHES = Number(process.env.SONAR_MAX_SEARCHES || 5);
const MAX_RESUMES = Math.max(0, Math.min(5, Number(process.env.SONAR_MAX_RESUMES ?? 3)));
const RATE_MAX = Number(process.env.SONAR_RATE_MAX || 20);
const RATE_WINDOW_MS = Number(process.env.SONAR_RATE_WINDOW_MS || 60_000);

/* ---- the same engine the page runs, for requests + stream reducing ---- */
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(DIR, 'engine.js'), 'utf8'), sandbox, { filename: 'sonar/engine.js' });
const Engine = sandbox.module.exports;

/* ---- tiny helpers ---- */
function send(res, status, headers, body) { res.writeHead(status, headers); res.end(body); }
function sendJSON(res, status, obj) {
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(obj));
}

// Tiny in-memory per-IP rate limit (best-effort abuse brake; resets on restart).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 2000) { for (const [k, r] of hits) if (now > r.reset) hits.delete(k); }
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) { hits.set(ip, { n: 1, reset: now + RATE_WINDOW_MS }); return false; }
  rec.n += 1;
  return rec.n > RATE_MAX;
}

/* ---- the live ask: stream Claude's web-searched answer as NDJSON ---- */
async function streamAsk({ question, history }, res) {
  if (!API_KEY) { sendJSON(res, 503, { ok: false, error: 'Set ANTHROPIC_API_KEY to enable live search.' }); return; }
  const v = Engine.validateQuestion(question);
  if (!v.ok) { sendJSON(res, 400, { ok: false, error: v.reason }); return; }

  const opts = { model: MODEL, maxTokens: MAX_TOKENS, maxSearches: MAX_SEARCHES };
  const body = Engine.buildRequestBody(v.question, history, opts, Date.now());
  const baseMessages = body.messages;

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-model': MODEL,
  });
  const emit = (evt) => res.write(JSON.stringify(evt) + '\n');
  emit({ t: 'hello', model: MODEL });

  const state = Engine.initStream();
  const decoder = new TextDecoder();

  // Stop paying for tokens nobody will read: abort the upstream stream the
  // moment the browser goes away, and cap the whole ask at 5 minutes.
  const abort = new AbortController();
  const killTimer = setTimeout(() => abort.abort(), 300_000);
  res.on('close', () => abort.abort());

  try {
    // The server-side search loop can pause (stop_reason "pause_turn"); echo
    // the assistant blocks back — no extra user turn — and it picks up where
    // it left off. Echoes ACCUMULATE: a second pause must still carry the
    // first continuation's searches and text.
    let messages = baseMessages;
    for (let attempt = 0; attempt <= MAX_RESUMES; attempt++) {
      state.stop = null;
      body.messages = messages;

      const upstream = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!upstream.ok || !upstream.body) {
        throw new Error('anthropic ' + upstream.status + ': ' + (await upstream.text()).slice(0, 400));
      }

      let carry = '';
      for await (const chunk of upstream.body) {
        const parsed = Engine.sseParse(carry, decoder.decode(chunk, { stream: true }));
        carry = parsed.carry;
        for (const evt of parsed.events) {
          for (const out of Engine.reduceEvent(state, evt)) emit(out);
        }
      }
      if (state.stop !== 'pause_turn' || res.writableEnded || res.destroyed) break;
      const echo = Engine.replayContent(state);
      if (!echo.length) break; // nothing valid to echo back — cannot resume
      messages = messages.concat([{ role: 'assistant', content: echo }]);
    }
  } finally {
    clearTimeout(killTimer);
  }

  emit({ t: 'done', stop: state.stop, sources: state.sources });
  res.end();
}

/* ---- static file serving, same-origin so page and /api/* need no CORS ---- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/health') {
      return sendJSON(res, 200, { ok: true, live: !!API_KEY, model: MODEL });
    }
    if (u.pathname === '/api/ask' && req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip)) return sendJSON(res, 429, { ok: false, error: 'rate limit — try again in a minute' });
      let raw = '';
      let tooBig = false;
      req.on('data', (c) => {
        if (tooBig) return; // drain the rest so the 413 reliably reaches the client
        raw += c;
        if (raw.length > 64_000) {
          tooBig = true;
          raw = '';
          sendJSON(res, 413, { ok: false, error: 'request too large — start a fresh chat' });
        }
      });
      req.on('end', async () => {
        if (tooBig) return;
        try {
          await streamAsk(JSON.parse(raw || '{}'), res);
        } catch (err) {
          // Streaming already under way → the NDJSON error event is all we
          // have left; otherwise a proper JSON status.
          if (res.headersSent) {
            try { res.write(JSON.stringify({ t: 'error', message: String(err.message || err) }) + '\n'); } catch { /* gone */ }
            res.end();
          } else {
            sendJSON(res, 502, { ok: false, error: String(err.message || err) });
          }
        }
      });
      return;
    }
    // static: sonar/ only, no traversal
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = normalize(join(DIR, p));
    if (file !== DIR && !file.startsWith(DIR + sep)) return send(res, 403, {}, 'no');
    try {
      const ext = file.slice(file.lastIndexOf('.'));
      return send(res, 200, { 'content-type': MIME[ext] || 'application/octet-stream' }, readFileSync(file));
    } catch {
      return send(res, 404, { 'content-type': 'text/plain' }, 'not found');
    }
  } catch (e) {
    if (res.headersSent) return res.end();
    return send(res, 500, { 'content-type': 'text/plain' }, 'server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`📡 Sonar → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(API_KEY
    ? `   Live search: ENABLED (${MODEL}) — max ${MAX_SEARCHES} searches, ${MAX_TOKENS} tokens, ${RATE_MAX} asks/${RATE_WINDOW_MS / 1000}s/IP`
    : '   Live search: off — set ANTHROPIC_API_KEY (the page runs in offline demo mode)');
});
