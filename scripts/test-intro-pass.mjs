#!/usr/bin/env node
/**
 * Unit tests for intro/pass.mjs — the zero-dependency Apple Wallet .pkpass
 * pipeline. Exercises the DER encoders against known byte sequences, the
 * store-only ZIP round-trip, the SHA-1 manifest, pass.json content, and the
 * full CMS signature — verified with node:crypto against a self-signed
 * certificate built from the same DER primitives (no Apple account needed to
 * prove the plumbing; Apple's cert slots into the identical path).
 * Run: node scripts/test-intro-pass.mjs
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  der, derLen, SEQ, oid, int, utcTime, OCTET, readTLV, certIssuerAndSerial, pemToDer,
  buildSignedAttrs, buildCms, selfSignedCert, crc32, zipStore, unzipStore,
  passIcon, buildPassJson, buildPkpass, PASS_COLORS,
} from '../intro/pass.mjs';

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

const NOW = new Date(Date.UTC(2026, 6, 22, 12, 0, 0));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const certDer = selfSignedCert('Intro Test Signer', keys, NOW);
const certPem = '-----BEGIN CERTIFICATE-----\n' + certDer.toString('base64').replace(/(.{64})/g, '$1\n') + '\n-----END CERTIFICATE-----\n';
const keyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });

const card = {
  name: 'Ada Lovelace', title: 'Analyst', company: 'Analytical Engines Ltd', tagline: '',
  phone: '+44 7700 900123', email: 'ada@example.com', website: 'https://ada.dev',
  location: 'London, UK', bio: 'First programmer.', theme: 'midnight',
  socials: [{ k: 'github', v: 'ada' }], avatar: '', updatedAt: 1234567,
};
const SHARE = 'https://example.com/intro/#c=1.abc';
const OPTS = {
  passTypeId: 'pass.com.test.intro', teamId: 'TEAM123456', shareUrl: SHARE,
  signerCertPem: certPem, signerKeyPem: keyPem, wwdrPem: certPem, now: NOW,
};

/* ── DER primitives ── */

test('derLen: short and long form', () => {
  assert.deepEqual([...derLen(5)], [5]);
  assert.deepEqual([...derLen(127)], [127]);
  assert.deepEqual([...derLen(128)], [0x81, 128]);
  assert.deepEqual([...derLen(300)], [0x82, 0x01, 0x2c]);
});

test('oid encodes known values byte-exactly', () => {
  // 1.2.840.113549.1.7.2 (signedData) — from RFC examples
  assert.equal(oid('1.2.840.113549.1.7.2').toString('hex'), '06092a864886f70d010702');
  // 2.16.840.1.101.3.4.2.1 (sha256)
  assert.equal(oid('2.16.840.1.101.3.4.2.1').toString('hex'), '0609608648016503040201');
});

test('int handles high-bit padding', () => {
  assert.equal(int(1).toString('hex'), '020101');
  assert.equal(int(128).toString('hex'), '02020080');   // needs a leading zero
});

test('utcTime formats UTC with Z', () => {
  assert.equal(utcTime(NOW).slice(2).toString('ascii'), '260722120000Z');
});

test('readTLV round-trips a nested structure', () => {
  const inner = SEQ(int(7), OCTET(Buffer.from('hi')));
  const outer = SEQ(inner);
  const t = readTLV(outer, 0);
  assert.equal(t.tag, 0x30);
  const first = readTLV(outer, t.cStart);
  assert.equal(Buffer.compare(first.raw, inner), 0);
});

test('pemToDer inverts PEM wrapping', () => {
  assert.equal(Buffer.compare(pemToDer(certPem), certDer), 0);
});

/* ── self-signed cert + issuer/serial extraction ── */

test('self-signed cert parses and verifies with node:crypto', () => {
  const x509 = new crypto.X509Certificate(certDer);
  assert.equal(x509.subject, 'CN=Intro Test Signer');
  assert.ok(x509.verify(keys.publicKey));
});

test('certIssuerAndSerial lifts the right TLVs', () => {
  const { serial, issuer } = certIssuerAndSerial(certDer);
  assert.equal(serial[0], 0x02);                       // INTEGER
  assert.equal(issuer[0], 0x30);                       // SEQUENCE (Name)
  assert.ok(issuer.includes(Buffer.from('Intro Test Signer')));
});

/* ── CMS signature ── */

test('signedAttrs carry the sha256 of the manifest, DER-sorted', () => {
  const manifest = Buffer.from('{"pass.json":"abc"}');
  const attrs = buildSignedAttrs(manifest, NOW);
  const digest = crypto.createHash('sha256').update(manifest).digest();
  const all = Buffer.concat(attrs);
  assert.ok(all.includes(digest), 'messageDigest present');
  const sorted = [...attrs].sort(Buffer.compare);
  assert.deepEqual(attrs.map((a) => a.toString('hex')), sorted.map((a) => a.toString('hex')));
});

test('CMS signature verifies over the SET-tagged signedAttrs', () => {
  const manifest = Buffer.from('{"m":"anifest"}');
  const cms = buildCms(manifest, certDer, [certDer], keyPem, NOW);
  assert.equal(cms[0], 0x30, 'ContentInfo SEQUENCE');
  assert.ok(cms.includes(oid('1.2.840.113549.1.7.2')), 'signedData OID');
  assert.ok(cms.includes(certDer), 'signer cert embedded');
  // rebuild attrs as SET and check the embedded signature verifies
  const attrs = buildSignedAttrs(manifest, NOW);
  const content = Buffer.concat(attrs);
  const asSet = Buffer.concat([Buffer.from([0x31]), derLen(content.length), content]);
  // the OCTET STRING signature is the last 256 bytes of the CMS (2048-bit RSA)
  const sig = cms.slice(cms.length - 256);
  assert.ok(crypto.verify('sha256', asSet, keys.publicKey, sig), 'RSA signature valid');
});

/* ── ZIP ── */

test('crc32 matches the known vector for "123456789"', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zipStore round-trips through unzipStore', () => {
  const files = [
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir-less/b.bin', data: crypto.randomBytes(1000) },
  ];
  const zip = zipStore(files, NOW);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local header signature');
  const back = unzipStore(zip);
  assert.equal(back['a.txt'].toString(), 'hello');
  assert.equal(Buffer.compare(back['dir-less/b.bin'], files[1].data), 0);
  // EOCD count
  const eocd = zip.slice(zip.length - 22);
  assert.equal(eocd.readUInt32LE(0), 0x06054b50);
  assert.equal(eocd.readUInt16LE(10), 2);
});

/* ── pass.json ── */

test('buildPassJson: identity, fields, barcode and theme colors', () => {
  const p = buildPassJson(card, SHARE, OPTS);
  assert.equal(p.formatVersion, 1);
  assert.equal(p.passTypeIdentifier, 'pass.com.test.intro');
  assert.equal(p.teamIdentifier, 'TEAM123456');
  assert.equal(p.generic.primaryFields[0].value, 'Ada Lovelace');
  assert.deepEqual(p.generic.secondaryFields.map((f) => f.value), ['Analyst', 'Analytical Engines Ltd']);
  assert.equal(p.barcodes[0].format, 'PKBarcodeFormatQR');
  assert.equal(p.barcodes[0].message, SHARE);
  assert.equal(p.backgroundColor, PASS_COLORS.midnight.bg);
  assert.ok(p.generic.backFields.some((f) => f.key === 'social-github' && f.value === '@ada'));
  assert.ok(p.generic.backFields.some((f) => f.key === 'link' && f.value === SHARE));
});

test('buildPassJson: serial is deterministic and content-derived', () => {
  const a = buildPassJson(card, SHARE, OPTS).serialNumber;
  const b = buildPassJson(card, SHARE, OPTS).serialNumber;
  const c = buildPassJson({ ...card, email: 'other@example.com' }, SHARE, OPTS).serialNumber;
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{20}$/);
});

/* ── icons ── */

test('passIcon emits real PNGs at pass sizes', () => {
  for (const n of [29, 58, 87]) {
    const png = passIcon(n);
    assert.equal(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), n);   // IHDR width
  }
});

/* ── the whole .pkpass ── */

test('buildPkpass: complete, manifest-consistent, signed archive', () => {
  const pkpass = buildPkpass(card, OPTS);
  const files = unzipStore(pkpass);
  for (const name of ['pass.json', 'icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'manifest.json', 'signature']) {
    assert.ok(files[name], name + ' present');
  }
  const manifest = JSON.parse(files['manifest.json'].toString());
  for (const [name, sha] of Object.entries(manifest)) {
    assert.equal(crypto.createHash('sha1').update(files[name]).digest('hex'), sha, 'sha1 of ' + name);
  }
  assert.equal(Object.keys(manifest).length, 6, 'manifest covers exactly the payload files');
  const pass = JSON.parse(files['pass.json'].toString());
  assert.equal(pass.generic.primaryFields[0].value, 'Ada Lovelace');
  assert.equal(files['signature'][0], 0x30, 'signature is DER');
  assert.ok(files['signature'].includes(certDer), 'signature embeds the signer cert');
});

test('buildPkpass is deterministic for a fixed now', () => {
  const a = buildPkpass(card, OPTS), b = buildPkpass(card, OPTS);
  assert.equal(Buffer.compare(a, b), 0);
});

/* ── run ── */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} passed`);
