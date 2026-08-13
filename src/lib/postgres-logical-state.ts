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
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT,
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256,
} from "./postgres-reviewed-price-promotion-kernel.js";

export const POSTGRES_LOGICAL_STATE_RECEIPT_FILE = "state-receipt.json" as const;
export const POSTGRES_LOGICAL_STATE_RECEIPT_KIND =
  "pintpath-postgres-logical-source-state" as const;
export const POSTGRES_LOGICAL_STATE_RECEIPT_VERSION = 1 as const;

const APPLICATION_SCHEMA = "pintpath_app";
const OPERATIONS_SCHEMA = "pintpath_ops";
const MAX_PAGE_ROWS = 10_000;
const DEFAULT_PAGE_ROWS = 500;
const MAX_STATE_TOTAL_BUCKETS = 100_000;
const MAX_V2_BOUNDARY_BYTES = 4 * 1024 * 1024;
const MAX_V2_BOUNDARY_DEPTH = 32;
const MAX_V2_BOUNDARY_NODES = 20_000;
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

/** A dedicated, non-concurrently-used PostgreSQL session for the complete V2 capture. */
export interface PostgresLogicalStateV2Connection extends PostgresLogicalStateConnection {
  readonly processID: number;
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

export interface PostgresLogicalStateInventoryV2 extends Omit<
  PostgresLogicalStateInventory,
  | "archivedControlTableCount"
  | "archivedControlRowCount"
  | "archivedControlTableSetSha256"
  | "archivedControlDataSha256"
  | "archivedControlKeyRangesSha256"
  | "overallStateSha256"
  | "archivedControlTables"
> {
  readonly kernelContractSha256: string;
  readonly kernelMigrationSha256: string;
  /**
   * Hash of the exact, owner-normalized data-only source read boundary. This is
   * deliberately not a complete schema-definition or pg_dump catalog hash.
   */
  readonly sourceReadBoundarySha256: string;
  readonly controlTableCount: 5;
  readonly controlRowCount: string;
  readonly controlTableSetSha256: string;
  readonly controlDataSha256: string;
  readonly controlKeyRangesSha256: string;
  readonly overallStateSha256: string;
  readonly controlTables: readonly PostgresLogicalStateTableReceipt[];
}

export interface PostgresLogicalStateCaptureV2 {
  readonly inventory: PostgresLogicalStateInventoryV2;
  readonly sourceDatabaseOid: string;
  readonly sourcePhysicalReadBoundarySha256: string;
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

interface SourceReadBoundaryRow extends QueryResultRow {
  readonly databaseOid: string;
  readonly descriptorJson: string;
}

interface SearchPathRow extends QueryResultRow {
  readonly firstSchema: string;
  readonly backendPid: number;
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly transactionIsolation: string;
  readonly transactionReadOnly: string;
  readonly serverVersionNum: string;
  readonly transactionId: string;
}

interface V2SessionBinding {
  readonly transactionId: string;
  readonly currentUser: string;
  readonly sessionUser: string;
}

interface OwnRowCountRow extends QueryResultRow {
  readonly rowCount: string;
  readonly currentUser: string;
  readonly sessionUser: string;
}

interface ArchivedControlContract {
  readonly schemaName: typeof APPLICATION_SCHEMA | typeof OPERATIONS_SCHEMA;
  readonly table: LogicalStateTableContract;
  readonly postgresTypes: readonly string[];
}

type LogicalStateKeyKind = "integer" | "text" | "uuid";

type LogicalStateColumnContract = PostgresMigrationColumnContract;

interface LogicalStateTableContract extends Omit<PostgresMigrationTableContract, "columns"> {
  readonly columns: readonly LogicalStateColumnContract[];
}

function keyKindForColumn(
  table: LogicalStateTableContract,
  column: LogicalStateColumnContract,
): LogicalStateKeyKind {
  if (
    ["reviewed_price_promotion_operations", "reviewed_price_promotion_rows"].includes(table.name)
    && column[0] === "operation_id"
  ) return "uuid";
  return column[1] === "INTEGER" ? "integer" : "text";
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

const REVIEWED_PRICE_OPERATIONS_TABLE: LogicalStateTableContract = Object.freeze({
  name: "reviewed_price_promotion_operations",
  dependencies: [],
  columns: Object.freeze([
    ["operation_id", "TEXT", "text", false, 1],
    ["operation_kind", "TEXT", "text", false, 0],
    ["source_apply_operation_id", "TEXT", "text", true, 0],
    ["candidate_sha", "TEXT", "text", false, 0],
    ["expected_environment", "TEXT", "text", false, 0],
    ["authority_bundle_sha256", "TEXT", "text", false, 0],
    ["plan_candidate_sha256", "TEXT", "text", false, 0],
    ["review_packet_candidate_sha256", "TEXT", "text", false, 0],
    ["target_physical_identity_sha256", "TEXT", "text", false, 0],
    ["source_snapshot_sha256", "TEXT", "text", false, 0],
    ["request_sha256", "TEXT", "text", false, 0],
    ["requested_row_count", "INTEGER", "integer", false, 0],
    ["committed_at", "TEXT", "utc-instant", false, 0],
    ["result_state_sha256", "TEXT", "text", false, 0],
    ["receipt_sha256", "TEXT", "text", false, 0],
  ] satisfies readonly PostgresMigrationColumnContract[]),
});

const REVIEWED_PRICE_ROWS_TABLE: LogicalStateTableContract = Object.freeze({
  name: "reviewed_price_promotion_rows",
  dependencies: ["reviewed_price_promotion_operations"],
  columns: Object.freeze([
    ["operation_id", "TEXT", "text", false, 1],
    ["row_ordinal", "INTEGER", "integer", false, 2],
    ["source_ingestion_id", "TEXT", "text", false, 0],
    ["venue_id", "TEXT", "text", false, 0],
    ["price_record_id", "TEXT", "text", false, 0],
    ["venue_beer_id", "TEXT", "text", false, 0],
    ["normalized_beer_id", "TEXT", "text", false, 0],
    ["row_request_sha256", "TEXT", "text", false, 0],
    ["before_state_sha256", "TEXT", "text", false, 0],
    ["after_state_sha256", "TEXT", "text", false, 0],
    ["row_receipt_sha256", "TEXT", "text", false, 0],
  ] satisfies readonly PostgresMigrationColumnContract[]),
});

const ARCHIVED_CONTROL_CONTRACT_V2 = Object.freeze<readonly ArchivedControlContract[]>([
  ...ARCHIVED_CONTROL_CONTRACT,
  {
    schemaName: OPERATIONS_SCHEMA,
    table: REVIEWED_PRICE_OPERATIONS_TABLE,
    postgresTypes: [
      "uuid", "text", "uuid", "text", "text", "text", "text", "text", "text",
      "text", "text", "integer", "timestamp with time zone", "text", "text",
    ],
  },
  {
    schemaName: OPERATIONS_SCHEMA,
    table: REVIEWED_PRICE_ROWS_TABLE,
    postgresTypes: [
      "uuid", "integer", "uuid", "uuid", "text", "text", "text", "text", "text",
      "text", "text",
    ],
  },
]);

const V2_LOCKED_RELATIONS = Object.freeze([
  ...POSTGRES_MIGRATION_CONTRACT.tables.map((table) => [APPLICATION_SCHEMA, table.name] as const),
  [APPLICATION_SCHEMA, "schema_metadata"] as const,
  [OPERATIONS_SCHEMA, "migration_chunks"] as const,
  [OPERATIONS_SCHEMA, "migration_runs"] as const,
  [OPERATIONS_SCHEMA, "reviewed_price_promotion_operations"] as const,
  [OPERATIONS_SCHEMA, "reviewed_price_promotion_rows"] as const,
].sort(([leftSchema, leftTable], [rightSchema, rightTable]) => (
  leftSchema < rightSchema ? -1 : leftSchema > rightSchema ? 1
    : leftTable < rightTable ? -1 : leftTable > rightTable ? 1 : 0
)));

const V2_RELATION_LOCK_SQL = `/* pintpath:logical-state:v2:relation-lock */
  LOCK TABLE ${V2_LOCKED_RELATIONS.map(([schemaName, tableName]) => (
    `ONLY ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`
  )).join(",\n    ")}
  IN ACCESS SHARE MODE`;

interface SourceReadBoundarySchemaDescriptor {
  readonly schemaName: string;
  readonly owner: string;
  readonly acl: readonly SourceReadBoundaryAclDescriptor[];
}

interface SourceReadBoundaryAclDescriptor {
  readonly grantor: string;
  readonly grantee: string;
  readonly privilege: string;
  readonly grantable: boolean;
}

interface SourceReadBoundaryPolicyDescriptor {
  readonly name: string;
  readonly permissive: boolean;
  readonly command: string;
  readonly roles: readonly string[];
  readonly using: string | null;
  readonly withCheck: string | null;
}

interface SourceReadBoundaryRelationDescriptor {
  readonly qualifiedName: string;
  readonly owner: string;
  readonly kind: "r";
  readonly persistence: "p";
  readonly rowSecurity: true;
  readonly forceRowSecurity: true;
  readonly generatedColumnCount: 0;
  readonly identityColumnCount: 0;
  readonly droppedColumnCount: 0;
  readonly nonDefaultCollationColumnCount: number;
  readonly inheritanceEdgeCount: 0;
  readonly isPartition: false;
  readonly accessMethod: "heap";
  readonly tablespaceOid: "0";
  readonly options: null;
  readonly partitionBound: null;
  readonly replicaIdentity: "d";
  readonly primaryKeyCount: 1;
  readonly unsafePrimaryKeyCount: 0;
  readonly columnAclCount: 0;
  readonly acl: readonly SourceReadBoundaryAclDescriptor[];
  readonly policies: readonly SourceReadBoundaryPolicyDescriptor[];
}

interface SourceReadBoundaryKernelTableDescriptor {
  readonly qualifiedName: string;
  readonly columns: readonly string[];
  readonly constraints: readonly string[];
  readonly constraintStates: readonly string[];
  readonly indexes: readonly string[];
  readonly internalForeignKeyTriggers: readonly string[];
  readonly internalTriggerCount: number;
  readonly nonInternalTriggers: number;
  readonly inheritanceEdges: number;
  readonly rewriteRules: number;
  readonly extensionDependencies: number;
  readonly publicationMemberships: number;
  readonly publicationNamespaceMemberships: number;
  readonly isPartition: false;
  readonly accessMethod: "heap";
  readonly tablespaceOid: "0";
  readonly options: null;
  readonly partitionBound: null;
  readonly replicaIdentity: "d";
}

interface SourceReadBoundaryKernelFunctionDescriptor {
  readonly qualifiedName: string;
  readonly owner: string;
  readonly identityArguments: string;
  readonly resultType: string;
  readonly argumentNames: readonly string[];
  readonly language: "plpgsql";
  readonly kind: "f";
  readonly securityDefiner: true;
  readonly volatility: "v";
  readonly parallel: "u";
  readonly leakproof: false;
  readonly strict: false;
  readonly returnsSet: false;
  readonly argumentDefaults: 0;
  readonly variadicTypeOid: "0";
  readonly supportFunctionOid: "0";
  readonly cost: 100;
  readonly rows: 0;
  readonly config: readonly ["search_path=pg_catalog"];
  readonly source: string;
  readonly acl: readonly SourceReadBoundaryAclDescriptor[];
  readonly extensionDependencies: number;
}

interface SourceReadBoundaryRoleDescriptor {
  readonly role: string;
  readonly login: false;
  readonly superuser: false;
  readonly createDatabase: false;
  readonly createRole: false;
  readonly inherit: false;
  readonly replication: false;
  readonly bypassRls: false;
  readonly connectionLimit: -1;
  readonly validUntil: null;
  readonly membershipsGranted: readonly string[];
  readonly membershipsReceived: readonly string[];
  readonly settings: readonly string[];
  readonly sharedDependencies: readonly string[];
}

interface PostgresLogicalStateSourceReadBoundaryDescriptor {
  readonly kind: "pintpath-postgres-logical-state-source-read-boundary";
  readonly version: 1;
  readonly archiveMode: "data-only";
  readonly schemaDefinitionAuthority: "checked-in-canonical-ddl-plus-inert-kernel";
  readonly restorabilityVerification: "required-separate-cross-oid-scratch-restore";
  readonly databaseOwner: string;
  readonly schemas: readonly SourceReadBoundarySchemaDescriptor[];
  readonly relations: readonly SourceReadBoundaryRelationDescriptor[];
  readonly kernelTables: readonly SourceReadBoundaryKernelTableDescriptor[];
  readonly kernelFunctions: readonly SourceReadBoundaryKernelFunctionDescriptor[];
  readonly roles: readonly SourceReadBoundaryRoleDescriptor[];
  readonly privateSequenceCount: 0;
  readonly privateRelationPublicationCount: 0;
  readonly privateSchemaPublicationCount: 0;
  readonly allTablesPublicationCount: 0;
  readonly privateRelationExtensionDependencyCount: 0;
}

const SCOPED_ROLE_LABELS = Object.freeze({
  backup: "$pintpath_logical_backup_current_database",
  applyOwner: "$pintpath_reviewed_price_apply_owner_current_database",
  applyExecute: "$pintpath_reviewed_price_apply_execute_current_database",
  quarantineOwner: "$pintpath_reviewed_price_quarantine_owner_current_database",
  quarantineExecute: "$pintpath_reviewed_price_quarantine_execute_current_database",
} as const);

const BACKUP_ROLE_PREFIX = "pintpath_logical_backup_d";

const SOURCE_READ_BOUNDARY_SCOPED_ROLE_PREFIXES = Object.freeze([
  BACKUP_ROLE_PREFIX,
  ...Object.values(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.roles),
]);

const SOURCE_READ_BOUNDARY_RESERVED_OWNER_IDENTITIES = new Set<string>([
  "PUBLIC",
  "$database_owner",
  "pintpath_migrator",
  "pintpath_runtime",
  ...Object.values(SCOPED_ROLE_LABELS),
]);

function safeSourceReadBoundaryDatabaseOwner(value: string): boolean {
  return value.length >= 1
    && Buffer.byteLength(value, "utf8") <= 63
    && !/[\r\n\0]/.test(value)
    && !SOURCE_READ_BOUNDARY_RESERVED_OWNER_IDENTITIES.has(value)
    && !SOURCE_READ_BOUNDARY_SCOPED_ROLE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

const LOGICAL_BACKUP_POLICY_EXPRESSION = `(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid
   FROM pg_database database
  WHERE (database.datname = current_database()))))`;

const EXPECTED_KERNEL_CONSTRAINT_DESCRIPTORS = Object.freeze({
  "pintpath_ops.reviewed_price_promotion_operations": Object.freeze([
    "reviewed_price_promotion_operations_authority_hash_check:c:CHECK ((authority_bundle_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_operations_candidate_check:c:CHECK ((candidate_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'::text))",
    "reviewed_price_promotion_operations_environment_check:c:CHECK ((expected_environment = ANY (ARRAY['permanent-staging'::text, 'production'::text])))",
    "reviewed_price_promotion_operations_kind_check:c:CHECK ((operation_kind = ANY (ARRAY['apply'::text, 'quarantine'::text])))",
    "reviewed_price_promotion_operations_packet_hash_check:c:CHECK ((review_packet_candidate_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_operations_pkey:p:PRIMARY KEY (operation_id)",
    "reviewed_price_promotion_operations_plan_hash_check:c:CHECK ((plan_candidate_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_operations_receipt_hash_check:c:CHECK ((receipt_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_operations_request_hash_check:c:CHECK ((request_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_operations_result_hash_check:c:CHECK ((result_state_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_operations_row_count_check:c:CHECK (((requested_row_count >= 1) AND (requested_row_count <= 5000)))",
    "reviewed_price_promotion_operations_snapshot_hash_check:c:CHECK ((source_snapshot_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_operations_source_apply_fkey:f:FOREIGN KEY (source_apply_operation_id) REFERENCES pintpath_ops.reviewed_price_promotion_operations(operation_id)",
    "reviewed_price_promotion_operations_source_check:c:CHECK ((((operation_kind = 'apply'::text) AND (source_apply_operation_id IS NULL)) OR ((operation_kind = 'quarantine'::text) AND (source_apply_operation_id IS NOT NULL) AND (source_apply_operation_id <> operation_id))))",
    "reviewed_price_promotion_operations_target_hash_check:c:CHECK ((target_physical_identity_sha256 ~ '^[0-9a-f]{64}$'::text))",
  ]),
  "pintpath_ops.reviewed_price_promotion_rows": Object.freeze([
    "reviewed_price_promotion_rows_after_hash_check:c:CHECK ((after_state_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_rows_before_hash_check:c:CHECK ((before_state_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_rows_normalized_id_check:c:CHECK (((octet_length(normalized_beer_id) >= 1) AND (octet_length(normalized_beer_id) <= 180)))",
    "reviewed_price_promotion_rows_operation_fkey:f:FOREIGN KEY (operation_id) REFERENCES pintpath_ops.reviewed_price_promotion_operations(operation_id)",
    "reviewed_price_promotion_rows_ordinal_check:c:CHECK (((row_ordinal >= 0) AND (row_ordinal <= 4999)))",
    "reviewed_price_promotion_rows_pkey:p:PRIMARY KEY (operation_id, row_ordinal)",
    "reviewed_price_promotion_rows_price_id_check:c:CHECK (((octet_length(price_record_id) >= 1) AND (octet_length(price_record_id) <= 500)))",
    "reviewed_price_promotion_rows_receipt_hash_check:c:CHECK ((row_receipt_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_rows_request_hash_check:c:CHECK ((row_request_sha256 ~ '^[0-9a-f]{64}$'::text))",
    "reviewed_price_promotion_rows_venue_beer_id_check:c:CHECK (((octet_length(venue_beer_id) >= 1) AND (octet_length(venue_beer_id) <= 500)))",
  ]),
} as const);

const EXPECTED_KERNEL_INDEX_DESCRIPTORS = Object.freeze({
  "pintpath_ops.reviewed_price_promotion_operations": Object.freeze([
    "reviewed_price_promotion_operations_pkey:t:t:t:t:t:t:f:f:f:f:CREATE UNIQUE INDEX reviewed_price_promotion_operations_pkey ON pintpath_ops.reviewed_price_promotion_operations USING btree (operation_id)",
    "reviewed_price_promotion_operations_receipt_uidx:t:f:t:t:t:t:f:f:f:f:CREATE UNIQUE INDEX reviewed_price_promotion_operations_receipt_uidx ON pintpath_ops.reviewed_price_promotion_operations USING btree (receipt_sha256)",
    "reviewed_price_promotion_operations_source_apply_idx:f:f:t:t:t:t:f:f:f:f:CREATE INDEX reviewed_price_promotion_operations_source_apply_idx ON pintpath_ops.reviewed_price_promotion_operations USING btree (source_apply_operation_id) WHERE (source_apply_operation_id IS NOT NULL)",
  ]),
  "pintpath_ops.reviewed_price_promotion_rows": Object.freeze([
    "reviewed_price_promotion_rows_pkey:t:t:t:t:t:t:f:f:f:f:CREATE UNIQUE INDEX reviewed_price_promotion_rows_pkey ON pintpath_ops.reviewed_price_promotion_rows USING btree (operation_id, row_ordinal)",
    "reviewed_price_promotion_rows_price_uidx:t:f:t:t:t:t:f:f:f:f:CREATE UNIQUE INDEX reviewed_price_promotion_rows_price_uidx ON pintpath_ops.reviewed_price_promotion_rows USING btree (operation_id, price_record_id)",
    "reviewed_price_promotion_rows_receipt_uidx:t:f:t:t:t:t:f:f:f:f:CREATE UNIQUE INDEX reviewed_price_promotion_rows_receipt_uidx ON pintpath_ops.reviewed_price_promotion_rows USING btree (operation_id, row_receipt_sha256)",
    "reviewed_price_promotion_rows_venue_beer_uidx:t:f:t:t:t:t:f:f:f:f:CREATE UNIQUE INDEX reviewed_price_promotion_rows_venue_beer_uidx ON pintpath_ops.reviewed_price_promotion_rows USING btree (operation_id, venue_beer_id)",
  ]),
} as const);

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

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonicalUuid(value: string): string {
  if (!CANONICAL_UUID_PATTERN.test(value)) {
    throw new PostgresLogicalStateError("state_invalid");
  }
  return value;
}

function uuidBytes(value: string): Buffer {
  return Buffer.from(canonicalUuid(value).replaceAll("-", ""), "hex");
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
  columns?: readonly LogicalStateColumnContract[],
  domain = "pint-path-source-primary-key-v1",
  keyKinds?: readonly LogicalStateKeyKind[],
): Buffer {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, domain);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const column = columns?.[index];
    const keyKind = keyKinds?.[index] ?? (column?.[1] === "INTEGER" ? "integer" : "text");
    if (!column || keyKind === "text") updateLengthFramed(hash, `T${value}`);
    else if (keyKind === "integer") updateLengthFramed(hash, `I${BigInt(value)}`);
    else if (keyKind === "uuid") updateLengthFramed(hash, `U${canonicalUuid(value)}`);
    else throw new PostgresLogicalStateError("contract_invalid");
  }
  return hash.digest();
}

function canonicalRow(
  table: LogicalStateTableContract,
  row: Readonly<Record<string, unknown>>,
  domain = "pint-path-postgres-transformed-row-v1",
): Buffer {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, domain);
  updateLengthFramed(hash, table.name);
  for (const column of table.columns) {
    updateLengthFramed(hash, column[0]);
    updateLengthFramed(hash, canonicalNativeValue(row[column[0]], column));
  }
  return hash.digest();
}

function targetProjection(table: LogicalStateTableContract): string {
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

function primaryKeyColumns(table: LogicalStateTableContract): LogicalStateColumnContract[] {
  const columns = table.columns
    .filter((column) => column[4] > 0)
    .sort((left, right) => left[4] - right[4]);
  if (
    columns.length === 0
    || columns.some((column, index) => (
      column[4] !== index + 1 || !["TEXT", "INTEGER", "UUID"].includes(column[1])
    ))
  ) throw new PostgresLogicalStateError("contract_invalid");
  return columns;
}

function renderPageSql(
  table: LogicalStateTableContract,
  hasCursor: boolean,
  schemaName = APPLICATION_SCHEMA,
  onlyOwnRows = false,
): string {
  const keys = primaryKeyColumns(table);
  const tableIdentifier = quoteIdentifier(table.name);
  const keyExpressions = keys.map((column) => (
    keyKindForColumn(table, column) === "text"
      ? `${quoteIdentifier(column[0])} COLLATE "C"`
      : quoteIdentifier(column[0])
  ));
  const parameters = keys.map((column, index) => (
    keyKindForColumn(table, column) === "text"
      ? `$${index + 1}::text COLLATE "C"`
      : keyKindForColumn(table, column) === "integer"
        ? `$${index + 1}::bigint`
        : `$${index + 1}::uuid`
  ));
  const cursor = hasCursor
    ? `WHERE ROW(${keyExpressions.join(", ")}) > ROW(${parameters.join(", ")})`
    : "";
  return `/* pintpath:logical-state:page:${schemaName}:${table.name} */
    SELECT ${targetProjection(table)}
    FROM ${onlyOwnRows ? "ONLY " : ""}${schemaName}.${tableIdentifier}
    ${cursor}
    ORDER BY ${keyExpressions.map((expression) => `${expression} ASC`).join(", ")}
    LIMIT $${hasCursor ? keys.length + 1 : 1}::integer`;
}

function pageSql(
  table: LogicalStateTableContract,
  hasCursor: boolean,
  schemaName = APPLICATION_SCHEMA,
): string {
  return renderPageSql(table, hasCursor, schemaName, false);
}

function pageSqlV2(
  table: LogicalStateTableContract,
  hasCursor: boolean,
  schemaName = APPLICATION_SCHEMA,
): string {
  return renderPageSql(table, hasCursor, schemaName, true);
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

/**
 * Exact read and pagination boundary component for a future data-only archive.
 * It intentionally does not claim to prove every source constraint or the
 * archive's restorability. A future V4 archive must contain only the reviewed
 * TABLE DATA TOC, restore into the pinned canonical DDL plus kernel in a
 * different-OID scratch database, and pass exact V2 recapture before acceptance.
 */
const SOURCE_READ_BOUNDARY_SQL = `/* pintpath:logical-state:v2:source-read-boundary */
WITH database_identity AS (
  SELECT database.oid, database.datdba, owner.rolname AS database_owner
  FROM pg_catalog.pg_database AS database
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = database.datdba
  WHERE database.datname = pg_catalog.current_database()
), scoped_role_names AS (
  SELECT role_name
  FROM database_identity AS database
  CROSS JOIN LATERAL pg_catalog.unnest(ARRAY[
    'pintpath_logical_backup_d' || database.oid::text,
    'pintpath_reviewed_price_apply_owner_d' || database.oid::text,
    'pintpath_reviewed_price_apply_execute_d' || database.oid::text,
    'pintpath_reviewed_price_quarantine_owner_d' || database.oid::text,
    'pintpath_reviewed_price_quarantine_execute_d' || database.oid::text
  ]) AS expected(role_name)
), private_relations AS (
  SELECT relation.oid, relation.relname, relation.relowner, relation.relkind,
         relation.relpersistence, relation.relrowsecurity, relation.relforcerowsecurity,
         relation.relispartition, relation.relam, relation.reltablespace,
         relation.reloptions, relation.relpartbound, relation.relreplident,
         namespace.nspname
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
    AND relation.relkind IN ('r', 'p')
), kernel_relations AS (
  SELECT * FROM private_relations
  WHERE nspname = 'pintpath_ops'
    AND relname = ANY(ARRAY[
      'reviewed_price_promotion_operations',
      'reviewed_price_promotion_rows'
    ])
), kernel_routines AS (
  SELECT routine.*, namespace.nspname, language.lanname, owner.rolname AS owner_name
  FROM pg_catalog.pg_proc AS routine
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
  JOIN pg_catalog.pg_language AS language ON language.oid = routine.prolang
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
  WHERE namespace.nspname = 'pintpath_ops'
    AND routine.proname = ANY(ARRAY[
      'apply_reviewed_price_promotion',
      'quarantine_reviewed_price_promotion'
    ])
)
SELECT database.oid::text AS "databaseOid",
  pg_catalog.jsonb_build_object(
    'kind', 'pintpath-postgres-logical-state-source-read-boundary',
    'version', 1,
    'archiveMode', 'data-only',
    'schemaDefinitionAuthority', 'checked-in-canonical-ddl-plus-inert-kernel',
    'restorabilityVerification', 'required-separate-cross-oid-scratch-restore',
    'databaseOwner', database.database_owner,
    'schemas', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'schemaName', namespace.nspname,
        'owner', owner.rolname,
        'acl', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'grantor', grantor.rolname,
            'grantee', COALESCE(grantee.rolname, 'PUBLIC'),
            'privilege', privilege.privilege_type,
            'grantable', privilege.is_grantable
          ) ORDER BY grantor.rolname COLLATE "C", COALESCE(grantee.rolname, 'PUBLIC') COLLATE "C",
                     privilege.privilege_type COLLATE "C", privilege.is_grantable)
          FROM pg_catalog.aclexplode(COALESCE(
            namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
          )) AS privilege
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        ), '[]'::pg_catalog.jsonb)
      ) ORDER BY namespace.nspname COLLATE "C")
      FROM pg_catalog.pg_namespace AS namespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
    ), '[]'::pg_catalog.jsonb),
    'relations', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'qualifiedName', pg_catalog.format('%I.%I', relation.nspname, relation.relname),
        'owner', owner.rolname,
        'kind', relation.relkind,
        'persistence', relation.relpersistence,
        'rowSecurity', relation.relrowsecurity,
        'forceRowSecurity', relation.relforcerowsecurity,
        'generatedColumnCount', (SELECT pg_catalog.count(*)::integer
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
            AND attribute.attgenerated <> ''),
        'identityColumnCount', (SELECT pg_catalog.count(*)::integer
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
            AND attribute.attidentity <> ''),
        'droppedColumnCount', (SELECT pg_catalog.count(*)::integer
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attnum > 0 AND attribute.attisdropped),
        'nonDefaultCollationColumnCount', (SELECT pg_catalog.count(*)::integer
          FROM pg_catalog.pg_attribute AS attribute
          JOIN pg_catalog.pg_type AS column_type ON column_type.oid = attribute.atttypid
          WHERE attribute.attrelid = relation.oid
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
            AND attribute.attcollation <> column_type.typcollation),
        'inheritanceEdgeCount', (SELECT pg_catalog.count(*)::integer
          FROM pg_catalog.pg_inherits AS inheritance
          WHERE inheritance.inhrelid = relation.oid OR inheritance.inhparent = relation.oid),
        'isPartition', relation.relispartition,
        'accessMethod', access_method.amname,
        'tablespaceOid', relation.reltablespace::text,
        'options', relation.reloptions,
        'partitionBound', pg_catalog.pg_get_expr(relation.relpartbound, relation.oid, false),
        'replicaIdentity', relation.relreplident,
        'primaryKeyCount', (SELECT pg_catalog.count(*)::integer
          FROM pg_catalog.pg_constraint AS primary_key
          WHERE primary_key.conrelid = relation.oid AND primary_key.contype = 'p'),
        'unsafePrimaryKeyCount', (SELECT pg_catalog.count(*)::integer
          FROM pg_catalog.pg_constraint AS primary_key
          LEFT JOIN pg_catalog.pg_index AS primary_index
            ON primary_index.indexrelid = primary_key.conindid
          LEFT JOIN pg_catalog.pg_class AS primary_index_relation
            ON primary_index_relation.oid = primary_key.conindid
          LEFT JOIN pg_catalog.pg_am AS primary_index_access_method
            ON primary_index_access_method.oid = primary_index_relation.relam
          WHERE primary_key.conrelid = relation.oid AND primary_key.contype = 'p'
            AND (
              NOT primary_key.convalidated
              OR primary_key.condeferrable
              OR primary_key.condeferred
              OR NOT primary_key.connoinherit
              OR primary_key.conindid = 0::oid
              OR primary_index.indexrelid IS NULL
              OR NOT primary_index.indisunique
              OR NOT primary_index.indisprimary
              OR NOT primary_index.indisvalid
              OR NOT primary_index.indisready
              OR NOT primary_index.indislive
              OR NOT primary_index.indimmediate
              OR primary_index.indcheckxmin
              OR primary_index.indisclustered
              OR primary_index.indisreplident
              OR primary_index.indnullsnotdistinct
              OR primary_index.indexprs IS NOT NULL
              OR primary_index.indpred IS NOT NULL
              OR primary_index.indnatts <> pg_catalog.cardinality(primary_key.conkey)
              OR primary_index.indnkeyatts <> pg_catalog.cardinality(primary_key.conkey)
              OR EXISTS (
                SELECT 1
                FROM pg_catalog.unnest(primary_key.conkey) WITH ORDINALITY
                  AS constraint_key(attnum, key_ordinal)
                FULL JOIN pg_catalog.unnest(primary_index.indkey::pg_catalog.int2[])
                  WITH ORDINALITY AS index_key(attnum, key_ordinal)
                  USING (key_ordinal)
                WHERE constraint_key.attnum IS DISTINCT FROM index_key.attnum
              )
              OR primary_index_relation.relkind <> 'i'
              OR primary_index_relation.relpersistence <> 'p'
              OR primary_index_relation.relispartition
              OR primary_index_relation.relnamespace <> relation_acl.relnamespace
              OR primary_index_relation.relowner <> relation.relowner
              OR primary_index_relation.reltablespace <> 0::oid
              OR primary_index_relation.reloptions IS NOT NULL
              OR primary_index_access_method.amname <> 'btree'
            )),
        'columnAclCount', (SELECT pg_catalog.count(*)::integer
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
            AND attribute.attacl IS NOT NULL),
        'acl', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'grantor', grantor.rolname,
            'grantee', COALESCE(grantee.rolname, 'PUBLIC'),
            'privilege', privilege.privilege_type,
            'grantable', privilege.is_grantable
          ) ORDER BY grantor.rolname COLLATE "C", COALESCE(grantee.rolname, 'PUBLIC') COLLATE "C",
                     privilege.privilege_type COLLATE "C", privilege.is_grantable)
          FROM pg_catalog.aclexplode(COALESCE(
            relation_acl.relacl, pg_catalog.acldefault('r', relation_acl.relowner)
          )) AS privilege
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        ), '[]'::pg_catalog.jsonb),
        'policies', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'name', policy.polname,
            'permissive', policy.polpermissive,
            'command', policy.polcmd,
            'roles', COALESCE((
              SELECT pg_catalog.jsonb_agg(COALESCE(policy_role.rolname, 'PUBLIC')
                ORDER BY COALESCE(policy_role.rolname, 'PUBLIC') COLLATE "C")
              FROM pg_catalog.unnest(policy.polroles) AS policy_role_oid(oid)
              LEFT JOIN pg_catalog.pg_roles AS policy_role ON policy_role.oid = policy_role_oid.oid
            ), '[]'::pg_catalog.jsonb),
            'using', pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false),
            'withCheck', pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false)
          ) ORDER BY policy.polname COLLATE "C")
          FROM pg_catalog.pg_policy AS policy WHERE policy.polrelid = relation.oid
        ), '[]'::pg_catalog.jsonb)
      ) ORDER BY relation.nspname COLLATE "C", relation.relname COLLATE "C")
      FROM private_relations AS relation
      JOIN pg_catalog.pg_class AS relation_acl ON relation_acl.oid = relation.oid
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
      JOIN pg_catalog.pg_am AS access_method ON access_method.oid = relation.relam
    ), '[]'::pg_catalog.jsonb),
    'kernelTables', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'qualifiedName', pg_catalog.format('%I.%I', relation.nspname, relation.relname),
        'columns', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.format('%s:%s:%s:%s:%s:%s:%s',
            attribute.attname,
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
            CASE WHEN attribute.attnotnull THEN 'not-null' ELSE 'nullable' END,
            CASE WHEN collation_record.oid IS NULL THEN '-'
              ELSE pg_catalog.format('%I.%I', collation_namespace.nspname, collation_record.collname)
            END,
            COALESCE(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false), '-'),
            COALESCE(NULLIF(attribute.attgenerated, ''), '-'),
            COALESCE(NULLIF(attribute.attidentity, ''), '-')
          ) ORDER BY attribute.attnum)
          FROM pg_catalog.pg_attribute AS attribute
          LEFT JOIN pg_catalog.pg_collation AS collation_record
            ON collation_record.oid = attribute.attcollation AND attribute.attcollation <> 0::oid
          LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
            ON collation_namespace.oid = collation_record.collnamespace
          LEFT JOIN pg_catalog.pg_attrdef AS default_value
            ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
          WHERE attribute.attrelid = relation.oid
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
        ), '[]'::pg_catalog.jsonb),
        'constraints', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.format('%s:%s:%s',
            constraint_object.conname, constraint_object.contype,
            pg_catalog.pg_get_constraintdef(constraint_object.oid, false)
          ) ORDER BY constraint_object.conname COLLATE "C")
          FROM pg_catalog.pg_constraint AS constraint_object
          WHERE constraint_object.conrelid = relation.oid
        ), '[]'::pg_catalog.jsonb),
        'constraintStates', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.format('%s:%s:%s:%s:%s:%s',
            constraint_object.conname, constraint_object.convalidated,
            constraint_object.condeferrable, constraint_object.condeferred,
            constraint_object.connoinherit,
            CASE WHEN constraint_object.contype = 'f' THEN constraint_object.confdeltype::text ELSE '-' END
          ) ORDER BY constraint_object.conname COLLATE "C")
          FROM pg_catalog.pg_constraint AS constraint_object
          WHERE constraint_object.conrelid = relation.oid
        ), '[]'::pg_catalog.jsonb),
        'indexes', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.format('%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
            index_relation.relname, index_object.indisunique, index_object.indisprimary,
            index_object.indisvalid, index_object.indisready, index_object.indislive,
            index_object.indimmediate, index_object.indcheckxmin, index_object.indisclustered,
            index_object.indisreplident, index_object.indnullsnotdistinct,
            pg_catalog.pg_get_indexdef(index_relation.oid)
          ) ORDER BY index_relation.relname COLLATE "C")
          FROM pg_catalog.pg_index AS index_object
          JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_object.indexrelid
          WHERE index_object.indrelid = relation.oid
        ), '[]'::pg_catalog.jsonb),
        'internalForeignKeyTriggers', COALESCE((SELECT pg_catalog.jsonb_agg(
          pg_catalog.format('%s:%s:%s:%s:%s:%s:%s:%s',
            constraint_object.conname, trigger_object.tgtype, trigger_object.tgenabled,
            trigger_object.tgisinternal, trigger_object.tgdeferrable,
            trigger_object.tginitdeferred, trigger_object.tgparentid,
            pg_catalog.format('%I.%I', trigger_function_namespace.nspname, trigger_function.proname)
          ) ORDER BY constraint_object.conname COLLATE "C", trigger_object.tgtype,
                     trigger_function_namespace.nspname COLLATE "C",
                     trigger_function.proname COLLATE "C")
          FROM pg_catalog.pg_trigger AS trigger_object
          JOIN pg_catalog.pg_constraint AS constraint_object
            ON constraint_object.oid = trigger_object.tgconstraint
          JOIN pg_catalog.pg_proc AS trigger_function ON trigger_function.oid = trigger_object.tgfoid
          JOIN pg_catalog.pg_namespace AS trigger_function_namespace
            ON trigger_function_namespace.oid = trigger_function.pronamespace
          WHERE trigger_object.tgrelid = relation.oid AND trigger_object.tgisinternal
            AND trigger_object.tgconstraint <> 0::oid
        ), '[]'::pg_catalog.jsonb),
        'nonInternalTriggers', (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_trigger AS trigger_object
          WHERE trigger_object.tgrelid = relation.oid AND NOT trigger_object.tgisinternal),
        'internalTriggerCount', (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_trigger AS trigger_object
          WHERE trigger_object.tgrelid = relation.oid AND trigger_object.tgisinternal),
        'inheritanceEdges', (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_inherits AS inheritance
          WHERE inheritance.inhrelid = relation.oid OR inheritance.inhparent = relation.oid),
        'rewriteRules', (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_rewrite AS rewrite_rule
          WHERE rewrite_rule.ev_class = relation.oid AND rewrite_rule.rulename <> '_RETURN'),
        'extensionDependencies', (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_depend AS dependency
          WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND dependency.objid = relation.oid AND dependency.deptype = 'e'),
        'publicationMemberships', (SELECT pg_catalog.count(*)::integer
          FROM pg_catalog.pg_publication_rel AS publication_relation
          WHERE publication_relation.prrelid = relation.oid),
        'publicationNamespaceMemberships', (SELECT pg_catalog.count(*)::integer
          FROM pg_catalog.pg_publication_namespace AS publication_namespace
          JOIN pg_catalog.pg_namespace AS publication_schema
            ON publication_schema.oid = publication_namespace.pnnspid
          WHERE publication_schema.nspname = relation.nspname),
        'isPartition', relation_class.relispartition,
        'accessMethod', access_method.amname,
        'tablespaceOid', relation_class.reltablespace::text,
        'options', relation_class.reloptions,
        'partitionBound', pg_catalog.pg_get_expr(relation_class.relpartbound, relation_class.oid, false),
        'replicaIdentity', relation_class.relreplident
      ) ORDER BY relation.relname COLLATE "C") FROM kernel_relations AS relation
      JOIN pg_catalog.pg_class AS relation_class ON relation_class.oid = relation.oid
      JOIN pg_catalog.pg_am AS access_method ON access_method.oid = relation_class.relam
    ), '[]'::pg_catalog.jsonb),
    'kernelFunctions', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'qualifiedName', pg_catalog.format('%I.%I', routine.nspname, routine.proname),
        'owner', routine.owner_name,
        'identityArguments', pg_catalog.pg_get_function_identity_arguments(routine.oid),
        'resultType', pg_catalog.pg_get_function_result(routine.oid),
        'argumentNames', COALESCE(pg_catalog.to_jsonb(routine.proargnames), '[]'::pg_catalog.jsonb),
        'language', routine.lanname,
        'kind', routine.prokind,
        'securityDefiner', routine.prosecdef,
        'volatility', routine.provolatile,
        'parallel', routine.proparallel,
        'leakproof', routine.proleakproof,
        'strict', routine.proisstrict,
        'returnsSet', routine.proretset,
        'argumentDefaults', routine.pronargdefaults,
        'variadicTypeOid', routine.provariadic::text,
        'supportFunctionOid', routine.prosupport::oid::text,
        'cost', routine.procost,
        'rows', routine.prorows,
        'config', COALESCE(pg_catalog.to_jsonb(routine.proconfig), '[]'::pg_catalog.jsonb),
        'source', routine.prosrc,
        'acl', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantor', grantor.rolname,
          'grantee', COALESCE(grantee.rolname, 'PUBLIC'),
          'privilege', privilege.privilege_type,
          'grantable', privilege.is_grantable
        ) ORDER BY grantor.rolname COLLATE "C", COALESCE(grantee.rolname, 'PUBLIC') COLLATE "C",
                   privilege.privilege_type COLLATE "C", privilege.is_grantable)
          FROM pg_catalog.aclexplode(COALESCE(
            routine.proacl, pg_catalog.acldefault('f', routine.proowner)
          )) AS privilege
          JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = privilege.grantor
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
        ), '[]'::pg_catalog.jsonb),
        'extensionDependencies', (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_depend AS dependency
          WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND dependency.objid = routine.oid AND dependency.deptype = 'e')
      ) ORDER BY routine.proname COLLATE "C", routine.oid)
      FROM kernel_routines AS routine
    ), '[]'::pg_catalog.jsonb),
    'roles', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'role', role.rolname,
        'login', role.rolcanlogin,
        'superuser', role.rolsuper,
        'createDatabase', role.rolcreatedb,
        'createRole', role.rolcreaterole,
        'inherit', role.rolinherit,
        'replication', role.rolreplication,
        'bypassRls', role.rolbypassrls,
        'connectionLimit', role.rolconnlimit,
        'validUntil', role.rolvaliduntil,
        'membershipsGranted', COALESCE((SELECT pg_catalog.jsonb_agg(granted.rolname ORDER BY granted.rolname COLLATE "C")
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
          WHERE membership.member = role.oid), '[]'::pg_catalog.jsonb),
        'membershipsReceived', COALESCE((SELECT pg_catalog.jsonb_agg(member.rolname ORDER BY member.rolname COLLATE "C")
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
          WHERE membership.roleid = role.oid), '[]'::pg_catalog.jsonb),
        'settings', COALESCE((SELECT pg_catalog.jsonb_agg(setting.setconfig::text ORDER BY setting.setdatabase, setting.setconfig::text COLLATE "C")
          FROM pg_catalog.pg_db_role_setting AS setting WHERE setting.setrole = role.oid), '[]'::pg_catalog.jsonb),
        'sharedDependencies', COALESCE((SELECT pg_catalog.jsonb_agg(
          pg_catalog.format('%s:%s:%s:%s:%s',
            CASE
              WHEN dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
                THEN 'schema'
              WHEN dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                THEN 'relation'
              WHEN dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                THEN 'function'
              ELSE 'unsupported-' || dependency.classid::text
            END,
            COALESCE(namespace.nspname,
              CASE WHEN relation.oid IS NOT NULL THEN pg_catalog.format('%I.%I', relation_namespace.nspname, relation.relname) END,
              CASE WHEN target_routine.oid IS NOT NULL THEN pg_catalog.format('%I.%I(%s)', routine_namespace.nspname,
                target_routine.proname, pg_catalog.pg_get_function_identity_arguments(target_routine.oid)) END,
              dependency.objid::text),
            dependency.deptype, dependency.objsubid,
            dependency.dbid = database.oid
          ) ORDER BY pg_catalog.format('%s:%s:%s:%s:%s',
            CASE
              WHEN dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass THEN 'schema'
              WHEN dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass THEN 'relation'
              WHEN dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass THEN 'function'
              ELSE 'unsupported-' || dependency.classid::text
            END,
            COALESCE(namespace.nspname,
              CASE WHEN relation.oid IS NOT NULL THEN pg_catalog.format('%I.%I', relation_namespace.nspname, relation.relname) END,
              CASE WHEN target_routine.oid IS NOT NULL THEN pg_catalog.format('%I.%I(%s)', routine_namespace.nspname,
                target_routine.proname, pg_catalog.pg_get_function_identity_arguments(target_routine.oid)) END,
              dependency.objid::text), dependency.deptype, dependency.objsubid,
            dependency.dbid = database.oid
          ) COLLATE "C")
          FROM pg_catalog.pg_shdepend AS dependency
          LEFT JOIN pg_catalog.pg_namespace AS namespace
            ON dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
           AND namespace.oid = dependency.objid
          LEFT JOIN pg_catalog.pg_class AS relation
            ON dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
           AND relation.oid = dependency.objid
          LEFT JOIN pg_catalog.pg_namespace AS relation_namespace ON relation_namespace.oid = relation.relnamespace
          LEFT JOIN pg_catalog.pg_proc AS target_routine
            ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
           AND target_routine.oid = dependency.objid
          LEFT JOIN pg_catalog.pg_namespace AS routine_namespace ON routine_namespace.oid = target_routine.pronamespace
          WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            AND dependency.refobjid = role.oid
        ), '[]'::pg_catalog.jsonb)
      ) ORDER BY role.rolname COLLATE "C")
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname IN (SELECT role_name FROM scoped_role_names)
    ), '[]'::pg_catalog.jsonb),
    'privateSequenceCount', (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_class AS sequence
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops']) AND sequence.relkind = 'S'),
    'privateRelationPublicationCount', (SELECT pg_catalog.count(*)::integer
      FROM pg_catalog.pg_publication_rel AS publication_relation
      WHERE publication_relation.prrelid IN (SELECT oid FROM private_relations)),
    'privateSchemaPublicationCount', (SELECT pg_catalog.count(*)::integer
      FROM pg_catalog.pg_publication_namespace AS publication_namespace
      JOIN pg_catalog.pg_namespace AS publication_schema
        ON publication_schema.oid = publication_namespace.pnnspid
      WHERE publication_schema.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])),
    'allTablesPublicationCount', (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_publication WHERE puballtables),
    'privateRelationExtensionDependencyCount',
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_depend AS dependency
       WHERE dependency.deptype = 'e'
         AND dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.objid IN (SELECT oid FROM private_relations))
  )::pg_catalog.text AS "descriptorJson"
FROM database_identity AS database`;

function compareCatalogText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortedCatalog<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => compareCatalogText(key(left), key(right)));
}

function catalogAcl(
  owner: string,
  ownerPrivileges: readonly string[],
  grants: readonly (readonly [grantee: string, privilege: string])[],
): SourceReadBoundaryAclDescriptor[] {
  return sortedCatalog([
    ...ownerPrivileges.map((privilege) => ({
      grantor: owner, grantee: owner, privilege, grantable: false,
    })),
    ...grants.map(([grantee, privilege]) => ({
      grantor: owner, grantee, privilege, grantable: false,
    })),
  ], (entry) => `${entry.grantor}\0${entry.grantee}\0${entry.privilege}\0${entry.grantable}`);
}

function catalogPolicy(
  name: string,
  command: string,
  roles: readonly string[],
  using: string | null,
  withCheck: string | null,
): SourceReadBoundaryPolicyDescriptor {
  return { name, permissive: true, command, roles, using, withCheck };
}

function basePolicies(schemaName: string, tableName: string): SourceReadBoundaryPolicyDescriptor[] {
  let policies: SourceReadBoundaryPolicyDescriptor[];
  if (schemaName === APPLICATION_SCHEMA && tableName === "schema_metadata") {
    policies = [
      catalogPolicy("schema_metadata_runtime_read", "r", ["pintpath_runtime"], "true", null),
      catalogPolicy("schema_metadata_migrator_select", "r", ["pintpath_migrator"], "true", null),
      catalogPolicy("schema_metadata_migrator_update", "w", ["pintpath_migrator"], "true", "true"),
    ];
  } else if (schemaName === OPERATIONS_SCHEMA && ["migration_chunks", "migration_runs"].includes(tableName)) {
    policies = [
      catalogPolicy(`${tableName}_migrator_select`, "r", ["pintpath_migrator"], "true", null),
      catalogPolicy(`${tableName}_migrator_insert`, "a", ["pintpath_migrator"], null, "true"),
      catalogPolicy(`${tableName}_migrator_update`, "w", ["pintpath_migrator"], "true", "true"),
    ];
  } else if (schemaName === OPERATIONS_SCHEMA) {
    policies = [
      catalogPolicy(`${tableName}_migrator_select`, "r", ["pintpath_migrator"], "true", null),
    ];
  } else {
    policies = [
      catalogPolicy(`${tableName}_runtime_all`, "*", ["pintpath_runtime"], "true", "true"),
      catalogPolicy(`${tableName}_migrator_select`, "r", ["pintpath_migrator"], "true", null),
      catalogPolicy(`${tableName}_migrator_insert`, "a", ["pintpath_migrator"], null, "true"),
    ];
  }
  policies.push(catalogPolicy(
    `${tableName}_logical_backup_select`, "r", ["PUBLIC"],
    LOGICAL_BACKUP_POLICY_EXPRESSION, null,
  ));
  return sortedCatalog(policies, (policy) => policy.name);
}

function expectedRelationAcl(
  owner: string,
  schemaName: string,
  tableName: string,
): SourceReadBoundaryAclDescriptor[] {
  const grants: Array<readonly [string, string]> = [[SCOPED_ROLE_LABELS.backup, "SELECT"]];
  if (schemaName === APPLICATION_SCHEMA && tableName === "schema_metadata") {
    grants.push(["pintpath_runtime", "SELECT"], ["pintpath_migrator", "SELECT"],
      ["pintpath_migrator", "UPDATE"]);
  } else if (schemaName === APPLICATION_SCHEMA) {
    for (const privilege of ["DELETE", "INSERT", "SELECT", "UPDATE"]) {
      grants.push(["pintpath_runtime", privilege]);
    }
    grants.push(["pintpath_migrator", "INSERT"], ["pintpath_migrator", "SELECT"]);
  } else if (["migration_chunks", "migration_runs"].includes(tableName)) {
    grants.push(["pintpath_migrator", "INSERT"], ["pintpath_migrator", "SELECT"],
      ["pintpath_migrator", "UPDATE"]);
  } else {
    grants.push(["pintpath_migrator", "SELECT"]);
  }
  return catalogAcl(owner, [
    "DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE",
  ], grants);
}

function kernelColumnDescriptors(
  columns: readonly string[],
): string[] {
  return columns.map((column) => {
    const [name, type, nullable] = column.split(":");
    const postgresType = type === "text-c" ? "text"
      : type === "timestamptz" ? "timestamp with time zone" : type;
    return `${name}:${postgresType}:${nullable}:${type === "text-c" ? "pg_catalog.\"C\"" : "-"}:-:-:-`;
  });
}

function kernelConstraintStates(
  names: readonly string[],
): string[] {
  return names.map((name) => (
    `${name}:t:f:f:${name.endsWith("_pkey") || name.endsWith("_fkey") ? "t" : "f"}:${name.endsWith("_fkey") ? "a" : "-"}`
  ));
}

const OPERATIONS_FOREIGN_KEY_TRIGGER_DESCRIPTORS = Object.freeze([
  "reviewed_price_promotion_operations_source_apply_fkey:5:O:t:f:f:0:pg_catalog.\"RI_FKey_check_ins\"",
  "reviewed_price_promotion_operations_source_apply_fkey:9:O:t:f:f:0:pg_catalog.\"RI_FKey_noaction_del\"",
  "reviewed_price_promotion_operations_source_apply_fkey:17:O:t:f:f:0:pg_catalog.\"RI_FKey_check_upd\"",
  "reviewed_price_promotion_operations_source_apply_fkey:17:O:t:f:f:0:pg_catalog.\"RI_FKey_noaction_upd\"",
  "reviewed_price_promotion_rows_operation_fkey:9:O:t:f:f:0:pg_catalog.\"RI_FKey_noaction_del\"",
  "reviewed_price_promotion_rows_operation_fkey:17:O:t:f:f:0:pg_catalog.\"RI_FKey_noaction_upd\"",
]);

const ROWS_FOREIGN_KEY_TRIGGER_DESCRIPTORS = Object.freeze([
  "reviewed_price_promotion_rows_operation_fkey:5:O:t:f:f:0:pg_catalog.\"RI_FKey_check_ins\"",
  "reviewed_price_promotion_rows_operation_fkey:17:O:t:f:f:0:pg_catalog.\"RI_FKey_check_upd\"",
]);

function expectedSourceReadBoundaryDescriptor(
  databaseOwner: string,
): PostgresLogicalStateSourceReadBoundaryDescriptor {
  const applicationTables = [
    ...POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
    "schema_metadata",
  ];
  const operationsTables = [
    "migration_chunks", "migration_runs",
    "reviewed_price_promotion_operations", "reviewed_price_promotion_rows",
  ];
  const relations = sortedCatalog([
    ...applicationTables.map((tableName) => ({ schemaName: APPLICATION_SCHEMA, tableName })),
    ...operationsTables.map((tableName) => ({ schemaName: OPERATIONS_SCHEMA, tableName })),
  ], (entry) => `${entry.schemaName}.${entry.tableName}`).map(({ schemaName, tableName }) => ({
    qualifiedName: `${schemaName}.${tableName}`,
    owner: databaseOwner,
    kind: "r" as const,
    persistence: "p" as const,
    rowSecurity: true as const,
    forceRowSecurity: true as const,
    generatedColumnCount: 0 as const,
    identityColumnCount: 0 as const,
    droppedColumnCount: 0 as const,
    nonDefaultCollationColumnCount: schemaName === OPERATIONS_SCHEMA
        && tableName === "reviewed_price_promotion_operations"
      ? 11
      : schemaName === OPERATIONS_SCHEMA && tableName === "reviewed_price_promotion_rows"
        ? 7
        : 0,
    inheritanceEdgeCount: 0 as const,
    isPartition: false as const,
    accessMethod: "heap" as const,
    tablespaceOid: "0" as const,
    options: null,
    partitionBound: null,
    replicaIdentity: "d" as const,
    primaryKeyCount: 1 as const,
    unsafePrimaryKeyCount: 0 as const,
    columnAclCount: 0 as const,
    acl: expectedRelationAcl(databaseOwner, schemaName, tableName),
    policies: basePolicies(schemaName, tableName),
  }));
  const kernelTables: SourceReadBoundaryKernelTableDescriptor[] = [
    {
      qualifiedName: POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables.operations.qualifiedName,
      columns: kernelColumnDescriptors(
        POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables.operations.columns,
      ),
      constraints: EXPECTED_KERNEL_CONSTRAINT_DESCRIPTORS[
        "pintpath_ops.reviewed_price_promotion_operations"
      ],
      constraintStates: kernelConstraintStates(
        POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables.operations.constraints,
      ),
      indexes: EXPECTED_KERNEL_INDEX_DESCRIPTORS[
        "pintpath_ops.reviewed_price_promotion_operations"
      ],
      internalForeignKeyTriggers: OPERATIONS_FOREIGN_KEY_TRIGGER_DESCRIPTORS,
      internalTriggerCount: 6,
      nonInternalTriggers: 0,
      inheritanceEdges: 0,
      rewriteRules: 0,
      extensionDependencies: 0,
      publicationMemberships: 0,
      publicationNamespaceMemberships: 0,
      isPartition: false,
      accessMethod: "heap",
      tablespaceOid: "0",
      options: null,
      partitionBound: null,
      replicaIdentity: "d",
    },
    {
      qualifiedName: POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables.rows.qualifiedName,
      columns: kernelColumnDescriptors(
        POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables.rows.columns,
      ),
      constraints: EXPECTED_KERNEL_CONSTRAINT_DESCRIPTORS[
        "pintpath_ops.reviewed_price_promotion_rows"
      ],
      constraintStates: kernelConstraintStates(
        POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables.rows.constraints,
      ),
      indexes: EXPECTED_KERNEL_INDEX_DESCRIPTORS[
        "pintpath_ops.reviewed_price_promotion_rows"
      ],
      internalForeignKeyTriggers: ROWS_FOREIGN_KEY_TRIGGER_DESCRIPTORS,
      internalTriggerCount: 2,
      nonInternalTriggers: 0,
      inheritanceEdges: 0,
      rewriteRules: 0,
      extensionDependencies: 0,
      publicationMemberships: 0,
      publicationNamespaceMemberships: 0,
      isPartition: false,
      accessMethod: "heap",
      tablespaceOid: "0",
      options: null,
      partitionBound: null,
      replicaIdentity: "d",
    },
  ];
  const functionSource = (owner: string) => (
    `BEGIN IF CURRENT_USER <> '${owner}' THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reviewed_price_promotion_kernel_owner_unsafe'; END IF; RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reviewed_price_promotion_kernel_disabled'; END`
  );
  const functions: SourceReadBoundaryKernelFunctionDescriptor[] = [
    ["apply_reviewed_price_promotion", SCOPED_ROLE_LABELS.applyOwner,
      SCOPED_ROLE_LABELS.applyExecute] as const,
    ["quarantine_reviewed_price_promotion", SCOPED_ROLE_LABELS.quarantineOwner,
      SCOPED_ROLE_LABELS.quarantineExecute] as const,
  ].map(([name, owner, execute]) => ({
    qualifiedName: `pintpath_ops.${name}`,
    owner,
    identityArguments: "request jsonb",
    resultType: "jsonb",
    argumentNames: ["request"],
    language: "plpgsql" as const,
    kind: "f" as const,
    securityDefiner: true as const,
    volatility: "v" as const,
    parallel: "u" as const,
    leakproof: false as const,
    strict: false as const,
    returnsSet: false as const,
    argumentDefaults: 0 as const,
    variadicTypeOid: "0" as const,
    supportFunctionOid: "0" as const,
    cost: 100 as const,
    rows: 0 as const,
    config: ["search_path=pg_catalog"] as const,
    source: functionSource(owner),
    acl: catalogAcl(owner, ["EXECUTE"], [[execute, "EXECUTE"]]),
    extensionDependencies: 0,
  }));
  const relationDependencies = relations.map((relation) => (
    `relation:${relation.qualifiedName}:a:0:t`
  ));
  const roleBase = {
    login: false as const, superuser: false as const, createDatabase: false as const,
    createRole: false as const, inherit: false as const, replication: false as const,
    bypassRls: false as const, connectionLimit: -1 as const, validUntil: null,
    membershipsGranted: [] as string[], membershipsReceived: [] as string[], settings: [] as string[],
  };
  const roles: SourceReadBoundaryRoleDescriptor[] = [
    {
      ...roleBase,
      role: SCOPED_ROLE_LABELS.backup,
      sharedDependencies: sortedCatalog([
        "schema:pintpath_app:a:0:t", "schema:pintpath_ops:a:0:t", ...relationDependencies,
      ], (entry) => entry),
    },
    {
      ...roleBase,
      role: SCOPED_ROLE_LABELS.applyExecute,
      sharedDependencies: sortedCatalog([
        "schema:pintpath_ops:a:0:t",
        "function:pintpath_ops.apply_reviewed_price_promotion(request jsonb):a:0:t",
      ], (entry) => entry),
    },
    {
      ...roleBase,
      role: SCOPED_ROLE_LABELS.applyOwner,
      sharedDependencies: [
        "function:pintpath_ops.apply_reviewed_price_promotion(request jsonb):o:0:t",
      ],
    },
    {
      ...roleBase,
      role: SCOPED_ROLE_LABELS.quarantineExecute,
      sharedDependencies: sortedCatalog([
        "schema:pintpath_ops:a:0:t",
        "function:pintpath_ops.quarantine_reviewed_price_promotion(request jsonb):a:0:t",
      ], (entry) => entry),
    },
    {
      ...roleBase,
      role: SCOPED_ROLE_LABELS.quarantineOwner,
      sharedDependencies: [
        "function:pintpath_ops.quarantine_reviewed_price_promotion(request jsonb):o:0:t",
      ],
    },
  ];
  return {
    kind: "pintpath-postgres-logical-state-source-read-boundary",
    version: 1,
    archiveMode: "data-only",
    schemaDefinitionAuthority: "checked-in-canonical-ddl-plus-inert-kernel",
    restorabilityVerification: "required-separate-cross-oid-scratch-restore",
    databaseOwner,
    schemas: [
      {
        schemaName: APPLICATION_SCHEMA,
        owner: databaseOwner,
        acl: catalogAcl(databaseOwner, ["CREATE", "USAGE"], [
          [SCOPED_ROLE_LABELS.backup, "USAGE"],
          ["pintpath_migrator", "USAGE"],
          ["pintpath_runtime", "USAGE"],
        ]),
      },
      {
        schemaName: OPERATIONS_SCHEMA,
        owner: databaseOwner,
        acl: catalogAcl(databaseOwner, ["CREATE", "USAGE"], [
          [SCOPED_ROLE_LABELS.backup, "USAGE"],
          [SCOPED_ROLE_LABELS.applyExecute, "USAGE"],
          [SCOPED_ROLE_LABELS.quarantineExecute, "USAGE"],
          ["pintpath_migrator", "USAGE"],
        ]),
      },
    ],
    relations,
    kernelTables,
    kernelFunctions: functions,
    roles,
    privateSequenceCount: 0,
    privateRelationPublicationCount: 0,
    privateSchemaPublicationCount: 0,
    allTablesPublicationCount: 0,
    privateRelationExtensionDependencyCount: 0,
  };
}

function sourceReadBoundaryHashProjection(
  descriptor: PostgresLogicalStateSourceReadBoundaryDescriptor,
): PostgresLogicalStateSourceReadBoundaryDescriptor {
  const databaseOwner = descriptor.databaseOwner;
  const projectedOwner = "$database_owner";
  const projectAcl = (
    acl: readonly SourceReadBoundaryAclDescriptor[],
  ): SourceReadBoundaryAclDescriptor[] => sortedCatalog(
    acl.map((entry) => ({
      ...entry,
      grantor: entry.grantor === databaseOwner ? projectedOwner : entry.grantor,
      grantee: entry.grantee === databaseOwner ? projectedOwner : entry.grantee,
    })),
    (entry) => `${entry.grantor}\0${entry.grantee}\0${entry.privilege}\0${entry.grantable}`,
  );
  return {
    ...descriptor,
    databaseOwner: projectedOwner,
    schemas: descriptor.schemas.map((schema) => ({
      ...schema,
      owner: schema.owner === databaseOwner ? projectedOwner : schema.owner,
      acl: projectAcl(schema.acl),
    })),
    relations: descriptor.relations.map((relation) => ({
      ...relation,
      owner: relation.owner === databaseOwner ? projectedOwner : relation.owner,
      acl: projectAcl(relation.acl),
    })),
  };
}

function exactDatabaseOid(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= 1n && parsed <= 4_294_967_295n;
}

function normalizeSourceReadBoundaryValue(
  value: unknown,
  databaseOid: string,
): unknown {
  const roleMap = new Map<string, string>([
    [`${BACKUP_ROLE_PREFIX}${databaseOid}`, SCOPED_ROLE_LABELS.backup],
    [`${POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.roles.applyOwner}${databaseOid}`,
      SCOPED_ROLE_LABELS.applyOwner],
    [`${POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.roles.applyExecute}${databaseOid}`,
      SCOPED_ROLE_LABELS.applyExecute],
    [`${POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.roles.quarantineOwner}${databaseOid}`,
      SCOPED_ROLE_LABELS.quarantineOwner],
    [`${POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.roles.quarantineExecute}${databaseOid}`,
      SCOPED_ROLE_LABELS.quarantineExecute],
  ]);
  const sourceMap = new Map<string, string>();
  for (const [rawOwner, label] of roleMap) {
    if (!rawOwner.includes("_owner_d")) continue;
    const rawSource = `BEGIN IF CURRENT_USER <> '${rawOwner}' THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reviewed_price_promotion_kernel_owner_unsafe'; END IF; RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reviewed_price_promotion_kernel_disabled'; END`;
    const normalizedSource = `BEGIN IF CURRENT_USER <> '${label}' THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reviewed_price_promotion_kernel_owner_unsafe'; END IF; RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reviewed_price_promotion_kernel_disabled'; END`;
    sourceMap.set(rawSource, normalizedSource);
  }
  const labels = new Set(Object.values(SCOPED_ROLE_LABELS));
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      if (labels.has(candidate as (typeof SCOPED_ROLE_LABELS)[keyof typeof SCOPED_ROLE_LABELS])) {
        throw new PostgresLogicalStateError("contract_invalid");
      }
      const normalizedRole = roleMap.get(candidate);
      const normalizedSource = sourceMap.get(candidate);
      if (normalizedRole) return normalizedRole;
      if (normalizedSource) return normalizedSource;
      if (SOURCE_READ_BOUNDARY_SCOPED_ROLE_PREFIXES.some(
        (prefix) => candidate.startsWith(prefix),
      )
          || candidate.includes("reviewed_price_promotion_kernel_owner_unsafe")) {
        throw new PostgresLogicalStateError("contract_invalid");
      }
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (!isPlainObject(candidate)) {
      if (candidate === null || typeof candidate === "boolean"
          || (typeof candidate === "number" && Number.isFinite(candidate))) return candidate;
      throw new PostgresLogicalStateError("contract_invalid");
    }
    return Object.fromEntries(Object.entries(candidate).map(([key, entry]) => [key, visit(entry)]));
  };
  const normalized = visit(value);
  if (!isPlainObject(normalized)) throw new PostgresLogicalStateError("contract_invalid");
  const sortAcl = (candidate: unknown): unknown => {
    if (!Array.isArray(candidate)) throw new PostgresLogicalStateError("contract_invalid");
    return sortedCatalog(candidate, (entry) => {
      if (!isPlainObject(entry)) throw new PostgresLogicalStateError("contract_invalid");
      return `${String(entry.grantor)}\0${String(entry.grantee)}\0${String(entry.privilege)}\0${String(entry.grantable)}`;
    });
  };
  for (const collectionName of ["schemas", "relations", "kernelFunctions"] as const) {
    const collection = normalized[collectionName];
    if (!Array.isArray(collection)) throw new PostgresLogicalStateError("contract_invalid");
    for (const entry of collection) {
      if (!isPlainObject(entry)) throw new PostgresLogicalStateError("contract_invalid");
      entry.acl = sortAcl(entry.acl);
      if (collectionName === "relations") {
        const policies = entry.policies;
        if (!Array.isArray(policies)) throw new PostgresLogicalStateError("contract_invalid");
        const sortedPolicies = sortedCatalog(policies, (policy) => {
          if (!isPlainObject(policy)) throw new PostgresLogicalStateError("contract_invalid");
          return String(policy.name);
        });
        entry.policies = sortedPolicies;
        for (const policy of sortedPolicies) {
          if (!isPlainObject(policy) || !Array.isArray(policy.roles)) {
            throw new PostgresLogicalStateError("contract_invalid");
          }
          policy.roles = sortedCatalog(policy.roles, (role) => String(role));
        }
      }
    }
  }
  const roles = normalized.roles;
  if (!Array.isArray(roles)) throw new PostgresLogicalStateError("contract_invalid");
  const sortedRoles = sortedCatalog(roles, (role) => {
    if (!isPlainObject(role)) throw new PostgresLogicalStateError("contract_invalid");
    return String(role.role);
  });
  normalized.roles = sortedRoles;
  for (const role of sortedRoles) {
    if (!isPlainObject(role)) throw new PostgresLogicalStateError("contract_invalid");
    for (const field of [
      "membershipsGranted", "membershipsReceived", "settings", "sharedDependencies",
    ]) {
      if (!Array.isArray(role[field])) throw new PostgresLogicalStateError("contract_invalid");
      role[field] = sortedCatalog(role[field], (entry) => String(entry));
    }
  }
  return normalized;
}

async function verifyPostgresLogicalStateSourceReadBoundary(
  connection: PostgresLogicalStateConnection,
): Promise<{
  readonly databaseOid: string;
  readonly physicalReadBoundarySha256: string;
  readonly sourceReadBoundarySha256: string;
}> {
  let result: PostgresLogicalStateQueryResult<SourceReadBoundaryRow>;
  try {
    result = await connection.query<SourceReadBoundaryRow>(SOURCE_READ_BOUNDARY_SQL);
  } catch {
    throw new PostgresLogicalStateError("contract_invalid");
  }
  const row = result.rows[0];
  let descriptor: unknown;
  if (typeof row?.descriptorJson === "string"
      && Buffer.byteLength(row.descriptorJson, "utf8") <= MAX_V2_BOUNDARY_BYTES) {
    try {
      descriptor = JSON.parse(row.descriptorJson);
    } catch {
      throw new PostgresLogicalStateError("contract_invalid");
    }
  }
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: descriptor, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_V2_BOUNDARY_NODES || entry.depth > MAX_V2_BOUNDARY_DEPTH) {
      throw new PostgresLogicalStateError("contract_invalid");
    }
    if (Array.isArray(entry.value)) {
      for (const child of entry.value) pending.push({ value: child, depth: entry.depth + 1 });
    } else if (isPlainObject(entry.value)) {
      for (const child of Object.values(entry.value)) {
        pending.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
  if (result.rows.length !== 1 || result.rowCount !== 1 || !row
      || !exactDatabaseOid(row.databaseOid) || !isPlainObject(descriptor)
      || typeof descriptor.databaseOwner !== "string"
      || !safeSourceReadBoundaryDatabaseOwner(descriptor.databaseOwner)) {
    throw new PostgresLogicalStateError("contract_invalid");
  }
  const portable = normalizeSourceReadBoundaryValue(descriptor, row.databaseOid);
  const expected = expectedSourceReadBoundaryDescriptor(descriptor.databaseOwner);
  if (canonicalPostgresLogicalStateJson(portable)
      !== canonicalPostgresLogicalStateJson(expected)) {
    throw new PostgresLogicalStateError("contract_invalid");
  }
  return {
    databaseOid: row.databaseOid,
    physicalReadBoundarySha256: sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-state-physical-source-read-boundary",
      version: 1,
      databaseOid: row.databaseOid,
      descriptor,
    }),
    sourceReadBoundarySha256: sha256CanonicalPostgresLogicalState(
      sourceReadBoundaryHashProjection(expected),
    ),
  };
}

export const POSTGRES_LOGICAL_STATE_KERNEL_CONTRACT_SHA256 =
  sha256CanonicalPostgresLogicalState(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT);

const V2_SESSION_PREFLIGHT_SQL = `/* pintpath:logical-state:v2:session-preflight */
  SELECT (pg_catalog.current_schemas(true))[1]::pg_catalog.text AS "firstSchema",
         pg_catalog.pg_backend_pid() AS "backendPid",
         CURRENT_USER::pg_catalog.text AS "currentUser",
         SESSION_USER::pg_catalog.text AS "sessionUser",
         pg_catalog.current_setting('transaction_isolation') AS "transactionIsolation",
         pg_catalog.current_setting('transaction_read_only') AS "transactionReadOnly",
         pg_catalog.current_setting('server_version_num') AS "serverVersionNum",
         pg_catalog.pg_current_xact_id()::pg_catalog.text AS "transactionId"`;

async function verifyPostgresLogicalStateV2Session(
  connection: PostgresLogicalStateV2Connection,
  expected?: V2SessionBinding,
): Promise<V2SessionBinding> {
  if (!Number.isSafeInteger(connection.processID) || connection.processID < 1) {
    throw new PostgresLogicalStateError("contract_invalid");
  }
  let result: PostgresLogicalStateQueryResult<SearchPathRow>;
  try {
    result = await connection.query<SearchPathRow>(V2_SESSION_PREFLIGHT_SQL);
  } catch {
    throw new PostgresLogicalStateError("contract_invalid");
  }
  const row = result.rows[0];
  if (
    result.rows.length !== 1 || result.rowCount !== 1 || !row
    || row.backendPid !== connection.processID
    || typeof row.currentUser !== "string" || row.currentUser.length < 1
    || typeof row.sessionUser !== "string" || row.sessionUser.length < 1
    || /[\r\n\0]/.test(row.currentUser) || /[\r\n\0]/.test(row.sessionUser)
    || row.transactionIsolation !== "repeatable read"
    || row.transactionReadOnly !== "on"
    || !/^17\d{4}$/.test(row.serverVersionNum)
    || !/^(?:0|[1-9]\d*)$/.test(row.transactionId)
    || (expected !== undefined && (
      row.transactionId !== expected.transactionId
      || row.currentUser !== expected.currentUser
      || row.sessionUser !== expected.sessionUser
    ))
    || row.firstSchema !== "pg_catalog"
  ) throw new PostgresLogicalStateError("contract_invalid");
  return {
    transactionId: row.transactionId,
    currentUser: row.currentUser,
    sessionUser: row.sessionUser,
  };
}

async function lockPostgresLogicalStateV2Relations(
  connection: PostgresLogicalStateConnection,
): Promise<void> {
  try {
    await connection.query(V2_RELATION_LOCK_SQL);
  } catch {
    throw new PostgresLogicalStateError("contract_invalid");
  }
}

async function readExactOwnRowCountV2(
  connection: PostgresLogicalStateConnection,
  schemaName: typeof APPLICATION_SCHEMA | typeof OPERATIONS_SCHEMA,
  tableName: string,
  expectedSession: V2SessionBinding,
): Promise<bigint> {
  let result: PostgresLogicalStateQueryResult<OwnRowCountRow>;
  try {
    result = await connection.query<OwnRowCountRow>(
      `/* pintpath:logical-state:v2:own-row-count:${schemaName}:${tableName} */
       SELECT pg_catalog.count(*)::pg_catalog.text AS "rowCount",
              CURRENT_USER::pg_catalog.text AS "currentUser",
              SESSION_USER::pg_catalog.text AS "sessionUser"
       FROM ONLY ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`,
    );
  } catch {
    throw new PostgresLogicalStateError("state_invalid");
  }
  const rowCount = result.rows[0]?.rowCount;
  if (
    result.rows.length !== 1
    || result.rowCount !== 1
    || typeof rowCount !== "string"
    || !/^(?:0|[1-9]\d{0,18})$/.test(rowCount)
    || result.rows[0]?.currentUser !== expectedSession.currentUser
    || result.rows[0]?.sessionUser !== expectedSession.sessionUser
  ) throw new PostgresLogicalStateError("state_invalid");
  const parsed = BigInt(rowCount);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new PostgresLogicalStateError("state_invalid");
  }
  return parsed;
}

async function verifyPostgresLogicalStateContractForControls(
  connection: PostgresLogicalStateConnection,
  controls: readonly ArchivedControlContract[],
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
    controlColumns = controls === ARCHIVED_CONTROL_CONTRACT
      ? await connection.query<ControlColumnRow>(`/* pintpath:logical-state:control-columns */
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
      ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", attribute.attnum`)
      : await connection.query<ControlColumnRow>(`/* pintpath:logical-state:control-columns */
      SELECT namespace.nspname AS "schemaName", relation.relname AS "tableName",
             attribute.attname AS "columnName",
             pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS "dataType",
             NOT attribute.attnotnull AS nullable,
             attribute.attnum::integer AS ordinal
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
              = ANY($1::text[])
        AND relation.relkind IN ('r', 'p')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", attribute.attnum`, [
        controls.map((control) => `${control.schemaName}.${control.table.name}`),
      ]);
    controlPrimaryKeys = controls === ARCHIVED_CONTROL_CONTRACT
      ? await connection.query<ControlPrimaryKeyRow>(`/* pintpath:logical-state:control-primary-keys */
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
      ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", key_ordinal.ordinality`)
      : await connection.query<ControlPrimaryKeyRow>(`/* pintpath:logical-state:control-primary-keys */
      SELECT namespace.nspname AS "schemaName", relation.relname AS "tableName",
             attribute.attname AS "columnName",
             key_ordinal.ordinality::integer AS "primaryKeyPosition"
      FROM pg_catalog.pg_constraint AS constraint_record
      JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key_ordinal(attnum, ordinality)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid AND attribute.attnum = key_ordinal.attnum
      WHERE pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
              = ANY($1::text[])
        AND constraint_record.contype = 'p'
      ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", key_ordinal.ordinality`, [
        controls.map((control) => `${control.schemaName}.${control.table.name}`),
      ]);
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
  const expectedControlColumns = controls.flatMap((control) => (
    control.table.columns.map((column, index) => ({
      schemaName: control.schemaName,
      tableName: control.table.name,
      columnName: column[0],
      dataType: control.postgresTypes[index],
      nullable: column[3],
      ordinal: index + 1,
    }))
  ));
  const expectedControlPrimaryKeys = controls.flatMap((control) => (
    control.table.columns.filter((column) => column[4] > 0).map((column) => ({
      schemaName: control.schemaName,
      tableName: control.table.name,
      columnName: column[0],
      primaryKeyPosition: column[4],
    }))
  ));
  if (
    JSON.stringify(applicationTables) !== JSON.stringify(expectedApplicationTables)
    || JSON.stringify(operationsTables) !== JSON.stringify(
      controls.filter((control) => control.schemaName === OPERATIONS_SCHEMA)
        .map((control) => control.table.name).sort(),
    )
    || !count
    || count.columnCount !== String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns)
    || count.foreignKeyCount !== String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys)
    || count.rowSecurityTableCount
      !== String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + controls.length)
    || JSON.stringify(actualPrimaryKeys) !== JSON.stringify(expectedPrimaryKeys)
    || JSON.stringify(authoritativeColumns.rows) !== JSON.stringify(expectedAuthoritativeColumns)
    || JSON.stringify(controlColumns.rows) !== JSON.stringify(expectedControlColumns)
    || JSON.stringify(controlPrimaryKeys.rows) !== JSON.stringify(expectedControlPrimaryKeys)
    || apiExposure.rows.length !== 1
    || apiExposure.rows[0]?.unsafe !== false
  ) throw new PostgresLogicalStateError("contract_invalid");
  return metadataBindings(metadata.rows);
}

export async function verifyPostgresLogicalStateContract(
  connection: PostgresLogicalStateConnection,
): Promise<ReturnType<typeof metadataBindings>> {
  return verifyPostgresLogicalStateContractForControls(connection, ARCHIVED_CONTROL_CONTRACT);
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
    const keys = primaryKeyColumns(table as LogicalStateTableContract);
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
          pageSql(table as LogicalStateTableContract, cursor !== null, APPLICATION_SCHEMA),
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
        const encodedRow = canonicalRow(table as LogicalStateTableContract, row);
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
    const keys = primaryKeyColumns(table as LogicalStateTableContract);
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
          pageSql(table as LogicalStateTableContract, cursor !== null, schemaName),
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

async function captureLogicalStateTablesV2(
  connection: PostgresLogicalStateConnection,
  pageRows: number,
  contractSha256: string,
  sessionBinding: V2SessionBinding,
): Promise<{
  readonly tables: readonly PostgresLogicalStateTableReceipt[];
  readonly authoritativeRowCount: bigint;
  readonly nonEmptyAuthoritativeTableCount: number;
  readonly tableSetSha256: string;
  readonly transformedDataSha256: string;
  readonly keyRangesSha256: string;
  readonly stateTotalsSha256: string;
}> {
  const tableSetHash = crypto.createHash("sha256");
  const transformedDataHash = crypto.createHash("sha256");
  const keyRangesHash = crypto.createHash("sha256");
  const stateTotalsHash = crypto.createHash("sha256");
  const totals = new Map<string, bigint>();
  updateLengthFramed(tableSetHash, "pint-path-postgres-table-set-v2");
  updateLengthFramed(transformedDataHash, "pint-path-postgres-transformed-data-v2");
  updateLengthFramed(keyRangesHash, "pint-path-postgres-logical-key-ranges-v2");
  const receipts: PostgresLogicalStateTableReceipt[] = [];
  let authoritativeRowCount = 0n;
  let nonEmptyAuthoritativeTableCount = 0;
  for (const sourceTable of POSTGRES_MIGRATION_CONTRACT.tables) {
    const table = sourceTable as LogicalStateTableContract;
    const keys = primaryKeyColumns(table);
    const tableHash = crypto.createHash("sha256");
    updateLengthFramed(tableHash, "pint-path-postgres-transformed-table-v2");
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
          pageSqlV2(table, cursor !== null, APPLICATION_SCHEMA),
          cursor === null ? [pageRows] : [...cursor, pageRows],
        );
      } catch {
        throw new PostgresLogicalStateError("state_invalid");
      }
      if (result.rows.length > pageRows) throw new PostgresLogicalStateError("state_invalid");
      for (const row of result.rows) {
        const values = keys.map((column) => row[column[0]]);
        if (values.some((value) => typeof value !== "string")) {
          throw new PostgresLogicalStateError("state_invalid");
        }
        const keyValues = values as string[];
        if (cursor && compareKey(keyValues, cursor, keys) <= 0) {
          throw new PostgresLogicalStateError("state_invalid");
        }
        const keySha = canonicalPrimaryKey(
          keyValues, keys, "pint-path-source-primary-key-v2",
        ).toString("hex");
        firstPrimaryKeySha256 ??= keySha;
        lastPrimaryKeySha256 = keySha;
        updateLengthFramed(tableHash, canonicalRow(
          table, row, "pint-path-postgres-transformed-row-v2",
        ));
        for (const column of table.columns.filter(stateColumn)) {
          const valueDigest = sha256PostgresMigrationBytes(
            canonicalNativeValue(row[column[0]], column),
          );
          const totalKey = `${table.name}\0${column[0]}\0${valueDigest}`;
          if (!totals.has(totalKey) && totals.size >= MAX_STATE_TOTAL_BUCKETS) {
            throw new PostgresLogicalStateError("state_invalid");
          }
          totals.set(totalKey, (totals.get(totalKey) ?? 0n) + 1n);
        }
        cursor = keyValues;
        rowCount += 1n;
      }
      if (result.rows.length < pageRows) break;
      if (result.rows.length === 0 || cursor === null) {
        throw new PostgresLogicalStateError("state_invalid");
      }
    }
    if (await readExactOwnRowCountV2(
      connection, APPLICATION_SCHEMA, table.name, sessionBinding,
    ) !== rowCount) {
      throw new PostgresLogicalStateError("state_invalid");
    }
    const transformedSha256 = tableHash.digest("hex");
    receipts.push({
      tableName: table.name,
      columnCount: table.columns.length,
      rowCount: rowCount.toString(),
      transformedSha256,
      firstPrimaryKeySha256,
      lastPrimaryKeySha256,
    });
    authoritativeRowCount += rowCount;
    if (rowCount > 0n) nonEmptyAuthoritativeTableCount += 1;
    for (const hash of [tableSetHash]) {
      updateLengthFramed(hash, table.name);
      updateLengthFramed(hash, rowCount.toString());
    }
    updateLengthFramed(transformedDataHash, table.name);
    updateLengthFramed(transformedDataHash, transformedSha256);
    updateLengthFramed(keyRangesHash, table.name);
    updateLengthFramed(keyRangesHash, rowCount.toString());
    updateLengthFramed(keyRangesHash, firstPrimaryKeySha256 ?? "");
    updateLengthFramed(keyRangesHash, lastPrimaryKeySha256 ?? "");
  }
  updateLengthFramed(stateTotalsHash, "pint-path-postgres-state-totals-v2");
  for (const [key, count] of sortedCatalog([...totals], ([key]) => key)) {
    updateLengthFramed(stateTotalsHash, key);
    updateLengthFramed(stateTotalsHash, count.toString());
  }
  return {
    tables: receipts,
    authoritativeRowCount,
    nonEmptyAuthoritativeTableCount,
    tableSetSha256: tableSetHash.digest("hex"),
    transformedDataSha256: transformedDataHash.digest("hex"),
    keyRangesSha256: keyRangesHash.digest("hex"),
    stateTotalsSha256: stateTotalsHash.digest("hex"),
  };
}

async function captureLogicalControlTablesV2(
  connection: PostgresLogicalStateConnection,
  pageRows: number,
  contractSha256: string,
  sessionBinding: V2SessionBinding,
): Promise<{
  readonly tables: readonly PostgresLogicalStateTableReceipt[];
  readonly rowCount: bigint;
  readonly tableSetSha256: string;
  readonly dataSha256: string;
  readonly keyRangesSha256: string;
}> {
  const tableSetHash = crypto.createHash("sha256");
  const dataHash = crypto.createHash("sha256");
  const keyRangesHash = crypto.createHash("sha256");
  updateLengthFramed(tableSetHash, "pintpath-postgres-logical-control-table-set-v2");
  updateLengthFramed(dataHash, "pintpath-postgres-logical-control-data-v2");
  updateLengthFramed(keyRangesHash, "pintpath-postgres-logical-control-key-ranges-v2");
  const receipts: PostgresLogicalStateTableReceipt[] = [];
  let controlRowCount = 0n;
  for (const control of ARCHIVED_CONTROL_CONTRACT_V2) {
    const table = control.table as LogicalStateTableContract;
    const qualifiedName = `${control.schemaName}.${table.name}`;
    const requiredRowCount = requiredKernelControlRowCount(qualifiedName);
    const keys = primaryKeyColumns(table);
    const keyKinds = keys.map((column) => keyKindForColumn(table, column));
    const tableHash = crypto.createHash("sha256");
    updateLengthFramed(tableHash, "pintpath-postgres-logical-control-table-v2");
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
          pageSqlV2(table, cursor !== null, control.schemaName),
          cursor === null ? [pageRows] : [...cursor, pageRows],
        );
      } catch {
        throw new PostgresLogicalStateError("state_invalid");
      }
      if (result.rows.length > pageRows) throw new PostgresLogicalStateError("state_invalid");
      if (requiredRowCount === "0" && result.rows.length > 0) {
        throw new PostgresLogicalStateError("contract_invalid");
      }
      for (const row of result.rows) {
        const values = keys.map((column) => row[column[0]]);
        if (values.some((value) => typeof value !== "string")) {
          throw new PostgresLogicalStateError("state_invalid");
        }
        const keyValues = values as string[];
        if (cursor && compareKey(keyValues, cursor, keys, keyKinds) <= 0) {
          throw new PostgresLogicalStateError("state_invalid");
        }
        const keySha = canonicalPrimaryKey(
          keyValues, keys, "pint-path-source-primary-key-v2", keyKinds,
        ).toString("hex");
        firstPrimaryKeySha256 ??= keySha;
        lastPrimaryKeySha256 = keySha;
        const rowHash = crypto.createHash("sha256");
        updateLengthFramed(rowHash, "pintpath-postgres-logical-control-row-v2");
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
    if (await readExactOwnRowCountV2(
      connection, control.schemaName, table.name, sessionBinding,
    ) !== rowCount) {
      throw new PostgresLogicalStateError("state_invalid");
    }
    const transformedSha256 = tableHash.digest("hex");
    if (requiredRowCount !== null && rowCount.toString() !== requiredRowCount) {
      throw new PostgresLogicalStateError("contract_invalid");
    }
    receipts.push({
      tableName: qualifiedName,
      columnCount: table.columns.length,
      rowCount: rowCount.toString(),
      transformedSha256,
      firstPrimaryKeySha256,
      lastPrimaryKeySha256,
    });
    controlRowCount += rowCount;
    updateLengthFramed(tableSetHash, qualifiedName);
    updateLengthFramed(tableSetHash, rowCount.toString());
    updateLengthFramed(dataHash, qualifiedName);
    updateLengthFramed(dataHash, transformedSha256);
    updateLengthFramed(keyRangesHash, qualifiedName);
    updateLengthFramed(keyRangesHash, rowCount.toString());
    updateLengthFramed(keyRangesHash, firstPrimaryKeySha256 ?? "");
    updateLengthFramed(keyRangesHash, lastPrimaryKeySha256 ?? "");
  }
  return {
    tables: receipts,
    rowCount: controlRowCount,
    tableSetSha256: tableSetHash.digest("hex"),
    dataSha256: dataHash.digest("hex"),
    keyRangesSha256: keyRangesHash.digest("hex"),
  };
}

export async function capturePostgresLogicalStateV2(
  connection: PostgresLogicalStateV2Connection,
  options: { readonly pageRows?: number } = {},
): Promise<PostgresLogicalStateCaptureV2> {
  const pageRows = normalizePageSize(options.pageRows);
  // This must be the first snapshot-relevant operation on the dedicated
  // transaction. It blocks catalog/relcache DDL races for every row source.
  await lockPostgresLogicalStateV2Relations(connection);
  // PostgreSQL rejects this isolation-level toggle if any earlier command in
  // the transaction acquired a snapshot. LOCK itself is permitted, so this
  // proves the locks preceded the capture snapshot without trusting a driver.
  try {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY, NOT DEFERRABLE",
    );
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY, NOT DEFERRABLE",
    );
  } catch {
    throw new PostgresLogicalStateError("contract_invalid");
  }
  const sessionBinding = await verifyPostgresLogicalStateV2Session(connection);
  const catalog = await verifyPostgresLogicalStateSourceReadBoundary(connection);
  if (sessionBinding.currentUser !== `${BACKUP_ROLE_PREFIX}${catalog.databaseOid}`) {
    throw new PostgresLogicalStateError("contract_invalid");
  }
  const bindings = await verifyPostgresLogicalStateContractForControls(
    connection, ARCHIVED_CONTROL_CONTRACT_V2,
  );
  const authoritative = await captureLogicalStateTablesV2(
    connection, pageRows, bindings.migrationContractSha256, sessionBinding,
  );
  const controls = await captureLogicalControlTablesV2(
    connection, pageRows, bindings.migrationContractSha256, sessionBinding,
  );
  const v2Bindings = {
    ...bindings,
    schemaMetadataSha256: sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-schema-metadata",
      version: 2,
      v1SchemaMetadataSha256: bindings.schemaMetadataSha256,
    }),
  };
  const withoutOverall: Omit<PostgresLogicalStateInventoryV2, "overallStateSha256"> = {
    authoritativeTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
    authoritativeColumnCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns,
    authoritativeRowCount: authoritative.authoritativeRowCount.toString(),
    nonEmptyAuthoritativeTableCount: authoritative.nonEmptyAuthoritativeTableCount,
    zeroRowAuthoritativeTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
      - authoritative.nonEmptyAuthoritativeTableCount,
    ...v2Bindings,
    kernelContractSha256: POSTGRES_LOGICAL_STATE_KERNEL_CONTRACT_SHA256,
    kernelMigrationSha256: POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256,
    sourceReadBoundarySha256: catalog.sourceReadBoundarySha256,
    tableSetSha256: authoritative.tableSetSha256,
    transformedDataSha256: authoritative.transformedDataSha256,
    keyRangesSha256: authoritative.keyRangesSha256,
    stateTotalsSha256: authoritative.stateTotalsSha256,
    controlTableCount: 5,
    controlRowCount: controls.rowCount.toString(),
    controlTableSetSha256: controls.tableSetSha256,
    controlDataSha256: controls.dataSha256,
    controlKeyRangesSha256: controls.keyRangesSha256,
    tables: authoritative.tables,
    controlTables: controls.tables,
  };
  const inventory: PostgresLogicalStateInventoryV2 = {
    ...withoutOverall,
    overallStateSha256: sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-state-inventory",
      version: 2,
      ...withoutOverall,
    }),
  };
  await verifyPostgresLogicalStateV2Session(connection, sessionBinding);
  return {
    inventory,
    sourceDatabaseOid: catalog.databaseOid,
    sourcePhysicalReadBoundarySha256: catalog.physicalReadBoundarySha256,
  };
}

export async function computePostgresLogicalStateInventoryV2(
  connection: PostgresLogicalStateV2Connection,
  options: { readonly pageRows?: number } = {},
): Promise<PostgresLogicalStateInventoryV2> {
  return (await capturePostgresLogicalStateV2(connection, options)).inventory;
}

function compareKey(
  left: readonly string[],
  right: readonly string[],
  columns: readonly LogicalStateColumnContract[],
  keyKinds?: readonly LogicalStateKeyKind[],
): number {
  if (left.length !== right.length || left.length !== columns.length) {
    throw new PostgresLogicalStateError("state_invalid");
  }
  for (let index = 0; index < left.length; index += 1) {
    const column = columns[index]!;
    const keyKind = keyKinds?.[index] ?? (column[1] === "INTEGER" ? "integer" : "text");
    const comparison = keyKind === "text"
      ? Buffer.compare(Buffer.from(left[index]!, "utf8"), Buffer.from(right[index]!, "utf8"))
      : keyKind === "uuid"
        ? Buffer.compare(uuidBytes(left[index]!), uuidBytes(right[index]!))
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

function requiredKernelControlRowCount(
  qualifiedName: string,
): string | null {
  for (const table of Object.values(
    POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables,
  )) {
    if (table.qualifiedName === qualifiedName) return String(table.requiredRowCount);
  }
  return null;
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

export function exactPostgresLogicalStateMatchV2(
  expected: PostgresLogicalStateInventoryV2,
  actual: PostgresLogicalStateInventoryV2,
): boolean {
  return canonicalPostgresLogicalStateJson(expected) === canonicalPostgresLogicalStateJson(actual);
}

export const postgresLogicalStateInternals = {
  canonicalNativeValue,
  canonicalPrimaryKey,
  canonicalRow,
  compareKey,
  expectedSourceReadBoundaryDescriptor,
  normalizeSourceReadBoundaryValue,
  sourceReadBoundaryHashProjection,
  sourceReadBoundarySql: SOURCE_READ_BOUNDARY_SQL,
  pageSql,
  pageSqlV2,
  v2RelationLockSql: V2_RELATION_LOCK_SQL,
  validateStateInventory,
};
