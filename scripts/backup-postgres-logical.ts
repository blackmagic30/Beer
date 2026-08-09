import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictArguments } from "./lib/strict-arguments.js";
import {
  canonicalPostgresBackupJson,
  createPostgresLogicalBackup,
  PostgresLogicalBackupError,
  type PostgresLogicalBackupDependencies,
  type PostgresLogicalBackupFailureCode,
  type PostgresLogicalBackupResult,
} from "../src/lib/postgres-logical-backup.js";

export interface PostgresLogicalBackupCliFailure {
  schemaVersion: 1;
  ok: false;
  failureCode: PostgresLogicalBackupFailureCode;
}

export interface PostgresLogicalBackupCliSuccess {
  schemaVersion: 2;
  ok: true;
  archiveSha256: string;
  manifestSha256: string;
  stateReceiptSha256: string;
  authoritativeRowCount: string;
  overallStateSha256: string;
}

export interface PostgresLogicalBackupCliDependencies {
  createBackup: (
    options: { connectionFile: string; outputDirectory: string },
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
      allowed: new Set(["--connection-file", "--output"]),
      required: new Set(["--connection-file", "--output"]),
    });
    const result = await dependencies.createBackup({
      connectionFile: argumentsByName.get("--connection-file")!,
      outputDirectory: argumentsByName.get("--output")!,
    });
    const success: PostgresLogicalBackupCliSuccess = {
      schemaVersion: 2,
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
