import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { BusinessRepository } from "../db/business.repository.js";

export interface BackupFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupStorageFile extends BackupFile {
  contentType: string;
}

export interface AccountDeletionTombstone {
  requestId: string;
  userId: string;
  completedAt: string;
}

export interface AccountDeletionTombstoneDocument {
  version: 1;
  generatedAt: string;
  tombstones: AccountDeletionTombstone[];
}

interface EmptyDeletionLedgerGenesis {
  version: 1;
  kind: "pint-path-account-deletion-ledger-genesis";
  createdAt: string;
  immutablePrefix: string;
  currentLedgerPath: string;
}

interface EmptyDeletionLedgerCheckpoint {
  version: 2;
  generatedAt: string;
  genesisPath: string;
  genesisSha256: string;
  currentLedgerPath: string;
  currentLedgerSha256: string;
  immutableObjectCount: number;
  immutableSetSha256: string;
  tombstoneCount: number;
  latestCompletedAt: string | null;
}

const TOMBSTONE_LEDGER_PREFIX = "_control/account-deletion-ledger/v1";
const TOMBSTONE_LEDGER_GENESIS_PATH = "_control/account-deletion-ledger-genesis.json";
const CURRENT_TOMBSTONE_LEDGER_PATH = "_control/account-deletion-tombstones.json";

export interface BackupStorageEvidence {
  provider: "supabase";
  bucket: string;
  path: string;
  fileCount: number;
  bytes: number;
  files: BackupStorageFile[];
  databaseReferenceCount: number;
  orphanPaths: string[];
  reconciliationAttempts: number;
}

export interface SupabaseEvidenceReference {
  id: string;
  objectPath: string;
  mimeType: string | null;
  byteSize: number | null;
}

export type FilesystemEvidenceReference = Omit<SupabaseEvidenceReference, "mimeType">;

export interface BackupManifest {
  version: 1 | 2;
  createdAt: string;
  database: BackupFile;
  evidence: {
    path: string;
    fileCount: number;
    bytes: number;
    files: BackupFile[];
    databaseReferenceCount?: number;
    orphanPaths?: string[];
  };
  storageEvidence?: BackupStorageEvidence;
  deletionTombstones?: BackupFile & { count: number };
}

export interface RestoreRehearsalResult {
  manifest: BackupManifest;
  restoreRoot: string;
  databasePath: string;
  evidencePath: string;
  storageEvidencePath: string | null;
  tombstonesApplied: number;
  evidenceFilesPurged: number;
  evidencePurgedPathSha256s: string[];
  authority: {
    sourceManifestSha256: string;
    sourceDatabaseSha256: string;
    deletionLedgerSha256: string;
    deletionLedgerGenesisSha256: string;
    deletionLedgerCheckpointSha256: string;
  };
}

interface StableFileSnapshot {
  bytes: Buffer | null;
  size: number;
  sha256: string;
}

function sameStableFile(
  identity: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  stat: fs.Stats,
): boolean {
  return identity.dev === stat.dev &&
    identity.ino === stat.ino &&
    identity.size === stat.size &&
    identity.mtimeMs === stat.mtimeMs &&
    identity.ctimeMs === stat.ctimeMs;
}

async function readStableFileSnapshot(
  filePath: string,
  includeBytes: boolean,
): Promise<StableFileSnapshot> {
  const before = await fs.promises.lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error("Trusted file must be one regular, non-linked file.");
  }
  const identity = {
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
  const chunks: Buffer[] = [];
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameStableFile(identity, opened)) {
      throw new Error("Trusted file changed before it was read.");
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
      if (bytesRead === 0) throw new Error("Trusted file ended before its declared size.");
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(chunk);
      if (includeBytes) chunks.push(chunk);
      position += bytesRead;
    }
    const afterDescriptor = await handle.stat();
    const afterPath = await fs.promises.lstat(filePath);
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.nlink !== 1 ||
      !sameStableFile(identity, afterDescriptor) ||
      !sameStableFile(identity, afterPath)
    ) {
      throw new Error("Trusted file changed while it was read.");
    }
  } finally {
    await handle.close();
  }
  return {
    bytes: includeBytes ? Buffer.concat(chunks, before.size) : null,
    size: before.size,
    sha256: hash.digest("hex"),
  };
}

export async function sha256File(filePath: string): Promise<string> {
  return (await readStableFileSnapshot(filePath, false)).sha256;
}

export function sha256Bytes(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function tableExists(database: BetterSqlite3.Database, tableName: string): boolean {
  return Boolean(database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName));
}

export function normalizeTombstones(tombstones: AccountDeletionTombstone[]): AccountDeletionTombstone[] {
  const byUserId = new Map<string, AccountDeletionTombstone>();
  for (const tombstone of tombstones) {
    const requestId = String(tombstone.requestId || "").trim();
    const userId = String(tombstone.userId || "").trim();
    const completedAt = String(tombstone.completedAt || "").trim();
    if (!requestId || !userId || !completedAt || Number.isNaN(Date.parse(completedAt))) {
      throw new Error("Invalid account-deletion tombstone.");
    }
    const existing = byUserId.get(userId);
    if (!existing || Date.parse(existing.completedAt) < Date.parse(completedAt)) {
      byUserId.set(userId, { requestId, userId, completedAt });
    }
  }
  return [...byUserId.values()].sort((first, second) => first.userId.localeCompare(second.userId));
}

export function listSupabaseEvidenceReferences(databasePath: string): SupabaseEvidenceReference[] {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(database, "source_evidence_objects")) return [];
    return database.prepare(
      `SELECT id, object_path AS objectPath, mime_type AS mimeType, byte_size AS byteSize
         FROM source_evidence_objects
        WHERE storage_provider = 'supabase_private' AND deleted_at IS NULL
        ORDER BY object_path ASC`,
    ).all() as SupabaseEvidenceReference[];
  } finally {
    database.close();
  }
}

export function listFilesystemEvidenceReferences(databasePath: string): FilesystemEvidenceReference[] {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(database, "source_evidence_objects")) return [];
    return database.prepare(
      `SELECT id, object_path AS objectPath, byte_size AS byteSize
         FROM source_evidence_objects
        WHERE storage_provider = 'filesystem_private' AND deleted_at IS NULL
        ORDER BY object_path ASC`,
    ).all() as FilesystemEvidenceReference[];
  } finally {
    database.close();
  }
}

export function listAccountDeletionTombstones(databasePath: string): AccountDeletionTombstone[] {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(database, "account_deletion_requests")) return [];
    const rows = database.prepare(
      `SELECT id AS requestId, user_id AS userId, completed_at AS completedAt
         FROM account_deletion_requests
        WHERE status = 'completed' AND completed_at IS NOT NULL
        ORDER BY completed_at ASC, id ASC`,
    ).all() as AccountDeletionTombstone[];
    return normalizeTombstones(rows);
  } finally {
    database.close();
  }
}

export function parseAccountDeletionTombstones(value: string | Buffer): AccountDeletionTombstoneDocument {
  const parsed = JSON.parse(value.toString()) as AccountDeletionTombstoneDocument;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.tombstones) ||
    !parsed.generatedAt ||
    Number.isNaN(Date.parse(parsed.generatedAt))
  ) {
    throw new Error("Unsupported account-deletion tombstone document.");
  }
  return {
    version: 1,
    generatedAt: String(parsed.generatedAt || ""),
    tombstones: normalizeTombstones(parsed.tombstones),
  };
}

export async function readAccountDeletionTombstones(
  tombstonePath: string,
): Promise<AccountDeletionTombstoneDocument> {
  return parseAccountDeletionTombstones(await fs.promises.readFile(tombstonePath));
}

async function writeAccountDeletionTombstones(
  tombstonePath: string,
  tombstones: AccountDeletionTombstone[],
): Promise<BackupFile & { count: number }> {
  const document: AccountDeletionTombstoneDocument = {
    version: 1,
    generatedAt: new Date().toISOString(),
    tombstones: normalizeTombstones(tombstones),
  };
  await fs.promises.writeFile(tombstonePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  const stat = await fs.promises.stat(tombstonePath);
  return {
    path: path.basename(tombstonePath),
    bytes: stat.size,
    sha256: await sha256File(tombstonePath),
    count: document.tombstones.length,
  };
}

async function writeBackupManifest(backupRoot: string, manifest: BackupManifest): Promise<void> {
  await fs.promises.writeFile(
    path.join(backupRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function finalizeBackupSupplementalData(input: {
  backupRoot: string;
  storageEvidence: BackupStorageEvidence;
  deletionTombstones: AccountDeletionTombstone[];
}): Promise<BackupManifest> {
  const backupRoot = path.resolve(input.backupRoot);
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(backupRoot, "manifest.json"), "utf8"),
  ) as BackupManifest;
  const deletionTombstones = await writeAccountDeletionTombstones(
    path.join(backupRoot, "account-deletion-tombstones.json"),
    input.deletionTombstones,
  );
  const completed: BackupManifest = {
    ...manifest,
    version: 2,
    storageEvidence: input.storageEvidence,
    deletionTombstones,
  };
  await writeBackupManifest(backupRoot, completed);
  return completed;
}

export async function listBackupFiles(root: string, current = root): Promise<BackupFile[]> {
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  const files: BackupFile[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listBackupFiles(root, absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.promises.stat(absolutePath);
    files.push({
      path: path.relative(root, absolutePath),
      bytes: stat.size,
      sha256: await sha256File(absolutePath),
    });
  }
  return files.sort((first, second) => first.path.localeCompare(second.path));
}

function sameBackupFiles(first: BackupFile[], second: BackupFile[]): boolean {
  return first.length === second.length && first.every((file, index) => (
    file.path === second[index]?.path &&
    file.bytes === second[index]?.bytes &&
    file.sha256 === second[index]?.sha256
  ));
}

function assertFilesystemEvidenceReferences(
  references: FilesystemEvidenceReference[],
  files: BackupFile[],
): void {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  for (const reference of references) {
    const file = filesByPath.get(reference.objectPath);
    if (!file) {
      throw new Error(`Backup is missing database-referenced filesystem evidence: ${reference.objectPath}`);
    }
    if (reference.byteSize !== null && reference.byteSize !== file.bytes) {
      throw new Error(`Backup filesystem evidence has the wrong byte size: ${reference.objectPath}`);
    }
  }
}

function assertDatabaseFilesystemEvidenceReferences(
  databasePath: string,
  evidence: BackupManifest["evidence"],
): void {
  const references = listFilesystemEvidenceReferences(databasePath);
  if (evidence.databaseReferenceCount !== references.length || !Array.isArray(evidence.orphanPaths)) {
    throw new Error("Backup filesystem-evidence reconciliation metadata is stale or missing.");
  }
  assertFilesystemEvidenceReferences(references, evidence.files);
  const referencePaths = new Set(references.map((reference) => reference.objectPath));
  const actualOrphans = evidence.files
    .map((file) => file.path)
    .filter((filePath) => !referencePaths.has(filePath))
    .sort((first, second) => first.localeCompare(second));
  const declaredOrphans = [...evidence.orphanPaths]
    .sort((first, second) => first.localeCompare(second));
  if (
    actualOrphans.length !== declaredOrphans.length ||
    actualOrphans.some((filePath, index) => filePath !== declaredOrphans[index])
  ) {
    throw new Error("Backup filesystem-evidence orphan report does not match the exported files.");
  }
}

export async function createDataBackup(input: {
  sourceDatabase: string;
  sourceEvidence: string;
  backupRoot: string;
}): Promise<BackupManifest> {
  const sourceDatabase = path.resolve(input.sourceDatabase);
  const sourceEvidence = path.resolve(input.sourceEvidence);
  const backupRoot = path.resolve(input.backupRoot);
  const backupDatabase = path.join(backupRoot, "pint-path.sqlite");
  const backupEvidence = path.join(backupRoot, "source-evidence");

  if (!fs.existsSync(sourceDatabase)) {
    throw new Error(`Database does not exist: ${sourceDatabase}`);
  }

  if (fs.existsSync(backupRoot) && (await fs.promises.readdir(backupRoot)).length > 0) {
    throw new Error(`Backup destination is not empty: ${backupRoot}`);
  }

  await fs.promises.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const database = new BetterSqlite3(sourceDatabase, { readonly: true, fileMustExist: true });
  try {
    await database.backup(backupDatabase);
  } finally {
    database.close();
  }
  // The live database runs in WAL mode. Normalize the self-contained backup
  // copy before any verification opens it so SQLite does not create untracked
  // `-wal`/`-shm` files beside the manifest-authoritative database object.
  const normalizedBackup = new BetterSqlite3(backupDatabase, { fileMustExist: true });
  try {
    const journalMode = normalizedBackup.pragma("journal_mode = DELETE", { simple: true });
    if (String(journalMode).toLowerCase() !== "delete") {
      throw new Error("Could not normalize the backup SQLite journal mode.");
    }
  } finally {
    normalizedBackup.close();
  }
  await fs.promises.rm(`${backupDatabase}-wal`, { force: true });
  await fs.promises.rm(`${backupDatabase}-shm`, { force: true });

  const sourceEvidenceBefore = fs.existsSync(sourceEvidence) ? await listBackupFiles(sourceEvidence) : [];
  if (fs.existsSync(sourceEvidence)) {
    await fs.promises.cp(sourceEvidence, backupEvidence, { recursive: true, errorOnExist: true });
  }
  const sourceEvidenceAfter = fs.existsSync(sourceEvidence) ? await listBackupFiles(sourceEvidence) : [];
  if (!sameBackupFiles(sourceEvidenceBefore, sourceEvidenceAfter)) {
    throw new Error("Filesystem source evidence changed while the backup snapshot was being captured.");
  }

  const databaseStat = await fs.promises.stat(backupDatabase);
  const evidenceFiles = fs.existsSync(backupEvidence) ? await listBackupFiles(backupEvidence) : [];
  const filesystemReferences = listFilesystemEvidenceReferences(backupDatabase);
  const filesystemReferencePaths = new Set(filesystemReferences.map((reference) => reference.objectPath));
  assertFilesystemEvidenceReferences(filesystemReferences, evidenceFiles);
  const deletionTombstones = await writeAccountDeletionTombstones(
    path.join(backupRoot, "account-deletion-tombstones.json"),
    listAccountDeletionTombstones(backupDatabase),
  );
  const manifest: BackupManifest = {
    version: 2,
    createdAt: new Date().toISOString(),
    database: {
      path: path.basename(backupDatabase),
      bytes: databaseStat.size,
      sha256: await sha256File(backupDatabase),
    },
    evidence: {
      path: path.basename(backupEvidence),
      fileCount: evidenceFiles.length,
      bytes: evidenceFiles.reduce((sum, file) => sum + file.bytes, 0),
      files: evidenceFiles,
      databaseReferenceCount: filesystemReferences.length,
      orphanPaths: evidenceFiles
        .map((file) => file.path)
        .filter((filePath) => !filesystemReferencePaths.has(filePath))
        .sort((first, second) => first.localeCompare(second)),
    },
    deletionTombstones,
  };

  await writeBackupManifest(backupRoot, manifest);

  return manifest;
}

function resolveContainedPath(root: string, relativePath: string): string {
  const normalizedRoot = path.resolve(root);
  const filePath = path.resolve(normalizedRoot, relativePath);
  if (filePath !== normalizedRoot && !filePath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Unsafe manifest path: ${relativePath}`);
  }
  return filePath;
}

async function assertBackupFile(root: string, expected: BackupFile): Promise<void> {
  const filePath = resolveContainedPath(root, expected.path);
  if (filePath === path.resolve(root)) {
    throw new Error(`Unsafe manifest path: ${expected.path}`);
  }
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size !== expected.bytes || await sha256File(filePath) !== expected.sha256) {
    throw new Error(`Backup checksum mismatch: ${expected.path}`);
  }
}

function assertSqliteIntegrity(databasePath: string): void {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
    }
    if (foreignKeys.length > 0) {
      throw new Error(`SQLite foreign-key check failed: ${JSON.stringify(foreignKeys)}`);
    }
  } finally {
    database.close();
  }
}

async function verifyDataBackupWithAuthority(backupPath: string): Promise<{
  manifest: BackupManifest;
  manifestSha256: string;
}> {
  const backupRoot = path.resolve(backupPath);
  const manifestPath = path.join(backupRoot, "manifest.json");
  const manifestSnapshot = await readStableFileSnapshot(manifestPath, true);
  const manifest = JSON.parse(manifestSnapshot.bytes!.toString("utf8")) as BackupManifest;
  if (
    ![1, 2].includes(manifest.version) ||
    !manifest.database ||
    !manifest.evidence ||
    !Array.isArray(manifest.evidence.files)
  ) {
    throw new Error("Unsupported backup manifest version.");
  }
  const evidenceBytes = manifest.evidence.files.reduce((total, file) => total + file.bytes, 0);
  if (
    manifest.evidence.fileCount !== manifest.evidence.files.length ||
    manifest.evidence.bytes !== evidenceBytes ||
    (manifest.version >= 2 && (
      !Number.isInteger(manifest.evidence.databaseReferenceCount) ||
      !Array.isArray(manifest.evidence.orphanPaths)
    ))
  ) {
    throw new Error("Backup evidence manifest totals do not match its file list.");
  }

  await assertBackupFile(backupRoot, manifest.database);
  const evidenceRoot = resolveContainedPath(backupRoot, manifest.evidence.path);
  for (const file of manifest.evidence.files) await assertBackupFile(evidenceRoot, file);
  const actualEvidenceFiles = fs.existsSync(evidenceRoot) ? await listBackupFiles(evidenceRoot) : [];
  if (
    actualEvidenceFiles.length !== manifest.evidence.files.length ||
    actualEvidenceFiles.some((file, index) => file.path !== manifest.evidence.files[index]?.path)
  ) {
    throw new Error("Backup evidence contents do not match its manifest.");
  }
  if (manifest.version >= 2) {
    assertDatabaseFilesystemEvidenceReferences(
      resolveContainedPath(backupRoot, manifest.database.path),
      manifest.evidence,
    );
  }

  if (manifest.deletionTombstones) {
    await assertBackupFile(backupRoot, manifest.deletionTombstones);
    const tombstones = await readAccountDeletionTombstones(
      resolveContainedPath(backupRoot, manifest.deletionTombstones.path),
    );
    if (tombstones.tombstones.length !== manifest.deletionTombstones.count) {
      throw new Error("Backup deletion-tombstone count does not match its manifest.");
    }
  } else if (manifest.version >= 2) {
    throw new Error("Backup manifest is missing its account-deletion tombstones.");
  }

  if (manifest.storageEvidence) {
    const storageEvidence = manifest.storageEvidence;
    const storageBytes = storageEvidence.files.reduce((total, file) => total + file.bytes, 0);
    if (
      storageEvidence.provider !== "supabase" ||
      !storageEvidence.bucket ||
      storageEvidence.fileCount !== storageEvidence.files.length ||
      storageEvidence.bytes !== storageBytes ||
      storageEvidence.files.some((file) => !file.contentType) ||
      !Number.isInteger(storageEvidence.databaseReferenceCount) ||
      storageEvidence.databaseReferenceCount < 0 ||
      !Array.isArray(storageEvidence.orphanPaths) ||
      !Number.isInteger(storageEvidence.reconciliationAttempts) ||
      storageEvidence.reconciliationAttempts < 1
    ) {
      throw new Error("Backup Storage-evidence manifest totals or metadata are invalid.");
    }
    const storageRoot = resolveContainedPath(backupRoot, storageEvidence.path);
    for (const file of storageEvidence.files) await assertBackupFile(storageRoot, file);
    const actualStorageFiles = fs.existsSync(storageRoot) ? await listBackupFiles(storageRoot) : [];
    if (
      actualStorageFiles.length !== storageEvidence.files.length ||
      actualStorageFiles.some((file, index) => file.path !== storageEvidence.files[index]?.path)
    ) {
      throw new Error("Backup Storage-evidence contents do not match its manifest.");
    }
    assertDatabaseStorageEvidenceReferences(
      resolveContainedPath(backupRoot, manifest.database.path),
      storageEvidence,
    );
  } else if (listSupabaseEvidenceReferences(resolveContainedPath(backupRoot, manifest.database.path)).length > 0) {
    throw new Error("Backup database references Supabase evidence but the Storage export is missing.");
  }

  assertSqliteIntegrity(resolveContainedPath(backupRoot, manifest.database.path));

  const manifestAfterChecks = await readStableFileSnapshot(manifestPath, true);
  if (
    manifestAfterChecks.sha256 !== manifestSnapshot.sha256 ||
    !manifestAfterChecks.bytes!.equals(manifestSnapshot.bytes!)
  ) {
    throw new Error("Backup manifest changed while the backup was verified.");
  }
  return { manifest, manifestSha256: manifestSnapshot.sha256 };
}

export async function verifyDataBackup(backupPath: string): Promise<BackupManifest> {
  return (await verifyDataBackupWithAuthority(backupPath)).manifest;
}

function normalizeMimeType(value: string | null | undefined): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || null;
}

function assertDatabaseStorageEvidenceReferences(
  databasePath: string,
  storageEvidence: BackupStorageEvidence,
): void {
  const references = listSupabaseEvidenceReferences(databasePath);
  const filesByPath = new Map(storageEvidence.files.map((file) => [file.path, file]));
  if (references.length !== storageEvidence.databaseReferenceCount) {
    throw new Error("Backup Storage-evidence database-reference count is stale.");
  }
  for (const reference of references) {
    const file = filesByPath.get(reference.objectPath);
    if (!file) {
      throw new Error(`Backup is missing database-referenced Storage evidence: ${reference.objectPath}`);
    }
    if (reference.byteSize !== null && reference.byteSize !== file.bytes) {
      throw new Error(`Backup Storage evidence has the wrong byte size: ${reference.objectPath}`);
    }
    const expectedMimeType = normalizeMimeType(reference.mimeType);
    if (expectedMimeType && expectedMimeType !== normalizeMimeType(file.contentType)) {
      throw new Error(`Backup Storage evidence has the wrong MIME type: ${reference.objectPath}`);
    }
  }
  const referencePaths = new Set(references.map((reference) => reference.objectPath));
  const actualOrphans = storageEvidence.files
    .map((file) => file.path)
    .filter((filePath) => !referencePaths.has(filePath))
    .sort((first, second) => first.localeCompare(second));
  const declaredOrphans = [...storageEvidence.orphanPaths]
    .sort((first, second) => first.localeCompare(second));
  if (
    actualOrphans.length !== declaredOrphans.length ||
    actualOrphans.some((filePath, index) => filePath !== declaredOrphans[index])
  ) {
    throw new Error("Backup Storage-evidence orphan report does not match the exported objects.");
  }
}

async function applyAccountDeletionTombstones(input: {
  databasePath: string;
  evidencePath: string;
  storageEvidencePath: string | null;
  tombstones: AccountDeletionTombstone[];
}): Promise<{
  tombstonesApplied: number;
  evidenceFilesPurged: number;
  evidencePurgedPathSha256s: string[];
}> {
  if (input.tombstones.length === 0) {
    return {
      tombstonesApplied: 0,
      evidenceFilesPurged: 0,
      evidencePurgedPathSha256s: [],
    };
  }
  const database = new BetterSqlite3(input.databasePath);
  let tombstonesApplied = 0;
  let evidenceFilesPurged = 0;
  const evidencePurgedPathSha256s = new Set<string>();
  try {
    if (!tableExists(database, "accounts") || !tableExists(database, "account_deletion_requests")) {
      throw new Error("Restored database cannot apply account-deletion tombstones.");
    }
    const repository = new BusinessRepository(database);
    for (const tombstone of normalizeTombstones(input.tombstones)) {
      const account = database.prepare("SELECT id FROM accounts WHERE id = ? LIMIT 1").get(tombstone.userId);
      if (!account) continue;
      const evidenceRows = tableExists(database, "source_evidence_objects")
        ? database.prepare(
          `SELECT id, storage_provider AS storageProvider, object_path AS objectPath
             FROM source_evidence_objects
            WHERE owner_user_id = ? AND deleted_at IS NULL`,
        ).all(tombstone.userId) as Array<{ id: string; storageProvider: string; objectPath: string }>
        : [];
      const existingRequest = database.prepare(
        "SELECT id FROM account_deletion_requests WHERE user_id = ? ORDER BY requested_at DESC LIMIT 1",
      ).get(tombstone.userId) as { id: string } | undefined;
      const requestId = existingRequest?.id
        ?? `restore-deletion-${crypto.createHash("sha256").update(`${tombstone.userId}:${tombstone.completedAt}`).digest("hex").slice(0, 32)}`;
      if (existingRequest) {
        database.prepare(
          `UPDATE account_deletion_requests
              SET status = 'processing', reviewed_by = NULL, reviewed_at = NULL,
                  completed_at = NULL, last_error = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(tombstone.completedAt, requestId);
      } else {
        database.prepare(
          `INSERT INTO account_deletion_requests (
             id, user_id, status, user_message, requested_at, execute_after,
             reviewed_by, reviewed_at, completed_at, last_error, created_at, updated_at
           ) VALUES (?, ?, 'processing', NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        ).run(
          requestId,
          tombstone.userId,
          tombstone.completedAt,
          tombstone.completedAt,
          tombstone.completedAt,
          tombstone.completedAt,
        );
      }

      const summary = repository.executeAccountAnonymisation({
        requestId,
        reviewedBy: tombstone.userId,
        now: tombstone.completedAt,
      });
      for (const evidenceId of (summary.evidenceIds as string[] | undefined) ?? []) {
        repository.markSourceEvidenceDeleted({ id: evidenceId, deletedAt: tombstone.completedAt });
      }
      for (const evidence of evidenceRows) {
        const root = evidence.storageProvider === "filesystem_private"
          ? input.evidencePath
          : evidence.storageProvider === "supabase_private"
            ? input.storageEvidencePath
            : null;
        if (!root) continue;
        const restoredObject = resolveContainedPath(root, evidence.objectPath);
        if (fs.existsSync(restoredObject)) {
          evidenceFilesPurged += 1;
          evidencePurgedPathSha256s.add(sha256Bytes(Buffer.from(
            `${evidence.storageProvider}\0${evidence.objectPath}`,
            "utf8",
          )));
        }
        await fs.promises.rm(restoredObject, { force: true });
      }
      tombstonesApplied += 1;
    }
  } finally {
    database.close();
  }
  return {
    tombstonesApplied,
    evidenceFilesPurged,
    evidencePurgedPathSha256s: [...evidencePurgedPathSha256s].sort(),
  };
}

async function assertDeletionLedgerAuthority(input: {
  actualLedgerSha256: string;
  currentTombstones: AccountDeletionTombstone[];
  deletionLedgerGenesisPath: string;
  expectedDeletionLedgerGenesisSha256: string;
  deletionLedgerCheckpointPath: string;
  expectedDeletionLedgerCheckpointSha256: string;
}): Promise<{ genesisSha256: string; checkpointSha256: string }> {
  if (
    !/^[a-f0-9]{64}$/i.test(input.expectedDeletionLedgerGenesisSha256) ||
    !/^[a-f0-9]{64}$/i.test(input.expectedDeletionLedgerCheckpointSha256)
  ) {
    throw new Error(
      "Trusted SHA-256 checkpoints are required for deletion-ledger genesis and checkpoint records.",
    );
  }

  const genesisPath = path.resolve(input.deletionLedgerGenesisPath);
  const checkpointPath = path.resolve(input.deletionLedgerCheckpointPath);
  const genesisSnapshot = await readStableFileSnapshot(genesisPath, true);
  const checkpointSnapshot = await readStableFileSnapshot(checkpointPath, true);
  const actualGenesisSha256 = genesisSnapshot.sha256;
  const actualCheckpointSha256 = checkpointSnapshot.sha256;
  if (
    actualGenesisSha256 !== input.expectedDeletionLedgerGenesisSha256.toLowerCase() ||
    actualCheckpointSha256 !== input.expectedDeletionLedgerCheckpointSha256.toLowerCase()
  ) {
    throw new Error(
      "The deletion-ledger authority records do not match their trusted SHA-256 checkpoints.",
    );
  }

  const genesis = JSON.parse(genesisSnapshot.bytes!.toString("utf8")) as EmptyDeletionLedgerGenesis;
  const checkpoint = JSON.parse(
    checkpointSnapshot.bytes!.toString("utf8"),
  ) as EmptyDeletionLedgerCheckpoint;
  const currentTombstones = normalizeTombstones(input.currentTombstones);
  const expectedLatestCompletedAt = currentTombstones.reduce<string | null>(
    (latest, tombstone) => latest === null || Date.parse(tombstone.completedAt) > Date.parse(latest)
      ? tombstone.completedAt
      : latest,
    null,
  );
  const emptyImmutableSetSha256 = sha256Bytes(Buffer.from(JSON.stringify([])));
  if (
    genesis.version !== 1 ||
    genesis.kind !== "pint-path-account-deletion-ledger-genesis" ||
    !genesis.createdAt ||
    Number.isNaN(Date.parse(genesis.createdAt)) ||
    genesis.immutablePrefix !== TOMBSTONE_LEDGER_PREFIX ||
    genesis.currentLedgerPath !== CURRENT_TOMBSTONE_LEDGER_PATH ||
    checkpoint.version !== 2 ||
    !checkpoint.generatedAt ||
    Number.isNaN(Date.parse(checkpoint.generatedAt)) ||
    checkpoint.genesisPath !== TOMBSTONE_LEDGER_GENESIS_PATH ||
    checkpoint.genesisSha256 !== actualGenesisSha256 ||
    checkpoint.currentLedgerPath !== CURRENT_TOMBSTONE_LEDGER_PATH ||
    checkpoint.currentLedgerSha256 !== input.actualLedgerSha256 ||
    !Number.isSafeInteger(checkpoint.immutableObjectCount) ||
    checkpoint.immutableObjectCount < currentTombstones.length ||
    !/^[a-f0-9]{64}$/.test(checkpoint.immutableSetSha256) ||
    checkpoint.tombstoneCount !== currentTombstones.length ||
    checkpoint.latestCompletedAt !== expectedLatestCompletedAt ||
    (currentTombstones.length === 0 && (
      checkpoint.immutableObjectCount !== 0 ||
      checkpoint.immutableSetSha256 !== emptyImmutableSetSha256
    ))
  ) {
    throw new Error("The deletion ledger is not bound to a valid independent genesis/checkpoint state.");
  }
  return {
    genesisSha256: actualGenesisSha256,
    checkpointSha256: actualCheckpointSha256,
  };
}

export async function rehearseDataRestore(input: {
  backupPath: string;
  restoreRoot: string;
  deletionTombstonePath: string;
  expectedDeletionTombstoneSha256: string;
  deletionLedgerGenesisPath: string;
  expectedDeletionLedgerGenesisSha256: string;
  deletionLedgerCheckpointPath: string;
  expectedDeletionLedgerCheckpointSha256: string;
}): Promise<RestoreRehearsalResult> {
  const backupRoot = path.resolve(input.backupPath);
  const restoreRoot = path.resolve(input.restoreRoot);
  if (!input.deletionTombstonePath) {
    throw new Error("A current independent account-deletion tombstone ledger is required for every restore rehearsal.");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.expectedDeletionTombstoneSha256)) {
    throw new Error("A trusted expected SHA-256 checkpoint is required for the deletion ledger.");
  }
  const tombstonePath = path.resolve(input.deletionTombstonePath);
  const tombstoneSnapshot = await readStableFileSnapshot(tombstonePath, true);
  const actualTombstoneSha256 = tombstoneSnapshot.sha256;
  if (actualTombstoneSha256 !== input.expectedDeletionTombstoneSha256.toLowerCase()) {
    throw new Error("The deletion ledger does not match its trusted SHA-256 checkpoint.");
  }
  const currentTombstoneDocument = parseAccountDeletionTombstones(
    tombstoneSnapshot.bytes!,
  );
  const deletionAuthority = await assertDeletionLedgerAuthority({
    actualLedgerSha256: actualTombstoneSha256,
    currentTombstones: currentTombstoneDocument.tombstones,
    deletionLedgerGenesisPath: input.deletionLedgerGenesisPath,
    expectedDeletionLedgerGenesisSha256: input.expectedDeletionLedgerGenesisSha256,
    deletionLedgerCheckpointPath: input.deletionLedgerCheckpointPath,
    expectedDeletionLedgerCheckpointSha256: input.expectedDeletionLedgerCheckpointSha256,
  });
  const verifiedBackup = await verifyDataBackupWithAuthority(backupRoot);
  const manifest = verifiedBackup.manifest;
  const sourceManifestSha256 = verifiedBackup.manifestSha256;

  if (fs.existsSync(restoreRoot) && (await fs.promises.readdir(restoreRoot)).length > 0) {
    throw new Error(`Restore rehearsal destination is not empty: ${restoreRoot}`);
  }

  await fs.promises.mkdir(restoreRoot, { recursive: true, mode: 0o700 });
  const databasePath = path.join(restoreRoot, "pint-path.sqlite");
  const evidencePath = path.join(restoreRoot, "source-evidence");
  const storageEvidencePath = manifest.storageEvidence
    ? path.join(restoreRoot, "supabase-source-evidence")
    : null;
  await fs.promises.copyFile(path.join(backupRoot, manifest.database.path), databasePath);
  await fs.promises.chmod(databasePath, 0o600);

  const backupEvidencePath = path.join(backupRoot, manifest.evidence.path);
  if (fs.existsSync(backupEvidencePath)) {
    await fs.promises.cp(backupEvidencePath, evidencePath, { recursive: true, errorOnExist: true });
  }
  await fs.promises.mkdir(evidencePath, { recursive: true, mode: 0o700 });

  if (manifest.storageEvidence && storageEvidencePath) {
    const backupStoragePath = resolveContainedPath(backupRoot, manifest.storageEvidence.path);
    if (fs.existsSync(backupStoragePath)) {
      await fs.promises.cp(backupStoragePath, storageEvidencePath, { recursive: true, errorOnExist: true });
    }
    await fs.promises.mkdir(storageEvidencePath, { recursive: true, mode: 0o700 });
  }

  await assertBackupFile(restoreRoot, { ...manifest.database, path: path.basename(databasePath) });
  const restoredEvidenceFiles = fs.existsSync(evidencePath) ? await listBackupFiles(evidencePath) : [];
  if (
    restoredEvidenceFiles.length !== manifest.evidence.files.length ||
    restoredEvidenceFiles.some((file, index) => {
      const expected = manifest.evidence.files[index];
      return !expected || file.path !== expected.path || file.bytes !== expected.bytes || file.sha256 !== expected.sha256;
    })
  ) {
    throw new Error("Restored evidence contents do not match the backup manifest.");
  }
  if (manifest.storageEvidence && storageEvidencePath) {
    const restoredStorageFiles = fs.existsSync(storageEvidencePath)
      ? await listBackupFiles(storageEvidencePath)
      : [];
    if (
      restoredStorageFiles.length !== manifest.storageEvidence.files.length ||
      restoredStorageFiles.some((file, index) => {
        const expected = manifest.storageEvidence?.files[index];
        return !expected || file.path !== expected.path || file.bytes !== expected.bytes || file.sha256 !== expected.sha256;
      })
    ) {
      throw new Error("Restored Storage evidence does not match the backup manifest.");
    }
  }

  const embeddedTombstones = manifest.deletionTombstones
    ? (await readAccountDeletionTombstones(
      resolveContainedPath(backupRoot, manifest.deletionTombstones.path),
    )).tombstones
    : [];
  const applied = await applyAccountDeletionTombstones({
    databasePath,
    evidencePath,
    storageEvidencePath,
    tombstones: normalizeTombstones([...embeddedTombstones, ...currentTombstoneDocument.tombstones]),
  });
  if (manifest.version >= 2) {
    const remainingEvidenceFiles = manifest.evidence.files.filter((file) => (
      fs.existsSync(resolveContainedPath(evidencePath, file.path))
    ));
    const filesystemReferences = listFilesystemEvidenceReferences(databasePath);
    const filesystemReferencePaths = new Set(filesystemReferences.map((reference) => reference.objectPath));
    assertDatabaseFilesystemEvidenceReferences(databasePath, {
      ...manifest.evidence,
      files: remainingEvidenceFiles,
      fileCount: remainingEvidenceFiles.length,
      bytes: remainingEvidenceFiles.reduce((total, file) => total + file.bytes, 0),
      databaseReferenceCount: filesystemReferences.length,
      orphanPaths: remainingEvidenceFiles
        .map((file) => file.path)
        .filter((filePath) => !filesystemReferencePaths.has(filePath)),
    });
  }
  if (manifest.storageEvidence) {
    assertDatabaseStorageEvidenceReferences(databasePath, {
      ...manifest.storageEvidence,
      files: manifest.storageEvidence.files.filter((file) => {
        const restoredFile = storageEvidencePath
          ? resolveContainedPath(storageEvidencePath, file.path)
          : null;
        return Boolean(restoredFile && fs.existsSync(restoredFile));
      }),
      fileCount: manifest.storageEvidence.files.filter((file) => {
        const restoredFile = storageEvidencePath
          ? resolveContainedPath(storageEvidencePath, file.path)
          : null;
        return Boolean(restoredFile && fs.existsSync(restoredFile));
      }).length,
      bytes: manifest.storageEvidence.files.reduce((total, file) => {
        const restoredFile = storageEvidencePath
          ? resolveContainedPath(storageEvidencePath, file.path)
          : null;
        return restoredFile && fs.existsSync(restoredFile) ? total + file.bytes : total;
      }, 0),
      orphanPaths: manifest.storageEvidence.orphanPaths.filter((filePath) => {
        const restoredFile = storageEvidencePath
          ? resolveContainedPath(storageEvidencePath, filePath)
          : null;
        return Boolean(restoredFile && fs.existsSync(restoredFile));
      }),
      databaseReferenceCount: listSupabaseEvidenceReferences(databasePath).length,
    });
  }
  assertSqliteIntegrity(databasePath);

  return {
    manifest,
    restoreRoot,
    databasePath,
    evidencePath,
    storageEvidencePath,
    ...applied,
    authority: {
      sourceManifestSha256,
      sourceDatabaseSha256: manifest.database.sha256,
      deletionLedgerSha256: actualTombstoneSha256,
      deletionLedgerGenesisSha256: deletionAuthority.genesisSha256,
      deletionLedgerCheckpointSha256: deletionAuthority.checkpointSha256,
    },
  };
}
