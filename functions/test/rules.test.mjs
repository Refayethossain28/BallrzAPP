/**
 * Firestore security-rules tests (firestore.rules) against the emulator.
 *
 * These assert the access guarantees the app depends on: a client can't read
 * another client's booking, a user can't self-promote to admin, a driver can't
 * self-approve compliance/payouts or inflate a job's pay, and the payout ledger
 * is admin-write-only. Run:  npm run test:rules
 * which boots the Firestore emulator and runs this with node --test.
 */
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

let env;
const client = (uid) => env.authenticatedContext(uid).firestore();
const admin = () => env.authenticatedContext('admin-1', { admin: true }).firestore();
const driver = (uid) => env.authenticatedContext(uid, { driver: true }).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-apexvip',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));

// ── Bookings: a client owns only their own ──────────────────────────────────
test('a client can read their own booking but not another client\'s', async () => {
  await seed((db) => setDoc(doc(db, 'bookings/b1'), { clientId: 'client-a', pickup: 'Mayfair' }));
  await assertSucceeds(getDoc(doc(client('client-a'), 'bookings/b1')));
  await assertFails(getDoc(doc(client('client-b'), 'bookings/b1')));
});

test('a client cannot create a booking under someone else\'s clientId', async () => {
  await assertSucceeds(setDoc(doc(client('client-a'), 'bookings/mine'), { clientId: 'client-a' }));
  await assertFails(setDoc(doc(client('client-a'), 'bookings/theirs'), { clientId: 'client-b' }));
});

// ── Privilege escalation: the create-role hole this PR fixed ─────────────────
test('a user cannot self-create their profile as admin (the fixed hole)', async () => {
  await assertFails(setDoc(doc(client('eve'), 'users/eve'), { name: 'Eve', role: 'admin' }));
  await assertFails(setDoc(doc(client('eve'), 'users/eve'), { name: 'Eve', role: 'driver' }));
  await assertSucceeds(setDoc(doc(client('eve'), 'users/eve'), { name: 'Eve' }));            // no role
  await assertSucceeds(setDoc(doc(client('eve2'), 'users/eve2'), { name: 'Eve', role: 'client' }));
});

test('a user cannot self-promote on update; an admin can set roles', async () => {
  await seed((db) => setDoc(doc(db, 'users/u1'), { name: 'U', role: 'client' }));
  await assertFails(updateDoc(doc(client('u1'), 'users/u1'), { role: 'admin' }));
  await assertSucceeds(updateDoc(doc(admin(), 'users/u1'), { role: 'driver' }));
});

// ── Driver self-approval guard ──────────────────────────────────────────────
test('a driver may update their own profile but not compliance/payout', async () => {
  await seed((db) => setDoc(doc(db, 'drivers/d1'), { name: 'Driver', status: 'offline' }));
  await assertSucceeds(updateDoc(doc(driver('d1'), 'drivers/d1'), { status: 'online' }));
  await assertFails(updateDoc(doc(driver('d1'), 'drivers/d1'), { compliance: { compliant: true } }));
  await assertFails(updateDoc(doc(driver('d1'), 'drivers/d1'), { payout: { payoutsEnabled: true } }));
  await assertSucceeds(updateDoc(doc(admin(), 'drivers/d1'), { compliance: { compliant: true } }));
});

// ── Payout ledger: admin-write-only, driver reads only their own ────────────
test('payout ledger is admin-write-only and per-driver readable', async () => {
  await seed((db) => setDoc(doc(db, 'driver_payouts/p1'), { driverId: 'd1', amount: 160, status: 'owed' }));
  await assertSucceeds(getDoc(doc(driver('d1'), 'driver_payouts/p1')));
  await assertFails(getDoc(doc(driver('d2'), 'driver_payouts/p1')));
  await assertFails(updateDoc(doc(driver('d1'), 'driver_payouts/p1'), { status: 'paid' }));
  await assertSucceeds(updateDoc(doc(admin(), 'driver_payouts/p1'), { status: 'paid' }));
});

// ── open_jobs claim guard ───────────────────────────────────────────────────
test('a driver may claim an open job but not inflate pay or claim for another', async () => {
  const base = { status: 'open', driverId: '', bookingDocId: 'b1', bookingRef: 'APX-1', pay: 160, market: 'london' };
  await seed((db) => setDoc(doc(db, 'open_jobs/j1'), base));
  // legit claim
  await assertSucceeds(updateDoc(doc(driver('d1'), 'open_jobs/j1'), { status: 'claimed', driverId: 'd1' }));
  // inflate pay
  await seed((db) => setDoc(doc(db, 'open_jobs/j2'), base));
  await assertFails(updateDoc(doc(driver('d1'), 'open_jobs/j2'), { status: 'claimed', driverId: 'd1', pay: 9999 }));
  // claim for someone else
  await seed((db) => setDoc(doc(db, 'open_jobs/j3'), base));
  await assertFails(updateDoc(doc(driver('d1'), 'open_jobs/j3'), { status: 'claimed', driverId: 'd2' }));
  // can't re-claim an already-claimed job
  await seed((db) => setDoc(doc(db, 'open_jobs/j4'), { ...base, status: 'claimed', driverId: 'd2' }));
  await assertFails(updateDoc(doc(driver('d1'), 'open_jobs/j4'), { status: 'claimed', driverId: 'd1' }));
});

// ── settings + audit log ────────────────────────────────────────────────────
test('pricing is world-readable but admin-write-only', async () => {
  await seed((db) => setDoc(doc(db, 'settings/pricing'), { day_v: 550 }));
  await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'settings/pricing')));
  await assertFails(setDoc(doc(client('anyone'), 'settings/pricing'), { day_v: 1 }));
  await assertSucceeds(setDoc(doc(admin(), 'settings/pricing'), { day_v: 600 }));
});

test('audit log is append-only (no edits or deletes, even by admin)', async () => {
  await assertSucceeds(setDoc(doc(driver('d1'), 'audit_log/e1'), { action: 'claim', actorUid: 'd1' }));
  await assertFails(setDoc(doc(client('c1'), 'audit_log/e2'), { action: 'x' }));        // client can't write
  await seed((db) => setDoc(doc(db, 'audit_log/e3'), { action: 'payout' }));
  await assertFails(updateDoc(doc(admin(), 'audit_log/e3'), { action: 'tampered' }));   // no edits
});

// ── Concierge (velvet_*): membership entitlements + request ownership ───────
test('a member owns their velvet_members doc; others cannot read it', async () => {
  await assertSucceeds(setDoc(doc(client('m1'), 'velvet_members/m1'),
    { memberName: 'Rafa', billing: 'local', sub: { tierId: 'gold', status: 'trialing' } }));
  await assertSucceeds(getDoc(doc(client('m1'), 'velvet_members/m1')));
  await assertFails(getDoc(doc(client('m2'), 'velvet_members/m1')));
  await assertSucceeds(getDoc(doc(admin(), 'velvet_members/m1')));
});

test('a member cannot create their doc already claiming Stripe billing', async () => {
  await assertFails(setDoc(doc(client('m1'), 'velvet_members/m1'),
    { billing: 'stripe', sub: { tierId: 'black', status: 'active' } }));
});

test('once the webhook owns billing, a member cannot change their entitlement', async () => {
  const stripeSub = { tierId: 'silver', status: 'active', periodEnd: 1 };
  await seed((db) => setDoc(doc(db, 'velvet_members/m1'),
    { memberName: 'Rafa', points: 10, billing: 'stripe', sub: stripeSub, stripeCustomerId: 'cus_1' }));
  // self-granting a tier: blocked
  await assertFails(updateDoc(doc(client('m1'), 'velvet_members/m1'),
    { sub: { tierId: 'black', status: 'active', periodEnd: 1 } }));
  // flipping billing back to local: blocked
  await assertFails(updateDoc(doc(client('m1'), 'velvet_members/m1'), { billing: 'local' }));
  // updating harmless profile fields while keeping Stripe truth intact: fine
  await assertSucceeds(updateDoc(doc(client('m1'), 'velvet_members/m1'), { memberName: 'R', points: 20 }));
  // and on LOCAL billing the simulation may update its own sub freely
  await seed((db) => setDoc(doc(db, 'velvet_members/m2'),
    { billing: 'local', sub: { tierId: 'silver', status: 'trialing' } }));
  await assertSucceeds(updateDoc(doc(client('m2'), 'velvet_members/m2'),
    { sub: { tierId: 'gold', status: 'active' } }));
});

test('demo invoices are member-writable only until Stripe takes over', async () => {
  await seed((db) => setDoc(doc(db, 'velvet_members/m1'), { billing: 'local' }));
  await assertSucceeds(setDoc(doc(client('m1'), 'velvet_members/m1/invoices/i1'), { amountPence: 4900 }));
  await seed((db) => setDoc(doc(db, 'velvet_members/m3'), { billing: 'stripe' }));
  await assertFails(setDoc(doc(client('m3'), 'velvet_members/m3/invoices/i1'), { amountPence: 1 }));
});

test('concierge requests: owner-scoped; the desk (admin) works them', async () => {
  await assertSucceeds(setDoc(doc(client('m1'), 'velvet_requests/r1'),
    { ownerUid: 'm1', title: 'Table', status: 'submitted' }));
  await assertFails(setDoc(doc(client('m1'), 'velvet_requests/r2'), { ownerUid: 'm2' })); // forged owner
  await assertFails(getDoc(doc(client('m2'), 'velvet_requests/r1')));                     // not theirs
  await assertSucceeds(getDoc(doc(admin(), 'velvet_requests/r1')));
  await assertSucceeds(updateDoc(doc(admin(), 'velvet_requests/r1'), { status: 'triaged' }));
  // owner may update their request but never reassign it
  await assertSucceeds(updateDoc(doc(client('m1'), 'velvet_requests/r1'), { title: 'Table for four' }));
  await assertFails(updateDoc(doc(client('m1'), 'velvet_requests/r1'), { ownerUid: 'm2' }));
});
