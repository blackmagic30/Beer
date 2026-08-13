import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SystemStateRecord } from "../db/system-state.repository.js";
import {
  POSTGRES_LOGICAL_BACKUP_ARCHIVE,
  POSTGRES_LOGICAL_BACKUP_MANIFEST,
  POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  canonicalPostgresBackupJson,
} from "./postgres-logical-backup.js";
import {
  assertPostgresLogicalBackupStateReceiptBinding,
  parsePostgresLogicalBackupManifest,
} from "./postgres-logical-restore.js";
import {
  POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY,
  POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT,
  POSTGRES_LOGICAL_OFFSITE_PREFIX,
  assertPostgresLogicalOffsiteDestinationPins,
  createSupabasePostgresLogicalOffsiteStorage,
  parsePostgresLogicalBackupSuccessState,
  postgresLogicalOffsiteInternals,
  type PostgresLogicalBackupSuccessState,
  type PostgresLogicalOffsiteBucketInfo,
  type PostgresLogicalOffsiteDownload,
  type PostgresLogicalOffsiteObjectInfo,
} from "./postgres-logical-offsite.js";
import { parsePostgresLogicalSourceStateReceipt } from "./postgres-logical-state.js";
import { createServerSupabaseClient } from "./supabase-client.js";
import {
  OPERATIONAL_OFFSITE_SUPABASE_ORIGIN,
  assertExactSupabaseOrigin,
  assertSupabaseServerApiKey,
  resolveExactOperationalOffsiteBackupBucket,
} from "./supabase-key-format.js";

const CONTRACT = "pintpath-postgres-logical-offsite-v2" as const;
const IMMUTABLE_CACHE_CONTROL = "31536000" as const;
const MUTABLE_CACHE_CONTROL = "0" as const;
const MAX_REMOTE_JSON_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_STATE_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const BACKUP_ID_PATTERN = /^\d{8}T\d{9}Z-[a-f0-9]{64}$/;
const ATTESTATION_ID_PATTERN = /^\d{8}T\d{9}Z-[a-f0-9]{64}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type RemoteObjectKind = "archive" | "manifest" | "state-receipt";

interface RemoteObjectDescriptor {
  readonly kind: RemoteObjectKind;
  readonly objectPathSha256: string;
  readonly bytes: string;
  readonly sha256: string;
  readonly contentType: "application/octet-stream" | "application/json";
  readonly metadataSha256: string;
  readonly storageObjectIdSha256: string;
  readonly storageVersionSha256: string;
}

interface LatestPointer {
  readonly kind: "pintpath-postgres-logical-offsite-latest";
  readonly version: 2;
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

interface Attestation {
  readonly kind: "pintpath-postgres-logical-offsite-attestation";
  readonly version: 2;
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
  readonly objects: readonly [
    RemoteObjectDescriptor,
    RemoteObjectDescriptor,
    RemoteObjectDescriptor,
  ];
  readonly remoteObjectSetSha256: string;
}

interface OutputDirectoryIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
}

interface StreamedArtifact {
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type PostgresLogicalOffsiteRetrievalFailureCode =
  | "invalid_arguments"
  | "unsafe_output_path"
  | "success_state_unavailable"
  | "success_state_invalid"
  | "success_state_mismatch"
  | "runtime_identity_mismatch"
  | "destination_unsafe"
  | "destination_unreachable"
  | "bucket_not_private"
  | "object_verification_failed"
  | "backup_manifest_invalid"
  | "output_write_failed"
  | "cleanup_failed";

export class PostgresLogicalOffsiteRetrievalError extends Error {
  constructor(readonly code: PostgresLogicalOffsiteRetrievalFailureCode) {
    super(code);
    this.name = "PostgresLogicalOffsiteRetrievalError";
  }
}

export interface PostgresLogicalOffsiteRetrievalStateAuthority {
  get(
    key: string,
  ): Promise<SystemStateRecord<Record<string, unknown>> | null>;
}

export interface PostgresLogicalOffsiteRetrievalStorage {
  readonly destinationOrigin: string;
  inspectBucket(bucketName: string): Promise<PostgresLogicalOffsiteBucketInfo>;
  objectInfo(
    bucketName: string,
    objectPath: string,
  ): Promise<PostgresLogicalOffsiteObjectInfo | null>;
  downloadVerified(input: {
    readonly bucketName: string;
    readonly objectPath: string;
    readonly maximumBytes: number;
    readonly retainBytes: boolean;
  }): Promise<PostgresLogicalOffsiteDownload>;
  streamDownload(input: {
    readonly bucketName: string;
    readonly objectPath: string;
    readonly maximumBytes: number;
    readonly onChunk: (chunk: Buffer) => Promise<void>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<PostgresLogicalOffsiteDownload>;
}

export interface RetrievePostgresLogicalOffsiteOptions {
  readonly outputDirectory: string;
  readonly expectedSuccessStateSha256: string;
  readonly runtimeDatabaseIdentitySha256: string;
  readonly sourceSupabaseUrl: string;
  readonly destinationSupabaseUrl: string;
  readonly expectedDestinationOriginSha256: string;
  readonly bucketName: string;
  readonly expectedBucketNameSha256: string;
  readonly state: PostgresLogicalOffsiteRetrievalStateAuthority;
  readonly storage: PostgresLogicalOffsiteRetrievalStorage;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface PostgresLogicalOffsiteRetrievalResult {
  readonly schemaVersion: 1;
  readonly kind: "pintpath-postgres-logical-offsite-retrieval";
  readonly ok: true;
  readonly retrievedAt: string;
  readonly successStateSha256: string;
  readonly backupCreatedAt: string;
  readonly backupIdSha256: string;
  readonly latestPointerSha256: string;
  readonly attestationSha256: string;
  readonly remoteObjectSetSha256: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly stateReceiptSha256: string;
  readonly sourceDatabaseIdentitySha256: string;
  readonly overallStateSha256: string;
  readonly archiveBytes: number;
  readonly manifestBytes: number;
  readonly stateReceiptBytes: number;
  readonly localArtifactSetSha256: string;
}

function retrievalError(
  code: PostgresLogicalOffsiteRetrievalFailureCode,
): PostgresLogicalOffsiteRetrievalError {
  return new PostgresLogicalOffsiteRetrievalError(code);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalPostgresBackupJson(value));
}

function assertSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized !== value || !SHA256_PATTERN.test(normalized)) {
    throw retrievalError("invalid_arguments");
  }
  return normalized;
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
    throw retrievalError("destination_unsafe");
  }
}

function assertBucketName(value: string): string {
  if (!BUCKET_PATTERN.test(value)) throw retrievalError("invalid_arguments");
  return value;
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw retrievalError("invalid_arguments");
  }
  return value.toISOString();
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:.]/g, "");
}

function expectedBackupId(state: PostgresLogicalBackupSuccessState): string {
  const value = `${compactTimestamp(state.backupCreatedAt)}-${state.manifestSha256}`;
  if (!BACKUP_ID_PATTERN.test(value)) throw retrievalError("success_state_invalid");
  return value;
}

function backupObjectPath(backupId: string, filename: string): string {
  if (
    !BACKUP_ID_PATTERN.test(backupId)
    || ![
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ].includes(filename)
  ) throw retrievalError("object_verification_failed");
  return `${POSTGRES_LOGICAL_OFFSITE_PREFIX}/backups/${backupId}/${filename}`;
}

function attestationObjectPath(backupId: string, attestationId: string): string {
  if (!BACKUP_ID_PATTERN.test(backupId) || !ATTESTATION_ID_PATTERN.test(attestationId)) {
    throw retrievalError("object_verification_failed");
  }
  return `${POSTGRES_LOGICAL_OFFSITE_PREFIX}/attestations/${backupId}/${attestationId}.json`;
}

function storageMetadata(input: {
  readonly objectKind: string;
  readonly objectSha256: string;
  readonly manifestSha256: string;
  readonly backupIdSha256: string;
}): Readonly<Record<string, string>> {
  return Object.freeze({
    contract: CONTRACT,
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

function exactStateRecord(
  before: SystemStateRecord<Record<string, unknown>>,
  after: SystemStateRecord<Record<string, unknown>>,
): boolean {
  return before.revision === after.revision
    && before.updatedAt === after.updatedAt
    && canonicalPostgresBackupJson(before.value)
      === canonicalPostgresBackupJson(after.value);
}

function stateMatchesPointer(
  state: PostgresLogicalBackupSuccessState,
  pointer: LatestPointer,
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

function attestationMatchesAuthority(
  state: PostgresLogicalBackupSuccessState,
  pointer: LatestPointer,
  attestation: Attestation,
): boolean {
  return attestation.backupId === pointer.backupId
    && attestation.backupIdSha256 === state.backupIdSha256
    && attestation.backupCreatedAt === state.backupCreatedAt
    && attestation.verifiedAt === state.completedAt
    && attestation.archiveSha256 === state.archiveSha256
    && attestation.manifestSha256 === state.manifestSha256
    && attestation.stateReceiptSha256 === state.stateReceiptSha256
    && attestation.manifestBindingSha256 === state.manifestBindingSha256
    && attestation.sourceDatabaseIdentitySha256
      === state.sourceDatabaseIdentitySha256
    && attestation.runtimeConnectionUrlSha256
      === state.runtimeConnectionUrlSha256
    && attestation.overallStateSha256 === state.overallStateSha256
    && attestation.remoteObjectSetSha256 === state.remoteObjectSetSha256
    && attestation.destinationOriginSha256 === state.destinationOriginSha256
    && attestation.bucketNameSha256 === state.bucketNameSha256
    && attestation.operatorIdSha256 === state.operatorIdSha256;
}

function assertObjectInfo(input: {
  readonly info: PostgresLogicalOffsiteObjectInfo | null;
  readonly expectedBytes: number;
  readonly expectedContentType: string;
  readonly expectedCacheControl: string;
  readonly expectedMetadata: Readonly<Record<string, string>>;
  readonly expectedStorageObjectIdSha256: string;
  readonly expectedStorageVersionSha256: string;
}): PostgresLogicalOffsiteObjectInfo {
  const info = input.info;
  if (
    !info
    || info.bytes !== input.expectedBytes
    || info.contentType.toLowerCase() !== input.expectedContentType
    || !cacheControlMatches(info.cacheControl, input.expectedCacheControl)
    || !exactMetadataSubset(info.metadata, input.expectedMetadata)
    || sha256(info.storageObjectId) !== input.expectedStorageObjectIdSha256
    || sha256(info.storageVersion) !== input.expectedStorageVersionSha256
  ) throw retrievalError("object_verification_failed");
  return info;
}

async function downloadSmallFenced(input: {
  readonly storage: PostgresLogicalOffsiteRetrievalStorage;
  readonly bucketName: string;
  readonly objectPath: string;
  readonly maximumBytes: number;
  readonly expectedSha256: string;
}): Promise<{
  readonly bytes: Buffer;
  readonly before: PostgresLogicalOffsiteObjectInfo;
  readonly after: PostgresLogicalOffsiteObjectInfo;
}> {
  try {
    const before = await input.storage.objectInfo(input.bucketName, input.objectPath);
    if (!before) throw retrievalError("object_verification_failed");
    const download = await input.storage.downloadVerified({
      bucketName: input.bucketName,
      objectPath: input.objectPath,
      maximumBytes: input.maximumBytes,
      retainBytes: true,
    });
    const after = await input.storage.objectInfo(input.bucketName, input.objectPath);
    if (
      !after
      || !sameObjectInfo(before, after)
      || !download.retainedBytes
      || download.bytes !== download.retainedBytes.length
      || download.sha256 !== input.expectedSha256
      || sha256(download.retainedBytes) !== input.expectedSha256
    ) throw retrievalError("object_verification_failed");
    return { bytes: download.retainedBytes, before, after };
  } catch (error) {
    if (error instanceof PostgresLogicalOffsiteRetrievalError) throw error;
    throw retrievalError("destination_unreachable");
  }
}

function exactUid(): number {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!Number.isInteger(uid) || Number(uid) < 0) {
    throw retrievalError("unsafe_output_path");
  }
  return Number(uid);
}

async function createExactOutputDirectory(
  requestedPath: string,
): Promise<OutputDirectoryIdentity> {
  const uid = exactUid();
  if (
    !path.isAbsolute(requestedPath)
    || path.resolve(requestedPath) !== requestedPath
    || requestedPath === path.parse(requestedPath).root
    || requestedPath.includes("\0")
  ) throw retrievalError("unsafe_output_path");
  let created = false;
  try {
    const existing = await fs.promises.lstat(requestedPath).catch(
      (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error),
    );
    if (existing) throw new Error("exists");
    const parent = path.dirname(requestedPath);
    const parentStat = await fs.promises.lstat(parent, { bigint: true });
    if (
      !parentStat.isDirectory()
      || parentStat.isSymbolicLink()
      || parentStat.uid !== BigInt(uid)
      || Number(parentStat.mode & 0o077n) !== 0
      || await fs.promises.realpath(parent) !== parent
    ) throw new Error("unsafe parent");
    await fs.promises.mkdir(requestedPath, { mode: 0o700 });
    created = true;
    await fs.promises.chmod(requestedPath, 0o700);
    const stat = await fs.promises.lstat(requestedPath, { bigint: true });
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.uid !== BigInt(uid)
      || Number(stat.mode & 0o7777n) !== 0o700
      || await fs.promises.realpath(requestedPath) !== requestedPath
    ) throw new Error("unsafe output");
    return { path: requestedPath, dev: stat.dev, ino: stat.ino, uid: stat.uid };
  } catch {
    if (created) await fs.promises.rmdir(requestedPath).catch(() => undefined);
    throw retrievalError("unsafe_output_path");
  }
}

async function assertOutputDirectory(
  directory: OutputDirectoryIdentity,
  allowedEntries: readonly string[],
): Promise<void> {
  try {
    const stat = await fs.promises.lstat(directory.path, { bigint: true });
    const entries = (await fs.promises.readdir(directory.path)).sort();
    const allowed = new Set(allowedEntries);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.dev !== directory.dev
      || stat.ino !== directory.ino
      || stat.uid !== directory.uid
      || Number(stat.mode & 0o7777n) !== 0o700
      || await fs.promises.realpath(directory.path) !== directory.path
      || entries.some((entry) => !allowed.has(entry))
    ) throw new Error("changed");
  } catch {
    throw retrievalError("output_write_failed");
  }
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function hashExactLocalFile(input: {
  readonly filePath: string;
  readonly expectedUid: bigint;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
}): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const before = await fs.promises.lstat(input.filePath, { bigint: true });
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1n
      || before.uid !== input.expectedUid
      || Number(before.mode & 0o7777n) !== 0o600
      || before.size !== BigInt(input.expectedBytes)
      || await fs.promises.realpath(input.filePath) !== input.filePath
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
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0n;
    while (offset < opened.size) {
      const length = Number(opened.size - offset > BigInt(buffer.length)
        ? BigInt(buffer.length)
        : opened.size - offset);
      const read = await handle.read(buffer, 0, length, Number(offset));
      if (read.bytesRead < 1) throw new Error("changed");
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += BigInt(read.bytesRead);
    }
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathAfter = await fs.promises.lstat(input.filePath, { bigint: true });
    if (
      !sameFileIdentity(before, descriptorAfter)
      || !sameFileIdentity(before, pathAfter)
      || hash.digest("hex") !== input.expectedSha256
    ) throw new Error("changed");
  } catch {
    throw retrievalError("output_write_failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeAllAt(
  handle: fs.promises.FileHandle,
  chunk: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const written = await handle.write(
      chunk,
      offset,
      chunk.length - offset,
      position + offset,
    );
    if (written.bytesWritten < 1) throw retrievalError("output_write_failed");
    offset += written.bytesWritten;
  }
}

async function streamArtifactToFile(input: {
  readonly directory: OutputDirectoryIdentity;
  readonly storage: PostgresLogicalOffsiteRetrievalStorage;
  readonly bucketName: string;
  readonly objectPath: string;
  readonly filename: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<StreamedArtifact> {
  const destination = path.join(input.directory.path, input.filename);
  if (
    path.dirname(destination) !== input.directory.path
    || path.basename(destination) !== input.filename
  ) throw retrievalError("output_write_failed");
  let handle: fs.promises.FileHandle | null = null;
  try {
    await assertOutputDirectory(input.directory, [
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ]);
    handle = await fs.promises.open(
      destination,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || opened.uid !== input.directory.uid
      || Number(opened.mode & 0o7777n) !== 0o600
      || opened.size !== 0n
    ) throw retrievalError("output_write_failed");
    const localHash = crypto.createHash("sha256");
    let localBytes = 0;
    let callbackActive = false;
    const streamed = await input.storage.streamDownload({
      bucketName: input.bucketName,
      objectPath: input.objectPath,
      maximumBytes: input.expectedBytes,
      ...(input.signal ? { signal: input.signal } : {}),
      onChunk: async (rawChunk) => {
        if (callbackActive || !Buffer.isBuffer(rawChunk) || rawChunk.length < 1) {
          throw retrievalError("object_verification_failed");
        }
        callbackActive = true;
        try {
          if (localBytes + rawChunk.length > input.expectedBytes) {
            throw retrievalError("object_verification_failed");
          }
          localHash.update(rawChunk);
          await writeAllAt(handle!, rawChunk, localBytes);
          localBytes += rawChunk.length;
        } finally {
          callbackActive = false;
        }
      },
    });
    const localSha256 = localHash.digest("hex");
    if (
      localBytes !== input.expectedBytes
      || localSha256 !== input.expectedSha256
      || streamed.bytes !== input.expectedBytes
      || streamed.sha256 !== input.expectedSha256
      || streamed.retainedBytes
    ) throw retrievalError("object_verification_failed");
    await handle.sync();
    const finalDescriptor = await handle.stat({ bigint: true });
    if (
      !finalDescriptor.isFile()
      || finalDescriptor.nlink !== 1n
      || finalDescriptor.uid !== input.directory.uid
      || Number(finalDescriptor.mode & 0o7777n) !== 0o600
      || finalDescriptor.size !== BigInt(input.expectedBytes)
    ) throw retrievalError("output_write_failed");
    await handle.close();
    handle = null;
    await hashExactLocalFile({
      filePath: destination,
      expectedUid: input.directory.uid,
      expectedBytes: input.expectedBytes,
      expectedSha256: input.expectedSha256,
    });
    return {
      filename: input.filename,
      bytes: input.expectedBytes,
      sha256: input.expectedSha256,
    };
  } catch (error) {
    if (error instanceof PostgresLogicalOffsiteRetrievalError) throw error;
    throw retrievalError("output_write_failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedLocalFile(
  directory: OutputDirectoryIdentity,
  filename: string,
  maximumBytes: number,
): Promise<Buffer> {
  const filePath = path.join(directory.path, filename);
  let handle: fs.promises.FileHandle | null = null;
  try {
    const before = await fs.promises.lstat(filePath, { bigint: true });
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1n
      || before.uid !== directory.uid
      || Number(before.mode & 0o7777n) !== 0o600
      || before.size < 1n
      || before.size > BigInt(maximumBytes)
      || await fs.promises.realpath(filePath) !== filePath
    ) throw new Error("unsafe");
    // The O_NOFOLLOW descriptor is bound to the pre-open lstat by full file
    // identity; both the descriptor and pathname are revalidated after read.
    // codeql[js/file-system-race]
    handle = await fs.promises.open( // lgtm[js/file-system-race]
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, opened)) throw new Error("changed");
    const bytes = await handle.readFile();
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathAfter = await fs.promises.lstat(filePath, { bigint: true });
    if (
      bytes.length !== Number(before.size)
      || !sameFileIdentity(before, descriptorAfter)
      || !sameFileIdentity(before, pathAfter)
    ) throw new Error("changed");
    return bytes;
  } catch {
    throw retrievalError("output_write_failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function cleanupExactOutput(directory: OutputDirectoryIdentity): Promise<void> {
  const allowed = new Set([
    POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    POSTGRES_LOGICAL_BACKUP_MANIFEST,
    POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  ]);
  try {
    const stat = await fs.promises.lstat(directory.path, { bigint: true });
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.dev !== directory.dev
      || stat.ino !== directory.ino
      || stat.uid !== directory.uid
      || await fs.promises.realpath(directory.path) !== directory.path
    ) throw new Error("changed");
    const entries = await fs.promises.readdir(directory.path);
    if (entries.some((entry) => !allowed.has(entry))) throw new Error("unexpected");
    for (const entry of entries) await fs.promises.unlink(path.join(directory.path, entry));
    await fs.promises.rmdir(directory.path);
  } catch {
    throw retrievalError("cleanup_failed");
  }
}

function parsePointer(bytes: Buffer): LatestPointer {
  try {
    return postgresLogicalOffsiteInternals.parseLatestPointer(bytes) as LatestPointer;
  } catch {
    throw retrievalError("object_verification_failed");
  }
}

function parseAttestation(bytes: Buffer): Attestation {
  try {
    return postgresLogicalOffsiteInternals.parseAttestation(bytes) as Attestation;
  } catch {
    throw retrievalError("object_verification_failed");
  }
}

async function readInitialAuthority(input: {
  readonly state: PostgresLogicalOffsiteRetrievalStateAuthority;
  readonly expectedSuccessStateSha256: string;
}): Promise<{
  readonly record: SystemStateRecord<Record<string, unknown>>;
  readonly parsed: PostgresLogicalBackupSuccessState;
  readonly stateSha256: string;
}> {
  const record = await input.state.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)
    .catch(() => null);
  if (!record) throw retrievalError("success_state_unavailable");
  let parsed: PostgresLogicalBackupSuccessState;
  try {
    parsed = parsePostgresLogicalBackupSuccessState(record.value);
  } catch {
    throw retrievalError("success_state_invalid");
  }
  const stateSha256 = canonicalSha256(parsed);
  if (stateSha256 !== input.expectedSuccessStateSha256) {
    throw retrievalError("success_state_mismatch");
  }
  return { record, parsed, stateSha256 };
}

async function inspectPrivateBucket(
  storage: PostgresLogicalOffsiteRetrievalStorage,
  bucketName: string,
): Promise<void> {
  try {
    const bucket = await storage.inspectBucket(bucketName);
    if (!bucket.private) throw retrievalError("bucket_not_private");
  } catch (error) {
    if (error instanceof PostgresLogicalOffsiteRetrievalError) throw error;
    throw retrievalError("destination_unreachable");
  }
}

export async function retrievePostgresLogicalOffsiteBackup(
  options: RetrievePostgresLogicalOffsiteOptions,
): Promise<PostgresLogicalOffsiteRetrievalResult> {
  const expectedSuccessStateSha256 = assertSha256(options.expectedSuccessStateSha256);
  const runtimeDatabaseIdentitySha256 = assertSha256(
    options.runtimeDatabaseIdentitySha256,
  );
  const expectedDestinationOriginSha256 = assertSha256(
    options.expectedDestinationOriginSha256,
  );
  const expectedBucketNameSha256 = assertSha256(options.expectedBucketNameSha256);
  const bucketName = assertBucketName(options.bucketName);
  const sourceOrigin = canonicalOrigin(options.sourceSupabaseUrl);
  const destinationOrigin = canonicalOrigin(options.destinationSupabaseUrl);
  if (sourceOrigin === destinationOrigin) throw retrievalError("destination_unsafe");
  try {
    assertPostgresLogicalOffsiteDestinationPins({
      destinationSupabaseUrl: options.destinationSupabaseUrl,
      bucketName,
      expectedDestinationOriginSha256,
      expectedBucketNameSha256,
    });
  } catch {
    throw retrievalError("destination_unsafe");
  }
  if (canonicalOrigin(options.storage.destinationOrigin) !== destinationOrigin) {
    throw retrievalError("destination_unsafe");
  }
  const authority = await readInitialAuthority({
    state: options.state,
    expectedSuccessStateSha256,
  });
  const successState = authority.parsed;
  if (
    successState.destinationOriginSha256 !== sha256(destinationOrigin)
    || successState.destinationOriginSha256 !== expectedDestinationOriginSha256
    || successState.bucketNameSha256 !== sha256(bucketName)
    || successState.bucketNameSha256 !== expectedBucketNameSha256
  ) throw retrievalError("destination_unsafe");
  if (successState.sourceDatabaseIdentitySha256 !== runtimeDatabaseIdentitySha256) {
    throw retrievalError("runtime_identity_mismatch");
  }
  await inspectPrivateBucket(options.storage, bucketName);

  const pointerDownload = await downloadSmallFenced({
    storage: options.storage,
    bucketName,
    objectPath: POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT,
    maximumBytes: MAX_REMOTE_JSON_BYTES,
    expectedSha256: successState.latestPointerSha256,
  });
  const pointer = parsePointer(pointerDownload.bytes);
  const backupId = expectedBackupId(successState);
  const expectedAttestationId = `${compactTimestamp(successState.completedAt)}-${successState.attestationSha256}`;
  if (
    !stateMatchesPointer(successState, pointer)
    || pointer.backupId !== backupId
    || pointer.backupIdSha256 !== sha256(backupId)
    || pointer.attestationId !== expectedAttestationId
  ) throw retrievalError("object_verification_failed");
  const commonMetadata = {
    manifestSha256: successState.manifestSha256,
    backupIdSha256: successState.backupIdSha256,
  };
  const pointerMetadata = storageMetadata({
    ...commonMetadata,
    objectKind: "postgres-logical-offsite-latest",
    objectSha256: successState.latestPointerSha256,
  });
  assertObjectInfo({
    info: pointerDownload.after,
    expectedBytes: pointerDownload.bytes.length,
    expectedContentType: "application/json",
    expectedCacheControl: MUTABLE_CACHE_CONTROL,
    expectedMetadata: pointerMetadata,
    expectedStorageObjectIdSha256: successState.latestPointerStorageObjectIdSha256,
    expectedStorageVersionSha256: successState.latestPointerStorageVersionSha256,
  });

  const attestationPath = attestationObjectPath(backupId, pointer.attestationId);
  const attestationDownload = await downloadSmallFenced({
    storage: options.storage,
    bucketName,
    objectPath: attestationPath,
    maximumBytes: MAX_REMOTE_JSON_BYTES,
    expectedSha256: successState.attestationSha256,
  });
  const attestation = parseAttestation(attestationDownload.bytes);
  if (!attestationMatchesAuthority(successState, pointer, attestation)) {
    throw retrievalError("object_verification_failed");
  }
  const attestationMetadata = storageMetadata({
    ...commonMetadata,
    objectKind: "postgres-logical-offsite-attestation",
    objectSha256: successState.attestationSha256,
  });
  assertObjectInfo({
    info: attestationDownload.after,
    expectedBytes: attestationDownload.bytes.length,
    expectedContentType: "application/json",
    expectedCacheControl: IMMUTABLE_CACHE_CONTROL,
    expectedMetadata: attestationMetadata,
    expectedStorageObjectIdSha256: successState.attestationStorageObjectIdSha256,
    expectedStorageVersionSha256: successState.attestationStorageVersionSha256,
  });

  const specifications = [
    {
      kind: "archive" as const,
      filename: POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      expectedSha256: successState.archiveSha256,
      maximumBytes: MAX_ARCHIVE_BYTES,
      contentType: "application/octet-stream" as const,
      objectKind: "postgres-logical-archive",
    },
    {
      kind: "manifest" as const,
      filename: POSTGRES_LOGICAL_BACKUP_MANIFEST,
      expectedSha256: successState.manifestSha256,
      maximumBytes: MAX_MANIFEST_BYTES,
      contentType: "application/json" as const,
      objectKind: "postgres-logical-manifest",
    },
    {
      kind: "state-receipt" as const,
      filename: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      expectedSha256: successState.stateReceiptSha256,
      maximumBytes: MAX_STATE_RECEIPT_BYTES,
      contentType: "application/json" as const,
      objectKind: "postgres-logical-state-receipt",
    },
  ] as const;

  let output: OutputDirectoryIdentity | null = null;
  let completed = false;
  try {
    const verified = specifications.map((specification, index) => {
      const descriptor = attestation.objects[index]!;
      const objectPath = backupObjectPath(backupId, specification.filename);
      const expectedBytes = Number(descriptor.bytes);
      const metadata = storageMetadata({
        ...commonMetadata,
        objectKind: specification.objectKind,
        objectSha256: specification.expectedSha256,
      });
      if (
        descriptor.kind !== specification.kind
        || descriptor.sha256 !== specification.expectedSha256
        || descriptor.contentType !== specification.contentType
        || descriptor.objectPathSha256 !== sha256(objectPath)
        || descriptor.metadataSha256 !== canonicalSha256(metadata)
        || !Number.isSafeInteger(expectedBytes)
        || expectedBytes < 1
        || expectedBytes > specification.maximumBytes
      ) throw retrievalError("object_verification_failed");
      return { specification, descriptor, objectPath, expectedBytes, metadata };
    });

    output = await createExactOutputDirectory(options.outputDirectory);
    const streamedArtifacts: StreamedArtifact[] = [];
    // Validate the small canonical authority files before spending time on the
    // potentially large archive, while still streaming every artifact.
    for (const item of [verified[1]!, verified[2]!, verified[0]!]) {
      let before: PostgresLogicalOffsiteObjectInfo | null;
      try {
        before = await options.storage.objectInfo(bucketName, item.objectPath);
      } catch {
        throw retrievalError("destination_unreachable");
      }
      const verifiedBefore = assertObjectInfo({
        info: before,
        expectedBytes: item.expectedBytes,
        expectedContentType: item.specification.contentType,
        expectedCacheControl: IMMUTABLE_CACHE_CONTROL,
        expectedMetadata: item.metadata,
        expectedStorageObjectIdSha256: item.descriptor.storageObjectIdSha256,
        expectedStorageVersionSha256: item.descriptor.storageVersionSha256,
      });
      const streamed = await streamArtifactToFile({
        directory: output,
        storage: options.storage,
        bucketName,
        objectPath: item.objectPath,
        filename: item.specification.filename,
        expectedBytes: item.expectedBytes,
        expectedSha256: item.specification.expectedSha256,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      let after: PostgresLogicalOffsiteObjectInfo | null;
      try {
        after = await options.storage.objectInfo(bucketName, item.objectPath);
      } catch {
        throw retrievalError("destination_unreachable");
      }
      const verifiedAfter = assertObjectInfo({
        info: after,
        expectedBytes: item.expectedBytes,
        expectedContentType: item.specification.contentType,
        expectedCacheControl: IMMUTABLE_CACHE_CONTROL,
        expectedMetadata: item.metadata,
        expectedStorageObjectIdSha256: item.descriptor.storageObjectIdSha256,
        expectedStorageVersionSha256: item.descriptor.storageVersionSha256,
      });
      if (!sameObjectInfo(verifiedBefore, verifiedAfter)) {
        throw retrievalError("object_verification_failed");
      }
      streamedArtifacts.push(streamed);
    }

    const manifestBytes = await readBoundedLocalFile(
      output,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      MAX_MANIFEST_BYTES,
    );
    const receiptBytes = await readBoundedLocalFile(
      output,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      MAX_STATE_RECEIPT_BYTES,
    );
    try {
      const manifest = parsePostgresLogicalBackupManifest(manifestBytes);
      const receipt = parsePostgresLogicalSourceStateReceipt(receiptBytes);
      assertPostgresLogicalBackupStateReceiptBinding(receipt, manifest);
      if (
        manifest.createdAt !== successState.backupCreatedAt
        || manifest.archive.bytes !== verified[0]!.expectedBytes
        || manifest.archive.sha256 !== successState.archiveSha256
        || manifest.state.receiptSha256 !== successState.stateReceiptSha256
        || manifest.state.manifestBindingSha256 !== successState.manifestBindingSha256
        || manifest.state.sourceDatabaseIdentitySha256
          !== successState.sourceDatabaseIdentitySha256
        || manifest.state.overallStateSha256 !== successState.overallStateSha256
      ) throw new Error("binding mismatch");
    } catch {
      throw retrievalError("backup_manifest_invalid");
    }

    const pointerFence = await downloadSmallFenced({
      storage: options.storage,
      bucketName,
      objectPath: POSTGRES_LOGICAL_OFFSITE_LATEST_OBJECT,
      maximumBytes: MAX_REMOTE_JSON_BYTES,
      expectedSha256: successState.latestPointerSha256,
    });
    if (
      !sameObjectInfo(pointerDownload.before, pointerFence.before)
      || !sameObjectInfo(pointerDownload.after, pointerFence.after)
      || !pointerFence.bytes.equals(pointerDownload.bytes)
    ) throw retrievalError("object_verification_failed");
    const stateAfter = await options.state.get(POSTGRES_LOGICAL_BACKUP_SUCCESS_STATE_KEY)
      .catch(() => null);
    if (!stateAfter || !exactStateRecord(authority.record, stateAfter)) {
      throw retrievalError("success_state_mismatch");
    }
    await assertOutputDirectory(output, [
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ]);
    const exactEntries = (await fs.promises.readdir(output.path)).sort();
    const requiredEntries = [
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ].sort();
    if (canonicalPostgresBackupJson(exactEntries)
      !== canonicalPostgresBackupJson(requiredEntries)) {
      throw retrievalError("output_write_failed");
    }
    const artifacts = streamedArtifacts.sort((left, right) => (
      left.filename.localeCompare(right.filename)
    ));
    const byFilename = new Map(artifacts.map((artifact) => [artifact.filename, artifact]));
    const archive = byFilename.get(POSTGRES_LOGICAL_BACKUP_ARCHIVE)!;
    const manifest = byFilename.get(POSTGRES_LOGICAL_BACKUP_MANIFEST)!;
    const stateReceipt = byFilename.get(POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT)!;
    const retrievedAt = canonicalNow(options.now ?? (() => new Date()));
    completed = true;
    return {
      schemaVersion: 1,
      kind: "pintpath-postgres-logical-offsite-retrieval",
      ok: true,
      retrievedAt,
      successStateSha256: authority.stateSha256,
      backupCreatedAt: successState.backupCreatedAt,
      backupIdSha256: successState.backupIdSha256,
      latestPointerSha256: successState.latestPointerSha256,
      attestationSha256: successState.attestationSha256,
      remoteObjectSetSha256: successState.remoteObjectSetSha256,
      archiveSha256: archive.sha256,
      manifestSha256: manifest.sha256,
      stateReceiptSha256: stateReceipt.sha256,
      sourceDatabaseIdentitySha256: successState.sourceDatabaseIdentitySha256,
      overallStateSha256: successState.overallStateSha256,
      archiveBytes: archive.bytes,
      manifestBytes: manifest.bytes,
      stateReceiptBytes: stateReceipt.bytes,
      localArtifactSetSha256: canonicalSha256(artifacts.map((artifact) => ({
        ...artifact,
        mode: "0600",
      }))),
    };
  } catch (error) {
    if (output && !completed) {
      try {
        await cleanupExactOutput(output);
      } catch {
        throw retrievalError("cleanup_failed");
      }
    }
    if (error instanceof PostgresLogicalOffsiteRetrievalError) throw error;
    throw retrievalError("object_verification_failed");
  }
}

function isExactArtifactObjectPath(objectPath: string): boolean {
  if (/[%\\\u0000-\u001f\u007f]/.test(objectPath)) return false;
  const parts = objectPath.split("/");
  return parts.length === 6
    && parts[0] === "_control"
    && parts[1] === "postgres-logical-backups"
    && parts[2] === "v2"
    && parts[3] === "backups"
    && BACKUP_ID_PATTERN.test(parts[4]!)
    && [
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ].includes(parts[5]!);
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

function createReadOnlyArtifactFetch(input: {
  readonly destinationOrigin: string;
  readonly bucketName: string;
  readonly fetchImplementation: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  const origin = canonicalOrigin(input.destinationOrigin);
  const bucketName = assertBucketName(input.bucketName);
  const prefix = `/storage/v1/object/${bucketName}/`;
  return async (requestInput, init) => {
    let url: URL;
    try {
      url = requestUrl(requestInput);
      const objectPath = url.pathname.startsWith(prefix)
        ? url.pathname.slice(prefix.length)
        : "";
      if (
        requestMethod(requestInput, init) !== "GET"
        || url.origin !== origin
        || url.username
        || url.password
        || url.search
        || url.hash
        || !isExactArtifactObjectPath(objectPath)
      ) throw new Error("outside retrieval authority");
    } catch {
      throw retrievalError("destination_unsafe");
    }
    return input.fetchImplementation(requestInput, { ...init, redirect: "error" });
  };
}

class SupabasePostgresLogicalOffsiteRetrievalStorage
implements PostgresLogicalOffsiteRetrievalStorage {
  readonly destinationOrigin: string;
  private readonly client: SupabaseClient;
  private readonly base: ReturnType<typeof createSupabasePostgresLogicalOffsiteStorage>;

  constructor(
    destinationSupabaseUrl: string,
    destinationServiceRoleKey: string,
    private readonly bucketName: string,
    requestTimeoutMs: number,
    private readonly streamTimeoutMs: number,
    fetchImplementation: typeof globalThis.fetch,
    clientFactory?: ((
      url: string,
      key: string,
      fetchImplementation: typeof globalThis.fetch,
    ) => SupabaseClient) | undefined,
  ) {
    this.destinationOrigin = canonicalOrigin(destinationSupabaseUrl);
    assertBucketName(bucketName);
    if (
      !destinationServiceRoleKey
      || destinationServiceRoleKey.length > 64 * 1024
      || /[\u0000\r\n]/.test(destinationServiceRoleKey)
    ) throw retrievalError("destination_unsafe");
    this.base = createSupabasePostgresLogicalOffsiteStorage({
      destinationSupabaseUrl: this.destinationOrigin,
      destinationServiceRoleKey,
      requestTimeoutMs,
      fetchImplementation,
    });
    const readOnlyFetch = createReadOnlyArtifactFetch({
      destinationOrigin: this.destinationOrigin,
      bucketName,
      fetchImplementation,
    });
    this.client = clientFactory
      ? clientFactory(this.destinationOrigin, destinationServiceRoleKey, readOnlyFetch)
      : createServerSupabaseClient(this.destinationOrigin, destinationServiceRoleKey, {
        timeoutMs: requestTimeoutMs,
        fetchImplementation: readOnlyFetch,
      });
  }

  inspectBucket(bucketName: string): Promise<PostgresLogicalOffsiteBucketInfo> {
    return this.base.inspectBucket(bucketName);
  }

  objectInfo(
    bucketName: string,
    objectPath: string,
  ): Promise<PostgresLogicalOffsiteObjectInfo | null> {
    return this.base.objectInfo(bucketName, objectPath);
  }

  downloadVerified(input: {
    readonly bucketName: string;
    readonly objectPath: string;
    readonly maximumBytes: number;
    readonly retainBytes: boolean;
  }): Promise<PostgresLogicalOffsiteDownload> {
    return this.base.downloadVerified(input);
  }

  async streamDownload(input: {
    readonly bucketName: string;
    readonly objectPath: string;
    readonly maximumBytes: number;
    readonly onChunk: (chunk: Buffer) => Promise<void>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<PostgresLogicalOffsiteDownload> {
    if (
      input.bucketName !== this.bucketName
      || !isExactArtifactObjectPath(input.objectPath)
      || !Number.isSafeInteger(input.maximumBytes)
      || input.maximumBytes < 1
      || input.maximumBytes > MAX_ARCHIVE_BYTES
    ) throw retrievalError("invalid_arguments");
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let readable: Readable | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(retrievalError("destination_unreachable"));
      }, this.streamTimeoutMs);
      timeout.unref?.();
    });
    try {
      const result = await Promise.race([
        this.client.storage.from(input.bucketName).download(
          input.objectPath,
          {},
          { cache: "no-store", signal },
        ).asStream(),
        deadline,
      ]);
      if (result.error || !result.data) throw retrievalError("destination_unreachable");
      readable = Readable.fromWeb(
        result.data as Parameters<typeof Readable.fromWeb>[0],
      );
      const iterator = readable[Symbol.asyncIterator]();
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      while (true) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next.done) break;
        const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        if (chunk.length < 1) continue;
        bytes += chunk.length;
        if (bytes > input.maximumBytes) {
          throw retrievalError("object_verification_failed");
        }
        hash.update(chunk);
        await input.onChunk(Buffer.from(chunk));
      }
      return { bytes, sha256: hash.digest("hex") };
    } catch (error) {
      if (error instanceof PostgresLogicalOffsiteRetrievalError) throw error;
      throw retrievalError("destination_unreachable");
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
      readable?.destroy();
    }
  }
}

export function createSupabasePostgresLogicalOffsiteRetrievalStorage(input: {
  readonly destinationSupabaseUrl: string;
  readonly destinationServiceRoleKey: string;
  readonly bucketName: string;
  readonly requestTimeoutMs?: number | undefined;
  readonly streamTimeoutMs?: number | undefined;
  readonly fetchImplementation?: typeof globalThis.fetch | undefined;
  readonly clientFactory?: ((
    url: string,
    key: string,
    fetchImplementation: typeof globalThis.fetch,
  ) => SupabaseClient) | undefined;
}): PostgresLogicalOffsiteRetrievalStorage {
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
    resolveExactOperationalOffsiteBackupBucket(input.bucketName, "bucketName");
  } catch {
    throw retrievalError("destination_unsafe");
  }
  const requestTimeoutMs = input.requestTimeoutMs ?? 60_000;
  const streamTimeoutMs = input.streamTimeoutMs ?? 2 * 60 * 60 * 1000;
  if (
    !Number.isFinite(requestTimeoutMs)
    || requestTimeoutMs < 1_000
    || requestTimeoutMs > 10 * 60 * 1000
    || !Number.isFinite(streamTimeoutMs)
    || streamTimeoutMs < 1_000
    || streamTimeoutMs > 12 * 60 * 60 * 1000
  ) throw retrievalError("invalid_arguments");
  return new SupabasePostgresLogicalOffsiteRetrievalStorage(
    input.destinationSupabaseUrl,
    input.destinationServiceRoleKey,
    input.bucketName,
    requestTimeoutMs,
    streamTimeoutMs,
    input.fetchImplementation ?? globalThis.fetch,
    input.clientFactory,
  );
}

export const postgresLogicalOffsiteRetrievalInternals = {
  createReadOnlyArtifactFetch,
  isExactArtifactObjectPath,
};
