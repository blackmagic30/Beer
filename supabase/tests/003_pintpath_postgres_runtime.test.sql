begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(13);

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
