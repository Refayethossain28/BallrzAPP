#!/usr/bin/env node
/**
 * Voyager server — turns the browser into a proper, full browser
 * ==============================================================
 *
 * Run this and open the URL it prints, and Voyager can open sites that refuse
 * to be framed (YouTube, Google, X, most big apps) — because the page is
 * fetched here, its `X-Frame-Options` / CSP framing header is stripped, its
 * links are rewritten to keep flowing through this server, and the result is
 * served back from THIS origin, where no cross-origin framing rule applies.
 *
 *     node voyager/server.mjs            # then open http://localhost:8790
 *     PORT=9000 node voyager/server.mjs  # pick a port
 *
 * The static app (index.html) auto-detects the server via /__voyager/ping and
 * switches itself into "full browser" mode; without the server it stays a
 * plain framing browser, so the GitHub Pages build is unchanged.
 *
 * Zero dependencies — Node 18+ (global fetch) and built-in http/fs only.
 * All the URL/HTML rewriting lives in voyager/proxy.js (pure, unit-tested);
 * this file is just sockets, fetch, and streaming.
 *
 * Safety: the proxy refuses private/internal/loopback hosts (SSRF guard) so it
 * can't be aimed at your own network, cookies are not forwarded (no shared
 * session funnel), and it binds to localhost. Set VOYAGER_ALLOW_PRIVATE=1 to
 * allow private hosts (local development / the test suite only).
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const DIR = dirname(fileURLToPath(import.meta.url));

/* proxy.js is a UMD module (also loaded in the browser and by the tests). The
 * repo is type:module, so we evaluate it in a tiny vm sandbox to get its
 * exports rather than require()/import — dependency-free and identical to how
 * the test harness loads it. */
const Proxy = (() => {
  const sb = { module: { exports: {} }, URL, TextDecoder, console };
  sb.self = sb;
  vm.createContext(sb);
  vm.runInContext(readFileSync(join(DIR, 'proxy.js'), 'utf8'), sb, { filename: 'voyager/proxy.js' });
  return sb.module.exports;
})();
const PORT = Number(process.env.PORT) || 8790;
const HOST = process.env.HOST || '127.0.0.1';           // deploy with HOST=0.0.0.0
const ALLOW_PRIVATE = !!process.env.VOYAGER_ALLOW_PRIVATE;
const MAX_TEXT = 12 * 1024 * 1024; // cap in-memory rewrite of html/css
// Reliable lock for a PUBLIC deployment: set PROXY_KEY and every /proxy request
// must carry ?key=<PROXY_KEY>. Unlike an Origin/Referer allowlist (which phone
// browsers often don't send on framed navigations), a key rides in the URL, so
// it always arrives. The key is threaded into every rewritten link too. Empty =
// no key required.
const PROXY_KEY = process.env.PROXY_KEY || '';
// The proxy path handed to the rewriter — carries the key so in-page links stay authorised.
const PROXY_PATH = PROXY_KEY ? '/proxy?key=' + encodeURIComponent(PROXY_KEY) : '/proxy';
// Legacy soft guard: comma-separated app origins. Only enforced when no
// PROXY_KEY is set (kept for back-compat; the key is the recommended lock).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
// Ad / tracker blocking, on by default. The app can still disable it per-request
// (?block=0); set BLOCK_TRACKERS=0 to force it off server-wide.
const TRACKER_BLOCK = process.env.BLOCK_TRACKERS !== '0';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
  '/proxy.js': ['proxy.js', 'text/javascript; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

function send(res, status, headers, body) {
  res.writeHead(status, Object.assign({ 'cache-control': 'no-store' }, headers));
  res.end(body);
}

/** A small styled page shown inside the frame when a fetch can't be made. */
function errorPage(title, detail) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1322;color:#e9eefb;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="max-width:420px;padding:28px;text-align:center">
<div style="font-size:34px">🛰️</div>
<h2 style="margin:10px 0 6px;font-size:18px">${title}</h2>
<p style="color:#93a0c0;margin:0">${detail}</p></div></body>`;
}

async function serveStatic(pathname, res) {
  const entry = STATIC[pathname];
  if (!entry) return false;
  try {
    const buf = await readFile(join(DIR, entry[0]));
    send(res, 200, { 'content-type': entry[1] }, buf);
  } catch (e) {
    send(res, 404, { 'content-type': 'text/plain' }, 'not found');
  }
  return true;
}

async function handleProxy(target, req, res, blockOn) {
  let url;
  try { url = new URL(target); } catch (e) {
    return send(res, 400, { 'content-type': 'text/html; charset=utf-8' }, errorPage('Not a valid address', 'Voyager could not read that URL.'));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return send(res, 400, { 'content-type': 'text/html; charset=utf-8' }, errorPage('Unsupported address', 'The proxy only handles http and https pages.'));
  }
  if (!ALLOW_PRIVATE && Proxy.isBlockedHost(url.hostname)) {
    return send(res, 403, { 'content-type': 'text/html; charset=utf-8' }, errorPage('Blocked for safety', 'That host is private or internal, so the proxy refuses to reach it.'));
  }
  // Ad / tracker blocking: a matching sub-resource just returns empty, so the
  // page loads without the tracker rather than talking to it.
  if (blockOn && Proxy.isTracker(target)) {
    return send(res, 204, { 'x-voyager-blocked': '1' }, '');
  }
  // The rewrite path carries the key (auth) and the block flag, so every link
  // on the page inherits the same behaviour as this request.
  const ppath = PROXY_PATH + (blockOn ? '' : (PROXY_PATH.indexOf('?') === -1 ? '?' : '&') + 'block=0');
  // Legacy Origin allowlist — only when there's no PROXY_KEY (the key is the
  // reliable lock; Origin/Referer are often absent on framed navigations).
  if (!PROXY_KEY && ALLOWED_ORIGINS.length) {
    const ref = req.headers['origin'] || req.headers['referer'] || '';
    const selfOrigin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['host'] || ''}`;
    if (!Proxy.originAllowed(ref, ALLOWED_ORIGINS.concat([selfOrigin]))) {
      return send(res, 403, { 'content-type': 'text/html; charset=utf-8' }, errorPage('Not allowed', 'This proxy only serves its own app. Remove ALLOWED_ORIGINS, or switch to a PROXY_KEY (see voyager/DEPLOY.md).'));
    }
  }

  // Forward the request. Cookies deliberately not forwarded (see file header).
  const init = { headers: Object.assign({}, BROWSER_HEADERS), redirect: 'follow' };
  if (req.method === 'POST') {
    init.method = 'POST';
    init.body = await readBody(req);
    const ct = req.headers['content-type'];
    if (ct) init.headers['content-type'] = ct;
  }

  let upstream;
  try {
    upstream = await fetch(url.href, init);
  } catch (e) {
    return send(res, 502, { 'content-type': 'text/html; charset=utf-8' },
      errorPage('Couldn’t reach that site', String(e && e.message || e)));
  }

  const finalUrl = upstream.url || url.href;           // after redirects — the real base
  const ct = upstream.headers.get('content-type') || '';
  const outHeaders = { 'content-type': ct || 'application/octet-stream' };

  if (Proxy.isHtml(ct) || Proxy.isCss(ct)) {
    const raw = await upstream.arrayBuffer();
    if (raw.byteLength > MAX_TEXT) {
      // too big to rewrite in memory — hand it back untouched (framing already stripped by our headers)
      return send(res, upstream.status, outHeaders, Buffer.from(raw));
    }
    let text = new TextDecoder('utf-8').decode(raw);
    text = Proxy.isHtml(ct) ? Proxy.rewriteHtml(text, finalUrl, ppath)
                            : Proxy.rewriteCss(text, finalUrl, ppath);
    return send(res, upstream.status, outHeaders, text);
  }

  // Everything else (images, fonts, scripts, media): pass bytes through, framing headers dropped.
  const buf = Buffer.from(await upstream.arrayBuffer());
  send(res, upstream.status, outHeaders, buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

const server = http.createServer(async (req, res) => {
  let parsed;
  try { parsed = new URL(req.url, `http://${req.headers.host || HOST}`); }
  catch (e) { return send(res, 400, { 'content-type': 'text/plain' }, 'bad request'); }
  const pathname = parsed.pathname;

  if (pathname === '/__voyager/ping') {
    // CORS-open so the app (on another origin, when deployed) can verify a
    // pasted proxy URL. Reveals only "I am a Voyager proxy", nothing sensitive.
    return send(res, 200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      JSON.stringify({ voyager: true, version: 1 }));
  }
  if (pathname === '/proxy') {
    // Reliable lock: if a key is configured, it must match — it rides in the URL
    // so it survives framed navigations that strip Origin/Referer.
    if (PROXY_KEY && parsed.searchParams.get('key') !== PROXY_KEY) {
      return send(res, 403, { 'content-type': 'text/html; charset=utf-8' },
        errorPage('Locked', 'This proxy needs its key. In Voyager → Settings, add “?key=YOURKEY” to the proxy URL (matching PROXY_KEY on the server).'));
    }
    const target = parsed.searchParams.get('url');
    if (!target) return send(res, 400, { 'content-type': 'text/plain' }, 'missing url');
    const blockOn = TRACKER_BLOCK && parsed.searchParams.get('block') !== '0';
    return handleProxy(target, req, res, blockOn);
  }
  if (await serveStatic(pathname, res)) return;
  send(res, 404, { 'content-type': 'text/plain' }, 'not found');
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Voyager — full browser mode`);
  console.log(`  open  http://${shown}:${PORT}`);
  console.log(`  proxy on, SSRF guard ${ALLOW_PRIVATE ? 'OFF (private hosts allowed)' : 'on'}, cookies off`);
  console.log(`  lock: ${PROXY_KEY ? 'PROXY_KEY on (append ?key=… in Voyager)' : (ALLOWED_ORIGINS.length ? 'origin allowlist ' + ALLOWED_ORIGINS.join(', ') : 'OPEN (set PROXY_KEY to lock a public deploy)')}`);
});
