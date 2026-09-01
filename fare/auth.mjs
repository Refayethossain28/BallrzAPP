/**
 * fare/auth.mjs — passwordless auth for Fare. Magic links: we email a
 * single-use token; redeeming it creates a session token the app stores and
 * sends as the x-fare-session header. Only SHA-256 hashes ever touch the
 * database, so a leaked DB can't impersonate anyone.
 */
import { randomBytes, createHash } from 'node:crypto';
import * as store from './db.mjs';

export const LOGIN_TOKEN_TTL_MIN = 15;
export const SESSION_TTL_DAYS = 90;
export const TRIAL_DAYS = 30;

export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();

/* ── rate limiting (in-memory; one process serves everything) ── */
const attempts = new Map(); // email → [timestamps]
export function loginRateLimited(email, now = Date.now()) {
  const windowMs = 15 * 60 * 1000;
  const list = (attempts.get(email) || []).filter((t) => now - t < windowMs);
  if (list.length >= 3) { attempts.set(email, list); return true; }
  list.push(now);
  attempts.set(email, list);
  return false;
}

/* ── magic links ── */

// → the raw token to embed in the emailed link (only its hash is stored).
export function issueLoginToken(db, email) {
  const token = newToken();
  store.createLoginToken(db, hashToken(token), email, isoIn(LOGIN_TOKEN_TTL_MIN * 60 * 1000));
  return token;
}

// Redeem a link: burn the token, find-or-create the account (claiming the
// legacy account 1 if it's unclaimed), open a session. → {account, session}|null
export function redeemLoginToken(db, token) {
  const email = store.consumeLoginToken(db, hashToken(token));
  if (!email) return null;
  const trialEndsAt = isoIn(TRIAL_DAYS * 24 * 3600 * 1000);
  const account = store.accountForEmail(db, email, trialEndsAt);
  const session = newToken();
  store.createSession(db, hashToken(session), account.id, isoIn(SESSION_TTL_DAYS * 24 * 3600 * 1000));
  return { account, session };
}

export function accountForSession(db, sessionToken) {
  if (!sessionToken) return null;
  return store.sessionAccount(db, hashToken(sessionToken));
}

export function signOut(db, sessionToken) {
  if (sessionToken) store.deleteSession(db, hashToken(sessionToken));
}
