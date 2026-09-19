/* Rig — the pure proof-of-work mining engine.
 * =====================================================================
 * Rig is a miner you can actually run: real FIPS 180-4 SHA-256, real
 * double-SHA-256 over real 80-byte Bitcoin block headers, real compact
 * "bits" target math — the unit tests prove it by recomputing the actual
 * Bitcoin genesis block hash from raw bytes. Every rule of the app lives
 * HERE as pure, deterministic, clock-injected functions with zero DOM and
 * zero I/O — unit-tested in scripts/test-rig-logic.mjs, rendered by
 * index.html.
 *
 * Honesty is a design rule, not a disclaimer: the Bitcoin mode mines
 * genuine SHA-256d practice shares and shows you exactly what your
 * hashrate means against the real network (spoiler: geological time).
 * It never credits pretend BTC. The local coins (Ballrz, Nugget, Ember)
 * are chains this app is the whole network for — the proof-of-work on
 * them is just as real, and the blocks you find are actually yours.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
  var TWO32 = 4294967296; // 2^32 — expected hashes per difficulty-1 unit

  /* ---------------- bytes and hex ---------------- */

  var HEXD = '0123456789abcdef';

  function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += HEXD[bytes[i] >> 4] + HEXD[bytes[i] & 15];
    return s;
  }

  function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) throw new Error('bad hex');
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // Flip byte order of a hex string — Bitcoin displays hashes reversed
  // from the byte order it hashes them in.
  function reverseHex(hex) {
    var b = hexToBytes(hex), out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i];
    return bytesToHex(out);
  }

  function utf8ToBytes(str) {
    // Hand-rolled so the engine has zero environment dependencies
    // (TextEncoder is absent in the vm test sandbox).
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

  /* ---------------- SHA-256 (FIPS 180-4) — pure JS, bytes in, bytes out ---------------- */

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

  /* ---------------- the 80-byte Bitcoin block header ---------------- */
  // Exactly Bitcoin's wire layout: version, prev hash and merkle root in
  // internal (reversed) byte order, time, compact bits, nonce — all
  // little-endian. Hash it with double-SHA-256, reverse the digest, and
  // you get the hex the whole world knows a block by.

  function writeUint32LE(buf, off, v) {
    buf[off] = v & 255; buf[off + 1] = (v >>> 8) & 255;
    buf[off + 2] = (v >>> 16) & 255; buf[off + 3] = (v >>> 24) & 255;
  }

  function serializeHeader(h) {
    var out = new Uint8Array(80);
    writeUint32LE(out, 0, h.version >>> 0);
    out.set(hexToBytes(reverseHex(h.prevHash)), 4);
    out.set(hexToBytes(reverseHex(h.merkleRoot)), 36);
    writeUint32LE(out, 68, h.time >>> 0);
    writeUint32LE(out, 72, h.bits >>> 0);
    writeUint32LE(out, 76, h.nonce >>> 0);
    return out;
  }

  function headerHash(h) { return reverseHex(sha256dHex(serializeHeader(h))); }

  /* ---------------- targets, bits, difficulty ---------------- */
  // A hash "wins" when, read as a 256-bit big-endian number, it is at or
  // below the target. Bitcoin ships the target compressed into 4 bytes
  // ("bits"): 1 exponent byte + 3 mantissa bytes.

  function bitsToTarget(bits) {
    var exp = (bits >>> 24) & 255;
    var mant = bits & 0x7fffff;
    var out = new Uint8Array(32);
    var mb = [(mant >> 16) & 255, (mant >> 8) & 255, mant & 255];
    for (var i = 0; i < 3; i++) {
      var pos = 32 - exp + i; // value = mantissa * 256^(exp-3)
      if (pos >= 0 && pos < 32) out[pos] = mb[i];
    }
    return out;
  }

  function targetToBits(target) {
    var i = 0;
    while (i < 32 && target[i] === 0) i++;
    if (i === 32) return 0;
    var size = 32 - i;
    var b0 = target[i], b1 = i + 1 < 32 ? target[i + 1] : 0, b2 = i + 2 < 32 ? target[i + 2] : 0;
    var mant = (b0 << 16) | (b1 << 8) | b2;
    if (b0 & 0x80) { mant >>= 8; size += 1; } // keep the sign bit clear, like Bitcoin
    return ((size << 24) | mant) >>> 0;
  }

  // Big-endian numeric value of a 32-byte target as a float. Doubles hold
  // 53 bits — far more than the leading bytes that decide any comparison
  // we make with this.
  function targetToFloat(target) {
    var v = 0;
    for (var i = 0; i < 32; i++) v = v * 256 + target[i];
    return v;
  }

  // Approximate float back into 32 big-endian bytes. Only the leading
  // bytes carry real precision, which is exactly what target maths needs.
  function floatToTarget(v) {
    var out = new Uint8Array(32);
    if (!(v > 0)) return out;
    var max = Math.pow(2, 256);
    if (v >= max) { for (var j = 0; j < 32; j++) out[j] = 255; return out; }
    for (var i = 0; i < 32; i++) {
      var p = Math.pow(2, 8 * (31 - i));
      var b = Math.floor(v / p);
      if (b > 255) b = 255;
      out[i] = b;
      v -= b * p;
    }
    return out;
  }

  var DIFF1_BITS = 0x1d00ffff;
  var DIFF1_FLOAT = targetToFloat(bitsToTarget(DIFF1_BITS));

  function difficultyFromTarget(target) {
    var t = targetToFloat(target);
    return t > 0 ? DIFF1_FLOAT / t : Infinity;
  }

  function difficultyFromBits(bits) { return difficultyFromTarget(bitsToTarget(bits)); }

  function targetFromDifficulty(diff) {
    if (!(diff > 0)) return floatToTarget(DIFF1_FLOAT);
    return floatToTarget(DIFF1_FLOAT / diff);
  }

  // Target that takes ~expectedHashes attempts to beat: 2^256 / H.
  function targetFromExpectedHashes(expectedHashes) {
    if (!(expectedHashes > 1)) expectedHashes = 1;
    return floatToTarget(Math.pow(2, 256) / expectedHashes);
  }

  function expectedHashesForTarget(target) {
    var t = targetToFloat(target);
    return t > 0 ? Math.pow(2, 256) / t : Infinity;
  }

  // display-order hash hex vs 32-byte big-endian target
  function hashMeetsTarget(hashHex, target) {
    var h = hexToBytes(hashHex);
    for (var i = 0; i < 32; i++) {
      if (h[i] < target[i]) return true;
      if (h[i] > target[i]) return false;
    }
    return true; // equal counts as met
  }

  function compareHashes(aHex, bHex) {
    return aHex < bHex ? -1 : aHex > bHex ? 1 : 0; // same-length hex compares numerically
  }

  /* ---------------- the Bitcoin genesis block: proof this is real ---------------- */
  // 3rd January 2009. Recompute the most famous hash in the world from the
  // raw header fields — if the SHA-256, the serialization or the byte
  // order were wrong anywhere, this would not come out right.
  var GENESIS = {
    version: 1,
    prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
    merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
    time: 1231006505,
    bits: 0x1d00ffff,
    nonce: 2083236893,
    hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
  };

  function verifyGenesis() {
    var computed = headerHash(GENESIS);
    return { computed: computed, expected: GENESIS.hash, ok: computed === GENESIS.hash };
  }

  /* ---------------- mining: scan nonces for real ---------------- */
  // One serialized header, nonce patched in place at offset 76, double-
  // SHA-256 per attempt. Deterministic: same header + same range = same
  // shares, same blocks, same best hash.
  function mineRange(headerFields, nonceStart, count, targets) {
    var buf = serializeHeader(headerFields);
    var shareT = targets && targets.share ? targets.share : null;
    var blockT = targets && targets.block ? targets.block : null;
    var shares = [], blocks = [];
    var best = null, last = null;
    for (var i = 0; i < count; i++) {
      var nonce = (nonceStart + i) >>> 0;
      writeUint32LE(buf, 76, nonce);
      var hash = reverseHex(bytesToHex(sha256Bytes(sha256Bytes(buf))));
      last = { nonce: nonce, hash: hash };
      if (best === null || compareHashes(hash, best.hash) < 0) best = { nonce: nonce, hash: hash };
      if (blockT && hashMeetsTarget(hash, blockT)) blocks.push({ nonce: nonce, hash: hash });
      else if (shareT && hashMeetsTarget(hash, shareT)) shares.push({ nonce: nonce, hash: hash });
    }
    return { tried: count, last: last, best: best, shares: shares, blocks: blocks };
  }

  /* ---------------- the coins ---------------- */
  // One real network you practise against, three local chains you truly
  // mine. kind:'real' → shares only, never a balance (honesty rule).
  // kind:'local' → this app is the whole network; found blocks are yours.
  var COINS = [
    {
      id: 'btc', name: 'Bitcoin', symbol: 'BTC', kind: 'real', algo: 'SHA-256d',
      decimals: 8, color: '#f7931a', glyph: '₿',
      blockSeconds: 600, blockReward: 3.125,
      // ~Sep 2026 ballpark; the UI lets you set today's real value.
      networkDifficulty: 1.25e14,
      desc: 'The real thing. Genuine double-SHA-256 over a real header layout, pool-style practice shares — and the honest maths on why a phone will never win a block.'
    },
    {
      id: 'blz', name: 'Ballrz', symbol: 'BLZ', kind: 'local', algo: 'SHA-256d',
      decimals: 2, color: '#ffd166', glyph: 'Ⓑ',
      blockSeconds: 20, blockReward: 50, halvingEvery: 500, retargetEvery: 10,
      startHashes: 400000,
      desc: 'The house coin. Quick 20-second blocks so you feel the whole loop: hash, win, reward, halving, difficulty creeping up behind you.'
    },
    {
      id: 'nug', name: 'Nugget', symbol: 'NUG', kind: 'local', algo: 'SHA-256d',
      decimals: 3, color: '#e8b04b', glyph: '◆',
      blockSeconds: 60, blockReward: 12, halvingEvery: 300, retargetEvery: 10,
      startHashes: 2500000,
      desc: 'A minute a block. Scarcer, slower, worth the wait — the middle-distance run.'
    },
    {
      id: 'emb', name: 'Ember', symbol: 'EMB', kind: 'local', algo: 'SHA-256d',
      decimals: 4, color: '#ff6b4a', glyph: '✦',
      blockSeconds: 180, blockReward: 2.5, halvingEvery: 200, retargetEvery: 8,
      startHashes: 12000000,
      desc: 'The hard one. Three-minute blocks and a mean retarget — finding an Ember block actually means something.'
    }
  ];

  function coinById(id) {
    for (var i = 0; i < COINS.length; i++) if (COINS[i].id === id) return COINS[i];
    return null;
  }

  /* ---------------- local chains: small, but real ---------------- */
  // Plain JSON-safe state so the UI can persist it. The genesis tip is
  // deterministic per coin, so every fresh install agrees on block 1's
  // parent.
  function newChain(coin) {
    return {
      coinId: coin.id,
      height: 0,
      tipHash: reverseHex(sha256dHex('rig-genesis:' + coin.id)),
      expectedHashes: coin.startHashes,
      windowTimes: [],   // unix seconds of blocks in the current retarget window
      minedTotal: 0
    };
  }

  // Block subsidy with halving; drops to 0 once it would round below one
  // smallest unit, so the supply really is capped.
  function rewardAt(coin, height) {
    var halvings = Math.floor(height / coin.halvingEvery);
    var r = coin.blockReward / Math.pow(2, halvings);
    var unit = Math.pow(10, -coin.decimals);
    if (r < unit) return 0;
    return Math.round(r / unit) * unit;
  }

  var MIN_EXPECTED_HASHES = 4096;
  var MAX_EXPECTED_HASHES = Math.pow(2, 48);

  // Apply a found block: advance the tip, credit the subsidy, and every
  // retargetEvery blocks re-aim difficulty at coin.blockSeconds, clamped
  // ×4 either way like Bitcoin.
  function applyBlock(coin, chain, blockTimeSec) {
    var height = chain.height + 1;
    var reward = rewardAt(coin, height);
    var times = chain.windowTimes.concat([blockTimeSec]);
    var expected = chain.expectedHashes;
    var retargeted = null;
    if (times.length >= coin.retargetEvery) {
      var spanSec = times[times.length - 1] - times[0];
      var intervals = times.length - 1;
      var actualPerBlock = intervals > 0 ? spanSec / intervals : coin.blockSeconds;
      if (actualPerBlock < 0.001) actualPerBlock = 0.001;
      var ratio = coin.blockSeconds / actualPerBlock;
      if (ratio > 4) ratio = 4;
      if (ratio < 0.25) ratio = 0.25;
      var next = Math.round(expected * ratio);
      if (next < MIN_EXPECTED_HASHES) next = MIN_EXPECTED_HASHES;
      if (next > MAX_EXPECTED_HASHES) next = MAX_EXPECTED_HASHES;
      retargeted = { from: expected, to: next };
      expected = next;
      times = [];
    }
    return {
      chain: {
        coinId: chain.coinId,
        height: height,
        tipHash: chain.tipHash,   // caller sets to the found hash via sealBlock
        expectedHashes: expected,
        windowTimes: times,
        minedTotal: Math.round((chain.minedTotal + reward) * 1e8) / 1e8
      },
      reward: reward,
      retargeted: retargeted
    };
  }

  function sealBlock(coin, chain, found, blockTimeSec) {
    var r = applyBlock(coin, chain, blockTimeSec);
    r.chain.tipHash = found.hash;
    return r;
  }

  /* ---------------- jobs: the header you are actually hashing ---------------- */
  // Deterministic given (coin, chain tip, tag, clock): the merkle root
  // commits to who is mining and when, like a coinbase transaction would.
  function buildJob(coin, chain, minerTag, now) {
    var timeSec = Math.floor(now / 1000);
    var isReal = coin.kind === 'real';
    var height = isReal ? null : chain.height + 1;
    var prevHash = isReal
      ? reverseHex(sha256dHex('rig-btc-practice-parent:' + Math.floor(timeSec / 600)))
      : chain.tipHash;
    var merkleRoot = reverseHex(sha256dHex(
      'rig-work:' + coin.id + ':' + (height === null ? 'practice' : height) + ':' + String(minerTag || 'anon') + ':' + timeSec
    ));
    // Quantize the target through the compact encoding so a sealed block
    // always satisfies the target its own header's bits field declares —
    // Bitcoin's consensus rule is bitsToTarget(bits), not the raw value.
    var blockTarget = bitsToTarget(targetToBits(isReal
      ? targetFromDifficulty(coin.networkDifficulty)
      : targetFromExpectedHashes(chain.expectedHashes)));
    return {
      coinId: coin.id,
      height: height,
      header: {
        version: isReal ? 0x20000000 : 2,
        prevHash: prevHash,
        merkleRoot: merkleRoot,
        time: timeSec,
        bits: targetToBits(blockTarget),
        nonce: 0
      },
      blockTarget: blockTarget
    };
  }

  // Pool-style vardiff: pick a share workload from the measured hashrate
  // so a share lands roughly every `periodSec` seconds. Clamped so dead-
  // slow devices still get shares and fast ones don't spam.
  function shareHashesFor(hashrate, periodSec) {
    var period = periodSec > 0 ? periodSec : 6;
    var h = hashrate > 0 ? hashrate : 10000;
    var n = Math.round(h * period);
    if (n < 32768) n = 32768;
    if (n > 2147483648) n = 2147483648;
    return n;
  }

  function shareTargetFor(hashrate, periodSec, blockTarget) {
    var t = targetFromExpectedHashes(shareHashesFor(hashrate, periodSec));
    // never make shares *harder* than the block itself (tiny local chains)
    if (blockTarget && targetToFloat(blockTarget) > targetToFloat(t)) return blockTarget;
    return t;
  }

  /* ---------------- hashrate: what the rig is really doing ---------------- */
  // samples: [{t: ms, n: hashes completed in the batch ending at t}]
  function pruneSamples(samples, now, windowMs) {
    var w = windowMs || 10 * SECOND;
    var out = [];
    for (var i = 0; i < samples.length; i++) if (samples[i].t > now - w) out.push(samples[i]);
    return out;
  }

  function hashrateOf(samples, now, windowMs) {
    var w = windowMs || 10 * SECOND;
    var kept = pruneSamples(samples, now, w);
    if (kept.length === 0) return 0;
    var total = 0, oldest = now;
    for (var i = 0; i < kept.length; i++) {
      total += kept[i].n;
      if (kept[i].t < oldest) oldest = kept[i].t;
    }
    var span = Math.max(now - oldest, SECOND); // avoid divide-by-nearly-zero spikes
    return total / (span / 1000);
  }

  /* ---------------- the honest maths ---------------- */

  function expectedSecondsToBlock(difficulty, hashrate) {
    if (!(hashrate > 0)) return Infinity;
    return difficulty * TWO32 / hashrate;
  }

  // Everything the reality-check card needs, computed live from a real
  // measured hashrate. No euphemisms: this is why the app never shows a
  // BTC balance.
  var UNIVERSE_AGE_YEARS = 13.8e9;

  function btcReality(hashrate, networkDifficulty) {
    var diff = networkDifficulty > 0 ? networkDifficulty : coinById('btc').networkDifficulty;
    var netHashrate = diff * TWO32 / 600; // difficulty × 2^32 hashes per 600 s block
    var secondsToBlock = expectedSecondsToBlock(diff, hashrate);
    var years = secondsToBlock / (365.25 * 24 * 3600);
    return {
      networkDifficulty: diff,
      networkHashrate: netHashrate,
      yourShare: hashrate > 0 ? hashrate / netHashrate : 0,
      secondsToBlock: secondsToBlock,
      yearsToBlock: years,
      universeAges: years / UNIVERSE_AGE_YEARS,
      verdict: hashrate > 0
        ? 'Every hash you compute is a real lottery ticket — the odds are just astronomical. Real Bitcoin mining needs ASIC hardware and a pool.'
        : 'Start the rig to measure your hashrate against the real network.'
    };
  }

  /* ---------------- formatters ---------------- */

  var HR_UNITS = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s', 'ZH/s'];

  function formatHashrate(hps) {
    if (!(hps > 0)) return '0 H/s';
    var u = 0, v = hps;
    while (v >= 1000 && u < HR_UNITS.length - 1) { v /= 1000; u++; }
    return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + HR_UNITS[u];
  }

  function formatInt(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatAmount(x, decimals) {
    var v = Number(x) || 0;
    var s = v.toFixed(decimals);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.length > 1 ? parts[0] + '.' + parts[1] : parts[0];
  }

  // Honest human duration, from seconds up through multiples of the age
  // of the universe. Never rounds an absurd number into a plausible one.
  var YEAR_SEC = 365.25 * 24 * 3600;
  var BIG_YEARS = [
    { min: 1e15, div: 1e15, word: 'quadrillion' },
    { min: 1e12, div: 1e12, word: 'trillion' },
    { min: 1e9,  div: 1e9,  word: 'billion' },
    { min: 1e6,  div: 1e6,  word: 'million' },
    { min: 1e3,  div: 1e3,  word: 'thousand' }
  ];

  function formatDuration(seconds) {
    if (!isFinite(seconds)) return 'forever (no hashrate yet)';
    if (seconds < 1) return 'under a second';
    if (seconds < 90) return Math.round(seconds) + ' seconds';
    if (seconds < 90 * 60) return Math.round(seconds / 60) + ' minutes';
    if (seconds < 36 * 3600) return Math.round(seconds / 3600) + ' hours';
    if (seconds < 400 * 24 * 3600) return Math.round(seconds / (24 * 3600)) + ' days';
    var years = seconds / YEAR_SEC;
    if (years >= 1e18) return 'about 10^' + Math.round(Math.log(years) / Math.LN10) + ' years';
    for (var i = 0; i < BIG_YEARS.length; i++) {
      if (years >= BIG_YEARS[i].min) {
        var v = years / BIG_YEARS[i].div;
        return 'about ' + (v >= 100 ? formatInt(v) : Math.round(v * 10) / 10) + ' ' + BIG_YEARS[i].word + ' years';
      }
    }
    return 'about ' + formatInt(years) + ' years';
  }

  function formatDifficulty(diff) {
    if (!(diff > 0)) return '0';
    if (diff >= 1e12) return (Math.round(diff / 1e10) / 100) + ' T';
    if (diff >= 1e9) return (Math.round(diff / 1e7) / 100) + ' G';
    if (diff >= 1e6) return (Math.round(diff / 1e4) / 100) + ' M';
    if (diff >= 1e3) return (Math.round(diff / 10) / 100) + ' k';
    return String(Math.round(diff * 1e6) / 1e6);
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Leading zero count of a display hash — the UI's "how close was that"
  function leadingZeroes(hashHex) {
    var n = 0;
    while (n < hashHex.length && hashHex.charAt(n) === '0') n++;
    return n;
  }

  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY, TWO32: TWO32,
    DIFF1_BITS: DIFF1_BITS, GENESIS: GENESIS, COINS: COINS,
    UNIVERSE_AGE_YEARS: UNIVERSE_AGE_YEARS,
    bytesToHex: bytesToHex, hexToBytes: hexToBytes, reverseHex: reverseHex,
    utf8ToBytes: utf8ToBytes,
    sha256Bytes: sha256Bytes, sha256Hex: sha256Hex,
    sha256dBytes: sha256dBytes, sha256dHex: sha256dHex,
    serializeHeader: serializeHeader, headerHash: headerHash,
    bitsToTarget: bitsToTarget, targetToBits: targetToBits,
    targetToFloat: targetToFloat, floatToTarget: floatToTarget,
    difficultyFromTarget: difficultyFromTarget, difficultyFromBits: difficultyFromBits,
    targetFromDifficulty: targetFromDifficulty,
    targetFromExpectedHashes: targetFromExpectedHashes, expectedHashesForTarget: expectedHashesForTarget,
    hashMeetsTarget: hashMeetsTarget, compareHashes: compareHashes,
    verifyGenesis: verifyGenesis, mineRange: mineRange,
    coinById: coinById, newChain: newChain, rewardAt: rewardAt,
    applyBlock: applyBlock, sealBlock: sealBlock, buildJob: buildJob,
    shareHashesFor: shareHashesFor, shareTargetFor: shareTargetFor,
    pruneSamples: pruneSamples, hashrateOf: hashrateOf,
    expectedSecondsToBlock: expectedSecondsToBlock, btcReality: btcReality,
    formatHashrate: formatHashrate, formatInt: formatInt, formatAmount: formatAmount,
    formatDuration: formatDuration, formatDifficulty: formatDifficulty,
    escapeHTML: escapeHTML, leadingZeroes: leadingZeroes
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.RigEngine = E;
})(typeof self !== 'undefined' ? self : this);
