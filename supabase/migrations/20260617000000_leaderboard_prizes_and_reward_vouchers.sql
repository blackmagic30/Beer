-- Monthly contributor leaderboard prizes and user reward vouchers.
--
-- Canonical prize finalization and voucher creation are handled by the protected
-- Express business API. These tables mirror the local schema for Supabase-backed
-- environments while keeping voucher ownership private and preventing direct
-- browser writes.

create table if not exists public.account_reward_vouchers (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  public_account_id text not null,
  source_type text not null,
  source_id text,
  title text not null,
  amount_cents integer not null default 0 check (amount_cents >= 0),
  currency text not null default 'AUD',
  venue_scope text,
  status text not null default 'active' check (status in ('active', 'redeemed', 'expired', 'void')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  redeemed_at timestamptz,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_account_reward_vouchers_user
  on public.account_reward_vouchers(user_id, status, issued_at desc);

create table if not exists public.leaderboard_prize_campaigns (
  month_key text primary key check (month_key ~ '^[0-9]{4}-[0-9]{2}$'),
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  first_place_cents integer not null default 10000 check (first_place_cents >= 0),
  second_place_cents integer not null default 5000 check (second_place_cents >= 0),
  third_place_cents integer not null default 2500 check (third_place_cents >= 0),
  affiliate_bar text,
  terms text,
  status text not null default 'active' check (status in ('active', 'finalized', 'cancelled')),
  finalized_at timestamptz,
  finalized_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.leaderboard_prize_awards (
  id text primary key,
  month_key text not null references public.leaderboard_prize_campaigns(month_key) on delete cascade,
  rank integer not null check (rank between 1 and 3),
  user_id uuid not null references auth.users(id) on delete cascade,
  public_account_id text not null,
  display_name text,
  points numeric not null default 0,
  approved_submissions integer not null default 0 check (approved_submissions >= 0),
  voucher_id text references public.account_reward_vouchers(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (month_key, rank),
  unique (month_key, user_id)
);

create index if not exists idx_leaderboard_prize_awards_user
  on public.leaderboard_prize_awards(user_id, month_key desc);

alter table public.account_reward_vouchers enable row level security;
alter table public.leaderboard_prize_campaigns enable row level security;
alter table public.leaderboard_prize_awards enable row level security;

drop policy if exists "reward_vouchers_select_own" on public.account_reward_vouchers;
create policy "reward_vouchers_select_own"
  on public.account_reward_vouchers for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "leaderboard_campaigns_select_authenticated" on public.leaderboard_prize_campaigns;
create policy "leaderboard_campaigns_select_authenticated"
  on public.leaderboard_prize_campaigns for select
  to authenticated
  using (true);

revoke all on public.account_reward_vouchers from anon;
revoke all on public.account_reward_vouchers from authenticated;
grant select on public.account_reward_vouchers to authenticated;

revoke all on public.leaderboard_prize_campaigns from anon;
revoke all on public.leaderboard_prize_campaigns from authenticated;
grant select on public.leaderboard_prize_campaigns to authenticated;

revoke all on public.leaderboard_prize_awards from anon;
revoke all on public.leaderboard_prize_awards from authenticated;

comment on table public.account_reward_vouchers is
  'Private user reward vouchers created by trusted server-side flows such as monthly leaderboard finalization. Users may only read their own vouchers.';

comment on table public.leaderboard_prize_campaigns is
  'Monthly leaderboard prize configuration. Browser users can read active prize terms, but writes require the protected app service role/admin API.';

comment on table public.leaderboard_prize_awards is
  'Server-side snapshot of monthly top-three winners. Direct browser access is revoked to avoid exposing auth user IDs; use the business API leaderboard response.';
