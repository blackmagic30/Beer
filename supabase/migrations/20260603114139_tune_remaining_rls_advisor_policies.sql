-- Tune remaining live Supabase RLS advisor findings.
-- Combines duplicate owner/admin SELECT policies and makes auth.uid() calls
-- init-plan friendly with (select auth.uid()).

do $$
begin
  if to_regclass('public.account_privacy_settings') is not null then
    drop policy if exists "privacy_settings_select_own" on public.account_privacy_settings;
    drop policy if exists "privacy_settings_admin_select" on public.account_privacy_settings;
    drop policy if exists "privacy_settings_select_own_or_admin" on public.account_privacy_settings;
    create policy "privacy_settings_select_own_or_admin"
      on public.account_privacy_settings
      for select
      to authenticated
      using (
        (select auth.uid()) = user_id
        or private.beermap_is_admin((select auth.uid()))
      );

    drop policy if exists "privacy_settings_insert_own" on public.account_privacy_settings;
    create policy "privacy_settings_insert_own"
      on public.account_privacy_settings
      for insert
      to authenticated
      with check ((select auth.uid()) = user_id);

    drop policy if exists "privacy_settings_update_own" on public.account_privacy_settings;
    create policy "privacy_settings_update_own"
      on public.account_privacy_settings
      for update
      to authenticated
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;

  if to_regclass('public.account_discount_passes') is not null then
    drop policy if exists "account_discount_passes_select_own" on public.account_discount_passes;
    create policy "account_discount_passes_select_own"
      on public.account_discount_passes
      for select
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;

  if to_regclass('public.discount_redemptions') is not null then
    drop policy if exists "discount_redemptions_select_own" on public.discount_redemptions;
    create policy "discount_redemptions_select_own"
      on public.discount_redemptions
      for select
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;

  if to_regclass('public.age_verifications') is not null then
    drop policy if exists "age_verifications_select_own" on public.age_verifications;
    drop policy if exists "age_verifications_admin_select" on public.age_verifications;
    drop policy if exists "age_verifications_select_own_or_admin" on public.age_verifications;
    create policy "age_verifications_select_own_or_admin"
      on public.age_verifications
      for select
      to authenticated
      using (
        (select auth.uid()) = user_id
        or private.beermap_is_admin((select auth.uid()))
      );
  end if;

  if to_regclass('public.beermap_uploads') is not null then
    drop policy if exists "uploads_select_own" on public.beermap_uploads;
    drop policy if exists "uploads_admin_select" on public.beermap_uploads;
    drop policy if exists "uploads_select_own_or_admin" on public.beermap_uploads;
    create policy "uploads_select_own_or_admin"
      on public.beermap_uploads
      for select
      to authenticated
      using (
        (select auth.uid()) = user_id
        or private.beermap_is_admin((select auth.uid()))
      );
  end if;

  if to_regclass('public.beermap_verifications') is not null then
    drop policy if exists "verifications_select_own" on public.beermap_verifications;
    drop policy if exists "verifications_admin_select" on public.beermap_verifications;
    drop policy if exists "verifications_select_own_or_admin" on public.beermap_verifications;
    create policy "verifications_select_own_or_admin"
      on public.beermap_verifications
      for select
      to authenticated
      using (
        (select auth.uid()) = verifier_user_id
        or private.beermap_is_admin((select auth.uid()))
      );
  end if;

  if to_regclass('public.user_activity_events') is not null then
    drop policy if exists "activity_select_own" on public.user_activity_events;
    drop policy if exists "activity_admin_select" on public.user_activity_events;
    drop policy if exists "activity_select_own_or_admin" on public.user_activity_events;
    create policy "activity_select_own_or_admin"
      on public.user_activity_events
      for select
      to authenticated
      using (
        (select auth.uid()) = user_id
        or private.beermap_is_admin((select auth.uid()))
      );
  end if;

  if to_regclass('public.user_price_submissions') is not null then
    drop policy if exists "user_price_submissions_owner_select" on public.user_price_submissions;
    drop policy if exists "user_price_submissions_admin_select" on public.user_price_submissions;
    drop policy if exists "user_price_submissions_select_own_or_admin" on public.user_price_submissions;
    create policy "user_price_submissions_select_own_or_admin"
      on public.user_price_submissions
      for select
      to authenticated
      using (
        (select auth.uid()) = user_id
        or private.beermap_is_admin((select auth.uid()))
      );
  end if;
end
$$;
