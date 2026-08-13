import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../src/db/database.js";
import {
  createDataBackup,
  listBackupFiles,
  sha256Bytes,
} from "../src/lib/data-backup.js";
import {
  assertImmutableBackupId,
  createReadOnlyOffsiteFetch,
  downloadOffsiteBackup,
  readPrivateSecretFile,
} from "../src/lib/offsite-backup-download.js";
import {
  OPERATIONAL_OFFSITE_BACKUP_BUCKET,
  OPERATIONAL_OFFSITE_SUPABASE_ORIGIN,
} from "../src/lib/supabase-key-format.js";

interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

class FakeBackupStorage {
  readonly objects = new Map<string, StoredObject>();
  readonly listedPrefixes: string[] = [];
  readonly downloadedPaths: string[] = [];
  unsafeEntryName: string | null = null;
  publicBucket = false;
  repeatCursor = false;
  readonly reportedSizes = new Map<string, number>();
  mutateAfterStream: ((objectPath: string) => void) | null = null;

  client(): SupabaseClient {
    const storage = this;
    return {
      storage: {
        async getBucket(name: string) {
          return name === "pintpath-backups"
            ? {
                data: { id: name, name, public: storage.publicBucket },
                error: null,
              }
            : { data: null, error: new Error("Missing bucket") };
        },
        from(name: string) {
          if (name !== "pintpath-backups") throw new Error("Unexpected bucket");
          return {
            async listV2(options?: {
              prefix?: string;
              limit?: number;
              cursor?: string;
            }) {
              const prefix = options?.prefix ?? "";
              storage.listedPrefixes.push(prefix);
              const children: Array<{
                name: string;
                key: string;
                id: string;
                metadata: Record<string, unknown> | null;
                created_at: string;
                updated_at: string;
                last_accessed_at: string;
              }> = [];
              for (const [objectPath, object] of storage.objects) {
                if (!objectPath.startsWith(prefix)) continue;
                const remainder = objectPath.slice(prefix.length);
                if (!remainder) continue;
                children.push({
                  name: remainder,
                  key: objectPath,
                  id: `id-${objectPath}`,
                  metadata: {
                    mimetype: object.contentType,
                    size: object.bytes.length,
                  },
                  created_at: "2026-07-18T03:04:05.000Z",
                  updated_at: "2026-07-18T03:04:05.000Z",
                  last_accessed_at: "2026-07-18T03:04:05.000Z",
                });
              }
              if (prefix === `${backupId}/` && storage.unsafeEntryName) {
                children.push({
                  name: storage.unsafeEntryName,
                  key: `${prefix}${storage.unsafeEntryName}`,
                  id: "unsafe-object",
                  metadata: { mimetype: "application/octet-stream" },
                  created_at: "2026-07-18T03:04:05.000Z",
                  updated_at: "2026-07-18T03:04:05.000Z",
                  last_accessed_at: "2026-07-18T03:04:05.000Z",
                });
              }
              const ordered = children.sort((first, second) =>
                first.name.localeCompare(second.name),
              );
              const offset = Number(options?.cursor ?? 0);
              const limit = options?.limit ?? 100;
              const objects = ordered.slice(offset, offset + limit);
              const nextOffset = offset + objects.length;
              return {
                data: {
                  objects,
                  folders: [],
                  hasNext: nextOffset < ordered.length,
                  ...(nextOffset < ordered.length
                    ? {
                        nextCursor: storage.repeatCursor
                          ? "0"
                          : String(nextOffset),
                      }
                    : {}),
                },
                error: null,
              };
            },
            download(objectPath: string) {
              storage.downloadedPaths.push(objectPath);
              const object = storage.objects.get(objectPath);
              const blobResult = object
                ? {
                    data: new Blob([object.bytes], {
                      type: object.contentType,
                    }),
                    error: null,
                  }
                : { data: null, error: new Error("Missing object") };
              const builder = Promise.resolve(blobResult) as Promise<
                typeof blobResult
              > & {
                asStream: () => Promise<{
                  data: ReadableStream<Uint8Array> | null;
                  error: Error | null;
                }>;
              };
              builder.asStream = async () => {
                if (!object)
                  return { data: null, error: new Error("Missing object") };
                const stream = new Blob([object.bytes]).stream();
                storage.mutateAfterStream?.(objectPath);
                return { data: stream, error: null };
              };
              return builder;
            },
            async info(objectPath: string) {
              const object = storage.objects.get(objectPath);
              return object
                ? {
                    data: {
                      id: `id-${objectPath}`,
                      version: "1",
                      name: objectPath,
                      bucketId: name,
                      size:
                        storage.reportedSizes.get(objectPath) ??
                        object.bytes.length,
                      cacheControl: "3600",
                      contentType: object.contentType,
                      etag: `etag-${objectPath}`,
                      createdAt: "2026-07-18T03:04:05.000Z",
                      updatedAt: "2026-07-18T03:04:05.000Z",
                      lastModified: "2026-07-18T03:04:05.000Z",
                      metadata: {
                        mimetype: object.contentType,
                        size: object.bytes.length,
                      },
                    },
                    error: null,
                  }
                : { data: null, error: new Error("Missing object") };
            },
          };
        },
      },
    } as unknown as SupabaseClient;
  }
}

const roots: string[] = [];
const backupId = "pint-path-2026-07-18T03-04-05-006Z";

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pint-path-backup-download-test-"),
  );
  roots.push(root);
  return root;
}

async function populateValidBackup(
  storage: FakeBackupStorage,
  root: string,
): Promise<void> {
  const databasePath = path.join(root, "source.sqlite");
  createDatabase(databasePath).close();
  const localBackup = path.join(root, "source-backup");
  await createDataBackup({
    sourceDatabase: databasePath,
    sourceEvidence: path.join(root, "source-evidence"),
    backupRoot: localBackup,
  });
  for (const file of await listBackupFiles(localBackup)) {
    storage.objects.set(`${backupId}/${file.path}`, {
      bytes: await fs.promises.readFile(path.join(localBackup, file.path)),
      contentType: file.path.endsWith(".json")
        ? "application/json"
        : "application/octet-stream",
    });
  }
}

function downloadInput(storage: FakeBackupStorage, outputPath: string) {
  return {
    destinationSupabaseUrl: OPERATIONAL_OFFSITE_SUPABASE_ORIGIN,
    destinationServiceRoleKey: ["sb", "secret", "download_boundary_abcdefghijk"].join("_"),
    bucketName: OPERATIONAL_OFFSITE_BACKUP_BUCKET,
    backupId,
    expectedManifestSha256: storage.objects.has(`${backupId}/manifest.json`)
      ? sha256Bytes(storage.objects.get(`${backupId}/manifest.json`)!.bytes)
      : "0".repeat(64),
    outputPath,
    pageSize: 2,
    clientFactory: () => storage.client(),
  };
}

describe("off-site backup SDK downloader", () => {
  it("downloads only the exact immutable prefix with pagination and verifies it", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    storage.objects.set("pint-path-2026-07-18T03-04-05-007Z/manifest.json", {
      bytes: Buffer.from("sibling must not be downloaded"),
      contentType: "application/json",
    });
    const outputPath = path.join(root, "downloaded");

    const result = await downloadOffsiteBackup(
      downloadInput(storage, outputPath),
    );

    expect(result).toMatchObject({
      backupId,
      outputPath,
      objectCount: 3,
      filesystemEvidenceFiles: 0,
      storageEvidenceFiles: 0,
      deletionTombstones: 0,
    });
    expect(
      storage.listedPrefixes.every((prefix) => prefix.startsWith(backupId)),
    ).toBe(true);
    expect(
      storage.downloadedPaths.every((objectPath) =>
        objectPath.startsWith(`${backupId}/`),
      ),
    ).toBe(true);
    expect(
      storage.downloadedPaths.some((objectPath) =>
        objectPath.endsWith("-007Z/manifest.json"),
      ),
    ).toBe(false);
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o700);
    expect(
      fs.statSync(path.join(outputPath, "manifest.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it("rejects an undeclared object instead of accepting files outside the manifest", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    storage.objects.set(`${backupId}/extra/nested/notes.txt`, {
      bytes: Buffer.from("undeclared object"),
      contentType: "text/plain",
    });
    const outputPath = path.join(root, "extra-object-download");

    await expect(
      downloadOffsiteBackup(downloadInput(storage, outputPath)),
    ).rejects.toThrow("does not exactly match its manifest");
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("rejects a manifest-declared object that is missing remotely", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    storage.objects.delete(`${backupId}/pint-path.sqlite`);

    await expect(
      downloadOffsiteBackup(downloadInput(storage, path.join(root, "missing"))),
    ).rejects.toThrow("does not exactly match its manifest");
  });

  it("rejects a repeated cursor instead of looping or accepting an unstable page", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    storage.repeatCursor = true;
    const input = {
      ...downloadInput(storage, path.join(root, "repeated-cursor")),
      pageSize: 1,
    };

    await expect(downloadOffsiteBackup(input)).rejects.toThrow(
      "repeated cursor",
    );
  });

  it("rejects a public destination bucket", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    storage.publicBucket = true;

    await expect(
      downloadOffsiteBackup(downloadInput(storage, path.join(root, "public"))),
    ).rejects.toThrow("not private");
  });

  it("requires the trusted production manifest digest", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    const input = {
      ...downloadInput(storage, path.join(root, "wrong-manifest")),
      expectedManifestSha256: "0".repeat(64),
    };

    await expect(downloadOffsiteBackup(input)).rejects.toThrow(
      "trusted production SHA-256",
    );
  });

  it("rejects non-exact or impossible backup IDs before accessing Storage", async () => {
    expect(() => assertImmutableBackupId("latest.json")).toThrow(
      "exact immutable",
    );
    expect(() =>
      assertImmutableBackupId("pint-path-2026-02-31T03-04-05-006Z"),
    ).toThrow("invalid timestamp");
  });

  it("rejects unreviewed destination credentials before output or client access", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    const outputPath = path.join(root, "blocked-output");
    const clientFactory = vi.fn(() => storage.client());
    const valid = {
      ...downloadInput(storage, outputPath),
      clientFactory,
    };
    for (const candidate of [
      { ...valid, destinationSupabaseUrl: "https://attacker.invalid" },
      { ...valid, destinationServiceRoleKey: "sb_publishable_wrong_slot_abcdefghij" },
      { ...valid, bucketName: ` ${OPERATIONAL_OFFSITE_BACKUP_BUCKET}` },
    ]) {
      await expect(downloadOffsiteBackup(candidate)).rejects.toThrow();
    }
    expect(clientFactory).not.toHaveBeenCalled();
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("rejects traversal components and leaves no partial output", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    storage.unsafeEntryName = "..";
    const outputPath = path.join(root, "unsafe-download");

    await expect(
      downloadOffsiteBackup(downloadInput(storage, outputPath)),
    ).rejects.toThrow("unsafe object path component");
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("removes the partial directory when manifest verification fails", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    storage.objects.get(`${backupId}/manifest.json`)!.bytes =
      Buffer.from('{"invalid":true}');
    const outputPath = path.join(root, "corrupt-download");

    await expect(
      downloadOffsiteBackup(downloadInput(storage, outputPath)),
    ).rejects.toThrow();
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("removes partial output when an object does not match its manifest checksum", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    const databaseObject = storage.objects.get(`${backupId}/pint-path.sqlite`)!;
    databaseObject.bytes = Buffer.alloc(databaseObject.bytes.length, 1);
    const outputPath = path.join(root, "checksum-failure-download");

    await expect(
      downloadOffsiteBackup(downloadInput(storage, outputPath)),
    ).rejects.toThrow("integrity verification");
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("stops a streamed object that grows beyond the manifest byte size", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    const objectPath = `${backupId}/pint-path.sqlite`;
    const databaseObject = storage.objects.get(objectPath)!;
    const expectedBytes = databaseObject.bytes.length;
    databaseObject.bytes = Buffer.concat([
      databaseObject.bytes,
      Buffer.from("overflow"),
    ]);
    storage.reportedSizes.set(objectPath, expectedBytes);
    const outputPath = path.join(root, "overflow-download");

    await expect(
      downloadOffsiteBackup(downloadInput(storage, outputPath)),
    ).rejects.toThrow("exceeds its manifest byte size");
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("detects an object that changes during its streamed download", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    const objectPath = `${backupId}/pint-path.sqlite`;
    storage.mutateAfterStream = (downloadedPath) => {
      if (downloadedPath !== objectPath) return;
      storage.mutateAfterStream = null;
      storage.objects.get(objectPath)!.contentType = "application/x-mutated";
    };

    await expect(
      downloadOffsiteBackup(
        downloadInput(storage, path.join(root, "mutation")),
      ),
    ).rejects.toThrow("changed during download");
  });

  it("reports cleanup failure instead of silently leaving partial output", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    await populateValidBackup(storage, root);
    storage.objects.get(`${backupId}/pint-path.sqlite`)!.bytes =
      Buffer.from("not sqlite");
    const outputPath = path.join(root, "cleanup-failure-download");
    const remove = vi
      .spyOn(fs.promises, "rm")
      .mockRejectedValueOnce(new Error("cleanup denied"));

    await expect(
      downloadOffsiteBackup(downloadInput(storage, outputPath)),
    ).rejects.toThrow("partial output remains");
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(
      fs
        .readdirSync(root)
        .some((entry) =>
          entry.startsWith(".cleanup-failure-download.partial-"),
        ),
    ).toBe(true);
    remove.mockRestore();
  });

  it("preserves a pre-existing output path instead of deleting or replacing it", async () => {
    const root = temporaryRoot();
    const storage = new FakeBackupStorage();
    const outputPath = path.join(root, "existing");
    fs.mkdirSync(outputPath);
    fs.writeFileSync(path.join(outputPath, "keep.txt"), "keep");

    await expect(
      downloadOffsiteBackup(downloadInput(storage, outputPath)),
    ).rejects.toThrow("already exists");
    expect(fs.readFileSync(path.join(outputPath, "keep.txt"), "utf8")).toBe(
      "keep",
    );
    expect(storage.listedPrefixes).toHaveLength(0);
  });

  it("accepts only private regular secret-key files", async () => {
    const root = temporaryRoot();
    const secretPath = path.join(root, "backup.secret");
    fs.writeFileSync(secretPath, "service-role-secret", { mode: 0o600 });
    expect(await readPrivateSecretFile(secretPath)).toBe("service-role-secret");

    fs.writeFileSync(secretPath, "service-role-secret\n", { mode: 0o600 });
    await expect(readPrivateSecretFile(secretPath)).rejects.toThrow(
      "no whitespace or line ending",
    );
    fs.writeFileSync(secretPath, "service-role-secret", { mode: 0o600 });

    fs.chmodSync(secretPath, 0o644);
    await expect(readPrivateSecretFile(secretPath)).rejects.toThrow(
      "group or other users",
    );

    const linkPath = path.join(root, "backup-secret-link");
    fs.symlinkSync(secretPath, linkPath);
    await expect(readPrivateSecretFile(linkPath)).rejects.toThrow(
      "non-symbolic-link",
    );
  });

  it("blocks writes, foreign origins, insecure origins, and other prefixes at fetch", async () => {
    const calls: string[] = [];
    const redirects: Array<RequestRedirect | undefined> = [];
    const guarded = createReadOnlyOffsiteFetch({
      projectOrigin: "https://independent-backup.supabase.co",
      bucketName: "pintpath-backups",
      backupId,
      fetchImplementation: async (input, init) => {
        calls.push(String(input));
        redirects.push(init?.redirect);
        return new Response("{}", { status: 200 });
      },
    });
    await guarded(
      "https://independent-backup.supabase.co/storage/v1/bucket/pintpath-backups",
    );
    await guarded(
      "https://independent-backup.supabase.co/storage/v1/object/list-v2/pintpath-backups",
      {
        method: "POST",
        body: JSON.stringify({ prefix: `${backupId}/`, with_delimiter: false }),
      },
    );
    await guarded(
      `https://independent-backup.supabase.co/storage/v1/object/pintpath-backups/${backupId}/manifest.json`,
    );
    expect(calls).toHaveLength(3);
    expect(redirects).toEqual(["error", "error", "error"]);

    await expect(
      guarded(
        `https://independent-backup.supabase.co/storage/v1/object/pintpath-backups/${backupId}/file`,
        { method: "PUT", body: "secret" },
      ),
    ).rejects.toThrow("Blocked");
    await expect(
      guarded("https://evil.example/storage/v1/bucket/pintpath-backups"),
    ).rejects.toThrow("Blocked");
    await expect(
      guarded(
        "https://independent-backup.supabase.co/storage/v1/object/list-v2/pintpath-backups",
        {
          method: "POST",
          body: JSON.stringify({ prefix: "other/", with_delimiter: false }),
        },
      ),
    ).rejects.toThrow("Blocked");
    expect(() =>
      createReadOnlyOffsiteFetch({
        projectOrigin: "http://independent-backup.supabase.co",
        bucketName: "pintpath-backups",
        backupId,
      }),
    ).toThrow("bare HTTPS");
  });
});
