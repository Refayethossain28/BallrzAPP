'use client'
import {
  collection, deleteDoc, doc, getDocs, orderBy, query, setDoc, limit,
} from 'firebase/firestore'
import { firebaseAuth, firestore } from './firebase'
import type { ScreenshotAnalysis } from './types'
import {
  addEntry as localAdd, loadJournal as localLoad, setOutcome as localSetOutcome,
  removeEntry as localRemove, clearJournal as localClear,
  type JournalEntry, type TradeOutcome,
} from './journal'

// Journal storage facade: signed-in users read/write Firestore (synced across
// devices); signed-out users keep the original device-local journal. On first
// signed-in load, any local entries are migrated up to the cloud once.

const MAX_CLOUD_ENTRIES = 200
const MIGRATED_KEY = 'apexfx-journal-migrated'

function uid(): string | null {
  return firebaseAuth().currentUser?.uid ?? null
}

function tradesCol(userId: string) {
  return collection(firestore(), 'apexfx', userId, 'trades')
}

export async function loadEntries(): Promise<JournalEntry[]> {
  const userId = uid()
  if (!userId) return localLoad()

  await migrateLocalOnce(userId)
  const snap = await getDocs(query(tradesCol(userId), orderBy('createdAt', 'desc'), limit(MAX_CLOUD_ENTRIES)))
  return snap.docs.map(d => ({ ...(d.data() as Omit<JournalEntry, 'id'>), id: d.id }))
}

export async function saveEntry(result: ScreenshotAnalysis, thumb: string): Promise<void> {
  const userId = uid()
  if (!userId) {
    localAdd(result, thumb)
    return
  }
  const entry = localAdd(result, thumb) // also keep a local copy as offline cache
  const { id, ...data } = entry
  await setDoc(doc(tradesCol(userId), id), data)
}

export async function markOutcome(id: string, outcome: TradeOutcome): Promise<void> {
  localSetOutcome(id, outcome)
  const userId = uid()
  if (userId) {
    // Merge-write: works whether or not the cloud doc exists yet, and any
    // real failure surfaces to the caller instead of vanishing silently.
    await setDoc(doc(tradesCol(userId), id), { outcome }, { merge: true })
  }
}

export async function deleteEntry(id: string): Promise<void> {
  localRemove(id)
  const userId = uid()
  if (userId) {
    await deleteDoc(doc(tradesCol(userId), id)).catch(() => { /* ignore */ })
  }
}

export async function clearAll(): Promise<void> {
  const userId = uid()
  localClear()
  if (userId) {
    const snap = await getDocs(tradesCol(userId))
    await Promise.all(snap.docs.map(d => deleteDoc(d.ref)))
  }
}

// One-time upload of pre-login local entries so nothing is lost on sign-in.
async function migrateLocalOnce(userId: string) {
  try {
    if (localStorage.getItem(`${MIGRATED_KEY}-${userId}`)) return
    const local = localLoad()
    for (const entry of local) {
      const { id, ...data } = entry
      await setDoc(doc(tradesCol(userId), id), data, { merge: true })
    }
    localStorage.setItem(`${MIGRATED_KEY}-${userId}`, '1')
  } catch {
    // Migration is best-effort; never block the journal on it.
  }
}
