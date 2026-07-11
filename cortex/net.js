/**
 * Cortex networking — turning the in-memory chain into a gossip node.
 * ===================================================================
 *
 * engine.js is the consensus CORE: it validates blocks and, given a rival
 * chain, adopts the one that has learned the most (`replaceChain`). This module
 * is the thin layer that makes a node TALK to others: broadcast the blocks you
 * mine, ingest what peers send, and converge — exactly the job coin/engine.js's
 * chain sync does for TimeCoin.
 *
 * It is TRANSPORT-AGNOSTIC. You inject a `send(msg)` and call `receive(msg)`;
 * the same node logic then runs over the HTTP relay (cortex/server.mjs), a
 * BroadcastChannel between browser tabs, or an in-memory bus in the tests. The
 * relay stays dumb — it forwards messages and can censor or delay, but every
 * node re-validates everything, so a bad relay cannot forge a block or mint
 * MIND. Same trust model as a Bitcoin node behind someone else's network.
 *
 * ── ⚠ TESTNET ONLY ───────────────────────────────────────────────────────────
 * Do NOT run this as a real-value network yet. Consensus needs every node to
 * recompute the identical loss from identical weights, but the model's forward
 * pass uses floating-point tanh/exp/log, which are NOT guaranteed bit-identical
 * across CPUs/OSes/JS engines. Two honest nodes could therefore disagree on a
 * block's validity and the chain would fork. The gate for a trustworthy network
 * is a deterministic (fixed-point) forward pass — see cortex/TRUSTLESS.md and
 * the deploy guide. Until then this is for local/testnet experimentation.
 *
 * Messages (all JSON, {type,...}): 'hello' (I joined — send me your chain),
 * 'chain' (my full chain, for fork choice), 'block' (a freshly mined block,
 * fast-path), 'tx' (a MIND transfer for the mempool).
 *
 * Dependency-free UMD. Reuses BallrzCortex (the Chain). Registers global
 * BallrzCortexNet.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzCortexNet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function cortex() {
    var g = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined') ? globalThis : this;
    if (g && g.BallrzCortex) return g.BallrzCortex;
    throw new Error('cortex/engine.js must be loaded before net.js');
  }

  // A node wraps a Chain and a send() sink. Feed it peer messages via receive().
  //   opts: { chain, send, id, clock? }
  function createNode(opts) {
    if (!opts || !opts.chain || typeof opts.send !== 'function') throw new Error('createNode needs { chain, send }');
    var clock = opts.clock || function () { return Date.now(); };
    var node = {
      id: opts.id || 'node',
      chain: opts.chain,
      send: opts.send,
      mempool: [],           // pending MIND transfers to fold into the next block
      seen: {},              // block hashes we've already broadcast (dedupe)
      stats: { rx: 0, tx: 0, blocksAccepted: 0, chainsAdopted: 0, txsPooled: 0 }
    };

    /* ── network-adjusted time (Bitcoin-style median-of-peers) ──────────────
     * Every gossip message is stamped with the sender's clock; we keep one
     * offset per peer and use the MEDIAN to correct our own clock. This is
     * what the emission schedule's future-block rule runs on, so one node
     * with a wrong clock follows the network instead of forking off it. The
     * adjustment is clamped: if the median exceeds MAX_ADJUST_MS the peers
     * are assumed hostile or broken and we fall back to our local clock —
     * a sybil majority can therefore shift our time by at most ±10 minutes.
     */
    var MAX_ADJUST_MS = 10 * 60 * 1000, MAX_PEER_OFFSETS = 33;
    var peerOffsets = {}, peerOrder = [];
    function noteOffset(from, theirNow) {
      if (typeof theirNow !== 'number' || !isFinite(theirNow) || !from) return;
      if (!(from in peerOffsets)) {
        peerOrder.push(from);
        if (peerOrder.length > MAX_PEER_OFFSETS) delete peerOffsets[peerOrder.shift()];
      }
      peerOffsets[from] = theirNow - clock();
    }
    node.now = function () {
      var offs = [];
      for (var k in peerOffsets) if (peerOffsets.hasOwnProperty(k)) offs.push(peerOffsets[k]);
      if (!offs.length) return clock();
      offs.sort(function (a, b) { return a - b; });
      var med = offs.length % 2 ? offs[(offs.length - 1) / 2] : (offs[offs.length / 2 - 1] + offs[offs.length / 2]) / 2;
      if (med > MAX_ADJUST_MS || med < -MAX_ADJUST_MS) med = 0; // peers too far out — trust our own clock
      return clock() + med;
    };

    function broadcast(msg) { node.stats.tx++; msg.now = clock(); node.send(msg); }

    // Announce our whole chain so peers can fork-choice against it.
    node.announce = function () { broadcast({ type: 'chain', from: node.id, blocks: node.chain.blocks }); };
    // Ask the network to introduce itself (peers reply with their chains).
    node.hello = function () { broadcast({ type: 'hello', from: node.id }); };

    // Queue a signed MIND transfer and gossip it.
    node.submitTx = function (tx) {
      if (!tx || !tx.id) return false;
      for (var i = 0; i < node.mempool.length; i++) if (node.mempool[i].id === tx.id) return false;
      node.mempool.push(tx); node.stats.txsPooled++;
      broadcast({ type: 'tx', from: node.id, tx: tx });
      return true;
    };

    // Mine a block (folding in the mempool), append locally, and broadcast it.
    node.mineAndBroadcast = function (mineOpts) {
      mineOpts = mineOpts || {};
      // Scheduled tasks default the block timestamp to NETWORK time, so a
      // miner with a skewed clock stamps blocks its peers will accept.
      var at = mineOpts.at != null ? mineOpts.at : (node.chain.task.schedule ? node.now() : undefined);
      var blk = node.chain.mineBlock({
        privKey: mineOpts.privKey, payTo: mineOpts.payTo, steps: mineOpts.steps, lr: mineOpts.lr,
        at: at, nonce: mineOpts.nonce, txs: node.mempool.slice()
      });
      if (!blk) return null;                 // model converged — nothing to mine
      node.chain.addBlock(blk);
      node.mempool = [];
      node.seen[blk.hash] = 1;
      broadcast({ type: 'block', from: node.id, block: blk });
      return blk;
    };

    // Scheduled tasks only: reject blocks dated in the future (beyond clock
    // drift). This is what stops a miner post-dating `at` to unlock schedule
    // budget early — the network won't relay or accept a future-dated block
    // until that time actually arrives (at which point it earned nothing).
    // Judged against NETWORK-ADJUSTED time (node.now(), median of peers), the
    // same weak-clock assumption Bitcoin makes; see cortex/SECURITY.md.
    var MAX_FUTURE_MS = 5 * 60 * 1000;
    function fromTheFuture(b) {
      return !!(node.chain.task.schedule && b && Number(b.at) > node.now() + MAX_FUTURE_MS);
    }

    // Handle one incoming message. Returns a short tag describing what we did.
    node.receive = function (msg) {
      node.stats.rx++;
      if (!msg || msg.from === node.id) return 'ignored:self';
      noteOffset(msg.from, msg.now); // every peer message helps calibrate network time
      switch (msg.type) {
        case 'hello':
          node.announce();                    // newcomer — hand them our chain
          return 'answered:hello';
        case 'chain': {
          // Fork choice: adopt a rival chain iff it has learned strictly more.
          if (msg.blocks && msg.blocks.length && fromTheFuture(msg.blocks[msg.blocks.length - 1])) return 'rejected:future-timestamp';
          var adopted = false;
          try { adopted = node.chain.replaceChain(msg.blocks); } catch (e) { adopted = false; }
          if (adopted) { node.stats.chainsAdopted++; return 'adopted:chain'; }
          return 'kept:chain';
        }
        case 'block': {
          var b = msg.block;
          if (!b || node.seen[b.hash]) return 'ignored:dup';
          if (fromTheFuture(b)) return 'rejected:future-timestamp';
          // Fast path: the block extends our tip.
          if (b.prevHash === node.chain.tip().hash && b.index === node.chain.tip().index + 1) {
            try {
              node.chain.addBlock(b);
              node.seen[b.hash] = 1; node.stats.blocksAccepted++;
              broadcast({ type: 'block', from: node.id, block: b });   // relay onward
              return 'accepted:block';
            } catch (e) { return 'rejected:block:' + e.message; }
          }
          // Doesn't fit (we're behind or on a fork): ask for full chains to reconcile.
          node.hello();
          return 'requested:sync';
        }
        case 'tx': {
          var tx = msg.tx;
          if (!tx || !tx.id) return 'ignored:tx';
          for (var i = 0; i < node.mempool.length; i++) if (node.mempool[i].id === tx.id) return 'ignored:dup';
          node.mempool.push(tx); node.stats.txsPooled++;
          broadcast({ type: 'tx', from: node.id, tx: tx });            // relay onward
          return 'pooled:tx';
        }
        default: return 'ignored:type';
      }
    };

    // Persistence: a node can save/restore its chain blocks as plain JSON.
    node.snapshot = function () { return { taskId: node.chain.task.id, blocks: node.chain.blocks }; };

    return node;
  }

  // Load blocks into a fresh chain (persistence / initial sync). Validates by
  // replaying through replaceChain, so a corrupt snapshot is simply not adopted.
  function loadChain(task, blocks, opts) {
    var X = cortex(), chain = new X.Chain(task, opts || {});
    if (blocks && blocks.length > 1) chain.replaceChain(blocks);
    return chain;
  }

  // A relay transport: POST messages to /msg and pull new ones from /msgs?since.
  // Returns { send, poll, cursor } — `poll(onMsg)` fetches everything new and
  // dispatches it (call it on a timer for live use, or by hand in tests). Uses
  // the global fetch (browsers and Node ≥18).
  function httpTransport(baseUrl, opts) {
    opts = opts || {};
    var f = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('no fetch available for httpTransport');
    var base = String(baseUrl).replace(/\/$/, ''), cursor = 0;
    return {
      get cursor() { return cursor; },
      send: function (msg) { return f(base + '/msg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) }); },
      poll: function (onMsg) {
        return f(base + '/msgs?since=' + cursor).then(function (r) { return r.json(); }).then(function (d) {
          cursor = d.seq || cursor;
          (d.msgs || []).forEach(function (m) { try { onMsg(m); } catch (e) { /* skip a bad message */ } });
          return d.msgs ? d.msgs.length : 0;
        });
      }
    };
  }

  return {
    version: '1.0.0',
    createNode: createNode, loadChain: loadChain, httpTransport: httpTransport,
    MESSAGE_TYPES: ['hello', 'chain', 'block', 'tx']
  };
});
