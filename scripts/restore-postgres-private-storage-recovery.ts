import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPrivateSecretFile } from "../src/lib/offsite-backup-download.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_PRIVATE_STORAGE_BUCKET,
  POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_ENV,
  POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_VALUE,
  PostgresPrivateStorageRecoveryError,
  createPostgresPrivateStorageDatabaseInspector,
  createSupabasePrivateStorageRecoveryBoundary,
  restorePostgresPrivateStorageRecovery,
  type PostgresPrivateStorageRecoveryFailureCode,
  type RestorePostgresPrivateStorageRecoveryResult,
} from "../src/lib/postgres-private-storage-recovery.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const ARGUMENTS = new Set([
  "--backup-directory",
  "--backup-manifest-sha256",
  "--bucket-name-sha256",
  "--destination-origin-sha256",
  "--forbidden-origin-sha256s",
  "--recovery-manifest-sha256",
  "--recovery-set-directory",
  "--recovery-set-sha256",
  "--service-role-key-file",
  "--target-connection-url-file",
  "--target-connection-url-sha256",
  "--target-database-identity-sha256",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type PostgresPrivateStorageRestoreCliFailureCode =
  | PostgresPrivateStorageRecoveryFailureCode
  | "configuration_missing_or_unsafe"
  | "confirmation_required"
  | "operator_guard_rejected"
  | "secret_file_unsafe"
  | "unexpected_failure";

export type PostgresPrivateStorageRestoreCliResult =
  | RestorePostgresPrivateStorageRecoveryResult
  | {
      readonly schemaVersion: 1;
      readonly kind: "pintpath-postgres-private-storage-recovery-restore";
      readonly ok: false;
      readonly failureCode: PostgresPrivateStorageRestoreCliFailureCode;
      readonly destinationDisposalRequired: boolean;
    };

export interface PostgresPrivateStorageRestoreCliDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly readSecretFile: (filePath: string) => Promise<string>;
  readonly createInspector: typeof createPostgresPrivateStorageDatabaseInspector;
  readonly createStorage: typeof createSupabasePrivateStorageRecoveryBoundary;
  readonly restore: typeof restorePostgresPrivateStorageRecovery;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly writeOutput: (value: string) => void;
}

const DEFAULT_DEPENDENCIES: PostgresPrivateStorageRestoreCliDependencies = {
  environment: process.env,
  readSecretFile: readPrivateSecretFile,
  createInspector: createPostgresPrivateStorageDatabaseInspector,
  createStorage: createSupabasePrivateStorageRecoveryBoundary,
  restore: restorePostgresPrivateStorageRecovery,
  assertMutationAllowed: assertOperatorMutationAllowed,
  writeOutput: (value) => process.stdout.write(value),
};

class RestoreCliError extends Error {
  constructor(readonly code: PostgresPrivateStorageRestoreCliFailureCode) {
    super(code);
    this.name = "RestoreCliError";
  }
}

function exactEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: "RESTORE_SUPABASE_URL",
): string {
  const value = environment[name];
  if (!value || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new RestoreCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function forbiddenHashes(value: string): readonly string[] {
  const hashes = value.split(",");
  if (
    hashes.length < 1 ||
    hashes.some((hash) => !SHA256_PATTERN.test(hash)) ||
    new Set(hashes).size !== hashes.length
  )
    throw new RestoreCliError("invalid_arguments");
  return Object.freeze(hashes);
}

function exactSecretFilePath(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw new RestoreCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function failureCode(
  error: unknown,
): PostgresPrivateStorageRestoreCliFailureCode {
  if (error instanceof RestoreCliError) return error.code;
  if (error instanceof PostgresPrivateStorageRecoveryError) return error.code;
  return "unexpected_failure";
}

async function secret(
  dependencies: PostgresPrivateStorageRestoreCliDependencies,
  value: string,
): Promise<string> {
  try {
    return await dependencies.readSecretFile(value);
  } catch {
    throw new RestoreCliError("secret_file_unsafe");
  }
}

export async function runPostgresPrivateStorageRestoreCli(
  argv: readonly string[],
  overrides: Partial<PostgresPrivateStorageRestoreCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresPrivateStorageRestoreCliDependencies = {
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
      throw new RestoreCliError("invalid_arguments");
    }
    if (
      dependencies.environment[
        POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_ENV
      ] !== POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_VALUE
    )
      throw new RestoreCliError("confirmation_required");
    try {
      dependencies.assertMutationAllowed(
        "Postgres private Storage recovery restore rehearsal",
      );
    } catch {
      throw new RestoreCliError("operator_guard_rejected");
    }
    const targetConnectionUrlFile = exactSecretFilePath(
      args.get("--target-connection-url-file")!,
    );
    const serviceRoleKeyFile = exactSecretFilePath(
      args.get("--service-role-key-file")!,
    );
    const [connectionString, serviceRoleKey] = await Promise.all([
      secret(dependencies, targetConnectionUrlFile),
      secret(dependencies, serviceRoleKeyFile),
    ]);
    const destinationSupabaseUrl = exactEnvironment(
      dependencies.environment,
      "RESTORE_SUPABASE_URL",
    );
    const inspectTargetDatabase = dependencies.createInspector({
      connectionString,
      expectedConnectionUrlSha256: args.get("--target-connection-url-sha256")!,
    });
    const destinationStorage = dependencies.createStorage({
      supabaseUrl: destinationSupabaseUrl,
      serviceRoleKey,
      bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
    });
    const result = await dependencies.restore({
      backupDirectory: args.get("--backup-directory")!,
      expectedBackupManifestSha256: args.get("--backup-manifest-sha256")!,
      recoverySetDirectory: args.get("--recovery-set-directory")!,
      expectedRecoverySetSha256: args.get("--recovery-set-sha256")!,
      expectedRecoveryManifestSha256: args.get("--recovery-manifest-sha256")!,
      expectedTargetDatabaseIdentitySha256: args.get(
        "--target-database-identity-sha256",
      )!,
      expectedTargetConnectionUrlSha256: args.get(
        "--target-connection-url-sha256",
      )!,
      destinationSupabaseUrl,
      expectedDestinationOriginSha256: args.get("--destination-origin-sha256")!,
      forbiddenDestinationOriginSha256s: forbiddenHashes(
        args.get("--forbidden-origin-sha256s")!,
      ),
      bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
      expectedBucketNameSha256: args.get("--bucket-name-sha256")!,
      inspectTargetDatabase,
      destinationStorage,
    });
    dependencies.writeOutput(canonicalPostgresBackupJson(result));
    return 0;
  } catch (error) {
    const code = failureCode(error);
    const result: PostgresPrivateStorageRestoreCliResult = {
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-restore",
      ok: false,
      failureCode: code,
      destinationDisposalRequired: code.endsWith("_disposal_required"),
    };
    dependencies.writeOutput(canonicalPostgresBackupJson(result));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresPrivateStorageRestoreCli(
    process.argv.slice(2),
  );
}
