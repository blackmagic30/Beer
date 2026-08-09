import crypto from "node:crypto";

import type { QueryResultRow } from "pg";

import { POSTGRES_MIGRATION_CONTRACT } from "../db/postgres-migration-contract.js";
import {
  sha256PostgresMigrationBytes,
  sha256PostgresMigrationContract,
  type PostgresMigrationColumnContract,
  type PostgresMigrationTableContract,
} from "../db/postgres-migration-schema.js";
import { postgresMigrationSourceInternals } from "../db/postgres-migration-source.js";

export const POSTGRES_LOGICAL_STATE_RECEIPT_FILE = "state-receipt.json" as const;
export const POSTGRES_LOGICAL_STATE_RECEIPT_KIND =
  "pintpath-postgres-logical-source-state" as const;
export const POSTGRES_LOGICAL_STATE_RECEIPT_VERSION = 1 as const;

const APPLICATION_SCHEMA = "pintpath_app";
const OPERATIONS_SCHEMA = "pintpath_ops";
const MAX_PAGE_ROWS = 10_000;
const DEFAULT_PAGE_ROWS = 500;
const MAX_STATE_TOTAL_BUCKETS = 100_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXPECTED_METADATA_KEYS = Object.freeze([
  "import_state",
  "migration_candidate_sha",
  "migration_contract_sha256",
  "migration_manifest_sha256",
  "migration_plan_sha256",
  "migration_run_sha256",
  "schema_version",
  "source_schema_fingerprint",
  "source_schema_sha256",
  "source_schema_version",
  "source_snapshot_sha256",
  "target_ddl_sha256",
] as const);

export class PostgresLogicalStateError extends Error {
  constructor(readonly code: "contract_invalid" | "state_invalid" | "receipt_invalid") {
    super(code);
    this.name = "PostgresLogicalStateError";
  }
}

export interface PostgresLogicalStateQueryResult<Row extends QueryResultRow = QueryResultRow> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface PostgresLogicalStateConnection {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresLogicalStateQueryResult<Row>>;
}

export interface PostgresLogicalStateTableReceipt {
  readonly tableName: string;
  readonly columnCount: number;
  readonly rowCount: string;
  readonly transformedSha256: string;
  readonly firstPrimaryKeySha256: string | null;
  readonly lastPrimaryKeySha256: string | null;
}

export interface PostgresLogicalStateInventory {
  readonly authoritativeTableCount: number;
  readonly authoritativeColumnCount: number;
  readonly authoritativeRowCount: string;
  readonly nonEmptyAuthoritativeTableCount: number;
  readonly zeroRowAuthoritativeTableCount: number;
  readonly migrationContractSha256: string;
  readonly sourceSchemaFingerprint: string;
  readonly sourceSchemaSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly targetDdlSha256: string;
  readonly schemaMetadataSha256: string;
  readonly tableSetSha256: string;
  readonly transformedDataSha256: string;
  readonly keyRangesSha256: string;
  readonly stateTotalsSha256: string;
  readonly archivedControlTableCount: number;
  readonly archivedControlRowCount: string;
  readonly archivedControlTableSetSha256: string;
  readonly archivedControlDataSha256: string;
  readonly archivedControlKeyRangesSha256: string;
  readonly overallStateSha256: string;
  readonly tables: readonly PostgresLogicalStateTableReceipt[];
  readonly archivedControlTables: readonly PostgresLogicalStateTableReceipt[];
}

export interface PostgresLogicalSourceStateReceipt {
  readonly kind: typeof POSTGRES_LOGICAL_STATE_RECEIPT_KIND;
  readonly version: typeof POSTGRES_LOGICAL_STATE_RECEIPT_VERSION;
  readonly capturedAt: string;
  readonly source: {
    readonly databaseIdentitySha256: string;
    readonly urlSha256: string;
    readonly snapshotBindingSha256: string;
  };
  readonly archive: {
    readonly file: "pintpath-postgres.dump";
    readonly bytes: number;
    readonly sha256: string;
    readonly listingSha256: string;
  };
  readonly manifestBindingSha256: string;
  readonly state: PostgresLogicalStateInventory;
}

interface MetadataRow extends QueryResultRow {
  readonly key: string;
  readonly value: string;
}

interface TableNameRow extends QueryResultRow {
  readonly schemaName: string;
  readonly tableName: string;
}

interface CatalogCountRow extends QueryResultRow {
  readonly columnCount: string;
  readonly foreignKeyCount: string;
  readonly rowSecurityTableCount: string;
}

interface PrimaryKeyRow extends QueryResultRow {
  readonly tableName: string;
  readonly columnName: string;
  readonly primaryKeyPosition: number;
}

interface AuthoritativeColumnRow extends QueryResultRow {
  readonly tableName: string;
  readonly columnName: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly ordinal: number;
}

interface UnsafeRow extends QueryResultRow {
  readonly unsafe: boolean;
}

interface ControlColumnRow extends QueryResultRow {
  readonly schemaName: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly ordinal: number;
}

interface ControlPrimaryKeyRow extends QueryResultRow {
  readonly schemaName: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly primaryKeyPosition: number;
}

interface ArchivedControlContract {
  readonly schemaName: typeof APPLICATION_SCHEMA | typeof OPERATIONS_SCHEMA;
  readonly table: PostgresMigrationTableContract;
  readonly postgresTypes: readonly string[];
}

const ARCHIVED_CONTROL_CONTRACT = Object.freeze<readonly ArchivedControlContract[]>([
  {
    schemaName: APPLICATION_SCHEMA,
    table: {
      name: "schema_metadata",
      dependencies: [],
      columns: [
        ["key", "TEXT", "text", false, 1],
        ["value", "TEXT", "text", false, 0],
        ["updated_at", "TEXT", "utc-instant", false, 0],
      ],
    },
    postgresTypes: ["text", "text", "timestamp with time zone"],
  },
  {
    schemaName: OPERATIONS_SCHEMA,
    table: {
      name: "migration_chunks",
      dependencies: ["migration_runs"],
      columns: [
        ["run_id", "TEXT", "text", false, 1],
        ["table_name", "TEXT", "text", false, 2],
        ["chunk_ordinal", "INTEGER", "integer", false, 3],
        ["row_count", "INTEGER", "integer", false, 0],
        ["source_transformed_sha256", "TEXT", "text", false, 0],
        ["target_sha256", "TEXT", "text", false, 0],
        ["completed_at", "TEXT", "utc-instant", false, 0],
      ],
    },
    postgresTypes: [
      "text", "text", "integer", "integer", "text", "text", "timestamp with time zone",
    ],
  },
  {
    schemaName: OPERATIONS_SCHEMA,
    table: {
      name: "migration_runs",
      dependencies: [],
      columns: [
        ["run_id", "TEXT", "text", false, 1],
        ["source_snapshot_sha256", "TEXT", "text", false, 0],
        ["source_schema_fingerprint", "TEXT", "text", false, 0],
        ["contract_sha256", "TEXT", "text", false, 0],
        ["manifest_sha256", "TEXT", "text", false, 0],
        ["target_ddl_sha256", "TEXT", "text", false, 0],
        ["source_schema_version", "INTEGER", "integer", false, 0],
        ["candidate_commit_sha", "TEXT", "text", false, 0],
        ["target_binding_sha256", "TEXT", "text", false, 0],
        ["expected_environment", "TEXT", "text", false, 0],
        ["approval_reference_sha256", "TEXT", "text", false, 0],
        ["operator_id_sha256", "TEXT", "text", false, 0],
        ["verifier_id_sha256", "TEXT", "text", true, 0],
        ["status", "TEXT", "text", false, 0],
        ["started_at", "TEXT", "utc-instant", false, 0],
        ["completed_at", "TEXT", "utc-instant", true, 0],
        ["receipt_sha256", "TEXT", "text", true, 0],
        ["failure_code", "TEXT", "text", true, 0],
      ],
    },
    postgresTypes: [
      "text", "text", "text", "text", "text", "text", "integer", "text", "text",
      "text", "text", "text", "text", "text", "timestamp with time zone",
      "timestamp with time zone", "text", "text",
    ],
  },
]);

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_json_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalizeJson(entry)}`
    )).join(",")}}`;
  }
  throw new Error("unsupported_json_value");
}

export function canonicalPostgresLogicalStateJson(value: unknown): string {
  return `${canonicalizeJson(value)}\n`;
}

export function sha256CanonicalPostgresLogicalState(value: unknown): string {
  return sha256PostgresMigrationBytes(canonicalPostgresLogicalStateJson(value));
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function updateLengthFramed(hash: crypto.Hash, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new PostgresLogicalStateError("contract_invalid");
  return `"${identifier}"`;
}

function stateColumn(column: PostgresMigrationColumnContract): boolean {
  return column[0] === "status"
    || column[0] === "state"
    || column[0].endsWith("_status")
    || column[0].endsWith("_state");
}

function canonicalNativeValue(value: unknown, column: PostgresMigrationColumnContract): string {
  if (value === null) return postgresMigrationSourceInternals.canonicalSourceValue(null, column);
  switch (column[2]) {
    case "boolean": {
      const boolean = typeof value === "boolean"
        ? value
        : value === "t" ? true : value === "f" ? false : null;
      if (boolean === null) throw new PostgresLogicalStateError("state_invalid");
      return postgresMigrationSourceInternals.canonicalSourceValue(boolean ? 1n : 0n, column);
    }
    case "integer": {
      if (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") {
        throw new PostgresLogicalStateError("state_invalid");
      }
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new PostgresLogicalStateError("state_invalid");
      }
      let integer: bigint;
      try {
        integer = BigInt(value);
      } catch {
        throw new PostgresLogicalStateError("state_invalid");
      }
      return postgresMigrationSourceInternals.canonicalSourceValue(integer, column);
    }
    case "decimal": {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new PostgresLogicalStateError("state_invalid");
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new PostgresLogicalStateError("state_invalid");
      }
      try {
        return `D${postgresMigrationSourceInternals.normalizeExactDecimalToken(String(value))}`;
      } catch {
        throw new PostgresLogicalStateError("state_invalid");
      }
    }
    case "float64": {
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(number)) throw new PostgresLogicalStateError("state_invalid");
      return postgresMigrationSourceInternals.canonicalSourceValue(number, column);
    }
    default:
      try {
        return postgresMigrationSourceInternals.canonicalSourceValue(value, column);
      } catch {
        throw new PostgresLogicalStateError("state_invalid");
      }
  }
}

function canonicalPrimaryKey(
  values: readonly string[],
  columns?: readonly PostgresMigrationColumnContract[],
): Buffer {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-source-primary-key-v1");
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const column = columns?.[index];
    if (!column || column[1] === "TEXT") updateLengthFramed(hash, `T${value}`);
    else if (column[1] === "INTEGER") updateLengthFramed(hash, `I${BigInt(value)}`);
    else throw new PostgresLogicalStateError("contract_invalid");
  }
  return hash.digest();
}

function canonicalRow(
  table: PostgresMigrationTableContract,
  row: Readonly<Record<string, unknown>>,
): Buffer {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-postgres-transformed-row-v1");
  updateLengthFramed(hash, table.name);
  for (const column of table.columns) {
    updateLengthFramed(hash, column[0]);
    updateLengthFramed(hash, canonicalNativeValue(row[column[0]], column));
  }
  return hash.digest();
}

function targetProjection(table: PostgresMigrationTableContract): string {
  return table.columns.map((column) => {
    const identifier = quoteIdentifier(column[0]);
    let expression = identifier;
    if (["json-array", "json-object", "decimal", "integer", "float64"].includes(column[2])) {
      expression = `${identifier}::text`;
    } else if (column[2] === "utc-instant") {
      expression = `to_char(${identifier} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    } else if (column[2] === "local-time") {
      expression = `to_char(${identifier}, 'HH24:MI:SS.US')`;
    }
    return `${expression} AS ${identifier}`;
  }).join(", ");
}

function primaryKeyColumns(table: PostgresMigrationTableContract): PostgresMigrationColumnContract[] {
  const columns = table.columns
    .filter((column) => column[4] > 0)
    .sort((left, right) => left[4] - right[4]);
  if (
    columns.length === 0
    || columns.some((column, index) => (
      column[4] !== index + 1 || !["TEXT", "INTEGER"].includes(column[1])
    ))
  ) throw new PostgresLogicalStateError("contract_invalid");
  return columns;
}

function pageSql(
  table: PostgresMigrationTableContract,
  hasCursor: boolean,
  schemaName = APPLICATION_SCHEMA,
): string {
  const keys = primaryKeyColumns(table);
  const tableIdentifier = quoteIdentifier(table.name);
  const keyExpressions = keys.map((column) => (
    column[1] === "TEXT"
      ? `${quoteIdentifier(column[0])} COLLATE "C"`
      : quoteIdentifier(column[0])
  ));
  const parameters = keys.map((column, index) => (
    column[1] === "TEXT"
      ? `$${index + 1}::text COLLATE "C"`
      : `$${index + 1}::bigint`
  ));
  const cursor = hasCursor
    ? `WHERE ROW(${keyExpressions.join(", ")}) > ROW(${parameters.join(", ")})`
    : "";
  return `/* pintpath:logical-state:page:${schemaName}:${table.name} */
    SELECT ${targetProjection(table)}
    FROM ${schemaName}.${tableIdentifier}
    ${cursor}
    ORDER BY ${keyExpressions.map((expression) => `${expression} ASC`).join(", ")}
    LIMIT $${hasCursor ? keys.length + 1 : 1}::integer`;
}

function parseExactCount(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new PostgresLogicalStateError("receipt_invalid");
  return BigInt(value);
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function normalizePageSize(value: number | undefined): number {
  const pageRows = value ?? DEFAULT_PAGE_ROWS;
  if (!Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > MAX_PAGE_ROWS) {
    throw new PostgresLogicalStateError("state_invalid");
  }
  return pageRows;
}

function metadataBindings(rows: readonly MetadataRow[]): Omit<PostgresLogicalStateInventory,
  "authoritativeTableCount" | "authoritativeColumnCount" | "authoritativeRowCount"
  | "nonEmptyAuthoritativeTableCount" | "zeroRowAuthoritativeTableCount"
  | "tableSetSha256" | "transformedDataSha256" | "keyRangesSha256"
  | "stateTotalsSha256" | "archivedControlTableCount" | "archivedControlRowCount"
  | "archivedControlTableSetSha256" | "archivedControlDataSha256"
  | "archivedControlKeyRangesSha256" | "overallStateSha256" | "tables"
  | "archivedControlTables"> {
  const sorted = [...rows].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  if (
    JSON.stringify(sorted.map((row) => row.key)) !== JSON.stringify(EXPECTED_METADATA_KEYS)
    || sorted.some((row) => typeof row.value !== "string" || /[\r\n\0]/.test(row.value))
  ) throw new PostgresLogicalStateError("contract_invalid");
  const metadata = new Map(sorted.map((row) => [row.key, row.value]));
  const migrationContractSha256 = sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT);
  const hashKeys = [
    "migration_contract_sha256", "migration_manifest_sha256", "migration_plan_sha256",
    "migration_run_sha256", "source_schema_fingerprint", "source_schema_sha256",
    "source_snapshot_sha256", "target_ddl_sha256",
  ];
  if (
    metadata.get("schema_version") !== "1"
    || metadata.get("import_state") !== "ready"
    || metadata.get("migration_contract_sha256") !== migrationContractSha256
    || metadata.get("source_schema_fingerprint") !== POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(metadata.get("migration_candidate_sha") ?? "")
    || metadata.get("source_schema_version") !== String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion)
    || hashKeys.some((key) => !SHA256_PATTERN.test(metadata.get(key) ?? ""))
  ) throw new PostgresLogicalStateError("contract_invalid");
  return {
    migrationContractSha256,
    sourceSchemaFingerprint: metadata.get("source_schema_fingerprint")!,
    sourceSchemaSha256: metadata.get("source_schema_sha256")!,
    sourceSnapshotSha256: metadata.get("source_snapshot_sha256")!,
    targetDdlSha256: metadata.get("target_ddl_sha256")!,
    schemaMetadataSha256: sha256CanonicalPostgresLogicalState(
      sorted.map((row) => [row.key, row.value]),
    ),
  };
}

export async function verifyPostgresLogicalStateContract(
  connection: PostgresLogicalStateConnection,
): Promise<ReturnType<typeof metadataBindings>> {
  let tables: PostgresLogicalStateQueryResult<TableNameRow>;
  let counts: PostgresLogicalStateQueryResult<CatalogCountRow>;
  let primaryKeys: PostgresLogicalStateQueryResult<PrimaryKeyRow>;
  let authoritativeColumns: PostgresLogicalStateQueryResult<AuthoritativeColumnRow>;
  let metadata: PostgresLogicalStateQueryResult<MetadataRow>;
  let apiExposure: PostgresLogicalStateQueryResult<UnsafeRow>;
  let controlColumns: PostgresLogicalStateQueryResult<ControlColumnRow>;
  let controlPrimaryKeys: PostgresLogicalStateQueryResult<ControlPrimaryKeyRow>;
  try {
    tables = await connection.query<TableNameRow>(`/* pintpath:logical-state:table-set */
      SELECT namespace.nspname AS "schemaName", relation.relname AS "tableName"
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[])
        AND relation.relkind IN ('r', 'p')
      ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C"`, [
      [APPLICATION_SCHEMA, OPERATIONS_SCHEMA],
    ]);
    counts = await connection.query<CatalogCountRow>(`/* pintpath:logical-state:catalog-counts */
      SELECT
        (SELECT count(*)::text
         FROM pg_catalog.pg_attribute AS attribute
         JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[])
           AND relation.relkind IN ('r', 'p') AND attribute.attnum > 0 AND NOT attribute.attisdropped
        ) AS "columnCount",
        (SELECT count(*)::text
         FROM pg_catalog.pg_constraint AS constraint_record
         JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[])
           AND constraint_record.contype = 'f'
        ) AS "foreignKeyCount",
        (SELECT count(*)::text
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY($3::text[]) AND relation.relkind IN ('r', 'p')
           AND relation.relrowsecurity AND relation.relforcerowsecurity
        ) AS "rowSecurityTableCount"`, [
      APPLICATION_SCHEMA,
      POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
      [APPLICATION_SCHEMA, OPERATIONS_SCHEMA],
    ]);
    primaryKeys = await connection.query<PrimaryKeyRow>(`/* pintpath:logical-state:primary-keys */
      SELECT relation.relname AS "tableName", attribute.attname AS "columnName",
             key_ordinal.ordinality::integer AS "primaryKeyPosition"
      FROM pg_catalog.pg_constraint AS constraint_record
      JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key_ordinal(attnum, ordinality)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid AND attribute.attnum = key_ordinal.attnum
      WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[])
        AND constraint_record.contype = 'p'
      ORDER BY relation.relname COLLATE "C", key_ordinal.ordinality`, [
      APPLICATION_SCHEMA,
      POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
    ]);
    authoritativeColumns = await connection.query<AuthoritativeColumnRow>(
      `/* pintpath:logical-state:authoritative-column-contract */
      SELECT relation.relname AS "tableName", attribute.attname AS "columnName",
             pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS "dataType",
             NOT attribute.attnotnull AS nullable,
             attribute.attnum::integer AS ordinal
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[])
        AND relation.relkind IN ('r', 'p')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY relation.relname COLLATE "C", attribute.attnum`, [
        APPLICATION_SCHEMA,
        POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
      ],
    );
    controlColumns = await connection.query<ControlColumnRow>(`/* pintpath:logical-state:control-columns */
      SELECT namespace.nspname AS "schemaName", relation.relname AS "tableName",
             attribute.attname AS "columnName",
             pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS "dataType",
             NOT attribute.attnotnull AS nullable,
             attribute.attnum::integer AS ordinal
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE (namespace.nspname, relation.relname) IN (
        ('pintpath_app', 'schema_metadata'),
        ('pintpath_ops', 'migration_chunks'),
        ('pintpath_ops', 'migration_runs')
      ) AND relation.relkind IN ('r', 'p')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", attribute.attnum`);
    controlPrimaryKeys = await connection.query<ControlPrimaryKeyRow>(`/* pintpath:logical-state:control-primary-keys */
      SELECT namespace.nspname AS "schemaName", relation.relname AS "tableName",
             attribute.attname AS "columnName",
             key_ordinal.ordinality::integer AS "primaryKeyPosition"
      FROM pg_catalog.pg_constraint AS constraint_record
      JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key_ordinal(attnum, ordinality)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid AND attribute.attnum = key_ordinal.attnum
      WHERE (namespace.nspname, relation.relname) IN (
        ('pintpath_app', 'schema_metadata'),
        ('pintpath_ops', 'migration_chunks'),
        ('pintpath_ops', 'migration_runs')
      ) AND constraint_record.contype = 'p'
      ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", key_ordinal.ordinality`);
    metadata = await connection.query<MetadataRow>(`/* pintpath:logical-state:schema-metadata */
      SELECT key, value FROM ${APPLICATION_SCHEMA}.schema_metadata ORDER BY key COLLATE "C"`);
    apiExposure = await connection.query<UnsafeRow>(`/* pintpath:logical-state:api-isolation */
      WITH forbidden_roles AS (
        SELECT oid FROM pg_catalog.pg_roles
        WHERE rolname = ANY(ARRAY['anon', 'authenticated', 'service_role'])
      ), private_namespaces AS (
        SELECT oid, nspowner, nspacl FROM pg_catalog.pg_namespace
        WHERE nspname = ANY($1::text[])
      ), private_relations AS (
        SELECT relation.oid, relation.relkind, relation.relowner, relation.relacl
        FROM pg_catalog.pg_class AS relation
        JOIN private_namespaces AS namespace ON namespace.oid = relation.relnamespace
      ), private_functions AS (
        SELECT routine.oid, routine.proowner, routine.proacl
        FROM pg_catalog.pg_proc AS routine
        JOIN private_namespaces AS namespace ON namespace.oid = routine.pronamespace
      )
      SELECT (
        EXISTS (
          SELECT 1 FROM forbidden_roles AS role CROSS JOIN private_namespaces AS namespace
          WHERE has_schema_privilege(role.oid, namespace.oid, 'USAGE')
             OR has_schema_privilege(role.oid, namespace.oid, 'CREATE')
        ) OR EXISTS (
          SELECT 1 FROM forbidden_roles AS role CROSS JOIN private_relations AS relation
          WHERE (relation.relkind = 'S' AND (
            has_sequence_privilege(role.oid, relation.oid, 'USAGE')
            OR has_sequence_privilege(role.oid, relation.oid, 'SELECT')
            OR has_sequence_privilege(role.oid, relation.oid, 'UPDATE')
          )) OR (relation.relkind <> 'S' AND (
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
          ))
        ) OR EXISTS (
          SELECT 1 FROM forbidden_roles AS role CROSS JOIN private_functions AS routine
          WHERE has_function_privilege(role.oid, routine.oid, 'EXECUTE')
        ) OR EXISTS (
          SELECT 1 FROM private_namespaces AS namespace
          CROSS JOIN LATERAL aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) AS privilege
          WHERE privilege.grantee = 0
        ) OR EXISTS (
          SELECT 1 FROM private_relations AS relation
          CROSS JOIN LATERAL aclexplode(COALESCE(
            relation.relacl,
            acldefault((CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char", relation.relowner)
          )) AS privilege
          WHERE privilege.grantee = 0
        ) OR EXISTS (
          SELECT 1 FROM private_functions AS routine
          CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner))) AS privilege
          WHERE privilege.grantee = 0
        )
      ) AS unsafe`, [[APPLICATION_SCHEMA, OPERATIONS_SCHEMA]]);
  } catch {
    throw new PostgresLogicalStateError("contract_invalid");
  }

  const expectedApplicationTables = [
    ...POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
    "schema_metadata",
  ].sort();
  const applicationTables = tables.rows
    .filter((row) => row.schemaName === APPLICATION_SCHEMA)
    .map((row) => row.tableName)
    .sort();
  const operationsTables = tables.rows
    .filter((row) => row.schemaName === OPERATIONS_SCHEMA)
    .map((row) => row.tableName)
    .sort();
  const count = counts.rows[0];
  const expectedPrimaryKeys = POSTGRES_MIGRATION_CONTRACT.tables.flatMap((table) => (
    table.columns.filter((column) => column[4] > 0).map((column) => ({
      tableName: table.name,
      columnName: column[0],
      primaryKeyPosition: column[4],
    }))
  )).sort((left, right) => (
    left.tableName < right.tableName ? -1 : left.tableName > right.tableName ? 1
      : left.primaryKeyPosition - right.primaryKeyPosition
  ));
  const actualPrimaryKeys = [...primaryKeys.rows].sort((left, right) => (
    left.tableName < right.tableName ? -1 : left.tableName > right.tableName ? 1
      : left.primaryKeyPosition - right.primaryKeyPosition
  ));
  const postgresType = (column: PostgresMigrationColumnContract): string => {
    switch (column[2]) {
      case "binary": return "bytea";
      case "boolean": return "boolean";
      case "calendar-month":
      case "text": return "text";
      case "decimal": return "numeric";
      case "float64": return "double precision";
      case "integer": return "bigint";
      case "json-array":
      case "json-object": return "jsonb";
      case "local-time": return "time without time zone";
      case "utc-instant": return "timestamp with time zone";
    }
  };
  const expectedAuthoritativeColumns = [...POSTGRES_MIGRATION_CONTRACT.tables]
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .flatMap((table) => table.columns.map((column, index) => ({
      tableName: table.name,
      columnName: column[0],
      dataType: postgresType(column),
      nullable: column[3],
      ordinal: index + 1,
    })));
  const expectedControlColumns = ARCHIVED_CONTROL_CONTRACT.flatMap((control) => (
    control.table.columns.map((column, index) => ({
      schemaName: control.schemaName,
      tableName: control.table.name,
      columnName: column[0],
      dataType: control.postgresTypes[index],
      nullable: column[3],
      ordinal: index + 1,
    }))
  ));
  const expectedControlPrimaryKeys = ARCHIVED_CONTROL_CONTRACT.flatMap((control) => (
    control.table.columns.filter((column) => column[4] > 0).map((column) => ({
      schemaName: control.schemaName,
      tableName: control.table.name,
      columnName: column[0],
      primaryKeyPosition: column[4],
    }))
  ));
  if (
    JSON.stringify(applicationTables) !== JSON.stringify(expectedApplicationTables)
    || JSON.stringify(operationsTables) !== JSON.stringify(["migration_chunks", "migration_runs"])
    || !count
    || count.columnCount !== String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns)
    || count.foreignKeyCount !== String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys)
    || count.rowSecurityTableCount !== String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + 3)
    || JSON.stringify(actualPrimaryKeys) !== JSON.stringify(expectedPrimaryKeys)
    || JSON.stringify(authoritativeColumns.rows) !== JSON.stringify(expectedAuthoritativeColumns)
    || JSON.stringify(controlColumns.rows) !== JSON.stringify(expectedControlColumns)
    || JSON.stringify(controlPrimaryKeys.rows) !== JSON.stringify(expectedControlPrimaryKeys)
    || apiExposure.rows.length !== 1
    || apiExposure.rows[0]?.unsafe !== false
  ) throw new PostgresLogicalStateError("contract_invalid");
  return metadataBindings(metadata.rows);
}

export async function computePostgresLogicalStateInventory(
  connection: PostgresLogicalStateConnection,
  options: { readonly pageRows?: number } = {},
): Promise<PostgresLogicalStateInventory> {
  const pageRows = normalizePageSize(options.pageRows);
  const bindings = await verifyPostgresLogicalStateContract(connection);
  const contractSha256 = bindings.migrationContractSha256;
  const tableSetHash = crypto.createHash("sha256");
  const transformedDataHash = crypto.createHash("sha256");
  const keyRangesHash = crypto.createHash("sha256");
  const totals = new Map<string, bigint>();
  updateLengthFramed(tableSetHash, "pint-path-postgres-table-set-v1");
  updateLengthFramed(transformedDataHash, "pint-path-postgres-transformed-data-v1");
  updateLengthFramed(keyRangesHash, "pint-path-postgres-logical-key-ranges-v1");
  const tableReceipts: PostgresLogicalStateTableReceipt[] = [];
  let authoritativeRowCount = 0n;
  let nonEmptyAuthoritativeTableCount = 0;

  for (const table of POSTGRES_MIGRATION_CONTRACT.tables) {
    const keys = primaryKeyColumns(table);
    const tableHash = crypto.createHash("sha256");
    updateLengthFramed(tableHash, "pint-path-postgres-transformed-table-v1");
    updateLengthFramed(tableHash, contractSha256);
    updateLengthFramed(tableHash, table.name);
    for (const column of table.columns) updateLengthFramed(tableHash, column[0]);
    let cursor: string[] | null = null;
    let rowCount = 0n;
    let firstPrimaryKeySha256: string | null = null;
    let lastPrimaryKeySha256: string | null = null;
    while (true) {
      let result: PostgresLogicalStateQueryResult;
      try {
        result = await connection.query(
          pageSql(table, cursor !== null, APPLICATION_SCHEMA),
          cursor === null ? [pageRows] : [...cursor, pageRows],
        );
      } catch {
        throw new PostgresLogicalStateError("state_invalid");
      }
      if (result.rows.length > pageRows) throw new PostgresLogicalStateError("state_invalid");
      for (const row of result.rows) {
        const primaryKeyValues = keys.map((column) => row[column[0]]);
        if (primaryKeyValues.some((value) => typeof value !== "string")) {
          throw new PostgresLogicalStateError("state_invalid");
        }
        const keyValues = primaryKeyValues as string[];
        const primaryKeySha256 = canonicalPrimaryKey(keyValues, keys).toString("hex");
        if (cursor && compareKey(keyValues, cursor, keys) <= 0) {
          throw new PostgresLogicalStateError("state_invalid");
        }
        if (firstPrimaryKeySha256 === null) firstPrimaryKeySha256 = primaryKeySha256;
        lastPrimaryKeySha256 = primaryKeySha256;
        const encodedRow = canonicalRow(table, row);
        updateLengthFramed(tableHash, encodedRow);
        for (const column of table.columns.filter(stateColumn)) {
          const valueDigest = sha256PostgresMigrationBytes(canonicalNativeValue(row[column[0]], column));
          const key = `${table.name}\0${column[0]}\0${valueDigest}`;
          if (!totals.has(key) && totals.size >= MAX_STATE_TOTAL_BUCKETS) {
            throw new PostgresLogicalStateError("state_invalid");
          }
          totals.set(key, (totals.get(key) ?? 0n) + 1n);
        }
        cursor = keyValues;
        rowCount += 1n;
      }
      if (result.rows.length < pageRows) break;
      if (result.rows.length === 0 || cursor === null) throw new PostgresLogicalStateError("state_invalid");
    }
    const transformedSha256 = tableHash.digest("hex");
    const receipt: PostgresLogicalStateTableReceipt = {
      tableName: table.name,
      columnCount: table.columns.length,
      rowCount: rowCount.toString(),
      transformedSha256,
      firstPrimaryKeySha256,
      lastPrimaryKeySha256,
    };
    tableReceipts.push(receipt);
    authoritativeRowCount += rowCount;
    if (rowCount > 0n) nonEmptyAuthoritativeTableCount += 1;
    updateLengthFramed(tableSetHash, table.name);
    updateLengthFramed(tableSetHash, rowCount.toString());
    updateLengthFramed(transformedDataHash, table.name);
    updateLengthFramed(transformedDataHash, transformedSha256);
    updateLengthFramed(keyRangesHash, table.name);
    updateLengthFramed(keyRangesHash, rowCount.toString());
    updateLengthFramed(keyRangesHash, firstPrimaryKeySha256 ?? "");
    updateLengthFramed(keyRangesHash, lastPrimaryKeySha256 ?? "");
  }

  const controlTableSetHash = crypto.createHash("sha256");
  const controlDataHash = crypto.createHash("sha256");
  const controlKeyRangesHash = crypto.createHash("sha256");
  updateLengthFramed(controlTableSetHash, "pintpath-postgres-logical-control-table-set-v1");
  updateLengthFramed(controlDataHash, "pintpath-postgres-logical-control-data-v1");
  updateLengthFramed(controlKeyRangesHash, "pintpath-postgres-logical-control-key-ranges-v1");
  const archivedControlTables: PostgresLogicalStateTableReceipt[] = [];
  let archivedControlRowCount = 0n;
  for (const control of ARCHIVED_CONTROL_CONTRACT) {
    const { schemaName, table } = control;
    const qualifiedName = `${schemaName}.${table.name}`;
    const keys = primaryKeyColumns(table);
    const tableHash = crypto.createHash("sha256");
    updateLengthFramed(tableHash, "pintpath-postgres-logical-control-table-v1");
    updateLengthFramed(tableHash, contractSha256);
    updateLengthFramed(tableHash, qualifiedName);
    for (const column of table.columns) updateLengthFramed(tableHash, column[0]);
    let cursor: string[] | null = null;
    let rowCount = 0n;
    let firstPrimaryKeySha256: string | null = null;
    let lastPrimaryKeySha256: string | null = null;
    while (true) {
      let result: PostgresLogicalStateQueryResult;
      try {
        result = await connection.query(
          pageSql(table, cursor !== null, schemaName),
          cursor === null ? [pageRows] : [...cursor, pageRows],
        );
      } catch {
        throw new PostgresLogicalStateError("state_invalid");
      }
      if (result.rows.length > pageRows) throw new PostgresLogicalStateError("state_invalid");
      for (const row of result.rows) {
        const primaryKeyValues = keys.map((column) => row[column[0]]);
        if (primaryKeyValues.some((value) => typeof value !== "string")) {
          throw new PostgresLogicalStateError("state_invalid");
        }
        const keyValues = primaryKeyValues as string[];
        const primaryKeySha256 = canonicalPrimaryKey(keyValues, keys).toString("hex");
        if (cursor && compareKey(keyValues, cursor, keys) <= 0) {
          throw new PostgresLogicalStateError("state_invalid");
        }
        if (firstPrimaryKeySha256 === null) firstPrimaryKeySha256 = primaryKeySha256;
        lastPrimaryKeySha256 = primaryKeySha256;
        const rowHash = crypto.createHash("sha256");
        updateLengthFramed(rowHash, "pintpath-postgres-logical-control-row-v1");
        updateLengthFramed(rowHash, qualifiedName);
        for (const column of table.columns) {
          updateLengthFramed(rowHash, column[0]);
          updateLengthFramed(rowHash, canonicalNativeValue(row[column[0]], column));
        }
        updateLengthFramed(tableHash, rowHash.digest());
        cursor = keyValues;
        rowCount += 1n;
      }
      if (result.rows.length < pageRows) break;
      if (result.rows.length === 0 || cursor === null) {
        throw new PostgresLogicalStateError("state_invalid");
      }
    }
    const transformedSha256 = tableHash.digest("hex");
    archivedControlTables.push({
      tableName: qualifiedName,
      columnCount: table.columns.length,
      rowCount: rowCount.toString(),
      transformedSha256,
      firstPrimaryKeySha256,
      lastPrimaryKeySha256,
    });
    archivedControlRowCount += rowCount;
    updateLengthFramed(controlTableSetHash, qualifiedName);
    updateLengthFramed(controlTableSetHash, rowCount.toString());
    updateLengthFramed(controlDataHash, qualifiedName);
    updateLengthFramed(controlDataHash, transformedSha256);
    updateLengthFramed(controlKeyRangesHash, qualifiedName);
    updateLengthFramed(controlKeyRangesHash, rowCount.toString());
    updateLengthFramed(controlKeyRangesHash, firstPrimaryKeySha256 ?? "");
    updateLengthFramed(controlKeyRangesHash, lastPrimaryKeySha256 ?? "");
  }

  const stateTotalsHash = crypto.createHash("sha256");
  updateLengthFramed(stateTotalsHash, "pint-path-postgres-state-totals-v1");
  for (const [key, count] of [...totals].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    updateLengthFramed(stateTotalsHash, key);
    updateLengthFramed(stateTotalsHash, count.toString());
  }
  const withoutOverall = {
    authoritativeTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
    authoritativeColumnCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns,
    authoritativeRowCount: authoritativeRowCount.toString(),
    nonEmptyAuthoritativeTableCount,
    zeroRowAuthoritativeTableCount:
      POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables - nonEmptyAuthoritativeTableCount,
    ...bindings,
    tableSetSha256: tableSetHash.digest("hex"),
    transformedDataSha256: transformedDataHash.digest("hex"),
    keyRangesSha256: keyRangesHash.digest("hex"),
    stateTotalsSha256: stateTotalsHash.digest("hex"),
    archivedControlTableCount: ARCHIVED_CONTROL_CONTRACT.length,
    archivedControlRowCount: archivedControlRowCount.toString(),
    archivedControlTableSetSha256: controlTableSetHash.digest("hex"),
    archivedControlDataSha256: controlDataHash.digest("hex"),
    archivedControlKeyRangesSha256: controlKeyRangesHash.digest("hex"),
    tables: tableReceipts,
    archivedControlTables,
  };
  return {
    ...withoutOverall,
    overallStateSha256: sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-state-inventory",
      version: 1,
      ...withoutOverall,
    }),
  };
}

function compareKey(
  left: readonly string[],
  right: readonly string[],
  columns: readonly PostgresMigrationColumnContract[],
): number {
  if (left.length !== right.length || left.length !== columns.length) {
    throw new PostgresLogicalStateError("state_invalid");
  }
  for (let index = 0; index < left.length; index += 1) {
    const column = columns[index]!;
    const comparison = column[1] === "TEXT"
      ? Buffer.compare(Buffer.from(left[index]!, "utf8"), Buffer.from(right[index]!, "utf8"))
      : BigInt(left[index]!) < BigInt(right[index]!) ? -1
        : BigInt(left[index]!) > BigInt(right[index]!) ? 1 : 0;
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function buildPostgresLogicalSourceStateReceipt(input: {
  readonly capturedAt: string;
  readonly databaseIdentitySha256: string;
  readonly sourceUrlSha256: string;
  readonly snapshotBindingSha256: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly archiveListingSha256: string;
  readonly manifestBindingSha256: string;
  readonly state: PostgresLogicalStateInventory;
}): PostgresLogicalSourceStateReceipt {
  return {
    kind: POSTGRES_LOGICAL_STATE_RECEIPT_KIND,
    version: POSTGRES_LOGICAL_STATE_RECEIPT_VERSION,
    capturedAt: input.capturedAt,
    source: {
      databaseIdentitySha256: input.databaseIdentitySha256,
      urlSha256: input.sourceUrlSha256,
      snapshotBindingSha256: input.snapshotBindingSha256,
    },
    archive: {
      file: "pintpath-postgres.dump",
      bytes: input.archiveBytes,
      sha256: input.archiveSha256,
      listingSha256: input.archiveListingSha256,
    },
    manifestBindingSha256: input.manifestBindingSha256,
    state: input.state,
  };
}

function validIsoInstant(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function validateStateInventory(value: unknown): value is PostgresLogicalStateInventory {
  if (!isPlainObject(value) || !exactKeys(value, [
    "authoritativeTableCount", "authoritativeColumnCount", "authoritativeRowCount",
    "nonEmptyAuthoritativeTableCount", "zeroRowAuthoritativeTableCount",
    "migrationContractSha256", "sourceSchemaFingerprint", "sourceSchemaSha256",
    "sourceSnapshotSha256", "targetDdlSha256", "schemaMetadataSha256",
    "tableSetSha256", "transformedDataSha256", "keyRangesSha256",
    "stateTotalsSha256", "archivedControlTableCount", "archivedControlRowCount",
    "archivedControlTableSetSha256", "archivedControlDataSha256",
    "archivedControlKeyRangesSha256", "overallStateSha256", "tables",
    "archivedControlTables",
  ])) return false;
  if (
    value.authoritativeTableCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
    || value.authoritativeColumnCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns
    || typeof value.authoritativeRowCount !== "string"
    || !/^\d+$/.test(value.authoritativeRowCount)
    || !Number.isSafeInteger(value.nonEmptyAuthoritativeTableCount)
    || !Number.isSafeInteger(value.zeroRowAuthoritativeTableCount)
    || Number(value.nonEmptyAuthoritativeTableCount) < 0
    || Number(value.zeroRowAuthoritativeTableCount) < 0
    || Number(value.nonEmptyAuthoritativeTableCount) + Number(value.zeroRowAuthoritativeTableCount)
      !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
    || value.migrationContractSha256 !== sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT)
    || value.sourceSchemaFingerprint !== POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint
    || ![
      value.sourceSchemaSha256, value.sourceSnapshotSha256, value.targetDdlSha256,
      value.schemaMetadataSha256, value.tableSetSha256, value.transformedDataSha256,
      value.keyRangesSha256, value.stateTotalsSha256, value.overallStateSha256,
      value.archivedControlTableSetSha256, value.archivedControlDataSha256,
      value.archivedControlKeyRangesSha256,
    ].every(safeHash)
    || !Array.isArray(value.tables)
    || value.tables.length !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
    || value.archivedControlTableCount !== ARCHIVED_CONTROL_CONTRACT.length
    || typeof value.archivedControlRowCount !== "string"
    || !/^\d+$/.test(value.archivedControlRowCount)
    || !Array.isArray(value.archivedControlTables)
    || value.archivedControlTables.length !== ARCHIVED_CONTROL_CONTRACT.length
  ) return false;
  let total = 0n;
  for (let index = 0; index < value.tables.length; index += 1) {
    const table = value.tables[index];
    const contractTable = POSTGRES_MIGRATION_CONTRACT.tables[index];
    if (
      !isPlainObject(table)
      || !contractTable
      || !exactKeys(table, [
        "tableName", "columnCount", "rowCount", "transformedSha256",
        "firstPrimaryKeySha256", "lastPrimaryKeySha256",
      ])
      || table.tableName !== contractTable.name
      || table.columnCount !== contractTable.columns.length
      || typeof table.rowCount !== "string"
      || !/^\d+$/.test(table.rowCount)
      || !safeHash(table.transformedSha256)
      || !(table.firstPrimaryKeySha256 === null || safeHash(table.firstPrimaryKeySha256))
      || !(table.lastPrimaryKeySha256 === null || safeHash(table.lastPrimaryKeySha256))
      || ((table.rowCount === "0") !== (table.firstPrimaryKeySha256 === null))
      || ((table.rowCount === "0") !== (table.lastPrimaryKeySha256 === null))
    ) return false;
    total += parseExactCount(table.rowCount);
  }
  if (total.toString() !== value.authoritativeRowCount) return false;
  let controlTotal = 0n;
  for (let index = 0; index < value.archivedControlTables.length; index += 1) {
    const table = value.archivedControlTables[index];
    const contract = ARCHIVED_CONTROL_CONTRACT[index];
    if (
      !isPlainObject(table)
      || !contract
      || !exactKeys(table, [
        "tableName", "columnCount", "rowCount", "transformedSha256",
        "firstPrimaryKeySha256", "lastPrimaryKeySha256",
      ])
      || table.tableName !== `${contract.schemaName}.${contract.table.name}`
      || table.columnCount !== contract.table.columns.length
      || typeof table.rowCount !== "string"
      || !/^\d+$/.test(table.rowCount)
      || !safeHash(table.transformedSha256)
      || !(table.firstPrimaryKeySha256 === null || safeHash(table.firstPrimaryKeySha256))
      || !(table.lastPrimaryKeySha256 === null || safeHash(table.lastPrimaryKeySha256))
      || ((table.rowCount === "0") !== (table.firstPrimaryKeySha256 === null))
      || ((table.rowCount === "0") !== (table.lastPrimaryKeySha256 === null))
    ) return false;
    controlTotal += parseExactCount(table.rowCount);
  }
  if (controlTotal.toString() !== value.archivedControlRowCount) return false;
  const { overallStateSha256: _ignored, ...withoutOverall } = value;
  return value.overallStateSha256 === sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-state-inventory",
    version: 1,
    ...withoutOverall,
  });
}

export function parsePostgresLogicalSourceStateReceipt(
  bytes: Buffer,
): PostgresLogicalSourceStateReceipt {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new PostgresLogicalStateError("receipt_invalid");
  }
  if (
    !isPlainObject(value)
    || canonicalPostgresLogicalStateJson(value) !== text
    || !exactKeys(value, [
      "kind", "version", "capturedAt", "source", "archive", "manifestBindingSha256", "state",
    ])
    || value.kind !== POSTGRES_LOGICAL_STATE_RECEIPT_KIND
    || value.version !== POSTGRES_LOGICAL_STATE_RECEIPT_VERSION
    || !validIsoInstant(value.capturedAt)
    || !isPlainObject(value.source)
    || !exactKeys(value.source, ["databaseIdentitySha256", "urlSha256", "snapshotBindingSha256"])
    || ![value.source.databaseIdentitySha256, value.source.urlSha256, value.source.snapshotBindingSha256].every(safeHash)
    || !isPlainObject(value.archive)
    || !exactKeys(value.archive, ["file", "bytes", "sha256", "listingSha256"])
    || value.archive.file !== "pintpath-postgres.dump"
    || !Number.isSafeInteger(value.archive.bytes)
    || Number(value.archive.bytes) < 1
    || !safeHash(value.archive.sha256)
    || !safeHash(value.archive.listingSha256)
    || !safeHash(value.manifestBindingSha256)
    || !validateStateInventory(value.state)
  ) throw new PostgresLogicalStateError("receipt_invalid");
  return value as unknown as PostgresLogicalSourceStateReceipt;
}

export function exactPostgresLogicalStateMatch(
  expected: PostgresLogicalStateInventory,
  actual: PostgresLogicalStateInventory,
): boolean {
  return canonicalPostgresLogicalStateJson(expected) === canonicalPostgresLogicalStateJson(actual);
}

export const postgresLogicalStateInternals = {
  canonicalNativeValue,
  canonicalPrimaryKey,
  canonicalRow,
  compareKey,
  pageSql,
  validateStateInventory,
};
