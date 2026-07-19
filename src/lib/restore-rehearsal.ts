import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import BetterSqlite3 from "better-sqlite3";

export const RESTORE_RUNTIME_ATTESTATION_VERSION = 2 as const;
export const RESTORE_RUNTIME_ATTESTATION_KIND = "pint-path-restore-runtime-attestation" as const;
export const RESTORE_RUNTIME_ATTESTATION_FILE = "restore-runtime-attestation.json";
export const RESTORE_RUNTIME_DATABASE_FILE = "pint-path.sqlite";
export const RESTORE_RUNTIME_EVIDENCE_DIRECTORY = "source-evidence";
export const RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY = "supabase-source-evidence";

const RESTORE_REHEARSAL_STATE_KEY = "job:restore_rehearsal";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const execFileAsync = promisify(execFile);

export interface RestoreRuntimeFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface RestoreRuntimeStorageFile extends RestoreRuntimeFile {
  contentType: string;
}

export interface RestoreRehearsalState {
  key: typeof RESTORE_REHEARSAL_STATE_KEY;
  state: "succeeded";
  startedAt: string;
  completedAt: string;
  updatedAt: string;
  backupId: string;
  sourceManifestSha256: string;
  sourceDatabaseSha256: string;
  deletionLedgerSha256: string;
  deletionLedgerGenesisSha256: string;
  deletionLedgerCheckpointSha256: string;
  databaseBytes: number;
  evidenceFileCount: number;
  storageEvidenceFileCount: number;
  tombstonesApplied: number;
  evidenceFilesPurged: number;
  evidencePurgedPathSha256s: string[];
}

export interface RestoreRuntimeAttestation {
  version: typeof RESTORE_RUNTIME_ATTESTATION_VERSION;
  kind: typeof RESTORE_RUNTIME_ATTESTATION_KIND;
  backupId: string;
  sourceManifestSha256: string;
  database: RestoreRuntimeFile & { path: typeof RESTORE_RUNTIME_DATABASE_FILE };
  evidence: {
    path: typeof RESTORE_RUNTIME_EVIDENCE_DIRECTORY;
    fileCount: number;
    bytes: number;
    files: RestoreRuntimeFile[];
    databaseReferenceCount: number;
    orphanPaths: string[];
  };
  storageEvidence: {
    provider: "supabase";
    bucket: string;
    path: typeof RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY;
    fileCount: number;
    bytes: number;
    files: RestoreRuntimeStorageFile[];
    databaseReferenceCount: number;
    orphanPaths: string[];
  };
  restoreRehearsal: RestoreRehearsalState;
}

export interface BuildRestoreRuntimeAttestationInput {
  restoreRoot: string;
  backupId: string;
  sourceManifestPath: string;
  expectedSourceManifestSha256: string;
  expectedDeletionLedgerSha256: string;
  expectedDeletionLedgerGenesisSha256: string;
  expectedDeletionLedgerCheckpointSha256: string;
}

export interface VerifyRestoreRuntimeAttestationInput {
  restoreRoot: string;
  expectedAttestationSha256: string;
  expectedBackupId: string;
  expectedSourceManifestSha256: string;
}

export interface VerifiedRestoreRuntimeAttestation {
  restoreRoot: string;
  databasePath: string;
  evidencePath: string;
  storageEvidencePath: string;
  attestationPath: string;
  attestationSha256: string;
  attestation: RestoreRuntimeAttestation;
}

export interface ActivateVerifiedRestoreRuntimeInput {
  incomingRoot: string;
  finalRoot: string;
  expectedAttestationSha256: string;
  expectedBackupId: string;
  expectedSourceManifestSha256: string;
}

export interface ActivatedRestoreRuntime {
  activated: true;
  activationLockCleanupRequired: boolean;
  backupId: string;
  attestationSha256: string;
  sourceManifestSha256: string;
  sourceDatabaseSha256: string;
  runtimeDatabaseSha256: string;
  evidenceFileCount: number;
  storageEvidenceFileCount: number;
}

interface SourceBackupManifestSummary {
  database: RestoreRuntimeFile & { path: typeof RESTORE_RUNTIME_DATABASE_FILE };
  evidence: {
    path: typeof RESTORE_RUNTIME_EVIDENCE_DIRECTORY;
    fileCount: number;
    bytes: number;
    files: RestoreRuntimeFile[];
    databaseReferenceCount: number;
    orphanPaths: string[];
  };
  storageEvidence: {
    provider: "supabase";
    bucket: string;
    path: typeof RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY;
    fileCount: number;
    bytes: number;
    files: RestoreRuntimeStorageFile[];
    databaseReferenceCount: number;
    orphanPaths: string[];
  };
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface DatabaseEvidenceReferenceState {
  activeEvidenceReferenceCount: number;
  activeStorageReferenceCount: number;
  activeEvidencePaths: Set<string>;
  activeStoragePaths: Set<string>;
  deletedEvidencePaths: Set<string>;
  deletedStorageEvidencePaths: Set<string>;
}

function comparePaths(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function sha256Bytes(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(comparePaths);
  const expected = [...expectedKeys].sort(comparePaths);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function normalizeSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a complete SHA-256 value.`);
  }
  return normalized;
}

function assertSameSha256(actual: string, expected: string, label: string): void {
  const actualBytes = Buffer.from(normalizeSha256(actual, label), "hex");
  const expectedBytes = Buffer.from(normalizeSha256(expected, label), "hex");
  if (!crypto.timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error(`${label} does not match its trusted SHA-256 value.`);
  }
}

function normalizeBackupId(value: string): string {
  const backupId = value.trim();
  if (!SAFE_BACKUP_ID_PATTERN.test(backupId) || backupId === "." || backupId === "..") {
    throw new Error("Restore backup ID is missing or unsafe.");
  }
  return backupId;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function assertPositiveInteger(value: unknown, label: string): number {
  const result = assertNonNegativeInteger(value, label);
  if (result === 0) throw new Error(`${label} must be greater than zero.`);
  return result;
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing.`);
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function normalizeSha256List(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const normalized = value.map((entry, index) => (
    normalizeSha256(String(entry ?? ""), `${label} ${index + 1}`)
  ));
  const sorted = [...normalized].sort(comparePaths);
  if (
    normalized.some((entry, index) => entry !== sorted[index]) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error(`${label} must be unique and sorted.`);
  }
  return normalized;
}

function evidencePurgePathSha256(provider: string, objectPath: string): string {
  return sha256Bytes(Buffer.from(`${provider}\0${objectPath}`, "utf8"));
}

function normalizeRelativeFilePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    /[\0-\x1f\x7f]/.test(value) ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error(`${label} is not a safe canonical relative path.`);
  }
  return value;
}

function normalizeContentType(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing.`);
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)) {
    throw new Error(`${label} is not a canonical MIME type.`);
  }
  return normalized;
}

function normalizeStorageBucket(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)
  ) {
    throw new Error(`${label} is missing or unsafe.`);
  }
  return value;
}

function normalizeOrphanPaths(
  value: unknown,
  files: RestoreRuntimeFile[],
  label: string,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const filePaths = new Set(files.map((file) => file.path));
  const orphanPaths = value.map((orphanPath, index) => (
    normalizeRelativeFilePath(orphanPath, `${label} ${index + 1}`)
  ));
  const sorted = [...orphanPaths].sort(comparePaths);
  if (
    orphanPaths.some((orphanPath, index) => orphanPath !== sorted[index]) ||
    new Set(orphanPaths).size !== orphanPaths.length ||
    orphanPaths.some((orphanPath) => !filePaths.has(orphanPath))
  ) {
    throw new Error(`${label} must be unique, sorted, and present in the file list.`);
  }
  return orphanPaths;
}

function isContained(rootRealPath: string, candidateRealPath: string): boolean {
  return candidateRealPath.startsWith(`${rootRealPath}${path.sep}`);
}

async function assertDirectory(
  directoryPath: string,
  label: string,
  containingRealPath?: string,
): Promise<string> {
  const stat = await fs.promises.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a link or special file.`);
  }
  const realPath = await fs.promises.realpath(directoryPath);
  if (containingRealPath && !isContained(containingRealPath, realPath)) {
    throw new Error(`${label} resolves outside the restore root.`);
  }
  return realPath;
}

function sameFileIdentity(first: FileIdentity, second: fs.Stats): boolean {
  return first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs;
}

function sameDirectoryIdentity(first: DirectoryIdentity, second: fs.Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

async function assertPathDoesNotExist(targetPath: string, label: string): Promise<void> {
  try {
    await fs.promises.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists; activation will not overwrite it.`);
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.promises.open(directoryPath, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicRenameNoReplace(sourcePath: string, destinationPath: string): Promise<void> {
  if (process.platform === "linux") {
    try {
      await execFileAsync("/bin/mv", [
        "--no-clobber",
        "--no-target-directory",
        "--",
        sourcePath,
        destinationPath,
      ], {
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 16 * 1024,
      });
    } catch {
      throw new Error("Atomic no-replace restore rename failed.");
    }
    try {
      await fs.promises.lstat(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error("Final restore root appeared before the no-replace rename completed.");
  }
  await fs.promises.rename(sourcePath, destinationPath);
}

async function inspectRegularFile(
  filePath: string,
  label: string,
  containingRealPath?: string,
): Promise<{ bytes: number; sha256: string; realPath: string }> {
  const before = await fs.promises.lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(`${label} must be one regular, non-linked file.`);
  }
  const realPath = await fs.promises.realpath(filePath);
  if (containingRealPath && !isContained(containingRealPath, realPath)) {
    throw new Error(`${label} resolves outside the restore root.`);
  }
  const identity: FileIdentity = {
    dev: before.dev,
    ino: before.ino,
    size: before.size,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
  };
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const hash = crypto.createHash("sha256");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(identity, opened)) {
      throw new Error(`${label} changed before its checksum was calculated.`);
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, opened.size - position),
        position,
      );
      if (bytesRead === 0) throw new Error(`${label} ended before its declared size.`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const afterDescriptor = await handle.stat();
    const afterPath = await fs.promises.lstat(filePath);
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.nlink !== 1 ||
      !sameFileIdentity(identity, afterDescriptor) ||
      !sameFileIdentity(identity, afterPath)
    ) {
      throw new Error(`${label} changed while its checksum was calculated.`);
    }
  } finally {
    await handle.close();
  }
  return { bytes: before.size, sha256: hash.digest("hex"), realPath };
}

async function listStrictRuntimeFiles(
  fileRoot: string,
  restoreRootRealPath: string,
  label: string,
): Promise<RestoreRuntimeFile[]> {
  const fileRootRealPath = await assertDirectory(
    fileRoot,
    `${label} directory`,
    restoreRootRealPath,
  );
  const files: RestoreRuntimeFile[] = [];

  async function visit(currentPath: string, relativeDirectory: string): Promise<number> {
    const currentRealPath = relativeDirectory
      ? await assertDirectory(currentPath, `${label} directory ${relativeDirectory}`, fileRootRealPath)
      : fileRootRealPath;
    if (currentRealPath !== fileRootRealPath && !isContained(fileRootRealPath, currentRealPath)) {
      throw new Error(`${label} directory ${relativeDirectory} resolves outside its root.`);
    }
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    let descendantFileCount = 0;
    for (const entry of entries.sort((first, second) => comparePaths(first.name, second.name))) {
      const relativePath = normalizeRelativeFilePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
        `${label} path`,
      );
      const absolutePath = path.join(currentPath, entry.name);
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`${label} path ${relativePath} must not be a symbolic link.`);
      }
      if (stat.isDirectory()) {
        const nestedFileCount = await visit(absolutePath, relativePath);
        if (nestedFileCount === 0) {
          throw new Error(`${label} directory ${relativePath} is an unattested empty directory.`);
        }
        descendantFileCount += nestedFileCount;
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`${label} path ${relativePath} must be a regular file.`);
      }
      const inspected = await inspectRegularFile(
        absolutePath,
        `${label} file ${relativePath}`,
        fileRootRealPath,
      );
      files.push({ path: relativePath, bytes: inspected.bytes, sha256: inspected.sha256 });
      descendantFileCount += 1;
    }
    return descendantFileCount;
  }

  await visit(fileRoot, "");
  return files.sort((first, second) => comparePaths(first.path, second.path));
}

async function listStrictEvidenceFiles(
  evidenceRoot: string,
  restoreRootRealPath: string,
): Promise<RestoreRuntimeFile[]> {
  return listStrictRuntimeFiles(evidenceRoot, restoreRootRealPath, "Restore evidence");
}

async function listStrictStorageEvidenceFiles(
  storageEvidenceRoot: string,
  restoreRootRealPath: string,
): Promise<RestoreRuntimeFile[]> {
  return listStrictRuntimeFiles(
    storageEvidenceRoot,
    restoreRootRealPath,
    "Restore Storage evidence",
  );
}

async function assertRestoreRootEntries(restoreRoot: string, allowAttestation: boolean): Promise<void> {
  const expected = new Set([
    RESTORE_RUNTIME_DATABASE_FILE,
    RESTORE_RUNTIME_EVIDENCE_DIRECTORY,
    RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY,
    ...(allowAttestation ? [RESTORE_RUNTIME_ATTESTATION_FILE] : []),
  ]);
  const entries = await fs.promises.readdir(restoreRoot);
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry))) {
    throw new Error("Restore root contains an unapproved file, directory, or SQLite sidecar.");
  }
}

async function readSourceManifestSummary(input: {
  sourceManifestPath: string;
  expectedSourceManifestSha256: string;
}): Promise<{ sha256: string; summary: SourceBackupManifestSummary }> {
  const manifestPath = path.resolve(input.sourceManifestPath);
  if (path.basename(manifestPath) !== "manifest.json") {
    throw new Error("Source backup manifest must be the immutable manifest.json file.");
  }
  const inspected = await inspectRegularFile(manifestPath, "Source backup manifest");
  const expectedSha256 = normalizeSha256(
    input.expectedSourceManifestSha256,
    "Source backup manifest SHA-256",
  );
  assertSameSha256(inspected.sha256, expectedSha256, "Source backup manifest");
  const manifestBytes = await fs.promises.readFile(manifestPath);
  if (
    manifestBytes.length !== inspected.bytes ||
    sha256Bytes(manifestBytes) !== inspected.sha256
  ) {
    throw new Error("Source backup manifest changed while it was being read.");
  }
  const parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.database) ||
    !isRecord(parsed.evidence) ||
    !isRecord(parsed.storageEvidence)
  ) {
    throw new Error("Source backup manifest has an unsupported structure.");
  }
  if (parsed.version !== 2) {
    throw new Error("Runtime attestation requires a complete v2 source backup manifest.");
  }
  const database = normalizeRestoreRuntimeFile(parsed.database, "Source database");
  if (database.path !== RESTORE_RUNTIME_DATABASE_FILE) {
    throw new Error("Source database path is not the fixed backup database file.");
  }
  if (database.bytes === 0) throw new Error("Source database bytes must be greater than zero.");
  if (parsed.evidence.path !== RESTORE_RUNTIME_EVIDENCE_DIRECTORY) {
    throw new Error("Source evidence path is not the fixed backup evidence directory.");
  }
  if (!Array.isArray(parsed.evidence.files)) {
    throw new Error("Source evidence file list is invalid.");
  }
  const evidenceFiles = parsed.evidence.files.map((file, index) => (
    normalizeRestoreRuntimeFile(file, `Source evidence file ${index + 1}`)
  ));
  assertUniqueSortedRuntimeFiles(evidenceFiles, "Source evidence");
  const evidenceFileCount = assertNonNegativeInteger(
    parsed.evidence.fileCount,
    "Source evidence file count",
  );
  const evidenceBytes = assertNonNegativeInteger(parsed.evidence.bytes, "Source evidence bytes");
  if (
    evidenceFileCount !== evidenceFiles.length ||
    evidenceBytes !== evidenceFiles.reduce((total, file) => total + file.bytes, 0)
  ) {
    throw new Error("Source evidence totals do not match its file list.");
  }
  const evidenceDatabaseReferenceCount = assertNonNegativeInteger(
    parsed.evidence.databaseReferenceCount,
    "Source evidence database-reference count",
  );
  const evidenceOrphanPaths = normalizeOrphanPaths(
    parsed.evidence.orphanPaths,
    evidenceFiles,
    "Source evidence orphan paths",
  );
  if (evidenceDatabaseReferenceCount < evidenceFiles.length - evidenceOrphanPaths.length) {
    throw new Error("Source evidence database-reference count does not cover its non-orphan files.");
  }

  const storageEvidence = parsed.storageEvidence;
  if (
    storageEvidence.provider !== "supabase" ||
    storageEvidence.path !== RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY ||
    !Array.isArray(storageEvidence.files) ||
    !Array.isArray(storageEvidence.orphanPaths)
  ) {
    throw new Error("Source backup manifest has invalid Storage-evidence metadata.");
  }
  const storageFiles = storageEvidence.files.map((file, index) => (
    normalizeRestoreRuntimeStorageFile(file, `Source Storage-evidence file ${index + 1}`)
  ));
  assertUniqueSortedRuntimeFiles(storageFiles, "Source Storage evidence");
  const storageFileCount = assertNonNegativeInteger(
    storageEvidence.fileCount,
    "Source Storage-evidence file count",
  );
  const storageBytes = assertNonNegativeInteger(
    storageEvidence.bytes,
    "Source Storage-evidence bytes",
  );
  if (
    storageFileCount !== storageFiles.length ||
    storageBytes !== storageFiles.reduce((total, file) => total + file.bytes, 0)
  ) {
    throw new Error("Source Storage-evidence totals do not match its file list.");
  }
  const orphanPaths = normalizeOrphanPaths(
    storageEvidence.orphanPaths,
    storageFiles,
    "Source Storage orphan paths",
  );
  const databaseReferenceCount = assertNonNegativeInteger(
    storageEvidence.databaseReferenceCount,
    "Source Storage database-reference count",
  );
  if (databaseReferenceCount < storageFiles.length - orphanPaths.length) {
    throw new Error("Source Storage database-reference count does not cover its non-orphan files.");
  }
  const summary: SourceBackupManifestSummary = {
    database: {
      path: RESTORE_RUNTIME_DATABASE_FILE,
      bytes: database.bytes,
      sha256: database.sha256,
    },
    evidence: {
      path: RESTORE_RUNTIME_EVIDENCE_DIRECTORY,
      fileCount: evidenceFileCount,
      bytes: evidenceBytes,
      files: evidenceFiles,
      databaseReferenceCount: evidenceDatabaseReferenceCount,
      orphanPaths: evidenceOrphanPaths,
    },
    storageEvidence: {
      provider: "supabase",
      bucket: normalizeStorageBucket(storageEvidence.bucket, "Source Storage bucket"),
      path: RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY,
      fileCount: storageFileCount,
      bytes: storageBytes,
      files: storageFiles,
      databaseReferenceCount,
      orphanPaths,
    },
  };
  return { sha256: inspected.sha256, summary };
}

function parseRestoreState(valueJson: string, updatedAtValue: string): RestoreRehearsalState {
  const parsed = JSON.parse(valueJson) as unknown;
  if (!isRecord(parsed)) throw new Error("Restore rehearsal state is not valid JSON.");
  assertExactKeys(parsed, [
    "state",
    "startedAt",
    "completedAt",
    "backupId",
    "sourceManifestSha256",
    "sourceDatabaseSha256",
    "deletionLedgerSha256",
    "deletionLedgerGenesisSha256",
    "deletionLedgerCheckpointSha256",
    "databaseBytes",
    "evidenceFileCount",
    "storageEvidenceFileCount",
    "tombstonesApplied",
    "evidenceFilesPurged",
    "evidencePurgedPathSha256s",
  ], "Restore rehearsal state");
  if (parsed.state !== "succeeded") {
    throw new Error("Restore rehearsal state is not succeeded.");
  }
  const startedAt = normalizeTimestamp(parsed.startedAt, "Restore rehearsal start time");
  const completedAt = normalizeTimestamp(parsed.completedAt, "Restore rehearsal completion time");
  const updatedAt = normalizeTimestamp(updatedAtValue, "Restore rehearsal state update time");
  if (Date.parse(completedAt) < Date.parse(startedAt) || Date.parse(updatedAt) < Date.parse(completedAt)) {
    throw new Error("Restore rehearsal timestamps are not monotonic.");
  }
  const evidenceFilesPurged = assertNonNegativeInteger(
    parsed.evidenceFilesPurged,
    "Purged evidence file count",
  );
  const evidencePurgedPathSha256s = normalizeSha256List(
    parsed.evidencePurgedPathSha256s,
    "Purged evidence path hashes",
  );
  if (evidencePurgedPathSha256s.length !== evidenceFilesPurged) {
    throw new Error("Purged evidence path hashes do not match the purge count.");
  }
  return {
    key: RESTORE_REHEARSAL_STATE_KEY,
    state: "succeeded",
    startedAt,
    completedAt,
    updatedAt,
    backupId: normalizeBackupId(String(parsed.backupId ?? "")),
    sourceManifestSha256: normalizeSha256(
      String(parsed.sourceManifestSha256 ?? ""),
      "Restore source manifest SHA-256",
    ),
    sourceDatabaseSha256: normalizeSha256(
      String(parsed.sourceDatabaseSha256 ?? ""),
      "Restore source database SHA-256",
    ),
    deletionLedgerSha256: normalizeSha256(
      String(parsed.deletionLedgerSha256 ?? ""),
      "Restore deletion ledger SHA-256",
    ),
    deletionLedgerGenesisSha256: normalizeSha256(
      String(parsed.deletionLedgerGenesisSha256 ?? ""),
      "Restore deletion-ledger genesis SHA-256",
    ),
    deletionLedgerCheckpointSha256: normalizeSha256(
      String(parsed.deletionLedgerCheckpointSha256 ?? ""),
      "Restore deletion-ledger checkpoint SHA-256",
    ),
    databaseBytes: assertPositiveInteger(parsed.databaseBytes, "Restore source database bytes"),
    evidenceFileCount: assertNonNegativeInteger(
      parsed.evidenceFileCount,
      "Restore source evidence file count",
    ),
    storageEvidenceFileCount: assertNonNegativeInteger(
      parsed.storageEvidenceFileCount,
      "Restore Storage-evidence file count",
    ),
    tombstonesApplied: assertNonNegativeInteger(
      parsed.tombstonesApplied,
      "Applied tombstone count",
    ),
    evidenceFilesPurged,
    evidencePurgedPathSha256s,
  };
}

function assertDatabaseEvidenceReferences(
  database: BetterSqlite3.Database,
  evidenceFiles: RestoreRuntimeFile[],
  storageEvidenceFiles: RestoreRuntimeStorageFile[],
): DatabaseEvidenceReferenceState {
  const table = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_evidence_objects' LIMIT 1",
  ).get();
  if (!table) throw new Error("Restored database is missing source_evidence_objects.");
  const references = database.prepare(
    `SELECT storage_provider AS storageProvider, object_path AS objectPath,
            mime_type AS mimeType, byte_size AS byteSize, deleted_at AS deletedAt
       FROM source_evidence_objects
      WHERE storage_provider IN ('filesystem_private', 'supabase_private')
      ORDER BY storage_provider ASC, object_path ASC`,
  ).all() as Array<{
    storageProvider: "filesystem_private" | "supabase_private";
    objectPath: string;
    mimeType: string | null;
    byteSize: number | null;
    deletedAt: string | null;
  }>;
  const evidenceFilesByPath = new Map(evidenceFiles.map((file) => [file.path, file]));
  const storageFilesByPath = new Map(storageEvidenceFiles.map((file) => [file.path, file]));
  const deletedEvidencePaths = new Set<string>();
  const deletedStorageEvidencePaths = new Set<string>();
  const activeEvidencePaths = new Set<string>();
  const activeStoragePaths = new Set<string>();
  let activeEvidenceReferenceCount = 0;
  let activeStorageReferenceCount = 0;
  for (const reference of references) {
    const objectPath = normalizeRelativeFilePath(reference.objectPath, "Database evidence path");
    if (reference.deletedAt !== null) {
      if (Number.isNaN(Date.parse(reference.deletedAt))) {
        throw new Error(`Restored database evidence has an invalid deletion time: ${objectPath}`);
      }
      (reference.storageProvider === "supabase_private"
        ? deletedStorageEvidencePaths
        : deletedEvidencePaths).add(objectPath);
      continue;
    }
    const file = reference.storageProvider === "supabase_private"
      ? storageFilesByPath.get(objectPath)
      : evidenceFilesByPath.get(objectPath);
    if (!file) {
      throw new Error(`Restored database references missing evidence: ${objectPath}`);
    }
    if (reference.byteSize !== null && reference.byteSize !== file.bytes) {
      throw new Error(`Restored database evidence size is wrong: ${objectPath}`);
    }
    if (reference.storageProvider === "supabase_private") {
      activeStorageReferenceCount += 1;
      activeStoragePaths.add(objectPath);
    } else {
      activeEvidenceReferenceCount += 1;
      activeEvidencePaths.add(objectPath);
    }
    if (
      reference.storageProvider === "supabase_private" &&
      reference.mimeType !== null &&
      normalizeContentType(reference.mimeType, `Database Storage evidence MIME type ${objectPath}`) !==
        (file as RestoreRuntimeStorageFile).contentType
    ) {
      throw new Error(`Restored database Storage evidence MIME type is wrong: ${objectPath}`);
    }
  }
  return {
    activeEvidenceReferenceCount,
    activeStorageReferenceCount,
    activeEvidencePaths,
    activeStoragePaths,
    deletedEvidencePaths,
    deletedStorageEvidencePaths,
  };
}

function inspectSqliteDatabase(
  databasePath: string,
  evidenceFiles: RestoreRuntimeFile[],
  storageEvidenceFiles: RestoreRuntimeStorageFile[],
): {
  state: RestoreRehearsalState;
} & DatabaseEvidenceReferenceState {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    const journalMode = String(database.pragma("journal_mode", { simple: true })).toLowerCase();
    if (journalMode !== "delete") {
      throw new Error("Restored SQLite database is not in self-contained DELETE journal mode.");
    }
    const integrity = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(`Restored SQLite integrity check failed: ${JSON.stringify(integrity)}`);
    }
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length > 0) {
      throw new Error(`Restored SQLite foreign-key check failed: ${JSON.stringify(foreignKeys)}`);
    }
    const stateTable = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_state' LIMIT 1",
    ).get();
    if (!stateTable) throw new Error("Restored database is missing system_state.");
    const row = database.prepare(
      "SELECT value_json AS valueJson, updated_at AS updatedAt FROM system_state WHERE key = ? LIMIT 1",
    ).get(RESTORE_REHEARSAL_STATE_KEY) as { valueJson: string; updatedAt: string } | undefined;
    if (!row) throw new Error("Restored database is missing the restore rehearsal success record.");
    return {
      state: parseRestoreState(row.valueJson, row.updatedAt),
      ...assertDatabaseEvidenceReferences(database, evidenceFiles, storageEvidenceFiles),
    };
  } finally {
    database.close();
  }
}

function assertStateMatchesSourceAndRuntime(input: {
  state: RestoreRehearsalState;
  source: SourceBackupManifestSummary;
  backupId: string;
  sourceManifestSha256: string;
  deletionLedgerSha256: string;
  deletionLedgerGenesisSha256: string;
  deletionLedgerCheckpointSha256: string;
  evidenceFileCount: number;
  storageEvidenceFileCount: number;
  runtimeEvidenceFiles: RestoreRuntimeFile[];
  runtimeStorageEvidenceFiles: RestoreRuntimeStorageFile[];
}): void {
  const { state, source } = input;
  if (state.backupId !== input.backupId) {
    throw new Error("Restore rehearsal state is for a different backup ID.");
  }
  assertSameSha256(
    state.sourceManifestSha256,
    input.sourceManifestSha256,
    "Restore rehearsal source manifest",
  );
  assertSameSha256(
    state.sourceDatabaseSha256,
    source.database.sha256,
    "Restore rehearsal source database",
  );
  assertSameSha256(
    state.deletionLedgerSha256,
    input.deletionLedgerSha256,
    "Restore rehearsal deletion ledger",
  );
  assertSameSha256(
    state.deletionLedgerGenesisSha256,
    input.deletionLedgerGenesisSha256,
    "Restore rehearsal deletion-ledger genesis",
  );
  assertSameSha256(
    state.deletionLedgerCheckpointSha256,
    input.deletionLedgerCheckpointSha256,
    "Restore rehearsal deletion-ledger checkpoint",
  );
  if (
    state.databaseBytes !== source.database.bytes ||
    state.evidenceFileCount !== source.evidence.fileCount ||
    state.storageEvidenceFileCount !== source.storageEvidence.fileCount
  ) {
    throw new Error("Restore rehearsal state does not match the trusted source manifest counts.");
  }
  const sourceFileCount = state.evidenceFileCount + state.storageEvidenceFileCount;
  const retainedFileCount = input.evidenceFileCount + input.storageEvidenceFileCount;
  if (state.evidenceFilesPurged > sourceFileCount) {
    throw new Error("Restore rehearsal purged more evidence files than the source contained.");
  }
  if (retainedFileCount !== sourceFileCount - state.evidenceFilesPurged) {
    throw new Error("Retained restore evidence count does not match the rehearsal result.");
  }
  const retainedEvidencePaths = new Set(input.runtimeEvidenceFiles.map((file) => file.path));
  const retainedStoragePaths = new Set(
    input.runtimeStorageEvidenceFiles.map((file) => file.path),
  );
  const expectedPurgeHashes = [
    ...source.evidence.files
      .filter((file) => !retainedEvidencePaths.has(file.path))
      .map((file) => evidencePurgePathSha256("filesystem_private", file.path)),
    ...source.storageEvidence.files
      .filter((file) => !retainedStoragePaths.has(file.path))
      .map((file) => evidencePurgePathSha256("supabase_private", file.path)),
  ].sort(comparePaths);
  if (
    expectedPurgeHashes.length !== state.evidenceFilesPurged ||
    JSON.stringify(expectedPurgeHashes) !== JSON.stringify(state.evidencePurgedPathSha256s)
  ) {
    throw new Error("Restore rehearsal purge hashes do not match the exact removed evidence paths.");
  }
}

function reconcileRuntimeFilesWithSource<T extends RestoreRuntimeFile>(input: {
  sourceFiles: T[];
  runtimeFiles: T[];
  deletedPaths: Set<string>;
  label: string;
  compareMetadata?: ((source: T, runtime: T) => boolean) | undefined;
}): void {
  const sourceByPath = new Map(input.sourceFiles.map((file) => [file.path, file]));
  const runtimeByPath = new Map(input.runtimeFiles.map((file) => [file.path, file]));
  for (const runtime of input.runtimeFiles) {
    const source = sourceByPath.get(runtime.path);
    if (
      !source ||
      source.bytes !== runtime.bytes ||
      source.sha256 !== runtime.sha256 ||
      (input.compareMetadata && !input.compareMetadata(source, runtime))
    ) {
      throw new Error(`${input.label} does not match the trusted source manifest: ${runtime.path}`);
    }
  }
  for (const source of input.sourceFiles) {
    if (!runtimeByPath.has(source.path) && !input.deletedPaths.has(source.path)) {
      throw new Error(`${input.label} is missing without a deletion-ledger purge: ${source.path}`);
    }
  }
}

function assertRuntimeReferenceBinding<T extends RestoreRuntimeFile>(input: {
  sourceFiles: T[];
  sourceOrphanPaths: string[];
  sourceDatabaseReferenceCount: number;
  runtimeFiles: T[];
  activePaths: Set<string>;
  activeReferenceCount: number;
  deletedPaths: Set<string>;
  label: string;
}): string[] {
  if (input.activeReferenceCount > input.sourceDatabaseReferenceCount) {
    throw new Error(`${input.label} has more active database references than its source manifest.`);
  }
  const runtimePaths = new Set(input.runtimeFiles.map((file) => file.path));
  const sourceOrphans = new Set(input.sourceOrphanPaths);
  for (const sourceFile of input.sourceFiles) {
    const retained = runtimePaths.has(sourceFile.path);
    const sourceOrphan = sourceOrphans.has(sourceFile.path);
    const active = input.activePaths.has(sourceFile.path);
    const deleted = input.deletedPaths.has(sourceFile.path);
    if (sourceOrphan) {
      if (!retained || active) {
        throw new Error(`${input.label} changed its trusted source-orphan classification.`);
      }
    } else if (retained) {
      if (!active) {
        throw new Error(`${input.label} retained a file without its active database reference.`);
      }
    } else if (!deleted) {
      throw new Error(`${input.label} removed a referenced file without a deleted database row.`);
    }
  }
  for (const activePath of input.activePaths) {
    if (sourceOrphans.has(activePath)) {
      throw new Error(`${input.label} activated a database reference for a trusted source orphan.`);
    }
  }
  return input.runtimeFiles
    .map((file) => file.path)
    .filter((filePath) => sourceOrphans.has(filePath))
    .sort(comparePaths);
}

function sameRuntimeFiles(first: RestoreRuntimeFile[], second: RestoreRuntimeFile[]): boolean {
  return first.length === second.length && first.every((file, index) => {
    const candidate = second[index];
    return Boolean(candidate) &&
      file.path === candidate?.path &&
      file.bytes === candidate.bytes &&
      file.sha256 === candidate.sha256;
  });
}

function normalizeRestoreRuntimeFile(value: unknown, label: string): RestoreRuntimeFile {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  assertExactKeys(value, ["path", "bytes", "sha256"], label);
  return {
    path: normalizeRelativeFilePath(value.path, `${label} path`),
    bytes: assertNonNegativeInteger(value.bytes, `${label} bytes`),
    sha256: normalizeSha256(String(value.sha256 ?? ""), `${label} SHA-256`),
  };
}

function normalizeRestoreRuntimeStorageFile(
  value: unknown,
  label: string,
): RestoreRuntimeStorageFile {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  assertExactKeys(value, ["path", "bytes", "sha256", "contentType"], label);
  return {
    path: normalizeRelativeFilePath(value.path, `${label} path`),
    bytes: assertNonNegativeInteger(value.bytes, `${label} bytes`),
    sha256: normalizeSha256(String(value.sha256 ?? ""), `${label} SHA-256`),
    contentType: normalizeContentType(value.contentType, `${label} content type`),
  };
}

function assertUniqueSortedRuntimeFiles(
  files: RestoreRuntimeFile[],
  label: string,
): void {
  const sortedFiles = [...files].sort((first, second) => comparePaths(first.path, second.path));
  if (
    files.some((file, index) => file.path !== sortedFiles[index]?.path) ||
    new Set(files.map((file) => file.path)).size !== files.length
  ) {
    throw new Error(`${label} file paths must be unique and sorted.`);
  }
}

function normalizeRestoreRuntimeAttestation(value: unknown): RestoreRuntimeAttestation {
  if (!isRecord(value)) throw new Error("Restore runtime attestation is invalid.");
  assertExactKeys(value, [
    "version",
    "kind",
    "backupId",
    "sourceManifestSha256",
    "database",
    "evidence",
    "storageEvidence",
    "restoreRehearsal",
  ], "Restore runtime attestation");
  if (
    value.version !== RESTORE_RUNTIME_ATTESTATION_VERSION ||
    value.kind !== RESTORE_RUNTIME_ATTESTATION_KIND
  ) {
    throw new Error("Restore runtime attestation has an unsupported version or kind.");
  }
  const database = normalizeRestoreRuntimeFile(value.database, "Attested database");
  if (database.path !== RESTORE_RUNTIME_DATABASE_FILE) {
    throw new Error("Attested database path is not the fixed runtime database file.");
  }
  if (!isRecord(value.evidence)) throw new Error("Attested evidence is invalid.");
  assertExactKeys(value.evidence, [
    "path",
    "fileCount",
    "bytes",
    "files",
    "databaseReferenceCount",
    "orphanPaths",
  ], "Attested evidence");
  if (value.evidence.path !== RESTORE_RUNTIME_EVIDENCE_DIRECTORY) {
    throw new Error("Attested evidence path is not the fixed runtime evidence directory.");
  }
  if (!Array.isArray(value.evidence.files)) throw new Error("Attested evidence file list is invalid.");
  const files = value.evidence.files.map((file, index) => (
    normalizeRestoreRuntimeFile(file, `Attested evidence file ${index + 1}`)
  ));
  assertUniqueSortedRuntimeFiles(files, "Attested evidence");
  const declaredFileCount = assertNonNegativeInteger(
    value.evidence.fileCount,
    "Attested evidence file count",
  );
  const declaredBytes = assertNonNegativeInteger(value.evidence.bytes, "Attested evidence bytes");
  if (
    declaredFileCount !== files.length ||
    declaredBytes !== files.reduce((total, file) => total + file.bytes, 0)
  ) {
    throw new Error("Attested evidence totals do not match the file list.");
  }
  const declaredEvidenceReferenceCount = assertNonNegativeInteger(
    value.evidence.databaseReferenceCount,
    "Attested evidence database-reference count",
  );
  const evidenceOrphanPaths = normalizeOrphanPaths(
    value.evidence.orphanPaths,
    files,
    "Attested evidence orphan paths",
  );
  if (!isRecord(value.storageEvidence)) {
    throw new Error("Attested Storage evidence is invalid.");
  }
  assertExactKeys(value.storageEvidence, [
    "provider",
    "bucket",
    "path",
    "fileCount",
    "bytes",
    "files",
    "databaseReferenceCount",
    "orphanPaths",
  ], "Attested Storage evidence");
  if (
    value.storageEvidence.provider !== "supabase" ||
    value.storageEvidence.path !== RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY ||
    !Array.isArray(value.storageEvidence.files)
  ) {
    throw new Error("Attested Storage evidence metadata is invalid.");
  }
  const storageFiles = value.storageEvidence.files.map((file, index) => (
    normalizeRestoreRuntimeStorageFile(file, `Attested Storage-evidence file ${index + 1}`)
  ));
  assertUniqueSortedRuntimeFiles(storageFiles, "Attested Storage evidence");
  const declaredStorageFileCount = assertNonNegativeInteger(
    value.storageEvidence.fileCount,
    "Attested Storage-evidence file count",
  );
  const declaredStorageBytes = assertNonNegativeInteger(
    value.storageEvidence.bytes,
    "Attested Storage-evidence bytes",
  );
  if (
    declaredStorageFileCount !== storageFiles.length ||
    declaredStorageBytes !== storageFiles.reduce((total, file) => total + file.bytes, 0)
  ) {
    throw new Error("Attested Storage-evidence totals do not match the file list.");
  }
  const declaredStorageReferenceCount = assertNonNegativeInteger(
    value.storageEvidence.databaseReferenceCount,
    "Attested Storage-evidence database-reference count",
  );
  const storageOrphanPaths = normalizeOrphanPaths(
    value.storageEvidence.orphanPaths,
    storageFiles,
    "Attested Storage-evidence orphan paths",
  );
  if (!isRecord(value.restoreRehearsal)) throw new Error("Attested restore state is invalid.");
  assertExactKeys(value.restoreRehearsal, [
    "key",
    "state",
    "startedAt",
    "completedAt",
    "updatedAt",
    "backupId",
    "sourceManifestSha256",
    "sourceDatabaseSha256",
    "deletionLedgerSha256",
    "deletionLedgerGenesisSha256",
    "deletionLedgerCheckpointSha256",
    "databaseBytes",
    "evidenceFileCount",
    "storageEvidenceFileCount",
    "tombstonesApplied",
    "evidenceFilesPurged",
    "evidencePurgedPathSha256s",
  ], "Attested restore state");
  if (
    value.restoreRehearsal.key !== RESTORE_REHEARSAL_STATE_KEY ||
    value.restoreRehearsal.state !== "succeeded"
  ) {
    throw new Error("Attested restore state is not a supported successful rehearsal.");
  }
  const startedAt = normalizeTimestamp(value.restoreRehearsal.startedAt, "Attested restore start time");
  const completedAt = normalizeTimestamp(
    value.restoreRehearsal.completedAt,
    "Attested restore completion time",
  );
  const updatedAt = normalizeTimestamp(value.restoreRehearsal.updatedAt, "Attested restore update time");
  if (Date.parse(completedAt) < Date.parse(startedAt) || Date.parse(updatedAt) < Date.parse(completedAt)) {
    throw new Error("Attested restore timestamps are not monotonic.");
  }
  const attestedEvidenceFilesPurged = assertNonNegativeInteger(
    value.restoreRehearsal.evidenceFilesPurged,
    "Attested purged evidence count",
  );
  const attestedEvidencePurgeHashes = normalizeSha256List(
    value.restoreRehearsal.evidencePurgedPathSha256s,
    "Attested purged evidence path hashes",
  );
  if (attestedEvidencePurgeHashes.length !== attestedEvidenceFilesPurged) {
    throw new Error("Attested purge path hashes do not match the purge count.");
  }
  return {
    version: RESTORE_RUNTIME_ATTESTATION_VERSION,
    kind: RESTORE_RUNTIME_ATTESTATION_KIND,
    backupId: normalizeBackupId(String(value.backupId ?? "")),
    sourceManifestSha256: normalizeSha256(
      String(value.sourceManifestSha256 ?? ""),
      "Attested source manifest SHA-256",
    ),
    database: {
      path: RESTORE_RUNTIME_DATABASE_FILE,
      bytes: database.bytes,
      sha256: database.sha256,
    },
    evidence: {
      path: RESTORE_RUNTIME_EVIDENCE_DIRECTORY,
      fileCount: declaredFileCount,
      bytes: declaredBytes,
      files,
      databaseReferenceCount: declaredEvidenceReferenceCount,
      orphanPaths: evidenceOrphanPaths,
    },
    storageEvidence: {
      provider: "supabase",
      bucket: normalizeStorageBucket(
        value.storageEvidence.bucket,
        "Attested Storage bucket",
      ),
      path: RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY,
      fileCount: declaredStorageFileCount,
      bytes: declaredStorageBytes,
      files: storageFiles,
      databaseReferenceCount: declaredStorageReferenceCount,
      orphanPaths: storageOrphanPaths,
    },
    restoreRehearsal: {
      key: RESTORE_REHEARSAL_STATE_KEY,
      state: "succeeded",
      startedAt,
      completedAt,
      updatedAt,
      backupId: normalizeBackupId(String(value.restoreRehearsal.backupId ?? "")),
      sourceManifestSha256: normalizeSha256(
        String(value.restoreRehearsal.sourceManifestSha256 ?? ""),
        "Attested restore source manifest SHA-256",
      ),
      sourceDatabaseSha256: normalizeSha256(
        String(value.restoreRehearsal.sourceDatabaseSha256 ?? ""),
        "Attested restore source database SHA-256",
      ),
      deletionLedgerSha256: normalizeSha256(
        String(value.restoreRehearsal.deletionLedgerSha256 ?? ""),
        "Attested restore deletion ledger SHA-256",
      ),
      deletionLedgerGenesisSha256: normalizeSha256(
        String(value.restoreRehearsal.deletionLedgerGenesisSha256 ?? ""),
        "Attested restore deletion-ledger genesis SHA-256",
      ),
      deletionLedgerCheckpointSha256: normalizeSha256(
        String(value.restoreRehearsal.deletionLedgerCheckpointSha256 ?? ""),
        "Attested restore deletion-ledger checkpoint SHA-256",
      ),
      databaseBytes: assertPositiveInteger(
        value.restoreRehearsal.databaseBytes,
        "Attested restore source database bytes",
      ),
      evidenceFileCount: assertNonNegativeInteger(
        value.restoreRehearsal.evidenceFileCount,
        "Attested restore source evidence count",
      ),
      storageEvidenceFileCount: assertNonNegativeInteger(
        value.restoreRehearsal.storageEvidenceFileCount,
        "Attested restore source Storage-evidence count",
      ),
      tombstonesApplied: assertNonNegativeInteger(
        value.restoreRehearsal.tombstonesApplied,
        "Attested applied tombstone count",
      ),
      evidenceFilesPurged: attestedEvidenceFilesPurged,
      evidencePurgedPathSha256s: attestedEvidencePurgeHashes,
    },
  };
}

export function serializeRestoreRuntimeAttestation(attestation: RestoreRuntimeAttestation): Buffer {
  const normalized = normalizeRestoreRuntimeAttestation(attestation);
  return Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function buildRestoreRuntimeAttestation(
  input: BuildRestoreRuntimeAttestationInput,
): Promise<RestoreRuntimeAttestation> {
  const restoreRoot = path.resolve(input.restoreRoot);
  const restoreRootRealPath = await assertDirectory(restoreRoot, "Restore root");
  const attestationPath = path.join(restoreRoot, RESTORE_RUNTIME_ATTESTATION_FILE);
  const hasAttestation = fs.existsSync(attestationPath);
  await assertRestoreRootEntries(restoreRoot, hasAttestation);
  const backupId = normalizeBackupId(input.backupId);
  const source = await readSourceManifestSummary({
    sourceManifestPath: input.sourceManifestPath,
    expectedSourceManifestSha256: input.expectedSourceManifestSha256,
  });
  const databasePath = path.join(restoreRoot, RESTORE_RUNTIME_DATABASE_FILE);
  const evidencePath = path.join(restoreRoot, RESTORE_RUNTIME_EVIDENCE_DIRECTORY);
  const storageEvidencePath = path.join(
    restoreRoot,
    RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY,
  );
  const database = await inspectRegularFile(
    databasePath,
    "Restored SQLite database",
    restoreRootRealPath,
  );
  const evidenceFiles = await listStrictEvidenceFiles(evidencePath, restoreRootRealPath);
  const rawStorageEvidenceFiles = await listStrictStorageEvidenceFiles(
    storageEvidencePath,
    restoreRootRealPath,
  );
  const sourceStorageFilesByPath = new Map(
    source.summary.storageEvidence.files.map((file) => [file.path, file]),
  );
  const storageEvidenceFiles = rawStorageEvidenceFiles.map((file) => {
    const sourceFile = sourceStorageFilesByPath.get(file.path);
    if (!sourceFile) {
      throw new Error(
        `Restore Storage evidence does not match the trusted source manifest: ${file.path}`,
      );
    }
    return { ...file, contentType: sourceFile.contentType };
  });
  const inspectedDatabase = inspectSqliteDatabase(
    databasePath,
    evidenceFiles,
    storageEvidenceFiles,
  );
  const restoreState = inspectedDatabase.state;
  reconcileRuntimeFilesWithSource({
    sourceFiles: source.summary.evidence.files,
    runtimeFiles: evidenceFiles,
    deletedPaths: inspectedDatabase.deletedEvidencePaths,
    label: "Restore evidence",
  });
  reconcileRuntimeFilesWithSource({
    sourceFiles: source.summary.storageEvidence.files,
    runtimeFiles: storageEvidenceFiles,
    deletedPaths: inspectedDatabase.deletedStorageEvidencePaths,
    label: "Restore Storage evidence",
    compareMetadata: (sourceFile, runtimeFile) => (
      sourceFile.contentType === runtimeFile.contentType
    ),
  });
  const runtimeEvidenceOrphanPaths = assertRuntimeReferenceBinding({
    sourceFiles: source.summary.evidence.files,
    sourceOrphanPaths: source.summary.evidence.orphanPaths,
    sourceDatabaseReferenceCount: source.summary.evidence.databaseReferenceCount,
    runtimeFiles: evidenceFiles,
    activePaths: inspectedDatabase.activeEvidencePaths,
    activeReferenceCount: inspectedDatabase.activeEvidenceReferenceCount,
    deletedPaths: inspectedDatabase.deletedEvidencePaths,
    label: "Restore evidence",
  });
  const runtimeStorageOrphanPaths = assertRuntimeReferenceBinding({
    sourceFiles: source.summary.storageEvidence.files,
    sourceOrphanPaths: source.summary.storageEvidence.orphanPaths,
    sourceDatabaseReferenceCount: source.summary.storageEvidence.databaseReferenceCount,
    runtimeFiles: storageEvidenceFiles,
    activePaths: inspectedDatabase.activeStoragePaths,
    activeReferenceCount: inspectedDatabase.activeStorageReferenceCount,
    deletedPaths: inspectedDatabase.deletedStorageEvidencePaths,
    label: "Restore Storage evidence",
  });
  assertStateMatchesSourceAndRuntime({
    state: restoreState,
    source: source.summary,
    backupId,
    sourceManifestSha256: source.sha256,
    deletionLedgerSha256: normalizeSha256(
      input.expectedDeletionLedgerSha256,
      "Expected deletion ledger SHA-256",
    ),
    deletionLedgerGenesisSha256: normalizeSha256(
      input.expectedDeletionLedgerGenesisSha256,
      "Expected deletion-ledger genesis SHA-256",
    ),
    deletionLedgerCheckpointSha256: normalizeSha256(
      input.expectedDeletionLedgerCheckpointSha256,
      "Expected deletion-ledger checkpoint SHA-256",
    ),
    evidenceFileCount: evidenceFiles.length,
    storageEvidenceFileCount: storageEvidenceFiles.length,
    runtimeEvidenceFiles: evidenceFiles,
    runtimeStorageEvidenceFiles: storageEvidenceFiles,
  });
  const databaseAfterChecks = await inspectRegularFile(
    databasePath,
    "Restored SQLite database",
    restoreRootRealPath,
  );
  const evidenceFilesAfterChecks = await listStrictEvidenceFiles(evidencePath, restoreRootRealPath);
  const storageEvidenceFilesAfterChecks = await listStrictStorageEvidenceFiles(
    storageEvidencePath,
    restoreRootRealPath,
  );
  if (
    database.bytes !== databaseAfterChecks.bytes ||
    database.sha256 !== databaseAfterChecks.sha256 ||
    !sameRuntimeFiles(evidenceFiles, evidenceFilesAfterChecks) ||
    !sameRuntimeFiles(storageEvidenceFiles, storageEvidenceFilesAfterChecks)
  ) {
    throw new Error("Restore runtime artifacts changed during attestation checks.");
  }
  await assertRestoreRootEntries(restoreRoot, hasAttestation);
  return normalizeRestoreRuntimeAttestation({
    version: RESTORE_RUNTIME_ATTESTATION_VERSION,
    kind: RESTORE_RUNTIME_ATTESTATION_KIND,
    backupId,
    sourceManifestSha256: source.sha256,
    database: {
      path: RESTORE_RUNTIME_DATABASE_FILE,
      bytes: database.bytes,
      sha256: database.sha256,
    },
    evidence: {
      path: RESTORE_RUNTIME_EVIDENCE_DIRECTORY,
      fileCount: evidenceFiles.length,
      bytes: evidenceFiles.reduce((total, file) => total + file.bytes, 0),
      files: evidenceFiles,
      databaseReferenceCount: inspectedDatabase.activeEvidenceReferenceCount,
      orphanPaths: runtimeEvidenceOrphanPaths,
    },
    storageEvidence: {
      provider: "supabase",
      bucket: source.summary.storageEvidence.bucket,
      path: RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY,
      fileCount: storageEvidenceFiles.length,
      bytes: storageEvidenceFiles.reduce((total, file) => total + file.bytes, 0),
      files: storageEvidenceFiles,
      databaseReferenceCount: inspectedDatabase.activeStorageReferenceCount,
      orphanPaths: runtimeStorageOrphanPaths,
    },
    restoreRehearsal: restoreState,
  });
}

export async function writeRestoreRuntimeAttestation(
  input: BuildRestoreRuntimeAttestationInput,
): Promise<VerifiedRestoreRuntimeAttestation> {
  const restoreRoot = path.resolve(input.restoreRoot);
  const attestationPath = path.join(restoreRoot, RESTORE_RUNTIME_ATTESTATION_FILE);
  if (fs.existsSync(attestationPath)) {
    throw new Error("Restore runtime attestation already exists and will not be overwritten.");
  }
  const attestation = await buildRestoreRuntimeAttestation(input);
  const bytes = serializeRestoreRuntimeAttestation(attestation);
  const handle = await fs.promises.open(attestationPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.chmod(attestationPath, 0o600);
  const attestationSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return verifyRestoreRuntimeAttestation({
    restoreRoot,
    expectedAttestationSha256: attestationSha256,
    expectedBackupId: attestation.backupId,
    expectedSourceManifestSha256: attestation.sourceManifestSha256,
  });
}

export async function verifyRestoreRuntimeAttestation(
  input: VerifyRestoreRuntimeAttestationInput,
): Promise<VerifiedRestoreRuntimeAttestation> {
  const restoreRoot = path.resolve(input.restoreRoot);
  const restoreRootRealPath = await assertDirectory(restoreRoot, "Restore root");
  await assertRestoreRootEntries(restoreRoot, true);
  const attestationPath = path.join(restoreRoot, RESTORE_RUNTIME_ATTESTATION_FILE);
  const inspectedAttestation = await inspectRegularFile(
    attestationPath,
    "Restore runtime attestation",
    restoreRootRealPath,
  );
  const expectedAttestationSha256 = normalizeSha256(
    input.expectedAttestationSha256,
    "Restore runtime attestation SHA-256",
  );
  assertSameSha256(
    inspectedAttestation.sha256,
    expectedAttestationSha256,
    "Restore runtime attestation",
  );
  const rawAttestation = await fs.promises.readFile(attestationPath);
  if (
    rawAttestation.length !== inspectedAttestation.bytes ||
    sha256Bytes(rawAttestation) !== inspectedAttestation.sha256
  ) {
    throw new Error("Restore runtime attestation changed while it was being read.");
  }
  const attestation = normalizeRestoreRuntimeAttestation(
    JSON.parse(rawAttestation.toString("utf8")) as unknown,
  );
  if (!rawAttestation.equals(serializeRestoreRuntimeAttestation(attestation))) {
    throw new Error("Restore runtime attestation is not in its deterministic canonical form.");
  }
  if (attestation.backupId !== normalizeBackupId(input.expectedBackupId)) {
    throw new Error("Restore runtime attestation is for a different backup ID.");
  }
  const expectedSourceManifestSha256 = normalizeSha256(
    input.expectedSourceManifestSha256,
    "Expected source manifest SHA-256",
  );
  assertSameSha256(
    attestation.sourceManifestSha256,
    expectedSourceManifestSha256,
    "Restore runtime source manifest",
  );
  if (attestation.restoreRehearsal.backupId !== attestation.backupId) {
    throw new Error("Attested restore state is for a different backup ID.");
  }
  assertSameSha256(
    attestation.restoreRehearsal.sourceManifestSha256,
    attestation.sourceManifestSha256,
    "Attested restore-state source manifest",
  );

  const databasePath = path.join(restoreRoot, RESTORE_RUNTIME_DATABASE_FILE);
  const evidencePath = path.join(restoreRoot, RESTORE_RUNTIME_EVIDENCE_DIRECTORY);
  const storageEvidencePath = path.join(
    restoreRoot,
    RESTORE_RUNTIME_STORAGE_EVIDENCE_DIRECTORY,
  );
  const database = await inspectRegularFile(
    databasePath,
    "Restored SQLite database",
    restoreRootRealPath,
  );
  if (
    database.bytes !== attestation.database.bytes ||
    database.sha256 !== attestation.database.sha256
  ) {
    throw new Error("Restored SQLite database does not match its runtime attestation.");
  }
  const evidenceFiles = await listStrictEvidenceFiles(evidencePath, restoreRootRealPath);
  if (
    evidenceFiles.length !== attestation.evidence.files.length ||
    evidenceFiles.some((file, index) => {
      const expected = attestation.evidence.files[index];
      return !expected ||
        file.path !== expected.path ||
        file.bytes !== expected.bytes ||
        file.sha256 !== expected.sha256;
    })
  ) {
    throw new Error("Restore evidence contents do not match the runtime attestation.");
  }
  const rawStorageEvidenceFiles = await listStrictStorageEvidenceFiles(
    storageEvidencePath,
    restoreRootRealPath,
  );
  if (!sameRuntimeFiles(rawStorageEvidenceFiles, attestation.storageEvidence.files)) {
    throw new Error("Restore Storage-evidence contents do not match the runtime attestation.");
  }
  const inspectedDatabase = inspectSqliteDatabase(
    databasePath,
    evidenceFiles,
    attestation.storageEvidence.files,
  );
  const state = inspectedDatabase.state;
  const currentEvidenceOrphanPaths = evidenceFiles
    .map((file) => file.path)
    .filter((filePath) => !inspectedDatabase.activeEvidencePaths.has(filePath))
    .sort(comparePaths);
  const currentStorageOrphanPaths = rawStorageEvidenceFiles
    .map((file) => file.path)
    .filter((filePath) => !inspectedDatabase.activeStoragePaths.has(filePath))
    .sort(comparePaths);
  if (
    inspectedDatabase.activeEvidenceReferenceCount !==
      attestation.evidence.databaseReferenceCount ||
    inspectedDatabase.activeStorageReferenceCount !==
      attestation.storageEvidence.databaseReferenceCount ||
    JSON.stringify(currentEvidenceOrphanPaths) !==
      JSON.stringify(attestation.evidence.orphanPaths) ||
    JSON.stringify(currentStorageOrphanPaths) !==
      JSON.stringify(attestation.storageEvidence.orphanPaths)
  ) {
    throw new Error("Restore database-reference and orphan reconciliation changed after attestation.");
  }
  if (JSON.stringify(state) !== JSON.stringify(attestation.restoreRehearsal)) {
    throw new Error("Restore rehearsal state does not match the runtime attestation.");
  }
  if (
    evidenceFiles.length + rawStorageEvidenceFiles.length !==
      state.evidenceFileCount + state.storageEvidenceFileCount - state.evidenceFilesPurged
  ) {
    throw new Error("Retained restore evidence count no longer matches the rehearsal result.");
  }
  const databaseAfterChecks = await inspectRegularFile(
    databasePath,
    "Restored SQLite database",
    restoreRootRealPath,
  );
  const evidenceFilesAfterChecks = await listStrictEvidenceFiles(evidencePath, restoreRootRealPath);
  const storageEvidenceFilesAfterChecks = await listStrictStorageEvidenceFiles(
    storageEvidencePath,
    restoreRootRealPath,
  );
  if (
    databaseAfterChecks.bytes !== attestation.database.bytes ||
    databaseAfterChecks.sha256 !== attestation.database.sha256 ||
    !sameRuntimeFiles(evidenceFilesAfterChecks, attestation.evidence.files) ||
    !sameRuntimeFiles(storageEvidenceFilesAfterChecks, attestation.storageEvidence.files)
  ) {
    throw new Error("Restore runtime artifacts changed during verification.");
  }
  await assertRestoreRootEntries(restoreRoot, true);
  return {
    restoreRoot,
    databasePath,
    evidencePath,
    storageEvidencePath,
    attestationPath,
    attestationSha256: inspectedAttestation.sha256,
    attestation,
  };
}

export async function activateVerifiedRestoreRuntime(
  input: ActivateVerifiedRestoreRuntimeInput,
): Promise<ActivatedRestoreRuntime> {
  if (!path.isAbsolute(input.incomingRoot) || !path.isAbsolute(input.finalRoot)) {
    throw new Error("Restore activation paths must be absolute.");
  }
  const incomingRoot = path.resolve(input.incomingRoot);
  const finalRoot = path.resolve(input.finalRoot);
  const backupId = normalizeBackupId(input.expectedBackupId);
  const parentPath = path.dirname(incomingRoot);
  if (path.dirname(finalRoot) !== parentPath) {
    throw new Error("Incoming and final restore directories must share one parent directory.");
  }
  if (
    path.basename(incomingRoot) !== `incoming-${backupId}` ||
    path.basename(finalRoot) !== `restore-${backupId}`
  ) {
    throw new Error("Restore activation directory names do not match the trusted backup ID.");
  }

  const parentStat = await fs.promises.lstat(parentPath);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("Restore activation parent must be a real directory.");
  }
  if ((parentStat.mode & 0o022) !== 0) {
    throw new Error("Restore activation parent must not be group- or world-writable.");
  }
  const parentRealPath = await fs.promises.realpath(parentPath);
  const incomingStat = await fs.promises.lstat(incomingRoot);
  if (incomingStat.isSymbolicLink() || !incomingStat.isDirectory()) {
    throw new Error("Incoming restore root must be a real directory.");
  }
  const incomingRealPath = await fs.promises.realpath(incomingRoot);
  if (
    path.dirname(incomingRealPath) !== parentRealPath ||
    incomingStat.dev !== parentStat.dev
  ) {
    throw new Error("Incoming restore root must be a same-volume direct child of its parent.");
  }
  const incomingIdentity: DirectoryIdentity = {
    dev: incomingStat.dev,
    ino: incomingStat.ino,
  };

  const lockPath = path.join(parentPath, ".pint-path-restore-activation.lock");
  let lockHandle: fs.promises.FileHandle | null = null;
  let ownsLock = false;
  let operationFailed = false;
  let activatedResult: ActivatedRestoreRuntime | null = null;
  try {
    try {
      lockHandle = await fs.promises.open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Another restore activation is already in progress.");
      }
      throw error;
    }
    ownsLock = true;
    await lockHandle.writeFile(`${backupId}\n`, { encoding: "utf8" });
    await lockHandle.sync();
    await fsyncDirectory(parentPath);
    await assertPathDoesNotExist(finalRoot, "Final restore root");

    const verified = await verifyRestoreRuntimeAttestation({
      restoreRoot: incomingRoot,
      expectedAttestationSha256: input.expectedAttestationSha256,
      expectedBackupId: backupId,
      expectedSourceManifestSha256: input.expectedSourceManifestSha256,
    });
    const recheckedIncoming = await fs.promises.lstat(incomingRoot);
    if (
      recheckedIncoming.isSymbolicLink() ||
      !recheckedIncoming.isDirectory() ||
      !sameDirectoryIdentity(incomingIdentity, recheckedIncoming) ||
      recheckedIncoming.dev !== parentStat.dev
    ) {
      throw new Error("Incoming restore root changed during activation verification.");
    }
    await assertPathDoesNotExist(finalRoot, "Final restore root");

    await atomicRenameNoReplace(incomingRoot, finalRoot);
    await fsyncDirectory(parentPath);
    try {
      const activatedStat = await fs.promises.lstat(finalRoot);
      if (
        activatedStat.isSymbolicLink() ||
        !activatedStat.isDirectory() ||
        !sameDirectoryIdentity(incomingIdentity, activatedStat)
      ) {
        throw new Error("Activated restore root is not the verified incoming directory.");
      }
      await verifyRestoreRuntimeAttestation({
        restoreRoot: finalRoot,
        expectedAttestationSha256: verified.attestationSha256,
        expectedBackupId: backupId,
        expectedSourceManifestSha256: verified.attestation.sourceManifestSha256,
      });
    } catch (error) {
      try {
        await assertPathDoesNotExist(incomingRoot, "Incoming restore root");
        await atomicRenameNoReplace(finalRoot, incomingRoot);
        await fsyncDirectory(parentPath);
      } catch {
        throw new Error(
          "Activated restore failed final verification and automatic rollback also failed.",
        );
      }
      throw error;
    }

    activatedResult = {
      activated: true,
      activationLockCleanupRequired: false,
      backupId,
      attestationSha256: verified.attestationSha256,
      sourceManifestSha256: verified.attestation.sourceManifestSha256,
      sourceDatabaseSha256: verified.attestation.restoreRehearsal.sourceDatabaseSha256,
      runtimeDatabaseSha256: verified.attestation.database.sha256,
      evidenceFileCount: verified.attestation.evidence.fileCount,
      storageEvidenceFileCount: verified.attestation.storageEvidence.fileCount,
    };
    return activatedResult;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    let cleanupFailed = false;
    if (lockHandle) {
      try {
        await lockHandle.close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (ownsLock) {
      try {
        await fs.promises.unlink(lockPath);
        await fsyncDirectory(parentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailed = true;
      }
    }
    if (cleanupFailed && activatedResult) {
      activatedResult.activationLockCleanupRequired = true;
    } else if (cleanupFailed && !operationFailed) {
      throw new Error("Restore activation lock cleanup failed before activation completed.");
    }
  }
}
