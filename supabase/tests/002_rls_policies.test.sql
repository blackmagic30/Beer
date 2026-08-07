begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(8);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'profiles',
        'beermap_uploads',
        'beermap_verifications',
        'user_activity_events',
        'age_verifications',
        'user_price_submissions',
        'account_privacy_settings',
        'account_discount_passes',
        'discount_redemptions',
        'account_reward_vouchers',
        'leaderboard_prize_campaigns',
        'free_pint_reward_codes',
        'pint_point_drink_records',
        'free_pint_reward_redemptions',
        'pint_point_ledger'
      ])
  ),
  24::bigint,
  'the final repository-owned RLS policy set is complete'
);

select set_eq(
  $$
    select tablename || ':' || policyname || ':' || cmd
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'profiles',
        'beermap_uploads',
        'beermap_verifications',
        'user_activity_events',
        'age_verifications',
        'user_price_submissions',
        'account_privacy_settings',
        'account_discount_passes',
        'discount_redemptions',
        'account_reward_vouchers',
        'leaderboard_prize_campaigns',
        'free_pint_reward_codes',
        'pint_point_drink_records',
        'free_pint_reward_redemptions',
        'pint_point_ledger'
      ])
  $$,
  $$
    values
      ('account_discount_passes:account_discount_passes_select_own:SELECT'),
      ('account_privacy_settings:privacy_settings_insert_own:INSERT'),
      ('account_privacy_settings:privacy_settings_select_own_or_admin:SELECT'),
      ('account_privacy_settings:privacy_settings_update_own:UPDATE'),
      ('account_reward_vouchers:reward_vouchers_select_own:SELECT'),
      ('age_verifications:age_verifications_select_own_or_admin:SELECT'),
      ('beermap_uploads:uploads_admin_review_update:UPDATE'),
      ('beermap_uploads:uploads_insert_own:INSERT'),
      ('beermap_uploads:uploads_select_own_or_admin:SELECT'),
      ('beermap_verifications:verifications_insert_other_uploads:INSERT'),
      ('beermap_verifications:verifications_select_own_or_admin:SELECT'),
      ('discount_redemptions:discount_redemptions_select_own:SELECT'),
      ('free_pint_reward_codes:free_pint_reward_codes_select_own:SELECT'),
      ('free_pint_reward_redemptions:free_pint_reward_redemptions_select_own:SELECT'),
      ('leaderboard_prize_campaigns:leaderboard_campaigns_select_authenticated:SELECT'),
      ('pint_point_drink_records:pint_point_drink_records_select_own:SELECT'),
      ('pint_point_ledger:pint_point_ledger_select_own:SELECT'),
      ('profiles:profiles_select_own:SELECT'),
      ('profiles:profiles_update_own_safe_fields:UPDATE'),
      ('user_activity_events:activity_insert_own:INSERT'),
      ('user_activity_events:activity_select_own_or_admin:SELECT'),
      ('user_price_submissions:user_price_submissions_admin_review_update:UPDATE'),
      ('user_price_submissions:user_price_submissions_owner_insert_pending:INSERT'),
      ('user_price_submissions:user_price_submissions_select_own_or_admin:SELECT')
  $$,
  'the exact reviewed RLS policy identities and commands are present'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'profiles',
        'beermap_uploads',
        'beermap_verifications',
        'user_activity_events',
        'age_verifications',
        'user_price_submissions',
        'account_privacy_settings',
        'account_discount_passes',
        'discount_redemptions',
        'account_reward_vouchers',
        'leaderboard_prize_campaigns',
        'free_pint_reward_codes',
        'pint_point_drink_records',
        'free_pint_reward_redemptions',
        'pint_point_ledger'
      ])
      and roles <> array['authenticated']::name[]
  ),
  0::bigint,
  'every repository-owned browser policy is scoped to authenticated'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and cmd = 'UPDATE'
      and tablename = any (array[
        'profiles',
        'beermap_uploads',
        'user_price_submissions',
        'account_privacy_settings'
      ])
      and (qual is null or with_check is null)
  ),
  0::bigint,
  'every UPDATE policy has both USING and WITH CHECK'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and cmd = 'INSERT'
      and tablename = any (array[
        'beermap_uploads',
        'beermap_verifications',
        'user_activity_events',
        'user_price_submissions',
        'account_privacy_settings'
      ])
      and with_check is null
  ),
  0::bigint,
  'every INSERT policy has a WITH CHECK predicate'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and cmd = 'DELETE'
      and tablename = any (array[
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
  'browser roles have no repository-owned DELETE policy'
);

select ok(
  exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'leaderboard_prize_campaigns'
      and policyname = 'leaderboard_campaigns_select_authenticated'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and qual = 'true'
  ),
  'leaderboard campaign terms are intentionally readable by authenticated users'
);

select ok(
  not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename in ('venue_menu_captures', 'leaderboard_prize_awards')
  ),
  'server-write-only repository tables have no browser policies'
);

select * from finish();

rollback;
