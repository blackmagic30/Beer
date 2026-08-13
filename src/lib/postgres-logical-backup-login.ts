import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { Client, type ClientConfig, type QueryResultRow } from "pg";

import { POSTGRES_MIGRATION_CONTRACT } from "../db/postgres-migration-contract.js";
import { canonicalPostgresBackupJson } from "./postgres-logical-backup.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  openPostgresRailwayStockLocalhostCaTransport,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaNodeConnection,
  type PostgresRailwayStockLocalhostCaTransport,
} from "./postgres-railway-stock-localhost-ca.js";

export const POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT = "permanent-staging" as const;
export const POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT_ENV =
  "PINTPATH_POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT" as const;
export const POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION_ENV =
  "PINTPATH_POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION" as const;
export const POSTGRES_LOGICAL_BACKUP_LOGIN_OPERATION_ENV =
  "PINTPATH_POSTGRES_LOGICAL_BACKUP_LOGIN_OPERATION" as const;
export const POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE =
  "postgres-logical-backup-url.key" as const;
export const POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE =
  "provision-intent.json" as const;
export const POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_INTENT_FILE =
  "retire-intent.json" as const;
export const POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_DISABLED_FILE =
  "retire-disabled.json" as const;

const MANAGER_SCHEMA_VERSION = 2 as const;
const MAX_PRIVATE_FILE_BYTES = 64 * 1024;
const MAX_ADMIN_URL_BYTES = 16 * 1024;
const SCRAM_ITERATIONS = 4_096;
const PASSWORD_BYTES = 48;
const SCRAM_SALT_BYTES = 16;
const DATABASE_OID_PATTERN = /^[1-9][0-9]{0,9}$/;
const LOGIN_VERSION_PATTERN = /^[1-9][0-9]{0,19}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA1_PATTERN = /^[a-f0-9]{40}$/;
const NODE_VERSION_PATTERN = /^v22\.[0-9]+\.[0-9]+$/;
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,95}$/;
const APPROVAL_REFERENCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{7,255}$/;
const SYSTEM_IDENTIFIER_PATTERN = /^[1-9][0-9]{0,19}$/;
const ROLE_OID_PATTERN = /^[1-9][0-9]{0,9}$/;
const ROLE_PREFIX = "pintpath_logical_backup_d";
const MAX_POSTGRES_OID = 4_294_967_295n;
const ADVISORY_LOCK_KEY = "-4745247869249173621";
const EXPECTED_PRIVATE_RELATIONS = POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + 3;
const EXPECTED_BASE_POLICIES = 177;
const EXPECTED_BACKUP_POLICIES = EXPECTED_PRIVATE_RELATIONS;
const EXPECTED_POLICIES = EXPECTED_BASE_POLICIES + EXPECTED_BACKUP_POLICIES;
const EXPECTED_GROUP_DEPENDENCIES = 2 + EXPECTED_PRIVATE_RELATIONS;
const LOGICAL_BACKUP_POLICY_EXPRESSION = `(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid
   FROM pg_database database
  WHERE (database.datname = current_database()))))`;
const SCRAM_VERIFIER_PATTERN =
  /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;
const SAFE_PRELOAD_LIBRARIES = new Set(["", "pg_stat_statements", "auto_explain"]);
const FORBIDDEN_ENVIRONMENT_KEYS = Object.freeze([
  "DATABASE_URL",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "OPENSSL_CONF",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
] as const);

export type PostgresLogicalBackupLoginOperation = "provision" | "retire";

export type PostgresLogicalBackupLoginFailureCode =
  | "invalid_arguments"
  | "host_gate_failed"
  | "unsafe_admin_connection_file"
  | "unsafe_admin_connection_url"
  | "source_identity_mismatch"
  | "source_authority_invalid"
  | "logger_guard_failed"
  | "escrow_invalid"
  | "receipt_invalid"
  | "mutation_failed"
  | "mutation_ambiguous"
  | "canary_failed"
  | "cleanup_failed";

export class PostgresLogicalBackupLoginError extends Error {
  readonly code: PostgresLogicalBackupLoginFailureCode;

  constructor(code: PostgresLogicalBackupLoginFailureCode) {
    super(code);
    this.name = "PostgresLogicalBackupLoginError";
    this.code = code;
  }
}

export interface PostgresLogicalBackupLoginManagerOptions {
  readonly operation: PostgresLogicalBackupLoginOperation;
  readonly adminConnectionFile: string;
  readonly expectedAdminUrlSha256: string;
  readonly transportProfile: typeof POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE;
  readonly rootCaFile: string;
  readonly expectedRootCaDerSha256: string;
  readonly expectedDatabaseIdentitySha256: string;
  readonly expectedHeadSha: string;
  readonly expectedTreeSha: string;
  readonly expectedUid: number;
  readonly expectedNodeVersion: string;
  readonly expectedEnvironment: typeof POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT;
  readonly operationId: string;
  readonly approvalReference: string;
  readonly loginVersion: string;
  readonly escrowDirectory: string;
  readonly receiptFile: string;
  readonly provisionReceiptFile?: string;
  readonly expectedProvisionReceiptSha256?: string;
}

export interface PostgresLogicalBackupLoginReceipt {
  readonly schemaVersion: typeof MANAGER_SCHEMA_VERSION;
  readonly kind: "pintpath-postgres-logical-backup-login";
  readonly operation: PostgresLogicalBackupLoginOperation;
  readonly status: "provisioned" | "retired";
  readonly createdAt: string;
  readonly operationId: string;
  readonly approvalReference: string;
  readonly expectedEnvironment: typeof POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT;
  readonly executorUid: number;
  readonly mutationArm: string;
  readonly headSha: string;
  readonly treeSha: string;
  readonly nodeVersion: string;
  readonly adminUrlSha256: string;
  readonly transportProfile: typeof POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE;
  readonly rootCaDerSha256: string;
  readonly databaseIdentitySha256: string;
  readonly databaseOid: string;
  readonly databaseNameSha256: string;
  readonly loginVersion: string;
  readonly loginRole: string;
  readonly loginRoleOid: string;
  readonly groupRole: string;
  readonly marker: string;
  readonly markerSha256: string;
  readonly escrowIntentSha256: string;
  readonly escrowUrlSha256: string;
  readonly loggerInventorySha256: string;
  readonly authorityPolicyCount: number;
  readonly authorityDependencyCount: number;
  readonly canary: {
    readonly saslScramSha256: boolean;
    readonly setRole: boolean;
    readonly readOnly: boolean;
  };
  readonly provisionReceiptSha256: string | null;
  readonly retireIntentSha256: string | null;
  readonly retireDisabledSha256: string | null;
}

export interface PostgresLogicalBackupLoginManagerResult {
  readonly receipt: PostgresLogicalBackupLoginReceipt;
  readonly receiptSha256: string;
}

export interface PostgresLogicalBackupLoginRepositoryIdentity {
  readonly headSha: string;
  readonly treeSha: string;
  readonly upstreamSha: string;
  readonly clean: boolean;
  readonly root: string;
  readonly coreRepositoryFormatVersion: string;
  readonly coreBare: string;
  readonly hooksPathAbsent: boolean;
  readonly fsmonitorAbsentOrFalse: boolean;
}

export interface PostgresLogicalBackupLoginConnection {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  close(): Promise<void>;
  readonly authenticationMethod: "scram-sha-256" | "other" | "unknown";
}

export interface PostgresLogicalBackupLoginDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getUid: () => number | null;
  readonly getEuid: () => number | null;
  readonly nodeVersion: string;
  readonly now: () => Date;
  readonly randomBytes: (size: number) => Buffer;
  readonly repositoryRoot: string;
  readonly inspectRepository: (root: string) => Promise<PostgresLogicalBackupLoginRepositoryIdentity>;
  readonly connect: (
    config: PostgresLogicalBackupLoginConnectionConfig,
  ) => Promise<PostgresLogicalBackupLoginConnection>;
  readonly openTransport: (
    options: OpenPostgresRailwayStockLocalhostCaTransportOptions,
  ) => Promise<PostgresRailwayStockLocalhostCaTransport>;
}

interface PostgresLogicalBackupLoginConnectionConfig extends ClientConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: PostgresRailwayStockLocalhostCaNodeConnection["ssl"];
  readonly application_name: string;
  readonly connectionTimeoutMillis: number;
  readonly query_timeout: number;
  readonly statement_timeout: number;
}

interface StablePrivateFile {
  readonly path: string;
  readonly value: Buffer;
  readonly sha256: string;
  readonly identity: PrivateFileIdentity;
}

interface HeldStablePrivateFile extends StablePrivateFile {
  readonly handle: FileHandle;
}

interface TrustedPrivateDirectory {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: DirectoryIdentity;
}

interface ReceiptAuthority {
  readonly path: string;
  readonly parent: TrustedPrivateDirectory;
  readonly existing: {
    readonly receipt: PostgresLogicalBackupLoginReceipt;
    readonly file: HeldStablePrivateFile;
  } | null;
}

interface PrivateFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
}

interface SafeAdminConnection {
  readonly urlSha256: string;
  readonly protocol: "postgres:" | "postgresql:";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

interface SourceIdentity {
  readonly systemIdentifier: string;
  readonly databaseOid: string;
  readonly databaseName: string;
  readonly serverVersionNum: string;
  readonly databaseIdentitySha256: string;
  readonly adminRole: string;
}

interface ProvisionIntent {
  readonly schemaVersion: typeof MANAGER_SCHEMA_VERSION;
  readonly kind: "pintpath-postgres-logical-backup-login-provision-intent";
  readonly createdAt: string;
  readonly operationId: string;
  readonly approvalReference: string;
  readonly expectedEnvironment: typeof POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT;
  readonly executorUid: number;
  readonly mutationArm: string;
  readonly headSha: string;
  readonly treeSha: string;
  readonly nodeVersion: string;
  readonly adminUrlSha256: string;
  readonly transportProfile: typeof POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE;
  readonly rootCaDerSha256: string;
  readonly databaseIdentitySha256: string;
  readonly databaseOid: string;
  readonly databaseNameSha256: string;
  readonly loginVersion: string;
  readonly loginRole: string;
  readonly groupRole: string;
  readonly escrowUrlSha256: string;
  readonly scramSaltBase64: string;
  readonly scramVerifierSha256: string;
  readonly loggerInventorySha256: string;
}

interface RetireIntent {
  readonly schemaVersion: typeof MANAGER_SCHEMA_VERSION;
  readonly kind: "pintpath-postgres-logical-backup-login-retire-intent";
  readonly createdAt: string;
  readonly operationId: string;
  readonly approvalReference: string;
  readonly expectedEnvironment: typeof POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT;
  readonly executorUid: number;
  readonly mutationArm: string;
  readonly headSha: string;
  readonly treeSha: string;
  readonly nodeVersion: string;
  readonly adminUrlSha256: string;
  readonly transportProfile: typeof POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE;
  readonly rootCaDerSha256: string;
  readonly databaseIdentitySha256: string;
  readonly loginVersion: string;
  readonly loginRole: string;
  readonly loginRoleOid: string;
  readonly groupRole: string;
  readonly marker: string;
  readonly provisionReceiptSha256: string;
}

interface RetireDisabledCheckpoint extends Omit<RetireIntent, "kind"> {
  readonly kind: "pintpath-postgres-logical-backup-login-retire-disabled";
  readonly disabledAt: string;
}

interface EscrowBundle {
  readonly directory: string;
  readonly directoryIdentity: DirectoryIdentity;
  readonly urlFile: StablePrivateFile;
  readonly intentFile: StablePrivateFile;
  readonly intent: ProvisionIntent;
  readonly password: string;
  readonly verifier: string;
}

interface LoggerInventory {
  readonly sharedPreloadLibraries: readonly string[];
  readonly sessionPreloadLibraries: readonly string[];
  readonly localPreloadLibraries: readonly string[];
  readonly pgauditInstalled: boolean;
  readonly pgStatStatementsLoaded: boolean;
  readonly autoExplainLoaded: boolean;
}

interface CandidateState {
  readonly exists: boolean;
  readonly oid: string | null;
  readonly marker: string | null;
  readonly canLogin: boolean | null;
  readonly hasPassword: boolean | null;
  readonly exact: boolean;
  readonly preparedExact: boolean;
  readonly disabledExact: boolean;
}

interface GroupAuthorityState {
  readonly exact: boolean;
  readonly policyCount: number;
  readonly dependencyCount: number;
  readonly childCount: number;
}

interface HostGateResult {
  readonly repository: PostgresLogicalBackupLoginRepositoryIdentity;
  readonly mutationArm: string;
}

function sha256(value: string | Buffer): string {
  // This utility produces non-authentication equality/integrity bindings. Any
  // credential flowing here is generated from 256 bits of randomness, while
  // PostgreSQL authentication relies on its separately generated SCRAM verifier.
  // codeql[js/insufficient-password-hash]
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalPostgresBackupJson(value));
}

function exactAbsolutePath(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
  return value;
}

function exactOid(value: string): boolean {
  if (!ROLE_OID_PATTERN.test(value)) return false;
  try {
    return BigInt(value) <= MAX_POSTGRES_OID;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remapPreservingCleanup(
  error: unknown,
  code: PostgresLogicalBackupLoginFailureCode,
): never {
  if (error instanceof PostgresLogicalBackupLoginError && error.code === "cleanup_failed") {
    throw error;
  }
  throw new PostgresLogicalBackupLoginError(code);
}

function sameFileIdentity(left: PrivateFileIdentity, right: PrivateFileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function privateFileIdentity(stat: fs.BigIntStats): PrivateFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function directoryIdentity(stat: fs.BigIntStats): DirectoryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    nlink: stat.nlink,
  };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function assertPrivateFileStat(
  stat: fs.BigIntStats,
  expectedUid: bigint,
  maximumBytes: number,
  allowEmpty = false,
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== expectedUid
    || stat.nlink !== 1n
    || Number(stat.mode & 0o7777n) !== 0o600
    || (!allowEmpty && stat.size < 1n)
    || stat.size > BigInt(maximumBytes)
  ) throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
}

async function openStablePrivateFile(
  filePathInput: string,
  expectedUid: number,
  maximumBytes = MAX_PRIVATE_FILE_BYTES,
): Promise<HeldStablePrivateFile> {
  const filePath = exactAbsolutePath(filePathInput);
  let before: fs.BigIntStats;
  try {
    before = await fs.promises.lstat(filePath, { bigint: true });
    assertPrivateFileStat(before, BigInt(expectedUid), maximumBytes);
  } catch (error) {
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
  }
  let handle: FileHandle | null = null;
  let bytes: Buffer | null = null;
  try {
    // The O_NOFOLLOW descriptor is bound to the pre-open lstat by full file
    // identity; both the descriptor and pathname are revalidated after read.
    // codeql[js/file-system-race]
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW ?? 0)
        | (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    assertPrivateFileStat(opened, BigInt(expectedUid), maximumBytes);
    const beforeIdentity = privateFileIdentity(before);
    if (!sameFileIdentity(beforeIdentity, privateFileIdentity(opened))) {
      throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
      }
      offset += read.bytesRead;
    }
    const eof = Buffer.alloc(1);
    const extra = await handle.read(eof, 0, 1, bytes.length);
    eof.fill(0);
    if (extra.bytesRead !== 0) {
      throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
    }
    const afterDescriptor = await handle.stat({ bigint: true });
    const afterPath = await fs.promises.lstat(filePath, { bigint: true });
    assertPrivateFileStat(afterDescriptor, BigInt(expectedUid), maximumBytes);
    assertPrivateFileStat(afterPath, BigInt(expectedUid), maximumBytes);
    const finalIdentity = privateFileIdentity(afterDescriptor);
    if (
      !sameFileIdentity(beforeIdentity, finalIdentity)
      || !sameFileIdentity(finalIdentity, privateFileIdentity(afterPath))
    ) throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
    return {
      path: filePath,
      value: bytes,
      sha256: sha256(bytes),
      identity: finalIdentity,
      handle,
    };
  } catch (error) {
    bytes?.fill(0);
    let closeFailed = false;
    if (handle) {
      try {
        await closeFileHandleExact(handle);
      } catch {
        closeFailed = true;
      }
    }
    if (closeFailed) throw new PostgresLogicalBackupLoginError("cleanup_failed");
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
  }
}

async function closeFileHandleExact(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Retry only to release the descriptor; the first ambiguity remains fatal.
    await handle.close().catch(() => undefined);
    throw new PostgresLogicalBackupLoginError("cleanup_failed");
  }
}

async function closeHeldStablePrivateFile(file: HeldStablePrivateFile): Promise<void> {
  file.value.fill(0);
  await closeFileHandleExact(file.handle);
}

async function readStablePrivateFile(
  filePathInput: string,
  expectedUid: number,
  maximumBytes = MAX_PRIVATE_FILE_BYTES,
): Promise<StablePrivateFile> {
  const held = await openStablePrivateFile(filePathInput, expectedUid, maximumBytes);
  try {
    await closeFileHandleExact(held.handle);
  } catch {
    held.value.fill(0);
    throw new PostgresLogicalBackupLoginError("cleanup_failed");
  }
  return {
    path: held.path,
    value: held.value,
    sha256: held.sha256,
    identity: held.identity,
  };
}

async function assertStablePrivateFileUnchanged(
  expected: StablePrivateFile,
  expectedUid: number,
): Promise<void> {
  if ("handle" in expected) {
    const held = expected as HeldStablePrivateFile;
    try {
      const descriptor = await held.handle.stat({ bigint: true });
      const current = await fs.promises.lstat(held.path, { bigint: true });
      assertPrivateFileStat(descriptor, BigInt(expectedUid), held.value.length);
      assertPrivateFileStat(current, BigInt(expectedUid), held.value.length);
      if (
        !sameFileIdentity(held.identity, privateFileIdentity(descriptor))
        || !sameFileIdentity(held.identity, privateFileIdentity(current))
      ) throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
      const reread = Buffer.alloc(held.value.length);
      try {
        let offset = 0;
        while (offset < reread.length) {
          const result = await held.handle.read(reread, offset, reread.length - offset, offset);
          if (result.bytesRead === 0) {
            throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
          }
          offset += result.bytesRead;
        }
        const eof = Buffer.alloc(1);
        const extra = await held.handle.read(eof, 0, 1, reread.length);
        eof.fill(0);
        if (extra.bytesRead !== 0 || !reread.equals(held.value)) {
          throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
        }
      } finally {
        reread.fill(0);
      }
      const afterDescriptor = await held.handle.stat({ bigint: true });
      const afterPath = await fs.promises.lstat(held.path, { bigint: true });
      if (
        !sameFileIdentity(held.identity, privateFileIdentity(afterDescriptor))
        || !sameFileIdentity(held.identity, privateFileIdentity(afterPath))
      ) throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
      return;
    } catch (error) {
      if (error instanceof PostgresLogicalBackupLoginError) throw error;
      throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
    }
  }
  const actual = await readStablePrivateFile(expected.path, expectedUid, expected.value.length)
    .catch((error) => {
      if (error instanceof PostgresLogicalBackupLoginError && error.code === "cleanup_failed") {
        throw error;
      }
      return null;
    });
  try {
    if (
      !actual
      || !sameFileIdentity(expected.identity, actual.identity)
      || actual.sha256 !== expected.sha256
      || !actual.value.equals(expected.value)
    ) throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
  } finally {
    actual?.value.fill(0);
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

function parseSafeAdminUrl(value: string): SafeAdminConnection {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_url");
  }
  const entries = [...parsed.searchParams.entries()];
  const sslEntries = entries.filter(([key]) => key === "sslmode");
  const hostname = parsed.hostname.toLowerCase();
  const normalizedHost = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const port = Number(parsed.port || "5432");
  const database = decodeUrlComponent(parsed.pathname.startsWith("/")
    ? parsed.pathname.slice(1)
    : "");
  const username = decodeUrlComponent(parsed.username);
  const password = decodeUrlComponent(parsed.password);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !hostname
    || hostname.includes("pooler")
    || hostname.includes("pgbouncer")
    || hostname.includes("pgpool")
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
    || entries.length !== 1
    || sslEntries.length !== 1
    || sslEntries[0]?.[1] !== "verify-full"
  ) throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_url");
  return {
    urlSha256: sha256(value),
    protocol: parsed.protocol as "postgres:" | "postgresql:",
    host: normalizedHost,
    port,
    database,
    username,
    password,
  };
}

function postgresConnectionConfig(
  admin: SafeAdminConnection,
  transport: PostgresRailwayStockLocalhostCaTransport,
  user: string,
  password: string,
  applicationName: string,
): PostgresLogicalBackupLoginConnectionConfig {
  return {
    host: transport.nodeConnection.host,
    port: transport.nodeConnection.port,
    database: admin.database,
    user,
    password,
    ssl: transport.nodeConnection.ssl,
    application_name: applicationName,
    connectionTimeoutMillis: 15_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  };
}

function parseLibraryList(value: string): string[] {
  if (!value.trim()) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).sort();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new PostgresLogicalBackupLoginError("source_authority_invalid");
  }
  return `"${value}"`;
}

function quoteServerIdentifier(value: string): string {
  if (!value || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new PostgresLogicalBackupLoginError("source_authority_invalid");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function sourceIdentitySha256(identity: Omit<SourceIdentity, "databaseIdentitySha256" | "adminRole">): string {
  return canonicalSha256({
    kind: "pintpath-postgres-logical-source-database",
    version: 1,
    systemIdentifier: identity.systemIdentifier,
    databaseOid: identity.databaseOid,
    databaseName: identity.databaseName,
    serverVersionNum: identity.serverVersionNum,
  });
}

export function createPostgresLogicalBackupLoginScramVerifier(
  password: string,
  salt: Buffer,
): string {
  if (!/^[A-Za-z0-9_-]{64}$/.test(password) || salt.byteLength !== SCRAM_SALT_BYTES) {
    throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
  const passwordBytes = Buffer.from(password, "utf8");
  let saltedPassword: Buffer | null = null;
  let clientKey: Buffer | null = null;
  let storedKey: Buffer | null = null;
  let serverKey: Buffer | null = null;
  try {
    saltedPassword = crypto.pbkdf2Sync(
      passwordBytes,
      salt,
      SCRAM_ITERATIONS,
      32,
      "sha256",
    );
    clientKey = crypto.createHmac("sha256", saltedPassword).update("Client Key").digest();
    storedKey = crypto.createHash("sha256").update(clientKey).digest();
    serverKey = crypto.createHmac("sha256", saltedPassword).update("Server Key").digest();
    const verifier = `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
    if (!SCRAM_VERIFIER_PATTERN.test(verifier)) {
      throw new PostgresLogicalBackupLoginError("mutation_failed");
    }
    return verifier;
  } finally {
    passwordBytes.fill(0);
    saltedPassword?.fill(0);
    clientKey?.fill(0);
    storedKey?.fill(0);
    serverKey?.fill(0);
  }
}

function mutationArmInput(options: PostgresLogicalBackupLoginManagerOptions): Record<string, unknown> {
  return {
    schemaVersion: MANAGER_SCHEMA_VERSION,
    kind: "pintpath-postgres-logical-backup-login-mutation-arm",
    operation: options.operation,
    expectedEnvironment: options.expectedEnvironment,
    expectedAdminUrlSha256: options.expectedAdminUrlSha256,
    transportProfile: options.transportProfile,
    rootCaFile: options.rootCaFile,
    rootCaDerSha256: options.expectedRootCaDerSha256,
    expectedDatabaseIdentitySha256: options.expectedDatabaseIdentitySha256,
    expectedHeadSha: options.expectedHeadSha,
    expectedTreeSha: options.expectedTreeSha,
    expectedUid: options.expectedUid,
    expectedNodeVersion: options.expectedNodeVersion,
    operationId: options.operationId,
    approvalReference: options.approvalReference,
    loginVersion: options.loginVersion,
    escrowDirectory: options.escrowDirectory,
    receiptFile: options.receiptFile,
    provisionReceiptFile: options.provisionReceiptFile ?? null,
    expectedProvisionReceiptSha256: options.expectedProvisionReceiptSha256 ?? null,
  };
}

export function postgresLogicalBackupLoginMutationArm(
  options: PostgresLogicalBackupLoginManagerOptions,
): string {
  validateOptions(options);
  return canonicalSha256(mutationArmInput(options));
}

function validateOptions(
  options: PostgresLogicalBackupLoginManagerOptions,
  paths = true,
): void {
  if (
    !["provision", "retire"].includes(options.operation)
    || !SHA256_PATTERN.test(options.expectedAdminUrlSha256)
    || options.transportProfile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE
    || !SHA256_PATTERN.test(options.expectedRootCaDerSha256)
    || !SHA256_PATTERN.test(options.expectedDatabaseIdentitySha256)
    || !GIT_SHA1_PATTERN.test(options.expectedHeadSha)
    || !GIT_SHA1_PATTERN.test(options.expectedTreeSha)
    || !Number.isSafeInteger(options.expectedUid)
    || options.expectedUid < 0
    || !NODE_VERSION_PATTERN.test(options.expectedNodeVersion)
    || options.expectedEnvironment !== POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT
    || !OPERATION_ID_PATTERN.test(options.operationId)
    || !APPROVAL_REFERENCE_PATTERN.test(options.approvalReference)
    || !LOGIN_VERSION_PATTERN.test(options.loginVersion)
    || (options.operation === "provision"
      && (options.provisionReceiptFile !== undefined
        || options.expectedProvisionReceiptSha256 !== undefined))
    || (options.operation === "retire"
      && (!options.provisionReceiptFile
        || !options.expectedProvisionReceiptSha256
        || !SHA256_PATTERN.test(options.expectedProvisionReceiptSha256)))
  ) throw new PostgresLogicalBackupLoginError("invalid_arguments");
  if (paths) {
    exactAbsolutePath(options.adminConnectionFile);
    exactAbsolutePath(options.rootCaFile);
    exactAbsolutePath(options.escrowDirectory);
    exactAbsolutePath(options.receiptFile);
    if (options.provisionReceiptFile) exactAbsolutePath(options.provisionReceiptFile);
    const pathValues = [
      options.adminConnectionFile,
      options.rootCaFile,
      options.escrowDirectory,
      options.receiptFile,
      ...(options.provisionReceiptFile ? [options.provisionReceiptFile] : []),
    ];
    if (new Set(pathValues).size !== pathValues.length) {
      throw new PostgresLogicalBackupLoginError("invalid_arguments");
    }
    if (
      options.adminConnectionFile.startsWith(`${options.escrowDirectory}${path.sep}`)
      || options.rootCaFile.startsWith(`${options.escrowDirectory}${path.sep}`)
      || options.receiptFile.startsWith(`${options.escrowDirectory}${path.sep}`)
      || options.provisionReceiptFile?.startsWith(`${options.escrowDirectory}${path.sep}`)
    ) throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
}

async function runBoundedGit(
  root: string,
  args: readonly string[],
  allowExitOne = false,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/git", [...args], {
      cwd: root,
      shell: false,
      env: {
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      clearTimeout(timer);
      reject(new PostgresLogicalBackupLoginError("host_gate_failed"));
    };
    const timer = setTimeout(fail, 10_000);
    const append = (target: Buffer[], value: Buffer | string, current: number): number => {
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const next = current + buffer.byteLength;
      if (next > 16 * 1024) {
        fail();
        return current;
      }
      target.push(buffer);
      return next;
    };
    child.stdout.on("data", (value: Buffer | string) => {
      stdoutBytes = append(stdout, value, stdoutBytes);
    });
    child.stderr.on("data", (value: Buffer | string) => {
      stderrBytes = append(stderr, value, stderrBytes);
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (
        signal
        || code === null
        || (code !== 0 && !(allowExitOne && code === 1))
        || stderrBytes !== 0
      ) {
        reject(new PostgresLogicalBackupLoginError("host_gate_failed"));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"), exitCode: code });
    });
  });
}

async function gitConfigValue(root: string, name: string): Promise<string | null> {
  const result = await runBoundedGit(root, ["config", "--get", name], true);
  return result.exitCode === 1 ? null : result.stdout.trim();
}

async function inspectRepositoryDefault(
  rootInput: string,
): Promise<PostgresLogicalBackupLoginRepositoryIdentity> {
  const root = await fs.promises.realpath(exactAbsolutePath(rootInput));
  const [top, head, tree, upstream, status, repositoryFormat, bare, hooks, fsmonitor] =
    await Promise.all([
      runBoundedGit(root, ["rev-parse", "--show-toplevel"]),
      runBoundedGit(root, ["rev-parse", "HEAD"]),
      runBoundedGit(root, ["rev-parse", "HEAD^{tree}"]),
      runBoundedGit(root, ["rev-parse", "@{upstream}"]),
      runBoundedGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
      gitConfigValue(root, "core.repositoryformatversion"),
      gitConfigValue(root, "core.bare"),
      gitConfigValue(root, "core.hooksPath"),
      gitConfigValue(root, "core.fsmonitor"),
    ]);
  return {
    headSha: head.stdout.trim(),
    treeSha: tree.stdout.trim(),
    upstreamSha: upstream.stdout.trim(),
    clean: status.stdout.length === 0,
    root: (await fs.promises.realpath(top.stdout.trim())),
    coreRepositoryFormatVersion: repositoryFormat ?? "0",
    coreBare: bare ?? "false",
    hooksPathAbsent: hooks === null,
    fsmonitorAbsentOrFalse: fsmonitor === null || fsmonitor === "false",
  };
}

class DirectClientConnection implements PostgresLogicalBackupLoginConnection {
  private method: "scram-sha-256" | "other" | "unknown" = "unknown";
  private fatal = false;

  private constructor(private readonly client: Client) {}

  static async connect(
    config: PostgresLogicalBackupLoginConnectionConfig,
  ): Promise<DirectClientConnection> {
    const client = new Client(config);
    const result = new DirectClientConnection(client);
    // node-postgres emits post-connect socket/backend failures on Client#error.
    // Install this before connect and retain only a non-secret fixed state so a
    // transport loss can never become an uncaught raw Error or stack trace.
    client.on("error", () => { result.fatal = true; });
    const connection = (client as unknown as {
      connection?: { on: (name: string, listener: () => void) => void };
    }).connection;
    connection?.on("authenticationSASL", () => { result.method = "scram-sha-256"; });
    connection?.on("authenticationSASLContinue", () => { result.method = "scram-sha-256"; });
    for (const event of ["authenticationCleartextPassword", "authenticationMD5Password"]) {
      connection?.on(event, () => { result.method = "other"; });
    }
    try {
      await client.connect();
      if (result.fatal) {
        throw new PostgresLogicalBackupLoginError("source_authority_invalid");
      }
      return result;
    } catch {
      try {
        await client.end();
      } catch {
        throw new PostgresLogicalBackupLoginError("cleanup_failed");
      }
      throw new PostgresLogicalBackupLoginError("source_authority_invalid");
    }
  }

  get authenticationMethod(): "scram-sha-256" | "other" | "unknown" {
    return this.method;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    if (this.fatal) {
      throw new PostgresLogicalBackupLoginError("source_authority_invalid");
    }
    try {
      const result = await this.client.query<Row>(text, [...values]);
      if (this.fatal) {
        throw new PostgresLogicalBackupLoginError("source_authority_invalid");
      }
      return { rows: result.rows, rowCount: result.rowCount };
    } catch {
      throw new PostgresLogicalBackupLoginError(
        this.fatal ? "source_authority_invalid" : "mutation_failed",
      );
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.end();
    } catch {
      this.fatal = true;
      throw new PostgresLogicalBackupLoginError("cleanup_failed");
    }
  }
}

const DEFAULT_DEPENDENCIES: PostgresLogicalBackupLoginDependencies = {
  env: process.env,
  getUid: () => process.getuid?.() ?? null,
  getEuid: () => process.geteuid?.() ?? null,
  nodeVersion: process.version,
  now: () => new Date(),
  randomBytes: (size) => crypto.randomBytes(size),
  repositoryRoot: path.resolve("."),
  inspectRepository: inspectRepositoryDefault,
  connect: DirectClientConnection.connect,
  openTransport: (options) => openPostgresRailwayStockLocalhostCaTransport(options),
};

function transportBindingIsExact(
  transport: PostgresRailwayStockLocalhostCaTransport,
  options: PostgresLogicalBackupLoginManagerOptions,
  admin: SafeAdminConnection,
): boolean {
  return transport.profile === options.transportProfile
    && transport.rootCaDerSha256 === options.expectedRootCaDerSha256
    && transport.sourceUrlAuthority.hostname === admin.host
    && transport.sourceUrlAuthority.port === admin.port
    && transport.nodeConnection.host === transport.resolvedAddress
    && transport.nodeConnection.port === 5_432
    && transport.nodeConnection.ssl.servername === "localhost"
    && transport.nodeConnection.ssl.rejectUnauthorized === true
    && transport.nodeConnection.ssl.minVersion === "TLSv1.2"
    && typeof transport.nodeConnection.ssl.ca === "string"
    && transport.nodeConnection.ssl.ca.length > 0
    && typeof transport.nodeConnection.ssl.checkServerIdentity === "function";
}

async function assertTransportExact(
  transport: PostgresRailwayStockLocalhostCaTransport,
  options: PostgresLogicalBackupLoginManagerOptions,
  admin: SafeAdminConnection,
): Promise<void> {
  if (!transportBindingIsExact(transport, options, admin)) {
    throw new PostgresLogicalBackupLoginError("source_authority_invalid");
  }
  try {
    await transport.assertExact();
  } catch {
    throw new PostgresLogicalBackupLoginError("source_authority_invalid");
  }
}

async function closeTransportExact(
  transport: PostgresRailwayStockLocalhostCaTransport,
): Promise<void> {
  try {
    await transport.close();
  } catch {
    throw new PostgresLogicalBackupLoginError("cleanup_failed");
  }
}

async function closeConnectionExact(
  connection: PostgresLogicalBackupLoginConnection,
): Promise<void> {
  try {
    await connection.close();
  } catch {
    throw new PostgresLogicalBackupLoginError("cleanup_failed");
  }
}

async function validateHostGates(
  options: PostgresLogicalBackupLoginManagerOptions,
  dependencies: PostgresLogicalBackupLoginDependencies,
): Promise<HostGateResult> {
  const uid = dependencies.getUid();
  const euid = dependencies.getEuid();
  const mutationArm = postgresLogicalBackupLoginMutationArm(options);
  if (
    uid === null
    || euid === null
    || uid !== euid
    || uid !== options.expectedUid
    || dependencies.nodeVersion !== options.expectedNodeVersion
    || dependencies.env.NODE_ENV !== "production"
    || dependencies.env[POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT_ENV]
      !== options.expectedEnvironment
    || dependencies.env[POSTGRES_LOGICAL_BACKUP_LOGIN_OPERATION_ENV] !== options.operation
    || dependencies.env[POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION_ENV] !== mutationArm
    || FORBIDDEN_ENVIRONMENT_KEYS.some((key) => dependencies.env[key] !== undefined)
    || Object.entries(dependencies.env).some(([key, value]) =>
      value !== undefined && /^PG[A-Z0-9_]*$/.test(key))
  ) throw new PostgresLogicalBackupLoginError("host_gate_failed");
  const repository = await dependencies.inspectRepository(dependencies.repositoryRoot)
    .catch(() => { throw new PostgresLogicalBackupLoginError("host_gate_failed"); });
  if (
    !GIT_SHA1_PATTERN.test(repository.headSha)
    || !GIT_SHA1_PATTERN.test(repository.treeSha)
    || repository.headSha !== options.expectedHeadSha
    || repository.treeSha !== options.expectedTreeSha
    || repository.upstreamSha !== repository.headSha
    || !repository.clean
    || await fs.promises.realpath(dependencies.repositoryRoot) !== repository.root
    || repository.coreRepositoryFormatVersion !== "0"
    || repository.coreBare !== "false"
    || !repository.hooksPathAbsent
    || !repository.fsmonitorAbsentOrFalse
  ) throw new PostgresLogicalBackupLoginError("host_gate_failed");
  return { repository, mutationArm };
}

function assertTrustedPrivateDirectory(stat: fs.BigIntStats, expectedUid: bigint): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== expectedUid
    || stat.nlink < 1n
    || Number(stat.mode & 0o7777n) !== 0o700
  ) throw new PostgresLogicalBackupLoginError("escrow_invalid");
}

async function openTrustedPrivateDirectory(
  directoryInput: string,
  expectedUid: number,
): Promise<{ path: string; handle: FileHandle; identity: DirectoryIdentity }> {
  const directory = exactAbsolutePath(directoryInput);
  let handle: FileHandle | null = null;
  try {
    if (await fs.promises.realpath(directory) !== directory) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    const before = await fs.promises.lstat(directory, { bigint: true });
    assertTrustedPrivateDirectory(before, BigInt(expectedUid));
    // The O_NOFOLLOW directory descriptor is bound to the lstat identity and
    // remains held for every child operation using this authority.
    // codeql[js/file-system-race]
    handle = await fs.promises.open(
      directory,
      fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY ?? 0)
        | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    assertTrustedPrivateDirectory(opened, BigInt(expectedUid));
    const identity = directoryIdentity(before);
    if (!sameDirectoryIdentity(identity, directoryIdentity(opened))) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    return { path: directory, handle, identity };
  } catch (error) {
    if (handle) {
      try {
        await closeFileHandleExact(handle);
      } catch {
        throw new PostgresLogicalBackupLoginError("cleanup_failed");
      }
    }
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
}

async function assertDirectoryStillExact(
  trusted: { path: string; handle: FileHandle; identity: DirectoryIdentity },
  expectedUid: number,
): Promise<void> {
  const descriptor = await trusted.handle.stat({ bigint: true });
  const current = await fs.promises.lstat(trusted.path, { bigint: true });
  assertTrustedPrivateDirectory(descriptor, BigInt(expectedUid));
  assertTrustedPrivateDirectory(current, BigInt(expectedUid));
  if (
    !sameDirectoryIdentity(trusted.identity, directoryIdentity(descriptor))
    || !sameDirectoryIdentity(trusted.identity, directoryIdentity(current))
    || await fs.promises.realpath(trusted.path) !== trusted.path
  ) throw new PostgresLogicalBackupLoginError("escrow_invalid");
}

async function writeExactPrivateLeaf(
  filePath: string,
  bytes: Buffer,
  expectedUid: number,
): Promise<HeldStablePrivateFile> {
  let handle: FileHandle | null = null;
  let createdIdentity: PrivateFileIdentity | null = null;
  let verified: Buffer | null = null;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_RDWR
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const created = await handle.stat({ bigint: true });
    assertPrivateFileStat(created, BigInt(expectedUid), MAX_PRIVATE_FILE_BYTES, true);
    createdIdentity = privateFileIdentity(created);
    let writeOffset = 0;
    while (writeOffset < bytes.length) {
      const written = await handle.write(
        bytes,
        writeOffset,
        bytes.length - writeOffset,
        writeOffset,
      );
      if (written.bytesWritten === 0) throw new PostgresLogicalBackupLoginError("escrow_invalid");
      writeOffset += written.bytesWritten;
    }
    await handle.chmod(0o600);
    await handle.sync();
    const opened = await handle.stat({ bigint: true });
    const current = await fs.promises.lstat(filePath, { bigint: true });
    assertPrivateFileStat(opened, BigInt(expectedUid), MAX_PRIVATE_FILE_BYTES);
    assertPrivateFileStat(current, BigInt(expectedUid), MAX_PRIVATE_FILE_BYTES);
    if (
      opened.size !== BigInt(bytes.length)
      || opened.dev !== createdIdentity.dev
      || opened.ino !== createdIdentity.ino
      || current.dev !== opened.dev
      || current.ino !== opened.ino
    ) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    verified = Buffer.alloc(bytes.length);
    let readOffset = 0;
    while (readOffset < verified.length) {
      const read = await handle.read(verified, readOffset, verified.length - readOffset, readOffset);
      if (read.bytesRead === 0) throw new PostgresLogicalBackupLoginError("escrow_invalid");
      readOffset += read.bytesRead;
    }
    const eof = Buffer.alloc(1);
    const extra = await handle.read(eof, 0, 1, verified.length);
    eof.fill(0);
    if (extra.bytesRead !== 0 || !verified.equals(bytes)) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    const finalStat = await handle.stat({ bigint: true });
    const finalPath = await fs.promises.lstat(filePath, { bigint: true });
    assertPrivateFileStat(finalStat, BigInt(expectedUid), MAX_PRIVATE_FILE_BYTES);
    assertPrivateFileStat(finalPath, BigInt(expectedUid), MAX_PRIVATE_FILE_BYTES);
    const identity = privateFileIdentity(finalStat);
    if (!sameFileIdentity(identity, privateFileIdentity(finalPath))) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    return {
      path: filePath,
      value: verified,
      sha256: sha256(verified),
      identity,
      handle,
    };
  } catch (error) {
    verified?.fill(0);
    let cleanupFailed = false;
    if (handle) {
      if (!createdIdentity) {
        try {
          const recovered = await handle.stat({ bigint: true });
          if (
            !recovered.isFile()
            || recovered.uid !== BigInt(expectedUid)
            || recovered.nlink < 1n
          ) {
            cleanupFailed = recovered.nlink !== 0n;
          } else {
            createdIdentity = privateFileIdentity(recovered);
          }
        } catch {
          cleanupFailed = true;
        }
      }
      if (createdIdentity && !await unlinkExactHeldLeaf(
        filePath,
        handle,
        createdIdentity,
        expectedUid,
      )) {
        cleanupFailed = true;
      }
      try {
        await closeFileHandleExact(handle);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new PostgresLogicalBackupLoginError("cleanup_failed");
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
}

async function unlinkExactHeldLeaf(
  filePath: string,
  handle: FileHandle,
  identity: PrivateFileIdentity,
  expectedUid: number,
  expectedLinksBefore = 1n,
  remainingPath: string | null = null,
): Promise<boolean> {
  try {
    // Node has no unlinkat-by-directory-fd API. The containing directory is
    // current-UID/mode-0700; within that authority we retain the leaf fd,
    // reject any replacement already visible at lstat, and prove the retained
    // inode's link count changed after unlink. Any ambiguity is cleanup_failed.
    const opened = await handle.stat({ bigint: true });
    const stat = await fs.promises.lstat(filePath, { bigint: true });
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.uid !== BigInt(expectedUid)
      || stat.dev !== identity.dev
      || stat.ino !== identity.ino
      || !opened.isFile()
      || opened.uid !== BigInt(expectedUid)
      || opened.dev !== identity.dev
      || opened.ino !== identity.ino
      || opened.nlink !== expectedLinksBefore
      || stat.nlink !== opened.nlink
    ) return false;
    const beforeLinks = opened.nlink;
    await fs.promises.unlink(filePath);
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== identity.dev
      || after.ino !== identity.ino
      || after.nlink !== beforeLinks - 1n
    ) return false;
    const removedPathAbsent = await fs.promises.lstat(filePath).then(
      () => false,
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    if (!removedPathAbsent) return false;
    if (after.nlink === 0n) return remainingPath === null;
    if (after.nlink !== 1n || !remainingPath) return false;
    const remaining = await fs.promises.lstat(remainingPath, { bigint: true });
    return remaining.isFile()
      && !remaining.isSymbolicLink()
      && remaining.uid === BigInt(expectedUid)
      && remaining.dev === identity.dev
      && remaining.ino === identity.ino
      && remaining.nlink === 1n
      && after.dev === identity.dev
      && after.ino === identity.ino
      && after.nlink === 1n;
  } catch (error) {
    return false;
  }
}

async function removeOwnedTemporaryEscrow(
  directoryPath: string,
  identity: DirectoryIdentity,
  leaves: readonly HeldStablePrivateFile[],
  expectedUid: number,
): Promise<boolean> {
  let exact = true;
  for (const leaf of leaves) {
    if (!await unlinkExactHeldLeaf(leaf.path, leaf.handle, leaf.identity, expectedUid)) exact = false;
    leaf.value.fill(0);
    try {
      await closeFileHandleExact(leaf.handle);
    } catch {
      exact = false;
    }
  }
  try {
    const stat = await fs.promises.lstat(directoryPath, { bigint: true });
    if (!sameDirectoryIdentity(identity, directoryIdentity(stat))) return false;
    if ((await fs.promises.readdir(directoryPath)).length !== 0) return false;
    await fs.promises.rmdir(directoryPath);
    return exact;
  } catch {
    return false;
  }
}

async function writeExclusivePrivateFile(
  filePathInput: string,
  value: unknown,
  expectedUid: number,
  trustedParent?: TrustedPrivateDirectory,
): Promise<{ sha256: string; file: StablePrivateFile }> {
  const filePath = exactAbsolutePath(filePathInput);
  const ownsParent = trustedParent === undefined;
  const parent = trustedParent
    ?? await openTrustedPrivateDirectory(path.dirname(filePath), expectedUid);
  let temporaryPath = "";
  let bytes: Buffer | null = null;
  let temporary: HeldStablePrivateFile | null = null;
  let linked = false;
  let temporaryUnlinked = false;
  let cleanupFailed = false;
  let resultFile: StablePrivateFile | null = null;
  try {
    if (parent.path !== path.dirname(filePath)) {
      throw new PostgresLogicalBackupLoginError("receipt_invalid");
    }
    temporaryPath = path.join(
      parent.path,
      `.pintpath-login-manager-${crypto.randomBytes(16).toString("hex")}.tmp`,
    );
    bytes = Buffer.from(canonicalPostgresBackupJson(value), "utf8");
    await assertDirectoryStillExact(parent, expectedUid);
    if (await fs.promises.lstat(filePath).then(() => true).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    })) throw new PostgresLogicalBackupLoginError("receipt_invalid");
    temporary = await writeExactPrivateLeaf(temporaryPath, bytes, expectedUid);
    await assertDirectoryStillExact(parent, expectedUid);
    try {
      await fs.promises.link(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PostgresLogicalBackupLoginError("receipt_invalid");
      }
      const descriptor = await temporary.handle.stat({ bigint: true }).catch(() => null);
      const final = await fs.promises.lstat(filePath, { bigint: true }).catch(() => null);
      if (
        descriptor
        && final
        && descriptor.dev === temporary.identity.dev
        && descriptor.ino === temporary.identity.ino
        && descriptor.nlink === 2n
        && final.dev === descriptor.dev
        && final.ino === descriptor.ino
      ) linked = true;
      throw error;
    }
    linked = true;
    const linkedDescriptor = await temporary.handle.stat({ bigint: true });
    const linkedTemporary = await fs.promises.lstat(temporaryPath, { bigint: true });
    const linkedFinal = await fs.promises.lstat(filePath, { bigint: true });
    if (
      linkedDescriptor.dev !== temporary.identity.dev
      || linkedDescriptor.ino !== temporary.identity.ino
      || linkedDescriptor.nlink !== 2n
      || linkedTemporary.dev !== linkedDescriptor.dev
      || linkedTemporary.ino !== linkedDescriptor.ino
      || linkedFinal.dev !== linkedDescriptor.dev
      || linkedFinal.ino !== linkedDescriptor.ino
    ) throw new PostgresLogicalBackupLoginError("receipt_invalid");
    if (!await unlinkExactHeldLeaf(
      temporaryPath,
      temporary.handle,
      temporary.identity,
      expectedUid,
      2n,
      filePath,
    )) throw new PostgresLogicalBackupLoginError("cleanup_failed");
    temporaryUnlinked = true;
    await parent.handle.sync();
    await assertDirectoryStillExact(parent, expectedUid);
    const finalDescriptor = await temporary.handle.stat({ bigint: true });
    const finalPath = await fs.promises.lstat(filePath, { bigint: true });
    if (
      finalDescriptor.nlink !== 1n
      || finalDescriptor.dev !== temporary.identity.dev
      || finalDescriptor.ino !== temporary.identity.ino
      || finalPath.dev !== finalDescriptor.dev
      || finalPath.ino !== finalDescriptor.ino
    ) throw new PostgresLogicalBackupLoginError("receipt_invalid");
    const result = await readStablePrivateFile(filePath, expectedUid, MAX_PRIVATE_FILE_BYTES);
    resultFile = result;
    if (
      !result.value.equals(bytes)
      || !sameFileIdentity(result.identity, privateFileIdentity(finalDescriptor))
    ) {
      result.value.fill(0);
      throw new PostgresLogicalBackupLoginError("receipt_invalid");
    }
    temporary.value.fill(0);
    try {
      await closeFileHandleExact(temporary.handle);
    } catch {
      result.value.fill(0);
      throw new PostgresLogicalBackupLoginError("cleanup_failed");
    }
    temporary = null;
    return { sha256: sha256(bytes), file: result };
  } catch (error) {
    if (linked) cleanupFailed = true;
    if (temporary) {
      if (!temporaryUnlinked) {
        const unlinked = await unlinkExactHeldLeaf(
          temporaryPath,
          temporary.handle,
          temporary.identity,
          expectedUid,
          linked ? 2n : 1n,
          linked ? filePath : null,
        );
        if (!unlinked) cleanupFailed = true;
      }
      temporary.value.fill(0);
      try {
        await closeFileHandleExact(temporary.handle);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new PostgresLogicalBackupLoginError("cleanup_failed");
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("receipt_invalid");
  } finally {
    temporary?.value.fill(0);
    bytes?.fill(0);
    if (ownsParent) {
      try {
        await closeFileHandleExact(parent.handle);
      } catch {
        resultFile?.value.fill(0);
        throw new PostgresLogicalBackupLoginError("cleanup_failed");
      }
    }
  }
}

function canonicalTimestamp(now: () => Date): string {
  let value: string;
  try {
    value = now().toISOString();
  } catch {
    throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
  return value;
}

function scopedGroupRole(databaseOid: string): string {
  if (!DATABASE_OID_PATTERN.test(databaseOid) || !exactOid(databaseOid)) {
    throw new PostgresLogicalBackupLoginError("source_identity_mismatch");
  }
  return `${ROLE_PREFIX}${databaseOid}`;
}

function versionedLoginRole(databaseOid: string, version: string): string {
  if (!LOGIN_VERSION_PATTERN.test(version)) {
    throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
  const value = `${scopedGroupRole(databaseOid)}_v${version}`;
  if (value.length > 63) throw new PostgresLogicalBackupLoginError("invalid_arguments");
  return value;
}

function encodeConnectionUrl(
  admin: SafeAdminConnection,
  loginRole: string,
  password: string,
): string {
  const host = admin.host.includes(":") ? `[${admin.host}]` : admin.host;
  return `${admin.protocol}//${encodeURIComponent(loginRole)}:${encodeURIComponent(password)}`
    + `@${host}:${admin.port}/${encodeURIComponent(admin.database)}?sslmode=verify-full`;
}

function parseProvisionIntent(value: Buffer): ProvisionIntent {
  let parsed: unknown;
  const text = value.toString("utf8");
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
  if (!isRecord(parsed) || canonicalPostgresBackupJson(parsed) !== text) {
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
  const expectedKeys = [
    "schemaVersion", "kind", "createdAt", "operationId", "approvalReference",
    "expectedEnvironment", "executorUid", "mutationArm", "headSha", "treeSha",
    "nodeVersion", "adminUrlSha256", "transportProfile", "rootCaDerSha256",
    "databaseIdentitySha256", "databaseOid", "databaseNameSha256", "loginVersion",
    "loginRole", "groupRole", "escrowUrlSha256", "scramSaltBase64",
    "scramVerifierSha256", "loggerInventorySha256",
  ] as const;
  if (
    !exactKeys(parsed, expectedKeys)
    || parsed.schemaVersion !== MANAGER_SCHEMA_VERSION
    || parsed.kind !== "pintpath-postgres-logical-backup-login-provision-intent"
    || !exactTimestamp(parsed.createdAt)
    || !OPERATION_ID_PATTERN.test(String(parsed.operationId))
    || !APPROVAL_REFERENCE_PATTERN.test(String(parsed.approvalReference))
    || parsed.expectedEnvironment !== POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT
    || !Number.isSafeInteger(parsed.executorUid)
    || Number(parsed.executorUid) < 0
    || !SHA256_PATTERN.test(String(parsed.mutationArm))
    || !GIT_SHA1_PATTERN.test(String(parsed.headSha))
    || !GIT_SHA1_PATTERN.test(String(parsed.treeSha))
    || !NODE_VERSION_PATTERN.test(String(parsed.nodeVersion))
    || !SHA256_PATTERN.test(String(parsed.adminUrlSha256))
    || parsed.transportProfile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE
    || !SHA256_PATTERN.test(String(parsed.rootCaDerSha256))
    || !SHA256_PATTERN.test(String(parsed.databaseIdentitySha256))
    || !DATABASE_OID_PATTERN.test(String(parsed.databaseOid))
    || !SHA256_PATTERN.test(String(parsed.databaseNameSha256))
    || !LOGIN_VERSION_PATTERN.test(String(parsed.loginVersion))
    || typeof parsed.loginRole !== "string"
    || typeof parsed.groupRole !== "string"
    || !SHA256_PATTERN.test(String(parsed.escrowUrlSha256))
    || !/^[A-Za-z0-9+/]{22}==$/.test(String(parsed.scramSaltBase64))
    || !SHA256_PATTERN.test(String(parsed.scramVerifierSha256))
    || !SHA256_PATTERN.test(String(parsed.loggerInventorySha256))
  ) throw new PostgresLogicalBackupLoginError("escrow_invalid");
  return parsed as unknown as ProvisionIntent;
}

function intentMatches(
  intent: ProvisionIntent,
  options: PostgresLogicalBackupLoginManagerOptions,
  identity: SourceIdentity,
  admin: SafeAdminConnection,
): boolean {
  return intent.operationId === options.operationId
    && intent.approvalReference === options.approvalReference
    && intent.expectedEnvironment === options.expectedEnvironment
    && intent.executorUid === options.expectedUid
    && intent.mutationArm === postgresLogicalBackupLoginMutationArm(options)
    && intent.headSha === options.expectedHeadSha
    && intent.treeSha === options.expectedTreeSha
    && intent.nodeVersion === options.expectedNodeVersion
    && intent.adminUrlSha256 === options.expectedAdminUrlSha256
    && intent.transportProfile === options.transportProfile
    && intent.rootCaDerSha256 === options.expectedRootCaDerSha256
    && intent.databaseIdentitySha256 === options.expectedDatabaseIdentitySha256
    && intent.databaseOid === identity.databaseOid
    && intent.databaseNameSha256 === sha256(identity.databaseName)
    && intent.loginVersion === options.loginVersion
    && intent.loginRole === versionedLoginRole(identity.databaseOid, options.loginVersion)
    && intent.groupRole === scopedGroupRole(identity.databaseOid);
}

async function loadExistingEscrow(
  options: PostgresLogicalBackupLoginManagerOptions,
  identity: SourceIdentity,
  admin: SafeAdminConnection,
): Promise<EscrowBundle | null> {
  const directory = exactAbsolutePath(options.escrowDirectory);
  const stat = await fs.promises.lstat(directory, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  assertTrustedPrivateDirectory(stat, BigInt(options.expectedUid));
  if (await fs.promises.realpath(directory) !== directory) {
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
  const entries = (await fs.promises.readdir(directory)).sort();
  const allowed: readonly string[] = [
    POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE,
    POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
  ];
  if (entries.some((entry) => !allowed.includes(entry))) {
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
  let urlFile: StablePrivateFile | null = null;
  let intentFile: StablePrivateFile | null = null;
  try {
    urlFile = await readStablePrivateFile(
      path.join(directory, POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE),
      options.expectedUid,
      MAX_ADMIN_URL_BYTES,
    );
    intentFile = await readStablePrivateFile(
      path.join(directory, POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE),
      options.expectedUid,
    );
    const intent = parseProvisionIntent(intentFile.value);
    if (!intentMatches(intent, options, identity, admin)) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    const url = urlFile.value.toString("utf8").trim();
    if (urlFile.sha256 !== sha256(`${url}\n`) && urlFile.sha256 !== sha256(url)) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    if (sha256(url) !== intent.escrowUrlSha256) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    const parsed = parseSafeAdminUrl(url);
    if (
      parsed.host !== admin.host
      || parsed.port !== admin.port
      || parsed.database !== admin.database
      || parsed.username !== intent.loginRole
      || parsed.urlSha256 !== intent.escrowUrlSha256
    ) throw new PostgresLogicalBackupLoginError("escrow_invalid");
    const salt = Buffer.from(intent.scramSaltBase64, "base64");
    const verifier = createPostgresLogicalBackupLoginScramVerifier(parsed.password, salt);
    salt.fill(0);
    if (sha256(verifier) !== intent.scramVerifierSha256) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    return {
      directory,
      directoryIdentity: directoryIdentity(stat),
      urlFile,
      intentFile,
      intent,
      password: parsed.password,
      verifier,
    };
  } catch (error) {
    urlFile?.value.fill(0);
    intentFile?.value.fill(0);
    if (error instanceof PostgresLogicalBackupLoginError && error.code === "cleanup_failed") {
      throw error;
    }
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
}

async function createEscrow(
  options: PostgresLogicalBackupLoginManagerOptions,
  identity: SourceIdentity,
  admin: SafeAdminConnection,
  transport: PostgresRailwayStockLocalhostCaTransport,
  loggerInventorySha256: string,
  dependencies: PostgresLogicalBackupLoginDependencies,
): Promise<EscrowBundle> {
  const finalDirectory = exactAbsolutePath(options.escrowDirectory);
  const parent = await openTrustedPrivateDirectory(path.dirname(finalDirectory), options.expectedUid);
  let temporaryDirectory = "";
  let temporaryAuthority: TrustedPrivateDirectory | null = null;
  let temporaryIdentity: DirectoryIdentity | null = null;
  let temporaryDirectoryCreated = false;
  const leaves: HeldStablePrivateFile[] = [];
  let published = false;
  let resultEscrow: EscrowBundle | null = null;
  let passwordBytes: Buffer | null = null;
  let salt: Buffer | null = null;
  let urlBytes: Buffer | null = null;
  let intentBytes: Buffer | null = null;
  try {
    temporaryDirectory = path.join(
      parent.path,
      `.pintpath-login-escrow-${crypto.randomBytes(16).toString("hex")}.tmp`,
    );
    passwordBytes = dependencies.randomBytes(PASSWORD_BYTES);
    salt = dependencies.randomBytes(SCRAM_SALT_BYTES);
    if (passwordBytes.byteLength !== PASSWORD_BYTES || salt.byteLength !== SCRAM_SALT_BYTES) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    const password = passwordBytes.toString("base64url");
    passwordBytes.fill(0);
    const verifier = createPostgresLogicalBackupLoginScramVerifier(password, salt);
    const loginRole = versionedLoginRole(identity.databaseOid, options.loginVersion);
    const groupRole = scopedGroupRole(identity.databaseOid);
    const url = encodeConnectionUrl(admin, loginRole, password);
    const intent: ProvisionIntent = {
      schemaVersion: MANAGER_SCHEMA_VERSION,
      kind: "pintpath-postgres-logical-backup-login-provision-intent",
      createdAt: canonicalTimestamp(dependencies.now),
      operationId: options.operationId,
      approvalReference: options.approvalReference,
      expectedEnvironment: options.expectedEnvironment,
      executorUid: options.expectedUid,
      mutationArm: postgresLogicalBackupLoginMutationArm(options),
      headSha: options.expectedHeadSha,
      treeSha: options.expectedTreeSha,
      nodeVersion: options.expectedNodeVersion,
      adminUrlSha256: options.expectedAdminUrlSha256,
      transportProfile: transport.profile,
      rootCaDerSha256: transport.rootCaDerSha256,
      databaseIdentitySha256: options.expectedDatabaseIdentitySha256,
      databaseOid: identity.databaseOid,
      databaseNameSha256: sha256(identity.databaseName),
      loginVersion: options.loginVersion,
      loginRole,
      groupRole,
      escrowUrlSha256: sha256(url),
      scramSaltBase64: salt.toString("base64"),
      scramVerifierSha256: sha256(verifier),
      loggerInventorySha256,
    };
    salt.fill(0);
    urlBytes = Buffer.from(`${url}\n`, "utf8");
    intentBytes = Buffer.from(canonicalPostgresBackupJson(intent), "utf8");
    const exists = await fs.promises.lstat(finalDirectory).then(() => true).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    if (exists) throw new PostgresLogicalBackupLoginError("escrow_invalid");
    await fs.promises.mkdir(temporaryDirectory, { mode: 0o700, recursive: false });
    temporaryDirectoryCreated = true;
    const created = await fs.promises.lstat(temporaryDirectory, { bigint: true });
    if (
      !created.isDirectory()
      || created.isSymbolicLink()
      || created.uid !== BigInt(options.expectedUid)
      || created.nlink < 1n
    ) throw new PostgresLogicalBackupLoginError("escrow_invalid");
    temporaryIdentity = directoryIdentity(created);
    await fs.promises.chmod(temporaryDirectory, 0o700);
    const secured = await fs.promises.lstat(temporaryDirectory, { bigint: true });
    assertTrustedPrivateDirectory(secured, BigInt(options.expectedUid));
    if (
      secured.dev !== temporaryIdentity.dev
      || secured.ino !== temporaryIdentity.ino
    ) throw new PostgresLogicalBackupLoginError("escrow_invalid");
    temporaryIdentity = directoryIdentity(secured);
    temporaryAuthority = await openTrustedPrivateDirectory(
      temporaryDirectory,
      options.expectedUid,
    );
    const urlFile = await writeExactPrivateLeaf(
      path.join(temporaryDirectory, POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE),
      urlBytes,
      options.expectedUid,
    );
    leaves.push(urlFile);
    const intentFile = await writeExactPrivateLeaf(
      path.join(temporaryDirectory, POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE),
      intentBytes,
      options.expectedUid,
    );
    leaves.push(intentFile);
    await temporaryAuthority.handle.sync();
    await assertDirectoryStillExact(temporaryAuthority, options.expectedUid);
    await assertDirectoryStillExact(parent, options.expectedUid);
    await fs.promises.rename(temporaryDirectory, finalDirectory);
    published = true;
    await parent.handle.sync();
    const publishedDirectory: TrustedPrivateDirectory = {
      ...temporaryAuthority,
      path: finalDirectory,
    };
    await assertDirectoryStillExact(publishedDirectory, options.expectedUid);
    for (const leaf of leaves) {
      const publishedPath = path.join(finalDirectory, path.basename(leaf.path));
      const descriptor = await leaf.handle.stat({ bigint: true });
      const current = await fs.promises.lstat(publishedPath, { bigint: true });
      assertPrivateFileStat(descriptor, BigInt(options.expectedUid), MAX_PRIVATE_FILE_BYTES);
      assertPrivateFileStat(current, BigInt(options.expectedUid), MAX_PRIVATE_FILE_BYTES);
      if (
        descriptor.dev !== leaf.identity.dev
        || descriptor.ino !== leaf.identity.ino
        || current.dev !== descriptor.dev
        || current.ino !== descriptor.ino
      ) throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    const loaded = await loadExistingEscrow(options, identity, admin);
    if (!loaded) throw new PostgresLogicalBackupLoginError("escrow_invalid");
    let closeFailed = false;
    for (const leaf of leaves) {
      leaf.value.fill(0);
      try {
        await closeFileHandleExact(leaf.handle);
      } catch {
        closeFailed = true;
      }
    }
    leaves.splice(0);
    try {
      await closeFileHandleExact(temporaryAuthority.handle);
    } catch {
      closeFailed = true;
    }
    temporaryAuthority = null;
    if (closeFailed) {
      loaded.urlFile.value.fill(0);
      loaded.intentFile.value.fill(0);
      throw new PostgresLogicalBackupLoginError("cleanup_failed");
    }
    resultEscrow = loaded;
    return loaded;
  } catch (error) {
    let cleanupFailed = published;
    if (!published && temporaryAuthority) {
      const removed = await removeOwnedTemporaryEscrow(
        temporaryDirectory,
        temporaryAuthority.identity,
        leaves,
        options.expectedUid,
      );
      if (!removed) cleanupFailed = true;
      if (removed) {
        try {
          await parent.handle.sync();
        } catch {
          cleanupFailed = true;
        }
      }
      leaves.splice(0);
    } else if (!published && temporaryIdentity) {
      try {
        const current = await fs.promises.lstat(temporaryDirectory, { bigint: true });
        if (
          !sameDirectoryIdentity(temporaryIdentity, directoryIdentity(current))
          || (await fs.promises.readdir(temporaryDirectory)).length !== 0
        ) {
          cleanupFailed = true;
        } else {
          await fs.promises.rmdir(temporaryDirectory);
          await parent.handle.sync();
        }
      } catch {
        cleanupFailed = true;
      }
    } else if (!published && temporaryDirectoryCreated) {
      cleanupFailed = true;
    } else {
      for (const leaf of leaves) {
        leaf.value.fill(0);
        try {
          await closeFileHandleExact(leaf.handle);
        } catch {
          cleanupFailed = true;
        }
      }
      leaves.splice(0);
    }
    if (temporaryAuthority) {
      try {
        await closeFileHandleExact(temporaryAuthority.handle);
      } catch {
        cleanupFailed = true;
      }
      temporaryAuthority = null;
    }
    if (cleanupFailed) throw new PostgresLogicalBackupLoginError("cleanup_failed");
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  } finally {
    passwordBytes?.fill(0);
    salt?.fill(0);
    urlBytes?.fill(0);
    intentBytes?.fill(0);
    for (const leaf of leaves) leaf.value.fill(0);
    try {
      await closeFileHandleExact(parent.handle);
    } catch {
      resultEscrow?.urlFile.value.fill(0);
      resultEscrow?.intentFile.value.fill(0);
      throw new PostgresLogicalBackupLoginError("cleanup_failed");
    }
  }
}

interface SourceIdentityRow extends QueryResultRow {
  readonly systemIdentifier: string;
  readonly databaseOid: string;
  readonly databaseName: string;
  readonly serverVersionNum: string;
  readonly adminRole: string;
  readonly currentRole: string;
  readonly adminCanLogin: boolean;
  readonly adminSuperuser: boolean;
  readonly transactionReadOnly: boolean;
  readonly inRecovery: boolean;
}

interface GroupAuthorityRow extends QueryResultRow {
  readonly roleName: string;
  readonly canLogin: boolean;
  readonly hasPassword: boolean;
  readonly validUntilIsNull: boolean;
  readonly inheritsPrivileges: boolean;
  readonly connectionLimit: number;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly parentMembershipCount: number;
  readonly childMembershipCount: number;
  readonly exactChildMembershipCount: number;
  readonly scopedLoginCount: number;
  readonly reservedLoginNamespaceCount: number;
  readonly directDatabasePrivilegeCount: number;
  readonly directFunctionPrivilegeCount: number;
  readonly roleSettingCount: number;
  readonly ownedCurrentDatabaseObjectCount: number;
  readonly sharedDependencyCount: number;
  readonly exactSharedDependencyCount: number;
  readonly privateSchemaCount: number;
  readonly directSchemaPrivilegeCount: number;
  readonly exactSchemaPrivilegeCount: number;
  readonly privateRelationCount: number;
  readonly forceRlsRelationCount: number;
  readonly directRelationPrivilegeCount: number;
  readonly exactRelationPrivilegeCount: number;
  readonly privateSequenceCount: number;
  readonly directColumnPrivilegeCount: number;
  readonly executablePrivateFunctionCount: number;
  readonly privatePolicyCount: number;
  readonly exactBasePolicyCount: number;
  readonly exactBackupPolicyCount: number;
  readonly unsafePublicPolicyCount: number;
  readonly unsafeReservedPolicyCount: number;
  readonly directScopedPolicyCount: number;
}

interface CandidateStateRow extends QueryResultRow {
  readonly oid: string;
  readonly marker: string | null;
  readonly canLogin: boolean;
  readonly hasPassword: boolean;
  readonly inheritsPrivileges: boolean;
  readonly connectionLimit: number;
  readonly validUntilIsNull: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly parentMembershipCount: number;
  readonly childMembershipCount: number;
  readonly exactMembershipCount: number;
  readonly directDatabasePrivilegeCount: number;
  readonly exactDatabasePrivilegeCount: number;
  readonly directFunctionPrivilegeCount: number;
  readonly exactFunctionPrivilegeCount: number;
  readonly directPrivateObjectPrivilegeCount: number;
  readonly ownedPrivateObjectCount: number;
  readonly roleSettingCount: number;
  readonly sharedDependencyCount: number;
  readonly exactSharedDependencyCount: number;
}

async function inspectSourceIdentity(
  connection: PostgresLogicalBackupLoginConnection,
  expectedIdentitySha256: string,
): Promise<SourceIdentity> {
  let result: { rows: SourceIdentityRow[]; rowCount: number | null };
  try {
    result = await connection.query<SourceIdentityRow>(`/* pintpath:backup-login:source-identity */
      SELECT
        control.system_identifier::text AS "systemIdentifier",
        database.oid::text AS "databaseOid",
        pg_catalog.current_database() AS "databaseName",
        pg_catalog.current_setting('server_version_num') AS "serverVersionNum",
        session_user AS "adminRole",
        current_user AS "currentRole",
        administrator.rolcanlogin AS "adminCanLogin",
        administrator.rolsuper AS "adminSuperuser",
        pg_catalog.current_setting('transaction_read_only')::boolean AS "transactionReadOnly",
        pg_catalog.pg_is_in_recovery() AS "inRecovery"
      FROM pg_catalog.pg_database AS database
      JOIN pg_catalog.pg_roles AS administrator
        ON administrator.rolname = session_user
      CROSS JOIN pg_catalog.pg_control_system() AS control
      WHERE database.datname = pg_catalog.current_database()`);
  } catch {
    throw new PostgresLogicalBackupLoginError("source_authority_invalid");
  }
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || !row
    || !SYSTEM_IDENTIFIER_PATTERN.test(row.systemIdentifier)
    || !DATABASE_OID_PATTERN.test(row.databaseOid)
    || !exactOid(row.databaseOid)
    || !row.databaseName
    || row.databaseName.includes("\0")
    || !/^17[0-9]{4}$/.test(row.serverVersionNum)
    || !row.adminRole
    || row.currentRole !== row.adminRole
    || row.adminCanLogin !== true
    || row.adminSuperuser !== true
    || row.transactionReadOnly !== false
    || row.inRecovery !== false
  ) throw new PostgresLogicalBackupLoginError("source_authority_invalid");
  const base = {
    systemIdentifier: row.systemIdentifier,
    databaseOid: row.databaseOid,
    databaseName: row.databaseName,
    serverVersionNum: row.serverVersionNum,
  };
  const databaseIdentitySha256 = sourceIdentitySha256(base);
  if (databaseIdentitySha256 !== expectedIdentitySha256) {
    throw new PostgresLogicalBackupLoginError("source_identity_mismatch");
  }
  return { ...base, databaseIdentitySha256, adminRole: row.adminRole };
}

const GROUP_AUTHORITY_QUERY = `/* pintpath:backup-login:group-authority */
  SELECT
    role.rolname AS "roleName",
    role.rolcanlogin AS "canLogin",
    (authentication.rolpassword IS NOT NULL) AS "hasPassword",
    (role.rolvaliduntil IS NULL) AS "validUntilIsNull",
    role.rolinherit AS "inheritsPrivileges",
    role.rolconnlimit AS "connectionLimit",
    role.rolsuper AS "superuser",
    role.rolcreatedb AS "createDatabase",
    role.rolcreaterole AS "createRole",
    role.rolreplication AS "replication",
    role.rolbypassrls AS "bypassRls",
    (SELECT count(*)::integer FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = role.oid) AS "parentMembershipCount",
    (SELECT count(*)::integer FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = role.oid) AS "childMembershipCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
      WHERE membership.roleid = role.oid
        AND child.rolname = $2
        AND NOT membership.admin_option
        AND NOT membership.inherit_option
        AND membership.set_option) AS "exactChildMembershipCount",
    (SELECT count(*)::integer FROM pg_catalog.pg_roles AS candidate
      WHERE candidate.rolname ~ ('^' || role.rolname || '_v[1-9][0-9]{0,19}$'))
      AS "scopedLoginCount",
    (SELECT count(*)::integer FROM pg_catalog.pg_roles AS candidate
      WHERE candidate.rolname LIKE (role.rolname || '\\_%') ESCAPE '\\')
      AS "reservedLoginNamespaceCount",
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
    (SELECT count(*)::integer FROM pg_catalog.pg_db_role_setting AS setting
      WHERE setting.setrole = role.oid) AS "roleSettingCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_shdepend AS dependency
      JOIN pg_catalog.pg_database AS current_database_row
        ON current_database_row.datname = pg_catalog.current_database()
      WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND dependency.refobjid = role.oid
        AND dependency.deptype = 'o'
        AND dependency.dbid IN (0::oid, current_database_row.oid))
      AS "ownedCurrentDatabaseObjectCount",
    (SELECT count(*)::integer FROM pg_catalog.pg_shdepend AS dependency
      WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND dependency.refobjid = role.oid) AS "sharedDependencyCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_shdepend AS dependency
      JOIN pg_catalog.pg_database AS current_database_row
        ON current_database_row.datname = pg_catalog.current_database()
      WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND dependency.refobjid = role.oid
        AND dependency.dbid = current_database_row.oid
        AND dependency.objsubid = 0
        AND dependency.deptype = 'a'
        AND (
          (dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
            AND EXISTS (
              SELECT 1 FROM pg_catalog.pg_namespace AS namespace
              WHERE namespace.oid = dependency.objid
                AND namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
            ))
          OR
          (dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND EXISTS (
              SELECT 1 FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = relation.relnamespace
              WHERE relation.oid = dependency.objid
                AND namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                AND relation.relkind IN ('r', 'p')
            ))
        )) AS "exactSharedDependencyCount",
    (SELECT count(*)::integer FROM pg_catalog.pg_namespace AS namespace
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops']))
      AS "privateSchemaCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        namespace.nspacl,
        pg_catalog.acldefault('n', namespace.nspowner)
      )) AS privilege
      WHERE privilege.grantee = role.oid) AS "directSchemaPrivilegeCount",
    (SELECT count(*)::integer FROM pg_catalog.pg_namespace AS namespace
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
        AND pg_catalog.has_schema_privilege(role.oid, namespace.oid, 'USAGE')
        AND NOT pg_catalog.has_schema_privilege(role.oid, namespace.oid, 'CREATE')
        AND (SELECT count(*) FROM LATERAL pg_catalog.aclexplode(COALESCE(
          namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
        )) AS privilege
          WHERE privilege.grantee = role.oid
            AND privilege.privilege_type = 'USAGE'
            AND NOT privilege.is_grantable) = 1
        AND NOT EXISTS (
          SELECT 1 FROM LATERAL pg_catalog.aclexplode(COALESCE(
            namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
          )) AS privilege
          WHERE privilege.grantee = role.oid
            AND (privilege.privilege_type <> 'USAGE' OR privilege.is_grantable)
        )) AS "exactSchemaPrivilegeCount",
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
        AND (SELECT count(*) FROM LATERAL pg_catalog.aclexplode(COALESCE(
          relation.relacl, pg_catalog.acldefault('r', relation.relowner)
        )) AS privilege
          WHERE privilege.grantee = role.oid
            AND privilege.privilege_type = 'SELECT'
            AND NOT privilege.is_grantable) = 1
        AND NOT EXISTS (
          SELECT 1 FROM LATERAL pg_catalog.aclexplode(COALESCE(
            relation.relacl, pg_catalog.acldefault('r', relation.relowner)
          )) AS privilege
          WHERE privilege.grantee = role.oid
            AND (privilege.privilege_type <> 'SELECT' OR privilege.is_grantable)
        )) AS "exactRelationPrivilegeCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
        AND relation.relkind = 'S') AS "privateSequenceCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
        AND attribute.attnum > 0
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
          (namespace.nspname = 'pintpath_app'
            AND relation.relname <> 'schema_metadata'
            AND (
              (policy.polname = (relation.relname || '_runtime_all')::name
                AND policy.polroles = ARRAY[runtime_role.oid]::oid[]
                AND policy.polcmd = '*'
                AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
                AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
              OR
              (policy.polname = (relation.relname || '_migrator_select')::name
                AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                AND policy.polcmd = 'r'
                AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
                AND policy.polwithcheck IS NULL)
              OR
              (policy.polname = (relation.relname || '_migrator_insert')::name
                AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                AND policy.polcmd = 'a'
                AND policy.polqual IS NULL
                AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
            ))
          OR
          (namespace.nspname = 'pintpath_app'
            AND relation.relname = 'schema_metadata'
            AND (
              (policy.polname = 'schema_metadata_runtime_read'::name
                AND policy.polroles = ARRAY[runtime_role.oid]::oid[]
                AND policy.polcmd = 'r'
                AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
                AND policy.polwithcheck IS NULL)
              OR
              (policy.polname = 'schema_metadata_migrator_select'::name
                AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                AND policy.polcmd = 'r'
                AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
                AND policy.polwithcheck IS NULL)
              OR
              (policy.polname = 'schema_metadata_migrator_update'::name
                AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                AND policy.polcmd = 'w'
                AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
                AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
            ))
          OR
          (namespace.nspname = 'pintpath_ops'
            AND relation.relname = ANY(ARRAY['migration_chunks', 'migration_runs'])
            AND (
              (policy.polname = (relation.relname || '_migrator_select')::name
                AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                AND policy.polcmd = 'r'
                AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
                AND policy.polwithcheck IS NULL)
              OR
              (policy.polname = (relation.relname || '_migrator_insert')::name
                AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                AND policy.polcmd = 'a'
                AND policy.polqual IS NULL
                AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
              OR
              (policy.polname = (relation.relname || '_migrator_update')::name
                AND policy.polroles = ARRAY[migrator_role.oid]::oid[]
                AND policy.polcmd = 'w'
                AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
                AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true')
            ))
        )) AS "exactBasePolicyCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_policy AS policy
      JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
        AND policy.polname = (relation.relname || '_logical_backup_select')::name
        AND policy.polroles = ARRAY[0]::oid[]
        AND policy.polcmd = 'r'
        AND policy.polpermissive
        AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = $3
        AND policy.polwithcheck IS NULL) AS "exactBackupPolicyCount",
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
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = $3
          AND policy.polwithcheck IS NULL
        )) AS "unsafePublicPolicyCount",
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
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = $3
          AND policy.polwithcheck IS NULL
        )) AS "unsafeReservedPolicyCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_policy AS policy
      JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
        AND role.oid = ANY(policy.polroles)) AS "directScopedPolicyCount"
  FROM pg_catalog.pg_roles AS role
  JOIN pg_catalog.pg_authid AS authentication ON authentication.oid = role.oid
  WHERE role.rolname = $1`;

async function inspectGroupAuthority(
  connection: PostgresLogicalBackupLoginConnection,
  groupRole: string,
  candidateRole: string,
  expectedChildren: 0 | 1,
  expectedScopedLogins: 0 | 1 = expectedChildren,
): Promise<GroupAuthorityState> {
  let result: { rows: GroupAuthorityRow[]; rowCount: number | null };
  try {
    result = await connection.query<GroupAuthorityRow>(GROUP_AUTHORITY_QUERY, [
      groupRole,
      candidateRole,
      LOGICAL_BACKUP_POLICY_EXPRESSION,
    ]);
  } catch {
    throw new PostgresLogicalBackupLoginError("source_authority_invalid");
  }
  const row = result.rows[0];
  const exact = result.rows.length === 1
    && !!row
    && row.roleName === groupRole
    && row.canLogin === false
    && row.hasPassword === false
    && row.validUntilIsNull === true
    && row.inheritsPrivileges === false
    && row.connectionLimit === -1
    && row.superuser === false
    && row.createDatabase === false
    && row.createRole === false
    && row.replication === false
    && row.bypassRls === false
    && row.parentMembershipCount === 0
    && row.childMembershipCount === expectedChildren
    && row.exactChildMembershipCount === expectedChildren
    && row.scopedLoginCount === expectedScopedLogins
    && row.reservedLoginNamespaceCount === expectedScopedLogins
    && row.directDatabasePrivilegeCount === 0
    && row.directFunctionPrivilegeCount === 0
    && row.roleSettingCount === 0
    && row.ownedCurrentDatabaseObjectCount === 0
    && row.sharedDependencyCount === EXPECTED_GROUP_DEPENDENCIES
    && row.exactSharedDependencyCount === row.sharedDependencyCount
    && row.privateSchemaCount === 2
    && row.directSchemaPrivilegeCount === 2
    && row.exactSchemaPrivilegeCount === 2
    && row.privateRelationCount === EXPECTED_PRIVATE_RELATIONS
    && row.forceRlsRelationCount === EXPECTED_PRIVATE_RELATIONS
    && row.directRelationPrivilegeCount === EXPECTED_PRIVATE_RELATIONS
    && row.exactRelationPrivilegeCount === EXPECTED_PRIVATE_RELATIONS
    && row.privateSequenceCount === 0
    && row.directColumnPrivilegeCount === 0
    && row.executablePrivateFunctionCount === 0
    && row.privatePolicyCount === EXPECTED_POLICIES
    && row.exactBasePolicyCount === EXPECTED_BASE_POLICIES
    && row.exactBackupPolicyCount === EXPECTED_BACKUP_POLICIES
    && row.unsafePublicPolicyCount === 0
    && row.unsafeReservedPolicyCount === 0
    && row.directScopedPolicyCount === 0;
  return {
    exact,
    policyCount: row?.privatePolicyCount ?? 0,
    dependencyCount: row?.sharedDependencyCount ?? 0,
    childCount: row?.childMembershipCount ?? 0,
  };
}

const CANDIDATE_STATE_QUERY = `/* pintpath:backup-login:candidate-state */
  SELECT
    candidate.oid::text AS "oid",
    pg_catalog.shobj_description(candidate.oid, 'pg_authid') AS "marker",
    candidate.rolcanlogin AS "canLogin",
    (authentication.rolpassword IS NOT NULL) AS "hasPassword",
    candidate.rolinherit AS "inheritsPrivileges",
    candidate.rolconnlimit AS "connectionLimit",
    (candidate.rolvaliduntil IS NULL) AS "validUntilIsNull",
    candidate.rolsuper AS "superuser",
    candidate.rolcreatedb AS "createDatabase",
    candidate.rolcreaterole AS "createRole",
    candidate.rolreplication AS "replication",
    candidate.rolbypassrls AS "bypassRls",
    (SELECT count(*)::integer FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = candidate.oid) AS "parentMembershipCount",
    (SELECT count(*)::integer FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = candidate.oid) AS "childMembershipCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
      WHERE membership.member = candidate.oid
        AND parent.rolname = $2
        AND NOT membership.admin_option
        AND NOT membership.inherit_option
        AND membership.set_option) AS "exactMembershipCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_database AS database
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        database.datacl, pg_catalog.acldefault('d', database.datdba)
      )) AS privilege
      WHERE privilege.grantee = candidate.oid) AS "directDatabasePrivilegeCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_database AS database
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        database.datacl, pg_catalog.acldefault('d', database.datdba)
      )) AS privilege
      WHERE database.datname = pg_catalog.current_database()
        AND privilege.grantee = candidate.oid
        AND privilege.privilege_type = 'CONNECT'
        AND NOT privilege.is_grantable) AS "exactDatabasePrivilegeCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) AS privilege
      WHERE privilege.grantee = candidate.oid) AS "directFunctionPrivilegeCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) AS privilege
      WHERE routine.oid = 'pg_catalog.pg_control_system()'::pg_catalog.regprocedure
        AND privilege.grantee = candidate.oid
        AND privilege.privilege_type = 'EXECUTE'
        AND NOT privilege.is_grantable) AS "exactFunctionPrivilegeCount",
    (SELECT count(*)::integer FROM (
      SELECT 1
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
      )) AS privilege
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
        AND privilege.grantee = candidate.oid
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
        AND privilege.grantee = candidate.oid
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
        AND privilege.grantee = candidate.oid
    ) AS direct_private_privilege) AS "directPrivateObjectPrivilegeCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_shdepend AS dependency
      WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND dependency.refobjid = candidate.oid
        AND dependency.deptype = 'o') AS "ownedPrivateObjectCount",
    (SELECT count(*)::integer FROM pg_catalog.pg_db_role_setting AS setting
      WHERE setting.setrole = candidate.oid) AS "roleSettingCount",
    (SELECT count(*)::integer FROM pg_catalog.pg_shdepend AS dependency
      WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND dependency.refobjid = candidate.oid) AS "sharedDependencyCount",
    (SELECT count(*)::integer
      FROM pg_catalog.pg_shdepend AS dependency
      JOIN pg_catalog.pg_database AS database
        ON database.datname = pg_catalog.current_database()
      WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND dependency.refobjid = candidate.oid
        AND dependency.objsubid = 0
        AND dependency.deptype = 'a'
        AND (
          (dependency.dbid = 0::oid
            AND dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
            AND dependency.objid = database.oid)
          OR
          (dependency.dbid = database.oid
            AND dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND dependency.objid = 'pg_catalog.pg_control_system()'::pg_catalog.regprocedure)
        )) AS "exactSharedDependencyCount"
  FROM pg_catalog.pg_roles AS candidate
  JOIN pg_catalog.pg_authid AS authentication ON authentication.oid = candidate.oid
  WHERE candidate.rolname = $1`;

async function inspectCandidateState(
  connection: PostgresLogicalBackupLoginConnection,
  loginRole: string,
  groupRole: string,
  expectedMarker: string | null,
  expectedOid: string | null = null,
): Promise<CandidateState> {
  let result: { rows: CandidateStateRow[]; rowCount: number | null };
  try {
    result = await connection.query<CandidateStateRow>(CANDIDATE_STATE_QUERY, [
      loginRole,
      groupRole,
    ]);
  } catch {
    throw new PostgresLogicalBackupLoginError("source_authority_invalid");
  }
  if (result.rows.length === 0) {
    return {
      exists: false,
      oid: null,
      marker: null,
      canLogin: null,
      hasPassword: null,
      exact: false,
      preparedExact: false,
      disabledExact: false,
    };
  }
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || !exactOid(row.oid)) {
    throw new PostgresLogicalBackupLoginError("source_authority_invalid");
  }
  const baseExact = row.inheritsPrivileges === false
    && row.connectionLimit === 2
    && row.validUntilIsNull === true
    && row.superuser === false
    && row.createDatabase === false
    && row.createRole === false
    && row.replication === false
    && row.bypassRls === false
    && row.childMembershipCount === 0
    && row.directPrivateObjectPrivilegeCount === 0
    && row.ownedPrivateObjectCount === 0
    && row.roleSettingCount === 0
    && (expectedMarker === null || row.marker === expectedMarker)
    && (expectedOid === null || row.oid === expectedOid);
  const exact = baseExact
    && row.canLogin === true
    && row.hasPassword === true
    && row.parentMembershipCount === 1
    && row.exactMembershipCount === 1
    && row.directDatabasePrivilegeCount === 1
    && row.exactDatabasePrivilegeCount === 1
    && row.directFunctionPrivilegeCount === 1
    && row.exactFunctionPrivilegeCount === 1
    && row.sharedDependencyCount === 2
    && row.exactSharedDependencyCount === 2;
  const preparedExact = baseExact
    && row.canLogin === false
    && row.hasPassword === true
    && row.parentMembershipCount === 1
    && row.exactMembershipCount === 1
    && row.directDatabasePrivilegeCount === 1
    && row.exactDatabasePrivilegeCount === 1
    && row.directFunctionPrivilegeCount === 1
    && row.exactFunctionPrivilegeCount === 1
    && row.sharedDependencyCount === 2
    && row.exactSharedDependencyCount === 2;
  const disabledExact = baseExact
    && row.canLogin === false
    && row.hasPassword === false
    && row.parentMembershipCount === 0
    && row.exactMembershipCount === 0
    && row.directDatabasePrivilegeCount === 0
    && row.exactDatabasePrivilegeCount === 0
    && row.directFunctionPrivilegeCount === 0
    && row.exactFunctionPrivilegeCount === 0
    && row.sharedDependencyCount === 0
    && row.exactSharedDependencyCount === 0;
  return {
    exists: true,
    oid: row.oid,
    marker: row.marker,
    canLogin: row.canLogin,
    hasPassword: row.hasPassword,
    exact,
    preparedExact,
    disabledExact,
  };
}

interface LoggerInventoryRow extends QueryResultRow {
  readonly sharedPreloadLibraries: string;
  readonly sessionPreloadLibraries: string;
  readonly localPreloadLibraries: string;
  readonly pgauditInstalled: boolean;
  readonly pgStatStatementsLoaded: boolean;
  readonly autoExplainLoaded: boolean;
}

interface LoggerGuardRow extends QueryResultRow {
  readonly logStatement: string;
  readonly logMinDurationStatement: string;
  readonly logDuration: string;
  readonly logMinErrorStatement: string;
  readonly logParameterMaxLength: string;
  readonly logParameterMaxLengthOnError: string;
  readonly logErrorVerbosity: string;
  readonly logStatementStats: string;
  readonly logParserStats: string;
  readonly logPlannerStats: string;
  readonly logExecutorStats: string;
  readonly debugPrintParse: string;
  readonly debugPrintRewritten: string;
  readonly debugPrintPlan: string;
  readonly logMinDurationSample: string;
  readonly logStatementSampleRate: string;
  readonly logTransactionSampleRate: string;
  readonly passwordEncryption: string;
  readonly pgStatStatementsTrack: string | null;
  readonly autoExplainLogMinDuration: string | null;
  readonly autoExplainLogNestedStatements: string | null;
}

async function inspectLoggerInventory(
  connection: PostgresLogicalBackupLoginConnection,
): Promise<LoggerInventory> {
  let result: { rows: LoggerInventoryRow[]; rowCount: number | null };
  try {
    result = await connection.query<LoggerInventoryRow>(`/* pintpath:backup-login:logger-inventory */
      SELECT
        pg_catalog.current_setting('shared_preload_libraries') AS "sharedPreloadLibraries",
        pg_catalog.current_setting('session_preload_libraries') AS "sessionPreloadLibraries",
        pg_catalog.current_setting('local_preload_libraries') AS "localPreloadLibraries",
        EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgaudit')
          AS "pgauditInstalled",
        'pg_stat_statements' = ANY(
          pg_catalog.string_to_array(
            pg_catalog.replace(pg_catalog.current_setting('shared_preload_libraries'), ' ', ''),
            ','
          )
        ) AS "pgStatStatementsLoaded",
        'auto_explain' = ANY(
          pg_catalog.string_to_array(
            pg_catalog.replace(pg_catalog.current_setting('shared_preload_libraries'), ' ', ''),
            ','
          )
        ) AS "autoExplainLoaded"`);
  } catch {
    throw new PostgresLogicalBackupLoginError("logger_guard_failed");
  }
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row) {
    throw new PostgresLogicalBackupLoginError("logger_guard_failed");
  }
  const inventory: LoggerInventory = {
    sharedPreloadLibraries: parseLibraryList(row.sharedPreloadLibraries),
    sessionPreloadLibraries: parseLibraryList(row.sessionPreloadLibraries),
    localPreloadLibraries: parseLibraryList(row.localPreloadLibraries),
    pgauditInstalled: row.pgauditInstalled,
    pgStatStatementsLoaded: row.pgStatStatementsLoaded,
    autoExplainLoaded: row.autoExplainLoaded,
  };
  const everyKnown = [
    ...inventory.sharedPreloadLibraries,
    ...inventory.sessionPreloadLibraries,
    ...inventory.localPreloadLibraries,
  ].every((library) => SAFE_PRELOAD_LIBRARIES.has(library));
  if (
    !everyKnown
    || inventory.pgauditInstalled
    || inventory.sessionPreloadLibraries.length !== 0
    || inventory.localPreloadLibraries.length !== 0
  ) throw new PostgresLogicalBackupLoginError("logger_guard_failed");
  return inventory;
}

async function setAndVerifyLoggerGuards(
  connection: PostgresLogicalBackupLoginConnection,
  inventory: LoggerInventory,
): Promise<void> {
  try {
    await connection.query(`/* pintpath:backup-login:logger-guards */
      SET LOCAL log_statement = 'none';
      SET LOCAL log_min_duration_statement = '-1';
      SET LOCAL log_duration = 'off';
      SET LOCAL log_min_error_statement = 'panic';
      SET LOCAL log_parameter_max_length = '0';
      SET LOCAL log_parameter_max_length_on_error = '0';
      SET LOCAL log_error_verbosity = 'terse';
      SET LOCAL log_statement_stats = 'off';
      SET LOCAL log_parser_stats = 'off';
      SET LOCAL log_planner_stats = 'off';
      SET LOCAL log_executor_stats = 'off';
      SET LOCAL debug_print_parse = 'off';
      SET LOCAL debug_print_rewritten = 'off';
      SET LOCAL debug_print_plan = 'off';
      SET LOCAL log_min_duration_sample = '-1';
      SET LOCAL log_statement_sample_rate = '0';
      SET LOCAL log_transaction_sample_rate = '0';
      SET LOCAL password_encryption = 'scram-sha-256'`);
    if (inventory.pgStatStatementsLoaded) {
      await connection.query("SET LOCAL pg_stat_statements.track = 'none'");
    }
    if (inventory.autoExplainLoaded) {
      await connection.query(`SET LOCAL auto_explain.log_min_duration = '-1';
        SET LOCAL auto_explain.log_nested_statements = 'off'`);
    }
    const result = await connection.query<LoggerGuardRow>(`/* pintpath:backup-login:logger-guards-verify */
      SELECT
        pg_catalog.current_setting('log_statement') AS "logStatement",
        pg_catalog.current_setting('log_min_duration_statement') AS "logMinDurationStatement",
        pg_catalog.current_setting('log_duration') AS "logDuration",
        pg_catalog.current_setting('log_min_error_statement') AS "logMinErrorStatement",
        pg_catalog.current_setting('log_parameter_max_length') AS "logParameterMaxLength",
        pg_catalog.current_setting('log_parameter_max_length_on_error')
          AS "logParameterMaxLengthOnError",
        pg_catalog.current_setting('log_error_verbosity') AS "logErrorVerbosity",
        pg_catalog.current_setting('log_statement_stats') AS "logStatementStats",
        pg_catalog.current_setting('log_parser_stats') AS "logParserStats",
        pg_catalog.current_setting('log_planner_stats') AS "logPlannerStats",
        pg_catalog.current_setting('log_executor_stats') AS "logExecutorStats",
        pg_catalog.current_setting('debug_print_parse') AS "debugPrintParse",
        pg_catalog.current_setting('debug_print_rewritten') AS "debugPrintRewritten",
        pg_catalog.current_setting('debug_print_plan') AS "debugPrintPlan",
        pg_catalog.current_setting('log_min_duration_sample') AS "logMinDurationSample",
        pg_catalog.current_setting('log_statement_sample_rate') AS "logStatementSampleRate",
        pg_catalog.current_setting('log_transaction_sample_rate') AS "logTransactionSampleRate",
        pg_catalog.current_setting('password_encryption') AS "passwordEncryption",
        CASE WHEN $1::boolean THEN pg_catalog.current_setting('pg_stat_statements.track')
          ELSE NULL END AS "pgStatStatementsTrack",
        CASE WHEN $2::boolean THEN pg_catalog.current_setting('auto_explain.log_min_duration')
          ELSE NULL END AS "autoExplainLogMinDuration",
        CASE WHEN $2::boolean THEN pg_catalog.current_setting('auto_explain.log_nested_statements')
          ELSE NULL END AS "autoExplainLogNestedStatements"`, [
      inventory.pgStatStatementsLoaded,
      inventory.autoExplainLoaded,
    ]);
    const row = result.rows[0];
    if (
      result.rows.length !== 1
      || !row
      || row.logStatement !== "none"
      || row.logMinDurationStatement !== "-1"
      || row.logDuration !== "off"
      || row.logMinErrorStatement !== "panic"
      || row.logParameterMaxLength !== "0"
      || row.logParameterMaxLengthOnError !== "0"
      || row.logErrorVerbosity !== "terse"
      || row.logStatementStats !== "off"
      || row.logParserStats !== "off"
      || row.logPlannerStats !== "off"
      || row.logExecutorStats !== "off"
      || row.debugPrintParse !== "off"
      || row.debugPrintRewritten !== "off"
      || row.debugPrintPlan !== "off"
      || row.logMinDurationSample !== "-1"
      || Number(row.logStatementSampleRate) !== 0
      || Number(row.logTransactionSampleRate) !== 0
      || row.passwordEncryption !== "scram-sha-256"
      || (inventory.pgStatStatementsLoaded && row.pgStatStatementsTrack !== "none")
      || (inventory.autoExplainLoaded && row.autoExplainLogMinDuration !== "-1")
      || (inventory.autoExplainLoaded && row.autoExplainLogNestedStatements !== "off")
    ) throw new PostgresLogicalBackupLoginError("logger_guard_failed");
  } catch (error) {
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("logger_guard_failed");
  }
}

async function acquireManagerLock(
  connection: PostgresLogicalBackupLoginConnection,
): Promise<void> {
  try {
    const result = await connection.query<{ acquired: boolean }>(
      `/* pintpath:backup-login:advisory-lock */
       SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS "acquired"`,
      [ADVISORY_LOCK_KEY],
    );
    if (result.rows.length !== 1 || result.rows[0]?.acquired !== true) {
      throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
    }
  } catch (error) {
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
  }
}

async function assertManagerLockHeld(
  connection: PostgresLogicalBackupLoginConnection,
): Promise<void> {
  try {
    const result = await connection.query<{ held: boolean }>(`/* pintpath:backup-login:lock-verify */
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_locks AS lock
        WHERE lock.locktype = 'advisory'
          AND lock.pid = pg_catalog.pg_backend_pid()
          AND lock.classid = (($1::bigint >> 32) & 4294967295)::oid
          AND lock.objid = ($1::bigint & 4294967295)::oid
          AND lock.objsubid = 1
          AND lock.granted
      ) AS "held"`, [ADVISORY_LOCK_KEY]);
    if (result.rows.length !== 1 || result.rows[0]?.held !== true) {
      throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
    }
  } catch (error) {
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
  }
}

const CREATE_VERIFIER_FUNCTION_SQL = `/* pintpath:backup-login:create-verifier-function */
  CREATE OR REPLACE FUNCTION pg_temp.pintpath_apply_backup_login_verifier(
    target_oid oid,
    expected_name name,
    supplied_verifier text
  ) RETURNS void
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
  AS $function$
  DECLARE
    actual_name name;
    actual_login boolean;
    actual_password text;
  BEGIN
    SELECT role.rolname, role.rolcanlogin, role.rolpassword
      INTO STRICT actual_name, actual_login, actual_password
    FROM pg_catalog.pg_authid AS role
    WHERE role.oid = target_oid
    FOR UPDATE;
    IF actual_name IS DISTINCT FROM expected_name
      OR actual_login
      OR actual_password IS NOT NULL
      OR supplied_verifier !~
        '^SCRAM-SHA-256\\$4096:[A-Za-z0-9+/]{22}==\\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$'
    THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'backup_login_verifier_rejected';
    END IF;
    EXECUTE pg_catalog.format('ALTER ROLE %I PASSWORD %L', actual_name, supplied_verifier);
  END
  $function$`;

function loggerInventorySha256(inventory: LoggerInventory): string {
  return canonicalSha256({
    schemaVersion: 1,
    kind: "pintpath-postgres-logical-backup-login-logger-inventory",
    sharedPreloadLibraries: inventory.sharedPreloadLibraries,
    sessionPreloadLibraries: inventory.sessionPreloadLibraries,
    localPreloadLibraries: inventory.localPreloadLibraries,
    pgauditInstalled: inventory.pgauditInstalled,
    pgStatStatementsLoaded: inventory.pgStatStatementsLoaded,
    autoExplainLoaded: inventory.autoExplainLoaded,
  });
}

function roleMarker(
  operationId: string,
  intentSha256: string,
  roleOid: string,
): string {
  if (
    !OPERATION_ID_PATTERN.test(operationId)
    || !SHA256_PATTERN.test(intentSha256)
    || !exactOid(roleOid)
  ) throw new PostgresLogicalBackupLoginError("mutation_failed");
  return `pintpath-logical-backup-login/v1:${operationId}:${intentSha256}:${roleOid}`;
}

async function assertEscrowUnchanged(
  escrow: EscrowBundle,
  expectedUid: number,
): Promise<void> {
  try {
    const stat = await fs.promises.lstat(escrow.directory, { bigint: true });
    assertTrustedPrivateDirectory(stat, BigInt(expectedUid));
    if (!sameDirectoryIdentity(escrow.directoryIdentity, directoryIdentity(stat))) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    const entries = (await fs.promises.readdir(escrow.directory)).sort();
    const allowed = new Set<string>([
      POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE,
      POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
      POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_INTENT_FILE,
      POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_DISABLED_FILE,
    ]);
    if (entries.some((entry) => !allowed.has(entry))) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    await assertStablePrivateFileUnchanged(escrow.urlFile, expectedUid);
    await assertStablePrivateFileUnchanged(escrow.intentFile, expectedUid);
  } catch (error) {
    if (error instanceof PostgresLogicalBackupLoginError && error.code === "cleanup_failed") {
      throw error;
    }
    if (error instanceof PostgresLogicalBackupLoginError && error.code === "escrow_invalid") {
      throw error;
    }
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
}

async function rollbackQuietly(
  connection: PostgresLogicalBackupLoginConnection,
): Promise<void> {
  await connection.query("ROLLBACK").catch(() => undefined);
}

async function provisionCandidateTransaction(
  connection: PostgresLogicalBackupLoginConnection,
  identity: SourceIdentity,
  escrow: EscrowBundle,
  expectedLoggerInventorySha256: string,
): Promise<{
  roleOid: string;
  marker: string;
  group: GroupAuthorityState;
}> {
  const loginRole = escrow.intent.loginRole;
  const groupRole = escrow.intent.groupRole;
  let began = false;
  try {
    await assertManagerLockHeld(connection);
    await connection.query("BEGIN");
    began = true;
    const inventory = await inspectLoggerInventory(connection);
    if (loggerInventorySha256(inventory) !== expectedLoggerInventorySha256) {
      throw new PostgresLogicalBackupLoginError("logger_guard_failed");
    }
    await setAndVerifyLoggerGuards(connection, inventory);
    const groupBefore = await inspectGroupAuthority(connection, groupRole, loginRole, 0);
    if (!groupBefore.exact) {
      throw new PostgresLogicalBackupLoginError("source_authority_invalid");
    }
    const before = await inspectCandidateState(connection, loginRole, groupRole, null);
    if (before.exists) {
      throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
    }

    await connection.query(`/* pintpath:backup-login:create-candidate */
      CREATE ROLE ${quoteIdentifier(loginRole)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD NULL`);
    const oidResult = await connection.query<{ oid: string }>(
      `SELECT role.oid::text AS "oid" FROM pg_catalog.pg_roles AS role
       WHERE role.rolname = $1`,
      [loginRole],
    );
    const roleOid = oidResult.rows[0]?.oid;
    if (oidResult.rows.length !== 1 || !roleOid || !exactOid(roleOid)) {
      throw new PostgresLogicalBackupLoginError("mutation_failed");
    }
    const marker = roleMarker(escrow.intent.operationId, escrow.intentFile.sha256, roleOid);
    await connection.query(`/* pintpath:backup-login:mark-candidate */
      COMMENT ON ROLE ${quoteIdentifier(loginRole)} IS '${marker}'`);
    await connection.query(`/* pintpath:backup-login:grant-connect */
      GRANT CONNECT ON DATABASE ${quoteServerIdentifier(identity.databaseName)}
      TO ${quoteIdentifier(loginRole)}`);
    await connection.query(`/* pintpath:backup-login:grant-control-system */
      GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system()
      TO ${quoteIdentifier(loginRole)}`);
    await connection.query(`/* pintpath:backup-login:grant-group */
      GRANT ${quoteIdentifier(groupRole)} TO ${quoteIdentifier(loginRole)}
      WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
    await connection.query(CREATE_VERIFIER_FUNCTION_SQL);
    await connection.query(
      `/* pintpath:backup-login:bind-verifier */
       SELECT pg_temp.pintpath_apply_backup_login_verifier($1::oid, $2::name, $3::text)`,
      [roleOid, loginRole, escrow.verifier],
    );
    const prepared = await inspectCandidateState(
      connection,
      loginRole,
      groupRole,
      marker,
      roleOid,
    );
    const groupPrepared = await inspectGroupAuthority(connection, groupRole, loginRole, 1);
    if (!prepared.preparedExact || !groupPrepared.exact) {
      throw new PostgresLogicalBackupLoginError("mutation_failed");
    }
    await connection.query(`/* pintpath:backup-login:enable-last */
      ALTER ROLE ${quoteIdentifier(loginRole)} LOGIN`);
    const active = await inspectCandidateState(
      connection,
      loginRole,
      groupRole,
      marker,
      roleOid,
    );
    const groupAfter = await inspectGroupAuthority(connection, groupRole, loginRole, 1);
    if (!active.exact || !groupAfter.exact) {
      throw new PostgresLogicalBackupLoginError("mutation_failed");
    }
    await assertManagerLockHeld(connection);
    await connection.query("COMMIT");
    began = false;
    return { roleOid, marker, group: groupAfter };
  } catch (error) {
    if (began) await rollbackQuietly(connection);
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
  }
}

async function canaryProvisionedLogin(
  options: PostgresLogicalBackupLoginManagerOptions,
  admin: SafeAdminConnection,
  escrow: EscrowBundle,
  transport: PostgresRailwayStockLocalhostCaTransport,
  dependencies: PostgresLogicalBackupLoginDependencies,
): Promise<PostgresLogicalBackupLoginReceipt["canary"]> {
  await assertTransportExact(transport, options, admin);
  const config = postgresConnectionConfig(
    admin,
    transport,
    escrow.intent.loginRole,
    escrow.password,
    "pintpath-logical-backup-login-canary",
  );
  let connection: PostgresLogicalBackupLoginConnection | null = null;
  let transaction = false;
  let result: PostgresLogicalBackupLoginReceipt["canary"] | null = null;
  try {
    connection = await dependencies.connect(config).catch(() => {
      throw new PostgresLogicalBackupLoginError("canary_failed");
    });
    await assertTransportExact(transport, options, admin);
    if (connection.authenticationMethod !== "scram-sha-256") {
      throw new PostgresLogicalBackupLoginError("canary_failed");
    }
    await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transaction = true;
    await connection.query(`SET ROLE ${quoteIdentifier(escrow.intent.groupRole)}`);
    const queryResult = await connection.query<{
      sessionRole: string;
      effectiveRole: string;
      transactionReadOnly: boolean;
      rowsObserved: number;
    }>(`/* pintpath:backup-login:read-only-canary */
      SELECT
        session_user AS "sessionRole",
        current_user AS "effectiveRole",
        pg_catalog.current_setting('transaction_read_only')::boolean AS "transactionReadOnly",
        (SELECT count(*)::integer FROM pintpath_app.schema_metadata) AS "rowsObserved"`);
    const row = queryResult.rows[0];
    if (
      queryResult.rows.length !== 1
      || !row
      || row.sessionRole !== escrow.intent.loginRole
      || row.effectiveRole !== escrow.intent.groupRole
      || row.transactionReadOnly !== true
      || !Number.isSafeInteger(row.rowsObserved)
      || row.rowsObserved < 0
    ) throw new PostgresLogicalBackupLoginError("canary_failed");
    await connection.query("ROLLBACK");
    transaction = false;
    result = { saslScramSha256: true, setRole: true, readOnly: true };
  } catch (error) {
    if (transaction) await connection?.query("ROLLBACK").catch(() => undefined);
    if (
      error instanceof PostgresLogicalBackupLoginError
      && ["cleanup_failed", "source_authority_invalid"].includes(error.code)
    ) throw error;
    throw new PostgresLogicalBackupLoginError("canary_failed");
  } finally {
    if (connection) await closeConnectionExact(connection);
  }
  await assertTransportExact(transport, options, admin);
  if (!result) throw new PostgresLogicalBackupLoginError("canary_failed");
  return result;
}

function parseManagerReceipt(value: Buffer): PostgresLogicalBackupLoginReceipt {
  const text = value.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PostgresLogicalBackupLoginError("receipt_invalid");
  }
  if (!isRecord(parsed) || canonicalPostgresBackupJson(parsed) !== text) {
    throw new PostgresLogicalBackupLoginError("receipt_invalid");
  }
  const expectedKeys = [
    "schemaVersion", "kind", "operation", "status", "createdAt", "operationId",
    "approvalReference", "expectedEnvironment", "executorUid", "mutationArm",
    "headSha", "treeSha", "nodeVersion",
    "adminUrlSha256", "transportProfile", "rootCaDerSha256",
    "databaseIdentitySha256", "databaseOid", "databaseNameSha256",
    "loginVersion", "loginRole", "loginRoleOid", "groupRole", "marker", "markerSha256",
    "escrowIntentSha256", "escrowUrlSha256", "loggerInventorySha256",
    "authorityPolicyCount", "authorityDependencyCount", "canary",
    "provisionReceiptSha256", "retireIntentSha256", "retireDisabledSha256",
  ] as const;
  if (
    !exactKeys(parsed, expectedKeys)
    || parsed.schemaVersion !== MANAGER_SCHEMA_VERSION
    || parsed.kind !== "pintpath-postgres-logical-backup-login"
    || !["provision", "retire"].includes(String(parsed.operation))
    || !["provisioned", "retired"].includes(String(parsed.status))
    || (parsed.operation === "provision" && parsed.status !== "provisioned")
    || (parsed.operation === "retire" && parsed.status !== "retired")
    || !exactTimestamp(parsed.createdAt)
    || !OPERATION_ID_PATTERN.test(String(parsed.operationId))
    || !APPROVAL_REFERENCE_PATTERN.test(String(parsed.approvalReference))
    || parsed.expectedEnvironment !== POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT
    || !Number.isSafeInteger(parsed.executorUid)
    || Number(parsed.executorUid) < 0
    || !SHA256_PATTERN.test(String(parsed.mutationArm))
    || !GIT_SHA1_PATTERN.test(String(parsed.headSha))
    || !GIT_SHA1_PATTERN.test(String(parsed.treeSha))
    || !NODE_VERSION_PATTERN.test(String(parsed.nodeVersion))
    || !SHA256_PATTERN.test(String(parsed.adminUrlSha256))
    || parsed.transportProfile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE
    || !SHA256_PATTERN.test(String(parsed.rootCaDerSha256))
    || !SHA256_PATTERN.test(String(parsed.databaseIdentitySha256))
    || !DATABASE_OID_PATTERN.test(String(parsed.databaseOid))
    || !SHA256_PATTERN.test(String(parsed.databaseNameSha256))
    || !LOGIN_VERSION_PATTERN.test(String(parsed.loginVersion))
    || typeof parsed.loginRole !== "string"
    || typeof parsed.groupRole !== "string"
    || !exactOid(String(parsed.loginRoleOid))
    || typeof parsed.marker !== "string"
    || !SHA256_PATTERN.test(String(parsed.markerSha256))
    || sha256(String(parsed.marker)) !== parsed.markerSha256
    || !SHA256_PATTERN.test(String(parsed.escrowIntentSha256))
    || !SHA256_PATTERN.test(String(parsed.escrowUrlSha256))
    || !SHA256_PATTERN.test(String(parsed.loggerInventorySha256))
    || parsed.authorityPolicyCount !== EXPECTED_POLICIES
    || parsed.authorityDependencyCount !== EXPECTED_GROUP_DEPENDENCIES
    || !isRecord(parsed.canary)
    || !exactKeys(parsed.canary, ["saslScramSha256", "setRole", "readOnly"])
    || typeof parsed.canary.saslScramSha256 !== "boolean"
    || typeof parsed.canary.setRole !== "boolean"
    || typeof parsed.canary.readOnly !== "boolean"
    || !(parsed.provisionReceiptSha256 === null
      || SHA256_PATTERN.test(String(parsed.provisionReceiptSha256)))
    || !(parsed.retireIntentSha256 === null
      || SHA256_PATTERN.test(String(parsed.retireIntentSha256)))
    || !(parsed.retireDisabledSha256 === null
      || SHA256_PATTERN.test(String(parsed.retireDisabledSha256)))
  ) throw new PostgresLogicalBackupLoginError("receipt_invalid");
  const receipt = parsed as unknown as PostgresLogicalBackupLoginReceipt;
  if (
    receipt.loginRole !== versionedLoginRole(receipt.databaseOid, receipt.loginVersion)
    || receipt.groupRole !== scopedGroupRole(receipt.databaseOid)
    || receipt.marker !== roleMarker(
      receipt.operation === "provision" ? receipt.operationId : receipt.marker.split(":")[1] ?? "",
      receipt.escrowIntentSha256,
      receipt.loginRoleOid,
    )
    || (receipt.operation === "provision" && receipt.provisionReceiptSha256 !== null)
    || (receipt.operation === "provision" && receipt.retireIntentSha256 !== null)
    || (receipt.operation === "provision" && receipt.retireDisabledSha256 !== null)
    || (receipt.operation === "provision" && !Object.values(receipt.canary).every(Boolean))
    || (receipt.operation === "retire" && receipt.provisionReceiptSha256 === null)
    || (receipt.operation === "retire" && receipt.retireIntentSha256 === null)
    || (receipt.operation === "retire" && receipt.retireDisabledSha256 === null)
    || (receipt.operation === "retire" && Object.values(receipt.canary).some(Boolean))
  ) throw new PostgresLogicalBackupLoginError("receipt_invalid");
  return receipt;
}

async function openManagerReceipt(
  filePath: string,
  expectedSha256: string | null,
  expectedUid: number,
): Promise<{ receipt: PostgresLogicalBackupLoginReceipt; file: HeldStablePrivateFile }> {
  let file: HeldStablePrivateFile;
  try {
    file = await openStablePrivateFile(filePath, expectedUid, MAX_PRIVATE_FILE_BYTES);
  } catch (error) {
    if (error instanceof PostgresLogicalBackupLoginError && error.code === "cleanup_failed") {
      throw error;
    }
    throw new PostgresLogicalBackupLoginError("receipt_invalid");
  }
  try {
    if (expectedSha256 !== null && file.sha256 !== expectedSha256) {
      throw new PostgresLogicalBackupLoginError("receipt_invalid");
    }
    return { receipt: parseManagerReceipt(file.value), file };
  } catch (error) {
    try {
      await closeHeldStablePrivateFile(file);
    } catch {
      throw new PostgresLogicalBackupLoginError("cleanup_failed");
    }
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("receipt_invalid");
  }
}

async function preflightReceiptAuthority(
  receiptFileInput: string,
  expectedUid: number,
  expectedSha256: string | null = null,
  requireExisting = false,
): Promise<ReceiptAuthority> {
  const receiptFile = exactAbsolutePath(receiptFileInput);
  const parent = await openTrustedPrivateDirectory(path.dirname(receiptFile), expectedUid)
    .catch((error) => {
      if (error instanceof PostgresLogicalBackupLoginError && error.code === "cleanup_failed") {
        throw error;
      }
      throw new PostgresLogicalBackupLoginError("receipt_invalid");
    });
  let openedExisting: Awaited<ReturnType<typeof openManagerReceipt>> | null = null;
  try {
    await assertDirectoryStillExact(parent, expectedUid);
    const exists = await fs.promises.lstat(receiptFile).then(() => true).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    if (!exists) {
      if (requireExisting) throw new PostgresLogicalBackupLoginError("receipt_invalid");
      return { path: receiptFile, parent, existing: null };
    }
    const existing = await openManagerReceipt(receiptFile, expectedSha256, expectedUid);
    openedExisting = existing;
    await assertDirectoryStillExact(parent, expectedUid);
    return { path: receiptFile, parent, existing };
  } catch (error) {
    let cleanupFailed = false;
    if (openedExisting) {
      try {
        await closeHeldStablePrivateFile(openedExisting.file);
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await closeFileHandleExact(parent.handle);
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) throw new PostgresLogicalBackupLoginError("cleanup_failed");
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("receipt_invalid");
  }
}

async function closeReceiptAuthority(authority: ReceiptAuthority): Promise<void> {
  let failed = false;
  if (authority.existing) {
    try {
      await closeHeldStablePrivateFile(authority.existing.file);
    } catch {
      failed = true;
    }
  }
  try {
    await closeFileHandleExact(authority.parent.handle);
  } catch {
    failed = true;
  }
  if (failed) throw new PostgresLogicalBackupLoginError("cleanup_failed");
}

async function assertReceiptAuthorityUnchanged(
  authority: ReceiptAuthority,
  expectedUid: number,
): Promise<void> {
  await assertDirectoryStillExact(authority.parent, expectedUid)
    .catch((error) => remapPreservingCleanup(error, "receipt_invalid"));
  if (authority.existing) {
    await assertStablePrivateFileUnchanged(authority.existing.file, expectedUid)
      .catch((error) => remapPreservingCleanup(error, "receipt_invalid"));
    return;
  }
  const absent = await fs.promises.lstat(authority.path).then(
    () => false,
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  if (!absent) throw new PostgresLogicalBackupLoginError("receipt_invalid");
}

async function publishOrValidateReceipt(
  authority: ReceiptAuthority,
  expected: PostgresLogicalBackupLoginReceipt,
  expectedUid: number,
): Promise<PostgresLogicalBackupLoginManagerResult> {
  await assertReceiptAuthorityUnchanged(authority, expectedUid);
  if (authority.existing) {
    const normalized: PostgresLogicalBackupLoginReceipt = {
      ...expected,
      createdAt: authority.existing.receipt.createdAt,
    };
    if (
      canonicalPostgresBackupJson(authority.existing.receipt)
        !== canonicalPostgresBackupJson(normalized)
    ) {
      throw new PostgresLogicalBackupLoginError("receipt_invalid");
    }
    return {
      receipt: authority.existing.receipt,
      receiptSha256: authority.existing.file.sha256,
    };
  }
  const written = await writeExclusivePrivateFile(
    authority.path,
    expected,
    expectedUid,
    authority.parent,
  );
  try {
    await assertDirectoryStillExact(authority.parent, expectedUid)
      .catch((error) => {
        if (error instanceof PostgresLogicalBackupLoginError && error.code === "cleanup_failed") {
          throw error;
        }
        throw new PostgresLogicalBackupLoginError("receipt_invalid");
      });
    return { receipt: expected, receiptSha256: written.sha256 };
  } finally {
    written.file.value.fill(0);
  }
}

function buildProvisionReceipt(
  options: PostgresLogicalBackupLoginManagerOptions,
  identity: SourceIdentity,
  escrow: EscrowBundle,
  transport: PostgresRailwayStockLocalhostCaTransport,
  roleOid: string,
  marker: string,
  group: GroupAuthorityState,
  canary: PostgresLogicalBackupLoginReceipt["canary"],
  dependencies: PostgresLogicalBackupLoginDependencies,
): PostgresLogicalBackupLoginReceipt {
  return {
    schemaVersion: MANAGER_SCHEMA_VERSION,
    kind: "pintpath-postgres-logical-backup-login",
    operation: "provision",
    status: "provisioned",
    createdAt: canonicalTimestamp(dependencies.now),
    operationId: options.operationId,
    approvalReference: options.approvalReference,
    expectedEnvironment: options.expectedEnvironment,
    executorUid: options.expectedUid,
    mutationArm: postgresLogicalBackupLoginMutationArm(options),
    headSha: options.expectedHeadSha,
    treeSha: options.expectedTreeSha,
    nodeVersion: options.expectedNodeVersion,
    adminUrlSha256: options.expectedAdminUrlSha256,
    transportProfile: transport.profile,
    rootCaDerSha256: transport.rootCaDerSha256,
    databaseIdentitySha256: options.expectedDatabaseIdentitySha256,
    databaseOid: identity.databaseOid,
    databaseNameSha256: sha256(identity.databaseName),
    loginVersion: options.loginVersion,
    loginRole: escrow.intent.loginRole,
    loginRoleOid: roleOid,
    groupRole: escrow.intent.groupRole,
    marker,
    markerSha256: sha256(marker),
    escrowIntentSha256: escrow.intentFile.sha256,
    escrowUrlSha256: escrow.intent.escrowUrlSha256,
    loggerInventorySha256: escrow.intent.loggerInventorySha256,
    authorityPolicyCount: group.policyCount,
    authorityDependencyCount: group.dependencyCount,
    canary,
    provisionReceiptSha256: null,
    retireIntentSha256: null,
    retireDisabledSha256: null,
  };
}

function decodeConnectionFile(file: StablePrivateFile): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(file.value).trim();
  } catch {
    throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
  }
  if (!decoded || decoded.includes("\0") || /[\r\n]/.test(decoded)) {
    throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_file");
  }
  return decoded;
}

async function reconnectAdminWithLock(
  admin: SafeAdminConnection,
  options: PostgresLogicalBackupLoginManagerOptions,
  transport: PostgresRailwayStockLocalhostCaTransport,
  dependencies: PostgresLogicalBackupLoginDependencies,
): Promise<{
  connection: PostgresLogicalBackupLoginConnection;
  identity: SourceIdentity;
}> {
  await assertTransportExact(transport, options, admin);
  const connection = await dependencies.connect(postgresConnectionConfig(
    admin,
    transport,
    admin.username,
    admin.password,
    "pintpath-logical-backup-login-manager",
  )).catch(() => {
    throw new PostgresLogicalBackupLoginError("source_authority_invalid");
  });
  try {
    await assertTransportExact(transport, options, admin);
    await acquireManagerLock(connection);
    const identity = await inspectSourceIdentity(
      connection,
      options.expectedDatabaseIdentitySha256,
    );
    await assertTransportExact(transport, options, admin);
    return { connection, identity };
  } catch (error) {
    await closeConnectionExact(connection);
    throw error;
  }
}

async function manageProvision(
  options: PostgresLogicalBackupLoginManagerOptions,
  adminFile: StablePrivateFile,
  admin: SafeAdminConnection,
  receiptAuthority: ReceiptAuthority,
  transport: PostgresRailwayStockLocalhostCaTransport,
  dependencies: PostgresLogicalBackupLoginDependencies,
): Promise<PostgresLogicalBackupLoginManagerResult> {
  let locked: Awaited<ReturnType<typeof reconnectAdminWithLock>> | null = null;
  let escrow: EscrowBundle | null = null;
  try {
    locked = await reconnectAdminWithLock(admin, options, transport, dependencies);
    const identity = locked.identity;
    const loginRole = versionedLoginRole(identity.databaseOid, options.loginVersion);
    const groupRole = scopedGroupRole(identity.databaseOid);
    const inventory = await inspectLoggerInventory(locked.connection);
    const inventorySha256 = loggerInventorySha256(inventory);
    const initialCandidate = await inspectCandidateState(
      locked.connection,
      loginRole,
      groupRole,
      null,
    );
    escrow = await loadExistingEscrow(options, identity, admin);
    if (escrow && escrow.intent.loggerInventorySha256 !== inventorySha256) {
      throw new PostgresLogicalBackupLoginError("logger_guard_failed");
    }
    if (receiptAuthority.existing) {
      const existing = receiptAuthority.existing.receipt;
      if (
        existing.operation !== "provision"
        || existing.status !== "provisioned"
        || existing.operationId !== options.operationId
        || existing.approvalReference !== options.approvalReference
        || existing.expectedEnvironment !== options.expectedEnvironment
        || existing.executorUid !== options.expectedUid
        || existing.mutationArm !== postgresLogicalBackupLoginMutationArm(options)
        || existing.headSha !== options.expectedHeadSha
        || existing.treeSha !== options.expectedTreeSha
        || existing.nodeVersion !== options.expectedNodeVersion
        || existing.adminUrlSha256 !== options.expectedAdminUrlSha256
        || existing.transportProfile !== transport.profile
        || existing.rootCaDerSha256 !== transport.rootCaDerSha256
        || existing.databaseIdentitySha256 !== options.expectedDatabaseIdentitySha256
        || existing.databaseOid !== identity.databaseOid
        || existing.databaseNameSha256 !== sha256(identity.databaseName)
        || existing.loginVersion !== options.loginVersion
        || existing.loginRole !== loginRole
        || existing.groupRole !== groupRole
        || !escrow
      ) throw new PostgresLogicalBackupLoginError("receipt_invalid");
      const candidate = await inspectCandidateState(
        locked.connection,
        loginRole,
        groupRole,
        existing.marker,
        existing.loginRoleOid,
      );
      const group = await inspectGroupAuthority(locked.connection, groupRole, loginRole, 1);
      if (!candidate.exact || !group.exact) {
        throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      }
      await assertManagerLockHeld(locked.connection);
      await assertStablePrivateFileUnchanged(adminFile, options.expectedUid);
      await assertEscrowUnchanged(escrow, options.expectedUid);
      const canary = await canaryProvisionedLogin(
        options,
        admin,
        escrow,
        transport,
        dependencies,
      );
      const expected = buildProvisionReceipt(
        options,
        identity,
        escrow,
        transport,
        existing.loginRoleOid,
        existing.marker,
        group,
        canary,
        dependencies,
      );
      await assertTransportExact(transport, options, admin);
      return await publishOrValidateReceipt(receiptAuthority, expected, options.expectedUid);
    }
    if (!escrow) {
      if (initialCandidate.exists) {
        throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      }
      const group = await inspectGroupAuthority(locked.connection, groupRole, loginRole, 0);
      if (!group.exact) {
        throw new PostgresLogicalBackupLoginError("source_authority_invalid");
      }
      await assertTransportExact(transport, options, admin);
      escrow = await createEscrow(
        options,
        identity,
        admin,
        transport,
        inventorySha256,
        dependencies,
      );
    }
    if (escrow.intent.loggerInventorySha256 !== inventorySha256) {
      throw new PostgresLogicalBackupLoginError("logger_guard_failed");
    }
    await assertStablePrivateFileUnchanged(adminFile, options.expectedUid);
    await assertEscrowUnchanged(escrow, options.expectedUid);

    let roleOid: string;
    let marker: string;
    let group: GroupAuthorityState;
    if (initialCandidate.exists) {
      if (!initialCandidate.oid) {
        throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      }
      roleOid = initialCandidate.oid;
      marker = roleMarker(options.operationId, escrow.intentFile.sha256, roleOid);
      const resumed = await inspectCandidateState(
        locked.connection,
        loginRole,
        groupRole,
        marker,
        roleOid,
      );
      group = await inspectGroupAuthority(locked.connection, groupRole, loginRole, 1);
      if (!resumed.exact || !group.exact) {
        throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      }
    } else {
      await assertReceiptAuthorityUnchanged(receiptAuthority, options.expectedUid);
      await assertTransportExact(transport, options, admin);
      try {
        const provisioned = await provisionCandidateTransaction(
          locked.connection,
          identity,
          escrow,
          inventorySha256,
        );
        roleOid = provisioned.roleOid;
        marker = provisioned.marker;
        group = provisioned.group;
      } catch (error) {
        await closeConnectionExact(locked.connection);
        locked = await reconnectAdminWithLock(admin, options, transport, dependencies);
        const candidate = await inspectCandidateState(
          locked.connection,
          loginRole,
          groupRole,
          null,
        );
        if (!candidate.oid) throw error;
        roleOid = candidate.oid;
        marker = roleMarker(options.operationId, escrow.intentFile.sha256, roleOid);
        const reconciled = await inspectCandidateState(
          locked.connection,
          loginRole,
          groupRole,
          marker,
          roleOid,
        );
        group = await inspectGroupAuthority(locked.connection, groupRole, loginRole, 1);
        if (!reconciled.exact || !group.exact) throw error;
      }
    }

    await assertManagerLockHeld(locked.connection);
    await assertStablePrivateFileUnchanged(adminFile, options.expectedUid);
    await assertEscrowUnchanged(escrow, options.expectedUid);
    const canary = await canaryProvisionedLogin(
      options,
      admin,
      escrow,
      transport,
      dependencies,
    );
    const finalCandidate = await inspectCandidateState(
      locked.connection,
      loginRole,
      groupRole,
      marker,
      roleOid,
    );
    const finalGroup = await inspectGroupAuthority(locked.connection, groupRole, loginRole, 1);
    if (!finalCandidate.exact || !finalGroup.exact) {
      throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
    }
    await assertManagerLockHeld(locked.connection);
    await assertStablePrivateFileUnchanged(adminFile, options.expectedUid);
    await assertEscrowUnchanged(escrow, options.expectedUid);
    const receipt = buildProvisionReceipt(
      options,
      identity,
      escrow,
      transport,
      roleOid,
      marker,
      finalGroup,
      canary,
      dependencies,
    );
    await assertTransportExact(transport, options, admin);
    return await publishOrValidateReceipt(receiptAuthority, receipt, options.expectedUid);
  } finally {
    escrow?.urlFile.value.fill(0);
    escrow?.intentFile.value.fill(0);
    if (locked) await closeConnectionExact(locked.connection);
  }
}

function provisionIntentMatchesReceipt(
  intent: ProvisionIntent,
  receipt: PostgresLogicalBackupLoginReceipt,
): boolean {
  return receipt.operation === "provision"
    && intent.operationId === receipt.operationId
    && intent.approvalReference === receipt.approvalReference
    && intent.expectedEnvironment === receipt.expectedEnvironment
    && intent.executorUid === receipt.executorUid
    && intent.mutationArm === receipt.mutationArm
    && intent.headSha === receipt.headSha
    && intent.treeSha === receipt.treeSha
    && intent.nodeVersion === receipt.nodeVersion
    && intent.adminUrlSha256 === receipt.adminUrlSha256
    && intent.transportProfile === receipt.transportProfile
    && intent.rootCaDerSha256 === receipt.rootCaDerSha256
    && intent.databaseIdentitySha256 === receipt.databaseIdentitySha256
    && intent.databaseOid === receipt.databaseOid
    && intent.databaseNameSha256 === receipt.databaseNameSha256
    && intent.loginVersion === receipt.loginVersion
    && intent.loginRole === receipt.loginRole
    && intent.groupRole === receipt.groupRole
    && intent.escrowUrlSha256 === receipt.escrowUrlSha256;
}

async function loadRetirementEscrow(
  options: PostgresLogicalBackupLoginManagerOptions,
  identity: SourceIdentity,
  provisionReceipt: PostgresLogicalBackupLoginReceipt,
): Promise<EscrowBundle> {
  const directory = exactAbsolutePath(options.escrowDirectory);
  let stat: fs.BigIntStats;
  try {
    stat = await fs.promises.lstat(directory, { bigint: true });
    assertTrustedPrivateDirectory(stat, BigInt(options.expectedUid));
    if (await fs.promises.realpath(directory) !== directory) throw new Error("not_canonical");
  } catch {
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
  const entries = (await fs.promises.readdir(directory)).sort();
  const allowed: readonly string[] = [
    POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE,
    POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
    POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_DISABLED_FILE,
    POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_INTENT_FILE,
  ];
  if (entries.some((entry) => !allowed.includes(entry))) {
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
  let urlFile: StablePrivateFile | null = null;
  let intentFile: StablePrivateFile | null = null;
  try {
    urlFile = await readStablePrivateFile(
      path.join(directory, POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE),
      options.expectedUid,
      MAX_ADMIN_URL_BYTES,
    ).catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
    intentFile = await readStablePrivateFile(
      path.join(directory, POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE),
      options.expectedUid,
    ).catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
    const intent = parseProvisionIntent(intentFile.value);
    if (
      !provisionIntentMatchesReceipt(intent, provisionReceipt)
      || intentFile.sha256 !== provisionReceipt.escrowIntentSha256
      || identity.databaseOid !== receiptDatabaseOid(provisionReceipt)
      || identity.databaseIdentitySha256 !== provisionReceipt.databaseIdentitySha256
    ) throw new PostgresLogicalBackupLoginError("escrow_invalid");
    const url = new TextDecoder("utf-8", { fatal: true }).decode(urlFile.value).trim();
    if (!url || /[\r\n\0]/.test(url) || sha256(url) !== intent.escrowUrlSha256) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    const parsed = parseSafeAdminUrl(url);
    if (
      parsed.database !== identity.databaseName
      || parsed.username !== provisionReceipt.loginRole
      || parsed.urlSha256 !== provisionReceipt.escrowUrlSha256
    ) throw new PostgresLogicalBackupLoginError("escrow_invalid");
    const salt = Buffer.from(intent.scramSaltBase64, "base64");
    const verifier = createPostgresLogicalBackupLoginScramVerifier(parsed.password, salt);
    salt.fill(0);
    if (sha256(verifier) !== intent.scramVerifierSha256) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    return {
      directory,
      directoryIdentity: directoryIdentity(stat),
      urlFile,
      intentFile,
      intent,
      password: parsed.password,
      verifier,
    };
  } catch (error) {
    urlFile?.value.fill(0);
    intentFile?.value.fill(0);
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
}

function receiptDatabaseOid(receipt: PostgresLogicalBackupLoginReceipt): string {
  if (!exactOid(receipt.databaseOid)) {
    throw new PostgresLogicalBackupLoginError("receipt_invalid");
  }
  return receipt.databaseOid;
}

async function writeOrValidateEscrowCheckpoint(
  filePath: string,
  value: RetireIntent | RetireDisabledCheckpoint,
  expectedUid: number,
): Promise<{ sha256: string; file: StablePrivateFile }> {
  const expectedBytes = Buffer.from(canonicalPostgresBackupJson(value), "utf8");
  try {
    const existing = await fs.promises.lstat(filePath).then(() => true).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    if (existing) {
      const file = await readStablePrivateFile(filePath, expectedUid, MAX_PRIVATE_FILE_BYTES)
        .catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
      if (!file.value.equals(expectedBytes)) {
        file.value.fill(0);
        throw new PostgresLogicalBackupLoginError("escrow_invalid");
      }
      return { sha256: file.sha256, file };
    }
    const written = await writeExclusivePrivateFile(filePath, value, expectedUid)
      .catch((error) => {
        if (error instanceof PostgresLogicalBackupLoginError && error.code === "cleanup_failed") {
          throw error;
        }
        throw new PostgresLogicalBackupLoginError("escrow_invalid");
      });
    return written;
  } finally {
    expectedBytes.fill(0);
  }
}

async function disableCandidateTransaction(
  connection: PostgresLogicalBackupLoginConnection,
  identity: SourceIdentity,
  provisionReceipt: PostgresLogicalBackupLoginReceipt,
): Promise<GroupAuthorityState> {
  const loginRole = provisionReceipt.loginRole;
  const groupRole = provisionReceipt.groupRole;
  let began = false;
  try {
    await assertManagerLockHeld(connection);
    await connection.query("BEGIN");
    began = true;
    const current = await inspectCandidateState(
      connection,
      loginRole,
      groupRole,
      provisionReceipt.marker,
      provisionReceipt.loginRoleOid,
    );
    const group = await inspectGroupAuthority(connection, groupRole, loginRole, 1);
    if (!current.exact || !group.exact) {
      throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
    }
    await connection.query(`ALTER ROLE ${quoteIdentifier(loginRole)} NOLOGIN`);
    await connection.query(`ALTER ROLE ${quoteIdentifier(loginRole)} PASSWORD NULL`);
    await connection.query(
      `REVOKE ${quoteIdentifier(groupRole)} FROM ${quoteIdentifier(loginRole)}`,
    );
    await connection.query(`REVOKE CONNECT ON DATABASE ${quoteServerIdentifier(identity.databaseName)}
      FROM ${quoteIdentifier(loginRole)}`);
    await connection.query(`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system()
      FROM ${quoteIdentifier(loginRole)}`);
    const disabled = await inspectCandidateState(
      connection,
      loginRole,
      groupRole,
      provisionReceipt.marker,
      provisionReceipt.loginRoleOid,
    );
    const groupAfter = await inspectGroupAuthority(connection, groupRole, loginRole, 0, 1);
    if (!disabled.disabledExact || !groupAfter.exact) {
      throw new PostgresLogicalBackupLoginError("mutation_failed");
    }
    await assertManagerLockHeld(connection);
    await connection.query("COMMIT");
    began = false;
    return groupAfter;
  } catch (error) {
    if (began) await rollbackQuietly(connection);
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
  }
}

async function terminateCandidateSessions(
  connection: PostgresLogicalBackupLoginConnection,
  roleOid: string,
): Promise<void> {
  try {
    await connection.query(`/* pintpath:backup-login:terminate-sessions */
      SELECT pg_catalog.pg_terminate_backend(activity.pid, 5000)
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.usesysid = $1::oid
        AND activity.pid <> pg_catalog.pg_backend_pid()`, [roleOid]);
    const result = await connection.query<{ survivorCount: number }>(
      `SELECT count(*)::integer AS "survivorCount"
       FROM pg_catalog.pg_stat_activity AS activity
       WHERE activity.usesysid = $1::oid
         AND activity.pid <> pg_catalog.pg_backend_pid()`,
      [roleOid],
    );
    if (result.rows.length !== 1 || result.rows[0]?.survivorCount !== 0) {
      throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
    }
  } catch (error) {
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
  }
}

async function dropDisabledCandidateTransaction(
  connection: PostgresLogicalBackupLoginConnection,
  provisionReceipt: PostgresLogicalBackupLoginReceipt,
): Promise<GroupAuthorityState> {
  let began = false;
  try {
    await assertManagerLockHeld(connection);
    await connection.query("BEGIN");
    began = true;
    const disabled = await inspectCandidateState(
      connection,
      provisionReceipt.loginRole,
      provisionReceipt.groupRole,
      provisionReceipt.marker,
      provisionReceipt.loginRoleOid,
    );
    const group = await inspectGroupAuthority(
      connection,
      provisionReceipt.groupRole,
      provisionReceipt.loginRole,
      0,
      1,
    );
    const sessions = await connection.query<{ survivorCount: number }>(
      `SELECT count(*)::integer AS "survivorCount"
       FROM pg_catalog.pg_stat_activity AS activity
       WHERE activity.usesysid = $1::oid
         AND activity.pid <> pg_catalog.pg_backend_pid()`,
      [provisionReceipt.loginRoleOid],
    );
    if (
      !disabled.disabledExact
      || !group.exact
      || sessions.rows.length !== 1
      || sessions.rows[0]?.survivorCount !== 0
    ) throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
    await connection.query(`DROP ROLE ${quoteIdentifier(provisionReceipt.loginRole)}`);
    const absent = await inspectCandidateState(
      connection,
      provisionReceipt.loginRole,
      provisionReceipt.groupRole,
      null,
    );
    const finalGroup = await inspectGroupAuthority(
      connection,
      provisionReceipt.groupRole,
      provisionReceipt.loginRole,
      0,
    );
    if (absent.exists || !finalGroup.exact) {
      throw new PostgresLogicalBackupLoginError("mutation_failed");
    }
    await connection.query("COMMIT");
    began = false;
    return finalGroup;
  } catch (error) {
    if (began) await rollbackQuietly(connection);
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
  }
}

function exactTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value;
}

async function readCanonicalObject(
  filePath: string,
  expectedUid: number,
): Promise<{ value: Record<string, unknown>; file: StablePrivateFile }> {
  const file = await readStablePrivateFile(filePath, expectedUid, MAX_PRIVATE_FILE_BYTES)
    .catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
  const text = file.value.toString("utf8");
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || canonicalPostgresBackupJson(value) !== text) {
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    return { value, file };
  } catch (error) {
    file.value.fill(0);
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("escrow_invalid");
  }
}

async function assertPrivatePathAbsent(filePath: string): Promise<void> {
  const absent = await fs.promises.lstat(filePath).then(
    () => false,
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  if (!absent) throw new PostgresLogicalBackupLoginError("escrow_invalid");
}

function retireIntentBase(
  options: PostgresLogicalBackupLoginManagerOptions,
  provisionReceipt: PostgresLogicalBackupLoginReceipt,
  provisionReceiptSha256: string,
  transport: PostgresRailwayStockLocalhostCaTransport,
): Omit<RetireIntent, "createdAt"> {
  return {
    schemaVersion: MANAGER_SCHEMA_VERSION,
    kind: "pintpath-postgres-logical-backup-login-retire-intent",
    operationId: options.operationId,
    approvalReference: options.approvalReference,
    expectedEnvironment: options.expectedEnvironment,
    executorUid: options.expectedUid,
    mutationArm: postgresLogicalBackupLoginMutationArm(options),
    headSha: options.expectedHeadSha,
    treeSha: options.expectedTreeSha,
    nodeVersion: options.expectedNodeVersion,
    adminUrlSha256: options.expectedAdminUrlSha256,
    transportProfile: transport.profile,
    rootCaDerSha256: transport.rootCaDerSha256,
    databaseIdentitySha256: options.expectedDatabaseIdentitySha256,
    loginVersion: options.loginVersion,
    loginRole: provisionReceipt.loginRole,
    loginRoleOid: provisionReceipt.loginRoleOid,
    groupRole: provisionReceipt.groupRole,
    marker: provisionReceipt.marker,
    provisionReceiptSha256,
  };
}

async function createOrLoadRetireIntent(
  options: PostgresLogicalBackupLoginManagerOptions,
  provisionReceipt: PostgresLogicalBackupLoginReceipt,
  provisionReceiptSha256: string,
  transport: PostgresRailwayStockLocalhostCaTransport,
  dependencies: PostgresLogicalBackupLoginDependencies,
  allowCreate: boolean,
): Promise<{ value: RetireIntent; file: StablePrivateFile; sha256: string }> {
  const filePath = path.join(
    options.escrowDirectory,
    POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_INTENT_FILE,
  );
  const base = retireIntentBase(options, provisionReceipt, provisionReceiptSha256, transport);
  const existing = await fs.promises.lstat(filePath).then(() => true).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (existing) {
    const read = await readCanonicalObject(filePath, options.expectedUid);
    const expectedKeys = [...Object.keys(base), "createdAt"].sort();
    if (
      !exactKeys(read.value, expectedKeys)
      || !exactTimestamp(read.value.createdAt)
      || canonicalPostgresBackupJson(read.value)
        !== canonicalPostgresBackupJson({ ...base, createdAt: read.value.createdAt })
    ) {
      read.file.value.fill(0);
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    return {
      value: read.value as unknown as RetireIntent,
      file: read.file,
      sha256: read.file.sha256,
    };
  }
  if (!allowCreate) throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
  const value: RetireIntent = { ...base, createdAt: canonicalTimestamp(dependencies.now) };
  const written = await writeOrValidateEscrowCheckpoint(filePath, value, options.expectedUid);
  return { value, file: written.file, sha256: written.sha256 };
}

async function createOrLoadDisabledCheckpoint(
  options: PostgresLogicalBackupLoginManagerOptions,
  retireIntent: RetireIntent,
  dependencies: PostgresLogicalBackupLoginDependencies,
  allowCreate: boolean,
): Promise<{
  value: RetireDisabledCheckpoint;
  file: StablePrivateFile;
  sha256: string;
}> {
  const filePath = path.join(
    options.escrowDirectory,
    POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_DISABLED_FILE,
  );
  const base: Omit<RetireDisabledCheckpoint, "disabledAt"> = {
    ...retireIntent,
    kind: "pintpath-postgres-logical-backup-login-retire-disabled",
  };
  const existing = await fs.promises.lstat(filePath).then(() => true).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (existing) {
    const read = await readCanonicalObject(filePath, options.expectedUid);
    const expectedKeys = [...Object.keys(base), "disabledAt"].sort();
    if (
      !exactKeys(read.value, expectedKeys)
      || !exactTimestamp(read.value.disabledAt)
      || canonicalPostgresBackupJson(read.value)
        !== canonicalPostgresBackupJson({ ...base, disabledAt: read.value.disabledAt })
    ) {
      read.file.value.fill(0);
      throw new PostgresLogicalBackupLoginError("escrow_invalid");
    }
    return {
      value: read.value as unknown as RetireDisabledCheckpoint,
      file: read.file,
      sha256: read.file.sha256,
    };
  }
  if (!allowCreate) throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
  const value: RetireDisabledCheckpoint = {
    ...base,
    disabledAt: canonicalTimestamp(dependencies.now),
  };
  const written = await writeOrValidateEscrowCheckpoint(filePath, value, options.expectedUid);
  return { value, file: written.file, sha256: written.sha256 };
}

function buildRetireReceipt(
  options: PostgresLogicalBackupLoginManagerOptions,
  identity: SourceIdentity,
  provisionReceipt: PostgresLogicalBackupLoginReceipt,
  transport: PostgresRailwayStockLocalhostCaTransport,
  provisionReceiptSha256: string,
  retireIntentSha256: string,
  retireDisabledSha256: string,
  group: GroupAuthorityState,
  loggerSha256: string,
  dependencies: PostgresLogicalBackupLoginDependencies,
): PostgresLogicalBackupLoginReceipt {
  return {
    schemaVersion: MANAGER_SCHEMA_VERSION,
    kind: "pintpath-postgres-logical-backup-login",
    operation: "retire",
    status: "retired",
    createdAt: canonicalTimestamp(dependencies.now),
    operationId: options.operationId,
    approvalReference: options.approvalReference,
    expectedEnvironment: options.expectedEnvironment,
    executorUid: options.expectedUid,
    mutationArm: postgresLogicalBackupLoginMutationArm(options),
    headSha: options.expectedHeadSha,
    treeSha: options.expectedTreeSha,
    nodeVersion: options.expectedNodeVersion,
    adminUrlSha256: options.expectedAdminUrlSha256,
    transportProfile: transport.profile,
    rootCaDerSha256: transport.rootCaDerSha256,
    databaseIdentitySha256: options.expectedDatabaseIdentitySha256,
    databaseOid: identity.databaseOid,
    databaseNameSha256: sha256(identity.databaseName),
    loginVersion: provisionReceipt.loginVersion,
    loginRole: provisionReceipt.loginRole,
    loginRoleOid: provisionReceipt.loginRoleOid,
    groupRole: provisionReceipt.groupRole,
    marker: provisionReceipt.marker,
    markerSha256: provisionReceipt.markerSha256,
    escrowIntentSha256: provisionReceipt.escrowIntentSha256,
    escrowUrlSha256: provisionReceipt.escrowUrlSha256,
    loggerInventorySha256: loggerSha256,
    authorityPolicyCount: group.policyCount,
    authorityDependencyCount: group.dependencyCount,
    canary: { saslScramSha256: false, setRole: false, readOnly: false },
    provisionReceiptSha256,
    retireIntentSha256,
    retireDisabledSha256,
  };
}

function assertProvisionReceiptForRetirement(
  options: PostgresLogicalBackupLoginManagerOptions,
  receipt: PostgresLogicalBackupLoginReceipt,
  transport: PostgresRailwayStockLocalhostCaTransport,
): void {
  if (
    receipt.operation !== "provision"
    || receipt.status !== "provisioned"
    || receipt.expectedEnvironment !== options.expectedEnvironment
    || receipt.transportProfile !== transport.profile
    || receipt.rootCaDerSha256 !== transport.rootCaDerSha256
    || receipt.transportProfile !== options.transportProfile
    || receipt.rootCaDerSha256 !== options.expectedRootCaDerSha256
    || receipt.databaseIdentitySha256 !== options.expectedDatabaseIdentitySha256
    || receipt.loginVersion !== options.loginVersion
    || !Object.values(receipt.canary).every(Boolean)
  ) throw new PostgresLogicalBackupLoginError("receipt_invalid");
}

async function manageRetire(
  options: PostgresLogicalBackupLoginManagerOptions,
  adminFile: StablePrivateFile,
  admin: SafeAdminConnection,
  receiptAuthority: ReceiptAuthority,
  provisionAuthority: ReceiptAuthority,
  transport: PostgresRailwayStockLocalhostCaTransport,
  dependencies: PostgresLogicalBackupLoginDependencies,
): Promise<PostgresLogicalBackupLoginManagerResult> {
  const provisionPath = options.provisionReceiptFile;
  const provisionSha256 = options.expectedProvisionReceiptSha256;
  if (!provisionPath || !provisionSha256) {
    throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
  const provision = provisionAuthority.existing;
  if (
    provisionAuthority.path !== provisionPath
    || !provision
    || provision.file.sha256 !== provisionSha256
  ) throw new PostgresLogicalBackupLoginError("receipt_invalid");
  assertProvisionReceiptForRetirement(options, provision.receipt, transport);
  let locked: Awaited<ReturnType<typeof reconnectAdminWithLock>> | null = null;
  let escrow: EscrowBundle | null = null;
  let retireIntent: Awaited<ReturnType<typeof createOrLoadRetireIntent>> | null = null;
  let disabledCheckpoint: Awaited<ReturnType<typeof createOrLoadDisabledCheckpoint>> | null = null;
  try {
    locked = await reconnectAdminWithLock(admin, options, transport, dependencies);
    const identity = locked.identity;
    if (
      identity.databaseOid !== provision.receipt.databaseOid
      || sha256(identity.databaseName) !== provision.receipt.databaseNameSha256
      || versionedLoginRole(identity.databaseOid, options.loginVersion)
        !== provision.receipt.loginRole
      || scopedGroupRole(identity.databaseOid) !== provision.receipt.groupRole
    ) throw new PostgresLogicalBackupLoginError("receipt_invalid");
    const inventory = await inspectLoggerInventory(locked.connection);
    const inventorySha256 = loggerInventorySha256(inventory);
    escrow = await loadRetirementEscrow(
      options,
      identity,
      provision.receipt,
    );
    await assertStablePrivateFileUnchanged(adminFile, options.expectedUid);
    await assertStablePrivateFileUnchanged(provision.file, options.expectedUid)
      .catch((error) => remapPreservingCleanup(error, "receipt_invalid"));
    await assertEscrowUnchanged(escrow, options.expectedUid);

    let candidate = await inspectCandidateState(
      locked.connection,
      provision.receipt.loginRole,
      provision.receipt.groupRole,
      provision.receipt.marker,
      provision.receipt.loginRoleOid,
    );
    const expectedChildren: 0 | 1 = candidate.exact ? 1 : 0;
    let group = await inspectGroupAuthority(
      locked.connection,
      provision.receipt.groupRole,
      provision.receipt.loginRole,
      expectedChildren,
      candidate.exists ? 1 : 0,
    );
    if (
      !group.exact
      || (candidate.exists && !candidate.exact && !candidate.disabledExact)
    ) throw new PostgresLogicalBackupLoginError("mutation_ambiguous");

    const retireIntentPath = path.join(
      options.escrowDirectory,
      POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_INTENT_FILE,
    );
    const disabledCheckpointPath = path.join(
      options.escrowDirectory,
      POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_DISABLED_FILE,
    );
    const retireIntentExists = await fs.promises.lstat(retireIntentPath)
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new PostgresLogicalBackupLoginError("escrow_invalid");
      });
    const disabledCheckpointExists = await fs.promises.lstat(disabledCheckpointPath)
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new PostgresLogicalBackupLoginError("escrow_invalid");
      });
    if (retireIntentExists) {
      retireIntent = await createOrLoadRetireIntent(
        options,
        provision.receipt,
        provisionSha256,
        transport,
        dependencies,
        false,
      );
    }
    if (disabledCheckpointExists) {
      if (!retireIntent) throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      disabledCheckpoint = await createOrLoadDisabledCheckpoint(
        options,
        retireIntent.value,
        dependencies,
        false,
      );
    }

    // Retirement is forward-only. Exact active, exact disabled, and absent are
    // the only accepted phases; checkpoint files may never imply a phase ahead
    // of the live catalog authority.
    if (candidate.exact) {
      if (disabledCheckpoint || receiptAuthority.existing) {
        throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      }
      if (!retireIntent) {
        await assertTransportExact(transport, options, admin);
        retireIntent = await createOrLoadRetireIntent(
          options,
          provision.receipt,
          provisionSha256,
          transport,
          dependencies,
          true,
        );
      }
    } else if (candidate.disabledExact) {
      if (!retireIntent || receiptAuthority.existing) {
        throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      }
    } else if (!candidate.exists) {
      if (!retireIntent || !disabledCheckpoint) {
        throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      }
    } else {
      throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
    }

    if (candidate.exact) {
      await assertReceiptAuthorityUnchanged(receiptAuthority, options.expectedUid);
      await assertStablePrivateFileUnchanged(retireIntent.file, options.expectedUid)
        .catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
      await assertPrivatePathAbsent(disabledCheckpointPath);
      await assertTransportExact(transport, options, admin);
      try {
        group = await disableCandidateTransaction(
          locked.connection,
          identity,
          provision.receipt,
        );
      } catch (error) {
        await closeConnectionExact(locked.connection);
        locked = await reconnectAdminWithLock(admin, options, transport, dependencies);
        candidate = await inspectCandidateState(
          locked.connection,
          provision.receipt.loginRole,
          provision.receipt.groupRole,
          provision.receipt.marker,
          provision.receipt.loginRoleOid,
        );
        group = await inspectGroupAuthority(
          locked.connection,
          provision.receipt.groupRole,
          provision.receipt.loginRole,
          0,
          1,
        );
        if (!candidate.disabledExact || !group.exact) throw error;
      }
      candidate = await inspectCandidateState(
        locked.connection,
        provision.receipt.loginRole,
        provision.receipt.groupRole,
        provision.receipt.marker,
        provision.receipt.loginRoleOid,
      );
    }

    if (candidate.exists) {
      if (!candidate.disabledExact) {
        throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      }
      await assertReceiptAuthorityUnchanged(receiptAuthority, options.expectedUid);
      await assertStablePrivateFileUnchanged(retireIntent.file, options.expectedUid)
        .catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
      if (disabledCheckpoint) {
        await assertStablePrivateFileUnchanged(disabledCheckpoint.file, options.expectedUid)
          .catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
      } else {
        await assertPrivatePathAbsent(disabledCheckpointPath);
      }
      await assertTransportExact(transport, options, admin);
      await terminateCandidateSessions(locked.connection, provision.receipt.loginRoleOid);
      const afterTermination = await inspectCandidateState(
        locked.connection,
        provision.receipt.loginRole,
        provision.receipt.groupRole,
        provision.receipt.marker,
        provision.receipt.loginRoleOid,
      );
      if (!afterTermination.disabledExact) {
        throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      }
      if (!disabledCheckpoint) {
        await assertTransportExact(transport, options, admin);
        disabledCheckpoint = await createOrLoadDisabledCheckpoint(
          options,
          retireIntent.value,
          dependencies,
          true,
        );
      }
      await assertManagerLockHeld(locked.connection);
      await assertStablePrivateFileUnchanged(adminFile, options.expectedUid);
      await assertStablePrivateFileUnchanged(provision.file, options.expectedUid)
        .catch((error) => remapPreservingCleanup(error, "receipt_invalid"));
      await assertEscrowUnchanged(escrow, options.expectedUid);
      await assertStablePrivateFileUnchanged(retireIntent.file, options.expectedUid)
        .catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
      await assertStablePrivateFileUnchanged(disabledCheckpoint.file, options.expectedUid)
        .catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
      await assertReceiptAuthorityUnchanged(receiptAuthority, options.expectedUid);
      await assertTransportExact(transport, options, admin);
      try {
        group = await dropDisabledCandidateTransaction(locked.connection, provision.receipt);
      } catch (error) {
        await closeConnectionExact(locked.connection);
        locked = await reconnectAdminWithLock(admin, options, transport, dependencies);
        const reconciled = await inspectCandidateState(
          locked.connection,
          provision.receipt.loginRole,
          provision.receipt.groupRole,
          provision.receipt.marker,
          provision.receipt.loginRoleOid,
        );
        if (reconciled.disabledExact) {
          await assertTransportExact(transport, options, admin);
          group = await dropDisabledCandidateTransaction(locked.connection, provision.receipt);
        } else if (!reconciled.exists) {
          group = await inspectGroupAuthority(
            locked.connection,
            provision.receipt.groupRole,
            provision.receipt.loginRole,
            0,
          );
          if (!group.exact) throw error;
        } else {
          throw error;
        }
      }
    } else {
      if (!disabledCheckpoint) {
        throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
      }
    }

    const absent = await inspectCandidateState(
      locked.connection,
      provision.receipt.loginRole,
      provision.receipt.groupRole,
      null,
    );
    group = await inspectGroupAuthority(
      locked.connection,
      provision.receipt.groupRole,
      provision.receipt.loginRole,
      0,
    );
    if (absent.exists || !group.exact) {
      throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
    }
    await assertManagerLockHeld(locked.connection);
    await assertStablePrivateFileUnchanged(adminFile, options.expectedUid);
    await assertStablePrivateFileUnchanged(provision.file, options.expectedUid)
      .catch((error) => remapPreservingCleanup(error, "receipt_invalid"));
    await assertEscrowUnchanged(escrow, options.expectedUid);
    await assertStablePrivateFileUnchanged(retireIntent.file, options.expectedUid)
      .catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
    await assertStablePrivateFileUnchanged(disabledCheckpoint.file, options.expectedUid)
      .catch((error) => remapPreservingCleanup(error, "escrow_invalid"));
    const receipt = buildRetireReceipt(
      options,
      identity,
      provision.receipt,
      transport,
      provisionSha256,
      retireIntent.sha256,
      disabledCheckpoint.sha256,
      group,
      inventorySha256,
      dependencies,
    );
    await assertTransportExact(transport, options, admin);
    return await publishOrValidateReceipt(receiptAuthority, receipt, options.expectedUid);
  } finally {
    escrow?.urlFile.value.fill(0);
    escrow?.intentFile.value.fill(0);
    retireIntent?.file.value.fill(0);
    disabledCheckpoint?.file.value.fill(0);
    if (locked) await closeConnectionExact(locked.connection);
  }
}

export async function managePostgresLogicalBackupLogin(
  options: PostgresLogicalBackupLoginManagerOptions,
  overrides: Partial<PostgresLogicalBackupLoginDependencies> = {},
): Promise<PostgresLogicalBackupLoginManagerResult> {
  validateOptions(options);
  const dependencies: PostgresLogicalBackupLoginDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  await validateHostGates(options, dependencies);
  let adminFile: HeldStablePrivateFile | null = null;
  let receiptAuthority: ReceiptAuthority | null = null;
  let provisionAuthority: ReceiptAuthority | null = null;
  let transport: PostgresRailwayStockLocalhostCaTransport | null = null;
  try {
    adminFile = await openStablePrivateFile(
      options.adminConnectionFile,
      options.expectedUid,
      MAX_ADMIN_URL_BYTES,
    );
    const adminUrl = decodeConnectionFile(adminFile);
    const admin = parseSafeAdminUrl(adminUrl);
    if (admin.urlSha256 !== options.expectedAdminUrlSha256) {
      throw new PostgresLogicalBackupLoginError("unsafe_admin_connection_url");
    }
    receiptAuthority = await preflightReceiptAuthority(
      options.receiptFile,
      options.expectedUid,
    );
    if (options.operation === "retire") {
      if (!options.provisionReceiptFile || !options.expectedProvisionReceiptSha256) {
        throw new PostgresLogicalBackupLoginError("invalid_arguments");
      }
      provisionAuthority = await preflightReceiptAuthority(
        options.provisionReceiptFile,
        options.expectedUid,
        options.expectedProvisionReceiptSha256,
        true,
      );
    }
    try {
      transport = await dependencies.openTransport({
        profile: options.transportProfile,
        rootCaFile: options.rootCaFile,
        expectedRootCaDerSha256: options.expectedRootCaDerSha256,
        expectedUid: options.expectedUid,
        sourceUrlAuthority: { hostname: admin.host, port: admin.port },
      });
    } catch (error) {
      if (isRecord(error) && error.code === "cleanup_failed") {
        throw new PostgresLogicalBackupLoginError("cleanup_failed");
      }
      throw new PostgresLogicalBackupLoginError("source_authority_invalid");
    }
    await assertTransportExact(transport, options, admin);
    return options.operation === "provision"
      ? await manageProvision(
        options,
        adminFile,
        admin,
        receiptAuthority,
        transport,
        dependencies,
      )
      : await manageRetire(
        options,
        adminFile,
        admin,
        receiptAuthority,
        provisionAuthority!,
        transport,
        dependencies,
      );
  } catch (error) {
    if (error instanceof PostgresLogicalBackupLoginError) throw error;
    throw new PostgresLogicalBackupLoginError("mutation_ambiguous");
  } finally {
    let cleanupFailed = false;
    if (transport) {
      try {
        await closeTransportExact(transport);
      } catch {
        cleanupFailed = true;
      }
    }
    if (provisionAuthority) {
      try {
        await closeReceiptAuthority(provisionAuthority);
      } catch {
        cleanupFailed = true;
      }
    }
    if (receiptAuthority) {
      try {
        await closeReceiptAuthority(receiptAuthority);
      } catch {
        cleanupFailed = true;
      }
    }
    if (adminFile) {
      try {
        await closeHeldStablePrivateFile(adminFile);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new PostgresLogicalBackupLoginError("cleanup_failed");
  }
}
