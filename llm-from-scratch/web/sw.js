/* Offline service worker for "ApexAI".
 * The page and the JS inference engine are static; the model is RETRAINABLE —
 * the train-llm workflow (or a local export) commits a new model.json. So:
 *  - navigations and every model*.json are network-first (you get the latest
 *    build and the latest WEIGHTS when online, the cached copies when offline —
 *    cache-first weights would pin every prior visitor to a stale model
 *    forever). The model is NOT precached: the page's own fetch stores it, so
 *    a first visit downloads it once, not twice.
 *  - everything else (gpt.js?v=N, icons) is cache-first for speed and full
 *    offline use — once loaded, the whole model runs with no network. The
 *    engine URL carries a version so a page update never runs with a stale
 *    cached engine.
 * Bump CACHE to force a clean reinstall. */
const CACHE = 'apexai-v3';
const ASSETS = ['./', './index.html', './gpt.js?v=2', './manifest.json',
                './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    // Best-effort: don't fail the whole install if one optional asset is missing.
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
  const req = e.request;
  const path = new URL(req.url).pathname;
  const isPage = req.mode === 'navigate' ||
                 (req.destination === '' && /\/(index\.html)?(\?.*)?$/.test(path));
  // every model file — the default and the niche ones (model-names.json, …)
  const isModel = /\/model[^/]*\.json$/.test(path);

  if (isPage || isModel) {
    const cacheKey = isModel ? './' + path.split('/').pop() : './index.html';
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
