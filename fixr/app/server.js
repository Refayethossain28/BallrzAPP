// Fixr API + static host. Express, async store (SQLite or Postgres),
// real AI intake + drafted client messages, client memory (CRM), live updates
// via SSE, payment capture + Connect driver settlement, flight tracking,
// a driver PWA, and driver Connect self-onboarding. Run: `npm start`.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as store from "./db.js";
import { parseInbound, draftMessage, intakeMode } from "./parse.js";
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

/* ---------- live updates (SSE) ----------
   One event stream; console, driver app, and passenger tracking all subscribe.
   In-memory per instance — fine for one web service; move to pub/sub if Fixr
   ever runs multiple instances behind a balancer. */
const subscribers = new Set();

function emit(type, data = {}) {
  const line = `data: ${JSON.stringify({ type, ...data, t: Date.now() })}\n\n`;
  for (const res of subscribers) {
    try { res.write(line); } catch { subscribers.delete(res); }
  }
}

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
  subscribers.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* cleaned up below */ }
  }, 25000);
  req.on("close", () => { clearInterval(heartbeat); subscribers.delete(res); });
});

/* ---------- status / health ---------- */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, db: store.backendName, intake: intakeMode(), payments: paymentsMode(), flight: flightMode() });
});

app.get("/api/stats", wrap(async (_req, res) => res.json(await store.getStats())));

app.get("/api/flight/:number", wrap(async (req, res) => {
  const status = await getFlightStatus(req.params.number);
  if (!status) return res.status(404).json({ error: "no flight number" });
  res.json(status);
}));

/* ---------- clients (the memory layer) ---------- */
app.get("/api/clients", wrap(async (_req, res) => res.json(await store.listClients())));

app.post("/api/clients/:id/prefs", wrap(async (req, res) => {
  const c = await store.updateClientPrefs(req.params.id, req.body.preferences || "");
  if (!c) return res.status(404).json({ error: "client not found" });
  emit("client.updated", { id: c.id });
  res.json(c);
}));

/* ---------- intake & dispatch ---------- */
app.post("/api/parse", wrap(async (req, res) => {
  const parsed = await parseInbound(req.body.text);
  // Recognize repeat clients at parse time — the "★ 4th trip, prefers…" moment.
  const client_profile = await store.getClientByName(parsed.client);
  res.json({ parsed, quote: quoteFor(parsed), client_profile });
}));

async function createFromParsed(parsed, source, quote) {
  const client = await store.findOrCreateClient(parsed.client);
  const slaMinutes = parsed.type === "concierge" ? null : 25 + Math.floor(Math.random() * 40);
  const request = await store.createRequest({
    type: parsed.type, client_name: client?.name || parsed.client, client_id: client?.id,
    source, raw: parsed.raw, parsed,
    quote_amount: quote?.total ?? null, sla_minutes: slaMinutes,
  });
  emit("request.created", { id: request.id, status: request.status });
  return request;
}

app.post("/api/requests", wrap(async (req, res) => {
  const { parsed, source = "manual" } = req.body;
  if (!parsed?.type) return res.status(400).json({ error: "missing parsed payload" });
  const request = await createFromParsed(parsed, source, quoteFor(parsed));
  res.status(201).json(request);
}));

app.get("/api/requests", wrap(async (_req, res) => res.json(await store.listRequests())));
app.get("/api/resources", wrap(async (_req, res) => res.json(await store.listResources())));

// AI-drafted confirmation text the operator can copy-send to the client.
app.post("/api/requests/:id/draft", wrap(async (req, res) => {
  const r = await store.getRequest(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(await draftMessage(r));
}));

app.post("/api/requests/:id/confirm", wrap(async (req, res) => {
  const r = await store.setStatus(req.params.id, "confirmed", "client confirmed");
  emit("request.updated", { id: r.id, status: r.status });
  res.json(r);
}));

app.post("/api/requests/:id/assign", wrap(async (req, res) => {
  const r = await store.assignResource(req.params.id, req.body.resource_id);
  emit("request.updated", { id: r.id, status: r.status });
  res.json(r);
}));

app.post("/api/requests/:id/enroute", wrap(async (req, res) => {
  const r = await store.setStatus(req.params.id, "in_progress", "driver en route · client SMS sent");
  emit("request.updated", { id: r.id, status: r.status });
  res.json(r);
}));

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
  emit("request.updated", { id: updated.id, status: updated.status });
  emit("payment.captured", { id: updated.id, amount: request.quote_amount });
  res.json({ request: updated, payment: pay });
}));

// Operator sets the service fee on a request (used for concierge / custom quotes).
app.post("/api/requests/:id/fee", wrap(async (req, res) => {
  const amount = Math.round(Number(req.body.amount));
  if (!(amount > 0)) return res.status(400).json({ error: "amount must be a positive number" });
  const r = await store.getRequest(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  const updated = await store.setQuote(req.params.id, amount);
  emit("request.updated", { id: updated.id, status: updated.status });
  res.json(updated);
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
  emit("driver.location", { id: req.params.id });
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
  const request = await createFromParsed(parsed, "client", quote);
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
  const request = await createFromParsed(parsed, "client", null);
  res.status(201).json({ request });
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
    driver: driver ? {
      name: driver.name, vehicle: driver.vehicle,
      sharing_location: driver.last_lat != null, location_at: driver.last_ping_at || null,
    } : null,
  });
}));

/* ---------- demo day ----------
   Seeds a realistic day (known clients with preferences, trips across every
   stage, one settled payment) so a first demo never shows an empty board. */
app.post("/api/demo/seed", wrap(async (_req, res) => {
  const existing = await store.listRequests();
  if (existing.length > 0) return res.status(409).json({ error: "board is not empty" });

  const alvarez = await store.findOrCreateClient("Mr. Alvarez");
  const lin = await store.findOrCreateClient("Mrs. Lin");
  const park = await store.findOrCreateClient("Ms. Park");
  await store.updateClientPrefs(alvarez.id, "Prefers Escalade · still water · no small talk");
  await store.updateClientPrefs(lin.id, "S-Class only · front seat forward · WSJ in the back");
  await store.updateClientPrefs(park.id, "Texts, never calls · always add 15 min buffer");

  const mk = (parsed, quote, client) => store.createRequest({
    type: parsed.type, client_name: client.name, client_id: client.id, source: "demo",
    raw: parsed.raw, parsed, quote_amount: quote, sla_minutes: parsed.type === "concierge" ? null : 30,
  });

  // Completed airport run with a settled payment.
  const done = await mk({ type: "airport", client: alvarez.name, datetime: "today 6:00 AM",
    pickup: "The Peninsula", dropoff: "JFK", flight: "DL472", pax: 2, vehicle: "Cadillac Escalade",
    hours: 0, venue: "", notes: "", raw: "Escalade to JFK 6am, flight DL472, 2 pax" }, 204, alvarez);
  await store.recordPayment({ request_id: done.id, provider: "mock", provider_ref: "pi_demo_" + done.id,
    amount: 204, platform_fee: 1.02, driver_share: 143, transfer_ref: "tr_demo_" + done.id, status: "succeeded" });
  await store.setStatus(done.id, "completed", "completed · fare succeeded via mock · platform fee $1.02 · driver $143 settled");

  // In-progress hourly, assigned to a driver.
  const live = await mk({ type: "hourly", client: lin.name, datetime: "tonight 7:00 PM",
    pickup: "The Mark Hotel", dropoff: "", flight: "", pax: 1, vehicle: "Mercedes S-Class",
    hours: 4, venue: "", notes: "dinner then theater", raw: "S-Class tonight 7pm, as directed ~4 hrs" }, 532, lin);
  await store.assignResource(live.id, "d2");
  await store.setStatus(live.id, "in_progress", "driver en route · client SMS sent");

  // Confirmed transfer + fresh quote + an unpriced concierge ask.
  const conf = await mk({ type: "transfer", client: park.name, datetime: "tomorrow 9:15 AM",
    pickup: "The Carlyle", dropoff: "432 Park Ave", flight: "", pax: 1, vehicle: "Sedan",
    hours: 0, venue: "", notes: "", raw: "Sedan from The Carlyle to 432 Park, 9:15am" }, 74, park);
  await store.setStatus(conf.id, "confirmed", "client confirmed");
  await mk({ type: "airport", client: alvarez.name, datetime: "Fri 4:30 PM",
    pickup: "Midtown office", dropoff: "TEB", flight: "", pax: 3, vehicle: "Sprinter Executive",
    hours: 0, venue: "", notes: "private aviation — wheels up 6pm", raw: "Sprinter to Teterboro Friday, 3 pax" }, 236, alvarez);
  await mk({ type: "concierge", client: lin.name, datetime: "Sat 8:00 PM",
    pickup: "", dropoff: "", flight: "", pax: 4, vehicle: "Any", hours: 0,
    venue: "Carbone", notes: "Table for 4 at Carbone Saturday 8pm, quiet booth", raw: "Concierge: Carbone Sat 8pm x4" }, null, lin);

  emit("request.created", { id: "demo" });
  res.json({ ok: true, clients: 3, requests: 5 });
}));

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Fixr on http://localhost:${PORT}  [db=${store.backendName} intake=${intakeMode()} payments=${paymentsMode()} flight=${flightMode()}]`);
  });
}

export { app };
