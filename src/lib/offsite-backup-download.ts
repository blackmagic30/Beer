import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type BackupFile,
  type BackupManifest,
  sha256Bytes,
  sha256File,
  verifyDataBackup,
} from "./data-backup.js";
import { createServerSupabaseClient } from "./supabase-client.js";

const BACKUP_ID_PATTERN =
  /^pint-path-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const DEFAULT_PAGE_SIZE = 100;
const MAX_REMOTE_FILES = 1_000_000;
const MAX_DIRECTORY_DEPTH = 64;
const DOWNLOAD_REQUEST_TIMEOUT_MS = 60_000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

interface RemoteBackupFile {
  objectPath: string;
  relativePath: string;
  fingerprint: string;
}

export interface DownloadOffsiteBackupInput {
  destinationSupabaseUrl: string;
  destinationServiceRoleKey: string;
  bucketName: string;
  backupId: string;
  expectedManifestSha256: string;
  outputPath: string;
  requestTimeoutMs?: number;
  pageSize?: number;
  signal?: AbortSignal;
  clientFactory?: (url: string, serviceRoleKey: string) => SupabaseClient;
}

export interface DownloadOffsiteBackupResult {
  backupId: string;
  manifestSha256: string;
  outputPath: string;
  objectCount: number;
  bytes: number;
  databaseBytes: number;
  filesystemEvidenceFiles: number;
  storageEvidenceFiles: number;
  deletionTombstones: number;
}

export function assertImmutableBackupId(value: string): string {
  const backupId = value.trim();
  const match = BACKUP_ID_PATTERN.exec(backupId);
  if (!match) {
    throw new Error(
      "Backup ID must be an exact immutable pint-path timestamp ID.",
    );
  }
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const timestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error("Backup ID contains an invalid timestamp.");
  }
  return backupId;
}

function assertSecureProjectOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Off-site backup destination URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Off-site backup destination must be a bare HTTPS project origin.",
    );
  }
  return url.origin;
}

function assertSafeBucketName(value: string): string {
  const bucketName = value.trim();
  if (
    !/^[A-Za-z0-9_.-]{1,100}$/.test(bucketName) ||
    bucketName.includes("..")
  ) {
    throw new Error("Off-site backup bucket name is invalid.");
  }
  return bucketName;
}

function requestUrl(input: URL | RequestInfo): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

function requestMethod(input: URL | RequestInfo, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  return typeof Request !== "undefined" && input instanceof Request
    ? input.method.toUpperCase()
    : "GET";
}

/**
 * Prevents the privileged operator credential from being used for any write or
 * any read outside the selected private bucket and immutable backup prefix.
 */
export function createReadOnlyOffsiteFetch(input: {
  projectOrigin: string;
  bucketName: string;
  backupId: string;
  fetchImplementation?: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  const origin = assertSecureProjectOrigin(input.projectOrigin);
  const bucketName = assertSafeBucketName(input.bucketName);
  const backupId = assertImmutableBackupId(input.backupId);
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const bucketPath = `/storage/v1/bucket/${bucketName}`;
  const listPath = `/storage/v1/object/list-v2/${bucketName}`;
  const objectPrefix = `/storage/v1/object/${bucketName}/${backupId}/`;
  const infoPrefix = `/storage/v1/object/info/${bucketName}/${backupId}/`;

  return async (requestInput, init) => {
    const url = requestUrl(requestInput);
    const method = requestMethod(requestInput, init);
    let allowed =
      url.origin === origin &&
      !url.search &&
      !url.hash &&
      ((method === "GET" && url.pathname === bucketPath) ||
        (method === "GET" && url.pathname.startsWith(objectPrefix)) ||
        (method === "GET" && url.pathname.startsWith(infoPrefix)));

    if (
      url.origin === origin &&
      method === "POST" &&
      url.pathname === listPath
    ) {
      try {
        const body = JSON.parse(String(init?.body ?? "")) as Record<
          string,
          unknown
        >;
        allowed =
          body.prefix === `${backupId}/` && body.with_delimiter === false;
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      throw new Error(
        "Blocked a non-read-only or out-of-scope off-site backup request.",
      );
    }
    // A redirect would escape the path/origin decision above after the
    // privileged Authorization header has already been attached by the SDK.
    // Fail closed instead of allowing the underlying fetch to follow it.
    return fetchImplementation(requestInput, { ...init, redirect: "error" });
  };
}

function assertSafeEntryName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      "Off-site backup contains an unsafe object path component.",
    );
  }
  return value;
}

function assertSafeRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.posix.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Backup manifest contains an unsafe ${label} path.`);
  }
  const components = value.split("/");
  for (const component of components) assertSafeEntryName(component);
  if (components.join("/") !== value) {
    throw new Error(`Backup manifest contains a non-canonical ${label} path.`);
  }
  return value;
}

function assertExpectedFile(value: unknown, label: string): BackupFile {
  if (!value || typeof value !== "object") {
    throw new Error(`Backup manifest is missing ${label} metadata.`);
  }
  const file = value as Partial<BackupFile>;
  const filePath = assertSafeRelativePath(file.path, label);
  if (
    !Number.isSafeInteger(file.bytes) ||
    Number(file.bytes) < 0 ||
    typeof file.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  ) {
    throw new Error(
      `Backup manifest contains invalid ${label} integrity metadata.`,
    );
  }
  return { path: filePath, bytes: Number(file.bytes), sha256: file.sha256 };
}

function parseManifestInventory(bytes: Buffer): {
  manifest: BackupManifest;
  expectedFiles: Map<string, BackupFile>;
} {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8")) as BackupManifest;
  } catch {
    throw new Error("The immutable backup manifest is not valid JSON.");
  }
  if (
    ![1, 2].includes(manifest.version) ||
    !manifest.evidence ||
    !Array.isArray(manifest.evidence.files)
  ) {
    throw new Error(
      "The immutable backup manifest has an unsupported structure.",
    );
  }

  const expectedFiles = new Map<string, BackupFile>();
  const addExpected = (relativePath: string, file: BackupFile): void => {
    if (relativePath === "manifest.json" || expectedFiles.has(relativePath)) {
      throw new Error(
        "The immutable backup manifest contains a duplicate file path.",
      );
    }
    expectedFiles.set(relativePath, file);
  };
  const database = assertExpectedFile(manifest.database, "database");
  addExpected(database.path, database);

  const evidenceRoot = assertSafeRelativePath(
    manifest.evidence.path,
    "filesystem evidence root",
  );
  for (const entry of manifest.evidence.files) {
    const file = assertExpectedFile(entry, "filesystem evidence");
    addExpected(`${evidenceRoot}/${file.path}`, file);
  }

  if (manifest.deletionTombstones) {
    const tombstones = assertExpectedFile(
      manifest.deletionTombstones,
      "deletion tombstone",
    );
    addExpected(tombstones.path, tombstones);
  } else if (manifest.version >= 2) {
    throw new Error(
      "The immutable backup manifest is missing deletion tombstones.",
    );
  }

  if (manifest.storageEvidence) {
    if (!Array.isArray(manifest.storageEvidence.files)) {
      throw new Error(
        "The immutable backup manifest has invalid Storage evidence metadata.",
      );
    }
    const storageRoot = assertSafeRelativePath(
      manifest.storageEvidence.path,
      "Storage evidence root",
    );
    for (const entry of manifest.storageEvidence.files) {
      const file = assertExpectedFile(entry, "Storage evidence");
      addExpected(`${storageRoot}/${file.path}`, file);
    }
  }
  return { manifest, expectedFiles };
}

function resolveContainedFile(root: string, relativePath: string): string {
  const filePath = path.resolve(root, ...relativePath.split("/"));
  if (filePath === root || !filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      "Off-site backup object path escapes the output directory.",
    );
  }
  return filePath;
}

async function resolveNewOutputRoot(requestedPath: string): Promise<{
  outputRoot: string;
  parent: string;
}> {
  const absolutePath = path.resolve(requestedPath);
  const existing = await fs.promises
    .lstat(absolutePath)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (existing)
    throw new Error(`Backup output path already exists: ${absolutePath}`);

  const parent = path.dirname(absolutePath);
  const parentStat = await fs.promises.stat(parent).catch(() => null);
  if (!parentStat?.isDirectory()) {
    throw new Error(`Backup output parent directory does not exist: ${parent}`);
  }
  const realParent = await fs.promises.realpath(parent);
  const realParentStat = await fs.promises.stat(realParent);
  if ((realParentStat.mode & 0o077) !== 0) {
    throw new Error(
      "Backup output parent directory must have mode 700 or stricter.",
    );
  }
  return {
    outputRoot: path.join(realParent, path.basename(absolutePath)),
    parent: realParent,
  };
}

async function collectRemoteBackupFiles(input: {
  client: SupabaseClient;
  bucketName: string;
  backupId: string;
  pageSize: number;
  signal?: AbortSignal;
}): Promise<RemoteBackupFile[]> {
  const files: RemoteBackupFile[] = [];
  const exactPrefix = `${input.backupId}/`;
  const seenObjectPaths = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    if (input.signal?.aborted) throw input.signal.reason;
    const { data, error } = await input.client.storage
      .from(input.bucketName)
      .listV2(
        {
          prefix: exactPrefix,
          ...(cursor ? { cursor } : {}),
          limit: input.pageSize,
          with_delimiter: false,
          sortBy: { column: "name", order: "asc" },
        },
        input.signal ? { signal: input.signal } : {},
      );
    if (error || !data)
      throw new Error("Could not list the requested immutable backup prefix.");
    if (data.folders.length > 0 || data.objects.length > input.pageSize) {
      throw new Error("Off-site backup listing returned an invalid flat page.");
    }
    const nextCursor = data.hasNext ? data.nextCursor?.trim() : undefined;
    if (data.hasNext && (!nextCursor || seenCursors.has(nextCursor))) {
      throw new Error(
        "Off-site backup listing returned an invalid or repeated cursor.",
      );
    }

    for (const entry of data.objects) {
      const rawPath = entry.key?.trim() || entry.name;
      const objectPath = rawPath.startsWith(exactPrefix)
        ? rawPath
        : `${exactPrefix}${rawPath}`;
      if (!objectPath.startsWith(exactPrefix)) {
        throw new Error(
          "Off-site backup listing escaped the requested immutable prefix.",
        );
      }
      const relativePath = assertSafeRelativePath(
        objectPath.slice(exactPrefix.length),
        "remote object",
      );
      if (relativePath.split("/").length > MAX_DIRECTORY_DEPTH) {
        throw new Error(
          "Off-site backup directory depth exceeds the safety limit.",
        );
      }
      if (seenObjectPaths.has(objectPath)) {
        throw new Error("Off-site backup listing contains a duplicate object.");
      }
      seenObjectPaths.add(objectPath);
      files.push({
        objectPath,
        relativePath,
        fingerprint: JSON.stringify({
          id: entry.id,
          key: entry.key ?? null,
          name: entry.name,
          createdAt: entry.created_at,
          updatedAt: entry.updated_at,
          metadata: entry.metadata,
        }),
      });
      if (files.length > MAX_REMOTE_FILES) {
        throw new Error(
          "Off-site backup contains too many objects to download safely.",
        );
      }
    }

    if (!data.hasNext) break;
    seenCursors.add(nextCursor!);
    cursor = nextCursor!;
  }

  if (files.length === 0)
    throw new Error("The requested immutable backup prefix is empty.");
  return files.sort((first, second) =>
    first.relativePath.localeCompare(second.relativePath),
  );
}

function sameInventory(
  first: RemoteBackupFile[],
  second: RemoteBackupFile[],
): boolean {
  return (
    first.length === second.length &&
    first.every(
      (file, index) =>
        file.objectPath === second[index]?.objectPath &&
        file.relativePath === second[index]?.relativePath &&
        file.fingerprint === second[index]?.fingerprint,
    )
  );
}

function assertManifestInventory(
  inventory: RemoteBackupFile[],
  expectedFiles: Map<string, BackupFile>,
): void {
  const expectedPaths = ["manifest.json", ...expectedFiles.keys()].sort(
    (first, second) => first.localeCompare(second),
  );
  const actualPaths = inventory.map((file) => file.relativePath);
  if (
    expectedPaths.length !== actualPaths.length ||
    expectedPaths.some((filePath, index) => filePath !== actualPaths[index])
  ) {
    throw new Error(
      "The immutable backup prefix does not exactly match its manifest.",
    );
  }
}

async function downloadObject(input: {
  client: SupabaseClient;
  bucketName: string;
  objectPath: string;
  label: string;
  maximumBytes?: number;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const { data, error } = await input.client.storage
    .from(input.bucketName)
    .download(
      input.objectPath,
      {},
      { cache: "no-store", ...(input.signal ? { signal: input.signal } : {}) },
    )
    .asStream();
  if (error || !data)
    throw new Error(`Could not download immutable backup ${input.label}.`);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const readable = Readable.fromWeb(
    data as Parameters<typeof Readable.fromWeb>[0],
  );
  for await (const rawChunk of readable) {
    if (input.signal?.aborted) throw input.signal.reason;
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    totalBytes += chunk.length;
    if (input.maximumBytes !== undefined && totalBytes > input.maximumBytes) {
      readable.destroy();
      throw new Error(
        `Immutable backup ${input.label} exceeds the safety limit.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
}

function normalizedObjectInfo(value: Record<string, unknown>): string {
  return JSON.stringify({
    id: value.id ?? null,
    version: value.version ?? null,
    name: value.name ?? null,
    bucketId: value.bucketId ?? null,
    size: value.size ?? null,
    cacheControl: value.cacheControl ?? null,
    contentType: value.contentType ?? null,
    etag: value.etag ?? null,
    createdAt: value.createdAt ?? null,
    updatedAt: value.updatedAt ?? null,
    lastModified: value.lastModified ?? null,
    metadata: value.metadata ?? null,
  });
}

async function objectInfo(input: {
  client: SupabaseClient;
  bucketName: string;
  objectPath: string;
  expectedBytes: number;
}): Promise<string> {
  const { data, error } = await input.client.storage
    .from(input.bucketName)
    .info(input.objectPath);
  if (error || !data)
    throw new Error("Could not inspect an immutable backup object.");
  if (
    data.name !== input.objectPath ||
    data.bucketId !== input.bucketName ||
    data.size !== input.expectedBytes
  ) {
    throw new Error(
      "Immutable backup object metadata does not match the manifest.",
    );
  }
  return normalizedObjectInfo(data as unknown as Record<string, unknown>);
}

async function writeAll(
  handle: fs.promises.FileHandle,
  bytes: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (result.bytesWritten <= 0)
      throw new Error("Could not write the downloaded backup object.");
    offset += result.bytesWritten;
  }
}

async function writeVerifiedBufferToFile(input: {
  destination: string;
  bytes: Buffer;
  expectedSha256: string;
}): Promise<void> {
  const handle = await fs.promises.open(
    input.destination,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await writeAll(handle, input.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if ((await sha256File(input.destination)) !== input.expectedSha256) {
    throw new Error(
      "The locally written immutable backup manifest failed verification.",
    );
  }
}

async function downloadObjectToFile(input: {
  client: SupabaseClient;
  bucketName: string;
  objectPath: string;
  destination: string;
  expected: BackupFile;
  signal?: AbortSignal;
}): Promise<void> {
  const handle = await fs.promises.open(
    input.destination,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let streamedBytes = 0;
  const hash = crypto.createHash("sha256");
  try {
    const { data, error } = await input.client.storage
      .from(input.bucketName)
      .download(
        input.objectPath,
        {},
        {
          cache: "no-store",
          ...(input.signal ? { signal: input.signal } : {}),
        },
      )
      .asStream();
    if (error || !data)
      throw new Error("Could not download an immutable backup object.");
    const readable = Readable.fromWeb(
      data as Parameters<typeof Readable.fromWeb>[0],
    );
    for await (const rawChunk of readable) {
      if (input.signal?.aborted) throw input.signal.reason;
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      streamedBytes += chunk.length;
      if (streamedBytes > input.expected.bytes) {
        throw new Error(
          "An immutable backup object exceeds its manifest byte size.",
        );
      }
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (
    streamedBytes !== input.expected.bytes ||
    hash.digest("hex") !== input.expected.sha256 ||
    (await sha256File(input.destination)) !== input.expected.sha256
  ) {
    throw new Error(
      "An immutable backup object failed manifest integrity verification.",
    );
  }
}

async function ensurePrivateDirectory(
  root: string,
  directory: string,
): Promise<void> {
  const relative = path.relative(root, directory);
  if (!relative) return;
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      await fs.promises.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Backup output contains an unsafe directory entry.");
    }
  }
}

export async function readPrivateSecretFile(filename: string): Promise<string> {
  const secretPath = path.resolve(filename);
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      secretPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error(
      "The service-role key file must be a readable regular non-symbolic-link file.",
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(
        "The service-role key file must be a regular non-symbolic-link file.",
      );
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        "The service-role key file must not be accessible by group or other users.",
      );
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(
        "The service-role key file must be owned by the current operator user.",
      );
    }
    if (stat.size > 64 * 1024) {
      throw new Error("The service-role key file is unexpectedly large.");
    }
    const value = (await handle.readFile({ encoding: "utf8" })).trim();
    if (!value) throw new Error("The service-role key file is empty.");
    return value;
  } finally {
    await handle.close();
  }
}

export async function downloadOffsiteBackup(
  input: DownloadOffsiteBackupInput,
): Promise<DownloadOffsiteBackupResult> {
  const backupId = assertImmutableBackupId(input.backupId);
  const expectedManifestSha256 = input.expectedManifestSha256
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256)) {
    throw new Error("A trusted production manifest SHA-256 is required.");
  }
  const { outputRoot, parent } = await resolveNewOutputRoot(input.outputPath);
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error(
      "Backup listing page size must be an integer between 1 and 1000.",
    );
  }
  if (
    !input.destinationSupabaseUrl.trim() ||
    !input.destinationServiceRoleKey.trim()
  ) {
    throw new Error("Off-site backup destination credentials are required.");
  }
  const projectOrigin = assertSecureProjectOrigin(input.destinationSupabaseUrl);
  const bucketName = assertSafeBucketName(input.bucketName);

  const client = input.clientFactory
    ? input.clientFactory(projectOrigin, input.destinationServiceRoleKey)
    : createServerSupabaseClient(
        projectOrigin,
        input.destinationServiceRoleKey,
        {
          timeoutMs: input.requestTimeoutMs ?? DOWNLOAD_REQUEST_TIMEOUT_MS,
          fetchImplementation: createReadOnlyOffsiteFetch({
            projectOrigin,
            bucketName,
            backupId,
          }),
        },
      );
  const { data: bucket, error: bucketError } =
    await client.storage.getBucket(bucketName);
  if (bucketError || !bucket || bucket.public !== false) {
    throw new Error(
      "The off-site backup bucket is unavailable or is not private.",
    );
  }

  const manifestObjectPath = `${backupId}/manifest.json`;
  const manifestBytes = await downloadObject({
    client,
    bucketName,
    objectPath: manifestObjectPath,
    label: "manifest",
    maximumBytes: MAX_MANIFEST_BYTES,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const manifestSha256 = sha256Bytes(manifestBytes);
  if (manifestSha256 !== expectedManifestSha256) {
    throw new Error(
      "The immutable backup manifest does not match the trusted production SHA-256.",
    );
  }
  const { expectedFiles } = parseManifestInventory(manifestBytes);
  const inventory = await collectRemoteBackupFiles({
    client,
    bucketName,
    backupId,
    pageSize,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  assertManifestInventory(inventory, expectedFiles);
  const manifestInfoBefore = await objectInfo({
    client,
    bucketName,
    objectPath: manifestObjectPath,
    expectedBytes: manifestBytes.length,
  });
  const stagingRoot = await fs.promises.mkdtemp(
    path.join(parent, `.${path.basename(outputRoot)}.partial-`),
  );
  let published = false;
  try {
    await fs.promises.chmod(stagingRoot, 0o700);
    const stagingStat = await fs.promises.lstat(stagingRoot);
    if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
      throw new Error("Backup output is not a private regular directory.");
    }

    const manifestDestination = resolveContainedFile(
      stagingRoot,
      "manifest.json",
    );
    await writeVerifiedBufferToFile({
      destination: manifestDestination,
      bytes: manifestBytes,
      expectedSha256: expectedManifestSha256,
    });
    let totalBytes = manifestBytes.length;
    for (const file of inventory) {
      if (file.relativePath === "manifest.json") continue;
      const expected = expectedFiles.get(file.relativePath);
      if (!expected)
        throw new Error(
          "The immutable backup prefix contains an unexpected object.",
        );
      const destination = resolveContainedFile(stagingRoot, file.relativePath);
      await ensurePrivateDirectory(stagingRoot, path.dirname(destination));
      const infoBefore = await objectInfo({
        client,
        bucketName,
        objectPath: file.objectPath,
        expectedBytes: expected.bytes,
      });
      await downloadObjectToFile({
        client,
        bucketName,
        objectPath: file.objectPath,
        destination,
        expected,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const infoAfter = await objectInfo({
        client,
        bucketName,
        objectPath: file.objectPath,
        expectedBytes: expected.bytes,
      });
      if (infoBefore !== infoAfter) {
        throw new Error("An immutable backup object changed during download.");
      }
      totalBytes += expected.bytes;
    }

    const inventoryAfterDownload = await collectRemoteBackupFiles({
      client,
      bucketName,
      backupId,
      pageSize,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!sameInventory(inventory, inventoryAfterDownload)) {
      throw new Error("The immutable backup prefix changed during download.");
    }
    const manifestAfterDownload = await downloadObject({
      client,
      bucketName,
      objectPath: manifestObjectPath,
      label: "manifest",
      maximumBytes: MAX_MANIFEST_BYTES,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const manifestInfoAfter = await objectInfo({
      client,
      bucketName,
      objectPath: manifestObjectPath,
      expectedBytes: manifestBytes.length,
    });
    if (
      !manifestBytes.equals(manifestAfterDownload) ||
      manifestInfoBefore !== manifestInfoAfter
    ) {
      throw new Error("The immutable backup manifest changed during download.");
    }

    const manifest = await verifyDataBackup(stagingRoot);
    const result: DownloadOffsiteBackupResult = {
      backupId,
      manifestSha256,
      outputPath: path.resolve(input.outputPath),
      objectCount: inventory.length,
      bytes: totalBytes,
      databaseBytes: manifest.database.bytes,
      filesystemEvidenceFiles: manifest.evidence.fileCount,
      storageEvidenceFiles: manifest.storageEvidence?.fileCount ?? 0,
      deletionTombstones: manifest.deletionTombstones?.count ?? 0,
    };
    const finalState = await fs.promises
      .lstat(outputRoot)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (finalState)
      throw new Error(`Backup output path already exists: ${outputRoot}`);
    await fs.promises.rename(stagingRoot, outputRoot);
    published = true;
    return result;
  } catch (error) {
    if (!published) {
      try {
        await fs.promises.rm(stagingRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Off-site backup download failed and partial output remains at: ${stagingRoot}`,
        );
      }
    }
    throw error;
  }
}
