import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

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
  type PostgresLogicalSourceStateReceipt,
} from "./postgres-logical-state.js";

export const POSTGRES_LOGICAL_WORM_REGION = "ap-southeast-4" as const;
export const POSTGRES_LOGICAL_WORM_RETENTION_DAYS = 30 as const;
export const POSTGRES_LOGICAL_WORM_PREFIX =
  "_recovery/postgres-logical-backups/v1" as const;
export const POSTGRES_LOGICAL_WORM_CONTRACT =
  "pintpath-postgres-logical-worm-v1" as const;

const RECEIPT_KIND = "pintpath-postgres-logical-worm-receipt" as const;
const CONTRACT_VERSION = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const PRINCIPAL_ARN_PATTERN = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/;
const BUCKET_PATTERN = /^(?!xn--)(?!sthree-)(?!amzn_s3_demo_)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)(?!.*--table-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const BACKUP_ID_PATTERN = /^\d{8}T\d{9}Z-[a-f0-9]{64}$/;
const VERSION_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_MANIFEST_BYTES = 256n * 1024n;
const MAX_STATE_RECEIPT_BYTES = 4n * 1024n * 1024n;
const ABSOLUTE_MAX_ARCHIVE_BYTES = 5n * 1024n * 1024n * 1024n;
const DEFAULT_OPERATION_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OPERATION_TIMEOUT_MS = 30 * 60 * 1000;
const RETENTION_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const IMMUTABLE_CACHE_CONTROL = "private, max-age=2592000, immutable";

export type PostgresLogicalWormFailureCode =
  | "invalid_arguments"
  | "unsafe_backup_directory"
  | "backup_manifest_invalid"
  | "backup_tampered"
  | "authority_identity_mismatch"
  | "authority_not_independent"
  | "destination_pin_mismatch"
  | "destination_unreachable"
  | "bucket_controls_invalid"
  | "writer_not_least_privilege"
  | "object_collision"
  | "object_upload_failed"
  | "object_verification_failed"
  | "retention_proof_failed"
  | "immutable_receipt_failed"
  | "deadline_exceeded"
  | "stream_limit_exceeded";

export class PostgresLogicalWormError extends Error {
  constructor(readonly code: PostgresLogicalWormFailureCode) {
    super(code);
    this.name = "PostgresLogicalWormError";
  }
}

export interface PostgresLogicalWormIdentity {
  readonly accountId: string;
  readonly principalArn: string;
}

export interface PostgresLogicalWormBucketControls {
  readonly region: string;
  readonly versioning: "Enabled" | "Suspended" | null;
  readonly objectLockEnabled: boolean;
  readonly defaultRetentionMode: "COMPLIANCE" | "GOVERNANCE" | null;
  readonly defaultRetentionDays: number | null;
  readonly defaultRetentionYears: number | null;
  readonly blockPublicAcls: boolean;
  readonly ignorePublicAcls: boolean;
  readonly blockPublicPolicy: boolean;
  readonly restrictPublicBuckets: boolean;
  readonly bucketOwnerEnforced: boolean;
  readonly policyIsPublic: boolean;
  readonly defaultEncryptionAlgorithms: readonly string[];
  readonly requesterPays: boolean;
}

export interface PostgresLogicalWormVersionInventory {
  readonly truncated: boolean;
  readonly versions: readonly {
    readonly key: string;
    readonly versionId: string;
    readonly isLatest: boolean;
    readonly bytes: number;
    readonly lastModified: string;
  }[];
  readonly deleteMarkers: readonly {
    readonly key: string;
    readonly versionId: string;
    readonly isLatest: boolean;
  }[];
}

export type PostgresLogicalWormWriterDenialAction =
  | "get_object_version"
  | "list_object_versions"
  | "delete_object_version"
  | "get_object_retention"
  | "get_bucket_object_lock_configuration";

export interface PostgresLogicalWormDenialEvidence {
  readonly action: PostgresLogicalWormWriterDenialAction;
  readonly errorCode: "AccessDenied";
  readonly httpStatusCode: 403;
  readonly requestIdSha256: string;
  readonly extendedRequestIdSha256: string | null;
}

export interface PostgresLogicalWormPutInput {
  readonly key: string;
  readonly body: Readable;
  readonly bytes: number;
  readonly sha256: string;
  readonly checksumSha256Base64: string;
  readonly contentType: "application/octet-stream" | "application/json";
  readonly cacheControl: typeof IMMUTABLE_CACHE_CONTROL;
  readonly metadata: Readonly<Record<string, string>>;
  readonly expectedBucketOwner: string;
  readonly ifNoneMatch: "*";
  readonly checksumAlgorithm: "SHA256";
  readonly serverSideEncryption: "AES256";
  readonly signal: AbortSignal;
}

export interface PostgresLogicalWormPutResult {
  readonly versionId: string;
  readonly checksumSha256Base64: string;
  readonly serverSideEncryption: "AES256";
  readonly eTag: string;
  readonly requestIdSha256: string;
}

export interface PostgresLogicalWormReadResult {
  readonly key: string;
  readonly versionId: string;
  readonly bytes: number;
  readonly checksumSha256Base64: string;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly serverSideEncryption: string;
  readonly objectLockMode: string | null;
  readonly retainUntil: string | null;
  readonly lastModified: string;
  readonly body: AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void };
}

export interface PostgresLogicalWormProvider {
  readonly region: string;
  readonly bucketName: string;
  inspectWriterIdentity(signal: AbortSignal): Promise<PostgresLogicalWormIdentity>;
  inspectReaderIdentity(signal: AbortSignal): Promise<PostgresLogicalWormIdentity>;
  inspectBucketControls(input: {
    readonly expectedBucketOwner: string;
    readonly signal: AbortSignal;
  }): Promise<PostgresLogicalWormBucketControls>;
  listExactVersions(input: {
    readonly key: string;
    readonly expectedBucketOwner: string;
    readonly signal: AbortSignal;
  }): Promise<PostgresLogicalWormVersionInventory>;
  putImmutable(input: PostgresLogicalWormPutInput): Promise<PostgresLogicalWormPutResult>;
  readExactVersion(input: {
    readonly key: string;
    readonly versionId: string;
    readonly expectedBucketOwner: string;
    readonly signal: AbortSignal;
  }): Promise<PostgresLogicalWormReadResult>;
  runWriterDenialCanary(input: {
    readonly action: PostgresLogicalWormWriterDenialAction;
    readonly key: string;
    readonly versionId: string;
    readonly expectedBucketOwner: string;
    readonly signal: AbortSignal;
  }): Promise<PostgresLogicalWormDenialEvidence>;
}

export interface AttestPostgresLogicalWormOptions {
  readonly backupDirectory: string;
  readonly expectedManifestSha256: string;
  readonly bucketName: string;
  readonly expectedBucketNameSha256: string;
  readonly recoveryAccountId: string;
  readonly expectedRecoveryAccountIdSha256: string;
  readonly expectedWriterPrincipalArnSha256: string;
  readonly expectedReaderPrincipalArnSha256: string;
  readonly forbiddenAccountIds?: readonly string[] | undefined;
  readonly operatorId: string;
  readonly provider: PostgresLogicalWormProvider;
  readonly maximumArchiveBytes?: bigint | undefined;
  readonly operationTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface PostgresLogicalWormResult {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly backupCreatedAt: string;
  readonly completedAt: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly stateReceiptSha256: string;
  readonly overallStateSha256: string;
  readonly backupIdSha256: string;
  readonly recoveryAccountIdSha256: string;
  readonly bucketNameSha256: string;
  readonly writerPrincipalArnSha256: string;
  readonly readerPrincipalArnSha256: string;
  readonly immutableObjectSetSha256: string;
  readonly writerDenialSetSha256: string;
  readonly receiptSha256: string;
  readonly receiptObjectKeySha256: string;
  readonly receiptVersionIdSha256: string;
  readonly receiptDenialSetSha256: string;
  readonly minimumRetainUntil: string;
}

export interface PostgresLogicalWormIamPolicyDocument {
  readonly Version: "2012-10-17";
  readonly Statement: readonly {
    readonly Sid: string;
    readonly Effect: "Allow";
    readonly Action: string | readonly string[];
    readonly Resource: string;
    readonly Condition?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  }[];
}

interface TrustedFileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly sha256: string;
  readonly bytes?: Buffer;
}

interface TrustedBackup {
  readonly directoryPath: string;
  readonly directoryDev: bigint;
  readonly directoryIno: bigint;
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly receiptPath: string;
  readonly archive: TrustedFileSnapshot;
  readonly manifest: TrustedFileSnapshot & { readonly bytes: Buffer };
  readonly receipt: TrustedFileSnapshot & { readonly bytes: Buffer };
  readonly parsedManifest: PostgresLogicalBackupManifest;
  readonly parsedReceipt: PostgresLogicalSourceStateReceipt;
}

type WormObjectKind = "archive" | "manifest" | "state-receipt" | "worm-receipt";

interface LocalObject {
  readonly kind: WormObjectKind;
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: "application/octet-stream" | "application/json";
  readonly metadata: Readonly<Record<string, string>>;
  readonly openBody: () => Promise<Readable>;
}

interface VerifiedObjectDescriptor {
  readonly kind: WormObjectKind;
  readonly objectKeySha256: string;
  readonly versionIdSha256: string;
  readonly bytes: string;
  readonly sha256: string;
  readonly checksumSha256Base64Sha256: string;
  readonly contentType: string;
  readonly metadataSha256: string;
  readonly objectLockMode: "COMPLIANCE";
  readonly retainUntil: string;
  readonly lastModified: string;
  readonly created: boolean;
}

interface WormReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly version: typeof CONTRACT_VERSION;
  readonly backupCreatedAt: string;
  readonly verifiedAt: string;
  readonly backupIdSha256: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly stateReceiptSha256: string;
  readonly sourceDatabaseIdentitySha256: string;
  readonly overallStateSha256: string;
  readonly recoveryAccountIdSha256: string;
  readonly bucketNameSha256: string;
  readonly regionSha256: string;
  readonly writerPrincipalArnSha256: string;
  readonly readerPrincipalArnSha256: string;
  readonly operatorIdSha256: string;
  readonly bucketControlsSha256: string;
  readonly objects: readonly VerifiedObjectDescriptor[];
  readonly immutableObjectSetSha256: string;
  readonly writerDenials: readonly PostgresLogicalWormDenialEvidence[];
  readonly writerDenialSetSha256: string;
}

function wormError(code: PostgresLogicalWormFailureCode): PostgresLogicalWormError {
  return new PostgresLogicalWormError(code);
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
    throw wormError("invalid_arguments");
  }
  return normalized;
}

function assertAccountId(value: string): string {
  if (!ACCOUNT_ID_PATTERN.test(value)) throw wormError("invalid_arguments");
  return value;
}

function assertBucketName(value: string): string {
  if (
    !BUCKET_PATTERN.test(value)
    || value.includes("..")
    || /^\d+\.\d+\.\d+\.\d+$/.test(value)
  ) throw wormError("invalid_arguments");
  return value;
}

/**
 * Canonical identity policy for the upload role. It intentionally has no
 * bucket-level, read, list, delete, retention, ACL, or multipart permissions.
 * The S3 default-retention rule applies Object Lock without granting the role
 * s3:PutObjectRetention.
 */
export function buildPostgresLogicalWormWriterPolicy(
  bucketNameInput: string,
): PostgresLogicalWormIamPolicyDocument {
  const bucketName = assertBucketName(bucketNameInput);
  return Object.freeze({
    Version: "2012-10-17",
    Statement: Object.freeze([Object.freeze({
      Sid: "PutOnlyConditionalSseS3WormObjects",
      Effect: "Allow",
      Action: "s3:PutObject",
      Resource: `arn:aws:s3:::${bucketName}/${POSTGRES_LOGICAL_WORM_PREFIX}/*`,
      Condition: Object.freeze({
        StringEquals: Object.freeze({
          "s3:if-none-match": "*",
          "s3:x-amz-server-side-encryption": "AES256",
        }),
      }),
    })]),
  });
}

/** Canonical read-only verifier role policy; no mutating S3 action is present. */
export function buildPostgresLogicalWormReaderPolicy(
  bucketNameInput: string,
): PostgresLogicalWormIamPolicyDocument {
  const bucketName = assertBucketName(bucketNameInput);
  return Object.freeze({
    Version: "2012-10-17",
    Statement: Object.freeze([
      Object.freeze({
        Sid: "InspectPinnedWormBucketControls",
        Effect: "Allow",
        Action: Object.freeze([
          "s3:GetBucketLocation",
          "s3:GetBucketObjectLockConfiguration",
          "s3:GetBucketOwnershipControls",
          "s3:GetBucketPolicyStatus",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketRequestPayment",
          "s3:GetBucketVersioning",
          "s3:GetEncryptionConfiguration",
          "s3:ListBucketVersions",
        ]),
        Resource: `arn:aws:s3:::${bucketName}`,
      }),
      Object.freeze({
        Sid: "VerifyExactWormObjectVersions",
        Effect: "Allow",
        Action: Object.freeze([
          "s3:GetObjectRetention",
          "s3:GetObjectVersion",
        ]),
        Resource: `arn:aws:s3:::${bucketName}/${POSTGRES_LOGICAL_WORM_PREFIX}/*`,
      }),
    ]),
  });
}

function assertPrincipalArn(value: string): string {
  if (!PRINCIPAL_ARN_PATTERN.test(value)) {
    throw wormError("authority_identity_mismatch");
  }
  return value;
}

function assertCanonicalTimestamp(value: string, code: PostgresLogicalWormFailureCode): string {
  if (!CANONICAL_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw wormError(code);
  }
  return value;
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw wormError("invalid_arguments");
  }
  return value.toISOString();
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:.]/g, "");
}

function exactMetadata(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const normalize = (value: Readonly<Record<string, string>>) => Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key.toLowerCase(), entry]),
  );
  return canonicalPostgresBackupJson(normalize(actual))
    === canonicalPostgresBackupJson(normalize(expected));
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
    && left.mode === right.mode
    && left.nlink === right.nlink
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
    handle = await fs.promises.open(
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
      mode: before.mode,
      nlink: before.nlink,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
      sha256: hash.digest("hex"),
      ...(input.retainBytes ? { bytes: Buffer.concat(retained) } : {}),
    };
  } catch (error) {
    if (error instanceof PostgresLogicalWormError) throw error;
    throw wormError(input.invalidCode);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validateLocalBackup(input: {
  readonly backupDirectory: string;
  readonly expectedManifestSha256: string;
  readonly maximumArchiveBytes: bigint;
}): Promise<TrustedBackup> {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 0) throw wormError("invalid_arguments");
  if (
    !path.isAbsolute(input.backupDirectory)
    || path.resolve(input.backupDirectory) !== input.backupDirectory
    || input.backupDirectory.includes("\0")
  ) throw wormError("invalid_arguments");
  let directory: fs.BigIntStats;
  try {
    directory = fs.lstatSync(input.backupDirectory, { bigint: true });
    if (
      !directory.isDirectory()
      || directory.isSymbolicLink()
      || directory.uid !== BigInt(uid!)
      || Number(directory.mode & 0o7777n) !== 0o700
      || fs.realpathSync(input.backupDirectory) !== input.backupDirectory
    ) throw new Error("unsafe");
    const actual = (await fs.promises.readdir(input.backupDirectory)).sort();
    const expected = [
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
    ].sort();
    if (canonicalPostgresBackupJson(actual) !== canonicalPostgresBackupJson(expected)) {
      throw new Error("unexpected entries");
    }
  } catch {
    throw wormError("unsafe_backup_directory");
  }
  const archivePath = path.join(input.backupDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE);
  const manifestPath = path.join(input.backupDirectory, POSTGRES_LOGICAL_BACKUP_MANIFEST);
  const receiptPath = path.join(
    input.backupDirectory,
    POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  );
  const manifest = await snapshotTrustedFile({
    filePath: manifestPath,
    uid: uid!,
    maximumBytes: MAX_MANIFEST_BYTES,
    retainBytes: true,
    invalidCode: "backup_manifest_invalid",
  });
  if (!manifest.bytes || manifest.sha256 !== input.expectedManifestSha256) {
    throw wormError("backup_tampered");
  }
  let parsedManifest: PostgresLogicalBackupManifest;
  try {
    parsedManifest = parsePostgresLogicalBackupManifest(manifest.bytes);
  } catch {
    throw wormError("backup_manifest_invalid");
  }
  if (parsedManifest.schemaVersion !== 3) {
    throw wormError("backup_manifest_invalid");
  }
  const archive = await snapshotTrustedFile({
    filePath: archivePath,
    uid: uid!,
    maximumBytes: input.maximumArchiveBytes,
    retainBytes: false,
    invalidCode: "backup_tampered",
  });
  if (
    archive.size !== BigInt(parsedManifest.archive.bytes)
    || archive.sha256 !== parsedManifest.archive.sha256
  ) throw wormError("backup_tampered");
  const receipt = await snapshotTrustedFile({
    filePath: receiptPath,
    uid: uid!,
    maximumBytes: MAX_STATE_RECEIPT_BYTES,
    retainBytes: true,
    invalidCode: "backup_tampered",
  });
  if (!receipt.bytes || receipt.sha256 !== parsedManifest.state.receiptSha256) {
    throw wormError("backup_tampered");
  }
  let parsedReceipt: PostgresLogicalSourceStateReceipt;
  try {
    parsedReceipt = parsePostgresLogicalSourceStateReceipt(receipt.bytes);
    assertPostgresLogicalBackupStateReceiptBinding(parsedReceipt, parsedManifest);
  } catch {
    throw wormError("backup_manifest_invalid");
  }
  const after = fs.lstatSync(input.backupDirectory, { bigint: true });
  if (after.dev !== directory.dev || after.ino !== directory.ino || !after.isDirectory()) {
    throw wormError("backup_tampered");
  }
  return {
    directoryPath: input.backupDirectory,
    directoryDev: directory.dev,
    directoryIno: directory.ino,
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

async function assertBackupUnchanged(
  backup: TrustedBackup,
  maximumArchiveBytes: bigint,
): Promise<void> {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 0) throw wormError("backup_tampered");
  let directory: fs.BigIntStats;
  try {
    directory = fs.lstatSync(backup.directoryPath, { bigint: true });
  } catch {
    throw wormError("backup_tampered");
  }
  if (
    !directory.isDirectory()
    || directory.dev !== backup.directoryDev
    || directory.ino !== backup.directoryIno
  ) throw wormError("backup_tampered");
  const [archive, manifest, receipt] = await Promise.all([
    snapshotTrustedFile({
      filePath: backup.archivePath,
      uid: uid!,
      maximumBytes: maximumArchiveBytes,
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
  ) throw wormError("backup_tampered");
}

function timeoutMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1_000
    || resolved > MAX_OPERATION_TIMEOUT_MS
  ) throw wormError("invalid_arguments");
  return resolved;
}

async function boundedOperation<T>(
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref?.();
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw wormError("deadline_exceeded");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeChunk(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array)) throw wormError("object_verification_failed");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

async function hashBoundedBody(input: {
  readonly body: PostgresLogicalWormReadResult["body"];
  readonly maximumBytes: number;
  readonly signal: AbortSignal;
}): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const abort = () => input.body.destroy?.(new Error("aborted"));
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const raw of input.body) {
      if (input.signal.aborted) throw wormError("deadline_exceeded");
      const chunk = normalizeChunk(raw);
      bytes += chunk.length;
      if (bytes > input.maximumBytes) {
        input.body.destroy?.(new Error("stream limit exceeded"));
        throw wormError("stream_limit_exceeded");
      }
      hash.update(chunk);
    }
    if (input.signal.aborted) throw wormError("deadline_exceeded");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    input.signal.removeEventListener("abort", abort);
  }
}

function assertBucketControls(controls: PostgresLogicalWormBucketControls): void {
  const algorithms = [...controls.defaultEncryptionAlgorithms].sort();
  if (
    controls.region !== POSTGRES_LOGICAL_WORM_REGION
    || controls.versioning !== "Enabled"
    || !controls.objectLockEnabled
    || controls.defaultRetentionMode !== "COMPLIANCE"
    || controls.defaultRetentionDays !== POSTGRES_LOGICAL_WORM_RETENTION_DAYS
    || controls.defaultRetentionYears !== null
    || !controls.blockPublicAcls
    || !controls.ignorePublicAcls
    || !controls.blockPublicPolicy
    || !controls.restrictPublicBuckets
    || !controls.bucketOwnerEnforced
    || controls.policyIsPublic
    || canonicalPostgresBackupJson(algorithms)
      !== canonicalPostgresBackupJson(["AES256"])
    || controls.requesterPays
  ) throw wormError("bucket_controls_invalid");
}

function assertAuthority(input: {
  readonly writer: PostgresLogicalWormIdentity;
  readonly reader: PostgresLogicalWormIdentity;
  readonly recoveryAccountId: string;
  readonly expectedWriterPrincipalArnSha256: string;
  readonly expectedReaderPrincipalArnSha256: string;
  readonly forbiddenAccountIds: readonly string[];
}): void {
  const writerArn = assertPrincipalArn(input.writer.principalArn);
  const readerArn = assertPrincipalArn(input.reader.principalArn);
  if (
    input.writer.accountId !== input.recoveryAccountId
    || input.reader.accountId !== input.recoveryAccountId
    || sha256(writerArn) !== input.expectedWriterPrincipalArnSha256
    || sha256(readerArn) !== input.expectedReaderPrincipalArnSha256
  ) throw wormError("authority_identity_mismatch");
  if (
    writerArn === readerArn
    || input.forbiddenAccountIds.includes(input.recoveryAccountId)
  ) throw wormError("authority_not_independent");
}

function metadataFor(input: {
  readonly kind: WormObjectKind;
  readonly sha256: string;
  readonly manifestSha256: string;
  readonly backupIdSha256: string;
}): Readonly<Record<string, string>> {
  return Object.freeze({
    contract: POSTGRES_LOGICAL_WORM_CONTRACT,
    objectkind: input.kind,
    sha256: input.sha256,
    manifestsha256: input.manifestSha256,
    backupidsha256: input.backupIdSha256,
  });
}

async function openTrustedBody(input: {
  readonly filePath: string;
  readonly snapshot: TrustedFileSnapshot;
}): Promise<Readable> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      input.filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== input.snapshot.dev
      || opened.ino !== input.snapshot.ino
      || opened.mode !== input.snapshot.mode
      || opened.nlink !== input.snapshot.nlink
      || opened.size !== input.snapshot.size
      || opened.mtimeNs !== input.snapshot.mtimeNs
      || opened.ctimeNs !== input.snapshot.ctimeNs
    ) throw new Error("changed");
    const stream = handle.createReadStream({ autoClose: true });
    handle = null;
    return stream;
  } catch {
    await handle?.close().catch(() => undefined);
    throw wormError("backup_tampered");
  }
}

function assertVersionInventory(
  inventory: PostgresLogicalWormVersionInventory,
  key: string,
): PostgresLogicalWormVersionInventory["versions"][number] | null {
  if (
    inventory.truncated
    || inventory.deleteMarkers.length > 0
    || inventory.versions.some((version) => version.key !== key)
    || inventory.deleteMarkers.some((marker) => marker.key !== key)
    || inventory.versions.length > 1
  ) throw wormError("object_collision");
  const version = inventory.versions[0];
  if (!version) return null;
  if (
    !VERSION_ID_PATTERN.test(version.versionId)
    || !version.isLatest
    || !Number.isSafeInteger(version.bytes)
    || version.bytes < 1
  ) throw wormError("object_collision");
  assertCanonicalTimestamp(version.lastModified, "object_collision");
  return version;
}

function validateDenialEvidence(
  evidence: PostgresLogicalWormDenialEvidence,
  action: PostgresLogicalWormWriterDenialAction,
): PostgresLogicalWormDenialEvidence {
  if (
    evidence.action !== action
    || evidence.errorCode !== "AccessDenied"
    || evidence.httpStatusCode !== 403
    || !SHA256_PATTERN.test(evidence.requestIdSha256)
    || (
      evidence.extendedRequestIdSha256 !== null
      && !SHA256_PATTERN.test(evidence.extendedRequestIdSha256)
    )
  ) throw wormError("writer_not_least_privilege");
  return evidence;
}

async function writerDenialProof(input: {
  readonly provider: PostgresLogicalWormProvider;
  readonly key: string;
  readonly versionId: string;
  readonly expectedBucketOwner: string;
  readonly operationTimeoutMs: number;
}): Promise<readonly PostgresLogicalWormDenialEvidence[]> {
  const actions: readonly PostgresLogicalWormWriterDenialAction[] = [
    "get_object_version",
    "list_object_versions",
    "delete_object_version",
    "get_object_retention",
    "get_bucket_object_lock_configuration",
  ];
  const evidence: PostgresLogicalWormDenialEvidence[] = [];
  for (const action of actions) {
    let value: PostgresLogicalWormDenialEvidence;
    try {
      value = await boundedOperation(input.operationTimeoutMs, (signal) => (
        input.provider.runWriterDenialCanary({
          action,
          key: input.key,
          versionId: input.versionId,
          expectedBucketOwner: input.expectedBucketOwner,
          signal,
        })
      ));
    } catch (error) {
      if (error instanceof PostgresLogicalWormError) throw error;
      throw wormError("writer_not_least_privilege");
    }
    evidence.push(validateDenialEvidence(value, action));
  }
  return Object.freeze(evidence);
}

async function verifyRemoteObject(input: {
  readonly provider: PostgresLogicalWormProvider;
  readonly local: LocalObject;
  readonly versionId: string;
  readonly expectedBucketOwner: string;
  readonly earliestRetentionBaseMs: number;
  readonly operationTimeoutMs: number;
  readonly created: boolean;
}): Promise<VerifiedObjectDescriptor> {
  let remote: PostgresLogicalWormReadResult;
  let streamed: { readonly bytes: number; readonly sha256: string };
  try {
    ({ remote, streamed } = await boundedOperation(
      input.operationTimeoutMs,
      async (signal) => {
        const value = await input.provider.readExactVersion({
          key: input.local.key,
          versionId: input.versionId,
          expectedBucketOwner: input.expectedBucketOwner,
          signal,
        });
        const digest = await hashBoundedBody({
          body: value.body,
          maximumBytes: input.local.bytes,
          signal,
        });
        return { remote: value, streamed: digest };
      },
    ));
  } catch (error) {
    if (error instanceof PostgresLogicalWormError) throw error;
    throw wormError("object_verification_failed");
  }
  if (
    remote.key !== input.local.key
    || remote.versionId !== input.versionId
    || remote.bytes !== input.local.bytes
    || streamed.bytes !== input.local.bytes
    || streamed.sha256 !== input.local.sha256
    || remote.checksumSha256Base64
      !== Buffer.from(input.local.sha256, "hex").toString("base64")
    || remote.contentType.toLowerCase() !== input.local.contentType
    || remote.cacheControl.toLowerCase() !== IMMUTABLE_CACHE_CONTROL
    || !exactMetadata(remote.metadata, input.local.metadata)
    || remote.serverSideEncryption !== "AES256"
  ) throw wormError("object_verification_failed");
  const lastModified = assertCanonicalTimestamp(
    remote.lastModified,
    "object_verification_failed",
  );
  const retainUntil = remote.retainUntil
    ? assertCanonicalTimestamp(remote.retainUntil, "retention_proof_failed")
    : null;
  const minimumRetainMs = input.earliestRetentionBaseMs
    + POSTGRES_LOGICAL_WORM_RETENTION_DAYS * 24 * 60 * 60 * 1000
    - RETENTION_CLOCK_TOLERANCE_MS;
  if (
    remote.objectLockMode !== "COMPLIANCE"
    || retainUntil === null
    || Date.parse(retainUntil) < minimumRetainMs
    || Date.parse(retainUntil) <= Date.parse(lastModified)
  ) throw wormError("retention_proof_failed");
  return Object.freeze({
    kind: input.local.kind,
    objectKeySha256: sha256(input.local.key),
    versionIdSha256: sha256(input.versionId),
    bytes: String(input.local.bytes),
    sha256: input.local.sha256,
    checksumSha256Base64Sha256: sha256(remote.checksumSha256Base64),
    contentType: input.local.contentType,
    metadataSha256: canonicalSha256(input.local.metadata),
    objectLockMode: "COMPLIANCE",
    retainUntil,
    lastModified,
    created: input.created,
  });
}

async function ensureAndVerifyObject(input: {
  readonly provider: PostgresLogicalWormProvider;
  readonly local: LocalObject;
  readonly expectedBucketOwner: string;
  readonly earliestRetentionBaseMs: number;
  readonly operationTimeoutMs: number;
}): Promise<{ readonly descriptor: VerifiedObjectDescriptor; readonly versionId: string }> {
  let before: PostgresLogicalWormVersionInventory;
  try {
    before = await boundedOperation(input.operationTimeoutMs, (signal) => (
      input.provider.listExactVersions({
        key: input.local.key,
        expectedBucketOwner: input.expectedBucketOwner,
        signal,
      })
    ));
  } catch (error) {
    if (error instanceof PostgresLogicalWormError) throw error;
    throw wormError("destination_unreachable");
  }
  let version = assertVersionInventory(before, input.local.key);
  let created = false;
  let createdVersionId: string | null = null;
  if (!version) {
    const body = await input.local.openBody();
    try {
      const put = await boundedOperation(input.operationTimeoutMs, (signal) => (
        input.provider.putImmutable({
          key: input.local.key,
          body,
          bytes: input.local.bytes,
          sha256: input.local.sha256,
          checksumSha256Base64: Buffer.from(input.local.sha256, "hex").toString("base64"),
          contentType: input.local.contentType,
          cacheControl: IMMUTABLE_CACHE_CONTROL,
          metadata: input.local.metadata,
          expectedBucketOwner: input.expectedBucketOwner,
          ifNoneMatch: "*",
          checksumAlgorithm: "SHA256",
          serverSideEncryption: "AES256",
          signal,
        })
      ));
      if (
        !VERSION_ID_PATTERN.test(put.versionId)
        || put.checksumSha256Base64
          !== Buffer.from(input.local.sha256, "hex").toString("base64")
        || put.serverSideEncryption !== "AES256"
        || !put.eTag
        || !SHA256_PATTERN.test(put.requestIdSha256)
      ) throw wormError("object_upload_failed");
      created = true;
      createdVersionId = put.versionId;
    } catch (error) {
      if (error instanceof PostgresLogicalWormError) throw error;
      // A concurrent identical conditional write is accepted only after the
      // independent reader proves that there is one exact protected version.
    } finally {
      body.destroy();
    }
    let after: PostgresLogicalWormVersionInventory;
    try {
      after = await boundedOperation(input.operationTimeoutMs, (signal) => (
        input.provider.listExactVersions({
          key: input.local.key,
          expectedBucketOwner: input.expectedBucketOwner,
          signal,
        })
      ));
    } catch {
      throw wormError("object_upload_failed");
    }
    version = assertVersionInventory(after, input.local.key);
    if (!version) throw wormError("object_upload_failed");
    if (createdVersionId !== null && version.versionId !== createdVersionId) {
      throw wormError("object_collision");
    }
  }
  if (version.bytes !== input.local.bytes) throw wormError("object_collision");
  const descriptor = await verifyRemoteObject({
    provider: input.provider,
    local: input.local,
    versionId: version.versionId,
    expectedBucketOwner: input.expectedBucketOwner,
    earliestRetentionBaseMs: input.earliestRetentionBaseMs,
    operationTimeoutMs: input.operationTimeoutMs,
    created,
  });
  return { descriptor, versionId: version.versionId };
}

function objectKey(backupId: string, filename: string): string {
  if (!BACKUP_ID_PATTERN.test(backupId)) throw wormError("backup_manifest_invalid");
  if (![
    POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    POSTGRES_LOGICAL_BACKUP_MANIFEST,
    POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  ].includes(filename as typeof POSTGRES_LOGICAL_BACKUP_ARCHIVE)) {
    throw wormError("invalid_arguments");
  }
  return `${POSTGRES_LOGICAL_WORM_PREFIX}/backups/${backupId}/${filename}`;
}

function receiptKey(backupId: string, receiptSha256: string): string {
  if (!BACKUP_ID_PATTERN.test(backupId) || !SHA256_PATTERN.test(receiptSha256)) {
    throw wormError("invalid_arguments");
  }
  return `${POSTGRES_LOGICAL_WORM_PREFIX}/receipts/${backupId}/${receiptSha256}.json`;
}

function minimumRetainUntil(objects: readonly VerifiedObjectDescriptor[]): string {
  if (objects.length < 1) throw wormError("retention_proof_failed");
  return objects.map((value) => value.retainUntil).sort()[0]!;
}

export async function attestPostgresLogicalWorm(
  options: AttestPostgresLogicalWormOptions,
): Promise<PostgresLogicalWormResult> {
  const expectedManifestSha256 = assertSha256(options.expectedManifestSha256);
  const bucketName = assertBucketName(options.bucketName);
  const expectedBucketNameSha256 = assertSha256(options.expectedBucketNameSha256);
  const recoveryAccountId = assertAccountId(options.recoveryAccountId);
  const expectedRecoveryAccountIdSha256 = assertSha256(
    options.expectedRecoveryAccountIdSha256,
  );
  const expectedWriterPrincipalArnSha256 = assertSha256(
    options.expectedWriterPrincipalArnSha256,
  );
  const expectedReaderPrincipalArnSha256 = assertSha256(
    options.expectedReaderPrincipalArnSha256,
  );
  if (
    sha256(bucketName) !== expectedBucketNameSha256
    || sha256(recoveryAccountId) !== expectedRecoveryAccountIdSha256
    || options.provider.bucketName !== bucketName
    || options.provider.region !== POSTGRES_LOGICAL_WORM_REGION
  ) throw wormError("destination_pin_mismatch");
  const forbiddenAccountIds = (options.forbiddenAccountIds ?? []).map(assertAccountId);
  if (new Set(forbiddenAccountIds).size !== forbiddenAccountIds.length) {
    throw wormError("invalid_arguments");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{0,254}$/.test(options.operatorId)) {
    throw wormError("invalid_arguments");
  }
  const maximumArchiveBytes = options.maximumArchiveBytes ?? ABSOLUTE_MAX_ARCHIVE_BYTES;
  if (maximumArchiveBytes < 1n || maximumArchiveBytes > ABSOLUTE_MAX_ARCHIVE_BYTES) {
    throw wormError("invalid_arguments");
  }
  const operationTimeoutMs = timeoutMs(options.operationTimeoutMs);
  const now = options.now ?? (() => new Date());
  const startedAt = canonicalNow(now);
  const startedAtMs = Date.parse(startedAt);
  const backup = await validateLocalBackup({
    backupDirectory: options.backupDirectory,
    expectedManifestSha256,
    maximumArchiveBytes,
  });
  if (Date.parse(backup.parsedManifest.createdAt) > startedAtMs) {
    throw wormError("backup_manifest_invalid");
  }

  let writer: PostgresLogicalWormIdentity;
  let reader: PostgresLogicalWormIdentity;
  let controls: PostgresLogicalWormBucketControls;
  try {
    [writer, reader, controls] = await Promise.all([
      boundedOperation(operationTimeoutMs, (signal) => (
        options.provider.inspectWriterIdentity(signal)
      )),
      boundedOperation(operationTimeoutMs, (signal) => (
        options.provider.inspectReaderIdentity(signal)
      )),
      boundedOperation(operationTimeoutMs, (signal) => (
        options.provider.inspectBucketControls({
          expectedBucketOwner: recoveryAccountId,
          signal,
        })
      )),
    ]);
  } catch (error) {
    if (error instanceof PostgresLogicalWormError) throw error;
    throw wormError("destination_unreachable");
  }
  assertAuthority({
    writer,
    reader,
    recoveryAccountId,
    expectedWriterPrincipalArnSha256,
    expectedReaderPrincipalArnSha256,
    forbiddenAccountIds,
  });
  assertBucketControls(controls);

  const backupId = `${compactTimestamp(backup.parsedManifest.createdAt)}-${backup.manifest.sha256}`;
  if (!BACKUP_ID_PATTERN.test(backupId)) throw wormError("backup_manifest_invalid");
  const backupIdSha256 = sha256(backupId);
  const common = {
    manifestSha256: backup.manifest.sha256,
    backupIdSha256,
  };
  const objects: readonly LocalObject[] = [
    {
      kind: "archive",
      key: objectKey(backupId, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
      bytes: Number(backup.archive.size),
      sha256: backup.archive.sha256,
      contentType: "application/octet-stream",
      metadata: metadataFor({
        kind: "archive",
        sha256: backup.archive.sha256,
        ...common,
      }),
      openBody: () => openTrustedBody({
        filePath: backup.archivePath,
        snapshot: backup.archive,
      }),
    },
    {
      kind: "manifest",
      key: objectKey(backupId, POSTGRES_LOGICAL_BACKUP_MANIFEST),
      bytes: Number(backup.manifest.size),
      sha256: backup.manifest.sha256,
      contentType: "application/json",
      metadata: metadataFor({
        kind: "manifest",
        sha256: backup.manifest.sha256,
        ...common,
      }),
      openBody: async () => Readable.from([backup.manifest.bytes]),
    },
    {
      kind: "state-receipt",
      key: objectKey(backupId, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT),
      bytes: Number(backup.receipt.size),
      sha256: backup.receipt.sha256,
      contentType: "application/json",
      metadata: metadataFor({
        kind: "state-receipt",
        sha256: backup.receipt.sha256,
        ...common,
      }),
      openBody: async () => Readable.from([backup.receipt.bytes]),
    },
  ];
  const verified: VerifiedObjectDescriptor[] = [];
  let archiveVersionId = "";
  for (const local of objects) {
    const remote = await ensureAndVerifyObject({
      provider: options.provider,
      local,
      expectedBucketOwner: recoveryAccountId,
      earliestRetentionBaseMs: startedAtMs,
      operationTimeoutMs,
    });
    verified.push(remote.descriptor);
    if (local.kind === "archive") archiveVersionId = remote.versionId;
    await assertBackupUnchanged(backup, maximumArchiveBytes);
  }
  if (!archiveVersionId) throw wormError("object_verification_failed");
  const writerDenials = await writerDenialProof({
    provider: options.provider,
    key: objects[0]!.key,
    versionId: archiveVersionId,
    expectedBucketOwner: recoveryAccountId,
    operationTimeoutMs,
  });
  const immutableObjectSetSha256 = canonicalSha256(verified);
  const writerDenialSetSha256 = canonicalSha256(writerDenials);
  const verifiedAt = canonicalNow(now);
  const receipt: WormReceipt = Object.freeze({
    kind: RECEIPT_KIND,
    version: CONTRACT_VERSION,
    backupCreatedAt: backup.parsedManifest.createdAt,
    verifiedAt,
    backupIdSha256,
    archiveSha256: backup.archive.sha256,
    manifestSha256: backup.manifest.sha256,
    stateReceiptSha256: backup.receipt.sha256,
    sourceDatabaseIdentitySha256:
      backup.parsedManifest.state.sourceDatabaseIdentitySha256,
    overallStateSha256: backup.parsedManifest.state.overallStateSha256,
    recoveryAccountIdSha256: expectedRecoveryAccountIdSha256,
    bucketNameSha256: expectedBucketNameSha256,
    regionSha256: sha256(POSTGRES_LOGICAL_WORM_REGION),
    writerPrincipalArnSha256: sha256(writer.principalArn),
    readerPrincipalArnSha256: sha256(reader.principalArn),
    operatorIdSha256: sha256(options.operatorId),
    bucketControlsSha256: canonicalSha256(controls),
    objects: Object.freeze(verified),
    immutableObjectSetSha256,
    writerDenials,
    writerDenialSetSha256,
  });
  const receiptBytes = Buffer.from(canonicalPostgresBackupJson(receipt), "utf8");
  const receiptSha256 = sha256(receiptBytes);
  const receiptObject: LocalObject = {
    kind: "worm-receipt",
    key: receiptKey(backupId, receiptSha256),
    bytes: receiptBytes.length,
    sha256: receiptSha256,
    contentType: "application/json",
    metadata: metadataFor({
      kind: "worm-receipt",
      sha256: receiptSha256,
      ...common,
    }),
    openBody: async () => Readable.from([receiptBytes]),
  };
  let receiptRemote: {
    readonly descriptor: VerifiedObjectDescriptor;
    readonly versionId: string;
  };
  try {
    receiptRemote = await ensureAndVerifyObject({
      provider: options.provider,
      local: receiptObject,
      expectedBucketOwner: recoveryAccountId,
      earliestRetentionBaseMs: startedAtMs,
      operationTimeoutMs,
    });
  } catch (error) {
    if (error instanceof PostgresLogicalWormError) {
      if (["deadline_exceeded", "stream_limit_exceeded"].includes(error.code)) throw error;
      throw wormError("immutable_receipt_failed");
    }
    throw wormError("immutable_receipt_failed");
  }
  const receiptDenials = await writerDenialProof({
    provider: options.provider,
    key: receiptObject.key,
    versionId: receiptRemote.versionId,
    expectedBucketOwner: recoveryAccountId,
    operationTimeoutMs,
  });
  await assertBackupUnchanged(backup, maximumArchiveBytes);
  const completedAt = canonicalNow(now);
  return Object.freeze({
    schemaVersion: 1,
    ok: true,
    backupCreatedAt: backup.parsedManifest.createdAt,
    completedAt,
    archiveSha256: backup.archive.sha256,
    manifestSha256: backup.manifest.sha256,
    stateReceiptSha256: backup.receipt.sha256,
    overallStateSha256: backup.parsedManifest.state.overallStateSha256,
    backupIdSha256,
    recoveryAccountIdSha256: expectedRecoveryAccountIdSha256,
    bucketNameSha256: expectedBucketNameSha256,
    writerPrincipalArnSha256: sha256(writer.principalArn),
    readerPrincipalArnSha256: sha256(reader.principalArn),
    immutableObjectSetSha256,
    writerDenialSetSha256,
    receiptSha256,
    receiptObjectKeySha256: receiptRemote.descriptor.objectKeySha256,
    receiptVersionIdSha256: receiptRemote.descriptor.versionIdSha256,
    receiptDenialSetSha256: canonicalSha256(receiptDenials),
    minimumRetainUntil: minimumRetainUntil([
      ...verified,
      receiptRemote.descriptor,
    ]),
  });
}

export interface AwsSdkV3WormClient {
  send(
    command: unknown,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

export interface AwsSdkV3WormCommandConstructor {
  new(input: Readonly<Record<string, unknown>>): unknown;
}

export interface AwsSdkV3WormCommands {
  readonly GetCallerIdentityCommand: AwsSdkV3WormCommandConstructor;
  readonly PutObjectCommand: AwsSdkV3WormCommandConstructor;
  readonly GetObjectCommand: AwsSdkV3WormCommandConstructor;
  readonly GetObjectRetentionCommand: AwsSdkV3WormCommandConstructor;
  readonly DeleteObjectCommand: AwsSdkV3WormCommandConstructor;
  readonly ListObjectVersionsCommand: AwsSdkV3WormCommandConstructor;
  readonly GetBucketLocationCommand: AwsSdkV3WormCommandConstructor;
  readonly GetBucketVersioningCommand: AwsSdkV3WormCommandConstructor;
  readonly GetObjectLockConfigurationCommand: AwsSdkV3WormCommandConstructor;
  readonly GetPublicAccessBlockCommand: AwsSdkV3WormCommandConstructor;
  readonly GetBucketOwnershipControlsCommand: AwsSdkV3WormCommandConstructor;
  readonly GetBucketEncryptionCommand: AwsSdkV3WormCommandConstructor;
  readonly GetBucketPolicyStatusCommand: AwsSdkV3WormCommandConstructor;
  readonly GetBucketRequestPaymentCommand: AwsSdkV3WormCommandConstructor;
}

function awsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw wormError("destination_unreachable");
  }
  return value as Record<string, unknown>;
}

function awsOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function awsString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function awsBoolean(value: unknown): boolean {
  return value === true;
}

function awsTimestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function awsMetadata(value: unknown): Readonly<Record<string, string>> {
  const record = awsOptionalRecord(value);
  if (!record) return Object.freeze({});
  const entries: [string, string][] = [];
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") throw wormError("object_verification_failed");
    entries.push([key.toLowerCase(), entry]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function normalizedCallerPrincipalArn(accountId: string, value: unknown): string {
  const arn = awsString(value);
  if (!arn) throw wormError("authority_identity_mismatch");
  const assumedPrefix = `arn:aws:sts::${accountId}:assumed-role/`;
  if (arn.startsWith(assumedPrefix)) {
    const resource = arn.slice(assumedPrefix.length);
    const slash = resource.lastIndexOf("/");
    if (slash < 1 || slash === resource.length - 1) {
      throw wormError("authority_identity_mismatch");
    }
    return assertPrincipalArn(`arn:aws:iam::${accountId}:role/${resource.slice(0, slash)}`);
  }
  return assertPrincipalArn(arn);
}

function awsRequestIdSha256(value: unknown): string {
  const metadata = awsOptionalRecord(awsOptionalRecord(value)?.$metadata);
  const requestId = awsString(metadata?.requestId);
  if (!requestId) throw wormError("destination_unreachable");
  return sha256(requestId);
}

function awsExtendedRequestIdSha256(value: unknown): string | null {
  const metadata = awsOptionalRecord(awsOptionalRecord(value)?.$metadata);
  const requestId = awsString(metadata?.extendedRequestId);
  return requestId ? sha256(requestId) : null;
}

function exactAwsAccessDenied(
  error: unknown,
  action: PostgresLogicalWormWriterDenialAction,
): PostgresLogicalWormDenialEvidence {
  const record = awsOptionalRecord(error);
  const metadata = awsOptionalRecord(record?.$metadata);
  const code = awsString(record?.name) ?? awsString(record?.Code) ?? awsString(record?.code);
  const status = metadata?.httpStatusCode;
  const requestId = awsString(metadata?.requestId);
  if (code !== "AccessDenied" || status !== 403 || !requestId) {
    throw wormError("writer_not_least_privilege");
  }
  const extended = awsString(metadata?.extendedRequestId);
  return Object.freeze({
    action,
    errorCode: "AccessDenied",
    httpStatusCode: 403,
    requestIdSha256: sha256(requestId),
    extendedRequestIdSha256: extended ? sha256(extended) : null,
  });
}

function awsCommand(
  Constructor: AwsSdkV3WormCommandConstructor,
  input: Readonly<Record<string, unknown>>,
): unknown {
  return new Constructor(input);
}

async function awsSend(
  client: AwsSdkV3WormClient,
  Constructor: AwsSdkV3WormCommandConstructor,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return awsRecord(await client.send(
    awsCommand(Constructor, input),
    { abortSignal: signal },
  ));
}

function bucketInput(bucketName: string, expectedBucketOwner: string): Record<string, unknown> {
  return { Bucket: bucketName, ExpectedBucketOwner: expectedBucketOwner };
}

/**
 * Thin adapter around AWS SDK for JavaScript v3 clients. The SDK is injected so
 * the core contract remains testable and so importing this module never reads
 * an AWS credential chain. PutObject deliberately omits retention headers: the
 * bucket's verified default retention applies COMPLIANCE mode while the writer
 * needs only s3:PutObject.
 */
export function createAwsSdkV3PostgresLogicalWormProvider(input: {
  readonly region: typeof POSTGRES_LOGICAL_WORM_REGION;
  readonly bucketName: string;
  readonly writerS3: AwsSdkV3WormClient;
  readonly readerS3: AwsSdkV3WormClient;
  readonly writerSts: AwsSdkV3WormClient;
  readonly readerSts: AwsSdkV3WormClient;
  readonly commands: AwsSdkV3WormCommands;
}): PostgresLogicalWormProvider {
  const bucketName = assertBucketName(input.bucketName);
  if (input.region !== POSTGRES_LOGICAL_WORM_REGION) {
    throw wormError("destination_pin_mismatch");
  }
  const identity = async (
    client: AwsSdkV3WormClient,
    signal: AbortSignal,
  ): Promise<PostgresLogicalWormIdentity> => {
    const response = await awsSend(
      client,
      input.commands.GetCallerIdentityCommand,
      {},
      signal,
    );
    const accountId = awsString(response.Account);
    if (!accountId || !ACCOUNT_ID_PATTERN.test(accountId)) {
      throw wormError("authority_identity_mismatch");
    }
    return Object.freeze({
      accountId,
      principalArn: normalizedCallerPrincipalArn(accountId, response.Arn),
    });
  };
  const provider: PostgresLogicalWormProvider = {
    region: input.region,
    bucketName,
    inspectWriterIdentity: (signal) => identity(input.writerSts, signal),
    inspectReaderIdentity: (signal) => identity(input.readerSts, signal),
    inspectBucketControls: async ({ expectedBucketOwner, signal }) => {
      const common = bucketInput(bucketName, expectedBucketOwner);
      const [
        location,
        versioning,
        objectLock,
        publicAccess,
        ownership,
        encryption,
        policy,
        payment,
      ] = await Promise.all([
        awsSend(input.readerS3, input.commands.GetBucketLocationCommand, common, signal),
        awsSend(input.readerS3, input.commands.GetBucketVersioningCommand, common, signal),
        awsSend(
          input.readerS3,
          input.commands.GetObjectLockConfigurationCommand,
          common,
          signal,
        ),
        awsSend(input.readerS3, input.commands.GetPublicAccessBlockCommand, common, signal),
        awsSend(
          input.readerS3,
          input.commands.GetBucketOwnershipControlsCommand,
          common,
          signal,
        ),
        awsSend(input.readerS3, input.commands.GetBucketEncryptionCommand, common, signal),
        awsSend(input.readerS3, input.commands.GetBucketPolicyStatusCommand, common, signal),
        awsSend(input.readerS3, input.commands.GetBucketRequestPaymentCommand, common, signal),
      ]);
      const lockConfiguration = awsOptionalRecord(objectLock.ObjectLockConfiguration);
      const lockRule = awsOptionalRecord(lockConfiguration?.Rule);
      const defaultRetention = awsOptionalRecord(lockRule?.DefaultRetention);
      const block = awsOptionalRecord(publicAccess.PublicAccessBlockConfiguration);
      const ownershipControls = awsOptionalRecord(ownership.OwnershipControls);
      const ownershipRules = Array.isArray(ownershipControls?.Rules)
        ? ownershipControls.Rules.map(awsOptionalRecord)
        : [];
      const encryptionConfiguration = awsOptionalRecord(
        encryption.ServerSideEncryptionConfiguration,
      );
      const encryptionRules = Array.isArray(encryptionConfiguration?.Rules)
        ? encryptionConfiguration.Rules.map(awsOptionalRecord)
        : [];
      const algorithms = encryptionRules.map((rule) => {
        const defaultEncryption = awsOptionalRecord(rule?.ApplyServerSideEncryptionByDefault);
        return awsString(defaultEncryption?.SSEAlgorithm) ?? "";
      });
      const policyStatus = awsOptionalRecord(policy.PolicyStatus);
      return Object.freeze({
        region: awsString(location.LocationConstraint) ?? "us-east-1",
        versioning: versioning.Status === "Enabled"
          ? "Enabled"
          : versioning.Status === "Suspended" ? "Suspended" : null,
        objectLockEnabled: lockConfiguration?.ObjectLockEnabled === "Enabled",
        defaultRetentionMode: defaultRetention?.Mode === "COMPLIANCE"
          ? "COMPLIANCE"
          : defaultRetention?.Mode === "GOVERNANCE" ? "GOVERNANCE" : null,
        defaultRetentionDays: typeof defaultRetention?.Days === "number"
          ? defaultRetention.Days
          : null,
        defaultRetentionYears: typeof defaultRetention?.Years === "number"
          ? defaultRetention.Years
          : null,
        blockPublicAcls: awsBoolean(block?.BlockPublicAcls),
        ignorePublicAcls: awsBoolean(block?.IgnorePublicAcls),
        blockPublicPolicy: awsBoolean(block?.BlockPublicPolicy),
        restrictPublicBuckets: awsBoolean(block?.RestrictPublicBuckets),
        bucketOwnerEnforced: ownershipRules.length === 1
          && ownershipRules[0]?.ObjectOwnership === "BucketOwnerEnforced",
        policyIsPublic: policyStatus?.IsPublic === true,
        defaultEncryptionAlgorithms: Object.freeze(algorithms),
        requesterPays: payment.Payer === "Requester",
      });
    },
    listExactVersions: async ({ key, expectedBucketOwner, signal }) => {
      const response = await awsSend(
        input.readerS3,
        input.commands.ListObjectVersionsCommand,
        {
          ...bucketInput(bucketName, expectedBucketOwner),
          Prefix: key,
          MaxKeys: 1000,
        },
        signal,
      );
      const versions = Array.isArray(response.Versions) ? response.Versions : [];
      const deleteMarkers = Array.isArray(response.DeleteMarkers)
        ? response.DeleteMarkers
        : [];
      return Object.freeze({
        truncated: response.IsTruncated === true,
        versions: Object.freeze(versions.map((raw) => {
          const value = awsRecord(raw);
          const versionKey = awsString(value.Key);
          const versionId = awsString(value.VersionId);
          const lastModified = awsTimestamp(value.LastModified);
          if (
            !versionKey
            || !versionId
            || !lastModified
            || typeof value.Size !== "number"
          ) throw wormError("destination_unreachable");
          return Object.freeze({
            key: versionKey,
            versionId,
            isLatest: value.IsLatest === true,
            bytes: value.Size,
            lastModified,
          });
        })),
        deleteMarkers: Object.freeze(deleteMarkers.map((raw) => {
          const value = awsRecord(raw);
          const markerKey = awsString(value.Key);
          const versionId = awsString(value.VersionId);
          if (!markerKey || !versionId) throw wormError("destination_unreachable");
          return Object.freeze({
            key: markerKey,
            versionId,
            isLatest: value.IsLatest === true,
          });
        })),
      });
    },
    putImmutable: async (putInput) => {
      const response = await awsSend(
        input.writerS3,
        input.commands.PutObjectCommand,
        {
          ...bucketInput(bucketName, putInput.expectedBucketOwner),
          Key: putInput.key,
          Body: putInput.body,
          ContentLength: putInput.bytes,
          ContentType: putInput.contentType,
          CacheControl: putInput.cacheControl,
          Metadata: putInput.metadata,
          IfNoneMatch: putInput.ifNoneMatch,
          ChecksumAlgorithm: putInput.checksumAlgorithm,
          ChecksumSHA256: putInput.checksumSha256Base64,
          ServerSideEncryption: putInput.serverSideEncryption,
        },
        putInput.signal,
      );
      const versionId = awsString(response.VersionId);
      const checksum = awsString(response.ChecksumSHA256);
      const encryption = awsString(response.ServerSideEncryption);
      const eTag = awsString(response.ETag);
      if (!versionId || !checksum || encryption !== "AES256" || !eTag) {
        throw wormError("object_upload_failed");
      }
      return Object.freeze({
        versionId,
        checksumSha256Base64: checksum,
        serverSideEncryption: "AES256",
        eTag,
        requestIdSha256: awsRequestIdSha256(response),
      });
    },
    readExactVersion: async ({ key, versionId, expectedBucketOwner, signal }) => {
      const common = {
        ...bucketInput(bucketName, expectedBucketOwner),
        Key: key,
        VersionId: versionId,
      };
      const retention = await awsSend(
        input.readerS3,
        input.commands.GetObjectRetentionCommand,
        common,
        signal,
      );
      const response = await awsSend(
        input.readerS3,
        input.commands.GetObjectCommand,
        { ...common, ChecksumMode: "ENABLED" },
        signal,
      );
      const body = response.Body;
      if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function") {
        throw wormError("object_verification_failed");
      }
      const retentionValue = awsOptionalRecord(retention.Retention);
      const lastModified = awsTimestamp(response.LastModified);
      const returnedVersionId = awsString(response.VersionId);
      if (!lastModified || !returnedVersionId || typeof response.ContentLength !== "number") {
        throw wormError("object_verification_failed");
      }
      return {
        key,
        versionId: returnedVersionId,
        bytes: response.ContentLength,
        checksumSha256Base64: awsString(response.ChecksumSHA256) ?? "",
        contentType: awsString(response.ContentType) ?? "",
        cacheControl: awsString(response.CacheControl) ?? "",
        metadata: awsMetadata(response.Metadata),
        serverSideEncryption: awsString(response.ServerSideEncryption) ?? "",
        objectLockMode: awsString(retentionValue?.Mode),
        retainUntil: awsTimestamp(retentionValue?.RetainUntilDate),
        lastModified,
        body: body as PostgresLogicalWormReadResult["body"],
      };
    },
    runWriterDenialCanary: async ({
      action,
      key,
      versionId,
      expectedBucketOwner,
      signal,
    }) => {
      const common = {
        ...bucketInput(bucketName, expectedBucketOwner),
        Key: key,
        VersionId: versionId,
      };
      let Constructor: AwsSdkV3WormCommandConstructor = input.commands.GetObjectCommand;
      let commandInput: Readonly<Record<string, unknown>> = common;
      switch (action) {
        case "get_object_version":
          Constructor = input.commands.GetObjectCommand;
          commandInput = common;
          break;
        case "list_object_versions":
          Constructor = input.commands.ListObjectVersionsCommand;
          commandInput = {
            ...bucketInput(bucketName, expectedBucketOwner),
            Prefix: key,
            MaxKeys: 1,
          };
          break;
        case "delete_object_version":
          Constructor = input.commands.DeleteObjectCommand;
          commandInput = common;
          break;
        case "get_object_retention":
          Constructor = input.commands.GetObjectRetentionCommand;
          commandInput = common;
          break;
        case "get_bucket_object_lock_configuration":
          Constructor = input.commands.GetObjectLockConfigurationCommand;
          commandInput = bucketInput(bucketName, expectedBucketOwner);
          break;
      }
      try {
        const unexpected = await input.writerS3.send(
          awsCommand(Constructor, commandInput),
          { abortSignal: signal },
        );
        const body = awsOptionalRecord(unexpected)?.Body as
          | { destroy?: (error?: Error) => void }
          | undefined;
        body?.destroy?.(new Error("writer denial canary unexpectedly succeeded"));
      } catch (error) {
        if (error instanceof PostgresLogicalWormError) throw error;
        return exactAwsAccessDenied(error, action);
      }
      throw wormError("writer_not_least_privilege");
    },
  };
  return Object.freeze(provider);
}

export const postgresLogicalWormInternals = {
  ABSOLUTE_MAX_ARCHIVE_BYTES,
  IMMUTABLE_CACHE_CONTROL,
  RETENTION_CLOCK_TOLERANCE_MS,
  canonicalSha256,
  hashBoundedBody,
  metadataFor,
  receiptKey,
  validateDenialEvidence,
};
