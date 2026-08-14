import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_POSTGRES_AUTHORITATIVE_TABLES,
  checkPostgresRuntimeReadiness,
  type PostgresRuntimeFailureCode,
  type PostgresRuntimeReadiness,
} from "../src/db/postgres-runtime.js";
import {
  createPostgresDatabase,
  type PostgresDatabaseOptions,
  type SqlDatabase,
  type SqlPoolMetrics,
} from "../src/db/sql-database.js";
import {
  assertPostgresRailwayStockLocalhostRootCaPem,
  openPostgresRailwayStockLocalhostCaTransportFromPem,
  parsePostgresRailwayStockLocalhostCaUrl,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  type OpenPostgresRailwayStockLocalhostCaTransportFromPemOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

export const POSTGRES_RUNTIME_VERIFIER_POOL_OPTIONS = Object.freeze({
  applicationName: "pintpath-runtime-verifier",
  maxConnections: 1,
  idleTimeoutMs: 5_000,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 15_000,
  idleInTransactionTimeoutMs: 10_000,
});

export type PostgresRuntimeVerifierFailureCode =
  | "database_authority_missing_or_unsafe"
  | "transport_initialization_failed"
  | "transport_verification_failed"
  | "adapter_initialization_failed"
  | "verification_failed"
  | "runtime_not_ready"
  | "close_failed";

export interface PostgresRuntimeVerifierReport {
  schemaVersion: 1;
  ready: boolean;
  failureCode: PostgresRuntimeVerifierFailureCode | null;
  readiness: PostgresRuntimeReadiness | null;
}

export interface PostgresRuntimeVerifierDependencies {
  env: Readonly<Record<string, string | undefined>>;
  getUid: () => number | null;
  now: () => Date;
  openPostgresRuntimeTransport: (
    options: OpenPostgresRailwayStockLocalhostCaTransportFromPemOptions,
  ) => Promise<PostgresRailwayStockLocalhostCaTransport>;
  createDatabase: (options: PostgresDatabaseOptions) => SqlDatabase;
  checkReadiness: (database: SqlDatabase) => Promise<PostgresRuntimeReadiness>;
  writeOutput: (output: string) => void;
}

const POSTGRES_RUNTIME_FAILURE_CODES = new Set<PostgresRuntimeFailureCode>([
  "not_postgres",
  "runtime_role_unsafe",
  "search_path_unsafe",
  "schema_version_unsupported",
  "import_not_ready",
  "authoritative_table_count_mismatch",
  "operations_schema_accessible",
  "application_schema_exposed",
  "catalog_check_failed",
]);

const DEFAULT_DEPENDENCIES: PostgresRuntimeVerifierDependencies = {
  env: process.env,
  getUid: () => process.getuid?.() ?? null,
  now: () => new Date(),
  openPostgresRuntimeTransport: (options) => (
    openPostgresRailwayStockLocalhostCaTransportFromPem(options)
  ),
  createDatabase: createPostgresDatabase,
  checkReadiness: checkPostgresRuntimeReadiness,
  writeOutput: (output) => process.stdout.write(output),
};

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function safeNullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function safeDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function sanitizePoolMetrics(value: SqlPoolMetrics): SqlPoolMetrics {
  return {
    dialect: value.dialect === "postgres" ? "postgres" : "sqlite",
    totalConnections: safeInteger(value.totalConnections),
    idleConnections: safeInteger(value.idleConnections),
    waitingRequests: safeInteger(value.waitingRequests),
    completedQueries: safeInteger(value.completedQueries),
    failedQueries: safeInteger(value.failedQueries),
    transactionFailures: safeInteger(value.transactionFailures),
    lastQueryDurationMs: safeDuration(value.lastQueryDurationMs),
  };
}

function sanitizeReadiness(value: PostgresRuntimeReadiness): PostgresRuntimeReadiness {
  const failures = Array.isArray(value.failures)
    ? value.failures.filter((failure): failure is PostgresRuntimeFailureCode => (
      typeof failure === "string"
      && POSTGRES_RUNTIME_FAILURE_CODES.has(failure as PostgresRuntimeFailureCode)
    ))
    : [];
  const hasUnknownFailure = !Array.isArray(value.failures)
    || failures.length !== value.failures.length;
  const checks = {
    dialect: value.checks?.dialect === true,
    runtimeRole: value.checks?.runtimeRole === true,
    searchPath: value.checks?.searchPath === true,
    schemaVersion: value.checks?.schemaVersion === true,
    importReady: value.checks?.importReady === true,
    authoritativeTables: value.checks?.authoritativeTables === true,
    operationsIsolation: value.checks?.operationsIsolation === true,
    applicationSchemaIsolation: value.checks?.applicationSchemaIsolation === true,
  };
  const pool = sanitizePoolMetrics(value.metrics?.pool ?? {
    dialect: "sqlite",
    totalConnections: 0,
    idleConnections: 0,
    waitingRequests: 0,
    completedQueries: 0,
    failedQueries: 0,
    transactionFailures: 0,
    lastQueryDurationMs: null,
  });
  const schemaVersion = value.metrics?.schemaVersion === "supported"
    ? "supported"
    : value.metrics?.schemaVersion === "unsupported" ? "unsupported" : "unavailable";
  const importState = value.metrics?.importState === "ready"
    ? "ready"
    : value.metrics?.importState === "not-ready" ? "not-ready" : "unavailable";
  const authoritativeTableCount = safeNullableInteger(
    value.metrics?.authoritativeTableCount,
  );
  const fullyReady = value.ready === true
    && Object.values(checks).every(Boolean)
    && failures.length === 0
    && !hasUnknownFailure
    && schemaVersion === "supported"
    && importState === "ready"
    && authoritativeTableCount === EXPECTED_POSTGRES_AUTHORITATIVE_TABLES
    && pool.dialect === "postgres";

  return {
    ready: fullyReady,
    checks,
    failures,
    metrics: {
      schemaVersion,
      importState,
      authoritativeTableCount,
      expectedAuthoritativeTableCount: EXPECTED_POSTGRES_AUTHORITATIVE_TABLES,
      pool,
    },
  };
}

function report(
  readiness: PostgresRuntimeReadiness | null,
  failureCode: PostgresRuntimeVerifierFailureCode | null,
): PostgresRuntimeVerifierReport {
  return {
    schemaVersion: 1,
    ready: readiness?.ready === true && failureCode === null,
    failureCode,
    readiness,
  };
}

function writeReport(
  dependencies: PostgresRuntimeVerifierDependencies,
  value: PostgresRuntimeVerifierReport,
): void {
  dependencies.writeOutput(`${JSON.stringify(value)}\n`);
}

export async function runPostgresRuntimeVerifier(
  overrides: Partial<PostgresRuntimeVerifierDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresRuntimeVerifierDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  const connectionString = dependencies.env.DATABASE_URL ?? "";
  const rootCaPem = dependencies.env.PINTPATH_POSTGRES_ROOT_CA_PEM ?? "";
  const rootCaDerSha256 = dependencies.env
    .PINTPATH_POSTGRES_ROOT_CA_DER_SHA256?.trim().toLowerCase() ?? "";
  let parsedUrl;
  let uid: number | null;
  try {
    parsedUrl = parsePostgresRailwayStockLocalhostCaUrl(connectionString);
    assertPostgresRailwayStockLocalhostRootCaPem(
      rootCaPem,
      rootCaDerSha256,
      dependencies.now(),
    );
    uid = dependencies.getUid();
    if (!Number.isSafeInteger(uid) || uid === null || uid < 0) {
      throw new Error("invalid_uid");
    }
  } catch {
    writeReport(
      dependencies,
      report(null, "database_authority_missing_or_unsafe"),
    );
    return 1;
  }

  let database: SqlDatabase | null = null;
  let transport: PostgresRailwayStockLocalhostCaTransport | null = null;
  let readiness: PostgresRuntimeReadiness | null = null;
  let failureCode: PostgresRuntimeVerifierFailureCode | null = null;
  try {
    try {
      transport = await dependencies.openPostgresRuntimeTransport({
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaPem,
        expectedRootCaDerSha256: rootCaDerSha256,
        expectedUid: uid,
        sourceUrlAuthority: parsedUrl.sourceUrlAuthority,
      });
      await transport.assertExact();
    } catch {
      failureCode = "transport_initialization_failed";
    }

    if (transport && !failureCode) {
      try {
        database = dependencies.createDatabase({
          connectionString: parsedUrl.connectionString,
          activeRole: "pintpath_runtime",
          railwayStockLocalhostCaConnection: transport.nodeConnection,
          ...POSTGRES_RUNTIME_VERIFIER_POOL_OPTIONS,
        });
      } catch {
        failureCode = "adapter_initialization_failed";
      }
    }

    if (database && transport && !failureCode) {
      try {
        await transport.assertExact();
      } catch {
        failureCode = "transport_verification_failed";
      }
    }

    if (database && transport && !failureCode) {
      try {
        readiness = sanitizeReadiness(await dependencies.checkReadiness(database));
        if (!readiness.ready) failureCode = "runtime_not_ready";
      } catch {
        failureCode = "verification_failed";
      }
      try {
        await transport.assertExact();
      } catch {
        failureCode = "transport_verification_failed";
      }
    }
  } finally {
    let closeFailed = false;
    if (transport) {
      try {
        await transport.assertExact();
      } catch {
        failureCode = "transport_verification_failed";
      }
    }
    if (database) {
      try {
        await database.close();
      } catch {
        closeFailed = true;
      }
    }
    if (transport) {
      try {
        await transport.assertExact();
      } catch {
        failureCode = "transport_verification_failed";
      }
      try {
        await transport.close();
      } catch {
        closeFailed = true;
      }
    }
    if (closeFailed) failureCode = "close_failed";
  }

  const result = report(readiness, failureCode);
  writeReport(dependencies, result);
  return result.ready ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    // The CLI is an operator surface, so validate the full environment and
    // identity-registry contract before constructing even the one-connection
    // verifier adapter. The injectable unit API above intentionally remains
    // independent for deterministic adapter/readiness tests.
    await import("../src/config/env.js");
    process.exitCode = await runPostgresRuntimeVerifier();
  } catch {
    process.stdout.write(`${JSON.stringify(report(null, "verification_failed"))}\n`);
    process.exitCode = 1;
  }
}
