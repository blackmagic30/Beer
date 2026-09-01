import type { QueryResultRow } from "pg";

import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "./postgres-migration-schema.js";

export const POSTGRES_MIGRATION_LIVE_SCHEMA_KIND =
  "pint-path-postgres-migration-live-schema" as const;
export const POSTGRES_MIGRATION_LIVE_SCHEMA_VERSION = 1 as const;

// Generated from a clean PostgreSQL 17 application of
// src/db/postgres-schema.sql. Update only through the reviewed regeneration
// command after examining the canonical object diff.
export const POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_SHA256 =
  "861ae08b4486b491cb54aa081edda8ed1ebbf2c35cfb0cd792400c4e6d519c88" as const;
export const POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_OBJECT_COUNT = 1555 as const;

export interface PostgresMigrationLiveSchemaConnection {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: Row[]; readonly rowCount: number | null }>;
}

type LiveSchemaRow = QueryResultRow & {
  objectKind: string;
  objectIdentity: string;
  objectDefinition: unknown;
};

export interface PostgresMigrationLiveSchemaInspection {
  readonly objectCount: number;
  readonly sha256: string;
}

const LIVE_SCHEMA_QUERY = `/* pintpath:migration:live-schema-contract */
WITH
database_context AS (
  SELECT database.oid AS database_oid, database.datdba AS owner_oid
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = pg_catalog.current_database()
),
target_namespaces AS (
  SELECT namespace.oid, namespace.nspname, namespace.nspowner, namespace.nspacl
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname IN ('pintpath_app', 'pintpath_ops')
),
namespace_rows AS (
  SELECT
    'namespace'::text AS "objectKind",
    namespace.nspname::text AS "objectIdentity",
    pg_catalog.jsonb_build_object(
      'owner', CASE
        WHEN namespace.nspowner = database_context.owner_oid THEN '@database-owner'
        ELSE pg_catalog.pg_get_userbyid(namespace.nspowner)
      END,
      'acl', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'grantee', CASE
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              WHEN privilege.grantee = database_context.owner_oid THEN '@database-owner'
              WHEN grantee.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
                THEN '@logical-backup-role'
              ELSE grantee.rolname
            END,
            'grantor', CASE
              WHEN privilege.grantor = database_context.owner_oid THEN '@database-owner'
              ELSE grantor.rolname
            END,
            'privilege', privilege.privilege_type,
            'grantable', privilege.is_grantable
          )
          ORDER BY CASE
            WHEN privilege.grantee = 0 THEN 'PUBLIC'
            WHEN privilege.grantee = database_context.owner_oid THEN '@database-owner'
            WHEN grantee.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
              THEN '@logical-backup-role'
            ELSE grantee.rolname
          END, CASE
            WHEN privilege.grantor = database_context.owner_oid THEN '@database-owner'
            ELSE grantor.rolname
          END, privilege.privilege_type, privilege.is_grantable
        )
        FROM pg_catalog.aclexplode(
          COALESCE(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
        ) AS privilege
        LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        LEFT JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
      ), '[]'::jsonb)
    ) AS "objectDefinition"
  FROM target_namespaces AS namespace
  CROSS JOIN database_context
),
relation_rows AS (
  SELECT
    'relation'::text AS "objectKind",
    (namespace.nspname || '.' || relation.relname)::text AS "objectIdentity",
    pg_catalog.jsonb_build_object(
      'kind', relation.relkind,
      'persistence', relation.relpersistence,
      'rowSecurity', relation.relrowsecurity,
      'forceRowSecurity', relation.relforcerowsecurity,
      'replicaIdentity', relation.relreplident,
      'owner', CASE
        WHEN relation.relowner = database_context.owner_oid THEN '@database-owner'
        ELSE pg_catalog.pg_get_userbyid(relation.relowner)
      END,
      'acl', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'grantee', CASE
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              WHEN privilege.grantee = database_context.owner_oid THEN '@database-owner'
              WHEN grantee.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
                THEN '@logical-backup-role'
              ELSE grantee.rolname
            END,
            'grantor', CASE
              WHEN privilege.grantor = database_context.owner_oid THEN '@database-owner'
              ELSE grantor.rolname
            END,
            'privilege', privilege.privilege_type,
            'grantable', privilege.is_grantable
          )
          ORDER BY CASE
            WHEN privilege.grantee = 0 THEN 'PUBLIC'
            WHEN privilege.grantee = database_context.owner_oid THEN '@database-owner'
            WHEN grantee.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
              THEN '@logical-backup-role'
            ELSE grantee.rolname
          END, CASE
            WHEN privilege.grantor = database_context.owner_oid THEN '@database-owner'
            ELSE grantor.rolname
          END, privilege.privilege_type, privilege.is_grantable
        )
        FROM pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault(
              CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
              relation.relowner
            )
          )
        ) AS privilege
        LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        LEFT JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
      ), '[]'::jsonb)
    ) AS "objectDefinition"
  FROM pg_catalog.pg_class AS relation
  JOIN target_namespaces AS namespace ON namespace.oid = relation.relnamespace
  CROSS JOIN database_context
  WHERE relation.relkind IN ('r', 'p', 'S', 'v', 'm')
),
column_rows AS (
  SELECT
    'column'::text AS "objectKind",
    (namespace.nspname || '.' || relation.relname || '.' || attribute.attname)::text
      AS "objectIdentity",
    pg_catalog.jsonb_build_object(
      'ordinal', attribute.attnum,
      'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
      'notNull', attribute.attnotnull,
      'identity', attribute.attidentity,
      'generated', attribute.attgenerated,
      'compression', attribute.attcompression,
      'collation', CASE
        WHEN attribute.attcollation = 0 THEN NULL
        ELSE attribute.attcollation::pg_catalog.regcollation::text
      END,
      'default', pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false),
      'acl', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'grantee', CASE
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              WHEN privilege.grantee = database_context.owner_oid THEN '@database-owner'
              WHEN grantee.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
                THEN '@logical-backup-role'
              ELSE grantee.rolname
            END,
            'grantor', CASE
              WHEN privilege.grantor = database_context.owner_oid THEN '@database-owner'
              ELSE grantor.rolname
            END,
            'privilege', privilege.privilege_type,
            'grantable', privilege.is_grantable
          )
          ORDER BY CASE
            WHEN privilege.grantee = 0 THEN 'PUBLIC'
            WHEN privilege.grantee = database_context.owner_oid THEN '@database-owner'
            WHEN grantee.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
              THEN '@logical-backup-role'
            ELSE grantee.rolname
          END, CASE
            WHEN privilege.grantor = database_context.owner_oid THEN '@database-owner'
            ELSE grantor.rolname
          END, privilege.privilege_type, privilege.is_grantable
        )
        FROM pg_catalog.aclexplode(attribute.attacl) AS privilege
        LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        LEFT JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
      ), '[]'::jsonb)
    ) AS "objectDefinition"
  FROM pg_catalog.pg_class AS relation
  JOIN target_namespaces AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
  LEFT JOIN pg_catalog.pg_attrdef AS default_value
    ON default_value.adrelid = relation.oid
    AND default_value.adnum = attribute.attnum
  CROSS JOIN database_context
  WHERE relation.relkind IN ('r', 'p', 'S', 'v', 'm')
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
),
constraint_rows AS (
  SELECT
    'constraint'::text AS "objectKind",
    (namespace.nspname || '.' || relation.relname || '.' || constraint_record.conname)::text
      AS "objectIdentity",
    pg_catalog.jsonb_build_object(
      'type', constraint_record.contype,
      'definition', pg_catalog.pg_get_constraintdef(constraint_record.oid, false),
      'validated', constraint_record.convalidated,
      'deferrable', constraint_record.condeferrable,
      'deferred', constraint_record.condeferred,
      'local', constraint_record.conislocal,
      'inheritCount', constraint_record.coninhcount,
      'noInherit', constraint_record.connoinherit
    ) AS "objectDefinition"
  FROM pg_catalog.pg_constraint AS constraint_record
  JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
  JOIN target_namespaces AS namespace ON namespace.oid = relation.relnamespace
),
index_rows AS (
  SELECT
    'index'::text AS "objectKind",
    (namespace.nspname || '.' || index_relation.relname)::text AS "objectIdentity",
    pg_catalog.jsonb_build_object(
      'table', namespace.nspname || '.' || table_relation.relname,
      'definition', pg_catalog.pg_get_indexdef(index_relation.oid, 0, false),
      'unique', index_record.indisunique,
      'primary', index_record.indisprimary,
      'exclusion', index_record.indisexclusion,
      'immediate', index_record.indimmediate,
      'valid', index_record.indisvalid,
      'ready', index_record.indisready,
      'live', index_record.indislive,
      'clustered', index_record.indisclustered,
      'replicaIdentity', index_record.indisreplident,
      'predicate', pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid, false),
      'expressions', pg_catalog.pg_get_expr(index_record.indexprs, index_record.indrelid, false)
    ) AS "objectDefinition"
  FROM pg_catalog.pg_index AS index_record
  JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = index_record.indrelid
  JOIN target_namespaces AS namespace ON namespace.oid = table_relation.relnamespace
  JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
),
trigger_rows AS (
  SELECT
    'trigger'::text AS "objectKind",
    (namespace.nspname || '.' || relation.relname || '.' || trigger_record.tgname)::text
      AS "objectIdentity",
    pg_catalog.jsonb_build_object(
      'definition', pg_catalog.pg_get_triggerdef(trigger_record.oid, false),
      'enabled', trigger_record.tgenabled,
      'type', trigger_record.tgtype,
      'constraint', trigger_record.tgconstraint <> 0
    ) AS "objectDefinition"
  FROM pg_catalog.pg_trigger AS trigger_record
  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
  JOIN target_namespaces AS namespace ON namespace.oid = relation.relnamespace
  WHERE NOT trigger_record.tgisinternal
),
policy_rows AS (
  SELECT
    'policy'::text AS "objectKind",
    (namespace.nspname || '.' || relation.relname || '.' || policy.polname)::text
      AS "objectIdentity",
    pg_catalog.jsonb_build_object(
      'command', policy.polcmd,
      'permissive', policy.polpermissive,
      'roles', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          CASE
            WHEN role_oid = 0 THEN 'PUBLIC'
            WHEN role_record.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
              THEN '@logical-backup-role'
            ELSE role_record.rolname
          END
          ORDER BY CASE
            WHEN role_oid = 0 THEN 'PUBLIC'
            WHEN role_record.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
              THEN '@logical-backup-role'
            ELSE role_record.rolname
          END
        )
        FROM pg_catalog.unnest(policy.polroles) AS role_ids(role_oid)
        LEFT JOIN pg_catalog.pg_roles AS role_record ON role_record.oid = role_oid
      ), '[]'::jsonb),
      'using', pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false),
      'check', pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false)
    ) AS "objectDefinition"
  FROM pg_catalog.pg_policy AS policy
  JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
  JOIN target_namespaces AS namespace ON namespace.oid = relation.relnamespace
),
routine_rows AS (
  SELECT
    'routine'::text AS "objectKind",
    (namespace.nspname || '.' || routine.proname || '(' ||
      pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')')::text AS "objectIdentity",
    pg_catalog.jsonb_build_object(
      'kind', routine.prokind,
      'owner', CASE
        WHEN routine.proowner = database_context.owner_oid THEN '@database-owner'
        ELSE pg_catalog.pg_get_userbyid(routine.proowner)
      END,
      'language', language.lanname,
      'securityDefiner', routine.prosecdef,
      'leakproof', routine.proleakproof,
      'strict', routine.proisstrict,
      'volatility', routine.provolatile,
      'parallel', routine.proparallel,
      'config', COALESCE(pg_catalog.to_jsonb(routine.proconfig), '[]'::jsonb),
      'definition', pg_catalog.pg_get_functiondef(routine.oid),
      'acl', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'grantee', CASE
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              WHEN privilege.grantee = database_context.owner_oid THEN '@database-owner'
              WHEN grantee.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
                THEN '@logical-backup-role'
              ELSE grantee.rolname
            END,
            'grantor', CASE
              WHEN privilege.grantor = database_context.owner_oid THEN '@database-owner'
              ELSE grantor.rolname
            END,
            'privilege', privilege.privilege_type,
            'grantable', privilege.is_grantable
          )
          ORDER BY CASE
            WHEN privilege.grantee = 0 THEN 'PUBLIC'
            WHEN privilege.grantee = database_context.owner_oid THEN '@database-owner'
            WHEN grantee.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
              THEN '@logical-backup-role'
            ELSE grantee.rolname
          END, CASE
            WHEN privilege.grantor = database_context.owner_oid THEN '@database-owner'
            ELSE grantor.rolname
          END, privilege.privilege_type, privilege.is_grantable
        )
        FROM pg_catalog.aclexplode(
          COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        ) AS privilege
        LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        LEFT JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
      ), '[]'::jsonb)
    ) AS "objectDefinition"
  FROM pg_catalog.pg_proc AS routine
  JOIN target_namespaces AS namespace ON namespace.oid = routine.pronamespace
  JOIN pg_catalog.pg_language AS language ON language.oid = routine.prolang
  CROSS JOIN database_context
),
type_rows AS (
  SELECT
    'type'::text AS "objectKind",
    (namespace.nspname || '.' || type_record.typname)::text AS "objectIdentity",
    pg_catalog.jsonb_build_object(
      'kind', type_record.typtype,
      'category', type_record.typcategory,
      'notNull', type_record.typnotnull,
      'baseType', CASE
        WHEN type_record.typbasetype = 0 THEN NULL
        ELSE pg_catalog.format_type(type_record.typbasetype, type_record.typtypmod)
      END,
      'default', type_record.typdefault,
      'collation', CASE
        WHEN type_record.typcollation = 0 THEN NULL
        ELSE type_record.typcollation::pg_catalog.regcollation::text
      END,
      'enumLabels', COALESCE((
        SELECT pg_catalog.jsonb_agg(enum.enumlabel ORDER BY enum.enumsortorder)
        FROM pg_catalog.pg_enum AS enum
        WHERE enum.enumtypid = type_record.oid
      ), '[]'::jsonb)
    ) AS "objectDefinition"
  FROM pg_catalog.pg_type AS type_record
  JOIN target_namespaces AS namespace ON namespace.oid = type_record.typnamespace
  WHERE type_record.typtype IN ('d', 'e')
),
default_acl_rows AS (
  SELECT
    'default-acl'::text AS "objectKind",
    (
      CASE
        WHEN default_acl.defaclrole = database_context.owner_oid THEN '@database-owner'
        ELSE owner_role.rolname
      END || ':' || COALESCE(namespace.nspname, '@global') || ':'
        || default_acl.defaclobjtype::text
    )::text AS "objectIdentity",
    pg_catalog.jsonb_build_object(
      'acl', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'grantee', CASE
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              WHEN privilege.grantee = database_context.owner_oid THEN '@database-owner'
              WHEN grantee.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
                THEN '@logical-backup-role'
              ELSE grantee.rolname
            END,
            'grantor', CASE
              WHEN privilege.grantor = database_context.owner_oid THEN '@database-owner'
              ELSE grantor.rolname
            END,
            'privilege', privilege.privilege_type,
            'grantable', privilege.is_grantable
          )
          ORDER BY CASE
            WHEN privilege.grantee = 0 THEN 'PUBLIC'
            WHEN privilege.grantee = database_context.owner_oid THEN '@database-owner'
            WHEN grantee.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
              THEN '@logical-backup-role'
            ELSE grantee.rolname
          END, CASE
            WHEN privilege.grantor = database_context.owner_oid THEN '@database-owner'
            ELSE grantor.rolname
          END, privilege.privilege_type, privilege.is_grantable
        )
        FROM pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
        LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        LEFT JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
      ), '[]'::jsonb)
    ) AS "objectDefinition"
  FROM pg_catalog.pg_default_acl AS default_acl
  LEFT JOIN target_namespaces AS namespace ON namespace.oid = default_acl.defaclnamespace
  JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = default_acl.defaclrole
  CROSS JOIN database_context
  WHERE default_acl.defaclnamespace = 0
    OR namespace.oid IS NOT NULL
)
SELECT * FROM namespace_rows
UNION ALL SELECT * FROM relation_rows
UNION ALL SELECT * FROM column_rows
UNION ALL SELECT * FROM constraint_rows
UNION ALL SELECT * FROM index_rows
UNION ALL SELECT * FROM trigger_rows
UNION ALL SELECT * FROM policy_rows
UNION ALL SELECT * FROM routine_rows
UNION ALL SELECT * FROM type_rows
UNION ALL SELECT * FROM default_acl_rows
ORDER BY "objectKind", "objectIdentity"`;

function exactText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new TypeError(`Invalid live-schema ${field}.`);
  }
  return value;
}

export async function inspectPostgresMigrationLiveSchema(
  connection: PostgresMigrationLiveSchemaConnection,
): Promise<PostgresMigrationLiveSchemaInspection> {
  const result = await connection.query<LiveSchemaRow>(LIVE_SCHEMA_QUERY);
  if (
    result.rowCount !== result.rows.length
    || result.rows.length === 0
    || result.rows.length > 10_000
  ) {
    throw new TypeError("Invalid live-schema catalog result.");
  }
  const seen = new Set<string>();
  const objects = result.rows.map((row) => {
    const kind = exactText(row.objectKind, "object kind");
    const identity = exactText(row.objectIdentity, "object identity");
    const key = `${kind}\0${identity}`;
    if (seen.has(key)) throw new TypeError("Duplicate live-schema object identity.");
    seen.add(key);
    return {
      definition: row.objectDefinition,
      identity,
      kind,
    };
  });
  const canonical = serializeCanonicalPostgresMigrationJson({
    kind: POSTGRES_MIGRATION_LIVE_SCHEMA_KIND,
    objects,
    version: POSTGRES_MIGRATION_LIVE_SCHEMA_VERSION,
  });
  return {
    objectCount: objects.length,
    sha256: sha256PostgresMigrationBytes(canonical),
  };
}

export const postgresMigrationLiveSchemaInternals = {
  LIVE_SCHEMA_QUERY,
};
