/**
 * AI Token (AIT) — a proof-of-work cryptocurrency whose miners mine AI tokens
 * ===========================================================================
 *
 * A sibling chain to TimeCoin, built on the same dependency-free engine
 * (../coin/engine.js): SHA-256 from FIPS 180-4, secp256k1 ECDSA, base58check
 * addresses, a UTXO ledger, merkle trees, Bitcoin-style difficulty retargeting
 * and fork choice by cumulative work. This module doesn't re-implement any of
 * that — it parameterises a new chain and adds the AI layer on top.
 *
 * The idea
 * --------
 * Miners burn electricity on proof-of-work exactly as in Bitcoin, but the
 * block reward is denominated in **AI tokens**: currency whose unit of account
 * is the model token, the atom of AI inference. The base unit is the *spark*
 * (1 AIT = 100,000 sparks) and the peg is deliberately simple:
 *
 *     1 spark = 1 model token of inference
 *
 * so an AIT balance IS a metered right to computation — mine a block, and the
 * subsidy in your wallet reads directly as "N model tokens of AI you can buy".
 *
 * Paying for inference — prompt-commitment receipts
 * -------------------------------------------------
 * To spend AIT on AI, a user builds an ordinary signed transaction that pays
 * the cost to the *prompt-commitment address* of their prompt:
 *
 *     promptAddress(prompt) = base58check(version, sha256d(utf8(prompt))[0..20])
 *
 * That address is derived from a hash, not from any key, so by preimage
 * resistance nobody can ever spend from it — the payment is provably burned —
 * and the transaction doubles as an on-chain receipt committing to *exactly*
 * that prompt without revealing it. An inference provider (or anyone) can
 * verify a receipt with the prompt + txId alone: reveal the prompt, re-derive
 * the address, and check the confirmed transaction paid enough sparks for the
 * tokens consumed. Burning rather than paying a provider keeps the chain
 * neutral (no privileged treasury address) and makes inference deflationary:
 * every question asked shrinks the supply.
 *
 * Two extensions make the receipt scheme genuinely useful:
 *
 *   • PROVIDER PAYMENTS — pass `provider` to payForInference and the cost goes
 *     to that provider's ordinary address instead of being burned, while a
 *     1-spark commitment output still burns to the prompt's address, binding
 *     the payment to the exact prompt. Providers earn real AIT for serving
 *     inference; the burn is reduced to a timestamped commitment. The chain
 *     stays neutral: any provider address works, none is privileged.
 *
 *   • NOTARY — the same commitment trick works for ANY document, not just
 *     prompts: notarize() burns 1 spark to commitmentAddress(sha256d(bytes)),
 *     giving a proof-of-existence anyone can check later from the document +
 *     txId — "this exact content existed at this block height/time". PoW makes
 *     the timestamp expensive to forge.
 *
 * Money supply
 * ------------
 * 128 AIT per block, halving every 131,072 (2^17) blocks. The geometric series
 * caps the supply at 128 × 2^17 × 2 = 2^25 = 33,554,432 AIT — a power of two,
 * as befits a machine currency — i.e. ~3.36 trillion model tokens will ever
 * exist, and every one of them is mined.
 *
 * Loaded the same UMD way as coin/engine.js: in the browser include
 * ../coin/engine.js first (`self.BallrzCoin`), then this file exposes
 * `self.BallrzAI`; in the Node test sandbox it reads `BallrzCoin` off the
 * sandbox global and exports via `module.exports`. Everything here is
 * deterministic (timestamps are injectable), so the consensus-adjacent parts
 * are fully unit-testable in scripts/test-aicoin-logic.mjs.
 */
(function (root, factory) {
  var core = root && root.BallrzCoin;
  if (!core && typeof require === 'function') {
    try { core = require('../coin/engine.js'); } catch (err) { /* browser bundlers */ }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(core);
  else root.BallrzAI = factory(core);
})(typeof self !== 'undefined' ? self : this, function (Coin) {
  'use strict';
  if (!Coin) throw new Error('aicoin/engine.js requires coin/engine.js (BallrzCoin) to be loaded first');

  var COIN = Coin.COIN;           // sparks per AIT (100,000 — five decimal places)
  var DECIMALS = Coin.DECIMALS;

  // The peg that makes these *AI* tokens: one spark buys one model token, so
  // 1 AIT = 100,000 model tokens of inference and balances read as compute.
  var TOKENS_PER_SPARK = 1;
  var TOKENS_PER_AIT = COIN * TOKENS_PER_SPARK;

  var PARAMS = {
    name: 'AI Token',
    ticker: 'AIT',
    // 128 AIT halving every 2^17 blocks → hard cap 2^25 = 33,554,432 AIT,
    // enforced by the same coinbase rule that caps TimeCoin and Bitcoin.
    initialSubsidy: 128 * COIN,
    halvingInterval: 131072,
    retargetInterval: 10,          // difficulty adjusts every 10 blocks…
    targetBlockTimeMs: 15000,      // …aiming at one block per 15 s (browser-scale)
    genesisTarget: '000' + repeatChar('f', 61), // PoW limit: 12 leading zero bits
    genesisTimestamp: 1783900800000, // 2026-07-13T00:00Z, fixed so every node derives the identical genesis
    genesisMessage: '13/Jul/2026 The miners mine intelligence: one spark, one token',
    maxBlockTxs: 100
  };

  function repeatChar(c, n) { var s = ''; while (n-- > 0) s += c; return s; }

  /** A ready-to-mine AI Token chain (overrides are for tests only). */
  function createChain(overrides) {
    var p = {};
    for (var k in PARAMS) p[k] = PARAMS[k];
    for (var o in (overrides || {})) p[o] = overrides[o];
    return new Coin.Blockchain(p);
  }

  /* ======================================================================
   * Inference pricing — sparks ↔ model tokens
   * ==================================================================== */

  /** Price of `modelTokens` tokens of inference, in sparks (base units). */
  function costForTokens(modelTokens) {
    if (!Number.isInteger(modelTokens) || modelTokens <= 0) throw new Error('modelTokens must be a positive integer');
    return Math.ceil(modelTokens / TOKENS_PER_SPARK);
  }

  /** How many model tokens of inference `sparks` base units buy. */
  function tokensFor(sparks) {
    if (!Number.isInteger(sparks) || sparks < 0) throw new Error('sparks must be a non-negative integer');
    return sparks * TOKENS_PER_SPARK;
  }

  /**
   * Rough prompt-size estimate (~4 characters per token, the usual rule of
   * thumb) for UI quoting. Real billing verifies against actual usage.
   */
  function estimateTokens(text) {
    return Math.max(1, Math.ceil(String(text == null ? '' : text).length / 4));
  }

  /* ======================================================================
   * Multi-output payments
   * ==================================================================== */

  /**
   * Build and sign a transfer with ARBITRARY outputs (Coin.buildTransaction
   * handles only one destination). Same rules: greedy coin selection from
   * `utxos`, change back to the wallet, every input signed over the sighash.
   */
  function buildPayment(opts) {
    var wallet = opts.wallet, fee = opts.fee || 0, wanted = opts.outputs;
    if (!Number.isInteger(fee) || fee < 0) throw new Error('fee must be a non-negative integer');
    if (!Array.isArray(wanted) || wanted.length === 0) throw new Error('outputs required');
    var need = fee;
    wanted.forEach(function (o) {
      if (!Number.isInteger(o.amount) || o.amount <= 0) throw new Error('output amount must be a positive integer of sparks');
      if (!Coin.isValidAddress(o.address)) throw new Error('invalid output address');
      need += o.amount;
    });

    var total = 0, picked = [];
    for (var i = 0; i < opts.utxos.length && total < need; i++) {
      picked.push(opts.utxos[i]);
      total += opts.utxos[i].amount;
    }
    if (total < need) throw new Error('insufficient funds: have ' + total + ', need ' + need);

    var outputs = wanted.map(function (o) { return { address: o.address, amount: o.amount }; });
    var change = total - need;
    if (change > 0) outputs.push({ address: wallet.address, amount: change });

    var tx = {
      type: 'transfer',
      inputs: picked.map(function (u) { return { txId: u.txId, outIndex: u.outIndex, pubKey: wallet.publicKey, signature: '' }; }),
      outputs: outputs,
      timestamp: Math.floor(opts.timestamp !== undefined ? opts.timestamp : Date.now())
    };
    var h = Coin.sighash(tx);
    tx.inputs.forEach(function (inp) { inp.signature = Coin.sign(h, wallet.privateKey); });
    tx.id = Coin.txIdOf(tx);
    return tx;
  }

  /* ======================================================================
   * Commitment addresses — prompts, documents, anything hashable
   * ==================================================================== */

  // Sparks burned to bind a payment or notarization to a commitment address.
  var COMMIT_AMOUNT = 1;

  /**
   * The burn/commitment address of a 32-byte digest (64 hex chars): a
   * syntactically valid p2pkh address whose 20-byte payload comes from the
   * digest, not from any public key — so funds sent there are unspendable,
   * and the payment commits to the hashed content without revealing it.
   */
  function commitmentAddress(digestHex) {
    if (typeof digestHex !== 'string' || !/^[0-9a-f]{64}$/.test(digestHex)) throw new Error('digest must be 64 lowercase hex chars');
    return Coin.base58Check(Coin.ADDRESS_VERSION, Coin.hexToBytes(digestHex).slice(0, 20));
  }

  /** The commitment address of a prompt string: commit to sha256d(utf8(prompt)). */
  function promptAddress(prompt) {
    if (typeof prompt !== 'string' || prompt.length === 0) throw new Error('prompt must be a non-empty string');
    return commitmentAddress(Coin.sha256d(Coin.utf8ToBytes(prompt)));
  }

  /* ======================================================================
   * Inference receipts
   * ==================================================================== */

  /**
   * Pay for `modelTokens` tokens of inference on `prompt` and return the
   * receipt the payer keeps. Two modes:
   *
   *   burn (default)  — the whole cost goes to promptAddress(prompt);
   *   provider        — pass `provider` (an ordinary address) and the cost
   *                     pays that provider, while COMMIT_AMOUNT sparks still
   *                     burn to the prompt's address to bind payment↔prompt.
   */
  function payForInference(opts) {
    var chain = opts.chain, wallet = opts.wallet;
    var cost = costForTokens(opts.modelTokens);
    var commit = promptAddress(opts.prompt);
    var outputs;
    if (opts.provider !== undefined && opts.provider !== null && opts.provider !== '') {
      if (!Coin.isValidAddress(opts.provider)) throw new Error('invalid provider address');
      if (opts.provider === commit) throw new Error('provider cannot be the commitment address');
      outputs = [{ address: opts.provider, amount: cost }, { address: commit, amount: COMMIT_AMOUNT }];
    } else {
      outputs = [{ address: commit, amount: cost }];
    }
    var tx = buildPayment({
      utxos: chain.spendableUtxos(wallet.address),
      wallet: wallet,
      outputs: outputs,
      fee: opts.fee || 0,
      timestamp: opts.timestamp
    });
    chain.submitTransaction(tx);
    return { txId: tx.id, address: commit, provider: opts.provider || null, cost: cost, modelTokens: opts.modelTokens, tx: tx };
  }

  // Find a transaction in blocks or mempool. → {tx, confirmations, block|null} | null
  function locateTx(chain, txId) {
    var found = chain.findTransaction(txId);
    if (found) return { tx: found.tx, block: found.block, confirmations: chain.tip.height - found.block.height + 1 };
    for (var i = 0; i < chain.mempool.length; i++) {
      if (chain.mempool[i].tx.id === txId) return { tx: chain.mempool[i].tx, block: null, confirmations: 0 };
    }
    return null;
  }

  function paidTo(tx, address) {
    var paid = 0;
    tx.outputs.forEach(function (o) { if (o.address === address) paid += o.amount; });
    return paid;
  }

  /**
   * Verify an inference receipt against the chain: given the revealed prompt,
   * the claimed token count and the paying txId, check a confirmed transaction
   * paid at least costForTokens(modelTokens) sparks — to promptAddress(prompt)
   * for a burn receipt, or (pass `provider`) to the provider's address with a
   * COMMIT_AMOUNT burn to the prompt's address binding payment to prompt.
   * Never throws — returns {ok, status, paid, required, confirmations, address}.
   *
   * The provider check asks "did this address receive ≥ cost in this tx?", so
   * a payer's own change output would satisfy it — meaningless in practice,
   * because a provider verifies their OWN address before serving, but don't
   * treat a third party's claim of "X was the provider" as proven by this.
   */
  function verifyInferenceReceipt(chain, opts) {
    var required, address;
    try {
      required = costForTokens(opts.modelTokens);
      address = promptAddress(opts.prompt);
    } catch (err) {
      return { ok: false, status: 'invalid: ' + err.message, paid: 0, required: 0, confirmations: 0, address: null };
    }
    var loc = locateTx(chain, opts.txId);
    if (!loc) return { ok: false, status: 'not found: no such transaction on this chain', paid: 0, required: required, confirmations: 0, address: address };
    var provider = opts.provider || null;
    var paid = paidTo(loc.tx, provider || address);
    var committed = provider ? paidTo(loc.tx, address) : paid;
    var base = { paid: paid, required: required, confirmations: loc.confirmations, address: address };
    var fail = function (status) { base.ok = false; base.status = status; return base; };
    if (committed === 0) return fail('mismatch: transaction does not pay this prompt’s commitment address');
    if (provider && paid < required) return fail('underpaid: provider got ' + paid + ' of ' + required + ' sparks');
    if (!provider && paid < required) return fail('underpaid: ' + paid + ' of ' + required + ' sparks');
    if (!loc.block) return fail('pending: in mempool, not yet mined');
    base.ok = true;
    base.status = 'paid: ' + paid + ' sparks' + (provider ? ' to provider' : '') + ' over ' + loc.confirmations + ' confirmation(s)';
    return base;
  }

  /* ======================================================================
   * Notary — proof-of-existence for any document
   * ==================================================================== */

  /**
   * Notarize a document: burn COMMIT_AMOUNT sparks to the commitment address
   * of its sha256d digest. Pass `digestHex` directly (hash big files yourself
   * with Coin.sha256d) or `text` to hash a string here. Once mined, the block
   * is a proof-of-work timestamp that this exact content existed.
   */
  function notarize(opts) {
    var digest = opts.digestHex !== undefined ? opts.digestHex : Coin.sha256d(Coin.utf8ToBytes(String(opts.text)));
    var address = commitmentAddress(digest);
    var tx = buildPayment({
      utxos: opts.chain.spendableUtxos(opts.wallet.address),
      wallet: opts.wallet,
      outputs: [{ address: address, amount: COMMIT_AMOUNT }],
      fee: opts.fee || 0,
      timestamp: opts.timestamp
    });
    opts.chain.submitTransaction(tx);
    return { txId: tx.id, address: address, digestHex: digest, tx: tx };
  }

  /**
   * Check a notarization: does `txId` pay the commitment address of this
   * digest (or of sha256d(text)), and in which block? Never throws.
   * → {ok, status, height, timestamp, confirmations, address}
   */
  function verifyNotarization(chain, opts) {
    var address;
    try {
      var digest = opts.digestHex !== undefined ? opts.digestHex : Coin.sha256d(Coin.utf8ToBytes(String(opts.text)));
      address = commitmentAddress(digest);
    } catch (err) {
      return { ok: false, status: 'invalid: ' + err.message, height: null, timestamp: null, confirmations: 0, address: null };
    }
    var loc = locateTx(chain, opts.txId);
    if (!loc) return { ok: false, status: 'not found: no such transaction on this chain', height: null, timestamp: null, confirmations: 0, address: address };
    if (paidTo(loc.tx, address) < COMMIT_AMOUNT) {
      return { ok: false, status: 'mismatch: transaction does not commit to this content', height: loc.block ? loc.block.height : null, timestamp: null, confirmations: loc.confirmations, address: address };
    }
    if (!loc.block) return { ok: false, status: 'pending: in mempool, not yet mined', height: null, timestamp: null, confirmations: 0, address: address };
    return {
      ok: true,
      status: 'notarized in block #' + loc.block.height + ' (' + loc.confirmations + ' confirmation(s))',
      height: loc.block.height, timestamp: loc.block.timestamp, confirmations: loc.confirmations, address: address
    };
  }

  /* ====================================================================== */
  function formatAIT(sparks) { return Coin.formatAmount(sparks, PARAMS.ticker); }

  return {
    version: '1.1.0',
    core: Coin,
    PARAMS: PARAMS,
    COIN: COIN, DECIMALS: DECIMALS,
    TOKENS_PER_SPARK: TOKENS_PER_SPARK, TOKENS_PER_AIT: TOKENS_PER_AIT, COMMIT_AMOUNT: COMMIT_AMOUNT,
    createChain: createChain,
    costForTokens: costForTokens, tokensFor: tokensFor, estimateTokens: estimateTokens,
    buildPayment: buildPayment,
    commitmentAddress: commitmentAddress, promptAddress: promptAddress,
    payForInference: payForInference, verifyInferenceReceipt: verifyInferenceReceipt,
    notarize: notarize, verifyNotarization: verifyNotarization,
    formatAIT: formatAIT
  };
});
