import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUserTier } from '@/lib/tier'
import TradingAppClient from '@/components/TradingAppClient'

export default async function AppPage() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth/login')
  }

  const tier = await getUserTier(user.id)

  return <TradingAppClient tier={tier} />
}
