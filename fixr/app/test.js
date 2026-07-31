// End-to-end smoke test against the real server: boot it, drive a request
// through the full lifecycle, assert persistence + payment. No secrets needed
// (intake falls back to the heuristic parser, payments to a mock capture).
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FIXR_DB = join(mkdtempSync(join(tmpdir(), "fixr-")), "t.db");
process.env.PORT = "0"; // ephemeral port

const { app } = await import("./server.js");
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://localhost:${server.address().port}`;
const call = (p, opts) => fetch(base + p, { headers: { "Content-Type": "application/json" }, ...opts }).then(async (r) => {
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
});

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log("  ✓", msg); passed++; };

try {
  const h = await call("/api/health");
  ok(h.ok, `health: db=${h.db} intake=${h.intake} payments=${h.payments} flight=${h.flight}`);

  const { parsed, quote } = await call("/api/parse", {
    method: "POST",
    body: JSON.stringify({ text: "Need a Suburban to JFK Thursday 6am for Mr. Alvarez, 2 passengers, flight DL472" }),
  });
  ok(parsed.type === "airport", `parsed type=airport from free text`);
  ok(parsed.flight === "DL472", `extracted flight DL472`);
  ok(parsed.vehicle === "Cadillac Escalade", `mapped Suburban -> Cadillac Escalade`);
  ok(quote && quote.total > 0, `instant quote = $${quote.total}`);

  const req = await call("/api/requests", { method: "POST", body: JSON.stringify({ parsed, source: "test" }) });
  ok(req.id && req.status === "quoted", `request created (${req.id}) in 'quoted'`);

  const drivers = await call("/api/resources");
  ok(drivers.length >= 1, `${drivers.length} drivers seeded`);

  await call(`/api/requests/${req.id}/confirm`, { method: "POST" });
  const assigned = await call(`/api/requests/${req.id}/assign`, { method: "POST", body: JSON.stringify({ resource_id: drivers[0].id }) });
  ok(assigned.status === "assigned" && assigned.assigned_resource_id === drivers[0].id, `assigned to ${drivers[0].name}`);

  // Driver app: the assigned driver sees the trip, and can ping location.
  const drv = await call(`/api/driver/${drivers[0].id}/trips`);
  ok(drv.trips.some((t) => t.id === req.id), `driver ${drivers[0].name} sees the assigned trip`);
  const ping = await call(`/api/driver/${drivers[0].id}/location`, { method: "POST", body: JSON.stringify({ lat: 40.71, lng: -74.0 }) });
  ok(ping.ok, `driver location ping accepted`);

  // Stripe Connect self-onboarding (mock when no key).
  const onboard = await call(`/api/drivers/${drivers[0].id}/connect/onboard`, { method: "POST" });
  ok(onboard.accountId && onboard.url, `onboarding link created (${onboard.provider})`);
  const cstatus = await call(`/api/drivers/${drivers[0].id}/connect/status`);
  ok(cstatus.connected, `driver Connect account connected (${cstatus.account_id})`);

  // Client app: a passenger books directly and tracks status.
  const booking = await call(`/api/client/request`, {
    method: "POST",
    body: JSON.stringify({ client_name: "Ms. Park", pickup: "The Mark Hotel", dropoff: "LaGuardia", when: "Fri 5pm", vehicle: "Mercedes S-Class", pax: 2 }),
  });
  ok(booking.request?.id && booking.quote?.total > 0, `client booked a ride ($${booking.quote.total})`);
  const board = await call("/api/requests");
  ok(board.some((r) => r.id === booking.request.id && r.source === "client"), `client booking lands on dispatch board (source=client)`);
  const track = await call(`/api/client/request/${booking.request.id}`);
  ok(track.status === "quoted" && track.dropoff === "LaGuardia", `client can track status (${track.status})`);

  // Concierge: a passenger requests a non-transport service; operator sets a fee.
  const conc = await call(`/api/client/concierge`, {
    method: "POST",
    body: JSON.stringify({ client_name: "Mr. Alvarez", request: "Table for 4 at Carbone Friday 8pm, quiet booth", when: "Fri 8pm" }),
  });
  ok(conc.request?.type === "concierge" && conc.request.quote_amount == null, `concierge request created (no auto-quote)`);
  const priced = await call(`/api/requests/${conc.request.id}/fee`, { method: "POST", body: JSON.stringify({ amount: 250 }) });
  ok(priced.quote_amount === 250, `operator set concierge service fee ($${priced.quote_amount})`);
  const ctrack = await call(`/api/client/request/${conc.request.id}`);
  ok(ctrack.type === "concierge" && ctrack.request.includes("Carbone"), `passenger tracks concierge request`);

  const flight = await call(`/api/flight/${parsed.flight}`);
  ok(flight.flight === "DL472" && flight.status, `flight status: ${flight.status} (${flight.source})`);

  await call(`/api/requests/${req.id}/enroute`, { method: "POST" });
  const done = await call(`/api/requests/${req.id}/complete`, { method: "POST" });
  ok(done.request.status === "completed", `lifecycle completed`);
  ok(done.payment.status === "succeeded", `fare captured via ${done.payment.provider} (fee $${done.payment.platformFee})`);
  ok(done.payment.driverShare > 0 && done.payment.driverShare < req.quote_amount,
     `driver settled $${done.payment.driverShare} of $${req.quote_amount} fare (net $${done.payment.operatorNet})`);

  const all = await call("/api/requests");
  const persisted = all.find((r) => r.id === req.id);
  ok(persisted && persisted.audit_log.length >= 4, `audit trail persisted (${persisted.audit_log.length} entries)`);

  // Client memory: repeat bookings build a profile with trips + preferences.
  const clientsList = await call("/api/clients");
  const park = clientsList.find((c) => c.name === "Ms. Park");
  ok(park && park.trips >= 1, `client remembered from booking (${park.name}, ${park.trips} trip)`);
  const booking2 = await call(`/api/client/request`, {
    method: "POST",
    body: JSON.stringify({ client_name: "Ms. Park", pickup: "SoHo", dropoff: "Newark", vehicle: "SUV" }),
  });
  ok(booking2.request.client_id === park.id, `repeat booking linked to same client profile`);
  await call(`/api/clients/${park.id}/prefs`, { method: "POST", body: JSON.stringify({ preferences: "Texts only · 15 min buffer" }) });
  const { client_profile } = await call("/api/parse", {
    method: "POST",
    body: JSON.stringify({ text: "Sedan for Ms. Park to the airport tomorrow 9am" }),
  });
  ok(client_profile && client_profile.preferences.includes("Texts only") && client_profile.trips >= 2,
     `AI intake recognizes repeat client (★ ${client_profile.trips} trips, prefs shown)`);

  // AI-drafted client message (template fallback with no key).
  const draft = await call(`/api/requests/${req.id}/draft`, { method: "POST" });
  ok(draft.text.includes("Fixr") && draft.text.length > 40, `client message drafted (${draft.engine})`);

  // Today dashboard.
  const stats = await call("/api/stats");
  ok(stats.today.trips >= 3 && stats.today.captured >= req.quote_amount,
     `stats: ${stats.today.trips} trips today, $${stats.today.captured} captured, $${stats.today.driver_paid} to drivers`);

  // Live updates: SSE stream delivers a request.created event.
  const ac = new AbortController();
  const sse = await fetch(base + "/api/events", { signal: ac.signal, headers: { Accept: "text/event-stream" } });
  const reader = sse.body.getReader();
  const sawEvent = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("request.created")) return true;
    }
  })();
  await call("/api/requests", { method: "POST", body: JSON.stringify({ parsed: { ...parsed, client: "Mr. SSE" }, source: "test" }) });
  const gotLive = await Promise.race([sawEvent, new Promise((r) => setTimeout(() => r(false), 4000))]);
  ac.abort();
  ok(gotLive, `SSE live update received (request.created)`);

  // Demo seed refuses when the board already has data (protects real data).
  const seedTry = await fetch(base + "/api/demo/seed", { method: "POST" });
  ok(seedTry.status === 409, `demo seed refuses on a non-empty board (409)`);

  // Phone capture + SMS notifications (log mode without Twilio keys).
  const phoneBooking = await call(`/api/client/request`, {
    method: "POST",
    body: JSON.stringify({ client_name: "Mr. Grant", phone: "+1 917 555 0142", pickup: "Tribeca", dropoff: "EWR" }),
  });
  await call(`/api/requests/${phoneBooking.request.id}/confirm`, { method: "POST" });
  await new Promise((r) => setTimeout(r, 250)); // notify is fire-and-forget
  const clientsNow = await call("/api/clients");
  ok(clientsNow.find((c) => c.name === "Mr. Grant")?.phone === "+1 917 555 0142", `client phone captured from booking`);
  const feed = await call("/api/notifications");
  const note = feed.find((n) => n.request_id === phoneBooking.request.id);
  ok(note && /confirmed/i.test(note.body) && note.recipient.includes("917"),
     `client notification composed + recorded (${note.channel}/${note.status})`);

  // Driver-scoped lifecycle (works even when the console is locked).
  const d2 = drivers[1];
  await call(`/api/requests/${phoneBooking.request.id}/assign`, { method: "POST", body: JSON.stringify({ resource_id: d2.id }) });
  const dEn = await call(`/api/driver/${d2.id}/trips/${phoneBooking.request.id}/enroute`, { method: "POST" });
  ok(dEn.status === "in_progress", `driver-scoped enroute`);
  const wrongDriver = await fetch(base + `/api/driver/${drivers[2].id}/trips/${phoneBooking.request.id}/complete`, { method: "POST" });
  ok(wrongDriver.status === 404, `another driver cannot touch the trip (404)`);
  const dDone = await call(`/api/driver/${d2.id}/trips/${phoneBooking.request.id}/complete`, { method: "POST" });
  ok(dDone.request.status === "completed" && dDone.payment.status === "succeeded", `driver-scoped complete + settlement`);

  // Preference-aware intake: saved vehicle preference auto-applies.
  const grant = (await call("/api/clients")).find((c) => c.name === "Mr. Grant");
  await call(`/api/clients/${grant.id}/prefs`, { method: "POST", body: JSON.stringify({ preferences: "Prefers Escalade, no small talk" }) });
  const prefParse = await call("/api/parse", { method: "POST", body: JSON.stringify({ text: "Car for Mr. Grant to JFK tomorrow 8am" }) });
  ok(prefParse.parsed.vehicle === "Cadillac Escalade" && prefParse.parsed._vehicle_auto === true,
     `saved preference auto-selects vehicle (${prefParse.parsed.vehicle})`);
  ok(prefParse.quote.total > 0 && prefParse.quote.lines.some((l) => l[0].includes("1.45")),
     `auto-selected vehicle priced with its multiplier ($${prefParse.quote.total})`);

  // Vendor rolodex.
  const vendor = await call("/api/vendors", { method: "POST", body: JSON.stringify({ name: "Carbone", category: "dining", contact: "maitre d'", notes: "corner booths" }) });
  const vendorsNow = await call("/api/vendors");
  ok(vendor.id && vendorsNow.some((v) => v.name === "Carbone"), `vendor rolodex create + list`);

  // Owner digest (template mode without a key).
  const digest = await call("/api/digest");
  ok(digest.text.includes("$") && digest.text.includes("Fixr"), `owner digest written (${digest.engine})`);

  // Operator auth: locks the console APIs when OPERATOR_KEY is set.
  process.env.OPERATOR_KEY = "test-key-123";
  const locked = await fetch(base + "/api/requests");
  ok(locked.status === 401, `console APIs lock when OPERATOR_KEY is set (401)`);
  const unlocked = await fetch(base + "/api/requests", { headers: { "x-operator-key": "test-key-123" } });
  ok(unlocked.status === 200, `operator key unlocks (200)`);
  const driverStill = await fetch(base + `/api/driver/${d2.id}/trips`);
  ok(driverStill.status === 200, `driver app unaffected by console lock`);
  const passengerStill = await fetch(base + `/api/client/request/${phoneBooking.request.id}`);
  ok(passengerStill.status === 200, `passenger tracking unaffected by console lock`);
  delete process.env.OPERATOR_KEY;

  const health = await call("/api/health");
  ok(health.notify === "log" && health.auth === "open", `health reports notify=${health.notify} auth=${health.auth}`);

  console.log(`\n${passed} checks passed`);
} catch (e) {
  console.error("\n✗ FAILED:", e.message);
  process.exitCode = 1;
} finally {
  server.close();
}
