#!/usr/bin/env node
/**
 * Unit tests for cortex/tournament.js — the forecasting-tournament chain
 * (TRUSTLESS.md phases 1–3). Drives the full OPEN→COMMIT→LOCK→REVEAL→RESOLVE→
 * SCORE lifecycle on a deterministic mock feed + oracle, with no real-world
 * trust. Covers: the round state machine and feature commitment (phase 1),
 * skill-based reward + staking/slashing (phase 2), and the signed outcome
 * oracle (phase 3), plus every abuse path. Loaded in a vm sandbox with the
 * coin engine, dataset module, cortex engine and holdout layer. Run:
 *   node scripts/test-cortex-tournament.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const box = { module: { exports: {} } }; box.self = box;
vm.createContext(box);
const load = (p, set) => { box.module = { exports: {} }; vm.runInContext(readFileSync(join(ROOT, p), 'utf8'), box, { filename: p }); if (set) box[set] = box.module.exports; return box.module.exports; };
const C = load('coin/engine.js', 'BallrzCoin');
load('cortex/datasets.js', 'BallrzCortexData');
const X = load('cortex/engine.js', 'BallrzCortex');
const H = load('cortex/holdout.js', 'BallrzCortexHoldout');
const T = load('cortex/tournament.js', 'BallrzCortexTournament');

const alice = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001');
const bob = C.walletFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000002');
const MIND = X.MIND;

let n = 0; const tests = []; const test = (name, fn) => tests.push([name, fn]);

// A mock feed + a fresh tournament with alice & bob funded to stake.
function setup(opts = {}) {
  const feed = T.mockFeed({ seed: 'e2e', inputs: 3, samples: 60, noise: 0.08 });
  const tour = T.create({
    inputs: feed.inputs, layers: [10],
    oraclePubKey: feed.oracle.publicKey,
    stake: opts.stake == null ? 2 * MIND : opts.stake,
    slashFraction: opts.slashFraction == null ? 0.5 : opts.slashFraction,
    balances: { [alice.address]: 10 * MIND, [bob.address]: 10 * MIND }
  });
  return { feed, tour };
}
// Resolve a round with a valid oracle attestation over the true labels.
function resolve(tour, feed, rs, round, labels) {
  const att = T.signOutcome(feed.oracle.privateKey, round, rs.featuresHash, labels);
  return T.resolveRound(tour, { round, labels, attestation: att });
}

test('phase 3: outcome oracle attestation binds round, features and labels', () => {
  const { feed, tour } = setup();
  const r = feed.round(0), fh = T.featuresHashOf(r.features);
  const att = T.signOutcome(feed.oracle.privateKey, 0, fh, r.labels);
  assert.ok(T.verifyOutcome(att, feed.oracle.publicKey, fh, r.labels), 'valid attestation verifies');
  assert.ok(!T.verifyOutcome(att, bob.publicKey, fh, r.labels), 'wrong oracle key rejected');
  assert.ok(!T.verifyOutcome(att, feed.oracle.publicKey, 'deadbeef', r.labels), 'features mismatch rejected');
  const tampered = r.labels.slice(); tampered[0] = 1 - tampered[0];
  assert.ok(!T.verifyOutcome(att, feed.oracle.publicKey, fh, tampered), 'label tampering rejected');
});

test('phase 1: the round state machine enforces its transitions', () => {
  const { feed, tour } = setup();
  const r = feed.round(0);
  const rs = T.openRound(tour, { round: 0, features: r.features });
  assert.equal(rs.state, 'OPEN');
  assert.equal(rs.featuresHash, T.featuresHashOf(r.features), 'features committed at open');
  // can't reveal before lock, can't resolve before lock, can't score before resolve
  const w = T.trainOnHistory(tour.spec, [feed.round(90)], { steps: 50, seed: 'x' });
  T.commitEntry(tour, { round: 0, privKey: alice.privateKey, weightsCommitment: H.commitWeights(w) });
  assert.throws(() => T.revealEntry(tour, { round: 0, miner: alice.address, weights: w }), /after lock/);
  assert.throws(() => T.scoreRound(tour, 0), /not resolved/);
  T.lockRound(tour, 0);
  assert.throws(() => T.commitEntry(tour, { round: 0, privKey: bob.privateKey, weightsCommitment: 'x' }), /not open/);
});

test('phase 2: staking escrows MIND and double-entry / underfunding are rejected', () => {
  const { feed, tour } = setup({ stake: 2 * MIND });
  T.openRound(tour, { round: 0, features: feed.round(0).features });
  const before = T.balanceOf(tour, alice.address);
  T.commitEntry(tour, { round: 0, privKey: alice.privateKey, weightsCommitment: 'c1' });
  assert.equal(T.balanceOf(tour, alice.address), before - 2 * MIND, 'stake moved to escrow');
  assert.throws(() => T.commitEntry(tour, { round: 0, privKey: alice.privateKey, weightsCommitment: 'c2' }), /already entered/);
  const poor = C.walletFromPrivateKey('00000000000000000000000000000000000000000000000000000000000000aa');
  assert.throws(() => T.commitEntry(tour, { round: 0, privKey: poor.privateKey, weightsCommitment: 'c3' }), /insufficient MIND/);
});

test('reveal must match the pre-outcome weight commitment', () => {
  const { feed, tour } = setup();
  const w = T.trainOnHistory(tour.spec, [feed.round(91)], { steps: 50, seed: 'r' });
  T.openRound(tour, { round: 0, features: feed.round(0).features });
  T.commitEntry(tour, { round: 0, privKey: alice.privateKey, weightsCommitment: H.commitWeights(w) });
  T.lockRound(tour, 0);
  const tampered = w.slice(); tampered[0] += 0.5;
  assert.throws(() => T.revealEntry(tour, { round: 0, miner: alice.address, weights: tampered }), /do not match the commitment/);
  T.revealEntry(tour, { round: 0, miner: alice.address, weights: w }); // the real weights are fine
});

test('resolve rejects an attestation not signed by the configured oracle', () => {
  const { feed, tour } = setup();
  const r = feed.round(0), rs = T.openRound(tour, { round: 0, features: r.features });
  T.lockRound(tour, 0);
  const forged = T.signOutcome(bob.privateKey, 0, rs.featuresHash, r.labels); // wrong signer
  assert.throws(() => T.resolveRound(tour, { round: 0, labels: r.labels, attestation: forged }), /attestation invalid/);
});

test('end to end: a model trained on history earns MIND predicting the future; an anti-skill one is slashed', () => {
  const { feed, tour } = setup({ stake: 2 * MIND });
  // History = resolved past rounds (public); the honest miner trains on them.
  const history = [10, 11, 12, 13, 14].map((k) => feed.round(k));
  const good = T.trainOnHistory(tour.spec, history, { steps: 1200, seed: 'alice' });
  // Bob trains on FLIPPED labels — a confidently-wrong, genuinely anti-skill model.
  const flipped = history.map((r) => ({ features: r.features, labels: r.labels.map((v) => 1 - v) }));
  const bad = T.trainOnHistory(tour.spec, flipped, { steps: 1200, seed: 'bob' });

  const R = 0, r = feed.round(R);
  const rs = T.openRound(tour, { round: R, features: r.features });
  const aBefore = T.balanceOf(tour, alice.address), bBefore = T.balanceOf(tour, bob.address);
  T.commitEntry(tour, { round: R, privKey: alice.privateKey, weightsCommitment: H.commitWeights(good) });
  T.commitEntry(tour, { round: R, privKey: bob.privateKey, weightsCommitment: H.commitWeights(bad) });
  T.lockRound(tour, R);
  T.revealEntry(tour, { round: R, miner: alice.address, weights: good });
  T.revealEntry(tour, { round: R, miner: bob.address, weights: bad });
  resolve(tour, feed, rs, R, r.labels);
  const out = T.scoreRound(tour, R);

  const aRes = out.results.find((x) => x.miner === alice.address);
  const bRes = out.results.find((x) => x.miner === bob.address);
  assert.equal(aRes.status, 'reward', `trained model clears the skill bar (skill ${aRes.skill})`);
  assert.ok(aRes.reward > 0, 'and earns freshly minted MIND');
  assert.ok(T.balanceOf(tour, alice.address) > aBefore, 'alice net-ahead (stake back + reward)');
  assert.equal(bRes.status, 'slash', `confidently-wrong model is anti-skill (skill ${bRes.skill})`);
  assert.ok(bRes.slashed > 0 && T.balanceOf(tour, bob.address) < bBefore, 'and is slashed for it');
  assert.equal(T.balanceOf(tour, alice.address), aBefore - 2 * MIND + aRes.returned + aRes.reward + (aRes.bonus || 0));
});

test('noise-level skill lands in the dead zone — luck is not paid', () => {
  const { feed, tour } = setup({ stake: 2 * MIND });
  const R = 2, r = feed.round(R);
  const rs = T.openRound(tour, { round: R, features: r.features });
  const rand = X.randomWeights(tour.spec, 'lucky-random'); // untrained
  const before = T.balanceOf(tour, alice.address);
  T.commitEntry(tour, { round: R, privKey: alice.privateKey, weightsCommitment: H.commitWeights(rand) });
  T.lockRound(tour, R);
  T.revealEntry(tour, { round: R, miner: alice.address, weights: rand });
  resolve(tour, feed, rs, R, r.labels);
  const res = T.scoreRound(tour, R).results[0];
  assert.equal(res.status, 'neutral', `near-baseline skill (${res.skill}) earns nothing`);
  assert.equal(res.reward, 0);
  assert.equal(T.balanceOf(tour, alice.address), before, 'stake returned intact, no reward, no slash');
});

test('an entrant who never reveals forfeits the whole stake', () => {
  const { feed, tour } = setup({ stake: 3 * MIND });
  const R = 1, r = feed.round(R);
  const rs = T.openRound(tour, { round: R, features: r.features });
  const before = T.balanceOf(tour, alice.address);
  T.commitEntry(tour, { round: R, privKey: alice.privateKey, weightsCommitment: 'never-revealed' });
  T.lockRound(tour, R);
  resolve(tour, feed, rs, R, r.labels);
  const out = T.scoreRound(tour, R);
  const res = out.results.find((x) => x.miner === alice.address);
  assert.equal(res.revealed, false);
  assert.equal(res.slashed, 3 * MIND, 'full stake forfeited');
  assert.equal(T.balanceOf(tour, alice.address), before - 3 * MIND, 'stake not returned');
});

test('skill improves as the model sees more history (genuine generalisation)', () => {
  const { feed, tour } = setup();
  const score = (histLen, seed) => {
    const hist = []; for (let k = 20; k < 20 + histLen; k++) hist.push(feed.round(k));
    const w = T.trainOnHistory(tour.spec, hist, { steps: 1500, seed });
    const r = feed.round(5);
    return X.MIND && (T.baselineLoss(r.labels) - X.loss(tour.spec, w, r.features, r.labels));
  };
  const little = score(1, 's1');
  const lots = score(8, 's8');
  assert.ok(lots > little, `more history -> more skill on the held-out future round (${little.toFixed(3)} -> ${lots.toFixed(3)})`);
});

// ---- runner ----------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); n++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n    ${e && e.message}`); }
}
console.log(`\n${n}/${tests.length} cortex tournament tests passed`);
if (failed) process.exit(1);
