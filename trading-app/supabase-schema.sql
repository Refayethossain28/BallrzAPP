-- ============================================================
-- FX Signal Pro — Supabase Schema
-- Run this in your Supabase SQL Editor
-- ============================================================

-- 1. Create subscriptions table
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tier         TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro')),
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- 2. Enable Row Level Security
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- 3. Policy: users can only read their own subscription
CREATE POLICY "Users can view own subscription"
  ON public.subscriptions
  FOR SELECT
  USING (auth.uid() = user_id);

-- 4. Policy: service role can do everything (used by webhook + tier check)
-- The service role bypasses RLS by default, so no explicit policy needed.
-- But we add an explicit policy for clarity:
CREATE POLICY "Service role full access"
  ON public.subscriptions
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- (Note: the service role key always bypasses RLS, so the above is a
--  belt-and-suspenders measure for any future anon calls.)

-- 5. Auto-insert 'free' subscription on user signup via trigger
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.subscriptions (user_id, tier)
  VALUES (NEW.id, 'free')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Drop trigger if it already exists, then recreate
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
