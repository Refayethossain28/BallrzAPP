/* Cortex service worker — makes the app installable and usable offline.
 *
 * Adapted from the TimeCoin worker (coin/sw.js), same update-friendly strategy:
 *   • navigations  → network-first, fall back to the cached page when offline
 *   • static shell → stale-while-revalidate (instant load, refresh in background)
 *   • the RELAY IS NEVER CACHED: /msg, /msgs, /status and any non-GET or
 *     cross-origin request pass straight through — consensus traffic must be live.
 * Offline you can open the app and see your chain (it lives in localStorage);
 * mining works locally and gossips when you're back online.
 * Bump CACHE to force clients onto a fresh shell.
 */
var CACHE = 'cortex-v5';
var SHELL = ['./', './index.html', './app.html', './mine.html', './wallet.html', './guide.html', './network.html',
  './engine.js', './datasets.js', './net.js', './keystore.js', './app.js',
  './holdout.js', './tournament.js', './prover.js',
  '../coin/engine.js',
  './cortex.webmanifest', './mine.webmanifest', './wallet.webmanifest',
  './cortex-icon-192.png', './cortex-icon-512.png', './cortex-icon-maskable-512.png', './cortex-icon-180.png',
  './mine-icon-192.png', './mine-icon-512.png', './mine-icon-maskable-512.png', './mine-icon-180.png',
  './wallet-icon-192.png', './wallet-icon-512.png', './wallet-icon-maskable-512.png', './wallet-icon-180.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isRelayPath(pathname) { return /\/(msgs?|status)(\?|$)/.test(pathname); }
function isShellRequest(req, url) {
  if (req.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  if (isRelayPath(url.pathname)) return false; // never touch consensus traffic
  return /\.(html|js|css|png|webmanifest|svg|md|json)$/.test(url.pathname) || url.pathname.endsWith('/');
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);

  // Navigations: network-first so a new deploy shows immediately; the cached
  // copy of the SAME page (mine vs wallet) is the offline fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (m) { return m || caches.match('./index.html'); });
      })
    );
    return;
  }

  // Static shell: stale-while-revalidate.
  if (isShellRequest(req, url)) {
    e.respondWith(
      caches.match(req).then(function (cached) {
        var refresh = fetch(req).then(function (res) {
          if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
          return res;
        }).catch(function () { return cached; });
        return cached || refresh;
      })
    );
  }
  // Everything else (relay polling, POSTs, cross-origin): straight through.
});
