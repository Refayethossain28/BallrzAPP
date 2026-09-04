#!/usr/bin/env node
/**
 * Unit tests for docket/engine.js — the pure "deal with my paperwork"
 * engine behind Docket (document classification from typed key lines,
 * amount/due-date/reference extraction, the importance-ordered pile and
 * its triage bands, deadline states, the per-document briefing with
 * play-it-in-your-favour tips and discount-window savings, the drafted
 * letters that act on a document, and the assistant's pile digest) —
 * plus the pure helpers of docket/ai.js (tolerant JSON extraction from a
 * live model reply, clamping an AI reading into fields the engine can
 * trust, letter parsing, image-block encoding).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-docket-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'docket', 'engine.js'), 'utf8'), sandbox, { filename: 'docket/engine.js' });
const E = sandbox.module.exports;

const aiSandbox = { module: { exports: {} } };
aiSandbox.self = aiSandbox;
vm.createContext(aiSandbox);
vm.runInContext(readFileSync(join(ROOT, 'docket', 'ai.js'), 'utf8'), aiSandbox, { filename: 'docket/ai.js' });
const AI = aiSandbox.module.exports;

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04 12:00 UTC
const { DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

const FINE_TEXT = 'Penalty Charge Notice — contravention 01: parked in a restricted street. ' +
  'Reference: PCN/12345678. Amount due: £120.00. A discounted amount of £60.00 is payable ' +
  'if received within 14 days of the date of this notice.';

const doc = (over = {}) => ({
  id: 'd1', title: 'Fine / penalty — Camden Council', sender: 'Camden Council',
  category: 'fine', text: FINE_TEXT, amount: 120, currency: '£',
  dueDate: '2026-09-18', ref: 'PCN/12345678', escalation: null,
  status: 'open', ts: NOW - 2 * E.HOUR, photo: null, ...over,
});

/* ---------- text safety & calendar ---------- */
test('escapeHTML neutralises markup', () => {
  assert.equal(E.escapeHTML('<img src=x onerror=1>&"\''), '&lt;img src=x onerror=1&gt;&amp;&quot;&#39;');
});
test('parseISO validates real calendar dates only', () => {
  assert.equal(E.parseISO('2026-09-04'), Date.UTC(2026, 8, 4));
  assert.equal(E.parseISO('2026-02-31'), null);
  assert.equal(E.parseISO('nonsense'), null);
});
test('isoPlusDays crosses month boundaries; daysUntil counts calendar days', () => {
  assert.equal(E.isoPlusDays('2026-08-30', 5), '2026-09-04');
  assert.equal(E.daysUntil('2026-09-04', NOW), 0);
  assert.equal(E.daysUntil('2026-09-01', NOW), -3);
  assert.equal(E.daysUntil('2026-09-10', NOW), 6);
});
test('formatMoney: thousands separators, trimmed .00', () => {
  assert.equal(E.formatMoney(1234.5, '£'), '£1,234.50');
  assert.equal(E.formatMoney(120, '£'), '£120');
});

/* ---------- classification ---------- */
test('classifyDocument recognises a penalty notice with high confidence', () => {
  const c = E.classifyDocument(FINE_TEXT);
  assert.equal(c.key, 'fine');
  assert.equal(c.confidence, 'high');
  assert.ok(c.hits.includes('penalty charge'));
});
test('classifyDocument spans the playbook: debt, tax, medical, subscription, junk', () => {
  assert.equal(E.classifyDocument('FINAL DEMAND — your outstanding balance has been passed to collections').key, 'debt');
  assert.equal(E.classifyDocument('HMRC self assessment tax return reminder').key, 'tax');
  assert.equal(E.classifyDocument('Your hospital appointment: NHS referral to the clinic').key, 'medical');
  assert.equal(E.classifyDocument('Your membership will renew automatically on the renewal date').key, 'subscription');
  assert.equal(E.classifyDocument('EXCLUSIVE OFFER — you have been selected for our prize draw! Act now').key, 'junk');
});
test('classifyDocument: unknown text falls back to other/low', () => {
  const c = E.classifyDocument('a note from grandma about the garden');
  assert.equal(c.key, 'other');
  assert.equal(c.confidence, 'low');
});
test('escalationWords spots the language that jumps the queue', () => {
  assert.equal(E.escalationWords('this is your FINAL NOTICE before court'), 'final notice');
  assert.equal(E.escalationWords('have a lovely day'), null);
});

/* ---------- extraction: amounts, dates, references ---------- */
test('extractAmount prefers the amount next to due/total over bigger small print', () => {
  const a = E.extractAmount('Cover worth £5,000. Amount due: £120.00 plus admin fee £15');
  deepEq({ amount: a.amount, label: a.label }, { amount: 120, label: '£120' });
});
test('extractAmount: no context → the largest figure; none → null', () => {
  assert.equal(E.extractAmount('items at £20 and £75 listed').amount, 75);
  assert.equal(E.extractAmount('£1,234.56 subtotal here').amount, 1234.56);
  assert.equal(E.extractAmount('no money mentioned'), null);
});
test('extractDueDate reads wordy, US-style and numeric day-first dates', () => {
  assert.equal(E.extractDueDate('pay by 30 September 2026', NOW), '2026-09-30');
  assert.equal(E.extractDueDate('due September 30, 2026 at the latest', NOW), '2026-09-30');
  assert.equal(E.extractDueDate('payment due 30/09/2026', NOW), '2026-09-30');
  assert.equal(E.extractDueDate('deadline 30-09-26', NOW), '2026-09-30');
});
test('extractDueDate: "within 14 days" counts from the received day', () => {
  assert.equal(E.extractDueDate('payable within 14 days of the date of this notice', NOW), '2026-09-18');
});
test('extractDueDate: a "pay by" date outranks other dates; soonest wins among equals', () => {
  assert.equal(E.extractDueDate('issued 01/08/2026 — please pay by 15/09/2026', NOW), '2026-09-15');
  assert.equal(E.extractDueDate('hearing on 20/09/2026 or 10/09/2026', NOW), '2026-09-10');
  assert.equal(E.extractDueDate('the meeting of 31/02/2026 was cancelled', NOW), null);
  assert.equal(E.extractDueDate('no dates here at all', NOW), null);
});
test('extractReference finds the reference number', () => {
  assert.equal(E.extractReference(FINE_TEXT), 'PCN/12345678');
  assert.equal(E.extractReference('Account no: AB-99-1234 enclosed'), 'AB-99-1234');
  assert.equal(E.extractReference('no reference at all'), null);
});

/* ---------- adding a document ---------- */
test('validateDocument reads everything from the key lines', () => {
  const v = E.validateDocument({ text: FINE_TEXT, sender: 'Camden Council' }, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.doc.category, 'fine');
  assert.equal(v.doc.amount, 120);
  assert.equal(v.doc.dueDate, '2026-09-18'); // within 14 days of arrival
  assert.equal(v.doc.ref, 'PCN/12345678');
  assert.equal(v.doc.title, 'Fine / penalty — Camden Council');
  assert.equal(v.doc.status, 'open');
});
test('validateDocument: photo alone is enough; nothing at all is not', () => {
  assert.equal(E.validateDocument({ photo: 'data:image/jpeg;base64,x' }, NOW).ok, true);
  assert.equal(E.validateDocument({ text: '   ' }, NOW).ok, false);
});
test('validateDocument respects human overrides of category and due date', () => {
  const v = E.validateDocument({ text: FINE_TEXT, category: 'legal', dueDate: '2026-10-01' }, NOW);
  assert.equal(v.doc.category, 'legal');
  assert.equal(v.doc.dueDate, '2026-10-01');
});

/* ---------- deadlines & importance ---------- */
test('deadlineStatus bands: overdue / today / urgent / soon / ok / none', () => {
  assert.equal(E.deadlineStatus(doc({ dueDate: '2026-09-01' }), NOW).state, 'overdue');
  assert.equal(E.deadlineStatus(doc({ dueDate: '2026-09-04' }), NOW).state, 'today');
  assert.equal(E.deadlineStatus(doc({ dueDate: '2026-09-06' }), NOW).state, 'urgent');
  assert.equal(E.deadlineStatus(doc({ dueDate: '2026-09-10' }), NOW).state, 'soon');
  assert.equal(E.deadlineStatus(doc({ dueDate: '2026-10-20' }), NOW).state, 'ok');
  assert.equal(E.deadlineStatus(doc({ dueDate: null }), NOW).state, 'none');
});
test('importanceScore: deadline pressure, money and escalation all add up', () => {
  const base = E.importanceScore(doc({ dueDate: null, amount: null }), NOW).score;
  const withDue = E.importanceScore(doc({ dueDate: '2026-09-01', amount: null }), NOW).score;
  const withAll = E.importanceScore(doc({ dueDate: '2026-09-01', escalation: 'final notice' }), NOW).score;
  assert.ok(withDue > base, 'overdue adds pressure');
  assert.ok(withAll > withDue, 'money + escalation add more');
  const r = E.importanceScore(doc({ escalation: 'final notice' }), NOW).reasons;
  assert.ok(r.some((x) => x.label.includes('final notice')), 'escalation is a named reason');
});
test('importanceScore: dealt-with documents leave the race; snoozing dampens', () => {
  assert.equal(E.importanceScore(doc({ status: 'done' }), NOW).score, 0);
  const live = E.importanceScore(doc(), NOW).score;
  const snoozed = E.importanceScore(doc({ snoozedUntil: NOW + 3 * DAY }), NOW).score;
  assert.equal(snoozed, Math.round(live * 0.25));
});
test('triage orders the pile by importance and assigns bands', () => {
  const docs = [
    doc({ id: 'junk', category: 'junk', text: 'exclusive offer', amount: null, dueDate: null, ref: null }),
    doc({ id: 'fine', dueDate: '2026-09-01' }),                              // overdue → now
    doc({ id: 'bill', category: 'bill', amount: 80, dueDate: '2026-09-10' }), // soon → week
    doc({ id: 'old', status: 'done' }),
  ];
  const t = E.triage(docs, NOW);
  deepEq(t.map((e) => e.doc.id), ['fine', 'bill', 'junk', 'old']);
  deepEq(t.map((e) => e.band), ['now', 'week', 'later', 'done']);
});
test('triage is deterministic on ties (ts, then id)', () => {
  const a = doc({ id: 'a', ts: NOW - E.HOUR });
  const b = doc({ id: 'b', ts: NOW - E.HOUR });
  deepEq(E.triage([b, a], NOW).map((e) => e.doc.id), E.triage([a, b], NOW).map((e) => e.doc.id));
});

/* ---------- savings & the briefing ---------- */
test('potentialSaving: 50% fine discount inside 14 days of arrival, gone after', () => {
  const s = E.potentialSaving(doc({ ts: NOW }), NOW);
  assert.equal(s.save, 60);
  assert.equal(s.until, '2026-09-18');
  assert.equal(E.potentialSaving(doc({ ts: NOW - 20 * DAY }), NOW), null);
  assert.equal(E.potentialSaving(doc({ category: 'bill', ts: NOW }), NOW), null);
});
test('briefing explains the document and leads with the saving', () => {
  const b = E.briefing(doc({ ts: NOW }), NOW);
  assert.equal(b.category, 'Fine / penalty');
  assert.ok(b.what.length > 20 && b.why.length > 20);
  assert.ok(b.why.includes('£120'), 'money at stake surfaces in the why');
  assert.ok(b.favour[0].includes('50% discount window'), 'saving line leads the favour list');
  assert.ok(b.suggested.some((s) => s.kind === 'appeal'), 'suggests challenging it');
  assert.ok(b.deadlineLine.includes('14 days to play with'));
});
test('briefing flags escalation language and overdue deadlines', () => {
  const b = E.briefing(doc({ escalation: 'final notice', dueDate: '2026-09-01', ts: NOW - 20 * DAY }), NOW);
  assert.ok(b.why.includes('final notice'));
  assert.ok(b.deadlineLine.includes('deadline has passed'));
});

/* ---------- acting on it: drafted letters ---------- */
test('draftAction appeal: reference, amount, name and formal-representation line', () => {
  const d = E.draftAction(doc(), 'appeal', { name: 'Rafa Hossain' }, NOW);
  assert.equal(d.subject, 'Formal challenge — reference PCN/12345678');
  assert.ok(d.body.includes('4 September 2026'), 'dated today');
  assert.ok(d.body.includes('Dear Camden Council'));
  assert.ok(d.body.includes('£120'));
  assert.ok(d.body.includes('formal representation'));
  assert.ok(d.body.trim().endsWith('Rafa Hossain'));
});
test('draftAction query is a prove-it letter that admits nothing', () => {
  const d = E.draftAction(doc({ category: 'debt' }), 'query', {}, NOW);
  assert.ok(d.body.includes('do not acknowledge any liability'));
  assert.ok(d.body.includes('breakdown'));
  assert.ok(d.body.includes('[Your name]'), 'placeholder when no name given');
});
test('draftAction covers every kind a category can suggest; unknown kind → null', () => {
  for (const c of E.CATEGORIES) {
    for (const kind of c.actions) {
      const d = E.draftAction(doc({ category: c.key }), kind, { name: 'R' }, NOW);
      assert.ok(d && d.subject && d.body.length > 100, c.key + '/' + kind);
    }
  }
  assert.equal(E.draftAction(doc(), 'nonsense', {}, NOW), null);
});
test('mailtoLink encodes subject and body safely', () => {
  const link = E.mailtoLink({ subject: 'A & B', body: 'line1\nline2' }, 'x@y.com');
  assert.ok(link.startsWith('mailto:x%40y.com?subject=A%20%26%20B&body=line1%0Aline2'));
});

/* ---------- the digest ---------- */
test('assistantDigest counts the pile and points at the top item', () => {
  const docs = [
    doc({ id: 'fine', dueDate: '2026-09-01' }),
    doc({ id: 'bill', category: 'bill', amount: 80, dueDate: '2026-09-10' }),
    doc({ id: 'junk', category: 'junk', amount: null, dueDate: null }),
    doc({ id: 'won', status: 'done', savedAmount: 60 }),
  ];
  const g = E.assistantDigest(docs, NOW);
  deepEq({ open: g.open, overdue: g.overdue, dueSoon: g.dueSoon, done: g.done, atStake: g.atStake, saved: g.saved },
         { open: 3, overdue: 1, dueSoon: 1, done: 1, atStake: 200, saved: 60 });
  assert.equal(g.topId, 'fine');
  assert.ok(g.headline.includes('OVERDUE'));
  assert.ok(g.headline.includes('£60'), 'celebrates the saving');
});
test('assistantDigest: empty pile and fully-cleared pile speak differently', () => {
  assert.ok(E.assistantDigest([], NOW).headline.includes('first document'));
  assert.ok(E.assistantDigest([doc({ status: 'done' })], NOW).headline.includes('Pile clear'));
});

/* ---------- Docket AI: pure helpers ---------- */
test('AI extractJSON survives fences, prose and nested braces; garbage → null', () => {
  deepEq(AI.extractJSON('{"a":1}'), { a: 1 });
  deepEq(AI.extractJSON('Here you go:\n```json\n{"a":{"b":2}}\n```\nHope that helps!'), { a: { b: 2 } });
  deepEq(AI.extractJSON('prefix {"summary":"a fine","amount":60} suffix'), { summary: 'a fine', amount: 60 });
  assert.equal(AI.extractJSON('no json here at all'), null);
  assert.equal(AI.extractJSON(''), null);
});
test('AI normalizeAnalysis passes a clean reading through', () => {
  const n = AI.normalizeAnalysis({
    summary: 'A parking fine from Camden Council.', sender: ' Camden Council ',
    category: 'fine', amount: 130, currency: '£', due_date: '2026-09-18',
    reference: 'PCN/48291073', key_lines: 'Penalty Charge Notice…',
    advice: ['Pay within 14 days for 50% off', 'Check the signage'], scam_risk: 'none', scam_why: ''
  });
  assert.equal(n.category, 'fine');
  assert.equal(n.amount, 130);
  assert.equal(n.dueDate, '2026-09-18');
  assert.equal(n.sender, 'Camden Council');
  assert.equal(n.advice.length, 2);
  assert.equal(n.scamRisk, 'none');
});
test('AI normalizeAnalysis clamps junk: bad category/date/amount/enums, capped advice', () => {
  const n = AI.normalizeAnalysis({
    category: 'spaceship', amount: -5, currency: '¥', due_date: '2026-02-31',
    advice: ['ok', 42, '', 'a', 'b', 'c', 'd', 'e', 'f'], scam_risk: 'certain', reference: null
  });
  assert.equal(n.category, null);
  assert.equal(n.amount, null);
  assert.equal(n.currency, '£');
  assert.equal(n.dueDate, null);
  assert.equal(n.ref, null);
  assert.equal(n.scamRisk, 'none');
  assert.equal(n.advice.length, 6, 'advice capped and junk-filtered');
  assert.ok(!n.advice.includes(''));
  assert.equal(AI.normalizeAnalysis(null).summary, '', 'null-safe');
});
test('AI parseLetter splits the SUBJECT line; falls back without one', () => {
  const l = AI.parseLetter('SUBJECT: Formal challenge — PCN/1\n\nDear Sir,\n\nBody here.');
  assert.equal(l.subject, 'Formal challenge — PCN/1');
  assert.ok(l.body.startsWith('Dear Sir,'));
  assert.equal(AI.parseLetter('just a body').subject, 'Regarding your recent letter');
});
test('AI docContext carries the document facts; imageBlock encodes only real data URLs', () => {
  const ctx = AI.docContext(doc());
  assert.ok(ctx.includes('Camden Council') && ctx.includes('£120') && ctx.includes('PCN/12345678') && ctx.includes('2026-09-18'));
  const b = AI.imageBlock('data:image/jpeg;base64,abc123');
  deepEq(b, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' } });
  assert.equal(AI.imageBlock('http://x/y.jpg'), null);
  assert.equal(AI.imageBlock(null), null);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exit(1);
  }
}
console.log(`\n${passed}/${tests.length} docket logic tests passed`);
