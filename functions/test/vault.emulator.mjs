/**
 * Emulator integration test: Vault Online — the digital bank's server side,
 * driven through the real callables the app calls.
 *
 * The loop that matters, run for real against Firestore + Functions emulators:
 *   1. Two people open banks (vaultOpen) → unique rails, £250 welcome each,
 *      idempotent on re-call.
 *   2. Confirmation of payee (vaultLookup) resolves rails to a name.
 *   3. Alice pays Bob (vaultSend) → both ledgers move atomically, Bob's
 *      money arrives, Alice's contact book learns Bob.
 *   4. The gates hold server-side: overdrawing bounces, a frozen card
 *      declines a purchase, a stranger without auth gets nothing.
 *
 * Run:  npm run test:emulator   (from functions/; boots both suites)
 */
import admin from 'firebase-admin';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-apexvip' });
const db = admin.firestore();

const FN_BASE = 'http://127.0.0.1:5001/demo-apexvip/us-central1';

let failed = false;
const check = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

/** Unsigned dev JWT — the Functions emulator decodes it without verifying. */
function fakeToken(uid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'none', typ: 'JWT' }) + '.' +
         b64({ sub: uid, user_id: uid, aud: 'demo-apexvip', iss: 'https://securetoken.google.com/demo-apexvip' }) + '.';
}

/** Call a callable like the browser SDK does; returns { ok, data, code, message }. */
async function call(name, uid, data) {
  const res = await fetch(`${FN_BASE}/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(uid ? { authorization: 'Bearer ' + fakeToken(uid) } : {}),
    },
    body: JSON.stringify({ data: data || {} }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.result !== undefined) return { ok: true, data: body.result };
  return { ok: false, code: body.error?.status, message: body.error?.message };
}

const bank = async (uid) => (await db.doc(`vaultBanks/${uid}`).get()).data();
const balance = (state, id) => state.txns.reduce((b, t) => b + (t.to === id ? t.amount : 0) - (t.from === id ? t.amount : 0), 0);

async function main() {
  console.log('→ two people open banks…');
  const a1 = await call('vaultOpen', 'alice', { name: 'Alice Tester' });
  check(a1.ok && a1.data.existed === false, 'vaultOpen creates Alice\'s bank');
  const a2 = await call('vaultOpen', 'alice', { name: 'Alice Again' });
  check(a2.ok && a2.data.existed === true, 'vaultOpen is idempotent');
  const b1 = await call('vaultOpen', 'bob', { name: 'Bob Recipient' });
  check(b1.ok && b1.data.existed === false, 'vaultOpen creates Bob\'s bank');

  let alice = await bank('alice');
  const bobBefore = await bank('bob');
  check(balance(alice, 'current') === 25000, `Alice starts with the £250 welcome (got ${balance(alice, 'current')}p)`);
  check(/^GB\d{2}VAUL\d{14}$/.test(alice.iban), 'Alice\'s IBAN has the Vault shape');
  check(alice.sortCode !== bobBefore.sortCode || alice.accountNumber !== bobBefore.accountNumber, 'rails are unique');
  const railDoc = await db.doc(`vaultRails/${alice.sortCode.replace(/\D/g, '')}-${alice.accountNumber}`).get();
  check(railDoc.exists && railDoc.data().uid === 'alice', 'rails directory maps back to Alice');

  console.log('→ confirmation of payee…');
  const cop = await call('vaultLookup', 'alice', { sortCode: bobBefore.sortCode, accountNumber: bobBefore.accountNumber });
  check(cop.ok && cop.data.found && cop.data.name === 'Bob Recipient', `lookup names the payee (got ${JSON.stringify(cop.data)})`);
  const copMiss = await call('vaultLookup', 'alice', { sortCode: '99-99-99', accountNumber: '00000001' });
  check(copMiss.ok && copMiss.data.found === false, 'lookup of unknown rails says not found');

  console.log('→ Alice pays Bob £40…');
  const send = await call('vaultSend', 'alice', {
    toSortCode: bobBefore.sortCode, toAccountNumber: bobBefore.accountNumber, amount: 4000, reference: 'Lunch',
  });
  check(send.ok && send.data.toName === 'Bob Recipient', 'vaultSend succeeds and confirms the payee name');
  alice = await bank('alice');
  const bob = await bank('bob');
  check(balance(alice, 'current') === 21000, `Alice is down £40 (got ${balance(alice, 'current')}p)`);
  check(balance(bob, 'current') === 29000, `Bob is up £40 (got ${balance(bob, 'current')}p)`);
  check(bob.txns.some((t) => t.desc === 'From Alice Tester · Lunch'), 'Bob\'s ledger says who paid and why');
  check(alice.contacts.some((c) => c.name === 'Bob Recipient'), 'Alice\'s contact book learned Bob');

  console.log('→ the gates hold…');
  const overdraw = await call('vaultSend', 'alice', {
    toSortCode: bobBefore.sortCode, toAccountNumber: bobBefore.accountNumber, amount: 999900,
  });
  check(!overdraw.ok && /enough/i.test(overdraw.message || ''), `overdrawing bounces (${overdraw.message})`);
  const selfSend = await call('vaultSend', 'alice', {
    toSortCode: alice.sortCode, toAccountNumber: alice.accountNumber, amount: 100,
  });
  check(!selfSend.ok, 'sending to yourself is refused');

  await call('vaultExec', 'alice', { op: 'setfrozen', args: { frozen: true } });
  const frozenBuy = await call('vaultExec', 'alice', { op: 'cardpurchase', args: { amount: 500, merchant: 'Pret' } });
  check(!frozenBuy.ok && /frozen/i.test(frozenBuy.message || ''), `frozen card declines (${frozenBuy.message})`);
  await call('vaultExec', 'alice', { op: 'setfrozen', args: { frozen: false } });
  const buy = await call('vaultExec', 'alice', { op: 'cardpurchase', args: { amount: 350, merchant: 'Pret' } });
  check(buy.ok, 'unfrozen card pays');
  alice = await bank('alice');
  check(balance(alice, 'current') === 21000 - 350, 'the purchase landed on the server ledger');

  const hugeTopUp = await call('vaultExec', 'alice', { op: 'topup', args: { amount: 100000000 } });
  check(!hugeTopUp.ok && hugeTopUp.code === 'INVALID_ARGUMENT', 'top-ups over the cap are refused');
  const noAuth = await call('vaultSend', null, {
    toSortCode: bobBefore.sortCode, toAccountNumber: bobBefore.accountNumber, amount: 100,
  });
  check(!noAuth.ok && noAuth.code === 'UNAUTHENTICATED', 'no auth, no bank');

  console.log(failed ? '\nVault emulator test: FAILED' : '\nVault emulator test: all checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
