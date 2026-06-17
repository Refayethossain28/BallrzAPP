import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import { app } from './firebase';
import { registerPushToken } from './functions';

/**
 * Best-effort Web Push registration. Requests notification permission, obtains
 * an FCM token (needs the firebase-messaging service worker + a VAPID key) and
 * stores it server-side. Returns whether a token was registered. Never throws.
 */
export async function registerForPush(): Promise<boolean> {
  try {
    if (!(await isSupported()) || typeof Notification === 'undefined') return false;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;
    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
    const token = await getToken(getMessaging(app), vapidKey ? { vapidKey } : undefined);
    if (!token) return false;
    await registerPushToken({ token });
    return true;
  } catch {
    return false; // push is optional — never block the app on it
  }
}
