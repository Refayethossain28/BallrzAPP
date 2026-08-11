#!/usr/bin/env node
/**
 * Build an LLM training corpus from the live internet — Magpie feeds
 * "ApexAI".
 *
 * Crawls from one or more seed URLs with the same unit-tested machinery the
 * Magpie scraper uses (magpie/engine.js in a vm sandbox): tolerant HTML
 * parsing, readable-prose extraction (extractArticle — paragraphs, headings,
 * quotes; nav/footer chrome and boilerplate crumbs dropped), link discovery,
 * URL canonicalisation, and the Robots Exclusion Protocol. The result is one
 * plain-text UTF-8 file ready for llm-from-scratch/train.py.
 *
 *     node scripts/build-web-corpus.mjs https://en.wikipedia.org/wiki/Magpie \
 *         --pages 40 --out llm-from-scratch/data/web.txt
 *
 *     # then train the browser model on it (locally…)
 *     cd llm-from-scratch && python train.py --data data/web.txt --tokenizer bpe --steps 5000
 *     # …or commit data/web.txt and dispatch the "Train browser LLM" workflow
 *     # with corpus_url = data/web.txt
 *
 * Flags:
 *   --pages N      page budget, 1..500                     (default 30)
 *   --out FILE     output corpus path      (default llm-from-scratch/data/web.txt)
 *   --any-host     follow links off the seed hosts too     (default: same hosts only)
 *   --delay MS     politeness delay between fetches        (default 1000)
 *   --min-words N  skip pages with fewer readable words    (default 60)
 *
 * Honesty & safety — identical posture to the Magpie servers: MagpieBot UA,
 * robots.txt fetched per-origin and enforced, SSRF guard on every URL
 * (hostname and resolved IP; MAGPIE_ALLOW_PRIVATE=1 lifts it for local
 * fixture testing only), HTML only, 1.5 MB per page, one page per delay.
 * Zero dependencies — Node built-ins only.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lookup } from 'node:dns/promises';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'MagpieBot/1.0 (+https://refayethossain28.github.io/BallrzAPP/magpie/; a from-scratch prototype scraper)';
const ALLOW_PRIVATE = process.env.MAGPIE_ALLOW_PRIVATE === '1';
const MAX_BYTES = 1.5 * 1024 * 1024;

/* ---- the Magpie engine (repo is type:module) ---- */
const sandbox = { module: { exports: {} }, URL };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'magpie', 'engine.js'), 'utf8'), sandbox, { filename: 'magpie/engine.js' });
const E = sandbox.module.exports;

/* ---- args ---- */
const seeds = [];
let pagesCap = 30, out = join('llm-from-scratch', 'data', 'web.txt');
let sameHost = true, delayMs = 1000, minWords = 60;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--pages') pagesCap = Math.max(1, Math.min(500, parseInt(argv[++i], 10) || 30));
  else if (a === '--out') out = argv[++i];
  else if (a === '--any-host') sameHost = false;
  else if (a === '--delay') delayMs = Math.max(0, parseInt(argv[++i], 10) || 1000);
  else if (a === '--min-words') minWords = Math.max(0, parseInt(argv[++i], 10) || 60);
  else if (a.startsWith('--')) { console.error(`unknown flag ${a}`); process.exit(2); }
  else seeds.push(a);
}
if (!seeds.length) {
  console.error('usage: node scripts/build-web-corpus.mjs <seed-url> [more-seeds…] [--pages N] [--out FILE]');
  process.exit(2);
}

/* ---- SSRF guard (same posture as magpie/server.mjs) ---- */
function isBlockedHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || /(^|\.)localhost$/.test(h) || /\.local$/.test(h)) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}
async function assertPublic(url) {
  if (ALLOW_PRIVATE) return;
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s)');
  if (isBlockedHost(u.hostname)) throw new Error('private/internal host refused');
  try {
    const { address } = await lookup(u.hostname);
    if (isBlockedHost(address)) throw new Error('host resolves to a private address');
  } catch (e) {
    if (/private/.test(String(e.message))) throw e;
    throw new Error('DNS lookup failed');
  }
}

/* ---- polite fetching with robots.txt ---- */
function timedFetch(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  return fetch(url, {
    signal: ctl.signal, redirect: 'follow',
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
  }).finally(() => clearTimeout(t));
}
const robotsCache = new Map();
async function robotsAllows(url) {
  const origin = new URL(url).origin;
  if (!robotsCache.has(origin)) {
    let rules = [];
    try {
      const r = await timedFetch(origin + '/robots.txt');
      if (r.ok) rules = E.parseRobots(await r.text());
    } catch { /* unreachable robots.txt = allowed */ }
    robotsCache.set(origin, rules);
  }
  const u = new URL(url);
  return E.robotsAllowed(robotsCache.get(origin), UA, u.pathname + u.search);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- the crawl ---- */
const hosts = new Set();
const queue = [];
const seen = new Set();
for (const s of seeds) {
  const norm = E.normalizeUrl(s);
  if (!norm) { console.error(`skipping unparseable seed: ${s}`); continue; }
  hosts.add(new URL(norm).hostname);
  if (!seen.has(norm)) { seen.add(norm); queue.push(norm); }
}
if (!queue.length) { console.error('no usable seeds'); process.exit(2); }

const docs = [];
let fetched = 0, skippedRobots = 0, skippedThin = 0, failed = 0;

while (queue.length && fetched < pagesCap) {
  const url = queue.shift();
  try {
    await assertPublic(url);
    if (!(await robotsAllows(url))) { skippedRobots++; continue; }
    const r = await timedFetch(url);
    fetched++;
    const ct = String(r.headers.get('content-type') || '');
    if (!r.ok || !/text\/html|application\/xhtml\+xml/i.test(ct)) { failed++; continue; }
    const html = Buffer.from(await r.arrayBuffer()).subarray(0, MAX_BYTES).toString('utf8');
    const finalUrl = E.normalizeUrl(r.url) || url;
    const doc = E.parseHTML(html);
    const art = E.extractArticle(doc);
    if (art.words >= minWords) {
      docs.push({ url: finalUrl, title: art.title, text: art.text, words: art.words });
      console.log(`  ✓ ${finalUrl}  (${art.words} words)`);
    } else {
      skippedThin++;
      console.log(`  · ${finalUrl}  (thin — ${art.words} words, skipped)`);
    }
    // discover more pages
    for (const link of E.extractLinks(doc, finalUrl)) {
      const norm = E.normalizeUrl(link.url);
      if (!norm || seen.has(norm)) continue;
      if (sameHost && !hosts.has(new URL(norm).hostname)) continue;
      seen.add(norm);
      queue.push(norm);
    }
    if (queue.length && fetched < pagesCap) await sleep(delayMs);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${url}  (${e && e.message || e})`);
  }
}

/* ---- write the corpus ---- */
if (!docs.length) {
  console.error('\nno readable pages collected — corpus not written');
  process.exit(1);
}
// dedupe whole documents (mirrors/redirect twins), normalise whitespace
const bodySeen = new Set();
const parts = [];
for (const d of docs) {
  const key = E.contentHash(d.text);
  if (bodySeen.has(key)) continue;
  bodySeen.add(key);
  parts.push(`= ${d.title || d.url} =\n\n${d.text}\n`);
}
const corpus = parts.join('\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n');
const outPath = join(ROOT, out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, corpus);

const words = corpus.split(/\s+/).filter(Boolean).length;
console.log(`\n🐦‍⬛ corpus: ${parts.length} pages · ${words.toLocaleString()} words · ${(corpus.length / 1024).toFixed(1)} KB → ${out}`);
console.log(`   (crawl: ${fetched} fetched, ${skippedRobots} blocked by robots.txt, ${skippedThin} thin, ${failed} failed)`);
console.log(`\nTrain on it:\n  cd llm-from-scratch && python train.py --data ${out.replace(/^llm-from-scratch\//, '')} --tokenizer bpe --steps 5000`);
console.log(`  …or commit ${out} and dispatch the "Train browser LLM" workflow with corpus_url = data/web.txt`);
