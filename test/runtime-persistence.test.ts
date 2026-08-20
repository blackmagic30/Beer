import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createRuntimePersistence,
  inspectPostgresRuntimeImplementationContract,
  LegacyBusinessRuntimeUnavailableError,
  shouldUsePostgresRuntime,
  type RuntimePersistenceDependencies,
} from "../src/db/runtime-persistence.js";
import type { SqlDatabase, SqlPoolMetrics } from "../src/db/sql-database.js";
import {
  checkPostgresRailwayStockLocalhostServerIdentity,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

const POSTGRES_URL =
  "postgresql://runtime:secret@postgres-staging.railway.internal:5432/pintpath?sslmode=verify-full";
const POSTGRES_ROOT_CA_PEM =
  "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n";
const POSTGRES_ROOT_CA_DER_SHA256 = "a".repeat(64);

function fakeDatabase(
  dialect: "sqlite" | "postgres" = "postgres",
): SqlDatabase {
  return {
    dialect,
    prepare: vi.fn(() => {
      throw new Error("not used");
    }),
    exec: vi.fn(async () => undefined),
    transaction: vi.fn(() => async () => undefined),
    close: vi.fn(async () => undefined),
    metrics: vi.fn((): SqlPoolMetrics => ({
      dialect,
      totalConnections: 0,
      idleConnections: 0,
      waitingRequests: 0,
      completedQueries: 0,
      failedQueries: 0,
      transactionFailures: 0,
      lastQueryDurationMs: null,
    })),
  };
}

function dependencies(
  input: {
    postgres?: SqlDatabase;
    sqlite?: SqlDatabase;
    ready?: boolean;
    assertExactFailureAt?: number;
  } = {},
): RuntimePersistenceDependencies & {
  readonly runtimeTransport: PostgresRailwayStockLocalhostCaTransport;
} {
  const postgres = input.postgres ?? fakeDatabase("postgres");
  const sqlite = input.sqlite ?? fakeDatabase("sqlite");
  let assertExactCalls = 0;
  const transport = {
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaDerSha256: POSTGRES_ROOT_CA_DER_SHA256,
    sourceUrlAuthority: {
      hostname: "postgres-staging.railway.internal",
      port: 5_432,
    },
    resolvedAddress: "fd12:3456:789a::10",
    temporaryDirectory: "/private/runtime-transport",
    passwordFileDirectory: "/private/runtime-transport",
    passwordFileHost: "localhost",
    nodeConnection: {
      host: "fd12:3456:789a::10",
      port: 5_432,
      ssl: {
        ca: POSTGRES_ROOT_CA_PEM,
        servername: "localhost",
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        checkServerIdentity: checkPostgresRailwayStockLocalhostServerIdentity,
      },
    },
    libpqEnvironment: {
      PGHOST: "localhost",
      PGHOSTADDR: "fd12:3456:789a::10",
      PGPORT: "5432",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/private/runtime-transport/root-ca.pem",
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
    },
    assertExact: vi.fn(async () => {
      assertExactCalls += 1;
      if (
        input.assertExactFailureAt !== undefined
        && assertExactCalls === input.assertExactFailureAt
      ) {
        throw new Error("transport_drift");
      }
    }),
    close: vi.fn(async () => undefined),
  } satisfies PostgresRailwayStockLocalhostCaTransport;
  return {
    runtimeTransport: transport,
    createPostgresDatabase: vi.fn(() => postgres),
    getUid: () => 501,
    openPostgresRuntimeTransport: vi.fn(async () => transport),
    checkPostgresRuntimeReadiness: vi.fn(async () => ({
      ready: input.ready ?? true,
      failures: input.ready === false ? ["import_not_ready"] : [],
    })),
    loadSqliteRuntime: vi.fn(async () => ({
      sqlDatabase: sqlite,
      businessRepository: { checkDatabaseHealth: vi.fn() } as never,
      performAccountDeletionSecretPhysicalCheckpoint: vi.fn(async () => true),
    })),
  };
}

describe("runtime persistence selection", () => {
  it("exposes an executable fail-closed implementation contract", () => {
    expect(inspectPostgresRuntimeImplementationContract()).toEqual({
      ready: true,
      productionSelectsPostgresWithoutCredentialFallback: true,
      restoreSelectsSqlite: true,
      developmentSelectsSqlite: true,
      legacyRepositoryFailsClosed: true,
    });
  });
  it("selects PostgreSQL for production and permanent staging, but not restored SQLite", () => {
    expect(
      shouldUsePostgresRuntime({
        nodeEnv: "production",
        restoreRehearsalMode: false,
        databaseUrl:
          "postgresql://runtime@db.internal/pintpath?sslmode=require",
      }),
    ).toBe(true);
    expect(
      shouldUsePostgresRuntime({
        nodeEnv: "production",
        restoreRehearsalMode: false,
        postgresRecoveryRehearsalMode: true,
      }),
    ).toBe(true);
    expect(() =>
      shouldUsePostgresRuntime({
        nodeEnv: "test",
        restoreRehearsalMode: false,
        postgresRecoveryRehearsalMode: true,
      }),
    ).toThrow("cannot fall back to SQLite");
    expect(() =>
      shouldUsePostgresRuntime({
        nodeEnv: "production",
        restoreRehearsalMode: true,
        postgresRecoveryRehearsalMode: true,
      }),
    ).toThrow("cannot fall back to SQLite");
    expect(
      shouldUsePostgresRuntime({
        nodeEnv: "production",
        restoreRehearsalMode: false,
      }),
    ).toBe(true);
    expect(
      shouldUsePostgresRuntime({
        nodeEnv: "production",
        restoreRehearsalMode: true,
        databaseUrl:
          "postgresql://runtime@db.internal/pintpath?sslmode=require",
      }),
    ).toBe(false);
    expect(
      shouldUsePostgresRuntime({
        nodeEnv: "test",
        restoreRehearsalMode: false,
        databaseUrl:
          "postgresql://runtime@db.internal/pintpath?sslmode=require",
      }),
    ).toBe(false);
  });

  it("keeps the canonical app module free of direct SQLite loading", () => {
    const appSource = fs.readFileSync(path.resolve("src/app.ts"), "utf8");
    const backupSource = fs.readFileSync(
      path.resolve("src/lib/data-backup.ts"),
      "utf8",
    );
    expect(appSource).not.toContain('import("./db/database.js")');
    expect(appSource).not.toContain("createDatabase(");
    expect(appSource).not.toContain("asAsyncSqliteDatabase(");
    expect(appSource).toContain(
      "inspectPostgresLogicalRuntimeDatabaseIdentity(sqlDatabase)",
    );
    expect(appSource).toContain('activeRole: "pintpath_maintenance"');
    expect(appSource).toContain(
      "POSTGRES_CONNECTION_BUDGET.maintenanceWorkPoolMaxConnectionsPerProcess",
    );
    expect(appSource).toContain(
      "POSTGRES_CONNECTION_BUDGET.maintenanceReadinessPoolMaxConnectionsPerProcess",
    );
    expect(appSource).toContain("inspectPostgresApplicationPoolMetrics(");
    expect(appSource).toContain('"runtime",');
    expect(appSource).toContain('"maintenance_work",');
    expect(appSource).toContain('"maintenance_readiness",');
    expect(appSource).toContain("poolMetrics: [");
    expect(appSource).toContain('applicationName: "pintpath-privacy-maintenance-readiness"');
    expect(appSource).toContain("maintenanceReadinessDatabase");
    expect(appSource).toContain(
      "new AccountPrivacyRepository(maintenanceDatabase)",
    );
    expect(
      appSource.match(
        /checkPostgresMaintenanceRuntimeReadiness\(\s*maintenanceReadinessDatabase/g,
      ),
    ).toHaveLength(2);
    expect(
      appSource.match(
        /allowLegacyTwoConnectionLimitDuringRollout:\s*!automaticMaintenanceEnabled/g,
      ),
    ).toHaveLength(2);
    expect(appSource).toContain("railwayStockLocalhostCaConnection:");
    expect(appSource).toContain(
      "await persistence.assertPostgresTransportExact()",
    );
    expect(appSource).toContain("await closePostgresAuthorities()");
    expect(appSource).toContain("probePostgresLogicalOffsiteReadiness({");
    expect(appSource).toContain("stateValue: state?.value");
    expect(appSource).toContain("runtimeDatabaseIdentitySha256");
    expect(appSource).toContain(
      "!env.ACCOUNT_DELETION_REHEARSAL_ENABLED",
    );
    expect(backupSource).not.toMatch(
      /^import BetterSqlite3 from "better-sqlite3";/m,
    );
    expect(backupSource).toContain(
      'import type BetterSqlite3 from "better-sqlite3";',
    );
  });

  it("keeps every reviewed Free-runtime legacy repository entry point removed", () => {
    const serviceSource = fs.readFileSync(
      path.resolve("src/modules/business/business.service.ts"),
      "utf8",
    );
    for (const method of [
      "getVenueManagerInsights",
      "getVenuePartnerAdminCounts",
      "getVenuePartnerLeadContext",
      "searchAccountsForAdmin",
      "overrideUserStatus",
      "getAnalyticsPreview",
      "getContributionPointsForMonth",
      "findLikelyVenueDuplicate",
      "getLatestVenueDataTimestamp",
      "venueHasPublishedBeerRecord",
      "listMissionFeedPage",
      "listMissions",
      "listMissionVenueCandidates",
      "replaceAutoMissions",
      "pruneInactiveAutoMissions",
      "deactivateDemoMissions",
      "createSourceEvidenceObject",
      "getSourceEvidenceObject",
      "createSubmission",
      "prunePrivacyRetention",
    ]) {
      expect(serviceSource).not.toContain(`this.repository.${method}`);
    }
  });

  it("initializes only PostgreSQL for canonical production and fails closed on legacy access", async () => {
    const deps = dependencies();
    const runtime = await createRuntimePersistence(
      {
        postgresRuntime: true,
        restoreRehearsalMode: false,
        databaseUrl: POSTGRES_URL,
        postgresRootCaPem: POSTGRES_ROOT_CA_PEM,
        expectedPostgresRootCaDerSha256: POSTGRES_ROOT_CA_DER_SHA256,
      },
      deps,
    );

    expect(runtime.mode).toBe("postgres");
    expect(deps.loadSqliteRuntime).not.toHaveBeenCalled();
    expect(deps.createPostgresDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRole: "pintpath_runtime",
        railwayStockLocalhostCaConnection: expect.objectContaining({
          host: "fd12:3456:789a::10",
        }),
        applicationName: "pintpath-web",
        maxConnections: 2,
      }),
    );
    expect(() => runtime.businessRepository.getBarProfile("venue-1")).toThrow(
      LegacyBusinessRuntimeUnavailableError,
    );
    await expect(
      runtime.performAccountDeletionSecretPhysicalCheckpoint([]),
    ).resolves.toBe(true);
    expect(deps.runtimeTransport.assertExact).toHaveBeenCalledTimes(3);
    await runtime.assertPostgresTransportExact();
    expect(deps.runtimeTransport.assertExact).toHaveBeenCalledTimes(4);
    await runtime.close();
    expect(deps.runtimeTransport.close).toHaveBeenCalledOnce();
    expect(deps.openPostgresRuntimeTransport).toHaveBeenCalledWith({
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaPem: POSTGRES_ROOT_CA_PEM,
      expectedRootCaDerSha256: POSTGRES_ROOT_CA_DER_SHA256,
      expectedUid: 501,
      sourceUrlAuthority: {
        hostname: "postgres-staging.railway.internal",
        port: 5_432,
      },
    });
  });

  it("closes the PostgreSQL pool when startup readiness fails", async () => {
    const postgres = fakeDatabase("postgres");
    const deps = dependencies({ postgres, ready: false });
    await expect(
      createRuntimePersistence(
        {
          postgresRuntime: true,
          restoreRehearsalMode: false,
          databaseUrl: POSTGRES_URL,
          postgresRootCaPem: POSTGRES_ROOT_CA_PEM,
          expectedPostgresRootCaDerSha256: POSTGRES_ROOT_CA_DER_SHA256,
        },
        deps,
      ),
    ).rejects.toThrow("import_not_ready");
    expect(postgres.close).toHaveBeenCalledOnce();
    expect(deps.runtimeTransport.close).toHaveBeenCalledOnce();
    expect(deps.loadSqliteRuntime).not.toHaveBeenCalled();
  });

  it("closes both authorities when the post-readiness transport fence detects drift", async () => {
    const postgres = fakeDatabase("postgres");
    const deps = dependencies({ postgres, assertExactFailureAt: 3 });
    await expect(
      createRuntimePersistence(
        {
          postgresRuntime: true,
          restoreRehearsalMode: false,
          databaseUrl: POSTGRES_URL,
          postgresRootCaPem: POSTGRES_ROOT_CA_PEM,
          expectedPostgresRootCaDerSha256: POSTGRES_ROOT_CA_DER_SHA256,
        },
        deps,
      ),
    ).rejects.toThrow("transport_drift");
    expect(postgres.close).toHaveBeenCalledOnce();
    expect(deps.runtimeTransport.close).toHaveBeenCalledOnce();
  });

  it("attempts transport cleanup and reports it when startup pool cleanup fails", async () => {
    const postgres = fakeDatabase("postgres");
    vi.mocked(postgres.close).mockRejectedValueOnce(new Error("pool_close_failed"));
    const deps = dependencies({ postgres, ready: false });
    await expect(
      createRuntimePersistence(
        {
          postgresRuntime: true,
          restoreRehearsalMode: false,
          databaseUrl: POSTGRES_URL,
          postgresRootCaPem: POSTGRES_ROOT_CA_PEM,
          expectedPostgresRootCaDerSha256: POSTGRES_ROOT_CA_DER_SHA256,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: "Canonical PostgreSQL startup and authority cleanup failed.",
    });
    expect(postgres.close).toHaveBeenCalledOnce();
    expect(deps.runtimeTransport.close).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "sslmode=require",
      "postgresql://runtime:secret@postgres-staging.railway.internal:5432/pintpath?sslmode=require",
    ],
    [
      "non-Railway authority",
      "postgresql://runtime:secret@db.internal:5432/pintpath?sslmode=verify-full",
    ],
  ])("rejects an unauthenticated production transport: %s", async (_label, databaseUrl) => {
    const deps = dependencies();
    await expect(createRuntimePersistence({
      postgresRuntime: true,
      restoreRehearsalMode: false,
      databaseUrl,
      postgresRootCaPem: POSTGRES_ROOT_CA_PEM,
      expectedPostgresRootCaDerSha256: POSTGRES_ROOT_CA_DER_SHA256,
    }, deps)).rejects.toThrow("exact Railway private");
    expect(deps.openPostgresRuntimeTransport).not.toHaveBeenCalled();
    expect(deps.createPostgresDatabase).not.toHaveBeenCalled();
  });

  it("fails closed instead of loading SQLite when a production runtime lacks DATABASE_URL", async () => {
    const deps = dependencies();
    await expect(
      createRuntimePersistence(
        {
          postgresRuntime: shouldUsePostgresRuntime({
            nodeEnv: "production",
            restoreRehearsalMode: false,
          }),
          restoreRehearsalMode: false,
        },
        deps,
      ),
    ).rejects.toThrow("requires DATABASE_URL");
    expect(deps.loadSqliteRuntime).not.toHaveBeenCalled();
    expect(deps.createPostgresDatabase).not.toHaveBeenCalled();
  });

  it.each([
    [false, "sqlite"],
    [true, "sqlite_restore_read_only"],
  ] as const)(
    "loads the SQLite runtime only for noncanonical mode (restore=%s)",
    async (readOnly, mode) => {
      const deps = dependencies();
      const runtime = await createRuntimePersistence(
        {
          postgresRuntime: false,
          restoreRehearsalMode: readOnly,
        },
        deps,
      );
      expect(runtime.mode).toBe(mode);
      expect(deps.loadSqliteRuntime).toHaveBeenCalledWith({ readOnly });
      expect(deps.createPostgresDatabase).not.toHaveBeenCalled();
    },
  );
});
