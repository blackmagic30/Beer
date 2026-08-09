import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Client, type ClientConfig, type QueryResultRow } from "pg";

import { sqlDatabaseInternals } from "../db/sql-database.js";
import {
  POSTGRES_LOGICAL_BACKUP_ARCHIVE,
  POSTGRES_LOGICAL_BACKUP_MANIFEST,
  POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  canonicalPostgresBackupJson,
  type PostgresLogicalBackupManifest,
} from "./postgres-logical-backup.js";
import {
  assertPostgresLogicalBackupStateReceiptBinding,
  parsePostgresLogicalBackupManifest,
} from "./postgres-logical-restore.js";
import {
  canonicalPostgresLogicalStateJson,
  computePostgresLogicalStateInventory,
  exactPostgresLogicalStateMatch,
  parsePostgresLogicalSourceStateReceipt,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalSourceStateReceipt,
  type PostgresLogicalStateConnection,
  type PostgresLogicalStateInventory,
} from "./postgres-logical-state.js";
import { postgresAccountDeletionReplayInternals } from "./postgres-account-deletion-replay.js";
import { postgresLogicalOffsiteInternals } from "./postgres-logical-offsite.js";
import { createServerSupabaseClient } from "./supabase-client.js";

export const POSTGRES_PRIVATE_STORAGE_RECOVERY_KIND =
  "pintpath-postgres-private-storage-recovery-set" as const;
export const POSTGRES_PRIVATE_STORAGE_RECOVERY_VERSION = 1 as const;
export const POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST =
  "recovery-set.json" as const;
export const POSTGRES_PRIVATE_STORAGE_RECOVERY_OBJECTS =
  "private-storage" as const;
export const POSTGRES_PRIVATE_STORAGE_RECOVERY_DELETION_AUTHORITY =
  "deletion-authority" as const;
export const POSTGRES_PRIVATE_STORAGE_BUCKET =
  "beermap-source-evidence" as const;
export const POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_ENV =
  "PINTPATH_POSTGRES_PRIVATE_STORAGE_RESTORE" as const;
export const POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_VALUE =
  "confirmed" as const;

const AUTHORITY_CURRENT_FILE = "current.json" as const;
const AUTHORITY_GENESIS_FILE = "genesis.json" as const;
const AUTHORITY_CHECKPOINT_FILE = "checkpoint.json" as const;
const AUTHORITY_FILES = Object.freeze([
  AUTHORITY_CHECKPOINT_FILE,
  AUTHORITY_CURRENT_FILE,
  AUTHORITY_GENESIS_FILE,
]);
const ROOT_ENTRIES = Object.freeze([
  POSTGRES_PRIVATE_STORAGE_RECOVERY_DELETION_AUTHORITY,
  POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST,
  POSTGRES_PRIVATE_STORAGE_RECOVERY_OBJECTS,
]);
const BACKUP_ENTRIES = Object.freeze(
  [
    POSTGRES_LOGICAL_BACKUP_MANIFEST,
    POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  ].sort(compareUtf8),
);
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_OBJECT_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_LOGICAL_MANIFEST_BYTES = 256 * 1024;
const MAX_RECOVERY_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_STATE_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024 * 1024;
const MAX_AUTHORITY_CURRENT_BYTES = 64 * 1024 * 1024;
const MAX_AUTHORITY_CONTROL_BYTES = 1024 * 1024;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_OBJECT_COUNT = 10_000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export type PostgresPrivateStorageRecoveryFailureCode =
  | "invalid_arguments"
  | "unsafe_backup_directory"
  | "backup_invalid"
  | "backup_tampered"
  | "unsafe_deletion_authority"
  | "deletion_authority_invalid"
  | "source_database_mismatch"
  | "source_bucket_invalid"
  | "source_storage_unreachable"
  | "source_storage_changed"
  | "reference_reconciliation_failed"
  | "unsafe_output_path"
  | "output_failed"
  | "recovery_set_invalid"
  | "recovery_set_tampered"
  | "target_database_mismatch"
  | "destination_not_distinct"
  | "destination_bucket_invalid"
  | "destination_not_empty"
  | "destination_upload_failed_disposal_required"
  | "destination_verification_failed_disposal_required";

export class PostgresPrivateStorageRecoveryError extends Error {
  constructor(readonly code: PostgresPrivateStorageRecoveryFailureCode) {
    super(code);
    this.name = "PostgresPrivateStorageRecoveryError";
  }
}

export interface PostgresPrivateStorageReference {
  readonly objectPath: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface PostgresPrivateStorageDatabaseSnapshot {
  readonly connectionUrlSha256: string;
  readonly databaseIdentitySha256: string;
  readonly targetClass: "disposable-rehearsal" | null;
  readonly state: PostgresLogicalStateInventory;
  readonly references: readonly PostgresPrivateStorageReference[];
}

export type PostgresPrivateStorageDatabaseInspector =
  () => Promise<PostgresPrivateStorageDatabaseSnapshot>;

export interface PostgresPrivateStorageBucketInfo {
  readonly private: boolean;
  readonly fileSizeLimit: number | null;
  readonly allowedMimeTypes: readonly string[] | null;
}

export interface PostgresPrivateStorageObjectInfo {
  readonly objectPath: string;
  readonly bytes: number;
  readonly contentType: string;
  readonly storageObjectId: string;
  readonly storageVersion: string;
}

export interface PostgresPrivateStorageDownloadedObject {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly storageObjectId: string;
  readonly storageVersion: string;
}

export interface PostgresPrivateStorageBoundary {
  readonly origin: string;
  readonly bucketName: string;
  inspectBucket(): Promise<PostgresPrivateStorageBucketInfo>;
  listObjects(): Promise<readonly PostgresPrivateStorageObjectInfo[]>;
  downloadObject(
    objectPath: string,
  ): Promise<PostgresPrivateStorageDownloadedObject>;
  uploadImmutable(input: {
    readonly objectPath: string;
    readonly bytes: Buffer;
    readonly contentType: string;
  }): Promise<void>;
}

export interface PostgresPrivateStorageRecoveryObject {
  readonly objectPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly sourceStorageObjectIdSha256: string;
  readonly sourceStorageVersionSha256: string;
  readonly referencedByDatabase: boolean;
}

export interface PostgresPrivateStorageRecoveryManifest {
  readonly kind: typeof POSTGRES_PRIVATE_STORAGE_RECOVERY_KIND;
  readonly version: typeof POSTGRES_PRIVATE_STORAGE_RECOVERY_VERSION;
  readonly capturedAt: string;
  readonly logicalBackup: {
    readonly manifestSha256: string;
    readonly archiveSha256: string;
    readonly stateReceiptSha256: string;
    readonly sourceDatabaseIdentitySha256: string;
    readonly sourceUrlSha256: string;
    readonly overallStateSha256: string;
    readonly sourceEvidenceTableSha256: string;
  };
  readonly sourceStorage: {
    readonly originSha256: string;
    readonly bucketNameSha256: string;
    readonly objectCount: number;
    readonly databaseReferenceCount: number;
    readonly orphanObjectCount: number;
    readonly totalBytes: string;
    readonly sourceInventorySha256: string;
    readonly objectSetSha256: string;
    readonly objects: readonly PostgresPrivateStorageRecoveryObject[];
  };
  readonly deletionAuthority: {
    readonly currentSha256: string;
    readonly genesisSha256: string;
    readonly checkpointSha256: string;
    readonly immutableSetSha256: string;
    readonly tombstoneCount: number;
    readonly latestCompletedAt: string | null;
    readonly authoritySetSha256: string;
  };
  readonly recoverySetSha256: string;
}

export interface CapturePostgresPrivateStorageRecoveryOptions {
  readonly backupDirectory: string;
  readonly expectedBackupManifestSha256: string;
  readonly deletionAuthorityDirectory: string;
  readonly expectedLedgerCurrentSha256: string;
  readonly expectedLedgerGenesisSha256: string;
  readonly expectedLedgerCheckpointSha256: string;
  readonly expectedLedgerImmutableSetSha256: string;
  readonly expectedTombstoneCount: number;
  readonly sourceSupabaseUrl: string;
  readonly expectedSourceOriginSha256: string;
  readonly bucketName: typeof POSTGRES_PRIVATE_STORAGE_BUCKET;
  readonly expectedBucketNameSha256: string;
  readonly outputDirectory: string;
  readonly inspectSourceDatabase: PostgresPrivateStorageDatabaseInspector;
  readonly sourceStorage: PostgresPrivateStorageBoundary;
  readonly now?: (() => Date) | undefined;
  readonly getUid?: (() => number | null) | undefined;
}

export interface CapturePostgresPrivateStorageRecoveryResult {
  readonly schemaVersion: 1;
  readonly kind: "pintpath-postgres-private-storage-recovery-capture";
  readonly ok: true;
  readonly capturedAt: string;
  readonly logicalBackupManifestSha256: string;
  readonly storageObjectCount: number;
  readonly databaseReferenceCount: number;
  readonly deletionTombstoneCount: number;
  readonly recoverySetSha256: string;
  readonly recoveryManifestSha256: string;
}

export interface RestorePostgresPrivateStorageRecoveryOptions {
  readonly backupDirectory: string;
  readonly expectedBackupManifestSha256: string;
  readonly recoverySetDirectory: string;
  readonly expectedRecoverySetSha256: string;
  readonly expectedRecoveryManifestSha256: string;
  readonly expectedTargetDatabaseIdentitySha256: string;
  readonly expectedTargetConnectionUrlSha256: string;
  readonly destinationSupabaseUrl: string;
  readonly expectedDestinationOriginSha256: string;
  readonly forbiddenDestinationOriginSha256s: readonly string[];
  readonly bucketName: typeof POSTGRES_PRIVATE_STORAGE_BUCKET;
  readonly expectedBucketNameSha256: string;
  readonly inspectTargetDatabase: PostgresPrivateStorageDatabaseInspector;
  readonly destinationStorage: PostgresPrivateStorageBoundary;
  readonly now?: (() => Date) | undefined;
  readonly getUid?: (() => number | null) | undefined;
}

export interface RestorePostgresPrivateStorageRecoveryResult {
  readonly schemaVersion: 1;
  readonly kind: "pintpath-postgres-private-storage-recovery-restore";
  readonly ok: true;
  readonly restoredAt: string;
  readonly targetDatabaseIdentitySha256: string;
  readonly recoverySetSha256: string;
  readonly recoveryManifestSha256: string;
  readonly restoredObjectCount: number;
  readonly restoredBytes: string;
  readonly destinationObjectSetSha256: string;
  readonly deletionAuthoritySetSha256: string;
}

interface TrustedFile {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly sha256: string;
  readonly bytes: Buffer | null;
}

interface TrustedDirectory {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ValidatedLogicalBackup {
  readonly directory: TrustedDirectory;
  readonly manifestFile: TrustedFile & { readonly bytes: Buffer };
  readonly archiveFile: TrustedFile;
  readonly stateReceiptFile: TrustedFile & { readonly bytes: Buffer };
  readonly manifest: PostgresLogicalBackupManifest;
  readonly stateReceipt: PostgresLogicalSourceStateReceipt;
}

interface ValidatedDeletionAuthority {
  readonly directory: TrustedDirectory;
  readonly current: TrustedFile & { readonly bytes: Buffer };
  readonly genesis: TrustedFile & { readonly bytes: Buffer };
  readonly checkpoint: TrustedFile & { readonly bytes: Buffer };
  readonly immutableSetSha256: string;
  readonly tombstoneCount: number;
  readonly latestCompletedAt: string | null;
  readonly authoritySetSha256: string;
}

interface ValidatedRecoverySet {
  readonly directory: TrustedDirectory;
  readonly manifestFile: TrustedFile & { readonly bytes: Buffer };
  readonly manifest: PostgresPrivateStorageRecoveryManifest;
  readonly objectDirectory: TrustedDirectory;
  readonly objectPrefixDirectories: readonly TrustedDirectory[];
  readonly objectFiles: readonly TrustedFile[];
  readonly authority: ValidatedDeletionAuthority;
}

interface SourceIdentityRow extends QueryResultRow {
  readonly systemIdentifier: string;
  readonly databaseOid: string;
  readonly databaseName: string;
  readonly serverVersionNum: string;
  readonly roleName: string;
  readonly canLogin: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly canSetMigrator: boolean;
  readonly transactionReadOnly: boolean;
  readonly inRecovery: boolean;
  readonly databaseIsTemplate: boolean;
  readonly databaseAllowsConnections: boolean;
  readonly targetClass: string | null;
}

interface EffectiveRoleRow extends QueryResultRow {
  readonly effectiveRole: string;
  readonly sessionRole: string;
  readonly transactionIsolation: string;
  readonly transactionReadOnly: boolean;
  readonly canLogin: boolean;
  readonly inheritsPrivileges: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
}

interface ReferenceRow extends QueryResultRow {
  readonly objectPath: string;
  readonly mimeType: string;
  readonly byteSize: string;
}

function recoveryError(
  code: PostgresPrivateStorageRecoveryFailureCode,
): PostgresPrivateStorageRecoveryError {
  return new PostgresPrivateStorageRecoveryError(code);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalPostgresBackupJson(value));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw recoveryError("invalid_arguments");
  return value;
}

function canonicalTimestamp(value: Date): string {
  const timestamp = value.toISOString();
  if (!CANONICAL_TIMESTAMP.test(timestamp))
    throw recoveryError("invalid_arguments");
  return timestamp;
}

function validCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value))
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw recoveryError("invalid_arguments");
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw recoveryError("invalid_arguments");
  return url.origin;
}

function exactAbsolutePath(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw recoveryError("invalid_arguments");
  }
  return value;
}

function exactUid(getUid: (() => number | null) | undefined): number {
  const uid = (getUid ?? (() => process.getuid?.() ?? null))();
  if (uid === null || !Number.isInteger(uid) || uid < 0) {
    throw recoveryError("invalid_arguments");
  }
  return uid;
}

function normalizeContentType(value: string): string {
  const normalized = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(normalized)) {
    throw recoveryError("reference_reconciliation_failed");
  }
  return normalized;
}

function safeObjectPath(value: string): string {
  if (
    !SAFE_OBJECT_PATH_PATTERN.test(value) ||
    value.includes("\\") ||
    value.includes("//") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  )
    throw recoveryError("reference_reconciliation_failed");
  return value;
}

function safeStorageToken(
  value: string,
  failureCode: PostgresPrivateStorageRecoveryFailureCode = "source_storage_changed",
): string {
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw recoveryError(failureCode);
  }
  return value;
}

function sameFileIdentity(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function trustedPrivateFile(input: {
  readonly filePath: string;
  readonly uid: number;
  readonly maximumBytes: number;
  readonly retainBytes: boolean;
  readonly invalidCode: PostgresPrivateStorageRecoveryFailureCode;
}): Promise<TrustedFile> {
  const filePath = exactAbsolutePath(input.filePath);
  let handle: fs.promises.FileHandle | null = null;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(input.uid) ||
      Number(before.mode & 0o7777n) !== 0o600 ||
      before.size < 1n ||
      before.size > BigInt(input.maximumBytes) ||
      fs.realpathSync(filePath) !== filePath
    )
      throw new Error("unsafe");
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, opened)) throw new Error("changed");
    const hash = crypto.createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(opened.size)) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, Number(opened.size) - offset),
        offset,
      );
      if (read.bytesRead === 0) throw new Error("short");
      const chunk = Buffer.from(buffer.subarray(0, read.bytesRead));
      hash.update(chunk);
      if (input.retainBytes) chunks.push(chunk);
      offset += read.bytesRead;
    }
    const afterDescriptor = await handle.stat({ bigint: true });
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    if (
      !sameFileIdentity(before, afterDescriptor) ||
      !sameFileIdentity(before, afterPath)
    ) {
      throw new Error("changed");
    }
    return {
      path: filePath,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
      sha256: hash.digest("hex"),
      bytes: input.retainBytes
        ? Buffer.concat(chunks, Number(before.size))
        : null,
    };
  } catch (error) {
    if (error instanceof PostgresPrivateStorageRecoveryError) throw error;
    throw recoveryError(input.invalidCode);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function trustedPrivateDirectory(input: {
  readonly directoryPath: string;
  readonly uid: number;
  readonly exactEntries?: readonly string[] | undefined;
  readonly invalidCode: PostgresPrivateStorageRecoveryFailureCode;
}): TrustedDirectory {
  const directoryPath = exactAbsolutePath(input.directoryPath);
  try {
    const stat = fs.lstatSync(directoryPath, { bigint: true });
    const entries = fs.readdirSync(directoryPath).sort(compareUtf8);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== BigInt(input.uid) ||
      Number(stat.mode & 0o7777n) !== 0o700 ||
      fs.realpathSync(directoryPath) !== directoryPath ||
      (input.exactEntries &&
        JSON.stringify(entries) !==
          JSON.stringify([...input.exactEntries].sort(compareUtf8)))
    )
      throw new Error("unsafe");
    return { path: directoryPath, dev: stat.dev, ino: stat.ino };
  } catch {
    throw recoveryError(input.invalidCode);
  }
}

function assertDirectoryUnchanged(
  directory: TrustedDirectory,
  uid: number,
  exactEntries: readonly string[],
  code: PostgresPrivateStorageRecoveryFailureCode,
): void {
  try {
    const stat = fs.lstatSync(directory.path, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== BigInt(uid) ||
      Number(stat.mode & 0o7777n) !== 0o700 ||
      stat.dev !== directory.dev ||
      stat.ino !== directory.ino ||
      JSON.stringify(fs.readdirSync(directory.path).sort(compareUtf8)) !==
        JSON.stringify([...exactEntries].sort(compareUtf8))
    )
      throw new Error("changed");
  } catch {
    throw recoveryError(code);
  }
}

async function assertFileUnchanged(
  file: TrustedFile,
  uid: number,
  maximumBytes: number,
  code: PostgresPrivateStorageRecoveryFailureCode,
): Promise<void> {
  const current = await trustedPrivateFile({
    filePath: file.path,
    uid,
    maximumBytes,
    retainBytes: false,
    invalidCode: code,
  });
  if (
    current.dev !== file.dev ||
    current.ino !== file.ino ||
    current.size !== file.size ||
    current.mtimeNs !== file.mtimeNs ||
    current.ctimeNs !== file.ctimeNs ||
    current.sha256 !== file.sha256
  )
    throw recoveryError(code);
}

function retained(file: TrustedFile): TrustedFile & { readonly bytes: Buffer } {
  if (!file.bytes) throw recoveryError("output_failed");
  return file as TrustedFile & { readonly bytes: Buffer };
}

async function validateLogicalBackup(
  directoryPath: string,
  expectedManifestSha256: string,
  uid: number,
): Promise<ValidatedLogicalBackup> {
  const expected = exactSha256(expectedManifestSha256);
  const directory = trustedPrivateDirectory({
    directoryPath,
    uid,
    exactEntries: BACKUP_ENTRIES,
    invalidCode: "unsafe_backup_directory",
  });
  const [manifestRaw, archiveFile, stateReceiptRaw] = await Promise.all([
    trustedPrivateFile({
      filePath: path.join(directory.path, POSTGRES_LOGICAL_BACKUP_MANIFEST),
      uid,
      maximumBytes: MAX_LOGICAL_MANIFEST_BYTES,
      retainBytes: true,
      invalidCode: "backup_invalid",
    }),
    trustedPrivateFile({
      filePath: path.join(directory.path, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
      uid,
      maximumBytes: MAX_ARCHIVE_BYTES,
      retainBytes: false,
      invalidCode: "backup_tampered",
    }),
    trustedPrivateFile({
      filePath: path.join(
        directory.path,
        POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      ),
      uid,
      maximumBytes: MAX_STATE_RECEIPT_BYTES,
      retainBytes: true,
      invalidCode: "backup_invalid",
    }),
  ]);
  const manifestFile = retained(manifestRaw);
  const stateReceiptFile = retained(stateReceiptRaw);
  if (manifestFile.sha256 !== expected) throw recoveryError("backup_tampered");
  let manifest: PostgresLogicalBackupManifest;
  let stateReceipt: PostgresLogicalSourceStateReceipt;
  try {
    manifest = parsePostgresLogicalBackupManifest(manifestFile.bytes);
    stateReceipt = parsePostgresLogicalSourceStateReceipt(
      stateReceiptFile.bytes,
    );
    assertPostgresLogicalBackupStateReceiptBinding(stateReceipt, manifest);
  } catch {
    throw recoveryError("backup_invalid");
  }
  if (
    manifest.schemaVersion !== 2 ||
    manifest.state.receiptSha256 !== stateReceiptFile.sha256 ||
    manifest.archive.sha256 !== archiveFile.sha256 ||
    manifest.archive.bytes !== Number(archiveFile.size)
  )
    throw recoveryError("backup_tampered");
  return {
    directory,
    manifestFile,
    archiveFile,
    stateReceiptFile,
    manifest,
    stateReceipt,
  };
}

function sourceEvidenceTableSha256(
  state: PostgresLogicalStateInventory,
): string {
  const table = state.tables.find(
    (candidate) => candidate.tableName === "source_evidence_objects",
  );
  if (!table || !SHA256_PATTERN.test(table.transformedSha256)) {
    throw recoveryError("backup_invalid");
  }
  return table.transformedSha256;
}

function parseAuthority(input: {
  readonly current: TrustedFile & { readonly bytes: Buffer };
  readonly genesis: TrustedFile & { readonly bytes: Buffer };
  readonly checkpoint: TrustedFile & { readonly bytes: Buffer };
  readonly expectedCurrentSha256: string;
  readonly expectedGenesisSha256: string;
  readonly expectedCheckpointSha256: string;
  readonly expectedImmutableSetSha256: string;
  readonly expectedTombstoneCount: number;
}): Omit<
  ValidatedDeletionAuthority,
  "directory" | "current" | "genesis" | "checkpoint"
> {
  if (
    input.current.sha256 !== exactSha256(input.expectedCurrentSha256) ||
    input.genesis.sha256 !== exactSha256(input.expectedGenesisSha256) ||
    input.checkpoint.sha256 !== exactSha256(input.expectedCheckpointSha256) ||
    !Number.isSafeInteger(input.expectedTombstoneCount) ||
    input.expectedTombstoneCount < 0
  )
    throw recoveryError("deletion_authority_invalid");
  let tombstones: ReturnType<
    typeof postgresAccountDeletionReplayInternals.parseCanonicalTombstones
  >;
  let genesis: ReturnType<
    typeof postgresAccountDeletionReplayInternals.parseCanonicalGenesis
  >;
  let checkpoint: ReturnType<
    typeof postgresAccountDeletionReplayInternals.parseCanonicalCheckpoint
  >;
  try {
    tombstones =
      postgresAccountDeletionReplayInternals.parseCanonicalTombstones(
        input.current.bytes,
      );
    genesis = postgresAccountDeletionReplayInternals.parseCanonicalGenesis(
      input.genesis.bytes,
    );
    checkpoint =
      postgresAccountDeletionReplayInternals.parseCanonicalCheckpoint(
        input.checkpoint.bytes,
      );
  } catch {
    throw recoveryError("deletion_authority_invalid");
  }
  const latestCompletedAt = tombstones.reduce<string | null>(
    (latest, tombstone) =>
      latest === null || tombstone.completedAt > latest
        ? tombstone.completedAt
        : latest,
    null,
  );
  let currentDocument: { readonly generatedAt?: unknown };
  try {
    currentDocument = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.current.bytes),
    ) as { readonly generatedAt?: unknown };
  } catch {
    throw recoveryError("deletion_authority_invalid");
  }
  const expectedGeneratedAt = new Date(
    Math.max(
      Date.parse(genesis.createdAt),
      latestCompletedAt === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(latestCompletedAt),
    ),
  ).toISOString();
  const immutableSetSha256 = exactSha256(input.expectedImmutableSetSha256);
  if (
    checkpoint.currentLedgerSha256 !== input.current.sha256 ||
    checkpoint.genesisSha256 !== input.genesis.sha256 ||
    currentDocument.generatedAt !== checkpoint.generatedAt ||
    checkpoint.generatedAt !== expectedGeneratedAt ||
    checkpoint.immutableSetSha256 !== immutableSetSha256 ||
    checkpoint.immutableObjectCount < tombstones.length ||
    checkpoint.tombstoneCount !== input.expectedTombstoneCount ||
    tombstones.length !== input.expectedTombstoneCount ||
    checkpoint.latestCompletedAt !== latestCompletedAt
  )
    throw recoveryError("deletion_authority_invalid");
  return {
    immutableSetSha256,
    tombstoneCount: tombstones.length,
    latestCompletedAt,
    authoritySetSha256: canonicalSha256({
      kind: "pintpath-postgres-private-storage-deletion-authority-set",
      version: 1,
      currentSha256: input.current.sha256,
      genesisSha256: input.genesis.sha256,
      checkpointSha256: input.checkpoint.sha256,
      immutableSetSha256,
      tombstoneCount: tombstones.length,
      latestCompletedAt,
    }),
  };
}

async function validateDeletionAuthority(input: {
  readonly directoryPath: string;
  readonly uid: number;
  readonly expectedCurrentSha256: string;
  readonly expectedGenesisSha256: string;
  readonly expectedCheckpointSha256: string;
  readonly expectedImmutableSetSha256: string;
  readonly expectedTombstoneCount: number;
}): Promise<ValidatedDeletionAuthority> {
  const directory = trustedPrivateDirectory({
    directoryPath: input.directoryPath,
    uid: input.uid,
    exactEntries: AUTHORITY_FILES,
    invalidCode: "unsafe_deletion_authority",
  });
  const [currentRaw, genesisRaw, checkpointRaw] = await Promise.all([
    trustedPrivateFile({
      filePath: path.join(directory.path, AUTHORITY_CURRENT_FILE),
      uid: input.uid,
      maximumBytes: MAX_AUTHORITY_CURRENT_BYTES,
      retainBytes: true,
      invalidCode: "unsafe_deletion_authority",
    }),
    trustedPrivateFile({
      filePath: path.join(directory.path, AUTHORITY_GENESIS_FILE),
      uid: input.uid,
      maximumBytes: MAX_AUTHORITY_CONTROL_BYTES,
      retainBytes: true,
      invalidCode: "unsafe_deletion_authority",
    }),
    trustedPrivateFile({
      filePath: path.join(directory.path, AUTHORITY_CHECKPOINT_FILE),
      uid: input.uid,
      maximumBytes: MAX_AUTHORITY_CONTROL_BYTES,
      retainBytes: true,
      invalidCode: "unsafe_deletion_authority",
    }),
  ]);
  const current = retained(currentRaw);
  const genesis = retained(genesisRaw);
  const checkpoint = retained(checkpointRaw);
  return {
    directory,
    current,
    genesis,
    checkpoint,
    ...parseAuthority({
      current,
      genesis,
      checkpoint,
      expectedCurrentSha256: input.expectedCurrentSha256,
      expectedGenesisSha256: input.expectedGenesisSha256,
      expectedCheckpointSha256: input.expectedCheckpointSha256,
      expectedImmutableSetSha256: input.expectedImmutableSetSha256,
      expectedTombstoneCount: input.expectedTombstoneCount,
    }),
  };
}

async function assertLogicalBackupUnchanged(
  backup: ValidatedLogicalBackup,
  uid: number,
): Promise<void> {
  assertDirectoryUnchanged(
    backup.directory,
    uid,
    BACKUP_ENTRIES,
    "backup_tampered",
  );
  await Promise.all([
    assertFileUnchanged(
      backup.manifestFile,
      uid,
      MAX_LOGICAL_MANIFEST_BYTES,
      "backup_tampered",
    ),
    assertFileUnchanged(
      backup.archiveFile,
      uid,
      MAX_ARCHIVE_BYTES,
      "backup_tampered",
    ),
    assertFileUnchanged(
      backup.stateReceiptFile,
      uid,
      MAX_STATE_RECEIPT_BYTES,
      "backup_tampered",
    ),
  ]);
}

async function assertAuthorityUnchanged(
  authority: ValidatedDeletionAuthority,
  uid: number,
): Promise<void> {
  assertDirectoryUnchanged(
    authority.directory,
    uid,
    AUTHORITY_FILES,
    "deletion_authority_invalid",
  );
  await Promise.all([
    assertFileUnchanged(
      authority.current,
      uid,
      MAX_AUTHORITY_CURRENT_BYTES,
      "deletion_authority_invalid",
    ),
    assertFileUnchanged(
      authority.genesis,
      uid,
      MAX_AUTHORITY_CONTROL_BYTES,
      "deletion_authority_invalid",
    ),
    assertFileUnchanged(
      authority.checkpoint,
      uid,
      MAX_AUTHORITY_CONTROL_BYTES,
      "deletion_authority_invalid",
    ),
  ]);
}

function normalizeReferences(
  references: readonly PostgresPrivateStorageReference[],
): readonly PostgresPrivateStorageReference[] {
  if (references.length > MAX_OBJECT_COUNT)
    throw recoveryError("reference_reconciliation_failed");
  const normalized = references
    .map((reference) => {
      const objectPath = safeObjectPath(reference.objectPath);
      const mimeType = normalizeContentType(reference.mimeType);
      if (
        reference.mimeType !== mimeType ||
        !Number.isSafeInteger(reference.byteSize) ||
        reference.byteSize < 1 ||
        reference.byteSize > MAX_OBJECT_BYTES
      ) {
        throw recoveryError("reference_reconciliation_failed");
      }
      return { objectPath, mimeType, byteSize: reference.byteSize };
    })
    .sort((left, right) => compareUtf8(left.objectPath, right.objectPath));
  if (
    normalized.some(
      (value, index) => value.objectPath === normalized[index - 1]?.objectPath,
    )
  ) {
    throw recoveryError("reference_reconciliation_failed");
  }
  return Object.freeze(normalized);
}

function normalizeStorageInventory(
  objects: readonly PostgresPrivateStorageObjectInfo[],
  failureCode:
    | "source_storage_changed"
    | "destination_bucket_invalid"
    | "destination_verification_failed_disposal_required" = "source_storage_changed",
): readonly PostgresPrivateStorageObjectInfo[] {
  if (objects.length > MAX_OBJECT_COUNT) throw recoveryError(failureCode);
  let totalBytes = 0;
  const normalized = objects
    .map((object) => {
      let objectPath: string;
      let contentType: string;
      try {
        objectPath = safeObjectPath(object.objectPath);
        contentType = normalizeContentType(object.contentType);
      } catch {
        throw recoveryError(failureCode);
      }
      if (
        !Number.isSafeInteger(object.bytes) ||
        object.bytes < 1 ||
        object.bytes > MAX_OBJECT_BYTES
      ) {
        throw recoveryError(failureCode);
      }
      if (object.contentType !== contentType) throw recoveryError(failureCode);
      totalBytes += object.bytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
        throw recoveryError(failureCode);
      }
      return {
        objectPath,
        bytes: object.bytes,
        contentType,
        storageObjectId: safeStorageToken(object.storageObjectId, failureCode),
        storageVersion: safeStorageToken(object.storageVersion, failureCode),
      };
    })
    .sort((left, right) => compareUtf8(left.objectPath, right.objectPath));
  if (
    normalized.some(
      (value, index) => value.objectPath === normalized[index - 1]?.objectPath,
    )
  ) {
    throw recoveryError(failureCode);
  }
  return Object.freeze(normalized);
}

function storageInventorySha256(
  objects: readonly PostgresPrivateStorageObjectInfo[],
): string {
  return canonicalSha256(
    objects.map((object) => ({
      objectPath: object.objectPath,
      bytes: object.bytes,
      contentType: object.contentType,
      storageObjectIdSha256: sha256(object.storageObjectId),
      storageVersionSha256: sha256(object.storageVersion),
    })),
  );
}

function recoveryObjectInventorySha256(
  objects: readonly PostgresPrivateStorageRecoveryObject[],
): string {
  return canonicalSha256(
    objects.map((object) => ({
      objectPath: object.objectPath,
      bytes: object.bytes,
      contentType: object.contentType,
      storageObjectIdSha256: object.sourceStorageObjectIdSha256,
      storageVersionSha256: object.sourceStorageVersionSha256,
    })),
  );
}

function sameStorageInventory(
  left: readonly PostgresPrivateStorageObjectInfo[],
  right: readonly PostgresPrivateStorageObjectInfo[],
): boolean {
  return (
    canonicalPostgresBackupJson(left) === canonicalPostgresBackupJson(right)
  );
}

function sameReferences(
  left: readonly PostgresPrivateStorageReference[],
  right: readonly PostgresPrivateStorageReference[],
): boolean {
  return (
    canonicalPostgresBackupJson(left) === canonicalPostgresBackupJson(right)
  );
}

function reconcileReferences(input: {
  readonly references: readonly PostgresPrivateStorageReference[];
  readonly inventory: readonly PostgresPrivateStorageObjectInfo[];
}): ReadonlySet<string> {
  const inventory = new Map(
    input.inventory.map((object) => [object.objectPath, object]),
  );
  const referenced = new Set<string>();
  for (const reference of input.references) {
    const object = inventory.get(reference.objectPath);
    if (
      !object ||
      object.bytes !== reference.byteSize ||
      object.contentType !== reference.mimeType
    )
      throw recoveryError("reference_reconciliation_failed");
    referenced.add(reference.objectPath);
  }
  return referenced;
}

function validateDatabaseSnapshot(input: {
  readonly snapshot: PostgresPrivateStorageDatabaseSnapshot;
  readonly backup: ValidatedLogicalBackup;
  readonly expectedIdentitySha256: string;
  readonly expectedConnectionUrlSha256: string;
  readonly requireDisposable: boolean;
}): readonly PostgresPrivateStorageReference[] {
  if (
    input.snapshot.connectionUrlSha256 !==
      exactSha256(input.expectedConnectionUrlSha256) ||
    input.snapshot.databaseIdentitySha256 !==
      exactSha256(input.expectedIdentitySha256) ||
    !exactPostgresLogicalStateMatch(
      input.backup.stateReceipt.state,
      input.snapshot.state,
    ) ||
    (input.requireDisposable &&
      input.snapshot.targetClass !== "disposable-rehearsal") ||
    (!input.requireDisposable && input.snapshot.targetClass !== null)
  )
    throw recoveryError(
      input.requireDisposable
        ? "target_database_mismatch"
        : "source_database_mismatch",
    );
  return normalizeReferences(input.snapshot.references);
}

function ensureBoundary(input: {
  readonly storage: PostgresPrivateStorageBoundary;
  readonly expectedOrigin: string;
  readonly bucketName: string;
  readonly failureCode: PostgresPrivateStorageRecoveryFailureCode;
}): void {
  let storageOrigin: string;
  try {
    storageOrigin = canonicalOrigin(input.storage.origin);
  } catch {
    throw recoveryError(input.failureCode);
  }
  if (
    storageOrigin !== input.expectedOrigin ||
    input.storage.bucketName !== input.bucketName
  ) {
    throw recoveryError(input.failureCode);
  }
}

async function ensurePrivateBucket(
  storage: PostgresPrivateStorageBoundary,
  failureCode: "source_bucket_invalid" | "destination_bucket_invalid",
): Promise<void> {
  try {
    const bucket = await storage.inspectBucket();
    const allowedMimeTypes =
      bucket.allowedMimeTypes === null
        ? null
        : [...bucket.allowedMimeTypes].sort(compareUtf8);
    const expectedMimeTypes = [...ALLOWED_MIME_TYPES].sort(compareUtf8);
    if (
      !bucket.private ||
      bucket.fileSizeLimit !== MAX_OBJECT_BYTES ||
      !allowedMimeTypes ||
      new Set(allowedMimeTypes).size !== allowedMimeTypes.length ||
      canonicalPostgresBackupJson(allowedMimeTypes) !==
        canonicalPostgresBackupJson(expectedMimeTypes)
    )
      throw new Error("unsafe_bucket_policy");
  } catch {
    throw recoveryError(failureCode);
  }
}

function resolveContainedObjectPath(root: string, objectPath: string): string {
  const safe = safeObjectPath(objectPath);
  const resolved = path.resolve(root, ...safe.split("/"));
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw recoveryError("unsafe_output_path");
  }
  return resolved;
}

function recoveryObjectRelativePath(objectPath: string): string {
  const objectPathSha256 = sha256(safeObjectPath(objectPath));
  return `${objectPathSha256.slice(0, 2)}/${objectPathSha256}.object`;
}

async function prepareOutputRoot(
  outputDirectory: string,
  uid: number,
): Promise<TrustedDirectory> {
  const output = exactAbsolutePath(outputDirectory);
  const parent = trustedPrivateDirectory({
    directoryPath: path.dirname(output),
    uid,
    invalidCode: "unsafe_output_path",
  });
  const parentEntriesBefore = fs.readdirSync(parent.path).sort(compareUtf8);
  const outputName = path.basename(output);
  try {
    await fs.promises.mkdir(output, { mode: 0o700 });
    const created = trustedPrivateDirectory({
      directoryPath: output,
      uid,
      exactEntries: [],
      invalidCode: "unsafe_output_path",
    });
    assertDirectoryUnchanged(
      parent,
      uid,
      [...parentEntriesBefore, outputName].sort(compareUtf8),
      "unsafe_output_path",
    );
    return created;
  } catch (error) {
    if (error instanceof PostgresPrivateStorageRecoveryError) throw error;
    throw recoveryError("unsafe_output_path");
  }
}

async function ensureOutputSubdirectory(
  root: TrustedDirectory,
  relative: string,
): Promise<string> {
  const directory = path.join(root.path, relative);
  try {
    await fs.promises.mkdir(directory, { mode: 0o700 });
    const stat = await fs.promises.lstat(directory);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.mode & 0o7777) !== 0o700
    ) {
      throw new Error("unsafe");
    }
    return directory;
  } catch {
    throw recoveryError("output_failed");
  }
}

async function createPrivateFile(
  filePath: string,
  bytes: Buffer,
): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch {
    throw recoveryError("output_failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function createPrivateObjectFile(
  storageRoot: string,
  objectPath: string,
  bytes: Buffer,
): Promise<string> {
  const filePath = resolveContainedObjectPath(storageRoot, objectPath);
  const relativeParent = path.relative(storageRoot, path.dirname(filePath));
  let current = storageRoot;
  for (const segment of relativeParent ? relativeParent.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      await fs.promises.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw recoveryError("output_failed");
    }
    const stat = await fs.promises.lstat(current);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw recoveryError("output_failed");
    }
  }
  await createPrivateFile(filePath, bytes);
  return filePath;
}

function recoverySetBinding(
  manifest: Omit<PostgresPrivateStorageRecoveryManifest, "recoverySetSha256">,
): string {
  return canonicalSha256({
    bindingKind: "pintpath-postgres-private-storage-recovery-set-binding",
    bindingVersion: 1,
    ...manifest,
  });
}

export async function capturePostgresPrivateStorageRecovery(
  options: CapturePostgresPrivateStorageRecoveryOptions,
): Promise<CapturePostgresPrivateStorageRecoveryResult> {
  const uid = exactUid(options.getUid);
  const sourceOrigin = canonicalOrigin(options.sourceSupabaseUrl);
  if (
    sha256(sourceOrigin) !== exactSha256(options.expectedSourceOriginSha256) ||
    options.bucketName !== POSTGRES_PRIVATE_STORAGE_BUCKET ||
    sha256(options.bucketName) !== exactSha256(options.expectedBucketNameSha256)
  )
    throw recoveryError("invalid_arguments");
  ensureBoundary({
    storage: options.sourceStorage,
    expectedOrigin: sourceOrigin,
    bucketName: options.bucketName,
    failureCode: "source_bucket_invalid",
  });
  const backup = await validateLogicalBackup(
    exactAbsolutePath(options.backupDirectory),
    options.expectedBackupManifestSha256,
    uid,
  );
  const authority = await validateDeletionAuthority({
    directoryPath: exactAbsolutePath(options.deletionAuthorityDirectory),
    uid,
    expectedCurrentSha256: options.expectedLedgerCurrentSha256,
    expectedGenesisSha256: options.expectedLedgerGenesisSha256,
    expectedCheckpointSha256: options.expectedLedgerCheckpointSha256,
    expectedImmutableSetSha256: options.expectedLedgerImmutableSetSha256,
    expectedTombstoneCount: options.expectedTombstoneCount,
  });
  await ensurePrivateBucket(options.sourceStorage, "source_bucket_invalid");
  const firstDatabase = await options.inspectSourceDatabase().catch(() => {
    throw recoveryError("source_database_mismatch");
  });
  const firstReferences = validateDatabaseSnapshot({
    snapshot: firstDatabase,
    backup,
    expectedIdentitySha256: backup.stateReceipt.source.databaseIdentitySha256,
    expectedConnectionUrlSha256: backup.stateReceipt.source.urlSha256,
    requireDisposable: false,
  });
  let firstInventory: readonly PostgresPrivateStorageObjectInfo[];
  try {
    firstInventory = normalizeStorageInventory(
      await options.sourceStorage.listObjects(),
    );
  } catch (error) {
    if (error instanceof PostgresPrivateStorageRecoveryError) throw error;
    throw recoveryError("source_storage_unreachable");
  }
  const referencedPaths = reconcileReferences({
    references: firstReferences,
    inventory: firstInventory,
  });
  const output = await prepareOutputRoot(
    exactAbsolutePath(options.outputDirectory),
    uid,
  );
  const storageRoot = await ensureOutputSubdirectory(
    output,
    POSTGRES_PRIVATE_STORAGE_RECOVERY_OBJECTS,
  );
  const authorityRoot = await ensureOutputSubdirectory(
    output,
    POSTGRES_PRIVATE_STORAGE_RECOVERY_DELETION_AUTHORITY,
  );
  const objects: PostgresPrivateStorageRecoveryObject[] = [];
  let totalBytes = 0;
  for (const remote of firstInventory) {
    let downloaded: PostgresPrivateStorageDownloadedObject;
    try {
      downloaded = await options.sourceStorage.downloadObject(
        remote.objectPath,
      );
    } catch (error) {
      if (error instanceof PostgresPrivateStorageRecoveryError) throw error;
      throw recoveryError("source_storage_unreachable");
    }
    const contentType = normalizeContentType(downloaded.contentType);
    if (
      downloaded.bytes.length !== remote.bytes ||
      downloaded.bytes.length < 1 ||
      downloaded.bytes.length > MAX_OBJECT_BYTES ||
      downloaded.contentType !== contentType ||
      contentType !== remote.contentType ||
      safeStorageToken(downloaded.storageObjectId) !== remote.storageObjectId ||
      safeStorageToken(downloaded.storageVersion) !== remote.storageVersion
    )
      throw recoveryError("source_storage_changed");
    totalBytes += downloaded.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES)
      throw recoveryError("source_storage_changed");
    await createPrivateObjectFile(
      storageRoot,
      recoveryObjectRelativePath(remote.objectPath),
      downloaded.bytes,
    );
    objects.push(
      Object.freeze({
        objectPath: remote.objectPath,
        bytes: downloaded.bytes.length,
        sha256: sha256(downloaded.bytes),
        contentType,
        sourceStorageObjectIdSha256: sha256(remote.storageObjectId),
        sourceStorageVersionSha256: sha256(remote.storageVersion),
        referencedByDatabase: referencedPaths.has(remote.objectPath),
      }),
    );
  }
  await Promise.all([
    createPrivateFile(
      path.join(authorityRoot, AUTHORITY_CURRENT_FILE),
      authority.current.bytes,
    ),
    createPrivateFile(
      path.join(authorityRoot, AUTHORITY_GENESIS_FILE),
      authority.genesis.bytes,
    ),
    createPrivateFile(
      path.join(authorityRoot, AUTHORITY_CHECKPOINT_FILE),
      authority.checkpoint.bytes,
    ),
  ]);
  const secondDatabase = await options.inspectSourceDatabase().catch(() => {
    throw recoveryError("source_database_mismatch");
  });
  await ensurePrivateBucket(options.sourceStorage, "source_bucket_invalid");
  const secondReferences = validateDatabaseSnapshot({
    snapshot: secondDatabase,
    backup,
    expectedIdentitySha256: backup.stateReceipt.source.databaseIdentitySha256,
    expectedConnectionUrlSha256: backup.stateReceipt.source.urlSha256,
    requireDisposable: false,
  });
  let secondInventory: readonly PostgresPrivateStorageObjectInfo[];
  try {
    secondInventory = normalizeStorageInventory(
      await options.sourceStorage.listObjects(),
    );
  } catch (error) {
    if (error instanceof PostgresPrivateStorageRecoveryError) throw error;
    throw recoveryError("source_storage_unreachable");
  }
  await ensurePrivateBucket(options.sourceStorage, "source_bucket_invalid");
  if (
    !sameReferences(firstReferences, secondReferences) ||
    !sameStorageInventory(firstInventory, secondInventory)
  )
    throw recoveryError("source_storage_changed");
  await Promise.all([
    assertLogicalBackupUnchanged(backup, uid),
    assertAuthorityUnchanged(authority, uid),
  ]);
  const sourceObjectSetSha256 = canonicalSha256(objects);
  const capturedAt = canonicalTimestamp((options.now ?? (() => new Date()))());
  const withoutBinding: Omit<
    PostgresPrivateStorageRecoveryManifest,
    "recoverySetSha256"
  > = {
    kind: POSTGRES_PRIVATE_STORAGE_RECOVERY_KIND,
    version: POSTGRES_PRIVATE_STORAGE_RECOVERY_VERSION,
    capturedAt,
    logicalBackup: {
      manifestSha256: backup.manifestFile.sha256,
      archiveSha256: backup.archiveFile.sha256,
      stateReceiptSha256: backup.stateReceiptFile.sha256,
      sourceDatabaseIdentitySha256:
        backup.stateReceipt.source.databaseIdentitySha256,
      sourceUrlSha256: backup.stateReceipt.source.urlSha256,
      overallStateSha256: backup.stateReceipt.state.overallStateSha256,
      sourceEvidenceTableSha256: sourceEvidenceTableSha256(
        backup.stateReceipt.state,
      ),
    },
    sourceStorage: {
      originSha256: sha256(sourceOrigin),
      bucketNameSha256: sha256(options.bucketName),
      objectCount: objects.length,
      databaseReferenceCount: firstReferences.length,
      orphanObjectCount: objects.filter(
        (object) => !object.referencedByDatabase,
      ).length,
      totalBytes: String(totalBytes),
      sourceInventorySha256: storageInventorySha256(firstInventory),
      objectSetSha256: sourceObjectSetSha256,
      objects: Object.freeze(objects),
    },
    deletionAuthority: {
      currentSha256: authority.current.sha256,
      genesisSha256: authority.genesis.sha256,
      checkpointSha256: authority.checkpoint.sha256,
      immutableSetSha256: authority.immutableSetSha256,
      tombstoneCount: authority.tombstoneCount,
      latestCompletedAt: authority.latestCompletedAt,
      authoritySetSha256: authority.authoritySetSha256,
    },
  };
  const recoverySetSha256 = recoverySetBinding(withoutBinding);
  const manifest: PostgresPrivateStorageRecoveryManifest = {
    ...withoutBinding,
    recoverySetSha256,
  };
  const manifestBytes = Buffer.from(
    canonicalPostgresBackupJson(manifest),
    "utf8",
  );
  if (manifestBytes.length > MAX_RECOVERY_MANIFEST_BYTES) {
    throw recoveryError("output_failed");
  }
  await createPrivateFile(
    path.join(output.path, POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST),
    manifestBytes,
  );
  assertDirectoryUnchanged(output, uid, ROOT_ENTRIES, "output_failed");
  let validatedOutput: ValidatedRecoverySet;
  try {
    validatedOutput = await validateRecoverySet({
      directoryPath: output.path,
      uid,
      expectedRecoverySetSha256: recoverySetSha256,
      expectedManifestSha256: sha256(manifestBytes),
    });
  } catch {
    throw recoveryError("output_failed");
  }
  if (
    validatedOutput.manifest.recoverySetSha256 !== recoverySetSha256 ||
    validatedOutput.manifestFile.sha256 !== sha256(manifestBytes)
  )
    throw recoveryError("output_failed");
  return Object.freeze({
    schemaVersion: 1,
    kind: "pintpath-postgres-private-storage-recovery-capture",
    ok: true,
    capturedAt,
    logicalBackupManifestSha256: backup.manifestFile.sha256,
    storageObjectCount: objects.length,
    databaseReferenceCount: firstReferences.length,
    deletionTombstoneCount: authority.tombstoneCount,
    recoverySetSha256,
    recoveryManifestSha256: sha256(manifestBytes),
  });
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRecoveryManifest(
  bytes: Buffer,
): PostgresPrivateStorageRecoveryManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw recoveryError("recovery_set_invalid");
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "kind",
      "version",
      "capturedAt",
      "logicalBackup",
      "sourceStorage",
      "deletionAuthority",
      "recoverySetSha256",
    ])
  )
    throw recoveryError("recovery_set_invalid");
  if (
    value.kind !== POSTGRES_PRIVATE_STORAGE_RECOVERY_KIND ||
    value.version !== POSTGRES_PRIVATE_STORAGE_RECOVERY_VERSION ||
    !validCanonicalTimestamp(value.capturedAt) ||
    !isRecord(value.logicalBackup) ||
    !isRecord(value.sourceStorage) ||
    !isRecord(value.deletionAuthority)
  )
    throw recoveryError("recovery_set_invalid");
  const logical = value.logicalBackup;
  const storage = value.sourceStorage;
  const authority = value.deletionAuthority;
  if (
    !exactKeys(logical, [
      "manifestSha256",
      "archiveSha256",
      "stateReceiptSha256",
      "sourceDatabaseIdentitySha256",
      "sourceUrlSha256",
      "overallStateSha256",
      "sourceEvidenceTableSha256",
    ]) ||
    !exactKeys(storage, [
      "originSha256",
      "bucketNameSha256",
      "objectCount",
      "databaseReferenceCount",
      "orphanObjectCount",
      "totalBytes",
      "sourceInventorySha256",
      "objectSetSha256",
      "objects",
    ]) ||
    !exactKeys(authority, [
      "currentSha256",
      "genesisSha256",
      "checkpointSha256",
      "immutableSetSha256",
      "tombstoneCount",
      "latestCompletedAt",
      "authoritySetSha256",
    ])
  )
    throw recoveryError("recovery_set_invalid");
  const logicalHashes = Object.values(logical);
  const storageHashes = [
    storage.originSha256,
    storage.bucketNameSha256,
    storage.sourceInventorySha256,
    storage.objectSetSha256,
  ];
  const authorityHashes = [
    authority.currentSha256,
    authority.genesisSha256,
    authority.checkpointSha256,
    authority.immutableSetSha256,
    authority.authoritySetSha256,
  ];
  if (
    [
      ...logicalHashes,
      ...storageHashes,
      ...authorityHashes,
      value.recoverySetSha256,
    ].some((hash) => typeof hash !== "string" || !SHA256_PATTERN.test(hash)) ||
    !Number.isSafeInteger(storage.objectCount) ||
    Number(storage.objectCount) < 0 ||
    Number(storage.objectCount) > MAX_OBJECT_COUNT ||
    !Number.isSafeInteger(storage.databaseReferenceCount) ||
    Number(storage.databaseReferenceCount) < 0 ||
    !Number.isSafeInteger(storage.orphanObjectCount) ||
    Number(storage.orphanObjectCount) < 0 ||
    typeof storage.totalBytes !== "string" ||
    !/^(?:0|[1-9]\d*)$/.test(storage.totalBytes) ||
    BigInt(storage.totalBytes).toString() !== storage.totalBytes ||
    BigInt(storage.totalBytes) > BigInt(MAX_TOTAL_BYTES) ||
    !Array.isArray(storage.objects) ||
    storage.objects.length !== storage.objectCount ||
    !Number.isSafeInteger(authority.tombstoneCount) ||
    Number(authority.tombstoneCount) < 0 ||
    (authority.latestCompletedAt !== null &&
      (typeof authority.latestCompletedAt !== "string" ||
        !validCanonicalTimestamp(authority.latestCompletedAt)))
  )
    throw recoveryError("recovery_set_invalid");
  const objects: PostgresPrivateStorageRecoveryObject[] = [];
  for (const raw of storage.objects) {
    if (
      !isRecord(raw) ||
      !exactKeys(raw, [
        "objectPath",
        "bytes",
        "sha256",
        "contentType",
        "sourceStorageObjectIdSha256",
        "sourceStorageVersionSha256",
        "referencedByDatabase",
      ])
    )
      throw recoveryError("recovery_set_invalid");
    if (
      typeof raw.objectPath !== "string" ||
      typeof raw.contentType !== "string" ||
      !Number.isSafeInteger(raw.bytes) ||
      Number(raw.bytes) < 1 ||
      Number(raw.bytes) > MAX_OBJECT_BYTES ||
      typeof raw.sha256 !== "string" ||
      !SHA256_PATTERN.test(raw.sha256) ||
      typeof raw.sourceStorageObjectIdSha256 !== "string" ||
      !SHA256_PATTERN.test(raw.sourceStorageObjectIdSha256) ||
      typeof raw.sourceStorageVersionSha256 !== "string" ||
      !SHA256_PATTERN.test(raw.sourceStorageVersionSha256) ||
      typeof raw.referencedByDatabase !== "boolean"
    )
      throw recoveryError("recovery_set_invalid");
    let objectPath: string;
    let contentType: string;
    try {
      objectPath = safeObjectPath(raw.objectPath);
      contentType = normalizeContentType(raw.contentType);
    } catch {
      throw recoveryError("recovery_set_invalid");
    }
    if (raw.contentType !== contentType)
      throw recoveryError("recovery_set_invalid");
    objects.push({
      objectPath,
      bytes: Number(raw.bytes),
      sha256: raw.sha256,
      contentType,
      sourceStorageObjectIdSha256: raw.sourceStorageObjectIdSha256,
      sourceStorageVersionSha256: raw.sourceStorageVersionSha256,
      referencedByDatabase: raw.referencedByDatabase,
    });
  }
  const sorted = [...objects].sort((left, right) =>
    compareUtf8(left.objectPath, right.objectPath),
  );
  if (
    canonicalPostgresBackupJson(objects) !==
      canonicalPostgresBackupJson(sorted) ||
    sorted.some(
      (object, index) => object.objectPath === sorted[index - 1]?.objectPath,
    ) ||
    sorted.reduce((total, object) => total + BigInt(object.bytes), 0n) !==
      BigInt(storage.totalBytes) ||
    sorted.filter((object) => object.referencedByDatabase).length !==
      storage.databaseReferenceCount ||
    sorted.filter((object) => !object.referencedByDatabase).length !==
      storage.orphanObjectCount ||
    canonicalSha256(sorted) !== storage.objectSetSha256 ||
    recoveryObjectInventorySha256(sorted) !== storage.sourceInventorySha256 ||
    storage.bucketNameSha256 !== sha256(POSTGRES_PRIVATE_STORAGE_BUCKET)
  )
    throw recoveryError("recovery_set_invalid");
  const manifest = value as unknown as PostgresPrivateStorageRecoveryManifest;
  const withoutBinding: Omit<
    PostgresPrivateStorageRecoveryManifest,
    "recoverySetSha256"
  > = {
    kind: manifest.kind,
    version: manifest.version,
    capturedAt: manifest.capturedAt,
    logicalBackup: manifest.logicalBackup,
    sourceStorage: manifest.sourceStorage,
    deletionAuthority: manifest.deletionAuthority,
  };
  if (
    recoverySetBinding(withoutBinding) !== manifest.recoverySetSha256 ||
    Buffer.from(canonicalPostgresBackupJson(manifest), "utf8").compare(
      bytes,
    ) !== 0
  )
    throw recoveryError("recovery_set_invalid");
  return manifest;
}

async function validateRecoveryObjectFiles(
  root: string,
  uid: number,
  objects: readonly PostgresPrivateStorageRecoveryObject[],
): Promise<{
  readonly directory: TrustedDirectory;
  readonly prefixDirectories: readonly TrustedDirectory[];
  readonly files: readonly TrustedFile[];
}> {
  const expectedByDirectory = new Map<string, string[]>();
  const relativePaths = objects.map((object) =>
    recoveryObjectRelativePath(object.objectPath),
  );
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw recoveryError("recovery_set_invalid");
  }
  for (const relativePath of relativePaths) {
    const [directory, filename] = relativePath.split("/");
    if (!directory || !filename) throw recoveryError("recovery_set_invalid");
    const filenames = expectedByDirectory.get(directory) ?? [];
    filenames.push(filename);
    expectedByDirectory.set(directory, filenames);
  }
  const directory = trustedPrivateDirectory({
    directoryPath: root,
    uid,
    exactEntries: [...expectedByDirectory.keys()].sort(compareUtf8),
    invalidCode: "recovery_set_invalid",
  });
  const fileByRelativePath = new Map<string, TrustedFile>();
  const prefixDirectories: TrustedDirectory[] = [];
  let totalBytes = 0n;
  for (const [directoryName, filenames] of [
    ...expectedByDirectory.entries(),
  ].sort(([left], [right]) => compareUtf8(left, right))) {
    const directory = trustedPrivateDirectory({
      directoryPath: path.join(root, directoryName),
      uid,
      exactEntries: filenames.sort(compareUtf8),
      invalidCode: "recovery_set_invalid",
    });
    prefixDirectories.push(directory);
    for (const filename of filenames) {
      const file = await trustedPrivateFile({
        filePath: path.join(directory.path, filename),
        uid,
        maximumBytes: MAX_OBJECT_BYTES,
        retainBytes: false,
        invalidCode: "recovery_set_invalid",
      });
      totalBytes += file.size;
      if (totalBytes > BigInt(MAX_TOTAL_BYTES))
        throw recoveryError("recovery_set_invalid");
      fileByRelativePath.set(`${directoryName}/${filename}`, file);
    }
  }
  const files = Object.freeze(
    relativePaths.map((relativePath) => {
      const file = fileByRelativePath.get(relativePath);
      if (!file) throw recoveryError("recovery_set_invalid");
      return file;
    }),
  );
  return Object.freeze({
    directory,
    prefixDirectories: Object.freeze(prefixDirectories),
    files,
  });
}

async function assertRecoveryObjectsUnchanged(input: {
  readonly recoverySet: ValidatedRecoverySet;
  readonly uid: number;
  readonly failureCode: PostgresPrivateStorageRecoveryFailureCode;
}): Promise<void> {
  const expectedByDirectory = new Map<string, string[]>();
  for (const object of input.recoverySet.manifest.sourceStorage.objects) {
    const [directoryName, filename] = recoveryObjectRelativePath(
      object.objectPath,
    ).split("/");
    if (!directoryName || !filename) throw recoveryError(input.failureCode);
    const filenames = expectedByDirectory.get(directoryName) ?? [];
    filenames.push(filename);
    expectedByDirectory.set(directoryName, filenames);
  }
  const expectedDirectories = [...expectedByDirectory.entries()].sort(
    ([left], [right]) => compareUtf8(left, right),
  );
  if (
    expectedDirectories.length !==
      input.recoverySet.objectPrefixDirectories.length ||
    input.recoverySet.objectFiles.length !==
      input.recoverySet.manifest.sourceStorage.objects.length
  )
    throw recoveryError(input.failureCode);
  assertDirectoryUnchanged(
    input.recoverySet.objectDirectory,
    input.uid,
    expectedDirectories.map(([directoryName]) => directoryName),
    input.failureCode,
  );
  for (const [[, filenames], directory] of expectedDirectories.map(
    (entry, index) =>
      [entry, input.recoverySet.objectPrefixDirectories[index]!] as const,
  )) {
    assertDirectoryUnchanged(
      directory,
      input.uid,
      filenames,
      input.failureCode,
    );
  }
  for (const file of input.recoverySet.objectFiles) {
    await assertFileUnchanged(
      file,
      input.uid,
      MAX_OBJECT_BYTES,
      input.failureCode,
    );
  }
}

async function validateRecoverySet(input: {
  readonly directoryPath: string;
  readonly uid: number;
  readonly expectedRecoverySetSha256: string;
  readonly expectedManifestSha256: string;
}): Promise<ValidatedRecoverySet> {
  const directory = trustedPrivateDirectory({
    directoryPath: input.directoryPath,
    uid: input.uid,
    exactEntries: ROOT_ENTRIES,
    invalidCode: "recovery_set_invalid",
  });
  const manifestFile = retained(
    await trustedPrivateFile({
      filePath: path.join(
        directory.path,
        POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST,
      ),
      uid: input.uid,
      maximumBytes: MAX_RECOVERY_MANIFEST_BYTES,
      retainBytes: true,
      invalidCode: "recovery_set_invalid",
    }),
  );
  if (manifestFile.sha256 !== exactSha256(input.expectedManifestSha256)) {
    throw recoveryError("recovery_set_tampered");
  }
  const manifest = parseRecoveryManifest(manifestFile.bytes);
  if (
    manifest.recoverySetSha256 !== exactSha256(input.expectedRecoverySetSha256)
  ) {
    throw recoveryError("recovery_set_tampered");
  }
  const objectRoot = path.join(
    directory.path,
    POSTGRES_PRIVATE_STORAGE_RECOVERY_OBJECTS,
  );
  const objectTree = await validateRecoveryObjectFiles(
    objectRoot,
    input.uid,
    manifest.sourceStorage.objects,
  );
  const objectFiles = objectTree.files;
  if (objectFiles.length !== manifest.sourceStorage.objects.length) {
    throw recoveryError("recovery_set_tampered");
  }
  for (const [index, object] of manifest.sourceStorage.objects.entries()) {
    const file = objectFiles[index];
    if (
      !file ||
      Number(file.size) !== object.bytes ||
      file.sha256 !== object.sha256
    ) {
      throw recoveryError("recovery_set_tampered");
    }
  }
  const authorityDirectory = path.join(
    directory.path,
    POSTGRES_PRIVATE_STORAGE_RECOVERY_DELETION_AUTHORITY,
  );
  const authority = await validateDeletionAuthority({
    directoryPath: authorityDirectory,
    uid: input.uid,
    expectedCurrentSha256: manifest.deletionAuthority.currentSha256,
    expectedGenesisSha256: manifest.deletionAuthority.genesisSha256,
    expectedCheckpointSha256: manifest.deletionAuthority.checkpointSha256,
    expectedImmutableSetSha256: manifest.deletionAuthority.immutableSetSha256,
    expectedTombstoneCount: manifest.deletionAuthority.tombstoneCount,
  });
  if (
    authority.authoritySetSha256 !==
      manifest.deletionAuthority.authoritySetSha256 ||
    authority.latestCompletedAt !== manifest.deletionAuthority.latestCompletedAt
  ) {
    throw recoveryError("recovery_set_tampered");
  }
  return {
    directory,
    manifestFile,
    manifest,
    objectDirectory: objectTree.directory,
    objectPrefixDirectories: objectTree.prefixDirectories,
    objectFiles,
    authority,
  };
}

function expectedReferencesFromManifest(
  manifest: PostgresPrivateStorageRecoveryManifest,
): readonly PostgresPrivateStorageReference[] {
  return Object.freeze(
    manifest.sourceStorage.objects
      .filter((object) => object.referencedByDatabase)
      .map((object) => ({
        objectPath: object.objectPath,
        mimeType: object.contentType,
        byteSize: object.bytes,
      })),
  );
}

function destinationObjectSetSha256(
  input: readonly {
    readonly objectPath: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly contentType: string;
  }[],
): string {
  return canonicalSha256(input);
}

export async function restorePostgresPrivateStorageRecovery(
  options: RestorePostgresPrivateStorageRecoveryOptions,
): Promise<RestorePostgresPrivateStorageRecoveryResult> {
  const uid = exactUid(options.getUid);
  const destinationOrigin = canonicalOrigin(options.destinationSupabaseUrl);
  const destinationOriginSha256 = sha256(destinationOrigin);
  const forbidden = options.forbiddenDestinationOriginSha256s.map(exactSha256);
  if (
    destinationOriginSha256 !==
      exactSha256(options.expectedDestinationOriginSha256) ||
    new Set(forbidden).size !== forbidden.length ||
    options.bucketName !== POSTGRES_PRIVATE_STORAGE_BUCKET ||
    sha256(options.bucketName) !== exactSha256(options.expectedBucketNameSha256)
  )
    throw recoveryError("invalid_arguments");
  ensureBoundary({
    storage: options.destinationStorage,
    expectedOrigin: destinationOrigin,
    bucketName: options.bucketName,
    failureCode: "destination_bucket_invalid",
  });
  const backup = await validateLogicalBackup(
    exactAbsolutePath(options.backupDirectory),
    options.expectedBackupManifestSha256,
    uid,
  );
  const recoverySet = await validateRecoverySet({
    directoryPath: exactAbsolutePath(options.recoverySetDirectory),
    uid,
    expectedRecoverySetSha256: options.expectedRecoverySetSha256,
    expectedManifestSha256: options.expectedRecoveryManifestSha256,
  });
  if (
    recoverySet.manifest.logicalBackup.manifestSha256 !==
      backup.manifestFile.sha256 ||
    recoverySet.manifest.logicalBackup.archiveSha256 !==
      backup.archiveFile.sha256 ||
    recoverySet.manifest.logicalBackup.stateReceiptSha256 !==
      backup.stateReceiptFile.sha256 ||
    recoverySet.manifest.logicalBackup.sourceDatabaseIdentitySha256 !==
      backup.stateReceipt.source.databaseIdentitySha256 ||
    recoverySet.manifest.logicalBackup.sourceUrlSha256 !==
      backup.stateReceipt.source.urlSha256 ||
    recoverySet.manifest.logicalBackup.overallStateSha256 !==
      backup.stateReceipt.state.overallStateSha256 ||
    recoverySet.manifest.logicalBackup.sourceEvidenceTableSha256 !==
      sourceEvidenceTableSha256(backup.stateReceipt.state)
  )
    throw recoveryError("recovery_set_tampered");
  if (
    destinationOriginSha256 ===
      recoverySet.manifest.sourceStorage.originSha256 ||
    forbidden.includes(destinationOriginSha256)
  )
    throw recoveryError("destination_not_distinct");
  const firstTarget = await options.inspectTargetDatabase().catch(() => {
    throw recoveryError("target_database_mismatch");
  });
  const firstTargetReferences = validateDatabaseSnapshot({
    snapshot: firstTarget,
    backup,
    expectedIdentitySha256: options.expectedTargetDatabaseIdentitySha256,
    expectedConnectionUrlSha256: options.expectedTargetConnectionUrlSha256,
    requireDisposable: true,
  });
  if (
    !sameReferences(
      firstTargetReferences,
      expectedReferencesFromManifest(recoverySet.manifest),
    )
  ) {
    throw recoveryError("target_database_mismatch");
  }
  await ensurePrivateBucket(
    options.destinationStorage,
    "destination_bucket_invalid",
  );
  let destinationBefore: readonly PostgresPrivateStorageObjectInfo[];
  try {
    destinationBefore = normalizeStorageInventory(
      await options.destinationStorage.listObjects(),
      "destination_bucket_invalid",
    );
  } catch {
    throw recoveryError("destination_bucket_invalid");
  }
  if (destinationBefore.length !== 0)
    throw recoveryError("destination_not_empty");
  const objectFileByPath = new Map(
    recoverySet.manifest.sourceStorage.objects.map((object, index) => [
      object.objectPath,
      recoverySet.objectFiles[index]!,
    ]),
  );
  let mutationStarted = false;
  const verified: Array<{
    readonly objectPath: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly contentType: string;
  }> = [];
  try {
    for (const object of recoverySet.manifest.sourceStorage.objects) {
      const expectedFile = objectFileByPath.get(object.objectPath);
      if (!expectedFile) throw recoveryError("recovery_set_tampered");
      const file = retained(
        await trustedPrivateFile({
          filePath: expectedFile.path,
          uid,
          maximumBytes: MAX_OBJECT_BYTES,
          retainBytes: true,
          invalidCode: "recovery_set_tampered",
        }),
      );
      if (
        file.dev !== expectedFile.dev ||
        file.ino !== expectedFile.ino ||
        file.size !== expectedFile.size ||
        file.mtimeNs !== expectedFile.mtimeNs ||
        file.ctimeNs !== expectedFile.ctimeNs ||
        file.sha256 !== expectedFile.sha256 ||
        file.sha256 !== object.sha256
      )
        throw recoveryError("recovery_set_tampered");
      mutationStarted = true;
      try {
        await options.destinationStorage.uploadImmutable({
          objectPath: object.objectPath,
          bytes: file.bytes,
          contentType: object.contentType,
        });
      } catch {
        throw recoveryError("destination_upload_failed_disposal_required");
      }
      let downloaded: PostgresPrivateStorageDownloadedObject;
      try {
        downloaded = await options.destinationStorage.downloadObject(
          object.objectPath,
        );
      } catch {
        throw recoveryError(
          "destination_verification_failed_disposal_required",
        );
      }
      if (
        downloaded.bytes.length !== object.bytes ||
        sha256(downloaded.bytes) !== object.sha256 ||
        downloaded.contentType !== object.contentType ||
        normalizeContentType(downloaded.contentType) !== object.contentType
      )
        throw recoveryError(
          "destination_verification_failed_disposal_required",
        );
      verified.push({
        objectPath: object.objectPath,
        bytes: object.bytes,
        sha256: object.sha256,
        contentType: object.contentType,
      });
    }
    let destinationAfter: readonly PostgresPrivateStorageObjectInfo[];
    try {
      destinationAfter = normalizeStorageInventory(
        await options.destinationStorage.listObjects(),
        mutationStarted
          ? "destination_verification_failed_disposal_required"
          : "destination_bucket_invalid",
      );
    } catch {
      throw recoveryError(
        mutationStarted
          ? "destination_verification_failed_disposal_required"
          : "destination_bucket_invalid",
      );
    }
    if (
      destinationAfter.length !==
        recoverySet.manifest.sourceStorage.objects.length ||
      destinationAfter.some((object, index) => {
        const expected = recoverySet.manifest.sourceStorage.objects[index];
        return (
          !expected ||
          object.objectPath !== expected.objectPath ||
          object.bytes !== expected.bytes ||
          object.contentType !== expected.contentType
        );
      })
    )
      throw recoveryError(
        mutationStarted
          ? "destination_verification_failed_disposal_required"
          : "destination_bucket_invalid",
      );
    const destinationAfterByPath = new Map(
      destinationAfter.map((object) => [object.objectPath, object]),
    );
    for (const object of recoverySet.manifest.sourceStorage.objects) {
      const downloaded = await options.destinationStorage
        .downloadObject(object.objectPath)
        .catch(() => {
          throw recoveryError(
            mutationStarted
              ? "destination_verification_failed_disposal_required"
              : "destination_bucket_invalid",
          );
        });
      const expectedRemote = destinationAfterByPath.get(object.objectPath);
      if (
        !expectedRemote ||
        downloaded.bytes.length !== object.bytes ||
        sha256(downloaded.bytes) !== object.sha256 ||
        downloaded.contentType !== object.contentType ||
        normalizeContentType(downloaded.contentType) !== object.contentType ||
        downloaded.storageObjectId !== expectedRemote.storageObjectId ||
        downloaded.storageVersion !== expectedRemote.storageVersion
      )
        throw recoveryError(
          mutationStarted
            ? "destination_verification_failed_disposal_required"
            : "destination_bucket_invalid",
        );
      const localFile = objectFileByPath.get(object.objectPath);
      if (!localFile) throw recoveryError("recovery_set_tampered");
      await assertFileUnchanged(
        localFile,
        uid,
        MAX_OBJECT_BYTES,
        "recovery_set_tampered",
      );
    }
    const secondTarget = await options.inspectTargetDatabase().catch(() => {
      throw recoveryError("target_database_mismatch");
    });
    const secondReferences = validateDatabaseSnapshot({
      snapshot: secondTarget,
      backup,
      expectedIdentitySha256: options.expectedTargetDatabaseIdentitySha256,
      expectedConnectionUrlSha256: options.expectedTargetConnectionUrlSha256,
      requireDisposable: true,
    });
    if (!sameReferences(firstTargetReferences, secondReferences)) {
      throw recoveryError("target_database_mismatch");
    }
    await ensurePrivateBucket(
      options.destinationStorage,
      "destination_bucket_invalid",
    );
    await Promise.all([
      assertLogicalBackupUnchanged(backup, uid),
      assertFileUnchanged(
        recoverySet.manifestFile,
        uid,
        MAX_RECOVERY_MANIFEST_BYTES,
        "recovery_set_tampered",
      ),
      assertAuthorityUnchanged(recoverySet.authority, uid),
      assertRecoveryObjectsUnchanged({
        recoverySet,
        uid,
        failureCode: "recovery_set_tampered",
      }),
    ]);
    assertDirectoryUnchanged(
      recoverySet.directory,
      uid,
      ROOT_ENTRIES,
      "recovery_set_tampered",
    );
    let destinationFinal: readonly PostgresPrivateStorageObjectInfo[];
    try {
      destinationFinal = normalizeStorageInventory(
        await options.destinationStorage.listObjects(),
        mutationStarted
          ? "destination_verification_failed_disposal_required"
          : "destination_bucket_invalid",
      );
    } catch {
      throw recoveryError(
        mutationStarted
          ? "destination_verification_failed_disposal_required"
          : "destination_bucket_invalid",
      );
    }
    if (!sameStorageInventory(destinationAfter, destinationFinal)) {
      throw recoveryError(
        mutationStarted
          ? "destination_verification_failed_disposal_required"
          : "destination_bucket_invalid",
      );
    }
    const restoredAt = canonicalTimestamp(
      (options.now ?? (() => new Date()))(),
    );
    return Object.freeze({
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-restore",
      ok: true,
      restoredAt,
      targetDatabaseIdentitySha256: firstTarget.databaseIdentitySha256,
      recoverySetSha256: recoverySet.manifest.recoverySetSha256,
      recoveryManifestSha256: recoverySet.manifestFile.sha256,
      restoredObjectCount: verified.length,
      restoredBytes: String(
        verified.reduce((sum, object) => sum + object.bytes, 0),
      ),
      destinationObjectSetSha256: destinationObjectSetSha256(verified),
      deletionAuthoritySetSha256: recoverySet.authority.authoritySetSha256,
    });
  } catch (error) {
    if (error instanceof PostgresPrivateStorageRecoveryError) {
      if (mutationStarted && !error.code.endsWith("_disposal_required"))
        throw recoveryError(
          "destination_verification_failed_disposal_required",
        );
      throw error;
    }
    throw recoveryError(
      mutationStarted
        ? "destination_verification_failed_disposal_required"
        : "destination_bucket_invalid",
    );
  }
}

function decodedConnectionComponent(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !/[\r\n\0]/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function connectionUrl(input: {
  readonly value: string;
  readonly allowInsecureLoopbackForTests: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): {
  readonly clientConfig: Readonly<ClientConfig>;
  readonly urlSha256: string;
} {
  const value = input.value.trim();
  if (
    !value ||
    value !== input.value ||
    value.length > 16 * 1024 ||
    /[\r\n\0]/.test(value)
  ) {
    throw recoveryError("invalid_arguments");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw recoveryError("invalid_arguments");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(hostname);
  const queryEntries = [...url.searchParams.entries()];
  const sslModes = queryEntries
    .filter(([name]) => name === "sslmode")
    .map(([, mode]) => mode);
  const sslMode = sslModes[0]?.toLowerCase() ?? "";
  const port = Number(url.port || "5432");
  const databasePath = url.pathname.startsWith("/")
    ? url.pathname.slice(1)
    : "";
  const database = decodedConnectionComponent(databasePath);
  const user = decodedConnectionComponent(url.username);
  const password = decodedConnectionComponent(url.password);
  const poolerHost =
    hostname.includes("pooler") ||
    hostname.includes("pgbouncer") ||
    hostname.includes("pgpool");
  const insecureTest =
    input.allowInsecureLoopbackForTests &&
    input.environment.NODE_ENV === "test" &&
    loopback &&
    sslModes.length === 1 &&
    sslMode === "disable";
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !hostname ||
    poolerHost ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    port === 6_543 ||
    !database ||
    database.includes("/") ||
    !user ||
    !password ||
    url.hash ||
    sslModes.length !== 1 ||
    queryEntries.some(([name]) => name !== "sslmode") ||
    (!insecureTest &&
      !["require", "verify-ca", "verify-full"].includes(sslMode))
  )
    throw recoveryError("invalid_arguments");
  return {
    clientConfig: Object.freeze({
      host: hostname,
      port,
      database,
      user,
      password,
      ssl: insecureTest ? false : { rejectUnauthorized: sslMode !== "require" },
      connectionTimeoutMillis: 15_000,
    }),
    urlSha256: sha256(value),
  };
}

function databaseIdentitySha256(row: SourceIdentityRow): string {
  if (row.targetClass === "disposable-rehearsal") {
    return sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-restore-target",
      version: 1,
      systemIdentifier: row.systemIdentifier,
      databaseOid: row.databaseOid,
      databaseName: row.databaseName,
      serverVersionNum: row.serverVersionNum,
      targetClass: row.targetClass,
    });
  }
  return sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-source-database",
    version: 1,
    systemIdentifier: row.systemIdentifier,
    databaseOid: row.databaseOid,
    databaseName: row.databaseName,
    serverVersionNum: row.serverVersionNum,
  });
}

export function createPostgresPrivateStorageDatabaseInspector(input: {
  readonly connectionString: string;
  readonly expectedConnectionUrlSha256?: string | undefined;
  readonly allowInsecureLoopbackForTests?: boolean | undefined;
  readonly environment?:
    Readonly<Record<string, string | undefined>> | undefined;
}): PostgresPrivateStorageDatabaseInspector {
  const environment = input.environment ?? process.env;
  const parsed = connectionUrl({
    value: input.connectionString,
    allowInsecureLoopbackForTests: input.allowInsecureLoopbackForTests ?? false,
    environment,
  });
  if (
    input.expectedConnectionUrlSha256 !== undefined &&
    parsed.urlSha256 !== exactSha256(input.expectedConnectionUrlSha256)
  )
    throw recoveryError("invalid_arguments");
  return async () => {
    const client = new Client({
      ...parsed.clientConfig,
      application_name: "pintpath-private-storage-recovery",
      query_timeout: 120_000,
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
    });
    let transaction = false;
    let roleSet = false;
    try {
      await client.connect();
      const identityResult =
        await client.query<SourceIdentityRow>(`/* pintpath:private-storage:identity */
        SELECT control.system_identifier::text AS "systemIdentifier",
               database.oid::text AS "databaseOid",
               current_database() AS "databaseName",
               current_setting('server_version_num') AS "serverVersionNum",
               login.rolname AS "roleName", login.rolcanlogin AS "canLogin",
               login.rolsuper AS superuser, login.rolcreatedb AS "createDatabase",
               login.rolcreaterole AS "createRole", login.rolreplication AS replication,
               login.rolbypassrls AS "bypassRls",
               pg_has_role(session_user, 'pintpath_migrator', 'SET') AS "canSetMigrator",
               current_setting('transaction_read_only')::boolean AS "transactionReadOnly",
               pg_is_in_recovery() AS "inRecovery",
               database.datistemplate AS "databaseIsTemplate",
               database.datallowconn AS "databaseAllowsConnections",
               current_setting('pintpath.logical_restore_target_class', true) AS "targetClass"
        FROM pg_catalog.pg_database AS database
        JOIN pg_catalog.pg_roles AS login ON login.rolname = session_user
        CROSS JOIN pg_catalog.pg_control_system() AS control
        WHERE database.datname = current_database()`);
      const identity = identityResult.rows[0];
      if (
        identityResult.rows.length !== 1 ||
        !identity ||
        !/^\d+$/.test(identity.systemIdentifier) ||
        !/^\d+$/.test(identity.databaseOid) ||
        !identity.databaseName ||
        !/^17\d{4}$/.test(identity.serverVersionNum) ||
        !identity.roleName ||
        identity.canLogin !== true ||
        identity.superuser !== false ||
        identity.createDatabase !== false ||
        identity.createRole !== false ||
        identity.replication !== false ||
        identity.bypassRls !== false ||
        identity.canSetMigrator !== true ||
        identity.transactionReadOnly !== false ||
        identity.inRecovery !== false ||
        identity.databaseIsTemplate !== false ||
        identity.databaseAllowsConnections !== true ||
        ![null, "", "disposable-rehearsal"].includes(identity.targetClass)
      )
        throw new Error("unsafe_identity");
      await client.query(
        "/* pintpath:private-storage:set-role */ SET ROLE pintpath_migrator",
      );
      roleSet = true;
      await client.query(`/* pintpath:private-storage:begin */
        BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      transaction = true;
      await client.query(`/* pintpath:private-storage:settings */
        SET LOCAL statement_timeout = '120s';
        SET LOCAL lock_timeout = '30s';
        SET LOCAL idle_in_transaction_session_timeout = '600s';
        SET LOCAL timezone = 'UTC';
        SET LOCAL bytea_output = 'hex';
        SET LOCAL extra_float_digits = 3`);
      const roleResult =
        await client.query<EffectiveRoleRow>(`/* pintpath:private-storage:role */
        SELECT current_user AS "effectiveRole", session_user AS "sessionRole",
               current_setting('transaction_isolation') AS "transactionIsolation",
               current_setting('transaction_read_only')::boolean AS "transactionReadOnly",
               role.rolcanlogin AS "canLogin", role.rolinherit AS "inheritsPrivileges",
               role.rolsuper AS superuser, role.rolcreatedb AS "createDatabase",
               role.rolcreaterole AS "createRole", role.rolreplication AS replication,
               role.rolbypassrls AS "bypassRls"
        FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user`);
      const role = roleResult.rows[0];
      if (
        roleResult.rows.length !== 1 ||
        role?.effectiveRole !== "pintpath_migrator" ||
        !role.sessionRole ||
        role.sessionRole === role.effectiveRole ||
        role.transactionIsolation !== "repeatable read" ||
        role.transactionReadOnly !== true ||
        role.canLogin !== false ||
        role.inheritsPrivileges !== true ||
        role.superuser !== false ||
        role.createDatabase !== false ||
        role.createRole !== false ||
        role.replication !== false ||
        role.bypassRls !== false
      )
        throw new Error("unsafe_role");
      const connection: PostgresLogicalStateConnection = {
        query: async <Row extends QueryResultRow = QueryResultRow>(
          text: string,
          values: readonly unknown[] = [],
        ) => {
          const result = await client.query<Row>(text, [...values]);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      };
      const state = await computePostgresLogicalStateInventory(connection);
      const referenceResult =
        await client.query<ReferenceRow>(`/* pintpath:private-storage:references */
        SELECT object_path AS "objectPath", mime_type AS "mimeType",
               byte_size::text AS "byteSize"
        FROM pintpath_app.source_evidence_objects
        WHERE storage_provider = 'supabase_private' AND deleted_at IS NULL
        ORDER BY object_path COLLATE "C"`);
      const references = normalizeReferences(
        referenceResult.rows.map((row) => ({
          objectPath: row.objectPath,
          mimeType: row.mimeType,
          byteSize: Number(row.byteSize),
        })),
      );
      await client.query("/* pintpath:private-storage:rollback */ ROLLBACK");
      transaction = false;
      await client.query(
        "/* pintpath:private-storage:reset-role */ RESET ROLE",
      );
      roleSet = false;
      return Object.freeze({
        connectionUrlSha256: parsed.urlSha256,
        databaseIdentitySha256: databaseIdentitySha256(identity),
        targetClass:
          identity.targetClass === "disposable-rehearsal"
            ? "disposable-rehearsal"
            : null,
        state,
        references,
      });
    } catch {
      throw recoveryError("source_database_mismatch");
    } finally {
      if (transaction) await client.query("ROLLBACK").catch(() => undefined);
      if (roleSet) await client.query("RESET ROLE").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  };
}

function normalizeInfoToken(value: unknown): string {
  if (typeof value !== "string") throw recoveryError("source_storage_changed");
  return safeStorageToken(value);
}

function storageStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const value = record.statusCode ?? record.status;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

class SupabasePrivateStorageBoundary implements PostgresPrivateStorageBoundary {
  readonly origin: string;
  private readonly client: SupabaseClient;

  constructor(
    supabaseUrl: string,
    serviceRoleKey: string,
    readonly bucketName: string,
    private readonly requestTimeoutMs: number,
    clientFactory?: ((url: string, key: string) => SupabaseClient) | undefined,
    fetchImplementation?: typeof globalThis.fetch | undefined,
  ) {
    this.origin = canonicalOrigin(supabaseUrl);
    if (
      !serviceRoleKey ||
      serviceRoleKey.length > 64 * 1024 ||
      /[\u0000\r\n]/.test(serviceRoleKey)
    ) {
      throw recoveryError("invalid_arguments");
    }
    const scopedFetch =
      postgresLogicalOffsiteInternals.createScopedStorageFetch(
        this.origin,
        fetchImplementation ?? globalThis.fetch,
      );
    this.client = clientFactory
      ? clientFactory(this.origin, serviceRoleKey)
      : createServerSupabaseClient(this.origin, serviceRoleKey, {
          timeoutMs: requestTimeoutMs,
          fetchImplementation: scopedFetch,
        });
  }

  private async boundedOperation<Result>(
    operation: () => PromiseLike<Result>,
  ): Promise<Result> {
    let timer: NodeJS.Timeout | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(recoveryError("source_storage_unreachable")),
        this.requestTimeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.resolve(operation()), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async inspectBucket(): Promise<PostgresPrivateStorageBucketInfo> {
    const { data, error } = await this.boundedOperation(() =>
      this.client.storage.getBucket(this.bucketName),
    );
    if (error || !data) throw recoveryError("source_storage_unreachable");
    const raw = data as typeof data & {
      readonly file_size_limit?: unknown;
      readonly allowed_mime_types?: unknown;
    };
    return {
      private: data.public === false,
      fileSizeLimit:
        typeof raw.file_size_limit === "number" ? raw.file_size_limit : null,
      allowedMimeTypes:
        Array.isArray(raw.allowed_mime_types) &&
        raw.allowed_mime_types.every((value) => typeof value === "string")
          ? raw.allowed_mime_types
          : null,
    };
  }

  private async objectInfo(
    objectPath: string,
  ): Promise<PostgresPrivateStorageObjectInfo> {
    const { data, error } = await this.boundedOperation(() =>
      this.client.storage.from(this.bucketName).info(objectPath),
    );
    if (error || !data) throw recoveryError("source_storage_unreachable");
    const raw = data as typeof data & {
      readonly id?: unknown;
      readonly version?: unknown;
      readonly size?: unknown;
      readonly contentType?: unknown;
      readonly name?: unknown;
      readonly bucketId?: unknown;
    };
    if (
      raw.name !== objectPath ||
      raw.bucketId !== this.bucketName ||
      typeof raw.size !== "number" ||
      typeof raw.contentType !== "string"
    ) {
      throw recoveryError("source_storage_changed");
    }
    return normalizeStorageInventory([
      {
        objectPath,
        bytes: raw.size,
        contentType: raw.contentType,
        storageObjectId: normalizeInfoToken(raw.id),
        storageVersion: normalizeInfoToken(raw.version),
      },
    ])[0]!;
  }

  private async listPaths(prefix = "", depth = 0): Promise<string[]> {
    if (depth > 128) throw recoveryError("source_storage_changed");
    const paths: string[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await this.boundedOperation(() =>
        this.client.storage.from(this.bucketName).list(prefix, {
          limit: 100,
          offset,
          sortBy: { column: "name", order: "asc" },
        }),
      );
      if (error) throw recoveryError("source_storage_unreachable");
      if (!Array.isArray(data)) throw recoveryError("source_storage_changed");
      const entries = data;
      for (const entry of entries) {
        if (!entry || typeof entry.name !== "string" || !entry.name) {
          throw recoveryError("source_storage_changed");
        }
        const objectPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const file =
          typeof entry.id === "string" &&
          entry.id.length > 0 &&
          isRecord(entry.metadata);
        const folder = entry.id === null && entry.metadata === null;
        if (file === folder) throw recoveryError("source_storage_changed");
        if (file) {
          paths.push(safeObjectPath(objectPath));
        } else if (folder) {
          paths.push(
            ...(await this.listPaths(safeObjectPath(objectPath), depth + 1)),
          );
        }
        if (paths.length > MAX_OBJECT_COUNT)
          throw recoveryError("source_storage_changed");
      }
      if (entries.length < 100) break;
      offset += entries.length;
    }
    return paths;
  }

  async listObjects(): Promise<readonly PostgresPrivateStorageObjectInfo[]> {
    const paths = (await this.listPaths()).sort(compareUtf8);
    const objects: PostgresPrivateStorageObjectInfo[] = [];
    for (const objectPath of paths) {
      objects.push(await this.objectInfo(objectPath));
    }
    return normalizeStorageInventory(objects);
  }

  async downloadObject(
    objectPath: string,
  ): Promise<PostgresPrivateStorageDownloadedObject> {
    const safe = safeObjectPath(objectPath);
    const before = await this.objectInfo(safe);
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let timer: NodeJS.Timeout | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(recoveryError("source_storage_unreachable"));
      }, this.requestTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        (async () => {
          const { data, error } = await this.client.storage
            .from(this.bucketName)
            .download(
              safe,
              { cacheNonce: crypto.randomBytes(16).toString("hex") },
              { cache: "no-store", signal: controller.signal },
            )
            .asStream();
          if (error || !data) throw recoveryError("source_storage_unreachable");
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          reader = data.getReader();
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            const chunk = Buffer.from(result.value);
            totalBytes += chunk.length;
            if (totalBytes > MAX_OBJECT_BYTES) {
              throw recoveryError("source_storage_changed");
            }
            chunks.push(chunk);
          }
          if (totalBytes < 1) throw recoveryError("source_storage_changed");
          const after = await this.objectInfo(safe);
          if (!sameStorageInventory([before], [after])) {
            throw recoveryError("source_storage_changed");
          }
          return {
            bytes: Buffer.concat(chunks, totalBytes),
            contentType: after.contentType,
            storageObjectId: after.storageObjectId,
            storageVersion: after.storageVersion,
          };
        })(),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof PostgresPrivateStorageRecoveryError) throw error;
      throw recoveryError("source_storage_unreachable");
    } finally {
      controller.abort();
      const activeReader =
        reader as ReadableStreamDefaultReader<Uint8Array> | null;
      if (activeReader) void activeReader.cancel().catch(() => undefined);
      if (timer) clearTimeout(timer);
    }
  }

  async uploadImmutable(input: {
    readonly objectPath: string;
    readonly bytes: Buffer;
    readonly contentType: string;
  }): Promise<void> {
    const objectPath = safeObjectPath(input.objectPath);
    const contentType = normalizeContentType(input.contentType);
    if (input.bytes.length < 1 || input.bytes.length > MAX_OBJECT_BYTES) {
      throw recoveryError("destination_upload_failed_disposal_required");
    }
    const { error } = await this.boundedOperation(() =>
      this.client.storage
        .from(this.bucketName)
        .upload(objectPath, input.bytes, {
          contentType,
          cacheControl: "3600",
          upsert: false,
        }),
    );
    if (error) {
      if (storageStatus(error) === 409) {
        throw recoveryError("destination_not_empty");
      }
      throw recoveryError("destination_upload_failed_disposal_required");
    }
  }
}

export function createSupabasePrivateStorageRecoveryBoundary(input: {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly bucketName?: string | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly clientFactory?:
    ((url: string, key: string) => SupabaseClient) | undefined;
  readonly fetchImplementation?: typeof globalThis.fetch | undefined;
}): PostgresPrivateStorageBoundary {
  const bucketName = input.bucketName ?? POSTGRES_PRIVATE_STORAGE_BUCKET;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    bucketName !== POSTGRES_PRIVATE_STORAGE_BUCKET ||
    !Number.isFinite(requestTimeoutMs) ||
    requestTimeoutMs < 1_000 ||
    requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
  )
    throw recoveryError("invalid_arguments");
  return new SupabasePrivateStorageBoundary(
    input.supabaseUrl,
    input.serviceRoleKey,
    bucketName,
    requestTimeoutMs,
    input.clientFactory,
    input.fetchImplementation,
  );
}

export const postgresPrivateStorageRecoveryInternals = {
  canonicalOrigin,
  connectionUrl,
  parseRecoveryManifest,
  compareUtf8,
  recoverySetBinding,
  recoveryObjectRelativePath,
  safeObjectPath,
  storageInventorySha256,
};
