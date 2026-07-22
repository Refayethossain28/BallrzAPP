/**
 * Intro — the card engine
 * =======================
 *
 * Everything a digital business card needs, as pure deterministic logic:
 *
 *   · the card model — normalisation, length clamps, theme + social validation,
 *     so a card loaded from storage, a link or a QR code is always well-formed;
 *   · the share codec — a card packs into a compact, versioned, URL-safe token
 *     (short keys → JSON → from-scratch UTF-8 → from-scratch base64url), so a
 *     whole card travels inside a link's #fragment. No server, no database, no
 *     account: the link IS the card. Decoding is strict and returns null on
 *     anything malformed, truncated or from a future version;
 *   · the vCard 3.0 generator — RFC 2426 escaping, CRLF line endings, 75-char
 *     line folding and an embedded PHOTO, so "Save contact" drops the card
 *     straight into iOS/Android contacts;
 *   · social link building — paste a handle, an @handle or a full profile URL
 *     for any of the ten supported networks and the engine canonicalises it;
 *   · a from-scratch QR encoder (byte mode, ECC, masking — the same encoder
 *     verified bit-for-bit in Omni), so the share link renders as a scannable
 *     code entirely on-device;
 *   · a completeness score, so the editor can nudge toward a card worth handing
 *     to someone.
 *
 * No Date.now, no Math.random, no DOM, no atob/btoa/TextEncoder — timestamps
 * are passed in and every byte-level primitive is implemented here, so the
 * engine runs identically in the browser (window.Intro) and under Node/vm for
 * the unit tests (scripts/test-intro-logic.mjs). UMD, framework-free.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Intro = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var CODEC_VERSION = '1';
  var LINK_MAX = 32000;     // max encoded chars for a share link (avatar auto-dropped above this)
  var AVATAR_EDGE = 320;    // suggested avatar raster size (UI hint; engine just stores the data URL)

  /* ============================================================ small helpers */

  function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
  function trimTo(v, n) { return str(v).replace(/\s+/g, ' ').trim().slice(0, n); }

  /** Monogram for the avatar fallback: first letter of the first and last word. */
  function initials(name) {
    var words = str(name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    var a = words[0].charAt(0), b = words.length > 1 ? words[words.length - 1].charAt(0) : '';
    return (a + b).toUpperCase();
  }

  function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str(e).trim()); }

  /** Keep a leading + and digits — what tel: links and wa.me want. */
  function telDigits(p) {
    var s = str(p).trim(); if (!s) return '';
    var plus = s.charAt(0) === '+' ? '+' : '';
    var digits = s.replace(/\D/g, '');
    return digits ? plus + digits : '';
  }

  /** Add https:// when no scheme was typed; empty stays empty. */
  function normalizeUrl(u) {
    var s = str(u).trim(); if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';        // reject exotic schemes (javascript:, data:…)
    return 'https://' + s.replace(/^\/+/, '');
  }

  /** How a URL reads on the card face: no scheme, no www., no trailing slash. */
  function prettyUrl(u) {
    return str(u).trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  }

  /* ============================================================ socials */

  // base: profile URL prefix for a bare handle. match: recognise a pasted full URL.
  var SOCIALS = [
    { id: 'linkedin',  label: 'LinkedIn',  base: 'https://www.linkedin.com/in/', match: /linkedin\.com\/(?:in|company)\/([^/?#]+)/i },
    { id: 'x',         label: 'X',         base: 'https://x.com/',               match: /(?:x|twitter)\.com\/([^/?#]+)/i },
    { id: 'instagram', label: 'Instagram', base: 'https://instagram.com/',       match: /instagram\.com\/([^/?#]+)/i },
    { id: 'github',    label: 'GitHub',    base: 'https://github.com/',          match: /github\.com\/([^/?#]+)/i },
    { id: 'tiktok',    label: 'TikTok',    base: 'https://tiktok.com/@',         match: /tiktok\.com\/@?([^/?#]+)/i },
    { id: 'youtube',   label: 'YouTube',   base: 'https://youtube.com/@',        match: /youtube\.com\/(?:@|c\/|channel\/|user\/)?([^/?#]+)/i },
    { id: 'facebook',  label: 'Facebook',  base: 'https://facebook.com/',        match: /facebook\.com\/([^/?#]+)/i },
    { id: 'whatsapp',  label: 'WhatsApp',  base: 'https://wa.me/',               match: /wa\.me\/\+?(\d+)/i },
    { id: 'telegram',  label: 'Telegram',  base: 'https://t.me/',                match: /t\.me\/([^/?#]+)/i },
    { id: 'threads',   label: 'Threads',   base: 'https://threads.net/@',        match: /threads\.net\/@?([^/?#]+)/i }
  ];
  var SOCIAL_BY_ID = {};
  SOCIALS.forEach(function (s) { SOCIAL_BY_ID[s.id] = s; });

  /** Canonical stored handle: strips @, whitespace, and a pasted profile URL. */
  function socialHandle(id, value) {
    var meta = SOCIAL_BY_ID[id]; if (!meta) return '';
    var v = str(value).trim();
    var m = meta.match.exec(v);
    if (m) v = m[1];
    v = v.replace(/^@+/, '').replace(/\/+$/, '');
    if (id === 'whatsapp') v = telDigits(v).replace(/^\+/, '');
    return trimTo(v, 100);
  }

  /** Full profile URL for a stored handle. */
  function socialUrl(id, handle) {
    var meta = SOCIAL_BY_ID[id]; if (!meta) return '';
    var h = socialHandle(id, handle); if (!h) return '';
    return meta.base + h;
  }

  /* ============================================================ themes */

  // Pure data — the UI paints with these values; the engine only validates ids.
  var THEMES = [
    { id: 'onyx',      name: 'Onyx',      bg: 'radial-gradient(130% 140% at 50% -20%, #23201a 0%, #0d0b08 55%, #060504 100%)', ink: '#f5f0e8', sub: 'rgba(245,240,232,.62)', accent: '#d4af6e', line: 'rgba(212,175,110,.4)', chipBg: 'rgba(212,175,110,.12)', dark: true },
    { id: 'midnight',  name: 'Midnight',  bg: 'linear-gradient(150deg, #101736 0%, #0a0e1f 60%, #070a16 100%)',                ink: '#eef2ff', sub: 'rgba(238,242,255,.6)',  accent: '#8fa2ff', line: 'rgba(143,162,255,.4)', chipBg: 'rgba(143,162,255,.12)', dark: true },
    { id: 'aurora',    name: 'Aurora',    bg: 'linear-gradient(140deg, #0e2a2b 0%, #133b46 45%, #1d2447 100%)',                ink: '#ecfdf7', sub: 'rgba(236,253,247,.62)', accent: '#39e6b4', line: 'rgba(57,230,180,.4)',  chipBg: 'rgba(57,230,180,.12)',  dark: true },
    { id: 'ember',     name: 'Ember',     bg: 'linear-gradient(145deg, #2b1210 0%, #3d1a12 50%, #1c0c0a 100%)',                ink: '#fff1e8', sub: 'rgba(255,241,232,.62)', accent: '#ff9d6b', line: 'rgba(255,157,107,.4)', chipBg: 'rgba(255,157,107,.12)', dark: true },
    { id: 'forest',    name: 'Forest',    bg: 'linear-gradient(150deg, #12291b 0%, #0d1f15 55%, #081410 100%)',                ink: '#efffef', sub: 'rgba(239,255,239,.6)', accent: '#7ddb8f', line: 'rgba(125,219,143,.4)', chipBg: 'rgba(125,219,143,.12)', dark: true },
    { id: 'lavender',  name: 'Lavender',  bg: 'linear-gradient(145deg, #251b3f 0%, #1b1430 55%, #120d20 100%)',                ink: '#f4efff', sub: 'rgba(244,239,255,.62)', accent: '#c39bff', line: 'rgba(195,155,255,.4)', chipBg: 'rgba(195,155,255,.12)', dark: true },
    { id: 'porcelain', name: 'Porcelain', bg: 'linear-gradient(150deg, #ffffff 0%, #f3f1ec 60%, #e9e5dc 100%)',                ink: '#1c1a17', sub: 'rgba(28,26,23,.62)',    accent: '#8a6d2f', line: 'rgba(138,109,47,.35)', chipBg: 'rgba(138,109,47,.09)',  dark: false },
    { id: 'glacier',   name: 'Glacier',   bg: 'linear-gradient(150deg, #f4f9ff 0%, #e6eef9 55%, #d8e4f2 100%)',                ink: '#101828', sub: 'rgba(16,24,40,.6)',     accent: '#2563eb', line: 'rgba(37,99,235,.3)',   chipBg: 'rgba(37,99,235,.08)',   dark: false }
  ];
  var THEME_BY_ID = {};
  THEMES.forEach(function (t) { THEME_BY_ID[t.id] = t; });
  function theme(id) { return THEME_BY_ID[id] || THEMES[0]; }

  /* ============================================================ the card model */

  function blankCard(now) {
    var ts = typeof now === 'number' ? now : 0;
    return {
      id: '', name: '', title: '', company: '', tagline: '',
      phone: '', email: '', website: '', location: '', bio: '',
      socials: [],            // [{ k: 'linkedin', v: 'handle' }, …]
      theme: THEMES[0].id,
      avatar: '',             // data:image/…;base64,… or ''
      createdAt: ts, updatedAt: ts
    };
  }

  /** Sanitize anything card-shaped (storage, link, import) into a valid card. */
  function normalizeCard(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var c = blankCard(0);
    c.id = trimTo(r.id, 40);
    c.name = trimTo(r.name, 80);
    c.title = trimTo(r.title, 80);
    c.company = trimTo(r.company, 80);
    c.tagline = trimTo(r.tagline, 120);
    c.phone = trimTo(r.phone, 30);
    c.email = trimTo(r.email, 120);
    c.website = normalizeUrl(trimTo(r.website, 200));
    c.location = trimTo(r.location, 80);
    c.bio = str(r.bio).trim().slice(0, 280);
    c.theme = THEME_BY_ID[r.theme] ? r.theme : THEMES[0].id;
    var av = str(r.avatar);
    c.avatar = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(av) ? av : '';
    var socials = Array.isArray(r.socials) ? r.socials : [];
    for (var i = 0; i < socials.length && c.socials.length < 8; i++) {
      var s = socials[i] || {};
      var k = str(s.k), v = socialHandle(k, s.v);
      if (SOCIAL_BY_ID[k] && v && !c.socials.some(function (x) { return x.k === k; })) {
        c.socials.push({ k: k, v: v });
      }
    }
    c.createdAt = typeof r.createdAt === 'number' && isFinite(r.createdAt) ? r.createdAt : 0;
    c.updatedAt = typeof r.updatedAt === 'number' && isFinite(r.updatedAt) ? r.updatedAt : c.createdAt;
    return c;
  }

  /* ============================================================ UTF-8 + base64url (from scratch) */

  function utf8Encode(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var lo = s.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function utf8Decode(bytes) {
    var out = '', i = 0;
    while (i < bytes.length) {
      var b = bytes[i++], c;
      if (b < 0x80) c = b;
      else if (b < 0xE0) c = ((b & 31) << 6) | (bytes[i++] & 63);
      else if (b < 0xF0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      else c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      if (c >= 0x10000) { c -= 0x10000; out += String.fromCharCode(0xD800 + (c >> 10), 0xDC00 + (c & 0x3FF)); }
      else out += String.fromCharCode(c);
    }
    return out;
  }

  var B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64U_REV = (function () { var r = {}; for (var i = 0; i < 64; i++) r[B64U.charAt(i)] = i; return r; })();

  function b64uEncode(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : -1, b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
      out += B64U.charAt(b0 >> 2);
      out += B64U.charAt(((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4));
      if (b1 >= 0) out += B64U.charAt(((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6));
      if (b2 >= 0) out += B64U.charAt(b2 & 63);
    }
    return out;
  }

  function b64uDecode(s) {
    s = str(s); if (/[^A-Za-z0-9\-_]/.test(s) || s.length % 4 === 1) return null;
    var out = [];
    for (var i = 0; i < s.length; i += 4) {
      var n = 0, len = Math.min(4, s.length - i);
      for (var j = 0; j < 4; j++) n = (n << 6) | (j < len ? B64U_REV[s.charAt(i + j)] : 0);
      out.push((n >> 16) & 255);
      if (len > 2) out.push((n >> 8) & 255);
      if (len > 3) out.push(n & 255);
    }
    return out;
  }

  /* ============================================================ the share codec */

  // Short-key map keeps the token small; unknown keys are ignored on decode so
  // older apps can open newer cards.
  var PACK_KEYS = [
    ['n', 'name'], ['t', 'title'], ['c', 'company'], ['g', 'tagline'],
    ['p', 'phone'], ['e', 'email'], ['w', 'website'], ['l', 'location'],
    ['b', 'bio'], ['h', 'theme'], ['a', 'avatar']
  ];

  /**
   * Pack a card into a URL-safe token: '<ver>.<base64url(utf8(json))>'.
   * opts.avatar === false leaves the photo out (QR codes need short payloads).
   */
  function encodeCard(card, opts) {
    var c = normalizeCard(card);
    var withAvatar = !(opts && opts.avatar === false);
    var o = {};
    PACK_KEYS.forEach(function (kv) {
      var v = c[kv[1]];
      if (kv[1] === 'avatar' && !withAvatar) return;
      if (v) o[kv[0]] = v;
    });
    if (c.socials.length) o.s = c.socials.map(function (s) { return [s.k, s.v]; });
    return CODEC_VERSION + '.' + b64uEncode(utf8Encode(JSON.stringify(o)));
  }

  /** Strict inverse of encodeCard: null for anything malformed or future-versioned. */
  function decodeCard(token) {
    var s = str(token).trim();
    var dot = s.indexOf('.');
    if (dot < 1 || s.slice(0, dot) !== CODEC_VERSION) return null;
    var bytes = b64uDecode(s.slice(dot + 1));
    if (!bytes || !bytes.length) return null;
    var o;
    try { o = JSON.parse(utf8Decode(bytes)); } catch (e) { return null; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    var raw = {};
    PACK_KEYS.forEach(function (kv) { if (o[kv[0]] != null) raw[kv[1]] = o[kv[0]]; });
    if (Array.isArray(o.s)) raw.socials = o.s.map(function (p) { return Array.isArray(p) ? { k: p[0], v: p[1] } : {}; });
    var card = normalizeCard(raw);
    return card.name || card.email || card.phone ? card : null;   // an empty card is not a card
  }

  /**
   * The shareable link. The photo rides along when the token stays under
   * LINK_MAX; otherwise it is dropped so the link always works everywhere.
   */
  function shareUrl(base, card) {
    var b = str(base).split('#')[0];
    var token = encodeCard(card);
    if (token.length > LINK_MAX) token = encodeCard(card, { avatar: false });
    return b + '#c=' + token;
  }

  /** Pull the card token out of a location.hash (or a whole pasted URL). */
  function parseHash(hash) {
    var m = /#?c=([0-9]+\.[A-Za-z0-9\-_]+)/.exec(str(hash));
    return m ? m[1] : null;
  }

  /* ============================================================ vCard 3.0 */

  function vEsc(s) {
    return str(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  }

  /** RFC 2426 line folding: continuation lines start with a single space. */
  function vFold(line) {
    var out = '', first = true;
    while (line.length > 74) { out += (first ? '' : ' ') + line.slice(0, 74) + '\r\n'; line = line.slice(74); first = false; }
    return out + (first ? '' : ' ') + line;
  }

  /** A vCard 3.0 the phone's contacts app understands, photo included. */
  function vcard(card, revIso) {
    var c = normalizeCard(card);
    var words = c.name.split(' ').filter(Boolean);
    var family = words.length > 1 ? words[words.length - 1] : '';
    var given = words.length > 1 ? words.slice(0, -1).join(' ') : c.name;
    var lines = ['BEGIN:VCARD', 'VERSION:3.0'];
    lines.push(vFold('FN:' + vEsc(c.name || 'Unknown')));
    lines.push(vFold('N:' + vEsc(family) + ';' + vEsc(given) + ';;;'));
    if (c.company) lines.push(vFold('ORG:' + vEsc(c.company)));
    if (c.title) lines.push(vFold('TITLE:' + vEsc(c.title)));
    if (c.phone) lines.push(vFold('TEL;TYPE=CELL:' + vEsc(c.phone)));
    if (c.email) lines.push(vFold('EMAIL;TYPE=INTERNET:' + vEsc(c.email)));
    if (c.website) lines.push(vFold('URL:' + vEsc(c.website)));
    if (c.location) lines.push(vFold('ADR;TYPE=WORK:;;' + vEsc(c.location) + ';;;;'));
    if (c.bio || c.tagline) lines.push(vFold('NOTE:' + vEsc(c.bio || c.tagline)));
    c.socials.forEach(function (s) {
      lines.push(vFold('X-SOCIALPROFILE;TYPE=' + s.k + ':' + vEsc(socialUrl(s.k, s.v))));
    });
    var photo = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(c.avatar);
    if (photo) {
      var kind = photo[1].toLowerCase() === 'png' ? 'PNG' : 'JPEG';
      lines.push(vFold('PHOTO;ENCODING=b;TYPE=' + kind + ':' + photo[2]));
    }
    if (revIso) lines.push('REV:' + str(revIso));
    lines.push('END:VCARD');
    return lines.join('\r\n') + '\r\n';
  }

  function vcardFilename(card) {
    var slug = str(card && card.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return (slug || 'contact') + '.vcf';
  }

  /* ============================================================ completeness */

  var COMPLETENESS = [
    { key: 'name',    pts: 25, label: 'your name',            has: function (c) { return !!c.name; } },
    { key: 'role',    pts: 15, label: 'a title or company',   has: function (c) { return !!(c.title || c.company); } },
    { key: 'contact', pts: 25, label: 'a phone or email',     has: function (c) { return !!(c.phone || c.email); } },
    { key: 'website', pts: 10, label: 'a website',            has: function (c) { return !!c.website; } },
    { key: 'photo',   pts: 10, label: 'a photo',              has: function (c) { return !!c.avatar; } },
    { key: 'socials', pts: 10, label: 'a social profile',     has: function (c) { return c.socials.length > 0; } },
    { key: 'bio',     pts: 5,  label: 'a short bio',          has: function (c) { return !!(c.bio || c.tagline); } }
  ];

  function completeness(card) {
    var c = normalizeCard(card), pct = 0, missing = [];
    COMPLETENESS.forEach(function (f) { if (f.has(c)) pct += f.pts; else missing.push(f.label); });
    return { pct: pct, missing: missing };
  }

  /* ============================================================ QR encoder (byte mode, from scratch — no libs) */

  var QR_ECC = { L: 0, M: 1, Q: 2, H: 3 };
  var QR_ECC_CW = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]];
  var QR_ECC_BLK = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]];

  function qrGfMul(x, y) { var z = 0; for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; }
  function qrRsGen(deg) {
    var r = new Array(deg); for (var i = 0; i < deg; i++) r[i] = 0; r[deg - 1] = 1; var root = 1;
    for (var i = 0; i < deg; i++) { for (var j = 0; j < r.length; j++) { r[j] = qrGfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; } root = qrGfMul(root, 0x02); } return r;
  }
  function qrRsRem(data, div) {
    var r = new Array(div.length); for (var i = 0; i < r.length; i++) r[i] = 0;
    for (var k = 0; k < data.length; k++) { var factor = data[k] ^ r.shift(); r.push(0); for (var i = 0; i < div.length; i++) r[i] ^= qrGfMul(div[i], factor); } return r;
  }
  function qrRawModules(ver) { var r = (16 * ver + 128) * ver + 64; if (ver >= 2) { var n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; } return r; }
  function qrDataCodewords(ver, ecl) { return Math.floor(qrRawModules(ver) / 8) - QR_ECC_CW[ecl][ver] * QR_ECC_BLK[ecl][ver]; }
  function qrAlignPos(ver) {
    if (ver === 1) return []; var num = Math.floor(ver / 7) + 2; var size = ver * 4 + 17;
    var step = (ver === 32) ? 26 : Math.ceil((size - 13) / (2 * num - 2)) * 2; var out = [6];
    for (var pos = size - 7; out.length < num; pos -= step) out.splice(1, 0, pos); return out;
  }
  function qrBit(x, i) { return ((x >>> i) & 1) !== 0; }
  function qrSetFn(m, fn, x, y, dark) { if (y < 0 || y >= m.length || x < 0 || x >= m.length) return; m[y][x] = dark; fn[y][x] = true; }
  function qrAddEcc(data, ver, ecl) {
    var numBlocks = QR_ECC_BLK[ecl][ver], blockEcc = QR_ECC_CW[ecl][ver], raw = Math.floor(qrRawModules(ver) / 8);
    var numShort = numBlocks - raw % numBlocks, shortLen = Math.floor(raw / numBlocks), div = qrRsGen(blockEcc), blocks = [];
    for (var i = 0, k = 0; i < numBlocks; i++) { var dat = data.slice(k, k + shortLen - blockEcc + (i < numShort ? 0 : 1)); k += dat.length;
      var ecc = qrRsRem(dat, div); if (i < numShort) dat.push(0); blocks.push(dat.concat(ecc)); }
    var out = [];
    for (var j = 0; j < blocks[0].length; j++) for (var bi = 0; bi < blocks.length; bi++) { if (j === shortLen - blockEcc && bi < numShort) continue; out.push(blocks[bi][j]); }
    return out;
  }
  function qrReserveFmt(m, fn, size) {
    for (var i = 0; i <= 8; i++) { if (i !== 6) { qrSetFn(m, fn, 8, i, false); qrSetFn(m, fn, i, 8, false); } }
    for (var i = 0; i < 8; i++) { qrSetFn(m, fn, size - 1 - i, 8, false); qrSetFn(m, fn, 8, size - 1 - i, false); } qrSetFn(m, fn, 8, size - 8, true);
  }
  function qrDrawFmt(m, ecl, mask, size) {
    var fb = [1, 0, 3, 2][ecl]; var data = (fb << 3) | mask; var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); var bits = ((data << 10) | rem) ^ 0x5412;
    for (var i = 0; i <= 5; i++) m[i][8] = qrBit(bits, i); m[7][8] = qrBit(bits, 6); m[8][8] = qrBit(bits, 7); m[8][7] = qrBit(bits, 8);
    for (var i = 9; i < 15; i++) m[8][14 - i] = qrBit(bits, i);
    for (var i = 0; i < 8; i++) m[8][size - 1 - i] = qrBit(bits, i); for (var i = 8; i < 15; i++) m[size - 15 + i][8] = qrBit(bits, i); m[size - 8][8] = true;
  }
  function qrDrawVersion(m, fn, ver, size) {
    if (ver < 7) return; var rem = ver; for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25); var bits = (ver << 12) | rem;
    for (var i = 0; i < 18; i++) { var bit = qrBit(bits, i); var a = size - 11 + i % 3, b = Math.floor(i / 3); qrSetFn(m, fn, a, b, bit); qrSetFn(m, fn, b, a, bit); }
  }
  function qrPenalty(m) {
    var n = m.length, s = 0;
    function lineRun(arr) { var t = 0, run = 1; for (var i = 1; i < arr.length; i++) { if (arr[i] === arr[i - 1]) { run++; if (run === 5) t += 3; else if (run > 5) t++; } else run = 1; } return t; }
    function rowStr(arr) { var o = ''; for (var i = 0; i < arr.length; i++) o += arr[i] ? '1' : '0'; return o; }
    function occ(str2, p) { var c = 0, i = 0; while ((i = str2.indexOf(p, i)) >= 0) { c++; i++; } return c; }
    var pA = '10111010000', pB = '00001011101';
    for (var y = 0; y < n; y++) { s += lineRun(m[y]); var sr = rowStr(m[y]); s += 40 * (occ(sr, pA) + occ(sr, pB)); }
    for (var x = 0; x < n; x++) { var col = []; for (var y2 = 0; y2 < n; y2++) col.push(m[y2][x]); s += lineRun(col); var sc = rowStr(col); s += 40 * (occ(sc, pA) + occ(sc, pB)); }
    for (var y3 = 0; y3 < n - 1; y3++) for (var x2 = 0; x2 < n - 1; x2++) { var c = m[y3][x2]; if (c === m[y3][x2 + 1] && c === m[y3 + 1][x2] && c === m[y3 + 1][x2 + 1]) s += 3; }
    var dark = 0; for (var y4 = 0; y4 < n; y4++) for (var x3 = 0; x3 < n; x3++) if (m[y4][x3]) dark++;
    s += Math.floor(Math.abs(dark / (n * n) * 100 - 50) / 5) * 10; return s;
  }
  function qrMatrix(text, eclName, forcedMask) {
    var ecl = QR_ECC[eclName]; if (ecl == null) ecl = 1;
    var bytes = utf8Encode(String(text)); var ver = 1, dataCW = 0;
    for (; ver <= 40; ver++) { dataCW = qrDataCodewords(ver, ecl); var cc = ver < 10 ? 8 : 16; if (4 + cc + bytes.length * 8 <= dataCW * 8) break; }
    if (ver > 40) throw new Error('Too much data for a QR code');
    var bb = []; function ab(v, l) { for (var i = l - 1; i >= 0; i--) bb.push((v >>> i) & 1); }
    ab(0x4, 4); ab(bytes.length, ver < 10 ? 8 : 16); for (var i = 0; i < bytes.length; i++) ab(bytes[i], 8);
    var cap = dataCW * 8; ab(0, Math.min(4, cap - bb.length)); if (bb.length % 8) ab(0, 8 - bb.length % 8);
    for (var pad = 0xEC; bb.length < cap; pad ^= 0xEC ^ 0x11) ab(pad, 8);
    var data = []; for (var k = 0; k < bb.length; k += 8) { var b = 0; for (var j = 0; j < 8; j++) b = (b << 1) | bb[k + j]; data.push(b); }
    var allCW = qrAddEcc(data, ver, ecl);
    var size = ver * 4 + 17, m = [], fn = [];
    for (var r = 0; r < size; r++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    for (var i2 = 0; i2 < size; i2++) { qrSetFn(m, fn, 6, i2, i2 % 2 === 0); qrSetFn(m, fn, i2, 6, i2 % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) { var d = Math.max(Math.abs(dx), Math.abs(dy)); qrSetFn(m, fn, c[0] + dx, c[1] + dy, d !== 2 && d !== 4); }
    });
    var ap = qrAlignPos(ver), na = ap.length;
    for (var ai = 0; ai < na; ai++) for (var aj = 0; aj < na; aj++) {
      if ((ai === 0 && aj === 0) || (ai === 0 && aj === na - 1) || (ai === na - 1 && aj === 0)) continue;
      for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++) qrSetFn(m, fn, ap[ai] + dx2, ap[aj] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
    }
    qrReserveFmt(m, fn, size); qrDrawVersion(m, fn, ver, size);
    var bi = 0; for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) { for (var jj = 0; jj < 2; jj++) { var x = right - jj; var up = ((right + 1) & 2) === 0; var y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < allCW.length * 8) { m[y][x] = qrBit(allCW[bi >>> 3], 7 - (bi & 7)); bi++; } } }
    }
    function clone(src) { return src.map(function (row) { return row.slice(); }); }
    function apply(mm, msk) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) { if (fn[y][x]) continue; var inv;
        switch (msk) { case 0: inv = (x + y) % 2 === 0; break; case 1: inv = y % 2 === 0; break; case 2: inv = x % 3 === 0; break; case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break; case 5: inv = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: inv = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break; default: inv = ((x + y) % 2 + (x * y) % 3) % 2 === 0; }
        if (inv) mm[y][x] = !mm[y][x]; }
    }
    var best = null, bestPen = Infinity, masks = (typeof forcedMask === 'number') ? [forcedMask] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (var mi = 0; mi < masks.length; mi++) { var cand = clone(m); apply(cand, masks[mi]); qrDrawFmt(cand, ecl, masks[mi], size);
      var pen = (masks.length === 1) ? 0 : qrPenalty(cand); if (pen < bestPen) { bestPen = pen; best = cand; } }
    return best;
  }
  function qrSvg(text, ecl) {
    var m = qrMatrix(text, ecl); var n = m.length, q = 4, size = n + q * 2, scale = 8, rects = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (m[y][x]) rects += '<rect x="' + (x + q) + '" y="' + (y + q) + '" width="1.02" height="1.02"/>';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + (size * scale) + '" height="' + (size * scale) + '" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" style="max-width:100%;height:auto;display:block"><rect width="' + size + '" height="' + size + '" fill="#fff"/><g fill="#000">' + rects + '</g></svg>';
  }

  /* ============================================================ exports */

  return {
    version: VERSION,
    CODEC_VERSION: CODEC_VERSION, LINK_MAX: LINK_MAX, AVATAR_EDGE: AVATAR_EDGE,
    THEMES: THEMES, theme: theme,
    SOCIALS: SOCIALS, socialHandle: socialHandle, socialUrl: socialUrl,
    initials: initials, isEmail: isEmail, telDigits: telDigits,
    normalizeUrl: normalizeUrl, prettyUrl: prettyUrl,
    blankCard: blankCard, normalizeCard: normalizeCard,
    encodeCard: encodeCard, decodeCard: decodeCard, shareUrl: shareUrl, parseHash: parseHash,
    vcard: vcard, vcardFilename: vcardFilename,
    completeness: completeness,
    utf8Encode: utf8Encode, utf8Decode: utf8Decode, b64uEncode: b64uEncode, b64uDecode: b64uDecode,
    qrMatrix: qrMatrix, qrSvg: qrSvg
  };
});
