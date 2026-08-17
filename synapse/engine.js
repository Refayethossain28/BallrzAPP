/* Synapse (SYN) — the AI cryptocurrency where money is minted by answering.
 * =====================================================================
 * The repo already holds two coins: TimeCoin (../coin — a Bitcoin built
 * from raw bytes up) and Neura (../neura — fixed supply, mining trains a
 * shared neural net). Synapse is the third angle: an INFERENCE ECONOMY.
 *
 *   · Asking is a transaction. You attach a fee in SYN to a prompt.
 *   · Answering is mining. A miner takes the pending prompts, runs the
 *     chain's deterministic model on each (seeded by the previous block
 *     hash), seals prompt+answer pairs into a block, grinds a light
 *     proof-of-work, and collects the fees plus a halving block subsidy.
 *   · Verification is re-inference. Every node re-runs the model on the
 *     same seed and prompt: an answer that doesn't match byte-for-byte
 *     invalidates the whole block. You cannot fake the thinking —
 *     Proof of Inference.
 *
 * So coins enter the world only through served answers, and leave your
 * wallet only to buy them: the currency IS the compute.
 *
 * Prototype honesty: the "model" is a tiny seeded template-and-lexicon
 * generator standing in for a real LLM (deterministic, so consensus can
 * re-check it); hashes are iterated FNV-1a, not SHA-256; and spend
 * authorization is enforced by the app holding your secret, not ECDSA —
 * ../coin/engine.js shows the real cryptography. The economics, the
 * consensus rule and the ledger discipline are what this engine pins.
 *
 * Everything here is pure, deterministic and clock-injected — zero DOM,
 * zero I/O — unit-tested in scripts/test-synapse-logic.mjs, rendered by
 * index.html. Classic script on purpose: it must load in a browser
 * <script>, in the headless smoke sandbox, and via module.exports in the
 * test runner.
 */
(function (root) {
  'use strict';

  /* ---------------- deterministic hashing ---------------- */

  // FNV-1a 32-bit — stable across platforms, good spread for short strings.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function pad8(n) { return ('0000000' + n.toString(16)).slice(-8); }

  // 128-bit hex digest from four domain-separated FNV passes. Not SHA-256 —
  // fine for a demo chain, and honest about it (see header).
  function hashHex(s) {
    var out = '';
    for (var i = 0; i < 4; i++) out += pad8(hashStr('synapse:' + i + '|' + s));
    return out;
  }

  // One deterministic float in [0,1) from any seed string.
  function rand01(seed) {
    var h = hashStr(seed);
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  }

  function pick(list, seed) { return list[Math.floor(rand01(seed) * list.length) % list.length]; }

  /* ---------------- money ---------------- */
  // Amounts are integer millis: 1 SYN = 1000 mills. Subsidy 50 SYN halving
  // every 1,000 blocks → the floor-halved series sums to 99,994 SYN — just
  // under 100,000, the same way Bitcoin's cap is just under 21M.
  var MILL = 1000;
  var PARAMS = {
    name: 'Synapse', ticker: 'SYN',
    initialSubsidy: 50 * MILL,
    halvingInterval: 1000,
    cap: 99994 * MILL,
    minFee: 0,                       // asking can be free; miners choose what to serve
    maxPrompt: 280,
    powPrefix: '00',                 // light PoW: 1-in-256 hashes — phones mine happily
    maxBlockAsks: 25,
    genesisTs: 1786492800000,        // 2026-08-12T00:00Z — fixed, every node derives the same genesis
    genesisMessage: '12/Aug/2026 Synapse: the answer is the money'
  };

  function subsidyAt(height) {
    if (height < 1) return 0; // the genesis mints nothing — no premine
    var halvings = Math.floor((height - 1) / PARAMS.halvingInterval);
    if (halvings > 30) return 0;
    return Math.floor(PARAMS.initialSubsidy / Math.pow(2, halvings));
  }

  // Total mills issued by subsidies for all blocks up to and including height.
  function supplyAt(height) {
    var total = 0;
    for (var h = 1; h <= height; h++) {
      var s = subsidyAt(h);
      if (s === 0) break;
      total += s;
      // jump whole eras at once when far from a boundary
      var eraEnd = Math.ceil(h / PARAMS.halvingInterval) * PARAMS.halvingInterval;
      var span = Math.min(eraEnd, height) - h;
      if (span > 0) { total += span * s; h += span; }
    }
    return total;
  }

  function formatSYN(mills) {
    var v = Math.round(Number(mills) || 0);
    var neg = v < 0 ? '-' : '';
    v = Math.abs(v);
    var whole = Math.floor(v / MILL);
    var frac = v % MILL;
    var s = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (frac) s += '.' + ('00' + frac).slice(-3).replace(/0+$/, '');
    return neg + s + ' SYN';
  }

  /* ---------------- wallets ---------------- */
  // Address = digest of the secret. The engine never stores secrets in the
  // chain; the app keeps them on-device (real signatures: ../coin/engine.js).
  function normalizeSecret(s) { return String(s == null ? '' : s).trim(); }

  function walletFromSecret(secret) {
    secret = normalizeSecret(secret);
    if (secret.length < 6) return { ok: false, reason: 'Secret phrase: at least 6 characters.' };
    return { ok: true, address: 'syn' + hashHex('wallet|' + secret).slice(0, 20), secret: secret };
  }

  /* ---------------- the mind: deterministic inference ---------------- */
  // A toy seeded oracle stands in for the model. What matters for the
  // currency is that it is a pure function of (seed, prompt): every node
  // reproduces the exact answer, so answers are consensus-checkable.
  var OPENERS = [
    'Consider it this way:', 'The short answer:', 'Looked at squarely,',
    'Two things are true at once here.', 'Start from what is certain:',
    'The chain has seen this shape before —', 'Strip it to essentials:'
  ];
  var ANGLES = [
    'the constraint is not %s but what %s costs to keep',
    'most of the difficulty in %s dissolves once you name %s plainly',
    '%s rewards patience more than force, and %s punishes the reverse',
    'begin with the smallest honest version of %s, then let %s compound',
    'what looks like %s is usually %s wearing a disguise',
    'the leverage in %s hides where %s is least examined'
  ];
  var CLOSERS = [
    'Act on the smallest step that cannot be argued with.',
    'Measure it once, then decide — not the other way round.',
    'If it still matters in a week, it was real.',
    'Keep the part that survives a second reading.',
    'The rest is noise wearing a deadline.',
    'Ask again when one fact changes.'
  ];
  var FALLBACK_WORDS = ['this', 'the question', 'the goal', 'the risk', 'the habit', 'the plan'];

  function promptWords(prompt) {
    var words = String(prompt || '').toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) || [];
    var seen = {}, out = [];
    for (var i = 0; i < words.length; i++) {
      if (!seen[words[i]]) { seen[words[i]] = 1; out.push(words[i]); }
    }
    return out;
  }

  function infer(seed, prompt) {
    var p = String(prompt || '').trim();
    var key = String(seed) + '|' + p;
    var words = promptWords(p);
    var w1 = words.length ? pick(words, key + '|w1') : pick(FALLBACK_WORDS, key + '|w1');
    var w2 = words.length > 1 ? pick(words.filter(function (w) { return w !== w1; }), key + '|w2')
                              : pick(FALLBACK_WORDS, key + '|w2');
    var angle = pick(ANGLES, key + '|angle').replace('%s', w1).replace('%s', w2);
    return pick(OPENERS, key + '|open') + ' ' + angle + '. ' + pick(CLOSERS, key + '|close');
  }

  /* ---------------- transactions: asking ---------------- */
  function makeAsk(secret, prompt, feeMills, now) {
    var w = walletFromSecret(secret);
    if (!w.ok) return { ok: false, reason: w.reason };
    var p = String(prompt == null ? '' : prompt).trim();
    if (!p) return { ok: false, reason: 'Ask something.' };
    if (p.length > PARAMS.maxPrompt) return { ok: false, reason: 'Keep it under ' + PARAMS.maxPrompt + ' characters (' + p.length + ' now).' };
    var fee = Math.round(Number(feeMills));
    if (!isFinite(fee) || fee < PARAMS.minFee) fee = PARAMS.minFee;
    var tx = { from: w.address, prompt: p, fee: fee, ts: now };
    tx.id = 'ask' + hashHex('ask|' + w.address + '|' + p + '|' + fee + '|' + now).slice(0, 16);
    return { ok: true, tx: tx };
  }

  /* ---------------- blocks & the chain ---------------- */
  function blockPayload(b) {
    var asks = (b.txs || []).map(function (t) { return t.id + ':' + t.from + ':' + t.fee + ':' + t.prompt; }).join('~');
    var ans = (b.answers || []).map(function (a) { return a.promptId + ':' + a.text; }).join('~');
    return [b.height, b.prevHash, b.ts, b.miner, b.subsidy, asks, ans, b.nonce].join('|');
  }
  function computeBlockHash(b) { return hashHex('block|' + blockPayload(b)); }

  function genesisBlock() {
    var g = {
      height: 0, prevHash: hashHex('void'), ts: PARAMS.genesisTs,
      miner: 'syn' + hashHex('wallet|nobody').slice(0, 20), // pays nobody: subsidy 0
      subsidy: 0, txs: [], answers: [], nonce: 0,
      message: PARAMS.genesisMessage
    };
    g.hash = computeBlockHash(g);
    return g;
  }

  function newChain() { return [genesisBlock()]; }

  function balancesOf(chain) {
    var bal = {};
    for (var i = 1; i < chain.length; i++) {
      var b = chain[i], fees = 0;
      for (var j = 0; j < b.txs.length; j++) {
        var t = b.txs[j];
        bal[t.from] = (bal[t.from] || 0) - t.fee;
        fees += t.fee;
      }
      bal[b.miner] = (bal[b.miner] || 0) + b.subsidy + fees;
    }
    return bal;
  }

  // Which pending asks can actually pay their fee, given the chain and each
  // other (same asker's fees accumulate). Returns at most maxBlockAsks.
  function affordableAsks(chain, txs) {
    var bal = balancesOf(chain);
    var out = [], spent = {};
    for (var i = 0; i < (txs || []).length && out.length < PARAMS.maxBlockAsks; i++) {
      var t = txs[i];
      var already = spent[t.from] || 0;
      if (((bal[t.from] || 0) - already) >= t.fee) {
        spent[t.from] = already + t.fee;
        out.push(t);
      }
    }
    return out;
  }

  function mineBlock(chain, txs, minerAddress, now, maxTries) {
    var tip = chain[chain.length - 1];
    var height = tip.height + 1;
    var serve = affordableAsks(chain, txs);
    var answers = [];
    for (var i = 0; i < serve.length; i++) {
      answers.push({ promptId: serve[i].id, text: infer(tip.hash, serve[i].prompt) });
    }
    var b = {
      height: height, prevHash: tip.hash, ts: Math.max(now, tip.ts),
      miner: minerAddress, subsidy: subsidyAt(height),
      txs: serve, answers: answers, nonce: 0
    };
    var tries = maxTries || 200000;
    for (var n = 0; n < tries; n++) {
      b.nonce = n;
      var h = computeBlockHash(b);
      if (h.slice(0, PARAMS.powPrefix.length) === PARAMS.powPrefix) { b.hash = h; return b; }
    }
    return null;
  }

  // The consensus rule, in one place. A block is valid only if the hash,
  // the proof-of-work, the money and EVERY answer re-derive exactly.
  function validateBlock(chain, b) {
    var tip = chain[chain.length - 1];
    if (!b || b.height !== tip.height + 1) return { ok: false, reason: 'wrong height' };
    if (b.prevHash !== tip.hash) return { ok: false, reason: 'does not extend the tip' };
    if (b.ts < tip.ts) return { ok: false, reason: 'time ran backwards' };
    if (computeBlockHash(b) !== b.hash) return { ok: false, reason: 'hash does not match contents' };
    if (b.hash.slice(0, PARAMS.powPrefix.length) !== PARAMS.powPrefix) return { ok: false, reason: 'insufficient proof-of-work' };
    if (b.subsidy !== subsidyAt(b.height)) return { ok: false, reason: 'wrong subsidy claimed' };
    if (b.txs.length > PARAMS.maxBlockAsks) return { ok: false, reason: 'too many asks' };
    if ((b.answers || []).length !== b.txs.length) return { ok: false, reason: 'answers missing' };
    var bal = balancesOf(chain), spent = {};
    for (var i = 0; i < b.txs.length; i++) {
      var t = b.txs[i], a = b.answers[i];
      if (!t.prompt || String(t.prompt).length > PARAMS.maxPrompt) return { ok: false, reason: 'bad prompt' };
      if (!isFinite(t.fee) || t.fee < PARAMS.minFee) return { ok: false, reason: 'bad fee' };
      var already = spent[t.from] || 0;
      if (((bal[t.from] || 0) - already) < t.fee) return { ok: false, reason: 'asker cannot pay the fee' };
      spent[t.from] = already + t.fee;
      if (a.promptId !== t.id) return { ok: false, reason: 'answer for the wrong prompt' };
      // Proof of Inference: re-run the model. Byte-for-byte or bust.
      if (a.text !== infer(b.prevHash, t.prompt)) return { ok: false, reason: 'answer fails re-inference' };
    }
    return { ok: true };
  }

  function validateChain(chain) {
    if (!chain || !chain.length) return { ok: false, reason: 'empty chain' };
    var g = genesisBlock();
    if (JSON.stringify(chain[0]) !== JSON.stringify(g)) return { ok: false, reason: 'wrong genesis' };
    var sofar = [chain[0]];
    for (var i = 1; i < chain.length; i++) {
      var v = validateBlock(sofar, chain[i]);
      if (!v.ok) return { ok: false, reason: 'block ' + i + ': ' + v.reason };
      sofar.push(chain[i]);
    }
    return { ok: true };
  }

  function chainStats(chain) {
    var height = chain.length - 1;
    var asks = 0, fees = 0;
    for (var i = 1; i < chain.length; i++) {
      asks += chain[i].txs.length;
      for (var j = 0; j < chain[i].txs.length; j++) fees += chain[i].txs[j].fee;
    }
    var supply = supplyAt(height);
    return {
      height: height, asks: asks, feesPaid: fees,
      supply: supply, cap: PARAMS.cap,
      minedPct: PARAMS.cap > 0 ? supply / PARAMS.cap : 0,
      nextSubsidy: subsidyAt(height + 1),
      blocksToHalving: PARAMS.halvingInterval - ((height) % PARAMS.halvingInterval)
    };
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var E = {
    MILL: MILL, PARAMS: PARAMS,
    hashStr: hashStr, hashHex: hashHex, rand01: rand01,
    subsidyAt: subsidyAt, supplyAt: supplyAt, formatSYN: formatSYN,
    normalizeSecret: normalizeSecret, walletFromSecret: walletFromSecret,
    promptWords: promptWords, infer: infer,
    makeAsk: makeAsk, affordableAsks: affordableAsks,
    genesisBlock: genesisBlock, newChain: newChain, computeBlockHash: computeBlockHash,
    balancesOf: balancesOf, mineBlock: mineBlock,
    validateBlock: validateBlock, validateChain: validateChain,
    chainStats: chainStats, escapeHTML: escapeHTML
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.SynapseEngine = E;
})(typeof self !== 'undefined' ? self : this);
