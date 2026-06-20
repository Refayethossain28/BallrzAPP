// Persistence layer — Node's built-in SQLite (no native build step).
// The polymorphic `requests` table is the heart of the model: a ride is
// type='transfer', a concierge task is type='concierge' — same table.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.VANTAGE_DB || join(here, "vantage.db");

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tier TEXT DEFAULT 'standard',
    preferences TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'driver',
    name TEXT NOT NULL,
    phone TEXT,
    vehicle TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    stripe_account_id TEXT               -- Connect account for driver settlement
  );

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    client_name TEXT,
    type TEXT NOT NULL,                 -- transfer | hourly | airport | concierge
    status TEXT NOT NULL DEFAULT 'quoted',
    source TEXT DEFAULT 'manual',
    raw_inbound_text TEXT,
    parsed_payload TEXT DEFAULT '{}',   -- JSON: pickup, dropoff, flight, vehicle...
    quote_amount INTEGER,
    sla_due_at TEXT,
    assigned_resource_id TEXT,
    audit_log TEXT DEFAULT '[]',        -- JSON array of {t, action, actor}
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    provider TEXT,                      -- 'stripe' | 'mock'
    provider_ref TEXT,                  -- payment_intent id
    amount INTEGER,
    platform_fee REAL,                  -- Vantage take-rate
    driver_share INTEGER,               -- settled to the driver (Connect transfer)
    transfer_ref TEXT,                  -- Connect transfer id
    status TEXT,
    created_at TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();

/* ---------- resources (drivers) ---------- */
export function listResources() {
  return db.prepare(`SELECT * FROM resources ORDER BY name`).all();
}
export function setResourceStatus(id, status) {
  db.prepare(`UPDATE resources SET status=? WHERE id=?`).run(status, id);
}

/* ---------- requests ---------- */
export function createRequest({ type, client_name, source, raw, parsed, quote_amount, sla_minutes }) {
  const id = "R" + randomUUID().slice(0, 8);
  const sla = sla_minutes != null
    ? new Date(Date.now() + sla_minutes * 60000).toISOString()
    : null;
  const audit = [{ t: now(), action: `created via ${source}`, actor: "system" }];
  db.prepare(`
    INSERT INTO requests
      (id, client_name, type, status, source, raw_inbound_text, parsed_payload,
       quote_amount, sla_due_at, audit_log, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, client_name || "New client", type, "quoted", source,
    raw || "", JSON.stringify(parsed || {}),
    quote_amount ?? null, sla, JSON.stringify(audit), now()
  );
  return getRequest(id);
}

export function getRequest(id) {
  const row = db.prepare(`SELECT * FROM requests WHERE id=?`).get(id);
  return row ? hydrate(row) : null;
}

export function listRequests() {
  return db.prepare(`SELECT * FROM requests ORDER BY created_at DESC`).all().map(hydrate);
}

export function appendAudit(id, action, actor = "operator") {
  const row = db.prepare(`SELECT audit_log FROM requests WHERE id=?`).get(id);
  if (!row) return;
  const log = JSON.parse(row.audit_log);
  log.push({ t: now(), action, actor });
  db.prepare(`UPDATE requests SET audit_log=? WHERE id=?`).run(JSON.stringify(log), id);
}

export function setStatus(id, status, action) {
  db.prepare(`UPDATE requests SET status=? WHERE id=?`).run(status, id);
  if (action) appendAudit(id, action);
  return getRequest(id);
}

export function assignResource(id, resourceId) {
  const r = db.prepare(`SELECT * FROM resources WHERE id=?`).get(resourceId);
  if (!r) throw new Error("resource not found");
  db.prepare(`UPDATE requests SET assigned_resource_id=?, status='assigned' WHERE id=?`)
    .run(resourceId, id);
  setResourceStatus(resourceId, "on_trip");
  appendAudit(id, `assigned to ${r.name} · driver app notified`);
  return getRequest(id);
}

export function recordPayment({ request_id, provider, provider_ref, amount, platform_fee, driver_share, transfer_ref, status }) {
  const id = "PAY" + randomUUID().slice(0, 8);
  db.prepare(`
    INSERT INTO payments
      (id, request_id, provider, provider_ref, amount, platform_fee, driver_share, transfer_ref, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(id, request_id, provider, provider_ref || null, amount ?? null,
        platform_fee ?? null, driver_share ?? null, transfer_ref || null, status, now());
  return id;
}

export function getResource(id) {
  return db.prepare(`SELECT * FROM resources WHERE id=?`).get(id) || null;
}

function hydrate(row) {
  return {
    ...row,
    parsed_payload: safeParse(row.parsed_payload, {}),
    audit_log: safeParse(row.audit_log, []),
  };
}
function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/* ---------- seed ---------- */
export function seedIfEmpty() {
  const count = db.prepare(`SELECT COUNT(*) c FROM resources`).get().c;
  if (count > 0) return;
  const drivers = [
    ["d1", "Marcus Hale", "Cadillac Escalade"],
    ["d2", "Sofia Reyes", "Mercedes S-Class"],
    ["d3", "Daniel Cho", "Sprinter Executive"],
  ];
  const ins = db.prepare(`INSERT INTO resources (id,type,name,vehicle,status) VALUES (?,?,?,?,?)`);
  for (const [id, name, vehicle] of drivers) ins.run(id, "driver", name, vehicle, "available");
}

// `node db.js --seed` for a fresh dataset
if (process.argv[1] && process.argv[1].endsWith("db.js") && process.argv.includes("--seed")) {
  seedIfEmpty();
  console.log("Seeded drivers:", listResources().map((r) => r.name).join(", "));
}
