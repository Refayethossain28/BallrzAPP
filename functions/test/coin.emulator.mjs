/**
 * Emulator integration test: the ApexCoin ledger, run for real.
 *
 * Boots the actual triggers + callables in the Functions emulator and walks the
 * whole coin lifecycle:
 *   1. A confirmed booking awards the client their TIER's % (awardBookingCoins,
 *      Bronze 3% by default) — once, even when the trigger fires again
 *      (deterministic ledger id). A Silver balance earns at 4%.
 *   2. redeemApexCoins (called as the signed-in client, over the emulator's
 *      callable HTTP surface) clamps to the balance, deducts transactionally,
 *      and is idempotent per bookingRef.
 *   3. A booking that carried a redemption earns on the CASH portion only.
 *   4. Completing a trip pays the driver AND credits 2% AXC — once.
 *   5. redeemDriverCoins zeroes the wallet and lands the £ in driver_payouts
 *      as 'owed' — the rail payoutDriver settles.
 *
 * Run:  npm run test:emulator:coin   (from functions/)
 */
import admin from 'firebase-admin';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
const FUNCTIONS_ORIGIN = process.env.FUNCTIONS_EMULATOR_ORIGIN || 'http://127.0.0.1:5001';
admin.initializeApp({ projectId: 'demo-apexvip' });
const db = admin.firestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const check = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

/** Poll until `fn` returns truthy (trigger side-effects are async). */
async function waitFor(fn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

/** An unsigned (alg:none) JWT the Auth-less Functions emulator accepts as `request.auth`. */
function emulatorToken(uid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: 'https://securetoken.google.com/demo-apexvip', aud: 'demo-apexvip',
    iat: now, exp: now + 3600, auth_time: now, sub: uid, user_id: uid, uid,
    firebase: { identities: {}, sign_in_provider: 'custom' },
  })}.`;
}

/** Invoke a callable the way the SDK does: POST {data} to the emulator URL. */
async function call(name, uid, data) {
  const res = await fetch(`${FUNCTIONS_ORIGIN}/demo-apexvip/us-central1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${emulatorToken(uid)}` },
    body: JSON.stringify({ data: data ?? {} }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${name} ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.result;
}

async function main() {
  // ── 1. A confirmed booking awards the client 5%, exactly once ─────────────
  console.log('→ booking → client coin award (awardBookingCoins)…');
  await db.doc('users/coin-client').set({ role: 'client', name: 'Coin Client' });
  const bookingA = await db.collection('bookings').add({
    ref: 'APX-COIN1', status: 'confirmed', clientId: 'coin-client',
    pickup: 'Mayfair', dropoff: 'Heathrow T5', location: 'london',
    baseFare: 200, price: 200,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const earnRow = await waitFor(async () => {
    const s = await db.doc(`coin_ledger/earn_${bookingA.id}`).get();
    return s.exists ? s.data() : null;
  });
  check(!!earnRow, 'earn ledger row created by the trigger');
  if (earnRow) check(earnRow.amount === 6, `client earned Bronze 3% of £200 = 6 APEX (got ${earnRow.amount})`);
  if (earnRow) check(/Bronze 3%/.test(earnRow.reason), `ledger reason names the tier + rate (got "${earnRow.reason}")`);
  let user = (await db.doc('users/coin-client').get()).data();
  check(user.apexBalance === 6, `users/{uid}.apexBalance is 6 (got ${user.apexBalance})`);

  // ── 2. redeemApexCoins: clamped, transactional, idempotent ────────────────
  console.log('→ redeemApexCoins as the signed-in client…');
  const r1 = await call('redeemApexCoins', 'coin-client', { amount: 999, bookingRef: 'APX-COIN2' });
  check(r1.redeemed === 6, `redemption clamped to the balance: 6 (got ${r1.redeemed})`);
  check(r1.balance === 0, `balance after redemption is 0 (got ${r1.balance})`);
  const r2 = await call('redeemApexCoins', 'coin-client', { amount: 999, bookingRef: 'APX-COIN2' });
  check(r2.redeemed === 6, `a retried redemption is idempotent (got ${r2.redeemed})`);
  user = (await db.doc('users/coin-client').get()).data();
  check(user.apexBalance === 0, `retry did not double-deduct (balance ${user.apexBalance})`);

  // ── 3. The redeemed booking earns on the cash portion only ────────────────
  console.log('→ booking paid partly with APEX earns on the cash portion…');
  const bookingB = await db.collection('bookings').add({
    ref: 'APX-COIN2', status: 'confirmed', clientId: 'coin-client',
    pickup: 'Soho', dropoff: 'Gatwick', location: 'london',
    baseFare: 100, price: 100, apexRedeemed: 6,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const earnB = await waitFor(async () => {
    const s = await db.doc(`coin_ledger/earn_${bookingB.id}`).get();
    return s.exists ? s.data() : null;
  });
  check(!!earnB, 'second earn ledger row created');
  if (earnB) check(earnB.amount === 3, `earn is Bronze 3% of the £94 cash portion = 3 (round(2.82)) — got ${earnB.amount}`);

  // ── 3b. A higher tier earns at its own rate ────────────────────────────────
  console.log('→ a Silver member earns at 4%…');
  await db.doc('users/coin-silver').set({ role: 'client', apexBalance: 600 }); // Silver tier
  const bookingC = await db.collection('bookings').add({
    ref: 'APX-COIN3', status: 'confirmed', clientId: 'coin-silver',
    pickup: 'Knightsbridge', dropoff: 'Luton', location: 'london',
    baseFare: 200, price: 200,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const earnC = await waitFor(async () => {
    const s = await db.doc(`coin_ledger/earn_${bookingC.id}`).get();
    return s.exists ? s.data() : null;
  });
  check(earnC && earnC.amount === 8, `Silver earned 4% of £200 = 8 APEX (got ${earnC && earnC.amount})`);
  const silver = (await db.doc('users/coin-silver').get()).data();
  check(silver.apexBalance === 608, `Silver balance is 608 (got ${silver.apexBalance})`);

  // ── 4. Trip completion pays the driver and credits 2% AXC, once ───────────
  console.log('→ completing the trip credits the driver 2% AXC…');
  await db.doc('drivers/coin-driver').set({ name: 'Coin Driver', reg: 'AX24 CON' });
  await bookingA.update({ driverId: 'coin-driver', driverName: 'Coin Driver', status: 'completed' });
  const drvRow = await waitFor(async () => {
    const s = await db.doc(`coin_ledger/driverearn_${bookingA.id}`).get();
    return s.exists ? s.data() : null;
  });
  check(!!drvRow, 'driver earn ledger row created on completion');
  if (drvRow) check(drvRow.amount === 3.2, `driver earned 2% of £160 pay = 3.2 AXC (got ${drvRow.amount})`);
  let drv = (await db.doc('drivers/coin-driver').get()).data();
  check(drv.apexcoin === 3.2, `drivers/{uid}.apexcoin is 3.2 (got ${drv.apexcoin})`);
  const payoutA = await waitFor(async () => {
    const s = await db.doc(`driver_payouts/${bookingA.id}`).get();
    return s.exists ? s.data() : null;
  });
  check(payoutA && payoutA.amount === 160, 'trip payout row still lands as before (£160 owed)');

  // Idempotency: re-touch the completed booking — no double award.
  await bookingA.update({ note: 'touched' });
  await sleep(1500);
  drv = (await db.doc('drivers/coin-driver').get()).data();
  check(drv.apexcoin === 3.2, `re-fired trigger did not double-award (still 3.2, got ${drv.apexcoin})`);

  // ── 5. redeemDriverCoins → wallet zeroed, £ owed on the payout rail ───────
  console.log('→ redeemDriverCoins cashes out onto the payout rail…');
  const dr = await call('redeemDriverCoins', 'coin-driver');
  check(dr.redeemed === 3.2, `driver cashed out 3.2 AXC (got ${dr.redeemed})`);
  drv = (await db.doc('drivers/coin-driver').get()).data();
  check(drv.apexcoin === 0, `driver wallet is zero after cash-out (got ${drv.apexcoin})`);
  const owed = await db.collection('driver_payouts')
    .where('driverId', '==', 'coin-driver').where('status', '==', 'owed').get();
  const cashout = owed.docs.map((d) => d.data()).find((p) => p.bookingRef === 'AXC redemption');
  check(!!cashout && cashout.amount === 3.2, 'a £3.20 "AXC redemption" row is owed in driver_payouts');
  const dr2 = await call('redeemDriverCoins', 'coin-driver');
  check(dr2.redeemed === 0, `an empty wallet cashes out nothing (got ${dr2.redeemed})`);
}

main()
  .then(() => { console.log(failed ? '\nCOIN TEST FAILED' : '\nCOIN TEST PASSED'); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error('error:', e?.message || e); process.exit(1); });
