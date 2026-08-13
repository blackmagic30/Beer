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
  derivePostgresMigrationRunId,
  postgresMigrationReceiptSchema,
  postgresMigrationTargetIdentitySchema,
  sha256PostgresMigrationRunBinding,
  sha256PostgresMigrationTargetIdentity,
  type PostgresMigrationReceipt,
  type PostgresMigrationTargetIdentity,
} from "../src/db/postgres-migration-receipt.js";
import { POSTGRES_MIGRATION_CONTRACT } from
  "../src/db/postgres-migration-contract.js";
import {
  sha256PostgresMigrationBytes,
  sha256PostgresMigrationContract,
} from
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
  POSTGRES_REVIEWED_PRICE_PROMOTION_MAX_REVIEW_PACKET_BYTES,
  postgresReviewedPricePromotionAuthorityBundleFreshAt,
  postgresReviewedPricePromotionAuthorityBundleSchema,
  postgresReviewedPricePromotionReviewPacketSchema,
  type PostgresReviewedPricePromotionAuthorityBundle,
  type PostgresReviewedPricePromotionReviewPacket,
} from "../src/lib/postgres-reviewed-price-promotion-authority.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
  POSTGRES_REVIEWED_PRICE_PROMOTION_IDENTITY_QUERY,
  POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256,
  canonicalPostgresReviewedPricePromotionJson,
  postgresReviewedPricePromotionPlanCandidateSchema,
  postgresReviewedPricePromotionPrivateInputSchema,
  sha256PostgresReviewedPricePromotionIdentity,
  sha256PostgresReviewedPricePromotionValue,
  type BuildPostgresReviewedPricePromotionPlanInput,
  type PostgresReviewedPricePromotionPlanArtifacts,
  type PostgresReviewedPricePromotionPlanCandidate,
  type PostgresReviewedPricePromotionPlanErrorCode,
  type PostgresReviewedPricePromotionPrivateInput,
} from "../src/lib/postgres-reviewed-price-promotion-plan.js";
import { REVIEWED_PRICE_SELECTION_POLICY_SHA256 } from
  "../src/lib/reviewed-price-selection-policy.js";
import {
  REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES,
  REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
} from "../src/lib/reviewed-price-wrong-price-policy.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  openPostgresRailwayStockLocalhostCaTransport,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import { POSTGRES_REVIEWED_PRICE_PROMOTION_RUNTIME } from
  "./lib/postgres-reviewed-price-promotion-runtime.js";

export const POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND = "plan" as const;

const ARGUMENT_COUNT = 17;
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
const BIGINT_TO_STRING = BigInt.prototype.toString;
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
const OBJECT_PROTOTYPE = Object.prototype;
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
const SET_ADD = Set.prototype.add;
const SET_DELETE = Set.prototype.delete;
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
const PROCESS_KILL = process.kill;
const PROCESS_PID = process.pid;
const PROCESS_ENVIRONMENT = process.env;
const FS_PROMISES_LINK = fs.promises.link;
const FS_PROMISES_LSTAT = fs.promises.lstat;
const FS_PROMISES_OPEN = fs.promises.open;
const FS_PROMISES_REALPATH = fs.promises.realpath;
const FS_PROMISES_RENAME = fs.promises.rename;
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
const MAX_AUTHORITY_BUNDLE_BYTES = 64 * 1_024;
const MAX_PLAN_BYTES = 256 * 1_024;
const MAX_PUBLICATION_JOURNAL_BYTES = 64 * 1_024;
// Every accepted packet string is length-bounded. Budgeting the schema maxima
// at six JSON bytes per UTF-16 code unit (the worst escaped representation),
// plus canonical keys/indentation for 50 * 100 rows, remains below this cap.
const MAX_REVIEW_PACKET_BYTES =
  POSTGRES_REVIEWED_PRICE_PROMOTION_MAX_REVIEW_PACKET_BYTES;
const HELD_FILE_COUNT = 7;
const ACTIVE_PUBLICATION_JOURNALS = new Set<string>();

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
  "authority_mismatch",
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
  readonly assertPublicationBoundary?: (
    boundary: PostgresReviewedPricePromotionPublicationBoundary,
  ) => void;
  readonly releasePublishedArtifactHandle?: (
    artifact: PostgresReviewedPricePromotionPublishedArtifact,
    close: () => Promise<void>,
  ) => Promise<void>;
  readonly openDatabase: (
    options: PostgresReviewedPricePromotionPlannerDatabaseOptions,
  ) => PostgresReviewedPricePromotionPlannerDatabaseHandle
    | Promise<PostgresReviewedPricePromotionPlannerDatabaseHandle>;
  readonly buildPlan: (
    input: BuildPostgresReviewedPricePromotionPlanInput,
  ) => Promise<PostgresReviewedPricePromotionPlanArtifacts>;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly expectedRootCaDerSha256: string;
  readonly now: () => Date;
  readonly writeOutput: (value: string) => void;
}

export type PostgresReviewedPricePromotionPublicationBoundary =
  | "review-packet-published"
  | "plan-published"
  | "plan-finalized"
  | "review-packet-finalized";

export type PostgresReviewedPricePromotionPublishedArtifact =
  | "plan"
  | "review-packet";

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

interface SerializedStableFileIdentity {
  readonly ctimeNs: string;
  readonly dev: string;
  readonly gid: string;
  readonly ino: string;
  readonly mode: string;
  readonly mtimeNs: string;
  readonly nlink: string;
  readonly size: string;
  readonly uid: string;
}

interface PublicationArtifactRecord {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
  readonly temporaryPath: string;
}

interface CommittedPublicationArtifactRecord extends PublicationArtifactRecord {
  readonly identity: SerializedStableFileIdentity;
}

interface PostgresReviewedPricePromotionSuccessSummary {
  readonly activationBlockerCount: number;
  readonly candidateSha: string;
  readonly command: typeof POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND;
  readonly expectedEnvironment: "permanent-staging";
  readonly itemCount: number;
  readonly mutationEnabled: false;
  readonly ok: true;
  readonly planCandidateSha256: string;
  readonly planFileSha256: string;
  readonly physicalIdentitySha256: string;
  readonly plannerLoginIdentitySha256: string;
  readonly reviewPacketCandidateSha256: string;
  readonly reviewPacketFileSha256: string;
  readonly rowCount: number;
}

interface PreparedPublicationJournal {
  readonly artifacts: {
    readonly plan: PublicationArtifactRecord;
    readonly reviewPacket: PublicationArtifactRecord;
  };
  readonly invocationSha256: string;
  readonly kind: "pintpath-postgres-reviewed-price-promotion-publication";
  readonly outputPlan: string;
  readonly outputReviewPacket: string;
  readonly processId: number;
  readonly state: "prepared";
  readonly summary: PostgresReviewedPricePromotionSuccessSummary;
  readonly version: 1;
}

interface CommittedPublicationJournal {
  readonly artifacts: {
    readonly plan: CommittedPublicationArtifactRecord;
    readonly reviewPacket: CommittedPublicationArtifactRecord;
  };
  readonly invocationSha256: string;
  readonly kind: "pintpath-postgres-reviewed-price-promotion-publication";
  readonly outputPlan: string;
  readonly outputReviewPacket: string;
  readonly processId: number;
  readonly state: "committed";
  readonly summary: PostgresReviewedPricePromotionSuccessSummary;
  readonly version: 1;
}

type PublicationJournal =
  | PreparedPublicationJournal
  | CommittedPublicationJournal;

interface PublicationJournalPaths {
  readonly commit: string;
  readonly journal: string;
  readonly prepare: string;
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
  readonly authorityBundle: string;
  readonly authorityBundleSha256: string;
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
  readonly outputReviewPacket: string;
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
  failureCode:
    | "argument_invalid"
    | "artifact_file_unsafe"
    | "output_file_unsafe"
    | "plan_result_invalid",
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
  failureCode: "argument_invalid" | "database_open_failed" | "plan_result_invalid" =
    "argument_invalid",
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
  const publicationBoundaryDescriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [input, "assertPublicationBoundary"],
  ) as PropertyDescriptor | undefined;
  const assertPublicationBoundary = publicationBoundaryDescriptor
    ? ownDependencyValue(input, "assertPublicationBoundary")
    : undefined;
  const releaseHandleDescriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [input, "releasePublishedArtifactHandle"],
  ) as PropertyDescriptor | undefined;
  const releasePublishedArtifactHandle = releaseHandleDescriptor
    ? ownDependencyValue(input, "releasePublishedArtifactHandle")
    : undefined;
  if (
    typeof openDatabase !== "function"
    || typeof buildPlan !== "function"
    || environment === null
    || typeof environment !== "object"
    || isProxy(environment)
    || typeof expectedRootCaDerSha256 !== "string"
    || typeof now !== "function"
    || typeof writeOutput !== "function"
    || assertPublicationBoundary !== undefined
      && typeof assertPublicationBoundary !== "function"
    || releasePublishedArtifactHandle !== undefined
      && typeof releasePublishedArtifactHandle !== "function"
  ) fail("argument_invalid");
  return OBJECT_FREEZE({
    ...(assertPublicationBoundary === undefined
      ? {}
      : { assertPublicationBoundary }),
    ...(releasePublishedArtifactHandle === undefined
      ? {}
      : { releasePublishedArtifactHandle }),
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
    case "--authority-bundle": return 14;
    case "--authority-bundle-sha256": return 15;
    case "--output-review-packet": return 16;
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
    null, null, null,
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
    authorityBundle: exactArrayItem(slots, 14, "argument_invalid") as string,
    authorityBundleSha256:
      exactArrayItem(slots, 15, "argument_invalid") as string,
    outputReviewPacket:
      exactArrayItem(slots, 16, "argument_invalid") as string,
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

async function capturedRename(
  oldPath: string,
  newPath: string,
): Promise<void> {
  await REFLECT_APPLY(FS_PROMISES_RENAME, FS_PROMISES_OBJECT, [
    oldPath,
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

function sameFileObject(
  left: StableFileIdentity,
  right: StableFileIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid;
}

function serializeStableFileIdentity(
  value: StableFileIdentity,
): SerializedStableFileIdentity {
  const decimal = (item: bigint): string => REFLECT_APPLY(
    BIGINT_TO_STRING,
    item,
    [],
  ) as string;
  return OBJECT_FREEZE({
    ctimeNs: decimal(value.ctimeNs),
    dev: decimal(value.dev),
    gid: decimal(value.gid),
    ino: decimal(value.ino),
    mode: decimal(value.mode),
    mtimeNs: decimal(value.mtimeNs),
    nlink: decimal(value.nlink),
    size: decimal(value.size),
    uid: decimal(value.uid),
  });
}

function sameSerializedFileIdentity(
  expected: SerializedStableFileIdentity,
  actual: StableFileIdentity,
): boolean {
  const decimal = (item: bigint): string => REFLECT_APPLY(
    BIGINT_TO_STRING,
    item,
    [],
  ) as string;
  return expected.ctimeNs === decimal(actual.ctimeNs)
    && expected.dev === decimal(actual.dev)
    && expected.gid === decimal(actual.gid)
    && expected.ino === decimal(actual.ino)
    && expected.mode === decimal(actual.mode)
    && expected.mtimeNs === decimal(actual.mtimeNs)
    && expected.nlink === decimal(actual.nlink)
    && expected.size === decimal(actual.size)
    && expected.uid === decimal(actual.uid);
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

function deepFreezeCanonicalArtifact(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (isProxy(value)) fail("artifact_invalid");
  const prototype = REFLECT_APPLY(
    OBJECT_GET_PROTOTYPE_OF,
    OBJECT_CONSTRUCTOR,
    [value],
  );
  if (
    prototype !== OBJECT_PROTOTYPE
    && prototype !== null
    && prototype !== ARRAY_PROTOTYPE
  ) fail("artifact_invalid");
  const keys = REFLECT_OWN_KEYS(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      OBJECT_CONSTRUCTOR,
      [value, key],
    ) as PropertyDescriptor | undefined;
    if (!descriptor || !REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_CONSTRUCTOR,
      [descriptor, "value"],
    )) fail("artifact_invalid");
    deepFreezeCanonicalArtifact(descriptor.value);
  }
  REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [value]);
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
      deepFreezeCanonicalArtifact(parsed.data);
      return OBJECT_FREEZE({
        sha256: input.held.sha256,
        value: parsed.data,
      });
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

async function closeHeldPrivateFiles(input: {
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

function activePublicationJournal(filename: string): boolean {
  return REFLECT_APPLY(
    SET_HAS,
    ACTIVE_PUBLICATION_JOURNALS,
    [filename],
  ) as boolean;
}

function registerActivePublicationJournal(filename: string): void {
  if (activePublicationJournal(filename)) fail("output_file_unsafe");
  REFLECT_APPLY(SET_ADD, ACTIVE_PUBLICATION_JOURNALS, [filename]);
}

function unregisterActivePublicationJournal(filename: string): void {
  if (!activePublicationJournal(filename)) fail("output_file_unsafe");
  const deleted = REFLECT_APPLY(
    SET_DELETE,
    ACTIVE_PUBLICATION_JOURNALS,
    [filename],
  );
  if (deleted !== true) fail("output_file_unsafe");
}

function publicationProcessIsAlive(processId: number): boolean {
  if (
    !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [processId])
    || processId < 1
    || typeof PROCESS_KILL !== "function"
  ) fail("output_file_unsafe");
  try {
    REFLECT_APPLY(PROCESS_KILL, PROCESS_OBJECT, [processId, 0]);
    return true;
  } catch (error) {
    if (errnoIs(error, "ESRCH")) return false;
    return fail("output_file_unsafe");
  }
}

function assertPreparedPublicationRecoverable(
  journal: PreparedPublicationJournal,
  journalPath: string,
  allowActiveProcess: boolean,
): void {
  if (journal.processId === PROCESS_PID) {
    if (!allowActiveProcess && activePublicationJournal(journalPath)) {
      fail("output_file_unsafe");
    }
    return;
  }
  if (publicationProcessIsAlive(journal.processId)) fail("output_file_unsafe");
}

function publicationJournalPaths(
  outputPlanInput: string,
  outputReviewPacketInput: string,
): PublicationJournalPaths {
  const outputPlan = exactAbsolutePath(outputPlanInput);
  const outputReviewPacket = exactAbsolutePath(outputReviewPacketInput);
  const parent = REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [outputPlan]) as string;
  if (
    REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [outputReviewPacket]) !== parent
  ) fail("argument_invalid");
  const publicationId = sha256PostgresReviewedPricePromotionValue({
    outputPlan,
    outputReviewPacket,
  });
  const journal = REFLECT_APPLY(PATH_JOIN, PATH_OBJECT, [
    parent,
    `.pintpath-postgres-reviewed-price-publication-${publicationId}.journal`,
  ]) as string;
  const prepare = `${journal}.prepare`;
  const commit = `${journal}.commit`;
  if (
    exactAbsolutePath(journal) !== journal
    || exactAbsolutePath(prepare) !== prepare
    || exactAbsolutePath(commit) !== commit
  ) fail("argument_invalid");
  return OBJECT_FREEZE({ commit, journal, prepare });
}

function publicationInvocationSha256(input: {
  readonly args: ExactCliArguments;
  readonly authorityBundle: string;
  readonly deploymentAttestation: string;
  readonly expectedRootCaDerSha256: string;
  readonly migrationReceipt: string;
  readonly migrationTargetIdentity: string;
  readonly outputPlan: string;
  readonly outputReviewPacket: string;
  readonly plannerUrlFile: string;
  readonly privateInput: string;
}): string {
  return sha256PostgresReviewedPricePromotionValue({
    authorityBundle: input.authorityBundle,
    authorityBundleSha256: exactSha256(input.args.authorityBundleSha256),
    candidateSha: exactCandidateSha(input.args.candidateSha),
    command: POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND,
    deploymentAttestation: input.deploymentAttestation,
    deploymentAttestationSha256:
      exactSha256(input.args.deploymentAttestationSha256),
    expectedEnvironment: input.args.expectedEnvironment,
    expectedRootCaDerSha256: exactSha256(input.expectedRootCaDerSha256),
    expectedTargetDatabaseIdentitySha256:
      exactSha256(input.args.expectedTargetDatabaseIdentitySha256),
    migrationReceipt: input.migrationReceipt,
    migrationReceiptSha256: exactSha256(input.args.migrationReceiptSha256),
    migrationTargetIdentity: input.migrationTargetIdentity,
    migrationTargetIdentitySha256:
      exactSha256(input.args.migrationTargetIdentitySha256),
    outputPlan: input.outputPlan,
    outputReviewPacket: input.outputReviewPacket,
    plannerUrlFile: input.plannerUrlFile,
    plannerUrlSha256: exactSha256(input.args.plannerUrlSha256),
    privateInput: input.privateInput,
    privateInputSha256: exactSha256(input.args.privateInputSha256),
    publicationVersion: 1,
    reviewedPriceSelectionPolicySha256:
      REVIEWED_PRICE_SELECTION_POLICY_SHA256,
    reviewedPriceSourceSchemaSha256:
      POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256,
    reviewedPriceWrongPricePolicySha256:
      REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
    railwayDeploymentAttestationPolicySha256:
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256,
  });
}

function describePublicationArtifact(
  filenameInput: string,
  temporaryPathInput: string,
  value: unknown,
  maximumBytes: number,
): PublicationArtifactRecord {
  const filename = exactAbsolutePath(filenameInput);
  const temporaryPath = exactAbsolutePath(temporaryPathInput);
  let bytes: Buffer | null = null;
  try {
    bytes = canonicalPostgresReviewedPricePromotionJson(value);
    const byteCount = exactBufferLength(bytes, "plan_result_invalid");
    if (byteCount < 1 || byteCount > maximumBytes) fail("plan_result_invalid");
    return OBJECT_FREEZE({
      bytes: byteCount,
      path: filename,
      sha256: sha256PostgresMigrationBytes(bytes),
      temporaryPath,
    });
  } finally {
    wipeBytes(bytes);
  }
}

function publicationTemporaryPath(
  parent: string,
  prefix: "plan" | "review-packet",
): string {
  const temporaryPath = REFLECT_APPLY(PATH_JOIN, PATH_OBJECT, [
    parent,
    `.pintpath-postgres-reviewed-price-${prefix}-${freshTemporarySuffix()}.tmp`,
  ]) as string;
  if (
    exactAbsolutePath(temporaryPath) !== temporaryPath
    || REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [temporaryPath]) !== parent
  ) fail("output_file_unsafe");
  return temporaryPath;
}

function exactOutputRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || isProxy(value)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [value])
      !== OBJECT_PROTOTYPE
  ) fail("output_file_unsafe");
  const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, REFLECT_OBJECT, [value]);
  if (!ARRAY_IS_ARRAY(keys) || keys.length !== expectedKeys.length) {
    fail("output_file_unsafe");
  }
  for (let expectedIndex = 0; expectedIndex < expectedKeys.length; expectedIndex += 1) {
    const expected = expectedKeys[expectedIndex];
    if (typeof expected !== "string") fail("output_file_unsafe");
    let found = false;
    for (let actualIndex = 0; actualIndex < keys.length; actualIndex += 1) {
      const actual = keys[actualIndex];
      if (actual === expected) found = true;
    }
    if (!found) fail("output_file_unsafe");
  }
  return value as Record<string, unknown>;
}

function exactOutputString(
  value: Record<string, unknown>,
  key: string,
): string {
  const item = ownDataValue(value, key, "output_file_unsafe");
  if (typeof item !== "string") fail("output_file_unsafe");
  return item;
}

function exactOutputNonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const item = ownDataValue(value, key, "output_file_unsafe");
  if (
    !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [item])
    || (item as number) < 0
  ) fail("output_file_unsafe");
  return item as number;
}

function exactSerializedStableFileIdentity(
  value: unknown,
): SerializedStableFileIdentity {
  const record = exactOutputRecord(value, [
    "ctimeNs",
    "dev",
    "gid",
    "ino",
    "mode",
    "mtimeNs",
    "nlink",
    "size",
    "uid",
  ]);
  const decimal = (key: string): string => {
    const item = exactOutputString(record, key);
    if (!regexMatches(/^(?:0|[1-9][0-9]*)$/, item)) {
      fail("output_file_unsafe");
    }
    let parsed: bigint;
    try {
      parsed = REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [item]) as bigint;
    } catch {
      return fail("output_file_unsafe");
    }
    if (
      REFLECT_APPLY(BIGINT_TO_STRING, parsed, []) !== item
    ) fail("output_file_unsafe");
    return item;
  };
  return OBJECT_FREEZE({
    ctimeNs: decimal("ctimeNs"),
    dev: decimal("dev"),
    gid: decimal("gid"),
    ino: decimal("ino"),
    mode: decimal("mode"),
    mtimeNs: decimal("mtimeNs"),
    nlink: decimal("nlink"),
    size: decimal("size"),
    uid: decimal("uid"),
  });
}

function exactPublicationArtifactRecord(input: {
  readonly committed: boolean;
  readonly expectedPath: string;
  readonly maximumBytes: number;
  readonly prefix: "plan" | "review-packet";
  readonly value: unknown;
}): PublicationArtifactRecord | CommittedPublicationArtifactRecord {
  const record = exactOutputRecord(input.value, input.committed
    ? ["bytes", "identity", "path", "sha256", "temporaryPath"]
    : ["bytes", "path", "sha256", "temporaryPath"]);
  const bytes = exactOutputNonNegativeInteger(record, "bytes");
  const artifactPath = exactOutputString(record, "path");
  const sha256 = exactOutputString(record, "sha256");
  const temporaryPath = exactOutputString(record, "temporaryPath");
  const parent = REFLECT_APPLY(
    PATH_DIRNAME,
    PATH_OBJECT,
    [input.expectedPath],
  ) as string;
  const temporaryPrefix = REFLECT_APPLY(PATH_JOIN, PATH_OBJECT, [
    parent,
    `.pintpath-postgres-reviewed-price-${input.prefix}-`,
  ]) as string;
  const suffix = REFLECT_APPLY(
    STRING_SLICE,
    temporaryPath,
    [temporaryPrefix.length, -4],
  ) as string;
  if (
    bytes < 1
    || bytes > input.maximumBytes
    || artifactPath !== input.expectedPath
    || exactAbsolutePath(artifactPath) !== artifactPath
    || exactAbsolutePath(temporaryPath) !== temporaryPath
    || REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [temporaryPath]) !== parent
    || REFLECT_APPLY(STRING_STARTS_WITH, temporaryPath, [temporaryPrefix])
      !== true
    || REFLECT_APPLY(STRING_ENDS_WITH, temporaryPath, [".tmp"]) !== true
    || !regexMatches(/^[a-f0-9]{32}$/, suffix)
    || !regexMatches(SHA256_PATTERN, sha256)
  ) fail("output_file_unsafe");
  if (!input.committed) {
    return OBJECT_FREEZE({
      bytes,
      path: artifactPath,
      sha256,
      temporaryPath,
    });
  }
  const identity = exactSerializedStableFileIdentity(
    ownDataValue(record, "identity", "output_file_unsafe"),
  );
  if (
    identity.nlink !== "1"
    || identity.size !== REFLECT_APPLY(NUMBER_TO_STRING, bytes, [])
  ) {
    fail("output_file_unsafe");
  }
  return OBJECT_FREEZE({
    bytes,
    identity,
    path: artifactPath,
    sha256,
    temporaryPath,
  });
}

function exactPublicationSummary(input: {
  readonly candidateSha: string;
  readonly expectedPhysicalIdentitySha256: string;
  readonly plan: PublicationArtifactRecord;
  readonly reviewPacket: PublicationArtifactRecord;
  readonly value: unknown;
}): PostgresReviewedPricePromotionSuccessSummary {
  const record = exactOutputRecord(input.value, [
    "activationBlockerCount",
    "candidateSha",
    "command",
    "expectedEnvironment",
    "itemCount",
    "mutationEnabled",
    "ok",
    "planCandidateSha256",
    "planFileSha256",
    "physicalIdentitySha256",
    "plannerLoginIdentitySha256",
    "reviewPacketCandidateSha256",
    "reviewPacketFileSha256",
    "rowCount",
  ]);
  const activationBlockerCount = exactOutputNonNegativeInteger(
    record,
    "activationBlockerCount",
  );
  const candidateSha = exactOutputString(record, "candidateSha");
  const command = exactOutputString(record, "command");
  const expectedEnvironment = exactOutputString(record, "expectedEnvironment");
  const itemCount = exactOutputNonNegativeInteger(record, "itemCount");
  const mutationEnabled = ownDataValue(
    record,
    "mutationEnabled",
    "output_file_unsafe",
  );
  const ok = ownDataValue(record, "ok", "output_file_unsafe");
  const planCandidateSha256 = exactOutputString(record, "planCandidateSha256");
  const planFileSha256 = exactOutputString(record, "planFileSha256");
  const physicalIdentitySha256 = exactOutputString(
    record,
    "physicalIdentitySha256",
  );
  const plannerLoginIdentitySha256 = exactOutputString(
    record,
    "plannerLoginIdentitySha256",
  );
  const reviewPacketCandidateSha256 = exactOutputString(
    record,
    "reviewPacketCandidateSha256",
  );
  const reviewPacketFileSha256 = exactOutputString(
    record,
    "reviewPacketFileSha256",
  );
  const rowCount = exactOutputNonNegativeInteger(record, "rowCount");
  if (
    activationBlockerCount
      !== POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS.length
    || candidateSha !== input.candidateSha
    || command !== POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND
    || expectedEnvironment !== "permanent-staging"
    || mutationEnabled !== false
    || ok !== true
    || !regexMatches(SHA256_PATTERN, planCandidateSha256)
    || planFileSha256 !== input.plan.sha256
    || physicalIdentitySha256 !== input.expectedPhysicalIdentitySha256
    || !regexMatches(SHA256_PATTERN, plannerLoginIdentitySha256)
    || !regexMatches(SHA256_PATTERN, reviewPacketCandidateSha256)
    || reviewPacketFileSha256 !== input.reviewPacket.sha256
  ) fail("output_file_unsafe");
  return OBJECT_FREEZE({
    activationBlockerCount,
    candidateSha,
    command: POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND,
    expectedEnvironment: "permanent-staging",
    itemCount,
    mutationEnabled: false,
    ok: true,
    planCandidateSha256,
    planFileSha256,
    physicalIdentitySha256,
    plannerLoginIdentitySha256,
    reviewPacketCandidateSha256,
    reviewPacketFileSha256,
    rowCount,
  });
}

function decodeExactUtf8Output(bytes: Buffer): string {
  let roundTrip: Buffer | null = null;
  try {
    const value = REFLECT_APPLY(TEXT_DECODER_DECODE, UTF8_FATAL_DECODER, [bytes]);
    if (typeof value !== "string") fail("output_file_unsafe");
    roundTrip = REFLECT_APPLY(
      BUFFER_FROM,
      BUFFER_CONSTRUCTOR,
      [value, "utf8"],
    ) as Buffer;
    if (!exactBytesEqual(roundTrip, bytes)) fail("output_file_unsafe");
    return value;
  } catch (error) {
    if (isSafeCliError(error)) throw error;
    return fail("output_file_unsafe");
  } finally {
    wipeBytes(roundTrip);
  }
}

function parsePublicationJournal(input: {
  readonly bytes: Buffer;
  readonly candidateSha: string;
  readonly expectedInvocationSha256: string;
  readonly expectedPhysicalIdentitySha256: string;
  readonly outputPlan: string;
  readonly outputReviewPacket: string;
}): PublicationJournal {
  let raw: unknown;
  try {
    raw = REFLECT_APPLY(JSON_PARSE, JSON_OBJECT, [
      decodeExactUtf8Output(input.bytes),
    ]) as unknown;
  } catch (error) {
    if (isSafeCliError(error)) throw error;
    return fail("output_file_unsafe");
  }
  const record = exactOutputRecord(raw, [
    "artifacts",
    "invocationSha256",
    "kind",
    "outputPlan",
    "outputReviewPacket",
    "processId",
    "state",
    "summary",
    "version",
  ]);
  const kind = exactOutputString(record, "kind");
  const invocationSha256 = exactOutputString(record, "invocationSha256");
  const outputPlan = exactOutputString(record, "outputPlan");
  const outputReviewPacket = exactOutputString(record, "outputReviewPacket");
  const processId = exactOutputNonNegativeInteger(record, "processId");
  const state = exactOutputString(record, "state");
  const version = ownDataValue(record, "version", "output_file_unsafe");
  if (
    kind !== "pintpath-postgres-reviewed-price-promotion-publication"
    || invocationSha256 !== input.expectedInvocationSha256
    || outputPlan !== input.outputPlan
    || outputReviewPacket !== input.outputReviewPacket
    || processId < 1
    || state !== "prepared" && state !== "committed"
    || version !== 1
  ) fail("output_file_unsafe");
  const artifactsRecord = exactOutputRecord(
    ownDataValue(record, "artifacts", "output_file_unsafe"),
    ["plan", "reviewPacket"],
  );
  const committed = state === "committed";
  const plan = exactPublicationArtifactRecord({
    committed,
    expectedPath: outputPlan,
    maximumBytes: MAX_PLAN_BYTES,
    prefix: "plan",
    value: ownDataValue(artifactsRecord, "plan", "output_file_unsafe"),
  });
  const reviewPacket = exactPublicationArtifactRecord({
    committed,
    expectedPath: outputReviewPacket,
    maximumBytes: MAX_REVIEW_PACKET_BYTES,
    prefix: "review-packet",
    value: ownDataValue(
      artifactsRecord,
      "reviewPacket",
      "output_file_unsafe",
    ),
  });
  if (!exactDistinctPaths([
    outputPlan,
    outputReviewPacket,
    plan.temporaryPath,
    reviewPacket.temporaryPath,
  ])) fail("output_file_unsafe");
  const summary = exactPublicationSummary({
    candidateSha: input.candidateSha,
    expectedPhysicalIdentitySha256: input.expectedPhysicalIdentitySha256,
    plan,
    reviewPacket,
    value: ownDataValue(record, "summary", "output_file_unsafe"),
  });
  let canonical: Buffer | null = null;
  try {
    canonical = canonicalPostgresReviewedPricePromotionJson(raw);
    if (!exactBytesEqual(canonical, input.bytes)) fail("output_file_unsafe");
  } finally {
    wipeBytes(canonical);
  }
  if (committed) {
    return OBJECT_FREEZE({
      artifacts: OBJECT_FREEZE({
        plan: plan as CommittedPublicationArtifactRecord,
        reviewPacket: reviewPacket as CommittedPublicationArtifactRecord,
      }),
      invocationSha256,
      kind,
      outputPlan,
      outputReviewPacket,
      processId,
      state: "committed",
      summary,
      version: 1,
    });
  }
  return OBJECT_FREEZE({
    artifacts: OBJECT_FREEZE({ plan, reviewPacket }),
    invocationSha256,
    kind,
    outputPlan,
    outputReviewPacket,
    processId,
    state: "prepared",
    summary,
    version: 1,
  });
}

function assertPrivateJournalFile(
  stat: fs.BigIntStats,
  uid: bigint,
): void {
  if (
    (stat.mode & S_IFMT) !== S_IFREG
    || stat.uid !== uid
    || stat.nlink !== 1n
    || (stat.mode & 0o7777n) !== 0o600n
    || stat.size < 1n
    || stat.size > REFLECT_APPLY(
      BIGINT_CONSTRUCTOR,
      undefined,
      [MAX_PUBLICATION_JOURNAL_BYTES],
    )
  ) fail("output_file_unsafe");
}

async function readExactPrivateJournal(
  authority: PrivateParentAuthority,
  filenameInput: string,
): Promise<{ readonly bytes: Buffer; readonly identity: StableFileIdentity }> {
  const filename = exactAbsolutePath(filenameInput);
  if (REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [filename]) !== authority.path) {
    fail("output_file_unsafe");
  }
  let handle: fs.promises.FileHandle | null = null;
  let bytes: Buffer | null = null;
  try {
    await authority.assertExact();
    const pathBefore = await capturedLstat(filename, "output_file_unsafe");
    const realBefore = await capturedRealpath(filename, "output_file_unsafe");
    assertPrivateJournalFile(pathBefore, authority.uid);
    if (realBefore !== filename) fail("output_file_unsafe");
    handle = await capturedOpen(
      filename,
      O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
      undefined,
      "output_file_unsafe",
    );
    const opened = await capturedHandleStat(handle, "output_file_unsafe");
    assertPrivateJournalFile(opened, authority.uid);
    const identity = fileIdentity(opened);
    if (!sameFileIdentity(identity, fileIdentity(pathBefore))) {
      fail("output_file_unsafe");
    }
    const size = REFLECT_APPLY(NUMBER_OBJECT, undefined, [opened.size]) as number;
    if (
      !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [size])
      || size < 1
    ) fail("output_file_unsafe");
    bytes = await readExactDescriptor(handle, size, "output_file_unsafe");
    const after = await capturedHandleStat(handle, "output_file_unsafe");
    const pathAfter = await capturedLstat(filename, "output_file_unsafe");
    const realAfter = await capturedRealpath(filename, "output_file_unsafe");
    assertPrivateJournalFile(after, authority.uid);
    assertPrivateJournalFile(pathAfter, authority.uid);
    if (
      realAfter !== filename
      || !sameFileIdentity(identity, fileIdentity(after))
      || !sameFileIdentity(identity, fileIdentity(pathAfter))
    ) fail("output_file_unsafe");
    await authority.assertExact();
    const result = { bytes, identity };
    bytes = null;
    return result;
  } catch (error) {
    wipeBytes(bytes);
    if (isSafeCliError(error)) throw error;
    return fail("output_file_unsafe");
  } finally {
    if (handle) {
      try {
        await capturedHandleClose(handle, "output_file_unsafe");
      } catch {
        wipeBytes(bytes);
        fail("output_file_unsafe");
      }
    }
  }
}

async function writePrivateJournalStagingFile(
  authority: PrivateParentAuthority,
  filenameInput: string,
  value: PublicationJournal,
): Promise<void> {
  const filename = exactAbsolutePath(filenameInput);
  if (REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [filename]) !== authority.path) {
    fail("output_file_unsafe");
  }
  let bytes: Buffer | null = null;
  let handle: fs.promises.FileHandle | null = null;
  let owned = false;
  let ownedIdentity: StableFileIdentity | null = null;
  try {
    bytes = canonicalPostgresReviewedPricePromotionJson(value);
    const byteCount = exactBufferLength(bytes, "output_file_unsafe");
    if (byteCount < 1 || byteCount > MAX_PUBLICATION_JOURNAL_BYTES) {
      fail("output_file_unsafe");
    }
    await authority.assertExact();
    handle = await capturedOpen(
      filename,
      O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW,
      0o600,
      "output_file_unsafe",
    );
    owned = true;
    ownedIdentity = fileIdentity(await capturedHandleStat(
      handle,
      "output_file_unsafe",
    ));
    await capturedHandleWriteFile(handle, bytes);
    await capturedHandleChmod(handle, 0o600);
    await capturedHandleSync(handle, "output_file_unsafe");
    const written = await capturedHandleStat(handle, "output_file_unsafe");
    assertPrivateOutputFile(written, authority.uid, byteCount);
    const readback = await readExactDescriptor(
      handle,
      byteCount,
      "output_file_unsafe",
    );
    try {
      if (!exactBytesEqual(readback, bytes)) fail("output_file_unsafe");
    } finally {
      wipeBytes(readback);
    }
    await authority.assertExact();
    await capturedHandleClose(handle, "output_file_unsafe");
    handle = null;
    owned = false;
  } catch (error) {
    if (isSafeCliError(error)) throw error;
    return fail("output_file_unsafe");
  } finally {
    wipeBytes(bytes);
    let cleanupFailed = false;
    if (owned && handle && ownedIdentity) {
      try {
        await capturedHandleTruncate(handle, 0);
        await capturedHandleSync(handle, "output_file_unsafe");
        const atPath = await capturedLstat(filename, "output_file_unsafe");
        const current = fileIdentity(atPath);
        if (
          !sameFileObject(ownedIdentity, current)
          || current.size !== 0n
          || current.nlink !== 1n
        ) fail("output_file_unsafe");
        await capturedUnlink(filename);
        await capturedHandleSync(authority.handle, "output_file_unsafe");
      } catch {
        cleanupFailed = true;
      }
    }
    if (handle) {
      try {
        await capturedHandleClose(handle, "output_file_unsafe");
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) fail("output_file_unsafe");
  }
}

async function assertJournalEquals(
  authority: PrivateParentAuthority,
  filename: string,
  value: PublicationJournal,
): Promise<StableFileIdentity> {
  const held = await readExactPrivateJournal(authority, filename);
  let expected: Buffer | null = null;
  try {
    expected = canonicalPostgresReviewedPricePromotionJson(value);
    if (!exactBytesEqual(held.bytes, expected)) fail("output_file_unsafe");
    return held.identity;
  } finally {
    wipeBytes(held.bytes);
    wipeBytes(expected);
  }
}

async function writePreparedPublicationJournal(input: {
  readonly authority: PrivateParentAuthority;
  readonly journal: PreparedPublicationJournal;
  readonly paths: PublicationJournalPaths;
}): Promise<void> {
  try {
    await input.authority.assertExact();
    if (
      await pathExists(input.paths.journal)
      || await pathExists(input.paths.prepare)
      || await pathExists(input.paths.commit)
      || await pathExists(input.journal.artifacts.plan.path)
      || await pathExists(input.journal.artifacts.plan.temporaryPath)
      || await pathExists(input.journal.artifacts.reviewPacket.path)
      || await pathExists(input.journal.artifacts.reviewPacket.temporaryPath)
    ) fail("output_file_unsafe");
    await writePrivateJournalStagingFile(
      input.authority,
      input.paths.prepare,
      input.journal,
    );
    await input.authority.assertExact();
    await capturedLink(input.paths.prepare, input.paths.journal);
    await capturedUnlink(input.paths.prepare);
    await capturedHandleSync(input.authority.handle, "output_file_unsafe");
    await assertJournalEquals(
      input.authority,
      input.paths.journal,
      input.journal,
    );
  } catch (error) {
    if (isSafeCliError(error)) throw error;
    return fail("output_file_unsafe");
  }
}

async function validateCommittedPublicationArtifact(
  authority: PrivateParentAuthority,
  artifact: CommittedPublicationArtifactRecord,
): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  let bytes: Buffer | null = null;
  try {
    await authority.assertExact();
    const pathBefore = await capturedLstat(artifact.path, "output_file_unsafe");
    const realBefore = await capturedRealpath(artifact.path, "output_file_unsafe");
    assertPrivateOutputFile(pathBefore, authority.uid, artifact.bytes);
    const beforeIdentity = fileIdentity(pathBefore);
    if (
      realBefore !== artifact.path
      || !sameSerializedFileIdentity(artifact.identity, beforeIdentity)
    ) fail("output_file_unsafe");
    handle = await capturedOpen(
      artifact.path,
      O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
      undefined,
      "output_file_unsafe",
    );
    const opened = await capturedHandleStat(handle, "output_file_unsafe");
    assertPrivateOutputFile(opened, authority.uid, artifact.bytes);
    if (!sameFileIdentity(beforeIdentity, fileIdentity(opened))) {
      fail("output_file_unsafe");
    }
    bytes = await readExactDescriptor(
      handle,
      artifact.bytes,
      "output_file_unsafe",
    );
    if (sha256PostgresMigrationBytes(bytes) !== artifact.sha256) {
      fail("output_file_unsafe");
    }
    const after = await capturedHandleStat(handle, "output_file_unsafe");
    const pathAfter = await capturedLstat(artifact.path, "output_file_unsafe");
    const realAfter = await capturedRealpath(artifact.path, "output_file_unsafe");
    assertPrivateOutputFile(after, authority.uid, artifact.bytes);
    assertPrivateOutputFile(pathAfter, authority.uid, artifact.bytes);
    if (
      realAfter !== artifact.path
      || !sameFileIdentity(beforeIdentity, fileIdentity(after))
      || !sameFileIdentity(beforeIdentity, fileIdentity(pathAfter))
    ) fail("output_file_unsafe");
    await authority.assertExact();
  } catch (error) {
    if (isSafeCliError(error)) throw error;
    return fail("output_file_unsafe");
  } finally {
    wipeBytes(bytes);
    if (handle) {
      try {
        await capturedHandleClose(handle, "output_file_unsafe");
      } catch {
        fail("output_file_unsafe");
      }
    }
  }
}

async function writeCommittedPublicationJournal(input: {
  readonly authority: PrivateParentAuthority;
  readonly committed: CommittedPublicationJournal;
  readonly markCommitted: () => void;
  readonly paths: PublicationJournalPaths;
  readonly prepared: PreparedPublicationJournal;
}): Promise<boolean> {
  let renamed = false;
  try {
    if (
      await pathExists(input.paths.prepare)
      || await pathExists(input.paths.commit)
      || await pathExists(input.prepared.artifacts.plan.temporaryPath)
      || await pathExists(input.prepared.artifacts.reviewPacket.temporaryPath)
    ) fail("output_file_unsafe");
    await assertJournalEquals(
      input.authority,
      input.paths.journal,
      input.prepared,
    );
    await validateCommittedPublicationArtifact(
      input.authority,
      input.committed.artifacts.plan,
    );
    await validateCommittedPublicationArtifact(
      input.authority,
      input.committed.artifacts.reviewPacket,
    );
    await writePrivateJournalStagingFile(
      input.authority,
      input.paths.commit,
      input.committed,
    );
    await assertJournalEquals(
      input.authority,
      input.paths.journal,
      input.prepared,
    );
    await validateCommittedPublicationArtifact(
      input.authority,
      input.committed.artifacts.plan,
    );
    await validateCommittedPublicationArtifact(
      input.authority,
      input.committed.artifacts.reviewPacket,
    );
    await capturedRename(input.paths.commit, input.paths.journal);
    renamed = true;
    // The rename is the visibility boundary. Mark both retained artifacts in
    // the same synchronous turn so no later fsync/close ambiguity can trigger
    // destructive rollback beneath a committed marker.
    input.markCommitted();
    await capturedHandleSync(input.authority.handle, "output_file_unsafe");
    await assertJournalEquals(
      input.authority,
      input.paths.journal,
      input.committed,
    );
    await validateCommittedPublicationArtifact(
      input.authority,
      input.committed.artifacts.plan,
    );
    await validateCommittedPublicationArtifact(
      input.authority,
      input.committed.artifacts.reviewPacket,
    );
    return true;
  } catch (error) {
    if (renamed) return false;
    if (isSafeCliError(error)) throw error;
    return fail("output_file_unsafe");
  }
}

interface RecoverablePublicationFile {
  readonly filename: string;
  readonly handle: fs.promises.FileHandle;
  readonly identity: StableFileIdentity;
  readonly size: number;
}

async function openRecoverablePublicationFile(input: {
  readonly allowInvalidated: boolean;
  readonly authority: PrivateParentAuthority;
  readonly expectedBytes: number;
  readonly expectedSha256: string | null;
  readonly filename: string;
  readonly temporary: boolean;
}): Promise<RecoverablePublicationFile | null> {
  let handle: fs.promises.FileHandle | null = null;
  let bytes: Buffer | null = null;
  try {
    let pathBefore: fs.BigIntStats;
    try {
      pathBefore = await capturedLstat(input.filename, "output_file_unsafe");
    } catch (error) {
      if (errnoIs(error, "ENOENT")) return null;
      throw error;
    }
    const realBefore = await capturedRealpath(
      input.filename,
      "output_file_unsafe",
    );
    if (
      realBefore !== input.filename
      || (pathBefore.mode & S_IFMT) !== S_IFREG
      || pathBefore.uid !== input.authority.uid
      || (pathBefore.mode & 0o7777n) !== 0o600n
      || pathBefore.nlink < 1n
      || pathBefore.nlink > 2n
      || pathBefore.size < 0n
      || pathBefore.size > REFLECT_APPLY(
        BIGINT_CONSTRUCTOR,
        undefined,
        [input.expectedBytes],
      )
    ) fail("output_file_unsafe");
    handle = await capturedOpen(
      input.filename,
      O_RDWR | O_NOFOLLOW | O_NONBLOCK,
      undefined,
      "output_file_unsafe",
    );
    const opened = await capturedHandleStat(handle, "output_file_unsafe");
    const identity = fileIdentity(opened);
    if (!sameFileIdentity(identity, fileIdentity(pathBefore))) {
      fail("output_file_unsafe");
    }
    const size = REFLECT_APPLY(NUMBER_OBJECT, undefined, [opened.size]) as number;
    if (
      !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [size])
      || size < 0
      || size > input.expectedBytes
      || !input.temporary
        && size !== input.expectedBytes
        && !(input.allowInvalidated && size === 0)
    ) fail("output_file_unsafe");
    if (size === input.expectedBytes && input.expectedSha256 !== null) {
      bytes = await readExactDescriptor(handle, size, "output_file_unsafe");
      if (sha256PostgresMigrationBytes(bytes) !== input.expectedSha256) {
        fail("output_file_unsafe");
      }
    }
    const result = OBJECT_FREEZE({
      filename: input.filename,
      handle,
      identity,
      size,
    });
    handle = null;
    return result;
  } catch (error) {
    if (isSafeCliError(error)) throw error;
    return fail("output_file_unsafe");
  } finally {
    wipeBytes(bytes);
    if (handle) {
      try {
        await capturedHandleClose(handle, "output_file_unsafe");
      } catch {
        fail("output_file_unsafe");
      }
    }
  }
}

async function recoverPreparedPublicationArtifact(
  authority: PrivateParentAuthority,
  artifact: PublicationArtifactRecord,
): Promise<void> {
  const finalFile = await openRecoverablePublicationFile({
    allowInvalidated: true,
    authority,
    expectedBytes: artifact.bytes,
    expectedSha256: artifact.sha256,
    filename: artifact.path,
    temporary: false,
  });
  const temporaryFile = await openRecoverablePublicationFile({
    allowInvalidated: true,
    authority,
    expectedBytes: artifact.bytes,
    expectedSha256: artifact.sha256,
    filename: artifact.temporaryPath,
    temporary: true,
  });
  const files: readonly RecoverablePublicationFile[] = temporaryFile
    ? finalFile ? [temporaryFile, finalFile] : [temporaryFile]
    : finalFile ? [finalFile] : [];
  let exact = true;
  try {
    if (finalFile && temporaryFile) {
      const linked = sameFileObject(finalFile.identity, temporaryFile.identity);
      if (
        !linked
        || finalFile.identity.nlink !== 2n
        || temporaryFile.identity.nlink !== 2n
        || finalFile.size !== temporaryFile.size
      ) fail("output_file_unsafe");
    } else if (
      finalFile?.identity.nlink !== undefined
        && finalFile.identity.nlink !== 1n
      || temporaryFile?.identity.nlink !== undefined
        && temporaryFile.identity.nlink !== 1n
    ) fail("output_file_unsafe");

    let truncatedIdentity: StableFileIdentity | null = null;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file) fail("output_file_unsafe");
      if (
        truncatedIdentity
        && sameFileObject(truncatedIdentity, file.identity)
      ) {
        continue;
      }
      await capturedHandleTruncate(file.handle, 0);
      await capturedHandleSync(file.handle, "output_file_unsafe");
      truncatedIdentity = file.identity;
    }
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file) fail("output_file_unsafe");
      const atPath = await capturedLstat(file.filename, "output_file_unsafe");
      const current = fileIdentity(atPath);
      if (
        !sameFileObject(file.identity, current)
        || current.size !== 0n
        || (current.mode & 0o7777n) !== 0o600n
      ) fail("output_file_unsafe");
    }
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file) fail("output_file_unsafe");
      await capturedUnlink(file.filename);
    }
    if (files.length > 0) {
      await capturedHandleSync(authority.handle, "output_file_unsafe");
    }
  } catch {
    exact = false;
  } finally {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file) {
        exact = false;
        continue;
      }
      try {
        await capturedHandleClose(file.handle, "output_file_unsafe");
      } catch {
        exact = false;
      }
    }
  }
  if (!exact) fail("output_file_unsafe");
}

async function removeReservedPublicationStagingFile(
  authority: PrivateParentAuthority,
  filename: string,
): Promise<void> {
  const file = await openRecoverablePublicationFile({
    allowInvalidated: true,
    authority,
    expectedBytes: MAX_PUBLICATION_JOURNAL_BYTES,
    expectedSha256: null,
    filename,
    temporary: true,
  });
  if (!file) return;
  let exact = true;
  try {
    if (file.identity.nlink !== 1n) fail("output_file_unsafe");
    await capturedHandleTruncate(file.handle, 0);
    await capturedHandleSync(file.handle, "output_file_unsafe");
    const atPath = await capturedLstat(filename, "output_file_unsafe");
    const current = fileIdentity(atPath);
    if (!sameFileObject(file.identity, current) || current.size !== 0n) {
      fail("output_file_unsafe");
    }
    await capturedUnlink(filename);
    await capturedHandleSync(authority.handle, "output_file_unsafe");
  } catch {
    exact = false;
  } finally {
    try {
      await capturedHandleClose(file.handle, "output_file_unsafe");
    } catch {
      exact = false;
    }
  }
  if (!exact) fail("output_file_unsafe");
}

async function normalizePreparedJournalHardlink(
  authority: PrivateParentAuthority,
  paths: PublicationJournalPaths,
): Promise<void> {
  let journalStat: fs.BigIntStats;
  try {
    journalStat = await capturedLstat(paths.journal, "output_file_unsafe");
  } catch (error) {
    if (errnoIs(error, "ENOENT")) return;
    throw error;
  }
  if (journalStat.nlink === 1n) {
    if (await pathExists(paths.prepare)) fail("output_file_unsafe");
    return;
  }
  if (journalStat.nlink !== 2n) fail("output_file_unsafe");
  const prepareStat = await capturedLstat(paths.prepare, "output_file_unsafe");
  if (
    !sameFileIdentity(fileIdentity(journalStat), fileIdentity(prepareStat))
    || (journalStat.mode & S_IFMT) !== S_IFREG
    || journalStat.uid !== authority.uid
    || (journalStat.mode & 0o7777n) !== 0o600n
    || journalStat.size < 1n
    || journalStat.size > REFLECT_APPLY(
      BIGINT_CONSTRUCTOR,
      undefined,
      [MAX_PUBLICATION_JOURNAL_BYTES],
    )
  ) fail("output_file_unsafe");
  await capturedUnlink(paths.prepare);
  await capturedHandleSync(authority.handle, "output_file_unsafe");
  const normalized = await capturedLstat(paths.journal, "output_file_unsafe");
  if (
    normalized.nlink !== 1n
    || !sameFileObject(fileIdentity(journalStat), fileIdentity(normalized))
  ) fail("output_file_unsafe");
}

async function removeExactPreparedJournal(
  authority: PrivateParentAuthority,
  filename: string,
  expectedIdentity: StableFileIdentity,
): Promise<void> {
  const current = await capturedLstat(filename, "output_file_unsafe");
  if (!sameFileIdentity(expectedIdentity, fileIdentity(current))) {
    fail("output_file_unsafe");
  }
  await capturedUnlink(filename);
  await capturedHandleSync(authority.handle, "output_file_unsafe");
}

async function reconcilePublicationJournal(input: {
  readonly allowActiveProcess?: boolean;
  readonly authority: PrivateParentAuthority;
  readonly candidateSha: string;
  readonly expectedInvocationSha256: string;
  readonly expectedPhysicalIdentitySha256: string;
  readonly outputPlan: string;
  readonly outputReviewPacket: string;
  readonly paths: PublicationJournalPaths;
}): Promise<PostgresReviewedPricePromotionSuccessSummary | null> {
  await input.authority.assertExact();
  const journalExists = await pathExists(input.paths.journal);
  if (!journalExists) {
    if (
      await pathExists(input.outputPlan)
      || await pathExists(input.outputReviewPacket)
      || await pathExists(input.paths.commit)
    ) fail("output_file_unsafe");
    if (await pathExists(input.paths.prepare)) {
      const orphan = await readExactPrivateJournal(
        input.authority,
        input.paths.prepare,
      );
      let orphanJournal: PublicationJournal;
      try {
        orphanJournal = parsePublicationJournal({
          bytes: orphan.bytes,
          candidateSha: input.candidateSha,
          expectedInvocationSha256: input.expectedInvocationSha256,
          expectedPhysicalIdentitySha256:
            input.expectedPhysicalIdentitySha256,
          outputPlan: input.outputPlan,
          outputReviewPacket: input.outputReviewPacket,
        });
      } finally {
        wipeBytes(orphan.bytes);
      }
      if (
        orphanJournal.state !== "prepared"
        || await pathExists(orphanJournal.artifacts.plan.temporaryPath)
        || await pathExists(orphanJournal.artifacts.reviewPacket.temporaryPath)
      ) fail("output_file_unsafe");
      assertPreparedPublicationRecoverable(
        orphanJournal,
        input.paths.journal,
        input.allowActiveProcess === true,
      );
      await removeExactPreparedJournal(
        input.authority,
        input.paths.prepare,
        orphan.identity,
      );
    }
    return null;
  }
  await normalizePreparedJournalHardlink(input.authority, input.paths);
  const held = await readExactPrivateJournal(
    input.authority,
    input.paths.journal,
  );
  let journal: PublicationJournal;
  try {
    journal = parsePublicationJournal({
      bytes: held.bytes,
      candidateSha: input.candidateSha,
      expectedInvocationSha256: input.expectedInvocationSha256,
      expectedPhysicalIdentitySha256: input.expectedPhysicalIdentitySha256,
      outputPlan: input.outputPlan,
      outputReviewPacket: input.outputReviewPacket,
    });
  } finally {
    wipeBytes(held.bytes);
  }
  if (journal.state === "committed") {
    if (
      await pathExists(input.paths.prepare)
      || await pathExists(input.paths.commit)
      || await pathExists(journal.artifacts.plan.temporaryPath)
      || await pathExists(journal.artifacts.reviewPacket.temporaryPath)
    ) fail("output_file_unsafe");
    await validateCommittedPublicationArtifact(
      input.authority,
      journal.artifacts.plan,
    );
    await validateCommittedPublicationArtifact(
      input.authority,
      journal.artifacts.reviewPacket,
    );
    return journal.summary;
  }
  assertPreparedPublicationRecoverable(
    journal,
    input.paths.journal,
    input.allowActiveProcess === true,
  );
  await recoverPreparedPublicationArtifact(
    input.authority,
    journal.artifacts.plan,
  );
  await recoverPreparedPublicationArtifact(
    input.authority,
    journal.artifacts.reviewPacket,
  );
  await removeReservedPublicationStagingFile(
    input.authority,
    input.paths.commit,
  );
  if (await pathExists(input.paths.prepare)) fail("output_file_unsafe");
  await removeExactPreparedJournal(
    input.authority,
    input.paths.journal,
    held.identity,
  );
  return null;
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
  finalizeForCommit(): Promise<void>;
  markCommitted(): void;
  prepareForSummary(): Promise<void>;
  revalidateForCommit(): Promise<void>;
  releaseCommittedHandle(
    releaseHandle: PostgresReviewedPricePromotionCliDependencies[
      "releasePublishedArtifactHandle"
    ],
  ): Promise<void>;
  rollback(): Promise<void>;
}

function assertPublicationBoundary(
  callback: PostgresReviewedPricePromotionCliDependencies[
    "assertPublicationBoundary"
  ],
  boundary: PostgresReviewedPricePromotionPublicationBoundary,
): void {
  if (!callback) return;
  try {
    callback(boundary);
  } catch {
    fail("output_file_unsafe");
  }
}

async function rollbackPublishedArtifacts(
  artifacts: readonly (PublishedPrivatePlan | null)[],
): Promise<boolean> {
  let exact = true;
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (!artifact) continue;
    try {
      await artifact.rollback();
    } catch {
      exact = false;
    }
  }
  return exact;
}

async function commitPublishedArtifactPair(input: {
  readonly assertPublicationBoundary: ((
    boundary: PostgresReviewedPricePromotionPublicationBoundary,
  ) => void) | undefined;
  readonly commitJournal: (markCommitted: () => void) => Promise<boolean>;
  readonly plan: PublishedPrivatePlan;
  readonly releasePublishedArtifactHandle:
    PostgresReviewedPricePromotionCliDependencies[
      "releasePublishedArtifactHandle"
    ];
  readonly reviewPacket: PublishedPrivatePlan;
}): Promise<boolean> {
  let publicationExact = true;
  try {
    await input.plan.finalizeForCommit();
    assertPublicationBoundary(input.assertPublicationBoundary, "plan-finalized");
    await input.reviewPacket.finalizeForCommit();
    assertPublicationBoundary(
      input.assertPublicationBoundary,
      "review-packet-finalized",
    );
    await input.plan.revalidateForCommit();
    await input.reviewPacket.revalidateForCommit();
    publicationExact = await input.commitJournal(() => {
      // There is deliberately no await or callback between these transitions.
      input.plan.markCommitted();
      input.reviewPacket.markCommitted();
    });
  } catch {
    const rolledBack = await rollbackPublishedArtifacts([
      input.plan,
      input.reviewPacket,
    ]);
    if (!rolledBack) fail("output_file_unsafe");
    fail("output_file_unsafe");
  }
  let cleanupExact = publicationExact;
  try {
    await input.plan.releaseCommittedHandle(
      input.releasePublishedArtifactHandle,
    );
  } catch {
    cleanupExact = false;
  }
  try {
    await input.reviewPacket.releaseCommittedHandle(
      input.releasePublishedArtifactHandle,
    );
  } catch {
    cleanupExact = false;
  }
  return cleanupExact;
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

async function writeNewPrivateCanonicalArtifact(
  authority: PrivateParentAuthority,
  artifact: PublicationArtifactRecord,
  value: unknown,
  maximumBytes: number,
  temporaryPrefix: "plan" | "review-packet",
): Promise<PublishedPrivatePlan> {
  assertRequiredFilesystemAuthority();
  const filename = exactAbsolutePath(artifact.path);
  const bytes = canonicalPostgresReviewedPricePromotionJson(value);
  const byteCount = exactBufferLength(bytes, "plan_result_invalid");
  if (byteCount < 1 || byteCount > maximumBytes) fail("plan_result_invalid");
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
  const temporaryPath = exactAbsolutePath(artifact.temporaryPath);
  if (
    REFLECT_APPLY(PATH_DIRNAME, PATH_OBJECT, [temporaryPath]) !== parent
    || artifact.bytes !== byteCount
    || artifact.sha256 !== sha256
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
    let state:
      | "open"
      | "prepared"
      | "finalizing"
      | "failed"
      | "committed"
      | "rolled-back" =
      "open";
    let retainedHandleClosed = false;
    let retainedRollbackHandleClosed = false;
    let bytesWiped = false;
    const wipePlanBytes = (): void => {
      if (bytesWiped) return;
      wipeBytes(bytes);
      bytesWiped = true;
    };
    const validateExactPublishedArtifact = async (): Promise<boolean> => {
      let exact = true;
      let current: Buffer | null = null;
      const assertExactMetadata = async (): Promise<void> => {
        await authority.assertExact();
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
        ) fail("output_file_unsafe");
        await authority.assertExact();
      };
      try {
        await assertExactMetadata();
        current = await readExactDescriptor(
          retainedRollbackHandle,
          byteCount,
          "output_file_unsafe",
        );
        if (
          !exactBytesEqual(current, bytes)
          || sha256PostgresMigrationBytes(current) !== sha256
          || sha256PostgresMigrationBytes(bytes) !== sha256
        ) exact = false;
        await assertExactMetadata();
      } catch {
        exact = false;
      } finally {
        wipeBytes(current);
      }
      return exact;
    };
    const result: PublishedPrivatePlan = {
      sha256,
      identity,
      finalizeForCommit: async () => {
        if (state !== "prepared") fail("output_file_unsafe");
        const exact = await validateExactPublishedArtifact();
        state = exact ? "finalizing" : "failed";
        if (!exact) wipePlanBytes();
        if (!exact) fail("output_file_unsafe");
      },
      markCommitted: () => {
        if (state !== "finalizing") fail("output_file_unsafe");
        state = "committed";
        wipePlanBytes();
      },
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
      revalidateForCommit: async () => {
        if (state !== "finalizing") fail("output_file_unsafe");
        const exact = await validateExactPublishedArtifact();
        if (!exact) {
          state = "failed";
          wipePlanBytes();
          fail("output_file_unsafe");
        }
      },
      releaseCommittedHandle: async (releaseHandle) => {
        if (state !== "committed") fail("output_file_unsafe");
        if (retainedRollbackHandleClosed) return;
        let exact = true;
        let closeCallCount = 0;
        let closeResolved = false;
        let closeAuthorized = true;
        const close = async (): Promise<void> => {
          closeCallCount += 1;
          if (!closeAuthorized || closeCallCount !== 1) {
            fail("output_file_unsafe");
          }
          await capturedHandleClose(
            retainedRollbackHandle,
            "output_file_unsafe",
          );
          closeResolved = true;
        };
        try {
          if (releaseHandle) {
            await releaseHandle(temporaryPrefix, close);
          } else {
            await close();
          }
          if (closeCallCount !== 1 || !closeResolved) exact = false;
        } catch {
          exact = false;
        } finally {
          closeAuthorized = false;
        }
        if (closeResolved) retainedRollbackHandleClosed = true;
        if (!retainedRollbackHandleClosed) {
          try {
            await capturedHandleClose(
              retainedRollbackHandle,
              "output_file_unsafe",
            );
            retainedRollbackHandleClosed = true;
          } catch {
            // The first post-commit close failure remains authoritative. The
            // process boundary is the final best-effort release for an
            // ambiguously open descriptor.
          }
        }
        if (!exact) fail("output_file_unsafe");
      },
      rollback: async () => {
        if (state === "rolled-back") return;
        if (state === "committed") fail("output_file_unsafe");
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
            maximumBytes,
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
              maximumBytes,
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
          maximumBytes,
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

function writeNewPrivateCanonicalPlan(
  authority: PrivateParentAuthority,
  artifact: PublicationArtifactRecord,
  value: PostgresReviewedPricePromotionPlanCandidate,
): Promise<PublishedPrivatePlan> {
  return writeNewPrivateCanonicalArtifact(
    authority,
    artifact,
    value,
    MAX_PLAN_BYTES,
    "plan",
  );
}

function writeNewPrivateCanonicalReviewPacket(
  authority: PrivateParentAuthority,
  artifact: PublicationArtifactRecord,
  value: PostgresReviewedPricePromotionReviewPacket,
): Promise<PublishedPrivatePlan> {
  return writeNewPrivateCanonicalArtifact(
    authority,
    artifact,
    value,
    MAX_REVIEW_PACKET_BYTES,
    "review-packet",
  );
}

async function invalidateAndRemoveExactPublishedPlan(
  authority: PrivateParentAuthority,
  filename: string,
  expectedSha256: string,
  expectedIdentity: StableFileIdentity | null,
  expectedBytes: number,
  maximumBytes: number,
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
    if (
      !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [maximumBytes])
      || maximumBytes < 1
      || maximumBytes > MAX_REVIEW_PACKET_BYTES
      || expectedBytes < 1
      || expectedBytes > maximumBytes
    ) return false;

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

function reviewedPriceBoundTextSha256(label: string, value: string): string {
  return sha256PostgresMigrationBytes(
    `pintpath-reviewed-price-${label}-v1\0${value}`,
  );
}

function assertExactPlanBindings(input: {
  readonly authorityBundle: PostgresReviewedPricePromotionAuthorityBundle;
  readonly authorityBundleSha256: string;
  readonly artifacts: unknown;
  readonly candidateSha: string;
  readonly deployment: BuildPostgresReviewedPricePromotionPlanInput["expectedDeployment"];
  readonly migrationReceipt: PostgresMigrationReceipt;
  readonly migrationReceiptFileSha256: string;
  readonly migrationTargetIdentity: PostgresMigrationTargetIdentity;
  readonly privateInput: PostgresReviewedPricePromotionPrivateInput;
  readonly privateInputFileSha256: string;
  readonly physicalIdentitySha256: string;
  readonly plannerLoginIdentitySha256: string;
}): PostgresReviewedPricePromotionPlanArtifacts {
  if (input.artifacts === null || typeof input.artifacts !== "object") {
    fail("plan_result_invalid");
  }
  if (
    isProxy(input.artifacts)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [input.artifacts])
      !== OBJECT_PROTOTYPE
  ) fail("plan_result_invalid");
  const artifactKeys = REFLECT_OWN_KEYS(input.artifacts);
  if (
    artifactKeys.length !== 2
    || artifactKeys[0] !== "plan"
    || artifactKeys[1] !== "reviewPacket"
  ) fail("plan_result_invalid");
  const rawPlan = ownDataValue(input.artifacts, "plan", "plan_result_invalid");
  const rawReviewPacket = ownDataValue(
    input.artifacts,
    "reviewPacket",
    "plan_result_invalid",
  );
  const parsed = postgresReviewedPricePromotionPlanCandidateSchema.safeParse(rawPlan);
  const parsedPacket = postgresReviewedPricePromotionReviewPacketSchema.safeParse(
    rawReviewPacket,
  );
  if (!parsed.success || !parsedPacket.success) fail("plan_result_invalid");
  const plan = parsed.data;
  const reviewPacket = parsedPacket.data;
  const expectedDeployment = input.deployment;
  const authority = input.authorityBundle;
  const privateInput = input.privateInput;
  const migrationReceipt = input.migrationReceipt;
  const evidenceSetSha256 = sha256PostgresReviewedPricePromotionValue(
    privateInput.items,
  );
  const targetProfileSha256 = sha256PostgresReviewedPricePromotionValue(
    authority.targetProfile,
  );
  const expectedRoleSafetySha256 = sha256PostgresReviewedPricePromotionValue({
    authorityQuerySha256: sha256PostgresMigrationBytes(
      POSTGRES_REVIEWED_PRICE_PROMOTION_IDENTITY_QUERY,
    ),
    requiredColumnCount: 84,
    requiredRelationCount: 9,
    roleAuthorityValid: true,
    searchPathSchemas: ["pg_catalog"],
    transactionIsolation: "repeatable read",
    transactionReadOnly: true,
  });
  const expectedMigrationRunBindingSha256 = sha256PostgresMigrationRunBinding({
    approvalReferenceSha256: migrationReceipt.approvalReferenceSha256,
    candidateSha: migrationReceipt.candidateSha,
    contractSha256: migrationReceipt.contractSha256,
    expectedEnvironment: migrationReceipt.expectedEnvironment,
    manifestSha256: migrationReceipt.manifestSha256,
    operatorIdSha256: migrationReceipt.operatorIdSha256,
    planSha256: migrationReceipt.planSha256,
    sourceSchemaFingerprint: migrationReceipt.sourceSchemaFingerprint,
    sourceSchemaVersion: POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion,
    sourceSnapshotSha256: migrationReceipt.sourceSnapshotSha256,
    targetDdlSha256: migrationReceipt.targetDdlSha256,
    targetIdentitySha256: migrationReceipt.targetIdentitySha256,
    liveSchemaSha256: migrationReceipt.liveSchemaSha256,
    transportAuthoritySha256: migrationReceipt.transportAuthoritySha256,
    targetUrlSha256: migrationReceipt.targetUrlSha256,
    verifierIdSha256: migrationReceipt.verifierIdSha256,
    verifierAuthoritySha256: migrationReceipt.verifierAuthoritySha256,
    verifierAuthorityPolicySha256:
      migrationReceipt.verifierAuthorityPolicySha256,
    verifierPublicKeySha256: migrationReceipt.verifierPublicKeySha256,
  });
  const expectedMigrationSnapshotSha256 =
    sha256PostgresReviewedPricePromotionValue({
      approvalReferenceSha256: plan.migration.approvalReferenceSha256,
      candidateSha: plan.candidateSha,
      completedAt: plan.migration.completedAt,
      contractSha256: plan.migration.contractSha256,
      expectedEnvironment: plan.expectedEnvironment,
      failureCode: null,
      manifestSha256: plan.migration.manifestSha256,
      operatorIdSha256: plan.migration.operatorIdSha256,
      receiptSha256: plan.migration.receiptSha256,
      runId: plan.migration.runId,
      sourceSchemaFingerprint: plan.migration.sourceSchemaFingerprint,
      sourceSchemaVersion: plan.migration.sourceSchemaVersion,
      sourceSnapshotSha256: plan.migration.sourceSnapshotSha256,
      startedAt: plan.migration.startedAt,
      status: "ready",
      targetBindingSha256: plan.migration.targetBindingSha256,
      targetDdlSha256: plan.migration.targetDdlSha256,
      verifierIdSha256: plan.migration.verifierIdSha256,
    });
  let selectedRowCount = 0;
  let packetRowCount = 0;
  let sourceBindingsExact = plan.sourceSnapshot.items.length === privateInput.itemCount
    && reviewPacket.items.length === privateInput.itemCount;
  for (let index = 0; index < privateInput.itemCount; index += 1) {
    const privateItem = privateInput.items[index];
    const sourceItem = plan.sourceSnapshot.items[index];
    const packetItem = reviewPacket.items[index];
    if (!privateItem || !sourceItem || !packetItem) {
      sourceBindingsExact = false;
      break;
    }
    selectedRowCount += sourceItem.selectedRowCount;
    packetRowCount += packetItem.rows.length;
    if (
      sourceItem.sourceIngestionId !== privateItem.sourceIngestionId
      || sourceItem.venueIdSha256 !== privateItem.venueIdSha256
      || packetItem.sourceIngestionId !== privateItem.sourceIngestionId
      || packetItem.evidenceContentSha256 !== privateItem.evidenceContentSha256
      || packetItem.evidenceReferenceSha256 !== privateItem.evidenceReferenceSha256
      || packetItem.evidenceReference
        !== `source-ingestion:${privateItem.sourceIngestionId}`
      || sha256PostgresReviewedPricePromotionIdentity(
        "evidence-reference",
        packetItem.evidenceReference,
      ) !== privateItem.evidenceReferenceSha256
      || sha256PostgresReviewedPricePromotionIdentity(
        "venue-id",
        packetItem.venue.id,
      ) !== privateItem.venueIdSha256
      || packetItem.rows.length !== sourceItem.selectedRowCount
    ) sourceBindingsExact = false;
    for (let rowIndex = 0; rowIndex < packetItem.rows.length; rowIndex += 1) {
      const row = packetItem.rows[rowIndex];
      if (
        !row
        || row.ordinal !== rowIndex
        || row.priceRecord.sourceIngestionId !== privateItem.sourceIngestionId
        || row.venueBeer.sourceIngestionId !== privateItem.sourceIngestionId
        || row.priceRecord.venueId !== packetItem.venue.id
        || row.venueBeer.venueId !== packetItem.venue.id
      ) sourceBindingsExact = false;
    }
  }
  const wrongPrices = plan.sourceSnapshot.wrongPriceReports;
  const emptyConflictRowsSha256 = sha256PostgresReviewedPricePromotionValue([]);
  const sourceSnapshotWithoutCombined = {
    items: plan.sourceSnapshot.items,
    publicConflicts: plan.sourceSnapshot.publicConflicts,
    selectionPolicySha256: plan.sourceSnapshot.selectionPolicySha256,
    wrongPriceReports: plan.sourceSnapshot.wrongPriceReports,
  };
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
    || migrationReceipt.candidateSha !== input.candidateSha
    || migrationReceipt.expectedEnvironment !== "permanent-staging"
    || migrationReceipt.contractSha256
      !== sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT)
    || migrationReceipt.sourceSchemaFingerprint
      !== POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint
    || migrationReceipt.tableCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
    || migrationReceipt.columnCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns
    || migrationReceipt.foreignKeyCount
      !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys
    || migrationReceipt.runBindingSha256 !== expectedMigrationRunBindingSha256
    || migrationReceipt.runIdSha256
      !== derivePostgresMigrationRunId(expectedMigrationRunBindingSha256)
    || plan.privateInput.manifestSha256 !== input.privateInputFileSha256
    || plan.privateInput.itemCount !== privateInput.itemCount
    || plan.privateInput.marketedSuburb !== privateInput.marketedSuburb
    || plan.privateInput.evidenceSetSha256 !== evidenceSetSha256
    || !sourceBindingsExact
    || plan.authority.authorityBundleSha256 !== input.authorityBundleSha256
    || plan.authority.generatedAt !== input.authorityBundle.generatedAt
    || plan.authority.expiresAt !== input.authorityBundle.expiresAt
    || plan.authority.authorityMode !== authority.authorityMode
    || plan.authority.mutationAuthorized !== authority.mutationAuthorized
    || plan.authority.providerAuthorityObserved !== authority.providerAuthorityObserved
    || plan.authority.evidenceReferencesSha256
      !== sha256PostgresReviewedPricePromotionValue(authority.evidenceReferences)
    || plan.authority.recoveryReferencesSha256
      !== sha256PostgresReviewedPricePromotionValue(authority.recoveryReferences)
    || plan.authority.reviewBindingsSha256
      !== sha256PostgresReviewedPricePromotionValue(authority.reviewBindings)
    || plan.authority.targetProfileSha256 !== targetProfileSha256
    || plan.authority.supabaseProjectIdentitySha256
      !== input.authorityBundle.targetProfile.supabaseProjectIdentitySha256
    || plan.target.physicalIdentitySha256 !== input.physicalIdentitySha256
    || plan.target.plannerLoginIdentitySha256 !== input.plannerLoginIdentitySha256
    || plan.target.catalogIdentity.currentUserSha256
      !== reviewedPriceBoundTextSha256("postgres-current-user", PLANNER_ROLE)
    || plan.target.catalogIdentity.sessionUserSha256
      !== reviewedPriceBoundTextSha256("postgres-session-user", PLANNER_ROLE)
    || plan.target.catalogIdentity.databaseNameSha256
      !== reviewedPriceBoundTextSha256(
        "postgres-database-name",
        input.migrationTargetIdentity.databaseName,
      )
    || plan.target.catalogIdentity.databaseOidSha256
      !== reviewedPriceBoundTextSha256(
        "postgres-database-oid",
        input.migrationTargetIdentity.databaseOid,
      )
    || plan.target.catalogIdentity.serverVersionNum
      !== input.migrationTargetIdentity.serverVersionNum
    || plan.target.catalogIdentity.systemIdentifierSha256
      !== reviewedPriceBoundTextSha256(
        "postgres-system-identifier",
        input.migrationTargetIdentity.systemIdentifier,
      )
    || plan.target.catalogIdentity.roleSafetySha256 !== expectedRoleSafetySha256
    || plan.migration.approvalReferenceSha256
      !== migrationReceipt.approvalReferenceSha256
    || plan.migration.contractSha256 !== migrationReceipt.contractSha256
    || plan.migration.manifestSha256 !== migrationReceipt.manifestSha256
    || plan.migration.operatorIdSha256 !== migrationReceipt.operatorIdSha256
    || plan.migration.planSha256 !== migrationReceipt.planSha256
    || plan.migration.receiptSha256 !== migrationReceipt.receiptSha256
    || plan.migration.runId !== migrationReceipt.runIdSha256
    || plan.migration.schemaMetadataSha256 !== migrationReceipt.schemaMetadataSha256
    || plan.migration.sourceSchemaFingerprint
      !== migrationReceipt.sourceSchemaFingerprint
    || plan.migration.sourceSchemaSha256
      !== POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256
    || plan.migration.sourceSchemaVersion
      !== POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion
    || plan.migration.sourceSnapshotSha256
      !== migrationReceipt.sourceSnapshotSha256
    || plan.migration.runSnapshotSha256 !== expectedMigrationSnapshotSha256
    || plan.migration.targetBindingSha256
      !== migrationReceipt.runBindingSha256
    || plan.migration.targetDdlSha256 !== migrationReceipt.targetDdlSha256
    || plan.migration.verifierIdSha256 !== migrationReceipt.verifierIdSha256
    || sha256PostgresMigrationTargetIdentity(input.migrationTargetIdentity)
      !== migrationReceipt.targetIdentitySha256
    || plan.mutationEnabled !== false
    || !activationBlockersExact(plan.activationBlockers)
    || plan.sourceSnapshot.selectionPolicySha256
      !== REVIEWED_PRICE_SELECTION_POLICY_SHA256
    || plan.sourceSnapshot.combinedSha256
      !== sha256PostgresReviewedPricePromotionValue(sourceSnapshotWithoutCombined)
    || plan.sourceSnapshot.publicConflicts.priceRecordCount !== 0
    || plan.sourceSnapshot.publicConflicts.venueBeerCount !== 0
    || plan.sourceSnapshot.publicConflicts.rowsSha256
      !== emptyConflictRowsSha256
    || wrongPrices.policySha256 !== REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256
    || wrongPrices.blockingStatuses[0]
      !== REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES[0]
    || wrongPrices.blockingStatuses[1]
      !== REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES[1]
    || wrongPrices.blockingCount !== 0
    || wrongPrices.openOrInProgressCount !== 0
    || wrongPrices.blockingCount !== wrongPrices.openOrInProgressCount
    || (wrongPrices.totalCount === 0)
      !== (wrongPrices.rowsSha256 === emptyConflictRowsSha256)
    || wrongPrices.totalCount !== (
      wrongPrices.openOrInProgressCount
        + wrongPrices.rejectedCount
        + wrongPrices.resolvedCount
    )
    || reviewPacket.authorityBundleSha256 !== input.authorityBundleSha256
    || reviewPacket.candidateSha !== input.candidateSha
    || reviewPacket.expectedEnvironment !== "permanent-staging"
    || reviewPacket.privateInputManifestSha256 !== input.privateInputFileSha256
    || reviewPacket.marketedSuburb !== privateInput.marketedSuburb
    || reviewPacket.generatedAt !== authority.generatedAt
    || reviewPacket.expiresAt !== authority.expiresAt
    || reviewPacket.targetPhysicalIdentitySha256 !== input.physicalIdentitySha256
    || reviewPacket.targetProfileSha256 !== targetProfileSha256
    || reviewPacket.wrongPricePolicySha256
      !== REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256
    || reviewPacket.sourceSnapshotSha256 !== plan.sourceSnapshot.combinedSha256
    || reviewPacket.reviewPacketCandidateSha256
      !== plan.reviewPacket.reviewPacketCandidateSha256
    || reviewPacket.itemCount !== plan.reviewPacket.itemCount
    || reviewPacket.rowCount !== plan.reviewPacket.rowCount
    || reviewPacket.itemCount !== privateInput.itemCount
    || reviewPacket.rowCount !== packetRowCount
    || reviewPacket.rowCount !== selectedRowCount
    || reviewPacket.mutationEnabled !== false
  ) fail("plan_result_invalid");
  return OBJECT_FREEZE({ plan, reviewPacket });
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
  let retainedAuthorityBundle:
    PostgresReviewedPricePromotionAuthorityBundle | null = null;
  let plan: PostgresReviewedPricePromotionPlanCandidate | null = null;
  let reviewPacket: PostgresReviewedPricePromotionReviewPacket | null = null;
  let outputPlan = "";
  let outputReviewPacket = "";
  let publicationPaths: PublicationJournalPaths | null = null;
  let publicationInvocationBindingSha256: string | null = null;
  let preparedPublicationJournal: PreparedPublicationJournal | null = null;
  let publicationJournalPrepared = false;
  let successSummary: PostgresReviewedPricePromotionSuccessSummary | null = null;
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
    const authorityBundlePath = exactAbsolutePath(args.authorityBundle);
    outputPlan = exactAbsolutePath(args.outputPlan);
    outputReviewPacket = exactAbsolutePath(args.outputReviewPacket);
    publicationPaths = publicationJournalPaths(outputPlan, outputReviewPacket);
    if (!exactDistinctPaths([
      deploymentAttestationPath,
      plannerUrlPath,
      migrationReceiptPath,
      migrationTargetIdentityPath,
      privateInputPath,
      authorityBundlePath,
      outputPlan,
      outputReviewPacket,
      publicationPaths.journal,
      publicationPaths.prepare,
      publicationPaths.commit,
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
      authorityBundlePath,
      outputPlan,
      outputReviewPacket,
      publicationPaths.journal,
      publicationPaths.prepare,
      publicationPaths.commit,
    ], commonParent)) {
      fail("artifact_file_unsafe");
    }
    publicationInvocationBindingSha256 = publicationInvocationSha256({
      args,
      authorityBundle: authorityBundlePath,
      deploymentAttestation: deploymentAttestationPath,
      expectedRootCaDerSha256: dependencies.expectedRootCaDerSha256,
      migrationReceipt: migrationReceiptPath,
      migrationTargetIdentity: migrationTargetIdentityPath,
      outputPlan,
      outputReviewPacket,
      plannerUrlFile: plannerUrlPath,
      privateInput: privateInputPath,
    });
    parentAuthority = await openPrivateParentAuthority(commonParent);
    const recoveredSummary = await reconcilePublicationJournal({
      authority: parentAuthority,
      candidateSha,
      expectedInvocationSha256: publicationInvocationBindingSha256,
      expectedPhysicalIdentitySha256:
        exactSha256(args.expectedTargetDatabaseIdentitySha256),
      outputPlan,
      outputReviewPacket,
      paths: publicationPaths,
    });
    if (recoveredSummary) {
      await parentAuthority.close();
      parentAuthority = null;
      writeSummary(dependencies, recoveredSummary);
      return 0;
    }

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
        authorityBundlePath,
        outputPlan,
        outputReviewPacket,
        publicationPaths.journal,
        publicationPaths.prepare,
        publicationPaths.commit,
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
    const authorityBundleFile = await openHeldPrivateFile(
      parentAuthority,
      authorityBundlePath,
      MAX_AUTHORITY_BUNDLE_BYTES,
    );
    retainHeldFile(authorityBundleFile);
    const authorityBundle = await readCanonicalJsonArtifact({
      held: authorityBundleFile,
      expectedSha256: exactSha256(args.authorityBundleSha256),
      parse: (value) => postgresReviewedPricePromotionAuthorityBundleSchema.safeParse(value),
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
      || authorityBundle.value.candidateSha !== candidateSha
      || authorityBundle.value.expectedEnvironment !== "permanent-staging"
      || authorityBundle.value.privateInputManifestSha256 !== privateInput.sha256
      || authorityBundle.value.targetProfile.deploymentAttestationFileSha256
        !== deploymentAttestationFile.sha256
      || authorityBundle.value.targetProfile.physicalDatabaseIdentitySha256
        !== expectedPhysicalDatabaseIdentitySha256
      || authorityBundle.value.targetProfile.railwayEnvironmentIdSha256
        !== deployment.environmentIdSha256
      || authorityBundle.value.targetProfile.railwayProjectIdSha256
        !== deployment.projectIdSha256
      || authorityBundle.value.targetProfile.railwayServiceIdSha256
        !== deployment.serviceIdSha256
      || !postgresReviewedPricePromotionAuthorityBundleFreshAt(
        authorityBundle.value,
        dependencies.now(),
      )
    ) fail("artifact_invalid");
    retainedAuthorityBundle = authorityBundle.value;
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
      authorityBundle: authorityBundle.value,
      candidateSha,
      database: databaseHandle.database,
      expectedDeployment: deployment,
      expectedEnvironment: "permanent-staging",
      expectedMigration: { receiptFileSha256: migrationReceipt.sha256 },
      expectedAuthorityBundleSha256: authorityBundle.sha256,
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
    const exactArtifacts = assertExactPlanBindings({
      artifacts: candidate,
      authorityBundle: authorityBundle.value,
      authorityBundleSha256: authorityBundle.sha256,
      candidateSha,
      deployment,
      migrationReceipt: migrationReceipt.value,
      migrationReceiptFileSha256: migrationReceipt.sha256,
      migrationTargetIdentity: migrationTargetIdentity.value,
      privateInput: privateInput.value,
      privateInputFileSha256: privateInput.sha256,
      physicalIdentitySha256: expectedPhysicalDatabaseIdentitySha256,
      plannerLoginIdentitySha256: expectedPlannerLoginIdentitySha256,
    });
    plan = exactArtifacts.plan;
    reviewPacket = exactArtifacts.reviewPacket;
  } catch (error) {
    failureCode = safeFailureCode(error);
    plan = null;
    reviewPacket = null;
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
        reviewPacket = null;
      }
    }
    try {
      await databaseHandle.assertExact();
    } catch {
      failureCode = "database_release_failed";
      plan = null;
      reviewPacket = null;
    }
    try {
      await databaseHandle.release();
    } catch {
      failureCode = "database_release_failed";
      plan = null;
      reviewPacket = null;
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
        reviewPacket = null;
      }
    }
  }

  let publishedPlan: PublishedPrivatePlan | null = null;
  let publishedReviewPacket: PublishedPrivatePlan | null = null;
  let artifactsCommitted = false;
  let planFileSha256: string | null = null;
  let reviewPacketFileSha256: string | null = null;
  if (
    plan
    && reviewPacket
    && !failureCode
    && parentAuthority
    && rootCaFile
    && publicationPaths
    && publicationInvocationBindingSha256
    && summaryInput
  ) {
    try {
      if (
        !retainedDeploymentAttestation
        || !retainedAuthorityBundle
        || !railwayApplicationDeploymentAttestationReceiptFreshAt(
          retainedDeploymentAttestation,
          dependencies.now(),
        )
        || !postgresReviewedPricePromotionAuthorityBundleFreshAt(
          retainedAuthorityBundle,
          dependencies.now(),
        )
      ) fail("artifact_invalid");
      await assertHeldAuthorityExact({
        authority: parentAuthority,
        files: heldFiles,
        rootCa: rootCaFile,
        expectedRootCaDerSha256: dependencies.expectedRootCaDerSha256,
      });
      const reviewPacketArtifact = describePublicationArtifact(
        outputReviewPacket,
        publicationTemporaryPath(parentAuthority.path, "review-packet"),
        reviewPacket,
        MAX_REVIEW_PACKET_BYTES,
      );
      const planArtifact = describePublicationArtifact(
        outputPlan,
        publicationTemporaryPath(parentAuthority.path, "plan"),
        plan,
        MAX_PLAN_BYTES,
      );
      if (!exactDistinctPaths([
        publicationPaths.journal,
        publicationPaths.prepare,
        publicationPaths.commit,
        outputPlan,
        outputReviewPacket,
        planArtifact.temporaryPath,
        reviewPacketArtifact.temporaryPath,
      ])) fail("output_file_unsafe");
      successSummary = OBJECT_FREEZE({
        activationBlockerCount: plan.activationBlockers.length,
        candidateSha: summaryInput.candidateSha,
        command: POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND,
        expectedEnvironment: summaryInput.expectedEnvironment,
        itemCount: summaryInput.itemCount,
        mutationEnabled: false,
        ok: true,
        planCandidateSha256: plan.planCandidateSha256,
        planFileSha256: planArtifact.sha256,
        physicalIdentitySha256: summaryInput.physicalIdentitySha256,
        plannerLoginIdentitySha256: summaryInput.plannerLoginIdentitySha256,
        reviewPacketCandidateSha256: reviewPacket.reviewPacketCandidateSha256,
        reviewPacketFileSha256: reviewPacketArtifact.sha256,
        rowCount: reviewPacket.rowCount,
      });
      preparedPublicationJournal = OBJECT_FREEZE({
        artifacts: OBJECT_FREEZE({
          plan: planArtifact,
          reviewPacket: reviewPacketArtifact,
        }),
        invocationSha256: publicationInvocationBindingSha256,
        kind: "pintpath-postgres-reviewed-price-promotion-publication",
        outputPlan,
        outputReviewPacket,
        processId: PROCESS_PID,
        state: "prepared",
        summary: successSummary,
        version: 1,
      });
      await writePreparedPublicationJournal({
        authority: parentAuthority,
        journal: preparedPublicationJournal,
        paths: publicationPaths,
      });
      registerActivePublicationJournal(publicationPaths.journal);
      publicationJournalPrepared = true;
      publishedReviewPacket = await writeNewPrivateCanonicalReviewPacket(
        parentAuthority,
        reviewPacketArtifact,
        reviewPacket,
      );
      reviewPacketFileSha256 = publishedReviewPacket.sha256;
      assertPublicationBoundary(
        dependencies.assertPublicationBoundary,
        "review-packet-published",
      );
      publishedPlan = await writeNewPrivateCanonicalPlan(
        parentAuthority,
        planArtifact,
        plan,
      );
      planFileSha256 = publishedPlan.sha256;
      assertPublicationBoundary(
        dependencies.assertPublicationBoundary,
        "plan-published",
      );
      await assertHeldAuthorityExact({
        authority: parentAuthority,
        files: heldFiles,
        rootCa: rootCaFile,
        expectedRootCaDerSha256: dependencies.expectedRootCaDerSha256,
      });
      if (!railwayApplicationDeploymentAttestationReceiptFreshAt(
        retainedDeploymentAttestation,
        dependencies.now(),
      ) || !postgresReviewedPricePromotionAuthorityBundleFreshAt(
        retainedAuthorityBundle,
        dependencies.now(),
      )) fail("artifact_invalid");
    } catch (error) {
      failureCode = safeFailureCode(error);
      plan = null;
      reviewPacket = null;
    }
  }

  const heldFilesClosed = await closeHeldPrivateFiles({
    files: heldFiles,
  });
  if (!heldFilesClosed) {
    failureCode = "artifact_file_unsafe";
    plan = null;
    reviewPacket = null;
  }

  if (publishedReviewPacket && publishedPlan && plan && reviewPacket && !failureCode) {
    try {
      await publishedReviewPacket.prepareForSummary();
      await publishedPlan.prepareForSummary();
    } catch {
      failureCode = "output_file_unsafe";
      plan = null;
      reviewPacket = null;
    }
  }
  if (
    publishedReviewPacket
    && publishedPlan
    && plan
    && reviewPacket
    && !failureCode
    && parentAuthority
    && preparedPublicationJournal
    && publicationPaths
  ) {
    try {
      const commitAuthority = parentAuthority;
      const exactPreparedPublicationJournal = preparedPublicationJournal;
      const committedPublicationJournal: CommittedPublicationJournal =
        OBJECT_FREEZE({
          artifacts: OBJECT_FREEZE({
            plan: OBJECT_FREEZE({
              ...exactPreparedPublicationJournal.artifacts.plan,
              identity: serializeStableFileIdentity(publishedPlan.identity),
            }),
            reviewPacket: OBJECT_FREEZE({
              ...exactPreparedPublicationJournal.artifacts.reviewPacket,
              identity: serializeStableFileIdentity(
                publishedReviewPacket.identity,
              ),
            }),
          }),
          invocationSha256: exactPreparedPublicationJournal.invocationSha256,
          kind: exactPreparedPublicationJournal.kind,
          outputPlan: exactPreparedPublicationJournal.outputPlan,
          outputReviewPacket: exactPreparedPublicationJournal.outputReviewPacket,
          processId: exactPreparedPublicationJournal.processId,
          state: "committed",
          summary: exactPreparedPublicationJournal.summary,
          version: 1,
        });
      const committedHandleCleanupExact = await commitPublishedArtifactPair({
        assertPublicationBoundary: dependencies.assertPublicationBoundary,
        commitJournal: (markCommitted) => writeCommittedPublicationJournal({
          authority: commitAuthority,
          committed: committedPublicationJournal,
          markCommitted,
          paths: publicationPaths,
          prepared: exactPreparedPublicationJournal,
        }),
        plan: publishedPlan,
        releasePublishedArtifactHandle:
          dependencies.releasePublishedArtifactHandle,
        reviewPacket: publishedReviewPacket,
      });
      artifactsCommitted = true;
      if (!committedHandleCleanupExact) failureCode = "output_file_unsafe";
    } catch {
      failureCode = "output_file_unsafe";
      plan = null;
      reviewPacket = null;
    }
  }
  if (!artifactsCommitted && publishedPlan && (!plan || !reviewPacket || failureCode)) {
    try {
      await publishedPlan.rollback();
    } catch {
      failureCode = "output_file_unsafe";
    }
    publishedPlan = null;
    planFileSha256 = null;
  }
  if (
    !artifactsCommitted
    && publishedReviewPacket
    && (!plan || !reviewPacket || failureCode)
  ) {
    try {
      await publishedReviewPacket.rollback();
    } catch {
      failureCode = "output_file_unsafe";
    }
    publishedReviewPacket = null;
    reviewPacketFileSha256 = null;
  }

  if (
    !artifactsCommitted
    && publicationJournalPrepared
    && parentAuthority
    && preparedPublicationJournal
    && publicationPaths
  ) {
    try {
      await reconcilePublicationJournal({
        allowActiveProcess: true,
        authority: parentAuthority,
        candidateSha: preparedPublicationJournal.summary.candidateSha,
        expectedInvocationSha256:
          preparedPublicationJournal.invocationSha256,
        expectedPhysicalIdentitySha256:
          preparedPublicationJournal.summary.physicalIdentitySha256,
        outputPlan,
        outputReviewPacket,
        paths: publicationPaths,
      });
      publicationJournalPrepared = false;
      preparedPublicationJournal = null;
      unregisterActivePublicationJournal(publicationPaths.journal);
    } catch {
      failureCode = "output_file_unsafe";
    }
  }

  if (
    artifactsCommitted
    && publicationJournalPrepared
    && publicationPaths
  ) {
    try {
      unregisterActivePublicationJournal(publicationPaths.journal);
      publicationJournalPrepared = false;
      preparedPublicationJournal = null;
    } catch {
      failureCode = "output_file_unsafe";
    }
  }

  if (parentAuthority) {
    try {
      await parentAuthority.close();
    } catch {
      failureCode = "artifact_file_unsafe";
    }
    parentAuthority = null;
  }

  try {
    if (
      !plan
      || !reviewPacket
      || !planFileSha256
      || !reviewPacketFileSha256
      || !summaryInput
      || !successSummary
      || !publishedPlan
      || !publishedReviewPacket
      || !artifactsCommitted
      || failureCode
    ) {
      writeSummary(dependencies, {
        command: POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND,
        failureCode: failureCode ?? "unexpected_failure",
        ok: false,
      });
      return 1;
    }
    writeSummary(dependencies, successSummary);
    publishedReviewPacket = null;
    publishedPlan = null;
    return 0;
  } catch {
    let finalFailureCode: PostgresReviewedPricePromotionCliFailureCode =
      artifactsCommitted ? "output_file_unsafe" : "unexpected_failure";
    if (!artifactsCommitted && publishedPlan) {
      try {
        await publishedPlan.rollback();
      } catch {
        finalFailureCode = "output_file_unsafe";
      }
    }
    if (!artifactsCommitted && publishedReviewPacket) {
      try {
        await publishedReviewPacket.rollback();
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
  MAX_PUBLICATION_JOURNAL_BYTES,
  publicationJournalPath: (
    outputPlan: string,
    outputReviewPacket: string,
  ) => publicationJournalPaths(outputPlan, outputReviewPacket).journal,
});
