/* Offline service worker for Argus. The shell (page, engine, coastlines,
 * icons) is precached so the globe, the bundled satellite catalogue and the
 * simulation work with no signal; navigations are network-first so a fresh
 * build wins when online. Live feeds (OpenSky, USGS, CelesTrak, adsb.lol,
 * AISStream, FIRMS, wheretheiss.at) are cross-origin and pass straight
 * through — they are never cached. Bump CACHE to force a clean reinstall. */
const CACHE = 'argus-v1';
const ASSETS = ['./', './index.html', './engine.js', './land.js', './manifest.json',
                './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
  if (url.origin !== location.origin) return; // live feeds pass through untouched
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    }))
  );
});

self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
