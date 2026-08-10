import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import { POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE } from
  "../src/lib/postgres-railway-stock-localhost-ca.js";
import {
  POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION_ENV,
  PostgresLogicalBackupLoginError,
  managePostgresLogicalBackupLogin,
  postgresLogicalBackupLoginMutationArm,
  type PostgresLogicalBackupLoginFailureCode,
  type PostgresLogicalBackupLoginManagerOptions,
  type PostgresLogicalBackupLoginManagerResult,
  type PostgresLogicalBackupLoginOperation,
} from "../src/lib/postgres-logical-backup-login.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const COMMON_ARGUMENTS = new Set([
  "--admin-connection-file",
  "--approval-reference",
  "--escrow-directory",
  "--expected-admin-url-sha256",
  "--expected-database-identity-sha256",
  "--expected-environment",
  "--expected-head-sha",
  "--expected-node-version",
  "--expected-root-ca-der-sha256",
  "--expected-tree-sha",
  "--expected-uid",
  "--login-version",
  "--operation-id",
  "--receipt",
  "--root-ca-file",
  "--transport-profile",
]);

const RETIRE_ARGUMENTS = new Set([
  ...COMMON_ARGUMENTS,
  "--expected-provision-receipt-sha256",
  "--provision-receipt",
]);

export interface PostgresLogicalBackupLoginCliDependencies {
  readonly manage: (
    options: PostgresLogicalBackupLoginManagerOptions,
  ) => Promise<PostgresLogicalBackupLoginManagerResult>;
  readonly writeOutput: (value: string) => void;
}

const DEFAULT_DEPENDENCIES: PostgresLogicalBackupLoginCliDependencies = {
  manage: managePostgresLogicalBackupLogin,
  writeOutput: (value) => process.stdout.write(value),
};

function exactUid(value: string): number {
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) {
    throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
  return parsed;
}

function operation(value: string | undefined): PostgresLogicalBackupLoginOperation {
  if (value !== "provision" && value !== "retire") {
    throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
  return value;
}

export function parsePostgresLogicalBackupLoginOptions(
  requestedOperation: PostgresLogicalBackupLoginOperation,
  argv: readonly string[],
): PostgresLogicalBackupLoginManagerOptions {
  const allowed = requestedOperation === "retire" ? RETIRE_ARGUMENTS : COMMON_ARGUMENTS;
  let parsed: Map<string, string>;
  try {
    parsed = parseStrictArguments(argv, { allowed, required: allowed });
  } catch {
    throw new PostgresLogicalBackupLoginError("invalid_arguments");
  }
  return {
    operation: requestedOperation,
    adminConnectionFile: parsed.get("--admin-connection-file")!,
    expectedAdminUrlSha256: parsed.get("--expected-admin-url-sha256")!,
    transportProfile: parsed.get("--transport-profile")! as
      typeof POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaFile: parsed.get("--root-ca-file")!,
    expectedRootCaDerSha256: parsed.get("--expected-root-ca-der-sha256")!,
    expectedDatabaseIdentitySha256: parsed.get("--expected-database-identity-sha256")!,
    expectedHeadSha: parsed.get("--expected-head-sha")!,
    expectedTreeSha: parsed.get("--expected-tree-sha")!,
    expectedUid: exactUid(parsed.get("--expected-uid")!),
    expectedNodeVersion: parsed.get("--expected-node-version")!,
    expectedEnvironment: parsed.get("--expected-environment")! as
      PostgresLogicalBackupLoginManagerOptions["expectedEnvironment"],
    operationId: parsed.get("--operation-id")!,
    approvalReference: parsed.get("--approval-reference")!,
    loginVersion: parsed.get("--login-version")!,
    escrowDirectory: parsed.get("--escrow-directory")!,
    receiptFile: parsed.get("--receipt")!,
    ...(requestedOperation === "retire" ? {
      provisionReceiptFile: parsed.get("--provision-receipt")!,
      expectedProvisionReceiptSha256:
        parsed.get("--expected-provision-receipt-sha256")!,
    } : {}),
  };
}

function failureCode(error: unknown): PostgresLogicalBackupLoginFailureCode {
  return error instanceof PostgresLogicalBackupLoginError
    ? error.code
    : "mutation_ambiguous";
}

export async function runPostgresLogicalBackupLoginCli(
  argv: readonly string[],
  overrides: Partial<PostgresLogicalBackupLoginCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresLogicalBackupLoginCliDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  try {
    const [first, second, ...rest] = argv;
    const armOnly = first === "arm";
    const requestedOperation = operation(armOnly ? second : first);
    const rawArguments = armOnly ? rest : argv.slice(1);
    const options = parsePostgresLogicalBackupLoginOptions(requestedOperation, rawArguments);
    if (armOnly) {
      dependencies.writeOutput(canonicalPostgresBackupJson({
        schemaVersion: 1,
        ok: true,
        operation: requestedOperation,
        mutationEnvironment: POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION_ENV,
        mutationArm: postgresLogicalBackupLoginMutationArm(options),
      }));
      return 0;
    }
    const result = await dependencies.manage(options);
    dependencies.writeOutput(canonicalPostgresBackupJson({
      schemaVersion: 1,
      ok: true,
      operation: result.receipt.operation,
      status: result.receipt.status,
      receiptSha256: result.receiptSha256,
      headSha: result.receipt.headSha,
      treeSha: result.receipt.treeSha,
      databaseIdentitySha256: result.receipt.databaseIdentitySha256,
      loginRole: result.receipt.loginRole,
      loginRoleOid: result.receipt.loginRoleOid,
      groupRole: result.receipt.groupRole,
    }));
    return 0;
  } catch (error) {
    dependencies.writeOutput(canonicalPostgresBackupJson({
      schemaVersion: 1,
      ok: false,
      failureCode: failureCode(error),
    }));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresLogicalBackupLoginCli(process.argv.slice(2));
}
