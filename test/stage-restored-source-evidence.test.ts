import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BusinessRepository } from "../src/db/business.repository.js";
import { createDatabase } from "../src/db/database.js";
import {
  createDataBackup,
  finalizeBackupSupplementalData,
  listBackupFiles,
} from "../src/lib/data-backup.js";
import { stageRestoredSourceEvidence } from "../src/lib/stage-restored-source-evidence.js";

const BLOCKED_CLI_SERVICE_ROLE_KEY = [
  "sb",
  "secret",
  "never_read_by_blocked_cli_12345",
].join("_");
const BLOCKED_LIBRARY_SERVICE_ROLE_KEY = [
  "sb",
  "secret",
  "never_read_by_blocked_library_123",
].join("_");

interface FakeObject {
  bytes: Buffer;
  contentType: string;
}

class FakeStagingStorage {
  readonly objects = new Map<string, FakeObject>();
  readonly uploads: Array<{ path: string; contentType: string; upsert: boolean }> = [];
  isPublic = false;
  downloadContentTypeOverride: string | null = null;
  onGetBucket: (() => void) | null = null;

  client(): SupabaseClient {
    const storage = this;
    return {
      storage: {
        async getBucket(name: string) {
          if (name !== "beermap-source-evidence") {
            return { data: null, error: new Error(`Unknown bucket: ${name}`) };
          }
          storage.onGetBucket?.();
          return {
            data: { id: name, name, public: storage.isPublic },
            error: null,
          };
        },
        from(name: string) {
          if (name !== "beermap-source-evidence") throw new Error(`Unknown bucket: ${name}`);
          return {
            async list(prefix = "", options?: { limit?: number; offset?: number }) {
              const prefixWithSlash = prefix ? `${prefix}/` : "";
              const children = new Map<string, {
                name: string;
                id: string | null;
                metadata: Record<string, unknown> | null;
              }>();
              for (const [objectPath, object] of storage.objects) {
                if (!objectPath.startsWith(prefixWithSlash)) continue;
                const remainder = objectPath.slice(prefixWithSlash.length);
                if (!remainder) continue;
                const separator = remainder.indexOf("/");
                if (separator >= 0) {
                  const child = remainder.slice(0, separator);
                  children.set(child, { name: child, id: null, metadata: null });
                } else {
                  children.set(remainder, {
                    name: remainder,
                    id: `id-${objectPath}`,
                    metadata: { mimetype: object.contentType },
                  });
                }
              }
              const ordered = [...children.values()]
                .sort((first, second) => first.name.localeCompare(second.name));
              const offset = options?.offset ?? 0;
              const limit = options?.limit ?? 100;
              return { data: ordered.slice(offset, offset + limit), error: null };
            },
            async upload(
              objectPath: string,
              body: Buffer,
              options?: { contentType?: string; upsert?: boolean },
            ) {
              if (storage.objects.has(objectPath) && !options?.upsert) {
                return { data: null, error: new Error(`Object already exists: ${objectPath}`) };
              }
              const contentType = options?.contentType ?? "application/octet-stream";
              storage.objects.set(objectPath, { bytes: Buffer.from(body), contentType });
              storage.uploads.push({
                path: objectPath,
                contentType,
                upsert: options?.upsert ?? false,
              });
              return { data: { path: objectPath }, error: null };
            },
            async download(objectPath: string) {
              const object = storage.objects.get(objectPath);
              return object
                ? {
                  data: new Blob([object.bytes], {
                    type: storage.downloadContentTypeOverride ?? object.contentType,
                  }),
                  error: null,
                }
                : { data: null, error: new Error(`Missing object: ${objectPath}`) };
            },
            async remove(objectPaths: string[]) {
              for (const objectPath of objectPaths) storage.objects.delete(objectPath);
              return { data: objectPaths.map((objectPath) => ({ name: objectPath })), error: null };
            },
          };
        },
      },
    } as unknown as SupabaseClient;
  }
}

interface FixtureFile {
  path: string;
  bytes: Buffer;
  contentType: string;
}

interface StagingFixture {
  root: string;
  backupPath: string;
  restorePath: string;
  files: FixtureFile[];
}

const temporaryRoots: string[] = [];
const independentOrigins = {
  productionSupabaseUrl: "https://production.supabase.co",
  offsiteBackupSupabaseUrl: "https://offsite.supabase.co",
};

async function makeFixture(options: {
  referenced?: boolean;
  files?: FixtureFile[];
  storagePath?: string;
} = {}): Promise<StagingFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-stage-evidence-test-"));
  temporaryRoots.push(root);
  const liveDatabasePath = path.join(root, "live.sqlite");
  const backupPath = path.join(root, "backup");
  const restorePath = path.join(root, "restore");
  const files: FixtureFile[] = options.files ?? [
    { path: "owner/menu.pdf", bytes: Buffer.from("%PDF-restored-menu"), contentType: "application/pdf" },
    { path: "orphan/photo.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: "image/jpeg" },
  ];

  const database = createDatabase(liveDatabasePath);
  if (options.referenced) {
    const repository = new BusinessRepository(database);
    repository.createAccount({
      id: "owner",
      email: "owner@example.com",
      passwordHash: "test-password-hash",
      role: "user",
      subscriptionStatus: "free",
      now: "2026-07-14T00:00:00.000Z",
    });
    database.prepare(
      `INSERT INTO source_evidence_objects (
         id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
         data_base64, external_url, retention_expires_at, deleted_at, created_at
       ) VALUES (?, ?, 'supabase_private', ?, ?, ?, NULL, NULL, ?, NULL, ?)`,
    ).run(
      "menu-evidence",
      "owner",
      files[0]!.path,
      files[0]!.contentType,
      files[0]!.bytes.length,
      "2026-10-14T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
    );
  }
  database.close();

  await createDataBackup({
    sourceDatabase: liveDatabasePath,
    sourceEvidence: path.join(root, "legacy-evidence"),
    backupRoot: backupPath,
  });
  const backupStorageRoot = path.join(backupPath, "supabase-source-evidence");
  fs.mkdirSync(backupStorageRoot, { recursive: true });
  for (const file of files) {
    const destination = path.join(backupStorageRoot, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.bytes);
  }
  const backupFiles = await listBackupFiles(backupStorageRoot);
  await finalizeBackupSupplementalData({
    backupRoot: backupPath,
    storageEvidence: {
      provider: "supabase",
      bucket: "beermap-source-evidence",
      path: options.storagePath ?? "supabase-source-evidence",
      fileCount: backupFiles.length,
      bytes: backupFiles.reduce((total, file) => total + file.bytes, 0),
      files: backupFiles.map((file) => ({
        ...file,
        contentType: files.find((candidate) => candidate.path === file.path)!.contentType,
      })),
      databaseReferenceCount: options.referenced ? 1 : 0,
      orphanPaths: options.referenced ? [files[1]!.path] : files.map((file) => file.path),
      reconciliationAttempts: 1,
    },
    deletionTombstones: [],
  });

  fs.mkdirSync(restorePath, { recursive: true });
  fs.copyFileSync(path.join(backupPath, "pint-path.sqlite"), path.join(restorePath, "pint-path.sqlite"));
  fs.cpSync(backupStorageRoot, path.join(restorePath, "supabase-source-evidence"), { recursive: true });
  return { root, backupPath, restorePath, files };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("staging restored Supabase source evidence", () => {
  it("accepts an authenticated empty Storage restore without materialising its local directory", async () => {
    const fixture = await makeFixture({ files: [] });
    fs.rmSync(path.join(fixture.restorePath, "supabase-source-evidence"), {
      recursive: true,
      force: true,
    });
    const staging = new FakeStagingStorage();

    const result = await stageRestoredSourceEvidence({
      backupPath: fixture.backupPath,
      restorePath: fixture.restorePath,
      stagingSupabaseUrl: "https://staging.supabase.co",
      stagingServiceRoleKey: "staging-secret-key",
      ...independentOrigins,
      clientFactory: () => staging.client(),
    });

    expect(result).toMatchObject({
      bucket: "beermap-source-evidence",
      objectCount: 0,
      bytes: 0,
    });
    expect(result.objectSetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(staging.uploads).toEqual([]);
    expect(staging.objects.size).toBe(0);
  });

  it("keeps empty Storage restores fail-closed for remote and local state", async () => {
    const fixture = await makeFixture({ files: [] });
    const storageRoot = path.join(fixture.restorePath, "supabase-source-evidence");
    fs.rmSync(storageRoot, { recursive: true, force: true });
    const base = {
      backupPath: fixture.backupPath,
      restorePath: fixture.restorePath,
      stagingSupabaseUrl: "https://staging.supabase.co",
      stagingServiceRoleKey: "staging-secret-key",
      ...independentOrigins,
    };

    const publicStaging = new FakeStagingStorage();
    publicStaging.isPublic = true;
    await expect(stageRestoredSourceEvidence({
      ...base,
      clientFactory: () => publicStaging.client(),
    })).rejects.toThrow("must be private");

    const occupiedStaging = new FakeStagingStorage();
    occupiedStaging.objects.set("already/here.pdf", {
      bytes: Buffer.from("occupied"),
      contentType: "application/pdf",
    });
    await expect(stageRestoredSourceEvidence({
      ...base,
      clientFactory: () => occupiedStaging.client(),
    })).rejects.toThrow("must be empty");

    fs.writeFileSync(storageRoot, "not a directory");
    await expect(stageRestoredSourceEvidence({
      ...base,
      clientFactory: () => new FakeStagingStorage().client(),
    })).rejects.toThrow("directory is missing or unsafe");
    fs.rmSync(storageRoot);

    fs.symlinkSync(fixture.root, storageRoot, "dir");
    await expect(stageRestoredSourceEvidence({
      ...base,
      clientFactory: () => new FakeStagingStorage().client(),
    })).rejects.toThrow("directory is missing or unsafe");
    fs.rmSync(storageRoot);

    const lateLocalFile = new FakeStagingStorage();
    lateLocalFile.onGetBucket = () => {
      fs.mkdirSync(storageRoot, { recursive: true });
      fs.writeFileSync(path.join(storageRoot, "unlisted.txt"), "unexpected");
    };
    await expect(stageRestoredSourceEvidence({
      ...base,
      clientFactory: () => lateLocalFile.client(),
    })).rejects.toThrow("unmanifested or deleted object");
  });

  it("rejects a noncanonical Storage manifest path even when the object set is empty", async () => {
    const fixture = await makeFixture({ files: [], storagePath: "other-storage-root" });

    await expect(stageRestoredSourceEvidence({
      backupPath: fixture.backupPath,
      restorePath: fixture.restorePath,
      stagingSupabaseUrl: "https://staging.supabase.co",
      stagingServiceRoleKey: "staging-secret-key",
      ...independentOrigins,
      clientFactory: () => new FakeStagingStorage().client(),
    })).rejects.toThrow("backup Storage path is not supabase-source-evidence");
  });

  it("rejects a missing restored directory when the verified manifest expects objects", async () => {
    const fixture = await makeFixture();
    fs.rmSync(path.join(fixture.restorePath, "supabase-source-evidence"), {
      recursive: true,
      force: true,
    });

    await expect(stageRestoredSourceEvidence({
      backupPath: fixture.backupPath,
      restorePath: fixture.restorePath,
      stagingSupabaseUrl: "https://staging.supabase.co",
      stagingServiceRoleKey: "staging-secret-key",
      ...independentOrigins,
      clientFactory: () => new FakeStagingStorage().client(),
    })).rejects.toThrow("directory is missing or unsafe");
  });

  it("uploads exact paths without upsert and redownload-verifies bytes and manifest MIME types", async () => {
    const fixture = await makeFixture();
    const staging = new FakeStagingStorage();
    let clientArguments: [string, string] | null = null;

    const result = await stageRestoredSourceEvidence({
      backupPath: fixture.backupPath,
      restorePath: fixture.restorePath,
      stagingSupabaseUrl: "https://staging.supabase.co",
      stagingServiceRoleKey: "staging-secret-key",
      ...independentOrigins,
      clientFactory: (url, key) => {
        clientArguments = [url, key];
        return staging.client();
      },
    });

    expect(clientArguments).toEqual(["https://staging.supabase.co", "staging-secret-key"]);
    expect(result).toMatchObject({
      bucket: "beermap-source-evidence",
      objectCount: 2,
      bytes: fixture.files.reduce((total, file) => total + file.bytes.length, 0),
    });
    expect(result.objectSetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(staging.uploads).toEqual([
      { path: "orphan/photo.jpg", contentType: "image/jpeg", upsert: false },
      { path: "owner/menu.pdf", contentType: "application/pdf", upsert: false },
    ]);
    for (const file of fixture.files) {
      expect(staging.objects.get(file.path)).toEqual({ bytes: file.bytes, contentType: file.contentType });
    }
  });

  it("rejects production/off-site project reuse, public buckets, and non-empty buckets", async () => {
    const fixture = await makeFixture();
    const staging = new FakeStagingStorage();
    const base = {
      backupPath: fixture.backupPath,
      restorePath: fixture.restorePath,
      stagingServiceRoleKey: "staging-secret-key",
      ...independentOrigins,
      clientFactory: () => staging.client(),
    };
    await expect(stageRestoredSourceEvidence({
      ...base,
      stagingSupabaseUrl: "https://same.supabase.co",
      productionSupabaseUrl: "https://SAME.supabase.co/",
    })).rejects.toThrow("separate from the production");
    await expect(stageRestoredSourceEvidence({
      ...base,
      stagingSupabaseUrl: "https://same.supabase.co",
      offsiteBackupSupabaseUrl: "https://SAME.supabase.co/",
    })).rejects.toThrow("separate from the off-site backup");
    await expect(stageRestoredSourceEvidence({
      ...base,
      stagingSupabaseUrl: "https://staging.supabase.co",
      productionSupabaseUrl: " ",
    })).rejects.toThrow("production Supabase URL is required");
    await expect(stageRestoredSourceEvidence({
      ...base,
      stagingSupabaseUrl: "https://staging.supabase.co",
      offsiteBackupSupabaseUrl: " ",
    })).rejects.toThrow("off-site backup Supabase URL is required");

    staging.isPublic = true;
    await expect(stageRestoredSourceEvidence({
      ...base,
      stagingSupabaseUrl: "https://staging.supabase.co",
    })).rejects.toThrow("must be private");

    staging.isPublic = false;
    staging.objects.set("already/here.pdf", {
      bytes: Buffer.from("occupied"),
      contentType: "application/pdf",
    });
    await expect(stageRestoredSourceEvidence({
      ...base,
      stagingSupabaseUrl: "https://staging.supabase.co",
    })).rejects.toThrow("must be empty");
  });

  it("rejects files outside the verified manifest and purges partial uploads after verification failure", async () => {
    const fixture = await makeFixture();
    fs.writeFileSync(
      path.join(fixture.restorePath, "supabase-source-evidence", "unlisted.txt"),
      "not in manifest",
    );
    const staging = new FakeStagingStorage();
    const input = {
      backupPath: fixture.backupPath,
      restorePath: fixture.restorePath,
      stagingSupabaseUrl: "https://staging.supabase.co",
      stagingServiceRoleKey: "staging-secret-key",
      ...independentOrigins,
      clientFactory: () => staging.client(),
    };
    await expect(stageRestoredSourceEvidence(input)).rejects.toThrow("unmanifested or deleted object");
    fs.rmSync(path.join(fixture.restorePath, "supabase-source-evidence", "unlisted.txt"));

    staging.downloadContentTypeOverride = "application/octet-stream";
    await expect(stageRestoredSourceEvidence(input)).rejects.toThrow("checksum or MIME verification failed");
    expect(staging.objects.size).toBe(0);
  });

  it("does not re-upload evidence suppressed by the restore's deletion ledger", async () => {
    const fixture = await makeFixture({ referenced: true });
    const restoredDatabase = new BetterSqlite3(path.join(fixture.restorePath, "pint-path.sqlite"));
    restoredDatabase.prepare(
      "UPDATE source_evidence_objects SET byte_size = NULL, deleted_at = ? WHERE object_path = ?",
    ).run("2026-07-14T12:00:00.000Z", "owner/menu.pdf");
    restoredDatabase.close();
    fs.rmSync(path.join(fixture.restorePath, "supabase-source-evidence", "owner", "menu.pdf"));
    const staging = new FakeStagingStorage();

    const result = await stageRestoredSourceEvidence({
      backupPath: fixture.backupPath,
      restorePath: fixture.restorePath,
      stagingSupabaseUrl: "https://staging.supabase.co",
      stagingServiceRoleKey: "staging-secret-key",
      ...independentOrigins,
      clientFactory: () => staging.client(),
    });

    expect(result.objectCount).toBe(1);
    expect(staging.objects.has("owner/menu.pdf")).toBe(false);
    expect(staging.objects.has("orphan/photo.jpg")).toBe(true);
  });

  it("redacts the staging service-role key from provider errors", async () => {
    const fixture = await makeFixture();
    const secret = "staging-service-role-secret-value";
    let captured: Error | null = null;
    try {
      await stageRestoredSourceEvidence({
        backupPath: fixture.backupPath,
        restorePath: fixture.restorePath,
        stagingSupabaseUrl: "https://staging.supabase.co",
        stagingServiceRoleKey: secret,
        ...independentOrigins,
        clientFactory: () => {
          throw new Error(`Provider rejected ${secret}`);
        },
      });
    } catch (error) {
      captured = error as Error;
    }
    expect(captured?.message).toContain("[REDACTED]");
    expect(captured?.message).not.toContain(secret);
  });

  it("rejects a restored database symlink before SQLite opens it", async () => {
    const fixture = await makeFixture();
    const databasePath = path.join(fixture.restorePath, "pint-path.sqlite");
    const targetPath = path.join(fixture.root, "symlink-target.sqlite");
    fs.renameSync(databasePath, targetPath);
    fs.symlinkSync(targetPath, databasePath);

    await expect(stageRestoredSourceEvidence({
      backupPath: fixture.backupPath,
      restorePath: fixture.restorePath,
      stagingSupabaseUrl: "https://staging.supabase.co",
      stagingServiceRoleKey: "staging-secret-key",
      ...independentOrigins,
      clientFactory: () => new FakeStagingStorage().client(),
    })).rejects.toThrow("Restored database is missing or unsafe");
  });

  it("keeps the CLI blocked before credential or restore-file access without disposable-project authority", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import=tsx",
        path.resolve(process.cwd(), "scripts/stage-restored-source-evidence.ts"),
        "--backup=/does-not-exist",
        "--restore=/does-not-exist",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          STAGING_SUPABASE_URL: "https://bbfibbadwjxzrcdncavy.supabase.co",
          STAGING_SUPABASE_SERVICE_ROLE_KEY: BLOCKED_CLI_SERVICE_ROLE_KEY,
          SUPABASE_URL: "https://auth.pintpath.au",
          OFFSITE_BACKUP_SUPABASE_URL: "https://hfbmhdxrwtihukmixxta.supabase.co",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: "Restore-staging evidence transport is unavailable until a reviewed disposable-project authority is registered.",
    });
    expect(result.stderr).not.toContain(BLOCKED_CLI_SERVICE_ROLE_KEY);
  });

  it("rejects the library before filesystem access when no test-only transport is injected", async () => {
    await expect(stageRestoredSourceEvidence({
      backupPath: "/does-not-exist/backup",
      restorePath: "/does-not-exist/restore",
      stagingSupabaseUrl: "https://unregistered.invalid",
      stagingServiceRoleKey: BLOCKED_LIBRARY_SERVICE_ROLE_KEY,
      ...independentOrigins,
    })).rejects.toThrow(
      "Restore-staging evidence transport is unavailable until a reviewed disposable-project authority is registered.",
    );
  });
});
