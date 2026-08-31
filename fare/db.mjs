/**
 * fare/db.mjs — SQLite persistence for Fare, on Node's built-in node:sqlite
 * (zero dependencies, Node 22+). All money columns are integer pence; all
 * business rules live in public/engine.js — this file only stores and loads.
 *
 * The DB path comes from the caller (server reads FARE_DB_PATH), so hosting
 * with a mounted persistent disk is a one-env-var change.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      terms_days INTEGER NOT NULL DEFAULT 14,
      wait_rate INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      date TEXT NOT NULL,
      time TEXT NOT NULL DEFAULT '',
      pickup TEXT NOT NULL DEFAULT '',
      dropoff TEXT NOT NULL DEFAULT '',
      fare INTEGER NOT NULL DEFAULT 0,
      wait_minutes INTEGER NOT NULL DEFAULT 0,
      wait_rate INTEGER NOT NULL DEFAULT 0,
      extras TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      invoice_id INTEGER REFERENCES invoices(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_client_date ON jobs(client_id, date);
    CREATE INDEX IF NOT EXISTS idx_jobs_invoice ON jobs(invoice_id);
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER NOT NULL UNIQUE,
      display_number TEXT NOT NULL,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      period TEXT NOT NULL,
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      paid_date TEXT,
      subtotal INTEGER NOT NULL,
      vat_rate REAL NOT NULL DEFAULT 0,
      vat_amount INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`INSERT OR IGNORE INTO settings (id, json) VALUES (1, '{}')`);
  return db;
}

const nowIso = () => new Date().toISOString();

/* ── settings ── */

export function getSettings(db) {
  const row = db.prepare('SELECT json FROM settings WHERE id = 1').get();
  try { return JSON.parse(row?.json || '{}'); } catch { return {}; }
}

export function saveSettings(db, obj) {
  db.prepare('UPDATE settings SET json = ? WHERE id = 1').run(JSON.stringify(obj));
}

/* ── clients ── */

const clientRow = (r) => r && {
  id: r.id, name: r.name, email: r.email, address: r.address,
  termsDays: r.terms_days, waitRate: r.wait_rate, notes: r.notes, archived: !!r.archived,
};

export function listClients(db, { includeArchived = false } = {}) {
  const rows = db.prepare(
    `SELECT * FROM clients ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY name COLLATE NOCASE`
  ).all();
  return rows.map(clientRow);
}

export function getClient(db, id) {
  return clientRow(db.prepare('SELECT * FROM clients WHERE id = ?').get(id));
}

export function createClient(db, c) {
  const r = db.prepare(
    `INSERT INTO clients (name, email, address, terms_days, wait_rate, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(c.name, c.email, c.address, c.termsDays, c.waitRate, c.notes, nowIso());
  return getClient(db, Number(r.lastInsertRowid));
}

export function updateClient(db, id, c) {
  db.prepare(
    `UPDATE clients SET name = ?, email = ?, address = ?, terms_days = ?, wait_rate = ?, notes = ? WHERE id = ?`
  ).run(c.name, c.email, c.address, c.termsDays, c.waitRate, c.notes, id);
  return getClient(db, id);
}

export function setClientArchived(db, id, archived) {
  db.prepare('UPDATE clients SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  return getClient(db, id);
}

/* ── jobs ── */

const jobRow = (r) => {
  if (!r) return null;
  let extras = [];
  try { extras = JSON.parse(r.extras || '[]'); } catch { /* tolerate */ }
  return {
    id: r.id, clientId: r.client_id, date: r.date, time: r.time,
    pickup: r.pickup, dropoff: r.dropoff, fare: r.fare,
    waitMinutes: r.wait_minutes, waitRate: r.wait_rate,
    extras, notes: r.notes, invoiceId: r.invoice_id,
  };
};

export function listJobs(db, { clientId, month, uninvoiced, limit = 1000 } = {}) {
  const where = [], args = [];
  if (clientId) { where.push('client_id = ?'); args.push(clientId); }
  if (month) { where.push("substr(date, 1, 7) = ?"); args.push(month); }
  if (uninvoiced) where.push('invoice_id IS NULL');
  const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY date DESC, time DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map(jobRow);
}

export function getJob(db, id) {
  return jobRow(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
}

export function createJob(db, j) {
  const r = db.prepare(
    `INSERT INTO jobs (client_id, date, time, pickup, dropoff, fare, wait_minutes, wait_rate, extras, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(j.clientId, j.date, j.time, j.pickup, j.dropoff, j.fare, j.waitMinutes, j.waitRate,
    JSON.stringify(j.extras), j.notes, nowIso());
  return getJob(db, Number(r.lastInsertRowid));
}

export function updateJob(db, id, j) {
  db.prepare(
    `UPDATE jobs SET client_id = ?, date = ?, time = ?, pickup = ?, dropoff = ?, fare = ?,
     wait_minutes = ?, wait_rate = ?, extras = ?, notes = ? WHERE id = ?`
  ).run(j.clientId, j.date, j.time, j.pickup, j.dropoff, j.fare, j.waitMinutes, j.waitRate,
    JSON.stringify(j.extras), j.notes, id);
  return getJob(db, id);
}

export function deleteJob(db, id) {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

/* ── invoices ── */

const invoiceRow = (r) => {
  if (!r) return null;
  let snapshot = {};
  try { snapshot = JSON.parse(r.snapshot || '{}'); } catch { /* tolerate */ }
  return {
    id: r.id, number: r.number, displayNumber: r.display_number, clientId: r.client_id,
    period: r.period, issueDate: r.issue_date, dueDate: r.due_date,
    status: r.status, paidDate: r.paid_date,
    subtotal: r.subtotal, vatRatePct: r.vat_rate, vatAmount: r.vat_amount, total: r.total,
    snapshot,
  };
};

export function listInvoices(db) {
  return db.prepare('SELECT * FROM invoices ORDER BY number DESC').all().map(invoiceRow);
}

export function getInvoice(db, id) {
  return invoiceRow(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id));
}

// Insert the invoice, claim its jobs, and bump the sequential counter — one
// transaction, so numbers can never be double-issued.
export function createInvoice(db, inv, jobIds, settings) {
  db.exec('BEGIN');
  try {
    const r = db.prepare(
      `INSERT INTO invoices (number, display_number, client_id, period, issue_date, due_date, status,
        subtotal, vat_rate, vat_amount, total, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(inv.number, inv.displayNumber, inv.clientId, inv.period, inv.issueDate, inv.dueDate,
      inv.status, inv.subtotal, inv.vatRatePct, inv.vatAmount, inv.total,
      JSON.stringify(inv.snapshot), nowIso());
    const invoiceId = Number(r.lastInsertRowid);
    const claim = db.prepare('UPDATE jobs SET invoice_id = ? WHERE id = ? AND invoice_id IS NULL');
    for (const jobId of jobIds) {
      const res = claim.run(invoiceId, jobId);
      if (Number(res.changes) !== 1) throw new Error(`job ${jobId} is already invoiced`);
    }
    settings.nextNumber = inv.number + 1;
    saveSettings(db, settings);
    db.exec('COMMIT');
    return getInvoice(db, invoiceId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function setInvoiceStatus(db, id, status, paidDate) {
  db.prepare('UPDATE invoices SET status = ?, paid_date = ? WHERE id = ?')
    .run(status, paidDate || null, id);
  return getInvoice(db, id);
}

// Voiding releases the jobs so they can be re-invoiced (e.g. after a fix).
// The used number is not recycled — a gap is honest; a duplicate is not.
export function voidInvoice(db, id) {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE jobs SET invoice_id = NULL WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ── backup / restore (v1 safety net; also the v2 migration seam) ── */

export function dumpAll(db) {
  return {
    fareBackup: 1,
    exportedAt: nowIso(),
    settings: getSettings(db),
    clients: db.prepare('SELECT * FROM clients ORDER BY id').all(),
    jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
    invoices: db.prepare('SELECT * FROM invoices ORDER BY id').all(),
  };
}

export function restoreAll(db, dump) {
  if (!dump || dump.fareBackup !== 1) throw new Error('not a Fare backup file');
  const cols = (rows) => Object.keys(rows[0] || {});
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM jobs; DELETE FROM invoices; DELETE FROM clients;');
    for (const table of ['clients', 'invoices', 'jobs']) { // parents before jobs
      const rows = dump[table] || [];
      if (!rows.length) continue;
      const names = cols(rows);
      const stmt = db.prepare(
        `INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`
      );
      for (const row of rows) stmt.run(...names.map((n) => row[n] ?? null));
    }
    saveSettings(db, dump.settings || {});
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
