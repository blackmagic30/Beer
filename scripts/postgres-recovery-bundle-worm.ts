import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalPostgresBackupJson,
} from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_LOGICAL_WORM_REGION,
  PostgresLogicalWormError,
  createAwsSdkV3PostgresLogicalWormProvider,
  type AwsSdkV3WormCommandConstructor,
  type AwsSdkV3WormCommands,
} from "../src/lib/postgres-logical-worm.js";
import {
  PostgresRecoveryBundleWormError,
  retrievePostgresRecoveryBundleWorm,
  sealPostgresRecoveryBundleWorm,
  type PostgresRecoveryBundleWormResult,
} from "../src/lib/postgres-recovery-bundle-worm.js";
import {
  runtimeConstructor,
  runtimeRecord,
  type LoadedAwsWormProvider,
  type RuntimeAwsClient,
  type RuntimeAwsClientConstructor,
  type RuntimeFromIni,
} from "./attest-postgres-logical-worm.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import { readTrustedRegularFile } from "./lib/trusted-filesystem.js";

export const POSTGRES_RECOVERY_BUNDLE_WORM_CONFIRMATION_ENV =
  "PINTPATH_POSTGRES_RECOVERY_BUNDLE_WORM" as const;
export const POSTGRES_RECOVERY_BUNDLE_WORM_CONFIRMATION_VALUE = "confirmed" as const;
export const POSTGRES_RECOVERY_BUNDLE_WORM_AWS_GATE_ENV =
  "PINTPATH_POSTGRES_RECOVERY_BUNDLE_WORM_AWS" as const;
export const POSTGRES_RECOVERY_BUNDLE_WORM_AWS_GATE_VALUE = "confirmed" as const;
export const POSTGRES_RECOVERY_BUNDLE_WORM_RECOVERY_ACCOUNT_ENV =
  "POSTGRES_RECOVERY_BUNDLE_WORM_RECOVERY_ACCOUNT_ID" as const;
export const POSTGRES_RECOVERY_BUNDLE_WORM_FORBIDDEN_ACCOUNTS_ENV =
  "POSTGRES_RECOVERY_BUNDLE_WORM_FORBIDDEN_ACCOUNT_IDS" as const;

const COMMON_ARGUMENTS = new Set([
  "--bucket-name",
  "--expected-bucket-name-sha256",
  "--expected-reader-principal-arn-sha256",
  "--reader-profile",
]);
const SEAL_ARGUMENTS = new Set([
  ...COMMON_ARGUMENTS,
  "--candidate-sha",
  "--expected-recovery-account-id-sha256",
  "--expected-recovery-manifest-sha256",
  "--expected-recovery-set-sha256",
  "--expected-writer-principal-arn-sha256",
  "--operator-id",
  "--recovery-set-directory",
  "--writer-profile",
]);
const RETRIEVE_ARGUMENTS = new Set([
  ...COMMON_ARGUMENTS,
  "--expected-bundle-manifest-sha256",
  "--expected-candidate-sha",
  "--expected-recovery-account-id-sha256",
  "--expected-recovery-manifest-sha256",
  "--expected-recovery-set-sha256",
  "--output-directory",
  "--worm-result-file",
  "--worm-result-sha256",
]);
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9+=,.@_-]{0,127}$/;
const ACCOUNT = /^\d{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BUCKET = /^(?!xn--)(?!sthree-)(?!amzn_s3_demo_)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)(?!.*--table-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export type PostgresRecoveryBundleWormCliFailureCode =
  | PostgresRecoveryBundleWormError["code"]
  | "confirmation_required"
  | "real_aws_gate_required"
  | "operator_guard_rejected"
  | "configuration_missing_or_unsafe"
  | "aws_sdk_unavailable"
  | "provider_close_failed"
  | "unexpected_failure";

export interface PostgresRecoveryBundleWormCliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly loadAwsProvider: (input: {
    readonly bucketName: string;
    readonly writerProfile: string | null;
    readonly readerProfile: string;
  }) => LoadedAwsWormProvider;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly seal: typeof sealPostgresRecoveryBundleWorm;
  readonly retrieve: typeof retrievePostgresRecoveryBundleWorm;
  readonly writeOutput: (source: string) => void;
}

class SafeCliError extends Error {
  constructor(readonly code: PostgresRecoveryBundleWormCliFailureCode) {
    super(code);
    this.name = "SafeCliError";
  }
}

function command(
  source: Record<string, unknown>,
  name: string,
): AwsSdkV3WormCommandConstructor {
  return runtimeConstructor<AwsSdkV3WormCommandConstructor>(source, name);
}

interface RecoveryBundleAwsRuntime {
  readonly s3: Record<string, unknown>;
  readonly sts: Record<string, unknown>;
  readonly credentials: Record<string, unknown>;
}

export function createRecoveryBundleAwsProviderFromRuntime(input: {
  readonly bucketName: string;
  readonly writerProfile: string | null;
  readonly readerProfile: string;
}, runtime: RecoveryBundleAwsRuntime): LoadedAwsWormProvider {
    const { s3, sts, credentials } = runtime;
    const S3Client = runtimeConstructor<RuntimeAwsClientConstructor>(s3, "S3Client");
    const STSClient = runtimeConstructor<RuntimeAwsClientConstructor>(sts, "STSClient");
    const fromIni = runtimeConstructor<RuntimeFromIni>(credentials, "fromIni");
    const commands: AwsSdkV3WormCommands = {
      GetCallerIdentityCommand: command(sts, "GetCallerIdentityCommand"),
      PutObjectCommand: command(s3, "PutObjectCommand"),
      GetObjectCommand: command(s3, "GetObjectCommand"),
      GetObjectRetentionCommand: command(s3, "GetObjectRetentionCommand"),
      DeleteObjectCommand: command(s3, "DeleteObjectCommand"),
      ListObjectVersionsCommand: command(s3, "ListObjectVersionsCommand"),
      GetBucketLocationCommand: command(s3, "GetBucketLocationCommand"),
      GetBucketVersioningCommand: command(s3, "GetBucketVersioningCommand"),
      GetObjectLockConfigurationCommand: command(s3, "GetObjectLockConfigurationCommand"),
      GetPublicAccessBlockCommand: command(s3, "GetPublicAccessBlockCommand"),
      GetBucketOwnershipControlsCommand: command(s3, "GetBucketOwnershipControlsCommand"),
      GetBucketEncryptionCommand: command(s3, "GetBucketEncryptionCommand"),
      GetBucketPolicyStatusCommand: command(s3, "GetBucketPolicyStatusCommand"),
      GetBucketRequestPaymentCommand: command(s3, "GetBucketRequestPaymentCommand"),
    };
    const readerCredentials = fromIni({ profile: input.readerProfile });
    const common = {
      region: POSTGRES_LOGICAL_WORM_REGION,
      maxAttempts: 3,
      retryMode: "standard",
      followRegionRedirects: false,
    } as const;
    const readerS3 = new S3Client({ ...common, credentials: readerCredentials });
    const readerSts = new STSClient({ ...common, credentials: readerCredentials });
    const clients: RuntimeAwsClient[] = [readerS3, readerSts];
    const unavailableWriterClient: RuntimeAwsClient = Object.freeze({
      send: async () => {
        throw new PostgresLogicalWormError("writer_not_least_privilege");
      },
    });
    let writerS3: RuntimeAwsClient = unavailableWriterClient;
    let writerSts: RuntimeAwsClient = unavailableWriterClient;
    if (input.writerProfile !== null) {
      const writerCredentials = fromIni({ profile: input.writerProfile });
      writerS3 = new S3Client({ ...common, credentials: writerCredentials });
      writerSts = new STSClient({ ...common, credentials: writerCredentials });
      clients.push(writerS3, writerSts);
    }
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
}

export function loadRecoveryBundleAwsProvider(input: {
  readonly bucketName: string;
  readonly writerProfile: string | null;
  readonly readerProfile: string;
}): LoadedAwsWormProvider {
  try {
    const require = createRequire(import.meta.url);
    return createRecoveryBundleAwsProviderFromRuntime(input, {
      s3: runtimeRecord(require("@aws-sdk/client-s3")),
      sts: runtimeRecord(require("@aws-sdk/client-sts")),
      credentials: runtimeRecord(require("@aws-sdk/credential-providers")),
    });
  } catch (error) {
    if (error instanceof SafeCliError || error instanceof PostgresLogicalWormError) {
      throw error;
    }
    throw new SafeCliError("aws_sdk_unavailable");
  }
}

const DEFAULT_DEPENDENCIES: PostgresRecoveryBundleWormCliDependencies = {
  env: process.env,
  loadAwsProvider: loadRecoveryBundleAwsProvider,
  assertMutationAllowed: assertOperatorMutationAllowed,
  seal: sealPostgresRecoveryBundleWorm,
  retrieve: retrievePostgresRecoveryBundleWorm,
  writeOutput: (source) => process.stdout.write(source),
};

function exactAbsolute(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function exactProfile(value: string): string {
  if (!PROFILE.test(value)) throw new SafeCliError("configuration_missing_or_unsafe");
  return value;
}

function exactSha(value: string): string {
  if (!SHA256.test(value)) throw new SafeCliError("configuration_missing_or_unsafe");
  return value;
}

function exactBucket(value: string): string {
  if (!BUCKET.test(value) || value.includes("..")) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function readWormResult(
  filename: string,
  expectedSha256: string,
): PostgresRecoveryBundleWormResult {
  let bytes: Buffer;
  try {
    bytes = readTrustedRegularFile(filename, {
      minBytes: 2, maxBytes: 64 * 1024, requireOwner: true, requirePrivate: true,
    });
  } catch {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  try {
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      throw new Error("hash mismatch");
    }
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || canonicalPostgresBackupJson(parsed) !== bytes.toString("utf8")) {
      throw new Error("noncanonical");
    }
    return parsed as PostgresRecoveryBundleWormResult;
  } catch {
    throw new SafeCliError("configuration_missing_or_unsafe");
  } finally {
    bytes.fill(0);
  }
}

function recoveryAccount(env: Readonly<Record<string, string | undefined>>): string {
  const value = env[POSTGRES_RECOVERY_BUNDLE_WORM_RECOVERY_ACCOUNT_ENV] ?? "";
  if (!ACCOUNT.test(value)) throw new SafeCliError("configuration_missing_or_unsafe");
  return value;
}

function forbiddenAccounts(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const value = env[POSTGRES_RECOVERY_BUNDLE_WORM_FORBIDDEN_ACCOUNTS_ENV] ?? "";
  const entries = value.split(",");
  if (entries.length < 1 || entries.some((entry) => !ACCOUNT.test(entry))
    || new Set(entries).size !== entries.length) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  return Object.freeze(entries);
}

function failureCode(error: unknown): PostgresRecoveryBundleWormCliFailureCode {
  if (error instanceof SafeCliError || error instanceof PostgresRecoveryBundleWormError) {
    return error.code;
  }
  if (error instanceof PostgresLogicalWormError) return error.code as PostgresRecoveryBundleWormCliFailureCode;
  return "unexpected_failure";
}

export async function runPostgresRecoveryBundleWormCli(
  argv: readonly string[],
  overrides: Partial<PostgresRecoveryBundleWormCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  let provider: LoadedAwsWormProvider | null = null;
  try {
    const [subcommand, ...raw] = argv;
    if (subcommand !== "seal" && subcommand !== "retrieve") {
      throw new SafeCliError("configuration_missing_or_unsafe");
    }
    const allowed = subcommand === "seal" ? SEAL_ARGUMENTS : RETRIEVE_ARGUMENTS;
    let args: ReadonlyMap<string, string>;
    try {
      args = parseStrictArguments(raw, { allowed, required: allowed });
    } catch {
      throw new SafeCliError("configuration_missing_or_unsafe");
    }
    if (
      dependencies.env[POSTGRES_RECOVERY_BUNDLE_WORM_CONFIRMATION_ENV]
        !== POSTGRES_RECOVERY_BUNDLE_WORM_CONFIRMATION_VALUE
    ) throw new SafeCliError("confirmation_required");
    if (
      dependencies.env[POSTGRES_RECOVERY_BUNDLE_WORM_AWS_GATE_ENV]
        !== POSTGRES_RECOVERY_BUNDLE_WORM_AWS_GATE_VALUE
    ) throw new SafeCliError("real_aws_gate_required");
    try {
      dependencies.assertMutationAllowed(
        subcommand === "seal"
          ? "Postgres private Storage recovery WORM seal"
          : "Postgres private Storage recovery WORM retrieval",
      );
    } catch {
      throw new SafeCliError("operator_guard_rejected");
    }
    const bucketName = exactBucket(args.get("--bucket-name")!);
    const readerProfile = exactProfile(args.get("--reader-profile")!);
    provider = dependencies.loadAwsProvider({
      bucketName,
      readerProfile,
      writerProfile: subcommand === "seal"
        ? exactProfile(args.get("--writer-profile")!)
        : null,
    });
    const recoveryAccountId = recoveryAccount(dependencies.env);
    const result = subcommand === "seal"
      ? await dependencies.seal({
        recoverySetDirectory: exactAbsolute(args.get("--recovery-set-directory")!),
        expectedRecoverySetSha256: exactSha(args.get("--expected-recovery-set-sha256")!),
        expectedRecoveryManifestSha256: exactSha(args.get("--expected-recovery-manifest-sha256")!),
        candidateSha: args.get("--candidate-sha")!,
        bucketName,
        expectedBucketNameSha256: exactSha(args.get("--expected-bucket-name-sha256")!),
        recoveryAccountId,
        expectedRecoveryAccountIdSha256: exactSha(args.get("--expected-recovery-account-id-sha256")!),
        expectedWriterPrincipalArnSha256: exactSha(args.get("--expected-writer-principal-arn-sha256")!),
        expectedReaderPrincipalArnSha256: exactSha(args.get("--expected-reader-principal-arn-sha256")!),
        forbiddenAccountIds: forbiddenAccounts(dependencies.env),
        operatorId: args.get("--operator-id")!,
        provider: provider.provider,
      })
      : await dependencies.retrieve({
        outputDirectory: exactAbsolute(args.get("--output-directory")!),
        wormResult: (() => {
          const value = readWormResult(
            exactAbsolute(args.get("--worm-result-file")!),
            exactSha(args.get("--worm-result-sha256")!),
          );
          if (value.candidateSha !== args.get("--expected-candidate-sha")
            || value.recoverySetSha256 !== exactSha(args.get("--expected-recovery-set-sha256")!)
            || value.recoveryManifestSha256
              !== exactSha(args.get("--expected-recovery-manifest-sha256")!)
            || value.bundleManifestSha256
              !== exactSha(args.get("--expected-bundle-manifest-sha256")!)) {
            throw new SafeCliError("configuration_missing_or_unsafe");
          }
          return value;
        })(),
        wormResultSha256: exactSha(args.get("--worm-result-sha256")!),
        bucketName,
        expectedBucketNameSha256: exactSha(args.get("--expected-bucket-name-sha256")!),
        recoveryAccountId,
        expectedRecoveryAccountIdSha256: exactSha(args.get("--expected-recovery-account-id-sha256")!),
        expectedReaderPrincipalArnSha256: exactSha(args.get("--expected-reader-principal-arn-sha256")!),
        provider: provider.provider,
      });
    provider.close();
    provider = null;
    dependencies.writeOutput(canonicalPostgresBackupJson(result));
    return 0;
  } catch (error) {
    if (provider) {
      try {
        provider.close();
      } catch {
        error = new SafeCliError("provider_close_failed");
      }
    }
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
  process.exitCode = await runPostgresRecoveryBundleWormCli(process.argv.slice(2));
}
