/* Offline service worker for Omni. The app is one HTML file, so we use
 * network-first for page navigations — when online you always get the latest
 * build (no more stuck-on-an-old-cache after a fix), falling back to the cache
 * when offline. Static assets (icons/manifest) stay cache-first for speed.
 * Bump CACHE to force a clean reinstall. */
const CACHE = 'omni-v2';
const ASSETS = ['./', './index.html', './manifest.json',
                './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png'];

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
  const req = e.request;
  const isPage = req.mode === 'navigate' ||
                 (req.destination === '' && /\/(index\.html)?(\?.*)?$/.test(new URL(req.url).pathname));

  if (isPage) {
    // network-first: latest when online, cached shell when offline
    e.respondWith(
      fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // cache-first for everything else
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => undefined)
    )
  );
});
