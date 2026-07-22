/**
 * Intro — Apple Wallet pass builder
 * =================================
 *
 * Builds and signs a complete .pkpass for an Intro card with ZERO npm
 * dependencies — only Node built-ins (crypto, zlib):
 *
 *   · pass.json     — a "generic" pass: name up front, role/contacts on the
 *                     face, everything else on the back, and the card's share
 *                     link as the QR barcode, so scanning the pass opens the
 *                     live card;
 *   · icons         — the pass icon/logo PNGs are rasterized right here with
 *                     the same minimal PNG encoder used for the app icons;
 *   · manifest.json — SHA-1 of every file, per the PassKit spec;
 *   · signature     — a detached PKCS#7/CMS SignedData over the manifest,
 *                     hand-assembled DER (SEQUENCE by SEQUENCE) and signed
 *                     RSA-SHA256 via node:crypto, embedding the Pass Type ID
 *                     certificate and Apple's WWDR intermediate;
 *   · .pkpass       — a store-only ZIP written byte-by-byte.
 *
 * Apple only opens passes signed by a Pass Type ID certificate issued through
 * the Apple Developer Programme — that's a hard platform rule, not a library
 * choice. This module is the whole pipeline; intro/server.mjs feeds it your
 * certificates (see intro/WALLET.md). Everything except the RSA primitive is
 * deterministic given `now`, and the DER/ZIP/manifest layers are unit-tested
 * against a self-built certificate in scripts/test-intro-pass.mjs.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/* ============================================================ DER / ASN.1 */

export function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | b.length, ...b]);
}
export function der(tag, ...parts) {
  const c = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([Buffer.from([tag]), derLen(c.length), c]);
}
export const SEQ = (...p) => der(0x30, ...p);
export const SETOF = (...p) => der(0x31, ...sortDer(p));           // DER: SET OF is byte-sorted
export const OCTET = (b) => der(0x04, b);
export const NULL = Buffer.from([0x05, 0x00]);
export const BITSTR = (b) => der(0x03, Buffer.concat([Buffer.from([0]), b]));
export const UTF8 = (s) => der(0x0c, Buffer.from(s, 'utf8'));
export const ctx = (n, ...p) => der(0xa0 | n, ...p);               // [n] EXPLICIT

function sortDer(parts) {
  return [...parts].sort(Buffer.compare);
}
export function oid(s) {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (let i = 2; i < p.length; i++) {
    let v = p[i]; const st = [v & 0x7f];
    while ((v = Math.floor(v / 128)) > 0) st.unshift(0x80 | (v & 0x7f));
    out.push(...st);
  }
  return der(0x06, Buffer.from(out));
}
export function int(v) {
  let b;
  if (typeof v === 'number') {
    b = []; let n = v;
    do { b.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
    b = Buffer.from(b);
  } else b = Buffer.from(v);
  if (b.length === 0 || (b[0] & 0x80)) b = Buffer.concat([Buffer.from([0]), b]);
  return der(0x02, b);
}
export function utcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  const s = String(d.getUTCFullYear()).slice(2) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
            p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return der(0x17, Buffer.from(s, 'ascii'));
}

/** Minimal TLV reader — enough to lift issuer + serial out of an X.509 cert. */
export function readTLV(buf, off) {
  const tag = buf[off];
  let len = buf[off + 1], lenBytes = 1;
  if (len & 0x80) {
    const n = len & 0x7f; len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    lenBytes = 1 + n;
  }
  const cStart = off + 1 + lenBytes;
  return { tag, len, cStart, cEnd: cStart + len, raw: buf.slice(off, cStart + len) };
}
export function certIssuerAndSerial(certDer) {
  const cert = readTLV(certDer, 0);
  const tbs = readTLV(certDer, cert.cStart);
  let t = readTLV(certDer, tbs.cStart);
  if (t.tag === 0xa0) t = readTLV(certDer, t.cEnd);   // skip [0] version
  const serial = t.raw;                                // INTEGER
  t = readTLV(certDer, t.cEnd);                        // signature AlgorithmIdentifier
  t = readTLV(certDer, t.cEnd);                        // issuer Name
  return { serial, issuer: t.raw };
}
export function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

/* ============================================================ CMS / PKCS#7 detached signature */

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
};

export function buildSignedAttrs(manifestBuf, now) {
  const digest = crypto.createHash('sha256').update(manifestBuf).digest();
  return sortDer([
    SEQ(oid(OID.contentType), der(0x31, oid(OID.data))),
    SEQ(oid(OID.signingTime), der(0x31, utcTime(now))),
    SEQ(oid(OID.messageDigest), der(0x31, OCTET(digest))),
  ]);
}

/**
 * Detached CMS SignedData over the manifest — the `signature` file of the
 * .pkpass. signerKey may be a PEM string or {key, passphrase}.
 */
export function buildCms(manifestBuf, signerCertDer, extraCertDers, signerKey, now) {
  const attrs = buildSignedAttrs(manifestBuf, now);
  const attrsContent = Buffer.concat(attrs);
  const attrsAsSet = Buffer.concat([Buffer.from([0x31]), derLen(attrsContent.length), attrsContent]);
  const attrsImplicit = Buffer.concat([Buffer.from([0xa0]), derLen(attrsContent.length), attrsContent]);
  const key = typeof signerKey === 'string' ? crypto.createPrivateKey(signerKey)
    : crypto.createPrivateKey({ key: signerKey.key, passphrase: signerKey.passphrase });
  const signature = crypto.sign('sha256', attrsAsSet, key);   // RSASSA-PKCS1-v1_5
  const ias = certIssuerAndSerial(signerCertDer);
  const signerInfo = SEQ(
    int(1),
    SEQ(ias.issuer, ias.serial),
    SEQ(oid(OID.sha256), NULL),
    attrsImplicit,
    SEQ(oid(OID.rsaEncryption), NULL),
    OCTET(signature)
  );
  const certsContent = Buffer.concat([signerCertDer, ...extraCertDers]);
  const certsImplicit = Buffer.concat([Buffer.from([0xa0]), derLen(certsContent.length), certsContent]);
  const signedData = SEQ(
    int(1),
    SETOF(SEQ(oid(OID.sha256), NULL)),
    SEQ(oid(OID.data)),                                        // detached: no content
    certsImplicit,
    SETOF(signerInfo)
  );
  return SEQ(oid(OID.signedData), ctx(0, signedData));
}

/** A minimal self-signed RSA cert — used by the unit tests to exercise the
 *  whole pipeline without an Apple certificate. */
export function selfSignedCert(commonName, keyPair, now) {
  const name = SEQ(der(0x31, SEQ(oid(OID.commonName), UTF8(commonName))));
  const notAfter = new Date(now.getTime() + 365 * 86400000);
  const pub = typeof keyPair.publicKey.export === 'function'
    ? keyPair.publicKey : crypto.createPublicKey(keyPair.publicKey);
  const spki = pub.export({ type: 'spki', format: 'der' });
  const tbs = SEQ(
    ctx(0, int(2)),
    int(now.getTime() % 0xffffff | 1),
    SEQ(oid(OID.sha256WithRSA), NULL),
    name,
    SEQ(utcTime(now), utcTime(notAfter)),
    name,
    spki
  );
  const sig = crypto.sign('sha256', tbs, keyPair.privateKey);
  return SEQ(tbs, SEQ(oid(OID.sha256WithRSA), NULL), BITSTR(sig));
}

/* ============================================================ store-only ZIP */

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{name, data}] → a store-only (no compression) ZIP buffer. */
export function zipStore(files, now) {
  const dosTime = ((now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate()) & 0xffff;
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lh, name, f.data]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Test helper: read a store-only ZIP back into {name → data}. */
export function unzipStore(buf) {
  const out = {};
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(off + 26), extraLen = buf.readUInt16LE(off + 28);
    const size = buf.readUInt32LE(off + 22);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extraLen;
    out[name] = buf.slice(start, start + size);
    off = start + size;
  }
  return out;
}

/* ============================================================ pass icons (minimal PNG) */

function encodePNG(N, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The pass mark: the app's gold→coral card motif, flat and small. */
export function passIcon(N) {
  const buf = Buffer.alloc(N * N * 4);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const lerp = (a, b, f) => a + (b - a) * f;
  const s = N / 58, r = 10 * s, aa = 1.2 * s;
  const GOLD = [0xf0, 0xb4, 0x5c], CORAL = [0xff, 0x8a, 0x5c], INK = [0x2b, 0x15, 0x08];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const qx = Math.max(Math.abs(x - N / 2) - N / 2 + r, 0), qy = Math.max(Math.abs(y - N / 2) - N / 2 + r, 0);
    const d = Math.hypot(qx, qy) - r;
    const cov = clamp((aa - d) / (2 * aa));
    const t = clamp((x + y) / (2 * N));
    let col = [lerp(GOLD[0], CORAL[0], t), lerp(GOLD[1], CORAL[1], t), lerp(GOLD[2], CORAL[2], t)];
    const av = Math.hypot(x - 19 * s, y - 22 * s) - 7 * s;
    const bar1 = Math.max(Math.abs(x - 38 * s) - 8 * s, Math.abs(y - 20 * s) - 2.4 * s);
    const bar2 = Math.max(Math.abs(x - 34 * s) - 12 * s, Math.abs(y - 38 * s) - 2.4 * s);
    const inkA = clamp((aa - Math.min(av, bar1, bar2)) / (2 * aa)) * 0.82;
    col = [lerp(col[0], INK[0], inkA), lerp(col[1], INK[1], inkA), lerp(col[2], INK[2], inkA)];
    const i = (y * N + x) * 4;
    buf[i] = Math.round(col[0]); buf[i + 1] = Math.round(col[1]); buf[i + 2] = Math.round(col[2]);
    buf[i + 3] = Math.round(255 * cov);
  }
  return encodePNG(N, buf);
}

/* ============================================================ pass.json */

// Solid colour approximations of the app's card themes, per PassKit's rgb() format.
export const PASS_COLORS = {
  onyx:      { bg: 'rgb(13,11,8)',    fg: 'rgb(245,240,232)', label: 'rgb(212,175,110)' },
  midnight:  { bg: 'rgb(13,17,38)',   fg: 'rgb(238,242,255)', label: 'rgb(143,162,255)' },
  aurora:    { bg: 'rgb(17,49,54)',   fg: 'rgb(236,253,247)', label: 'rgb(57,230,180)' },
  ember:     { bg: 'rgb(48,20,16)',   fg: 'rgb(255,241,232)', label: 'rgb(255,157,107)' },
  forest:    { bg: 'rgb(14,33,21)',   fg: 'rgb(239,255,239)', label: 'rgb(125,219,143)' },
  lavender:  { bg: 'rgb(30,22,50)',   fg: 'rgb(244,239,255)', label: 'rgb(195,155,255)' },
  porcelain: { bg: 'rgb(246,244,239)', fg: 'rgb(28,26,23)',   label: 'rgb(138,109,47)' },
  glacier:   { bg: 'rgb(235,242,250)', fg: 'rgb(16,24,40)',   label: 'rgb(37,99,235)' },
};

/**
 * The pass.json for a normalized Intro card. shareUrl becomes the QR barcode,
 * so scanning the pass opens the live card.
 */
export function buildPassJson(card, shareUrl, opts) {
  const colors = PASS_COLORS[card.theme] || PASS_COLORS.onyx;
  const secondary = [];
  if (card.title) secondary.push({ key: 'title', label: 'ROLE', value: card.title });
  if (card.company) secondary.push({ key: 'company', label: 'COMPANY', value: card.company });
  const aux = [];
  if (card.phone) aux.push({ key: 'phone', label: 'PHONE', value: card.phone });
  if (card.email) aux.push({ key: 'email', label: 'EMAIL', value: card.email });
  const back = [];
  if (card.website) back.push({ key: 'website', label: 'Website', value: card.website });
  if (card.location) back.push({ key: 'location', label: 'Location', value: card.location });
  if (card.bio || card.tagline) back.push({ key: 'bio', label: 'About', value: card.bio || card.tagline });
  for (const s of card.socials || []) back.push({ key: 'social-' + s.k, label: s.k, value: '@' + s.v });
  back.push({ key: 'link', label: 'Live card', value: shareUrl });
  const serial = crypto.createHash('sha1')
    .update([card.name, card.email, card.phone, String(card.updatedAt || 0)].join('|')).digest('hex').slice(0, 20);
  return {
    formatVersion: 1,
    passTypeIdentifier: opts.passTypeId,
    teamIdentifier: opts.teamId,
    serialNumber: serial,
    organizationName: card.name || 'Intro',
    description: (card.name || 'Intro') + ' — business card',
    generic: {
      primaryFields: [{ key: 'name', value: card.name || 'Intro card' }],
      secondaryFields: secondary,
      auxiliaryFields: aux,
      backFields: back,
    },
    barcodes: [{ format: 'PKBarcodeFormatQR', message: shareUrl, messageEncoding: 'iso-8859-1' }],
    backgroundColor: colors.bg,
    foregroundColor: colors.fg,
    labelColor: colors.label,
  };
}

/* ============================================================ the .pkpass */

/**
 * card: a normalized Intro card. opts: {passTypeId, teamId, shareUrl,
 * signerCertPem, signerKeyPem, signerKeyPassphrase?, wwdrPem, now?}.
 * Returns the signed .pkpass as a Buffer.
 */
export function buildPkpass(card, opts) {
  const now = opts.now || new Date();
  const passJson = Buffer.from(JSON.stringify(buildPassJson(card, opts.shareUrl, opts), null, 2));
  const files = [
    { name: 'pass.json', data: passJson },
    { name: 'icon.png', data: passIcon(29) },
    { name: 'icon@2x.png', data: passIcon(58) },
    { name: 'icon@3x.png', data: passIcon(87) },
    { name: 'logo.png', data: passIcon(50) },
    { name: 'logo@2x.png', data: passIcon(100) },
  ];
  const manifest = {};
  for (const f of files) manifest[f.name] = crypto.createHash('sha1').update(f.data).digest('hex');
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
  const signature = buildCms(
    manifestBuf,
    pemToDer(opts.signerCertPem),
    opts.wwdrPem ? [pemToDer(opts.wwdrPem)] : [],
    opts.signerKeyPassphrase ? { key: opts.signerKeyPem, passphrase: opts.signerKeyPassphrase } : opts.signerKeyPem,
    now
  );
  return zipStore(
    [...files, { name: 'manifest.json', data: manifestBuf }, { name: 'signature', data: signature }],
    now
  );
}
