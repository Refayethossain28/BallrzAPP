/* TimeCoin service worker — makes the app installable and usable offline.
 *
 * Strategy is deliberately update-friendly (the app changes often and users have
 * hit stale caches before):
 *   • navigations  → network-first, fall back to cache when offline
 *   • static files → stale-while-revalidate (instant load, refresh in background)
 *   • everything else (relay polling: /msgs, /msg, /status, and any non-GET or
 *     cross-origin request) is passed straight through, never cached.
 * Bump CACHE to force every client onto a fresh shell.
 */
var CACHE = 'ballrzcoin-v15';
var SHELL = ['./', './index.html', './mine.html', './join.html', './engine.js', './mutual.js', './reputation.js', './bridge.js', './config.js', './qr.js', './wordlist.js', './i18n.js',
  './SAFETY.md', './icon-192.png', './icon-512.png', './manifest.webmanifest',
  './miner.webmanifest', './miner-icon-192.png', './miner-icon-512.png', './miner-icon-180.png'];

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

function isShellRequest(req, url) {
  if (req.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  // Never touch the relay endpoints.
  if (/\/(msgs?|status)(\?|$)/.test(url.pathname)) return false;
  return /\.(html|js|css|png|webmanifest|svg|md)$/.test(url.pathname) || url.pathname.endsWith('/');
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);

  // Navigations: network-first so a new deploy shows up immediately; cache is the
  // offline safety net.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (m) { return m || caches.match('./'); });
      })
    );
    return;
  }

  if (!isShellRequest(req, url)) return; // let the network handle everything else

  // Static assets: stale-while-revalidate.
  e.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
