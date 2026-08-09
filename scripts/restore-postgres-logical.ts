import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  POSTGRES_LOGICAL_RESTORE_CONFIRMATION_ENV,
  POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
  PostgresLogicalRestoreError,
  inspectPostgresLogicalRestoreTarget,
  restorePostgresLogicalBackup,
  type InspectPostgresLogicalRestoreTargetOptions,
  type PostgresLogicalRestoreFailureCode,
  type PostgresLogicalRestoreResult,
  type PostgresLogicalRestoreTargetInspection,
  type RestorePostgresLogicalBackupOptions,
} from "../src/lib/postgres-logical-restore.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const INSPECT_ARGUMENTS = new Set(["--target-url-file"]);
const RESTORE_ARGUMENTS = new Set([
  "--backup-directory",
  "--backup-manifest-sha256",
  "--receipt",
  "--target-identity-sha256",
  "--target-url-file",
]);

export interface PostgresLogicalRestoreCliDependencies {
  readonly inspectTarget: (
    options: InspectPostgresLogicalRestoreTargetOptions,
  ) => Promise<PostgresLogicalRestoreTargetInspection>;
  readonly restoreBackup: (
    options: RestorePostgresLogicalBackupOptions,
  ) => Promise<PostgresLogicalRestoreResult>;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly writeOutput: (value: string) => void;
}

interface SafeCliFailure {
  readonly schemaVersion: 1;
  readonly ok: false;
  readonly failureCode: PostgresLogicalRestoreFailureCode | "unexpected_failure";
  readonly targetDisposalRequired: boolean;
}

const DEFAULT_DEPENDENCIES: PostgresLogicalRestoreCliDependencies = {
  inspectTarget: inspectPostgresLogicalRestoreTarget,
  restoreBackup: restorePostgresLogicalBackup,
  assertMutationAllowed: assertOperatorMutationAllowed,
  writeOutput: (value) => process.stdout.write(value),
};

function exactAbsolutePath(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    throw new PostgresLogicalRestoreError("invalid_arguments");
  }
  return value;
}

function safeFailure(error: unknown): SafeCliFailure {
  const failureCode = error instanceof PostgresLogicalRestoreError
    ? error.code
    : "unexpected_failure";
  return {
    schemaVersion: 1,
    ok: false,
    failureCode,
    targetDisposalRequired: failureCode.endsWith("_target_disposal_required"),
  };
}

export async function runPostgresLogicalRestoreCli(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Partial<PostgresLogicalRestoreCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresLogicalRestoreCliDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  try {
    const [subcommand, ...rawArguments] = argv;
    if (subcommand === "inspect-target") {
      const args = parseStrictArguments(rawArguments, {
        allowed: INSPECT_ARGUMENTS,
        required: INSPECT_ARGUMENTS,
      });
      const result = await dependencies.inspectTarget({
        targetUrlFile: exactAbsolutePath(args.get("--target-url-file")!),
      });
      dependencies.writeOutput(canonicalPostgresBackupJson({
        schemaVersion: 1,
        ok: true,
        command: "inspect-target",
        targetIdentitySha256: result.targetIdentitySha256,
        disposableTarget: result.disposableTarget,
        privateSchemasAbsent: result.privateSchemasAbsent,
      }));
      return 0;
    }
    if (subcommand !== "restore") throw new PostgresLogicalRestoreError("invalid_arguments");
    const args = parseStrictArguments(rawArguments, {
      allowed: RESTORE_ARGUMENTS,
      required: RESTORE_ARGUMENTS,
    });
    if (
      environment[POSTGRES_LOGICAL_RESTORE_CONFIRMATION_ENV]
      !== POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE
    ) throw new PostgresLogicalRestoreError("confirmation_required");
    try {
      dependencies.assertMutationAllowed("Postgres logical restore rehearsal");
    } catch {
      throw new PostgresLogicalRestoreError("operator_guard_rejected");
    }
    const result = await dependencies.restoreBackup({
      backupDirectory: exactAbsolutePath(args.get("--backup-directory")!),
      expectedBackupManifestSha256: args.get("--backup-manifest-sha256")!,
      targetUrlFile: exactAbsolutePath(args.get("--target-url-file")!),
      expectedTargetIdentitySha256: args.get("--target-identity-sha256")!,
      receiptFile: exactAbsolutePath(args.get("--receipt")!),
      confirmation: POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
    });
    dependencies.writeOutput(canonicalPostgresBackupJson({
      schemaVersion: 1,
      ok: true,
      command: "restore",
      receiptSha256: result.receiptSha256,
      backupManifestSha256: result.backupManifestSha256,
      backupArchiveSha256: result.backupArchiveSha256,
      targetIdentitySha256: result.targetIdentitySha256,
      authoritativeRowCount: result.authoritativeRowCount,
      nonEmptyAuthoritativeTableCount: result.nonEmptyAuthoritativeTableCount,
      authoritativeCountInventorySha256: result.authoritativeCountInventorySha256,
      overallStateSha256: result.overallStateSha256,
      promotionReconciliationReady: result.promotionReconciliationReady,
      sourceStateBindingStatus: result.sourceStateBindingStatus,
    }));
    return 0;
  } catch (error) {
    dependencies.writeOutput(canonicalPostgresBackupJson(safeFailure(error)));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresLogicalRestoreCli(process.argv.slice(2));
}
