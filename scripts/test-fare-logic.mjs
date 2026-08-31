#!/usr/bin/env node
/**
 * Unit tests for Fare — the chauffeur job-logging + invoicing app.
 *
 * Covers the pure engine (fare/public/engine.js: pence money maths, pro-rata
 * waiting time, remembered routes, invoice building/numbering/status), the
 * SQLite store (fare/db.mjs on node:sqlite, in-memory: invoice transaction,
 * double-invoice guard, void, backup round-trip) and the hand-rolled PDF
 * writer (fare/pdf.mjs: valid xref'd PDF, itemised text, logo, pagination).
 * The engine loads in a vm sandbox exactly like the browser/test convention.
 * Zero dependencies — Node built-ins only (needs Node 22+ for node:sqlite).
 * Run: node scripts/test-fare-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'fare', 'public', 'engine.js'), 'utf8'), sandbox, { filename: 'fare/public/engine.js' });
const E = sandbox.module.exports;

const db = await import('../fare/db.mjs');
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
    { type: 'ulez', amount: 0 },              // zero → dropped
    { type: 'nonsense', amount: 100 },        // unknown → dropped
    { type: 'other', amount: 300, label: 'Congestion charge' },
    { type: 'tolls', amount: -5 },            // negative → dropped
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

test('validateClient: name required, terms defaulted', () => {
  assert.equal(E.validateClient({ name: '  ' }).ok, false);
  const v = E.validateClient({ name: ' Acme Ltd ', termsDays: 'soon', waitRate: 2500 });
  assert.equal(v.ok, true);
  assert.equal(v.client.name, 'Acme Ltd');
  assert.equal(v.client.termsDays, 14);
  assert.equal(v.client.waitRate, 2500);
});

test('normaliseSettings: defaults, clamps, logo gate', () => {
  const s = E.normaliseSettings({ vatRatePct: '20', nextNumber: 0, invoicePrefix: '', logo: 'data:image/png;base64,xx' });
  assert.equal(s.invoicePrefix, 'INV-');
  assert.equal(s.nextNumber, 1);
  assert.equal(s.vatRatePct, 20);
  assert.equal(s.logo, null, 'only jpeg data URLs are kept');
  assert.equal(s.defaultTermsDays, 14);
  assert.equal(E.normaliseSettings({ logo: 'data:image/jpeg;base64,abc' }).logo, 'data:image/jpeg;base64,abc');
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
  // job 11: 9000 + 2000 wait + 1250 = 12250 · job 12: 15000 + 800 + 1500 = 17300
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
  assert.equal(r.invoice.vatAmount, 247); // round(1234 * .2)
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
    { clientId: 1, date: '2026-08-20', fare: 3000, extras: [], invoiceId: 9 }, // already invoiced
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

/* ─────────────────────────── store: node:sqlite ─────────────────────────── */

function seededDb() {
  const d = db.openDb(':memory:');
  db.saveSettings(d, { ...SETTINGS });
  const client = db.createClient(d, { name: 'Acme Ltd', email: 'ap@acme.co', address: '1 King St', termsDays: 21, waitRate: 3000, notes: '' });
  return { d, client };
}

test('store: client + job CRUD with month/client filters', () => {
  const { d, client } = seededDb();
  const job = db.createJob(d, {
    clientId: client.id, date: '2026-08-20', time: '09:00', pickup: 'Home', dropoff: 'T5',
    fare: 9000, waitMinutes: 40, waitRate: 3000, extras: [{ type: 'ulez', amount: 1250 }], notes: '',
  });
  assert.equal(job.id, 1);
  deepEq(job.extras, [{ type: 'ulez', amount: 1250 }]);
  db.createJob(d, { clientId: client.id, date: '2026-07-01', time: '', pickup: 'A', dropoff: 'B', fare: 5000, waitMinutes: 0, waitRate: 0, extras: [], notes: '' });
  assert.equal(db.listJobs(d, { month: '2026-08' }).length, 1);
  assert.equal(db.listJobs(d, { clientId: client.id }).length, 2);
  assert.equal(db.listJobs(d, { clientId: 999 }).length, 0);
  const upd = db.updateJob(d, job.id, { ...job, fare: 9500, extras: job.extras });
  assert.equal(upd.fare, 9500);
  db.deleteJob(d, 2);
  assert.equal(db.listJobs(d, {}).length, 1);
});

test('store: invoice transaction claims jobs, bumps the counter, never double-invoices', () => {
  const { d, client } = seededDb();
  const j1 = db.createJob(d, { clientId: client.id, date: '2026-08-20', time: '', pickup: 'Home', dropoff: 'T5', fare: 9000, waitMinutes: 40, waitRate: 3000, extras: [{ type: 'ulez', amount: 1250 }], notes: '' });
  const settings = E.normaliseSettings(db.getSettings(d));
  const built = E.buildInvoice({ client, jobs: [j1], settings, todayISO: '2026-09-01', month: '2026-08', number: settings.nextNumber });
  const inv = db.createInvoice(d, built.invoice, [j1.id], settings);
  assert.equal(inv.displayNumber, 'APX-0042');
  assert.equal(db.getJob(d, j1.id).invoiceId, inv.id, 'job claimed');
  assert.equal(E.normaliseSettings(db.getSettings(d)).nextNumber, 43, 'counter bumped');
  // a second invoice over the same job must fail atomically
  const again = E.buildInvoice({ client, jobs: [j1], settings: db.getSettings(d), todayISO: '2026-09-01', month: '2026-08', number: 43 });
  assert.throws(() => db.createInvoice(d, again.invoice, [j1.id], E.normaliseSettings(db.getSettings(d))), /already invoiced/);
  assert.equal(db.listInvoices(d).length, 1, 'failed invoice rolled back');
  assert.equal(E.normaliseSettings(db.getSettings(d)).nextNumber, 43, 'counter untouched by rollback');
  // void releases the job, keeps the number retired
  db.voidInvoice(d, inv.id);
  assert.equal(db.getJob(d, j1.id).invoiceId, null);
  assert.equal(db.listInvoices(d).length, 0);
  assert.equal(E.normaliseSettings(db.getSettings(d)).nextNumber, 43, 'no number reuse after void');
});

test('store: paid status + backup/restore round-trip', () => {
  const { d, client } = seededDb();
  const j = db.createJob(d, { clientId: client.id, date: '2026-08-20', time: '', pickup: 'A', dropoff: 'B', fare: 9000, waitMinutes: 0, waitRate: 0, extras: [], notes: '' });
  const settings = E.normaliseSettings(db.getSettings(d));
  const built = E.buildInvoice({ client, jobs: [j], settings, todayISO: '2026-09-01', month: '2026-08', number: settings.nextNumber });
  const inv = db.createInvoice(d, built.invoice, [j.id], settings);
  const paid = db.setInvoiceStatus(d, inv.id, 'paid', '2026-09-10');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paidDate, '2026-09-10');

  const dump = db.dumpAll(d);
  const d2 = db.openDb(':memory:');
  db.restoreAll(d2, dump);
  assert.equal(db.listClients(d2).length, 1);
  assert.equal(db.listJobs(d2, {}).length, 1);
  assert.equal(db.listInvoices(d2)[0].displayNumber, inv.displayNumber);
  assert.equal(db.getJob(d2, j.id).invoiceId, inv.id, 'claims survive restore');
  assert.throws(() => db.restoreAll(d2, { hello: 1 }), /not a Fare backup/);
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
  // minimal syntactically-parseable JPEG: SOI + SOF0 (16×32) + EOI
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
