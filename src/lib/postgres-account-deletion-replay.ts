import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { QueryResultRow } from "pg";

import {
  AccountDeletionQueueRepository,
  type AccountDeletionRequestRow,
} from "../db/account-deletion-queue.repository.js";
import {
  ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION,
  ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION,
  AccountPrivacyRepository,
} from "../db/account-privacy.repository.js";
import {
  createPostgresDatabase,
  type SqlDatabase,
} from "../db/sql-database.js";
import {
  type AccountDeletionTombstone,
  normalizeTombstones,
} from "./data-backup.js";
import { createPostgresAccountDeletionSecretPhysicalCheckpoint } from "./account-deletion-secret-checkpoint.js";
import { canonicalPostgresBackupJson } from "./postgres-logical-backup.js";
import type { PostgresLogicalRestoreReceipt } from "./postgres-logical-restore.js";

const APPLICATION_SCHEMA = "pintpath_app";
const OPERATIONS_SCHEMA = "pintpath_ops";
const RUNTIME_ROLE = "pintpath_runtime";
const MIGRATOR_ROLE = "pintpath_migrator";
const RESTORE_LOCK_KEY = "-5884877150838658403";
const DISPOSABLE_TARGET_CLASS = "disposable-rehearsal";
const RECEIPT_KIND = "pintpath-postgres-account-deletion-tombstone-replay" as const;
const RECEIPT_VERSION = 1 as const;
const AUTHORITY_CURRENT_FILE = "current.json";
const AUTHORITY_GENESIS_FILE = "genesis.json";
const AUTHORITY_CHECKPOINT_FILE = "checkpoint.json";
const REMOTE_CURRENT_PATH = "_control/account-deletion-tombstones.json";
const REMOTE_GENESIS_PATH = "_control/account-deletion-ledger-genesis.json";
const REMOTE_IMMUTABLE_PREFIX = "_control/account-deletion-ledger/v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,254}$/i;
const MAX_CONNECTION_FILE_BYTES = 16 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_CURRENT_BYTES = 64 * 1024 * 1024;
const MAX_CONTROL_BYTES = 1024 * 1024;

export const POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_ENV =
  "PINTPATH_POSTGRES_ACCOUNT_DELETION_REPLAY" as const;
export const POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE = "confirmed" as const;

export type PostgresAccountDeletionReplayFailureCode =
  | "invalid_arguments"
  | "confirmation_required"
  | "operator_guard_rejected"
  | "unsafe_connection_file"
  | "unsafe_connection_url"
  | "unsafe_authority_directory"
  | "authority_invalid"
  | "authority_tampered"
  | "base_restore_receipt_invalid"
  | "target_unreachable"
  | "target_not_disposable"
  | "target_identity_mismatch"
  | "target_role_unsafe"
  | "target_state_mismatch"
  | "target_busy"
  | "replay_incomplete_target_disposal_required"
  | "verification_failed_target_disposal_required"
  | "receipt_failed_target_disposal_required";

const FAILURE_MESSAGES: Readonly<Record<PostgresAccountDeletionReplayFailureCode, string>> = {
  invalid_arguments: "invalid_arguments",
  confirmation_required: "confirmation_required",
  operator_guard_rejected: "operator_guard_rejected",
  unsafe_connection_file: "unsafe_connection_file",
  unsafe_connection_url: "unsafe_connection_url",
  unsafe_authority_directory: "unsafe_authority_directory",
  authority_invalid: "authority_invalid",
  authority_tampered: "authority_tampered",
  base_restore_receipt_invalid: "base_restore_receipt_invalid",
  target_unreachable: "target_unreachable",
  target_not_disposable: "target_not_disposable",
  target_identity_mismatch: "target_identity_mismatch",
  target_role_unsafe: "target_role_unsafe",
  target_state_mismatch: "target_state_mismatch",
  target_busy: "target_busy",
  replay_incomplete_target_disposal_required: "replay_incomplete_target_disposal_required",
  verification_failed_target_disposal_required: "verification_failed_target_disposal_required",
  receipt_failed_target_disposal_required: "receipt_failed_target_disposal_required",
};

/** Stable failures never interpolate a URL, credential, account, or request identifier. */
export class PostgresAccountDeletionReplayError extends Error {
  constructor(readonly code: PostgresAccountDeletionReplayFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "PostgresAccountDeletionReplayError";
  }
}

export interface ReplayPostgresAccountDeletionTombstonesOptions {
  readonly runtimeUrlFile: string;
  readonly baseRestoreReceiptFile: string;
  readonly expectedBaseRestoreReceiptSha256: string;
  readonly deletionLedgerAuthorityDirectory: string;
  readonly expectedTargetIdentitySha256: string;
  readonly expectedLedgerCurrentSha256: string;
  readonly expectedLedgerGenesisSha256: string;
  readonly expectedLedgerCheckpointSha256: string;
  readonly expectedLedgerImmutableSetSha256: string;
  readonly expectedTombstoneCount: number;
  readonly receiptFile: string;
  readonly confirmation: string;
}

export interface PostgresAccountDeletionReplayCounts {
  readonly seen: number;
  readonly newlyApplied: number;
  readonly alreadyApplied: number;
  readonly missing: number;
  readonly failed: number;
}

export interface PostgresAccountDeletionReplayReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly version: typeof RECEIPT_VERSION;
  readonly status: "verified";
  readonly replayedAt: string;
  readonly targetIdentitySha256: string;
  readonly targetClass: typeof DISPOSABLE_TARGET_CLASS;
  readonly serverVersionNum: string;
  readonly runtimeRoleRestricted: true;
  readonly restoreLockKeySha256: string;
  readonly baseRestoreReceiptSha256: string;
  readonly migrationCandidateSha: string;
  readonly migrationManifestSha256: string;
  readonly migrationRunSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly backupManifestSha256: string;
  readonly backupArchiveSha256: string;
  readonly sourceStateReceiptSha256: string;
  readonly sourceSnapshotBindingSha256: string;
  readonly expectedSourceOverallStateSha256: string;
  readonly restoredOverallStateSha256: string;
  readonly ledgerCurrentSha256: string;
  readonly ledgerGenesisSha256: string;
  readonly ledgerCheckpointSha256: string;
  readonly ledgerImmutableSetSha256: string;
  readonly ledgerTombstoneCount: number;
  readonly counts: PostgresAccountDeletionReplayCounts;
  readonly recipientSecretPhysicalCheckpointVerified: true;
  readonly semanticProjectionSha256: string;
  readonly idempotency: "exact-semantic-projection";
}

export interface PostgresAccountDeletionReplayResult extends PostgresAccountDeletionReplayCounts {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly receiptSha256: string;
  readonly targetIdentitySha256: string;
  readonly ledgerCurrentSha256: string;
  readonly ledgerTombstoneCount: number;
  readonly semanticProjectionSha256: string;
}

interface AccountDeletionReplayQueueBoundary {
  getAccountDeletionRequestById(requestId: string): Promise<AccountDeletionRequestRow | null>;
  beginAccountDeletion(input: {
    requestId: string;
    reviewedBy: string;
    now: string;
    staleBefore: string;
  }): Promise<AccountDeletionRequestRow | null>;
  markAccountDeletionTombstoneRecorded(input: {
    requestId: string;
    attemptCount: number;
    recordedAt: string;
    now: string;
  }): Promise<boolean>;
  checkpointAccountDeletionNotificationSecrets(
    performPhysicalCheckpoint: (
      snapshot: readonly { requestId: string; generation: number }[],
    ) => Promise<boolean>,
  ): Promise<boolean>;
}

interface AccountDeletionReplayPrivacyBoundary {
  executeAccountAnonymisation(input: {
    requestId: string;
    attemptCount: number;
    reviewedBy: string;
    now: string;
    completionNotificationDisposition: "suppress_restore";
    providerPolicy: {
      requireTombstoneReceipt: true;
      allowUnconfirmedStripeDeletion: false;
    };
  }): Promise<{ readonly evidenceIds: string[] }>;
}

export interface PostgresAccountDeletionReplayDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getUid: () => number | null;
  readonly now: () => Date;
  readonly createDatabase: (connectionString: string) => SqlDatabase;
  readonly createQueue: (database: SqlDatabase) => AccountDeletionReplayQueueBoundary;
  readonly createPrivacy: (database: SqlDatabase) => AccountDeletionReplayPrivacyBoundary;
  readonly createPhysicalCheckpoint: (
    database: SqlDatabase,
  ) => (snapshot: readonly { requestId: string; generation: number }[]) => Promise<boolean>;
  /** Test seam only: also requires NODE_ENV=test and an exact loopback host. */
  readonly allowInsecureLoopbackForTests: boolean;
}

interface TrustedFileIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly sha256: string;
}

interface TrustedFileSnapshot extends TrustedFileIdentity {
  readonly bytes: Buffer;
}

interface TrustedDirectorySnapshot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface LedgerGenesis {
  readonly version: 1;
  readonly kind: "pint-path-account-deletion-ledger-genesis";
  readonly createdAt: string;
  readonly immutablePrefix: typeof REMOTE_IMMUTABLE_PREFIX;
  readonly currentLedgerPath: typeof REMOTE_CURRENT_PATH;
}

interface LedgerCheckpoint {
  readonly version: 2;
  readonly generatedAt: string;
  readonly genesisPath: typeof REMOTE_GENESIS_PATH;
  readonly genesisSha256: string;
  readonly currentLedgerPath: typeof REMOTE_CURRENT_PATH;
  readonly currentLedgerSha256: string;
  readonly immutableObjectCount: number;
  readonly immutableSetSha256: string;
  readonly tombstoneCount: number;
  readonly latestCompletedAt: string | null;
}

interface TrustedAuthority {
  readonly directory: TrustedDirectorySnapshot;
  readonly current: TrustedFileIdentity;
  readonly genesis: TrustedFileIdentity;
  readonly checkpoint: TrustedFileIdentity;
  readonly tombstones: readonly AccountDeletionTombstone[];
  readonly checkpointDocument: LedgerCheckpoint;
}

interface TargetInspectionRow extends QueryResultRow {
  readonly systemIdentifier: string;
  readonly databaseOid: string;
  readonly databaseName: string;
  readonly serverVersionNum: string;
  readonly targetClass: string | null;
  readonly transactionReadOnly: boolean;
  readonly inRecovery: boolean;
  readonly databaseIsTemplate: boolean;
  readonly databaseAllowsConnections: boolean;
  readonly sameEffectiveRole: boolean;
  readonly roleName: string;
  readonly canLogin: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly runtimeMember: boolean;
  readonly migratorMember: boolean;
  readonly applicationSchemaUsage: boolean;
  readonly operationsSchemaUsage: boolean;
  readonly searchPathSchemas: string[];
  readonly currentSchema: string | null;
  readonly hasDatabaseCreatePrivilege: boolean;
  readonly applicationSchemaCreate: boolean;
  readonly unexpectedMembership: boolean;
}

interface TargetInspection {
  readonly targetIdentitySha256: string;
  readonly serverVersionNum: string;
}

interface TargetMetadata extends QueryResultRow {
  readonly key: string;
  readonly value: string;
}

interface ReplayStateRow extends QueryResultRow {
  readonly requestId: string;
  readonly userId: string;
  readonly requestStatus: string;
  readonly reviewedBy: string | null;
  readonly completedAt: string | null;
  readonly deletionTombstoneRecordedAt: string | null;
  readonly requestUserMessage: string | null;
  readonly requestLastError: string | null;
  readonly resultSummaryJson: string | null;
  readonly accountPublicId: string | null;
  readonly accountEmail: string | null;
  readonly passwordHash: string | null;
  readonly authProvider: string | null;
  readonly supabaseUserId: string | null;
  readonly stripeCustomerId: string | null;
  readonly accountStatus: string | null;
  readonly subscriptionStatus: string | null;
  readonly profilePublicId: string | null;
  readonly profileStatus: string | null;
  readonly outboxStatus: string | null;
  readonly outboxTerminalAt: string | null;
  readonly outboxNextAttemptAt: string | null;
  readonly outboxLeaseToken: string | null;
  readonly outboxLeaseExpiresAt: string | null;
  readonly outboxProviderMessageId: string | null;
  readonly outboxProviderLastEvent: string | null;
  readonly outboxProviderEventAt: string | null;
  readonly outboxLastError: string | null;
  readonly secretPurgeCheckpointPending: boolean | null;
  readonly authSessionCount: string;
  readonly recipientSecretCount: string;
  readonly notificationEventCount: string;
  readonly activeSourceEvidenceCount: string;
}

interface LockRow extends QueryResultRow {
  readonly acquired: boolean;
  readonly backendPid: string;
}

interface LockHeldRow extends QueryResultRow {
  readonly held: boolean;
  readonly backendPid: string;
}

interface OtherClientBackendsRow extends QueryResultRow {
  readonly otherClientBackends: string;
}

interface ReplayProjection {
  readonly tombstoneSha256: string;
  readonly completedAt: string;
  readonly accountStatus: "suspended";
  readonly authProvider: "deleted";
  readonly providerIdentifiersCleared: true;
  readonly authSessionCount: "0";
  readonly requestStatus: "completed";
  readonly outboxStatus: "suppressed_restore";
  readonly recipientSecretCount: "0";
  readonly secretPurgeCheckpointPending: false;
  readonly notificationEventCount: "0";
  readonly activeSourceEvidenceCount: "0";
  readonly evidenceIdCount: 0;
  readonly removedSubmissions: number;
  readonly removedSubmissionItems: number;
  readonly removedContributionRows: number;
  readonly removedDerivedPriceRecords: number;
}

const BASE_RECEIPT_KEYS = Object.freeze([
  "aclContractSha256",
  "apiRolesIsolated",
  "authoritativeColumnCount",
  "authoritativeCountInventorySha256",
  "authoritativeRowCount",
  "authoritativeTableCount",
  "backupArchiveSha256",
  "backupManifestSha256",
  "controlCountInventorySha256",
  "exactDataReconciliation",
  "expectedArchivedControlDataSha256",
  "expectedArchivedControlKeyRangesSha256",
  "expectedArchivedControlTableSetSha256",
  "expectedSourceDataSha256",
  "expectedSourceKeyRangesSha256",
  "expectedSourceOverallStateSha256",
  "expectedSourceStateReceiptSha256",
  "expectedSourceStateTotalsSha256",
  "expectedSourceTableSetSha256",
  "foreignKeyCount",
  "kind",
  "migratorReconciliationAccessVerified",
  "nonEmptyAuthoritativeTableCount",
  "promotionReconciliationReady",
  "restoredAt",
  "restoredOverallStateSha256",
  "rowSecurityTableCount",
  "runtimeApplicationAccessRestored",
  "runtimeOperationsIsolated",
  "schemaMetadataSha256",
  "sourceSnapshotBindingSha256",
  "sourceStateBindingStatus",
  "status",
  "targetIdentitySha256",
  "targetUrlSha256",
  "version",
] as const);

const DEFAULT_DEPENDENCIES: PostgresAccountDeletionReplayDependencies = {
  env: process.env,
  getUid: () => process.getuid?.() ?? null,
  now: () => new Date(),
  createDatabase: (connectionString) => createPostgresDatabase({
    connectionString,
    applicationName: "pintpath-account-deletion-tombstone-replay",
    maxConnections: 1,
    // The session-level advisory lock is an authorization boundary. Do not let
    // the pool retire its sole idle backend between exact lock proofs.
    idleTimeoutMs: 0,
    statementTimeoutMs: 30_000,
    idleInTransactionTimeoutMs: 30_000,
  }),
  createQueue: (database) => new AccountDeletionQueueRepository(database),
  createPrivacy: (database) => new AccountPrivacyRepository(database),
  createPhysicalCheckpoint: createPostgresAccountDeletionSecretPhysicalCheckpoint,
  allowInsecureLoopbackForTests: false,
};

function replayError(
  code: PostgresAccountDeletionReplayFailureCode,
): PostgresAccountDeletionReplayError {
  return new PostgresAccountDeletionReplayError(code);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalPostgresBackupJson(value));
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw replayError("invalid_arguments");
  }
  return value;
}

function exactCount(value: unknown, allowZero = true): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw replayError("invalid_arguments");
  }
  return Number(value);
}

function canonicalUtc(value: unknown, code: PostgresAccountDeletionReplayFailureCode): string {
  if (typeof value !== "string") throw replayError(code);
  try {
    if (new Date(value).toISOString() !== value) throw new Error("not-canonical");
  } catch {
    throw replayError(code);
  }
  return value;
}

function canonicalAbsolutePath(value: string): string {
  if (!value || value.includes("\0") || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw replayError("invalid_arguments");
  }
  return value;
}

function exactUid(dependencies: PostgresAccountDeletionReplayDependencies): number {
  const uid = dependencies.getUid();
  if (uid === null || !Number.isInteger(uid) || uid < 0) {
    throw replayError("invalid_arguments");
  }
  return uid;
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

function retainTrustedFileIdentity(snapshot: TrustedFileSnapshot): TrustedFileIdentity {
  return {
    path: snapshot.path,
    dev: snapshot.dev,
    ino: snapshot.ino,
    size: snapshot.size,
    mtimeNs: snapshot.mtimeNs,
    ctimeNs: snapshot.ctimeNs,
    sha256: snapshot.sha256,
  };
}

async function readTrustedPrivateFile(input: {
  filePath: string;
  uid: number;
  maxBytes: number;
  invalidCode: PostgresAccountDeletionReplayFailureCode;
}): Promise<TrustedFileSnapshot> {
  const filePath = canonicalAbsolutePath(input.filePath);
  let handle: fs.promises.FileHandle | null = null;
  let bytes: Buffer | null = null;
  let snapshot: TrustedFileSnapshot | null = null;
  let failed = false;
  try {
    const pathStat = fs.lstatSync(filePath, { bigint: true });
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1n
      || pathStat.uid !== BigInt(input.uid)
      || Number(pathStat.mode & 0o7777n) !== 0o600
      || pathStat.size < 1n
      || pathStat.size > BigInt(input.maxBytes)
      || fs.realpathSync(filePath) !== filePath
    ) throw new Error("unsafe");
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(pathStat, opened)) throw new Error("changed");
    bytes = await handle.readFile();
    const afterDescriptor = await handle.stat({ bigint: true });
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    if (
      !sameFileIdentity(pathStat, afterDescriptor)
      || !sameFileIdentity(pathStat, afterPath)
      || bytes.length !== Number(pathStat.size)
    ) throw new Error("changed");
    snapshot = {
      path: filePath,
      dev: pathStat.dev,
      ino: pathStat.ino,
      size: pathStat.size,
      mtimeNs: pathStat.mtimeNs,
      ctimeNs: pathStat.ctimeNs,
      sha256: sha256(bytes),
      bytes,
    };
  } catch {
    failed = true;
  }
  if (handle) {
    const closing = handle;
    handle = null;
    try {
      await closing.close();
    } catch {
      failed = true;
    }
  }
  if (failed || !snapshot) {
    bytes?.fill(0);
    throw replayError(input.invalidCode);
  }
  return snapshot;
}

async function assertTrustedFileUnchanged(
  expected: TrustedFileIdentity,
  uid: number,
  code: PostgresAccountDeletionReplayFailureCode,
): Promise<void> {
  const actual = await readTrustedPrivateFile({
    filePath: expected.path,
    uid,
    maxBytes: Number(expected.size),
    invalidCode: code,
  });
  try {
    if (
      actual.dev !== expected.dev
      || actual.ino !== expected.ino
      || actual.size !== expected.size
      || actual.mtimeNs !== expected.mtimeNs
      || actual.ctimeNs !== expected.ctimeNs
      || actual.sha256 !== expected.sha256
    ) throw replayError(code);
  } finally {
    actual.bytes.fill(0);
  }
}

function safeUtf8(bytes: Buffer, code: PostgresAccountDeletionReplayFailureCode): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw replayError(code);
  }
}

function strictJson(
  bytes: Buffer,
  code: PostgresAccountDeletionReplayFailureCode,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(safeUtf8(bytes, code));
    if (!isObject(parsed)) throw new Error("shape");
    return parsed;
  } catch (error) {
    if (error instanceof PostgresAccountDeletionReplayError) throw error;
    throw replayError(code);
  }
}

function prettyJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseCanonicalTombstones(bytes: Buffer): readonly AccountDeletionTombstone[] {
  const document = strictJson(bytes, "authority_invalid");
  if (!exactKeys(document, ["version", "generatedAt", "tombstones"])) {
    throw replayError("authority_invalid");
  }
  const generatedAt = canonicalUtc(document.generatedAt, "authority_invalid");
  if (document.version !== 1 || !Array.isArray(document.tombstones)) {
    throw replayError("authority_invalid");
  }
  const supplied = document.tombstones.map((value) => {
    if (!isObject(value) || !exactKeys(value, ["requestId", "userId", "completedAt"])) {
      throw replayError("authority_invalid");
    }
    if (
      typeof value.requestId !== "string"
      || !IDENTIFIER_PATTERN.test(value.requestId)
      || typeof value.userId !== "string"
      || !IDENTIFIER_PATTERN.test(value.userId)
    ) throw replayError("authority_invalid");
    return {
      requestId: value.requestId,
      userId: value.userId,
      completedAt: canonicalUtc(value.completedAt, "authority_invalid"),
    };
  });
  const normalized = normalizeTombstones(supplied);
  if (canonicalPostgresBackupJson(supplied) !== canonicalPostgresBackupJson(normalized)) {
    throw replayError("authority_invalid");
  }
  const canonicalDocument = { version: 1, generatedAt, tombstones: normalized };
  if (!prettyJson(canonicalDocument).equals(bytes)) throw replayError("authority_invalid");
  return normalized;
}

function parseCanonicalGenesis(bytes: Buffer): LedgerGenesis {
  const value = strictJson(bytes, "authority_invalid");
  if (!exactKeys(value, ["version", "kind", "createdAt", "immutablePrefix", "currentLedgerPath"])) {
    throw replayError("authority_invalid");
  }
  const genesis: LedgerGenesis = {
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt: canonicalUtc(value.createdAt, "authority_invalid"),
    immutablePrefix: REMOTE_IMMUTABLE_PREFIX,
    currentLedgerPath: REMOTE_CURRENT_PATH,
  };
  if (
    value.version !== genesis.version
    || value.kind !== genesis.kind
    || value.immutablePrefix !== genesis.immutablePrefix
    || value.currentLedgerPath !== genesis.currentLedgerPath
    || !prettyJson(genesis).equals(bytes)
  ) throw replayError("authority_invalid");
  return genesis;
}

function parseCanonicalCheckpoint(bytes: Buffer): LedgerCheckpoint {
  const value = strictJson(bytes, "authority_invalid");
  if (!exactKeys(value, [
    "version", "generatedAt", "genesisPath", "genesisSha256", "currentLedgerPath",
    "currentLedgerSha256", "immutableObjectCount", "immutableSetSha256",
    "tombstoneCount", "latestCompletedAt",
  ])) throw replayError("authority_invalid");
  const latestCompletedAt = value.latestCompletedAt === null
    ? null
    : canonicalUtc(value.latestCompletedAt, "authority_invalid");
  if (
    value.version !== 2
    || value.genesisPath !== REMOTE_GENESIS_PATH
    || value.currentLedgerPath !== REMOTE_CURRENT_PATH
    || typeof value.genesisSha256 !== "string"
    || !SHA256_PATTERN.test(value.genesisSha256)
    || typeof value.currentLedgerSha256 !== "string"
    || !SHA256_PATTERN.test(value.currentLedgerSha256)
    || !Number.isSafeInteger(value.immutableObjectCount)
    || Number(value.immutableObjectCount) < 0
    || typeof value.immutableSetSha256 !== "string"
    || !SHA256_PATTERN.test(value.immutableSetSha256)
    || !Number.isSafeInteger(value.tombstoneCount)
    || Number(value.tombstoneCount) < 0
  ) throw replayError("authority_invalid");
  const checkpoint: LedgerCheckpoint = {
    version: 2,
    generatedAt: canonicalUtc(value.generatedAt, "authority_invalid"),
    genesisPath: REMOTE_GENESIS_PATH,
    genesisSha256: value.genesisSha256,
    currentLedgerPath: REMOTE_CURRENT_PATH,
    currentLedgerSha256: value.currentLedgerSha256,
    immutableObjectCount: Number(value.immutableObjectCount),
    immutableSetSha256: value.immutableSetSha256,
    tombstoneCount: Number(value.tombstoneCount),
    latestCompletedAt,
  };
  if (!prettyJson(checkpoint).equals(bytes)) throw replayError("authority_invalid");
  return checkpoint;
}

async function readAuthority(input: {
  directory: string;
  uid: number;
  expectedCurrentSha256: string;
  expectedGenesisSha256: string;
  expectedCheckpointSha256: string;
  expectedImmutableSetSha256: string;
  expectedTombstoneCount: number;
}): Promise<TrustedAuthority> {
  const directoryPath = canonicalAbsolutePath(input.directory);
  let directoryStat: fs.BigIntStats;
  try {
    directoryStat = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || directoryStat.uid !== BigInt(input.uid)
      || Number(directoryStat.mode & 0o7777n) !== 0o700
      || fs.realpathSync(directoryPath) !== directoryPath
      || JSON.stringify(fs.readdirSync(directoryPath).sort()) !== JSON.stringify([
        AUTHORITY_CHECKPOINT_FILE,
        AUTHORITY_CURRENT_FILE,
        AUTHORITY_GENESIS_FILE,
      ])
    ) throw new Error("unsafe");
  } catch {
    throw replayError("unsafe_authority_directory");
  }
  let current: TrustedFileSnapshot | null = null;
  let genesis: TrustedFileSnapshot | null = null;
  let checkpoint: TrustedFileSnapshot | null = null;
  try {
    current = await readTrustedPrivateFile({
      filePath: path.join(directoryPath, AUTHORITY_CURRENT_FILE),
      uid: input.uid,
      maxBytes: MAX_CURRENT_BYTES,
      invalidCode: "unsafe_authority_directory",
    });
    genesis = await readTrustedPrivateFile({
      filePath: path.join(directoryPath, AUTHORITY_GENESIS_FILE),
      uid: input.uid,
      maxBytes: MAX_CONTROL_BYTES,
      invalidCode: "unsafe_authority_directory",
    });
    checkpoint = await readTrustedPrivateFile({
      filePath: path.join(directoryPath, AUTHORITY_CHECKPOINT_FILE),
      uid: input.uid,
      maxBytes: MAX_CONTROL_BYTES,
      invalidCode: "unsafe_authority_directory",
    });
    if (
      current.sha256 !== input.expectedCurrentSha256
      || genesis.sha256 !== input.expectedGenesisSha256
      || checkpoint.sha256 !== input.expectedCheckpointSha256
    ) throw replayError("authority_tampered");
    const tombstones = parseCanonicalTombstones(current.bytes);
    const genesisDocument = parseCanonicalGenesis(genesis.bytes);
    const checkpointDocument = parseCanonicalCheckpoint(checkpoint.bytes);
    const latestCompletedAt = tombstones.reduce<string | null>(
      (latest, tombstone) => latest === null || tombstone.completedAt > latest
        ? tombstone.completedAt
        : latest,
      null,
    );
    const currentValue = strictJson(current.bytes, "authority_invalid");
    const expectedGeneratedAt = new Date(Math.max(
      Date.parse(genesisDocument.createdAt),
      latestCompletedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(latestCompletedAt),
    )).toISOString();
    if (
      checkpointDocument.currentLedgerSha256 !== current.sha256
      || checkpointDocument.genesisSha256 !== genesis.sha256
      || checkpointDocument.generatedAt !== currentValue.generatedAt
      || checkpointDocument.generatedAt !== expectedGeneratedAt
      || checkpointDocument.immutableSetSha256 !== input.expectedImmutableSetSha256
      || checkpointDocument.immutableObjectCount < tombstones.length
      || checkpointDocument.tombstoneCount !== input.expectedTombstoneCount
      || tombstones.length !== input.expectedTombstoneCount
      || checkpointDocument.latestCompletedAt !== latestCompletedAt
    ) throw replayError("authority_tampered");
    return {
      directory: { path: directoryPath, dev: directoryStat.dev, ino: directoryStat.ino },
      current: retainTrustedFileIdentity(current),
      genesis: retainTrustedFileIdentity(genesis),
      checkpoint: retainTrustedFileIdentity(checkpoint),
      tombstones,
      checkpointDocument,
    };
  } finally {
    current?.bytes.fill(0);
    genesis?.bytes.fill(0);
    checkpoint?.bytes.fill(0);
  }
}

async function assertAuthorityUnchanged(authority: TrustedAuthority, uid: number): Promise<void> {
  let directoryStat: fs.BigIntStats;
  try {
    directoryStat = fs.lstatSync(authority.directory.path, { bigint: true });
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || directoryStat.uid !== BigInt(uid)
      || Number(directoryStat.mode & 0o7777n) !== 0o700
      || directoryStat.dev !== authority.directory.dev
      || directoryStat.ino !== authority.directory.ino
      || JSON.stringify(fs.readdirSync(authority.directory.path).sort()) !== JSON.stringify([
        AUTHORITY_CHECKPOINT_FILE,
        AUTHORITY_CURRENT_FILE,
        AUTHORITY_GENESIS_FILE,
      ])
    ) throw new Error("changed");
  } catch {
    throw replayError("authority_tampered");
  }
  // Settle each descriptor lifecycle before starting the next one. A
  // fail-fast Promise.all would let later reads/close attempts continue after
  // the caller had already begun database cleanup or receipt handling.
  await assertTrustedFileUnchanged(authority.current, uid, "authority_tampered");
  await assertTrustedFileUnchanged(authority.genesis, uid, "authority_tampered");
  await assertTrustedFileUnchanged(authority.checkpoint, uid, "authority_tampered");
}

function validBaseRestoreReceipt(value: Record<string, unknown>): boolean {
  if (!exactKeys(value, BASE_RECEIPT_KEYS)) return false;
  const hashKeys = BASE_RECEIPT_KEYS.filter((key) => key.endsWith("Sha256"));
  const trueKeys = [
    "apiRolesIsolated",
    "migratorReconciliationAccessVerified",
    "promotionReconciliationReady",
    "runtimeApplicationAccessRestored",
    "runtimeOperationsIsolated",
  ];
  const countKeys = [
    "authoritativeColumnCount",
    "authoritativeTableCount",
    "foreignKeyCount",
    "nonEmptyAuthoritativeTableCount",
    "rowSecurityTableCount",
  ];
  return value.kind === "pintpath-postgres-logical-restore-rehearsal"
    && value.version === 1
    && value.status === "verified"
    && value.sourceStateBindingStatus === "exact-match"
    && value.exactDataReconciliation === "canonical-contract-exact"
    && typeof value.authoritativeRowCount === "string"
    && /^\d+$/.test(value.authoritativeRowCount)
    && canonicalUtc(value.restoredAt, "base_restore_receipt_invalid") === value.restoredAt
    && hashKeys.every((key) => typeof value[key] === "string" && SHA256_PATTERN.test(value[key] as string))
    && trueKeys.every((key) => value[key] === true)
    && countKeys.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    && value.expectedSourceOverallStateSha256 === value.restoredOverallStateSha256;
}

function parseBaseRestoreReceipt(
  snapshot: TrustedFileSnapshot,
  expectedTargetIdentitySha256: string,
): PostgresLogicalRestoreReceipt {
  const text = safeUtf8(snapshot.bytes, "base_restore_receipt_invalid");
  const value = strictJson(snapshot.bytes, "base_restore_receipt_invalid");
  if (
    canonicalPostgresBackupJson(value) !== text
    || !validBaseRestoreReceipt(value)
    || value.targetIdentitySha256 !== expectedTargetIdentitySha256
  ) throw replayError("base_restore_receipt_invalid");
  return value as unknown as PostgresLogicalRestoreReceipt;
}

function parseRuntimeUrl(
  bytes: Buffer,
  dependencies: PostgresAccountDeletionReplayDependencies,
): string {
  const value = safeUtf8(bytes, "unsafe_connection_file").trim();
  if (!value || /[\r\n\0]/.test(value)) throw replayError("unsafe_connection_file");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw replayError("unsafe_connection_url");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  let username = "";
  let password = "";
  let database = "";
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw replayError("unsafe_connection_url");
  }
  const unsafeComponent = (component: string) => (
    !component || component.length > 1024 || /[\r\n\0]/.test(component)
  );
  const sslModes = parsed.searchParams.getAll("sslmode");
  const sslMode = sslModes[0]?.toLowerCase() ?? "";
  const testLoopback = dependencies.allowInsecureLoopbackForTests
    && dependencies.env.NODE_ENV === "test"
    && loopback
    && sslMode === "disable";
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !host
    || host.includes("pooler")
    || host.includes("pgbouncer")
    || host.includes("pgpool")
    || unsafeComponent(username)
    || unsafeComponent(password)
    || unsafeComponent(database)
    || database.includes("/")
    || !Number.isInteger(Number(parsed.port || "5432"))
    || Number(parsed.port || "5432") < 1
    || Number(parsed.port || "5432") > 65_535
    || Number(parsed.port || "5432") === 6_543
    || parsed.hash
    || sslModes.length !== 1
    || [...parsed.searchParams.keys()].some((key) => key !== "sslmode")
    || (!testLoopback && sslMode !== "require")
  ) throw replayError("unsafe_connection_url");
  return value;
}

export function postgresAccountDeletionReplayTargetIdentitySha256(input: {
  readonly systemIdentifier: string;
  readonly databaseOid: string;
  readonly databaseName: string;
  readonly serverVersionNum: string;
  readonly targetClass: string;
}): string {
  return canonicalSha256({
    kind: "pintpath-postgres-logical-restore-target",
    version: 1,
    systemIdentifier: input.systemIdentifier,
    databaseOid: input.databaseOid,
    databaseName: input.databaseName,
    serverVersionNum: input.serverVersionNum,
    targetClass: input.targetClass,
  });
}

async function inspectTarget(database: SqlDatabase): Promise<TargetInspection> {
  let row: TargetInspectionRow | undefined;
  try {
    row = await database.prepare(`/* pintpath:deletion-replay:target-inspection */
      SELECT
        control.system_identifier::text AS "systemIdentifier",
        target_database.oid::text AS "databaseOid",
        current_database() AS "databaseName",
        current_setting('server_version_num') AS "serverVersionNum",
        current_setting('pintpath.logical_restore_target_class', true) AS "targetClass",
        current_setting('transaction_read_only')::boolean AS "transactionReadOnly",
        pg_is_in_recovery() AS "inRecovery",
        target_database.datistemplate AS "databaseIsTemplate",
        target_database.datallowconn AS "databaseAllowsConnections",
        session_user = current_user AS "sameEffectiveRole",
        login_role.rolname AS "roleName",
        login_role.rolcanlogin AS "canLogin",
        login_role.rolsuper AS "superuser",
        login_role.rolcreatedb AS "createDatabase",
        login_role.rolcreaterole AS "createRole",
        login_role.rolreplication AS "replication",
        login_role.rolbypassrls AS "bypassRls",
        COALESCE(pg_has_role(session_user, to_regrole('${RUNTIME_ROLE}'), 'MEMBER'), false)
          AS "runtimeMember",
        COALESCE(pg_has_role(session_user, to_regrole('${MIGRATOR_ROLE}'), 'MEMBER'), false)
          AS "migratorMember",
        has_schema_privilege(current_user, '${APPLICATION_SCHEMA}', 'USAGE')
          AS "applicationSchemaUsage",
        has_schema_privilege(current_user, '${OPERATIONS_SCHEMA}', 'USAGE')
          AS "operationsSchemaUsage",
        current_schemas(false)::text[] AS "searchPathSchemas",
        current_schema() AS "currentSchema",
        has_database_privilege(current_user, target_database.oid, 'CREATE')
          AS "hasDatabaseCreatePrivilege",
        has_schema_privilege(current_user, '${APPLICATION_SCHEMA}', 'CREATE')
          AS "applicationSchemaCreate",
        EXISTS (
          SELECT 1
            FROM pg_catalog.pg_auth_members membership
            JOIN pg_catalog.pg_roles inherited_role ON inherited_role.oid = membership.roleid
            JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
           WHERE member_role.rolname = session_user
             AND inherited_role.rolname <> '${RUNTIME_ROLE}'
        ) AS "unexpectedMembership"
      FROM pg_catalog.pg_database AS target_database
      CROSS JOIN pg_catalog.pg_control_system() AS control
      JOIN pg_catalog.pg_roles AS login_role ON login_role.rolname = session_user
      WHERE target_database.datname = current_database()`).get<TargetInspectionRow>();
  } catch {
    throw replayError("target_not_disposable");
  }
  if (
    !row
    || !/^\d+$/.test(row.systemIdentifier)
    || !/^\d+$/.test(row.databaseOid)
    || !row.databaseName
    || !/^17\d{4}$/.test(row.serverVersionNum)
    || row.targetClass !== DISPOSABLE_TARGET_CLASS
    || row.transactionReadOnly
    || row.inRecovery
    || row.databaseIsTemplate
    || !row.databaseAllowsConnections
    || !row.sameEffectiveRole
  ) throw replayError("target_not_disposable");
  if (
    !row.roleName
    || !row.canLogin
    || row.superuser
    || row.createDatabase
    || row.createRole
    || row.replication
    || row.bypassRls
    || !row.runtimeMember
    || row.migratorMember
    || !row.applicationSchemaUsage
    || row.operationsSchemaUsage
    || row.hasDatabaseCreatePrivilege
    || row.applicationSchemaCreate
    || row.unexpectedMembership
    || JSON.stringify(row.searchPathSchemas) !== JSON.stringify([APPLICATION_SCHEMA, "pg_catalog"])
    || row.currentSchema !== APPLICATION_SCHEMA
  ) throw replayError("target_role_unsafe");
  return {
    targetIdentitySha256: postgresAccountDeletionReplayTargetIdentitySha256({
      systemIdentifier: row.systemIdentifier,
      databaseOid: row.databaseOid,
      databaseName: row.databaseName,
      serverVersionNum: row.serverVersionNum,
      targetClass: row.targetClass,
    }),
    serverVersionNum: row.serverVersionNum,
  };
}

async function acquireRestoreLock(database: SqlDatabase): Promise<string> {
  let row: LockRow | undefined;
  try {
    row = await database.prepare(`/* pintpath:deletion-replay:restore-lock */
      SELECT pg_try_advisory_lock(?::bigint) AS "acquired",
             pg_backend_pid()::text AS "backendPid"`).get<LockRow>(RESTORE_LOCK_KEY);
  } catch {
    throw replayError("target_busy");
  }
  if (row?.acquired !== true || !/^\d+$/.test(row.backendPid)) throw replayError("target_busy");
  return row.backendPid;
}

async function assertRestoreLockHeld(database: SqlDatabase, backendPid: string): Promise<void> {
  let row: LockHeldRow | undefined;
  try {
    row = await database.prepare(`/* pintpath:deletion-replay:restore-lock-held */
      SELECT pg_backend_pid()::text AS "backendPid",
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_locks AS held_lock
                WHERE held_lock.pid = pg_backend_pid()
                  AND held_lock.locktype = 'advisory'
                  AND held_lock.granted
                  AND held_lock.classid = (((?::bigint >> 32) & 4294967295)::oid)
                  AND held_lock.objid = ((?::bigint & 4294967295)::oid)
                  AND held_lock.objsubid = 1
             ) AS "held"`).get<LockHeldRow>(RESTORE_LOCK_KEY, RESTORE_LOCK_KEY);
  } catch {
    throw replayError("target_busy");
  }
  if (row?.held !== true || row.backendPid !== backendPid) throw replayError("target_busy");
}

async function assertNoOtherClientBackends(
  database: SqlDatabase,
  failureCode: "target_busy" | "verification_failed_target_disposal_required",
): Promise<void> {
  let row: OtherClientBackendsRow | undefined;
  try {
    row = await database.prepare(`/* pintpath:deletion-replay:other-client-backends */
      SELECT count(*)::text AS "otherClientBackends"
        FROM pg_catalog.pg_stat_activity
       WHERE datname = current_database()
         AND backend_type = 'client backend'
         AND pid <> pg_backend_pid()`).get<OtherClientBackendsRow>();
  } catch {
    throw replayError(failureCode);
  }
  if (row?.otherClientBackends !== "0") throw replayError(failureCode);
}

async function readTargetMetadata(database: SqlDatabase): Promise<{
  migrationCandidateSha: string;
  migrationManifestSha256: string;
  migrationRunSha256: string;
  sourceSnapshotSha256: string;
}> {
  let rows: TargetMetadata[];
  try {
    rows = await database.prepare(`/* pintpath:deletion-replay:metadata */
      SELECT key, value FROM ${APPLICATION_SCHEMA}.schema_metadata
       WHERE key IN (
         'import_state', 'schema_version', 'migration_candidate_sha',
         'migration_manifest_sha256', 'migration_run_sha256', 'source_snapshot_sha256'
       ) ORDER BY key`).all<TargetMetadata>();
  } catch {
    throw replayError("target_state_mismatch");
  }
  const metadata = new Map(rows.map((row) => [row.key, row.value]));
  const migrationCandidateSha = metadata.get("migration_candidate_sha") ?? "";
  const migrationManifestSha256 = metadata.get("migration_manifest_sha256") ?? "";
  const migrationRunSha256 = metadata.get("migration_run_sha256") ?? "";
  const sourceSnapshotSha256 = metadata.get("source_snapshot_sha256") ?? "";
  if (
    rows.length !== 6
    || metadata.size !== 6
    || metadata.get("import_state") !== "ready"
    || metadata.get("schema_version") !== "1"
    || !CANDIDATE_SHA_PATTERN.test(migrationCandidateSha)
    || !SHA256_PATTERN.test(migrationManifestSha256)
    || !SHA256_PATTERN.test(migrationRunSha256)
    || !SHA256_PATTERN.test(sourceSnapshotSha256)
  ) throw replayError("target_state_mismatch");
  return { migrationCandidateSha, migrationManifestSha256, migrationRunSha256, sourceSnapshotSha256 };
}

async function loadReplayState(
  database: SqlDatabase,
  requestId: string,
): Promise<ReplayStateRow | null> {
  try {
    const row = await database.prepare(`/* pintpath:deletion-replay:semantic-state */
      SELECT
        deletion.id AS "requestId",
        deletion.user_id AS "userId",
        deletion.status AS "requestStatus",
        deletion.reviewed_by AS "reviewedBy",
        deletion.completed_at AS "completedAt",
        deletion.deletion_tombstone_recorded_at AS "deletionTombstoneRecordedAt",
        deletion.user_message AS "requestUserMessage",
        deletion.last_error AS "requestLastError",
        deletion.result_summary_json::text AS "resultSummaryJson",
        account.public_account_id AS "accountPublicId",
        account.email AS "accountEmail",
        account.password_hash AS "passwordHash",
        account.auth_provider AS "authProvider",
        account.supabase_user_id AS "supabaseUserId",
        account.stripe_customer_id AS "stripeCustomerId",
        account.status AS "accountStatus",
        account.subscription_status AS "subscriptionStatus",
        profile.public_account_id AS "profilePublicId",
        profile.account_status AS "profileStatus",
        notice.status AS "outboxStatus",
        notice.terminal_at AS "outboxTerminalAt",
        notice.next_attempt_at AS "outboxNextAttemptAt",
        notice.lease_token AS "outboxLeaseToken",
        notice.lease_expires_at AS "outboxLeaseExpiresAt",
        notice.provider_message_id AS "outboxProviderMessageId",
        notice.provider_last_event AS "outboxProviderLastEvent",
        notice.provider_event_at AS "outboxProviderEventAt",
        notice.last_error AS "outboxLastError",
        notice.secret_purge_checkpoint_pending AS "secretPurgeCheckpointPending",
        (SELECT count(*)::text FROM ${APPLICATION_SCHEMA}.auth_sessions session
          WHERE session.user_id = deletion.user_id) AS "authSessionCount",
        (SELECT count(*)::text FROM ${APPLICATION_SCHEMA}.account_deletion_notice_recipient_secrets secret
          WHERE secret.request_id = deletion.id) AS "recipientSecretCount",
        (SELECT count(*)::text FROM ${APPLICATION_SCHEMA}.account_deletion_notification_events event
          WHERE event.request_id = deletion.id) AS "notificationEventCount",
        (SELECT count(*)::text FROM ${APPLICATION_SCHEMA}.source_evidence_objects evidence
          WHERE evidence.owner_user_id = deletion.user_id AND evidence.deleted_at IS NULL)
          AS "activeSourceEvidenceCount"
      FROM ${APPLICATION_SCHEMA}.account_deletion_requests deletion
      LEFT JOIN ${APPLICATION_SCHEMA}.accounts account ON account.id = deletion.user_id
      LEFT JOIN ${APPLICATION_SCHEMA}.profiles profile ON profile.id = deletion.user_id
      LEFT JOIN ${APPLICATION_SCHEMA}.account_deletion_completion_outbox notice
        ON notice.request_id = deletion.id
      WHERE deletion.id = ?
      LIMIT 1`).get<ReplayStateRow>(requestId);
    return row ?? null;
  } catch {
    throw replayError("verification_failed_target_disposal_required");
  }
}

function parseSummaryProjection(
  value: string | null,
  expectedSurrogate: string,
): {
  evidenceIdCount: 0;
  removedSubmissions: number;
  removedSubmissionItems: number;
  removedContributionRows: number;
  removedDerivedPriceRecords: number;
} | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isObject(parsed)
      || parsed.anonymisedAccount !== expectedSurrogate
      || parsed.surrogatePublicId !== expectedSurrogate
      || !Array.isArray(parsed.evidenceIds)
      || parsed.evidenceIds.length !== 0
      || parsed.retentionPolicyVersion !== ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION
      || parsed.transactionContractVersion !== ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION
    ) return null;
    const countKeys = [
      "removedSubmissions",
      "removedSubmissionItems",
      "removedContributionRows",
      "removedDerivedPriceRecords",
    ] as const;
    if (countKeys.some((key) => (
      !Number.isSafeInteger(parsed[key]) || Number(parsed[key]) < 0
    ))) return null;
    return {
      evidenceIdCount: 0,
      removedSubmissions: Number(parsed.removedSubmissions),
      removedSubmissionItems: Number(parsed.removedSubmissionItems),
      removedContributionRows: Number(parsed.removedContributionRows),
      removedDerivedPriceRecords: Number(parsed.removedDerivedPriceRecords),
    };
  } catch {
    return null;
  }
}

function completedProjection(
  tombstone: AccountDeletionTombstone,
  row: ReplayStateRow | null,
  requireAcknowledgedCheckpoint: boolean,
): ReplayProjection | null {
  if (!row || row.requestId !== tombstone.requestId || row.userId !== tombstone.userId) return null;
  const surrogate = `DEL-${sha256(tombstone.userId).slice(0, 12).toUpperCase()}`;
  const surrogateEmail = `deleted-${tombstone.userId}@invalid.pintpath.local`;
  const summary = parseSummaryProjection(row.resultSummaryJson, surrogate);
  const profileSafe = row.profilePublicId === null
    ? row.profileStatus === null
    : row.profilePublicId === surrogate && row.profileStatus === "suspended";
  if (
    row.requestStatus !== "completed"
    || row.completedAt !== tombstone.completedAt
    || row.deletionTombstoneRecordedAt !== tombstone.completedAt
    || row.requestUserMessage !== null
    || row.requestLastError !== null
    || row.accountPublicId !== surrogate
    || row.accountEmail !== surrogateEmail
    || row.passwordHash !== "deleted"
    || row.authProvider !== "deleted"
    || row.supabaseUserId !== null
    || row.stripeCustomerId !== null
    || row.accountStatus !== "suspended"
    || row.subscriptionStatus !== "free"
    || !profileSafe
    || row.outboxStatus !== "suppressed_restore"
    || row.outboxTerminalAt !== tombstone.completedAt
    || row.outboxNextAttemptAt !== null
    || row.outboxLeaseToken !== null
    || row.outboxLeaseExpiresAt !== null
    || row.outboxProviderMessageId !== null
    || row.outboxProviderLastEvent !== null
    || row.outboxProviderEventAt !== null
    || row.outboxLastError
      !== "Notification suppressed during deletion-tombstone restore reconciliation."
    || row.recipientSecretCount !== "0"
    || row.authSessionCount !== "0"
    || row.notificationEventCount !== "0"
    || row.activeSourceEvidenceCount !== "0"
    || summary === null
    || (requireAcknowledgedCheckpoint && row.secretPurgeCheckpointPending !== false)
  ) return null;
  return {
    tombstoneSha256: canonicalSha256(tombstone),
    completedAt: tombstone.completedAt,
    accountStatus: "suspended",
    authProvider: "deleted",
    providerIdentifiersCleared: true,
    authSessionCount: "0",
    requestStatus: "completed",
    outboxStatus: "suppressed_restore",
    recipientSecretCount: "0",
    secretPurgeCheckpointPending: false,
    notificationEventCount: "0",
    activeSourceEvidenceCount: "0",
    evidenceIdCount: 0,
    removedSubmissions: summary.removedSubmissions,
    removedSubmissionItems: summary.removedSubmissionItems,
    removedContributionRows: summary.removedContributionRows,
    removedDerivedPriceRecords: summary.removedDerivedPriceRecords,
  };
}

async function replayOne(input: {
  tombstone: AccountDeletionTombstone;
  database: SqlDatabase;
  queue: AccountDeletionReplayQueueBoundary;
  privacy: AccountDeletionReplayPrivacyBoundary;
}): Promise<"newly-applied" | "already-applied" | "missing" | "failed"> {
  const initial = await loadReplayState(input.database, input.tombstone.requestId);
  if (!initial || initial.userId !== input.tombstone.userId) return "missing";
  if (initial.requestStatus === "completed") {
    return completedProjection(input.tombstone, initial, false) ? "already-applied" : "failed";
  }
  try {
    const request = await input.queue.getAccountDeletionRequestById(input.tombstone.requestId);
    if (!request || request.user_id !== input.tombstone.userId) return "missing";
    const reviewedBy = request.reviewed_by ?? request.user_id;
    const processing = await input.queue.beginAccountDeletion({
      requestId: input.tombstone.requestId,
      reviewedBy,
      now: input.tombstone.completedAt,
      staleBefore: input.tombstone.completedAt,
    });
    if (!processing || processing.user_id !== input.tombstone.userId || processing.status !== "processing") {
      return "failed";
    }
    const recorded = await input.queue.markAccountDeletionTombstoneRecorded({
      requestId: input.tombstone.requestId,
      attemptCount: processing.attempt_count,
      recordedAt: input.tombstone.completedAt,
      now: input.tombstone.completedAt,
    });
    if (!recorded) return "failed";
    const summary = await input.privacy.executeAccountAnonymisation({
      requestId: input.tombstone.requestId,
      attemptCount: processing.attempt_count,
      reviewedBy,
      now: input.tombstone.completedAt,
      completionNotificationDisposition: "suppress_restore",
      providerPolicy: {
        requireTombstoneReceipt: true,
        allowUnconfirmedStripeDeletion: false,
      },
    });
    if (summary.evidenceIds.length !== 0) return "failed";
    return completedProjection(
      input.tombstone,
      await loadReplayState(input.database, input.tombstone.requestId),
      false,
    ) ? "newly-applied" : "failed";
  } catch {
    return "failed";
  }
}

interface ReceiptDestination {
  readonly filePath: string;
  readonly parentPath: string;
  readonly parentDev: bigint;
  readonly parentIno: bigint;
  readonly uid: number;
}

function validateReceiptDestination(fileInput: string, uid: number): ReceiptDestination {
  const filePath = canonicalAbsolutePath(fileInput);
  const parentPath = path.dirname(filePath);
  try {
    let leafAbsent = false;
    try {
      fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") leafAbsent = true;
      else throw error;
    }
    if (!leafAbsent) throw new Error("exists");
    const parent = fs.lstatSync(parentPath, { bigint: true });
    if (
      !parent.isDirectory()
      || parent.isSymbolicLink()
      || parent.uid !== BigInt(uid)
      || Number(parent.mode & 0o7777n) !== 0o700
      || fs.realpathSync(parentPath) !== parentPath
    ) throw new Error("unsafe");
    return { filePath, parentPath, parentDev: parent.dev, parentIno: parent.ino, uid };
  } catch {
    throw replayError("invalid_arguments");
  }
}

async function writeReceipt(
  destination: ReceiptDestination,
  receipt: PostgresAccountDeletionReplayReceipt,
): Promise<string> {
  const bytes = Buffer.from(canonicalPostgresBackupJson(receipt), "utf8");
  let handle: fs.promises.FileHandle | null = null;
  let parentHandle: fs.promises.FileHandle | null = null;
  try {
    parentHandle = await fs.promises.open(
      destination.parentPath,
      fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY ?? 0)
      | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedParent = await parentHandle.stat({ bigint: true });
    const openedParentPath = fs.lstatSync(destination.parentPath, { bigint: true });
    if (
      !openedParent.isDirectory()
      || openedParent.dev !== destination.parentDev
      || openedParent.ino !== destination.parentIno
      || openedParent.uid !== BigInt(destination.uid)
      || Number(openedParent.mode & 0o7777n) !== 0o700
      || !sameFileIdentity(openedParent, openedParentPath)
      || fs.realpathSync(destination.parentPath) !== destination.parentPath
    ) throw new Error("parent-changed");
    handle = await fs.promises.open(
      destination.filePath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const before = await handle.stat({ bigint: true });
    await handle.writeFile(bytes);
    await handle.sync();
    const readback = Buffer.alloc(bytes.length);
    let offset = 0;
    while (offset < readback.length) {
      const { bytesRead } = await handle.read(
        readback,
        offset,
        readback.length - offset,
        offset,
      );
      if (bytesRead < 1) throw new Error("receipt-short-read");
      offset += bytesRead;
    }
    const eof = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (eof.bytesRead !== 0 || !crypto.timingSafeEqual(readback, bytes)) {
      throw new Error("receipt-readback-mismatch");
    }
    const after = await handle.stat({ bigint: true });
    const pathStat = fs.lstatSync(destination.filePath, { bigint: true });
    if (
      !after.isFile()
      || after.nlink !== 1n
      || after.uid !== BigInt(destination.uid)
      || Number(after.mode & 0o7777n) !== 0o600
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== BigInt(bytes.length)
      || !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1n
      || pathStat.uid !== BigInt(destination.uid)
      || Number(pathStat.mode & 0o7777n) !== 0o600
      || pathStat.dev !== before.dev
      || pathStat.ino !== before.ino
      || pathStat.size !== BigInt(bytes.length)
    ) throw new Error("unsafe-receipt");
    await parentHandle.sync();
    const finalParentDescriptor = await parentHandle.stat({ bigint: true });
    const finalParentPath = fs.lstatSync(destination.parentPath, { bigint: true });
    if (
      !finalParentDescriptor.isDirectory()
      || finalParentDescriptor.dev !== destination.parentDev
      || finalParentDescriptor.ino !== destination.parentIno
      || finalParentDescriptor.uid !== BigInt(destination.uid)
      || Number(finalParentDescriptor.mode & 0o7777n) !== 0o700
      || !finalParentPath.isDirectory()
      || finalParentPath.isSymbolicLink()
      || finalParentPath.dev !== destination.parentDev
      || finalParentPath.ino !== destination.parentIno
      || finalParentPath.uid !== BigInt(destination.uid)
      || Number(finalParentPath.mode & 0o7777n) !== 0o700
    ) throw new Error("parent-changed");
    const receiptSha256 = sha256(readback);
    const closingHandle = handle;
    handle = null;
    await closingHandle.close();
    const closingParentHandle = parentHandle;
    parentHandle = null;
    await closingParentHandle.close();
    const closedPath = fs.lstatSync(destination.filePath, { bigint: true });
    const closedParent = fs.lstatSync(destination.parentPath, { bigint: true });
    if (
      !sameFileIdentity(after, closedPath)
      || !sameFileIdentity(finalParentDescriptor, closedParent)
      || fs.realpathSync(destination.parentPath) !== destination.parentPath
    ) throw new Error("unsafe-receipt");
    return receiptSha256;
  } catch {
    if (handle) {
      const closing = handle;
      handle = null;
      await closing.close().catch(() => undefined);
    }
    if (parentHandle) {
      const closing = parentHandle;
      parentHandle = null;
      await closing.close().catch(() => undefined);
    }
    throw replayError("receipt_failed_target_disposal_required");
  }
}

export async function replayPostgresAccountDeletionTombstones(
  options: ReplayPostgresAccountDeletionTombstonesOptions,
  overrides: Partial<PostgresAccountDeletionReplayDependencies> = {},
): Promise<PostgresAccountDeletionReplayResult> {
  const dependencies: PostgresAccountDeletionReplayDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  if (options.confirmation !== POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE) {
    throw replayError("confirmation_required");
  }
  const uid = exactUid(dependencies);
  const expectedBaseRestoreReceiptSha256 = exactSha256(
    options.expectedBaseRestoreReceiptSha256,
  );
  const expectedTargetIdentitySha256 = exactSha256(options.expectedTargetIdentitySha256);
  const expectedLedgerCurrentSha256 = exactSha256(options.expectedLedgerCurrentSha256);
  const expectedLedgerGenesisSha256 = exactSha256(options.expectedLedgerGenesisSha256);
  const expectedLedgerCheckpointSha256 = exactSha256(options.expectedLedgerCheckpointSha256);
  const expectedLedgerImmutableSetSha256 = exactSha256(options.expectedLedgerImmutableSetSha256);
  const expectedTombstoneCount = exactCount(options.expectedTombstoneCount, false);
  const receiptDestination = validateReceiptDestination(options.receiptFile, uid);
  const runtimeUrlFilePath = canonicalAbsolutePath(options.runtimeUrlFile);
  const baseRestoreReceiptFilePath = canonicalAbsolutePath(options.baseRestoreReceiptFile);
  const authorityDirectoryPath = canonicalAbsolutePath(options.deletionLedgerAuthorityDirectory);
  if (
    receiptDestination.parentPath === path.dirname(runtimeUrlFilePath)
    || receiptDestination.parentPath === authorityDirectoryPath
  ) throw replayError("invalid_arguments");

  // Authenticate every non-credential authority before reading the runtime
  // credential. Retain only inode/hash identities after parsing and wipe the
  // source buffers synchronously.
  const baseReceiptSnapshot = await readTrustedPrivateFile({
    filePath: baseRestoreReceiptFilePath,
    uid,
    maxBytes: MAX_RECEIPT_BYTES,
    invalidCode: "base_restore_receipt_invalid",
  });
  let baseReceiptFile: TrustedFileIdentity;
  let baseReceipt: PostgresLogicalRestoreReceipt;
  try {
    if (baseReceiptSnapshot.sha256 !== expectedBaseRestoreReceiptSha256) {
      throw replayError("base_restore_receipt_invalid");
    }
    baseReceipt = parseBaseRestoreReceipt(
      baseReceiptSnapshot,
      expectedTargetIdentitySha256,
    );
    baseReceiptFile = retainTrustedFileIdentity(baseReceiptSnapshot);
  } finally {
    baseReceiptSnapshot.bytes.fill(0);
  }
  const authority = await readAuthority({
    directory: authorityDirectoryPath,
    uid,
    expectedCurrentSha256: expectedLedgerCurrentSha256,
    expectedGenesisSha256: expectedLedgerGenesisSha256,
    expectedCheckpointSha256: expectedLedgerCheckpointSha256,
    expectedImmutableSetSha256: expectedLedgerImmutableSetSha256,
    expectedTombstoneCount,
  });
  const connectionSnapshot = await readTrustedPrivateFile({
    filePath: runtimeUrlFilePath,
    uid,
    maxBytes: MAX_CONNECTION_FILE_BYTES,
    invalidCode: "unsafe_connection_file",
  });
  let connectionString = "";
  const connectionFile = retainTrustedFileIdentity(connectionSnapshot);
  try {
    connectionString = parseRuntimeUrl(connectionSnapshot.bytes, dependencies);
  } finally {
    connectionSnapshot.bytes.fill(0);
  }

  let database: SqlDatabase;
  try {
    database = dependencies.createDatabase(connectionString);
  } catch {
    throw replayError("target_unreachable");
  } finally {
    // Strings cannot be reliably wiped in JavaScript, but do not retain this
    // redundant local copy after the database boundary has consumed it.
    connectionString = "";
  }
  let mutationStarted = false;
  let databaseCloseAttempted = false;
  let databaseCloseFailed = false;
  const closeDatabaseOnce = async (): Promise<void> => {
    if (databaseCloseAttempted) {
      if (databaseCloseFailed) throw new Error("database-close-unverified");
      return;
    }
    databaseCloseAttempted = true;
    let closeUncertain = false;
    try {
      const beforeClose = database.metrics();
      if (
        beforeClose.dialect !== "postgres"
        || beforeClose.failedQueries !== 0
        || beforeClose.transactionFailures !== 0
        || beforeClose.totalConnections !== 1
        || beforeClose.idleConnections !== 1
        || beforeClose.waitingRequests !== 0
      ) closeUncertain = true;
    } catch {
      closeUncertain = true;
    }
    try {
      await database.close();
    } catch {
      closeUncertain = true;
    }
    try {
      const closedMetrics = database.metrics();
      if (
        closedMetrics.dialect !== "postgres"
        || closedMetrics.failedQueries !== 0
        || closedMetrics.transactionFailures !== 0
        || closedMetrics.totalConnections !== 0
        || closedMetrics.idleConnections !== 0
        || closedMetrics.waitingRequests !== 0
      ) closeUncertain = true;
    } catch {
      closeUncertain = true;
    }
    if (closeUncertain) {
      databaseCloseFailed = true;
      throw new Error("database-close-unverified");
    }
  };
  try {
    const initialInspection = await inspectTarget(database);
    if (initialInspection.targetIdentitySha256 !== expectedTargetIdentitySha256) {
      throw replayError("target_identity_mismatch");
    }
    const backendPid = await acquireRestoreLock(database);
    await assertRestoreLockHeld(database, backendPid);
    await assertNoOtherClientBackends(database, "target_busy");
    const lockedInspection = await inspectTarget(database);
    if (lockedInspection.targetIdentitySha256 !== expectedTargetIdentitySha256) {
      throw replayError("target_identity_mismatch");
    }
    const metadata = await readTargetMetadata(database);
    await assertAuthorityUnchanged(authority, uid);
    await assertTrustedFileUnchanged(connectionFile, uid, "unsafe_connection_file");
    await assertTrustedFileUnchanged(baseReceiptFile, uid, "base_restore_receipt_invalid");

    const queue = dependencies.createQueue(database);
    const privacy = dependencies.createPrivacy(database);
    const counts: {
      seen: number;
      newlyApplied: number;
      alreadyApplied: number;
      missing: number;
      failed: number;
    } = {
      seen: authority.tombstones.length,
      newlyApplied: 0,
      alreadyApplied: 0,
      missing: 0,
      failed: 0,
    };
    const outcomes: Array<"newly-applied" | "already-applied" | "missing" | "failed"> = [];
    for (const tombstone of authority.tombstones) {
      await assertRestoreLockHeld(database, backendPid);
      const initial = await loadReplayState(database, tombstone.requestId);
      if (initial?.requestStatus !== "completed") mutationStarted = true;
      const outcome = await replayOne({ tombstone, database, queue, privacy });
      outcomes.push(outcome);
      if (outcome === "newly-applied") counts.newlyApplied += 1;
      else if (outcome === "already-applied") counts.alreadyApplied += 1;
      else if (outcome === "missing") counts.missing += 1;
      else counts.failed += 1;
    }
    await assertRestoreLockHeld(database, backendPid);
    // The checkpoint boundary can perform a guarded acknowledgement write.
    // Treat every failure after this point as requiring disposal, even when
    // the current invocation happened to observe an empty checkpoint set.
    mutationStarted = true;
    const checkpointVerified = await queue.checkpointAccountDeletionNotificationSecrets(
      dependencies.createPhysicalCheckpoint(database),
    );
    if (!checkpointVerified) {
      throw replayError("verification_failed_target_disposal_required");
    }

    const projections: ReplayProjection[] = [];
    for (const [index, tombstone] of authority.tombstones.entries()) {
      const projection = completedProjection(
        tombstone,
        await loadReplayState(database, tombstone.requestId),
        true,
      );
      if (!projection) {
        const outcome = outcomes[index];
        if (outcome === "newly-applied") {
          counts.newlyApplied -= 1;
          counts.failed += 1;
        } else if (outcome === "already-applied") {
          counts.alreadyApplied -= 1;
          counts.failed += 1;
        }
      } else {
        projections.push(projection);
      }
    }
    if (
      counts.missing !== 0
      || counts.failed !== 0
      || counts.newlyApplied + counts.alreadyApplied !== counts.seen
      || projections.length !== counts.seen
    ) throw replayError("replay_incomplete_target_disposal_required");

    await assertRestoreLockHeld(database, backendPid);
    const finalInspection = await inspectTarget(database);
    if (finalInspection.targetIdentitySha256 !== expectedTargetIdentitySha256) {
      throw replayError("verification_failed_target_disposal_required");
    }
    await assertAuthorityUnchanged(authority, uid);
    await assertTrustedFileUnchanged(connectionFile, uid, "unsafe_connection_file");
    await assertTrustedFileUnchanged(baseReceiptFile, uid, "base_restore_receipt_invalid");
    let replayedAt: string;
    try {
      replayedAt = dependencies.now().toISOString();
    } catch {
      throw replayError("verification_failed_target_disposal_required");
    }
    const semanticProjectionSha256 = canonicalSha256(projections);
    const receipt: PostgresAccountDeletionReplayReceipt = {
      kind: RECEIPT_KIND,
      version: RECEIPT_VERSION,
      status: "verified",
      replayedAt,
      targetIdentitySha256: expectedTargetIdentitySha256,
      targetClass: DISPOSABLE_TARGET_CLASS,
      serverVersionNum: finalInspection.serverVersionNum,
      runtimeRoleRestricted: true,
      restoreLockKeySha256: sha256(RESTORE_LOCK_KEY),
      baseRestoreReceiptSha256: baseReceiptFile.sha256,
      migrationCandidateSha: metadata.migrationCandidateSha,
      migrationManifestSha256: metadata.migrationManifestSha256,
      migrationRunSha256: metadata.migrationRunSha256,
      sourceSnapshotSha256: metadata.sourceSnapshotSha256,
      backupManifestSha256: baseReceipt.backupManifestSha256,
      backupArchiveSha256: baseReceipt.backupArchiveSha256,
      sourceStateReceiptSha256: baseReceipt.expectedSourceStateReceiptSha256,
      sourceSnapshotBindingSha256: baseReceipt.sourceSnapshotBindingSha256,
      expectedSourceOverallStateSha256: baseReceipt.expectedSourceOverallStateSha256,
      restoredOverallStateSha256: baseReceipt.restoredOverallStateSha256,
      ledgerCurrentSha256: authority.current.sha256,
      ledgerGenesisSha256: authority.genesis.sha256,
      ledgerCheckpointSha256: authority.checkpoint.sha256,
      ledgerImmutableSetSha256: authority.checkpointDocument.immutableSetSha256,
      ledgerTombstoneCount: authority.tombstones.length,
      counts,
      recipientSecretPhysicalCheckpointVerified: true,
      semanticProjectionSha256,
      idempotency: "exact-semantic-projection",
    };
    // Keep the final backend and lock checks immediately adjacent to the
    // intentional pool drain. A pool error or non-empty post-close metrics is
    // authorization failure, not best-effort cleanup.
    await assertNoOtherClientBackends(
      database,
      "verification_failed_target_disposal_required",
    );
    await assertRestoreLockHeld(database, backendPid);
    await closeDatabaseOnce();
    // Database close is an injected asynchronous boundary and may itself run
    // adversarial cleanup. Reassert every source after it settles and before a
    // receipt can be created.
    await assertAuthorityUnchanged(authority, uid);
    await assertTrustedFileUnchanged(connectionFile, uid, "unsafe_connection_file");
    await assertTrustedFileUnchanged(baseReceiptFile, uid, "base_restore_receipt_invalid");
    const receiptSha256 = await writeReceipt(receiptDestination, receipt);
    return {
      schemaVersion: 1,
      ok: true,
      receiptSha256,
      targetIdentitySha256: expectedTargetIdentitySha256,
      ledgerCurrentSha256: authority.current.sha256,
      ledgerTombstoneCount: authority.tombstones.length,
      ...counts,
      semanticProjectionSha256,
    };
  } catch (error) {
    if (!databaseCloseAttempted) {
      await closeDatabaseOnce().catch(() => undefined);
    }
    if (databaseCloseFailed) {
      throw replayError(mutationStarted
        ? "verification_failed_target_disposal_required"
        : "target_not_disposable");
    }
    if (error instanceof PostgresAccountDeletionReplayError) {
      if (mutationStarted && !error.code.endsWith("_target_disposal_required")) {
        throw replayError("verification_failed_target_disposal_required");
      }
      throw error;
    }
    throw replayError(mutationStarted
      ? "verification_failed_target_disposal_required"
      : "target_not_disposable");
  }
}

export const postgresAccountDeletionReplayInternals = {
  parseCanonicalCheckpoint,
  parseCanonicalGenesis,
  parseCanonicalTombstones,
  parseBaseRestoreReceipt,
  completedProjection,
};
