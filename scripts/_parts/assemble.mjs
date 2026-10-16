#!/usr/bin/env node
// Dev-only assembler: concatenates aerial/_parts/*.js (sorted) into aerial/engine.js
// with the house IIFE wrapper. Run: node scripts/_parts/assemble.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PARTS = join(ROOT, 'aerial', '_parts');
const files = readdirSync(PARTS).filter(f => f.endsWith('.js')).sort();
const ORDER = ['UTIL', 'TS', 'MP4', 'HLS', 'RADIO', 'PODCAST', 'LIBRARY'];
const header = readFileSync(join(PARTS, 'HEADER.txt'), 'utf8');
let body = '';
for (const f of files) body += readFileSync(join(PARTS, f), 'utf8').replace(/\s+$/, '') + '\n\n';
const present = ORDER.filter(n => new RegExp('^var ' + n + ' = \\(function', 'm').test(body));
const out = header
  + '(function (root) {\n  \'use strict\';\n\n'
  + body.split('\n').map(l => (l ? '  ' + l : l)).join('\n')
  + '  var E = {};\n'
  + present.map(n => `  Object.keys(${n}).forEach(function (k) { if (E.hasOwnProperty(k)) throw new Error('AerialEngine: duplicate export ' + k + ' in ${n}'); E[k] = ${n}[k]; });\n`).join('')
  + present.map(n => `  E.${n.toLowerCase()} = ${n};\n`).join('')
  + '\n  if (typeof module !== \'undefined\' && module.exports) module.exports = E;\n'
  + '  root.AerialEngine = E;\n'
  + '})(typeof self !== \'undefined\' ? self : this);\n';
writeFileSync(join(ROOT, 'aerial', 'engine.js'), out);
console.log(`aerial/engine.js assembled from ${files.length} part(s): ${present.join(', ')} (${out.length} bytes)`);
