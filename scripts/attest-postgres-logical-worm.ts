import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_LOGICAL_WORM_REGION,
  PostgresLogicalWormError,
  attestPostgresLogicalWorm,
  createAwsSdkV3PostgresLogicalWormProvider,
  type AwsSdkV3WormClient,
  type AwsSdkV3WormCommandConstructor,
  type AwsSdkV3WormCommands,
  type PostgresLogicalWormFailureCode,
  type PostgresLogicalWormProvider,
  type PostgresLogicalWormResult,
} from "../src/lib/postgres-logical-worm.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

export const POSTGRES_LOGICAL_WORM_CONFIRMATION_ENV =
  "PINTPATH_POSTGRES_LOGICAL_WORM" as const;
export const POSTGRES_LOGICAL_WORM_CONFIRMATION_VALUE = "confirmed" as const;
export const POSTGRES_LOGICAL_WORM_AWS_GATE_ENV =
  "PINTPATH_POSTGRES_LOGICAL_WORM_AWS" as const;
export const POSTGRES_LOGICAL_WORM_AWS_GATE_VALUE = "confirmed" as const;
export const POSTGRES_LOGICAL_WORM_RECOVERY_ACCOUNT_ENV =
  "POSTGRES_LOGICAL_WORM_RECOVERY_ACCOUNT_ID" as const;
export const POSTGRES_LOGICAL_WORM_FORBIDDEN_ACCOUNTS_ENV =
  "POSTGRES_LOGICAL_WORM_FORBIDDEN_ACCOUNT_IDS" as const;

const ARGUMENTS = new Set([
  "--backup-directory",
  "--backup-manifest-sha256",
  "--bucket-name",
  "--expected-bucket-name-sha256",
  "--expected-reader-principal-arn-sha256",
  "--expected-recovery-account-id-sha256",
  "--expected-writer-principal-arn-sha256",
  "--operator-id",
  "--reader-profile",
  "--writer-profile",
]);
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+=,.@_-]{0,127}$/;
const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUCKET_PATTERN = /^(?!xn--)(?!sthree-)(?!amzn_s3_demo_)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)(?!.*--table-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export type PostgresLogicalWormCliFailureCode =
  | PostgresLogicalWormFailureCode
  | "confirmation_required"
  | "real_aws_gate_required"
  | "operator_guard_rejected"
  | "configuration_missing_or_unsafe"
  | "aws_sdk_unavailable"
  | "provider_close_failed"
  | "unexpected_failure";

export interface LoadedAwsWormProvider {
  readonly provider: PostgresLogicalWormProvider;
  close(): void;
}

export interface PostgresLogicalWormCliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly loadAwsProvider: (input: {
    readonly bucketName: string;
    readonly writerProfile: string;
    readonly readerProfile: string;
  }) => LoadedAwsWormProvider;
  readonly attest: typeof attestPostgresLogicalWorm;
  readonly writeOutput: (value: string) => void;
}

class SafeCliError extends Error {
  constructor(readonly code: PostgresLogicalWormCliFailureCode) {
    super(code);
    this.name = "SafeCliError";
  }
}

interface RuntimeAwsClient extends AwsSdkV3WormClient {
  destroy?: () => void;
}

interface RuntimeAwsClientConstructor {
  new(config: Readonly<Record<string, unknown>>): RuntimeAwsClient;
}

type RuntimeFromIni = (input: { readonly profile: string }) => unknown;

function runtimeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafeCliError("aws_sdk_unavailable");
  }
  return value as Record<string, unknown>;
}

function runtimeConstructor<T>(
  source: Record<string, unknown>,
  name: string,
): T {
  const value = source[name];
  if (typeof value !== "function") throw new SafeCliError("aws_sdk_unavailable");
  return value as T;
}

export function loadAwsSdkV3WormProvider(input: {
  readonly bucketName: string;
  readonly writerProfile: string;
  readonly readerProfile: string;
}): LoadedAwsWormProvider {
  try {
    const require = createRequire(import.meta.url);
    const s3 = runtimeRecord(require("@aws-sdk/client-s3"));
    const sts = runtimeRecord(require("@aws-sdk/client-sts"));
    const credentials = runtimeRecord(require("@aws-sdk/credential-providers"));
    const S3Client = runtimeConstructor<RuntimeAwsClientConstructor>(s3, "S3Client");
    const STSClient = runtimeConstructor<RuntimeAwsClientConstructor>(sts, "STSClient");
    const fromIni = runtimeConstructor<RuntimeFromIni>(credentials, "fromIni");
    const command = (source: Record<string, unknown>, name: string) => (
      runtimeConstructor<AwsSdkV3WormCommandConstructor>(source, name)
    );
    const commands: AwsSdkV3WormCommands = {
      GetCallerIdentityCommand: command(sts, "GetCallerIdentityCommand"),
      PutObjectCommand: command(s3, "PutObjectCommand"),
      GetObjectCommand: command(s3, "GetObjectCommand"),
      GetObjectRetentionCommand: command(s3, "GetObjectRetentionCommand"),
      DeleteObjectCommand: command(s3, "DeleteObjectCommand"),
      ListObjectVersionsCommand: command(s3, "ListObjectVersionsCommand"),
      GetBucketLocationCommand: command(s3, "GetBucketLocationCommand"),
      GetBucketVersioningCommand: command(s3, "GetBucketVersioningCommand"),
      GetObjectLockConfigurationCommand: command(
        s3,
        "GetObjectLockConfigurationCommand",
      ),
      GetPublicAccessBlockCommand: command(s3, "GetPublicAccessBlockCommand"),
      GetBucketOwnershipControlsCommand: command(
        s3,
        "GetBucketOwnershipControlsCommand",
      ),
      GetBucketEncryptionCommand: command(s3, "GetBucketEncryptionCommand"),
      GetBucketPolicyStatusCommand: command(s3, "GetBucketPolicyStatusCommand"),
      GetBucketRequestPaymentCommand: command(s3, "GetBucketRequestPaymentCommand"),
    };
    const writerCredentials = fromIni({ profile: input.writerProfile });
    const readerCredentials = fromIni({ profile: input.readerProfile });
    const common = {
      region: POSTGRES_LOGICAL_WORM_REGION,
      maxAttempts: 3,
      retryMode: "standard",
      followRegionRedirects: false,
    } as const;
    const writerS3 = new S3Client({ ...common, credentials: writerCredentials });
    const readerS3 = new S3Client({ ...common, credentials: readerCredentials });
    const writerSts = new STSClient({ ...common, credentials: writerCredentials });
    const readerSts = new STSClient({ ...common, credentials: readerCredentials });
    const clients = [writerS3, readerS3, writerSts, readerSts] as const;
    return {
      provider: createAwsSdkV3PostgresLogicalWormProvider({
        region: POSTGRES_LOGICAL_WORM_REGION,
        bucketName: input.bucketName,
        writerS3,
        readerS3,
        writerSts,
        readerSts,
        commands,
      }),
      close: () => {
        for (const client of clients) client.destroy?.();
      },
    };
  } catch (error) {
    if (error instanceof SafeCliError || error instanceof PostgresLogicalWormError) {
      throw error;
    }
    throw new SafeCliError("aws_sdk_unavailable");
  }
}

const DEFAULT_DEPENDENCIES: PostgresLogicalWormCliDependencies = {
  env: process.env,
  assertMutationAllowed: assertOperatorMutationAllowed,
  loadAwsProvider: loadAwsSdkV3WormProvider,
  attest: attestPostgresLogicalWorm,
  writeOutput: (value) => process.stdout.write(value),
};

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactAbsolutePath(value: string): string {
  if (
    !path.isAbsolute(value)
    || path.resolve(value) !== value
    || value.includes("\0")
  ) throw new SafeCliError("configuration_missing_or_unsafe");
  return value;
}

function exactProfile(value: string): string {
  if (!PROFILE_PATTERN.test(value)) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function exactSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function exactBucketName(value: string): string {
  if (
    !BUCKET_PATTERN.test(value)
    || value.includes("..")
    || /^\d+\.\d+\.\d+\.\d+$/.test(value)
  ) throw new SafeCliError("configuration_missing_or_unsafe");
  return value;
}

function exactOperatorId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{0,254}$/.test(value)) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function recoveryAccountId(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const value = environment[POSTGRES_LOGICAL_WORM_RECOVERY_ACCOUNT_ENV];
  if (!value || !ACCOUNT_ID_PATTERN.test(value)) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function forbiddenAccountIds(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const value = environment[POSTGRES_LOGICAL_WORM_FORBIDDEN_ACCOUNTS_ENV];
  if (!value) return Object.freeze([]);
  if (value.trim() !== value || /\s/.test(value)) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  const accounts = value.split(",");
  if (
    accounts.length < 1
    || accounts.some((account) => !ACCOUNT_ID_PATTERN.test(account))
    || new Set(accounts).size !== accounts.length
  ) throw new SafeCliError("configuration_missing_or_unsafe");
  return Object.freeze(accounts);
}

function safeFailureCode(error: unknown): PostgresLogicalWormCliFailureCode {
  if (error instanceof SafeCliError || error instanceof PostgresLogicalWormError) {
    return error.code;
  }
  return "unexpected_failure";
}

function write(
  dependencies: PostgresLogicalWormCliDependencies,
  value: unknown,
): void {
  dependencies.writeOutput(canonicalPostgresBackupJson(value));
}

export async function runPostgresLogicalWormCli(
  argv: readonly string[],
  overrides: Partial<PostgresLogicalWormCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresLogicalWormCliDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  let loaded: LoadedAwsWormProvider | null = null;
  let result: PostgresLogicalWormResult | null = null;
  let failureCode: PostgresLogicalWormCliFailureCode | null = null;
  try {
    const args = parseStrictArguments(argv, {
      allowed: ARGUMENTS,
      required: ARGUMENTS,
    });
    if (
      dependencies.env[POSTGRES_LOGICAL_WORM_CONFIRMATION_ENV]
      !== POSTGRES_LOGICAL_WORM_CONFIRMATION_VALUE
    ) throw new SafeCliError("confirmation_required");
    if (
      dependencies.env[POSTGRES_LOGICAL_WORM_AWS_GATE_ENV]
      !== POSTGRES_LOGICAL_WORM_AWS_GATE_VALUE
    ) throw new SafeCliError("real_aws_gate_required");
    try {
      dependencies.assertMutationAllowed("Postgres logical WORM attestation");
    } catch {
      throw new SafeCliError("operator_guard_rejected");
    }
    const writerProfile = exactProfile(args.get("--writer-profile")!);
    const readerProfile = exactProfile(args.get("--reader-profile")!);
    if (writerProfile === readerProfile) {
      throw new SafeCliError("configuration_missing_or_unsafe");
    }
    const accountId = recoveryAccountId(dependencies.env);
    const expectedAccountHash = exactSha256(
      args.get("--expected-recovery-account-id-sha256")!,
    );
    if (sha256(accountId) !== expectedAccountHash) {
      throw new SafeCliError("configuration_missing_or_unsafe");
    }
    const backupDirectory = exactAbsolutePath(args.get("--backup-directory")!);
    const expectedManifestSha256 = exactSha256(
      args.get("--backup-manifest-sha256")!,
    );
    const bucketName = exactBucketName(args.get("--bucket-name")!);
    const expectedBucketNameSha256 = exactSha256(
      args.get("--expected-bucket-name-sha256")!,
    );
    if (sha256(bucketName) !== expectedBucketNameSha256) {
      throw new SafeCliError("configuration_missing_or_unsafe");
    }
    const expectedWriterPrincipalArnSha256 = exactSha256(
      args.get("--expected-writer-principal-arn-sha256")!,
    );
    const expectedReaderPrincipalArnSha256 = exactSha256(
      args.get("--expected-reader-principal-arn-sha256")!,
    );
    if (expectedWriterPrincipalArnSha256 === expectedReaderPrincipalArnSha256) {
      throw new SafeCliError("configuration_missing_or_unsafe");
    }
    const operatorId = exactOperatorId(args.get("--operator-id")!);
    const forbiddenAccounts = forbiddenAccountIds(dependencies.env);
    loaded = dependencies.loadAwsProvider({
      bucketName,
      writerProfile,
      readerProfile,
    });
    result = await dependencies.attest({
      backupDirectory,
      expectedManifestSha256,
      bucketName,
      expectedBucketNameSha256,
      recoveryAccountId: accountId,
      expectedRecoveryAccountIdSha256: expectedAccountHash,
      expectedWriterPrincipalArnSha256,
      expectedReaderPrincipalArnSha256,
      forbiddenAccountIds: forbiddenAccounts,
      operatorId,
      provider: loaded.provider,
    });
  } catch (error) {
    failureCode = safeFailureCode(error);
  } finally {
    if (loaded) {
      try {
        loaded.close();
      } catch {
        failureCode = "provider_close_failed";
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
  process.exitCode = await runPostgresLogicalWormCli(process.argv.slice(2));
}
