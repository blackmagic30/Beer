import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_PRIVATE_STORAGE_BUCKET,
  postgresPrivateStorageRecoveryInternals,
  type PostgresPrivateStorageBoundary,
  type PostgresPrivateStorageRecoveryManifest,
} from "../src/lib/postgres-private-storage-recovery.js";
import {
  PostgresPrivateStoragePurgeError,
  purgePostgresPrivateStorageRecoveryTarget,
} from "../scripts/purge-postgres-private-storage-recovery-target.js";

const CANDIDATE = "c".repeat(40);
const PROJECT_REF = "bcdefghijklmnopqrstu";
const ORIGIN = `https://${PROJECT_REF}.supabase.co`;
const RAILWAY_PROJECT = "11111111-1111-4111-8111-111111111111";
const RAILWAY_ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const TARGET_IDENTITY = "d".repeat(64);
const TARGET_URL = "e".repeat(64);
const ROOT_CA_DER = "1".repeat(64);
const DESTINATION_RESTORE_AUTHORITY = "2".repeat(64);
const SERVICE_KEY = `sb_secret_${"s".repeat(32)}`; // security-scan allow: synthetic fixture
const NOW = new Date("2026-08-14T04:00:00.000Z");
const roots: string[] = [];

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function root(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-purge-")));
  fs.chmodSync(directory, 0o700);
  roots.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(overrides: {
  readonly authoritySchema?: string;
  readonly restore?: Readonly<Record<string, unknown>>;
} = {}) {
  const directory = root();
  const bytes = Buffer.from("%PDF-exact-private-object", "utf8");
  const recoveryObject = {
    objectPath: "accounts/evidence.pdf",
    bytes: bytes.length,
    sha256: hash(bytes),
    contentType: "application/pdf",
    sourceStorageObjectIdSha256: "1".repeat(64),
    sourceStorageVersionSha256: "2".repeat(64),
    referencedByDatabase: true,
  };
  const withoutBinding: Omit<PostgresPrivateStorageRecoveryManifest, "recoverySetSha256"> = {
    kind: "pintpath-postgres-private-storage-recovery-set",
    version: 2,
    capturedAt: "2026-08-14T03:00:00.000Z",
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
      databaseReferenceCount: 1, orphanObjectCount: 0, totalBytes: String(bytes.length),
      sourceInventorySha256: hash(canonicalPostgresBackupJson([{
        objectPath: recoveryObject.objectPath, bytes: recoveryObject.bytes,
        contentType: recoveryObject.contentType,
        storageObjectIdSha256: recoveryObject.sourceStorageObjectIdSha256,
        storageVersionSha256: recoveryObject.sourceStorageVersionSha256,
      }])),
      objectSetSha256: hash(canonicalPostgresBackupJson([recoveryObject])),
      objects: [recoveryObject],
    },
    deletionAuthority: {
      currentSha256: "c".repeat(64), genesisSha256: "d".repeat(64),
      checkpointSha256: "e".repeat(64), immutableSetSha256: "f".repeat(64),
      tombstoneCount: 1, latestCompletedAt: "2026-08-14T02:00:00.000Z",
      authoritySetSha256: "0".repeat(64),
    },
  };
  const manifest: PostgresPrivateStorageRecoveryManifest = {
    ...withoutBinding,
    recoverySetSha256: postgresPrivateStorageRecoveryInternals.recoverySetBinding(withoutBinding),
  };
  const manifestSource = canonicalPostgresBackupJson(manifest);
  const manifestSha = hash(manifestSource);
  const restoredObjectSetSha = hash(canonicalPostgresBackupJson([{
    objectPath: recoveryObject.objectPath, bytes: recoveryObject.bytes,
    sha256: recoveryObject.sha256, contentType: recoveryObject.contentType,
  }]));
  const restore = {
    schemaVersion: 1, kind: "pintpath-postgres-private-storage-recovery-restore",
    ok: true, restoredAt: "2026-08-14T03:15:00.000Z",
    targetDatabaseIdentitySha256: TARGET_IDENTITY,
    recoverySetSha256: manifest.recoverySetSha256,
    recoveryManifestSha256: manifestSha, restoredObjectCount: 1,
    restoredBytes: String(bytes.length),
    destinationObjectSetSha256: restoredObjectSetSha,
    deletionAuthoritySetSha256: manifest.deletionAuthority.authoritySetSha256,
    databaseTransportProfile: "railway-stock-localhost-ca-v1",
    databaseTransportRootCaDerSha256: ROOT_CA_DER,
    databaseEffectiveRole: "pintpath_migrator",
    candidateSha: CANDIDATE,
    destinationConnectionUrlSha256: TARGET_URL,
    destinationOriginSha256: hash(ORIGIN),
    destinationBucketNameSha256: hash(POSTGRES_PRIVATE_STORAGE_BUCKET),
    destinationAuthoritySha256: DESTINATION_RESTORE_AUTHORITY,
    destinationAuthorityPublicKeySha256: "3".repeat(64),
    destinationAuthorityReviewerIdSha256: "4".repeat(64),
    destinationRailwayProjectIdSha256: hash(RAILWAY_PROJECT),
    destinationRailwayEnvironmentIdSha256: hash(RAILWAY_ENVIRONMENT),
    ...overrides.restore,
  };
  const restoreSource = canonicalPostgresBackupJson(restore);
  const restoreSha = hash(restoreSource);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = {
    schemaVersion: "pintpath-private-storage-disposable-purge-authority-payload/v1",
    operation: "purge-only-restored-object-set",
    candidateSha: CANDIDATE, destinationOrigin: ORIGIN,
    destinationOriginSha256: hash(ORIGIN), destinationProjectRef: PROJECT_REF,
    bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
    bucketNameSha256: hash(POSTGRES_PRIVATE_STORAGE_BUCKET),
    targetConnectionUrlSha256: TARGET_URL, targetDatabaseIdentitySha256: TARGET_IDENTITY,
    targetRailwayProjectId: RAILWAY_PROJECT,
    targetRailwayEnvironmentId: RAILWAY_ENVIRONMENT,
    destinationRestoreAuthoritySha256: DESTINATION_RESTORE_AUTHORITY,
    reviewerIdSha256: "a".repeat(64),
    reviewerPublicKeySha256: hash(publicKeyPem), issuedAt: "2026-08-14T03:30:00.000Z",
    expiresAt: "2026-08-14T04:30:00.000Z",
  };
  const authoritySource = canonicalPostgresBackupJson({
    schemaVersion: overrides.authoritySchema
      ?? "pintpath-private-storage-disposable-purge-authority/v1",
    payload,
    signatureBase64: crypto.sign(
      null, Buffer.from(canonicalPostgresBackupJson(payload)), privateKey,
    ).toString("base64"),
  });
  const values: Record<string, string> = {
    "--purge-authority-file": "/private/purge-authority.json",
    "--purge-authority-sha256": hash(authoritySource),
    "--purge-authority-public-key-file": "/private/purge-authority.pem",
    "--purge-authority-public-key-sha256": hash(publicKeyPem),
    "--recovery-manifest-file": "/private/recovery-set.json",
    "--recovery-manifest-sha256": manifestSha,
    "--restore-receipt-file": "/private/restore-receipt.json",
    "--restore-receipt-sha256": restoreSha,
    "--destination-restore-authority-sha256": DESTINATION_RESTORE_AUTHORITY,
    "--expected-root-ca-der-sha256": ROOT_CA_DER,
    "--destination-origin-sha256": hash(ORIGIN),
    "--destination-project-ref": PROJECT_REF,
    "--expected-candidate-sha": CANDIDATE,
    "--forbidden-origin-sha256s": "f".repeat(64),
    "--service-role-key-file": "/private/service-role.key",
    "--target-connection-url-sha256": TARGET_URL,
    "--target-database-identity-sha256": TARGET_IDENTITY,
    "--target-railway-project-id": RAILWAY_PROJECT,
    "--target-railway-environment-id": RAILWAY_ENVIRONMENT,
    "--output": path.join(directory, "purge-receipt.json"),
  };
  const privateFiles: Record<string, string> = {
    "/private/purge-authority.json": authoritySource,
    "/private/purge-authority.pem": publicKeyPem,
    "/private/recovery-set.json": manifestSource,
    "/private/restore-receipt.json": restoreSource,
    "/private/service-role.key": SERVICE_KEY,
  };
  return {
    argv: Object.entries(values).flatMap(([flag, value]) => [flag, value]),
    values, privateFiles, bytes, recoveryObject,
  };
}

class MemoryStorage implements PostgresPrivateStorageBoundary {
  readonly origin = ORIGIN;
  readonly bucketName = POSTGRES_PRIVATE_STORAGE_BUCKET;
  objects = [{
    objectPath: "accounts/evidence.pdf", bytes: 25, contentType: "application/pdf",
    storageObjectId: "storage-id", storageVersion: "storage-version",
  }];
  removed: readonly string[] = [];

  constructor(readonly bytes: Buffer) {
    this.objects[0]!.bytes = bytes.length;
  }

  async inspectBucket() {
    return { private: true, fileSizeLimit: null, allowedMimeTypes: ["application/pdf"] };
  }

  async listObjects() {
    return this.objects;
  }

  async downloadObject() {
    return {
      bytes: Buffer.from(this.bytes), contentType: "application/pdf",
      storageObjectId: "storage-id", storageVersion: "storage-version",
    };
  }

  async uploadImmutable() {
    throw new Error("not used");
  }

  async removeObjects(paths: readonly string[]) {
    this.removed = [...paths];
    this.objects = [];
  }
}

function dependencies(value: ReturnType<typeof fixture>, storage: PostgresPrivateStorageBoundary) {
  return {
    argv: value.argv,
    env: {
      PINTPATH_POSTGRES_PRIVATE_STORAGE_PURGE: "confirmed",
      RESTORE_SUPABASE_URL: ORIGIN,
    },
    now: () => NOW,
    readPrivateFile: async (filename: string) => value.privateFiles[filename]!,
    createStorage: () => storage,
    assertMutationAllowed: () => undefined,
    writeOutput: () => undefined,
  };
}

describe("exact private Storage recovery target purge", () => {
  it("removes only the signed restored set, proves absence twice, and self-hashes", async () => {
    const value = fixture();
    const storage = new MemoryStorage(value.bytes);
    const receipt = await purgePostgresPrivateStorageRecoveryTarget(
      dependencies(value, storage),
    ) as Record<string, unknown>;
    expect(storage.removed).toEqual(["accounts/evidence.pdf"]);
    expect(receipt).toMatchObject({
      ok: true, candidateSha: CANDIDATE, restoredObjectSetExact: true,
      concurrentObjectSetAbsent: true, storageObjectsAbsentExact: true,
    });
    const { receiptSha256, ...withoutHash } = receipt;
    expect(receiptSha256).toBe(hash(canonicalPostgresBackupJson(withoutHash)));
    expect(fs.statSync(value.values["--output"]!).mode & 0o7777).toBe(0o600);
  });

  it("rejects a restore-only authority before constructing Storage", async () => {
    const value = fixture({ authoritySchema: "pintpath-private-storage-disposable-authority/v1" });
    const createStorage = vi.fn();
    await expect(purgePostgresPrivateStorageRecoveryTarget({
      ...dependencies(value, new MemoryStorage(value.bytes)), createStorage,
    })).rejects.toEqual(new PostgresPrivateStoragePurgeError("authority_invalid"));
    expect(createStorage).not.toHaveBeenCalled();
  });

  it("rejects an extra or changed object without deleting anything", async () => {
    const value = fixture();
    const storage = new MemoryStorage(value.bytes);
    storage.objects.push({
      objectPath: "unexpected/private.pdf", bytes: 1, contentType: "application/pdf",
      storageObjectId: "extra", storageVersion: "extra-v1",
    });
    await expect(purgePostgresPrivateStorageRecoveryTarget(
      dependencies(value, storage),
    )).rejects.toEqual(new PostgresPrivateStoragePurgeError("unexpected_object_set"));
    expect(storage.removed).toEqual([]);
  });

  it.each([
    ["candidate", { candidateSha: "b".repeat(40) }],
    ["destination authority", { destinationAuthoritySha256: "5".repeat(64) }],
    ["Railway environment", { destinationRailwayEnvironmentIdSha256: "6".repeat(64) }],
    ["database role", { databaseEffectiveRole: "pintpath_runtime" }],
    ["root CA", { databaseTransportRootCaDerSha256: "7".repeat(64) }],
    ["destination origin", { destinationOriginSha256: "8".repeat(64) }],
  ])("rejects a semantically substituted %s restore receipt before Storage access", async (
    _label, restore,
  ) => {
    const value = fixture({ restore });
    const createStorage = vi.fn();
    await expect(purgePostgresPrivateStorageRecoveryTarget({
      ...dependencies(value, new MemoryStorage(value.bytes)), createStorage,
    })).rejects.toEqual(new PostgresPrivateStoragePurgeError("restore_receipt_invalid"));
    expect(createStorage).not.toHaveBeenCalled();
  });

  it("rejects output collisions before reading secrets or touching Storage", async () => {
    const value = fixture();
    fs.writeFileSync(value.values["--output"]!, "occupied", { mode: 0o600 });
    const readPrivateFile = vi.fn(async () => "must-not-read");
    const storage = new MemoryStorage(value.bytes);
    await expect(purgePostgresPrivateStorageRecoveryTarget({
      ...dependencies(value, storage), readPrivateFile,
    })).rejects.toEqual(new PostgresPrivateStoragePurgeError("output_unsafe"));
    expect(readPrivateFile).not.toHaveBeenCalled();
    expect(storage.removed).toEqual([]);
  });

  it("rejects a symlinked evidence directory before reading private files", async () => {
    const value = fixture();
    const directory = path.dirname(value.values["--output"]!);
    const realDirectory = `${directory}.real`;
    fs.renameSync(directory, realDirectory);
    roots.push(realDirectory);
    fs.symlinkSync(realDirectory, directory, "dir");
    const readPrivateFile = vi.fn(async () => "must-not-read");
    await expect(purgePostgresPrivateStorageRecoveryTarget({
      ...dependencies(value, new MemoryStorage(value.bytes)), readPrivateFile,
    })).rejects.toEqual(new PostgresPrivateStoragePurgeError("output_unsafe"));
    expect(readPrivateFile).not.toHaveBeenCalled();
  });

  it("detects evidence-directory replacement during purge and emits no green receipt", async () => {
    const value = fixture();
    const storage = new MemoryStorage(value.bytes);
    const directory = path.dirname(value.values["--output"]!);
    const moved = `${directory}.moved`;
    storage.removeObjects = async (paths: readonly string[]) => {
      fs.renameSync(directory, moved);
      roots.push(moved);
      fs.mkdirSync(directory, { mode: 0o700 });
      storage.removed = [...paths];
      storage.objects = [];
    };
    await expect(purgePostgresPrivateStorageRecoveryTarget(
      dependencies(value, storage),
    )).rejects.toEqual(new PostgresPrivateStoragePurgeError("output_unsafe"));
    expect(fs.existsSync(value.values["--output"]!)).toBe(false);
  });

  it("makes held-directory close failure dominant before writing a purge receipt", async () => {
    const value = fixture();
    const directory = path.dirname(value.values["--output"]!);
    const stat = fs.statSync(directory, { bigint: true });
    await expect(purgePostgresPrivateStorageRecoveryTarget({
      ...dependencies(value, new MemoryStorage(value.bytes)),
      holdEvidenceDirectory: () => ({
        path: directory,
        identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid },
        assertExact: () => undefined,
        close: () => { throw new Error("synthetic_close_failure"); },
      }),
    })).rejects.toEqual(new PostgresPrivateStoragePurgeError("output_unsafe"));
    expect(fs.existsSync(value.values["--output"]!)).toBe(false);
  });

  it("rejects parent replacement after close before writing a purge receipt", async () => {
    const value = fixture();
    const directory = path.dirname(value.values["--output"]!);
    const moved = `${directory}.after-close`;
    const stat = fs.statSync(directory, { bigint: true });
    await expect(purgePostgresPrivateStorageRecoveryTarget({
      ...dependencies(value, new MemoryStorage(value.bytes)),
      holdEvidenceDirectory: () => ({
        path: directory,
        identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid },
        assertExact: () => undefined,
        close: () => {
          fs.renameSync(directory, moved);
          roots.push(moved);
          fs.mkdirSync(directory, { mode: 0o700 });
        },
      }),
    })).rejects.toEqual(new PostgresPrivateStoragePurgeError("output_unsafe"));
    expect(fs.existsSync(value.values["--output"]!)).toBe(false);
  });
});
