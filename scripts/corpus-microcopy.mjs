#!/usr/bin/env node
/**
 * Build a MICROCOPY corpus for the from-scratch LLM — the "✍️ Microcopy" niche.
 *
 * The other domain where a tiny model earns its keep: short, house-style
 * messages with a fixed shape — booking confirmations, driver updates, receipts,
 * membership and marketing lines. Trained on a corpus of that style it drafts
 * plausible on-brand variations a human tops and tails.
 *
 * This generates a deterministic seed corpus of ApexVIP-style messages across
 * scenarios and tones, with {slots} kept literal so the model learns the
 * template structure (name / time / car / place) rather than memorising values.
 * Each line is one message; expand or replace with your own past messages.
 *
 *   node scripts/corpus-microcopy.mjs            # -> llm-from-scratch/data/microcopy.txt
 *
 * Train a dedicated model (BPE suits prose):
 *   Actions → "Train browser LLM" → corpus_url = data/microcopy.txt,
 *     out_model = model-microcopy.json, tokenizer = bpe, block_size = 96
 * Zero dependencies — Node built-ins only.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let out = join('llm-from-scratch', 'data', 'microcopy.txt');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i] === '--out') out = argv[++i];

/* ---- templates: scenario × phrasing, {slots} left literal ---- */
// Every phrasing is a full, sendable message in the ApexVIP voice: warm,
// precise, unhurried. The model learns the register and the slot pattern.
const T = {
  booked: [
    'Your chauffeur is confirmed for {time}. {name}, we look forward to looking after you.',
    'All set, {name} — your {car} is booked for {time}. Sit back; we have the rest.',
    'Confirmed: {name}, {time}, {car}. Your driver’s details will arrive an hour ahead.',
    'Thank you, {name}. Your journey on {date} at {time} is reserved. A pleasure to have you with us.',
    'Booking confirmed. {car}, {time}, from {location}. We’ll be ready a few minutes early.',
  ],
  enroute: [
    '{driver} is on the way in the {car} and will reach {location} in {min} minutes.',
    'Your chauffeur {driver} has set off — arriving in about {min} minutes.',
    'On the move: {driver} is {min} minutes from {location}. Whenever you’re ready.',
    '{name}, your {car} is {min} minutes away. No rush — the car will wait.',
  ],
  arrived: [
    '{driver} has arrived at {location} in the {car}. Take your time.',
    'Your chauffeur is waiting outside in the {car}. Registration {plate}.',
    'We’re here, {name} — {driver} is at {location}, {car}, whenever suits.',
  ],
  receipt: [
    'Thank you for travelling with us, {name}. Your fare for {date} was {amount}. We hope it was seamless.',
    'Journey complete. {amount} for {date}, {car}. A receipt is attached, {name}.',
    'It was our pleasure, {name}. Total {amount}. We’d be glad to see you again soon.',
  ],
  membership: [
    '{name}, your invitation to ApexVIP Founding membership is ready — keep more, wait less.',
    'Welcome to ApexVIP, {name}. Priority cars, fixed fares, one number for anything.',
    'A place has opened in the Founding tier, {name}. Shall we hold it for you?',
  ],
  marketing: [
    'The city, on your terms. Chauffeured travel that runs to your clock, not ours.',
    'No apps to wrestle, no surge, no small talk you didn’t ask for — just the car, on time.',
    'Arrive unhurried. ApexVIP — the quiet luxury of never watching the road.',
    'One number. Any hour. The same trusted driver. This is travel, handled.',
    'For the journeys that matter, a car that’s already waiting.',
  ],
  reschedule: [
    'No trouble at all, {name} — we’ve moved your car to {time}. All confirmed.',
    'Done. Your pickup is now {time} from {location}. Anything else, just say.',
    '{name}, we’ve held everything and shifted you to {time}. The {car} is yours.',
  ],
};

/* ---- assemble: label each line by scenario so the model can be prompted ---- */
const lines = [];
for (const [scenario, variants] of Object.entries(T)) {
  for (const v of variants) {
    // a plain line, and a lightly labelled line, so the model learns both a raw
    // house voice and a "scenario -> message" mapping usable as a prompt
    lines.push(v);
    lines.push(scenario + ': ' + v);
  }
}
// Repeat the set a few times (small corpora train better with the pattern seen
// often); the labelled/unlabelled mix stays balanced.
const corpus = (lines.join('\n') + '\n').repeat(40);

const outPath = join(ROOT, out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, corpus);
const words = corpus.split(/\s+/).filter(Boolean).length;
console.log(`✍️  microcopy corpus: ${lines.length} templates · ${words.toLocaleString()} words · ${(corpus.length / 1024).toFixed(1)} KB → ${out}`);
console.log('   scenarios:', Object.keys(T).join(', '));
console.log(`\nTrain it:\n  Actions → "Train browser LLM" → corpus_url = ${out.replace(/^llm-from-scratch\//, '')}, out_model = model-microcopy.json, tokenizer = bpe, block_size = 96, steps = 4000`);
