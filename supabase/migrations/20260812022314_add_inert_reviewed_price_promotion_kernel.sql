-- Add an inert, fail-closed database foundation for a future independently
-- authorized reviewed-price promotion kernel. This migration deliberately
-- grants no caller membership and both SECURITY DEFINER functions always fail
-- before inspecting their request or touching a relation.

begin;

set local search_path = pg_catalog;

do $pintpath_kernel$
declare
  current_database_oid oid;
  current_database_oid_text text;
  executor_is_superuser boolean;
  runtime_role_oid oid;
  migrator_role_oid oid;
  schema_owner_oid oid;
  backup_role_name text;
  backup_role_oid oid;
  apply_owner_name text;
  apply_owner_oid oid;
  quarantine_owner_name text;
  quarantine_owner_oid oid;
  apply_execute_name text;
  apply_execute_oid oid;
  quarantine_execute_name text;
  quarantine_execute_oid oid;
  actual_relations text[];
  private_relation_count integer;
  force_rls_relation_count integer;
  private_sequence_count integer;
  private_policy_count integer;
  exact_base_policy_count integer;
  exact_backup_policy_count integer;
  kernel_relation_count integer;
  kernel_routine_count integer;
  existing_kernel_role_count integer;
  successor_policy_only_upgrade boolean := false;
  source_apply_database_oid_text text;
  source_quarantine_database_oid_text text;
  restore_source_database_oid_text text;
  source_apply_body text;
  source_quarantine_body text;
  target record;
  expected_policy_expression constant text := $policy$(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid
   FROM pg_database database
  WHERE (database.datname = current_database()))))$policy$;
  legacy_relations constant text[] := array[
    'pintpath_app.account_deletion_completion_outbox',
    'pintpath_app.account_deletion_notice_recipient_secrets',
    'pintpath_app.account_deletion_notification_events',
    'pintpath_app.account_deletion_requests',
    'pintpath_app.account_discount_passes',
    'pintpath_app.account_preferences',
    'pintpath_app.account_privacy_settings',
    'pintpath_app.account_reward_vouchers',
    'pintpath_app.accounts',
    'pintpath_app.admin_ingestion_queue',
    'pintpath_app.age_verifications',
    'pintpath_app.auth_sessions',
    'pintpath_app.beer_catalog_aliases',
    'pintpath_app.beer_catalog_items',
    'pintpath_app.billing_checkout_reservations',
    'pintpath_app.contribution_ledger',
    'pintpath_app.discount_redemptions',
    'pintpath_app.events',
    'pintpath_app.feedback',
    'pintpath_app.free_pint_reward_codes',
    'pintpath_app.free_pint_reward_redemptions',
    'pintpath_app.leaderboard_prize_awards',
    'pintpath_app.leaderboard_prize_campaigns',
    'pintpath_app.migration_quarantined_records',
    'pintpath_app.mission_progress',
    'pintpath_app.missions',
    'pintpath_app.pint_point_drink_records',
    'pintpath_app.pint_point_ledger',
    'pintpath_app.profiles',
    'pintpath_app.revoked_provider_sessions',
    'pintpath_app.saved_items',
    'pintpath_app.schema_metadata',
    'pintpath_app.security_audit_log',
    'pintpath_app.source_evidence_objects',
    'pintpath_app.stripe_webhook_events',
    'pintpath_app.submission_items',
    'pintpath_app.submission_source_evidence',
    'pintpath_app.submissions',
    'pintpath_app.system_state',
    'pintpath_app.user_activity_events',
    'pintpath_app.venue_analytics_events',
    'pintpath_app.venue_beers',
    'pintpath_app.venue_claim_requests',
    'pintpath_app.venue_happy_hours',
    'pintpath_app.venue_identity_aliases',
    'pintpath_app.venue_interest_requests',
    'pintpath_app.venue_location_cache',
    'pintpath_app.venue_manager_assignments',
    'pintpath_app.venue_monthly_reports',
    'pintpath_app.venue_partner_outreach',
    'pintpath_app.venue_pending_changes',
    'pintpath_app.venue_price_records',
    'pintpath_app.venue_profiles',
    'pintpath_app.venue_requests',
    'pintpath_app.venue_specials',
    'pintpath_app.verifications',
    'pintpath_app.wrong_price_reports',
    'pintpath_ops.migration_chunks',
    'pintpath_ops.migration_runs'
  ];
  successor_relations constant text[] := array[
    'pintpath_app.account_deletion_completion_outbox',
    'pintpath_app.account_deletion_notice_recipient_secrets',
    'pintpath_app.account_deletion_notification_events',
    'pintpath_app.account_deletion_requests',
    'pintpath_app.account_discount_passes',
    'pintpath_app.account_preferences',
    'pintpath_app.account_privacy_settings',
    'pintpath_app.account_reward_vouchers',
    'pintpath_app.accounts',
    'pintpath_app.admin_ingestion_queue',
    'pintpath_app.age_verifications',
    'pintpath_app.auth_sessions',
    'pintpath_app.beer_catalog_aliases',
    'pintpath_app.beer_catalog_items',
    'pintpath_app.billing_checkout_reservations',
    'pintpath_app.contribution_ledger',
    'pintpath_app.discount_redemptions',
    'pintpath_app.events',
    'pintpath_app.feedback',
    'pintpath_app.free_pint_reward_codes',
    'pintpath_app.free_pint_reward_redemptions',
    'pintpath_app.leaderboard_prize_awards',
    'pintpath_app.leaderboard_prize_campaigns',
    'pintpath_app.migration_quarantined_records',
    'pintpath_app.mission_progress',
    'pintpath_app.missions',
    'pintpath_app.pint_point_drink_records',
    'pintpath_app.pint_point_ledger',
    'pintpath_app.profiles',
    'pintpath_app.revoked_provider_sessions',
    'pintpath_app.saved_items',
    'pintpath_app.schema_metadata',
    'pintpath_app.security_audit_log',
    'pintpath_app.source_evidence_objects',
    'pintpath_app.stripe_webhook_events',
    'pintpath_app.submission_items',
    'pintpath_app.submission_source_evidence',
    'pintpath_app.submissions',
    'pintpath_app.system_state',
    'pintpath_app.user_activity_events',
    'pintpath_app.venue_analytics_events',
    'pintpath_app.venue_beers',
    'pintpath_app.venue_claim_requests',
    'pintpath_app.venue_happy_hours',
    'pintpath_app.venue_identity_aliases',
    'pintpath_app.venue_interest_requests',
    'pintpath_app.venue_location_cache',
    'pintpath_app.venue_manager_assignments',
    'pintpath_app.venue_monthly_reports',
    'pintpath_app.venue_partner_outreach',
    'pintpath_app.venue_pending_changes',
    'pintpath_app.venue_price_records',
    'pintpath_app.venue_profiles',
    'pintpath_app.venue_requests',
    'pintpath_app.venue_specials',
    'pintpath_app.verifications',
    'pintpath_app.wrong_price_reports',
    'pintpath_ops.migration_chunks',
    'pintpath_ops.migration_runs',
    'pintpath_ops.reviewed_price_promotion_operations',
    'pintpath_ops.reviewed_price_promotion_rows'
  ];
  apply_body text;
  quarantine_body text;
  role_name text;
  api_role_name text;
begin
  perform pg_catalog.pg_advisory_xact_lock(-1516610544307388179);

  select database.oid, database.oid::text
    into strict current_database_oid, current_database_oid_text
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();
  if current_database_oid = 0::oid
     or current_database_oid_text !~ '^[1-9][0-9]{0,9}$' then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_kernel_database_identity_unsafe';
  end if;

  select role.rolsuper into strict executor_is_superuser
  from pg_catalog.pg_roles as role
  where role.rolname = current_user;
  select pg_catalog.to_regrole('pintpath_runtime')::oid,
         pg_catalog.to_regrole('pintpath_migrator')::oid
    into runtime_role_oid, migrator_role_oid;
  if runtime_role_oid is null or migrator_role_oid is null then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_base_role_unsafe';
  end if;
  select namespace.nspowner into strict schema_owner_oid
  from pg_catalog.pg_namespace as namespace
  where namespace.nspname = 'pintpath_ops';

  backup_role_name := 'pintpath_logical_backup_d' || current_database_oid_text;
  apply_owner_name := 'pintpath_reviewed_price_apply_owner_d' || current_database_oid_text;
  quarantine_owner_name := 'pintpath_reviewed_price_quarantine_owner_d' || current_database_oid_text;
  apply_execute_name := 'pintpath_reviewed_price_apply_execute_d' || current_database_oid_text;
  quarantine_execute_name := 'pintpath_reviewed_price_quarantine_execute_d' || current_database_oid_text;
  apply_body := pg_catalog.format(
    'BEGIN IF CURRENT_USER <> %L THEN RAISE EXCEPTION USING ERRCODE = ''42501'', MESSAGE = ''reviewed_price_promotion_kernel_owner_unsafe''; END IF; RAISE EXCEPTION USING ERRCODE = ''55000'', MESSAGE = ''reviewed_price_promotion_kernel_disabled''; END',
    apply_owner_name
  );
  quarantine_body := pg_catalog.format(
    'BEGIN IF CURRENT_USER <> %L THEN RAISE EXCEPTION USING ERRCODE = ''42501'', MESSAGE = ''reviewed_price_promotion_kernel_owner_unsafe''; END IF; RAISE EXCEPTION USING ERRCODE = ''55000'', MESSAGE = ''reviewed_price_promotion_kernel_disabled''; END',
    quarantine_owner_name
  );
  restore_source_database_oid_text := nullif(
    pg_catalog.current_setting(
      'pintpath.restore_reviewed_price_kernel_source_database_oid', true
    ),
    ''
  );

  select array_agg(
    pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    order by namespace.nspname collate "C", relation.relname collate "C"
  ), count(*)::integer,
  count(*) filter (where relation.relrowsecurity and relation.relforcerowsecurity)::integer
    into actual_relations, private_relation_count, force_rls_relation_count
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
    and relation.relkind in ('r', 'p');

  select count(*)::integer into private_sequence_count
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
    and relation.relkind = 'S';
  if private_sequence_count <> 0 then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_sequence_inventory_unsafe';
  end if;

  select count(*)::integer into private_policy_count
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = any(array['pintpath_app', 'pintpath_ops']);

  select count(*)::integer into exact_base_policy_count
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
    and policy.polpermissive
    and (
      (
        namespace.nspname = 'pintpath_app'
        and relation.relname <> 'schema_metadata'
        and (
          (
            policy.polname = (relation.relname || '_runtime_all')::name
            and policy.polroles = array[runtime_role_oid]::oid[]
            and policy.polcmd = '*'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          ) or (
            policy.polname = (relation.relname || '_migrator_select')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          ) or (
            policy.polname = (relation.relname || '_migrator_insert')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'a'
            and policy.polqual is null
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      ) or (
        namespace.nspname = 'pintpath_app'
        and relation.relname = 'schema_metadata'
        and (
          (
            policy.polname = 'schema_metadata_runtime_read'::name
            and policy.polroles = array[runtime_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          ) or (
            policy.polname = 'schema_metadata_migrator_select'::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          ) or (
            policy.polname = 'schema_metadata_migrator_update'::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'w'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      ) or (
        namespace.nspname = 'pintpath_ops'
        and relation.relname = any(array['migration_chunks', 'migration_runs'])
        and (
          (
            policy.polname = (relation.relname || '_migrator_select')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          ) or (
            policy.polname = (relation.relname || '_migrator_insert')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'a'
            and policy.polqual is null
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          ) or (
            policy.polname = (relation.relname || '_migrator_update')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'w'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      ) or (
        namespace.nspname = 'pintpath_ops'
        and relation.relname = any(array[
          'reviewed_price_promotion_operations',
          'reviewed_price_promotion_rows'
        ])
        and policy.polname = (relation.relname || '_migrator_select')::name
        and policy.polroles = array[migrator_role_oid]::oid[]
        and policy.polcmd = 'r'
        and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
        and policy.polwithcheck is null
      )
    );

  select count(*)::integer into exact_backup_policy_count
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
          = any(case when private_relation_count = 59 then legacy_relations else successor_relations end)
    and policy.polname = (relation.relname || '_logical_backup_select')::name
    and policy.polpermissive
    and policy.polcmd = 'r'
    and policy.polroles = array[0]::oid[]
    and policy.polwithcheck is null
    and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false)
          = expected_policy_expression;

  select count(*)::integer into kernel_relation_count
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'pintpath_ops'
    and relation.relname = any(array[
      'reviewed_price_promotion_operations',
      'reviewed_price_promotion_rows'
    ])
    and relation.relkind in ('r', 'p');
  select count(*)::integer into kernel_routine_count
  from pg_catalog.pg_proc as routine
  join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
  where namespace.nspname = 'pintpath_ops'
    and routine.proname = any(array[
      'apply_reviewed_price_promotion',
      'quarantine_reviewed_price_promotion'
    ]);
  select count(*)::integer into existing_kernel_role_count
  from pg_catalog.pg_roles as role
  where role.rolname = any(array[
    apply_owner_name,
    quarantine_owner_name,
    apply_execute_name,
    quarantine_execute_name
  ]);

  if actual_relations = legacy_relations then
    if restore_source_database_oid_text is not null then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_kernel_restore_binding_unsafe';
    end if;
    if force_rls_relation_count <> 59
       or exact_base_policy_count <> 177
       or not (
         (private_policy_count = 177 and exact_backup_policy_count = 0)
         or (private_policy_count = 236 and exact_backup_policy_count = 59)
       )
       or kernel_relation_count <> 0
       or kernel_routine_count <> 0
       or existing_kernel_role_count <> 0 then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_kernel_legacy_state_unsafe';
    end if;
  elsif actual_relations = successor_relations then
    if force_rls_relation_count <> 61
       or exact_base_policy_count <> 179
       or private_policy_count <> 240
       or exact_backup_policy_count <> 61
       or kernel_relation_count <> 2
       or kernel_routine_count <> 2
       or existing_kernel_role_count not in (0, 4) then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_kernel_successor_state_unsafe';
    end if;
    if existing_kernel_role_count = 4
       and restore_source_database_oid_text is not null then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_kernel_restore_binding_unsafe';
    end if;
  else
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_relation_inventory_unsafe';
  end if;

  -- If the legacy scoped backup role exists, reject unsafe attributes before
  -- extending it. The exhaustive successor ACL/dependency check below remains
  -- authoritative and rolls the transaction back on any drift.
  select role.oid into backup_role_oid
  from pg_catalog.pg_roles as role
  where role.rolname = backup_role_name;
  if backup_role_oid is not null and exists (
    select 1 from pg_catalog.pg_roles as role
    where role.oid = backup_role_oid
      and (
        role.rolcanlogin or role.rolsuper or role.rolcreatedb
        or role.rolcreaterole or role.rolinherit or role.rolreplication
        or role.rolbypassrls
        or role.rolconnlimit <> -1
        or role.rolvaliduntil is not null
        or exists (
          select 1 from pg_catalog.pg_auth_members as membership
          where membership.member = role.oid or membership.roleid = role.oid
        )
        or exists (
          select 1 from pg_catalog.pg_db_role_setting as setting
          where setting.setrole = role.oid
        )
      )
  ) then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_kernel_backup_role_unsafe';
  end if;
  if private_policy_count = 177 and backup_role_oid is not null then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_backup_state_mixed';
  end if;
  if actual_relations = legacy_relations and backup_role_oid is not null and (
    (select count(*) from pg_catalog.pg_shdepend as dependency
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = backup_role_oid) <> 61
    or (select count(*) from pg_catalog.pg_namespace as namespace
      cross join lateral pg_catalog.aclexplode(coalesce(
        namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
      )) as privilege
      where privilege.grantee = backup_role_oid
        and namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
        and privilege.privilege_type = 'USAGE'
        and not privilege.is_grantable) <> 2
    or (select count(*) from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(coalesce(
        relation.relacl, pg_catalog.acldefault('r', relation.relowner)
      )) as privilege
      where privilege.grantee = backup_role_oid
        and pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
              = any(legacy_relations)
        and relation.relkind in ('r', 'p')
        and privilege.privilege_type = 'SELECT'
        and not privilege.is_grantable) <> 59
    or exists (
      select 1 from pg_catalog.pg_namespace as namespace
      cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
      where namespace.nspacl is not null
        and privilege.grantee = backup_role_oid
        and not (
          namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
          and privilege.privilege_type = 'USAGE'
          and not privilege.is_grantable
        )
    )
    or exists (
      select 1 from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(relation.relacl) as privilege
      where relation.relacl is not null
        and privilege.grantee = backup_role_oid
        and not (
          pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
            = any(legacy_relations)
          and relation.relkind in ('r', 'p')
          and privilege.privilege_type = 'SELECT'
          and not privilege.is_grantable
        )
    )
    or exists (
      select 1 from pg_catalog.pg_shdepend as dependency
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = backup_role_oid
        and not (
          dependency.dbid = current_database_oid
          and dependency.deptype = 'a'
          and dependency.objsubid = 0
          and (
            (
              dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
              and exists (
                select 1 from pg_catalog.pg_namespace as namespace
                where namespace.oid = dependency.objid
                  and namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
              )
            ) or (
              dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              and exists (
                select 1 from pg_catalog.pg_class as relation
                join pg_catalog.pg_namespace as namespace
                  on namespace.oid = relation.relnamespace
                where relation.oid = dependency.objid
                  and pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
                        = any(legacy_relations)
                  and relation.relkind in ('r', 'p')
              )
            )
          )
        )
    )
    or exists (
      select 1 from pg_catalog.pg_proc as routine
      cross join lateral pg_catalog.aclexplode(coalesce(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) as privilege where privilege.grantee = backup_role_oid
    )
    or exists (
      select 1 from pg_catalog.pg_attribute as attribute
      cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
      where attribute.attnum > 0 and not attribute.attisdropped
        and attribute.attacl is not null and privilege.grantee = backup_role_oid
    )
    or exists (
      select 1 from pg_catalog.pg_database as database_object
      cross join lateral pg_catalog.aclexplode(coalesce(
        database_object.datacl,
        pg_catalog.acldefault('d', database_object.datdba)
      )) as privilege where privilege.grantee = backup_role_oid
    )
    or exists (
      select 1 from pg_catalog.pg_shdepend as dependency
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = backup_role_oid and dependency.deptype = 'o'
    )
  ) then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_kernel_legacy_backup_authority_unsafe';
  end if;
  if actual_relations = successor_relations
     and existing_kernel_role_count = 4 and backup_role_oid is null then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_role_state_mixed';
  end if;
  successor_policy_only_upgrade :=
    actual_relations = successor_relations
    and executor_is_superuser
    and existing_kernel_role_count = 0;
  if restore_source_database_oid_text is not null
     and not successor_policy_only_upgrade then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_restore_binding_unsafe';
  end if;
  if successor_policy_only_upgrade then
    if exists (
      select 1
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'pintpath_ops'
        and routine.proname = any(array[
          'apply_reviewed_price_promotion',
          'quarantine_reviewed_price_promotion'
        ])
        and (
          routine.proowner <> schema_owner_oid
          or (select count(*)
            from pg_catalog.aclexplode(coalesce(
              routine.proacl,
              pg_catalog.acldefault('f', routine.proowner)
            )) as privilege) <> 1
          or (select count(*)
            from pg_catalog.aclexplode(coalesce(
              routine.proacl,
              pg_catalog.acldefault('f', routine.proowner)
            )) as privilege
            where privilege.grantor = routine.proowner
              and privilege.grantee = routine.proowner
              and privilege.privilege_type = 'EXECUTE'
              and not privilege.is_grantable) <> 1
        )
    ) then
      raise exception using errcode = '42501',
        message = 'reviewed_price_promotion_kernel_policy_only_owner_unsafe';
    end if;
    select pg_catalog.substring(
      routine.prosrc,
      'pintpath_reviewed_price_apply_owner_d([1-9][0-9]{0,9})'
    ) into source_apply_database_oid_text
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'pintpath_ops'
      and routine.proname = 'apply_reviewed_price_promotion'
      and routine.pronargs = 1
      and routine.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype::oid;
    select pg_catalog.substring(
      routine.prosrc,
      'pintpath_reviewed_price_quarantine_owner_d([1-9][0-9]{0,9})'
    ) into source_quarantine_database_oid_text
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'pintpath_ops'
      and routine.proname = 'quarantine_reviewed_price_promotion'
      and routine.pronargs = 1
      and routine.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype::oid;
    if source_apply_database_oid_text is null
       or source_quarantine_database_oid_text is null
       or source_apply_database_oid_text <> source_quarantine_database_oid_text then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_kernel_policy_only_function_unsafe';
    end if;
    if source_apply_database_oid_text::numeric > 4294967295 then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_kernel_policy_only_function_unsafe';
    end if;
    if source_apply_database_oid_text = current_database_oid_text then
      if restore_source_database_oid_text is not null then
        raise exception using errcode = '55000',
          message = 'reviewed_price_promotion_kernel_restore_binding_unsafe';
      end if;
    else
      if restore_source_database_oid_text is null
         or restore_source_database_oid_text !~ '^[1-9][0-9]{0,9}$' then
        raise exception using errcode = '55000',
          message = 'reviewed_price_promotion_kernel_restore_binding_unsafe';
      end if;
      if restore_source_database_oid_text::numeric > 4294967295
         or restore_source_database_oid_text <> source_apply_database_oid_text then
        raise exception using errcode = '55000',
          message = 'reviewed_price_promotion_kernel_restore_binding_unsafe';
      end if;
    end if;
    source_apply_body := pg_catalog.replace(
      apply_body,
      apply_owner_name,
      'pintpath_reviewed_price_apply_owner_d' || source_apply_database_oid_text
    );
    source_quarantine_body := pg_catalog.replace(
      quarantine_body,
      quarantine_owner_name,
      'pintpath_reviewed_price_quarantine_owner_d' || source_quarantine_database_oid_text
    );
    if (select count(*) from pg_catalog.pg_proc as routine
        join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
        join pg_catalog.pg_language as language on language.oid = routine.prolang
        where namespace.nspname = 'pintpath_ops'
          and routine.proname = 'apply_reviewed_price_promotion'
          and routine.pronargs = 1
          and routine.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype::oid
          and routine.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
          and routine.proargnames = array['request']::text[]
          and language.lanname = 'plpgsql'
          and routine.prokind = 'f'
          and routine.prosecdef and routine.provolatile = 'v'
          and routine.proparallel = 'u' and not routine.proleakproof
          and not routine.proisstrict and not routine.proretset
          and routine.pronargdefaults = 0 and routine.provariadic = 0::oid
          and routine.prosupport = 0::oid
          and routine.procost = 100 and routine.prorows = 0
          and routine.proallargtypes is null and routine.proargmodes is null
          and routine.prosqlbody is null
          and routine.proconfig = array['search_path=pg_catalog']::text[]
          and routine.prosrc = source_apply_body) <> 1
       or (select count(*) from pg_catalog.pg_proc as routine
        join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
        join pg_catalog.pg_language as language on language.oid = routine.prolang
        where namespace.nspname = 'pintpath_ops'
          and routine.proname = 'quarantine_reviewed_price_promotion'
          and routine.pronargs = 1
          and routine.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype::oid
          and routine.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
          and routine.proargnames = array['request']::text[]
          and language.lanname = 'plpgsql'
          and routine.prokind = 'f'
          and routine.prosecdef and routine.provolatile = 'v'
          and routine.proparallel = 'u' and not routine.proleakproof
          and not routine.proisstrict and not routine.proretset
          and routine.pronargdefaults = 0 and routine.provariadic = 0::oid
          and routine.prosupport = 0::oid
          and routine.procost = 100 and routine.prorows = 0
          and routine.proallargtypes is null and routine.proargmodes is null
          and routine.prosqlbody is null
          and routine.proconfig = array['search_path=pg_catalog']::text[]
          and routine.prosrc = source_quarantine_body) <> 1 then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_kernel_policy_only_function_unsafe';
    end if;
    if backup_role_oid is not null and (
      not pg_catalog.has_schema_privilege(
        backup_role_oid, 'pintpath_app', 'USAGE'
      )
      or not pg_catalog.has_schema_privilege(
        backup_role_oid, 'pintpath_ops', 'USAGE'
      )
      or exists (
        select 1
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        where pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
                = any(successor_relations)
          and relation.relkind in ('r', 'p')
          and not pg_catalog.has_table_privilege(
            backup_role_oid, relation.oid, 'SELECT'
          )
      )
      or pg_catalog.has_function_privilege(
        backup_role_oid,
        'pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb)',
        'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        backup_role_oid,
        'pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb)',
        'EXECUTE'
      )
    ) then
      raise exception using errcode = '42501',
        message = 'reviewed_price_promotion_kernel_policy_only_backup_unsafe';
    end if;
    -- pg_dump --no-owner --no-acl preserves the source database OID in these
    -- otherwise portable fail-closed bodies. Only after the complete source
    -- form above is authenticated may this pinned migration substitute the
    -- current target OID before reconstructing target-scoped owners and ACLs.
    execute pg_catalog.format(
      'create or replace function pintpath_ops.apply_reviewed_price_promotion(request pg_catalog.jsonb) returns pg_catalog.jsonb language plpgsql volatile parallel unsafe security definer set search_path = pg_catalog as %L',
      apply_body
    );
    execute pg_catalog.format(
      'create or replace function pintpath_ops.quarantine_reviewed_price_promotion(request pg_catalog.jsonb) returns pg_catalog.jsonb language plpgsql volatile parallel unsafe security definer set search_path = pg_catalog as %L',
      quarantine_body
    );
  end if;

  if actual_relations = legacy_relations then
    create table pintpath_ops.reviewed_price_promotion_operations (
      operation_id uuid not null,
      operation_kind text collate pg_catalog."C" not null,
      source_apply_operation_id uuid,
      candidate_sha text collate pg_catalog."C" not null,
      expected_environment text collate pg_catalog."C" not null,
      authority_bundle_sha256 text collate pg_catalog."C" not null,
      plan_candidate_sha256 text collate pg_catalog."C" not null,
      review_packet_candidate_sha256 text collate pg_catalog."C" not null,
      target_physical_identity_sha256 text collate pg_catalog."C" not null,
      source_snapshot_sha256 text collate pg_catalog."C" not null,
      request_sha256 text collate pg_catalog."C" not null,
      requested_row_count integer not null,
      committed_at timestamptz not null,
      result_state_sha256 text collate pg_catalog."C" not null,
      receipt_sha256 text collate pg_catalog."C" not null,
      constraint reviewed_price_promotion_operations_pkey primary key (operation_id),
      constraint reviewed_price_promotion_operations_source_apply_fkey
        foreign key (source_apply_operation_id)
        references pintpath_ops.reviewed_price_promotion_operations(operation_id)
        on delete no action,
      constraint reviewed_price_promotion_operations_kind_check
        check (operation_kind in ('apply', 'quarantine')),
      constraint reviewed_price_promotion_operations_environment_check
        check (expected_environment in ('permanent-staging', 'production')),
      constraint reviewed_price_promotion_operations_candidate_check
        check (candidate_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
      constraint reviewed_price_promotion_operations_authority_hash_check
        check (authority_bundle_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_operations_plan_hash_check
        check (plan_candidate_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_operations_packet_hash_check
        check (review_packet_candidate_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_operations_target_hash_check
        check (target_physical_identity_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_operations_snapshot_hash_check
        check (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_operations_request_hash_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_operations_result_hash_check
        check (result_state_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_operations_receipt_hash_check
        check (receipt_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_operations_row_count_check
        check (requested_row_count between 1 and 5000),
      constraint reviewed_price_promotion_operations_source_check
        check (
          (operation_kind = 'apply' and source_apply_operation_id is null)
          or (
            operation_kind = 'quarantine'
            and source_apply_operation_id is not null
            and source_apply_operation_id <> operation_id
          )
        )
    );
    create unique index reviewed_price_promotion_operations_receipt_uidx
      on pintpath_ops.reviewed_price_promotion_operations (receipt_sha256);
    create index reviewed_price_promotion_operations_source_apply_idx
      on pintpath_ops.reviewed_price_promotion_operations (source_apply_operation_id)
      where source_apply_operation_id is not null;

    create table pintpath_ops.reviewed_price_promotion_rows (
      operation_id uuid not null,
      row_ordinal integer not null,
      source_ingestion_id uuid not null,
      venue_id uuid not null,
      price_record_id text collate pg_catalog."C" not null,
      venue_beer_id text collate pg_catalog."C" not null,
      normalized_beer_id text collate pg_catalog."C" not null,
      row_request_sha256 text collate pg_catalog."C" not null,
      before_state_sha256 text collate pg_catalog."C" not null,
      after_state_sha256 text collate pg_catalog."C" not null,
      row_receipt_sha256 text collate pg_catalog."C" not null,
      constraint reviewed_price_promotion_rows_pkey
        primary key (operation_id, row_ordinal),
      constraint reviewed_price_promotion_rows_operation_fkey
        foreign key (operation_id)
        references pintpath_ops.reviewed_price_promotion_operations(operation_id)
        on delete no action,
      constraint reviewed_price_promotion_rows_ordinal_check
        check (row_ordinal between 0 and 4999),
      constraint reviewed_price_promotion_rows_price_id_check
        check (octet_length(price_record_id) between 1 and 500),
      constraint reviewed_price_promotion_rows_venue_beer_id_check
        check (octet_length(venue_beer_id) between 1 and 500),
      constraint reviewed_price_promotion_rows_normalized_id_check
        check (octet_length(normalized_beer_id) between 1 and 180),
      constraint reviewed_price_promotion_rows_request_hash_check
        check (row_request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_rows_before_hash_check
        check (before_state_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_rows_after_hash_check
        check (after_state_sha256 ~ '^[0-9a-f]{64}$'),
      constraint reviewed_price_promotion_rows_receipt_hash_check
        check (row_receipt_sha256 ~ '^[0-9a-f]{64}$')
    );
    create unique index reviewed_price_promotion_rows_price_uidx
      on pintpath_ops.reviewed_price_promotion_rows (operation_id, price_record_id);
    create unique index reviewed_price_promotion_rows_venue_beer_uidx
      on pintpath_ops.reviewed_price_promotion_rows (operation_id, venue_beer_id);
    create unique index reviewed_price_promotion_rows_receipt_uidx
      on pintpath_ops.reviewed_price_promotion_rows (operation_id, row_receipt_sha256);

    alter table pintpath_ops.reviewed_price_promotion_operations enable row level security;
    alter table pintpath_ops.reviewed_price_promotion_operations force row level security;
    alter table pintpath_ops.reviewed_price_promotion_rows enable row level security;
    alter table pintpath_ops.reviewed_price_promotion_rows force row level security;

    create policy reviewed_price_promotion_operations_migrator_select
      on pintpath_ops.reviewed_price_promotion_operations
      for select to pintpath_migrator using (true);
    create policy reviewed_price_promotion_rows_migrator_select
      on pintpath_ops.reviewed_price_promotion_rows
      for select to pintpath_migrator using (true);
    grant select on table
      pintpath_ops.reviewed_price_promotion_operations,
      pintpath_ops.reviewed_price_promotion_rows
      to pintpath_migrator;

    if exact_backup_policy_count = 0 then
      for target in
        select namespace.nspname as schema_name, relation.relname as relation_name
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        where pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
                = any(successor_relations)
          and relation.relkind in ('r', 'p')
        order by namespace.nspname collate "C", relation.relname collate "C"
      loop
        execute pg_catalog.format(
          'create policy %I on %I.%I as permissive for select to public using (current_user = (''pintpath_logical_backup_d'' || (select database.oid::text from pg_catalog.pg_database as database where database.datname = pg_catalog.current_database())))',
          target.relation_name || '_logical_backup_select',
          target.schema_name,
          target.relation_name
        );
      end loop;
    else
      create policy reviewed_price_promotion_operations_logical_backup_select
        on pintpath_ops.reviewed_price_promotion_operations
        for select to public
        using (current_user = ('pintpath_logical_backup_d'::text || (
          select database.oid::text from pg_catalog.pg_database as database
          where database.datname = pg_catalog.current_database()
        )));
      create policy reviewed_price_promotion_rows_logical_backup_select
        on pintpath_ops.reviewed_price_promotion_rows
        for select to public
        using (current_user = ('pintpath_logical_backup_d'::text || (
          select database.oid::text from pg_catalog.pg_database as database
          where database.datname = pg_catalog.current_database()
        )));
    end if;

    execute pg_catalog.format(
      'create function pintpath_ops.apply_reviewed_price_promotion(request pg_catalog.jsonb) returns pg_catalog.jsonb language plpgsql volatile parallel unsafe security definer set search_path = pg_catalog as %L',
      apply_body
    );
    execute pg_catalog.format(
      'create function pintpath_ops.quarantine_reviewed_price_promotion(request pg_catalog.jsonb) returns pg_catalog.jsonb language plpgsql volatile parallel unsafe security definer set search_path = pg_catalog as %L',
      quarantine_body
    );
    revoke all on function pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) from public;
    revoke all on function pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb) from public;
    revoke all on function pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb)
      from pintpath_runtime, pintpath_migrator;
    revoke all on function pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb)
      from pintpath_runtime, pintpath_migrator;
    foreach api_role_name in array array['anon', 'authenticated', 'service_role'] loop
      if pg_catalog.to_regrole(api_role_name) is not null then
        execute pg_catalog.format(
          'revoke all on function pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) from %I',
          api_role_name
        );
        execute pg_catalog.format(
          'revoke all on function pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb) from %I',
          api_role_name
        );
      end if;
    end loop;
  end if;

  -- Create or extend the scoped backup authority only when a true superuser can
  -- safely create the cluster role. Portable RLS policies remain useful in the
  -- exact policy-only state after archive restore.
  if (actual_relations = legacy_relations or successor_policy_only_upgrade)
     and backup_role_oid is null and executor_is_superuser then
    execute pg_catalog.format(
      'create role %I nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
      backup_role_name
    );
    select role.oid into strict backup_role_oid
    from pg_catalog.pg_roles as role where role.rolname = backup_role_name;
  end if;
  if (actual_relations = legacy_relations or successor_policy_only_upgrade)
     and backup_role_oid is not null then
    execute pg_catalog.format(
      'grant usage on schema pintpath_app, pintpath_ops to %I', backup_role_name
    );
    for target in
      select namespace.nspname as schema_name, relation.relname as relation_name
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
              = any(successor_relations)
        and relation.relkind in ('r', 'p')
      order by namespace.nspname collate "C", relation.relname collate "C"
    loop
      execute pg_catalog.format(
        'grant select on %I.%I to %I',
        target.schema_name, target.relation_name, backup_role_name
      );
    end loop;
    execute pg_catalog.format(
      'revoke all on function pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) from %I',
      backup_role_name
    );
    execute pg_catalog.format(
      'revoke all on function pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb) from %I',
      backup_role_name
    );
  end if;

  select count(*)::integer into existing_kernel_role_count
  from pg_catalog.pg_roles as role
  where role.rolname = any(array[
    apply_owner_name,
    quarantine_owner_name,
    apply_execute_name,
    quarantine_execute_name
  ]);
  if existing_kernel_role_count not in (0, 4) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_role_state_mixed';
  end if;
  if (actual_relations = legacy_relations or successor_policy_only_upgrade)
     and existing_kernel_role_count = 0 and executor_is_superuser then
    foreach role_name in array array[
      apply_owner_name,
      quarantine_owner_name,
      apply_execute_name,
      quarantine_execute_name
    ] loop
      execute pg_catalog.format(
        'create role %I nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
        role_name
      );
    end loop;
  end if;

  select role.oid into apply_owner_oid from pg_catalog.pg_roles as role
    where role.rolname = apply_owner_name;
  select role.oid into quarantine_owner_oid from pg_catalog.pg_roles as role
    where role.rolname = quarantine_owner_name;
  select role.oid into apply_execute_oid from pg_catalog.pg_roles as role
    where role.rolname = apply_execute_name;
  select role.oid into quarantine_execute_oid from pg_catalog.pg_roles as role
    where role.rolname = quarantine_execute_name;
  if (actual_relations = legacy_relations or successor_policy_only_upgrade)
     and executor_is_superuser then
    if apply_owner_oid is null or quarantine_owner_oid is null
       or apply_execute_oid is null or quarantine_execute_oid is null then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_kernel_role_state_incomplete';
    end if;
    execute pg_catalog.format(
      'alter function pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) owner to %I',
      apply_owner_name
    );
    execute pg_catalog.format(
      'alter function pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb) owner to %I',
      quarantine_owner_name
    );
    execute pg_catalog.format(
      'grant usage on schema pintpath_ops to %I', apply_execute_name
    );
    execute pg_catalog.format(
      'grant usage on schema pintpath_ops to %I', quarantine_execute_name
    );
    execute pg_catalog.format(
      'grant execute on function pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) to %I',
      apply_execute_name
    );
    execute pg_catalog.format(
      'grant execute on function pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb) to %I',
      quarantine_execute_name
    );
  end if;

  -- Recompute the portable policy inventory after all DDL.
  select count(*)::integer into private_policy_count
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = any(array['pintpath_app', 'pintpath_ops']);
  select count(*)::integer into exact_backup_policy_count
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
          = any(successor_relations)
    and policy.polname = (relation.relname || '_logical_backup_select')::name
    and policy.polpermissive
    and policy.polcmd = 'r'
    and policy.polroles = array[0]::oid[]
    and policy.polwithcheck is null
    and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false)
          = expected_policy_expression;
  select count(*)::integer,
         count(*) filter (where relation.relrowsecurity and relation.relforcerowsecurity)::integer
    into private_relation_count, force_rls_relation_count
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
    and relation.relkind in ('r', 'p');
  if private_relation_count <> 61
     or force_rls_relation_count <> 61
     or private_policy_count <> 240
     or exact_backup_policy_count <> 61 then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_portable_postcondition_failed';
  end if;

  -- This migration contains no enabled mutation path, so any ledger row is
  -- necessarily out-of-band. ACCESS EXCLUSIVE locks remain held until commit;
  -- temporarily relaxing FORCE RLS lets the exact table owner prove emptiness
  -- in the policy-only state without exposing a concurrent bypass window.
  alter table pintpath_ops.reviewed_price_promotion_rows
    no force row level security;
  alter table pintpath_ops.reviewed_price_promotion_operations
    no force row level security;
  if exists (
    select 1 from pintpath_ops.reviewed_price_promotion_operations
  ) or exists (
    select 1 from pintpath_ops.reviewed_price_promotion_rows
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_inert_ledger_not_empty';
  end if;
  alter table pintpath_ops.reviewed_price_promotion_operations
    force row level security;
  alter table pintpath_ops.reviewed_price_promotion_rows
    force row level security;

  -- Exact table-column and default inventory. No hidden default, generated, or
  -- identity column may mint mutable authority outside a reviewed request.
  if exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'pintpath_ops'
      and relation.relname = any(array[
        'reviewed_price_promotion_operations',
        'reviewed_price_promotion_rows'
      ])
      and (
        relation.relkind <> 'r'
        or relation.relpersistence <> 'p'
        or relation.relispartition
        or relation.relam <> (
          select access_method.oid
          from pg_catalog.pg_am as access_method
          where access_method.amname = 'heap' and access_method.amtype = 't'
        )
        or relation.reltablespace <> 0::oid
        or relation.reloptions is not null
        or relation.relpartbound is not null
        or relation.relrowsecurity is not true
        or relation.relforcerowsecurity is not true
        or relation.relreplident <> 'd'
        or exists (
          select 1 from pg_catalog.pg_inherits as inheritance
          where inheritance.inhrelid = relation.oid
             or inheritance.inhparent = relation.oid
        )
        or exists (
          select 1 from pg_catalog.pg_trigger as trigger_object
          where trigger_object.tgrelid = relation.oid
            and not trigger_object.tgisinternal
        )
        or exists (
          select 1 from pg_catalog.pg_rewrite as rewrite_rule
          where rewrite_rule.ev_class = relation.oid
            and rewrite_rule.rulename <> '_RETURN'
        )
      )
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_relation_contract_unsafe';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_publication_rel as publication_relation
    where publication_relation.prrelid = any(array[
      'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass,
      'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass
    ])
  ) or exists (
    select 1 from pg_catalog.pg_publication as publication
    where publication.puballtables
  ) or exists (
    select 1
    from pg_catalog.pg_publication_namespace as publication_namespace
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = publication_namespace.pnnspid
    where namespace.nspname = 'pintpath_ops'
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_publication_unsafe';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_depend as dependency
    where dependency.deptype = 'e'
      and (
        (
          dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          and exists (
            select 1
            from pg_catalog.pg_class as catalog_relation
            join pg_catalog.pg_namespace as namespace
              on namespace.oid = catalog_relation.relnamespace
            where catalog_relation.oid = dependency.objid
              and namespace.nspname = 'pintpath_ops'
              and (
                catalog_relation.relname = any(array[
                  'reviewed_price_promotion_operations',
                  'reviewed_price_promotion_rows'
                ])
                or catalog_relation.oid in (
                  select index_object.indexrelid
                  from pg_catalog.pg_index as index_object
                  where index_object.indrelid = any(array[
                    'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass,
                    'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass
                  ])
                )
              )
          )
        )
        or (
          dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          and exists (
            select 1 from pg_catalog.pg_constraint as constraint_object
            where constraint_object.oid = dependency.objid
              and constraint_object.conrelid = any(array[
                'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass,
                'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass
              ])
          )
        )
        or (
          dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and exists (
            select 1
            from pg_catalog.pg_proc as routine
            join pg_catalog.pg_namespace as namespace
              on namespace.oid = routine.pronamespace
            where routine.oid = dependency.objid
              and namespace.nspname = 'pintpath_ops'
              and routine.proname = any(array[
                'apply_reviewed_price_promotion',
                'quarantine_reviewed_price_promotion'
              ])
              and routine.pronargs = 1
              and routine.proargtypes[0] =
                'pg_catalog.jsonb'::pg_catalog.regtype::oid
          )
        )
      )
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_extension_dependency_unsafe';
  end if;
  if (
    select array_agg(
      pg_catalog.format('%s:%s:%s:%s:%s',
        attribute.attname,
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
        attribute.attnotnull,
        attribute.attidentity,
        attribute.attgenerated
      ) order by attribute.attnum
    )
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid =
      'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass
      and attribute.attnum > 0 and not attribute.attisdropped
  ) is distinct from array[
    'operation_id:uuid:t::',
    'operation_kind:text:t::',
    'source_apply_operation_id:uuid:f::',
    'candidate_sha:text:t::',
    'expected_environment:text:t::',
    'authority_bundle_sha256:text:t::',
    'plan_candidate_sha256:text:t::',
    'review_packet_candidate_sha256:text:t::',
    'target_physical_identity_sha256:text:t::',
    'source_snapshot_sha256:text:t::',
    'request_sha256:text:t::',
    'requested_row_count:integer:t::',
    'committed_at:timestamp with time zone:t::',
    'result_state_sha256:text:t::',
    'receipt_sha256:text:t::'
  ]::text[] or exists (
    select 1 from pg_catalog.pg_attrdef as default_value
    where default_value.adrelid =
      'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_operation_columns_unsafe';
  end if;
  if (
    select array_agg(
      pg_catalog.format('%s:%s:%s:%s:%s',
        attribute.attname,
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
        attribute.attnotnull,
        attribute.attidentity,
        attribute.attgenerated
      ) order by attribute.attnum
    )
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid =
      'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass
      and attribute.attnum > 0 and not attribute.attisdropped
  ) is distinct from array[
    'operation_id:uuid:t::',
    'row_ordinal:integer:t::',
    'source_ingestion_id:uuid:t::',
    'venue_id:uuid:t::',
    'price_record_id:text:t::',
    'venue_beer_id:text:t::',
    'normalized_beer_id:text:t::',
    'row_request_sha256:text:t::',
    'before_state_sha256:text:t::',
    'after_state_sha256:text:t::',
    'row_receipt_sha256:text:t::'
  ]::text[] or exists (
    select 1 from pg_catalog.pg_attrdef as default_value
    where default_value.adrelid =
      'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_row_columns_unsafe';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = any(array[
      'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass,
      'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass
    ])
      and attribute.attnum > 0 and not attribute.attisdropped
      and (
        (
          attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
          and attribute.attcollation <>
            'pg_catalog."C"'::pg_catalog.regcollation::oid
        )
        or (
          attribute.atttypid <> 'pg_catalog.text'::pg_catalog.regtype
          and attribute.attcollation <> 0::oid
        )
      )
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_column_collation_unsafe';
  end if;

  if (
    select array_agg(
      pg_catalog.format('%s:%s:%s',
        constraint_object.conname,
        constraint_object.contype,
        pg_catalog.pg_get_constraintdef(constraint_object.oid, false)
      ) order by constraint_object.conname collate "C"
    )
    from pg_catalog.pg_constraint as constraint_object
    where constraint_object.conrelid =
      'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass
  ) is distinct from array[
    'reviewed_price_promotion_operations_authority_hash_check:c:CHECK ((authority_bundle_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_operations_candidate_check:c:CHECK ((candidate_sha ~ ''^(?:[0-9a-f]{40}|[0-9a-f]{64})$''::text))',
    'reviewed_price_promotion_operations_environment_check:c:CHECK ((expected_environment = ANY (ARRAY[''permanent-staging''::text, ''production''::text])))',
    'reviewed_price_promotion_operations_kind_check:c:CHECK ((operation_kind = ANY (ARRAY[''apply''::text, ''quarantine''::text])))',
    'reviewed_price_promotion_operations_packet_hash_check:c:CHECK ((review_packet_candidate_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_operations_pkey:p:PRIMARY KEY (operation_id)',
    'reviewed_price_promotion_operations_plan_hash_check:c:CHECK ((plan_candidate_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_operations_receipt_hash_check:c:CHECK ((receipt_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_operations_request_hash_check:c:CHECK ((request_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_operations_result_hash_check:c:CHECK ((result_state_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_operations_row_count_check:c:CHECK (((requested_row_count >= 1) AND (requested_row_count <= 5000)))',
    'reviewed_price_promotion_operations_snapshot_hash_check:c:CHECK ((source_snapshot_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_operations_source_apply_fkey:f:FOREIGN KEY (source_apply_operation_id) REFERENCES pintpath_ops.reviewed_price_promotion_operations(operation_id)',
    'reviewed_price_promotion_operations_source_check:c:CHECK ((((operation_kind = ''apply''::text) AND (source_apply_operation_id IS NULL)) OR ((operation_kind = ''quarantine''::text) AND (source_apply_operation_id IS NOT NULL) AND (source_apply_operation_id <> operation_id))))',
    'reviewed_price_promotion_operations_target_hash_check:c:CHECK ((target_physical_identity_sha256 ~ ''^[0-9a-f]{64}$''::text))'
  ]::text[] or exists (
    select 1 from pg_catalog.pg_constraint as constraint_object
    where constraint_object.conrelid =
      'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass
      and (
        not constraint_object.convalidated
        or constraint_object.condeferrable
        or constraint_object.condeferred
        or (constraint_object.contype = 'c' and constraint_object.connoinherit)
        or (
          constraint_object.contype = 'f'
          and constraint_object.confdeltype <> 'a'
        )
      )
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_operation_constraints_unsafe';
  end if;
  if (
    select array_agg(
      pg_catalog.format('%s:%s:%s',
        constraint_object.conname,
        constraint_object.contype,
        pg_catalog.pg_get_constraintdef(constraint_object.oid, false)
      ) order by constraint_object.conname collate "C"
    )
    from pg_catalog.pg_constraint as constraint_object
    where constraint_object.conrelid =
      'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass
  ) is distinct from array[
    'reviewed_price_promotion_rows_after_hash_check:c:CHECK ((after_state_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_rows_before_hash_check:c:CHECK ((before_state_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_rows_normalized_id_check:c:CHECK (((octet_length(normalized_beer_id) >= 1) AND (octet_length(normalized_beer_id) <= 180)))',
    'reviewed_price_promotion_rows_operation_fkey:f:FOREIGN KEY (operation_id) REFERENCES pintpath_ops.reviewed_price_promotion_operations(operation_id)',
    'reviewed_price_promotion_rows_ordinal_check:c:CHECK (((row_ordinal >= 0) AND (row_ordinal <= 4999)))',
    'reviewed_price_promotion_rows_pkey:p:PRIMARY KEY (operation_id, row_ordinal)',
    'reviewed_price_promotion_rows_price_id_check:c:CHECK (((octet_length(price_record_id) >= 1) AND (octet_length(price_record_id) <= 500)))',
    'reviewed_price_promotion_rows_receipt_hash_check:c:CHECK ((row_receipt_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_rows_request_hash_check:c:CHECK ((row_request_sha256 ~ ''^[0-9a-f]{64}$''::text))',
    'reviewed_price_promotion_rows_venue_beer_id_check:c:CHECK (((octet_length(venue_beer_id) >= 1) AND (octet_length(venue_beer_id) <= 500)))'
  ]::text[] or exists (
    select 1 from pg_catalog.pg_constraint as constraint_object
    where constraint_object.conrelid =
      'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass
      and (
        not constraint_object.convalidated
        or constraint_object.condeferrable
        or constraint_object.condeferred
        or (constraint_object.contype = 'c' and constraint_object.connoinherit)
        or (
          constraint_object.contype = 'f'
          and constraint_object.confdeltype <> 'a'
        )
      )
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_row_constraints_unsafe';
  end if;

  if (select count(*)
      from pg_catalog.pg_trigger as trigger_object
      join pg_catalog.pg_class as relation on relation.oid = trigger_object.tgrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      join pg_catalog.pg_constraint as constraint_object
        on constraint_object.oid = trigger_object.tgconstraint
      where namespace.nspname = 'pintpath_ops'
        and relation.relname = any(array[
          'reviewed_price_promotion_operations',
          'reviewed_price_promotion_rows'
        ])
        and constraint_object.conname = any(array[
          'reviewed_price_promotion_operations_source_apply_fkey',
          'reviewed_price_promotion_rows_operation_fkey'
        ])
        and trigger_object.tgisinternal
        and trigger_object.tgenabled = 'O'
        and trigger_object.tgparentid = 0::oid) <> 8
     or exists (
       select 1
       from pg_catalog.pg_trigger as trigger_object
       join pg_catalog.pg_class as relation on relation.oid = trigger_object.tgrelid
       join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'pintpath_ops'
         and relation.relname = any(array[
           'reviewed_price_promotion_operations',
           'reviewed_price_promotion_rows'
         ])
         and trigger_object.tgisinternal
         and (
           trigger_object.tgenabled <> 'O'
           or trigger_object.tgconstraint = 0::oid
           or trigger_object.tgparentid <> 0::oid
           or not exists (
             select 1 from pg_catalog.pg_constraint as constraint_object
             where constraint_object.oid = trigger_object.tgconstraint
               and constraint_object.conname = any(array[
                 'reviewed_price_promotion_operations_source_apply_fkey',
                 'reviewed_price_promotion_rows_operation_fkey'
               ])
           )
         )
     )
     or exists (
       select 1
       from (values
         ('reviewed_price_promotion_operations_source_apply_fkey'::text),
         ('reviewed_price_promotion_rows_operation_fkey'::text)
       ) as expected_constraint(constraint_name)
       where (select count(*)
         from pg_catalog.pg_trigger as trigger_object
         join pg_catalog.pg_constraint as constraint_object
           on constraint_object.oid = trigger_object.tgconstraint
         where constraint_object.conname = expected_constraint.constraint_name
           and trigger_object.tgisinternal
           and trigger_object.tgenabled = 'O') <> 4
     ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_fk_trigger_unsafe';
  end if;

  if (
    select array_agg(
      pg_catalog.format('%s:%s:%s:%s',
        index_relation.relname,
        index_object.indisunique,
        index_object.indisprimary,
        pg_catalog.pg_get_indexdef(index_relation.oid)
      ) order by index_relation.relname collate "C"
    )
    from pg_catalog.pg_index as index_object
    join pg_catalog.pg_class as index_relation
      on index_relation.oid = index_object.indexrelid
    where index_object.indrelid =
      'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass
  ) is distinct from array[
    'reviewed_price_promotion_operations_pkey:t:t:CREATE UNIQUE INDEX reviewed_price_promotion_operations_pkey ON pintpath_ops.reviewed_price_promotion_operations USING btree (operation_id)',
    'reviewed_price_promotion_operations_receipt_uidx:t:f:CREATE UNIQUE INDEX reviewed_price_promotion_operations_receipt_uidx ON pintpath_ops.reviewed_price_promotion_operations USING btree (receipt_sha256)',
    'reviewed_price_promotion_operations_source_apply_idx:f:f:CREATE INDEX reviewed_price_promotion_operations_source_apply_idx ON pintpath_ops.reviewed_price_promotion_operations USING btree (source_apply_operation_id) WHERE (source_apply_operation_id IS NOT NULL)'
  ]::text[] or (
    select array_agg(
      pg_catalog.format('%s:%s:%s:%s',
        index_relation.relname,
        index_object.indisunique,
        index_object.indisprimary,
        pg_catalog.pg_get_indexdef(index_relation.oid)
      ) order by index_relation.relname collate "C"
    )
    from pg_catalog.pg_index as index_object
    join pg_catalog.pg_class as index_relation
      on index_relation.oid = index_object.indexrelid
    where index_object.indrelid =
      'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass
  ) is distinct from array[
    'reviewed_price_promotion_rows_pkey:t:t:CREATE UNIQUE INDEX reviewed_price_promotion_rows_pkey ON pintpath_ops.reviewed_price_promotion_rows USING btree (operation_id, row_ordinal)',
    'reviewed_price_promotion_rows_price_uidx:t:f:CREATE UNIQUE INDEX reviewed_price_promotion_rows_price_uidx ON pintpath_ops.reviewed_price_promotion_rows USING btree (operation_id, price_record_id)',
    'reviewed_price_promotion_rows_receipt_uidx:t:f:CREATE UNIQUE INDEX reviewed_price_promotion_rows_receipt_uidx ON pintpath_ops.reviewed_price_promotion_rows USING btree (operation_id, row_receipt_sha256)',
    'reviewed_price_promotion_rows_venue_beer_uidx:t:f:CREATE UNIQUE INDEX reviewed_price_promotion_rows_venue_beer_uidx ON pintpath_ops.reviewed_price_promotion_rows USING btree (operation_id, venue_beer_id)'
  ]::text[] or exists (
    select 1
    from pg_catalog.pg_index as index_object
    join pg_catalog.pg_class as relation on relation.oid = index_object.indrelid
    where relation.oid = any(array[
      'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass,
      'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass
    ])
      and (
        not index_object.indisvalid
        or not index_object.indisready
        or not index_object.indislive
        or not index_object.indimmediate
        or index_object.indcheckxmin
        or index_object.indisclustered
        or index_object.indisreplident
        or index_object.indnullsnotdistinct
      )
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_index_inventory_unsafe';
  end if;

  -- Functions must remain exact and must not inspect request bytes. The body is
  -- compared byte-for-byte and the function ACL is checked below.
  if (select count(*) from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      join pg_catalog.pg_language as language on language.oid = routine.prolang
      where namespace.nspname = 'pintpath_ops'
        and routine.proname = 'apply_reviewed_price_promotion'
        and routine.pronargs = 1
        and routine.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype::oid
        and routine.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
        and routine.proargnames = array['request']::text[]
        and language.lanname = 'plpgsql'
        and routine.prokind = 'f'
        and routine.prosecdef and routine.provolatile = 'v'
        and routine.proparallel = 'u' and not routine.proleakproof
        and not routine.proisstrict and not routine.proretset
        and routine.pronargdefaults = 0 and routine.provariadic = 0::oid
        and routine.prosupport = 0::oid
        and routine.procost = 100 and routine.prorows = 0
        and routine.proallargtypes is null and routine.proargmodes is null
        and routine.prosqlbody is null
        and routine.proconfig = array['search_path=pg_catalog']::text[]
        and routine.prosrc = apply_body) <> 1
     or (select count(*) from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      join pg_catalog.pg_language as language on language.oid = routine.prolang
      where namespace.nspname = 'pintpath_ops'
        and routine.proname = 'quarantine_reviewed_price_promotion'
        and routine.pronargs = 1
        and routine.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype::oid
        and routine.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
        and routine.proargnames = array['request']::text[]
        and language.lanname = 'plpgsql'
        and routine.prokind = 'f'
        and routine.prosecdef and routine.provolatile = 'v'
        and routine.proparallel = 'u' and not routine.proleakproof
        and not routine.proisstrict and not routine.proretset
        and routine.pronargdefaults = 0 and routine.provariadic = 0::oid
        and routine.prosupport = 0::oid
        and routine.procost = 100 and routine.prorows = 0
        and routine.proallargtypes is null and routine.proargmodes is null
        and routine.prosqlbody is null
        and routine.proconfig = array['search_path=pg_catalog']::text[]
        and routine.prosrc = quarantine_body) <> 1 then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_kernel_function_contract_unsafe';
  end if;

  -- No login role, runtime role, API role, migrator, PUBLIC, or backup role can
  -- execute either function. Only the exact execute group is present in the
  -- fully reconstructed superuser state; policy-only state has owner-only ACL.
  if exists (
    select 1
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
    cross join lateral pg_catalog.aclexplode(coalesce(
      routine.proacl,
      pg_catalog.acldefault('f', routine.proowner)
    )) as privilege
    where namespace.nspname = 'pintpath_ops'
      and routine.proname = any(array[
        'apply_reviewed_price_promotion',
        'quarantine_reviewed_price_promotion'
      ])
      and (
        privilege.privilege_type <> 'EXECUTE'
        or privilege.is_grantable
        or privilege.grantee not in (
          routine.proowner,
          coalesce(case when routine.proname = 'apply_reviewed_price_promotion'
            then apply_execute_oid else quarantine_execute_oid end, routine.proowner)
        )
      )
  ) then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_kernel_function_acl_unsafe';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'pintpath_ops'
      and routine.proname = any(array[
        'apply_reviewed_price_promotion',
        'quarantine_reviewed_price_promotion'
      ])
      and routine.pronargs = 1
      and routine.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype::oid
      and (
        (select count(*)
          from pg_catalog.aclexplode(coalesce(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )) as privilege)
          <> case when apply_execute_oid is null then 1 else 2 end
        or (select count(*)
          from pg_catalog.aclexplode(coalesce(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )) as privilege
          where privilege.grantor = routine.proowner
            and privilege.grantee = routine.proowner
            and privilege.privilege_type = 'EXECUTE'
            and not privilege.is_grantable) <> 1
        or (
          apply_execute_oid is not null
          and (select count(*)
            from pg_catalog.aclexplode(coalesce(
              routine.proacl,
              pg_catalog.acldefault('f', routine.proowner)
            )) as privilege
            where privilege.grantor = routine.proowner
              and privilege.grantee = case
                when routine.proname = 'apply_reviewed_price_promotion'
                  then apply_execute_oid
                else quarantine_execute_oid
              end
              and privilege.privilege_type = 'EXECUTE'
              and not privilege.is_grantable) <> 1
        )
      )
  ) then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_kernel_function_acl_unsafe';
  end if;
  if apply_execute_oid is null then
    if exists (
      select 1 from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'pintpath_ops'
        and routine.proname = any(array[
          'apply_reviewed_price_promotion',
          'quarantine_reviewed_price_promotion'
        ])
        and routine.proowner <> schema_owner_oid
    ) then
      raise exception using errcode = '42501',
        message = 'reviewed_price_promotion_kernel_provisional_owner_unsafe';
    end if;
  else
    if exists (
      select 1 from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'pintpath_ops'
        and (
          (routine.proname = 'apply_reviewed_price_promotion'
            and routine.proowner <> apply_owner_oid)
          or (routine.proname = 'quarantine_reviewed_price_promotion'
            and routine.proowner <> quarantine_owner_oid)
        )
    ) then
      raise exception using errcode = '42501',
        message = 'reviewed_price_promotion_kernel_function_owner_unsafe';
    end if;
  end if;

  -- Exact negative role attributes and memberships. No activation membership is
  -- introduced by this migration.
  if existing_kernel_role_count = 4 or executor_is_superuser then
    foreach role_name in array array[
      apply_owner_name,
      quarantine_owner_name,
      apply_execute_name,
      quarantine_execute_name
    ] loop
      if not exists (
        select 1 from pg_catalog.pg_roles as role
        where role.rolname = role_name
          and not role.rolcanlogin and not role.rolsuper
          and not role.rolcreatedb and not role.rolcreaterole
          and not role.rolinherit and not role.rolreplication
          and not role.rolbypassrls
          and role.rolconnlimit = -1
          and role.rolvaliduntil is null
          and not exists (
            select 1 from pg_catalog.pg_auth_members as membership
            where membership.member = role.oid or membership.roleid = role.oid
          )
          and not exists (
            select 1 from pg_catalog.pg_db_role_setting as setting
            where setting.setrole = role.oid
          )
      ) then
        raise exception using errcode = '42501',
          message = 'reviewed_price_promotion_kernel_scoped_role_unsafe';
      end if;
    end loop;
  end if;

  if backup_role_oid is not null and (
    (select count(*) from pg_catalog.pg_shdepend as dependency
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = backup_role_oid) <> 63
    or (select count(*) from pg_catalog.pg_namespace as namespace
      cross join lateral pg_catalog.aclexplode(coalesce(
        namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
      )) as privilege
      where privilege.grantee = backup_role_oid
        and namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
        and privilege.privilege_type = 'USAGE'
        and not privilege.is_grantable) <> 2
    or (select count(*) from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(coalesce(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )) as privilege
      where privilege.grantee = backup_role_oid
        and pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
              = any(successor_relations)
        and relation.relkind in ('r', 'p')
        and privilege.privilege_type = 'SELECT'
        and not privilege.is_grantable) <> 61
    or exists (
      select 1
      from pg_catalog.pg_namespace as namespace
      cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
      where namespace.nspacl is not null
        and privilege.grantee = backup_role_oid
        and not (
          namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
          and privilege.privilege_type = 'USAGE'
          and not privilege.is_grantable
        )
    )
    or exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(relation.relacl) as privilege
      where relation.relacl is not null
        and privilege.grantee = backup_role_oid
        and not (
          pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
            = any(successor_relations)
          and relation.relkind in ('r', 'p')
          and privilege.privilege_type = 'SELECT'
          and not privilege.is_grantable
        )
    )
    or exists (
      select 1 from pg_catalog.pg_shdepend as dependency
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = backup_role_oid
        and not (
          dependency.dbid = current_database_oid
          and dependency.deptype = 'a'
          and dependency.objsubid = 0
          and (
            (
              dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
              and exists (
                select 1 from pg_catalog.pg_namespace as namespace
                where namespace.oid = dependency.objid
                  and namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
              )
            ) or (
              dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              and exists (
                select 1 from pg_catalog.pg_class as relation
                join pg_catalog.pg_namespace as namespace
                  on namespace.oid = relation.relnamespace
                where relation.oid = dependency.objid
                  and pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
                        = any(successor_relations)
                  and relation.relkind in ('r', 'p')
              )
            )
          )
        )
    )
    or exists (
      select 1 from pg_catalog.pg_proc as routine
      cross join lateral pg_catalog.aclexplode(coalesce(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) as privilege where privilege.grantee = backup_role_oid
    )
    or exists (
      select 1 from pg_catalog.pg_attribute as attribute
      cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
      where attribute.attnum > 0 and not attribute.attisdropped
        and attribute.attacl is not null and privilege.grantee = backup_role_oid
    )
    or exists (
      select 1 from pg_catalog.pg_database as database_object
      cross join lateral pg_catalog.aclexplode(coalesce(
        database_object.datacl,
        pg_catalog.acldefault('d', database_object.datdba)
      )) as privilege where privilege.grantee = backup_role_oid
    )
    or exists (
      select 1 from pg_catalog.pg_shdepend as dependency
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = backup_role_oid and dependency.deptype = 'o'
    )
  ) then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_kernel_backup_authority_unsafe';
  end if;

  if apply_execute_oid is not null then
    if exists (
      select 1
      from (values
        (apply_owner_oid, 'apply_reviewed_price_promotion'::text),
        (quarantine_owner_oid, 'quarantine_reviewed_price_promotion'::text)
      ) as expected_owner(role_oid, routine_name)
      where expected_owner.role_oid is null
        or (select count(*) from pg_catalog.pg_shdepend as dependency
          where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            and dependency.refobjid = expected_owner.role_oid) <> 1
        or (select count(*) from pg_catalog.pg_proc as routine
          join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
          where routine.proowner = expected_owner.role_oid
            and namespace.nspname = 'pintpath_ops'
            and routine.proname = expected_owner.routine_name
            and routine.pronargs = 1
            and routine.proargtypes[0] =
              'pg_catalog.jsonb'::pg_catalog.regtype::oid) <> 1
        or exists (
          select 1 from pg_catalog.pg_shdepend as dependency
          where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            and dependency.refobjid = expected_owner.role_oid
            and not (
              dependency.dbid = current_database_oid
              and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
              and dependency.objsubid = 0 and dependency.deptype = 'o'
              and exists (
                select 1 from pg_catalog.pg_proc as routine
                join pg_catalog.pg_namespace as namespace
                  on namespace.oid = routine.pronamespace
                where routine.oid = dependency.objid
                  and namespace.nspname = 'pintpath_ops'
                  and routine.proname = expected_owner.routine_name
                  and routine.pronargs = 1
                  and routine.proargtypes[0] =
                    'pg_catalog.jsonb'::pg_catalog.regtype::oid
              )
            )
        )
        or exists (
          select 1 from pg_catalog.pg_namespace as namespace
          cross join lateral pg_catalog.aclexplode(coalesce(
            namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
          )) as privilege where privilege.grantee = expected_owner.role_oid
        )
        or exists (
          select 1 from pg_catalog.pg_class as relation
          cross join lateral pg_catalog.aclexplode(coalesce(
            relation.relacl, pg_catalog.acldefault('r', relation.relowner)
          )) as privilege where privilege.grantee = expected_owner.role_oid
        )
        or exists (
          select 1 from pg_catalog.pg_database as database_object
          cross join lateral pg_catalog.aclexplode(coalesce(
            database_object.datacl,
            pg_catalog.acldefault('d', database_object.datdba)
          )) as privilege where privilege.grantee = expected_owner.role_oid
        )
    ) then
      raise exception using errcode = '42501',
        message = 'reviewed_price_promotion_kernel_owner_authority_unsafe';
    end if;

    if exists (
      select 1
      from (values
        (apply_execute_oid, 'apply_reviewed_price_promotion'::text),
        (quarantine_execute_oid, 'quarantine_reviewed_price_promotion'::text)
      ) as expected_executor(role_oid, routine_name)
      where expected_executor.role_oid is null
        or (select count(*) from pg_catalog.pg_shdepend as dependency
          where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            and dependency.refobjid = expected_executor.role_oid) <> 2
        or (select count(*) from pg_catalog.pg_namespace as namespace
          cross join lateral pg_catalog.aclexplode(coalesce(
            namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
          )) as privilege
          where privilege.grantee = expected_executor.role_oid
            and namespace.nspname = 'pintpath_ops'
            and privilege.privilege_type = 'USAGE'
            and not privilege.is_grantable) <> 1
        or exists (
          select 1
          from pg_catalog.pg_namespace as namespace
          cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
          where namespace.nspacl is not null
            and privilege.grantee = expected_executor.role_oid
            and not (
              namespace.nspname = 'pintpath_ops'
              and privilege.privilege_type = 'USAGE'
              and not privilege.is_grantable
            )
        )
        or (select count(*) from pg_catalog.pg_proc as routine
          join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
          cross join lateral pg_catalog.aclexplode(coalesce(
            routine.proacl, pg_catalog.acldefault('f', routine.proowner)
          )) as privilege
          where privilege.grantee = expected_executor.role_oid
            and namespace.nspname = 'pintpath_ops'
            and routine.proname = expected_executor.routine_name
            and routine.pronargs = 1
            and routine.proargtypes[0] =
              'pg_catalog.jsonb'::pg_catalog.regtype::oid
            and privilege.privilege_type = 'EXECUTE'
            and not privilege.is_grantable) <> 1
        or exists (
          select 1 from pg_catalog.pg_shdepend as dependency
          where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            and dependency.refobjid = expected_executor.role_oid
            and not (
              dependency.dbid = current_database_oid
              and dependency.deptype = 'a'
              and dependency.objsubid = 0
              and (
                (
                  dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
                  and exists (
                    select 1 from pg_catalog.pg_namespace as namespace
                    where namespace.oid = dependency.objid
                      and namespace.nspname = 'pintpath_ops'
                  )
                ) or (
                  dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                  and exists (
                    select 1 from pg_catalog.pg_proc as routine
                    join pg_catalog.pg_namespace as namespace
                      on namespace.oid = routine.pronamespace
                    where routine.oid = dependency.objid
                      and namespace.nspname = 'pintpath_ops'
                      and routine.proname = expected_executor.routine_name
                      and routine.pronargs = 1
                      and routine.proargtypes[0] =
                        'pg_catalog.jsonb'::pg_catalog.regtype::oid
                  )
                )
              )
            )
        )
        or exists (
          select 1 from pg_catalog.pg_class as relation
          cross join lateral pg_catalog.aclexplode(coalesce(
            relation.relacl, pg_catalog.acldefault('r', relation.relowner)
          )) as privilege where privilege.grantee = expected_executor.role_oid
        )
        or exists (
          select 1 from pg_catalog.pg_database as database_object
          cross join lateral pg_catalog.aclexplode(coalesce(
            database_object.datacl,
            pg_catalog.acldefault('d', database_object.datdba)
          )) as privilege where privilege.grantee = expected_executor.role_oid
        )
        or exists (
          select 1 from pg_catalog.pg_class as relation
          where relation.relowner = expected_executor.role_oid
        )
        or exists (
          select 1 from pg_catalog.pg_proc as routine
          where routine.proowner = expected_executor.role_oid
        )
    ) then
      raise exception using errcode = '42501',
        message = 'reviewed_price_promotion_kernel_execute_authority_unsafe';
    end if;
  end if;

  -- The two private schemas admit no object-squatting authority. Application
  -- runtime access exists only on pintpath_app; execute groups exist only on
  -- pintpath_ops; every recorded grant is issued by the exact schema owner.
  if exists (
    select 1
    from pg_catalog.pg_namespace as namespace
    where namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
      and (
        (select count(*)
          from pg_catalog.aclexplode(coalesce(
            namespace.nspacl,
            pg_catalog.acldefault('n', namespace.nspowner)
          )) as privilege)
          <> case
            when namespace.nspname = 'pintpath_app'
              then 4 + case when backup_role_oid is null then 0 else 1 end
            else 3
              + case when backup_role_oid is null then 0 else 1 end
              + case when apply_execute_oid is null then 0 else 2 end
          end
        or exists (
          select 1
          from pg_catalog.aclexplode(coalesce(
            namespace.nspacl,
            pg_catalog.acldefault('n', namespace.nspowner)
          )) as privilege
          where privilege.grantor <> namespace.nspowner
            or privilege.is_grantable
            or not (
              (
                privilege.grantee = namespace.nspowner
                and privilege.privilege_type = any(array['USAGE', 'CREATE'])
              )
              or (
                namespace.nspname = 'pintpath_app'
                and privilege.grantee = runtime_role_oid
                and privilege.privilege_type = 'USAGE'
              )
              or (
                privilege.grantee = migrator_role_oid
                and privilege.privilege_type = 'USAGE'
              )
              or (
                backup_role_oid is not null
                and privilege.grantee = backup_role_oid
                and privilege.privilege_type = 'USAGE'
              )
              or (
                namespace.nspname = 'pintpath_ops'
                and apply_execute_oid is not null
                and privilege.grantee = any(array[
                  apply_execute_oid,
                  quarantine_execute_oid
                ])
                and privilege.privilege_type = 'USAGE'
              )
            )
        )
      )
  ) then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_kernel_schema_acl_unsafe';
  end if;

  -- Runtime and migrator have no DML authority over the inert ledgers. The
  -- migrator's exact SELECT grant is the sole non-owner table privilege apart
  -- from a fully exact logical-backup role.
  if has_table_privilege(runtime_role_oid,
       'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass,
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     or has_table_privilege(runtime_role_oid,
       'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass,
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     or has_table_privilege(migrator_role_oid,
       'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass,
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     or has_table_privilege(migrator_role_oid,
       'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass,
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     or not has_table_privilege(migrator_role_oid,
       'pintpath_ops.reviewed_price_promotion_operations'::pg_catalog.regclass,
       'SELECT')
     or not has_table_privilege(migrator_role_oid,
       'pintpath_ops.reviewed_price_promotion_rows'::pg_catalog.regclass,
       'SELECT')
     or exists (
       select 1
       from pg_catalog.pg_class as relation
       join pg_catalog.pg_namespace as namespace
         on namespace.oid = relation.relnamespace
       where namespace.nspname = 'pintpath_ops'
         and relation.relname = any(array[
           'reviewed_price_promotion_operations',
           'reviewed_price_promotion_rows'
         ])
         and (
           relation.relowner <> schema_owner_oid
           or (select count(*)
             from pg_catalog.aclexplode(coalesce(
               relation.relacl,
               pg_catalog.acldefault('r', relation.relowner)
             )) as privilege) <> case when backup_role_oid is null then 9 else 10 end
           or exists (
             select 1
             from pg_catalog.aclexplode(coalesce(
               relation.relacl,
               pg_catalog.acldefault('r', relation.relowner)
             )) as privilege
             where privilege.grantor <> schema_owner_oid
               or privilege.is_grantable
               or not (
                 (
                   privilege.grantee = schema_owner_oid
                   and privilege.privilege_type = any(array[
                     'INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE',
                     'REFERENCES', 'TRIGGER', 'MAINTAIN'
                   ])
                 )
                 or (
                   privilege.grantee = migrator_role_oid
                   and privilege.privilege_type = 'SELECT'
                 )
                 or (
                   backup_role_oid is not null
                   and privilege.grantee = backup_role_oid
                   and privilege.privilege_type = 'SELECT'
                 )
               )
           )
         )
     )
     or exists (
       select 1
       from pg_catalog.pg_attribute as attribute
       join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
       join pg_catalog.pg_namespace as namespace
         on namespace.oid = relation.relnamespace
       where namespace.nspname = 'pintpath_ops'
         and relation.relname = any(array[
           'reviewed_price_promotion_operations',
           'reviewed_price_promotion_rows'
         ])
         and attribute.attnum > 0 and not attribute.attisdropped
         and attribute.attacl is not null
     ) then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_kernel_table_acl_unsafe';
  end if;
end
$pintpath_kernel$;

commit;
