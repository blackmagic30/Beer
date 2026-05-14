-- Supabase foundation for BeerMap accounts, uploads, verifications, activity, and 18+ reward eligibility.
-- This is additive and intentionally does not store raw ID documents, licence numbers, passport numbers,
-- Medicare numbers, birth-date documents, or ID images.

create schema if not exists private;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  username text unique,
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'admin', 'venue_manager')),
  account_status text not null default 'active' check (account_status in ('active', 'warned', 'suspended')),
  email_verified_at timestamptz,
  mfa_level text not null default 'aal1' check (mfa_level in ('aal1', 'aal2')),
  mfa_verified_at timestamptz,
  age_verification_status text not null default 'not_started'
    check (age_verification_status in ('not_started', 'pending', 'verified', 'rejected', 'expired')),
  is_over_18_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.beermap_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  venue_id text not null,
  beer_id text,
  submission_type text not null,
  status text not null default 'pending'
    check (status in ('pending', 'needs_more_evidence', 'approved', 'rejected', 'disputed', 'fraud_flagged')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.beermap_verifications (
  id uuid primary key default gen_random_uuid(),
  verifier_user_id uuid not null references auth.users(id) on delete cascade,
  upload_id uuid not null references public.beermap_uploads(id) on delete cascade,
  target_entity_type text not null default 'upload',
  target_entity_id text not null,
  result text not null check (result in ('confirmed', 'disputed', 'needs_more_evidence')),
  notes text,
  created_at timestamptz not null default now(),
  unique (verifier_user_id, upload_id)
);

create table if not exists public.user_activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  related_entity_type text,
  related_entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.age_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'not_started'
    check (status in ('not_started', 'pending', 'verified', 'rejected', 'expired')),
  age_threshold integer not null default 18 check (age_threshold = 18),
  is_over_18 boolean not null default false,
  provider_name text,
  provider_reference_id text,
  checked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_beermap_uploads_user on public.beermap_uploads(user_id, created_at desc);
create index if not exists idx_beermap_uploads_status on public.beermap_uploads(status, created_at desc);
create index if not exists idx_beermap_verifications_user on public.beermap_verifications(verifier_user_id, created_at desc);
create index if not exists idx_beermap_verifications_target on public.beermap_verifications(target_entity_type, target_entity_id, created_at desc);
create index if not exists idx_user_activity_events_user on public.user_activity_events(user_id, created_at desc);
create index if not exists idx_user_activity_events_type on public.user_activity_events(event_type, created_at desc);
create index if not exists idx_age_verifications_user on public.age_verifications(user_id, created_at desc);
create index if not exists idx_age_verifications_status on public.age_verifications(status, updated_at desc);
create index if not exists idx_profiles_email_verified on public.profiles(email_verified_at, updated_at desc);

alter table public.profiles enable row level security;
alter table public.beermap_uploads enable row level security;
alter table public.beermap_verifications enable row level security;
alter table public.user_activity_events enable row level security;
alter table public.age_verifications enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_update_own_safe_fields"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

revoke update on public.profiles from authenticated;
grant update (display_name, username, avatar_url, updated_at) on public.profiles to authenticated;

create policy "uploads_select_own"
  on public.beermap_uploads for select
  using (auth.uid() = user_id);

create policy "uploads_insert_own"
  on public.beermap_uploads for insert
  with check (auth.uid() = user_id);

create policy "uploads_update_own_pending"
  on public.beermap_uploads for update
  using (auth.uid() = user_id and status in ('pending', 'needs_more_evidence'))
  with check (auth.uid() = user_id);

create or replace function private.beermap_upload_owner(p_upload_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select user_id from public.beermap_uploads where id = p_upload_id;
$$;

grant execute on function private.beermap_upload_owner(uuid) to authenticated;

create policy "verifications_insert_other_uploads"
  on public.beermap_verifications for insert
  with check (
    auth.uid() = verifier_user_id
    and private.beermap_upload_owner(upload_id) is not null
    and private.beermap_upload_owner(upload_id) <> auth.uid()
  );

create policy "verifications_select_own"
  on public.beermap_verifications for select
  using (auth.uid() = verifier_user_id);

create policy "activity_insert_own"
  on public.user_activity_events for insert
  with check (auth.uid() = user_id);

create policy "activity_select_own"
  on public.user_activity_events for select
  using (auth.uid() = user_id);

create policy "age_verifications_select_own"
  on public.age_verifications for select
  using (auth.uid() = user_id);

-- Age verification rows should be written by trusted server-side/provider flows using the service role,
-- not by users directly. No insert/update policy is provided for authenticated users on purpose.

create or replace function private.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url, email_verified_at)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url',
    new.email_confirmed_at
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_beermap_profile on auth.users;
create trigger on_auth_user_created_beermap_profile
  after insert on auth.users
  for each row execute function private.create_profile_for_new_user();

-- Private Storage bucket for upload/source evidence. Public pages must never read raw menu photos,
-- OCR evidence, or verification proof directly. App servers should create short-lived signed URLs
-- after checking account, admin, or owning-venue-manager authorization.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'beermap-source-evidence',
  'beermap-source-evidence',
  false,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "source_evidence_owner_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'beermap-source-evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "source_evidence_owner_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'beermap-source-evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "source_evidence_owner_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'beermap-source-evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'beermap-source-evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
