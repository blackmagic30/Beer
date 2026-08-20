begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(11);

select ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) browser_role(role_name)
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege(
        browser_role.role_name,
        c.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
  ),
  'browser JWT roles have no effective privileges on public relations, including grants inherited from PUBLIC'
);

select ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) browser_role(role_name)
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_any_column_privilege(
        browser_role.role_name,
        c.oid,
        'SELECT,INSERT,UPDATE,REFERENCES'
      )
  ),
  'browser JWT roles have no effective public column privileges, including grants inherited from PUBLIC'
);

select ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) browser_role(role_name)
    where n.nspname = 'public'
      and c.relkind = 'S'
      and has_sequence_privilege(
        browser_role.role_name,
        c.oid,
        'USAGE,SELECT,UPDATE'
      )
  ),
  'browser JWT roles have no effective public sequence privileges, including grants inherited from PUBLIC'
);

select ok(
  has_table_privilege('service_role', 'public.profiles', 'SELECT'),
  'service_role can run the isolated restore readiness probe'
);

select ok(
  has_table_privilege(
    'service_role',
    'public.pintpath_storage_policy_posture',
    'SELECT'
  )
    and not has_table_privilege(
      'service_role',
      'public.pintpath_storage_policy_posture',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
    and not exists (
      select 1
      from pg_catalog.pg_class relation
      cross join lateral pg_catalog.aclexplode(
        coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) acl
      where relation.oid = 'public.pintpath_storage_policy_posture'::pg_catalog.regclass
        and acl.grantee = 0
    ),
  'service_role has only SELECT and PUBLIC has no ACL on the aggregate Storage posture'
);

select ok(
  not has_table_privilege(
    'anon',
    'public.pintpath_storage_policy_posture',
    'SELECT'
  )
    and not has_table_privilege(
      'authenticated',
      'public.pintpath_storage_policy_posture',
      'SELECT'
    ),
  'browser JWT roles cannot read the Storage posture view'
);

set local role service_role;

select ok(
  (
    select object_policy_count = 0
      and object_rls_enabled is true
      and bucket_policy_count = 0
      and bucket_rls_enabled is true
      and public_bucket_count = 0
    from public.pintpath_storage_policy_posture
  ),
  'service_role can execute the invoker-rights Storage posture probe'
);

reset role;

select ok(
  not has_schema_privilege('authenticated', 'private', 'USAGE')
    and not has_schema_privilege('anon', 'private', 'USAGE'),
  'browser JWT roles cannot resolve private helper functions'
);

select ok(
  not has_function_privilege('authenticated', 'private.beermap_upload_owner(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.beermap_is_admin(uuid)', 'EXECUTE'),
  'authenticated cannot execute private RLS helpers after Data API retirement'
);

select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'anon cannot execute private helper functions'
);

select ok(
  not exists (
    select 1
    from pg_default_acl d
    left join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) acl
    left join pg_roles grantee on grantee.oid = acl.grantee
    where d.defaclrole = 'postgres'::regrole
      and n.nspname = 'public'
      and (
        (
          d.defaclobjtype in ('r', 'S')
          and (
            acl.grantee = 0
            or grantee.rolname in ('anon', 'authenticated', 'service_role')
          )
        )
        or (
          d.defaclobjtype = 'f'
          and (
            acl.grantee = 0
            or grantee.rolname in ('anon', 'authenticated', 'service_role')
          )
        )
      )
  ),
  'future postgres-owned public objects remain private until explicitly granted'
);

select * from finish();

rollback;
