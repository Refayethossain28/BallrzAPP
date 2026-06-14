-- Create subscriptions table
create table if not exists public.subscriptions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null unique,
  tier text not null default 'free' check (tier in ('free', 'pro')),
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Enable RLS
alter table public.subscriptions enable row level security;

-- Users can read their own subscription
create policy "Users can read own subscription"
  on public.subscriptions
  for select
  using (auth.uid() = user_id);

-- Service role can do everything (used server-side)
create policy "Service role full access"
  on public.subscriptions
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Auto-create free subscription on user signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.subscriptions (user_id, tier)
  values (new.id, 'free')
  on conflict (user_id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
