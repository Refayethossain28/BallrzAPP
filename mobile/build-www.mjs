#!/usr/bin/env node
/**
 * Assembles a Capacitor `www/` folder for one ApexVIP app from the repo's source.
 *
 * The apps are single self-contained HTML files that load a few shared JS files
 * and icons by relative path, so a flat www/ (the app HTML renamed to index.html
 * + those assets) runs offline in the iOS WKWebView. Firebase/Leaflet/Square load
 * from their CDNs at runtime, as they do on the web.
 *
 * Usage:  node build-www.mjs client|driver
 */
import { copyFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const app = process.argv[2];
if (!['client', 'driver'].includes(app)) {
  console.error('usage: node build-www.mjs client|driver');
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');            // repo root
const OUT = join(HERE, app, 'www');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const cp = (src, dest = src) => {
  if (existsSync(join(REPO, src))) copyFileSync(join(REPO, src), join(OUT, dest));
};

// App shell → index.html
cp(`apexvip-${app}.html`, 'index.html');
// Shared engine, config, and service worker
['apexvip-core.js', 'apexvip-lib.js', 'firebase.js', 'firebase-messaging-sw.js'].forEach((f) => cp(f));
// Manifests
['manifest.json', `manifest-${app}.json`].forEach((f) => cp(f));
// Icons + splash video (best-effort)
readdirSync(REPO).filter((f) => /^icon-.*\.png$/.test(f)).forEach((f) => cp(f));
['splash-bg.mp4', 'apple-touch-icon.png'].forEach((f) => cp(f));

console.log(`✓ assembled ${OUT}`);
