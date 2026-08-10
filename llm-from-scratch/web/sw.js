/* Offline service worker for "My Own AI Model".
 * The page and the JS inference engine are static; the model is RETRAINABLE —
 * the train-llm workflow commits a new model.json whenever the model is
 * retrained (now one dispatch away, on any Magpie-scraped corpus). So:
 *  - navigations and model.json are network-first (you get the latest build
 *    and the latest WEIGHTS when online, the cached copies when offline —
 *    cache-first weights would pin every prior visitor to a stale model
 *    forever),
 *  - everything else (gpt.js, icons) is cache-first for speed and full
 *    offline use — once loaded, the whole model runs with no network.
 * Bump CACHE to force a clean reinstall. */
const CACHE = 'my-ai-model-v2';
const ASSETS = ['./', './index.html', './gpt.js', './model.json', './manifest.json',
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
  const isPage = req.mode === 'navigate' ||
                 (req.destination === '' && /\/(index\.html)?(\?.*)?$/.test(new URL(req.url).pathname));
  const isModel = /\/model\.json$/.test(new URL(req.url).pathname);

  if (isPage || isModel) {
    const cacheKey = isModel ? './model.json' : './index.html';
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
