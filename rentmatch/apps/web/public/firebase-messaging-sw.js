/* Firebase Cloud Messaging service worker for Web Push background messages.
 *
 * FCM requires this file at the web root. Fill in the same Firebase config the
 * app uses (the compat builds are what the messaging SW expects). Without it,
 * `registerForPush()` resolves to false and the app continues without push. */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  // TODO: mirror your VITE_FIREBASE_* values here at build/deploy time.
  apiKey: '',
  authDomain: '',
  projectId: '',
  messagingSenderId: '',
  appId: '',
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  if (title) self.registration.showNotification(title, { body: body || '', icon: '/icon-192.png' });
});
