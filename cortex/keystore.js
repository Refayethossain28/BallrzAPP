/**
 * Cortex keystore — encrypt a wallet private key at rest, dependency-free.
 * =======================================================================
 *
 * A known gap for browser wallets (coin/SECURITY.md #1) is that private keys sit
 * in plaintext in localStorage. This closes it for Cortex: a passphrase-encrypted
 * key box you can persist safely. It uses only what coin/engine.js already ships
 * — SHA-256 and HMAC-SHA256 — so there are no dependencies and nothing exotic:
 *
 *   • KDF: the passphrase + a random salt are hashed through many SHA-256
 *     iterations (work factor `iters`) into a 32-byte master key — deliberately
 *     slow, so guessing a weak passphrase is expensive.
 *   • Cipher: a SHA-256 counter-mode keystream XORed over the 32 key bytes.
 *   • Integrity: an HMAC-SHA256 tag over the ciphertext, checked before
 *     decrypting, so a wrong passphrase or any tampering is rejected — not
 *     silently turned into a bogus key.
 *
 * This is authenticated encryption built from a hash, appropriate for protecting
 * a local key with a user passphrase. It is NOT a substitute for a hardware
 * wallet or a vetted KDF like scrypt/argon2; a very weak passphrase is still
 * weak. See cortex/SECURITY.md.
 *
 * UMD; reuses BallrzCoin (sha256, hmacSha256, hex/byte helpers). Registers
 * global BallrzCortexKeystore.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzCortexKeystore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function coin() {
    var g = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this;
    if (g && g.BallrzCoin) return g.BallrzCoin;
    throw new Error('coin/engine.js must be loaded before keystore.js');
  }

  var DEFAULT_ITERS = 200000;

  // 32-byte master key from passphrase + salt, stretched over `iters` SHA-256s.
  function deriveKey(passphrase, saltHex, iters) {
    var C = coin(), h = C.sha256('cortex-ks:' + String(passphrase) + ':' + saltHex);
    for (var i = 0; i < iters; i++) h = C.sha256(h + saltHex);
    return h; // 64 hex chars = 32 bytes
  }

  // SHA-256 counter-mode keystream, `nBytes` long, as a byte array.
  function keystream(encKey, saltHex, nBytes) {
    var C = coin(), out = [], c = 0;
    while (out.length < nBytes) {
      var block = C.hexToBytes(C.sha256(encKey + ':' + saltHex + ':' + c));
      for (var i = 0; i < block.length && out.length < nBytes; i++) out.push(block[i]);
      c++;
    }
    return out;
  }

  // Constant-ish-time hex compare (avoids leaking where a mismatch is).
  function equalHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    var diff = 0; for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  function randomSaltHex() {
    var g = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this;
    var bytes = new Array(16), i;
    if (g && g.crypto && g.crypto.getRandomValues) {
      var a = new Uint8Array(16); g.crypto.getRandomValues(a);
      for (i = 0; i < 16; i++) bytes[i] = a[i];
    } else {
      throw new Error('no secure RNG available — pass an explicit salt');
    }
    return coin().bytesToHex(bytes);
  }

  // Encrypt a 32-byte private key (hex) under a passphrase → a portable box.
  //   opts: { salt (hex, for tests/determinism), iters }
  function encryptKey(privHex, passphrase, opts) {
    opts = opts || {};
    var C = coin();
    if (!/^[0-9a-fA-F]{64}$/.test(String(privHex))) throw new Error('private key must be 32 bytes hex');
    var salt = opts.salt || randomSaltHex();
    var iters = opts.iters || DEFAULT_ITERS;
    var key = deriveKey(passphrase, salt, iters);
    var encKey = C.sha256(key + ':enc'), macKey = C.sha256(key + ':mac');
    var pt = C.hexToBytes(privHex), ks = keystream(encKey, salt, pt.length);
    var ct = new Array(pt.length); for (var i = 0; i < pt.length; i++) ct[i] = pt[i] ^ ks[i];
    var ctHex = C.bytesToHex(ct);
    // HMAC-SHA256 over the ciphertext (coin's hmac takes BYTE arrays, not strings).
    var mac = C.hmacSha256(C.hexToBytes(macKey), C.hexToBytes(salt + ctHex));
    return { v: 1, kdf: 'sha256-iter', iters: iters, salt: salt, ct: ctHex, mac: mac };
  }

  // Decrypt a box back to the private key hex. Throws on a wrong passphrase or
  // any tampering (the MAC is checked first).
  function decryptKey(box, passphrase) {
    var C = coin();
    if (!box || box.v !== 1 || !box.salt || !box.ct || !box.mac) throw new Error('not a valid key box');
    var key = deriveKey(passphrase, box.salt, box.iters || DEFAULT_ITERS);
    var encKey = C.sha256(key + ':enc'), macKey = C.sha256(key + ':mac');
    if (!equalHex(C.hmacSha256(C.hexToBytes(macKey), C.hexToBytes(box.salt + box.ct)), box.mac)) throw new Error('wrong passphrase or corrupted key box');
    var ct = C.hexToBytes(box.ct), ks = keystream(encKey, box.salt, ct.length);
    var pt = new Array(ct.length); for (var i = 0; i < ct.length; i++) pt[i] = ct[i] ^ ks[i];
    return C.bytesToHex(pt);
  }

  return { version: '1.0.0', DEFAULT_ITERS: DEFAULT_ITERS, encryptKey: encryptKey, decryptKey: decryptKey, randomSaltHex: randomSaltHex };
});
