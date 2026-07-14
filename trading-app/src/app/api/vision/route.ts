import { NextRequest, NextResponse } from 'next/server'
import { analyzeScreenshot, type ImageMediaType } from '@/lib/visionModel'

// Runs the vision model server-side so ANTHROPIC_API_KEY stays off the client.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TYPES: ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
// The Claude API caps images at 5MB; base64 inflates bytes by ~4/3.
const MAX_BASE64_LENGTH = Math.floor(5 * 1024 * 1024 * (4 / 3))

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { image?: string; mediaType?: string }

    if (!body.image || !body.mediaType) {
      return NextResponse.json({ error: 'Missing required fields: image, mediaType' }, { status: 400 })
    }
    if (!ALLOWED_TYPES.includes(body.mediaType as ImageMediaType)) {
      return NextResponse.json(
        { error: 'Unsupported image type. Use PNG, JPEG, GIF, or WebP.' },
        { status: 400 },
      )
    }
    if (body.image.length > MAX_BASE64_LENGTH) {
      return NextResponse.json({ error: 'Image too large. Maximum size is 5MB.' }, { status: 413 })
    }

    const result = await analyzeScreenshot(body.image, body.mediaType as ImageMediaType)

    if ('error' in result) {
      return NextResponse.json(result, { status: 502 })
    }
    return NextResponse.json(result)
  } catch (err) {
    console.error('Vision route error:', err)
    return NextResponse.json({ error: 'Failed to analyze screenshot' }, { status: 500 })
  }
}
