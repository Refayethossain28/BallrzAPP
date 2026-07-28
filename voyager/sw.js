/* Offline service worker for Voyager. One HTML file + the engine, so
 * navigations are network-first (you always get the latest build when online,
 * the cached shell when offline) and static assets are cache-first for speed —
 * the browser itself opens even with no connection; only the web needs a
 * network. Bump CACHE to force a clean reinstall. */
const CACHE = 'voyager-v9'; // v9: highlights + follow sites (feeds)
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
  const path = new URL(req.url).pathname;
  // Full-browser proxy traffic is never cached or shell-fallen-back — it must
  // always hit the live server and return the real page.
  if (path === '/proxy' || path === '/reader' || path === '/feeds' || path.startsWith('/__voyager')) return;
  // Only our own shell is cached — the pages the user browses to belong to
  // their sites and go straight to the network, untouched.
  if (new URL(req.url).origin !== self.location.origin) return;
  const isPage = req.mode === 'navigate' ||
                 (req.destination === '' && /\/(index\.html)?(\?.*)?$/.test(new URL(req.url).pathname));

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
