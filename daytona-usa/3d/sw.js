// Service worker: makes the game installable + playable offline.
// Network-first (so updates land), with a cache fallback that ignores the
// ?v= cache-buster so a freshly-requested game3d.js?v=NEW still resolves offline.
const CACHE = 'apexgp-v1';
const SHELL = ['./','./index.html','./game3d.js','./applemusic.js','../music.js',
               './vendor/three.module.js','./manifest.webmanifest','./icon.svg'];

self.addEventListener('install', e=>{
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, {cache:'reload'}))).catch(()=>{}))
      .then(()=>self.skipWaiting())
  );
});
self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener('fetch', e=>{
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith((async ()=>{
    try {
      const net = await fetch(req);
      try { if (new URL(req.url).origin === location.origin){ const c=await caches.open(CACHE); c.put(req, net.clone()); } } catch(_){}
      return net;
    } catch(err) {
      const c = await caches.open(CACHE);
      const hit = await c.match(req, {ignoreSearch:true}) || await c.match('./index.html');
      if (hit) return hit;
      throw err;
    }
  })());
});
