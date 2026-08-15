import {
  createPostgresAccountDeletionSecretPhysicalCheckpoint,
  type AccountDeletionSecretPhysicalCheckpoint,
} from "../lib/account-deletion-secret-checkpoint.js";
import type { BusinessRepository } from "./business.repository.js";
import { POSTGRES_CONNECTION_BUDGET } from "./postgres-connection-budget.js";
import {
  createPostgresDatabase,
  type PostgresDatabaseOptions,
  type SqlDatabase,
} from "./sql-database.js";
import { checkPostgresRuntimeReadiness } from "./postgres-runtime.js";
import {
  openPostgresRailwayStockLocalhostCaTransportFromPem,
  parsePostgresRailwayStockLocalhostCaUrl,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  type OpenPostgresRailwayStockLocalhostCaTransportFromPemOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../lib/postgres-railway-stock-localhost-ca.js";

export type RuntimePersistenceMode =
  "postgres" | "sqlite" | "sqlite_restore_read_only";

export interface RuntimePersistence {
  mode: RuntimePersistenceMode;
  sqlDatabase: SqlDatabase;
  businessRepository: BusinessRepository;
  performAccountDeletionSecretPhysicalCheckpoint: AccountDeletionSecretPhysicalCheckpoint;
  postgresTransport: PostgresRailwayStockLocalhostCaTransport | null;
  assertPostgresTransportExact(): Promise<void>;
  close(): Promise<void>;
}

interface SqliteRuntimePersistence {
  sqlDatabase: SqlDatabase;
  businessRepository: BusinessRepository;
  performAccountDeletionSecretPhysicalCheckpoint: AccountDeletionSecretPhysicalCheckpoint;
}

export interface RuntimePersistenceDependencies {
  createPostgresDatabase(options: PostgresDatabaseOptions): SqlDatabase;
  getUid(): number | null;
  openPostgresRuntimeTransport(
    options: OpenPostgresRailwayStockLocalhostCaTransportFromPemOptions,
  ): Promise<PostgresRailwayStockLocalhostCaTransport>;
  checkPostgresRuntimeReadiness(database: SqlDatabase): Promise<{
    ready: boolean;
    failures: readonly string[];
  }>;
  loadSqliteRuntime(input: {
    readOnly: boolean;
  }): Promise<SqliteRuntimePersistence>;
}

const DEFAULT_DEPENDENCIES: RuntimePersistenceDependencies = {
  createPostgresDatabase,
  getUid: () => process.getuid?.() ?? null,
  openPostgresRuntimeTransport: (options) => (
    openPostgresRailwayStockLocalhostCaTransportFromPem(options)
  ),
  checkPostgresRuntimeReadiness,
  async loadSqliteRuntime(input) {
    const [databaseModule, sqlModule, repositoryModule, checkpointModule] =
      await Promise.all([
        import("./database.js"),
        import("./sql-database.js"),
        import("./business.repository.js"),
        import("../lib/account-deletion-secret-checkpoint.js"),
      ]);
    const database = input.readOnly
      ? databaseModule.openReadOnlyDatabase()
      : databaseModule.createDatabase();
    return {
      sqlDatabase: sqlModule.asAsyncSqliteDatabase(database),
      businessRepository: new repositoryModule.BusinessRepository(database),
      performAccountDeletionSecretPhysicalCheckpoint:
        checkpointModule.createSqliteAccountDeletionSecretPhysicalCheckpoint(
          database,
        ),
    };
  },
};

export class LegacyBusinessRuntimeUnavailableError extends Error {
  readonly code = "legacy_sqlite_runtime_unavailable" as const;

  constructor(readonly method: string) {
    super(
      "Legacy SQLite persistence is unavailable in the canonical PostgreSQL runtime.",
    );
    this.name = "LegacyBusinessRuntimeUnavailableError";
  }
}

/**
 * Keeps deferred commercial-only code structurally present without letting an
 * accidental Free-runtime call silently open, read, or dual-write SQLite.
 */
export function createUnavailableLegacyBusinessRepository(
  onAccess?: ((method: string) => void) | undefined,
): BusinessRepository {
  const target = Object.create(null) as object;
  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (typeof property !== "string") return undefined;
      return () => {
        onAccess?.(property);
        throw new LegacyBusinessRuntimeUnavailableError(property);
      };
    },
  }) as unknown as BusinessRepository;
}

export function shouldUsePostgresRuntime(input: {
  nodeEnv: string;
  restoreRehearsalMode: boolean;
  postgresRecoveryRehearsalMode?: boolean | undefined;
  databaseUrl?: string | undefined;
}): boolean {
  if (input.postgresRecoveryRehearsalMode) {
    if (input.nodeEnv !== "production" || input.restoreRehearsalMode) {
      throw new Error(
        "PostgreSQL recovery rehearsal cannot fall back to SQLite or a non-production runtime.",
      );
    }
    return true;
  }
  return input.nodeEnv === "production" && !input.restoreRehearsalMode;
}

export interface PostgresRuntimeImplementationContract {
  readonly ready: boolean;
  readonly productionSelectsPostgresWithoutCredentialFallback: boolean;
  readonly restoreSelectsSqlite: boolean;
  readonly developmentSelectsSqlite: boolean;
  readonly legacyRepositoryFailsClosed: boolean;
}

/**
 * Executes the credential-free parts of the production selection contract.
 * The release workflow separately exercises createRuntimePersistence with an
 * injected pool and proves that the SQLite loader is never called.
 */
export function inspectPostgresRuntimeImplementationContract(): PostgresRuntimeImplementationContract {
  const productionSelectsPostgresWithoutCredentialFallback =
    shouldUsePostgresRuntime({
      nodeEnv: "production",
      restoreRehearsalMode: false,
    });
  const restoreSelectsSqlite = !shouldUsePostgresRuntime({
    nodeEnv: "production",
    restoreRehearsalMode: true,
  });
  const developmentSelectsSqlite = !shouldUsePostgresRuntime({
    nodeEnv: "development",
    restoreRehearsalMode: false,
  });
  let legacyRepositoryFailsClosed = false;
  try {
    createUnavailableLegacyBusinessRepository().checkDatabaseHealth();
  } catch (error) {
    legacyRepositoryFailsClosed =
      error instanceof LegacyBusinessRuntimeUnavailableError;
  }
  return {
    ready:
      productionSelectsPostgresWithoutCredentialFallback &&
      restoreSelectsSqlite &&
      developmentSelectsSqlite &&
      legacyRepositoryFailsClosed,
    productionSelectsPostgresWithoutCredentialFallback,
    restoreSelectsSqlite,
    developmentSelectsSqlite,
    legacyRepositoryFailsClosed,
  };
}

export async function createRuntimePersistence(
  input: {
    postgresRuntime: boolean;
    restoreRehearsalMode: boolean;
    databaseUrl?: string | undefined;
    postgresRootCaPem?: string | undefined;
    expectedPostgresRootCaDerSha256?: string | undefined;
  },
  overrides: Partial<RuntimePersistenceDependencies> = {},
): Promise<RuntimePersistence> {
  const dependencies: RuntimePersistenceDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };

  if (!input.postgresRuntime) {
    const sqlite = await dependencies.loadSqliteRuntime({
      readOnly: input.restoreRehearsalMode,
    });
    return {
      mode: input.restoreRehearsalMode ? "sqlite_restore_read_only" : "sqlite",
      ...sqlite,
      postgresTransport: null,
      assertPostgresTransportExact: async () => undefined,
      close: async () => sqlite.sqlDatabase.close(),
    };
  }

  if (input.restoreRehearsalMode) {
    throw new Error(
      "Canonical PostgreSQL and read-only SQLite restore modes cannot be combined.",
    );
  }
  if (!input.databaseUrl) {
    throw new Error("Canonical PostgreSQL runtime requires DATABASE_URL.");
  }
  if (!input.postgresRootCaPem || !input.expectedPostgresRootCaDerSha256) {
    throw new Error(
      "Canonical PostgreSQL runtime requires the reviewed Railway root CA PEM and DER SHA-256 pin.",
    );
  }
  let parsedUrl;
  try {
    parsedUrl = parsePostgresRailwayStockLocalhostCaUrl(input.databaseUrl);
  } catch {
    throw new Error(
      "Canonical PostgreSQL runtime requires the exact Railway private :5432 URL with sslmode=verify-full.",
    );
  }
  let uid: number | null;
  try {
    uid = dependencies.getUid();
  } catch {
    uid = null;
  }
  if (!Number.isSafeInteger(uid) || uid === null || uid < 0) {
    throw new Error("Canonical PostgreSQL runtime requires one exact current UID.");
  }
  const postgresTransport = await dependencies.openPostgresRuntimeTransport({
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaPem: input.postgresRootCaPem,
    expectedRootCaDerSha256: input.expectedPostgresRootCaDerSha256,
    expectedUid: uid,
    sourceUrlAuthority: parsedUrl.sourceUrlAuthority,
  });
  let sqlDatabase: SqlDatabase | null = null;
  try {
    await postgresTransport.assertExact();
    sqlDatabase = dependencies.createPostgresDatabase({
      connectionString: parsedUrl.connectionString,
      activeRole: "pintpath_runtime",
      railwayStockLocalhostCaConnection: postgresTransport.nodeConnection,
      applicationName: "pintpath-web",
      maxConnections: POSTGRES_CONNECTION_BUDGET.runtimePoolMaxConnectionsPerProcess,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 10_000,
      statementTimeoutMs: 30_000,
      idleInTransactionTimeoutMs: 30_000,
    });
    await postgresTransport.assertExact();
    let readiness;
    try {
      readiness = await dependencies.checkPostgresRuntimeReadiness(sqlDatabase);
    } finally {
      await postgresTransport.assertExact();
    }
    if (!readiness.ready) {
      const failures = [...readiness.failures].sort().join(",") || "unknown";
      throw new Error(
        `Canonical PostgreSQL runtime readiness failed: ${failures}.`,
      );
    }
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (sqlDatabase) {
      try {
        await sqlDatabase.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    try {
      await postgresTransport.close();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Canonical PostgreSQL startup and authority cleanup failed.",
      );
    }
    throw error;
  }

  const close = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await sqlDatabase.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await postgresTransport.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Canonical PostgreSQL runtime authority failed to close exactly.",
      );
    }
  };

  return {
    mode: "postgres",
    sqlDatabase,
    businessRepository: createUnavailableLegacyBusinessRepository(),
    performAccountDeletionSecretPhysicalCheckpoint:
      createPostgresAccountDeletionSecretPhysicalCheckpoint(sqlDatabase),
    postgresTransport,
    assertPostgresTransportExact: () => postgresTransport.assertExact(),
    close,
  };
}
