import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_LOGICAL_WORM_REGION,
  POSTGRES_LOGICAL_WORM_RETENTION_DAYS,
  type PostgresLogicalWormBucketControls,
  type PostgresLogicalWormProvider,
  type PostgresLogicalWormPutInput,
  type PostgresLogicalWormWriterDenialAction,
} from "../src/lib/postgres-logical-worm.js";
import {
  POSTGRES_RECOVERY_BUNDLE_WORM_KIND,
  PostgresRecoveryBundleWormError,
  postgresRecoveryBundleWormInternals,
  retrievePostgresRecoveryBundleWorm,
  sealPostgresRecoveryBundleWorm,
} from "../src/lib/postgres-recovery-bundle-worm.js";
import {
  POSTGRES_PRIVATE_STORAGE_BUCKET,
  postgresPrivateStorageRecoveryInternals,
  type PostgresPrivateStorageRecoveryManifest,
} from "../src/lib/postgres-private-storage-recovery.js";
import {
  POSTGRES_RECOVERY_BUNDLE_WORM_AWS_GATE_ENV,
  POSTGRES_RECOVERY_BUNDLE_WORM_CONFIRMATION_ENV,
  POSTGRES_RECOVERY_BUNDLE_WORM_FORBIDDEN_ACCOUNTS_ENV,
  POSTGRES_RECOVERY_BUNDLE_WORM_RECOVERY_ACCOUNT_ENV,
  createRecoveryBundleAwsProviderFromRuntime,
  runPostgresRecoveryBundleWormCli,
} from "../scripts/postgres-recovery-bundle-worm.js";

const CANDIDATE = "c".repeat(40);
const ACCOUNT = "123456789012";
const FORBIDDEN_ACCOUNT = "210987654321";
const BUCKET = "pintpath-recovery-worm-test";
const WRITER = `arn:aws:iam::${ACCOUNT}:role/pintpath-recovery-writer`;
const READER = `arn:aws:iam::${ACCOUNT}:role/pintpath-recovery-reader`;
const NOW = new Date("2026-08-14T03:00:00.000Z");
const LAST_MODIFIED = "2026-08-14T03:00:01.000Z";
const RETAIN_UNTIL = new Date(
  NOW.getTime() + POSTGRES_LOGICAL_WORM_RETENTION_DAYS * 86_400_000,
).toISOString();
const roots: string[] = [];

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const CONTROLS: PostgresLogicalWormBucketControls = Object.freeze({
  region: POSTGRES_LOGICAL_WORM_REGION, versioning: "Enabled",
  objectLockEnabled: true, defaultRetentionMode: "COMPLIANCE",
  defaultRetentionDays: POSTGRES_LOGICAL_WORM_RETENTION_DAYS,
  defaultRetentionYears: null, blockPublicAcls: true, ignorePublicAcls: true,
  blockPublicPolicy: true, restrictPublicBuckets: true, bucketOwnerEnforced: true,
  policyIsPublic: false, defaultEncryptionAlgorithms: ["AES256"], requesterPays: false,
});

interface Stored {
  readonly key: string;
  readonly body: Buffer;
  readonly versionId: string;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly metadata: Readonly<Record<string, string>>;
}

class MemoryProvider implements PostgresLogicalWormProvider {
  readonly region = POSTGRES_LOGICAL_WORM_REGION;
  readonly bucketName = BUCKET;
  readonly stored = new Map<string, Stored>();
  controls = CONTROLS;
  readerArn = READER;
  corruptMetadata = false;
  readCalls = 0;
  failReadCall: number | null = null;
  beforeRead: ((call: number) => void) | null = null;

  async inspectWriterIdentity() { return { accountId: ACCOUNT, principalArn: WRITER }; }
  async inspectReaderIdentity() { return { accountId: ACCOUNT, principalArn: this.readerArn }; }
  async inspectBucketControls() { return this.controls; }
  async listExactVersions(input: { readonly key: string }) {
    const value = this.stored.get(input.key);
    return {
      truncated: false, deleteMarkers: [],
      versions: value ? [{
        key: value.key, versionId: value.versionId, isLatest: true,
        bytes: value.body.length, lastModified: LAST_MODIFIED,
      }] : [],
    };
  }
  async putImmutable(input: PostgresLogicalWormPutInput) {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const value = {
      key: input.key, body, versionId: `version-${this.stored.size + 1}`,
      contentType: input.contentType, cacheControl: input.cacheControl,
      metadata: input.metadata,
    };
    this.stored.set(input.key, value);
    return {
      versionId: value.versionId,
      checksumSha256Base64: Buffer.from(input.sha256, "hex").toString("base64"),
      serverSideEncryption: "AES256" as const, eTag: '"etag"',
      requestIdSha256: "a".repeat(64),
    };
  }
  async readExactVersion(input: { readonly key: string }) {
    this.readCalls += 1;
    this.beforeRead?.(this.readCalls);
    if (this.readCalls === this.failReadCall) throw new Error("synthetic read failure");
    const value = this.stored.get(input.key);
    if (!value) throw new Error("not found");
    return {
      key: value.key, versionId: value.versionId, bytes: value.body.length,
      checksumSha256Base64: value.body.toString("base64") === ""
        ? "" : Buffer.from(hash(value.body), "hex").toString("base64"),
      contentType: value.contentType, cacheControl: value.cacheControl,
      metadata: this.corruptMetadata ? { ...value.metadata, unexpected: "true" } : value.metadata,
      serverSideEncryption: "AES256", objectLockMode: "COMPLIANCE",
      retainUntil: RETAIN_UNTIL, lastModified: LAST_MODIFIED,
      body: Readable.from([value.body]),
    };
  }
  async runWriterDenialCanary(input: { readonly action: PostgresLogicalWormWriterDenialAction }) {
    return {
      action: input.action, errorCode: "AccessDenied" as const, httpStatusCode: 403 as const,
      requestIdSha256: "a".repeat(64), extendedRequestIdSha256: null,
    };
  }
}

function privateRoot(): string {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-worm-bundle-")));
  fs.chmodSync(value, 0o700);
  roots.push(value);
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

function writePrivate(filename: string, source: string | Buffer, boundaryRoot: string): void {
  const relative = path.relative(boundaryRoot, filename);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("private test fixture escaped its boundary");
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  for (let current = path.dirname(filename);;) {
    fs.chmodSync(current, 0o700);
    if (current === boundaryRoot) break;
    current = path.dirname(current);
  }
  fs.writeFileSync(filename, source, { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function recoveryFixture() {
  const directory = privateRoot();
  const objectBytes = Buffer.from("private-object", "utf8");
  const current = canonicalPostgresBackupJson({ current: true });
  const genesis = canonicalPostgresBackupJson({ genesis: true });
  const checkpoint = canonicalPostgresBackupJson({ checkpoint: true });
  const object = {
    objectPath: "accounts/evidence.pdf", bytes: objectBytes.length,
    sha256: hash(objectBytes), contentType: "application/pdf",
    sourceStorageObjectIdSha256: "1".repeat(64),
    sourceStorageVersionSha256: "2".repeat(64), referencedByDatabase: true,
  };
  const withoutBinding: Omit<PostgresPrivateStorageRecoveryManifest, "recoverySetSha256"> = {
    kind: "pintpath-postgres-private-storage-recovery-set", version: 2,
    capturedAt: NOW.toISOString(),
    logicalBackup: {
      manifestSha256: "3".repeat(64), archiveSha256: "4".repeat(64),
      stateReceiptSha256: "5".repeat(64), sourceDatabaseIdentitySha256: "6".repeat(64),
      sourceUrlSha256: "7".repeat(64), captureUrlSha256: "8".repeat(64),
      migrationRunSha256: "9".repeat(64), sourceEnvironment: "production",
      candidateSha: CANDIDATE, overallStateSha256: "a".repeat(64),
      sourceEvidenceTableSha256: "b".repeat(64),
    },
    sourceStorage: {
      originSha256: hash("https://jxpubqlmqnnqwadmjgyk.supabase.co"),
      bucketNameSha256: hash(POSTGRES_PRIVATE_STORAGE_BUCKET), objectCount: 1,
      databaseReferenceCount: 1, orphanObjectCount: 0,
      totalBytes: String(objectBytes.length),
      sourceInventorySha256: hash(canonicalPostgresBackupJson([{
        objectPath: object.objectPath, bytes: object.bytes, contentType: object.contentType,
        storageObjectIdSha256: object.sourceStorageObjectIdSha256,
        storageVersionSha256: object.sourceStorageVersionSha256,
      }])),
      objectSetSha256: hash(canonicalPostgresBackupJson([object])), objects: [object],
    },
    deletionAuthority: {
      currentSha256: hash(current), genesisSha256: hash(genesis),
      checkpointSha256: hash(checkpoint), immutableSetSha256: "c".repeat(64),
      tombstoneCount: 1, latestCompletedAt: "2026-08-14T02:00:00.000Z",
      authoritySetSha256: "d".repeat(64),
    },
  };
  const manifest: PostgresPrivateStorageRecoveryManifest = {
    ...withoutBinding,
    recoverySetSha256: postgresPrivateStorageRecoveryInternals.recoverySetBinding(withoutBinding),
  };
  const manifestSource = canonicalPostgresBackupJson(manifest);
  writePrivate(path.join(directory, "recovery-set.json"), manifestSource, directory);
  writePrivate(path.join(directory, "deletion-authority/current.json"), current, directory);
  writePrivate(path.join(directory, "deletion-authority/genesis.json"), genesis, directory);
  writePrivate(path.join(directory, "deletion-authority/checkpoint.json"), checkpoint, directory);
  writePrivate(path.join(directory, "private-storage",
    postgresPrivateStorageRecoveryInternals.recoveryObjectRelativePath(object.objectPath)), objectBytes,
  directory);
  return { directory, manifest, manifestSha256: hash(manifestSource) };
}

function options(provider: MemoryProvider, fixture = recoveryFixture()) {
  return {
    recoverySetDirectory: fixture.directory,
    expectedRecoverySetSha256: fixture.manifest.recoverySetSha256,
    expectedRecoveryManifestSha256: fixture.manifestSha256,
    candidateSha: CANDIDATE, bucketName: BUCKET, expectedBucketNameSha256: hash(BUCKET),
    recoveryAccountId: ACCOUNT, expectedRecoveryAccountIdSha256: hash(ACCOUNT),
    expectedWriterPrincipalArnSha256: hash(WRITER),
    expectedReaderPrincipalArnSha256: hash(READER), forbiddenAccountIds: [FORBIDDEN_ACCOUNT],
    operatorId: "operator-reference", provider, now: () => NOW,
  };
}

function retrievalOptions(
  provider: MemoryProvider,
  sealed: Awaited<ReturnType<typeof sealPostgresRecoveryBundleWorm>>,
  fixture: ReturnType<typeof recoveryFixture>,
  outputDirectory: string,
) {
  return {
    outputDirectory,
    wormResult: sealed,
    wormResultSha256: hash(canonicalPostgresBackupJson(sealed)),
    bucketName: BUCKET,
    expectedBucketNameSha256: hash(BUCKET),
    recoveryAccountId: ACCOUNT,
    expectedRecoveryAccountIdSha256: hash(ACCOUNT),
    expectedReaderPrincipalArnSha256: hash(READER),
    provider,
    now: () => new Date("2026-08-14T03:00:02.000Z"),
  };
}

describe("private recovery bundle WORM", () => {
  it("seals and independently retrieves an exact candidate-bound bundle", async () => {
    const provider = new MemoryProvider();
    const fixture = recoveryFixture();
    const sealed = await sealPostgresRecoveryBundleWorm(options(provider, fixture));
    const output = path.join(privateRoot(), "retrieved");
    const retrieved = await retrievePostgresRecoveryBundleWorm(
      retrievalOptions(provider, sealed, fixture, output),
    );
    expect(retrieved).toMatchObject({
      ok: true, candidateSha: CANDIDATE,
      recoverySetSha256: fixture.manifest.recoverySetSha256,
    });
    expect(fs.statSync(output).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(path.join(output, "recovery-set.json")).mode & 0o7777).toBe(0o600);
  });

  it("rejects missing, extra, and cross-substituted WORM result fields", async () => {
    const provider = new MemoryProvider();
    const fixture = recoveryFixture();
    const sealed = await sealPostgresRecoveryBundleWorm(options(provider, fixture));
    const missing = { ...sealed } as Record<string, unknown>;
    delete missing.receiptObjectKeySha256;
    const extra = { ...sealed, unexpected: true } as Record<string, unknown>;
    for (const value of [missing, extra]) {
      expect(() => postgresRecoveryBundleWormInternals.validateWormResult(
        value as never,
        hash(canonicalPostgresBackupJson(value)),
        new Date("2026-08-14T03:00:02.000Z").getTime(),
      )).toThrow(new PostgresRecoveryBundleWormError("worm_result_invalid"));
    }
    const changed = { ...sealed, immutableObjectSetSha256: "0".repeat(64) };
    await expect(retrievePostgresRecoveryBundleWorm({
      ...retrievalOptions(provider, sealed, fixture, path.join(privateRoot(), "retrieved")),
      wormResult: changed,
      wormResultSha256: hash(canonicalPostgresBackupJson(changed)),
    })).rejects.toEqual(new PostgresRecoveryBundleWormError("receipt_failed"));
  });

  it("rejects missing, extra, and changed immutable receipt fields", async () => {
    const provider = new MemoryProvider();
    const fixture = recoveryFixture();
    const sealed = await sealPostgresRecoveryBundleWorm(options(provider, fixture));
    const storedReceipt = [...provider.stored.values()].find((stored) => {
      try {
        const value = JSON.parse(stored.body.toString("utf8")) as { kind?: unknown; version?: unknown };
        return value.kind === "pintpath-postgres-private-storage-worm-receipt"
          && value.version === 1;
      } catch {
        return false;
      }
    });
    expect(storedReceipt).toBeDefined();
    const receipt = JSON.parse(storedReceipt!.body.toString("utf8")) as Record<string, unknown>;
    const missing = { ...receipt };
    delete missing.writerDenialSetSha256;
    const cases = [
      missing,
      { ...receipt, unexpected: true },
      { ...receipt, immutableObjectSetSha256: "0".repeat(64) },
    ];
    for (const value of cases) {
      expect(() => postgresRecoveryBundleWormInternals.parseWormReceipt(
        Buffer.from(canonicalPostgresBackupJson(value)),
        sealed,
        new Date("2026-08-14T03:00:02.000Z").getTime(),
      )).toThrow(new PostgresRecoveryBundleWormError("receipt_failed"));
    }
  });

  it("rejects an immutable receipt whose individually bounded descriptors exceed the bundle cap", async () => {
    const provider = new MemoryProvider();
    const fixture = recoveryFixture();
    const sealed = await sealPostgresRecoveryBundleWorm(options(provider, fixture));
    const storedReceipt = [...provider.stored.values()].find((stored) => {
      try {
        const value = JSON.parse(stored.body.toString("utf8")) as { kind?: unknown };
        return value.kind === "pintpath-postgres-private-storage-worm-receipt";
      } catch {
        return false;
      }
    });
    expect(storedReceipt).toBeDefined();
    const receipt = JSON.parse(storedReceipt!.body.toString("utf8")) as Record<string, unknown>;
    const immutableObjects = (receipt.immutableObjects as Record<string, unknown>[]).map(
      (descriptor) => descriptor.kind === "recovery-bundle-data"
        ? { ...descriptor, bytes: (20n * 1024n * 1024n * 1024n).toString() }
        : descriptor,
    );
    const immutableObjectSetSha256 = hash(canonicalPostgresBackupJson(immutableObjects));
    const changedReceipt = { ...receipt, immutableObjects, immutableObjectSetSha256 };
    expect(() => postgresRecoveryBundleWormInternals.parseWormReceipt(
      Buffer.from(canonicalPostgresBackupJson(changedReceipt)),
      { ...sealed, immutableObjectSetSha256 },
      new Date("2026-08-14T03:00:02.000Z").getTime(),
    )).toThrow(new PostgresRecoveryBundleWormError("receipt_failed"));
  });

  it("rejects reader identity and bucket-control drift before object reads", async () => {
    const provider = new MemoryProvider();
    const fixture = recoveryFixture();
    const sealed = await sealPostgresRecoveryBundleWorm(options(provider, fixture));
    const sealReadbackCalls = provider.readCalls;
    provider.controls = { ...CONTROLS, policyIsPublic: true };
    await expect(retrievePostgresRecoveryBundleWorm(retrievalOptions(
      provider, sealed, fixture, path.join(privateRoot(), "retrieved"),
    ))).rejects.toEqual(new PostgresRecoveryBundleWormError("destination_pin_mismatch"));
    expect(provider.readCalls).toBe(sealReadbackCalls); // retrieval rejects before object reads
  });

  it("destroys a stalled retrieval body when its bounded deadline expires", async () => {
    let destroyed = false;
    const body = new Readable({ read() {} });
    body.on("error", () => undefined);
    const originalDestroy = body.destroy.bind(body);
    body.destroy = (error?: Error) => {
      destroyed = true;
      return originalDestroy(error);
    };
    const expected = hash("body");
    const provider = {
      listExactVersions: async () => ({
        truncated: false, deleteMarkers: [], versions: [{
          key: "key", versionId: "v1", isLatest: true, bytes: 4,
          lastModified: LAST_MODIFIED,
        }],
      }),
      readExactVersion: async () => ({
        key: "key", versionId: "v1", bytes: 4,
        checksumSha256Base64: Buffer.from(expected, "hex").toString("base64"),
        contentType: "application/json", cacheControl: "private, max-age=2592000, immutable",
        metadata: { exact: "true" }, serverSideEncryption: "AES256",
        objectLockMode: "COMPLIANCE", retainUntil: RETAIN_UNTIL,
        lastModified: LAST_MODIFIED, body,
      }),
    } as unknown as PostgresLogicalWormProvider;
    await expect(postgresRecoveryBundleWormInternals.readRemoteBytes({
      provider, key: "key", expectedBucketOwner: ACCOUNT, expectedSha256: expected,
      maximumBytes: 4, operationTimeoutMs: 10, expectedContentType: "application/json",
      expectedMetadata: { exact: "true" },
    })).rejects.toEqual(new PostgresRecoveryBundleWormError("retrieval_failed"));
    expect(destroyed).toBe(true);
  });

  it("rejects a non-canonical or invalid COMPLIANCE retention timestamp", async () => {
    for (const retainUntil of ["not-a-timestamp", "2027-01-01T00:00:00Z"]) {
      const expected = hash("body");
      const provider = {
        listExactVersions: async () => ({
          truncated: false, deleteMarkers: [], versions: [{
            key: "key", versionId: "v1", isLatest: true, bytes: 4,
            lastModified: LAST_MODIFIED,
          }],
        }),
        readExactVersion: async () => ({
          key: "key", versionId: "v1", bytes: 4,
          checksumSha256Base64: Buffer.from(expected, "hex").toString("base64"),
          contentType: "application/json", cacheControl: "private, max-age=2592000, immutable",
          metadata: { exact: "true" }, serverSideEncryption: "AES256",
          objectLockMode: "COMPLIANCE", retainUntil,
          lastModified: LAST_MODIFIED, body: Readable.from([Buffer.from("body")]),
        }),
      } as unknown as PostgresLogicalWormProvider;
      await expect(postgresRecoveryBundleWormInternals.readRemoteBytes({
        provider, key: "key", expectedBucketOwner: ACCOUNT, expectedSha256: expected,
        maximumBytes: 4, operationTimeoutMs: 100, expectedContentType: "application/json",
        expectedMetadata: { exact: "true" },
      })).rejects.toEqual(new PostgresRecoveryBundleWormError("retrieval_failed"));
    }
  });

  it("rejects metadata substitution during independent retrieval", async () => {
    const provider = new MemoryProvider();
    const fixture = recoveryFixture();
    const sealed = await sealPostgresRecoveryBundleWorm(options(provider, fixture));
    provider.corruptMetadata = true;
    await expect(retrievePostgresRecoveryBundleWorm(retrievalOptions(
      provider, sealed, fixture, path.join(privateRoot(), "retrieved"),
    ))).rejects.toEqual(new PostgresRecoveryBundleWormError("receipt_failed"));
  });

  it("removes only its exact partial output after a later object retrieval fails", async () => {
    const provider = new MemoryProvider();
    const fixture = recoveryFixture();
    const sealed = await sealPostgresRecoveryBundleWorm(options(provider, fixture));
    const output = path.join(privateRoot(), "retrieved");
    provider.failReadCall = provider.readCalls + 3;
    await expect(retrievePostgresRecoveryBundleWorm(
      retrievalOptions(provider, sealed, fixture, output),
    )).rejects.toEqual(new PostgresRecoveryBundleWormError("retrieval_failed"));
    expect(fs.existsSync(output)).toBe(false);
  });

  it("rejects an output collision without altering it", async () => {
    const provider = new MemoryProvider();
    const fixture = recoveryFixture();
    const sealed = await sealPostgresRecoveryBundleWorm(options(provider, fixture));
    const output = path.join(privateRoot(), "retrieved");
    fs.mkdirSync(output, { mode: 0o700 });
    const sentinel = path.join(output, "sentinel");
    fs.writeFileSync(sentinel, "owned-by-caller", { mode: 0o600 });
    await expect(retrievePostgresRecoveryBundleWorm(
      retrievalOptions(provider, sealed, fixture, output),
    )).rejects.toEqual(new PostgresRecoveryBundleWormError("retrieval_output_unsafe"));
    expect(fs.readFileSync(sentinel, "utf8")).toBe("owned-by-caller");
  });

  it("retains ambiguous inodes and never deletes a replacement output root", async () => {
    const provider = new MemoryProvider();
    const fixture = recoveryFixture();
    const sealed = await sealPostgresRecoveryBundleWorm(options(provider, fixture));
    const parent = privateRoot();
    const output = path.join(parent, "retrieved");
    const moved = path.join(parent, "retrieved-held-original");
    const replaceAt = provider.readCalls + 4;
    provider.beforeRead = (call) => {
      if (call !== replaceAt) return;
      fs.renameSync(output, moved);
      fs.mkdirSync(output, { mode: 0o700 });
      fs.writeFileSync(path.join(output, "replacement-sentinel"), "retain", { mode: 0o600 });
    };
    await expect(retrievePostgresRecoveryBundleWorm(
      retrievalOptions(provider, sealed, fixture, output),
    )).rejects.toEqual(new PostgresRecoveryBundleWormError("retrieval_output_unsafe"));
    expect(fs.readFileSync(path.join(output, "replacement-sentinel"), "utf8")).toBe("retain");
    expect(fs.existsSync(path.join(moved, "recovery-set.json"))).toBe(true);
  });

  it("never returns a green retrieval after a held output descriptor fails to close", async () => {
    const provider = new MemoryProvider();
    const fixture = recoveryFixture();
    const sealed = await sealPostgresRecoveryBundleWorm(options(provider, fixture));
    const output = path.join(privateRoot(), "retrieved");
    const closeSync = fs.closeSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      if (!injected && fs.fstatSync(descriptor).isDirectory()) {
        injected = true;
        throw new Error("synthetic held-directory close failure");
      }
      closeSync(descriptor);
    });
    await expect(retrievePostgresRecoveryBundleWorm(
      retrievalOptions(provider, sealed, fixture, output),
    )).rejects.toEqual(new PostgresRecoveryBundleWormError("retrieval_output_unsafe"));
    expect(injected).toBe(true);
    expect(fs.existsSync(path.join(output, "recovery-set.json"))).toBe(true);
  });

  it("CLI gates real AWS before provider construction and closes a mocked provider", async () => {
    const cliWormResult = {
      schemaVersion: 1 as const, ok: true as const,
      kind: "pintpath-postgres-private-storage-worm-receipt" as const,
      candidateSha: CANDIDATE, completedAt: NOW.toISOString(),
      recoverySetSha256: "3".repeat(64), recoveryManifestSha256: "2".repeat(64),
      logicalBackupManifestSha256: "4".repeat(64), bundleManifestSha256: "1".repeat(64),
      immutableObjectSetSha256: "8".repeat(64), recoveryAccountIdSha256: hash(ACCOUNT),
      bucketNameSha256: hash(BUCKET), writerPrincipalArnSha256: hash(WRITER),
      readerPrincipalArnSha256: hash(READER), writerDenialSetSha256: "9".repeat(64),
      receiptSha256: "a".repeat(64), receiptObjectKeySha256: "b".repeat(64),
      receiptVersionIdSha256: "c".repeat(64), receiptDenialSetSha256: "d".repeat(64),
      minimumRetainUntil: RETAIN_UNTIL,
    };
    const cliWormResultSource = canonicalPostgresBackupJson(cliWormResult);
    const cliWormResultFile = path.join(privateRoot(), "private-storage-worm-receipt.json");
    writePrivate(cliWormResultFile, cliWormResultSource, path.dirname(cliWormResultFile));
    const cliWormResultSha256 = hash(cliWormResultSource);
    const args = [
      "retrieve", "--bucket-name", BUCKET, "--expected-bucket-name-sha256", hash(BUCKET),
      "--expected-reader-principal-arn-sha256", hash(READER), "--reader-profile", "reader",
      "--expected-bundle-manifest-sha256", "1".repeat(64),
      "--expected-candidate-sha", CANDIDATE,
      "--expected-recovery-account-id-sha256", hash(ACCOUNT),
      "--expected-recovery-manifest-sha256", "2".repeat(64),
      "--expected-recovery-set-sha256", "3".repeat(64),
      "--output-directory", path.join(privateRoot(), "output"),
      "--worm-result-file", cliWormResultFile,
      "--worm-result-sha256", cliWormResultSha256,
    ];
    const loadAwsProvider = vi.fn();
    let output = "";
    expect(await runPostgresRecoveryBundleWormCli(args, {
      env: { [POSTGRES_RECOVERY_BUNDLE_WORM_CONFIRMATION_ENV]: "confirmed" },
      loadAwsProvider,
      assertMutationAllowed: () => undefined,
      writeOutput: (value) => { output += value; },
    })).toBe(1);
    expect(JSON.parse(output).failureCode).toBe("real_aws_gate_required");
    expect(loadAwsProvider).not.toHaveBeenCalled();

    const close = vi.fn();
    output = "";
    expect(await runPostgresRecoveryBundleWormCli(args, {
      env: {
        [POSTGRES_RECOVERY_BUNDLE_WORM_CONFIRMATION_ENV]: "confirmed",
        [POSTGRES_RECOVERY_BUNDLE_WORM_AWS_GATE_ENV]: "confirmed",
        [POSTGRES_RECOVERY_BUNDLE_WORM_RECOVERY_ACCOUNT_ENV]: ACCOUNT,
        [POSTGRES_RECOVERY_BUNDLE_WORM_FORBIDDEN_ACCOUNTS_ENV]: FORBIDDEN_ACCOUNT,
      },
      loadAwsProvider: () => ({ provider: new MemoryProvider(), close }),
      assertMutationAllowed: () => undefined,
      retrieve: async () => ({ schemaVersion: 1, ok: true,
        kind: "pintpath-postgres-private-storage-worm-retrieval",
        candidateSha: CANDIDATE, recoveredAt: NOW.toISOString(),
        recoverySetSha256: "3".repeat(64), recoveryManifestSha256: "2".repeat(64),
        logicalBackupManifestSha256: "4".repeat(64),
        bundleManifestSha256: "1".repeat(64), entrySetSha256: "5".repeat(64),
        wormResultSha256: cliWormResultSha256, wormReceiptSha256: "7".repeat(64),
        immutableObjectSetSha256: "8".repeat(64),
        recoveredEntryCount: 4, recoveredBytes: "4",
        recoveryAccountIdSha256: hash(ACCOUNT), bucketNameSha256: hash(BUCKET),
        readerPrincipalArnSha256: hash(READER),
        minimumRetainUntil: RETAIN_UNTIL,
      }),
      writeOutput: (value) => { output += value; },
    })).toBe(0);
    expect(JSON.parse(output).ok).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("constructs retrieval with only reader credentials and reader AWS clients", async () => {
    const profiles: string[] = [];
    const s3Clients: Array<{ readonly destroy: ReturnType<typeof vi.fn> }> = [];
    const stsClients: Array<{ readonly destroy: ReturnType<typeof vi.fn> }> = [];
    class Command {
      constructor(readonly input: Readonly<Record<string, unknown>>) {}
    }
    class S3Client {
      readonly destroy = vi.fn();
      constructor(readonly config: Readonly<Record<string, unknown>>) {
        s3Clients.push(this);
      }
      async send() { return {}; }
    }
    class STSClient {
      readonly destroy = vi.fn();
      constructor(readonly config: Readonly<Record<string, unknown>>) {
        stsClients.push(this);
      }
      async send() { return {}; }
    }
    const loaded = createRecoveryBundleAwsProviderFromRuntime({
      bucketName: BUCKET,
      writerProfile: null,
      readerProfile: "reader-only",
    }, {
      s3: {
        S3Client,
        PutObjectCommand: Command,
        GetObjectCommand: Command,
        GetObjectRetentionCommand: Command,
        DeleteObjectCommand: Command,
        ListObjectVersionsCommand: Command,
        GetBucketLocationCommand: Command,
        GetBucketVersioningCommand: Command,
        GetObjectLockConfigurationCommand: Command,
        GetPublicAccessBlockCommand: Command,
        GetBucketOwnershipControlsCommand: Command,
        GetBucketEncryptionCommand: Command,
        GetBucketPolicyStatusCommand: Command,
        GetBucketRequestPaymentCommand: Command,
      },
      sts: { STSClient, GetCallerIdentityCommand: Command },
      credentials: {
        fromIni: ({ profile }: { readonly profile: string }) => {
          profiles.push(profile);
          return { profile };
        },
      },
    });

    expect(profiles).toEqual(["reader-only"]);
    expect(s3Clients).toHaveLength(1);
    expect(stsClients).toHaveLength(1);
    await expect(loaded.provider.inspectWriterIdentity(
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "writer_not_least_privilege" });
    loaded.close();
    expect(s3Clients[0]?.destroy).toHaveBeenCalledOnce();
    expect(stsClients[0]?.destroy).toHaveBeenCalledOnce();
  });

  it("bundle manifest parser rejects candidate and entry-set tampering", () => {
    const manifest = {
      kind: POSTGRES_RECOVERY_BUNDLE_WORM_KIND, version: 1, candidateSha: CANDIDATE,
      recoverySetSha256: "1".repeat(64), recoveryManifestSha256: "2".repeat(64),
      logicalBackupManifestSha256: "3".repeat(64), createdAt: NOW.toISOString(),
      entries: [], entrySetSha256: "4".repeat(64),
    };
    expect(() => postgresRecoveryBundleWormInternals.parseBundleManifest(
      Buffer.from(canonicalPostgresBackupJson(manifest)),
    )).toThrowError(PostgresRecoveryBundleWormError);
  });

  it("bundle manifest parser enforces slot-specific and aggregate producer byte caps", () => {
    const baseEntries = [
      { slot: "manifest", relativePath: "recovery-set.json", bytes: "1",
        sha256: "1".repeat(64), contentType: "application/json" },
      { slot: "ledger-checkpoint", relativePath: "deletion-authority/checkpoint.json",
        bytes: "1", sha256: "2".repeat(64), contentType: "application/json" },
      { slot: "ledger-current", relativePath: "deletion-authority/current.json",
        bytes: "1", sha256: "3".repeat(64), contentType: "application/json" },
      { slot: "ledger-genesis", relativePath: "deletion-authority/genesis.json",
        bytes: "1", sha256: "4".repeat(64), contentType: "application/json" },
    ];
    const parse = (entries: readonly Record<string, unknown>[]) => {
      const manifest = {
        kind: POSTGRES_RECOVERY_BUNDLE_WORM_KIND,
        version: 1,
        candidateSha: CANDIDATE,
        recoverySetSha256: "1".repeat(64),
        recoveryManifestSha256: "2".repeat(64),
        logicalBackupManifestSha256: "3".repeat(64),
        createdAt: NOW.toISOString(),
        entries,
        entrySetSha256: hash(canonicalPostgresBackupJson(entries)),
      };
      return postgresRecoveryBundleWormInternals.parseBundleManifest(
        Buffer.from(canonicalPostgresBackupJson(manifest)),
      );
    };
    for (const [index, bytes] of [
      [0, 16n * 1024n * 1024n + 1n],
      [1, 64n * 1024n * 1024n + 1n],
    ] as const) {
      const entries = baseEntries.map((entry, entryIndex) => entryIndex === index
        ? { ...entry, bytes: bytes.toString() }
        : entry);
      expect(() => parse(entries)).toThrow(new PostgresRecoveryBundleWormError(
        "retrieval_failed",
      ));
    }
    expect(() => parse([
      ...baseEntries,
      {
        slot: "storage-00000000",
        relativePath: "objects/00000000.bin",
        bytes: (8n * 1024n * 1024n + 1n).toString(),
        sha256: "5".repeat(64),
        contentType: "application/octet-stream",
      },
    ])).toThrow(new PostgresRecoveryBundleWormError("retrieval_failed"));
    const aggregateEntries = [
      ...baseEntries,
      ...Array.from({ length: 6_401 }, (_, index) => ({
        slot: `storage-${String(index).padStart(8, "0")}`,
        relativePath: `objects/${String(index).padStart(8, "0")}.bin`,
        bytes: String(8 * 1024 * 1024),
        sha256: "5".repeat(64),
        contentType: "application/octet-stream",
      })),
    ];
    expect(() => parse(aggregateEntries)).toThrow(new PostgresRecoveryBundleWormError(
      "retrieval_failed",
    ));
  });
});
