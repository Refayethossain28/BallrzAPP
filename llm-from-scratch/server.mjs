// server.mjs — the "Live AI" proxy for My Own AI Model.
//
// The app ships with a tiny GPT trained from scratch (runs 100% in the browser).
// This optional proxy adds a second engine: a "Live AI" toggle that routes the
// same prompt box to REAL Frontier Claude — Fable 5 by default — so you can put
// your hand-built model side by side with a state-of-the-art one.
//
// Zero dependencies: Node 18+ built-in `fetch` + `http`, matching the repo's
// zero-build ethos. The API key stays server-side (the browser never sees it),
// and we stream tokens back as they arrive so the Live AI output appears
// word-by-word, exactly like the on-device model.
//
// Run:  ANTHROPIC_API_KEY=sk-ant-... node server.mjs
// Then: open http://localhost:8789  and flip on "⚡ Live AI (Fable 5)".

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "web");
const PORT = process.env.PORT || 8789;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
// The most capable Claude by default. Override with LLM_LIVE_MODEL.
const MODEL = process.env.LLM_LIVE_MODEL || "claude-fable-5";

// Cap generation length server-side. A public proxy holds YOUR key, so keep the
// blast radius small: short replies + a per-IP rate limit (below).
const MAX_TOKENS_CAP = Number(process.env.LLM_MAX_TOKENS || 512);

// CORS: when this proxy is hosted (e.g. Render) and called from the GitHub Pages
// app, requests are cross-origin. Allow only known origins by default; override
// with ALLOW_ORIGINS="https://a.com,https://b.com" or "*" (not recommended).
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS ||
  "https://refayethossain28.github.io,http://localhost:8789,http://localhost:8000")
  .split(",").map((s) => s.trim()).filter(Boolean);
function allowOrigin(origin) {
  if (ALLOW_ORIGINS.includes("*")) return "*";
  if (origin && ALLOW_ORIGINS.includes(origin)) return origin;
  return ALLOW_ORIGINS[0] || "*";
}
function corsHeaders(req) {
  return {
    "access-control-allow-origin": allowOrigin(req.headers.origin),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

// Tiny in-memory per-IP rate limit (best-effort abuse brake; resets on restart).
const RATE_MAX = Number(process.env.LLM_RATE_MAX || 20);      // requests
const RATE_WINDOW_MS = Number(process.env.LLM_RATE_WINDOW_MS || 60_000); // per window
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) { hits.set(ip, { n: 1, reset: now + RATE_WINDOW_MS }); return false; }
  rec.n += 1;
  return rec.n > RATE_MAX;
}

const SYSTEM =
  "You are a brilliant, helpful AI assistant. Answer the user's prompt directly " +
  "and well. If the prompt is an unfinished piece of text, continue it naturally " +
  "in the same voice. Be concise unless asked for depth.";

/* ---- stream a completion from Claude straight to the browser as plain text ----
   We ask the Anthropic API for an SSE stream and forward only the text deltas,
   so the front-end can append them to the output as they land. */
async function streamClaude({ prompt, temperature, maxTokens }, req, res) {
  if (!API_KEY) throw new Error("no ANTHROPIC_API_KEY in env");
  const body = {
    model: MODEL,
    max_tokens: Math.max(16, Math.min(MAX_TOKENS_CAP, (maxTokens | 0) || MAX_TOKENS_CAP)),
    temperature: Math.max(0, Math.min(1, Number(temperature) || 0.8)),
    system: SYSTEM,
    stream: true,
    messages: [{ role: "user", content: String(prompt || "").slice(0, 8000) || "Hello!" }],
  };
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!upstream.ok || !upstream.body) {
    throw new Error("anthropic " + upstream.status + ": " + (await upstream.text()));
  }

  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-cache",
    "x-model": MODEL,
    ...corsHeaders(req),
  });

  // Parse the SSE byte stream, emit content_block_delta text as it arrives.
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
          res.write(evt.delta.text);
        }
      } catch { /* ignore keep-alive / non-JSON lines */ }
    }
  }
  res.end();
}

/* ---- static file serving so the page is same-origin (no CORS) ---- */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json",
};
async function serveStatic(req, res) {
  let path = decodeURIComponent((req.url || "/").split("?")[0]);
  if (path === "/" || path === "") path = "/index.html";
  if (path.includes("..")) { res.writeHead(403).end("nope"); return; }
  try {
    const file = await readFile(join(WEB_DIR, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  // CORS preflight for the cross-origin POST from the hosted app.
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  if (req.method === "GET" && (req.url === "/health" || req.url.startsWith("/health?"))) {
    res.writeHead(200, { "content-type": "application/json", ...corsHeaders(req) });
    res.end(JSON.stringify({ ok: true, live: !!API_KEY, model: MODEL }));
    return;
  }
  if (req.method === "POST" && req.url === "/ai") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) {
      res.writeHead(429, { "content-type": "application/json", ...corsHeaders(req) });
      res.end(JSON.stringify({ ok: false, error: "rate limit — try again in a minute" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        await streamClaude(JSON.parse(body || "{}"), req, res);
      } catch (err) {
        // If streaming already started we can only cut the connection; otherwise
        // return a JSON error the browser surfaces in the status line.
        if (res.headersSent) {
          res.end();
        } else {
          res.writeHead(502, { "content-type": "application/json", ...corsHeaders(req) });
          res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
        }
      }
    });
    return;
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`My Own AI Model proxy on port ${PORT}`);
  console.log(API_KEY
    ? `→ Live AI enabled (${MODEL}); max_tokens<=${MAX_TOKENS_CAP}, rate ${RATE_MAX}/${RATE_WINDOW_MS / 1000}s/IP`
    : "→ no ANTHROPIC_API_KEY set: only the on-device model is available");
  console.log(`→ allowed origins: ${ALLOW_ORIGINS.join(", ")}`);
});
