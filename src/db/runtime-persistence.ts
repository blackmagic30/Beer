import {
  createPostgresAccountDeletionSecretPhysicalCheckpoint,
  type AccountDeletionSecretPhysicalCheckpoint,
} from "../lib/account-deletion-secret-checkpoint.js";
import type { BusinessRepository } from "./business.repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabaseOptions,
  type SqlDatabase,
} from "./sql-database.js";
import { checkPostgresRuntimeReadiness } from "./postgres-runtime.js";

export type RuntimePersistenceMode =
  "postgres" | "sqlite" | "sqlite_restore_read_only";

export interface RuntimePersistence {
  mode: RuntimePersistenceMode;
  sqlDatabase: SqlDatabase;
  businessRepository: BusinessRepository;
  performAccountDeletionSecretPhysicalCheckpoint: AccountDeletionSecretPhysicalCheckpoint;
}

interface SqliteRuntimePersistence {
  sqlDatabase: SqlDatabase;
  businessRepository: BusinessRepository;
  performAccountDeletionSecretPhysicalCheckpoint: AccountDeletionSecretPhysicalCheckpoint;
}

export interface RuntimePersistenceDependencies {
  createPostgresDatabase(options: PostgresDatabaseOptions): SqlDatabase;
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
  databaseUrl?: string | undefined;
}): boolean {
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

  const sqlDatabase = dependencies.createPostgresDatabase({
    connectionString: input.databaseUrl,
    applicationName: "pintpath-web",
    maxConnections: 8,
    idleTimeoutMs: 30_000,
    connectionTimeoutMs: 10_000,
    statementTimeoutMs: 30_000,
    idleInTransactionTimeoutMs: 30_000,
  });
  try {
    const readiness =
      await dependencies.checkPostgresRuntimeReadiness(sqlDatabase);
    if (!readiness.ready) {
      const failures = [...readiness.failures].sort().join(",") || "unknown";
      throw new Error(
        `Canonical PostgreSQL runtime readiness failed: ${failures}.`,
      );
    }
  } catch (error) {
    await sqlDatabase.close().catch(() => undefined);
    throw error;
  }

  return {
    mode: "postgres",
    sqlDatabase,
    businessRepository: createUnavailableLegacyBusinessRepository(),
    performAccountDeletionSecretPhysicalCheckpoint:
      createPostgresAccountDeletionSecretPhysicalCheckpoint(sqlDatabase),
  };
}
