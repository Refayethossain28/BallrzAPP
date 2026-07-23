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
import { doc, getDoc, getDocs, collection, setDoc, updateDoc } from 'firebase/firestore';

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

test('a driver cannot forge an audit entry under another actor id', async () => {
  // Append is allowed only under your OWN actorUid — so a driver can't frame
  // an admin (or another driver) by writing their uid as the actor.
  await assertFails(setDoc(doc(driver('d1'), 'audit_log/f1'), { action: 'payout', actorUid: 'admin-1' }));
  await assertFails(setDoc(doc(driver('d1'), 'audit_log/f2'), { action: 'payout', actorUid: 'd2' }));
});

// ── Booking financials are frozen against self-service edits ─────────────────
test('a client cannot rewrite booking financials or the driver assignment', async () => {
  await seed((db) => setDoc(doc(db, 'bookings/bf1'),
    { clientId: 'client-a', baseFare: 185, price: 185, status: 'confirmed' }));
  // A benign self-edit (e.g. cancelling) is fine…
  await assertSucceeds(updateDoc(doc(client('client-a'), 'bookings/bf1'), { status: 'cancelled' }));
  // …but the money fields and the driver assignment are Cloud-Function-only.
  await assertFails(updateDoc(doc(client('client-a'), 'bookings/bf1'), { baseFare: 1 }));
  await assertFails(updateDoc(doc(client('client-a'), 'bookings/bf1'), { price: 1 }));
  await assertFails(updateDoc(doc(client('client-a'), 'bookings/bf1'), { paymentStatus: 'paid' }));
  await assertFails(updateDoc(doc(client('client-a'), 'bookings/bf1'), { driverId: 'client-a' }));
});

test('a driver cannot rewrite booking financials or the client rating', async () => {
  await seed((db) => setDoc(doc(db, 'bookings/bf2'),
    { clientId: 'client-a', driverId: 'd1', baseFare: 185, price: 185, status: 'accepted' }));
  // The assigned driver may progress the trip status…
  await assertSucceeds(updateDoc(doc(driver('d1'), 'bookings/bf2'), { status: 'en_route' }));
  // …but never the fare, nor the client's rating of them.
  await assertFails(updateDoc(doc(driver('d1'), 'bookings/bf2'), { price: 9999 }));
  await assertFails(updateDoc(doc(driver('d1'), 'bookings/bf2'), { driverRating: 5 }));
});

test('a driver claiming a free booking still cannot set the fare', async () => {
  await seed((db) => setDoc(doc(db, 'bookings/bf3'),
    { clientId: 'client-a', driverId: '', baseFare: 185, price: 185, status: 'confirmed' }));
  // Claiming (stamping self as driver) is allowed…
  await assertSucceeds(updateDoc(doc(driver('d1'), 'bookings/bf3'), { driverId: 'd1', status: 'accepted' }));
  // …but not while also inflating the fare.
  await seed((db) => setDoc(doc(db, 'bookings/bf4'),
    { clientId: 'client-a', driverId: '', baseFare: 185, price: 185, status: 'confirmed' }));
  await assertFails(updateDoc(doc(driver('d1'), 'bookings/bf4'), { driverId: 'd1', price: 9999 }));
});

// ── User profile: loyalty + identity fields are Cloud-Function-only ──────────
test('a user cannot self-mint loyalty balance, referral credit, or tier', async () => {
  await seed((db) => setDoc(doc(db, 'users/u2'), { name: 'U', role: 'client', apexBalance: 0 }));
  await assertSucceeds(updateDoc(doc(client('u2'), 'users/u2'), { name: 'New Name' }));
  await assertFails(updateDoc(doc(client('u2'), 'users/u2'), { apexBalance: 100000 }));
  await assertFails(updateDoc(doc(client('u2'), 'users/u2'), { tier: 'Black' }));
  await assertFails(updateDoc(doc(client('u2'), 'users/u2'), { referralCode: 'FREE' }));
  await assertFails(updateDoc(doc(client('u2'), 'users/u2'), { referredBy: 'someone' }));
  // …but an admin (Cloud Function proxy) may.
  await assertSucceeds(updateDoc(doc(admin(), 'users/u2'), { apexBalance: 500 }));
});

// ── Velvet: loyalty points are never self-awarded ───────────────────────────
test('a velvet member cannot self-award loyalty points', async () => {
  await assertFails(setDoc(doc(client('m1'), 'velvet_members/m1'), { name: 'M', points: 500 }));
  await assertSucceeds(setDoc(doc(client('m1'), 'velvet_members/m1'), { name: 'M', points: 0 }));
  await assertSucceeds(updateDoc(doc(client('m1'), 'velvet_members/m1'), { name: 'M2' }));
  await assertFails(updateDoc(doc(client('m1'), 'velvet_members/m1'), { points: 999 }));
  await assertSucceeds(updateDoc(doc(admin(), 'velvet_members/m1'), { points: 250 }));
});

// ── Launch-audit guards ──────────────────────────────────────────────────────

test('admins can create bookings for clients (ops console)', async () => {
  await assertSucceeds(setDoc(doc(admin(), 'bookings/adm1'), { clientId: 'admin-1', clientName: 'Walk-in', price: 185 }));
  // A client still can't create under someone else's id.
  await assertFails(setDoc(doc(client('c1'), 'bookings/adm2'), { clientId: 'c2' }));
});

test('drivers cannot read unassigned bookings (client PII protection)', async () => {
  await seed((db) => setDoc(doc(db, 'bookings/pii1'), { clientId: 'c1', clientEmail: 'x@y.z', pickup: '1 Home St', driverId: '' }));
  await assertFails(getDoc(doc(driver('d1'), 'bookings/pii1')));
  // …the assigned driver still reads their own job's booking.
  await seed((db) => setDoc(doc(db, 'bookings/pii2'), { clientId: 'c1', driverId: 'd1' }));
  await assertSucceeds(getDoc(doc(driver('d1'), 'bookings/pii2')));
});

test('drivers record is staff/self-only; GPS lives in driver_locations', async () => {
  await seed((db) => setDoc(doc(db, 'drivers/dx'), { name: 'D', payout: { accountId: 'acct_secret' } }));
  await assertFails(getDoc(doc(client('c1'), 'drivers/dx')));        // client can't read payout/compliance
  await assertSucceeds(getDoc(doc(driver('dx'), 'drivers/dx')));     // self
  await assertSucceeds(getDoc(doc(admin(), 'drivers/dx')));          // staff
  // Positions: driver writes own, any signed-in user reads (trip tracking).
  await assertSucceeds(setDoc(doc(driver('dx'), 'driver_locations/dx'), { lat: 51.5, lng: -0.12 }));
  await assertFails(setDoc(doc(driver('dx'), 'driver_locations/other'), { lat: 0, lng: 0 }));
  await assertSucceeds(getDoc(doc(client('c1'), 'driver_locations/dx')));
});

test('payout_requests: driver files their own, admin works the queue', async () => {
  await assertSucceeds(setDoc(doc(driver('d1'), 'payout_requests/p1'), { driverId: 'd1', amount: 320 }));
  await assertFails(setDoc(doc(driver('d1'), 'payout_requests/p2'), { driverId: 'd2', amount: 320 })); // not for another driver
  await assertFails(updateDoc(doc(driver('d1'), 'payout_requests/p1'), { status: 'approved' }));       // no self-approval
  await assertSucceeds(updateDoc(doc(admin(), 'payout_requests/p1'), { status: 'approved' }));
  await assertFails(getDoc(doc(driver('d2'), 'payout_requests/p1')));                                  // not another driver's
});

test('invites: a code can be checked by exact id pre-auth, but not enumerated', async () => {
  await seed((db) => setDoc(doc(db, 'invites/GOLD123'), { active: true }));
  await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'invites/GOLD123')));
  await assertFails(getDocs(collection(client('c1'), 'invites')));   // list stays admin-only
});

test('a subscriber cannot re-stamp their own trial end date', async () => {
  await seed((db) => setDoc(doc(db, 'subscriptions/s1'), { status: 'trial', trialEndsAt: '2026-08-01' }));
  await assertSucceeds(updateDoc(doc(client('s1'), 'subscriptions/s1'), { status: 'cancelled' }));
  await assertFails(updateDoc(doc(client('s1'), 'subscriptions/s1'), { trialEndsAt: '2099-01-01' }));
  await assertSucceeds(updateDoc(doc(admin(), 'subscriptions/s1'), { trialEndsAt: '2026-09-01' }));
});

test('corporates are ops-console-only', async () => {
  await assertFails(setDoc(doc(client('c1'), 'corporates/co1'), { name: 'Evil Corp' }));
  await assertSucceeds(setDoc(doc(admin(), 'corporates/co2'), { name: 'Real Corp' }));
});
