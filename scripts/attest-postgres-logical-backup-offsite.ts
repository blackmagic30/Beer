import crypto from "node:crypto";
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
  attestPostgresLogicalBackup,
  assertPostgresLogicalOffsiteDestinationPins,
  createPostgresLogicalOffsiteStateAuthority,
  createSupabasePostgresLogicalOffsiteStorage,
  inspectPostgresLogicalRuntimeDatabaseIdentity,
  PostgresLogicalOffsiteError,
  type PostgresLogicalOffsiteFailureCode,
  type PostgresLogicalOffsiteResult,
  type PostgresLogicalOffsiteStorage,
} from "../src/lib/postgres-logical-offsite.js";
import {
  openPostgresRailwayStockLocalhostCaTransport,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  PostgresRailwayStockLocalhostCaError,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import { readPrivateSecretFile } from "../src/lib/offsite-backup-download.js";
import {
  assertExactSupabaseOrigin,
  assertSupabaseServerApiKey,
  resolveExactOperationalOffsiteBackupBucket,
} from "../src/lib/supabase-key-format.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

export const POSTGRES_LOGICAL_OFFSITE_CONFIRMATION_ENV =
  "PINTPATH_POSTGRES_LOGICAL_OFFSITE" as const;
export const POSTGRES_LOGICAL_OFFSITE_CONFIRMATION_VALUE = "confirmed" as const;

const ARGUMENTS = new Set([
  "--backup-directory",
  "--backup-manifest-sha256",
  "--expected-bucket-name-sha256",
  "--expected-destination-origin-sha256",
  "--expected-runtime-root-ca-der-sha256",
  "--operator-id",
  "--runtime-root-ca-file",
  "--runtime-database-url-file",
  "--service-role-key-file",
]);

export type PostgresLogicalOffsiteCliFailureCode =
  | PostgresLogicalOffsiteFailureCode
  | "confirmation_required"
  | "operator_guard_rejected"
  | "configuration_missing_or_unsafe"
  | "secret_file_unsafe"
  | "runtime_adapter_failed"
  | "runtime_not_ready"
  | "runtime_root_ca_unsafe"
  | "runtime_root_ca_pin_mismatch"
  | "runtime_root_ca_certificate_invalid"
  | "runtime_root_ca_drift"
  | "runtime_root_ca_close_failed"
  | "runtime_close_failed"
  | "unexpected_failure";

export interface PostgresLogicalOffsiteCliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly readSecretFile: (filename: string) => Promise<string>;
  readonly getUid: () => number | null;
  readonly openRuntimeTransport: (
    options: OpenPostgresRailwayStockLocalhostCaTransportOptions,
  ) => Promise<PostgresRailwayStockLocalhostCaTransport>;
  readonly createDatabase: (options: PostgresDatabaseOptions) => SqlDatabase;
  readonly checkRuntime: typeof checkPostgresRuntimeReadiness;
  readonly inspectRuntimeIdentity: typeof inspectPostgresLogicalRuntimeDatabaseIdentity;
  readonly createStorage: (input: {
    readonly destinationSupabaseUrl: string;
    readonly destinationServiceRoleKey: string;
  }) => PostgresLogicalOffsiteStorage;
  readonly attest: (input: {
    readonly backupDirectory: string;
    readonly expectedManifestSha256: string;
    readonly runtimeDatabaseIdentitySha256: string;
    readonly runtimeConnectionUrlSha256: string;
    readonly sourceSupabaseUrl: string;
    readonly destinationSupabaseUrl: string;
    readonly expectedDestinationOriginSha256: string;
    readonly bucketName: string;
    readonly expectedBucketNameSha256: string;
    readonly operatorId: string;
    readonly storage: PostgresLogicalOffsiteStorage;
    readonly state: ReturnType<typeof createPostgresLogicalOffsiteStateAuthority>;
  }) => Promise<PostgresLogicalOffsiteResult>;
  readonly writeOutput: (value: string) => void;
}

const DEFAULT_DEPENDENCIES: PostgresLogicalOffsiteCliDependencies = {
  env: process.env,
  assertMutationAllowed: assertOperatorMutationAllowed,
  readSecretFile: readPrivateSecretFile,
  getUid: () => process.getuid?.() ?? null,
  openRuntimeTransport: (options) => (
    openPostgresRailwayStockLocalhostCaTransport(options)
  ),
  createDatabase: createPostgresDatabase,
  checkRuntime: checkPostgresRuntimeReadiness,
  inspectRuntimeIdentity: inspectPostgresLogicalRuntimeDatabaseIdentity,
  createStorage: (input) => createSupabasePostgresLogicalOffsiteStorage(input),
  attest: attestPostgresLogicalBackup,
  writeOutput: (value) => process.stdout.write(value),
};

class SafeCliError extends Error {
  constructor(readonly code: PostgresLogicalOffsiteCliFailureCode) {
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

const PRODUCTION_SUPABASE_ORIGIN = "https://auth.pintpath.au";
const OFFSITE_BACKUP_SUPABASE_ORIGIN =
  "https://hfbmhdxrwtihukmixxta.supabase.co";

interface NormalizedRuntimeDatabaseUrl {
  readonly connectionString: string;
  readonly sourceUrlAuthority: {
    readonly hostname: string;
    readonly port: number;
  };
}

function normalizeTlsPostgresUrl(value: string): NormalizedRuntimeDatabaseUrl {
  try {
    if (/\u0000|\r|\n/.test(value)) throw new Error("unsafe");
    const parsed = new URL(value);
    const sslModes = parsed.searchParams.getAll("sslmode");
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? Number(parsed.port) : 5_432;
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol)
      || !parsed.username
      || !parsed.password
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.railway\.internal$/.test(
        hostname,
      )
      || hostname !== parsed.hostname
      || port !== 5_432
      || !parsed.pathname.replace(/^\//, "")
      || parsed.hash
      || sslModes.length !== 1
      || [...parsed.searchParams.keys()].some((key) => key !== "sslmode")
      || sslModes[0]!.toLowerCase() !== "verify-full"
    ) throw new Error("unsafe");
    parsed.searchParams.set("uselibpqcompat", "true");
    return {
      connectionString: parsed.toString(),
      sourceUrlAuthority: {
        hostname,
        port,
      },
    };
  } catch {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
}

function runtimeRootCaFailureCode(
  error: PostgresRailwayStockLocalhostCaError,
): PostgresLogicalOffsiteCliFailureCode {
  switch (error.code) {
    case "root_ca_pin_mismatch":
      return "runtime_root_ca_pin_mismatch";
    case "root_ca_certificate_invalid":
      return "runtime_root_ca_certificate_invalid";
    case "transport_drift":
      return "runtime_root_ca_drift";
    case "cleanup_failed":
      return "runtime_root_ca_close_failed";
    default:
      return "runtime_root_ca_unsafe";
  }
}

function safeFailureCode(error: unknown): PostgresLogicalOffsiteCliFailureCode {
  if (error instanceof PostgresRailwayStockLocalhostCaError) {
    return runtimeRootCaFailureCode(error);
  }
  if (error instanceof SafeCliError || error instanceof PostgresLogicalOffsiteError) {
    return error.code;
  }
  return "unexpected_failure";
}

function write(
  dependencies: PostgresLogicalOffsiteCliDependencies,
  value: unknown,
): void {
  dependencies.writeOutput(canonicalPostgresBackupJson(value));
}

export async function runPostgresLogicalOffsiteCli(
  argv: readonly string[],
  overrides: Partial<PostgresLogicalOffsiteCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresLogicalOffsiteCliDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  let database: SqlDatabase | null = null;
  let runtimeTransport: PostgresRailwayStockLocalhostCaTransport | null = null;
  let result: PostgresLogicalOffsiteResult | null = null;
  let failureCode: PostgresLogicalOffsiteCliFailureCode | null = null;
  try {
    const args = parseStrictArguments(argv, {
      allowed: ARGUMENTS,
      required: ARGUMENTS,
    });
    if (
      dependencies.env[POSTGRES_LOGICAL_OFFSITE_CONFIRMATION_ENV]
      !== POSTGRES_LOGICAL_OFFSITE_CONFIRMATION_VALUE
    ) throw new SafeCliError("confirmation_required");
    try {
      dependencies.assertMutationAllowed("Postgres logical backup off-site attestation");
    } catch {
      throw new SafeCliError("operator_guard_rejected");
    }
    const backupDirectory = exactAbsolutePath(args.get("--backup-directory")!);
    const runtimeDatabaseUrlFile = exactAbsolutePath(
      args.get("--runtime-database-url-file")!,
    );
    const runtimeRootCaFile = exactAbsolutePath(
      args.get("--runtime-root-ca-file")!,
    );
    const serviceRoleKeyFile = exactAbsolutePath(args.get("--service-role-key-file")!);
    const sourceSupabaseUrl = exactEnvironment(dependencies.env, "SUPABASE_URL");
    const destinationSupabaseUrl = exactEnvironment(
      dependencies.env,
      "OFFSITE_BACKUP_SUPABASE_URL",
    );
    try {
      assertExactSupabaseOrigin(
        sourceSupabaseUrl,
        PRODUCTION_SUPABASE_ORIGIN,
        "SUPABASE_URL",
      );
      assertExactSupabaseOrigin(
        destinationSupabaseUrl,
        OFFSITE_BACKUP_SUPABASE_ORIGIN,
        "OFFSITE_BACKUP_SUPABASE_URL",
      );
    } catch {
      throw new SafeCliError("configuration_missing_or_unsafe");
    }
    let bucketName: string;
    try {
      bucketName = resolveExactOperationalOffsiteBackupBucket(
        dependencies.env.OFFSITE_BACKUP_BUCKET,
      );
    } catch {
      throw new SafeCliError("configuration_missing_or_unsafe");
    }
    assertPostgresLogicalOffsiteDestinationPins({
      destinationSupabaseUrl,
      bucketName,
      expectedDestinationOriginSha256:
        args.get("--expected-destination-origin-sha256")!,
      expectedBucketNameSha256: args.get("--expected-bucket-name-sha256")!,
    });
    let runtimeUrl: string;
    let destinationServiceRoleKey: string;
    try {
      [runtimeUrl, destinationServiceRoleKey] = await Promise.all([
        dependencies.readSecretFile(runtimeDatabaseUrlFile),
        dependencies.readSecretFile(serviceRoleKeyFile),
      ]);
      assertSupabaseServerApiKey(
        destinationServiceRoleKey,
        "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
      );
    } catch {
      throw new SafeCliError("secret_file_unsafe");
    }
    const normalizedRuntimeUrl = normalizeTlsPostgresUrl(runtimeUrl);
    let uid: number | null;
    try {
      uid = dependencies.getUid();
    } catch {
      throw new SafeCliError("runtime_root_ca_unsafe");
    }
    if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
      throw new SafeCliError("runtime_root_ca_unsafe");
    }
    runtimeTransport = await dependencies.openRuntimeTransport({
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaFile: runtimeRootCaFile,
      expectedRootCaDerSha256:
        args.get("--expected-runtime-root-ca-der-sha256")!,
      expectedUid: uid!,
      sourceUrlAuthority: normalizedRuntimeUrl.sourceUrlAuthority,
    });
    await runtimeTransport.assertExact();
    try {
      database = dependencies.createDatabase({
        connectionString: normalizedRuntimeUrl.connectionString,
        activeRole: "pintpath_runtime",
        railwayStockLocalhostCaConnection: runtimeTransport.nodeConnection,
        applicationName: "pintpath-logical-backup-offsite-attestor",
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
    await runtimeTransport.assertExact();
    try {
      const readiness = await dependencies.checkRuntime(database);
      if (!readiness.ready) throw new SafeCliError("runtime_not_ready");
    } catch (error) {
      if (error instanceof SafeCliError) throw error;
      throw new SafeCliError("runtime_not_ready");
    }
    await runtimeTransport.assertExact();
    let runtimeDatabaseIdentitySha256: string;
    try {
      runtimeDatabaseIdentitySha256 = await dependencies.inspectRuntimeIdentity(database);
    } catch (error) {
      if (error instanceof PostgresLogicalOffsiteError) throw error;
      throw new SafeCliError("runtime_identity_unavailable");
    }
    await runtimeTransport.assertExact();
    const runtimeConnectionUrlSha256 = crypto
      .createHash("sha256")
      .update(runtimeUrl, "utf8")
      .digest("hex");
    const storage = dependencies.createStorage({
      destinationSupabaseUrl,
      destinationServiceRoleKey,
    });
    result = await dependencies.attest({
      backupDirectory,
      expectedManifestSha256: args.get("--backup-manifest-sha256")!,
      runtimeDatabaseIdentitySha256,
      runtimeConnectionUrlSha256,
      sourceSupabaseUrl,
      destinationSupabaseUrl,
      expectedDestinationOriginSha256:
        args.get("--expected-destination-origin-sha256")!,
      bucketName,
      expectedBucketNameSha256: args.get("--expected-bucket-name-sha256")!,
      operatorId: args.get("--operator-id")!,
      storage,
      state: createPostgresLogicalOffsiteStateAuthority(
        new SystemStateRepository(database),
      ),
    });
    await runtimeTransport.assertExact();
  } catch (error) {
    failureCode = safeFailureCode(error);
  } finally {
    if (runtimeTransport) {
      try {
        await runtimeTransport.assertExact();
      } catch (error) {
        failureCode = error instanceof PostgresRailwayStockLocalhostCaError
          ? runtimeRootCaFailureCode(error)
          : "runtime_root_ca_drift";
        result = null;
      }
    }
    if (database) {
      try {
        await database.close();
      } catch {
        failureCode = "runtime_close_failed";
        result = null;
      }
    }
    if (runtimeTransport) {
      try {
        await runtimeTransport.close();
      } catch {
        failureCode = "runtime_root_ca_close_failed";
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
  process.exitCode = await runPostgresLogicalOffsiteCli(process.argv.slice(2));
}
