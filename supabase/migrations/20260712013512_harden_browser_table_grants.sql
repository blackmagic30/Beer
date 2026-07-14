-- The current web app reads venue, price, reward, and submission data through
-- the protected Express API. Browser roles only need narrowly scoped access to
-- their own account records. Remove Supabase's broad default table grants,
-- including TRUNCATE/REFERENCES/TRIGGER privileges that are never required.

do $$
begin
  if to_regclass('public.call_results') is not null then
    execute 'drop policy if exists "public read" on public.call_results';
  end if;
  if to_regclass('public.guinness_prices') is not null then
    execute 'drop policy if exists "Public can read guinness_prices" on public.guinness_prices';
  end if;
  if to_regclass('public.venues') is not null then
    execute 'drop policy if exists "public read venues" on public.venues';
  end if;
end
$$;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.beermap_uploads from anon, authenticated;
revoke all on table public.beermap_verifications from anon, authenticated;
revoke all on table public.user_activity_events from anon, authenticated;
revoke all on table public.age_verifications from anon, authenticated;
revoke all on table public.user_price_submissions from anon, authenticated;
revoke all on table public.venue_menu_captures from anon, authenticated;
revoke all on table public.account_privacy_settings from anon, authenticated;
revoke all on table public.account_discount_passes from anon, authenticated;
revoke all on table public.discount_redemptions from anon, authenticated;
revoke all on table public.account_reward_vouchers from anon, authenticated;
revoke all on table public.leaderboard_prize_campaigns from anon, authenticated;
revoke all on table public.leaderboard_prize_awards from anon, authenticated;
revoke all on table public.free_pint_reward_codes from anon, authenticated;
revoke all on table public.pint_point_drink_records from anon, authenticated;
revoke all on table public.free_pint_reward_redemptions from anon, authenticated;
revoke all on table public.pint_point_ledger from anon, authenticated;
do $$
begin
  if to_regclass('public.call_logs') is not null then
    execute 'revoke all on table public.call_logs from anon, authenticated';
  end if;
  if to_regclass('public.call_queue') is not null then
    execute 'revoke all on table public.call_queue from anon, authenticated';
  end if;
  if to_regclass('public.call_results') is not null then
    execute 'revoke all on table public.call_results from anon, authenticated';
  end if;
  if to_regclass('public.guinness_prices') is not null then
    execute 'revoke all on table public.guinness_prices from anon, authenticated';
  end if;
  if to_regclass('public.venue_billing') is not null then
    execute 'revoke all on table public.venue_billing from anon, authenticated';
  end if;
  if to_regclass('public.venues') is not null then
    execute 'revoke all on table public.venues from anon, authenticated';
  end if;
end
$$;

grant select on table public.profiles to authenticated;
grant update (display_name, username, avatar_url, updated_at) on table public.profiles to authenticated;

grant select, insert, update on table public.account_privacy_settings to authenticated;
grant select on table public.age_verifications to authenticated;
grant select on table public.beermap_uploads to authenticated;
grant select on table public.beermap_verifications to authenticated;
grant select on table public.user_activity_events to authenticated;
grant select on table public.user_price_submissions to authenticated;
grant select on table public.account_discount_passes to authenticated;
grant select on table public.discount_redemptions to authenticated;
grant select on table public.account_reward_vouchers to authenticated;
grant select on table public.leaderboard_prize_campaigns to authenticated;
grant select on table public.free_pint_reward_codes to authenticated;
grant select on table public.pint_point_drink_records to authenticated;
grant select on table public.free_pint_reward_redemptions to authenticated;
grant select on table public.pint_point_ledger to authenticated;

do $$
begin
  if to_regclass('public.call_results') is not null then
    execute $comment$comment on table public.call_results is
      'Legacy ingestion output retained for migration history. Server/service-role access only; use venue_menu_captures and the protected Express API.'$comment$;
  end if;
  if to_regclass('public.venues') is not null then
    execute $comment$comment on table public.venues is
      'Canonical Supabase venue directory. Public reads are mediated by the protected Express API.'$comment$;
  end if;
end
$$;
