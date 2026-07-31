#!/usr/bin/env node
/**
 * Seeker companion crawl server — zero dependencies, Node built-ins only.
 *
 * The static Seeker page can only crawl its own origin (plus CORS-open pages):
 * the browser's same-origin policy is doing its job. This little server is the
 * honest fix — run it and open Seeker from it, and the ⛏ crawl panel can index
 * ANY site on the internet:
 *
 *     node seeker/server.mjs            # then open http://localhost:8795
 *
 * What it does:
 *   - serves the seeker/ directory (so the page and /api/* share one origin)
 *   - GET /api/health          → {ok:true, seeker:"server"} (the page's probe)
 *   - GET /api/fetch?url=...   → fetches the page server-side and returns
 *                                {url, status, html} for the in-page engine to
 *                                extract and index. HTML only, 1.5 MB cap,
 *                                10 s timeout, ≤5 redirects.
 *
 * Honesty & safety:
 *   - It identifies itself (User-Agent: SeekerBot) and RESPECTS robots.txt —
 *     the rules are fetched per-origin, cached, and evaluated with the same
 *     unit-tested parser the page uses (seeker/engine.js in a vm sandbox).
 *   - SSRF guard: refuses private / loopback / link-local / metadata hosts,
 *     both by hostname and by the address DNS actually resolves to. Set
 *     SEEKER_ALLOW_PRIVATE=1 to lift it for local development only.
 *   - It fetches on your behalf, from your machine, one page at a time with
 *     the page's polite delay — a prototype crawler, not a datacentre.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { lookup } from 'node:dns/promises';
import vm from 'node:vm';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8795);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOW_PRIVATE = process.env.SEEKER_ALLOW_PRIVATE === '1';
const UA = 'SeekerBot/1.0 (+https://refayethossain28.github.io/BallrzAPP/seeker/; a from-scratch prototype crawler)';
const MAX_BYTES = 1.5 * 1024 * 1024;
const FETCH_TIMEOUT = 10000;

/* ---- the same engine the page runs, for robots.txt (repo is type:module) ---- */
const sandbox = { module: { exports: {} }, URL };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(DIR, 'engine.js'), 'utf8'), sandbox, { filename: 'seeker/engine.js' });
const Engine = sandbox.module.exports;

/* ---- SSRF guard (same posture as voyager/proxy.js) ---- */
function isBlockedHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || /(^|\.)localhost$/.test(h) || /\.local$/.test(h)) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (/^127\./.test(h)) return true;                       // loopback
  if (/^10\./.test(h)) return true;                        // private A
  if (/^192\.168\./.test(h)) return true;                  // private C
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;   // private B
  if (/^169\.254\./.test(h)) return true;                  // link-local / cloud metadata
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true;         // IPv6 unique-local
  if (/^fe80:/.test(h)) return true;                       // IPv6 link-local
  return false;
}

async function assertPublic(url) {
  if (ALLOW_PRIVATE) return;
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs');
  if (isBlockedHost(u.hostname)) throw new Error('private/internal host refused');
  try {
    const { address } = await lookup(u.hostname);
    if (isBlockedHost(address)) throw new Error('host resolves to a private address');
  } catch (e) {
    if (/private/.test(String(e.message))) throw e;
    throw new Error('DNS lookup failed');
  }
}

/* ---- robots.txt, fetched per-origin and cached ---- */
const robotsCache = new Map();
async function robotsAllows(url) {
  const u = new URL(url);
  const origin = u.origin;
  if (!robotsCache.has(origin)) {
    let rules = [];
    try {
      const r = await timedFetch(origin + '/robots.txt');
      if (r.ok) rules = Engine.parseRobots(await r.text());
    } catch { /* unreachable robots.txt = allowed */ }
    robotsCache.set(origin, rules);
  }
  return Engine.robotsAllowed(robotsCache.get(origin), UA, u.pathname + u.search);
}

function timedFetch(url, redirect = 'follow') {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  return fetch(url, {
    signal: ctl.signal, redirect,
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
  }).finally(() => clearTimeout(t));
}

/* ---- /api/fetch ---- */
async function apiFetch(rawUrl) {
  const url = Engine.normalizeUrl(rawUrl);
  if (!url) return { status: 400, body: { error: 'not a crawlable URL' } };
  await assertPublic(url);
  if (!(await robotsAllows(url))) return { status: 200, body: { url, error: 'disallowed by robots.txt' } };
  const r = await timedFetch(url);
  const finalUrl = Engine.normalizeUrl(r.url) || url;
  await assertPublic(finalUrl); // redirects must stay public too
  const ct = String(r.headers.get('content-type') || '');
  if (!/text\/html|application\/xhtml\+xml/i.test(ct)) {
    return { status: 200, body: { url: finalUrl, status: r.status, error: 'not an HTML page' } };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: 200, body: { url: finalUrl, status: r.status, html: buf.subarray(0, MAX_BYTES).toString('utf8') } };
}

/* ---- static files + routing ---- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json' };

function send(res, status, headers, body) { res.writeHead(status, headers); res.end(body); }
function sendJSON(res, status, obj) {
  send(res, status, { 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/health') return sendJSON(res, 200, { ok: true, seeker: 'server' });
    if (u.pathname === '/api/fetch') {
      const target = u.searchParams.get('url') || '';
      try {
        const out = await apiFetch(target);
        return sendJSON(res, out.status, out.body);
      } catch (e) {
        return sendJSON(res, 200, { url: target, error: String(e && e.message || e) });
      }
    }
    // static: seeker/ only, no traversal
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = normalize(join(DIR, p));
    if (!file.startsWith(DIR)) return send(res, 403, {}, 'no');
    try {
      const ext = file.slice(file.lastIndexOf('.'));
      return send(res, 200, { 'content-type': MIME[ext] || 'application/octet-stream' }, readFileSync(file));
    } catch {
      return send(res, 404, { 'content-type': 'text/plain' }, 'not found');
    }
  } catch (e) {
    return send(res, 500, { 'content-type': 'text/plain' }, 'server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🔎 Seeker crawl server → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`   robots.txt respected (UA: SeekerBot), SSRF guard ${ALLOW_PRIVATE ? 'OFF (private hosts allowed)' : 'on'}`);
});
