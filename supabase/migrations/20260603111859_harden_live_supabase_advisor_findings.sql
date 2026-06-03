-- Harden live Supabase advisor findings from the Pint Path project.
-- This migration is deliberately defensive because the live project has some
-- legacy direct-Supabase venue RPC objects that are not part of every local
-- development database.

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

do $$
declare
  table_name text;
begin
  -- These tables intentionally have no browser-facing access path. Add an
  -- explicit deny policy so RLS remains fail-closed without looking forgotten.
  foreach table_name in array array['call_logs', 'call_queue', 'venue_billing']
  loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('drop policy if exists server_only_no_client_access on public.%I', table_name);
      execute format(
        'create policy server_only_no_client_access on public.%I for all to anon, authenticated using (false) with check (false)',
        table_name
      );
    end if;
  end loop;
end
$$;

do $$
begin
  if to_regprocedure('public.set_updated_at()') is not null then
    alter function public.set_updated_at() set search_path = pg_catalog;
  end if;
end
$$;

do $$
begin
  -- The following legacy SECURITY DEFINER helpers should not be public REST RPCs.
  if to_regprocedure('public.can_admin_venue(uuid)') is not null then
    revoke all on function public.can_admin_venue(uuid) from public, anon, authenticated;
  end if;

  if to_regprocedure('public.can_manage_venue(uuid)') is not null then
    revoke all on function public.can_manage_venue(uuid) from public, anon, authenticated;
  end if;

  if to_regprocedure('public.can_view_paid_venue_features(uuid)') is not null then
    revoke all on function public.can_view_paid_venue_features(uuid) from public, anon, authenticated;
  end if;

  if to_regprocedure('public.current_user_is_verified()') is not null then
    revoke all on function public.current_user_is_verified() from public, anon, authenticated;
  end if;

  if to_regprocedure('public.get_bar_dashboard_analytics(uuid, timestamp with time zone, timestamp with time zone, integer)') is not null then
    revoke all on function public.get_bar_dashboard_analytics(uuid, timestamp with time zone, timestamp with time zone, integer) from public, anon, authenticated;
  end if;

  if to_regprocedure('public.prevent_venue_private_field_client_updates()') is not null then
    revoke all on function public.prevent_venue_private_field_client_updates() from public, anon, authenticated;
  end if;

  if to_regprocedure('public.track_bar_analytics_event(text, uuid, text, text, text, text, jsonb)') is not null then
    revoke all on function public.track_bar_analytics_event(text, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
  end if;
end
$$;

do $$
begin
  -- The live project no longer has public.bar_accounts, so these old direct
  -- venue-management policies can call stale helpers. Drop them unless the
  -- supporting table exists, then rebuild private equivalents.
  if to_regclass('public.venues') is not null and to_regclass('public.bar_accounts') is null then
    drop policy if exists "bar members can read own venue" on public.venues;
    drop policy if exists "bar owners can update own venue profile" on public.venues;
  end if;

  if to_regclass('public.venues') is not null and to_regclass('public.bar_accounts') is not null then
    execute $fn$
      create or replace function private.current_user_is_verified()
      returns boolean
      language sql
      stable
      security definer
      set search_path = pg_catalog
      as $body$
        select exists (
          select 1
          from auth.users u
          where u.id = (select auth.uid())
            and (u.email_confirmed_at is not null or u.confirmed_at is not null)
        );
      $body$;
    $fn$;

    execute $fn$
      create or replace function private.can_admin_venue(p_venue_id uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = pg_catalog
      as $body$
        select private.current_user_is_verified()
          and exists (
            select 1
            from public.bar_accounts ba
            where ba.venue_id = p_venue_id
              and ba.user_id = (select auth.uid())
              and ba.role in ('owner', 'admin')
          );
      $body$;
    $fn$;

    execute $fn$
      create or replace function private.can_manage_venue(p_venue_id uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = pg_catalog
      as $body$
        select private.current_user_is_verified()
          and exists (
            select 1
            from public.bar_accounts ba
            where ba.venue_id = p_venue_id
              and ba.user_id = (select auth.uid())
              and ba.role in ('owner', 'admin', 'staff')
          );
      $body$;
    $fn$;

    revoke all on function private.current_user_is_verified() from public;
    revoke all on function private.can_admin_venue(uuid) from public;
    revoke all on function private.can_manage_venue(uuid) from public;
    grant execute on function private.current_user_is_verified() to authenticated;
    grant execute on function private.can_admin_venue(uuid) to authenticated;
    grant execute on function private.can_manage_venue(uuid) to authenticated;

    drop policy if exists "bar members can read own venue" on public.venues;
    create policy "bar members can read own venue"
      on public.venues
      for select
      to authenticated
      using (private.can_manage_venue(id));

    drop policy if exists "bar owners can update own venue profile" on public.venues;
    create policy "bar owners can update own venue profile"
      on public.venues
      for update
      to authenticated
      using (private.can_admin_venue(id))
      with check (private.can_admin_venue(id));
  end if;
end
$$;

do $$
begin
  -- Convert common auth.uid() policy calls into initplans and scope old
  -- public-role owner policies to authenticated users.
  if to_regclass('public.profiles') is not null then
    drop policy if exists "profiles_select_own" on public.profiles;
    create policy "profiles_select_own"
      on public.profiles
      for select
      to authenticated
      using ((select auth.uid()) = id);

    drop policy if exists "profiles_update_own_safe_fields" on public.profiles;
    create policy "profiles_update_own_safe_fields"
      on public.profiles
      for update
      to authenticated
      using ((select auth.uid()) = id)
      with check ((select auth.uid()) = id);
  end if;

  if to_regclass('public.beermap_uploads') is not null then
    drop policy if exists "uploads_select_own" on public.beermap_uploads;
    create policy "uploads_select_own"
      on public.beermap_uploads
      for select
      to authenticated
      using ((select auth.uid()) = user_id);

    drop policy if exists "uploads_insert_own" on public.beermap_uploads;
    create policy "uploads_insert_own"
      on public.beermap_uploads
      for insert
      to authenticated
      with check ((select auth.uid()) = user_id);

    drop policy if exists "uploads_admin_select" on public.beermap_uploads;
    create policy "uploads_admin_select"
      on public.beermap_uploads
      for select
      to authenticated
      using (private.beermap_is_admin((select auth.uid())));

    drop policy if exists "uploads_admin_review_update" on public.beermap_uploads;
    create policy "uploads_admin_review_update"
      on public.beermap_uploads
      for update
      to authenticated
      using (private.beermap_is_admin((select auth.uid())))
      with check (private.beermap_is_admin((select auth.uid())));
  end if;

  if to_regclass('public.beermap_verifications') is not null then
    drop policy if exists "verifications_select_own" on public.beermap_verifications;
    create policy "verifications_select_own"
      on public.beermap_verifications
      for select
      to authenticated
      using ((select auth.uid()) = verifier_user_id);

    drop policy if exists "verifications_insert_other_uploads" on public.beermap_verifications;
    create policy "verifications_insert_other_uploads"
      on public.beermap_verifications
      for insert
      to authenticated
      with check (
        (select auth.uid()) = verifier_user_id
        and private.beermap_upload_owner(upload_id) is not null
        and private.beermap_upload_owner(upload_id) <> (select auth.uid())
      );

    drop policy if exists "verifications_admin_select" on public.beermap_verifications;
    create policy "verifications_admin_select"
      on public.beermap_verifications
      for select
      to authenticated
      using (private.beermap_is_admin((select auth.uid())));
  end if;

  if to_regclass('public.user_activity_events') is not null then
    drop policy if exists "activity_select_own" on public.user_activity_events;
    create policy "activity_select_own"
      on public.user_activity_events
      for select
      to authenticated
      using ((select auth.uid()) = user_id);

    drop policy if exists "activity_insert_own" on public.user_activity_events;
    create policy "activity_insert_own"
      on public.user_activity_events
      for insert
      to authenticated
      with check ((select auth.uid()) = user_id);

    drop policy if exists "activity_admin_select" on public.user_activity_events;
    create policy "activity_admin_select"
      on public.user_activity_events
      for select
      to authenticated
      using (private.beermap_is_admin((select auth.uid())));
  end if;

  if to_regclass('public.age_verifications') is not null then
    drop policy if exists "age_verifications_select_own" on public.age_verifications;
    create policy "age_verifications_select_own"
      on public.age_verifications
      for select
      to authenticated
      using ((select auth.uid()) = user_id);

    drop policy if exists "age_verifications_admin_select" on public.age_verifications;
    create policy "age_verifications_admin_select"
      on public.age_verifications
      for select
      to authenticated
      using (private.beermap_is_admin((select auth.uid())));
  end if;
end
$$;

do $$
begin
  if to_regclass('public.user_price_submissions') is not null then
    drop policy if exists "user_price_submissions_owner_select" on public.user_price_submissions;
    create policy "user_price_submissions_owner_select"
      on public.user_price_submissions
      for select
      to authenticated
      using ((select auth.uid()) = user_id);

    drop policy if exists "user_price_submissions_owner_insert_pending" on public.user_price_submissions;
    create policy "user_price_submissions_owner_insert_pending"
      on public.user_price_submissions
      for insert
      to authenticated
      with check (
        (select auth.uid()) = user_id
        and status = 'pending'
        and verified_at is null
        and rejected_at is null
        and reviewer_notes is null
        and (evidence_path is null or evidence_path like ((select auth.uid())::text || '/%'))
      );

    drop policy if exists "user_price_submissions_admin_select" on public.user_price_submissions;
    create policy "user_price_submissions_admin_select"
      on public.user_price_submissions
      for select
      to authenticated
      using (private.beermap_is_admin((select auth.uid())));

    drop policy if exists "user_price_submissions_admin_review_update" on public.user_price_submissions;
    create policy "user_price_submissions_admin_review_update"
      on public.user_price_submissions
      for update
      to authenticated
      using (private.beermap_is_admin((select auth.uid())))
      with check (private.beermap_is_admin((select auth.uid())));
  end if;
end
$$;

do $$
begin
  if to_regclass('public.beermap_verifications') is not null then
    create index if not exists idx_beermap_verifications_upload_id
      on public.beermap_verifications(upload_id);
  end if;

  if to_regclass('public.call_logs') is not null then
    create index if not exists idx_call_logs_venue_id
      on public.call_logs(venue_id);
  end if;

  if to_regclass('public.call_queue') is not null then
    create index if not exists idx_call_queue_venue_id
      on public.call_queue(venue_id);
  end if;

  if to_regclass('public.call_results') is not null then
    create index if not exists idx_call_results_venue_id
      on public.call_results(venue_id);
  end if;

  if to_regclass('public.discount_redemptions') is not null then
    create index if not exists idx_discount_redemptions_discount_pass_id
      on public.discount_redemptions(discount_pass_id);
    create index if not exists idx_discount_redemptions_redeemed_by_user_id
      on public.discount_redemptions(redeemed_by_user_id);
  end if;
end
$$;
