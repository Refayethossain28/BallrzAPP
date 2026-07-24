// server.mjs — AIOS's optional Live AI proxy. The OS is fully functional
// without it (the on-device intent router handles apps, files, notes, timers
// and maths); running this adds open conversation and lets a real Claude model
// drive the OS. The API key stays server-side — the browser never sees
// ANTHROPIC_API_KEY. Zero dependencies: Node 18+ built-in `fetch` + `http`,
// matching the repo's zero-build ethos.
//
//   • The model is briefed on the AIOS shell and answers through a FORCED
//     tool call, so the result is structured JSON: a reply for the chat
//     bubble plus a list of shell commands ({command: "mkdir -p invoices"}).
//   • The browser executes those commands through the same unit-tested
//     kernel that powers the Terminal — the model has exactly the powers a
//     user at the keyboard has inside the sandboxed virtual OS, no more.
//   • Same origin as the page (we also serve index.html), so there's no CORS.
//
// Run:  ANTHROPIC_API_KEY=sk-ant-... node server.mjs
// Then: open http://localhost:8791

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8791;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
// The most capable Claude by default. Override with AIOS_MODEL.
const MODEL = process.env.AIOS_MODEL || "claude-opus-4-8";

/* ---- the structured tool Claude is forced to fill in ---- */
const OS_TOOL = {
  name: "os_response",
  description: "Respond to the user of AIOS, optionally driving the OS with shell commands.",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "What to say in the assistant chat bubble. Warm, concise, useful." },
      commands: {
        type: "array",
        description: "AIOS shell commands to run on the user's machine-in-the-browser, in order. Empty if the request needs no action.",
        items: { type: "string" }
      }
    },
    required: ["reply"]
  }
};

const SYSTEM = `You are the Live AI of AIOS, an operating system running entirely in the user's browser.
You can DO things, not just talk: every command you emit runs in the AIOS shell against the user's
virtual disk and window manager. Available commands:
  ls [path] · cd [path] · pwd · cat <file> · echo <text> > <file> (or >>) · mkdir [-p] <dir>
  touch <file> · rm [-r] <path> · mv <a> <b> · cp <a> <b> · find <text> · open <app|file|dir> · ps · kill <pid>
Apps you can open: files, terminal, notes, assistant, monitor, settings, about.
Paths are unix-style; the user's home is /home/user, notes live in /home/user/notes.
Quote arguments containing spaces. Prefer a few precise commands over many.
When the user asks for something outside the OS (facts, writing, ideas), just answer in the reply —
you are also a first-class assistant. When you create or change files, mention what you did.
Keep replies short; this is a chat bubble, not an essay.`;

async function callClaude(text, context) {
  const ctx = context && typeof context === "object" ? context : {};
  const userMsg =
    `OS context: cwd=${JSON.stringify(String(ctx.cwd || "/home/user"))}, ` +
    `user=${JSON.stringify(String(ctx.owner || "user").slice(0, 24))}\n` +
    (Array.isArray(ctx.files) && ctx.files.length
      ? `Files on disk (sample): ${ctx.files.slice(0, 60).map(String).join(", ")}\n`
      : "") +
    `\nUser says: ${String(text).slice(0, 2000)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: [OS_TOOL],
      tool_choice: { type: "tool", name: "os_response" },
      messages: [{ role: "user", content: userMsg }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use");
  const input = toolUse ? toolUse.input : { reply: "I couldn't produce a structured answer — try again?" };
  return {
    reply: String(input.reply || ""),
    // The browser applies these through the unit-tested kernel shell.
    actions: (Array.isArray(input.commands) ? input.commands : [])
      .slice(0, 12)
      .map((c) => ({ command: String(c).slice(0, 400) }))
  };
}

/* ---- tiny same-origin server: static files + the two API routes ---- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const send = (code, type, body) => { res.writeHead(code, { "content-type": type }); res.end(body); };

  try {
    if (url.pathname === "/api/health") {
      return send(200, "application/json", JSON.stringify({ ok: true, live: !!API_KEY, model: API_KEY ? MODEL : null }));
    }
    if (url.pathname === "/api/assistant" && req.method === "POST") {
      if (!API_KEY) return send(503, "application/json", JSON.stringify({ error: "Set ANTHROPIC_API_KEY to enable Live AI." }));
      const { text, context } = JSON.parse((await readBody(req)) || "{}");
      if (!text || typeof text !== "string") return send(400, "application/json", JSON.stringify({ error: "text required" }));
      const out = await callClaude(text, context);
      return send(200, "application/json", JSON.stringify(out));
    }

    // static: serve the AIOS app itself (path-traversal-safe)
    let p = normalize(url.pathname).replace(/^([/\\])+/, "");
    if (p === "" || p === ".") p = "index.html";
    if (p.includes("..")) return send(403, "text/plain", "forbidden");
    const file = join(__dirname, p);
    const data = await readFile(file);
    return send(200, MIME[extname(file)] || "application/octet-stream", data);
  } catch (err) {
    if (err && err.code === "ENOENT") return send(404, "text/plain", "not found");
    console.error(err);
    return send(500, "application/json", JSON.stringify({ error: "server error" }));
  }
});

server.listen(PORT, () => {
  console.log(`AIOS serving at http://localhost:${PORT}  (Live AI: ${API_KEY ? "ENABLED — " + MODEL : "off, set ANTHROPIC_API_KEY"})`);
});
