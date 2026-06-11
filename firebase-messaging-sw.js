// ApexVIP Service Worker — Push Notifications + Offline PWA shell
// Version 2.0

const CACHE_NAME = 'apexvip-v2';
const OFFLINE_URLS = [
  '/BallrzAPP/apexvip-client.html',
  '/BallrzAPP/apexvip-dubai.html',
  '/BallrzAPP/apexvip-core.js',
  '/BallrzAPP/manifest.json',
];

// ── Install: pre-cache the app shell ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(OFFLINE_URLS).catch(() => {})
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for HTML/JS, cache fallback for offline ─────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.pathname.includes('/BallrzAPP/')) return;

  event.respondWith(
    fetch(event.request)
      .then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Offline Booking Queue ─────────────────────────────────────────────────────
const QUEUE_KEY = 'apexvip_offline_bookings';

// Register background sync when a booking is queued
self.addEventListener('sync', event => {
  if (event.tag === 'booking-sync') {
    event.waitUntil(flushBookingQueue());
  }
});

async function flushBookingQueue() {
  const db = await openQueueDB();
  const tx = db.transaction('queue', 'readwrite');
  const store = tx.objectStore('queue');
  const all = await storeGetAll(store);

  for (const entry of all) {
    try {
      const resp = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.data),
      });
      if (resp.ok) {
        await store.delete(entry.id);
        // Notify the client that the queued booking went through
        const wins = await clients.matchAll({ type: 'window' });
        wins.forEach(w => w.postMessage({ type: 'BOOKING_QUEUED_SYNCED', ref: entry.data.ref }));
      }
    } catch(e) {
      console.warn('Queue flush failed for', entry.id, e.message);
    }
  }
}

function openQueueDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('apexvip-queue', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function storeGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

// Listen for messages from the main app to queue bookings
self.addEventListener('message', event => {
  if (event.data?.type === 'QUEUE_BOOKING') {
    openQueueDB().then(db => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').add({ data: event.data.booking, queuedAt: Date.now() });
      // Request background sync
      self.registration.sync?.register('booking-sync').catch(() => {});
    });
  }
});

// ── Firebase Cloud Messaging ──────────────────────────────────────────────────
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// NOTE: This config is intentionally public (it's the Firebase SDK config, not a secret)
firebase.initializeApp({
  apiKey: "AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI",
  authDomain: "apexvip-1b4a9.firebaseapp.com",
  projectId: "apexvip-1b4a9",
  messagingSenderId: "254410067879",
  appId: "1:254410067879:web:754b71a35182c997f37082"
});

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  const screen = payload.data?.screen || 'home';

  self.registration.showNotification(title || 'ApexVIP', {
    body: body || '',
    icon: '/BallrzAPP/icon-192.png',
    badge: '/BallrzAPP/icon-192.png',
    data: { screen },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' }
    ],
    vibrate: [200, 100, 200],
  });
});

// Click handler — focus or open the app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const screen = event.notification.data?.screen || 'home';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      if (wins.length > 0) {
        wins[0].focus();
        wins[0].postMessage({ type: 'NAVIGATE', screen });
      } else {
        clients.openWindow('/BallrzAPP/apexvip-client.html');
      }
    })
  );
});
