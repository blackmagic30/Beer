import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPrivateSecretFile } from "../src/lib/offsite-backup-download.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_PRIVATE_STORAGE_BUCKET,
  PostgresPrivateStorageRecoveryError,
  capturePostgresPrivateStorageRecovery,
  createPostgresPrivateStorageDatabaseInspector,
  createSupabasePrivateStorageRecoveryBoundary,
  type CapturePostgresPrivateStorageRecoveryResult,
  type PostgresPrivateStorageRecoveryFailureCode,
} from "../src/lib/postgres-private-storage-recovery.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const ARGUMENTS = new Set([
  "--backup-directory",
  "--backup-manifest-sha256",
  "--bucket-name-sha256",
  "--connection-url-file",
  "--connection-url-sha256",
  "--deletion-authority-directory",
  "--ledger-checkpoint-sha256",
  "--ledger-current-sha256",
  "--ledger-genesis-sha256",
  "--ledger-immutable-set-sha256",
  "--ledger-tombstone-count",
  "--output-directory",
  "--service-role-key-file",
  "--source-origin-sha256",
]);

export type PostgresPrivateStorageCaptureCliFailureCode =
  | PostgresPrivateStorageRecoveryFailureCode
  | "configuration_missing_or_unsafe"
  | "operator_guard_rejected"
  | "secret_file_unsafe"
  | "unexpected_failure";

export type PostgresPrivateStorageCaptureCliResult =
  | CapturePostgresPrivateStorageRecoveryResult
  | {
      readonly schemaVersion: 1;
      readonly kind: "pintpath-postgres-private-storage-recovery-capture";
      readonly ok: false;
      readonly failureCode: PostgresPrivateStorageCaptureCliFailureCode;
    };

export interface PostgresPrivateStorageCaptureCliDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly readSecretFile: (filePath: string) => Promise<string>;
  readonly createInspector: typeof createPostgresPrivateStorageDatabaseInspector;
  readonly createStorage: typeof createSupabasePrivateStorageRecoveryBoundary;
  readonly capture: typeof capturePostgresPrivateStorageRecovery;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly writeOutput: (value: string) => void;
}

const DEFAULT_DEPENDENCIES: PostgresPrivateStorageCaptureCliDependencies = {
  environment: process.env,
  readSecretFile: readPrivateSecretFile,
  createInspector: createPostgresPrivateStorageDatabaseInspector,
  createStorage: createSupabasePrivateStorageRecoveryBoundary,
  capture: capturePostgresPrivateStorageRecovery,
  assertMutationAllowed: assertOperatorMutationAllowed,
  writeOutput: (value) => process.stdout.write(value),
};

class CaptureCliError extends Error {
  constructor(readonly code: PostgresPrivateStorageCaptureCliFailureCode) {
    super(code);
    this.name = "CaptureCliError";
  }
}

function exactEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: "SUPABASE_URL",
): string {
  const value = environment[name];
  if (!value || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new CaptureCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function exactCount(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value))
    throw new CaptureCliError("invalid_arguments");
  const count = Number(value);
  if (!Number.isSafeInteger(count))
    throw new CaptureCliError("invalid_arguments");
  return count;
}

function exactSecretFilePath(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw new CaptureCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function failureCode(
  error: unknown,
): PostgresPrivateStorageCaptureCliFailureCode {
  if (error instanceof CaptureCliError) return error.code;
  if (error instanceof PostgresPrivateStorageRecoveryError) return error.code;
  return "unexpected_failure";
}

async function secret(
  dependencies: PostgresPrivateStorageCaptureCliDependencies,
  value: string,
): Promise<string> {
  try {
    return await dependencies.readSecretFile(value);
  } catch {
    throw new CaptureCliError("secret_file_unsafe");
  }
}

export async function runPostgresPrivateStorageCaptureCli(
  argv: readonly string[],
  overrides: Partial<PostgresPrivateStorageCaptureCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresPrivateStorageCaptureCliDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  try {
    let args: Map<string, string>;
    try {
      args = parseStrictArguments(argv, {
        allowed: ARGUMENTS,
        required: ARGUMENTS,
      });
    } catch {
      throw new CaptureCliError("invalid_arguments");
    }
    try {
      dependencies.assertMutationAllowed(
        "Postgres private Storage recovery capture",
      );
    } catch {
      throw new CaptureCliError("operator_guard_rejected");
    }
    const connectionUrlFile = exactSecretFilePath(
      args.get("--connection-url-file")!,
    );
    const serviceRoleKeyFile = exactSecretFilePath(
      args.get("--service-role-key-file")!,
    );
    const [connectionString, serviceRoleKey] = await Promise.all([
      secret(dependencies, connectionUrlFile),
      secret(dependencies, serviceRoleKeyFile),
    ]);
    const sourceSupabaseUrl = exactEnvironment(
      dependencies.environment,
      "SUPABASE_URL",
    );
    const inspectSourceDatabase = dependencies.createInspector({
      connectionString,
      expectedConnectionUrlSha256: args.get("--connection-url-sha256")!,
    });
    const sourceStorage = dependencies.createStorage({
      supabaseUrl: sourceSupabaseUrl,
      serviceRoleKey,
      bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
    });
    const result = await dependencies.capture({
      backupDirectory: args.get("--backup-directory")!,
      expectedBackupManifestSha256: args.get("--backup-manifest-sha256")!,
      deletionAuthorityDirectory: args.get("--deletion-authority-directory")!,
      expectedLedgerCurrentSha256: args.get("--ledger-current-sha256")!,
      expectedLedgerGenesisSha256: args.get("--ledger-genesis-sha256")!,
      expectedLedgerCheckpointSha256: args.get("--ledger-checkpoint-sha256")!,
      expectedLedgerImmutableSetSha256: args.get(
        "--ledger-immutable-set-sha256",
      )!,
      expectedTombstoneCount: exactCount(args.get("--ledger-tombstone-count")!),
      sourceSupabaseUrl,
      expectedSourceOriginSha256: args.get("--source-origin-sha256")!,
      bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
      expectedBucketNameSha256: args.get("--bucket-name-sha256")!,
      outputDirectory: args.get("--output-directory")!,
      inspectSourceDatabase,
      sourceStorage,
    });
    dependencies.writeOutput(canonicalPostgresBackupJson(result));
    return 0;
  } catch (error) {
    const result: PostgresPrivateStorageCaptureCliResult = {
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-capture",
      ok: false,
      failureCode: failureCode(error),
    };
    dependencies.writeOutput(canonicalPostgresBackupJson(result));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresPrivateStorageCaptureCli(
    process.argv.slice(2),
  );
}
