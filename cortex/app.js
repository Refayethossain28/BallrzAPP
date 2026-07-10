/**
 * Cortex browser app layer — shared by mine.html and wallet.html.
 * ================================================================
 *
 * Gives both pages ONE wallet and ONE chain: persisted in localStorage, synced
 * live between tabs over a BroadcastChannel, and — when the page is served by a
 * Cortex relay — synced across devices through it (cortex/net.js). So you can
 * mine on /mine.html and watch the balance update on /wallet.html, on the same
 * shared genesis a headless cortex/node.mjs also joins.
 *
 * ⚠ Testnet: the wallet key is kept in localStorage (use "Back up key" to export
 *   it ENCRYPTED via keystore.js). See cortex/SECURITY.md.
 *
 * Browser-only. Reads globals BallrzCortex, BallrzCoin, BallrzCortexNet,
 * BallrzCortexKeystore. Registers window.CortexApp.
 */
(function (root) {
  'use strict';
  var Cortex = root.BallrzCortex, Coin = root.BallrzCoin, Net = root.BallrzCortexNet, Keystore = root.BallrzCortexKeystore;

  // The shared network identity — matches cortex/node.mjs defaults so browser
  // tabs and headless nodes converge on the same chain. "Warnet": the shared
  // model learns whether a militarized confrontation between states turns
  // LETHAL, from real Correlates of War data (mmb_war, embedded in
  // datasets.js). Mining trains a free, community-owned conflict-lethality
  // model. Changing the task means a NEW chain; older chains (cortex-mainnet,
  // scamnet, warnet-v1) still exist wherever they were stored.
  //
  // v3: the deeper [24,24] net + a 10-YEAR EMISSION SCHEDULE. A consensus rule
  // rations how fast the chain may absorb learning: allowedLoss(t) decays from
  // the genesis loss (0.6574) toward genesis−budget with a 2.3-year half-life,
  // and a block that learns below the schedule at its timestamp is INVALID.
  // Emissions halve every ~2.3 years (like Bitcoin): ~50% of all MIND by year
  // 2.3, ~95% by year 10 — the ceiling is reached "in about 10 years" no
  // matter how much compute shows up. Budget 0.32 is under the model's
  // benchmarked capacity (ΔL≈0.353), so learning can follow the schedule to
  // the end. Max supply: 0.32 × 3e12 = 960,000 MIND.
  var TASK_ID = 'cortex-warnet-v3', GENESIS_SEED = 'cortex-genesis';
  var TASK_OPTS = {
    dataset: 'war', layers: [24, 24],
    minImprovement: 0.000002,        // a block needs real — if small — learning
    rewardPerLoss: 3000000000000,    // 3e12 base units per 1.0 loss removed
    schedule: {
      startAt: 1783641600000,        // 2026-07-10T00:00:00Z — fixed for all nodes
      halfLifeMs: 72582480000,       // 2.3 years
      budget: 0.32,                  // total loss the schedule will ever release
      minIntervalMs: 60000           // at most one block per minute
    }
  };
  var LS_WALLET = 'cortex.wallet.v1', LS_CHAIN = 'cortex.chain.v1';

  function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, v); } catch (e) {} }

  function init(opts) {
    opts = opts || {};
    var task = Cortex.makeTask(Object.assign({ id: TASK_ID }, TASK_OPTS));

    // Wallet: load or create, persisted locally.
    var pk = lsGet(LS_WALLET);
    var wallet = pk ? Coin.walletFromPrivateKey(pk) : Coin.generateWallet();
    if (!pk) lsSet(LS_WALLET, wallet.privateKey);

    // Chain: restore snapshot or start fresh on the shared genesis.
    var chain;
    try {
      var snap = JSON.parse(lsGet(LS_CHAIN) || 'null');
      chain = (snap && snap.taskId === TASK_ID && snap.blocks) ? Net.loadChain(task, snap.blocks, { genesisSeed: GENESIS_SEED }) : new Cortex.Chain(task, { genesisSeed: GENESIS_SEED });
    } catch (e) { chain = new Cortex.Chain(task, { genesisSeed: GENESIS_SEED }); }

    var listeners = [];
    var app = {
      task: task, wallet: wallet, chain: chain, node: null, mining: false, net: 'local',
      onUpdate: function (fn) { listeners.push(fn); },
    };
    function persist() { lsSet(LS_CHAIN, JSON.stringify({ taskId: TASK_ID, blocks: chain.blocks })); }
    function emit() { persist(); for (var i = 0; i < listeners.length; i++) try { listeners[i](app.state()); } catch (e) {} }

    // Transport: BroadcastChannel between tabs (+ relay across devices, below).
    var bc = (typeof root.BroadcastChannel !== 'undefined') ? new root.BroadcastChannel('cortex-' + TASK_ID) : null;
    var relay = null;
    function send(msg) { if (bc) try { bc.postMessage(msg); } catch (e) {} if (relay) relay.send(msg); }
    var node = Net.createNode({ id: wallet.address.slice(0, 10), chain: chain, send: send });
    app.node = node;
    if (bc) bc.onmessage = function (ev) { node.receive(ev.data); emit(); };

    // Relay auto-connect when served by one.
    var origin = (root.location && typeof root.location.origin === 'string') ? root.location.origin : '';
    if (origin.indexOf('http') === 0 && root.fetch) {
      try {
        root.fetch(origin + '/status').then(function (r) { return r.json(); }).then(function (d) {
          if (!d || d.name !== 'cortex-relay') { app.net = 'local'; emit(); return; }
          relay = Net.httpTransport(origin);
          node.hello();
          root.setInterval(function () { relay.poll(function (m) { node.receive(m); }).then(function () { emit(); }).catch(function () {}); }, 2000);
          app.net = 'network'; emit();
        }).catch(function () { app.net = 'local'; emit(); });
      } catch (e) { app.net = 'local'; }
    }

    app.state = function () {
      return {
        address: wallet.address, height: chain.height(),
        loss: chain.tipLoss(), accuracy: chain.accuracy(),
        balance: chain.balanceOf(wallet.address), supply: chain.totalSupply(),
        learning: chain.cumulativeImprovement(), net: app.net,
        pending: node.mempool.slice(), blocks: chain.blocks.slice(),
        window: chain.mineWindow(Date.now()), // emission schedule: is a block mineable now?
        fmt: Cortex.formatMind
      };
    };

    // Mine one block; broadcasts it. cb(block|null), onProgress(round, loss).
    // Training the deeper v2 model is heavy (up to minutes near convergence),
    // so it runs in a Web Worker — the UI stays live and streams progress.
    // Fallback (file://, old browsers): main thread, as before.
    var miner = null;
    function minerWorker() {
      if (miner !== null) return miner || null;
      try { miner = (typeof root.Worker !== 'undefined' && origin.indexOf('http') === 0) ? new root.Worker('miner-worker.js') : false; }
      catch (e) { miner = false; }
      return miner || null;
    }
    function mineOnMainThread(cb) {
      root.setTimeout(function () {
        var blk = null;
        try { blk = node.mineAndBroadcast({ privKey: wallet.privateKey, steps: opts.steps || 100, at: Date.now(), nonce: 'b' + chain.height() }); } catch (e) { blk = null; }
        app.mining = false; emit(); if (cb) cb(blk, blk ? null : chain.mineWindow(Date.now()));
      }, 20);
    }
    app.mine = function (cb, onProgress) {
      if (app.mining) return; app.mining = true;
      // Schedule gate: if nothing has accrued yet, don't even spin up training.
      var win = chain.mineWindow(Date.now());
      if (!win.open) { app.mining = false; if (cb) cb(null, win); return; }
      var w = minerWorker();
      if (!w) return mineOnMainThread(cb);
      w.onerror = function () { miner = false; mineOnMainThread(cb); }; // worker broken — fall back this press and onward
      w.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type === 'progress') { if (onProgress) onProgress(m.round, m.loss); return; }
        var blk = (m.type === 'done') ? m.block : null;
        if (blk) {
          // Same post-mine steps as net.js mineAndBroadcast; addBlock throws if
          // a rival block landed while we trained (next poll reconciles).
          try { chain.addBlock(blk); node.mempool = []; node.seen[blk.hash] = 1; send({ type: 'block', from: node.id, block: blk }); }
          catch (e) { blk = null; }
        }
        app.mining = false; emit(); if (cb) cb(blk, blk ? null : chain.mineWindow(Date.now()));
      };
      w.postMessage({
        taskOpts: Object.assign({ id: TASK_ID }, TASK_OPTS), genesisSeed: GENESIS_SEED,
        blocks: chain.blocks, privKey: wallet.privateKey, steps: opts.steps || 100,
        at: Date.now(), nonce: 'b' + chain.height(), txs: node.mempool.slice()
      });
    };

    // Submit a signed transfer to the network (confirms when a block includes it).
    app.send = function (to, amountMind, cb) {
      try {
        if (!Coin.isValidAddress(to)) throw new Error('invalid address');
        var units = Math.round(Number(amountMind) * Cortex.MIND);
        if (!(units > 0)) throw new Error('amount must be positive');
        if (chain.balanceOf(wallet.address) < units) throw new Error('insufficient MIND');
        var tx = Cortex.signTransfer({ privKey: wallet.privateKey, to: to, amount: units, at: Date.now(), nonce: 'pay-' + Date.now() });
        node.submitTx(tx); emit(); if (cb) cb(null, tx);
      } catch (e) { if (cb) cb(e); }
    };

    app.backupKeystore = function (passphrase) { return Keystore.encryptKey(wallet.privateKey, passphrase); };
    app.importKey = function (privHex) { Coin.walletFromPrivateKey(privHex); lsSet(LS_WALLET, privHex); root.location.reload(); };
    app.revealKey = function () { return wallet.privateKey; };
    app.reset = function () { lsSet(LS_CHAIN, ''); root.location.reload(); };

    emit();
    return app;
  }

  root.CortexApp = { init: init, TASK_ID: TASK_ID };
})(typeof self !== 'undefined' ? self : this);
