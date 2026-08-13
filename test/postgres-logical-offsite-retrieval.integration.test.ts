import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  SystemLeaseValue,
  SystemStateRecord,
} from "../src/db/system-state.repository.js";
import {
  POSTGRES_LOGICAL_BACKUP_ARCHIVE,
  POSTGRES_LOGICAL_BACKUP_MANIFEST,
  POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  canonicalPostgresBackupJson,
} from "../src/lib/postgres-logical-backup.js";
import {
  assertPostgresLogicalBackupStateReceiptBinding,
  parsePostgresLogicalBackupManifest,
} from "../src/lib/postgres-logical-restore.js";
import {
  POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY,
  POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT,
  POSTGRES_LOGICAL_OFFSITE_PREFIX,
  attestPostgresLogicalBackup,
  probePostgresLogicalOffsiteReadiness,
  type PostgresLogicalOffsiteBucketInfo,
  type PostgresLogicalOffsiteDownload,
  type PostgresLogicalOffsiteObjectInfo,
  type PostgresLogicalOffsiteStateAuthority,
  type PostgresLogicalOffsiteStorage,
  type PostgresLogicalOffsiteUpload,
} from "../src/lib/postgres-logical-offsite.js";
import {
  retrievePostgresLogicalOffsiteBackup,
  type PostgresLogicalOffsiteRetrievalStorage,
} from "../src/lib/postgres-logical-offsite-retrieval.js";
import { parsePostgresLogicalSourceStateReceipt } from "../src/lib/postgres-logical-state.js";
import {
  LOGICAL_OFFSITE_ARCHIVE_BYTES,
  LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256,
  sha256Fixture,
  writeLogicalOffsiteFixture,
} from "./postgres-logical-offsite.fixtures.js";

const SOURCE_URL = "https://production.example.test";
const DESTINATION_URL = "https://operational-copy.example.test";
const BUCKET = "pintpath-backups";
const ATTESTED_AT = "2026-08-09T02:00:00.000Z";
const RETRIEVED_AT = "2026-08-09T03:00:00.000Z";
const RUNTIME_CONNECTION_URL_SHA256 = sha256Fixture(
  "candidate-runtime-connection-url",
);

interface FakeObject {
  bytes: Buffer;
  info: PostgresLogicalOffsiteObjectInfo;
}

class FakeStorage
implements PostgresLogicalOffsiteStorage, PostgresLogicalOffsiteRetrievalStorage {
  readonly destinationOrigin = DESTINATION_URL;
  readonly objects = new Map<string, FakeObject>();
  readonly streamedPaths: string[] = [];
  readonly downloadedPaths: string[] = [];
  mutateAfterStreamPath: string | null = null;
  onStreamComplete: ((objectPath: string) => void) | null = null;
  private generation = 0;

  async inspectBucket(): Promise<PostgresLogicalOffsiteBucketInfo> {
    return {
      private: true,
      fileSizeLimit: null,
      allowedMimeTypes: ["application/json", "application/octet-stream"],
    };
  }

  async objectInfo(
    _bucketName: string,
    objectPath: string,
  ): Promise<PostgresLogicalOffsiteObjectInfo | null> {
    const object = this.objects.get(objectPath);
    return object
      ? { ...object.info, metadata: { ...object.info.metadata } }
      : null;
  }

  async uploadImmutable(input: PostgresLogicalOffsiteUpload): Promise<void> {
    if (this.objects.has(input.objectPath)) throw new Error("duplicate");
    this.write(input);
  }

  async replaceMutable(input: PostgresLogicalOffsiteUpload): Promise<void> {
    this.write(input);
  }

  async downloadVerified(input: {
    readonly objectPath: string;
    readonly maximumBytes: number;
    readonly retainBytes: boolean;
  }): Promise<PostgresLogicalOffsiteDownload> {
    const object = this.objects.get(input.objectPath);
    if (!object || object.bytes.length > input.maximumBytes) throw new Error("missing");
    this.downloadedPaths.push(input.objectPath);
    return {
      bytes: object.bytes.length,
      sha256: sha256Fixture(object.bytes),
      ...(input.retainBytes ? { retainedBytes: Buffer.from(object.bytes) } : {}),
    };
  }

  async streamDownload(input: {
    readonly objectPath: string;
    readonly maximumBytes: number;
    readonly onChunk: (chunk: Buffer) => Promise<void>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<PostgresLogicalOffsiteDownload> {
    const object = this.objects.get(input.objectPath);
    if (!object || object.bytes.length > input.maximumBytes) throw new Error("missing");
    this.streamedPaths.push(input.objectPath);
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    for (let offset = 0; offset < object.bytes.length; offset += 7) {
      if (input.signal?.aborted) throw new Error("aborted");
      const chunk = object.bytes.subarray(offset, Math.min(offset + 7, object.bytes.length));
      hash.update(chunk);
      bytes += chunk.length;
      await input.onChunk(Buffer.from(chunk));
    }
    if (input.objectPath === this.mutateAfterStreamPath) {
      object.info = {
        ...object.info,
        storageVersion: `${object.info.storageVersion}-changed`,
      };
    }
    this.onStreamComplete?.(input.objectPath);
    return { bytes, sha256: hash.digest("hex") };
  }

  async removeExact(_bucketName: string, objectPaths: readonly string[]): Promise<void> {
    for (const objectPath of objectPaths) this.objects.delete(objectPath);
  }

  private write(input: PostgresLogicalOffsiteUpload): void {
    const bytes = input.bytes
      ? Buffer.from(input.bytes)
      : fs.readFileSync(input.filePath!);
    const previous = this.objects.get(input.objectPath);
    this.generation += 1;
    this.objects.set(input.objectPath, {
      bytes,
      info: {
        bytes: bytes.length,
        contentType: input.contentType,
        cacheControl: input.cacheControl,
        metadata: { ...input.metadata },
        storageObjectId: previous?.info.storageObjectId ?? `object-${this.generation}`,
        storageVersion: `version-${this.generation}`,
      },
    });
  }
}

class FakeState implements PostgresLogicalOffsiteStateAuthority {
  readonly records = new Map<string, SystemStateRecord<Record<string, unknown>>>();
  private revision = 0;

  async get(key: string): Promise<SystemStateRecord<Record<string, unknown>> | null> {
    return this.records.get(key) ?? null;
  }

  async compareAndSet(
    key: string,
    expectedRevision: string | null,
    value: Record<string, unknown>,
    now: string,
  ): Promise<SystemStateRecord<Record<string, unknown>> | null> {
    const existing = this.records.get(key);
    if ((existing?.revision ?? null) !== expectedRevision) return null;
    const record = this.record(value, now);
    this.records.set(key, record);
    return record;
  }

  async acquireLease(input: {
    readonly key: string;
    readonly owner: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseUntil: string;
  }): Promise<SystemStateRecord<SystemLeaseValue> | null> {
    const value: SystemLeaseValue = {
      owner: input.owner,
      leaseToken: input.leaseToken,
      leaseUntil: input.leaseUntil,
      acquiredAt: input.now,
    };
    const record = this.record(value, input.now);
    this.records.set(input.key, record as SystemStateRecord<Record<string, unknown>>);
    return record;
  }

  async releaseLease(input: {
    readonly key: string;
    readonly owner: string;
    readonly leaseToken: string;
    readonly now: string;
  }): Promise<SystemStateRecord<SystemLeaseValue> | null> {
    const value: SystemLeaseValue = {
      owner: input.owner,
      leaseToken: input.leaseToken,
      leaseUntil: input.now,
      releasedAt: input.now,
    };
    const record = this.record(value, input.now);
    this.records.set(input.key, record as SystemStateRecord<Record<string, unknown>>);
    return record;
  }

  replaceSuccessRecordWithSameValue(): void {
    const current = this.records.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)!;
    this.records.set(
      POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY,
      this.record({ ...current.value }, current.updatedAt),
    );
  }

  private record<T extends object>(value: T, now: string): SystemStateRecord<T> {
    this.revision += 1;
    return { value, updatedAt: now, revision: `revision-${this.revision}` };
  }
}

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(
    os.tmpdir(),
    "pintpath-logical-retrieval-test-",
  )));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function canonicalSha256(value: unknown): string {
  return sha256Fixture(canonicalPostgresBackupJson(value));
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:.]/g, "");
}

function historicalStorageMetadata(input: {
  readonly objectKind: string;
  readonly objectSha256: string;
  readonly manifestSha256: string;
  readonly backupIdSha256: string;
}): Readonly<Record<string, string>> {
  return {
    contract: "pintpath-postgres-logical-offsite-v2",
    objectKind: input.objectKind,
    sha256: input.objectSha256,
    manifestSha256: input.manifestSha256,
    backupIdSha256: input.backupIdSha256,
  };
}

async function historicalV2AttestedFixture(): Promise<{
  readonly root: string;
  readonly storage: FakeStorage;
  readonly state: FakeState;
  readonly stateSha256: string;
  readonly backupId: string;
}> {
  const root = temporaryRoot();
  const fixture = writeLogicalOffsiteFixture(
    root,
    "2026-08-09T01:00:00.000Z",
    2,
  );
  if (fixture.manifest.schemaVersion !== 2) {
    throw new Error("historical fixture must remain schema v2");
  }
  const storage = new FakeStorage();
  const state = new FakeState();
  const backupId = `${compactTimestamp(fixture.manifest.createdAt)}-${fixture.manifestSha256}`;
  const backupIdSha256 = sha256Fixture(backupId);
  const localObjects = [
    {
      kind: "archive",
      objectKind: "postgres-logical-archive",
      filename: POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      bytes: LOGICAL_OFFSITE_ARCHIVE_BYTES,
      sha256: fixture.archiveSha256,
      contentType: "application/octet-stream",
    },
    {
      kind: "manifest",
      objectKind: "postgres-logical-manifest",
      filename: POSTGRES_LOGICAL_BACKUP_MANIFEST,
      bytes: fs.readFileSync(path.join(
        fixture.backupDirectory,
        POSTGRES_LOGICAL_BACKUP_MANIFEST,
      )),
      sha256: fixture.manifestSha256,
      contentType: "application/json",
    },
    {
      kind: "state-receipt",
      objectKind: "postgres-logical-state-receipt",
      filename: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      bytes: fs.readFileSync(path.join(
        fixture.backupDirectory,
        POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      )),
      sha256: fixture.receiptSha256,
      contentType: "application/json",
    },
  ] as const;
  const descriptors = localObjects.map((local, index) => {
    const objectPath = `${POSTGRES_LOGICAL_OFFSITE_PREFIX}/backups/${backupId}/${local.filename}`;
    const metadata = historicalStorageMetadata({
      objectKind: local.objectKind,
      objectSha256: local.sha256,
      manifestSha256: fixture.manifestSha256,
      backupIdSha256,
    });
    const storageObjectId = `historical-v2-object-${index + 1}`;
    const storageVersion = `historical-v2-version-${index + 1}`;
    storage.objects.set(objectPath, {
      bytes: Buffer.from(local.bytes),
      info: {
        bytes: local.bytes.length,
        contentType: local.contentType,
        cacheControl: "31536000",
        metadata,
        storageObjectId,
        storageVersion,
      },
    });
    return {
      kind: local.kind,
      objectPathSha256: sha256Fixture(objectPath),
      bytes: String(local.bytes.length),
      sha256: local.sha256,
      contentType: local.contentType,
      metadataSha256: canonicalSha256(metadata),
      storageObjectIdSha256: sha256Fixture(storageObjectId),
      storageVersionSha256: sha256Fixture(storageVersion),
    };
  });
  const remoteObjectSetSha256 = canonicalSha256(descriptors);
  const commonEvidence = {
    backupId,
    backupIdSha256,
    backupCreatedAt: fixture.manifest.createdAt,
    manifestSha256: fixture.manifestSha256,
    archiveSha256: fixture.archiveSha256,
    stateReceiptSha256: fixture.receiptSha256,
    manifestBindingSha256: fixture.manifest.state.manifestBindingSha256,
    sourceDatabaseIdentitySha256:
      fixture.manifest.state.sourceDatabaseIdentitySha256,
    runtimeConnectionUrlSha256: RUNTIME_CONNECTION_URL_SHA256,
    overallStateSha256: fixture.manifest.state.overallStateSha256,
    destinationOriginSha256: sha256Fixture(DESTINATION_URL),
    bucketNameSha256: sha256Fixture(BUCKET),
    operatorIdSha256: sha256Fixture("retrieval-integration-operator"),
  } as const;
  const attestation = {
    kind: "pintpath-postgres-logical-offsite-attestation",
    version: 2,
    ...commonEvidence,
    verifiedAt: ATTESTED_AT,
    objects: descriptors,
    remoteObjectSetSha256,
  } as const;
  const attestationBytes = Buffer.from(canonicalPostgresBackupJson(attestation), "utf8");
  const attestationSha256 = sha256Fixture(attestationBytes);
  const attestationId = `${compactTimestamp(ATTESTED_AT)}-${attestationSha256}`;
  const attestationPath = `${POSTGRES_LOGICAL_OFFSITE_PREFIX}/attestations/${backupId}/${attestationId}.json`;
  const attestationStorageObjectId = "historical-v2-attestation-object";
  const attestationStorageVersion = "historical-v2-attestation-version";
  storage.objects.set(attestationPath, {
    bytes: attestationBytes,
    info: {
      bytes: attestationBytes.length,
      contentType: "application/json",
      cacheControl: "31536000",
      metadata: historicalStorageMetadata({
        objectKind: "postgres-logical-offsite-attestation",
        objectSha256: attestationSha256,
        manifestSha256: fixture.manifestSha256,
        backupIdSha256,
      }),
      storageObjectId: attestationStorageObjectId,
      storageVersion: attestationStorageVersion,
    },
  });
  const pointer = {
    kind: "pintpath-postgres-logical-offsite-latest",
    version: 2,
    ...commonEvidence,
    attestationId,
    completedAt: ATTESTED_AT,
    remoteObjectSetSha256,
    attestationSha256,
    attestationStorageObjectIdSha256: sha256Fixture(attestationStorageObjectId),
    attestationStorageVersionSha256: sha256Fixture(attestationStorageVersion),
  } as const;
  const pointerBytes = Buffer.from(canonicalPostgresBackupJson(pointer), "utf8");
  const latestPointerSha256 = sha256Fixture(pointerBytes);
  const latestPointerStorageObjectId = "historical-v2-pointer-object";
  const latestPointerStorageVersion = "historical-v2-pointer-version";
  storage.objects.set(POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT, {
    bytes: pointerBytes,
    info: {
      bytes: pointerBytes.length,
      contentType: "application/json",
      cacheControl: "0",
      metadata: historicalStorageMetadata({
        objectKind: "postgres-logical-offsite-latest",
        objectSha256: latestPointerSha256,
        manifestSha256: fixture.manifestSha256,
        backupIdSha256,
      }),
      storageObjectId: latestPointerStorageObjectId,
      storageVersion: latestPointerStorageVersion,
    },
  });
  const successState = {
    kind: "pintpath-postgres-logical-backup-success",
    version: 2,
    backupCreatedAt: fixture.manifest.createdAt,
    completedAt: ATTESTED_AT,
    archiveSha256: fixture.archiveSha256,
    manifestSha256: fixture.manifestSha256,
    stateReceiptSha256: fixture.receiptSha256,
    manifestBindingSha256: fixture.manifest.state.manifestBindingSha256,
    sourceDatabaseIdentitySha256:
      fixture.manifest.state.sourceDatabaseIdentitySha256,
    runtimeConnectionUrlSha256: RUNTIME_CONNECTION_URL_SHA256,
    overallStateSha256: fixture.manifest.state.overallStateSha256,
    remoteObjectSetSha256,
    attestationSha256,
    attestationStorageObjectIdSha256: sha256Fixture(attestationStorageObjectId),
    attestationStorageVersionSha256: sha256Fixture(attestationStorageVersion),
    latestPointerSha256,
    latestPointerStorageObjectIdSha256: sha256Fixture(latestPointerStorageObjectId),
    latestPointerStorageVersionSha256: sha256Fixture(latestPointerStorageVersion),
    backupIdSha256,
    destinationOriginSha256: sha256Fixture(DESTINATION_URL),
    bucketNameSha256: sha256Fixture(BUCKET),
    operatorIdSha256: sha256Fixture("retrieval-integration-operator"),
  } as const;
  state.records.set(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY, {
    value: successState,
    updatedAt: ATTESTED_AT,
    revision: "historical-v2-state",
  });
  return {
    root,
    storage,
    state,
    stateSha256: canonicalSha256(successState),
    backupId,
  };
}

async function attestedFixture(): Promise<{
  readonly root: string;
  readonly storage: FakeStorage;
  readonly state: FakeState;
  readonly stateSha256: string;
  readonly backupId: string;
}> {
  const root = temporaryRoot();
  const fixture = writeLogicalOffsiteFixture(root);
  const storage = new FakeStorage();
  const state = new FakeState();
  await attestPostgresLogicalBackup({
    backupDirectory: fixture.backupDirectory,
    expectedManifestSha256: fixture.manifestSha256,
    runtimeDatabaseIdentitySha256: LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256,
    runtimeConnectionUrlSha256: RUNTIME_CONNECTION_URL_SHA256,
    sourceSupabaseUrl: SOURCE_URL,
    destinationSupabaseUrl: DESTINATION_URL,
    expectedDestinationOriginSha256: sha256Fixture(DESTINATION_URL),
    bucketName: BUCKET,
    expectedBucketNameSha256: sha256Fixture(BUCKET),
    operatorId: "retrieval-integration-operator",
    storage,
    state,
    now: () => new Date(ATTESTED_AT),
    randomUuid: () => "123e4567-e89b-42d3-a456-426614174000",
  });
  const success = state.records.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)!;
  const backupId = [...storage.objects.keys()]
    .find((entry) => entry.includes("/backups/"))!
    .split("/")[4]!;
  return {
    root,
    storage,
    state,
    stateSha256: sha256Fixture(canonicalPostgresBackupJson(success.value)),
    backupId,
  };
}

function retrievalOptions(fixture: Awaited<ReturnType<typeof attestedFixture>>) {
  return {
    outputDirectory: path.join(fixture.root, "retrieved-logical-backup"),
    expectedSuccessStateSha256: fixture.stateSha256,
    runtimeDatabaseIdentitySha256: LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256,
    sourceSupabaseUrl: SOURCE_URL,
    destinationSupabaseUrl: DESTINATION_URL,
    expectedDestinationOriginSha256: sha256Fixture(DESTINATION_URL),
    bucketName: BUCKET,
    expectedBucketNameSha256: sha256Fixture(BUCKET),
    state: fixture.state,
    storage: fixture.storage,
    now: () => new Date(RETRIEVED_AT),
  } as const;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Postgres logical operational-copy retrieval integration", () => {
  it("retrieves an attested manifest-v3 backup into the exact restore-compatible directory", async () => {
    const fixture = await attestedFixture();
    const options = retrievalOptions(fixture);

    const result = await retrievePostgresLogicalOffsiteBackup(options);

    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "pintpath-postgres-logical-offsite-retrieval",
      ok: true,
      retrievedAt: RETRIEVED_AT,
      successStateSha256: fixture.stateSha256,
      sourceDatabaseIdentitySha256: LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256,
      archiveSha256: sha256Fixture(LOGICAL_OFFSITE_ARCHIVE_BYTES),
      archiveBytes: LOGICAL_OFFSITE_ARCHIVE_BYTES.length,
    });
    expect(
      fixture.state.records.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)!
        .value.runtimeConnectionUrlSha256,
    ).toBe(RUNTIME_CONNECTION_URL_SHA256);
    expect(fs.readdirSync(options.outputDirectory).sort()).toEqual([
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ].sort());
    expect(fs.statSync(options.outputDirectory).mode & 0o7777).toBe(0o700);
    for (const filename of fs.readdirSync(options.outputDirectory)) {
      expect(fs.statSync(path.join(options.outputDirectory, filename)).mode & 0o7777)
        .toBe(0o600);
    }
    expect(fs.readFileSync(path.join(
      options.outputDirectory,
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    ))).toEqual(LOGICAL_OFFSITE_ARCHIVE_BYTES);
    const manifestBytes = fs.readFileSync(path.join(
      options.outputDirectory,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
    ));
    const receiptBytes = fs.readFileSync(path.join(
      options.outputDirectory,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ));
    const manifest = parsePostgresLogicalBackupManifest(manifestBytes);
    const receipt = parsePostgresLogicalSourceStateReceipt(receiptBytes);
    expect(manifest.schemaVersion).toBe(3);
    expect(() => assertPostgresLogicalBackupStateReceiptBinding(receipt, manifest))
      .not.toThrow();
    expect(fixture.storage.streamedPaths).toHaveLength(3);

    const serialized = canonicalPostgresBackupJson(result);
    for (const sensitive of [
      SOURCE_URL,
      DESTINATION_URL,
      BUCKET,
      options.outputDirectory,
      fixture.backupId,
      "retrieval-integration-operator",
    ]) expect(serialized).not.toContain(sensitive);
  });

  it("retrieves a frozen historical manifest-v2 authority without enabling new v2 writes", async () => {
    const fixture = await historicalV2AttestedFixture();
    const options = retrievalOptions(fixture);
    await expect(probePostgresLogicalOffsiteReadiness({
      stateValue: fixture.state.records.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)!.value,
      runtimeDatabaseIdentitySha256: LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256,
      sourceSupabaseUrl: SOURCE_URL,
      destinationSupabaseUrl: DESTINATION_URL,
      bucketName: BUCKET,
      maxFreshnessHours: 24,
      storage: fixture.storage,
      now: new Date(ATTESTED_AT),
    })).resolves.toMatchObject({
      status: "failed",
      liveProbe: true,
      error: "remote_attestation_mismatch",
    });
    const result = await retrievePostgresLogicalOffsiteBackup(options);
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "pintpath-postgres-logical-offsite-retrieval",
      ok: true,
      successStateSha256: fixture.stateSha256,
      archiveSha256: sha256Fixture(LOGICAL_OFFSITE_ARCHIVE_BYTES),
    });
    const manifest = parsePostgresLogicalBackupManifest(fs.readFileSync(path.join(
      options.outputDirectory,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
    )));
    const receipt = parsePostgresLogicalSourceStateReceipt(fs.readFileSync(path.join(
      options.outputDirectory,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    )));
    expect(manifest.schemaVersion).toBe(2);
    expect(() => assertPostgresLogicalBackupStateReceiptBinding(receipt, manifest))
      .not.toThrow();
    expect(fixture.storage.streamedPaths).toHaveLength(3);
  });

  it("rejects a changed Storage generation after streaming and removes partial output", async () => {
    const fixture = await attestedFixture();
    const options = retrievalOptions(fixture);
    fixture.storage.mutateAfterStreamPath = [...fixture.storage.objects.keys()]
      .find((entry) => entry.endsWith(`/${POSTGRES_LOGICAL_BACKUP_ARCHIVE}`))!;

    await expect(retrievePostgresLogicalOffsiteBackup(options)).rejects.toMatchObject({
      code: "object_verification_failed",
    });
    expect(fs.existsSync(options.outputDirectory)).toBe(false);
  });

  it("fences the live success-state revision across the complete retrieval", async () => {
    const fixture = await attestedFixture();
    const options = retrievalOptions(fixture);
    const archivePath = [...fixture.storage.objects.keys()]
      .find((entry) => entry.endsWith(`/${POSTGRES_LOGICAL_BACKUP_ARCHIVE}`))!;
    fixture.storage.onStreamComplete = (objectPath) => {
      if (objectPath === archivePath) fixture.state.replaceSuccessRecordWithSameValue();
    };

    await expect(retrievePostgresLogicalOffsiteBackup(options)).rejects.toMatchObject({
      code: "success_state_mismatch",
    });
    expect(fs.existsSync(options.outputDirectory)).toBe(false);
  });

  it("requires the exact operator-pinned success-state digest", async () => {
    const fixture = await attestedFixture();
    const options = retrievalOptions(fixture);

    await expect(retrievePostgresLogicalOffsiteBackup({
      ...options,
      expectedSuccessStateSha256: "0".repeat(64),
    })).rejects.toMatchObject({ code: "success_state_mismatch" });
    expect(fixture.storage.streamedPaths).toEqual([]);
    expect(fs.existsSync(options.outputDirectory)).toBe(false);
  });

  it("rejects a runtime URL digest that is not bound to the remote pointer", async () => {
    const fixture = await attestedFixture();
    const options = retrievalOptions(fixture);
    const current = fixture.state.records.get(
      POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY,
    )!;
    const changedValue = {
      ...current.value,
      runtimeConnectionUrlSha256: "0".repeat(64),
    };
    fixture.state.records.set(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY, {
      ...current,
      value: changedValue,
    });

    await expect(retrievePostgresLogicalOffsiteBackup({
      ...options,
      expectedSuccessStateSha256: sha256Fixture(
        canonicalPostgresBackupJson(changedValue),
      ),
    })).rejects.toMatchObject({ code: "object_verification_failed" });
    expect(fixture.storage.streamedPaths).toEqual([]);
    expect(fs.existsSync(options.outputDirectory)).toBe(false);
  });

  it.each(["pointer", "attestation"] as const)(
    "requires the attested %s Storage object ID and generation",
    async (kind) => {
      const fixture = await attestedFixture();
      const options = retrievalOptions(fixture);
      const objectPath = kind === "pointer"
        ? POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT
        : [...fixture.storage.objects.keys()].find((entry) => (
          entry.includes("/attestations/") && entry.endsWith(".json")
        ))!;
      const object = fixture.storage.objects.get(objectPath)!;
      object.info = {
        ...object.info,
        ...(kind === "pointer"
          ? { storageVersion: `${object.info.storageVersion}-drift` }
          : { storageObjectId: `${object.info.storageObjectId}-drift` }),
      };

      await expect(retrievePostgresLogicalOffsiteBackup(options)).rejects.toMatchObject({
        code: "object_verification_failed",
      });
      expect(fixture.storage.streamedPaths).toEqual([]);
      expect(fs.existsSync(options.outputDirectory)).toBe(false);
    },
  );

  it("fails closed on existing, symbolic-link, and non-private output authorities", async () => {
    const existing = await attestedFixture();
    const existingOptions = retrievalOptions(existing);
    fs.mkdirSync(existingOptions.outputDirectory, { mode: 0o700 });
    await expect(retrievePostgresLogicalOffsiteBackup(existingOptions)).rejects.toMatchObject({
      code: "unsafe_output_path",
    });

    const symbolic = await attestedFixture();
    const symbolicOptions = retrievalOptions(symbolic);
    const target = path.join(symbolic.root, "symlink-target");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, symbolicOptions.outputDirectory);
    await expect(retrievePostgresLogicalOffsiteBackup(symbolicOptions)).rejects.toMatchObject({
      code: "unsafe_output_path",
    });
    expect(fs.lstatSync(symbolicOptions.outputDirectory).isSymbolicLink()).toBe(true);

    const permissive = await attestedFixture();
    fs.chmodSync(permissive.root, 0o755);
    const permissiveOptions = retrievalOptions(permissive);
    await expect(retrievePostgresLogicalOffsiteBackup(permissiveOptions)).rejects.toMatchObject({
      code: "unsafe_output_path",
    });
    expect(fs.existsSync(permissiveOptions.outputDirectory)).toBe(false);
  });
});
