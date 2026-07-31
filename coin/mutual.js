/**
 * TimeCoin mutual credit — a LETS-style ledger that runs alongside the
 * proof-of-work chain.
 * ====================================================================
 *
 * The chain is "commodity money": a fixed supply you mine and hold. Mutual
 * credit is the other great model for a community currency, and arguably the
 * fairer one at scale:
 *
 *   • Everyone starts at exactly ZERO. There is no money to mine or hold.
 *   • A payment is a signed IOU: it moves value from payer to payee, so the
 *     payer goes negative and the payee positive. The SUM of every balance is
 *     always 0 — "money" is created the instant a favour is done and destroyed
 *     as balances drift back toward zero.
 *   • A per-account CREDIT LIMIT bounds how far negative anyone may go (an
 *     interest-free overdraft the community extends to each other).
 *
 * There is no scarcity to fight over and no cold-start problem: the medium of
 * exchange appears exactly when people transact and nets to nothing. It's the
 * mechanism behind LETS schemes, time banks and WIR — now with unforgeable
 * secp256k1 signatures so no one can spend from an account they don't control.
 *
 * This module reuses TimeCoin's cryptography (same curve, same addresses), so
 * a wallet works in both systems. Loaded the UMD way; in the browser it reads
 * the global `BallrzCoin` (kept as the internal namespace), same in the Node sandbox.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzMutual = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function coin() {
    var g = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this;
    if (g && g.BallrzCoin) return g.BallrzCoin;
    throw new Error('TimeCoin engine must be loaded before mutual.js');
  }

  // Canonical, signature-covered string for a credit transfer. Field order is
  // fixed so every node hashes the identical bytes.
  function canonical(tx) {
    return [tx.from, tx.to, tx.amount, tx.at, tx.nonce].join('|');
  }
  function txId(tx) {
    return coin().sha256d(canonical(tx) + '|' + tx.pubKey + '|' + tx.sig);
  }

  // Create + sign a credit transfer of `amount` (base units) from the holder of
  // privKey to address `to`. `at` and `nonce` are supplied (deterministic, so
  // the ledger is fully testable).
  function signCredit(opts) {
    var C = coin();
    var pubKey = C.getPublicKey(opts.privKey);
    var tx = {
      from: C.addressFromPublicKey(pubKey),
      to: String(opts.to),
      amount: Math.floor(opts.amount),
      at: Number(opts.at),
      nonce: String(opts.nonce),
      memo: opts.memo ? String(opts.memo).slice(0, 80) : '',
      pubKey: pubKey
    };
    tx.sig = C.sign(C.sha256(canonical(tx)), opts.privKey);
    tx.id = txId(tx);
    return tx;
  }

  // A credit transfer is valid iff: addresses well-formed and distinct, amount a
  // positive integer, the public key matches the `from` address, and the
  // signature verifies. (Credit limits are a ledger-level rule, checked in
  // applyLedger, not here — an individual transfer is well-formed regardless.)
  function verifyCredit(tx) {
    var C = coin();
    if (!tx || typeof tx !== 'object') return false;
    if (!C.isValidAddress(tx.from) || !C.isValidAddress(tx.to) || tx.from === tx.to) return false;
    if (!Number.isInteger(tx.amount) || tx.amount <= 0) return false;
    if (!tx.pubKey || C.addressFromPublicKey(tx.pubKey) !== tx.from) return false;
    try { return C.verify(C.sha256(canonical(tx)), tx.sig, tx.pubKey); }
    catch (e) { return false; }
  }

  // Fold a set of transfers into balances. Transfers are de-duplicated by id and
  // applied in (timestamp, id) order. A transfer that would push the SENDER past
  // their credit limit is rejected (not applied), everything else nets to zero.
  // `creditLimit` is in base units and may be:
  //   • a number (a single limit for everyone),
  //   • null/undefined (no limit), or
  //   • a function limitFor(address) → base units (per-person limits; return
  //     Infinity or null for "no limit" on that account).
  function applyLedger(txs, creditLimit) {
    var limitFor;
    if (typeof creditLimit === 'function') limitFor = creditLimit;
    else { var lim = (creditLimit === undefined || creditLimit === null) ? Infinity : creditLimit; limitFor = function () { return lim; }; }
    var seen = {}, list = [];
    (txs || []).forEach(function (tx) {
      if (verifyCredit(tx) && !seen[tx.id]) { seen[tx.id] = 1; list.push(tx); }
    });
    list.sort(function (a, b) { return (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    var balances = {}, applied = [], rejected = [];
    list.forEach(function (tx) {
      var fromBal = balances[tx.from] || 0;
      var limit = limitFor(tx.from); if (limit == null) limit = Infinity;
      if (fromBal - tx.amount < -limit) { rejected.push(tx); return; }
      balances[tx.from] = fromBal - tx.amount;
      balances[tx.to] = (balances[tx.to] || 0) + tx.amount;
      applied.push(tx);
    });
    return { balances: balances, applied: applied, rejected: rejected };
  }

  // Sum of all balances — always 0 for a consistent ledger (used by tests).
  function netSum(balances) {
    var s = 0; for (var k in balances) if (balances.hasOwnProperty(k)) s += balances[k]; return s;
  }

  return {
    version: '1.0.0',
    canonical: canonical, txId: txId,
    signCredit: signCredit, verifyCredit: verifyCredit,
    applyLedger: applyLedger, netSum: netSum
  };
});
