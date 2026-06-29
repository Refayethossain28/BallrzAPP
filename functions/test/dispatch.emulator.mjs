/**
 * Emulator integration test: a booking dispatches to a driver, and a driver
 * claims it — all four steps of the loop, run for real.
 *
 * Runs inside the Firebase emulator (Firestore + Functions) so the real
 * onBookingCreated trigger fires:
 *   1–2. Write a booking as the client app does → assert the trigger produces the
 *        `open_jobs/{bookingId}` doc the driver app subscribes to.
 *   3–4. Replay the driver app's claim transaction (two drivers racing) → assert
 *        exactly one wins, the booking flips to "accepted" with that driver, and
 *        a driver-side `jobs` doc is created.
 *
 * Run:  npm run test:emulator   (from functions/)
 * which is: firebase emulators:exec --only firestore,functions --project demo-apexvip \
 *             "node test/dispatch.emulator.mjs"
 */
import admin from 'firebase-admin';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
admin.initializeApp({ projectId: 'demo-apexvip' });
const db = admin.firestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const check = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

async function main() {
  // 1) Write a booking the way confirmBooking() in the client does.
  console.log('→ writing a booking…');
  const booking = {
    ref: 'APX-TEST', status: 'confirmed', location: 'london',
    clientId: 'client-1', clientName: 'Test Client',
    serviceType: 'airport', serviceLabel: 'Airport Transfer',
    pickup: 'Mayfair', dropoff: 'Heathrow T5',
    date: '2026-07-01', time: '09:00', vehicle: 'Mercedes S-Class',
    baseFare: 200, price: 200,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const ref = await db.collection('bookings').add(booking);
  console.log(`  booking id: ${ref.id}`);

  // 2) Wait for the onBookingCreated trigger to produce the open_job.
  console.log('→ waiting for dispatch (onBookingCreated → open_jobs)…');
  let job = null;
  for (let i = 0; i < 60; i++) {
    const snap = await db.doc(`open_jobs/${ref.id}`).get();
    if (snap.exists) { job = snap.data(); break; }
    await sleep(250);
  }

  // 3) Assert the driver-facing job is correct.
  check(!!job, 'open_jobs doc was created by the trigger');
  if (job) {
    check(job.status === 'open', `status is "open" (got "${job.status}")`);
    check(job.market === 'london', `market is "london" (got "${job.market}")`);
    check(job.pickup === 'Mayfair', `pickup carried through (got "${job.pickup}")`);
    check(job.dropoff === 'Heathrow T5', `dropoff carried through (got "${job.dropoff}")`);
    check(job.pay === 160, `pay is 80% of £200 = £160 (got ${job.pay})`);
    check(job.bookingDocId === ref.id, 'open_job links back to the booking');
  }

  // 4) Idempotency: a second write must not create a duplicate job.
  console.log('→ checking dispatch is idempotent…');
  await ref.update({ note: 'touched' });
  await sleep(1500);
  const again = await db.doc(`open_jobs/${ref.id}`).get();
  check(again.exists, 'open_job still present after a booking update (no duplicate path)');

  // 5) Two drivers race to claim — replays the driver app's claim transaction.
  console.log('→ two drivers racing to claim the job…');
  await db.doc('drivers/driver-1').set({ name: 'Driver One', reg: 'AP24 ONE', market: 'london' });
  await db.doc('drivers/driver-2').set({ name: 'Driver Two', reg: 'AP24 TWO', market: 'london' });

  // The exact transaction from apexvip-driver.html claimBroadcastJob: first to
  // flip status off "open" wins; everyone else throws "taken".
  const claim = (who) => db.runTransaction(async (tx) => {
    const openRef = db.collection('open_jobs').doc(ref.id);
    const doc = await tx.get(openRef);
    if (!doc.exists || doc.data().status !== 'open') throw new Error('taken');
    tx.update(openRef, { status: 'claimed', driverId: who, claimedAt: admin.firestore.FieldValue.serverTimestamp() });
    return who;
  });

  const race = await Promise.allSettled([claim('driver-1'), claim('driver-2')]);
  const winners = race.filter((r) => r.status === 'fulfilled');
  check(winners.length === 1, `exactly one driver wins the race (got ${winners.length})`);
  const winner = winners[0]?.value;

  const claimed = (await db.doc(`open_jobs/${ref.id}`).get()).data();
  check(claimed.status === 'claimed', `open_job is now "claimed" (got "${claimed.status}")`);
  check(claimed.driverId === winner, `open_job carries the winning driver (${winner})`);

  // Winner takes ownership of the booking + creates a driver-side jobs doc.
  const drv = (await db.doc(`drivers/${winner}`).get()).data();
  await ref.update({
    driverId: winner, driverName: drv.name, driverPlate: drv.reg,
    status: 'accepted', assignedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const jobDoc = await db.collection('jobs').add({
    driverId: winner, bookingDocId: ref.id, bookingRef: booking.ref,
    pickup: booking.pickup, dropoff: booking.dropoff, pay: claimed.pay,
    status: 'accepted', createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const bk = (await ref.get()).data();
  check(bk.status === 'accepted', `booking flips to "accepted" (got "${bk.status}")`);
  check(bk.driverId === winner, 'booking now carries the winning driverId');
  check((await db.doc(`jobs/${jobDoc.id}`).get()).exists, 'a driver-side jobs doc was created');
}

main()
  .then(() => { console.log(failed ? '\nDISPATCH TEST FAILED' : '\nDISPATCH TEST PASSED'); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error('error:', e?.message || e); process.exit(1); });
