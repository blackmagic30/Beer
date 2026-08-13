import type { QueryResultRow } from "pg";

import {
  POSTGRES_APPLICATION_SCHEMA,
  POSTGRES_OPERATIONS_SCHEMA,
  type SqlDatabase,
  type SqlPoolMetrics,
} from "./sql-database.js";

export const POSTGRES_RUNTIME_ROLE = "pintpath_runtime";
export const SUPPORTED_POSTGRES_SCHEMA_VERSION = "1";
export const EXPECTED_POSTGRES_AUTHORITATIVE_TABLES = 56;

export const POSTGRES_RUNTIME_WRITE_TABLES = Object.freeze([
  "account_deletion_completion_outbox",
  "account_deletion_notice_recipient_secrets",
  "account_deletion_notification_events",
  "account_deletion_requests",
  "account_discount_passes",
  "account_preferences",
  "account_privacy_settings",
  "account_reward_vouchers",
  "accounts",
  "admin_ingestion_queue",
  "age_verifications",
  "auth_sessions",
  "beer_catalog_aliases",
  "beer_catalog_items",
  "billing_checkout_reservations",
  "discount_redemptions",
  "events",
  "feedback",
  "free_pint_reward_codes",
  "free_pint_reward_redemptions",
  "leaderboard_prize_awards",
  "leaderboard_prize_campaigns",
  "migration_quarantined_records",
  "mission_progress",
  "missions",
  "pint_point_drink_records",
  "profiles",
  "revoked_provider_sessions",
  "saved_items",
  "source_evidence_objects",
  "stripe_webhook_events",
  "submission_items",
  "submission_source_evidence",
  "submissions",
  "system_state",
  "user_activity_events",
  "venue_analytics_events",
  "venue_beers",
  "venue_claim_requests",
  "venue_happy_hours",
  "venue_identity_aliases",
  "venue_interest_requests",
  "venue_location_cache",
  "venue_manager_assignments",
  "venue_monthly_reports",
  "venue_partner_outreach",
  "venue_pending_changes",
  "venue_price_records",
  "venue_profiles",
  "venue_requests",
  "venue_specials",
  "verifications",
  "wrong_price_reports",
] as const);

export const POSTGRES_RUNTIME_APPEND_ONLY_TABLES = Object.freeze([
  "contribution_ledger",
  "pint_point_ledger",
  "security_audit_log",
] as const);

export const POSTGRES_RUNTIME_SELECT_TABLES = Object.freeze([
  ...POSTGRES_RUNTIME_WRITE_TABLES,
  ...POSTGRES_RUNTIME_APPEND_ONLY_TABLES,
  "schema_metadata",
] as const);

export const POSTGRES_RUNTIME_INSERT_TABLES = Object.freeze([
  ...POSTGRES_RUNTIME_WRITE_TABLES,
  ...POSTGRES_RUNTIME_APPEND_ONLY_TABLES,
] as const);

export const POSTGRES_RUNTIME_FUNCTIONS = Object.freeze([
  "clear_account_references_before_delete",
  "datetime",
  "instr",
  "json_each",
  "json_extract",
  "json_valid",
  "julianday",
  "strftime",
] as const);

export type PostgresRuntimeFailureCode =
  | "not_postgres"
  | "runtime_role_unsafe"
  | "search_path_unsafe"
  | "schema_version_unsupported"
  | "import_not_ready"
  | "authoritative_table_count_mismatch"
  | "operations_schema_accessible"
  | "application_schema_exposed"
  | "catalog_check_failed";

export interface PostgresRuntimeChecks {
  dialect: boolean;
  runtimeRole: boolean;
  searchPath: boolean;
  schemaVersion: boolean;
  importReady: boolean;
  authoritativeTables: boolean;
  operationsIsolation: boolean;
  applicationSchemaIsolation: boolean;
}

export interface SafePostgresRuntimeMetrics {
  schemaVersion: "supported" | "unsupported" | "unavailable";
  importState: "ready" | "not-ready" | "unavailable";
  authoritativeTableCount: number | null;
  expectedAuthoritativeTableCount: number;
  pool: SqlPoolMetrics;
}

export interface PostgresRuntimeReadiness {
  ready: boolean;
  checks: PostgresRuntimeChecks;
  failures: PostgresRuntimeFailureCode[];
  metrics: SafePostgresRuntimeMetrics;
}

interface RuntimeSessionRow extends QueryResultRow {
  activeRoleExact: boolean;
  isSuperuser: boolean;
  canBypassRls: boolean;
  isRuntimeMember: boolean;
  loginCanLogin: boolean;
  loginCanCreateDatabase: boolean;
  loginCanCreateRole: boolean;
  loginInheritsPrivileges: boolean;
  loginCanReplicate: boolean;
  loginConnectionLimit: number;
  loginValidUntilNull: boolean;
  loginMemberships: unknown;
  loginMembershipOptionsExact: boolean;
  runtimeRoleSafe: boolean;
  runtimeRoleParents: unknown;
  runtimeRoleChildrenExact: boolean;
  runtimeRoleChildrenSafeForRotation: boolean;
  hasRoleSettings: boolean;
  canConnectDatabase: boolean;
  canCreateDatabaseObjects: boolean;
  canCreateTemporaryObjects: boolean;
  databaseAclExact: boolean;
  hasUnsafeDirectAclDependencies: boolean;
  ownsDatabaseObjects: boolean;
  hasUnsafeDefaultPrivileges: boolean;
  searchPathSchemas: string[];
  currentSchema: string | null;
}

interface MetadataRow extends QueryResultRow {
  key: string;
  value: string;
}

interface AuthoritativeTableCountRow extends QueryResultRow {
  tableCount: number;
}

interface AccessCheckRow extends QueryResultRow {
  hasAccess: boolean;
}

interface RuntimeAuthorityRow extends QueryResultRow {
  selectTables: unknown;
  insertTables: unknown;
  updateTables: unknown;
  deleteTables: unknown;
  functions: unknown;
  canUseApplicationSchema: boolean;
  canCreateApplicationObjects: boolean;
  hasApplicationSequenceAccess: boolean;
  hasUnexpectedTableAuthority: boolean;
  hasColumnAclEntries: boolean;
  hasUnexpectedAclDependency: boolean;
  hasGrantableAcl: boolean;
}

const RUNTIME_SESSION_QUERY = `/* pintpath:postgres-runtime:session */
SELECT
  (
    current_user = '${POSTGRES_RUNTIME_ROLE}'
    AND session_user <> current_user
    AND NOT active_role.rolcanlogin
    AND login_role.rolcanlogin
  ) AS "activeRoleExact",
  (active_role.rolsuper OR login_role.rolsuper) AS "isSuperuser",
  (active_role.rolbypassrls OR login_role.rolbypassrls) AS "canBypassRls",
  COALESCE(
    pg_has_role(session_user, to_regrole('${POSTGRES_RUNTIME_ROLE}'), 'MEMBER')
      AND pg_has_role(current_user, to_regrole('${POSTGRES_RUNTIME_ROLE}'), 'USAGE'),
    false
  ) AS "isRuntimeMember",
  login_role.rolcanlogin AS "loginCanLogin",
  login_role.rolcreatedb AS "loginCanCreateDatabase",
  login_role.rolcreaterole AS "loginCanCreateRole",
  login_role.rolinherit AS "loginInheritsPrivileges",
  login_role.rolreplication AS "loginCanReplicate",
  login_role.rolconnlimit AS "loginConnectionLimit",
  login_role.rolvaliduntil IS NULL AS "loginValidUntilNull",
  COALESCE((
    SELECT jsonb_agg(granted.rolname::text ORDER BY granted.rolname::text COLLATE "C")
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
    WHERE membership.member = login_role.oid
  ), '[]'::jsonb) AS "loginMemberships",
  COALESCE((
    SELECT pg_catalog.count(*) = 1
      AND pg_catalog.bool_and(
        granted.rolname = '${POSTGRES_RUNTIME_ROLE}'
        AND NOT membership.admin_option
        AND NOT membership.inherit_option
        AND membership.set_option
      )
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
    WHERE membership.member = login_role.oid
  ), false) AS "loginMembershipOptionsExact",
  (
    NOT active_role.rolcanlogin
    AND NOT active_role.rolsuper
    AND NOT active_role.rolcreatedb
    AND NOT active_role.rolcreaterole
    AND active_role.rolinherit
    AND NOT active_role.rolreplication
    AND NOT active_role.rolbypassrls
    AND active_role.rolconnlimit = -1
    AND active_role.rolvaliduntil IS NULL
  ) AS "runtimeRoleSafe",
  COALESCE((
    SELECT jsonb_agg(parent.rolname::text ORDER BY parent.rolname::text COLLATE "C")
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
    WHERE membership.member = active_role.oid
  ), '[]'::jsonb) AS "runtimeRoleParents",
  COALESCE((
    SELECT pg_catalog.count(*) = 1
      AND pg_catalog.bool_and(
        child.oid = login_role.oid
        AND NOT membership.admin_option
        AND NOT membership.inherit_option
        AND membership.set_option
      )
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
    WHERE membership.roleid = active_role.oid
  ), false) AS "runtimeRoleChildrenExact",
  COALESCE((
    SELECT pg_catalog.count(*) BETWEEN 1 AND 2
      AND pg_catalog.bool_or(child.oid = login_role.oid)
      AND pg_catalog.bool_and(
        child.rolcanlogin
        AND NOT child.rolsuper
        AND NOT child.rolcreatedb
        AND NOT child.rolcreaterole
        AND NOT child.rolinherit
        AND NOT child.rolreplication
        AND NOT child.rolbypassrls
        AND child.rolconnlimit = 8
        AND child.rolvaliduntil IS NULL
        AND NOT membership.admin_option
        AND NOT membership.inherit_option
        AND membership.set_option
        AND (
          SELECT pg_catalog.count(*) = 1
          FROM pg_catalog.pg_auth_members AS child_membership
          WHERE child_membership.member = child.oid
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_db_role_setting AS setting
          WHERE setting.setrole = child.oid
        )
        AND has_database_privilege(child.oid, current_database(), 'CONNECT')
        AND NOT has_database_privilege(child.oid, current_database(), 'CREATE')
        AND NOT has_database_privilege(child.oid, current_database(), 'TEMP')
        AND (
          SELECT pg_catalog.count(*) = 1
            AND pg_catalog.bool_and(
              grant_entry.privilege_type = 'CONNECT'
              AND NOT grant_entry.is_grantable
            )
          FROM pg_catalog.pg_database AS database
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(database.datacl, pg_catalog.acldefault('d', database.datdba))
          ) AS grant_entry
          WHERE database.datname = pg_catalog.current_database()
            AND grant_entry.grantee = child.oid
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
          WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            AND dependency.refobjid = child.oid
            AND dependency.deptype IN ('a', 'o')
            AND NOT (
              dependency.deptype = 'a'
              AND dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
              AND dependency.objid = (
                SELECT database.oid FROM pg_catalog.pg_database AS database
                WHERE database.datname = pg_catalog.current_database()
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_default_acl AS defaults
          WHERE defaults.defaclrole = child.oid
        )
      )
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
    WHERE membership.roleid = active_role.oid
  ), false) AS "runtimeRoleChildrenSafeForRotation",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_db_role_setting AS setting
    WHERE setting.setrole IN (login_role.oid, active_role.oid)
  ) AS "hasRoleSettings",
  has_database_privilege(session_user, current_database(), 'CONNECT')
    AS "canConnectDatabase",
  has_database_privilege(session_user, current_database(), 'CREATE')
    AS "canCreateDatabaseObjects",
  has_database_privilege(session_user, current_database(), 'TEMP')
    AS "canCreateTemporaryObjects",
  COALESCE((
    SELECT pg_catalog.count(*) = 1
      AND pg_catalog.bool_and(
        grant_entry.privilege_type = 'CONNECT'
        AND NOT grant_entry.is_grantable
      )
    FROM pg_catalog.pg_database AS database
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(database.datacl, pg_catalog.acldefault('d', database.datdba))
    ) AS grant_entry
    WHERE database.datname = pg_catalog.current_database()
      AND grant_entry.grantee = login_role.oid
  ), false) AS "databaseAclExact",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.refobjid = login_role.oid
      AND dependency.deptype = 'a'
      AND NOT (
        dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
        AND dependency.objid = (
          SELECT database.oid FROM pg_catalog.pg_database AS database
          WHERE database.datname = pg_catalog.current_database()
        )
      )
  ) AS "hasUnsafeDirectAclDependencies",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.refobjid IN (login_role.oid, active_role.oid)
      AND dependency.deptype = 'o'
  ) AS "ownsDatabaseObjects",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl AS defaults
    WHERE defaults.defaclrole IN (login_role.oid, active_role.oid)
  ) AS "hasUnsafeDefaultPrivileges",
  current_schemas(false)::text[] AS "searchPathSchemas",
  current_schema() AS "currentSchema"
FROM pg_catalog.pg_roles AS active_role
JOIN pg_catalog.pg_roles AS login_role
  ON login_role.rolname = session_user
WHERE active_role.rolname = current_user`;

const SCHEMA_METADATA_QUERY = `/* pintpath:postgres-runtime:metadata */
SELECT key, value
FROM ${POSTGRES_APPLICATION_SCHEMA}.schema_metadata
WHERE key IN ('schema_version', 'import_state')
ORDER BY key`;

const AUTHORITATIVE_TABLE_COUNT_QUERY = `/* pintpath:postgres-runtime:table-count */
SELECT count(*)::integer AS "tableCount"
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = '${POSTGRES_APPLICATION_SCHEMA}'
  AND relation.relkind IN ('r', 'p')
  AND relation.relname <> 'schema_metadata'`;

const RUNTIME_AUTHORITY_QUERY = `/* pintpath:postgres-runtime:authority */
WITH application_namespace AS (
  SELECT namespace.oid
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname = '${POSTGRES_APPLICATION_SCHEMA}'
), application_tables AS (
  SELECT relation.oid, relation.relname, relation.relowner, relation.relacl
  FROM pg_catalog.pg_class AS relation
  JOIN application_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.relkind IN ('r', 'p')
), application_sequences AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN application_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.relkind = 'S'
), application_functions AS (
  SELECT routine.oid, routine.proname
  FROM pg_catalog.pg_proc AS routine
  JOIN application_namespace AS namespace ON namespace.oid = routine.pronamespace
), application_columns AS (
  SELECT attribute.attrelid, attribute.attacl
  FROM pg_catalog.pg_attribute AS attribute
  JOIN application_tables AS relation ON relation.oid = attribute.attrelid
  WHERE attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND attribute.attacl IS NOT NULL
), login_and_runtime AS (
  SELECT role.oid
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname IN (session_user::text, '${POSTGRES_RUNTIME_ROLE}')
)
SELECT
  COALESCE((SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
    FROM application_tables AS table_name
    WHERE has_table_privilege(current_user, table_name.oid, 'SELECT')),
    '[]'::jsonb) AS "selectTables",
  COALESCE((SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
    FROM application_tables AS table_name
    WHERE has_table_privilege(current_user, table_name.oid, 'INSERT')),
    '[]'::jsonb) AS "insertTables",
  COALESCE((SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
    FROM application_tables AS table_name
    WHERE has_table_privilege(current_user, table_name.oid, 'UPDATE')),
    '[]'::jsonb) AS "updateTables",
  COALESCE((SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
    FROM application_tables AS table_name
    WHERE has_table_privilege(current_user, table_name.oid, 'DELETE')),
    '[]'::jsonb) AS "deleteTables",
  COALESCE((SELECT jsonb_agg(routine.proname ORDER BY routine.proname)
    FROM application_functions AS routine
    WHERE has_function_privilege(current_user, routine.oid, 'EXECUTE')),
    '[]'::jsonb) AS "functions",
  has_schema_privilege(current_user, '${POSTGRES_APPLICATION_SCHEMA}', 'USAGE')
    AS "canUseApplicationSchema",
  has_schema_privilege(current_user, '${POSTGRES_APPLICATION_SCHEMA}', 'CREATE')
    AS "canCreateApplicationObjects",
  EXISTS (SELECT 1 FROM application_sequences AS sequence
    WHERE has_sequence_privilege(current_user, sequence.oid, 'USAGE')
       OR has_sequence_privilege(current_user, sequence.oid, 'SELECT')
       OR has_sequence_privilege(current_user, sequence.oid, 'UPDATE'))
    AS "hasApplicationSequenceAccess",
  EXISTS (SELECT 1 FROM application_tables AS relation
    WHERE has_table_privilege(current_user, relation.oid, 'TRUNCATE')
       OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
       OR has_table_privilege(current_user, relation.oid, 'TRIGGER'))
    AS "hasUnexpectedTableAuthority",
  EXISTS (SELECT 1 FROM application_columns AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    WHERE privilege.grantee IN (SELECT oid FROM login_and_runtime))
    AS "hasColumnAclEntries",
  EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.refobjid = pg_catalog.to_regrole('${POSTGRES_RUNTIME_ROLE}')
      AND dependency.deptype = 'a'
      AND NOT (
        dependency.dbid = (
          SELECT database.oid FROM pg_catalog.pg_database AS database
          WHERE database.datname = pg_catalog.current_database()
        )
        AND (
          (dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
            AND dependency.objid IN (SELECT oid FROM application_namespace))
          OR (dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND dependency.objid IN (SELECT oid FROM application_tables))
          OR (dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND dependency.objid IN (SELECT oid FROM application_functions))
        )
      )) AS "hasUnexpectedAclDependency",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS privilege
    WHERE namespace.oid IN (SELECT oid FROM application_namespace)
      AND privilege.grantee = pg_catalog.to_regrole('${POSTGRES_RUNTIME_ROLE}')
      AND privilege.is_grantable
    UNION ALL
    SELECT 1 FROM application_tables AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS privilege
    WHERE privilege.grantee = pg_catalog.to_regrole('${POSTGRES_RUNTIME_ROLE}')
      AND privilege.is_grantable
    UNION ALL
    SELECT 1 FROM application_functions AS routine
    JOIN pg_catalog.pg_proc AS source ON source.oid = routine.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source.proacl, pg_catalog.acldefault('f', source.proowner))
    ) AS privilege
    WHERE privilege.grantee = pg_catalog.to_regrole('${POSTGRES_RUNTIME_ROLE}')
      AND privilege.is_grantable
  ) AS "hasGrantableAcl"`;

const OPERATIONS_ACCESS_QUERY = `/* pintpath:postgres-runtime:operations-access */
WITH operations_namespace AS (
  SELECT oid
  FROM pg_catalog.pg_namespace
  WHERE nspname = '${POSTGRES_OPERATIONS_SCHEMA}'
), operations_relations AS (
  SELECT relation.oid, relation.relkind
  FROM pg_catalog.pg_class AS relation
  JOIN operations_namespace AS namespace
    ON namespace.oid = relation.relnamespace
), operations_functions AS (
  SELECT routine.oid
  FROM pg_catalog.pg_proc AS routine
  JOIN operations_namespace AS namespace
    ON namespace.oid = routine.pronamespace
)
SELECT
  EXISTS (
    SELECT 1
    FROM operations_namespace
    WHERE has_schema_privilege(current_user, oid, 'USAGE')
       OR has_schema_privilege(current_user, oid, 'CREATE')
  ) OR EXISTS (
    SELECT 1
    FROM operations_relations
    WHERE relkind <> 'S'
      AND (
        has_table_privilege(current_user, oid, 'SELECT')
        OR has_table_privilege(current_user, oid, 'INSERT')
        OR has_table_privilege(current_user, oid, 'UPDATE')
        OR has_table_privilege(current_user, oid, 'DELETE')
        OR has_table_privilege(current_user, oid, 'TRUNCATE')
        OR has_table_privilege(current_user, oid, 'REFERENCES')
        OR has_table_privilege(current_user, oid, 'TRIGGER')
        OR has_any_column_privilege(current_user, oid, 'SELECT')
        OR has_any_column_privilege(current_user, oid, 'INSERT')
        OR has_any_column_privilege(current_user, oid, 'UPDATE')
        OR has_any_column_privilege(current_user, oid, 'REFERENCES')
      )
  ) OR EXISTS (
    SELECT 1
    FROM operations_relations
    WHERE relkind = 'S'
      AND (
        has_sequence_privilege(current_user, oid, 'USAGE')
        OR has_sequence_privilege(current_user, oid, 'SELECT')
        OR has_sequence_privilege(current_user, oid, 'UPDATE')
      )
  ) OR EXISTS (
    SELECT 1
    FROM operations_functions
    WHERE has_function_privilege(current_user, oid, 'EXECUTE')
  ) AS "hasAccess"`;

const APPLICATION_EXPOSURE_QUERY = `/* pintpath:postgres-runtime:application-exposure */
WITH forbidden_roles AS (
  SELECT oid
  FROM pg_catalog.pg_roles
  WHERE rolname = ANY (ARRAY['anon', 'authenticated', 'service_role'])
), application_namespace AS (
  SELECT oid, nspowner, nspacl
  FROM pg_catalog.pg_namespace
  WHERE nspname = '${POSTGRES_APPLICATION_SCHEMA}'
), application_relations AS (
  SELECT relation.oid, relation.relkind, relation.relowner, relation.relacl
  FROM pg_catalog.pg_class AS relation
  JOIN application_namespace AS namespace
    ON namespace.oid = relation.relnamespace
), application_functions AS (
  SELECT routine.oid, routine.proowner, routine.proacl
  FROM pg_catalog.pg_proc AS routine
  JOIN application_namespace AS namespace
    ON namespace.oid = routine.pronamespace
), application_columns AS (
  SELECT attribute.attrelid, attribute.attacl
  FROM pg_catalog.pg_attribute AS attribute
  JOIN application_relations AS relation
    ON relation.oid = attribute.attrelid
  WHERE attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND attribute.attacl IS NOT NULL
)
SELECT
  EXISTS (
    SELECT 1
    FROM forbidden_roles AS role
    CROSS JOIN application_namespace AS namespace
    WHERE has_schema_privilege(role.oid, namespace.oid, 'USAGE')
       OR has_schema_privilege(role.oid, namespace.oid, 'CREATE')
  ) OR EXISTS (
    SELECT 1
    FROM forbidden_roles AS role
    CROSS JOIN application_relations AS relation
    WHERE relation.relkind <> 'S'
      AND (
        has_table_privilege(role.oid, relation.oid, 'SELECT')
        OR has_table_privilege(role.oid, relation.oid, 'INSERT')
        OR has_table_privilege(role.oid, relation.oid, 'UPDATE')
        OR has_table_privilege(role.oid, relation.oid, 'DELETE')
        OR has_table_privilege(role.oid, relation.oid, 'TRUNCATE')
        OR has_table_privilege(role.oid, relation.oid, 'REFERENCES')
        OR has_table_privilege(role.oid, relation.oid, 'TRIGGER')
        OR has_any_column_privilege(role.oid, relation.oid, 'SELECT')
        OR has_any_column_privilege(role.oid, relation.oid, 'INSERT')
        OR has_any_column_privilege(role.oid, relation.oid, 'UPDATE')
        OR has_any_column_privilege(role.oid, relation.oid, 'REFERENCES')
      )
  ) OR EXISTS (
    SELECT 1
    FROM forbidden_roles AS role
    CROSS JOIN application_relations AS relation
    WHERE relation.relkind = 'S'
      AND (
        has_sequence_privilege(role.oid, relation.oid, 'USAGE')
        OR has_sequence_privilege(role.oid, relation.oid, 'SELECT')
        OR has_sequence_privilege(role.oid, relation.oid, 'UPDATE')
      )
  ) OR EXISTS (
    SELECT 1
    FROM forbidden_roles AS role
    CROSS JOIN application_functions AS routine
    WHERE has_function_privilege(role.oid, routine.oid, 'EXECUTE')
  ) OR EXISTS (
    SELECT 1
    FROM application_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) AS privilege
    WHERE privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM application_relations AS relation
    CROSS JOIN LATERAL aclexplode(
      COALESCE(
        relation.relacl,
        acldefault(
          (CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
          relation.relowner
        )
      )
    ) AS privilege
    WHERE privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM application_columns AS attribute
    CROSS JOIN LATERAL aclexplode(
      attribute.attacl
    ) AS privilege
    WHERE privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM application_functions AS routine
    CROSS JOIN LATERAL aclexplode(
      COALESCE(routine.proacl, acldefault('f', routine.proowner))
    ) AS privilege
    WHERE privilege.grantee = 0
  ) AS "hasAccess"`;

function safeCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function safeDuration(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function safePoolMetrics(database: SqlDatabase): SqlPoolMetrics {
  const metrics = database.metrics();
  return {
    dialect: metrics.dialect,
    totalConnections: safeCount(metrics.totalConnections),
    idleConnections: safeCount(metrics.idleConnections),
    waitingRequests: safeCount(metrics.waitingRequests),
    completedQueries: safeCount(metrics.completedQueries),
    failedQueries: safeCount(metrics.failedQueries),
    transactionFailures: safeCount(metrics.transactionFailures),
    lastQueryDurationMs: safeDuration(metrics.lastQueryDurationMs),
  };
}

function emptyChecks(dialect: boolean): PostgresRuntimeChecks {
  return {
    dialect,
    runtimeRole: false,
    searchPath: false,
    schemaVersion: false,
    importReady: false,
    authoritativeTables: false,
    operationsIsolation: false,
    applicationSchemaIsolation: false,
  };
}

function unavailableMetrics(database: SqlDatabase): SafePostgresRuntimeMetrics {
  return {
    schemaVersion: "unavailable",
    importState: "unavailable",
    authoritativeTableCount: null,
    expectedAuthoritativeTableCount: EXPECTED_POSTGRES_AUTHORITATIVE_TABLES,
    pool: safePoolMetrics(database),
  };
}

function canonicalRoleList(value: unknown): string[] | null {
  let candidate = value;
  if (typeof candidate === "string" && candidate.length <= 65_536) {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (
    !Array.isArray(candidate)
    || candidate.some((entry) => typeof entry !== "string")
  ) {
    return null;
  }
  const sorted = [...candidate].sort();
  return new Set(sorted).size === sorted.length ? sorted : null;
}

function rolesMatch(value: unknown, expected: readonly string[]): boolean {
  const actual = canonicalRoleList(value);
  return actual !== null && JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function failureCodes(checks: PostgresRuntimeChecks): PostgresRuntimeFailureCode[] {
  const failures: PostgresRuntimeFailureCode[] = [];
  if (!checks.dialect) failures.push("not_postgres");
  if (!checks.runtimeRole) failures.push("runtime_role_unsafe");
  if (!checks.searchPath) failures.push("search_path_unsafe");
  if (!checks.schemaVersion) failures.push("schema_version_unsupported");
  if (!checks.importReady) failures.push("import_not_ready");
  if (!checks.authoritativeTables) failures.push("authoritative_table_count_mismatch");
  if (!checks.operationsIsolation) failures.push("operations_schema_accessible");
  if (!checks.applicationSchemaIsolation) failures.push("application_schema_exposed");
  return failures;
}

export async function checkPostgresRuntimeReadiness(
  database: SqlDatabase,
  options: { readonly allowSafeRotationOverlap?: boolean } = {},
): Promise<PostgresRuntimeReadiness> {
  const poolMetrics = safePoolMetrics(database);
  const dialectReady = database.dialect === "postgres" && poolMetrics.dialect === "postgres";
  if (!dialectReady) {
    return {
      ready: false,
      checks: emptyChecks(false),
      failures: ["not_postgres"],
      metrics: unavailableMetrics(database),
    };
  }

  try {
    // Keep readiness introspection sequential so one probe cannot consume five
    // pool connections while the service is already under pressure.
    const session = await database.prepare(RUNTIME_SESSION_QUERY).get<RuntimeSessionRow>();
    const authority = await database
      .prepare(RUNTIME_AUTHORITY_QUERY)
      .get<RuntimeAuthorityRow>();
    const metadataRows = await database.prepare(SCHEMA_METADATA_QUERY).all<MetadataRow>();
    const tableCountRow = await database
      .prepare(AUTHORITATIVE_TABLE_COUNT_QUERY)
      .get<AuthoritativeTableCountRow>();
    const operationsAccess = await database
      .prepare(OPERATIONS_ACCESS_QUERY)
      .get<AccessCheckRow>();
    const applicationExposure = await database
      .prepare(APPLICATION_EXPOSURE_QUERY)
      .get<AccessCheckRow>();

    const metadata = new Map<string, string>();
    let metadataIsUnique = metadataRows.length === 2;
    for (const row of metadataRows) {
      if (metadata.has(row.key)) metadataIsUnique = false;
      metadata.set(row.key, row.value);
    }

    const schemaVersion = metadata.get("schema_version");
    const importState = metadata.get("import_state");
    const authoritativeTableCount = Number.isInteger(tableCountRow?.tableCount)
      && tableCountRow!.tableCount >= 0
      ? tableCountRow!.tableCount
      : null;
    const checks: PostgresRuntimeChecks = {
      dialect: true,
      runtimeRole: session?.isRuntimeMember === true
        && session.activeRoleExact === true
        && session.isSuperuser === false
        && session.canBypassRls === false
        && session.loginCanLogin === true
        && session.loginCanCreateDatabase === false
        && session.loginCanCreateRole === false
        && session.loginInheritsPrivileges === false
        && session.loginCanReplicate === false
        && session.loginConnectionLimit === 8
        && session.loginValidUntilNull === true
        && rolesMatch(session.loginMemberships, [POSTGRES_RUNTIME_ROLE])
        && session.loginMembershipOptionsExact === true
        && session.runtimeRoleSafe === true
        && rolesMatch(session.runtimeRoleParents, [])
        && (
          options.allowSafeRotationOverlap === true
            ? session.runtimeRoleChildrenSafeForRotation === true
            : session.runtimeRoleChildrenExact === true
        )
        && session.hasRoleSettings === false
        && session.canConnectDatabase === true
        && session.canCreateDatabaseObjects === false
        && session.canCreateTemporaryObjects === false
        && session.databaseAclExact === true
        && session.hasUnsafeDirectAclDependencies === false
        && session.ownsDatabaseObjects === false
        && session.hasUnsafeDefaultPrivileges === false
        && rolesMatch(authority?.selectTables, POSTGRES_RUNTIME_SELECT_TABLES)
        && rolesMatch(authority?.insertTables, POSTGRES_RUNTIME_INSERT_TABLES)
        && rolesMatch(authority?.updateTables, POSTGRES_RUNTIME_WRITE_TABLES)
        && rolesMatch(authority?.deleteTables, POSTGRES_RUNTIME_WRITE_TABLES)
        && rolesMatch(authority?.functions, POSTGRES_RUNTIME_FUNCTIONS)
        && authority?.canUseApplicationSchema === true
        && authority.canCreateApplicationObjects === false
        && authority.hasApplicationSequenceAccess === false
        && authority.hasUnexpectedTableAuthority === false
        && authority.hasColumnAclEntries === false
        && authority.hasUnexpectedAclDependency === false
        && authority.hasGrantableAcl === false,
      searchPath: session?.currentSchema === POSTGRES_APPLICATION_SCHEMA
        && Array.isArray(session.searchPathSchemas)
        && session.searchPathSchemas.length === 2
        && session.searchPathSchemas[0] === POSTGRES_APPLICATION_SCHEMA
        && session.searchPathSchemas[1] === "pg_catalog",
      schemaVersion: metadataIsUnique
        && schemaVersion === SUPPORTED_POSTGRES_SCHEMA_VERSION,
      importReady: metadataIsUnique && importState === "ready",
      authoritativeTables: authoritativeTableCount === EXPECTED_POSTGRES_AUTHORITATIVE_TABLES,
      operationsIsolation: operationsAccess?.hasAccess === false,
      applicationSchemaIsolation: applicationExposure?.hasAccess === false,
    };
    const failures = failureCodes(checks);

    return {
      ready: failures.length === 0,
      checks,
      failures,
      metrics: {
        schemaVersion: schemaVersion === undefined
          ? "unavailable"
          : checks.schemaVersion ? "supported" : "unsupported",
        importState: importState === undefined
          ? "unavailable"
          : checks.importReady ? "ready" : "not-ready",
        authoritativeTableCount,
        expectedAuthoritativeTableCount: EXPECTED_POSTGRES_AUTHORITATIVE_TABLES,
        pool: safePoolMetrics(database),
      },
    };
  } catch {
    return {
      ready: false,
      checks: emptyChecks(true),
      failures: ["catalog_check_failed"],
      metrics: unavailableMetrics(database),
    };
  }
}

export const postgresRuntimeQueries = {
  runtimeSession: RUNTIME_SESSION_QUERY,
  runtimeAuthority: RUNTIME_AUTHORITY_QUERY,
  schemaMetadata: SCHEMA_METADATA_QUERY,
  authoritativeTableCount: AUTHORITATIVE_TABLE_COUNT_QUERY,
  operationsAccess: OPERATIONS_ACCESS_QUERY,
  applicationExposure: APPLICATION_EXPOSURE_QUERY,
};
