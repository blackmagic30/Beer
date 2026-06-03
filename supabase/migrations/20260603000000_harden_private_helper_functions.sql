-- Harden private helper functions used by RLS policies and auth triggers.
-- Keep helper execution off PUBLIC, grant only the policy helpers authenticated
-- sessions need, and use fully qualified object names with a narrow search path.

create schema if not exists private;

revoke all on schema private from public;
revoke all on all functions in schema private from public;
grant usage on schema private to authenticated;

create or replace function private.beermap_upload_owner(p_upload_id uuid)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select user_id from public.beermap_uploads where id = p_upload_id;
$$;

revoke all on function private.beermap_upload_owner(uuid) from public;
grant execute on function private.beermap_upload_owner(uuid) to authenticated;

create or replace function private.beermap_is_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from public.profiles
    where id = p_user_id
      and role = 'admin'
      and account_status = 'active'
  );
$$;

revoke all on function private.beermap_is_admin(uuid) from public;
grant execute on function private.beermap_is_admin(uuid) to authenticated;

create extension if not exists pgcrypto with schema extensions;

create or replace function private.generate_public_account_id()
returns text
language plpgsql
security definer
set search_path = pg_catalog
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

revoke all on function private.generate_public_account_id() from public;

create or replace function private.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
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
    null,
    null,
    null,
    null
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

revoke all on function private.create_profile_for_new_user() from public;
