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
   * Prompt-commitment receipts
   * ==================================================================== */

  /**
   * The burn/commitment address of a prompt: a syntactically valid p2pkh
   * address whose 20-byte payload is a hash of the prompt, not of any public
   * key — so funds sent there are unspendable, and the payment commits to the
   * prompt without revealing it.
   */
  function promptAddress(prompt) {
    if (typeof prompt !== 'string' || prompt.length === 0) throw new Error('prompt must be a non-empty string');
    var digest = Coin.sha256d(Coin.utf8ToBytes(prompt));
    return Coin.base58Check(Coin.ADDRESS_VERSION, Coin.hexToBytes(digest).slice(0, 20));
  }

  /**
   * Pay for `modelTokens` tokens of inference on `prompt`: builds a signed
   * transaction burning the cost to promptAddress(prompt), submits it to the
   * chain's mempool, and returns the receipt the payer keeps.
   */
  function payForInference(opts) {
    var chain = opts.chain, wallet = opts.wallet;
    var cost = costForTokens(opts.modelTokens);
    var to = promptAddress(opts.prompt);
    var tx = Coin.buildTransaction({
      utxos: chain.spendableUtxos(wallet.address),
      wallet: wallet,
      to: to,
      amount: cost,
      fee: opts.fee || 0,
      timestamp: opts.timestamp
    });
    chain.submitTransaction(tx);
    return { txId: tx.id, address: to, cost: cost, modelTokens: opts.modelTokens, tx: tx };
  }

  /**
   * Verify an inference receipt against the chain: given the revealed prompt,
   * the claimed token count and the paying txId, check a confirmed transaction
   * paid at least costForTokens(modelTokens) sparks to promptAddress(prompt).
   * Never throws — returns {ok, status, paid, required, confirmations, address}.
   */
  function verifyInferenceReceipt(chain, opts) {
    var required, address;
    try {
      required = costForTokens(opts.modelTokens);
      address = promptAddress(opts.prompt);
    } catch (err) {
      return { ok: false, status: 'invalid: ' + err.message, paid: 0, required: 0, confirmations: 0, address: null };
    }
    var paidIn = function (tx) {
      var paid = 0;
      tx.outputs.forEach(function (o) { if (o.address === address) paid += o.amount; });
      return paid;
    };
    var found = chain.findTransaction(opts.txId);
    if (!found) {
      for (var i = 0; i < chain.mempool.length; i++) {
        if (chain.mempool[i].tx.id === opts.txId) {
          return { ok: false, status: 'pending: in mempool, not yet mined', paid: paidIn(chain.mempool[i].tx), required: required, confirmations: 0, address: address };
        }
      }
      return { ok: false, status: 'not found: no such transaction on this chain', paid: 0, required: required, confirmations: 0, address: address };
    }
    var paid = paidIn(found.tx);
    var confirmations = chain.tip.height - found.block.height + 1;
    if (paid === 0) return { ok: false, status: 'mismatch: transaction does not pay this prompt’s commitment address', paid: 0, required: required, confirmations: confirmations, address: address };
    if (paid < required) return { ok: false, status: 'underpaid: ' + paid + ' of ' + required + ' sparks', paid: paid, required: required, confirmations: confirmations, address: address };
    return { ok: true, status: 'paid: ' + paid + ' sparks over ' + confirmations + ' confirmation(s)', paid: paid, required: required, confirmations: confirmations, address: address };
  }

  /* ====================================================================== */
  function formatAIT(sparks) { return Coin.formatAmount(sparks, PARAMS.ticker); }

  return {
    version: '1.0.0',
    core: Coin,
    PARAMS: PARAMS,
    COIN: COIN, DECIMALS: DECIMALS,
    TOKENS_PER_SPARK: TOKENS_PER_SPARK, TOKENS_PER_AIT: TOKENS_PER_AIT,
    createChain: createChain,
    costForTokens: costForTokens, tokensFor: tokensFor, estimateTokens: estimateTokens,
    promptAddress: promptAddress, payForInference: payForInference, verifyInferenceReceipt: verifyInferenceReceipt,
    formatAIT: formatAIT
  };
});
