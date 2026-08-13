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
  isSuperuser: boolean;
  canBypassRls: boolean;
  isRuntimeMember: boolean;
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

const RUNTIME_SESSION_QUERY = `/* pintpath:postgres-runtime:session */
SELECT
  (active_role.rolsuper OR login_role.rolsuper) AS "isSuperuser",
  (active_role.rolbypassrls OR login_role.rolbypassrls) AS "canBypassRls",
  COALESCE(
    pg_has_role(session_user, to_regrole('${POSTGRES_RUNTIME_ROLE}'), 'MEMBER')
      AND pg_has_role(current_user, to_regrole('${POSTGRES_RUNTIME_ROLE}'), 'USAGE'),
    false
  ) AS "isRuntimeMember",
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
        && session.isSuperuser === false
        && session.canBypassRls === false,
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
  schemaMetadata: SCHEMA_METADATA_QUERY,
  authoritativeTableCount: AUTHORITATIVE_TABLE_COUNT_QUERY,
  operationsAccess: OPERATIONS_ACCESS_QUERY,
  applicationExposure: APPLICATION_EXPOSURE_QUERY,
};
