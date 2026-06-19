/* Offline service worker for Lingua. The app shell is a single HTML file plus
 * icons, so navigations are network-first (latest build when online, cached
 * shell when offline) and static assets are cache-first for speed.
 * The /ai and /health proxy calls are never cached. Bump CACHE to reinstall. */
const CACHE = 'lingua-v1';
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
  const url = new URL(e.request.url);
  if (url.pathname === '/ai' || url.pathname === '/health') return; // never cache AI calls

  const req = e.request;
  const isPage = req.mode === 'navigate' ||
                 (req.destination === '' && /\/(index\.html)?(\?.*)?$/.test(url.pathname));

  if (isPage) {
    e.respondWith(
      fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
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
