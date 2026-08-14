import fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  POSTGRES_RUNTIME_VERIFIER_POOL_OPTIONS,
  runPostgresRuntimeVerifier,
  type PostgresRuntimeVerifierDependencies,
  type PostgresRuntimeVerifierReport,
} from "../scripts/verify-postgres-runtime.js";
import type { PostgresRuntimeReadiness } from "../src/db/postgres-runtime.js";
import type {
  PostgresDatabaseOptions,
  SqlDatabase,
  SqlPoolMetrics,
  SqlStatement,
} from "../src/db/sql-database.js";
import type {
  OpenPostgresRailwayStockLocalhostCaTransportFromPemOptions,
  PostgresRailwayStockLocalhostCaNodeConnection,
  PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import {
  TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
  TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
} from "./postgres-railway-stock-localhost-ca.fixtures.js";

const tlsDatabaseUrl = "postgresql://runtime:do-not-print@pintpath-postgres.railway.internal:5432/pintpath?sslmode=verify-full";
const fakeNodeConnection = Object.freeze({
  host: "fd12::1",
  port: 5_432,
  ssl: Object.freeze({}),
}) as unknown as PostgresRailwayStockLocalhostCaNodeConnection;

function runtimeEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    DATABASE_URL: tlsDatabaseUrl,
    PINTPATH_POSTGRES_ROOT_CA_PEM: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
    PINTPATH_POSTGRES_ROOT_CA_DER_SHA256:
      TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
    ...overrides,
  };
}

function healthyReadiness(): PostgresRuntimeReadiness {
  return {
    ready: true,
    checks: {
      dialect: true,
      runtimeRole: true,
      searchPath: true,
      schemaVersion: true,
      importReady: true,
      authoritativeTables: true,
      operationsIsolation: true,
      applicationSchemaIsolation: true,
    },
    failures: [],
    metrics: {
      schemaVersion: "supported",
      importState: "ready",
      authoritativeTableCount: 56,
      expectedAuthoritativeTableCount: 56,
      pool: {
        dialect: "postgres",
        totalConnections: 1,
        idleConnections: 1,
        waitingRequests: 0,
        completedQueries: 5,
        failedQueries: 0,
        transactionFailures: 0,
        lastQueryDurationMs: 3.5,
      },
    },
  };
}

class FakeDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  closeCalls = 0;

  constructor(private readonly closeError?: Error) {}

  prepare(): SqlStatement {
    throw new Error("The injected readiness check should replace database introspection.");
  }

  async exec(): Promise<void> {}

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => work();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }

  metrics(): SqlPoolMetrics {
    return healthyReadiness().metrics.pool;
  }
}

class FakeTransport {
  assertCalls = 0;
  closeCalls = 0;
  readonly nodeConnection = fakeNodeConnection;

  constructor(
    private readonly failingAssertCall?: number,
    private readonly closeError?: Error,
  ) {}

  async assertExact(): Promise<void> {
    this.assertCalls += 1;
    if (this.assertCalls === this.failingAssertCall) {
      throw new Error("transport drift contains private authority");
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }
}

interface HarnessOptions {
  database?: FakeDatabase;
  readiness?: PostgresRuntimeReadiness;
  checkError?: Error;
  createError?: Error;
  openError?: Error;
  transport?: FakeTransport;
  uid?: number | null;
  env?: Readonly<Record<string, string | undefined>>;
}

function createHarness(options: HarnessOptions = {}) {
  const database = options.database ?? new FakeDatabase();
  const transport = options.transport ?? new FakeTransport();
  const output: string[] = [];
  const createdWith: PostgresDatabaseOptions[] = [];
  const openedWith: OpenPostgresRailwayStockLocalhostCaTransportFromPemOptions[] = [];
  const dependencies: Partial<PostgresRuntimeVerifierDependencies> = {
    env: options.env ?? runtimeEnv(),
    getUid: () => options.uid === undefined ? 501 : options.uid,
    now: () => new Date("2026-08-14T00:00:00.000Z"),
    openPostgresRuntimeTransport: async (transportOptions) => {
      openedWith.push(transportOptions);
      if (options.openError) throw options.openError;
      return transport as unknown as PostgresRailwayStockLocalhostCaTransport;
    },
    createDatabase: (databaseOptions) => {
      createdWith.push(databaseOptions);
      if (options.createError) throw options.createError;
      return database;
    },
    checkReadiness: async () => {
      if (options.checkError) throw options.checkError;
      return options.readiness ?? healthyReadiness();
    },
    writeOutput: (value) => output.push(value),
  };
  return { database, transport, output, createdWith, openedWith, dependencies };
}

function parseOnlyReport(output: string[]): PostgresRuntimeVerifierReport {
  expect(output).toHaveLength(1);
  expect(output[0]!.endsWith("\n")).toBe(true);
  return JSON.parse(output[0]!) as PostgresRuntimeVerifierReport;
}

describe("Postgres runtime verifier", () => {
  it("validates the full environment identity contract before the executable CLI opens Postgres", () => {
    const source = fs.readFileSync("scripts/verify-postgres-runtime.ts", "utf8");
    const cliBranch = source.slice(source.indexOf("if (invokedPath ==="));

    expect(cliBranch.indexOf('await import("../src/config/env.js")')).toBeGreaterThanOrEqual(0);
    expect(cliBranch.indexOf('await import("../src/config/env.js")'))
      .toBeLessThan(cliBranch.indexOf("runPostgresRuntimeVerifier()"));
  });

  it("uses a bounded verifier pool, emits JSON only, closes, and succeeds", async () => {
    const harness = createHarness();

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(0);
    expect(result).toEqual({
      schemaVersion: 1,
      ready: true,
      failureCode: null,
      readiness: healthyReadiness(),
    });
    expect(harness.createdWith).toEqual([{
      connectionString: tlsDatabaseUrl,
      activeRole: "pintpath_runtime",
      railwayStockLocalhostCaConnection: fakeNodeConnection,
      ...POSTGRES_RUNTIME_VERIFIER_POOL_OPTIONS,
    }]);
    expect(harness.openedWith).toEqual([{
      profile: "railway-stock-localhost-ca-v1",
      rootCaPem: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
      expectedRootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
      expectedUid: 501,
      sourceUrlAuthority: {
        hostname: "pintpath-postgres.railway.internal",
        port: 5_432,
      },
    }]);
    expect(POSTGRES_RUNTIME_VERIFIER_POOL_OPTIONS).toEqual({
      applicationName: "pintpath-runtime-verifier",
      maxConnections: 1,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 10_000,
      statementTimeoutMs: 15_000,
      idleInTransactionTimeoutMs: 10_000,
    });
    expect(harness.database.closeCalls).toBe(1);
    expect(harness.transport.assertCalls).toBe(5);
    expect(harness.transport.closeCalls).toBe(1);
    expect(harness.output[0]).not.toContain("do-not-print");
    expect(harness.output[0]).not.toContain("database.invalid");
    expect(harness.output[0]).not.toContain("pintpath_app");
    expect(harness.output[0]).not.toContain("pintpath_ops");
  });

  it.each([
    undefined,
    "",
    "not-a-url",
    "http://runtime:private@example.invalid/pintpath?sslmode=require",
    "postgresql://runtime:private@example.invalid/pintpath",
    "postgresql://runtime:private@pintpath-postgres.railway.internal:5432/pintpath?sslmode=require",
    "postgresql://runtime:private@pintpath-postgres.railway.internal:5432/pintpath?sslmode=verify-ca",
    "postgresql://runtime:private@pintpath-postgres.railway.internal:5432/pintpath?sslmode=verify-full#fragment",
  ])("rejects a missing or unsafe DATABASE_URL without opening transport: %s", async (value) => {
    const harness = createHarness({ env: runtimeEnv({ DATABASE_URL: value }) });

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(1);
    expect(result).toEqual({
      schemaVersion: 1,
      ready: false,
      failureCode: "database_authority_missing_or_unsafe",
      readiness: null,
    });
    expect(harness.createdWith).toEqual([]);
    expect(harness.openedWith).toEqual([]);
    expect(harness.database.closeCalls).toBe(0);
    expect(harness.transport.closeCalls).toBe(0);
    expect(harness.output[0]).not.toContain("private");
    expect(harness.output[0]).not.toContain("example.invalid");
  });

  it.each([
    ["missing PEM", { PINTPATH_POSTGRES_ROOT_CA_PEM: "" }],
    ["wrong DER pin", { PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: "a".repeat(64) }],
  ])("rejects %s before opening transport", async (_label, overrides) => {
    const harness = createHarness({ env: runtimeEnv(overrides) });
    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    expect(exitCode).toBe(1);
    expect(parseOnlyReport(harness.output).failureCode).toBe(
      "database_authority_missing_or_unsafe",
    );
    expect(harness.openedWith).toEqual([]);
    expect(harness.output[0]).not.toContain("BEGIN CERTIFICATE");
  });

  it("closes and exits nonzero when runtime readiness fails", async () => {
    const notReady = healthyReadiness();
    notReady.ready = false;
    notReady.checks.importReady = false;
    notReady.failures = ["import_not_ready"];
    notReady.metrics.importState = "not-ready";
    const harness = createHarness({ readiness: notReady });

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(1);
    expect(result.ready).toBe(false);
    expect(result.failureCode).toBe("runtime_not_ready");
    expect(result.readiness?.failures).toEqual(["import_not_ready"]);
    expect(harness.database.closeCalls).toBe(1);
  });

  it("closes and redacts a raw verification failure", async () => {
    const harness = createHarness({
      checkError: new Error("postgresql://runtime:leaked@private.internal/pintpath"),
    });

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(1);
    expect(result).toEqual({
      schemaVersion: 1,
      ready: false,
      failureCode: "verification_failed",
      readiness: null,
    });
    expect(harness.database.closeCalls).toBe(1);
    expect(harness.output[0]).not.toContain("leaked");
    expect(harness.output[0]).not.toContain("private.internal");
  });

  it("fails closed when the stock-localhost transport cannot open", async () => {
    const harness = createHarness({
      openError: new Error(`transport rejected ${tlsDatabaseUrl}`),
    });

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(1);
    expect(result.failureCode).toBe("transport_initialization_failed");
    expect(harness.openedWith).toHaveLength(1);
    expect(harness.createdWith).toEqual([]);
    expect(harness.transport.closeCalls).toBe(0);
    expect(harness.output[0]).not.toContain("do-not-print");
  });

  it("fences the adapter and closes both authorities on transport drift", async () => {
    const transport = new FakeTransport(2);
    const harness = createHarness({ transport });

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(1);
    expect(result.failureCode).toBe("transport_verification_failed");
    expect(harness.createdWith).toHaveLength(1);
    expect(harness.database.closeCalls).toBe(1);
    expect(transport.assertCalls).toBe(4);
    expect(transport.closeCalls).toBe(1);
    expect(harness.output[0]).not.toContain("private authority");
  });

  it("reports close failure without exposing its raw error", async () => {
    const database = new FakeDatabase(new Error("close failed for user secret-operator"));
    const harness = createHarness({ database });

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(1);
    expect(result.ready).toBe(false);
    expect(result.failureCode).toBe("close_failed");
    expect(result.readiness?.ready).toBe(true);
    expect(database.closeCalls).toBe(1);
    expect(harness.transport.closeCalls).toBe(1);
    expect(harness.output[0]).not.toContain("secret-operator");
  });

  it("reports transport cleanup failure without exposing its raw error", async () => {
    const transport = new FakeTransport(
      undefined,
      new Error("cleanup failed for private transport"),
    );
    const harness = createHarness({ transport });

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(1);
    expect(result.failureCode).toBe("close_failed");
    expect(result.readiness?.ready).toBe(true);
    expect(harness.database.closeCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
    expect(harness.output[0]).not.toContain("private transport");
  });

  it("redacts adapter construction failures", async () => {
    const harness = createHarness({
      createError: new Error(`connection rejected: ${tlsDatabaseUrl}`),
    });

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(1);
    expect(result.failureCode).toBe("adapter_initialization_failed");
    expect(result.readiness).toBeNull();
    expect(harness.database.closeCalls).toBe(0);
    expect(harness.transport.closeCalls).toBe(1);
    expect(harness.output[0]).not.toContain("do-not-print");
  });

  it("allowlists readiness fields and rejects an apparently-ready unsafe payload", async () => {
    const injected = healthyReadiness() as PostgresRuntimeReadiness & {
      databaseUrl: string;
      currentUser: string;
    };
    injected.databaseUrl = tlsDatabaseUrl;
    injected.currentUser = "secret-runtime-user";
    injected.failures = ["unknown_failure" as never];
    const harness = createHarness({ readiness: injected });

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(1);
    expect(result.failureCode).toBe("runtime_not_ready");
    expect(result.readiness?.failures).toEqual([]);
    expect(harness.output[0]).not.toContain("databaseUrl");
    expect(harness.output[0]).not.toContain("currentUser");
    expect(harness.output[0]).not.toContain("secret-runtime-user");
  });
});
