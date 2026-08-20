-- Pint Path clients use Supabase only for Auth. All Storage access is mediated
-- by the application server with the service role, so every direct object
-- policy on the managed object or bucket tables is an unexpected browser-
-- access surface regardless of its name, roles, predicate, or bucket filter.
BEGIN;

SET LOCAL lock_timeout = '5s';
LOCK TABLE storage.buckets, storage.objects IN ACCESS EXCLUSIVE MODE;

do $$
declare
  storage_policy record;
begin
  for storage_policy in
    select
      relation.relname as relation_name,
      policy.polname as policy_name
    from pg_catalog.pg_policy policy
    inner join pg_catalog.pg_class relation
      on relation.oid = policy.polrelid
    inner join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'storage'
      and relation.relname in ('buckets', 'objects')
    order by relation.relname, policy.polname
  loop
    execute pg_catalog.format(
      'drop policy if exists %I on storage.%I',
      storage_policy.policy_name,
      storage_policy.relation_name
    );
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_policy policy
    where policy.polrelid in (
      'storage.buckets'::pg_catalog.regclass,
      'storage.objects'::pg_catalog.regclass
    )
  ) then
    raise exception using
      errcode = '42501',
      message = 'Storage policy cleanup did not reach the required empty posture.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class relation
    where relation.oid in (
      'storage.buckets'::pg_catalog.regclass,
      'storage.objects'::pg_catalog.regclass
    )
      and not relation.relrowsecurity
  ) then
    raise exception using
      errcode = '42501',
      message = 'Storage row-level security is not enabled after posture hardening.';
  end if;
end
$$;

-- Reassert the private bucket contract in the same forward migration so policy
-- cleanup cannot leave a partially hardened Storage configuration.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'beermap-source-evidence',
  'beermap-source-evidence',
  false,
  8388608,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf'
  ]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if exists (
    select 1
    from storage.buckets bucket
    where bucket.public is true
  ) then
    raise exception using
      errcode = '42501',
      message = 'A public Storage bucket remains after posture hardening.';
  end if;
end
$$;

-- Expose only the aggregate posture required by server readiness. Policy names,
-- predicates, and role lists remain unavailable through the Data API.
drop view if exists public.pintpath_storage_policy_posture;

create view public.pintpath_storage_policy_posture
with (security_invoker = true)
as
select
  (
    select count(*)::bigint
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'storage.objects'::pg_catalog.regclass
  ) as object_policy_count,
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid = 'storage.objects'::pg_catalog.regclass
  ) as object_rls_enabled,
  (
    select count(*)::bigint
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'storage.buckets'::pg_catalog.regclass
  ) as bucket_policy_count,
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid = 'storage.buckets'::pg_catalog.regclass
  ) as bucket_rls_enabled,
  (
    select count(*)::bigint
    from storage.buckets bucket
    where bucket.public is true
  ) as public_bucket_count;

revoke all privileges on table public.pintpath_storage_policy_posture
  from public, anon, authenticated, service_role;
grant select on table public.pintpath_storage_policy_posture to service_role;

comment on view public.pintpath_storage_policy_posture is
  'Service-role readiness posture: managed Storage tables must keep RLS enabled with zero policies and every bucket must remain private because Pint Path Storage access is server mediated.';

COMMIT;
