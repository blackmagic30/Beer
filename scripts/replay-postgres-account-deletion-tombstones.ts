import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_ENV,
  POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
  PostgresAccountDeletionReplayError,
  replayPostgresAccountDeletionTombstones,
  type PostgresAccountDeletionReplayFailureCode,
  type PostgresAccountDeletionReplayResult,
  type ReplayPostgresAccountDeletionTombstonesOptions,
} from "../src/lib/postgres-account-deletion-replay.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const ARGUMENTS = new Set([
  "--base-restore-receipt",
  "--deletion-ledger-authority-directory",
  "--expected-ledger-checkpoint-sha256",
  "--expected-ledger-current-sha256",
  "--expected-ledger-genesis-sha256",
  "--expected-ledger-immutable-set-sha256",
  "--expected-target-identity-sha256",
  "--expected-tombstone-count",
  "--receipt",
  "--runtime-url-file",
]);

export interface PostgresAccountDeletionReplayCliDependencies {
  readonly replay: (
    options: ReplayPostgresAccountDeletionTombstonesOptions,
  ) => Promise<PostgresAccountDeletionReplayResult>;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly writeOutput: (value: string) => void;
}

interface SafeCliFailure {
  readonly schemaVersion: 1;
  readonly ok: false;
  readonly failureCode: PostgresAccountDeletionReplayFailureCode | "unexpected_failure";
  readonly targetDisposalRequired: boolean;
}

const DEFAULT_DEPENDENCIES: PostgresAccountDeletionReplayCliDependencies = {
  replay: replayPostgresAccountDeletionTombstones,
  assertMutationAllowed: assertOperatorMutationAllowed,
  writeOutput: (value) => process.stdout.write(value),
};

function exactAbsolutePath(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    throw new PostgresAccountDeletionReplayError("invalid_arguments");
  }
  return value;
}

function exactPositiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new PostgresAccountDeletionReplayError("invalid_arguments");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new PostgresAccountDeletionReplayError("invalid_arguments");
  }
  return parsed;
}

function safeFailure(error: unknown): SafeCliFailure {
  const failureCode = error instanceof PostgresAccountDeletionReplayError
    ? error.code
    : "unexpected_failure";
  return {
    schemaVersion: 1,
    ok: false,
    failureCode,
    targetDisposalRequired: failureCode.endsWith("_target_disposal_required"),
  };
}

export async function runPostgresAccountDeletionReplayCli(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Partial<PostgresAccountDeletionReplayCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresAccountDeletionReplayCliDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  try {
    const args = parseStrictArguments(argv, { allowed: ARGUMENTS, required: ARGUMENTS });
    if (
      environment[POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_ENV]
      !== POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE
    ) throw new PostgresAccountDeletionReplayError("confirmation_required");
    try {
      dependencies.assertMutationAllowed("Postgres account-deletion tombstone replay");
    } catch {
      throw new PostgresAccountDeletionReplayError("operator_guard_rejected");
    }
    const result = await dependencies.replay({
      runtimeUrlFile: exactAbsolutePath(args.get("--runtime-url-file")!),
      baseRestoreReceiptFile: exactAbsolutePath(args.get("--base-restore-receipt")!),
      deletionLedgerAuthorityDirectory: exactAbsolutePath(
        args.get("--deletion-ledger-authority-directory")!,
      ),
      expectedTargetIdentitySha256: args.get("--expected-target-identity-sha256")!,
      expectedLedgerCurrentSha256: args.get("--expected-ledger-current-sha256")!,
      expectedLedgerGenesisSha256: args.get("--expected-ledger-genesis-sha256")!,
      expectedLedgerCheckpointSha256: args.get("--expected-ledger-checkpoint-sha256")!,
      expectedLedgerImmutableSetSha256:
        args.get("--expected-ledger-immutable-set-sha256")!,
      expectedTombstoneCount: exactPositiveInteger(args.get("--expected-tombstone-count")!),
      receiptFile: exactAbsolutePath(args.get("--receipt")!),
      confirmation: POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
    });
    dependencies.writeOutput(canonicalPostgresBackupJson({
      schemaVersion: 1,
      ok: true,
      receiptSha256: result.receiptSha256,
      targetIdentitySha256: result.targetIdentitySha256,
      ledgerCurrentSha256: result.ledgerCurrentSha256,
      ledgerTombstoneCount: result.ledgerTombstoneCount,
      seen: result.seen,
      newlyApplied: result.newlyApplied,
      alreadyApplied: result.alreadyApplied,
      missing: result.missing,
      failed: result.failed,
      semanticProjectionSha256: result.semanticProjectionSha256,
    }));
    return 0;
  } catch (error) {
    dependencies.writeOutput(canonicalPostgresBackupJson(safeFailure(error)));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresAccountDeletionReplayCli(process.argv.slice(2));
}
