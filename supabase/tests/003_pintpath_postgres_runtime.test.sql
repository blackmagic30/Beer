begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(23);

select ok(
  to_regnamespace('pintpath_app') is not null
    and to_regnamespace('pintpath_ops') is not null,
  'the private application and operations schemas exist'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pintpath_app'
      and c.relkind in ('r', 'p')
  ),
  57::bigint,
  'the application schema contains 56 runtime tables plus schema metadata'
);

select ok(
  (select count(*)
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'pintpath_ops'
     and c.relkind in ('r', 'p')) = 5
  and not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pintpath_ops'
      and c.relkind in ('r', 'p')
      and c.relname not in (
        'migration_chunks',
        'migration_runs',
        'migration_verifier_authority',
        'reviewed_price_promotion_operations',
        'reviewed_price_promotion_rows'
      )
  ),
  'the operations schema contains exactly migration, verifier-authority, and activated reviewed-price ledgers'
);

select ok(
  (select count(*)
   from pg_roles
   where rolname in ('pintpath_runtime', 'pintpath_migrator')
     and not rolcanlogin
     and not rolsuper
     and not rolcreatedb
     and not rolcreaterole
     and not rolreplication
     and not rolbypassrls
     and rolinherit) = 2
  and exists (
    select 1 from pg_roles
    where rolname = 'pintpath_maintenance'
      and not rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolinherit
      and not rolreplication
      and not rolbypassrls
  )
  and exists (
    select 1 from pg_roles
    where rolname = 'pintpath_migration_verifier_authority'
      and not rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and rolinherit
      and not rolreplication
      and not rolbypassrls
  ),
  'runtime, migrator, verifier-authority, and privacy-maintenance roles have exact non-login safety attributes'
);

select ok(
  has_schema_privilege(
    'pintpath_migration_verifier_authority', 'pintpath_ops', 'USAGE'
  )
  and not has_schema_privilege(
    'pintpath_migration_verifier_authority', 'pintpath_ops', 'CREATE'
  )
  and not has_schema_privilege(
    'pintpath_migration_verifier_authority', 'pintpath_app', 'USAGE'
  )
  and has_table_privilege(
    'pintpath_migration_verifier_authority',
    'pintpath_ops.migration_verifier_authority',
    'SELECT,INSERT,UPDATE'
  )
  and not has_table_privilege(
    'pintpath_migration_verifier_authority',
    'pintpath_ops.migration_verifier_authority',
    'DELETE,TRUNCATE,REFERENCES,TRIGGER'
  )
  and has_table_privilege(
    'pintpath_migrator', 'pintpath_ops.migration_verifier_authority', 'SELECT'
  )
  and not has_table_privilege(
    'pintpath_migrator', 'pintpath_ops.migration_verifier_authority',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  )
  and (select relrowsecurity and relforcerowsecurity
       from pg_class
       where oid = 'pintpath_ops.migration_verifier_authority'::regclass)
  and (select count(*) from pg_policy
       where polrelid = 'pintpath_ops.migration_verifier_authority'::regclass) = 4
  and not exists (
    select 1 from pg_policy
    where polrelid = 'pintpath_ops.migration_verifier_authority'::regclass
      and polroles = array[0]::oid[]
  ),
  'the verifier authority is named-role-only, forced-RLS, migrator-read-only, and excluded from PUBLIC backup policy'
);

select ok(
  exists (
    with scoped as (
      select ('pintpath_logical_backup_d' || database.oid::text) as role_name,
             database.oid as database_oid
      from pg_database as database
      where database.datname = current_database()
    )
    select 1
    from pg_roles r
    cross join scoped
    where r.rolname = scoped.role_name
      and not r.rolcanlogin
      and not r.rolsuper
      and not r.rolcreatedb
      and not r.rolcreaterole
      and not r.rolinherit
      and not r.rolreplication
      and not r.rolbypassrls
      and not exists (
        select 1 from pg_auth_members m where m.member = r.oid
      )
      and not exists (
        select 1 from pg_auth_members m where m.roleid = r.oid
      )
      and not exists (
        select 1 from pg_db_role_setting setting where setting.setrole = r.oid
      )
      and (select count(*) from pg_shdepend dependency
           where dependency.refclassid = 'pg_authid'::regclass
             and dependency.refobjid = r.oid) = 63
      and (select count(*) from pg_shdepend dependency
           where dependency.refclassid = 'pg_authid'::regclass
             and dependency.refobjid = r.oid
             and dependency.dbid = scoped.database_oid
             and dependency.objsubid = 0
             and dependency.deptype = 'a'
             and dependency.classid in (
               'pg_namespace'::regclass,
               'pg_class'::regclass
             )) = 63
  )
  or (
    not (select rolsuper from pg_roles where rolname = current_user)
    and not exists (
      with scoped as (
        select 'pintpath_logical_backup_d' || database.oid::text as role_name
        from pg_database as database where database.datname = current_database()
      )
      select 1 from pg_roles r cross join scoped where r.rolname = scoped.role_name
    )
    and not exists (
      with scoped as (
        select 'pintpath_logical_backup_d' || database.oid::text as role_name
        from pg_database as database where database.datname = current_database()
      )
      select 1 from pg_roles r cross join scoped
      where r.rolname like (scoped.role_name || '\_v%') escape '\'
    )
  ),
  'logical backup is either a full exact scoped group or an inert non-superuser policy-only state'
);

select ok(
  (with scoped as (
     select 'pintpath_logical_backup_d' || database.oid::text as role_name,
            to_regrole('pintpath_logical_backup_d' || database.oid::text)::oid as role_oid
     from pg_database as database where database.datname = current_database()
   ) select case
       when scoped.role_oid is null then
         not (select rolsuper from pg_roles where rolname = current_user)
       else has_schema_privilege(scoped.role_oid, 'pintpath_app', 'USAGE')
         and has_schema_privilege(scoped.role_oid, 'pintpath_ops', 'USAGE')
         and not has_schema_privilege(scoped.role_oid, 'pintpath_app', 'CREATE')
         and not has_schema_privilege(scoped.role_oid, 'pintpath_ops', 'CREATE')
       end
     from scoped),
  'the full scoped group has USAGE-only schemas or the non-superuser state has no group'
);

select ok(
  (
    with scoped as (
      select to_regrole('pintpath_logical_backup_d' || database.oid::text)::oid as role_oid
      from pg_database as database where database.datname = current_database()
    )
    select case
      when scoped.role_oid is null then
        not (select rolsuper from pg_roles where rolname = current_user)
      else (
        select count(*)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('pintpath_app', 'pintpath_ops')
          and c.relkind in ('r', 'p')
          and has_table_privilege(scoped.role_oid, c.oid, 'SELECT')
          and not has_table_privilege(
            scoped.role_oid, c.oid,
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
      ) = 61
      end
    from scoped
  ),
  'the full scoped group has SELECT-only authority or the non-superuser state has no group'
);

select ok(
  (
    with scoped as (
      select to_regrole('pintpath_logical_backup_d' || database.oid::text)::oid as role_oid
      from pg_database as database where database.datname = current_database()
    )
    select case
      when scoped.role_oid is null then
        not (select rolsuper from pg_roles where rolname = current_user)
      else not exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('pintpath_app', 'pintpath_ops')
          and c.relkind in ('r', 'p')
          and (
            (select count(*)
             from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) privilege
             where privilege.grantee = scoped.role_oid
               and privilege.privilege_type = 'SELECT'
               and not privilege.is_grantable) <> 1
            or exists (
              select 1
              from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) privilege
              where privilege.grantee = scoped.role_oid
                and (privilege.privilege_type <> 'SELECT' or privilege.is_grantable)
            )
          )
      )
      end
    from scoped
  ),
  'the full scoped group has exact direct table ACLs or the non-superuser state has no group'
);

select ok(
  (select count(*)
   from pg_policy policy
   join pg_class relation on relation.oid = policy.polrelid
   join pg_namespace namespace on namespace.oid = relation.relnamespace
   where namespace.nspname in ('pintpath_app', 'pintpath_ops')) = 244
  and (
    with authority as (
      select runtime_role.oid as runtime_oid,
             migrator_role.oid as migrator_oid,
             maintenance_role.oid as maintenance_oid,
             database.oid::text as database_oid,
             format(
               '(CURRENT_USER = ANY (ARRAY[''pintpath_runtime''::text, ''pintpath_maintenance''::text, ''pintpath_reviewed_price_apply_owner_d%s''::text]))',
               database.oid
             ) as apply_policy,
             format(
               '(CURRENT_USER = ANY (ARRAY[''pintpath_runtime''::text, ''pintpath_maintenance''::text, ''pintpath_reviewed_price_apply_owner_d%s''::text, ''pintpath_reviewed_price_quarantine_owner_d%s''::text]))',
               database.oid,
               database.oid
             ) as price_policy,
             format(
               '(CURRENT_USER = ANY (ARRAY[''pintpath_migrator''::text, ''pintpath_reviewed_price_apply_owner_d%s''::text]))',
               database.oid
             ) as migration_policy,
             format(
               '(CURRENT_USER = ANY (ARRAY[''pintpath_migrator''::text, ''pintpath_reviewed_price_apply_owner_d%s''::text, ''pintpath_reviewed_price_quarantine_owner_d%s''::text]))',
               database.oid,
               database.oid
             ) as ledger_policy
      from pg_roles runtime_role
      cross join pg_roles migrator_role
      cross join pg_roles maintenance_role
      cross join pg_database database
      where runtime_role.rolname = 'pintpath_runtime'
        and migrator_role.rolname = 'pintpath_migrator'
        and maintenance_role.rolname = 'pintpath_maintenance'
        and database.datname = current_database()
    )
    select count(*) = 179
    from pg_policy policy
    join pg_class relation on relation.oid = policy.polrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join authority
    where namespace.nspname in ('pintpath_app', 'pintpath_ops')
      and policy.polpermissive
      and (
        (namespace.nspname = 'pintpath_app'
         and relation.relname <> 'schema_metadata'
         and (
           (policy.polname = (relation.relname || '_runtime_all')::name
            and policy.polcmd = '*'
            and (
              (relation.relname not in (
                 'admin_ingestion_queue', 'beer_catalog_items',
                 'venue_profiles', 'wrong_price_reports',
                 'venue_price_records', 'venue_beers'
               )
               and policy.polroles = array[
                 authority.runtime_oid, authority.maintenance_oid
               ]::oid[]
               and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
               and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
              or
              (relation.relname in (
                 'admin_ingestion_queue', 'beer_catalog_items',
                 'venue_profiles', 'wrong_price_reports'
               )
               and policy.polroles = array[0]::oid[]
               and pg_get_expr(policy.polqual, policy.polrelid, false) = authority.apply_policy
               and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = authority.apply_policy)
              or
              (relation.relname in ('venue_price_records', 'venue_beers')
               and policy.polroles = array[0]::oid[]
               and pg_get_expr(policy.polqual, policy.polrelid, false) = authority.price_policy
               and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = authority.price_policy)
            ))
           or
           (policy.polname = (relation.relname || '_migrator_select')::name
            and policy.polroles = array[authority.migrator_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null)
           or
           (policy.polname = (relation.relname || '_migrator_insert')::name
            and policy.polroles = array[authority.migrator_oid]::oid[]
            and policy.polcmd = 'a'
            and policy.polqual is null
            and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
         ))
        or
        (namespace.nspname = 'pintpath_app'
         and relation.relname = 'schema_metadata'
         and (
           (policy.polname = 'schema_metadata_runtime_read'::name
            and policy.polroles = array[0]::oid[]
            and policy.polcmd = 'r'
            and pg_get_expr(policy.polqual, policy.polrelid, false) = authority.apply_policy
            and policy.polwithcheck is null)
           or
           (policy.polname = 'schema_metadata_migrator_select'::name
            and policy.polroles = array[authority.migrator_oid]::oid[]
            and policy.polcmd = 'r'
            and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and policy.polwithcheck is null)
           or
           (policy.polname = 'schema_metadata_migrator_update'::name
            and policy.polroles = array[authority.migrator_oid]::oid[]
            and policy.polcmd = 'w'
            and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
         ))
        or
        (namespace.nspname = 'pintpath_ops'
         and relation.relname in ('migration_chunks', 'migration_runs')
         and (
           (policy.polname = (relation.relname || '_migrator_select')::name
            and policy.polcmd = 'r'
            and policy.polwithcheck is null
            and (
              (relation.relname = 'migration_chunks'
               and policy.polroles = array[authority.migrator_oid]::oid[]
               and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true')
              or
              (relation.relname = 'migration_runs'
               and policy.polroles = array[0]::oid[]
               and pg_get_expr(policy.polqual, policy.polrelid, false) = authority.migration_policy)
            ))
           or
           (policy.polname = (relation.relname || '_migrator_insert')::name
            and policy.polroles = array[authority.migrator_oid]::oid[]
            and policy.polcmd = 'a'
            and policy.polqual is null
            and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
           or
           (policy.polname = (relation.relname || '_migrator_update')::name
            and policy.polroles = array[authority.migrator_oid]::oid[]
            and policy.polcmd = 'w'
            and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
         ))
        or
        (namespace.nspname = 'pintpath_ops'
         and relation.relname in (
           'reviewed_price_promotion_operations',
           'reviewed_price_promotion_rows'
         )
         and policy.polname = (relation.relname || '_migrator_select')::name
         and policy.polroles = array[0]::oid[]
         and policy.polcmd = '*'
         and pg_get_expr(policy.polqual, policy.polrelid, false) = authority.ledger_policy
         and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = authority.ledger_policy)
      )
  ),
  'the complete 244-policy inventory contains 179 activated application/promotion policies plus four verifier-authority and 61 backup policies'
);

select ok(
  (select count(*)
   from pg_policy policy
   join pg_class relation on relation.oid = policy.polrelid
   join pg_namespace namespace on namespace.oid = relation.relnamespace
   where namespace.nspname in ('pintpath_app', 'pintpath_ops')
     and policy.polname = (relation.relname || '_logical_backup_select')::name
     and policy.polroles = array[0]::oid[]
     and policy.polcmd = 'r'
     and policy.polpermissive
     and pg_get_expr(policy.polqual, policy.polrelid, false) = $policy$(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid
   FROM pg_database database
  WHERE (database.datname = current_database()))))$policy$
     and policy.polwithcheck is null) = 61
  and (select count(*)
       from pg_policy policy
       join pg_class relation on relation.oid = policy.polrelid
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname in ('pintpath_app', 'pintpath_ops')
         and 0::oid = any(policy.polroles)) = 71
  and (select count(*)
       from pg_policy policy
       join pg_class relation on relation.oid = policy.polrelid
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname in ('pintpath_app', 'pintpath_ops')
         and policy.polname::text ~ '_logical_backup_select$') = 61
  and not exists (
    with scoped as (
      select to_regrole('pintpath_logical_backup_d' || database.oid::text)::oid as role_oid
      from pg_database as database where database.datname = current_database()
    )
    select 1
    from pg_policy policy
    join pg_class relation on relation.oid = policy.polrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join scoped
    where namespace.nspname in ('pintpath_app', 'pintpath_ops')
      and scoped.role_oid is not null
      and scoped.role_oid = any(policy.polroles)
  ),
  'the exact 61 backup plus 10 activated authority policies use PUBLIC without naming the scoped backup role'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('pintpath_app', 'pintpath_ops')
      and c.relkind = 'S'
  ),
  0::bigint,
  'the reviewed logical-backup schema inventory contains no sequences'
);

select ok(
  (
    with scoped as (
      select to_regrole('pintpath_logical_backup_d' || database.oid::text)::oid as role_oid
      from pg_database as database where database.datname = current_database()
    )
    select case
      when scoped.role_oid is null then
        not (select rolsuper from pg_roles where rolname = current_user)
      else not exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('pintpath_app', 'pintpath_ops')
          and has_function_privilege(scoped.role_oid, p.oid, 'EXECUTE')
      )
      end
    from scoped
  ),
  'the full scoped group has no private function authority or the non-superuser state has no group'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pintpath_app'
      and c.relkind in ('r', 'p')
      and (not c.relrowsecurity or not c.relforcerowsecurity)
  ),
  0::bigint,
  'RLS is enabled and forced on every application table'
);

select ok(
  (select count(*)
   from pg_policies
   where schemaname = 'pintpath_app'
     and policyname like '%\_runtime\_all' escape '\'
     and cmd = 'ALL') = 56
  and (select count(*)
       from pg_policies
       where schemaname = 'pintpath_app'
         and policyname like '%\_runtime\_all' escape '\'
         and roles = array[
           'pintpath_maintenance', 'pintpath_runtime'
         ]::name[]) = 50
  and (select count(*)
       from pg_policies
       where schemaname = 'pintpath_app'
         and policyname like '%\_runtime\_all' escape '\'
         and roles = array['public']::name[]) = 6,
  'all 56 runtime policies retain maintenance access and only six use activated owner predicates'
);

select ok(
  exists (
    select 1
    from pg_policies
    where schemaname = 'pintpath_app'
      and tablename = 'schema_metadata'
      and policyname = 'schema_metadata_runtime_read'
      and cmd = 'SELECT'
      and roles = array['public']::name[]
      and qual like '%pintpath_runtime%'
      and qual like '%pintpath_maintenance%'
      and qual like '%pintpath_reviewed_price_apply_owner_d%'
  ),
  'schema metadata has the activated runtime, maintenance, and apply-owner read policy'
);

select ok(
  has_schema_privilege('pintpath_runtime', 'pintpath_app', 'USAGE')
    and not has_schema_privilege('pintpath_runtime', 'pintpath_ops', 'USAGE'),
  'the runtime role can resolve application objects but not operations objects'
);

select ok(
  has_table_privilege('pintpath_runtime', 'pintpath_app.accounts', 'SELECT')
    and has_table_privilege('pintpath_runtime', 'pintpath_app.accounts', 'INSERT')
    and has_table_privilege('pintpath_runtime', 'pintpath_app.accounts', 'UPDATE')
    and has_table_privilege('pintpath_runtime', 'pintpath_app.accounts', 'DELETE')
    and has_table_privilege('pintpath_runtime', 'pintpath_app.schema_metadata', 'SELECT')
    and not has_table_privilege('pintpath_runtime', 'pintpath_app.schema_metadata', 'INSERT')
    and not has_table_privilege('pintpath_runtime', 'pintpath_app.schema_metadata', 'UPDATE')
    and not has_table_privilege('pintpath_runtime', 'pintpath_app.schema_metadata', 'DELETE'),
  'the runtime role has CRUD on app data and read-only schema metadata'
);

select ok(
  not exists (
    select 1
    from pg_namespace n
    cross join (values ('anon'), ('authenticated'), ('service_role')) api_role(role_name)
    where n.nspname in ('pintpath_app', 'pintpath_ops')
      and has_schema_privilege(api_role.role_name, n.oid, 'USAGE')
  ),
  'Supabase API roles cannot resolve either private runtime schema'
);

select ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated'), ('service_role')) api_role(role_name)
    where n.nspname in ('pintpath_app', 'pintpath_ops')
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege(
        api_role.role_name,
        c.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
  ),
  'Supabase API roles have no relation privileges in either private schema'
);

select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated'), ('service_role')) api_role(role_name)
    where n.nspname in ('pintpath_app', 'pintpath_ops')
      and has_function_privilege(api_role.role_name, p.oid, 'EXECUTE')
  ),
  'Supabase API roles cannot execute private application or operations functions'
);

select ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pintpath_ops'
      and c.relkind in ('r', 'p')
      and has_table_privilege(
        'pintpath_runtime',
        c.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
  ),
  'the application runtime role has no migration-ledger privileges'
);

select ok(
  (
    with authority as (
      select database.oid::text as database_oid,
             'pintpath_reviewed_price_apply_owner_d' || database.oid::text as apply_owner,
             'pintpath_reviewed_price_apply_execute_d' || database.oid::text as apply_execute,
             'pintpath_reviewed_price_quarantine_owner_d' || database.oid::text as quarantine_owner,
             'pintpath_reviewed_price_quarantine_execute_d' || database.oid::text as quarantine_execute,
             'pintpath_reviewed_price_reviewer_execute_d' || database.oid::text as reviewer_execute
      from pg_database database
      where database.datname = current_database()
    ), role_contract as (
      select apply_owner as role_name from authority
      union all select apply_execute from authority
      union all select quarantine_owner from authority
      union all select quarantine_execute from authority
      union all select reviewer_execute from authority
    ), function_contract as (
      select 'authorize_reviewed_price_promotion'::name as function_name,
             apply_owner as owner_name,
             reviewer_execute as executor_name
      from authority
      union all
      select 'apply_reviewed_price_promotion'::name,
             apply_owner,
             apply_execute
      from authority
      union all
      select 'quarantine_reviewed_price_promotion'::name,
             quarantine_owner,
             quarantine_execute
      from authority
    )
    select
      (select count(*)
       from pg_roles role
       join role_contract contract on contract.role_name = role.rolname
       where not role.rolcanlogin
         and not role.rolsuper
         and not role.rolcreatedb
         and not role.rolcreaterole
         and not role.rolinherit
         and not role.rolreplication
         and not role.rolbypassrls
         and role.rolconnlimit = -1
         and role.rolvaliduntil is null
         and not exists (
           select 1 from pg_auth_members membership
           where membership.member = role.oid
              or (
                membership.roleid = role.oid
                and not (
                  not (select rolsuper from pg_roles where rolname = current_user)
                  and membership.member = current_user::regrole
                  and membership.grantor = 10::oid
                  and exists (
                    select 1 from pg_roles grantor
                    where grantor.oid = membership.grantor
                      and grantor.rolsuper
                  )
                  and membership.admin_option
                  and not membership.inherit_option
                  and not membership.set_option
                )
              )
         )
         and (select count(*) from pg_auth_members membership
              where membership.roleid = role.oid) =
             case when (select rolsuper from pg_roles where rolname = current_user)
               then 0 else 1 end
         and not exists (
           select 1 from pg_db_role_setting setting
           where setting.setrole = role.oid
         )) = 5
      and (select count(*)
           from pg_proc routine
           join pg_namespace namespace on namespace.oid = routine.pronamespace
           join function_contract contract on contract.function_name = routine.proname
           where namespace.nspname = 'pintpath_ops'
             and routine.pronargs = 1
             and routine.proargtypes[0] = 'jsonb'::regtype::oid
             and routine.proowner = contract.owner_name::regrole
             and (select count(*)
                  from aclexplode(coalesce(
                    routine.proacl,
                    acldefault('f', routine.proowner)
                  )) privilege
                  where privilege.privilege_type = 'EXECUTE'
                    and not privilege.is_grantable
                    and privilege.grantee in (
                      contract.owner_name::regrole,
                      contract.executor_name::regrole
                    )) = 2
             and not exists (
               select 1
               from aclexplode(coalesce(
                 routine.proacl,
                 acldefault('f', routine.proowner)
               )) privilege
               where privilege.privilege_type <> 'EXECUTE'
                  or privilege.is_grantable
                  or privilege.grantee not in (
                    contract.owner_name::regrole,
                    contract.executor_name::regrole
                  )
             )) = 3
      and not exists (
        select 1
        from role_contract contract
        join authority on true
        join pg_class relation on relation.relkind in ('r', 'p')
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        where contract.role_name in (
            authority.apply_execute,
            authority.quarantine_execute,
            authority.reviewer_execute
          )
          and namespace.nspname in ('pintpath_app', 'pintpath_ops')
          and has_table_privilege(
            contract.role_name,
            relation.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
      )
  ),
  'reviewed-price owners and execute roles are active with exact role, function, and zero-table execute authority'
);

select * from finish();

rollback;
