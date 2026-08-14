import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import {
  canonicalPostgresBackupJson,
} from "./postgres-logical-backup.js";
import {
  POSTGRES_LOGICAL_WORM_CONTRACT,
  POSTGRES_LOGICAL_WORM_REGION,
  PostgresLogicalWormError,
  postgresLogicalWormInternals,
  type PostgresLogicalWormLocalObject,
  type PostgresLogicalWormProvider,
  type PostgresLogicalWormVerifiedObjectDescriptor,
} from "./postgres-logical-worm.js";
import {
  POSTGRES_PRIVATE_STORAGE_RECOVERY_DELETION_AUTHORITY,
  POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST,
  POSTGRES_PRIVATE_STORAGE_RECOVERY_OBJECTS,
  postgresPrivateStorageRecoveryInternals,
} from "./postgres-private-storage-recovery.js";

export const POSTGRES_RECOVERY_BUNDLE_WORM_PREFIX =
  "_recovery/postgres-logical-backups/v1/private-storage-bundles" as const;
export const POSTGRES_RECOVERY_BUNDLE_WORM_KIND =
  "pintpath-postgres-private-storage-worm-bundle" as const;
export const POSTGRES_RECOVERY_BUNDLE_WORM_RECEIPT_KIND =
  "pintpath-postgres-private-storage-worm-receipt" as const;
export const POSTGRES_RECOVERY_BUNDLE_RETRIEVAL_KIND =
  "pintpath-postgres-private-storage-worm-retrieval" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE = /^[a-f0-9]{40}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERSION_ID = /^[^\s\0]{1,1024}$/;
const SLOT = /^(?:manifest|ledger-(?:checkpoint|current|genesis)|storage-[0-9]{8})$/;
const MAX_MANIFEST_BYTES = 16n * 1024n * 1024n;
const MAX_LEDGER_BYTES = 64n * 1024n * 1024n;
const MAX_OBJECT_BYTES = 8n * 1024n * 1024n;
const MAX_TOTAL_BYTES = 50n * 1024n * 1024n * 1024n;
const MAX_OBJECT_COUNT = 10_004;

export type PostgresRecoveryBundleWormFailureCode =
  | "invalid_arguments"
  | "unsafe_recovery_bundle"
  | "recovery_bundle_tampered"
  | "recovery_bundle_manifest_invalid"
  | "destination_pin_mismatch"
  | "destination_unreachable"
  | "object_collision"
  | "object_verification_failed"
  | "receipt_failed"
  | "worm_result_invalid"
  | "retrieval_output_unsafe"
  | "retrieval_failed";

export class PostgresRecoveryBundleWormError extends Error {
  constructor(readonly code: PostgresRecoveryBundleWormFailureCode) {
    super(code);
    this.name = "PostgresRecoveryBundleWormError";
  }
}

interface BundleEntry {
  readonly slot: string;
  readonly relativePath: string;
  readonly bytes: string;
  readonly sha256: string;
  readonly contentType: "application/json" | "application/octet-stream";
}

interface BundleManifest {
  readonly kind: typeof POSTGRES_RECOVERY_BUNDLE_WORM_KIND;
  readonly version: 1;
  readonly candidateSha: string;
  readonly recoverySetSha256: string;
  readonly recoveryManifestSha256: string;
  readonly logicalBackupManifestSha256: string;
  readonly createdAt: string;
  readonly entries: readonly BundleEntry[];
  readonly entrySetSha256: string;
}

interface BundleWormReceipt {
  readonly kind: typeof POSTGRES_RECOVERY_BUNDLE_WORM_RECEIPT_KIND;
  readonly version: 1;
  readonly candidateSha: string;
  readonly completedAt: string;
  readonly recoverySetSha256: string;
  readonly recoveryManifestSha256: string;
  readonly logicalBackupManifestSha256: string;
  readonly bundleManifestSha256: string;
  readonly recoveryAccountIdSha256: string;
  readonly bucketNameSha256: string;
  readonly writerPrincipalArnSha256: string;
  readonly readerPrincipalArnSha256: string;
  readonly operatorIdSha256: string;
  readonly bucketControlsSha256: string;
  readonly immutableObjects: readonly PostgresLogicalWormVerifiedObjectDescriptor[];
  readonly immutableObjectSetSha256: string;
  readonly writerDenials: readonly {
    readonly action: string;
    readonly errorCode: "AccessDenied";
    readonly httpStatusCode: 403;
    readonly requestIdSha256: string;
    readonly extendedRequestIdSha256: string | null;
  }[];
  readonly writerDenialSetSha256: string;
}

interface TrustedEntry extends BundleEntry {
  readonly filePath: string;
  readonly snapshot: Awaited<ReturnType<
    typeof postgresLogicalWormInternals.snapshotTrustedFile
  >>;
}

interface TrustedBundle {
  readonly directoryPath: string;
  readonly directoryIdentity: ReturnType<typeof directoryIdentity>;
  readonly manifest: BundleManifest;
  readonly manifestBytes: Buffer;
  readonly manifestSha256: string;
  readonly entries: readonly TrustedEntry[];
}

export interface SealPostgresRecoveryBundleWormOptions {
  readonly recoverySetDirectory: string;
  readonly expectedRecoverySetSha256: string;
  readonly expectedRecoveryManifestSha256: string;
  readonly candidateSha: string;
  readonly bucketName: string;
  readonly expectedBucketNameSha256: string;
  readonly recoveryAccountId: string;
  readonly expectedRecoveryAccountIdSha256: string;
  readonly expectedWriterPrincipalArnSha256: string;
  readonly expectedReaderPrincipalArnSha256: string;
  readonly forbiddenAccountIds?: readonly string[] | undefined;
  readonly operatorId: string;
  readonly provider: PostgresLogicalWormProvider;
  readonly operationTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface PostgresRecoveryBundleWormResult {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly kind: typeof POSTGRES_RECOVERY_BUNDLE_WORM_RECEIPT_KIND;
  readonly candidateSha: string;
  readonly completedAt: string;
  readonly recoverySetSha256: string;
  readonly recoveryManifestSha256: string;
  readonly logicalBackupManifestSha256: string;
  readonly bundleManifestSha256: string;
  readonly immutableObjectSetSha256: string;
  readonly recoveryAccountIdSha256: string;
  readonly bucketNameSha256: string;
  readonly writerPrincipalArnSha256: string;
  readonly readerPrincipalArnSha256: string;
  readonly writerDenialSetSha256: string;
  readonly receiptSha256: string;
  readonly receiptObjectKeySha256: string;
  readonly receiptVersionIdSha256: string;
  readonly receiptDenialSetSha256: string;
  readonly minimumRetainUntil: string;
}

export interface RetrievePostgresRecoveryBundleWormOptions {
  readonly outputDirectory: string;
  readonly wormResult: PostgresRecoveryBundleWormResult;
  readonly wormResultSha256: string;
  readonly bucketName: string;
  readonly expectedBucketNameSha256: string;
  readonly recoveryAccountId: string;
  readonly expectedRecoveryAccountIdSha256: string;
  readonly expectedReaderPrincipalArnSha256: string;
  readonly provider: PostgresLogicalWormProvider;
  readonly operationTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface PostgresRecoveryBundleWormRetrievalResult {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly kind: typeof POSTGRES_RECOVERY_BUNDLE_RETRIEVAL_KIND;
  readonly candidateSha: string;
  readonly recoveredAt: string;
  readonly recoverySetSha256: string;
  readonly recoveryManifestSha256: string;
  readonly logicalBackupManifestSha256: string;
  readonly bundleManifestSha256: string;
  readonly wormResultSha256: string;
  readonly wormReceiptSha256: string;
  readonly immutableObjectSetSha256: string;
  readonly entrySetSha256: string;
  readonly recoveredEntryCount: number;
  readonly recoveredBytes: string;
  readonly recoveryAccountIdSha256: string;
  readonly bucketNameSha256: string;
  readonly readerPrincipalArnSha256: string;
  readonly minimumRetainUntil: string;
}

function fail(code: PostgresRecoveryBundleWormFailureCode): never {
  throw new PostgresRecoveryBundleWormError(code);
}

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
  return hash(canonicalPostgresBackupJson(value));
}

function exactKeys(value: object, expected: readonly string[], code: PostgresRecoveryBundleWormFailureCode): void {
  if (canonicalPostgresBackupJson(Object.keys(value).sort(compare))
    !== canonicalPostgresBackupJson([...expected].sort(compare))) fail(code);
}

function exactTimestamp(value: unknown, code: PostgresRecoveryBundleWormFailureCode): string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(code);
  return value;
}

function exactSha(value: string): string {
  if (!SHA256.test(value)) fail("invalid_arguments");
  return value;
}

function exactCandidate(value: string): string {
  if (!CANDIDATE.test(value)) fail("invalid_arguments");
  return value;
}

function exactAbsolute(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    fail("invalid_arguments");
  }
  return value;
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameDirectory(
  left: ReturnType<typeof directoryIdentity>,
  right: ReturnType<typeof directoryIdentity>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function directoryIdentity(directoryPath: string, uid: number) {
  const stat = fs.lstatSync(directoryPath, { bigint: true });
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid)
    || Number(stat.mode & 0o7777n) !== 0o700
    || fs.realpathSync(directoryPath) !== directoryPath
  ) fail("unsafe_recovery_bundle");
  return Object.freeze({
    dev: stat.dev, ino: stat.ino, mode: stat.mode,
    mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
  });
}

function expectedRelativeEntries(manifest: ReturnType<
  typeof postgresPrivateStorageRecoveryInternals.parseRecoveryManifest
>): readonly BundleEntry[] {
  const entries: BundleEntry[] = [
    {
      slot: "manifest",
      relativePath: POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST,
      bytes: "0",
      sha256: "",
      contentType: "application/json",
    },
    {
      slot: "ledger-checkpoint",
      relativePath: `${POSTGRES_PRIVATE_STORAGE_RECOVERY_DELETION_AUTHORITY}/checkpoint.json`,
      bytes: "0",
      sha256: manifest.deletionAuthority.checkpointSha256,
      contentType: "application/json",
    },
    {
      slot: "ledger-current",
      relativePath: `${POSTGRES_PRIVATE_STORAGE_RECOVERY_DELETION_AUTHORITY}/current.json`,
      bytes: "0",
      sha256: manifest.deletionAuthority.currentSha256,
      contentType: "application/json",
    },
    {
      slot: "ledger-genesis",
      relativePath: `${POSTGRES_PRIVATE_STORAGE_RECOVERY_DELETION_AUTHORITY}/genesis.json`,
      bytes: "0",
      sha256: manifest.deletionAuthority.genesisSha256,
      contentType: "application/json",
    },
  ];
  manifest.sourceStorage.objects.forEach((object, index) => {
    entries.push({
      slot: `storage-${String(index).padStart(8, "0")}`,
      relativePath: `${POSTGRES_PRIVATE_STORAGE_RECOVERY_OBJECTS}/${
        postgresPrivateStorageRecoveryInternals.recoveryObjectRelativePath(
          object.objectPath,
        )}`,
      bytes: String(object.bytes),
      sha256: object.sha256,
      contentType: object.contentType === "application/json"
        ? "application/json"
        : "application/octet-stream",
    });
  });
  return Object.freeze(entries);
}

function exactInventory(root: string, entries: readonly BundleEntry[], uid: number): void {
  const expectedFiles = new Set(entries.map((entry) => entry.relativePath));
  const expectedDirectories = new Set<string>(["."]);
  for (const relative of expectedFiles) {
    let current = path.dirname(relative);
    while (current !== ".") {
      expectedDirectories.add(current);
      current = path.dirname(current);
    }
  }
  const observedFiles = new Set<string>();
  const observedDirectories = new Set<string>(["."]);
  const walk = (directory: string, relative: string): void => {
    const identity = directoryIdentity(directory, uid);
    if (identity.dev !== directoryIdentity(root, uid).dev) fail("unsafe_recovery_bundle");
    for (const leaf of fs.readdirSync(directory).sort(compare)) {
      const absolute = path.join(directory, leaf);
      const childRelative = relative === "." ? leaf : `${relative}/${leaf}`;
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        observedDirectories.add(childRelative);
        walk(absolute, childRelative);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        observedFiles.add(childRelative);
      } else {
        fail("unsafe_recovery_bundle");
      }
    }
  };
  walk(root, ".");
  if (
    canonicalPostgresBackupJson([...observedFiles].sort(compare))
      !== canonicalPostgresBackupJson([...expectedFiles].sort(compare))
    || canonicalPostgresBackupJson([...observedDirectories].sort(compare))
      !== canonicalPostgresBackupJson([...expectedDirectories].sort(compare))
  ) fail("unsafe_recovery_bundle");
}

async function trustedBundle(input: {
  readonly directory: string;
  readonly expectedRecoverySetSha256: string;
  readonly expectedRecoveryManifestSha256: string;
  readonly candidateSha: string;
  readonly now: () => Date;
}): Promise<TrustedBundle> {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) fail("invalid_arguments");
  const directoryPath = exactAbsolute(input.directory);
  const directory = directoryIdentity(directoryPath, uid);
  const manifestPath = path.join(directoryPath, POSTGRES_PRIVATE_STORAGE_RECOVERY_MANIFEST);
  const manifestSnapshot = await postgresLogicalWormInternals.snapshotTrustedFile({
    filePath: manifestPath,
    uid,
    maximumBytes: MAX_MANIFEST_BYTES,
    retainBytes: true,
    invalidCode: "backup_manifest_invalid",
  }).catch(() => fail("unsafe_recovery_bundle"));
  if (!manifestSnapshot.bytes) fail("unsafe_recovery_bundle");
  const expectedManifestSha = exactSha(input.expectedRecoveryManifestSha256);
  if (manifestSnapshot.sha256 !== expectedManifestSha) fail("recovery_bundle_tampered");
  let recoveryManifest: ReturnType<
    typeof postgresPrivateStorageRecoveryInternals.parseRecoveryManifest
  >;
  try {
    recoveryManifest = postgresPrivateStorageRecoveryInternals.parseRecoveryManifest(
      manifestSnapshot.bytes,
    );
  } catch {
    fail("recovery_bundle_manifest_invalid");
  }
  if (
    recoveryManifest.recoverySetSha256 !== exactSha(input.expectedRecoverySetSha256)
    || recoveryManifest.logicalBackup.candidateSha !== input.candidateSha
  ) fail("recovery_bundle_manifest_invalid");
  const expected = expectedRelativeEntries(recoveryManifest);
  exactInventory(directoryPath, expected, uid);
  const trusted: TrustedEntry[] = [];
  let total = 0n;
  for (const entry of expected) {
    const maximumBytes = entry.slot === "manifest"
      ? MAX_MANIFEST_BYTES
      : entry.slot.startsWith("ledger-") ? MAX_LEDGER_BYTES : MAX_OBJECT_BYTES;
    const snapshot = entry.slot === "manifest"
      ? manifestSnapshot
      : await postgresLogicalWormInternals.snapshotTrustedFile({
        filePath: path.join(directoryPath, entry.relativePath),
        uid,
        maximumBytes,
        retainBytes: false,
        invalidCode: "backup_tampered",
      }).catch(() => fail("unsafe_recovery_bundle"));
    const expectedHash = entry.slot === "manifest" ? expectedManifestSha : entry.sha256;
    if (snapshot.sha256 !== expectedHash) fail("recovery_bundle_tampered");
    if (entry.bytes !== "0" && snapshot.size.toString() !== entry.bytes) {
      fail("recovery_bundle_tampered");
    }
    total += snapshot.size;
    if (total > MAX_TOTAL_BYTES) fail("recovery_bundle_manifest_invalid");
    trusted.push(Object.freeze({
      ...entry,
      bytes: snapshot.size.toString(),
      sha256: snapshot.sha256,
      filePath: path.join(directoryPath, entry.relativePath),
      snapshot,
    }));
  }
  if (trusted.length > MAX_OBJECT_COUNT) fail("recovery_bundle_manifest_invalid");
  const createdAt = postgresLogicalWormInternals.canonicalNow(input.now);
  const manifestWithoutSet = {
    kind: POSTGRES_RECOVERY_BUNDLE_WORM_KIND,
    version: 1 as const,
    candidateSha: input.candidateSha,
    recoverySetSha256: recoveryManifest.recoverySetSha256,
    recoveryManifestSha256: expectedManifestSha,
    logicalBackupManifestSha256: recoveryManifest.logicalBackup.manifestSha256,
    createdAt,
    entries: trusted.map(({ filePath: _path, snapshot: _snapshot, ...entry }) => entry),
  };
  const bundleManifest: BundleManifest = Object.freeze({
    ...manifestWithoutSet,
    entrySetSha256: canonicalHash(manifestWithoutSet.entries),
  });
  const manifestBytes = Buffer.from(canonicalPostgresBackupJson(bundleManifest), "utf8");
  if (manifestBytes.length > Number(MAX_MANIFEST_BYTES)) {
    fail("recovery_bundle_manifest_invalid");
  }
  return Object.freeze({
    directoryPath,
    directoryIdentity: directory,
    manifest: bundleManifest,
    manifestBytes,
    manifestSha256: hash(manifestBytes),
    entries: Object.freeze(trusted),
  });
}

async function assertBundleUnchanged(bundle: TrustedBundle): Promise<void> {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
    fail("recovery_bundle_tampered");
  }
  if (!sameDirectory(bundle.directoryIdentity, directoryIdentity(bundle.directoryPath, uid))) {
    fail("recovery_bundle_tampered");
  }
  for (const entry of bundle.entries) {
    const snapshot = await postgresLogicalWormInternals.snapshotTrustedFile({
      filePath: entry.filePath,
      uid,
      maximumBytes: BigInt(entry.bytes),
      retainBytes: false,
      invalidCode: "backup_tampered",
    }).catch(() => fail("recovery_bundle_tampered"));
    if (
      snapshot.dev !== entry.snapshot.dev || snapshot.ino !== entry.snapshot.ino
      || snapshot.size !== entry.snapshot.size || snapshot.mtimeNs !== entry.snapshot.mtimeNs
      || snapshot.ctimeNs !== entry.snapshot.ctimeNs || snapshot.sha256 !== entry.sha256
    ) fail("recovery_bundle_tampered");
  }
}

function bundlePrefix(candidateSha: string, recoverySetSha256: string): string {
  return `${POSTGRES_RECOVERY_BUNDLE_WORM_PREFIX}/${exactCandidate(candidateSha)}-${
    exactSha(recoverySetSha256)}`;
}

function objectKey(prefix: string, slot: string): string {
  if (!SLOT.test(slot)) fail("recovery_bundle_manifest_invalid");
  return `${prefix}/data/${slot}`;
}

function manifestKey(prefix: string): string {
  return `${prefix}/bundle-manifest.json`;
}

function receiptKey(prefix: string, receiptSha256: string): string {
  return `${prefix}/receipts/${exactSha(receiptSha256)}.json`;
}

const WORM_RESULT_KEYS = Object.freeze([
  "schemaVersion", "ok", "kind", "candidateSha", "completedAt",
  "recoverySetSha256", "recoveryManifestSha256", "logicalBackupManifestSha256",
  "bundleManifestSha256", "immutableObjectSetSha256", "recoveryAccountIdSha256",
  "bucketNameSha256", "writerPrincipalArnSha256", "readerPrincipalArnSha256",
  "writerDenialSetSha256", "receiptSha256", "receiptObjectKeySha256",
  "receiptVersionIdSha256", "receiptDenialSetSha256", "minimumRetainUntil",
]);

const WORM_RECEIPT_KEYS = Object.freeze([
  "kind", "version", "candidateSha", "completedAt", "recoverySetSha256",
  "recoveryManifestSha256", "logicalBackupManifestSha256", "bundleManifestSha256",
  "recoveryAccountIdSha256", "bucketNameSha256", "writerPrincipalArnSha256",
  "readerPrincipalArnSha256", "operatorIdSha256", "bucketControlsSha256",
  "immutableObjects", "immutableObjectSetSha256", "writerDenials",
  "writerDenialSetSha256",
]);

const IMMUTABLE_DESCRIPTOR_KEYS = Object.freeze([
  "kind", "objectKeySha256", "versionIdSha256", "bytes", "sha256",
  "checksumSha256Base64Sha256", "contentType", "metadataSha256",
  "objectLockMode", "retainUntil", "lastModified", "created",
]);

const DENIAL_KEYS = Object.freeze([
  "action", "errorCode", "httpStatusCode", "requestIdSha256",
  "extendedRequestIdSha256",
]);

const DENIAL_ACTIONS = Object.freeze([
  "get_object_version", "list_object_versions", "delete_object_marker",
  "delete_object_version", "get_object_retention",
  "get_bucket_object_lock_configuration",
]);

function validateWormResult(
  value: PostgresRecoveryBundleWormResult,
  expectedSha256: string,
  nowMs: number,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("worm_result_invalid");
  exactKeys(value, WORM_RESULT_KEYS, "worm_result_invalid");
  if (value.schemaVersion !== 1 || value.ok !== true
    || value.kind !== POSTGRES_RECOVERY_BUNDLE_WORM_RECEIPT_KIND
    || !CANDIDATE.test(value.candidateSha)
    || canonicalHash(value) !== expectedSha256) fail("worm_result_invalid");
  const completedAt = exactTimestamp(value.completedAt, "worm_result_invalid");
  const retainUntil = exactTimestamp(value.minimumRetainUntil, "worm_result_invalid");
  for (const key of WORM_RESULT_KEYS.filter((key) => key.endsWith("Sha256"))) {
    if (!SHA256.test(String((value as unknown as Record<string, unknown>)[key]))) {
      fail("worm_result_invalid");
    }
  }
  if (value.writerPrincipalArnSha256 === value.readerPrincipalArnSha256
    || Date.parse(completedAt) > nowMs || Date.parse(retainUntil) <= nowMs) {
    fail("worm_result_invalid");
  }
}

function parseWormReceipt(
  bytes: Buffer,
  result: PostgresRecoveryBundleWormResult,
  nowMs: number,
): BundleWormReceipt {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("receipt_failed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalPostgresBackupJson(value) !== bytes.toString("utf8")) fail("receipt_failed");
  exactKeys(value, WORM_RECEIPT_KEYS, "receipt_failed");
  const receipt = value as BundleWormReceipt;
  if (receipt.kind !== POSTGRES_RECOVERY_BUNDLE_WORM_RECEIPT_KIND
    || receipt.version !== 1 || receipt.candidateSha !== result.candidateSha
    || exactTimestamp(receipt.completedAt, "receipt_failed") !== result.completedAt
    || !Array.isArray(receipt.immutableObjects) || receipt.immutableObjects.length < 5
    || receipt.immutableObjects.length > MAX_OBJECT_COUNT + 1
    || !Array.isArray(receipt.writerDenials)
    || receipt.writerDenials.length !== DENIAL_ACTIONS.length) fail("receipt_failed");
  for (const key of WORM_RECEIPT_KEYS.filter((key) => key.endsWith("Sha256"))) {
    if (!SHA256.test(String((receipt as unknown as Record<string, unknown>)[key]))) {
      fail("receipt_failed");
    }
  }
  let immutableDataBytes = 0n;
  for (const descriptor of receipt.immutableObjects) {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      fail("receipt_failed");
    }
    exactKeys(descriptor, IMMUTABLE_DESCRIPTOR_KEYS, "receipt_failed");
    if (!/^[1-9]\d*$/.test(descriptor.bytes) || BigInt(descriptor.bytes) > MAX_TOTAL_BYTES
      || !["recovery-bundle-manifest", "recovery-bundle-data"].includes(descriptor.kind)
      || !["application/json", "application/octet-stream"].includes(descriptor.contentType)
      || descriptor.objectLockMode !== "COMPLIANCE" || typeof descriptor.created !== "boolean") {
      fail("receipt_failed");
    }
    for (const key of ["objectKeySha256", "versionIdSha256", "sha256",
      "checksumSha256Base64Sha256", "metadataSha256"] as const) {
      if (!SHA256.test(descriptor[key])) fail("receipt_failed");
    }
    const retained = exactTimestamp(descriptor.retainUntil, "receipt_failed");
    const lastModified = exactTimestamp(descriptor.lastModified, "receipt_failed");
    if (Date.parse(retained) < Date.parse(result.minimumRetainUntil)
      || Date.parse(retained) <= nowMs || Date.parse(retained) <= Date.parse(lastModified)
    ) fail("receipt_failed");
    if (descriptor.kind === "recovery-bundle-data") {
      immutableDataBytes += BigInt(descriptor.bytes);
      if (immutableDataBytes > MAX_TOTAL_BYTES) fail("receipt_failed");
    }
  }
  receipt.writerDenials.forEach((denial, index) => {
    if (!denial || typeof denial !== "object" || Array.isArray(denial)) fail("receipt_failed");
    exactKeys(denial, DENIAL_KEYS, "receipt_failed");
    if (denial.action !== DENIAL_ACTIONS[index] || denial.errorCode !== "AccessDenied"
      || denial.httpStatusCode !== 403 || !SHA256.test(denial.requestIdSha256)
      || denial.extendedRequestIdSha256 !== null
        && !SHA256.test(denial.extendedRequestIdSha256)) fail("receipt_failed");
  });
  if (receipt.recoverySetSha256 !== result.recoverySetSha256
    || receipt.recoveryManifestSha256 !== result.recoveryManifestSha256
    || receipt.logicalBackupManifestSha256 !== result.logicalBackupManifestSha256
    || receipt.bundleManifestSha256 !== result.bundleManifestSha256
    || receipt.recoveryAccountIdSha256 !== result.recoveryAccountIdSha256
    || receipt.bucketNameSha256 !== result.bucketNameSha256
    || receipt.writerPrincipalArnSha256 !== result.writerPrincipalArnSha256
    || receipt.readerPrincipalArnSha256 !== result.readerPrincipalArnSha256
    || canonicalHash(receipt.immutableObjects) !== result.immutableObjectSetSha256
    || receipt.immutableObjectSetSha256 !== result.immutableObjectSetSha256
    || canonicalHash(receipt.writerDenials) !== result.writerDenialSetSha256
    || receipt.writerDenialSetSha256 !== result.writerDenialSetSha256) fail("receipt_failed");
  return receipt;
}

function metadata(input: {
  readonly kind: "recovery-bundle-manifest" | "recovery-bundle-data" | "recovery-bundle-receipt";
  readonly sha256: string;
  readonly bundleManifestSha256: string;
  readonly bundleIdSha256: string;
}): Readonly<Record<string, string>> {
  return Object.freeze({
    contract: POSTGRES_LOGICAL_WORM_CONTRACT,
    objectkind: input.kind,
    sha256: input.sha256,
    manifestsha256: input.bundleManifestSha256,
    backupidsha256: input.bundleIdSha256,
  });
}

function mapLogicalError(error: unknown): never {
  if (error instanceof PostgresRecoveryBundleWormError) throw error;
  if (error instanceof PostgresLogicalWormError) {
    if (error.code === "destination_pin_mismatch") fail("destination_pin_mismatch");
    if (error.code === "object_collision") fail("object_collision");
    if (["object_verification_failed", "retention_proof_failed"].includes(error.code)) {
      fail("object_verification_failed");
    }
    throw error;
  }
  fail("destination_unreachable");
}

export async function sealPostgresRecoveryBundleWorm(
  options: SealPostgresRecoveryBundleWormOptions,
): Promise<PostgresRecoveryBundleWormResult> {
  const candidateSha = exactCandidate(options.candidateSha);
  const bucketName = postgresLogicalWormInternals.assertBucketName(options.bucketName);
  const expectedBucketNameSha256 = exactSha(options.expectedBucketNameSha256);
  const recoveryAccountId = postgresLogicalWormInternals.assertAccountId(
    options.recoveryAccountId,
  );
  const expectedRecoveryAccountIdSha256 = exactSha(
    options.expectedRecoveryAccountIdSha256,
  );
  const expectedWriterPrincipalArnSha256 = exactSha(
    options.expectedWriterPrincipalArnSha256,
  );
  const expectedReaderPrincipalArnSha256 = exactSha(
    options.expectedReaderPrincipalArnSha256,
  );
  if (
    hash(bucketName) !== expectedBucketNameSha256
    || hash(recoveryAccountId) !== expectedRecoveryAccountIdSha256
    || options.provider.bucketName !== bucketName
    || options.provider.region !== POSTGRES_LOGICAL_WORM_REGION
  ) fail("destination_pin_mismatch");
  const forbidden = (options.forbiddenAccountIds ?? []).map((value) => (
    postgresLogicalWormInternals.assertAccountId(value)
  ));
  if (new Set(forbidden).size !== forbidden.length) fail("invalid_arguments");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{0,254}$/.test(options.operatorId)) {
    fail("invalid_arguments");
  }
  const operationTimeoutMs = postgresLogicalWormInternals.timeoutMs(
    options.operationTimeoutMs,
  );
  const now = options.now ?? (() => new Date());
  const bundle = await trustedBundle({
    directory: options.recoverySetDirectory,
    expectedRecoverySetSha256: options.expectedRecoverySetSha256,
    expectedRecoveryManifestSha256: options.expectedRecoveryManifestSha256,
    candidateSha,
    now,
  });
  try {
    const [writer, reader, controls] = await Promise.all([
      postgresLogicalWormInternals.boundedOperation(operationTimeoutMs, (signal) => (
        options.provider.inspectWriterIdentity(signal)
      )),
      postgresLogicalWormInternals.boundedOperation(operationTimeoutMs, (signal) => (
        options.provider.inspectReaderIdentity(signal)
      )),
      postgresLogicalWormInternals.boundedOperation(operationTimeoutMs, (signal) => (
        options.provider.inspectBucketControls({
          expectedBucketOwner: recoveryAccountId,
          signal,
        })
      )),
    ]);
    postgresLogicalWormInternals.assertAuthority({
      writer, reader, recoveryAccountId,
      expectedWriterPrincipalArnSha256,
      expectedReaderPrincipalArnSha256,
      forbiddenAccountIds: forbidden,
    });
    postgresLogicalWormInternals.assertBucketControls(controls);
    const prefix = bundlePrefix(candidateSha, bundle.manifest.recoverySetSha256);
    const bundleIdSha256 = hash(prefix);
    const common = {
      bundleManifestSha256: bundle.manifestSha256,
      bundleIdSha256,
    };
    const localObjects: PostgresLogicalWormLocalObject[] = [
      {
        kind: "recovery-bundle-manifest",
        key: manifestKey(prefix),
        bytes: bundle.manifestBytes.length,
        sha256: bundle.manifestSha256,
        contentType: "application/json",
        metadata: metadata({
          kind: "recovery-bundle-manifest",
          sha256: bundle.manifestSha256,
          ...common,
        }),
        openBody: async () => Readable.from([bundle.manifestBytes]),
      },
      ...bundle.entries.map((entry): PostgresLogicalWormLocalObject => ({
        kind: "recovery-bundle-data",
        key: objectKey(prefix, entry.slot),
        bytes: Number(entry.bytes),
        sha256: entry.sha256,
        contentType: entry.contentType,
        metadata: metadata({
          kind: "recovery-bundle-data",
          sha256: entry.sha256,
          ...common,
        }),
        openBody: () => postgresLogicalWormInternals.openTrustedBody({
          filePath: entry.filePath,
          snapshot: entry.snapshot,
        }),
      })),
    ];
    const verified: PostgresLogicalWormVerifiedObjectDescriptor[] = [];
    let denialKey = "";
    let denialVersion = "";
    for (const local of localObjects) {
      const remote = await postgresLogicalWormInternals.ensureAndVerifyObject({
        provider: options.provider,
        local,
        expectedBucketOwner: recoveryAccountId,
        earliestRetentionBaseMs: Date.parse(bundle.manifest.createdAt),
        operationTimeoutMs,
      });
      verified.push(remote.descriptor);
      if (!denialKey) {
        denialKey = local.key;
        denialVersion = remote.versionId;
      }
      await assertBundleUnchanged(bundle);
    }
    const writerDenials = await postgresLogicalWormInternals.writerDenialProof({
      provider: options.provider,
      key: denialKey,
      versionId: denialVersion,
      expectedBucketOwner: recoveryAccountId,
      operationTimeoutMs,
    });
    const immutableObjectSetSha256 = canonicalHash(verified);
    const writerDenialSetSha256 = canonicalHash(writerDenials);
    const completedAt = postgresLogicalWormInternals.canonicalNow(now);
    const receipt = Object.freeze({
      kind: POSTGRES_RECOVERY_BUNDLE_WORM_RECEIPT_KIND,
      version: 1,
      candidateSha,
      completedAt,
      recoverySetSha256: bundle.manifest.recoverySetSha256,
      recoveryManifestSha256: bundle.manifest.recoveryManifestSha256,
      logicalBackupManifestSha256: bundle.manifest.logicalBackupManifestSha256,
      bundleManifestSha256: bundle.manifestSha256,
      recoveryAccountIdSha256: expectedRecoveryAccountIdSha256,
      bucketNameSha256: expectedBucketNameSha256,
      writerPrincipalArnSha256: hash(writer.principalArn),
      readerPrincipalArnSha256: hash(reader.principalArn),
      operatorIdSha256: hash(options.operatorId),
      bucketControlsSha256: canonicalHash(controls),
      immutableObjects: verified,
      immutableObjectSetSha256,
      writerDenials,
      writerDenialSetSha256,
    });
    const receiptBytes = Buffer.from(canonicalPostgresBackupJson(receipt), "utf8");
    const receiptSha256 = hash(receiptBytes);
    const receiptObject: PostgresLogicalWormLocalObject = {
      kind: "recovery-bundle-receipt",
      key: receiptKey(prefix, receiptSha256),
      bytes: receiptBytes.length,
      sha256: receiptSha256,
      contentType: "application/json",
      metadata: metadata({
        kind: "recovery-bundle-receipt",
        sha256: receiptSha256,
        ...common,
      }),
      openBody: async () => Readable.from([receiptBytes]),
    };
    const remoteReceipt = await postgresLogicalWormInternals.ensureAndVerifyObject({
      provider: options.provider,
      local: receiptObject,
      expectedBucketOwner: recoveryAccountId,
      earliestRetentionBaseMs: Date.parse(bundle.manifest.createdAt),
      operationTimeoutMs,
    }).catch((error) => {
      if (error instanceof PostgresLogicalWormError) fail("receipt_failed");
      throw error;
    });
    const receiptDenials = await postgresLogicalWormInternals.writerDenialProof({
      provider: options.provider,
      key: receiptObject.key,
      versionId: remoteReceipt.versionId,
      expectedBucketOwner: recoveryAccountId,
      operationTimeoutMs,
    });
    await assertBundleUnchanged(bundle);
    return Object.freeze({
      schemaVersion: 1,
      ok: true,
      kind: POSTGRES_RECOVERY_BUNDLE_WORM_RECEIPT_KIND,
      candidateSha,
      completedAt,
      recoverySetSha256: bundle.manifest.recoverySetSha256,
      recoveryManifestSha256: bundle.manifest.recoveryManifestSha256,
      logicalBackupManifestSha256: bundle.manifest.logicalBackupManifestSha256,
      bundleManifestSha256: bundle.manifestSha256,
      immutableObjectSetSha256,
      recoveryAccountIdSha256: expectedRecoveryAccountIdSha256,
      bucketNameSha256: expectedBucketNameSha256,
      writerPrincipalArnSha256: hash(writer.principalArn),
      readerPrincipalArnSha256: hash(reader.principalArn),
      writerDenialSetSha256,
      receiptSha256,
      receiptObjectKeySha256: remoteReceipt.descriptor.objectKeySha256,
      receiptVersionIdSha256: remoteReceipt.descriptor.versionIdSha256,
      receiptDenialSetSha256: canonicalHash(receiptDenials),
      minimumRetainUntil: postgresLogicalWormInternals.minimumRetainUntil([
        ...verified,
        remoteReceipt.descriptor,
      ]),
    });
  } catch (error) {
    mapLogicalError(error);
  }
}

function parseBundleManifest(bytes: Buffer): BundleManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("retrieval_failed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("retrieval_failed");
  exactKeys(value, [
    "kind", "version", "candidateSha", "recoverySetSha256",
    "recoveryManifestSha256", "logicalBackupManifestSha256", "createdAt",
    "entries", "entrySetSha256",
  ], "retrieval_failed");
  const manifest = value as BundleManifest;
  if (
    manifest.kind !== POSTGRES_RECOVERY_BUNDLE_WORM_KIND || manifest.version !== 1
    || !CANDIDATE.test(manifest.candidateSha) || !SHA256.test(manifest.recoverySetSha256)
    || !SHA256.test(manifest.recoveryManifestSha256)
    || !SHA256.test(manifest.logicalBackupManifestSha256)
    || !Array.isArray(manifest.entries) || manifest.entries.length < 4
    || manifest.entries.length > MAX_OBJECT_COUNT || !SHA256.test(manifest.entrySetSha256)
    || canonicalPostgresBackupJson(value) !== bytes.toString("utf8")
    || canonicalHash(manifest.entries) !== manifest.entrySetSha256
  ) fail("retrieval_failed");
  exactTimestamp(manifest.createdAt, "retrieval_failed");
  const paths = new Set<string>();
  const slots = new Set<string>();
  let totalBytes = 0n;
  for (const entry of manifest.entries) {
    const entryBytes = typeof entry?.bytes === "string" && /^[1-9]\d*$/.test(entry.bytes)
      ? BigInt(entry.bytes)
      : 0n;
    const maximumBytes = typeof entry?.slot === "string" && entry.slot === "manifest"
      ? MAX_MANIFEST_BYTES
      : typeof entry?.slot === "string" && entry.slot.startsWith("ledger-")
        ? MAX_LEDGER_BYTES
        : MAX_OBJECT_BYTES;
    if (
      !entry || typeof entry !== "object" || !SLOT.test(entry.slot)
      || Array.isArray(entry)
      || !entry.relativePath || path.posix.normalize(entry.relativePath) !== entry.relativePath
      || entry.relativePath.startsWith("/") || entry.relativePath.includes("..")
      || !/^[1-9]\d*$/.test(entry.bytes) || entryBytes > maximumBytes
      || !SHA256.test(entry.sha256)
      || !["application/json", "application/octet-stream"].includes(entry.contentType)
      || paths.has(entry.relativePath) || slots.has(entry.slot)
    ) fail("retrieval_failed");
    exactKeys(entry, ["slot", "relativePath", "bytes", "sha256", "contentType"],
      "retrieval_failed");
    paths.add(entry.relativePath);
    slots.add(entry.slot);
    totalBytes += entryBytes;
    if (totalBytes > MAX_TOTAL_BYTES) fail("retrieval_failed");
  }
  if (!slots.has("manifest") || !slots.has("ledger-checkpoint")
    || !slots.has("ledger-current") || !slots.has("ledger-genesis")) {
    fail("retrieval_failed");
  }
  return manifest;
}

async function readRemoteBytes(input: {
  readonly provider: PostgresLogicalWormProvider;
  readonly key: string;
  readonly expectedBucketOwner: string;
  readonly expectedSha256: string;
  readonly maximumBytes: number;
  readonly operationTimeoutMs: number;
  readonly expectedContentType: "application/json" | "application/octet-stream";
  readonly expectedMetadata: Readonly<Record<string, string>>;
  readonly expectedObjectKeySha256?: string | undefined;
  readonly expectedVersionIdSha256?: string | undefined;
  readonly expectedMetadataSha256?: string | undefined;
  readonly expectedChecksumSha256Base64Sha256?: string | undefined;
  readonly expectedRetainUntil?: string | undefined;
  readonly expectedLastModified?: string | undefined;
  readonly minimumRetainUntil?: string | undefined;
  readonly nowMs?: number | undefined;
}): Promise<Buffer> {
  const inventory = await postgresLogicalWormInternals.boundedOperation(
    input.operationTimeoutMs,
    (signal) => input.provider.listExactVersions({
      key: input.key,
      expectedBucketOwner: input.expectedBucketOwner,
      signal,
    }),
  ).catch(() => fail("retrieval_failed"));
  if (
    inventory.truncated || inventory.deleteMarkers.length !== 0
    || inventory.versions.length !== 1 || inventory.versions[0]!.key !== input.key
  ) fail("retrieval_failed");
  const version = inventory.versions[0]!;
  if (!VERSION_ID.test(version.versionId) || version.isLatest !== true
    || !Number.isSafeInteger(version.bytes) || version.bytes < 1
    || version.bytes > input.maximumBytes
    || input.expectedObjectKeySha256 && hash(input.key) !== input.expectedObjectKeySha256
    || input.expectedVersionIdSha256 && hash(version.versionId) !== input.expectedVersionIdSha256) {
    fail("retrieval_failed");
  }
  const { remote, result, bytes } = await postgresLogicalWormInternals.boundedOperation(
    input.operationTimeoutMs,
    async (signal) => {
      const value = await input.provider.readExactVersion({
        key: input.key,
        versionId: version.versionId,
        expectedBucketOwner: input.expectedBucketOwner,
        signal,
      });
      const abort = () => value.body.destroy?.(new Error("bounded retrieval aborted"));
      signal.addEventListener("abort", abort, { once: true });
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        for await (const raw of value.body) {
          if (signal.aborted) throw new Error("bounded retrieval aborted");
          const chunk = Buffer.from(raw);
          length += chunk.length;
          if (length > input.maximumBytes) {
            value.body.destroy?.(new Error("bounded retrieval exceeded"));
            throw new Error("bounded retrieval exceeded");
          }
          chunks.push(chunk);
        }
        if (signal.aborted) throw new Error("bounded retrieval aborted");
        return { remote: value, result: Buffer.concat(chunks, length), bytes: length };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  ).catch(() => fail("retrieval_failed"));
  const retentionMs = typeof remote.retainUntil === "string"
    ? Date.parse(remote.retainUntil) : Number.NaN;
  const lastModifiedMs = Date.parse(remote.lastModified);
  if (
    version.isLatest !== true || remote.key !== input.key
    || !VERSION_ID.test(version.versionId)
    || remote.versionId !== version.versionId
    || !CANONICAL_TIMESTAMP.test(version.lastModified)
    || !Number.isFinite(Date.parse(version.lastModified))
    || new Date(version.lastModified).toISOString() !== version.lastModified
    || !CANONICAL_TIMESTAMP.test(remote.lastModified)
    || !Number.isFinite(lastModifiedMs)
    || new Date(lastModifiedMs).toISOString() !== remote.lastModified
    || remote.lastModified !== version.lastModified
    || bytes !== version.bytes || bytes !== remote.bytes || hash(result) !== input.expectedSha256
    || remote.checksumSha256Base64 !== Buffer.from(input.expectedSha256, "hex").toString("base64")
    || remote.contentType.toLowerCase() !== input.expectedContentType
    || remote.cacheControl.toLowerCase()
      !== postgresLogicalWormInternals.IMMUTABLE_CACHE_CONTROL
    || canonicalPostgresBackupJson(remote.metadata)
      !== canonicalPostgresBackupJson(input.expectedMetadata)
    || remote.serverSideEncryption !== "AES256"
    || remote.objectLockMode !== "COMPLIANCE" || !remote.retainUntil
    || !CANONICAL_TIMESTAMP.test(remote.retainUntil)
    || !Number.isFinite(retentionMs)
    || new Date(retentionMs).toISOString() !== remote.retainUntil
    || retentionMs <= (input.nowMs ?? Date.now())
    || input.expectedMetadataSha256
      && canonicalHash(input.expectedMetadata) !== input.expectedMetadataSha256
    || input.expectedChecksumSha256Base64Sha256
      && hash(remote.checksumSha256Base64) !== input.expectedChecksumSha256Base64Sha256
    || input.expectedRetainUntil && remote.retainUntil !== input.expectedRetainUntil
    || input.minimumRetainUntil
      && retentionMs < Date.parse(exactTimestamp(input.minimumRetainUntil, "retrieval_failed"))
    || input.expectedLastModified && remote.lastModified !== input.expectedLastModified
  ) fail("retrieval_failed");
  return result;
}

interface RetrievalOutputNode {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly size: bigint;
}

interface HeldRetrievalOutput {
  readonly root: string;
  createFile(relativePath: string, bytes: Buffer): void;
  assertExactInventory(relativePaths: readonly string[]): void;
  cleanupCreatedExact(): boolean;
  close(): void;
}

const OUTPUT_NOFOLLOW = fs.constants.O_NOFOLLOW;
const OUTPUT_DIRECTORY = fs.constants.O_DIRECTORY;

function outputNode(
  filename: string,
  uid: number,
  kind: "directory" | "file",
  descriptor?: number,
): RetrievalOutputNode {
  const stat = descriptor === undefined
    ? fs.lstatSync(filename, { bigint: true })
    : fs.fstatSync(descriptor, { bigint: true });
  const expectedMode = kind === "directory" ? 0o700n : 0o600n;
  if (
    (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
    || stat.isSymbolicLink() || stat.uid !== BigInt(uid)
    || Number(stat.mode & 0o7777n) !== Number(expectedMode)
    || kind === "file" && stat.nlink !== 1n
  ) fail("retrieval_output_unsafe");
  return Object.freeze({
    path: filename, kind, dev: stat.dev, ino: stat.ino, mode: stat.mode,
    uid: stat.uid, gid: stat.gid, size: stat.size,
  });
}

function outputPathMatches(node: RetrievalOutputNode, descriptor?: number): boolean {
  try {
    const stat = descriptor === undefined
      ? fs.lstatSync(node.path, { bigint: true })
      : fs.fstatSync(descriptor, { bigint: true });
    const pathname = fs.lstatSync(node.path, { bigint: true });
    return !pathname.isSymbolicLink()
      && (node.kind === "directory" ? stat.isDirectory() : stat.isFile())
      && stat.dev === node.dev && stat.ino === node.ino && stat.mode === node.mode
      && stat.uid === node.uid && stat.gid === node.gid
      && (node.kind === "directory" || stat.nlink === 1n && stat.size === node.size)
      && pathname.dev === node.dev && pathname.ino === node.ino
      && fs.realpathSync(node.path) === node.path;
  } catch {
    return false;
  }
}

function prepareOutputRoot(directory: string): HeldRetrievalOutput {
  const parent = path.dirname(directory);
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0
    || !Number.isSafeInteger(OUTPUT_NOFOLLOW) || OUTPUT_NOFOLLOW <= 0
    || !Number.isSafeInteger(OUTPUT_DIRECTORY) || OUTPUT_DIRECTORY <= 0) {
    fail("retrieval_output_unsafe");
  }
  let parentDescriptor: number | null = null;
  let rootCreated = false;
  const directoryDescriptors = new Map<string, number>();
  const directories = new Map<string, RetrievalOutputNode>();
  const files = new Map<string, RetrievalOutputNode>();
  let closed = false;
  const closeDescriptors = (): boolean => {
    if (closed) return true;
    closed = true;
    let exact = true;
    for (const descriptor of [...directoryDescriptors.values()].reverse()) {
      try { fs.closeSync(descriptor); } catch { exact = false; }
    }
    directoryDescriptors.clear();
    if (parentDescriptor !== null) {
      try { fs.closeSync(parentDescriptor); } catch { exact = false; }
      parentDescriptor = null;
    }
    return exact;
  };
  const assertDirectory = (filename: string): void => {
    const node = directories.get(filename);
    const descriptor = directoryDescriptors.get(filename);
    if (!node || descriptor === undefined || !outputPathMatches(node, descriptor)) {
      fail("retrieval_output_unsafe");
    }
  };
  const auditInventory = (): boolean => {
    try {
      if (closed || parentDescriptor === null) return false;
      const parentNode = outputNode(parent, uid, "directory", parentDescriptor);
      if (!outputPathMatches(parentNode, parentDescriptor)) return false;
      for (const [filename, descriptor] of directoryDescriptors) {
        const node = directories.get(filename);
        if (!node || !outputPathMatches(node, descriptor)) return false;
      }
      for (const node of files.values()) if (!outputPathMatches(node)) return false;
      const expectedChildren = new Map<string, Set<string>>();
      for (const filename of directories.keys()) expectedChildren.set(filename, new Set());
      for (const filename of [...directories.keys(), ...files.keys()]) {
        if (filename === directory) continue;
        expectedChildren.get(path.dirname(filename))?.add(path.basename(filename));
      }
      for (const [filename, children] of expectedChildren) {
        const observed = fs.readdirSync(filename).sort(compare);
        if (canonicalPostgresBackupJson(observed)
          !== canonicalPostgresBackupJson([...children].sort(compare))) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  const cleanupCreatedExact = (): boolean => {
    if (!rootCreated) {
      return closeDescriptors();
    }
    if (!auditInventory()) {
      closeDescriptors();
      return false;
    }
    try {
      for (const node of [...files.values()].reverse()) {
        if (!outputPathMatches(node)) throw new Error("output replaced");
        fs.unlinkSync(node.path);
      }
      files.clear();
      for (const node of [...directories.values()]
        .sort((left, right) => right.path.length - left.path.length)) {
        const descriptor = directoryDescriptors.get(node.path);
        if (descriptor === undefined || !outputPathMatches(node, descriptor)) {
          throw new Error("output replaced");
        }
        fs.rmdirSync(node.path);
      }
      rootCreated = false;
      if (parentDescriptor !== null) fs.fsyncSync(parentDescriptor);
      return closeDescriptors();
    } catch {
      closeDescriptors();
      return false;
    }
  };
  try {
    parentDescriptor = fs.openSync(
      parent,
      fs.constants.O_RDONLY | OUTPUT_DIRECTORY | OUTPUT_NOFOLLOW,
    );
    const parentNode = outputNode(parent, uid, "directory", parentDescriptor);
    if (!outputPathMatches(parentNode, parentDescriptor)) fail("retrieval_output_unsafe");
    fs.mkdirSync(directory, { mode: 0o700 });
    rootCreated = true;
    const rootDescriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | OUTPUT_DIRECTORY | OUTPUT_NOFOLLOW,
    );
    const rootNode = outputNode(directory, uid, "directory", rootDescriptor);
    directories.set(directory, rootNode);
    directoryDescriptors.set(directory, rootDescriptor);
    if (!outputPathMatches(parentNode, parentDescriptor)
      || !outputPathMatches(rootNode, rootDescriptor)) fail("retrieval_output_unsafe");
    return {
      root: directory,
      createFile(relativePath, bytes): void {
        if (closed) fail("retrieval_output_unsafe");
        const target = path.join(directory, relativePath);
        if (!target.startsWith(`${directory}${path.sep}`)) fail("retrieval_output_unsafe");
        let current = directory;
        assertDirectory(current);
        for (const part of path.dirname(relativePath).split(path.sep)
          .filter((value) => value !== ".")) {
          const child = path.join(current, part);
          if (!directories.has(child)) {
            assertDirectory(current);
            fs.mkdirSync(child, { mode: 0o700 });
            const descriptor = fs.openSync(
              child,
              fs.constants.O_RDONLY | OUTPUT_DIRECTORY | OUTPUT_NOFOLLOW,
            );
            const node = outputNode(child, uid, "directory", descriptor);
            directories.set(child, node);
            directoryDescriptors.set(child, descriptor);
            assertDirectory(current);
            assertDirectory(child);
          }
          current = child;
        }
        assertDirectory(directory);
        assertDirectory(current);
        let descriptor: number | null = null;
        try {
          descriptor = fs.openSync(
            target,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
              | OUTPUT_NOFOLLOW,
            0o600,
          );
          const before = outputNode(target, uid, "file", descriptor);
          if (before.size !== 0n || !outputPathMatches(before, descriptor)) {
            fail("retrieval_output_unsafe");
          }
          files.set(target, before);
          let offset = 0;
          while (offset < bytes.length) {
            const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (written < 1) fail("retrieval_output_unsafe");
            offset += written;
          }
          fs.fsyncSync(descriptor);
          const after = outputNode(target, uid, "file", descriptor);
          if (after.dev !== before.dev || after.ino !== before.ino
            || after.size !== BigInt(bytes.length) || !outputPathMatches(after, descriptor)) {
            fail("retrieval_output_unsafe");
          }
          files.set(target, after);
          assertDirectory(current);
          assertDirectory(directory);
        } finally {
          if (descriptor !== null) fs.closeSync(descriptor);
        }
      },
      assertExactInventory(relativePaths): void {
        const expected = [...relativePaths].sort(compare);
        const observed = [...files.keys()]
          .map((filename) => path.relative(directory, filename).split(path.sep).join("/"))
          .sort(compare);
        if (canonicalPostgresBackupJson(expected) !== canonicalPostgresBackupJson(observed)
          || !auditInventory()) fail("retrieval_output_unsafe");
      },
      cleanupCreatedExact,
      close(): void {
        if (!auditInventory()) {
          closeDescriptors();
          fail("retrieval_output_unsafe");
        }
        if (!closeDescriptors()) fail("retrieval_output_unsafe");
      },
    };
  } catch (error) {
    const cleaned = cleanupCreatedExact();
    if (!cleaned) fail("retrieval_output_unsafe");
    if (error instanceof PostgresRecoveryBundleWormError) throw error;
    fail("retrieval_output_unsafe");
  }
}

export async function retrievePostgresRecoveryBundleWorm(
  options: RetrievePostgresRecoveryBundleWormOptions,
): Promise<PostgresRecoveryBundleWormRetrievalResult> {
  const recoveredAt = postgresLogicalWormInternals.canonicalNow(
    options.now ?? (() => new Date()),
  );
  const nowMs = Date.parse(recoveredAt);
  const wormResultSha256 = exactSha(options.wormResultSha256);
  validateWormResult(options.wormResult, wormResultSha256, nowMs);
  const candidateSha = options.wormResult.candidateSha;
  const recoverySetSha256 = options.wormResult.recoverySetSha256;
  const recoveryManifestSha256 = options.wormResult.recoveryManifestSha256;
  const bundleManifestSha256 = options.wormResult.bundleManifestSha256;
  const bucketName = postgresLogicalWormInternals.assertBucketName(options.bucketName);
  const recoveryAccountId = postgresLogicalWormInternals.assertAccountId(
    options.recoveryAccountId,
  );
  const expectedBucketNameSha256 = exactSha(options.expectedBucketNameSha256);
  const expectedRecoveryAccountIdSha256 = exactSha(
    options.expectedRecoveryAccountIdSha256,
  );
  const expectedReaderPrincipalArnSha256 = exactSha(
    options.expectedReaderPrincipalArnSha256,
  );
  if (
    hash(bucketName) !== expectedBucketNameSha256
    || hash(recoveryAccountId) !== expectedRecoveryAccountIdSha256
    || options.provider.bucketName !== bucketName
    || options.provider.region !== POSTGRES_LOGICAL_WORM_REGION
    || options.wormResult.bucketNameSha256 !== expectedBucketNameSha256
    || options.wormResult.recoveryAccountIdSha256 !== expectedRecoveryAccountIdSha256
    || options.wormResult.readerPrincipalArnSha256 !== expectedReaderPrincipalArnSha256
  ) fail("destination_pin_mismatch");
  const operationTimeoutMs = postgresLogicalWormInternals.timeoutMs(
    options.operationTimeoutMs,
  );
  const [reader, controls] = await Promise.all([
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
  ]).catch(() => fail("destination_unreachable"));
  if (
    reader.accountId !== recoveryAccountId
    || hash(reader.principalArn) !== expectedReaderPrincipalArnSha256
  ) fail("destination_pin_mismatch");
  try {
    postgresLogicalWormInternals.assertBucketControls(controls);
  } catch {
    fail("destination_pin_mismatch");
  }
  const prefix = bundlePrefix(candidateSha, recoverySetSha256);
  const bundleIdSha256 = hash(prefix);
  const commonMetadata = { bundleManifestSha256, bundleIdSha256 };
  const receiptKeyValue = receiptKey(prefix, options.wormResult.receiptSha256);
  const receiptBytes = await readRemoteBytes({
    provider: options.provider,
    key: receiptKeyValue,
    expectedBucketOwner: recoveryAccountId,
    expectedSha256: options.wormResult.receiptSha256,
    maximumBytes: Number(MAX_MANIFEST_BYTES),
    operationTimeoutMs,
    expectedContentType: "application/json",
    expectedMetadata: metadata({
      kind: "recovery-bundle-receipt",
      sha256: options.wormResult.receiptSha256,
      ...commonMetadata,
    }),
    expectedObjectKeySha256: options.wormResult.receiptObjectKeySha256,
    expectedVersionIdSha256: options.wormResult.receiptVersionIdSha256,
    minimumRetainUntil: options.wormResult.minimumRetainUntil,
    nowMs,
  }).catch(() => fail("receipt_failed"));
  let receipt: BundleWormReceipt;
  try {
    receipt = parseWormReceipt(receiptBytes, options.wormResult, nowMs);
  } finally {
    receiptBytes.fill(0);
  }
  const immutableByKey = new Map<string, PostgresLogicalWormVerifiedObjectDescriptor>();
  for (const descriptor of receipt.immutableObjects) {
    if (immutableByKey.has(descriptor.objectKeySha256)) fail("receipt_failed");
    immutableByKey.set(descriptor.objectKeySha256, descriptor);
  }
  const exactDescriptor = (
    key: string,
    kind: "recovery-bundle-manifest" | "recovery-bundle-data",
  ): PostgresLogicalWormVerifiedObjectDescriptor => {
    const descriptor = immutableByKey.get(hash(key));
    if (!descriptor || descriptor.kind !== kind) fail("receipt_failed");
    return descriptor;
  };
  const bundleManifestKey = manifestKey(prefix);
  const manifestDescriptor = exactDescriptor(bundleManifestKey, "recovery-bundle-manifest");
  if (manifestDescriptor.sha256 !== bundleManifestSha256
    || manifestDescriptor.contentType !== "application/json"
    || BigInt(manifestDescriptor.bytes) > MAX_MANIFEST_BYTES) fail("receipt_failed");
  const manifestBytes = await readRemoteBytes({
    provider: options.provider,
    key: bundleManifestKey,
    expectedBucketOwner: recoveryAccountId,
    expectedSha256: bundleManifestSha256,
    maximumBytes: Number(BigInt(manifestDescriptor.bytes)),
    operationTimeoutMs,
    expectedContentType: "application/json",
    expectedMetadata: metadata({
      kind: "recovery-bundle-manifest",
      sha256: bundleManifestSha256,
      ...commonMetadata,
    }),
    expectedObjectKeySha256: manifestDescriptor.objectKeySha256,
    expectedVersionIdSha256: manifestDescriptor.versionIdSha256,
    expectedMetadataSha256: manifestDescriptor.metadataSha256,
    expectedChecksumSha256Base64Sha256: manifestDescriptor.checksumSha256Base64Sha256,
    expectedRetainUntil: manifestDescriptor.retainUntil,
    expectedLastModified: manifestDescriptor.lastModified,
    minimumRetainUntil: options.wormResult.minimumRetainUntil,
    nowMs,
  });
  let manifest: BundleManifest;
  try { manifest = parseBundleManifest(manifestBytes); } finally { manifestBytes.fill(0); }
  if (
    manifest.candidateSha !== candidateSha
    || manifest.recoverySetSha256 !== recoverySetSha256
    || manifest.recoveryManifestSha256 !== recoveryManifestSha256
    || manifest.logicalBackupManifestSha256 !== options.wormResult.logicalBackupManifestSha256
    || Date.parse(manifest.createdAt) > Date.parse(options.wormResult.completedAt)
    || receipt.immutableObjects.length !== manifest.entries.length + 1
  ) fail("retrieval_failed");
  const entryDescriptors = manifest.entries.map((entry) => {
    const key = objectKey(prefix, entry.slot);
    const descriptor = exactDescriptor(key, "recovery-bundle-data");
    if (descriptor.sha256 !== entry.sha256 || descriptor.bytes !== entry.bytes
      || descriptor.contentType !== entry.contentType) fail("receipt_failed");
    return Object.freeze({ entry, key, descriptor });
  });
  const declaredEntryBytes = manifest.entries.reduce(
    (sum, entry) => sum + BigInt(entry.bytes),
    0n,
  );
  const immutableEntryBytes = entryDescriptors.reduce(
    (sum, value) => sum + BigInt(value.descriptor.bytes),
    0n,
  );
  if (declaredEntryBytes > MAX_TOTAL_BYTES || immutableEntryBytes !== declaredEntryBytes) {
    fail("receipt_failed");
  }
  const outputDirectory = exactAbsolute(options.outputDirectory);
  const output = prepareOutputRoot(outputDirectory);
  let total = 0n;
  try {
    for (const { entry, key, descriptor } of entryDescriptors) {
      const bytes = await readRemoteBytes({
        provider: options.provider,
        key,
        expectedBucketOwner: recoveryAccountId,
        expectedSha256: entry.sha256,
        maximumBytes: Number(BigInt(entry.bytes)),
        operationTimeoutMs,
        expectedContentType: entry.contentType,
        expectedMetadata: metadata({
          kind: "recovery-bundle-data",
          sha256: entry.sha256,
          ...commonMetadata,
        }),
        expectedObjectKeySha256: descriptor.objectKeySha256,
        expectedVersionIdSha256: descriptor.versionIdSha256,
        expectedMetadataSha256: descriptor.metadataSha256,
        expectedChecksumSha256Base64Sha256: descriptor.checksumSha256Base64Sha256,
        expectedRetainUntil: descriptor.retainUntil,
        expectedLastModified: descriptor.lastModified,
        minimumRetainUntil: options.wormResult.minimumRetainUntil,
        nowMs,
      });
      try {
        output.createFile(entry.relativePath, bytes);
        total += BigInt(bytes.length);
      } finally {
        bytes.fill(0);
      }
    }
    output.assertExactInventory(manifest.entries.map((entry) => entry.relativePath));
    const verified = await trustedBundle({
      directory: outputDirectory,
      expectedRecoverySetSha256: recoverySetSha256,
      expectedRecoveryManifestSha256: recoveryManifestSha256,
      candidateSha,
      now: () => new Date(manifest.createdAt),
    });
    if (verified.manifest.entrySetSha256 !== manifest.entrySetSha256) {
      fail("retrieval_failed");
    }
    output.assertExactInventory(manifest.entries.map((entry) => entry.relativePath));
    output.close();
  } catch (error) {
    const cleaned = output.cleanupCreatedExact();
    if (!cleaned) fail("retrieval_output_unsafe");
    if (error instanceof PostgresRecoveryBundleWormError) throw error;
    fail("retrieval_failed");
  }
  return Object.freeze({
    schemaVersion: 1,
    ok: true,
    kind: POSTGRES_RECOVERY_BUNDLE_RETRIEVAL_KIND,
    candidateSha,
    recoveredAt,
    recoverySetSha256,
    recoveryManifestSha256,
    logicalBackupManifestSha256: manifest.logicalBackupManifestSha256,
    bundleManifestSha256,
    wormResultSha256,
    wormReceiptSha256: options.wormResult.receiptSha256,
    immutableObjectSetSha256: options.wormResult.immutableObjectSetSha256,
    entrySetSha256: manifest.entrySetSha256,
    recoveredEntryCount: manifest.entries.length,
    recoveredBytes: total.toString(),
    recoveryAccountIdSha256: expectedRecoveryAccountIdSha256,
    bucketNameSha256: expectedBucketNameSha256,
    readerPrincipalArnSha256: expectedReaderPrincipalArnSha256,
    minimumRetainUntil: options.wormResult.minimumRetainUntil,
  });
}

export const postgresRecoveryBundleWormInternals = {
  bundlePrefix,
  expectedRelativeEntries,
  metadata,
  parseBundleManifest,
  parseWormReceipt,
  readRemoteBytes,
  validateWormResult,
};
