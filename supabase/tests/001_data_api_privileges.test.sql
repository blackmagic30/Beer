begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(8);

select is(
  (
    select count(*)
    from information_schema.table_privileges p
    where p.table_schema = 'public'
      and p.grantee = 'anon'
      and p.table_name = any (array[
        'profiles',
        'beermap_uploads',
        'beermap_verifications',
        'user_activity_events',
        'age_verifications',
        'user_price_submissions',
        'venue_menu_captures',
        'account_privacy_settings',
        'account_discount_passes',
        'discount_redemptions',
        'account_reward_vouchers',
        'leaderboard_prize_campaigns',
        'leaderboard_prize_awards',
        'free_pint_reward_codes',
        'pint_point_drink_records',
        'free_pint_reward_redemptions',
        'pint_point_ledger'
      ])
  ),
  0::bigint,
  'anon has no table privileges on repository-owned public tables'
);

select set_eq(
  $$
    select table_name || ':' || privilege_type
    from information_schema.table_privileges
    where table_schema = 'public'
      and grantee = 'authenticated'
      and table_name = any (array[
        'profiles',
        'beermap_uploads',
        'beermap_verifications',
        'user_activity_events',
        'age_verifications',
        'user_price_submissions',
        'venue_menu_captures',
        'account_privacy_settings',
        'account_discount_passes',
        'discount_redemptions',
        'account_reward_vouchers',
        'leaderboard_prize_campaigns',
        'leaderboard_prize_awards',
        'free_pint_reward_codes',
        'pint_point_drink_records',
        'free_pint_reward_redemptions',
        'pint_point_ledger'
      ])
  $$,
  $$
    values
      ('account_discount_passes:SELECT'),
      ('account_privacy_settings:INSERT'),
      ('account_privacy_settings:SELECT'),
      ('account_privacy_settings:UPDATE'),
      ('account_reward_vouchers:SELECT'),
      ('age_verifications:SELECT'),
      ('beermap_uploads:SELECT'),
      ('beermap_verifications:SELECT'),
      ('discount_redemptions:SELECT'),
      ('free_pint_reward_codes:SELECT'),
      ('free_pint_reward_redemptions:SELECT'),
      ('leaderboard_prize_campaigns:SELECT'),
      ('pint_point_drink_records:SELECT'),
      ('pint_point_ledger:SELECT'),
      ('profiles:SELECT'),
      ('user_activity_events:SELECT'),
      ('user_price_submissions:SELECT')
  $$,
  'authenticated has only the intended table-level Data API privileges'
);

select set_eq(
  $$
    select column_name
    from information_schema.column_privileges
    where table_schema = 'public'
      and table_name = 'profiles'
      and grantee = 'authenticated'
      and privilege_type = 'UPDATE'
  $$,
  $$
    values
      ('avatar_url'),
      ('display_name'),
      ('updated_at'),
      ('username')
  $$,
  'authenticated can update only safe profile columns'
);

select ok(
  has_table_privilege('service_role', 'public.profiles', 'SELECT'),
  'service_role can run the isolated restore readiness probe'
);

select ok(
  has_schema_privilege('authenticated', 'private', 'USAGE')
    and not has_schema_privilege('anon', 'private', 'USAGE'),
  'only authenticated browser sessions can resolve approved private RLS helpers'
);

select ok(
  has_function_privilege('authenticated', 'private.beermap_upload_owner(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'private.beermap_is_admin(uuid)', 'EXECUTE'),
  'authenticated can execute the two approved private RLS helpers'
);

select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'anon cannot execute private helper functions'
);

select ok(
  not exists (
    select 1
    from pg_default_acl d
    left join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) acl
    left join pg_roles grantee on grantee.oid = acl.grantee
    where d.defaclrole = 'postgres'::regrole
      and n.nspname = 'public'
      and (
        (
          d.defaclobjtype in ('r', 'S')
          and grantee.rolname in ('anon', 'authenticated', 'service_role')
        )
        or (
          d.defaclobjtype = 'f'
          and (
            acl.grantee = 0
            or grantee.rolname in ('anon', 'authenticated', 'service_role')
          )
        )
      )
  ),
  'future postgres-owned public objects remain private until explicitly granted'
);

select * from finish();

rollback;
