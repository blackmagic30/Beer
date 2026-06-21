-- Pint Points loyalty wallet and one-time Free Pint Reward codes.
--
-- Codes are hashed server-side and all writes are intended to go through the
-- protected business API. Browser clients can read only their own wallet
-- activity; venue validation/redeem flows remain server-authorized.

create table if not exists public.free_pint_reward_codes (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  public_account_id text not null,
  code_hash text not null unique,
  eligible_venue_scope text not null default 'affiliated',
  status text not null default 'active'
    check (status in ('active', 'used', 'expired', 'cancelled', 'rejected')),
  points_reserved integer not null default 50 check (points_reserved = 50),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  cancelled_at timestamptz,
  rejected_at timestamptz,
  rejected_reason text,
  redeemed_by_user_id uuid references auth.users(id) on delete set null,
  redeemed_venue_id text,
  metadata_json jsonb not null default '{}'::jsonb
);

create index if not exists idx_free_pint_reward_codes_user
  on public.free_pint_reward_codes(user_id, status, expires_at desc);

create index if not exists idx_free_pint_reward_codes_code
  on public.free_pint_reward_codes(code_hash);

create index if not exists idx_free_pint_reward_codes_venue
  on public.free_pint_reward_codes(redeemed_venue_id, status, used_at desc);

create table if not exists public.pint_point_drink_records (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  venue_id text not null,
  venue_name text not null,
  suburb text,
  item_name text,
  beverage_category text not null default 'alcoholic',
  quantity integer not null default 1 check (quantity between 1 and 20),
  is_alcoholic boolean not null default true,
  source text not null default 'venue_portal'
    check (source in ('venue_portal', 'pos_webhook', 'admin_adjustment', 'manual_entry')),
  reward_code_id text references public.free_pint_reward_codes(id) on delete set null,
  recorded_by_user_id uuid references auth.users(id) on delete set null,
  recorded_at timestamptz not null default now(),
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_pint_point_drink_records_user
  on public.pint_point_drink_records(user_id, recorded_at desc);

create index if not exists idx_pint_point_drink_records_venue
  on public.pint_point_drink_records(venue_id, recorded_at desc);

create table if not exists public.free_pint_reward_redemptions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  public_account_id text not null,
  reward_code_id text not null references public.free_pint_reward_codes(id) on delete cascade,
  venue_id text not null,
  venue_name text not null,
  suburb text,
  redeemed_by_user_id uuid references auth.users(id) on delete set null,
  redeemed_at timestamptz not null default now(),
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_free_pint_reward_redemptions_user
  on public.free_pint_reward_redemptions(user_id, redeemed_at desc);

create index if not exists idx_free_pint_reward_redemptions_venue
  on public.free_pint_reward_redemptions(venue_id, redeemed_at desc);

create table if not exists public.pint_point_ledger (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  venue_id text,
  drink_record_id text references public.pint_point_drink_records(id) on delete set null,
  reward_code_id text references public.free_pint_reward_codes(id) on delete set null,
  type text not null check (
    type in (
      'drink_scan',
      'manual_drink_entry',
      'reward_code_created',
      'reward_code_expired',
      'reward_redeemed',
      'reward_cancelled',
      'reward_rejected',
      'admin_adjustment',
      'fraud_reversal'
    )
  ),
  points_delta integer not null default 0,
  points_reserved_delta integer not null default 0,
  description text not null,
  created_at timestamptz not null default now(),
  metadata_json jsonb not null default '{}'::jsonb
);

create index if not exists idx_pint_point_ledger_user
  on public.pint_point_ledger(user_id, created_at desc);

create index if not exists idx_pint_point_ledger_venue
  on public.pint_point_ledger(venue_id, created_at desc);

alter table public.free_pint_reward_codes enable row level security;
alter table public.pint_point_drink_records enable row level security;
alter table public.free_pint_reward_redemptions enable row level security;
alter table public.pint_point_ledger enable row level security;

drop policy if exists "free_pint_reward_codes_select_own" on public.free_pint_reward_codes;
create policy "free_pint_reward_codes_select_own"
  on public.free_pint_reward_codes for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "pint_point_drink_records_select_own" on public.pint_point_drink_records;
create policy "pint_point_drink_records_select_own"
  on public.pint_point_drink_records for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "free_pint_reward_redemptions_select_own" on public.free_pint_reward_redemptions;
create policy "free_pint_reward_redemptions_select_own"
  on public.free_pint_reward_redemptions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "pint_point_ledger_select_own" on public.pint_point_ledger;
create policy "pint_point_ledger_select_own"
  on public.pint_point_ledger for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.free_pint_reward_codes from anon;
revoke all on public.free_pint_reward_codes from authenticated;
grant select on public.free_pint_reward_codes to authenticated;

revoke all on public.pint_point_drink_records from anon;
revoke all on public.pint_point_drink_records from authenticated;
grant select on public.pint_point_drink_records to authenticated;

revoke all on public.free_pint_reward_redemptions from anon;
revoke all on public.free_pint_reward_redemptions from authenticated;
grant select on public.free_pint_reward_redemptions to authenticated;

revoke all on public.pint_point_ledger from anon;
revoke all on public.pint_point_ledger from authenticated;
grant select on public.pint_point_ledger to authenticated;

comment on table public.pint_point_ledger is
  'Private Pint Points wallet ledger. Positive drink entries and reserved/free-pint reward movements are written only by trusted server flows.';

comment on table public.free_pint_reward_codes is
  'Short-lived one-time Free Pint Reward codes. Raw codes are never stored, only hashes.';
