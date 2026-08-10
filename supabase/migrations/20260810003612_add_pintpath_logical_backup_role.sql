-- Additive upgrade for databases that already applied the original Pint Path
-- PostgreSQL runtime migration. The reusable group role is bound to the
-- current database OID; portable RLS policies derive that same identity at
-- evaluation time and therefore contain no cluster-specific role reference.

begin;

do $$
declare
  current_database_oid oid;
  current_database_oid_text text;
  backup_role_name text;
  backup_role_oid oid;
  runtime_role_oid oid;
  migrator_role_oid oid;
  role_exists boolean;
  role_contract_exact boolean := false;
  migration_state text;
  private_policy_count integer;
  exact_base_policy_count integer;
  exact_policy_count integer;
  reserved_login_role_count integer;
  expected_policy_expression constant text := $policy$(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid
   FROM pg_database database
  WHERE (database.datname = current_database()))))$policy$;
  expected_relations constant text[] := array[
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
  actual_relations text[];
  target record;
  target_policy name;
begin
  perform pg_catalog.pg_advisory_xact_lock(-1516610544307388182);

  select database.oid, database.oid::text
    into strict current_database_oid, current_database_oid_text
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();

  if current_database_oid = 0::oid
     or current_database_oid_text !~ '^[1-9][0-9]{0,9}$' then
    raise exception using
      errcode = '22023',
      message = 'Refusing logical-backup upgrade because the current database OID is not canonical.';
  end if;
  backup_role_name := 'pintpath_logical_backup_d' || current_database_oid_text;

  select pg_catalog.to_regrole('pintpath_runtime')::oid,
         pg_catalog.to_regrole('pintpath_migrator')::oid
    into runtime_role_oid, migrator_role_oid;
  if runtime_role_oid is null or migrator_role_oid is null then
    raise exception using
      errcode = '55000',
      message = 'Refusing logical-backup upgrade because the canonical base roles are absent.';
  end if;

  select array_agg(
    pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    order by namespace.nspname collate "C", relation.relname collate "C"
  ) into actual_relations
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
    and relation.relkind in ('r', 'p');

  if actual_relations is distinct from expected_relations then
    raise exception using
      errcode = '55000',
      message = 'Refusing logical-backup upgrade because the private table inventory drifted.',
      detail = 'Expected exactly 59 reviewed application/control tables.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
      and relation.relkind = 'S'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Refusing logical-backup upgrade because the zero-sequence inventory drifted.';
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
          )
          or (
            policy.polname = (relation.relname || '_migrator_select')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          )
          or (
            policy.polname = (relation.relname || '_migrator_insert')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'a'
            and policy.polqual is null
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      )
      or (
        namespace.nspname = 'pintpath_app'
        and relation.relname = 'schema_metadata'
        and (
          (
            policy.polname = 'schema_metadata_runtime_read'::name
            and policy.polroles = array[runtime_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          )
          or (
            policy.polname = 'schema_metadata_migrator_select'::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          )
          or (
            policy.polname = 'schema_metadata_migrator_update'::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'w'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      )
      or (
        namespace.nspname = 'pintpath_ops'
        and relation.relname = any(array['migration_chunks', 'migration_runs'])
        and (
          (
            policy.polname = (relation.relname || '_migrator_select')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          )
          or (
            policy.polname = (relation.relname || '_migrator_insert')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'a'
            and policy.polqual is null
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
          or (
            policy.polname = (relation.relname || '_migrator_update')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'w'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      )
    );

  select count(*)::integer into exact_policy_count
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
          = any(expected_relations)
    and policy.polname = (relation.relname || '_logical_backup_select')::name
    and policy.polpermissive
    and policy.polcmd = 'r'
    and policy.polroles = array[0]::oid[]
    and policy.polwithcheck is null
    and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false)
          = expected_policy_expression;

  select count(*)::integer into reserved_login_role_count
  from pg_catalog.pg_roles as role
  where role.rolname like (backup_role_name || '\_v%') escape '\';

  if reserved_login_role_count <> 0 then
    raise exception using
      errcode = '55000',
      message = 'Refusing logical-backup upgrade because the current database login namespace is not empty.';
  end if;

  select exists (
    select 1 from pg_catalog.pg_roles as role
    where role.rolname = backup_role_name
  ) into role_exists;

  if not role_exists
     and private_policy_count = 177
     and exact_base_policy_count = 177
     and exact_policy_count = 0
  then
    migration_state := 'absent';
  elsif not role_exists
        and private_policy_count = 236
        and exact_base_policy_count = 177
        and exact_policy_count = 59
  then
    migration_state := 'restored-policy-only';
  elsif role_exists
        and private_policy_count = 236
        and exact_base_policy_count = 177
        and exact_policy_count = 59
  then
    migration_state := 'exact-candidate';
  else
    raise exception using
      errcode = '55000',
      message = 'Refusing logical-backup upgrade because live state is mixed or unsafe.',
      detail = 'Accepted pre-states are fully absent, exact restored-policy-only, or fully exact.';
  end if;

  if role_exists then
    select role.oid into strict backup_role_oid
    from pg_catalog.pg_roles as role
    where role.rolname = backup_role_name;

    if exists (
      select 1
      from pg_catalog.pg_policy as policy
      join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
        and backup_role_oid = any(policy.polroles)
    ) then
      raise exception using
        errcode = '42501',
        message = 'Refusing logical-backup upgrade because a policy directly names the scoped role.';
    end if;

    select (
      not role.rolcanlogin
      and not role.rolsuper
      and not role.rolcreatedb
      and not role.rolcreaterole
      and not role.rolinherit
      and not role.rolreplication
      and not role.rolbypassrls
      and not exists (
        select 1 from pg_catalog.pg_auth_members as membership
        where membership.member = role.oid
      )
      and not exists (
        select 1 from pg_catalog.pg_auth_members as membership
        where membership.roleid = role.oid
      )
      and not exists (
        select 1 from pg_catalog.pg_db_role_setting as setting
        where setting.setrole = role.oid
      )
      and not exists (
        select 1
        from pg_catalog.pg_database as granted_database
        cross join lateral pg_catalog.aclexplode(coalesce(
          granted_database.datacl,
          pg_catalog.acldefault('d', granted_database.datdba)
        )) as privilege
        where privilege.grantee = role.oid
      )
      and not exists (
        select 1
        from pg_catalog.pg_proc as routine
        cross join lateral pg_catalog.aclexplode(coalesce(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )) as privilege
        where privilege.grantee = role.oid
      )
      and not exists (
        select 1
        from pg_catalog.pg_attribute as attribute
        cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
        where attribute.attnum > 0
          and not attribute.attisdropped
          and attribute.attacl is not null
          and privilege.grantee = role.oid
      )
      and not exists (
        select 1
        from pg_catalog.pg_shdepend as dependency
        where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          and dependency.refobjid = role.oid
          and dependency.deptype = 'o'
          and dependency.dbid in (0::oid, current_database_oid)
      )
      and (
        select count(*)
        from pg_catalog.pg_shdepend as dependency
        where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          and dependency.refobjid = role.oid
      ) = 61
      and (
        select count(*)
        from pg_catalog.pg_shdepend as dependency
        where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          and dependency.refobjid = role.oid
          and dependency.dbid = current_database_oid
          and dependency.objsubid = 0
          and dependency.deptype = 'a'
          and (
            (
              dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
              and exists (
                select 1 from pg_catalog.pg_namespace as namespace
                where namespace.oid = dependency.objid
                  and namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
              )
            )
            or (
              dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              and exists (
                select 1
                from pg_catalog.pg_class as relation
                join pg_catalog.pg_namespace as namespace
                  on namespace.oid = relation.relnamespace
                where relation.oid = dependency.objid
                  and pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
                    = any(expected_relations)
                  and relation.relkind in ('r', 'p')
              )
            )
          )
      ) = 61
      and (
        select count(*)
        from pg_catalog.pg_namespace as namespace
        cross join lateral pg_catalog.aclexplode(coalesce(
          namespace.nspacl,
          pg_catalog.acldefault('n', namespace.nspowner)
        )) as privilege
        where privilege.grantee = role.oid
      ) = 2
      and not exists (
        select 1
        from pg_catalog.pg_namespace as namespace
        cross join lateral pg_catalog.aclexplode(coalesce(
          namespace.nspacl,
          pg_catalog.acldefault('n', namespace.nspowner)
        )) as privilege
        where privilege.grantee = role.oid
          and (
            namespace.nspname <> all(array['pintpath_app', 'pintpath_ops'])
            or privilege.privilege_type <> 'USAGE'
            or privilege.is_grantable
          )
      )
      and (
        select count(*)
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        cross join lateral pg_catalog.aclexplode(coalesce(
          relation.relacl,
          pg_catalog.acldefault(
            (case when relation.relkind = 'S' then 'S' else 'r' end)::"char",
            relation.relowner
          )
        )) as privilege
        where privilege.grantee = role.oid
      ) = 59
      and not exists (
        select 1
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        cross join lateral pg_catalog.aclexplode(coalesce(
          relation.relacl,
          pg_catalog.acldefault(
            (case when relation.relkind = 'S' then 'S' else 'r' end)::"char",
            relation.relowner
          )
        )) as privilege
        where privilege.grantee = role.oid
          and (
            pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
              <> all(expected_relations)
            or relation.relkind not in ('r', 'p')
            or privilege.privilege_type <> 'SELECT'
            or privilege.is_grantable
          )
      )
    ) into role_contract_exact
    from pg_catalog.pg_roles as role
    where role.oid = backup_role_oid;

    if not role_contract_exact then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'Refusing logical-backup upgrade because scoped role %I is not fully exact.',
          backup_role_name
        );
    end if;
    migration_state := 'exact';
  else
    execute pg_catalog.format(
      'create role %I nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
      backup_role_name
    );
    select role.oid into strict backup_role_oid
    from pg_catalog.pg_roles as role
    where role.rolname = backup_role_name;

    if exists (
      select 1
      from pg_catalog.pg_roles as role
      where role.oid = backup_role_oid
        and (
          role.rolcanlogin
          or role.rolsuper
          or role.rolcreatedb
          or role.rolcreaterole
          or role.rolinherit
          or role.rolreplication
          or role.rolbypassrls
          or exists (
            select 1 from pg_catalog.pg_auth_members as membership
            where membership.member = role.oid or membership.roleid = role.oid
          )
          or exists (
            select 1 from pg_catalog.pg_db_role_setting as setting
            where setting.setrole = role.oid
          )
          or exists (
            select 1
            from pg_catalog.pg_shdepend as dependency
            where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
              and dependency.refobjid = role.oid
          )
        )
    ) then
      raise exception using
        errcode = '42501',
        message = 'Logical-backup upgrade did not create an inert scoped role.';
    end if;
  end if;

  -- A fully exact zero-child state is a genuine no-op. Only the two accepted
  -- upgrade states may create the scoped role's policies or ACLs.
  if migration_state <> 'exact' then
    execute pg_catalog.format(
      'grant usage on schema pintpath_app, pintpath_ops to %I',
      backup_role_name
    );

    for target in
      select namespace.nspname as schema_name, relation.relname as relation_name
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
              = any(expected_relations)
        and relation.relkind in ('r', 'p')
      order by namespace.nspname collate "C", relation.relname collate "C"
    loop
      target_policy := (target.relation_name || '_logical_backup_select')::name;
      if not exists (
        select 1
        from pg_catalog.pg_policy as policy
        where policy.polrelid = pg_catalog.to_regclass(
          pg_catalog.format('%I.%I', target.schema_name, target.relation_name)
        )
          and policy.polname = target_policy
      ) then
        execute pg_catalog.format(
          'create policy %I on %I.%I as permissive for select to public using (current_user = (''pintpath_logical_backup_d'' || (select database.oid::text from pg_catalog.pg_database as database where database.datname = pg_catalog.current_database())))',
          target_policy,
          target.schema_name,
          target.relation_name
        );
      end if;
      execute pg_catalog.format(
        'grant select on %I.%I to %I',
        target.schema_name,
        target.relation_name,
        backup_role_name
      );
    end loop;

    -- The reviewed inventory is currently empty. This remains SELECT-only if a
    -- later canonical schema deliberately introduces a reviewed sequence.
    execute pg_catalog.format(
      'grant select on all sequences in schema pintpath_app, pintpath_ops to %I',
      backup_role_name
    );
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
          )
          or (
            policy.polname = (relation.relname || '_migrator_select')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          )
          or (
            policy.polname = (relation.relname || '_migrator_insert')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'a'
            and policy.polqual is null
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      )
      or (
        namespace.nspname = 'pintpath_app'
        and relation.relname = 'schema_metadata'
        and (
          (
            policy.polname = 'schema_metadata_runtime_read'::name
            and policy.polroles = array[runtime_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          )
          or (
            policy.polname = 'schema_metadata_migrator_select'::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          )
          or (
            policy.polname = 'schema_metadata_migrator_update'::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'w'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      )
      or (
        namespace.nspname = 'pintpath_ops'
        and relation.relname = any(array['migration_chunks', 'migration_runs'])
        and (
          (
            policy.polname = (relation.relname || '_migrator_select')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null
          )
          or (
            policy.polname = (relation.relname || '_migrator_insert')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'a'
            and policy.polqual is null
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
          or (
            policy.polname = (relation.relname || '_migrator_update')::name
            and policy.polroles = array[migrator_role_oid]::oid[]
            and policy.polcmd = 'w'
            and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      )
    );

  select count(*)::integer into exact_policy_count
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
          = any(expected_relations)
    and policy.polname = (relation.relname || '_logical_backup_select')::name
    and policy.polpermissive
    and policy.polcmd = 'r'
    and policy.polroles = array[0]::oid[]
    and policy.polwithcheck is null
    and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false)
          = expected_policy_expression;

  if private_policy_count <> 236
     or exact_base_policy_count <> 177
     or exact_policy_count <> 59 then
    raise exception using
      errcode = '42501',
      message = 'Logical-backup upgrade did not establish the canonical 236-policy inventory.';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(coalesce(
      namespace.nspacl,
      pg_catalog.acldefault('n', namespace.nspowner)
    )) as privilege
    where privilege.grantee = backup_role_oid
  ) <> 2 or exists (
    select 1
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(coalesce(
      namespace.nspacl,
      pg_catalog.acldefault('n', namespace.nspowner)
    )) as privilege
    where privilege.grantee = backup_role_oid
      and (
        namespace.nspname <> all(array['pintpath_app', 'pintpath_ops'])
        or privilege.privilege_type <> 'USAGE'
        or privilege.is_grantable
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'Logical-backup upgrade did not establish exact scoped schema ACLs.';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(coalesce(
      relation.relacl,
      pg_catalog.acldefault(
        (case when relation.relkind = 'S' then 'S' else 'r' end)::"char",
        relation.relowner
      )
    )) as privilege
    where privilege.grantee = backup_role_oid
  ) <> 59 or exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(coalesce(
      relation.relacl,
      pg_catalog.acldefault(
        (case when relation.relkind = 'S' then 'S' else 'r' end)::"char",
        relation.relowner
      )
    )) as privilege
    where privilege.grantee = backup_role_oid
      and (
        pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
          <> all(expected_relations)
        or relation.relkind not in ('r', 'p')
        or privilege.privilege_type <> 'SELECT'
        or privilege.is_grantable
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'Logical-backup upgrade did not establish exact scoped table ACLs.';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_shdepend as dependency
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.refobjid = backup_role_oid
  ) <> 61 or (
    select count(*)
    from pg_catalog.pg_shdepend as dependency
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.refobjid = backup_role_oid
      and dependency.dbid = current_database_oid
      and dependency.objsubid = 0
      and dependency.deptype = 'a'
      and (
        (
          dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
          and exists (
            select 1 from pg_catalog.pg_namespace as namespace
            where namespace.oid = dependency.objid
              and namespace.nspname = any(array['pintpath_app', 'pintpath_ops'])
          )
        )
        or (
          dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          and exists (
            select 1
            from pg_catalog.pg_class as relation
            join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
            where relation.oid = dependency.objid
              and pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
                = any(expected_relations)
              and relation.relkind in ('r', 'p')
          )
        )
      )
  ) <> 61 then
    raise exception using
      errcode = '42501',
      message = 'Logical-backup upgrade produced unexpected shared role dependencies.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members as membership
    where membership.member = backup_role_oid or membership.roleid = backup_role_oid
  ) or exists (
    select 1
    from pg_catalog.pg_db_role_setting as setting
    where setting.setrole = backup_role_oid
  ) then
    raise exception using
      errcode = '42501',
      message = 'Logical-backup upgrade left the scoped role active or configurable.';
  end if;
end
$$;

commit;
