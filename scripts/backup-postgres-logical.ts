import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictArguments } from "./lib/strict-arguments.js";
import {
  canonicalPostgresBackupJson,
  createPostgresLogicalBackup,
  PostgresLogicalBackupError,
  type CreatePostgresLogicalBackupOptions,
  type PostgresLogicalBackupDependencies,
  type PostgresLogicalBackupFailureCode,
  type PostgresLogicalBackupResult,
} from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

export interface PostgresLogicalBackupCliFailure {
  schemaVersion: 1;
  ok: false;
  failureCode: PostgresLogicalBackupFailureCode;
}

export interface PostgresLogicalBackupCliSuccess {
  schemaVersion: 3;
  ok: true;
  archiveSha256: string;
  manifestSha256: string;
  stateReceiptSha256: string;
  authoritativeRowCount: string;
  overallStateSha256: string;
}

export interface PostgresLogicalBackupCliDependencies {
  createBackup: (
    options: CreatePostgresLogicalBackupOptions,
    overrides?: Partial<PostgresLogicalBackupDependencies>,
  ) => Promise<PostgresLogicalBackupResult>;
  writeOutput: (value: string) => void;
}

const DEFAULT_CLI_DEPENDENCIES: PostgresLogicalBackupCliDependencies = {
  createBackup: createPostgresLogicalBackup,
  writeOutput: (value) => process.stdout.write(value),
};

function failureCode(error: unknown): PostgresLogicalBackupFailureCode {
  return error instanceof PostgresLogicalBackupError
    ? error.code
    : "invalid_arguments";
}

export async function runPostgresLogicalBackupCli(
  argv: readonly string[],
  overrides: Partial<PostgresLogicalBackupCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresLogicalBackupCliDependencies = {
    ...DEFAULT_CLI_DEPENDENCIES,
    ...overrides,
  };
  try {
    const argumentsByName = parseStrictArguments(argv, {
      allowed: new Set([
        "--connection-file",
        "--expected-source-url-sha256",
        "--transport-profile",
        "--root-ca-file",
        "--expected-root-ca-der-sha256",
        "--pg-dump-file",
        "--expected-pg-dump-sha256",
        "--pg-restore-file",
        "--expected-pg-restore-sha256",
        "--output",
      ]),
      required: new Set([
        "--connection-file",
        "--expected-source-url-sha256",
        "--transport-profile",
        "--root-ca-file",
        "--expected-root-ca-der-sha256",
        "--pg-dump-file",
        "--expected-pg-dump-sha256",
        "--pg-restore-file",
        "--expected-pg-restore-sha256",
        "--output",
      ]),
    });
    const transportProfile = argumentsByName.get("--transport-profile");
    if (transportProfile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE) {
      throw new PostgresLogicalBackupError("invalid_arguments");
    }
    const result = await dependencies.createBackup({
      connectionFile: argumentsByName.get("--connection-file")!,
      expectedSourceUrlSha256: argumentsByName.get("--expected-source-url-sha256")!,
      transportProfile,
      rootCaFile: argumentsByName.get("--root-ca-file")!,
      expectedRootCaDerSha256: argumentsByName.get("--expected-root-ca-der-sha256")!,
      pgDumpFile: argumentsByName.get("--pg-dump-file")!,
      expectedPgDumpSha256: argumentsByName.get("--expected-pg-dump-sha256")!,
      pgRestoreFile: argumentsByName.get("--pg-restore-file")!,
      expectedPgRestoreSha256: argumentsByName.get("--expected-pg-restore-sha256")!,
      outputDirectory: argumentsByName.get("--output")!,
    });
    const success: PostgresLogicalBackupCliSuccess = {
      schemaVersion: 3,
      ok: true,
      archiveSha256: result.archiveSha256,
      manifestSha256: result.manifestSha256,
      stateReceiptSha256: result.stateReceiptSha256,
      authoritativeRowCount: result.authoritativeRowCount,
      overallStateSha256: result.overallStateSha256,
    };
    dependencies.writeOutput(canonicalPostgresBackupJson(success));
    return 0;
  } catch (error) {
    const failure: PostgresLogicalBackupCliFailure = {
      schemaVersion: 1,
      ok: false,
      failureCode: failureCode(error),
    };
    dependencies.writeOutput(canonicalPostgresBackupJson(failure));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresLogicalBackupCli(process.argv.slice(2));
}
