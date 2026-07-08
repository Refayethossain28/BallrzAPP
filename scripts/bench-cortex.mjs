#!/usr/bin/env node
/**
 * Benchmark for cortex/engine.js — the *production cost* of mining a
 * Proof-of-Learning block, and the hard-to-produce / cheap-to-verify asymmetry.
 *
 * A miner's cost is CPU time spent training (real compute → real electricity).
 * This measures it three ways:
 *   1. Unit costs — one gradient step vs one forward-pass verification.
 *   2. The cost curve — ms and cost-per-MIND for every block to convergence,
 *      showing how mining gets exponentially dearer as the model matures.
 *   3. A USD estimate — the measured wall-time turned into energy and dollars
 *      for this toy task, plus a FLOPs-based projection to production scale.
 *
 * Not part of `npm test` (timings aren't deterministic). Run:
 *   node scripts/bench-cortex.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const box = { module: { exports: {} } }; box.self = box;
vm.createContext(box);
vm.runInContext(readFileSync(join(ROOT, 'coin', 'engine.js'), 'utf8'), box, { filename: 'coin/engine.js' });
const C = box.module.exports; box.BallrzCoin = C; box.module = { exports: {} };
vm.runInContext(readFileSync(join(ROOT, 'cortex', 'engine.js'), 'utf8'), box, { filename: 'cortex/engine.js' });
const X = box.module.exports;

// --- assumptions for the USD estimate (edit to taste) -----------------------
const CORE_WATTS = 15;        // power drawn by one busy CPU core
const USD_PER_KWH = 0.15;     // grid electricity price
// production-scale projection reference device:
const GPU_FLOPS = 1e14;       // 100 TFLOP/s effective (a single modern accelerator)
const GPU_USD_PER_HR = 1.5;   // rented GPU, all-in

const ms = (ns) => Number(ns) / 1e6;
const now = () => process.hrtime.bigint();

const task = X.makeTask({ id: 'cortex-live-demo' });
const wallet = C.generateWallet();
console.log(`task: ${task.samples} samples · ${task.hidden} hidden · ${task.dim} weights · minImprovement=${task.minImprovement}\n`);

// 1. unit costs -------------------------------------------------------------
const w0 = X.randomWeights(task, 'bench');
let t0 = now(); for (let k = 0; k < 3000; k++) X.trainStep(task, w0, 0.5); const stepUs = ms(now() - t0) / 3000 * 1000;
t0 = now(); for (let k = 0; k < 3000; k++) X.loss(task, w0); const lossUs = ms(now() - t0) / 3000 * 1000;
const digest = C.sha256('x');
t0 = now(); for (let k = 0; k < 200; k++) C.sign(digest, wallet.privateKey); const signMs = ms(now() - t0) / 200;
const sig = C.sign(digest, wallet.privateKey);
t0 = now(); for (let k = 0; k < 200; k++) C.verify(digest, sig, wallet.publicKey); const verMs = ms(now() - t0) / 200;
console.log('UNIT COSTS');
console.log(`  gradient step (mining work)      ${stepUs.toFixed(1)} µs`);
console.log(`  forward-pass loss check (verify) ${lossUs.toFixed(1)} µs`);
console.log(`  secp256k1 sign / verify          ${signMs.toFixed(2)} / ${verMs.toFixed(2)} ms  (fixed per-block crypto)\n`);

// 2. cost curve to convergence ----------------------------------------------
const chain = new X.Chain(task, { genesisSeed: 'demo' });
const rows = []; let totalMs = 0, n = 0;
for (;;) {
  const before = chain.tipLoss();
  const s = now();
  const blk = chain.mineBlock({ privKey: wallet.privateKey, steps: 100, nonce: 'm' + n });
  const dt = ms(now() - s);
  if (!blk) break;
  chain.addBlock(blk);
  totalMs += dt;
  rows.push({ i: blk.index, dt, reward: blk.reward, usdPerMind: dt / (blk.reward / X.MIND) });
  if (++n > 300) break;
}
console.log(`COST CURVE — ${n} blocks to convergence, ${(totalMs / 1000).toFixed(2)}s total CPU`);
const show = (b) => `  #${String(b.i).padStart(2)}  ${b.dt.toFixed(0).padStart(4)} ms   reward ${X.formatMind(b.reward).padEnd(14)}  ${(b.dt / (b.reward / X.MIND)).toFixed(0).padStart(7)} ms/MIND`;
rows.slice(0, 3).forEach((b) => console.log(show(b)));
console.log('   …');
rows.slice(-3).forEach((b) => console.log(show(b)));
const early = rows[0], late = rows[rows.length - 1];
console.log(`\n  mining a mature block costs ${(late.dt / early.dt).toFixed(0)}x an early one, ` +
            `and ${(late.usdPerMind / early.usdPerMind).toFixed(0)}x as much per MIND earned`);
console.log(`  asymmetry: a mature block ≈ ${(late.dt / (lossUs / 1000)).toFixed(0)}x its own learning-verification\n`);

// 3. USD --------------------------------------------------------------------
const kwh = (totalMs / 1000) * CORE_WATTS / 3600 / 1000;
console.log('USD (this toy task, measured)');
console.log(`  whole chain: ${(totalMs / 1000).toFixed(2)}s CPU · ${kwh.toExponential(2)} kWh · $${(kwh * USD_PER_KWH).toExponential(2)} of electricity`);
console.log(`  per mature block: $${((late.dt / 1000) * CORE_WATTS / 3600 / 1000 * USD_PER_KWH).toExponential(2)}  (i.e. effectively free at this scale)\n`);

// 4. measured scale gradient — the RUNNABLE production-cost tiers -----------
console.log('SCALE GRADIENT — measured cost per gradient step at each preset tier');
console.log('  ' + 'scale'.padEnd(9) + 'samples'.padStart(9) + 'hidden'.padStart(8) + 'params'.padStart(8) + 'µs/step'.padStart(10) + 'vs toy'.padStart(9) + '~ms/1k-step block'.padStart(20));
const iters = { toy: 2000, small: 500, medium: 60, large: 6 };
let toyStep = null;
for (const name of Object.keys(X.SCALES)) {
  const st = X.makeTask({ id: 'grad-' + name, scale: name });
  const sw = X.randomWeights(st, 'b');
  const N = iters[name] || 20;
  const g0 = now(); for (let k = 0; k < N; k++) X.trainStep(st, sw, 0.5); const us = ms(now() - g0) / N * 1000;
  if (toyStep == null) toyStep = us;
  const blockMs = us * 1000 / 1000; // µs/step × 1000 steps → ms
  console.log('  ' + name.padEnd(9) + String(st.samples).padStart(9) + String(st.hidden).padStart(8) +
    String(st.dim).padStart(8) + us.toFixed(1).padStart(10) + (us / toyStep).toFixed(0).concat('x').padStart(9) +
    (blockMs < 1000 ? blockMs.toFixed(0) + ' ms' : (blockMs / 1000).toFixed(1) + ' s').padStart(20));
}
console.log('  (these tiers are what cortex/engine.js actually runs; the table below PROJECTS beyond them.)\n');

console.log('USD PROJECTION to production scale  (illustrative — cost is a design parameter set by the task size)');
console.log('  FLOPs/block ≈ 6 × params × samples-processed;  time = FLOPs / (100 TFLOP/s);  $ at $1.5/GPU-hr');
const scen = [
  ['this prototype', task.dim, task.samples * 100],
  ['small model', 1e5, 1e6],
  ['medium model', 1e7, 1e8],
  ['large model', 1e9, 1e10],
];
console.log('  ' + 'scenario'.padEnd(16) + 'params'.padStart(10) + 'FLOPs/block'.padStart(15) + 'time/block'.padStart(14) + 'USD/block'.padStart(13));
for (const [name, params, samples] of scen) {
  const flops = 6 * params * samples;
  const secs = flops / GPU_FLOPS;
  const usd = secs / 3600 * GPU_USD_PER_HR;
  const timeStr = secs < 1 ? (secs * 1000).toFixed(1) + ' ms' : secs < 3600 ? secs.toFixed(1) + ' s' : (secs / 3600).toFixed(1) + ' h';
  console.log('  ' + name.padEnd(16) + params.toExponential(0).padStart(10) + flops.toExponential(1).padStart(15) + timeStr.padStart(14) + ('$' + (usd < 0.01 ? usd.toExponential(1) : usd.toFixed(2))).padStart(13));
}
console.log('\nNote: MIND has no market price — this is production (cost-basis) only. See cortex/README.md.');
