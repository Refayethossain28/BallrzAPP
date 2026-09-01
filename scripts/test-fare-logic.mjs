#!/usr/bin/env node
/**
 * Unit tests for Fare — the chauffeur job-logging + invoicing app.
 *
 * Covers the pure engine (fare/public/engine.js: pence money maths, pro-rata
 * waiting time, remembered routes, invoice building/numbering/status, chase
 * planning, account access gating), the SQLite store (fare/db.mjs on
 * node:sqlite: multi-tenant scoping, the v1→v2 in-place migration, invoice
 * transaction, double-invoice guard, void, backup round-trip), passwordless
 * auth (fare/auth.mjs: single-use magic links, sessions, legacy-account
 * claim), Stripe webhook verification (fare/stripe.mjs, pure HMAC), and the
 * hand-rolled PDF writer (fare/pdf.mjs).
 * The engine loads in a vm sandbox exactly like the browser/test convention.
 * Zero dependencies — Node built-ins only (needs Node 22+ for node:sqlite).
 * Run: node scripts/test-fare-logic.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'fare', 'public', 'engine.js'), 'utf8'), sandbox, { filename: 'fare/public/engine.js' });
const E = sandbox.module.exports;

const db = await import('../fare/db.mjs');
const auth = await import('../fare/auth.mjs');
const stripe = await import('../fare/stripe.mjs');
const { invoicePdf } = await import('../fare/pdf.mjs');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ─────────────────────────── engine: money ─────────────────────────── */

test('parseMoney: pounds, pennies, junk', () => {
  assert.equal(E.parseMoney('90'), 9000);
  assert.equal(E.parseMoney('£1,234.5'), 123450);
  assert.equal(E.parseMoney(' 12.50 '), 1250);
  assert.equal(E.parseMoney(12.5), 1250);
  assert.equal(E.parseMoney('12.345'), null);
  assert.equal(E.parseMoney('-4'), null);
  assert.equal(E.parseMoney('abc'), null);
  assert.equal(E.parseMoney(''), null);
});

test('formatMoney: pence → £ with thousands separators', () => {
  assert.equal(E.formatMoney(0), '£0.00');
  assert.equal(E.formatMoney(9000), '£90.00');
  assert.equal(E.formatMoney(123450), '£1,234.50');
  assert.equal(E.formatMoney(100000000), '£1,000,000.00');
  assert.equal(E.formatMoney(-250), '-£2.50');
});

test('waitCharge: pro-rata per minute at an hourly rate', () => {
  assert.equal(E.waitCharge(40, 3000), 2000);      // 40 min @ £30/hr = £20
  assert.equal(E.waitCharge(60, 3000), 3000);
  assert.equal(E.waitCharge(0, 3000), 0);
  assert.equal(E.waitCharge(1, 3000), 50);
  assert.equal(E.waitCharge(7, 1234), 144);        // round(143.96)
  assert.equal(E.waitCharge(90, 0), 0);
});

test('jobTotal = fare + waiting + itemised extras', () => {
  const job = {
    fare: 9000, waitMinutes: 30, waitRate: 3000,
    extras: [{ type: 'parking', amount: 450 }, { type: 'ulez', amount: 1250 }],
  };
  assert.equal(E.jobTotal(job), 9000 + 1500 + 450 + 1250);
  assert.equal(E.sumJobs([job, job]), 2 * 12200);
});

test('normaliseExtras: keeps known+positive, drops junk', () => {
  const out = E.normaliseExtras([
    { type: 'parking', amount: 450 },
    { type: 'ulez', amount: 0 },
    { type: 'nonsense', amount: 100 },
    { type: 'other', amount: 300, label: 'Congestion charge' },
    { type: 'tolls', amount: -5 },
  ]);
  deepEq(out, [
    { type: 'parking', amount: 450 },
    { type: 'other', amount: 300, label: 'Congestion charge' },
  ]);
  assert.equal(E.extraLabel(out[1]), 'Congestion charge');
  assert.equal(E.extraLabel({ type: 'airport' }), 'Airport drop-off');
});

/* ─────────────────────────── engine: dates ─────────────────────────── */

test('addDaysISO crosses month ends on the calendar', () => {
  assert.equal(E.addDaysISO('2026-01-31', 14), '2026-02-14');
  assert.equal(E.addDaysISO('2026-12-31', 1), '2027-01-01');
  assert.equal(E.addDaysISO('2026-08-31', 0), '2026-08-31');
});

test('month helpers: key, label, shifting across years', () => {
  assert.equal(E.monthKey('2026-08-31'), '2026-08');
  assert.equal(E.monthLabel('2026-08'), 'August 2026');
  assert.equal(E.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(E.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(E.formatDayLabel('2026-08-31'), 'Mon 31 Aug');
  assert.equal(E.formatDateLong('2026-08-31'), '31 August 2026');
});

/* ───────────────── engine: remembered routes (taps not typing) ───────────────── */

test('routeSuggestions: deduped, frequency-first, latest template', () => {
  const jobs = [
    { clientId: 1, date: '2026-08-01', pickup: 'Home', dropoff: 'Heathrow T5', fare: 9000, waitRate: 3000, extras: [] },
    { clientId: 1, date: '2026-08-08', pickup: 'home', dropoff: 'HEATHROW T5', fare: 9500, waitRate: 3000, extras: [{ type: 'airport', amount: 500 }] },
    { clientId: 1, date: '2026-08-10', pickup: 'Office', dropoff: 'Gatwick', fare: 11000, waitRate: 0, extras: [] },
    { clientId: 2, date: '2026-08-11', pickup: 'Mayfair', dropoff: 'Ascot', fare: 20000, waitRate: 0, extras: [] },
  ];
  const routes = E.routeSuggestions(jobs, 1);
  assert.equal(routes.length, 2, 'client 2 excluded, case-insensitive dedupe');
  assert.equal(routes[0].dropoff, 'HEATHROW T5', 'most-used first, newest as template');
  assert.equal(routes[0].fare, 9500);
  assert.equal(routes[0].count, 2);
  deepEq(routes[0].extras, [{ type: 'airport', amount: 500 }]);
});

/* ─────────────────────────── engine: validation ─────────────────────────── */

test('validateJob: guards client/date/fare, clamps waiting', () => {
  assert.equal(E.validateJob({ clientId: 9, date: '2026-08-31', fare: '90' }, [1, 2]).ok, false);
  assert.equal(E.validateJob({ clientId: 1, date: 'nope', fare: '90' }, [1]).ok, false);
  assert.equal(E.validateJob({ clientId: 1, date: '2026-08-31', fare: 'abc' }, [1]).ok, false);
  const v = E.validateJob({
    clientId: 1, date: '2026-08-31', time: '14:30', pickup: '  Home ', dropoff: 'T5',
    fare: '£95.50', waitMinutes: '40', waitRate: 3000,
    extras: [{ type: 'ulez', amount: 1250 }], notes: 'x',
  }, [1]);
  assert.equal(v.ok, true);
  assert.equal(v.job.fare, 9550);
  assert.equal(v.job.pickup, 'Home');
  assert.equal(v.job.waitMinutes, 40);
  assert.equal(E.jobTotal(v.job), 9550 + 2000 + 1250);
});

test('validateClient: name required, terms defaulted, chase opt-out kept', () => {
  assert.equal(E.validateClient({ name: '  ' }).ok, false);
  const v = E.validateClient({ name: ' Acme Ltd ', termsDays: 'soon', waitRate: 2500, chaseOptout: 1 });
  assert.equal(v.ok, true);
  assert.equal(v.client.name, 'Acme Ltd');
  assert.equal(v.client.termsDays, 14);
  assert.equal(v.client.waitRate, 2500);
  assert.equal(v.client.chaseOptout, true);
});

test('normaliseSettings: defaults, clamps, logo gate, chase config', () => {
  const s = E.normaliseSettings({ vatRatePct: '20', nextNumber: 0, invoicePrefix: '', logo: 'data:image/png;base64,xx', chaseIntervalDays: 0, chaseMax: 99 });
  assert.equal(s.invoicePrefix, 'INV-');
  assert.equal(s.nextNumber, 1);
  assert.equal(s.vatRatePct, 20);
  assert.equal(s.logo, null, 'only jpeg data URLs are kept');
  assert.equal(s.defaultTermsDays, 14);
  assert.equal(s.chaseEnabled, false);
  assert.equal(s.chaseIntervalDays, 7, 'out-of-range interval falls back');
  assert.equal(s.chaseMax, 3, 'out-of-range max falls back');
  assert.equal(E.normaliseSettings({ logo: 'data:image/jpeg;base64,abc' }).logo, 'data:image/jpeg;base64,abc');
});

test('validEmail: accepts addresses, rejects junk', () => {
  assert.equal(E.validEmail('ap@acme.co'), true);
  assert.equal(E.validEmail('  x@y.uk '), true);
  assert.equal(E.validEmail('nope'), false);
  assert.equal(E.validEmail('a@b'), false);
  assert.equal(E.validEmail(''), false);
});

/* ─────────────────────────── engine: invoicing ─────────────────────────── */

const CLIENT = { id: 3, name: 'Acme Ltd', address: '1 King St\nLondon', email: 'ap@acme.co', termsDays: 21, waitRate: 3000 };
const AUG_JOBS = [
  { id: 11, clientId: 3, date: '2026-08-20', time: '09:00', pickup: 'Home', dropoff: 'Heathrow T5', fare: 9000, waitMinutes: 40, waitRate: 3000, extras: [{ type: 'ulez', amount: 1250 }] },
  { id: 12, clientId: 3, date: '2026-08-05', time: '18:15', pickup: 'Savoy', dropoff: 'Ascot', fare: 15000, waitMinutes: 0, waitRate: 3000, extras: [{ type: 'parking', amount: 800 }, { type: 'other', amount: 1500, label: 'Congestion charge' }] },
];
const SETTINGS = { businessName: 'Apex Chauffeurs', address: '2 Park Lane\nLondon W1', invoicePrefix: 'APX-', nextNumber: 42, vatEnabled: false, bankAccountName: 'R Hossain', bankSortCode: '01-02-03', bankAccountNumber: '12345678' };

test('buildInvoice: totals, numbering, due date from client terms, frozen snapshot', () => {
  const r = E.buildInvoice({ client: CLIENT, jobs: AUG_JOBS, settings: SETTINGS, todayISO: '2026-09-01', month: '2026-08', number: 42 });
  assert.equal(r.ok, true);
  const inv = r.invoice;
  assert.equal(inv.displayNumber, 'APX-0042');
  assert.equal(inv.period, '2026-08');
  assert.equal(inv.dueDate, '2026-09-22', '21-day client terms');
  assert.equal(inv.subtotal, 12250 + 17300);
  assert.equal(inv.vatAmount, 0);
  assert.equal(inv.total, inv.subtotal);
  assert.equal(inv.snapshot.lines[0].date, '2026-08-05', 'oldest first on the invoice');
  assert.equal(inv.snapshot.lines[1].waitCharge, 2000);
  assert.equal(inv.snapshot.lines[0].extras[1].label, 'Congestion charge');
  assert.equal(inv.snapshot.business.name, 'Apex Chauffeurs');
  assert.equal(inv.snapshot.client.name, 'Acme Ltd');
  assert.equal(inv.snapshot.bank.sortCode, '01-02-03');
  assert.equal(inv.snapshot.termsDays, 21);
});

test('buildInvoice: VAT added and rounded when enabled', () => {
  const r = E.buildInvoice({
    client: CLIENT, jobs: [{ id: 1, clientId: 3, date: '2026-08-01', fare: 1234, waitMinutes: 0, waitRate: 0, extras: [] }],
    settings: { ...SETTINGS, vatEnabled: true, vatRatePct: 20 }, todayISO: '2026-09-01', month: '2026-08', number: 1,
  });
  assert.equal(r.invoice.vatAmount, 247);
  assert.equal(r.invoice.total, 1481);
});

test('buildInvoice: refuses an empty month', () => {
  assert.equal(E.buildInvoice({ client: CLIENT, jobs: [], settings: SETTINGS, todayISO: '2026-09-01' }).ok, false);
});

test('invoiceStatus: paid sticks; overdue is derived from the clock', () => {
  const inv = { status: 'sent', dueDate: '2026-09-22' };
  assert.equal(E.invoiceStatus(inv, '2026-09-22'), 'sent');
  assert.equal(E.invoiceStatus(inv, '2026-09-23'), 'overdue');
  assert.equal(E.invoiceStatus({ status: 'paid', dueDate: '2020-01-01' }, '2026-09-23'), 'paid');
});

test('uninvoicedGroups: per client+month, newest month first', () => {
  const jobs = [
    { clientId: 1, date: '2026-07-04', fare: 5000, extras: [] },
    { clientId: 1, date: '2026-08-10', fare: 7000, extras: [] },
    { clientId: 1, date: '2026-08-20', fare: 3000, extras: [], invoiceId: 9 },
    { clientId: 2, date: '2026-08-11', fare: 20000, extras: [] },
  ];
  const clients = [{ id: 1, name: 'Beta' }, { id: 2, name: 'Acme' }];
  const g = E.uninvoicedGroups(jobs, clients);
  assert.equal(g.length, 3);
  assert.equal(g[0].month, '2026-08');
  assert.equal(g[0].clientName, 'Acme', 'same month sorts by name');
  assert.equal(g[2].month, '2026-07');
  assert.equal(g[1].total, 7000);
});

/* ──────────────── engine: accounts, gating, chase planning ──────────────── */

test('trialDaysLeft + accountAccess: trial, active, expired, billing off', () => {
  const trial = { status: 'trial', trialEndsAt: '2026-09-10T00:00:00.000Z' };
  assert.equal(E.trialDaysLeft(trial, '2026-09-01'), 9);
  assert.equal(E.trialDaysLeft(trial, '2026-09-10'), 0);
  // billing disabled → everything allowed regardless of status
  assert.equal(E.accountAccess({ status: 'canceled' }, '2026-09-01', false).readOnly, false);
  // live trial and active subscription → full access
  assert.equal(E.accountAccess(trial, '2026-09-01', true).readOnly, false);
  assert.equal(E.accountAccess({ status: 'active' }, '2026-09-01', true).readOnly, false);
  // expired trial / canceled / past_due → read-only with a human reason
  const ended = E.accountAccess(trial, '2026-09-11', true);
  assert.equal(ended.readOnly, true);
  assert.ok(ended.reason.includes('trial'));
  assert.ok(E.accountAccess({ status: 'past_due' }, '2026-09-01', true).reason.includes('payment'));
});

test('chasePlan: overdue sent invoices only, spaced, capped, opt-out honoured', () => {
  const cfg = { ...SETTINGS, chaseEnabled: true, chaseIntervalDays: 7, chaseMax: 2 };
  const clients = [
    { id: 1, name: 'A', email: 'a@x.co' },
    { id: 2, name: 'B', email: 'b@x.co', chaseOptout: true },
    { id: 3, name: 'C', email: '' }, // no email → never chased
  ];
  const invoices = [
    { id: 10, clientId: 1, status: 'sent', dueDate: '2026-08-20' },  // overdue
    { id: 11, clientId: 1, status: 'sent', dueDate: '2026-09-05' },  // not due yet
    { id: 12, clientId: 1, status: 'paid', dueDate: '2026-08-01' },  // paid → never
    { id: 13, clientId: 2, status: 'sent', dueDate: '2026-08-01' },  // opted out
    { id: 14, clientId: 3, status: 'sent', dueDate: '2026-08-01' },  // no email
  ];
  // due 20 Aug + 7 days → first reminder from 27 Aug
  assert.equal(E.chasePlan(invoices, [], clients, cfg, '2026-08-26').length, 0, 'interval not yet passed');
  const first = E.chasePlan(invoices, [], clients, cfg, '2026-09-01');
  assert.equal(first.length, 1);
  assert.equal(first[0].invoice.id, 10);
  assert.equal(first[0].reminderNo, 1);
  assert.equal(first[0].recipient, 'a@x.co');
  // after a reminder on 1 Sep, the next comes 7 days later — and chaseMax caps it
  const log1 = [{ invoiceId: 10, kind: 'reminder', sentAt: '2026-09-01T10:00:00Z' }];
  assert.equal(E.chasePlan(invoices, log1, clients, cfg, '2026-09-05').length, 0, 'too soon for reminder 2');
  const second = E.chasePlan(invoices, log1, clients, cfg, '2026-09-08');
  assert.equal(second.length, 1);
  assert.equal(second[0].reminderNo, 2);
  const log2 = log1.concat([{ invoiceId: 10, kind: 'reminder', sentAt: '2026-09-08T10:00:00Z' }]);
  const later = E.chasePlan(invoices, log2, clients, cfg, '2026-10-01');
  assert.ok(!later.some((p) => p.invoice.id === 10), 'chaseMax reached — invoice 10 stops');
  deepEq(later.map((p) => p.invoice.id), [11], 'invoice 11 is overdue by October and starts its own chase');
  assert.equal(E.chasePlan(invoices, [], clients, { ...cfg, chaseEnabled: false }, '2026-09-01').length, 0, 'disabled → nothing');
});

/* ─────────────────────────── store: node:sqlite ─────────────────────────── */

function seededDb() {
  const d = db.openDb(':memory:');
  db.saveSettings(d, 1, { ...SETTINGS });
  const client = db.createClient(d, 1, { name: 'Acme Ltd', email: 'ap@acme.co', address: '1 King St', termsDays: 21, waitRate: 3000, notes: '', chaseOptout: false });
  return { d, client };
}

test('store: client + job CRUD with month/client filters', () => {
  const { d, client } = seededDb();
  const job = db.createJob(d, 1, {
    clientId: client.id, date: '2026-08-20', time: '09:00', pickup: 'Home', dropoff: 'T5',
    fare: 9000, waitMinutes: 40, waitRate: 3000, extras: [{ type: 'ulez', amount: 1250 }], notes: '',
  });
  assert.equal(job.id, 1);
  deepEq(job.extras, [{ type: 'ulez', amount: 1250 }]);
  db.createJob(d, 1, { clientId: client.id, date: '2026-07-01', time: '', pickup: 'A', dropoff: 'B', fare: 5000, waitMinutes: 0, waitRate: 0, extras: [], notes: '' });
  assert.equal(db.listJobs(d, 1, { month: '2026-08' }).length, 1);
  assert.equal(db.listJobs(d, 1, { clientId: client.id }).length, 2);
  assert.equal(db.listJobs(d, 1, { clientId: 999 }).length, 0);
  const upd = db.updateJob(d, 1, job.id, { ...job, fare: 9500, extras: job.extras });
  assert.equal(upd.fare, 9500);
  db.deleteJob(d, 1, 2);
  assert.equal(db.listJobs(d, 1, {}).length, 1);
});

test('store: tenants are hermetically separated', () => {
  const { d, client } = seededDb();
  db.createJob(d, 1, { clientId: client.id, date: '2026-08-20', time: '', pickup: 'A', dropoff: 'B', fare: 9000, waitMinutes: 0, waitRate: 0, extras: [], notes: '' });
  const c2 = db.createClient(d, 2, { name: 'Rival Cars', email: '', address: '', termsDays: 14, waitRate: 0, notes: '', chaseOptout: false });
  // account 2 sees only its own world
  assert.equal(db.listClients(d, 2).length, 1);
  assert.equal(db.listClients(d, 2)[0].name, 'Rival Cars');
  assert.equal(db.listJobs(d, 2, {}).length, 0);
  assert.ok(!db.getClient(d, 2, client.id), 'cannot read another tenant’s client');
  assert.ok(!db.getJob(d, 2, 1), 'cannot read another tenant’s job');
  db.deleteJob(d, 2, 1); // scoped delete must be a no-op
  assert.equal(db.listJobs(d, 1, {}).length, 1, 'cross-tenant delete is a no-op');
  // both tenants can hold the same invoice number
  db.saveSettings(d, 2, { invoicePrefix: 'INV-', nextNumber: 42 });
  const j2 = db.createJob(d, 2, { clientId: c2.id, date: '2026-08-02', time: '', pickup: 'X', dropoff: 'Y', fare: 1000, waitMinutes: 0, waitRate: 0, extras: [], notes: '' });
  const b1 = E.buildInvoice({ client, jobs: db.listJobs(d, 1, {}), settings: SETTINGS, todayISO: '2026-09-01', month: '2026-08', number: 42 });
  const b2 = E.buildInvoice({ client: c2, jobs: [j2], settings: db.getSettings(d, 2), todayISO: '2026-09-01', month: '2026-08', number: 42 });
  db.createInvoice(d, 1, b1.invoice, db.listJobs(d, 1, {}).map((j) => j.id), E.normaliseSettings(db.getSettings(d, 1)));
  db.createInvoice(d, 2, b2.invoice, [j2.id], E.normaliseSettings(db.getSettings(d, 2)));
  assert.equal(db.listInvoices(d, 1)[0].number, 42);
  assert.equal(db.listInvoices(d, 2)[0].number, 42, 'same number, different tenants — fine');
});

test('store: invoice transaction claims jobs, bumps the counter, never double-invoices', () => {
  const { d, client } = seededDb();
  const j1 = db.createJob(d, 1, { clientId: client.id, date: '2026-08-20', time: '', pickup: 'Home', dropoff: 'T5', fare: 9000, waitMinutes: 40, waitRate: 3000, extras: [{ type: 'ulez', amount: 1250 }], notes: '' });
  const settings = E.normaliseSettings(db.getSettings(d, 1));
  const built = E.buildInvoice({ client, jobs: [j1], settings, todayISO: '2026-09-01', month: '2026-08', number: settings.nextNumber });
  const inv = db.createInvoice(d, 1, built.invoice, [j1.id], settings);
  assert.equal(inv.displayNumber, 'APX-0042');
  assert.equal(db.getJob(d, 1, j1.id).invoiceId, inv.id, 'job claimed');
  assert.equal(E.normaliseSettings(db.getSettings(d, 1)).nextNumber, 43, 'counter bumped');
  const again = E.buildInvoice({ client, jobs: [j1], settings: db.getSettings(d, 1), todayISO: '2026-09-01', month: '2026-08', number: 43 });
  assert.throws(() => db.createInvoice(d, 1, again.invoice, [j1.id], E.normaliseSettings(db.getSettings(d, 1))), /already invoiced/);
  assert.equal(db.listInvoices(d, 1).length, 1, 'failed invoice rolled back');
  assert.equal(E.normaliseSettings(db.getSettings(d, 1)).nextNumber, 43, 'counter untouched by rollback');
  db.voidInvoice(d, 1, inv.id);
  assert.equal(db.getJob(d, 1, j1.id).invoiceId, null);
  assert.equal(db.listInvoices(d, 1).length, 0);
  assert.equal(E.normaliseSettings(db.getSettings(d, 1)).nextNumber, 43, 'no number reuse after void');
});

test('store: paid status, email log + backup/restore round-trip', () => {
  const { d, client } = seededDb();
  const j = db.createJob(d, 1, { clientId: client.id, date: '2026-08-20', time: '', pickup: 'A', dropoff: 'B', fare: 9000, waitMinutes: 0, waitRate: 0, extras: [], notes: '' });
  const settings = E.normaliseSettings(db.getSettings(d, 1));
  const built = E.buildInvoice({ client, jobs: [j], settings, todayISO: '2026-09-01', month: '2026-08', number: settings.nextNumber });
  const inv = db.createInvoice(d, 1, built.invoice, [j.id], settings);
  const paid = db.setInvoiceStatus(d, 1, inv.id, 'paid', '2026-09-10');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paidDate, '2026-09-10');
  db.logEmail(d, 1, { invoiceId: inv.id, kind: 'invoice', recipient: 'ap@acme.co', providerId: 'x1' });
  assert.equal(db.listEmailLog(d, 1, { invoiceId: inv.id }).length, 1);
  assert.equal(db.listEmailLog(d, 2).length, 0, 'email log is tenant-scoped');

  const dump = db.dumpAll(d, 1);
  assert.equal(dump.fareBackup, 2);
  const d2 = db.openDb(':memory:');
  db.restoreAll(d2, 5, dump); // restore into a DIFFERENT account id — ids remap
  assert.equal(db.listClients(d2, 5).length, 1);
  assert.equal(db.listJobs(d2, 5, {}).length, 1);
  assert.equal(db.listInvoices(d2, 5)[0].displayNumber, inv.displayNumber);
  const restoredJob = db.listJobs(d2, 5, {})[0];
  assert.equal(restoredJob.invoiceId, db.listInvoices(d2, 5)[0].id, 'claims survive restore via id remap');
  assert.throws(() => db.restoreAll(d2, 5, { hello: 1 }), /not a Fare backup/);
});

test('store: a v1 single-user database migrates in place to v2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fare-migrate-'));
  const path = join(dir, 'v1.db');
  // Build a faithful v1 database by hand (the pre-account schema).
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL DEFAULT '{}');
    INSERT INTO settings (id, json) VALUES (1, '{"businessName":"Apex Chauffeurs","invoicePrefix":"APX-","nextNumber":3}');
    CREATE TABLE clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', terms_days INTEGER NOT NULL DEFAULT 14,
      wait_rate INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL);
    INSERT INTO clients (name, email, terms_days, wait_rate, created_at) VALUES ('Acme Ltd', 'ap@acme.co', 21, 3000, 'x');
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, number INTEGER NOT NULL UNIQUE,
      display_number TEXT NOT NULL, client_id INTEGER NOT NULL, period TEXT NOT NULL,
      issue_date TEXT NOT NULL, due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent', paid_date TEXT,
      subtotal INTEGER NOT NULL, vat_rate REAL NOT NULL DEFAULT 0, vat_amount INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO invoices (number, display_number, client_id, period, issue_date, due_date, status,
      subtotal, vat_rate, vat_amount, total, snapshot, created_at)
      VALUES (2, 'APX-0002', 1, '2026-08', '2026-08-31', '2026-09-21', 'sent', 34050, 0, 0, 34050, '{}', 'x');
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL,
      date TEXT NOT NULL, time TEXT NOT NULL DEFAULT '', pickup TEXT NOT NULL DEFAULT '',
      dropoff TEXT NOT NULL DEFAULT '', fare INTEGER NOT NULL DEFAULT 0, wait_minutes INTEGER NOT NULL DEFAULT 0,
      wait_rate INTEGER NOT NULL DEFAULT 0, extras TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',
      invoice_id INTEGER REFERENCES invoices(id), created_at TEXT NOT NULL);
    INSERT INTO jobs (client_id, date, fare, invoice_id, created_at) VALUES (1, '2026-08-20', 9000, 1, 'x');
  `);
  // like production: FK enforcement is on when the migration runs
  raw.exec('PRAGMA foreign_keys = ON');
  raw.close();

  const d = db.openDb(path); // ← migration happens here
  try {
    assert.equal(db.getSettings(d, 1).businessName, 'Apex Chauffeurs', 'settings became account 1');
    assert.equal(db.listClients(d, 1).length, 1, 'clients became account 1');
    assert.equal(db.listJobs(d, 1, {}).length, 1);
    assert.equal(db.listInvoices(d, 1)[0].displayNumber, 'APX-0002');
    const acct1 = db.getAccount(d, 1);
    assert.ok(acct1 && acct1.email === null, 'account 1 exists, unclaimed');
    // the owner claims it on first sign-in
    const claimed = db.accountForEmail(d, 'rafa@example.com', '2026-10-01T00:00:00Z');
    assert.equal(claimed.id, 1, 'first sign-in claims the legacy account');
    assert.equal(db.getAccount(d, 1).email, 'rafa@example.com');
    // a different email later gets a fresh, empty account
    const other = db.accountForEmail(d, 'someone@else.co', '2026-10-01T00:00:00Z');
    assert.notEqual(other.id, 1);
    assert.equal(db.listClients(d, other.id).length, 0);
    // idempotent: reopening migrates nothing twice
    d.close();
    const d2 = db.openDb(path);
    assert.equal(db.listClients(d2, 1).length, 1);
    d2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────────────────────── auth: magic links + sessions ───────────────────────── */

test('auth: magic link is single-use, sessions resolve, legacy claim works', () => {
  const d = db.openDb(':memory:');
  db.saveSettings(d, 1, {});                        // legacy-ish data
  db.ensureOwnerAccount(d);
  const token = auth.issueLoginToken(d, 'rafa@example.com');
  assert.ok(token.length > 30);
  const redeemed = auth.redeemLoginToken(d, token);
  assert.ok(redeemed, 'valid token redeems');
  assert.equal(redeemed.account.id, 1, 'claims the unclaimed owner account');
  assert.equal(redeemed.account.email, 'rafa@example.com');
  assert.equal(redeemed.account.status, 'trial');
  assert.equal(auth.redeemLoginToken(d, token), null, 'second use is refused');
  assert.equal(auth.redeemLoginToken(d, 'garbage'), null);
  const account = auth.accountForSession(d, redeemed.session);
  assert.equal(account.id, 1, 'session token resolves to the account');
  assert.equal(auth.accountForSession(d, 'wrong'), null);
  auth.signOut(d, redeemed.session);
  assert.equal(auth.accountForSession(d, redeemed.session), null, 'signed out');
  // a new email → a new account with a trial
  const t2 = auth.issueLoginToken(d, 'driver2@example.com');
  const r2 = auth.redeemLoginToken(d, t2);
  assert.notEqual(r2.account.id, 1);
  assert.ok(r2.account.trialEndsAt > new Date().toISOString(), '30-day trial set');
});

test('auth: sign-in emails are rate limited per address', () => {
  const now = Date.now();
  const addr = 'burst@example.com';
  assert.equal(auth.loginRateLimited(addr, now), false);
  assert.equal(auth.loginRateLimited(addr, now + 1000), false);
  assert.equal(auth.loginRateLimited(addr, now + 2000), false);
  assert.equal(auth.loginRateLimited(addr, now + 3000), true, '4th within 15 min blocked');
  assert.equal(auth.loginRateLimited(addr, now + 16 * 60 * 1000), false, 'window expires');
});

/* ───────────────────────── stripe: webhook + event mapping ───────────────────────── */

test('stripe: webhook signature verifies, tampering and stale timestamps fail', () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
  const nowMs = 1_700_000_000_000;
  const t = Math.floor(nowMs / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const ok = stripe.verifyWebhook(payload, `t=${t},v1=${v1}`, secret, nowMs);
  assert.ok(ok && ok.type === 'customer.subscription.deleted');
  assert.equal(stripe.verifyWebhook(payload + ' ', `t=${t},v1=${v1}`, secret, nowMs), null, 'tampered payload');
  assert.equal(stripe.verifyWebhook(payload, `t=${t},v1=${'0'.repeat(64)}`, secret, nowMs), null, 'wrong signature');
  assert.equal(stripe.verifyWebhook(payload, `t=${t},v1=${v1}`, secret, nowMs + 10 * 60 * 1000), null, 'stale timestamp');
});

test('stripe: events map to the account-status changes they imply', () => {
  deepEq(stripe.billingUpdateForEvent({
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: '7', customer: 'cus_9', subscription: 'sub_9' } },
  }), { accountId: 7, customerId: 'cus_9', subscriptionId: 'sub_9', status: 'active' });
  assert.equal(stripe.billingUpdateForEvent({
    type: 'customer.subscription.updated', data: { object: { id: 's', customer: 'c', status: 'past_due' } },
  }).status, 'past_due');
  assert.equal(stripe.billingUpdateForEvent({
    type: 'customer.subscription.deleted', data: { object: { id: 's', customer: 'c' } },
  }).status, 'canceled');
  assert.equal(stripe.billingUpdateForEvent({ type: 'invoice.finalized', data: { object: {} } }), null);
});

/* ─────────────────────────── PDF writer ─────────────────────────── */

const built = E.buildInvoice({ client: CLIENT, jobs: AUG_JOBS, settings: SETTINGS, todayISO: '2026-09-01', month: '2026-08', number: 42 });

test('invoicePdf: a real xref’d PDF carrying the itemised invoice text', () => {
  const buf = invoicePdf(built.invoice);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(buf.subarray(-40).toString('latin1').includes('%%EOF'));
  const text = buf.toString('latin1');
  assert.ok(text.includes('startxref') && text.includes('/Type /Catalog'));
  assert.ok(text.includes('APX-0042'), 'invoice number');
  assert.ok(text.includes('Apex Chauffeurs'), 'business name');
  assert.ok(text.includes('Acme Ltd'), 'client name');
  assert.ok(text.includes('Savoy - Ascot'), 'route line');
  assert.ok(text.includes('Waiting time - 40 min @ \xA330.00/hr'), 'pro-rata waiting itemised');
  assert.ok(text.includes('ULEZ') && text.includes('Congestion charge'), 'extras itemised');
  assert.ok(text.includes('Total due'));
  assert.ok(text.includes('\xA3295.50'), 'grand total £295.50 in WinAnsi');
  assert.ok(text.includes('within 21 days'));
  assert.ok(text.includes('01-02-03'), 'bank details in the footer');
  assert.ok(!text.includes('/DCTDecode'), 'no logo → no image object');
});

test('invoicePdf: VAT row when enabled, escaped brackets, JPEG logo embedded', () => {
  const vatBuilt = E.buildInvoice({
    client: { ...CLIENT, name: 'Acme (Holdings) Ltd' }, jobs: AUG_JOBS,
    settings: { ...SETTINGS, vatEnabled: true, vatRatePct: 20, vatNumber: 'GB123' },
    todayISO: '2026-09-01', month: '2026-08', number: 7,
  });
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9]);
  const buf = invoicePdf(vatBuilt.invoice, { logoDataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
  const text = buf.toString('latin1');
  assert.ok(text.includes('Acme \\(Holdings\\) Ltd'), 'parens escaped in content stream');
  assert.ok(text.includes('VAT @ 20%'));
  assert.ok(text.includes('GB123'));
  assert.ok(text.includes('/DCTDecode') && text.includes('/Width 32 /Height 16'), 'logo XObject embedded');
});

test('invoicePdf: a heavy month paginates onto multiple pages', () => {
  const manyJobs = [];
  for (let i = 1; i <= 45; i++) {
    manyJobs.push({
      id: i, clientId: 3, date: '2026-08-' + String((i % 28) + 1).padStart(2, '0'), time: '09:00',
      pickup: 'Pickup point number ' + i, dropoff: 'Drop-off destination ' + i,
      fare: 10000 + i, waitMinutes: 30, waitRate: 3000, extras: [{ type: 'parking', amount: 500 }],
    });
  }
  const big = E.buildInvoice({ client: CLIENT, jobs: manyJobs, settings: SETTINGS, todayISO: '2026-09-01', month: '2026-08', number: 9 });
  const text = invoicePdf(big.invoice).toString('latin1');
  const count = /\/Count (\d+)/.exec(text);
  assert.ok(count && Number(count[1]) >= 2, 'expected 2+ pages, got ' + (count && count[1]));
  assert.ok(text.includes('continued'), 'continuation header present');
});

/* ─────────────────────────── run ─────────────────────────── */

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n${err && err.stack || err}`);
    process.exit(1);
  }
}
console.log(`\nfare: ${passed}/${tests.length} passed`);
