// Vantage API + static host. A real server: persistent SQLite, REST endpoints,
// real AI intake, real (or mock) payment capture. Run: `npm start`.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as store from "./db.js";
import { parseInbound, intakeMode } from "./parse.js";
import { quoteFor } from "./quote.js";
import { captureAndSettle, paymentsMode } from "./payments.js";
import { getFlightStatus, flightMode } from "./flight.js";

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

// Health / mode — shows whether real AI + payments + flight tracking are wired up.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, intake: intakeMode(), payments: paymentsMode(), flight: flightMode() });
});

// Live flight status (real AviationStack when FLIGHT_API_KEY is set, else mock).
app.get("/api/flight/:number", wrap(async (req, res) => {
  const status = await getFlightStatus(req.params.number);
  if (!status) return res.status(404).json({ error: "no flight number" });
  res.json(status);
}));

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

// Complete the trip: capture the fare AND settle the driver (Connect / mock).
app.post("/api/requests/:id/complete", wrap(async (req, res) => {
  const request = store.getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: "not found" });

  const driver = request.assigned_resource_id ? store.getResource(request.assigned_resource_id) : null;
  const pay = await captureAndSettle(request, driver);
  store.recordPayment({
    request_id: request.id,
    provider: pay.provider,
    provider_ref: pay.provider_ref,
    amount: request.quote_amount,
    platform_fee: pay.platformFee,
    driver_share: pay.driverShare,
    transfer_ref: pay.transfer_ref,
    status: pay.status,
  });
  if (driver) store.setResourceStatus(driver.id, "available");

  const settleMsg = pay.driverShare
    ? ` · driver $${pay.driverShare} ${pay.settled ? "settled" : "pending onboarding"}`
    : "";
  const updated = store.setStatus(
    request.id, "completed",
    `completed · fare ${pay.status} via ${pay.provider} · platform fee $${pay.platformFee}${settleMsg}`
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
