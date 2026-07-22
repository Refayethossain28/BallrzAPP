#!/usr/bin/env node
/**
 * Unit tests for intro/engine.js — the pure card engine behind Intro, the
 * digital business card app. Covers the card model, the URL-safe share codec
 * (from-scratch UTF-8 + base64url), the vCard 3.0 generator, social link
 * canonicalisation, the completeness score and the from-scratch QR encoder.
 * Loaded in a vm sandbox (repo is type:module). Run: node scripts/test-intro-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// deepEqual across the vm realm boundary trips on prototype identity — compare by JSON instead.
const eqJson = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'intro', 'engine.js'), 'utf8'), sandbox, { filename: 'intro/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

const sample = (over = {}) => ({
  name: 'Ada Lovelace', title: 'Analyst', company: 'Analytical Engines Ltd',
  phone: '+44 7700 900123', email: 'ada@example.com', website: 'ada.dev',
  location: 'London, UK', bio: 'First programmer.', theme: 'midnight',
  socials: [{ k: 'github', v: '@ada' }, { k: 'linkedin', v: 'https://www.linkedin.com/in/ada-l/' }],
  ...over,
});

/* ── helpers ── */

test('initials: first + last word, uppercased', () => {
  assert.equal(E.initials('Ada Lovelace'), 'AL');
  assert.equal(E.initials('  ada   king   lovelace '), 'AL');
  assert.equal(E.initials('Plato'), 'P');
  assert.equal(E.initials(''), '');
});

test('isEmail accepts real addresses, rejects junk', () => {
  assert.ok(E.isEmail('a@b.co'));
  assert.ok(!E.isEmail('a@b'));
  assert.ok(!E.isEmail('not an email'));
  assert.ok(!E.isEmail(''));
});

test('telDigits keeps + and digits only', () => {
  assert.equal(E.telDigits('+44 (0)7700 900-123'), '+4407700900123');
  assert.equal(E.telDigits('07700 900123'), '07700900123');
  assert.equal(E.telDigits('call me'), '');
});

test('normalizeUrl adds https:// and rejects exotic schemes', () => {
  assert.equal(E.normalizeUrl('ada.dev'), 'https://ada.dev');
  assert.equal(E.normalizeUrl('http://a.b'), 'http://a.b');
  assert.equal(E.normalizeUrl('javascript:alert(1)'), '');
  assert.equal(E.normalizeUrl(''), '');
});

test('prettyUrl strips scheme, www and trailing slash', () => {
  assert.equal(E.prettyUrl('https://www.ada.dev/'), 'ada.dev');
  assert.equal(E.prettyUrl('http://x.com/a/'), 'x.com/a');
});

/* ── socials ── */

test('socialHandle canonicalises @handles and pasted profile URLs', () => {
  assert.equal(E.socialHandle('github', '@ada'), 'ada');
  assert.equal(E.socialHandle('linkedin', 'https://www.linkedin.com/in/ada-l/'), 'ada-l');
  assert.equal(E.socialHandle('x', 'https://twitter.com/ada'), 'ada');
  assert.equal(E.socialHandle('tiktok', 'https://tiktok.com/@ada'), 'ada');
  assert.equal(E.socialHandle('whatsapp', '+44 7700 900123'), '447700900123');
  assert.equal(E.socialHandle('nope', 'x'), '');
});

test('socialUrl builds the full profile link', () => {
  assert.equal(E.socialUrl('github', '@ada'), 'https://github.com/ada');
  assert.equal(E.socialUrl('whatsapp', '+44 7700 900123'), 'https://wa.me/447700900123');
  assert.equal(E.socialUrl('telegram', 'ada'), 'https://t.me/ada');
  assert.equal(E.socialUrl('github', ''), '');
});

/* ── card model ── */

test('blankCard is empty, themed, and stamps the given time', () => {
  const c = E.blankCard(123);
  assert.equal(c.name, '');
  assert.equal(c.theme, E.THEMES[0].id);
  assert.equal(c.createdAt, 123);
  eqJson(c.socials, []);
});

test('normalizeCard clamps, trims and validates', () => {
  const c = E.normalizeCard({ name: '  Ada   Lovelace  ', bio: 'x'.repeat(1000), theme: 'nope', website: 'ada.dev' });
  assert.equal(c.name, 'Ada Lovelace');
  assert.equal(c.bio.length, 280);
  assert.equal(c.theme, E.THEMES[0].id);
  assert.equal(c.website, 'https://ada.dev');
});

test('normalizeCard dedupes socials, caps at 8, drops unknown networks', () => {
  const socials = [
    { k: 'github', v: 'a' }, { k: 'github', v: 'b' }, { k: 'myspace', v: 'x' },
    ...['x', 'instagram', 'tiktok', 'youtube', 'facebook', 'telegram', 'threads', 'linkedin', 'whatsapp'].map((k) => ({ k, v: '123' })),
  ];
  const c = E.normalizeCard({ socials });
  assert.equal(c.socials.length, 8);
  assert.equal(c.socials.filter((s) => s.k === 'github').length, 1);
  assert.equal(c.socials[0].v, 'a');
  assert.ok(!c.socials.some((s) => s.k === 'myspace'));
});

test('normalizeCard rejects a non-image avatar', () => {
  assert.equal(E.normalizeCard({ avatar: 'data:text/html;base64,PGI+' }).avatar, '');
  const ok = 'data:image/jpeg;base64,/9j/4AAQ';
  assert.equal(E.normalizeCard({ avatar: ok }).avatar, ok);
});

/* ── UTF-8 + base64url primitives ── */

test('utf8 round-trips ASCII, accents, CJK and emoji', () => {
  for (const s of ['hello', 'café', '東京 タワー', 'emoji 👩🏽‍💻🎴', '']) {
    assert.equal(E.utf8Decode(E.utf8Encode(s)), s);
  }
});

test('utf8Encode matches known byte sequences', () => {
  eqJson(E.utf8Encode('é'), [0xC3, 0xA9]);
  eqJson(E.utf8Encode('€'), [0xE2, 0x82, 0xAC]);
  eqJson(E.utf8Encode('😀'), [0xF0, 0x9F, 0x98, 0x80]);
});

test('base64url round-trips all byte values and is URL-safe', () => {
  const bytes = Array.from({ length: 256 }, (_, i) => i);
  const enc = E.b64uEncode(bytes);
  assert.ok(!/[+/=]/.test(enc), 'no +, / or = in ' + enc.slice(0, 20));
  eqJson(E.b64uDecode(enc), bytes);
});

test('b64uDecode rejects illegal input', () => {
  assert.equal(E.b64uDecode('a'), null);          // length % 4 === 1
  assert.equal(E.b64uDecode('ab+d'), null);       // non-url-safe alphabet
});

/* ── the share codec ── */

test('encode/decode round-trips a full card', () => {
  const token = E.encodeCard(sample());
  const c = E.decodeCard(token);
  assert.equal(c.name, 'Ada Lovelace');
  assert.equal(c.website, 'https://ada.dev');
  assert.equal(c.theme, 'midnight');
  eqJson(c.socials, [{ k: 'github', v: 'ada' }, { k: 'linkedin', v: 'ada-l' }]);
});

test('codec survives unicode names and bios', () => {
  const c = E.decodeCard(E.encodeCard(sample({ name: 'José Ñandú 王', bio: 'こんにちは 🌸' })));
  assert.equal(c.name, 'José Ñandú 王');
  assert.equal(c.bio, 'こんにちは 🌸');
});

test('decodeCard is strict: null on garbage, wrong version, empty cards', () => {
  assert.equal(E.decodeCard(''), null);
  assert.equal(E.decodeCard('not a token'), null);
  assert.equal(E.decodeCard('9.' + E.encodeCard(sample()).slice(2)), null);   // future version
  assert.equal(E.decodeCard('1.!!!!'), null);                                  // bad base64url
  assert.equal(E.decodeCard('1.' + E.b64uEncode(E.utf8Encode('[1,2]'))), null); // JSON but not an object
  assert.equal(E.decodeCard(E.encodeCard({ theme: 'onyx' })), null);           // no identity → not a card
});

test('decoded cards are normalized (hostile input neutralised)', () => {
  const evil = '1.' + E.b64uEncode(E.utf8Encode(JSON.stringify({ n: 'Eve', w: 'javascript:alert(1)', s: [['github', '@e'], ['bogus', 'x']] })));
  const c = E.decodeCard(evil);
  assert.equal(c.website, '');
  eqJson(c.socials, [{ k: 'github', v: 'e' }]);
});

test('encodeCard {avatar:false} leaves the photo out', () => {
  const avatar = 'data:image/jpeg;base64,' + 'A'.repeat(400);
  const withA = E.encodeCard(sample({ avatar }));
  const without = E.encodeCard(sample({ avatar }), { avatar: false });
  assert.ok(withA.length > without.length + 300);
  assert.equal(E.decodeCard(without).avatar, '');
  assert.equal(E.decodeCard(withA).avatar, avatar);
});

test('shareUrl embeds the token and auto-drops an oversized avatar', () => {
  const url = E.shareUrl('https://x.y/intro/', sample());
  assert.ok(url.startsWith('https://x.y/intro/#c=1.'));
  assert.equal(E.decodeCard(E.parseHash(url)).name, 'Ada Lovelace');
  const huge = 'data:image/jpeg;base64,' + 'A'.repeat(E.LINK_MAX);
  const url2 = E.shareUrl('https://x.y/intro/#c=old', sample({ avatar: huge }));
  assert.ok(url2.length < E.LINK_MAX + 100);
  const c2 = E.decodeCard(E.parseHash(url2));
  assert.equal(c2.avatar, '');
  assert.equal(c2.name, 'Ada Lovelace');
});

test('parseHash finds the token in a hash or a whole URL', () => {
  assert.equal(E.parseHash('#c=1.abcd'), '1.abcd');
  assert.equal(E.parseHash('c=1.abcd'), '1.abcd');
  assert.equal(E.parseHash('https://x.y/intro/#c=1.ab-_cd'), '1.ab-_cd');
  assert.equal(E.parseHash('#other=1'), null);
});

/* ── vCard ── */

test('vcard emits valid 3.0 structure with CRLF endings', () => {
  const v = E.vcard(sample(), '2026-07-22T00:00:00Z');
  assert.ok(v.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n'));
  assert.ok(v.endsWith('END:VCARD\r\n'));
  assert.ok(v.includes('FN:Ada Lovelace'));
  assert.ok(v.includes('N:Lovelace;Ada;;;'));
  assert.ok(v.includes('TEL;TYPE=CELL:+44 7700 900123'));
  assert.ok(v.includes('EMAIL;TYPE=INTERNET:ada@example.com'));
  assert.ok(v.includes('URL:https://ada.dev'));
  assert.ok(v.includes('X-SOCIALPROFILE;TYPE=github:https://github.com/ada'));
  assert.ok(v.includes('REV:2026-07-22T00:00:00Z'));
});

test('vcard escapes commas, semicolons and newlines', () => {
  const v = E.vcard(sample({ company: 'Engines; Ltd, London', bio: 'line1\nline2' }));
  assert.ok(v.includes('ORG:Engines\\; Ltd\\, London'));
  assert.ok(v.includes('NOTE:line1\\nline2'));
});

test('vcard folds long lines with a leading space continuation', () => {
  const v = E.vcard(sample({ bio: 'x'.repeat(200) }));
  const folded = v.split('\r\n').filter((l) => l.startsWith(' '));
  assert.ok(folded.length >= 2, 'long NOTE folded');
  for (const line of v.split('\r\n')) assert.ok(line.length <= 75, 'line <= 75 chars: ' + line.length);
});

test('vcard embeds the photo with the right type', () => {
  const v = E.vcard(sample({ avatar: 'data:image/png;base64,iVBORw0KGgo' }));
  assert.ok(v.replace(/\r\n /g, '').includes('PHOTO;ENCODING=b;TYPE=PNG:iVBORw0KGgo'));
});

test('vcardFilename slugs the name', () => {
  assert.equal(E.vcardFilename({ name: 'Ada Lovelace!' }), 'ada-lovelace.vcf');
  assert.equal(E.vcardFilename({ name: '' }), 'contact.vcf');
});

/* ── completeness ── */

test('completeness: empty card is 0, full card is 100', () => {
  assert.equal(E.completeness({}).pct, 0);
  const full = E.completeness(sample({ avatar: 'data:image/jpeg;base64,/9j/4AAQ' }));
  assert.equal(full.pct, 100);
  eqJson(full.missing, []);
});

test('completeness reports what is missing', () => {
  const r = E.completeness({ name: 'Ada', email: 'ada@example.com' });
  assert.equal(r.pct, 50);
  assert.ok(r.missing.includes('a photo'));
  assert.ok(r.missing.includes('a website'));
});

/* ── QR encoder ── */

test('qrMatrix: "HELLO" fits version 1 (21×21) with valid finders + timing', () => {
  const m = sandbox.module.exports.qrMatrix('HELLO', 'M');
  assert.equal(m.length, 21);
  assert.equal(m[0].length, 21);
  // finder: dark 3×3 core, light ring at distance 2, dark border at distance 3
  for (const [cx, cy] of [[3, 3], [17, 3], [3, 17]]) {
    assert.equal(m[cy][cx], true);
    assert.equal(m[cy][cx - 1], true);
    assert.equal(m[cy][cx - 2], false);
    assert.equal(m[cy][cx - 3], true);
  }
  // timing pattern alternates along row/col 6
  for (let i = 8; i < 13; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
});

test('qrMatrix grows versions with payload and is deterministic', () => {
  const small = E.qrMatrix('x', 'M').length;
  const big = E.qrMatrix('x'.repeat(200), 'M').length;
  assert.ok(big > small);
  eqJson(E.qrMatrix('same input', 'M'), E.qrMatrix('same input', 'M'));
});

test('qrMatrix throws when the payload cannot fit', () => {
  assert.throws(() => E.qrMatrix('x'.repeat(4000), 'H'), /Too much data/);
});

test('qrSvg wraps the matrix in a quiet-zoned SVG', () => {
  const svg = E.qrSvg('HELLO', 'M');
  assert.ok(svg.startsWith('<svg xmlns'));
  assert.ok(svg.includes('viewBox="0 0 29 29"'));   // version 1: 21 + 2×4 quiet zone
  assert.ok(svg.includes('<rect'));
});

test('a real share URL fits in a QR code without the avatar', () => {
  const url = E.shareUrl('https://refayethossain28.github.io/BallrzAPP/intro/', sample());
  const token = E.parseHash(url);
  const qrUrl = 'https://refayethossain28.github.io/BallrzAPP/intro/#c=' + E.encodeCard(E.decodeCard(token), { avatar: false });
  const m = E.qrMatrix(qrUrl, 'M');
  assert.ok(m.length >= 21 && m.length <= 177);
});

/* ── run ── */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} passed`);
