/**
 * ApexCoin on-chain bridge — APEX leaves the app as a real ERC-20 (AXC) and
 * comes back. The token contract lives in ../../apexchain (ApexCoin.sol);
 * this module is the ONLY thing that moves value across the boundary:
 *
 *   withdraw:  deduct the app ledger (transactional, idempotent) → treasury
 *              MINTS AXC to the user's wallet. On a chain failure the
 *              deduction is compensated, so coins are never lost in flight.
 *   deposit:   the user transfers AXC to the treasury from their LINKED
 *              wallet, then claims the tx hash → verified against the chain,
 *              credited once (ledger id = the tx hash), and the treasury
 *              BURNS what it received.
 *
 * Because mint happens only against a ledger deduction and deposits are
 * burned, the token's totalSupply() always equals coins circulating OUTSIDE
 * ApexVIP. Wallet linking requires an ethers signature so nobody can claim
 * another user's deposits.
 *
 * Config: Firestore `settings/chain` {enabled, rpcUrl, contractAddress,
 * explorerBase?} + the CHAIN_TREASURY_KEY secret. Until all are set every
 * entry point fails closed with a clear message — the repo's standard
 * partial-setup behaviour. Testnet first: see docs/apexvip-apexcoin-onchain.md.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import * as admin from 'firebase-admin';
import {
  Contract, JsonRpcProvider, Wallet,
  getAddress, isAddress, verifyMessage, id as topicId,
} from 'ethers';

import { round2 } from './logic.js';
import type { CoinLedgerEntry, User } from './types.js';

export const CHAIN_TREASURY_KEY = defineSecret('CHAIN_TREASURY_KEY');

/** 2-decimal token: 1 APEX = 1.00 AXC = 100 on-chain units. */
const UNITS_PER_COIN = 100n;
const TRANSFER_TOPIC = topicId('Transfer(address,address,uint256)');

const APEXCOIN_ABI = [
  'function mint(address to, uint256 amount)',
  'function burn(uint256 amount)',
  'function balanceOf(address owner) view returns (uint256)',
];

export interface ChainSettings {
  enabled?: boolean;
  rpcUrl?: string;
  contractAddress?: string;
  chainId?: number;
  explorerBase?: string;
}

interface ChainConfig {
  provider: JsonRpcProvider;
  treasury: Wallet;
  coin: Contract;
  contractAddress: string;
  explorerBase: string;
}

/** The message a wallet signs to prove the user controls it. */
export function walletLinkMessage(uid: string): string {
  return `ApexVIP wallet link for user ${uid}`;
}

/** Resolve the bridge config, or null when not (fully) configured. */
async function chainConfig(): Promise<ChainConfig | null> {
  let s: ChainSettings = {};
  try {
    const snap = await admin.firestore().doc('settings/chain').get();
    if (snap.exists) s = (snap.data() as ChainSettings) || {};
  } catch { /* unreadable settings → treated as unconfigured */ }
  const key = CHAIN_TREASURY_KEY.value() || process.env.CHAIN_TREASURY_KEY || '';
  if (!s.enabled || !s.rpcUrl || !s.contractAddress || !key || !isAddress(s.contractAddress)) return null;
  const provider = new JsonRpcProvider(s.rpcUrl);
  const treasury = new Wallet(key, provider);
  return {
    provider, treasury,
    coin: new Contract(s.contractAddress, APEXCOIN_ABI, treasury),
    contractAddress: getAddress(s.contractAddress),
    explorerBase: s.explorerBase || '',
  };
}

function requireAuth(request: CallableRequest<unknown>): string {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  return request.auth.uid;
}

const NOT_CONFIGURED = new HttpsError(
  'failed-precondition',
  'The on-chain bridge is not configured (settings/chain + CHAIN_TREASURY_KEY).',
);

// linkChainWallet — prove control of an external wallet by signing a fixed
// message; the verified address becomes the ONLY wallet whose deposits credit
// this account. Rules block self-writes to users.chainAddress, so an attacker
// can't link someone else's wallet and claim their deposits.
export const linkChainWallet = onCall(
  { secrets: [CHAIN_TREASURY_KEY], region: 'us-central1' },
  async (request: CallableRequest<{ address?: string; signature?: string }>) => {
    const uid = requireAuth(request);
    const d = request.data || {};
    const address = String(d.address || '');
    const signature = String(d.signature || '');
    if (!isAddress(address)) throw new HttpsError('invalid-argument', 'A valid wallet address is required');
    if (!signature) throw new HttpsError('invalid-argument', 'signature is required');
    let recovered = '';
    try { recovered = verifyMessage(walletLinkMessage(uid), signature); } catch { /* malformed sig */ }
    if (!recovered || getAddress(recovered) !== getAddress(address)) {
      throw new HttpsError('permission-denied', 'Signature does not prove control of that wallet');
    }
    const checksummed = getAddress(address);
    await admin.firestore().doc(`users/${uid}`).set({ chainAddress: checksummed }, { merge: true });
    return { address: checksummed };
  },
);

// withdrawCoinsOnchain — APEX leaves the app: deduct the ledger, then the
// treasury mints AXC to the given wallet. Idempotent per idempotencyKey; a
// chain failure refunds the deduction (compensating transaction).
export const withdrawCoinsOnchain = onCall(
  { secrets: [CHAIN_TREASURY_KEY], region: 'us-central1' },
  async (request: CallableRequest<{ amount?: number; address?: string; idempotencyKey?: string }>) => {
    const uid = requireAuth(request);
    const d = request.data || {};
    const amount = Math.floor(Number(d.amount));
    const address = String(d.address || '');
    const idem = String(d.idempotencyKey || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
      throw new HttpsError('invalid-argument', 'amount must be a positive number of coins');
    }
    if (!isAddress(address)) throw new HttpsError('invalid-argument', 'A valid destination wallet address is required');
    if (!idem) throw new HttpsError('invalid-argument', 'idempotencyKey is required');
    const cfg = await chainConfig();
    if (!cfg) throw NOT_CONFIGURED;

    const db = admin.firestore();
    const ledgerRef = db.doc(`coin_ledger/withdraw_${uid}_${idem}`);
    const userRef = db.doc(`users/${uid}`);

    // Phase 1 — deduct the ledger first, so a crash can never leave minted
    // tokens without a matching deduction.
    const prior = await db.runTransaction(async (tx) => {
      const [row, userSnap] = await Promise.all([tx.get(ledgerRef), tx.get(userRef)]);
      const balance = Math.max(0, Number((userSnap.data() as User | undefined)?.apexBalance) || 0);
      if (row.exists) {
        const r = row.data() as CoinLedgerEntry & { txHash?: string };
        return { done: true, withdrawn: Number(r.amount) || 0, txHash: r.txHash || '', balance };
      }
      if (balance < amount) throw new HttpsError('failed-precondition', 'Insufficient APEX balance');
      tx.set(ledgerRef, {
        uid, role: 'client', type: 'withdraw', amount, reason: 'On-chain withdrawal',
        ref: getAddress(address), at: admin.firestore.FieldValue.serverTimestamp(),
      } satisfies CoinLedgerEntry);
      tx.set(userRef, { apexBalance: admin.firestore.FieldValue.increment(-amount) }, { merge: true });
      return { done: false, withdrawn: amount, txHash: '', balance: balance - amount };
    });
    if (prior.done) {
      // Idempotent retry — the earlier call already deducted (and, if txHash
      // is set, minted). Never mint twice for one key.
      return { withdrawn: prior.withdrawn, txHash: prior.txHash, balance: prior.balance, explorer: prior.txHash && cfg.explorerBase ? cfg.explorerBase + prior.txHash : '' };
    }

    // Phase 2 — mint on-chain; compensate the deduction if the chain says no.
    try {
      const tx = await cfg.coin.mint(getAddress(address), BigInt(amount) * UNITS_PER_COIN);
      const receipt = await tx.wait();
      await ledgerRef.set({ txHash: receipt.hash, status: 'confirmed' }, { merge: true });
      logger.info('withdrawCoinsOnchain', { uid, amount, txHash: receipt.hash });
      return { withdrawn: amount, txHash: receipt.hash, balance: prior.balance, explorer: cfg.explorerBase ? cfg.explorerBase + receipt.hash : '' };
    } catch (err) {
      logger.error('withdrawCoinsOnchain mint failed — refunding', err instanceof Error ? err.message : String(err));
      await db.runTransaction(async (tx) => {
        tx.delete(ledgerRef);
        tx.set(userRef, { apexBalance: admin.firestore.FieldValue.increment(amount) }, { merge: true });
      });
      throw new HttpsError('unavailable', 'On-chain mint failed — your APEX was not deducted. Please try again.');
    }
  },
);

// depositCoinsOnchain — AXC comes home: the user transfers to the treasury
// from their LINKED wallet, then claims the tx hash. Verified on-chain,
// credited exactly once (ledger id = tx hash), and the received tokens are
// burned so totalSupply keeps equalling coins outside the app.
export const depositCoinsOnchain = onCall(
  { secrets: [CHAIN_TREASURY_KEY], region: 'us-central1' },
  async (request: CallableRequest<{ txHash?: string }>) => {
    const uid = requireAuth(request);
    const txHash = String((request.data || {}).txHash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new HttpsError('invalid-argument', 'A transaction hash is required');
    const cfg = await chainConfig();
    if (!cfg) throw NOT_CONFIGURED;

    const db = admin.firestore();
    const linked = (((await db.doc(`users/${uid}`).get()).data() as User | undefined)?.chainAddress) || '';
    if (!linked) throw new HttpsError('failed-precondition', 'Link a wallet first — deposits are only credited from your verified wallet.');

    const receipt = await cfg.provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) throw new HttpsError('not-found', 'That transaction is not confirmed on-chain.');

    // Sum AXC Transfer(from: linked wallet → to: treasury) in this tx.
    const treasuryAddr = getAddress(cfg.treasury.address);
    const linkedAddr = getAddress(linked);
    let units = 0n;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== cfg.contractAddress) continue;
      if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
      const from = getAddress('0x' + log.topics[1].slice(26));
      const to = getAddress('0x' + log.topics[2].slice(26));
      if (from === linkedAddr && to === treasuryAddr) units += BigInt(log.data);
    }
    if (units <= 0n) {
      throw new HttpsError('failed-precondition', 'No AXC transfer from your linked wallet to the ApexVIP treasury found in that transaction.');
    }
    const amount = round2(Number(units) / Number(UNITS_PER_COIN));

    // Credit exactly once — the ledger id IS the tx hash.
    const credited = await creditDeposit(uid, amount, txHash);
    if (credited) {
      // Retire what came home; best-effort — a failed burn only delays the
      // supply invariant until the next successful one, never double-credits.
      try { await (await cfg.coin.burn(units)).wait(); }
      catch (err) { logger.warn('deposit burn failed (will retry on a later deposit)', err instanceof Error ? err.message : String(err)); }
    }
    const balance = Math.max(0, Number(((await db.doc(`users/${uid}`).get()).data() as User | undefined)?.apexBalance) || 0);
    return { deposited: credited ? amount : 0, alreadyClaimed: !credited, balance };
  },
);

/** Transactionally credit a deposit once; false if this txHash was already claimed. */
async function creditDeposit(uid: string, amount: number, txHash: string): Promise<boolean> {
  const db = admin.firestore();
  const ledgerRef = db.doc(`coin_ledger/deposit_${txHash}`);
  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ledgerRef);
      if (existing.exists) throw new Error('deposit-claimed');
      tx.set(ledgerRef, {
        uid, role: 'client', type: 'deposit', amount, reason: 'On-chain deposit', ref: txHash,
        at: admin.firestore.FieldValue.serverTimestamp(),
      } satisfies CoinLedgerEntry);
      tx.set(db.doc(`users/${uid}`), { apexBalance: admin.firestore.FieldValue.increment(amount) }, { merge: true });
    });
    return true;
  } catch (err) {
    if (err instanceof Error && err.message === 'deposit-claimed') return false;
    throw err;
  }
}
