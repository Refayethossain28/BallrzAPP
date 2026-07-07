#!/usr/bin/env node
/**
 * Unit tests for coin/reputation.js — portable, signed reputation:
 * receipt/vouch attestations on secp256k1, self-attestation guard, tamper
 * rejection, de-duplication, honest distinct-author / known-author counting,
 * and passport build/read round-trips. Loaded in a vm sandbox alongside the
 * coin engine (repo is type:module). Run: node scripts/test-reputation.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'coin', 'engine.js'), 'utf8'), sandbox, { filename: 'coin/engine.js' });
const C = sandbox.module.exports;
sandbox.BallrzCoin = C;                 // reputation.js looks it up as self.BallrzCoin
sandbox.module = { exports: {} };
vm.runInContext(readFileSync(join(ROOT, 'coin', 'reputation.js'), 'utf8'), sandbox, { filename: 'coin/reputation.js' });
const R = sandbox.module.exports;

const w = (n) => C.walletFromPrivateKey(String(n).padStart(64, '0'));
const subject = w(1);      // the person the reputation is ABOUT
const alice = w(2);
const bob = w(3);
const carol = w(4);
const mallory = w(5);

let clock = 1000;
const tick = () => ++clock;
// author signs an attestation ABOUT `about`
const receipt = (author, about, note, value) =>
  R.signReceipt({ privKey: author.privateKey, subject: about.address, note, value, at: tick(), nonce: 'n' + clock });
const vouch = (author, about, note) =>
  R.signVouch({ privKey: author.privateKey, subject: about.address, note, at: tick(), nonce: 'n' + clock });

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

test('a receipt signs, verifies and records author + subject', () => {
  const a = receipt(alice, subject, 'fixed my bike', 2);
  assert.equal(a.kind, 'receipt');
  assert.equal(a.subject, subject.address, 'about the subject');
  assert.equal(a.from, alice.address, 'authored by alice');
  assert.equal(a.value, 2);
  assert.ok(R.verifyAttestation(a), 'valid receipt verifies');
});

test('a vouch signs and verifies with zero value', () => {
  const a = vouch(bob, subject, 'trust them completely');
  assert.equal(a.kind, 'vouch');
  assert.equal(a.value, 0);
  assert.ok(R.verifyAttestation(a));
});

test('you cannot attest about yourself', () => {
  assert.throws(() => receipt(subject, subject, 'I am great', 9), /yourself/);
});

test('tampering with subject, author, note, value or signature is rejected', () => {
  const a = receipt(alice, subject, 'walked my dog', 1);
  assert.ok(R.verifyAttestation(a));
  assert.ok(!R.verifyAttestation({ ...a, subject: bob.address }), 'redirect subject fails');
  assert.ok(!R.verifyAttestation({ ...a, from: bob.address }), 'author swap fails');
  assert.ok(!R.verifyAttestation({ ...a, note: 'saved my life' }), 'note tamper fails');
  assert.ok(!R.verifyAttestation({ ...a, value: 999 }), 'value tamper fails');
  assert.ok(!R.verifyAttestation({ ...a, sig: a.sig.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }), 'sig tamper fails');
  // forging authorship: sign as mallory but claim to be alice
  const forged = receipt(mallory, subject, 'x', 0);
  assert.ok(!R.verifyAttestation({ ...forged, from: alice.address }), 'cannot forge a foreign author');
});

test('malformed attestations are rejected, not thrown', () => {
  assert.ok(!R.verifyAttestation(null));
  assert.ok(!R.verifyAttestation({}));
  assert.ok(!R.verifyAttestation({ kind: 'malware', subject: subject.address, from: alice.address }));
  const a = receipt(alice, subject, 'ok', 0);
  assert.ok(!R.verifyAttestation({ ...a, value: -1 }), 'negative value rejected');
  assert.ok(!R.verifyAttestation({ ...a, value: 1.5 }), 'non-integer value rejected');
});

test('summarize counts distinct authors, receipts, vouches and value', () => {
  const atts = [
    receipt(alice, subject, 'a', 2),
    receipt(alice, subject, 'again', 3),   // same author twice → still 1 distinct
    receipt(bob, subject, 'b', 1),
    vouch(carol, subject, 'solid'),
  ];
  const s = R.summarize(subject.address, atts);
  assert.equal(s.total, 4);
  assert.equal(s.receipts, 3);
  assert.equal(s.vouches, 1);
  assert.equal(s.value, 6, 'sums receipt values');
  assert.equal(s.distinctAuthors, 3, 'alice counted once');
});

test('summarize is sybil-honest: it ignores forged and off-subject attestations', () => {
  const good = receipt(alice, subject, 'real', 1);
  const forged = { ...receipt(mallory, subject, 'fake', 1), from: bob.address }; // bad signature binding
  const offSubject = receipt(alice, bob, 'about someone else', 5);
  const s = R.summarize(subject.address, [good, forged, offSubject]);
  assert.equal(s.total, 1, 'only the one genuine, on-subject receipt counts');
  assert.equal(s.distinctAuthors, 1);
});

test('summarize de-duplicates identical attestations by id', () => {
  const a = receipt(alice, subject, 'once', 1);
  const s = R.summarize(subject.address, [a, { ...a }, { ...a }]);
  assert.equal(s.total, 1, 'the same attestation is counted once');
});

test('known() surfaces how many authors you already trust', () => {
  const atts = [receipt(alice, subject, 'a', 1), receipt(bob, subject, 'b', 1), receipt(carol, subject, 'c', 1)];
  const myContacts = new Set([alice.address, carol.address]);
  const s = R.summarize(subject.address, atts, { known: (addr) => myContacts.has(addr) });
  assert.equal(s.distinctAuthors, 3);
  assert.equal(s.knownCount, 2, 'alice and carol are known; bob is a stranger');
  assert.ok(s.knownAuthors.includes(alice.address) && s.knownAuthors.includes(carol.address), 'known list is alice + carol');
  assert.ok(!s.knownAuthors.includes(bob.address), 'the stranger is not in the known list');
});

test('buildPassport bundles only verified, on-subject attestations', () => {
  const atts = [receipt(alice, subject, 'a', 1)];
  // add a genuinely off-subject and a forged one to prove they're stripped
  atts.push(receipt(alice, carol, 'about carol', 2));
  atts.push({ ...receipt(mallory, subject, 'forged', 1), from: alice.address });
  const p = R.buildPassport({ address: subject.address, pubKey: subject.publicKey, name: 'Subject' }, atts);
  assert.equal(p.v, 1);
  assert.equal(p.subject.address, subject.address);
  assert.equal(p.attestations.length, 1, 'only the one valid on-subject receipt survives');
});

test('readPassport re-verifies independently and reports self-claimed identity', () => {
  const atts = [receipt(alice, subject, 'a', 2), vouch(bob, subject, 'trust')];
  const p = R.buildPassport({ address: subject.address, pubKey: subject.publicKey, name: 'Sam' }, atts);
  // ship it as JSON and back — the receiving circle only has these bytes
  const wire = JSON.parse(JSON.stringify(p));
  const s = R.readPassport(wire, { known: (a) => a === alice.address });
  assert.equal(s.identity.name, 'Sam');
  assert.equal(s.total, 2);
  assert.equal(s.distinctAuthors, 2);
  assert.equal(s.knownCount, 1, 'only alice is known here');
});

test('a hand-edited passport cannot inflate itself', () => {
  const p = R.buildPassport({ address: subject.address, pubKey: subject.publicKey, name: 'x' }, [receipt(alice, subject, 'a', 1)]);
  // attacker appends a receipt they signed about SOMEONE ELSE, relabelling subject
  const stolen = receipt(bob, carol, 'about carol', 9);
  p.attestations.push({ ...stolen, subject: subject.address }); // breaks the signature
  const s = R.readPassport(p);
  assert.equal(s.total, 1, 'the tampered attestation is dropped on re-verification');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
  }
  console.log('\nreputation: ' + passed + '/' + tests.length + ' passed');
})();
