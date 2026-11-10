/* Offline service worker for Furqan. The shell (page, engine, icons) is
 * cache-first for speed; the page itself and quran.json are network-first so
 * a corrected text or a new build reaches returning visitors, with the cached
 * copies used offline. Once loaded, the whole Qur'an and the search engine run
 * with no network at all. Bump CACHE to force a clean reinstall. */
const CACHE = 'furqan-v1';
const ASSETS = ['./', './index.html', './engine.js', './quran.json', './manifest.json', './fonts/AmiriQuran-Regular.ttf',
                './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
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
  if (url.origin !== location.origin) return;   // the Live AI proxy is never cached
  const path = url.pathname;
  const isPage = e.request.mode === 'navigate' || /\/(index\.html)?$/.test(path);
  const isText = /\/quran\.json$/.test(path);
  if (isPage || isText) {
    const key = isText ? './quran.json' : './index.html';
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match(key)))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => undefined))
  );
});

/* tap-to-update: activate the new version when the page asks */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
