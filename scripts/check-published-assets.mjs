#!/usr/bin/env node
/**
 * Published-asset gate — catches the "referenced but never published" class of
 * bug that shipped twice: apexvip-engine.js missing from the Pages assembly
 * (window.ApexEngine 404'd for every visitor) and a nonexistent
 * apexvip-dubai.html in the service-worker precache (cache.addAll is atomic,
 * so one 404 silently emptied the offline shell).
 *
 * Checks, against the repo tree:
 *  1. every URL in firebase-messaging-sw.js OFFLINE_URLS exists;
 *  2. every local script/link/img/video/source src+href referenced by the
 *     ApexVIP app pages exists;
 *  3. the assets those pages need are actually copied by pages.yml.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const fail = [];
const ok = (msg) => console.log('  ✓ ' + msg);

// ── 1. Service-worker precache ───────────────────────────────────────────────
const sw = readFileSync(resolve(root, 'firebase-messaging-sw.js'), 'utf8');
const urls = [...sw.matchAll(/'\/BallrzAPP\/([^']+)'/g)].map((m) => m[1]);
if (!urls.length) fail.push('OFFLINE_URLS not found in firebase-messaging-sw.js');
for (const u of urls) {
  if (existsSync(resolve(root, u))) ok(`precache: ${u}`);
  else fail.push(`firebase-messaging-sw.js precaches /BallrzAPP/${u} but ${u} does not exist in the repo — cache.addAll() is atomic, this single 404 empties the offline shell`);
}

// ── 2. Local assets referenced by the app pages ──────────────────────────────
const PAGES = ['apexvip-client.html', 'apexvip-driver.html', 'apexvip-admin.html', 'index.html'];
// Built during the Pages workflow itself (Vite build / LLM export) — present on
// the published site but not in the repo tree.
const BUILT_IN_WORKFLOW = new Set(['apex/', 'llm/']);
const ATTR = /(?:src|href)="([^"#?]+)(?:[?#][^"]*)?"/g;
for (const page of PAGES) {
  const html = readFileSync(resolve(root, page), 'utf8');
  const seen = new Set();
  for (const [, ref] of html.matchAll(ATTR)) {
    if (/^(https?:|data:|mailto:|tel:|javascript:|\/\/|#|\{|\$)/.test(ref)) continue;
    if (ref.includes('${')) continue; // template-built URL — not statically checkable
    if (BUILT_IN_WORKFLOW.has(ref)) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (!existsSync(resolve(root, ref.replace(/^\.\//, '')))) {
      fail.push(`${page} references "${ref}" which does not exist in the repo`);
    }
  }
  ok(`${page}: ${seen.size} local refs checked`);
}

// ── 3. pages.yml copies what the apps load ───────────────────────────────────
const pagesYml = readFileSync(resolve(root, '.github/workflows/pages.yml'), 'utf8');
const MUST_PUBLISH = ['apexvip-engine.js', 'apexvip-core.js', 'apexvip-lib.js', 'firebase.js', 'firebase-messaging-sw.js'];
for (const f of MUST_PUBLISH) {
  if (pagesYml.includes(f)) ok(`pages.yml publishes ${f}`);
  else fail.push(`pages.yml does not copy ${f} into _site — the live site will 404 it`);
}

if (fail.length) {
  console.error('\nPublished-asset check FAILED:');
  for (const f of fail) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('\nAll published-asset checks passed.');
