begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(7);

select has_table(
  'public',
  'venues',
  'the external venue directory exists on clean and hosted databases'
);

select columns_are(
  'public',
  'venues',
  array[
    'id', 'created_at', 'google_place_id', 'name', 'address', 'suburb',
    'state', 'postcode', 'phone', 'website', 'latitude', 'longitude',
    'source', 'description', 'instagram', 'contact_email', 'opening_hours',
    'venue_type', 'tags', 'membership_tier', 'highlighted_name',
    'premium_badge', 'promoted', 'featured_special_eligible', 'active',
    'updated_at', 'business_status', 'last_checked_at', 'directory_eligible'
  ],
  'the venue directory exposes the reviewed production-compatible columns'
);

select col_is_pk(
  'public',
  'venues',
  'id',
  'venue identity is a primary key'
);

select col_is_unique(
  'public',
  'venues',
  'google_place_id',
  'a Google Place maps to at most one venue identity'
);

select ok(
  (
    select relrowsecurity
      from pg_class
     where oid = 'public.venues'::regclass
  )
    and not has_table_privilege('anon', 'public.venues', 'SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated', 'public.venues', 'SELECT,INSERT,UPDATE,DELETE'),
  'RLS is enabled and browser JWT roles have no venue table privileges'
);

select ok(
  has_table_privilege('service_role', 'public.venues', 'SELECT,INSERT,UPDATE,DELETE'),
  'the server role can reconcile the external directory'
);

select ok(
  exists (
    select 1
      from pg_trigger
     where tgrelid = 'public.venues'::regclass
       and tgname = 'set_venues_updated_at'
       and not tgisinternal
       and tgenabled <> 'D'
  )
    and exists (
      select 1
        from pg_proc
       where oid = 'public.set_updated_at()'::regprocedure
         and not prosecdef
         and coalesce(proconfig, '{}'::text[]) @> array['search_path=pg_catalog']
    ),
  'updated_at is maintained by an invoker function with a fixed search path'
);

select * from finish();

rollback;
