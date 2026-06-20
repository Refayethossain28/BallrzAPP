// Postgres backend — same async interface as db-sqlite.js. Selected when
// DATABASE_URL is set. Multi-instance safe (connection pool, shared DB).

import pg from "pg";
import { randomUUID } from "node:crypto";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const now = () => new Date().toISOString();
const q = (text, params) => pool.query(text, params);

export async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'driver', name TEXT NOT NULL,
      phone TEXT, vehicle TEXT, status TEXT NOT NULL DEFAULT 'available',
      stripe_account_id TEXT, last_lat DOUBLE PRECISION, last_lng DOUBLE PRECISION, last_ping_at TEXT
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, client_id TEXT, client_name TEXT, type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'quoted', source TEXT DEFAULT 'manual',
      raw_inbound_text TEXT, parsed_payload TEXT DEFAULT '{}', quote_amount INTEGER,
      sla_due_at TEXT, assigned_resource_id TEXT, audit_log TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, provider TEXT, provider_ref TEXT,
      amount INTEGER, platform_fee DOUBLE PRECISION, driver_share INTEGER, transfer_ref TEXT,
      status TEXT, created_at TEXT NOT NULL
    )`);
}

export async function seedIfEmpty() {
  const { rows } = await q(`SELECT COUNT(*)::int c FROM resources`);
  if (rows[0].c > 0) return;
  const drivers = [
    ["d1", "Marcus Hale", "Cadillac Escalade"],
    ["d2", "Sofia Reyes", "Mercedes S-Class"],
    ["d3", "Daniel Cho", "Sprinter Executive"],
  ];
  for (const [id, name, vehicle] of drivers)
    await q(`INSERT INTO resources (id,type,name,vehicle,status) VALUES ($1,$2,$3,$4,$5)`, [id, "driver", name, vehicle, "available"]);
}

export async function listResources() { return (await q(`SELECT * FROM resources ORDER BY name`)).rows; }
export async function getResource(id) { return (await q(`SELECT * FROM resources WHERE id=$1`, [id])).rows[0] || null; }
export async function setResourceStatus(id, status) { await q(`UPDATE resources SET status=$1 WHERE id=$2`, [status, id]); }
export async function setResourceConnect(id, accountId) { await q(`UPDATE resources SET stripe_account_id=$1 WHERE id=$2`, [accountId, id]); return getResource(id); }
export async function setResourceLocation(id, lat, lng) {
  await q(`UPDATE resources SET last_lat=$1, last_lng=$2, last_ping_at=$3 WHERE id=$4`, [lat, lng, now(), id]);
}

export async function createRequest({ type, client_name, source, raw, parsed, quote_amount, sla_minutes }) {
  const id = "R" + randomUUID().slice(0, 8);
  const sla = sla_minutes != null ? new Date(Date.now() + sla_minutes * 60000).toISOString() : null;
  const audit = [{ t: now(), action: `created via ${source}`, actor: "system" }];
  await q(`INSERT INTO requests
      (id, client_name, type, status, source, raw_inbound_text, parsed_payload, quote_amount, sla_due_at, audit_log, created_at)
      VALUES ($1,$2,$3,'quoted',$4,$5,$6,$7,$8,$9,$10)`,
    [id, client_name || "New client", type, source, raw || "", JSON.stringify(parsed || {}),
     quote_amount ?? null, sla, JSON.stringify(audit), now()]);
  return getRequest(id);
}

export async function getRequest(id) {
  const row = (await q(`SELECT * FROM requests WHERE id=$1`, [id])).rows[0];
  return row ? hydrate(row) : null;
}
export async function listRequests() { return (await q(`SELECT * FROM requests ORDER BY created_at DESC`)).rows.map(hydrate); }
export async function listRequestsForDriver(driverId) {
  return (await q(`SELECT * FROM requests WHERE assigned_resource_id=$1 AND status IN ('assigned','in_progress') ORDER BY created_at DESC`, [driverId])).rows.map(hydrate);
}

export async function appendAudit(id, action, actor = "operator") {
  const row = (await q(`SELECT audit_log FROM requests WHERE id=$1`, [id])).rows[0];
  if (!row) return;
  const log = safe(row.audit_log, []); log.push({ t: now(), action, actor });
  await q(`UPDATE requests SET audit_log=$1 WHERE id=$2`, [JSON.stringify(log), id]);
}
export async function setStatus(id, status, action) {
  await q(`UPDATE requests SET status=$1 WHERE id=$2`, [status, id]);
  if (action) await appendAudit(id, action);
  return getRequest(id);
}
export async function assignResource(id, resourceId) {
  const r = await getResource(resourceId);
  if (!r) throw new Error("resource not found");
  await q(`UPDATE requests SET assigned_resource_id=$1, status='assigned' WHERE id=$2`, [resourceId, id]);
  await setResourceStatus(resourceId, "on_trip");
  await appendAudit(id, `assigned to ${r.name} · driver app notified`);
  return getRequest(id);
}
export async function recordPayment(p) {
  const id = "PAY" + randomUUID().slice(0, 8);
  await q(`INSERT INTO payments
      (id, request_id, provider, provider_ref, amount, platform_fee, driver_share, transfer_ref, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, p.request_id, p.provider, p.provider_ref || null, p.amount ?? null,
     p.platform_fee ?? null, p.driver_share ?? null, p.transfer_ref || null, p.status, now()]);
  return id;
}

function hydrate(row) {
  return { ...row, parsed_payload: safe(row.parsed_payload, {}), audit_log: safe(row.audit_log, []) };
}
function safe(s, fb) { try { return typeof s === "string" ? JSON.parse(s) : (s ?? fb); } catch { return fb; } }
