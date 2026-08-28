begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(10);

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

select ok(
  (
    select count(*) = 3
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'venues'
       and (
         (
           column_name = 'business_status'
           and data_type = 'text'
           and is_nullable = 'YES'
           and column_default is null
         )
         or (
           column_name = 'last_checked_at'
           and data_type = 'timestamp with time zone'
           and is_nullable = 'YES'
           and column_default is null
         )
         or (
           column_name = 'directory_eligible'
           and data_type = 'boolean'
           and is_nullable = 'NO'
           and column_default = 'false'
         )
       )
  ),
  'directory status columns have the reviewed types, nullability, and defaults'
);

select ok(
  (
    select count(*) = 2
      from pg_constraint
     where conrelid = 'public.venues'::regclass
       and conname in (
         'venues_business_status_check',
         'venues_australian_postcode_check'
       )
       and contype = 'c'
  ),
  'directory status and Australian postcode checks exist'
);

select ok(
  exists (
    select 1
      from pg_index i
      join pg_class index_relation on index_relation.oid = i.indexrelid
     where i.indrelid = 'public.venues'::regclass
       and index_relation.relname = 'venues_operational_directory_name_id_idx'
       and i.indisvalid
       and i.indisready
       and position('directory_eligible = true' in pg_get_expr(i.indpred, i.indrelid)) > 0
       and position('business_status' in pg_get_expr(i.indpred, i.indrelid)) > 0
       and position('OPERATIONAL' in pg_get_expr(i.indpred, i.indrelid)) > 0
  ),
  'the operational directory index is valid and fail-closed'
);

select * from finish();

rollback;
