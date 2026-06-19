// server.mjs — Lingua's local AI proxy. Wires Translate / Teach / Ask / Practice
// / Chat to REAL Claude calls so answers are accurate, while keeping the API key
// server-side (the browser never sees ANTHROPIC_API_KEY). Zero dependencies:
// Node 18+ built-in `fetch` + `http`, matching the repo's zero-build ethos.
//
//   • The model does the linguistics — translation, dialect rendering,
//     romanization, grammar explanation, quiz generation and tutor role-play.
//   • Translate / Teach / Practice / Chat FORCE a tool call so the result is
//     structured JSON the front-end renders deterministically.
//   • Free-form "Ask" lets Claude answer in prose.
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

const PRACTICE_TOOL = {
  name: "practice_set",
  description: "Return a set of vocabulary/phrase cards for flashcard and quiz practice.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "8–10 useful items for the requested topic & level.",
        items: {
          type: "object",
          properties: {
            front:         { type: "string", description: "The English prompt / meaning to test recall from." },
            back:          { type: "string", description: "The answer in the target language/dialect (native script)." },
            pronunciation: { type: "string", description: "Romanized pronunciation. Empty if Latin script." }
          },
          required: ["front", "back"]
        }
      }
    },
    required: ["items"]
  }
};

const CHAT_TOOL = {
  name: "tutor_reply",
  description: "Reply as a friendly native-speaker tutor in the target dialect, and gently correct the learner.",
  input_schema: {
    type: "object",
    properties: {
      reply:         { type: "string", description: "Your conversational reply in the target language/dialect (native script). Keep it short and natural for the learner's level." },
      pronunciation: { type: "string", description: "Romanized pronunciation of your reply. Empty if Latin script." },
      english:       { type: "string", description: "A brief English gloss of your reply." },
      correction:    { type: "string", description: "A short, encouraging note correcting the learner's last message if needed. Empty if it was fine." }
    },
    required: ["reply"]
  }
};

function targetLabel(p) {
  return p.dialect ? `${p.targetName} (${p.dialect} dialect)` : p.targetName;
}

// Returns { sys, messages, tools, force }. Chat passes a conversation; everything
// else is a single user turn.
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
    return { sys, messages: [{ role: "user", content: user }], tools: [TRANSLATE_TOOL], force: "translation_result" };
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
    return { sys, messages: [{ role: "user", content: user }], tools: [LESSON_TOOL], force: "lesson" };
  }
  if (p.mode === "practice") {
    const sys =
      "You are a language tutor building flashcards. Produce genuinely useful, correct items " +
      "for the SPECIFIC dialect requested, with native script and romanized pronunciation for " +
      "non-Latin scripts. Vary the items; keep them appropriate to the learner's level.";
    const user =
      `Create a practice set of about ${p.count || 10} items on "${p.topic}" for a ${p.level} ` +
      `learner of ${targetLabel(p)}.` + (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : "");
    return { sys, messages: [{ role: "user", content: user }], tools: [PRACTICE_TOOL], force: "practice_set" };
  }
  if (p.mode === "chat") {
    const sys =
      `You are a warm, encouraging native-speaker conversation partner and tutor for a ${p.level || "beginner"} ` +
      `learner of ${targetLabel(p)}.` + (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : "") +
      " Stay in character as a friendly local. Reply in the target dialect's natural everyday speech, " +
      "kept short and simple for the learner's level. Always provide romanized pronunciation and a brief " +
      "English gloss. If the learner's last message has a mistake, add a short kind correction; otherwise leave it empty. " +
      "Keep the conversation going with a simple question.";
    const history = Array.isArray(p.messages) ? p.messages : [];
    const messages = history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content }));
    if (!messages.length) messages.push({ role: "user", content: "(Start the conversation with a friendly greeting and a simple question.)" });
    return { sys, messages, tools: [CHAT_TOOL], force: "tutor_reply" };
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
  return { sys, messages: [{ role: "user", content: user }], tools: null, force: null };
}

async function callClaude(p) {
  if (!API_KEY) throw new Error("no ANTHROPIC_API_KEY in env");
  const { sys, messages, tools, force } = buildRequest(p);
  const body = { model: MODEL, max_tokens: 1500, system: sys, messages };
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
