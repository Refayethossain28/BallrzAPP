#!/usr/bin/env node
/**
 * Unit tests for coin/engine.js — the BallrzCoin (BLZ) cryptocurrency core:
 * SHA-256/HMAC against published test vectors, secp256k1 ECDSA against the
 * classic RFC 6979 vector, base58check addresses, UTXO transaction rules,
 * merkle trees, proof-of-work mining, difficulty retargeting, halvings and
 * cumulative-work fork choice. Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-coin-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'coin', 'engine.js'), 'utf8'), sandbox, { filename: 'coin/engine.js' });
const C = sandbox.module.exports;

// The recovery-phrase wordlist is loaded the same UMD way; mirror the app's
// encode/decode here so the scheme (and the wordlist's integrity) is tested.
const wlBox = { module: { exports: {} } }; wlBox.self = wlBox;
vm.createContext(wlBox);
vm.runInContext(readFileSync(join(ROOT, 'coin', 'wordlist.js'), 'utf8'), wlBox, { filename: 'coin/wordlist.js' });
const WORDS = wlBox.module.exports;
const WORD_IX = Object.fromEntries(WORDS.map((w, i) => [w, i]));
const keyToPhrase = (hex) => {
  const b = C.hexToBytes(hex);
  const out = [...b].map((x) => WORDS[x]);
  out.push(WORDS[parseInt(C.sha256(b).slice(0, 2), 16)]);
  return out.join(' ');
};
const phraseToKey = (phrase) => {
  const words = phrase.trim().toLowerCase().split(/\s+/);
  if (words.length !== 33) throw new Error('A recovery phrase is 33 words');
  const bytes = words.slice(0, 32).map((w) => {
    const v = WORD_IX[w]; if (v === undefined) throw new Error('Not a recovery word: ' + w); return v;
  });
  const check = WORD_IX[words[32]];
  if (parseInt(C.sha256(bytes).slice(0, 2), 16) !== check) throw new Error('Checksum failed');
  return C.bytesToHex(bytes);
};

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

test('recovery wordlist has 256 unique words', () => {
  assert.equal(WORDS.length, 256);
  assert.equal(new Set(WORDS).size, 256, 'all words unique');
  assert.ok(WORDS.every((w) => /^[a-z]{3,6}$/.test(w)), 'all words are 3–6 lowercase letters');
});
test('recovery phrase round-trips a private key and catches errors', () => {
  const key = alice.privateKey;
  const phrase = keyToPhrase(key);
  assert.equal(phrase.split(' ').length, 33, '32 data words + 1 checksum');
  assert.equal(phraseToKey(phrase), key, 'phrase restores the exact key');
  // a swapped word fails the checksum
  const w = phrase.split(' ');
  const j = w[0] === WORDS[0] ? 1 : 0;
  w[j] = WORDS[(WORD_IX[w[j]] + 1) % 256];
  assert.throws(() => phraseToKey(w.join(' ')), /Checksum failed/);
  // wrong length rejected
  assert.throws(() => phraseToKey('able acid'), /33 words/);
});
test('ECDH derives the same shared secret for both parties', () => {
  const ab = C.ecdh(alice.privateKey, bob.publicKey);
  const ba = C.ecdh(bob.privateKey, alice.publicKey);
  assert.equal(ab, ba, 'alice·B == bob·A');
  assert.match(ab, /^[0-9a-f]{64}$/, '32-byte hex secret');
  // a different counterparty yields a different secret
  const ac = C.ecdh(alice.privateKey, carol.publicKey);
  assert.notEqual(ab, ac);
  assert.throws(() => C.ecdh(alice.privateKey, 'zz'), /./, 'bad pubkey rejected');
});

/* Fast test-net parameters: 8 leading zero bits ≈ 256 hashes per block. */
const GENESIS_TIME = 1000000;
const TEST_PARAMS = {
  genesisTarget: '00' + 'f'.repeat(62),
  genesisTimestamp: GENESIS_TIME,
  targetBlockTimeMs: 1000,
  retargetInterval: 5,
  halvingInterval: 4,
  maxBlockTxs: 25,
  initialSubsidy: 50 * C.COIN, // 50 BLZ block reward on the test net
};
const newChain = (over = {}) => new C.Blockchain({ ...TEST_PARAMS, ...over });

/* Deterministic wallets. */
const alice = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001');
const bob = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000002');
const carol = C.walletFromPrivateKey('00000000000000000000000000000000000000000000000000000000deadbeef');

let clock = GENESIS_TIME;
const tick = (ms = 1000) => (clock += ms);
const mineTo = (chain, wallet, ms = 1000) =>
  chain.minePendingTransactions(wallet.address, { timestamp: tick(ms) });

/* ---------- hashing primitives (published vectors) ---------- */
test('sha256 matches FIPS 180-4 vectors', () => {
  assert.equal(C.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(C.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
test('sha256 handles block-boundary message lengths', () => {
  // 56 bytes forces the padding into a second block.
  assert.equal(C.sha256('a'.repeat(56)), C.sha256('a'.repeat(56))); // deterministic
  assert.notEqual(C.sha256('a'.repeat(55)), C.sha256('a'.repeat(56)));
  assert.equal(C.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});
test('hmac-sha256 matches RFC 4231 test case 1', () => {
  const key = C.hexToBytes('0b'.repeat(20));
  const msg = C.utf8ToBytes('Hi There');
  assert.equal(C.hmacSha256(key, msg), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
});

/* ---------- secp256k1 ---------- */
test('public key of d=1 is the compressed generator point', () => {
  assert.equal(alice.publicKey, '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
});
test('RFC 6979 deterministic signature matches the known secp256k1 vector', () => {
  // privkey 0x01, message "Satoshi Nakamoto" (single SHA-256), low-S.
  const sig = C.sign(C.sha256('Satoshi Nakamoto'), alice.privateKey);
  assert.equal(sig,
    '934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8' +
    '2442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5');
});
test('sign/verify round-trip; forgeries and tampering rejected', () => {
  const h = C.sha256('pay bob 5 BLZ');
  const sig = C.sign(h, bob.privateKey);
  assert.equal(C.sign(h, bob.privateKey), sig, 'deterministic — same sig twice');
  assert.ok(C.verify(h, sig, bob.publicKey));
  assert.ok(!C.verify(C.sha256('pay bob 500 BLZ'), sig, bob.publicKey), 'different message');
  assert.ok(!C.verify(h, sig, alice.publicKey), 'wrong key');
  const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  assert.ok(!C.verify(h, flipped, bob.publicKey), 'tampered signature');
  assert.ok(!C.verify(h, 'zz'.repeat(64), bob.publicKey), 'garbage signature');
});

/* ---------- addresses ---------- */
test('base58check round-trips and detects tampering', () => {
  const payload = C.hexToBytes('00112233445566778899aabbccddeeff00112233');
  const addr = C.base58Check(C.ADDRESS_VERSION, payload);
  const dec = C.base58CheckDecode(addr);
  assert.equal(dec.version, C.ADDRESS_VERSION);
  assert.equal(C.bytesToHex(dec.payload), C.bytesToHex(payload));
  const evil = addr.slice(0, -1) + (addr.endsWith('x') ? 'y' : 'x');
  assert.throws(() => C.base58CheckDecode(evil), /checksum|base58/);
});
test('addresses start with B, validate, and reject edits', () => {
  for (const w of [alice, bob, carol]) {
    assert.equal(w.address[0], 'B', w.address);
    assert.ok(C.isValidAddress(w.address));
  }
  assert.ok(!C.isValidAddress(alice.address.slice(0, -1) + (alice.address.endsWith('1') ? '2' : '1')));
  assert.ok(!C.isValidAddress('not an address'));
  assert.equal(C.addressFromPublicKey(alice.publicKey), alice.address, 'derivation is stable');
});
test('generateWallet: deterministic from entropy, random otherwise', () => {
  const w1 = C.generateWallet('aa'.repeat(32));
  const w2 = C.generateWallet('aa'.repeat(32));
  assert.equal(w1.address, w2.address);
  assert.notEqual(C.generateWallet().address, C.generateWallet().address);
});

/* ---------- merkle tree ---------- */
test('merkle root: single leaf is itself; order matters; odd leaf duplicated', () => {
  const a = C.sha256('a'), b = C.sha256('b'), c = C.sha256('c');
  assert.equal(C.merkleRoot([a]), a);
  assert.notEqual(C.merkleRoot([a, b]), C.merkleRoot([b, a]));
  assert.equal(C.merkleRoot([a, b, c]), C.merkleRoot([a, b, c, c]), 'odd count duplicates last');
});

/* ---------- money ---------- */
test('amount formatting and parsing', () => {
  assert.equal(C.DECIMALS, 5, 'five decimal places');
  assert.equal(C.parseAmount('1.5'), 1.5 * C.COIN);
  assert.equal(C.parseAmount('0.00001'), 1, 'smallest unit is one base unit');
  assert.equal(C.formatAmount(C.parseAmount('12.34500')), '12.345 BLZ');
  assert.equal(C.formatAmount(50 * C.COIN), '50 BLZ');
  assert.throws(() => C.parseAmount('1.123456'), /bad amount/); // more than 5 decimals
  assert.throws(() => C.parseAmount('nope'), /bad amount/);
});
test('default monetary policy: exactly 21,000,000,000 BLZ will ever exist', () => {
  const chain = new C.Blockchain(); // real params, not the test net
  const CAP = 21000000000 * C.COIN;
  assert.equal(chain.subsidyAt(1), 50000 * C.COIN, '50,000 BLZ at height 1');
  assert.equal(chain.stats().maxSupply, CAP);
  // Sum the whole halving series: 50,000 BLZ halving every 210,000 blocks, forever.
  let total = 0;
  for (let h = 0; ; h++) {
    const s = chain.subsidyAt(h * chain.params.halvingInterval);
    if (s === 0) break;
    total += s * chain.params.halvingInterval;
  }
  assert.ok(total <= CAP, 'issuance never exceeds the cap');
  assert.ok(total > 0.995 * CAP, 'and approaches it, like Bitcoin');
  assert.ok(CAP <= Number.MAX_SAFE_INTEGER, 'the whole supply stays an exact integer');
});
test('subsidy halves on schedule and eventually hits zero', () => {
  const chain = newChain(); // halvingInterval 4
  assert.equal(chain.subsidyAt(1), 50 * C.COIN);
  assert.equal(chain.subsidyAt(3), 50 * C.COIN);
  assert.equal(chain.subsidyAt(4), 25 * C.COIN);
  assert.equal(chain.subsidyAt(8), 12.5 * C.COIN);
  assert.equal(chain.subsidyAt(4 * 60), 0, 'reward runs out — the supply cap');
});

/* ---------- genesis & mining ---------- */
test('genesis is deterministic: two nodes derive the identical block', () => {
  assert.equal(newChain().tip.hash, newChain().tip.hash);
  assert.notEqual(newChain().tip.hash, newChain({ genesisMessage: 'other coin' }).tip.hash);
});
test('mining pays the subsidy and the block meets its target', () => {
  const chain = newChain();
  const block = mineTo(chain, alice);
  assert.equal(block.height, 1);
  assert.ok(C.meetsTarget(block.hash, block.target), 'proof of work holds');
  assert.equal(C.blockHashOf(block), block.hash);
  assert.equal(chain.getBalance(alice.address), 50 * C.COIN);
  assert.equal(chain.totalSupply(), 50 * C.COIN);
});

/* ---------- transfers ---------- */
test('send: recipient paid, change returned, fee goes to the miner', () => {
  const chain = newChain();
  mineTo(chain, alice); // alice: 50
  const fee = C.parseAmount('0.001');
  chain.send(alice, bob.address, C.parseAmount('12.5'), fee, { timestamp: tick() });
  assert.equal(chain.mempool.length, 1);
  mineTo(chain, carol);
  assert.equal(chain.mempool.length, 0);
  assert.equal(chain.getBalance(bob.address), C.parseAmount('12.5'));
  assert.equal(chain.getBalance(alice.address), C.parseAmount('37.499'), 'change minus fee');
  assert.equal(chain.getBalance(carol.address), 50 * C.COIN + fee, 'subsidy + fee');
  assert.equal(chain.totalSupply(), 100 * C.COIN, 'transfers create no money');
});
test('overspending and unfunded wallets are rejected', () => {
  const chain = newChain();
  mineTo(chain, alice);
  assert.throws(() => chain.send(alice, bob.address, 51 * C.COIN, 0), /insufficient funds/);
  assert.throws(() => chain.send(bob, alice.address, 1, 0), /insufficient funds/);
});
test('a signature from the wrong key is rejected', () => {
  const chain = newChain();
  mineTo(chain, alice);
  const utxos = chain.spendableUtxos(alice.address);
  // Bob tries to spend Alice's output using his own keypair.
  const theft = C.buildTransaction({ utxos, wallet: bob, to: bob.address, amount: 1 * C.COIN, fee: 0, timestamp: tick() });
  assert.throws(() => chain.submitTransaction(theft), /does not own/);
});
test('tampering with a signed transaction invalidates it', () => {
  const chain = newChain();
  mineTo(chain, alice);
  const tx = C.buildTransaction({
    utxos: chain.spendableUtxos(alice.address), wallet: alice,
    to: bob.address, amount: 1 * C.COIN, fee: 0, timestamp: tick(),
  });
  tx.outputs[0].amount = 49 * C.COIN; // give myself more
  tx.id = C.txIdOf(tx);               // even re-computing the id doesn't help
  assert.throws(() => chain.submitTransaction(tx), /invalid signature/);
});
test('mempool double-spends are rejected; balances respect pending txs', () => {
  const chain = newChain();
  mineTo(chain, alice); // one single 50 BLZ output
  chain.send(alice, bob.address, 30 * C.COIN, 0, { timestamp: tick() });
  assert.throws(() => chain.send(alice, carol.address, 30 * C.COIN, 0, { timestamp: tick() }),
    /insufficient funds/, 'the only UTXO is locked by the pending tx');
});
test('fee-rate ordering: higher-fee transactions are mined first', () => {
  const chain = newChain({ maxBlockTxs: 1 });
  mineTo(chain, alice);
  mineTo(chain, alice); // two separate 50 BLZ outputs
  const cheap = chain.send(alice, bob.address, 1 * C.COIN, 100, { timestamp: tick() });
  const rich = chain.send(alice, bob.address, 1 * C.COIN, 100000, { timestamp: tick() });
  const block = mineTo(chain, carol);
  assert.equal(block.transactions.length, 2, 'block only fits one transfer');
  assert.equal(block.transactions[1].id, rich.id, 'higher fee wins the slot');
  assert.equal(chain.mempool[0].tx.id, cheap.id, 'cheap tx waits');
});

/* ---------- consensus rules ---------- */
test('blocks with bad PoW, wrong prevHash or tampered contents are rejected', () => {
  const chain = newChain();
  const good = chain.prepareBlock(alice.address, { timestamp: tick() });
  // no PoW at all (target is 8 zero bits, an unmined hash virtually never passes)
  const lazy = { ...good, hash: C.blockHashOf(good) };
  if (!C.meetsTarget(lazy.hash, lazy.target)) assert.throws(() => chain.addBlock(lazy), /proof of work/);
  // mined, then tampered: editing the coinbase breaks its id...
  C.mine(good);
  const forged = JSON.parse(JSON.stringify(good));
  forged.transactions[0].outputs = [{ address: bob.address, amount: 5000 * C.COIN }];
  assert.throws(() => chain.addBlock(forged), /coinbase id mismatch/);
  // ...and re-computing the id just moves the failure to the merkle commitment
  forged.transactions[0].id = C.txIdOf(forged.transactions[0]);
  assert.throws(() => chain.addBlock(forged), /merkle root mismatch/);
  // wrong parent
  const orphan = { ...good, prevHash: C.sha256('nonsense') };
  assert.throws(() => chain.addBlock(orphan), /prevHash/);
  // the untampered original still works
  chain.addBlock(good);
  assert.equal(chain.tip.height, 1);
});
test('coinbase cannot pay more than subsidy + fees', () => {
  const chain = newChain();
  const block = chain.prepareBlock(alice.address, { timestamp: tick() });
  block.transactions[0] = C.createCoinbase({ height: 1, address: alice.address, amount: 51 * C.COIN });
  block.merkleRoot = C.merkleRoot(block.transactions.map((t) => t.id));
  C.mine(block);
  assert.throws(() => chain.addBlock(block), /more than subsidy/);
});
test('timestamps must advance past the median of recent blocks', () => {
  const chain = newChain();
  mineTo(chain, alice);
  const stale = chain.prepareBlock(alice.address, { timestamp: GENESIS_TIME - 5000 });
  assert.ok(stale.timestamp > GENESIS_TIME, 'prepareBlock clamps to median-time-past + 1');
  const manual = { ...chain.prepareBlock(alice.address, { timestamp: tick() }), timestamp: GENESIS_TIME - 1 };
  manual.hash = ''; C.mine(manual);
  assert.throws(() => chain.addBlock(manual), /median/);
});
test('difficulty retargets: fast blocks tighten the target, slow blocks relax it', () => {
  const chain = newChain(); // retarget every 5, target spacing 1000ms
  let t = GENESIS_TIME;     // local timeline so the genesis-anchored window is controlled
  const t0 = BigInt('0x' + chain.tip.target);
  for (let i = 0; i < 5; i++) chain.minePendingTransactions(alice.address, { timestamp: (t += 100) }); // 10× too fast
  const t1 = BigInt('0x' + chain.nextTarget());
  assert.ok(t1 < t0, 'target shrank (harder)');
  assert.equal(t1, t0 / 4n, 'clamped to a 4× step like Bitcoin');
  for (let i = 0; i < 5; i++) chain.minePendingTransactions(alice.address, { timestamp: (t += 60000) }); // way too slow
  const t2 = BigInt('0x' + chain.nextTarget());
  assert.ok(t2 > t1, 'target grew (easier)');
  assert.ok(t2 <= BigInt('0x' + TEST_PARAMS.genesisTarget), 'never easier than the PoW limit');
});
test('cumulative work accrues per block', () => {
  const chain = newChain();
  const w0 = chain.workTotal;
  mineTo(chain, alice);
  assert.ok(chain.workTotal > w0);
  assert.equal(chain.workTotal - w0, C.workOf(chain.tip.target));
});

/* ---------- fork choice & sync ---------- */
test('replaceChain adopts a heavier fork and re-queues orphaned mempool txs', () => {
  const a = newChain(), b = newChain();
  let ca = GENESIS_TIME, cb = GENESIS_TIME;
  a.minePendingTransactions(alice.address, { timestamp: (ca += 1000) });
  a.minePendingTransactions(alice.address, { timestamp: (ca += 1000) });
  b.minePendingTransactions(bob.address, { timestamp: (cb += 1000) });
  b.minePendingTransactions(bob.address, { timestamp: (cb += 1000) });
  b.minePendingTransactions(bob.address, { timestamp: (cb += 1000) });
  // a has a pending tx that spends an output existing only on fork A
  a.send(alice, carol.address, 10 * C.COIN, 0, { timestamp: ca + 1 });

  assert.equal(a.replaceChain(b.blocks), true, 'heavier fork wins');
  assert.equal(a.tip.hash, b.tip.hash);
  assert.equal(a.getBalance(alice.address), 0, 'fork A rewards are gone');
  assert.equal(a.getBalance(bob.address), 150 * C.COIN);
  assert.equal(a.mempool.length, 0, 'orphaned tx dropped — its inputs never existed here');

  assert.equal(b.replaceChain(a.blocks), false, 'equal/lighter chain rejected');
});
test('replaceChain rejects invalid or foreign chains outright', () => {
  const a = newChain();
  a.minePendingTransactions(alice.address, { timestamp: GENESIS_TIME + 1000 });
  const foreign = newChain({ genesisMessage: 'evil twin' });
  assert.equal(a.replaceChain(foreign.blocks), false, 'different genesis');
  const b = newChain();
  for (let i = 1; i <= 3; i++) b.minePendingTransactions(bob.address, { timestamp: GENESIS_TIME + i * 1000 });
  const doctored = JSON.parse(JSON.stringify(b.blocks));
  doctored[2].transactions[0].outputs[0].amount = 5000 * C.COIN;
  assert.equal(a.replaceChain(doctored), false, 'tampered fork rejected');
});
test('serialisation round-trip revalidates every block and preserves state', () => {
  const chain = newChain();
  mineTo(chain, alice);
  chain.send(alice, bob.address, 5 * C.COIN, 1000, { timestamp: tick() });
  mineTo(chain, carol);
  const restored = C.Blockchain.fromJSON(JSON.parse(JSON.stringify(chain.toJSON())));
  assert.equal(restored.tip.hash, chain.tip.hash);
  assert.equal(restored.workTotal, chain.workTotal);
  assert.equal(restored.getBalance(bob.address), chain.getBalance(bob.address));
  assert.equal(restored.totalSupply(), chain.totalSupply());
});

/* ---------- explorer helpers ---------- */
test('history and findTransaction trace the ledger', () => {
  const chain = newChain();
  mineTo(chain, alice);
  const tx = chain.send(alice, bob.address, 7 * C.COIN, 0, { timestamp: tick() });
  mineTo(chain, carol);
  const hist = chain.history(alice.address);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].delta, 50 * C.COIN, 'coinbase in');
  assert.equal(hist[1].delta, -7 * C.COIN, 'net spend (inputs minus change)');
  const found = chain.findTransaction(tx.id);
  assert.equal(found.block.height, 2);
  assert.equal(found.tx.outputs[0].address, bob.address);
  assert.equal(chain.findTransaction(C.sha256('nope')), null);
});
test('richList ranks holders by balance', () => {
  const chain = newChain();
  mineTo(chain, alice);                                        // alice 50
  chain.send(alice, bob.address, 20 * C.COIN, 0, { timestamp: tick() });
  mineTo(chain, carol);                                        // carol 50, alice 30, bob 20
  const rich = chain.richList();
  // Spread into this realm's arrays — vm-sandbox arrays fail cross-realm deepStrictEqual.
  assert.deepEqual([...rich.map((r) => r.address)], [carol.address, alice.address, bob.address]);
  assert.deepEqual([...rich.map((r) => r.amount)], [50 * C.COIN, 30 * C.COIN, 20 * C.COIN]);
  assert.equal(chain.richList(2).length, 2, 'limit respected');
});
test('stats reports the shape the UI renders', () => {
  const chain = newChain();
  mineTo(chain, alice);
  const s = chain.stats();
  assert.equal(s.ticker, 'BLZ');
  assert.equal(s.height, 1);
  assert.equal(s.supply, 50 * C.COIN);
  assert.equal(s.blockReward, 50 * C.COIN);
  assert.equal(s.nextHalvingHeight, 4);
  assert.ok(s.difficulty >= 1);
});

/* ---------- 2-of-3 multisig escrow ---------- */
const escrowRedeem = { pubkeys: [alice.publicKey, bob.publicKey, carol.publicKey], m: 2 };
const escrowAddr = C.createMultisigAddress(escrowRedeem.pubkeys, escrowRedeem.m);

test('multisig addresses: distinct, order-independent, start with M, validated', () => {
  assert.equal(escrowAddr[0], 'M', escrowAddr);
  assert.equal(C.addressType(escrowAddr), 'multisig');
  assert.equal(C.addressType(alice.address), 'p2pkh');
  assert.ok(C.isValidAddress(escrowAddr));
  // key order doesn't change the address; the key SET does
  assert.equal(C.createMultisigAddress([carol.publicKey, alice.publicKey, bob.publicKey], 2), escrowAddr);
  assert.notEqual(C.createMultisigAddress(escrowRedeem.pubkeys, 3), escrowAddr, 'different m → different address');
  assert.throws(() => C.createMultisigAddress([alice.publicKey, alice.publicKey], 2), /duplicate/);
  assert.throws(() => C.createMultisigAddress([alice.publicKey, bob.publicKey], 3), /1\.\.n/);
});

test('funds can be locked into escrow and spent with 2 of 3 signatures', () => {
  const chain = newChain();
  mineTo(chain, alice);                                    // alice: 50
  // buyer (alice) funds the escrow
  chain.send(alice, escrowAddr, 10 * C.COIN, 0, { timestamp: tick() });
  mineTo(chain, carol);
  assert.equal(chain.getBalance(escrowAddr), 10 * C.COIN, 'escrow holds the coins');
  assert.equal(chain.getBalance(bob.address), 0);

  // release to the seller (bob): buyer + arbiter sign (2 of 3)
  const utxos = chain.spendableUtxos(escrowAddr);
  let spend = C.buildMultisigSpend({ utxos, redeem: escrowRedeem, to: bob.address, amount: 10 * C.COIN, fee: 0, changeAddress: escrowAddr, timestamp: tick() });
  C.signMultisig(spend, alice.privateKey);
  C.signMultisig(spend, carol.privateKey);
  C.finalizeMultisig(spend);
  chain.submitTransaction(spend);
  mineTo(chain, alice);
  assert.equal(chain.getBalance(bob.address), 10 * C.COIN, 'seller paid from escrow');
  assert.equal(chain.getBalance(escrowAddr), 0, 'escrow emptied');
});

test('escrow refund path: a different 2 of 3 also unlocks it', () => {
  const chain = newChain();
  mineTo(chain, alice);
  chain.send(alice, escrowAddr, 8 * C.COIN, 0, { timestamp: tick() });
  mineTo(chain, carol);
  // refund the buyer (alice): seller (bob) + arbiter (carol) sign
  const spend = C.buildMultisigSpend({ utxos: chain.spendableUtxos(escrowAddr), redeem: escrowRedeem, to: alice.address, amount: 8 * C.COIN, fee: 0, changeAddress: escrowAddr, timestamp: tick() });
  C.signMultisig(spend, bob.privateKey);
  C.signMultisig(spend, carol.privateKey);
  C.finalizeMultisig(spend);
  chain.submitTransaction(spend);
  mineTo(chain, alice);
  assert.equal(chain.getBalance(escrowAddr), 0);
  // alice got 8 back (plus she still had her earlier mining rewards/change)
  assert.ok(chain.getBalance(alice.address) >= 8 * C.COIN);
});

test('a single signature cannot drain a 2-of-3 escrow', () => {
  const chain = newChain();
  mineTo(chain, alice);
  chain.send(alice, escrowAddr, 5 * C.COIN, 0, { timestamp: tick() });
  mineTo(chain, carol);
  const spend = C.buildMultisigSpend({ utxos: chain.spendableUtxos(escrowAddr), redeem: escrowRedeem, to: carol.address, amount: 5 * C.COIN, fee: 0, changeAddress: escrowAddr, timestamp: tick() });
  C.signMultisig(spend, carol.privateKey);            // only ONE signer
  assert.throws(() => C.finalizeMultisig(spend), /not enough signatures/);
  // and even if forced through with one sig, the network rejects it
  spend.inputs.forEach((i) => { i.signatures = [C.sign(C.sighash(spend), carol.privateKey)]; delete i._signers; });
  spend.id = C.txIdOf(spend);
  assert.throws(() => chain.submitTransaction(spend), /needs exactly 2 signatures/);
});

test('an outsider’s signatures cannot unlock the escrow', () => {
  const chain = newChain();
  mineTo(chain, alice);
  chain.send(alice, escrowAddr, 5 * C.COIN, 0, { timestamp: tick() });
  mineTo(chain, carol);
  const dave = C.walletFromPrivateKey('00000000000000000000000000000000000000000000000000000000000000aa');
  const eve = C.walletFromPrivateKey('00000000000000000000000000000000000000000000000000000000000000bb');
  const spend = C.buildMultisigSpend({ utxos: chain.spendableUtxos(escrowAddr), redeem: escrowRedeem, to: dave.address, amount: 5 * C.COIN, fee: 0, changeAddress: escrowAddr, timestamp: tick() });
  // two signatures, but from people NOT in the escrow key set
  const h = C.sighash(spend);
  spend.inputs.forEach((i) => { i.signatures = [C.sign(h, dave.privateKey), C.sign(h, eve.privateKey)]; delete i._signers; });
  spend.id = C.txIdOf(spend);
  assert.throws(() => chain.submitTransaction(spend), /invalid or out-of-order multisig|insufficient valid/);
});

test('lying about the redeem set (to match a different address) is rejected', () => {
  const chain = newChain();
  mineTo(chain, alice);
  chain.send(alice, escrowAddr, 5 * C.COIN, 0, { timestamp: tick() });
  mineTo(chain, carol);
  const spend = C.buildMultisigSpend({ utxos: chain.spendableUtxos(escrowAddr), redeem: escrowRedeem, to: bob.address, amount: 5 * C.COIN, fee: 0, changeAddress: escrowAddr, timestamp: tick() });
  C.signMultisig(spend, alice.privateKey); C.signMultisig(spend, bob.privateKey);
  C.finalizeMultisig(spend);
  // tamper: swap in a redeem that doesn't hash to the funded address
  spend.inputs.forEach((i) => { i.redeem = { pubkeys: [alice.publicKey, bob.publicKey], m: 2 }; });
  spend.id = C.txIdOf(spend);
  assert.throws(() => chain.submitTransaction(spend), /redeem does not match/);
});

test('multisig transactions survive JSON serialisation and re-validation', () => {
  const chain = newChain();
  mineTo(chain, alice);
  chain.send(alice, escrowAddr, 6 * C.COIN, 0, { timestamp: tick() });
  mineTo(chain, carol);
  const spend = C.buildMultisigSpend({ utxos: chain.spendableUtxos(escrowAddr), redeem: escrowRedeem, to: bob.address, amount: 6 * C.COIN, fee: 0, changeAddress: escrowAddr, timestamp: tick() });
  C.signMultisig(spend, alice.privateKey); C.signMultisig(spend, carol.privateKey);
  C.finalizeMultisig(spend);
  chain.submitTransaction(spend);
  mineTo(chain, bob);
  const restored = C.Blockchain.fromJSON(JSON.parse(JSON.stringify(chain.toJSON())));
  assert.equal(restored.tip.hash, chain.tip.hash, 'a chain containing a multisig spend re-validates from genesis');
  assert.equal(restored.getBalance(bob.address), chain.getBalance(bob.address));
});

/* ---------- runner ---------- */
for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\ncoin: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
