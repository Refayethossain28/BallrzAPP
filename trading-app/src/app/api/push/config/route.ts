import { NextResponse } from 'next/server'

// Exposes the public half of the VAPID keypair so the browser can subscribe.
// (Public by design — the private key never leaves the server.)
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? null
  return NextResponse.json({
    enabled: Boolean(publicKey && process.env.VAPID_PRIVATE_KEY && process.env.FIREBASE_SERVICE_ACCOUNT),
    publicKey,
  })
}
