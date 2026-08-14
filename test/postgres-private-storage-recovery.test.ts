import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import {
  POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  canonicalPostgresBackupJson,
} from "../src/lib/postgres-logical-backup.js";
import { parsePostgresLogicalSourceStateReceipt } from "../src/lib/postgres-logical-state.js";
import {
  POSTGRES_PRIVATE_STORAGE_BUCKET,
  POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST,
  POSTGRES_PRIVATE_STORAGE_RECOVERY_OBJECTS,
  POSTGRES_PRIVATE_STORAGE_RECOVERY_VERSION,
  POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_ENV,
  POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_VALUE,
  PostgresPrivateStorageRecoveryError,
  capturePostgresPrivateStorageRecovery,
  createSupabasePrivateStorageRecoveryBoundary,
  postgresPrivateStorageRecoveryInternals,
  restorePostgresPrivateStorageRecovery,
  type CapturePostgresPrivateStorageRecoveryOptions,
  type PostgresPrivateStorageBoundary,
  type PostgresPrivateStorageDatabaseSnapshot,
  type PostgresPrivateStorageDownloadedObject,
  type PostgresPrivateStorageObjectInfo,
  type PostgresPrivateStorageReference,
  type RestorePostgresPrivateStorageRecoveryOptions,
} from "../src/lib/postgres-private-storage-recovery.js";
import { runPostgresPrivateStorageRestoreCli } from "../scripts/restore-postgres-private-storage-recovery.js";
import { runPostgresPrivateStorageCaptureCli } from "../scripts/capture-postgres-private-storage-recovery.js";
import {
  PERMANENT_STAGING_SUPABASE_ORIGIN,
  PRODUCTION_SUPABASE_STORAGE_ORIGIN,
} from "../src/lib/supabase-key-format.js";
import {
  LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256,
  sha256Fixture,
  writeLogicalOffsiteFixture,
} from "./postgres-logical-offsite.fixtures.js";

const CAPTURED_AT = "2026-08-09T06:00:00.000Z";
const RESTORED_AT = "2026-08-09T06:15:00.000Z";
const COMPLETED_AT = "2026-08-09T05:00:00.000Z";
const SOURCE_ORIGIN = PRODUCTION_SUPABASE_STORAGE_ORIGIN;
const STAGING_SOURCE_ORIGIN = PERMANENT_STAGING_SUPABASE_ORIGIN;
const DESTINATION_ORIGIN = "https://bcdefghijklmnopqrstu.supabase.co";
const SERVICE_ROLE_KEY = `sb_secret_${"s".repeat(32)}`; // security-scan allow: synthetic fixture
const MIGRATION_RUN_SHA256 = "3".repeat(64);
const CANDIDATE_COMMIT_SHA = "c".repeat(40);
const TARGET_DATABASE_IDENTITY_SHA256 = "f1".repeat(32);
const TARGET_CONNECTION_URL_SHA256 = "e2".repeat(32);
const AUTHORITY_NOW = new Date("2026-08-09T06:30:00.000Z");

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fakeDatabaseTransport(
  options: OpenPostgresRailwayStockLocalhostCaTransportOptions,
): PostgresRailwayStockLocalhostCaTransport {
  return {
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaDerSha256: options.expectedRootCaDerSha256,
    sourceUrlAuthority: options.sourceUrlAuthority,
    resolvedAddress: "fd12::1",
    temporaryDirectory: "/private/transport",
    passwordFileDirectory: "/private/transport",
    passwordFileHost: "localhost",
    nodeConnection: {
      host: "fd12::1",
      port: 5432,
      ssl: {
        ca: "fixture",
        servername: "localhost",
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        checkServerIdentity: () => undefined,
      },
    },
    libpqEnvironment: {
      PGHOST: "localhost",
      PGHOSTADDR: "fd12::1",
      PGPORT: "5432",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/private/transport/railway-root-ca.pem",
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
    },
    assertExact: async () => undefined,
    close: async () => undefined,
  };
}

function restoreCliAuthorityFixture(): {
  readonly argv: string[];
  readonly authoritySource: string;
  readonly publicKeyPem: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = {
    schemaVersion: "pintpath-private-storage-disposable-authority-payload/v1",
    candidateSha: CANDIDATE_COMMIT_SHA,
    destinationOrigin: DESTINATION_ORIGIN,
    destinationOriginSha256: sha256(DESTINATION_ORIGIN),
    targetConnectionUrlSha256: TARGET_CONNECTION_URL_SHA256,
    targetDatabaseIdentitySha256: TARGET_DATABASE_IDENTITY_SHA256,
    targetRailwayProjectId: "11111111-1111-4111-8111-111111111111",
    targetRailwayEnvironmentId: "22222222-2222-4222-8222-222222222222",
    reviewerIdSha256: "9".repeat(64),
    reviewerPublicKeySha256: sha256(publicKeyPem),
    issuedAt: "2026-08-09T06:00:00.000Z",
    expiresAt: "2026-08-10T06:00:00.000Z",
  };
  const authoritySource = canonicalPostgresBackupJson({
    schemaVersion: "pintpath-private-storage-disposable-authority/v1",
    payload,
    signatureBase64: crypto.sign(
      null,
      Buffer.from(canonicalPostgresBackupJson(payload), "utf8"),
      privateKey,
    ).toString("base64"),
  });
  const values: Readonly<Record<string, string>> = {
    "--backup-directory": "/private/backup",
    "--backup-manifest-sha256": "a".repeat(64),
    "--bucket-name-sha256": "a".repeat(64),
    "--destination-origin-sha256": sha256(DESTINATION_ORIGIN),
    "--destination-authority-file": "/private/destination-authority.json",
    "--destination-authority-sha256": sha256(authoritySource),
    "--destination-authority-public-key-file": "/private/destination-authority.pem",
    "--destination-authority-public-key-sha256": sha256(publicKeyPem),
    "--expected-candidate-sha": CANDIDATE_COMMIT_SHA,
    "--forbidden-origin-sha256s": "b".repeat(64),
    "--recovery-manifest-sha256": "a".repeat(64),
    "--recovery-set-directory": "/private/recovery-set",
    "--recovery-set-sha256": "a".repeat(64),
    "--service-role-key-file": "/private/service-role.key",
    "--target-connection-url-file": "/private/connection",
    "--root-ca-file": "/private/root-ca.pem",
    "--expected-root-ca-der-sha256": "a".repeat(64),
    "--target-connection-url-sha256": TARGET_CONNECTION_URL_SHA256,
    "--target-database-identity-sha256": TARGET_DATABASE_IDENTITY_SHA256,
    "--target-railway-project-id": "11111111-1111-4111-8111-111111111111",
    "--target-railway-environment-id": "22222222-2222-4222-8222-222222222222",
  };
  return {
    argv: Object.entries(values).flatMap(([key, value]) => [key, value]),
    authoritySource,
    publicKeyPem,
  };
}

function privateRoot(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-private-storage-recovery-"),
    ),
  );
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function writePrivate(filePath: string, value: string | Buffer): void {
  fs.writeFileSync(filePath, value, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function pretty(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeDeletionAuthority(root: string): {
  readonly directory: string;
  readonly currentSha256: string;
  readonly genesisSha256: string;
  readonly checkpointSha256: string;
  readonly immutableSetSha256: string;
} {
  const directory = path.join(root, "deletion-authority");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const current = pretty({
    version: 1,
    generatedAt: COMPLETED_AT,
    tombstones: [
      {
        requestId: "nonzero-recovery-delete-request",
        userId: "nonzero-recovery-delete-user",
        completedAt: COMPLETED_AT,
      },
    ],
  });
  const genesis = pretty({
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt: "2026-08-01T00:00:00.000Z",
    immutablePrefix: "_control/account-deletion-ledger/v1",
    currentLedgerPath: "_control/account-deletion-tombstones.json",
  });
  const currentSha256 = sha256(current);
  const genesisSha256 = sha256(genesis);
  const immutableSetSha256 = "b2".repeat(32);
  const checkpoint = pretty({
    version: 2,
    generatedAt: COMPLETED_AT,
    genesisPath: "_control/account-deletion-ledger-genesis.json",
    genesisSha256,
    currentLedgerPath: "_control/account-deletion-tombstones.json",
    currentLedgerSha256: currentSha256,
    immutableObjectCount: 1,
    immutableSetSha256,
    tombstoneCount: 1,
    latestCompletedAt: COMPLETED_AT,
  });
  writePrivate(path.join(directory, "current.json"), current);
  writePrivate(path.join(directory, "genesis.json"), genesis);
  writePrivate(path.join(directory, "checkpoint.json"), checkpoint);
  return {
    directory,
    currentSha256,
    genesisSha256,
    checkpointSha256: sha256(checkpoint),
    immutableSetSha256,
  };
}

interface StoredObject {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly id: string;
  readonly version: string;
}

class MemoryStorage implements PostgresPrivateStorageBoundary {
  readonly bucketName = POSTGRES_PRIVATE_STORAGE_BUCKET;
  readonly uploads: string[] = [];
  readonly values = new Map<string, StoredObject>();
  private listCallCount = 0;
  private downloadCallCount = 0;

  constructor(
    readonly origin: string,
    initial: Readonly<
      Record<string, { readonly bytes: Buffer; readonly contentType: string }>
    >,
    private readonly options: {
      readonly publicBucket?: boolean;
      readonly driftOnSecondList?: boolean;
      readonly failUploadPath?: string;
      readonly insertOnListCall?: number;
      readonly mutateAfterDownloadCall?: number;
      readonly afterDownload?:
        ((call: number, objectPath: string) => void) | undefined;
    } = {},
  ) {
    for (const [objectPath, object] of Object.entries(initial)) {
      this.values.set(objectPath, {
        bytes: Buffer.from(object.bytes),
        contentType: object.contentType,
        id: `id:${objectPath}`,
        version: `version:${objectPath}:1`,
      });
    }
  }

  async inspectBucket(): Promise<{
    readonly private: boolean;
    readonly fileSizeLimit: number;
    readonly allowedMimeTypes: readonly string[];
  }> {
    return {
      private: this.options.publicBucket !== true,
      fileSizeLimit: 8 * 1024 * 1024,
      allowedMimeTypes: [
        "application/pdf",
        "image/heic",
        "image/heif",
        "image/jpeg",
        "image/png",
        "image/webp",
      ],
    };
  }

  async listObjects(): Promise<readonly PostgresPrivateStorageObjectInfo[]> {
    this.listCallCount += 1;
    if (this.options.insertOnListCall === this.listCallCount) {
      this.values.set("late/insertion.pdf", {
        bytes: Buffer.from("%PDF-late-insertion", "utf8"),
        contentType: "application/pdf",
        id: "late-insertion-id",
        version: "late-insertion-version:1",
      });
    }
    return [...this.values.entries()]
      .sort(([left], [right]) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      )
      .map(([objectPath, object], index) => ({
        objectPath,
        bytes: object.bytes.length,
        contentType: object.contentType,
        storageObjectId: object.id,
        storageVersion:
          this.options.driftOnSecondList &&
          this.listCallCount === 2 &&
          index === 0
            ? `${object.version}:changed`
            : object.version,
      }));
  }

  async downloadObject(
    objectPath: string,
  ): Promise<PostgresPrivateStorageDownloadedObject> {
    const object = this.values.get(objectPath);
    if (!object) throw new Error("not_found");
    this.downloadCallCount += 1;
    const result = {
      bytes: Buffer.from(object.bytes),
      contentType: object.contentType,
      storageObjectId: object.id,
      storageVersion: object.version,
    };
    if (this.options.mutateAfterDownloadCall === this.downloadCallCount) {
      this.values.set(objectPath, {
        ...object,
        version: `${object.version}:late-change`,
      });
    }
    this.options.afterDownload?.(this.downloadCallCount, objectPath);
    return result;
  }

  async uploadImmutable(input: {
    readonly objectPath: string;
    readonly bytes: Buffer;
    readonly contentType: string;
  }): Promise<void> {
    if (this.options.failUploadPath === input.objectPath)
      throw new Error("upload_failed");
    if (this.values.has(input.objectPath)) throw new Error("already_exists");
    this.uploads.push(input.objectPath);
    this.values.set(input.objectPath, {
      bytes: Buffer.from(input.bytes),
      contentType: input.contentType,
      id: `destination-id:${input.objectPath}`,
      version: `destination-version:${input.objectPath}:1`,
    });
  }
}

function fixtureState(backupDirectory: string) {
  return parsePostgresLogicalSourceStateReceipt(
    fs.readFileSync(
      path.join(backupDirectory, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT),
    ),
  ).state;
}

function sourceSnapshot(
  backupDirectory: string,
  references: readonly PostgresPrivateStorageReference[] = [
    {
      objectPath: "accounts/evidence.pdf",
      mimeType: "application/pdf",
      byteSize: 17,
    },
  ],
  binding: Partial<Pick<
    PostgresPrivateStorageDatabaseSnapshot,
    "migrationRunSha256" | "sourceEnvironment" | "candidateSha"
  >> = {},
): PostgresPrivateStorageDatabaseSnapshot {
  return {
    connectionUrlSha256: "d".repeat(64),
    databaseIdentitySha256: LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256,
    migrationRunSha256:
      binding.migrationRunSha256 ?? MIGRATION_RUN_SHA256,
    sourceEnvironment: binding.sourceEnvironment ?? "production",
    candidateSha: binding.candidateSha ?? CANDIDATE_COMMIT_SHA,
    targetClass: null,
    state: fixtureState(backupDirectory),
    references,
  };
}

function targetSnapshot(
  backupDirectory: string,
  references: readonly PostgresPrivateStorageReference[] = [
    {
      objectPath: "accounts/evidence.pdf",
      mimeType: "application/pdf",
      byteSize: 17,
    },
  ],
): PostgresPrivateStorageDatabaseSnapshot {
  return {
    ...sourceSnapshot(backupDirectory, references),
    connectionUrlSha256: TARGET_CONNECTION_URL_SHA256,
    databaseIdentitySha256: TARGET_DATABASE_IDENTITY_SHA256,
    targetClass: "disposable-rehearsal",
  };
}

function sourceObjects() {
  return {
    "accounts/evidence.pdf": {
      bytes: Buffer.from("%PDF-recovery-set", "utf8"),
      contentType: "application/pdf",
    },
    "orphan/menu.webp": {
      bytes: Buffer.from("RIFF-recovery-orphan", "utf8"),
      contentType: "image/webp",
    },
  };
}

function captureHarness(
  root: string,
  storage = new MemoryStorage(SOURCE_ORIGIN, sourceObjects()),
  manifestSchemaVersion: 2 | 3 = 3,
) {
  const backup = writeLogicalOffsiteFixture(
    root,
    "2026-08-09T01:00:00.000Z",
    manifestSchemaVersion,
  );
  const authority = writeDeletionAuthority(root);
  const outputDirectory = path.join(root, "recovery-set");
  const options: CapturePostgresPrivateStorageRecoveryOptions = {
    backupDirectory: backup.backupDirectory,
    expectedBackupManifestSha256: backup.manifestSha256,
    deletionAuthorityDirectory: authority.directory,
    expectedLedgerCurrentSha256: authority.currentSha256,
    expectedLedgerGenesisSha256: authority.genesisSha256,
    expectedLedgerCheckpointSha256: authority.checkpointSha256,
    expectedLedgerImmutableSetSha256: authority.immutableSetSha256,
    expectedTombstoneCount: 1,
    sourceEnvironment: "production",
    expectedCandidateSha: CANDIDATE_COMMIT_SHA,
    expectedCaptureConnectionUrlSha256: "d".repeat(64),
    sourceSupabaseUrl: SOURCE_ORIGIN,
    expectedSourceOriginSha256: sha256(SOURCE_ORIGIN),
    bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
    expectedBucketNameSha256: sha256(POSTGRES_PRIVATE_STORAGE_BUCKET),
    outputDirectory,
    inspectSourceDatabase: async () => sourceSnapshot(backup.backupDirectory),
    sourceStorage: storage,
    now: () => new Date(CAPTURED_AT),
  };
  return { backup, authority, outputDirectory, options, storage };
}

async function capturedHarness(root: string) {
  const harness = captureHarness(root);
  const result = await capturePostgresPrivateStorageRecovery(harness.options);
  return { ...harness, result };
}

function restoreOptions(
  harness: Awaited<ReturnType<typeof capturedHarness>>,
  destinationStorage: MemoryStorage,
): RestorePostgresPrivateStorageRecoveryOptions {
  return {
    backupDirectory: harness.backup.backupDirectory,
    expectedBackupManifestSha256: harness.backup.manifestSha256,
    recoverySetDirectory: harness.outputDirectory,
    expectedRecoverySetSha256: harness.result.recoverySetSha256,
    expectedRecoveryManifestSha256: harness.result.recoveryManifestSha256,
    expectedTargetDatabaseIdentitySha256: TARGET_DATABASE_IDENTITY_SHA256,
    expectedTargetConnectionUrlSha256: TARGET_CONNECTION_URL_SHA256,
    destinationSupabaseUrl: destinationStorage.origin,
    expectedDestinationOriginSha256: sha256(destinationStorage.origin),
    forbiddenDestinationOriginSha256s: [
      sha256("https://production.supabase.co"),
    ],
    bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
    expectedBucketNameSha256: sha256(POSTGRES_PRIVATE_STORAGE_BUCKET),
    inspectTargetDatabase: async () =>
      targetSnapshot(harness.backup.backupDirectory),
    destinationStorage,
    now: () => new Date(RESTORED_AT),
  };
}

function rebindRecoverySetToLogicalBackup(
  recoverySetDirectory: string,
  backup: ReturnType<typeof writeLogicalOffsiteFixture>,
): {
  readonly recoverySetSha256: string;
  readonly recoveryManifestSha256: string;
} {
  const manifestPath = path.join(
    recoverySetDirectory,
    POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST,
  );
  const current = postgresPrivateStorageRecoveryInternals.parseRecoveryManifest(
    fs.readFileSync(manifestPath),
  );
  const { recoverySetSha256: _previousBinding, ...withoutBinding } = current;
  const reboundWithoutBinding = {
    ...withoutBinding,
    logicalBackup: {
      ...withoutBinding.logicalBackup,
      manifestSha256: backup.manifestSha256,
      archiveSha256: backup.archiveSha256,
      stateReceiptSha256: backup.receiptSha256,
      sourceDatabaseIdentitySha256:
        backup.manifest.state.sourceDatabaseIdentitySha256,
      sourceUrlSha256: backup.manifest.state.sourceUrlSha256,
      overallStateSha256: backup.manifest.state.overallStateSha256,
    },
  };
  const recoverySetSha256 = postgresPrivateStorageRecoveryInternals
    .recoverySetBinding(reboundWithoutBinding);
  const rebound = {
    ...reboundWithoutBinding,
    recoverySetSha256,
  };
  const bytes = Buffer.from(canonicalPostgresBackupJson(rebound), "utf8");
  writePrivate(manifestPath, bytes);
  return {
    recoverySetSha256,
    recoveryManifestSha256: sha256(bytes),
  };
}

describe("Postgres private Storage recovery sets", () => {
  it("captures the full private bucket and restores it exactly to an empty distinct destination", async () => {
    const root = privateRoot();
    const harness = await capturedHarness(root);
    expect(harness.backup.manifest.schemaVersion).toBe(3);
    expect(harness.result).toMatchObject({
      ok: true,
      storageObjectCount: 2,
      databaseReferenceCount: 1,
      deletionTombstoneCount: 1,
    });
    expect(fs.statSync(harness.outputDirectory).mode & 0o777).toBe(0o700);
    const manifestPath = path.join(
      harness.outputDirectory,
      POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST,
    );
    expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest =
      postgresPrivateStorageRecoveryInternals.parseRecoveryManifest(
        manifestBytes,
      );
    expect(manifest).toMatchObject({
      version: POSTGRES_PRIVATE_STORAGE_RECOVERY_VERSION,
      logicalBackup: {
        migrationRunSha256: MIGRATION_RUN_SHA256,
        sourceEnvironment: "production",
        candidateSha: CANDIDATE_COMMIT_SHA,
      },
    });
    expect(manifest.sourceStorage).toMatchObject({
      objectCount: 2,
      databaseReferenceCount: 1,
      orphanObjectCount: 1,
    });
    expect(
      manifest.sourceStorage.objects.map((object) => [
        object.objectPath,
        object.referencedByDatabase,
      ]),
    ).toEqual([
      ["accounts/evidence.pdf", true],
      ["orphan/menu.webp", false],
    ]);
    expect(Buffer.from(canonicalPostgresBackupJson(manifest), "utf8")).toEqual(
      manifestBytes,
    );

    const destination = new MemoryStorage(DESTINATION_ORIGIN, {});
    const restored = await restorePostgresPrivateStorageRecovery(
      restoreOptions(harness, destination),
    );
    expect(restored).toMatchObject({
      ok: true,
      restoredObjectCount: 2,
      recoverySetSha256: harness.result.recoverySetSha256,
      recoveryManifestSha256: harness.result.recoveryManifestSha256,
    });
    expect(destination.uploads).toEqual([
      "accounts/evidence.pdf",
      "orphan/menu.webp",
    ]);
    expect(
      await destination.downloadObject("accounts/evidence.pdf"),
    ).toMatchObject({
      bytes: sourceObjects()["accounts/evidence.pdf"].bytes,
      contentType: "application/pdf",
    });
  });

  it("rejects a valid schema-v2 backup before any source Storage call", async () => {
    const root = privateRoot();
    const storage = new MemoryStorage(SOURCE_ORIGIN, sourceObjects());
    const inspectBucket = vi.spyOn(storage, "inspectBucket");
    const listObjects = vi.spyOn(storage, "listObjects");
    const downloadObject = vi.spyOn(storage, "downloadObject");
    const harness = captureHarness(root, storage, 2);
    await expect(capturePostgresPrivateStorageRecovery(harness.options))
      .rejects.toEqual(new PostgresPrivateStorageRecoveryError("backup_invalid"));
    expect(inspectBucket).not.toHaveBeenCalled();
    expect(listObjects).not.toHaveBeenCalled();
    expect(downloadObject).not.toHaveBeenCalled();
    expect(fs.existsSync(harness.outputDirectory)).toBe(false);
  });

  it("rejects an independently expected candidate mismatch before source Storage I/O", async () => {
    const root = privateRoot();
    const storage = new MemoryStorage(SOURCE_ORIGIN, sourceObjects());
    const inspectBucket = vi.spyOn(storage, "inspectBucket");
    const listObjects = vi.spyOn(storage, "listObjects");
    const downloadObject = vi.spyOn(storage, "downloadObject");
    const harness = captureHarness(root, storage);

    await expect(capturePostgresPrivateStorageRecovery({
      ...harness.options,
      expectedCandidateSha: "d".repeat(40),
    })).rejects.toMatchObject({ code: "source_database_mismatch" });
    expect(inspectBucket).not.toHaveBeenCalled();
    expect(listObjects).not.toHaveBeenCalled();
    expect(downloadObject).not.toHaveBeenCalled();
    expect(fs.existsSync(harness.outputDirectory)).toBe(false);
  });

  it("rejects a capture credential pinned to a different physical database before Storage I/O", async () => {
    const root = privateRoot();
    const storage = new MemoryStorage(SOURCE_ORIGIN, sourceObjects());
    const listObjects = vi.spyOn(storage, "listObjects");
    const harness = captureHarness(root, storage);

    await expect(capturePostgresPrivateStorageRecovery({
      ...harness.options,
      expectedCaptureConnectionUrlSha256: "e".repeat(64),
    })).rejects.toMatchObject({ code: "source_database_mismatch" });
    expect(listObjects).not.toHaveBeenCalled();
    expect(fs.existsSync(harness.outputDirectory)).toBe(false);
  });

  it("rejects a production database paired with permanent-staging Storage before source Storage I/O", async () => {
    const root = privateRoot();
    const storage = new MemoryStorage(STAGING_SOURCE_ORIGIN, sourceObjects());
    const inspectBucket = vi.spyOn(storage, "inspectBucket");
    const listObjects = vi.spyOn(storage, "listObjects");
    const downloadObject = vi.spyOn(storage, "downloadObject");
    const harness = captureHarness(root, storage);

    await expect(capturePostgresPrivateStorageRecovery({
      ...harness.options,
      sourceEnvironment: "permanent-staging",
      sourceSupabaseUrl: STAGING_SOURCE_ORIGIN,
      expectedSourceOriginSha256: sha256(STAGING_SOURCE_ORIGIN),
      sourceStorage: storage,
    })).rejects.toMatchObject({ code: "source_database_mismatch" });
    expect(inspectBucket).not.toHaveBeenCalled();
    expect(listObjects).not.toHaveBeenCalled();
    expect(downloadObject).not.toHaveBeenCalled();
    expect(fs.existsSync(harness.outputDirectory)).toBe(false);
  });

  it.each([
    `${SOURCE_ORIGIN}/`,
    SOURCE_ORIGIN.toUpperCase(),
    `${SOURCE_ORIGIN}:443`,
  ])("rejects normalized source-origin variant %s before source Storage I/O", async (sourceSupabaseUrl) => {
    const root = privateRoot();
    const storage = new MemoryStorage(SOURCE_ORIGIN, sourceObjects());
    const inspectBucket = vi.spyOn(storage, "inspectBucket");
    const listObjects = vi.spyOn(storage, "listObjects");
    const downloadObject = vi.spyOn(storage, "downloadObject");
    const harness = captureHarness(root, storage);

    await expect(capturePostgresPrivateStorageRecovery({
      ...harness.options,
      sourceSupabaseUrl,
    })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(inspectBucket).not.toHaveBeenCalled();
    expect(listObjects).not.toHaveBeenCalled();
    expect(downloadObject).not.toHaveBeenCalled();
    expect(fs.existsSync(harness.outputDirectory)).toBe(false);
  });

  it("rejects migration-run drift between the two database inspections", async () => {
    const root = privateRoot();
    const storage = new MemoryStorage(SOURCE_ORIGIN, sourceObjects());
    const listObjects = vi.spyOn(storage, "listObjects");
    const harness = captureHarness(root, storage);
    let inspection = 0;

    await expect(capturePostgresPrivateStorageRecovery({
      ...harness.options,
      inspectSourceDatabase: async () => {
        inspection += 1;
        return sourceSnapshot(
          harness.backup.backupDirectory,
          undefined,
          inspection === 1
            ? {}
            : { migrationRunSha256: "4".repeat(64) },
        );
      },
    })).rejects.toMatchObject({ code: "source_database_mismatch" });
    expect(listObjects).toHaveBeenCalledTimes(1);
    expect(
      fs.existsSync(path.join(
        harness.outputDirectory,
        POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST,
      )),
    ).toBe(false);
  });

  it("rejects legacy-version and authority-field manifest tampering", async () => {
    const root = privateRoot();
    const harness = await capturedHarness(root);
    const manifestPath = path.join(
      harness.outputDirectory,
      POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST,
    );
    const manifest = postgresPrivateStorageRecoveryInternals.parseRecoveryManifest(
      fs.readFileSync(manifestPath),
    );
    const { recoverySetSha256: _binding, ...withoutBinding } = manifest;
    const legacyBinding = sha256(canonicalPostgresBackupJson({
      bindingKind: "pintpath-postgres-private-storage-recovery-set-binding",
      bindingVersion: 1,
      ...withoutBinding,
    }));
    expect(manifest.recoverySetSha256).not.toBe(legacyBinding);

    for (const tampered of [
      { ...manifest, version: 1 },
      {
        ...manifest,
        logicalBackup: {
          ...manifest.logicalBackup,
          sourceEnvironment: "permanent-staging",
        },
      },
      {
        ...manifest,
        logicalBackup: {
          ...manifest.logicalBackup,
          candidateSha: "d".repeat(40),
        },
      },
    ]) {
      expect(() => postgresPrivateStorageRecoveryInternals.parseRecoveryManifest(
        Buffer.from(canonicalPostgresBackupJson(tampered), "utf8"),
      )).toThrow(expect.objectContaining({ code: "recovery_set_invalid" }));
    }

    const crossPairedWithoutBinding = {
      ...withoutBinding,
      logicalBackup: {
        ...withoutBinding.logicalBackup,
        sourceEnvironment: "permanent-staging" as const,
      },
    };
    const crossPaired = {
      ...crossPairedWithoutBinding,
      recoverySetSha256: postgresPrivateStorageRecoveryInternals
        .recoverySetBinding(crossPairedWithoutBinding),
    };
    expect(() => postgresPrivateStorageRecoveryInternals.parseRecoveryManifest(
      Buffer.from(canonicalPostgresBackupJson(crossPaired), "utf8"),
    )).toThrow(expect.objectContaining({ code: "recovery_set_invalid" }));
  });

  it("restores a frozen schema-v2 logical backup and matching historical recovery set", async () => {
    const root = privateRoot();
    const captured = await capturedHarness(root);
    const legacyRoot = privateRoot();
    const legacyBackup = writeLogicalOffsiteFixture(
      legacyRoot,
      "2026-08-09T01:00:00.000Z",
      2,
    );
    const rebound = rebindRecoverySetToLogicalBackup(
      captured.outputDirectory,
      legacyBackup,
    );
    const historical = {
      ...captured,
      backup: legacyBackup,
      result: { ...captured.result, ...rebound },
    };
    const destination = new MemoryStorage(DESTINATION_ORIGIN, {});
    await expect(restorePostgresPrivateStorageRecovery(
      restoreOptions(historical, destination),
    )).resolves.toMatchObject({
      schemaVersion: 1,
      ok: true,
      recoverySetSha256: rebound.recoverySetSha256,
      recoveryManifestSha256: rebound.recoveryManifestSha256,
    });
    expect(destination.uploads).toContain("accounts/evidence.pdf");
  });

  it("rejects source inventory drift and preserves the unpinned partial output for forensics", async () => {
    const root = privateRoot();
    const storage = new MemoryStorage(SOURCE_ORIGIN, sourceObjects(), {
      driftOnSecondList: true,
    });
    const harness = captureHarness(root, storage);
    await expect(
      capturePostgresPrivateStorageRecovery(harness.options),
    ).rejects.toMatchObject({
      code: "source_storage_changed",
    });
    expect(fs.existsSync(harness.outputDirectory)).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          harness.outputDirectory,
          POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST,
        ),
      ),
    ).toBe(false);
  });

  it("rejects a live Postgres reference whose strict size does not match Storage", async () => {
    const root = privateRoot();
    const harness = captureHarness(root);
    const options: CapturePostgresPrivateStorageRecoveryOptions = {
      ...harness.options,
      inspectSourceDatabase: async () =>
        sourceSnapshot(harness.backup.backupDirectory, [
          {
            objectPath: "accounts/evidence.pdf",
            mimeType: "application/pdf",
            byteSize: 999,
          },
        ]),
    };
    await expect(
      capturePostgresPrivateStorageRecovery(options),
    ).rejects.toMatchObject({
      code: "reference_reconciliation_failed",
    });
    expect(fs.existsSync(harness.outputDirectory)).toBe(false);
  });

  it("rejects non-canonical MIME metadata instead of normalizing it silently", async () => {
    const root = privateRoot();
    const harness = captureHarness(root);
    const options: CapturePostgresPrivateStorageRecoveryOptions = {
      ...harness.options,
      inspectSourceDatabase: async () =>
        sourceSnapshot(harness.backup.backupDirectory, [
          {
            objectPath: "accounts/evidence.pdf",
            mimeType: "APPLICATION/PDF; charset=binary",
            byteSize: 17,
          },
        ]),
    };
    await expect(
      capturePostgresPrivateStorageRecovery(options),
    ).rejects.toMatchObject({
      code: "reference_reconciliation_failed",
    });
    expect(fs.existsSync(harness.outputDirectory)).toBe(false);
  });

  it("detects recovery object tampering before any destination mutation", async () => {
    const root = privateRoot();
    const harness = await capturedHarness(root);
    const objectPath = path.join(
      harness.outputDirectory,
      POSTGRES_PRIVATE_STORAGE_RECOVERY_OBJECTS,
      ...postgresPrivateStorageRecoveryInternals
        .recoveryObjectRelativePath("accounts/evidence.pdf")
        .split("/"),
    );
    writePrivate(objectPath, Buffer.from("tampered", "utf8"));
    const destination = new MemoryStorage(DESTINATION_ORIGIN, {});
    await expect(
      restorePostgresPrivateStorageRecovery(
        restoreOptions(harness, destination),
      ),
    ).rejects.toMatchObject({ code: "recovery_set_tampered" });
    expect(destination.uploads).toEqual([]);
  });

  it("refuses a non-empty destination before upload", async () => {
    const root = privateRoot();
    const harness = await capturedHarness(root);
    const destination = new MemoryStorage(DESTINATION_ORIGIN, {
      "existing/object.pdf": {
        bytes: Buffer.from("%PDF-existing", "utf8"),
        contentType: "application/pdf",
      },
    });
    await expect(
      restorePostgresPrivateStorageRecovery(
        restoreOptions(harness, destination),
      ),
    ).rejects.toMatchObject({ code: "destination_not_empty" });
    expect(destination.uploads).toEqual([]);
  });

  it("seals a post-upload failure as disposal-required", async () => {
    const root = privateRoot();
    const harness = await capturedHarness(root);
    const destination = new MemoryStorage(
      DESTINATION_ORIGIN,
      {},
      {
        failUploadPath: "orphan/menu.webp",
      },
    );
    await expect(
      restorePostgresPrivateStorageRecovery(
        restoreOptions(harness, destination),
      ),
    ).rejects.toEqual(
      new PostgresPrivateStorageRecoveryError(
        "destination_upload_failed_disposal_required",
      ),
    );
    expect(destination.uploads).toEqual(["accounts/evidence.pdf"]);
  });

  it("rejects a destination object changed after its later readback", async () => {
    const root = privateRoot();
    const harness = await capturedHarness(root);
    const destination = new MemoryStorage(
      DESTINATION_ORIGIN,
      {},
      {
        mutateAfterDownloadCall: 4,
      },
    );
    await expect(
      restorePostgresPrivateStorageRecovery(
        restoreOptions(harness, destination),
      ),
    ).rejects.toMatchObject({
      code: "destination_verification_failed_disposal_required",
    });
    expect(destination.uploads).toHaveLength(2);
  });

  it("re-fences the exact local recovery tree before restore success", async () => {
    const root = privateRoot();
    const harness = await capturedHarness(root);
    const destination = new MemoryStorage(
      DESTINATION_ORIGIN,
      {},
      {
        afterDownload: (call) => {
          if (call === 4) {
            fs.mkdirSync(
              path.join(
                harness.outputDirectory,
                POSTGRES_PRIVATE_STORAGE_RECOVERY_OBJECTS,
                "zz",
              ),
              { mode: 0o700 },
            );
          }
        },
      },
    );
    await expect(
      restorePostgresPrivateStorageRecovery(
        restoreOptions(harness, destination),
      ),
    ).rejects.toMatchObject({
      code: "destination_verification_failed_disposal_required",
    });
  });

  it("rejects an empty-set late insertion without ordering disposal of an untouched target", async () => {
    const root = privateRoot();
    const sourceStorage = new MemoryStorage(SOURCE_ORIGIN, {});
    const harness = captureHarness(root, sourceStorage);
    const captureOptions: CapturePostgresPrivateStorageRecoveryOptions = {
      ...harness.options,
      inspectSourceDatabase: async () =>
        sourceSnapshot(harness.backup.backupDirectory, []),
    };
    const result = await capturePostgresPrivateStorageRecovery(captureOptions);
    const captured = { ...harness, result };
    const destination = new MemoryStorage(
      DESTINATION_ORIGIN,
      {},
      { insertOnListCall: 3 },
    );
    const options: RestorePostgresPrivateStorageRecoveryOptions = {
      ...restoreOptions(captured, destination),
      inspectTargetDatabase: async () =>
        targetSnapshot(harness.backup.backupDirectory, []),
    };
    await expect(
      restorePostgresPrivateStorageRecovery(options),
    ).rejects.toMatchObject({
      code: "destination_bucket_invalid",
    });
    expect(destination.uploads).toEqual([]);
  });

  it("rejects a destination equal to the captured source before inspection or upload", async () => {
    const root = privateRoot();
    const harness = await capturedHarness(root);
    const destination = new MemoryStorage(SOURCE_ORIGIN, {});
    const inspectTargetDatabase = vi.fn(async () =>
      targetSnapshot(harness.backup.backupDirectory),
    );
    await expect(
      restorePostgresPrivateStorageRecovery({
        ...restoreOptions(harness, destination),
        inspectTargetDatabase,
      }),
    ).rejects.toMatchObject({ code: "destination_not_distinct" });
    expect(inspectTargetDatabase).not.toHaveBeenCalled();
    expect(destination.uploads).toEqual([]);
  });
});

describe("Postgres private Storage recovery restore CLI", () => {
  it("fails closed without the exact restore confirmation and emits no secret material", async () => {
    let output = "";
    const exitCode = await runPostgresPrivateStorageRestoreCli([], {
      environment: {},
      writeOutput: (value) => {
        output += value;
      },
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-restore",
      ok: false,
      failureCode: "invalid_arguments",
      destinationDisposalRequired: false,
    });
    expect(output).not.toContain("service-role");
  });

  it("reports the confirmation gate after strict arguments pass", async () => {
    const argumentsByName = [
      ...[
        "--backup-directory",
        "--backup-manifest-sha256",
        "--bucket-name-sha256",
        "--destination-origin-sha256",
        "--destination-authority-file",
        "--destination-authority-sha256",
        "--destination-authority-public-key-file",
        "--destination-authority-public-key-sha256",
        "--expected-candidate-sha",
        "--forbidden-origin-sha256s",
        "--recovery-manifest-sha256",
        "--recovery-set-directory",
        "--recovery-set-sha256",
        "--service-role-key-file",
        "--target-connection-url-file",
        "--root-ca-file",
        "--expected-root-ca-der-sha256",
        "--target-connection-url-sha256",
        "--target-database-identity-sha256",
        "--target-railway-project-id",
        "--target-railway-environment-id",
      ],
    ].flatMap((name) => [
      name,
      name.includes("sha256") ? "a".repeat(64)
        : name === "--target-railway-project-id"
            ? "11111111-1111-4111-8111-111111111111"
            : name === "--target-railway-environment-id"
              ? "22222222-2222-4222-8222-222222222222"
              : "/private/input",
    ]);
    let output = "";
    const exitCode = await runPostgresPrivateStorageRestoreCli(
      argumentsByName,
      {
        environment: {
          [POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_ENV]: "wrong",
        },
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      failureCode: "confirmation_required",
      destinationDisposalRequired: false,
    });
    expect(POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_VALUE).toBe(
      "confirmed",
    );
  });

  it("blocks an unsigned disposable destination before reading database or Storage secrets", async () => {
    const names = [
      "--backup-directory",
      "--backup-manifest-sha256",
      "--bucket-name-sha256",
      "--destination-origin-sha256",
      "--destination-authority-file",
      "--destination-authority-sha256",
      "--destination-authority-public-key-file",
      "--destination-authority-public-key-sha256",
      "--expected-candidate-sha",
      "--forbidden-origin-sha256s",
      "--recovery-manifest-sha256",
      "--recovery-set-directory",
      "--recovery-set-sha256",
      "--service-role-key-file",
      "--target-connection-url-file",
      "--root-ca-file",
      "--expected-root-ca-der-sha256",
      "--target-connection-url-sha256",
      "--target-database-identity-sha256",
      "--target-railway-project-id",
      "--target-railway-environment-id",
    ];
    const argv = names.flatMap((name) => [
      name,
      name === "--forbidden-origin-sha256s"
        ? "b".repeat(64)
        : name === "--expected-candidate-sha"
          ? CANDIDATE_COMMIT_SHA
        : name === "--target-railway-project-id"
          ? "11111111-1111-4111-8111-111111111111"
        : name === "--target-railway-environment-id"
          ? "22222222-2222-4222-8222-222222222222"
        : name.includes("sha256")
          ? "a".repeat(64)
          : "/private/input",
    ]);
    argv[argv.indexOf("--target-connection-url-file") + 1] = "/private/connection";
    const readSecretFile = vi.fn(async () => "must-not-be-read");
    let output = "";
    const exitCode = await runPostgresPrivateStorageRestoreCli(argv, {
      environment: {
        [POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_ENV]:
          POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_VALUE,
        RESTORE_SUPABASE_URL: DESTINATION_ORIGIN,
      },
      readSecretFile,
      assertMutationAllowed: () => undefined,
      writeOutput: (value) => {
        output += value;
      },
    });
    expect(exitCode).toBe(1);
    expect(readSecretFile).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output)).toMatchObject({
      failureCode: "configuration_missing_or_unsafe",
      destinationDisposalRequired: false,
    });
    expect(output).not.toContain("must-not-be-read");
  });

  it("marks every post-upload library failure as requiring destination disposal", async () => {
    const fixture = restoreCliAuthorityFixture();
    let output = "";
    const exitCode = await runPostgresPrivateStorageRestoreCli(fixture.argv, {
      environment: {
        [POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_ENV]:
          POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_VALUE,
        RESTORE_SUPABASE_URL: DESTINATION_ORIGIN,
      },
      assertDestinationOriginApproved: (origin) => {
        expect(origin).toBe(DESTINATION_ORIGIN);
      },
      now: () => AUTHORITY_NOW,
      readSecretFile: async (filePath) =>
        filePath.endsWith("destination-authority.json")
          ? fixture.authoritySource
          : filePath.endsWith("destination-authority.pem")
            ? fixture.publicKeyPem
            : filePath.includes("connection")
          ? "postgresql://backup:secret@postgres.railway.internal:5432/pintpath?sslmode=verify-full"
          : SERVICE_ROLE_KEY,
      openDatabaseTransport: async (options) => fakeDatabaseTransport(options),
      createInspector: () => async () => {
        throw new Error("unused");
      },
      createStorage: () => new MemoryStorage(DESTINATION_ORIGIN, {}),
      restore: async () => {
        throw new PostgresPrivateStorageRecoveryError(
          "destination_verification_failed_disposal_required",
        );
      },
      assertMutationAllowed: () => undefined,
      writeOutput: (value) => {
        output += value;
      },
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      failureCode: "destination_verification_failed_disposal_required",
      destinationDisposalRequired: true,
    });
    expect(output).not.toContain(SERVICE_ROLE_KEY);
  });

  it("emits authenticated transport, migrator-role, and signed destination bindings on success", async () => {
    const fixture = restoreCliAuthorityFixture();
    let output = "";
    const exitCode = await runPostgresPrivateStorageRestoreCli(fixture.argv, {
      environment: {
        [POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_ENV]:
          POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_VALUE,
        RESTORE_SUPABASE_URL: DESTINATION_ORIGIN,
      },
      now: () => AUTHORITY_NOW,
      readSecretFile: async (filePath) =>
        filePath.endsWith("destination-authority.json")
          ? fixture.authoritySource
          : filePath.endsWith("destination-authority.pem")
            ? fixture.publicKeyPem
            : filePath.includes("connection")
              ? "postgresql://backup:secret@postgres.railway.internal:5432/pintpath?sslmode=verify-full"
              : SERVICE_ROLE_KEY,
      openDatabaseTransport: async (options) => fakeDatabaseTransport(options),
      createInspector: () => async () => { throw new Error("unused"); },
      createStorage: () => new MemoryStorage(DESTINATION_ORIGIN, {}),
      restore: async () => ({
        schemaVersion: 1,
        kind: "pintpath-postgres-private-storage-recovery-restore",
        ok: true,
        restoredAt: RESTORED_AT,
        targetDatabaseIdentitySha256: TARGET_DATABASE_IDENTITY_SHA256,
        recoverySetSha256: "2".repeat(64),
        recoveryManifestSha256: "3".repeat(64),
        restoredObjectCount: 2,
        restoredBytes: "42",
        destinationObjectSetSha256: "4".repeat(64),
        deletionAuthoritySetSha256: "5".repeat(64),
      }),
      assertMutationAllowed: () => undefined,
      writeOutput: (value) => { output += value; },
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      databaseTransportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      databaseTransportRootCaDerSha256: "a".repeat(64),
      databaseEffectiveRole: "pintpath_migrator",
      destinationAuthoritySha256: sha256(fixture.authoritySource),
      destinationAuthorityPublicKeySha256: sha256(fixture.publicKeyPem),
      destinationAuthorityReviewerIdSha256: "9".repeat(64),
    });
  });
});

describe("Postgres private Storage recovery capture CLI", () => {
  it("rejects incomplete strict arguments before reading either secret", async () => {
    let output = "";
    const readSecretFile = vi.fn(async () => "must-not-be-read");
    const exitCode = await runPostgresPrivateStorageCaptureCli([], {
      readSecretFile,
      writeOutput: (value) => {
        output += value;
      },
    });
    expect(exitCode).toBe(1);
    expect(readSecretFile).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      failureCode: "invalid_arguments",
    });
    expect(output).not.toContain("must-not-be-read");
  });

  it("applies the operator guard before reading secrets", async () => {
    const names = [
      "--backup-directory",
      "--backup-manifest-sha256",
      "--bucket-name-sha256",
      "--connection-url-file",
      "--root-ca-file",
      "--expected-root-ca-der-sha256",
      "--connection-url-sha256",
      "--deletion-authority-directory",
      "--expected-candidate-sha",
      "--ledger-checkpoint-sha256",
      "--ledger-current-sha256",
      "--ledger-genesis-sha256",
      "--ledger-immutable-set-sha256",
      "--ledger-tombstone-count",
      "--output-directory",
      "--service-role-key-file",
      "--source-environment",
      "--source-origin-sha256",
    ];
    const argv = names.flatMap((name) => [
      name,
      name === "--ledger-tombstone-count"
        ? "1"
        : name === "--source-environment"
          ? "permanent-staging"
          : name === "--expected-candidate-sha"
            ? CANDIDATE_COMMIT_SHA
            : name === "--source-origin-sha256"
              ? sha256(STAGING_SOURCE_ORIGIN)
        : name.includes("sha256")
          ? "a".repeat(64)
          : "/private/input",
    ]);
    let output = "";
    const readSecretFile = vi.fn(async () => "must-not-be-read");
    const exitCode = await runPostgresPrivateStorageCaptureCli(argv, {
      readSecretFile,
      assertMutationAllowed: () => {
        throw new Error("guarded");
      },
      writeOutput: (value) => {
        output += value;
      },
    });
    expect(exitCode).toBe(1);
    expect(readSecretFile).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      failureCode: "operator_guard_rejected",
    });
    expect(output).not.toContain("must-not-be-read");
  });

  it("requires absolute canonical secret paths before reading either secret", async () => {
    const names = [
      "--backup-directory",
      "--backup-manifest-sha256",
      "--bucket-name-sha256",
      "--connection-url-file",
      "--root-ca-file",
      "--expected-root-ca-der-sha256",
      "--connection-url-sha256",
      "--deletion-authority-directory",
      "--expected-candidate-sha",
      "--ledger-checkpoint-sha256",
      "--ledger-current-sha256",
      "--ledger-genesis-sha256",
      "--ledger-immutable-set-sha256",
      "--ledger-tombstone-count",
      "--output-directory",
      "--service-role-key-file",
      "--source-environment",
      "--source-origin-sha256",
    ];
    const argv = names.flatMap((name) => [
      name,
      name === "--ledger-tombstone-count"
        ? "1"
        : name === "--service-role-key-file"
          ? "relative.key"
          : name === "--source-environment"
            ? "permanent-staging"
            : name === "--expected-candidate-sha"
              ? CANDIDATE_COMMIT_SHA
              : name === "--source-origin-sha256"
                ? sha256(STAGING_SOURCE_ORIGIN)
          : name.includes("sha256")
            ? "a".repeat(64)
            : "/private/input",
    ]);
    const readSecretFile = vi.fn(async () => "must-not-be-read");
    let output = "";
    const exitCode = await runPostgresPrivateStorageCaptureCli(argv, {
      readSecretFile,
      assertMutationAllowed: () => undefined,
      writeOutput: (value) => {
        output += value;
      },
    });
    expect(exitCode).toBe(1);
    expect(readSecretFile).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      failureCode: "configuration_missing_or_unsafe",
    });
  });

  it.each([
    [
      "an unreviewed canonical source origin",
      "permanent-staging",
      "https://abcdefghijklmnopqrst.supabase.co",
      CANDIDATE_COMMIT_SHA,
      "configuration_missing_or_unsafe",
    ],
    [
      "a production environment paired with permanent-staging Storage",
      "production",
      STAGING_SOURCE_ORIGIN,
      CANDIDATE_COMMIT_SHA,
      "configuration_missing_or_unsafe",
    ],
    [
      "a non-canonical independently expected candidate",
      "permanent-staging",
      STAGING_SOURCE_ORIGIN,
      CANDIDATE_COMMIT_SHA.toUpperCase(),
      "invalid_arguments",
    ],
  ] as const)("rejects %s before reading either secret", async (
    _label,
    sourceEnvironment,
    sourceOrigin,
    candidateSha,
    expectedFailureCode,
  ) => {
    const names = [
      "--backup-directory",
      "--backup-manifest-sha256",
      "--bucket-name-sha256",
      "--connection-url-file",
      "--root-ca-file",
      "--expected-root-ca-der-sha256",
      "--connection-url-sha256",
      "--deletion-authority-directory",
      "--expected-candidate-sha",
      "--ledger-checkpoint-sha256",
      "--ledger-current-sha256",
      "--ledger-genesis-sha256",
      "--ledger-immutable-set-sha256",
      "--ledger-tombstone-count",
      "--output-directory",
      "--service-role-key-file",
      "--source-environment",
      "--source-origin-sha256",
    ];
    const argv = names.flatMap((name) => [
      name,
      name === "--ledger-tombstone-count"
        ? "1"
      : name === "--source-environment"
          ? sourceEnvironment
          : name === "--expected-candidate-sha"
            ? candidateSha
            : name === "--source-origin-sha256"
              ? sha256(
                  sourceEnvironment === "permanent-staging"
                    ? STAGING_SOURCE_ORIGIN
                    : SOURCE_ORIGIN,
                )
        : name.includes("sha256")
          ? "a".repeat(64)
          : "/private/input",
    ]);
    const readSecretFile = vi.fn(async () => "must-not-be-read");
    let output = "";
    const exitCode = await runPostgresPrivateStorageCaptureCli(argv, {
      environment: { SUPABASE_URL: sourceOrigin },
      readSecretFile,
      assertMutationAllowed: () => undefined,
      writeOutput: (value) => {
        output += value;
      },
    });
    expect(exitCode).toBe(1);
    expect(readSecretFile).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      failureCode: expectedFailureCode,
    });
  });

  it.each([
    `sb_publishable_${"p".repeat(32)}`,
    `${SERVICE_ROLE_KEY}\n`,
    "arbitrary-service-role-value",
  ])("rejects an unsafe source server key before constructing Storage", async (key) => {
    const names = [
      "--backup-directory",
      "--backup-manifest-sha256",
      "--bucket-name-sha256",
      "--connection-url-file",
      "--root-ca-file",
      "--expected-root-ca-der-sha256",
      "--connection-url-sha256",
      "--deletion-authority-directory",
      "--expected-candidate-sha",
      "--ledger-checkpoint-sha256",
      "--ledger-current-sha256",
      "--ledger-genesis-sha256",
      "--ledger-immutable-set-sha256",
      "--ledger-tombstone-count",
      "--output-directory",
      "--service-role-key-file",
      "--source-environment",
      "--source-origin-sha256",
    ];
    const argv = names.flatMap((name) => [
      name,
      name === "--ledger-tombstone-count"
        ? "1"
        : name === "--source-environment"
          ? "permanent-staging"
          : name === "--expected-candidate-sha"
            ? CANDIDATE_COMMIT_SHA
            : name === "--source-origin-sha256"
              ? sha256(STAGING_SOURCE_ORIGIN)
        : name.includes("sha256")
          ? "a".repeat(64)
          : "/private/input",
    ]);
    const createStorage = vi.fn();
    let output = "";
    const exitCode = await runPostgresPrivateStorageCaptureCli(argv, {
      environment: { SUPABASE_URL: STAGING_SOURCE_ORIGIN },
      readSecretFile: async (filePath) =>
        filePath.includes("connection")
          ? "postgresql://backup:secret@postgres.railway.internal:5432/pintpath?sslmode=verify-full"
          : key,
      createStorage,
      assertMutationAllowed: () => undefined,
      writeOutput: (value) => {
        output += value;
      },
    });
    expect(exitCode).toBe(1);
    expect(createStorage).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      failureCode: "secret_file_unsafe",
    });
    expect(output).not.toContain(key);
  });

  it("passes only pinned inputs to capture and emits a hash-only canonical result", async () => {
    const names = [
      "--backup-directory",
      "--backup-manifest-sha256",
      "--bucket-name-sha256",
      "--connection-url-file",
      "--root-ca-file",
      "--expected-root-ca-der-sha256",
      "--connection-url-sha256",
      "--deletion-authority-directory",
      "--expected-candidate-sha",
      "--ledger-checkpoint-sha256",
      "--ledger-current-sha256",
      "--ledger-genesis-sha256",
      "--ledger-immutable-set-sha256",
      "--ledger-tombstone-count",
      "--output-directory",
      "--service-role-key-file",
      "--source-environment",
      "--source-origin-sha256",
    ];
    const argv = names.flatMap((name) => [
      name,
      name === "--ledger-tombstone-count"
        ? "1"
        : name === "--source-environment"
          ? "permanent-staging"
          : name === "--expected-candidate-sha"
            ? CANDIDATE_COMMIT_SHA
            : name === "--source-origin-sha256"
              ? sha256(STAGING_SOURCE_ORIGIN)
        : name.includes("sha256")
          ? "a".repeat(64)
          : "/private/input",
    ]);
    argv[argv.indexOf("--connection-url-file") + 1] = "/private/connection";
    let output = "";
    let capturedOptions: CapturePostgresPrivateStorageRecoveryOptions | null =
      null;
    const exitCode = await runPostgresPrivateStorageCaptureCli(argv, {
      environment: { SUPABASE_URL: STAGING_SOURCE_ORIGIN },
      readSecretFile: async (filePath) =>
        filePath.includes("connection")
          ? "postgresql://backup:secret@postgres.railway.internal:5432/pintpath?sslmode=verify-full"
          : SERVICE_ROLE_KEY,
      openDatabaseTransport: async (options) => fakeDatabaseTransport(options),
      createInspector: (input) => {
        expect(input).toMatchObject({
          expectedSourceEnvironment: "permanent-staging",
          expectedCandidateSha: CANDIDATE_COMMIT_SHA,
        });
        return async () => {
          throw new Error("unused");
        };
      },
      createStorage: (input) => {
        expect(input.supabaseUrl).toBe(STAGING_SOURCE_ORIGIN);
        expect(input.sourceEnvironment).toBe("permanent-staging");
        return new MemoryStorage(STAGING_SOURCE_ORIGIN, {});
      },
      capture: async (options) => {
        capturedOptions = options;
        return {
          schemaVersion: 1,
          kind: "pintpath-postgres-private-storage-recovery-capture",
          ok: true,
          capturedAt: CAPTURED_AT,
          logicalBackupManifestSha256: "1".repeat(64),
          storageObjectCount: 2,
          databaseReferenceCount: 1,
          deletionTombstoneCount: 1,
          recoverySetSha256: "2".repeat(64),
          recoveryManifestSha256: "3".repeat(64),
          databaseConnectionUrlSha256: "a".repeat(64),
        };
      },
      assertMutationAllowed: () => undefined,
      writeOutput: (value) => {
        output += value;
      },
    });
    expect(exitCode).toBe(0);
    expect(capturedOptions).toMatchObject({
      sourceSupabaseUrl: STAGING_SOURCE_ORIGIN,
      sourceEnvironment: "permanent-staging",
      expectedCandidateSha: CANDIDATE_COMMIT_SHA,
      expectedCaptureConnectionUrlSha256: "a".repeat(64),
      expectedTombstoneCount: 1,
      bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
    });
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      recoverySetSha256: "2".repeat(64),
      recoveryManifestSha256: "3".repeat(64),
      databaseTransportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      databaseTransportRootCaDerSha256: "a".repeat(64),
      databaseEffectiveRole: "pintpath_migrator",
    });
    expect(output).not.toContain(SERVICE_ROLE_KEY);
    expect(output).not.toContain("postgresql://");
  });
});

describe("Postgres private Storage recovery path and origin normalization", () => {
  it("allows only canonical contained object paths and default project-ref origins", () => {
    expect(
      postgresPrivateStorageRecoveryInternals.safeObjectPath(
        "users/a/menu.pdf",
      ),
    ).toBe("users/a/menu.pdf");
    expect(() =>
      postgresPrivateStorageRecoveryInternals.safeObjectPath("../menu.pdf"),
    ).toThrowError(PostgresPrivateStorageRecoveryError);
    expect(
      postgresPrivateStorageRecoveryInternals.canonicalOrigin(
        "https://abcdefghijklmnopqrst.supabase.co/",
      ),
    ).toBe("https://abcdefghijklmnopqrst.supabase.co");
    expect(() =>
      postgresPrivateStorageRecoveryInternals.canonicalOrigin(
        "http://a.supabase.co",
      ),
    ).toThrowError(PostgresPrivateStorageRecoveryError);
    expect(() =>
      postgresPrivateStorageRecoveryInternals.canonicalOrigin(
        "https://storage.example.test",
      ),
    ).toThrowError(PostgresPrivateStorageRecoveryError);
  });

  it("accepts only direct safe PostgreSQL connection URLs", () => {
    expect(
      postgresPrivateStorageRecoveryInternals.connectionUrl({
        value:
          "postgresql://backup:sec%2Fret@postgres.railway.internal:5432/pintpath?sslmode=verify-full",
        allowInsecureLoopbackForTests: false,
        environment: {},
      }).clientConfig,
    ).toMatchObject({
      host: "postgres.railway.internal",
      port: 5432,
      database: "pintpath",
      user: "backup",
      password: "sec/ret",
    });
    expect(() =>
      postgresPrivateStorageRecoveryInternals.connectionUrl({
        value:
          "postgresql://backup:secret@pgbouncer.example.test/pintpath?sslmode=require",
        allowInsecureLoopbackForTests: false,
        environment: {},
      }),
    ).toThrowError(PostgresPrivateStorageRecoveryError);
    expect(() =>
      postgresPrivateStorageRecoveryInternals.connectionUrl({
        value:
          "postgresql://backup:secret@db.example.test/pint%2Fpath?sslmode=require",
        allowInsecureLoopbackForTests: false,
        environment: {},
      }),
    ).toThrowError(PostgresPrivateStorageRecoveryError);
  });

  it("keeps fixture hashes stable for test proof", () => {
    expect(sha256Fixture(Buffer.from("proof"))).toBe(
      sha256(Buffer.from("proof")),
    );
  });
});

describe("Supabase private Storage recovery boundary", () => {
  it("accepts the exact reviewed permanent-staging capture origin", () => {
    const clientFactory = vi.fn(
      () => ({ storage: {} }) as unknown as SupabaseClient,
    );
    const boundary = createSupabasePrivateStorageRecoveryBoundary({
      supabaseUrl: STAGING_SOURCE_ORIGIN,
      sourceEnvironment: "permanent-staging",
      serviceRoleKey: SERVICE_ROLE_KEY,
      clientFactory,
    });

    expect(boundary.origin).toBe(STAGING_SOURCE_ORIGIN);
    expect(clientFactory).toHaveBeenCalledWith(
      STAGING_SOURCE_ORIGIN,
      SERVICE_ROLE_KEY,
    );
  });

  it.each([
    ["production environment with permanent-staging origin", {
      supabaseUrl: STAGING_SOURCE_ORIGIN,
      sourceEnvironment: "production" as const,
      serviceRoleKey: SERVICE_ROLE_KEY,
    }],
    ["permanent-staging environment with production origin", {
      supabaseUrl: SOURCE_ORIGIN,
      sourceEnvironment: "permanent-staging" as const,
      serviceRoleKey: SERVICE_ROLE_KEY,
    }],
    ["unreviewed source origin", {
      supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
      sourceEnvironment: "permanent-staging" as const,
      serviceRoleKey: SERVICE_ROLE_KEY,
    }],
    ["publishable key in the server slot", {
      supabaseUrl: SOURCE_ORIGIN,
      sourceEnvironment: "production" as const,
      serviceRoleKey: `sb_publishable_${"p".repeat(32)}`,
    }],
  ])("rejects %s before constructing any client or request", (_label, input) => {
    const fetchImplementation = vi.fn() as unknown as typeof globalThis.fetch;
    const clientFactory = vi.fn(() => ({ storage: {} } as unknown as SupabaseClient));

    expect(() => createSupabasePrivateStorageRecoveryBoundary({
      ...input,
      fetchImplementation,
      clientFactory,
    })).toThrow(expect.objectContaining({ code: "invalid_arguments" }));
    expect(clientFactory).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("distinguishes folders, rechecks object identity, and bypasses download caches", async () => {
    const infoCalls: string[] = [];
    const download = vi.fn(
      (
        _objectPath: string,
        options: { readonly cacheNonce?: string },
        parameters: { readonly cache?: string; readonly signal?: AbortSignal },
      ) => ({
        asStream: async () => ({
          data: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(Buffer.from("PDF", "utf8")));
              controller.close();
            },
          }),
          error: null,
          options,
          parameters,
        }),
      }),
    );
    const fileApi = {
      list: vi.fn(async (prefix: string) => ({
        data:
          prefix === ""
            ? [
                { name: "accounts", id: null, metadata: null },
                { name: "root.pdf", id: "root-id", metadata: {} },
              ]
            : [{ name: "menu.pdf", id: "menu-id", metadata: {} }],
        error: null,
      })),
      info: vi.fn(async (objectPath: string) => {
        infoCalls.push(objectPath);
        return {
          data: {
            id: `id:${objectPath}`,
            version: `version:${objectPath}`,
            name: objectPath,
            bucketId: POSTGRES_PRIVATE_STORAGE_BUCKET,
            size: 3,
            contentType: "application/pdf",
          },
          error: null,
        };
      }),
      download,
      upload: vi.fn(),
    };
    const client = {
      storage: {
        getBucket: vi.fn(async () => ({
          data: {
            public: false,
            file_size_limit: 8 * 1024 * 1024,
            allowed_mime_types: [
              "image/jpeg",
              "image/png",
              "image/webp",
              "image/heic",
              "image/heif",
              "application/pdf",
            ],
          },
          error: null,
        })),
        from: vi.fn(() => fileApi),
      },
    } as unknown as SupabaseClient;
    const boundary = createSupabasePrivateStorageRecoveryBoundary({
      supabaseUrl: SOURCE_ORIGIN,
      sourceEnvironment: "production",
      serviceRoleKey: SERVICE_ROLE_KEY,
      clientFactory: () => client,
      requestTimeoutMs: 5_000,
    });
    await expect(boundary.inspectBucket()).resolves.toMatchObject({
      private: true,
      fileSizeLimit: 8 * 1024 * 1024,
    });
    await expect(boundary.listObjects()).resolves.toEqual([
      {
        objectPath: "accounts/menu.pdf",
        bytes: 3,
        contentType: "application/pdf",
        storageObjectId: "id:accounts/menu.pdf",
        storageVersion: "version:accounts/menu.pdf",
      },
      {
        objectPath: "root.pdf",
        bytes: 3,
        contentType: "application/pdf",
        storageObjectId: "id:root.pdf",
        storageVersion: "version:root.pdf",
      },
    ]);
    await expect(boundary.downloadObject("accounts/menu.pdf")).resolves.toEqual(
      {
        bytes: Buffer.from("PDF", "utf8"),
        contentType: "application/pdf",
        storageObjectId: "id:accounts/menu.pdf",
        storageVersion: "version:accounts/menu.pdf",
      },
    );
    expect(
      infoCalls.filter((value) => value === "accounts/menu.pdf"),
    ).toHaveLength(3);
    expect(download).toHaveBeenCalledTimes(1);
    const [, options, parameters] = download.mock.calls[0]!;
    expect(options.cacheNonce).toMatch(/^[a-f0-9]{32}$/);
    expect(parameters.cache).toBe("no-store");
    expect(parameters.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects an identity change across a no-store download", async () => {
    let infoCall = 0;
    const fileApi = {
      info: vi.fn(async (objectPath: string) => {
        infoCall += 1;
        return {
          data: {
            id: "object-id",
            version: `version-${infoCall}`,
            name: objectPath,
            bucketId: POSTGRES_PRIVATE_STORAGE_BUCKET,
            size: 3,
            contentType: "application/pdf",
          },
          error: null,
        };
      }),
      download: vi.fn(() => ({
        asStream: async () => ({
          data: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(Buffer.from("PDF", "utf8")));
              controller.close();
            },
          }),
          error: null,
        }),
      })),
    };
    const client = {
      storage: { from: vi.fn(() => fileApi) },
    } as unknown as SupabaseClient;
    const boundary = createSupabasePrivateStorageRecoveryBoundary({
      supabaseUrl: SOURCE_ORIGIN,
      sourceEnvironment: "production",
      serviceRoleKey: SERVICE_ROLE_KEY,
      clientFactory: () => client,
    });
    await expect(boundary.downloadObject("menu.pdf")).rejects.toMatchObject({
      code: "source_storage_changed",
    });
  });

  it("rejects an errorless null list instead of treating it as an empty bucket", async () => {
    const fileApi = {
      list: vi.fn(async () => ({ data: null, error: null })),
    };
    const client = {
      storage: { from: vi.fn(() => fileApi) },
    } as unknown as SupabaseClient;
    const boundary = createSupabasePrivateStorageRecoveryBoundary({
      supabaseUrl: SOURCE_ORIGIN,
      sourceEnvironment: "production",
      serviceRoleKey: SERVICE_ROLE_KEY,
      clientFactory: () => client,
    });
    await expect(boundary.listObjects()).rejects.toMatchObject({
      code: "source_storage_changed",
    });
  });
});
