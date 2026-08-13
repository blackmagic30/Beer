import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPostgresDatabase, type PostgresDatabaseOptions, type SqlDatabase } from
  "../src/db/sql-database.js";
import {
  appendAccountDeletionTombstone,
  fetchVerifiedAccountDeletionLedger,
  type AccountDeletionLedgerConfig,
  type VerifiedAccountDeletionLedger,
} from "../src/lib/offsite-backup.js";
import { readPrivateSecretFile } from "../src/lib/offsite-backup-download.js";
import {
  assertExactSupabaseOrigin,
  assertSupabaseServerApiKey,
  resolveExactOperationalOffsiteBackupBucket,
} from "../src/lib/supabase-key-format.js";
import {
  assertPostgresLogicalOffsiteDestinationPins,
} from "../src/lib/postgres-logical-offsite.js";
import { canonicalPostgresLogicalStateJson } from "../src/lib/postgres-logical-state.js";
import {
  completePostgresAccountDeletionRecoveryFixture,
  inspectPostgresAccountDeletionRecoveryFixture,
  PostgresAccountDeletionRecoveryFixtureError,
  preparePostgresAccountDeletionRecoveryFixture,
  type CompletePostgresAccountDeletionRecoveryFixtureOptions,
} from "../src/lib/postgres-account-deletion-recovery-fixture.js";
import type { AccountDeletionTombstone } from "../src/lib/data-backup.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

export const POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_ENV =
  "PINTPATH_POSTGRES_ACCOUNT_DELETION_RECOVERY_PROOF" as const;
export const POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_VALUE = "confirmed" as const;
const PRODUCTION_SUPABASE_ORIGIN = "https://auth.pintpath.au";
const OFFSITE_BACKUP_SUPABASE_ORIGIN =
  "https://hfbmhdxrwtihukmixxta.supabase.co";

const PREPARE_ARGUMENTS = new Set([
  "--runtime-database-url-file",
  "--expected-database-identity-sha256",
  "--fixture-receipt",
  "--fixture-id",
  "--prepared-at",
]);
const PREPARE_REQUIRED = new Set([
  "--runtime-database-url-file",
  "--expected-database-identity-sha256",
  "--fixture-receipt",
]);
const INSPECT_ARGUMENTS = new Set([
  "--runtime-database-url-file",
  "--fixture-receipt",
  "--fixture-receipt-sha256",
]);
const COMPLETE_ARGUMENTS = new Set([
  "--runtime-database-url-file",
  "--fixture-receipt",
  "--fixture-receipt-sha256",
  "--logical-backup-state-receipt",
  "--logical-backup-state-receipt-sha256",
  "--ledger-authority-output",
  "--completion-receipt",
  "--completed-at",
  "--service-role-key-file",
  "--expected-destination-origin-sha256",
  "--expected-bucket-name-sha256",
]);

export type PostgresAccountDeletionRecoveryCliFailureCode =
  | PostgresAccountDeletionRecoveryFixtureError["code"]
  | "invalid_arguments"
  | "confirmation_required"
  | "operator_guard_rejected"
  | "configuration_missing_or_unsafe"
  | "secret_file_unsafe"
  | "database_adapter_failed"
  | "database_close_failed"
  | "unexpected_failure";

export type PostgresAccountDeletionRecoveryCliResult =
  | {
    readonly schemaVersion: 1;
    readonly ok: true;
    readonly command: "prepare";
    readonly fixtureReceiptSha256: string;
    readonly databaseIdentitySha256: string;
    readonly preparedStateSha256: string;
  }
  | {
    readonly schemaVersion: 1;
    readonly ok: true;
    readonly command: "inspect";
    readonly phase: "prepared" | "completed";
    readonly fixtureReceiptSha256: string;
    readonly databaseIdentitySha256: string;
    readonly stateSha256: string;
  }
  | {
    readonly schemaVersion: 1;
    readonly ok: true;
    readonly command: "complete";
    readonly completionReceiptSha256: string;
    readonly databaseIdentitySha256: string;
    readonly completedStateSha256: string;
    readonly ledgerAuthoritySha256: string;
  }
  | {
    readonly schemaVersion: 1;
    readonly ok: false;
    readonly failureCode: PostgresAccountDeletionRecoveryCliFailureCode;
  };

export interface PostgresAccountDeletionRecoveryCliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readSecretFile: (filePath: string) => Promise<string>;
  readonly createDatabase: (options: PostgresDatabaseOptions) => SqlDatabase;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly assertDestinationPins: typeof assertPostgresLogicalOffsiteDestinationPins;
  readonly prepare: typeof preparePostgresAccountDeletionRecoveryFixture;
  readonly inspect: typeof inspectPostgresAccountDeletionRecoveryFixture;
  readonly complete: typeof completePostgresAccountDeletionRecoveryFixture;
  readonly appendAndFetchVerifiedLedger: (
    config: AccountDeletionLedgerConfig,
    tombstone: AccountDeletionTombstone,
  ) => Promise<VerifiedAccountDeletionLedger>;
  readonly writeOutput: (value: string) => void;
}

const DEFAULT_DEPENDENCIES: PostgresAccountDeletionRecoveryCliDependencies = {
  env: process.env,
  readSecretFile: readPrivateSecretFile,
  createDatabase: createPostgresDatabase,
  assertMutationAllowed: assertOperatorMutationAllowed,
  assertDestinationPins: assertPostgresLogicalOffsiteDestinationPins,
  prepare: preparePostgresAccountDeletionRecoveryFixture,
  inspect: inspectPostgresAccountDeletionRecoveryFixture,
  complete: completePostgresAccountDeletionRecoveryFixture,
  appendAndFetchVerifiedLedger: async (config, tombstone) => {
    await appendAccountDeletionTombstone(config, tombstone);
    return fetchVerifiedAccountDeletionLedger(config);
  },
  writeOutput: (value) => process.stdout.write(value),
};

class CliError extends Error {
  constructor(readonly code: PostgresAccountDeletionRecoveryCliFailureCode) {
    super(code);
    this.name = "CliError";
  }
}

function absolutePath(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    throw new CliError("configuration_missing_or_unsafe");
  }
  return value;
}

function exactEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: "SUPABASE_URL" | "OFFSITE_BACKUP_SUPABASE_URL",
): string {
  const value = environment[name];
  if (!value || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new CliError("configuration_missing_or_unsafe");
  }
  return value;
}

function normalizeTlsPostgresUrl(value: string): string {
  try {
    if (/[\r\n\0]/.test(value)) throw new Error("unsafe");
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
      || !["require", "verify-ca", "verify-full"].includes(sslModes[0]!.toLowerCase())
      || [...parsed.searchParams.keys()].some((key) => !["sslmode", "sslrootcert"].includes(key))
    ) throw new Error("unsafe");
    parsed.searchParams.set("uselibpqcompat", "true");
    return parsed.toString();
  } catch {
    throw new CliError("configuration_missing_or_unsafe");
  }
}

function safeFailure(error: unknown): PostgresAccountDeletionRecoveryCliFailureCode {
  if (
    error instanceof CliError
    || error instanceof PostgresAccountDeletionRecoveryFixtureError
  ) return error.code;
  return "unexpected_failure";
}

function assertConfirmed(
  dependencies: PostgresAccountDeletionRecoveryCliDependencies,
  operation: string,
): void {
  if (
    dependencies.env[POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_ENV]
    !== POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_VALUE
  ) throw new CliError("confirmation_required");
  try {
    dependencies.assertMutationAllowed(operation);
  } catch {
    throw new CliError("operator_guard_rejected");
  }
}

async function createRuntimeDatabase(
  dependencies: PostgresAccountDeletionRecoveryCliDependencies,
  filePath: string,
): Promise<SqlDatabase> {
  let databaseUrl: string;
  try {
    databaseUrl = await dependencies.readSecretFile(absolutePath(filePath));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("secret_file_unsafe");
  }
  try {
    return dependencies.createDatabase({
      connectionString: normalizeTlsPostgresUrl(databaseUrl),
      applicationName: "pintpath-account-deletion-recovery-proof",
      maxConnections: 1,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 10_000,
      statementTimeoutMs: 30_000,
      idleInTransactionTimeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("database_adapter_failed");
  }
}

async function runCommand(
  argv: readonly string[],
  dependencies: PostgresAccountDeletionRecoveryCliDependencies,
): Promise<PostgresAccountDeletionRecoveryCliResult> {
  const [command, ...rawArguments] = argv;
  if (!command || !["prepare", "inspect", "complete"].includes(command)) {
    throw new CliError("invalid_arguments");
  }
  let database: SqlDatabase | null = null;
  let result: PostgresAccountDeletionRecoveryCliResult;
  try {
    if (command === "prepare") {
      let args: Map<string, string>;
      try {
        args = parseStrictArguments(rawArguments, {
          allowed: PREPARE_ARGUMENTS,
          required: PREPARE_REQUIRED,
        });
      } catch {
        throw new CliError("invalid_arguments");
      }
      assertConfirmed(dependencies, "PostgreSQL account-deletion recovery fixture preparation");
      database = await createRuntimeDatabase(dependencies, args.get("--runtime-database-url-file")!);
      const prepared = await dependencies.prepare({
        database,
        receiptFile: absolutePath(args.get("--fixture-receipt")!),
        expectedDatabaseIdentitySha256: args.get("--expected-database-identity-sha256")!,
        ...(args.has("--fixture-id") ? { fixtureId: args.get("--fixture-id")! } : {}),
        ...(args.has("--prepared-at") ? { preparedAt: args.get("--prepared-at")! } : {}),
      });
      result = {
        schemaVersion: 1,
        ok: true,
        command: "prepare",
        fixtureReceiptSha256: prepared.receiptSha256,
        databaseIdentitySha256: prepared.databaseIdentitySha256,
        preparedStateSha256: prepared.stateSha256,
      };
    } else if (command === "inspect") {
      let args: Map<string, string>;
      try {
        args = parseStrictArguments(rawArguments, {
          allowed: INSPECT_ARGUMENTS,
          required: INSPECT_ARGUMENTS,
        });
      } catch {
        throw new CliError("invalid_arguments");
      }
      database = await createRuntimeDatabase(dependencies, args.get("--runtime-database-url-file")!);
      const inspected = await dependencies.inspect({
        database,
        receiptFile: absolutePath(args.get("--fixture-receipt")!),
        expectedReceiptSha256: args.get("--fixture-receipt-sha256")!,
      });
      result = {
        schemaVersion: 1,
        ok: true,
        command: "inspect",
        phase: inspected.state.phase,
        fixtureReceiptSha256: inspected.receiptSha256,
        databaseIdentitySha256: inspected.databaseIdentitySha256,
        stateSha256: inspected.stateSha256,
      };
    } else {
      let args: Map<string, string>;
      try {
        args = parseStrictArguments(rawArguments, {
          allowed: COMPLETE_ARGUMENTS,
          required: COMPLETE_ARGUMENTS,
        });
      } catch {
        throw new CliError("invalid_arguments");
      }
      assertConfirmed(dependencies, "PostgreSQL account-deletion recovery fixture completion");
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
        throw new CliError("configuration_missing_or_unsafe");
      }
      let bucketName: string;
      try {
        bucketName = resolveExactOperationalOffsiteBackupBucket(
          dependencies.env.OFFSITE_BACKUP_BUCKET,
        );
      } catch {
        throw new CliError("configuration_missing_or_unsafe");
      }
      try {
        dependencies.assertDestinationPins({
          destinationSupabaseUrl,
          bucketName,
          expectedDestinationOriginSha256: args.get("--expected-destination-origin-sha256")!,
          expectedBucketNameSha256: args.get("--expected-bucket-name-sha256")!,
        });
      } catch {
        throw new CliError("configuration_missing_or_unsafe");
      }
      let destinationServiceRoleKey: string;
      try {
        destinationServiceRoleKey = await dependencies.readSecretFile(
          absolutePath(args.get("--service-role-key-file")!),
        );
        assertSupabaseServerApiKey(
          destinationServiceRoleKey,
          "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
        );
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError("secret_file_unsafe");
      }
      database = await createRuntimeDatabase(dependencies, args.get("--runtime-database-url-file")!);
      const ledgerConfig: AccountDeletionLedgerConfig = {
        sourceSupabaseUrl,
        destinationSupabaseUrl,
        destinationServiceRoleKey,
        bucketName,
      };
      const completeOptions: CompletePostgresAccountDeletionRecoveryFixtureOptions = {
        database,
        receiptFile: absolutePath(args.get("--fixture-receipt")!),
        expectedReceiptSha256: args.get("--fixture-receipt-sha256")!,
        logicalBackupStateReceiptFile: absolutePath(args.get("--logical-backup-state-receipt")!),
        expectedLogicalBackupStateReceiptSha256:
          args.get("--logical-backup-state-receipt-sha256")!,
        ledgerAuthorityDirectory: absolutePath(args.get("--ledger-authority-output")!),
        completionReceiptFile: absolutePath(args.get("--completion-receipt")!),
        completedAt: args.get("--completed-at")!,
        appendAndVerifyTombstone: (tombstone) => (
          dependencies.appendAndFetchVerifiedLedger(ledgerConfig, tombstone)
        ),
      };
      const completed = await dependencies.complete(completeOptions);
      result = {
        schemaVersion: 1,
        ok: true,
        command: "complete",
        completionReceiptSha256: completed.receiptSha256,
        databaseIdentitySha256: completed.databaseIdentitySha256,
        completedStateSha256: completed.stateSha256,
        ledgerAuthoritySha256: completed.ledgerAuthoritySha256,
      };
    }
  } finally {
    if (database) {
      try {
        await database.close();
      } catch {
        throw new CliError("database_close_failed");
      }
    }
  }
  return result;
}

export async function runPostgresAccountDeletionRecoveryCli(
  argv: readonly string[],
  overrides: Partial<PostgresAccountDeletionRecoveryCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresAccountDeletionRecoveryCliDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  let result: PostgresAccountDeletionRecoveryCliResult;
  try {
    result = await runCommand(argv, dependencies);
  } catch (error) {
    result = {
      schemaVersion: 1,
      ok: false,
      failureCode: safeFailure(error),
    };
  }
  dependencies.writeOutput(canonicalPostgresLogicalStateJson(result));
  return result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresAccountDeletionRecoveryCli(process.argv.slice(2));
}
