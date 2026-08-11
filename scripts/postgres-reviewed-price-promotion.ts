import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder, types as utilTypes } from "node:util";
import { fileURLToPath } from "node:url";

import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
} from "../src/db/sql-database.js";
import postgresRuntime, {
  type Client,
  type ClientConfig,
  type Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";
// These production dependencies are values, not deferred imports. The locked
// bootstrap must finish evaluating the complete pg/SQL graph before it seals
// module loading and before either private database input is read.
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
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RECEIPT_BYTES,
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256,
  parseRailwayApplicationDeploymentAttestationReceipt,
  railwayApplicationDeploymentAttestationReceiptFreshAt,
  type RailwayApplicationDeploymentAttestationReceipt,
} from "../src/lib/railway-application-deployment-attestation.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
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

export const POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND = "plan" as const;

const ARGUMENT_COUNT = 14;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTROL_CHARACTER_PATTERN = /[\r\n\0]/;
const PEM_BODY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const FORBIDDEN_DATABASE_URL_PATTERN = /^PINTPATH_.*DATABASE_URL/;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_SLICE = Array.prototype.slice;
const BUFFER_CONSTRUCTOR = Buffer;
const BUFFER_ALLOC = Buffer.alloc;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_EQUALS = Buffer.prototype.equals;
const BUFFER_FROM = Buffer.from;
const BUFFER_IS_BUFFER = Buffer.isBuffer;
const BUFFER_TO_STRING = Buffer.prototype.toString;
const BIGINT_CONSTRUCTOR = BigInt;
const CRYPTO_OBJECT = crypto;
const CRYPTO_RANDOM_BYTES = crypto.randomBytes;
const CRYPTO_X509_CERTIFICATE = crypto.X509Certificate;
const X509_CERTIFICATE_PROTOTYPE = crypto.X509Certificate.prototype;
const X509_CHECK_ISSUED = X509_CERTIFICATE_PROTOTYPE.checkIssued;
const X509_VERIFY = X509_CERTIFICATE_PROTOTYPE.verify;
const DATE_NOW = Date.now;
const DATE_OBJECT = Date;
const DATE_PARSE = Date.parse;
const DECODE_URI_COMPONENT = decodeURIComponent;
const JSON_OBJECT = JSON;
const JSON_PARSE = JSON.parse;
const NUMBER_TO_STRING = Number.prototype.toString;
const NUMBER_OBJECT = Number;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_INTEGER = Number.isInteger;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const X509_CA_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  X509_CERTIFICATE_PROTOTYPE,
  "ca",
)?.get;
const X509_ISSUER_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  X509_CERTIFICATE_PROTOTYPE,
  "issuer",
)?.get;
const X509_PUBLIC_KEY_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  X509_CERTIFICATE_PROTOTYPE,
  "publicKey",
)?.get;
const X509_RAW_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  X509_CERTIFICATE_PROTOTYPE,
  "raw",
)?.get;
const X509_SUBJECT_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  X509_CERTIFICATE_PROTOTYPE,
  "subject",
)?.get;
const X509_VALID_FROM_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  X509_CERTIFICATE_PROTOTYPE,
  "validFrom",
)?.get;
const X509_VALID_TO_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  X509_CERTIFICATE_PROTOTYPE,
  "validTo",
)?.get;
const PATH_OBJECT = path;
const PATH_DIRNAME = path.dirname;
const PATH_IS_ABSOLUTE = path.isAbsolute;
const PATH_JOIN = path.join;
const PATH_NORMALIZE = path.normalize;
const PATH_RESOLVE = path.resolve;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_CONSTRUCT = Reflect.construct;
const REFLECT_DEFINE_PROPERTY = Reflect.defineProperty;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REFLECT_OBJECT = Reflect;
const REGEXP_EXEC = RegExp.prototype.exec;
const SET_HAS = Set.prototype.has;
const STRING_ENDS_WITH = String.prototype.endsWith;
const STRING_CHAR_AT = String.prototype.charAt;
const STRING_INCLUDES = String.prototype.includes;
const STRING_INDEX_OF = String.prototype.indexOf;
const STRING_SLICE = String.prototype.slice;
const STRING_STARTS_WITH = String.prototype.startsWith;
const STRING_TO_UPPER_CASE = String.prototype.toUpperCase;
const STRING_TRIM = String.prototype.trim;
const TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "length",
)?.get;
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill;
const URL_CONSTRUCTOR = URL;
const URL_PROTOTYPE = URL.prototype;
const URL_HASH_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "hash")?.get;
const URL_HOSTNAME_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "hostname")?.get;
const URL_PASSWORD_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "password")?.get;
const URL_PATHNAME_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "pathname")?.get;
const URL_PORT_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "port")?.get;
const URL_PROTOCOL_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "protocol")?.get;
const URL_SEARCH_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "search")?.get;
const URL_SEARCH_PARAMS_GETTER = Object.getOwnPropertyDescriptor(
  URL.prototype,
  "searchParams",
)?.get;
const URL_TO_STRING = URL.prototype.toString;
const URL_USERNAME_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "username")?.get;
const URL_SEARCH_PARAMS_CONSTRUCTOR = URLSearchParams;
const URL_SEARCH_PARAMS_PROTOTYPE = URLSearchParams.prototype;
const URL_SEARCH_PARAMS_APPEND = URLSearchParams.prototype.append;
const URL_SEARCH_PARAMS_GET = URLSearchParams.prototype.get;
const URL_SEARCH_PARAMS_GET_ALL = URLSearchParams.prototype.getAll;
const URL_SEARCH_PARAMS_TO_STRING = URLSearchParams.prototype.toString;
const UTIL_IS_PROXY = utilTypes.isProxy;
const UTIL_TYPES_OBJECT = utilTypes;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

const FS_PROMISES_OBJECT = fs.promises;
const PROCESS_OBJECT = process;
const PROCESS_GETEUID = process.geteuid;
const PROCESS_ENVIRONMENT = process.env;
const FS_PROMISES_LINK = fs.promises.link;
const FS_PROMISES_LSTAT = fs.promises.lstat;
const FS_PROMISES_OPEN = fs.promises.open;
const FS_PROMISES_REALPATH = fs.promises.realpath;
const FS_PROMISES_UNLINK = fs.promises.unlink;
const O_CREAT = fs.constants.O_CREAT;
const O_DIRECTORY = fs.constants.O_DIRECTORY;
const O_EXCL = fs.constants.O_EXCL;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const O_RDONLY = fs.constants.O_RDONLY;
const O_RDWR = fs.constants.O_RDWR;
const S_IFDIR = REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [fs.constants.S_IFDIR]);
const S_IFMT = REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [fs.constants.S_IFMT]);
const S_IFREG = REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [fs.constants.S_IFREG]);

const FILE_HANDLE_PROBE = await REFLECT_APPLY(
  FS_PROMISES_OPEN,
  FS_PROMISES_OBJECT,
  [fileURLToPath(import.meta.url), O_RDONLY],
) as fs.promises.FileHandle;
const FILE_HANDLE_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(FILE_HANDLE_PROBE) as {
  chmod: (...args: never[]) => unknown;
  read: (...args: never[]) => unknown;
  stat: (...args: never[]) => unknown;
  sync: (...args: never[]) => unknown;
  truncate: (...args: never[]) => unknown;
  writeFile: (...args: never[]) => unknown;
};
const FILE_HANDLE_CHMOD = FILE_HANDLE_PROTOTYPE.chmod;
const FILE_HANDLE_PROBE_CLOSE = FILE_HANDLE_PROBE.close;
const FILE_HANDLE_READ = FILE_HANDLE_PROTOTYPE.read;
const FILE_HANDLE_STAT = FILE_HANDLE_PROTOTYPE.stat;
const FILE_HANDLE_SYNC = FILE_HANDLE_PROTOTYPE.sync;
const FILE_HANDLE_TRUNCATE = FILE_HANDLE_PROTOTYPE.truncate;
const FILE_HANDLE_WRITE_FILE = FILE_HANDLE_PROTOTYPE.writeFile;
await REFLECT_APPLY(FILE_HANDLE_PROBE_CLOSE, FILE_HANDLE_PROBE, []);
const FILE_HANDLE_CLOSES = new WeakMap<
  fs.promises.FileHandle,
  () => Promise<void>
>();
const LOWERCASE_HEX = "0123456789abcdef";
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
const HELD_FILE_COUNT = 6;

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
const SAFE_CLI_ERROR_BRAND = new WeakSet<object>();

class SafeCliError extends Error {
  constructor(readonly code: PostgresReviewedPricePromotionCliFailureCode) {
    super(code);
    this.name = "SafeCliError";
    REFLECT_APPLY(WEAK_SET_ADD, SAFE_CLI_ERROR_BRAND, [this]);
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
  readonly assertProductionBoundary?: () => void;
  readonly openDatabase: (
    options: PostgresReviewedPricePromotionPlannerDatabaseOptions,
  ) => PostgresReviewedPricePromotionPlannerDatabaseHandle
    | Promise<PostgresReviewedPricePromotionPlannerDatabaseHandle>;
  readonly buildPlan: (
    input: BuildPostgresReviewedPricePromotionPlanInput,
  ) => Promise<PostgresReviewedPricePromotionPlanCandidate>;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly expectedRootCaDerSha256: string;
  readonly now: () => Date;
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
    && !ARRAY_IS_ARRAY(bindings[0])
    && !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_CONSTRUCTOR, [bindings[0]])
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
        assertNoForbiddenAmbientAuthority(PROCESS_ENVIRONMENT);
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
      assertNoForbiddenAmbientAuthority(PROCESS_ENVIRONMENT);
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
    return {
      Client: postgresRuntime.Client,
      Pool: postgresRuntime.Pool,
      compileQuery: sqlDatabaseInternals.compilePostgresQuery,
      createTypeOverrides: sqlDatabaseInternals.createPostgresTypeOverrides,
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
    || !regexMatches(SHA256_PATTERN, options.expectedRootCaDerSha256)
    || options.hostname !== PERMANENT_STAGING_HOST
    || options.idleInTransactionTimeoutMs !== 10_000
    || options.idleTimeoutMs !== 5_000
    || options.maxConnections !== 1
    || typeof options.password !== "string"
    || !options.password
    || regexMatches(CONTROL_CHARACTER_PATTERN, options.password)
    || options.port !== 5_432
    || REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [options.rootCaFile])
      === options.rootCaFile
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
      expectedUid: REFLECT_APPLY(NUMBER_OBJECT, undefined, [effectiveUid()]) as number,
      sourceUrlAuthority: {
        hostname: options.hostname,
        port: options.port,
      },
    });
    await transport.assertExact();
    assertNoForbiddenAmbientAuthority(PROCESS_ENVIRONMENT);
    const runtime = await dependencies.loadPgRuntime();
    assertNoForbiddenAmbientAuthority(PROCESS_ENVIRONMENT);
    await transport.assertExact();
    const RuntimeClient = runtime.Client;
    class AuthorityGuardedPlannerClient extends RuntimeClient {
      constructor(config?: string | ClientConfig) {
        assertNoForbiddenAmbientAuthority(PROCESS_ENVIRONMENT);
        super(config);
        assertNoForbiddenAmbientAuthority(PROCESS_ENVIRONMENT);
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
      options: "-c search_path=pg_catalog -c default_transaction_read_only=on"
        + " -c row_security=on -c statement_timeout=30000"
        + " -c idle_in_transaction_session_timeout=10000"
        + " -c lock_timeout=10000 -c synchronous_commit=on",
      types: runtime.createTypeOverrides(),
    };
    if (REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_CONSTRUCTOR,
      [poolConfig, "connectionString"],
    )) fail("database_open_failed");
    assertNoForbiddenAmbientAuthority(PROCESS_ENVIRONMENT);
    pool = new runtime.Pool(poolConfig);
    assertNoForbiddenAmbientAuthority(PROCESS_ENVIRONMENT);
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
    assertNoForbiddenAmbientAuthority(PROCESS_ENVIRONMENT);
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
  readonly sha256: string;
  assertExact(): Promise<void>;
  close(): Promise<void>;
}

interface HeldPrivateFileState {
  readonly authority: PrivateParentAuthority;
  readonly filename: string;
  readonly handle: fs.promises.FileHandle;
  readonly identity: StableFileIdentity;
  readonly maximumBytes: number;
  readonly sha256: string;
  readonly size: number;
  readonly uid: bigint;
  closed: boolean;
}

const HELD_PRIVATE_FILE_STATES = new WeakMap<
  HeldPrivateFile,
  HeldPrivateFileState
>();

interface ExactCliArguments {
  readonly candidateSha: string;
  readonly deploymentAttestation: string;
  readonly deploymentAttestationSha256: string;
  readonly expectedEnvironment: string;
  readonly expectedTargetDatabaseIdentitySha256: string;
  readonly migrationReceipt: string;
  readonly migrationReceiptSha256: string;
  readonly migrationTargetIdentity: string;
  readonly migrationTargetIdentitySha256: string;
  readonly outputPlan: string;
  readonly plannerUrlFile: string;
  readonly plannerUrlSha256: string;
  readonly privateInput: string;
  readonly privateInputSha256: string;
}

function fail(code: PostgresReviewedPricePromotionCliFailureCode): never {
  throw new SafeCliError(code);
}

function isSafeCliError(value: unknown): value is SafeCliError {
  return value !== null
    && typeof value === "object"
    && REFLECT_APPLY(WEAK_SET_HAS, SAFE_CLI_ERROR_BRAND, [value]) === true;
}

function isProxy(value: object): boolean {
  return REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_OBJECT, [value]) as boolean;
}

function ownDataValue(
  value: object,
  key: string,
  failureCode: "argument_invalid" | "artifact_file_unsafe" | "output_file_unsafe",
): unknown {
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [value, key],
  ) as PropertyDescriptor | undefined;
  if (
    !descriptor
    || REFLECT_APPLY(OBJECT_HAS_OWN, OBJECT_CONSTRUCTOR, [descriptor, "value"])
      !== true
  ) fail(failureCode);
  return descriptor.value;
}

function ownDependencyValue(
  value: object,
  key: string,
  failureCode: "argument_invalid" | "database_open_failed" = "argument_invalid",
): unknown {
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [value, key],
  ) as PropertyDescriptor | undefined;
  if (!descriptor) fail(failureCode);
  if (REFLECT_APPLY(OBJECT_HAS_OWN, OBJECT_CONSTRUCTOR, [descriptor, "value"])) {
    return descriptor.value;
  }
  if (typeof descriptor.get !== "function" || descriptor.set !== undefined) {
    fail(failureCode);
  }
  return REFLECT_APPLY(descriptor.get, value, []);
}

function snapshotCliDependencies(
  input: PostgresReviewedPricePromotionCliDependencies,
): PostgresReviewedPricePromotionCliDependencies {
  if (input === null || typeof input !== "object" || isProxy(input)) {
    fail("argument_invalid");
  }
  const openDatabase = ownDependencyValue(input, "openDatabase");
  const buildPlan = ownDependencyValue(input, "buildPlan");
  const environment = ownDependencyValue(input, "environment");
  const expectedRootCaDerSha256 = ownDependencyValue(
    input,
    "expectedRootCaDerSha256",
  );
  const now = ownDependencyValue(input, "now");
  const writeOutput = ownDependencyValue(input, "writeOutput");
  if (
    typeof openDatabase !== "function"
    || typeof buildPlan !== "function"
    || environment === null
    || typeof environment !== "object"
    || isProxy(environment)
    || typeof expectedRootCaDerSha256 !== "string"
    || typeof now !== "function"
    || typeof writeOutput !== "function"
  ) fail("argument_invalid");
  return OBJECT_FREEZE({
    openDatabase,
    buildPlan,
    environment: environment as Readonly<NodeJS.ProcessEnv>,
    expectedRootCaDerSha256,
    now,
    writeOutput,
  }) as PostgresReviewedPricePromotionCliDependencies;
}

function snapshotPlannerDatabaseHandle(
  input: unknown,
): PostgresReviewedPricePromotionPlannerDatabaseHandle {
  if (input === null || typeof input !== "object" || isProxy(input)) {
    fail("database_open_failed");
  }
  const database = ownDependencyValue(input, "database", "database_open_failed");
  const assertExact = ownDependencyValue(input, "assertExact", "database_open_failed");
  const release = ownDependencyValue(input, "release", "database_open_failed");
  const dialect = database !== null && typeof database === "object"
    ? ownDependencyValue(database, "dialect", "database_open_failed")
    : null;
  if (
    database === null
    || typeof database !== "object"
    || isProxy(database)
    || dialect !== "postgres"
    || typeof assertExact !== "function"
    || typeof release !== "function"
  ) fail("database_open_failed");
  return OBJECT_FREEZE({
    database: database as SqlDatabase,
    assertExact: () => REFLECT_APPLY(assertExact, input, []) as Promise<void>,
    release: () => REFLECT_APPLY(release, input, []) as Promise<void>,
  });
}

function exactArrayLength(
  value: readonly unknown[],
  failureCode: "argument_invalid" | "artifact_file_unsafe",
): number {
  if (
    !ARRAY_IS_ARRAY(value)
    || isProxy(value)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [value])
      !== ARRAY_PROTOTYPE
  ) fail(failureCode);
  const length = ownDataValue(value, "length", failureCode);
  if (
    !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [length])
    || (length as number) < 0
  ) fail(failureCode);
  return length as number;
}

function exactArrayItem(
  value: readonly unknown[],
  index: number,
  failureCode: "argument_invalid" | "artifact_file_unsafe",
): unknown {
  const key = REFLECT_APPLY(NUMBER_TO_STRING, index, []) as string;
  return ownDataValue(value, key, failureCode);
}

function argumentSlot(name: string): number {
  switch (name) {
    case "--candidate-sha": return 0;
    case "--deployment-attestation": return 1;
    case "--deployment-attestation-sha256": return 2;
    case "--expected-environment": return 3;
    case "--expected-target-database-identity-sha256": return 4;
    case "--migration-receipt": return 5;
    case "--migration-receipt-sha256": return 6;
    case "--migration-target-identity": return 7;
    case "--migration-target-identity-sha256": return 8;
    case "--output-plan": return 9;
    case "--planner-url-file": return 10;
    case "--planner-url-sha256": return 11;
    case "--private-input": return 12;
    case "--private-input-sha256": return 13;
    default: return -1;
  }
}

function defineArraySlot(
  value: unknown[],
  index: number,
  item: unknown,
  failureCode: "argument_invalid" | "artifact_file_unsafe",
): void {
  const key = REFLECT_APPLY(NUMBER_TO_STRING, index, []) as string;
  if (!REFLECT_APPLY(REFLECT_DEFINE_PROPERTY, REFLECT_OBJECT, [value, key, {
    configurable: true,
    enumerable: true,
    value: item,
    writable: true,
  }])) fail(failureCode);
}

function parseExactCliArguments(argv: readonly string[]): ExactCliArguments {
  const length = exactArrayLength(argv, "argument_invalid");
  if (length < ARGUMENT_COUNT + 1 || length > ARGUMENT_COUNT * 2 + 1) {
    fail("argument_invalid");
  }
  if (
    exactArrayItem(argv, 0, "argument_invalid")
    !== POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND
  ) fail("argument_invalid");

  const slots: Array<string | null> = [
    null, null, null, null, null, null, null,
    null, null, null, null, null, null, null,
  ];
  let index = 1;
  while (index < length) {
    const token = exactArrayItem(argv, index, "argument_invalid");
    if (typeof token !== "string" || token.length < 3) fail("argument_invalid");
    const equalsAt = REFLECT_APPLY(STRING_INDEX_OF, token, ["="]) as number;
    let name: string;
    let argumentValue: string;
    if (equalsAt >= 0) {
      name = REFLECT_APPLY(STRING_SLICE, token, [0, equalsAt]) as string;
      argumentValue = REFLECT_APPLY(STRING_SLICE, token, [equalsAt + 1]) as string;
      index += 1;
    } else {
      name = token;
      index += 1;
      if (index >= length) fail("argument_invalid");
      const next = exactArrayItem(argv, index, "argument_invalid");
      if (typeof next !== "string") fail("argument_invalid");
      argumentValue = next;
      index += 1;
    }
    if (
      argumentValue.length === 0
      || REFLECT_APPLY(STRING_STARTS_WITH, argumentValue, ["--"]) === true
    ) fail("argument_invalid");
    const slot = argumentSlot(name);
    if (slot < 0 || exactArrayItem(slots, slot, "argument_invalid") !== null) {
      fail("argument_invalid");
    }
    defineArraySlot(slots, slot, argumentValue, "argument_invalid");
  }
  for (let slot = 0; slot < ARGUMENT_COUNT; slot += 1) {
    if (typeof exactArrayItem(slots, slot, "argument_invalid") !== "string") {
      fail("argument_invalid");
    }
  }
  return OBJECT_FREEZE({
    candidateSha: exactArrayItem(slots, 0, "argument_invalid") as string,
    deploymentAttestation: exactArrayItem(slots, 1, "argument_invalid") as string,
    deploymentAttestationSha256:
      exactArrayItem(slots, 2, "argument_invalid") as string,
    expectedEnvironment: exactArrayItem(slots, 3, "argument_invalid") as string,
    expectedTargetDatabaseIdentitySha256:
      exactArrayItem(slots, 4, "argument_invalid") as string,
    migrationReceipt: exactArrayItem(slots, 5, "argument_invalid") as string,
    migrationReceiptSha256: exactArrayItem(slots, 6, "argument_invalid") as string,
    migrationTargetIdentity:
      exactArrayItem(slots, 7, "argument_invalid") as string,
    migrationTargetIdentitySha256:
      exactArrayItem(slots, 8, "argument_invalid") as string,
    outputPlan: exactArrayItem(slots, 9, "argument_invalid") as string,
    plannerUrlFile: exactArrayItem(slots, 10, "argument_invalid") as string,
    plannerUrlSha256: exactArrayItem(slots, 11, "argument_invalid") as string,
    privateInput: exactArrayItem(slots, 12, "argument_invalid") as string,
    privateInputSha256: exactArrayItem(slots, 13, "argument_invalid") as string,
  });
}

function exactFileHandle(
  value: unknown,
  failureCode: "artifact_file_unsafe" | "output_file_unsafe",
): fs.promises.FileHandle {
  if (
    value === null
    || typeof value !== "object"
    || isProxy(value)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [value])
      !== FILE_HANDLE_PROTOTYPE
  ) fail(failureCode);
  return value as fs.promises.FileHandle;
}

async function capturedOpen(
  filename: string,
  flags: number,
  mode: number | undefined,
  failureCode: "artifact_file_unsafe" | "output_file_unsafe",
): Promise<fs.promises.FileHandle> {
  const argumentsList = mode === undefined
    ? [filename, flags]
    : [filename, flags, mode];
  const opened = await REFLECT_APPLY(
    FS_PROMISES_OPEN,
    FS_PROMISES_OBJECT,
    argumentsList,
  );
  const handle = exactFileHandle(opened, failureCode);
  const close = ownDataValue(handle, "close", failureCode);
  if (typeof close !== "function") fail(failureCode);
  REFLECT_APPLY(WEAK_MAP_SET, FILE_HANDLE_CLOSES, [handle, close]);
  return handle;
}

async function capturedLstat(
  filename: string,
  failureCode: "artifact_file_unsafe" | "output_file_unsafe",
): Promise<fs.BigIntStats> {
  const value = await REFLECT_APPLY(FS_PROMISES_LSTAT, FS_PROMISES_OBJECT, [
    filename,
    { bigint: true },
  ]);
  if (value === null || typeof value !== "object" || isProxy(value)) {
    fail(failureCode);
  }
  return value as fs.BigIntStats;
}

async function capturedRealpath(
  filename: string,
  failureCode: "artifact_file_unsafe" | "output_file_unsafe",
): Promise<string> {
  const value = await REFLECT_APPLY(
    FS_PROMISES_REALPATH,
    FS_PROMISES_OBJECT,
    [filename],
  );
  if (typeof value !== "string") fail(failureCode);
  return value;
}

async function capturedLink(
  existingPath: string,
  newPath: string,
): Promise<void> {
  await REFLECT_APPLY(FS_PROMISES_LINK, FS_PROMISES_OBJECT, [
    existingPath,
    newPath,
  ]);
}

async function capturedUnlink(filename: string): Promise<void> {
  await REFLECT_APPLY(FS_PROMISES_UNLINK, FS_PROMISES_OBJECT, [filename]);
}

async function capturedHandleStat(
  handle: fs.promises.FileHandle,
  failureCode: "artifact_file_unsafe" | "output_file_unsafe",
): Promise<fs.BigIntStats> {
  exactFileHandle(handle, failureCode);
  const value = await REFLECT_APPLY(FILE_HANDLE_STAT, handle, [{ bigint: true }]);
  if (value === null || typeof value !== "object" || isProxy(value)) {
    fail(failureCode);
  }
  return value as fs.BigIntStats;
}

async function capturedHandleRead(
  handle: fs.promises.FileHandle,
  bytes: Buffer,
  offset: number,
  length: number,
  position: number,
  failureCode: "artifact_file_unsafe" | "output_file_unsafe",
): Promise<number> {
  exactFileHandle(handle, failureCode);
  const value = await REFLECT_APPLY(FILE_HANDLE_READ, handle, [
    bytes,
    offset,
    length,
    position,
  ]);
  if (value === null || typeof value !== "object" || isProxy(value)) {
    fail(failureCode);
  }
  const bytesRead = ownDataValue(value, "bytesRead", failureCode);
  if (
    !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [bytesRead])
    || (bytesRead as number) < 0
  ) {
    fail(failureCode);
  }
  return bytesRead as number;
}

async function capturedHandleClose(
  handle: fs.promises.FileHandle,
  failureCode: "artifact_file_unsafe" | "output_file_unsafe",
): Promise<void> {
  exactFileHandle(handle, failureCode);
  const close = REFLECT_APPLY(WEAK_MAP_GET, FILE_HANDLE_CLOSES, [handle]);
  if (typeof close !== "function") fail(failureCode);
  await REFLECT_APPLY(close, handle, []);
}

async function capturedHandleChmod(
  handle: fs.promises.FileHandle,
  mode: number,
): Promise<void> {
  exactFileHandle(handle, "output_file_unsafe");
  await REFLECT_APPLY(FILE_HANDLE_CHMOD, handle, [mode]);
}

async function capturedHandleSync(
  handle: fs.promises.FileHandle,
  failureCode: "artifact_file_unsafe" | "output_file_unsafe",
): Promise<void> {
  exactFileHandle(handle, failureCode);
  await REFLECT_APPLY(FILE_HANDLE_SYNC, handle, []);
}

async function capturedHandleTruncate(
  handle: fs.promises.FileHandle,
  length: number,
): Promise<void> {
  exactFileHandle(handle, "output_file_unsafe");
  await REFLECT_APPLY(FILE_HANDLE_TRUNCATE, handle, [length]);
}

async function capturedHandleWriteFile(
  handle: fs.promises.FileHandle,
  bytes: Buffer,
): Promise<void> {
  exactFileHandle(handle, "output_file_unsafe");
  await REFLECT_APPLY(FILE_HANDLE_WRITE_FILE, handle, [bytes]);
}

function wipeBytes(bytes: Uint8Array | null | undefined): void {
  if (bytes) REFLECT_APPLY(TYPED_ARRAY_FILL, bytes, [0]);
}

function exactBytesEqual(left: Buffer, right: Uint8Array): boolean {
  return REFLECT_APPLY(BUFFER_EQUALS, left, [right]) as boolean;
}

function exactBufferLength(
  value: Buffer,
  failureCode: PostgresReviewedPricePromotionCliFailureCode,
): number {
  if (
    typeof TYPED_ARRAY_LENGTH_GETTER !== "function"
    || !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_CONSTRUCTOR, [value])
    || isProxy(value)
  ) fail(failureCode);
  const length = REFLECT_APPLY(TYPED_ARRAY_LENGTH_GETTER, value, []);
  if (
    !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [length])
    || length < 0
  ) {
    fail(failureCode);
  }
  return length as number;
}

function regexMatches(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function errnoIs(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function assertRequiredFilesystemAuthority(): void {
  if (
    !REFLECT_APPLY(NUMBER_IS_INTEGER, NUMBER_OBJECT, [O_NOFOLLOW])
    || O_NOFOLLOW <= 0
    || !REFLECT_APPLY(NUMBER_IS_INTEGER, NUMBER_OBJECT, [O_DIRECTORY])
    || O_DIRECTORY <= 0
    || typeof PROCESS_GETEUID !== "function"
  ) fail("artifact_file_unsafe");
}

function effectiveUid(): bigint {
  if (typeof PROCESS_GETEUID !== "function") fail("artifact_file_unsafe");
  const value = REFLECT_APPLY(PROCESS_GETEUID, PROCESS_OBJECT, []);
  if (
    !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [value])
    || value < 0
  ) fail("artifact_file_unsafe");
  return REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [value]) as bigint;
}

function exactAbsolutePath(value: string): string {
  if (
    typeof value !== "string"
    || !REFLECT_APPLY(PATH_IS_ABSOLUTE, PATH_OBJECT, [value])
    || REFLECT_APPLY(PATH_NORMALIZE, PATH_OBJECT, [value]) !== value
    || REFLECT_APPLY(PATH_RESOLVE, PATH_OBJECT, [value]) !== value
    || REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [value]) === value
    || REFLECT_APPLY(STRING_INCLUDES, value, ["\0"]) === true
    || regexMatches(CONTROL_CHARACTER_PATTERN, value)
    || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_CONSTRUCTOR, [value, "utf8"])
      > MAX_PATH_BYTES
  ) fail("argument_invalid");
  return value;
}

function exactSha256(value: string): string {
  if (!regexMatches(SHA256_PATTERN, value)) fail("argument_invalid");
  return value;
}

function exactCandidateSha(value: string): string {
  if (!regexMatches(CANDIDATE_PATTERN, value)) fail("argument_invalid");
  return value;
}

function exactDistinctPaths(values: readonly string[]): boolean {
  const length = exactArrayLength(values, "argument_invalid");
  for (let left = 0; left < length; left += 1) {
    const leftValue = exactArrayItem(values, left, "argument_invalid");
    if (typeof leftValue !== "string") fail("argument_invalid");
    for (let right = left + 1; right < length; right += 1) {
      if (leftValue === exactArrayItem(values, right, "argument_invalid")) {
        return false;
      }
    }
  }
  return true;
}

function allPathsHaveParent(
  values: readonly string[],
  expectedParent: string,
): boolean {
  const length = exactArrayLength(values, "argument_invalid");
  for (let index = 0; index < length; index += 1) {
    const filename = exactArrayItem(values, index, "argument_invalid");
    if (
      typeof filename !== "string"
      || REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [filename]) !== expectedParent
    ) return false;
  }
  return true;
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
    (stat.mode & S_IFMT) !== S_IFREG
    || stat.uid !== uid
    || stat.nlink !== 1n
    || (stat.mode & 0o7777n) !== 0o600n
    || stat.size < 1n
    || stat.size > REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [maximumBytes])
    || expectedBytes !== undefined && stat.size !== REFLECT_APPLY(
      BIGINT_CONSTRUCTOR,
      undefined,
      [expectedBytes],
    )
  ) fail("artifact_file_unsafe");
}

function assertPrivateOutputFile(
  stat: fs.BigIntStats,
  uid: bigint,
  expectedBytes: number,
): void {
  if (
    (stat.mode & S_IFMT) !== S_IFREG
    || stat.uid !== uid
    || stat.nlink !== 1n
    || (stat.mode & 0o7777n) !== 0o600n
    || stat.size !== REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [expectedBytes])
  ) fail("output_file_unsafe");
}

function assertPrivateOutputParent(stat: fs.BigIntStats, uid: bigint): void {
  if (
    (stat.mode & S_IFMT) !== S_IFDIR
    || stat.uid !== uid
    || stat.nlink < 1n
    || (stat.mode & 0o7777n) !== 0o700n
  ) fail("output_file_unsafe");
}

function assertPrivateInputParent(stat: fs.BigIntStats, uid: bigint): void {
  if (
    (stat.mode & S_IFMT) !== S_IFDIR
    || stat.uid !== uid
    || stat.nlink < 1n
    || (stat.mode & 0o7777n) !== 0o700n
  ) fail("artifact_file_unsafe");
}

async function assertParentAuthorityExact(
  authority: PrivateParentAuthority,
): Promise<void> {
  const descriptor = await capturedHandleStat(
    authority.handle,
    "artifact_file_unsafe",
  );
  const atPath = await capturedLstat(authority.path, "artifact_file_unsafe");
  const real = await capturedRealpath(authority.path, "artifact_file_unsafe");
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
    const real = await capturedRealpath(parent, "artifact_file_unsafe");
    const atPath = await capturedLstat(parent, "artifact_file_unsafe");
    if (real !== parent) fail("artifact_file_unsafe");
    assertPrivateInputParent(atPath, uid);
    const identity = directoryIdentity(atPath);
    handle = await capturedOpen(
      parent,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
      undefined,
      "artifact_file_unsafe",
    );
    const opened = await capturedHandleStat(handle, "artifact_file_unsafe");
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
          await capturedHandleClose(heldParentHandle, "artifact_file_unsafe");
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
        await capturedHandleClose(handle, "artifact_file_unsafe");
      } catch {
        return fail("artifact_file_unsafe");
      }
    }
    if (isSafeCliError(error)) throw error;
    return fail("artifact_file_unsafe");
  }
}

async function readExactDescriptor(
  handle: fs.promises.FileHandle,
  size: number,
  failureCode: "artifact_file_unsafe" | "output_file_unsafe" =
    "artifact_file_unsafe",
): Promise<Buffer> {
  const bytes = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_CONSTRUCTOR, [size]) as Buffer;
  let offset = 0;
  while (offset < size) {
    const bytesRead = await capturedHandleRead(
      handle,
      bytes,
      offset,
      size - offset,
      offset,
      failureCode,
    );
    if (bytesRead === 0) fail(failureCode);
    offset += bytesRead;
  }
  const overflow = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_CONSTRUCTOR, [1]) as Buffer;
  try {
    const bytesRead = await capturedHandleRead(
      handle,
      overflow,
      0,
      1,
      size,
      failureCode,
    );
    if (bytesRead !== 0) fail(failureCode);
  } finally {
    wipeBytes(overflow);
  }
  return bytes;
}

function heldPrivateFileState(held: HeldPrivateFile): HeldPrivateFileState {
  const state = REFLECT_APPLY(
    WEAK_MAP_GET,
    HELD_PRIVATE_FILE_STATES,
    [held],
  ) as HeldPrivateFileState | undefined;
  if (!state) fail("artifact_file_unsafe");
  return state;
}

async function withFreshVerifiedHeldBytes<Value>(
  held: HeldPrivateFile,
  expectedSha256: string | null,
  use: (bytes: Buffer) => Value | Promise<Value>,
): Promise<Value> {
  const state = heldPrivateFileState(held);
  if (state.closed) fail("artifact_file_unsafe");
  if (
    expectedSha256 !== null
    && state.sha256 !== exactSha256(expectedSha256)
  ) fail("artifact_hash_mismatch");
  await state.authority.assertExact();
  const descriptor = await capturedHandleStat(
    state.handle,
    "artifact_file_unsafe",
  );
  const atPath = await capturedLstat(state.filename, "artifact_file_unsafe");
  const real = await capturedRealpath(state.filename, "artifact_file_unsafe");
  assertPrivateFile(descriptor, state.uid, state.maximumBytes, state.size);
  assertPrivateFile(atPath, state.uid, state.maximumBytes, state.size);
  if (
    real !== state.filename
    || !sameFileIdentity(state.identity, fileIdentity(descriptor))
    || !sameFileIdentity(state.identity, fileIdentity(atPath))
  ) fail("artifact_file_unsafe");
  const actual = await readExactDescriptor(state.handle, state.size);
  try {
    if (sha256PostgresMigrationBytes(actual) !== state.sha256) {
      fail("artifact_file_unsafe");
    }
    return await use(actual);
  } finally {
    wipeBytes(actual);
  }
}

async function openHeldPrivateFile(
  authority: PrivateParentAuthority,
  filenameInput: string,
  maximumBytes: number,
): Promise<HeldPrivateFile> {
  assertRequiredFilesystemAuthority();
  const filename = exactAbsolutePath(filenameInput);
  if (REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [filename]) !== authority.path) {
    fail("artifact_file_unsafe");
  }
  const uid = authority.uid;
  let handle: fs.promises.FileHandle | null = null;
  let bytes: Buffer | null = null;
  try {
    await authority.assertExact();
    const real = await capturedRealpath(filename, "artifact_file_unsafe");
    const pathBefore = await capturedLstat(filename, "artifact_file_unsafe");
    if (real !== filename) fail("artifact_file_unsafe");
    assertPrivateFile(pathBefore, uid, maximumBytes);
    handle = await capturedOpen(
      filename,
      O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
      undefined,
      "artifact_file_unsafe",
    );
    const before = await capturedHandleStat(handle, "artifact_file_unsafe");
    assertPrivateFile(before, uid, maximumBytes);
    const beforeIdentity = fileIdentity(before);
    const pathOpened = await capturedLstat(filename, "artifact_file_unsafe");
    assertPrivateFile(pathOpened, uid, maximumBytes);
    if (!sameFileIdentity(beforeIdentity, fileIdentity(pathOpened))) {
      fail("artifact_file_unsafe");
    }
    const size = REFLECT_APPLY(NUMBER_OBJECT, undefined, [before.size]);
    if (
      !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [size])
      || size < 1
      || size > maximumBytes
    ) fail("artifact_file_unsafe");
    bytes = await readExactDescriptor(handle, size);
    const after = await capturedHandleStat(handle, "artifact_file_unsafe");
    const pathAfter = await capturedLstat(filename, "artifact_file_unsafe");
    const realAfter = await capturedRealpath(filename, "artifact_file_unsafe");
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
    const heldHandle = handle;
    const state: HeldPrivateFileState = {
      authority,
      closed: false,
      filename,
      handle: heldHandle,
      identity,
      maximumBytes,
      sha256,
      size,
      uid,
    };
    let held: HeldPrivateFile;
    held = OBJECT_FREEZE({
      path: filename,
      sha256,
      assertExact: async () => {
        await withFreshVerifiedHeldBytes(held, null, () => undefined);
      },
      close: async () => {
        if (state.closed) fail("artifact_file_unsafe");
        let failed = false;
        try {
          await withFreshVerifiedHeldBytes(held, null, () => undefined);
        } catch {
          failed = true;
        }
        state.closed = true;
        try {
          await capturedHandleClose(heldHandle, "artifact_file_unsafe");
        } catch {
          failed = true;
        }
        if (failed) fail("artifact_file_unsafe");
      },
    });
    REFLECT_APPLY(WEAK_MAP_SET, HELD_PRIVATE_FILE_STATES, [held, state]);
    handle = null;
    wipeBytes(bytes);
    bytes = null;
    return held;
  } catch (error) {
    wipeBytes(bytes);
    if (handle) {
      try {
        await capturedHandleClose(handle, "artifact_file_unsafe");
      } catch {
        return fail("artifact_file_unsafe");
      }
    }
    if (isSafeCliError(error)) throw error;
    return fail("artifact_file_unsafe");
  }
}

function decodeExactUtf8(bytes: Buffer): string {
  let roundTrip: Buffer | null = null;
  try {
    const value = REFLECT_APPLY(TEXT_DECODER_DECODE, UTF8_FATAL_DECODER, [
      bytes,
    ]);
    if (typeof value !== "string") fail("artifact_invalid");
    roundTrip = REFLECT_APPLY(
      BUFFER_FROM,
      BUFFER_CONSTRUCTOR,
      [value, "utf8"],
    ) as Buffer;
    if (!exactBytesEqual(roundTrip, bytes)) fail("artifact_invalid");
    return value;
  } catch (error) {
    if (isSafeCliError(error)) throw error;
    return fail("artifact_invalid");
  } finally {
    wipeBytes(roundTrip);
  }
}

async function readCanonicalJsonArtifact<Value>(input: {
  readonly held: HeldPrivateFile;
  readonly expectedSha256: string;
  readonly parse: (value: unknown) => { readonly success: boolean; readonly data?: Value };
}): Promise<PrivateArtifact<Value>> {
  return withFreshVerifiedHeldBytes(
    input.held,
    input.expectedSha256,
    (bytes) => {
      let raw: unknown;
      try {
        raw = REFLECT_APPLY(
          JSON_PARSE,
          JSON_OBJECT,
          [decodeExactUtf8(bytes)],
        ) as unknown;
      } catch (error) {
        if (isSafeCliError(error)) throw error;
        return fail("artifact_invalid");
      }
      const parsed = input.parse(raw);
      if (!parsed.success || parsed.data === undefined) fail("artifact_invalid");
      const canonical = canonicalPostgresReviewedPricePromotionJson(parsed.data);
      try {
        if (!exactBytesEqual(canonical, bytes)) fail("artifact_invalid");
      } finally {
        wipeBytes(canonical);
      }
      return {
        sha256: input.held.sha256,
        value: parsed.data,
      };
    },
  );
}

interface PlannerUrlAuthority {
  readonly password: string;
  readonly rootCaFile: string;
}

function directVerifyFullPlannerUrl(bytes: Buffer): PlannerUrlAuthority {
  const line = decodeExactUtf8(bytes);
  if (
    REFLECT_APPLY(STRING_ENDS_WITH, line, ["\n"]) !== true
    || REFLECT_APPLY(STRING_INDEX_OF, line, ["\n"]) !== line.length - 1
    || regexMatches(CONTROL_CHARACTER_PATTERN, REFLECT_APPLY(
      STRING_SLICE,
      line,
      [0, -1],
    ) as string)
  ) fail("planner_url_unsafe");
  const value = REFLECT_APPLY(STRING_SLICE, line, [0, -1]) as string;
  if (
    !value
    || REFLECT_APPLY(STRING_TRIM, value, []) !== value
  ) fail("planner_url_unsafe");
  let parsed: URL;
  try {
    parsed = REFLECT_APPLY(
      REFLECT_CONSTRUCT,
      REFLECT_OBJECT,
      [URL_CONSTRUCTOR, [value]],
    ) as URL;
    if (
      isProxy(parsed)
      || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [parsed])
        !== URL_PROTOTYPE
    ) fail("planner_url_unsafe");
  } catch {
    return fail("planner_url_unsafe");
  }
  if (
    typeof URL_HASH_GETTER !== "function"
    || typeof URL_HOSTNAME_GETTER !== "function"
    || typeof URL_PASSWORD_GETTER !== "function"
    || typeof URL_PATHNAME_GETTER !== "function"
    || typeof URL_PORT_GETTER !== "function"
    || typeof URL_PROTOCOL_GETTER !== "function"
    || typeof URL_SEARCH_GETTER !== "function"
    || typeof URL_SEARCH_PARAMS_GETTER !== "function"
    || typeof URL_USERNAME_GETTER !== "function"
  ) fail("planner_url_unsafe");
  const encodedUsername = REFLECT_APPLY(URL_USERNAME_GETTER, parsed, []) as unknown;
  const encodedPassword = REFLECT_APPLY(URL_PASSWORD_GETTER, parsed, []) as unknown;
  const pathname = REFLECT_APPLY(URL_PATHNAME_GETTER, parsed, []) as unknown;
  const searchParams = REFLECT_APPLY(URL_SEARCH_PARAMS_GETTER, parsed, []) as unknown;
  if (
    typeof encodedUsername !== "string"
    || typeof encodedPassword !== "string"
    || typeof pathname !== "string"
    || searchParams === null
    || typeof searchParams !== "object"
    || isProxy(searchParams)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [searchParams])
      !== URL_SEARCH_PARAMS_PROTOTYPE
  ) fail("planner_url_unsafe");
  let username: string;
  let databaseName: string;
  let password: string;
  try {
    username = REFLECT_APPLY(DECODE_URI_COMPONENT, undefined, [
      encodedUsername,
    ]) as string;
    password = REFLECT_APPLY(DECODE_URI_COMPONENT, undefined, [
      encodedPassword,
    ]) as string;
    databaseName = REFLECT_APPLY(DECODE_URI_COMPONENT, undefined, [
      REFLECT_APPLY(STRING_SLICE, pathname, [1]),
    ]) as string;
  } catch {
    return fail("planner_url_unsafe");
  }
  const rootCaEntries = REFLECT_APPLY(
    URL_SEARCH_PARAMS_GET_ALL,
    searchParams,
    ["sslrootcert"],
  ) as unknown;
  const sslModeEntries = REFLECT_APPLY(
    URL_SEARCH_PARAMS_GET_ALL,
    searchParams,
    ["sslmode"],
  ) as unknown;
  if (
    !ARRAY_IS_ARRAY(rootCaEntries)
    || exactArrayLength(rootCaEntries, "argument_invalid") !== 1
    || !ARRAY_IS_ARRAY(sslModeEntries)
    || exactArrayLength(sslModeEntries, "argument_invalid") !== 1
  ) fail("planner_url_unsafe");
  const rootCaFile = exactArrayItem(
    rootCaEntries,
    0,
    "argument_invalid",
  );
  const sslMode = exactArrayItem(sslModeEntries, 0, "argument_invalid");
  if (typeof rootCaFile !== "string" || typeof sslMode !== "string") {
    fail("planner_url_unsafe");
  }
  const expectedParameters = REFLECT_APPLY(
    REFLECT_CONSTRUCT,
    REFLECT_OBJECT,
    [URL_SEARCH_PARAMS_CONSTRUCTOR, []],
  ) as URLSearchParams;
  if (
    isProxy(expectedParameters)
    || REFLECT_APPLY(
      OBJECT_GET_PROTOTYPE_OF,
      OBJECT_CONSTRUCTOR,
      [expectedParameters],
    ) !== URL_SEARCH_PARAMS_PROTOTYPE
  ) fail("planner_url_unsafe");
  REFLECT_APPLY(URL_SEARCH_PARAMS_APPEND, expectedParameters, [
    "sslmode",
    "verify-full",
  ]);
  REFLECT_APPLY(URL_SEARCH_PARAMS_APPEND, expectedParameters, [
    "sslrootcert",
    rootCaFile,
  ]);
  const expectedSearch = REFLECT_APPLY(
    URL_SEARCH_PARAMS_TO_STRING,
    expectedParameters,
    [],
  ) as unknown;
  const protocol = REFLECT_APPLY(URL_PROTOCOL_GETTER, parsed, []) as unknown;
  const hostname = REFLECT_APPLY(URL_HOSTNAME_GETTER, parsed, []) as unknown;
  const port = REFLECT_APPLY(URL_PORT_GETTER, parsed, []) as unknown;
  const hash = REFLECT_APPLY(URL_HASH_GETTER, parsed, []) as unknown;
  const search = REFLECT_APPLY(URL_SEARCH_GETTER, parsed, []) as unknown;
  const serialized = REFLECT_APPLY(URL_TO_STRING, parsed, []) as unknown;
  const exactSslMode = REFLECT_APPLY(URL_SEARCH_PARAMS_GET, searchParams, [
    "sslmode",
  ]) as unknown;
  if (
    protocol !== "postgresql:"
    || serialized !== value
    || username !== PLANNER_ROLE
    || !password
    || regexMatches(CONTROL_CHARACTER_PATTERN, password)
    || hostname !== PERMANENT_STAGING_HOST
    || port !== PERMANENT_STAGING_PORT
    || databaseName !== PERMANENT_STAGING_DATABASE
    || pathname !== `/${PERMANENT_STAGING_DATABASE}`
    || hash !== ""
    || exactSslMode !== "verify-full"
    || sslMode !== "verify-full"
    || !rootCaFile
    || typeof search !== "string"
    || typeof expectedSearch !== "string"
    || REFLECT_APPLY(STRING_SLICE, search, [1]) !== expectedSearch
  ) fail("planner_url_unsafe");
  return OBJECT_FREEZE({
    password,
    rootCaFile: exactAbsolutePath(rootCaFile),
  });
}

function singlePemCertificate(value: string): boolean {
  if (
    !value
    || REFLECT_APPLY(STRING_INCLUDES, value, ["\0"]) === true
  ) return false;
  const begin = "-----BEGIN CERTIFICATE-----";
  const end = "-----END CERTIFICATE-----";
  const firstBegin = REFLECT_APPLY(STRING_INDEX_OF, value, [begin]) as number;
  const firstEnd = REFLECT_APPLY(
    STRING_INDEX_OF,
    value,
    [end, firstBegin + begin.length],
  ) as number;
  if (
    firstBegin < 0
    || firstEnd < 0
    || REFLECT_APPLY(
      STRING_INDEX_OF,
      value,
      [begin, firstBegin + begin.length],
    ) !== -1
    || REFLECT_APPLY(
      STRING_INDEX_OF,
      value,
      [end, firstEnd + end.length],
    ) !== -1
    || REFLECT_APPLY(
      STRING_TRIM,
      REFLECT_APPLY(STRING_SLICE, value, [0, firstBegin]),
      [],
    ) !== ""
    || REFLECT_APPLY(
      STRING_TRIM,
      REFLECT_APPLY(STRING_SLICE, value, [firstEnd + end.length]),
      [],
    ) !== ""
  ) return false;
  const rawBody = REFLECT_APPLY(
    STRING_SLICE,
    value,
    [firstBegin + begin.length, firstEnd],
  ) as string;
  let body = "";
  for (let index = 0; index < rawBody.length; index += 1) {
    const character = REFLECT_APPLY(STRING_CHAR_AT, rawBody, [index]) as string;
    if (
      character === " "
      || character === "\t"
      || character === "\r"
      || character === "\n"
      || character === "\v"
      || character === "\f"
    ) continue;
    body += character;
  }
  return body.length > 0 && regexMatches(PEM_BODY_PATTERN, body);
}

async function validateHeldRootCa(
  held: HeldPrivateFile,
  expectedDerSha256Input: string,
): Promise<void> {
  const expectedDerSha256 = exactSha256(expectedDerSha256Input);
  await withFreshVerifiedHeldBytes(held, null, (bytes) => {
    let certificate: crypto.X509Certificate;
    try {
      const pem = decodeExactUtf8(bytes);
      if (!singlePemCertificate(pem)) fail("root_ca_invalid");
      certificate = REFLECT_APPLY(
        REFLECT_CONSTRUCT,
        REFLECT_OBJECT,
        [CRYPTO_X509_CERTIFICATE, [pem]],
      ) as crypto.X509Certificate;
      if (
        isProxy(certificate)
        || REFLECT_APPLY(
          OBJECT_GET_PROTOTYPE_OF,
          OBJECT_CONSTRUCTOR,
          [certificate],
        ) !== X509_CERTIFICATE_PROTOTYPE
      ) fail("root_ca_invalid");
    } catch (error) {
      if (isSafeCliError(error)) throw error;
      return fail("root_ca_invalid");
    }
    if (
      typeof X509_CA_GETTER !== "function"
      || typeof X509_ISSUER_GETTER !== "function"
      || typeof X509_PUBLIC_KEY_GETTER !== "function"
      || typeof X509_RAW_GETTER !== "function"
      || typeof X509_SUBJECT_GETTER !== "function"
      || typeof X509_VALID_FROM_GETTER !== "function"
      || typeof X509_VALID_TO_GETTER !== "function"
    ) fail("root_ca_invalid");
    const raw = REFLECT_APPLY(X509_RAW_GETTER, certificate, []) as unknown;
    if (
      !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_CONSTRUCTOR, [raw])
      || isProxy(raw as object)
    ) fail("root_ca_invalid");
    const actualDerSha256 = sha256PostgresMigrationBytes(raw as Buffer);
    if (actualDerSha256 !== expectedDerSha256) fail("root_ca_pin_mismatch");
    const now = REFLECT_APPLY(DATE_NOW, DATE_OBJECT, []) as number;
    const validFromText = REFLECT_APPLY(
      X509_VALID_FROM_GETTER,
      certificate,
      [],
    );
    const validToText = REFLECT_APPLY(X509_VALID_TO_GETTER, certificate, []);
    if (typeof validFromText !== "string" || typeof validToText !== "string") {
      fail("root_ca_invalid");
    }
    const validFrom = REFLECT_APPLY(DATE_PARSE, DATE_OBJECT, [validFromText]) as number;
    const validTo = REFLECT_APPLY(DATE_PARSE, DATE_OBJECT, [validToText]) as number;
    let selfSigned = false;
    try {
      const subject = REFLECT_APPLY(X509_SUBJECT_GETTER, certificate, []);
      const issuer = REFLECT_APPLY(X509_ISSUER_GETTER, certificate, []);
      const publicKey = REFLECT_APPLY(X509_PUBLIC_KEY_GETTER, certificate, []);
      selfSigned = typeof subject === "string"
        && subject === issuer
        && REFLECT_APPLY(X509_CHECK_ISSUED, certificate, [certificate]) === true
        && REFLECT_APPLY(X509_VERIFY, certificate, [publicKey]) === true;
    } catch {
      selfSigned = false;
    }
    if (
      REFLECT_APPLY(X509_CA_GETTER, certificate, []) !== true
      || !selfSigned
      || !REFLECT_APPLY(NUMBER_IS_FINITE, NUMBER_OBJECT, [now])
      || !REFLECT_APPLY(NUMBER_IS_FINITE, NUMBER_OBJECT, [validFrom])
      || !REFLECT_APPLY(NUMBER_IS_FINITE, NUMBER_OBJECT, [validTo])
      || now < validFrom
      || now >= validTo
      || validTo - now < MINIMUM_CA_REMAINING_VALIDITY_MS
    ) fail("root_ca_invalid");
  });
}

function forbiddenAmbientAuthorityName(name: string): boolean {
  const canonical = REFLECT_APPLY(STRING_TO_UPPER_CASE, name, []) as string;
  return canonical === "DATABASE_URL"
    || canonical === "DIRECT_URL"
    || canonical === "NODE_PG_FORCE_NATIVE"
    || REFLECT_APPLY(STRING_STARTS_WITH, canonical, ["PG"]) === true
    || REFLECT_APPLY(STRING_INCLUDES, canonical, ["SUPABASE"]) === true
    || REFLECT_APPLY(STRING_STARTS_WITH, canonical, ["PINTPATH_RUNTIME_"])
      === true
    || regexMatches(FORBIDDEN_DATABASE_URL_PATTERN, canonical);
}

function assertNoForbiddenAmbientAuthority(
  environment: Readonly<NodeJS.ProcessEnv>,
): void {
  if (
    environment === null
    || typeof environment !== "object"
    || isProxy(environment)
  ) fail("argument_invalid");
  const keys = REFLECT_APPLY(
    REFLECT_OWN_KEYS,
    REFLECT_OBJECT,
    [environment],
  ) as unknown;
  if (!ARRAY_IS_ARRAY(keys)) fail("argument_invalid");
  const length = exactArrayLength(keys, "argument_invalid");
  for (let index = 0; index < length; index += 1) {
    const name = exactArrayItem(keys, index, "argument_invalid");
    if (typeof name !== "string") fail("argument_invalid");
    const value = ownDataValue(environment, name, "argument_invalid");
    if (
      typeof value === "string"
      && value.length > 0
      && forbiddenAmbientAuthorityName(name)
    ) fail("argument_invalid");
  }
}

async function assertHeldAuthorityExact(input: {
  readonly authority: PrivateParentAuthority;
  readonly files: readonly (HeldPrivateFile | null)[];
  readonly rootCa: HeldPrivateFile;
  readonly expectedRootCaDerSha256: string;
}): Promise<void> {
  await input.authority.assertExact();
  for (let index = 0; index < HELD_FILE_COUNT; index += 1) {
    const file = exactHeldFileSlot(input.files, index, false);
    if (!file) fail("artifact_file_unsafe");
    await file.assertExact();
  }
  await validateHeldRootCa(input.rootCa, input.expectedRootCaDerSha256);
  await input.authority.assertExact();
}

async function closeHeldAuthority(input: {
  readonly authority: PrivateParentAuthority | null;
  readonly files: readonly (HeldPrivateFile | null)[];
}): Promise<boolean> {
  let exact = true;
  for (let index = HELD_FILE_COUNT - 1; index >= 0; index -= 1) {
    const file = exactHeldFileSlot(input.files, index, true);
    if (!file) continue;
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

function exactHeldFileSlot(
  files: readonly (HeldPrivateFile | null)[],
  index: number,
  allowNull: boolean,
): HeldPrivateFile | null {
  if (exactArrayLength(files, "artifact_file_unsafe") !== HELD_FILE_COUNT) {
    fail("artifact_file_unsafe");
  }
  const value = exactArrayItem(files, index, "artifact_file_unsafe");
  if (value === null && allowNull) return null;
  if (
    value === null
    || typeof value !== "object"
    || isProxy(value)
  ) fail("artifact_file_unsafe");
  heldPrivateFileState(value as HeldPrivateFile);
  return value as HeldPrivateFile;
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await capturedLstat(filename, "output_file_unsafe");
    return true;
  } catch (error) {
    if (errnoIs(error, "ENOENT")) return false;
    return fail("output_file_unsafe");
  }
}

async function removeTemporaryOutput(filename: string): Promise<void> {
  try {
    await capturedUnlink(filename);
  } catch (error) {
    if (!errnoIs(error, "ENOENT")) fail("output_file_unsafe");
  }
}

interface PublishedPrivatePlan {
  readonly sha256: string;
  readonly identity: StableFileIdentity;
  prepareForSummary(): Promise<void>;
  release(): Promise<void>;
  rollback(): Promise<void>;
}

function freshTemporarySuffix(): string {
  let random: Buffer | null = null;
  try {
    random = REFLECT_APPLY(
      CRYPTO_RANDOM_BYTES,
      CRYPTO_OBJECT,
      [16],
    ) as Buffer;
    if (
      typeof TYPED_ARRAY_LENGTH_GETTER !== "function"
      || !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_CONSTRUCTOR, [random])
      || isProxy(random)
      || REFLECT_APPLY(TYPED_ARRAY_LENGTH_GETTER, random, []) !== 16
    ) fail("output_file_unsafe");
    let output = "";
    for (let index = 0; index < 16; index += 1) {
      const byte = random[index];
      if (
        typeof byte !== "number"
        || !REFLECT_APPLY(NUMBER_IS_INTEGER, NUMBER_OBJECT, [byte])
        || byte < 0
        || byte > 255
      ) {
        fail("output_file_unsafe");
      }
      output += REFLECT_APPLY(STRING_CHAR_AT, LOWERCASE_HEX, [byte >>> 4]);
      output += REFLECT_APPLY(STRING_CHAR_AT, LOWERCASE_HEX, [byte & 15]);
    }
    if (!regexMatches(/^[a-f0-9]{32}$/, output)) fail("output_file_unsafe");
    return output;
  } finally {
    wipeBytes(random);
  }
}

async function writeNewPrivateCanonicalPlan(
  authority: PrivateParentAuthority,
  filenameInput: string,
  value: PostgresReviewedPricePromotionPlanCandidate,
): Promise<PublishedPrivatePlan> {
  assertRequiredFilesystemAuthority();
  const filename = exactAbsolutePath(filenameInput);
  const bytes = canonicalPostgresReviewedPricePromotionJson(value);
  const byteCount = exactBufferLength(bytes, "plan_result_invalid");
  if (byteCount < 1 || byteCount > MAX_PLAN_BYTES) fail("plan_result_invalid");
  const parent = REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [filename]) as string;
  if (parent !== authority.path) fail("output_file_unsafe");
  const uid = authority.uid;
  const sha256 = sha256PostgresMigrationBytes(bytes);
  let fileHandle: fs.promises.FileHandle | null = null;
  let rollbackFileHandle: fs.promises.FileHandle | null = null;
  let published = false;
  let retained = false;
  let ownedTemporaryPresent = false;
  let publishedIdentity: StableFileIdentity | null = null;
  const temporaryPath = REFLECT_APPLY(PATH_JOIN, PATH_OBJECT, [
    parent,
    `.pintpath-postgres-reviewed-price-plan-${freshTemporarySuffix()}.tmp`,
  ]) as string;
  if (
    exactAbsolutePath(temporaryPath) !== temporaryPath
    || REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [temporaryPath]) !== parent
  ) fail("output_file_unsafe");
  try {
    await authority.assertExact();
    if (await pathExists(filename)) fail("output_file_unsafe");

    fileHandle = await capturedOpen(
      temporaryPath,
      O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW,
      0o600,
      "output_file_unsafe",
    );
    ownedTemporaryPresent = true;
    await capturedHandleWriteFile(fileHandle, bytes);
    await capturedHandleChmod(fileHandle, 0o600);
    await capturedHandleSync(fileHandle, "output_file_unsafe");
    const written = await capturedHandleStat(fileHandle, "output_file_unsafe");
    assertPrivateOutputFile(written, uid, byteCount);
    const readback = await readExactDescriptor(fileHandle, byteCount);
    try {
      if (!exactBytesEqual(readback, bytes)) fail("output_file_unsafe");
    } finally {
      wipeBytes(readback);
    }

    await authority.assertExact();
    const parentBeforePublish = await capturedHandleStat(
      authority.handle,
      "output_file_unsafe",
    );
    const parentPathBeforePublish = await capturedLstat(
      parent,
      "output_file_unsafe",
    );
    const parentRealBeforePublish = await capturedRealpath(
      parent,
      "output_file_unsafe",
    );
    assertPrivateOutputParent(parentBeforePublish, uid);
    assertPrivateOutputParent(parentPathBeforePublish, uid);
    if (
      parentRealBeforePublish !== parent
      || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentBeforePublish))
      || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentPathBeforePublish))
    ) fail("output_file_unsafe");
    if (sha256PostgresMigrationBytes(bytes) !== sha256) {
      fail("output_file_unsafe");
    }

    await capturedLink(temporaryPath, filename);
    published = true;
    await capturedUnlink(temporaryPath);
    ownedTemporaryPresent = false;
    await capturedHandleSync(authority.handle, "output_file_unsafe");

    const descriptorAfter = await capturedHandleStat(
      fileHandle,
      "output_file_unsafe",
    );
    const pathAfter = await capturedLstat(filename, "output_file_unsafe");
    const parentAfter = await capturedHandleStat(
      authority.handle,
      "output_file_unsafe",
    );
    const parentPathAfter = await capturedLstat(parent, "output_file_unsafe");
    const finalReal = await capturedRealpath(filename, "output_file_unsafe");
    assertPrivateOutputFile(descriptorAfter, uid, byteCount);
    assertPrivateOutputFile(pathAfter, uid, byteCount);
    assertPrivateOutputParent(parentAfter, uid);
    assertPrivateOutputParent(parentPathAfter, uid);
    const identity = fileIdentity(descriptorAfter);
    publishedIdentity = identity;
    if (
      finalReal !== filename
      || !sameFileIdentity(identity, fileIdentity(pathAfter))
      || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentAfter))
      || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentPathAfter))
    ) fail("output_file_unsafe");
    const finalReadback = await readExactDescriptor(fileHandle, byteCount);
    try {
      if (
        !exactBytesEqual(finalReadback, bytes)
        || sha256PostgresMigrationBytes(finalReadback) !== sha256
        || sha256PostgresMigrationBytes(bytes) !== sha256
      ) fail("output_file_unsafe");
    } finally {
      wipeBytes(finalReadback);
    }
    await authority.assertExact();

    rollbackFileHandle = await capturedOpen(
      filename,
      O_RDWR | O_NOFOLLOW | O_NONBLOCK,
      undefined,
      "output_file_unsafe",
    );
    const rollbackDescriptor = await capturedHandleStat(
      rollbackFileHandle,
      "output_file_unsafe",
    );
    assertPrivateOutputFile(rollbackDescriptor, uid, byteCount);
    if (!sameFileIdentity(identity, fileIdentity(rollbackDescriptor))) {
      fail("output_file_unsafe");
    }

    const retainedHandle = fileHandle;
    const retainedRollbackHandle = rollbackFileHandle;
    let state: "open" | "prepared" | "failed" | "released" | "rolled-back" =
      "open";
    let retainedHandleClosed = false;
    let retainedRollbackHandleClosed = false;
    let bytesWiped = false;
    const wipePlanBytes = (): void => {
      if (bytesWiped) return;
      wipeBytes(bytes);
      bytesWiped = true;
    };
    const result: PublishedPrivatePlan = {
      sha256,
      identity,
      prepareForSummary: async () => {
        if (state !== "open") fail("output_file_unsafe");
        let exact = true;
        let current: Buffer | null = null;
        try {
          const descriptor = await capturedHandleStat(
            retainedHandle,
            "output_file_unsafe",
          );
          const rollbackDescriptor = await capturedHandleStat(
            retainedRollbackHandle,
            "output_file_unsafe",
          );
          const atPath = await capturedLstat(filename, "output_file_unsafe");
          const real = await capturedRealpath(filename, "output_file_unsafe");
          assertPrivateOutputFile(descriptor, uid, byteCount);
          assertPrivateOutputFile(rollbackDescriptor, uid, byteCount);
          assertPrivateOutputFile(atPath, uid, byteCount);
          if (
            real !== filename
            || !sameFileIdentity(identity, fileIdentity(descriptor))
            || !sameFileIdentity(identity, fileIdentity(rollbackDescriptor))
            || !sameFileIdentity(identity, fileIdentity(atPath))
          ) exact = false;
          current = await readExactDescriptor(
            retainedHandle,
            byteCount,
            "output_file_unsafe",
          );
          if (!exactBytesEqual(current, bytes)) exact = false;
        } catch {
          exact = false;
        } finally {
          wipeBytes(current);
          try {
            await capturedHandleClose(retainedHandle, "output_file_unsafe");
            retainedHandleClosed = true;
          } catch {
            exact = false;
          }
          state = exact ? "prepared" : "failed";
        }
        if (!exact) fail("output_file_unsafe");
      },
      release: async () => {
        if (state !== "prepared") fail("output_file_unsafe");
        let exact = true;
        try {
          const descriptor = await capturedHandleStat(
            retainedRollbackHandle,
            "output_file_unsafe",
          );
          const atPath = await capturedLstat(filename, "output_file_unsafe");
          const real = await capturedRealpath(filename, "output_file_unsafe");
          assertPrivateOutputFile(descriptor, uid, byteCount);
          assertPrivateOutputFile(atPath, uid, byteCount);
          if (
            real !== filename
            || !sameFileIdentity(identity, fileIdentity(descriptor))
            || !sameFileIdentity(identity, fileIdentity(atPath))
          ) exact = false;
        } catch {
          exact = false;
        }
        if (exact) {
          try {
            await capturedHandleClose(
              retainedRollbackHandle,
              "output_file_unsafe",
            );
            retainedRollbackHandleClosed = true;
          } catch {
            exact = false;
          }
        }
        state = exact ? "released" : "failed";
        wipePlanBytes();
        if (!exact) fail("output_file_unsafe");
      },
      rollback: async () => {
        if (state === "rolled-back") return;
        if (state === "released") fail("output_file_unsafe");
        let exact = true;
        let invalidationExact = false;
        const heldRollbackHandle = !retainedRollbackHandleClosed
          ? retainedRollbackHandle
          : !retainedHandleClosed
            ? retainedHandle
            : null;
        try {
          invalidationExact = await invalidateAndRemoveExactPublishedPlan(
            authority,
            filename,
            sha256,
            identity,
            byteCount,
            heldRollbackHandle,
          );
        } catch {
          invalidationExact = false;
        }
        if (!invalidationExact) {
          exact = false;
          try {
            await invalidateAndRemoveExactPublishedPlan(
              authority,
              filename,
              sha256,
              identity,
              byteCount,
              null,
            );
          } catch {
            // The first cleanup failure remains authoritative.
          }
        }
        if (!retainedHandleClosed) {
          try {
            await capturedHandleClose(retainedHandle, "output_file_unsafe");
            retainedHandleClosed = true;
          } catch {
            exact = false;
          }
        }
        if (!retainedRollbackHandleClosed) {
          try {
            await capturedHandleClose(
              retainedRollbackHandle,
              "output_file_unsafe",
            );
            retainedRollbackHandleClosed = true;
          } catch {
            exact = false;
          }
        }
        state = "rolled-back";
        wipePlanBytes();
        if (!exact) fail("output_file_unsafe");
      },
    };
    retained = true;
    fileHandle = null;
    rollbackFileHandle = null;
    return result;
  } catch (error) {
    if (isSafeCliError(error)) throw error;
    return fail("output_file_unsafe");
  } finally {
    let cleanupFailed = false;
    if (published && !retained && fileHandle) {
      try {
        if (!await invalidateAndRemoveExactPublishedPlan(
          authority,
          filename,
          sha256,
          publishedIdentity,
          byteCount,
          fileHandle,
        )) cleanupFailed = true;
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
        await capturedHandleClose(fileHandle, "output_file_unsafe");
      } catch {
        cleanupFailed = true;
      }
    }
    if (rollbackFileHandle) {
      try {
        await capturedHandleClose(rollbackFileHandle, "output_file_unsafe");
      } catch {
        cleanupFailed = true;
      }
    }
    if (!retained) wipeBytes(bytes);
    if (cleanupFailed) fail("output_file_unsafe");
  }
}

async function invalidateAndRemoveExactPublishedPlan(
  authority: PrivateParentAuthority,
  filename: string,
  expectedSha256: string,
  expectedIdentity: StableFileIdentity | null,
  expectedBytes: number,
  heldHandle: fs.promises.FileHandle | null,
): Promise<boolean> {
  let parentHandle: fs.promises.FileHandle | null = null;
  let reopenedFileHandle: fs.promises.FileHandle | null = null;
  let bytes: Buffer | null = null;
  let exact = true;
  let invalidated = false;
  let removed = false;
  let descriptorBefore: fs.BigIntStats | null = null;
  try {
    if (expectedBytes < 1 || expectedBytes > MAX_PLAN_BYTES) return false;

    let targetHandle = heldHandle;
    if (!targetHandle) {
      const parentReal = await capturedRealpath(
        authority.path,
        "output_file_unsafe",
      );
      const parentAtPath = await capturedLstat(
        authority.path,
        "output_file_unsafe",
      );
      if (
        parentReal !== authority.path
        || (parentAtPath.mode & S_IFMT) !== S_IFDIR
        || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentAtPath))
      ) return false;
      assertPrivateOutputParent(parentAtPath, authority.uid);
      const atPath = await capturedLstat(filename, "output_file_unsafe");
      if (!expectedIdentity) return false;
      assertPrivateOutputFile(atPath, authority.uid, expectedBytes);
      if (!sameFileIdentity(expectedIdentity, fileIdentity(atPath))) return false;
      reopenedFileHandle = await capturedOpen(
        filename,
        O_RDWR | O_NOFOLLOW | O_NONBLOCK,
        undefined,
        "output_file_unsafe",
      );
      targetHandle = reopenedFileHandle;
    }

    descriptorBefore = await capturedHandleStat(targetHandle, "output_file_unsafe");
    if ((descriptorBefore.mode & S_IFMT) !== S_IFREG) return false;
    if (heldHandle) {
      if (
        descriptorBefore.uid !== authority.uid
        || descriptorBefore.size !== REFLECT_APPLY(
          BIGINT_CONSTRUCTOR,
          undefined,
          [expectedBytes],
        )
        || (descriptorBefore.mode & 0o7777n) !== 0o600n
        || descriptorBefore.nlink < 1n
        || descriptorBefore.nlink > 2n
        || expectedIdentity !== null && (
          descriptorBefore.dev !== expectedIdentity.dev
          || descriptorBefore.ino !== expectedIdentity.ino
          || !sameFileIdentity(expectedIdentity, fileIdentity(descriptorBefore))
        )
      ) exact = false;
    } else if (
      !expectedIdentity
      || !sameFileIdentity(expectedIdentity, fileIdentity(descriptorBefore))
    ) {
      return false;
    }

    if (descriptorBefore.size === REFLECT_APPLY(
      BIGINT_CONSTRUCTOR,
      undefined,
      [expectedBytes],
    )) {
      try {
        bytes = await readExactDescriptor(
          targetHandle,
          expectedBytes,
          "output_file_unsafe",
        );
        if (sha256PostgresMigrationBytes(bytes) !== expectedSha256) exact = false;
      } catch {
        exact = false;
      }
    } else {
      exact = false;
    }

    await capturedHandleTruncate(targetHandle, 0);
    await capturedHandleSync(targetHandle, "output_file_unsafe");
    invalidated = true;
    const descriptorAfter = await capturedHandleStat(
      targetHandle,
      "output_file_unsafe",
    );
    const pathAfter = await capturedLstat(filename, "output_file_unsafe");
    if (
      (descriptorAfter.mode & S_IFMT) !== S_IFREG
      || descriptorAfter.uid !== authority.uid
      || (descriptorAfter.mode & 0o7777n) !== 0o600n
      || descriptorAfter.size !== 0n
      || (pathAfter.mode & S_IFMT) !== S_IFREG
      || pathAfter.uid !== authority.uid
      || (pathAfter.mode & 0o7777n) !== 0o600n
      || pathAfter.size !== 0n
      || descriptorAfter.dev !== descriptorBefore.dev
      || descriptorAfter.ino !== descriptorBefore.ino
      || descriptorAfter.size !== 0n
    ) return false;
    if (
      descriptorAfter.uid !== authority.uid
      || (descriptorAfter.mode & 0o7777n) !== 0o600n
      || descriptorAfter.nlink !== descriptorBefore.nlink
    ) exact = false;
    if (
      (pathAfter.mode & S_IFMT) !== S_IFREG
      || pathAfter.dev !== descriptorBefore.dev
      || pathAfter.ino !== descriptorBefore.ino
      || pathAfter.size !== 0n
    ) return false;
    if (
      pathAfter.uid !== authority.uid
      || (pathAfter.mode & 0o7777n) !== 0o600n
      || pathAfter.nlink !== descriptorBefore.nlink
    ) exact = false;

    const parentReal = await capturedRealpath(
      authority.path,
      "output_file_unsafe",
    );
    const parentAtPath = await capturedLstat(
      authority.path,
      "output_file_unsafe",
    );
    if (
      parentReal !== authority.path
      || (parentAtPath.mode & S_IFMT) !== S_IFDIR
      || !sameDirectoryIdentity(authority.identity, directoryIdentity(parentAtPath))
    ) return false;
    assertPrivateOutputParent(parentAtPath, authority.uid);
    parentHandle = await capturedOpen(
      authority.path,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
      undefined,
      "output_file_unsafe",
    );
    const parentDescriptor = await capturedHandleStat(
      parentHandle,
      "output_file_unsafe",
    );
    assertPrivateOutputParent(parentDescriptor, authority.uid);
    if (!sameDirectoryIdentity(
      authority.identity,
      directoryIdentity(parentDescriptor),
    )) return false;

    const beforeUnlink = await capturedLstat(filename, "output_file_unsafe");
    if (
      (beforeUnlink.mode & S_IFMT) !== S_IFREG
      || beforeUnlink.size !== 0n
      || beforeUnlink.dev !== descriptorBefore.dev
      || beforeUnlink.ino !== descriptorBefore.ino
    ) return false;
    if (
      beforeUnlink.uid !== authority.uid
      || (beforeUnlink.mode & 0o7777n) !== 0o600n
      || beforeUnlink.nlink !== descriptorBefore.nlink
    ) exact = false;
    await capturedUnlink(filename);
    removed = true;
    await capturedHandleSync(parentHandle, "output_file_unsafe");
    const unlinked = await capturedHandleStat(targetHandle, "output_file_unsafe");
    if (
      unlinked.dev !== descriptorBefore.dev
      || unlinked.ino !== descriptorBefore.ino
      || unlinked.size !== 0n
      || unlinked.nlink !== descriptorBefore.nlink - 1n
      || await pathExists(filename)
    ) exact = false;
  } catch {
    exact = false;
  } finally {
    wipeBytes(bytes);
    if (reopenedFileHandle) {
      try {
        await capturedHandleClose(reopenedFileHandle, "output_file_unsafe");
      } catch {
        exact = false;
      }
    }
    if (parentHandle) {
      try {
        await capturedHandleClose(parentHandle, "output_file_unsafe");
      } catch {
        exact = false;
      }
    }
  }
  return invalidated && removed && exact;
}

function fixedOwnFailureCode(
  error: unknown,
  allowed: ReadonlySet<string>,
): PostgresReviewedPricePromotionCliFailureCode | null {
  try {
    if (typeof error !== "object" || error === null || isProxy(error)) return null;
    const descriptor = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      OBJECT_CONSTRUCTOR,
      [error, "code"],
    ) as PropertyDescriptor | undefined;
    if (
      !descriptor
      || REFLECT_APPLY(OBJECT_HAS_OWN, OBJECT_CONSTRUCTOR, [descriptor, "value"])
        !== true
      || typeof descriptor.value !== "string"
      || REFLECT_APPLY(SET_HAS, allowed, [descriptor.value]) !== true
    ) return null;
    return descriptor.value as PostgresReviewedPricePromotionCliFailureCode;
  } catch {
    return null;
  }
}

function safeFailureCode(error: unknown): PostgresReviewedPricePromotionCliFailureCode {
  try {
    if (isSafeCliError(error)) {
      return fixedOwnFailureCode(error, CLI_FAILURE_CODES) ?? "unexpected_failure";
    }
    return fixedOwnFailureCode(error, PLAN_FAILURE_CODES) ?? "unexpected_failure";
  } catch {
    // Proxies and hostile prototype traps cannot escape the fixed fallback.
  }
  return "unexpected_failure";
}

function writeSummary(
  dependencies: PostgresReviewedPricePromotionCliDependencies,
  value: unknown,
): void {
  const bytes = canonicalPostgresReviewedPricePromotionJson(value);
  try {
    const summary = REFLECT_APPLY(BUFFER_TO_STRING, bytes, ["utf8"]);
    if (typeof summary !== "string") fail("unexpected_failure");
    dependencies.writeOutput(summary);
  } finally {
    wipeBytes(bytes);
  }
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

function activationBlockersExact(value: unknown): boolean {
  if (
    !ARRAY_IS_ARRAY(value)
    || value.length !== POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS.length
  ) return false;
  for (
    let index = 0;
    index < POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS.length;
    index += 1
  ) {
    const key = REFLECT_APPLY(NUMBER_TO_STRING, index, []) as string;
    const descriptor = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      OBJECT_CONSTRUCTOR,
      [value, key],
    ) as PropertyDescriptor | undefined;
    if (
      !descriptor
      || REFLECT_APPLY(OBJECT_HAS_OWN, OBJECT_CONSTRUCTOR, [descriptor, "value"])
        !== true
      || descriptor.value
      !== POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[index]
    ) return false;
  }
  return true;
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
  const expectedDeployment = input.deployment;
  if (
    plan.candidateSha !== input.candidateSha
    || plan.expectedEnvironment !== "permanent-staging"
    || plan.expectedDeployment.attestationFileSha256
      !== expectedDeployment.attestationFileSha256
    || plan.expectedDeployment.attestationPolicySha256
      !== expectedDeployment.attestationPolicySha256
    || plan.expectedDeployment.deploymentIdSha256
      !== expectedDeployment.deploymentIdSha256
    || plan.expectedDeployment.environmentIdSha256
      !== expectedDeployment.environmentIdSha256
    || plan.expectedDeployment.imageDigestSha256
      !== expectedDeployment.imageDigestSha256
    || plan.expectedDeployment.projectIdSha256
      !== expectedDeployment.projectIdSha256
    || plan.expectedDeployment.serviceIdSha256
      !== expectedDeployment.serviceIdSha256
    || plan.migration.receiptFileSha256 !== input.migrationReceiptFileSha256
    || plan.privateInput.manifestSha256 !== input.privateInputFileSha256
    || plan.privateInput.itemCount !== input.privateInputItemCount
    || plan.sourceSnapshot.items.length !== input.privateInputItemCount
    || plan.target.physicalIdentitySha256 !== input.physicalIdentitySha256
    || plan.target.plannerLoginIdentitySha256 !== input.plannerLoginIdentitySha256
    || plan.mutationEnabled !== false
    || !activationBlockersExact(plan.activationBlockers)
  ) fail("plan_result_invalid");
  return plan;
}

function deploymentFromAttestation(
  receipt: RailwayApplicationDeploymentAttestationReceipt,
  attestationFileSha256: string,
): BuildPostgresReviewedPricePromotionPlanInput["expectedDeployment"] {
  return OBJECT_FREEZE({
    attestationFileSha256,
    attestationPolicySha256: receipt.hashes.policySha256,
    deploymentIdSha256: receipt.hashes.deploymentIdSha256,
    environmentIdSha256: receipt.hashes.environmentIdSha256,
    imageDigestSha256: receipt.hashes.imageDigestSha256,
    projectIdSha256: receipt.hashes.projectIdSha256,
    serviceIdSha256: receipt.hashes.serviceIdSha256,
  });
}

async function runPostgresReviewedPricePromotionCliWithDependencies(
  argv: readonly string[],
  dependencyInput: PostgresReviewedPricePromotionCliDependencies,
): Promise<0 | 1> {
  try {
    const productionGuard = dependencyInput.assertProductionBoundary;
    if (productionGuard !== undefined) {
      if (typeof productionGuard !== "function") return 1;
      REFLECT_APPLY(productionGuard, undefined, []);
    }
  } catch {
    return 1;
  }
  let dependencies: PostgresReviewedPricePromotionCliDependencies;
  try {
    dependencies = snapshotCliDependencies(dependencyInput);
  } catch {
    return 1;
  }
  let databaseHandle: PostgresReviewedPricePromotionPlannerDatabaseHandle | null = null;
  let parentAuthority: PrivateParentAuthority | null = null;
  const heldFiles: Array<HeldPrivateFile | null> = [
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  let heldFileCount = 0;
  const retainHeldFile = (file: HeldPrivateFile): void => {
    if (
      heldFileCount >= HELD_FILE_COUNT
      || exactHeldFileSlot(heldFiles, heldFileCount, true) !== null
    ) fail("artifact_file_unsafe");
    defineArraySlot(
      heldFiles,
      heldFileCount,
      file,
      "artifact_file_unsafe",
    );
    heldFileCount += 1;
  };
  let rootCaFile: HeldPrivateFile | null = null;
  let retainedDeploymentAttestation:
    RailwayApplicationDeploymentAttestationReceipt | null = null;
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
    const args = parseExactCliArguments(argv);
    if (args.expectedEnvironment !== "permanent-staging") {
      fail("environment_not_allowed");
    }
    assertNoForbiddenAmbientAuthority(dependencies.environment);

    const candidateSha = exactCandidateSha(args.candidateSha);
    const deploymentAttestationPath = exactAbsolutePath(
      args.deploymentAttestation,
    );
    const plannerUrlPath = exactAbsolutePath(args.plannerUrlFile);
    const migrationReceiptPath = exactAbsolutePath(args.migrationReceipt);
    const migrationTargetIdentityPath = exactAbsolutePath(
      args.migrationTargetIdentity,
    );
    const privateInputPath = exactAbsolutePath(args.privateInput);
    outputPlan = exactAbsolutePath(args.outputPlan);
    if (!exactDistinctPaths([
      deploymentAttestationPath,
      plannerUrlPath,
      migrationReceiptPath,
      migrationTargetIdentityPath,
      privateInputPath,
      outputPlan,
    ])) fail("argument_invalid");
    const commonParent = REFLECT_APPLY(
      PATH_DIRNAME,
      PATH_OBJECT,
      [plannerUrlPath],
    ) as string;
    if (!allPathsHaveParent([
      deploymentAttestationPath,
      migrationReceiptPath,
      migrationTargetIdentityPath,
      privateInputPath,
      outputPlan,
    ], commonParent)) {
      fail("artifact_file_unsafe");
    }
    parentAuthority = await openPrivateParentAuthority(commonParent);
    if (await pathExists(outputPlan)) fail("output_file_unsafe");

    const deploymentAttestationFile = await openHeldPrivateFile(
      parentAuthority,
      deploymentAttestationPath,
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RECEIPT_BYTES,
    );
    retainHeldFile(deploymentAttestationFile);
    const deploymentAttestation = await withFreshVerifiedHeldBytes(
      deploymentAttestationFile,
      exactSha256(args.deploymentAttestationSha256),
      (bytes) => parseRailwayApplicationDeploymentAttestationReceipt(bytes),
    );
    if (
      !deploymentAttestation
      || deploymentAttestation.expectedEnvironment !== "permanent-staging"
      || deploymentAttestation.candidateSha !== candidateSha
      || deploymentAttestation.hashes.policySha256
        !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256
      || !railwayApplicationDeploymentAttestationReceiptFreshAt(
        deploymentAttestation,
        dependencies.now(),
      )
    ) fail("artifact_invalid");
    retainedDeploymentAttestation = deploymentAttestation;
    const deployment = deploymentFromAttestation(
      deploymentAttestation,
      deploymentAttestationFile.sha256,
    );

    const plannerUrlFile = await openHeldPrivateFile(
      parentAuthority,
      plannerUrlPath,
      MAX_PLANNER_URL_FILE_BYTES,
    );
    retainHeldFile(plannerUrlFile);
    const plannerUrl = await withFreshVerifiedHeldBytes(
      plannerUrlFile,
      exactSha256(args.plannerUrlSha256),
      directVerifyFullPlannerUrl,
    );
    if (
      REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [plannerUrl.rootCaFile])
        !== commonParent
      || !exactDistinctPaths([
        deploymentAttestationPath,
        plannerUrlPath,
        plannerUrl.rootCaFile,
        migrationReceiptPath,
        migrationTargetIdentityPath,
        privateInputPath,
        outputPlan,
      ])
    ) fail("artifact_file_unsafe");
    rootCaFile = await openHeldPrivateFile(
      parentAuthority,
      plannerUrl.rootCaFile,
      MAX_ROOT_CA_BYTES,
    );
    retainHeldFile(rootCaFile);

    const migrationReceiptFile = await openHeldPrivateFile(
      parentAuthority,
      migrationReceiptPath,
      MAX_MIGRATION_RECEIPT_BYTES,
    );
    retainHeldFile(migrationReceiptFile);
    const migrationReceipt = await readCanonicalJsonArtifact({
      held: migrationReceiptFile,
      expectedSha256: exactSha256(args.migrationReceiptSha256),
      parse: (value) => postgresMigrationReceiptSchema.safeParse(value),
    });
    const migrationTargetIdentityFile = await openHeldPrivateFile(
      parentAuthority,
      migrationTargetIdentityPath,
      MAX_MIGRATION_TARGET_IDENTITY_BYTES,
    );
    retainHeldFile(migrationTargetIdentityFile);
    const migrationTargetIdentity = await readCanonicalJsonArtifact({
      held: migrationTargetIdentityFile,
      expectedSha256: exactSha256(args.migrationTargetIdentitySha256),
      parse: (value) => postgresMigrationTargetIdentitySchema.safeParse(value),
    });
    const privateInputFile = await openHeldPrivateFile(
      parentAuthority,
      privateInputPath,
      MAX_PRIVATE_INPUT_BYTES,
    );
    retainHeldFile(privateInputFile);
    const privateInput = await readCanonicalJsonArtifact({
      held: privateInputFile,
      expectedSha256: exactSha256(args.privateInputSha256),
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
      args.expectedTargetDatabaseIdentitySha256,
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
      databaseHandle = snapshotPlannerDatabaseHandle(
        await dependencies.openDatabase({
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
        }),
      );
    } catch (error) {
      if (isSafeCliError(error)) throw error;
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
      if (
        !retainedDeploymentAttestation
        || !railwayApplicationDeploymentAttestationReceiptFreshAt(
          retainedDeploymentAttestation,
          dependencies.now(),
        )
      ) fail("artifact_invalid");
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
      if (!railwayApplicationDeploymentAttestationReceiptFreshAt(
        retainedDeploymentAttestation,
        dependencies.now(),
      )) fail("artifact_invalid");
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
      await publishedPlan.prepareForSummary();
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
    if (!plan || !planFileSha256 || !summaryInput || !publishedPlan || failureCode) {
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
    await publishedPlan.release();
    publishedPlan = null;
    return 0;
  } catch {
    let finalFailureCode: PostgresReviewedPricePromotionCliFailureCode =
      "unexpected_failure";
    if (publishedPlan) {
      try {
        await publishedPlan.rollback();
      } catch {
        finalFailureCode = "output_file_unsafe";
      }
    }
    try {
      writeSummary(dependencies, {
        command: POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND,
        failureCode: finalFailureCode,
        ok: false,
      });
    } catch {
      // The fixed exit status remains authoritative when stdout is unavailable.
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

const invokedPath = process.argv[1]
  ? REFLECT_APPLY(PATH_RESOLVE, PATH_OBJECT, [process.argv[1]]) as string
  : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresReviewedPricePromotionCli(
    REFLECT_APPLY(ARRAY_SLICE, process.argv, [2]) as string[],
  );
}

export const postgresReviewedPricePromotionCliInternals = Object.freeze({
  ARGUMENT_COUNT,
  MAX_DEPLOYMENT_ATTESTATION_BYTES:
    RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RECEIPT_BYTES,
  MAX_MIGRATION_RECEIPT_BYTES,
  MAX_MIGRATION_TARGET_IDENTITY_BYTES,
  MAX_PLAN_BYTES,
  MAX_PLANNER_URL_FILE_BYTES,
  MAX_PRIVATE_INPUT_BYTES,
});
