import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";

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
  POSTGRES_LOGICAL_WORM_RETRIEVAL_ACCOUNT_ENV,
  POSTGRES_LOGICAL_WORM_RETRIEVAL_AWS_GATE_ENV,
  POSTGRES_LOGICAL_WORM_RETRIEVAL_AWS_GATE_VALUE,
  POSTGRES_LOGICAL_WORM_RETRIEVAL_CONFIRMATION_ENV,
  POSTGRES_LOGICAL_WORM_RETRIEVAL_CONFIRMATION_VALUE,
  runPostgresLogicalWormRetrievalCli,
  type PostgresLogicalWormRetrievalCliDependencies,
} from "../scripts/retrieve-postgres-logical-worm.js";
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
  PostgresLogicalWormRetrievalError,
  postgresLogicalWormRetrievalInternals,
  retrievePostgresLogicalWormBackup,
} from "../src/lib/postgres-logical-worm-retrieval.js";
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

function fixture(manifestSchemaVersion: 2 | 3 = 3) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-worm-test-")),
  );
  fs.chmodSync(root, 0o700);
  temporaryRoots.push(root);
  return writeLogicalOffsiteFixture(
    root,
    "2026-08-09T01:00:00.000Z",
    manifestSchemaVersion,
  );
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

function retrievalOptions(
  provider: MemoryWormProvider,
  wormResult: Awaited<ReturnType<typeof attestPostgresLogicalWorm>>,
  outputDirectory: string,
) {
  return {
    outputDirectory,
    wormResult,
    wormResultSha256: sha256(canonicalPostgresBackupJson(wormResult)),
    bucketName: BUCKET,
    expectedBucketNameSha256: sha256(BUCKET),
    recoveryAccountId: ACCOUNT_ID,
    expectedRecoveryAccountIdSha256: sha256(ACCOUNT_ID),
    expectedReaderPrincipalArnSha256: sha256(READER_ARN),
    provider,
    now: () => new Date("2026-08-10T02:00:00.000Z"),
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
      "delete_object_marker",
      "delete_object_version",
      "get_object_retention",
      "get_bucket_object_lock_configuration",
      "get_object_version",
      "list_object_versions",
      "delete_object_marker",
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
    expect(parsed.writerDenials).toHaveLength(6);

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

  it("rejects a valid schema-v2 manifest before any provider call", async () => {
    const provider = new MemoryWormProvider();
    const inspectWriter = vi.spyOn(provider, "inspectWriterIdentity");
    const inspectReader = vi.spyOn(provider, "inspectReaderIdentity");
    const inspectBucket = vi.spyOn(provider, "inspectBucketControls");
    const listVersions = vi.spyOn(provider, "listExactVersions");
    await expect(attestPostgresLogicalWorm(options(provider, fixture(2))))
      .rejects.toEqual(new PostgresLogicalWormError("backup_manifest_invalid"));
    expect(inspectWriter).not.toHaveBeenCalled();
    expect(inspectReader).not.toHaveBeenCalled();
    expect(inspectBucket).not.toHaveBeenCalled();
    expect(listVersions).not.toHaveBeenCalled();
    expect(provider.puts).toEqual([]);
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

describe("Postgres logical WORM read-only retrieval", () => {
  it("rejects a replacement inserted after output creation but before descriptor open", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-worm-output-race-")),
    );
    fs.chmodSync(root, 0o700);
    temporaryRoots.push(root);
    const outputDirectory = path.join(root, "retrieved-backup");
    const displaced = path.join(root, "created-output-held");
    const originalOpenSync = fs.openSync;
    let injected = false;
    let creationTarget = "";
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      const [target, flags] = args;
      if (
        !injected && typeof flags === "number"
        && (flags & fs.constants.O_DIRECTORY) !== 0
        && path.basename(String(target)) === path.basename(outputDirectory)
      ) {
        injected = true;
        creationTarget = String(target);
        fs.renameSync(outputDirectory, displaced);
        fs.mkdirSync(outputDirectory, { mode: 0o700 });
      }
      return Reflect.apply(originalOpenSync, fs, args);
    });
    try {
      expect(() => postgresLogicalWormRetrievalInternals.prepareOutput(
        outputDirectory,
      )).toThrow(new PostgresLogicalWormRetrievalError("unsafe_output_path"));
      expect(injected).toBe(true);
      if (process.platform === "linux") {
        expect(creationTarget).toMatch(
          /^\/proc\/self\/fd\/[1-9][0-9]*\/retrieved-backup$/,
        );
      }
      expect(fs.statSync(displaced).isDirectory()).toBe(true);
      expect(fs.statSync(outputDirectory).isDirectory()).toBe(true);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("reconstructs the exact restore directory from independently verified immutable versions", async () => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const outputDirectory = path.join(path.dirname(backup.backupDirectory), "worm-retrieved");

    const result = await retrievePostgresLogicalWormBackup(
      retrievalOptions(provider, wormResult, outputDirectory),
    );

    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "pintpath-postgres-logical-worm-retrieval",
      ok: true,
      archiveSha256: wormResult.archiveSha256,
      manifestSha256: wormResult.manifestSha256,
      stateReceiptSha256: wormResult.stateReceiptSha256,
      wormReceiptSha256: wormResult.receiptSha256,
      wormResultSha256: sha256(canonicalPostgresBackupJson(wormResult)),
    });
    expect(fs.statSync(outputDirectory).mode & 0o777).toBe(0o700);
    const filenames = fs.readdirSync(outputDirectory).sort();
    expect(filenames).toEqual([
      "manifest.json",
      "pintpath-postgres.dump",
      "state-receipt.json",
    ]);
    for (const filename of filenames) {
      const restored = path.join(outputDirectory, filename);
      expect(fs.statSync(restored).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(restored)).toEqual(
        fs.readFileSync(path.join(backup.backupDirectory, filename)),
      );
    }
    expect(provider.puts).toHaveLength(4);
  });

  it("rejects a mismatched canonical WORM-result digest before any provider call", async () => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const inspectReader = vi.spyOn(provider, "inspectReaderIdentity");
    inspectReader.mockClear();
    const inspectControls = vi.spyOn(provider, "inspectBucketControls");
    inspectControls.mockClear();
    const listVersions = vi.spyOn(provider, "listExactVersions");
    listVersions.mockClear();

    await expect(retrievePostgresLogicalWormBackup({
      ...retrievalOptions(
        provider,
        wormResult,
        path.join(path.dirname(backup.backupDirectory), "bad-result"),
      ),
      wormResultSha256: "f".repeat(64),
    })).rejects.toEqual(new PostgresLogicalWormRetrievalError("worm_result_invalid"));
    expect(inspectReader).not.toHaveBeenCalled();
    expect(inspectControls).not.toHaveBeenCalled();
    expect(listVersions).not.toHaveBeenCalled();
  });

  it("rejects empty or arbitrary writer-denial evidence even when its claimed set hash agrees", async () => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const storedReceipt = [...provider.objects.values()].find((value) => (
      value.key.includes("/receipts/")
    ));
    expect(storedReceipt).toBeDefined();
    const receipt = JSON.parse(storedReceipt!.body.toString("utf8")) as Record<string, unknown>;
    const originalDenials = receipt.writerDenials as Record<string, unknown>[];
    const denialCases = [
      [],
      originalDenials.map((denial, index) => index === 0
        ? { ...denial, action: "arbitrary_writer_action" }
        : denial),
    ];
    for (const writerDenials of denialCases) {
      const writerDenialSetSha256 = sha256(canonicalPostgresBackupJson(writerDenials));
      const changedReceipt = {
        ...receipt,
        writerDenials,
        writerDenialSetSha256,
      };
      expect(() => postgresLogicalWormRetrievalInternals.parseReceipt(
        Buffer.from(canonicalPostgresBackupJson(changedReceipt)),
        { ...wormResult, writerDenialSetSha256 },
      )).toThrow(new PostgresLogicalWormRetrievalError("receipt_verification_failed"));
    }
  });

  it("removes an ordinary partial output after a late exact-version collision", async () => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const outputDirectory = path.join(path.dirname(backup.backupDirectory), "late-collision");
    const original = provider.listExactVersions.bind(provider);
    vi.spyOn(provider, "listExactVersions").mockImplementation(async (input) => {
      if (input.key.endsWith("/manifest.json")) {
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
      return original(input);
    });

    await expect(retrievePostgresLogicalWormBackup(
      retrievalOptions(provider, wormResult, outputDirectory),
    )).rejects.toMatchObject({ code: "object_verification_failed" });
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("makes cleanup failure dominant and retains evidence when the output path is replaced or polluted", async () => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const outputDirectory = path.join(path.dirname(backup.backupDirectory), "ambiguous-output");
    const original = provider.listExactVersions.bind(provider);
    let injected = false;
    vi.spyOn(provider, "listExactVersions").mockImplementation(async (input) => {
      if (!injected && input.key.endsWith("/manifest.json")) {
        injected = true;
        fs.writeFileSync(path.join(outputDirectory, "unexpected"), "do-not-delete");
      }
      return original(input);
    });

    await expect(retrievePostgresLogicalWormBackup(
      retrievalOptions(provider, wormResult, outputDirectory),
    )).rejects.toEqual(new PostgresLogicalWormRetrievalError("cleanup_failed"));
    expect(fs.readFileSync(path.join(outputDirectory, "unexpected"), "utf8"))
      .toBe("do-not-delete");
  });

  it("rejects changed immutable bytes and removes the reserved output", async () => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const archive = [...provider.objects.values()].find((entry) => (
      entry.key.endsWith("/pintpath-postgres.dump")
    ));
    expect(archive).toBeDefined();
    archive!.body[0] = archive!.body[0]! ^ 0xff;
    const outputDirectory = path.join(path.dirname(backup.backupDirectory), "tampered-output");

    await expect(retrievePostgresLogicalWormBackup(
      retrievalOptions(provider, wormResult, outputDirectory),
    )).rejects.toMatchObject({ code: "object_verification_failed" });
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("fails closed on bucket-control drift before reading any object", async () => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const list = vi.spyOn(provider, "listExactVersions");
    list.mockClear();
    vi.spyOn(provider, "inspectBucketControls").mockResolvedValue({
      ...CONTROLS,
      policyIsPublic: true,
    });
    const outputDirectory = path.join(path.dirname(backup.backupDirectory), "control-drift");

    await expect(retrievePostgresLogicalWormBackup(
      retrievalOptions(provider, wormResult, outputDirectory),
    )).rejects.toEqual(new PostgresLogicalWormRetrievalError("bucket_controls_invalid"));
    expect(list).not.toHaveBeenCalled();
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it.each([
    ["metadata substitution", (stored: StoredObject) => ({
      ...stored,
      metadata: { ...stored.metadata, sha256: "f".repeat(64) },
    })],
    ["content-type substitution", (stored: StoredObject) => ({
      ...stored,
      contentType: "text/plain",
    })],
    ["expired retention", (stored: StoredObject) => ({
      ...stored,
      retainUntil: "2026-08-10T01:59:59.000Z",
    })],
  ])("rejects immutable object %s and cleans its partial output", async (_name, mutate) => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const archive = [...provider.objects.values()].find((entry) => (
      entry.key.endsWith("/pintpath-postgres.dump")
    ));
    expect(archive).toBeDefined();
    provider.objects.set(archive!.key, mutate(archive!));
    const outputDirectory = path.join(path.dirname(backup.backupDirectory), `substitution-${_name}`);

    await expect(retrievePostgresLogicalWormBackup(
      retrievalOptions(provider, wormResult, outputDirectory),
    )).rejects.toMatchObject({ code: "object_verification_failed" });
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("destroys a stalled remote body at the operation deadline and removes the partial output", async () => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const original = provider.readExactVersion.bind(provider);
    let destroyed = false;
    let rejectPending: ((error: Error) => void) | null = null;
    vi.spyOn(provider, "readExactVersion").mockImplementation(async (input) => {
      if (!input.key.endsWith("/pintpath-postgres.dump")) return original(input);
      const stored = provider.objects.get(input.key)!;
      const body = {
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          await new Promise<never>((_resolve, reject) => { rejectPending = reject; });
        },
        destroy(error?: Error): void {
          destroyed = true;
          rejectPending?.(error ?? new Error("destroyed"));
        },
      };
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
        body,
      };
    });
    const outputDirectory = path.join(path.dirname(backup.backupDirectory), "stalled-body");

    await expect(retrievePostgresLogicalWormBackup({
      ...retrievalOptions(provider, wormResult, outputDirectory),
      operationTimeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(destroyed).toBe(true);
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("retains the held partial inode when the output root pathname is replaced", async () => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const outputDirectory = path.join(path.dirname(backup.backupDirectory), "replaced-root");
    const displaced = `${outputDirectory}-held`;
    const original = provider.listExactVersions.bind(provider);
    let replaced = false;
    vi.spyOn(provider, "listExactVersions").mockImplementation(async (input) => {
      if (!replaced && input.key.endsWith("/manifest.json")) {
        replaced = true;
        fs.renameSync(outputDirectory, displaced);
        fs.mkdirSync(outputDirectory, { mode: 0o700 });
      }
      return original(input);
    });

    await expect(retrievePostgresLogicalWormBackup(
      retrievalOptions(provider, wormResult, outputDirectory),
    )).rejects.toEqual(new PostgresLogicalWormRetrievalError("cleanup_failed"));
    expect(fs.existsSync(path.join(displaced, "pintpath-postgres.dump"))).toBe(true);
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

describe("Postgres logical WORM retrieval CLI", () => {
  it("keeps credential loading behind both read-only AWS gates", async () => {
    const loadReader = vi.fn();
    const output: string[] = [];
    const argv = [
      "--bucket-name", BUCKET,
      "--expected-bucket-name-sha256", sha256(BUCKET),
      "--expected-reader-principal-arn-sha256", sha256(READER_ARN),
      "--expected-recovery-account-id-sha256", sha256(ACCOUNT_ID),
      "--output-directory", "/private/operator/logical-worm-output",
      "--reader-profile", "logical-worm-reader",
      "--receipt-file", "/private/operator/evidence/logical-worm-retrieval-receipt.json",
      "--worm-result-file", "/private/operator/logical-worm-result.json",
      "--worm-result-sha256", "a".repeat(64),
    ];
    const result = await runPostgresLogicalWormRetrievalCli(argv, {
      env: {},
      loadReader,
      writeOutput: (value) => output.push(value),
    });
    expect(result).toBe(1);
    expect(loadReader).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      failureCode: "confirmation_required",
    });
  });

  it("makes reader-provider close failure dominant and emits no success record", async () => {
    const provider = new MemoryWormProvider();
    const backup = fixture();
    const wormResult = await attestPostgresLogicalWorm(options(provider, backup));
    const root = path.dirname(backup.backupDirectory);
    const wormResultFile = path.join(root, "logical-worm-result.json");
    const wormResultBytes = canonicalPostgresBackupJson(wormResult);
    fs.writeFileSync(wormResultFile, wormResultBytes, { mode: 0o600 });
    fs.chmodSync(wormResultFile, 0o600);
    const receiptDirectory = path.join(root, "evidence");
    fs.mkdirSync(receiptDirectory, { mode: 0o700 });
    const outputDirectory = path.join(root, "logical-from-worm");
    const output: string[] = [];
    const close = vi.fn(() => { throw new Error("close failed"); });
    const dependencies: Partial<PostgresLogicalWormRetrievalCliDependencies> = {
      env: {
        [POSTGRES_LOGICAL_WORM_RETRIEVAL_CONFIRMATION_ENV]:
          POSTGRES_LOGICAL_WORM_RETRIEVAL_CONFIRMATION_VALUE,
        [POSTGRES_LOGICAL_WORM_RETRIEVAL_AWS_GATE_ENV]:
          POSTGRES_LOGICAL_WORM_RETRIEVAL_AWS_GATE_VALUE,
        [POSTGRES_LOGICAL_WORM_RETRIEVAL_ACCOUNT_ENV]: ACCOUNT_ID,
      },
      loadReader: vi.fn(() => ({ provider, close })),
      writeOutput: (value) => output.push(value),
    };
    const argv = [
      "--bucket-name", BUCKET,
      "--expected-bucket-name-sha256", sha256(BUCKET),
      "--expected-reader-principal-arn-sha256", sha256(READER_ARN),
      "--expected-recovery-account-id-sha256", sha256(ACCOUNT_ID),
      "--output-directory", outputDirectory,
      "--reader-profile", "logical-worm-reader",
      "--receipt-file", path.join(receiptDirectory, "logical-worm-retrieval-receipt.json"),
      "--worm-result-file", wormResultFile,
      "--worm-result-sha256", sha256(wormResultBytes),
    ];

    await expect(runPostgresLogicalWormRetrievalCli(argv, dependencies)).resolves.toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      failureCode: "provider_close_failed",
    });
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
