'use client'
import { useEffect, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { firebaseAuth } from './firebase'

export function useAuth(): { user: User | null; ready: boolean } {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    return onAuthStateChanged(firebaseAuth(), u => {
      setUser(u)
      setReady(true)
    })
  }, [])

  return { user, ready }
}
