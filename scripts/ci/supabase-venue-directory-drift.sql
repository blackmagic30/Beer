\set ON_ERROR_STOP on

begin;

insert into public.venues (
  id,
  google_place_id,
  name,
  business_status,
  last_checked_at,
  directory_eligible
) values (
  '00000000-0000-4000-8000-000000000427',
  'pintpath-ci-legacy-venue-42703',
  'Pint Path legacy schema fixture',
  'OPERATIONAL',
  now(),
  true
);

-- Reproduce the observed hosted drift without changing the persistent local
-- database: the legacy relation exists, but the status-aware columns do not.
alter table public.venues disable row level security;
grant select, insert, update, delete on table public.venues to anon, authenticated;
alter table public.venues
  drop column business_status,
  drop column last_checked_at,
  drop column directory_eligible;

\ir ../../supabase/migrations/20260828010000_bootstrap_external_venue_directory.sql
\ir ../../supabase/migrations/20260828010000_bootstrap_external_venue_directory.sql
\ir supabase-venue-directory-schema-verify.sql

do $verify_preservation$
begin
  if not exists (
    select 1
      from public.venues
     where id = '00000000-0000-4000-8000-000000000427'
       and google_place_id = 'pintpath-ci-legacy-venue-42703'
       and name = 'Pint Path legacy schema fixture'
       and business_status is null
       and last_checked_at is null
       and directory_eligible = false
  ) then
    raise exception 'venue directory migration did not preserve and quarantine the legacy row';
  end if;
end
$verify_preservation$;

rollback;
