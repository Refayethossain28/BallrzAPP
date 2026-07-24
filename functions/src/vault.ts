/**
 * Vault Online — the server side of the digital bank (vault/).
 *
 * The browser app started life fully device-local. This module is the step
 * from "demo on one device" to "real online banking system": every user gets
 * a server-held bank, every mutation goes through a callable here, and P2P
 * transfers actually move money between two users' ledgers atomically. The
 * currency is still simulated (no e-money licence, and the app says so) —
 * but the *system* is real: server-authoritative, tamper-proof, multi-user.
 *
 * Architecture:
 *
 *   vaultBanks/{uid}    the user's whole bank state — the exact JSON shape
 *                       vault/engine.js operates on. Clients READ it live
 *                       (owner-only, via firestore.rules + onSnapshot) but
 *                       can never write it: all writes happen here with the
 *                       Admin SDK inside Firestore transactions.
 *   vaultRails/{key}    sort-code+account-number → uid directory, used for
 *                       payee lookup and rails uniqueness. No client access.
 *
 * The money rules are NOT re-implemented here. The engine (vault-engine.js,
 * a byte-identical copy of vault/engine.js, sync pinned by the vault unit
 * tests) runs server-side: post() remains the single gate — insufficient
 * funds, overdraft floor, card freeze/limits — and interest + standing-order
 * catch-up runs before every operation, exactly like the local app. What the
 * server adds is what a client can't be trusted with: identity, atomic
 * cross-user movement, rails uniqueness, and sanity caps for a shared world.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import * as admin from 'firebase-admin';
import { randomInt } from 'node:crypto';
import V, { type VaultState, type PostResult } from './vault-engine.js';

/* ── shared-world sanity caps (all integer pence) ─────────────────────────── */
const TOPUP_MAX = 10_000_00;        // £10,000 per top-up
const SEND_MAX = 10_000_00;         // £10,000 per transfer
const TOTAL_CAP = 250_000_00;       // £250,000 per bank — it's play money, not a piggy for mischief
const AER_MAX_ONLINE = 5;           // the house pays at most 5% AER online
const OVERDRAFT_MAX = 500_00;       // arranged overdraft up to £500
const LEDGER_KEEP = 3000;           // compact past this many txns (Firestore 1MiB doc limit)

const db = () => admin.firestore();
const bankRef = (uid: string) => db().doc(`vaultBanks/${uid}`);
const railKey = (sortCode: string, accountNumber: string) =>
  `${String(sortCode).replace(/\D/g, '')}-${String(accountNumber).replace(/\D/g, '')}`;
const railRef = (sortCode: string, accountNumber: string) =>
  db().doc(`vaultRails/${railKey(sortCode, accountNumber)}`);

const nowTS = () => new Date().toISOString();
const today = () => nowTS().slice(0, 10);

function uidOf(request: CallableRequest): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to use Vault Online.');
  return uid;
}

/** A positive integer-pence amount from untrusted input, capped. */
function penceOf(v: unknown, cap: number, what: string): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) throw new HttpsError('invalid-argument', `${what} must be a positive amount.`);
  if (n > cap) throw new HttpsError('invalid-argument', `${what} can be at most ${V.fmt(cap)}.`);
  return n;
}
function strOf(v: unknown, max: number): string {
  return String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Interest + standing-order catch-up, then ledger compaction — before every op. */
function catchUp(state: VaultState): VaultState {
  let s = V.accrueInterest(state, today());
  s = V.runDueOrders(s, today()).state;
  return V.compact(s, LEDGER_KEEP);
}

/** Engine post() errors become client-visible failed-preconditions. */
function mustPost(r: PostResult): { state: VaultState } {
  if (r.error || !r.state) throw new HttpsError('failed-precondition', r.message || 'The bank said no.');
  return { state: r.state };
}

/* ══════════════════════════ open a bank ══════════════════════════ */

/**
 * vaultOpen({ name }) — idempotent: creates the caller's bank (with unique
 * rails reserved in vaultRails and a £250 welcome balance) or returns the
 * one that already exists. No demo seed online — the ledger is your history.
 */
export const vaultOpen = onCall({ region: 'us-central1' }, async (request) => {
  const uid = uidOf(request);
  const name = strOf(request.data?.name, 40);
  if (!name) throw new HttpsError('invalid-argument', 'Tell us your name.');

  return db().runTransaction(async (tx) => {
    const existing = await tx.get(bankRef(uid));
    if (existing.exists) return { existed: true };

    // roll rails until they're unique (34m combinations; collisions are rare)
    let state: VaultState | null = null;
    for (let attempt = 0; attempt < 6 && !state; attempt++) {
      const candidate = V.openBank({ name, rng: V.mulberry32(randomInt(0, 2 ** 31)), nowISO: today() });
      const taken = await tx.get(railRef(candidate.sortCode, candidate.accountNumber));
      if (!taken.exists) state = candidate;
    }
    if (!state) throw new HttpsError('resource-exhausted', 'Could not allocate account rails — try again.');

    state = mustPost(V.post(state, {
      amount: 250_00, from: null, to: 'current',
      desc: 'Welcome to Vault · starter balance', category: 'income',
      method: 'faster-payment', ts: nowTS(),
    })).state;

    tx.set(railRef(state.sortCode, state.accountNumber), { uid, name });
    tx.set(bankRef(uid), state as unknown as admin.firestore.DocumentData);
    logger.info('vaultOpen: new bank', { uid, sortCode: state.sortCode });
    return { existed: false };
  });
});

/* ══════════════════════════ single-bank operations ══════════════════════════ */

type ExecArgs = Record<string, unknown>;

/** Every op: (caught-up state, validated args) → new state. Engine gates money. */
const OPS: Record<string, (s: VaultState, a: ExecArgs) => VaultState> = {
  /** Simulated faster-payment top-up (this is where a licensed build would call the BaaS). */
  topup: (s, a) => {
    const amount = penceOf(a.amount, TOPUP_MAX, 'Top-up');
    if (V.totalBalance(s) + amount > TOTAL_CAP) {
      throw new HttpsError('failed-precondition', `Banks are capped at ${V.fmt(TOTAL_CAP)} of play money.`);
    }
    return mustPost(V.post(s, { amount, from: null, to: 'current', desc: 'Top up', category: 'income', method: 'faster-payment', ts: nowTS() })).state;
  },
  cardpurchase: (s, a) => {
    const amount = penceOf(a.amount, SEND_MAX, 'Purchase');
    const merchant = strOf(a.merchant, 60) || 'Card purchase';
    return mustPost(V.cardPurchase(s, amount, merchant, nowTS())).state;
  },
  potcreate: (s, a) => {
    const name = strOf(a.name, 30);
    if (!name) throw new HttpsError('invalid-argument', 'Give the pot a name.');
    if (s.accounts.length >= 12) throw new HttpsError('failed-precondition', 'That’s enough pots for anyone (10).');
    const aer = Math.max(0, Math.min(AER_MAX_ONLINE, Number(a.aerPct) || 0));
    const goal = Math.max(0, Math.round(Number(a.goal) || 0));
    return V.createPot(s, { name, goal, aerPct: aer, nowISO: today() });
  },
  potmove: (s, a) => {
    const amount = penceOf(a.amount, TOTAL_CAP, 'Transfer');
    const potId = strOf(a.potId, 20);
    const pot = V.accountById(s, potId);
    if (!pot || pot.kind !== 'savings') throw new HttpsError('invalid-argument', 'No such pot.');
    return a.into
      ? mustPost(V.post(s, { amount, from: 'current', to: potId, desc: 'Pot transfer · ' + pot.name, category: 'savings', ts: nowTS() })).state
      : mustPost(V.post(s, { amount, from: potId, to: 'current', desc: 'Withdrawal · ' + pot.name, category: 'savings', ts: nowTS() })).state;
  },
  addorder: (s, a) => {
    const to = strOf(a.to, 40);
    if (!to) throw new HttpsError('invalid-argument', 'Who gets paid?');
    const amount = penceOf(a.amount, SEND_MAX, 'Standing order');
    const startISO = strOf(a.startISO, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startISO) || startISO < today()) {
      throw new HttpsError('invalid-argument', 'First payment must be today or later.');
    }
    if (s.orders.length >= 20) throw new HttpsError('failed-precondition', 'Standing-order limit reached (20).');
    return V.addOrder(s, { to, amount, freq: a.freq === 'weekly' ? 'weekly' : 'monthly', startISO, desc: to });
  },
  cancelorder: (s, a) => {
    const id = strOf(a.id, 40);
    const next = structuredClone(s);
    next.orders = next.orders.filter((o) => o.id !== id);
    if (next.orders.length === s.orders.length) throw new HttpsError('invalid-argument', 'No such standing order.');
    return next;
  },
  setfrozen: (s, a) => {
    const next = structuredClone(s);
    next.card.frozen = !!a.frozen;
    return next;
  },
  setlimits: (s, a) => {
    const next = structuredClone(s);
    next.card.limitPerTx = penceOf(a.perTx, SEND_MAX, 'Per-purchase limit');
    next.card.limitDaily = penceOf(a.daily, TOTAL_CAP, 'Daily limit');
    return next;
  },
  setroundups: (s, a) => {
    const next = structuredClone(s);
    if (a.potId == null || a.potId === '') { next.roundUpsTo = null; return next; }
    const pot = V.accountById(next, strOf(a.potId, 20));
    if (!pot || pot.kind !== 'savings') throw new HttpsError('invalid-argument', 'No such pot.');
    next.roundUpsTo = pot.id;
    return next;
  },
  setoverdraft: (s, a) => {
    const raw = Math.round(Number(a.amount) || 0);
    if (raw < 0 || raw > OVERDRAFT_MAX) {
      throw new HttpsError('invalid-argument', `Overdraft can be £0 to ${V.fmt(OVERDRAFT_MAX)}.`);
    }
    const next = structuredClone(s);
    for (const acct of next.accounts) if (acct.id === 'current') acct.overdraft = raw;
    return next;
  },
  /**
   * Crypto desk — the repo's own chains (TimeCoin, Neura) traded custodially
   * against the £ balance. The price is the engine's deterministic walk, so
   * the server and every client agree on it without a feed; the £ leg goes
   * through post() like all other money. Custodial only: the bank never
   * touches on-chain keys (the app reads those locally, read-only).
   */
  cryptobuy: (s, a) => {
    const key = strOf(a.key, 10).toUpperCase();
    const amount = penceOf(a.amount, SEND_MAX, 'Purchase');
    const r = V.cryptoBuy(s, key, amount, nowTS());
    if (r.error || !r.state) throw new HttpsError('failed-precondition', r.message || 'The desk said no.');
    return r.state;
  },
  cryptosell: (s, a) => {
    const key = strOf(a.key, 10).toUpperCase();
    const units = Math.round(Number(a.units));
    if (!Number.isFinite(units) || units <= 0 || units > Number.MAX_SAFE_INTEGER) {
      throw new HttpsError('invalid-argument', 'Units must be a positive whole number.');
    }
    const r = V.cryptoSell(s, key, units, nowTS());
    if (r.error || !r.state) throw new HttpsError('failed-precondition', r.message || 'The desk said no.');
    return r.state;
  },
  /** No mutation of its own — the shared catch-up (interest + due orders) is the point. */
  catchup: (s) => s,
};

/** vaultExec({ op, args }) — run one named operation on the caller's bank. */
export const vaultExec = onCall({ region: 'us-central1' }, async (request) => {
  const uid = uidOf(request);
  const op = strOf(request.data?.op, 20).toLowerCase();
  const handler = OPS[op];
  if (!handler) throw new HttpsError('invalid-argument', `Unknown operation "${op}".`);
  const args: ExecArgs = (request.data?.args && typeof request.data.args === 'object') ? request.data.args : {};

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(bankRef(uid));
    if (!snap.exists) throw new HttpsError('not-found', 'Open a Vault account first.');
    const state = handler(catchUp(snap.data() as unknown as VaultState), args);
    tx.set(bankRef(uid), state as unknown as admin.firestore.DocumentData);
  });
  return { ok: true };
});

/* ══════════════════════════ people paying people ══════════════════════════ */

/**
 * vaultLookup({ sortCode, accountNumber }) — confirmation of payee: the real
 * pre-flight check real banks run, so "did I type the right digits" is
 * answered with a name before any money moves.
 */
export const vaultLookup = onCall({ region: 'us-central1' }, async (request) => {
  uidOf(request);
  const snap = await railRef(strOf(request.data?.sortCode, 12), strOf(request.data?.accountNumber, 12)).get();
  if (!snap.exists) return { found: false };
  return { found: true, name: (snap.data() as { name?: string }).name || 'A Vault customer' };
});

/**
 * vaultSend({ toSortCode, toAccountNumber, amount, reference }) — the heart of
 * the online bank: an atomic double-entry across two users. Sender's gate
 * (funds, overdraft floor) runs in the engine; both ledgers update in one
 * Firestore transaction or neither does. The recipient sees it arrive live
 * through their own onSnapshot.
 */
export const vaultSend = onCall({ region: 'us-central1' }, async (request) => {
  const uid = uidOf(request);
  const amount = penceOf(request.data?.amount, SEND_MAX, 'Transfer');
  const reference = strOf(request.data?.reference, 30);
  const toSort = strOf(request.data?.toSortCode, 12);
  const toAcc = strOf(request.data?.toAccountNumber, 12);

  const toName = await db().runTransaction(async (tx) => {
    const rail = await tx.get(railRef(toSort, toAcc));
    if (!rail.exists) throw new HttpsError('not-found', 'No Vault account with those details — check the sort code and account number.');
    const toUid = (rail.data() as { uid: string }).uid;
    if (toUid === uid) throw new HttpsError('failed-precondition', 'That’s your own account — use pots to move money around.');

    const [fromSnap, toSnap] = await Promise.all([tx.get(bankRef(uid)), tx.get(bankRef(toUid))]);
    if (!fromSnap.exists) throw new HttpsError('not-found', 'Open a Vault account first.');
    if (!toSnap.exists) throw new HttpsError('not-found', 'That account is no longer open.');

    let sender = catchUp(fromSnap.data() as unknown as VaultState);
    let recipient = catchUp(toSnap.data() as unknown as VaultState);
    const recipientName = recipient.name;
    if (V.totalBalance(recipient) + amount > TOTAL_CAP) {
      throw new HttpsError('failed-precondition', 'The recipient’s bank is full (the play-money cap).');
    }

    const ref = reference ? ' · ' + reference : '';
    const ts = nowTS();
    sender = mustPost(V.post(sender, {
      amount, from: 'current', to: null,
      desc: 'Sent to ' + recipientName + ref, category: 'transfers', method: 'faster-payment', ts,
    })).state;
    recipient = mustPost(V.post(recipient, {
      amount, from: null, to: 'current',
      desc: 'From ' + sender.name + ref, category: 'income', method: 'faster-payment', ts,
    })).state;

    // remember the payee for next time
    const sortFmt = toSort.replace(/\D/g, '').replace(/^(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3');
    if (!sender.contacts.some((c) => railKey(c.sortCode, c.accountNumber) === railKey(toSort, toAcc))) {
      sender = structuredClone(sender);
      sender.contacts.push({ name: recipientName, sortCode: sortFmt, accountNumber: toAcc.replace(/\D/g, '') });
      if (sender.contacts.length > 50) sender.contacts.shift();
    }

    tx.set(bankRef(uid), sender as unknown as admin.firestore.DocumentData);
    tx.set(bankRef(toUid), recipient as unknown as admin.firestore.DocumentData);
    return recipientName;
  });

  logger.info('vaultSend', { uid, amount });
  return { ok: true, toName };
});
