// End-to-end smoke test against the real server: boot it, drive a request
// through the full lifecycle, assert persistence + payment. No secrets needed
// (intake falls back to the heuristic parser, payments to a mock capture).
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VANTAGE_DB = join(mkdtempSync(join(tmpdir(), "vantage-")), "t.db");
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
  ok(h.ok, `health: intake=${h.intake} payments=${h.payments}`);

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

  console.log(`\n${passed} checks passed`);
} catch (e) {
  console.error("\n✗ FAILED:", e.message);
  process.exitCode = 1;
} finally {
  server.close();
}
