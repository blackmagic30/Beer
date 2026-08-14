import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  POSTGRES_LOGICAL_BACKUP_ARCHIVE,
  POSTGRES_LOGICAL_BACKUP_MANIFEST,
  POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  canonicalPostgresBackupJson,
  type PostgresLogicalBackupManifest,
} from "./postgres-logical-backup.js";
import {
  POSTGRES_LOGICAL_WORM_CONTRACT,
  POSTGRES_LOGICAL_WORM_PREFIX,
  POSTGRES_LOGICAL_WORM_REGION,
  postgresLogicalWormInternals,
  type PostgresLogicalWormBucketControls,
  type PostgresLogicalWormDenialEvidence,
  type PostgresLogicalWormIdentity,
  type PostgresLogicalWormReadResult,
  type PostgresLogicalWormResult,
  type PostgresLogicalWormVerifiedObjectDescriptor,
  type PostgresLogicalWormVersionInventory,
  type PostgresLogicalWormWriterDenialAction,
} from "./postgres-logical-worm.js";
import {
  assertPostgresLogicalBackupStateReceiptBinding,
  parsePostgresLogicalBackupManifest,
} from "./postgres-logical-restore.js";
import {
  parsePostgresLogicalSourceStateReceipt,
  type PostgresLogicalSourceStateReceipt,
} from "./postgres-logical-state.js";

export const POSTGRES_LOGICAL_WORM_RETRIEVAL_KIND =
  "pintpath-postgres-logical-worm-retrieval" as const;

const RECEIPT_KIND = "pintpath-postgres-logical-worm-receipt" as const;
const SHA256 = /^[a-f0-9]{64}$/;
const ACCOUNT_ID = /^\d{12}$/;
const PRINCIPAL_ARN = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/;
const VERSION_ID = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_STATE_RECEIPT_BYTES = 4 * 1024 * 1024;

type RetrievalObjectKind = "archive" | "manifest" | "state-receipt";

interface LogicalWormReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly version: 1;
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
  readonly objects: readonly PostgresLogicalWormVerifiedObjectDescriptor[];
  readonly immutableObjectSetSha256: string;
  readonly writerDenials: readonly PostgresLogicalWormDenialEvidence[];
  readonly writerDenialSetSha256: string;
}

export interface PostgresLogicalWormReadOnlyProvider {
  readonly region: string;
  readonly bucketName: string;
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
  readExactVersion(input: {
    readonly key: string;
    readonly versionId: string;
    readonly expectedBucketOwner: string;
    readonly signal: AbortSignal;
  }): Promise<PostgresLogicalWormReadResult>;
}

export interface RetrievePostgresLogicalWormOptions {
  readonly outputDirectory: string;
  readonly wormResult: PostgresLogicalWormResult;
  readonly wormResultSha256: string;
  readonly bucketName: string;
  readonly expectedBucketNameSha256: string;
  readonly recoveryAccountId: string;
  readonly expectedRecoveryAccountIdSha256: string;
  readonly expectedReaderPrincipalArnSha256: string;
  readonly provider: PostgresLogicalWormReadOnlyProvider;
  readonly operationTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface PostgresLogicalWormRetrievalResult {
  readonly schemaVersion: 1;
  readonly kind: typeof POSTGRES_LOGICAL_WORM_RETRIEVAL_KIND;
  readonly ok: true;
  readonly retrievedAt: string;
  readonly backupCreatedAt: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly stateReceiptSha256: string;
  readonly sourceDatabaseIdentitySha256: string;
  readonly overallStateSha256: string;
  readonly backupIdSha256: string;
  readonly wormResultSha256: string;
  readonly wormReceiptSha256: string;
  readonly immutableObjectSetSha256: string;
  readonly archiveBytes: number;
  readonly manifestBytes: number;
  readonly stateReceiptBytes: number;
  readonly localArtifactSetSha256: string;
  readonly recoveryAccountIdSha256: string;
  readonly bucketNameSha256: string;
  readonly readerPrincipalArnSha256: string;
  readonly minimumRetainUntil: string;
}

export type PostgresLogicalWormRetrievalFailureCode =
  | "invalid_arguments"
  | "worm_result_invalid"
  | "destination_pin_mismatch"
  | "authority_identity_mismatch"
  | "bucket_controls_invalid"
  | "receipt_verification_failed"
  | "object_verification_failed"
  | "backup_manifest_invalid"
  | "unsafe_output_path"
  | "output_write_failed"
  | "cleanup_failed"
  | "deadline_exceeded";

export class PostgresLogicalWormRetrievalError extends Error {
  constructor(readonly code: PostgresLogicalWormRetrievalFailureCode) {
    super(code);
    this.name = "PostgresLogicalWormRetrievalError";
  }
}

function fail(code: PostgresLogicalWormRetrievalFailureCode): never {
  throw new PostgresLogicalWormRetrievalError(code);
}

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
  return hash(canonicalPostgresBackupJson(value));
}

function exactSha256(value: unknown, code: PostgresLogicalWormRetrievalFailureCode): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function exactTimestamp(
  value: unknown,
  code: PostgresLogicalWormRetrievalFailureCode,
): string {
  if (
    typeof value !== "string"
    || !CANONICAL_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) fail(code);
  return value;
}

function exactNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    fail("invalid_arguments");
  }
  return value.toISOString();
}

function exactKeys(value: object, expected: readonly string[], code: PostgresLogicalWormRetrievalFailureCode): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalPostgresBackupJson(actual) !== canonicalPostgresBackupJson(wanted)) {
    fail(code);
  }
}

const RESULT_KEYS = Object.freeze([
  "schemaVersion", "ok", "backupCreatedAt", "completedAt", "archiveSha256",
  "manifestSha256", "stateReceiptSha256", "overallStateSha256", "backupIdSha256",
  "recoveryAccountIdSha256", "bucketNameSha256", "writerPrincipalArnSha256",
  "readerPrincipalArnSha256", "immutableObjectSetSha256", "writerDenialSetSha256",
  "receiptSha256", "receiptObjectKeySha256", "receiptVersionIdSha256",
  "receiptDenialSetSha256", "minimumRetainUntil",
]);

function validateWormResult(value: PostgresLogicalWormResult, nowMs: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("worm_result_invalid");
  exactKeys(value, RESULT_KEYS, "worm_result_invalid");
  if (value.schemaVersion !== 1 || value.ok !== true) fail("worm_result_invalid");
  const createdAt = exactTimestamp(value.backupCreatedAt, "worm_result_invalid");
  const completedAt = exactTimestamp(value.completedAt, "worm_result_invalid");
  const retainUntil = exactTimestamp(value.minimumRetainUntil, "worm_result_invalid");
  for (const key of RESULT_KEYS.filter((key) => key.endsWith("Sha256"))) {
    exactSha256((value as unknown as Record<string, unknown>)[key], "worm_result_invalid");
  }
  if (
    Date.parse(createdAt) > Date.parse(completedAt)
    || Date.parse(completedAt) > nowMs
    || Date.parse(retainUntil) <= nowMs
  ) fail("worm_result_invalid");
  const backupId = `${createdAt.replace(/[-:.]/g, "")}-${value.manifestSha256}`;
  if (hash(backupId) !== value.backupIdSha256) fail("worm_result_invalid");
}

const RECEIPT_KEYS = Object.freeze([
  "kind", "version", "backupCreatedAt", "verifiedAt", "backupIdSha256",
  "archiveSha256", "manifestSha256", "stateReceiptSha256",
  "sourceDatabaseIdentitySha256", "overallStateSha256", "recoveryAccountIdSha256",
  "bucketNameSha256", "regionSha256", "writerPrincipalArnSha256",
  "readerPrincipalArnSha256", "operatorIdSha256", "bucketControlsSha256", "objects",
  "immutableObjectSetSha256", "writerDenials", "writerDenialSetSha256",
]);

const DESCRIPTOR_KEYS = Object.freeze([
  "kind", "objectKeySha256", "versionIdSha256", "bytes", "sha256",
  "checksumSha256Base64Sha256", "contentType", "metadataSha256", "objectLockMode",
  "retainUntil", "lastModified", "created",
]);

const WRITER_DENIAL_KEYS = Object.freeze([
  "action", "errorCode", "httpStatusCode", "requestIdSha256",
  "extendedRequestIdSha256",
]);

const WRITER_DENIAL_ACTIONS: readonly PostgresLogicalWormWriterDenialAction[] =
  Object.freeze([
    "get_object_version",
    "list_object_versions",
    "delete_object_marker",
    "delete_object_version",
    "get_object_retention",
    "get_bucket_object_lock_configuration",
  ]);

function parseReceipt(bytes: Buffer, result: PostgresLogicalWormResult): LogicalWormReceipt {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("receipt_verification_failed");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("receipt_verification_failed");
  }
  exactKeys(raw, RECEIPT_KEYS, "receipt_verification_failed");
  if (canonicalPostgresBackupJson(raw) !== bytes.toString("utf8")) {
    fail("receipt_verification_failed");
  }
  const receipt = raw as LogicalWormReceipt;
  if (
    receipt.kind !== RECEIPT_KIND
    || receipt.version !== 1
    || exactTimestamp(receipt.backupCreatedAt, "receipt_verification_failed")
      !== result.backupCreatedAt
    || exactTimestamp(receipt.verifiedAt, "receipt_verification_failed")
      > result.completedAt
    || !Array.isArray(receipt.objects)
    || receipt.objects.length !== 3
    || !Array.isArray(receipt.writerDenials)
    || receipt.writerDenials.length !== WRITER_DENIAL_ACTIONS.length
  ) fail("receipt_verification_failed");
  for (const key of RECEIPT_KEYS.filter((key) => key.endsWith("Sha256"))) {
    exactSha256((receipt as unknown as Record<string, unknown>)[key], "receipt_verification_failed");
  }
  for (const descriptor of receipt.objects) {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      fail("receipt_verification_failed");
    }
    exactKeys(descriptor, DESCRIPTOR_KEYS, "receipt_verification_failed");
    if (
      !["archive", "manifest", "state-receipt"].includes(descriptor.kind)
      || !/^[1-9]\d*$/.test(descriptor.bytes)
      || BigInt(descriptor.bytes) > postgresLogicalWormInternals.ABSOLUTE_MAX_ARCHIVE_BYTES
      || !["application/octet-stream", "application/json"].includes(descriptor.contentType)
      || descriptor.objectLockMode !== "COMPLIANCE"
      || typeof descriptor.created !== "boolean"
    ) fail("receipt_verification_failed");
    for (const key of [
      "objectKeySha256", "versionIdSha256", "sha256",
      "checksumSha256Base64Sha256", "metadataSha256",
    ] as const) exactSha256(descriptor[key], "receipt_verification_failed");
    exactTimestamp(descriptor.retainUntil, "receipt_verification_failed");
    exactTimestamp(descriptor.lastModified, "receipt_verification_failed");
  }
  receipt.writerDenials.forEach((denial, index) => {
    if (!denial || typeof denial !== "object" || Array.isArray(denial)) {
      fail("receipt_verification_failed");
    }
    exactKeys(denial, WRITER_DENIAL_KEYS, "receipt_verification_failed");
    if (
      denial.action !== WRITER_DENIAL_ACTIONS[index]
      || denial.errorCode !== "AccessDenied"
      || denial.httpStatusCode !== 403
      || !SHA256.test(denial.requestIdSha256)
      || (
        denial.extendedRequestIdSha256 !== null
        && !SHA256.test(denial.extendedRequestIdSha256)
      )
    ) fail("receipt_verification_failed");
  });
  if (
    receipt.objects.map((entry) => entry.kind).join(",")
      !== "archive,manifest,state-receipt"
    || canonicalHash(receipt.objects) !== receipt.immutableObjectSetSha256
    || receipt.immutableObjectSetSha256 !== result.immutableObjectSetSha256
    || receipt.backupIdSha256 !== result.backupIdSha256
    || receipt.archiveSha256 !== result.archiveSha256
    || receipt.manifestSha256 !== result.manifestSha256
    || receipt.stateReceiptSha256 !== result.stateReceiptSha256
    || receipt.overallStateSha256 !== result.overallStateSha256
    || receipt.recoveryAccountIdSha256 !== result.recoveryAccountIdSha256
    || receipt.bucketNameSha256 !== result.bucketNameSha256
    || receipt.writerPrincipalArnSha256 !== result.writerPrincipalArnSha256
    || receipt.readerPrincipalArnSha256 !== result.readerPrincipalArnSha256
    || canonicalHash(receipt.writerDenials) !== receipt.writerDenialSetSha256
    || receipt.writerDenialSetSha256 !== result.writerDenialSetSha256
    || receipt.regionSha256 !== hash(POSTGRES_LOGICAL_WORM_REGION)
  ) fail("receipt_verification_failed");
  return receipt;
}

function objectKey(backupId: string, filename: string): string {
  return `${POSTGRES_LOGICAL_WORM_PREFIX}/backups/${backupId}/${filename}`;
}

function receiptKey(backupId: string, receiptSha256: string): string {
  return `${POSTGRES_LOGICAL_WORM_PREFIX}/receipts/${backupId}/${receiptSha256}.json`;
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

function expectedMetadata(input: {
  readonly kind: RetrievalObjectKind | "worm-receipt";
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

interface OutputNode {
  readonly filename: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly size: bigint;
}

interface HeldOutput {
  readonly directory: string;
  readonly uid: bigint;
  create(filename: string): Promise<fs.promises.FileHandle>;
  record(filename: string, handle: fs.promises.FileHandle, bytes: number): Promise<void>;
  assertExact(): void;
  cleanup(): boolean;
  close(): boolean;
}

function sameNode(filename: string, expected: OutputNode): boolean {
  try {
    const stat = fs.lstatSync(filename, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
      && stat.dev === expected.dev && stat.ino === expected.ino
      && stat.uid === expected.uid && stat.gid === expected.gid
      && stat.mode === expected.mode
      && (expected.size < 0n || stat.size === expected.size)
      && fs.realpathSync(filename) === filename;
  } catch {
    return false;
  }
}

function prepareOutput(directory: string): HeldOutput {
  const allowed = new Set([
    POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    POSTGRES_LOGICAL_BACKUP_MANIFEST,
    POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  ]);
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (
    !Number.isSafeInteger(uid) || uid === undefined || uid < 0
    || !path.isAbsolute(directory) || path.resolve(directory) !== directory
    || directory === path.parse(directory).root || directory.includes("\0")
    || !Number.isSafeInteger(fs.constants.O_NOFOLLOW) || fs.constants.O_NOFOLLOW <= 0
    || !Number.isSafeInteger(fs.constants.O_DIRECTORY) || fs.constants.O_DIRECTORY <= 0
  ) fail("unsafe_output_path");
  const parent = path.dirname(directory);
  let parentFd: number | null = null;
  let directoryFd: number | null = null;
  let rootIdentity: fs.BigIntStats | null = null;
  const files = new Map<string, OutputNode>();
  let closed = false;
  const close = (): boolean => {
    if (closed) return true;
    closed = true;
    let ok = true;
    try { if (directoryFd !== null) fs.closeSync(directoryFd); } catch { ok = false; }
    try { if (parentFd !== null) fs.closeSync(parentFd); } catch { ok = false; }
    directoryFd = null;
    parentFd = null;
    return ok;
  };
  const rootMatches = (): boolean => {
    try {
      if (closed || rootIdentity === null || directoryFd === null || parentFd === null) return false;
      const pathname = fs.lstatSync(directory, { bigint: true });
      const descriptor = fs.fstatSync(directoryFd, { bigint: true });
      const parentPath = fs.lstatSync(parent, { bigint: true });
      const parentDescriptor = fs.fstatSync(parentFd, { bigint: true });
      return pathname.isDirectory() && descriptor.isDirectory()
        && !pathname.isSymbolicLink() && pathname.dev === rootIdentity.dev
        && pathname.ino === rootIdentity.ino && descriptor.dev === rootIdentity.dev
        && descriptor.ino === rootIdentity.ino && pathname.uid === rootIdentity.uid
        && descriptor.uid === rootIdentity.uid && pathname.gid === rootIdentity.gid
        && descriptor.gid === rootIdentity.gid && pathname.mode === rootIdentity.mode
        && descriptor.mode === rootIdentity.mode
        && Number(pathname.mode & 0o7777n) === 0o700
        && parentPath.dev === parentDescriptor.dev && parentPath.ino === parentDescriptor.ino
        && parentPath.uid === BigInt(uid) && Number(parentPath.mode & 0o077n) === 0
        && fs.realpathSync(parent) === parent && fs.realpathSync(directory) === directory;
    } catch {
      return false;
    }
  };
  try {
    const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (existing) fail("unsafe_output_path");
    parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const parentStat = fs.fstatSync(parentFd, { bigint: true });
    if (
      !parentStat.isDirectory() || parentStat.uid !== BigInt(uid)
      || Number(parentStat.mode & 0o077n) !== 0 || fs.realpathSync(parent) !== parent
    ) fail("unsafe_output_path");
    fs.mkdirSync(directory, { mode: 0o700 });
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    rootIdentity = fs.fstatSync(directoryFd, { bigint: true });
    if (!rootMatches()) fail("unsafe_output_path");
  } catch (error) {
    close();
    try { fs.rmdirSync(directory); } catch { /* directory may not have been created */ }
    if (error instanceof PostgresLogicalWormRetrievalError) throw error;
    fail("unsafe_output_path");
  }
  const audit = (exact: boolean): boolean => {
    if (!rootMatches()) return false;
    try {
      const entries = fs.readdirSync(directory).sort();
      const expected = [...files.keys()].sort();
      if (entries.some((entry) => !allowed.has(entry))) return false;
      if (exact && canonicalPostgresBackupJson(entries)
        !== canonicalPostgresBackupJson([...allowed].sort())) return false;
      if (!exact && canonicalPostgresBackupJson(entries)
        !== canonicalPostgresBackupJson(expected)) return false;
      return [...files.entries()].every(([filename, node]) => (
        sameNode(path.join(directory, filename), node)
      ));
    } catch {
      return false;
    }
  };
  return {
    directory,
    uid: BigInt(uid),
    async create(filename) {
      if (closed || !allowed.has(filename) || !audit(false)) fail("output_write_failed");
      let handle: fs.promises.FileHandle | null = null;
      try {
        handle = await fs.promises.open(
          path.join(directory, filename),
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
            | fs.constants.O_NOFOLLOW,
          0o600,
        );
        const stat = await handle.stat({ bigint: true });
        if (
          !stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(uid)
          || Number(stat.mode & 0o7777n) !== 0o600 || stat.size !== 0n
        ) fail("output_write_failed");
        files.set(filename, Object.freeze({
          filename: path.join(directory, filename), dev: stat.dev, ino: stat.ino,
          uid: stat.uid, gid: stat.gid, mode: stat.mode, size: -1n,
        }));
        if (!audit(false)) fail("output_write_failed");
        return handle;
      } catch {
        await handle?.close().catch(() => undefined);
        fail("output_write_failed");
      }
    },
    async record(filename, handle, bytes) {
      try {
        await handle.chmod(0o600);
        await handle.sync();
        const stat = await handle.stat({ bigint: true });
        if (
          !stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(uid)
          || Number(stat.mode & 0o7777n) !== 0o600 || stat.size !== BigInt(bytes)
        ) fail("output_write_failed");
        files.set(filename, Object.freeze({
          filename: path.join(directory, filename), dev: stat.dev, ino: stat.ino,
          uid: stat.uid, gid: stat.gid, mode: stat.mode, size: stat.size,
        }));
        if (!audit(false)) fail("output_write_failed");
      } catch (error) {
        if (error instanceof PostgresLogicalWormRetrievalError) throw error;
        fail("output_write_failed");
      }
    },
    assertExact() {
      if (!audit(true)) fail("output_write_failed");
    },
    cleanup() {
      if (!audit(false)) {
        close();
        return false;
      }
      try {
        for (const [filename, node] of [...files.entries()].reverse()) {
          const target = path.join(directory, filename);
          if (!sameNode(target, node)) throw new Error("replaced");
          fs.unlinkSync(target);
        }
        files.clear();
        if (!rootMatches() || fs.readdirSync(directory).length !== 0) {
          throw new Error("changed");
        }
        fs.rmdirSync(directory);
        if (parentFd !== null) fs.fsyncSync(parentFd);
        return close();
      } catch {
        close();
        return false;
      }
    },
    close,
  };
}

function inventoryVersion(
  inventory: PostgresLogicalWormVersionInventory,
  key: string,
): PostgresLogicalWormVersionInventory["versions"][number] {
  if (
    inventory.truncated || inventory.deleteMarkers.length !== 0
    || inventory.versions.length !== 1 || inventory.versions[0]!.key !== key
  ) fail("object_verification_failed");
  const version = inventory.versions[0]!;
  if (
    !VERSION_ID.test(version.versionId) || !version.isLatest
    || !Number.isSafeInteger(version.bytes) || version.bytes < 1
  ) fail("object_verification_failed");
  exactTimestamp(version.lastModified, "object_verification_failed");
  return version;
}

async function verifiedRemote(input: {
  readonly provider: PostgresLogicalWormReadOnlyProvider;
  readonly key: string;
  readonly descriptor: PostgresLogicalWormVerifiedObjectDescriptor;
  readonly expectedBucketOwner: string;
  readonly expectedMetadata: Readonly<Record<string, string>>;
  readonly expectedContentType: "application/json" | "application/octet-stream";
  readonly maximumBytes: number;
  readonly minimumRetainUntil: string;
  readonly exactRetainUntil?: boolean | undefined;
  readonly nowMs: number;
  readonly operationTimeoutMs: number;
  readonly output?: { readonly held: HeldOutput; readonly filename: string } | undefined;
  readonly retainBytes?: boolean | undefined;
}): Promise<{ readonly bytes: number; readonly sha256: string; readonly retained?: Buffer }> {
  const inventory = await postgresLogicalWormInternals.boundedOperation(
    input.operationTimeoutMs,
    (signal) => input.provider.listExactVersions({
      key: input.key,
      expectedBucketOwner: input.expectedBucketOwner,
      signal,
    }),
  ).catch((error) => {
    if ((error as { code?: string }).code === "deadline_exceeded") fail("deadline_exceeded");
    fail("object_verification_failed");
  });
  const version = inventoryVersion(inventory, input.key);
  const expectedBytes = Number(input.descriptor.bytes);
  if (
    expectedBytes > input.maximumBytes || version.bytes !== expectedBytes
    || hash(input.key) !== input.descriptor.objectKeySha256
    || hash(version.versionId) !== input.descriptor.versionIdSha256
    || version.lastModified !== input.descriptor.lastModified
  ) fail("object_verification_failed");
  let handle: fs.promises.FileHandle | null = null;
  try {
    if (input.output) handle = await input.output.held.create(input.output.filename);
    const streamed = await postgresLogicalWormInternals.boundedOperation(
      input.operationTimeoutMs,
      async (signal) => {
        const remote = await input.provider.readExactVersion({
          key: input.key,
          versionId: version.versionId,
          expectedBucketOwner: input.expectedBucketOwner,
          signal,
        });
        const abort = () => remote.body.destroy?.(new Error("logical WORM retrieval aborted"));
        signal.addEventListener("abort", abort, { once: true });
        const digest = crypto.createHash("sha256");
        const retained: Buffer[] = [];
        let bytes = 0;
        try {
          for await (const raw of remote.body) {
            if (signal.aborted) fail("deadline_exceeded");
            if (!(raw instanceof Uint8Array)) fail("object_verification_failed");
            const chunk = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
            bytes += chunk.length;
            if (bytes > expectedBytes || bytes > input.maximumBytes) {
              remote.body.destroy?.(new Error("logical WORM retrieval exceeded bound"));
              fail("object_verification_failed");
            }
            digest.update(chunk);
            if (handle) {
              let offset = 0;
              while (offset < chunk.length) {
                const written = await handle.write(chunk, offset, chunk.length - offset, bytes - chunk.length + offset);
                if (written.bytesWritten < 1) fail("output_write_failed");
                offset += written.bytesWritten;
              }
            }
            if (input.retainBytes) retained.push(Buffer.from(chunk));
          }
        } catch (error) {
          remote.body.destroy?.(new Error("logical WORM retrieval failed"));
          throw error;
        } finally {
          signal.removeEventListener("abort", abort);
        }
        return {
          remote,
          bytes,
          sha256: digest.digest("hex"),
          ...(input.retainBytes ? { retained: Buffer.concat(retained, bytes) } : {}),
        };
      },
    );
    const remote = streamed.remote;
    const retention = exactTimestamp(remote.retainUntil, "object_verification_failed");
    if (
      remote.key !== input.key || remote.versionId !== version.versionId
      || remote.bytes !== expectedBytes || streamed.bytes !== expectedBytes
      || streamed.sha256 !== input.descriptor.sha256
      || remote.checksumSha256Base64
        !== Buffer.from(input.descriptor.sha256, "hex").toString("base64")
      || hash(remote.checksumSha256Base64)
        !== input.descriptor.checksumSha256Base64Sha256
      || remote.contentType.toLowerCase() !== input.expectedContentType
      || remote.cacheControl.toLowerCase()
        !== postgresLogicalWormInternals.IMMUTABLE_CACHE_CONTROL
      || !exactMetadata(remote.metadata, input.expectedMetadata)
      || canonicalHash(input.expectedMetadata) !== input.descriptor.metadataSha256
      || remote.serverSideEncryption !== "AES256" || remote.objectLockMode !== "COMPLIANCE"
      || (input.exactRetainUntil ?? true) && retention !== input.descriptor.retainUntil
      || Date.parse(retention) < Date.parse(input.minimumRetainUntil)
      || Date.parse(retention) <= input.nowMs
      || exactTimestamp(remote.lastModified, "object_verification_failed")
        !== input.descriptor.lastModified
      || remote.lastModified !== version.lastModified
    ) fail("object_verification_failed");
    if (handle && input.output) {
      await input.output.held.record(input.output.filename, handle, expectedBytes);
      await handle.close();
      handle = null;
    }
    return {
      bytes: streamed.bytes,
      sha256: streamed.sha256,
      ...(streamed.retained ? { retained: streamed.retained } : {}),
    };
  } catch (error) {
    if (error instanceof PostgresLogicalWormRetrievalError) throw error;
    if ((error as { code?: string }).code === "deadline_exceeded") fail("deadline_exceeded");
    fail(handle ? "output_write_failed" : "object_verification_failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  fail("object_verification_failed");
}

function descriptor(
  receipt: LogicalWormReceipt,
  kind: RetrievalObjectKind,
): PostgresLogicalWormVerifiedObjectDescriptor {
  const value = receipt.objects.find((entry) => entry.kind === kind);
  if (!value) fail("receipt_verification_failed");
  return value;
}

function validateRecoveredBackup(input: {
  readonly manifestBytes: Buffer;
  readonly stateReceiptBytes: Buffer;
  readonly manifestDescriptor: PostgresLogicalWormVerifiedObjectDescriptor;
  readonly archiveDescriptor: PostgresLogicalWormVerifiedObjectDescriptor;
  readonly stateDescriptor: PostgresLogicalWormVerifiedObjectDescriptor;
  readonly receipt: LogicalWormReceipt;
}): { readonly manifest: PostgresLogicalBackupManifest; readonly state: PostgresLogicalSourceStateReceipt } {
  let manifest: PostgresLogicalBackupManifest;
  let state: PostgresLogicalSourceStateReceipt;
  try {
    manifest = parsePostgresLogicalBackupManifest(input.manifestBytes);
    state = parsePostgresLogicalSourceStateReceipt(input.stateReceiptBytes);
    assertPostgresLogicalBackupStateReceiptBinding(state, manifest);
  } catch {
    fail("backup_manifest_invalid");
  }
  if (
    manifest.schemaVersion !== 3 || manifest.createdAt !== input.receipt.backupCreatedAt
    || manifest.archive.sha256 !== input.archiveDescriptor.sha256
    || manifest.archive.bytes !== Number(input.archiveDescriptor.bytes)
    || manifest.state.receiptSha256 !== input.stateDescriptor.sha256
    || manifest.state.sourceDatabaseIdentitySha256
      !== input.receipt.sourceDatabaseIdentitySha256
    || manifest.state.overallStateSha256 !== input.receipt.overallStateSha256
    || hash(input.manifestBytes) !== input.manifestDescriptor.sha256
    || hash(input.stateReceiptBytes) !== input.stateDescriptor.sha256
  ) fail("backup_manifest_invalid");
  return { manifest, state };
}

export async function retrievePostgresLogicalWormBackup(
  options: RetrievePostgresLogicalWormOptions,
): Promise<PostgresLogicalWormRetrievalResult> {
  const retrievedAt = exactNow(options.now ?? (() => new Date()));
  const nowMs = Date.parse(retrievedAt);
  const wormResultSha256 = exactSha256(options.wormResultSha256, "invalid_arguments");
  validateWormResult(options.wormResult, nowMs);
  if (canonicalHash(options.wormResult) !== wormResultSha256) {
    fail("worm_result_invalid");
  }
  const bucketName = options.bucketName;
  const recoveryAccountId = options.recoveryAccountId;
  if (!ACCOUNT_ID.test(recoveryAccountId)) fail("invalid_arguments");
  const expectedBucketNameSha256 = exactSha256(
    options.expectedBucketNameSha256,
    "invalid_arguments",
  );
  const expectedRecoveryAccountIdSha256 = exactSha256(
    options.expectedRecoveryAccountIdSha256,
    "invalid_arguments",
  );
  const expectedReaderPrincipalArnSha256 = exactSha256(
    options.expectedReaderPrincipalArnSha256,
    "invalid_arguments",
  );
  try {
    postgresLogicalWormInternals.assertBucketName(bucketName);
  } catch {
    fail("invalid_arguments");
  }
  if (
    options.provider.region !== POSTGRES_LOGICAL_WORM_REGION
    || options.provider.bucketName !== bucketName
    || hash(bucketName) !== expectedBucketNameSha256
    || hash(recoveryAccountId) !== expectedRecoveryAccountIdSha256
    || options.wormResult.bucketNameSha256 !== expectedBucketNameSha256
    || options.wormResult.recoveryAccountIdSha256 !== expectedRecoveryAccountIdSha256
    || options.wormResult.readerPrincipalArnSha256 !== expectedReaderPrincipalArnSha256
  ) fail("destination_pin_mismatch");
  const operationTimeoutMs = (() => {
    try { return postgresLogicalWormInternals.timeoutMs(options.operationTimeoutMs); } catch {
      fail("invalid_arguments");
    }
  })();
  let identity: PostgresLogicalWormIdentity;
  let controls: PostgresLogicalWormBucketControls;
  try {
    [identity, controls] = await Promise.all([
      postgresLogicalWormInternals.boundedOperation(
        operationTimeoutMs,
        (signal) => options.provider.inspectReaderIdentity(signal),
      ),
      postgresLogicalWormInternals.boundedOperation(
        operationTimeoutMs,
        (signal) => options.provider.inspectBucketControls({
          expectedBucketOwner: recoveryAccountId,
          signal,
        }),
      ),
    ]);
  } catch (error) {
    if ((error as { code?: string }).code === "deadline_exceeded") fail("deadline_exceeded");
    fail("authority_identity_mismatch");
  }
  if (
    identity.accountId !== recoveryAccountId || !PRINCIPAL_ARN.test(identity.principalArn)
    || hash(identity.principalArn) !== expectedReaderPrincipalArnSha256
  ) fail("authority_identity_mismatch");
  try { postgresLogicalWormInternals.assertBucketControls(controls); } catch {
    fail("bucket_controls_invalid");
  }

  const backupId = `${options.wormResult.backupCreatedAt.replace(/[-:.]/g, "")}-${options.wormResult.manifestSha256}`;
  const receiptDescriptor: PostgresLogicalWormVerifiedObjectDescriptor = Object.freeze({
    kind: "worm-receipt",
    objectKeySha256: options.wormResult.receiptObjectKeySha256,
    versionIdSha256: options.wormResult.receiptVersionIdSha256,
    bytes: "1",
    sha256: options.wormResult.receiptSha256,
    checksumSha256Base64Sha256: "0".repeat(64),
    contentType: "application/json",
    metadataSha256: canonicalHash(expectedMetadata({
      kind: "worm-receipt",
      sha256: options.wormResult.receiptSha256,
      manifestSha256: options.wormResult.manifestSha256,
      backupIdSha256: options.wormResult.backupIdSha256,
    })),
    objectLockMode: "COMPLIANCE",
    retainUntil: options.wormResult.minimumRetainUntil,
    lastModified: options.wormResult.completedAt,
    created: false,
  });
  // The public result intentionally hashes the receipt's version and key but
  // omits its size/header descriptor. Retrieve it with the exact public pins,
  // then validate its full immutable metadata before trusting its contents.
  const receiptInventory = await postgresLogicalWormInternals.boundedOperation(
    operationTimeoutMs,
    (signal) => options.provider.listExactVersions({
      key: receiptKey(backupId, options.wormResult.receiptSha256),
      expectedBucketOwner: recoveryAccountId,
      signal,
    }),
  ).catch(() => fail("receipt_verification_failed"));
  const receiptVersion = inventoryVersion(
    receiptInventory,
    receiptKey(backupId, options.wormResult.receiptSha256),
  );
  const receiptKeyValue = receiptKey(backupId, options.wormResult.receiptSha256);
  if (
    hash(receiptKeyValue) !== options.wormResult.receiptObjectKeySha256
    || hash(receiptVersion.versionId) !== options.wormResult.receiptVersionIdSha256
    || receiptVersion.bytes < 1 || receiptVersion.bytes > MAX_RECEIPT_BYTES
  ) fail("receipt_verification_failed");
  const receiptRead = await verifiedRemote({
    provider: options.provider,
    key: receiptKeyValue,
    descriptor: {
      ...receiptDescriptor,
      bytes: String(receiptVersion.bytes),
      checksumSha256Base64Sha256: hash(
        Buffer.from(options.wormResult.receiptSha256, "hex").toString("base64"),
      ),
      retainUntil: options.wormResult.minimumRetainUntil,
      lastModified: receiptVersion.lastModified,
    },
    expectedBucketOwner: recoveryAccountId,
    expectedMetadata: expectedMetadata({
      kind: "worm-receipt",
      sha256: options.wormResult.receiptSha256,
      manifestSha256: options.wormResult.manifestSha256,
      backupIdSha256: options.wormResult.backupIdSha256,
    }),
    expectedContentType: "application/json",
    maximumBytes: MAX_RECEIPT_BYTES,
    minimumRetainUntil: options.wormResult.minimumRetainUntil,
    exactRetainUntil: false,
    nowMs,
    operationTimeoutMs,
    retainBytes: true,
  }).catch((error) => {
    if (error instanceof PostgresLogicalWormRetrievalError
      && error.code === "deadline_exceeded") throw error;
    fail("receipt_verification_failed");
  });
  if (!receiptRead.retained || receiptRead.sha256 !== options.wormResult.receiptSha256) {
    fail("receipt_verification_failed");
  }
  let receipt: LogicalWormReceipt;
  try {
    receipt = parseReceipt(receiptRead.retained, options.wormResult);
  } finally {
    receiptRead.retained.fill(0);
  }
  const output = prepareOutput(options.outputDirectory);
  try {
    const archiveDescriptor = descriptor(receipt, "archive");
    const manifestDescriptor = descriptor(receipt, "manifest");
    const stateDescriptor = descriptor(receipt, "state-receipt");
    const common = {
      manifestSha256: options.wormResult.manifestSha256,
      backupIdSha256: options.wormResult.backupIdSha256,
    };
    const archive = await verifiedRemote({
      provider: options.provider,
      key: objectKey(backupId, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
      descriptor: archiveDescriptor,
      expectedBucketOwner: recoveryAccountId,
      expectedMetadata: expectedMetadata({ kind: "archive", sha256: archiveDescriptor.sha256, ...common }),
      expectedContentType: "application/octet-stream",
      maximumBytes: Number(postgresLogicalWormInternals.ABSOLUTE_MAX_ARCHIVE_BYTES),
      minimumRetainUntil: options.wormResult.minimumRetainUntil,
      nowMs,
      operationTimeoutMs,
      output: { held: output, filename: POSTGRES_LOGICAL_BACKUP_ARCHIVE },
    });
    const manifest = await verifiedRemote({
      provider: options.provider,
      key: objectKey(backupId, POSTGRES_LOGICAL_BACKUP_MANIFEST),
      descriptor: manifestDescriptor,
      expectedBucketOwner: recoveryAccountId,
      expectedMetadata: expectedMetadata({ kind: "manifest", sha256: manifestDescriptor.sha256, ...common }),
      expectedContentType: "application/json",
      maximumBytes: MAX_MANIFEST_BYTES,
      minimumRetainUntil: options.wormResult.minimumRetainUntil,
      nowMs,
      operationTimeoutMs,
      output: { held: output, filename: POSTGRES_LOGICAL_BACKUP_MANIFEST },
      retainBytes: true,
    });
    const state = await verifiedRemote({
      provider: options.provider,
      key: objectKey(backupId, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT),
      descriptor: stateDescriptor,
      expectedBucketOwner: recoveryAccountId,
      expectedMetadata: expectedMetadata({ kind: "state-receipt", sha256: stateDescriptor.sha256, ...common }),
      expectedContentType: "application/json",
      maximumBytes: MAX_STATE_RECEIPT_BYTES,
      minimumRetainUntil: options.wormResult.minimumRetainUntil,
      nowMs,
      operationTimeoutMs,
      output: { held: output, filename: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT },
      retainBytes: true,
    });
    if (!manifest.retained || !state.retained) fail("backup_manifest_invalid");
    let validated: ReturnType<typeof validateRecoveredBackup>;
    try {
      validated = validateRecoveredBackup({
        manifestBytes: manifest.retained,
        stateReceiptBytes: state.retained,
        manifestDescriptor,
        archiveDescriptor,
        stateDescriptor,
        receipt,
      });
    } finally {
      manifest.retained.fill(0);
      state.retained.fill(0);
    }
    output.assertExact();
    const localArtifacts = [
      { filename: POSTGRES_LOGICAL_BACKUP_ARCHIVE, bytes: archive.bytes, sha256: archive.sha256 },
      { filename: POSTGRES_LOGICAL_BACKUP_MANIFEST, bytes: manifest.bytes, sha256: manifest.sha256 },
      { filename: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT, bytes: state.bytes, sha256: state.sha256 },
    ];
    if (!output.close()) fail("output_write_failed");
    return Object.freeze({
      schemaVersion: 1,
      kind: POSTGRES_LOGICAL_WORM_RETRIEVAL_KIND,
      ok: true,
      retrievedAt,
      backupCreatedAt: validated.manifest.createdAt,
      archiveSha256: archive.sha256,
      manifestSha256: manifest.sha256,
      stateReceiptSha256: state.sha256,
      sourceDatabaseIdentitySha256: validated.manifest.state.sourceDatabaseIdentitySha256,
      overallStateSha256: validated.manifest.state.overallStateSha256,
      backupIdSha256: options.wormResult.backupIdSha256,
      wormResultSha256,
      wormReceiptSha256: options.wormResult.receiptSha256,
      immutableObjectSetSha256: options.wormResult.immutableObjectSetSha256,
      archiveBytes: archive.bytes,
      manifestBytes: manifest.bytes,
      stateReceiptBytes: state.bytes,
      localArtifactSetSha256: canonicalHash(localArtifacts),
      recoveryAccountIdSha256: expectedRecoveryAccountIdSha256,
      bucketNameSha256: expectedBucketNameSha256,
      readerPrincipalArnSha256: expectedReaderPrincipalArnSha256,
      minimumRetainUntil: options.wormResult.minimumRetainUntil,
    });
  } catch (error) {
    if (!output.cleanup()) fail("cleanup_failed");
    if (error instanceof PostgresLogicalWormRetrievalError) throw error;
    fail("object_verification_failed");
  }
}

export const postgresLogicalWormRetrievalInternals = Object.freeze({
  expectedMetadata,
  objectKey,
  parseReceipt,
  prepareOutput,
  receiptKey,
  validateWormResult,
  verifiedRemote,
});
