import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  PostgresLogicalWormRetrievalError,
  retrievePostgresLogicalWormBackup,
  type PostgresLogicalWormReadOnlyProvider,
} from "../src/lib/postgres-logical-worm-retrieval.js";
import {
  POSTGRES_LOGICAL_WORM_REGION,
  PostgresLogicalWormError,
  createAwsSdkV3PostgresLogicalWormProvider,
  type AwsSdkV3WormClient,
  type AwsSdkV3WormCommandConstructor,
  type AwsSdkV3WormCommands,
  type PostgresLogicalWormResult,
} from "../src/lib/postgres-logical-worm.js";
import {
  runtimeConstructor,
  runtimeRecord,
  type RuntimeAwsClient,
  type RuntimeAwsClientConstructor,
  type RuntimeFromIni,
} from "./attest-postgres-logical-worm.js";
import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

export const POSTGRES_LOGICAL_WORM_RETRIEVAL_CONFIRMATION_ENV =
  "PINTPATH_POSTGRES_LOGICAL_WORM_RETRIEVAL" as const;
export const POSTGRES_LOGICAL_WORM_RETRIEVAL_CONFIRMATION_VALUE = "confirmed" as const;
export const POSTGRES_LOGICAL_WORM_RETRIEVAL_AWS_GATE_ENV =
  "PINTPATH_POSTGRES_LOGICAL_WORM_RETRIEVAL_AWS" as const;
export const POSTGRES_LOGICAL_WORM_RETRIEVAL_AWS_GATE_VALUE = "confirmed" as const;
export const POSTGRES_LOGICAL_WORM_RETRIEVAL_ACCOUNT_ENV =
  "POSTGRES_LOGICAL_WORM_RECOVERY_ACCOUNT_ID" as const;

const ARGUMENTS = new Set([
  "--bucket-name",
  "--expected-bucket-name-sha256",
  "--expected-reader-principal-arn-sha256",
  "--expected-recovery-account-id-sha256",
  "--output-directory",
  "--reader-profile",
  "--receipt-file",
  "--worm-result-file",
  "--worm-result-sha256",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const ACCOUNT = /^\d{12}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9+=,.@_-]{0,127}$/;
const BUCKET = /^(?!xn--)(?!sthree-)(?!amzn_s3_demo_)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)(?!.*--table-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export type PostgresLogicalWormRetrievalCliFailureCode =
  | PostgresLogicalWormRetrievalError["code"]
  | "confirmation_required"
  | "real_aws_gate_required"
  | "configuration_missing_or_unsafe"
  | "trusted_input_invalid"
  | "receipt_write_failed"
  | "aws_sdk_unavailable"
  | "provider_close_failed"
  | "unexpected_failure";

class SafeCliError extends Error {
  constructor(readonly code: PostgresLogicalWormRetrievalCliFailureCode) {
    super(code);
    this.name = "SafeCliError";
  }
}

export interface LoadedLogicalWormReader {
  readonly provider: PostgresLogicalWormReadOnlyProvider;
  close(): void;
}

export interface PostgresLogicalWormRetrievalCliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly loadReader: (input: {
    readonly bucketName: string;
    readonly readerProfile: string;
  }) => LoadedLogicalWormReader;
  readonly retrieve: typeof retrievePostgresLogicalWormBackup;
  readonly writeOutput: (value: string) => void;
}

function command(
  source: Record<string, unknown>,
  name: string,
): AwsSdkV3WormCommandConstructor {
  return runtimeConstructor<AwsSdkV3WormCommandConstructor>(source, name);
}

export function loadAwsSdkV3LogicalWormReader(input: {
  readonly bucketName: string;
  readonly readerProfile: string;
}): LoadedLogicalWormReader {
  try {
    const require = createRequire(import.meta.url);
    const s3 = runtimeRecord(require("@aws-sdk/client-s3"));
    const sts = runtimeRecord(require("@aws-sdk/client-sts"));
    const credentials = runtimeRecord(require("@aws-sdk/credential-providers"));
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
    const forbidden: AwsSdkV3WormClient = Object.freeze({
      send: async () => { throw new Error("writer client unavailable in reader process"); },
    });
    const provider = createAwsSdkV3PostgresLogicalWormProvider({
      region: POSTGRES_LOGICAL_WORM_REGION,
      bucketName: input.bucketName,
      writerS3: forbidden,
      writerSts: forbidden,
      readerS3,
      readerSts,
      commands,
    });
    return {
      provider,
      close: () => {
        readerS3.destroy?.();
        readerSts.destroy?.();
      },
    };
  } catch (error) {
    if (error instanceof SafeCliError || error instanceof PostgresLogicalWormError) {
      throw error;
    }
    throw new SafeCliError("aws_sdk_unavailable");
  }
}

const DEFAULT_DEPENDENCIES: PostgresLogicalWormRetrievalCliDependencies = {
  env: process.env,
  loadReader: loadAwsSdkV3LogicalWormReader,
  retrieve: retrievePostgresLogicalWormBackup,
  writeOutput: (value) => process.stdout.write(value),
};

function exactAbsolute(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
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

function exactProfile(value: string): string {
  if (!PROFILE.test(value)) throw new SafeCliError("configuration_missing_or_unsafe");
  return value;
}

function exactAccount(value: string | undefined): string {
  if (!value || !ACCOUNT.test(value)) {
    throw new SafeCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function readWormResult(filename: string, expectedSha256: string): PostgresLogicalWormResult {
  let bytes: Buffer;
  try {
    bytes = readTrustedRegularFile(filename, {
      minBytes: 2,
      maxBytes: 64 * 1024,
      requireOwner: true,
      requirePrivate: true,
    });
  } catch {
    throw new SafeCliError("trusted_input_invalid");
  }
  try {
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      throw new Error("hash");
    }
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || canonicalPostgresBackupJson(parsed) !== bytes.toString("utf8")) {
      throw new Error("canonical");
    }
    return parsed as PostgresLogicalWormResult;
  } catch {
    throw new SafeCliError("trusted_input_invalid");
  } finally {
    bytes.fill(0);
  }
}

function failureCode(error: unknown): PostgresLogicalWormRetrievalCliFailureCode {
  if (error instanceof SafeCliError || error instanceof PostgresLogicalWormRetrievalError) {
    return error.code;
  }
  return "unexpected_failure";
}

export async function runPostgresLogicalWormRetrievalCli(
  argv: readonly string[],
  overrides: Partial<PostgresLogicalWormRetrievalCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  let loaded: LoadedLogicalWormReader | null = null;
  let failure: PostgresLogicalWormRetrievalCliFailureCode | null = null;
  let successOutput: string | null = null;
  try {
    let args: ReadonlyMap<string, string>;
    try {
      args = parseStrictArguments(argv, { allowed: ARGUMENTS, required: ARGUMENTS });
    } catch {
      throw new SafeCliError("configuration_missing_or_unsafe");
    }
    if (dependencies.env[POSTGRES_LOGICAL_WORM_RETRIEVAL_CONFIRMATION_ENV]
      !== POSTGRES_LOGICAL_WORM_RETRIEVAL_CONFIRMATION_VALUE) {
      throw new SafeCliError("confirmation_required");
    }
    if (dependencies.env[POSTGRES_LOGICAL_WORM_RETRIEVAL_AWS_GATE_ENV]
      !== POSTGRES_LOGICAL_WORM_RETRIEVAL_AWS_GATE_VALUE) {
      throw new SafeCliError("real_aws_gate_required");
    }
    const wormResultFile = exactAbsolute(args.get("--worm-result-file")!);
    const wormResultSha256 = exactSha(args.get("--worm-result-sha256")!);
    const outputDirectory = exactAbsolute(args.get("--output-directory")!);
    const receiptFile = exactAbsolute(args.get("--receipt-file")!);
    const receiptDirectory = path.dirname(receiptFile);
    const receiptLeaf = path.basename(receiptFile);
    if (receiptDirectory === outputDirectory || receiptLeaf !== "logical-worm-retrieval-receipt.json") {
      throw new SafeCliError("configuration_missing_or_unsafe");
    }
    const receiptAuthority = (() => {
      try {
        return holdPrivateDirectoryIdentity(receiptDirectory, {
          requireExactDirectoryMode: true,
          requireOwner: true,
        });
      } catch {
        throw new SafeCliError("configuration_missing_or_unsafe");
      }
    })();
    try {
      const wormResult = readWormResult(wormResultFile, wormResultSha256);
      const bucketName = exactBucket(args.get("--bucket-name")!);
      loaded = dependencies.loadReader({
        bucketName,
        readerProfile: exactProfile(args.get("--reader-profile")!),
      });
      const result = await dependencies.retrieve({
        outputDirectory,
        wormResult,
        wormResultSha256,
        bucketName,
        expectedBucketNameSha256: exactSha(args.get("--expected-bucket-name-sha256")!),
        recoveryAccountId: exactAccount(
          dependencies.env[POSTGRES_LOGICAL_WORM_RETRIEVAL_ACCOUNT_ENV],
        ),
        expectedRecoveryAccountIdSha256: exactSha(
          args.get("--expected-recovery-account-id-sha256")!,
        ),
        expectedReaderPrincipalArnSha256: exactSha(
          args.get("--expected-reader-principal-arn-sha256")!,
        ),
        provider: loaded.provider,
      });
      receiptAuthority.assertExact();
      try {
        writePrivateExclusiveFile(
          receiptDirectory,
          receiptLeaf,
          canonicalPostgresBackupJson(result),
          {
            requireExactDirectoryMode: true,
            requireOwner: true,
            expectedDirectoryIdentity: receiptAuthority.identity,
          },
        );
      } catch {
        throw new SafeCliError("receipt_write_failed");
      }
      receiptAuthority.assertExact();
      successOutput = canonicalPostgresBackupJson({
        schemaVersion: 1,
        ok: true,
        kind: result.kind,
        receiptSha256: crypto.createHash("sha256")
          .update(canonicalPostgresBackupJson(result)).digest("hex"),
      });
    } finally {
      receiptAuthority.close();
    }
  } catch (error) {
    failure = failureCode(error);
  } finally {
    if (loaded) {
      try { loaded.close(); } catch { failure = "provider_close_failed"; }
    }
  }
  if (failure) {
    dependencies.writeOutput(canonicalPostgresBackupJson({
      schemaVersion: 1,
      ok: false,
      failureCode: failure,
    }));
    return 1;
  }
  if (!successOutput) {
    dependencies.writeOutput(canonicalPostgresBackupJson({
      schemaVersion: 1,
      ok: false,
      failureCode: "unexpected_failure",
    }));
    return 1;
  }
  dependencies.writeOutput(successOutput);
  return 0;
}

const direct = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (direct) {
  const exitCode = await runPostgresLogicalWormRetrievalCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
