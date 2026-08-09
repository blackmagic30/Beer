import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { Client, type ClientConfig, type QueryResultRow } from "pg";

import { POSTGRES_MIGRATION_CONTRACT } from "../db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../db/postgres-migration-schema.js";
import {
  POSTGRES_LOGICAL_BACKUP_ARCHIVE,
  POSTGRES_LOGICAL_BACKUP_MANIFEST,
  POSTGRES_LOGICAL_BACKUP_SCHEMAS,
  POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  canonicalPostgresBackupJson,
  postgresLogicalBackupManifestBindingSha256,
  runPostgresBackupProcess,
  type PostgresLogicalBackupManifest,
  type ProcessRunner,
} from "./postgres-logical-backup.js";
import {
  computePostgresLogicalStateInventory,
  exactPostgresLogicalStateMatch,
  parsePostgresLogicalSourceStateReceipt,
  type PostgresLogicalSourceStateReceipt,
  type PostgresLogicalStateInventory,
} from "./postgres-logical-state.js";

const APPLICATION_SCHEMA = "pintpath_app";
const OPERATIONS_SCHEMA = "pintpath_ops";
const RUNTIME_ROLE = "pintpath_runtime";
const MIGRATOR_ROLE = "pintpath_migrator";
const DISPOSABLE_TARGET_CLASS = "disposable-rehearsal";
const RESTORE_LOCK_KEY = "-5884877150838658403";
const RECEIPT_KIND = "pintpath-postgres-logical-restore-rehearsal" as const;
const RECEIPT_VERSION = 1 as const;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_STATE_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024n * 1024n * 1024n * 1024n;
const VERSION_OUTPUT_LIMIT = 4 * 1024;
const LISTING_OUTPUT_LIMIT = 64 * 1024 * 1024;
const RESTORE_OUTPUT_LIMIT = 1024 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 5 * 60 * 1_000;
const RESTORE_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){0,3}(?:[-+._a-zA-Z0-9 ()~:]{0,96})$/;

export const POSTGRES_LOGICAL_RESTORE_CONFIRMATION_ENV =
  "PINTPATH_POSTGRES_LOGICAL_RESTORE" as const;
export const POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE = "confirmed" as const;
export const POSTGRES_LOGICAL_RESTORE_TARGET_CLASS_SETTING =
  "pintpath.logical_restore_target_class" as const;

export type PostgresLogicalRestoreFailureCode =
  | "invalid_arguments"
  | "confirmation_required"
  | "operator_guard_rejected"
  | "unsafe_connection_file"
  | "unsafe_connection_url"
  | "unsafe_backup_directory"
  | "backup_manifest_invalid"
  | "backup_tampered"
  | "tool_unavailable_or_unsupported"
  | "target_unreachable"
  | "target_not_disposable"
  | "target_identity_mismatch"
  | "target_not_empty"
  | "target_busy"
  | "restore_failed"
  | "restore_rollback_unverified_target_disposal_required"
  | "verification_failed_target_disposal_required"
  | "receipt_failed_target_disposal_required";

export class PostgresLogicalRestoreError extends Error {
  constructor(readonly code: PostgresLogicalRestoreFailureCode) {
    super(code);
    this.name = "PostgresLogicalRestoreError";
  }
}

export interface PostgresLogicalRestoreQueryResult<Row extends QueryResultRow = QueryResultRow> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface PostgresLogicalRestoreConnection {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresLogicalRestoreQueryResult<Row>>;
  close(): Promise<void>;
}

export interface PostgresLogicalRestoreTargetInspection {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly targetIdentitySha256: string;
  readonly disposableTarget: true;
  readonly privateSchemasAbsent: true;
}

export interface PostgresLogicalRestoreReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly version: typeof RECEIPT_VERSION;
  readonly status: "verified";
  readonly restoredAt: string;
  readonly backupManifestSha256: string;
  readonly backupArchiveSha256: string;
  readonly targetIdentitySha256: string;
  readonly targetUrlSha256: string;
  readonly authoritativeTableCount: number;
  readonly authoritativeColumnCount: number;
  readonly foreignKeyCount: number;
  readonly authoritativeRowCount: string;
  readonly nonEmptyAuthoritativeTableCount: number;
  readonly authoritativeCountInventorySha256: string;
  readonly controlCountInventorySha256: string;
  readonly schemaMetadataSha256: string;
  readonly rowSecurityTableCount: number;
  readonly aclContractSha256: string;
  readonly apiRolesIsolated: true;
  readonly runtimeApplicationAccessRestored: true;
  readonly migratorReconciliationAccessVerified: true;
  readonly runtimeOperationsIsolated: true;
  readonly promotionReconciliationReady: true;
  readonly sourceStateBindingStatus: "exact-match";
  readonly expectedSourceStateReceiptSha256: string;
  readonly sourceSnapshotBindingSha256: string;
  readonly expectedSourceTableSetSha256: string;
  readonly expectedSourceDataSha256: string;
  readonly expectedSourceStateTotalsSha256: string;
  readonly expectedSourceKeyRangesSha256: string;
  readonly expectedArchivedControlTableSetSha256: string;
  readonly expectedArchivedControlDataSha256: string;
  readonly expectedArchivedControlKeyRangesSha256: string;
  readonly expectedSourceOverallStateSha256: string;
  readonly restoredOverallStateSha256: string;
  readonly exactDataReconciliation: "canonical-contract-exact";
}

export interface PostgresLogicalRestoreResult {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly receiptSha256: string;
  readonly backupManifestSha256: string;
  readonly backupArchiveSha256: string;
  readonly targetIdentitySha256: string;
  readonly authoritativeRowCount: string;
  readonly nonEmptyAuthoritativeTableCount: number;
  readonly authoritativeCountInventorySha256: string;
  readonly promotionReconciliationReady: true;
  readonly sourceStateBindingStatus: "exact-match";
  readonly overallStateSha256: string;
}

export interface InspectPostgresLogicalRestoreTargetOptions {
  readonly targetUrlFile: string;
}

export interface RestorePostgresLogicalBackupOptions {
  readonly backupDirectory: string;
  readonly expectedBackupManifestSha256: string;
  readonly targetUrlFile: string;
  readonly expectedTargetIdentitySha256: string;
  readonly receiptFile: string;
  readonly confirmation: string;
}

export interface PostgresLogicalRestoreConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: false | { readonly rejectUnauthorized: boolean };
  readonly connectionTimeoutMillis: number;
  readonly query_timeout: number;
  readonly application_name: string;
}

export interface PostgresLogicalRestoreDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getUid: () => number | null;
  readonly now: () => Date;
  readonly pgRestoreCommand: string;
  readonly runProcess: ProcessRunner;
  readonly connect: (
    config: PostgresLogicalRestoreConnectionConfig,
  ) => Promise<PostgresLogicalRestoreConnection>;
  readonly computeState: (
    connection: PostgresLogicalRestoreConnection,
  ) => Promise<PostgresLogicalStateInventory>;
  /** Test seam only: also requires NODE_ENV=test and an exact loopback host. */
  readonly allowInsecureLoopbackForTests: boolean;
}

interface TrustedFileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly sha256: string;
  readonly bytes?: Buffer;
}

interface TrustedDirectory {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ParsedConnection {
  readonly clientConfig: PostgresLogicalRestoreConnectionConfig;
  readonly pgEnvironment: Readonly<Record<string, string>>;
  readonly urlSha256: string;
}

interface TrustedConnectionFile {
  readonly filePath: string;
  readonly value: string;
  readonly snapshot: TrustedFileSnapshot;
}

interface ValidatedBackup {
  readonly directory: TrustedDirectory;
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly stateReceiptPath: string;
  readonly archive: TrustedFileSnapshot;
  readonly manifest: TrustedFileSnapshot;
  readonly stateReceipt: TrustedFileSnapshot;
  readonly parsedManifest: PostgresLogicalBackupManifest;
  readonly parsedStateReceipt: PostgresLogicalSourceStateReceipt;
}

interface TargetIdentityRow extends QueryResultRow {
  readonly systemIdentifier: string;
  readonly databaseOid: string;
  readonly databaseName: string;
  readonly serverVersionNum: string;
  readonly targetClass: string | null;
  readonly transactionReadOnly: boolean;
  readonly inRecovery: boolean;
  readonly databaseIsTemplate: boolean;
  readonly databaseAllowsConnections: boolean;
  readonly hasCreatePrivilege: boolean;
  readonly sameEffectiveRole: boolean;
}

interface RoleSafetyRow extends QueryResultRow {
  readonly roleName: string;
  readonly canLogin: boolean;
  readonly inheritsPrivileges: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
}

interface SchemaPresenceRow extends QueryResultRow {
  readonly schemaName: string;
}

interface TableNameRow extends QueryResultRow {
  readonly schemaName: string;
  readonly tableName: string;
}

interface CountRow extends QueryResultRow {
  readonly value: string;
}

interface NamedCountRow extends QueryResultRow {
  readonly tableName: string;
  readonly rowCount: string;
}

interface MetadataRow extends QueryResultRow {
  readonly key: string;
  readonly value: string;
}

interface SecurityRow extends QueryResultRow {
  readonly unsafe: boolean;
}

interface RoleNameRow extends QueryResultRow {
  readonly roleName: string;
}

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

const API_ROLE_NAMES = Object.freeze(["anon", "authenticated", "service_role"] as const);

function aclContractSha256(): string {
  return canonicalSha256({
    kind: "pintpath-postgres-logical-restore-acl-contract",
    version: 1,
    migrationContractSha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    authoritativeTableSetSha256: canonicalSha256(
      POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name).sort(),
    ),
    publicAndApiRoles: {
      applicationSchema: [],
      operationsSchema: [],
      privateTables: [],
      privateSequences: [],
      privateFunctions: [],
    },
    runtime: {
      applicationSchema: ["USAGE"],
      authoritativeTables: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      schemaMetadata: ["SELECT"],
      applicationFunctions: ["EXECUTE"],
      operationsSchema: [],
    },
    migrator: {
      applicationSchema: ["USAGE"],
      operationsSchema: ["USAGE"],
      authoritativeTables: ["SELECT", "INSERT"],
      schemaMetadata: ["SELECT", "UPDATE"],
      operationsTables: ["SELECT", "INSERT", "UPDATE"],
      privateSequences: [],
      privateFunctions: [],
    },
  });
}

function restoreError(code: PostgresLogicalRestoreFailureCode): PostgresLogicalRestoreError {
  return new PostgresLogicalRestoreError(code);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw restoreError("invalid_arguments");
  return normalized;
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalPostgresBackupJson(value));
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
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

function sameSnapshot(left: TrustedFileSnapshot, right: TrustedFileSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.sha256 === right.sha256;
}

function makeBaseProcessEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ"] as const) {
    const value = environment[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) {
      result[key] = value;
    }
  }
  if (!result.PATH) result.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  result.LC_ALL = "C";
  return result;
}

class DirectRestoreConnection implements PostgresLogicalRestoreConnection {
  private constructor(private readonly client: Client) {}

  static async connect(config: PostgresLogicalRestoreConnectionConfig): Promise<DirectRestoreConnection> {
    const clientConfig: ClientConfig = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      query_timeout: config.query_timeout,
      application_name: config.application_name,
    };
    const client = new Client(clientConfig);
    try {
      await client.connect();
      return new DirectRestoreConnection(client);
    } catch {
      await client.end().catch(() => undefined);
      throw restoreError("target_unreachable");
    }
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresLogicalRestoreQueryResult<Row>> {
    const result = await this.client.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

const DEFAULT_DEPENDENCIES: PostgresLogicalRestoreDependencies = {
  env: process.env,
  getUid: () => process.getuid?.() ?? null,
  now: () => new Date(),
  pgRestoreCommand: "pg_restore",
  runProcess: runPostgresBackupProcess,
  connect: DirectRestoreConnection.connect,
  computeState: computePostgresLogicalStateInventory,
  allowInsecureLoopbackForTests: false,
};

function exactUid(dependencies: PostgresLogicalRestoreDependencies): number {
  const uid = dependencies.getUid();
  if (uid === null || !Number.isInteger(uid) || uid < 0) {
    throw restoreError("invalid_arguments");
  }
  return uid;
}

function canonicalAbsolutePath(value: string): string {
  if (!value || value.includes("\0")) throw restoreError("invalid_arguments");
  return path.resolve(value);
}

async function trustedDirectory(directoryInput: string, uid: number): Promise<TrustedDirectory> {
  const directoryPath = canonicalAbsolutePath(directoryInput);
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.uid !== BigInt(uid)
      || Number(stat.mode & 0o7777n) !== 0o700
      || fs.realpathSync(directoryPath) !== directoryPath
    ) {
      throw new Error("unsafe");
    }
    const entries = (await fs.promises.readdir(directoryPath)).sort();
    const expected = [
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ].sort();
    if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new Error("unsafe");
  } catch {
    throw restoreError("unsafe_backup_directory");
  }
  return { path: directoryPath, dev: stat.dev, ino: stat.ino };
}

async function assertTrustedDirectory(directory: TrustedDirectory, uid: number): Promise<void> {
  try {
    const stat = fs.lstatSync(directory.path, { bigint: true });
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.uid !== BigInt(uid)
      || Number(stat.mode & 0o7777n) !== 0o700
      || stat.dev !== directory.dev
      || stat.ino !== directory.ino
      || fs.realpathSync(directory.path) !== directory.path
    ) throw new Error("changed");
  } catch {
    throw restoreError("backup_tampered");
  }
}

async function snapshotTrustedFile(input: {
  readonly filePath: string;
  readonly uid: number;
  readonly maxBytes: bigint;
  readonly retainBytes: boolean;
  readonly invalidCode: PostgresLogicalRestoreFailureCode;
}): Promise<TrustedFileSnapshot> {
  let pathStat: fs.BigIntStats;
  let handle: fs.promises.FileHandle | null = null;
  try {
    pathStat = fs.lstatSync(input.filePath, { bigint: true });
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1n
      || pathStat.uid !== BigInt(input.uid)
      || Number(pathStat.mode & 0o7777n) !== 0o600
      || pathStat.size < 1n
      || pathStat.size > input.maxBytes
      || fs.realpathSync(input.filePath) !== input.filePath
    ) throw new Error("unsafe");
    handle = await fs.promises.open(
      input.filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(pathStat, opened)) throw new Error("changed");
    const hash = crypto.createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0n;
    while (offset < opened.size) {
      const length = Number(opened.size - offset > BigInt(buffer.length)
        ? BigInt(buffer.length)
        : opened.size - offset);
      const result = await handle.read(buffer, 0, length, Number(offset));
      if (result.bytesRead === 0) throw new Error("changed");
      const bytes = buffer.subarray(0, result.bytesRead);
      hash.update(bytes);
      if (input.retainBytes) chunks.push(Buffer.from(bytes));
      offset += BigInt(result.bytesRead);
    }
    const afterDescriptor = await handle.stat({ bigint: true });
    const afterPath = fs.lstatSync(input.filePath, { bigint: true });
    if (!sameFileIdentity(pathStat, afterDescriptor) || !sameFileIdentity(pathStat, afterPath)) {
      throw new Error("changed");
    }
    return {
      dev: pathStat.dev,
      ino: pathStat.ino,
      size: pathStat.size,
      mtimeNs: pathStat.mtimeNs,
      ctimeNs: pathStat.ctimeNs,
      sha256: hash.digest("hex"),
      ...(input.retainBytes ? { bytes: Buffer.concat(chunks) } : {}),
    };
  } catch (error) {
    if (error instanceof PostgresLogicalRestoreError) throw error;
    throw restoreError(input.invalidCode);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function safeDecodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw restoreError("backup_manifest_invalid");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTool(value: unknown, name: "pg_dump" | "pg_restore"): boolean {
  if (!isPlainObject(value) || !exactKeys(value, ["name", "version", "major"])) return false;
  return value.name === name
    && typeof value.version === "string"
    && VERSION_PATTERN.test(value.version)
    && Number.isSafeInteger(value.major)
    && Number(value.major) === 17
    && Number.parseInt(value.version, 10) === value.major;
}

function validStateBinding(value: unknown): boolean {
  if (!isPlainObject(value) || !exactKeys(value, [
    "receiptFile", "receiptSha256", "manifestBindingSha256",
    "sourceDatabaseIdentitySha256", "sourceUrlSha256", "snapshotBindingSha256",
    "migrationContractSha256", "schemaMetadataSha256", "targetDdlSha256",
    "authoritativeTableCount", "authoritativeRowCount", "tableSetSha256",
    "transformedDataSha256", "stateTotalsSha256", "keyRangesSha256",
    "archivedControlTableCount", "archivedControlRowCount",
    "archivedControlTableSetSha256", "archivedControlDataSha256",
    "archivedControlKeyRangesSha256",
    "overallStateSha256",
  ])) return false;
  return value.receiptFile === POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT
    && [
      value.receiptSha256, value.manifestBindingSha256,
      value.sourceDatabaseIdentitySha256, value.sourceUrlSha256, value.snapshotBindingSha256,
      value.migrationContractSha256, value.schemaMetadataSha256, value.targetDdlSha256,
      value.tableSetSha256, value.transformedDataSha256, value.stateTotalsSha256,
      value.keyRangesSha256, value.overallStateSha256,
      value.archivedControlTableSetSha256, value.archivedControlDataSha256,
      value.archivedControlKeyRangesSha256,
    ].every((entry) => typeof entry === "string" && SHA256_PATTERN.test(entry))
    && value.migrationContractSha256 === sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT)
    && value.authoritativeTableCount === POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
    && typeof value.authoritativeRowCount === "string"
    && /^\d+$/.test(value.authoritativeRowCount)
    && value.archivedControlTableCount === 3
    && typeof value.archivedControlRowCount === "string"
    && /^\d+$/.test(value.archivedControlRowCount);
}

function parseManifest(bytes: Buffer): PostgresLogicalBackupManifest {
  const text = safeDecodeUtf8(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw restoreError("backup_manifest_invalid");
  }
  if (!isPlainObject(value) || canonicalPostgresBackupJson(value) !== text) {
    throw restoreError("backup_manifest_invalid");
  }
  if (!exactKeys(value, [
    "schemaVersion", "kind", "createdAt", "archive", "tools", "validation", "state",
  ])) {
    throw restoreError("backup_manifest_invalid");
  }
  const archive = value.archive;
  const tools = value.tools;
  const validation = value.validation;
  const state = value.state;
  if (
    !isPlainObject(archive)
    || !isPlainObject(tools)
    || !isPlainObject(validation)
    || !validStateBinding(state)
  ) {
    throw restoreError("backup_manifest_invalid");
  }
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  const parsedDate = new Date(createdAt);
  const exactDate = Number.isFinite(parsedDate.valueOf()) && parsedDate.toISOString() === createdAt;
  const archiveSchemas = archive.schemas;
  const requiredOptions = archive.requiredRestoreOptions;
  if (
    value.schemaVersion !== 2
    || value.kind !== "pintpath-postgres-logical-backup"
    || !exactDate
    || !exactKeys(archive, [
      "file", "format", "bytes", "sha256", "schemas", "aclStatementsIncluded",
      "requiredRestoreOptions",
    ])
    || archive.file !== POSTGRES_LOGICAL_BACKUP_ARCHIVE
    || archive.format !== "custom"
    || !Number.isSafeInteger(archive.bytes)
    || Number(archive.bytes) < 1
    || typeof archive.sha256 !== "string"
    || !SHA256_PATTERN.test(archive.sha256)
    || JSON.stringify(archiveSchemas) !== JSON.stringify(POSTGRES_LOGICAL_BACKUP_SCHEMAS)
    || archive.aclStatementsIncluded !== false
    || JSON.stringify(requiredOptions) !== JSON.stringify(["--no-owner", "--no-acl"])
    || !exactKeys(tools, ["pgDump", "pgRestore"])
    || !validTool(tools.pgDump, "pg_dump")
    || !validTool(tools.pgRestore, "pg_restore")
    || !exactKeys(validation, [
      "method", "tocEntries", "listedEntries", "listingSha256",
      "dumpedFromDatabaseVersion", "dumpedByPgDumpVersion",
    ])
    || validation.method !== "pg_restore --list"
    || !Number.isSafeInteger(validation.tocEntries)
    || Number(validation.tocEntries) < 1
    || !Number.isSafeInteger(validation.listedEntries)
    || Number(validation.listedEntries) < 1
    || typeof validation.listingSha256 !== "string"
    || !SHA256_PATTERN.test(validation.listingSha256)
    || typeof validation.dumpedFromDatabaseVersion !== "string"
    || !VERSION_PATTERN.test(validation.dumpedFromDatabaseVersion)
    || typeof validation.dumpedByPgDumpVersion !== "string"
    || !VERSION_PATTERN.test(validation.dumpedByPgDumpVersion)
  ) {
    throw restoreError("backup_manifest_invalid");
  }
  const manifest = value as unknown as PostgresLogicalBackupManifest;
  if (postgresLogicalBackupManifestBindingSha256(manifest) !== manifest.state.manifestBindingSha256) {
    throw restoreError("backup_manifest_invalid");
  }
  return manifest;
}

function parseToolMajor(stdout: string): number {
  const prefix = "pg_restore (PostgreSQL) ";
  const line = stdout.trim();
  if (!line.startsWith(prefix) || line.includes("\n") || line.includes("\r")) {
    throw restoreError("tool_unavailable_or_unsupported");
  }
  const version = line.slice(prefix.length);
  if (!VERSION_PATTERN.test(version)) throw restoreError("tool_unavailable_or_unsupported");
  const major = Number.parseInt(version, 10);
  if (!Number.isSafeInteger(major) || major !== 17) {
    throw restoreError("tool_unavailable_or_unsupported");
  }
  return major;
}

function validateArchiveListing(listing: string, manifest: PostgresLogicalBackupManifest): void {
  if (sha256(listing) !== manifest.validation.listingSha256) {
    throw restoreError("backup_tampered");
  }
  const toc = Number(listing.match(/^;\s+TOC Entries:\s+(\d+)\s*$/m)?.[1] ?? 0);
  const listedLines = listing.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith(";"));
  const schemas = listedLines
    .map((line) => /\bSCHEMA\s+-\s+([^\s]+)(?:\s|$)/.exec(line)?.[1])
    .filter((value): value is string => Boolean(value))
    .sort();
  const hasAcl = listedLines.some((line) => /\s(?:ACL|DEFAULT ACL)\s/.test(line));
  const forbiddenNamespace = listedLines.some((line) => (
    /\b(?:public|auth|storage|graphql_public|extensions)\b/.test(line)
  ));
  const hasUnscopedEntry = listedLines.some((line) => (
    !/(?:^|\s)(?:pintpath_app|pintpath_ops)(?:\s|$)/.test(line)
  ));
  if (
    toc !== manifest.validation.tocEntries
    || listedLines.length !== manifest.validation.listedEntries
    || JSON.stringify(schemas) !== JSON.stringify([...POSTGRES_LOGICAL_BACKUP_SCHEMAS].sort())
    || hasAcl
    || forbiddenNamespace
    || hasUnscopedEntry
  ) throw restoreError("backup_manifest_invalid");
}

function validateStateReceiptBinding(
  receipt: PostgresLogicalSourceStateReceipt,
  manifest: PostgresLogicalBackupManifest,
): void {
  const binding = manifest.state;
  const state = receipt.state;
  if (
    receipt.capturedAt !== manifest.createdAt
    || receipt.archive.file !== manifest.archive.file
    || receipt.archive.bytes !== manifest.archive.bytes
    || receipt.archive.sha256 !== manifest.archive.sha256
    || receipt.archive.listingSha256 !== manifest.validation.listingSha256
    || receipt.manifestBindingSha256 !== binding.manifestBindingSha256
    || receipt.source.databaseIdentitySha256 !== binding.sourceDatabaseIdentitySha256
    || receipt.source.urlSha256 !== binding.sourceUrlSha256
    || receipt.source.snapshotBindingSha256 !== binding.snapshotBindingSha256
    || state.migrationContractSha256 !== binding.migrationContractSha256
    || state.schemaMetadataSha256 !== binding.schemaMetadataSha256
    || state.targetDdlSha256 !== binding.targetDdlSha256
    || state.authoritativeTableCount !== binding.authoritativeTableCount
    || state.authoritativeRowCount !== binding.authoritativeRowCount
    || state.tableSetSha256 !== binding.tableSetSha256
    || state.transformedDataSha256 !== binding.transformedDataSha256
    || state.stateTotalsSha256 !== binding.stateTotalsSha256
    || state.keyRangesSha256 !== binding.keyRangesSha256
    || state.archivedControlTableCount !== binding.archivedControlTableCount
    || state.archivedControlRowCount !== binding.archivedControlRowCount
    || state.archivedControlTableSetSha256 !== binding.archivedControlTableSetSha256
    || state.archivedControlDataSha256 !== binding.archivedControlDataSha256
    || state.archivedControlKeyRangesSha256 !== binding.archivedControlKeyRangesSha256
    || state.overallStateSha256 !== binding.overallStateSha256
  ) throw restoreError("backup_manifest_invalid");
}

/**
 * Reuses the restore authority's strict, canonical manifest parser for
 * operator-side transport verification. Keeping one parser prevents an
 * off-site copy from accepting an artifact that the restore path would later
 * reject.
 */
export function parsePostgresLogicalBackupManifest(
  bytes: Buffer,
): PostgresLogicalBackupManifest {
  return parseManifest(bytes);
}

/**
 * Proves that the separately hashed source-state receipt and logical archive
 * are the exact artifacts named by a parsed manifest. This intentionally does
 * not execute pg_restore or contact a database.
 */
export function assertPostgresLogicalBackupStateReceiptBinding(
  receipt: PostgresLogicalSourceStateReceipt,
  manifest: PostgresLogicalBackupManifest,
): void {
  validateStateReceiptBinding(receipt, manifest);
}

async function validateBackupBeforeConnection(
  options: RestorePostgresLogicalBackupOptions,
  dependencies: PostgresLogicalRestoreDependencies,
  uid: number,
): Promise<ValidatedBackup> {
  const expectedManifestSha256 = assertSha256(options.expectedBackupManifestSha256);
  const directory = await trustedDirectory(options.backupDirectory, uid);
  const archivePath = path.join(directory.path, POSTGRES_LOGICAL_BACKUP_ARCHIVE);
  const manifestPath = path.join(directory.path, POSTGRES_LOGICAL_BACKUP_MANIFEST);
  const stateReceiptPath = path.join(directory.path, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT);
  const manifest = await snapshotTrustedFile({
    filePath: manifestPath,
    uid,
    maxBytes: BigInt(MAX_MANIFEST_BYTES),
    retainBytes: true,
    invalidCode: "backup_manifest_invalid",
  });
  if (manifest.sha256 !== expectedManifestSha256 || !manifest.bytes) {
    throw restoreError("backup_tampered");
  }
  const parsedManifest = parseManifest(manifest.bytes);
  const archive = await snapshotTrustedFile({
    filePath: archivePath,
    uid,
    maxBytes: MAX_ARCHIVE_BYTES,
    retainBytes: false,
    invalidCode: "backup_tampered",
  });
  if (
    archive.sha256 !== parsedManifest.archive.sha256
    || archive.size !== BigInt(parsedManifest.archive.bytes)
  ) throw restoreError("backup_tampered");
  const stateReceipt = await snapshotTrustedFile({
    filePath: stateReceiptPath,
    uid,
    maxBytes: BigInt(MAX_STATE_RECEIPT_BYTES),
    retainBytes: true,
    invalidCode: "backup_tampered",
  });
  if (stateReceipt.sha256 !== parsedManifest.state.receiptSha256 || !stateReceipt.bytes) {
    throw restoreError("backup_tampered");
  }
  let parsedStateReceipt: PostgresLogicalSourceStateReceipt;
  try {
    parsedStateReceipt = parsePostgresLogicalSourceStateReceipt(stateReceipt.bytes);
  } catch {
    throw restoreError("backup_manifest_invalid");
  }
  validateStateReceiptBinding(parsedStateReceipt, parsedManifest);
  await assertTrustedDirectory(directory, uid);

  const processEnvironment = makeBaseProcessEnvironment(dependencies.env);
  let version;
  try {
    version = await dependencies.runProcess({
      command: dependencies.pgRestoreCommand,
      args: ["--version"],
      env: processEnvironment,
      timeoutMs: TOOL_TIMEOUT_MS,
      maxStdoutBytes: VERSION_OUTPUT_LIMIT,
      maxStderrBytes: VERSION_OUTPUT_LIMIT,
    });
  } catch {
    throw restoreError("tool_unavailable_or_unsupported");
  }
  if (version.exitCode !== 0 || version.stderr.trim()) {
    throw restoreError("tool_unavailable_or_unsupported");
  }
  const toolMajor = parseToolMajor(version.stdout);
  if (toolMajor !== parsedManifest.tools.pgRestore.major) {
    throw restoreError("tool_unavailable_or_unsupported");
  }
  let listing;
  try {
    listing = await dependencies.runProcess({
      command: dependencies.pgRestoreCommand,
      args: ["--list", "--format=custom", archivePath],
      env: processEnvironment,
      timeoutMs: LIST_TIMEOUT_MS,
      maxStdoutBytes: LISTING_OUTPUT_LIMIT,
      maxStderrBytes: RESTORE_OUTPUT_LIMIT,
    });
  } catch {
    throw restoreError("backup_manifest_invalid");
  }
  if (listing.exitCode !== 0 || listing.stderr.trim()) {
    throw restoreError("backup_manifest_invalid");
  }
  validateArchiveListing(listing.stdout, parsedManifest);
  const archiveAfter = await snapshotTrustedFile({
    filePath: archivePath,
    uid,
    maxBytes: MAX_ARCHIVE_BYTES,
    retainBytes: false,
    invalidCode: "backup_tampered",
  });
  const manifestAfter = await snapshotTrustedFile({
    filePath: manifestPath,
    uid,
    maxBytes: BigInt(MAX_MANIFEST_BYTES),
    retainBytes: false,
    invalidCode: "backup_tampered",
  });
  const stateReceiptAfter = await snapshotTrustedFile({
    filePath: stateReceiptPath,
    uid,
    maxBytes: BigInt(MAX_STATE_RECEIPT_BYTES),
    retainBytes: false,
    invalidCode: "backup_tampered",
  });
  if (
    !sameSnapshot(archive, archiveAfter)
    || !sameSnapshot(manifest, manifestAfter)
    || !sameSnapshot(stateReceipt, stateReceiptAfter)
  ) {
    throw restoreError("backup_tampered");
  }
  await assertTrustedDirectory(directory, uid);
  return {
    directory,
    archivePath,
    manifestPath,
    stateReceiptPath,
    archive,
    manifest,
    stateReceipt,
    parsedManifest,
    parsedStateReceipt,
  };
}

async function readTrustedConnectionFile(
  fileInput: string,
  uid: number,
): Promise<TrustedConnectionFile> {
  const filePath = canonicalAbsolutePath(fileInput);
  const snapshot = await snapshotTrustedFile({
    filePath,
    uid,
    maxBytes: 16n * 1024n,
    retainBytes: true,
    invalidCode: "unsafe_connection_file",
  });
  if (!snapshot.bytes) throw restoreError("unsafe_connection_file");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes).trim();
  } catch {
    throw restoreError("unsafe_connection_file");
  }
  if (!decoded || decoded.includes("\0") || /[\r\n]/.test(decoded)) {
    throw restoreError("unsafe_connection_file");
  }
  return { filePath, value: decoded, snapshot };
}


async function assertTargetConnectionFileUnchanged(
  expected: TrustedConnectionFile,
  uid: number,
): Promise<void> {
  const actual = await snapshotTrustedFile({
    filePath: expected.filePath,
    uid,
    maxBytes: 16n * 1024n,
    retainBytes: false,
    invalidCode: "unsafe_connection_file",
  }).catch(() => null);
  if (!actual || !sameSnapshot(expected.snapshot, actual)) {
    throw restoreError("unsafe_connection_file");
  }
}

function decodeUrlComponent(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes("\0") && !/[\r\n]/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function parseSafeTargetUrl(
  value: string,
  dependencies: PostgresLogicalRestoreDependencies,
): ParsedConnection {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw restoreError("unsafe_connection_url");
  }
  const hostname = parsed.hostname.toLowerCase();
  const normalizedHost = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(normalizedHost);
  const queryEntries = [...parsed.searchParams.entries()];
  const sslModeEntries = queryEntries.filter(([name]) => name.toLowerCase() === "sslmode");
  const unsupportedQuery = queryEntries.some(([name]) => name !== "sslmode");
  const sslMode = sslModeEntries[0]?.[1].toLowerCase() ?? "";
  const testLoopback = dependencies.allowInsecureLoopbackForTests
    && dependencies.env.NODE_ENV === "test"
    && loopback
    && sslMode === "disable";
  const port = Number(parsed.port || "5432");
  const databasePath = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : "";
  const database = decodeUrlComponent(databasePath);
  const user = decodeUrlComponent(parsed.username);
  const password = decodeUrlComponent(parsed.password);
  const poolerHost = normalizedHost.includes("pooler")
    || normalizedHost.includes("pgbouncer")
    || normalizedHost.includes("pgpool");
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !normalizedHost
    || poolerHost
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || port === 6_543
    || !database
    || database.includes("/")
    || !user
    || !password
    || parsed.hash
    || sslModeEntries.length !== 1
    || unsupportedQuery
    || (!testLoopback && !["require", "verify-ca", "verify-full"].includes(sslMode))
  ) throw restoreError("unsafe_connection_url");
  const ssl: PostgresLogicalRestoreConnectionConfig["ssl"] = testLoopback
    ? false
    : { rejectUnauthorized: sslMode !== "require" };
  return {
    clientConfig: {
      host: normalizedHost,
      port,
      database,
      user,
      password,
      ssl,
      connectionTimeoutMillis: 15_000,
      query_timeout: 30_000,
      application_name: "pintpath-logical-restore-rehearsal",
    },
    pgEnvironment: Object.freeze({
      PGHOST: normalizedHost,
      PGPORT: String(port),
      PGDATABASE: database,
      PGUSER: user,
      PGPASSWORD: password,
      PGSSLMODE: sslMode,
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-restore-rehearsal",
    }),
    urlSha256: sha256(value),
  };
}

function assertTargetIdentityRow(row: TargetIdentityRow | undefined): TargetIdentityRow {
  if (
    !row
    || !/^\d+$/.test(row.systemIdentifier)
    || !/^\d+$/.test(row.databaseOid)
    || !row.databaseName
    || !/^\d{5,6}$/.test(row.serverVersionNum)
    || Number(row.serverVersionNum) < 170_000
    || Number(row.serverVersionNum) >= 180_000
    || row.targetClass !== DISPOSABLE_TARGET_CLASS
    || row.transactionReadOnly !== false
    || row.inRecovery !== false
    || row.databaseIsTemplate !== false
    || row.databaseAllowsConnections !== true
    || row.hasCreatePrivilege !== true
    || row.sameEffectiveRole !== true
  ) throw restoreError("target_not_disposable");
  return row;
}

function targetIdentitySha256(row: TargetIdentityRow): string {
  return canonicalSha256({
    kind: "pintpath-postgres-logical-restore-target",
    version: 1,
    systemIdentifier: row.systemIdentifier,
    databaseOid: row.databaseOid,
    databaseName: row.databaseName,
    serverVersionNum: row.serverVersionNum,
    targetClass: row.targetClass,
  });
}

async function inspectTargetIdentity(
  connection: PostgresLogicalRestoreConnection,
): Promise<string> {
  let identityResult: PostgresLogicalRestoreQueryResult<TargetIdentityRow>;
  let rolesResult: PostgresLogicalRestoreQueryResult<RoleSafetyRow>;
  try {
    identityResult = await connection.query<TargetIdentityRow>(`/* pintpath:logical-restore:target-identity */
      SELECT
        control.system_identifier::text AS "systemIdentifier",
        database.oid::text AS "databaseOid",
        current_database() AS "databaseName",
        current_setting('server_version_num') AS "serverVersionNum",
        current_setting('${POSTGRES_LOGICAL_RESTORE_TARGET_CLASS_SETTING}', true) AS "targetClass",
        current_setting('transaction_read_only')::boolean AS "transactionReadOnly",
        pg_is_in_recovery() AS "inRecovery",
        database.datistemplate AS "databaseIsTemplate",
        database.datallowconn AS "databaseAllowsConnections",
        has_database_privilege(current_user, database.oid, 'CREATE') AS "hasCreatePrivilege",
        session_user = current_user AS "sameEffectiveRole"
      FROM pg_catalog.pg_database AS database
      CROSS JOIN pg_catalog.pg_control_system() AS control
      WHERE database.datname = current_database()`);
    rolesResult = await connection.query<RoleSafetyRow>(`/* pintpath:logical-restore:required-roles */
      SELECT
        rolname AS "roleName",
        rolcanlogin AS "canLogin",
        rolinherit AS "inheritsPrivileges",
        rolsuper AS "superuser",
        rolcreatedb AS "createDatabase",
        rolcreaterole AS "createRole",
        rolreplication AS "replication",
        rolbypassrls AS "bypassRls"
      FROM pg_catalog.pg_roles
      WHERE rolname = ANY($1::text[])
      ORDER BY rolname`, [[MIGRATOR_ROLE, RUNTIME_ROLE]]);
  } catch (error) {
    if (error instanceof PostgresLogicalRestoreError) throw error;
    throw restoreError("target_not_disposable");
  }
  if (identityResult.rows.length !== 1) throw restoreError("target_not_disposable");
  const row = assertTargetIdentityRow(identityResult.rows[0]);
  const expectedRoles = [MIGRATOR_ROLE, RUNTIME_ROLE].sort();
  if (
    JSON.stringify(rolesResult.rows.map((role) => role.roleName).sort()) !== JSON.stringify(expectedRoles)
    || rolesResult.rows.some((role) => (
      role.canLogin
      || !role.inheritsPrivileges
      || role.superuser
      || role.createDatabase
      || role.createRole
      || role.replication
      || role.bypassRls
    ))
  ) throw restoreError("target_not_disposable");
  return targetIdentitySha256(row);
}

async function assertPrivateSchemasAbsent(
  connection: PostgresLogicalRestoreConnection,
): Promise<void> {
  let result: PostgresLogicalRestoreQueryResult<SchemaPresenceRow>;
  try {
    result = await connection.query<SchemaPresenceRow>(`/* pintpath:logical-restore:private-schemas-before */
      SELECT nspname AS "schemaName"
      FROM pg_catalog.pg_namespace
      WHERE nspname = ANY($1::text[])
      ORDER BY nspname`, [[APPLICATION_SCHEMA, OPERATIONS_SCHEMA]]);
  } catch {
    throw restoreError("target_not_disposable");
  }
  if (result.rows.length !== 0) throw restoreError("target_not_empty");
}

async function acquireRestoreLock(connection: PostgresLogicalRestoreConnection): Promise<void> {
  try {
    const result = await connection.query<QueryResultRow & { acquired: boolean }>(
      "/* pintpath:logical-restore:lock */ SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [RESTORE_LOCK_KEY],
    );
    if (result.rows[0]?.acquired !== true) throw restoreError("target_busy");
  } catch (error) {
    if (error instanceof PostgresLogicalRestoreError) throw error;
    throw restoreError("target_busy");
  }
}

async function releaseRestoreLock(connection: PostgresLogicalRestoreConnection): Promise<void> {
  try {
    await connection.query(
      "/* pintpath:logical-restore:unlock */ SELECT pg_advisory_unlock($1::bigint)",
      [RESTORE_LOCK_KEY],
    );
  } catch {
    // Closing the dedicated connection releases a session advisory lock.
  }
}

async function connectTarget(
  targetUrlFile: string,
  dependencies: PostgresLogicalRestoreDependencies,
  uid: number,
): Promise<{
  connection: PostgresLogicalRestoreConnection;
  parsed: ParsedConnection;
  connectionFile: TrustedConnectionFile;
}> {
  const connectionFile = await readTrustedConnectionFile(targetUrlFile, uid);
  const parsed = parseSafeTargetUrl(connectionFile.value, dependencies);
  let connection: PostgresLogicalRestoreConnection;
  try {
    connection = await dependencies.connect(parsed.clientConfig);
  } catch (error) {
    if (error instanceof PostgresLogicalRestoreError) throw error;
    throw restoreError("target_unreachable");
  }
  return { connection, parsed, connectionFile };
}

export async function inspectPostgresLogicalRestoreTarget(
  options: InspectPostgresLogicalRestoreTargetOptions,
  overrides: Partial<PostgresLogicalRestoreDependencies> = {},
): Promise<PostgresLogicalRestoreTargetInspection> {
  const dependencies: PostgresLogicalRestoreDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const uid = exactUid(dependencies);
  const { connection, connectionFile } = await connectTarget(options.targetUrlFile, dependencies, uid);
  try {
    const targetIdentitySha256Value = await inspectTargetIdentity(connection);
    await assertPrivateSchemasAbsent(connection);
    await assertTargetConnectionFileUnchanged(connectionFile, uid);
    return {
      schemaVersion: 1,
      ok: true,
      targetIdentitySha256: targetIdentitySha256Value,
      disposableTarget: true,
      privateSchemasAbsent: true,
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw restoreError("verification_failed_target_disposal_required");
  return `"${value.replaceAll('"', '""')}"`;
}

async function hardenRestoredPrivileges(
  connection: PostgresLogicalRestoreConnection,
): Promise<void> {
  const authoritativeTables = POSTGRES_MIGRATION_CONTRACT.tables
    .map((table) => `${APPLICATION_SCHEMA}.${quoteIdentifier(table.name)}`)
    .join(", ");
  try {
    await connection.query("/* pintpath:logical-restore:privileges-begin */ BEGIN");
    const apiRoles = await connection.query<RoleNameRow>(`/* pintpath:logical-restore:api-roles */
      SELECT rolname AS "roleName"
      FROM pg_catalog.pg_roles
      WHERE rolname = ANY($1::text[])
      ORDER BY rolname`, [API_ROLE_NAMES]);
    if (apiRoles.rows.some((row) => !API_ROLE_NAMES.includes(
      row.roleName as (typeof API_ROLE_NAMES)[number],
    ))) throw new Error("unexpected_api_role");
    await connection.query(`/* pintpath:logical-restore:privileges-schema-deny */
      REVOKE ALL ON SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM PUBLIC;
      REVOKE ALL ON SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM ${RUNTIME_ROLE}, ${MIGRATOR_ROLE}`);
    await connection.query(`/* pintpath:logical-restore:privileges-reset */
      REVOKE ALL ON ALL TABLES IN SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM PUBLIC;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM PUBLIC;
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM PUBLIC;
      REVOKE ALL ON ALL TABLES IN SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM ${RUNTIME_ROLE}, ${MIGRATOR_ROLE};
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM ${RUNTIME_ROLE}, ${MIGRATOR_ROLE};
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM ${RUNTIME_ROLE}, ${MIGRATOR_ROLE}`);
    await connection.query(`/* pintpath:logical-restore:privileges-public-default-deny */
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${APPLICATION_SCHEMA} REVOKE ALL ON TABLES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${APPLICATION_SCHEMA} REVOKE ALL ON SEQUENCES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${APPLICATION_SCHEMA} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${OPERATIONS_SCHEMA} REVOKE ALL ON TABLES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${OPERATIONS_SCHEMA} REVOKE ALL ON SEQUENCES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${OPERATIONS_SCHEMA} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
    for (const row of apiRoles.rows) {
      const role = quoteIdentifier(row.roleName);
      await connection.query(`/* pintpath:logical-restore:privileges-api-deny */
        REVOKE ALL ON SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM ${role};
        REVOKE ALL ON ALL TABLES IN SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM ${role};
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM ${role};
        REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${APPLICATION_SCHEMA}, ${OPERATIONS_SCHEMA} FROM ${role};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${APPLICATION_SCHEMA} REVOKE ALL ON TABLES FROM ${role};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${APPLICATION_SCHEMA} REVOKE ALL ON SEQUENCES FROM ${role};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${APPLICATION_SCHEMA} REVOKE EXECUTE ON FUNCTIONS FROM ${role};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${OPERATIONS_SCHEMA} REVOKE ALL ON TABLES FROM ${role};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${OPERATIONS_SCHEMA} REVOKE ALL ON SEQUENCES FROM ${role};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${OPERATIONS_SCHEMA} REVOKE EXECUTE ON FUNCTIONS FROM ${role}`);
    }
    await connection.query(`/* pintpath:logical-restore:privileges-grant */
      GRANT USAGE ON SCHEMA ${APPLICATION_SCHEMA} TO ${RUNTIME_ROLE}, ${MIGRATOR_ROLE};
      GRANT USAGE ON SCHEMA ${OPERATIONS_SCHEMA} TO ${MIGRATOR_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${authoritativeTables} TO ${RUNTIME_ROLE};
      GRANT SELECT, INSERT ON TABLE ${authoritativeTables} TO ${MIGRATOR_ROLE};
      GRANT SELECT ON TABLE ${APPLICATION_SCHEMA}.schema_metadata TO ${RUNTIME_ROLE};
      GRANT SELECT, UPDATE ON TABLE ${APPLICATION_SCHEMA}.schema_metadata TO ${MIGRATOR_ROLE};
      GRANT SELECT, INSERT, UPDATE ON TABLE
        ${OPERATIONS_SCHEMA}.migration_runs,
        ${OPERATIONS_SCHEMA}.migration_chunks
      TO ${MIGRATOR_ROLE};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${APPLICATION_SCHEMA} TO ${RUNTIME_ROLE}`);
    await connection.query("/* pintpath:logical-restore:privileges-commit */ COMMIT");
  } catch {
    try {
      await connection.query("/* pintpath:logical-restore:privileges-rollback */ ROLLBACK");
    } catch {
      // The disposable target must be discarded after an unverified restore.
    }
    throw restoreError("verification_failed_target_disposal_required");
  }
}

function parseExactSafeCount(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw restoreError("verification_failed_target_disposal_required");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw restoreError("verification_failed_target_disposal_required");
  }
  return count;
}

async function verifyCatalog(
  connection: PostgresLogicalRestoreConnection,
): Promise<void> {
  const expectedApplicationTables = [
    ...POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
    "schema_metadata",
  ].sort();
  const expectedOperationsTables = ["migration_chunks", "migration_runs"];
  let schemas: PostgresLogicalRestoreQueryResult<SchemaPresenceRow>;
  let tables: PostgresLogicalRestoreQueryResult<TableNameRow>;
  let columns: PostgresLogicalRestoreQueryResult<CountRow>;
  let foreignKeys: PostgresLogicalRestoreQueryResult<CountRow>;
  let rowSecurity: PostgresLogicalRestoreQueryResult<CountRow>;
  try {
    schemas = await connection.query<SchemaPresenceRow>(`/* pintpath:logical-restore:private-schemas-after */
      SELECT nspname AS "schemaName"
      FROM pg_catalog.pg_namespace
      WHERE nspname = ANY($1::text[])
      ORDER BY nspname`, [[APPLICATION_SCHEMA, OPERATIONS_SCHEMA]]);
    tables = await connection.query<TableNameRow>(`/* pintpath:logical-restore:table-set */
      SELECT namespace.nspname AS "schemaName", relation.relname AS "tableName"
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[])
        AND relation.relkind IN ('r', 'p')
      ORDER BY namespace.nspname, relation.relname`, [[APPLICATION_SCHEMA, OPERATIONS_SCHEMA]]);
    columns = await connection.query<CountRow>(`/* pintpath:logical-restore:authoritative-columns */
      SELECT count(*)::text AS value
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
        AND relation.relkind IN ('r', 'p')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped`, [
      APPLICATION_SCHEMA,
      POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
    ]);
    foreignKeys = await connection.query<CountRow>(`/* pintpath:logical-restore:foreign-keys */
      SELECT count(*)::text AS value
      FROM pg_catalog.pg_constraint AS constraint_record
      JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
        AND constraint_record.contype = 'f'`, [
      APPLICATION_SCHEMA,
      POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
    ]);
    rowSecurity = await connection.query<CountRow>(`/* pintpath:logical-restore:row-security */
      SELECT count(*)::text AS value
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[])
        AND relation.relkind IN ('r', 'p')
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity`, [[APPLICATION_SCHEMA, OPERATIONS_SCHEMA]]);
  } catch (error) {
    if (error instanceof PostgresLogicalRestoreError) throw error;
    throw restoreError("verification_failed_target_disposal_required");
  }
  const actualSchemas = schemas.rows.map((row) => row.schemaName).sort();
  const applicationTables = tables.rows
    .filter((row) => row.schemaName === APPLICATION_SCHEMA)
    .map((row) => row.tableName)
    .sort();
  const operationsTables = tables.rows
    .filter((row) => row.schemaName === OPERATIONS_SCHEMA)
    .map((row) => row.tableName)
    .sort();
  if (
    JSON.stringify(actualSchemas) !== JSON.stringify([...POSTGRES_LOGICAL_BACKUP_SCHEMAS].sort())
    || JSON.stringify(applicationTables) !== JSON.stringify(expectedApplicationTables)
    || JSON.stringify(operationsTables) !== JSON.stringify(expectedOperationsTables)
    || parseExactSafeCount(columns.rows[0]?.value) !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns
    || parseExactSafeCount(foreignKeys.rows[0]?.value) !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys
    || parseExactSafeCount(rowSecurity.rows[0]?.value)
      !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + 3
  ) throw restoreError("verification_failed_target_disposal_required");
}

function assertReadyMetadata(rows: readonly MetadataRow[]): string {
  const sorted = [...rows].sort((left, right) => left.key.localeCompare(right.key));
  if (
    JSON.stringify(sorted.map((row) => row.key)) !== JSON.stringify(EXPECTED_METADATA_KEYS)
    || sorted.some((row) => typeof row.value !== "string" || /[\r\n\0]/.test(row.value))
  ) throw restoreError("verification_failed_target_disposal_required");
  const metadata = new Map(sorted.map((row) => [row.key, row.value]));
  const hashKeys = [
    "migration_contract_sha256",
    "migration_manifest_sha256",
    "migration_plan_sha256",
    "migration_run_sha256",
    "source_schema_fingerprint",
    "source_schema_sha256",
    "source_snapshot_sha256",
    "target_ddl_sha256",
  ];
  if (
    metadata.get("schema_version") !== "1"
    || metadata.get("import_state") !== "ready"
    || metadata.get("migration_contract_sha256")
      !== sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT)
    || metadata.get("source_schema_fingerprint")
      !== POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(metadata.get("migration_candidate_sha") ?? "")
    || !/^\d+$/.test(metadata.get("source_schema_version") ?? "")
    || Number(metadata.get("source_schema_version")) !== POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion
    || hashKeys.some((key) => !SHA256_PATTERN.test(metadata.get(key) ?? ""))
  ) throw restoreError("verification_failed_target_disposal_required");
  return canonicalSha256(sorted.map((row) => [row.key, row.value]));
}

async function loadAndVerifyCounts(
  connection: PostgresLogicalRestoreConnection,
): Promise<{
  authoritativeRowCount: string;
  nonEmptyAuthoritativeTableCount: number;
  authoritativeCountInventorySha256: string;
  controlCountInventorySha256: string;
}> {
  const authoritativeNames = POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name).sort();
  const authoritativeSql = authoritativeNames.map((name) => (
    `SELECT '${name}'::text AS "tableName", count(*)::text AS "rowCount" `
    + `FROM ${APPLICATION_SCHEMA}.${quoteIdentifier(name)}`
  )).join(" UNION ALL ");
  let authoritative: PostgresLogicalRestoreQueryResult<NamedCountRow>;
  let control: PostgresLogicalRestoreQueryResult<NamedCountRow>;
  try {
    authoritative = await connection.query<NamedCountRow>(
      `/* pintpath:logical-restore:authoritative-count-inventory */ ${authoritativeSql}`,
    );
    control = await connection.query<NamedCountRow>(`/* pintpath:logical-restore:control-count-inventory */
      SELECT 'migration_chunks'::text AS "tableName", count(*)::text AS "rowCount"
      FROM ${OPERATIONS_SCHEMA}.migration_chunks
      UNION ALL
      SELECT 'migration_runs'::text AS "tableName", count(*)::text AS "rowCount"
      FROM ${OPERATIONS_SCHEMA}.migration_runs
      ORDER BY "tableName"`);
  } catch {
    throw restoreError("verification_failed_target_disposal_required");
  }
  const normalize = (rows: readonly NamedCountRow[], expected: readonly string[]) => {
    const sorted = [...rows].sort((left, right) => left.tableName.localeCompare(right.tableName));
    if (JSON.stringify(sorted.map((row) => row.tableName)) !== JSON.stringify(expected)) {
      throw restoreError("verification_failed_target_disposal_required");
    }
    return sorted.map((row) => {
      if (!/^\d+$/.test(row.rowCount)) {
        throw restoreError("verification_failed_target_disposal_required");
      }
      return [row.tableName, row.rowCount] as const;
    });
  };
  const authoritativeInventory = normalize(authoritative.rows, authoritativeNames);
  const controlInventory = normalize(control.rows, ["migration_chunks", "migration_runs"]);
  const authoritativeRowCount = authoritativeInventory
    .reduce((sum, [, count]) => sum + BigInt(count), 0n);
  const nonEmptyAuthoritativeTableCount = authoritativeInventory
    .filter(([, count]) => BigInt(count) > 0n).length;
  if (nonEmptyAuthoritativeTableCount < 1) {
    throw restoreError("verification_failed_target_disposal_required");
  }
  return {
    authoritativeRowCount: authoritativeRowCount.toString(),
    nonEmptyAuthoritativeTableCount,
    authoritativeCountInventorySha256: canonicalSha256(authoritativeInventory),
    controlCountInventorySha256: canonicalSha256(controlInventory),
  };
}

async function verifySecurityIsolation(connection: PostgresLogicalRestoreConnection): Promise<void> {
  let api: PostgresLogicalRestoreQueryResult<SecurityRow>;
  let migrator: PostgresLogicalRestoreQueryResult<SecurityRow>;
  let runtimeApplication: PostgresLogicalRestoreQueryResult<SecurityRow>;
  let runtime: PostgresLogicalRestoreQueryResult<SecurityRow>;
  try {
    api = await connection.query<SecurityRow>(`/* pintpath:logical-restore:api-isolation */
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
    runtimeApplication = await connection.query<SecurityRow>(`/* pintpath:logical-restore:runtime-application-access */
      WITH runtime_role AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1
      ), application_namespace AS (
        SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2
      ), authoritative_relations AS (
        SELECT relation.oid
        FROM pg_catalog.pg_class AS relation
        JOIN application_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE relation.relkind IN ('r', 'p')
          AND relation.relname = ANY($3::text[])
      ), metadata_relation AS (
        SELECT relation.oid
        FROM pg_catalog.pg_class AS relation
        JOIN application_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE relation.relname = 'schema_metadata'
          AND relation.relkind IN ('r', 'p')
      ), application_functions AS (
        SELECT routine.oid
        FROM pg_catalog.pg_proc AS routine
        JOIN application_namespace AS namespace ON namespace.oid = routine.pronamespace
      )
      SELECT (
        NOT EXISTS (SELECT 1 FROM runtime_role)
        OR NOT EXISTS (
          SELECT 1 FROM runtime_role AS role CROSS JOIN application_namespace AS namespace
          WHERE has_schema_privilege(role.oid, namespace.oid, 'USAGE')
            AND NOT has_schema_privilege(role.oid, namespace.oid, 'CREATE')
        ) OR EXISTS (
          SELECT 1 FROM runtime_role AS role CROSS JOIN authoritative_relations AS relation
          WHERE NOT has_table_privilege(role.oid, relation.oid, 'SELECT')
             OR NOT has_table_privilege(role.oid, relation.oid, 'INSERT')
             OR NOT has_table_privilege(role.oid, relation.oid, 'UPDATE')
             OR NOT has_table_privilege(role.oid, relation.oid, 'DELETE')
             OR has_table_privilege(role.oid, relation.oid, 'TRUNCATE')
             OR has_table_privilege(role.oid, relation.oid, 'REFERENCES')
             OR has_table_privilege(role.oid, relation.oid, 'TRIGGER')
        ) OR EXISTS (
          SELECT 1 FROM runtime_role AS role CROSS JOIN metadata_relation AS relation
          WHERE NOT has_table_privilege(role.oid, relation.oid, 'SELECT')
             OR has_table_privilege(role.oid, relation.oid, 'INSERT')
             OR has_table_privilege(role.oid, relation.oid, 'UPDATE')
             OR has_table_privilege(role.oid, relation.oid, 'DELETE')
             OR has_table_privilege(role.oid, relation.oid, 'TRUNCATE')
             OR has_table_privilege(role.oid, relation.oid, 'REFERENCES')
             OR has_table_privilege(role.oid, relation.oid, 'TRIGGER')
        ) OR EXISTS (
          SELECT 1 FROM runtime_role AS role CROSS JOIN application_functions AS routine
          WHERE NOT has_function_privilege(role.oid, routine.oid, 'EXECUTE')
        )
      ) AS unsafe`, [
      RUNTIME_ROLE,
      APPLICATION_SCHEMA,
      POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
    ]);
    migrator = await connection.query<SecurityRow>(`/* pintpath:logical-restore:migrator-reconciliation-access */
      WITH migrator_role AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1
      ), private_namespaces AS (
        SELECT oid, nspname FROM pg_catalog.pg_namespace
        WHERE nspname = ANY($2::text[])
      ), authoritative_relations AS (
        SELECT relation.oid
        FROM pg_catalog.pg_class AS relation
        JOIN private_namespaces AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $3
          AND relation.relkind IN ('r', 'p')
          AND relation.relname = ANY($4::text[])
      ), metadata_relation AS (
        SELECT relation.oid
        FROM pg_catalog.pg_class AS relation
        JOIN private_namespaces AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $3
          AND relation.relname = 'schema_metadata'
          AND relation.relkind IN ('r', 'p')
      ), operations_relations AS (
        SELECT relation.oid
        FROM pg_catalog.pg_class AS relation
        JOIN private_namespaces AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $5
          AND relation.relkind IN ('r', 'p')
      ), private_sequences AS (
        SELECT relation.oid
        FROM pg_catalog.pg_class AS relation
        JOIN private_namespaces AS namespace ON namespace.oid = relation.relnamespace
        WHERE relation.relkind = 'S'
      ), private_functions AS (
        SELECT routine.oid
        FROM pg_catalog.pg_proc AS routine
        JOIN private_namespaces AS namespace ON namespace.oid = routine.pronamespace
      )
      SELECT (
        NOT EXISTS (SELECT 1 FROM migrator_role)
        OR EXISTS (
          SELECT 1 FROM migrator_role AS role CROSS JOIN private_namespaces AS namespace
          WHERE NOT has_schema_privilege(role.oid, namespace.oid, 'USAGE')
             OR has_schema_privilege(role.oid, namespace.oid, 'CREATE')
        ) OR EXISTS (
          SELECT 1 FROM migrator_role AS role CROSS JOIN authoritative_relations AS relation
          WHERE NOT has_table_privilege(role.oid, relation.oid, 'SELECT')
             OR NOT has_table_privilege(role.oid, relation.oid, 'INSERT')
             OR has_table_privilege(role.oid, relation.oid, 'UPDATE')
             OR has_table_privilege(role.oid, relation.oid, 'DELETE')
             OR has_table_privilege(role.oid, relation.oid, 'TRUNCATE')
             OR has_table_privilege(role.oid, relation.oid, 'REFERENCES')
             OR has_table_privilege(role.oid, relation.oid, 'TRIGGER')
        ) OR EXISTS (
          SELECT 1 FROM migrator_role AS role CROSS JOIN metadata_relation AS relation
          WHERE NOT has_table_privilege(role.oid, relation.oid, 'SELECT')
             OR NOT has_table_privilege(role.oid, relation.oid, 'UPDATE')
             OR has_table_privilege(role.oid, relation.oid, 'INSERT')
             OR has_table_privilege(role.oid, relation.oid, 'DELETE')
             OR has_table_privilege(role.oid, relation.oid, 'TRUNCATE')
             OR has_table_privilege(role.oid, relation.oid, 'REFERENCES')
             OR has_table_privilege(role.oid, relation.oid, 'TRIGGER')
        ) OR EXISTS (
          SELECT 1 FROM migrator_role AS role CROSS JOIN operations_relations AS relation
          WHERE NOT has_table_privilege(role.oid, relation.oid, 'SELECT')
             OR NOT has_table_privilege(role.oid, relation.oid, 'INSERT')
             OR NOT has_table_privilege(role.oid, relation.oid, 'UPDATE')
             OR has_table_privilege(role.oid, relation.oid, 'DELETE')
             OR has_table_privilege(role.oid, relation.oid, 'TRUNCATE')
             OR has_table_privilege(role.oid, relation.oid, 'REFERENCES')
             OR has_table_privilege(role.oid, relation.oid, 'TRIGGER')
        ) OR EXISTS (
          SELECT 1 FROM migrator_role AS role CROSS JOIN private_sequences AS relation
          WHERE has_sequence_privilege(role.oid, relation.oid, 'USAGE')
             OR has_sequence_privilege(role.oid, relation.oid, 'SELECT')
             OR has_sequence_privilege(role.oid, relation.oid, 'UPDATE')
        ) OR EXISTS (
          SELECT 1 FROM migrator_role AS role CROSS JOIN private_functions AS routine
          WHERE has_function_privilege(role.oid, routine.oid, 'EXECUTE')
        )
      ) AS unsafe`, [
      MIGRATOR_ROLE,
      [APPLICATION_SCHEMA, OPERATIONS_SCHEMA],
      APPLICATION_SCHEMA,
      POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
      OPERATIONS_SCHEMA,
    ]);
    runtime = await connection.query<SecurityRow>(`/* pintpath:logical-restore:runtime-operations-isolation */
      WITH runtime_role AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1
      ), operations_namespace AS (
        SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2
      ), operations_relations AS (
        SELECT relation.oid, relation.relkind
        FROM pg_catalog.pg_class AS relation
        JOIN operations_namespace AS namespace ON namespace.oid = relation.relnamespace
      ), operations_functions AS (
        SELECT routine.oid FROM pg_catalog.pg_proc AS routine
        JOIN operations_namespace AS namespace ON namespace.oid = routine.pronamespace
      )
      SELECT (
        NOT EXISTS (SELECT 1 FROM runtime_role)
        OR EXISTS (
          SELECT 1 FROM runtime_role AS role CROSS JOIN operations_namespace AS namespace
          WHERE has_schema_privilege(role.oid, namespace.oid, 'USAGE')
             OR has_schema_privilege(role.oid, namespace.oid, 'CREATE')
        ) OR EXISTS (
          SELECT 1 FROM runtime_role AS role CROSS JOIN operations_relations AS relation
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
          ))
        ) OR EXISTS (
          SELECT 1 FROM runtime_role AS role CROSS JOIN operations_functions AS routine
          WHERE has_function_privilege(role.oid, routine.oid, 'EXECUTE')
        )
      ) AS unsafe`, [RUNTIME_ROLE, OPERATIONS_SCHEMA]);
  } catch {
    throw restoreError("verification_failed_target_disposal_required");
  }
  if (api.rows.length !== 1 || api.rows[0]?.unsafe !== false
    || runtimeApplication.rows.length !== 1 || runtimeApplication.rows[0]?.unsafe !== false
    || migrator.rows.length !== 1 || migrator.rows[0]?.unsafe !== false
    || runtime.rows.length !== 1 || runtime.rows[0]?.unsafe !== false) {
    throw restoreError("verification_failed_target_disposal_required");
  }
}

async function postRestoreVerification(
  connection: PostgresLogicalRestoreConnection,
  input: {
    backup: ValidatedBackup;
    targetIdentitySha256: string;
    targetUrlSha256: string;
    restoredAt: string;
    computeState: PostgresLogicalRestoreDependencies["computeState"];
  },
): Promise<PostgresLogicalRestoreReceipt> {
  await verifyCatalog(connection);
  let metadataResult: PostgresLogicalRestoreQueryResult<MetadataRow>;
  try {
    metadataResult = await connection.query<MetadataRow>(`/* pintpath:logical-restore:schema-metadata */
      SELECT key, value FROM ${APPLICATION_SCHEMA}.schema_metadata ORDER BY key`);
  } catch {
    throw restoreError("verification_failed_target_disposal_required");
  }
  const schemaMetadataSha256 = assertReadyMetadata(metadataResult.rows);
  const counts = await loadAndVerifyCounts(connection);
  await verifySecurityIsolation(connection);
  let targetState: PostgresLogicalStateInventory | null = null;
  let transactionOpen = false;
  let roleSet = false;
  try {
    await connection.query("/* pintpath:logical-restore:state-set-role */ SET ROLE pintpath_migrator");
    roleSet = true;
    await connection.query(`/* pintpath:logical-restore:state-begin */
      BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    transactionOpen = true;
    await connection.query(`/* pintpath:logical-restore:state-settings */
      SET LOCAL statement_timeout = '120s';
      SET LOCAL lock_timeout = '30s';
      SET LOCAL idle_in_transaction_session_timeout = '2h';
      SET LOCAL timezone = 'UTC';
      SET LOCAL bytea_output = 'hex';
      SET LOCAL extra_float_digits = 3`);
    targetState = await input.computeState(connection);
    await connection.query("/* pintpath:logical-restore:state-commit */ COMMIT");
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      await connection.query("/* pintpath:logical-restore:state-rollback */ ROLLBACK")
        .catch(() => undefined);
      transactionOpen = false;
    }
    throw restoreError("verification_failed_target_disposal_required");
  } finally {
    if (roleSet) {
      try {
        await connection.query("/* pintpath:logical-restore:state-reset-role */ RESET ROLE");
      } catch {
        targetState = null;
      }
    }
  }
  const sourceState = input.backup.parsedStateReceipt.state;
  if (
    !targetState
    || !exactPostgresLogicalStateMatch(sourceState, targetState)
    || counts.authoritativeRowCount !== targetState.authoritativeRowCount
    || counts.nonEmptyAuthoritativeTableCount !== targetState.nonEmptyAuthoritativeTableCount
    || schemaMetadataSha256 !== targetState.schemaMetadataSha256
  ) throw restoreError("verification_failed_target_disposal_required");
  return {
    kind: RECEIPT_KIND,
    version: RECEIPT_VERSION,
    status: "verified",
    restoredAt: input.restoredAt,
    backupManifestSha256: input.backup.manifest.sha256,
    backupArchiveSha256: input.backup.archive.sha256,
    targetIdentitySha256: input.targetIdentitySha256,
    targetUrlSha256: input.targetUrlSha256,
    authoritativeTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
    authoritativeColumnCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns,
    foreignKeyCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys,
    authoritativeRowCount: targetState.authoritativeRowCount,
    nonEmptyAuthoritativeTableCount: targetState.nonEmptyAuthoritativeTableCount,
    authoritativeCountInventorySha256: targetState.tableSetSha256,
    controlCountInventorySha256: targetState.archivedControlTableSetSha256,
    schemaMetadataSha256,
    rowSecurityTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + 3,
    aclContractSha256: aclContractSha256(),
    apiRolesIsolated: true,
    runtimeApplicationAccessRestored: true,
    migratorReconciliationAccessVerified: true,
    runtimeOperationsIsolated: true,
    promotionReconciliationReady: true,
    sourceStateBindingStatus: "exact-match",
    expectedSourceStateReceiptSha256: input.backup.stateReceipt.sha256,
    sourceSnapshotBindingSha256: input.backup.parsedStateReceipt.source.snapshotBindingSha256,
    expectedSourceTableSetSha256: sourceState.tableSetSha256,
    expectedSourceDataSha256: sourceState.transformedDataSha256,
    expectedSourceStateTotalsSha256: sourceState.stateTotalsSha256,
    expectedSourceKeyRangesSha256: sourceState.keyRangesSha256,
    expectedArchivedControlTableSetSha256: sourceState.archivedControlTableSetSha256,
    expectedArchivedControlDataSha256: sourceState.archivedControlDataSha256,
    expectedArchivedControlKeyRangesSha256: sourceState.archivedControlKeyRangesSha256,
    expectedSourceOverallStateSha256: sourceState.overallStateSha256,
    restoredOverallStateSha256: targetState.overallStateSha256,
    exactDataReconciliation: "canonical-contract-exact",
  };
}

interface ReceiptDestination {
  readonly filePath: string;
  readonly parentPath: string;
  readonly parentDev: bigint;
  readonly parentIno: bigint;
  readonly uid: number;
}

function validateReceiptDestination(fileInput: string, uid: number): ReceiptDestination {
  const filePath = canonicalAbsolutePath(fileInput);
  const parentPath = path.dirname(filePath);
  if (filePath === path.parse(filePath).root || path.basename(filePath) === ".") {
    throw restoreError("invalid_arguments");
  }
  try {
    if (fs.existsSync(filePath)) throw new Error("exists");
    const parent = fs.lstatSync(parentPath, { bigint: true });
    if (
      !parent.isDirectory()
      || parent.isSymbolicLink()
      || parent.uid !== BigInt(uid)
      || Number(parent.mode & 0o7777n) !== 0o700
      || fs.realpathSync(parentPath) !== parentPath
    ) throw new Error("unsafe");
    return {
      filePath,
      parentPath,
      parentDev: parent.dev,
      parentIno: parent.ino,
      uid,
    };
  } catch {
    throw restoreError("invalid_arguments");
  }
}

async function writePrivateReceipt(
  destination: ReceiptDestination,
  receipt: PostgresLogicalRestoreReceipt,
): Promise<string> {
  const bytes = Buffer.from(canonicalPostgresBackupJson(receipt), "utf8");
  let handle: fs.promises.FileHandle | null = null;
  let createdIdentity: { dev: bigint; ino: bigint } | null = null;
  try {
    const parent = fs.lstatSync(destination.parentPath, { bigint: true });
    if (
      !parent.isDirectory()
      || parent.isSymbolicLink()
      || parent.uid !== BigInt(destination.uid)
      || Number(parent.mode & 0o7777n) !== 0o700
      || parent.dev !== destination.parentDev
      || parent.ino !== destination.parentIno
    ) throw new Error("parent_changed");
    handle = await fs.promises.open(
      destination.filePath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const created = await handle.stat({ bigint: true });
    createdIdentity = { dev: created.dev, ino: created.ino };
    if (
      !created.isFile()
      || created.nlink !== 1n
      || created.uid !== BigInt(destination.uid)
      || Number(created.mode & 0o7777n) !== 0o600
    ) throw new Error("unsafe_receipt");
    await handle.writeFile(bytes);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const pathStat = fs.lstatSync(destination.filePath, { bigint: true });
    if (
      after.dev !== created.dev
      || after.ino !== created.ino
      || pathStat.dev !== created.dev
      || pathStat.ino !== created.ino
      || pathStat.size !== BigInt(bytes.length)
      || Number(pathStat.mode & 0o7777n) !== 0o600
    ) throw new Error("unsafe_receipt");
    return sha256(bytes);
  } catch {
    await handle?.close().catch(() => undefined);
    handle = null;
    if (createdIdentity) {
      try {
        const current = fs.lstatSync(destination.filePath, { bigint: true });
        if (current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) {
          await fs.promises.unlink(destination.filePath);
        }
      } catch {
        // Do not remove any path whose exact created identity cannot be proven.
      }
    }
    throw restoreError("receipt_failed_target_disposal_required");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertBackupUnchanged(
  backup: ValidatedBackup,
  uid: number,
): Promise<void> {
  await assertTrustedDirectory(backup.directory, uid);
  const archive = await snapshotTrustedFile({
    filePath: backup.archivePath,
    uid,
    maxBytes: MAX_ARCHIVE_BYTES,
    retainBytes: false,
    invalidCode: "backup_tampered",
  });
  const manifest = await snapshotTrustedFile({
    filePath: backup.manifestPath,
    uid,
    maxBytes: BigInt(MAX_MANIFEST_BYTES),
    retainBytes: false,
    invalidCode: "backup_tampered",
  });
  const stateReceipt = await snapshotTrustedFile({
    filePath: backup.stateReceiptPath,
    uid,
    maxBytes: BigInt(MAX_STATE_RECEIPT_BYTES),
    retainBytes: false,
    invalidCode: "backup_tampered",
  });
  if (
    !sameSnapshot(backup.archive, archive)
    || !sameSnapshot(backup.manifest, manifest)
    || !sameSnapshot(backup.stateReceipt, stateReceipt)
  ) {
    throw restoreError("backup_tampered");
  }
}

async function schemasRemainAbsentAfterFailedRestore(
  connection: PostgresLogicalRestoreConnection,
): Promise<boolean> {
  try {
    await assertPrivateSchemasAbsent(connection);
    return true;
  } catch {
    return false;
  }
}

export async function restorePostgresLogicalBackup(
  options: RestorePostgresLogicalBackupOptions,
  overrides: Partial<PostgresLogicalRestoreDependencies> = {},
): Promise<PostgresLogicalRestoreResult> {
  const dependencies: PostgresLogicalRestoreDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  if (options.confirmation !== POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE) {
    throw restoreError("confirmation_required");
  }
  const expectedTargetIdentitySha256 = assertSha256(options.expectedTargetIdentitySha256);
  const uid = exactUid(dependencies);
  const receiptDestination = validateReceiptDestination(options.receiptFile, uid);

  // The backup is fully authenticated, hashed, and structurally listed before
  // any network connection is attempted.
  const backup = await validateBackupBeforeConnection(options, dependencies, uid);
  const { connection, parsed, connectionFile } = await connectTarget(
    options.targetUrlFile,
    dependencies,
    uid,
  );
  let lockAcquired = false;
  let restoreStarted = false;
  try {
    const inspectedIdentity = await inspectTargetIdentity(connection);
    if (inspectedIdentity !== expectedTargetIdentitySha256) {
      throw restoreError("target_identity_mismatch");
    }
    await assertPrivateSchemasAbsent(connection);
    await acquireRestoreLock(connection);
    lockAcquired = true;
    const lockedIdentity = await inspectTargetIdentity(connection);
    if (lockedIdentity !== expectedTargetIdentitySha256) {
      throw restoreError("target_identity_mismatch");
    }
    await assertPrivateSchemasAbsent(connection);
    await assertBackupUnchanged(backup, uid);
    await assertTargetConnectionFileUnchanged(connectionFile, uid);

    const restoreEnvironment = Object.freeze({
      ...makeBaseProcessEnvironment(dependencies.env),
      ...parsed.pgEnvironment,
    });
    restoreStarted = true;
    let restored;
    try {
      restored = await dependencies.runProcess({
        command: dependencies.pgRestoreCommand,
        args: [
          "--format=custom",
          "--dbname=",
          "--no-owner",
          "--no-acl",
          "--exit-on-error",
          "--single-transaction",
          "--no-password",
          backup.archivePath,
        ],
        env: restoreEnvironment,
        timeoutMs: RESTORE_TIMEOUT_MS,
        maxStdoutBytes: RESTORE_OUTPUT_LIMIT,
        maxStderrBytes: RESTORE_OUTPUT_LIMIT,
      });
    } catch {
      const rolledBack = await schemasRemainAbsentAfterFailedRestore(connection);
      throw restoreError(rolledBack
        ? "restore_failed"
        : "restore_rollback_unverified_target_disposal_required");
    }
    if (restored.exitCode !== 0 || restored.stdout.trim() || restored.stderr.trim()) {
      const rolledBack = await schemasRemainAbsentAfterFailedRestore(connection);
      throw restoreError(rolledBack
        ? "restore_failed"
        : "restore_rollback_unverified_target_disposal_required");
    }
    // ACLs are intentionally absent from both the archive and pg_restore.
    // Reconstruct the reviewed least-privilege model transactionally before
    // the restored target is considered valid.
    await hardenRestoredPrivileges(connection);
    await assertBackupUnchanged(backup, uid).catch(() => {
      throw restoreError("verification_failed_target_disposal_required");
    });
    const identityAfterRestore = await inspectTargetIdentity(connection).catch(() => {
      throw restoreError("verification_failed_target_disposal_required");
    });
    if (identityAfterRestore !== expectedTargetIdentitySha256) {
      throw restoreError("verification_failed_target_disposal_required");
    }
    let restoredAt: string;
    try {
      restoredAt = dependencies.now().toISOString();
    } catch {
      throw restoreError("verification_failed_target_disposal_required");
    }
    const receipt = await postRestoreVerification(connection, {
      backup,
      targetIdentitySha256: expectedTargetIdentitySha256,
      targetUrlSha256: parsed.urlSha256,
      restoredAt,
      computeState: dependencies.computeState,
    });
    await assertBackupUnchanged(backup, uid).catch(() => {
      throw restoreError("verification_failed_target_disposal_required");
    });
    await assertTargetConnectionFileUnchanged(connectionFile, uid).catch(() => {
      throw restoreError("verification_failed_target_disposal_required");
    });
    const receiptSha256 = await writePrivateReceipt(receiptDestination, receipt);
    return {
      schemaVersion: 1,
      ok: true,
      receiptSha256,
      backupManifestSha256: backup.manifest.sha256,
      backupArchiveSha256: backup.archive.sha256,
      targetIdentitySha256: expectedTargetIdentitySha256,
      authoritativeRowCount: receipt.authoritativeRowCount,
      nonEmptyAuthoritativeTableCount: receipt.nonEmptyAuthoritativeTableCount,
      authoritativeCountInventorySha256: receipt.authoritativeCountInventorySha256,
      promotionReconciliationReady: true,
      sourceStateBindingStatus: "exact-match",
      overallStateSha256: receipt.restoredOverallStateSha256,
    };
  } catch (error) {
    if (error instanceof PostgresLogicalRestoreError) throw error;
    throw restoreError(restoreStarted
      ? "verification_failed_target_disposal_required"
      : "target_not_disposable");
  } finally {
    if (lockAcquired) await releaseRestoreLock(connection);
    await connection.close().catch(() => undefined);
  }
}

export const postgresLogicalRestoreInternals = {
  parseManifest,
  parseSafeTargetUrl,
  targetIdentitySha256,
  validateArchiveListing,
};
