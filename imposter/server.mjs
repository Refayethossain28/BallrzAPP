// server.mjs — Imposter's optional Live-AI proxy. Lets the game generate fresh
// word packs from any theme ("90s cartoons", "Premier League clubs", "our group
// chat") by calling REAL Claude, while keeping the API key server-side (the
// browser never sees ANTHROPIC_API_KEY). Zero dependencies: Node 18+ built-in
// `fetch` + `http`, matching the repo's zero-build ethos.
//
//   • POST /imposter-ai { prompt, count } -> { name, words:[…] } (forced tool call
//     so the result is clean structured JSON the game renders deterministically).
//   • Serves the game on the same origin (no CORS), so the page's fetch('/imposter-ai')
//     just works.
//   • The game runs perfectly WITHOUT this — Live AI is a bonus; everything else
//     is fully offline.
//
// Run:  ANTHROPIC_API_KEY=sk-ant-... node imposter/server.mjs
// Then: open http://localhost:8790

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8790;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.IMPOSTER_MODEL || "claude-opus-4-8";

/* The structured tool Claude is forced to fill: a clean category for the game. */
const PACK_TOOL = {
  name: "word_pack",
  description: "Return a themed pack of guessable items for a social-deduction party game.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "A short, fun category name (max 24 chars)." },
      words: {
        type: "array",
        description: "12–30 distinct items on the theme. Each is a single concrete noun or short proper name (1–2 words), recognisable to a general audience, nothing offensive. No duplicates, no numbering, no explanations.",
        items: { type: "string" },
      },
    },
    required: ["name", "words"],
  },
};

async function generatePack(prompt, count) {
  if (!API_KEY) throw new Error("no ANTHROPIC_API_KEY in env");
  const n = Math.max(12, Math.min(30, count || 24));
  const sys =
    "You build word packs for an 'imposter' party game where everyone shares a secret word " +
    "except one player. Good items are concrete, well-known, and easy to hint at in one word " +
    "without being trivially obvious. Keep them clean and broadly recognisable.";
  const user = `Theme: ${JSON.stringify(prompt)}. Produce about ${n} items that fit this theme.`;
  const body = {
    model: MODEL,
    max_tokens: 1024,
    system: sys,
    messages: [{ role: "user", content: user }],
    tools: [PACK_TOOL],
    tool_choice: { type: "tool", name: "word_pack" },
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("anthropic " + res.status + ": " + (await res.text()));
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("model returned no structured result");
  const out = toolUse.input || {};
  // Defensive clean-up: dedupe, trim, drop empties, cap length.
  const seen = new Set();
  const words = (Array.isArray(out.words) ? out.words : [])
    .map((w) => String(w || "").trim())
    .filter((w) => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
    .slice(0, 30);
  return { name: String(out.name || prompt).slice(0, 24), words };
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
    const file = await readFile(join(__dirname, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, live: !!API_KEY, model: MODEL }));
    return;
  }
  if (req.method === "POST" && req.url === "/imposter-ai") {
    try {
      const { prompt, count } = await readJson(req);
      if (!prompt || !String(prompt).trim()) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no prompt" })); return; }
      const pack = await generatePack(String(prompt), count);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pack));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Imposter running on http://localhost:${PORT}  (Live AI: ${API_KEY ? "on" : "OFF — set ANTHROPIC_API_KEY"})`);
});
