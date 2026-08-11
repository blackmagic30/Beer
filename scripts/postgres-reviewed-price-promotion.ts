import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import type {
  SqlBindings,
  SqlDatabase,
  SqlPoolMetrics,
} from "../src/db/sql-database.js";
import type {
  Client,
  ClientConfig,
  Pool,
  PoolClient,
  PoolConfig,
  QueryResultRow,
} from "pg";
import {
  postgresMigrationReceiptSchema,
  postgresMigrationTargetIdentitySchema,
  sha256PostgresMigrationTargetIdentity,
} from "../src/db/postgres-migration-receipt.js";
import { sha256PostgresMigrationBytes } from
  "../src/db/postgres-migration-schema.js";
import { sha256PostgresDatabaseIdentity } from
  "../src/lib/postgres-database-identity.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
  PostgresReviewedPricePromotionPlanError,
  canonicalPostgresReviewedPricePromotionJson,
  postgresReviewedPricePromotionPlanCandidateSchema,
  postgresReviewedPricePromotionPrivateInputSchema,
  sha256PostgresReviewedPricePromotionValue,
  type BuildPostgresReviewedPricePromotionPlanInput,
  type PostgresReviewedPricePromotionPlanCandidate,
  type PostgresReviewedPricePromotionPlanErrorCode,
} from "../src/lib/postgres-reviewed-price-promotion-plan.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  openPostgresRailwayStockLocalhostCaTransport,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import { POSTGRES_REVIEWED_PRICE_PROMOTION_RUNTIME } from
  "./lib/postgres-reviewed-price-promotion-runtime.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

export const POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND = "plan" as const;

const ARGUMENTS = new Set([
  "--candidate-sha",
  "--deployment-environment-id-sha256",
  "--deployment-id-sha256",
  "--deployment-image-digest-sha256",
  "--deployment-project-id-sha256",
  "--deployment-service-id-sha256",
  "--expected-environment",
  "--expected-target-database-identity-sha256",
  "--migration-receipt",
  "--migration-receipt-sha256",
  "--migration-target-identity",
  "--migration-target-identity-sha256",
  "--output-plan",
  "--planner-url-file",
  "--planner-url-sha256",
  "--private-input",
  "--private-input-sha256",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PLANNER_ROLE = "pintpath_reviewed_price_planner";
const PERMANENT_STAGING_HOST = "postgres-staging.railway.internal";
const PERMANENT_STAGING_PORT = "5432";
const PERMANENT_STAGING_DATABASE = "pintpath_staging";
const MINIMUM_CA_REMAINING_VALIDITY_MS = 86_400_000;
const MAX_ROOT_CA_BYTES = 64 * 1_024;
const MAX_PATH_BYTES = 4_096;
const MAX_PLANNER_URL_FILE_BYTES = 4_096;
const MAX_MIGRATION_RECEIPT_BYTES = 64 * 1_024;
const MAX_MIGRATION_TARGET_IDENTITY_BYTES = 16 * 1_024;
const MAX_PRIVATE_INPUT_BYTES = 256 * 1_024;
const MAX_PLAN_BYTES = 256 * 1_024;

export type PostgresReviewedPricePromotionCliFailureCode =
  | PostgresReviewedPricePromotionPlanErrorCode
  | "argument_invalid"
  | "environment_not_allowed"
  | "artifact_file_unsafe"
  | "artifact_hash_mismatch"
  | "artifact_invalid"
  | "planner_url_unsafe"
  | "root_ca_invalid"
  | "root_ca_pin_mismatch"
  | "database_open_failed"
  | "database_release_failed"
  | "plan_result_invalid"
  | "output_file_unsafe"
  | "unexpected_failure";

const PLAN_FAILURE_CODES = new Set<PostgresReviewedPricePromotionPlanErrorCode>([
  "argument_invalid",
  "catalog_mismatch",
  "environment_mismatch",
  "identity_mismatch",
  "inspection_invalid",
  "migration_mismatch",
  "not_postgres",
  "private_input_mismatch",
  "public_conflict",
  "role_unsafe",
  "source_mismatch",
  "wrong_price_open",
]);
const CLI_FAILURE_CODES = new Set<PostgresReviewedPricePromotionCliFailureCode>([
  ...PLAN_FAILURE_CODES,
  "environment_not_allowed",
  "artifact_file_unsafe",
  "artifact_hash_mismatch",
  "artifact_invalid",
  "planner_url_unsafe",
  "root_ca_invalid",
  "root_ca_pin_mismatch",
  "database_open_failed",
  "database_release_failed",
  "plan_result_invalid",
  "output_file_unsafe",
  "unexpected_failure",
]);

class SafeCliError extends Error {
  constructor(readonly code: PostgresReviewedPricePromotionCliFailureCode) {
    super(code);
    this.name = "SafeCliError";
  }
}

export interface PostgresReviewedPricePromotionPlannerDatabaseHandle {
  readonly database: SqlDatabase;
  readonly assertExact: () => Promise<void>;
  readonly release: () => Promise<void>;
}

export interface PostgresReviewedPricePromotionPlannerDatabaseOptions {
  readonly applicationName: "pintpath-reviewed-price-promotion-planner";
  readonly connectionTimeoutMs: 10_000;
  readonly database: typeof PERMANENT_STAGING_DATABASE;
  readonly expectedRootCaDerSha256: string;
  readonly hostname: typeof PERMANENT_STAGING_HOST;
  readonly idleInTransactionTimeoutMs: 10_000;
  readonly idleTimeoutMs: 5_000;
  readonly maxConnections: 1;
  readonly password: string;
  readonly port: 5_432;
  readonly rootCaFile: string;
  readonly statementTimeoutMs: 30_000;
  readonly user: typeof PLANNER_ROLE;
}

export interface PostgresReviewedPricePromotionCliDependencies {
  readonly openDatabase: (
    options: PostgresReviewedPricePromotionPlannerDatabaseOptions,
  ) => PostgresReviewedPricePromotionPlannerDatabaseHandle
    | Promise<PostgresReviewedPricePromotionPlannerDatabaseHandle>;
  readonly buildPlan: (
    input: BuildPostgresReviewedPricePromotionPlanInput,
  ) => Promise<PostgresReviewedPricePromotionPlanCandidate>;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly expectedRootCaDerSha256: string;
  readonly writeOutput: (value: string) => void;
}

interface CompiledPlannerQuery {
  readonly text: string;
  readonly values: unknown[];
}

interface PlannerPgRuntime {
  readonly Client: typeof Client;
  readonly Pool: new (config: PoolConfig) => Pool;
  readonly compileQuery: (sql: string, bindings: SqlBindings) => CompiledPlannerQuery;
  readonly createTypeOverrides: () => NonNullable<PoolConfig["types"]>;
}

interface OpenRailwayPlannerDatabaseDependencies {
  readonly loadPgRuntime: () => Promise<PlannerPgRuntime>;
  readonly openTransport: (
    options: OpenPostgresRailwayStockLocalhostCaTransportOptions,
  ) => Promise<PostgresRailwayStockLocalhostCaTransport>;
}

function normalizePlannerBindings(bindings: unknown[]): SqlBindings {
  if (
    bindings.length === 1
    && bindings[0] !== null
    && typeof bindings[0] === "object"
    && !Array.isArray(bindings[0])
    && !Buffer.isBuffer(bindings[0])
    && !(bindings[0] instanceof Date)
  ) return bindings[0] as Readonly<Record<string, unknown>>;
  return bindings;
}

class RailwayPlannerSqlDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly transactionClient = new AsyncLocalStorage<{
    readonly client: PoolClient;
    nextSavepoint: number;
  }>();
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;
  private lastQueryDurationMs: number | null = null;
  private closed = false;

  constructor(
    private readonly pool: Pool,
    private readonly compileQuery: PlannerPgRuntime["compileQuery"],
    private readonly releaseDatabase: () => Promise<void>,
  ) {
    pool.on("error", () => {
      this.failedQueries += 1;
    });
  }

  private async query<Row extends QueryResultRow>(
    sql: string,
    bindings: SqlBindings,
  ) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = this.compileQuery(sql, bindings);
    const transactionClient = this.transactionClient.getStore()?.client;
    const startedAt = performance.now();
    try {
      let result;
      if (transactionClient) {
        result = await transactionClient.query<Row>(
          compiled.text,
          compiled.values,
        );
      } else {
        assertNoForbiddenAmbientAuthority(process.env);
        result = await this.pool.query<Row>(compiled.text, compiled.values);
      }
      this.completedQueries += 1;
      return result;
    } catch (error) {
      this.failedQueries += 1;
      throw error;
    } finally {
      this.lastQueryDurationMs = performance.now() - startedAt;
    }
  }

  prepare(sql: string) {
    return {
      run: async (...bindings: unknown[]) => {
        const result = await this.query(sql, normalizePlannerBindings(bindings));
        return { changes: result.rowCount ?? 0 };
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizePlannerBindings(bindings));
        return result.rows[0];
      },
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizePlannerBindings(bindings));
        return result.rows;
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql, []);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `pintpath_planner_nested_${active.nextSavepoint++}`;
        await active.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await work();
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          this.transactionFailures += 1;
          try {
            await active.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          } catch {
            // The original planner failure remains authoritative.
          }
          throw error;
        }
      }
      if (this.closed) throw new Error("Database is closed.");
      assertNoForbiddenAmbientAuthority(process.env);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.transactionClient.run(
          { client, nextSavepoint: 1 },
          work,
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        this.transactionFailures += 1;
        try {
          await client.query("ROLLBACK");
        } catch {
          // The original planner failure remains authoritative.
        }
        throw error;
      } finally {
        client.release();
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.releaseDatabase();
  }

  metrics(): SqlPoolMetrics {
    return {
      dialect: this.dialect,
      totalConnections: this.closed ? 0 : this.pool.totalCount,
      idleConnections: this.closed ? 0 : this.pool.idleCount,
      waitingRequests: this.closed ? 0 : this.pool.waitingCount,
      completedQueries: this.completedQueries,
      failedQueries: this.failedQueries,
      transactionFailures: this.transactionFailures,
      lastQueryDurationMs: this.lastQueryDurationMs,
    };
  }
}

const DEFAULT_RAILWAY_DATABASE_DEPENDENCIES: OpenRailwayPlannerDatabaseDependencies = {
  loadPgRuntime: async () => {
    const [postgres, sqlDatabase] = await Promise.all([
      import("pg"),
      import("../src/db/sql-database.js"),
    ]);
    return {
      Client: postgres.Client,
      Pool: postgres.Pool,
      compileQuery: sqlDatabase.sqlDatabaseInternals.compilePostgresQuery,
      createTypeOverrides:
        sqlDatabase.sqlDatabaseInternals.createPostgresTypeOverrides,
    };
  },
  openTransport: openPostgresRailwayStockLocalhostCaTransport,
};

function assertExactPlannerDatabaseOptions(
  options: PostgresReviewedPricePromotionPlannerDatabaseOptions,
): void {
  if (
    options.applicationName !== "pintpath-reviewed-price-promotion-planner"
    || options.connectionTimeoutMs !== 10_000
    || options.database !== PERMANENT_STAGING_DATABASE
    || !SHA256_PATTERN.test(options.expectedRootCaDerSha256)
    || options.hostname !== PERMANENT_STAGING_HOST
    || options.idleInTransactionTimeoutMs !== 10_000
    || options.idleTimeoutMs !== 5_000
    || options.maxConnections !== 1
    || typeof options.password !== "string"
    || !options.password
    || /[\r\n\0]/.test(options.password)
    || options.port !== 5_432
    || path.dirname(options.rootCaFile) === options.rootCaFile
    || options.statementTimeoutMs !== 30_000
    || options.user !== PLANNER_ROLE
  ) fail("database_open_failed");
}

async function closePlannerDatabaseCapabilities(
  pool: Pool | null,
  transport: PostgresRailwayStockLocalhostCaTransport | null,
): Promise<void> {
  let failed = false;
  if (transport) {
    try {
      await transport.assertExact();
    } catch {
      failed = true;
    }
  }
  if (pool) {
    try {
      await pool.end();
    } catch {
      failed = true;
    }
  }
  if (transport) {
    try {
      await transport.close();
    } catch {
      failed = true;
    }
  }
  if (failed) fail("database_release_failed");
}

export async function openRailwayPlannerDatabase(
  options: PostgresReviewedPricePromotionPlannerDatabaseOptions,
  dependencyOverrides: Partial<OpenRailwayPlannerDatabaseDependencies> = {},
): Promise<PostgresReviewedPricePromotionPlannerDatabaseHandle> {
  assertExactPlannerDatabaseOptions(options);
  const dependencies = {
    ...DEFAULT_RAILWAY_DATABASE_DEPENDENCIES,
    ...dependencyOverrides,
  };
  let transport: PostgresRailwayStockLocalhostCaTransport | null = null;
  let pool: Pool | null = null;
  try {
    transport = await dependencies.openTransport({
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaFile: options.rootCaFile,
      expectedRootCaDerSha256: options.expectedRootCaDerSha256,
      expectedUid: Number(effectiveUid()),
      sourceUrlAuthority: {
        hostname: options.hostname,
        port: options.port,
      },
    });
    await transport.assertExact();
    assertNoForbiddenAmbientAuthority(process.env);
    const runtime = await dependencies.loadPgRuntime();
    assertNoForbiddenAmbientAuthority(process.env);
    await transport.assertExact();
    const RuntimeClient = runtime.Client;
    class AuthorityGuardedPlannerClient extends RuntimeClient {
      constructor(config?: string | ClientConfig) {
        assertNoForbiddenAmbientAuthority(process.env);
        super(config);
        assertNoForbiddenAmbientAuthority(process.env);
      }
    }
    const poolConfig: PoolConfig = {
      Client: AuthorityGuardedPlannerClient,
      host: transport.nodeConnection.host,
      port: options.port,
      database: options.database,
      user: options.user,
      password: options.password,
      ssl: transport.nodeConnection.ssl,
      application_name: options.applicationName,
      max: options.maxConnections,
      idleTimeoutMillis: options.idleTimeoutMs,
      connectionTimeoutMillis: options.connectionTimeoutMs,
      query_timeout: options.statementTimeoutMs,
      options: [
        "-c search_path=pg_catalog",
        "-c default_transaction_read_only=on",
        "-c row_security=on",
        `-c statement_timeout=${options.statementTimeoutMs}`,
        `-c idle_in_transaction_session_timeout=${options.idleInTransactionTimeoutMs}`,
        "-c lock_timeout=10000",
        "-c synchronous_commit=on",
      ].join(" "),
      types: runtime.createTypeOverrides(),
    };
    if (Object.hasOwn(poolConfig, "connectionString")) fail("database_open_failed");
    assertNoForbiddenAmbientAuthority(process.env);
    pool = new runtime.Pool(poolConfig);
    assertNoForbiddenAmbientAuthority(process.env);
    let releasePromise: Promise<void> | null = null;
    const openPool = pool;
    const openTransport = transport;
    const release = (): Promise<void> => {
      releasePromise ??= closePlannerDatabaseCapabilities(openPool, openTransport);
      return releasePromise;
    };
    const database = new RailwayPlannerSqlDatabase(
      openPool,
      runtime.compileQuery,
      release,
    );
    await transport.assertExact();
    assertNoForbiddenAmbientAuthority(process.env);
    const client = await pool.connect();
    client.release();
    await transport.assertExact();
    pool = null;
    transport = null;
    return {
      database,
      assertExact: () => openTransport.assertExact(),
      release,
    };
  } catch (error) {
    try {
      await closePlannerDatabaseCapabilities(pool, transport);
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }
}

interface StableFileIdentity {
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

interface StableDirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
}

interface PrivateArtifact<Value> {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly value: Value;
}

interface PrivateParentAuthority {
  readonly path: string;
  readonly handle: fs.promises.FileHandle;
  readonly identity: StableDirectoryIdentity;
  readonly uid: bigint;
  assertExact(): Promise<void>;
  close(): Promise<void>;
}

interface HeldPrivateFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  assertExact(): Promise<void>;
  close(): Promise<void>;
}

function fail(code: PostgresReviewedPricePromotionCliFailureCode): never {
  throw new SafeCliError(code);
}

function errnoIs(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function assertRequiredFilesystemAuthority(): void {
  if (
    !Number.isInteger(fs.constants.O_NOFOLLOW)
    || fs.constants.O_NOFOLLOW <= 0
    || !Number.isInteger(fs.constants.O_DIRECTORY)
    || fs.constants.O_DIRECTORY <= 0
    || typeof process.geteuid !== "function"
  ) fail("artifact_file_unsafe");
}

function effectiveUid(): bigint {
  if (typeof process.geteuid !== "function") fail("artifact_file_unsafe");
  const value = process.geteuid();
  if (!Number.isSafeInteger(value) || value < 0) fail("artifact_file_unsafe");
  return BigInt(value);
}

function exactAbsolutePath(value: string): string {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
    || value === path.parse(value).root
    || value.includes("\0")
    || /[\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
  ) fail("argument_invalid");
  return value;
}

function exactSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) fail("argument_invalid");
  return value;
}

function exactCandidateSha(value: string): string {
  if (!CANDIDATE_PATTERN.test(value)) fail("argument_invalid");
  return value;
}

function fileIdentity(stat: fs.BigIntStats): StableFileIdentity {
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

function directoryIdentity(stat: fs.BigIntStats): StableDirectoryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
  };
}

function sameFileIdentity(
  left: StableFileIdentity,
  right: StableFileIdentity,
): boolean {
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

function sameDirectoryIdentity(
  left: StableDirectoryIdentity,
  right: StableDirectoryIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function sameDirectoryObject(
  left: StableDirectoryIdentity,
  right: StableDirectoryIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid;
}

function assertPrivateFile(
  stat: fs.BigIntStats,
  uid: bigint,
  maximumBytes: number,
  expectedBytes?: number,
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== uid
    || stat.nlink !== 1n
    || (stat.mode & 0o7777n) !== 0o600n
    || stat.size < 1n
    || stat.size > BigInt(maximumBytes)
    || expectedBytes !== undefined && stat.size !== BigInt(expectedBytes)
  ) fail("artifact_file_unsafe");
}

function assertPrivateOutputFile(
  stat: fs.BigIntStats,
  uid: bigint,
  expectedBytes: number,
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== uid
    || stat.nlink !== 1n
    || (stat.mode & 0o7777n) !== 0o600n
    || stat.size !== BigInt(expectedBytes)
  ) fail("output_file_unsafe");
}

function assertPrivateOutputParent(stat: fs.BigIntStats, uid: bigint): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== uid
    || stat.nlink < 1n
    || (stat.mode & 0o7777n) !== 0o700n
  ) fail("output_file_unsafe");
}

function assertPrivateInputParent(stat: fs.BigIntStats, uid: bigint): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== uid
    || stat.nlink < 1n
    || (stat.mode & 0o7777n) !== 0o700n
  ) fail("artifact_file_unsafe");
}

async function assertParentAuthorityExact(
  authority: PrivateParentAuthority,
): Promise<void> {
  const [descriptor, atPath, real] = await Promise.all([
    authority.handle.stat({ bigint: true }),
    fs.promises.lstat(authority.path, { bigint: true }),
    fs.promises.realpath(authority.path),
  ]);
  assertPrivateInputParent(descriptor, authority.uid);
  assertPrivateInputParent(atPath, authority.uid);
  if (
    real !== authority.path
    || !sameDirectoryIdentity(authority.identity, directoryIdentity(descriptor))
    || !sameDirectoryIdentity(authority.identity, directoryIdentity(atPath))
  ) fail("artifact_file_unsafe");
}

async function openPrivateParentAuthority(
  parentInput: string,
): Promise<PrivateParentAuthority> {
  assertRequiredFilesystemAuthority();
  const parent = exactAbsolutePath(parentInput);
  const uid = effectiveUid();
  let handle: fs.promises.FileHandle | null = null;
  try {
    const [real, atPath] = await Promise.all([
      fs.promises.realpath(parent),
      fs.promises.lstat(parent, { bigint: true }),
    ]);
    if (real !== parent) fail("artifact_file_unsafe");
    assertPrivateInputParent(atPath, uid);
    const identity = directoryIdentity(atPath);
    handle = await fs.promises.open(
      parent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    assertPrivateInputParent(opened, uid);
    if (!sameDirectoryIdentity(identity, directoryIdentity(opened))) {
      fail("artifact_file_unsafe");
    }
    const heldParentHandle = handle;
    let closed = false;
    const authority: PrivateParentAuthority = {
      path: parent,
      handle: heldParentHandle,
      identity,
      uid,
      assertExact: () => {
        if (closed) return fail("artifact_file_unsafe");
        return assertParentAuthorityExact(authority);
      },
      close: async () => {
        if (closed) fail("artifact_file_unsafe");
        let failed = false;
        try {
          await assertParentAuthorityExact(authority);
        } catch {
          failed = true;
        }
        closed = true;
        try {
          await heldParentHandle.close();
        } catch {
          failed = true;
        }
        if (failed) fail("artifact_file_unsafe");
      },
    };
    handle = null;
    return authority;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        return fail("artifact_file_unsafe");
      }
    }
    if (error instanceof SafeCliError) throw error;
    return fail("artifact_file_unsafe");
  }
}

async function readExactDescriptor(
  handle: fs.promises.FileHandle,
  size: number,
  failureCode: "artifact_file_unsafe" | "output_file_unsafe" =
    "artifact_file_unsafe",
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) fail(failureCode);
    offset += result.bytesRead;
  }
  const overflow = Buffer.alloc(1);
  try {
    const result = await handle.read(overflow, 0, 1, size);
    if (result.bytesRead !== 0) fail(failureCode);
  } finally {
    overflow.fill(0);
  }
  return bytes;
}

async function openHeldPrivateFile(
  authority: PrivateParentAuthority,
  filenameInput: string,
  maximumBytes: number,
): Promise<HeldPrivateFile> {
  assertRequiredFilesystemAuthority();
  const filename = exactAbsolutePath(filenameInput);
  if (path.dirname(filename) !== authority.path) fail("artifact_file_unsafe");
  const uid = authority.uid;
  let handle: fs.promises.FileHandle | null = null;
  let bytes: Buffer | null = null;
  try {
    await authority.assertExact();
    const [real, pathBefore] = await Promise.all([
      fs.promises.realpath(filename),
      fs.promises.lstat(filename, { bigint: true }),
    ]);
    if (real !== filename) fail("artifact_file_unsafe");
    assertPrivateFile(pathBefore, uid, maximumBytes);
    handle = await fs.promises.open(
      filename,
      fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW
        | (fs.constants.O_NONBLOCK ?? 0),
    );
    const before = await handle.stat({ bigint: true });
    assertPrivateFile(before, uid, maximumBytes);
    const beforeIdentity = fileIdentity(before);
    const pathOpened = await fs.promises.lstat(filename, { bigint: true });
    assertPrivateFile(pathOpened, uid, maximumBytes);
    if (!sameFileIdentity(beforeIdentity, fileIdentity(pathOpened))) {
      fail("artifact_file_unsafe");
    }
    const size = Number(before.size);
    bytes = await readExactDescriptor(handle, size);
    const [after, pathAfter, realAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.promises.lstat(filename, { bigint: true }),
      fs.promises.realpath(filename),
    ]);
    assertPrivateFile(after, uid, maximumBytes, size);
    assertPrivateFile(pathAfter, uid, maximumBytes, size);
    if (
      realAfter !== filename
      || !sameFileIdentity(beforeIdentity, fileIdentity(after))
      || !sameFileIdentity(beforeIdentity, fileIdentity(pathAfter))
    ) fail("artifact_file_unsafe");
    await authority.assertExact();
    const sha256 = sha256PostgresMigrationBytes(bytes);
    const identity = beforeIdentity;
    const heldBytes = bytes;
    const heldHandle = handle;
    let closed = false;
    const held: HeldPrivateFile = {
      path: filename,
      bytes: heldBytes,
      sha256,
      assertExact: async () => {
        if (closed) fail("artifact_file_unsafe");
        await authority.assertExact();
        const [descriptor, atPath, real] = await Promise.all([
          heldHandle.stat({ bigint: true }),
          fs.promises.lstat(filename, { bigint: true }),
          fs.promises.realpath(filename),
        ]);
        assertPrivateFile(descriptor, uid, maximumBytes, heldBytes.length);
        assertPrivateFile(atPath, uid, maximumBytes, heldBytes.length);
        if (
          real !== filename
          || !sameFileIdentity(identity, fileIdentity(descriptor))
          || !sameFileIdentity(identity, fileIdentity(atPath))
        ) fail("artifact_file_unsafe");
        const actual = await readExactDescriptor(heldHandle, heldBytes.length);
        try {
          if (sha256PostgresMigrationBytes(actual) !== sha256) {
            fail("artifact_file_unsafe");
          }
        } finally {
          actual.fill(0);
        }
      },
      close: async () => {
        if (closed) fail("artifact_file_unsafe");
        let failed = false;
        try {
          await held.assertExact();
        } catch {
          failed = true;
        }
        closed = true;
        heldBytes.fill(0);
        try {
          await heldHandle.close();
        } catch {
          failed = true;
        }
        if (failed) fail("artifact_file_unsafe");
      },
    };
    handle = null;
    bytes = null;
    return held;
  } catch (error) {
    bytes?.fill(0);
    if (handle) {
      try {
        await handle.close();
      } catch {
        return fail("artifact_file_unsafe");
      }
    }
    if (error instanceof SafeCliError) throw error;
    return fail("artifact_file_unsafe");
  }
}

function assertHeldFileHash(
  held: HeldPrivateFile,
  expectedSha256: string,
): void {
  if (held.sha256 !== exactSha256(expectedSha256)) {
    fail("artifact_hash_mismatch");
  }
}

function decodeExactUtf8(bytes: Buffer): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(value, "utf8").equals(bytes)) fail("artifact_invalid");
    return value;
  } catch (error) {
    if (error instanceof SafeCliError) throw error;
    return fail("artifact_invalid");
  }
}

function readCanonicalJsonArtifact<Value>(input: {
  readonly held: HeldPrivateFile;
  readonly expectedSha256: string;
  readonly parse: (value: unknown) => { readonly success: boolean; readonly data?: Value };
}): PrivateArtifact<Value> {
  assertHeldFileHash(input.held, input.expectedSha256);
  let raw: unknown;
  try {
    raw = JSON.parse(decodeExactUtf8(input.held.bytes)) as unknown;
  } catch (error) {
    if (error instanceof SafeCliError) throw error;
    return fail("artifact_invalid");
  }
  const parsed = input.parse(raw);
  if (!parsed.success || parsed.data === undefined) fail("artifact_invalid");
  const canonical = canonicalPostgresReviewedPricePromotionJson(parsed.data);
  if (!canonical.equals(input.held.bytes)) fail("artifact_invalid");
  return {
    bytes: input.held.bytes,
    sha256: input.held.sha256,
    value: parsed.data,
  };
}

interface PlannerUrlAuthority {
  readonly password: string;
  readonly rootCaFile: string;
}

function directVerifyFullPlannerUrl(bytes: Buffer): PlannerUrlAuthority {
  const line = decodeExactUtf8(bytes);
  if (
    !line.endsWith("\n")
    || line.indexOf("\n") !== line.length - 1
    || /[\r\0]/.test(line)
  ) fail("planner_url_unsafe");
  const value = line.slice(0, -1);
  if (!value || value.trim() !== value) fail("planner_url_unsafe");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail("planner_url_unsafe");
  }
  let username: string;
  let databaseName: string;
  let password: string;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return fail("planner_url_unsafe");
  }
  const keys = [...parsed.searchParams.keys()];
  const rootCaEntries = parsed.searchParams.getAll("sslrootcert");
  const rootCaFile = rootCaEntries[0] ?? "";
  const expectedSearch = new URLSearchParams([
    ["sslmode", "verify-full"],
    ["sslrootcert", rootCaFile],
  ]).toString();
  if (
    parsed.protocol !== "postgresql:"
    || parsed.toString() !== value
    || username !== PLANNER_ROLE
    || !password
    || /[\r\n\0]/.test(password)
    || parsed.hostname !== PERMANENT_STAGING_HOST
    || parsed.port !== PERMANENT_STAGING_PORT
    || databaseName !== PERMANENT_STAGING_DATABASE
    || parsed.pathname !== `/${PERMANENT_STAGING_DATABASE}`
    || parsed.hash
    || keys.length !== 2
    || keys[0] !== "sslmode"
    || keys[1] !== "sslrootcert"
    || parsed.searchParams.getAll("sslmode").length !== 1
    || parsed.searchParams.get("sslmode") !== "verify-full"
    || rootCaEntries.length !== 1
    || !rootCaFile
    || parsed.search.slice(1) !== expectedSearch
  ) fail("planner_url_unsafe");
  return {
    password,
    rootCaFile: exactAbsolutePath(rootCaFile),
  };
}

function singlePemCertificate(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  const begin = "-----BEGIN CERTIFICATE-----";
  const end = "-----END CERTIFICATE-----";
  const firstBegin = value.indexOf(begin);
  const firstEnd = value.indexOf(end, firstBegin + begin.length);
  if (
    firstBegin < 0
    || firstEnd < 0
    || value.indexOf(begin, firstBegin + begin.length) !== -1
    || value.indexOf(end, firstEnd + end.length) !== -1
    || value.slice(0, firstBegin).trim() !== ""
    || value.slice(firstEnd + end.length).trim() !== ""
  ) return false;
  const body = value.slice(firstBegin + begin.length, firstEnd).replace(/\s/g, "");
  return body.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body);
}

function validateHeldRootCa(
  held: HeldPrivateFile,
  expectedDerSha256Input: string,
): void {
  const expectedDerSha256 = exactSha256(expectedDerSha256Input);
  let certificate: crypto.X509Certificate;
  try {
    const pem = decodeExactUtf8(held.bytes);
    if (!singlePemCertificate(pem)) fail("root_ca_invalid");
    certificate = new crypto.X509Certificate(pem);
  } catch (error) {
    if (error instanceof SafeCliError) throw error;
    return fail("root_ca_invalid");
  }
  const actualDerSha256 = sha256PostgresMigrationBytes(certificate.raw);
  if (actualDerSha256 !== expectedDerSha256) fail("root_ca_pin_mismatch");
  const now = Date.now();
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  let selfSigned = false;
  try {
    selfSigned = certificate.subject === certificate.issuer
      && certificate.checkIssued(certificate)
      && certificate.verify(certificate.publicKey);
  } catch {
    selfSigned = false;
  }
  if (
    !certificate.ca
    || !selfSigned
    || !Number.isFinite(now)
    || !Number.isFinite(validFrom)
    || !Number.isFinite(validTo)
    || now < validFrom
    || now >= validTo
    || validTo - now < MINIMUM_CA_REMAINING_VALIDITY_MS
  ) fail("root_ca_invalid");
}

function forbiddenAmbientAuthorityName(name: string): boolean {
  const canonical = name.toUpperCase();
  return canonical === "DATABASE_URL"
    || canonical === "DIRECT_URL"
    || canonical === "NODE_PG_FORCE_NATIVE"
    || canonical.startsWith("PG")
    || canonical.includes("SUPABASE")
    || canonical.startsWith("PINTPATH_RUNTIME_")
    || /^PINTPATH_.*DATABASE_URL/.test(canonical);
}

function assertNoForbiddenAmbientAuthority(
  environment: Readonly<NodeJS.ProcessEnv>,
): void {
  for (const [name, value] of Object.entries(environment)) {
    if (
      typeof value === "string"
      && value.length > 0
      && forbiddenAmbientAuthorityName(name)
    ) fail("argument_invalid");
  }
}

async function assertHeldAuthorityExact(input: {
  readonly authority: PrivateParentAuthority;
  readonly files: readonly HeldPrivateFile[];
  readonly rootCa: HeldPrivateFile;
  readonly expectedRootCaDerSha256: string;
}): Promise<void> {
  await input.authority.assertExact();
  for (const file of input.files) await file.assertExact();
  validateHeldRootCa(input.rootCa, input.expectedRootCaDerSha256);
  await input.authority.assertExact();
}

async function closeHeldAuthority(input: {
  readonly authority: PrivateParentAuthority | null;
  readonly files: readonly HeldPrivateFile[];
}): Promise<boolean> {
  let exact = true;
  for (const file of [...input.files].reverse()) {
    try {
      await file.close();
    } catch {
      exact = false;
    }
  }
  if (input.authority) {
    try {
      await input.authority.close();
    } catch {
      exact = false;
    }
  }
  return exact;
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filename);
    return true;
  } catch (error) {
    if (errnoIs(error, "ENOENT")) return false;
    return fail("output_file_unsafe");
  }
}

async function removeTemporaryOutput(filename: string): Promise<void> {
  try {
    await fs.promises.unlink(filename);
  } catch (error) {
    if (!errnoIs(error, "ENOENT")) fail("output_file_unsafe");
  }
}

interface PublishedPrivatePlan {
  readonly sha256: string;
  readonly identity: StableFileIdentity;
  close(): Promise<void>;
  rollback(): Promise<void>;
}

async function writeNewPrivateCanonicalPlan(
  authority: PrivateParentAuthority,
  filenameInput: string,
  value: PostgresReviewedPricePromotionPlanCandidate,
): Promise<PublishedPrivatePlan> {
  assertRequiredFilesystemAuthority();
  const filename = exactAbsolutePath(filenameInput);
  const bytes = canonicalPostgresReviewedPricePromotionJson(value);
  if (bytes.length < 1 || bytes.length > MAX_PLAN_BYTES) fail("plan_result_invalid");
  const parent = path.dirname(filename);
  if (parent !== authority.path) fail("output_file_unsafe");
  const uid = authority.uid;
  const sha256 = sha256PostgresMigrationBytes(bytes);
  let fileHandle: fs.promises.FileHandle | null = null;
  let published = false;
  let retained = false;
  let ownedTemporaryPresent = false;
  const temporaryPath = path.join(
    parent,
    `.pintpath-postgres-reviewed-price-plan-${crypto.randomBytes(16).toString("hex")}.tmp`,
  );
  try {
    await authority.assertExact();
    if (await pathExists(filename)) fail("output_file_unsafe");

    fileHandle = await fs.promises.open(
      temporaryPath,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_RDWR
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
    ownedTemporaryPresent = true;
    await fileHandle.writeFile(bytes);
    await fileHandle.chmod(0o600);
    await fileHandle.sync();
    const written = await fileHandle.stat({ bigint: true });
    assertPrivateOutputFile(written, uid, bytes.length);
    const readback = await readExactDescriptor(fileHandle, bytes.length);
    if (!readback.equals(bytes)) fail("output_file_unsafe");

    await authority.assertExact();
    const [parentBeforePublish, parentPathBeforePublish, parentRealBeforePublish] =
      await Promise.all([
        authority.handle.stat({ bigint: true }),
        fs.promises.lstat(parent, { bigint: true }),
        fs.promises.realpath(parent),
      ]);
    assertPrivateOutputParent(parentBeforePublish, uid);
    assertPrivateOutputParent(parentPathBeforePublish, uid);
    if (
      parentRealBeforePublish !== parent
      || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentBeforePublish))
      || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentPathBeforePublish))
    ) fail("output_file_unsafe");

    await fs.promises.link(temporaryPath, filename);
    published = true;
    await fs.promises.unlink(temporaryPath);
    ownedTemporaryPresent = false;
    await authority.handle.sync();

    const [descriptorAfter, pathAfter, parentAfter, parentPathAfter, finalReal] =
      await Promise.all([
        fileHandle.stat({ bigint: true }),
        fs.promises.lstat(filename, { bigint: true }),
        authority.handle.stat({ bigint: true }),
        fs.promises.lstat(parent, { bigint: true }),
        fs.promises.realpath(filename),
      ]);
    assertPrivateOutputFile(descriptorAfter, uid, bytes.length);
    assertPrivateOutputFile(pathAfter, uid, bytes.length);
    assertPrivateOutputParent(parentAfter, uid);
    assertPrivateOutputParent(parentPathAfter, uid);
    const identity = fileIdentity(descriptorAfter);
    if (
      finalReal !== filename
      || !sameFileIdentity(identity, fileIdentity(pathAfter))
      || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentAfter))
      || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentPathAfter))
    ) fail("output_file_unsafe");
    const finalReadback = await readExactDescriptor(fileHandle, bytes.length);
    if (!finalReadback.equals(bytes)) fail("output_file_unsafe");
    await authority.assertExact();

    const retainedHandle = fileHandle;
    let state: "open" | "closed" | "rolled-back" = "open";
    const result: PublishedPrivatePlan = {
      sha256,
      identity,
      close: async () => {
        if (state !== "open") fail("output_file_unsafe");
        let exact = true;
        let current: Buffer | null = null;
        try {
          const [descriptor, atPath, real] = await Promise.all([
            retainedHandle.stat({ bigint: true }),
            fs.promises.lstat(filename, { bigint: true }),
            fs.promises.realpath(filename),
          ]);
          assertPrivateOutputFile(descriptor, uid, bytes.length);
          assertPrivateOutputFile(atPath, uid, bytes.length);
          if (
            real !== filename
            || !sameFileIdentity(identity, fileIdentity(descriptor))
            || !sameFileIdentity(identity, fileIdentity(atPath))
          ) exact = false;
          current = await readExactDescriptor(
            retainedHandle,
            bytes.length,
            "output_file_unsafe",
          );
          if (!current.equals(bytes)) exact = false;
        } catch {
          exact = false;
        } finally {
          current?.fill(0);
          try {
            await retainedHandle.close();
          } catch {
            exact = false;
          }
          state = "closed";
        }
        if (!exact) fail("output_file_unsafe");
      },
      rollback: async () => {
        if (state === "rolled-back") return;
        let exact = await removeExactPublishedPlan(
          authority,
          filename,
          sha256,
          identity,
        );
        if (state === "open") {
          try {
            await retainedHandle.close();
          } catch {
            exact = false;
          }
        }
        state = "rolled-back";
        if (!exact) fail("output_file_unsafe");
      },
    };
    retained = true;
    fileHandle = null;
    return result;
  } catch (error) {
    if (error instanceof SafeCliError) throw error;
    return fail("output_file_unsafe");
  } finally {
    let cleanupFailed = false;
    if (published && !retained && fileHandle) {
      try {
        const [descriptor, atPath] = await Promise.all([
          fileHandle.stat({ bigint: true }),
          fs.promises.lstat(filename, { bigint: true }),
        ]);
        assertPrivateOutputFile(descriptor, uid, bytes.length);
        assertPrivateOutputFile(atPath, uid, bytes.length);
        if (descriptor.dev !== atPath.dev || descriptor.ino !== atPath.ino) {
          throw new Error("published_output_identity_drift");
        }
        await fs.promises.unlink(filename);
        await authority.handle.sync();
        if (await pathExists(filename)) throw new Error("published_output_remained");
      } catch {
        cleanupFailed = true;
      }
    }
    if (ownedTemporaryPresent) {
      try {
        await removeTemporaryOutput(temporaryPath);
      } catch {
        cleanupFailed = true;
      }
    }
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) fail("output_file_unsafe");
  }
}

async function removeExactPublishedPlan(
  authority: PrivateParentAuthority,
  filename: string,
  expectedSha256: string,
  expectedIdentity: StableFileIdentity,
): Promise<boolean> {
  let parentHandle: fs.promises.FileHandle | null = null;
  let fileHandle: fs.promises.FileHandle | null = null;
  let bytes: Buffer | null = null;
  let exact = true;
  try {
    const [parentReal, parentAtPath] = await Promise.all([
      fs.promises.realpath(authority.path),
      fs.promises.lstat(authority.path, { bigint: true }),
    ]);
    if (
      parentReal !== authority.path
      || !parentAtPath.isDirectory()
      || parentAtPath.isSymbolicLink()
      || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentAtPath))
    ) return false;
    assertPrivateOutputParent(parentAtPath, authority.uid);
    parentHandle = await fs.promises.open(
      authority.path,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const parentDescriptor = await parentHandle.stat({ bigint: true });
    assertPrivateOutputParent(parentDescriptor, authority.uid);
    if (!sameDirectoryIdentity(
      authority.identity,
      directoryIdentity(parentDescriptor),
    )) return false;
    fileHandle = await fs.promises.open(
      filename,
      fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW
        | (fs.constants.O_NONBLOCK ?? 0),
    );
    const descriptor = await fileHandle.stat({ bigint: true });
    if (descriptor.size < 1n || descriptor.size > BigInt(MAX_PLAN_BYTES)) return false;
    const size = Number(descriptor.size);
    assertPrivateOutputFile(descriptor, authority.uid, size);
    const atPath = await fs.promises.lstat(filename, { bigint: true });
    assertPrivateOutputFile(atPath, authority.uid, size);
    if (
      !sameFileIdentity(expectedIdentity, fileIdentity(descriptor))
      || !sameFileIdentity(expectedIdentity, fileIdentity(atPath))
    ) return false;
    bytes = await readExactDescriptor(fileHandle, size, "output_file_unsafe");
    if (sha256PostgresMigrationBytes(bytes) !== expectedSha256) return false;
    await fs.promises.unlink(filename);
    const unlinked = await fileHandle.stat({ bigint: true });
    if (
      unlinked.dev !== descriptor.dev
      || unlinked.ino !== descriptor.ino
      || unlinked.nlink !== 0n
      || await pathExists(filename)
    ) exact = false;
    await parentHandle.sync();
  } catch {
    exact = false;
  } finally {
    bytes?.fill(0);
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {
        exact = false;
      }
    }
    if (parentHandle) {
      try {
        await parentHandle.close();
      } catch {
        exact = false;
      }
    }
  }
  return exact;
}

function fixedOwnFailureCode(
  error: unknown,
  allowed: ReadonlySet<string>,
): PostgresReviewedPricePromotionCliFailureCode | null {
  try {
    if (typeof error !== "object" || error === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "string"
      || !allowed.has(descriptor.value as PostgresReviewedPricePromotionCliFailureCode)
    ) return null;
    return descriptor.value as PostgresReviewedPricePromotionCliFailureCode;
  } catch {
    return null;
  }
}

function safeFailureCode(error: unknown): PostgresReviewedPricePromotionCliFailureCode {
  try {
    if (error instanceof SafeCliError) {
      return fixedOwnFailureCode(error, CLI_FAILURE_CODES) ?? "unexpected_failure";
    }
    if (error instanceof PostgresReviewedPricePromotionPlanError) {
      return fixedOwnFailureCode(error, PLAN_FAILURE_CODES) ?? "unexpected_failure";
    }
  } catch {
    // Proxies and hostile prototype traps cannot escape the fixed fallback.
  }
  return "unexpected_failure";
}

function writeSummary(
  dependencies: PostgresReviewedPricePromotionCliDependencies,
  value: unknown,
): void {
  dependencies.writeOutput(
    canonicalPostgresReviewedPricePromotionJson(value).toString("utf8"),
  );
}

async function assertPlannerDatabaseExact(
  handle: PostgresReviewedPricePromotionPlannerDatabaseHandle,
): Promise<void> {
  try {
    await handle.assertExact();
  } catch {
    fail("database_open_failed");
  }
}

function assertExactPlanBindings(input: {
  readonly plan: unknown;
  readonly candidateSha: string;
  readonly deployment: BuildPostgresReviewedPricePromotionPlanInput["expectedDeployment"];
  readonly migrationReceiptFileSha256: string;
  readonly privateInputFileSha256: string;
  readonly privateInputItemCount: number;
  readonly physicalIdentitySha256: string;
  readonly plannerLoginIdentitySha256: string;
}): PostgresReviewedPricePromotionPlanCandidate {
  const parsed = postgresReviewedPricePromotionPlanCandidateSchema.safeParse(input.plan);
  if (!parsed.success) fail("plan_result_invalid");
  const plan = parsed.data;
  if (
    plan.candidateSha !== input.candidateSha
    || plan.expectedEnvironment !== "permanent-staging"
    || JSON.stringify(plan.expectedDeployment) !== JSON.stringify(input.deployment)
    || plan.migration.receiptFileSha256 !== input.migrationReceiptFileSha256
    || plan.privateInput.manifestSha256 !== input.privateInputFileSha256
    || plan.privateInput.itemCount !== input.privateInputItemCount
    || plan.sourceSnapshot.items.length !== input.privateInputItemCount
    || plan.target.physicalIdentitySha256 !== input.physicalIdentitySha256
    || plan.target.plannerLoginIdentitySha256 !== input.plannerLoginIdentitySha256
    || plan.mutationEnabled !== false
    || JSON.stringify(plan.activationBlockers)
      !== JSON.stringify(POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS)
  ) fail("plan_result_invalid");
  return plan;
}

async function runPostgresReviewedPricePromotionCliWithDependencies(
  argv: readonly string[],
  dependencies: PostgresReviewedPricePromotionCliDependencies,
): Promise<0 | 1> {
  let databaseHandle: PostgresReviewedPricePromotionPlannerDatabaseHandle | null = null;
  let parentAuthority: PrivateParentAuthority | null = null;
  const heldFiles: HeldPrivateFile[] = [];
  let rootCaFile: HeldPrivateFile | null = null;
  let plan: PostgresReviewedPricePromotionPlanCandidate | null = null;
  let outputPlan = "";
  let failureCode: PostgresReviewedPricePromotionCliFailureCode | null = null;
  let summaryInput: {
    readonly candidateSha: string;
    readonly expectedEnvironment: "permanent-staging";
    readonly itemCount: number;
    readonly physicalIdentitySha256: string;
    readonly plannerLoginIdentitySha256: string;
  } | null = null;

  try {
    if (argv[0] !== POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND) {
      fail("argument_invalid");
    }
    let args: ReadonlyMap<string, string>;
    try {
      args = parseStrictArguments(argv.slice(1), {
        allowed: ARGUMENTS,
        required: ARGUMENTS,
      });
    } catch {
      return fail("argument_invalid");
    }
    if (args.get("--expected-environment") !== "permanent-staging") {
      fail("environment_not_allowed");
    }
    assertNoForbiddenAmbientAuthority(dependencies.environment);

    const candidateSha = exactCandidateSha(args.get("--candidate-sha")!);
    const deployment = {
      deploymentIdSha256: exactSha256(args.get("--deployment-id-sha256")!),
      environmentIdSha256: exactSha256(
        args.get("--deployment-environment-id-sha256")!,
      ),
      imageDigestSha256: exactSha256(
        args.get("--deployment-image-digest-sha256")!,
      ),
      projectIdSha256: exactSha256(
        args.get("--deployment-project-id-sha256")!,
      ),
      serviceIdSha256: exactSha256(
        args.get("--deployment-service-id-sha256")!,
      ),
    };
    const plannerUrlPath = exactAbsolutePath(args.get("--planner-url-file")!);
    const migrationReceiptPath = exactAbsolutePath(args.get("--migration-receipt")!);
    const migrationTargetIdentityPath = exactAbsolutePath(
      args.get("--migration-target-identity")!,
    );
    const privateInputPath = exactAbsolutePath(args.get("--private-input")!);
    outputPlan = exactAbsolutePath(args.get("--output-plan")!);
    if (
      new Set([
        plannerUrlPath,
        migrationReceiptPath,
        migrationTargetIdentityPath,
        privateInputPath,
        outputPlan,
      ]).size !== 5
    ) fail("argument_invalid");
    const commonParent = path.dirname(plannerUrlPath);
    if ([
      migrationReceiptPath,
      migrationTargetIdentityPath,
      privateInputPath,
      outputPlan,
    ].some((filename) => path.dirname(filename) !== commonParent)) {
      fail("artifact_file_unsafe");
    }
    parentAuthority = await openPrivateParentAuthority(commonParent);
    if (await pathExists(outputPlan)) fail("output_file_unsafe");

    const plannerUrlFile = await openHeldPrivateFile(
      parentAuthority,
      plannerUrlPath,
      MAX_PLANNER_URL_FILE_BYTES,
    );
    heldFiles.push(plannerUrlFile);
    assertHeldFileHash(
      plannerUrlFile,
      exactSha256(args.get("--planner-url-sha256")!),
    );
    const plannerUrl = directVerifyFullPlannerUrl(plannerUrlFile.bytes);
    if (
      path.dirname(plannerUrl.rootCaFile) !== commonParent
      || new Set([
        plannerUrlPath,
        plannerUrl.rootCaFile,
        migrationReceiptPath,
        migrationTargetIdentityPath,
        privateInputPath,
        outputPlan,
      ]).size !== 6
    ) fail("artifact_file_unsafe");
    rootCaFile = await openHeldPrivateFile(
      parentAuthority,
      plannerUrl.rootCaFile,
      MAX_ROOT_CA_BYTES,
    );
    heldFiles.push(rootCaFile);

    const migrationReceiptFile = await openHeldPrivateFile(
      parentAuthority,
      migrationReceiptPath,
      MAX_MIGRATION_RECEIPT_BYTES,
    );
    heldFiles.push(migrationReceiptFile);
    const migrationReceipt = readCanonicalJsonArtifact({
      held: migrationReceiptFile,
      expectedSha256: exactSha256(args.get("--migration-receipt-sha256")!),
      parse: (value) => postgresMigrationReceiptSchema.safeParse(value),
    });
    const migrationTargetIdentityFile = await openHeldPrivateFile(
      parentAuthority,
      migrationTargetIdentityPath,
      MAX_MIGRATION_TARGET_IDENTITY_BYTES,
    );
    heldFiles.push(migrationTargetIdentityFile);
    const migrationTargetIdentity = readCanonicalJsonArtifact({
      held: migrationTargetIdentityFile,
      expectedSha256: exactSha256(
        args.get("--migration-target-identity-sha256")!,
      ),
      parse: (value) => postgresMigrationTargetIdentitySchema.safeParse(value),
    });
    const privateInputFile = await openHeldPrivateFile(
      parentAuthority,
      privateInputPath,
      MAX_PRIVATE_INPUT_BYTES,
    );
    heldFiles.push(privateInputFile);
    const privateInput = readCanonicalJsonArtifact({
      held: privateInputFile,
      expectedSha256: exactSha256(args.get("--private-input-sha256")!),
      parse: (value) => postgresReviewedPricePromotionPrivateInputSchema.safeParse(value),
    });
    const expectedRootCaDerSha256 = exactSha256(
      dependencies.expectedRootCaDerSha256,
    );
    await assertHeldAuthorityExact({
      authority: parentAuthority,
      files: heldFiles,
      rootCa: rootCaFile,
      expectedRootCaDerSha256,
    });
    const expectedPhysicalDatabaseIdentitySha256 = exactSha256(
      args.get("--expected-target-database-identity-sha256")!,
    );
    let historicalPhysicalDatabaseIdentitySha256: string;
    try {
      historicalPhysicalDatabaseIdentitySha256 =
        sha256PostgresDatabaseIdentity(migrationTargetIdentity.value);
    } catch {
      return fail("artifact_invalid");
    }
    if (
      migrationReceipt.value.expectedEnvironment !== "permanent-staging"
      || migrationReceipt.value.candidateSha !== candidateSha
      || migrationReceipt.value.targetIdentitySha256 !== migrationTargetIdentity.sha256
      || sha256PostgresMigrationTargetIdentity(migrationTargetIdentity.value)
        !== migrationTargetIdentity.sha256
      || historicalPhysicalDatabaseIdentitySha256
        !== expectedPhysicalDatabaseIdentitySha256
    ) fail("artifact_invalid");
    const expectedPlannerLoginIdentitySha256 =
      sha256PostgresReviewedPricePromotionValue({
        currentUser: PLANNER_ROLE,
        databaseName: migrationTargetIdentity.value.databaseName,
        databaseOid: migrationTargetIdentity.value.databaseOid,
        serverVersionNum: migrationTargetIdentity.value.serverVersionNum,
        sessionUser: PLANNER_ROLE,
        systemIdentifier: migrationTargetIdentity.value.systemIdentifier,
      });

    summaryInput = {
      candidateSha,
      expectedEnvironment: "permanent-staging",
      itemCount: privateInput.value.itemCount,
      physicalIdentitySha256: expectedPhysicalDatabaseIdentitySha256,
      plannerLoginIdentitySha256: expectedPlannerLoginIdentitySha256,
    };
    try {
      databaseHandle = await dependencies.openDatabase({
        applicationName: "pintpath-reviewed-price-promotion-planner",
        connectionTimeoutMs: 10_000,
        database: PERMANENT_STAGING_DATABASE,
        expectedRootCaDerSha256,
        hostname: PERMANENT_STAGING_HOST,
        idleInTransactionTimeoutMs: 10_000,
        idleTimeoutMs: 5_000,
        maxConnections: 1,
        password: plannerUrl.password,
        port: 5_432,
        rootCaFile: plannerUrl.rootCaFile,
        statementTimeoutMs: 30_000,
        user: PLANNER_ROLE,
      });
      if (
        !databaseHandle
        || databaseHandle.database?.dialect !== "postgres"
        || typeof databaseHandle.assertExact !== "function"
        || typeof databaseHandle.release !== "function"
      ) fail("database_open_failed");
    } catch (error) {
      if (error instanceof SafeCliError) throw error;
      return fail("database_open_failed");
    }
    await assertHeldAuthorityExact({
      authority: parentAuthority,
      files: heldFiles,
      rootCa: rootCaFile,
      expectedRootCaDerSha256,
    });
    await assertPlannerDatabaseExact(databaseHandle);
    const candidate = await dependencies.buildPlan({
      candidateSha,
      database: databaseHandle.database,
      expectedDeployment: deployment,
      expectedEnvironment: "permanent-staging",
      expectedMigration: { receiptFileSha256: migrationReceipt.sha256 },
      migrationReceipt: migrationReceipt.value,
      migrationTargetIdentity: migrationTargetIdentity.value,
      expectedPrivateInputSha256: privateInput.sha256,
      expectedPhysicalDatabaseIdentitySha256,
      privateInput: privateInput.value,
    });
    await assertPlannerDatabaseExact(databaseHandle);
    await assertHeldAuthorityExact({
      authority: parentAuthority,
      files: heldFiles,
      rootCa: rootCaFile,
      expectedRootCaDerSha256,
    });
    plan = assertExactPlanBindings({
      plan: candidate,
      candidateSha,
      deployment,
      migrationReceiptFileSha256: migrationReceipt.sha256,
      privateInputFileSha256: privateInput.sha256,
      privateInputItemCount: privateInput.value.itemCount,
      physicalIdentitySha256: expectedPhysicalDatabaseIdentitySha256,
      plannerLoginIdentitySha256: expectedPlannerLoginIdentitySha256,
    });
  } catch (error) {
    failureCode = safeFailureCode(error);
    plan = null;
  }

  if (databaseHandle) {
    if (parentAuthority && rootCaFile) {
      try {
        await assertHeldAuthorityExact({
          authority: parentAuthority,
          files: heldFiles,
          rootCa: rootCaFile,
          expectedRootCaDerSha256: dependencies.expectedRootCaDerSha256,
        });
      } catch (error) {
        failureCode = safeFailureCode(error);
        plan = null;
      }
    }
    try {
      await databaseHandle.assertExact();
    } catch {
      failureCode = "database_release_failed";
      plan = null;
    }
    try {
      await databaseHandle.release();
    } catch {
      failureCode = "database_release_failed";
      plan = null;
    }
    if (parentAuthority && rootCaFile) {
      try {
        await assertHeldAuthorityExact({
          authority: parentAuthority,
          files: heldFiles,
          rootCa: rootCaFile,
          expectedRootCaDerSha256: dependencies.expectedRootCaDerSha256,
        });
      } catch (error) {
        failureCode = safeFailureCode(error);
        plan = null;
      }
    }
  }

  let publishedPlan: PublishedPrivatePlan | null = null;
  let planFileSha256: string | null = null;
  if (plan && !failureCode && parentAuthority && rootCaFile) {
    try {
      await assertHeldAuthorityExact({
        authority: parentAuthority,
        files: heldFiles,
        rootCa: rootCaFile,
        expectedRootCaDerSha256: dependencies.expectedRootCaDerSha256,
      });
      publishedPlan = await writeNewPrivateCanonicalPlan(
        parentAuthority,
        outputPlan,
        plan,
      );
      planFileSha256 = publishedPlan.sha256;
      await assertHeldAuthorityExact({
        authority: parentAuthority,
        files: heldFiles,
        rootCa: rootCaFile,
        expectedRootCaDerSha256: dependencies.expectedRootCaDerSha256,
      });
    } catch (error) {
      failureCode = safeFailureCode(error);
      plan = null;
    }
  }

  const heldAuthorityClosed = await closeHeldAuthority({
    authority: parentAuthority,
    files: heldFiles,
  });
  if (!heldAuthorityClosed) {
    failureCode = "artifact_file_unsafe";
    plan = null;
  }

  if (publishedPlan && plan && !failureCode) {
    try {
      await publishedPlan.close();
    } catch {
      failureCode = "output_file_unsafe";
      plan = null;
    }
  }
  if (publishedPlan && (!plan || failureCode)) {
    try {
      await publishedPlan.rollback();
    } catch {
      failureCode = "output_file_unsafe";
    }
    publishedPlan = null;
    planFileSha256 = null;
  }

  try {
    if (!plan || !planFileSha256 || !summaryInput || failureCode) {
      writeSummary(dependencies, {
        command: POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND,
        failureCode: failureCode ?? "unexpected_failure",
        ok: false,
      });
      return 1;
    }
    writeSummary(dependencies, {
      activationBlockerCount: plan.activationBlockers.length,
      candidateSha: summaryInput.candidateSha,
      command: POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND,
      expectedEnvironment: summaryInput.expectedEnvironment,
      itemCount: summaryInput.itemCount,
      mutationEnabled: false,
      ok: true,
      planCandidateSha256: plan.planCandidateSha256,
      planFileSha256,
      physicalIdentitySha256: summaryInput.physicalIdentitySha256,
      plannerLoginIdentitySha256: summaryInput.plannerLoginIdentitySha256,
    });
    return 0;
  } catch {
    if (publishedPlan) {
      try {
        await publishedPlan.rollback();
      } catch {
        // The synchronous summary capability already failed closed.
      }
    }
    return 1;
  }
}

export async function runPostgresReviewedPricePromotionCli(
  argv: readonly string[],
): Promise<0 | 1> {
  return runPostgresReviewedPricePromotionCliWithDependencies(
    argv,
    POSTGRES_REVIEWED_PRICE_PROMOTION_RUNTIME,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresReviewedPricePromotionCli(
    process.argv.slice(2),
  );
}

export const postgresReviewedPricePromotionCliInternals = Object.freeze({
  ARGUMENT_COUNT: ARGUMENTS.size,
  MAX_MIGRATION_RECEIPT_BYTES,
  MAX_MIGRATION_TARGET_IDENTITY_BYTES,
  MAX_PLAN_BYTES,
  MAX_PLANNER_URL_FILE_BYTES,
  MAX_PRIVATE_INPUT_BYTES,
});
