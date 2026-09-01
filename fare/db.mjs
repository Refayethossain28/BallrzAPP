/**
 * fare/db.mjs — SQLite persistence for Fare, on Node's built-in node:sqlite
 * (zero dependencies, Node 22+). All money columns are integer pence; all
 * business rules live in public/engine.js — this file only stores and loads.
 *
 * v2 is multi-tenant: every business row carries account_id and every query
 * is scoped by it. openDb() migrates a v1 (single-user) database in place —
 * legacy rows become account 1, which the owner claims on first sign-in.
 *
 * The DB path comes from the caller (server reads FARE_DB_PATH), so hosting
 * with a mounted persistent disk is a one-env-var change.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const nowIso = () => new Date().toISOString();

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/* ─────────────────────────── schema + migration ─────────────────────────── */

const columns = (db, table) => {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }
  catch { return []; }
};

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,                -- NULL until the owner claims account 1
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'trial',   -- trial | active | past_due | canceled
      trial_ends_at TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_tokens (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      invoice_id INTEGER,
      kind TEXT NOT NULL,               -- invoice | reminder | login
      recipient TEXT NOT NULL,
      provider_id TEXT,
      sent_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_log_invoice ON email_log(invoice_id, kind);
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      terms_days INTEGER NOT NULL DEFAULT 14,
      wait_rate INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      chase_optout INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL DEFAULT 1,
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
    CREATE INDEX IF NOT EXISTS idx_jobs_invoice ON jobs(invoice_id);
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL DEFAULT 1,
      number INTEGER NOT NULL,
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
      created_at TEXT NOT NULL,
      UNIQUE (account_id, number)
    );
    CREATE TABLE IF NOT EXISTS settings (
      account_id INTEGER PRIMARY KEY,
      json TEXT NOT NULL DEFAULT '{}'
    );
  `);

  /* v1 → v2 upgrades, in place. Each check is idempotent. */

  // clients/jobs gained columns
  if (!columns(db, 'clients').includes('account_id')) {
    db.exec(`ALTER TABLE clients ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1`);
  }
  if (!columns(db, 'clients').includes('chase_optout')) {
    db.exec(`ALTER TABLE clients ADD COLUMN chase_optout INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns(db, 'jobs').includes('account_id')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1`);
  }

  // v1 invoices had a global UNIQUE(number); v2 needs UNIQUE(account_id, number)
  // — SQLite can't alter constraints, so rebuild once. jobs.invoice_id
  // references this table, so FK enforcement pauses for the rebuild (the
  // pragma is a no-op inside a transaction, hence set outside it).
  if (!columns(db, 'invoices').includes('account_id')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE invoices_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL DEFAULT 1,
          number INTEGER NOT NULL,
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
          created_at TEXT NOT NULL,
          UNIQUE (account_id, number)
        );
        INSERT INTO invoices_v2 (id, account_id, number, display_number, client_id, period,
          issue_date, due_date, status, paid_date, subtotal, vat_rate, vat_amount, total, snapshot, created_at)
        SELECT id, 1, number, display_number, client_id, period,
          issue_date, due_date, status, paid_date, subtotal, vat_rate, vat_amount, total, snapshot, created_at
        FROM invoices;
        DROP TABLE invoices;
        ALTER TABLE invoices_v2 RENAME TO invoices;
      `);
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (err) { db.exec('ROLLBACK'); db.exec('PRAGMA foreign_keys = ON'); throw err; }
  }

  // v1 settings was a singleton (id CHECK id=1); v2 keys by account_id.
  if (columns(db, 'settings').includes('id')) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE settings_v2 (account_id INTEGER PRIMARY KEY, json TEXT NOT NULL DEFAULT '{}');
        INSERT INTO settings_v2 (account_id, json) SELECT 1, json FROM settings WHERE id = 1;
        DROP TABLE settings;
        ALTER TABLE settings_v2 RENAME TO settings;
      `);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  }

  // Only now do the account_id columns exist everywhere (a v1 database gains
  // them via the ALTERs above), so the tenant index comes last.
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_account_date ON jobs(account_id, date)');

  // Legacy data with no account → account 1 exists, unclaimed (email NULL)
  // until the owner's first magic-link sign-in attaches their address.
  const hasData = db.prepare('SELECT COUNT(*) AS n FROM clients').get().n > 0 ||
    db.prepare('SELECT COUNT(*) AS n FROM settings').get().n > 0;
  const hasAccount1 = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE id = 1').get().n > 0;
  if (hasData && !hasAccount1) {
    db.prepare('INSERT INTO accounts (id, email, status, created_at) VALUES (1, NULL, ?, ?)')
      .run('trial', nowIso());
  }
}

/* ─────────────────────────────── accounts ─────────────────────────────── */

const accountRow = (r) => r && {
  id: r.id, email: r.email, name: r.name, status: r.status,
  trialEndsAt: r.trial_ends_at, stripeCustomerId: r.stripe_customer_id,
  stripeSubscriptionId: r.stripe_subscription_id, createdAt: r.created_at,
};

export function getAccount(db, id) {
  return accountRow(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
}

export function getAccountByEmail(db, email) {
  return accountRow(db.prepare('SELECT * FROM accounts WHERE email = ?').get(email));
}

export function getAccountByStripeCustomer(db, customerId) {
  return accountRow(db.prepare('SELECT * FROM accounts WHERE stripe_customer_id = ?').get(customerId));
}

// The one account door: an existing account for this email, else claim the
// unclaimed legacy account 1, else a brand-new 30-day-trial account.
export function accountForEmail(db, email, trialEndsAt) {
  const existing = getAccountByEmail(db, email);
  if (existing) return existing;
  const legacy = db.prepare('SELECT * FROM accounts WHERE id = 1 AND email IS NULL').get();
  if (legacy) {
    db.prepare('UPDATE accounts SET email = ?, trial_ends_at = COALESCE(trial_ends_at, ?) WHERE id = 1')
      .run(email, trialEndsAt);
    return getAccount(db, 1);
  }
  const r = db.prepare('INSERT INTO accounts (email, status, trial_ends_at, created_at) VALUES (?, ?, ?, ?)')
    .run(email, 'trial', trialEndsAt, nowIso());
  return getAccount(db, Number(r.lastInsertRowid));
}

// Key-based access (FARE_KEY) maps to the owner's account 1 — created lazily
// so a fresh install still works before anyone signs in.
export function ensureOwnerAccount(db) {
  if (!getAccount(db, 1)) {
    db.prepare('INSERT INTO accounts (id, email, status, created_at) VALUES (1, NULL, ?, ?)')
      .run('trial', nowIso());
  }
  return getAccount(db, 1);
}

export function updateAccountBilling(db, id, { status, stripeCustomerId, stripeSubscriptionId }) {
  db.prepare(`UPDATE accounts SET
      status = COALESCE(?, status),
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      stripe_subscription_id = COALESCE(?, stripe_subscription_id)
    WHERE id = ?`)
    .run(status ?? null, stripeCustomerId ?? null, stripeSubscriptionId ?? null, id);
  return getAccount(db, id);
}

/* ─────────────────────── sessions + login tokens ─────────────────────── */

export function createSession(db, tokenHash, accountId, expiresAt) {
  db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash, accountId, nowIso(), expiresAt);
}

export function sessionAccount(db, tokenHash, nowIsoStr) {
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
  if (!row || row.expires_at < (nowIsoStr || nowIso())) return null;
  return getAccount(db, row.account_id);
}

export function deleteSession(db, tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function createLoginToken(db, tokenHash, email, expiresAt) {
  db.prepare('INSERT INTO login_tokens (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash, email, expiresAt, nowIso());
}

// Single-use: returns the email once, then the token is burned.
export function consumeLoginToken(db, tokenHash, nowIsoStr) {
  const row = db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(tokenHash);
  if (!row || row.used || row.expires_at < (nowIsoStr || nowIso())) return null;
  db.prepare('UPDATE login_tokens SET used = 1 WHERE token_hash = ?').run(tokenHash);
  return row.email;
}

export function pruneAuth(db) {
  const cutoff = nowIso();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(cutoff);
  db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(cutoff);
}

/* ─────────────────────────────── settings ─────────────────────────────── */

export function getSettings(db, accountId) {
  const row = db.prepare('SELECT json FROM settings WHERE account_id = ?').get(accountId);
  try { return JSON.parse(row?.json || '{}'); } catch { return {}; }
}

export function saveSettings(db, accountId, obj) {
  db.prepare(`INSERT INTO settings (account_id, json) VALUES (?, ?)
    ON CONFLICT(account_id) DO UPDATE SET json = excluded.json`)
    .run(accountId, JSON.stringify(obj));
}

/* ─────────────────────────────── clients ─────────────────────────────── */

const clientRow = (r) => r && {
  id: r.id, name: r.name, email: r.email, address: r.address,
  termsDays: r.terms_days, waitRate: r.wait_rate, notes: r.notes,
  chaseOptout: !!r.chase_optout, archived: !!r.archived,
};

export function listClients(db, accountId, { includeArchived = false } = {}) {
  const rows = db.prepare(
    `SELECT * FROM clients WHERE account_id = ? ${includeArchived ? '' : 'AND archived = 0'}
     ORDER BY name COLLATE NOCASE`
  ).all(accountId);
  return rows.map(clientRow);
}

export function getClient(db, accountId, id) {
  return clientRow(db.prepare('SELECT * FROM clients WHERE id = ? AND account_id = ?').get(id, accountId));
}

export function createClient(db, accountId, c) {
  const r = db.prepare(
    `INSERT INTO clients (account_id, name, email, address, terms_days, wait_rate, notes, chase_optout, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(accountId, c.name, c.email, c.address, c.termsDays, c.waitRate, c.notes, c.chaseOptout ? 1 : 0, nowIso());
  return getClient(db, accountId, Number(r.lastInsertRowid));
}

export function updateClient(db, accountId, id, c) {
  db.prepare(
    `UPDATE clients SET name = ?, email = ?, address = ?, terms_days = ?, wait_rate = ?, notes = ?, chase_optout = ?
     WHERE id = ? AND account_id = ?`
  ).run(c.name, c.email, c.address, c.termsDays, c.waitRate, c.notes, c.chaseOptout ? 1 : 0, id, accountId);
  return getClient(db, accountId, id);
}

export function setClientArchived(db, accountId, id, archived) {
  db.prepare('UPDATE clients SET archived = ? WHERE id = ? AND account_id = ?')
    .run(archived ? 1 : 0, id, accountId);
  return getClient(db, accountId, id);
}

/* ──────────────────────────────── jobs ──────────────────────────────── */

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

export function listJobs(db, accountId, { clientId, month, uninvoiced, limit = 1000 } = {}) {
  const where = ['account_id = ?'], args = [accountId];
  if (clientId) { where.push('client_id = ?'); args.push(clientId); }
  if (month) { where.push('substr(date, 1, 7) = ?'); args.push(month); }
  if (uninvoiced) where.push('invoice_id IS NULL');
  const sql = `SELECT * FROM jobs WHERE ${where.join(' AND ')}
               ORDER BY date DESC, time DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map(jobRow);
}

export function getJob(db, accountId, id) {
  return jobRow(db.prepare('SELECT * FROM jobs WHERE id = ? AND account_id = ?').get(id, accountId));
}

export function createJob(db, accountId, j) {
  const r = db.prepare(
    `INSERT INTO jobs (account_id, client_id, date, time, pickup, dropoff, fare, wait_minutes, wait_rate, extras, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(accountId, j.clientId, j.date, j.time, j.pickup, j.dropoff, j.fare, j.waitMinutes, j.waitRate,
    JSON.stringify(j.extras), j.notes, nowIso());
  return getJob(db, accountId, Number(r.lastInsertRowid));
}

export function updateJob(db, accountId, id, j) {
  db.prepare(
    `UPDATE jobs SET client_id = ?, date = ?, time = ?, pickup = ?, dropoff = ?, fare = ?,
     wait_minutes = ?, wait_rate = ?, extras = ?, notes = ? WHERE id = ? AND account_id = ?`
  ).run(j.clientId, j.date, j.time, j.pickup, j.dropoff, j.fare, j.waitMinutes, j.waitRate,
    JSON.stringify(j.extras), j.notes, id, accountId);
  return getJob(db, accountId, id);
}

export function deleteJob(db, accountId, id) {
  db.prepare('DELETE FROM jobs WHERE id = ? AND account_id = ?').run(id, accountId);
}

/* ────────────────────────────── invoices ────────────────────────────── */

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

export function listInvoices(db, accountId) {
  return db.prepare('SELECT * FROM invoices WHERE account_id = ? ORDER BY number DESC')
    .all(accountId).map(invoiceRow);
}

export function getInvoice(db, accountId, id) {
  return invoiceRow(db.prepare('SELECT * FROM invoices WHERE id = ? AND account_id = ?').get(id, accountId));
}

// Insert the invoice, claim its jobs, and bump the sequential counter — one
// transaction, so numbers can never be double-issued.
export function createInvoice(db, accountId, inv, jobIds, settings) {
  db.exec('BEGIN');
  try {
    const r = db.prepare(
      `INSERT INTO invoices (account_id, number, display_number, client_id, period, issue_date, due_date, status,
        subtotal, vat_rate, vat_amount, total, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(accountId, inv.number, inv.displayNumber, inv.clientId, inv.period, inv.issueDate, inv.dueDate,
      inv.status, inv.subtotal, inv.vatRatePct, inv.vatAmount, inv.total,
      JSON.stringify(inv.snapshot), nowIso());
    const invoiceId = Number(r.lastInsertRowid);
    const claim = db.prepare('UPDATE jobs SET invoice_id = ? WHERE id = ? AND account_id = ? AND invoice_id IS NULL');
    for (const jobId of jobIds) {
      const res = claim.run(invoiceId, jobId, accountId);
      if (Number(res.changes) !== 1) throw new Error(`job ${jobId} is already invoiced`);
    }
    settings.nextNumber = inv.number + 1;
    saveSettings(db, accountId, settings);
    db.exec('COMMIT');
    return getInvoice(db, accountId, invoiceId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function setInvoiceStatus(db, accountId, id, status, paidDate) {
  db.prepare('UPDATE invoices SET status = ?, paid_date = ? WHERE id = ? AND account_id = ?')
    .run(status, paidDate || null, id, accountId);
  return getInvoice(db, accountId, id);
}

// Voiding releases the jobs so they can be re-invoiced (e.g. after a fix).
// The used number is not recycled — a gap is honest; a duplicate is not.
export function voidInvoice(db, accountId, id) {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE jobs SET invoice_id = NULL WHERE invoice_id = ? AND account_id = ?').run(id, accountId);
    db.prepare('DELETE FROM invoices WHERE id = ? AND account_id = ?').run(id, accountId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ─────────────────────────────── email log ─────────────────────────────── */

export function logEmail(db, accountId, { invoiceId, kind, recipient, providerId }) {
  const r = db.prepare(
    'INSERT INTO email_log (account_id, invoice_id, kind, recipient, provider_id, sent_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(accountId, invoiceId ?? null, kind, recipient, providerId ?? null, nowIso());
  return Number(r.lastInsertRowid);
}

export function listEmailLog(db, accountId, { invoiceId } = {}) {
  const rows = invoiceId
    ? db.prepare('SELECT * FROM email_log WHERE account_id = ? AND invoice_id = ? ORDER BY id').all(accountId, invoiceId)
    : db.prepare('SELECT * FROM email_log WHERE account_id = ? ORDER BY id').all(accountId);
  return rows.map((r) => ({
    id: r.id, invoiceId: r.invoice_id, kind: r.kind, recipient: r.recipient,
    providerId: r.provider_id, sentAt: r.sent_at,
  }));
}

// Accounts whose invoices might need chasing (the scheduler loops these).
export function accountsWithInvoices(db) {
  return db.prepare('SELECT DISTINCT account_id FROM invoices').all().map((r) => r.account_id);
}

/* ── backup / restore (per account; also the tenant-migration seam) ── */

export function dumpAll(db, accountId) {
  return {
    fareBackup: 2,
    exportedAt: nowIso(),
    settings: getSettings(db, accountId),
    clients: db.prepare('SELECT * FROM clients WHERE account_id = ? ORDER BY id').all(accountId),
    jobs: db.prepare('SELECT * FROM jobs WHERE account_id = ? ORDER BY id').all(accountId),
    invoices: db.prepare('SELECT * FROM invoices WHERE account_id = ? ORDER BY id').all(accountId),
    emailLog: db.prepare('SELECT * FROM email_log WHERE account_id = ? ORDER BY id').all(accountId),
  };
}

// Restores a backup into ONE account, remapping every id (so a v1 backup or
// another account's export lands cleanly regardless of existing rows).
export function restoreAll(db, accountId, dump) {
  if (!dump || (dump.fareBackup !== 1 && dump.fareBackup !== 2)) throw new Error('not a Fare backup file');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE jobs SET invoice_id = NULL WHERE account_id = ?').run(accountId);
    db.prepare('DELETE FROM jobs WHERE account_id = ?').run(accountId);
    db.prepare('DELETE FROM invoices WHERE account_id = ?').run(accountId);
    db.prepare('DELETE FROM clients WHERE account_id = ?').run(accountId);
    db.prepare('DELETE FROM email_log WHERE account_id = ?').run(accountId);

    const clientMap = {}, invoiceMap = {};
    for (const c of dump.clients || []) {
      const created = createClient(db, accountId, {
        name: c.name, email: c.email || '', address: c.address || '',
        termsDays: c.terms_days ?? 14, waitRate: c.wait_rate ?? 0,
        notes: c.notes || '', chaseOptout: !!c.chase_optout,
      });
      if (c.archived) setClientArchived(db, accountId, created.id, true);
      clientMap[c.id] = created.id;
    }
    for (const inv of dump.invoices || []) {
      const r = db.prepare(
        `INSERT INTO invoices (account_id, number, display_number, client_id, period, issue_date, due_date,
          status, paid_date, subtotal, vat_rate, vat_amount, total, snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(accountId, inv.number, inv.display_number, clientMap[inv.client_id] ?? inv.client_id,
        inv.period, inv.issue_date, inv.due_date, inv.status, inv.paid_date ?? null,
        inv.subtotal, inv.vat_rate, inv.vat_amount, inv.total, inv.snapshot, inv.created_at || nowIso());
      invoiceMap[inv.id] = Number(r.lastInsertRowid);
    }
    for (const j of dump.jobs || []) {
      db.prepare(
        `INSERT INTO jobs (account_id, client_id, date, time, pickup, dropoff, fare, wait_minutes, wait_rate,
          extras, notes, invoice_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(accountId, clientMap[j.client_id] ?? j.client_id, j.date, j.time || '', j.pickup || '', j.dropoff || '',
        j.fare ?? 0, j.wait_minutes ?? 0, j.wait_rate ?? 0, j.extras || '[]', j.notes || '',
        j.invoice_id != null ? (invoiceMap[j.invoice_id] ?? null) : null, j.created_at || nowIso());
    }
    saveSettings(db, accountId, dump.settings || {});
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
