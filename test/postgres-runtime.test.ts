import { describe, expect, it } from "vitest";

import {
  EXPECTED_POSTGRES_AUTHORITATIVE_TABLES,
  SUPPORTED_POSTGRES_SCHEMA_VERSION,
  checkPostgresRuntimeReadiness,
  postgresRuntimeQueries,
} from "../src/db/postgres-runtime.js";
import type {
  SqlDatabase,
  SqlPoolMetrics,
  SqlStatement,
} from "../src/db/sql-database.js";

interface MockRuntimeState {
  session?: {
    isSuperuser: boolean;
    canBypassRls: boolean;
    isRuntimeMember: boolean;
    searchPathSchemas: string[];
    currentSchema: string | null;
  } | undefined;
  metadata?: Array<{ key: string; value: string }> | undefined;
  tableCount?: number | undefined;
  operationsAccess?: boolean | undefined;
  applicationExposure?: boolean | undefined;
  failure?: Error | undefined;
}

const healthyState: Required<Omit<MockRuntimeState, "failure">> = {
  session: {
    isSuperuser: false,
    canBypassRls: false,
    isRuntimeMember: true,
    searchPathSchemas: ["pintpath_app", "pg_catalog"],
    currentSchema: "pintpath_app",
  },
  metadata: [
    { key: "import_state", value: "ready" },
    { key: "schema_version", value: SUPPORTED_POSTGRES_SCHEMA_VERSION },
  ],
  tableCount: EXPECTED_POSTGRES_AUTHORITATIVE_TABLES,
  operationsAccess: false,
  applicationExposure: false,
};

function poolMetrics(dialect: "sqlite" | "postgres"): SqlPoolMetrics {
  return {
    dialect,
    totalConnections: 4,
    idleConnections: 2,
    waitingRequests: 1,
    completedQueries: 20,
    failedQueries: 2,
    transactionFailures: 1,
    lastQueryDurationMs: 12.5,
  };
}

class MockSqlDatabase implements SqlDatabase {
  readonly preparedSql: string[] = [];

  constructor(
    readonly dialect: "sqlite" | "postgres",
    private readonly state: MockRuntimeState,
    private readonly pool = poolMetrics(dialect),
  ) {}

  prepare(sql: string): SqlStatement {
    this.preparedSql.push(sql);
    const value = () => {
      if (this.state.failure) throw this.state.failure;
      if (sql.includes(":session */")) return this.state.session;
      if (sql.includes(":metadata */")) return this.state.metadata ?? [];
      if (sql.includes(":table-count */")) {
        return this.state.tableCount === undefined
          ? undefined
          : { tableCount: this.state.tableCount };
      }
      if (sql.includes(":operations-access */")) {
        return this.state.operationsAccess === undefined
          ? undefined
          : { hasAccess: this.state.operationsAccess };
      }
      if (sql.includes(":application-exposure */")) {
        return this.state.applicationExposure === undefined
          ? undefined
          : { hasAccess: this.state.applicationExposure };
      }
      throw new Error("Unexpected mock query.");
    };
    return {
      run: async () => ({ changes: 0 }),
      get: async () => value() as never,
      all: async () => value() as never,
    };
  }

  async exec(): Promise<void> {}

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => work();
  }

  async close(): Promise<void> {}

  metrics(): SqlPoolMetrics {
    return this.pool;
  }
}

function postgresDatabase(overrides: MockRuntimeState = {}): MockSqlDatabase {
  return new MockSqlDatabase("postgres", {
    ...healthyState,
    ...overrides,
    session: overrides.session === undefined
      ? { ...healthyState.session }
      : overrides.session,
    metadata: overrides.metadata === undefined
      ? healthyState.metadata.map((row) => ({ ...row }))
      : overrides.metadata,
  });
}

describe("Postgres runtime readiness", () => {
  it("checks effective named-role access and direct PUBLIC ACLs", () => {
    expect(postgresRuntimeQueries.runtimeSession).toContain("rolsuper");
    expect(postgresRuntimeQueries.runtimeSession).toContain("rolbypassrls");
    expect(postgresRuntimeQueries.runtimeSession).toContain("pg_has_role");
    expect(postgresRuntimeQueries.runtimeSession).toContain("current_schemas(false)");

    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(postgresRuntimeQueries.applicationExposure).toContain(`'${role}'`);
    }
    expect(postgresRuntimeQueries.applicationExposure).toContain("has_schema_privilege");
    expect(postgresRuntimeQueries.applicationExposure).toContain("has_table_privilege");
    expect(postgresRuntimeQueries.applicationExposure).toContain("has_any_column_privilege");
    expect(postgresRuntimeQueries.applicationExposure).toContain("has_sequence_privilege");
    expect(postgresRuntimeQueries.applicationExposure).toContain("has_function_privilege");
    expect(postgresRuntimeQueries.applicationExposure).toContain("aclexplode");
    expect(postgresRuntimeQueries.applicationExposure).toContain("privilege.grantee = 0");
  });

  it("skips absent column ACLs without manufacturing a zero-dimensional ACL array", () => {
    expect(postgresRuntimeQueries.applicationExposure).toContain(
      "attribute.attacl IS NOT NULL",
    );
    expect(postgresRuntimeQueries.applicationExposure).toMatch(
      /FROM application_columns AS attribute\s+CROSS JOIN LATERAL aclexplode\(\s+attribute\.attacl\s+\) AS privilege\s+WHERE privilege\.grantee = 0/,
    );
    expect(postgresRuntimeQueries.applicationExposure).not.toContain(
      "COALESCE(attribute.attacl, '{}'::aclitem[])",
    );
  });

  it("returns safe readiness and pool metrics for the exact runtime contract", async () => {
    const database = postgresDatabase();

    const result = await checkPostgresRuntimeReadiness(database);

    expect(result).toEqual({
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
        pool: poolMetrics("postgres"),
      },
    });
    expect(database.preparedSql).toHaveLength(5);
    expect(JSON.stringify(result)).not.toMatch(/current_user|password|postgresql:\/\//i);
  });

  it("fails closed before catalog access for a non-Postgres database", async () => {
    const database = new MockSqlDatabase("sqlite", healthyState);

    const result = await checkPostgresRuntimeReadiness(database);

    expect(result.ready).toBe(false);
    expect(result.failures).toEqual(["not_postgres"]);
    expect(result.checks.dialect).toBe(false);
    expect(result.metrics.schemaVersion).toBe("unavailable");
    expect(database.preparedSql).toEqual([]);
  });

  it.each([
    ["a superuser", { session: { ...healthyState.session, isSuperuser: true } }, "runtime_role_unsafe"],
    ["a BYPASSRLS user", { session: { ...healthyState.session, canBypassRls: true } }, "runtime_role_unsafe"],
    ["a user outside the runtime role", { session: { ...healthyState.session, isRuntimeMember: false } }, "runtime_role_unsafe"],
    ["an unsafe search path", { session: { ...healthyState.session, searchPathSchemas: ["public", "pintpath_app", "pg_catalog"] } }, "search_path_unsafe"],
    ["the wrong current schema", { session: { ...healthyState.session, currentSchema: "public" } }, "search_path_unsafe"],
    ["an unsupported schema version", { metadata: [{ key: "import_state", value: "ready" }, { key: "schema_version", value: "2" }] }, "schema_version_unsupported"],
    ["an incomplete import", { metadata: [{ key: "import_state", value: "verifying" }, { key: "schema_version", value: "1" }] }, "import_not_ready"],
    ["a duplicate metadata key", { metadata: [{ key: "import_state", value: "ready" }, { key: "import_state", value: "ready" }] }, "schema_version_unsupported"],
    ["the wrong table count", { tableCount: 55 }, "authoritative_table_count_mismatch"],
    ["runtime access to operations", { operationsAccess: true }, "operations_schema_accessible"],
    ["a browser or PUBLIC application grant", { applicationExposure: true }, "application_schema_exposed"],
  ] as const)("rejects %s", async (_label, overrides, failure) => {
    const result = await checkPostgresRuntimeReadiness(postgresDatabase(overrides));

    expect(result.ready).toBe(false);
    expect(result.failures).toContain(failure);
  });

  it("does not return raw catalog errors or attacker-controlled metadata", async () => {
    const database = postgresDatabase({
      failure: new Error("postgresql://runtime:secret@private.internal/pintpath"),
    });

    const result = await checkPostgresRuntimeReadiness(database);

    expect(result.ready).toBe(false);
    expect(result.failures).toEqual(["catalog_check_failed"]);
    expect(result.metrics).toMatchObject({
      schemaVersion: "unavailable",
      importState: "unavailable",
      authoritativeTableCount: null,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private.internal");
  });

  it("sanitizes invalid pool counters instead of forwarding them", async () => {
    const database = new MockSqlDatabase("postgres", healthyState, {
      ...poolMetrics("postgres"),
      totalConnections: -1,
      waitingRequests: Number.NaN,
      lastQueryDurationMs: Number.POSITIVE_INFINITY,
    });

    const result = await checkPostgresRuntimeReadiness(database);

    expect(result.ready).toBe(true);
    expect(result.metrics.pool).toMatchObject({
      totalConnections: 0,
      waitingRequests: 0,
      lastQueryDurationMs: null,
    });
  });
});
