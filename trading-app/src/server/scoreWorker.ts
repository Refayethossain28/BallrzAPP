import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import webpush from 'web-push'
import { scoreTrades, type ScorableTrade } from '@/lib/scoring'

// Real-time trade scoring. Runs inside the always-on web service (started
// from instrumentation.ts): every few minutes it loads every user's open
// trades, scores them against fresh hourly candles, writes settled outcomes
// back to Firestore, and pushes a notification to each of the user's devices.
//
// Requires two server secrets (silently idle without them):
//   FIREBASE_SERVICE_ACCOUNT — service-account JSON (Firestore admin access)
//   VAPID_PRIVATE_KEY + VAPID_PUBLIC_KEY — web-push signing keys

const INTERVAL_MS = 5 * 60 * 1000
const STARTUP_DELAY_MS = 30 * 1000

declare global {
  // Guard against double-start across dev reloads / duplicate imports.
  var __apexfxScoreWorker: boolean | undefined
}

let adminDb: Firestore | null = null
let running = false

export function startScoreWorker() {
  if (globalThis.__apexfxScoreWorker) return
  globalThis.__apexfxScoreWorker = true

  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT
  const vapidPublic = process.env.VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY

  if (!svcJson) {
    console.log('[scoreWorker] FIREBASE_SERVICE_ACCOUNT not set — real-time scoring disabled')
    return
  }

  try {
    const svc = JSON.parse(svcJson) as Parameters<typeof cert>[0]
    if (getApps().length === 0) initializeApp({ credential: cert(svc) })
    adminDb = getFirestore()
  } catch (err) {
    console.error('[scoreWorker] invalid FIREBASE_SERVICE_ACCOUNT JSON:', err)
    return
  }

  if (vapidPublic && vapidPrivate) {
    try {
      webpush.setVapidDetails('mailto:rafa_hossain@icloud.com', vapidPublic, vapidPrivate)
    } catch (err) {
      console.error('[scoreWorker] invalid VAPID keys — pushes disabled:', err)
    }
  } else {
    console.log('[scoreWorker] VAPID keys not set — scoring runs but pushes are disabled')
  }

  console.log('[scoreWorker] started — checking open trades every 5 minutes')
  setTimeout(() => void tick(), STARTUP_DELAY_MS)
  setInterval(() => void tick(), INTERVAL_MS)
}

async function tick() {
  if (running || !adminDb) return
  running = true
  try {
    // listDocuments() surfaces virtual parents too, so users whose only data
    // lives in subcollections are still found.
    const userRefs = await adminDb.collection('apexfx').listDocuments()
    for (const userRef of userRefs) {
      await scoreUser(userRef.id).catch(err =>
        console.error(`[scoreWorker] user ${userRef.id} failed:`, err),
      )
    }
  } catch (err) {
    console.error('[scoreWorker] tick failed:', err)
  } finally {
    running = false
  }
}

async function scoreUser(uid: string) {
  const db = adminDb!
  const tradesCol = db.collection('apexfx').doc(uid).collection('trades')
  const snap = await tradesCol.where('outcome', '==', 'open').get()

  const open: Array<ScorableTrade & { instrumentLabel: string; verdictLabel: string; tp1: string; sl: string }> = []
  for (const d of snap.docs) {
    const t = d.data() as {
      instrument?: string; verdict?: string; takeProfit1?: string; stopLoss?: string; createdAt?: string
    }
    if (t.verdict !== 'BUY' && t.verdict !== 'SELL') continue
    if (!t.instrument || !t.takeProfit1 || !t.stopLoss || !t.createdAt) continue
    open.push({
      id: d.id,
      instrument: t.instrument,
      verdict: t.verdict,
      takeProfit1: t.takeProfit1,
      stopLoss: t.stopLoss,
      createdAt: t.createdAt,
      instrumentLabel: t.instrument,
      verdictLabel: t.verdict,
      tp1: t.takeProfit1,
      sl: t.stopLoss,
    })
  }
  if (open.length === 0) return

  const results = await scoreTrades(open)
  const settled = results.filter(r => r.outcome !== null)
  if (settled.length === 0) return

  for (const hit of settled) {
    const trade = open.find(t => t.id === hit.id)!
    await tradesCol.doc(hit.id).update({
      outcome: hit.outcome,
      scoredAt: new Date().toISOString(),
      scoredBy: 'auto',
    })
    await notifyUser(uid, trade, hit.outcome as 'tp1' | 'sl')
  }
}

async function notifyUser(
  uid: string,
  trade: { instrumentLabel: string; verdictLabel: string; tp1: string; sl: string },
  outcome: 'tp1' | 'sl',
) {
  if (!process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) return
  const db = adminDb!
  const subsSnap = await db.collection('apexfx').doc(uid).collection('pushSubs').get()
  if (subsSnap.empty) return

  const payload = JSON.stringify(
    outcome === 'tp1'
      ? {
          title: `🎯 ${trade.instrumentLabel} hit Take Profit 1`,
          body: `Your ${trade.verdictLabel} call reached ${trade.tp1}. Marked as a win on your scoreboard.`,
          url: '/journal',
          tag: `trade-${trade.instrumentLabel}`,
        }
      : {
          title: `🛑 ${trade.instrumentLabel} hit Stop Loss`,
          body: `Your ${trade.verdictLabel} call stopped out at ${trade.sl}. Marked on your scoreboard.`,
          url: '/journal',
          tag: `trade-${trade.instrumentLabel}`,
        },
  )

  for (const subDoc of subsSnap.docs) {
    const sub = subDoc.data() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) continue
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
        payload,
      )
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode
      if (status === 404 || status === 410) {
        await subDoc.ref.delete().catch(() => { /* ignore */ }) // subscription expired
      }
    }
  }
}
