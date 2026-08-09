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

const tlsDatabaseUrl = "postgresql://runtime:do-not-print@database.invalid/pintpath?sslmode=require";
const normalizedTlsDatabaseUrl = `${tlsDatabaseUrl}&uselibpqcompat=true`;

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

interface HarnessOptions {
  database?: FakeDatabase;
  readiness?: PostgresRuntimeReadiness;
  checkError?: Error;
  createError?: Error;
  env?: Readonly<Record<string, string | undefined>>;
}

function createHarness(options: HarnessOptions = {}) {
  const database = options.database ?? new FakeDatabase();
  const output: string[] = [];
  const createdWith: PostgresDatabaseOptions[] = [];
  const dependencies: Partial<PostgresRuntimeVerifierDependencies> = {
    env: options.env ?? { DATABASE_URL: tlsDatabaseUrl },
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
  return { database, output, createdWith, dependencies };
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
      connectionString: normalizedTlsDatabaseUrl,
      ...POSTGRES_RUNTIME_VERIFIER_POOL_OPTIONS,
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
    "postgresql://runtime:private@example.invalid/pintpath?sslmode=disable",
    "postgresql://runtime:private@example.invalid/pintpath?sslmode=require#fragment",
  ])("rejects a missing or unsafe DATABASE_URL without constructing an adapter: %s", async (value) => {
    const harness = createHarness({ env: { DATABASE_URL: value } });

    const exitCode = await runPostgresRuntimeVerifier(harness.dependencies);
    const result = parseOnlyReport(harness.output);

    expect(exitCode).toBe(1);
    expect(result).toEqual({
      schemaVersion: 1,
      ready: false,
      failureCode: "database_url_missing_or_unsafe",
      readiness: null,
    });
    expect(harness.createdWith).toEqual([]);
    expect(harness.database.closeCalls).toBe(0);
    expect(harness.output[0]).not.toContain("private");
    expect(harness.output[0]).not.toContain("example.invalid");
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
    expect(harness.output[0]).not.toContain("secret-operator");
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
