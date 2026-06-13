// server.mjs — local proxy that wires the concierge "split the bill" action to
// a REAL Claude tool-use call. Zero dependencies: Node 18+ built-in fetch +
// http only, so it runs with `node server.mjs` (no npm install), matching the
// repo's zero-build prototype ethos.
//
// Design (mirrors concepts/01-ai-life-concierge.md, Part B):
//   • The LLM is the ROUTER. Claude parses free text into a structured intent
//     (total + which known people are involved) via a FORCED tool call. It does
//     the natural-language understanding humans are bad to hard-code.
//   • The TOOL LAYER is the product. The server does the money math
//     deterministically (even split + exact penny distribution) and stamps an
//     idempotency key — never trusting the model's arithmetic. Reliable,
//     idempotent tool execution is the whole point.
//   • Keys stay server-side. The browser never sees ANTHROPIC_API_KEY; it POSTs
//     free text to /agent and gets back the same structured proposal the
//     in-page stub produces, so the UI is identical whether live or offline.
//
// In production this proxy is the "Agent service (orchestrator)" box in the
// architecture diagram. Here it's ~120 lines so you can read the whole path.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = "claude-opus-4-8"; // latest, most capable — agent reliability is the product
const PARTICIPANTS = ["you", "Sam", "Alex"]; // the known group roster

// The tool Claude is FORCED to call. Note its job is parse-only: extract the
// total and the people. The dollar math is deliberately NOT delegated.
const TOOLS = [
  {
    name: "parse_bill",
    description:
      "Extract a bill total and the set of people splitting it from a chat message. " +
      "Only call this when the message describes a shared cost to split.",
    input_schema: {
      type: "object",
      properties: {
        total: {
          type: "number",
          description: "The total bill amount in dollars (e.g. 138.60).",
        },
        participants: {
          type: "array",
          items: { type: "string", enum: PARTICIPANTS },
          description:
            "Everyone sharing the cost, including 'you' for the payer/speaker. " +
            "If the message says 'everyone' or 'the group', include all of: " +
            PARTICIPANTS.join(", ") + ".",
        },
      },
      required: ["total", "participants"],
    },
  },
];

// Deterministic, idempotent money math — the server's job, not the model's.
function buildSplit(total, participants) {
  const uniq = [...new Set(participants)].filter((p) => PARTICIPANTS.includes(p));
  if (!(total > 0) || uniq.length < 2) return null;
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / uniq.length);
  const rem = cents - base * uniq.length;
  const shares = uniq.map((name, i) => ({ name, cents: base + (i < rem ? 1 : 0) }));
  const key = "split_" + uniq.slice().sort().join("-") + "_" + cents;
  return { kind: "split", total, payer: "you", shares, key, source: "claude" };
}

// Call Claude with tool_choice forcing parse_bill, then do the math ourselves.
async function runClaudeAgent(text) {
  if (!API_KEY) throw new Error("no ANTHROPIC_API_KEY in env");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      tools: TOOLS,
      tool_choice: { type: "tool", name: "parse_bill" }, // force the structured call
      messages: [
        {
          role: "user",
          content:
            `Group chat with ${PARTICIPANTS.join(", ")}. ` +
            `"you" is the speaker. Message: ${JSON.stringify(text)}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error("anthropic " + res.status + ": " + (await res.text()));
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use");
  if (!toolUse) return null; // model declined to act — no actionable bill
  const { total, participants } = toolUse.input || {};
  return buildSplit(Number(total), Array.isArray(participants) ? participants : []);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/agent") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { text } = JSON.parse(body || "{}");
        const proposal = await runClaudeAgent(String(text || ""));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, proposal }));
      } catch (err) {
        // The browser falls back to its in-page stub on any failure.
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
    });
    return;
  }
  // Serve the prototype itself so it's one origin (no CORS).
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    try {
      const html = await readFile(join(__dirname, "index.html"));
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(404).end("index.html not found");
    }
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`concierge-split agent on http://localhost:${PORT}`);
  console.log(API_KEY ? "→ live Claude tool-use enabled" : "→ no ANTHROPIC_API_KEY: client will use offline stub");
});
