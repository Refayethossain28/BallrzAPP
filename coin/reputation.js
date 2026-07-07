/**
 * TimeCoin portable reputation — signed attestations that travel with a person.
 * ====================================================================
 *
 * Reputation in a single circle is easy: everyone sees the same relay, so the
 * "favours done" leaderboard converges from the deals people gossip. But that
 * reputation is trapped in that circle. Move to a new circle — a different
 * relay, new faces — and you start from zero, because nobody there witnessed
 * your history.
 *
 * This module makes reputation PORTABLE. Two kinds of signed attestation:
 *
 *   • a RECEIPT is written by the person on the RECEIVING end of a favour:
 *     "I, <me>, received <note> from <subject>." It is signed with the
 *     author's own wallet key, so anyone, anywhere, can verify the signature
 *     without having seen the deal and without trusting any relay.
 *   • a VOUCH is a direct statement of trust: "I, <me>, vouch for <subject>."
 *
 * A subject collects the attestations others have signed about them into a
 * PASSPORT — a small, self-contained bundle they can export to a file or QR and
 * carry to any circle. On arrival, every node re-verifies each signature
 * locally and shows an HONEST summary: how many attestations verify, and — the
 * number that actually matters — how many come from DISTINCT people, and of
 * those how many YOU already know. A pile of receipts signed by one person with
 * many keys is worth nothing; receipts from many people you recognise are worth
 * a lot. The math is checked on your device; the relay is never trusted.
 *
 * Reuses TimeCoin's cryptography (same curve, same addresses, same sign/verify)
 * so a wallet needs no new key system. Loaded the UMD way; in the browser it
 * reads the global `BallrzCoin`, same in the Node test sandbox.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzReputation = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KINDS = { receipt: 1, vouch: 1 };
  var NOTE_MAX = 140;

  function coin() {
    var g = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this;
    if (g && g.BallrzCoin) return g.BallrzCoin;
    throw new Error('TimeCoin engine must be loaded before reputation.js');
  }

  // Canonical, signature-covered string. JSON of a fixed-order array so the note
  // (which may contain any character) can't inject delimiters, and every node
  // hashes byte-identical input. `pubKey`/`sig`/`id` are intentionally excluded.
  function canonical(a) {
    return JSON.stringify([a.kind, a.subject, a.from, a.note, a.value, a.at, a.nonce]);
  }
  function attId(a) {
    return coin().sha256d(canonical(a) + '|' + a.pubKey + '|' + a.sig);
  }

  // Create + sign an attestation. `at` and `nonce` are supplied so signing is
  // deterministic and fully testable.
  //   opts: { kind:'receipt'|'vouch', subject, note, value, at, nonce, privKey }
  function signAttestation(opts) {
    var C = coin();
    if (!KINDS[opts.kind]) throw new Error('unknown attestation kind');
    var pubKey = C.getPublicKey(opts.privKey);
    var a = {
      kind: opts.kind,
      subject: String(opts.subject),          // who this reputation is ABOUT
      from: C.addressFromPublicKey(pubKey),    // who is attesting (the signer)
      note: opts.note ? String(opts.note).slice(0, NOTE_MAX) : '',
      value: Math.max(0, Math.floor(opts.value || 0)), // optional: hours/units of the favour
      at: Number(opts.at),
      nonce: String(opts.nonce),
      pubKey: pubKey
    };
    if (a.subject === a.from) throw new Error('cannot attest about yourself');
    if (!C.isValidAddress(a.subject)) throw new Error('invalid subject address');
    a.sig = C.sign(C.sha256(canonical(a)), opts.privKey);
    a.id = attId(a);
    return a;
  }
  function signReceipt(opts) { opts.kind = 'receipt'; return signAttestation(opts); }
  function signVouch(opts) { opts.kind = 'vouch'; return signAttestation(opts); }

  // An attestation is valid iff: kind known, addresses well-formed and distinct
  // (you can't attest about yourself), the public key matches the author's
  // address, and the signature verifies over the canonical form.
  function verifyAttestation(a) {
    var C = coin();
    if (!a || typeof a !== 'object') return false;
    if (!KINDS[a.kind]) return false;
    if (!C.isValidAddress(a.subject) || !C.isValidAddress(a.from) || a.subject === a.from) return false;
    if (typeof a.note !== 'string' || a.note.length > NOTE_MAX) return false;
    if (!Number.isInteger(a.value) || a.value < 0) return false;
    if (!a.pubKey || C.addressFromPublicKey(a.pubKey) !== a.from) return false;
    try { return C.verify(C.sha256(canonical(a)), a.sig, a.pubKey); }
    catch (e) { return false; }
  }

  // Bundle the attestations about `subject` into a portable passport. Identity
  // (name/pubKey) is a self-claimed hint only — it's the SIGNATURES that carry
  // trust, so a forged name changes nothing about what verifies.
  function buildPassport(subject, attestations) {
    var list = (attestations || []).filter(function (a) {
      return verifyAttestation(a) && a.subject === subject.address;
    });
    var seen = {}, out = [];
    list.forEach(function (a) { if (!seen[a.id]) { seen[a.id] = 1; out.push(a); } });
    return {
      v: 1,
      subject: { address: subject.address, pubKey: subject.pubKey || '', name: subject.name || '' },
      attestations: out
    };
  }

  // Honest summary of the reputation held for `subjectAddress`. Verifies every
  // attestation locally, de-dupes by id, drops anything not about the subject.
  //   opts.known: optional fn(address)->truthy for "someone I already know".
  // Returns counts that DON'T lie: total verified, and — what matters against
  // sybil forgery — the number of DISTINCT authors and how many you recognise.
  function summarize(subjectAddress, attestations, opts) {
    opts = opts || {};
    var known = typeof opts.known === 'function' ? opts.known : function () { return false; };
    var seen = {}, verified = [];
    (attestations || []).forEach(function (a) {
      if (a && a.subject === subjectAddress && !seen[a.id] && verifyAttestation(a)) {
        seen[a.id] = 1; verified.push(a);
      }
    });
    var authors = {}, receipts = 0, vouches = 0, value = 0;
    verified.forEach(function (a) {
      authors[a.from] = (authors[a.from] || 0) + 1;
      if (a.kind === 'receipt') { receipts++; value += a.value; }
      else vouches++;
    });
    var authorList = Object.keys(authors);
    var knownAuthors = authorList.filter(function (addr) { return known(addr); });
    return {
      subject: subjectAddress,
      total: verified.length,
      receipts: receipts,
      vouches: vouches,
      value: value,
      distinctAuthors: authorList.length,
      authors: authorList,
      knownAuthors: knownAuthors,
      knownCount: knownAuthors.length,
      verified: verified
    };
  }

  // Verify + normalise a passport received from someone else. Returns the same
  // shape as summarize(), plus the self-claimed subject identity. Only
  // attestations that are actually ABOUT the passport's subject and verify are
  // counted, so a hand-edited passport can't inflate itself.
  function readPassport(passport, opts) {
    if (!passport || !passport.subject || !passport.subject.address) throw new Error('not a passport');
    var s = summarize(passport.subject.address, passport.attestations, opts);
    s.identity = { address: passport.subject.address, pubKey: passport.subject.pubKey || '', name: passport.subject.name || '' };
    return s;
  }

  return {
    version: '1.0.0',
    NOTE_MAX: NOTE_MAX,
    canonical: canonical, attId: attId,
    signAttestation: signAttestation, signReceipt: signReceipt, signVouch: signVouch,
    verifyAttestation: verifyAttestation,
    buildPassport: buildPassport, readPassport: readPassport, summarize: summarize
  };
});
