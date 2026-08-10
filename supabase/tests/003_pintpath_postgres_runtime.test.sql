begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(21);

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

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pintpath_ops'
      and c.relkind in ('r', 'p')
  ),
  2::bigint,
  'the operations schema contains only the migration run and chunk ledgers'
);

select is(
  (
    select count(*)
    from pg_roles
    where rolname in ('pintpath_runtime', 'pintpath_migrator')
      and not rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolreplication
      and not rolbypassrls
      and rolinherit
  ),
  2::bigint,
  'the runtime and migrator roles are non-login, inheriting, least-privilege roles'
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
             and dependency.refobjid = r.oid) = 61
      and (select count(*) from pg_shdepend dependency
           where dependency.refclassid = 'pg_authid'::regclass
             and dependency.refobjid = r.oid
             and dependency.dbid = scoped.database_oid
             and dependency.objsubid = 0
             and dependency.deptype = 'a'
             and dependency.classid in (
               'pg_namespace'::regclass,
               'pg_class'::regclass
             )) = 61
  ),
  'the OID-scoped logical-backup group is inert and has only 61 allowlisted current-database ACL dependencies'
);

select ok(
  (with scoped as (
     select 'pintpath_logical_backup_d' || database.oid::text as role_name
     from pg_database as database where database.datname = current_database()
   ) select has_schema_privilege(scoped.role_name, 'pintpath_app', 'USAGE')
       and has_schema_privilege(scoped.role_name, 'pintpath_ops', 'USAGE')
       and not has_schema_privilege(scoped.role_name, 'pintpath_app', 'CREATE')
       and not has_schema_privilege(scoped.role_name, 'pintpath_ops', 'CREATE')
     from scoped),
  'the OID-scoped logical-backup group can resolve but cannot create in either private schema'
);

select is(
  (
    with scoped as (
      select 'pintpath_logical_backup_d' || database.oid::text as role_name
      from pg_database as database where database.datname = current_database()
    )
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join scoped
    where n.nspname in ('pintpath_app', 'pintpath_ops')
      and c.relkind in ('r', 'p')
      and has_table_privilege(scoped.role_name, c.oid, 'SELECT')
      and not has_table_privilege(
        scoped.role_name, c.oid,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
  ),
  59::bigint,
  'the OID-scoped logical-backup group has SELECT and no mutation authority on the exact 59-table inventory'
);

select ok(
  not exists (
    with scoped as (
      select ('pintpath_logical_backup_d' || database.oid::text)::regrole as role_oid
      from pg_database as database where database.datname = current_database()
    )
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join scoped
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
  ),
  'every OID-scoped logical-backup table ACL is one direct non-grantable SELECT and nothing else'
);

select ok(
  (select count(*)
   from pg_policy policy
   join pg_class relation on relation.oid = policy.polrelid
   join pg_namespace namespace on namespace.oid = relation.relnamespace
   where namespace.nspname in ('pintpath_app', 'pintpath_ops')) = 236
  and (select count(*)
       from pg_policy policy
       join pg_class relation on relation.oid = policy.polrelid
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       cross join pg_roles runtime_role
       cross join pg_roles migrator_role
       where runtime_role.rolname = 'pintpath_runtime'
         and migrator_role.rolname = 'pintpath_migrator'
         and namespace.nspname in ('pintpath_app', 'pintpath_ops')
         and policy.polpermissive
         and (
           (namespace.nspname = 'pintpath_app'
            and relation.relname <> 'schema_metadata'
            and (
              (policy.polname = (relation.relname || '_runtime_all')::name
               and policy.polroles = array[runtime_role.oid]::oid[]
               and policy.polcmd = '*'
               and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
               and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
              or
              (policy.polname = (relation.relname || '_migrator_select')::name
               and policy.polroles = array[migrator_role.oid]::oid[]
               and policy.polcmd = 'r'
               and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
               and policy.polwithcheck is null)
              or
              (policy.polname = (relation.relname || '_migrator_insert')::name
               and policy.polroles = array[migrator_role.oid]::oid[]
               and policy.polcmd = 'a'
               and policy.polqual is null
               and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
            ))
           or
           (namespace.nspname = 'pintpath_app'
            and relation.relname = 'schema_metadata'
            and (
              (policy.polname = 'schema_metadata_runtime_read'::name
               and policy.polroles = array[runtime_role.oid]::oid[]
               and policy.polcmd = 'r'
               and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
               and policy.polwithcheck is null)
              or
              (policy.polname = 'schema_metadata_migrator_select'::name
               and policy.polroles = array[migrator_role.oid]::oid[]
               and policy.polcmd = 'r'
               and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
               and policy.polwithcheck is null)
              or
              (policy.polname = 'schema_metadata_migrator_update'::name
               and policy.polroles = array[migrator_role.oid]::oid[]
               and policy.polcmd = 'w'
               and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
               and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
            ))
           or
           (namespace.nspname = 'pintpath_ops'
            and relation.relname in ('migration_chunks', 'migration_runs')
            and (
              (policy.polname = (relation.relname || '_migrator_select')::name
               and policy.polroles = array[migrator_role.oid]::oid[]
               and policy.polcmd = 'r'
               and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
               and policy.polwithcheck is null)
              or
              (policy.polname = (relation.relname || '_migrator_insert')::name
               and policy.polroles = array[migrator_role.oid]::oid[]
               and policy.polcmd = 'a'
               and policy.polqual is null
               and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
              or
              (policy.polname = (relation.relname || '_migrator_update')::name
               and policy.polroles = array[migrator_role.oid]::oid[]
               and policy.polcmd = 'w'
               and pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
               and pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
            ))
         )) = 177,
  'the complete 236-policy inventory contains exactly 177 canonical runtime/migrator policies and no arbitrary named-role policy'
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
     and policy.polwithcheck is null) = 59
  and (select count(*)
       from pg_policy policy
       join pg_class relation on relation.oid = policy.polrelid
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname in ('pintpath_app', 'pintpath_ops')
         and 0::oid = any(policy.polroles)) = 59
  and (select count(*)
       from pg_policy policy
       join pg_class relation on relation.oid = policy.polrelid
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname in ('pintpath_app', 'pintpath_ops')
         and policy.polname::text ~ '_logical_backup_select$') = 59
  and not exists (
    with scoped as (
      select ('pintpath_logical_backup_d' || database.oid::text)::regrole as role_oid
      from pg_database as database where database.datname = current_database()
    )
    select 1
    from pg_policy policy
    join pg_class relation on relation.oid = policy.polrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join scoped
    where namespace.nspname in ('pintpath_app', 'pintpath_ops')
      and scoped.role_oid = any(policy.polroles)
  ),
  'the exact 59 portable PUBLIC database-OID policies exist with no extra PUBLIC, reserved-name, or scoped-role policy'
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
  not exists (
    with scoped as (
      select 'pintpath_logical_backup_d' || database.oid::text as role_name
      from pg_database as database where database.datname = current_database()
    )
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join scoped
    where n.nspname in ('pintpath_app', 'pintpath_ops')
      and has_function_privilege(scoped.role_name, p.oid, 'EXECUTE')
  ),
  'the OID-scoped logical-backup group cannot execute private functions'
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

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'pintpath_app'
      and policyname like '%\_runtime\_all' escape '\'
      and cmd = 'ALL'
      and roles = array['pintpath_runtime']::name[]
  ),
  56::bigint,
  'every imported runtime table has the reviewed runtime policy'
);

select ok(
  exists (
    select 1
    from pg_policies
    where schemaname = 'pintpath_app'
      and tablename = 'schema_metadata'
      and policyname = 'schema_metadata_runtime_read'
      and cmd = 'SELECT'
      and roles = array['pintpath_runtime']::name[]
  ),
  'schema metadata has a runtime read-only RLS policy'
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

select * from finish();

rollback;
