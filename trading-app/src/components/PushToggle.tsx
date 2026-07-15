'use client'
import { useEffect, useState } from 'react'
import { doc, setDoc, deleteDoc } from 'firebase/firestore'
import { firestore } from '@/lib/firebase'
import { useAuth } from '@/lib/useAuth'
import { Bell, BellOff, BellRing, Loader2 } from 'lucide-react'

// Per-device push-alert toggle. Subscribes this browser/PWA to web push and
// stores the subscription under the signed-in user so the score worker can
// notify every device when a trade settles.

type PushState = 'unsupported' | 'checking' | 'off' | 'on' | 'busy' | 'denied' | 'server-off'

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

function subDocId(endpoint: string): string {
  // Deterministic per-endpoint id so re-subscribing overwrites, not duplicates.
  let hash = 0
  for (let i = 0; i < endpoint.length; i++) hash = (hash * 31 + endpoint.charCodeAt(i)) | 0
  return `sub-${(hash >>> 0).toString(36)}`
}

export default function PushToggle() {
  const { user } = useAuth()
  const [state, setState] = useState<PushState>('checking')

  useEffect(() => {
    if (!user) return
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setState('unsupported')
      return
    }
    if (Notification.permission === 'denied') {
      setState('denied')
      return
    }
    ;(async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        setState(sub ? 'on' : 'off')
      } catch {
        setState('off')
      }
    })()
  }, [user])

  if (!user || state === 'checking') return null

  const enable = async () => {
    setState('busy')
    try {
      const cfg = await (await fetch('/api/push/config')).json() as { enabled: boolean; publicKey: string | null }
      if (!cfg.enabled || !cfg.publicKey) {
        setState('server-off')
        return
      }
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off')
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.publicKey) as BufferSource,
      })
      const json = sub.toJSON()
      await setDoc(doc(firestore(), 'apexfx', user.uid, 'pushSubs', subDocId(sub.endpoint)), {
        endpoint: sub.endpoint,
        keys: json.keys ?? {},
        createdAt: new Date().toISOString(),
        userAgent: navigator.userAgent.slice(0, 200),
      })
      setState('on')
    } catch (err) {
      console.error('Push subscribe failed:', err)
      setState('off')
    }
  }

  const disable = async () => {
    setState('busy')
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await deleteDoc(doc(firestore(), 'apexfx', user.uid, 'pushSubs', subDocId(sub.endpoint))).catch(() => { /* ignore */ })
        await sub.unsubscribe()
      }
      setState('off')
    } catch {
      setState('off')
    }
  }

  const pill = 'inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors'

  switch (state) {
    case 'on':
      return (
        <button onClick={() => void disable()} className={`${pill} text-buy bg-buy/10 border-buy/25 hover:border-buy/50`} title="Tap to turn off trade alerts on this device">
          <BellRing className="w-3.5 h-3.5" /> Alerts on
        </button>
      )
    case 'busy':
      return (
        <span className={`${pill} text-gray-400 bg-surface-muted/60 border-surface-border`}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Alerts
        </span>
      )
    case 'denied':
      return (
        <span className={`${pill} text-gray-500 bg-surface-muted/60 border-surface-border`} title="Notifications are blocked for ApexFX in your device settings — enable them there, then retry.">
          <BellOff className="w-3.5 h-3.5" /> Alerts blocked
        </span>
      )
    case 'server-off':
      return (
        <span className={`${pill} text-yellow-500 bg-yellow-500/10 border-yellow-500/25`} title="Push alerts aren't configured on the server yet.">
          <BellOff className="w-3.5 h-3.5" /> Alerts unavailable
        </span>
      )
    case 'unsupported':
      return (
        <span className={`${pill} text-gray-500 bg-surface-muted/60 border-surface-border`} title="On iPhone, add ApexFX to your Home Screen and open it from there to enable notifications.">
          <BellOff className="w-3.5 h-3.5" /> Alerts n/a here
        </span>
      )
    default:
      return (
        <button onClick={() => void enable()} className={`${pill} text-gray-300 bg-surface-muted/60 border-surface-border hover:border-blue-500/50 hover:text-white`} title="Get a push notification when an open trade hits TP or SL">
          <Bell className="w-3.5 h-3.5" /> Enable alerts
        </button>
      )
  }
}
