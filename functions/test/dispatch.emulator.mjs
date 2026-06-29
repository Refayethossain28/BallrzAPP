/**
 * Emulator integration test: a booking actually dispatches to a driver.
 *
 * Runs inside the Firebase emulator (Firestore + Functions) so the real
 * onBookingCreated trigger fires. We write a booking exactly as the client app
 * does, then assert an `open_jobs/{bookingId}` doc appears — the document the
 * driver app subscribes to — with the right market, pickup and 80% pay.
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
}

main()
  .then(() => { console.log(failed ? '\nDISPATCH TEST FAILED' : '\nDISPATCH TEST PASSED'); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error('error:', e?.message || e); process.exit(1); });
