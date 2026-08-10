import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";

import { POSTGRES_MIGRATION_CONTRACT } from "../db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../db/postgres-migration-schema.js";
import { sqlDatabaseInternals } from "../db/sql-database.js";
import {
  POSTGRES_LOGICAL_STATE_RECEIPT_FILE,
  buildPostgresLogicalSourceStateReceipt,
  canonicalPostgresLogicalStateJson,
  computePostgresLogicalStateInventory,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalSourceStateReceipt,
  type PostgresLogicalStateConnection,
  type PostgresLogicalStateInventory,
  type PostgresLogicalStateQueryResult,
} from "./postgres-logical-state.js";

export const POSTGRES_LOGICAL_BACKUP_SCHEMAS = Object.freeze([
  "pintpath_app",
  "pintpath_ops",
] as const);

export const POSTGRES_LOGICAL_BACKUP_ARCHIVE = "pintpath-postgres.dump";
export const POSTGRES_LOGICAL_BACKUP_MANIFEST = "manifest.json";
export const POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT = POSTGRES_LOGICAL_STATE_RECEIPT_FILE;

export type PostgresLogicalBackupFailureCode =
  | "invalid_arguments"
  | "unsafe_connection_file"
  | "unsafe_connection_url"
  | "unsafe_output_path"
  | "tool_unavailable_or_unsupported"
  | "source_unreachable_or_unsafe"
  | "source_contract_invalid"
  | "dump_failed"
  | "archive_invalid"
  | "archive_tampered"
  | "state_receipt_failed"
  | "manifest_failed"
  | "cleanup_failed";

export class PostgresLogicalBackupError extends Error {
  readonly code: PostgresLogicalBackupFailureCode;

  constructor(code: PostgresLogicalBackupFailureCode) {
    super(code);
    this.name = "PostgresLogicalBackupError";
    this.code = code;
  }
}

export interface ProcessInvocation {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (invocation: ProcessInvocation) => Promise<ProcessResult>;

export interface PostgresLogicalBackupToolIdentity {
  name: "pg_dump" | "pg_restore";
  version: string;
  major: number;
}

export interface PostgresLogicalBackupStateBinding {
  receiptFile: typeof POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT;
  receiptSha256: string;
  manifestBindingSha256: string;
  sourceDatabaseIdentitySha256: string;
  sourceUrlSha256: string;
  snapshotBindingSha256: string;
  migrationContractSha256: string;
  schemaMetadataSha256: string;
  targetDdlSha256: string;
  authoritativeTableCount: number;
  authoritativeRowCount: string;
  tableSetSha256: string;
  transformedDataSha256: string;
  stateTotalsSha256: string;
  keyRangesSha256: string;
  archivedControlTableCount: number;
  archivedControlRowCount: string;
  archivedControlTableSetSha256: string;
  archivedControlDataSha256: string;
  archivedControlKeyRangesSha256: string;
  overallStateSha256: string;
}

export interface PostgresLogicalBackupManifest {
  schemaVersion: 2;
  kind: "pintpath-postgres-logical-backup";
  createdAt: string;
  archive: {
    file: typeof POSTGRES_LOGICAL_BACKUP_ARCHIVE;
    format: "custom";
    bytes: number;
    sha256: string;
    schemas: readonly ["pintpath_app", "pintpath_ops"];
    aclStatementsIncluded: false;
    requiredRestoreOptions: readonly ["--no-owner", "--no-acl"];
  };
  tools: {
    pgDump: PostgresLogicalBackupToolIdentity;
    pgRestore: PostgresLogicalBackupToolIdentity;
  };
  validation: {
    method: "pg_restore --list";
    tocEntries: number;
    listedEntries: number;
    listingSha256: string;
    dumpedFromDatabaseVersion: string;
    dumpedByPgDumpVersion: string;
  };
  state: PostgresLogicalBackupStateBinding;
}

export interface PostgresLogicalBackupResult {
  schemaVersion: 2;
  ok: true;
  outputDirectory: string;
  archivePath: string;
  manifestPath: string;
  stateReceiptPath: string;
  archiveSha256: string;
  manifestSha256: string;
  stateReceiptSha256: string;
  authoritativeRowCount: string;
  overallStateSha256: string;
}

export interface CreatePostgresLogicalBackupOptions {
  connectionFile: string;
  outputDirectory: string;
  expectedSourceUrlSha256: string;
}

export interface PostgresLogicalBackupDependencies {
  env: Readonly<Record<string, string | undefined>>;
  getUid: () => number | null;
  now: () => Date;
  pgDumpCommand: string;
  pgRestoreCommand: string;
  runProcess: ProcessRunner;
  connect: (
    config: PostgresLogicalBackupConnectionConfig,
  ) => Promise<PostgresLogicalBackupConnection>;
  computeState: (
    connection: PostgresLogicalBackupConnection,
  ) => Promise<PostgresLogicalStateInventory>;
  /** Test seam only: also requires NODE_ENV=test and an exact loopback host. */
  allowInsecureLoopbackForTests: boolean;
}

interface StableFileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface SafeConnection {
  pgEnvironment: Readonly<Record<string, string>>;
  clientConfig: PostgresLogicalBackupConnectionConfig;
  urlSha256: string;
}

interface EphemeralPgpass {
  readonly directoryPath: string;
  readonly directoryIdentity: DirectoryIdentity;
  readonly filePath: string;
  readonly fileSnapshot: StableFileSnapshot;
  // Holding the original inode open prevents unlink-and-recreate from recycling
  // its inode number before the pathname identity check during cleanup.
  readonly guardHandle: fs.promises.FileHandle;
}

export interface PostgresLogicalBackupConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: false | { readonly rejectUnauthorized: boolean };
  readonly application_name: string;
  readonly connectionTimeoutMillis: number;
  readonly query_timeout: number;
}

export interface PostgresLogicalBackupConnection extends PostgresLogicalStateConnection {
  close(): Promise<void>;
}

interface TrustedConnectionFile {
  readonly value: string;
  readonly snapshot: StableFileSnapshot;
}

interface ArchiveListing {
  tocEntries: number;
  listedEntries: number;
  listingSha256: string;
  dumpedFromDatabaseVersion: string;
  dumpedByPgDumpVersion: string;
}

interface SourceIdentityRow extends QueryResultRow {
  readonly systemIdentifier: string;
  readonly databaseOid: string;
  readonly databaseName: string;
  readonly backupRoleName: string;
  readonly serverVersionNum: string;
  readonly roleName: string;
  readonly canLogin: boolean;
  readonly inheritsPrivileges: boolean;
  readonly connectionLimit: number;
  readonly validUntilIsNull: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly membershipCount: number;
  readonly childMembershipCount: number;
  readonly hasExactLogicalBackupMembership: boolean;
  readonly canSetLogicalBackup: boolean;
  readonly canSetMigrator: boolean;
  readonly canSetRuntime: boolean;
  readonly canSetSiblingLogicalBackup: boolean;
  readonly directDatabasePrivilegeCount: number;
  readonly hasDirectDatabaseConnect: boolean;
  readonly directFunctionPrivilegeCount: number;
  readonly hasDirectControlSystemExecute: boolean;
  readonly directPrivateObjectPrivilegeCount: number;
  readonly ownedPrivateObjectCount: number;
  readonly roleSettingCount: number;
  readonly sharedDependencyCount: number;
  readonly exactSharedDependencyCount: number;
  readonly transactionReadOnly: boolean;
  readonly inRecovery: boolean;
}

interface EffectiveRoleRow extends QueryResultRow {
  readonly effectiveRole: string;
  readonly sessionRole: string;
  readonly transactionIsolation: string;
  readonly transactionReadOnly: boolean;
  readonly canLogin: boolean;
  readonly inheritsPrivileges: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly membershipCount: number;
  readonly childMembershipCount: number;
  readonly exactSessionLoginChildCount: number;
  readonly directDatabasePrivilegeCount: number;
  readonly directFunctionPrivilegeCount: number;
  readonly roleSettingCount: number;
  readonly ownedCurrentDatabaseObjectCount: number;
  readonly sharedDependencyCount: number;
  readonly exactSharedDependencyCount: number;
  readonly privateSchemaCount: number;
  readonly directSchemaPrivilegeCount: number;
  readonly selectOnlySchemaCount: number;
  readonly privateRelationCount: number;
  readonly forceRlsRelationCount: number;
  readonly directRelationPrivilegeCount: number;
  readonly selectOnlyRelationCount: number;
  readonly privateSequenceCount: number;
  readonly selectOnlySequenceCount: number;
  readonly directColumnPrivilegeCount: number;
  readonly executablePrivateFunctionCount: number;
  readonly privatePolicyCount: number;
  readonly exactBasePolicyCount: number;
  readonly publicPrivatePolicyCount: number;
  readonly exactLogicalBackupSelectPolicyCount: number;
  readonly unsafePublicPrivatePolicyCount: number;
  readonly unsafeReservedPolicyNameCount: number;
  readonly directScopedPolicyCount: number;
}

interface SnapshotRow extends QueryResultRow {
  readonly snapshotIdentifier: string;
}

const MAX_CONNECTION_FILE_BYTES = 16 * 1024;
const VERSION_OUTPUT_LIMIT = 4 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
const DUMP_TIMEOUT_MS = 60 * 60 * 1_000;
const RESTORE_LIST_TIMEOUT_MS = 5 * 60 * 1_000;
const DUMP_OUTPUT_LIMIT = 512 * 1024;
const RESTORE_LIST_OUTPUT_LIMIT = 32 * 1024 * 1024;
const STATE_RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){0,3}(?:[-+._a-zA-Z0-9 ()~:]{0,96})$/;
const SNAPSHOT_IDENTIFIER_PATTERN = /^[a-fA-F0-9-]{1,128}$/;
const LOGICAL_BACKUP_ROLE_PREFIX = "pintpath_logical_backup_d";
const DATABASE_OID_PATTERN = /^[1-9][0-9]{0,9}$/;
const LOGICAL_BACKUP_VERSION_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAX_POSTGRES_OID = 4_294_967_295n;
const EXACT_LOGICAL_BACKUP_POLICY_EXPRESSION = `(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid
   FROM pg_database database
  WHERE (database.datname = current_database()))))`;

function scopedLogicalBackupRole(databaseOid: string): string | null {
  if (!DATABASE_OID_PATTERN.test(databaseOid)) return null;
  try {
    if (BigInt(databaseOid) > MAX_POSTGRES_OID) return null;
  } catch {
    return null;
  }
  return `${LOGICAL_BACKUP_ROLE_PREFIX}${databaseOid}`;
}

function isExactVersionedLogicalBackupLogin(
  roleName: string,
  backupRoleName: string,
): boolean {
  const prefix = `${backupRoleName}_v`;
  return roleName.startsWith(prefix)
    && LOGICAL_BACKUP_VERSION_PATTERN.test(roleName.slice(prefix.length));
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

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maximumBytes: number,
): number {
  const nextBytes = currentBytes + chunk.byteLength;
  if (nextBytes > maximumBytes) throw new Error("process_output_limit_exceeded");
  chunks.push(chunk);
  return nextBytes;
}

export const runPostgresBackupProcess: ProcessRunner = async (invocation) => {
  if (
    !invocation.command ||
    invocation.command.includes("\0") ||
    invocation.args.some((argument) => argument.includes("\0")) ||
    Object.entries(invocation.env).some(([key, value]) => (
      !key || key.includes("\0") || value.includes("\0")
    ))
  ) {
    throw new Error("invalid_process_invocation");
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      env: { ...invocation.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      reject(error);
    };
    const timeout = setTimeout(
      () => fail(new Error("process_timeout")),
      invocation.timeoutMs,
    );
    timeout.unref();

    child.stdout.on("data", (value: Buffer | string) => {
      if (settled) return;
      try {
        stdoutBytes = appendBounded(
          stdout,
          Buffer.isBuffer(value) ? value : Buffer.from(value),
          stdoutBytes,
          invocation.maxStdoutBytes,
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error("process_output_limit_exceeded"));
      }
    });
    child.stderr.on("data", (value: Buffer | string) => {
      if (settled) return;
      try {
        stderrBytes = appendBounded(
          stderr,
          Buffer.isBuffer(value) ? value : Buffer.from(value),
          stderrBytes,
          invocation.maxStderrBytes,
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error("process_output_limit_exceeded"));
      }
    });
    child.once("error", (error) => fail(error));
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal || exitCode === null) {
        reject(new Error("process_terminated_without_exit_code"));
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
      });
    });
  });
};

class DirectBackupConnection implements PostgresLogicalBackupConnection {
  private constructor(
    private readonly pool: Pool,
    private readonly client: PoolClient,
  ) {}

  static async connect(
    config: PostgresLogicalBackupConnectionConfig,
  ): Promise<DirectBackupConnection> {
    const poolConfig: PoolConfig = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      application_name: config.application_name,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      query_timeout: config.query_timeout,
      max: 1,
      idleTimeoutMillis: 1_000,
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
    };
    const pool = new Pool(poolConfig);
    pool.on("error", () => undefined);
    try {
      const client = await pool.connect();
      return new DirectBackupConnection(pool, client);
    } catch {
      await pool.end().catch(() => undefined);
      throw new PostgresLogicalBackupError("source_unreachable_or_unsafe");
    }
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresLogicalStateQueryResult<Row>> {
    const result = await this.client.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async close(): Promise<void> {
    this.client.release();
    await this.pool.end();
  }
}

const DEFAULT_DEPENDENCIES: PostgresLogicalBackupDependencies = {
  env: process.env,
  getUid: () => process.getuid?.() ?? null,
  now: () => new Date(),
  pgDumpCommand: "pg_dump",
  pgRestoreCommand: "pg_restore",
  runProcess: runPostgresBackupProcess,
  connect: DirectBackupConnection.connect,
  computeState: computePostgresLogicalStateInventory,
  allowInsecureLoopbackForTests: false,
};

function sameFileIdentity(
  expected: Pick<fs.Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">,
  actual: fs.Stats,
): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs;
}

async function readTrustedConnectionFile(
  filePath: string,
  expectedUid: number,
): Promise<TrustedConnectionFile> {
  let before: fs.Stats;
  try {
    before = await fs.promises.lstat(filePath);
  } catch {
    throw new PostgresLogicalBackupError("unsafe_connection_file");
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || before.uid !== expectedUid
    || (before.mode & 0o7777) !== 0o600
    || before.size < 1
    || before.size > MAX_CONNECTION_FILE_BYTES
  ) {
    throw new PostgresLogicalBackupError("unsafe_connection_file");
  }

  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.uid !== expectedUid
      || (opened.mode & 0o7777) !== 0o600
      || !sameFileIdentity(before, opened)
    ) {
      throw new PostgresLogicalBackupError("unsafe_connection_file");
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new PostgresLogicalBackupError("unsafe_connection_file");
      }
      offset += read.bytesRead;
    }
    const afterDescriptor = await handle.stat();
    const afterPath = await fs.promises.lstat(filePath);
    if (
      afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || afterPath.nlink !== 1
      || afterPath.uid !== expectedUid
      || (afterPath.mode & 0o7777) !== 0o600
      || !sameFileIdentity(before, afterDescriptor)
      || !sameFileIdentity(before, afterPath)
    ) {
      throw new PostgresLogicalBackupError("unsafe_connection_file");
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new PostgresLogicalBackupError("unsafe_connection_file");
    }
    const value = decoded.trim();
    if (!value || value.includes("\0") || /[\r\n]/.test(value)) {
      throw new PostgresLogicalBackupError("unsafe_connection_file");
    }
    return {
      value,
      snapshot: {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      },
    };
  } catch (error) {
    if (error instanceof PostgresLogicalBackupError) throw error;
    throw new PostgresLogicalBackupError("unsafe_connection_file");
  } finally {
    await handle?.close().catch(() => undefined);
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

function parseSafeConnectionUrl(
  value: string,
  dependencies: PostgresLogicalBackupDependencies,
): SafeConnection {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PostgresLogicalBackupError("unsafe_connection_url");
  }

  const queryEntries = [...parsed.searchParams.entries()];
  const sslModeEntries = queryEntries.filter(([name]) => name.toLowerCase() === "sslmode");
  const hasUnsupportedQuery = queryEntries.some(([name]) => name !== "sslmode");
  const sslMode = sslModeEntries[0]?.[1].toLowerCase() ?? "";
  const hostname = parsed.hostname.toLowerCase();
  const portText = parsed.port || "5432";
  const port = Number(portText);
  const databasePath = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : "";
  const database = decodeUrlComponent(databasePath);
  const username = decodeUrlComponent(parsed.username);
  const password = decodeUrlComponent(parsed.password);
  const poolerHostname = hostname.includes("pooler")
    || hostname.includes("pgbouncer")
    || hostname.includes("pgpool");
  const normalizedHost = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(normalizedHost);
  const insecureTestLoopback = dependencies.allowInsecureLoopbackForTests
    && dependencies.env.NODE_ENV === "test"
    && loopback
    && sslMode === "disable";

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !hostname
    || poolerHostname
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || port === 6_543
    || !database
    || database.includes("/")
    || !username
    || !password
    || normalizedHost.includes("*")
    || database.includes("*")
    || username.includes("*")
    || parsed.hash
    || sslModeEntries.length !== 1
    || hasUnsupportedQuery
    || (!insecureTestLoopback && sslMode !== "verify-full")
  ) {
    throw new PostgresLogicalBackupError("unsafe_connection_url");
  }

  return {
    pgEnvironment: Object.freeze({
      PGHOST: normalizedHost,
      PGPORT: String(port),
      PGDATABASE: database,
      PGUSER: username,
      PGSSLMODE: sslMode,
      ...(insecureTestLoopback ? {} : { PGSSLROOTCERT: "system" }),
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-backup",
    }),
    clientConfig: {
      host: normalizedHost,
      port,
      database,
      user: username,
      password,
      ssl: insecureTestLoopback ? false : { rejectUnauthorized: true },
      application_name: "pintpath-logical-backup-state",
      connectionTimeoutMillis: 15_000,
      query_timeout: 120_000,
    },
    urlSha256: crypto.createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

async function assertConnectionFileUnchanged(
  filePath: string,
  expectedUid: number,
  expected: TrustedConnectionFile,
): Promise<void> {
  const actual = await readTrustedConnectionFile(filePath, expectedUid).catch(() => null);
  if (
    !actual
    || actual.value !== expected.value
    || !sameSnapshot(actual.snapshot, expected.snapshot)
  ) throw new PostgresLogicalBackupError("unsafe_connection_file");
}

function parseToolIdentity(
  name: PostgresLogicalBackupToolIdentity["name"],
  result: ProcessResult,
): PostgresLogicalBackupToolIdentity {
  if (result.exitCode !== 0 || result.stderr.trim() || result.stdout.length > VERSION_OUTPUT_LIMIT) {
    throw new PostgresLogicalBackupError("tool_unavailable_or_unsupported");
  }
  const line = result.stdout.trim();
  const prefix = `${name} (PostgreSQL) `;
  if (!line.startsWith(prefix) || line.includes("\n") || line.includes("\r")) {
    throw new PostgresLogicalBackupError("tool_unavailable_or_unsupported");
  }
  const version = line.slice(prefix.length).trim();
  if (!SAFE_VERSION_PATTERN.test(version)) {
    throw new PostgresLogicalBackupError("tool_unavailable_or_unsupported");
  }
  const major = Number.parseInt(version, 10);
  if (!Number.isInteger(major) || major !== 17) {
    throw new PostgresLogicalBackupError("tool_unavailable_or_unsupported");
  }
  return { name, version, major };
}

async function identifyTool(
  name: PostgresLogicalBackupToolIdentity["name"],
  command: string,
  processEnvironment: Readonly<Record<string, string>>,
  runProcess: ProcessRunner,
): Promise<PostgresLogicalBackupToolIdentity> {
  let result: ProcessResult;
  try {
    result = await runProcess({
      command,
      args: ["--version"],
      env: processEnvironment,
      timeoutMs: TOOL_TIMEOUT_MS,
      maxStdoutBytes: VERSION_OUTPUT_LIMIT,
      maxStderrBytes: VERSION_OUTPUT_LIMIT,
    });
  } catch {
    throw new PostgresLogicalBackupError("tool_unavailable_or_unsupported");
  }
  return parseToolIdentity(name, result);
}

async function prepareFreshOutputDirectory(
  requestedPath: string,
  expectedUid: number,
): Promise<{ outputDirectory: string; identity: DirectoryIdentity }> {
  const resolved = path.resolve(requestedPath);
  if (resolved === path.parse(resolved).root || path.basename(resolved) === ".") {
    throw new PostgresLogicalBackupError("unsafe_output_path");
  }
  let canonicalParent: string;
  try {
    canonicalParent = await fs.promises.realpath(path.dirname(resolved));
  } catch {
    throw new PostgresLogicalBackupError("unsafe_output_path");
  }
  const outputDirectory = path.join(canonicalParent, path.basename(resolved));
  let created = false;
  try {
    await fs.promises.mkdir(outputDirectory, { mode: 0o700, recursive: false });
    created = true;
    const stat = await fs.promises.lstat(outputDirectory);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || stat.uid !== expectedUid
      || (stat.mode & 0o7777) !== 0o700
    ) {
      throw new Error("unsafe_created_directory");
    }
    return { outputDirectory, identity: { dev: stat.dev, ino: stat.ino } };
  } catch {
    if (created) {
      const createdStat = await fs.promises.lstat(outputDirectory).catch(() => null);
      if (createdStat?.isDirectory() && !createdStat.isSymbolicLink()) {
        try {
          await fs.promises.rm(outputDirectory, { recursive: true, force: false });
        } catch {
          throw new PostgresLogicalBackupError("cleanup_failed");
        }
      } else if (createdStat) {
        throw new PostgresLogicalBackupError("cleanup_failed");
      }
    }
    throw new PostgresLogicalBackupError("unsafe_output_path");
  }
}

async function assertDirectoryIdentity(
  directoryPath: string,
  identity: DirectoryIdentity,
  expectedUid: number,
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(directoryPath);
  } catch {
    throw new PostgresLogicalBackupError("archive_tampered");
  }
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.dev !== identity.dev
    || stat.ino !== identity.ino
    || stat.uid !== expectedUid
    || (stat.mode & 0o7777) !== 0o700
  ) {
    throw new PostgresLogicalBackupError("archive_tampered");
  }
}

async function createExclusiveFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function snapshotTrustedFile(
  filePath: string,
  expectedUid: number,
  requireNonEmpty: boolean,
): Promise<StableFileSnapshot> {
  const before = await fs.promises.lstat(filePath);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || before.uid !== expectedUid
    || (before.mode & 0o7777) !== 0o600
    || (requireNonEmpty && before.size < 1)
  ) {
    throw new PostgresLogicalBackupError("archive_invalid");
  }
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const hash = crypto.createHash("sha256");
  try {
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened)) {
      throw new PostgresLogicalBackupError("archive_tampered");
    }
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, opened.size - offset),
        offset,
      );
      if (read.bytesRead === 0) {
        throw new PostgresLogicalBackupError("archive_tampered");
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const afterDescriptor = await handle.stat();
    const afterPath = await fs.promises.lstat(filePath);
    if (
      afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || afterPath.nlink !== 1
      || afterPath.uid !== expectedUid
      || (afterPath.mode & 0o7777) !== 0o600
      || !sameFileIdentity(before, afterDescriptor)
      || !sameFileIdentity(before, afterPath)
    ) {
      throw new PostgresLogicalBackupError("archive_tampered");
    }
  } finally {
    await handle.close();
  }
  return {
    dev: before.dev,
    ino: before.ino,
    size: before.size,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
    sha256: hash.digest("hex"),
  };
}

function sameSnapshot(first: StableFileSnapshot, second: StableFileSnapshot): boolean {
  return first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs
    && first.sha256 === second.sha256;
}

function escapePgpassField(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function pgpassRecord(connection: SafeConnection): Buffer {
  return Buffer.from(`${[
    connection.clientConfig.host,
    String(connection.clientConfig.port),
    connection.clientConfig.database,
    connection.clientConfig.user,
    connection.clientConfig.password,
  ].map(escapePgpassField).join(":")}\n`, "utf8");
}

async function ephemeralPgpassIsExact(
  pgpass: EphemeralPgpass,
  expectedUid: number,
): Promise<boolean> {
  try {
    const directory = await fs.promises.lstat(pgpass.directoryPath);
    if (
      directory.isSymbolicLink()
      || !directory.isDirectory()
      || directory.uid !== expectedUid
      || (directory.mode & 0o7777) !== 0o700
      || directory.dev !== pgpass.directoryIdentity.dev
      || directory.ino !== pgpass.directoryIdentity.ino
    ) return false;
    const guardedFile = await pgpass.guardHandle.stat();
    if (
      !guardedFile.isFile()
      || guardedFile.nlink !== 1
      || guardedFile.uid !== expectedUid
      || (guardedFile.mode & 0o7777) !== 0o600
      || !sameFileIdentity(pgpass.fileSnapshot, guardedFile)
    ) return false;
    const entries = await fs.promises.readdir(pgpass.directoryPath);
    if (entries.length !== 1 || entries[0] !== path.basename(pgpass.filePath)) return false;
    const file = await snapshotTrustedFile(pgpass.filePath, expectedUid, true);
    return sameSnapshot(file, pgpass.fileSnapshot);
  } catch {
    return false;
  }
}

async function cleanupEphemeralPgpassPath(
  pgpass: EphemeralPgpass,
  expectedUid: number,
): Promise<boolean> {
  let exact = true;
  try {
    const directoryBefore = await fs.promises.lstat(pgpass.directoryPath);
    if (
      directoryBefore.isSymbolicLink()
      || !directoryBefore.isDirectory()
      || directoryBefore.uid !== expectedUid
      || directoryBefore.dev !== pgpass.directoryIdentity.dev
      || directoryBefore.ino !== pgpass.directoryIdentity.ino
    ) return false;
    if ((directoryBefore.mode & 0o7777) !== 0o700) exact = false;
    const fileBefore = await fs.promises.lstat(pgpass.filePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (fileBefore) {
      if (
        fileBefore.isSymbolicLink()
        || !fileBefore.isFile()
        || fileBefore.uid !== expectedUid
        || fileBefore.dev !== pgpass.fileSnapshot.dev
        || fileBefore.ino !== pgpass.fileSnapshot.ino
      ) return false;
      if (fileBefore.nlink !== 1) exact = false;
      if (!await ephemeralPgpassIsExact(pgpass, expectedUid)) exact = false;
      await fs.promises.unlink(pgpass.filePath);
    } else {
      exact = false;
    }
    const remainingFile = await fs.promises.lstat(pgpass.filePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (remainingFile) return false;
    const directory = await fs.promises.lstat(pgpass.directoryPath);
    if (
      directory.isSymbolicLink()
      || !directory.isDirectory()
      || directory.uid !== expectedUid
      || directory.dev !== pgpass.directoryIdentity.dev
      || directory.ino !== pgpass.directoryIdentity.ino
    ) return false;
    if ((directory.mode & 0o7777) !== 0o700) exact = false;
    if ((await fs.promises.readdir(pgpass.directoryPath)).length !== 0) return false;
    await fs.promises.rmdir(pgpass.directoryPath);
    const remainingDirectory = await fs.promises.lstat(pgpass.directoryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    return remainingDirectory === null && exact;
  } catch {
    return false;
  }
}

async function cleanupEphemeralPgpass(
  pgpass: EphemeralPgpass,
  expectedUid: number,
): Promise<boolean> {
  const pathCleanupSucceeded = await cleanupEphemeralPgpassPath(pgpass, expectedUid);
  let descriptorCleanupSucceeded = true;
  try {
    await pgpass.guardHandle.close();
  } catch {
    descriptorCleanupSucceeded = false;
  }
  return pathCleanupSucceeded && descriptorCleanupSucceeded;
}

async function cleanupPartialEphemeralPgpass(
  directoryPath: string,
  directoryIdentity: DirectoryIdentity,
  filePath: string | null,
  fileIdentity: FileIdentity | null,
  expectedUid: number,
): Promise<boolean> {
  let exact = true;
  try {
    const directory = await fs.promises.lstat(directoryPath);
    if (
      directory.isSymbolicLink()
      || !directory.isDirectory()
      || directory.uid !== expectedUid
      || directory.dev !== directoryIdentity.dev
      || directory.ino !== directoryIdentity.ino
    ) return false;
    if (filePath && fileIdentity) {
      const file = await fs.promises.lstat(filePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (file) {
        if (
          file.isSymbolicLink()
          || !file.isFile()
          || file.uid !== expectedUid
          || file.dev !== fileIdentity.dev
          || file.ino !== fileIdentity.ino
        ) return false;
        if (file.nlink !== 1) exact = false;
        await fs.promises.unlink(filePath);
      } else {
        exact = false;
      }
    }
    if ((await fs.promises.readdir(directoryPath)).length !== 0) return false;
    await fs.promises.rmdir(directoryPath);
    return exact;
  } catch {
    return false;
  }
}

async function createEphemeralPgpass(
  connection: SafeConnection,
  expectedUid: number,
): Promise<EphemeralPgpass> {
  let directoryPath: string | null = null;
  let directoryIdentity: DirectoryIdentity | null = null;
  let filePath: string | null = null;
  let fileIdentity: FileIdentity | null = null;
  let fileSnapshot: StableFileSnapshot | null = null;
  let record: Buffer | null = null;
  let handle: fs.promises.FileHandle | null = null;
  try {
    const configuredTempRoot = os.tmpdir();
    if (!path.isAbsolute(configuredTempRoot) || configuredTempRoot.includes("\0")) {
      throw new Error("unsafe_temporary_root");
    }
    const canonicalTempRoot = await fs.promises.realpath(configuredTempRoot);
    const tempRoot = await fs.promises.lstat(canonicalTempRoot);
    if (tempRoot.isSymbolicLink() || !tempRoot.isDirectory()) {
      throw new Error("unsafe_temporary_root");
    }
    directoryPath = await fs.promises.mkdtemp(
      path.join(canonicalTempRoot, "pintpath-logical-backup-pgpass-"),
    );
    if (path.dirname(directoryPath) !== canonicalTempRoot) {
      throw new Error("unsafe_temporary_directory");
    }
    const createdDirectory = await fs.promises.lstat(directoryPath);
    if (
      createdDirectory.isSymbolicLink()
      || !createdDirectory.isDirectory()
      || createdDirectory.uid !== expectedUid
    ) throw new Error("unsafe_temporary_directory");
    directoryIdentity = { dev: createdDirectory.dev, ino: createdDirectory.ino };
    await fs.promises.chmod(directoryPath, 0o700);
    const directory = await fs.promises.lstat(directoryPath);
    if (
      directory.isSymbolicLink()
      || !directory.isDirectory()
      || directory.uid !== expectedUid
      || (directory.mode & 0o7777) !== 0o700
      || directory.dev !== directoryIdentity.dev
      || directory.ino !== directoryIdentity.ino
    ) throw new Error("unsafe_temporary_directory");

    filePath = path.join(directoryPath, "pgpass");
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const created = await handle.stat();
    const createdPath = await fs.promises.lstat(filePath);
    if (
      !created.isFile()
      || created.nlink !== 1
      || created.uid !== expectedUid
      || !sameFileIdentity(created, createdPath)
    ) throw new Error("unsafe_pgpass_file");
    fileIdentity = { dev: created.dev, ino: created.ino };
    await handle.chmod(0o600);
    record = pgpassRecord(connection);
    await handle.writeFile(record);
    await handle.sync();
    const opened = await handle.stat();
    const linked = await fs.promises.lstat(filePath);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.uid !== expectedUid
      || (opened.mode & 0o7777) !== 0o600
      || !sameFileIdentity(opened, linked)
      || opened.size !== record.byteLength
    ) throw new Error("unsafe_pgpass_file");
    fileSnapshot = {
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      sha256: crypto.createHash("sha256").update(record).digest("hex"),
    };
    record.fill(0);
    record = null;
    const pgpass: EphemeralPgpass = {
      directoryPath,
      directoryIdentity,
      filePath,
      fileSnapshot,
      guardHandle: handle,
    };
    if (!await ephemeralPgpassIsExact(pgpass, expectedUid)) {
      throw new Error("unsafe_pgpass_snapshot");
    }
    handle = null;
    return pgpass;
  } catch {
    record?.fill(0);
    if (directoryPath && directoryIdentity && filePath && fileSnapshot && handle) {
      const candidate = {
        directoryPath,
        directoryIdentity,
        filePath,
        fileSnapshot,
        guardHandle: handle,
      };
      handle = null;
      await cleanupEphemeralPgpass(candidate, expectedUid);
    } else {
      if (!fileIdentity && handle) {
        const opened = await handle.stat().catch(() => null);
        if (opened?.isFile() && opened.nlink === 1 && opened.uid === expectedUid) {
          fileIdentity = { dev: opened.dev, ino: opened.ino };
        }
      }
      await handle?.close().catch(() => undefined);
      if (directoryPath && directoryIdentity) {
        await cleanupPartialEphemeralPgpass(
          directoryPath,
          directoryIdentity,
          filePath,
          fileIdentity,
          expectedUid,
        );
      }
    }
    throw new PostgresLogicalBackupError("cleanup_failed");
  }
}

function safeArchiveVersion(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized && SAFE_VERSION_PATTERN.test(normalized) ? normalized : null;
}

function parseArchiveListing(stdout: string): ArchiveListing {
  const tocMatch = stdout.match(/^;\s+TOC Entries:\s+(\d+)\s*$/m);
  const databaseVersionMatch = stdout.match(/^;\s+Dumped from database version:\s+(.+)\s*$/m);
  const dumpVersionMatch = stdout.match(/^;\s+Dumped by pg_dump version:\s+(.+)\s*$/m);
  const tocEntries = Number(tocMatch?.[1] ?? 0);
  const dumpedFromDatabaseVersion = safeArchiveVersion(databaseVersionMatch?.[1]);
  const dumpedByPgDumpVersion = safeArchiveVersion(dumpVersionMatch?.[1]);
  const listedLines = stdout.split(/\r?\n/).filter((line) => (
    line.trim().length > 0 && !line.startsWith(";")
  ));
  const hasAppSchema = /\bSCHEMA\s+-\s+pintpath_app(?:\s|$)/m.test(stdout);
  const hasOpsSchema = /\bSCHEMA\s+-\s+pintpath_ops(?:\s|$)/m.test(stdout);
  const hasAcl = listedLines.some((line) => /\s(?:ACL|DEFAULT ACL)\s/.test(line));

  if (
    !Number.isSafeInteger(tocEntries)
    || tocEntries < 1
    || listedLines.length < 1
    || !dumpedFromDatabaseVersion
    || !dumpedByPgDumpVersion
    || !hasAppSchema
    || !hasOpsSchema
    || hasAcl
  ) {
    throw new PostgresLogicalBackupError("archive_invalid");
  }
  return {
    tocEntries,
    listedEntries: listedLines.length,
    listingSha256: crypto.createHash("sha256").update(stdout, "utf8").digest("hex"),
    dumpedFromDatabaseVersion,
    dumpedByPgDumpVersion,
  };
}

export function canonicalPostgresBackupJson(value: unknown): string {
  return canonicalPostgresLogicalStateJson(value);
}

async function writeCanonicalManifest(
  manifestPath: string,
  manifest: PostgresLogicalBackupManifest,
): Promise<void> {
  const handle = await fs.promises.open(manifestPath, "wx", 0o600);
  try {
    await handle.writeFile(canonicalPostgresBackupJson(manifest), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeCanonicalStateReceipt(
  receiptPath: string,
  receipt: PostgresLogicalSourceStateReceipt,
): Promise<void> {
  const bytes = Buffer.from(canonicalPostgresBackupJson(receipt), "utf8");
  if (bytes.length < 1 || bytes.length > STATE_RECEIPT_MAX_BYTES) {
    throw new PostgresLogicalBackupError("state_receipt_failed");
  }
  const handle = await fs.promises.open(receiptPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function stateBindingWithoutReceipt(
  state: PostgresLogicalBackupStateBinding,
): Omit<PostgresLogicalBackupStateBinding,
  "receiptFile" | "receiptSha256" | "manifestBindingSha256"> {
  return {
    sourceDatabaseIdentitySha256: state.sourceDatabaseIdentitySha256,
    sourceUrlSha256: state.sourceUrlSha256,
    snapshotBindingSha256: state.snapshotBindingSha256,
    migrationContractSha256: state.migrationContractSha256,
    schemaMetadataSha256: state.schemaMetadataSha256,
    targetDdlSha256: state.targetDdlSha256,
    authoritativeTableCount: state.authoritativeTableCount,
    authoritativeRowCount: state.authoritativeRowCount,
    tableSetSha256: state.tableSetSha256,
    transformedDataSha256: state.transformedDataSha256,
    stateTotalsSha256: state.stateTotalsSha256,
    keyRangesSha256: state.keyRangesSha256,
    archivedControlTableCount: state.archivedControlTableCount,
    archivedControlRowCount: state.archivedControlRowCount,
    archivedControlTableSetSha256: state.archivedControlTableSetSha256,
    archivedControlDataSha256: state.archivedControlDataSha256,
    archivedControlKeyRangesSha256: state.archivedControlKeyRangesSha256,
    overallStateSha256: state.overallStateSha256,
  };
}

export function postgresLogicalBackupManifestBindingSha256(
  manifest: Pick<PostgresLogicalBackupManifest,
  "schemaVersion" | "kind" | "createdAt" | "archive" | "tools" | "validation" | "state">,
): string {
  return sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-backup-manifest-binding",
    version: 1,
    schemaVersion: manifest.schemaVersion,
    backupKind: manifest.kind,
    createdAt: manifest.createdAt,
    archive: manifest.archive,
    tools: manifest.tools,
    validation: manifest.validation,
    state: stateBindingWithoutReceipt(manifest.state),
  });
}

function sourceIdentitySha256(row: SourceIdentityRow): string {
  return sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-source-database",
    version: 1,
    systemIdentifier: row.systemIdentifier,
    databaseOid: row.databaseOid,
    databaseName: row.databaseName,
    serverVersionNum: row.serverVersionNum,
  });
}

async function inspectSafeSourceIdentity(
  connection: PostgresLogicalBackupConnection,
): Promise<{ sourceDatabaseIdentitySha256: string; backupRoleName: string }> {
  let result: PostgresLogicalStateQueryResult<SourceIdentityRow>;
  try {
    result = await connection.query<SourceIdentityRow>(`/* pintpath:logical-backup:source-identity */
      SELECT
        control.system_identifier::text AS "systemIdentifier",
        database.oid::text AS "databaseOid",
        current_database() AS "databaseName",
        ('pintpath_logical_backup_d' || database.oid::text) AS "backupRoleName",
        current_setting('server_version_num') AS "serverVersionNum",
        login.rolname AS "roleName",
        login.rolcanlogin AS "canLogin",
        login.rolinherit AS "inheritsPrivileges",
        login.rolconnlimit AS "connectionLimit",
        (login.rolvaliduntil IS NULL) AS "validUntilIsNull",
        login.rolsuper AS "superuser",
        login.rolcreatedb AS "createDatabase",
        login.rolcreaterole AS "createRole",
        login.rolreplication AS "replication",
        login.rolbypassrls AS "bypassRls",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.member = login.oid
        ) AS "membershipCount",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid = login.oid
        ) AS "childMembershipCount",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
          WHERE membership.member = login.oid
            AND granted_role.rolname = ('pintpath_logical_backup_d' || database.oid::text)
            AND NOT membership.admin_option
            AND NOT membership.inherit_option
            AND membership.set_option
        ) AS "hasExactLogicalBackupMembership",
        pg_has_role(
          login.oid,
          ('pintpath_logical_backup_d' || database.oid::text),
          'SET'
        ) AS "canSetLogicalBackup",
        pg_has_role(session_user, 'pintpath_migrator', 'SET') AS "canSetMigrator",
        pg_has_role(session_user, 'pintpath_runtime', 'SET') AS "canSetRuntime",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_roles AS sibling_role
          WHERE sibling_role.rolname ~ '^pintpath_logical_backup_d[1-9][0-9]{0,9}$'
            AND sibling_role.rolname <> ('pintpath_logical_backup_d' || database.oid::text)
            AND pg_catalog.pg_has_role(login.oid, sibling_role.oid, 'SET')
        ) AS "canSetSiblingLogicalBackup",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_database AS granted_database
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            granted_database.datacl,
            pg_catalog.acldefault('d', granted_database.datdba)
          )) AS privilege
          WHERE privilege.grantee = login.oid
        ) AS "directDatabasePrivilegeCount",
        EXISTS (
          SELECT 1
          FROM LATERAL pg_catalog.aclexplode(COALESCE(
            database.datacl,
            pg_catalog.acldefault('d', database.datdba)
          )) AS privilege
          WHERE privilege.grantee = login.oid
            AND privilege.privilege_type = 'CONNECT'
            AND NOT privilege.is_grantable
        ) AS "hasDirectDatabaseConnect",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_proc AS routine
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )) AS privilege
          WHERE privilege.grantee = login.oid
        ) AS "directFunctionPrivilegeCount",
        EXISTS (
          SELECT 1
          FROM LATERAL pg_catalog.aclexplode(COALESCE(
            control_routine.proacl,
            pg_catalog.acldefault('f', control_routine.proowner)
          )) AS privilege
          WHERE privilege.grantee = login.oid
            AND privilege.privilege_type = 'EXECUTE'
            AND NOT privilege.is_grantable
        ) AS "hasDirectControlSystemExecute",
        (
          SELECT count(*)::integer
          FROM (
            SELECT 1
            FROM pg_catalog.pg_namespace AS namespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
              namespace.nspacl,
              pg_catalog.acldefault('n', namespace.nspowner)
            )) AS privilege
            WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
              AND privilege.grantee = login.oid
            UNION ALL
            SELECT 1
            FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
              relation.relacl,
              pg_catalog.acldefault(
                (CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
                relation.relowner
              )
            )) AS privilege
            WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
              AND privilege.grantee = login.oid
            UNION ALL
            SELECT 1
            FROM pg_catalog.pg_attribute AS attribute
            JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
            WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND attribute.attacl IS NOT NULL
              AND privilege.grantee = login.oid
          ) AS direct_private_privilege
        ) AS "directPrivateObjectPrivilegeCount",
        (
          (SELECT count(*) FROM pg_catalog.pg_namespace AS namespace
           WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
             AND namespace.nspowner = login.oid)
          + (SELECT count(*) FROM pg_catalog.pg_class AS relation
             JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
               AND relation.relowner = login.oid)
          + (SELECT count(*) FROM pg_catalog.pg_proc AS routine
             JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
             WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
               AND routine.proowner = login.oid)
        )::integer AS "ownedPrivateObjectCount",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_db_role_setting AS setting
          WHERE setting.setrole = login.oid
        ) AS "roleSettingCount",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_shdepend AS dependency
          WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            AND dependency.refobjid = login.oid
        ) AS "sharedDependencyCount",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_shdepend AS dependency
          WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            AND dependency.refobjid = login.oid
            AND dependency.objsubid = 0
            AND dependency.deptype = 'a'
            AND (
              (
                dependency.dbid = 0::oid
                AND dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
                AND dependency.objid = database.oid
              )
              OR (
                dependency.dbid = database.oid
                AND dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                AND dependency.objid = control_routine.oid
              )
            )
        ) AS "exactSharedDependencyCount",
        current_setting('transaction_read_only')::boolean AS "transactionReadOnly",
        pg_is_in_recovery() AS "inRecovery"
      FROM pg_catalog.pg_database AS database
      JOIN pg_catalog.pg_roles AS login ON login.rolname = session_user
      JOIN pg_catalog.pg_proc AS control_routine
        ON control_routine.oid = 'pg_catalog.pg_control_system()'::pg_catalog.regprocedure
      CROSS JOIN pg_catalog.pg_control_system() AS control
      WHERE database.datname = current_database()`);
  } catch {
    throw new PostgresLogicalBackupError("source_unreachable_or_unsafe");
  }
  const row = result.rows[0];
  const expectedBackupRoleName = row
    ? scopedLogicalBackupRole(row.databaseOid)
    : null;
  if (
    result.rows.length !== 1
    || !row
    || !/^\d+$/.test(row.systemIdentifier)
    || !/^\d+$/.test(row.databaseOid)
    || !row.databaseName
    || !/^17\d{4}$/.test(row.serverVersionNum)
    || !expectedBackupRoleName
    || row.backupRoleName !== expectedBackupRoleName
    || !isExactVersionedLogicalBackupLogin(row.roleName, expectedBackupRoleName)
    || row.canLogin !== true
    || row.inheritsPrivileges !== false
    || row.connectionLimit !== 2
    || row.validUntilIsNull !== true
    || row.superuser !== false
    || row.createDatabase !== false
    || row.createRole !== false
    || row.replication !== false
    || row.bypassRls !== false
    || row.membershipCount !== 1
    || row.childMembershipCount !== 0
    || row.hasExactLogicalBackupMembership !== true
    || row.canSetLogicalBackup !== true
    || row.canSetMigrator !== false
    || row.canSetRuntime !== false
    || row.canSetSiblingLogicalBackup !== false
    || row.directDatabasePrivilegeCount !== 1
    || row.hasDirectDatabaseConnect !== true
    || row.directFunctionPrivilegeCount !== 1
    || row.hasDirectControlSystemExecute !== true
    || row.directPrivateObjectPrivilegeCount !== 0
    || row.ownedPrivateObjectCount !== 0
    || row.roleSettingCount !== 0
    || row.sharedDependencyCount !== 2
    || row.exactSharedDependencyCount !== row.sharedDependencyCount
    || row.transactionReadOnly !== false
    || row.inRecovery !== false
  ) throw new PostgresLogicalBackupError("source_unreachable_or_unsafe");
  return {
    sourceDatabaseIdentitySha256: sourceIdentitySha256(row),
    backupRoleName: expectedBackupRoleName,
  };
}

async function beginExportedSourceSnapshot(
  connection: PostgresLogicalBackupConnection,
  sourceDatabaseIdentitySha256: string,
  sourceUrlSha256: string,
  backupRoleName: string,
): Promise<{ snapshotIdentifier: string; snapshotBindingSha256: string }> {
  try {
    await connection.query(`/* pintpath:logical-backup:set-role */ SET ROLE ${backupRoleName}`);
    await connection.query(`/* pintpath:logical-backup:begin-snapshot */
      BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await connection.query(`/* pintpath:logical-backup:snapshot-settings */
      SET LOCAL statement_timeout = '120s';
      SET LOCAL lock_timeout = '30s';
      SET LOCAL idle_in_transaction_session_timeout = '2h';
      SET LOCAL timezone = 'UTC';
      SET LOCAL bytea_output = 'hex';
      SET LOCAL extra_float_digits = 3`);
    const role = await connection.query<EffectiveRoleRow>(`/* pintpath:logical-backup:effective-role */
      SELECT current_user AS "effectiveRole", session_user AS "sessionRole",
             current_setting('transaction_isolation') AS "transactionIsolation",
             current_setting('transaction_read_only')::boolean AS "transactionReadOnly",
             role.rolcanlogin AS "canLogin", role.rolinherit AS "inheritsPrivileges",
             role.rolsuper AS superuser, role.rolcreatedb AS "createDatabase",
             role.rolcreaterole AS "createRole", role.rolreplication AS replication,
             role.rolbypassrls AS "bypassRls",
             (SELECT count(*)::integer FROM pg_catalog.pg_auth_members AS membership
              WHERE membership.member = role.oid) AS "membershipCount",
             (SELECT count(*)::integer FROM pg_catalog.pg_auth_members AS membership
              WHERE membership.roleid = role.oid) AS "childMembershipCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_auth_members AS membership
              JOIN pg_catalog.pg_roles AS child_role ON child_role.oid = membership.member
              WHERE membership.roleid = role.oid
                AND child_role.rolname = session_user
                AND NOT membership.admin_option
                AND NOT membership.inherit_option
                AND membership.set_option) AS "exactSessionLoginChildCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_database AS granted_database
              CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                granted_database.datacl,
                pg_catalog.acldefault('d', granted_database.datdba)
              )) AS privilege
              WHERE privilege.grantee = role.oid) AS "directDatabasePrivilegeCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_proc AS routine
              CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                routine.proacl,
                pg_catalog.acldefault('f', routine.proowner)
              )) AS privilege
              WHERE privilege.grantee = role.oid) AS "directFunctionPrivilegeCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_db_role_setting AS setting
              WHERE setting.setrole = role.oid) AS "roleSettingCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_shdepend AS dependency
              JOIN pg_catalog.pg_database AS current_database_row
                ON current_database_row.datname = current_database()
              WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                AND dependency.refobjid = role.oid
                AND dependency.deptype = 'o'
                AND dependency.dbid IN (0::oid, current_database_row.oid))
               AS "ownedCurrentDatabaseObjectCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_shdepend AS dependency
              WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                AND dependency.refobjid = role.oid) AS "sharedDependencyCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_shdepend AS dependency
              JOIN pg_catalog.pg_database AS current_database_row
                ON current_database_row.datname = current_database()
              WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                AND dependency.refobjid = role.oid
                AND dependency.dbid = current_database_row.oid
                AND dependency.objsubid = 0
                AND dependency.deptype = 'a'
                AND (
                  (
                    dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
                    AND EXISTS (
                      SELECT 1 FROM pg_catalog.pg_namespace AS namespace
                      WHERE namespace.oid = dependency.objid
                        AND namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                    )
                  )
                  OR (
                    dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                    AND EXISTS (
                      SELECT 1
                      FROM pg_catalog.pg_class AS relation
                      JOIN pg_catalog.pg_namespace AS namespace
                        ON namespace.oid = relation.relnamespace
                      WHERE relation.oid = dependency.objid
                        AND namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                        AND relation.relkind IN ('r', 'p', 'S')
                    )
                  )
                )) AS "exactSharedDependencyCount",
             (SELECT count(*)::integer FROM pg_catalog.pg_namespace AS namespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])) AS "privateSchemaCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_namespace AS namespace
              CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                namespace.nspacl,
                pg_catalog.acldefault('n', namespace.nspowner)
              )) AS privilege
              WHERE privilege.grantee = role.oid) AS "directSchemaPrivilegeCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_namespace AS namespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND pg_catalog.has_schema_privilege(role.oid, namespace.oid, 'USAGE')
                AND NOT pg_catalog.has_schema_privilege(role.oid, namespace.oid, 'CREATE')
                AND (SELECT count(*)
                     FROM LATERAL pg_catalog.aclexplode(COALESCE(
                       namespace.nspacl,
                       pg_catalog.acldefault('n', namespace.nspowner)
                     )) AS privilege
                     WHERE privilege.grantee = role.oid
                       AND privilege.privilege_type = 'USAGE'
                       AND NOT privilege.is_grantable) = 1
                AND NOT EXISTS (
                  SELECT 1
                  FROM LATERAL pg_catalog.aclexplode(COALESCE(
                    namespace.nspacl,
                    pg_catalog.acldefault('n', namespace.nspowner)
                  )) AS privilege
                  WHERE privilege.grantee = role.oid
                    AND (privilege.privilege_type <> 'USAGE' OR privilege.is_grantable)
                )) AS "selectOnlySchemaCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND relation.relkind IN ('r', 'p')) AS "privateRelationCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND relation.relkind IN ('r', 'p')
                AND relation.relrowsecurity
                AND relation.relforcerowsecurity) AS "forceRlsRelationCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_class AS relation
              CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                relation.relacl,
                pg_catalog.acldefault(
                  (CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
                  relation.relowner
                )
              )) AS privilege
              WHERE privilege.grantee = role.oid) AS "directRelationPrivilegeCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND relation.relkind IN ('r', 'p')
                AND pg_catalog.has_table_privilege(role.oid, relation.oid, 'SELECT')
                AND NOT pg_catalog.has_table_privilege(
                  role.oid, relation.oid,
                  'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                )
                AND (SELECT count(*)
                     FROM LATERAL pg_catalog.aclexplode(COALESCE(
                       relation.relacl,
                       pg_catalog.acldefault('r', relation.relowner)
                     )) AS privilege
                     WHERE privilege.grantee = role.oid
                       AND privilege.privilege_type = 'SELECT'
                       AND NOT privilege.is_grantable) = 1
                AND NOT EXISTS (
                  SELECT 1
                  FROM LATERAL pg_catalog.aclexplode(COALESCE(
                    relation.relacl,
                    pg_catalog.acldefault('r', relation.relowner)
                  )) AS privilege
                  WHERE privilege.grantee = role.oid
                    AND (privilege.privilege_type <> 'SELECT' OR privilege.is_grantable)
                )) AS "selectOnlyRelationCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND relation.relkind = 'S') AS "privateSequenceCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND relation.relkind = 'S'
                AND (SELECT count(*)
                     FROM LATERAL pg_catalog.aclexplode(COALESCE(
                       relation.relacl,
                       pg_catalog.acldefault('S', relation.relowner)
                     )) AS privilege
                     WHERE privilege.grantee = role.oid
                       AND privilege.privilege_type = 'SELECT'
                       AND NOT privilege.is_grantable) = 1
                AND NOT EXISTS (
                  SELECT 1
                  FROM LATERAL pg_catalog.aclexplode(COALESCE(
                    relation.relacl,
                    pg_catalog.acldefault('S', relation.relowner)
                  )) AS privilege
                  WHERE privilege.grantee = role.oid
                    AND (privilege.privilege_type <> 'SELECT' OR privilege.is_grantable)
                )) AS "selectOnlySequenceCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_attribute AS attribute
              JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
              WHERE attribute.attnum > 0
                AND NOT attribute.attisdropped
                AND attribute.attacl IS NOT NULL
                AND privilege.grantee = role.oid) AS "directColumnPrivilegeCount",
             (SELECT count(*)::integer
             FROM pg_catalog.pg_proc AS routine
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND pg_catalog.has_function_privilege(role.oid, routine.oid, 'EXECUTE'))
               AS "executablePrivateFunctionCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_policy AS policy
              JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops']))
               AS "privatePolicyCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_policy AS policy
              JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              CROSS JOIN pg_catalog.pg_roles AS runtime_role
              CROSS JOIN pg_catalog.pg_roles AS migrator_role
              WHERE runtime_role.rolname = 'pintpath_runtime'
                AND migrator_role.rolname = 'pintpath_migrator'
                AND namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND policy.polpermissive
                AND (
                  (
                    namespace.nspname = 'pintpath_app'
                    AND relation.relname <> 'schema_metadata'
                    AND (
                      (
                        policy.polname = (relation.relname || '_runtime_all')::name
                        AND policy.polroles = ARRAY[runtime_role.oid]::oid[]
                        AND policy.polcmd = '*'
                        AND pg_catalog.pg_get_expr(
                          policy.polqual, policy.polrelid, false
                        ) = 'true'
                        AND pg_catalog.pg_get_expr(
                          policy.polwithcheck, policy.polrelid, false
                        ) = 'true'
                      )
                      OR (
                        policy.polname = (relation.relname || '_migrator_select')::name
                        AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                        AND policy.polcmd = 'r'
                        AND pg_catalog.pg_get_expr(
                          policy.polqual, policy.polrelid, false
                        ) = 'true'
                        AND policy.polwithcheck IS NULL
                      )
                      OR (
                        policy.polname = (relation.relname || '_migrator_insert')::name
                        AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                        AND policy.polcmd = 'a'
                        AND policy.polqual IS NULL
                        AND pg_catalog.pg_get_expr(
                          policy.polwithcheck, policy.polrelid, false
                        ) = 'true'
                      )
                    )
                  )
                  OR (
                    namespace.nspname = 'pintpath_app'
                    AND relation.relname = 'schema_metadata'
                    AND (
                      (
                        policy.polname = 'schema_metadata_runtime_read'::name
                        AND policy.polroles = ARRAY[runtime_role.oid]::oid[]
                        AND policy.polcmd = 'r'
                        AND pg_catalog.pg_get_expr(
                          policy.polqual, policy.polrelid, false
                        ) = 'true'
                        AND policy.polwithcheck IS NULL
                      )
                      OR (
                        policy.polname = 'schema_metadata_migrator_select'::name
                        AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                        AND policy.polcmd = 'r'
                        AND pg_catalog.pg_get_expr(
                          policy.polqual, policy.polrelid, false
                        ) = 'true'
                        AND policy.polwithcheck IS NULL
                      )
                      OR (
                        policy.polname = 'schema_metadata_migrator_update'::name
                        AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                        AND policy.polcmd = 'w'
                        AND pg_catalog.pg_get_expr(
                          policy.polqual, policy.polrelid, false
                        ) = 'true'
                        AND pg_catalog.pg_get_expr(
                          policy.polwithcheck, policy.polrelid, false
                        ) = 'true'
                      )
                    )
                  )
                  OR (
                    namespace.nspname = 'pintpath_ops'
                    AND relation.relname = ANY(ARRAY['migration_chunks', 'migration_runs'])
                    AND (
                      (
                        policy.polname = (relation.relname || '_migrator_select')::name
                        AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                        AND policy.polcmd = 'r'
                        AND pg_catalog.pg_get_expr(
                          policy.polqual, policy.polrelid, false
                        ) = 'true'
                        AND policy.polwithcheck IS NULL
                      )
                      OR (
                        policy.polname = (relation.relname || '_migrator_insert')::name
                        AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                        AND policy.polcmd = 'a'
                        AND policy.polqual IS NULL
                        AND pg_catalog.pg_get_expr(
                          policy.polwithcheck, policy.polrelid, false
                        ) = 'true'
                      )
                      OR (
                        policy.polname = (relation.relname || '_migrator_update')::name
                        AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                        AND policy.polcmd = 'w'
                        AND pg_catalog.pg_get_expr(
                          policy.polqual, policy.polrelid, false
                        ) = 'true'
                        AND pg_catalog.pg_get_expr(
                          policy.polwithcheck, policy.polrelid, false
                        ) = 'true'
                      )
                    )
                  )
                )) AS "exactBasePolicyCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_policy AS policy
              JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND 0::oid = ANY(policy.polroles)) AS "publicPrivatePolicyCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_policy AS policy
              JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND policy.polname = (relation.relname || '_logical_backup_select')::name
                AND policy.polroles = ARRAY[0]::oid[]
                AND policy.polcmd = 'r'
                AND policy.polpermissive
                AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = $2
                AND policy.polwithcheck IS NULL) AS "exactLogicalBackupSelectPolicyCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_policy AS policy
              JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND 0::oid = ANY(policy.polroles)
                AND NOT (
                  policy.polname = (relation.relname || '_logical_backup_select')::name
                  AND policy.polroles = ARRAY[0]::oid[]
                  AND policy.polcmd = 'r'
                  AND policy.polpermissive
                  AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = $2
                  AND policy.polwithcheck IS NULL
                )) AS "unsafePublicPrivatePolicyCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_policy AS policy
              JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND policy.polname::text ~ '_logical_backup_select$'
                AND NOT (
                  policy.polname = (relation.relname || '_logical_backup_select')::name
                  AND policy.polroles = ARRAY[0]::oid[]
                  AND policy.polcmd = 'r'
                  AND policy.polpermissive
                  AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = $2
                  AND policy.polwithcheck IS NULL
                )) AS "unsafeReservedPolicyNameCount",
             (SELECT count(*)::integer
              FROM pg_catalog.pg_policy AS policy
              JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND role.oid = ANY(policy.polroles)) AS "directScopedPolicyCount"
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = current_user
        AND role.rolname = $1`, [backupRoleName, EXACT_LOGICAL_BACKUP_POLICY_EXPRESSION]);
    const roleRow = role.rows[0];
    if (
      role.rows.length !== 1
      || roleRow?.effectiveRole !== backupRoleName
      || !roleRow.sessionRole
      || roleRow.sessionRole === roleRow.effectiveRole
      || roleRow.transactionIsolation !== "repeatable read"
      || roleRow.transactionReadOnly !== true
      || roleRow.canLogin !== false
      || roleRow.inheritsPrivileges !== false
      || roleRow.superuser !== false
      || roleRow.createDatabase !== false
      || roleRow.createRole !== false
      || roleRow.replication !== false
      || roleRow.bypassRls !== false
      || roleRow.membershipCount !== 0
      || roleRow.childMembershipCount !== 1
      || roleRow.exactSessionLoginChildCount !== 1
      || roleRow.directDatabasePrivilegeCount !== 0
      || roleRow.directFunctionPrivilegeCount !== 0
      || roleRow.roleSettingCount !== 0
      || roleRow.ownedCurrentDatabaseObjectCount !== 0
      || roleRow.sharedDependencyCount !== roleRow.privateSchemaCount + roleRow.privateRelationCount
      || roleRow.exactSharedDependencyCount !== roleRow.sharedDependencyCount
      || roleRow.privateSchemaCount !== 2
      || roleRow.directSchemaPrivilegeCount !== roleRow.privateSchemaCount
      || roleRow.selectOnlySchemaCount !== roleRow.privateSchemaCount
      || roleRow.privateRelationCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + 3
      || roleRow.forceRlsRelationCount !== roleRow.privateRelationCount
      || roleRow.directRelationPrivilegeCount !== roleRow.privateRelationCount
      || roleRow.selectOnlyRelationCount !== roleRow.privateRelationCount
      || roleRow.privateSequenceCount !== 0
      || roleRow.selectOnlySequenceCount !== 0
      || roleRow.directColumnPrivilegeCount !== 0
      || roleRow.executablePrivateFunctionCount !== 0
      || roleRow.privatePolicyCount !== 236
      || roleRow.exactBasePolicyCount !== 177
      || roleRow.publicPrivatePolicyCount !== roleRow.privateRelationCount
      || roleRow.exactLogicalBackupSelectPolicyCount !== roleRow.privateRelationCount
      || roleRow.unsafePublicPrivatePolicyCount !== 0
      || roleRow.unsafeReservedPolicyNameCount !== 0
      || roleRow.directScopedPolicyCount !== 0
    ) throw new Error("unsafe_effective_role");
    const exported = await connection.query<SnapshotRow>(
      "/* pintpath:logical-backup:export-snapshot */ SELECT pg_export_snapshot() AS \"snapshotIdentifier\"",
    );
    const snapshotIdentifier = exported.rows[0]?.snapshotIdentifier;
    if (
      exported.rows.length !== 1
      || typeof snapshotIdentifier !== "string"
      || !SNAPSHOT_IDENTIFIER_PATTERN.test(snapshotIdentifier)
    ) throw new Error("invalid_snapshot_identifier");
    return {
      snapshotIdentifier,
      snapshotBindingSha256: sha256CanonicalPostgresLogicalState({
        kind: "pintpath-postgres-logical-snapshot-binding",
        version: 1,
        sourceDatabaseIdentitySha256,
        sourceUrlSha256,
        exportedSnapshotSha256: crypto.createHash("sha256")
          .update(snapshotIdentifier, "utf8").digest("hex"),
        effectiveRole: backupRoleName,
        transactionIsolation: "repeatable read",
        transactionReadOnly: true,
      }),
    };
  } catch (error) {
    if (error instanceof PostgresLogicalBackupError) throw error;
    throw new PostgresLogicalBackupError("source_unreachable_or_unsafe");
  }
}

async function endSourceSnapshot(connection: PostgresLogicalBackupConnection): Promise<boolean> {
  let clean = true;
  try {
    await connection.query("/* pintpath:logical-backup:rollback-snapshot */ ROLLBACK");
  } catch {
    clean = false;
  }
  try {
    await connection.query("/* pintpath:logical-backup:reset-role */ RESET ROLE");
  } catch {
    clean = false;
  }
  return clean;
}

async function cleanCreatedDirectory(
  outputDirectory: string,
  identity: DirectoryIdentity,
): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(outputDirectory);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || stat.dev !== identity.dev
      || stat.ino !== identity.ino
    ) {
      return false;
    }
    await fs.promises.rm(outputDirectory, { recursive: true, force: false });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function asSafeFailure(
  error: unknown,
  fallback: PostgresLogicalBackupFailureCode,
): PostgresLogicalBackupError {
  return error instanceof PostgresLogicalBackupError
    ? error
    : new PostgresLogicalBackupError(fallback);
}

export async function createPostgresLogicalBackup(
  options: CreatePostgresLogicalBackupOptions,
  overrides: Partial<PostgresLogicalBackupDependencies> = {},
): Promise<PostgresLogicalBackupResult> {
  if (
    typeof options.expectedSourceUrlSha256 !== "string"
    || !SHA256_PATTERN.test(options.expectedSourceUrlSha256)
  ) throw new PostgresLogicalBackupError("invalid_arguments");
  const dependencies: PostgresLogicalBackupDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  const uid = dependencies.getUid();
  if (!Number.isInteger(uid) || uid === null || uid < 0) {
    throw new PostgresLogicalBackupError("unsafe_connection_file");
  }

  const connectionFile = path.resolve(options.connectionFile);
  const trustedConnection = await readTrustedConnectionFile(connectionFile, uid);
  const parsedConnection = parseSafeConnectionUrl(trustedConnection.value, dependencies);
  if (parsedConnection.urlSha256 !== options.expectedSourceUrlSha256) {
    throw new PostgresLogicalBackupError("unsafe_connection_url");
  }
  const processEnvironment = makeBaseProcessEnvironment(dependencies.env);
  const [pgDump, pgRestore] = await Promise.all([
    identifyTool("pg_dump", dependencies.pgDumpCommand, processEnvironment, dependencies.runProcess),
    identifyTool("pg_restore", dependencies.pgRestoreCommand, processEnvironment, dependencies.runProcess),
  ]);
  if (pgDump.major !== pgRestore.major) {
    throw new PostgresLogicalBackupError("tool_unavailable_or_unsupported");
  }

  await assertConnectionFileUnchanged(connectionFile, uid, trustedConnection);
  let sourceConnection: PostgresLogicalBackupConnection;
  try {
    sourceConnection = await dependencies.connect(parsedConnection.clientConfig);
  } catch (error) {
    if (error instanceof PostgresLogicalBackupError) throw error;
    throw new PostgresLogicalBackupError("source_unreachable_or_unsafe");
  }

  let snapshotOpen = false;
  let prepared: Awaited<ReturnType<typeof prepareFreshOutputDirectory>> | null = null;
  let pendingError: PostgresLogicalBackupError | null = null;
  let completed: PostgresLogicalBackupResult | null = null;
  try {
    const sourceIdentity = await inspectSafeSourceIdentity(sourceConnection);
    const snapshot = await beginExportedSourceSnapshot(
      sourceConnection,
      sourceIdentity.sourceDatabaseIdentitySha256,
      parsedConnection.urlSha256,
      sourceIdentity.backupRoleName,
    );
    snapshotOpen = true;

    let state: PostgresLogicalStateInventory;
    try {
      // Hashing happens before pg_dump, but the exported REPEATABLE READ snapshot
      // is held open and imported by pg_dump. A commit between these operations
      // is therefore excluded from both artifacts.
      state = await dependencies.computeState(sourceConnection);
    } catch {
      throw new PostgresLogicalBackupError("source_contract_invalid");
    }
    if (
      state.authoritativeTableCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
      || state.migrationContractSha256 !== sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT)
    ) throw new PostgresLogicalBackupError("source_contract_invalid");

    await assertConnectionFileUnchanged(connectionFile, uid, trustedConnection);
    prepared = await prepareFreshOutputDirectory(options.outputDirectory, uid);
    const archivePath = path.join(prepared.outputDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE);
    const manifestPath = path.join(prepared.outputDirectory, POSTGRES_LOGICAL_BACKUP_MANIFEST);
    const stateReceiptPath = path.join(
      prepared.outputDirectory,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    );
    try {
      await createExclusiveFile(archivePath);
    } catch {
      throw new PostgresLogicalBackupError("unsafe_output_path");
    }

    const pgpass = await createEphemeralPgpass(parsedConnection, uid);
    const dumpEnvironment = Object.freeze({
      ...processEnvironment,
      ...parsedConnection.pgEnvironment,
      PGPASSFILE: pgpass.filePath,
    });
    let dumpResult: ProcessResult | null = null;
    let dumpError: PostgresLogicalBackupError | null = null;
    try {
      if (!await ephemeralPgpassIsExact(pgpass, uid)) {
        throw new PostgresLogicalBackupError("cleanup_failed");
      }
      dumpResult = await dependencies.runProcess({
        command: dependencies.pgDumpCommand,
        args: [
          "--format=custom",
          `--file=${archivePath}`,
          `--snapshot=${snapshot.snapshotIdentifier}`,
          `--role=${sourceIdentity.backupRoleName}`,
          "--no-owner",
          "--no-acl",
          "--enable-row-security",
          "--strict-names",
          "--lock-wait-timeout=30s",
          "--no-password",
          "--schema=pintpath_app",
          "--schema=pintpath_ops",
        ],
        env: dumpEnvironment,
        timeoutMs: DUMP_TIMEOUT_MS,
        maxStdoutBytes: DUMP_OUTPUT_LIMIT,
        maxStderrBytes: DUMP_OUTPUT_LIMIT,
      });
    } catch (error) {
      dumpError = error instanceof PostgresLogicalBackupError
        ? error
        : new PostgresLogicalBackupError("dump_failed");
    } finally {
      if (!await cleanupEphemeralPgpass(pgpass, uid)) {
        dumpError = new PostgresLogicalBackupError("cleanup_failed");
      }
    }
    if (dumpError) throw dumpError;
    if (!dumpResult) throw new PostgresLogicalBackupError("dump_failed");
    if (dumpResult.exitCode !== 0 || dumpResult.stdout.trim() || dumpResult.stderr.trim()) {
      throw new PostgresLogicalBackupError("dump_failed");
    }

    await assertDirectoryIdentity(prepared.outputDirectory, prepared.identity, uid);
    const beforeValidation = await snapshotTrustedFile(archivePath, uid, true);
    let listingResult: ProcessResult;
    try {
      listingResult = await dependencies.runProcess({
        command: dependencies.pgRestoreCommand,
        args: ["--list", "--format=custom", archivePath],
        env: processEnvironment,
        timeoutMs: RESTORE_LIST_TIMEOUT_MS,
        maxStdoutBytes: RESTORE_LIST_OUTPUT_LIMIT,
        maxStderrBytes: DUMP_OUTPUT_LIMIT,
      });
    } catch {
      throw new PostgresLogicalBackupError("archive_invalid");
    }
    if (listingResult.exitCode !== 0 || listingResult.stderr.trim()) {
      throw new PostgresLogicalBackupError("archive_invalid");
    }
    const listing = parseArchiveListing(listingResult.stdout);
    if (listing.dumpedByPgDumpVersion !== pgDump.version) {
      throw new PostgresLogicalBackupError("archive_invalid");
    }
    const afterValidation = await snapshotTrustedFile(archivePath, uid, true);
    if (!sameSnapshot(beforeValidation, afterValidation)) {
      throw new PostgresLogicalBackupError("archive_tampered");
    }
    await assertDirectoryIdentity(prepared.outputDirectory, prepared.identity, uid);
    await assertConnectionFileUnchanged(connectionFile, uid, trustedConnection);

    let createdAt: string;
    try {
      createdAt = dependencies.now().toISOString();
    } catch {
      throw new PostgresLogicalBackupError("manifest_failed");
    }
    const archive: PostgresLogicalBackupManifest["archive"] = {
      file: POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      format: "custom",
      bytes: afterValidation.size,
      sha256: afterValidation.sha256,
      schemas: POSTGRES_LOGICAL_BACKUP_SCHEMAS,
      aclStatementsIncluded: false,
      requiredRestoreOptions: ["--no-owner", "--no-acl"],
    };
    const tools = { pgDump, pgRestore };
    const validation: PostgresLogicalBackupManifest["validation"] = {
      method: "pg_restore --list",
      ...listing,
    };
    const provisionalState: PostgresLogicalBackupStateBinding = {
      receiptFile: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      receiptSha256: "0".repeat(64),
      manifestBindingSha256: "0".repeat(64),
      sourceDatabaseIdentitySha256: sourceIdentity.sourceDatabaseIdentitySha256,
      sourceUrlSha256: parsedConnection.urlSha256,
      snapshotBindingSha256: snapshot.snapshotBindingSha256,
      migrationContractSha256: state.migrationContractSha256,
      schemaMetadataSha256: state.schemaMetadataSha256,
      targetDdlSha256: state.targetDdlSha256,
      authoritativeTableCount: state.authoritativeTableCount,
      authoritativeRowCount: state.authoritativeRowCount,
      tableSetSha256: state.tableSetSha256,
      transformedDataSha256: state.transformedDataSha256,
      stateTotalsSha256: state.stateTotalsSha256,
      keyRangesSha256: state.keyRangesSha256,
      archivedControlTableCount: state.archivedControlTableCount,
      archivedControlRowCount: state.archivedControlRowCount,
      archivedControlTableSetSha256: state.archivedControlTableSetSha256,
      archivedControlDataSha256: state.archivedControlDataSha256,
      archivedControlKeyRangesSha256: state.archivedControlKeyRangesSha256,
      overallStateSha256: state.overallStateSha256,
    };
    const manifestBindingSha256 = postgresLogicalBackupManifestBindingSha256({
      schemaVersion: 2,
      kind: "pintpath-postgres-logical-backup",
      createdAt,
      archive,
      tools,
      validation,
      state: provisionalState,
    });
    const stateReceipt = buildPostgresLogicalSourceStateReceipt({
      capturedAt: createdAt,
      databaseIdentitySha256: sourceIdentity.sourceDatabaseIdentitySha256,
      sourceUrlSha256: parsedConnection.urlSha256,
      snapshotBindingSha256: snapshot.snapshotBindingSha256,
      archiveBytes: afterValidation.size,
      archiveSha256: afterValidation.sha256,
      archiveListingSha256: listing.listingSha256,
      manifestBindingSha256,
      state,
    });
    try {
      await writeCanonicalStateReceipt(stateReceiptPath, stateReceipt);
    } catch (error) {
      if (error instanceof PostgresLogicalBackupError) throw error;
      throw new PostgresLogicalBackupError("state_receipt_failed");
    }
    const stateReceiptSnapshot = await snapshotTrustedFile(stateReceiptPath, uid, true)
      .catch(() => { throw new PostgresLogicalBackupError("state_receipt_failed"); });
    const manifest: PostgresLogicalBackupManifest = {
      schemaVersion: 2,
      kind: "pintpath-postgres-logical-backup",
      createdAt,
      archive,
      tools,
      validation,
      state: {
        ...provisionalState,
        receiptSha256: stateReceiptSnapshot.sha256,
        manifestBindingSha256,
      },
    };
    if (postgresLogicalBackupManifestBindingSha256(manifest) !== manifestBindingSha256) {
      throw new PostgresLogicalBackupError("manifest_failed");
    }
    try {
      await writeCanonicalManifest(manifestPath, manifest);
    } catch {
      throw new PostgresLogicalBackupError("manifest_failed");
    }

    const finalArchive = await snapshotTrustedFile(archivePath, uid, true);
    const finalStateReceipt = await snapshotTrustedFile(stateReceiptPath, uid, true);
    if (
      !sameSnapshot(afterValidation, finalArchive)
      || !sameSnapshot(stateReceiptSnapshot, finalStateReceipt)
    ) throw new PostgresLogicalBackupError("archive_tampered");
    const manifestSnapshot = await snapshotTrustedFile(manifestPath, uid, true);
    await assertDirectoryIdentity(prepared.outputDirectory, prepared.identity, uid);
    await assertConnectionFileUnchanged(connectionFile, uid, trustedConnection);
    completed = {
      schemaVersion: 2,
      ok: true,
      outputDirectory: prepared.outputDirectory,
      archivePath,
      manifestPath,
      stateReceiptPath,
      archiveSha256: finalArchive.sha256,
      manifestSha256: manifestSnapshot.sha256,
      stateReceiptSha256: finalStateReceipt.sha256,
      authoritativeRowCount: state.authoritativeRowCount,
      overallStateSha256: state.overallStateSha256,
    };
  } catch (error) {
    pendingError = asSafeFailure(error, "archive_invalid");
  } finally {
    let snapshotClosed = true;
    if (snapshotOpen) snapshotClosed = await endSourceSnapshot(sourceConnection);
    try {
      await sourceConnection.close();
    } catch {
      snapshotClosed = false;
    }
    if (!snapshotClosed && !pendingError) {
      pendingError = new PostgresLogicalBackupError("cleanup_failed");
    }
  }

  if (pendingError || !completed) {
    if (prepared) {
      const cleaned = await cleanCreatedDirectory(prepared.outputDirectory, prepared.identity);
      if (!cleaned) throw new PostgresLogicalBackupError("cleanup_failed");
    }
    throw pendingError ?? new PostgresLogicalBackupError("archive_invalid");
  }
  return completed;
}
