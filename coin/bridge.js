/**
 * TimeCoin circle bridges — moving a favour between two circles, safely.
 * ====================================================================
 *
 * Circles are separate networks: each has its own relay and its own ledgers.
 * You generally DON'T want to weld two circles' money together — a small
 * community currency is safe precisely because it's local and bounded. Mined
 * TIME is scarce, so bridging it would import one circle's inflation into
 * another. Mutual credit is different: it's net-zero and every account is
 * capped by a credit limit, so it can cross a boundary without anyone able to
 * create value out of thin air. That makes it the ONLY layer we bridge.
 *
 * A bridge is one honest mechanism, the same one real LETS schemes use to
 * "intertrade": a person M who belongs to BOTH circles passes a favour along.
 *
 *   • Leg A (in circle A's ledger): the payer gives M credit.        payer → M
 *   • Leg B (in circle B's ledger): M gives the payee that credit.   M → payee
 *
 * Both legs are ordinary mutual-credit transfers (coin/mutual.js) — so they
 * gossip, fold into balances and respect credit limits with no special
 * handling. What makes them a *bridge* is that leg B's signed `nonce` commits
 * to leg A's id (`bridge:<legA.id>`). Because the nonce is part of what M signs,
 * the link is tamper-evident: anyone can check that M really did forward THAT
 * exact incoming favour, that the amounts match, and that M nets to zero across
 * the two circles (+X owed to M in A, −X owed by M in B). Value is relocated,
 * never minted. M is trusted only to pass it on — not to hold anyone's keys.
 *
 * Reuses TimeCoin's mutual-credit layer (and, through it, the same curve and
 * addresses). Loaded the UMD way; reads the globals `BallrzMutual` /
 * `BallrzCoin`, same in the Node test sandbox.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzBridge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PREFIX = 'bridge:';

  function g() { return (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this; }
  function mutual() {
    var m = g() && g().BallrzMutual;
    if (m) return m;
    throw new Error('TimeCoin mutual-credit module must be loaded before bridge.js');
  }
  function coin() {
    var c = g() && g().BallrzCoin;
    if (c) return c;
    throw new Error('TimeCoin engine must be loaded before bridge.js');
  }

  // The signed nonce a forwarding leg carries: it names the incoming leg, so the
  // whole route is bound together by M's own signature and can't be re-pointed.
  function bridgeNonce(incomingId) { return PREFIX + String(incomingId); }
  function isBridgeLeg(leg) { return !!(leg && typeof leg.nonce === 'string' && leg.nonce.indexOf(PREFIX) === 0); }
  function incomingIdOf(leg) { return isBridgeLeg(leg) ? leg.nonce.slice(PREFIX.length) : null; }

  // Build leg B: the holder of `privKey` (who must be the recipient of the
  // `incoming` leg) forwards the SAME amount onward to `payee` in another
  // circle. Deterministic given `at`, so it's fully testable.
  //   opts: { incoming, privKey, payee, at, memo }
  function buildBridgeLeg(opts) {
    var C = coin(), M = mutual();
    var incoming = opts.incoming;
    if (!M.verifyCredit(incoming)) throw new Error('the incoming leg is not a valid credit');
    var me = C.addressFromPublicKey(C.getPublicKey(opts.privKey));
    if (incoming.to !== me) throw new Error('only the recipient of the incoming favour can bridge it onward');
    if (!C.isValidAddress(opts.payee)) throw new Error('invalid payee address');
    if (opts.payee === me) throw new Error('a bridge must forward to someone else');
    if (opts.payee === incoming.from) throw new Error('cannot bridge a favour straight back to its sender');
    return M.signCredit({
      privKey: opts.privKey,
      to: opts.payee,
      amount: incoming.amount,
      at: Number(opts.at),
      nonce: bridgeNonce(incoming.id),
      memo: opts.memo ? String(opts.memo) : ''
    });
  }

  // Verify a two-leg intertrade. Returns { ok, reason, bridge, payer, payee,
  // amount }. Both legs must be valid credits, leg B must be a bridge leg that
  // names leg A, the pivot (M) must be leg A's recipient and leg B's sender, the
  // amounts must match, and payer ≠ payee. On success M is net-zero across the
  // two legs — bridging relocates value, it never creates it.
  function verifyIntertrade(legA, legB, opts) {
    opts = opts || {};
    var M = mutual();
    if (!M.verifyCredit(legA)) return { ok: false, reason: 'incoming leg invalid' };
    if (!M.verifyCredit(legB)) return { ok: false, reason: 'forwarding leg invalid' };
    if (!isBridgeLeg(legB) || incomingIdOf(legB) !== legA.id) return { ok: false, reason: 'the forwarding leg does not commit to this incoming favour' };
    if (legA.to !== legB.from) return { ok: false, reason: 'the same person must receive then forward' };
    if (legA.amount !== legB.amount) return { ok: false, reason: 'amounts do not match' };
    if (legA.from === legB.to) return { ok: false, reason: 'payer and payee are the same' };
    if (opts.bridge && legA.to !== opts.bridge) return { ok: false, reason: 'not bridged by the expected person' };
    return { ok: true, bridge: legA.to, payer: legA.from, payee: legB.to, amount: legA.amount };
  }

  // The bridge's net position across the two legs: +amount in circle A (owed to
  // them) and −amount in circle B (they now owe), summing to exactly 0. Proves
  // no value was minted — only carried across the boundary.
  function bridgeNet(legA, legB) {
    var v = verifyIntertrade(legA, legB);
    if (!v.ok) return null;
    return { bridge: v.bridge, inCircleA: legA.amount, inCircleB: -legB.amount, net: legA.amount - legB.amount };
  }

  return {
    version: '1.0.0',
    PREFIX: PREFIX,
    bridgeNonce: bridgeNonce, isBridgeLeg: isBridgeLeg, incomingIdOf: incomingIdOf,
    buildBridgeLeg: buildBridgeLeg, verifyIntertrade: verifyIntertrade, bridgeNet: bridgeNet
  };
});
