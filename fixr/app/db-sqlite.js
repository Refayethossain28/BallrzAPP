// SQLite backend (Node built-in node:sqlite). Default store for dev/demo.
// All functions are async to match the Postgres backend's interface, even
// though node:sqlite itself is synchronous.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.FIXR_DB || join(here, "fixr.db");
const db = new DatabaseSync(DB_PATH);
const now = () => new Date().toISOString();

export async function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'driver', name TEXT NOT NULL,
      phone TEXT, vehicle TEXT, status TEXT NOT NULL DEFAULT 'available',
      stripe_account_id TEXT, last_lat REAL, last_lng REAL, last_ping_at TEXT
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, client_id TEXT, client_name TEXT, type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'quoted', source TEXT DEFAULT 'manual',
      raw_inbound_text TEXT, parsed_payload TEXT DEFAULT '{}', quote_amount INTEGER,
      sla_due_at TEXT, assigned_resource_id TEXT, audit_log TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, provider TEXT, provider_ref TEXT,
      amount INTEGER, platform_fee REAL, driver_share INTEGER, transfer_ref TEXT,
      status TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      tier TEXT DEFAULT 'standard', preferences TEXT DEFAULT '',
      created_at TEXT NOT NULL, last_seen_at TEXT
    );
  `);
}

export async function seedIfEmpty() {
  if (db.prepare(`SELECT COUNT(*) c FROM resources`).get().c > 0) return;
  const drivers = [
    ["d1", "Marcus Hale", "Cadillac Escalade"],
    ["d2", "Sofia Reyes", "Mercedes S-Class"],
    ["d3", "Daniel Cho", "Sprinter Executive"],
  ];
  const ins = db.prepare(`INSERT INTO resources (id,type,name,vehicle,status) VALUES (?,?,?,?,?)`);
  for (const [id, name, vehicle] of drivers) ins.run(id, "driver", name, vehicle, "available");
}

export async function listResources() { return db.prepare(`SELECT * FROM resources ORDER BY name`).all(); }
export async function getResource(id) { return db.prepare(`SELECT * FROM resources WHERE id=?`).get(id) || null; }
export async function setResourceStatus(id, status) { db.prepare(`UPDATE resources SET status=? WHERE id=?`).run(status, id); }
export async function setResourceConnect(id, accountId) { db.prepare(`UPDATE resources SET stripe_account_id=? WHERE id=?`).run(accountId, id); return getResource(id); }
export async function setResourceLocation(id, lat, lng) {
  db.prepare(`UPDATE resources SET last_lat=?, last_lng=?, last_ping_at=? WHERE id=?`).run(lat, lng, now(), id);
}

/* ---------- clients (the memory layer) ---------- */
const GENERIC_NAMES = /^(new client|guest|client|customer)$/i;

export async function findOrCreateClient(name) {
  const clean = (name || "").trim();
  if (!clean || GENERIC_NAMES.test(clean)) return null;
  const key = clean.toLowerCase();
  let c = db.prepare(`SELECT * FROM clients WHERE name_key=?`).get(key);
  if (!c) {
    const id = "C" + randomUUID().slice(0, 8);
    db.prepare(`INSERT INTO clients (id, name, name_key, created_at, last_seen_at) VALUES (?,?,?,?,?)`)
      .run(id, clean, key, now(), now());
    c = db.prepare(`SELECT * FROM clients WHERE id=?`).get(id);
  } else {
    db.prepare(`UPDATE clients SET last_seen_at=? WHERE id=?`).run(now(), c.id);
  }
  return c;
}

export async function getClientByName(name) {
  const key = (name || "").trim().toLowerCase();
  if (!key || GENERIC_NAMES.test(key)) return null;
  const c = db.prepare(`SELECT * FROM clients WHERE name_key=?`).get(key);
  return c ? withClientStats(c) : null;
}

export async function listClients() {
  return db.prepare(`SELECT * FROM clients ORDER BY last_seen_at DESC`).all().map(withClientStats);
}

export async function updateClientPrefs(id, preferences) {
  db.prepare(`UPDATE clients SET preferences=? WHERE id=?`).run(preferences || "", id);
  const c = db.prepare(`SELECT * FROM clients WHERE id=?`).get(id);
  return c ? withClientStats(c) : null;
}

function withClientStats(c) {
  const s = db.prepare(
    `SELECT COUNT(*) trips, COALESCE(SUM(quote_amount),0) spend FROM requests WHERE client_id=?`
  ).get(c.id);
  return { ...c, trips: s.trips, spend: s.spend };
}

/* ---------- stats ---------- */
export async function getStats() {
  const dayStart = new Date().toISOString().slice(0, 10);
  const r = db.prepare(`SELECT COUNT(*) trips, COALESCE(SUM(quote_amount),0) booked,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed
      FROM requests WHERE created_at >= ?`).get(dayStart);
  const p = db.prepare(`SELECT COALESCE(SUM(amount),0) captured, COALESCE(SUM(driver_share),0) driver_paid,
      COALESCE(SUM(platform_fee),0) platform_fees
      FROM payments WHERE status='succeeded' AND created_at >= ?`).get(dayStart);
  const open = db.prepare(`SELECT COUNT(*) c FROM requests WHERE status != 'completed'`).get().c;
  return { today: { ...r, ...p }, open_requests: open };
}

export async function createRequest({ type, client_name, client_id, source, raw, parsed, quote_amount, sla_minutes }) {
  const id = "R" + randomUUID().slice(0, 8);
  const sla = sla_minutes != null ? new Date(Date.now() + sla_minutes * 60000).toISOString() : null;
  const audit = [{ t: now(), action: `created via ${source}`, actor: "system" }];
  db.prepare(`INSERT INTO requests
      (id, client_id, client_name, type, status, source, raw_inbound_text, parsed_payload, quote_amount, sla_due_at, audit_log, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, client_id || null, client_name || "New client", type, "quoted", source, raw || "",
         JSON.stringify(parsed || {}), quote_amount ?? null, sla, JSON.stringify(audit), now());
  return getRequest(id);
}

export async function getRequest(id) {
  const row = db.prepare(`SELECT * FROM requests WHERE id=?`).get(id);
  return row ? hydrate(row) : null;
}
export async function listRequests() { return db.prepare(`SELECT * FROM requests ORDER BY created_at DESC`).all().map(hydrate); }
export async function listRequestsForDriver(driverId) {
  return db.prepare(`SELECT * FROM requests WHERE assigned_resource_id=? AND status IN ('assigned','in_progress') ORDER BY created_at DESC`)
    .all(driverId).map(hydrate);
}

export async function appendAudit(id, action, actor = "operator") {
  const row = db.prepare(`SELECT audit_log FROM requests WHERE id=?`).get(id);
  if (!row) return;
  const log = JSON.parse(row.audit_log); log.push({ t: now(), action, actor });
  db.prepare(`UPDATE requests SET audit_log=? WHERE id=?`).run(JSON.stringify(log), id);
}
export async function setStatus(id, status, action) {
  db.prepare(`UPDATE requests SET status=? WHERE id=?`).run(status, id);
  if (action) await appendAudit(id, action);
  return getRequest(id);
}
export async function assignResource(id, resourceId) {
  const r = await getResource(resourceId);
  if (!r) throw new Error("resource not found");
  db.prepare(`UPDATE requests SET assigned_resource_id=?, status='assigned' WHERE id=?`).run(resourceId, id);
  await setResourceStatus(resourceId, "on_trip");
  await appendAudit(id, `assigned to ${r.name} · driver app notified`);
  return getRequest(id);
}
export async function setQuote(id, amount) {
  db.prepare(`UPDATE requests SET quote_amount=? WHERE id=?`).run(amount, id);
  await appendAudit(id, `service fee set to $${amount}`);
  return getRequest(id);
}
export async function recordPayment(p) {
  const id = "PAY" + randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO payments
      (id, request_id, provider, provider_ref, amount, platform_fee, driver_share, transfer_ref, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, p.request_id, p.provider, p.provider_ref || null, p.amount ?? null,
         p.platform_fee ?? null, p.driver_share ?? null, p.transfer_ref || null, p.status, now());
  return id;
}

function hydrate(row) {
  return { ...row, parsed_payload: safe(row.parsed_payload, {}), audit_log: safe(row.audit_log, []) };
}
function safe(s, fb) { try { return typeof s === "string" ? JSON.parse(s) : (s ?? fb); } catch { return fb; } }
