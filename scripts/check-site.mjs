#!/usr/bin/env node
/**
 * Deploy-integrity check for the assembled GitHub Pages site.
 *
 * Why: the Pages workflow ships an explicit allowlist of files, and history
 * shows what happens when it drifts — /concierge/ 404ed after launch, four
 * landing-page apps 404ed for weeks, and the splash videos silently vanished.
 * This walks every .html / .json (manifest) file in the assembled site,
 * extracts its LOCAL references (src/href/poster attributes, CSS url(...),
 * manifest icon/start_url entries) and fails if any target doesn't exist.
 *
 * Only static references are checked. Dynamic/templated paths (anything with
 * ${...}, quotes-in-JS concatenation etc.) and external URLs are skipped, as
 * are /apex/ and /llm/ (built and appended separately by the Pages workflow).
 *
 * Usage: node scripts/check-site.mjs [sitedir]   (default: _site)
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';

const SITE = resolve(process.argv[2] || '_site');
// roots that are appended by later build steps — not present in a fast assemble
const BUILT_LATER = ['apex/', 'llm/'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Local references in an HTML document (static attributes + CSS url()). */
function htmlRefs(text) {
  const refs = [];
  const attr = /(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attr.exec(text)) !== null) refs.push(m[1]);
  const cssUrl = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = cssUrl.exec(text)) !== null) refs.push(m[1]);
  return refs;
}

/** Icon/start_url references in a web-app manifest. */
function manifestRefs(text) {
  try {
    const j = JSON.parse(text);
    const refs = [];
    for (const icon of j.icons || []) if (icon.src) refs.push(icon.src);
    if (j.start_url) refs.push(j.start_url);
    return refs;
  } catch { return []; }
}

// the site is served under this base path on GitHub Pages; manifests use it
const BASE = '/BallrzAPP';
const ASSET_EXT = /\.(html?|m?js|css|png|jpe?g|gif|svg|webp|mp4|webm|json|webmanifest|ico|txt|md|pdf|woff2?)$/i;

function isCheckable(ref) {
  if (!ref) return false;
  if (/^(https?:)?\/\//i.test(ref)) return false;               // external
  if (/^(data:|mailto:|tel:|javascript:|blob:|#|%23)/i.test(ref)) return false;
  // JS expressions the attribute regex over-matches inside inline scripts
  if (/[(){}\[\]$,\s]/.test(ref) || ref.includes('+')) return false;
  // only asset-shaped paths: a directory, a path with a slash, or a known extension
  const bare = ref.split('?')[0].split('#')[0];
  if (!(bare.endsWith('/') || bare.includes('/') || ASSET_EXT.test(bare))) return false;
  if (bare.includes('.') && !bare.includes('/') && !ASSET_EXT.test(bare) && !bare.endsWith('/')) return false;
  return true;
}

const problems = [];
let checked = 0;

for (const file of walk(SITE)) {
  const ext = extname(file);
  let refs = [];
  if (ext === '.html') refs = htmlRefs(readFileSync(file, 'utf8'));
  else if (ext === '.json' && /manifest/.test(file)) refs = manifestRefs(readFileSync(file, 'utf8'));
  else continue;

  for (const raw of refs) {
    if (!isCheckable(raw)) continue;
    const ref = raw.split('?')[0].split('#')[0];
    if (!ref) continue;
    // resolve relative to the referencing file; leading / is site-root
    // (with the GitHub Pages base path stripped when present)
    const rooted = ref.startsWith(BASE + '/') ? ref.slice(BASE.length) : ref;
    let target = rooted.startsWith('/')
      ? join(SITE, rooted)
      : resolve(dirname(file), rooted);
    if (!target.startsWith(SITE)) continue;                     // escapes the site
    const rel = target.slice(SITE.length + 1).replace(/\\/g, '/');
    if (BUILT_LATER.some((b) => rel === b.replace(/\/$/, '') || rel.startsWith(b))) continue;
    checked++;
    const ok = existsSync(target) &&
      (statSync(target).isFile() || existsSync(join(target, 'index.html')));
    if (!ok) {
      problems.push(file.slice(SITE.length + 1) + ' → ' + raw);
    }
  }
}

if (problems.length) {
  console.error('✗ ' + problems.length + ' broken local reference(s) in the assembled site:');
  for (const p of problems) console.error('   ' + p);
  console.error('\nFix scripts/assemble-site.sh (or the referencing page).');
  process.exit(1);
}
console.log('✓ site check: ' + checked + ' local references verified, none broken');
