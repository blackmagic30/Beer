import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import BetterSqlite3 from "better-sqlite3";

import {
  type BackupStorageFile,
  sha256Bytes,
  sha256File,
  verifyDataBackup,
} from "./data-backup.js";
import { createServerSupabaseClient } from "./supabase-client.js";

const STAGING_EVIDENCE_BUCKET = "beermap-source-evidence";
const RESTORED_STORAGE_DIRECTORY = "supabase-source-evidence";
const RESTORED_DATABASE_FILENAME = "pint-path.sqlite";

interface RestoredStorageReference {
  objectPath: string;
  mimeType: string | null;
  byteSize: number | null;
  deletedAt: string | null;
}

interface LocalStorageFile extends BackupStorageFile {
  absolutePath: string;
}

export interface StageRestoredSourceEvidenceInput {
  backupPath: string;
  restorePath: string;
  stagingSupabaseUrl: string;
  stagingServiceRoleKey: string;
  productionSupabaseUrl: string;
  offsiteBackupSupabaseUrl: string;
  clientFactory?: ((url: string, serviceRoleKey: string) => SupabaseClient) | undefined;
}

export interface StageRestoredSourceEvidenceResult {
  bucket: typeof STAGING_EVIDENCE_BUCKET;
  objectCount: number;
  bytes: number;
  objectSetSha256: string;
  backupCreatedAt: string;
}

function normalizeProjectOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS.`);
  }
  return url.origin.toLowerCase();
}

function assertIndependentStagingProject(input: StageRestoredSourceEvidenceInput): string {
  const stagingOrigin = normalizeProjectOrigin(input.stagingSupabaseUrl, "STAGING_SUPABASE_URL");
  const forbidden = [
    ["production", input.productionSupabaseUrl],
    ["off-site backup", input.offsiteBackupSupabaseUrl],
  ] as const;
  for (const [purpose, candidate] of forbidden) {
    if (!candidate.trim()) throw new Error(`The ${purpose} Supabase URL is required.`);
    if (normalizeProjectOrigin(candidate.trim(), `${purpose} Supabase URL`) === stagingOrigin) {
      throw new Error(`The staging Storage project must be separate from the ${purpose} Supabase project.`);
    }
  }
  return stagingOrigin;
}

function assertSafeObjectPath(objectPath: string): void {
  if (
    !objectPath ||
    objectPath.includes("\\") ||
    objectPath.includes("\0") ||
    path.posix.isAbsolute(objectPath) ||
    path.posix.normalize(objectPath) !== objectPath ||
    objectPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe Storage object path in backup manifest: ${objectPath}`);
  }
}

function normalizeContentType(value: string, objectPath: string): string {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)) {
    throw new Error(`Invalid Storage MIME type in backup manifest: ${objectPath}`);
  }
  return normalized;
}

function resolveContainedObjectPath(root: string, objectPath: string): string {
  assertSafeObjectPath(objectPath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...objectPath.split("/"));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe restored Storage object path: ${objectPath}`);
  }
  return resolved;
}

async function collectLocalStorageFiles(root: string): Promise<LocalStorageFile[]> {
  const rootStat = await fs.promises.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Restored Storage evidence directory is missing or unsafe: ${root}`);
  }

  const files: LocalStorageFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic links are forbidden in restored Storage evidence: ${entry.name}`);
      }
      if (stat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Only regular files are allowed in restored Storage evidence: ${entry.name}`);
      }
      const objectPath = path.relative(root, absolutePath).split(path.sep).join("/");
      assertSafeObjectPath(objectPath);
      files.push({
        path: objectPath,
        absolutePath,
        bytes: stat.size,
        sha256: await sha256File(absolutePath),
        contentType: "",
      });
    }
  };
  await visit(root);
  return files.sort((first, second) => first.path.localeCompare(second.path));
}

function readRestoredStorageReferences(databasePath: string): RestoredStorageReference[] {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    const table = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_evidence_objects' LIMIT 1",
    ).get();
    if (!table) throw new Error("Restored database is missing source_evidence_objects.");
    return database.prepare(
      `SELECT object_path AS objectPath, mime_type AS mimeType, byte_size AS byteSize,
              deleted_at AS deletedAt
         FROM source_evidence_objects
        WHERE storage_provider = 'supabase_private'
        ORDER BY object_path ASC`,
    ).all() as RestoredStorageReference[];
  } finally {
    database.close();
  }
}

function expectedRestoredFiles(input: {
  manifestFiles: BackupStorageFile[];
  references: RestoredStorageReference[];
}): BackupStorageFile[] {
  const byPath = new Map<string, BackupStorageFile>();
  for (const file of input.manifestFiles) {
    assertSafeObjectPath(file.path);
    if (byPath.has(file.path)) throw new Error(`Duplicate Storage object in backup manifest: ${file.path}`);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error(`Invalid Storage checksum metadata in backup manifest: ${file.path}`);
    }
    byPath.set(file.path, {
      ...file,
      sha256: file.sha256.toLowerCase(),
      contentType: normalizeContentType(file.contentType, file.path),
    });
  }

  const referencesByPath = new Map<string, RestoredStorageReference>();
  for (const reference of input.references) {
    assertSafeObjectPath(reference.objectPath);
    if (reference.deletedAt && Number.isNaN(Date.parse(reference.deletedAt))) {
      throw new Error(`Invalid deletion timestamp in restored database: ${reference.objectPath}`);
    }
    if (referencesByPath.has(reference.objectPath)) {
      throw new Error(`Duplicate Storage path in restored database: ${reference.objectPath}`);
    }
    referencesByPath.set(reference.objectPath, reference);
    const manifestFile = byPath.get(reference.objectPath);
    if (!manifestFile) {
      if (reference.deletedAt) continue;
      throw new Error(`Live restored database evidence is absent from the verified backup: ${reference.objectPath}`);
    }
    if (reference.deletedAt) continue;
    const databaseMimeType = reference.mimeType
      ? normalizeContentType(reference.mimeType, reference.objectPath)
      : null;
    if (
      (reference.byteSize !== null && reference.byteSize !== manifestFile.bytes) ||
      (databaseMimeType !== null && databaseMimeType !== manifestFile.contentType)
    ) {
      throw new Error(`Restored database evidence metadata differs from the verified backup: ${reference.objectPath}`);
    }
  }

  return [...byPath.values()]
    .filter((file) => !referencesByPath.get(file.path)?.deletedAt)
    .sort((first, second) => first.path.localeCompare(second.path));
}

function assertLocalFilesMatch(
  actualFiles: LocalStorageFile[],
  expectedFiles: BackupStorageFile[],
): LocalStorageFile[] {
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file]));
  for (const actual of actualFiles) {
    const expected = expectedByPath.get(actual.path);
    if (!expected) {
      throw new Error(`Restored Storage evidence contains an unmanifested or deleted object: ${actual.path}`);
    }
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`Restored Storage evidence does not match the verified backup: ${actual.path}`);
    }
    actual.contentType = expected.contentType;
  }
  const actualPaths = new Set(actualFiles.map((file) => file.path));
  const missing = expectedFiles.find((file) => !actualPaths.has(file.path));
  if (missing) throw new Error(`Restored Storage evidence is missing a required object: ${missing.path}`);
  return actualFiles;
}

function assertSafeRemoteSegment(segment: string): void {
  if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
    throw new Error("The staging bucket returned an unsafe object name.");
  }
}

async function collectRemoteObjectPaths(
  client: SupabaseClient,
  bucket: string,
  prefix = "",
  depth = 0,
): Promise<string[]> {
  if (depth > 128) throw new Error("The staging bucket contains an excessively deep object tree.");
  const paths: string[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await client.storage.from(bucket).list(prefix, {
      limit: 100,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    const entries = data ?? [];
    for (const entry of entries) {
      assertSafeRemoteSegment(entry.name);
      const objectPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id || entry.metadata) {
        paths.push(objectPath);
      } else {
        paths.push(...await collectRemoteObjectPaths(client, bucket, objectPath, depth + 1));
      }
    }
    if (entries.length < 100) break;
    offset += entries.length;
  }
  return paths.sort((first, second) => first.localeCompare(second));
}

function safeErrorMessage(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  return message;
}

function objectSetSha256(files: BackupStorageFile[]): string {
  return sha256Bytes(Buffer.from(JSON.stringify(files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
    contentType: file.contentType,
  })))));
}

export async function stageRestoredSourceEvidence(
  input: StageRestoredSourceEvidenceInput,
): Promise<StageRestoredSourceEvidenceResult> {
  const serviceRoleKey = input.stagingServiceRoleKey.trim();
  if (!serviceRoleKey) throw new Error("STAGING_SUPABASE_SERVICE_ROLE_KEY is required.");
  const stagingUrl = input.stagingSupabaseUrl.trim();
  const stagingOrigin = assertIndependentStagingProject({ ...input, stagingSupabaseUrl: stagingUrl });

  const backupRoot = path.resolve(input.backupPath);
  const restoreRoot = path.resolve(input.restorePath);
  const restoreStat = await fs.promises.lstat(restoreRoot).catch(() => null);
  if (!restoreStat?.isDirectory() || restoreStat.isSymbolicLink()) {
    throw new Error(`Restore rehearsal directory is missing or unsafe: ${restoreRoot}`);
  }
  const manifest = await verifyDataBackup(backupRoot);
  if (!manifest.storageEvidence || manifest.storageEvidence.provider !== "supabase") {
    throw new Error("The verified backup does not contain Supabase Storage evidence.");
  }
  if (manifest.storageEvidence.bucket !== STAGING_EVIDENCE_BUCKET) {
    throw new Error(`The backup Storage bucket is not ${STAGING_EVIDENCE_BUCKET}.`);
  }

  const storageRoot = path.join(restoreRoot, RESTORED_STORAGE_DIRECTORY);
  const databasePath = path.join(restoreRoot, RESTORED_DATABASE_FILENAME);
  const databaseStat = await fs.promises.lstat(databasePath).catch(() => null);
  if (!databaseStat?.isFile() || databaseStat.isSymbolicLink()) {
    throw new Error(`Restored database is missing or unsafe: ${databasePath}`);
  }
  const expectedFiles = expectedRestoredFiles({
    manifestFiles: manifest.storageEvidence.files,
    references: readRestoredStorageReferences(databasePath),
  });
  const localFiles = assertLocalFilesMatch(await collectLocalStorageFiles(storageRoot), expectedFiles);
  const uploadedPaths: string[] = [];
  let client: SupabaseClient | null = null;

  try {
    client = input.clientFactory
      ? input.clientFactory(stagingOrigin, serviceRoleKey)
      : createServerSupabaseClient(stagingOrigin, serviceRoleKey, { timeoutMs: 120_000 });
    const { data: bucket, error: bucketError } = await client.storage.getBucket(STAGING_EVIDENCE_BUCKET);
    if (bucketError || !bucket) throw bucketError ?? new Error("The staging evidence bucket is unavailable.");
    if (bucket.public !== false) throw new Error("The staging evidence bucket must be private.");
    if ((await collectRemoteObjectPaths(client, STAGING_EVIDENCE_BUCKET)).length > 0) {
      throw new Error("The staging evidence bucket must be empty before a restore drill.");
    }

    for (const file of localFiles) {
      const absolutePath = resolveContainedObjectPath(storageRoot, file.path);
      const bytes = await fs.promises.readFile(absolutePath);
      if (bytes.length !== file.bytes || sha256Bytes(bytes) !== file.sha256) {
        throw new Error(`Restored Storage evidence changed during staging: ${file.path}`);
      }
      const { error } = await client.storage.from(STAGING_EVIDENCE_BUCKET).upload(
        file.path,
        bytes,
        { contentType: file.contentType, upsert: false },
      );
      if (error) throw error;
      uploadedPaths.push(file.path);
    }

    const remotePaths = await collectRemoteObjectPaths(client, STAGING_EVIDENCE_BUCKET);
    if (
      remotePaths.length !== uploadedPaths.length ||
      remotePaths.some((objectPath, index) => objectPath !== uploadedPaths[index])
    ) {
      throw new Error("The staging evidence bucket changed while objects were uploaded.");
    }

    for (const file of localFiles) {
      const { data, error } = await client.storage.from(STAGING_EVIDENCE_BUCKET).download(file.path);
      if (error || !data) throw error ?? new Error(`Could not verify staged object: ${file.path}`);
      const bytes = Buffer.from(await data.arrayBuffer());
      const contentType = data.type?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (
        bytes.length !== file.bytes ||
        sha256Bytes(bytes) !== file.sha256 ||
        contentType !== file.contentType
      ) {
        throw new Error(`Staged Storage checksum or MIME verification failed: ${file.path}`);
      }
    }

    const finalLocalFiles = assertLocalFilesMatch(
      await collectLocalStorageFiles(storageRoot),
      expectedFiles,
    );
    return {
      bucket: STAGING_EVIDENCE_BUCKET,
      objectCount: finalLocalFiles.length,
      bytes: finalLocalFiles.reduce((total, file) => total + file.bytes, 0),
      objectSetSha256: objectSetSha256(expectedFiles),
      backupCreatedAt: manifest.createdAt,
    };
  } catch (error) {
    let cleanupError: unknown = null;
    if (client) {
      for (let index = 0; index < uploadedPaths.length; index += 100) {
        const { error: removeError } = await client.storage
          .from(STAGING_EVIDENCE_BUCKET)
          .remove(uploadedPaths.slice(index, index + 100));
        if (removeError) {
          cleanupError = removeError;
          break;
        }
      }
    }
    const message = safeErrorMessage(error, [serviceRoleKey]);
    if (cleanupError) {
      throw new Error(`${message} Cleanup failed: ${safeErrorMessage(cleanupError, [serviceRoleKey])}`);
    }
    throw new Error(message);
  }
}
