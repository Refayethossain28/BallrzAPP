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
  await q(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      tier TEXT DEFAULT 'standard', preferences TEXT DEFAULT '', phone TEXT DEFAULT '',
      created_at TEXT NOT NULL, last_seen_at TEXT
    )`);
  await q(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT ''`);
  await q(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, request_id TEXT, recipient TEXT, channel TEXT,
      body TEXT, status TEXT, created_at TEXT NOT NULL
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS vendors (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT '',
      contact TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT NOT NULL
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

/* ---------- clients (the memory layer) ---------- */
const GENERIC_NAMES = /^(new client|guest|client|customer)$/i;

export async function findOrCreateClient(name, phone) {
  const clean = (name || "").trim();
  if (!clean || GENERIC_NAMES.test(clean)) return null;
  const key = clean.toLowerCase();
  const ph = (phone || "").trim();
  let c = (await q(`SELECT * FROM clients WHERE name_key=$1`, [key])).rows[0];
  if (!c) {
    const id = "C" + randomUUID().slice(0, 8);
    await q(`INSERT INTO clients (id, name, name_key, phone, created_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (name_key) DO NOTHING`, [id, clean, key, ph, now(), now()]);
    c = (await q(`SELECT * FROM clients WHERE name_key=$1`, [key])).rows[0];
  } else {
    await q(`UPDATE clients SET last_seen_at=$1, phone=CASE WHEN $2<>'' THEN $2 ELSE phone END WHERE id=$3`,
      [now(), ph, c.id]);
    c = (await q(`SELECT * FROM clients WHERE id=$1`, [c.id])).rows[0];
  }
  return c;
}

/* ---------- notifications ---------- */
export async function recordNotification({ request_id, recipient, channel, body, status }) {
  const id = "N" + randomUUID().slice(0, 8);
  await q(`INSERT INTO notifications (id, request_id, recipient, channel, body, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, request_id || null, recipient || "", channel, body, status, now()]);
  return id;
}
export async function listNotifications(limit = 30) {
  return (await q(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT $1`, [limit])).rows;
}

/* ---------- vendors (concierge rolodex) ---------- */
export async function createVendor({ name, category, contact, notes }) {
  const id = "V" + randomUUID().slice(0, 8);
  await q(`INSERT INTO vendors (id, name, category, contact, notes, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, name, category || "", contact || "", notes || "", now()]);
  return (await q(`SELECT * FROM vendors WHERE id=$1`, [id])).rows[0];
}
export async function listVendors() {
  return (await q(`SELECT * FROM vendors ORDER BY name`)).rows;
}
export async function updateVendor(id, { name, category, contact, notes }) {
  const v = (await q(`SELECT * FROM vendors WHERE id=$1`, [id])).rows[0];
  if (!v) return null;
  await q(`UPDATE vendors SET name=$1, category=$2, contact=$3, notes=$4 WHERE id=$5`,
    [name ?? v.name, category ?? v.category, contact ?? v.contact, notes ?? v.notes, id]);
  return (await q(`SELECT * FROM vendors WHERE id=$1`, [id])).rows[0];
}

export async function getClientByName(name) {
  const key = (name || "").trim().toLowerCase();
  if (!key || GENERIC_NAMES.test(key)) return null;
  const c = (await q(`SELECT * FROM clients WHERE name_key=$1`, [key])).rows[0];
  return c ? withClientStats(c) : null;
}

export async function listClients() {
  const { rows } = await q(`SELECT * FROM clients ORDER BY last_seen_at DESC`);
  return Promise.all(rows.map(withClientStats));
}

export async function updateClientPrefs(id, preferences) {
  await q(`UPDATE clients SET preferences=$1 WHERE id=$2`, [preferences || "", id]);
  const c = (await q(`SELECT * FROM clients WHERE id=$1`, [id])).rows[0];
  return c ? withClientStats(c) : null;
}

async function withClientStats(c) {
  const s = (await q(
    `SELECT COUNT(*)::int trips, COALESCE(SUM(quote_amount),0)::int spend FROM requests WHERE client_id=$1`, [c.id]
  )).rows[0];
  return { ...c, trips: s.trips, spend: s.spend };
}

/* ---------- stats ---------- */
export async function getStats() {
  const dayStart = new Date().toISOString().slice(0, 10);
  const r = (await q(`SELECT COUNT(*)::int trips, COALESCE(SUM(quote_amount),0)::int booked,
      COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0)::int completed
      FROM requests WHERE created_at >= $1`, [dayStart])).rows[0];
  const p = (await q(`SELECT COALESCE(SUM(amount),0)::int captured, COALESCE(SUM(driver_share),0)::int driver_paid,
      COALESCE(SUM(platform_fee),0)::float platform_fees
      FROM payments WHERE status='succeeded' AND created_at >= $1`, [dayStart])).rows[0];
  const open = (await q(`SELECT COUNT(*)::int c FROM requests WHERE status != 'completed'`)).rows[0].c;
  return { today: { ...r, ...p }, open_requests: open };
}

export async function createRequest({ type, client_name, client_id, source, raw, parsed, quote_amount, sla_minutes }) {
  const id = "R" + randomUUID().slice(0, 8);
  const sla = sla_minutes != null ? new Date(Date.now() + sla_minutes * 60000).toISOString() : null;
  const audit = [{ t: now(), action: `created via ${source}`, actor: "system" }];
  await q(`INSERT INTO requests
      (id, client_id, client_name, type, status, source, raw_inbound_text, parsed_payload, quote_amount, sla_due_at, audit_log, created_at)
      VALUES ($1,$2,$3,$4,'quoted',$5,$6,$7,$8,$9,$10,$11)`,
    [id, client_id || null, client_name || "New client", type, source, raw || "", JSON.stringify(parsed || {}),
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
export async function setQuote(id, amount) {
  await q(`UPDATE requests SET quote_amount=$1 WHERE id=$2`, [amount, id]);
  await appendAudit(id, `service fee set to $${amount}`);
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
