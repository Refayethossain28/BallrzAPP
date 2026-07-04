/**
 * BallrzCoin (BLZ) — a Bitcoin-style cryptocurrency engine
 * ========================================================
 *
 * A complete, dependency-free proof-of-work cryptocurrency core, built the way
 * Bitcoin is built — not a token on someone else's chain, but the whole stack
 * from raw bytes up:
 *
 *   • SHA-256 (and double-SHA-256) implemented from the FIPS 180-4 spec
 *   • HMAC-SHA256, used for RFC 6979 deterministic ECDSA nonces
 *   • secp256k1 elliptic-curve ECDSA — the exact curve Bitcoin uses — with
 *     compressed public keys and low-S signature normalisation (BIP-62)
 *   • base58check addresses (version byte 0x19, so addresses start with 'B')
 *   • a UTXO ledger: coins exist only as unspent transaction outputs, and a
 *     transaction is a set of signed inputs consuming them plus new outputs
 *   • merkle trees committing every block to its transactions
 *   • proof-of-work mining against a 256-bit target, with Bitcoin-style
 *     difficulty retargeting (clamped ×4 either way each window)
 *   • a halving block-subsidy schedule and a hard supply cap — by default
 *     only 21 BLZ will ever exist, a million times scarcer than Bitcoin
 *   • fork choice by *cumulative work* (not length), so `replaceChain` lets
 *     independent nodes converge — the UI syncs tabs over BroadcastChannel
 *
 * Simplifications vs. real Bitcoin (this is a teaching prototype, not money):
 * no script language (outputs pay a public-key hash directly), no coinbase
 * maturity delay, JSON serialisation instead of the wire format, hash160 is
 * double-SHA-256 truncated to 20 bytes (no RIPEMD-160), and networking is
 * left to the caller (same-origin tabs sync in index.html).
 *
 * Everything is deterministic: no clock reads except where a timestamp is
 * passed in, no randomness except wallet generation (which accepts injected
 * entropy). That's what makes the consensus rules — the part that's easy to
 * get subtly wrong — fully unit-testable in scripts/test-coin-logic.mjs.
 *
 * Loaded the same UMD way as ripple/engine.js, so it runs both in the browser
 * (`self.BallrzCoin`) and in the Node test sandbox (`module.exports`).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzCoin = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ======================================================================
   * Monetary constants
   * ==================================================================== */
  var COIN = 100000000;                    // 1 BLZ = 100,000,000 blazes (like satoshis)
  var MAX_MONEY = 21000000 * COIN;         // absolute sanity bound on any single output

  var DEFAULT_PARAMS = {
    name: 'BallrzCoin',
    ticker: 'BLZ',
    // Scarcity is the whole game: Bitcoin caps at 21,000,000 coins; BallrzCoin
    // caps at 21. The 0.05 BLZ subsidy halving every 210 blocks sums (like
    // Bitcoin's geometric series) to just under 21 BLZ ever — a million times
    // scarcer than Bitcoin.
    initialSubsidy: 5000000,               // 0.05 BLZ block reward at height 1
    halvingInterval: 210,                  // reward halves every N blocks (Bitcoin: 210,000)
    retargetInterval: 10,                  // difficulty adjusts every N blocks (Bitcoin: 2,016)
    targetBlockTimeMs: 15000,              // aim for one block per 15s (Bitcoin: 10 min)
    genesisTarget: '000' + repeatChar('f', 61), // proof-of-work limit: 12 leading zero bits
    genesisTimestamp: 1783123200000,       // 2026-07-04T00:00Z, fixed so every node derives the identical genesis
    genesisMessage: '04/Jul/2026 BallrzAPP declares monetary independence',
    maxBlockTxs: 100                       // transfers per block, excluding the coinbase
  };

  function repeatChar(c, n) { var s = ''; while (n-- > 0) s += c; return s; }

  /* ======================================================================
   * Bytes & hex
   * ==================================================================== */
  var HEX = '0123456789abcdef';

  function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
    return s;
  }

  function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) throw new Error('bad hex');
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function utf8ToBytes(str) {
    // Hand-rolled so the engine has zero environment dependencies (TextEncoder
    // is absent in the vm test sandbox).
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xffff) i++; // surrogate pair consumed
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function concatBytes() {
    var len = 0, i;
    for (i = 0; i < arguments.length; i++) len += arguments[i].length;
    var out = new Uint8Array(len), off = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], off); off += arguments[i].length; }
    return out;
  }

  /* ======================================================================
   * SHA-256 (FIPS 180-4) — pure JS, byte-array in, byte-array out
   * ==================================================================== */
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256Bytes(bytes) {
    var len = bytes.length;
    var padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
    dv.setUint32(padded.length - 4, (len << 3) >>> 0);

    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var w = new Array(64);

    for (var off = 0; off < padded.length; off += 64) {
      var i;
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var s0 = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) >>> 0;
        var s1 = (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (i = 0; i < 64; i++) {
        var S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
        var S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    var out = new Uint8Array(32);
    var odv = new DataView(out.buffer);
    odv.setUint32(0, h0); odv.setUint32(4, h1); odv.setUint32(8, h2); odv.setUint32(12, h3);
    odv.setUint32(16, h4); odv.setUint32(20, h5); odv.setUint32(24, h6); odv.setUint32(28, h7);
    return out;
  }

  function toBytes(data) { return typeof data === 'string' ? utf8ToBytes(data) : data; }
  function sha256Hex(data) { return bytesToHex(sha256Bytes(toBytes(data))); }
  function sha256dBytes(data) { return sha256Bytes(sha256Bytes(toBytes(data))); }
  function sha256dHex(data) { return bytesToHex(sha256dBytes(data)); }

  /* ======================================================================
   * HMAC-SHA256 (RFC 2104) — needed for RFC 6979 deterministic nonces
   * ==================================================================== */
  function hmacSha256(keyBytes, msgBytes) {
    var key = keyBytes.length > 64 ? sha256Bytes(keyBytes) : keyBytes;
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
      var k = i < key.length ? key[i] : 0;
      ipad[i] = k ^ 0x36;
      opad[i] = k ^ 0x5c;
    }
    return sha256Bytes(concatBytes(opad, sha256Bytes(concatBytes(ipad, msgBytes))));
  }
  function hmacSha256Hex(keyBytes, msgBytes) { return bytesToHex(hmacSha256(keyBytes, msgBytes)); }

  /* ======================================================================
   * secp256k1 — the Bitcoin curve: y² = x³ + 7 over F_p
   * ==================================================================== */
  var CURVE_P = BigInt('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f');
  var CURVE_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  var G = {
    x: BigInt('0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
    y: BigInt('0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8')
  };
  var ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), THREE = BigInt(3), SEVEN = BigInt(7);

  function mod(a, m) { var r = a % m; return r < ZERO ? r + m : r; }

  function invMod(a, m) {
    // Extended Euclid — much faster than Fermat for our BigInt sizes.
    var lm = ONE, hm = ZERO, low = mod(a, m), high = m;
    while (low > ONE) {
      var q = high / low;
      var nm = hm - lm * q, nw = high - low * q;
      hm = lm; high = low; lm = nm; low = nw;
    }
    if (low !== ONE) throw new Error('no modular inverse');
    return mod(lm, m);
  }

  function modPow(base, exp, m) {
    var r = ONE, b = mod(base, m), e = exp;
    while (e > ZERO) {
      if (e & ONE) r = (r * b) % m;
      b = (b * b) % m;
      e >>= ONE;
    }
    return r;
  }

  // Points are {x, y} in affine coordinates; null is the point at infinity.
  function pointAdd(p, q) {
    if (!p) return q;
    if (!q) return p;
    var lam;
    if (p.x === q.x) {
      if (mod(p.y + q.y, CURVE_P) === ZERO) return null;       // opposite points
      lam = mod(THREE * p.x * p.x * invMod(TWO * p.y, CURVE_P), CURVE_P); // doubling (a = 0)
    } else {
      lam = mod((q.y - p.y) * invMod(mod(q.x - p.x, CURVE_P), CURVE_P), CURVE_P);
    }
    var x3 = mod(lam * lam - p.x - q.x, CURVE_P);
    var y3 = mod(lam * (p.x - x3) - p.y, CURVE_P);
    return { x: x3, y: y3 };
  }

  function pointMul(k, p) {
    var r = null, q = p, e = k;
    while (e > ZERO) {
      if (e & ONE) r = pointAdd(r, q);
      q = pointAdd(q, q);
      e >>= ONE;
    }
    return r;
  }

  function padHex64(n) {
    var s = n.toString(16);
    while (s.length < 64) s = '0' + s;
    return s;
  }

  function getPublicKey(privHex) {
    var d = BigInt('0x' + privHex);
    if (d <= ZERO || d >= CURVE_N) throw new Error('private key out of range');
    var Q = pointMul(d, G);
    return ((Q.y & ONE) ? '03' : '02') + padHex64(Q.x); // compressed, like modern Bitcoin
  }

  function decompressPoint(pubHex) {
    if (typeof pubHex !== 'string' || pubHex.length !== 66) throw new Error('bad public key');
    var prefix = pubHex.slice(0, 2);
    if (prefix !== '02' && prefix !== '03') throw new Error('bad public key prefix');
    var x = BigInt('0x' + pubHex.slice(2));
    if (x >= CURVE_P) throw new Error('public key x out of range');
    var y2 = mod(x * x * x + SEVEN, CURVE_P);
    var y = modPow(y2, (CURVE_P + ONE) >> TWO, CURVE_P);      // sqrt: p ≡ 3 (mod 4)
    if (mod(y * y, CURVE_P) !== y2) throw new Error('point not on curve');
    if ((y & ONE) !== (prefix === '03' ? ONE : ZERO)) y = CURVE_P - y;
    return { x: x, y: y };
  }

  /* ---- RFC 6979: deterministic nonce k, so signing never needs an RNG ---- */
  function int2octets(n) { return hexToBytes(padHex64(n)); }

  function rfc6979Nonces(msgHashBytes, d) {
    // Returns a "next()" generator of candidate nonces per RFC 6979 §3.2.
    var x = int2octets(d);
    var h1 = int2octets(mod(BigInt('0x' + bytesToHex(msgHashBytes)), CURVE_N)); // bits2octets
    var V = new Uint8Array(32), K = new Uint8Array(32);
    V.fill(1); K.fill(0);
    K = hmacSha256(K, concatBytes(V, new Uint8Array([0]), x, h1));
    V = hmacSha256(K, V);
    K = hmacSha256(K, concatBytes(V, new Uint8Array([1]), x, h1));
    V = hmacSha256(K, V);
    return function next() {
      for (;;) {
        V = hmacSha256(K, V);
        var k = BigInt('0x' + bytesToHex(V));
        if (k >= ONE && k < CURVE_N) {
          // arm the retry path before returning, per the RFC
          var out = k;
          K = hmacSha256(K, concatBytes(V, new Uint8Array([0])));
          V = hmacSha256(K, V);
          return out;
        }
        K = hmacSha256(K, concatBytes(V, new Uint8Array([0])));
        V = hmacSha256(K, V);
      }
    };
  }

  function sign(msgHashHex, privHex) {
    if (typeof msgHashHex !== 'string' || msgHashHex.length !== 64) throw new Error('message hash must be 32 bytes hex');
    var d = BigInt('0x' + privHex);
    if (d <= ZERO || d >= CURVE_N) throw new Error('private key out of range');
    var e = mod(BigInt('0x' + msgHashHex), CURVE_N);
    var next = rfc6979Nonces(hexToBytes(msgHashHex), d);
    for (;;) {
      var k = next();
      var R = pointMul(k, G);
      var r = mod(R.x, CURVE_N);
      if (r === ZERO) continue;
      var s = mod(invMod(k, CURVE_N) * mod(e + r * d, CURVE_N), CURVE_N);
      if (s === ZERO) continue;
      if (s > CURVE_N >> ONE) s = CURVE_N - s;               // low-S (BIP-62)
      return padHex64(r) + padHex64(s);
    }
  }

  function verify(msgHashHex, sigHex, pubHex) {
    try {
      if (typeof sigHex !== 'string' || sigHex.length !== 128) return false;
      var r = BigInt('0x' + sigHex.slice(0, 64));
      var s = BigInt('0x' + sigHex.slice(64));
      if (r <= ZERO || r >= CURVE_N || s <= ZERO || s >= CURVE_N) return false;
      var Q = decompressPoint(pubHex);
      var e = mod(BigInt('0x' + msgHashHex), CURVE_N);
      var w = invMod(s, CURVE_N);
      var u1 = mod(e * w, CURVE_N);
      var u2 = mod(r * w, CURVE_N);
      var X = pointAdd(pointMul(u1, G), pointMul(u2, Q));
      if (!X) return false;
      return mod(X.x, CURVE_N) === r;
    } catch (err) {
      return false;
    }
  }

  /* ======================================================================
   * base58check addresses
   * ==================================================================== */
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var ADDRESS_VERSION = 0x19; // 25 → addresses start with 'B'

  function base58Encode(bytes) {
    var n = ZERO, i;
    for (i = 0; i < bytes.length; i++) n = (n << BigInt(8)) + BigInt(bytes[i]);
    var s = '';
    var FIFTY_EIGHT = BigInt(58);
    while (n > ZERO) { s = B58[Number(n % FIFTY_EIGHT)] + s; n /= FIFTY_EIGHT; }
    for (i = 0; i < bytes.length && bytes[i] === 0; i++) s = '1' + s; // leading zeros
    return s;
  }

  function base58Decode(str) {
    var n = ZERO, i;
    var FIFTY_EIGHT = BigInt(58);
    for (i = 0; i < str.length; i++) {
      var v = B58.indexOf(str[i]);
      if (v < 0) throw new Error('bad base58 character');
      n = n * FIFTY_EIGHT + BigInt(v);
    }
    var hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    var body = n === ZERO ? new Uint8Array(0) : hexToBytes(hex);
    var zeros = 0;
    while (zeros < str.length && str[zeros] === '1') zeros++;
    return concatBytes(new Uint8Array(zeros), body);
  }

  function base58Check(versionByte, payload) {
    var data = concatBytes(new Uint8Array([versionByte]), payload);
    var checksum = sha256dBytes(data).slice(0, 4);
    return base58Encode(concatBytes(data, checksum));
  }

  function base58CheckDecode(str) {
    var raw = base58Decode(str);
    if (raw.length < 5) throw new Error('too short');
    var data = raw.slice(0, raw.length - 4);
    var checksum = raw.slice(raw.length - 4);
    var expect = sha256dBytes(data).slice(0, 4);
    for (var i = 0; i < 4; i++) if (checksum[i] !== expect[i]) throw new Error('bad checksum');
    return { version: data[0], payload: data.slice(1) };
  }

  function addressFromPublicKey(pubHex) {
    // Bitcoin uses RIPEMD160(SHA256(pub)); we use double-SHA256 truncated to
    // 20 bytes — same shape (short hash of the key), one less algorithm.
    var h160 = sha256dBytes(hexToBytes(pubHex)).slice(0, 20);
    return base58Check(ADDRESS_VERSION, h160);
  }

  function isValidAddress(addr) {
    try {
      var d = base58CheckDecode(addr);
      return d.version === ADDRESS_VERSION && d.payload.length === 20;
    } catch (err) {
      return false;
    }
  }

  /* ======================================================================
   * Wallets
   * ==================================================================== */
  function randomBytes32() {
    var b = new Uint8Array(32);
    try {
      var g = typeof globalThis !== 'undefined' ? globalThis : null;
      if (g && g.crypto && g.crypto.getRandomValues) g.crypto.getRandomValues(b);
    } catch (err) { /* fall through to the mix-in below */ }
    // Always mix in Math.random so a stubbed/broken CSPRNG still yields a
    // usable key. Demo-grade randomness for a demo-grade coin.
    for (var i = 0; i < 32; i++) b[i] ^= Math.floor(Math.random() * 256);
    return b;
  }

  function walletFromPrivateKey(privHex) {
    var pub = getPublicKey(privHex); // validates range
    return { privateKey: privHex.toLowerCase(), publicKey: pub, address: addressFromPublicKey(pub) };
  }

  function generateWallet(entropyHex) {
    for (;;) {
      var seed = entropyHex ? hexToBytes(entropyHex) : randomBytes32();
      var d = mod(BigInt('0x' + bytesToHex(sha256Bytes(seed))), CURVE_N);
      if (d > ZERO) return walletFromPrivateKey(padHex64(d));
      if (entropyHex) throw new Error('entropy hashes to zero key');
    }
  }

  /* ======================================================================
   * Transactions — UTXO model
   * ==================================================================== */
  function txSerialize(tx) {
    if (tx.type === 'coinbase') {
      return JSON.stringify({
        type: 'coinbase', height: tx.height, extra: tx.extra || '',
        outputs: tx.outputs.map(function (o) { return { address: o.address, amount: o.amount }; })
      });
    }
    return JSON.stringify({
      type: 'transfer',
      inputs: tx.inputs.map(function (i) { return { txId: i.txId, outIndex: i.outIndex, pubKey: i.pubKey, signature: i.signature }; }),
      outputs: tx.outputs.map(function (o) { return { address: o.address, amount: o.amount }; }),
      timestamp: tx.timestamp
    });
  }

  function txIdOf(tx) { return sha256dHex(txSerialize(tx)); }

  function sighash(tx) {
    // SIGHASH_ALL equivalent: every input signs all outpoints + all outputs.
    return sha256dHex(JSON.stringify({
      in: tx.inputs.map(function (i) { return { txId: i.txId, outIndex: i.outIndex }; }),
      out: tx.outputs.map(function (o) { return { address: o.address, amount: o.amount }; })
    }));
  }

  function checkOutput(o) {
    if (!o || !isValidAddress(o.address)) throw new Error('invalid output address');
    if (!Number.isInteger(o.amount) || o.amount <= 0 || o.amount > MAX_MONEY) throw new Error('invalid output amount');
  }

  function createCoinbase(opts) {
    var outputs = (opts.amount > 0 && opts.address) ? [{ address: opts.address, amount: opts.amount }] : [];
    var tx = { type: 'coinbase', height: opts.height, extra: opts.extra || '', outputs: outputs };
    tx.id = txIdOf(tx);
    return tx;
  }

  /**
   * Build and sign a transfer. `utxos` is an array of spendable
   * {txId, outIndex, address, amount} owned by `wallet`.
   */
  function buildTransaction(opts) {
    var wallet = opts.wallet, amount = opts.amount, fee = opts.fee || 0;
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer of blazes');
    if (!Number.isInteger(fee) || fee < 0) throw new Error('fee must be a non-negative integer');
    if (!isValidAddress(opts.to)) throw new Error('invalid destination address');

    var need = amount + fee, total = 0, picked = [];
    for (var i = 0; i < opts.utxos.length && total < need; i++) {
      picked.push(opts.utxos[i]);
      total += opts.utxos[i].amount;
    }
    if (total < need) throw new Error('insufficient funds: have ' + total + ', need ' + need);

    var outputs = [{ address: opts.to, amount: amount }];
    var change = total - need;
    if (change > 0) outputs.push({ address: wallet.address, amount: change });

    var tx = {
      type: 'transfer',
      inputs: picked.map(function (u) { return { txId: u.txId, outIndex: u.outIndex, pubKey: wallet.publicKey, signature: '' }; }),
      outputs: outputs,
      timestamp: Math.floor(opts.timestamp !== undefined ? opts.timestamp : Date.now())
    };
    var h = sighash(tx);
    tx.inputs.forEach(function (inp) { inp.signature = sign(h, wallet.privateKey); });
    tx.id = txIdOf(tx);
    return tx;
  }

  /**
   * Full transfer validation against a UTXO resolver (key "txId:outIndex" →
   * {address, amount} | undefined). Throws on any violation; returns {fee}.
   */
  function verifyTransaction(tx, resolveUtxo) {
    if (!tx || tx.type !== 'transfer') throw new Error('not a transfer');
    if (tx.id !== txIdOf(tx)) throw new Error('transaction id mismatch');
    if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) throw new Error('transaction has no inputs');
    if (!Array.isArray(tx.outputs) || tx.outputs.length === 0) throw new Error('transaction has no outputs');
    var h = sighash(tx), seen = {}, inSum = 0, outSum = 0, i;
    for (i = 0; i < tx.inputs.length; i++) {
      var inp = tx.inputs[i];
      var key = inp.txId + ':' + inp.outIndex;
      if (seen[key]) throw new Error('duplicate input ' + key);
      seen[key] = true;
      var utxo = resolveUtxo(key);
      if (!utxo) throw new Error('input not in UTXO set (missing or already spent): ' + key);
      if (addressFromPublicKey(inp.pubKey) !== utxo.address) throw new Error('public key does not own output ' + key);
      if (!verify(h, inp.signature, inp.pubKey)) throw new Error('invalid signature on input ' + key);
      inSum += utxo.amount;
    }
    for (i = 0; i < tx.outputs.length; i++) { checkOutput(tx.outputs[i]); outSum += tx.outputs[i].amount; }
    if (outSum > inSum) throw new Error('outputs exceed inputs');
    return { fee: inSum - outSum };
  }

  // Validate a transfer against `view` (a Map) and apply its effects to it.
  function applyTransfer(tx, view) {
    var fee = verifyTransaction(tx, function (k) { return view.get(k); }).fee;
    tx.inputs.forEach(function (inp) { view.delete(inp.txId + ':' + inp.outIndex); });
    tx.outputs.forEach(function (o, idx) { view.set(tx.id + ':' + idx, { address: o.address, amount: o.amount }); });
    return fee;
  }

  /* ======================================================================
   * Merkle tree & proof of work
   * ==================================================================== */
  function merkleRoot(ids) {
    if (!ids.length) return repeatChar('0', 64);
    var level = ids.slice();
    while (level.length > 1) {
      var next = [];
      for (var i = 0; i < level.length; i += 2) {
        var a = level[i], b = i + 1 < level.length ? level[i + 1] : a;
        next.push(sha256dHex(hexToBytes(a + b)));
      }
      level = next;
    }
    return level[0];
  }

  function blockHashOf(block) {
    return sha256dHex([block.height, block.prevHash, block.merkleRoot, block.timestamp, block.target, block.nonce].join('|'));
  }

  function meetsTarget(hashHex, targetHex) {
    return BigInt('0x' + hashHex) <= BigInt('0x' + targetHex);
  }

  // Expected number of hashes to find a block at this target — the fork-choice metric.
  function workOf(targetHex) {
    return (ONE << BigInt(256)) / (BigInt('0x' + targetHex) + ONE);
  }

  function difficultyOf(targetHex, powLimitHex) {
    var limit = BigInt('0x' + (powLimitHex || DEFAULT_PARAMS.genesisTarget));
    return Number((limit * BigInt(1000)) / BigInt('0x' + targetHex)) / 1000;
  }

  /**
   * Grind nonces on a prepared block. Mutates and returns the block once a
   * hash meets the target; returns null if maxIterations runs out (block.nonce
   * is left where the search stopped, so callers can resume — the UI mines in
   * time slices this way).
   */
  function mine(block, opts) {
    opts = opts || {};
    var target = BigInt('0x' + block.target);
    var nonce = opts.startNonce !== undefined ? opts.startNonce : block.nonce || 0;
    var budget = opts.maxIterations !== undefined ? opts.maxIterations : Infinity;
    var prefix = [block.height, block.prevHash, block.merkleRoot, block.timestamp, block.target, ''].join('|');
    for (var i = 0; i < budget; i++, nonce++) {
      var h = sha256dHex(prefix + nonce);
      if (BigInt('0x' + h) <= target) {
        block.nonce = nonce;
        block.hash = h;
        return block;
      }
    }
    block.nonce = nonce;
    return null;
  }

  /* ======================================================================
   * The blockchain
   * ==================================================================== */
  function Blockchain(opts) {
    var p = {};
    for (var k in DEFAULT_PARAMS) p[k] = (opts && opts[k] !== undefined) ? opts[k] : DEFAULT_PARAMS[k];
    if (!/^[0-9a-f]{64}$/.test(p.genesisTarget)) throw new Error('genesisTarget must be 64 hex chars');
    ['initialSubsidy', 'halvingInterval', 'retargetInterval', 'targetBlockTimeMs', 'genesisTimestamp', 'maxBlockTxs'].forEach(function (key) {
      if (!Number.isInteger(p[key]) || p[key] < 0) throw new Error(key + ' must be a non-negative integer');
    });
    if (p.retargetInterval < 2) throw new Error('retargetInterval must be at least 2');
    this.params = p;
    this.blocks = [];
    this.utxo = new Map();      // "txId:outIndex" → {address, amount}
    this.mempool = [];          // [{tx, fee}]
    this.workTotal = ZERO;
    this._createGenesis();
  }

  Blockchain.prototype._createGenesis = function () {
    var p = this.params;
    // Bitcoin's genesis coinbase is famously unspendable; ours pays nobody.
    var cb = createCoinbase({ height: 0, address: null, amount: 0, extra: p.genesisMessage });
    var g = {
      height: 0,
      prevHash: repeatChar('0', 64),
      merkleRoot: merkleRoot([cb.id]),
      timestamp: p.genesisTimestamp,
      target: p.genesisTarget,
      nonce: 0,
      transactions: [cb],
      hash: ''
    };
    g.hash = blockHashOf(g); // genesis is defined, not mined — no PoW check at height 0
    this.blocks = [g];
    this.workTotal = workOf(g.target);
  };

  Object.defineProperty(Blockchain.prototype, 'tip', {
    get: function () { return this.blocks[this.blocks.length - 1]; }
  });

  Blockchain.prototype.subsidyAt = function (height) {
    var halvings = Math.floor(height / this.params.halvingInterval);
    if (halvings >= 53) return 0;
    return Math.floor(this.params.initialSubsidy / Math.pow(2, halvings));
  };

  Blockchain.prototype.medianTimePast = function () {
    var ts = this.blocks.slice(-11).map(function (b) { return b.timestamp; }).sort(function (a, b) { return a - b; });
    return ts[Math.floor((ts.length - 1) / 2)];
  };

  Blockchain.prototype.nextTarget = function () {
    var p = this.params, tip = this.tip, H = tip.height + 1;
    if (H % p.retargetInterval !== 0) return tip.target;
    var first = this.blocks[H - p.retargetInterval];
    var expected = Math.max(1, (p.retargetInterval - 1) * p.targetBlockTimeMs);
    var actual = tip.timestamp - first.timestamp;
    actual = Math.max(Math.floor(expected / 4), Math.min(expected * 4, Math.max(1, actual))); // ×4 clamp, like Bitcoin
    var limit = BigInt('0x' + p.genesisTarget);
    var t = (BigInt('0x' + tip.target) * BigInt(actual)) / BigInt(expected);
    if (t > limit) t = limit;   // never easier than the PoW limit
    if (t < ONE) t = ONE;
    return padHex64(t);
  };

  /** Full consensus validation; throws with a reason, or appends the block. */
  Blockchain.prototype.addBlock = function (block, opts) {
    opts = opts || {};
    var tip = this.tip, p = this.params;
    if (!block || block.height !== tip.height + 1) throw new Error('bad height');
    if (block.prevHash !== tip.hash) throw new Error('prevHash does not match tip');
    if (block.target !== this.nextTarget()) throw new Error('wrong difficulty target');
    if (!Number.isInteger(block.nonce) || block.nonce < 0) throw new Error('bad nonce');
    if (!Number.isInteger(block.timestamp)) throw new Error('bad timestamp');
    if (block.timestamp <= this.medianTimePast()) throw new Error('timestamp not after median of recent blocks');
    if (opts.now !== undefined && block.timestamp > opts.now + 2 * 3600 * 1000) throw new Error('timestamp too far in the future');
    if (blockHashOf(block) !== block.hash) throw new Error('block hash mismatch');
    if (!meetsTarget(block.hash, block.target)) throw new Error('insufficient proof of work');

    var txs = block.transactions;
    if (!Array.isArray(txs) || txs.length < 1 || txs.length > p.maxBlockTxs + 1) throw new Error('bad transaction count');
    if (block.merkleRoot !== merkleRoot(txs.map(function (t) { return t.id; }))) throw new Error('merkle root mismatch');

    var ids = {};
    txs.forEach(function (t) {
      if (ids[t.id]) throw new Error('duplicate transaction in block');
      ids[t.id] = true;
    });

    var cb = txs[0];
    if (!cb || cb.type !== 'coinbase') throw new Error('first transaction must be coinbase');
    if (cb.id !== txIdOf(cb)) throw new Error('coinbase id mismatch');
    if (cb.height !== block.height) throw new Error('coinbase height mismatch');

    var view = new Map(this.utxo), fees = 0, i;
    for (i = 1; i < txs.length; i++) {
      if (txs[i].type !== 'transfer') throw new Error('only one coinbase allowed');
      fees += applyTransfer(txs[i], view);
    }

    var cbOut = 0;
    cb.outputs.forEach(function (o) { checkOutput(o); cbOut += o.amount; });
    if (cbOut > this.subsidyAt(block.height) + fees) throw new Error('coinbase pays more than subsidy + fees');
    cb.outputs.forEach(function (o, idx) { view.set(cb.id + ':' + idx, { address: o.address, amount: o.amount }); });

    // Commit.
    this.utxo = view;
    this.blocks.push(block);
    this.workTotal += workOf(block.target);
    this.mempool = this.mempool.filter(function (entry) {
      if (ids[entry.tx.id]) return false; // included
      return entry.tx.inputs.every(function (inp) { return view.has(inp.txId + ':' + inp.outIndex); });
    });
    return block;
  };

  /* ---- mempool ---- */
  Blockchain.prototype.submitTransaction = function (tx) {
    var self = this;
    if (this.mempool.some(function (e) { return e.tx.id === tx.id; })) throw new Error('already in mempool');
    var locked = {};
    this.mempool.forEach(function (e) {
      e.tx.inputs.forEach(function (inp) { locked[inp.txId + ':' + inp.outIndex] = true; });
    });
    var fee = verifyTransaction(tx, function (k) {
      return locked[k] ? undefined : self.utxo.get(k); // no double-spends against pending txs
    }).fee;
    this.mempool.push({ tx: tx, fee: fee });
    return fee;
  };

  Blockchain.prototype.selectMempool = function () {
    var sorted = this.mempool.slice().sort(function (a, b) {
      return b.fee / txSerialize(b.tx).length - a.fee / txSerialize(a.tx).length; // fee-rate priority
    });
    var view = new Map(this.utxo), chosen = [], fees = 0;
    for (var i = 0; i < sorted.length && chosen.length < this.params.maxBlockTxs; i++) {
      try {
        fees += applyTransfer(sorted[i].tx, view);
        chosen.push(sorted[i].tx);
      } catch (err) { /* conflicts with an already-chosen tx — leave it for the next block */ }
    }
    return { txs: chosen, fees: fees };
  };

  /* ---- mining ---- */
  Blockchain.prototype.prepareBlock = function (minerAddress, opts) {
    opts = opts || {};
    if (!isValidAddress(minerAddress)) throw new Error('invalid miner address');
    var sel = this.selectMempool();
    var height = this.tip.height + 1;
    var cb = createCoinbase({
      height: height,
      address: minerAddress,
      amount: this.subsidyAt(height) + sel.fees,
      extra: opts.extra || ''
    });
    var transactions = [cb].concat(sel.txs);
    return {
      height: height,
      prevHash: this.tip.hash,
      merkleRoot: merkleRoot(transactions.map(function (t) { return t.id; })),
      timestamp: Math.max(Math.floor(opts.timestamp !== undefined ? opts.timestamp : Date.now()), this.medianTimePast() + 1),
      target: this.nextTarget(),
      nonce: 0,
      transactions: transactions,
      hash: ''
    };
  };

  Blockchain.prototype.minePendingTransactions = function (minerAddress, opts) {
    opts = opts || {};
    var block = this.prepareBlock(minerAddress, opts);
    if (!mine(block, { maxIterations: opts.maxIterations !== undefined ? opts.maxIterations : 10000000 })) {
      throw new Error('mining budget exhausted without finding a block');
    }
    return this.addBlock(block, opts);
  };

  /* ---- wallet-facing queries ---- */
  Blockchain.prototype.getBalance = function (address) {
    var sum = 0;
    this.utxo.forEach(function (o) { if (o.address === address) sum += o.amount; });
    return sum;
  };

  Blockchain.prototype.spendableUtxos = function (address) {
    var locked = {};
    this.mempool.forEach(function (e) {
      e.tx.inputs.forEach(function (inp) { locked[inp.txId + ':' + inp.outIndex] = true; });
    });
    var out = [];
    this.utxo.forEach(function (o, key) {
      if (o.address !== address || locked[key]) return;
      var sep = key.lastIndexOf(':');
      out.push({ txId: key.slice(0, sep), outIndex: Number(key.slice(sep + 1)), address: o.address, amount: o.amount });
    });
    out.sort(function (a, b) { return b.amount - a.amount; }); // fewest inputs first
    return out;
  };

  Blockchain.prototype.send = function (wallet, to, amount, fee, opts) {
    var tx = buildTransaction({
      utxos: this.spendableUtxos(wallet.address),
      wallet: wallet, to: to, amount: amount, fee: fee,
      timestamp: opts && opts.timestamp
    });
    this.submitTransaction(tx);
    return tx;
  };

  Blockchain.prototype.history = function (address) {
    var prevOuts = {}, events = [];
    this.blocks.forEach(function (block) {
      block.transactions.forEach(function (tx) {
        var delta = 0;
        if (tx.type === 'transfer') {
          tx.inputs.forEach(function (inp) {
            var o = prevOuts[inp.txId + ':' + inp.outIndex];
            if (o && o.address === address) delta -= o.amount;
          });
        }
        tx.outputs.forEach(function (o, idx) {
          prevOuts[tx.id + ':' + idx] = o;
          if (o.address === address) delta += o.amount;
        });
        if (delta !== 0) events.push({ height: block.height, txId: tx.id, type: tx.type, delta: delta });
      });
    });
    return events;
  };

  /** Balances of every address holding coins, richest first. */
  Blockchain.prototype.richList = function (limit) {
    var by = {};
    this.utxo.forEach(function (o) { by[o.address] = (by[o.address] || 0) + o.amount; });
    var list = Object.keys(by).map(function (a) { return { address: a, amount: by[a] }; });
    list.sort(function (x, y) { return y.amount - x.amount || (x.address < y.address ? -1 : 1); });
    return typeof limit === 'number' ? list.slice(0, limit) : list;
  };

  Blockchain.prototype.totalSupply = function () {
    var sum = 0;
    this.utxo.forEach(function (o) { sum += o.amount; });
    return sum;
  };

  Blockchain.prototype.findTransaction = function (txId) {
    for (var i = 0; i < this.blocks.length; i++) {
      var txs = this.blocks[i].transactions;
      for (var j = 0; j < txs.length; j++) {
        if (txs[j].id === txId) return { block: this.blocks[i], tx: txs[j] };
      }
    }
    return null;
  };

  Blockchain.prototype.stats = function () {
    var p = this.params, tip = this.tip;
    return {
      name: p.name, ticker: p.ticker,
      height: tip.height,
      tipHash: tip.hash,
      target: this.nextTarget(),
      difficulty: difficultyOf(this.nextTarget(), p.genesisTarget),
      supply: this.totalSupply(),
      maxSupply: p.initialSubsidy * p.halvingInterval * 2, // the halving series' limit

      blockReward: this.subsidyAt(tip.height + 1),
      nextHalvingHeight: (Math.floor(tip.height / p.halvingInterval) + 1) * p.halvingInterval,
      mempoolSize: this.mempool.length,
      workTotal: this.workTotal.toString(16)
    };
  };

  /* ---- serialisation & fork choice ---- */
  Blockchain.prototype.toJSON = function () {
    var p = {};
    for (var k in this.params) p[k] = this.params[k];
    return { params: p, blocks: this.blocks };
  };

  Blockchain.fromJSON = function (data) {
    var chain = new Blockchain(data.params || {});
    var blocks = (data && data.blocks) || [];
    if (!blocks.length || blocks[0].hash !== chain.blocks[0].hash) throw new Error('genesis mismatch');
    for (var i = 1; i < blocks.length; i++) chain.addBlock(blocks[i]);
    return chain;
  };

  /**
   * Nakamoto consensus: adopt `blocks` iff it is a fully valid chain sharing
   * our genesis with strictly more cumulative work. Returns true if adopted.
   */
  Blockchain.prototype.replaceChain = function (blocks) {
    var candidate;
    try {
      candidate = Blockchain.fromJSON({ params: this.params, blocks: blocks });
    } catch (err) {
      return false;
    }
    if (candidate.workTotal <= this.workTotal) return false;
    var oldPool = this.mempool;
    this.blocks = candidate.blocks;
    this.utxo = candidate.utxo;
    this.workTotal = candidate.workTotal;
    this.mempool = [];
    for (var i = 0; i < oldPool.length; i++) {
      try { this.submitTransaction(oldPool[i].tx); } catch (err) { /* spent on the new chain */ }
    }
    return true;
  };

  /* ======================================================================
   * Display helpers
   * ==================================================================== */
  function formatAmount(blazes, ticker) {
    var sign = blazes < 0 ? '-' : '';
    var abs = Math.abs(blazes);
    var whole = Math.floor(abs / COIN);
    var frac = String(abs % COIN + COIN).slice(1).replace(/0+$/, '');
    return sign + whole + (frac ? '.' + frac : '') + ' ' + (ticker || DEFAULT_PARAMS.ticker);
  }

  function parseAmount(str) {
    var m = /^\s*(\d+)(?:\.(\d{1,8}))?\s*$/.exec(String(str));
    if (!m) throw new Error('bad amount');
    return Number(m[1]) * COIN + Number((m[2] || '').padEnd(8, '0') || 0);
  }

  /* ====================================================================== */
  return {
    version: '1.0.0',
    COIN: COIN, MAX_MONEY: MAX_MONEY, DEFAULT_PARAMS: DEFAULT_PARAMS, ADDRESS_VERSION: ADDRESS_VERSION,
    // bytes & hashing
    bytesToHex: bytesToHex, hexToBytes: hexToBytes, utf8ToBytes: utf8ToBytes,
    sha256: sha256Hex, sha256d: sha256dHex, hmacSha256: hmacSha256Hex,
    // base58
    base58Encode: base58Encode, base58Decode: base58Decode,
    base58Check: base58Check, base58CheckDecode: base58CheckDecode,
    // elliptic-curve crypto
    getPublicKey: getPublicKey, sign: sign, verify: verify,
    // wallets & addresses
    generateWallet: generateWallet, walletFromPrivateKey: walletFromPrivateKey,
    addressFromPublicKey: addressFromPublicKey, isValidAddress: isValidAddress,
    // transactions
    txSerialize: txSerialize, txIdOf: txIdOf, sighash: sighash,
    createCoinbase: createCoinbase, buildTransaction: buildTransaction,
    verifyTransaction: verifyTransaction,
    // blocks & proof of work
    merkleRoot: merkleRoot, blockHashOf: blockHashOf, meetsTarget: meetsTarget,
    workOf: workOf, difficultyOf: difficultyOf, mine: mine,
    // the chain itself
    Blockchain: Blockchain,
    // display
    formatAmount: formatAmount, parseAmount: parseAmount
  };
});
