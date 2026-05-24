-- Record Terms and Privacy Policy acceptance for Pint Path account creation.
-- Acceptance is captured through signup UI checkboxes and stored as profile metadata.

alter table if exists public.profiles
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists privacy_accepted_at timestamptz,
  add column if not exists terms_version text,
  add column if not exists privacy_version text;

create index if not exists idx_profiles_terms_privacy_acceptance
  on public.profiles(terms_accepted_at, privacy_accepted_at, updated_at desc);

create or replace function private.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,
    email,
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

revoke update on public.profiles from authenticated;
grant update (display_name, username, avatar_url, updated_at) on public.profiles to authenticated;
