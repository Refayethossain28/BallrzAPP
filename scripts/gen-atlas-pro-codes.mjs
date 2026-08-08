#!/usr/bin/env node
/**
 * Generates Atlas Pro unlock codes — the seller-side half of the offline
 * activation system. Codes carry their own checksum (atlas/engine.js
 * validProCode), so the app verifies them with no server and no account:
 * sell them through any payment link (Stripe Payment Link, Gumroad, Ko-fi)
 * and deliver the code in the receipt email.
 *
 * Run: node scripts/gen-atlas-pro-codes.mjs [count]     (default 10)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'atlas', 'engine.js'), 'utf8'), sandbox, { filename: 'atlas/engine.js' });
const A = sandbox.module.exports;

const count = Math.max(1, Math.min(1000, parseInt(process.argv[2], 10) || 10));
const rand = () => randomBytes(4).readUInt32BE(0) / 2 ** 32;

const seen = new Set();
while (seen.size < count) {
  const code = A.makeProCode(rand);
  if (seen.has(code)) continue;
  if (!A.validProCode(code)) throw new Error('generated an invalid code: ' + code);
  seen.add(code);
  console.log(code);
}
console.error(`\n${count} Atlas Pro code(s) — each verifies offline in the app (Settings → ⭐ Atlas Pro).`);
