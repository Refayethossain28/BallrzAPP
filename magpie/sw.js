/* Offline service worker for Magpie. One HTML file + the engine, so navigations
 * AND engine.js are network-first (you always get the latest matching pair when
 * online, the cached copies when offline — a stale cached engine must never run
 * under a newer page) and the remaining static assets are cache-first for
 * speed. The fetch API (/api/) is never cached — live pages stay live. Bump
 * CACHE to force a clean reinstall. */
const CACHE = 'magpie-v1';
const ASSETS = ['./', './index.html', './engine.js', './manifest.json',
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
  const url = new URL(req.url);
  if (url.pathname.includes('/api/') || url.origin !== self.location.origin) return; // live data stays live

  const isPage = req.mode === 'navigate' ||
                 (req.destination === '' && /\/(index\.html)?(\?.*)?$/.test(url.pathname));
  const isEngine = /\/engine\.js$/.test(url.pathname);

  if (isPage || isEngine) {
    const cacheKey = isEngine ? './engine.js' : './index.html';
    e.respondWith(
      fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(cacheKey, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match(cacheKey)))
    );
    return;
  }

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

/* tap-to-update: activate the new version when the page asks */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
