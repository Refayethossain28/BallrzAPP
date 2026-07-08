// Fixr API + static host. Express, async store (SQLite or Postgres),
// real AI intake, payment capture + Connect driver settlement, flight tracking,
// a driver PWA, and driver Connect self-onboarding. Run: `npm start`.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as store from "./db.js";
import { parseInbound, intakeMode } from "./parse.js";
import { quoteFor } from "./quote.js";
import { captureAndSettle, paymentsMode } from "./payments.js";
import { getFlightStatus, flightMode } from "./flight.js";
import { createOnboardingLink, accountStatus } from "./connect.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(here, "public")));

await store.seedIfEmpty();

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });
const baseUrl = (req) => `${req.protocol}://${req.get("host")}`;

// Homepage is now the marketing site (public/index.html); the operator console
// lives at /app/. Keep the old /pitch link working.
app.get(["/pitch", "/pitch/"], (_req, res) => res.redirect(301, "/"));

/* ---------- status / health ---------- */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, db: store.backendName, intake: intakeMode(), payments: paymentsMode(), flight: flightMode() });
});

app.get("/api/flight/:number", wrap(async (req, res) => {
  const status = await getFlightStatus(req.params.number);
  if (!status) return res.status(404).json({ error: "no flight number" });
  res.json(status);
}));

/* ---------- intake & dispatch ---------- */
app.post("/api/parse", wrap(async (req, res) => {
  const parsed = await parseInbound(req.body.text);
  res.json({ parsed, quote: quoteFor(parsed) });
}));

app.post("/api/requests", wrap(async (req, res) => {
  const { parsed, source = "manual" } = req.body;
  if (!parsed?.type) return res.status(400).json({ error: "missing parsed payload" });
  const quote = quoteFor(parsed);
  const slaMinutes = parsed.type === "concierge" ? null : 25 + Math.floor(Math.random() * 40);
  const request = await store.createRequest({
    type: parsed.type, client_name: parsed.client, source, raw: parsed.raw,
    parsed, quote_amount: quote?.total ?? null, sla_minutes: slaMinutes,
  });
  res.status(201).json(request);
}));

app.get("/api/requests", wrap(async (_req, res) => res.json(await store.listRequests())));
app.get("/api/resources", wrap(async (_req, res) => res.json(await store.listResources())));

app.post("/api/requests/:id/confirm", wrap(async (req, res) =>
  res.json(await store.setStatus(req.params.id, "confirmed", "client confirmed"))));

app.post("/api/requests/:id/assign", wrap(async (req, res) =>
  res.json(await store.assignResource(req.params.id, req.body.resource_id))));

app.post("/api/requests/:id/enroute", wrap(async (req, res) =>
  res.json(await store.setStatus(req.params.id, "in_progress", "driver en route · client SMS sent"))));

app.post("/api/requests/:id/complete", wrap(async (req, res) => {
  const request = await store.getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: "not found" });
  const driver = request.assigned_resource_id ? await store.getResource(request.assigned_resource_id) : null;
  const pay = await captureAndSettle(request, driver);
  await store.recordPayment({
    request_id: request.id, provider: pay.provider, provider_ref: pay.provider_ref,
    amount: request.quote_amount, platform_fee: pay.platformFee, driver_share: pay.driverShare,
    transfer_ref: pay.transfer_ref, status: pay.status,
  });
  if (driver) await store.setResourceStatus(driver.id, "available");
  const settleMsg = pay.driverShare ? ` · driver $${pay.driverShare} ${pay.settled ? "settled" : "pending onboarding"}` : "";
  const updated = await store.setStatus(request.id, "completed",
    `completed · fare ${pay.status} via ${pay.provider} · platform fee $${pay.platformFee}${settleMsg}`);
  res.json({ request: updated, payment: pay });
}));

/* ---------- driver app ---------- */
app.get("/api/driver/:id/trips", wrap(async (req, res) => {
  const driver = await store.getResource(req.params.id);
  if (!driver) return res.status(404).json({ error: "driver not found" });
  res.json({ driver, trips: await store.listRequestsForDriver(driver.id) });
}));

app.post("/api/driver/:id/location", wrap(async (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== "number" || typeof lng !== "number") return res.status(400).json({ error: "lat/lng required" });
  await store.setResourceLocation(req.params.id, lat, lng);
  res.json({ ok: true });
}));

/* ---------- Stripe Connect self-onboarding ---------- */
app.post("/api/drivers/:id/connect/onboard", wrap(async (req, res) => {
  const driver = await store.getResource(req.params.id);
  if (!driver) return res.status(404).json({ error: "driver not found" });
  const link = await createOnboardingLink(driver, baseUrl(req));
  await store.setResourceConnect(driver.id, link.accountId);
  res.json(link);
}));

app.get("/api/drivers/:id/connect/status", wrap(async (req, res) => {
  const driver = await store.getResource(req.params.id);
  if (!driver) return res.status(404).json({ error: "driver not found" });
  res.json(await accountStatus(driver));
}));

/* ---------- client / passenger app ---------- */
// A passenger books directly; the request lands on the same dispatch board as
// any other (source 'client'). Same `request` primitive, created by the guest.
app.post("/api/client/request", wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.pickup || !b.dropoff) return res.status(400).json({ error: "pickup and dropoff required" });
  const type = b.flight ? "airport" : "transfer";
  const parsed = {
    type, client: b.client_name || "Guest",
    datetime: b.when || "ASAP", pickup: b.pickup, dropoff: b.dropoff,
    flight: (b.flight || "").toUpperCase(), pax: Number(b.pax) || 1,
    vehicle: b.vehicle || "Any", hours: 0, venue: "", notes: b.notes || "",
    raw: `Client booking: ${b.pickup} → ${b.dropoff}${b.when ? " · " + b.when : ""}`,
  };
  const quote = quoteFor(parsed);
  const request = await store.createRequest({
    type, client_name: parsed.client, source: "client", raw: parsed.raw,
    parsed, quote_amount: quote?.total ?? null, sla_minutes: 25 + Math.floor(Math.random() * 40),
  });
  res.status(201).json({ request, quote });
}));

// A passenger requests a concierge service (dining, tickets, jet, anything) —
// same `request` primitive, type 'concierge'. Priced by the operator as a fee.
app.post("/api/client/concierge", wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.request) return res.status(400).json({ error: "describe your request" });
  const parsed = {
    type: "concierge", client: b.client_name || "Guest",
    datetime: b.when || "—", pickup: "", dropoff: "", flight: "",
    pax: Number(b.pax) || 1, vehicle: "Any", hours: 0,
    venue: b.venue || "", notes: b.request,
    raw: `Concierge: ${b.request}${b.when ? " · " + b.when : ""}`,
  };
  const request = await store.createRequest({
    type: "concierge", client_name: parsed.client, source: "client",
    raw: parsed.raw, parsed, quote_amount: null, sla_minutes: null,
  });
  res.status(201).json({ request });
}));

// Operator sets the service fee on a request (used for concierge / custom quotes).
app.post("/api/requests/:id/fee", wrap(async (req, res) => {
  const amount = Math.round(Number(req.body.amount));
  if (!(amount > 0)) return res.status(400).json({ error: "amount must be a positive number" });
  const r = await store.getRequest(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(await store.setQuote(req.params.id, amount));
}));

// Passenger-facing status view (no internal fields/audit).
app.get("/api/client/request/:id", wrap(async (req, res) => {
  const r = await store.getRequest(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  const driver = r.assigned_resource_id ? await store.getResource(r.assigned_resource_id) : null;
  const p = r.parsed_payload || {};
  res.json({
    id: r.id, status: r.status, type: r.type, quote: r.quote_amount,
    pickup: p.pickup, dropoff: p.dropoff, when: p.datetime, vehicle: p.vehicle, flight: p.flight,
    request: p.notes || "", venue: p.venue || "",
    driver: driver ? { name: driver.name, vehicle: driver.vehicle, sharing_location: driver.last_lat != null } : null,
  });
}));

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Fixr on http://localhost:${PORT}  [db=${store.backendName} intake=${intakeMode()} payments=${paymentsMode()} flight=${flightMode()}]`);
  });
}

export { app };
