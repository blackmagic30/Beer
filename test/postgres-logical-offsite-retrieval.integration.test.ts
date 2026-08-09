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
  attestPostgresLogicalBackup,
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
  it("retrieves an attested v2 backup into the exact restore-compatible directory", async () => {
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
