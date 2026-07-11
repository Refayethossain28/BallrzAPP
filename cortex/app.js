/**
 * Cortex browser app layer — the WALLET app, the MINING CLIENT, and the shared
 * chain plumbing under both.
 * ============================================================================
 *
 * The two apps are genuinely separate — not two skins over one key:
 *
 *   • WALLET (initWallet, wallet.html): the ONLY place your spending key
 *     lives (localStorage; export encrypted via keystore.js). Balance, send,
 *     receive, backup.
 *   • MINING CLIENT (initMiner, mine.html): holds NO spending key. It signs
 *     blocks with a disposable RIG key and pays every reward to a PAYOUT
 *     address you configure (your wallet's) — the consensus carries the payout
 *     in the signed block, Bitcoin-coinbase style, so the mining device never
 *     needs — and cannot leak — the key that owns your MIND.
 *
 * Both talk to the same chain: persisted in localStorage, synced between tabs
 * over a BroadcastChannel, and across devices through a relay (cortex/net.js),
 * on the same shared genesis a headless cortex/node.mjs joins.
 *
 * ⚠ Testnet — see cortex/SECURITY.md.
 * Browser-only. Reads globals BallrzCortex, BallrzCoin, BallrzCortexNet,
 * BallrzCortexKeystore. Registers window.CortexApp.
 */
(function (root) {
  'use strict';
  var Cortex = root.BallrzCortex, Coin = root.BallrzCoin, Net = root.BallrzCortexNet, Keystore = root.BallrzCortexKeystore;

  // The shared network identity — matches cortex/node.mjs defaults so browser
  // tabs and headless nodes converge on the same chain. "Warnet": the model
  // learns whether a militarized confrontation between states turns LETHAL,
  // from real Correlates of War data (embedded in datasets.js).
  //
  // v4: same deeper [24,24] net and 10-year emission schedule as v3, plus the
  // coinbase-payout rule (block.miner is a payout address chosen by the
  // producer, decoupled from the signing key) that makes the wallet/miner
  // separation real. A consensus change means a NEW chain; older chains
  // (…-v1/v2/v3) still exist wherever they were stored. Every field below is
  // consensus-critical and must match cortex/node.mjs exactly.
  var TASK_ID = 'cortex-warnet-v4', GENESIS_SEED = 'cortex-genesis';
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
  var LS_WALLET = 'cortex.wallet.v1';  // the SPENDING key — wallet app only
  var LS_RIG = 'cortex.rig.v1';        // the disposable mining signer — miner only
  var LS_PAYTO = 'cortex.payto.v1';    // where the miner sends rewards
  var LS_CHAIN = 'cortex.chain.v1';
  var LS_RELAYS = 'cortex.relays.v1';  // extra relay URLs (comma-separated) beyond the serving origin

  function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, v); } catch (e) {} }

  /* ── shared plumbing: one chain, synced across tabs and the relay ── */
  function boot() {
    var task = Cortex.makeTask(Object.assign({ id: TASK_ID }, TASK_OPTS));
    var chain;
    try {
      var snap = JSON.parse(lsGet(LS_CHAIN) || 'null');
      chain = (snap && snap.taskId === TASK_ID && snap.blocks) ? Net.loadChain(task, snap.blocks, { genesisSeed: GENESIS_SEED }) : new Cortex.Chain(task, { genesisSeed: GENESIS_SEED });
    } catch (e) { chain = new Cortex.Chain(task, { genesisSeed: GENESIS_SEED }); }

    var listeners = [];
    var app = { task: task, chain: chain, node: null, net: 'local', onUpdate: function (fn) { listeners.push(fn); } };
    function persist() { lsSet(LS_CHAIN, JSON.stringify({ taskId: TASK_ID, blocks: chain.blocks })); }
    var emit = function () { persist(); for (var i = 0; i < listeners.length; i++) try { listeners[i](app.state()); } catch (e) {} };

    var bc = (typeof root.BroadcastChannel !== 'undefined') ? new root.BroadcastChannel('cortex-' + TASK_ID) : null;
    // Multi-relay: gossip through EVERY connected relay (the serving origin
    // plus any saved in localStorage), so no single relay is a chokepoint —
    // and this client bridges the relays it is homed on.
    var relays = [];
    var send = function (msg) {
      if (bc) try { bc.postMessage(msg); } catch (e) {}
      for (var i = 0; i < relays.length; i++) try { relays[i].send(msg); } catch (e) {}
    };
    var node = Net.createNode({ id: 'ui' + String(Math.random()).slice(2, 10), chain: chain, send: send });
    app.node = node;
    app.relays = 0;
    if (bc) bc.onmessage = function (ev) { node.receive(ev.data); emit(); };

    var origin = (root.location && typeof root.location.origin === 'string') ? root.location.origin : '';
    function connectRelay(url) {
      try {
        root.fetch(url + '/status').then(function (r) { return r.json(); }).then(function (d) {
          if (!d || d.name !== 'cortex-relay') return;
          var t = Net.httpTransport(url);
          relays.push(t);
          app.net = 'network'; app.relays = relays.length;
          node.hello();
          root.setInterval(function () { t.poll(function (m) { node.receive(m); }).then(function () { emit(); }).catch(function () {}); }, 2000);
          emit();
        }).catch(function () { emit(); });
      } catch (e) {}
    }
    if (root.fetch) {
      var urls = [];
      if (origin.indexOf('http') === 0) urls.push(origin);
      (lsGet(LS_RELAYS) || '').split(',').forEach(function (u) {
        u = u.trim().replace(/\/+$/, '');
        if (u.indexOf('http') === 0 && urls.indexOf(u) < 0) urls.push(u);
      });
      for (var u = 0; u < urls.length; u++) connectRelay(urls[u]);
    }
    // Add a relay at runtime (persisted): app.addRelay('https://other-relay')
    app.addRelay = function (url) {
      url = String(url || '').trim().replace(/\/+$/, '');
      if (url.indexOf('http') !== 0) throw new Error('relay URL must be http(s)');
      var cur = (lsGet(LS_RELAYS) || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (cur.indexOf(url) < 0) { cur.push(url); lsSet(LS_RELAYS, cur.join(',')); }
      connectRelay(url);
    };

    app._emit = emit; app._send = send; app._origin = origin;
    return app;
  }

  function baseState(app) {
    return {
      height: app.chain.height(), loss: app.chain.tipLoss(), accuracy: app.chain.accuracy(),
      supply: app.chain.totalSupply(), learning: app.chain.cumulativeImprovement(),
      net: app.net, relays: app.relays, pending: app.node.mempool.slice(), blocks: app.chain.blocks.slice(),
      window: app.chain.mineWindow(app.node.now()), fmt: Cortex.formatMind
    };
  }

  /* ── the WALLET app: the only holder of the spending key ── */
  function initWallet() {
    var app = boot();
    var pk = lsGet(LS_WALLET);
    var wallet = pk ? Coin.walletFromPrivateKey(pk) : Coin.generateWallet();
    if (!pk) lsSet(LS_WALLET, wallet.privateKey);
    app.wallet = wallet;

    app.state = function () {
      var s = baseState(app);
      s.address = wallet.address;
      s.balance = app.chain.balanceOf(wallet.address);
      return s;
    };

    // Submit a signed transfer (confirms when a block includes it).
    app.send = function (to, amountMind, cb) {
      try {
        if (!Coin.isValidAddress(to)) throw new Error('invalid address');
        var units = Math.round(Number(amountMind) * Cortex.MIND);
        if (!(units > 0)) throw new Error('amount must be positive');
        if (app.chain.balanceOf(wallet.address) < units) throw new Error('insufficient MIND');
        var tx = Cortex.signTransfer({ privKey: wallet.privateKey, to: to, amount: units, at: Date.now(), nonce: 'pay-' + Date.now() });
        app.node.submitTx(tx); app._emit(); if (cb) cb(null, tx);
      } catch (e) { if (cb) cb(e); }
    };

    app.backupKeystore = function (passphrase) { return Keystore.encryptKey(wallet.privateKey, passphrase); };
    app.importKey = function (privHex) { Coin.walletFromPrivateKey(privHex); lsSet(LS_WALLET, privHex); root.location.reload(); };
    app.revealKey = function () { return wallet.privateKey; };
    app.reset = function () { lsSet(LS_CHAIN, ''); root.location.reload(); };

    app._emit();
    return app;
  }

  /* ── the MINING CLIENT: disposable rig key + a payout address ── */
  function initMiner(opts) {
    opts = opts || {};
    var app = boot();
    // The rig key only ever signs blocks — it holds no funds, and losing or
    // leaking it costs nothing (rewards go to the payout address, not to it).
    var rk = lsGet(LS_RIG);
    var rig = rk ? Coin.walletFromPrivateKey(rk) : Coin.generateWallet();
    if (!rk) lsSet(LS_RIG, rig.privateKey);
    app.rig = rig;
    app.mining = false;

    // Payout: saved address, else this browser's wallet (if one exists), else
    // unset — the UI must ask for one before mining.
    var saved = lsGet(LS_PAYTO);
    if (!saved) {
      var wpk = lsGet(LS_WALLET);
      if (wpk) { try { saved = Coin.walletFromPrivateKey(wpk).address; lsSet(LS_PAYTO, saved); } catch (e) { saved = null; } }
    }
    app.payTo = (saved && Coin.isValidAddress(saved)) ? saved : null;
    app.setPayTo = function (addr) {
      if (!Coin.isValidAddress(addr)) throw new Error('not a valid MIND address');
      app.payTo = addr; lsSet(LS_PAYTO, addr); app._emit();
      return addr;
    };

    app.state = function () {
      var s = baseState(app);
      s.rigAddress = rig.address;
      s.payTo = app.payTo;
      s.paidOut = app.payTo ? app.chain.balanceOf(app.payTo) : 0; // what this payout address holds on-chain
      return s;
    };

    // Mine one block, paying the reward to the payout address; broadcasts it.
    // Heavy training runs in a Web Worker so the page stays live (fallback:
    // main thread). cb(block|null, windowInfo), onProgress(round, loss).
    var miner = null;
    function minerWorker() {
      if (miner !== null) return miner || null;
      try { miner = (typeof root.Worker !== 'undefined' && app._origin.indexOf('http') === 0) ? new root.Worker('miner-worker.js') : false; }
      catch (e) { miner = false; }
      return miner || null;
    }
    function afterMine(blk, cb) {
      if (blk) {
        // Same post-mine steps as net.js mineAndBroadcast; addBlock throws if
        // a rival block landed while we trained (next poll reconciles).
        try { app.chain.addBlock(blk); app.node.mempool = []; app.node.seen[blk.hash] = 1; app._send({ type: 'block', from: app.node.id, block: blk }); }
        catch (e) { blk = null; }
      }
      app.mining = false; app._emit();
      if (cb) cb(blk, blk ? null : app.chain.mineWindow(app.node.now()));
    }
    app.mine = function (cb, onProgress) {
      if (app.mining) return;
      if (!app.payTo) { if (cb) cb(null, { open: false, waitMs: 0, noPayout: true }); return; }
      app.mining = true;
      var win = app.chain.mineWindow(Date.now());
      if (!win.open) { app.mining = false; if (cb) cb(null, win); return; }
      var mineOpts = { privKey: rig.privateKey, payTo: app.payTo, steps: opts.steps || 100, at: app.node.now(), nonce: 'b' + app.chain.height(), txs: app.node.mempool.slice() };
      var w = minerWorker();
      if (!w) {
        root.setTimeout(function () {
          var blk = null;
          try { blk = app.chain.mineBlock(mineOpts); } catch (e) { blk = null; }
          afterMine(blk, cb);
        }, 20);
        return;
      }
      w.onerror = function () { miner = false; app.mining = false; app.mine(cb, onProgress); }; // worker broken — retry on main thread
      w.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type === 'progress') { if (onProgress) onProgress(m.round, m.loss); return; }
        afterMine((m.type === 'done') ? m.block : null, cb);
      };
      w.postMessage(Object.assign({ taskOpts: Object.assign({ id: TASK_ID }, TASK_OPTS), genesisSeed: GENESIS_SEED, blocks: app.chain.blocks }, mineOpts));
    };

    app._emit();
    return app;
  }

  // `init` stays as the wallet-flavoured default (network.html's dashboard
  // reads the chain through it).
  root.CortexApp = { init: initWallet, initWallet: initWallet, initMiner: initMiner, TASK_ID: TASK_ID };
})(typeof self !== 'undefined' ? self : this);
