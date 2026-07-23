/**
 * ApexVIP — one-off Firebase bootstrap.
 *
 * Seeds the live pricing document and creates the demo accounts (client, driver,
 * admin) with profiles + custom claims, so a freshly-configured project works
 * end-to-end. Idempotent: safe to re-run.
 *
 * Auth: uses Application Default Credentials. Point GOOGLE_APPLICATION_CREDENTIALS
 * at a service-account JSON for the target project, then:
 *
 *   cd firebase-setup
 *   npm install
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json npm run seed
 *
 * Optionally set DEMO_PASSWORD (default "password") and APEX_PROJECT_ID.
 */
import admin from 'firebase-admin';

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: process.env.APEX_PROJECT_ID || undefined,
});

const db = admin.firestore();
const auth = admin.auth();
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'password';

// Matches the PRICES defaults in apexvip-client.html — the app reads settings/pricing
// and overrides its built-in defaults from here, so you can tune fares without a deploy.
const PRICING = {
  airport_s: 185, airport_v: 225,
  heathrow_s: 185, heathrow_v: 225,
  gatwick_s: 195, gatwick_v: 235,
  stansted_s: 195, stansted_v: 235,
  luton_s: 185, luton_v: 225,
  city_s: 125, city_v: 155,
  hourly_s_rate: 65, hourly_v_rate: 75,
  day_s: 450, day_v: 550,
  evening_supplement: 50, peak_surcharge_pct: 15,
  membership: 199,
  base_s: 10, per_km_s: 2.20, per_min_s: 0.32, min_fare_s: 38,
  base_v: 13, per_km_v: 2.75, per_min_v: 0.40, min_fare_v: 50,
  cc_charge: 15,
};

const ACCOUNTS = [
  { email: 'client@apexvip.com', name: 'Alexandra Stone', role: 'client', claims: {} },
  { email: 'driver@apexvip.com', name: 'James Harrison', role: 'driver', claims: { driver: true } },
  { email: 'admin@apexvip.com', name: 'ApexVIP Ops', role: 'admin', claims: { admin: true } },
];

async function ensureUser(a) {
  let user;
  try {
    user = await auth.getUserByEmail(a.email);
  } catch {
    user = await auth.createUser({ email: a.email, password: DEMO_PASSWORD, displayName: a.name, emailVerified: true });
    console.log(`  created auth user ${a.email}`);
  }
  if (Object.keys(a.claims).length) await auth.setCustomUserClaims(user.uid, a.claims);
  await db.collection('users').doc(user.uid).set({
    name: a.name, email: a.email, role: a.role, tier: 'standard', bookings: 0, spent: 0,
    joined: new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return user.uid;
}

async function main() {
  await db.collection('settings').doc('pricing').set(PRICING, { merge: true });
  console.log('✓ settings/pricing seeded');

  for (const a of ACCOUNTS) {
    const uid = await ensureUser(a);
    console.log(`✓ ${a.role.padEnd(6)} ${a.email}  (${uid})  claims: ${JSON.stringify(a.claims)}`);
  }
  console.log(`\nDone. Demo password: "${DEMO_PASSWORD}" — change it before any real use.`);
  process.exit(0);
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
