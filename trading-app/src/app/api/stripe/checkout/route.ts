import { NextResponse, type NextRequest } from 'next/server'
import { stripe, PRO_PRICE_ID } from '@/lib/stripe'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  if (!stripe) {
    return NextResponse.json({ error: 'Payments not yet enabled' }, { status: 503 })
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        {
          price: PRO_PRICE_ID,
          quantity: 1,
        },
      ],
      customer_email: user.email,
      client_reference_id: user.id,
      success_url: `${appUrl}/app?upgraded=true`,
      cancel_url: `${appUrl}/pricing`,
      metadata: {
        user_id: user.id,
      },
    })

    return NextResponse.json({ url: session.url })
  } catch (error) {
    console.error('Stripe checkout error:', error)
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
  }
}
