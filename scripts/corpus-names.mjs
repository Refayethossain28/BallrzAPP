#!/usr/bin/env node
/**
 * Build a NAME corpus for the from-scratch LLM — the "🏷️ Names" niche.
 *
 * A small language model is genuinely good at one thing: learning the shape of
 * a narrow, repetitive domain and emitting plausible new members of it. Brand
 * and model names are the ideal case — the value is a *candidate* a human
 * picks, so plausibility, not truth, is the whole job.
 *
 * This generates a deterministic seed corpus of luxury / automotive / premium
 * brand names (one per line) from curated morpheme banks — no network, no
 * trademarks copied wholesale, just the *morphology* of the genre so a trained
 * model dreams up new ones. Expand it with your own list any time (append lines
 * to the output, or edit the banks below).
 *
 *   node scripts/corpus-names.mjs                 # -> llm-from-scratch/data/names.txt
 *   node scripts/corpus-names.mjs --count 12000 --out llm-from-scratch/data/names.txt
 *
 * Then train a dedicated tiny model on it (char tokenizer suits names best):
 *   Actions → "Train browser LLM" → corpus_url = data/names.txt,
 *     out_model = model-names.json, tokenizer = char, block_size = 48
 * Zero dependencies — Node built-ins only.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---- args (no Math.random — deterministic, seed-driven, reproducible) ---- */
let count = 10000, out = join('llm-from-scratch', 'data', 'names.txt'), seed = 1;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--count') count = Math.max(200, Math.min(200000, parseInt(argv[++i], 10) || 10000));
  else if (argv[i] === '--out') out = argv[++i];
  else if (argv[i] === '--seed') seed = parseInt(argv[++i], 10) || 1;
}

// A tiny deterministic PRNG (mulberry32) so runs are reproducible without
// Math.random (which is unavailable in some of this repo's sandboxes).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(seed);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/* ---- morpheme banks: the sound of "premium" ---- */
const PREFIX = ['Aur', 'Nov', 'Vel', 'Lum', 'Sol', 'Mer', 'Val', 'Cel', 'Ver', 'Alt',
  'Reg', 'Nob', 'Imp', 'Prim', 'Sov', 'Maj', 'Ely', 'Ser', 'Vant', 'Cor',
  'Astr', 'Onyx', 'Dael', 'Zeph', 'Cael', 'Ther', 'Lux', 'Obs', 'Nyx', 'Vesp'];
const MID = ['a', 'e', 'i', 'o', 'ia', 'io', 'eo', 'an', 'en', 'in', 'or', 'ar', 'is', 'us', 'yn'];
const SUFFIX = ['ora', 'ari', 'ell', 'ade', 'esse', 'ique', 'ova', 'ira', 'yn', 'os',
  'ance', 'ence', 'ique', 'aire', 'eur', 'ora', 'is', 'ea', 'ony', 'estra'];
// Real words that read as luxury when recombined (public-domain vocabulary).
const NOBLE = ['Noir', 'Privé', 'Royale', 'Élite', 'Sovereign', 'Meridian', 'Atlas', 'Aurora',
  'Onyx', 'Obsidian', 'Zenith', 'Apex', 'Crown', 'Regent', 'Empire', 'Vantage',
  'Celestine', 'Cardinal', 'Marquis', 'Baron', 'Estate', 'Heritage', 'Legacy',
  'Platinum', 'Titanium', 'Velvet', 'Ivory', 'Ebony', 'Sterling', 'Grandeur'];
const NATURE = ['Falcon', 'Phoenix', 'Stag', 'Panther', 'Raven', 'Comet', 'Meteor', 'Solace',
  'Zephyr', 'Cascade', 'Summit', 'Horizon', 'Eclipse', 'Aurora', 'Tempest',
  'Cobalt', 'Sapphire', 'Onyx', 'Amber', 'Slate', 'Ridge', 'Cove', 'Vale'];
const SERIES = ['One', 'GT', 'S', 'X', 'Prime', 'Reserve', 'Signature', 'Édition', 'Classic',
  'Continental', 'Grand', 'Sport', 'Executive', 'Noir', '24', 'Mk II', 'Series'];
const TITLE = ['Chauffeur', 'Motors', 'Automobili', 'Carriage', 'Coachworks', 'Livery',
  'Concours', 'Atelier', 'Maison', 'Collective', 'Group', 'Company'];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---- name shapes: several genres so the model learns variety ---- */
function coined() { return cap(pick(PREFIX)) + pick(MID) + pick(SUFFIX); }
function compound() { return pick(NOBLE) + ' ' + pick(NATURE); }
function marque() { return pick(NATURE) + ' ' + pick(SERIES); }
function house() { return pick(NOBLE) + ' ' + pick(TITLE); }
function initialied() { return pick(NOBLE).slice(0, 1) + pick(NOBLE).slice(0, 1) + ' ' + pick(NATURE); }
function noirline() { return pick(NATURE) + ' ' + pick(NOBLE); }
const SHAPES = [coined, coined, compound, marque, house, initialied, noirline];

/* ---- generate, dedupe, write ---- */
const seen = new Set();
const lines = [];
let guard = 0;
while (lines.length < count && guard < count * 40) {
  guard++;
  const name = pick(SHAPES)().replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.length > 34) continue;
  if (seen.has(name)) continue;
  seen.add(name);
  lines.push(name);
}

const corpus = lines.join('\n') + '\n';
const outPath = join(ROOT, out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, corpus);
console.log(`🏷️  names corpus: ${lines.length.toLocaleString()} unique names · ${(corpus.length / 1024).toFixed(1)} KB → ${out}`);
console.log('   sample:', lines.slice(0, 8).join(' · '));
console.log(`\nTrain it:\n  Actions → "Train browser LLM" → corpus_url = ${out.replace(/^llm-from-scratch\//, '')}, out_model = model-names.json, tokenizer = char, block_size = 48, steps = 4000`);
