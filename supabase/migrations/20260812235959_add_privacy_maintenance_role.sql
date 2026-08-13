-- Separate privacy erasure/retention from the request-serving runtime login.
-- The actual LOGIN is created outside this migration and must be a member only
-- of this fail-closed NOLOGIN group; application startup verifies its exact ACL.

begin;

do $$
declare
  role_record pg_catalog.pg_roles%rowtype;
begin
  if pg_catalog.to_regrole('pintpath_runtime') is null
     or pg_catalog.to_regrole('pintpath_migrator') is null then
    raise exception using
      errcode = '55000',
      message = 'Pint Path runtime roles must exist before privacy maintenance activation.';
  end if;

  if pg_catalog.to_regrole('pintpath_maintenance') is null then
    create role pintpath_maintenance
      nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
  end if;

  select roles.* into strict role_record
    from pg_catalog.pg_roles as roles
   where roles.rolname = 'pintpath_maintenance';
  if role_record.rolcanlogin
     or role_record.rolsuper
     or role_record.rolcreatedb
     or role_record.rolcreaterole
     or role_record.rolinherit
     or role_record.rolreplication
     or role_record.rolbypassrls then
    raise exception using
      errcode = '42501',
      message = 'pintpath_maintenance has unsafe role attributes',
      detail = 'Required: NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS.';
  end if;
  if exists (
    select 1
      from pg_catalog.pg_auth_members as membership
     where membership.member = role_record.oid
  ) then
    raise exception using
      errcode = '42501',
      message = 'pintpath_maintenance must not inherit any other database role.';
  end if;
end
$$;

revoke all on schema pintpath_app from pintpath_maintenance;
revoke all on schema pintpath_ops from pintpath_maintenance;
revoke all on all tables in schema pintpath_app from pintpath_maintenance;
revoke all on all tables in schema pintpath_ops from pintpath_maintenance;
revoke all on all sequences in schema pintpath_app from pintpath_maintenance;
revoke all on all sequences in schema pintpath_ops from pintpath_maintenance;
revoke all on all functions in schema pintpath_app from pintpath_maintenance;
revoke all on all functions in schema pintpath_ops from pintpath_maintenance;
grant usage on schema pintpath_app to pintpath_maintenance;

do $$
declare
  table_name text;
  baseline_tables constant text[] := array[
    'account_deletion_completion_outbox',
    'account_deletion_notice_recipient_secrets',
    'account_deletion_notification_events',
    'account_deletion_requests',
    'account_discount_passes',
    'account_preferences',
    'account_privacy_settings',
    'account_reward_vouchers',
    'accounts',
    'admin_ingestion_queue',
    'age_verifications',
    'auth_sessions',
    'beer_catalog_aliases',
    'beer_catalog_items',
    'billing_checkout_reservations',
    'contribution_ledger',
    'discount_redemptions',
    'events',
    'feedback',
    'free_pint_reward_codes',
    'free_pint_reward_redemptions',
    'leaderboard_prize_awards',
    'leaderboard_prize_campaigns',
    'migration_quarantined_records',
    'mission_progress',
    'missions',
    'pint_point_drink_records',
    'pint_point_ledger',
    'profiles',
    'revoked_provider_sessions',
    'saved_items',
    'security_audit_log',
    'source_evidence_objects',
    'stripe_webhook_events',
    'submission_items',
    'submission_source_evidence',
    'submissions',
    'system_state',
    'user_activity_events',
    'venue_analytics_events',
    'venue_beers',
    'venue_claim_requests',
    'venue_happy_hours',
    'venue_identity_aliases',
    'venue_interest_requests',
    'venue_location_cache',
    'venue_manager_assignments',
    'venue_monthly_reports',
    'venue_partner_outreach',
    'venue_pending_changes',
    'venue_price_records',
    'venue_profiles',
    'venue_requests',
    'venue_specials',
    'verifications',
    'wrong_price_reports'
  ];
  select_tables constant text[] := array[
    'account_deletion_completion_outbox',
    'account_deletion_notice_recipient_secrets',
    'account_deletion_notification_events',
    'account_deletion_requests',
    'account_discount_passes',
    'account_preferences',
    'account_privacy_settings',
    'account_reward_vouchers',
    'accounts',
    'age_verifications',
    'auth_sessions',
    'billing_checkout_reservations',
    'contribution_ledger',
    'discount_redemptions',
    'events',
    'feedback',
    'free_pint_reward_codes',
    'free_pint_reward_redemptions',
    'leaderboard_prize_awards',
    'leaderboard_prize_campaigns',
    'migration_quarantined_records',
    'mission_progress',
    'pint_point_drink_records',
    'pint_point_ledger',
    'profiles',
    'revoked_provider_sessions',
    'saved_items',
    'security_audit_log',
    'source_evidence_objects',
    'stripe_webhook_events',
    'submission_items',
    'submission_source_evidence',
    'submissions',
    'system_state',
    'user_activity_events',
    'venue_claim_requests',
    'venue_interest_requests',
    'venue_manager_assignments',
    'venue_partner_outreach',
    'venue_pending_changes',
    'venue_price_records',
    'venue_requests',
    'verifications',
    'wrong_price_reports'
  ];
  update_tables constant text[] := array[
    'account_deletion_completion_outbox',
    'account_deletion_notice_recipient_secrets',
    'account_deletion_requests',
    'accounts',
    'discount_redemptions',
    'events',
    'feedback',
    'free_pint_reward_codes',
    'free_pint_reward_redemptions',
    'leaderboard_prize_campaigns',
    'migration_quarantined_records',
    'pint_point_drink_records',
    'profiles',
    'security_audit_log',
    'source_evidence_objects',
    'stripe_webhook_events',
    'submissions',
    'system_state',
    'venue_claim_requests',
    'venue_interest_requests',
    'venue_manager_assignments',
    'venue_partner_outreach',
    'venue_pending_changes',
    'venue_requests',
    'wrong_price_reports'
  ];
  delete_tables constant text[] := array[
    'account_deletion_notification_events',
    'account_deletion_notice_recipient_secrets',
    'account_discount_passes',
    'account_preferences',
    'account_privacy_settings',
    'account_reward_vouchers',
    'age_verifications',
    'auth_sessions',
    'billing_checkout_reservations',
    'contribution_ledger',
    'discount_redemptions',
    'events',
    'free_pint_reward_codes',
    'free_pint_reward_redemptions',
    'leaderboard_prize_awards',
    'mission_progress',
    'pint_point_drink_records',
    'pint_point_ledger',
    'revoked_provider_sessions',
    'saved_items',
    'security_audit_log',
    'submission_items',
    'submissions',
    'user_activity_events',
    'venue_manager_assignments',
    'venue_pending_changes',
    'venue_price_records',
    'verifications'
  ];
  runtime_role_oid oid := pg_catalog.to_regrole('pintpath_runtime')::oid;
  maintenance_role_oid oid := pg_catalog.to_regrole('pintpath_maintenance')::oid;
begin
  if cardinality(baseline_tables) <> 56
     or cardinality(select_tables) <> 44
     or cardinality(update_tables) <> 25
     or cardinality(delete_tables) <> 28 then
    raise exception 'Privacy maintenance ACL inventory is not canonical.';
  end if;

  foreach table_name in array baseline_tables loop
    if pg_catalog.to_regclass(pg_catalog.format('pintpath_app.%I', table_name)) is null then
      raise exception 'Missing canonical table pintpath_app.%', table_name;
    end if;
    if not exists (
      select 1
        from pg_catalog.pg_policy as policy
        join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
        join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'pintpath_app'
         and relation.relname = table_name
         and policy.polname = (table_name || '_runtime_all')::name
    ) then
      raise exception 'Missing canonical runtime policy for pintpath_app.%', table_name;
    end if;
    execute pg_catalog.format(
      'alter policy %I on pintpath_app.%I to pintpath_runtime, pintpath_maintenance',
      table_name || '_runtime_all',
      table_name
    );
  end loop;

  foreach table_name in array select_tables loop
    execute pg_catalog.format('grant select on pintpath_app.%I to pintpath_maintenance', table_name);
  end loop;
  foreach table_name in array update_tables loop
    execute pg_catalog.format('grant update on pintpath_app.%I to pintpath_maintenance', table_name);
  end loop;
  foreach table_name in array delete_tables loop
    execute pg_catalog.format('grant delete on pintpath_app.%I to pintpath_maintenance', table_name);
  end loop;

  revoke update, delete on pintpath_app.security_audit_log from pintpath_runtime;
  revoke update, delete on pintpath_app.contribution_ledger from pintpath_runtime;
  revoke update, delete on pintpath_app.pint_point_ledger from pintpath_runtime;

  foreach table_name in array baseline_tables loop
    if not pg_catalog.has_table_privilege(
      'pintpath_runtime', pg_catalog.format('pintpath_app.%I', table_name), 'SELECT'
    ) or not pg_catalog.has_table_privilege(
      'pintpath_runtime', pg_catalog.format('pintpath_app.%I', table_name), 'INSERT'
    ) or pg_catalog.has_table_privilege(
      'pintpath_maintenance', pg_catalog.format('pintpath_app.%I', table_name), 'INSERT'
    ) or pg_catalog.has_table_privilege(
      'pintpath_maintenance', pg_catalog.format('pintpath_app.%I', table_name), 'SELECT'
    ) <> (table_name = any(select_tables))
      or pg_catalog.has_table_privilege(
        'pintpath_maintenance', pg_catalog.format('pintpath_app.%I', table_name), 'UPDATE'
      ) <> (table_name = any(update_tables))
      or pg_catalog.has_table_privilege(
        'pintpath_maintenance', pg_catalog.format('pintpath_app.%I', table_name), 'DELETE'
      ) <> (table_name = any(delete_tables)) then
      raise exception 'Non-canonical privacy maintenance ACL on pintpath_app.%', table_name;
    end if;
    if pg_catalog.has_table_privilege(
      'pintpath_runtime', pg_catalog.format('pintpath_app.%I', table_name), 'UPDATE'
    ) <> (not (table_name = any(array['security_audit_log', 'contribution_ledger', 'pint_point_ledger'])))
      or pg_catalog.has_table_privilege(
        'pintpath_runtime', pg_catalog.format('pintpath_app.%I', table_name), 'DELETE'
      ) <> (not (table_name = any(array['security_audit_log', 'contribution_ledger', 'pint_point_ledger']))) then
      raise exception 'Non-canonical append-only runtime ACL on pintpath_app.%', table_name;
    end if;
    if not exists (
      select 1
        from pg_catalog.pg_policy as policy
        join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
        join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'pintpath_app'
         and relation.relname = table_name
         and policy.polname = (table_name || '_runtime_all')::name
         and policy.polroles @> array[runtime_role_oid, maintenance_role_oid]::oid[]
         and policy.polroles <@ array[runtime_role_oid, maintenance_role_oid]::oid[]
         and policy.polcmd = '*'
         and policy.polpermissive
         and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
         and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
    ) then
      raise exception 'Non-canonical privacy maintenance RLS policy on pintpath_app.%', table_name;
    end if;
  end loop;

  if pg_catalog.has_schema_privilege('pintpath_maintenance', 'pintpath_ops', 'USAGE')
     or pg_catalog.has_table_privilege('pintpath_maintenance', 'pintpath_app.schema_metadata', 'SELECT')
     or exists (
       select 1
         from pg_catalog.pg_proc as routine
         join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
        where namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
          and pg_catalog.has_function_privilege('pintpath_maintenance', routine.oid, 'EXECUTE')
     ) then
    raise exception using
      errcode = '42501',
      message = 'Privacy maintenance authority escaped its reviewed table-only boundary.';
  end if;
end
$$;

commit;
