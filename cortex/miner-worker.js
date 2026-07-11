/**
 * Cortex miner worker — trains OFF the main thread.
 * ==================================================
 *
 * Mining a block on the deeper warnet-v2 model can take a minute of solid
 * compute; done on the page's main thread that freezes the UI (and iOS kills
 * unresponsive pages). So the app posts a snapshot of the chain here, this
 * worker rebuilds it, mines (streaming round-by-round progress back), and
 * returns the signed block — the page stays live throughout.
 *
 * Protocol (postMessage):
 *   in : { taskOpts, genesisSeed, blocks, privKey, payTo, steps, at, nonce, txs }
 *         (privKey is the disposable RIG key; payTo is the payout wallet address)
 *   out: { type:'progress', round, loss }       — after each training round
 *        { type:'done', block }                 — block, or null if converged
 *        { type:'error', message }
 *
 * Loads the same UMD modules as the page (they register on the worker's
 * `self`), so the mined block is byte-identical to a main-thread block.
 */
/* global importScripts */
importScripts('../coin/engine.js', 'datasets.js', 'engine.js', 'net.js');

self.onmessage = function (ev) {
  var m = ev.data || {};
  try {
    var X = self.BallrzCortex, Net = self.BallrzCortexNet;
    var task = X.makeTask(m.taskOpts);
    var chain = Net.loadChain(task, m.blocks, { genesisSeed: m.genesisSeed });
    var blk = chain.mineBlock({
      privKey: m.privKey, payTo: m.payTo, steps: m.steps, at: m.at, nonce: m.nonce, txs: m.txs || [],
      onRound: function (round, loss) { self.postMessage({ type: 'progress', round: round, loss: loss }); }
    });
    self.postMessage({ type: 'done', block: blk });
  } catch (e) {
    self.postMessage({ type: 'error', message: String((e && e.message) || e) });
  }
};
