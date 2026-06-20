// Vantage API + static host. A real server: persistent SQLite, REST endpoints,
// real AI intake, real (or mock) payment capture. Run: `npm start`.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as store from "./db.js";
import { parseInbound, intakeMode } from "./parse.js";
import { quoteFor } from "./quote.js";
import { captureForRequest, paymentsMode } from "./payments.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(here, "public")));

store.seedIfEmpty();

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });

// Health / mode — shows whether real AI + payments are wired up.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, intake: intakeMode(), payments: paymentsMode() });
});

// Parse free text -> structured booking + instant quote (no DB write yet).
app.post("/api/parse", wrap(async (req, res) => {
  const parsed = await parseInbound(req.body.text);
  const quote = quoteFor(parsed);
  res.json({ parsed, quote });
}));

// Confirm a parsed booking into the dispatch board.
app.post("/api/requests", wrap(async (req, res) => {
  const { parsed, source = "manual" } = req.body;
  if (!parsed?.type) return res.status(400).json({ error: "missing parsed payload" });
  const quote = quoteFor(parsed);
  const slaMinutes = parsed.type === "concierge" ? null : 25 + Math.floor(Math.random() * 40);
  const request = store.createRequest({
    type: parsed.type,
    client_name: parsed.client,
    source,
    raw: parsed.raw,
    parsed,
    quote_amount: quote?.total ?? null,
    sla_minutes: slaMinutes,
  });
  res.status(201).json(request);
}));

app.get("/api/requests", wrap((_req, res) => res.json(store.listRequests())));
app.get("/api/resources", wrap((_req, res) => res.json(store.listResources())));

app.post("/api/requests/:id/confirm", wrap((req, res) => {
  res.json(store.setStatus(req.params.id, "confirmed", "client confirmed"));
}));

app.post("/api/requests/:id/assign", wrap((req, res) => {
  res.json(store.assignResource(req.params.id, req.body.resource_id));
}));

app.post("/api/requests/:id/enroute", wrap((req, res) => {
  res.json(store.setStatus(req.params.id, "in_progress", "driver en route · client SMS sent"));
}));

// Complete the trip AND capture payment (mock or real Stripe).
app.post("/api/requests/:id/complete", wrap(async (req, res) => {
  const request = store.getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: "not found" });

  const pay = await captureForRequest(request);
  store.recordPayment({
    request_id: request.id,
    provider: pay.provider,
    provider_ref: pay.provider_ref,
    amount: request.quote_amount,
    status: pay.status,
  });
  if (request.assigned_resource_id) store.setResourceStatus(request.assigned_resource_id, "available");

  const updated = store.setStatus(
    request.id, "completed",
    `completed · payment ${pay.status} via ${pay.provider} · platform fee $${pay.platformFee}`
  );
  res.json({ request: updated, payment: pay });
}));

// Only auto-listen when run directly (`npm start`), not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Vantage on http://localhost:${PORT}  [intake=${intakeMode()} payments=${paymentsMode()}]`);
  });
}

export { app };
