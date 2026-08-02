import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BusinessRepository } from "../src/db/business.repository.js";
import { createDatabase } from "../src/db/database.js";
import { rehearseDataRestore, sha256Bytes } from "../src/lib/data-backup.js";
import {
  appendAccountDeletionTombstone,
  fetchVerifiedAccountDeletionLedger,
  probeOffsiteBackupReadiness,
  runOffsiteBackup,
  scheduleOffsiteBackups,
} from "../src/lib/offsite-backup.js";
import {
  isCanonicalProductionRuntime,
  resolveAccountDeletionLedgerRuntimeConfig,
} from "../src/lib/deployment-environment.js";

interface FakeObject {
  bytes: Buffer;
  contentType: string;
}

class FakeStorageProject {
  readonly buckets = new Map<string, Map<string, FakeObject>>();
  readonly staleUpsertObjects = new Map<string, FakeObject>();
  readonly downloadCacheNonces = new Map<string, string[]>();
  rootListCalls = 0;
  mutateSourceOnSecondRootList: (() => void) | null = null;
  backupFileSizeLimit: number | null = null;
  simulateStaleUpsertDownloads = false;

  bucket(name: string): Map<string, FakeObject> {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(name, bucket);
    }
    return bucket;
  }

  client(): SupabaseClient {
    const project = this;
    return {
      storage: {
        async getBucket(name: string) {
          return project.buckets.has(name)
            ? { data: {
              id: name,
              name,
              public: false,
              file_size_limit: name === "pintpath-backups" ? project.backupFileSizeLimit : 8 * 1024 * 1024,
              allowed_mime_types: name === "pintpath-backups"
                ? [
                  "application/json", "application/octet-stream", "application/pdf",
                  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
                ]
                : ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"],
            }, error: null }
            : { data: null, error: new Error(`Missing bucket: ${name}`) };
        },
        from(name: string) {
          return {
            async list(prefix = "", options?: { limit?: number; offset?: number }) {
              if (prefix === "" && name === "beermap-source-evidence") {
                project.rootListCalls += 1;
                if (project.rootListCalls === 2) project.mutateSourceOnSecondRootList?.();
              }
              const bucket = project.bucket(name);
              const prefixWithSlash = prefix ? `${prefix}/` : "";
              const children = new Map<string, { name: string; id: string | null; metadata: Record<string, unknown> | null }>();
              for (const [objectPath, object] of bucket) {
                if (!objectPath.startsWith(prefixWithSlash)) continue;
                const remainder = objectPath.slice(prefixWithSlash.length);
                if (!remainder) continue;
                const slash = remainder.indexOf("/");
                if (slash >= 0) {
                  const child = remainder.slice(0, slash);
                  children.set(child, { name: child, id: null, metadata: null });
                } else {
                  children.set(remainder, {
                    name: remainder,
                    id: `id-${objectPath}`,
                    metadata: { mimetype: object.contentType },
                  });
                }
              }
              const ordered = [...children.values()].sort((first, second) => first.name.localeCompare(second.name));
              const offset = options?.offset ?? 0;
              const limit = options?.limit ?? 100;
              return { data: ordered.slice(offset, offset + limit), error: null };
            },
            async download(
              objectPath: string,
              options?: { cacheNonce?: string },
            ) {
              const cacheNonce = options?.cacheNonce;
              if (cacheNonce) {
                const cacheNonces = project.downloadCacheNonces.get(objectPath) ?? [];
                cacheNonces.push(cacheNonce);
                project.downloadCacheNonces.set(objectPath, cacheNonces);
              }
              const stale = project.staleUpsertObjects.get(`${name}/${objectPath}`);
              const object = project.simulateStaleUpsertDownloads && stale && !cacheNonce
                ? stale
                : project.bucket(name).get(objectPath);
              return object
                ? { data: new Blob([object.bytes], { type: object.contentType }), error: null }
                : { data: null, error: new Error(`Missing object: ${objectPath}`) };
            },
            async upload(
              objectPath: string,
              body: Buffer,
              options?: { contentType?: string; upsert?: boolean },
            ) {
              const bucket = project.bucket(name);
              if (bucket.has(objectPath) && !options?.upsert) {
                return { data: null, error: new Error(`Object exists: ${objectPath}`) };
              }
              const previous = bucket.get(objectPath);
              if (
                previous &&
                options?.upsert &&
                !project.staleUpsertObjects.has(`${name}/${objectPath}`)
              ) {
                project.staleUpsertObjects.set(`${name}/${objectPath}`, {
                  bytes: Buffer.from(previous.bytes),
                  contentType: previous.contentType,
                });
              }
              bucket.set(objectPath, {
                bytes: Buffer.from(body),
                contentType: options?.contentType || "application/octet-stream",
              });
              return { data: { path: objectPath }, error: null };
            },
            async remove(objectPaths: string[]) {
              const bucket = project.bucket(name);
              for (const objectPath of objectPaths) bucket.delete(objectPath);
              return { data: objectPaths.map((objectPath) => ({ name: objectPath })), error: null };
            },
          };
        },
      },
    } as unknown as SupabaseClient;
  }
}

const roots: string[] = [];

function immutableTombstonePath(tombstone: {
  requestId: string;
  userId: string;
  completedAt: string;
}): string {
  const digest = crypto.createHash("sha256")
    .update(`${tombstone.requestId}\0${tombstone.userId}\0${tombstone.completedAt}`)
    .digest("hex");
  return `_control/account-deletion-ledger/v1/${digest}.json`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeDatabase(root: string, pdfBytes: Buffer): string {
  const databasePath = path.join(root, "pint-path.sqlite");
  const database = createDatabase(databasePath);
  const repository = new BusinessRepository(database);
  repository.createAccount({
    id: "storage-owner",
    email: "storage-owner@example.com",
    passwordHash: "test-password-hash",
    role: "user",
    subscriptionStatus: "free",
    now: "2026-07-01T00:00:00.000Z",
  });
  repository.createSourceEvidenceObject({
    id: "storage-pdf",
    ownerUserId: "storage-owner",
    storageProvider: "supabase_private",
    objectPath: "storage-owner/menu.pdf",
    mimeType: "application/pdf",
    byteSize: pdfBytes.length,
    dataBase64: null,
    externalUrl: null,
    retentionExpiresAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  database.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, status, requested_at, execute_after, completed_at, created_at, updated_at
     ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`,
  ).run(
    "completed-deletion",
    "storage-owner",
    "2026-07-10T00:00:00.000Z",
    "2026-07-10T00:00:00.000Z",
    "2026-07-11T00:00:00.000Z",
    "2026-07-10T00:00:00.000Z",
    "2026-07-11T00:00:00.000Z",
  );
  database.close();
  return databasePath;
}

function makeFreshDatabase(root: string): string {
  const databasePath = path.join(root, "fresh-pint-path.sqlite");
  createDatabase(databasePath).close();
  return databasePath;
}

describe("off-site backup durability", () => {
  it("permits automatic backup writes only from the canonical Railway environment", () => {
    expect(isCanonicalProductionRuntime({
      nodeEnv: "production",
      railwayEnvironmentName: "production",
    })).toBe(true);
    expect(isCanonicalProductionRuntime({
      nodeEnv: "production",
      railwayEnvironmentName: "staging",
    })).toBe(false);
    expect(isCanonicalProductionRuntime({
      nodeEnv: "production",
      railwayEnvironmentName: " ",
    })).toBe(false);
    expect(isCanonicalProductionRuntime({
      nodeEnv: "production",
    })).toBe(true);
    expect(isCanonicalProductionRuntime({
      nodeEnv: "test",
      railwayEnvironmentName: "production",
    })).toBe(false);
  });

  it("does not touch the backup destination when readiness is optional", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeOffsiteBackupReadiness({
      sourceSupabaseUrl: "https://production-source.supabase.co",
      destinationSupabaseUrl: "https://production-backup.supabase.co",
      destinationServiceRoleKey: "must-not-be-used-from-staging",
      bucketName: "pintpath-backups",
      lastSuccessfulAt: null,
      maxFreshnessHours: 26,
      required: false,
    })).resolves.toMatchObject({
      status: "ok",
      required: false,
      liveProbe: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a deletion-ledger writer configuration only for fully configured canonical production", () => {
    const complete = {
      nodeEnv: "production",
      railwayEnvironmentName: "production",
      sourceSupabaseUrl: "https://source.supabase.co",
      destinationSupabaseUrl: "https://backup.supabase.co",
      destinationServiceRoleKey: "fixture-destination-key",
      bucketName: "pintpath-backups",
    };
    expect(resolveAccountDeletionLedgerRuntimeConfig(complete)).toEqual({
      sourceSupabaseUrl: complete.sourceSupabaseUrl,
      destinationSupabaseUrl: complete.destinationSupabaseUrl,
      destinationServiceRoleKey: complete.destinationServiceRoleKey,
      bucketName: complete.bucketName,
    });
    expect(resolveAccountDeletionLedgerRuntimeConfig({
      ...complete,
      railwayEnvironmentName: "staging",
    })).toBeNull();
    expect(resolveAccountDeletionLedgerRuntimeConfig({
      ...complete,
      destinationServiceRoleKey: undefined,
    })).toBeNull();
    expect(resolveAccountDeletionLedgerRuntimeConfig({
      ...complete,
      destinationSupabaseUrl: " ",
    })).toBeNull();
    expect(resolveAccountDeletionLedgerRuntimeConfig({
      ...complete,
      destinationSupabaseUrl: "https://SOURCE.supabase.co/",
    })).toBeNull();
    expect(resolveAccountDeletionLedgerRuntimeConfig({
      ...complete,
      destinationSupabaseUrl: "not-a-url",
    })).toBeNull();
    expect(resolveAccountDeletionLedgerRuntimeConfig({
      ...complete,
      bucketName: " ",
    })).toBeNull();
  });

  it("bounds a readiness probe when Supabase Storage never responds", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    const readiness = await probeOffsiteBackupReadiness({
      sourceSupabaseUrl: "https://readiness-source.supabase.co",
      destinationSupabaseUrl: "https://readiness-timeout-destination.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "readiness-timeout-bucket",
      lastSuccessfulAt: new Date().toISOString(),
      maxFreshnessHours: 26,
      required: true,
      requestTimeoutMs: 10,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readiness).toMatchObject({
      status: "failed",
      required: true,
      liveProbe: true,
      error: "bucket_canary_failed",
    });
  });

  it("uses recent scheduled-backup evidence without privileged canary writes in serving readiness", async () => {
    const clientFactory = vi.fn(() => {
      throw new Error("Serving readiness must not create a Storage client for capability writes");
    });

    const readiness = await probeOffsiteBackupReadiness({
      sourceSupabaseUrl: "https://serving-source.supabase.co",
      destinationSupabaseUrl: "https://serving-backup.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      lastSuccessfulAt: new Date().toISOString(),
      maxFreshnessHours: 26,
      required: true,
      probeCapabilities: false,
      clientFactory,
    });

    expect(clientFactory).not.toHaveBeenCalled();
    expect(readiness).toMatchObject({
      status: "ok",
      required: true,
      liveProbe: false,
    });
  });

  it("still fails serving readiness when the last scheduled backup is stale", async () => {
    const readiness = await probeOffsiteBackupReadiness({
      sourceSupabaseUrl: "https://stale-source.supabase.co",
      destinationSupabaseUrl: "https://stale-backup.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      lastSuccessfulAt: new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString(),
      maxFreshnessHours: 26,
      required: true,
      probeCapabilities: false,
    });

    expect(readiness).toMatchObject({
      status: "failed",
      required: true,
      liveProbe: false,
      error: "last_successful_backup_stale",
    });
  });

  it("bounds a backup attempt when Supabase Storage never responds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-offsite-timeout-test-"));
    roots.push(root);
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runOffsiteBackup({
      databasePath: path.join(root, "unused.sqlite"),
      evidencePath: path.join(root, "unused-evidence"),
      sourceSupabaseUrl: "https://backup-timeout-source.supabase.co",
      sourceServiceRoleKey: "source-key",
      destinationSupabaseUrl: "https://backup-timeout-destination.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      retentionDays: 30,
      requestTimeoutMs: 10,
    })).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries promptly when a startup run encounters an existing lease", async () => {
    vi.useFakeTimers();
    let leaseAttempts = 0;
    const scheduler = scheduleOffsiteBackups({
      databasePath: "/unused.sqlite",
      evidencePath: "/unused-evidence",
      sourceSupabaseUrl: "https://source.supabase.co",
      sourceServiceRoleKey: "source-key",
      destinationSupabaseUrl: "https://backup.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      retentionDays: 30,
      intervalHours: 24,
      acquireLease: () => {
        leaseAttempts += 1;
        return false;
      },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(leaseAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(leaseAttempts).toBe(2);

    await scheduler.stop();
  });

  it("contains status and lease-release failures instead of rejecting the scheduler", async () => {
    vi.useFakeTimers();
    let statusAttempts = 0;
    let releaseAttempts = 0;
    const scheduler = scheduleOffsiteBackups({
      databasePath: "/unused.sqlite",
      evidencePath: "/unused-evidence",
      sourceSupabaseUrl: "https://same.supabase.co",
      sourceServiceRoleKey: "source-key",
      destinationSupabaseUrl: "https://same.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      retentionDays: 30,
      intervalHours: 24,
      acquireLease: () => true,
      releaseLease: () => {
        releaseAttempts += 1;
        throw new Error("lease store unavailable");
      },
      onStatus: async () => {
        statusAttempts += 1;
        throw new Error("status store unavailable");
      },
    });

    await expect(scheduler.runNow()).resolves.toBeUndefined();
    expect(statusAttempts).toBe(2);
    expect(releaseAttempts).toBe(1);

    await scheduler.stop();
  });

  it("authenticates a zero-deletion genesis and rehearses a fresh-install restore", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-offsite-fresh-test-"));
    roots.push(root);
    const source = new FakeStorageProject();
    const destination = new FakeStorageProject();
    source.bucket("beermap-source-evidence");
    const destinationBucket = destination.bucket("pintpath-backups");
    const clients = new Map([
      ["https://source.supabase.co", source.client()],
      ["https://backup.supabase.co", destination.client()],
    ]);
    const config = {
      databasePath: makeFreshDatabase(root),
      evidencePath: path.join(root, "legacy-evidence"),
      sourceSupabaseUrl: "https://source.supabase.co",
      sourceServiceRoleKey: "source-key",
      destinationSupabaseUrl: "https://backup.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      retentionDays: 30,
      clientFactory: (url: string) => clients.get(url)!,
    };

    const result = await runOffsiteBackup(config);
    expect(result.deletionTombstones).toBe(0);
    expect([...destinationBucket.keys()].filter((key) => (
      key.startsWith("_control/account-deletion-ledger/v1/")
    ))).toHaveLength(0);
    expect(destinationBucket.has("_control/account-deletion-ledger-genesis.json")).toBe(true);

    const verified = await fetchVerifiedAccountDeletionLedger(config);
    expect(verified.tombstones).toEqual([]);
    expect(verified.checkpoint).toMatchObject({
      version: 2,
      immutableObjectCount: 0,
      tombstoneCount: 0,
      latestCompletedAt: null,
      genesisSha256: verified.genesisSha256,
      currentLedgerSha256: verified.sha256,
    });

    const backupRoot = path.join(root, "downloaded-backup");
    for (const [objectPath, object] of destinationBucket) {
      const prefix = `${result.backupId}/`;
      if (!objectPath.startsWith(prefix)) continue;
      const localPath = path.join(backupRoot, objectPath.slice(prefix.length));
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, object.bytes);
    }
    const authorityRoot = path.join(root, "restore-authority");
    fs.mkdirSync(authorityRoot, { recursive: true });
    const ledgerPath = path.join(authorityRoot, "ledger.json");
    const genesisPath = path.join(authorityRoot, "genesis.json");
    const checkpointPath = path.join(authorityRoot, "checkpoint.json");
    fs.writeFileSync(ledgerPath, verified.bytes);
    fs.writeFileSync(genesisPath, verified.genesisBytes);
    fs.writeFileSync(checkpointPath, verified.checkpointBytes);

    const restored = await rehearseDataRestore({
      backupPath: backupRoot,
      restoreRoot: path.join(root, "restored"),
      deletionTombstonePath: ledgerPath,
      expectedDeletionTombstoneSha256: verified.sha256,
      deletionLedgerGenesisPath: genesisPath,
      expectedDeletionLedgerGenesisSha256: verified.genesisSha256,
      deletionLedgerCheckpointPath: checkpointPath,
      expectedDeletionLedgerCheckpointSha256: verified.checkpointSha256,
    });
    expect(restored.tombstonesApplied).toBe(0);
    expect(fs.existsSync(restored.databasePath)).toBe(true);

    destinationBucket.set("_control/account-deletion-ledger-genesis.json", {
      bytes: Buffer.from("{\"version\":1,\"kind\":\"forged\"}"),
      contentType: "application/json",
    });
    await expect(fetchVerifiedAccountDeletionLedger(config)).rejects.toThrow(
      "Invalid independent account-deletion ledger genesis record",
    );
  });

  it("cache-busts fixed-path ledger verification after a Storage upsert", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-offsite-cache-test-"));
    roots.push(root);
    const source = new FakeStorageProject();
    const destination = new FakeStorageProject();
    source.bucket("beermap-source-evidence");
    destination.bucket("pintpath-backups");
    const clients = new Map([
      ["https://source.supabase.co", source.client()],
      ["https://backup.supabase.co", destination.client()],
    ]);
    const config = {
      databasePath: makeFreshDatabase(root),
      evidencePath: path.join(root, "legacy-evidence"),
      sourceSupabaseUrl: "https://source.supabase.co",
      sourceServiceRoleKey: "source-key",
      destinationSupabaseUrl: "https://backup.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      retentionDays: 30,
      clientFactory: (url: string) => clients.get(url)!,
    };

    await runOffsiteBackup(config);
    const firstCurrent = Buffer.from(
      destination.bucket("pintpath-backups").get("_control/account-deletion-tombstones.json")!.bytes,
    );
    const firstCheckpoint = Buffer.from(
      destination.bucket("pintpath-backups").get("_control/account-deletion-ledger-checkpoint.json")!.bytes,
    );
    const database = createDatabase(config.databasePath);
    const repository = new BusinessRepository(database);
    repository.createAccount({
      id: "cache-regression-deleted-user",
      email: "cache-regression-deleted-user@example.com",
      passwordHash: "test-password-hash",
      role: "user",
      subscriptionStatus: "free",
      now: "2026-07-15T00:00:00.000Z",
    });
    database.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, requested_at, execute_after, completed_at, created_at, updated_at
       ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`,
    ).run(
      "cache-regression-deletion",
      "cache-regression-deleted-user",
      "2026-07-15T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    );
    database.close();
    destination.simulateStaleUpsertDownloads = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(runOffsiteBackup(config)).resolves.toMatchObject({
      deletionTombstones: 1,
    });

    const currentLedger = destination.bucket("pintpath-backups").get(
      "_control/account-deletion-tombstones.json",
    )!.bytes;
    const currentCheckpoint = destination.bucket("pintpath-backups").get(
      "_control/account-deletion-ledger-checkpoint.json",
    )!.bytes;
    expect(currentLedger).not.toEqual(firstCurrent);
    expect(currentCheckpoint).not.toEqual(firstCheckpoint);
    expect(JSON.parse(currentLedger.toString("utf8"))).toMatchObject({
      tombstones: [{ userId: "cache-regression-deleted-user" }],
    });
    expect(destination.staleUpsertObjects.get(
      "pintpath-backups/_control/account-deletion-tombstones.json",
    )?.bytes).toEqual(firstCurrent);
    expect(destination.staleUpsertObjects.get(
      "pintpath-backups/_control/account-deletion-ledger-checkpoint.json",
    )?.bytes).toEqual(firstCheckpoint);

    for (const objectPath of [
      "_control/account-deletion-tombstones.json",
      "_control/account-deletion-ledger-checkpoint.json",
    ]) {
      const nonces = destination.downloadCacheNonces.get(objectPath) ?? [];
      expect(nonces.length).toBeGreaterThan(1);
      expect(new Set(nonces).size).toBe(nonces.length);
    }
  });

  it("captures private Storage evidence, retries a concurrent mutation, preserves PDF MIME, and prunes old snapshots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-offsite-test-"));
    roots.push(root);
    const source = new FakeStorageProject();
    const destination = new FakeStorageProject();
    const sourceBucket = source.bucket("beermap-source-evidence");
    const destinationBucket = destination.bucket("pintpath-backups");
    const pdfBytes = Buffer.from("%PDF-private-menu");
    sourceBucket.set("storage-owner/menu.pdf", { bytes: pdfBytes, contentType: "application/pdf" });
    source.mutateSourceOnSecondRootList = () => {
      sourceBucket.set("unreferenced/orphan.jpg", {
        bytes: Buffer.from("orphan-image"),
        contentType: "image/jpeg",
      });
    };
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const oldBackupId = `pint-path-${oldDate.toISOString().replace(/[:.]/g, "-")}`;
    destinationBucket.set(`${oldBackupId}/manifest.json`, {
      bytes: Buffer.from("{}"),
      contentType: "application/json",
    });
    const olderTombstone = {
      requestId: "older-deletion",
      userId: "older-user",
      completedAt: "2026-06-01T00:00:00.000Z",
    };
    destinationBucket.set(immutableTombstonePath(olderTombstone), {
      bytes: Buffer.from(`${JSON.stringify({
        version: 1,
        generatedAt: olderTombstone.completedAt,
        tombstones: [olderTombstone],
      }, null, 2)}\n`),
      contentType: "application/json",
    });
    const databasePath = makeDatabase(root, pdfBytes);
    const clients = new Map([
      ["https://source.supabase.co", source.client()],
      ["https://backup.supabase.co", destination.client()],
    ]);

    const result = await runOffsiteBackup({
      databasePath,
      evidencePath: path.join(root, "legacy-evidence"),
      sourceSupabaseUrl: "https://source.supabase.co",
      sourceServiceRoleKey: "source-key",
      destinationSupabaseUrl: "https://backup.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      retentionDays: 30,
      clientFactory: (url) => clients.get(url)!,
    });

    expect(result.sourceEvidenceObjects).toBe(2);
    expect(result.deletionTombstones).toBe(2);
    expect(result.prunedBackups).toBe(1);
    expect([...destinationBucket.keys()].some((key) => key.startsWith(`${oldBackupId}/`))).toBe(false);
    expect([...destinationBucket.keys()].some((key) => (
      key.startsWith(`${result.backupId}/`) && (key.endsWith("-wal") || key.endsWith("-shm"))
    ))).toBe(false);
    const manifestObject = destinationBucket.get(`${result.backupId}/manifest.json`)!;
    expect(result.manifestSha256).toBe(sha256Bytes(manifestObject.bytes));
    expect(JSON.parse(destinationBucket.get("latest.json")!.bytes.toString("utf8")))
      .toMatchObject({ backupId: result.backupId, manifestSha256: result.manifestSha256 });
    const manifest = JSON.parse(manifestObject.bytes.toString("utf8")) as {
      storageEvidence: {
        reconciliationAttempts: number;
        databaseReferenceCount: number;
        orphanPaths: string[];
      };
      deletionTombstones: { count: number };
    };
    expect(manifest.storageEvidence).toMatchObject({
      reconciliationAttempts: 2,
      databaseReferenceCount: 1,
      orphanPaths: ["unreferenced/orphan.jpg"],
    });
    expect(manifest.deletionTombstones.count).toBe(2);
    const backedUpPdf = destinationBucket.get(
      `${result.backupId}/supabase-source-evidence/storage-owner/menu.pdf`,
    );
    expect(backedUpPdf?.bytes.equals(pdfBytes)).toBe(true);
    expect(backedUpPdf?.contentType).toBe("application/pdf");
    const currentLedger = JSON.parse(destinationBucket.get(
      "_control/account-deletion-tombstones.json",
    )!.bytes.toString("utf8")) as { tombstones: Array<{ userId: string }> };
    expect(currentLedger.tombstones.map((tombstone) => tombstone.userId)).toEqual([
      "older-user",
      "storage-owner",
    ]);
    const deletionConfig = {
      sourceSupabaseUrl: "https://source.supabase.co",
      destinationSupabaseUrl: "https://backup.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      clientFactory: (url: string) => clients.get(url)!,
    };
    const tombstone = {
      requestId: "completed-deletion",
      userId: "storage-owner",
      completedAt: "2026-07-11T00:00:00.000Z",
    };
    await appendAccountDeletionTombstone(deletionConfig, tombstone);
    await appendAccountDeletionTombstone(deletionConfig, tombstone);
    expect([...destinationBucket.keys()].filter((key) => (
      key.startsWith("_control/account-deletion-ledger/v1/")
    ))).toHaveLength(2);
    const verifiedLedger = await fetchVerifiedAccountDeletionLedger(deletionConfig);
    expect(verifiedLedger.tombstones).toHaveLength(2);

    const newerTombstone = {
      requestId: "newer-deletion",
      userId: "newer-user",
      completedAt: "2026-07-14T13:00:00.000Z",
    };
    const staleObjectPath = immutableTombstonePath(newerTombstone);
    destinationBucket.set(staleObjectPath, {
      bytes: Buffer.from(`${JSON.stringify({
        version: 1,
        generatedAt: newerTombstone.completedAt,
        tombstones: [newerTombstone],
      }, null, 2)}\n`),
      contentType: "application/json",
    });
    await expect(fetchVerifiedAccountDeletionLedger(deletionConfig)).rejects.toThrow(
      "stale, tampered, or changed",
    );
    destinationBucket.delete(staleObjectPath);

    destinationBucket.set("_control/account-deletion-tombstones.json", {
      bytes: Buffer.from("{\"version\":1,\"generatedAt\":\"2026-07-14T13:00:00.000Z\",\"tombstones\":[]}"),
      contentType: "application/json",
    });
    await expect(fetchVerifiedAccountDeletionLedger(deletionConfig)).rejects.toThrow(
      "stale, tampered, or changed",
    );

    const readiness = await probeOffsiteBackupReadiness({
      ...deletionConfig,
      lastSuccessfulAt: new Date().toISOString(),
      maxFreshnessHours: 26,
      required: true,
    });
    expect(readiness).toMatchObject({ status: "ok", liveProbe: true, required: true });
    expect([...destinationBucket.keys()].some((key) => key.startsWith("_readiness/"))).toBe(false);
  });

  it("rejects a destination in the production Supabase project", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-offsite-test-"));
    roots.push(root);
    await expect(runOffsiteBackup({
      databasePath: path.join(root, "unused.sqlite"),
      evidencePath: path.join(root, "evidence"),
      sourceSupabaseUrl: "https://same-project.supabase.co/",
      sourceServiceRoleKey: "source-key",
      destinationSupabaseUrl: "https://SAME-PROJECT.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      retentionDays: 30,
    })).rejects.toThrow("different Supabase project/provider");
  });

  it("rejects the legacy 100 MiB destination cap before a growing SQLite snapshot is uploaded", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-offsite-test-"));
    roots.push(root);
    const source = new FakeStorageProject();
    const destination = new FakeStorageProject();
    source.bucket("beermap-source-evidence");
    destination.bucket("pintpath-backups");
    destination.backupFileSizeLimit = 100 * 1024 * 1024;
    const clients = new Map([
      ["https://source.supabase.co", source.client()],
      ["https://backup.supabase.co", destination.client()],
    ]);
    await expect(runOffsiteBackup({
      databasePath: path.join(root, "larger-than-100-mib.sqlite"),
      evidencePath: path.join(root, "evidence"),
      sourceSupabaseUrl: "https://source.supabase.co",
      sourceServiceRoleKey: "source-key",
      destinationSupabaseUrl: "https://backup.supabase.co",
      destinationServiceRoleKey: "destination-key",
      bucketName: "pintpath-backups",
      retentionDays: 30,
      clientFactory: (url) => clients.get(url)!,
    })).rejects.toThrow("must not impose a bucket-level object cap");
  });
});
