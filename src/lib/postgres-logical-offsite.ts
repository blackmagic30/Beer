import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  SystemLeaseValue,
  SystemStateRecord,
  SystemStateRepository,
} from "../db/system-state.repository.js";
import type { SqlDatabase } from "../db/sql-database.js";
import { sha256PostgresDatabaseIdentity } from "./postgres-database-identity.js";
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
  parsePostgresLogicalSourceStateReceipt,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalSourceStateReceipt,
} from "./postgres-logical-state.js";
import {
  createBoundedSupabaseFetch,
  createServerSupabaseClient,
} from "./supabase-client.js";
import {
  OPERATIONAL_OFFSITE_SUPABASE_ORIGIN,
  assertExactSupabaseOrigin,
  assertSupabaseServerApiKey,
} from "./supabase-key-format.js";

export const POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY =
  "job:postgres_logical_backup_success" as const;
export const POSTGRES_LOGICAL_OFFSITE_LEASE_KEY =
  "lease:postgres_logical_backup_offsite_attestation" as const;
export const POSTGRES_LOGICAL_OFFSITE_PREFIX =
  "_control/postgres-logical-backups/v2" as const;
export const POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT =
  `${POSTGRES_LOGICAL_OFFSITE_PREFIX}/latest.json` as const;

const SUCCESS_KIND = "pintpath-postgres-logical-backup-success" as const;
const ATTESTATION_KIND = "pintpath-postgres-logical-offsite-attestation" as const;
const LATEST_KIND = "pintpath-postgres-logical-offsite-latest" as const;
const STORAGE_CONTRACT = "pintpath-postgres-logical-offsite-v2" as const;
const CONTRACT_VERSION = 2 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BACKUP_ID_PATTERN = /^\d{8}T\d{9}Z-[a-f0-9]{64}$/;
const ATTESTATION_ID_PATTERN = /^\d{8}T\d{9}Z-[a-f0-9]{64}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const OPERATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{0,254}$/;
const MAX_MANIFEST_BYTES = 256n * 1024n;
const MAX_STATE_RECEIPT_BYTES = 4n * 1024n * 1024n;
const MAX_ARCHIVE_BYTES = 50n * 1024n * 1024n * 1024n;
const MAX_REMOTE_JSON_BYTES = 256 * 1024;
const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
const SECRET_API_KEY_PATTERN = /^sb_secret_[A-Za-z0-9_-]{20,220}$/;
const LEGACY_JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{2,4096}$/;
const LEASE_DURATION_MS = 6 * 60 * 60 * 1000;
const MINIMUM_POINTER_LEASE_REMAINING_MS = 5 * 60 * 1000;
const IMMUTABLE_CACHE_CONTROL = "31536000";
const MUTABLE_CACHE_CONTROL = "0";

export type PostgresLogicalOffsiteFailureCode =
  | "invalid_arguments"
  | "unsafe_backup_directory"
  | "backup_manifest_invalid"
  | "backup_tampered"
  | "destination_unsafe"
  | "destination_unreachable"
  | "bucket_not_private"
  | "bucket_policy_incompatible"
  | "runtime_identity_unavailable"
  | "runtime_identity_mismatch"
  | "lease_unavailable"
  | "lease_lost"
  | "object_upload_failed"
  | "object_verification_failed"
  | "state_regression"
  | "state_write_failed"
  | "cleanup_failed";

export class PostgresLogicalOffsiteError extends Error {
  constructor(readonly code: PostgresLogicalOffsiteFailureCode) {
    super(code);
    this.name = "PostgresLogicalOffsiteError";
  }
}

export interface PostgresLogicalBackupSuccessState {
  readonly kind: typeof SUCCESS_KIND;
  readonly version: typeof CONTRACT_VERSION;
  readonly backupCreatedAt: string;
  readonly completedAt: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly stateReceiptSha256: string;
  readonly manifestBindingSha256: string;
  readonly sourceDatabaseIdentitySha256: string;
  readonly runtimeConnectionUrlSha256?: string | undefined;
  readonly overallStateSha256: string;
  readonly remoteObjectSetSha256: string;
  readonly attestationSha256: string;
  readonly attestationStorageObjectIdSha256: string;
  readonly attestationStorageVersionSha256: string;
  readonly latestPointerSha256: string;
  readonly latestPointerStorageObjectIdSha256: string;
  readonly latestPointerStorageVersionSha256: string;
  readonly backupIdSha256: string;
  readonly destinationOriginSha256: string;
  readonly bucketNameSha256: string;
  readonly operatorIdSha256: string;
}

export interface PostgresLogicalOffsiteResult {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly backupCreatedAt: string;
  readonly completedAt: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly stateReceiptSha256: string;
  readonly overallStateSha256: string;
  readonly sourceDatabaseIdentitySha256: string;
  readonly remoteObjectSetSha256: string;
  readonly attestationSha256: string;
  readonly latestPointerSha256: string;
  readonly backupIdSha256: string;
  readonly successStateSha256: string;
}

export interface PostgresLogicalOffsiteReadiness {
  readonly status: "ok" | "failed" | "required_unconfigured";
  readonly required: true;
  readonly liveProbe: boolean;
  readonly lastSuccessfulAt: string | null;
  readonly ageHours: number | null;
  readonly error?:
    | "attestation_state_invalid"
    | "destination_unconfigured"
    | "destination_not_independent"
    | "destination_binding_mismatch"
    | "runtime_database_binding_mismatch"
    | "last_successful_backup_stale"
    | "remote_attestation_unavailable"
    | "remote_attestation_mismatch";
}

export interface PostgresLogicalOffsiteBucketInfo {
  readonly private: boolean;
  readonly fileSizeLimit: number | null;
  readonly allowedMimeTypes: readonly string[] | null;
}

export interface PostgresLogicalOffsiteObjectInfo {
  readonly bytes: number;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly storageObjectId: string;
  readonly storageVersion: string;
}

export interface PostgresLogicalOffsiteDownload {
  readonly bytes: number;
  readonly sha256: string;
  readonly retainedBytes?: Buffer;
}

export interface PostgresLogicalOffsiteUpload {
  readonly bucketName: string;
  readonly objectPath: string;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly bytes?: Buffer;
  readonly filePath?: string;
  readonly expectedBytes: number;
}

export interface PostgresLogicalOffsiteStorage {
  readonly destinationOrigin: string;
  inspectBucket(bucketName: string): Promise<PostgresLogicalOffsiteBucketInfo>;
  objectInfo(
    bucketName: string,
    objectPath: string,
  ): Promise<PostgresLogicalOffsiteObjectInfo | null>;
  uploadImmutable(input: PostgresLogicalOffsiteUpload): Promise<void>;
  replaceMutable(input: PostgresLogicalOffsiteUpload): Promise<void>;
  downloadVerified(input: {
    readonly bucketName: string;
    readonly objectPath: string;
    readonly maximumBytes: number;
    readonly retainBytes: boolean;
  }): Promise<PostgresLogicalOffsiteDownload>;
  removeExact(bucketName: string, objectPaths: readonly string[]): Promise<void>;
}

export interface PostgresLogicalOffsiteStateAuthority {
  get(key: string): Promise<SystemStateRecord<Record<string, unknown>> | null>;
  compareAndSet(
    key: string,
    expectedRevision: string | null,
    value: Record<string, unknown>,
    now: string,
  ): Promise<SystemStateRecord<Record<string, unknown>> | null>;
  acquireLease(input: {
    readonly key: string;
    readonly owner: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseUntil: string;
  }): Promise<SystemStateRecord<SystemLeaseValue> | null>;
  releaseLease(input: {
    readonly key: string;
    readonly owner: string;
    readonly leaseToken: string;
    readonly now: string;
  }): Promise<SystemStateRecord<SystemLeaseValue> | null>;
}

export interface AttestPostgresLogicalBackupOptions {
  readonly backupDirectory: string;
  readonly expectedManifestSha256: string;
  readonly runtimeDatabaseIdentitySha256: string;
  readonly runtimeConnectionUrlSha256: string;
  readonly sourceSupabaseUrl: string;
  readonly destinationSupabaseUrl: string;
  readonly expectedDestinationOriginSha256: string;
  readonly bucketName: string;
  readonly expectedBucketNameSha256: string;
  readonly operatorId: string;
  readonly storage: PostgresLogicalOffsiteStorage;
  readonly state: PostgresLogicalOffsiteStateAuthority;
  readonly now?: (() => Date) | undefined;
  readonly randomUuid?: (() => string) | undefined;
}

interface TrustedFileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly sha256: string;
  readonly bytes?: Buffer;
}

interface TrustedBackupArtifacts {
  readonly directory: {
    readonly path: string;
    readonly dev: bigint;
    readonly ino: bigint;
  };
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly receiptPath: string;
  readonly archive: TrustedFileSnapshot;
  readonly manifest: TrustedFileSnapshot & { readonly bytes: Buffer };
  readonly receipt: TrustedFileSnapshot & { readonly bytes: Buffer };
  readonly parsedManifest: PostgresLogicalBackupManifest;
  readonly parsedReceipt: PostgresLogicalSourceStateReceipt;
}

type RemoteObjectKind = "archive" | "manifest" | "state-receipt";

interface RemoteObjectDescriptor {
  readonly kind: RemoteObjectKind;
  readonly objectPathSha256: string;
  readonly bytes: string;
  readonly sha256: string;
  readonly contentType: string;
  readonly metadataSha256: string;
  readonly storageObjectIdSha256: string;
  readonly storageVersionSha256: string;
}

interface PostgresLogicalOffsiteAttestation {
  readonly kind: typeof ATTESTATION_KIND;
  readonly version: typeof CONTRACT_VERSION;
  readonly backupId: string;
  readonly backupIdSha256: string;
  readonly backupCreatedAt: string;
  readonly verifiedAt: string;
  readonly manifestSha256: string;
  readonly archiveSha256: string;
  readonly stateReceiptSha256: string;
  readonly manifestBindingSha256: string;
  readonly sourceDatabaseIdentitySha256: string;
  readonly runtimeConnectionUrlSha256?: string | undefined;
  readonly overallStateSha256: string;
  readonly destinationOriginSha256: string;
  readonly bucketNameSha256: string;
  readonly operatorIdSha256: string;
  readonly objects: readonly RemoteObjectDescriptor[];
  readonly remoteObjectSetSha256: string;
}

interface PostgresLogicalOffsiteLatestPointer {
  readonly kind: typeof LATEST_KIND;
  readonly version: typeof CONTRACT_VERSION;
  readonly backupId: string;
  readonly backupIdSha256: string;
  readonly attestationId: string;
  readonly backupCreatedAt: string;
  readonly completedAt: string;
  readonly manifestSha256: string;
  readonly archiveSha256: string;
  readonly stateReceiptSha256: string;
  readonly manifestBindingSha256: string;
  readonly sourceDatabaseIdentitySha256: string;
  readonly runtimeConnectionUrlSha256?: string | undefined;
  readonly overallStateSha256: string;
  readonly remoteObjectSetSha256: string;
  readonly attestationSha256: string;
  readonly attestationStorageObjectIdSha256: string;
  readonly attestationStorageVersionSha256: string;
  readonly destinationOriginSha256: string;
  readonly bucketNameSha256: string;
  readonly operatorIdSha256: string;
}

function offsiteError(
  code: PostgresLogicalOffsiteFailureCode,
): PostgresLogicalOffsiteError {
  return new PostgresLogicalOffsiteError(code);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalPostgresBackupJson(value));
}

interface RuntimeDatabaseIdentityRow {
  readonly systemIdentifier: unknown;
  readonly databaseOid: unknown;
  readonly databaseName: unknown;
  readonly serverVersionNum: unknown;
}

export const POSTGRES_LOGICAL_RUNTIME_DATABASE_IDENTITY_QUERY =
  `/* pintpath:logical-offsite:runtime-database-identity */
  SELECT
    control.system_identifier::text AS "systemIdentifier",
    database.oid::text AS "databaseOid",
    current_database() AS "databaseName",
    current_setting('server_version_num') AS "serverVersionNum"
  FROM pg_catalog.pg_database AS database
  CROSS JOIN pg_catalog.pg_control_system() AS control
  WHERE database.datname = current_database()`;

export async function inspectPostgresLogicalRuntimeDatabaseIdentity(
  database: SqlDatabase,
): Promise<string> {
  if (database.dialect !== "postgres") {
    throw offsiteError("runtime_identity_unavailable");
  }
  let row: RuntimeDatabaseIdentityRow | undefined;
  try {
    row = await database
      .prepare(POSTGRES_LOGICAL_RUNTIME_DATABASE_IDENTITY_QUERY)
      .get<RuntimeDatabaseIdentityRow>();
  } catch {
    throw offsiteError("runtime_identity_unavailable");
  }
  if (
    !row
    || typeof row.systemIdentifier !== "string"
    || !/^\d+$/.test(row.systemIdentifier)
    || typeof row.databaseOid !== "string"
    || !/^\d+$/.test(row.databaseOid)
    || typeof row.databaseName !== "string"
    || row.databaseName.length < 1
    || row.databaseName.length > 63
    || /[\u0000-\u001f\u007f]/.test(row.databaseName)
    || typeof row.serverVersionNum !== "string"
    || !/^17\d{4}$/.test(row.serverVersionNum)
  ) throw offsiteError("runtime_identity_unavailable");
  return sha256PostgresDatabaseIdentity({
    systemIdentifier: row.systemIdentifier,
    databaseOid: row.databaseOid,
    databaseName: row.databaseName,
    serverVersionNum: row.serverVersionNum,
  });
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort())
    === JSON.stringify([...expected].sort());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function exactKeysWithOptionalSha256(
  value: Record<string, unknown>,
  expected: readonly string[],
  optionalKey: string,
): boolean {
  const hasOptional = Object.prototype.hasOwnProperty.call(value, optionalKey);
  return exactKeys(value, hasOptional ? [...expected, optionalKey] : expected)
    && (!hasOptional || isSha256(value[optionalKey]));
}

function isBoundedStorageToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 512
    && value.trim() === value
    && Buffer.byteLength(value, "utf8") <= 1024
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw offsiteError("invalid_arguments");
  }
  return value.toISOString();
}

function canonicalOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.port
    ) throw new Error("unsafe");
    return parsed.origin.toLowerCase();
  } catch {
    throw offsiteError("destination_unsafe");
  }
}

function assertBucketName(value: string): string {
  if (!BUCKET_PATTERN.test(value)) throw offsiteError("invalid_arguments");
  return value;
}

function assertOperatorId(value: string): string {
  if (
    !OPERATOR_PATTERN.test(value)
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw offsiteError("invalid_arguments");
  return value;
}

function assertSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw offsiteError("invalid_arguments");
  return normalized;
}

export function assertPostgresLogicalOffsiteDestinationPins(input: {
  readonly destinationSupabaseUrl: string;
  readonly bucketName: string;
  readonly expectedDestinationOriginSha256: string;
  readonly expectedBucketNameSha256: string;
}): void {
  const destinationOrigin = canonicalOrigin(input.destinationSupabaseUrl);
  const bucketName = assertBucketName(input.bucketName);
  if (
    sha256(destinationOrigin) !== assertSha256(input.expectedDestinationOriginSha256)
    || sha256(bucketName) !== assertSha256(input.expectedBucketNameSha256)
  ) throw offsiteError("destination_unsafe");
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:.]/g, "");
}

function backupId(manifest: PostgresLogicalBackupManifest, manifestSha256: string): string {
  const value = `${compactTimestamp(manifest.createdAt)}-${manifestSha256}`;
  if (!BACKUP_ID_PATTERN.test(value)) throw offsiteError("backup_manifest_invalid");
  return value;
}

function objectPathForBackup(id: string, filename: string): string {
  if (!BACKUP_ID_PATTERN.test(id)) throw offsiteError("invalid_arguments");
  if (![
    POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    POSTGRES_LOGICAL_BACKUP_MANIFEST,
    POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  ].includes(filename as typeof POSTGRES_LOGICAL_BACKUP_ARCHIVE)) {
    throw offsiteError("invalid_arguments");
  }
  return `${POSTGRES_LOGICAL_OFFSITE_PREFIX}/backups/${id}/${filename}`;
}

function attestationPath(id: string, attestationId: string): string {
  if (!BACKUP_ID_PATTERN.test(id) || !ATTESTATION_ID_PATTERN.test(attestationId)) {
    throw offsiteError("invalid_arguments");
  }
  return `${POSTGRES_LOGICAL_OFFSITE_PREFIX}/attestations/${id}/${attestationId}.json`;
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameSnapshot(left: TrustedFileSnapshot, right: TrustedFileSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.sha256 === right.sha256;
}

async function snapshotTrustedFile(input: {
  readonly filePath: string;
  readonly uid: number;
  readonly maximumBytes: bigint;
  readonly retainBytes: boolean;
  readonly invalidCode: "backup_manifest_invalid" | "backup_tampered";
}): Promise<TrustedFileSnapshot> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const before = fs.lstatSync(input.filePath, { bigint: true });
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1n
      || before.uid !== BigInt(input.uid)
      || Number(before.mode & 0o7777n) !== 0o600
      || before.size < 1n
      || before.size > input.maximumBytes
      || fs.realpathSync(input.filePath) !== input.filePath
    ) throw new Error("unsafe");
    // The O_NOFOLLOW descriptor is bound to the pre-open lstat by full file
    // identity and is revalidated after hashing the descriptor contents.
    // codeql[js/file-system-race]
    handle = await fs.promises.open( // lgtm[js/file-system-race]
      input.filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, opened)) throw new Error("changed");
    const hash = crypto.createHash("sha256");
    const retained: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0n;
    while (offset < opened.size) {
      const remaining = opened.size - offset;
      const length = Number(remaining > BigInt(buffer.length)
        ? BigInt(buffer.length)
        : remaining);
      const read = await handle.read(buffer, 0, length, Number(offset));
      if (read.bytesRead < 1) throw new Error("changed");
      const bytes = buffer.subarray(0, read.bytesRead);
      hash.update(bytes);
      if (input.retainBytes) retained.push(Buffer.from(bytes));
      offset += BigInt(read.bytesRead);
    }
    const afterDescriptor = await handle.stat({ bigint: true });
    const afterPath = fs.lstatSync(input.filePath, { bigint: true });
    if (
      !sameFileIdentity(before, afterDescriptor)
      || !sameFileIdentity(before, afterPath)
    ) throw new Error("changed");
    return {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
      sha256: hash.digest("hex"),
      ...(input.retainBytes ? { bytes: Buffer.concat(retained) } : {}),
    };
  } catch (error) {
    if (error instanceof PostgresLogicalOffsiteError) throw error;
    throw offsiteError(input.invalidCode);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validateLocalBackup(
  directoryInput: string,
  expectedManifestSha256: string,
): Promise<TrustedBackupArtifacts> {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 0) throw offsiteError("invalid_arguments");
  if (
    !path.isAbsolute(directoryInput)
    || path.resolve(directoryInput) !== directoryInput
    || directoryInput.includes("\0")
  ) throw offsiteError("invalid_arguments");
  let directoryStat: fs.BigIntStats;
  try {
    directoryStat = fs.lstatSync(directoryInput, { bigint: true });
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || directoryStat.uid !== BigInt(uid!)
      || Number(directoryStat.mode & 0o7777n) !== 0o700
      || fs.realpathSync(directoryInput) !== directoryInput
    ) throw new Error("unsafe");
    const entries = (await fs.promises.readdir(directoryInput)).sort();
    const expected = [
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ].sort();
    if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new Error("unsafe");
  } catch {
    throw offsiteError("unsafe_backup_directory");
  }
  const manifestPath = path.join(directoryInput, POSTGRES_LOGICAL_BACKUP_MANIFEST);
  const archivePath = path.join(directoryInput, POSTGRES_LOGICAL_BACKUP_ARCHIVE);
  const receiptPath = path.join(directoryInput, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT);
  const manifest = await snapshotTrustedFile({
    filePath: manifestPath,
    uid: uid!,
    maximumBytes: MAX_MANIFEST_BYTES,
    retainBytes: true,
    invalidCode: "backup_manifest_invalid",
  });
  if (!manifest.bytes || manifest.sha256 !== expectedManifestSha256) {
    throw offsiteError("backup_tampered");
  }
  let parsedManifest: PostgresLogicalBackupManifest;
  try {
    parsedManifest = parsePostgresLogicalBackupManifest(manifest.bytes);
  } catch {
    throw offsiteError("backup_manifest_invalid");
  }
  if (parsedManifest.schemaVersion !== 3) {
    throw offsiteError("backup_manifest_invalid");
  }
  const archive = await snapshotTrustedFile({
    filePath: archivePath,
    uid: uid!,
    maximumBytes: MAX_ARCHIVE_BYTES,
    retainBytes: false,
    invalidCode: "backup_tampered",
  });
  if (
    archive.size !== BigInt(parsedManifest.archive.bytes)
    || archive.sha256 !== parsedManifest.archive.sha256
  ) throw offsiteError("backup_tampered");
  const receipt = await snapshotTrustedFile({
    filePath: receiptPath,
    uid: uid!,
    maximumBytes: MAX_STATE_RECEIPT_BYTES,
    retainBytes: true,
    invalidCode: "backup_tampered",
  });
  if (!receipt.bytes || receipt.sha256 !== parsedManifest.state.receiptSha256) {
    throw offsiteError("backup_tampered");
  }
  let parsedReceipt: PostgresLogicalSourceStateReceipt;
  try {
    parsedReceipt = parsePostgresLogicalSourceStateReceipt(receipt.bytes);
    assertPostgresLogicalBackupStateReceiptBinding(parsedReceipt, parsedManifest);
  } catch {
    throw offsiteError("backup_manifest_invalid");
  }
  const currentDirectory = fs.lstatSync(directoryInput, { bigint: true });
  if (
    currentDirectory.dev !== directoryStat.dev
    || currentDirectory.ino !== directoryStat.ino
    || !currentDirectory.isDirectory()
  ) throw offsiteError("backup_tampered");
  return {
    directory: { path: directoryInput, dev: directoryStat.dev, ino: directoryStat.ino },
    archivePath,
    manifestPath,
    receiptPath,
    archive,
    manifest: { ...manifest, bytes: manifest.bytes },
    receipt: { ...receipt, bytes: receipt.bytes },
    parsedManifest,
    parsedReceipt,
  };
}

async function assertLocalBackupUnchanged(backup: TrustedBackupArtifacts): Promise<void> {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 0) throw offsiteError("backup_tampered");
  const directory = fs.lstatSync(backup.directory.path, { bigint: true });
  if (
    directory.dev !== backup.directory.dev
    || directory.ino !== backup.directory.ino
    || !directory.isDirectory()
  ) throw offsiteError("backup_tampered");
  const [archive, manifest, receipt] = await Promise.all([
    snapshotTrustedFile({
      filePath: backup.archivePath,
      uid: uid!,
      maximumBytes: MAX_ARCHIVE_BYTES,
      retainBytes: false,
      invalidCode: "backup_tampered",
    }),
    snapshotTrustedFile({
      filePath: backup.manifestPath,
      uid: uid!,
      maximumBytes: MAX_MANIFEST_BYTES,
      retainBytes: false,
      invalidCode: "backup_tampered",
    }),
    snapshotTrustedFile({
      filePath: backup.receiptPath,
      uid: uid!,
      maximumBytes: MAX_STATE_RECEIPT_BYTES,
      retainBytes: false,
      invalidCode: "backup_tampered",
    }),
  ]);
  if (
    !sameSnapshot(backup.archive, archive)
    || !sameSnapshot(backup.manifest, manifest)
    || !sameSnapshot(backup.receipt, receipt)
  ) throw offsiteError("backup_tampered");
}

function storageMetadata(input: {
  readonly objectKind: string;
  readonly objectSha256: string;
  readonly manifestSha256: string;
  readonly backupIdSha256: string;
}): Readonly<Record<string, string>> {
  return Object.freeze({
    contract: STORAGE_CONTRACT,
    objectKind: input.objectKind,
    sha256: input.objectSha256,
    manifestSha256: input.manifestSha256,
    backupIdSha256: input.backupIdSha256,
  });
}

function cacheControlMatches(actual: string, expected: string): boolean {
  const normalized = actual.trim().toLowerCase();
  return normalized === expected || normalized === `max-age=${expected}`;
}

function exactMetadataSubset(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function sameObjectInfo(
  left: PostgresLogicalOffsiteObjectInfo,
  right: PostgresLogicalOffsiteObjectInfo,
): boolean {
  return left.bytes === right.bytes
    && left.contentType === right.contentType
    && left.cacheControl === right.cacheControl
    && left.storageObjectId === right.storageObjectId
    && left.storageVersion === right.storageVersion
    && canonicalPostgresBackupJson(left.metadata)
      === canonicalPostgresBackupJson(right.metadata);
}

interface VerifiedRemoteObject {
  readonly info: PostgresLogicalOffsiteObjectInfo;
  readonly download: PostgresLogicalOffsiteDownload;
}

async function verifyRemoteObject(input: {
  readonly storage: PostgresLogicalOffsiteStorage;
  readonly upload: PostgresLogicalOffsiteUpload;
  readonly expectedSha256: string;
  readonly retainBytes: boolean;
}): Promise<VerifiedRemoteObject> {
  let beforeInfo: PostgresLogicalOffsiteObjectInfo | null;
  let afterInfo: PostgresLogicalOffsiteObjectInfo | null;
  let downloaded: PostgresLogicalOffsiteDownload;
  try {
    beforeInfo = await input.storage.objectInfo(
      input.upload.bucketName,
      input.upload.objectPath,
    );
    downloaded = await input.storage.downloadVerified({
      bucketName: input.upload.bucketName,
      objectPath: input.upload.objectPath,
      maximumBytes: input.upload.expectedBytes,
      retainBytes: input.retainBytes,
    });
    afterInfo = await input.storage.objectInfo(
      input.upload.bucketName,
      input.upload.objectPath,
    );
  } catch {
    throw offsiteError("object_verification_failed");
  }
  if (
    !beforeInfo
    || !afterInfo
    || !sameObjectInfo(beforeInfo, afterInfo)
    || afterInfo.bytes !== input.upload.expectedBytes
    || downloaded.bytes !== input.upload.expectedBytes
    || downloaded.sha256 !== input.expectedSha256
    || afterInfo.contentType.toLowerCase() !== input.upload.contentType
    || !cacheControlMatches(afterInfo.cacheControl, input.upload.cacheControl)
    || !exactMetadataSubset(afterInfo.metadata, input.upload.metadata)
  ) throw offsiteError("object_verification_failed");
  return { info: afterInfo, download: downloaded };
}

async function inspectExistingMutableObject(input: {
  readonly storage: PostgresLogicalOffsiteStorage;
  readonly upload: PostgresLogicalOffsiteUpload;
  readonly expectedSha256: string;
}): Promise<VerifiedRemoteObject | null> {
  let beforeInfo: PostgresLogicalOffsiteObjectInfo | null;
  let afterInfo: PostgresLogicalOffsiteObjectInfo | null;
  let downloaded: PostgresLogicalOffsiteDownload;
  try {
    beforeInfo = await input.storage.objectInfo(
      input.upload.bucketName,
      input.upload.objectPath,
    );
    if (!beforeInfo) return null;
    downloaded = await input.storage.downloadVerified({
      bucketName: input.upload.bucketName,
      objectPath: input.upload.objectPath,
      maximumBytes: MAX_REMOTE_JSON_BYTES,
      retainBytes: true,
    });
    afterInfo = await input.storage.objectInfo(
      input.upload.bucketName,
      input.upload.objectPath,
    );
  } catch {
    throw offsiteError("object_verification_failed");
  }
  if (
    !afterInfo
    || !sameObjectInfo(beforeInfo, afterInfo)
    || !downloaded.retainedBytes
    || downloaded.bytes !== afterInfo.bytes
    || downloaded.retainedBytes.length !== downloaded.bytes
  ) throw offsiteError("object_verification_failed");

  const exact = afterInfo.bytes === input.upload.expectedBytes
    && downloaded.sha256 === input.expectedSha256
    && afterInfo.contentType.toLowerCase() === input.upload.contentType
    && cacheControlMatches(afterInfo.cacheControl, input.upload.cacheControl)
    && exactMetadataSubset(afterInfo.metadata, input.upload.metadata);
  if (exact) return { info: afterInfo, download: downloaded };

  // A mutable pointer may legitimately describe an older backup, but it must
  // still be canonical and internally valid before this process replaces it.
  // An unreadable or malformed pointer is an uncertainty, not authorization
  // to overwrite recovery evidence.
  parseLatestPointer(downloaded.retainedBytes);
  return null;
}

async function ensureImmutableObject(input: {
  readonly storage: PostgresLogicalOffsiteStorage;
  readonly upload: PostgresLogicalOffsiteUpload;
  readonly expectedSha256: string;
  readonly retainBytes: boolean;
  readonly onCreated?: ((objectPath: string) => void) | undefined;
}): Promise<{ readonly created: boolean } & VerifiedRemoteObject> {
  let existing: PostgresLogicalOffsiteObjectInfo | null;
  try {
    existing = await input.storage.objectInfo(input.upload.bucketName, input.upload.objectPath);
  } catch {
    throw offsiteError("destination_unreachable");
  }
  let created = false;
  if (!existing) {
    try {
      await input.storage.uploadImmutable(input.upload);
      created = true;
      input.onCreated?.(input.upload.objectPath);
    } catch {
      try {
        existing = await input.storage.objectInfo(
          input.upload.bucketName,
          input.upload.objectPath,
        );
      } catch {
        throw offsiteError("object_upload_failed");
      }
      if (!existing) throw offsiteError("object_upload_failed");
    }
  }
  return { created, ...await verifyRemoteObject(input) };
}

function descriptor(
  kind: RemoteObjectKind,
  upload: PostgresLogicalOffsiteUpload,
  expectedSha256: string,
  storageObjectId: string,
  storageVersion: string,
): RemoteObjectDescriptor {
  return {
    kind,
    objectPathSha256: sha256(upload.objectPath),
    bytes: String(upload.expectedBytes),
    sha256: expectedSha256,
    contentType: upload.contentType,
    metadataSha256: canonicalSha256(upload.metadata),
    storageObjectIdSha256: sha256(storageObjectId),
    storageVersionSha256: sha256(storageVersion),
  };
}

function parseDescriptor(value: unknown, expectedKind: RemoteObjectKind): RemoteObjectDescriptor {
  if (
    !isPlainObject(value)
    || !exactKeys(value, [
      "kind", "objectPathSha256", "bytes", "sha256", "contentType", "metadataSha256",
      "storageObjectIdSha256", "storageVersionSha256",
    ])
    || value.kind !== expectedKind
    || !isSha256(value.objectPathSha256)
    || typeof value.bytes !== "string"
    || !/^[1-9]\d{0,13}$/.test(value.bytes)
    || BigInt(value.bytes) > MAX_ARCHIVE_BYTES
    || !isSha256(value.sha256)
    || !["application/octet-stream", "application/json"].includes(
      typeof value.contentType === "string" ? value.contentType : "",
    )
    || !isSha256(value.metadataSha256)
    || !isSha256(value.storageObjectIdSha256)
    || !isSha256(value.storageVersionSha256)
  ) throw offsiteError("object_verification_failed");
  return value as unknown as RemoteObjectDescriptor;
}

function parseCanonicalJson(bytes: Buffer): unknown {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw offsiteError("object_verification_failed");
  }
  if (canonicalPostgresBackupJson(value) !== text) {
    throw offsiteError("object_verification_failed");
  }
  return value;
}

function parseAttestation(bytes: Buffer): PostgresLogicalOffsiteAttestation {
  const value = parseCanonicalJson(bytes);
  if (
    !isPlainObject(value)
    || !exactKeysWithOptionalSha256(value, [
      "kind", "version", "backupId", "backupIdSha256", "backupCreatedAt",
      "verifiedAt", "manifestSha256", "archiveSha256", "stateReceiptSha256",
      "manifestBindingSha256", "sourceDatabaseIdentitySha256", "overallStateSha256",
      "destinationOriginSha256",
      "bucketNameSha256", "operatorIdSha256", "objects", "remoteObjectSetSha256",
    ], "runtimeConnectionUrlSha256")
    || value.kind !== ATTESTATION_KIND
    || value.version !== CONTRACT_VERSION
    || typeof value.backupId !== "string"
    || !BACKUP_ID_PATTERN.test(value.backupId)
    || !isSha256(value.backupIdSha256)
    || sha256(value.backupId) !== value.backupIdSha256
    || !isCanonicalTimestamp(value.backupCreatedAt)
    || !isCanonicalTimestamp(value.verifiedAt)
    || value.verifiedAt < value.backupCreatedAt
    || ![
      value.manifestSha256, value.archiveSha256, value.stateReceiptSha256,
      value.manifestBindingSha256, value.sourceDatabaseIdentitySha256,
      value.overallStateSha256,
      value.destinationOriginSha256, value.bucketNameSha256,
      value.operatorIdSha256, value.remoteObjectSetSha256,
    ].every(isSha256)
    || !Array.isArray(value.objects)
    || value.objects.length !== 3
  ) throw offsiteError("object_verification_failed");
  const objects = [
    parseDescriptor(value.objects[0], "archive"),
    parseDescriptor(value.objects[1], "manifest"),
    parseDescriptor(value.objects[2], "state-receipt"),
  ] as const;
  if (canonicalSha256(objects) !== value.remoteObjectSetSha256) {
    throw offsiteError("object_verification_failed");
  }
  return { ...(value as unknown as PostgresLogicalOffsiteAttestation), objects };
}

function parseLatestPointer(bytes: Buffer): PostgresLogicalOffsiteLatestPointer {
  const value = parseCanonicalJson(bytes);
  if (
    !isPlainObject(value)
    || !exactKeysWithOptionalSha256(value, [
      "kind", "version", "backupId", "backupIdSha256", "attestationId",
      "backupCreatedAt", "completedAt", "manifestSha256", "archiveSha256",
      "stateReceiptSha256", "manifestBindingSha256", "sourceDatabaseIdentitySha256",
      "overallStateSha256",
      "remoteObjectSetSha256", "attestationSha256",
      "attestationStorageObjectIdSha256", "attestationStorageVersionSha256",
      "destinationOriginSha256",
      "bucketNameSha256", "operatorIdSha256",
    ], "runtimeConnectionUrlSha256")
    || value.kind !== LATEST_KIND
    || value.version !== CONTRACT_VERSION
    || typeof value.backupId !== "string"
    || !BACKUP_ID_PATTERN.test(value.backupId)
    || !isSha256(value.backupIdSha256)
    || sha256(value.backupId) !== value.backupIdSha256
    || typeof value.attestationId !== "string"
    || !ATTESTATION_ID_PATTERN.test(value.attestationId)
    || !isCanonicalTimestamp(value.backupCreatedAt)
    || !isCanonicalTimestamp(value.completedAt)
    || value.completedAt < value.backupCreatedAt
    || ![
      value.manifestSha256, value.archiveSha256, value.stateReceiptSha256,
      value.manifestBindingSha256, value.sourceDatabaseIdentitySha256,
      value.overallStateSha256,
      value.remoteObjectSetSha256, value.attestationSha256,
      value.attestationStorageObjectIdSha256,
      value.attestationStorageVersionSha256,
      value.destinationOriginSha256, value.bucketNameSha256,
      value.operatorIdSha256,
    ].every(isSha256)
  ) throw offsiteError("object_verification_failed");
  return value as unknown as PostgresLogicalOffsiteLatestPointer;
}

export function parsePostgresLogicalBackupSuccessState(
  value: unknown,
): PostgresLogicalBackupSuccessState {
  if (
    !isPlainObject(value)
    || !exactKeysWithOptionalSha256(value, [
      "kind", "version", "backupCreatedAt", "completedAt", "archiveSha256",
      "manifestSha256", "stateReceiptSha256", "manifestBindingSha256",
      "sourceDatabaseIdentitySha256", "overallStateSha256", "remoteObjectSetSha256",
      "attestationSha256", "attestationStorageObjectIdSha256",
      "attestationStorageVersionSha256", "latestPointerSha256",
      "latestPointerStorageObjectIdSha256", "latestPointerStorageVersionSha256",
      "backupIdSha256", "destinationOriginSha256",
      "bucketNameSha256", "operatorIdSha256",
    ], "runtimeConnectionUrlSha256")
    || value.kind !== SUCCESS_KIND
    || value.version !== CONTRACT_VERSION
    || !isCanonicalTimestamp(value.backupCreatedAt)
    || !isCanonicalTimestamp(value.completedAt)
    || value.completedAt < value.backupCreatedAt
    || ![
      value.archiveSha256, value.manifestSha256, value.stateReceiptSha256,
      value.manifestBindingSha256, value.sourceDatabaseIdentitySha256,
      value.overallStateSha256,
      value.remoteObjectSetSha256, value.attestationSha256,
      value.attestationStorageObjectIdSha256,
      value.attestationStorageVersionSha256,
      value.latestPointerSha256, value.latestPointerStorageObjectIdSha256,
      value.latestPointerStorageVersionSha256,
      value.backupIdSha256,
      value.destinationOriginSha256, value.bucketNameSha256,
      value.operatorIdSha256,
    ].every(isSha256)
  ) throw offsiteError("state_write_failed");
  return value as unknown as PostgresLogicalBackupSuccessState;
}

function stateMatchesPointer(
  state: PostgresLogicalBackupSuccessState,
  pointer: PostgresLogicalOffsiteLatestPointer,
): boolean {
  return state.backupCreatedAt === pointer.backupCreatedAt
    && state.completedAt === pointer.completedAt
    && state.archiveSha256 === pointer.archiveSha256
    && state.manifestSha256 === pointer.manifestSha256
    && state.stateReceiptSha256 === pointer.stateReceiptSha256
    && state.manifestBindingSha256 === pointer.manifestBindingSha256
    && state.sourceDatabaseIdentitySha256 === pointer.sourceDatabaseIdentitySha256
    && state.runtimeConnectionUrlSha256 === pointer.runtimeConnectionUrlSha256
    && state.overallStateSha256 === pointer.overallStateSha256
    && state.remoteObjectSetSha256 === pointer.remoteObjectSetSha256
    && state.attestationSha256 === pointer.attestationSha256
    && state.attestationStorageObjectIdSha256
      === pointer.attestationStorageObjectIdSha256
    && state.attestationStorageVersionSha256
      === pointer.attestationStorageVersionSha256
    && state.backupIdSha256 === pointer.backupIdSha256
    && state.destinationOriginSha256 === pointer.destinationOriginSha256
    && state.bucketNameSha256 === pointer.bucketNameSha256
    && state.operatorIdSha256 === pointer.operatorIdSha256;
}

function stateRecordValue(state: PostgresLogicalBackupSuccessState): Record<string, unknown> {
  return { ...state };
}

function assertNoStateRegression(
  existing: SystemStateRecord<Record<string, unknown>> | null,
  incomingBackupCreatedAt: string,
  incomingManifestSha256: string,
): void {
  if (!existing) return;
  let parsed: PostgresLogicalBackupSuccessState;
  try {
    parsed = parsePostgresLogicalBackupSuccessState(existing.value);
  } catch {
    // A migrated legacy SQLite timestamp-only record is intentionally replaced
    // by the first verified Postgres logical-backup attestation.
    return;
  }
  if (
    parsed.backupCreatedAt > incomingBackupCreatedAt
    || (
      parsed.backupCreatedAt === incomingBackupCreatedAt
      && parsed.manifestSha256 !== incomingManifestSha256
    )
  ) throw offsiteError("state_regression");
}

async function assertLeaseRemaining(input: {
  readonly state: PostgresLogicalOffsiteStateAuthority;
  readonly owner: string;
  readonly leaseToken: string;
  readonly now: string;
  readonly minimumRemainingMs: number;
}): Promise<void> {
  const lease = await input.state.get(POSTGRES_LOGICAL_OFFSITE_LEASE_KEY);
  const value = lease?.value;
  if (
    !value
    || value.owner !== input.owner
    || value.leaseToken !== input.leaseToken
    || typeof value.leaseUntil !== "string"
    || !isCanonicalTimestamp(value.leaseUntil)
    || Date.parse(value.leaseUntil) - Date.parse(input.now) < input.minimumRemainingMs
  ) throw offsiteError("lease_lost");
}

async function inspectDestinationBucket(
  storage: PostgresLogicalOffsiteStorage,
  bucketName: string,
  requiredObjectBytes = 0,
): Promise<void> {
  let bucket: PostgresLogicalOffsiteBucketInfo;
  try {
    bucket = await storage.inspectBucket(bucketName);
  } catch {
    throw offsiteError("destination_unreachable");
  }
  if (!bucket.private) throw offsiteError("bucket_not_private");
  if (bucket.fileSizeLimit !== null && bucket.fileSizeLimit < requiredObjectBytes) {
    throw offsiteError("bucket_policy_incompatible");
  }
  if (bucket.allowedMimeTypes) {
    const allowed = new Set(bucket.allowedMimeTypes.map((entry) => entry.toLowerCase()));
    const permits = (contentType: string): boolean => allowed.has(contentType)
      || allowed.has("*/*")
      || allowed.has(`${contentType.split("/", 1)[0]}/*`);
    if (!permits("application/json") || !permits("application/octet-stream")) {
      throw offsiteError("bucket_policy_incompatible");
    }
  }
}

function isExactCleanupObjectPath(objectPath: string): boolean {
  if (/[%\\\u0000-\u001f\u007f]/.test(objectPath)) return false;
  const parts = objectPath.split("/");
  if (
    parts.length !== 6
    || parts[0] !== "_control"
    || parts[1] !== "postgres-logical-backups"
    || parts[2] !== "v2"
    || !BACKUP_ID_PATTERN.test(parts[4]!)
  ) return false;
  if (parts[3] === "backups") {
    return [
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ].includes(parts[5] as typeof POSTGRES_LOGICAL_BACKUP_ARCHIVE);
  }
  return parts[3] === "attestations"
    && parts[5]!.endsWith(".json")
    && ATTESTATION_ID_PATTERN.test(parts[5]!.slice(0, -".json".length));
}

export function createPostgresLogicalOffsiteStateAuthority(
  repository: SystemStateRepository,
): PostgresLogicalOffsiteStateAuthority {
  return {
    get: (key) => repository.get<Record<string, unknown>>(key),
    compareAndSet: (key, expectedRevision, value, now) => (
      repository.compareAndSet(key, expectedRevision, value, now)
    ),
    acquireLease: (input) => repository.acquireLease(input),
    releaseLease: (input) => repository.releaseLease(input),
  };
}

export async function attestPostgresLogicalBackup(
  options: AttestPostgresLogicalBackupOptions,
): Promise<PostgresLogicalOffsiteResult> {
  const now = options.now ?? (() => new Date());
  const randomUuid = options.randomUuid ?? crypto.randomUUID;
  const expectedManifestSha256 = assertSha256(options.expectedManifestSha256);
  const runtimeDatabaseIdentitySha256 = assertSha256(
    options.runtimeDatabaseIdentitySha256,
  );
  const runtimeConnectionUrlSha256 = assertSha256(
    options.runtimeConnectionUrlSha256,
  );
  const expectedDestinationOriginSha256 = assertSha256(
    options.expectedDestinationOriginSha256,
  );
  const expectedBucketNameSha256 = assertSha256(options.expectedBucketNameSha256);
  const bucketName = assertBucketName(options.bucketName);
  const operatorId = assertOperatorId(options.operatorId);
  const sourceOrigin = canonicalOrigin(options.sourceSupabaseUrl);
  const destinationOrigin = canonicalOrigin(options.destinationSupabaseUrl);
  if (sourceOrigin === destinationOrigin) throw offsiteError("destination_unsafe");
  if (canonicalOrigin(options.storage.destinationOrigin) !== destinationOrigin) {
    throw offsiteError("destination_unsafe");
  }
  const destinationOriginSha256 = sha256(destinationOrigin);
  const bucketNameSha256 = sha256(bucketName);
  assertPostgresLogicalOffsiteDestinationPins({
    destinationSupabaseUrl: options.destinationSupabaseUrl,
    bucketName,
    expectedDestinationOriginSha256,
    expectedBucketNameSha256,
  });
  if (
    destinationOriginSha256 !== expectedDestinationOriginSha256
    || bucketNameSha256 !== expectedBucketNameSha256
  ) throw offsiteError("destination_unsafe");
  const operatorIdSha256 = sha256(operatorId);
  const backup = await validateLocalBackup(
    options.backupDirectory,
    expectedManifestSha256,
  );
  if (
    runtimeDatabaseIdentitySha256
    !== backup.parsedManifest.state.sourceDatabaseIdentitySha256
  ) throw offsiteError("runtime_identity_mismatch");
  await inspectDestinationBucket(options.storage, bucketName, Number(backup.archive.size));

  const startedAt = canonicalNow(now);
  if (backup.parsedManifest.createdAt > startedAt) {
    throw offsiteError("backup_manifest_invalid");
  }
  const leaseUntil = new Date(Date.parse(startedAt) + LEASE_DURATION_MS).toISOString();
  const owner = `logical-offsite:${operatorIdSha256.slice(0, 32)}`;
  const leaseToken = randomUuid();
  if (!/^[0-9a-f-]{36}$/i.test(leaseToken)) throw offsiteError("invalid_arguments");
  const lease = await options.state.acquireLease({
    key: POSTGRES_LOGICAL_OFFSITE_LEASE_KEY,
    owner,
    leaseToken,
    now: startedAt,
    leaseUntil,
  });
  if (!lease) throw offsiteError("lease_unavailable");

  const id = backupId(backup.parsedManifest, backup.manifest.sha256);
  const backupIdSha256 = sha256(id);
  const createdPaths: string[] = [];
  let pointerMutationAttempted = false;
  try {
    const currentState = await options.state.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY);
    assertNoStateRegression(
      currentState,
      backup.parsedManifest.createdAt,
      backup.manifest.sha256,
    );
    const commonMetadata = {
      manifestSha256: backup.manifest.sha256,
      backupIdSha256,
    };
    const archiveUpload: PostgresLogicalOffsiteUpload = {
      bucketName,
      objectPath: objectPathForBackup(id, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
      filePath: backup.archivePath,
      expectedBytes: Number(backup.archive.size),
      contentType: "application/octet-stream",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      metadata: storageMetadata({
        ...commonMetadata,
        objectKind: "postgres-logical-archive",
        objectSha256: backup.archive.sha256,
      }),
    };
    const manifestUpload: PostgresLogicalOffsiteUpload = {
      bucketName,
      objectPath: objectPathForBackup(id, POSTGRES_LOGICAL_BACKUP_MANIFEST),
      bytes: backup.manifest.bytes,
      expectedBytes: Number(backup.manifest.size),
      contentType: "application/json",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      metadata: storageMetadata({
        ...commonMetadata,
        objectKind: "postgres-logical-manifest",
        objectSha256: backup.manifest.sha256,
      }),
    };
    const receiptUpload: PostgresLogicalOffsiteUpload = {
      bucketName,
      objectPath: objectPathForBackup(id, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT),
      bytes: backup.receipt.bytes,
      expectedBytes: Number(backup.receipt.size),
      contentType: "application/json",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      metadata: storageMetadata({
        ...commonMetadata,
        objectKind: "postgres-logical-state-receipt",
        objectSha256: backup.receipt.sha256,
      }),
    };
    const uploads = [archiveUpload, manifestUpload, receiptUpload] as const;
    const hashes = [
      backup.archive.sha256,
      backup.manifest.sha256,
      backup.receipt.sha256,
    ] as const;
    const kinds = ["archive", "manifest", "state-receipt"] as const;
    const verifiedObjects: VerifiedRemoteObject[] = [];
    for (let index = 0; index < uploads.length; index += 1) {
      await assertLeaseRemaining({
        state: options.state,
        owner,
        leaseToken,
        now: canonicalNow(now),
        minimumRemainingMs: MINIMUM_POINTER_LEASE_REMAINING_MS,
      });
      const result = await ensureImmutableObject({
        storage: options.storage,
        upload: uploads[index]!,
        expectedSha256: hashes[index]!,
        retainBytes: false,
        onCreated: (objectPath) => createdPaths.push(objectPath),
      });
      verifiedObjects.push(result);
    }
    await assertLocalBackupUnchanged(backup);

    const objects = uploads.map((upload, index) => (
      descriptor(
        kinds[index]!,
        upload,
        hashes[index]!,
        verifiedObjects[index]!.info.storageObjectId,
        verifiedObjects[index]!.info.storageVersion,
      )
    )) as [RemoteObjectDescriptor, RemoteObjectDescriptor, RemoteObjectDescriptor];
    const remoteObjectSetSha256 = canonicalSha256(objects);
    const completedAt = canonicalNow(now);
    await assertLeaseRemaining({
      state: options.state,
      owner,
      leaseToken,
      now: completedAt,
      minimumRemainingMs: MINIMUM_POINTER_LEASE_REMAINING_MS,
    });
    const attestation: PostgresLogicalOffsiteAttestation = {
      kind: ATTESTATION_KIND,
      version: CONTRACT_VERSION,
      backupId: id,
      backupIdSha256,
      backupCreatedAt: backup.parsedManifest.createdAt,
      verifiedAt: completedAt,
      manifestSha256: backup.manifest.sha256,
      archiveSha256: backup.archive.sha256,
      stateReceiptSha256: backup.receipt.sha256,
      manifestBindingSha256: backup.parsedManifest.state.manifestBindingSha256,
      sourceDatabaseIdentitySha256:
        backup.parsedManifest.state.sourceDatabaseIdentitySha256,
      runtimeConnectionUrlSha256,
      overallStateSha256: backup.parsedManifest.state.overallStateSha256,
      destinationOriginSha256,
      bucketNameSha256,
      operatorIdSha256,
      objects,
      remoteObjectSetSha256,
    };
    const attestationBytes = Buffer.from(canonicalPostgresBackupJson(attestation), "utf8");
    const attestationSha256 = sha256(attestationBytes);
    const attestationId = `${compactTimestamp(completedAt)}-${attestationSha256}`;
    if (!ATTESTATION_ID_PATTERN.test(attestationId)) throw offsiteError("invalid_arguments");
    const attestationUpload: PostgresLogicalOffsiteUpload = {
      bucketName,
      objectPath: attestationPath(id, attestationId),
      bytes: attestationBytes,
      expectedBytes: attestationBytes.length,
      contentType: "application/json",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      metadata: storageMetadata({
        ...commonMetadata,
        objectKind: "postgres-logical-offsite-attestation",
        objectSha256: attestationSha256,
      }),
    };
    const attestationResult = await ensureImmutableObject({
      storage: options.storage,
      upload: attestationUpload,
      expectedSha256: attestationSha256,
      retainBytes: true,
      onCreated: (objectPath) => createdPaths.push(objectPath),
    });
    if (
      !attestationResult.download.retainedBytes
      || canonicalPostgresBackupJson(parseAttestation(
        attestationResult.download.retainedBytes,
      )) !== attestationBytes.toString("utf8")
    ) throw offsiteError("object_verification_failed");
    const attestationStorageObjectIdSha256 = sha256(
      attestationResult.info.storageObjectId,
    );
    const attestationStorageVersionSha256 = sha256(attestationResult.info.storageVersion);

    const pointer: PostgresLogicalOffsiteLatestPointer = {
      kind: LATEST_KIND,
      version: CONTRACT_VERSION,
      backupId: id,
      backupIdSha256,
      attestationId,
      backupCreatedAt: backup.parsedManifest.createdAt,
      completedAt,
      manifestSha256: backup.manifest.sha256,
      archiveSha256: backup.archive.sha256,
      stateReceiptSha256: backup.receipt.sha256,
      manifestBindingSha256: backup.parsedManifest.state.manifestBindingSha256,
      sourceDatabaseIdentitySha256:
        backup.parsedManifest.state.sourceDatabaseIdentitySha256,
      runtimeConnectionUrlSha256,
      overallStateSha256: backup.parsedManifest.state.overallStateSha256,
      remoteObjectSetSha256,
      attestationSha256,
      attestationStorageObjectIdSha256,
      attestationStorageVersionSha256,
      destinationOriginSha256,
      bucketNameSha256,
      operatorIdSha256,
    };
    const pointerBytes = Buffer.from(canonicalPostgresBackupJson(pointer), "utf8");
    const latestPointerSha256 = sha256(pointerBytes);
    const pointerUpload: PostgresLogicalOffsiteUpload = {
      bucketName,
      objectPath: POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT,
      bytes: pointerBytes,
      expectedBytes: pointerBytes.length,
      contentType: "application/json",
      cacheControl: MUTABLE_CACHE_CONTROL,
      metadata: storageMetadata({
        ...commonMetadata,
        objectKind: "postgres-logical-offsite-latest",
        objectSha256: latestPointerSha256,
      }),
    };
    await assertLeaseRemaining({
      state: options.state,
      owner,
      leaseToken,
      now: canonicalNow(now),
      minimumRemainingMs: MINIMUM_POINTER_LEASE_REMAINING_MS,
    });
    const existingPointer = await inspectExistingMutableObject({
      storage: options.storage,
      upload: pointerUpload,
      expectedSha256: latestPointerSha256,
    });
    let pointerResult: VerifiedRemoteObject;
    if (existingPointer) {
      pointerResult = existingPointer;
    } else {
      try {
        // A transport error can arrive after Storage has committed the mutable
        // pointer. Once mutation starts, immutable evidence must never be
        // cleaned up because latest.json may already reference it.
        pointerMutationAttempted = true;
        await options.storage.replaceMutable(pointerUpload);
      } catch {
        throw offsiteError("object_upload_failed");
      }
      pointerResult = await verifyRemoteObject({
        storage: options.storage,
        upload: pointerUpload,
        expectedSha256: latestPointerSha256,
        retainBytes: true,
      });
    }
    if (
      !pointerResult.download.retainedBytes
      || canonicalPostgresBackupJson(parseLatestPointer(
        pointerResult.download.retainedBytes,
      ))
        !== pointerBytes.toString("utf8")
    ) throw offsiteError("object_verification_failed");
    const latestPointerStorageObjectIdSha256 = sha256(
      pointerResult.info.storageObjectId,
    );
    const latestPointerStorageVersionSha256 = sha256(pointerResult.info.storageVersion);

    const successState: PostgresLogicalBackupSuccessState = {
      kind: SUCCESS_KIND,
      version: CONTRACT_VERSION,
      backupCreatedAt: backup.parsedManifest.createdAt,
      completedAt,
      archiveSha256: backup.archive.sha256,
      manifestSha256: backup.manifest.sha256,
      stateReceiptSha256: backup.receipt.sha256,
      manifestBindingSha256: backup.parsedManifest.state.manifestBindingSha256,
      sourceDatabaseIdentitySha256:
        backup.parsedManifest.state.sourceDatabaseIdentitySha256,
      runtimeConnectionUrlSha256,
      overallStateSha256: backup.parsedManifest.state.overallStateSha256,
      remoteObjectSetSha256,
      attestationSha256,
      attestationStorageObjectIdSha256,
      attestationStorageVersionSha256,
      latestPointerSha256,
      latestPointerStorageObjectIdSha256,
      latestPointerStorageVersionSha256,
      backupIdSha256,
      destinationOriginSha256,
      bucketNameSha256,
      operatorIdSha256,
    };
    const stateBeforeWrite = await options.state.get(
      POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY,
    );
    assertNoStateRegression(
      stateBeforeWrite,
      successState.backupCreatedAt,
      successState.manifestSha256,
    );
    await assertLeaseRemaining({
      state: options.state,
      owner,
      leaseToken,
      now: canonicalNow(now),
      minimumRemainingMs: MINIMUM_POINTER_LEASE_REMAINING_MS,
    });
    const persisted = await options.state.compareAndSet(
      POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY,
      stateBeforeWrite?.revision ?? null,
      stateRecordValue(successState),
      completedAt,
    );
    if (!persisted) throw offsiteError("state_write_failed");
    const parsedPersisted = parsePostgresLogicalBackupSuccessState(persisted.value);
    if (canonicalPostgresBackupJson(parsedPersisted) !== canonicalPostgresBackupJson(successState)) {
      throw offsiteError("state_write_failed");
    }
    return {
      schemaVersion: 1,
      ok: true,
      backupCreatedAt: successState.backupCreatedAt,
      completedAt: successState.completedAt,
      archiveSha256: successState.archiveSha256,
      manifestSha256: successState.manifestSha256,
      stateReceiptSha256: successState.stateReceiptSha256,
      overallStateSha256: successState.overallStateSha256,
      sourceDatabaseIdentitySha256: successState.sourceDatabaseIdentitySha256,
      remoteObjectSetSha256: successState.remoteObjectSetSha256,
      attestationSha256: successState.attestationSha256,
      latestPointerSha256: successState.latestPointerSha256,
      backupIdSha256: successState.backupIdSha256,
      successStateSha256: sha256(canonicalPostgresBackupJson(successState)),
    };
  } catch (error) {
    if (!pointerMutationAttempted && createdPaths.length > 0) {
      try {
        await options.storage.removeExact(bucketName, [...createdPaths].reverse());
      } catch {
        throw offsiteError("cleanup_failed");
      }
    }
    if (error instanceof PostgresLogicalOffsiteError) throw error;
    throw offsiteError("object_verification_failed");
  } finally {
    await options.state.releaseLease({
      key: POSTGRES_LOGICAL_OFFSITE_LEASE_KEY,
      owner,
      leaseToken,
      now: canonicalNow(now),
    }).catch(() => null);
  }
}

function remoteReadinessFailure(input: {
  readonly state: PostgresLogicalBackupSuccessState | null;
  readonly now: Date;
  readonly liveProbe: boolean;
  readonly error: NonNullable<PostgresLogicalOffsiteReadiness["error"]>;
  readonly status?: "failed" | "required_unconfigured";
}): PostgresLogicalOffsiteReadiness {
  const backupCreatedAtMs = input.state
    ? Date.parse(input.state.backupCreatedAt)
    : Number.NaN;
  return {
    status: input.status ?? "failed",
    required: true,
    liveProbe: input.liveProbe,
    lastSuccessfulAt: input.state?.backupCreatedAt ?? null,
    ageHours: Number.isFinite(backupCreatedAtMs)
      ? (input.now.valueOf() - backupCreatedAtMs) / (60 * 60 * 1000)
      : null,
    error: input.error,
  };
}

async function verifyReadinessObjectInfo(input: {
  readonly storage: PostgresLogicalOffsiteStorage;
  readonly bucketName: string;
  readonly objectPath: string;
  readonly descriptor: RemoteObjectDescriptor;
  readonly metadata: Readonly<Record<string, string>>;
}): Promise<PostgresLogicalOffsiteObjectInfo | null> {
  const info = await input.storage.objectInfo(input.bucketName, input.objectPath);
  if (
    !info
    || info.bytes !== Number(input.descriptor.bytes)
    || info.contentType.toLowerCase() !== input.descriptor.contentType
    || !cacheControlMatches(info.cacheControl, IMMUTABLE_CACHE_CONTROL)
    || !exactMetadataSubset(info.metadata, input.metadata)
    || canonicalSha256(input.metadata) !== input.descriptor.metadataSha256
    || sha256(info.storageObjectId) !== input.descriptor.storageObjectIdSha256
    || sha256(info.storageVersion) !== input.descriptor.storageVersionSha256
  ) return null;
  return info;
}

export async function probePostgresLogicalOffsiteReadiness(input: {
  readonly stateValue: unknown;
  readonly runtimeDatabaseIdentitySha256: string;
  readonly sourceSupabaseUrl?: string | undefined;
  readonly destinationSupabaseUrl?: string | undefined;
  readonly destinationServiceRoleKey?: string | undefined;
  readonly bucketName: string;
  readonly maxFreshnessHours: number;
  readonly storage?: PostgresLogicalOffsiteStorage | undefined;
  readonly now?: Date | undefined;
  readonly requestTimeoutMs?: number | undefined;
}): Promise<PostgresLogicalOffsiteReadiness> {
  const now = input.now ?? new Date();
  let state: PostgresLogicalBackupSuccessState;
  try {
    if (!Number.isFinite(now.valueOf())) throw new Error("invalid now");
    state = parsePostgresLogicalBackupSuccessState(input.stateValue);
  } catch {
    return remoteReadinessFailure({
      state: null,
      now,
      liveProbe: false,
      error: "attestation_state_invalid",
    });
  }
  if (
    !isSha256(input.runtimeDatabaseIdentitySha256)
    || input.runtimeDatabaseIdentitySha256 !== state.sourceDatabaseIdentitySha256
  ) return remoteReadinessFailure({
    state,
    now,
    liveProbe: false,
    error: "runtime_database_binding_mismatch",
  });
  if (
    !input.sourceSupabaseUrl
    || !input.destinationSupabaseUrl
    || (!input.destinationServiceRoleKey && !input.storage)
  ) return remoteReadinessFailure({
    state,
    now,
    liveProbe: false,
    error: "destination_unconfigured",
    status: "required_unconfigured",
  });
  let sourceOrigin: string;
  let destinationOrigin: string;
  let bucketName: string;
  try {
    sourceOrigin = canonicalOrigin(input.sourceSupabaseUrl);
    destinationOrigin = canonicalOrigin(input.destinationSupabaseUrl);
    bucketName = assertBucketName(input.bucketName);
  } catch {
    return remoteReadinessFailure({
      state,
      now,
      liveProbe: false,
      error: "destination_unconfigured",
      status: "required_unconfigured",
    });
  }
  if (sourceOrigin === destinationOrigin) return remoteReadinessFailure({
    state,
    now,
    liveProbe: false,
    error: "destination_not_independent",
  });
  if (
    state.destinationOriginSha256 !== sha256(destinationOrigin)
    || state.bucketNameSha256 !== sha256(bucketName)
  ) return remoteReadinessFailure({
    state,
    now,
    liveProbe: false,
    error: "destination_binding_mismatch",
  });
  const ageHours = (now.valueOf() - Date.parse(state.backupCreatedAt))
    / (60 * 60 * 1000);
  if (
    !Number.isFinite(input.maxFreshnessHours)
    || input.maxFreshnessHours <= 0
    || ageHours < 0
    || ageHours > input.maxFreshnessHours
  ) return remoteReadinessFailure({
    state,
    now,
    liveProbe: false,
    error: "last_successful_backup_stale",
  });
  let storage: PostgresLogicalOffsiteStorage;
  try {
    storage = input.storage ?? createSupabasePostgresLogicalOffsiteStorage({
      destinationSupabaseUrl: input.destinationSupabaseUrl,
      destinationServiceRoleKey: input.destinationServiceRoleKey!,
      ...(input.requestTimeoutMs ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
    });
    if (canonicalOrigin(storage.destinationOrigin) !== destinationOrigin) {
      throw offsiteError("object_verification_failed");
    }
    await inspectDestinationBucket(storage, bucketName);
    const pointerInfo = await storage.objectInfo(
      bucketName,
      POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT,
    );
    if (!pointerInfo) throw offsiteError("object_verification_failed");
    const pointerDownload = await storage.downloadVerified({
      bucketName,
      objectPath: POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT,
      maximumBytes: MAX_REMOTE_JSON_BYTES,
      retainBytes: true,
    });
    const pointerInfoAfter = await storage.objectInfo(
      bucketName,
      POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT,
    );
    if (
      !pointerInfoAfter
      || !sameObjectInfo(pointerInfo, pointerInfoAfter)
      || !pointerDownload.retainedBytes
      || pointerDownload.sha256 !== state.latestPointerSha256
    ) throw offsiteError("object_verification_failed");
    const pointer = parseLatestPointer(pointerDownload.retainedBytes);
    if (!stateMatchesPointer(state, pointer)) throw offsiteError("object_verification_failed");
    const commonMetadata = {
      manifestSha256: state.manifestSha256,
      backupIdSha256: state.backupIdSha256,
    };
    const pointerMetadata = storageMetadata({
      ...commonMetadata,
      objectKind: "postgres-logical-offsite-latest",
      objectSha256: state.latestPointerSha256,
    });
    if (
      pointerInfoAfter.bytes !== pointerDownload.bytes
      || pointerInfoAfter.contentType.toLowerCase() !== "application/json"
      || !cacheControlMatches(pointerInfoAfter.cacheControl, MUTABLE_CACHE_CONTROL)
      || !exactMetadataSubset(pointerInfoAfter.metadata, pointerMetadata)
      || sha256(pointerInfoAfter.storageObjectId)
        !== state.latestPointerStorageObjectIdSha256
      || sha256(pointerInfoAfter.storageVersion)
        !== state.latestPointerStorageVersionSha256
    ) throw offsiteError("object_verification_failed");

    const immutableAttestationPath = attestationPath(
      pointer.backupId,
      pointer.attestationId,
    );
    const attestationInfo = await storage.objectInfo(bucketName, immutableAttestationPath);
    if (!attestationInfo) throw offsiteError("object_verification_failed");
    const attestationDownload = await storage.downloadVerified({
      bucketName,
      objectPath: immutableAttestationPath,
      maximumBytes: MAX_REMOTE_JSON_BYTES,
      retainBytes: true,
    });
    const attestationInfoAfter = await storage.objectInfo(
      bucketName,
      immutableAttestationPath,
    );
    if (
      !attestationInfoAfter
      || !sameObjectInfo(attestationInfo, attestationInfoAfter)
      || !attestationDownload.retainedBytes
      || attestationDownload.sha256 !== state.attestationSha256
    ) throw offsiteError("object_verification_failed");
    const attestation = parseAttestation(attestationDownload.retainedBytes);
    if (
      attestation.backupId !== pointer.backupId
      || attestation.backupIdSha256 !== state.backupIdSha256
      || attestation.backupCreatedAt !== state.backupCreatedAt
      || attestation.verifiedAt !== state.completedAt
      || attestation.archiveSha256 !== state.archiveSha256
      || attestation.manifestSha256 !== state.manifestSha256
      || attestation.stateReceiptSha256 !== state.stateReceiptSha256
      || attestation.manifestBindingSha256 !== state.manifestBindingSha256
      || attestation.sourceDatabaseIdentitySha256
        !== state.sourceDatabaseIdentitySha256
      || attestation.runtimeConnectionUrlSha256
        !== state.runtimeConnectionUrlSha256
      || attestation.overallStateSha256 !== state.overallStateSha256
      || attestation.remoteObjectSetSha256 !== state.remoteObjectSetSha256
      || attestation.destinationOriginSha256 !== state.destinationOriginSha256
      || attestation.bucketNameSha256 !== state.bucketNameSha256
      || attestation.operatorIdSha256 !== state.operatorIdSha256
    ) throw offsiteError("object_verification_failed");
    const attestationMetadata = storageMetadata({
      ...commonMetadata,
      objectKind: "postgres-logical-offsite-attestation",
      objectSha256: state.attestationSha256,
    });
    if (
      attestationInfoAfter.bytes !== attestationDownload.bytes
      || attestationInfoAfter.contentType.toLowerCase() !== "application/json"
      || !cacheControlMatches(attestationInfoAfter.cacheControl, IMMUTABLE_CACHE_CONTROL)
      || !exactMetadataSubset(attestationInfoAfter.metadata, attestationMetadata)
      || sha256(attestationInfoAfter.storageObjectId)
        !== state.attestationStorageObjectIdSha256
      || sha256(attestationInfoAfter.storageVersion)
        !== state.attestationStorageVersionSha256
    ) throw offsiteError("object_verification_failed");

    const filenames = [
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ] as const;
    const objectKinds = [
      "postgres-logical-archive",
      "postgres-logical-manifest",
      "postgres-logical-state-receipt",
    ] as const;
    let remoteManifestBytes: Buffer | undefined;
    let remoteReceiptBytes: Buffer | undefined;
    for (let index = 0; index < filenames.length; index += 1) {
      const expectedSha256 = [
        state.archiveSha256,
        state.manifestSha256,
        state.stateReceiptSha256,
      ][index]!;
      const metadata = storageMetadata({
        ...commonMetadata,
        objectKind: objectKinds[index]!,
        objectSha256: expectedSha256,
      });
      const objectPath = objectPathForBackup(pointer.backupId, filenames[index]!);
      const descriptor = attestation.objects[index]!;
      const objectInfo = await verifyReadinessObjectInfo({
        storage,
        bucketName,
        objectPath,
        descriptor,
        metadata,
      });
      if (
        sha256(objectPath) !== descriptor.objectPathSha256
        || descriptor.sha256 !== expectedSha256
        || !objectInfo
      ) throw offsiteError("object_verification_failed");
      if (index === 0) continue;
      const download = await storage.downloadVerified({
        bucketName,
        objectPath,
        maximumBytes: index === 1
          ? Number(MAX_MANIFEST_BYTES)
          : Number(MAX_STATE_RECEIPT_BYTES),
        retainBytes: true,
      });
      const objectInfoAfter = await storage.objectInfo(bucketName, objectPath);
      if (
        !objectInfoAfter
        || !sameObjectInfo(objectInfo, objectInfoAfter)
        || !download.retainedBytes
        || download.bytes !== Number(descriptor.bytes)
        || download.sha256 !== expectedSha256
      ) throw offsiteError("object_verification_failed");
      if (index === 1) remoteManifestBytes = download.retainedBytes;
      else remoteReceiptBytes = download.retainedBytes;
    }
    if (!remoteManifestBytes || !remoteReceiptBytes) {
      throw offsiteError("object_verification_failed");
    }
    try {
      const remoteManifest = parsePostgresLogicalBackupManifest(remoteManifestBytes);
      if (remoteManifest.schemaVersion !== 3) {
        throw offsiteError("object_verification_failed");
      }
      const remoteReceipt = parsePostgresLogicalSourceStateReceipt(remoteReceiptBytes);
      assertPostgresLogicalBackupStateReceiptBinding(remoteReceipt, remoteManifest);
      if (
        remoteManifest.createdAt !== state.backupCreatedAt
        || remoteManifest.archive.sha256 !== state.archiveSha256
        || remoteManifest.state.receiptSha256 !== state.stateReceiptSha256
        || remoteManifest.state.manifestBindingSha256 !== state.manifestBindingSha256
        || remoteManifest.state.sourceDatabaseIdentitySha256
          !== state.sourceDatabaseIdentitySha256
        || remoteManifest.state.overallStateSha256 !== state.overallStateSha256
      ) throw offsiteError("object_verification_failed");
    } catch {
      throw offsiteError("object_verification_failed");
    }
  } catch (error) {
    return remoteReadinessFailure({
      state,
      now,
      liveProbe: true,
      error: error instanceof PostgresLogicalOffsiteError
        && error.code === "object_verification_failed"
        ? "remote_attestation_mismatch"
        : "remote_attestation_unavailable",
    });
  }
  return {
    status: "ok",
    required: true,
    liveProbe: true,
    lastSuccessfulAt: state.backupCreatedAt,
    ageHours,
  };
}

function storageErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
  };
  for (const value of [candidate.statusCode, candidate.status]) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  }
  return null;
}

function normalizeRemoteMetadata(value: unknown): Readonly<Record<string, string>> {
  if (!isPlainObject(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && key.length <= 64 && entry.length <= 256) {
      result[key] = entry;
    }
  }
  return result;
}

function directTusEndpoint(destinationOrigin: string): string {
  const url = new URL(destinationOrigin);
  if (/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)) {
    url.hostname = url.hostname.replace(/\.supabase\.co$/, ".storage.supabase.co");
  }
  url.pathname = "/storage/v1/upload/resumable";
  return url.toString();
}

function createScopedStorageFetch(
  destinationOrigin: string,
  fetchImplementation: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const canonicalDestination = canonicalOrigin(destinationOrigin);
  const directTusOrigin = new URL(directTusEndpoint(canonicalDestination)).origin;
  const allowedOrigins = new Set([canonicalDestination, directTusOrigin]);
  return async (input, init) => {
    let requestUrl: URL;
    try {
      const rawUrl = typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url;
      requestUrl = new URL(rawUrl);
      if (
        requestUrl.protocol !== "https:"
        || !allowedOrigins.has(requestUrl.origin)
        || !requestUrl.pathname.startsWith("/storage/v1/")
        || requestUrl.username
        || requestUrl.password
        || requestUrl.hash
      ) throw new Error("outside storage authority");
    } catch {
      throw offsiteError("destination_unsafe");
    }
    return fetchImplementation(input, { ...init, redirect: "error" });
  };
}

function encodeTusMetadata(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key} ${Buffer.from(value, "utf8").toString("base64")}`)
    .join(",");
}

function isLegacyServiceRoleApiKey(value: string): boolean {
  const segments = value.split(".");
  if (
    segments.length !== 3
    || segments.some((segment) => !LEGACY_JWT_SEGMENT_PATTERN.test(segment))
  ) return false;
  try {
    const header: unknown = JSON.parse(
      Buffer.from(segments[0]!, "base64url").toString("utf8"),
    );
    const payload: unknown = JSON.parse(
      Buffer.from(segments[1]!, "base64url").toString("utf8"),
    );
    return isPlainObject(header)
      && header.alg === "HS256"
      && header.typ === "JWT"
      && isPlainObject(payload)
      && payload.role === "service_role";
  } catch {
    return false;
  }
}

function tusAuthenticationHeaders(
  serviceRoleKey: string,
): Readonly<Record<string, string>> {
  if (SECRET_API_KEY_PATTERN.test(serviceRoleKey)) {
    return { apikey: serviceRoleKey };
  }
  if (isLegacyServiceRoleApiKey(serviceRoleKey)) {
    return {
      authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    };
  }
  throw offsiteError("object_upload_failed");
}

class SupabasePostgresLogicalOffsiteStorage implements PostgresLogicalOffsiteStorage {
  private readonly client: SupabaseClient;
  private readonly boundedFetch: typeof globalThis.fetch;
  readonly destinationOrigin: string;

  constructor(
    destinationSupabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly requestTimeoutMs: number,
    clientFactory?: ((url: string, key: string) => SupabaseClient) | undefined,
    fetchImplementation?: typeof globalThis.fetch | undefined,
  ) {
    this.destinationOrigin = canonicalOrigin(destinationSupabaseUrl);
    if (
      !serviceRoleKey
      || serviceRoleKey.length > 64 * 1024
      || /[\u0000\r\n]/.test(serviceRoleKey)
    ) throw offsiteError("destination_unsafe");
    const scopedFetch = createScopedStorageFetch(
      this.destinationOrigin,
      fetchImplementation ?? globalThis.fetch,
    );
    this.boundedFetch = createBoundedSupabaseFetch({
      timeoutMs: requestTimeoutMs,
      fetchImplementation: scopedFetch,
    });
    this.client = clientFactory
      ? clientFactory(this.destinationOrigin, serviceRoleKey)
      : createServerSupabaseClient(this.destinationOrigin, serviceRoleKey, {
        timeoutMs: requestTimeoutMs,
        fetchImplementation: scopedFetch,
      });
  }

  async inspectBucket(bucketName: string): Promise<PostgresLogicalOffsiteBucketInfo> {
    const { data, error } = await this.client.storage.getBucket(bucketName);
    if (error || !data) throw offsiteError("destination_unreachable");
    const bucket = data as typeof data & {
      file_size_limit?: number | null;
      allowed_mime_types?: string[] | null;
    };
    return {
      private: bucket.public === false,
      fileSizeLimit: typeof bucket.file_size_limit === "number"
        ? bucket.file_size_limit
        : null,
      allowedMimeTypes: Array.isArray(bucket.allowed_mime_types)
        ? [...bucket.allowed_mime_types]
        : null,
    };
  }

  async objectInfo(
    bucketName: string,
    objectPath: string,
  ): Promise<PostgresLogicalOffsiteObjectInfo | null> {
    const { data, error } = await this.client.storage.from(bucketName).info(objectPath);
    if (error || !data) {
      if (storageErrorStatus(error) === 404) return null;
      throw offsiteError("destination_unreachable");
    }
    const raw = data as typeof data & {
      id?: unknown;
      version?: unknown;
      size?: unknown;
      contentType?: unknown;
      cacheControl?: unknown;
      metadata?: unknown;
    };
    if (
      typeof raw.size !== "number"
      || !Number.isSafeInteger(raw.size)
      || raw.size < 0
      || typeof raw.contentType !== "string"
      || typeof raw.cacheControl !== "string"
      || !isBoundedStorageToken(raw.id)
      || !isBoundedStorageToken(raw.version)
    ) throw offsiteError("object_verification_failed");
    return {
      bytes: raw.size,
      contentType: raw.contentType,
      cacheControl: raw.cacheControl,
      metadata: normalizeRemoteMetadata(raw.metadata),
      storageObjectId: raw.id,
      storageVersion: raw.version,
    };
  }

  async uploadImmutable(input: PostgresLogicalOffsiteUpload): Promise<void> {
    if (input.filePath) {
      await this.uploadTusFile(input);
      return;
    }
    if (!input.bytes || input.bytes.length !== input.expectedBytes) {
      throw offsiteError("object_upload_failed");
    }
    const { error } = await this.client.storage.from(input.bucketName).upload(
      input.objectPath,
      input.bytes,
      {
        contentType: input.contentType,
        cacheControl: input.cacheControl,
        upsert: false,
        metadata: { ...input.metadata },
      },
    );
    if (error) throw offsiteError("object_upload_failed");
  }

  async replaceMutable(input: PostgresLogicalOffsiteUpload): Promise<void> {
    if (!input.bytes || input.filePath || input.bytes.length !== input.expectedBytes) {
      throw offsiteError("object_upload_failed");
    }
    const { error } = await this.client.storage.from(input.bucketName).upload(
      input.objectPath,
      input.bytes,
      {
        contentType: input.contentType,
        cacheControl: input.cacheControl,
        upsert: true,
        metadata: { ...input.metadata },
      },
    );
    if (error) throw offsiteError("object_upload_failed");
  }

  async downloadVerified(input: {
    readonly bucketName: string;
    readonly objectPath: string;
    readonly maximumBytes: number;
    readonly retainBytes: boolean;
  }): Promise<PostgresLogicalOffsiteDownload> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let readable: Readable | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(offsiteError("destination_unreachable"));
      }, this.requestTimeoutMs);
    });
    try {
      const result = await Promise.race([
        this.client.storage
          .from(input.bucketName)
          .download(
            input.objectPath,
            { cacheNonce: crypto.randomUUID() },
            { cache: "no-store", signal: controller.signal },
          )
          .asStream(),
        deadline,
      ]);
      if (result.error || !result.data) throw offsiteError("destination_unreachable");
      const hash = crypto.createHash("sha256");
      const retained: Buffer[] = [];
      let byteCount = 0;
      readable = Readable.fromWeb(
        result.data as Parameters<typeof Readable.fromWeb>[0],
      );
      const iterator = readable[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next.done) break;
        const chunk = Buffer.isBuffer(next.value)
          ? next.value
          : Buffer.from(next.value);
        byteCount += chunk.length;
        if (byteCount > input.maximumBytes) {
          throw offsiteError("object_verification_failed");
        }
        hash.update(chunk);
        if (input.retainBytes) retained.push(Buffer.from(chunk));
      }
      return {
        bytes: byteCount,
        sha256: hash.digest("hex"),
        ...(input.retainBytes ? { retainedBytes: Buffer.concat(retained) } : {}),
      };
    } catch (error) {
      if (error instanceof PostgresLogicalOffsiteError) throw error;
      throw offsiteError("destination_unreachable");
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
      readable?.destroy();
    }
  }

  async removeExact(bucketName: string, objectPaths: readonly string[]): Promise<void> {
    if (
      objectPaths.length < 1
      || objectPaths.length > 4
      || objectPaths.some((entry) => !isExactCleanupObjectPath(entry))
    ) throw offsiteError("cleanup_failed");
    const { error } = await this.client.storage.from(bucketName).remove([...objectPaths]);
    if (error) throw offsiteError("cleanup_failed");
  }

  private async uploadTusFile(input: PostgresLogicalOffsiteUpload): Promise<void> {
    if (!input.filePath || input.bytes || input.expectedBytes < 1) {
      throw offsiteError("object_upload_failed");
    }
    const endpoint = directTusEndpoint(this.destinationOrigin);
    const uploadMetadata = encodeTusMetadata({
      bucketName: input.bucketName,
      objectName: input.objectPath,
      contentType: input.contentType,
      cacheControl: input.cacheControl,
      metadata: JSON.stringify(input.metadata),
    });
    const commonHeaders = {
      ...tusAuthenticationHeaders(this.serviceRoleKey),
      "tus-resumable": "1.0.0",
    };
    let createResponse: Response;
    try {
      createResponse = await this.boundedFetch(endpoint, {
        method: "POST",
        headers: {
          ...commonHeaders,
          "upload-length": String(input.expectedBytes),
          "upload-metadata": uploadMetadata,
        },
      });
    } catch {
      throw offsiteError("object_upload_failed");
    }
    if (createResponse.status !== 201) throw offsiteError("object_upload_failed");
    const location = createResponse.headers.get("location");
    let uploadUrl: URL;
    try {
      uploadUrl = new URL(location ?? "", endpoint);
      const endpointUrl = new URL(endpoint);
      if (
        uploadUrl.origin !== endpointUrl.origin
        || uploadUrl.protocol !== "https:"
        || !uploadUrl.pathname.startsWith("/storage/v1/upload/resumable/")
        || uploadUrl.username
        || uploadUrl.password
        || uploadUrl.search
        || uploadUrl.hash
      ) throw new Error("unsafe");
    } catch {
      throw offsiteError("object_upload_failed");
    }

    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(
        input.filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size !== BigInt(input.expectedBytes)) {
        throw offsiteError("object_upload_failed");
      }
      let offset = 0;
      const chunk = Buffer.allocUnsafe(TUS_CHUNK_BYTES);
      while (offset < input.expectedBytes) {
        const length = Math.min(TUS_CHUNK_BYTES, input.expectedBytes - offset);
        const read = await handle.read(chunk, 0, length, offset);
        if (read.bytesRead !== length) throw offsiteError("object_upload_failed");
        let patched = false;
        for (let attempt = 0; attempt < 5 && !patched; attempt += 1) {
          try {
            const response = await this.boundedFetch(uploadUrl, {
              method: "PATCH",
              headers: {
                ...commonHeaders,
                "content-type": "application/offset+octet-stream",
                "upload-offset": String(offset),
              },
              body: chunk.subarray(0, length),
            });
            const returnedOffset = Number(response.headers.get("upload-offset"));
            if (
              response.status === 204
              && Number.isSafeInteger(returnedOffset)
              && returnedOffset === offset + length
            ) {
              offset = returnedOffset;
              patched = true;
              continue;
            }
          } catch {
            // Resolve an uncertain PATCH outcome with the authoritative TUS
            // offset; no response body or URL is surfaced to the operator.
          }
          let head: Response;
          try {
            head = await this.boundedFetch(uploadUrl, {
              method: "HEAD",
              headers: commonHeaders,
            });
          } catch {
            if (attempt === 4) throw offsiteError("object_upload_failed");
            continue;
          }
          const remoteOffset = Number(head.headers.get("upload-offset"));
          if (
            !head.ok
            || !Number.isSafeInteger(remoteOffset)
            || remoteOffset < offset
            || remoteOffset > offset + length
          ) throw offsiteError("object_upload_failed");
          if (remoteOffset > offset) {
            offset = remoteOffset;
            patched = true;
          }
        }
        if (!patched) throw offsiteError("object_upload_failed");
      }
    } catch (error) {
      if (error instanceof PostgresLogicalOffsiteError) throw error;
      throw offsiteError("object_upload_failed");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

export function createSupabasePostgresLogicalOffsiteStorage(input: {
  readonly destinationSupabaseUrl: string;
  readonly destinationServiceRoleKey: string;
  readonly requestTimeoutMs?: number | undefined;
  readonly clientFactory?: ((url: string, key: string) => SupabaseClient) | undefined;
  readonly fetchImplementation?: typeof globalThis.fetch | undefined;
}): PostgresLogicalOffsiteStorage {
  try {
    assertExactSupabaseOrigin(
      input.destinationSupabaseUrl,
      OPERATIONAL_OFFSITE_SUPABASE_ORIGIN,
      "destinationSupabaseUrl",
    );
    assertSupabaseServerApiKey(
      input.destinationServiceRoleKey,
      "destinationServiceRoleKey",
    );
  } catch {
    throw offsiteError("destination_unsafe");
  }
  const requestTimeoutMs = input.requestTimeoutMs ?? 60_000;
  if (
    !Number.isFinite(requestTimeoutMs)
    || requestTimeoutMs < 1_000
    || requestTimeoutMs > 10 * 60 * 1000
  ) throw offsiteError("invalid_arguments");
  return new SupabasePostgresLogicalOffsiteStorage(
    input.destinationSupabaseUrl,
    input.destinationServiceRoleKey,
    requestTimeoutMs,
    input.clientFactory,
    input.fetchImplementation,
  );
}

export const postgresLogicalOffsiteInternals = {
  parseAttestation,
  parseLatestPointer,
  validateLocalBackup,
  directTusEndpoint,
  createScopedStorageFetch,
  encodeTusMetadata,
  isLegacyServiceRoleApiKey,
  tusAuthenticationHeaders,
};
