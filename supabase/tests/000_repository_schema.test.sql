begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(9);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any (array[
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
      ]::name[])
  ),
  17::bigint,
  'all repository-owned public tables exist'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any (array[
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
      ]::name[])
      and not c.relrowsecurity
  ),
  0::bigint,
  'RLS is enabled on every repository-owned public table'
);

select is(
  (
    select count(*)
    from pg_trigger t
    where t.tgrelid = 'auth.users'::regclass
      and t.tgname = 'on_auth_user_created_beermap_profile'
      and not t.tgisinternal
      and t.tgenabled <> 'D'
  ),
  1::bigint,
  'the auth user profile trigger exists and is enabled'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname = any (array[
        'beermap_upload_owner',
        'beermap_is_admin',
        'generate_public_account_id',
        'create_profile_for_new_user',
        'normalize_public_display_name_key',
        'public_display_name_is_blocked',
        'guard_public_display_name'
      ]::name[])
  ),
  7::bigint,
  'all repository-owned private helper functions exist'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.prosecdef
      and p.proname = any (array[
        'beermap_upload_owner',
        'beermap_is_admin',
        'generate_public_account_id',
        'create_profile_for_new_user'
      ]::name[])
      and not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=pg_catalog']
  ),
  0::bigint,
  'every repository-owned SECURITY DEFINER helper has a fixed pg_catalog search path'
);

select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where n.nspname = 'private'
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  'no private function is executable by PUBLIC'
);

select ok(
  exists (
    select 1
    from storage.buckets b
    where b.id = 'beermap-source-evidence'
      and b.name = 'beermap-source-evidence'
      and b.public is false
      and b.file_size_limit = 8388608
      and b.allowed_mime_types @> array[
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif',
        'application/pdf'
      ]::text[]
  ),
  'the source-evidence bucket is private and enforces the required limits'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        coalesce(qual, '') like '%beermap-source-evidence%'
        or coalesce(with_check, '') like '%beermap-source-evidence%'
      )
  ),
  0::bigint,
  'browser policies do not expose the service-role-only source-evidence bucket'
);

select ok(
  exists (
    select 1
    from pg_index i
    join pg_class index_relation on index_relation.oid = i.indexrelid
    join pg_namespace index_namespace on index_namespace.oid = index_relation.relnamespace
    where index_namespace.nspname = 'public'
      and index_relation.relname = 'venue_menu_captures_evidence_reference_idx'
      and i.indisunique
      and i.indpred is null
  ),
  'the evidence reference unique index supports an unqualified ON CONFLICT target'
);

select * from finish();

rollback;
