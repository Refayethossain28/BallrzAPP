// server.mjs — Lingua's local AI proxy. Wires the Translate / Teach / Ask
// actions to REAL Claude calls so answers are accurate, while keeping the API
// key server-side (the browser never sees ANTHROPIC_API_KEY). Zero dependencies:
// Node 18+ built-in `fetch` + `http`, matching the repo's zero-build ethos.
//
//   • The model does the linguistics — translation, dialect rendering,
//     romanization and grammar explanation — which is exactly what a strong
//     LLM is good at and what hard-coded tables get wrong.
//   • For Translate and Teach we FORCE a tool call so the result is structured
//     JSON the front-end can render deterministically (no brittle parsing).
//   • For free-form "Ask" we let Claude answer in prose.
//   • Same origin as the page (we also serve index.html), so there's no CORS.
//
// Run:  ANTHROPIC_API_KEY=sk-ant-... node server.mjs
// Then: open http://localhost:8788

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8788;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
// Latest, most capable model — accuracy is the whole point of this app.
const MODEL = process.env.LINGUA_MODEL || "claude-opus-4-8";

/* ---- the structured tools Claude is forced to fill in ---- */
const TRANSLATE_TOOL = {
  name: "translation_result",
  description: "Return a precise translation with pronunciation and useful learner notes.",
  input_schema: {
    type: "object",
    properties: {
      translation:   { type: "string", description: "The translated text in the target language/dialect, in its native script." },
      pronunciation: { type: "string", description: "Romanized pronunciation (e.g. pinyin, romaji, transliteration). Empty if the target already uses Latin script." },
      literal:       { type: "string", description: "A word-for-word literal gloss when it differs interestingly from the natural translation; otherwise empty." },
      register:      { type: "string", description: "Formality/register note, e.g. 'casual', 'polite/formal', 'spoken only'." },
      notes:         { type: "string", description: "One short note on dialect-specific word choice, gender, or usage. Empty if nothing notable." }
    },
    required: ["translation"]
  }
};

const LESSON_TOOL = {
  name: "lesson",
  description: "Return a short, level-appropriate, dialect-aware mini lesson on the requested topic.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      intro: { type: "string", description: "One or two sentences of context." },
      items: {
        type: "array",
        description: "5–8 example phrases/words for the topic.",
        items: {
          type: "object",
          properties: {
            phrase:        { type: "string", description: "The phrase in the target language/dialect (native script)." },
            pronunciation: { type: "string", description: "Romanized pronunciation. Empty if Latin script." },
            meaning:       { type: "string", description: "English meaning / when to use it." }
          },
          required: ["phrase", "meaning"]
        }
      },
      tip:         { type: "string", description: "One practical learning or cultural tip." },
      dialectNote: { type: "string", description: "How this differs in the requested dialect vs. the standard. Empty if not applicable." }
    },
    required: ["title", "items"]
  }
};

function targetLabel(p) {
  return p.dialect ? `${p.targetName} (${p.dialect} dialect)` : p.targetName;
}

function buildRequest(p) {
  if (p.mode === "translate") {
    const sys =
      "You are an expert translator and dialectologist. Translate accurately into the " +
      "EXACT requested language and dialect, using the natural phrasing a native speaker of " +
      "that specific variety would use (not just the standard form). Use the correct native script. " +
      "Provide romanized pronunciation for non-Latin scripts. Be precise and never invent words.";
    const user =
      `Translate the following from ${p.sourceName} into ${targetLabel(p)}.` +
      (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : "") +
      `\n\nText:\n${JSON.stringify(p.text || "")}`;
    return { sys, user, tools: [TRANSLATE_TOOL], force: "translation_result" };
  }
  if (p.mode === "teach") {
    const sys =
      "You are a patient, accurate language tutor. Produce a short, practical mini-lesson " +
      "for the requested topic, tailored to the learner's level and to the SPECIFIC dialect " +
      "requested (use that variety's real vocabulary and pronunciation, not only the standard). " +
      "Use correct native script and give romanized pronunciation for non-Latin scripts.";
    const user =
      `Teach a ${p.level} learner the topic "${p.topic}" in ${targetLabel(p)}.` +
      (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : "");
    return { sys, user, tools: [LESSON_TOOL], force: "lesson" };
  }
  // ask
  const sys =
    "You are an expert, accurate language teacher. Answer the learner's question about the " +
    "language/dialect clearly and concisely. Give examples in native script with romanized " +
    "pronunciation where helpful. If the question is about a specific dialect, answer for that variety.";
  const user =
    `Language: ${targetLabel(p)}.` +
    (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : "") +
    `\n\nQuestion: ${p.question || ""}`;
  return { sys, user, tools: null, force: null };
}

async function callClaude(p) {
  if (!API_KEY) throw new Error("no ANTHROPIC_API_KEY in env");
  const { sys, user, tools, force } = buildRequest(p);
  const body = {
    model: MODEL,
    max_tokens: 1500,
    system: sys,
    messages: [{ role: "user", content: user }],
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = { type: "tool", name: force };
  }
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
  const blocks = data.content || [];
  if (tools) {
    const toolUse = blocks.find((b) => b.type === "tool_use");
    if (!toolUse) throw new Error("model returned no structured result");
    return toolUse.input || {};
  }
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return { answer: text };
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

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, live: !!API_KEY, model: MODEL }));
    return;
  }
  if (req.method === "POST" && req.url === "/ai") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const result = await callClaude(payload);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err) {
        // The browser falls back to its offline starter set on any failure.
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
    });
    return;
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`Lingua on http://localhost:${PORT}`);
  console.log(API_KEY ? `→ live Claude (${MODEL}) enabled` : "→ no ANTHROPIC_API_KEY: client uses the offline starter set");
});
