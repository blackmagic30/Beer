import crypto from "node:crypto";

import { POSTGRES_MIGRATION_CONTRACT } from "../db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../db/postgres-migration-schema.js";
import {
  canonicalPostgresLogicalStateJson,
  POSTGRES_LOGICAL_STATE_KERNEL_CONTRACT_SHA256,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalStateCaptureV2,
  type PostgresLogicalStateInventoryV2,
  type PostgresLogicalStateTableReceipt,
} from "./postgres-logical-state.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_FILE,
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256,
} from "./postgres-reviewed-price-promotion-kernel.js";
import {
  POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
  type PostgresLogicalBackupV4TableDataDescriptor,
} from "./postgres-logical-backup-v4-table-data-contract.js";

export {
  POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
  type PostgresLogicalBackupV4TableDataDescriptor,
} from "./postgres-logical-backup-v4-table-data-contract.js";

export const POSTGRES_LOGICAL_BACKUP_V4_CAPABILITY = Object.freeze({
  implementationState: "OFFLINE_CONTRACT_ONLY",
  artifactEmissionImplemented: false,
  sourceSnapshotExportImplemented: false,
  sourceRoleProfileImplemented: false,
  restoreImplemented: false,
  productionCutoverAuthorized: false,
} as const);

export const POSTGRES_LOGICAL_BACKUP_V4_BASE_DDL_FILE =
  "src/db/postgres-schema.sql" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_BASE_DDL_SHA256 =
  "10973ed4a9d44b6ee9724b8ccb85a932f49b7b1bfe1b8c9e93710efd2fd16e94" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_MIGRATION_CONTRACT_SHA256 =
  "78f49d0af57a19f92154f717c3b5c9c7e3bdc02bbda68809a8f2257bf7ef879d" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_KERNEL_CONTRACT_SHA256 =
  "a70f287a9862b485b0868b32d0be6c9b3a150a3262169a19b0676700bb31dc8b" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_FILE =
  "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_SHA256 =
  "329308dda329342387db8d6ab0cabab4ba87e16a174eb843aa6b54108a995bb1" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_PORTABLE_BOUNDARY_SHA256 =
  "26b6b1346c15465ce538ac9769d435cd02c50bb138f8c73095ef5ff132506cf8" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_ARCHIVE_FILE = "pintpath-postgres.dump" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_MAX_MANIFEST_BYTES = 256 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATABASE_OID_PATTERN = /^(?:[1-9][0-9]{0,9})$/;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){0,3}(?:[-+._a-zA-Z0-9 ()~:]{0,96})$/;
const CANONICAL_COUNT_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
const MAX_SIGNED_INT8 = 9_223_372_036_854_775_807n;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4096;
const MAX_TOOL_VERSION_BYTES = 128;

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

const V4_MIGRATION_CONTRACT = deepFreeze(structuredClone(POSTGRES_MIGRATION_CONTRACT));
const MIGRATION_CONTRACT_SHA256 = sha256PostgresMigrationContract(V4_MIGRATION_CONTRACT);
const COMPUTED_TABLE_DATA_SET_SHA256 = sha256CanonicalPostgresLogicalState({
  kind: "pintpath-postgres-logical-backup-table-data-set",
  version: 1,
  entries: POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
});

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export const POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS = Object.freeze([
  "--format=custom",
  "--data-only",
  "--no-large-objects",
  "--no-password",
  "--lock-wait-timeout=30s",
  "--no-owner",
  "--no-acl",
  "--enable-row-security",
  "--strict-names",
  ...POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.map(
    (entry) => `--table=${entry.schemaName}.${entry.tableName}`,
  ),
] as const);

export const POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_SCRATCH_RESTORE_OPTIONS = Object.freeze([
  "--data-only",
  "--disable-triggers",
  "--single-transaction",
  "--exit-on-error",
  "--no-password",
  "--no-owner",
  "--no-acl",
] as const);

const CONTROL_TABLES = Object.freeze([
  Object.freeze({
    qualifiedName: "pintpath_app.schema_metadata",
    columns: Object.freeze(["key", "value", "updated_at"]),
  }),
  Object.freeze({
    qualifiedName: "pintpath_ops.migration_chunks",
    columns: Object.freeze([
      "run_id", "table_name", "chunk_ordinal", "row_count",
      "source_transformed_sha256", "target_sha256", "completed_at",
    ]),
  }),
  Object.freeze({
    qualifiedName: "pintpath_ops.migration_runs",
    columns: Object.freeze([
      "run_id", "source_snapshot_sha256", "source_schema_fingerprint",
      "contract_sha256", "manifest_sha256", "target_ddl_sha256",
      "source_schema_version", "candidate_commit_sha", "target_binding_sha256",
      "expected_environment", "approval_reference_sha256", "operator_id_sha256",
      "verifier_id_sha256", "status", "started_at", "completed_at",
      "receipt_sha256", "failure_code",
    ]),
  }),
  Object.freeze({
    qualifiedName: "pintpath_ops.reviewed_price_promotion_operations",
    columns: Object.freeze([
      "operation_id", "operation_kind", "source_apply_operation_id", "candidate_sha",
      "expected_environment", "authority_bundle_sha256", "plan_candidate_sha256",
      "review_packet_candidate_sha256", "target_physical_identity_sha256",
      "source_snapshot_sha256", "request_sha256", "requested_row_count", "committed_at",
      "result_state_sha256", "receipt_sha256",
    ]),
  }),
  Object.freeze({
    qualifiedName: "pintpath_ops.reviewed_price_promotion_rows",
    columns: Object.freeze([
      "operation_id", "row_ordinal", "source_ingestion_id", "venue_id",
      "price_record_id", "venue_beer_id", "normalized_beer_id", "row_request_sha256",
      "before_state_sha256", "after_state_sha256", "row_receipt_sha256",
    ]),
  }),
]);

export interface PostgresLogicalBackupV4ToolIdentity {
  readonly name: "pg_dump" | "pg_restore";
  readonly version: string;
  readonly major: 17;
  readonly executableSha256: string;
}

export interface PostgresLogicalBackupV4TocEvidence {
  readonly tocEntries: 63;
  readonly listedEntries: 59;
  readonly tableDataEntries: 59;
  readonly tableDataSetSha256: string;
  readonly entries: readonly PostgresLogicalBackupV4TableDataDescriptor[];
}

export interface PostgresLogicalBackupManifestV4 {
  readonly schemaVersion: 4;
  readonly kind: "pintpath-postgres-logical-backup";
  readonly createdAt: string;
  readonly archive: {
    readonly file: typeof POSTGRES_LOGICAL_BACKUP_V4_ARCHIVE_FILE;
    readonly format: "custom";
    readonly mode: "data-only";
    readonly bytes: number;
    readonly sha256: string;
    readonly listingSha256: string;
    readonly toc: PostgresLogicalBackupV4TocEvidence;
    readonly archiveRowCount: string;
    readonly tableDataStateSha256: string;
    readonly requiredDumpArguments: readonly string[];
    readonly requiredDynamicDumpArgumentBindings: {
      readonly profile: "source-authority-receipt-bound-pg-dump-arguments-v1";
      readonly roleArgument: string;
      readonly snapshotArgumentTemplate: "--snapshot=<authenticated-exported-snapshot>";
      readonly exportedSnapshotBindingSha256: string;
      readonly requiresExactSnapshotArgumentReceiptVerification: true;
    };
    readonly requiredScratchRestoreOptions: readonly string[];
  };
  readonly tools: {
    readonly pgDump: PostgresLogicalBackupV4ToolIdentity;
    readonly pgRestore: PostgresLogicalBackupV4ToolIdentity;
  };
  readonly transport: {
    readonly profile: "railway-stock-localhost-ca-v1";
    readonly rootCaCertificateSha256: string;
  };
  readonly sourceAuthority: {
    readonly profile: "detached-effective-role-snapshot-handoff-pg17-v1";
    readonly databaseIdentitySha256: string;
    readonly sourceUrlSha256: string;
    readonly exportedSnapshotBindingSha256: string;
    readonly sourceAuthorityReceiptSha256: string;
  };
  readonly schemaAuthority: {
    readonly profile: "checked-in-canonical-ddl-plus-inert-kernel";
    readonly baseDdlFile: typeof POSTGRES_LOGICAL_BACKUP_V4_BASE_DDL_FILE;
    readonly baseDdlSha256: string;
    readonly migrationContractSha256: string;
    readonly kernelMigrationFile: typeof POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_FILE;
    readonly kernelMigrationSha256: string;
    readonly kernelContractSha256: string;
    readonly sourceReadBoundarySha256: string;
  };
  readonly sourceCapture: {
    readonly captureSha256: string;
    readonly capture: PostgresLogicalStateCaptureV2;
  };
  readonly pairing: {
    readonly captureSha256: string;
    readonly databaseIdentitySha256: string;
    readonly sourceUrlSha256: string;
    readonly exportedSnapshotBindingSha256: string;
    readonly sourceAuthorityReceiptSha256: string;
    readonly sourceDatabaseOid: string;
    readonly sourcePhysicalReadBoundarySha256: string;
    readonly sourceReadBoundarySha256: string;
    readonly sourceOverallStateSha256: string;
    readonly archiveSha256: string;
    readonly listingSha256: string;
    readonly tableDataSetSha256: string;
    readonly tableDataStateSha256: string;
    readonly archiveRowCount: string;
    readonly pairingSha256: string;
  };
  readonly verificationRequirements: {
    readonly profile: "different-oid-canonical-schema-scratch-restore-v1";
    readonly requiresDifferentDatabaseOid: true;
    readonly requiresExactTableDataToc: true;
    readonly requiresExactTargetV2InventoryMatch: true;
    readonly requiresFreshTargetPhysicalReadBoundaryVerification: true;
    readonly requiresSameExportedSnapshot: true;
    readonly requiresSourceAuthorityReceiptVerification: true;
    readonly requiresIndependentToolExecutableVerification: true;
    readonly requiredForeignKeyIntegrity: {
      readonly canonicalForeignKeyCount: 79;
      readonly requiredViolationRowCount: 0;
    };
    readonly requiresConstraintsEnabledAfterLoad: true;
    readonly requiresTriggersEnabledAfterLoad: true;
    readonly requiresApplicationTriggerSemanticsVerification: true;
    readonly requiredPreLoadTargetState: {
      readonly profile: "canonical-empty-59-table-data-target-v1";
      readonly requiredEmptyTableCount: 59;
      readonly tableDataSetSha256: string;
      readonly requiresSchemaMetadataSeedRemoval: true;
      readonly requiresAllTableDataRelationsEmpty: true;
      readonly requiresKernelLedgersEmpty: true;
      readonly requiresPinnedSchemaAuthorityVerificationBeforeLoad: true;
      readonly requiresEmptyStateReceiptAfterSeedRemoval: true;
      readonly requiresIndependentReceiptVerification: true;
    };
    readonly requiredScratchRestoreAuthority: {
      readonly profile: "disposable-target-superuser-disable-triggers-v1";
      readonly requiresCurrentUserSuperuser: true;
      readonly requiresDisposableTargetIdentityBinding: true;
      readonly requiresIndependentReceiptVerification: true;
    };
    readonly opaqueCaptureDigestsNotStandaloneAuthority: readonly [
      "schemaMetadataSha256",
      "sourceSchemaSha256",
      "sourceSnapshotSha256",
      "stateTotalsSha256",
      "sourcePhysicalReadBoundarySha256",
    ];
  };
  readonly manifestBindingSha256: string;
}

export interface BuildPostgresLogicalBackupManifestV4Input {
  readonly createdAt: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly archiveListingSha256: string;
  readonly toc: PostgresLogicalBackupV4TocEvidence;
  readonly pgDump: PostgresLogicalBackupV4ToolIdentity;
  readonly pgRestore: PostgresLogicalBackupV4ToolIdentity;
  readonly rootCaCertificateSha256: string;
  readonly databaseIdentitySha256: string;
  readonly sourceUrlSha256: string;
  readonly exportedSnapshotBindingSha256: string;
  readonly sourceAuthorityReceiptSha256: string;
  readonly sourceCapture: PostgresLogicalStateCaptureV2;
}

export class PostgresLogicalBackupV4Error extends Error {
  constructor(readonly code: "manifest_invalid") {
    super(code);
    this.name = "PostgresLogicalBackupV4Error";
  }
}

function invalid(): never {
  throw new PostgresLogicalBackupV4Error("manifest_invalid");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotBoundedPlainData(value: unknown): unknown {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) invalid();
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate) || candidate < 0 || Object.is(candidate, -0)) invalid();
      return candidate;
    }
    if (typeof candidate !== "object") invalid();
    let prototype: object | null;
    let keys: (string | symbol)[];
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(candidate);
      keys = Reflect.ownKeys(candidate);
      descriptors = Object.getOwnPropertyDescriptors(candidate);
    } catch {
      invalid();
    }
    if (Array.isArray(candidate)) {
      if (prototype !== Array.prototype
        || keys.some((key) => typeof key !== "string"
          || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)))) invalid();
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) invalid();
      const length = lengthDescriptor.value as number;
      if (keys.length !== length + 1
        || keys.some((key) => key !== "length" && Number(key) >= length)) invalid();
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
        output.push(visit(descriptor.value, depth + 1));
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") invalid();
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function exactCount(value: unknown): bigint {
  if (typeof value !== "string" || !CANONICAL_COUNT_PATTERN.test(value)) invalid();
  const parsed = BigInt(value);
  if (parsed > MAX_SIGNED_INT8) invalid();
  return parsed;
}

function exactDatabaseOid(value: unknown): value is string {
  if (typeof value !== "string" || !DATABASE_OID_PATTERN.test(value)) return false;
  const parsed = BigInt(value);
  return parsed > 0n && parsed <= 4_294_967_295n;
}

function exactIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function updateLengthFramed(hash: crypto.Hash, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function emptyTableSha256(tableName: string, columns: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-postgres-transformed-table-v2");
  updateLengthFramed(hash, MIGRATION_CONTRACT_SHA256);
  updateLengthFramed(hash, tableName);
  for (const column of columns) updateLengthFramed(hash, column);
  return hash.digest("hex");
}

function emptyControlSha256(qualifiedName: string, columns: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pintpath-postgres-logical-control-table-v2");
  updateLengthFramed(hash, MIGRATION_CONTRACT_SHA256);
  updateLengthFramed(hash, qualifiedName);
  for (const column of columns) updateLengthFramed(hash, column);
  return hash.digest("hex");
}

function primaryKeySha256(value: string): string {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-source-primary-key-v2");
  updateLengthFramed(hash, `T${value}`);
  return hash.digest("hex");
}

function emptyAuthoritativeStateTotalsSha256(): string {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-postgres-state-totals-v2");
  return hash.digest("hex");
}

function validateReceipt(
  receipt: unknown,
  expectedName: string,
  expectedColumnCount: number,
  emptySha256: string,
): asserts receipt is PostgresLogicalStateTableReceipt {
  if (!isPlainObject(receipt) || !exactKeys(receipt, [
    "tableName", "columnCount", "rowCount", "transformedSha256",
    "firstPrimaryKeySha256", "lastPrimaryKeySha256",
  ])) invalid();
  const rowCount = exactCount(receipt.rowCount);
  if (
    receipt.tableName !== expectedName
    || receipt.columnCount !== expectedColumnCount
    || !safeHash(receipt.transformedSha256)
    || !(receipt.firstPrimaryKeySha256 === null || safeHash(receipt.firstPrimaryKeySha256))
    || !(receipt.lastPrimaryKeySha256 === null || safeHash(receipt.lastPrimaryKeySha256))
    || ((rowCount === 0n) !== (receipt.firstPrimaryKeySha256 === null))
    || ((rowCount === 0n) !== (receipt.lastPrimaryKeySha256 === null))
    || (rowCount === 0n && receipt.transformedSha256 !== emptySha256)
    || (rowCount > 0n && receipt.transformedSha256 === emptySha256)
    || (rowCount === 1n && receipt.firstPrimaryKeySha256 !== receipt.lastPrimaryKeySha256)
    || (rowCount > 1n && receipt.firstPrimaryKeySha256 === receipt.lastPrimaryKeySha256)
  ) invalid();
}

function authoritativeAggregates(tables: readonly PostgresLogicalStateTableReceipt[]): {
  readonly rowCount: bigint;
  readonly nonEmpty: number;
  readonly tableSetSha256: string;
  readonly transformedDataSha256: string;
  readonly keyRangesSha256: string;
} {
  const tableSet = crypto.createHash("sha256");
  const data = crypto.createHash("sha256");
  const ranges = crypto.createHash("sha256");
  updateLengthFramed(tableSet, "pint-path-postgres-table-set-v2");
  updateLengthFramed(data, "pint-path-postgres-transformed-data-v2");
  updateLengthFramed(ranges, "pint-path-postgres-logical-key-ranges-v2");
  let rowCount = 0n;
  let nonEmpty = 0;
  for (const table of tables) {
    const count = exactCount(table.rowCount);
    rowCount += count;
    if (count > 0n) nonEmpty += 1;
    updateLengthFramed(tableSet, table.tableName);
    updateLengthFramed(tableSet, table.rowCount);
    updateLengthFramed(data, table.tableName);
    updateLengthFramed(data, table.transformedSha256);
    updateLengthFramed(ranges, table.tableName);
    updateLengthFramed(ranges, table.rowCount);
    updateLengthFramed(ranges, table.firstPrimaryKeySha256 ?? "");
    updateLengthFramed(ranges, table.lastPrimaryKeySha256 ?? "");
  }
  return {
    rowCount,
    nonEmpty,
    tableSetSha256: tableSet.digest("hex"),
    transformedDataSha256: data.digest("hex"),
    keyRangesSha256: ranges.digest("hex"),
  };
}

function controlAggregates(tables: readonly PostgresLogicalStateTableReceipt[]): {
  readonly rowCount: bigint;
  readonly tableSetSha256: string;
  readonly dataSha256: string;
  readonly keyRangesSha256: string;
} {
  const tableSet = crypto.createHash("sha256");
  const data = crypto.createHash("sha256");
  const ranges = crypto.createHash("sha256");
  updateLengthFramed(tableSet, "pintpath-postgres-logical-control-table-set-v2");
  updateLengthFramed(data, "pintpath-postgres-logical-control-data-v2");
  updateLengthFramed(ranges, "pintpath-postgres-logical-control-key-ranges-v2");
  let rowCount = 0n;
  for (const table of tables) {
    rowCount += exactCount(table.rowCount);
    updateLengthFramed(tableSet, table.tableName);
    updateLengthFramed(tableSet, table.rowCount);
    updateLengthFramed(data, table.tableName);
    updateLengthFramed(data, table.transformedSha256);
    updateLengthFramed(ranges, table.tableName);
    updateLengthFramed(ranges, table.rowCount);
    updateLengthFramed(ranges, table.firstPrimaryKeySha256 ?? "");
    updateLengthFramed(ranges, table.lastPrimaryKeySha256 ?? "");
  }
  return {
    rowCount,
    tableSetSha256: tableSet.digest("hex"),
    dataSha256: data.digest("hex"),
    keyRangesSha256: ranges.digest("hex"),
  };
}

function validateInventory(inventory: unknown): asserts inventory is PostgresLogicalStateInventoryV2 {
  if (!isPlainObject(inventory) || !exactKeys(inventory, [
    "authoritativeTableCount", "authoritativeColumnCount", "authoritativeRowCount",
    "nonEmptyAuthoritativeTableCount", "zeroRowAuthoritativeTableCount",
    "migrationContractSha256", "sourceSchemaFingerprint", "sourceSchemaSha256",
    "sourceSnapshotSha256", "targetDdlSha256", "schemaMetadataSha256",
    "tableSetSha256", "transformedDataSha256", "keyRangesSha256", "stateTotalsSha256",
    "kernelContractSha256", "kernelMigrationSha256", "sourceReadBoundarySha256",
    "controlTableCount", "controlRowCount", "controlTableSetSha256", "controlDataSha256",
    "controlKeyRangesSha256", "overallStateSha256", "tables", "controlTables",
  ])) invalid();
  if (!Array.isArray(inventory.tables)
    || inventory.tables.length !== V4_MIGRATION_CONTRACT.expectedCounts.tables
    || !Array.isArray(inventory.controlTables)
    || inventory.controlTables.length !== CONTROL_TABLES.length) invalid();

  for (let index = 0; index < V4_MIGRATION_CONTRACT.tables.length; index += 1) {
    const contract = V4_MIGRATION_CONTRACT.tables[index]!;
    validateReceipt(
      inventory.tables[index],
      contract.name,
      contract.columns.length,
      emptyTableSha256(contract.name, contract.columns.map((column) => column[0])),
    );
  }
  for (let index = 0; index < CONTROL_TABLES.length; index += 1) {
    const contract = CONTROL_TABLES[index]!;
    validateReceipt(
      inventory.controlTables[index], contract.qualifiedName, contract.columns.length,
      emptyControlSha256(contract.qualifiedName, contract.columns),
    );
  }
  const schemaMetadata = inventory.controlTables[0]!;
  const authoritative = authoritativeAggregates(inventory.tables);
  const controls = controlAggregates(inventory.controlTables);
  if (
    inventory.authoritativeTableCount !== V4_MIGRATION_CONTRACT.expectedCounts.tables
    || inventory.authoritativeColumnCount !== V4_MIGRATION_CONTRACT.expectedCounts.columns
    || exactCount(inventory.authoritativeRowCount) !== authoritative.rowCount
    || inventory.nonEmptyAuthoritativeTableCount !== authoritative.nonEmpty
    || inventory.zeroRowAuthoritativeTableCount
      !== V4_MIGRATION_CONTRACT.expectedCounts.tables - authoritative.nonEmpty
    || inventory.migrationContractSha256 !== POSTGRES_LOGICAL_BACKUP_V4_MIGRATION_CONTRACT_SHA256
    || inventory.sourceSchemaFingerprint !== V4_MIGRATION_CONTRACT.expectedSchemaFingerprint
    || !safeHash(inventory.sourceSchemaSha256)
    || !safeHash(inventory.sourceSnapshotSha256)
    || inventory.targetDdlSha256 !== POSTGRES_LOGICAL_BACKUP_V4_BASE_DDL_SHA256
    || !safeHash(inventory.schemaMetadataSha256)
    || inventory.tableSetSha256 !== authoritative.tableSetSha256
    || inventory.transformedDataSha256 !== authoritative.transformedDataSha256
    || inventory.keyRangesSha256 !== authoritative.keyRangesSha256
    || !safeHash(inventory.stateTotalsSha256)
    || (authoritative.rowCount === 0n && inventory.stateTotalsSha256
      !== emptyAuthoritativeStateTotalsSha256())
    || inventory.kernelContractSha256 !== POSTGRES_LOGICAL_BACKUP_V4_KERNEL_CONTRACT_SHA256
    || inventory.kernelMigrationSha256
      !== POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_SHA256
    || inventory.sourceReadBoundarySha256
      !== POSTGRES_LOGICAL_BACKUP_V4_PORTABLE_BOUNDARY_SHA256
    || inventory.controlTableCount !== 5
    || exactCount(inventory.controlRowCount) !== controls.rowCount
    || inventory.controlTableSetSha256 !== controls.tableSetSha256
    || inventory.controlDataSha256 !== controls.dataSha256
    || inventory.controlKeyRangesSha256 !== controls.keyRangesSha256
    || schemaMetadata.rowCount !== "12"
    || schemaMetadata.firstPrimaryKeySha256 !== primaryKeySha256("import_state")
    || schemaMetadata.lastPrimaryKeySha256 !== primaryKeySha256("target_ddl_sha256")
    || inventory.controlTables[3]!.rowCount !== "0"
    || inventory.controlTables[4]!.rowCount !== "0"
  ) invalid();
  const { overallStateSha256: _ignored, ...withoutOverall } = inventory;
  if (inventory.overallStateSha256 !== sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-state-inventory",
    version: 2,
    ...withoutOverall,
  })) invalid();
}

function validateCapture(capture: unknown): asserts capture is PostgresLogicalStateCaptureV2 {
  if (!isPlainObject(capture) || !exactKeys(capture, [
    "inventory", "sourceDatabaseOid", "sourcePhysicalReadBoundarySha256",
  ]) || !exactDatabaseOid(capture.sourceDatabaseOid)
    || !safeHash(capture.sourcePhysicalReadBoundarySha256)) invalid();
  validateInventory(capture.inventory);
}

function validateTool(value: unknown, name: "pg_dump" | "pg_restore"):
  asserts value is PostgresLogicalBackupV4ToolIdentity {
  if (!isPlainObject(value) || !exactKeys(value, [
    "name", "version", "major", "executableSha256",
  ]) || value.name !== name || value.major !== 17
    || typeof value.version !== "string"
    || Buffer.byteLength(value.version, "utf8") > MAX_TOOL_VERSION_BYTES
    || !VERSION_PATTERN.test(value.version)
    || Number.parseInt(value.version, 10) !== 17 || !safeHash(value.executableSha256)) invalid();
}

function validateTocEvidence(value: unknown): asserts value is PostgresLogicalBackupV4TocEvidence {
  if (!isPlainObject(value) || !exactKeys(value, [
    "tocEntries", "listedEntries", "tableDataEntries", "tableDataSetSha256", "entries",
  ]) || value.tocEntries !== 63 || value.listedEntries !== 59
    || value.tableDataEntries !== 59
    || value.tableDataSetSha256 !== POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256
    || !Array.isArray(value.entries)
    || canonicalPostgresLogicalStateJson(value.entries)
      !== canonicalPostgresLogicalStateJson(POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS)) {
    invalid();
  }
}

function archiveState(capture: PostgresLogicalStateCaptureV2): {
  readonly rowCount: string;
  readonly stateSha256: string;
} {
  const included = [
    ...capture.inventory.tables.map((receipt) => ({
      schemaName: "pintpath_app" as const, tableName: receipt.tableName, receipt,
    })),
    ...capture.inventory.controlTables.slice(0, 3).map((receipt) => {
      const [schemaName, tableName] = receipt.tableName.split(".");
      return { schemaName, tableName, receipt };
    }),
  ].sort((left, right) => compareText(
    `${left.schemaName}.${left.tableName}`,
    `${right.schemaName}.${right.tableName}`,
  ));
  const rowCount = included.reduce((sum, entry) => sum + exactCount(entry.receipt.rowCount), 0n);
  return {
    rowCount: rowCount.toString(),
    stateSha256: sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-backup-table-data-state",
      version: 1,
      entries: included,
    }),
  };
}

function manifestWithoutBinding(manifest: PostgresLogicalBackupManifestV4):
  Omit<PostgresLogicalBackupManifestV4, "manifestBindingSha256"> {
  const { manifestBindingSha256: _ignored, ...withoutBinding } = manifest;
  return withoutBinding;
}

export function postgresLogicalBackupManifestV4BindingSha256(
  manifest: PostgresLogicalBackupManifestV4,
): string {
  try {
    const snapshot = snapshotBoundedPlainData(manifest);
    if (!isPlainObject(snapshot)) invalid();
    return sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-backup-manifest-binding",
      version: 3,
      manifest: manifestWithoutBinding(snapshot as unknown as PostgresLogicalBackupManifestV4),
    });
  } catch (error) {
    if (error instanceof PostgresLogicalBackupV4Error) throw error;
    invalid();
  }
}

function buildPostgresLogicalBackupManifestV4FromSnapshot(
  input: BuildPostgresLogicalBackupManifestV4Input,
): PostgresLogicalBackupManifestV4 {
  if (MIGRATION_CONTRACT_SHA256 !== POSTGRES_LOGICAL_BACKUP_V4_MIGRATION_CONTRACT_SHA256
    || sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT)
      !== POSTGRES_LOGICAL_BACKUP_V4_MIGRATION_CONTRACT_SHA256
    || POSTGRES_LOGICAL_STATE_KERNEL_CONTRACT_SHA256
      !== POSTGRES_LOGICAL_BACKUP_V4_KERNEL_CONTRACT_SHA256
    || POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_FILE
      !== POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_FILE
    || POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256
      !== POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_SHA256
    || COMPUTED_TABLE_DATA_SET_SHA256 !== POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256
    || POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256
      !== POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256) invalid();
  if (!exactIsoInstant(input.createdAt) || !Number.isSafeInteger(input.archiveBytes)
    || input.archiveBytes < 1 || !safeHash(input.archiveSha256)
    || !safeHash(input.archiveListingSha256) || !safeHash(input.rootCaCertificateSha256)
    || !safeHash(input.databaseIdentitySha256) || !safeHash(input.sourceUrlSha256)
    || !safeHash(input.exportedSnapshotBindingSha256)
    || !safeHash(input.sourceAuthorityReceiptSha256)) invalid();
  validateTool(input.pgDump, "pg_dump");
  validateTool(input.pgRestore, "pg_restore");
  validateTocEvidence(input.toc);
  validateCapture(input.sourceCapture);
  const captureSha256 = sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-state-capture",
    version: 2,
    capture: input.sourceCapture,
  });
  const state = archiveState(input.sourceCapture);
  const pairingWithoutSha = {
    captureSha256,
    databaseIdentitySha256: input.databaseIdentitySha256,
    sourceUrlSha256: input.sourceUrlSha256,
    exportedSnapshotBindingSha256: input.exportedSnapshotBindingSha256,
    sourceAuthorityReceiptSha256: input.sourceAuthorityReceiptSha256,
    sourceDatabaseOid: input.sourceCapture.sourceDatabaseOid,
    sourcePhysicalReadBoundarySha256: input.sourceCapture.sourcePhysicalReadBoundarySha256,
    sourceReadBoundarySha256: input.sourceCapture.inventory.sourceReadBoundarySha256,
    sourceOverallStateSha256: input.sourceCapture.inventory.overallStateSha256,
    archiveSha256: input.archiveSha256,
    listingSha256: input.archiveListingSha256,
    tableDataSetSha256: POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
    tableDataStateSha256: state.stateSha256,
    archiveRowCount: state.rowCount,
  };
  const provisional: PostgresLogicalBackupManifestV4 = {
    schemaVersion: 4,
    kind: "pintpath-postgres-logical-backup",
    createdAt: input.createdAt,
    archive: {
      file: POSTGRES_LOGICAL_BACKUP_V4_ARCHIVE_FILE,
      format: "custom",
      mode: "data-only",
      bytes: input.archiveBytes,
      sha256: input.archiveSha256,
      listingSha256: input.archiveListingSha256,
      toc: input.toc,
      archiveRowCount: state.rowCount,
      tableDataStateSha256: state.stateSha256,
      requiredDumpArguments: POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS,
      requiredDynamicDumpArgumentBindings: {
        profile: "source-authority-receipt-bound-pg-dump-arguments-v1",
        roleArgument: `--role=pintpath_logical_backup_d${input.sourceCapture.sourceDatabaseOid}`,
        snapshotArgumentTemplate: "--snapshot=<authenticated-exported-snapshot>",
        exportedSnapshotBindingSha256: input.exportedSnapshotBindingSha256,
        requiresExactSnapshotArgumentReceiptVerification: true,
      },
      requiredScratchRestoreOptions: POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_SCRATCH_RESTORE_OPTIONS,
    },
    tools: { pgDump: { ...input.pgDump }, pgRestore: { ...input.pgRestore } },
    transport: {
      profile: "railway-stock-localhost-ca-v1",
      rootCaCertificateSha256: input.rootCaCertificateSha256,
    },
    sourceAuthority: {
      profile: "detached-effective-role-snapshot-handoff-pg17-v1",
      databaseIdentitySha256: input.databaseIdentitySha256,
      sourceUrlSha256: input.sourceUrlSha256,
      exportedSnapshotBindingSha256: input.exportedSnapshotBindingSha256,
      sourceAuthorityReceiptSha256: input.sourceAuthorityReceiptSha256,
    },
    schemaAuthority: {
      profile: "checked-in-canonical-ddl-plus-inert-kernel",
      baseDdlFile: POSTGRES_LOGICAL_BACKUP_V4_BASE_DDL_FILE,
      baseDdlSha256: POSTGRES_LOGICAL_BACKUP_V4_BASE_DDL_SHA256,
      migrationContractSha256: POSTGRES_LOGICAL_BACKUP_V4_MIGRATION_CONTRACT_SHA256,
      kernelMigrationFile: POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_FILE,
      kernelMigrationSha256: POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_SHA256,
      kernelContractSha256: POSTGRES_LOGICAL_BACKUP_V4_KERNEL_CONTRACT_SHA256,
      sourceReadBoundarySha256: POSTGRES_LOGICAL_BACKUP_V4_PORTABLE_BOUNDARY_SHA256,
    },
    sourceCapture: { captureSha256, capture: input.sourceCapture },
    pairing: {
      ...pairingWithoutSha,
      pairingSha256: sha256CanonicalPostgresLogicalState({
        kind: "pintpath-postgres-logical-backup-v4-pairing",
        version: 1,
        ...pairingWithoutSha,
      }),
    },
    verificationRequirements: {
      profile: "different-oid-canonical-schema-scratch-restore-v1",
      requiresDifferentDatabaseOid: true,
      requiresExactTableDataToc: true,
      requiresExactTargetV2InventoryMatch: true,
      requiresFreshTargetPhysicalReadBoundaryVerification: true,
      requiresSameExportedSnapshot: true,
      requiresSourceAuthorityReceiptVerification: true,
      requiresIndependentToolExecutableVerification: true,
      requiredForeignKeyIntegrity: {
        canonicalForeignKeyCount: 79,
        requiredViolationRowCount: 0,
      },
      requiresConstraintsEnabledAfterLoad: true,
      requiresTriggersEnabledAfterLoad: true,
      requiresApplicationTriggerSemanticsVerification: true,
      requiredPreLoadTargetState: {
        profile: "canonical-empty-59-table-data-target-v1",
        requiredEmptyTableCount: 59,
        tableDataSetSha256: POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
        requiresSchemaMetadataSeedRemoval: true,
        requiresAllTableDataRelationsEmpty: true,
        requiresKernelLedgersEmpty: true,
        requiresPinnedSchemaAuthorityVerificationBeforeLoad: true,
        requiresEmptyStateReceiptAfterSeedRemoval: true,
        requiresIndependentReceiptVerification: true,
      },
      requiredScratchRestoreAuthority: {
        profile: "disposable-target-superuser-disable-triggers-v1",
        requiresCurrentUserSuperuser: true,
        requiresDisposableTargetIdentityBinding: true,
        requiresIndependentReceiptVerification: true,
      },
      opaqueCaptureDigestsNotStandaloneAuthority: [
        "schemaMetadataSha256",
        "sourceSchemaSha256",
        "sourceSnapshotSha256",
        "stateTotalsSha256",
        "sourcePhysicalReadBoundarySha256",
      ],
    },
    manifestBindingSha256: "0".repeat(64),
  };
  const manifest = {
    ...provisional,
    manifestBindingSha256: postgresLogicalBackupManifestV4BindingSha256(provisional),
  };
  if (Buffer.byteLength(canonicalPostgresLogicalStateJson(manifest), "utf8")
    > POSTGRES_LOGICAL_BACKUP_V4_MAX_MANIFEST_BYTES) invalid();
  return manifest;
}

export function buildPostgresLogicalBackupManifestV4(
  input: BuildPostgresLogicalBackupManifestV4Input,
): PostgresLogicalBackupManifestV4 {
  try {
    const snapshot = snapshotBoundedPlainData(input);
    if (!isPlainObject(snapshot) || !exactKeys(snapshot, [
      "createdAt", "archiveBytes", "archiveSha256", "archiveListingSha256",
      "toc", "pgDump", "pgRestore", "rootCaCertificateSha256", "databaseIdentitySha256",
      "sourceUrlSha256", "exportedSnapshotBindingSha256", "sourceAuthorityReceiptSha256",
      "sourceCapture",
    ]) || Buffer.byteLength(canonicalPostgresLogicalStateJson(snapshot), "utf8")
      > POSTGRES_LOGICAL_BACKUP_V4_MAX_MANIFEST_BYTES) invalid();
    return buildPostgresLogicalBackupManifestV4FromSnapshot(
      snapshot as unknown as BuildPostgresLogicalBackupManifestV4Input,
    );
  } catch (error) {
    if (error instanceof PostgresLogicalBackupV4Error) throw error;
    invalid();
  }
}

function assertBoundedJsonTree(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) invalid();
    if (typeof current.value === "number"
      && (!Number.isSafeInteger(current.value) || current.value < 0 || Object.is(current.value, -0))) {
      invalid();
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (isPlainObject(current.value)) {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

export function parsePostgresLogicalBackupManifestV4(
  bytes: Buffer,
): PostgresLogicalBackupManifestV4 {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1
    || bytes.length > POSTGRES_LOGICAL_BACKUP_V4_MAX_MANIFEST_BYTES) invalid();
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(text, "utf8").equals(bytes)) invalid();
    value = JSON.parse(text);
  } catch {
    invalid();
  }
  assertBoundedJsonTree(value);
  if (!isPlainObject(value) || canonicalPostgresLogicalStateJson(value) !== text
    || !exactKeys(value, [
      "schemaVersion", "kind", "createdAt", "archive", "tools", "transport",
      "sourceAuthority", "schemaAuthority", "sourceCapture", "pairing", "verificationRequirements",
      "manifestBindingSha256",
    ]) || value.schemaVersion !== 4 || value.kind !== "pintpath-postgres-logical-backup"
    || !isPlainObject(value.archive) || !isPlainObject(value.tools)
    || !isPlainObject(value.transport) || !isPlainObject(value.sourceAuthority)
    || !isPlainObject(value.sourceCapture)) invalid();
  if (!exactKeys(value.archive, [
    "file", "format", "mode", "bytes", "sha256", "listingSha256", "toc",
    "archiveRowCount", "tableDataStateSha256", "requiredDumpArguments",
    "requiredDynamicDumpArgumentBindings",
    "requiredScratchRestoreOptions",
  ]) || !exactKeys(value.tools, ["pgDump", "pgRestore"])
    || !exactKeys(value.transport, ["profile", "rootCaCertificateSha256"])
    || !exactKeys(value.sourceAuthority, [
      "profile", "databaseIdentitySha256", "sourceUrlSha256",
      "exportedSnapshotBindingSha256", "sourceAuthorityReceiptSha256",
    ])
    || !exactKeys(value.sourceCapture, ["captureSha256", "capture"])) invalid();
  validateTool(value.tools.pgDump, "pg_dump");
  validateTool(value.tools.pgRestore, "pg_restore");
  validateCapture(value.sourceCapture.capture);
  const rebuilt = buildPostgresLogicalBackupManifestV4({
    createdAt: String(value.createdAt),
    archiveBytes: Number(value.archive.bytes),
    archiveSha256: String(value.archive.sha256),
    archiveListingSha256: String(value.archive.listingSha256),
    toc: value.archive.toc as unknown as PostgresLogicalBackupV4TocEvidence,
    pgDump: value.tools.pgDump,
    pgRestore: value.tools.pgRestore,
    rootCaCertificateSha256: String(value.transport.rootCaCertificateSha256),
    databaseIdentitySha256: String(value.sourceAuthority.databaseIdentitySha256),
    sourceUrlSha256: String(value.sourceAuthority.sourceUrlSha256),
    exportedSnapshotBindingSha256: String(value.sourceAuthority.exportedSnapshotBindingSha256),
    sourceAuthorityReceiptSha256: String(value.sourceAuthority.sourceAuthorityReceiptSha256),
    sourceCapture: value.sourceCapture.capture,
  });
  if (canonicalPostgresLogicalStateJson(rebuilt) !== text) invalid();
  return rebuilt;
}

export function canonicalPostgresLogicalBackupManifestV4(
  manifest: PostgresLogicalBackupManifestV4,
): Buffer {
  try {
    const snapshot = snapshotBoundedPlainData(manifest);
    const parsed = parsePostgresLogicalBackupManifestV4(
      Buffer.from(canonicalPostgresLogicalStateJson(snapshot), "utf8"),
    );
    return Buffer.from(canonicalPostgresLogicalStateJson(parsed), "utf8");
  } catch (error) {
    if (error instanceof PostgresLogicalBackupV4Error) throw error;
    invalid();
  }
}
