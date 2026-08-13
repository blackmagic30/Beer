import { describe, expect, it, vi } from "vitest";

import {
  createRuntimePersistence,
  inspectPostgresRuntimeImplementationContract,
  LegacyBusinessRuntimeUnavailableError,
  shouldUsePostgresRuntime,
  type RuntimePersistenceDependencies,
} from "../src/db/runtime-persistence.js";
import type { SqlDatabase, SqlPoolMetrics } from "../src/db/sql-database.js";

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
  } = {},
): RuntimePersistenceDependencies {
  const postgres = input.postgres ?? fakeDatabase("postgres");
  const sqlite = input.sqlite ?? fakeDatabase("sqlite");
  return {
    createPostgresDatabase: vi.fn(() => postgres),
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
        databaseUrl:
          "postgresql://runtime:secret@db.internal:5432/pintpath?sslmode=require",
      },
      deps,
    );

    expect(runtime.mode).toBe("postgres");
    expect(deps.loadSqliteRuntime).not.toHaveBeenCalled();
    expect(deps.createPostgresDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationName: "pintpath-web",
        maxConnections: 8,
      }),
    );
    expect(() => runtime.businessRepository.getBarProfile("venue-1")).toThrow(
      LegacyBusinessRuntimeUnavailableError,
    );
    await expect(
      runtime.performAccountDeletionSecretPhysicalCheckpoint([]),
    ).resolves.toBe(true);
  });

  it("closes the PostgreSQL pool when startup readiness fails", async () => {
    const postgres = fakeDatabase("postgres");
    const deps = dependencies({ postgres, ready: false });
    await expect(
      createRuntimePersistence(
        {
          postgresRuntime: true,
          restoreRehearsalMode: false,
          databaseUrl:
            "postgresql://runtime:secret@db.internal:5432/pintpath?sslmode=require",
        },
        deps,
      ),
    ).rejects.toThrow("import_not_ready");
    expect(postgres.close).toHaveBeenCalledOnce();
    expect(deps.loadSqliteRuntime).not.toHaveBeenCalled();
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
import fs from "node:fs";
import path from "node:path";
