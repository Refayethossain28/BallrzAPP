#!/usr/bin/env node
/**
 * Bundles the live Atlas app (../atlas) into www/ for the native iOS build.
 * The app ships INSIDE the binary — App Review sees a real local app, not a
 * thin wrapper around a URL — and still talks to the same tile/routing/search
 * services at runtime.
 *
 * Two adjustments for the native shell:
 *  - the service worker registration is dropped (the shell IS the offline
 *    app shell; Capacitor serves from disk, and SW scope on capacitor://
 *    is unreliable) — the in-app offline tile packs still work because they
 *    cache into the Cache API directly from page context
 *  - a `window.ATLAS_NATIVE = true` flag is injected before any script so
 *    the app can adapt (e.g. hide web-payment UI per App Store rule 3.1.1)
 */
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'atlas');
const OUT = join(HERE, 'www');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const f of ['index.html', 'engine.js', 'config.js', 'manifest.json',
                 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png']) {
  cpSync(join(SRC, f), join(OUT, f));
}
if (existsSync(join(SRC, 'screenshots'))) cpSync(join(SRC, 'screenshots'), join(OUT, 'screenshots'), { recursive: true });

let html = readFileSync(join(OUT, 'index.html'), 'utf8');
html = html.replace('<head>', '<head>\n<script>window.ATLAS_NATIVE = true;</script>');
html = html.replace("navigator.serviceWorker.register('sw.js');", '/* SW skipped in native shell */');
writeFileSync(join(OUT, 'index.html'), html);

console.log('www/ bundled from ../atlas (native flag injected, SW registration disabled)');
