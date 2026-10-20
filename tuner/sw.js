/* Offline service worker for Tuner. One HTML file plus the engine, so
 * navigations are network-first (freshest build online, cached shell offline)
 * and same-origin static assets are cache-first for speed.
 *
 * Everything the app actually streams — playlists, Xtream Codes answers, HLS
 * manifests and segments, MP4 files, channel logos, the hls.js script — lives
 * on other origins and is deliberately left alone: this worker never
 * intercepts, caches or rewrites a cross-origin request, never caches a Range
 * request (media seeking must reach the server), and never caches a response
 * that is not a complete 200. Bump CACHE to force a clean reinstall. */
const CACHE = 'tuner-v1';
const ASSETS = ['./', './index.html', './engine.js', './manifest.json', './icon.svg',
                './icon-180.png', './icon-192.png', './icon-512.png'];

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

// Only a complete, successful, same-origin response is worth keeping
// (206 Partial Content is "ok" but must never be served as the whole file).
const cacheable = (res) => !!res && res.ok && res.status === 200 && res.type === 'basic';

function store(e, req, res) {
  if (!cacheable(res)) return res;
  const copy = res.clone();
  e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // streams, provider APIs, CDNs: not ours to touch
  if (req.headers.has('range')) return;            // partial media fetches go straight to the network
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => store(e, req, res))
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => store(e, req, res)))
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
