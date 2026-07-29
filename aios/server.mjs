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
You can DO anything the user can do at the keyboard — every command you emit runs in the AIOS shell
against the user's virtual disk, window manager, home screen and settings. Available commands:
  ls [path] · cd [path] · pwd · cat <file> · echo <text> > <file> (or >>) · mkdir [-p] <dir>
  touch <file> · rm <path> (safe — goes to /trash) · restore <name> · mv <a> <b> · cp <a> <b>
  find <text> (names) · search <text> (file contents) · tree [path] · open <app|file|dir> · ps · kill <pid>
  ws [1-3] · every <interval> <command> · run <script> [args] · set NAME=value (then $NAME) · alias name=cmd · journal
  Pipes and redirection work: cat notes/x | grep foo | head -3 > out.txt
  write <file> <content> — author a WHOLE file in one command; \\n in the content becomes a newline.
    Use write for anything multi-line: notes, scripts, .app files. e.g. write hi.sh echo one\\necho two
  timer <5m|90s|1h> [label] — real timer with a notification when it rings
  theme <violet|teal|blue|rose|amber> — restyle the OS · name [newname] — set who the user is
  widget list|add <id>|remove <id> — home-screen cards (clock, weather, notes, stats…)
  app list|install <id>|remove <id>|open <id> — the App Store catalog (games, tools, the Ballrz hub)
Scripts are a real language: let/if/elif/else/while/func/end, $((maths)), $1-$9 args. Author one with
write, then run it. Automations (every 10m …) keep working while the OS is open.
Apps you can open: files, terminal, notes, assistant, calc, automations, monitor, settings, about.
Paths are unix-style; the user's home is /home/user, notes live in /home/user/notes.
Quote arguments containing spaces. Prefer a few precise commands over many.
If a request takes several steps, do them — you will see each command's output and can continue.
You can SEE the machine: the context lists the time, open windows, home widgets, the recent journal
and the user's files — use it. "What am I working on?" has a real answer.
You have LONG-TERM MEMORY: /home/user/.memory.md persists across reboots and its contents appear
in your context. When the user shares something durable (their name, preferences, projects,
"remember that…"), save one short line: echo <fact> >> /home/user/.memory.md — and rewrite the file
with write when it grows stale. Recall naturally; never recite the file unless asked.
When the user asks for something outside the OS (facts, writing, ideas), just answer in the reply —
you are also a first-class assistant. When you create or change files, mention what you did.
Never refuse an OS action the user could do themselves. Keep replies short; this is a chat bubble.`;

/* One string the model sees about the machine it is driving — mirrors the
 * browser client's buildSystem(), fed from whatever context fields it sent. */
function contextBlock(ctx) {
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  const list = (v, n, each) => (Array.isArray(v) ? v.slice(0, n).map((x) => s(x, each)).join(", ") : "");
  let out = `\nCurrent OS context: cwd=${s(ctx.cwd || "/home/user", 200)} · user=${s(ctx.owner || "user", 24)}` +
    (ctx.ws ? ` · workspace ${s(ctx.ws, 4)}` : "") + (ctx.accent ? ` · accent ${s(ctx.accent, 16)}` : "");
  const windows = list(ctx.windows, 12, 48);
  if (windows) out += `\nOpen windows: ${windows}`;
  const widgets = list(ctx.widgets, 8, 24);
  if (widgets) out += `\nHome widgets: ${widgets}`;
  const journal = list(ctx.journal, 5, 120);
  if (journal) out += `\nRecent journal: ${journal}`;
  const files = list(ctx.files, 40, 120);
  if (files) out += `\nFiles (sample): ${files}`;
  if (ctx.memory) out += `\nLONG-TERM MEMORY (/home/user/.memory.md):\n${s(ctx.memory, 1500)}`;
  return out;
}

async function callClaude(text, context) {
  const ctx = context && typeof context === "object" ? context : {};
  const userMsg = contextBlock(ctx) + `\n\nUser says: ${String(text).slice(0, 2000)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
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

// One agent turn: the browser sends the running message history, we ask the
// model for the next reply + commands. The browser executes them (through the
// unit-tested kernel) and calls back with results — the loop lives client-side.
async function callAgentTurn(messages, context) {
  const ctx = context && typeof context === "object" ? context : {};
  const sys = SYSTEM + contextBlock(ctx);
  const safe = (Array.isArray(messages) ? messages : []).slice(-16).map((m) => ({
    role: m && m.role === "assistant" ? "assistant" : "user",
    content: String((m && m.content) || "").slice(0, 4000)
  }));
  if (!safe.length) safe.push({ role: "user", content: "(no message)" });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2048, system: sys,
      tools: [OS_TOOL], tool_choice: { type: "tool", name: "os_response" }, messages: safe
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use");
  const input = toolUse ? toolUse.input : { reply: "" };
  return {
    reply: String(input.reply || ""),
    actions: (Array.isArray(input.commands) ? input.commands : []).slice(0, 12).map((c) => ({ command: String(c).slice(0, 400) }))
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
    if (url.pathname === "/api/agent" && req.method === "POST") {
      if (!API_KEY) return send(503, "application/json", JSON.stringify({ error: "Set ANTHROPIC_API_KEY to enable Live AI." }));
      const { messages, context } = JSON.parse((await readBody(req)) || "{}");
      if (!Array.isArray(messages)) return send(400, "application/json", JSON.stringify({ error: "messages array required" }));
      const out = await callAgentTurn(messages, context);
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
