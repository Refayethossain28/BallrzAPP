/* Offline service worker for Ultra. One HTML file plus the engine, so
 * navigations are network-first (freshest build online, cached shell offline)
 * and static assets are cache-first for speed. Bump CACHE to force a clean
 * reinstall. */
const CACHE = 'ultra-v8';
// The EmulatorJS framework + cores under emujs/ are large and runtime-cached on
// first use, not precached here (cache.addAll is atomic — one 404 empties the
// shell, and 4 MB of cores shouldn't block install).
const ASSETS = ['./', './index.html', './play.html', './engine.js', './dc-engine.js',
                './manifest.json', './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // Navigations AND our own code (.js) go network-first, so a fresh deploy's
  // engine/UI reaches the page on the next online load instead of waiting for
  // the cache version to cascade; static assets stay cache-first for speed.
  const networkFirst = e.request.mode === 'navigate' || /\.js(\?|$)/.test(url.pathname);
  if (networkFirst) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }))
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
