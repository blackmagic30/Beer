import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, type ClientConfig, type QueryResultRow } from "pg";

import { canonicalPostgresBackupJson } from "./postgres-logical-backup.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  openPostgresRailwayStockLocalhostCaTransport,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "./postgres-railway-stock-localhost-ca.js";

export const STAGING_POSTGRES_BACKUP_CANARY_LOCK = Object.freeze({
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  serviceId: "bb84fecc-a125-49ce-853f-d2f25f7019c5",
  serviceName: "postgres-backup-canary-2d276b6",
  postgresServiceId: "c454955f-263b-4599-aee0-dc447a4d3d15",
  postgresResource:
    "railway:a4e0f507-d6d3-4df9-a818-ad92c0071a35:c454955f-263b-4599-aee0-dc447a4d3d15",
  railwayConfigPath: "/railway.postgres-backup-canary.toml",
  hostname: "postgres-staging.railway.internal",
  port: 5_432,
  database: "pintpath_staging",
  administrator: "postgres",
  transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  rootCaDerSha256:
    "7f57985264fc79c7e85a8c0a5a954b538dd47d5d7f1481c0eb30908acd999ba9",
} as const);

export const STAGING_POSTGRES_BACKUP_CANARY_SCHEMA =
  "pintpath-staging-postgres-backup-canary/v1" as const;
export const STAGING_POSTGRES_BACKUP_CANARY_SCOPE =
  "permanent-staging-postgres-backup-authority-candidates" as const;
export const STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV =
  "STAGING_POSTGRES_CA_CANARY_ADMIN_URL" as const;
export const STAGING_POSTGRES_BACKUP_CANARY_ROOT_CA_ENV =
  "STAGING_POSTGRES_CA_CANARY_ROOT_CA_PEM" as const;
export const STAGING_POSTGRES_BACKUP_CANARY_CONFIG_PATH_ENV =
  "STAGING_POSTGRES_CA_CANARY_RAILWAY_CONFIG_PATH" as const;

const APPLICATION_NAME = "pintpath-staging-postgres-backup-canary";
const MAX_ADMIN_URL_BYTES = 16 * 1_024;
const MAX_ROOT_CA_BYTES = 64 * 1_024;
const CONNECTION_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 15_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYSTEM_IDENTIFIER_PATTERN = /^[1-9][0-9]{0,19}$/;
const DATABASE_OID_PATTERN = /^[1-9][0-9]{0,9}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_POSTGRES_OID = 4_294_967_295n;
const TEMPORARY_DIRECTORY_PREFIX = "pintpath-staging-postgres-ca-canary-";
const ROOT_CA_FILE_NAME = "root-ca.pem";
const FORBIDDEN_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "DATABASE_URL",
  "DEBUG",
  "DEBUG_FD",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "OPENSSL_CONF",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "all_proxy",
  "https_proxy",
  "http_proxy",
]);

export type StagingPostgresBackupCanaryFailureCode =
  | "configuration_invalid"
  | "source_authority_invalid"
  | "source_query_failed"
  | "cleanup_failed";

export class StagingPostgresBackupCanaryError extends Error {
  readonly code: StagingPostgresBackupCanaryFailureCode;

  constructor(code: StagingPostgresBackupCanaryFailureCode) {
    super(code);
    this.name = "StagingPostgresBackupCanaryError";
    this.code = code;
  }
}

interface CanaryIdentity {
  railwayProject: boolean;
  railwayEnvironment: boolean;
  railwayService: boolean;
  railwayServiceName: boolean;
  railwayDeployment: boolean;
  dedicatedRailwayConfig: boolean;
  forbiddenEnvironmentAbsent: boolean;
  adminUrlAuthority: boolean;
  rootCaAuthority: boolean;
  transportAuthority: boolean;
  tlsScram: boolean;
  readOnlyTransaction: boolean;
  stagingDatabase: boolean;
  administrator: boolean;
}

interface CanaryCandidates {
  adminUrlSha256: string | null;
  databaseIdentitySha256: string | null;
}

export interface StagingPostgresBackupCanaryReceipt {
  schemaVersion: typeof STAGING_POSTGRES_BACKUP_CANARY_SCHEMA;
  scope: typeof STAGING_POSTGRES_BACKUP_CANARY_SCOPE;
  outcome: "passed" | "failed";
  deploymentId: string | null;
  transport: {
    profile: typeof POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE;
    rootCaDerSha256: string;
  };
  candidates: CanaryCandidates;
  identity: CanaryIdentity;
}

interface SafeAdminConnection {
  readonly urlSha256: string;
  readonly hostname: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
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

export interface StagingPostgresBackupCanaryConnection {
  readonly authenticationMethod: "scram-sha-256" | "other" | "unknown";
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  close(): Promise<void>;
}

export interface StagingPostgresBackupCanaryDependencies {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly getUid: () => number | null;
  readonly getEuid: () => number | null;
  readonly temporaryRoot: () => string;
  readonly openTransport: (
    options: OpenPostgresRailwayStockLocalhostCaTransportOptions,
  ) => Promise<PostgresRailwayStockLocalhostCaTransport>;
  readonly connect: (
    config: ClientConfig,
  ) => Promise<StagingPostgresBackupCanaryConnection>;
  readonly writeOutput: (output: string) => void;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
}

interface MaterializedRootCa {
  readonly directoryPath: string;
  readonly filePath: string;
  readonly directoryHandle: fs.promises.FileHandle;
  readonly fileHandle: fs.promises.FileHandle;
  readonly directoryIdentity: DirectoryIdentity;
  readonly fileIdentity: FileIdentity;
}

class DirectCanaryConnection implements StagingPostgresBackupCanaryConnection {
  private method: "scram-sha-256" | "other" | "unknown" = "unknown";
  private fatal = false;

  private constructor(private readonly client: Client) {}

  static async connect(config: ClientConfig): Promise<DirectCanaryConnection> {
    const client = new Client(config);
    const connection = new DirectCanaryConnection(client);
    client.on("error", () => { connection.fatal = true; });
    const wire = (client as unknown as {
      connection?: { on: (name: string, listener: () => void) => void };
    }).connection;
    wire?.on("authenticationSASL", () => { connection.method = "scram-sha-256"; });
    wire?.on("authenticationSASLContinue", () => {
      connection.method = "scram-sha-256";
    });
    for (const event of ["authenticationCleartextPassword", "authenticationMD5Password"]) {
      wire?.on(event, () => { connection.method = "other"; });
    }
    try {
      await client.connect();
      if (connection.fatal) {
        throw new StagingPostgresBackupCanaryError("source_authority_invalid");
      }
      return connection;
    } catch {
      try {
        await client.end();
      } catch {
        throw new StagingPostgresBackupCanaryError("cleanup_failed");
      }
      throw new StagingPostgresBackupCanaryError("source_authority_invalid");
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
      throw new StagingPostgresBackupCanaryError("source_authority_invalid");
    }
    try {
      const result = await this.client.query<Row>(text, [...values]);
      if (this.fatal) {
        throw new StagingPostgresBackupCanaryError("source_authority_invalid");
      }
      return { rows: result.rows, rowCount: result.rowCount };
    } catch {
      throw new StagingPostgresBackupCanaryError(
        this.fatal ? "source_authority_invalid" : "source_query_failed",
      );
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.end();
    } catch {
      throw new StagingPostgresBackupCanaryError("cleanup_failed");
    }
  }
}

const DEFAULT_DEPENDENCIES: StagingPostgresBackupCanaryDependencies = {
  argv: process.argv.slice(2),
  env: process.env,
  getUid: () => process.getuid?.() ?? null,
  getEuid: () => process.geteuid?.() ?? null,
  temporaryRoot: () => os.tmpdir(),
  openTransport: (options) => openPostgresRailwayStockLocalhostCaTransport(options),
  connect: (config) => DirectCanaryConnection.connect(config),
  writeOutput: (output) => process.stdout.write(output),
};

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stagingPostgresBackupDatabaseIdentitySha256(identity: {
  readonly systemIdentifier: string;
  readonly databaseOid: string;
  readonly databaseName: string;
  readonly serverVersionNum: string;
}): string {
  return sha256(canonicalPostgresBackupJson({
    kind: "pintpath-postgres-logical-source-database",
    version: 1,
    systemIdentifier: identity.systemIdentifier,
    databaseOid: identity.databaseOid,
    databaseName: identity.databaseName,
    serverVersionNum: identity.serverVersionNum,
  }));
}

function emptyIdentity(): CanaryIdentity {
  return {
    railwayProject: false,
    railwayEnvironment: false,
    railwayService: false,
    railwayServiceName: false,
    railwayDeployment: false,
    dedicatedRailwayConfig: false,
    forbiddenEnvironmentAbsent: false,
    adminUrlAuthority: false,
    rootCaAuthority: false,
    transportAuthority: false,
    tlsScram: false,
    readOnlyTransaction: false,
    stagingDatabase: false,
    administrator: false,
  };
}

function failedCandidates(): CanaryCandidates {
  return { adminUrlSha256: null, databaseIdentitySha256: null };
}

function fixedReceipt(
  deploymentId: string | null,
  identity: CanaryIdentity,
  candidates: CanaryCandidates,
): StagingPostgresBackupCanaryReceipt {
  const passed = Object.values(identity).every((value) => value === true)
    && SHA256_PATTERN.test(candidates.adminUrlSha256 ?? "")
    && SHA256_PATTERN.test(candidates.databaseIdentitySha256 ?? "");
  return {
    schemaVersion: STAGING_POSTGRES_BACKUP_CANARY_SCHEMA,
    scope: STAGING_POSTGRES_BACKUP_CANARY_SCOPE,
    outcome: passed ? "passed" : "failed",
    deploymentId,
    transport: {
      profile: STAGING_POSTGRES_BACKUP_CANARY_LOCK.transportProfile,
      rootCaDerSha256: STAGING_POSTGRES_BACKUP_CANARY_LOCK.rootCaDerSha256,
    },
    candidates: passed ? candidates : failedCandidates(),
    identity,
  };
}

function exactEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  maximumBytes: number,
): string {
  const value = env[name];
  return typeof value === "string"
      && value.length > 0
      && Buffer.byteLength(value, "utf8") <= maximumBytes
      && value === value.trim()
      && !/[\u0000\r\n]/.test(value)
    ? value
    : "";
}

function forbiddenEnvironmentAbsent(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return Object.entries(env).every(([name, value]) => {
    if (value === undefined || value === "") return true;
    return !name.toUpperCase().startsWith("PG")
      && !FORBIDDEN_ENVIRONMENT_KEYS.has(name);
  });
}

function decodeUrlComponent(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes("\0") && !/[\r\n]/.test(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function parseAdminUrl(value: string): SafeAdminConnection {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new StagingPostgresBackupCanaryError("configuration_invalid");
  }
  const entries = [...parsed.searchParams.entries()];
  const database = decodeUrlComponent(
    parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : "",
  );
  const username = decodeUrlComponent(parsed.username);
  const password = decodeUrlComponent(parsed.password);
  const port = Number(parsed.port || "5432");
  if (
    parsed.protocol !== "postgresql:"
    || parsed.hostname !== STAGING_POSTGRES_BACKUP_CANARY_LOCK.hostname
    || port !== STAGING_POSTGRES_BACKUP_CANARY_LOCK.port
    || database !== STAGING_POSTGRES_BACKUP_CANARY_LOCK.database
    || username !== STAGING_POSTGRES_BACKUP_CANARY_LOCK.administrator
    || !password
    || password.length > 1_024
    || parsed.hash !== ""
    || entries.length !== 1
    || entries[0]?.[0] !== "sslmode"
    || entries[0]?.[1] !== "verify-full"
  ) throw new StagingPostgresBackupCanaryError("configuration_invalid");
  return {
    urlSha256: sha256(value),
    hostname: parsed.hostname,
    port,
    database,
    username,
    password,
  };
}

function fileIdentity(stat: fs.BigIntStats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
  };
}

function directoryIdentity(stat: fs.BigIntStats): DirectoryIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactFile(stat: fs.BigIntStats, uid: number, expectedSize: number): boolean {
  return stat.isFile()
    && stat.uid === BigInt(uid)
    && (stat.mode & 0o777n) === 0o600n
    && stat.nlink === 1n
    && stat.size === BigInt(expectedSize);
}

function exactDirectory(stat: fs.BigIntStats, uid: number): boolean {
  return stat.isDirectory()
    && stat.uid === BigInt(uid)
    && (stat.mode & 0o777n) === 0o700n;
}

async function materializeRootCa(
  pem: Buffer,
  uid: number,
  temporaryRoot: string,
): Promise<MaterializedRootCa> {
  let directoryPath: string | null = null;
  let filePath: string | null = null;
  let directoryHandle: fs.promises.FileHandle | null = null;
  let fileHandle: fs.promises.FileHandle | null = null;
  let directorySnapshot: DirectoryIdentity | null = null;
  let fileSnapshot: FileIdentity | null = null;
  try {
    const realTemporaryRoot = await fs.promises.realpath(temporaryRoot);
    if (!path.isAbsolute(realTemporaryRoot) || path.normalize(realTemporaryRoot) !== realTemporaryRoot) {
      throw new StagingPostgresBackupCanaryError("configuration_invalid");
    }
    directoryPath = await fs.promises.mkdtemp(
      path.join(realTemporaryRoot, TEMPORARY_DIRECTORY_PREFIX),
    );
    await fs.promises.chmod(directoryPath, 0o700);
    directoryHandle = await fs.promises.open(
      directoryPath,
      fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY ?? 0)
        | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const directoryStat = await directoryHandle.stat({ bigint: true });
    if (!exactDirectory(directoryStat, uid)) {
      throw new StagingPostgresBackupCanaryError("configuration_invalid");
    }
    directorySnapshot = directoryIdentity(directoryStat);
    filePath = path.join(directoryPath, ROOT_CA_FILE_NAME);
    fileHandle = await fs.promises.open(
      filePath,
      fs.constants.O_RDWR
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await fileHandle.chmod(0o600);
    const created = await fileHandle.stat({ bigint: true });
    if (!exactFile(created, uid, 0)) {
      throw new StagingPostgresBackupCanaryError("configuration_invalid");
    }
    fileSnapshot = fileIdentity(created);
    await fileHandle.writeFile(pem);
    await fileHandle.sync();
    await directoryHandle.sync();
    const [written, pathStat, directoryAfter] = await Promise.all([
      fileHandle.stat({ bigint: true }),
      fs.promises.lstat(filePath, { bigint: true }),
      fs.promises.lstat(directoryPath, { bigint: true }),
    ]);
    if (
      !exactFile(written, uid, pem.byteLength)
      || !exactFile(pathStat, uid, pem.byteLength)
      || !sameFile(fileSnapshot, fileIdentity(written))
      || !sameFile(fileIdentity(written), fileIdentity(pathStat))
      || !exactDirectory(directoryAfter, uid)
      || !sameDirectory(directorySnapshot, directoryIdentity(directoryAfter))
    ) throw new StagingPostgresBackupCanaryError("configuration_invalid");
    return {
      directoryPath,
      filePath,
      directoryHandle,
      fileHandle,
      directoryIdentity: directorySnapshot,
      fileIdentity: fileIdentity(written),
    };
  } catch (error) {
    let cleanupExact = true;
    if (filePath && fileHandle) {
      try {
        const held = await fileHandle.stat({ bigint: true });
        const atPath = await fs.promises.lstat(filePath, { bigint: true });
        if (held.dev === atPath.dev && held.ino === atPath.ino) {
          await fs.promises.unlink(filePath);
        } else cleanupExact = false;
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") cleanupExact = false;
      }
    }
    try { await fileHandle?.close(); } catch { cleanupExact = false; }
    try { await directoryHandle?.close(); } catch { cleanupExact = false; }
    if (directoryPath) {
      try { await fs.promises.rmdir(directoryPath); } catch { cleanupExact = false; }
    }
    if (!cleanupExact) throw new StagingPostgresBackupCanaryError("cleanup_failed");
    if (error instanceof StagingPostgresBackupCanaryError) throw error;
    throw new StagingPostgresBackupCanaryError("configuration_invalid");
  }
}

async function cleanupRootCa(resource: MaterializedRootCa, uid: number): Promise<void> {
  let exact = true;
  try {
    const [held, atPath] = await Promise.all([
      resource.fileHandle.stat({ bigint: true }),
      fs.promises.lstat(resource.filePath, { bigint: true }),
    ]);
    const heldIdentity = fileIdentity(held);
    const pathIdentity = fileIdentity(atPath);
    const unchanged = exactFile(held, uid, Number(resource.fileIdentity.size))
      && exactFile(atPath, uid, Number(resource.fileIdentity.size))
      && sameFile(resource.fileIdentity, heldIdentity)
      && sameFile(heldIdentity, pathIdentity);
    if (!sameFile(heldIdentity, pathIdentity)) {
      exact = false;
    } else {
      await fs.promises.unlink(resource.filePath);
      const unlinked = await resource.fileHandle.stat({ bigint: true });
      if (unlinked.nlink !== 0n || !unchanged) exact = false;
    }
  } catch {
    exact = false;
  }
  try { await resource.fileHandle.close(); } catch { exact = false; }
  try {
    const [held, atPath, entries] = await Promise.all([
      resource.directoryHandle.stat({ bigint: true }),
      fs.promises.lstat(resource.directoryPath, { bigint: true }),
      fs.promises.readdir(resource.directoryPath),
    ]);
    if (
      !exactDirectory(held, uid)
      || !exactDirectory(atPath, uid)
      || !sameDirectory(resource.directoryIdentity, directoryIdentity(held))
      || !sameDirectory(directoryIdentity(held), directoryIdentity(atPath))
      || entries.length !== 0
    ) {
      exact = false;
    } else {
      await fs.promises.rmdir(resource.directoryPath);
    }
  } catch {
    exact = false;
  }
  try { await resource.directoryHandle.close(); } catch { exact = false; }
  if (!exact) throw new StagingPostgresBackupCanaryError("cleanup_failed");
}

function safeConfiguration(
  dependencies: StagingPostgresBackupCanaryDependencies,
  identity: CanaryIdentity,
): {
  deploymentId: string | null;
  admin: SafeAdminConnection | null;
  rootCaPem: Buffer | null;
  uid: number | null;
} {
  const { env } = dependencies;
  identity.railwayProject = exactEnvironment(env, "RAILWAY_PROJECT_ID", 128)
    === STAGING_POSTGRES_BACKUP_CANARY_LOCK.projectId;
  identity.railwayEnvironment = exactEnvironment(env, "RAILWAY_ENVIRONMENT_ID", 128)
    === STAGING_POSTGRES_BACKUP_CANARY_LOCK.environmentId;
  identity.railwayService = exactEnvironment(env, "RAILWAY_SERVICE_ID", 128)
    === STAGING_POSTGRES_BACKUP_CANARY_LOCK.serviceId;
  identity.railwayServiceName = exactEnvironment(env, "RAILWAY_SERVICE_NAME", 128)
    === STAGING_POSTGRES_BACKUP_CANARY_LOCK.serviceName;
  const deploymentId = exactEnvironment(env, "RAILWAY_DEPLOYMENT_ID", 128);
  identity.railwayDeployment = UUID_PATTERN.test(deploymentId);
  identity.dedicatedRailwayConfig = dependencies.argv.length === 0
    && exactEnvironment(env, STAGING_POSTGRES_BACKUP_CANARY_CONFIG_PATH_ENV, 128)
      === STAGING_POSTGRES_BACKUP_CANARY_LOCK.railwayConfigPath;
  identity.forbiddenEnvironmentAbsent = forbiddenEnvironmentAbsent(env);

  const adminUrl = env[STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV];
  const rootCa = env[STAGING_POSTGRES_BACKUP_CANARY_ROOT_CA_ENV];
  let environmentCleared = true;
  try {
    delete env[STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV];
    delete env[STAGING_POSTGRES_BACKUP_CANARY_ROOT_CA_ENV];
    environmentCleared = env[STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV] === undefined
      && env[STAGING_POSTGRES_BACKUP_CANARY_ROOT_CA_ENV] === undefined;
  } catch {
    environmentCleared = false;
  }
  let uid: number | null = null;
  let euid: number | null = null;
  try {
    uid = dependencies.getUid();
    euid = dependencies.getEuid();
  } catch {
    uid = null;
    euid = null;
  }
  let admin: SafeAdminConnection | null = null;
  let rootCaPem: Buffer | null = null;
  try {
    if (
      typeof adminUrl !== "string"
      || adminUrl !== adminUrl.trim()
      || Buffer.byteLength(adminUrl, "utf8") > MAX_ADMIN_URL_BYTES
      || /[\u0000\r\n]/.test(adminUrl)
      || typeof rootCa !== "string"
      || rootCa.length === 0
      || Buffer.byteLength(rootCa, "utf8") > MAX_ROOT_CA_BYTES
      || rootCa.includes("\0")
    ) throw new StagingPostgresBackupCanaryError("configuration_invalid");
    admin = parseAdminUrl(adminUrl);
    identity.adminUrlAuthority = true;
    rootCaPem = Buffer.from(rootCa, "utf8");
    identity.rootCaAuthority = rootCaPem.byteLength > 0;
  } catch {
    admin = null;
    rootCaPem?.fill(0);
    rootCaPem = null;
  }
  const baseExact = identity.railwayProject
    && identity.railwayEnvironment
    && identity.railwayService
    && identity.railwayServiceName
    && identity.railwayDeployment
    && identity.dedicatedRailwayConfig
    && identity.forbiddenEnvironmentAbsent
    && identity.adminUrlAuthority
    && identity.rootCaAuthority
    && environmentCleared
    && uid !== null
    && uid === euid;
  if (!baseExact) {
    rootCaPem?.fill(0);
    rootCaPem = null;
  }
  return {
    deploymentId: UUID_PATTERN.test(deploymentId) ? deploymentId : null,
    admin: baseExact ? admin : null,
    rootCaPem: baseExact ? rootCaPem : null,
    uid: baseExact ? uid : null,
  };
}

function validOid(value: string): boolean {
  if (!DATABASE_OID_PATTERN.test(value)) return false;
  try { return BigInt(value) <= MAX_POSTGRES_OID; } catch { return false; }
}

function exactReturnedTransport(
  transport: PostgresRailwayStockLocalhostCaTransport,
  expectedPemSha256: string,
): boolean {
  return transport.profile === STAGING_POSTGRES_BACKUP_CANARY_LOCK.transportProfile
    && transport.rootCaDerSha256 === STAGING_POSTGRES_BACKUP_CANARY_LOCK.rootCaDerSha256
    && transport.sourceUrlAuthority.hostname === STAGING_POSTGRES_BACKUP_CANARY_LOCK.hostname
    && transport.sourceUrlAuthority.port === STAGING_POSTGRES_BACKUP_CANARY_LOCK.port
    && transport.nodeConnection.host === transport.resolvedAddress
    && transport.nodeConnection.port === STAGING_POSTGRES_BACKUP_CANARY_LOCK.port
    && typeof transport.nodeConnection.ssl.ca === "string"
    && sha256(transport.nodeConnection.ssl.ca) === expectedPemSha256
    && transport.nodeConnection.ssl.servername === "localhost"
    && transport.nodeConnection.ssl.rejectUnauthorized === true
    && transport.nodeConnection.ssl.minVersion === "TLSv1.2"
    && typeof transport.nodeConnection.ssl.checkServerIdentity === "function";
}

async function inspectSource(
  connection: StagingPostgresBackupCanaryConnection,
  identity: CanaryIdentity,
): Promise<string> {
  await connection.query("/* pintpath:staging-backup-canary:begin */ BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let transactionOpen = true;
  try {
    const result = await connection.query<SourceIdentityRow>(`/* pintpath:staging-backup-canary:source-identity */
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
    const row = result.rows[0];
    identity.readOnlyTransaction = row?.transactionReadOnly === true;
    identity.stagingDatabase = result.rows.length === 1
      && Boolean(row)
      && SYSTEM_IDENTIFIER_PATTERN.test(row!.systemIdentifier)
      && validOid(row!.databaseOid)
      && row!.databaseName === STAGING_POSTGRES_BACKUP_CANARY_LOCK.database
      && /^17[0-9]{4}$/.test(row!.serverVersionNum)
      && row!.inRecovery === false;
    identity.administrator = Boolean(row)
      && row!.adminRole === STAGING_POSTGRES_BACKUP_CANARY_LOCK.administrator
      && row!.currentRole === row!.adminRole
      && row!.adminCanLogin === true
      && row!.adminSuperuser === true;
    if (!row || !identity.readOnlyTransaction || !identity.stagingDatabase || !identity.administrator) {
      throw new StagingPostgresBackupCanaryError("source_authority_invalid");
    }
    const hash = stagingPostgresBackupDatabaseIdentitySha256(row);
    await connection.query("/* pintpath:staging-backup-canary:rollback */ ROLLBACK");
    transactionOpen = false;
    return hash;
  } finally {
    if (transactionOpen) {
      try {
        await connection.query("/* pintpath:staging-backup-canary:rollback */ ROLLBACK");
      } catch {
        throw new StagingPostgresBackupCanaryError("cleanup_failed");
      }
    }
  }
}

export async function runStagingPostgresBackupCanary(
  dependencyOverrides: Partial<StagingPostgresBackupCanaryDependencies> = {},
): Promise<number> {
  const dependencies: StagingPostgresBackupCanaryDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const identity = emptyIdentity();
  let deploymentId: string | null = null;
  let candidates = failedCandidates();
  let rootCaPem: Buffer | null = null;
  let materialized: MaterializedRootCa | null = null;
  let transport: PostgresRailwayStockLocalhostCaTransport | null = null;
  let connection: StagingPostgresBackupCanaryConnection | null = null;
  let expectedUid: number | null = null;
  let expectedPemSha256: string | null = null;
  let cleanupExact = true;
  try {
    const configuration = safeConfiguration(dependencies, identity);
    deploymentId = configuration.deploymentId;
    rootCaPem = configuration.rootCaPem;
    if (!configuration.admin || !rootCaPem || configuration.uid === null) {
      throw new StagingPostgresBackupCanaryError("configuration_invalid");
    }
    expectedUid = configuration.uid;
    materialized = await materializeRootCa(
      rootCaPem,
      configuration.uid,
      dependencies.temporaryRoot(),
    );
    expectedPemSha256 = sha256(rootCaPem);
    rootCaPem.fill(0);
    rootCaPem = null;
    transport = await dependencies.openTransport({
      profile: STAGING_POSTGRES_BACKUP_CANARY_LOCK.transportProfile,
      rootCaFile: materialized.filePath,
      expectedRootCaDerSha256: STAGING_POSTGRES_BACKUP_CANARY_LOCK.rootCaDerSha256,
      expectedUid: configuration.uid,
      sourceUrlAuthority: {
        hostname: configuration.admin.hostname,
        port: configuration.admin.port,
      },
    });
    identity.transportAuthority = exactReturnedTransport(transport, expectedPemSha256);
    if (!identity.transportAuthority) {
      throw new StagingPostgresBackupCanaryError("source_authority_invalid");
    }
    await transport.assertExact();
    connection = await dependencies.connect({
      host: transport.nodeConnection.host,
      port: transport.nodeConnection.port,
      database: configuration.admin.database,
      user: configuration.admin.username,
      password: configuration.admin.password,
      ssl: transport.nodeConnection.ssl,
      application_name: APPLICATION_NAME,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
    });
    identity.tlsScram = connection.authenticationMethod === "scram-sha-256";
    if (!identity.tlsScram) {
      throw new StagingPostgresBackupCanaryError("source_authority_invalid");
    }
    await transport.assertExact();
    const databaseIdentitySha256 = await inspectSource(connection, identity);
    await transport.assertExact();
    candidates = {
      adminUrlSha256: configuration.admin.urlSha256,
      databaseIdentitySha256,
    };
  } catch {
    candidates = failedCandidates();
  } finally {
    rootCaPem?.fill(0);
    if (connection) {
      try { await connection.close(); } catch { cleanupExact = false; }
    }
    if (transport) {
      try { await transport.assertExact(); } catch { cleanupExact = false; }
      try { await transport.close(); } catch { cleanupExact = false; }
    }
    if (materialized) {
      try {
        await cleanupRootCa(materialized, expectedUid ?? -1);
      } catch {
        cleanupExact = false;
      }
    }
  }
  if (!cleanupExact) candidates = failedCandidates();
  const receipt = fixedReceipt(deploymentId, identity, candidates);
  try {
    dependencies.writeOutput(`${JSON.stringify(receipt)}\n`);
  } catch {
    return 1;
  }
  return receipt.outcome === "passed" && cleanupExact ? 0 : 1;
}
