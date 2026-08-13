-- Install the independently protected verifier trust anchor on databases that
-- already applied the original runtime migration. Fresh databases already get
-- the same objects from the generated base DDL; this migration verifies that
-- exact state and is therefore safe across both histories.

begin;

set local search_path = pg_catalog;

do $pintpath_verifier_authority$
declare
  verifier_role_oid oid;
  migrator_role_oid oid;
  authority_relation_oid oid;
  relation_exists boolean;
  role_exists boolean;
  exact_policy_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(721426590137322906);

  if pg_catalog.to_regnamespace('pintpath_ops') is null
     or pg_catalog.to_regrole('pintpath_migrator') is null
     or pg_catalog.to_regclass('pintpath_ops.migration_runs') is null
     or pg_catalog.to_regclass('pintpath_ops.reviewed_price_promotion_operations') is null
     or pg_catalog.to_regprocedure(
       'pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb)'
     ) is null then
    raise exception using errcode = '55000',
      message = 'postgres_migration_verifier_authority_prior_state_invalid';
  end if;

  select exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'pintpath_migration_verifier_authority'
  ) into role_exists;
  select pg_catalog.to_regclass(
    'pintpath_ops.migration_verifier_authority'
  ) is not null into relation_exists;
  if role_exists <> relation_exists then
    raise exception using errcode = '55000',
      message = 'postgres_migration_verifier_authority_partial_state_invalid';
  end if;

  if not role_exists then
    create role pintpath_migration_verifier_authority
      nologin nosuperuser nocreatedb nocreaterole inherit noreplication nobypassrls;
  end if;

  if not relation_exists then
    create table pintpath_ops.migration_verifier_authority (
      authority_id text primary key check (authority_id = 'active'),
      expected_environment text not null
        check (expected_environment in ('permanent-staging', 'production')),
      candidate_commit_sha text not null
        check (candidate_commit_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
      operator_id_sha256 text not null
        check (operator_id_sha256 ~ '^[0-9a-f]{64}$'),
      verifier_id_sha256 text not null
        check (verifier_id_sha256 ~ '^[0-9a-f]{64}$'),
      verifier_public_key_sha256 text not null
        check (verifier_public_key_sha256 ~ '^[0-9a-f]{64}$'),
      authority_policy_sha256 text not null
        check (authority_policy_sha256 ~ '^[0-9a-f]{64}$'),
      authority_sha256 text not null
        check (authority_sha256 ~ '^[0-9a-f]{64}$'),
      installed_at timestamptz not null
    );
    revoke all on pintpath_ops.migration_verifier_authority from public;
    alter table pintpath_ops.migration_verifier_authority enable row level security;
    alter table pintpath_ops.migration_verifier_authority force row level security;
    create policy migration_verifier_authority_migrator_select
      on pintpath_ops.migration_verifier_authority
      for select to pintpath_migrator using (true);
    create policy migration_verifier_authority_provisioner_select
      on pintpath_ops.migration_verifier_authority
      for select to pintpath_migration_verifier_authority using (true);
    create policy migration_verifier_authority_provisioner_insert
      on pintpath_ops.migration_verifier_authority
      for insert to pintpath_migration_verifier_authority with check (true);
    create policy migration_verifier_authority_provisioner_update
      on pintpath_ops.migration_verifier_authority
      for update to pintpath_migration_verifier_authority
      using (true) with check (true);
    grant usage on schema pintpath_ops
      to pintpath_migration_verifier_authority;
    grant select on pintpath_ops.migration_verifier_authority
      to pintpath_migrator;
    grant select, insert, update on pintpath_ops.migration_verifier_authority
      to pintpath_migration_verifier_authority;
  end if;

  select pg_catalog.to_regrole('pintpath_migration_verifier_authority')::oid,
         pg_catalog.to_regrole('pintpath_migrator')::oid,
         pg_catalog.to_regclass('pintpath_ops.migration_verifier_authority')::oid
    into strict verifier_role_oid, migrator_role_oid, authority_relation_oid;

  select count(*)::integer into exact_policy_count
  from pg_catalog.pg_policy as policy
  where policy.polrelid = authority_relation_oid
    and policy.polpermissive
    and (
      (policy.polname = 'migration_verifier_authority_migrator_select'
        and policy.polroles = array[migrator_role_oid]::oid[]
        and policy.polcmd = 'r'
        and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
        and policy.polwithcheck is null)
      or (policy.polname = 'migration_verifier_authority_provisioner_select'
        and policy.polroles = array[verifier_role_oid]::oid[]
        and policy.polcmd = 'r'
        and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
        and policy.polwithcheck is null)
      or (policy.polname = 'migration_verifier_authority_provisioner_insert'
        and policy.polroles = array[verifier_role_oid]::oid[]
        and policy.polcmd = 'a'
        and policy.polqual is null
        and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
      or (policy.polname = 'migration_verifier_authority_provisioner_update'
        and policy.polroles = array[verifier_role_oid]::oid[]
        and policy.polcmd = 'w'
        and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
        and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
    );

  if exact_policy_count <> 4
     or (select count(*) from pg_catalog.pg_policy
         where polrelid = authority_relation_oid) <> 4
     or not (select relrowsecurity and relforcerowsecurity
             from pg_catalog.pg_class where oid = authority_relation_oid)
     or exists (select 1 from pintpath_ops.migration_verifier_authority)
     or not has_schema_privilege(verifier_role_oid, 'pintpath_ops', 'USAGE')
     or has_schema_privilege(verifier_role_oid, 'pintpath_ops', 'CREATE')
     or has_schema_privilege(verifier_role_oid, 'pintpath_app', 'USAGE')
     or not has_table_privilege(verifier_role_oid, authority_relation_oid,
       'SELECT,INSERT,UPDATE')
     or has_table_privilege(verifier_role_oid, authority_relation_oid,
       'DELETE,TRUNCATE,TRIGGER,REFERENCES')
     or not has_table_privilege(migrator_role_oid, authority_relation_oid, 'SELECT')
     or has_table_privilege(migrator_role_oid, authority_relation_oid,
       'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
     or exists (
       select 1 from pg_catalog.pg_roles as role
       where role.oid = verifier_role_oid and (
         role.rolcanlogin or role.rolsuper or role.rolcreatedb
         or role.rolcreaterole or not role.rolinherit or role.rolreplication
         or role.rolbypassrls or role.rolconnlimit <> -1
         or role.rolvaliduntil is not null
       )
     )
     or exists (select 1 from pg_catalog.pg_auth_members
                where member = verifier_role_oid or roleid = verifier_role_oid)
     or exists (select 1 from pg_catalog.pg_db_role_setting
                where setrole = verifier_role_oid)
     or exists (select 1 from pg_catalog.pg_default_acl
                where defaclrole = verifier_role_oid)
     or exists (
       select 1 from pg_catalog.pg_shdepend
       where refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
         and refobjid = verifier_role_oid and deptype = 'o'
     )
     or exists (
       select 1 from pg_catalog.pg_policy as policy
       join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
       where policy.polroles = array[0]::oid[]
         and relation.oid = authority_relation_oid
     ) then
    raise exception using errcode = '42501',
      message = 'postgres_migration_verifier_authority_boundary_invalid';
  end if;
end
$pintpath_verifier_authority$;

commit;
