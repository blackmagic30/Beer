import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkPostgresRuntimeReadiness } from "../src/db/postgres-runtime.js";
import {
  createPostgresDatabase,
  type PostgresDatabaseOptions,
  type SqlDatabase,
} from "../src/db/sql-database.js";
import { SystemStateRepository } from "../src/db/system-state.repository.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  assertPostgresLogicalOffsiteDestinationPins,
  inspectPostgresLogicalRuntimeDatabaseIdentity,
  PostgresLogicalOffsiteError,
} from "../src/lib/postgres-logical-offsite.js";
import {
  createSupabasePostgresLogicalOffsiteRetrievalStorage,
  PostgresLogicalOffsiteRetrievalError,
  retrievePostgresLogicalOffsiteBackup,
  type PostgresLogicalOffsiteRetrievalFailureCode,
  type PostgresLogicalOffsiteRetrievalResult,
  type PostgresLogicalOffsiteRetrievalStateAuthority,
  type PostgresLogicalOffsiteRetrievalStorage,
} from "../src/lib/postgres-logical-offsite-retrieval.js";
import { readPrivateSecretFile } from "../src/lib/offsite-backup-download.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const ARGUMENTS = new Set([
  "--expected-bucket-name-sha256",
  "--expected-destination-origin-sha256",
  "--expected-success-state-sha256",
  "--output-directory",
  "--runtime-database-url-file",
  "--service-role-key-file",
]);

export type PostgresLogicalOffsiteRetrievalCliFailureCode =
  | PostgresLogicalOffsiteRetrievalFailureCode
  | "configuration_missing_or_unsafe"
  | "secret_file_unsafe"
  | "runtime_adapter_failed"
  | "runtime_not_ready"
  | "runtime_identity_unavailable"
  | "runtime_close_failed"
  | "unexpected_failure";

export interface PostgresLogicalOffsiteRetrievalCliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal | undefined;
  readonly readSecretFile: (filename: string) => Promise<string>;
  readonly createDatabase: (options: PostgresDatabaseOptions) => SqlDatabase;
  readonly checkRuntime: typeof checkPostgresRuntimeReadiness;
  readonly inspectRuntimeIdentity: typeof inspectPostgresLogicalRuntimeDatabaseIdentity;
  readonly createStateAuthority: (
    database: SqlDatabase,
  ) => PostgresLogicalOffsiteRetrievalStateAuthority;
  readonly createStorage: (input: {
    readonly destinationSupabaseUrl: string;
    readonly destinationServiceRoleKey: string;
    readonly bucketName: string;
  }) => PostgresLogicalOffsiteRetrievalStorage;
  readonly retrieve: (input: {
    readonly outputDirectory: string;
    readonly expectedSuccessStateSha256: string;
    readonly runtimeDatabaseIdentitySha256: string;
    readonly sourceSupabaseUrl: string;
    readonly destinationSupabaseUrl: string;
    readonly expectedDestinationOriginSha256: string;
    readonly bucketName: string;
    readonly expectedBucketNameSha256: string;
    readonly state: PostgresLogicalOffsiteRetrievalStateAuthority;
    readonly storage: PostgresLogicalOffsiteRetrievalStorage;
    readonly signal?: AbortSignal | undefined;
  }) => Promise<PostgresLogicalOffsiteRetrievalResult>;
  readonly writeOutput: (value: string) => void;
}

const DEFAULT_DEPENDENCIES: PostgresLogicalOffsiteRetrievalCliDependencies = {
  env: process.env,
  signal: undefined,
  readSecretFile: readPrivateSecretFile,
  createDatabase: createPostgresDatabase,
  checkRuntime: checkPostgresRuntimeReadiness,
  inspectRuntimeIdentity: inspectPostgresLogicalRuntimeDatabaseIdentity,
  createStateAuthority: (database) => {
    const repository = new SystemStateRepository(database);
    return {
      get: (key) => repository.get<Record<string, unknown>>(key),
    };
  },
  createStorage: (input) => (
    createSupabasePostgresLogicalOffsiteRetrievalStorage(input)
  ),
  retrieve: retrievePostgresLogicalOffsiteBackup,
  writeOutput: (value) => process.stdout.write(value),
};

class SafeCliError extends Error {
  constructor(readonly code: PostgresLogicalOffsiteRetrievalCliFailureCode) {
    super(code);
    this.name = "SafeCliError";
  }
}

function exactAbsolutePath(value: string): string {
  if (
    !path.isAbsolute(value)
    || path.resolve(value) !== value
    || value.includes("\0")
  ) throw new SafeCliError("configuration_missing_or_unsafe");
  return value;
}

function exactEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: "SUPABASE_URL" | "OFFSITE_BACKUP_SUPABASE_URL",
): string {
  const value = environment[name]?.trim();
  if (!value || value !== environment[name]) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function normalizeTlsPostgresUrl(value: string): string {
  try {
    if (/\u0000|\r|\n/.test(value)) throw new Error("unsafe");
    const parsed = new URL(value);
    const sslModes = parsed.searchParams.getAll("sslmode");
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol)
      || !parsed.username
      || !parsed.password
      || !parsed.hostname
      || !parsed.pathname.replace(/^\//, "")
      || parsed.hash
      || sslModes.length !== 1
      || [...parsed.searchParams.keys()].some((key) => key !== "sslmode")
      || !["require", "verify-ca", "verify-full"].includes(
        sslModes[0]!.toLowerCase(),
      )
    ) throw new Error("unsafe");
    parsed.searchParams.set("uselibpqcompat", "true");
    return parsed.toString();
  } catch {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
}

function safeFailureCode(
  error: unknown,
): PostgresLogicalOffsiteRetrievalCliFailureCode {
  if (error instanceof SafeCliError || error instanceof PostgresLogicalOffsiteRetrievalError) {
    return error.code;
  }
  if (error instanceof PostgresLogicalOffsiteError) {
    if (error.code === "runtime_identity_unavailable") return error.code;
    if (error.code === "destination_unsafe") return error.code;
    if (error.code === "invalid_arguments") return error.code;
  }
  return "unexpected_failure";
}

function write(
  dependencies: PostgresLogicalOffsiteRetrievalCliDependencies,
  value: unknown,
): void {
  dependencies.writeOutput(canonicalPostgresBackupJson(value));
}

export async function runPostgresLogicalOffsiteRetrievalCli(
  argv: readonly string[],
  overrides: Partial<PostgresLogicalOffsiteRetrievalCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresLogicalOffsiteRetrievalCliDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  let database: SqlDatabase | null = null;
  let result: PostgresLogicalOffsiteRetrievalResult | null = null;
  let failureCode: PostgresLogicalOffsiteRetrievalCliFailureCode | null = null;
  try {
    const args = parseStrictArguments(argv, {
      allowed: ARGUMENTS,
      required: ARGUMENTS,
    });
    const outputDirectory = exactAbsolutePath(args.get("--output-directory")!);
    const runtimeDatabaseUrlFile = exactAbsolutePath(
      args.get("--runtime-database-url-file")!,
    );
    const serviceRoleKeyFile = exactAbsolutePath(args.get("--service-role-key-file")!);
    const sourceSupabaseUrl = exactEnvironment(dependencies.env, "SUPABASE_URL");
    const destinationSupabaseUrl = exactEnvironment(
      dependencies.env,
      "OFFSITE_BACKUP_SUPABASE_URL",
    );
    const bucketName = dependencies.env.OFFSITE_BACKUP_BUCKET?.trim()
      || "pintpath-backups";
    try {
      assertPostgresLogicalOffsiteDestinationPins({
        destinationSupabaseUrl,
        bucketName,
        expectedDestinationOriginSha256:
          args.get("--expected-destination-origin-sha256")!,
        expectedBucketNameSha256: args.get("--expected-bucket-name-sha256")!,
      });
    } catch {
      throw new SafeCliError("destination_unsafe");
    }
    let runtimeUrl: string;
    let destinationServiceRoleKey: string;
    try {
      [runtimeUrl, destinationServiceRoleKey] = await Promise.all([
        dependencies.readSecretFile(runtimeDatabaseUrlFile),
        dependencies.readSecretFile(serviceRoleKeyFile),
      ]);
      if (/\u0000|\r|\n/.test(destinationServiceRoleKey)) throw new Error("unsafe");
    } catch {
      throw new SafeCliError("secret_file_unsafe");
    }
    try {
      database = dependencies.createDatabase({
        connectionString: normalizeTlsPostgresUrl(runtimeUrl),
        applicationName: "pintpath-logical-offsite-retriever",
        maxConnections: 1,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 10_000,
        statementTimeoutMs: 15_000,
        idleInTransactionTimeoutMs: 10_000,
      });
    } catch (error) {
      if (error instanceof SafeCliError) throw error;
      throw new SafeCliError("runtime_adapter_failed");
    }
    try {
      const readiness = await dependencies.checkRuntime(database);
      if (!readiness.ready) throw new SafeCliError("runtime_not_ready");
    } catch (error) {
      if (error instanceof SafeCliError) throw error;
      throw new SafeCliError("runtime_not_ready");
    }
    let runtimeDatabaseIdentitySha256: string;
    try {
      runtimeDatabaseIdentitySha256 = await dependencies.inspectRuntimeIdentity(database);
    } catch (error) {
      if (error instanceof PostgresLogicalOffsiteError) throw error;
      throw new SafeCliError("runtime_identity_unavailable");
    }
    const state = dependencies.createStateAuthority(database);
    const storage = dependencies.createStorage({
      destinationSupabaseUrl,
      destinationServiceRoleKey,
      bucketName,
    });
    result = await dependencies.retrieve({
      outputDirectory,
      expectedSuccessStateSha256: args.get("--expected-success-state-sha256")!,
      runtimeDatabaseIdentitySha256,
      sourceSupabaseUrl,
      destinationSupabaseUrl,
      expectedDestinationOriginSha256:
        args.get("--expected-destination-origin-sha256")!,
      bucketName,
      expectedBucketNameSha256: args.get("--expected-bucket-name-sha256")!,
      state,
      storage,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
  } catch (error) {
    failureCode = safeFailureCode(error);
  } finally {
    if (database) {
      try {
        await database.close();
      } catch {
        failureCode = "runtime_close_failed";
        result = null;
      }
    }
  }
  if (!result || failureCode) {
    write(dependencies, {
      schemaVersion: 1,
      ok: false,
      failureCode: failureCode ?? "unexpected_failure",
    });
    return 1;
  }
  write(dependencies, result);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    process.exitCode = await runPostgresLogicalOffsiteRetrievalCli(
      process.argv.slice(2),
      { signal: controller.signal },
    );
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
