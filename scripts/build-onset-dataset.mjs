#!/usr/bin/env node
/**
 * Cortex onset-dataset builder — turns a REAL, user-supplied conflict-onset CSV
 * (UCDP/PRIO or ACLED, downloaded under their licence) into an embeddable,
 * hash-pinned dataset for cortex/datasets.js.
 * ============================================================================
 *
 * WHY THIS EXISTS (read cortex/DATA.md): Proof-of-Learning needs every node to
 * recompute loss on byte-identical data, so datasets are embedded verbatim and
 * pinned by SHA-256 — never fetched at runtime. This project will NOT embed
 * conflict data it cannot verify, so there is no bundled onset dataset: you
 * bring the real file, this tool cleans it deterministically, prints the exact
 * bytes to paste into datasets.js, and prints the pinned hash to paste into the
 * test. Nothing here invents or downloads data.
 *
 * It computes the digest with the coin's own sha256 (coin/engine.js) so the
 * value it prints is byte-for-byte what scripts/test-cortex-logic.mjs will
 * assert — the canonical form matches the other real datasets exactly:
 *     features.map((f,i) => f.join(',') + '|' + labels[i]).join(';')  →  sha256
 *
 * USAGE:
 *   node scripts/build-onset-dataset.mjs <data.csv> [config.json] > onset.block.js
 *
 * The CSV must have a header row. Config (JSON) selects columns; defaults suit a
 * UCDP-style country-year file. All fields are optional:
 *   {
 *     "features": ["v2x_polyarchy","gdppc_log","pop_log","nb_conflict","prior_conflict"],
 *     "label":    "onset",          // column that is 0/1 or numeric (>threshold ⇒ 1)
 *     "threshold": 0,               // label > threshold ⇒ onset (1); default 0
 *     "name": "onset",
 *     "title": "Armed-conflict ONSET next period (UCDP/PRIO, REAL)",
 *     "source": "UCDP/PRIO Armed Conflict Dataset v<version> — ucdp.uu.se (downloaded <date>)",
 *     "labelName": "1 = new conflict onset, 0 = none",
 *     "round": 6                    // decimals to round each feature to
 *   }
 *
 * When the columns aren't obvious, run with no config to print the header and a
 * one-line preview, then write a config.json naming the columns you want.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

function loadCoin() {
  const box = { module: { exports: {} } }; box.self = box;
  vm.createContext(box);
  vm.runInContext(readFileSync(join(REPO, 'coin/engine.js'), 'utf8'), box, { filename: 'coin/engine.js' });
  return box.module.exports;
}

// Minimal RFC-ish CSV: handles quoted fields with commas; good enough for the
// tidy CSVs UCDP/ACLED export. Returns { header:[...], rows:[[...]] }.
function parseCsv(text) {
  const out = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.length > 0);
  for (const line of lines) {
    const fields = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
    fields.push(cur);
    out.push(fields.map((f) => f.trim()));
  }
  return { header: out[0] || [], rows: out.slice(1) };
}

function die(msg) { console.error('build-onset-dataset: ' + msg); process.exit(1); }

const csvPath = process.argv[2];
if (!csvPath) die('usage: node scripts/build-onset-dataset.mjs <data.csv> [config.json]');
const cfgPath = process.argv[3];
const cfg = cfgPath ? JSON.parse(readFileSync(resolve(cfgPath), 'utf8')) : {};

const { header, rows } = parseCsv(readFileSync(resolve(csvPath), 'utf8'));
if (!header.length) die('empty CSV (no header row found)');

// No config → show the shape and bail so the user can name columns honestly.
if (!cfg.features || !cfg.label) {
  console.error('CSV header (' + header.length + ' columns, ' + rows.length + ' data rows):');
  header.forEach((h, i) => console.error('  [' + i + '] ' + h));
  if (rows[0]) console.error('first row: ' + rows[0].join(' | '));
  die('write a config.json naming {"features":[...], "label":"..."} from the columns above, then re-run (see the header of this file).');
}

const idx = (name) => {
  const i = header.indexOf(name);
  if (i < 0) die('column "' + name + '" not in CSV header: ' + header.join(', '));
  return i;
};
const featIdx = cfg.features.map(idx);
const labIdx = idx(cfg.label);
const threshold = cfg.threshold ?? 0;
const round = cfg.round ?? 6;
const pow = Math.pow(10, round);

const features = [], labels = [];
let dropped = 0;
for (const r of rows) {
  const fv = featIdx.map((i) => Number(r[i]));
  const lvRaw = Number(r[labIdx]);
  if (fv.some((v) => !Number.isFinite(v)) || !Number.isFinite(lvRaw)) { dropped++; continue; }
  features.push(fv.map((v) => Math.round(v * pow) / pow));
  labels.push(lvRaw > threshold ? 1 : 0);
}
if (!features.length) die('no clean rows survived (every row had a non-numeric feature or label)');

const C = loadCoin();
const canon = features.map((f, i) => f.join(',') + '|' + labels[i]).join(';');
const sha = C.sha256(canon);
const positives = labels.filter((v) => v === 1).length;

const csvText = features.map((f, i) => f.join(',') + ',' + labels[i]).join('\n');
const name = cfg.name || 'onset';
const constName = name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_CSV';
const featNames = JSON.stringify(cfg.features);

// stats → stderr so stdout is a clean paste-able block
console.error('');
console.error('── ' + name + ' ────────────────────────────────────────────');
console.error('rows kept:       ' + features.length + (dropped ? '  (dropped ' + dropped + ' with missing/non-numeric values)' : ''));
console.error('features/row:    ' + features[0].length + '  ' + featNames);
console.error('onset (label=1): ' + positives + '  (' + (100 * positives / labels.length).toFixed(1) + '% — majority baseline ' + (100 * Math.max(positives, labels.length - positives) / labels.length).toFixed(1) + '%)');
console.error('PINNED SHA-256:  ' + sha);
console.error('');
console.error('NEXT STEPS (honest integrity, same as war/banknote/phishing):');
console.error('  1. Paste the block on stdout into cortex/datasets.js:');
console.error('       • the ' + constName + ' constant near the other *_CSV constants');
console.error('       • the DATASETS.' + name + ' entry inside the DATASETS object');
console.error('  2. Add a test in scripts/test-cortex-logic.mjs asserting:');
console.error("       assert.equal(C.sha256(canon), '" + sha + "');");
console.error('     (canon built exactly as above) plus rows=' + features.length + ', features=' + features[0].length + ', onset=' + positives + '.');
console.error('  3. To make it the LIVE task, set dataset:\'' + name + '\' in cortex/app.js + cortex/node.mjs and bump TASK_ID + sw.js CACHE.');
console.error('  Verify the SOURCE and LICENCE in cortex/DATA.md before shipping — this tool does not check provenance for you.');
console.error('');

// stdout: the paste-able block
process.stdout.write(
  '  // ' + (cfg.title || (name + ' (REAL, user-supplied)')) + '\n' +
  '  // Source: ' + (cfg.source || 'FILL IN — UCDP/PRIO or ACLED, version + download date; see cortex/DATA.md') + '\n' +
  '  // Built by scripts/build-onset-dataset.mjs from ' + csvPath + ' — SHA-256 ' + sha + '\n' +
  '  var ' + constName + ' = `\n' + csvText + '`;\n\n' +
  '  /* add inside the DATASETS object:\n' +
  '    ' + name + ': {\n' +
  '      name: ' + JSON.stringify(name) + ',\n' +
  '      title: ' + JSON.stringify(cfg.title || (name + ' (REAL)')) + ',\n' +
  '      source: ' + JSON.stringify(cfg.source || 'FILL IN — see cortex/DATA.md') + ',\n' +
  '      featureNames: ' + featNames + ',\n' +
  '      labelName: ' + JSON.stringify(cfg.labelName || '1 = onset, 0 = none') + ',\n' +
  '      csv: ' + constName + '\n' +
  '    },\n' +
  '  */\n'
);
