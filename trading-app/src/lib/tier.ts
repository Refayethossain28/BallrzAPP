import { createClient } from '@supabase/supabase-js'

export type Tier = 'pro' | 'free'

export async function getUserTier(userId: string): Promise<Tier> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data, error } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .single()

  if (error || !data) return 'free'
  return (data.tier as Tier) ?? 'free'
}
