-- Account leaderboard identity and privacy-safe venue discount redemption foundation.
-- Public leaderboards use public_account_id instead of email. Rotating discount passes are
-- hashed server-side and redemption records are only created by trusted app/API flows.

create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;

alter table public.profiles
  add column if not exists public_account_id text;

create unique index if not exists profiles_public_account_id_key
  on public.profiles(public_account_id);

create or replace function private.generate_public_account_id()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  candidate text;
begin
  loop
    candidate := 'PP-' || upper(substr(replace(extensions.gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (
      select 1
      from public.profiles
      where public_account_id = candidate
    );
  end loop;

  return candidate;
end;
$$;

update public.profiles
set public_account_id = private.generate_public_account_id()
where public_account_id is null;

create index if not exists idx_profiles_public_account
  on public.profiles(public_account_id);

create or replace function private.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.profiles (
    id,
    email,
    public_account_id,
    display_name,
    avatar_url,
    email_verified_at,
    terms_accepted_at,
    privacy_accepted_at,
    terms_version,
    privacy_version
  )
  values (
    new.id,
    new.email,
    private.generate_public_account_id(),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url',
    new.email_confirmed_at,
    case when lower(coalesce(new.raw_user_meta_data ->> 'terms_accepted', 'false')) = 'true' then now() else null end,
    case when lower(coalesce(new.raw_user_meta_data ->> 'privacy_accepted', 'false')) = 'true' then now() else null end,
    nullif(new.raw_user_meta_data ->> 'terms_version', ''),
    nullif(new.raw_user_meta_data ->> 'privacy_version', '')
  )
  on conflict (id) do update set
    email = excluded.email,
    public_account_id = coalesce(public.profiles.public_account_id, excluded.public_account_id),
    display_name = coalesce(public.profiles.display_name, excluded.display_name),
    avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url),
    email_verified_at = coalesce(public.profiles.email_verified_at, excluded.email_verified_at),
    terms_accepted_at = coalesce(public.profiles.terms_accepted_at, excluded.terms_accepted_at),
    privacy_accepted_at = coalesce(public.profiles.privacy_accepted_at, excluded.privacy_accepted_at),
    terms_version = coalesce(public.profiles.terms_version, excluded.terms_version),
    privacy_version = coalesce(public.profiles.privacy_version, excluded.privacy_version),
    updated_at = now();
  return new;
end;
$$;

create table if not exists public.account_discount_passes (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_token_hash text not null,
  code_hash text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz
);

create index if not exists idx_account_discount_passes_user
  on public.account_discount_passes(user_id, status, expires_at desc);

create index if not exists idx_account_discount_passes_session
  on public.account_discount_passes(session_token_hash, status, expires_at desc);

create index if not exists idx_account_discount_passes_code
  on public.account_discount_passes(code_hash);

alter table public.account_discount_passes enable row level security;

drop policy if exists "account_discount_passes_select_own" on public.account_discount_passes;
create policy "account_discount_passes_select_own"
  on public.account_discount_passes for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.account_discount_passes from anon;
grant select on public.account_discount_passes to authenticated;

create table if not exists public.discount_redemptions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  public_account_id text not null,
  venue_id text not null,
  venue_name text not null,
  suburb text,
  special_id text,
  item_name text,
  quantity integer not null default 1 check (quantity between 1 and 20),
  estimated_savings_cents integer not null default 0 check (estimated_savings_cents >= 0),
  discount_pass_id uuid references public.account_discount_passes(id) on delete set null,
  redeemed_by_user_id uuid references auth.users(id) on delete set null,
  redeemed_at timestamptz not null default now(),
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_discount_redemptions_user
  on public.discount_redemptions(user_id, redeemed_at desc);

create index if not exists idx_discount_redemptions_venue
  on public.discount_redemptions(venue_id, redeemed_at desc);

create index if not exists idx_discount_redemptions_redeemed_at
  on public.discount_redemptions(redeemed_at desc);

alter table public.discount_redemptions enable row level security;

drop policy if exists "discount_redemptions_select_own" on public.discount_redemptions;
create policy "discount_redemptions_select_own"
  on public.discount_redemptions for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.discount_redemptions from anon;
grant select on public.discount_redemptions to authenticated;

comment on table public.account_discount_passes is
  'Hashed, short-lived Pint Path discount pass codes. Raw codes are not stored.';

comment on table public.discount_redemptions is
  'Explicit user-presented venue discount redemptions. Used for profile savings and aggregate venue reports, not passive tracking.';
