import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SqlDatabase } from "../src/db/sql-database.js";
import type {
  SystemLeaseValue,
  SystemStateRecord,
} from "../src/db/system-state.repository.js";
import {
  POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY,
  POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT,
  POSTGRES_LOGICAL_OFFSITE_LEASE_KEY,
  inspectPostgresLogicalRuntimeDatabaseIdentity,
  attestPostgresLogicalBackup,
  createSupabasePostgresLogicalOffsiteStorage,
  parsePostgresLogicalBackupSuccessState,
  postgresLogicalOffsiteInternals,
  probePostgresLogicalOffsiteReadiness,
  PostgresLogicalOffsiteError,
  type PostgresLogicalOffsiteBucketInfo,
  type PostgresLogicalOffsiteDownload,
  type PostgresLogicalOffsiteObjectInfo,
  type PostgresLogicalOffsiteStateAuthority,
  type PostgresLogicalOffsiteStorage,
  type PostgresLogicalOffsiteUpload,
} from "../src/lib/postgres-logical-offsite.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  sha256Fixture,
  LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY,
  LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256,
  writeLogicalOffsiteFixture,
} from "./postgres-logical-offsite.fixtures.js";

const NOW = "2026-08-09T02:00:00.000Z";
const SOURCE_URL = "https://production.example.test";
const DESTINATION_URL = "https://operational-copy.example.test";
const BUCKET = "pintpath-backups";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_DATABASE_IDENTITY_SHA256 =
  LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256;
const RUNTIME_CONNECTION_URL_SHA256 = sha256Fixture(
  "candidate-runtime-connection-url",
);
const LEGACY_SERVICE_ROLE_KEY = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ role: "service_role", iss: "supabase" })).toString("base64url"),
  "synthetic-signature",
].join(".");
const SECRET_API_KEY = `sb_secret_${"s".repeat(32)}`;

interface FakeObject {
  bytes: Buffer;
  info: PostgresLogicalOffsiteObjectInfo;
}

class FakeStorage implements PostgresLogicalOffsiteStorage {
  readonly destinationOrigin = DESTINATION_URL;
  readonly objects = new Map<string, FakeObject>();
  readonly immutableUploads: string[] = [];
  readonly mutableWrites: string[] = [];
  readonly downloadedPaths: string[] = [];
  readonly removals: string[][] = [];
  corruptDownloadPath: string | null = null;
  corruptMetadataPath: string | null = null;
  throwAfterMutableWrite = false;
  onDownload: ((objectPath: string) => void) | null = null;
  private storageGeneration = 0;
  bucket: PostgresLogicalOffsiteBucketInfo = {
    private: true,
    fileSizeLimit: null,
    allowedMimeTypes: ["application/json", "application/octet-stream"],
  };

  async inspectBucket(): Promise<PostgresLogicalOffsiteBucketInfo> {
    return this.bucket;
  }

  async objectInfo(
    _bucketName: string,
    objectPath: string,
  ): Promise<PostgresLogicalOffsiteObjectInfo | null> {
    const object = this.objects.get(objectPath);
    if (!object) return null;
    return {
      ...object.info,
      metadata: objectPath === this.corruptMetadataPath
        ? { ...object.info.metadata, sha256: "0".repeat(64) }
        : object.info.metadata,
    };
  }

  async uploadImmutable(input: PostgresLogicalOffsiteUpload): Promise<void> {
    if (this.objects.has(input.objectPath)) throw new Error("duplicate");
    this.immutableUploads.push(input.objectPath);
    this.write(input);
  }

  async replaceMutable(input: PostgresLogicalOffsiteUpload): Promise<void> {
    this.mutableWrites.push(input.objectPath);
    this.write(input);
    if (this.throwAfterMutableWrite) throw new Error("committed then disconnected");
  }

  async downloadVerified(input: {
    readonly objectPath: string;
    readonly maximumBytes: number;
    readonly retainBytes: boolean;
  }): Promise<PostgresLogicalOffsiteDownload> {
    const object = this.objects.get(input.objectPath);
    if (!object) throw new Error("missing");
    const bytes = input.objectPath === this.corruptDownloadPath
      ? Buffer.concat([object.bytes, Buffer.from("tampered")])
      : object.bytes;
    if (bytes.length > input.maximumBytes) throw new Error("oversized");
    this.downloadedPaths.push(input.objectPath);
    this.onDownload?.(input.objectPath);
    return {
      bytes: bytes.length,
      sha256: sha256Fixture(bytes),
      ...(input.retainBytes ? { retainedBytes: Buffer.from(bytes) } : {}),
    };
  }

  async removeExact(_bucketName: string, objectPaths: readonly string[]): Promise<void> {
    this.removals.push([...objectPaths]);
    for (const objectPath of objectPaths) this.objects.delete(objectPath);
  }

  private write(input: PostgresLogicalOffsiteUpload): void {
    const bytes = input.bytes
      ? Buffer.from(input.bytes)
      : fs.readFileSync(input.filePath!);
    if (bytes.length !== input.expectedBytes) throw new Error("size mismatch");
    const existing = this.objects.get(input.objectPath);
    this.storageGeneration += 1;
    this.objects.set(input.objectPath, {
      bytes,
      info: {
        bytes: bytes.length,
        contentType: input.contentType,
        cacheControl: input.cacheControl,
        metadata: { ...input.metadata },
        storageObjectId: existing?.info.storageObjectId
          ?? `storage-object-${this.storageGeneration}`,
        storageVersion: `storage-version-${this.storageGeneration}`,
      },
    });
  }
}

class FakeState implements PostgresLogicalOffsiteStateAuthority {
  readonly records = new Map<string, SystemStateRecord<Record<string, unknown>>>();
  failSuccessCas = false;
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
    if (this.failSuccessCas && key === POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY) return null;
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
    const existing = this.records.get(input.key);
    const existingUntil = existing?.value.leaseUntil;
    if (typeof existingUntil === "string" && existingUntil > input.now) return null;
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
    const existing = this.records.get(input.key);
    if (
      existing?.value.owner !== input.owner
      || existing.value.leaseToken !== input.leaseToken
    ) return null;
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

  private record<T extends object>(value: T, now: string): SystemStateRecord<T> {
    this.revision += 1;
    return { value, updatedAt: now, revision: `revision-${this.revision}` };
  }
}

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(
    os.tmpdir(),
    "pintpath-logical-offsite-test-",
  )));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function options(input: {
  readonly backupDirectory: string;
  readonly manifestSha256: string;
  readonly storage: FakeStorage;
  readonly state: FakeState;
}) {
  return {
    backupDirectory: input.backupDirectory,
    expectedManifestSha256: input.manifestSha256,
    runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
    runtimeConnectionUrlSha256: RUNTIME_CONNECTION_URL_SHA256,
    sourceSupabaseUrl: SOURCE_URL,
    destinationSupabaseUrl: DESTINATION_URL,
    expectedDestinationOriginSha256: sha256Fixture(DESTINATION_URL),
    bucketName: BUCKET,
    expectedBucketNameSha256: sha256Fixture(BUCKET),
    operatorId: "release-operator-01",
    storage: input.storage,
    state: input.state,
    now: () => new Date(NOW),
    randomUuid: () => UUID,
  } as const;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Postgres logical off-site backup attestation", () => {
  it("uploads and re-downloads every bound artifact before writing exact hash-only state", async () => {
    const fixture = writeLogicalOffsiteFixture(temporaryRoot());
    const storage = new FakeStorage();
    const state = new FakeState();

    const result = await attestPostgresLogicalBackup(options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    }));

    expect(result).toMatchObject({
      schemaVersion: 1,
      ok: true,
      backupCreatedAt: fixture.manifest.createdAt,
      completedAt: NOW,
      archiveSha256: fixture.archiveSha256,
      manifestSha256: fixture.manifestSha256,
      stateReceiptSha256: fixture.receiptSha256,
      overallStateSha256: fixture.manifest.state.overallStateSha256,
      sourceDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
    });
    expect(result).not.toHaveProperty("runtimeConnectionUrlSha256");
    expect(storage.immutableUploads).toHaveLength(4);
    expect(storage.mutableWrites).toEqual([POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT]);
    expect(storage.removals).toEqual([]);
    const persisted = state.records.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)!;
    expect(Object.keys(persisted.value).sort()).toEqual([
      "archiveSha256", "attestationSha256", "attestationStorageObjectIdSha256",
      "attestationStorageVersionSha256", "backupCreatedAt", "backupIdSha256",
      "bucketNameSha256", "completedAt", "destinationOriginSha256", "kind",
      "latestPointerSha256", "latestPointerStorageObjectIdSha256",
      "latestPointerStorageVersionSha256", "manifestBindingSha256", "manifestSha256",
      "operatorIdSha256", "overallStateSha256", "remoteObjectSetSha256",
      "runtimeConnectionUrlSha256", "sourceDatabaseIdentitySha256",
      "stateReceiptSha256", "version",
    ].sort());
    expect(persisted.value.runtimeConnectionUrlSha256)
      .toBe(RUNTIME_CONNECTION_URL_SHA256);
    const pointer = JSON.parse(
      storage.objects.get(POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT)!.bytes.toString("utf8"),
    ) as Record<string, unknown>;
    const attestationPath = storage.immutableUploads.find((entry) => (
      entry.includes("/attestations/")
    ))!;
    const attestation = JSON.parse(
      storage.objects.get(attestationPath)!.bytes.toString("utf8"),
    ) as Record<string, unknown>;
    expect(pointer.runtimeConnectionUrlSha256).toBe(RUNTIME_CONNECTION_URL_SHA256);
    expect(attestation.runtimeConnectionUrlSha256)
      .toBe(RUNTIME_CONNECTION_URL_SHA256);
    const legacyState = { ...persisted.value };
    const legacyPointer = { ...pointer };
    const legacyAttestation = { ...attestation };
    delete legacyState.runtimeConnectionUrlSha256;
    delete legacyPointer.runtimeConnectionUrlSha256;
    delete legacyAttestation.runtimeConnectionUrlSha256;
    expect(() => parsePostgresLogicalBackupSuccessState(legacyState)).not.toThrow();
    expect(() => postgresLogicalOffsiteInternals.parseLatestPointer(
      Buffer.from(canonicalPostgresBackupJson(legacyPointer), "utf8"),
    )).not.toThrow();
    expect(() => postgresLogicalOffsiteInternals.parseAttestation(
      Buffer.from(canonicalPostgresBackupJson(legacyAttestation), "utf8"),
    )).not.toThrow();
    expect(canonicalPostgresBackupJson(
      parsePostgresLogicalBackupSuccessState(persisted.value),
    )).not.toContain("release-operator-01");
    expect(canonicalPostgresBackupJson(persisted.value)).not.toContain(SOURCE_URL);
    expect(canonicalPostgresBackupJson(persisted.value)).not.toContain(DESTINATION_URL);
    expect(canonicalPostgresBackupJson(persisted.value)).not.toContain(BUCKET);

    storage.downloadedPaths.splice(0);
    await expect(probePostgresLogicalOffsiteReadiness({
      stateValue: persisted.value,
      runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
      sourceSupabaseUrl: SOURCE_URL,
      destinationSupabaseUrl: DESTINATION_URL,
      bucketName: BUCKET,
      maxFreshnessHours: 24,
      storage,
      now: new Date(NOW),
    })).resolves.toEqual({
      status: "ok",
      required: true,
      liveProbe: true,
      lastSuccessfulAt: fixture.manifest.createdAt,
      ageHours: 1,
    });
    expect(persisted.value.version).toBe(2);
    expect(storage.downloadedPaths).toContain(POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT);
    expect(storage.downloadedPaths.some((entry) => entry.endsWith("/manifest.json")))
      .toBe(true);
    expect(storage.downloadedPaths.some((entry) => entry.endsWith("/state-receipt.json")))
      .toBe(true);
    expect(storage.downloadedPaths.some((entry) => entry.endsWith("/pintpath-postgres.dump")))
      .toBe(false);

    await expect(probePostgresLogicalOffsiteReadiness({
      stateValue: {
        ...persisted.value,
        runtimeConnectionUrlSha256: "0".repeat(64),
      },
      runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
      sourceSupabaseUrl: SOURCE_URL,
      destinationSupabaseUrl: DESTINATION_URL,
      bucketName: BUCKET,
      maxFreshnessHours: 24,
      storage,
      now: new Date(NOW),
    })).resolves.toMatchObject({
      error: "remote_attestation_mismatch",
      liveProbe: true,
    });
  });

  it("rejects migrated timestamp-only state before any remote readiness access", async () => {
    expect(() => parsePostgresLogicalBackupSuccessState({ completedAt: NOW }))
      .toThrowError(PostgresLogicalOffsiteError);
    const report = await probePostgresLogicalOffsiteReadiness({
      stateValue: { completedAt: NOW },
      runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
      sourceSupabaseUrl: SOURCE_URL,
      destinationSupabaseUrl: DESTINATION_URL,
      destinationServiceRoleKey: "must-not-be-used",
      bucketName: BUCKET,
      maxFreshnessHours: 24,
      storage: {
        inspectBucket: async () => { throw new Error("must not run"); },
      } as unknown as PostgresLogicalOffsiteStorage,
      now: new Date(NOW),
    });
    expect(report).toMatchObject({
      status: "failed",
      liveProbe: false,
      error: "attestation_state_invalid",
    });
  });

  it("fails closed on a version-one attestation state", async () => {
    const fixture = writeLogicalOffsiteFixture(temporaryRoot());
    const storage = new FakeStorage();
    const state = new FakeState();
    await attestPostgresLogicalBackup(options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    }));
    const current = state.records.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)!.value;
    const report = await probePostgresLogicalOffsiteReadiness({
      stateValue: { ...current, version: 1 },
      runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
      sourceSupabaseUrl: SOURCE_URL,
      destinationSupabaseUrl: DESTINATION_URL,
      bucketName: BUCKET,
      maxFreshnessHours: 24,
      storage,
      now: new Date(NOW),
    });
    expect(report).toMatchObject({
      status: "failed",
      liveProbe: false,
      error: "attestation_state_invalid",
    });
  });

  it.each(["manifest.json", "state-receipt.json"])(
    "detects same-size post-attestation corruption of %s",
    async (filename) => {
      const fixture = writeLogicalOffsiteFixture(temporaryRoot());
      const storage = new FakeStorage();
      const state = new FakeState();
      await attestPostgresLogicalBackup(options({
        backupDirectory: fixture.backupDirectory,
        manifestSha256: fixture.manifestSha256,
        storage,
        state,
      }));
      const objectPath = storage.immutableUploads.find((entry) => entry.endsWith(`/${filename}`))!;
      const object = storage.objects.get(objectPath)!;
      const corrupted = Buffer.from(object.bytes);
      corrupted[0] = corrupted[0] === 0x7b ? 0x5b : (corrupted[0]! ^ 1);
      object.bytes = corrupted;
      storage.downloadedPaths.splice(0);

      await expect(probePostgresLogicalOffsiteReadiness({
        stateValue: state.records.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)!.value,
        runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
        sourceSupabaseUrl: SOURCE_URL,
        destinationSupabaseUrl: DESTINATION_URL,
        bucketName: BUCKET,
        maxFreshnessHours: 24,
        storage,
        now: new Date(NOW),
      })).resolves.toMatchObject({
        error: "remote_attestation_mismatch",
        liveProbe: true,
      });
      expect(storage.downloadedPaths).toContain(objectPath);
    },
  );

  it.each(["storageObjectId", "storageVersion"] as const)(
    "detects archive replacement when its Storage %s changes",
    async (field) => {
      const fixture = writeLogicalOffsiteFixture(temporaryRoot());
      const storage = new FakeStorage();
      const state = new FakeState();
      await attestPostgresLogicalBackup(options({
        backupDirectory: fixture.backupDirectory,
        manifestSha256: fixture.manifestSha256,
        storage,
        state,
      }));
      const archivePath = storage.immutableUploads.find((entry) => (
        entry.endsWith("/pintpath-postgres.dump")
      ))!;
      const archive = storage.objects.get(archivePath)!;
      archive.info = { ...archive.info, [field]: `replacement-${field}` };
      storage.downloadedPaths.splice(0);

      await expect(probePostgresLogicalOffsiteReadiness({
        stateValue: state.records.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)!.value,
        runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
        sourceSupabaseUrl: SOURCE_URL,
        destinationSupabaseUrl: DESTINATION_URL,
        bucketName: BUCKET,
        maxFreshnessHours: 24,
        storage,
        now: new Date(NOW),
      })).resolves.toMatchObject({
        error: "remote_attestation_mismatch",
        liveProbe: true,
      });
      expect(storage.downloadedPaths).not.toContain(archivePath);
    },
  );

  it("cleans up only newly created logical-backup objects when remote bytes differ", async () => {
    const fixture = writeLogicalOffsiteFixture(temporaryRoot());
    const storage = new FakeStorage();
    const state = new FakeState();
    storage.corruptDownloadPath = [
      `${POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT.split("/latest.json")[0]}`,
      "backups",
    ].join("/");
    // Select the first immutable object after the upload path is known.
    const originalUpload = storage.uploadImmutable.bind(storage);
    storage.uploadImmutable = async (input) => {
      await originalUpload(input);
      if (storage.immutableUploads.length === 1) storage.corruptDownloadPath = input.objectPath;
    };

    await expect(attestPostgresLogicalBackup(options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    }))).rejects.toMatchObject({ code: "object_verification_failed" });

    expect(storage.removals).toHaveLength(1);
    expect(storage.removals[0]).toEqual([storage.immutableUploads[0]]);
    expect(storage.removals.flat().some((entry) => entry.includes("account-deletion")))
      .toBe(false);
    expect(state.records.has(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)).toBe(false);
  });

  it("leaves a fail-closed pointer and immutable evidence when final state CAS fails", async () => {
    const fixture = writeLogicalOffsiteFixture(temporaryRoot());
    const storage = new FakeStorage();
    const state = new FakeState();
    state.failSuccessCas = true;

    await expect(attestPostgresLogicalBackup(options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    }))).rejects.toMatchObject({ code: "state_write_failed" });

    expect(storage.objects.has(POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT)).toBe(true);
    expect(storage.removals).toEqual([]);
    expect(state.records.has(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)).toBe(false);
  });

  it("never cleans immutable evidence after a mutable pointer may have committed", async () => {
    const fixture = writeLogicalOffsiteFixture(temporaryRoot());
    const storage = new FakeStorage();
    const state = new FakeState();
    storage.throwAfterMutableWrite = true;

    await expect(attestPostgresLogicalBackup(options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    }))).rejects.toMatchObject({ code: "object_upload_failed" });

    expect(storage.objects.has(POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT)).toBe(true);
    expect(storage.removals).toEqual([]);
    expect(state.records.has(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)).toBe(false);
  });

  it("fences a lease takeover after pointer verification and before success state CAS", async () => {
    const fixture = writeLogicalOffsiteFixture(temporaryRoot());
    const storage = new FakeStorage();
    const state = new FakeState();
    storage.onDownload = (objectPath) => {
      if (objectPath !== POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT) return;
      storage.onDownload = null;
      state.records.set(POSTGRES_LOGICAL_OFFSITE_LEASE_KEY, {
        value: {
          owner: "takeover-operator",
          leaseToken: "00000000-0000-4000-8000-000000000000",
          leaseUntil: "2026-08-09T04:00:00.000Z",
        },
        updatedAt: NOW,
        revision: "takeover-revision",
      });
    };

    await expect(attestPostgresLogicalBackup(options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    }))).rejects.toMatchObject({ code: "lease_lost" });

    expect(storage.objects.has(POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT)).toBe(true);
    expect(storage.removals).toEqual([]);
    expect(state.records.has(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)).toBe(false);
    expect(state.records.get(POSTGRES_LOGICAL_OFFSITE_LEASE_KEY)?.value.owner)
      .toBe("takeover-operator");
  });

  it("supports exact replay without overwriting immutable objects and rejects an older backup", async () => {
    const root = temporaryRoot();
    const fixture = writeLogicalOffsiteFixture(root);
    const storage = new FakeStorage();
    const state = new FakeState();
    const runOptions = options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    });
    const first = await attestPostgresLogicalBackup(runOptions);
    const immutableCount = storage.immutableUploads.length;
    const replay = await attestPostgresLogicalBackup(runOptions);

    expect(replay).toEqual(first);
    expect(storage.immutableUploads).toHaveLength(immutableCount);
    expect(storage.mutableWrites).toHaveLength(2);

    const olderRoot = temporaryRoot();
    const older = writeLogicalOffsiteFixture(olderRoot, "2026-08-08T01:00:00.000Z");
    await expect(attestPostgresLogicalBackup(options({
      backupDirectory: older.backupDirectory,
      manifestSha256: older.manifestSha256,
      storage,
      state,
    }))).rejects.toMatchObject({ code: "state_regression" });
    expect(storage.immutableUploads).toHaveLength(immutableCount);
  });

  it("fences concurrent operators and rejects an unsafe directory before Storage mutation", async () => {
    const fixture = writeLogicalOffsiteFixture(temporaryRoot());
    const storage = new FakeStorage();
    const state = new FakeState();
    state.records.set(POSTGRES_LOGICAL_OFFSITE_LEASE_KEY, {
      value: {
        owner: "another-operator",
        leaseToken: UUID,
        leaseUntil: "2026-08-09T03:00:00.000Z",
      },
      updatedAt: NOW,
      revision: "active-lease",
    });
    await expect(attestPostgresLogicalBackup(options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    }))).rejects.toMatchObject({ code: "lease_unavailable" });
    expect(storage.immutableUploads).toEqual([]);

    state.records.clear();
    fs.writeFileSync(path.join(fixture.backupDirectory, "unexpected"), "no", { mode: 0o600 });
    await expect(attestPostgresLogicalBackup(options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    }))).rejects.toMatchObject({ code: "unsafe_backup_directory" });
    expect(storage.immutableUploads).toEqual([]);
  });

  it("requires protected destination pins and the exact manifest source database identity", async () => {
    const fixture = writeLogicalOffsiteFixture(temporaryRoot());
    const storage = new FakeStorage();
    const state = new FakeState();
    const base = options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    });

    await expect(attestPostgresLogicalBackup({
      ...base,
      expectedDestinationOriginSha256: "0".repeat(64),
    })).rejects.toMatchObject({ code: "destination_unsafe" });
    await expect(attestPostgresLogicalBackup({
      ...base,
      expectedBucketNameSha256: "0".repeat(64),
    })).rejects.toMatchObject({ code: "destination_unsafe" });
    await expect(attestPostgresLogicalBackup({
      ...base,
      runtimeDatabaseIdentitySha256: "0".repeat(64),
    })).rejects.toMatchObject({ code: "runtime_identity_mismatch" });
    await expect(attestPostgresLogicalBackup({
      ...base,
      runtimeConnectionUrlSha256: "",
    })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(storage.immutableUploads).toEqual([]);
    expect(storage.mutableWrites).toEqual([]);
  });

  it("fails readiness on stale state, destination drift, missing objects, and metadata drift", async () => {
    const fixture = writeLogicalOffsiteFixture(temporaryRoot());
    const storage = new FakeStorage();
    const state = new FakeState();
    await attestPostgresLogicalBackup(options({
      backupDirectory: fixture.backupDirectory,
      manifestSha256: fixture.manifestSha256,
      storage,
      state,
    }));
    const value = state.records.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)!.value;

    await expect(probePostgresLogicalOffsiteReadiness({
      stateValue: value,
      runtimeDatabaseIdentitySha256: "0".repeat(64),
      sourceSupabaseUrl: SOURCE_URL,
      destinationSupabaseUrl: DESTINATION_URL,
      bucketName: BUCKET,
      maxFreshnessHours: 24,
      storage,
      now: new Date(NOW),
    })).resolves.toMatchObject({
      error: "runtime_database_binding_mismatch",
      liveProbe: false,
    });

    await expect(probePostgresLogicalOffsiteReadiness({
      stateValue: value,
      runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
      sourceSupabaseUrl: SOURCE_URL,
      destinationSupabaseUrl: DESTINATION_URL,
      bucketName: BUCKET,
      maxFreshnessHours: 1,
      storage,
      now: new Date("2026-08-10T02:00:00.000Z"),
    })).resolves.toMatchObject({ error: "last_successful_backup_stale", liveProbe: false });
    await expect(probePostgresLogicalOffsiteReadiness({
      stateValue: value,
      runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
      sourceSupabaseUrl: SOURCE_URL,
      destinationSupabaseUrl: "https://different-copy.example.test",
      bucketName: BUCKET,
      maxFreshnessHours: 24,
      storage,
      now: new Date(NOW),
    })).resolves.toMatchObject({ error: "destination_binding_mismatch", liveProbe: false });

    const pointer = storage.objects.get(POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT)!;
    storage.objects.delete(POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT);
    await expect(probePostgresLogicalOffsiteReadiness({
      stateValue: value,
      runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
      sourceSupabaseUrl: SOURCE_URL,
      destinationSupabaseUrl: DESTINATION_URL,
      bucketName: BUCKET,
      maxFreshnessHours: 24,
      storage,
      now: new Date(NOW),
    })).resolves.toMatchObject({ error: "remote_attestation_mismatch", liveProbe: true });
    storage.objects.set(POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT, pointer);
    storage.corruptMetadataPath = POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT;
    await expect(probePostgresLogicalOffsiteReadiness({
      stateValue: value,
      runtimeDatabaseIdentitySha256: SOURCE_DATABASE_IDENTITY_SHA256,
      sourceSupabaseUrl: SOURCE_URL,
      destinationSupabaseUrl: DESTINATION_URL,
      bucketName: BUCKET,
      maxFreshnessHours: 24,
      storage,
      now: new Date(NOW),
    })).resolves.toMatchObject({ error: "remote_attestation_mismatch", liveProbe: true });
  });
});

describe("Postgres logical backup runtime identity", () => {
  it("reconstructs the same stable source database hash captured by the manifest", async () => {
    let query = "";
    const database = {
      dialect: "postgres",
      prepare: (sql: string) => {
        query = sql;
        return {
          get: async () => ({ ...LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY }),
        };
      },
    } as unknown as SqlDatabase;

    await expect(inspectPostgresLogicalRuntimeDatabaseIdentity(database))
      .resolves.toBe(SOURCE_DATABASE_IDENTITY_SHA256);
    expect(query).toContain("pg_catalog.pg_control_system()");
    expect(query).not.toContain(SOURCE_DATABASE_IDENTITY_SHA256);
  });

  it("fails closed for non-Postgres and malformed native identity rows", async () => {
    await expect(inspectPostgresLogicalRuntimeDatabaseIdentity({
      dialect: "sqlite",
    } as unknown as SqlDatabase)).rejects.toMatchObject({
      code: "runtime_identity_unavailable",
    });
    await expect(inspectPostgresLogicalRuntimeDatabaseIdentity({
      dialect: "postgres",
      prepare: () => ({ get: async () => ({ databaseName: "wrong" }) }),
    } as unknown as SqlDatabase)).rejects.toMatchObject({
      code: "runtime_identity_unavailable",
    });
  });
});

describe("Supabase resumable logical archive transport", () => {
  it("requires and exposes opaque bounded Storage object and generation identifiers", async () => {
    let includeVersion = true;
    const client = {
      storage: {
        from: () => ({
          info: async () => ({
            data: {
              id: "provider-object-id",
              ...(includeVersion ? { version: "provider-generation-token" } : {}),
              size: 12,
              contentType: "application/json",
              cacheControl: "31536000",
              metadata: { contract: "fixture" },
            },
            error: null,
          }),
        }),
      },
    } as unknown as SupabaseClient;
    const storage = createSupabasePostgresLogicalOffsiteStorage({
      destinationSupabaseUrl: "https://backup.example.test",
      destinationServiceRoleKey: "service-role-test-secret",
      clientFactory: () => client,
      fetchImplementation: async () => new Response(null, { status: 200 }),
    });

    await expect(storage.objectInfo(BUCKET, "object.json")).resolves.toEqual({
      bytes: 12,
      contentType: "application/json",
      cacheControl: "31536000",
      metadata: { contract: "fixture" },
      storageObjectId: "provider-object-id",
      storageVersion: "provider-generation-token",
    });
    includeVersion = false;
    await expect(storage.objectInfo(BUCKET, "object.json"))
      .rejects.toMatchObject({ code: "object_verification_failed" });
  });

  it("treats the Storage API provider statusCode 404 as an absent object", async () => {
    let statusCode = "404";
    const client = {
      storage: {
        from: () => ({
          info: async () => ({
            data: null,
            error: {
              name: "StorageApiError",
              message: "Object not found",
              status: 400,
              statusCode,
            },
          }),
        }),
      },
    } as unknown as SupabaseClient;
    const storage = createSupabasePostgresLogicalOffsiteStorage({
      destinationSupabaseUrl: "https://backup.example.test",
      destinationServiceRoleKey: "service-role-test-secret",
      clientFactory: () => client,
      fetchImplementation: async () => new Response(null, { status: 200 }),
    });

    await expect(storage.objectInfo(BUCKET, "missing.json")).resolves.toBeNull();
    statusCode = "403";
    await expect(storage.objectInfo(BUCKET, "denied.json"))
      .rejects.toMatchObject({ code: "destination_unreachable" });
  });

  it("uses six-MiB TUS semantics and resumes from a partial authoritative offset", async () => {
    const root = temporaryRoot();
    const filePath = path.join(root, "archive.dump");
    fs.writeFileSync(filePath, "abcdef", { mode: 0o600 });
    const calls: {
      method: string;
      offset: string | null;
      bytes: number;
      redirect: RequestRedirect | undefined;
      apikey: string | null;
      authorization: string | null;
    }[] = [];
    let patchAttempts = 0;
    const fetchImplementation: typeof globalThis.fetch = async (_input, init) => {
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body = init?.body;
      const bytes = Buffer.isBuffer(body) ? body.length : 0;
      calls.push({
        method,
        offset: headers.get("upload-offset"),
        bytes,
        redirect: init?.redirect,
        apikey: headers.get("apikey"),
        authorization: headers.get("authorization"),
      });
      if (method === "POST") {
        expect(headers.get("upload-length")).toBe("6");
        expect(headers.get("upload-metadata")).toContain("bucketName ");
        return new Response(null, {
          status: 201,
          headers: { location: "/storage/v1/upload/resumable/upload-id" },
        });
      }
      if (method === "PATCH") {
        patchAttempts += 1;
        if (patchAttempts === 1) throw new Error("uncertain network outcome");
        return new Response(null, {
          status: 204,
          headers: { "upload-offset": "6" },
        });
      }
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "upload-offset": "3" },
        });
      }
      throw new Error("unexpected request");
    };
    const storage = createSupabasePostgresLogicalOffsiteStorage({
      destinationSupabaseUrl: "https://backup.example.test",
      destinationServiceRoleKey: LEGACY_SERVICE_ROLE_KEY,
      requestTimeoutMs: 5_000,
      fetchImplementation,
      clientFactory: () => ({ storage: {} } as unknown as SupabaseClient),
    });

    await storage.uploadImmutable({
      bucketName: BUCKET,
      objectPath: "_control/postgres-logical-backups/v2/backups/fixture/archive.dump",
      contentType: "application/octet-stream",
      cacheControl: "31536000",
      metadata: { sha256: sha256Fixture("abcdef") },
      filePath,
      expectedBytes: 6,
    });

    expect(calls.map((call) => call.method)).toEqual(["POST", "PATCH", "HEAD", "PATCH"]);
    expect(calls.at(-1)).toEqual({
      method: "PATCH",
      offset: "3",
      bytes: 3,
      redirect: "error",
      apikey: LEGACY_SERVICE_ROLE_KEY,
      authorization: `Bearer ${LEGACY_SERVICE_ROLE_KEY}`,
    });
    expect(calls.every((call) => call.redirect === "error")).toBe(true);
    expect(calls.every((call) => call.apikey === LEGACY_SERVICE_ROLE_KEY)).toBe(true);
    expect(calls.every(
      (call) => call.authorization === `Bearer ${LEGACY_SERVICE_ROLE_KEY}`,
    )).toBe(true);
  });

  it("uses apikey-only TUS authentication for opaque secret API keys", async () => {
    const root = temporaryRoot();
    const filePath = path.join(root, "archive.dump");
    fs.writeFileSync(filePath, "x", { mode: 0o600 });
    const headers: Headers[] = [];
    let patchAttempts = 0;
    const fetchImplementation: typeof globalThis.fetch = async (_input, init) => {
      const requestHeaders = new Headers(init?.headers);
      headers.push(requestHeaders);
      if (init?.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { location: "/storage/v1/upload/resumable/secret-key-upload" },
        });
      }
      if (init?.method === "PATCH") {
        patchAttempts += 1;
        if (patchAttempts === 1) return new Response(null, { status: 503 });
        return new Response(null, {
          status: 204,
          headers: { "upload-offset": "1" },
        });
      }
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "upload-offset": "0" },
        });
      }
      throw new Error("unexpected request");
    };
    const storage = createSupabasePostgresLogicalOffsiteStorage({
      destinationSupabaseUrl: "https://backup.example.test",
      destinationServiceRoleKey: SECRET_API_KEY,
      requestTimeoutMs: 5_000,
      fetchImplementation,
      clientFactory: () => ({ storage: {} } as unknown as SupabaseClient),
    });

    await storage.uploadImmutable({
      bucketName: BUCKET,
      objectPath: "_control/postgres-logical-backups/v2/backups/fixture/archive.dump",
      contentType: "application/octet-stream",
      cacheControl: "31536000",
      metadata: { sha256: sha256Fixture("x") },
      filePath,
      expectedBytes: 1,
    });

    expect(headers).toHaveLength(4);
    for (const requestHeaders of headers) {
      expect(requestHeaders.get("apikey")).toBe(SECRET_API_KEY);
      expect(requestHeaders.has("authorization")).toBe(false);
      expect(requestHeaders.get("tus-resumable")).toBe("1.0.0");
    }
  });

  it("rejects malformed opaque keys before any TUS request without echoing them", async () => {
    const root = temporaryRoot();
    const filePath = path.join(root, "archive.dump");
    fs.writeFileSync(filePath, "x", { mode: 0o600 });
    const malformedKey = "sb_secret_too-short";
    const fetchImplementation = vi.fn() as unknown as typeof globalThis.fetch;
    const storage = createSupabasePostgresLogicalOffsiteStorage({
      destinationSupabaseUrl: "https://backup.example.test",
      destinationServiceRoleKey: malformedKey,
      requestTimeoutMs: 5_000,
      fetchImplementation,
      clientFactory: () => ({ storage: {} } as unknown as SupabaseClient),
    });
    let failure: unknown;
    try {
      await storage.uploadImmutable({
        bucketName: BUCKET,
        objectPath: "_control/postgres-logical-backups/v2/backups/fixture/archive.dump",
        contentType: "application/octet-stream",
        cacheControl: "31536000",
        metadata: { sha256: sha256Fixture("x") },
        filePath,
        expectedBytes: 1,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "object_upload_failed" });
    expect(JSON.stringify(failure)).not.toContain(malformedKey);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("never forwards privileged requests outside the exact Storage origins and paths", async () => {
    const requests: string[] = [];
    const scoped = postgresLogicalOffsiteInternals.createScopedStorageFetch(
      "https://backup-project.supabase.co",
      async (input, init) => {
        requests.push(typeof input === "string" ? input : input.toString());
        expect(init?.redirect).toBe("error");
        return new Response(null, { status: 200 });
      },
    );
    await expect(scoped(
      "https://backup-project.supabase.co/storage/v1/object/info/bucket/object",
      { headers: { apikey: "must-not-leak" } },
    )).resolves.toBeInstanceOf(Response);
    await expect(scoped(
      "https://attacker.example.test/storage/v1/object/info/bucket/object",
      { headers: { apikey: "must-not-leak" } },
    )).rejects.toMatchObject({ code: "destination_unsafe" });
    await expect(scoped(
      "https://backup-project.supabase.co/auth/v1/user",
      { headers: { apikey: "must-not-leak" } },
    )).rejects.toMatchObject({ code: "destination_unsafe" });
    expect(requests).toHaveLength(1);
  });

  it("bounds a response body that stalls after download headers arrive", async () => {
    const neverYieldingBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const client = {
      storage: {
        from: () => ({
          download: () => ({
            asStream: async () => ({ data: neverYieldingBody, error: null }),
          }),
        }),
      },
    } as unknown as SupabaseClient;
    const storage = createSupabasePostgresLogicalOffsiteStorage({
      destinationSupabaseUrl: "https://backup.example.test",
      destinationServiceRoleKey: "service-role-test-secret",
      requestTimeoutMs: 1_000,
      clientFactory: () => client,
      fetchImplementation: async () => new Response(null, { status: 200 }),
    });
    const started = Date.now();

    await expect(storage.downloadVerified({
      bucketName: BUCKET,
      objectPath: POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT,
      maximumBytes: 1024,
      retainBytes: true,
    })).rejects.toMatchObject({ code: "destination_unreachable" });
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("refuses any cleanup target outside its dedicated logical-backup namespace", async () => {
    const storage = createSupabasePostgresLogicalOffsiteStorage({
      destinationSupabaseUrl: "https://backup.example.test",
      destinationServiceRoleKey: "service-role-test-secret",
      clientFactory: () => ({ storage: {} } as unknown as SupabaseClient),
      fetchImplementation: async () => new Response(null, { status: 500 }),
    });
    await expect(storage.removeExact(BUCKET, [
      "_control/account-deletion-ledger/v1/immutable.json",
    ])).rejects.toMatchObject({ code: "cleanup_failed" });
  });
});
