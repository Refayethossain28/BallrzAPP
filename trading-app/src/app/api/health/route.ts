import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

// Reports whether the AI is ready to analyze screenshots. Uses the Models API
// (a free metadata call — no inference cost) to prove the key actually works,
// and caches the result so page loads don't hammer the Anthropic API.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export type AIStatus = 'online' | 'unconfigured' | 'invalid_key' | 'error'

interface HealthResult {
  ai: AIStatus
  message: string
  checkedAt: string
}

const CACHE_TTL_MS = 5 * 60 * 1000
let cached: { result: HealthResult; expires: number } | null = null

export async function GET() {
  if (cached && Date.now() < cached.expires) {
    return NextResponse.json(cached.result)
  }

  const result = await checkAI()
  // Cache failures briefly too, but recheck sooner so a fixed key shows green fast.
  const ttl = result.ai === 'online' ? CACHE_TTL_MS : 30 * 1000
  cached = { result, expires: Date.now() + ttl }
  return NextResponse.json(result)
}

async function checkAI(): Promise<HealthResult> {
  const checkedAt = new Date().toISOString()
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    return {
      ai: 'unconfigured',
      message: 'ANTHROPIC_API_KEY is not set on the server.',
      checkedAt,
    }
  }

  try {
    const client = new Anthropic({ apiKey })
    await client.models.retrieve('claude-opus-4-8')
    return { ai: 'online', message: 'AI is connected and ready.', checkedAt }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return {
        ai: 'invalid_key',
        message: 'The configured ANTHROPIC_API_KEY was rejected. Check the value in your host settings.',
        checkedAt,
      }
    }
    console.error('AI health check error:', err)
    return {
      ai: 'error',
      message: 'Could not reach the AI service. It may be temporary — retrying shortly.',
      checkedAt,
    }
  }
}
