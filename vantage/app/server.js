// Vantage API + static host. Express, async store (SQLite or Postgres),
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

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Vantage on http://localhost:${PORT}  [db=${store.backendName} intake=${intakeMode()} payments=${paymentsMode()} flight=${flightMode()}]`);
  });
}

export { app };
