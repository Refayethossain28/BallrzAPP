// AI inbound intake: free text -> structured request payload.
//
// Primary path: a single Claude call with structured JSON output
// (output_config.format + a strict json_schema) on claude-opus-4-8.
// Fallback path: a deterministic heuristic parser, so the app runs with no
// ANTHROPIC_API_KEY (local dev, CI, demos) and degrades gracefully on error.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-4-8";

// Strict schema Claude must conform to. additionalProperties:false + required
// are mandatory for structured outputs.
const REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["transfer", "hourly", "airport", "concierge"] },
    client: { type: "string", description: "Passenger/client name, or 'New client'." },
    datetime: { type: "string", description: "Pickup time in the client's words, e.g. 'Thursday 6am'." },
    pickup: { type: "string" },
    dropoff: { type: "string" },
    flight: { type: "string", description: "Flight number like DL472, or empty." },
    pax: { type: "integer", description: "Passenger count; 1 if unstated." },
    vehicle: {
      type: "string",
      enum: ["Sedan", "Mercedes S-Class", "SUV", "Cadillac Escalade", "Sprinter Executive", "Any"],
    },
    hours: { type: "integer", description: "Hours for hourly/as-directed bookings; 0 otherwise." },
    venue: { type: "string", description: "For concierge requests: the venue/restaurant; else empty." },
    notes: { type: "string" },
  },
  required: ["type", "client", "datetime", "pickup", "dropoff", "flight", "pax", "vehicle", "hours", "venue", "notes"],
};

const SYSTEM = `You are the intake parser for a luxury chauffeur & concierge dispatch system.
Convert a single inbound client message (SMS, email, or transcribed voicemail) into a
structured booking. Rules:
- type: "airport" if it involves a flight or a named airport; "hourly" if as-directed / by the hour;
  "concierge" if it's a non-transport request (restaurant booking, tickets, etc.); else "transfer".
- Resolve relative times into the client's own phrasing (keep "Thursday 6am", don't invent a date).
- Map vehicle hints (Suburban/Escalade->Cadillac Escalade, S-Class->Mercedes S-Class,
  Sprinter/van->Sprinter Executive, sedan/town car->Sedan). Use "Any" if unstated.
- Leave fields you can't determine as empty string (or 0 / 1 for numbers). Never guess a flight number.`;

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

export function intakeMode() {
  return process.env.ANTHROPIC_API_KEY ? "llm" : "heuristic";
}

export async function parseInbound(raw) {
  const text = (raw || "").trim();
  if (!text) throw new Error("empty message");

  const c = getClient();
  if (c) {
    try {
      return await parseWithClaude(c, text);
    } catch (err) {
      // Never fail intake because the model is unreachable — fall back.
      console.warn("[parse] LLM failed, using heuristic:", err.message);
    }
  }
  return { ...heuristicParse(text), _engine: "heuristic" };
}

async function parseWithClaude(c, text) {
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: REQUEST_SCHEMA } },
    messages: [{ role: "user", content: text }],
  });

  // With structured output the model returns JSON text; find and parse it.
  const jsonBlock = res.content.find((b) => b.type === "text");
  const payload = JSON.parse(jsonBlock.text);
  return { ...normalize(payload, text), _engine: "llm" };
}

/* ---------- heuristic fallback (no dependencies, deterministic) ---------- */

const AIRPORTS = ["JFK", "LGA", "EWR", "LAX", "SFO", "ORD", "MIA", "BOS", "DCA", "IAD", "ATL", "TEB", "VNY"];

export function heuristicParse(raw) {
  const t = raw.toLowerCase();
  const airport = AIRPORTS.find((a) => raw.toUpperCase().includes(a));
  const isConcierge =
    /\b(table|reservation|book .* at|tickets|restaurant|dinner reservation|booth)\b/.test(t) &&
    !/\b(car|suburban|sedan|suv|sprinter|s-class|pickup|drop)\b/.test(t);

  let type = "transfer";
  if (isConcierge) type = "concierge";
  else if (/\b(hourly|as directed|as-directed|hours|hrs)\b/.test(t)) type = "hourly";
  else if (airport || /\bflight\b/.test(t)) type = "airport";

  const client = (raw.match(/(?:mr\.?|mrs\.?|ms\.?|dr\.?)\s+[A-Z][a-z]+/i) || [])[0] || "New client";
  const when = (raw.match(/\b(\d{1,2}(:\d{2})?\s?(am|pm))\b/i) || [])[0] || "";
  const day = (raw.match(/\b(today|tomorrow|mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i) || [])[0] || "";
  const datetime = [day, when].filter(Boolean).join(" ");
  const pax = parseInt(
    (raw.match(/(\d+)\s*(passenger|pax|people|guest)/i) || [])[1] ||
    (raw.match(/party of (\d+)/i) || [])[1] || "1", 10);
  const flight = ((raw.match(/\b([A-Z]{2}\s?\d{2,4})\b/) || [])[1] || "").replace(/\s/, "");

  let vehicle = "Any";
  if (/suburban|escalade|suv/i.test(t)) vehicle = "Cadillac Escalade";
  else if (/s-class|s class|mercedes/i.test(t)) vehicle = "Mercedes S-Class";
  else if (/sprinter|van/i.test(t)) vehicle = "Sprinter Executive";
  else if (/sedan|town car/i.test(t)) vehicle = "Sedan";

  const pickup = (raw.match(/from ([^,]+?)(?: to | at |,|$)/i) || [])[1] || "";
  let dropoff = (raw.match(/to ([A-Z0-9][^,]+?)(?: at |,|$)/i) || [])[1] || "";
  if (type === "airport" && airport && !dropoff) dropoff = airport;
  const hours = parseInt((raw.match(/(\d+)\s*(hours|hrs)/i) || [])[1] || (type === "hourly" ? "3" : "0"), 10);
  const venue = (raw.match(/at ([A-Z][a-zA-Z'’ ]+?)(?: friday| saturday| sunday| monday| tuesday| wednesday| thursday| at |,|$)/) || [])[1] || "";

  return normalize({ type, client, datetime, pickup, dropoff, flight, pax, vehicle, hours, venue, notes: "" }, raw);
}

function normalize(p, raw) {
  return {
    type: p.type || "transfer",
    client: p.client || "New client",
    datetime: p.datetime || "—",
    pickup: p.pickup || "",
    dropoff: p.dropoff || "",
    flight: (p.flight || "").toUpperCase(),
    pax: Number.isFinite(p.pax) ? p.pax : 1,
    vehicle: p.vehicle || "Any",
    hours: Number.isFinite(p.hours) ? p.hours : 0,
    venue: p.venue || "",
    notes: p.notes || "",
    raw,
  };
}
