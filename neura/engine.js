/*
 * Neura (NEURA) — an AI-native, hard-capped store-of-value cryptocurrency.
 *
 * Built on the proven TimeCoin consensus core (../coin/engine.js — SHA-256,
 * secp256k1 ECDSA, UTXO ledger, merkle trees, proof-of-work with difficulty
 * retargeting, cumulative-work fork choice), Neura adds one new consensus
 * rule on top: **Proof of Intelligence**.
 *
 *   Every block must advance the chain's shared neural network (../neura/
 *   brain.js) by one deterministic training step, seeded by the previous
 *   block's hash, and commit the SHA-256 of the resulting weights in its
 *   coinbase as `PoI1|<brainHash>`. The coinbase id feeds the merkle root,
 *   which feeds the block hash, which the proof-of-work grinds against — so
 *   the AI work is sealed by the same energy that secures the money.
 *
 * Every node revalidates a block by re-running the training step itself and
 * comparing weight hashes: you cannot fake the learning, skip it, or train on
 * a cherry-picked batch (the batch is derived from the previous hash, fixed
 * before mining starts). Fork choice remains heaviest-cumulative-work, but a
 * chain with even one bad Proof of Intelligence is rejected outright no
 * matter how much work it carries.
 *
 * Monetary policy — deliberately scarcer than everything around it:
 *   · Hard cap:   21,000,000 NEURA. Ever. (1000× scarcer than TimeCoin.)
 *   · Issuance:   50 NEURA block subsidy, halving every 210,000 blocks —
 *                 Bitcoin's exact emission curve.
 *   · No premine: the genesis coinbase pays nobody. Every coin that will
 *                 ever exist is mined into existence by someone who also
 *                 trained the chain's mind.
 *
 * UMD: `self.NeuraChain` in the browser (after coin/engine.js and brain.js),
 * `module.exports = factory` in Node — the test harness calls the factory
 * with the two dependencies explicitly.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory;
  else root.NeuraChain = factory(root.BallrzCoin, root.NeuraBrain);
})(typeof self !== 'undefined' ? self : this, function (C, Brain) {
  'use strict';
  if (!C || !Brain) throw new Error('NeuraChain needs BallrzCoin (coin/engine.js) and NeuraBrain (neura/brain.js)');

  var COIN = C.COIN; // 100,000 base units ("sparks") per NEURA — 5 decimals

  /* ======================================================================
   * Consensus parameters
   * ==================================================================== */
  var PARAMS = {
    name: 'Neura',
    ticker: 'NEURA',
    // 50 NEURA halving every 210,000 blocks → the geometric series sums to
    // the 21,000,000 NEURA hard cap. Fixed forever; scarcity is the product.
    initialSubsidy: 50 * COIN,
    halvingInterval: 210000,
    retargetInterval: 10,
    targetBlockTimeMs: 15000,
    genesisTarget: '000' + new Array(62).join('f'), // 12 leading zero bits
    genesisTimestamp: 1783900800000, // 2026-07-13T00:00Z — fixed, so every node derives the identical genesis
    genesisMessage: '13/Jul/2026 Neura: fixed supply, growing mind',
    maxBlockTxs: 100
  };

  // The genesis brain: derived from the genesis message, identical for all.
  var GENESIS_BRAIN_SEED = C.sha256(C.utf8ToBytes(PARAMS.genesisMessage));
  var POI_PREFIX = 'PoI1';

  function brainHashOf(brain) {
    return C.sha256(C.hexToBytes(Brain.serialize(brain)));
  }

  /** The training seed for the block at `height` on top of `prevHash`. */
  function poiSeed(height, prevHash) {
    return C.sha256(C.utf8ToBytes('NeuraPoI|' + height + '|' + prevHash));
  }

  /** Parse a coinbase `extra` — returns the committed brain hash or null. */
  function parsePoI(extra) {
    var parts = String(extra || '').split('|');
    if (parts[0] !== POI_PREFIX || !/^[0-9a-f]{64}$/.test(parts[1] || '')) return null;
    return parts[1];
  }

  /* ======================================================================
   * The chain — wraps a TimeCoin Blockchain and carries the brain as
   * consensus state. brains[h] is the network's mind after block h.
   * ==================================================================== */
  function Chain(opts) {
    var p = {};
    for (var k in PARAMS) p[k] = PARAMS[k];
    if (opts) for (var o in opts) p[o] = opts[o];
    this.inner = new C.Blockchain(p);
    this.params = this.inner.params;
    this.brains = [Brain.initBrain(GENESIS_BRAIN_SEED)];
    this.losses = [Brain.evalLoss(this.brains[0])]; // losses[h] — the mind's error after block h
  }

  Object.defineProperty(Chain.prototype, 'tip', { get: function () { return this.inner.tip; } });
  Object.defineProperty(Chain.prototype, 'blocks', { get: function () { return this.inner.blocks; } });
  Object.defineProperty(Chain.prototype, 'mempool', { get: function () { return this.inner.mempool; } });
  Object.defineProperty(Chain.prototype, 'utxo', { get: function () { return this.inner.utxo; } });
  Object.defineProperty(Chain.prototype, 'workTotal', { get: function () { return this.inner.workTotal; } });
  Object.defineProperty(Chain.prototype, 'brain', { get: function () { return this.brains[this.brains.length - 1]; } });
  Object.defineProperty(Chain.prototype, 'loss', { get: function () { return this.losses[this.losses.length - 1]; } });

  /** Run the training step the next block is required to prove. */
  Chain.prototype.nextBrain = function () {
    var next = Brain.clone(this.brain);
    Brain.trainStep(next, poiSeed(this.tip.height + 1, this.tip.hash));
    return next;
  };

  /**
   * Assemble a block template whose coinbase commits the Proof of
   * Intelligence. Returns { block, brain } — grind `block` with C.mine, then
   * pass the pair to addBlock (the brain is revalidated regardless).
   */
  Chain.prototype.prepareBlock = function (minerAddress, opts) {
    opts = opts || {};
    var brain = this.nextBrain();
    var extra = POI_PREFIX + '|' + brainHashOf(brain) + (opts.tag ? '|' + String(opts.tag) : '');
    var innerOpts = { extra: extra };
    if (opts.timestamp !== undefined) innerOpts.timestamp = opts.timestamp;
    return { block: this.inner.prepareBlock(minerAddress, innerOpts), brain: brain };
  };

  /**
   * Full consensus validation: all of TimeCoin's rules (PoW, difficulty,
   * merkle, signatures, no double-spends, subsidy ceiling) PLUS the Proof of
   * Intelligence — the committed brain hash must equal the hash of the
   * training step this node runs for itself. Throws with a reason, or
   * appends the block and advances the shared mind.
   */
  Chain.prototype.addBlock = function (block, opts) {
    // Cheap structural guards first, so a stale/foreign block fails fast
    // before this node spends a training step on it.
    if (!block || block.height !== this.tip.height + 1) throw new Error('bad height');
    if (block.prevHash !== this.tip.hash) throw new Error('prevHash does not match tip');
    var committed = block.transactions && block.transactions[0] && parsePoI(block.transactions[0].extra);
    if (!committed) throw new Error('missing proof of intelligence');
    // Recompute the required training step locally — trust nothing.
    var brain = (opts && opts.brain && brainHashOf(opts.brain) === committed) ? opts.brain : this.nextBrain();
    if (brainHashOf(brain) !== committed) throw new Error('invalid proof of intelligence: brain hash mismatch');
    this.inner.addBlock(block, opts); // throws on any monetary/PoW violation
    this.brains.push(brain);
    this.losses.push(Brain.evalLoss(brain));
    return block;
  };

  /** Convenience: prepare, grind and append in one call (tests/CLI). */
  Chain.prototype.minePendingTransactions = function (minerAddress, opts) {
    opts = opts || {};
    var prep = this.prepareBlock(minerAddress, opts);
    var budget = opts.maxIterations !== undefined ? opts.maxIterations : 10000000;
    if (!C.mine(prep.block, { maxIterations: budget })) throw new Error('mining budget exhausted without finding a block');
    return this.addBlock(prep.block, { brain: prep.brain, now: opts.now });
  };

  /* ---- passthroughs to the monetary core ---- */
  Chain.prototype.submitTransaction = function (tx) { return this.inner.submitTransaction(tx); };
  Chain.prototype.getBalance = function (address) { return this.inner.getBalance(address); };
  Chain.prototype.spendableUtxos = function (address) { return this.inner.spendableUtxos(address); };
  Chain.prototype.send = function (wallet, to, amount, fee, opts) { return this.inner.send(wallet, to, amount, fee, opts); };
  Chain.prototype.history = function (address) { return this.inner.history(address); };
  Chain.prototype.richList = function (limit) { return this.inner.richList(limit); };
  Chain.prototype.totalSupply = function () { return this.inner.totalSupply(); };
  Chain.prototype.findTransaction = function (txId) { return this.inner.findTransaction(txId); };
  Chain.prototype.subsidyAt = function (height) { return this.inner.subsidyAt(height); };
  Chain.prototype.nextTarget = function () { return this.inner.nextTarget(); };

  /**
   * Synapse score — the mind's progress as a number people can feel: 0 at
   * genesis (pure noise), → 100 as the painted mark approaches the target.
   */
  Chain.prototype.synapseScore = function () {
    var l0 = this.losses[0];
    return Math.max(0, Math.min(100, (1 - this.loss / l0) * 100));
  };

  Chain.prototype.stats = function () {
    var s = this.inner.stats();
    s.brainHash = brainHashOf(this.brain);
    s.brainSteps = this.brain.steps;
    s.loss = this.loss;
    s.synapseScore = this.synapseScore();
    return s;
  };

  /* ---- serialisation & fork choice ---- */
  Chain.prototype.toJSON = function () { return this.inner.toJSON(); };

  /**
   * Rebuild a chain from serialized blocks, revalidating every rule —
   * including re-running every block's training step. An attacker cannot
   * hand you a chain with fabricated intelligence: you re-derive the mind
   * yourself from genesis and every committed hash has to match.
   */
  Chain.fromJSON = function (data) {
    var chain = new Chain((data && data.params) || {});
    var blocks = (data && data.blocks) || [];
    if (!blocks.length || blocks[0].hash !== chain.blocks[0].hash) throw new Error('genesis mismatch');
    for (var i = 1; i < blocks.length; i++) chain.addBlock(blocks[i]);
    return chain;
  };

  /**
   * Nakamoto fork choice with a mind: adopt `blocks` iff it is a fully valid
   * chain (monetary rules AND every Proof of Intelligence) sharing our
   * genesis, with strictly more cumulative work. Returns true if adopted.
   */
  Chain.prototype.replaceChain = function (blocks) {
    var candidate;
    try {
      candidate = Chain.fromJSON({ params: this.inner.params, blocks: blocks });
    } catch (err) {
      return false;
    }
    if (candidate.workTotal <= this.workTotal) return false;
    var oldPool = this.inner.mempool;
    this.inner = candidate.inner;
    this.brains = candidate.brains;
    this.losses = candidate.losses;
    for (var i = 0; i < oldPool.length; i++) {
      try { this.inner.submitTransaction(oldPool[i].tx); } catch (err) { /* spent on the new chain */ }
    }
    return true;
  };

  /* ====================================================================== */
  return {
    version: '1.0.0',
    PARAMS: PARAMS,
    POI_PREFIX: POI_PREFIX,
    GENESIS_BRAIN_SEED: GENESIS_BRAIN_SEED,
    Chain: Chain,
    brainHashOf: brainHashOf,
    poiSeed: poiSeed,
    parsePoI: parsePoI,
    coin: C,      // the monetary core (wallets, tx building, mining, format)
    brain: Brain  // the mind (training, rendering, serialisation)
  };
});
