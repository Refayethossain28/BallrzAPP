import { NextRequest, NextResponse } from 'next/server'
import { analyzeScreenshot, type AnalyzableImage, type ImageMediaType } from '@/lib/visionModel'

// Runs the vision model server-side so ANTHROPIC_API_KEY stays off the client.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TYPES: ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
// The Claude API caps images at 5MB; base64 inflates bytes by ~4/3.
const MAX_BASE64_LENGTH = Math.floor(5 * 1024 * 1024 * (4 / 3))
const MAX_IMAGES = 3

interface ImagePayload { image?: string; mediaType?: string }

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ImagePayload & { images?: ImagePayload[] }

    // Accept the multi-image shape, falling back to the original single-image
    // fields for backward compatibility.
    const raw: ImagePayload[] = Array.isArray(body.images) && body.images.length > 0
      ? body.images
      : [{ image: body.image, mediaType: body.mediaType }]

    if (raw.length > MAX_IMAGES) {
      return NextResponse.json({ error: `Too many images. Maximum is ${MAX_IMAGES}.` }, { status: 400 })
    }

    const images: AnalyzableImage[] = []
    for (const item of raw) {
      if (!item.image || !item.mediaType) {
        return NextResponse.json({ error: 'Each image needs image data and a mediaType.' }, { status: 400 })
      }
      if (!ALLOWED_TYPES.includes(item.mediaType as ImageMediaType)) {
        return NextResponse.json(
          { error: 'Unsupported image type. Use PNG, JPEG, GIF, or WebP.' },
          { status: 400 },
        )
      }
      if (item.image.length > MAX_BASE64_LENGTH) {
        return NextResponse.json({ error: 'Image too large. Maximum size is 5MB.' }, { status: 413 })
      }
      images.push({ base64: item.image, mediaType: item.mediaType as ImageMediaType })
    }

    const result = await analyzeScreenshot(images)

    if ('error' in result) {
      return NextResponse.json(result, { status: 502 })
    }
    return NextResponse.json(result)
  } catch (err) {
    console.error('Vision route error:', err)
    return NextResponse.json({ error: 'Failed to analyze screenshot' }, { status: 500 })
  }
}
