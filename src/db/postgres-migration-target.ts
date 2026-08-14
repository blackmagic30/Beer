import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { Client, type ClientConfig, type QueryResultRow } from "pg";

import { POSTGRES_MIGRATION_CONTRACT } from "./postgres-migration-contract.js";
import {
  POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_OBJECT_COUNT,
  POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_SHA256,
  inspectPostgresMigrationLiveSchema,
  type PostgresMigrationLiveSchemaInspection,
} from "./postgres-migration-live-schema.js";
import { readPostgresMigrationLedgerAuthority } from "./postgres-migration-ledger.js";
import {
  buildPostgresMigrationReadyMetadata,
  derivePostgresMigrationRunId,
  finalizePostgresMigrationApplyReceipt,
  finalizePostgresMigrationReceipt,
  sha256PostgresMigrationRunBinding,
  sha256PostgresMigrationReadyMetadata,
  sha256PostgresMigrationTargetIdentity,
  sha256PostgresMigrationTransportAuthority,
  verifyPostgresMigrationVerificationApproval,
  type PostgresMigrationApplyReceipt,
  type PostgresMigrationVerificationApproval,
  type PostgresMigrationReadyMetadata,
  type PostgresMigrationTargetIdentity,
  type PostgresMigrationReceipt as CanonicalPostgresMigrationReceipt,
} from "./postgres-migration-receipt.js";
import {
  POSTGRES_MIGRATION_ADVISORY_LOCK_KEY,
  POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
  POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE,
  postgresMigrationVerifierAuthoritySchema,
  type PostgresMigrationVerifierAuthority,
} from "./postgres-migration-verifier-authority.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  checkPostgresRailwayStockLocalhostServerIdentity,
  openPostgresRailwayStockLocalhostCaTransport,
  parsePostgresRailwayStockLocalhostCaUrl,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../lib/postgres-railway-stock-localhost-ca.js";
import {
  inspectPostgresMigrationSchema,
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
  sha256PostgresMigrationContract,
  type PostgresMigrationColumnContract,
  type PostgresMigrationSchemaDescriptor,
  type PostgresMigrationTableContract,
} from "./postgres-migration-schema.js";
import {
  POSTGRES_MIGRATION_PLAN_KIND,
  POSTGRES_MIGRATION_PLAN_VERSION,
  POSTGRES_MIGRATION_SNAPSHOT_DATABASE_FILE,
  PostgresMigrationSourceError,
  postgresMigrationSourceInternals,
  verifyPostgresMigrationSnapshotEvidence,
  type PostgresMigrationPlan,
  type PostgresMigrationPlanChunk,
  type PostgresMigrationPlanTable,
  type PostgresMigrationSnapshotManifest,
} from "./postgres-migration-source.js";

const APPLICATION_SCHEMA = "pintpath_app";
const OPERATIONS_SCHEMA = "pintpath_ops";
const MIGRATOR_ROLE = "pintpath_migrator";
const RUNTIME_ROLE = "pintpath_runtime";
const MIGRATION_LOCK_KEY = POSTGRES_MIGRATION_ADVISORY_LOCK_KEY;
const MAX_INSERT_PARAMETERS = 60_000;
const MAX_KEY_PARAMETERS = 20_000;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const SIGNED_INT64_MIN = -(1n << 63n);
const SIGNED_INT64_MAX = (1n << 63n) - 1n;

export type PostgresMigrationTargetErrorCode =
  | "ARGUMENT_INVALID"
  | "ARTIFACT_INVALID"
  | "IDENTITY_MISMATCH"
  | "IMPORT_FAILED"
  | "PLAN_MISMATCH"
  | "RECONCILIATION_FAILED"
  | "RESUME_MISMATCH"
  | "SOURCE_CHANGED"
  | "SOURCE_DATA_INVALID"
  | "TARGET_BUSY"
  | "TARGET_CHANGED"
  | "TARGET_NOT_EMPTY"
  | "TARGET_UNSAFE";

const TARGET_ERROR_MESSAGES: Readonly<Record<PostgresMigrationTargetErrorCode, string>> = {
  ARGUMENT_INVALID: "Postgres migration target arguments are invalid.",
  ARTIFACT_INVALID: "A Postgres migration artifact is invalid.",
  IDENTITY_MISMATCH: "Postgres migration identity binding does not match.",
  IMPORT_FAILED: "Postgres migration import failed.",
  PLAN_MISMATCH: "Postgres migration plan reconciliation failed.",
  RECONCILIATION_FAILED: "Postgres migration target reconciliation failed.",
  RESUME_MISMATCH: "Postgres migration target is not the exact resumable run.",
  SOURCE_CHANGED: "Postgres migration source changed during the run.",
  SOURCE_DATA_INVALID: "Postgres migration source data is invalid.",
  TARGET_BUSY: "Another Postgres migration owns the target lock.",
  TARGET_CHANGED: "Postgres migration target data changed after import.",
  TARGET_NOT_EMPTY: "Postgres migration target is not empty.",
  TARGET_UNSAFE: "Postgres migration target security or schema checks failed.",
};

export const POSTGRES_MIGRATION_TARGET_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_DATABASE_URL" as const;

export interface SafePostgresMigrationTargetFailure {
  readonly code: PostgresMigrationTargetErrorCode | "UNEXPECTED_FAILURE";
  readonly message: string;
  readonly exitCode: 2 | 3 | 4;
  readonly retryable: boolean;
}

export class PostgresMigrationTargetError extends Error {
  constructor(readonly code: PostgresMigrationTargetErrorCode) {
    super(TARGET_ERROR_MESSAGES[code]);
    this.name = "PostgresMigrationTargetError";
  }
}

export function safePostgresMigrationTargetFailure(error: unknown): SafePostgresMigrationTargetFailure {
  if (error instanceof PostgresMigrationTargetError) {
    return {
      code: error.code,
      message: TARGET_ERROR_MESSAGES[error.code],
      exitCode: error.code === "ARGUMENT_INVALID" ? 2 : error.code === "TARGET_BUSY" ? 4 : 3,
      retryable: error.code === "TARGET_BUSY",
    };
  }
  return {
    code: "UNEXPECTED_FAILURE",
    message: "Postgres migration target command failed unexpectedly; inspect protected application logs.",
    exitCode: 3,
    retryable: false,
  };
}

export type PostgresMigrationEnvironment = "permanent-staging" | "production";

export interface PostgresMigrationTargetInspection {
  readonly targetIdentity: PostgresMigrationTargetIdentity;
  readonly targetIdentitySha256: string;
  readonly targetUrlSha256: string;
  readonly transportAuthoritySha256: string;
  readonly targetDdlSha256: string;
  readonly liveSchemaSha256: string;
  readonly liveSchemaObjectCount: number;
  readonly tableCount: number;
  readonly columnCount: number;
  readonly foreignKeyCount: number;
}

export type { PostgresMigrationReceipt } from "./postgres-migration-receipt.js";

export interface PostgresMigrationTargetInput {
  readonly snapshotManifestPath: string;
  readonly expectedSnapshotManifestSha256: string;
  readonly planPath: string;
  readonly expectedPlanSha256: string;
  readonly targetDdlPath: string;
  readonly expectedTargetDdlSha256: string;
  readonly targetUrl: string;
  readonly expectedTargetUrlSha256: string;
  readonly rootCaFile: string;
  readonly expectedRootCaDerSha256: string;
  readonly expectedTransportAuthoritySha256: string;
  readonly expectedTargetIdentitySha256: string;
  readonly expectedEnvironment: PostgresMigrationEnvironment;
  readonly candidateSha: string;
  readonly approvalReference: string;
  readonly operatorId: string;
}

export interface PostgresMigrationVerificationAuthority {
  readonly applyReceipt: PostgresMigrationApplyReceipt;
  readonly applyReceiptFileSha256: string;
  readonly expectedApplyReceiptFileSha256: string;
  readonly approval: unknown;
  readonly approvalFileSha256: string;
  readonly expectedApprovalFileSha256: string;
  readonly verifierPublicKeyBytes: Buffer;
  readonly now: Date;
}

export interface PostgresMigrationVerifyInput extends PostgresMigrationTargetInput {
  readonly verificationAuthority: PostgresMigrationVerificationAuthority;
}

export interface PostgresMigrationTargetQueryResult<Row extends QueryResultRow = QueryResultRow> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface PostgresMigrationTargetConnection {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresMigrationTargetQueryResult<Row>>;
}

export interface PostgresMigrationTargetDependencies {
  readonly inspectLiveSchema?: (
    connection: PostgresMigrationTargetConnection,
  ) => Promise<PostgresMigrationLiveSchemaInspection>;
}

interface CloseableTargetConnection extends PostgresMigrationTargetConnection {
  close(): Promise<void>;
}

type StableArtifact = {
  readonly bytes: number;
  readonly contents: Buffer;
  readonly sha256: string;
  readonly stat: fs.BigIntStats;
};

type StableFileDigest = Omit<StableArtifact, "contents">;

type TargetIdentityRow = QueryResultRow & {
  systemIdentifier: string;
  databaseOid: string;
  databaseName: string;
  sessionUser: string;
  currentUser: string;
  serverVersionNum: string;
  sessionSuperuser: boolean;
  currentSuperuser: boolean;
  sessionBypassRls: boolean;
  currentBypassRls: boolean;
  activeRoleExact: boolean;
  loginAttributesSafe: boolean;
  loginMembershipExact: boolean;
  migratorRoleSafe: boolean;
  migratorRoleParentsAbsent: boolean;
  migratorRoleChildrenExact: boolean;
  loginRoleChildrenAbsent: boolean;
  roleSettingsAbsent: boolean;
  databaseAuthorityExact: boolean;
  migratorDatabaseAuthorityExact: boolean;
  migratorSchemaAuthorityExact: boolean;
  migratorTableAuthorityExact: boolean;
  migratorColumnPrivilegesAbsent: boolean;
  migratorRoutinePrivilegesAbsent: boolean;
  migratorSequencePrivilegesAbsent: boolean;
  unsafeDirectLoginAclAbsent: boolean;
  unsafeDirectMigratorAclAbsent: boolean;
  roleOwnershipAbsent: boolean;
  defaultPrivilegesAbsent: boolean;
  verifierAuthorityRoleBoundaryExact: boolean;
  migratorMember: boolean;
  runtimeMember: boolean;
  applicationSchemaUsage: boolean;
  operationsSchemaUsage: boolean;
  forbiddenMutationPrivilege: boolean;
};

type TargetColumnRow = QueryResultRow & {
  tableName: string;
  columnName: string;
  dataType: string;
  ordinalPosition: number;
  isNullable: boolean;
  rlsEnabled: boolean;
  rlsForced: boolean;
};

type TargetPrimaryKeyRow = QueryResultRow & {
  tableName: string;
  columnName: string;
  primaryKeyPosition: number;
};

type TargetConstraintSummaryRow = QueryResultRow & {
  foreignKeyCount: number;
  unvalidatedCount: number;
};

type TargetControlTableRow = QueryResultRow & {
  schemaName: string;
  tableName: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
};

type TargetForeignKeyRow = QueryResultRow & {
  childTable: string;
  parentTable: string;
  childColumn: string;
  parentColumn: string;
  columnPosition: number;
  onUpdate: string;
  onDelete: string;
  matchType: string;
  deferrable: boolean;
};

type MetadataRow = QueryResultRow & { key: string; value: string };
type TableCountRow = QueryResultRow & { tableName: string; rowCount: string };
type AdvisoryLockRow = QueryResultRow & { acquired: boolean };
type VerifierAuthorityRow = QueryResultRow & {
  expectedEnvironment: string;
  candidateSha: string;
  operatorIdSha256: string;
  verifierIdSha256: string;
  verifierPublicKeySha256: string;
  authorityPolicySha256: string;
  authoritySha256: string;
  installedAt: Date | string;
};

type MigrationRunRow = QueryResultRow & {
  runId: string;
  sourceSnapshotSha256: string;
  sourceSchemaFingerprint: string;
  contractSha256: string;
  manifestSha256: string;
  targetDdlSha256: string;
  sourceSchemaVersion: number;
  candidateSha: string;
  targetBindingSha256: string;
  expectedEnvironment: string;
  approvalReferenceSha256: string;
  operatorIdSha256: string;
  verifierIdSha256: string | null;
  status: "planned" | "importing" | "verifying" | "ready" | "failed";
  receiptSha256: string | null;
  failureCode: string | null;
};

type MigrationChunkRow = QueryResultRow & {
  runId: string;
  tableName: string;
  chunkOrdinal: number;
  rowCount: number;
  sourceTransformedSha256: string;
  targetSha256: string;
};

type TargetContext = {
  readonly manifest: PostgresMigrationSnapshotManifest;
  readonly manifestSha256: string;
  readonly plan: PostgresMigrationPlan;
  readonly planSha256: string;
  readonly targetDdlSha256: string;
  readonly targetUrlSha256: string;
  readonly transportAuthoritySha256: string;
  readonly targetIdentitySha256: string;
  readonly liveSchemaSha256: string;
  readonly contractSha256: string;
  readonly approvalReferenceSha256: string;
  readonly operatorIdSha256: string;
  readonly verifierIdSha256: string;
  readonly verifierAuthoritySha256: string;
  readonly verifierAuthorityPolicySha256: string;
  readonly verifierPublicKeySha256: string;
  readonly targetBindingSha256: string;
  readonly runId: string;
  readonly expectedEnvironment: PostgresMigrationEnvironment;
  readonly sourceDatabasePath: string;
  readonly sourceDescriptor: PostgresMigrationSchemaDescriptor;
};

type TransformedRow = {
  readonly raw: Record<string, unknown>;
  readonly target: readonly unknown[];
  readonly canonicalRow: Buffer;
  readonly primaryKeySha256: string;
};

type SourceChunk = {
  readonly plan: PostgresMigrationPlanChunk;
  readonly rows: readonly TransformedRow[];
  readonly transformedSha256: string;
};

type ReconciliationSummary = {
  readonly tableSetSha256: string;
  readonly transformedDataSha256: string;
  readonly keyRangesSha256: string;
  readonly stateTotalsSha256: string;
  readonly chunkCount: number;
  readonly zeroRowTableCount: number;
  readonly foreignKeyCount: number;
};

function targetError(code: PostgresMigrationTargetErrorCode): PostgresMigrationTargetError {
  return new PostgresMigrationTargetError(code);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw targetError("ARGUMENT_INVALID");
  return normalized;
}

function normalizeCandidateSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(normalized)) throw targetError("ARGUMENT_INVALID");
  return normalized;
}

function identitySha256(value: string, label: string): string {
  const normalized = normalizeIdentityReference(value);
  return sha256PostgresMigrationBytes(`${label}\0${normalized}`);
}

function normalizeIdentityReference(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 3 || normalized.length > 160 || /[\r\n\0]/.test(normalized)) {
    throw targetError("ARGUMENT_INVALID");
  }
  return normalized;
}

function assertCanonicalAbsoluteFile(filePath: string): void {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath || filePath.includes("\0")) {
    throw targetError("ARTIFACT_INVALID");
  }
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readStableArtifact(
  filePath: string,
  options: { readonly requiredMode?: number; readonly maxBytes?: number } = {},
): Promise<StableArtifact> {
  assertCanonicalAbsoluteFile(filePath);
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(filePath, { bigint: true });
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1n
      || fs.realpathSync(filePath) !== filePath
    ) {
      throw new Error("unsafe");
    }
  } catch {
    throw targetError("ARTIFACT_INVALID");
  }
  if (
    options.requiredMode !== undefined
    && Number(pathStat.mode & 0o777n) !== options.requiredMode
  ) {
    throw targetError("ARTIFACT_INVALID");
  }
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  if (pathStat.size > BigInt(maxBytes)) throw targetError("ARTIFACT_INVALID");
  // The O_NOFOLLOW descriptor is bound to the pre-open lstat by full file
  // identity and is revalidated after the descriptor-only read.
  // codeql[js/file-system-race]
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); // lgtm[js/file-system-race]
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFileIdentity(pathStat, before)) throw targetError("SOURCE_CHANGED");
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after) || BigInt(contents.length) !== before.size) {
      throw targetError("SOURCE_CHANGED");
    }
    return {
      bytes: contents.length,
      contents,
      sha256: sha256PostgresMigrationBytes(contents),
      stat: after,
    };
  } finally {
    await handle.close();
  }
}

async function assertSnapshotLedgerAuthority(
  snapshotDirectory: string,
  manifest: PostgresMigrationSnapshotManifest,
  failureCode: "ARTIFACT_INVALID" | "SOURCE_CHANGED",
): Promise<void> {
  try {
    const expected = manifest.deletionLedger;
    const bundle = await readPostgresMigrationLedgerAuthority(path.join(
      snapshotDirectory,
      expected.directory,
      expected.authorityManifestFile,
    ));
    if (
      bundle.manifestSha256 !== expected.authorityManifestSha256
      || bundle.manifest.current.sha256 !== expected.currentLedgerSha256
      || bundle.manifest.genesis.sha256 !== expected.genesisSha256
      || bundle.manifest.checkpoint.sha256 !== expected.checkpointSha256
      || bundle.manifest.checkpoint.immutableObjectCount !== expected.immutableObjectCount
      || bundle.manifest.checkpoint.immutableSetSha256 !== expected.immutableSetSha256
      || bundle.manifest.checkpoint.tombstoneCount !== expected.tombstoneCount
      || bundle.manifest.checkpoint.latestCompletedAt !== expected.latestCompletedAt
    ) {
      throw targetError(failureCode);
    }
  } catch (error) {
    if (error instanceof PostgresMigrationTargetError) throw error;
    throw targetError(failureCode);
  }
}

async function digestStableFile(
  filePath: string,
  options: { readonly requiredMode?: number; readonly maxBytes?: number } = {},
): Promise<StableFileDigest> {
  assertCanonicalAbsoluteFile(filePath);
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(filePath, { bigint: true });
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1n
      || fs.realpathSync(filePath) !== filePath
    ) throw new Error("unsafe");
  } catch {
    throw targetError("ARTIFACT_INVALID");
  }
  if (
    options.requiredMode !== undefined
    && Number(pathStat.mode & 0o777n) !== options.requiredMode
  ) throw targetError("ARTIFACT_INVALID");
  if (pathStat.size > BigInt(options.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
    throw targetError("ARTIFACT_INVALID");
  }
  // The O_NOFOLLOW descriptor is bound to the pre-open lstat by full file
  // identity and is revalidated after hashing the descriptor contents.
  // codeql[js/file-system-race]
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); // lgtm[js/file-system-race]
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFileIdentity(pathStat, before)) throw targetError("SOURCE_CHANGED");
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, position);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after) || BigInt(position) !== before.size) {
      throw targetError("SOURCE_CHANGED");
    }
    return { bytes: position, sha256: hash.digest("hex"), stat: after };
  } finally {
    await handle.close();
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort(compareStrings)) !== JSON.stringify([...expected].sort(compareStrings))) {
    throw targetError("ARTIFACT_INVALID");
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw targetError("ARTIFACT_INVALID");
  return value as Record<string, unknown>;
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw targetError("ARTIFACT_INVALID");
  }
  return value;
}

function normalizePlan(value: unknown): PostgresMigrationPlan {
  const plan = jsonObject(value);
  assertExactKeys(plan, [
    "candidateSha",
    "chunkRows",
    "columnCount",
    "contractSha256",
    "importOrder",
    "kind",
    "snapshotManifestSha256",
    "sourceDatabaseSha256",
    "sourceSchemaFingerprint",
    "sourceSchemaVersion",
    "tableCount",
    "tables",
    "totalRows",
    "version",
  ]);
  if (plan.kind !== POSTGRES_MIGRATION_PLAN_KIND || plan.version !== POSTGRES_MIGRATION_PLAN_VERSION) {
    throw targetError("ARTIFACT_INVALID");
  }
  if (!Array.isArray(plan.importOrder) || !Array.isArray(plan.tables)) throw targetError("ARTIFACT_INVALID");
  const conversionKeys = [
    "binary", "boolean", "calendar-month", "decimal", "float64", "integer",
    "json-array", "json-object", "local-time", "text", "utc-instant",
  ].sort(compareStrings);
  const tables: PostgresMigrationPlanTable[] = plan.tables.map((rawTable) => {
    const table = jsonObject(rawTable);
    assertExactKeys(table, ["chunks", "columnCount", "conversionCounts", "name", "rowCount", "transformedSha256"]);
    const conversionCounts = jsonObject(table.conversionCounts);
    if (JSON.stringify(Object.keys(conversionCounts).sort(compareStrings)) !== JSON.stringify(conversionKeys)) {
      throw targetError("ARTIFACT_INVALID");
    }
    if (!Array.isArray(table.chunks)) throw targetError("ARTIFACT_INVALID");
    const chunks: PostgresMigrationPlanChunk[] = table.chunks.map((rawChunk, index) => {
      const chunk = jsonObject(rawChunk);
      assertExactKeys(chunk, [
        "firstPrimaryKeySha256", "lastPrimaryKeySha256", "ordinal", "rowCount", "transformedSha256",
      ]);
      const ordinal = safeCount(chunk.ordinal);
      const rowCount = safeCount(chunk.rowCount);
      if (ordinal !== index || rowCount < 1) throw targetError("ARTIFACT_INVALID");
      return {
        ordinal,
        rowCount,
        transformedSha256: assertSha256(String(chunk.transformedSha256 ?? "")),
        firstPrimaryKeySha256: assertSha256(String(chunk.firstPrimaryKeySha256 ?? "")),
        lastPrimaryKeySha256: assertSha256(String(chunk.lastPrimaryKeySha256 ?? "")),
      };
    });
    const normalizedCounts = Object.fromEntries(
      conversionKeys.map((key) => [key, safeCount(conversionCounts[key])]),
    ) as PostgresMigrationPlanTable["conversionCounts"];
    const rowCount = safeCount(table.rowCount);
    if (chunks.reduce((total, chunk) => total + chunk.rowCount, 0) !== rowCount) {
      throw targetError("ARTIFACT_INVALID");
    }
    return {
      name: String(table.name ?? ""),
      columnCount: safeCount(table.columnCount),
      rowCount,
      transformedSha256: assertSha256(String(table.transformedSha256 ?? "")),
      conversionCounts: normalizedCounts,
      chunks,
    };
  });
  const normalized: PostgresMigrationPlan = {
    kind: POSTGRES_MIGRATION_PLAN_KIND,
    version: POSTGRES_MIGRATION_PLAN_VERSION,
    candidateSha: normalizeCandidateSha(String(plan.candidateSha ?? "")),
    contractSha256: assertSha256(String(plan.contractSha256 ?? "")),
    snapshotManifestSha256: assertSha256(String(plan.snapshotManifestSha256 ?? "")),
    sourceDatabaseSha256: assertSha256(String(plan.sourceDatabaseSha256 ?? "")),
    sourceSchemaVersion: safeCount(plan.sourceSchemaVersion),
    sourceSchemaFingerprint: assertSha256(String(plan.sourceSchemaFingerprint ?? "")),
    chunkRows: safeCount(plan.chunkRows),
    tableCount: safeCount(plan.tableCount),
    columnCount: safeCount(plan.columnCount),
    totalRows: safeCount(plan.totalRows),
    importOrder: plan.importOrder.map((item) => String(item)),
    tables,
  };
  if (
    normalized.chunkRows < 1
    || normalized.chunkRows > 10_000
    || normalized.tableCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
    || normalized.columnCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns
    || normalized.tables.length !== normalized.tableCount
    || normalized.tables.reduce((total, table) => total + table.rowCount, 0) !== normalized.totalRows
    || JSON.stringify(normalized.importOrder) !== JSON.stringify(POSTGRES_MIGRATION_CONTRACT.importOrder)
    || JSON.stringify(normalized.tables.map((table) => table.name)) !== JSON.stringify(normalized.importOrder)
  ) {
    throw targetError("ARTIFACT_INVALID");
  }
  for (let index = 0; index < normalized.tables.length; index += 1) {
    const table = POSTGRES_MIGRATION_CONTRACT.tables.find((entry) => entry.name === normalized.tables[index]!.name);
    if (!table || table.columns.length !== normalized.tables[index]!.columnCount) {
      throw targetError("ARTIFACT_INVALID");
    }
    if (normalized.tables[index]!.chunks.some((chunk) => chunk.rowCount > normalized.chunkRows)) {
      throw targetError("ARTIFACT_INVALID");
    }
  }
  return normalized;
}

function validateTargetUrl(value: string): {
  readonly database: string;
  readonly digest: string;
  readonly password: string;
  readonly sourceUrlAuthority: { readonly hostname: string; readonly port: 5432 };
  readonly user: string;
} {
  try {
    const validated = parsePostgresRailwayStockLocalhostCaUrl(value);
    const parsed = new URL(validated.connectionString);
    const user = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    if (
      user.length < 1
      || user.length > 128
      || password.length < 1
      || password.length > 4096
      || database.length < 1
      || database.length > 128
      || /[\u0000\r\n]/.test(user)
      || /[\u0000\r\n]/.test(password)
      || /[\u0000\r\n/]/.test(database)
    ) throw new Error("unsafe_decoded_url");
    return {
      database,
      digest: sha256PostgresMigrationBytes(value),
      password,
      sourceUrlAuthority: {
        hostname: validated.sourceUrlAuthority.hostname,
        port: 5432 as const,
      },
      user,
    };
  } catch {
    throw targetError("TARGET_UNSAFE");
  }
}

function transportAuthoritySha256(input: {
  readonly targetUrl: string;
  readonly expectedRootCaDerSha256: string;
}): string {
  const validated = validateTargetUrl(input.targetUrl);
  try {
    return sha256PostgresMigrationTransportAuthority({
      expectedRootCaDerSha256: input.expectedRootCaDerSha256,
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      sourceUrlAuthority: validated.sourceUrlAuthority,
    });
  } catch {
    throw targetError("ARGUMENT_INVALID");
  }
}

interface DirectPostgresMigrationDependencies {
  readonly createPgClient: (config: ClientConfig) => Client;
  readonly getUid: () => number | null;
  readonly getEuid: () => number | null;
  readonly openTransport: typeof openPostgresRailwayStockLocalhostCaTransport;
}

const DIRECT_POSTGRES_MIGRATION_DEPENDENCIES: DirectPostgresMigrationDependencies = {
  createPgClient: (config) => new Client(config),
  getUid: () => process.getuid?.() ?? null,
  getEuid: () => process.geteuid?.() ?? null,
  openTransport: openPostgresRailwayStockLocalhostCaTransport,
};

function currentEffectiveUid(
  dependencies: DirectPostgresMigrationDependencies,
): number {
  const uid = dependencies.getUid();
  const euid = dependencies.getEuid();
  if (uid === null || euid === null || uid !== euid || !Number.isSafeInteger(uid) || uid < 0) {
    throw targetError("TARGET_UNSAFE");
  }
  return uid;
}

function assertExactTransport(
  transport: PostgresRailwayStockLocalhostCaTransport,
  input: {
    readonly expectedRootCaDerSha256: string;
    readonly sourceUrlAuthority: { readonly hostname: string; readonly port: number };
  },
): void {
  if (
    transport.profile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE
    || transport.rootCaDerSha256 !== input.expectedRootCaDerSha256
    || transport.sourceUrlAuthority.hostname !== input.sourceUrlAuthority.hostname
    || transport.sourceUrlAuthority.port !== input.sourceUrlAuthority.port
    || transport.resolvedAddress !== transport.nodeConnection.host
    || !transport.resolvedAddress.toLowerCase().startsWith("fd12:")
    || transport.nodeConnection.port !== 5432
    || transport.nodeConnection.ssl.servername !== "localhost"
    || transport.nodeConnection.ssl.rejectUnauthorized !== true
    || transport.nodeConnection.ssl.minVersion !== "TLSv1.2"
    || transport.nodeConnection.ssl.checkServerIdentity
      !== checkPostgresRailwayStockLocalhostServerIdentity
  ) throw targetError("TARGET_UNSAFE");
}

class DirectPostgresMigrationConnection implements CloseableTargetConnection {
  private constructor(
    private readonly client: Client,
    private readonly transport: PostgresRailwayStockLocalhostCaTransport,
  ) {}

  static async connect(input: {
    readonly targetUrl: string;
    readonly rootCaFile: string;
    readonly expectedRootCaDerSha256: string;
  }, dependencies: DirectPostgresMigrationDependencies =
  DIRECT_POSTGRES_MIGRATION_DEPENDENCIES): Promise<DirectPostgresMigrationConnection> {
    const validated = validateTargetUrl(input.targetUrl);
    const uid = currentEffectiveUid(dependencies);
    let transport: PostgresRailwayStockLocalhostCaTransport | null = null;
    let client: Client | null = null;
    try {
      transport = await dependencies.openTransport({
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaFile: input.rootCaFile,
        expectedRootCaDerSha256: input.expectedRootCaDerSha256,
        expectedUid: uid,
        sourceUrlAuthority: validated.sourceUrlAuthority,
      });
      assertExactTransport(transport, {
        expectedRootCaDerSha256: input.expectedRootCaDerSha256,
        sourceUrlAuthority: validated.sourceUrlAuthority,
      });
      await transport.assertExact();
      const config: ClientConfig = {
        application_name: "pintpath-postgres-migration",
        connectionTimeoutMillis: 10_000,
        database: validated.database,
        host: transport.nodeConnection.host,
        options: `-c role=${MIGRATOR_ROLE}`,
        password: validated.password,
        port: transport.nodeConnection.port,
        query_timeout: 120_000,
        ssl: transport.nodeConnection.ssl,
        user: validated.user,
      };
      if (Object.hasOwn(config, "connectionString")) throw targetError("TARGET_UNSAFE");
      client = dependencies.createPgClient(config);
      await client.connect();
      await transport.assertExact();
      await client.query(`/* pintpath:migration:session-hardening */
        SET statement_timeout = '120s';
        SET lock_timeout = '10s';
        SET idle_in_transaction_session_timeout = '30s';
        SET search_path = ${APPLICATION_SCHEMA}, pg_catalog`);
      await transport.assertExact();
      return new DirectPostgresMigrationConnection(client, transport);
    } catch {
      if (client) {
        try { await client.end(); } catch { /* keep the safe error */ }
      }
      if (transport) {
        try { await transport.close(); } catch { /* keep the safe error */ }
      }
      throw targetError("TARGET_UNSAFE");
    }
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresMigrationTargetQueryResult<Row>> {
    await this.transport.assertExact().catch(() => { throw targetError("TARGET_UNSAFE"); });
    const result = await this.client.query<Row>(text, [...values]);
    await this.transport.assertExact().catch(() => { throw targetError("TARGET_UNSAFE"); });
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async close(): Promise<void> {
    let exact = true;
    try { await this.transport.assertExact(); } catch { exact = false; }
    try { await this.client.end(); } catch { exact = false; }
    try { await this.transport.close(); } catch { exact = false; }
    if (!exact) throw targetError("TARGET_UNSAFE");
  }
}

function quoteIdentifier(identifier: string, allowed: ReadonlySet<string>): string {
  if (!allowed.has(identifier) || !/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw targetError("ARTIFACT_INVALID");
  }
  return `"${identifier}"`;
}

function tableIdentifiers(table: PostgresMigrationTableContract): {
  readonly table: string;
  readonly columns: ReadonlySet<string>;
} {
  const columns = new Set(table.columns.map((column) => column[0]));
  const tables = new Set(POSTGRES_MIGRATION_CONTRACT.tables.map((entry) => entry.name));
  return { table: quoteIdentifier(table.name, tables), columns };
}

function updateLengthFramed(hash: crypto.Hash, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function canonicalRawKey(values: readonly unknown[]): Buffer {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-source-primary-key-v1");
  for (const value of values) {
    if (value === null) updateLengthFramed(hash, "N");
    else if (Buffer.isBuffer(value)) updateLengthFramed(hash, `X${value.toString("base64")}`);
    else if (typeof value === "bigint") updateLengthFramed(hash, `I${value}`);
    else if (typeof value === "number") {
      const bytes = Buffer.allocUnsafe(8);
      bytes.writeDoubleBE(value);
      updateLengthFramed(hash, `F${bytes.toString("hex")}`);
    } else if (typeof value === "string") updateLengthFramed(hash, `T${value}`);
    else throw targetError("SOURCE_DATA_INVALID");
  }
  return hash.digest();
}

function canonicalRow(table: PostgresMigrationTableContract, row: Record<string, unknown>): Buffer {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-postgres-transformed-row-v1");
  updateLengthFramed(hash, table.name);
  for (const column of table.columns) {
    updateLengthFramed(hash, column[0]);
    try {
      updateLengthFramed(hash, postgresMigrationSourceInternals.canonicalSourceValue(row[column[0]], column));
    } catch {
      throw targetError("SOURCE_DATA_INVALID");
    }
  }
  return hash.digest();
}

function transformedChunkSha256(
  contractSha256: string,
  tableName: string,
  ordinal: number,
  rows: readonly TransformedRow[],
): string {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-postgres-transformed-chunk-v1");
  updateLengthFramed(hash, contractSha256);
  updateLengthFramed(hash, tableName);
  updateLengthFramed(hash, String(ordinal));
  for (const row of rows) updateLengthFramed(hash, row.canonicalRow);
  return hash.digest("hex");
}

function beginTransformedTableHash(
  contractSha256: string,
  table: PostgresMigrationTableContract,
): crypto.Hash {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-postgres-transformed-table-v1");
  updateLengthFramed(hash, contractSha256);
  updateLengthFramed(hash, table.name);
  for (const column of table.columns) updateLengthFramed(hash, column[0]);
  return hash;
}

function targetCast(column: PostgresMigrationColumnContract): string {
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
}

function transformSourceValue(value: unknown, column: PostgresMigrationColumnContract): unknown {
  if (value === null) {
    if (!column[3]) throw targetError("SOURCE_DATA_INVALID");
    return null;
  }
  let canonical: string;
  try {
    canonical = postgresMigrationSourceInternals.canonicalSourceValue(value, column);
  } catch {
    throw targetError("SOURCE_DATA_INVALID");
  }
  switch (column[2]) {
    case "binary": return Buffer.from(value as Buffer);
    case "boolean": return canonical === "B1";
    case "calendar-month":
    case "text": return canonical.slice(1);
    case "decimal": return canonical.slice(1);
    case "float64": return value;
    case "integer": {
      const integer = value as bigint;
      if (integer < SIGNED_INT64_MIN || integer > SIGNED_INT64_MAX) throw targetError("SOURCE_DATA_INVALID");
      return integer.toString();
    }
    case "json-array":
    case "json-object": return canonical.slice(1);
    case "local-time":
      return canonical.slice(1);
    case "utc-instant": {
      const instant = canonical.slice(1);
      if (instant.startsWith("0000-")) throw targetError("SOURCE_DATA_INVALID");
      return instant;
    }
  }
}

function targetValueToSource(value: unknown, column: PostgresMigrationColumnContract): unknown {
  if (value === null) {
    if (!column[3]) throw targetError("TARGET_CHANGED");
    return null;
  }
  try {
    switch (column[2]) {
      case "binary":
        if (!Buffer.isBuffer(value)) throw new Error("type");
        return Buffer.from(value);
      case "boolean":
        if (typeof value !== "boolean") throw new Error("type");
        return value ? 1n : 0n;
      case "calendar-month":
      case "text":
      case "json-array":
      case "json-object":
      case "local-time":
      case "utc-instant":
        if (typeof value !== "string") throw new Error("type");
        return value;
      case "decimal": {
        if (typeof value !== "string") throw new Error("type");
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error("range");
        if (
          postgresMigrationSourceInternals.normalizeExactDecimalToken(value)
          !== postgresMigrationSourceInternals.normalizeExactDecimalToken(number.toString())
        ) {
          throw new Error("precision");
        }
        return number;
      }
      case "float64": {
        const number = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(number)) throw new Error("range");
        return number;
      }
      case "integer": {
        if (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") {
          throw new Error("type");
        }
        const integer = BigInt(value);
        if (integer < SIGNED_INT64_MIN || integer > SIGNED_INT64_MAX) throw new Error("range");
        return integer;
      }
    }
  } catch {
    throw targetError("TARGET_CHANGED");
  }
}

function transformSourceRow(
  table: PostgresMigrationTableContract,
  raw: Record<string, unknown>,
): TransformedRow {
  const primaryKey = table.columns
    .filter((column) => column[4] > 0)
    .sort((left, right) => left[4] - right[4]);
  return {
    raw,
    target: table.columns.map((column) => transformSourceValue(raw[column[0]], column)),
    canonicalRow: canonicalRow(table, raw),
    primaryKeySha256: canonicalRawKey(primaryKey.map((column) => raw[column[0]])).toString("hex"),
  };
}

function sourceSelect(table: PostgresMigrationTableContract): string {
  const identifiers = tableIdentifiers(table);
  const primaryKey = table.columns
    .filter((column) => column[4] > 0)
    .sort((left, right) => left[4] - right[4]);
  const select = table.columns.map((column) => quoteIdentifier(column[0], identifiers.columns)).join(", ");
  const order = primaryKey.map((column) => (
    column[1] === "TEXT"
      ? `${quoteIdentifier(column[0], identifiers.columns)} COLLATE BINARY ASC`
      : `${quoteIdentifier(column[0], identifiers.columns)} ASC`
  )).join(", ");
  return `SELECT ${select} FROM ${identifiers.table} ORDER BY ${order}`;
}

function readSourceChunks(
  database: BetterSqlite3.Database,
  table: PostgresMigrationTableContract,
  planTable: PostgresMigrationPlanTable,
  contractSha256: string,
): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  const iterator = database.prepare(sourceSelect(table)).safeIntegers(true).iterate() as IterableIterator<Record<string, unknown>>;
  let rows: TransformedRow[] = [];
  let ordinal = 0;
  for (const raw of iterator) {
    rows.push(transformSourceRow(table, raw));
    if (rows.length === (planTable.chunks[ordinal]?.rowCount ?? Number.POSITIVE_INFINITY)) {
      const planned = planTable.chunks[ordinal];
      if (!planned) throw targetError("PLAN_MISMATCH");
      const digest = transformedChunkSha256(contractSha256, table.name, ordinal, rows);
      if (
        digest !== planned.transformedSha256
        || rows[0]?.primaryKeySha256 !== planned.firstPrimaryKeySha256
        || rows.at(-1)?.primaryKeySha256 !== planned.lastPrimaryKeySha256
      ) {
        throw targetError("PLAN_MISMATCH");
      }
      chunks.push({ plan: planned, rows, transformedSha256: digest });
      rows = [];
      ordinal += 1;
    }
  }
  if (rows.length > 0 || ordinal !== planTable.chunks.length) throw targetError("PLAN_MISMATCH");
  if (planTable.rowCount === 0 && chunks.length !== 0) throw targetError("PLAN_MISMATCH");
  return chunks;
}

function targetProjection(table: PostgresMigrationTableContract): string {
  const { columns } = tableIdentifiers(table);
  return table.columns.map((column) => {
    const identifier = quoteIdentifier(column[0], columns);
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
  return table.columns
    .filter((column) => column[4] > 0)
    .sort((left, right) => left[4] - right[4]);
}

function targetRowFromResult(
  table: PostgresMigrationTableContract,
  result: Record<string, unknown>,
): TransformedRow {
  const raw = Object.fromEntries(
    table.columns.map((column) => [column[0], targetValueToSource(result[column[0]], column)]),
  );
  return transformSourceRow(table, raw);
}

async function fetchTargetRowsForSourceRows(
  connection: PostgresMigrationTargetConnection,
  table: PostgresMigrationTableContract,
  sourceRows: readonly TransformedRow[],
): Promise<TransformedRow[]> {
  if (sourceRows.length === 0) return [];
  const keys = primaryKeyColumns(table);
  const { table: tableIdentifier, columns } = tableIdentifiers(table);
  const output = new Map<string, TransformedRow>();
  const rowsPerQuery = Math.max(1, Math.floor(MAX_KEY_PARAMETERS / keys.length));
  for (let offset = 0; offset < sourceRows.length; offset += rowsPerQuery) {
    const batch = sourceRows.slice(offset, offset + rowsPerQuery);
    const values: unknown[] = [];
    const predicates = batch.map((row) => {
      const clauses = keys.map((column) => {
        const sourceColumnIndex = table.columns.findIndex((entry) => entry[0] === column[0]);
        values.push(row.target[sourceColumnIndex]);
        return `${quoteIdentifier(column[0], columns)} = $${values.length}::${targetCast(column)}`;
      });
      return `(${clauses.join(" AND ")})`;
    });
    const result = await connection.query(
      `/* pintpath:migration:fetch-target-chunk */
       SELECT ${targetProjection(table)}
       FROM ${APPLICATION_SCHEMA}.${tableIdentifier}
       WHERE ${predicates.join(" OR ")}`,
      values,
    );
    for (const raw of result.rows) {
      const transformed = targetRowFromResult(table, raw);
      if (output.has(transformed.primaryKeySha256)) throw targetError("TARGET_CHANGED");
      output.set(transformed.primaryKeySha256, transformed);
    }
  }
  return sourceRows.map((source) => {
    const target = output.get(source.primaryKeySha256);
    if (!target) throw targetError("TARGET_CHANGED");
    return target;
  });
}

async function countExistingTargetRows(
  connection: PostgresMigrationTargetConnection,
  table: PostgresMigrationTableContract,
  sourceRows: readonly TransformedRow[],
): Promise<number> {
  if (sourceRows.length === 0) return 0;
  try {
    const rows = await fetchTargetRowsForSourceRows(connection, table, sourceRows);
    return rows.length;
  } catch (error) {
    if (error instanceof PostgresMigrationTargetError && error.code === "TARGET_CHANGED") {
      const keys = primaryKeyColumns(table);
      const { table: tableIdentifier, columns } = tableIdentifiers(table);
      let count = 0;
      const rowsPerQuery = Math.max(1, Math.floor(MAX_KEY_PARAMETERS / keys.length));
      for (let offset = 0; offset < sourceRows.length; offset += rowsPerQuery) {
        const batch = sourceRows.slice(offset, offset + rowsPerQuery);
        const values: unknown[] = [];
        const predicates = batch.map((row) => `(${keys.map((column) => {
          const columnIndex = table.columns.findIndex((entry) => entry[0] === column[0]);
          values.push(row.target[columnIndex]);
          return `${quoteIdentifier(column[0], columns)} = $${values.length}::${targetCast(column)}`;
        }).join(" AND ")})`);
        const result = await connection.query<QueryResultRow & { rowCount: string }>(
          `/* pintpath:migration:count-target-keys */
           SELECT count(*)::text AS "rowCount"
           FROM ${APPLICATION_SCHEMA}.${tableIdentifier}
           WHERE ${predicates.join(" OR ")}`,
          values,
        );
        count += Number(result.rows[0]?.rowCount ?? "0");
      }
      return count;
    }
    throw error;
  }
}

async function insertSourceRows(
  connection: PostgresMigrationTargetConnection,
  table: PostgresMigrationTableContract,
  rows: readonly TransformedRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const { table: tableIdentifier, columns } = tableIdentifiers(table);
  const columnSql = table.columns.map((column) => quoteIdentifier(column[0], columns)).join(", ");
  const primaryKeySql = primaryKeyColumns(table)
    .map((column) => quoteIdentifier(column[0], columns))
    .join(", ");
  const rowsPerInsert = Math.max(1, Math.floor(MAX_INSERT_PARAMETERS / table.columns.length));
  for (let offset = 0; offset < rows.length; offset += rowsPerInsert) {
    const batch = rows.slice(offset, offset + rowsPerInsert);
    const values: unknown[] = [];
    const tuples = batch.map((row) => `(${table.columns.map((column, columnIndex) => {
      values.push(row.target[columnIndex]);
      return `$${values.length}::${targetCast(column)}`;
    }).join(", ")})`);
    const result = await connection.query(
      `/* pintpath:migration:insert-target-chunk */
       INSERT INTO ${APPLICATION_SCHEMA}.${tableIdentifier} (${columnSql})
       VALUES ${tuples.join(", ")}
       ON CONFLICT (${primaryKeySql}) DO NOTHING`,
      values,
    );
    if (result.rowCount !== batch.length) throw targetError("TARGET_CHANGED");
  }
}

function hashTargetChunk(
  contractSha256: string,
  table: PostgresMigrationTableContract,
  ordinal: number,
  rows: readonly TransformedRow[],
): string {
  return transformedChunkSha256(contractSha256, table.name, ordinal, rows);
}

async function inTransaction<Result>(
  connection: PostgresMigrationTargetConnection,
  work: () => Promise<Result>,
): Promise<Result> {
  await connection.query("/* pintpath:migration:begin */ BEGIN");
  try {
    const result = await work();
    await connection.query("/* pintpath:migration:commit */ COMMIT");
    return result;
  } catch (error) {
    try { await connection.query("/* pintpath:migration:rollback */ ROLLBACK"); } catch { /* keep original */ }
    throw error;
  }
}

function expectedPostgresType(column: PostgresMigrationColumnContract): string {
  return targetCast(column);
}

async function inspectTargetIdentity(
  connection: PostgresMigrationTargetConnection,
): Promise<{
  readonly digest: string;
  readonly identity: PostgresMigrationTargetIdentity;
  readonly row: TargetIdentityRow;
}> {
  const result = await connection.query<TargetIdentityRow>(`/* pintpath:migration:target-identity */
    SELECT
      control.system_identifier::text AS "systemIdentifier",
      database.oid::text AS "databaseOid",
      current_database() AS "databaseName",
      session_user AS "sessionUser",
      current_user AS "currentUser",
      current_setting('server_version_num') AS "serverVersionNum",
      login_role.rolsuper AS "sessionSuperuser",
      active_role.rolsuper AS "currentSuperuser",
      login_role.rolbypassrls AS "sessionBypassRls",
      active_role.rolbypassrls AS "currentBypassRls",
      (
        current_user = '${MIGRATOR_ROLE}'
        AND session_user <> current_user
      ) AS "activeRoleExact",
      (
        login_role.rolcanlogin
        AND NOT login_role.rolsuper
        AND NOT login_role.rolcreatedb
        AND NOT login_role.rolcreaterole
        AND NOT login_role.rolinherit
        AND NOT login_role.rolreplication
        AND NOT login_role.rolbypassrls
        AND login_role.rolconnlimit = 1
        AND login_role.rolvaliduntil > pg_catalog.clock_timestamp()
        AND login_role.rolvaliduntil <= pg_catalog.clock_timestamp() + interval '24 hours'
      ) AS "loginAttributesSafe",
      COALESCE((
        SELECT pg_catalog.count(*) = 1
          AND pg_catalog.bool_and(
            granted.rolname = '${MIGRATOR_ROLE}'
            AND NOT membership.admin_option
            AND NOT membership.inherit_option
            AND membership.set_option
          )
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
        WHERE membership.member = login_role.oid
      ), false) AS "loginMembershipExact",
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
      ) AS "migratorRoleSafe",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = active_role.oid
      ) AS "migratorRoleParentsAbsent",
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
      ), false) AS "migratorRoleChildrenExact",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.roleid = login_role.oid
      ) AS "loginRoleChildrenAbsent",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_db_role_setting AS setting
        WHERE setting.setrole IN (login_role.oid, active_role.oid)
      ) AS "roleSettingsAbsent",
      (
        has_database_privilege(login_role.oid, database.oid, 'CONNECT')
        AND NOT has_database_privilege(login_role.oid, database.oid, 'CREATE')
        AND NOT has_database_privilege(login_role.oid, database.oid, 'TEMP')
        AND COALESCE((
          SELECT pg_catalog.count(*) = 1
            AND pg_catalog.bool_and(
              privilege.privilege_type = 'CONNECT'
              AND NOT privilege.is_grantable
            )
          FROM LATERAL pg_catalog.aclexplode(
            COALESCE(database.datacl, pg_catalog.acldefault('d', database.datdba))
          ) AS privilege
          WHERE privilege.grantee = login_role.oid
        ), false)
      ) AS "databaseAuthorityExact",
      (
        NOT has_database_privilege(active_role.oid, database.oid, 'CREATE')
        AND NOT has_database_privilege(active_role.oid, database.oid, 'TEMP')
        AND NOT EXISTS (
          SELECT 1
          FROM LATERAL pg_catalog.aclexplode(
            COALESCE(database.datacl, pg_catalog.acldefault('d', database.datdba))
          ) AS privilege
          WHERE privilege.grantee = active_role.oid
        )
      ) AS "migratorDatabaseAuthorityExact",
      COALESCE((
        SELECT pg_catalog.count(*) = 2
          AND pg_catalog.bool_and(
            namespace.nspname IN ('${APPLICATION_SCHEMA}', '${OPERATIONS_SCHEMA}')
            AND privilege.privilege_type = 'USAGE'
            AND NOT privilege.is_grantable
          )
        FROM pg_catalog.pg_namespace AS namespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
        ) AS privilege
        WHERE privilege.grantee = active_role.oid
      ), false) AS "migratorSchemaAuthorityExact",
      COALESCE((
        SELECT pg_catalog.count(*) = ${POSTGRES_MIGRATION_CONTRACT.tables.length * 2 + 9}
          AND pg_catalog.bool_and(
            NOT privilege.is_grantable
            AND (
              (
                namespace.nspname = '${APPLICATION_SCHEMA}'
                AND relation.relname = ANY(ARRAY[${POSTGRES_MIGRATION_CONTRACT.tables.map((table) => `'${table.name.replaceAll("'", "''")}'`).join(", ")}])
                AND privilege.privilege_type IN ('SELECT', 'INSERT')
              )
              OR (
                namespace.nspname = '${APPLICATION_SCHEMA}'
                AND relation.relname = 'schema_metadata'
                AND privilege.privilege_type IN ('SELECT', 'UPDATE')
              )
              OR (
                namespace.nspname = '${OPERATIONS_SCHEMA}'
                AND relation.relname IN ('migration_runs', 'migration_chunks')
                AND privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
              )
              OR (
                namespace.nspname = '${OPERATIONS_SCHEMA}'
                AND relation.relname = 'migration_verifier_authority'
                AND privilege.privilege_type = 'SELECT'
              )
            )
          )
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(relation.relacl, pg_catalog.acldefault(
            CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
            relation.relowner
          ))
        ) AS privilege
        WHERE privilege.grantee = active_role.oid
          AND relation.relkind IN ('r', 'p', 'S', 'v', 'm')
      ), false) AS "migratorTableAuthorityExact",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
        WHERE attribute.attacl IS NOT NULL
          AND privilege.grantee = active_role.oid
      ) AS "migratorColumnPrivilegesAbsent",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS routine
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        ) AS privilege
        WHERE privilege.grantee = active_role.oid
      ) AS "migratorRoutinePrivilegesAbsent",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS sequence
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(sequence.relacl, pg_catalog.acldefault('S', sequence.relowner))
        ) AS privilege
        WHERE sequence.relkind = 'S'
          AND privilege.grantee = active_role.oid
      ) AS "migratorSequencePrivilegesAbsent",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_shdepend AS dependency
        WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          AND dependency.refobjid = login_role.oid
          AND dependency.deptype = 'a'
          AND NOT (
            dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
            AND dependency.objid = database.oid
          )
      ) AS "unsafeDirectLoginAclAbsent",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_shdepend AS dependency
        WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          AND dependency.refobjid = active_role.oid
          AND dependency.deptype = 'a'
          AND NOT (
            dependency.dbid = database.oid
            AND (
              (
                dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
                AND dependency.objid IN (application_namespace.oid, operations_namespace.oid)
              )
              OR (
                dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                AND EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_class AS allowed_relation
                  WHERE allowed_relation.oid = dependency.objid
                    AND (
                      (
                        allowed_relation.relnamespace = application_namespace.oid
                        AND (
                          allowed_relation.relname = 'schema_metadata'
                          OR allowed_relation.relname = ANY(ARRAY[${POSTGRES_MIGRATION_CONTRACT.tables.map((table) => `'${table.name.replaceAll("'", "''")}'`).join(", ")}])
                        )
                      )
                      OR (
                        allowed_relation.relnamespace = operations_namespace.oid
                        AND allowed_relation.relname IN (
                          'migration_runs',
                          'migration_chunks',
                          'migration_verifier_authority'
                        )
                      )
                    )
                )
              )
            )
          )
      ) AS "unsafeDirectMigratorAclAbsent",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_shdepend AS dependency
        WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          AND dependency.refobjid IN (login_role.oid, active_role.oid)
          AND dependency.deptype = 'o'
      ) AS "roleOwnershipAbsent",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl AS defaults
        WHERE defaults.defaclrole IN (login_role.oid, active_role.oid)
      ) AS "defaultPrivilegesAbsent",
      (
        NOT verifier_authority_role.rolcanlogin
        AND NOT verifier_authority_role.rolsuper
        AND NOT verifier_authority_role.rolcreatedb
        AND NOT verifier_authority_role.rolcreaterole
        AND verifier_authority_role.rolinherit
        AND NOT verifier_authority_role.rolreplication
        AND NOT verifier_authority_role.rolbypassrls
        AND verifier_authority_role.rolconnlimit = -1
        AND verifier_authority_role.rolvaliduntil IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.member = verifier_authority_role.oid
             OR membership.roleid = verifier_authority_role.oid
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_db_role_setting AS setting
          WHERE setting.setrole = verifier_authority_role.oid
        )
        AND NOT has_database_privilege(
          verifier_authority_role.oid, database.oid, 'CREATE'
        )
        AND NOT has_database_privilege(
          verifier_authority_role.oid, database.oid, 'TEMP'
        )
        AND has_schema_privilege(
          verifier_authority_role.oid, operations_namespace.oid, 'USAGE'
        )
        AND NOT has_schema_privilege(
          verifier_authority_role.oid, operations_namespace.oid, 'CREATE'
        )
        AND NOT has_schema_privilege(
          verifier_authority_role.oid, application_namespace.oid, 'USAGE'
        )
        AND COALESCE((
          SELECT pg_catalog.count(*) = 3
            AND pg_catalog.bool_and(
              relation.oid = 'pintpath_ops.migration_verifier_authority'::pg_catalog.regclass
              AND privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
              AND NOT privilege.is_grantable
            )
          FROM pg_catalog.pg_class AS relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
          ) AS privilege
          WHERE privilege.grantee = verifier_authority_role.oid
        ), false)
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
          WHERE attribute.attacl IS NOT NULL
            AND privilege.grantee = verifier_authority_role.oid
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc AS routine
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
          ) AS privilege
          WHERE privilege.grantee = verifier_authority_role.oid
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class AS sequence
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(sequence.relacl, pg_catalog.acldefault('S', sequence.relowner))
          ) AS privilege
          WHERE sequence.relkind = 'S'
            AND privilege.grantee = verifier_authority_role.oid
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
          WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            AND dependency.refobjid = verifier_authority_role.oid
            AND dependency.deptype = 'o'
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_default_acl AS defaults
          WHERE defaults.defaclrole = verifier_authority_role.oid
        )
      ) AS "verifierAuthorityRoleBoundaryExact",
      COALESCE(pg_has_role(session_user, to_regrole('${MIGRATOR_ROLE}'), 'MEMBER'), false)
        AND COALESCE(pg_has_role(current_user, to_regrole('${MIGRATOR_ROLE}'), 'USAGE'), false)
        AS "migratorMember",
      COALESCE(pg_has_role(session_user, to_regrole('${RUNTIME_ROLE}'), 'MEMBER'), false)
        AS "runtimeMember",
      has_schema_privilege(current_user, application_namespace.oid, 'USAGE') AS "applicationSchemaUsage",
      has_schema_privilege(current_user, operations_namespace.oid, 'USAGE') AS "operationsSchemaUsage",
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS forbidden_relation
        JOIN pg_catalog.pg_namespace AS forbidden_namespace
          ON forbidden_namespace.oid = forbidden_relation.relnamespace
        WHERE forbidden_namespace.nspname IN ('${APPLICATION_SCHEMA}', '${OPERATIONS_SCHEMA}')
          AND forbidden_relation.relkind IN ('r', 'p')
          AND (
            has_table_privilege(current_user, forbidden_relation.oid, 'DELETE')
            OR has_table_privilege(current_user, forbidden_relation.oid, 'TRUNCATE')
            OR (
              forbidden_namespace.nspname = '${APPLICATION_SCHEMA}'
              AND forbidden_relation.relname <> 'schema_metadata'
              AND has_table_privilege(current_user, forbidden_relation.oid, 'UPDATE')
            )
          )
      ) AS "forbiddenMutationPrivilege"
    FROM pg_catalog.pg_database AS database
    CROSS JOIN pg_catalog.pg_control_system() AS control
    JOIN pg_catalog.pg_roles AS login_role ON login_role.rolname = session_user
    JOIN pg_catalog.pg_roles AS active_role ON active_role.rolname = current_user
    JOIN pg_catalog.pg_roles AS verifier_authority_role
      ON verifier_authority_role.rolname = '${POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE}'
    JOIN pg_catalog.pg_namespace AS application_namespace ON application_namespace.nspname = '${APPLICATION_SCHEMA}'
    JOIN pg_catalog.pg_namespace AS operations_namespace ON operations_namespace.nspname = '${OPERATIONS_SCHEMA}'
    WHERE database.datname = current_database()`);
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) throw targetError("TARGET_UNSAFE");
  if (
    row.sessionSuperuser
    || row.currentSuperuser
    || row.sessionBypassRls
    || row.currentBypassRls
    || !row.activeRoleExact
    || !row.loginAttributesSafe
    || !row.loginMembershipExact
    || !row.migratorRoleSafe
    || !row.migratorRoleParentsAbsent
    || !row.migratorRoleChildrenExact
    || !row.loginRoleChildrenAbsent
    || !row.roleSettingsAbsent
    || !row.databaseAuthorityExact
    || !row.migratorDatabaseAuthorityExact
    || !row.migratorSchemaAuthorityExact
    || !row.migratorTableAuthorityExact
    || !row.migratorColumnPrivilegesAbsent
    || !row.migratorRoutinePrivilegesAbsent
    || !row.migratorSequencePrivilegesAbsent
    || !row.unsafeDirectLoginAclAbsent
    || !row.unsafeDirectMigratorAclAbsent
    || !row.roleOwnershipAbsent
    || !row.defaultPrivilegesAbsent
    || !row.verifierAuthorityRoleBoundaryExact
    || !row.migratorMember
    || row.runtimeMember
    || !row.applicationSchemaUsage
    || !row.operationsSchemaUsage
    || row.forbiddenMutationPrivilege
    || !/^\d+$/.test(row.systemIdentifier)
    || !/^\d+$/.test(row.databaseOid)
    || !/^\d+$/.test(row.serverVersionNum)
  ) {
    throw targetError("TARGET_UNSAFE");
  }
  const identity = {
      databaseName: row.databaseName,
      databaseOid: row.databaseOid,
      currentUser: row.currentUser,
      serverVersionNum: row.serverVersionNum,
      sessionUser: row.sessionUser,
      systemIdentifier: row.systemIdentifier,
  } satisfies PostgresMigrationTargetIdentity;
  return { digest: sha256PostgresMigrationTargetIdentity(identity), identity, row };
}

async function assertLiveSchema(
  connection: PostgresMigrationTargetConnection,
  inspect: NonNullable<PostgresMigrationTargetDependencies["inspectLiveSchema"]>
    = inspectPostgresMigrationLiveSchema,
): Promise<PostgresMigrationLiveSchemaInspection> {
  let inspection: PostgresMigrationLiveSchemaInspection;
  try {
    inspection = await inspect(connection);
  } catch {
    throw targetError("TARGET_UNSAFE");
  }
  if (
    inspection.sha256 !== POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_SHA256
    || inspection.objectCount !== POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_OBJECT_COUNT
  ) {
    throw targetError("TARGET_UNSAFE");
  }
  return inspection;
}

async function inspectTargetSchema(
  connection: PostgresMigrationTargetConnection,
): Promise<{ readonly tableCount: number; readonly columnCount: number; readonly foreignKeyCount: number }> {
  const columnsResult = await connection.query<TargetColumnRow>(`/* pintpath:migration:target-columns */
    SELECT
      relation.relname AS "tableName",
      attribute.attname AS "columnName",
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS "dataType",
      attribute.attnum::integer AS "ordinalPosition",
      NOT attribute.attnotnull AS "isNullable",
      relation.relrowsecurity AS "rlsEnabled",
      relation.relforcerowsecurity AS "rlsForced"
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = '${APPLICATION_SCHEMA}'
      AND relation.relkind IN ('r', 'p')
      AND relation.relname <> 'schema_metadata'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY relation.relname, attribute.attnum`);
  const expectedRows = POSTGRES_MIGRATION_CONTRACT.tables.flatMap((table) => table.columns.map((column, index) => ({
    tableName: table.name,
    columnName: column[0],
    dataType: expectedPostgresType(column),
    ordinalPosition: index + 1,
    isNullable: column[3],
  }))).sort((left, right) => compareStrings(left.tableName, right.tableName) || left.ordinalPosition - right.ordinalPosition);
  const actualRows = [...columnsResult.rows].sort(
    (left, right) => compareStrings(left.tableName, right.tableName) || left.ordinalPosition - right.ordinalPosition,
  );
  if (actualRows.length !== expectedRows.length) throw targetError("TARGET_UNSAFE");
  for (let index = 0; index < expectedRows.length; index += 1) {
    const actual = actualRows[index]!;
    const expected = expectedRows[index]!;
    if (
      actual.tableName !== expected.tableName
      || actual.columnName !== expected.columnName
      || actual.dataType !== expected.dataType
      || actual.ordinalPosition !== expected.ordinalPosition
      || actual.isNullable !== expected.isNullable
      || !actual.rlsEnabled
      || !actual.rlsForced
    ) {
      throw targetError("TARGET_UNSAFE");
    }
  }
  const primaryKeysResult = await connection.query<TargetPrimaryKeyRow>(`/* pintpath:migration:target-primary-keys */
    SELECT
      relation.relname AS "tableName",
      attribute.attname AS "columnName",
      key_ordinal.ordinality::integer AS "primaryKeyPosition"
    FROM pg_catalog.pg_constraint AS constraint_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key_ordinal(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid AND attribute.attnum = key_ordinal.attnum
    WHERE namespace.nspname = '${APPLICATION_SCHEMA}'
      AND relation.relname <> 'schema_metadata'
      AND constraint_record.contype = 'p'
    ORDER BY relation.relname, key_ordinal.ordinality`);
  const expectedPrimaryKeys = POSTGRES_MIGRATION_CONTRACT.tables.flatMap((table) => table.columns
    .filter((column) => column[4] > 0)
    .map((column) => ({ tableName: table.name, columnName: column[0], primaryKeyPosition: column[4] })))
    .sort((left, right) => compareStrings(left.tableName, right.tableName) || left.primaryKeyPosition - right.primaryKeyPosition);
  const actualPrimaryKeys = [...primaryKeysResult.rows].sort(
    (left, right) => compareStrings(left.tableName, right.tableName) || left.primaryKeyPosition - right.primaryKeyPosition,
  );
  if (JSON.stringify(actualPrimaryKeys) !== JSON.stringify(expectedPrimaryKeys)) throw targetError("TARGET_UNSAFE");
  const constraints = await connection.query<TargetConstraintSummaryRow>(`/* pintpath:migration:target-constraints */
    SELECT
      count(*) FILTER (WHERE constraint_record.contype = 'f')::integer AS "foreignKeyCount",
      count(*) FILTER (WHERE NOT constraint_record.convalidated)::integer AS "unvalidatedCount"
    FROM pg_catalog.pg_constraint AS constraint_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = '${APPLICATION_SCHEMA}'
      AND relation.relname <> 'schema_metadata'
      AND constraint_record.contype IN ('c', 'f', 'p', 'u')`);
  const constraintSummary = constraints.rows[0];
  if (
    !constraintSummary
    || constraintSummary.foreignKeyCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys
    || constraintSummary.unvalidatedCount !== 0
  ) {
    throw targetError("TARGET_UNSAFE");
  }
  const controlTables = await connection.query<TargetControlTableRow>(`/* pintpath:migration:target-control-tables */
    SELECT
      namespace.nspname AS "schemaName",
      relation.relname AS "tableName",
      relation.relrowsecurity AS "rlsEnabled",
      relation.relforcerowsecurity AS "rlsForced"
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE (namespace.nspname = '${APPLICATION_SCHEMA}' AND relation.relname = 'schema_metadata')
       OR (namespace.nspname = '${OPERATIONS_SCHEMA}' AND relation.relname IN (
         'migration_runs', 'migration_chunks', 'migration_verifier_authority'
       ))
    ORDER BY namespace.nspname, relation.relname`);
  const expectedControlTables: TargetControlTableRow[] = [
    { schemaName: APPLICATION_SCHEMA, tableName: "schema_metadata", rlsEnabled: true, rlsForced: true },
    { schemaName: OPERATIONS_SCHEMA, tableName: "migration_chunks", rlsEnabled: true, rlsForced: true },
    { schemaName: OPERATIONS_SCHEMA, tableName: "migration_runs", rlsEnabled: true, rlsForced: true },
    { schemaName: OPERATIONS_SCHEMA, tableName: "migration_verifier_authority", rlsEnabled: true, rlsForced: true },
  ];
  if (JSON.stringify(controlTables.rows) !== JSON.stringify(expectedControlTables)) {
    throw targetError("TARGET_UNSAFE");
  }
  return {
    tableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
    columnCount: expectedRows.length,
    foreignKeyCount: constraintSummary.foreignKeyCount,
  };
}

function postgresForeignKeyAction(action: string): string {
  const actions: Readonly<Record<string, string>> = {
    "NO ACTION": "a",
    RESTRICT: "r",
    CASCADE: "c",
    "SET NULL": "n",
    "SET DEFAULT": "d",
  };
  const result = actions[action];
  if (!result) throw targetError("RECONCILIATION_FAILED");
  return result;
}

async function inspectTargetForeignKeys(
  connection: PostgresMigrationTargetConnection,
  descriptor: PostgresMigrationSchemaDescriptor,
): Promise<void> {
  const result = await connection.query<TargetForeignKeyRow>(`/* pintpath:migration:target-foreign-keys */
    SELECT
      child_relation.relname AS "childTable",
      parent_relation.relname AS "parentTable",
      child_attribute.attname AS "childColumn",
      parent_attribute.attname AS "parentColumn",
      child_key.ordinality::integer AS "columnPosition",
      constraint_record.confupdtype::text AS "onUpdate",
      constraint_record.confdeltype::text AS "onDelete",
      constraint_record.confmatchtype::text AS "matchType",
      constraint_record.condeferrable AS "deferrable"
    FROM pg_catalog.pg_constraint AS constraint_record
    JOIN pg_catalog.pg_class AS child_relation ON child_relation.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_namespace AS child_namespace ON child_namespace.oid = child_relation.relnamespace
    JOIN pg_catalog.pg_class AS parent_relation ON parent_relation.oid = constraint_record.confrelid
    CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS child_key(attnum, ordinality)
    JOIN LATERAL unnest(constraint_record.confkey) WITH ORDINALITY AS parent_key(attnum, ordinality)
      ON parent_key.ordinality = child_key.ordinality
    JOIN pg_catalog.pg_attribute AS child_attribute
      ON child_attribute.attrelid = child_relation.oid AND child_attribute.attnum = child_key.attnum
    JOIN pg_catalog.pg_attribute AS parent_attribute
      ON parent_attribute.attrelid = parent_relation.oid AND parent_attribute.attnum = parent_key.attnum
    WHERE child_namespace.nspname = '${APPLICATION_SCHEMA}'
      AND constraint_record.contype = 'f'`);
  const expected = descriptor.tables.flatMap((table) => table.foreignKeys.map((foreignKey) => ({
    childTable: table.name,
    parentTable: foreignKey.table,
    childColumn: foreignKey.from,
    parentColumn: foreignKey.to,
    columnPosition: foreignKey.seq + 1,
    onUpdate: postgresForeignKeyAction(foreignKey.on_update),
    onDelete: postgresForeignKeyAction(foreignKey.on_delete),
    matchType: foreignKey.match === "NONE" ? "s" : foreignKey.match.toLowerCase().slice(0, 1),
    deferrable: false,
  })));
  const compare = (left: TargetForeignKeyRow, right: TargetForeignKeyRow) => (
    compareStrings(left.childTable, right.childTable)
    || compareStrings(left.parentTable, right.parentTable)
    || compareStrings(left.childColumn, right.childColumn)
    || compareStrings(left.parentColumn, right.parentColumn)
    || left.columnPosition - right.columnPosition
    || compareStrings(left.onUpdate, right.onUpdate)
    || compareStrings(left.onDelete, right.onDelete)
  );
  const actual = [...result.rows].sort(compare);
  expected.sort(compare);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw targetError("TARGET_UNSAFE");
  }
}

async function acquireMigrationLock(connection: PostgresMigrationTargetConnection): Promise<void> {
  const result = await connection.query<AdvisoryLockRow>(
    `/* pintpath:migration:lock */ SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
    [MIGRATION_LOCK_KEY],
  );
  if (result.rows[0]?.acquired !== true) throw targetError("TARGET_BUSY");
}

async function releaseMigrationLock(connection: PostgresMigrationTargetConnection): Promise<void> {
  try {
    await connection.query(
      `/* pintpath:migration:unlock */ SELECT pg_advisory_unlock($1::bigint)`,
      [MIGRATION_LOCK_KEY],
    );
  } catch {
    // Closing the single connection releases the session advisory lock.
  }
}

async function loadVerifierAuthority(
  connection: PostgresMigrationTargetConnection,
  expectedEnvironment: PostgresMigrationEnvironment,
  candidateSha: string,
): Promise<PostgresMigrationVerifierAuthority> {
  const result = await connection.query<VerifierAuthorityRow>(
    `/* pintpath:migration:load-independent-verifier-authority */
     SELECT
       expected_environment AS "expectedEnvironment",
       candidate_commit_sha AS "candidateSha",
       operator_id_sha256 AS "operatorIdSha256",
       verifier_id_sha256 AS "verifierIdSha256",
       verifier_public_key_sha256 AS "verifierPublicKeySha256",
       authority_policy_sha256 AS "authorityPolicySha256",
       authority_sha256 AS "authoritySha256",
       installed_at AS "installedAt"
     FROM ${OPERATIONS_SCHEMA}.migration_verifier_authority
     WHERE authority_id = 'active'
     ORDER BY authority_id`,
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1 || result.rowCount !== 1) {
    throw targetError("TARGET_UNSAFE");
  }
  let authority: PostgresMigrationVerifierAuthority;
  try {
    authority = postgresMigrationVerifierAuthoritySchema.parse({
      expectedEnvironment: row.expectedEnvironment,
      candidateSha: row.candidateSha,
      operatorIdSha256: row.operatorIdSha256,
      verifierIdSha256: row.verifierIdSha256,
      verifierPublicKeySha256: row.verifierPublicKeySha256,
      authorityPolicySha256: row.authorityPolicySha256,
      authoritySha256: row.authoritySha256,
      installedAt: row.installedAt instanceof Date
        ? row.installedAt.toISOString()
        : row.installedAt,
    });
  } catch {
    throw targetError("TARGET_UNSAFE");
  }
  if (
    authority.expectedEnvironment !== expectedEnvironment
    || authority.candidateSha !== candidateSha
    || authority.authorityPolicySha256
      !== POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256
  ) throw targetError("IDENTITY_MISMATCH");
  return authority;
}

async function assertVerifierAuthorityUnchanged(
  connection: PostgresMigrationTargetConnection,
  expected: PostgresMigrationVerifierAuthority,
): Promise<void> {
  const observed = await loadVerifierAuthority(
    connection,
    expected.expectedEnvironment,
    expected.candidateSha,
  );
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw targetError("TARGET_CHANGED");
  }
}

async function loadMetadata(connection: PostgresMigrationTargetConnection): Promise<Map<string, string>> {
  const result = await connection.query<MetadataRow>(`/* pintpath:migration:metadata */
    SELECT key, value FROM ${APPLICATION_SCHEMA}.schema_metadata ORDER BY key`);
  const metadata = new Map<string, string>();
  for (const row of result.rows) {
    if (metadata.has(row.key)) throw targetError("TARGET_UNSAFE");
    metadata.set(row.key, row.value);
  }
  if (metadata.get("schema_version") !== "1" || !metadata.has("import_state")) {
    throw targetError("TARGET_UNSAFE");
  }
  return metadata;
}

async function loadTableCounts(connection: PostgresMigrationTargetConnection): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of POSTGRES_MIGRATION_CONTRACT.tables) {
    const { table: tableIdentifier } = tableIdentifiers(table);
    const result = await connection.query<QueryResultRow & { rowCount: string }>(
      `/* pintpath:migration:table-count */ SELECT count(*)::text AS "rowCount" FROM ${APPLICATION_SCHEMA}.${tableIdentifier}`,
    );
    const value = result.rows[0]?.rowCount;
    if (!value || !/^\d+$/.test(value)) throw targetError("TARGET_UNSAFE");
    const count = Number(value);
    if (!Number.isSafeInteger(count)) throw targetError("TARGET_UNSAFE");
    counts.set(table.name, count);
  }
  return counts;
}

async function loadMigrationRuns(connection: PostgresMigrationTargetConnection): Promise<MigrationRunRow[]> {
  const result = await connection.query<MigrationRunRow>(`/* pintpath:migration:runs */
    SELECT
      run_id AS "runId",
      source_snapshot_sha256 AS "sourceSnapshotSha256",
      source_schema_fingerprint AS "sourceSchemaFingerprint",
      contract_sha256 AS "contractSha256",
      manifest_sha256 AS "manifestSha256",
      target_ddl_sha256 AS "targetDdlSha256",
      source_schema_version AS "sourceSchemaVersion",
      candidate_commit_sha AS "candidateSha",
      target_binding_sha256 AS "targetBindingSha256",
      expected_environment AS "expectedEnvironment",
      approval_reference_sha256 AS "approvalReferenceSha256",
      operator_id_sha256 AS "operatorIdSha256",
      verifier_id_sha256 AS "verifierIdSha256",
      status,
      receipt_sha256 AS "receiptSha256",
      failure_code AS "failureCode"
    FROM ${OPERATIONS_SCHEMA}.migration_runs
    ORDER BY run_id`);
  return result.rows;
}

function assertExactRun(run: MigrationRunRow, context: TargetContext, environment: PostgresMigrationEnvironment): void {
  if (
    run.runId !== context.runId
    || run.sourceSnapshotSha256 !== context.manifest.database.sha256
    || run.sourceSchemaFingerprint !== context.manifest.schema.fingerprint
    || run.contractSha256 !== context.contractSha256
    || run.manifestSha256 !== context.manifestSha256
    || run.targetDdlSha256 !== context.targetDdlSha256
    || run.sourceSchemaVersion !== context.manifest.schema.sourceVersion
    || run.candidateSha !== context.plan.candidateSha
    || run.targetBindingSha256 !== context.targetBindingSha256
    || run.expectedEnvironment !== environment
    || run.approvalReferenceSha256 !== context.approvalReferenceSha256
    || run.operatorIdSha256 !== context.operatorIdSha256
    || (run.verifierIdSha256 !== null && run.verifierIdSha256 !== context.verifierIdSha256)
  ) {
    throw targetError("RESUME_MISMATCH");
  }
}

async function createMigrationRun(
  connection: PostgresMigrationTargetConnection,
  context: TargetContext,
  environment: PostgresMigrationEnvironment,
): Promise<void> {
  await inTransaction(connection, async () => {
    const inserted = await connection.query(
      `/* pintpath:migration:create-run */
       INSERT INTO ${OPERATIONS_SCHEMA}.migration_runs (
         run_id, source_snapshot_sha256, source_schema_fingerprint, contract_sha256,
         manifest_sha256, target_ddl_sha256, source_schema_version, candidate_commit_sha,
         target_binding_sha256, expected_environment, approval_reference_sha256,
         operator_id_sha256, status, started_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'planned', clock_timestamp())`,
      [
        context.runId,
        context.manifest.database.sha256,
        context.manifest.schema.fingerprint,
        context.contractSha256,
        context.manifestSha256,
        context.targetDdlSha256,
        context.manifest.schema.sourceVersion,
        context.plan.candidateSha,
        context.targetBindingSha256,
        environment,
        context.approvalReferenceSha256,
        context.operatorIdSha256,
      ],
    );
    if (inserted.rowCount !== 1) throw targetError("IMPORT_FAILED");
    const updated = await connection.query(
      `/* pintpath:migration:set-import-state */
       UPDATE ${APPLICATION_SCHEMA}.schema_metadata
       SET value = 'importing', updated_at = clock_timestamp()
       WHERE key = 'import_state' AND value = 'empty'`,
    );
    if (updated.rowCount !== 1) throw targetError("TARGET_NOT_EMPTY");
  });
}

async function loadCompletedChunks(
  connection: PostgresMigrationTargetConnection,
  context: TargetContext,
): Promise<Map<string, MigrationChunkRow>> {
  const result = await connection.query<MigrationChunkRow>(`/* pintpath:migration:chunks */
    SELECT
      run_id AS "runId",
      table_name AS "tableName",
      chunk_ordinal AS "chunkOrdinal",
      row_count AS "rowCount",
      source_transformed_sha256 AS "sourceTransformedSha256",
      target_sha256 AS "targetSha256"
    FROM ${OPERATIONS_SCHEMA}.migration_chunks
    WHERE run_id = $1
    ORDER BY table_name, chunk_ordinal`, [context.runId]);
  const valid = new Set(context.plan.tables.flatMap((table) => table.chunks.map((chunk) => `${table.name}\0${chunk.ordinal}`)));
  const chunks = new Map<string, MigrationChunkRow>();
  for (const row of result.rows) {
    const key = `${row.tableName}\0${row.chunkOrdinal}`;
    if (row.runId !== context.runId || !valid.has(key) || chunks.has(key)) throw targetError("RESUME_MISMATCH");
    chunks.set(key, row);
  }
  return chunks;
}

async function updateRunStatus(
  connection: PostgresMigrationTargetConnection,
  runId: string,
  status: "importing" | "verifying",
): Promise<void> {
  const runUpdate = await connection.query(
    `/* pintpath:migration:update-run-status */
     UPDATE ${OPERATIONS_SCHEMA}.migration_runs
     SET status = $2, failure_code = NULL
     WHERE run_id = $1`,
    [runId, status],
  );
  if (runUpdate.rowCount !== 1) throw targetError("RESUME_MISMATCH");
  const metadataUpdate = await connection.query(
    `/* pintpath:migration:update-import-state */
     UPDATE ${APPLICATION_SCHEMA}.schema_metadata
     SET value = $1, updated_at = clock_timestamp()
     WHERE key = 'import_state'`,
    [status],
  );
  if (metadataUpdate.rowCount !== 1) throw targetError("TARGET_UNSAFE");
}

async function recordFailedRun(
  connection: PostgresMigrationTargetConnection,
  runId: string,
  code: PostgresMigrationTargetErrorCode,
): Promise<void> {
  try {
    await inTransaction(connection, async () => {
      await connection.query(
        `/* pintpath:migration:fail-run */
         UPDATE ${OPERATIONS_SCHEMA}.migration_runs
         SET status = 'failed', failure_code = $2, completed_at = clock_timestamp()
         WHERE run_id = $1`,
        [runId, code],
      );
      await connection.query(
        `/* pintpath:migration:fail-import-state */
         UPDATE ${APPLICATION_SCHEMA}.schema_metadata
         SET value = 'failed', updated_at = clock_timestamp()
         WHERE key = 'import_state'`,
      );
    });
  } catch {
    // The caller retains the original static error code.
  }
}

async function applyChunks(
  connection: PostgresMigrationTargetConnection,
  source: BetterSqlite3.Database,
  context: TargetContext,
  completed: Map<string, MigrationChunkRow>,
): Promise<void> {
  const contractByName = new Map<string, PostgresMigrationTableContract>(
    POSTGRES_MIGRATION_CONTRACT.tables.map((table) => [table.name, table]),
  );
  for (const planTable of context.plan.tables) {
    const table = contractByName.get(planTable.name);
    if (!table) throw targetError("PLAN_MISMATCH");
    const chunks = readSourceChunks(source, table, planTable, context.contractSha256);
    for (const chunk of chunks) {
      const key = `${table.name}\0${chunk.plan.ordinal}`;
      const checkpoint = completed.get(key);
      if (checkpoint) {
        if (
          checkpoint.rowCount !== chunk.rows.length
          || checkpoint.sourceTransformedSha256 !== chunk.transformedSha256
        ) {
          throw targetError("RESUME_MISMATCH");
        }
        const targetRows = await fetchTargetRowsForSourceRows(connection, table, chunk.rows);
        const targetHash = hashTargetChunk(context.contractSha256, table, chunk.plan.ordinal, targetRows);
        if (targetHash !== checkpoint.targetSha256 || targetHash !== chunk.transformedSha256) {
          throw targetError("TARGET_CHANGED");
        }
        continue;
      }
      const existingRows = await countExistingTargetRows(connection, table, chunk.rows);
      if (existingRows !== 0) throw targetError("TARGET_CHANGED");
      await inTransaction(connection, async () => {
        await insertSourceRows(connection, table, chunk.rows);
        const targetRows = await fetchTargetRowsForSourceRows(connection, table, chunk.rows);
        const targetHash = hashTargetChunk(context.contractSha256, table, chunk.plan.ordinal, targetRows);
        if (targetHash !== chunk.transformedSha256) throw targetError("TARGET_CHANGED");
        const checkpointed = await connection.query(
          `/* pintpath:migration:checkpoint-chunk */
           INSERT INTO ${OPERATIONS_SCHEMA}.migration_chunks (
             run_id, table_name, chunk_ordinal, row_count,
             source_transformed_sha256, target_sha256, completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
          [
            context.runId,
            table.name,
            chunk.plan.ordinal,
            chunk.rows.length,
            chunk.transformedSha256,
            targetHash,
          ],
        );
        if (checkpointed.rowCount !== 1) throw targetError("RESUME_MISMATCH");
      });
      completed.set(key, {
        runId: context.runId,
        tableName: table.name,
        chunkOrdinal: chunk.plan.ordinal,
        rowCount: chunk.rows.length,
        sourceTransformedSha256: chunk.transformedSha256,
        targetSha256: chunk.transformedSha256,
      });
    }
  }
}

async function verifyCompletedChunks(
  connection: PostgresMigrationTargetConnection,
  source: BetterSqlite3.Database,
  context: TargetContext,
  completed: Map<string, MigrationChunkRow>,
): Promise<void> {
  const expectedChunkCount = context.plan.tables.reduce((total, table) => total + table.chunks.length, 0);
  if (completed.size !== expectedChunkCount) throw targetError("RECONCILIATION_FAILED");
  const contractByName = new Map<string, PostgresMigrationTableContract>(
    POSTGRES_MIGRATION_CONTRACT.tables.map((table) => [table.name, table]),
  );
  for (const planTable of context.plan.tables) {
    const table = contractByName.get(planTable.name);
    if (!table) throw targetError("PLAN_MISMATCH");
    for (const chunk of readSourceChunks(source, table, planTable, context.contractSha256)) {
      const checkpoint = completed.get(`${table.name}\0${chunk.plan.ordinal}`);
      if (
        !checkpoint
        || checkpoint.rowCount !== chunk.rows.length
        || checkpoint.sourceTransformedSha256 !== chunk.transformedSha256
      ) {
        throw targetError("RECONCILIATION_FAILED");
      }
      const targetRows = await fetchTargetRowsForSourceRows(connection, table, chunk.rows);
      const targetHash = hashTargetChunk(context.contractSha256, table, chunk.plan.ordinal, targetRows);
      if (targetHash !== checkpoint.targetSha256 || targetHash !== chunk.transformedSha256) {
        throw targetError("TARGET_CHANGED");
      }
    }
  }
}

function stateColumn(column: PostgresMigrationColumnContract): boolean {
  return column[0] === "status"
    || column[0] === "state"
    || column[0].endsWith("_status")
    || column[0].endsWith("_state");
}

function addStateTotals(
  totals: Map<string, number>,
  table: PostgresMigrationTableContract,
  rows: readonly TransformedRow[],
): void {
  for (const row of rows) {
    for (const column of table.columns.filter(stateColumn)) {
      let canonical: string;
      try {
        canonical = postgresMigrationSourceInternals.canonicalSourceValue(row.raw[column[0]], column);
      } catch {
        throw targetError("RECONCILIATION_FAILED");
      }
      const valueDigest = sha256PostgresMigrationBytes(canonical);
      const key = `${table.name}\0${column[0]}\0${valueDigest}`;
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
  }
}

function stateTotalsSha256(totals: Map<string, number>): string {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-postgres-state-totals-v1");
  for (const [key, count] of [...totals.entries()].sort(([left], [right]) => compareStrings(left, right))) {
    updateLengthFramed(hash, key);
    updateLengthFramed(hash, String(count));
  }
  return hash.digest("hex");
}

function foreignKeyGroups(descriptor: PostgresMigrationSchemaDescriptor): Array<{
  readonly childTable: string;
  readonly parentTable: string;
  readonly columns: readonly { readonly from: string; readonly to: string }[];
}> {
  const groups: Array<{
    childTable: string;
    parentTable: string;
    columns: Array<{ from: string; to: string }>;
  }> = [];
  for (const table of descriptor.tables) {
    const byId = new Map<number, typeof table.foreignKeys>();
    for (const foreignKey of table.foreignKeys) {
      const existing = byId.get(foreignKey.id) ?? [];
      byId.set(foreignKey.id, [...existing, foreignKey]);
    }
    for (const rows of byId.values()) {
      const ordered = [...rows].sort((left, right) => left.seq - right.seq);
      const first = ordered[0];
      if (!first) throw targetError("RECONCILIATION_FAILED");
      groups.push({
        childTable: table.name,
        parentTable: first.table,
        columns: ordered.map((row) => ({ from: row.from, to: row.to })),
      });
    }
  }
  return groups;
}

async function assertNoOrphans(
  connection: PostgresMigrationTargetConnection,
  descriptor: PostgresMigrationSchemaDescriptor,
): Promise<number> {
  const tableNames = new Set<string>(POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name));
  const columnsByTable = new Map<string, ReadonlySet<string>>(POSTGRES_MIGRATION_CONTRACT.tables.map(
    (table) => [table.name, new Set<string>(table.columns.map((column) => column[0]))],
  ));
  const foreignKeys = foreignKeyGroups(descriptor);
  if (descriptor.tables.reduce((total, table) => total + table.foreignKeys.length, 0) !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys) {
    throw targetError("RECONCILIATION_FAILED");
  }
  for (const foreignKey of foreignKeys) {
    const childColumns = columnsByTable.get(foreignKey.childTable);
    const parentColumns = columnsByTable.get(foreignKey.parentTable);
    if (!childColumns || !parentColumns) throw targetError("RECONCILIATION_FAILED");
    const childTable = quoteIdentifier(foreignKey.childTable, tableNames);
    const parentTable = quoteIdentifier(foreignKey.parentTable, tableNames);
    const joins = foreignKey.columns.map(({ from, to }) => (
      `parent.${quoteIdentifier(to, parentColumns)} = child.${quoteIdentifier(from, childColumns)}`
    ));
    const nonNull = foreignKey.columns.map(({ from }) => (
      `child.${quoteIdentifier(from, childColumns)} IS NOT NULL`
    ));
    const missing = `parent.${quoteIdentifier(foreignKey.columns[0]!.to, parentColumns)} IS NULL`;
    const result = await connection.query<QueryResultRow & { hasOrphan: boolean }>(
      `/* pintpath:migration:orphan-check */
       SELECT EXISTS (
         SELECT 1
         FROM ${APPLICATION_SCHEMA}.${childTable} AS child
         LEFT JOIN ${APPLICATION_SCHEMA}.${parentTable} AS parent ON ${joins.join(" AND ")}
         WHERE ${nonNull.join(" AND ")} AND ${missing}
         LIMIT 1
       ) AS "hasOrphan"`,
    );
    if (result.rows[0]?.hasOrphan !== false) throw targetError("RECONCILIATION_FAILED");
  }
  return foreignKeys.length;
}

async function reconcileTarget(
  connection: PostgresMigrationTargetConnection,
  source: BetterSqlite3.Database,
  context: TargetContext,
): Promise<ReconciliationSummary> {
  await inspectTargetSchema(connection);
  await inspectTargetForeignKeys(connection, context.sourceDescriptor);
  const targetCounts = await loadTableCounts(connection);
  const contractByName = new Map<string, PostgresMigrationTableContract>(
    POSTGRES_MIGRATION_CONTRACT.tables.map((table) => [table.name, table]),
  );
  const sourceStateTotals = new Map<string, number>();
  const targetStateTotals = new Map<string, number>();
  const tableSetHash = crypto.createHash("sha256");
  const transformedDataHash = crypto.createHash("sha256");
  const keyRangesHash = crypto.createHash("sha256");
  updateLengthFramed(tableSetHash, "pint-path-postgres-table-set-v1");
  updateLengthFramed(transformedDataHash, "pint-path-postgres-transformed-data-v1");
  updateLengthFramed(keyRangesHash, "pint-path-postgres-key-ranges-v1");
  let chunkCount = 0;
  let zeroRowTableCount = 0;
  for (const planTable of context.plan.tables) {
    const table = contractByName.get(planTable.name);
    if (!table || targetCounts.get(table.name) !== planTable.rowCount) {
      throw targetError("RECONCILIATION_FAILED");
    }
    const sourceChunks = readSourceChunks(source, table, planTable, context.contractSha256);
    const sourceTableHash = beginTransformedTableHash(context.contractSha256, table);
    const targetTableHash = beginTransformedTableHash(context.contractSha256, table);
    if (sourceChunks.length === 0) zeroRowTableCount += 1;
    for (const chunk of sourceChunks) {
      const targetRows = await fetchTargetRowsForSourceRows(connection, table, chunk.rows);
      const targetChunkHash = hashTargetChunk(context.contractSha256, table, chunk.plan.ordinal, targetRows);
      if (targetChunkHash !== chunk.transformedSha256) throw targetError("RECONCILIATION_FAILED");
      for (const row of chunk.rows) updateLengthFramed(sourceTableHash, row.canonicalRow);
      for (const row of targetRows) updateLengthFramed(targetTableHash, row.canonicalRow);
      addStateTotals(sourceStateTotals, table, chunk.rows);
      addStateTotals(targetStateTotals, table, targetRows);
      updateLengthFramed(keyRangesHash, table.name);
      updateLengthFramed(keyRangesHash, chunk.plan.firstPrimaryKeySha256);
      updateLengthFramed(keyRangesHash, chunk.plan.lastPrimaryKeySha256);
      updateLengthFramed(keyRangesHash, targetRows[0]!.primaryKeySha256);
      updateLengthFramed(keyRangesHash, targetRows.at(-1)!.primaryKeySha256);
      chunkCount += 1;
    }
    const sourceTableSha256 = sourceTableHash.digest("hex");
    const targetTableSha256 = targetTableHash.digest("hex");
    if (sourceTableSha256 !== planTable.transformedSha256 || targetTableSha256 !== planTable.transformedSha256) {
      throw targetError("RECONCILIATION_FAILED");
    }
    updateLengthFramed(tableSetHash, table.name);
    updateLengthFramed(tableSetHash, String(planTable.rowCount));
    updateLengthFramed(transformedDataHash, table.name);
    updateLengthFramed(transformedDataHash, targetTableSha256);
  }
  const sourceStateSha256 = stateTotalsSha256(sourceStateTotals);
  const targetStateSha256 = stateTotalsSha256(targetStateTotals);
  if (sourceStateSha256 !== targetStateSha256) throw targetError("RECONCILIATION_FAILED");
  const foreignKeyCount = await assertNoOrphans(connection, context.sourceDescriptor);
  return {
    tableSetSha256: tableSetHash.digest("hex"),
    transformedDataSha256: transformedDataHash.digest("hex"),
    keyRangesSha256: keyRangesHash.digest("hex"),
    stateTotalsSha256: targetStateSha256,
    chunkCount,
    zeroRowTableCount,
    foreignKeyCount,
  };
}

function metadataForReady(context: TargetContext): PostgresMigrationReadyMetadata {
  return buildPostgresMigrationReadyMetadata({
    import_state: "ready",
    migration_candidate_sha: context.plan.candidateSha,
    migration_contract_sha256: context.contractSha256,
    migration_manifest_sha256: context.manifestSha256,
    migration_plan_sha256: context.planSha256,
    migration_run_sha256: context.runId,
    source_schema_fingerprint: context.manifest.schema.fingerprint,
    source_schema_version: String(context.manifest.schema.sourceVersion),
    source_snapshot_sha256: context.manifest.database.sha256,
    target_ddl_sha256: context.targetDdlSha256,
    live_schema_sha256: context.liveSchemaSha256,
  });
}

function assertExistingMetadataBinding(
  metadata: ReadonlyMap<string, string>,
  context: TargetContext,
  run: MigrationRunRow,
): void {
  const ready = metadataForReady(context);
  const bindingKeys = [
    "migration_candidate_sha",
    "migration_manifest_sha256",
    "migration_plan_sha256",
    "migration_run_sha256",
    "source_schema_fingerprint",
    "source_schema_version",
    "source_snapshot_sha256",
    "target_ddl_sha256",
    "live_schema_sha256",
  ] as const;
  const placeholders: Readonly<Record<string, string>> = {
    migration_candidate_sha: "",
    migration_manifest_sha256: "",
    migration_plan_sha256: "",
    migration_run_sha256: "",
    source_schema_fingerprint: "",
    source_schema_version: "0",
    source_snapshot_sha256: "",
    target_ddl_sha256: "",
    live_schema_sha256: "",
  };
  const isReadyBinding = bindingKeys.every((key) => metadata.get(key) === ready[key]);
  const isPlaceholderBinding = bindingKeys.every((key) => metadata.get(key) === placeholders[key]);
  if (run.status === "ready") {
    if (
      metadata.get("import_state") !== "ready"
      || !isReadyBinding
      || run.verifierIdSha256 !== context.verifierIdSha256
      || !run.receiptSha256
    ) {
      throw targetError("RESUME_MISMATCH");
    }
    return;
  }
  if (
    !["importing", "verifying", "failed"].includes(metadata.get("import_state") ?? "")
    || (!isReadyBinding && !isPlaceholderBinding)
    || (isReadyBinding && (run.verifierIdSha256 !== context.verifierIdSha256 || !run.receiptSha256))
    || (isPlaceholderBinding && (run.verifierIdSha256 !== null || run.receiptSha256 !== null))
  ) {
    throw targetError("RESUME_MISMATCH");
  }
}

function receiptCommon(
  context: TargetContext,
  summary: ReconciliationSummary,
): Omit<PostgresMigrationApplyReceipt, "receiptSha256" | "status"> {
  const metadataSha256 = sha256PostgresMigrationReadyMetadata(metadataForReady(context));
  const withoutReceipt = {
    kind: "pint-path-postgres-migration-receipt" as const,
    version: 3 as const,
    expectedEnvironment: context.expectedEnvironment,
    approvalReferenceSha256: context.approvalReferenceSha256,
    operatorIdSha256: context.operatorIdSha256,
    verifierIdSha256: context.verifierIdSha256,
    verifierAuthoritySha256: context.verifierAuthoritySha256,
    verifierAuthorityPolicySha256: context.verifierAuthorityPolicySha256,
    runIdSha256: context.runId,
    runBindingSha256: context.targetBindingSha256,
    targetIdentitySha256: context.targetIdentitySha256,
    transportAuthoritySha256: context.transportAuthoritySha256,
    targetUrlSha256: context.targetUrlSha256,
    targetDdlSha256: context.targetDdlSha256,
    liveSchemaSha256: context.liveSchemaSha256,
    sourceSnapshotSha256: context.manifest.database.sha256,
    sourceSchemaFingerprint: context.manifest.schema.fingerprint,
    contractSha256: context.contractSha256,
    manifestSha256: context.manifestSha256,
    planSha256: context.planSha256,
    candidateSha: context.plan.candidateSha,
    tableSetSha256: summary.tableSetSha256,
    transformedDataSha256: summary.transformedDataSha256,
    keyRangesSha256: summary.keyRangesSha256,
    stateTotalsSha256: summary.stateTotalsSha256,
    schemaMetadataSha256: metadataSha256,
    tableCount: context.plan.tableCount,
    columnCount: context.plan.columnCount,
    rowCount: context.plan.totalRows,
    chunkCount: summary.chunkCount,
    zeroRowTableCount: summary.zeroRowTableCount,
    foreignKeyCount: summary.foreignKeyCount,
  };
  return withoutReceipt;
}

function buildApplyReceipt(
  context: TargetContext,
  summary: ReconciliationSummary,
): PostgresMigrationApplyReceipt {
  return finalizePostgresMigrationApplyReceipt({
    ...receiptCommon(context, summary),
    status: "awaiting-verification",
  });
}

function buildReceipt(
  context: TargetContext,
  summary: ReconciliationSummary,
  authority: {
    readonly applyReceiptSha256: string;
    readonly approval: PostgresMigrationVerificationApproval;
    readonly approvalFileSha256: string;
  },
): CanonicalPostgresMigrationReceipt {
  return finalizePostgresMigrationReceipt({
    ...receiptCommon(context, summary),
    status: "ready",
    applyReceiptSha256: authority.applyReceiptSha256,
    verificationApprovalFileSha256: authority.approvalFileSha256,
    verifierPublicKeySha256: context.verifierPublicKeySha256,
    verifiedAt: authority.approval.payload.approvedAt,
  });
}

async function markAwaitingVerification(
  connection: PostgresMigrationTargetConnection,
  context: TargetContext,
  receipt: PostgresMigrationApplyReceipt,
): Promise<void> {
  await inTransaction(connection, async () => {
    const readyMetadata = metadataForReady(context);
    for (const [key, value] of Object.entries(readyMetadata)) {
      if (key === "import_state") continue;
      const updated = await connection.query(
        `/* pintpath:migration:write-verifying-metadata */
         UPDATE ${APPLICATION_SCHEMA}.schema_metadata
         SET value = $2, updated_at = clock_timestamp()
         WHERE key = $1`,
        [key, value],
      );
      if (updated.rowCount !== 1) throw targetError("TARGET_UNSAFE");
    }
    const run = await connection.query(
      `/* pintpath:migration:await-independent-verification */
       UPDATE ${OPERATIONS_SCHEMA}.migration_runs
       SET status = 'verifying', verifier_id_sha256 = $2, receipt_sha256 = $3,
           failure_code = NULL, completed_at = NULL
       WHERE run_id = $1`,
      [context.runId, context.verifierIdSha256, receipt.receiptSha256],
    );
    if (run.rowCount !== 1) throw targetError("RESUME_MISMATCH");
  });
}

async function markReady(
  connection: PostgresMigrationTargetConnection,
  context: TargetContext,
  receipt: CanonicalPostgresMigrationReceipt,
): Promise<void> {
  await inTransaction(connection, async () => {
    for (const [key, value] of Object.entries(metadataForReady(context))) {
      const updated = await connection.query(
        `/* pintpath:migration:write-ready-metadata */
         UPDATE ${APPLICATION_SCHEMA}.schema_metadata
         SET value = $2, updated_at = clock_timestamp()
         WHERE key = $1`,
        [key, value],
      );
      if (updated.rowCount !== 1) throw targetError("TARGET_UNSAFE");
    }
    const readyRun = await connection.query(
      `/* pintpath:migration:ready-run */
       UPDATE ${OPERATIONS_SCHEMA}.migration_runs
       SET status = 'ready', verifier_id_sha256 = $2, receipt_sha256 = $3,
           failure_code = NULL, completed_at = clock_timestamp()
       WHERE run_id = $1`,
      [context.runId, context.verifierIdSha256, receipt.receiptSha256],
    );
    if (readyRun.rowCount !== 1) throw targetError("RESUME_MISMATCH");
  });
  const metadata = await loadMetadata(connection);
  for (const [key, value] of Object.entries(metadataForReady(context))) {
    if (metadata.get(key) !== value) throw targetError("RECONCILIATION_FAILED");
  }
  const runs = await loadMigrationRuns(connection);
  if (
    runs.length !== 1
    || runs[0]?.runId !== context.runId
    || runs[0]?.status !== "ready"
    || runs[0]?.receiptSha256 !== receipt.receiptSha256
    || runs[0]?.verifierIdSha256 !== context.verifierIdSha256
  ) {
    throw targetError("RECONCILIATION_FAILED");
  }
}

async function validateSourceArtifacts(
  input: PostgresMigrationTargetInput,
): Promise<Omit<TargetContext,
  | "expectedEnvironment"
  | "targetIdentitySha256"
  | "liveSchemaSha256"
  | "verifierIdSha256"
  | "verifierAuthoritySha256"
  | "verifierAuthorityPolicySha256"
  | "verifierPublicKeySha256"
  | "targetBindingSha256"
  | "runId"
>> {
  const expectedManifestSha256 = assertSha256(input.expectedSnapshotManifestSha256);
  const expectedPlanSha256 = assertSha256(input.expectedPlanSha256);
  const expectedDdlSha256 = assertSha256(input.expectedTargetDdlSha256);
  const expectedTargetUrlSha256 = assertSha256(input.expectedTargetUrlSha256);
  const expectedTransportAuthoritySha256 = assertSha256(
    input.expectedTransportAuthoritySha256,
  );
  const candidateSha = normalizeCandidateSha(input.candidateSha);
  const contractSha256 = sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT);
  const manifestArtifact = await readStableArtifact(input.snapshotManifestPath, { requiredMode: 0o600, maxBytes: 1024 * 1024 });
  if (manifestArtifact.sha256 !== expectedManifestSha256) throw targetError("ARTIFACT_INVALID");
  let manifest: PostgresMigrationSnapshotManifest;
  try {
    const parsed = JSON.parse(manifestArtifact.contents.toString("utf8"));
    manifest = postgresMigrationSourceInternals.normalizeSnapshotManifest(parsed);
  } catch (error) {
    if (error instanceof PostgresMigrationSourceError) throw targetError("ARTIFACT_INVALID");
    throw targetError("ARTIFACT_INVALID");
  }
  if (!manifestArtifact.contents.equals(serializeCanonicalPostgresMigrationJson(manifest))) {
    throw targetError("ARTIFACT_INVALID");
  }
  const planArtifact = await readStableArtifact(input.planPath, { requiredMode: 0o600, maxBytes: 64 * 1024 * 1024 });
  if (planArtifact.sha256 !== expectedPlanSha256) throw targetError("ARTIFACT_INVALID");
  let plan: PostgresMigrationPlan;
  try {
    plan = normalizePlan(JSON.parse(planArtifact.contents.toString("utf8")));
  } catch (error) {
    if (error instanceof PostgresMigrationTargetError) throw error;
    throw targetError("ARTIFACT_INVALID");
  }
  if (!planArtifact.contents.equals(serializeCanonicalPostgresMigrationJson(plan))) {
    throw targetError("ARTIFACT_INVALID");
  }
  const ddlArtifact = await readStableArtifact(input.targetDdlPath, { maxBytes: MAX_ARTIFACT_BYTES });
  if (ddlArtifact.sha256 !== expectedDdlSha256) throw targetError("ARTIFACT_INVALID");
  const validatedUrl = validateTargetUrl(input.targetUrl);
  if (validatedUrl.digest !== expectedTargetUrlSha256) throw targetError("IDENTITY_MISMATCH");
  const exactTransportAuthoritySha256 = transportAuthoritySha256(input);
  if (exactTransportAuthoritySha256 !== expectedTransportAuthoritySha256) {
    throw targetError("IDENTITY_MISMATCH");
  }
  const operatorIdSha256 = identitySha256(input.operatorId, "operator-id");
  if (operatorIdSha256 !== manifest.operatorIdSha256) throw targetError("IDENTITY_MISMATCH");
  if (
    candidateSha !== manifest.candidateSha
    || candidateSha !== plan.candidateSha
    || plan.contractSha256 !== contractSha256
    || plan.contractSha256 !== manifest.contractSha256
    || plan.snapshotManifestSha256 !== manifestArtifact.sha256
    || plan.sourceDatabaseSha256 !== manifest.database.sha256
    || plan.sourceSchemaVersion !== manifest.schema.sourceVersion
    || plan.sourceSchemaFingerprint !== manifest.schema.fingerprint
  ) {
    throw targetError("PLAN_MISMATCH");
  }
  if (!(["permanent-staging", "production"] as const).includes(input.expectedEnvironment)) {
    throw targetError("ARGUMENT_INVALID");
  }
  const snapshotDirectory = path.dirname(input.snapshotManifestPath);
  let directoryStat: fs.BigIntStats;
  try {
    directoryStat = fs.lstatSync(snapshotDirectory, { bigint: true });
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || Number(directoryStat.mode & 0o777n) !== 0o700
      || fs.realpathSync(snapshotDirectory) !== snapshotDirectory
    ) throw new Error("unsafe");
  } catch {
    throw targetError("ARTIFACT_INVALID");
  }
  const sourceDatabasePath = path.join(snapshotDirectory, POSTGRES_MIGRATION_SNAPSHOT_DATABASE_FILE);
  const databaseArtifact = await digestStableFile(sourceDatabasePath, { requiredMode: 0o600 });
  if (databaseArtifact.sha256 !== manifest.database.sha256 || databaseArtifact.bytes !== manifest.database.bytes) {
    throw targetError("SOURCE_CHANGED");
  }
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    if (fs.existsSync(`${sourceDatabasePath}${suffix}`)) throw targetError("ARTIFACT_INVALID");
  }
  await assertSnapshotLedgerAuthority(snapshotDirectory, manifest, "ARTIFACT_INVALID");
  try {
    await verifyPostgresMigrationSnapshotEvidence(snapshotDirectory, manifest.evidence);
  } catch {
    throw targetError("ARTIFACT_INVALID");
  }
  const database = new BetterSqlite3(sourceDatabasePath, { readonly: true, fileMustExist: true });
  let sourceDescriptor: PostgresMigrationSchemaDescriptor;
  try {
    database.pragma("query_only = ON");
    database.pragma("foreign_keys = ON");
    const integrity = database.pragma("integrity_check") as Array<Record<string, unknown>>;
    const foreignKeys = database.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    const inspection = inspectPostgresMigrationSchema(database);
    if (
      integrity.length !== 1
      || String(Object.values(integrity[0] ?? {})[0] ?? "").toLowerCase() !== "ok"
      || foreignKeys.length !== 0
      || inspection.fingerprint !== manifest.schema.fingerprint
      || JSON.stringify(inspection.counts) !== JSON.stringify(manifest.schema.counts)
    ) throw targetError("SOURCE_CHANGED");
    sourceDescriptor = inspection.descriptor;
  } finally {
    database.close();
  }
  return {
    manifest,
    manifestSha256: manifestArtifact.sha256,
    plan,
    planSha256: planArtifact.sha256,
    targetDdlSha256: ddlArtifact.sha256,
    targetUrlSha256: validatedUrl.digest,
    transportAuthoritySha256: exactTransportAuthoritySha256,
    contractSha256,
    approvalReferenceSha256: identitySha256(input.approvalReference, "approval-reference"),
    operatorIdSha256,
    sourceDatabasePath,
    sourceDescriptor,
  };
}

function bindTargetContext(
  source: Omit<TargetContext,
    | "expectedEnvironment"
    | "targetIdentitySha256"
    | "liveSchemaSha256"
    | "verifierIdSha256"
    | "verifierAuthoritySha256"
    | "verifierAuthorityPolicySha256"
    | "verifierPublicKeySha256"
    | "targetBindingSha256"
    | "runId"
  >,
  targetIdentitySha256: string,
  liveSchemaSha256: string,
  environment: PostgresMigrationEnvironment,
  verifierAuthority: PostgresMigrationVerifierAuthority,
): TargetContext {
  if (
    verifierAuthority.expectedEnvironment !== environment
    || verifierAuthority.candidateSha !== source.plan.candidateSha
    || verifierAuthority.operatorIdSha256 !== source.operatorIdSha256
    || verifierAuthority.authorityPolicySha256
      !== POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256
  ) throw targetError("IDENTITY_MISMATCH");
  const targetBindingSha256 = sha256PostgresMigrationRunBinding({
    approvalReferenceSha256: source.approvalReferenceSha256,
    candidateSha: source.plan.candidateSha,
    contractSha256: source.contractSha256,
    expectedEnvironment: environment,
    manifestSha256: source.manifestSha256,
    operatorIdSha256: source.operatorIdSha256,
    planSha256: source.planSha256,
    sourceSchemaFingerprint: source.manifest.schema.fingerprint,
    sourceSchemaVersion: source.manifest.schema.sourceVersion,
    sourceSnapshotSha256: source.manifest.database.sha256,
    targetDdlSha256: source.targetDdlSha256,
    targetIdentitySha256,
    liveSchemaSha256,
    transportAuthoritySha256: source.transportAuthoritySha256,
    targetUrlSha256: source.targetUrlSha256,
    verifierIdSha256: verifierAuthority.verifierIdSha256,
    verifierAuthoritySha256: verifierAuthority.authoritySha256,
    verifierAuthorityPolicySha256: verifierAuthority.authorityPolicySha256,
    verifierPublicKeySha256: verifierAuthority.verifierPublicKeySha256,
  });
  return {
    ...source,
    expectedEnvironment: environment,
    targetIdentitySha256,
    liveSchemaSha256,
    verifierIdSha256: verifierAuthority.verifierIdSha256,
    verifierAuthoritySha256: verifierAuthority.authoritySha256,
    verifierAuthorityPolicySha256: verifierAuthority.authorityPolicySha256,
    verifierPublicKeySha256: verifierAuthority.verifierPublicKeySha256,
    targetBindingSha256,
    runId: derivePostgresMigrationRunId(targetBindingSha256),
  };
}

async function prepareTargetRun(
  connection: PostgresMigrationTargetConnection,
  context: TargetContext,
  environment: PostgresMigrationEnvironment,
): Promise<{ readonly existingRun: boolean; readonly run: MigrationRunRow }> {
  const metadata = await loadMetadata(connection);
  const runs = await loadMigrationRuns(connection);
  for (const key of Object.keys(metadataForReady(context))) {
    if (!metadata.has(key)) throw targetError("TARGET_UNSAFE");
  }
  if (metadata.get("migration_contract_sha256") !== context.contractSha256) {
    throw targetError("TARGET_UNSAFE");
  }
  if (runs.length > 1) throw targetError("RESUME_MISMATCH");
  const existing = runs[0];
  if (!existing) {
    const counts = await loadTableCounts(connection);
    if (metadata.get("import_state") !== "empty" || [...counts.values()].some((count) => count !== 0)) {
      throw targetError("TARGET_NOT_EMPTY");
    }
    await createMigrationRun(connection, context, environment);
    const created = (await loadMigrationRuns(connection))[0];
    if (!created) throw targetError("IMPORT_FAILED");
    assertExactRun(created, context, environment);
    return { existingRun: false, run: created };
  }
  assertExactRun(existing, context, environment);
  if (!["planned", "importing", "verifying", "ready", "failed"].includes(existing.status)) {
    throw targetError("RESUME_MISMATCH");
  }
  assertExistingMetadataBinding(metadata, context, existing);
  return { existingRun: true, run: existing };
}

async function assertSourceUnchanged(context: TargetContext): Promise<void> {
  const artifact = await digestStableFile(context.sourceDatabasePath, {
    requiredMode: 0o600,
  });
  if (artifact.sha256 !== context.manifest.database.sha256 || artifact.bytes !== context.manifest.database.bytes) {
    throw targetError("SOURCE_CHANGED");
  }
  await assertSnapshotLedgerAuthority(
    path.dirname(context.sourceDatabasePath),
    context.manifest,
    "SOURCE_CHANGED",
  );
  try {
    await verifyPostgresMigrationSnapshotEvidence(
      path.dirname(context.sourceDatabasePath),
      context.manifest.evidence,
    );
  } catch {
    throw targetError("SOURCE_CHANGED");
  }
}

export async function inspectPostgresMigrationTarget(input: {
  readonly targetUrl: string;
  readonly targetDdlPath: string;
  readonly expectedTargetDdlSha256: string;
  readonly rootCaFile: string;
  readonly expectedRootCaDerSha256: string;
}): Promise<PostgresMigrationTargetInspection> {
  validateTargetUrl(input.targetUrl);
  const connection = await DirectPostgresMigrationConnection.connect(input);
  try {
    return await inspectPostgresMigrationTargetWithConnection(input, connection);
  } finally {
    await connection.close();
  }
}

export async function inspectPostgresMigrationTargetWithConnection(
  input: {
    readonly targetUrl: string;
    readonly targetDdlPath: string;
    readonly expectedTargetDdlSha256: string;
    readonly expectedRootCaDerSha256: string;
  },
  connection: PostgresMigrationTargetConnection,
  dependencies: PostgresMigrationTargetDependencies = {},
): Promise<PostgresMigrationTargetInspection> {
  const ddl = await readStableArtifact(input.targetDdlPath, { maxBytes: MAX_ARTIFACT_BYTES });
  if (ddl.sha256 !== assertSha256(input.expectedTargetDdlSha256)) throw targetError("ARTIFACT_INVALID");
  const validatedUrl = validateTargetUrl(input.targetUrl);
  try {
    const identity = await inspectTargetIdentity(connection);
    const schema = await inspectTargetSchema(connection);
    const liveSchema = await assertLiveSchema(
      connection,
      dependencies.inspectLiveSchema ?? inspectPostgresMigrationLiveSchema,
    );
    return {
      targetIdentity: identity.identity,
      targetIdentitySha256: identity.digest,
      targetUrlSha256: validatedUrl.digest,
      transportAuthoritySha256: transportAuthoritySha256(input),
      targetDdlSha256: ddl.sha256,
      liveSchemaSha256: liveSchema.sha256,
      liveSchemaObjectCount: liveSchema.objectCount,
      ...schema,
    };
  } catch (error) {
    if (error instanceof PostgresMigrationTargetError) throw error;
    throw targetError("TARGET_UNSAFE");
  }
}

export async function applyPostgresMigrationWithConnection(
  input: PostgresMigrationTargetInput,
  connection: PostgresMigrationTargetConnection,
  dependencies: PostgresMigrationTargetDependencies = {},
): Promise<PostgresMigrationApplyReceipt> {
  const sourceContext = await validateSourceArtifacts(input);
  const expectedIdentitySha256 = assertSha256(input.expectedTargetIdentitySha256);
  const identity = await inspectTargetIdentity(connection);
  if (identity.digest !== expectedIdentitySha256) throw targetError("IDENTITY_MISMATCH");
  await inspectTargetSchema(connection);
  const inspectLiveSchema = dependencies.inspectLiveSchema ?? inspectPostgresMigrationLiveSchema;
  const liveSchema = await assertLiveSchema(connection, inspectLiveSchema);
  let context: TargetContext | null = null;
  let lockAcquired = false;
  let exactRun = false;
  try {
    await acquireMigrationLock(connection);
    lockAcquired = true;
    await inspectTargetSchema(connection);
    await assertLiveSchema(connection, inspectLiveSchema);
    await inspectTargetForeignKeys(connection, sourceContext.sourceDescriptor);
    const verifierAuthority = await loadVerifierAuthority(
      connection,
      input.expectedEnvironment,
      sourceContext.plan.candidateSha,
    );
    context = bindTargetContext(
      sourceContext,
      identity.digest,
      liveSchema.sha256,
      input.expectedEnvironment,
      verifierAuthority,
    );
    const prepared = await prepareTargetRun(connection, context, input.expectedEnvironment);
    if (prepared.run.status === "ready") throw targetError("RESUME_MISMATCH");
    exactRun = true;
    const completed = await loadCompletedChunks(connection, context);
    await updateRunStatus(connection, context.runId, "importing");
    const source = new BetterSqlite3(context.sourceDatabasePath, { readonly: true, fileMustExist: true });
    try {
      source.pragma("query_only = ON");
      source.pragma("foreign_keys = ON");
      await applyChunks(connection, source, context, completed);
      await assertSourceUnchanged(context);
      await updateRunStatus(connection, context.runId, "verifying");
      const summary = await reconcileTarget(connection, source, context);
      await assertLiveSchema(connection, inspectLiveSchema);
      await assertSourceUnchanged(context);
      const receipt = buildApplyReceipt(context, summary);
      if (prepared.run.receiptSha256 !== null && prepared.run.receiptSha256 !== receipt.receiptSha256) {
        throw targetError("TARGET_CHANGED");
      }
      await assertVerifierAuthorityUnchanged(connection, verifierAuthority);
      await markAwaitingVerification(connection, context, receipt);
      return receipt;
    } finally {
      source.close();
    }
  } catch (error) {
    const safe = error instanceof PostgresMigrationTargetError ? error : targetError("IMPORT_FAILED");
    if (exactRun && context) await recordFailedRun(connection, context.runId, safe.code);
    throw safe;
  } finally {
    if (lockAcquired) await releaseMigrationLock(connection);
  }
}

export async function applyPostgresMigration(
  input: PostgresMigrationTargetInput,
): Promise<PostgresMigrationApplyReceipt> {
  validateTargetUrl(input.targetUrl);
  const connection = await DirectPostgresMigrationConnection.connect(input);
  try {
    return await applyPostgresMigrationWithConnection(input, connection);
  } catch (error) {
    if (error instanceof PostgresMigrationTargetError) throw error;
    throw targetError("IMPORT_FAILED");
  } finally {
    await connection.close();
  }
}

export async function verifyPostgresMigrationWithConnection(
  input: PostgresMigrationVerifyInput,
  connection: PostgresMigrationTargetConnection,
  dependencies: PostgresMigrationTargetDependencies = {},
): Promise<CanonicalPostgresMigrationReceipt> {
  const sourceContext = await validateSourceArtifacts(input);
  const expectedIdentitySha256 = assertSha256(input.expectedTargetIdentitySha256);
  const identity = await inspectTargetIdentity(connection);
  if (identity.digest !== expectedIdentitySha256) throw targetError("IDENTITY_MISMATCH");
  const inspectLiveSchema = dependencies.inspectLiveSchema ?? inspectPostgresMigrationLiveSchema;
  const liveSchema = await assertLiveSchema(connection, inspectLiveSchema);
  let lockAcquired = false;
  try {
    await acquireMigrationLock(connection);
    lockAcquired = true;
    await inspectTargetSchema(connection);
    await assertLiveSchema(connection, inspectLiveSchema);
    await inspectTargetForeignKeys(connection, sourceContext.sourceDescriptor);
    const verifierAuthority = await loadVerifierAuthority(
      connection,
      input.expectedEnvironment,
      sourceContext.plan.candidateSha,
    );
    const context = bindTargetContext(
      sourceContext,
      identity.digest,
      liveSchema.sha256,
      input.expectedEnvironment,
      verifierAuthority,
    );
    const runs = await loadMigrationRuns(connection);
    if (runs.length !== 1 || !runs[0]) throw targetError("RESUME_MISMATCH");
    const run = runs[0];
    assertExactRun(run, context, input.expectedEnvironment);
    if (
      !["verifying", "ready"].includes(run.status)
      || run.verifierIdSha256 !== context.verifierIdSha256
      || !run.receiptSha256
    ) {
      throw targetError("RECONCILIATION_FAILED");
    }
    const source = new BetterSqlite3(context.sourceDatabasePath, { readonly: true, fileMustExist: true });
    try {
      source.pragma("query_only = ON");
      source.pragma("foreign_keys = ON");
      const completed = await loadCompletedChunks(connection, context);
      await verifyCompletedChunks(connection, source, context, completed);
      const summary = await reconcileTarget(connection, source, context);
      await assertLiveSchema(connection, inspectLiveSchema);
      await assertSourceUnchanged(context);
      const applyReceipt = buildApplyReceipt(context, summary);
      const verification = input.verificationAuthority;
      if (
        verification.applyReceiptFileSha256 !== verification.expectedApplyReceiptFileSha256
        || verification.applyReceipt.receiptSha256 !== applyReceipt.receiptSha256
      ) throw targetError("ARTIFACT_INVALID");
      let approval: PostgresMigrationVerificationApproval;
      try {
        approval = verifyPostgresMigrationVerificationApproval({
          approval: verification.approval,
          approvalFileSha256: verification.approvalFileSha256,
          applyReceipt,
          expectedApprovalFileSha256: verification.expectedApprovalFileSha256,
          expectedVerifierAuthoritySha256: context.verifierAuthoritySha256,
          expectedVerifierAuthorityPolicySha256:
            context.verifierAuthorityPolicySha256,
          expectedVerifierPublicKeySha256: context.verifierPublicKeySha256,
          now: verification.now,
          verifierPublicKeyBytes: verification.verifierPublicKeyBytes,
        });
      } catch {
        throw targetError("ARTIFACT_INVALID");
      }
      const receipt = buildReceipt(context, summary, {
        applyReceiptSha256: applyReceipt.receiptSha256,
        approval,
        approvalFileSha256: verification.approvalFileSha256,
      });
      if (run.status === "verifying") {
        if (run.receiptSha256 !== applyReceipt.receiptSha256) {
          throw targetError("RECONCILIATION_FAILED");
        }
        await assertVerifierAuthorityUnchanged(connection, verifierAuthority);
        await markReady(connection, context, receipt);
      } else if (run.receiptSha256 !== receipt.receiptSha256) {
        throw targetError("RECONCILIATION_FAILED");
      }
      const metadata = await loadMetadata(connection);
      for (const [key, value] of Object.entries(metadataForReady(context))) {
        if (metadata.get(key) !== value) throw targetError("RECONCILIATION_FAILED");
      }
      return receipt;
    } finally {
      source.close();
    }
  } catch (error) {
    if (error instanceof PostgresMigrationTargetError) throw error;
    throw targetError("RECONCILIATION_FAILED");
  } finally {
    if (lockAcquired) await releaseMigrationLock(connection);
  }
}

export async function verifyPostgresMigration(
  input: PostgresMigrationVerifyInput,
): Promise<CanonicalPostgresMigrationReceipt> {
  validateTargetUrl(input.targetUrl);
  const connection = await DirectPostgresMigrationConnection.connect(input);
  try {
    return await verifyPostgresMigrationWithConnection(input, connection);
  } catch (error) {
    if (error instanceof PostgresMigrationTargetError) throw error;
    throw targetError("RECONCILIATION_FAILED");
  } finally {
    await connection.close();
  }
}

export const postgresMigrationTargetInternals = {
  bindTargetContext,
  buildReceipt,
  canonicalRawKey,
  canonicalRow,
  hashTargetChunk,
  normalizePlan,
  targetValueToSource,
  transformSourceValue,
  transformedChunkSha256,
  transportAuthoritySha256,
  validateTargetUrl,
  openDirectConnection: DirectPostgresMigrationConnection.connect,
};
