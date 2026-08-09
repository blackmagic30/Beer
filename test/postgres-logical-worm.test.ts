import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  POSTGRES_LOGICAL_WORM_AWS_GATE_ENV,
  POSTGRES_LOGICAL_WORM_AWS_GATE_VALUE,
  POSTGRES_LOGICAL_WORM_CONFIRMATION_ENV,
  POSTGRES_LOGICAL_WORM_CONFIRMATION_VALUE,
  POSTGRES_LOGICAL_WORM_RECOVERY_ACCOUNT_ENV,
  runPostgresLogicalWormCli,
  type PostgresLogicalWormCliDependencies,
} from "../scripts/attest-postgres-logical-worm.js";
import {
  POSTGRES_LOGICAL_WORM_REGION,
  POSTGRES_LOGICAL_WORM_RETENTION_DAYS,
  PostgresLogicalWormError,
  attestPostgresLogicalWorm,
  buildPostgresLogicalWormReaderPolicy,
  buildPostgresLogicalWormWriterPolicy,
  createAwsSdkV3PostgresLogicalWormProvider,
  type AwsSdkV3WormClient,
  type AwsSdkV3WormCommandConstructor,
  type AwsSdkV3WormCommands,
  type PostgresLogicalWormBucketControls,
  type PostgresLogicalWormDenialEvidence,
  type PostgresLogicalWormProvider,
  type PostgresLogicalWormPutInput,
  type PostgresLogicalWormReadResult,
  type PostgresLogicalWormVersionInventory,
  type PostgresLogicalWormWriterDenialAction,
} from "../src/lib/postgres-logical-worm.js";
import {
  writeLogicalOffsiteFixture,
} from "./postgres-logical-offsite.fixtures.js";

const ACCOUNT_ID = "123456789012";
const FORBIDDEN_ACCOUNT_ID = "210987654321";
const BUCKET = "pintpath-recovery-worm-test";
const WRITER_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/pintpath-worm-writer`;
const READER_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/pintpath-worm-reader`;
const OPERATOR = "operator-test-reference";
const NOW = new Date("2026-08-09T02:00:00.000Z");
const LAST_MODIFIED = "2026-08-09T02:00:01.000Z";
const RETAIN_UNTIL = new Date(
  NOW.getTime() + POSTGRES_LOGICAL_WORM_RETENTION_DAYS * 24 * 60 * 60 * 1000,
).toISOString();

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const CONTROLS: PostgresLogicalWormBucketControls = Object.freeze({
  region: POSTGRES_LOGICAL_WORM_REGION,
  versioning: "Enabled",
  objectLockEnabled: true,
  defaultRetentionMode: "COMPLIANCE",
  defaultRetentionDays: POSTGRES_LOGICAL_WORM_RETENTION_DAYS,
  defaultRetentionYears: null,
  blockPublicAcls: true,
  ignorePublicAcls: true,
  blockPublicPolicy: true,
  restrictPublicBuckets: true,
  bucketOwnerEnforced: true,
  policyIsPublic: false,
  defaultEncryptionAlgorithms: ["AES256"],
  requesterPays: false,
});

interface StoredObject {
  readonly key: string;
  readonly versionId: string;
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly checksumSha256Base64: string;
  readonly retainUntil: string;
}

interface MemoryProviderOptions {
  readonly controls?: PostgresLogicalWormBucketControls;
  readonly writerArn?: string;
  readonly readerArn?: string;
  readonly writerAccountId?: string;
  readonly readerAccountId?: string;
  readonly retainUntil?: string;
  readonly corruptDownloads?: boolean;
  readonly denialSucceeds?: PostgresLogicalWormWriterDenialAction;
  readonly collision?: boolean;
  readonly deleteMarker?: boolean;
}

class MemoryWormProvider implements PostgresLogicalWormProvider {
  readonly region = POSTGRES_LOGICAL_WORM_REGION;
  readonly bucketName = BUCKET;
  readonly objects = new Map<string, StoredObject>();
  readonly puts: PostgresLogicalWormPutInput[] = [];
  readonly denialActions: PostgresLogicalWormWriterDenialAction[] = [];
  private version = 0;

  constructor(private readonly options: MemoryProviderOptions = {}) {}

  async inspectWriterIdentity() {
    return {
      accountId: this.options.writerAccountId ?? ACCOUNT_ID,
      principalArn: this.options.writerArn ?? WRITER_ARN,
    };
  }

  async inspectReaderIdentity() {
    return {
      accountId: this.options.readerAccountId ?? ACCOUNT_ID,
      principalArn: this.options.readerArn ?? READER_ARN,
    };
  }

  async inspectBucketControls() {
    return this.options.controls ?? CONTROLS;
  }

  async listExactVersions(input: { readonly key: string }):
  Promise<PostgresLogicalWormVersionInventory> {
    if (this.options.collision) {
      return {
        truncated: false,
        versions: [1, 2].map((index) => ({
          key: input.key,
          versionId: `collision-${index}`,
          isLatest: index === 2,
          bytes: 1,
          lastModified: LAST_MODIFIED,
        })),
        deleteMarkers: [],
      };
    }
    if (this.options.deleteMarker) {
      return {
        truncated: false,
        versions: [],
        deleteMarkers: [{ key: input.key, versionId: "marker-1", isLatest: true }],
      };
    }
    const stored = this.objects.get(input.key);
    return {
      truncated: false,
      versions: stored
        ? [{
          key: stored.key,
          versionId: stored.versionId,
          isLatest: true,
          bytes: stored.body.length,
          lastModified: LAST_MODIFIED,
        }]
        : [],
      deleteMarkers: [],
    };
  }

  async putImmutable(input: PostgresLogicalWormPutInput) {
    this.puts.push(input);
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    expect(body).toHaveLength(input.bytes);
    expect(sha256(body)).toBe(input.sha256);
    const versionId = `version/${++this.version}+opaque=`;
    this.objects.set(input.key, {
      key: input.key,
      versionId,
      body,
      contentType: input.contentType,
      cacheControl: input.cacheControl,
      metadata: input.metadata,
      checksumSha256Base64: input.checksumSha256Base64,
      retainUntil: this.options.retainUntil ?? RETAIN_UNTIL,
    });
    return {
      versionId,
      checksumSha256Base64: input.checksumSha256Base64,
      serverSideEncryption: "AES256" as const,
      eTag: `"${sha256(body).slice(0, 32)}"`,
      requestIdSha256: sha256(`put-${versionId}`),
    };
  }

  async readExactVersion(input: { readonly key: string; readonly versionId: string }):
  Promise<PostgresLogicalWormReadResult> {
    const stored = this.objects.get(input.key);
    if (!stored || stored.versionId !== input.versionId) throw new Error("not found");
    const body = this.options.corruptDownloads
      ? Buffer.concat([stored.body, Buffer.from("tampered")])
      : stored.body;
    return {
      key: stored.key,
      versionId: stored.versionId,
      bytes: stored.body.length,
      checksumSha256Base64: stored.checksumSha256Base64,
      contentType: stored.contentType,
      cacheControl: stored.cacheControl,
      metadata: stored.metadata,
      serverSideEncryption: "AES256",
      objectLockMode: "COMPLIANCE",
      retainUntil: stored.retainUntil,
      lastModified: LAST_MODIFIED,
      body: Readable.from([body]),
    };
  }

  async runWriterDenialCanary(input: {
    readonly action: PostgresLogicalWormWriterDenialAction;
  }): Promise<PostgresLogicalWormDenialEvidence> {
    this.denialActions.push(input.action);
    if (this.options.denialSucceeds === input.action) throw new Error("operation succeeded");
    return {
      action: input.action,
      errorCode: "AccessDenied",
      httpStatusCode: 403,
      requestIdSha256: sha256(`request-${input.action}`),
      extendedRequestIdSha256: sha256(`extended-${input.action}`),
    };
  }
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-worm-test-")),
  );
  fs.chmodSync(root, 0o700);
  temporaryRoots.push(root);
  return writeLogicalOffsiteFixture(root);
}

function options(
  provider: PostgresLogicalWormProvider,
  backup = fixture(),
) {
  return {
    backupDirectory: backup.backupDirectory,
    expectedManifestSha256: backup.manifestSha256,
    bucketName: BUCKET,
    expectedBucketNameSha256: sha256(BUCKET),
    recoveryAccountId: ACCOUNT_ID,
    expectedRecoveryAccountIdSha256: sha256(ACCOUNT_ID),
    expectedWriterPrincipalArnSha256: sha256(WRITER_ARN),
    expectedReaderPrincipalArnSha256: sha256(READER_ARN),
    forbiddenAccountIds: [FORBIDDEN_ACCOUNT_ID],
    operatorId: OPERATOR,
    provider,
    now: () => new Date(NOW),
  } as const;
}

describe("Postgres logical WORM authority", () => {
  it("publishes exact Put-only writer and read-only verifier policy contracts", () => {
    const writer = buildPostgresLogicalWormWriterPolicy(BUCKET);
    expect(writer.Statement).toEqual([{
      Sid: "PutOnlyConditionalSseS3WormObjects",
      Effect: "Allow",
      Action: "s3:PutObject",
      Resource: `arn:aws:s3:::${BUCKET}/_recovery/postgres-logical-backups/v1/*`,
      Condition: {
        StringEquals: {
          "s3:if-none-match": "*",
          "s3:x-amz-server-side-encryption": "AES256",
        },
      },
    }]);
    const reader = buildPostgresLogicalWormReaderPolicy(BUCKET);
    const readerActions = reader.Statement.flatMap((statement) => (
      typeof statement.Action === "string" ? [statement.Action] : statement.Action
    ));
    expect(readerActions).toContain("s3:GetObjectVersion");
    expect(readerActions).toContain("s3:GetObjectRetention");
    expect(readerActions).toContain("s3:ListBucketVersions");
    expect(readerActions.some((action) => /Put|Delete|Bypass/.test(action))).toBe(false);
    expect(JSON.stringify(writer)).not.toMatch(/Get|List|Delete|Retention|Bypass/);
  });

  it("writes four content-addressed versions and proves exact bytes, controls, retention, and denials", async () => {
    const provider = new MemoryWormProvider();
    const attestationOptions = options(provider);
    const result = await attestPostgresLogicalWorm(attestationOptions);

    expect(result.ok).toBe(true);
    expect(provider.puts).toHaveLength(4);
    expect(provider.objects.size).toBe(4);
    expect(provider.denialActions).toEqual([
      "get_object_version",
      "list_object_versions",
      "delete_object_version",
      "get_object_retention",
      "get_bucket_object_lock_configuration",
      "get_object_version",
      "list_object_versions",
      "delete_object_version",
      "get_object_retention",
      "get_bucket_object_lock_configuration",
    ]);
    for (const put of provider.puts) {
      expect(put).toMatchObject({
        ifNoneMatch: "*",
        checksumAlgorithm: "SHA256",
        serverSideEncryption: "AES256",
        expectedBucketOwner: ACCOUNT_ID,
      });
      expect(put.checksumSha256Base64).toBe(
        Buffer.from(put.sha256, "hex").toString("base64"),
      );
      expect(put.metadata.contract).toBe("pintpath-postgres-logical-worm-v1");
    }
    expect(result.minimumRetainUntil).toBe(RETAIN_UNTIL);

    const receipt = [...provider.objects.values()].find((value) => (
      value.key.includes("/receipts/")
    ));
    expect(receipt).toBeDefined();
    const parsed = JSON.parse(receipt!.body.toString("utf8")) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      kind: "pintpath-postgres-logical-worm-receipt",
      version: 1,
      recoveryAccountIdSha256: sha256(ACCOUNT_ID),
      bucketNameSha256: sha256(BUCKET),
      writerPrincipalArnSha256: sha256(WRITER_ARN),
      readerPrincipalArnSha256: sha256(READER_ARN),
    });
    expect(parsed.objects).toHaveLength(3);
    expect(parsed.writerDenials).toHaveLength(5);

    const publicOutput = JSON.stringify(result);
    for (const forbidden of [
      ACCOUNT_ID,
      BUCKET,
      WRITER_ARN,
      READER_ARN,
      OPERATOR,
      attestationOptions.backupDirectory,
      "version/1+opaque=",
    ]) expect(publicOutput).not.toContain(forbidden);
  });

  it("rejects a mismatched or non-independent authority before uploading", async () => {
    const wrongAccount = new MemoryWormProvider({ writerAccountId: FORBIDDEN_ACCOUNT_ID });
    await expect(attestPostgresLogicalWorm(options(wrongAccount)))
      .rejects.toMatchObject({ code: "authority_identity_mismatch" });
    expect(wrongAccount.puts).toHaveLength(0);

    const sharedRole = new MemoryWormProvider({ readerArn: WRITER_ARN });
    const sharedOptions = {
      ...options(sharedRole),
      expectedReaderPrincipalArnSha256: sha256(WRITER_ARN),
    };
    await expect(attestPostgresLogicalWorm(sharedOptions))
      .rejects.toMatchObject({ code: "authority_not_independent" });
    expect(sharedRole.puts).toHaveLength(0);

    const forbiddenRecovery = new MemoryWormProvider();
    await expect(attestPostgresLogicalWorm({
      ...options(forbiddenRecovery),
      forbiddenAccountIds: [ACCOUNT_ID],
    })).rejects.toMatchObject({ code: "authority_not_independent" });
    expect(forbiddenRecovery.puts).toHaveLength(0);
  });

  it.each([
    ["wrong region", { ...CONTROLS, region: "ap-southeast-2" }],
    ["governance", { ...CONTROLS, defaultRetentionMode: "GOVERNANCE" as const }],
    ["short retention", { ...CONTROLS, defaultRetentionDays: 29 }],
    ["public policy", { ...CONTROLS, policyIsPublic: true }],
    ["ACL ownership", { ...CONTROLS, bucketOwnerEnforced: false }],
    ["KMS default", { ...CONTROLS, defaultEncryptionAlgorithms: ["aws:kms"] }],
    ["requester pays", { ...CONTROLS, requesterPays: true }],
  ])("rejects unsafe bucket control: %s", async (_name, controls) => {
    const provider = new MemoryWormProvider({ controls });
    await expect(attestPostgresLogicalWorm(options(provider)))
      .rejects.toMatchObject({ code: "bucket_controls_invalid" });
    expect(provider.puts).toHaveLength(0);
  });

  it("requires each exact object version to retain COMPLIANCE protection for the full window", async () => {
    const tooShort = new Date(NOW.getTime() + 29 * 24 * 60 * 60 * 1000).toISOString();
    const provider = new MemoryWormProvider({ retainUntil: tooShort });
    await expect(attestPostgresLogicalWorm(options(provider)))
      .rejects.toMatchObject({ code: "retention_proof_failed" });
  });

  it("fails closed on corrupt or over-limit reader streams", async () => {
    const provider = new MemoryWormProvider({ corruptDownloads: true });
    await expect(attestPostgresLogicalWorm(options(provider)))
      .rejects.toMatchObject({ code: "stream_limit_exceeded" });
  });

  it("rejects version collisions and delete markers before PutObject", async () => {
    for (const provider of [
      new MemoryWormProvider({ collision: true }),
      new MemoryWormProvider({ deleteMarker: true }),
    ]) {
      await expect(attestPostgresLogicalWorm(options(provider)))
        .rejects.toMatchObject({ code: "object_collision" });
      expect(provider.puts).toHaveLength(0);
    }
  });

  it("requires every writer denial to be an exact AccessDenied 403 proof", async () => {
    const provider = new MemoryWormProvider({ denialSucceeds: "delete_object_version" });
    await expect(attestPostgresLogicalWorm(options(provider)))
      .rejects.toMatchObject({ code: "writer_not_least_privilege" });
  });

  it("pins bucket/account values before constructing provider operations", async () => {
    const provider = new MemoryWormProvider();
    await expect(attestPostgresLogicalWorm({
      ...options(provider),
      expectedBucketNameSha256: "a".repeat(64),
    })).rejects.toMatchObject({ code: "destination_pin_mismatch" });
    expect(provider.puts).toHaveLength(0);
  });
});

describe("AWS SDK v3 WORM adapter", () => {
  class CapturedCommand {
    constructor(readonly input: Readonly<Record<string, unknown>>) {}
  }

  const commands = Object.fromEntries([
    "GetCallerIdentityCommand",
    "PutObjectCommand",
    "GetObjectCommand",
    "GetObjectRetentionCommand",
    "DeleteObjectCommand",
    "ListObjectVersionsCommand",
    "GetBucketLocationCommand",
    "GetBucketVersioningCommand",
    "GetObjectLockConfigurationCommand",
    "GetPublicAccessBlockCommand",
    "GetBucketOwnershipControlsCommand",
    "GetBucketEncryptionCommand",
    "GetBucketPolicyStatusCommand",
    "GetBucketRequestPaymentCommand",
  ].map((name) => [name, class extends CapturedCommand {
    static readonly commandName = name;
    readonly commandName = name;
  }])) as unknown as AwsSdkV3WormCommands;

  it("normalizes assumed-role identity and sends conditional SHA-256 SSE-S3 PutObject without retention authority", async () => {
    const sent: CapturedCommand[] = [];
    const writerS3: AwsSdkV3WormClient = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command as CapturedCommand);
        return {
          VersionId: "aws-version-1",
          ChecksumSHA256: Buffer.from("a".repeat(64), "hex").toString("base64"),
          ServerSideEncryption: "AES256",
          ETag: '"etag"',
          $metadata: { requestId: "aws-request-id" },
        };
      }),
    };
    const reader = { send: vi.fn() } as unknown as AwsSdkV3WormClient;
    const writerSts: AwsSdkV3WormClient = {
      send: vi.fn(async () => ({
        Account: ACCOUNT_ID,
        Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/pintpath-worm-writer/session-123`,
        $metadata: { requestId: "sts-request" },
      })),
    };
    const provider = createAwsSdkV3PostgresLogicalWormProvider({
      region: POSTGRES_LOGICAL_WORM_REGION,
      bucketName: BUCKET,
      writerS3,
      readerS3: reader,
      writerSts,
      readerSts: reader,
      commands,
    });
    await expect(provider.inspectWriterIdentity(new AbortController().signal)).resolves.toEqual({
      accountId: ACCOUNT_ID,
      principalArn: WRITER_ARN,
    });
    const digest = "a".repeat(64);
    await provider.putImmutable({
      key: "_recovery/postgres-logical-backups/v1/test",
      body: Readable.from([Buffer.from("body")]),
      bytes: 4,
      sha256: digest,
      checksumSha256Base64: Buffer.from(digest, "hex").toString("base64"),
      contentType: "application/octet-stream",
      cacheControl: "private, max-age=2592000, immutable",
      metadata: { sha256: digest },
      expectedBucketOwner: ACCOUNT_ID,
      ifNoneMatch: "*",
      checksumAlgorithm: "SHA256",
      serverSideEncryption: "AES256",
      signal: new AbortController().signal,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toMatchObject({
      Bucket: BUCKET,
      ExpectedBucketOwner: ACCOUNT_ID,
      IfNoneMatch: "*",
      ChecksumAlgorithm: "SHA256",
      ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
      ServerSideEncryption: "AES256",
    });
    expect(sent[0]!.input).not.toHaveProperty("ObjectLockMode");
    expect(sent[0]!.input).not.toHaveProperty("ObjectLockRetainUntilDate");
    expect(sent[0]!.input).not.toHaveProperty("ACL");
  });
});

describe("Postgres logical WORM CLI safety gates", () => {
  const HASH = "a".repeat(64);
  const ARGV = [
    "--backup-directory", "/private/operator/backup",
    "--backup-manifest-sha256", HASH,
    "--bucket-name", BUCKET,
    "--expected-bucket-name-sha256", sha256(BUCKET),
    "--expected-reader-principal-arn-sha256", sha256(READER_ARN),
    "--expected-recovery-account-id-sha256", sha256(ACCOUNT_ID),
    "--expected-writer-principal-arn-sha256", sha256(WRITER_ARN),
    "--operator-id", OPERATOR,
    "--reader-profile", "worm-reader",
    "--writer-profile", "worm-writer",
  ] as const;

  function cliHarness(env: Readonly<Record<string, string | undefined>>) {
    const output: string[] = [];
    const loadAwsProvider = vi.fn(() => ({
      provider: {} as PostgresLogicalWormProvider,
      close: vi.fn(),
    }));
    const dependencies: Partial<PostgresLogicalWormCliDependencies> = {
      env,
      assertMutationAllowed: vi.fn(),
      loadAwsProvider,
      attest: vi.fn(async () => {
        throw new PostgresLogicalWormError("bucket_controls_invalid");
      }),
      writeOutput: (value) => output.push(value),
    };
    return { output, loadAwsProvider, dependencies };
  }

  it("does not load credentials until both explicit real-AWS gates pass", async () => {
    const noConfirmation = cliHarness({});
    await expect(runPostgresLogicalWormCli(ARGV, noConfirmation.dependencies)).resolves.toBe(1);
    expect(JSON.parse(noConfirmation.output[0]!)).toMatchObject({
      failureCode: "confirmation_required",
    });
    expect(noConfirmation.loadAwsProvider).not.toHaveBeenCalled();

    const noAwsGate = cliHarness({
      [POSTGRES_LOGICAL_WORM_CONFIRMATION_ENV]: POSTGRES_LOGICAL_WORM_CONFIRMATION_VALUE,
    });
    await expect(runPostgresLogicalWormCli(ARGV, noAwsGate.dependencies)).resolves.toBe(1);
    expect(JSON.parse(noAwsGate.output[0]!)).toMatchObject({
      failureCode: "real_aws_gate_required",
    });
    expect(noAwsGate.loadAwsProvider).not.toHaveBeenCalled();
  });

  it("emits only stable error codes after provider failures", async () => {
    const harness = cliHarness({
      [POSTGRES_LOGICAL_WORM_CONFIRMATION_ENV]: POSTGRES_LOGICAL_WORM_CONFIRMATION_VALUE,
      [POSTGRES_LOGICAL_WORM_AWS_GATE_ENV]: POSTGRES_LOGICAL_WORM_AWS_GATE_VALUE,
      [POSTGRES_LOGICAL_WORM_RECOVERY_ACCOUNT_ENV]: ACCOUNT_ID,
    });
    await expect(runPostgresLogicalWormCli(ARGV, harness.dependencies)).resolves.toBe(1);
    expect(JSON.parse(harness.output[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      failureCode: "bucket_controls_invalid",
    });
    for (const forbidden of [ACCOUNT_ID, BUCKET, WRITER_ARN, READER_ARN, OPERATOR]) {
      expect(harness.output[0]).not.toContain(forbidden);
    }
  });
});
