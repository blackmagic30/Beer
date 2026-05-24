-- Account-level privacy preferences for optional analytics and venue-report inclusion.
-- Public map reads are unaffected. These preferences apply to signed-in account activity.

create table if not exists public.account_privacy_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  optional_analytics_enabled boolean not null default true,
  venue_report_inclusion_enabled boolean not null default true,
  product_research_enabled boolean not null default true,
  email_updates_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_account_privacy_settings_updated
  on public.account_privacy_settings(updated_at desc);

alter table public.account_privacy_settings enable row level security;

drop policy if exists "privacy_settings_select_own" on public.account_privacy_settings;
drop policy if exists "privacy_settings_insert_own" on public.account_privacy_settings;
drop policy if exists "privacy_settings_update_own" on public.account_privacy_settings;
drop policy if exists "privacy_settings_admin_select" on public.account_privacy_settings;

create policy "privacy_settings_select_own"
  on public.account_privacy_settings for select
  to authenticated
  using (auth.uid() = user_id);

create policy "privacy_settings_insert_own"
  on public.account_privacy_settings for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "privacy_settings_update_own"
  on public.account_privacy_settings for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "privacy_settings_admin_select"
  on public.account_privacy_settings for select
  to authenticated
  using (private.beermap_is_admin(auth.uid()));

revoke all on public.account_privacy_settings from anon;
grant select, insert, update on public.account_privacy_settings to authenticated;
